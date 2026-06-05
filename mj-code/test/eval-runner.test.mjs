import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry } from "../src/lib/capability-registry.mjs";
import { EvalRunner } from "../src/lib/eval-runner.mjs";
import {
  buildCurrentVerifierInspectReport,
  compareVerifierInspectReports,
  createVerifierInspectResolvedReference,
  evaluateVerifierRegressionGate,
} from "../src/lib/agent-verifier-inspect.mjs";

function buildRegistry() {
  const registry = new CapabilityRegistry();
  registry.upsertMany([
    {
      id: "tool:read_file",
      name: "read_file",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "read",
      sourceQualifiedName: "builtin:read_file",
    },
    {
      id: "tool:apply_patch",
      name: "apply_patch",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "write",
      sourceQualifiedName: "builtin:apply_patch",
    },
    {
      id: "tool:run_shell",
      name: "run_shell",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "exec",
      sourceQualifiedName: "builtin:run_shell",
    },
    {
      id: "tool:web_search",
      name: "web_search",
      type: "web-tool",
      source: "web",
      enabled: true,
      active: true,
      riskCategory: "network",
      sourceQualifiedName: "web:web_search",
    },
    {
      id: "tool:extract_content",
      name: "extract_content",
      type: "web-tool",
      source: "web",
      enabled: true,
      active: true,
      riskCategory: "network",
      sourceQualifiedName: "web:extract_content",
    },
    {
      id: "mcp-tool:demo:lookup",
      name: "mcp__demo__lookup",
      type: "mcp-tool",
      source: "mcp:demo",
      enabled: true,
      active: true,
      riskCategory: "external",
      sourceQualifiedName: "mcp:demo:lookup",
    },
    {
      id: "plugin-tool:demo:echo",
      name: "plugin__demo__echo",
      type: "plugin-tool",
      source: "plugin:demo",
      enabled: true,
      active: true,
      riskCategory: "external",
      sourceQualifiedName: "plugin:demo:echo",
    },
  ]);
  return registry;
}

test("eval runner returns structured cases, summary, and capability scorecards", () => {
  const runner = new EvalRunner({
    provider: "openai-compatible",
    model: "gpt-5.4",
    maxTokens: 1200,
  });

  const result = runner.runSuite("all", {
    capabilityRegistry: buildRegistry(),
    runtimeHealth: { scorecard: { degradedFlags: [], circuits: { byLayer: {} } } },
    activeSkills: [],
    policy: { sources: [] },
    availableModels: ["gpt-5.4", "gpt-5-mini"],
    runtimeContinuity: {
      shellJobs: [{ id: "job-1", continuityState: "reattached", canCancel: true }],
      lastSourcePack: { sourceIds: ["S1"] },
      intelligence: { taskClassification: { taskClass: "bug_fix" } },
    },
    shellSamples: [
      { id: "job-live", attachStrategy: { mode: "live_attach_supervised" }, live: true, historicalOnly: false },
      { id: "job-old", attachStrategy: { mode: "historical_only" }, live: false, historicalOnly: true },
    ],
  });

  assert.equal(result.suite, "all");
  assert.ok(result.cases.length > 0);
  assert.ok(typeof result.summary.averageScore === "number");
  assert.ok(Array.isArray(result.scorecard.capabilities));
  assert.ok(result.cases.every((entry) => typeof entry.durationMs === "number"));
  assert.ok(result.cases.some((entry) => entry.suite === "continuity"));
  assert.ok(result.cases.some((entry) => entry.suite === "shell"));
  assert.equal(result.artifact, null);
  assert.equal(result.handoff, null);
  assert.equal(result.bundle, null);
});

test("eval runner exposes verifier and repair convergence metrics through the verification suite", () => {
  const runner = new EvalRunner({
    provider: "mock",
    model: "mock-mj-code-v1",
    maxTokens: 1200,
  });

  const result = runner.runSuite("verification", {
    capabilityRegistry: buildRegistry(),
    runtimeHealth: { scorecard: { degradedFlags: [], circuits: { byLayer: {} } } },
    activeSkills: [],
    policy: { sources: [] },
    availableModels: ["mock-mj-code-v1"],
  });

  assert.equal(result.suite, "verification");
  assert.equal(result.summary.failed, 0);
  assert.ok(result.cases.length >= 20);
  assert.ok(result.cases.every((entry) => entry.suite === "verification"));

  const retryPass = result.cases.find((entry) => entry.name === "verifier-fail-repair-retry-pass");
  assert.ok(retryPass);
  assert.equal(retryPass.metrics.verifierStatus, "passed");
  assert.equal(retryPass.metrics.repairStatus, "succeeded");
  assert.equal(retryPass.metrics.finalOutcome, "success");
  assert.equal(retryPass.metrics.repairAttemptCount, 1);
  assert.equal(retryPass.metrics.repairProgress, "resolved");
  assert.equal(retryPass.metrics.repairResolvedCount, 1);
  assert.equal(retryPass.metrics.diagnosticEngine, "tsserver");
  assert.equal(retryPass.metrics.diagnosticFallbackUsed, false);
  assert.equal(retryPass.metrics.diagnosticTransportAvailable, true);
  assert.ok(retryPass.metrics.fixHintCount >= 0);

  const noActionable = result.cases.find((entry) => entry.name === "verifier-fail-no-actionable-stop");
  assert.ok(noActionable);
  assert.equal(noActionable.metrics.repairStatus, "stopped");
  assert.equal(noActionable.metrics.stopReason, "no_actionable_findings");
  assert.equal(noActionable.metrics.finalOutcome, "failed");
  assert.equal(noActionable.metrics.repairProgress, "none");

  const improved = result.cases.find((entry) => entry.name === "repair-improves-but-does-not-fully-resolve");
  assert.ok(improved);
  assert.equal(improved.metrics.repairStatus, "exhausted");
  assert.equal(improved.metrics.repairProgress, "improved");
  assert.equal(improved.metrics.resolvedDiagnosticCount, 1);
  assert.equal(improved.metrics.persistedDiagnosticCount, 1);

  const noProgress = result.cases.find((entry) => entry.name === "repair-makes-no-progress");
  assert.ok(noProgress);
  assert.equal(noProgress.metrics.repairProgress, "unchanged");
  assert.equal(noProgress.metrics.persistedDiagnosticCount, 1);

  const regressed = result.cases.find((entry) => entry.name === "repair-regresses-diagnostics");
  assert.ok(regressed);
  assert.equal(regressed.metrics.repairProgress, "regressed");
  assert.equal(regressed.metrics.introducedDiagnosticCount, 1);

  const fallback = result.cases.find((entry) => entry.name === "compiler-api-fallback-still-produces-convergence-metrics");
  assert.ok(fallback);
  assert.equal(fallback.metrics.diagnosticEngine, "compiler_api");
  assert.equal(fallback.metrics.diagnosticFallbackUsed, true);
  assert.equal(fallback.metrics.diagnosticTransportAvailable, false);
  assert.equal(fallback.metrics.repairProgress, "improved");

  const tsserverHints = result.cases.find((entry) => entry.name === "tsserver-diagnostics-expose-fix-hints");
  assert.ok(tsserverHints);
  assert.equal(tsserverHints.metrics.fixHintAvailable, true);
  assert.equal(tsserverHints.metrics.fixHintSource, "tsserver");
  assert.equal(tsserverHints.metrics.fixHintCount, 2);
  assert.equal(tsserverHints.metrics.recommendedFixHintCount, 1);
  assert.equal(tsserverHints.metrics.fixHintFileCount, 1);

  const fallbackHints = result.cases.find((entry) => entry.name === "compiler-api-fallback-fix-hints-stay-unavailable");
  assert.ok(fallbackHints);
  assert.equal(fallbackHints.metrics.diagnosticEngine, "compiler_api");
  assert.equal(fallbackHints.metrics.fixHintAvailable, false);
  assert.equal(fallbackHints.metrics.fixHintSource, "unavailable");
  assert.equal(fallbackHints.metrics.fixHintCount, 0);

  const appliedAction = result.cases.find((entry) => entry.name === "allowlisted-code-action-can-be-previewed-and-applied");
  assert.ok(appliedAction);
  assert.equal(appliedAction.metrics.finalOutcome, "success");
  assert.equal(appliedAction.metrics.codeActionCandidateCount, 1);
  assert.equal(appliedAction.metrics.codeActionAllowlistedCount, 1);
  assert.equal(appliedAction.metrics.codeActionAppliedCount, 1);
  assert.equal(appliedAction.metrics.latestCodeActionApplied, true);
  assert.equal(appliedAction.metrics.latestCodeActionStatus, "applied");

  const blockedAction = result.cases.find((entry) => entry.name === "non-allowlisted-code-action-is-blocked-with-stable-reason");
  assert.ok(blockedAction);
  assert.equal(blockedAction.metrics.finalOutcome, "failed");
  assert.equal(blockedAction.metrics.codeActionAllowlistedCount, 0);
  assert.equal(blockedAction.metrics.codeActionBlockedCount, 1);
  assert.equal(blockedAction.metrics.latestCodeActionStatus, "blocked");
  assert.equal(blockedAction.metrics.latestCodeActionBlockedReason, "not_allowlisted");

  const fallbackActions = result.cases.find((entry) => entry.name === "compiler-api-fallback-code-actions-stay-unavailable");
  assert.ok(fallbackActions);
  assert.equal(fallbackActions.metrics.diagnosticEngine, "compiler_api");
  assert.equal(fallbackActions.metrics.codeActionAvailable, false);
  assert.equal(fallbackActions.metrics.codeActionSource, "unavailable");
  assert.equal(fallbackActions.metrics.codeActionCandidateCount, 0);

  const tsserverProjectContext = result.cases.find((entry) => entry.name === "tsserver-richer-project-context-is-available-and-counted");
  assert.ok(tsserverProjectContext);
  assert.equal(tsserverProjectContext.metrics.projectContextAvailable, true);
  assert.equal(tsserverProjectContext.metrics.projectContextSource, "tsserver");
  assert.equal(tsserverProjectContext.metrics.projectContextCount, 1);
  assert.equal(tsserverProjectContext.metrics.projectContextDiagnosticCoverageCount, 1);
  assert.equal(tsserverProjectContext.metrics.projectContextQuickInfoCount, 1);
  assert.equal(tsserverProjectContext.metrics.projectContextDefinitionCount, 1);
  assert.equal(tsserverProjectContext.metrics.projectContextImplementationCount, 2);
  assert.equal(tsserverProjectContext.metrics.projectContextReferenceCount, 2);
  assert.equal(tsserverProjectContext.metrics.projectContextDocumentSymbolCount, 3);

  const fallbackProjectContext = result.cases.find((entry) => entry.name === "compiler-api-fallback-richer-project-context-stays-unavailable");
  assert.ok(fallbackProjectContext);
  assert.equal(fallbackProjectContext.metrics.diagnosticEngine, "compiler_api");
  assert.equal(fallbackProjectContext.metrics.projectContextAvailable, false);
  assert.equal(fallbackProjectContext.metrics.projectContextSource, "unavailable");
  assert.equal(fallbackProjectContext.metrics.projectContextCount, 0);
  assert.equal(fallbackProjectContext.metrics.projectContextImplementationCount, 0);
  assert.equal(fallbackProjectContext.metrics.projectContextDocumentSymbolCount, 0);

  const inspectProjectContext = result.cases.find((entry) => entry.name === "inspect-summary-matches-richer-project-context-counters");
  assert.ok(inspectProjectContext);
  assert.equal(inspectProjectContext.metrics.inspectSummaryMatches, true);
  assert.equal(inspectProjectContext.metrics.projectContextImplementationCount, 1);
  assert.equal(inspectProjectContext.metrics.projectContextDocumentSymbolCount, 3);

  const repassRequired = result.cases.find((entry) => entry.name === "code-action-apply-still-requires-verifier-re-pass");
  assert.ok(repassRequired);
  assert.equal(repassRequired.metrics.codeActionAppliedCount, 1);
  assert.equal(repassRequired.metrics.latestCodeActionStatus, "applied");
  assert.equal(repassRequired.metrics.verifierStatus, "failed");
  assert.equal(repassRequired.metrics.finalOutcome, "failed");

  const warningOnly = result.cases.find((entry) => entry.name === "diagnostics-warning-only-does-not-fail");
  assert.ok(warningOnly);
  assert.equal(warningOnly.metrics.verifierStatus, "passed");
  assert.equal(warningOnly.metrics.diagnosticWarningCount, 1);
  assert.equal(warningOnly.metrics.diagnosticEngine, "tsserver");

  const parseSuppression = result.cases.find((entry) => entry.name === "parse-failure-suppresses-duplicate-diagnostics");
  assert.ok(parseSuppression);
  assert.equal(parseSuppression.metrics.duplicateDiagnosticsSuppressed, true);
  assert.equal(parseSuppression.metrics.diagnosticErrorCount, 0);

  const inspectMatch = result.cases.find((entry) => entry.name === "inspect-report-matches-recorded-outcome");
  assert.ok(inspectMatch);
  assert.equal(inspectMatch.metrics.inspectSummaryMatches, true);
  assert.equal(inspectMatch.metrics.repairProgress, "resolved");
  assert.ok(typeof inspectMatch.metrics.fixHintCount === "number");

  assert.ok(result.scorecard.capabilities.some((entry) => entry.tag === "verification"));
  assert.ok(result.scorecard.capabilities.some((entry) => entry.tag === "repair"));
  assert.ok(result.scorecard.capabilities.some((entry) => entry.tag === "fix-hints"));
  assert.ok(result.scorecard.capabilities.some((entry) => entry.tag === "code-actions"));
  assert.ok(result.scorecard.capabilities.some((entry) => entry.tag === "project-context"));
  assert.equal(result.artifact, null);
  assert.equal(result.handoff, null);
  assert.equal(result.bundle, null);
});

test("eval runner carries typed verifier baseline gate results without mutating verification cases", () => {
  const runner = new EvalRunner({
    provider: "mock",
    model: "mock-mj-code-v1",
    maxTokens: 1200,
  });
  const emptyReport = buildCurrentVerifierInspectReport({
    sessionId: null,
    lastTrace: null,
    lastVerifierRun: null,
    lastRepairLoop: null,
  });
  const baselineGate = evaluateVerifierRegressionGate({
    compare: compareVerifierInspectReports({
      leftReference: createVerifierInspectResolvedReference({
        kind: "baseline",
        reference: "empty-baseline",
        scope: emptyReport.scope,
        sessionId: emptyReport.sessionId,
        traceId: emptyReport.traceId,
        snapshotId: "vis-empty",
        baselineName: "empty-baseline",
      }),
      leftReport: emptyReport,
      rightReference: createVerifierInspectResolvedReference({
        kind: "current",
        scope: emptyReport.scope,
        sessionId: emptyReport.sessionId,
        traceId: emptyReport.traceId,
      }),
      rightReport: emptyReport,
    }),
    profileId: "release",
  });

  const result = runner.runSuite("verification", {
    capabilityRegistry: buildRegistry(),
    runtimeHealth: { scorecard: { degradedFlags: [], circuits: { byLayer: {} } } },
    activeSkills: [],
    policy: { sources: [] },
    availableModels: ["mock-mj-code-v1"],
    baselineGate,
  });

  assert.ok(result.baselineGate);
  assert.equal(result.baselineGate.pass, true);
  assert.equal(result.baselineGate.profile.id, "release");
  assert.equal(result.baselineGate.compare.left.reference.label, "baseline:empty-baseline");
  assert.equal(result.baselineGate.compare.right.reference.label, "current");
  assert.equal(result.baselineGate.compare.summary.hasChanges, false);
  assert.equal(result.baselineGate.compare.summary.diagnosticErrors.delta, 0);
  assert.equal(result.baselineGate.compare.summary.blockingDiagnostics.introducedCount, 0);
  assert.equal(result.baselinePolicyProfile?.id, "release");
  assert.equal(result.handoff, null);
  assert.equal(result.bundle, null);
  assert.equal(result.artifact, null);
  assert.ok(result.cases.length >= 20);
});
