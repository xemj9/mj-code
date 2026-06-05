import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildVerificationPlan,
  compareVerifierRunDiagnostics,
  createDiagnosticFingerprint,
  runChangedFileParseVerifier,
  runCommandVerifier,
  runPostEditVerifier,
} from "../src/lib/agent-verifier.mjs";
import { TypeScriptDiagnosticProvider } from "../src/lib/diagnostic-provider-typescript.mjs";

function normalizeTestPath(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function createShellRuntime(resultFactory) {
  const calls = [];
  return {
    calls,
    async run(input, executionContext = {}) {
      calls.push({ input, executionContext });
      return resultFactory(input, executionContext);
    },
  };
}

test("verifier skips when there are no touched files and no verification-biased plan", async () => {
  const shellRuntime = createShellRuntime(() => {
    throw new Error("shell runtime should not be called");
  });

  const run = await runPostEditVerifier(
    {
      cwd: process.cwd(),
      shellRuntime,
    },
    {
      step: 1,
      turnState: {
        traceId: "trace-skip",
        filesChanged: new Set(),
        toolEvents: [],
        executionPlan: null,
      },
      lastChangeSet: null,
    },
  );

  assert.equal(run.summary.status, "skipped");
  assert.equal(run.summary.totalChecks, 0);
  assert.equal(shellRuntime.calls.length, 0);
});

test("changed-file parse verifier covers json, js, ts, and unsupported files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-parse-"));
  const jsonPath = path.join(root, "ok.json");
  const jsPath = path.join(root, "broken.mjs");
  const tsPath = path.join(root, "broken.mts");
  const mdPath = path.join(root, "note.md");

  await fs.writeFile(jsonPath, JSON.stringify({ ok: true }), "utf8");
  await fs.writeFile(jsPath, "export const value = ;\n", "utf8");
  await fs.writeFile(tsPath, "export const broken: = 1;\n", "utf8");
  await fs.writeFile(mdPath, "# note\n", "utf8");

  const jsonResult = await runChangedFileParseVerifier(jsonPath, root);
  const jsResult = await runChangedFileParseVerifier(jsPath, root);
  const tsResult = await runChangedFileParseVerifier(tsPath, root);
  const mdResult = await runChangedFileParseVerifier(mdPath, root);

  assert.equal(jsonResult.status, "passed");
  assert.equal(jsResult.status, "failed");
  assert.equal(jsResult.category, "syntax_error");
  assert.equal(tsResult.status, "failed");
  assert.equal(tsResult.findings[0].line >= 1, true);
  assert.equal(mdResult.status, "skipped");
  assert.equal(mdResult.category, "unsupported_file");
});

test("command verifier records success and failure summaries", async () => {
  const successRuntime = createShellRuntime(() => ({
    jobId: "job-success",
    command: "npm test",
    cwd: process.cwd(),
    status: "completed",
    background: false,
    ptyRequested: false,
    ptyEnabled: false,
    ttyMode: "pipe",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    durationMs: 25,
    stdout: "ok\n",
    stderr: "",
    stdoutBytes: 3,
    stderrBytes: 0,
    totalStdoutBytes: 3,
    totalStderrBytes: 0,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    bufferTruncated: false,
    lastUpdateAt: new Date().toISOString(),
    live: false,
    reattached: false,
    historicalOnly: true,
    canReattach: false,
    canCancel: false,
    continuityState: "historical",
    reattachPolicy: "historical_only",
    cursorTailAvailable: false,
    stdinAttachAvailable: false,
    ptyDegradedReason: null,
    lifecycle: [],
  }));
  const failureRuntime = createShellRuntime(() => ({
    jobId: "job-failure",
    command: "npm run build",
    cwd: process.cwd(),
    status: "failed",
    background: false,
    ptyRequested: false,
    ptyEnabled: false,
    ttyMode: "pipe",
    exitCode: 2,
    signal: null,
    timedOut: false,
    cancelled: false,
    durationMs: 41,
    stdout: "",
    stderr: "Build failed loudly\n",
    stdoutBytes: 0,
    stderrBytes: 19,
    totalStdoutBytes: 0,
    totalStderrBytes: 19,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    bufferTruncated: false,
    lastUpdateAt: new Date().toISOString(),
    live: false,
    reattached: false,
    historicalOnly: true,
    canReattach: false,
    canCancel: false,
    continuityState: "historical",
    reattachPolicy: "historical_only",
    cursorTailAvailable: false,
    stdinAttachAvailable: false,
    ptyDegradedReason: null,
    lifecycle: [],
  }));

  const passed = await runCommandVerifier(
    { cwd: process.cwd(), shellRuntime: successRuntime },
    {
      id: "cmd-pass",
      command: "npm test",
      cwd: process.cwd(),
      source: "targeted",
      reason: "run tests",
    },
  );
  const failed = await runCommandVerifier(
    { cwd: process.cwd(), shellRuntime: failureRuntime },
    {
      id: "cmd-fail",
      command: "npm run build",
      cwd: process.cwd(),
      source: "targeted",
      reason: "run build",
    },
  );

  assert.equal(passed.status, "passed");
  assert.equal(passed.exitCode, 0);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 2);
  assert.match(failed.stderrSummary, /Build failed loudly/);
});

test("post-edit verifier reuses explicit verification commands and records replayable output", async () => {
  const shellRuntime = createShellRuntime(() => {
    throw new Error("targeted shell execution should not run when reusing explicit command output");
  });
  const sessionEvents = [];
  const journalEvents = [];
  const journalPhases = [];

  const run = await runPostEditVerifier(
    {
      cwd: process.cwd(),
      shellRuntime,
      sessionStore: {
        async append(type, payload) {
          sessionEvents.push({ type, payload });
        },
      },
      executionJournal: {
        async append(entry) {
          journalEvents.push(entry);
        },
        async recordPhase(entry) {
          journalPhases.push(entry);
        },
      },
      async captureStateSnapshot() {
        return "snapshot-ref";
      },
    },
    {
      step: 2,
      turnState: {
        traceId: "trace-explicit",
        filesChanged: new Set(),
        executionPlan: {
          steps: [{ type: "verify", status: "pending" }],
          verificationBias: true,
        },
        toolEvents: [
          {
            tool: "run_shell",
            input: {
              command: "npm test",
            },
            result: {
              jobId: "job-explicit",
              command: "npm test",
              cwd: process.cwd(),
              status: "completed",
              background: false,
              ptyRequested: false,
              ptyEnabled: false,
              ttyMode: "pipe",
              exitCode: 0,
              signal: null,
              timedOut: false,
              cancelled: false,
              durationMs: 120,
              stdout: "tests ok\n",
              stderr: "",
              stdoutBytes: 9,
              stderrBytes: 0,
              totalStdoutBytes: 9,
              totalStderrBytes: 0,
              stdoutDroppedBytes: 0,
              stderrDroppedBytes: 0,
              bufferTruncated: false,
              lastUpdateAt: new Date().toISOString(),
              live: false,
              reattached: false,
              historicalOnly: true,
              canReattach: false,
              canCancel: false,
              continuityState: "historical",
              reattachPolicy: "historical_only",
              cursorTailAvailable: false,
              stdinAttachAvailable: false,
              ptyDegradedReason: null,
              lifecycle: [],
            },
          },
        ],
      },
      lastChangeSet: null,
    },
  );

  assert.equal(run.summary.status, "passed");
  assert.equal(run.checks[0].kind, "command");
  assert.equal(shellRuntime.calls.length, 0);
  assert.equal(sessionEvents[0].type, "verifier_run");
  assert.equal(journalEvents[0].type, "verifier_run");
  assert.equal(journalPhases[0].phase, "verify");
});

test("verification plan includes a diagnostics check for changed TypeScript files", () => {
  const cwd = process.cwd();
  const changedPath = path.join(cwd, "src", "lib", "agent-verifier.mts");
  const plan = buildVerificationPlan({
    cwd,
    filesChanged: new Set([changedPath]),
    toolEvents: [],
    executionPlan: null,
    lastChangeSet: {
      impact: {
        relatedFiles: ["test/verifier.test.mjs"],
      },
    },
  });

  const diagnosticsCheck = plan.checks.find((check) => check.kind === "diagnostics");
  assert.ok(diagnosticsCheck);
  assert.ok(Array.isArray(diagnosticsCheck.paths));
  assert.ok(diagnosticsCheck.paths.includes(changedPath));
  assert.ok(diagnosticsCheck.paths.includes(path.join(cwd, "test", "verifier.test.mjs")));
});

test("verifier compares diagnostic runs with stable typed fingerprints", () => {
  const beforeFingerprint = createDiagnosticFingerprint({
    path: "/repo/src/example.ts",
    line: 3,
    column: 14,
    code: "TS2322",
    message: "Type 'number' is not assignable to type 'string'.",
    source: "typescript",
    scope: "file",
    category: "diagnostic_error",
    rule: null,
  });
  const before = {
    traceId: "trace-delta",
    step: 1,
    startedAt: "2026-04-05T00:00:00.000Z",
    finishedAt: "2026-04-05T00:00:01.000Z",
    plan: { required: true, trigger: "files_changed", reason: "changed", checks: [] },
    checks: [{
      id: "diagnostics:before",
      kind: "diagnostics",
      label: "Collect diagnostics",
      status: "failed",
      passed: false,
      summary: "Two diagnostics reported errors.",
      durationMs: 10,
      filePath: null,
      command: null,
      category: "diagnostic_error",
      findings: [
        {
          kind: "diagnostics",
          status: "failed",
          severity: "error",
          category: "diagnostic_error",
          path: "/repo/src/example.ts",
          line: 3,
          column: 14,
          code: "TS2322",
          message: "Type 'number' is not assignable to type 'string'.",
          source: "typescript",
          scope: "file",
          rule: null,
          related: [],
          excerpt: null,
          meta: null,
        },
        {
          kind: "diagnostics",
          status: "failed",
          severity: "error",
          category: "diagnostic_error",
          path: "/repo/src/example.ts",
          line: 8,
          column: 3,
          code: "TS2304",
          message: "Cannot find name 'laterValue'.",
          source: "typescript",
          scope: "file",
          rule: null,
          related: [],
          excerpt: null,
          meta: null,
        },
      ],
      exitCode: null,
      stdoutSummary: null,
      stderrSummary: null,
      skippedReason: null,
      metadata: null,
    }],
    summary: {
      status: "failed",
      passed: false,
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      skippedChecks: 0,
      findings: 2,
      failureCategories: ["diagnostic_error"],
      diagnosticErrorCount: 2,
      diagnosticWarningCount: 0,
      diagnosticInfoCount: 0,
      diagnosticProviderAvailable: true,
      diagnosticEngine: "tsserver",
      diagnosticFallbackUsed: false,
      diagnosticFallbackReason: null,
      diagnosticTransportAvailable: true,
      summary: "Verifier failed because diagnostics reported two errors.",
      durationMs: 20,
    },
  };
  const after = {
    ...before,
    startedAt: "2026-04-05T00:00:02.000Z",
    finishedAt: "2026-04-05T00:00:03.000Z",
    checks: [{
      ...before.checks[0],
      id: "diagnostics:after",
      summary: "One old diagnostic persisted and one new diagnostic was introduced.",
      findings: [
        before.checks[0].findings[0],
        {
          ...before.checks[0].findings[0],
          line: 12,
          column: 5,
          code: "TS7006",
          message: "Parameter 'value' implicitly has an 'any' type.",
        },
      ],
    }],
    summary: {
      ...before.summary,
      diagnosticErrorCount: 2,
      summary: "Verifier still failed after repair with one persisted and one new diagnostic.",
    },
  };

  const delta = compareVerifierRunDiagnostics(before, after);
  assert.equal(delta.comparable, true);
  assert.equal(delta.resolvedCount, 1);
  assert.equal(delta.persistedCount, 1);
  assert.equal(delta.introducedCount, 1);
  assert.equal(delta.beforeEngine, "tsserver");
  assert.equal(delta.afterEngine, "tsserver");
  assert.equal(delta.persisted[0].fingerprint, beforeFingerprint.fingerprint);
});

test("post-edit verifier fails when diagnostics find TypeScript errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-diagnostics-fail-"));
  const filePath = path.join(root, "broken.ts");
  await fs.writeFile(filePath, "export const broken: string = 1;\n", "utf8");

  const shellRuntime = createShellRuntime(() => {
    throw new Error("shell runtime should not be called");
  });
  const diagnosticProvider = new TypeScriptDiagnosticProvider();

  try {
    const run = await runPostEditVerifier(
      {
        cwd: root,
        shellRuntime,
        diagnosticProvider,
      },
      {
        step: 1,
        turnState: {
          traceId: "trace-diagnostics-fail",
          filesChanged: new Set([filePath]),
          toolEvents: [],
          executionPlan: null,
        },
        lastChangeSet: null,
      },
    );

    const diagnosticsCheck = run.checks.find((check) => check.kind === "diagnostics");
    assert.equal(run.summary.status, "failed");
    assert.ok(run.summary.diagnosticErrorCount > 0);
    assert.equal(run.summary.diagnosticProviderAvailable, true);
    assert.equal(run.summary.diagnosticEngine, "tsserver");
    assert.equal(run.summary.diagnosticFallbackUsed, false);
    assert.equal(run.summary.diagnosticTransportAvailable, true);
    assert.ok(diagnosticsCheck);
    assert.equal(diagnosticsCheck.status, "failed");
    assert.ok(diagnosticsCheck.findings.some((finding) => finding.category === "diagnostic_error"));
    assert.equal(diagnosticsCheck.metadata.engine, "tsserver");
    assert.equal(diagnosticsCheck.metadata.fallbackUsed, false);
    assert.equal(diagnosticsCheck.metadata.transportAvailable, true);
  } finally {
    await diagnosticProvider.close();
  }
});

test("post-edit verifier records tsserver fix-hint and code-action metadata for actionable diagnostics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-fix-hints-"));
  const filePath = path.join(root, "broken.ts");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      types: ["node"],
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(
    filePath,
    "export const data = readFileSync(\"./package.json\", \"utf8\");\n",
    "utf8",
  );

  const shellRuntime = createShellRuntime(() => {
    throw new Error("shell runtime should not be called");
  });
  const diagnosticProvider = new TypeScriptDiagnosticProvider();

  try {
    const run = await runPostEditVerifier(
      {
        cwd: root,
        shellRuntime,
        diagnosticProvider,
      },
      {
        step: 1,
        turnState: {
          traceId: "trace-diagnostics-fix-hints",
          filesChanged: new Set([filePath]),
          toolEvents: [],
          executionPlan: null,
        },
        lastChangeSet: null,
      },
    );

    const diagnosticsCheck = run.checks.find((check) => check.kind === "diagnostics");
    assert.ok(diagnosticsCheck);
    assert.equal(run.summary.fixHintAvailable, true);
    assert.equal(run.summary.fixHintSource, "tsserver");
    assert.ok((run.summary.fixHintCount ?? 0) > 0);
    assert.ok((run.summary.recommendedFixHintCount ?? 0) > 0);
    assert.equal(run.summary.fixHintFileCount, 1);
    assert.equal(run.summary.codeActionAvailable, true);
    assert.equal(run.summary.codeActionSource, "tsserver");
    assert.ok((run.summary.codeActionCandidateCount ?? 0) > 0);
    assert.equal(
      (run.summary.codeActionAllowlistedCount ?? 0) + (run.summary.codeActionBlockedCount ?? 0),
      run.summary.codeActionCandidateCount ?? 0,
    );
    assert.ok(diagnosticsCheck.fixHints);
    assert.equal(diagnosticsCheck.fixHints.availability.source, "tsserver");
    assert.ok(diagnosticsCheck.fixHints.summary.total > 0);
    assert.equal(typeof diagnosticsCheck.fixHints.hints[0].edits[0].changes[0].newTextPreview, "string");
    assert.equal(diagnosticsCheck.metadata.fixHintSummary.total, diagnosticsCheck.fixHints.summary.total);
    assert.ok(diagnosticsCheck.codeActions);
    assert.equal(diagnosticsCheck.codeActions.availability.source, "tsserver");
    assert.ok(diagnosticsCheck.codeActions.summary.total > 0);
    assert.equal(
      diagnosticsCheck.codeActions.summary.allowlistedCount + diagnosticsCheck.codeActions.summary.blockedCount,
      diagnosticsCheck.codeActions.summary.total,
    );
    assert.equal(typeof diagnosticsCheck.codeActions.actions[0].edits[0].changes[0].newTextPreview, "string");
    assert.equal(diagnosticsCheck.metadata.codeActionSummary.total, diagnosticsCheck.codeActions.summary.total);
  } finally {
    await diagnosticProvider.close();
  }
});

test("post-edit verifier records tsserver project-context metadata for diagnostic-linked symbols", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-project-context-"));
  const filePath = path.join(root, "context.ts");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(
    filePath,
    [
      "export interface Worker {",
      "  run(): string;",
      "}",
      "",
      "export class RealWorker implements Worker {",
      "  run(): number {",
      "    return 1;",
      "  }",
      "}",
      "",
      "export const worker = new RealWorker();",
      "",
    ].join("\n"),
    "utf8",
  );

  const shellRuntime = createShellRuntime(() => {
    throw new Error("shell runtime should not be called");
  });
  const diagnosticProvider = new TypeScriptDiagnosticProvider();

  try {
    const run = await runPostEditVerifier(
      {
        cwd: root,
        shellRuntime,
        diagnosticProvider,
      },
      {
        step: 1,
        turnState: {
          traceId: "trace-diagnostics-project-context",
          filesChanged: new Set([filePath]),
          toolEvents: [],
          executionPlan: null,
        },
        lastChangeSet: null,
      },
    );

    const diagnosticsCheck = run.checks.find((check) => check.kind === "diagnostics");
    assert.ok(diagnosticsCheck);
    assert.equal(run.summary.projectContextAvailable, true);
    assert.equal(run.summary.projectContextSource, "tsserver");
    assert.ok((run.summary.projectContextCount ?? 0) > 0);
    assert.ok((run.summary.projectContextQuickInfoCount ?? 0) > 0);
    assert.ok((run.summary.projectContextDefinitionCount ?? 0) > 0);
    assert.ok((run.summary.projectContextImplementationCount ?? 0) > 0);
    assert.ok((run.summary.projectContextReferenceCount ?? 0) > 0);
    assert.ok((run.summary.projectContextDocumentSymbolCount ?? 0) > 0);
    assert.ok(diagnosticsCheck.projectContext);
    assert.equal(diagnosticsCheck.projectContext.availability.source, "tsserver");
    assert.ok(diagnosticsCheck.projectContext.summary.total > 0);
    assert.equal(
      normalizeTestPath(diagnosticsCheck.projectContext.items[0].path),
      normalizeTestPath(filePath),
    );
    assert.equal(typeof diagnosticsCheck.projectContext.items[0].quickInfo?.displayText, "string");
    assert.ok((diagnosticsCheck.projectContext.items[0].implementations?.length ?? 0) > 0);
    assert.ok((diagnosticsCheck.projectContext.items[0].documentSymbols?.length ?? 0) > 0);
    assert.equal(diagnosticsCheck.metadata.projectContextSummary.total, diagnosticsCheck.projectContext.summary.total);
  } finally {
    await diagnosticProvider.close();
  }
});

test("diagnostics warnings do not fail the verifier", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-diagnostics-warn-"));
  const filePath = path.join(root, "warning.ts");
  await fs.writeFile(filePath, "export const warning = 1;\n", "utf8");

  const shellRuntime = createShellRuntime(() => {
    throw new Error("shell runtime should not be called");
  });
  const diagnosticProvider = {
    kind: "diagnostics",
    available: true,
    provider: "mock-diagnostics",
    async collectDiagnostics() {
      return {
        availability: {
          available: true,
          provider: "mock-diagnostics",
          mode: "project",
          reason: null,
          configPaths: [],
          supportedExtensions: [".ts"],
          transportAvailable: true,
        },
        engine: "tsserver",
        fallbackUsed: false,
        fallbackReason: null,
        diagnostics: [{
          path: filePath,
          line: 1,
          column: 1,
          severity: "warning",
          code: "mock-warning",
          message: "This is only a warning.",
          source: "typescript",
          scope: "file",
          category: "semantic",
          rule: "mock-rule",
          related: [],
        }],
        summary: {
          total: 1,
          errorCount: 0,
          warningCount: 1,
          infoCount: 0,
          targetCount: 1,
          processedTargetCount: 1,
          skippedTargetCount: 0,
          providerAvailable: true,
          mode: "project",
          engine: "tsserver",
          fallbackUsed: false,
          fallbackReason: null,
          transportAvailable: true,
        },
        processedPaths: [filePath],
        skippedPaths: [],
      };
    },
  };

  const run = await runPostEditVerifier(
    {
      cwd: root,
      shellRuntime,
      diagnosticProvider,
    },
    {
      step: 1,
      turnState: {
        traceId: "trace-diagnostics-warning",
        filesChanged: new Set([filePath]),
        toolEvents: [],
        executionPlan: null,
      },
      lastChangeSet: null,
    },
  );

  const diagnosticsCheck = run.checks.find((check) => check.kind === "diagnostics");
  assert.equal(run.summary.status, "passed");
  assert.equal(run.summary.diagnosticErrorCount, 0);
  assert.equal(run.summary.diagnosticWarningCount, 1);
  assert.equal(run.summary.diagnosticEngine, "tsserver");
  assert.equal(run.summary.diagnosticFallbackUsed, false);
  assert.ok(diagnosticsCheck);
  assert.equal(diagnosticsCheck.status, "passed");
  assert.equal(diagnosticsCheck.findings[0].severity, "warning");
});

test("parse failures suppress duplicate diagnostics collection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-diagnostics-skip-"));
  const filePath = path.join(root, "broken.ts");
  await fs.writeFile(filePath, "export const broken: = 1;\n", "utf8");

  const shellRuntime = createShellRuntime(() => {
    throw new Error("shell runtime should not be called");
  });
  const diagnosticCalls = [];
  const diagnosticProvider = {
    kind: "diagnostics",
    available: true,
    provider: "mock-diagnostics",
    async collectDiagnostics(input) {
      diagnosticCalls.push(input);
      return {
        availability: {
          available: true,
          provider: "mock-diagnostics",
          mode: "project",
          reason: null,
          configPaths: [],
          supportedExtensions: [".ts"],
          transportAvailable: true,
        },
        engine: "tsserver",
        fallbackUsed: false,
        fallbackReason: null,
        diagnostics: [],
        summary: {
          total: 0,
          errorCount: 0,
          warningCount: 0,
          infoCount: 0,
          targetCount: 0,
          processedTargetCount: 0,
          skippedTargetCount: 0,
          providerAvailable: true,
          mode: "project",
          engine: "tsserver",
          fallbackUsed: false,
          fallbackReason: null,
          transportAvailable: true,
        },
        processedPaths: [],
        skippedPaths: [],
      };
    },
  };

  const run = await runPostEditVerifier(
    {
      cwd: root,
      shellRuntime,
      diagnosticProvider,
    },
    {
      step: 1,
      turnState: {
        traceId: "trace-diagnostics-skip",
        filesChanged: new Set([filePath]),
        toolEvents: [],
        executionPlan: null,
      },
      lastChangeSet: null,
    },
  );

  const diagnosticsCheck = run.checks.find((check) => check.kind === "diagnostics");
  assert.equal(diagnosticCalls.length, 0);
  assert.ok(diagnosticsCheck);
  assert.equal(diagnosticsCheck.status, "skipped");
  assert.match(diagnosticsCheck.summary, /duplicate noise/i);
});

test("post-edit verifier records compiler-api fallback metadata when tsserver transport fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-diagnostics-fallback-"));
  const filePath = path.join(root, "broken.ts");
  await fs.writeFile(filePath, "export const broken: string = 1;\n", "utf8");

  const shellRuntime = createShellRuntime(() => {
    throw new Error("shell runtime should not be called");
  });
  const diagnosticProvider = new TypeScriptDiagnosticProvider({
    serverPath: path.join(root, "missing-tsserver.js"),
  });

  try {
    const run = await runPostEditVerifier(
      {
        cwd: root,
        shellRuntime,
        diagnosticProvider,
      },
      {
        step: 1,
        turnState: {
          traceId: "trace-diagnostics-fallback",
          filesChanged: new Set([filePath]),
          toolEvents: [],
          executionPlan: null,
        },
        lastChangeSet: null,
      },
    );

    const diagnosticsCheck = run.checks.find((check) => check.kind === "diagnostics");
    assert.ok(diagnosticsCheck);
    assert.equal(run.summary.diagnosticEngine, "compiler_api");
    assert.equal(run.summary.diagnosticFallbackUsed, true);
    assert.equal(run.summary.diagnosticTransportAvailable, false);
    assert.match(run.summary.diagnosticFallbackReason ?? "", /tsserver/i);
    assert.equal(run.summary.fixHintAvailable, false);
    assert.equal(run.summary.fixHintSource, "unavailable");
    assert.equal(run.summary.fixHintCount, 0);
    assert.equal(run.summary.codeActionAvailable, false);
    assert.equal(run.summary.codeActionSource, "unavailable");
    assert.equal(run.summary.codeActionCandidateCount, 0);
    assert.equal(run.summary.projectContextAvailable, false);
    assert.equal(run.summary.projectContextSource, "unavailable");
    assert.equal(run.summary.projectContextCount, 0);
    assert.equal(run.summary.projectContextImplementationCount, 0);
    assert.equal(run.summary.projectContextDocumentSymbolCount, 0);
    assert.equal(diagnosticsCheck.metadata.engine, "compiler_api");
    assert.equal(diagnosticsCheck.metadata.fallbackUsed, true);
    assert.equal(diagnosticsCheck.metadata.transportAvailable, false);
    assert.equal(diagnosticsCheck.fixHints.availability.source, "unavailable");
    assert.equal(diagnosticsCheck.metadata.codeActionSummary.total, 0);
    assert.equal(diagnosticsCheck.codeActions.availability.source, "unavailable");
    assert.equal(diagnosticsCheck.projectContext.availability.source, "unavailable");
    assert.equal(diagnosticsCheck.metadata.projectContextSummary.total, 0);
    assert.equal(diagnosticsCheck.metadata.projectContextSummary.implementationCount, 0);
    assert.equal(diagnosticsCheck.metadata.projectContextSummary.documentSymbolCount, 0);
  } finally {
    await diagnosticProvider.close();
  }
});
