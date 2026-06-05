import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MJCodeAgent } from "../src/agent.mjs";
import {
  buildCurrentVerifierInspectReport,
  buildReplayVerifierInspectReport,
  buildTraceVerifierInspectReport,
  compareVerifierInspectReports,
  createVerifierInspectResolvedReference,
  evaluateVerifierRegressionGate,
  listVerifierRegressionGatePolicyProfiles,
} from "../src/lib/agent-verifier-inspect.mjs";
import {
  parseVerifierInspectCommandArgs,
  parseVerifierInspectReferenceToken,
} from "../src/lib/agent-verifier-inspect-cli.mjs";
import {
  applyVerifierGitHubMutation,
} from "../src/lib/agent-verifier-github.mjs";
import {
  drilldownAgentVerifier,
  timelineAgentVerifier,
} from "../src/lib/agent-command-surface.mjs";
import {
  VerifierGitHubMutationStore,
} from "../src/lib/agent-verifier-github-store.mjs";
import {
  normalizeVerifierBaselinePromotionHistoryRenderProfile,
  normalizeVerifierBaselinePromotionRenderProfile,
  normalizeVerifierDrilldownRenderProfile,
  normalizeVerifierGitHubChecksRenderProfile,
  normalizeVerifierGitHubMutationRenderProfile,
  normalizeVerifierInspectArtifactListRenderProfile,
  normalizeVerifierInspectArtifactPruneRenderProfile,
  normalizeVerifierInspectArtifactRenderProfile,
  normalizeVerifierInspectBaselineRenderProfile,
  normalizeVerifierInspectCompareRenderProfile,
  normalizeVerifierInspectRenderProfile,
  normalizeVerifierInspectSnapshotRenderProfile,
  normalizeVerifierReleaseBundleRenderProfile,
  normalizeVerifierReleaseHandoffRenderProfile,
  normalizeVerifierReleaseTriageRenderProfile,
  normalizeVerifierRegressionGatePolicyProfileRenderProfile,
  normalizeVerifierRegressionGateRenderProfile,
  normalizeVerifierTimelineRenderProfile,
  renderVerifierBaselinePromotionHistory,
  renderVerifierBaselinePromotionPlan,
  renderVerifierDrilldownReport,
  renderVerifierGitHubChecksPayload,
  renderVerifierGitHubMutationResult,
  renderVerifierInspectArtifactList,
  renderVerifierInspectArtifactPruneResult,
  renderVerifierInspectArtifactRecord,
  renderVerifierInspectBaselineList,
  renderVerifierInspectBaselineRecord,
  renderVerifierInspectCompareReport,
  renderVerifierInspectReport,
  renderVerifierReleaseBundle,
  renderVerifierReleaseHandoff,
  renderVerifierRegressionGatePolicyProfiles,
  renderVerifierRegressionGateDecision,
  renderVerifierInspectSnapshotList,
  renderVerifierInspectSnapshotRecord,
  renderVerifierReleaseTriageSummary,
  renderVerifierTimelineReport,
} from "../src/lib/agent-verifier-inspect-render.mjs";
import { VerifierBaselinePromotionStore } from "../src/lib/agent-verifier-baseline-promotion.mjs";
import { VerifierInspectArtifactStore } from "../src/lib/agent-verifier-inspect-artifact-store.mjs";
import { VerifierReleaseStore } from "../src/lib/agent-verifier-release-store.mjs";
import { VerifierInspectSnapshotStore } from "../src/lib/agent-verifier-inspect-store.mjs";
import {
  createVerifierGitHubActionsBackfillInputFromEnv,
  createVerifierGitHubChecksPayloadFromSelection,
  createVerifierReleaseTriageSummaryFromSelection,
} from "../src/lib/agent-verifier-release-triage.mjs";
import { EvalRunner } from "../src/lib/eval-runner.mjs";

const execFileAsync = promisify(execFile);

function createUi() {
  return {
    ask() {
      throw new Error("ask should not be called in this test");
    },
    async confirm() {
      return true;
    },
    async confirmAction() {
      return true;
    },
    printBanner() {},
    printError(message) {
      throw new Error(message);
    },
    printInfo() {},
    close() {},
  };
}

function createCodeActionCollection(overrides = {}) {
  const title = overrides.title ?? "Add import from \"node:fs\"";
  const allowlisted = overrides.allowlisted ?? true;
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
      id: overrides.id ?? "code-action-broken",
      source: "tsserver",
      title,
      kind: "quickfix",
      reason: "Suggested by tsserver from the recorded diagnostics.",
      recommended: true,
      diagnosticFingerprints: ["diag-broken"],
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
      allowlistRule: allowlisted ? "add_import_single_file" : null,
      blockedReason: allowlisted ? null : "not_allowlisted",
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

function createProjectContextCollection() {
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
      diagnosticFingerprint: "diag-broken",
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
      definitions: [{
        path: "/repo/src/broken.ts",
        line: 1,
        column: 14,
        endLine: 1,
        endColumn: 20,
        kind: "const",
        name: "broken",
        containerName: null,
      }],
      implementations: [{
        path: "/repo/src/broken.ts",
        line: 3,
        column: 1,
        endLine: 3,
        endColumn: 25,
        contextStartLine: 3,
        contextStartColumn: 1,
        contextEndLine: 3,
        contextEndColumn: 26,
      }],
      implementationCount: 1,
      implementationsTruncated: false,
      references: [{
        path: "/repo/src/broken.ts",
        line: 3,
        column: 14,
        endLine: 3,
        endColumn: 20,
        lineText: "export const broken: string = 1;",
        isDefinition: false,
        isWriteAccess: false,
      }],
      referenceCount: 1,
      referencesTruncated: false,
      enclosingSymbol: {
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
      documentSymbols: [
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
      ],
      documentSymbolCount: 2,
      documentSymbolsTruncated: false,
    }],
    summary: {
      total: 1,
      diagnosticCoverageCount: 1,
      quickInfoCount: 1,
      definitionCount: 1,
      implementationCount: 1,
      referenceCount: 1,
      documentSymbolCount: 2,
      fileCount: 1,
      available: true,
      source: "tsserver",
      reason: null,
    },
  };
}

function createVerifierRun(overrides = {}) {
  const base = {
    traceId: "trace-verifier",
    step: 2,
    startedAt: "2026-04-05T00:00:00.000Z",
    finishedAt: "2026-04-05T00:00:01.000Z",
    plan: {
      required: true,
      trigger: "files_changed",
      reason: "Verifier required because files changed.",
      checks: [],
    },
    checks: [{
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
        message: "Type 'number' is not assignable to type 'string'.",
        source: "typescript",
        scope: "file",
        rule: null,
        excerpt: "export const broken: string = 1;",
        related: [],
        meta: null,
      }],
      command: null,
      filePath: null,
      exitCode: null,
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
          diagnosticFingerprints: ["diag-broken"],
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
      codeActions: createCodeActionCollection(),
      projectContext: createProjectContextCollection(),
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

function createRepairLoop(overrides = {}) {
  const projectContext = createProjectContextCollection();
  const contextItem = projectContext.items[0];
  const convergence = {
    compared: true,
    state: "resolved",
    summary: "Repair resolved the blocking diagnostics. Diagnostics delta: errors 1 -> 0, warnings 0 -> 0, info 0 -> 0, resolved 1, persisted 0, introduced 0.",
    delta: {
      comparable: true,
      summary: "Diagnostics delta: errors 1 -> 0, warnings 0 -> 0, info 0 -> 0, resolved 1, persisted 0, introduced 0.",
      beforeTotal: 1,
      afterTotal: 0,
      beforeErrorCount: 1,
      afterErrorCount: 0,
      beforeWarningCount: 0,
      afterWarningCount: 0,
      beforeInfoCount: 0,
      afterInfoCount: 0,
      resolvedCount: 1,
      persistedCount: 0,
      introducedCount: 0,
      resolved: [{
        fingerprint: "diag-broken",
        path: "/repo/src/broken.ts",
        line: 3,
        column: 14,
        code: "TS2322",
        message: "Type 'number' is not assignable to type 'string'.",
        source: "typescript",
        scope: "file",
        category: "diagnostic_error",
        rule: null,
      }],
      persisted: [],
      introduced: [],
      beforeEngine: "tsserver",
      afterEngine: "tsserver",
      beforeFallbackUsed: false,
      afterFallbackUsed: false,
      beforeTransportAvailable: true,
      afterTransportAvailable: true,
    },
  };
  const base = {
    traceId: "trace-verifier",
    startedAt: "2026-04-05T00:00:01.500Z",
    finishedAt: "2026-04-05T00:00:02.500Z",
    maxAttempts: 1,
    initialVerifierStartedAt: "2026-04-05T00:00:00.000Z",
    initialVerifierStep: 2,
    initialFailureCategories: ["diagnostic_error"],
    attempts: [{
      attempt: 1,
      startedAt: "2026-04-05T00:00:01.500Z",
      finishedAt: "2026-04-05T00:00:02.500Z",
      status: "succeeded",
      summary: "Repair attempt 1/1 succeeded.",
      decision: "retry",
      directive: {
        traceId: "trace-verifier",
        verifierRunStartedAt: "2026-04-05T00:00:00.000Z",
        verifierStep: 2,
        attempt: 1,
        maxAttempts: 1,
        summary: "Repair directive summary.",
        instruction: "Fix the issue and let verification run again.",
        failureCategories: ["diagnostic_error"],
        failedChecks: [],
        items: [{
          checkId: "diagnostics:broken.ts",
          checkLabel: "Collect diagnostics",
          kind: "diagnostics",
          category: "diagnostic_error",
          severity: "error",
          path: "/repo/src/broken.ts",
          line: 3,
          column: 14,
          code: "TS2322",
          source: "typescript",
          scope: "file",
          rule: null,
          command: null,
          fingerprint: "diag-broken",
          occurrenceCount: 1,
          message: "Type 'number' is not assignable to type 'string'.",
          excerpt: "export const broken: string = 1;",
          related: [],
          fixHints: [],
          codeActions: createCodeActionCollection().actions,
          projectContext: contextItem,
        }],
        fixHints: {
          availability: {
            available: true,
            source: "tsserver",
            reason: null,
            transportAvailable: true,
            fallbackUsed: false,
            fallbackReason: null,
          },
          hints: [],
          summary: {
            total: 0,
            recommendedCount: 0,
            fileCount: 0,
            available: true,
            source: "tsserver",
            reason: null,
          },
        },
        hintGroups: [{
          path: "/repo/src/broken.ts",
          diagnosticFingerprints: [],
          source: "tsserver",
          available: true,
          reason: null,
          hintCount: 0,
          recommendedHintCount: 0,
          hints: [],
        }],
        codeActions: createCodeActionCollection(),
        projectContext,
        filePaths: ["/repo/src/broken.ts"],
        commands: [],
        fileGroups: [{
          path: "/repo/src/broken.ts",
          itemCount: 1,
          diagnosticCount: 1,
          hintCount: 0,
          recommendedHintCount: 0,
          codeActionCount: 1,
          allowlistedCodeActionCount: 1,
          projectContextCount: 1,
          categories: ["diagnostic_error"],
          codes: ["TS2322"],
          items: [],
          definitions: contextItem.definitions,
          implementations: contextItem.implementations,
          documentSymbols: contextItem.documentSymbols,
          hintGroup: {
            path: "/repo/src/broken.ts",
            diagnosticFingerprints: [],
            source: "tsserver",
            available: true,
            reason: null,
            hintCount: 0,
            recommendedHintCount: 0,
            hints: [],
          },
          codeActions: createCodeActionCollection().actions,
        }],
      },
      triggerVerifierStartedAt: "2026-04-05T00:00:00.000Z",
      triggerVerifierStep: 2,
      triggerVerifierSummary: "Verifier failed because diagnostics reported errors.",
      baselineDiagnostics: {
        comparable: true,
        reason: null,
        total: 1,
        errorCount: 1,
        warningCount: 0,
        infoCount: 0,
        engine: "tsserver",
        fallbackUsed: false,
        transportAvailable: true,
        fingerprints: convergence.delta.resolved,
      },
      convergence,
      codeAction: {
        status: "applied",
        source: "tsserver",
        applied: true,
        candidateId: "code-action-broken",
        title: "Add import from \"node:fs\"",
        kind: "quickfix",
        allowlisted: true,
        summary: "Applied allowlisted code action through write_file and required verifier re-pass.",
        blockedReason: null,
        failureReason: null,
        approvalRequired: true,
        approvalStatus: "approved",
        toolName: "write_file",
        changeSetId: "change-broken-1",
        touchedFiles: ["/repo/src/broken.ts"],
        verifierRunStartedAt: "2026-04-05T00:00:00.000Z",
        verifierStep: 2,
      },
      resultVerifierStartedAt: "2026-04-05T00:00:02.000Z",
      resultVerifierStep: 3,
      resultVerifierSummary: "Verifier passed after repair.",
      continuationMessage: "Continue repairing.",
    }],
    summary: {
      status: "succeeded",
      attemptsUsed: 1,
      maxAttempts: 1,
      attemptsRemaining: 0,
      lastDecision: "stop",
      stopReason: null,
      triggeredByVerifierStartedAt: "2026-04-05T00:00:00.000Z",
      latestProgress: "resolved",
      progressTrend: "resolved",
      resolvedAttemptCount: 1,
      improvedAttemptCount: 0,
      unchangedAttemptCount: 0,
      regressedAttemptCount: 0,
      notApplicableAttemptCount: 0,
      resolvedDiagnosticCount: 1,
      persistedDiagnosticCount: 0,
      introducedDiagnosticCount: 0,
      codeActionAppliedCount: 1,
      codeActionBlockedCount: 0,
      latestCodeActionStatus: "applied",
      summary: "Repair loop succeeded after 1 attempt(s).",
    },
  };
  return {
    ...base,
    ...overrides,
    attempts: overrides.attempts ?? base.attempts,
    summary: {
      ...base.summary,
      ...(overrides.summary ?? {}),
    },
  };
}

function createPassedVerifierRun(overrides = {}) {
  return createVerifierRun({
    step: 3,
    startedAt: "2026-04-05T00:00:02.000Z",
    finishedAt: "2026-04-05T00:00:03.000Z",
    checks: [],
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
      durationMs: 40,
      diagnosticProviderAvailable: true,
      diagnosticErrorCount: 0,
      diagnosticWarningCount: 0,
      diagnosticInfoCount: 0,
      fixHintAvailable: false,
      fixHintSource: "none",
      fixHintCount: 0,
      recommendedFixHintCount: 0,
      fixHintFileCount: 0,
      fixHintReason: null,
      codeActionAvailable: false,
      codeActionSource: "none",
      codeActionCandidateCount: 0,
      codeActionAllowlistedCount: 0,
      codeActionBlockedCount: 0,
      codeActionReason: null,
      projectContextAvailable: false,
      projectContextSource: "none",
      projectContextCount: 0,
      projectContextDiagnosticCoverageCount: 0,
      projectContextQuickInfoCount: 0,
      projectContextDefinitionCount: 0,
      projectContextImplementationCount: 0,
      projectContextReferenceCount: 0,
      projectContextDocumentSymbolCount: 0,
      projectContextFileCount: 0,
      projectContextReason: null,
      ...(overrides.summary ?? {}),
    },
    ...overrides,
  });
}

function createReplayInspectReport() {
  return buildReplayVerifierInspectReport({
    session: {
      id: "session-render",
    },
    verifierRuns: [
      { run: createVerifierRun() },
      { run: createPassedVerifierRun() },
    ],
    repairLoops: [
      { loop: createRepairLoop() },
    ],
    finals: [{
      success: true,
      stopped: false,
    }],
    phases: [],
  });
}

function createReplayInspectReference(report = createReplayInspectReport()) {
  return createVerifierInspectResolvedReference({
    kind: "replay",
    reference: report.sessionId,
    scope: report.scope,
    sessionId: report.sessionId,
    traceId: report.traceId,
    replayReference: report.sessionId,
  });
}

test("verifier inspect current report keeps a stable empty shape when no data exists", () => {
  const report = buildCurrentVerifierInspectReport({
    sessionId: null,
    lastTrace: null,
    lastVerifierRun: null,
    lastRepairLoop: null,
  });

  assert.equal(report.scope, "current");
  assert.equal(report.sessionId, null);
  assert.equal(report.traceId, null);
  assert.equal(report.latest.verifierRun, null);
  assert.equal(report.latest.repairLoop, null);
  assert.equal(report.verifierRuns.length, 0);
  assert.equal(report.repairLoops.length, 0);
  assert.equal(report.summary.hasData, false);
  assert.equal(report.summary.verifierRunCount, 0);
  assert.equal(report.summary.repairLoopCount, 0);
  assert.equal(report.summary.latestRepairProgress, "none");
  assert.equal(report.summary.repairProgressTrend, "none");
  assert.equal(report.summary.resolvedDiagnosticCount, 0);
  assert.equal(report.summary.latestDiagnosticEngine, "none");
  assert.equal(report.summary.latestDiagnosticFallbackUsed, false);
  assert.equal(report.summary.fixHintCount, 0);
  assert.equal(report.summary.latestFixHintAvailable, false);
  assert.equal(report.summary.latestFixHintSource, "none");
  assert.equal(report.summary.codeActionCandidateCount, 0);
  assert.equal(report.summary.codeActionAllowlistedCount, 0);
  assert.equal(report.summary.codeActionAppliedCount, 0);
  assert.equal(report.summary.codeActionBlockedCount, 0);
  assert.equal(report.summary.projectContextCount, 0);
  assert.equal(report.summary.projectContextDefinitionCount, 0);
  assert.equal(report.summary.projectContextImplementationCount, 0);
  assert.equal(report.summary.projectContextDocumentSymbolCount, 0);
  assert.equal(report.summary.latestProjectContextAvailable, false);
  assert.equal(report.summary.latestProjectContextSource, "none");
  assert.equal(report.summary.latestCodeActionAvailable, false);
  assert.equal(report.summary.latestCodeActionSource, "none");
  assert.equal(report.summary.latestCodeActionApplied, false);
  assert.equal(report.summary.latestCodeActionStatus, "none");
  assert.equal(report.summary.latestCodeActionBlockedReason, null);
  assert.equal(report.summary.finalOutcome, "unknown");
});

test("verifier inspect export stores stable managed snapshots for empty current reports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-export-empty-"));
  const store = new VerifierInspectSnapshotStore(path.join(root, ".mj-code"));
  const report = buildCurrentVerifierInspectReport({
    sessionId: null,
    lastTrace: null,
    lastVerifierRun: null,
    lastRepairLoop: null,
  });

  const record = await store.exportSnapshot({
    source: createVerifierInspectResolvedReference({
      kind: "current",
      scope: report.scope,
      sessionId: report.sessionId,
      traceId: report.traceId,
    }),
    report,
  });
  const list = await store.listSnapshots();

  assert.match(record.metadata.snapshotId, /^vis-/);
  assert.equal(record.metadata.source.kind, "current");
  assert.equal(record.metadata.source.scope, "current");
  assert.equal(record.metadata.summary.hasData, false);
  assert.equal(record.report.scope, "current");
  assert.equal(record.report.summary.hasData, false);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].snapshotId, record.metadata.snapshotId);
  assert.equal(list.items[0].summary.hasData, false);
});

test("verifier inspect export stores replay provenance and compare can report zero delta for identical reports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-export-replay-"));
  const store = new VerifierInspectSnapshotStore(path.join(root, ".mj-code"));
  const report = createReplayInspectReport();
  const record = await store.exportSnapshot({
    source: createReplayInspectReference(report),
    report,
  });
  const loaded = await store.loadSnapshot(record.metadata.snapshotId);
  const compare = compareVerifierInspectReports({
    leftReference: createVerifierInspectResolvedReference({
      kind: "snapshot",
      reference: loaded.metadata.snapshotId,
      scope: loaded.report.scope,
      sessionId: loaded.report.sessionId,
      traceId: loaded.report.traceId,
      replayReference: loaded.metadata.source.replayReference,
      snapshotId: loaded.metadata.snapshotId,
    }),
    leftReport: loaded.report,
    rightReference: createReplayInspectReference(report),
    rightReport: report,
  });

  assert.equal(record.metadata.source.kind, "replay");
  assert.equal(record.metadata.source.replayReference, "session-render");
  assert.equal(record.metadata.summary.finalOutcome, "success");
  assert.equal(loaded.metadata.snapshotId, record.metadata.snapshotId);
  assert.equal(compare.summary.hasChanges, false);
  assert.equal(compare.summary.verifierRuns.delta, 0);
  assert.equal(compare.summary.blockingDiagnostics.beforeCount, 0);
  assert.equal(compare.summary.blockingDiagnostics.afterCount, 0);
  assert.equal(compare.summary.blockingDiagnostics.summary, "No blocking diagnostics on either side.");
});

test("verifier inspect baseline pin stores durable alias metadata and resolves replay provenance without duplicating reports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-baseline-store-"));
  const store = new VerifierInspectSnapshotStore(path.join(root, ".mj-code"));
  const report = createReplayInspectReport();
  const snapshot = await store.exportSnapshot({
    source: createReplayInspectReference(report),
    report,
  });
  const { baseline } = await store.pinBaseline({
    name: "release-main",
    snapshot,
    policyProfileId: "release",
  });
  const baselines = await store.listBaselines();
  const resolved = await store.resolveBaseline("baseline:release-main");

  assert.equal(baseline.metadata.name, "release-main");
  assert.match(baseline.metadata.baselineId, /^vib-/);
  assert.equal(baseline.metadata.snapshotId, snapshot.metadata.snapshotId);
  assert.equal(baseline.metadata.policyProfileId, "release");
  assert.equal(baseline.metadata.promotionCount, 0);
  assert.equal(baseline.metadata.source.kind, "replay");
  assert.equal(baseline.metadata.source.replayReference, "session-render");
  assert.equal(baseline.metadata.summary.finalOutcome, "success");
  assert.equal(baselines.total, 1);
  assert.equal(baselines.items[0].name, "release-main");
  assert.equal(resolved.reference.kind, "baseline");
  assert.equal(resolved.reference.label, "baseline:release-main");
  assert.equal(resolved.reference.snapshotId, snapshot.metadata.snapshotId);
  assert.equal(resolved.report.summary.finalOutcome, "success");

  assert.deepEqual(renderVerifierInspectBaselineRecord(baseline, { profile: "summary" }).split("\n"), [
    "Verifier Baseline",
    "name: release-main",
    `baseline id: ${baseline.metadata.baselineId}`,
    `created: ${baseline.metadata.createdAt}`,
    `updated: ${baseline.metadata.updatedAt}`,
    `snapshot: ${snapshot.metadata.snapshotId}`,
    "policy profile: release",
    "source: replay:session-render",
    "final outcome: success",
    "latest verifier: passed",
    "latest repair: succeeded",
    "continuity: verifier runs 2, repair loops 1, attempts 1",
  ]);

  assert.deepEqual(renderVerifierInspectBaselineList(baselines, { profile: "summary" }).split("\n"), [
    "Verifier Baselines",
    "total: 1",
    `1. release-main ${baseline.metadata.updatedAt}`,
    `   baseline ${baseline.metadata.baselineId}; snapshot ${snapshot.metadata.snapshotId}; policy release; replay:session-render; outcome success`,
    "   verifier passed, repair succeeded, errors 1, runs 2, attempts 1, promotions 0",
  ]);
});

test("verifier inspect baseline repin preserves auditable promotion history instead of silent overwrite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-baseline-promotion-"));
  const store = new VerifierInspectSnapshotStore(path.join(root, ".mj-code"));
  const report = createReplayInspectReport();
  const firstSnapshot = await store.exportSnapshot({
    source: createReplayInspectReference(report),
    report,
  });
  const secondSnapshot = await store.exportSnapshot({
    source: createReplayInspectReference(report),
    report,
  });
  const firstPin = await store.pinBaseline({
    name: "release-main",
    snapshot: firstSnapshot,
    policyProfileId: "default",
  });
  const secondPin = await store.pinBaseline({
    name: "release-main",
    snapshot: secondSnapshot,
    policyProfileId: "release",
  });
  const resolved = await store.resolveBaseline("baseline:release-main");

  assert.equal(firstPin.promotion, null);
  assert.ok(secondPin.promotion);
  assert.equal(secondPin.baseline.metadata.snapshotId, secondSnapshot.metadata.snapshotId);
  assert.equal(secondPin.baseline.metadata.policyProfileId, "release");
  assert.equal(secondPin.baseline.metadata.promotionCount, 1);
  assert.equal(secondPin.baseline.history.length, 1);
  assert.equal(secondPin.baseline.history[0].previousSnapshotId, firstSnapshot.metadata.snapshotId);
  assert.equal(secondPin.baseline.history[0].nextSnapshotId, secondSnapshot.metadata.snapshotId);
  assert.equal(secondPin.baseline.history[0].previousPolicyProfileId, "default");
  assert.equal(secondPin.baseline.history[0].nextPolicyProfileId, "release");
  assert.equal(resolved.baseline.metadata.snapshotId, secondSnapshot.metadata.snapshotId);
  assert.equal(resolved.baseline.history[0].nextSnapshotId, secondSnapshot.metadata.snapshotId);
  assert.match(renderVerifierInspectBaselineRecord(secondPin.baseline, { profile: "summary" }), /promotions: 1;/);
});

test("verifier inspect compare exposes convergence improvement plus code-action and context continuity deltas", () => {
  const failingRun = createVerifierRun({
    codeActions: {
      availability: {
        available: false,
        source: "unavailable",
        reason: "Code actions unavailable before richer tsserver context was collected.",
        transportAvailable: true,
        fallbackUsed: false,
        fallbackReason: null,
      },
      actions: [],
      summary: {
        total: 0,
        allowlistedCount: 0,
        blockedCount: 0,
        fileCount: 0,
        available: false,
        source: "unavailable",
        reason: "Code actions unavailable before richer tsserver context was collected.",
      },
    },
    projectContext: {
      availability: {
        available: false,
        source: "unavailable",
        reason: "Project context unavailable in the failing baseline.",
        transportAvailable: true,
        fallbackUsed: false,
        fallbackReason: null,
      },
      items: [],
      summary: {
        total: 0,
        diagnosticCoverageCount: 0,
        quickInfoCount: 0,
        definitionCount: 0,
        implementationCount: 0,
        referenceCount: 0,
        documentSymbolCount: 0,
        fileCount: 0,
        available: false,
        source: "unavailable",
        reason: "Project context unavailable in the failing baseline.",
      },
    },
    summary: {
      codeActionAvailable: false,
      codeActionSource: "unavailable",
      codeActionCandidateCount: 0,
      codeActionAllowlistedCount: 0,
      codeActionBlockedCount: 0,
      codeActionReason: "Code actions unavailable before richer tsserver context was collected.",
      projectContextAvailable: false,
      projectContextSource: "unavailable",
      projectContextCount: 0,
      projectContextDiagnosticCoverageCount: 0,
      projectContextQuickInfoCount: 0,
      projectContextDefinitionCount: 0,
      projectContextImplementationCount: 0,
      projectContextReferenceCount: 0,
      projectContextDocumentSymbolCount: 0,
      projectContextFileCount: 0,
      projectContextReason: "Project context unavailable in the failing baseline.",
    },
  });
  const failingReport = buildCurrentVerifierInspectReport({
    sessionId: "session-failing",
    lastTrace: {
      traceId: "trace-verifier",
      success: false,
      stopped: true,
      steps: 2,
      durationMs: 50,
      toolsUsed: [],
      approvalsAsked: 0,
      approvalsApproved: 0,
      approvalsDenied: 0,
      verifier: failingRun.summary,
      repair: null,
      errorTaxonomy: "verifier_failed",
    },
    lastVerifierRun: failingRun,
    lastRepairLoop: null,
  });
  const repairedReport = createReplayInspectReport();
  const compare = compareVerifierInspectReports({
    leftReference: createVerifierInspectResolvedReference({
      kind: "current",
      scope: failingReport.scope,
      sessionId: failingReport.sessionId,
      traceId: failingReport.traceId,
    }),
    leftReport: failingReport,
    rightReference: createReplayInspectReference(repairedReport),
    rightReport: repairedReport,
  });

  assert.equal(compare.summary.hasChanges, true);
  assert.equal(compare.summary.finalOutcome.before, "failed");
  assert.equal(compare.summary.finalOutcome.after, "success");
  assert.equal(compare.summary.latestVerifierStatus.before, "failed");
  assert.equal(compare.summary.latestVerifierStatus.after, "passed");
  assert.equal(compare.summary.diagnosticErrors.delta, -1);
  assert.equal(compare.summary.codeActionApplied.delta, 1);
  assert.equal(compare.summary.projectContextItems.delta, 1);
  assert.equal(compare.summary.projectContextDocumentSymbols.delta, 2);
  assert.equal(compare.summary.blockingDiagnostics.resolvedCount, 1);
  assert.equal(compare.summary.blockingDiagnostics.persistedCount, 0);
  assert.equal(compare.summary.blockingDiagnostics.introducedCount, 0);
  assert.equal(compare.summary.blockingDiagnostics.resolved[0]?.code, "TS2322");
});

test("verifier inspect regression gate keeps zero-delta and warning-only drifts non-failing, but fails on real verifier regressions", () => {
  const richPassedRun = createVerifierRun({
    summary: {
      status: "passed",
      passed: true,
      totalChecks: 1,
      passedChecks: 1,
      failedChecks: 0,
      skippedChecks: 0,
      findings: 0,
      failureCategories: [],
      summary: "Verifier passed cleanly.",
      diagnosticErrorCount: 0,
    },
  });
  const baselineReport = buildCurrentVerifierInspectReport({
    sessionId: "session-baseline",
    lastTrace: {
      traceId: "trace-baseline",
      success: true,
      stopped: false,
      steps: 1,
      durationMs: 20,
      toolsUsed: [],
      approvalsAsked: 0,
      approvalsApproved: 0,
      approvalsDenied: 0,
      verifier: richPassedRun.summary,
      repair: null,
      errorTaxonomy: null,
    },
    lastVerifierRun: richPassedRun,
    lastRepairLoop: null,
  });
  const baselineReference = createVerifierInspectResolvedReference({
    kind: "baseline",
    reference: "release-main",
    scope: baselineReport.scope,
    sessionId: baselineReport.sessionId,
    traceId: baselineReport.traceId,
    snapshotId: "vis-baseline",
    baselineName: "release-main",
  });
  const zeroDeltaGate = evaluateVerifierRegressionGate({
    compare: compareVerifierInspectReports({
      leftReference: baselineReference,
      leftReport: baselineReport,
      rightReference: baselineReference,
      rightReport: baselineReport,
    }),
  });

  const warningRun = createVerifierRun({
    checks: [],
    summary: {
      status: "passed",
      passed: true,
      totalChecks: 1,
      passedChecks: 1,
      failedChecks: 0,
      skippedChecks: 0,
      findings: 0,
      failureCategories: [],
      summary: "Verifier passed with a warning-only delta.",
      diagnosticErrorCount: 0,
      diagnosticWarningCount: 1,
      diagnosticInfoCount: 0,
      fixHintAvailable: false,
      fixHintSource: "none",
      fixHintCount: 0,
      recommendedFixHintCount: 0,
      fixHintFileCount: 0,
      fixHintReason: null,
      codeActionAvailable: false,
      codeActionSource: "none",
      codeActionCandidateCount: 0,
      codeActionAllowlistedCount: 0,
      codeActionBlockedCount: 0,
      codeActionReason: null,
      projectContextAvailable: false,
      projectContextSource: "none",
      projectContextCount: 0,
      projectContextDiagnosticCoverageCount: 0,
      projectContextQuickInfoCount: 0,
      projectContextDefinitionCount: 0,
      projectContextImplementationCount: 0,
      projectContextReferenceCount: 0,
      projectContextDocumentSymbolCount: 0,
      projectContextFileCount: 0,
      projectContextReason: null,
    },
  });
  const warningReport = buildCurrentVerifierInspectReport({
    sessionId: "session-warning",
    lastTrace: {
      traceId: "trace-warning",
      success: true,
      stopped: false,
      steps: 1,
      durationMs: 20,
      toolsUsed: [],
      approvalsAsked: 0,
      approvalsApproved: 0,
      approvalsDenied: 0,
      verifier: warningRun.summary,
      repair: null,
      errorTaxonomy: null,
    },
    lastVerifierRun: warningRun,
    lastRepairLoop: null,
  });
  const warningGate = evaluateVerifierRegressionGate({
    compare: compareVerifierInspectReports({
      leftReference: baselineReference,
      leftReport: baselineReport,
      rightReference: createVerifierInspectResolvedReference({
        kind: "current",
        scope: warningReport.scope,
        sessionId: warningReport.sessionId,
        traceId: warningReport.traceId,
      }),
      rightReport: warningReport,
    }),
  });

  const failingRun = createVerifierRun();
  const failingReport = buildCurrentVerifierInspectReport({
    sessionId: "session-failing",
    lastTrace: {
      traceId: "trace-verifier",
      success: false,
      stopped: true,
      steps: 2,
      durationMs: 50,
      toolsUsed: [],
      approvalsAsked: 0,
      approvalsApproved: 0,
      approvalsDenied: 0,
      verifier: failingRun.summary,
      repair: null,
      errorTaxonomy: "verifier_failed",
    },
    lastVerifierRun: failingRun,
    lastRepairLoop: null,
  });
  const failureGate = evaluateVerifierRegressionGate({
    compare: compareVerifierInspectReports({
      leftReference: baselineReference,
      leftReport: baselineReport,
      rightReference: createVerifierInspectResolvedReference({
        kind: "current",
        scope: failingReport.scope,
        sessionId: failingReport.sessionId,
        traceId: failingReport.traceId,
      }),
      rightReport: failingReport,
    }),
  });

  assert.equal(zeroDeltaGate.pass, true);
  assert.equal(zeroDeltaGate.failureCount, 0);
  assert.equal(zeroDeltaGate.noticeCount, 0);
  assert.equal(zeroDeltaGate.summary, "Gate passed with no regression reasons triggered.");

  assert.equal(warningGate.pass, true);
  assert.equal(warningGate.failureCount, 0);
  assert.ok(warningGate.reasons.some((entry) => entry.kind === "warning_delta_only"));

  assert.equal(failureGate.pass, false);
  assert.equal(failureGate.status, "fail");
  assert.ok(failureGate.reasons.some((entry) => entry.kind === "final_outcome_regressed"));
  assert.ok(failureGate.reasons.some((entry) => entry.kind === "latest_verifier_failed"));
  assert.ok(failureGate.reasons.some((entry) => entry.kind === "diagnostic_errors_increased"));
  assert.ok(failureGate.reasons.some((entry) => entry.kind === "blocking_diagnostics_introduced"));

  assert.deepEqual(renderVerifierRegressionGateDecision(failureGate, { profile: "summary" }).split("\n"), [
    "Verifier Gate",
    "status: fail",
    "left: baseline:release-main",
    "right: current",
    "policy profile: default",
    "policy: default_verifier_regression_gate_v1",
    "summary: Gate failed with 4 failure reason(s).",
    "final outcome: success -> failed",
    "latest verifier: passed -> failed",
    "diagnostics: errors 0 -> 1 (+1), warnings 0 -> 0 (0), info 0 -> 0 (0)",
    "blocking diagnostics: Blocking diagnostics 0 -> 1; resolved 0, persisted 0, introduced 1.",
    "failure reasons:",
    "1. final_outcome_regressed",
    "   Final outcome regressed from success to failed.",
    "2. latest_verifier_failed",
    "   Latest verifier regressed into failed from passed.",
    "3. diagnostic_errors_increased",
    "   Diagnostic error count increased by 1 (0 -> 1).",
    "4. blocking_diagnostics_introduced",
    "   Blocking diagnostics introduced: 1.",
  ]);

  assert.deepEqual(renderVerifierRegressionGateDecision(failureGate, { profile: "failures" }).split("\n"), [
    "Verifier Gate Failures",
    "status: fail",
    "left: baseline:release-main",
    "right: current",
    "summary: Gate failed with 4 failure reason(s).",
    "blocking diagnostics: Blocking diagnostics 0 -> 1; resolved 0, persisted 0, introduced 1.",
    "failure reasons:",
    "1. final_outcome_regressed",
    "   Final outcome regressed from success to failed.",
    "2. latest_verifier_failed",
    "   Latest verifier regressed into failed from passed.",
    "3. diagnostic_errors_increased",
    "   Diagnostic error count increased by 1 (0 -> 1).",
    "4. blocking_diagnostics_introduced",
    "   Blocking diagnostics introduced: 1.",
  ]);
});

test("verifier inspect render layer formats a compact summary with stable continuity lines", () => {
  const report = createReplayInspectReport();
  const rendered = renderVerifierInspectReport(report, { profile: "summary" });

  assert.deepEqual(rendered.split("\n"), [
    "Verifier Summary",
    "scope: replay",
    "session: session-render",
    "trace: trace-verifier",
    "final outcome: success",
    "latest verifier: passed",
    "latest repair: succeeded (resolved)",
    "latest diagnostics: tsserver, fallback no, errors 1, warnings 0, info 0",
    "assist totals: fix hints 1 total, 1 recommended, 1 files; code actions 1 total, 1 allowlisted, 1 applied, 0 blocked",
    "latest fix hints: unavailable via none",
    "latest code action: applied via tsserver",
    "context totals: items 1, defs 1, impls 1, refs 1, symbols 2; latest unavailable via none",
    "continuity: verifier runs 2 (passed 1, failed 1, skipped 0); repair loops 1 / attempts 1",
    "convergence: trend resolved; resolved 1, improved 0, unchanged 0, regressed 0; delta resolved 1, persisted 0, introduced 0",
  ]);
});

test("verifier inspect render layer keeps failure-first detail and file prioritization stable", () => {
  const report = createReplayInspectReport();
  const rendered = renderVerifierInspectReport(report, { profile: "failures" });

  assert.deepEqual(rendered.split("\n"), [
    "Verifier Failures",
    "scope: replay",
    "session: session-render",
    "trace: trace-verifier",
    "final outcome: success",
    "latest verifier: passed",
    "latest repair: succeeded (resolved)",
    "top blocking diagnostics:",
    "1. /repo/src/broken.ts:3:14 TS2322 [diagnostic_error]",
    "   Type 'number' is not assignable to type 'string'.",
    "   code actions: 1 total, 1 allowlisted",
    "   project context: quick info yes, defs 1, impls 1, refs 1, symbols 2",
    "top files:",
    "1. /repo/src/broken.ts",
    "   diagnostics 1, hints 0, code actions 1, context-linked items 1",
    "   codes: TS2322",
    "   context: defs 1, impls 1, symbols 2",
  ]);
});

test("verifier inspect render layer formats repair and richer context profiles with stable top-N output", () => {
  const report = createReplayInspectReport();
  const repairRendered = renderVerifierInspectReport(report, { profile: "repair" });
  const contextRendered = renderVerifierInspectReport(report, { profile: "context" });

  assert.deepEqual(repairRendered.split("\n"), [
    "Verifier Repair",
    "scope: replay",
    "session: session-render",
    "trace: trace-verifier",
    "final outcome: success",
    "latest repair: succeeded",
    "progress: resolved (trend resolved)",
    "attempts: 1/1 used, 0 remaining",
    "delta: resolved 1, persisted 0, introduced 0",
    "code actions: applied 1, blocked 0, latest applied",
    "latest attempt: #1 succeeded, decision retry",
    "latest convergence: resolved; resolved 1, persisted 0, introduced 0",
    "latest code action: applied Add import from \"node:fs\" via write_file",
    "top repair files:",
    "1. /repo/src/broken.ts",
    "   diagnostics 1, hints 0, code actions 1, context-linked items 1",
    "continuity: verifier runs 2, repair loops 1, final outcome success",
  ]);

  assert.deepEqual(contextRendered.split("\n"), [
    "Verifier Context",
    "scope: replay",
    "session: session-render",
    "trace: trace-verifier",
    "final outcome: success",
    "context totals: items 1, coverage 1, quick info 1, defs 1, impls 1, refs 1, symbols 2",
    "latest context: unavailable via none (0 items, 0 defs, 0 impls, 0 refs, 0 symbols)",
    "top context groups:",
    "1. /repo/src/broken.ts",
    "   definitions: broken@1:14",
    "   implementations: /repo/src/broken.ts:3:1",
    "   symbols: Container, broken",
    "latest blocking diagnostics with context:",
    "1. /repo/src/broken.ts:3:14 TS2322",
    "   enclosing scope: broken",
    "   quick info: const broken: string",
    "   Type 'number' is not assignable to type 'string'.",
  ]);
});

test("verifier inspect render profile normalization stays stable for cli and repl parsing", () => {
  assert.equal(normalizeVerifierInspectRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierInspectRenderProfile("failures"), "failures");
  assert.equal(normalizeVerifierInspectRenderProfile("repair"), "repair");
  assert.equal(normalizeVerifierInspectRenderProfile("context"), "context");
  assert.equal(normalizeVerifierInspectRenderProfile("json"), "json");
  assert.equal(normalizeVerifierInspectRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierInspectSnapshotRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierInspectSnapshotRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierInspectBaselineRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierInspectBaselineRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierInspectCompareRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierInspectCompareRenderProfile("failures"), "failures");
  assert.equal(normalizeVerifierInspectCompareRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierRegressionGatePolicyProfileRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierRegressionGatePolicyProfileRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierRegressionGateRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierRegressionGateRenderProfile("failures"), "failures");
  assert.equal(normalizeVerifierRegressionGateRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierInspectArtifactRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierInspectArtifactRenderProfile("failures"), "failures");
  assert.equal(normalizeVerifierInspectArtifactRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierInspectArtifactListRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierInspectArtifactListRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierReleaseHandoffRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierReleaseHandoffRenderProfile("failures"), "failures");
  assert.equal(normalizeVerifierReleaseHandoffRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierReleaseBundleRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierReleaseBundleRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierInspectArtifactPruneRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierInspectArtifactPruneRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierBaselinePromotionRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierBaselinePromotionRenderProfile("failures"), "failures");
  assert.equal(normalizeVerifierBaselinePromotionRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierBaselinePromotionHistoryRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierBaselinePromotionHistoryRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierReleaseTriageRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierReleaseTriageRenderProfile("failures"), "failures");
  assert.equal(normalizeVerifierReleaseTriageRenderProfile("unknown"), "json");
  assert.equal(normalizeVerifierGitHubChecksRenderProfile("summary"), "summary");
  assert.equal(normalizeVerifierGitHubChecksRenderProfile("unknown"), "json");
});

test("verifier inspect cli parser keeps inspect export list and compare semantics aligned", () => {
  assert.deepEqual(
    parseVerifierInspectCommandArgs(["trace", "summary"], "usage", null),
    {
      kind: "inspect",
      reference: { kind: "trace", reference: null },
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(["export", "replay", "session-1", "summary"], "usage", null),
    {
      kind: "export",
      reference: { kind: "replay", reference: "session-1" },
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(["exports", "--limit", "5", "summary"], "usage", null),
    {
      kind: "exports",
      limit: 5,
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["compare", "current", "snapshot:vis-demo", "failures"],
      "usage",
      null,
    ),
    {
      kind: "compare",
      left: { kind: "current", reference: null },
      right: { kind: "snapshot", reference: "vis-demo" },
      profile: "failures",
      writeArtifact: false,
      writeBundle: false,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["baseline", "pin", "snapshot:vis-demo", "release-main", "summary", "--policy", "release"],
      "usage",
      null,
    ),
    {
      kind: "baseline_pin",
      reference: { kind: "snapshot", reference: "vis-demo" },
      name: "release-main",
      profile: "summary",
      policyProfileId: "release",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["baselines", "--limit", "3", "summary"],
      "usage",
      null,
    ),
    {
      kind: "baselines",
      limit: 3,
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["gate", "baseline:release-main", "current", "failures"],
      "usage",
      null,
    ),
    {
      kind: "gate",
      left: { kind: "baseline", reference: "release-main" },
      right: { kind: "current", reference: null },
      profile: "failures",
      policyProfileId: null,
      writeArtifact: false,
      writeBundle: false,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["policies", "summary"],
      "usage",
      null,
    ),
    {
      kind: "policies",
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["artifacts", "--limit", "2", "summary"],
      "usage",
      null,
    ),
    {
      kind: "artifacts",
      limit: 2,
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["artifact", "via-demo", "failures"],
      "usage",
      null,
    ),
    {
      kind: "artifact",
      artifactId: "via-demo",
      profile: "failures",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["gate", "baseline:release-main", "current", "failures", "--policy", "release", "--write-artifact"],
      "usage",
      null,
    ),
    {
      kind: "gate",
      left: { kind: "baseline", reference: "release-main" },
      right: { kind: "current", reference: null },
      profile: "failures",
      policyProfileId: "release",
      writeArtifact: true,
      writeBundle: false,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["compare", "baseline:release-main", "current", "summary", "--write-artifact", "--write-bundle"],
      "usage",
      null,
    ),
    {
      kind: "compare",
      left: { kind: "baseline", reference: "release-main" },
      right: { kind: "current", reference: null },
      profile: "summary",
      writeArtifact: true,
      writeBundle: true,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["handoff", "latest", "failures"],
      "usage",
      null,
    ),
    {
      kind: "handoff",
      reference: "latest",
      profile: "failures",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["handoff", "export", "latest", "summary"],
      "usage",
      null,
    ),
    {
      kind: "handoff_export",
      reference: "latest",
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["promotion", "plan", "release-main", "latest", "failures", "--policy", "release"],
      "usage",
      null,
    ),
    {
      kind: "promotion_plan",
      baselineName: "release-main",
      reference: "latest",
      profile: "failures",
      policyProfileId: "release",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["promotion", "approve", "vpr-plan-demo", "summary"],
      "usage",
      null,
    ),
    {
      kind: "promotion_approve",
      reference: "vpr-plan-demo",
      profile: "summary",
      approverId: null,
      approverDisplayName: null,
      approvalSource: null,
      approvalMode: null,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["promotion", "history", "release-main", "summary"],
      "usage",
      null,
    ),
    {
      kind: "promotion_history",
      baselineName: "release-main",
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["promotion", "approve", "vpr-plan-demo", "summary", "--approver-id", "ci-bot", "--approver-name", "CI Bot", "--approval-source", "workflow_dispatch", "--approval-mode", "workflow_apply"],
      "usage",
      null,
    ),
    {
      kind: "promotion_approve",
      reference: "vpr-plan-demo",
      profile: "summary",
      approverId: "ci-bot",
      approverDisplayName: "CI Bot",
      approvalSource: "workflow_dispatch",
      approvalMode: "workflow_apply",
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["triage", "summary", "latest", "failures", "--github-actions"],
      "usage",
      null,
    ),
    {
      kind: "triage_summary",
      reference: "latest",
      profile: "failures",
      githubActions: true,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["drilldown", "current", "summary"],
      "usage",
      null,
    ),
    {
      kind: "drilldown",
      reference: "current",
      profile: "summary",
      githubActions: false,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["drilldown", "failures", "--github-actions"],
      "usage",
      null,
    ),
    {
      kind: "drilldown",
      reference: "latest",
      profile: "failures",
      githubActions: true,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["timeline", "current", "summary"],
      "usage",
      null,
    ),
    {
      kind: "timeline",
      reference: "current",
      profile: "summary",
      githubActions: false,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["timeline", "failures", "--github-actions"],
      "usage",
      null,
    ),
    {
      kind: "timeline",
      reference: "latest",
      profile: "failures",
      githubActions: true,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["github", "apply", "latest", "summary", "--github-actions"],
      "usage",
      null,
    ),
    {
      kind: "github_apply",
      reference: "latest",
      profile: "summary",
      githubActions: true,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["github", "result", "latest", "failures"],
      "usage",
      null,
    ),
    {
      kind: "github_result",
      reference: "latest",
      profile: "failures",
    },
  );
  assert.deepEqual(normalizeVerifierGitHubMutationRenderProfile("failures"), "failures");
  assert.deepEqual(normalizeVerifierDrilldownRenderProfile("failures"), "failures");
  assert.deepEqual(normalizeVerifierTimelineRenderProfile("failures"), "failures");
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["checks", "summary", "latest", "summary", "--github-actions"],
      "usage",
      null,
    ),
    {
      kind: "checks_summary",
      reference: "latest",
      profile: "summary",
      githubActions: true,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["checks", "export", "latest", "summary", "--github-actions"],
      "usage",
      null,
    ),
    {
      kind: "checks_export",
      reference: "latest",
      profile: "summary",
      githubActions: true,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["checks", "export", "latest", "summary"],
      "usage",
      null,
      { githubActions: true },
    ),
    {
      kind: "checks_export",
      reference: "latest",
      profile: "summary",
      githubActions: true,
    },
  );
  assert.deepEqual(
    parseVerifierInspectCommandArgs(
      ["artifacts", "prune", "summary", "--dry-run", "--max-count", "1", "--max-age-days", "7"],
      "usage",
      null,
    ),
    {
      kind: "artifacts_prune",
      profile: "summary",
      policy: {
        dryRun: true,
        maxArtifactCount: 1,
        maxArtifactAgeDays: 7,
      },
    },
  );
  assert.deepEqual(
    parseVerifierInspectReferenceToken("baseline:release-main", "usage"),
    { kind: "baseline", reference: "release-main" },
  );
});

test("verifier inspect policy profiles and durable compare/gate/eval artifacts stay typed and renderable", async () => {
  const profiles = listVerifierRegressionGatePolicyProfiles();
  assert.equal(profiles.total, 3);
  assert.deepEqual(profiles.items.map((entry) => entry.id), ["default", "strict", "release"]);
  assert.match(renderVerifierRegressionGatePolicyProfiles(profiles, { profile: "summary" }), /^Verifier Gate Policies/m);
  assert.match(renderVerifierRegressionGatePolicyProfiles(profiles, { profile: "summary" }), /1\. default \(builtin\)/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-artifact-store-"));
  const artifactStore = new VerifierInspectArtifactStore(path.join(root, ".mj-code"));
  const report = createReplayInspectReport();
  const reference = createReplayInspectReference(report);
  const compare = compareVerifierInspectReports({
    leftReference: reference,
    leftReport: report,
    rightReference: reference,
    rightReport: report,
  });
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const runner = new EvalRunner({
    provider: "mock",
    model: "mock-mj-code-v1",
    maxTokens: 1200,
  });
  const evalResult = runner.runSuite("verification", {
    baselineGate: gate,
  });

  const compareArtifact = await artifactStore.writeCompareArtifact(compare);
  const gateArtifact = await artifactStore.writeGateArtifact(gate);
  const evalArtifact = await artifactStore.writeEvalArtifact(evalResult);
  const listed = await artifactStore.listArtifacts();
  const loadedGateArtifact = await artifactStore.loadArtifact(gateArtifact.metadata.artifactId.slice(0, 12));

  assert.equal(compareArtifact.metadata.kind, "compare");
  assert.equal(compareArtifact.metadata.hasChanges, false);
  assert.equal(compareArtifact.compare.artifact?.artifactId, compareArtifact.metadata.artifactId);
  assert.equal(gateArtifact.metadata.kind, "gate");
  assert.equal(gateArtifact.metadata.policyProfileId, "release");
  assert.equal(gateArtifact.decision.profile.id, "release");
  assert.equal(evalArtifact.metadata.kind, "eval");
  assert.equal(evalArtifact.result.baselinePolicyProfile?.id, "release");
  assert.equal(evalArtifact.result.artifact?.artifactId, evalArtifact.metadata.artifactId);
  assert.equal(evalArtifact.evidence?.diagnosticErrors?.delta ?? 0, 0);
  assert.equal(listed.total, 3);
  assert.ok(listed.items.some((entry) => entry.artifactId === compareArtifact.metadata.artifactId));
  assert.ok(listed.items.some((entry) => entry.artifactId === gateArtifact.metadata.artifactId));
  assert.ok(listed.items.some((entry) => entry.artifactId === evalArtifact.metadata.artifactId));
  assert.equal(loadedGateArtifact.metadata.artifactId, gateArtifact.metadata.artifactId);
  assert.equal(loadedGateArtifact.metadata.kind, "gate");
  assert.match(renderVerifierInspectArtifactList(listed, { profile: "summary" }), /^Verifier Artifacts/m);
  assert.match(renderVerifierInspectArtifactRecord(gateArtifact, { profile: "summary" }), /^Verifier Artifact/m);
  assert.match(renderVerifierInspectArtifactRecord(gateArtifact, { profile: "summary" }), /policy profile: release/);
  assert.match(renderVerifierInspectArtifactRecord(evalArtifact, { profile: "failures" }), /baseline gate: pass/);
});

test("verifier release handoff, bundle export, and prune stay typed, renderable, and conservative", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-release-store-"));
  const projectStateDir = path.join(root, ".mj-code");
  const artifactStore = new VerifierInspectArtifactStore(projectStateDir);
  const releaseStore = new VerifierReleaseStore(projectStateDir);
  const snapshotStore = new VerifierInspectSnapshotStore(projectStateDir);
  const report = createReplayInspectReport();
  const reference = createReplayInspectReference(report);
  const compare = compareVerifierInspectReports({
    leftReference: reference,
    leftReport: report,
    rightReference: reference,
    rightReport: report,
  });
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const runner = new EvalRunner({
    provider: "mock",
    model: "mock-mj-code-v1",
    maxTokens: 1200,
  });
  const evalResult = runner.runSuite("verification", {
    baselineGate: gate,
  });

  const compareArtifact = await artifactStore.writeCompareArtifact(compare);
  const gateArtifact = await artifactStore.writeGateArtifact(gate);
  const evalArtifact = await artifactStore.writeEvalArtifact(evalResult);

  const compareHandoff = await releaseStore.writeArtifactHandoff(compareArtifact);
  const gateHandoff = await releaseStore.writeArtifactHandoff(gateArtifact);
  const evalHandoff = await releaseStore.writeArtifactHandoff(evalArtifact);
  const latestSelection = await releaseStore.loadHandoff("latest");
  const evalSelection = await releaseStore.loadHandoff(evalArtifact.metadata.artifactId);
  const gateSelection = await releaseStore.loadHandoff(gateArtifact.metadata.artifactId);

  assert.equal(latestSelection.available, true);
  assert.equal(latestSelection.latestCompareArtifactId, compareArtifact.metadata.artifactId);
  assert.equal(latestSelection.latestGateArtifactId, gateArtifact.metadata.artifactId);
  assert.equal(latestSelection.latestEvalArtifactId, evalArtifact.metadata.artifactId);
  assert.equal(evalSelection.handoff?.metadata.handoffId, evalHandoff.metadata.handoffId);
  assert.equal(gateSelection.handoff?.metadata.handoffId, gateHandoff.metadata.handoffId);
  assert.equal(compareHandoff.metadata.sourceKind, "compare");
  assert.match(renderVerifierReleaseHandoff(evalSelection, { profile: "summary" }), /^Verifier Release Handoff/m);
  assert.match(renderVerifierReleaseHandoff(evalSelection, { profile: "summary" }), /source: eval/);
  assert.match(renderVerifierReleaseHandoff(gateSelection, { profile: "failures" }), /^Verifier Release Handoff Failures/m);
  assert.match(renderVerifierReleaseHandoff(gateSelection, { profile: "failures" }), /source: gate/);

  const bundle = await releaseStore.exportBundleForArtifact(compareArtifact);
  const bundleRoles = bundle.files.map((entry) => entry.role).sort();
  assert.equal(bundle.metadata.handoffId, compareHandoff.metadata.handoffId);
  assert.equal(bundle.metadata.primaryArtifactId, compareArtifact.metadata.artifactId);
  assert.deepEqual(bundle.includedArtifacts.map((entry) => entry.artifactId), [compareArtifact.metadata.artifactId]);
  assert.deepEqual(bundleRoles, ["artifact", "bundle", "handoff", "references", "summary"]);
  assert.match(renderVerifierReleaseBundle(bundle, { profile: "summary" }), /^Verifier Bundle/m);
  const bundleSummaryMarkdown = await fs.readFile(bundle.metadata.summaryPath, "utf8");
  assert.match(bundleSummaryMarkdown, /^# Verifier Release Handoff/m);
  assert.match(bundleSummaryMarkdown, new RegExp(compareHandoff.metadata.handoffId));

  const baselineSnapshot = await snapshotStore.exportSnapshot({
    source: reference,
    report,
  });
  await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot: baselineSnapshot,
    policyProfileId: "release",
  });
  const promotedSnapshot = await snapshotStore.exportSnapshot({
    source: reference,
    report,
  });
  const promotedBaseline = await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot: promotedSnapshot,
    policyProfileId: "strict",
  });
  assert.ok(promotedBaseline.promotion);
  const promotionHandoff = await releaseStore.writeBaselinePromotionHandoff({
    baseline: promotedBaseline.baseline,
    promotion: promotedBaseline.promotion,
  });

  const prunePreview = await releaseStore.pruneArtifacts({
    maxArtifactCount: 1,
    dryRun: true,
  });
  assert.equal(prunePreview.deleted.some((entry) =>
    entry.kind === "artifact" && entry.id === compareArtifact.metadata.artifactId
  ), true);
  assert.match(renderVerifierInspectArtifactPruneResult(prunePreview, { profile: "summary" }), /^Verifier Artifact Prune/m);
  await fs.access(artifactStore.getArtifactPath(compareArtifact.metadata.artifactId));
  await fs.access(bundle.metadata.bundlePath);

  const pruneActual = await releaseStore.pruneArtifacts({
    maxArtifactCount: 1,
  });
  assert.equal(pruneActual.deleted.some((entry) =>
    entry.kind === "artifact" && entry.id === compareArtifact.metadata.artifactId
  ), true);
  assert.equal(pruneActual.deleted.some((entry) =>
    entry.kind === "bundle" && entry.id === bundle.metadata.bundleId
  ), true);
  assert.equal(pruneActual.kept.some((entry) =>
    entry.kind === "handoff"
      && entry.id === promotionHandoff.metadata.handoffId
      && entry.reasonKind === "protected_non_artifact"
  ), true);
  await assert.rejects(() => fs.access(artifactStore.getArtifactPath(compareArtifact.metadata.artifactId)));
  assert.ok(pruneActual.keptCount >= 1);
  await fs.access(releaseStore.getHandoffPath(promotionHandoff.metadata.handoffId));
  await assert.rejects(() => fs.access(bundle.metadata.bundlePath));
});

test("verifier promotion plans, triage summaries, and GitHub checks payloads stay typed, auditable, and backfillable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-promotion-triage-"));
  const projectStateDir = path.join(root, ".mj-code");
  const snapshotStore = new VerifierInspectSnapshotStore(projectStateDir);
  const artifactStore = new VerifierInspectArtifactStore(projectStateDir);
  const releaseStore = new VerifierReleaseStore(projectStateDir);
  const promotionStore = new VerifierBaselinePromotionStore(projectStateDir);
  const report = createReplayInspectReport();
  const replayReference = createReplayInspectReference(report);
  const baselineSnapshot = await snapshotStore.exportSnapshot({
    source: replayReference,
    report,
  });
  await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot: baselineSnapshot,
    policyProfileId: "default",
  });
  const resolvedBaseline = await snapshotStore.resolveBaseline("baseline:release-main");
  const compare = compareVerifierInspectReports({
    leftReference: resolvedBaseline.reference,
    leftReport: resolvedBaseline.report,
    rightReference: replayReference,
    rightReport: report,
  });
  const compareArtifact = await artifactStore.writeCompareArtifact(compare);
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const runner = new EvalRunner({
    provider: "mock",
    model: "mock-mj-code-v1",
    maxTokens: 1200,
  });
  const evalResult = runner.runSuite("verification", {
    baselineGate: gate,
  });
  const evalArtifact = await artifactStore.writeEvalArtifact(evalResult);
  await releaseStore.writeArtifactHandoff(compareArtifact);
  const evalHandoff = await releaseStore.writeArtifactHandoff(evalArtifact);
  const bundle = await releaseStore.exportBundle(evalArtifact.metadata.artifactId);

  const blockedPlan = await promotionStore.createPlan({
    baselineName: "release-main",
    reference: compareArtifact.metadata.artifactId,
  });
  assert.equal(blockedPlan.candidate.source.sourceKind, "compare");
  assert.equal(blockedPlan.decision.status, "blocked");
  assert.equal(blockedPlan.approvalStatus, "blocked");
  assert.ok(blockedPlan.decision.reasons.some((entry) => entry.kind === "source_unsupported"));
  assert.match(renderVerifierBaselinePromotionPlan(blockedPlan, { profile: "failures" }), /^Verifier Promotion Failures/m);
  assert.match(renderVerifierBaselinePromotionPlan(blockedPlan, { profile: "failures" }), /source_unsupported/);

  const eligiblePlan = await promotionStore.createPlan({
    baselineName: "release-main",
    reference: evalArtifact.metadata.artifactId,
    policyProfileId: "release",
  });
  assert.equal(eligiblePlan.candidate.source.sourceKind, "eval");
  assert.equal(eligiblePlan.candidate.policyProfileId, "release");
  assert.equal(eligiblePlan.policyInheritanceSource, "explicit");
  assert.equal(eligiblePlan.baselineScope.channel, "release-main");
  assert.equal(eligiblePlan.decision.status, "eligible");
  assert.equal(eligiblePlan.decision.policyInheritanceSource, "explicit");
  assert.equal(eligiblePlan.decision.blockReason, null);
  assert.equal(eligiblePlan.approvalStatus, "pending");
  assert.equal(eligiblePlan.candidate.source.handoffId, evalHandoff.metadata.handoffId);
  assert.match(renderVerifierBaselinePromotionPlan(eligiblePlan, { profile: "summary" }), /^Verifier Promotion Plan/m);
  assert.match(renderVerifierBaselinePromotionPlan(eligiblePlan, { profile: "summary" }), /decision: eligible/);

  const appliedPlan = await promotionStore.approvePlan({
    reference: eligiblePlan.planId,
    approverKind: "workflow",
    approverId: "github-actions",
    approverDisplayName: "GitHub Actions",
    approvalSource: "workflow_dispatch",
    approvalMode: "workflow_apply",
  });
  assert.equal(appliedPlan.approvalStatus, "applied");
  assert.equal(appliedPlan.approval?.approverKind, "workflow");
  assert.equal(appliedPlan.approval?.approverId, "github-actions");
  assert.equal(appliedPlan.approval?.actor.displayName, "GitHub Actions");
  assert.equal(appliedPlan.approval?.source, "workflow_dispatch");
  assert.equal(appliedPlan.approval?.approvalMode, "workflow_apply");
  assert.equal(appliedPlan.approval?.policyInheritanceSource, "explicit");
  assert.ok(appliedPlan.appliedPromotionId);
  assert.ok(appliedPlan.handoffId);
  assert.match(renderVerifierBaselinePromotionPlan(appliedPlan, { profile: "summary" }), /approval: applied/);

  const history = await promotionStore.listHistory("release-main");
  assert.equal(history.total, 1);
  assert.equal(history.items[0].promotionId, appliedPlan.appliedPromotionId);
  assert.equal(history.items[0].candidate?.source.sourceKind, "eval");
  assert.equal(history.items[0].approval?.source, "workflow_dispatch");
  assert.equal(history.items[0].approval?.approvalMode, "workflow_apply");
  assert.match(renderVerifierBaselinePromotionHistory(history, { profile: "summary" }), /^Verifier Promotion History/m);

  const backfillInput = createVerifierGitHubActionsBackfillInputFromEnv({
    GITHUB_RUN_ID: "1001",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_WORKFLOW: "verifier-release-gate",
    GITHUB_JOB: "verifier-release-gate",
    GITHUB_SHA: "abc123def456",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "demo/mj-code",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_ACTOR: "ci-bot",
    MJ_VERIFIER_UPLOAD_NAME: "verifier-release-1001",
    MJ_VERIFIER_UPLOAD_ARTIFACT_ID: "artifact-2002",
    MJ_VERIFIER_UPLOAD_ARTIFACT_URL: "https://github.com/demo/mj-code/actions/runs/1001/artifacts/2002",
    MJ_VERIFIER_UPLOAD_ARTIFACT_DIGEST: "sha256:feedface",
    MJ_VERIFIER_UPLOAD_RETENTION_DAYS: "14",
  });
  assert.ok(backfillInput);
  assert.equal(backfillInput?.workflow?.workflow, "verifier-release-gate");
  assert.equal(backfillInput?.upload?.artifactDigest, "sha256:feedface");

  const backfilledSelection = await releaseStore.backfillGitHubActionsMetadata(
    evalArtifact.metadata.artifactId,
    backfillInput,
  );
  const triage = createVerifierReleaseTriageSummaryFromSelection(backfilledSelection);
  assert.equal(triage.available, true);
  assert.equal(triage.sourceKind, "eval");
  assert.equal(triage.status, "pass");
  assert.equal(triage.pass, true);
  assert.equal(triage.policyProfileId, "release");
  assert.equal(triage.baselineName, "release-main");
  assert.equal(triage.baselineReferenceLabel, "baseline:release-main");
  assert.equal(triage.targetReferenceLabel, "replay:session-render");
  assert.equal(triage.bundleId, bundle.metadata.bundleId);
  assert.equal(triage.workflow?.runId, "1001");
  assert.equal(triage.upload?.artifactId, "artifact-2002");
  assert.equal(triage.upload?.artifactUrl, "https://github.com/demo/mj-code/actions/runs/1001/artifacts/2002");
  assert.equal(triage.upload?.artifactDigest, "sha256:feedface");
  assert.equal(triage.promotionStatus, "eligible");
  assert.equal(triage.promotionEligible, true);
  assert.equal(triage.topAffectedFiles.length, 0);
  assert.equal(triage.githubMutation, null);
  assert.match(renderVerifierReleaseTriageSummary(triage, { profile: "summary" }), /^Verifier Triage/m);
  assert.match(renderVerifierReleaseTriageSummary(triage, { profile: "summary" }), /promotion: eligible/);
  assert.match(renderVerifierReleaseTriageSummary(triage, { profile: "failures" }), /reasons: none/);

  const checksPayload = createVerifierGitHubChecksPayloadFromSelection(backfilledSelection, {
    name: "release-gate-checks",
  });
  assert.equal(checksPayload.available, true);
  assert.equal(checksPayload.name, "release-gate-checks");
  assert.equal(checksPayload.conclusion, "success");
  assert.equal(checksPayload.policyProfileId, "release");
  assert.equal(checksPayload.baselineReferenceLabel, "baseline:release-main");
  assert.equal(checksPayload.targetReferenceLabel, "replay:session-render");
  assert.equal(checksPayload.handoffId, evalHandoff.metadata.handoffId);
  assert.equal(checksPayload.bundleId, bundle.metadata.bundleId);
  assert.equal(checksPayload.workflow?.job, "verifier-release-gate");
  assert.equal(checksPayload.upload?.artifactName, "verifier-release-1001");
  assert.equal(checksPayload.annotationTotal, 0);
  assert.equal(checksPayload.annotationTruncated, false);
  assert.equal(checksPayload.topAffectedFiles.length, 0);
  assert.match(renderVerifierGitHubChecksPayload(checksPayload, { profile: "summary" }), /^Verifier GitHub Checks/m);
  assert.match(renderVerifierGitHubChecksPayload(checksPayload, { profile: "summary" }), /conclusion: success/);

  const loadedEvalArtifact = await artifactStore.loadArtifact(evalArtifact.metadata.artifactId);
  assert.equal(loadedEvalArtifact.metadata.workflow?.runId, "1001");
  assert.equal(loadedEvalArtifact.metadata.upload?.artifactDigest, "sha256:feedface");

  const fallbackMutation = await applyVerifierGitHubMutation({
    reference: "latest",
    payload: checksPayload,
    existing: null,
    env: {},
  });
  assert.equal(fallbackMutation.status, "unavailable");
  assert.equal(fallbackMutation.reasonKind, "token_missing");
  assert.match(renderVerifierGitHubMutationResult(fallbackMutation, { profile: "summary" }), /^Verifier GitHub Mutation/m);

  const successMutation = await applyVerifierGitHubMutation({
    reference: "latest",
    payload: checksPayload,
    existing: null,
    env: {
      GITHUB_TOKEN: "ghs_demo",
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: "demo/mj-code",
      GITHUB_SHA: "abc123def456",
    },
    fetchImpl: async () => ({
      ok: true,
      status: 201,
      async json() {
        return {
          id: 9001,
          html_url: "https://github.com/demo/mj-code/runs/9001",
          details_url: "https://github.com/demo/mj-code/actions/runs/1001",
        };
      },
      async text() {
        return "";
      },
    }),
  });
  assert.equal(successMutation.status, "success");
  assert.equal(successMutation.request.action, "create");
  assert.equal(successMutation.response?.checkRunId, 9001);

  const mutationStore = new VerifierGitHubMutationStore(projectStateDir);
  await mutationStore.writeResult(successMutation);
  const loadedMutation = await mutationStore.loadResult("latest");
  assert.equal(loadedMutation.available, true);
  assert.equal(loadedMutation.result?.response?.checkRunId, 9001);

  const triageWithMutation = createVerifierReleaseTriageSummaryFromSelection(backfilledSelection, {
    githubMutation: successMutation,
  });
  assert.equal(triageWithMutation.githubMutation?.status, "success");
  assert.equal(triageWithMutation.githubMutation?.response?.checkRunId, 9001);
  const checksPayloadWithMutation = createVerifierGitHubChecksPayloadFromSelection(backfilledSelection, {
    name: "release-gate-checks",
    githubMutation: successMutation,
  });
  assert.equal(checksPayloadWithMutation.triage.githubMutation?.status, "success");
  assert.match(renderVerifierGitHubMutationResult(successMutation, { profile: "failures" }), /status: success/);
});

test("verifier drilldown stays typed for current inspect state and latest release continuity", async () => {
  const inspectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-drilldown-inspect-"));
  const inspectDrilldown = await drilldownAgentVerifier({
    config: {
      projectStateDir: path.join(inspectRoot, ".mj-code"),
    },
    executionJournal: {
      async readEntries() {
        return [];
      },
    },
    lastRepairLoop: createRepairLoop(),
    lastTrace: null,
    lastVerifierRun: createVerifierRun(),
    sessionId: "session-render",
    sessionStore: {
      async buildReplay() {
        throw new Error("buildReplay should not be called for current drilldown");
      },
    },
  }, "current");
  assert.equal(inspectDrilldown.sourceKind, "inspect");
  assert.equal(inspectDrilldown.handoffStatus, "inspect");
  assert.equal(inspectDrilldown.topReasons.length > 0, true);
  assert.equal(inspectDrilldown.topAffectedFiles.length > 0, true);
  assert.equal((inspectDrilldown.blockingDiagnostics?.currentCount ?? 0) > 0, true);
  assert.match(renderVerifierDrilldownReport(inspectDrilldown, { profile: "summary" }), /^Verifier Drilldown/m);
  assert.match(renderVerifierDrilldownReport(inspectDrilldown, { profile: "summary" }), /next commands:/);

  const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-drilldown-release-"));
  const projectStateDir = path.join(releaseRoot, ".mj-code");
  const snapshotStore = new VerifierInspectSnapshotStore(projectStateDir);
  const artifactStore = new VerifierInspectArtifactStore(projectStateDir);
  const releaseStore = new VerifierReleaseStore(projectStateDir);
  const mutationStore = new VerifierGitHubMutationStore(projectStateDir);
  const report = createReplayInspectReport();
  const replayReference = createReplayInspectReference(report);
  const baselineSnapshot = await snapshotStore.exportSnapshot({
    source: replayReference,
    report,
  });
  await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot: baselineSnapshot,
    policyProfileId: "release",
  });
  const resolvedBaseline = await snapshotStore.resolveBaseline("baseline:release-main");
  const compare = compareVerifierInspectReports({
    leftReference: resolvedBaseline.reference,
    leftReport: resolvedBaseline.report,
    rightReference: replayReference,
    rightReport: report,
  });
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const gateArtifact = await artifactStore.writeGateArtifact(gate);
  const gateHandoff = await releaseStore.writeArtifactHandoff(gateArtifact);
  const fallbackMutation = await applyVerifierGitHubMutation({
    reference: gateArtifact.metadata.artifactId,
    payload: createVerifierGitHubChecksPayloadFromSelection(await releaseStore.loadHandoff(gateArtifact.metadata.artifactId)),
    existing: null,
    env: {
      GITHUB_REPOSITORY: "demo/mj-code",
      GITHUB_SHA: "abc123def456",
    },
  });
  const persistedMutation = await mutationStore.writeResult({
    ...fallbackMutation,
    handoffId: gateHandoff.metadata.handoffId,
  });
  const releaseDrilldown = await drilldownAgentVerifier({
    config: {
      projectStateDir,
    },
    executionJournal: {
      async readEntries() {
        return [];
      },
    },
    lastRepairLoop: null,
    lastTrace: null,
    lastVerifierRun: null,
    sessionId: null,
    sessionStore: {
      async buildReplay() {
        throw new Error("buildReplay should not be called for latest release drilldown");
      },
    },
  }, "latest");
  assert.equal(releaseDrilldown.sourceKind, "release");
  assert.equal(releaseDrilldown.handoffId, gateHandoff.metadata.handoffId);
  assert.equal(releaseDrilldown.primaryArtifactId, gateArtifact.metadata.artifactId);
  assert.equal(releaseDrilldown.githubMutation?.mutationId, persistedMutation.mutationId);
  assert.equal(releaseDrilldown.githubMutation?.reasonKind, "token_missing");
  assert.equal(releaseDrilldown.recommendedCommands.some((entry) => entry.command === "node src/cli.mjs verifier github result latest summary"), true);
  assert.match(renderVerifierDrilldownReport(releaseDrilldown, { profile: "failures" }), /^Verifier Drilldown Failures/m);
  assert.match(renderVerifierDrilldownReport(releaseDrilldown, { profile: "failures" }), /token_missing/);
});

test("verifier timeline stays typed for current inspect state and latest release continuity", async () => {
  const inspectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-timeline-inspect-"));
  const inspectTimeline = await timelineAgentVerifier({
    config: {
      projectStateDir: path.join(inspectRoot, ".mj-code"),
    },
    executionJournal: {
      async readEntries() {
        return [];
      },
    },
    lastRepairLoop: createRepairLoop(),
    lastTrace: null,
    lastVerifierRun: createVerifierRun(),
    sessionId: "session-timeline",
    sessionStore: {
      async buildReplay() {
        throw new Error("buildReplay should not be called for current timeline");
      },
    },
  }, "current");
  assert.equal(inspectTimeline.sourceKind, "inspect");
  assert.equal(inspectTimeline.focus.sourceKind, "inspect");
  assert.equal(inspectTimeline.events.some((entry) => entry.kind === "verifier_run"), true);
  assert.equal(inspectTimeline.events.some((entry) => entry.kind === "repair_loop"), true);
  assert.equal(inspectTimeline.recommendedCommands[0]?.command, "node src/cli.mjs verifier drilldown current summary");
  assert.match(renderVerifierTimelineReport(inspectTimeline, { profile: "summary" }), /^Verifier Timeline/m);
  assert.match(renderVerifierTimelineReport(inspectTimeline, { profile: "summary" }), /leading events:/);

  const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-timeline-release-"));
  const projectStateDir = path.join(releaseRoot, ".mj-code");
  const snapshotStore = new VerifierInspectSnapshotStore(projectStateDir);
  const artifactStore = new VerifierInspectArtifactStore(projectStateDir);
  const releaseStore = new VerifierReleaseStore(projectStateDir);
  const mutationStore = new VerifierGitHubMutationStore(projectStateDir);
  const report = createReplayInspectReport();
  const replayReference = createReplayInspectReference(report);
  const baselineSnapshot = await snapshotStore.exportSnapshot({
    source: replayReference,
    report,
  });
  await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot: baselineSnapshot,
    policyProfileId: "release",
  });
  const resolvedBaseline = await snapshotStore.resolveBaseline("baseline:release-main");
  const compare = compareVerifierInspectReports({
    leftReference: resolvedBaseline.reference,
    leftReport: resolvedBaseline.report,
    rightReference: replayReference,
    rightReport: report,
  });
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const gateArtifact = await artifactStore.writeGateArtifact(gate);
  await releaseStore.writeArtifactHandoff(gateArtifact);
  await releaseStore.exportBundle(gateArtifact.metadata.artifactId);
  const mutation = await applyVerifierGitHubMutation({
    reference: gateArtifact.metadata.artifactId,
    payload: createVerifierGitHubChecksPayloadFromSelection(await releaseStore.loadHandoff(gateArtifact.metadata.artifactId)),
    existing: null,
    env: {
      GITHUB_REPOSITORY: "demo/mj-code",
      GITHUB_SHA: "abc123def456",
    },
  });
  await mutationStore.writeResult(mutation);

  const releaseTimeline = await timelineAgentVerifier({
    config: {
      projectStateDir,
    },
    executionJournal: {
      async readEntries() {
        return [];
      },
    },
    lastRepairLoop: null,
    lastTrace: null,
    lastVerifierRun: null,
    sessionId: null,
    sessionStore: {
      async buildReplay() {
        throw new Error("buildReplay should not be called for latest release timeline");
      },
    },
  }, "latest");
  assert.equal(releaseTimeline.sourceKind, "release");
  assert.equal(releaseTimeline.focus.sourceKind, "release");
  assert.equal(releaseTimeline.events.some((entry) => entry.kind === "artifact_created"), true);
  assert.equal(releaseTimeline.events.some((entry) => entry.kind === "handoff_created"), true);
  assert.equal(releaseTimeline.events.some((entry) => entry.kind === "bundle_exported"), true);
  assert.equal(releaseTimeline.events.some((entry) => entry.kind === "promotion_planned"), true);
  assert.equal(releaseTimeline.events.some((entry) => entry.kind === "github_mutation"), true);
  assert.equal(releaseTimeline.continuity.githubMutationId, mutation.mutationId);
  assert.equal(releaseTimeline.recommendedCommands.some((entry) => entry.command === "node src/cli.mjs verifier github result latest summary"), true);
  assert.match(renderVerifierTimelineReport(releaseTimeline, { profile: "failures" }), /^Verifier Timeline Failures/m);
  assert.match(renderVerifierTimelineReport(releaseTimeline, { profile: "failures" }), /github_mutation/);
});

test("verifier inspect export and compare render layers keep stable operator summaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-render-export-"));
  const store = new VerifierInspectSnapshotStore(path.join(root, ".mj-code"));
  const replayReport = createReplayInspectReport();
  const snapshot = await store.exportSnapshot({
    source: createReplayInspectReference(replayReport),
    report: replayReport,
  });
  const list = await store.listSnapshots();
  const compare = compareVerifierInspectReports({
    leftReference: createVerifierInspectResolvedReference({
      kind: "snapshot",
      reference: snapshot.metadata.snapshotId,
      scope: snapshot.report.scope,
      sessionId: snapshot.report.sessionId,
      traceId: snapshot.report.traceId,
      replayReference: snapshot.metadata.source.replayReference,
      snapshotId: snapshot.metadata.snapshotId,
    }),
    leftReport: snapshot.report,
    rightReference: createReplayInspectReference(replayReport),
    rightReport: replayReport,
  });

  assert.deepEqual(renderVerifierInspectSnapshotRecord(snapshot, { profile: "summary" }).split("\n"), [
    "Verifier Export",
    `snapshot: ${snapshot.metadata.snapshotId}`,
    `created: ${snapshot.metadata.createdAt}`,
    "source: replay:session-render",
    "scope: replay",
    "session: session-render",
    "trace: trace-verifier",
    "final outcome: success",
    "latest verifier: passed",
    "latest repair: succeeded (resolved)",
    "continuity: verifier runs 2, repair loops 1, attempts 1",
    "assist: fix hints 1, code actions 1 (1 applied), context items 1",
  ]);

  assert.deepEqual(renderVerifierInspectSnapshotList(list, { profile: "summary" }).split("\n"), [
    "Verifier Exports",
    "total: 1",
    `1. ${snapshot.metadata.snapshotId} ${snapshot.metadata.createdAt}`,
    "   replay:session-render; outcome success; latest verifier passed; latest repair succeeded",
    "   runs 2, loops 1, attempts 1, fix hints 1, code actions 1 applied, context 1",
  ]);

  assert.deepEqual(renderVerifierInspectCompareReport(compare, { profile: "summary" }).split("\n"), [
    "Verifier Compare",
    `left: snapshot:${snapshot.metadata.snapshotId}`,
    "right: replay:session-render",
    "final outcome: success",
    "latest verifier: passed",
    "latest repair: succeeded (resolved)",
    "diagnostics: errors 0 -> 0 (0), warnings 0 -> 0 (0), info 0 -> 0 (0)",
    "continuity: verifier runs 2 -> 2 (0), repair loops 1 -> 1 (0), attempts 1 -> 1 (0)",
    "convergence: resolved 1 -> 1 (0), improved 0 -> 0 (0), unchanged 0 -> 0 (0), regressed 0 -> 0 (0)",
    "assist: fix hints 1 -> 1 (0), code actions 1 -> 1 (0), applied 1 -> 1 (0), context items 1 -> 1 (0)",
    "availability: fix hints no, code actions yes, context no",
    "blocking diagnostics: No blocking diagnostics on either side.",
    "no continuity deltas detected.",
  ]);

  assert.deepEqual(renderVerifierInspectCompareReport(compare, { profile: "failures" }).split("\n"), [
    "Verifier Compare Failures",
    `left: snapshot:${snapshot.metadata.snapshotId}`,
    "right: replay:session-render",
    "final outcome: success",
    "latest verifier: passed",
    "latest repair: succeeded (resolved)",
    "blocking diagnostics: No blocking diagnostics on either side.",
    "no blocking diagnostic continuity changes.",
  ]);
});

test("verifier inspect trace report exposes verifier-only data without repair noise", () => {
  const verifierRun = createVerifierRun({
    checks: [],
    summary: {
      status: "passed",
      passed: true,
      totalChecks: 1,
      passedChecks: 1,
      failedChecks: 0,
      skippedChecks: 0,
      findings: 0,
      failureCategories: [],
      summary: "Verifier passed.",
      durationMs: 30,
      diagnosticProviderAvailable: true,
      diagnosticErrorCount: 0,
      diagnosticWarningCount: 0,
      diagnosticInfoCount: 0,
      fixHintAvailable: false,
      fixHintSource: "none",
      fixHintCount: 0,
      recommendedFixHintCount: 0,
      fixHintFileCount: 0,
      fixHintReason: null,
      codeActionAvailable: false,
      codeActionSource: "none",
      codeActionCandidateCount: 0,
      codeActionAllowlistedCount: 0,
      codeActionBlockedCount: 0,
      codeActionReason: null,
      projectContextAvailable: false,
      projectContextSource: "none",
      projectContextCount: 0,
      projectContextDiagnosticCoverageCount: 0,
      projectContextQuickInfoCount: 0,
      projectContextDefinitionCount: 0,
      projectContextImplementationCount: 0,
      projectContextReferenceCount: 0,
      projectContextDocumentSymbolCount: 0,
      projectContextFileCount: 0,
      projectContextReason: null,
    },
  });
  const report = buildTraceVerifierInspectReport({
    sessionId: "session-trace",
    lastTrace: {
      traceId: "trace-verifier",
      success: true,
      stopped: false,
      steps: 2,
      durationMs: 50,
      toolsUsed: ["write_file"],
      approvalsAsked: 0,
      approvalsApproved: 0,
      approvalsDenied: 0,
      verifier: verifierRun.summary,
      repair: null,
    },
    lastVerifierRun: verifierRun,
    lastRepairLoop: null,
    entries: [{
      timestamp: "2026-04-05T00:00:01.000Z",
      sessionId: "session-trace",
      type: "verifier_run",
      traceId: "trace-verifier",
      stepId: 2,
      phase: "verify",
      payload: verifierRun,
    }],
  });

  assert.equal(report.scope, "trace");
  assert.equal(report.traceId, "trace-verifier");
  assert.equal(report.summary.verifierRunCount, 1);
  assert.equal(report.summary.failedVerifierRunCount, 0);
  assert.equal(report.summary.repairLoopCount, 0);
  assert.equal(report.summary.latestRepairProgress, "none");
  assert.equal(report.summary.tsserverDiagnosticRunCount, 1);
  assert.equal(report.summary.fixHintCount, 0);
  assert.equal(report.summary.latestFixHintAvailable, false);
  assert.equal(report.summary.latestFixHintSource, "none");
  assert.equal(report.summary.codeActionCandidateCount, 0);
  assert.equal(report.summary.codeActionAllowlistedCount, 0);
  assert.equal(report.summary.codeActionAppliedCount, 0);
  assert.equal(report.summary.codeActionBlockedCount, 0);
  assert.equal(report.summary.projectContextCount, 0);
  assert.equal(report.summary.latestProjectContextAvailable, false);
  assert.equal(report.summary.latestCodeActionAvailable, false);
  assert.equal(report.summary.latestCodeActionSource, "none");
  assert.equal(report.summary.latestCodeActionApplied, false);
  assert.equal(report.summary.latestCodeActionStatus, "none");
  assert.equal(report.summary.latestDiagnosticEngine, "tsserver");
  assert.equal(report.summary.finalOutcome, "success");
});

test("verifier inspect replay report summarizes verifier fail-repair-pass chains with deduped repair loops", () => {
  const failedRun = createVerifierRun();
  const passedRun = createVerifierRun({
    step: 3,
    startedAt: "2026-04-05T00:00:02.000Z",
    finishedAt: "2026-04-05T00:00:03.000Z",
    checks: [],
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
      durationMs: 40,
      diagnosticProviderAvailable: true,
      diagnosticErrorCount: 0,
      diagnosticWarningCount: 0,
      diagnosticInfoCount: 0,
      fixHintAvailable: false,
      fixHintSource: "none",
      fixHintCount: 0,
      recommendedFixHintCount: 0,
      fixHintFileCount: 0,
      fixHintReason: null,
      codeActionAvailable: false,
      codeActionSource: "none",
      codeActionCandidateCount: 0,
      codeActionAllowlistedCount: 0,
      codeActionBlockedCount: 0,
      codeActionReason: null,
      projectContextAvailable: false,
      projectContextSource: "none",
      projectContextCount: 0,
      projectContextDiagnosticCoverageCount: 0,
      projectContextQuickInfoCount: 0,
      projectContextDefinitionCount: 0,
      projectContextImplementationCount: 0,
      projectContextReferenceCount: 0,
      projectContextDocumentSymbolCount: 0,
      projectContextFileCount: 0,
      projectContextReason: null,
    },
  });
  const retryingLoop = createRepairLoop({
    finishedAt: null,
    attempts: [{
      ...createRepairLoop().attempts[0],
      finishedAt: null,
      status: "retrying",
      convergence: null,
      resultVerifierStartedAt: null,
      resultVerifierStep: null,
      resultVerifierSummary: null,
    }],
    summary: {
      status: "retrying",
      attemptsUsed: 1,
      maxAttempts: 1,
      attemptsRemaining: 0,
      lastDecision: "retry",
      stopReason: null,
      triggeredByVerifierStartedAt: "2026-04-05T00:00:00.000Z",
      latestProgress: "none",
      progressTrend: "none",
      resolvedAttemptCount: 0,
      improvedAttemptCount: 0,
      unchangedAttemptCount: 0,
      regressedAttemptCount: 0,
      notApplicableAttemptCount: 0,
      resolvedDiagnosticCount: 0,
      persistedDiagnosticCount: 0,
      introducedDiagnosticCount: 0,
      codeActionAppliedCount: 0,
      codeActionBlockedCount: 0,
      latestCodeActionStatus: "none",
      summary: "Repair attempt 1/1 started from verifier failure.",
    },
  });
  const succeededLoop = createRepairLoop();

  const report = buildReplayVerifierInspectReport({
    session: {
      id: "session-replay",
      provider: "mock",
      model: "mock-mj-code-v1",
      cwd: "/repo",
      networkMode: "docs-only",
      webProvider: "fallback",
      parentSessionId: null,
      branchType: "root",
    },
    lineage: {
      rootSessionId: "session-replay",
      parentSessionId: null,
      branchDepth: 0,
      branchType: "root",
      resumedAt: null,
      resumedFromSnapshot: null,
      ancestors: [],
      children: [],
    },
    branchEventsSessionId: "session-replay",
    prompts: [],
    context: [],
    approvals: [],
    toolCalls: [],
    webEvents: [],
    mcpEvents: [],
    hookEvents: [],
    boundaryDecisions: [],
    sourcePacks: [],
    changes: [],
    verifierRuns: [
      { timestamp: "2026-04-05T00:00:01.000Z", run: failedRun },
      { timestamp: "2026-04-05T00:00:03.000Z", run: passedRun },
    ],
    repairLoops: [
      { timestamp: "2026-04-05T00:00:01.500Z", loop: retryingLoop },
      { timestamp: "2026-04-05T00:00:02.500Z", loop: succeededLoop },
    ],
    finals: [{
      timestamp: "2026-04-05T00:00:03.500Z",
      success: true,
      stopped: false,
      content: "Repair completed.",
      steps: 3,
      sourceIds: [],
    }],
  });

  assert.equal(report.scope, "replay");
  assert.equal(report.summary.verifierRunCount, 2);
  assert.equal(report.summary.failedVerifierRunCount, 1);
  assert.equal(report.summary.passedVerifierRunCount, 1);
  assert.equal(report.summary.repairLoopCount, 1);
  assert.equal(report.summary.repairAttemptCount, 1);
  assert.equal(report.summary.repairSucceededCount, 1);
  assert.equal(report.summary.repairResolvedCount, 1);
  assert.equal(report.summary.latestRepairProgress, "resolved");
  assert.equal(report.summary.resolvedDiagnosticCount, 1);
  assert.equal(report.summary.tsserverDiagnosticRunCount, 2);
  assert.equal(report.summary.fixHintCount, 1);
  assert.equal(report.summary.recommendedFixHintCount, 1);
  assert.equal(report.summary.latestFixHintAvailable, false);
  assert.equal(report.summary.latestFixHintSource, "none");
  assert.equal(report.summary.codeActionCandidateCount, 1);
  assert.equal(report.summary.codeActionAllowlistedCount, 1);
  assert.equal(report.summary.codeActionAppliedCount, 1);
  assert.equal(report.summary.codeActionBlockedCount, 0);
  assert.equal(report.summary.projectContextCount, 1);
  assert.equal(report.summary.projectContextDefinitionCount, 1);
  assert.equal(report.summary.projectContextImplementationCount, 1);
  assert.equal(report.summary.projectContextReferenceCount, 1);
  assert.equal(report.summary.projectContextDocumentSymbolCount, 2);
  assert.equal(report.summary.latestProjectContextAvailable, false);
  assert.equal(report.summary.latestProjectContextSource, "none");
  assert.equal(report.summary.latestCodeActionApplied, true);
  assert.equal(report.summary.latestCodeActionStatus, "applied");
  assert.equal(report.summary.latestCodeActionBlockedReason, null);
  assert.equal(report.summary.diagnosticsFallbackCount, 0);
  assert.equal(report.summary.finalOutcome, "success");
  assert.equal(report.latest.repairLoop.summary.status, "succeeded");
});

test("verifier inspect replay report exposes exhausted repair outcomes", () => {
  const firstFail = createVerifierRun();
  const secondFail = createVerifierRun({
    step: 3,
    startedAt: "2026-04-05T00:00:02.000Z",
    finishedAt: "2026-04-05T00:00:03.000Z",
    summary: {
      status: "failed",
      passed: false,
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      skippedChecks: 0,
      findings: 1,
      failureCategories: ["diagnostic_error"],
      summary: "Verifier still failed after repair.",
      durationMs: 45,
      diagnosticProviderAvailable: true,
      diagnosticErrorCount: 1,
      diagnosticWarningCount: 0,
      diagnosticInfoCount: 0,
      codeActionAvailable: true,
      codeActionSource: "tsserver",
      codeActionCandidateCount: 1,
      codeActionAllowlistedCount: 1,
      codeActionBlockedCount: 0,
      codeActionReason: null,
    },
  });
  const exhaustedLoop = createRepairLoop({
    attempts: [{
      ...createRepairLoop().attempts[0],
      status: "failed",
      summary: "Repair attempt 1/1 failed to clear the verifier findings.",
      codeAction: {
        ...createRepairLoop().attempts[0].codeAction,
        status: "blocked",
        applied: false,
        blockedReason: "not_allowlisted",
        approvalRequired: false,
        approvalStatus: "blocked",
        toolName: null,
        changeSetId: null,
        summary: "Blocked the primary code action because it was not allowlisted.",
      },
      convergence: {
        compared: true,
        state: "unchanged",
        summary: "Repair made no measurable diagnostics progress. Diagnostics delta: errors 1 -> 1, warnings 0 -> 0, info 0 -> 0, resolved 0, persisted 1, introduced 0.",
        delta: {
          comparable: true,
          summary: "Diagnostics delta: errors 1 -> 1, warnings 0 -> 0, info 0 -> 0, resolved 0, persisted 1, introduced 0.",
          beforeTotal: 1,
          afterTotal: 1,
          beforeErrorCount: 1,
          afterErrorCount: 1,
          beforeWarningCount: 0,
          afterWarningCount: 0,
          beforeInfoCount: 0,
          afterInfoCount: 0,
          resolvedCount: 0,
          persistedCount: 1,
          introducedCount: 0,
          resolved: [],
          persisted: [{
            fingerprint: "diag-broken",
            path: "/repo/src/broken.ts",
            line: 3,
            column: 14,
            code: "TS2322",
            message: "Type 'number' is not assignable to type 'string'.",
            source: "typescript",
            scope: "file",
            category: "diagnostic_error",
            rule: null,
          }],
          introduced: [],
          beforeEngine: "tsserver",
          afterEngine: "tsserver",
          beforeFallbackUsed: false,
          afterFallbackUsed: false,
          beforeTransportAvailable: true,
          afterTransportAvailable: true,
        },
      },
    }],
    summary: {
      status: "exhausted",
      attemptsUsed: 1,
      maxAttempts: 1,
      attemptsRemaining: 0,
      lastDecision: "stop",
      stopReason: "attempts_exhausted",
      triggeredByVerifierStartedAt: "2026-04-05T00:00:00.000Z",
      latestProgress: "unchanged",
      progressTrend: "unchanged",
      resolvedAttemptCount: 0,
      improvedAttemptCount: 0,
      unchangedAttemptCount: 1,
      regressedAttemptCount: 0,
      notApplicableAttemptCount: 0,
      resolvedDiagnosticCount: 0,
      persistedDiagnosticCount: 1,
      introducedDiagnosticCount: 0,
      codeActionAppliedCount: 0,
      codeActionBlockedCount: 1,
      latestCodeActionStatus: "blocked",
      summary: "Repair loop exhausted after 1/1 attempt(s); verification is still failing.",
    },
  });

  const report = buildReplayVerifierInspectReport({
    session: {
      id: "session-exhausted",
      provider: "mock",
      model: "mock-mj-code-v1",
      cwd: "/repo",
      networkMode: "docs-only",
      webProvider: "fallback",
      parentSessionId: null,
      branchType: "root",
    },
    lineage: {
      rootSessionId: "session-exhausted",
      parentSessionId: null,
      branchDepth: 0,
      branchType: "root",
      resumedAt: null,
      resumedFromSnapshot: null,
      ancestors: [],
      children: [],
    },
    branchEventsSessionId: "session-exhausted",
    prompts: [],
    context: [],
    approvals: [],
    toolCalls: [],
    webEvents: [],
    mcpEvents: [],
    hookEvents: [],
    boundaryDecisions: [],
    sourcePacks: [],
    changes: [],
    verifierRuns: [
      { timestamp: "2026-04-05T00:00:01.000Z", run: firstFail },
      { timestamp: "2026-04-05T00:00:03.000Z", run: secondFail },
    ],
    repairLoops: [
      { timestamp: "2026-04-05T00:00:02.500Z", loop: exhaustedLoop },
    ],
    finals: [{
      timestamp: "2026-04-05T00:00:03.500Z",
      success: false,
      stopped: true,
      errorTaxonomy: "verifier_failed",
      content: "Verification failed.",
      steps: 3,
      sourceIds: [],
    }],
  });

  assert.equal(report.summary.repairLoopCount, 1);
  assert.equal(report.summary.repairExhaustedCount, 1);
  assert.equal(report.summary.repairUnchangedCount, 1);
  assert.equal(report.summary.failedVerifierRunCount, 2);
  assert.equal(report.summary.codeActionCandidateCount, 2);
  assert.equal(report.summary.codeActionAllowlistedCount, 2);
  assert.equal(report.summary.codeActionAppliedCount, 0);
  assert.equal(report.summary.codeActionBlockedCount, 1);
  assert.equal(report.summary.projectContextCount, 2);
  assert.equal(report.summary.projectContextImplementationCount, 2);
  assert.equal(report.summary.projectContextReferenceCount, 2);
  assert.equal(report.summary.projectContextDocumentSymbolCount, 4);
  assert.equal(report.summary.latestCodeActionApplied, false);
  assert.equal(report.summary.latestCodeActionStatus, "blocked");
  assert.equal(report.summary.latestCodeActionBlockedReason, "not_allowlisted");
  assert.equal(report.summary.finalOutcome, "failed");
});

test("cli verifier commands return stable inspect reports without requiring an API key", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-cli-empty-"));
  const current = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  const currentReport = JSON.parse(current.stdout);
  assert.equal(currentReport.scope, "current");
  assert.equal(currentReport.summary.hasData, false);
  assert.equal(currentReport.summary.verifierRunCount, 0);

  const trace = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "trace",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  const traceReport = JSON.parse(trace.stdout);
  assert.equal(traceReport.scope, "trace");
  assert.equal(traceReport.summary.hasData, false);

  const summary = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "--format",
    "summary",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.deepEqual(summary.stdout.trim().split("\n"), [
    "Verifier Summary",
    "scope: current",
    "session: none",
    "trace: none",
    "final outcome: unknown",
    "no verifier or repair data recorded.",
  ]);

  const traceFailures = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "trace",
    "failures",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.deepEqual(traceFailures.stdout.trim().split("\n"), [
    "Verifier Failures",
    "scope: trace",
    "session: none",
    "trace: none",
    "final outcome: unknown",
    "no verifier or repair data recorded.",
  ]);

  const exportCurrent = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "export",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  const exportRecord = JSON.parse(exportCurrent.stdout);
  assert.match(exportRecord.metadata.snapshotId, /^vis-/);
  assert.equal(exportRecord.metadata.source.kind, "current");
  assert.equal(exportRecord.report.summary.hasData, false);

  const exportList = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "exports",
    "summary",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(exportList.stdout, /^Verifier Exports/m);
  assert.match(exportList.stdout, new RegExp(exportRecord.metadata.snapshotId));

  const compareSummary = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "compare",
    "current",
    `snapshot:${exportRecord.metadata.snapshotId}`,
    "summary",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(compareSummary.stdout, /^Verifier Compare/m);
  assert.match(compareSummary.stdout, /blocking diagnostics: No blocking diagnostics on either side\./);
  assert.match(compareSummary.stdout, /no continuity deltas detected\./);

  const baselinePin = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "baseline",
    "pin",
    `snapshot:${exportRecord.metadata.snapshotId}`,
    "empty-current",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  const baselineRecord = JSON.parse(baselinePin.stdout);
  assert.equal(baselineRecord.metadata.name, "empty-current");
  assert.equal(baselineRecord.metadata.snapshotId, exportRecord.metadata.snapshotId);
  assert.equal(baselineRecord.metadata.policyProfileId, "default");

  const baselinesSummary = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "baselines",
    "summary",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(baselinesSummary.stdout, /^Verifier Baselines/m);
  assert.match(baselinesSummary.stdout, /empty-current/);

  const gatePass = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "gate",
    "baseline:empty-current",
    "current",
    "summary",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(gatePass.stdout, /^Verifier Gate/m);
  assert.match(gatePass.stdout, /status: pass/);

  const policiesSummary = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "policies",
    "summary",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(policiesSummary.stdout, /^Verifier Gate Policies/m);
  assert.match(policiesSummary.stdout, /default \(builtin\)/);
  assert.match(policiesSummary.stdout, /release \(builtin\)/);

  const gateArtifact = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "gate",
    "baseline:empty-current",
    "current",
    "--policy",
    "release",
    "--write-artifact",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  const gateArtifactDecision = JSON.parse(gateArtifact.stdout);
  assert.equal(gateArtifactDecision.profile.id, "release");
  assert.ok(gateArtifactDecision.artifact?.artifactId);

  const artifactsSummary = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "artifacts",
    "summary",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(artifactsSummary.stdout, /^Verifier Artifacts/m);
  assert.match(artifactsSummary.stdout, new RegExp(gateArtifactDecision.artifact.artifactId));

  const artifactSummary = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "artifact",
    gateArtifactDecision.artifact.artifactId,
    "summary",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(artifactSummary.stdout, /^Verifier Artifact/m);
  assert.match(artifactSummary.stdout, /policy profile: release/);
});

test("cli verifier checks export honors global github-actions backfill flags and emits workflow metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-cli-github-actions-"));
  const snapshotStore = new VerifierInspectSnapshotStore(path.join(root, ".mj-code"));
  const artifactStore = new VerifierInspectArtifactStore(path.join(root, ".mj-code"));
  const releaseStore = new VerifierReleaseStore(path.join(root, ".mj-code"));
  const report = buildCurrentVerifierInspectReport({
    sessionId: null,
    lastTrace: null,
    lastVerifierRun: null,
    lastRepairLoop: null,
  });
  const currentReference = createVerifierInspectResolvedReference({
    kind: "current",
    scope: report.scope,
    sessionId: report.sessionId,
    traceId: report.traceId,
  });
  const snapshot = await snapshotStore.exportSnapshot({
    source: currentReference,
    report,
  });
  await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot,
    policyProfileId: "release",
  });
  const compare = compareVerifierInspectReports({
    leftReference: createVerifierInspectResolvedReference({
      kind: "baseline",
      reference: "release-main",
      scope: report.scope,
      sessionId: report.sessionId,
      traceId: report.traceId,
      snapshotId: snapshot.metadata.snapshotId,
      baselineName: "release-main",
    }),
    leftReport: report,
    rightReference: currentReference,
    rightReport: report,
  });
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const runner = new EvalRunner({
    provider: "mock",
    model: "mock-mj-code-v1",
    maxTokens: 1200,
  });
  const evalResult = runner.runSuite("verification", {
    baselineGate: gate,
  });
  const evalArtifact = await artifactStore.writeEvalArtifact(evalResult);
  await releaseStore.writeArtifactHandoff(evalArtifact);

  const checks = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "checks",
    "export",
    "latest",
    "json",
    "--github-actions",
    "--cwd",
    root,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITHUB_RUN_ID: "901",
      GITHUB_RUN_ATTEMPT: "3",
      GITHUB_WORKFLOW: "verifier-release-gate",
      GITHUB_JOB: "verifier-release-gate",
      GITHUB_SHA: "abc123def456",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "demo/mj-code",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_ACTOR: "cli-test",
      MJ_VERIFIER_UPLOAD_NAME: "verifier-release-901",
      MJ_VERIFIER_UPLOAD_ARTIFACT_ID: "artifact-901",
      MJ_VERIFIER_UPLOAD_ARTIFACT_URL: "https://github.com/demo/mj-code/actions/runs/901/artifacts/901",
      MJ_VERIFIER_UPLOAD_ARTIFACT_DIGEST: "sha256:cli901",
      MJ_VERIFIER_UPLOAD_RETENTION_DAYS: "14",
    },
  });
  const payload = JSON.parse(checks.stdout);
  assert.equal(payload.workflow.runId, "901");
  assert.equal(payload.workflow.actor, "cli-test");
  assert.equal(payload.upload.artifactId, "artifact-901");
  assert.equal(payload.upload.artifactDigest, "sha256:cli901");
  assert.equal(payload.triage.workflow.runId, "901");
  assert.equal(payload.triage.upload.artifactUrl, "https://github.com/demo/mj-code/actions/runs/901/artifacts/901");
});

test("cli verifier drilldown covers current inspect state and latest mutation continuity", async () => {
  const currentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-cli-drilldown-current-"));
  const current = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "drilldown",
    "current",
    "summary",
    "--cwd",
    currentRoot,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(current.stdout, /^Verifier Drilldown/m);
  assert.match(current.stdout, /source: inspect/);
  assert.match(current.stdout, /reference: current/);
  assert.match(current.stdout, /next commands:/);

  const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-cli-drilldown-release-"));
  const projectStateDir = path.join(releaseRoot, ".mj-code");
  const snapshotStore = new VerifierInspectSnapshotStore(projectStateDir);
  const artifactStore = new VerifierInspectArtifactStore(projectStateDir);
  const releaseStore = new VerifierReleaseStore(projectStateDir);
  const mutationStore = new VerifierGitHubMutationStore(projectStateDir);
  const report = createReplayInspectReport();
  const replayReference = createReplayInspectReference(report);
  const baselineSnapshot = await snapshotStore.exportSnapshot({
    source: replayReference,
    report,
  });
  await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot: baselineSnapshot,
    policyProfileId: "release",
  });
  const resolvedBaseline = await snapshotStore.resolveBaseline("baseline:release-main");
  const compare = compareVerifierInspectReports({
    leftReference: resolvedBaseline.reference,
    leftReport: resolvedBaseline.report,
    rightReference: replayReference,
    rightReport: report,
  });
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const gateArtifact = await artifactStore.writeGateArtifact(gate);
  const gateSelection = await releaseStore.loadHandoff(gateArtifact.metadata.artifactId);
  const mutation = await applyVerifierGitHubMutation({
    reference: "latest",
    payload: createVerifierGitHubChecksPayloadFromSelection(gateSelection),
    existing: null,
    env: {
      GITHUB_REPOSITORY: "demo/mj-code",
      GITHUB_SHA: "abc123def456",
    },
  });
  await mutationStore.writeResult(mutation);

  const latest = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "drilldown",
    "latest",
    "failures",
    "--cwd",
    releaseRoot,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(latest.stdout, /^Verifier Drilldown Failures/m);
  assert.match(latest.stdout, /github mutation: unavailable; GITHUB_TOKEN is unavailable/);
  assert.match(latest.stdout, /node src\/cli\.mjs verifier github result latest summary/);
});

test("cli verifier timeline covers current inspect state and latest release continuity", async () => {
  const currentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-cli-timeline-current-"));
  const current = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "timeline",
    "current",
    "summary",
    "--cwd",
    currentRoot,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(current.stdout, /^Verifier Timeline/m);
  assert.match(current.stdout, /source: inspect/);
  assert.match(current.stdout, /leading events:/);
  assert.match(current.stdout, /node src\/cli\.mjs verifier drilldown current summary/);

  const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-cli-timeline-release-"));
  const projectStateDir = path.join(releaseRoot, ".mj-code");
  const snapshotStore = new VerifierInspectSnapshotStore(projectStateDir);
  const artifactStore = new VerifierInspectArtifactStore(projectStateDir);
  const releaseStore = new VerifierReleaseStore(projectStateDir);
  const mutationStore = new VerifierGitHubMutationStore(projectStateDir);
  const report = createReplayInspectReport();
  const replayReference = createReplayInspectReference(report);
  const baselineSnapshot = await snapshotStore.exportSnapshot({
    source: replayReference,
    report,
  });
  await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot: baselineSnapshot,
    policyProfileId: "release",
  });
  const resolvedBaseline = await snapshotStore.resolveBaseline("baseline:release-main");
  const compare = compareVerifierInspectReports({
    leftReference: resolvedBaseline.reference,
    leftReport: resolvedBaseline.report,
    rightReference: replayReference,
    rightReport: report,
  });
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const gateArtifact = await artifactStore.writeGateArtifact(gate);
  const gateSelection = await releaseStore.loadHandoff(gateArtifact.metadata.artifactId);
  await releaseStore.exportBundle(gateArtifact.metadata.artifactId);
  const mutation = await applyVerifierGitHubMutation({
    reference: "latest",
    payload: createVerifierGitHubChecksPayloadFromSelection(gateSelection),
    existing: null,
    env: {
      GITHUB_REPOSITORY: "demo/mj-code",
      GITHUB_SHA: "abc123def456",
    },
  });
  await mutationStore.writeResult(mutation);

  const latest = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "timeline",
    "latest",
    "failures",
    "--cwd",
    releaseRoot,
    "--provider",
    "openai-compatible",
  ], {
    cwd: process.cwd(),
  });
  assert.match(latest.stdout, /^Verifier Timeline Failures/m);
  assert.match(latest.stdout, /artifact:/);
  assert.match(latest.stdout, /github mutation:/);
  assert.match(latest.stdout, /node src\/cli\.mjs verifier promotion history release-main summary/);
});

test("cli verifier promotion approve honors global approval governance flags", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-cli-promotion-approve-"));

  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "baseline",
    "pin",
    "current",
    "release-main",
    "json",
    "--cwd",
    root,
    "--provider",
    "mock",
    "--policy",
    "release",
  ], {
    cwd: process.cwd(),
    env: process.env,
  });

  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "eval",
    "verification",
    "--cwd",
    root,
    "--provider",
    "mock",
    "--baseline",
    "baseline:release-main",
    "--baseline-target",
    "current",
    "--policy",
    "release",
    "--write-artifact",
  ], {
    cwd: process.cwd(),
    env: process.env,
  });

  const planResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "promotion",
    "plan",
    "release-main",
    "latest",
    "json",
    "--cwd",
    root,
    "--provider",
    "mock",
    "--policy",
    "release",
  ], {
    cwd: process.cwd(),
    env: process.env,
  });
  const plan = JSON.parse(planResult.stdout);

  const approvalResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "verifier",
    "promotion",
    "approve",
    plan.planId,
    "json",
    "--approver-id",
    "ci-bot",
    "--approver-name",
    "CI Bot",
    "--approval-source",
    "workflow_dispatch",
    "--approval-mode",
    "workflow_apply",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
    env: process.env,
  });
  const approvedPlan = JSON.parse(approvalResult.stdout);
  assert.equal(approvedPlan.approval.actor.id, "ci-bot");
  assert.equal(approvedPlan.approval.actor.displayName, "CI Bot");
  assert.equal(approvedPlan.approval.source, "workflow_dispatch");
  assert.equal(approvedPlan.approval.approvalMode, "workflow_apply");
});

test("cli verifier replay returns a stable replay-scoped report", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-verifier-cli-replay-"));
  await fs.writeFile(path.join(root, "broken.json"), JSON.stringify({ before: true }, null, 2), "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: root,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    let callCount = 0;
    agent.provider.complete = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "broken.json",
              content: "{\n",
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "verifier-cli-write-invalid",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "final",
          content: "Updated broken.json.",
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "verifier-cli-final",
        },
      };
    };

    await agent.runUserInput("Break broken.json and finalize.");

    const replayResult = await execFileAsync(process.execPath, [
      "src/cli.mjs",
      "verifier",
      "replay",
      agent.sessionId,
      "--cwd",
      root,
      "--provider",
      "mock",
    ], {
      cwd: process.cwd(),
    });
    const replayReport = JSON.parse(replayResult.stdout);
    assert.equal(replayReport.scope, "replay");
    assert.equal(replayReport.sessionId, agent.sessionId);
    assert.ok(replayReport.summary.failedVerifierRunCount >= 1);
    assert.equal(replayReport.summary.repairExhaustedCount, 1);
    assert.equal(replayReport.summary.finalOutcome, "failed");

    const replaySummary = await execFileAsync(process.execPath, [
      "src/cli.mjs",
      "verifier",
      "replay",
      agent.sessionId,
      "summary",
      "--cwd",
      root,
      "--provider",
      "mock",
    ], {
      cwd: process.cwd(),
    });
    assert.match(replaySummary.stdout, /^Verifier Summary/m);
    assert.match(replaySummary.stdout, /scope: replay/);
    assert.match(replaySummary.stdout, /final outcome: failed/);

    const replayExport = await execFileAsync(process.execPath, [
      "src/cli.mjs",
      "verifier",
      "export",
      "replay",
      agent.sessionId,
      "--cwd",
      root,
      "--provider",
      "mock",
    ], {
      cwd: process.cwd(),
    });
    const replayExportRecord = JSON.parse(replayExport.stdout);
    assert.equal(replayExportRecord.metadata.source.kind, "replay");
    assert.equal(replayExportRecord.metadata.source.replayReference, agent.sessionId);
    assert.equal(replayExportRecord.metadata.summary.finalOutcome, "failed");

    const replayCompare = await execFileAsync(process.execPath, [
      "src/cli.mjs",
      "verifier",
      "compare",
      `replay:${agent.sessionId}`,
      `snapshot:${replayExportRecord.metadata.snapshotId}`,
      "summary",
      "--cwd",
      root,
      "--provider",
      "mock",
    ], {
      cwd: process.cwd(),
    });
    assert.match(replayCompare.stdout, /^Verifier Compare/m);
    assert.match(replayCompare.stdout, /final outcome: failed/);
    assert.match(replayCompare.stdout, /no continuity deltas detected\./);

    const replayBaseline = await execFileAsync(process.execPath, [
      "src/cli.mjs",
      "verifier",
      "baseline",
      "pin",
      `snapshot:${replayExportRecord.metadata.snapshotId}`,
      "replay-failure",
      "--cwd",
      root,
      "--provider",
      "mock",
    ], {
      cwd: process.cwd(),
    });
    const replayBaselineRecord = JSON.parse(replayBaseline.stdout);
    assert.equal(replayBaselineRecord.metadata.name, "replay-failure");
    assert.equal(replayBaselineRecord.metadata.snapshotId, replayExportRecord.metadata.snapshotId);

    const replayGate = await execFileAsync(process.execPath, [
      "src/cli.mjs",
      "verifier",
      "gate",
      "baseline:replay-failure",
      `replay:${agent.sessionId}`,
      "summary",
      "--cwd",
      root,
      "--provider",
      "mock",
    ], {
      cwd: process.cwd(),
    });
    assert.match(replayGate.stdout, /^Verifier Gate/m);
    assert.match(replayGate.stdout, /status: pass/);
  } finally {
    await agent.close();
  }
});
