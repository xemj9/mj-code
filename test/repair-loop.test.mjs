import test from "node:test";
import assert from "node:assert/strict";

import {
  decideRepairLoopOnVerifierFailure,
  finalizeRepairLoopOnTurnFailure,
  finalizeRepairLoopOnVerifierPass,
  recordRepairCodeActionResult,
  selectRepairCodeActionCandidate,
} from "../src/lib/agent-repair-loop.mjs";
import { createDiagnosticFingerprint } from "../src/lib/agent-verifier.mjs";

function createCodeActionCollection(fingerprint, overrides = {}) {
  const title = overrides.title ?? "Add import from \"node:fs\"";
  const allowlisted = overrides.allowlisted ?? true;
  const blockedReason = allowlisted ? null : (overrides.blockedReason ?? "not_allowlisted");
  const allowlistRule = allowlisted ? (overrides.allowlistRule ?? "add_import_single_file") : null;
  return {
    availability: {
      available: true,
      source: "tsserver",
      reason: null,
      transportAvailable: true,
      fallbackUsed: false,
      fallbackReason: null,
    },
    actions: [{
      id: overrides.id ?? "code-action-broken-ts2322",
      source: "tsserver",
      title,
      kind: "quickfix",
      reason: "Suggested by tsserver from the recorded diagnostics.",
      recommended: true,
      diagnosticFingerprints: [fingerprint],
      filePaths: ["/repo/src/broken.ts"],
      edits: [{
        path: "/repo/src/broken.ts",
        isNewFile: false,
        changeCount: 1,
        changes: [{
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
          newText: "import { readFileSync } from \"node:fs\";\n",
          newTextPreview: "import { readFileSync } from \"node:fs\";",
          newTextLength: 40,
          textTruncated: false,
        }],
      }],
      fixName: "import",
      fixId: null,
      allowlisted,
      allowlistRule,
      blockedReason,
    }],
    summary: {
      total: 1,
      allowlistedCount: allowlisted ? 1 : 0,
      blockedCount: allowlisted ? 0 : 1,
      fileCount: 1,
      available: true,
      source: "tsserver",
      reason: null,
    },
  };
}

function createProjectContextCollection(fingerprint, overrides = {}) {
  const definitions = overrides.definitions ?? [{
    path: "/repo/src/broken.ts",
    line: 1,
    column: 14,
    endLine: 1,
    endColumn: 20,
    kind: "const",
    name: "broken",
    containerName: null,
  }];
  const implementations = overrides.implementations ?? [{
    path: "/repo/src/broken.ts",
    line: 3,
    column: 1,
    endLine: 3,
    endColumn: 25,
    contextStartLine: 3,
    contextStartColumn: 1,
    contextEndLine: 3,
    contextEndColumn: 26,
  }];
  const references = overrides.references ?? [{
    path: "/repo/src/broken.ts",
    line: 3,
    column: 14,
    endLine: 3,
    endColumn: 20,
    lineText: "export const broken: string = 1;",
    isDefinition: false,
    isWriteAccess: false,
  }];
  const documentSymbols = overrides.documentSymbols ?? [
    {
      path: "/repo/src/broken.ts",
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 20,
      name: "Container",
      kind: "class",
      kindModifiers: "export",
      containerName: null,
      depth: 0,
      childCount: 1,
    },
    {
      path: "/repo/src/broken.ts",
      line: 3,
      column: 1,
      endLine: 3,
      endColumn: 25,
      name: "broken",
      kind: "const",
      kindModifiers: "export",
      containerName: "Container",
      depth: 1,
      childCount: 0,
    },
  ];
  return {
    availability: {
      available: true,
      source: "tsserver",
      reason: null,
      transportAvailable: true,
      fallbackUsed: false,
      fallbackReason: null,
    },
    items: [{
      diagnosticFingerprint: fingerprint,
      path: "/repo/src/broken.ts",
      line: 3,
      column: 14,
      code: "TS2322",
      message: "Type 'number' is not assignable to type 'string'.",
      source: "typescript",
      scope: "file",
      quickInfo: {
        path: null,
        line: 3,
        column: 14,
        endLine: 3,
        endColumn: 20,
        kind: "const",
        kindModifiers: null,
        displayText: "const broken: string",
        documentation: "Synthetic tsserver quick info.",
      },
      definitions,
      implementations,
      implementationCount: overrides.implementationCount ?? implementations.length,
      implementationsTruncated: overrides.implementationsTruncated ?? false,
      references,
      referenceCount: overrides.referenceCount ?? references.length,
      referencesTruncated: overrides.referencesTruncated ?? false,
      enclosingSymbol: overrides.enclosingSymbol ?? documentSymbols[1],
      documentSymbols,
      documentSymbolCount: overrides.documentSymbolCount ?? documentSymbols.length,
      documentSymbolsTruncated: overrides.documentSymbolsTruncated ?? false,
    }],
    summary: {
      total: 1,
      diagnosticCoverageCount: 1,
      quickInfoCount: 1,
      definitionCount: definitions.length,
      implementationCount: overrides.implementationCount ?? implementations.length,
      referenceCount: overrides.referenceCount ?? references.length,
      documentSymbolCount: overrides.documentSymbolCount ?? documentSymbols.length,
      fileCount: 1,
      available: true,
      source: "tsserver",
      reason: null,
    },
  };
}

function createVerifierRun(overrides = {}) {
  const fingerprint = createDiagnosticFingerprint({
    path: "/repo/src/broken.ts",
    line: 3,
    column: 14,
    code: "TS2322",
    message: "Type 'number' is not assignable to type 'string'.",
    source: "typescript",
    scope: "file",
    category: "diagnostic_error",
    rule: null,
  }).fingerprint;
  const baseCheck = {
    id: "diagnostics:broken.ts",
    kind: "diagnostics",
    label: "Collect diagnostics",
    status: "failed",
    category: "diagnostic_error",
    summary: "TypeScript diagnostics reported errors.",
    durationMs: 12,
    findings: [{
      kind: "diagnostics",
      status: "failed",
      severity: "error",
      category: "diagnostic_error",
      path: "/repo/src/broken.ts",
      line: 3,
      column: 14,
      code: "TS2322",
      source: "typescript",
      scope: "file",
      rule: null,
      message: "Type 'number' is not assignable to type 'string'.",
      excerpt: "export const broken: string = 1;",
      related: [],
      meta: null,
    }],
    command: null,
    filePath: null,
    exitCode: null,
    durationMsSummary: null,
    stdoutSummary: null,
    stderrSummary: null,
    availability: null,
    fixHints: {
      availability: {
        available: true,
        source: "tsserver",
        reason: null,
        transportAvailable: true,
        fallbackUsed: false,
        fallbackReason: null,
      },
      hints: [{
        id: "hint-broken-ts2322",
        source: "tsserver",
        title: "Change the initializer to a string literal.",
        kind: "quickfix",
        reason: "Suggested by tsserver for TS2322.",
        recommended: true,
        diagnosticFingerprints: [fingerprint],
        filePaths: ["/repo/src/broken.ts"],
        edits: [{
          path: "/repo/src/broken.ts",
          isNewFile: false,
          changeCount: 1,
          changes: [{
            startLine: 1,
            startColumn: 30,
            endLine: 1,
            endColumn: 31,
            newTextPreview: "\"1\"",
            newTextLength: 3,
          }],
        }],
        fixName: "fixTypeMismatch",
        fixId: null,
      }],
      summary: {
        total: 1,
        recommendedCount: 1,
        fileCount: 1,
        available: true,
        source: "tsserver",
        reason: null,
      },
    },
    codeActions: createCodeActionCollection(fingerprint),
    projectContext: createProjectContextCollection(fingerprint),
  };

  const base = {
    traceId: "trace-repair",
    step: 2,
    startedAt: "2026-04-05T00:00:00.000Z",
    finishedAt: "2026-04-05T00:00:01.000Z",
    plan: {
      required: true,
      trigger: "files_changed",
      reason: "Verifier required because files changed.",
      checks: [],
    },
    checks: [baseCheck],
    summary: {
      status: "failed",
      passed: false,
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      skippedChecks: 0,
      findings: 1,
      failureCategories: ["diagnostic_error"],
      summary: "Verifier failed because diagnostics reported errors.",
      durationMs: 100,
      diagnosticProviderAvailable: true,
      diagnosticErrorCount: 1,
      diagnosticWarningCount: 0,
      diagnosticInfoCount: 0,
      diagnosticEngine: "tsserver",
      diagnosticFallbackUsed: false,
      diagnosticFallbackReason: null,
      diagnosticTransportAvailable: true,
      fixHintAvailable: true,
      fixHintSource: "tsserver",
      fixHintCount: 1,
      recommendedFixHintCount: 1,
      fixHintFileCount: 1,
      fixHintReason: null,
      codeActionAvailable: true,
      codeActionSource: "tsserver",
      codeActionCandidateCount: 1,
      codeActionAllowlistedCount: 1,
      codeActionBlockedCount: 0,
      codeActionReason: null,
      projectContextAvailable: true,
      projectContextSource: "tsserver",
      projectContextCount: 1,
      projectContextDiagnosticCoverageCount: 1,
      projectContextQuickInfoCount: 1,
      projectContextDefinitionCount: 1,
      projectContextImplementationCount: 1,
      projectContextReferenceCount: 1,
      projectContextDocumentSymbolCount: 2,
      projectContextFileCount: 1,
      projectContextReason: null,
    },
  };
  return {
    ...base,
    ...overrides,
    summary: {
      ...base.summary,
      ...(overrides.summary ?? {}),
    },
  };
}

function createDiagnosticFinding(overrides = {}) {
  return {
    kind: "diagnostics",
    status: "failed",
    severity: "error",
    category: "diagnostic_error",
    path: "/repo/src/broken.ts",
    line: 3,
    column: 14,
    code: "TS2322",
    source: "typescript",
    scope: "file",
    rule: null,
    message: "Type 'number' is not assignable to type 'string'.",
    excerpt: "export const broken: string = 1;",
    related: [],
    meta: null,
    ...overrides,
  };
}

test("repair loop creates a typed retry directive from actionable verifier findings", () => {
  const verifierRun = createVerifierRun();

  const { repairLoop, decision } = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun,
    remainingSteps: 2,
  });

  assert.equal(decision.decision, "retry");
  assert.equal(decision.status, "retrying");
  assert.equal(decision.attempt, 1);
  assert.equal(decision.maxAttempts, 1);
  assert.ok(decision.directive);
  assert.equal(decision.directive.items[0].path, "/repo/src/broken.ts");
  assert.equal(decision.directive.items[0].line, 3);
  assert.equal(decision.directive.items[0].column, 14);
  assert.equal(decision.directive.items[0].code, "TS2322");
  assert.equal(decision.directive.items[0].fingerprint.length, 40);
  assert.equal(decision.directive.items[0].occurrenceCount, 1);
  assert.equal(decision.directive.items[0].fixHints.length, 1);
  assert.equal(decision.directive.items[0].fixHints[0].source, "tsserver");
  assert.equal(decision.directive.items[0].codeActions.length, 1);
  assert.equal(decision.directive.items[0].codeActions[0].allowlisted, true);
  assert.equal(decision.directive.items[0].projectContext?.quickInfo?.displayText, "const broken: string");
  assert.equal(decision.directive.items[0].projectContext?.definitions[0]?.path, "/repo/src/broken.ts");
  assert.equal(decision.directive.items[0].projectContext?.implementations[0]?.path, "/repo/src/broken.ts");
  assert.equal(decision.directive.items[0].projectContext?.enclosingSymbol?.name, "broken");
  assert.equal(decision.directive.items[0].projectContext?.documentSymbols[0]?.name, "Container");
  assert.equal(decision.directive.fileGroups[0].path, "/repo/src/broken.ts");
  assert.equal(decision.directive.fileGroups[0].diagnosticCount, 1);
  assert.equal(decision.directive.fileGroups[0].hintCount, 1);
  assert.equal(decision.directive.fileGroups[0].recommendedHintCount, 1);
  assert.equal(decision.directive.fileGroups[0].codeActionCount, 1);
  assert.equal(decision.directive.fileGroups[0].allowlistedCodeActionCount, 1);
  assert.equal(decision.directive.fileGroups[0].projectContextCount, 1);
  assert.equal(decision.directive.fileGroups[0].definitions[0]?.path, "/repo/src/broken.ts");
  assert.equal(decision.directive.fileGroups[0].implementations[0]?.path, "/repo/src/broken.ts");
  assert.equal(decision.directive.fileGroups[0].documentSymbols[0]?.name, "Container");
  assert.equal(decision.directive.fileGroups[0].hintGroup.source, "tsserver");
  assert.equal(decision.directive.fixHints.summary.total, 1);
  assert.equal(decision.directive.codeActions.summary.total, 1);
  assert.equal(decision.directive.codeActions.summary.allowlistedCount, 1);
  assert.equal(decision.directive.projectContext.summary.total, 1);
  assert.equal(decision.directive.projectContext.summary.implementationCount, 1);
  assert.equal(decision.directive.projectContext.summary.referenceCount, 1);
  assert.equal(decision.directive.projectContext.summary.documentSymbolCount, 2);
  assert.equal(decision.directive.hintGroups[0].hintCount, 1);
  assert.equal(decision.directive.failureCategories[0], "diagnostic_error");
  assert.match(repairLoop.attempts[0].continuationMessage ?? "", /Do not claim success/);
  assert.match(repairLoop.attempts[0].continuationMessage ?? "", /suggested fix/);
  assert.match(repairLoop.attempts[0].continuationMessage ?? "", /enclosing scope/);
  assert.match(repairLoop.attempts[0].continuationMessage ?? "", /nearby symbols/);
  assert.equal(repairLoop.attempts[0].baselineDiagnostics.engine, "tsserver");
  assert.equal(repairLoop.attempts[0].baselineDiagnostics.fingerprints.length, 1);
  assert.equal(repairLoop.summary.status, "retrying");
  assert.equal(repairLoop.summary.attemptsUsed, 1);
});

test("repair loop stops when findings are not actionable or no step budget remains", () => {
  const nonActionableRun = createVerifierRun({
    checks: [{
      id: "diagnostics:warning.ts",
      kind: "diagnostics",
      label: "Collect diagnostics",
      status: "passed",
      category: null,
      summary: "Only warnings were present.",
      durationMs: 10,
      findings: [{
        kind: "diagnostics",
        status: "passed",
        severity: "warning",
        category: null,
        path: "/repo/src/warning.ts",
        line: 1,
        column: 1,
        code: "TS6133",
        source: "typescript",
        scope: "file",
        rule: null,
        message: "value is declared but never read",
        excerpt: null,
        related: [],
        meta: null,
      }],
      command: null,
      filePath: null,
      exitCode: null,
      durationMsSummary: null,
      stdoutSummary: null,
      stderrSummary: null,
      availability: null,
    }],
    summary: {
      status: "failed",
      passed: false,
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      skippedChecks: 0,
      findings: 1,
      failureCategories: ["diagnostic_error"],
      summary: "Verifier failed without actionable errors.",
      durationMs: 40,
      diagnosticProviderAvailable: true,
      diagnosticErrorCount: 0,
      diagnosticWarningCount: 1,
      diagnosticInfoCount: 0,
    },
  });

  const noActionable = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: nonActionableRun,
    remainingSteps: 2,
  });
  assert.equal(noActionable.decision.decision, "stop");
  assert.equal(noActionable.decision.stopReason, "no_actionable_findings");
  assert.equal(noActionable.repairLoop.summary.status, "stopped");

  const maxSteps = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun(),
    remainingSteps: 0,
  });
  assert.equal(maxSteps.decision.decision, "stop");
  assert.equal(maxSteps.decision.stopReason, "max_steps_reached");
  assert.equal(maxSteps.repairLoop.summary.stopReason, "max_steps_reached");
});

test("repair loop keeps richer project-context prioritization stable and bounded", () => {
  const fingerprint = createDiagnosticFingerprint({
    path: "/repo/src/broken.ts",
    line: 3,
    column: 14,
    code: "TS2322",
    message: "Type 'number' is not assignable to type 'string'.",
    source: "typescript",
    scope: "file",
    category: "diagnostic_error",
    rule: null,
  }).fingerprint;
  const verifierRun = createVerifierRun();
  verifierRun.checks[0].projectContext = createProjectContextCollection(fingerprint, {
    implementations: [
      {
        path: "/repo/src/impl-b.ts",
        line: 20,
        column: 1,
        endLine: 20,
        endColumn: 10,
        contextStartLine: 19,
        contextStartColumn: 1,
        contextEndLine: 21,
        contextEndColumn: 1,
      },
      {
        path: "/repo/src/impl-a.ts",
        line: 10,
        column: 1,
        endLine: 10,
        endColumn: 10,
        contextStartLine: 9,
        contextStartColumn: 1,
        contextEndLine: 11,
        contextEndColumn: 1,
      },
      {
        path: "/repo/src/impl-c.ts",
        line: 30,
        column: 1,
        endLine: 30,
        endColumn: 10,
        contextStartLine: 29,
        contextStartColumn: 1,
        contextEndLine: 31,
        contextEndColumn: 1,
      },
      {
        path: "/repo/src/impl-d.ts",
        line: 40,
        column: 1,
        endLine: 40,
        endColumn: 10,
        contextStartLine: 39,
        contextStartColumn: 1,
        contextEndLine: 41,
        contextEndColumn: 1,
      },
    ],
    implementationCount: 4,
    implementationsTruncated: true,
    documentSymbols: [
      {
        path: "/repo/src/broken.ts",
        line: 9,
        column: 1,
        endLine: 9,
        endColumn: 12,
        name: "zeta",
        kind: "const",
        kindModifiers: "",
        containerName: "Container",
        depth: 1,
        childCount: 0,
      },
      {
        path: "/repo/src/broken.ts",
        line: 3,
        column: 1,
        endLine: 3,
        endColumn: 20,
        name: "broken",
        kind: "const",
        kindModifiers: "export",
        containerName: "Container",
        depth: 1,
        childCount: 0,
      },
      {
        path: "/repo/src/broken.ts",
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 20,
        name: "Container",
        kind: "class",
        kindModifiers: "export",
        containerName: null,
        depth: 0,
        childCount: 3,
      },
      {
        path: "/repo/src/broken.ts",
        line: 7,
        column: 1,
        endLine: 7,
        endColumn: 15,
        name: "alpha",
        kind: "method",
        kindModifiers: "",
        containerName: "Container",
        depth: 1,
        childCount: 0,
      },
      {
        path: "/repo/src/broken.ts",
        line: 11,
        column: 1,
        endLine: 11,
        endColumn: 10,
        name: "omega",
        kind: "const",
        kindModifiers: "",
        containerName: null,
        depth: 0,
        childCount: 0,
      },
    ],
    documentSymbolCount: 5,
    documentSymbolsTruncated: true,
    enclosingSymbol: {
      path: "/repo/src/broken.ts",
      line: 3,
      column: 1,
      endLine: 3,
      endColumn: 20,
      name: "broken",
      kind: "const",
      kindModifiers: "export",
      containerName: "Container",
      depth: 1,
      childCount: 0,
    },
  });
  verifierRun.summary.projectContextImplementationCount = 4;
  verifierRun.summary.projectContextDocumentSymbolCount = 5;

  const { decision } = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun,
    remainingSteps: 2,
  });

  assert.ok(decision.directive);
  assert.equal(decision.directive.items[0].projectContext?.implementationCount, 4);
  assert.equal(decision.directive.items[0].projectContext?.documentSymbolCount, 5);
  assert.equal(decision.directive.items[0].projectContext?.implementations.length, 4);
  assert.equal(decision.directive.items[0].projectContext?.documentSymbols.length, 5);
  assert.equal(decision.directive.fileGroups[0].implementations.length, 3);
  assert.deepEqual(
    decision.directive.fileGroups[0].implementations.map((entry) => entry.path),
    ["/repo/src/impl-a.ts", "/repo/src/impl-b.ts", "/repo/src/impl-c.ts"],
  );
  assert.equal(decision.directive.fileGroups[0].documentSymbols.length, 4);
  assert.deepEqual(
    decision.directive.fileGroups[0].documentSymbols.map((entry) => entry.name),
    ["Container", "omega", "broken", "alpha"],
  );
});

test("repair loop exhausts after one failed retry and preserves command failures in the directive surface", () => {
  const verifierRun = createVerifierRun({
    checks: [{
      id: "command:npm-test",
      kind: "command",
      label: "Reuse verify command: npm test",
      status: "failed",
      category: "command_failed",
      summary: "Verifier command \"npm test\" exited with code 1.",
      durationMs: 30,
      findings: [],
      command: {
        id: "cmd-1",
        command: "npm test",
        cwd: "/repo",
        source: "tool_execution",
        reason: "reuse explicit test run",
      },
      filePath: null,
      exitCode: 1,
      durationMsSummary: 30,
      stdoutSummary: "1 failing test",
      stderrSummary: "Error output",
      availability: null,
    }],
    summary: {
      status: "failed",
      passed: false,
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      skippedChecks: 0,
      findings: 1,
      failureCategories: ["command_failed"],
      summary: "Verifier failed because npm test exited with code 1.",
      durationMs: 40,
      diagnosticProviderAvailable: false,
      diagnosticErrorCount: 0,
      diagnosticWarningCount: 0,
      diagnosticInfoCount: 0,
    },
  });

  const first = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun,
    remainingSteps: 2,
  });
  assert.equal(first.decision.decision, "retry");
  assert.equal(first.decision.directive.items[0].command, "npm test");

  const second = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun,
    existingLoop: first.repairLoop,
    remainingSteps: 1,
  });

  assert.equal(second.decision.decision, "stop");
  assert.equal(second.decision.status, "exhausted");
  assert.equal(second.decision.stopReason, "attempts_exhausted");
  assert.equal(second.repairLoop.attempts[0].status, "failed");
  assert.match(second.repairLoop.attempts[0].summary, /failed/);
  assert.equal(second.repairLoop.attempts[0].convergence.state, "not_applicable");
});

test("repair loop selects allowlisted code actions and records applied outcomes", () => {
  const started = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun(),
    remainingSteps: 2,
  });

  const candidate = selectRepairCodeActionCandidate(started.repairLoop);
  assert.ok(candidate);
  assert.equal(candidate.allowlisted, true);
  assert.equal(candidate.allowlistRule, "add_import_single_file");

  const updated = recordRepairCodeActionResult({
    repairLoop: started.repairLoop,
    result: {
      status: "applied",
      source: "tsserver",
      applied: true,
      candidateId: candidate.id,
      title: candidate.title,
      kind: candidate.kind,
      allowlisted: true,
      summary: "Applied the allowlisted code action through write_file.",
      blockedReason: null,
      failureReason: null,
      approvalRequired: true,
      approvalStatus: "approved",
      toolName: "write_file",
      changeSetId: "change-action-1",
      touchedFiles: [...candidate.filePaths],
      verifierRunStartedAt: started.repairLoop.initialVerifierStartedAt,
      verifierStep: started.repairLoop.initialVerifierStep,
    },
    continuationMessage: "System-applied bounded code action. Verification still must pass before success.",
  });

  assert.ok(updated);
  assert.equal(updated.attempts[0].codeAction.status, "applied");
  assert.equal(updated.attempts[0].codeAction.applied, true);
  assert.equal(updated.summary.codeActionAppliedCount, 1);
  assert.equal(updated.summary.codeActionBlockedCount, 0);
  assert.equal(updated.summary.latestCodeActionStatus, "applied");
  assert.match(updated.attempts[0].continuationMessage ?? "", /System-applied bounded code action/);
});

test("repair loop keeps blocked code-action candidates explicit when the allowlist rejects them", () => {
  const verifierRun = createVerifierRun({
    checks: [{
      ...createVerifierRun().checks[0],
      codeActions: createCodeActionCollection(
        createDiagnosticFingerprint({
          path: "/repo/src/broken.ts",
          line: 3,
          column: 14,
          code: "TS2322",
          message: "Type 'number' is not assignable to type 'string'.",
          source: "typescript",
          scope: "file",
          category: "diagnostic_error",
          rule: null,
        }).fingerprint,
        {
          allowlisted: false,
          title: "Convert default export to named export",
        },
      ),
    }],
    summary: {
      codeActionAvailable: true,
      codeActionSource: "tsserver",
      codeActionCandidateCount: 1,
      codeActionAllowlistedCount: 0,
      codeActionBlockedCount: 1,
      codeActionReason: null,
    },
  });

  const started = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun,
    remainingSteps: 2,
  });

  assert.equal(started.decision.decision, "retry");
  assert.equal(started.decision.directive.codeActions.summary.allowlistedCount, 0);
  assert.equal(started.decision.directive.fileGroups[0].allowlistedCodeActionCount, 0);
  assert.equal(started.decision.directive.items[0].codeActions[0].blockedReason, "not_allowlisted");
  assert.equal(selectRepairCodeActionCandidate(started.repairLoop), null);

  const updated = recordRepairCodeActionResult({
    repairLoop: started.repairLoop,
    result: {
      status: "blocked",
      source: "tsserver",
      applied: false,
      candidateId: started.decision.directive.items[0].codeActions[0].id,
      title: started.decision.directive.items[0].codeActions[0].title,
      kind: "quickfix",
      allowlisted: false,
      summary: "Blocked the primary code action because it was not allowlisted.",
      blockedReason: "not_allowlisted",
      failureReason: null,
      approvalRequired: false,
      approvalStatus: "blocked",
      toolName: null,
      changeSetId: null,
      touchedFiles: ["/repo/src/broken.ts"],
      verifierRunStartedAt: started.repairLoop.initialVerifierStartedAt,
      verifierStep: started.repairLoop.initialVerifierStep,
    },
  });

  assert.ok(updated);
  assert.equal(updated.attempts[0].codeAction.status, "blocked");
  assert.equal(updated.attempts[0].codeAction.blockedReason, "not_allowlisted");
  assert.equal(updated.summary.codeActionAppliedCount, 0);
  assert.equal(updated.summary.codeActionBlockedCount, 1);
  assert.equal(updated.summary.latestCodeActionStatus, "blocked");
});

test("repair loop records verifier pass and interrupted turn outcomes without losing attempt history", () => {
  const started = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun(),
    remainingSteps: 2,
  });

  const succeeded = finalizeRepairLoopOnVerifierPass({
    repairLoop: started.repairLoop,
    verifierRun: {
      ...createVerifierRun(),
      startedAt: "2026-04-05T00:00:02.000Z",
      finishedAt: "2026-04-05T00:00:03.000Z",
      checks: [{
        id: "diagnostics:fixed.ts",
        kind: "diagnostics",
        label: "Collect diagnostics",
        status: "passed",
        category: null,
        summary: "Diagnostics passed after repair.",
        durationMs: 10,
        findings: [],
        command: null,
        filePath: null,
        exitCode: null,
        stdoutSummary: null,
        stderrSummary: null,
        metadata: null,
      }],
      summary: {
        status: "passed",
        passed: true,
        totalChecks: 1,
        passedChecks: 1,
        failedChecks: 0,
        skippedChecks: 0,
        findings: 0,
        failureCategories: [],
        summary: "Verifier passed after repair.",
        durationMs: 50,
        diagnosticProviderAvailable: true,
        diagnosticErrorCount: 0,
        diagnosticWarningCount: 0,
        diagnosticInfoCount: 0,
      },
    },
  });

  assert.equal(succeeded.summary.status, "succeeded");
  assert.equal(succeeded.attempts[0].status, "succeeded");
  assert.equal(succeeded.summary.attemptsRemaining, 0);
  assert.equal(succeeded.attempts[0].convergence.state, "resolved");
  assert.equal(succeeded.summary.latestProgress, "resolved");

  const interrupted = finalizeRepairLoopOnTurnFailure({
    repairLoop: started.repairLoop,
    status: "failed",
    stopReason: "turn_interrupted",
    summary: "Repair loop stopped because provider execution failed before verification could pass again.",
  });

  assert.equal(interrupted.summary.status, "failed");
  assert.equal(interrupted.summary.stopReason, "turn_interrupted");
  assert.equal(interrupted.attempts[0].status, "failed");
  assert.match(interrupted.attempts[0].summary, /provider execution failed/);
});

test("repair loop records improved, unchanged, and regressed convergence states from diagnostics deltas", () => {
  const improvedStart = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun({
      checks: [{
        id: "diagnostics:improved-before",
        kind: "diagnostics",
        label: "Collect diagnostics",
        status: "failed",
        category: "diagnostic_error",
        summary: "Two diagnostics reported errors.",
        durationMs: 10,
        findings: [
          createDiagnosticFinding(),
          createDiagnosticFinding({
            line: 8,
            column: 9,
            code: "TS2339",
            message: "Property 'trim' does not exist on type 'number'.",
          }),
        ],
        command: null,
        filePath: null,
        exitCode: null,
        stdoutSummary: null,
        stderrSummary: null,
        metadata: null,
      }],
      summary: {
        diagnosticErrorCount: 2,
      },
    }),
    remainingSteps: 2,
  });
  const improvedResult = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun({
      startedAt: "2026-04-05T00:00:02.000Z",
      finishedAt: "2026-04-05T00:00:03.000Z",
      checks: [{
        id: "diagnostics:improved-after",
        kind: "diagnostics",
        label: "Collect diagnostics",
        status: "failed",
        category: "diagnostic_error",
        summary: "One diagnostic still reports an error.",
        durationMs: 10,
        findings: [createDiagnosticFinding()],
        command: null,
        filePath: null,
        exitCode: null,
        stdoutSummary: null,
        stderrSummary: null,
        metadata: null,
      }],
      summary: {
        diagnosticErrorCount: 1,
        summary: "Verifier still failed after repair, but fewer diagnostics remain.",
      },
    }),
    existingLoop: improvedStart.repairLoop,
    remainingSteps: 1,
  });
  assert.equal(improvedResult.repairLoop.attempts[0].convergence.state, "improved");
  assert.equal(improvedResult.repairLoop.attempts[0].convergence.delta.resolvedCount, 1);
  assert.equal(improvedResult.repairLoop.summary.latestProgress, "improved");

  const unchangedStart = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun(),
    remainingSteps: 2,
  });
  const unchangedResult = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun({
      startedAt: "2026-04-05T00:00:02.000Z",
      finishedAt: "2026-04-05T00:00:03.000Z",
      summary: {
        summary: "Verifier still failed with the same diagnostics.",
      },
    }),
    existingLoop: unchangedStart.repairLoop,
    remainingSteps: 1,
  });
  assert.equal(unchangedResult.repairLoop.attempts[0].convergence.state, "unchanged");
  assert.equal(unchangedResult.repairLoop.summary.progressTrend, "unchanged");

  const regressedStart = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun(),
    remainingSteps: 2,
  });
  const regressedResult = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun({
      startedAt: "2026-04-05T00:00:02.000Z",
      finishedAt: "2026-04-05T00:00:03.000Z",
      checks: [{
        id: "diagnostics:regressed-after",
        kind: "diagnostics",
        label: "Collect diagnostics",
        status: "failed",
        category: "diagnostic_error",
        summary: "Two diagnostics now report errors.",
        durationMs: 10,
        findings: [
          createDiagnosticFinding(),
          createDiagnosticFinding({
            line: 5,
            column: 7,
            message: "Type 'boolean' is not assignable to type 'string'.",
          }),
        ],
        command: null,
        filePath: null,
        exitCode: null,
        stdoutSummary: null,
        stderrSummary: null,
        metadata: null,
      }],
      summary: {
        diagnosticErrorCount: 2,
        summary: "Verifier failed with more diagnostics after repair.",
      },
    }),
    existingLoop: regressedStart.repairLoop,
    remainingSteps: 1,
  });
  assert.equal(regressedResult.repairLoop.attempts[0].convergence.state, "regressed");
  assert.equal(regressedResult.repairLoop.attempts[0].convergence.delta.introducedCount, 1);
  assert.equal(regressedResult.repairLoop.summary.latestProgress, "regressed");
});

test("repair loop keeps transport-aware fallback provenance in convergence records", () => {
  const start = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun({
      summary: {
        diagnosticEngine: "compiler_api",
        diagnosticFallbackUsed: true,
        diagnosticFallbackReason: "tsserver transport exited unexpectedly",
        diagnosticTransportAvailable: false,
      },
    }),
    remainingSteps: 2,
  });

  const result = decideRepairLoopOnVerifierFailure({
    cwd: "/repo",
    verifierRun: createVerifierRun({
      startedAt: "2026-04-05T00:00:02.000Z",
      finishedAt: "2026-04-05T00:00:03.000Z",
      summary: {
        diagnosticEngine: "compiler_api",
        diagnosticFallbackUsed: true,
        diagnosticFallbackReason: "tsserver transport exited unexpectedly",
        diagnosticTransportAvailable: false,
      },
    }),
    existingLoop: start.repairLoop,
    remainingSteps: 1,
  });

  assert.equal(result.repairLoop.attempts[0].baselineDiagnostics.engine, "compiler_api");
  assert.equal(result.repairLoop.attempts[0].convergence.delta.beforeEngine, "compiler_api");
  assert.equal(result.repairLoop.attempts[0].convergence.delta.afterEngine, "compiler_api");
  assert.equal(result.repairLoop.attempts[0].convergence.delta.beforeFallbackUsed, true);
  assert.equal(result.repairLoop.attempts[0].convergence.delta.afterTransportAvailable, false);
});
