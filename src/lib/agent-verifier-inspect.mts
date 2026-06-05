import {
  collectDiagnosticFingerprintsFromVerifierRun,
} from "./agent-verifier.mjs";

import type {
  DiagnosticFingerprint,
  ExecutionJournalEntry,
  RepairLoopRecord,
  SessionReplay,
  TraceSummary,
  VerifierInspectBaselineMetadata,
  VerifierInspectCompareReport,
  VerifierInspectCompareSummary,
  VerifierInspectCountDelta,
  VerifierInspectFinalOutcome,
  VerifierInspectArtifactEvidence,
  VerifierInspectLatest,
  VerifierInspectReferenceKind,
  VerifierInspectReport,
  VerifierInspectResolvedReference,
  VerifierInspectSnapshotMetadata,
  VerifierInspectScope,
  VerifierInspectSummary,
  VerifierInspectValueChange,
  VerifierRegressionGateDecision,
  VerifierRegressionGatePolicy,
  VerifierRegressionGatePolicyProfile,
  VerifierRegressionGatePolicyProfileId,
  VerifierRegressionGatePolicyProfileList,
  VerifierRegressionGateReason,
  VerifierRegressionGateReasonKind,
  VerifierRunRecord,
} from "../types/contracts.js";

interface CurrentVerifierInspectInput {
  sessionId: string | null;
  lastTrace: TraceSummary | null;
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
}

interface TraceVerifierInspectInput extends CurrentVerifierInspectInput {
  entries: ExecutionJournalEntry[];
}

const BUILTIN_VERIFIER_REGRESSION_GATE_POLICY_PROFILES: readonly VerifierRegressionGatePolicyProfile[] = [
  {
    id: "default",
    name: "default",
    description: "Preserves the landed regression gate: fail on outcome, error, blocking-diagnostic, and repair-regression regressions; notice on warning/info and assist-availability drift.",
    builtin: true,
    policy: {
      name: "default_verifier_regression_gate_v1",
      failOnFinalOutcomeRegression: true,
      failOnLatestVerifierFailed: true,
      failOnLatestVerifierStatusRegression: false,
      failOnLatestRepairStatusRegression: false,
      failOnDiagnosticErrorIncrease: true,
      failOnBlockingDiagnosticsIntroduced: true,
      failOnRepairRegressedCountIncrease: true,
      failOnLatestRepairProgressRegression: true,
      noticeOnWarningDelta: true,
      noticeOnInfoDelta: true,
      noticeOnFixHintAvailabilityChange: true,
      noticeOnCodeActionAvailabilityChange: true,
      noticeOnProjectContextAvailabilityChange: true,
    },
  },
  {
    id: "strict",
    name: "strict",
    description: "Default profile plus fail when the latest verifier status worsens even if it does not newly enter failed.",
    builtin: true,
    policy: {
      name: "strict_verifier_regression_gate_v1",
      failOnFinalOutcomeRegression: true,
      failOnLatestVerifierFailed: true,
      failOnLatestVerifierStatusRegression: true,
      failOnLatestRepairStatusRegression: false,
      failOnDiagnosticErrorIncrease: true,
      failOnBlockingDiagnosticsIntroduced: true,
      failOnRepairRegressedCountIncrease: true,
      failOnLatestRepairProgressRegression: true,
      noticeOnWarningDelta: true,
      noticeOnInfoDelta: true,
      noticeOnFixHintAvailabilityChange: true,
      noticeOnCodeActionAvailabilityChange: true,
      noticeOnProjectContextAvailabilityChange: true,
    },
  },
  {
    id: "release",
    name: "release",
    description: "Strict profile plus fail when the latest repair status worsens across the baseline comparison.",
    builtin: true,
    policy: {
      name: "release_verifier_regression_gate_v1",
      failOnFinalOutcomeRegression: true,
      failOnLatestVerifierFailed: true,
      failOnLatestVerifierStatusRegression: true,
      failOnLatestRepairStatusRegression: true,
      failOnDiagnosticErrorIncrease: true,
      failOnBlockingDiagnosticsIntroduced: true,
      failOnRepairRegressedCountIncrease: true,
      failOnLatestRepairProgressRegression: true,
      noticeOnWarningDelta: true,
      noticeOnInfoDelta: true,
      noticeOnFixHintAvailabilityChange: true,
      noticeOnCodeActionAvailabilityChange: true,
      noticeOnProjectContextAvailabilityChange: true,
    },
  },
];

export function buildCurrentVerifierInspectReport(
  input: CurrentVerifierInspectInput,
): VerifierInspectReport {
  const verifierRuns = input.lastVerifierRun ? [cloneVerifierRun(input.lastVerifierRun)] : [];
  const repairLoops = input.lastRepairLoop ? [cloneRepairLoop(input.lastRepairLoop)] : [];
  const latest = createLatestRecord(verifierRuns, repairLoops);
  return createVerifierInspectReport({
    scope: "current",
    sessionId: input.sessionId,
    traceId: resolveTraceId(input.lastTrace, latest),
    latest,
    verifierRuns,
    repairLoops,
    finalOutcome: resolveTraceOutcome(input.lastTrace),
  });
}

export function buildTraceVerifierInspectReport(
  input: TraceVerifierInspectInput,
): VerifierInspectReport {
  const latestFromState = createLatestRecord(
    input.lastVerifierRun ? [cloneVerifierRun(input.lastVerifierRun)] : [],
    input.lastRepairLoop ? [cloneRepairLoop(input.lastRepairLoop)] : [],
  );
  const traceId = resolveTraceId(input.lastTrace, latestFromState);
  if (!traceId) {
    return createVerifierInspectReport({
      scope: "trace",
      sessionId: input.sessionId,
      traceId: null,
      latest: {
        verifierRun: null,
        repairLoop: null,
      },
      verifierRuns: [],
      repairLoops: [],
      finalOutcome: resolveTraceOutcome(input.lastTrace),
    });
  }

  const verifierRuns = input.entries
    .map(extractVerifierRunFromJournalEntry)
    .filter((entry): entry is VerifierRunRecord => entry != null && entry.traceId === traceId);
  const repairLoops = collapseRepairLoops(
    input.entries
      .map(extractRepairLoopFromJournalEntry)
      .filter((entry): entry is RepairLoopRecord => entry != null && entry.traceId === traceId),
  );
  const latest = createLatestRecord(
    verifierRuns.length > 0 ? verifierRuns : latestFromState.verifierRun?.traceId === traceId
      ? [latestFromState.verifierRun]
      : [],
    repairLoops.length > 0 ? repairLoops : latestFromState.repairLoop?.traceId === traceId
      ? [latestFromState.repairLoop]
      : [],
  );

  return createVerifierInspectReport({
    scope: "trace",
    sessionId: input.sessionId,
    traceId,
    latest,
    verifierRuns,
    repairLoops,
    finalOutcome: resolveTraceOutcome(input.lastTrace),
  });
}

export function buildReplayVerifierInspectReport(
  replay: SessionReplay,
): VerifierInspectReport {
  const verifierRuns = replay.verifierRuns.map((entry) => cloneVerifierRun(entry.run));
  const repairLoops = collapseRepairLoops(
    replay.repairLoops.map((entry) => cloneRepairLoop(entry.loop)),
  );
  const latest = createLatestRecord(verifierRuns, repairLoops);

  return createVerifierInspectReport({
    scope: "replay",
    sessionId: replay.session.id,
    traceId: latest.verifierRun?.traceId ?? latest.repairLoop?.traceId ?? null,
    latest,
    verifierRuns,
    repairLoops,
    finalOutcome: resolveReplayOutcome(replay, latest),
  });
}

export function createVerifierInspectResolvedReference(input: {
  kind: VerifierInspectReferenceKind;
  reference?: string | null;
  scope: VerifierInspectScope;
  sessionId: string | null;
  traceId: string | null;
  replayReference?: string | null;
  snapshotId?: string | null;
  baselineName?: string | null;
}): VerifierInspectResolvedReference {
  const reference = input.reference ?? null;
  const replayReference = input.replayReference ?? null;
  const snapshotId = input.snapshotId ?? null;
  const baselineName = input.baselineName ?? null;
  return {
    kind: input.kind,
    label: formatVerifierInspectReferenceLabel({
      kind: input.kind,
      scope: input.scope,
      reference,
      sessionId: input.sessionId,
      traceId: input.traceId,
      replayReference,
      snapshotId,
      baselineName,
    }),
    reference,
    scope: input.scope,
    sessionId: input.sessionId,
    traceId: input.traceId,
    replayReference,
    snapshotId,
    baselineName,
  };
}

export function createVerifierInspectSnapshotMetadata(input: {
  snapshotId: string;
  createdAt: string;
  source: VerifierInspectResolvedReference;
  report: VerifierInspectReport;
}): VerifierInspectSnapshotMetadata {
  return {
    snapshotId: input.snapshotId,
    createdAt: input.createdAt,
    source: cloneResolvedReference(input.source),
    summary: cloneVerifierInspectSummary(input.report.summary),
  };
}

export function createVerifierInspectBaselineMetadata(input: {
  baselineId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  snapshotId: string;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  source: VerifierInspectResolvedReference;
  report: VerifierInspectReport;
}): VerifierInspectBaselineMetadata {
  return {
    baselineId: input.baselineId,
    name: input.name,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    snapshotId: input.snapshotId,
    policyProfileId: input.policyProfileId,
    source: cloneResolvedReference(input.source),
    summary: cloneVerifierInspectSummary(input.report.summary),
    promotionCount: 0,
    latestPromotionId: null,
  };
}

export function compareVerifierInspectReports(input: {
  leftReference: VerifierInspectResolvedReference;
  leftReport: VerifierInspectReport;
  rightReference: VerifierInspectResolvedReference;
  rightReport: VerifierInspectReport;
}): VerifierInspectCompareReport {
  const leftReport = cloneVerifierInspectReport(input.leftReport);
  const rightReport = cloneVerifierInspectReport(input.rightReport);
  return {
    left: {
      reference: cloneResolvedReference(input.leftReference),
      report: leftReport,
    },
    right: {
      reference: cloneResolvedReference(input.rightReference),
      report: rightReport,
    },
    summary: summarizeVerifierInspectComparison(leftReport, rightReport),
    artifact: null,
    handoff: null,
    bundle: null,
  };
}

export function listVerifierRegressionGatePolicyProfiles(): VerifierRegressionGatePolicyProfileList {
  const items = BUILTIN_VERIFIER_REGRESSION_GATE_POLICY_PROFILES.map((entry) => clonePolicyProfile(entry));
  return {
    total: items.length,
    items,
  };
}

export function resolveVerifierRegressionGatePolicyProfile(input: {
  profileId?: string | null;
  policy?: VerifierRegressionGatePolicy | null;
} = {}): VerifierRegressionGatePolicyProfile {
  if (input.policy) {
    const profileId = `${input.profileId ?? input.policy.name ?? "custom"}`.trim() || "custom";
    return {
      id: profileId,
      name: profileId,
      description: "Custom verifier regression gate policy.",
      builtin: false,
      policy: structuredClone(input.policy),
    };
  }
  const normalized = `${input.profileId ?? "default"}`.trim().toLowerCase() || "default";
  const match = BUILTIN_VERIFIER_REGRESSION_GATE_POLICY_PROFILES.find((entry) => entry.id === normalized);
  if (!match) {
    throw new Error(`Unknown verifier gate policy profile "${normalized}".`);
  }
  return clonePolicyProfile(match);
}

export function createDefaultVerifierRegressionGatePolicy(): VerifierRegressionGatePolicy {
  return resolveVerifierRegressionGatePolicyProfile({ profileId: "default" }).policy;
}

export function evaluateVerifierRegressionGate(input: {
  compare: VerifierInspectCompareReport;
  policy?: VerifierRegressionGatePolicy;
  profileId?: string | null;
}): VerifierRegressionGateDecision {
  const profile = resolveVerifierRegressionGatePolicyProfile({
    profileId: input.profileId,
    policy: input.policy ?? null,
  });
  const policy = structuredClone(profile.policy);
  const compare = cloneVerifierInspectCompareReport(input.compare);
  const reasons: VerifierRegressionGateReason[] = [];
  const summary = compare.summary;

  if (policy.failOnFinalOutcomeRegression && isVerifierInspectOutcomeRegression(summary.finalOutcome.before, summary.finalOutcome.after)) {
    reasons.push(createGateReason({
      kind: "final_outcome_regressed",
      severity: "failure",
      summary: `Final outcome regressed from ${summary.finalOutcome.before} to ${summary.finalOutcome.after}.`,
      finalOutcome: summary.finalOutcome,
    }));
  }
  if (policy.failOnLatestVerifierFailed && summary.latestVerifierStatus.after === "failed" && summary.latestVerifierStatus.before !== "failed") {
    reasons.push(createGateReason({
      kind: "latest_verifier_failed",
      severity: "failure",
      summary: `Latest verifier regressed into failed from ${summary.latestVerifierStatus.before}.`,
      latestVerifierStatus: summary.latestVerifierStatus,
    }));
  }
  if (
    policy.failOnLatestVerifierStatusRegression &&
    summary.latestVerifierStatus.after !== "failed" &&
    isVerifierStatusRegression(summary.latestVerifierStatus.before, summary.latestVerifierStatus.after)
  ) {
    reasons.push(createGateReason({
      kind: "latest_verifier_status_regressed",
      severity: "failure",
      summary: `Latest verifier status regressed from ${summary.latestVerifierStatus.before} to ${summary.latestVerifierStatus.after}.`,
      latestVerifierStatus: summary.latestVerifierStatus,
    }));
  }
  if (
    policy.failOnLatestRepairStatusRegression &&
    isRepairStatusRegression(summary.latestRepairStatus.before, summary.latestRepairStatus.after)
  ) {
    reasons.push(createGateReason({
      kind: "latest_repair_status_regressed",
      severity: "failure",
      summary: `Latest repair status regressed from ${summary.latestRepairStatus.before} to ${summary.latestRepairStatus.after}.`,
      latestRepairStatus: summary.latestRepairStatus,
    }));
  }
  if (policy.failOnDiagnosticErrorIncrease && summary.diagnosticErrors.delta > 0) {
    reasons.push(createGateReason({
      kind: "diagnostic_errors_increased",
      severity: "failure",
      summary: `Diagnostic error count increased by ${summary.diagnosticErrors.delta} (${summary.diagnosticErrors.before} -> ${summary.diagnosticErrors.after}).`,
      countDelta: summary.diagnosticErrors,
    }));
  }
  if (policy.failOnBlockingDiagnosticsIntroduced && summary.blockingDiagnostics.introducedCount > 0) {
    reasons.push(createGateReason({
      kind: "blocking_diagnostics_introduced",
      severity: "failure",
      summary: `Blocking diagnostics introduced: ${summary.blockingDiagnostics.introducedCount}.`,
      blockingDiagnostics: summary.blockingDiagnostics,
    }));
  }
  if (policy.failOnRepairRegressedCountIncrease && summary.repairRegressed.delta > 0) {
    reasons.push(createGateReason({
      kind: "repair_regressed_count_increased",
      severity: "failure",
      summary: `Repair regressed count increased by ${summary.repairRegressed.delta} (${summary.repairRegressed.before} -> ${summary.repairRegressed.after}).`,
      countDelta: summary.repairRegressed,
    }));
  }
  if (
    policy.failOnLatestRepairProgressRegression &&
    summary.latestRepairProgress.after === "regressed" &&
    summary.latestRepairProgress.before !== "regressed"
  ) {
    reasons.push(createGateReason({
      kind: "latest_repair_progress_regressed",
      severity: "failure",
      summary: `Latest repair progress regressed from ${summary.latestRepairProgress.before} to regressed.`,
      latestRepairProgress: summary.latestRepairProgress,
    }));
  }
  if (policy.noticeOnWarningDelta && summary.diagnosticWarnings.delta !== 0 && summary.diagnosticErrors.delta === 0) {
    reasons.push(createGateReason({
      kind: "warning_delta_only",
      severity: "notice",
      summary: `Warning count changed by ${summary.diagnosticWarnings.delta} (${summary.diagnosticWarnings.before} -> ${summary.diagnosticWarnings.after}).`,
      countDelta: summary.diagnosticWarnings,
    }));
  }
  if (policy.noticeOnInfoDelta && summary.diagnosticInfo.delta !== 0 && summary.diagnosticErrors.delta === 0) {
    reasons.push(createGateReason({
      kind: "info_delta_only",
      severity: "notice",
      summary: `Info count changed by ${summary.diagnosticInfo.delta} (${summary.diagnosticInfo.before} -> ${summary.diagnosticInfo.after}).`,
      countDelta: summary.diagnosticInfo,
    }));
  }
  if (policy.noticeOnFixHintAvailabilityChange && summary.latestFixHintAvailable.changed) {
    reasons.push(createGateReason({
      kind: "fix_hint_availability_changed",
      severity: "notice",
      summary: `Fix-hint availability changed from ${summary.latestFixHintAvailable.before ? "available" : "unavailable"} to ${summary.latestFixHintAvailable.after ? "available" : "unavailable"}.`,
      availabilityChange: summary.latestFixHintAvailable,
    }));
  }
  if (policy.noticeOnCodeActionAvailabilityChange && summary.latestCodeActionAvailable.changed) {
    reasons.push(createGateReason({
      kind: "code_action_availability_changed",
      severity: "notice",
      summary: `Code-action availability changed from ${summary.latestCodeActionAvailable.before ? "available" : "unavailable"} to ${summary.latestCodeActionAvailable.after ? "available" : "unavailable"}.`,
      availabilityChange: summary.latestCodeActionAvailable,
    }));
  }
  if (policy.noticeOnProjectContextAvailabilityChange && summary.latestProjectContextAvailable.changed) {
    reasons.push(createGateReason({
      kind: "project_context_availability_changed",
      severity: "notice",
      summary: `Project-context availability changed from ${summary.latestProjectContextAvailable.before ? "available" : "unavailable"} to ${summary.latestProjectContextAvailable.after ? "available" : "unavailable"}.`,
      availabilityChange: summary.latestProjectContextAvailable,
    }));
  }

  const failureCount = reasons.filter((entry) => entry.severity === "failure").length;
  const noticeCount = reasons.filter((entry) => entry.severity === "notice").length;
  const pass = failureCount === 0;
  return {
    profile,
    policy,
    compare,
    status: pass ? "pass" : "fail",
    pass,
    failureCount,
    noticeCount,
    reasons,
    summary: summarizeVerifierRegressionGateDecision({
      pass,
      failureCount,
      noticeCount,
    }),
    artifact: null,
    handoff: null,
    bundle: null,
  };
}

export function createVerifierInspectArtifactEvidenceFromCompareSummary(
  summary: VerifierInspectCompareSummary,
): VerifierInspectArtifactEvidence {
  return {
    finalOutcome: structuredClone(summary.finalOutcome),
    latestVerifierStatus: structuredClone(summary.latestVerifierStatus),
    latestRepairStatus: structuredClone(summary.latestRepairStatus),
    latestRepairProgress: structuredClone(summary.latestRepairProgress),
    diagnosticErrors: structuredClone(summary.diagnosticErrors),
    diagnosticWarnings: structuredClone(summary.diagnosticWarnings),
    diagnosticInfo: structuredClone(summary.diagnosticInfo),
    repairRegressed: structuredClone(summary.repairRegressed),
    blockingDiagnostics: {
      beforeCount: summary.blockingDiagnostics.beforeCount,
      afterCount: summary.blockingDiagnostics.afterCount,
      resolvedCount: summary.blockingDiagnostics.resolvedCount,
      persistedCount: summary.blockingDiagnostics.persistedCount,
      introducedCount: summary.blockingDiagnostics.introducedCount,
      summary: summary.blockingDiagnostics.summary,
    },
  };
}

export function collectBlockingDiagnosticFingerprintsFromVerifierInspectReport(
  report: VerifierInspectReport,
): DiagnosticFingerprint[] {
  const latestVerifierRun = report.latest.verifierRun;
  if (!latestVerifierRun || latestVerifierRun.summary.status !== "failed") {
    return [];
  }
  return collectDiagnosticFingerprintsFromVerifierRun(latestVerifierRun);
}

function createVerifierInspectReport(input: {
  scope: VerifierInspectScope;
  sessionId: string | null;
  traceId: string | null;
  latest: VerifierInspectLatest;
  verifierRuns: VerifierRunRecord[];
  repairLoops: RepairLoopRecord[];
  finalOutcome: VerifierInspectFinalOutcome;
}): VerifierInspectReport {
  return {
    scope: input.scope,
    sessionId: input.sessionId,
    traceId: input.traceId,
    latest: {
      verifierRun: input.latest.verifierRun ? cloneVerifierRun(input.latest.verifierRun) : null,
      repairLoop: input.latest.repairLoop ? cloneRepairLoop(input.latest.repairLoop) : null,
    },
    verifierRuns: input.verifierRuns.map((entry) => cloneVerifierRun(entry)),
    repairLoops: input.repairLoops.map((entry) => cloneRepairLoop(entry)),
    summary: summarizeVerifierInspectReport({
      latest: input.latest,
      verifierRuns: input.verifierRuns,
      repairLoops: input.repairLoops,
      finalOutcome: input.finalOutcome,
    }),
  };
}

function summarizeVerifierInspectReport(input: {
  latest: VerifierInspectLatest;
  verifierRuns: VerifierRunRecord[];
  repairLoops: RepairLoopRecord[];
  finalOutcome: VerifierInspectFinalOutcome;
}): VerifierInspectSummary {
  const verifierRunCount = input.verifierRuns.length;
  const passedVerifierRunCount = input.verifierRuns.filter((entry) => entry.summary.status === "passed").length;
  const failedVerifierRunCount = input.verifierRuns.filter((entry) => entry.summary.status === "failed").length;
  const skippedVerifierRunCount = input.verifierRuns.filter((entry) => entry.summary.status === "skipped").length;
  const diagnosticErrorCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.diagnosticErrorCount ?? 0),
    0,
  );
  const diagnosticWarningCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.diagnosticWarningCount ?? 0),
    0,
  );
  const diagnosticInfoCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.diagnosticInfoCount ?? 0),
    0,
  );
  const repairLoopCount = input.repairLoops.length;
  const repairAttemptCount = input.repairLoops.reduce(
    (total, entry) => total + entry.attempts.length,
    0,
  );
  const repairAttempts = input.repairLoops.flatMap((entry) => entry.attempts);
  const repairConvergences = repairAttempts
    .map((entry) => entry.convergence)
    .filter((entry): entry is NonNullable<(typeof repairAttempts)[number]["convergence"]> => entry != null);
  const tsserverDiagnosticRunCount = input.verifierRuns.filter(
    (entry) => entry.summary.diagnosticEngine === "tsserver",
  ).length;
  const compilerApiDiagnosticRunCount = input.verifierRuns.filter(
    (entry) => entry.summary.diagnosticEngine === "compiler_api",
  ).length;
  const diagnosticsFallbackCount = input.verifierRuns.filter(
    (entry) => entry.summary.diagnosticFallbackUsed === true,
  ).length;
  const fixHintCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.fixHintCount ?? 0),
    0,
  );
  const recommendedFixHintCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.recommendedFixHintCount ?? 0),
    0,
  );
  const fixHintFileCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.fixHintFileCount ?? 0),
    0,
  );
  const codeActionCandidateCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.codeActionCandidateCount ?? 0),
    0,
  );
  const codeActionAllowlistedCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.codeActionAllowlistedCount ?? 0),
    0,
  );
  const projectContextCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.projectContextCount ?? 0),
    0,
  );
  const projectContextDiagnosticCoverageCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.projectContextDiagnosticCoverageCount ?? 0),
    0,
  );
  const projectContextQuickInfoCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.projectContextQuickInfoCount ?? 0),
    0,
  );
  const projectContextDefinitionCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.projectContextDefinitionCount ?? 0),
    0,
  );
  const projectContextImplementationCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.projectContextImplementationCount ?? 0),
    0,
  );
  const projectContextReferenceCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.projectContextReferenceCount ?? 0),
    0,
  );
  const projectContextDocumentSymbolCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.projectContextDocumentSymbolCount ?? 0),
    0,
  );
  const projectContextFileCount = input.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.projectContextFileCount ?? 0),
    0,
  );
  const codeActionAppliedCount = repairAttempts.filter((entry) => entry.codeAction?.status === "applied").length;
  const codeActionBlockedCount = repairAttempts.filter((entry) => entry.codeAction?.status === "blocked").length;
  const progressStates = [...new Set(repairConvergences.map((entry) => entry.state))];
  const latestCodeAction = input.latest.repairLoop?.attempts.at(-1)?.codeAction ?? null;

  return {
    hasData: verifierRunCount > 0 || repairLoopCount > 0,
    verifierRunCount,
    passedVerifierRunCount,
    failedVerifierRunCount,
    skippedVerifierRunCount,
    diagnosticErrorCount,
    diagnosticWarningCount,
    diagnosticInfoCount,
    repairLoopCount,
    repairAttemptCount,
    repairSucceededCount: input.repairLoops.filter((entry) => entry.summary.status === "succeeded").length,
    repairStoppedCount: input.repairLoops.filter((entry) => entry.summary.status === "stopped").length,
    repairExhaustedCount: input.repairLoops.filter((entry) => entry.summary.status === "exhausted").length,
    repairFailedCount: input.repairLoops.filter((entry) => entry.summary.status === "failed").length,
    repairResolvedCount: repairConvergences.filter((entry) => entry.state === "resolved").length,
    repairImprovedCount: repairConvergences.filter((entry) => entry.state === "improved").length,
    repairUnchangedCount: repairConvergences.filter((entry) => entry.state === "unchanged").length,
    repairRegressedCount: repairConvergences.filter((entry) => entry.state === "regressed").length,
    repairNotApplicableCount: repairConvergences.filter((entry) => entry.state === "not_applicable").length,
    latestRepairProgress: input.latest.repairLoop?.summary.latestProgress ?? "none",
    repairProgressTrend: progressStates.length === 0
      ? "none"
      : progressStates.length === 1
        ? progressStates[0]
        : "mixed",
    resolvedDiagnosticCount: repairConvergences.reduce(
      (total, entry) => total + Number(entry.delta?.resolvedCount ?? 0),
      0,
    ),
    persistedDiagnosticCount: repairConvergences.reduce(
      (total, entry) => total + Number(entry.delta?.persistedCount ?? 0),
      0,
    ),
    introducedDiagnosticCount: repairConvergences.reduce(
      (total, entry) => total + Number(entry.delta?.introducedCount ?? 0),
      0,
    ),
    tsserverDiagnosticRunCount,
    compilerApiDiagnosticRunCount,
    diagnosticsFallbackCount,
    fixHintCount,
    recommendedFixHintCount,
    fixHintFileCount,
    codeActionCandidateCount,
    codeActionAllowlistedCount,
    codeActionAppliedCount,
    codeActionBlockedCount,
    projectContextCount,
    projectContextDiagnosticCoverageCount,
    projectContextQuickInfoCount,
    projectContextDefinitionCount,
    projectContextImplementationCount,
    projectContextReferenceCount,
    projectContextDocumentSymbolCount,
    projectContextFileCount,
    latestVerifierStatus: input.latest.verifierRun?.summary.status ?? "none",
    latestRepairStatus: input.latest.repairLoop?.summary.status ?? "none",
    latestDiagnosticEngine: input.latest.verifierRun?.summary.diagnosticEngine ?? "none",
    latestDiagnosticFallbackUsed: input.latest.verifierRun?.summary.diagnosticFallbackUsed === true,
    latestDiagnosticFallbackReason: input.latest.verifierRun?.summary.diagnosticFallbackReason ?? null,
    latestDiagnosticTransportAvailable:
      typeof input.latest.verifierRun?.summary.diagnosticTransportAvailable === "boolean"
        ? input.latest.verifierRun.summary.diagnosticTransportAvailable
        : null,
    latestFixHintAvailable: input.latest.verifierRun?.summary.fixHintAvailable === true,
    latestFixHintSource: input.latest.verifierRun?.summary.fixHintSource ?? "none",
    latestFixHintReason: input.latest.verifierRun?.summary.fixHintReason ?? null,
    latestFixHintCount: Number(input.latest.verifierRun?.summary.fixHintCount ?? 0),
    latestRecommendedFixHintCount: Number(input.latest.verifierRun?.summary.recommendedFixHintCount ?? 0),
    latestFixHintFileCount: Number(input.latest.verifierRun?.summary.fixHintFileCount ?? 0),
    latestCodeActionAvailable: latestCodeAction != null
      ? latestCodeAction.source !== "unavailable"
      : input.latest.verifierRun?.summary.codeActionAvailable === true,
    latestCodeActionSource: latestCodeAction?.source ?? input.latest.verifierRun?.summary.codeActionSource ?? "none",
    latestCodeActionApplied: latestCodeAction?.applied === true,
    latestCodeActionStatus: latestCodeAction?.status ?? "none",
    latestCodeActionBlockedReason: latestCodeAction?.blockedReason ?? null,
    latestProjectContextAvailable: input.latest.verifierRun?.summary.projectContextAvailable === true,
    latestProjectContextSource: input.latest.verifierRun?.summary.projectContextSource ?? "none",
    latestProjectContextReason: input.latest.verifierRun?.summary.projectContextReason ?? null,
    latestProjectContextCount: Number(input.latest.verifierRun?.summary.projectContextCount ?? 0),
    latestProjectContextDiagnosticCoverageCount:
      Number(input.latest.verifierRun?.summary.projectContextDiagnosticCoverageCount ?? 0),
    latestProjectContextQuickInfoCount: Number(input.latest.verifierRun?.summary.projectContextQuickInfoCount ?? 0),
    latestProjectContextDefinitionCount: Number(input.latest.verifierRun?.summary.projectContextDefinitionCount ?? 0),
    latestProjectContextImplementationCount:
      Number(input.latest.verifierRun?.summary.projectContextImplementationCount ?? 0),
    latestProjectContextReferenceCount: Number(input.latest.verifierRun?.summary.projectContextReferenceCount ?? 0),
    latestProjectContextDocumentSymbolCount:
      Number(input.latest.verifierRun?.summary.projectContextDocumentSymbolCount ?? 0),
    latestProjectContextFileCount: Number(input.latest.verifierRun?.summary.projectContextFileCount ?? 0),
    finalOutcome: input.finalOutcome,
  };
}

function resolveTraceId(
  lastTrace: TraceSummary | null,
  latest: VerifierInspectLatest,
): string | null {
  return lastTrace?.traceId
    ?? latest.verifierRun?.traceId
    ?? latest.repairLoop?.traceId
    ?? null;
}

function resolveTraceOutcome(
  trace: TraceSummary | null,
): VerifierInspectFinalOutcome {
  if (!trace) {
    return "unknown";
  }
  if (trace.success) {
    return "success";
  }
  if (trace.stopped) {
    return trace.errorTaxonomy ? "failed" : "stopped";
  }
  return "degraded";
}

function resolveReplayOutcome(
  replay: SessionReplay,
  latest: VerifierInspectLatest,
): VerifierInspectFinalOutcome {
  const final = replay.finals.at(-1);
  if (final && typeof final === "object" && final.success === true) {
    return "success";
  }
  if (final && typeof final === "object" && final.stopped === true) {
    if (typeof final.errorTaxonomy === "string" && final.errorTaxonomy.length > 0) {
      return "failed";
    }
    if (
      latest.verifierRun?.summary.status === "failed" ||
      latest.repairLoop?.summary.status === "failed" ||
      latest.repairLoop?.summary.status === "exhausted"
    ) {
      return "failed";
    }
    if (latest.repairLoop?.summary.status === "stopped") {
      return "stopped";
    }
    return "stopped";
  }
  if (latest.verifierRun?.summary.status === "failed") {
    return "failed";
  }
  if (
    latest.repairLoop?.summary.status === "failed" ||
    latest.repairLoop?.summary.status === "exhausted"
  ) {
    return "failed";
  }
  if (latest.repairLoop?.summary.status === "stopped") {
    return "stopped";
  }
  if (latest.verifierRun?.summary.status === "passed") {
    return "success";
  }
  if (latest.verifierRun?.summary.status === "skipped") {
    return "stopped";
  }
  if (!final || typeof final !== "object") {
    return "unknown";
  }
  if (final.stopped === true) {
    return typeof final.errorTaxonomy === "string" && final.errorTaxonomy.length > 0
      ? "failed"
      : "stopped";
  }
  return "unknown";
}

function extractVerifierRunFromJournalEntry(
  entry: ExecutionJournalEntry,
): VerifierRunRecord | null {
  if (entry.type !== "verifier_run") {
    return null;
  }
  return isVerifierRunRecord(entry.payload)
    ? cloneVerifierRun(entry.payload)
    : null;
}

function extractRepairLoopFromJournalEntry(
  entry: ExecutionJournalEntry,
): RepairLoopRecord | null {
  if (
    entry.type !== "repair_loop" ||
    !isObject(entry.payload) ||
    !isRepairLoopRecord(entry.payload.loop)
  ) {
    return null;
  }
  return cloneRepairLoop(entry.payload.loop);
}

function collapseRepairLoops(records: RepairLoopRecord[]): RepairLoopRecord[] {
  const order: string[] = [];
  const collapsed = new Map<string, RepairLoopRecord>();

  for (const record of records) {
    const key = getRepairLoopKey(record);
    if (!collapsed.has(key)) {
      order.push(key);
    }
    collapsed.set(key, cloneRepairLoop(record));
  }

  return order
    .map((key) => collapsed.get(key))
    .filter((entry): entry is RepairLoopRecord => entry != null);
}

function getRepairLoopKey(record: RepairLoopRecord): string {
  return JSON.stringify([
    record.traceId,
    record.startedAt,
    record.initialVerifierStartedAt,
    record.initialVerifierStep,
    record.maxAttempts,
  ]);
}

function createLatestRecord(
  verifierRuns: VerifierRunRecord[],
  repairLoops: RepairLoopRecord[],
): VerifierInspectLatest {
  return {
    verifierRun: verifierRuns.at(-1) ?? null,
    repairLoop: repairLoops.at(-1) ?? null,
  };
}

function cloneVerifierRun(run: VerifierRunRecord): VerifierRunRecord {
  return structuredClone(run);
}

function cloneRepairLoop(loop: RepairLoopRecord): RepairLoopRecord {
  return structuredClone(loop);
}

function cloneVerifierInspectReport(report: VerifierInspectReport): VerifierInspectReport {
  return structuredClone(report);
}

function cloneVerifierInspectCompareReport(
  report: VerifierInspectCompareReport,
): VerifierInspectCompareReport {
  return structuredClone(report);
}

function cloneResolvedReference(
  reference: VerifierInspectResolvedReference,
): VerifierInspectResolvedReference {
  return structuredClone(reference);
}

function cloneVerifierInspectSummary(summary: VerifierInspectSummary): VerifierInspectSummary {
  return structuredClone(summary);
}

function clonePolicyProfile(
  profile: VerifierRegressionGatePolicyProfile,
): VerifierRegressionGatePolicyProfile {
  return structuredClone(profile);
}

function summarizeVerifierInspectComparison(
  left: VerifierInspectReport,
  right: VerifierInspectReport,
): VerifierInspectCompareSummary {
  const summary: VerifierInspectCompareSummary = {
    hasChanges: false,
    finalOutcome: createValueChange(left.summary.finalOutcome, right.summary.finalOutcome),
    latestVerifierStatus: createValueChange(left.summary.latestVerifierStatus, right.summary.latestVerifierStatus),
    latestRepairStatus: createValueChange(left.summary.latestRepairStatus, right.summary.latestRepairStatus),
    latestRepairProgress: createValueChange(left.summary.latestRepairProgress, right.summary.latestRepairProgress),
    latestDiagnosticEngine: createValueChange(
      left.summary.latestDiagnosticEngine,
      right.summary.latestDiagnosticEngine,
    ),
    latestFixHintAvailable: createValueChange(
      left.summary.latestFixHintAvailable,
      right.summary.latestFixHintAvailable,
    ),
    latestCodeActionAvailable: createValueChange(
      left.summary.latestCodeActionAvailable,
      right.summary.latestCodeActionAvailable,
    ),
    latestProjectContextAvailable: createValueChange(
      left.summary.latestProjectContextAvailable,
      right.summary.latestProjectContextAvailable,
    ),
    verifierRuns: createCountDelta(left.summary.verifierRunCount, right.summary.verifierRunCount),
    repairLoops: createCountDelta(left.summary.repairLoopCount, right.summary.repairLoopCount),
    repairAttempts: createCountDelta(left.summary.repairAttemptCount, right.summary.repairAttemptCount),
    diagnosticErrors: createCountDelta(
      resolveLatestDiagnosticCount(left, "error"),
      resolveLatestDiagnosticCount(right, "error"),
    ),
    diagnosticWarnings: createCountDelta(
      resolveLatestDiagnosticCount(left, "warning"),
      resolveLatestDiagnosticCount(right, "warning"),
    ),
    diagnosticInfo: createCountDelta(
      resolveLatestDiagnosticCount(left, "info"),
      resolveLatestDiagnosticCount(right, "info"),
    ),
    repairResolved: createCountDelta(left.summary.repairResolvedCount, right.summary.repairResolvedCount),
    repairImproved: createCountDelta(left.summary.repairImprovedCount, right.summary.repairImprovedCount),
    repairUnchanged: createCountDelta(left.summary.repairUnchangedCount, right.summary.repairUnchangedCount),
    repairRegressed: createCountDelta(left.summary.repairRegressedCount, right.summary.repairRegressedCount),
    resolvedDiagnostics: createCountDelta(
      left.summary.resolvedDiagnosticCount,
      right.summary.resolvedDiagnosticCount,
    ),
    persistedDiagnostics: createCountDelta(
      left.summary.persistedDiagnosticCount,
      right.summary.persistedDiagnosticCount,
    ),
    introducedDiagnostics: createCountDelta(
      left.summary.introducedDiagnosticCount,
      right.summary.introducedDiagnosticCount,
    ),
    fixHints: createCountDelta(left.summary.fixHintCount, right.summary.fixHintCount),
    recommendedFixHints: createCountDelta(
      left.summary.recommendedFixHintCount,
      right.summary.recommendedFixHintCount,
    ),
    fixHintFiles: createCountDelta(left.summary.fixHintFileCount, right.summary.fixHintFileCount),
    codeActionCandidates: createCountDelta(
      left.summary.codeActionCandidateCount,
      right.summary.codeActionCandidateCount,
    ),
    codeActionAllowlisted: createCountDelta(
      left.summary.codeActionAllowlistedCount,
      right.summary.codeActionAllowlistedCount,
    ),
    codeActionApplied: createCountDelta(
      left.summary.codeActionAppliedCount,
      right.summary.codeActionAppliedCount,
    ),
    codeActionBlocked: createCountDelta(
      left.summary.codeActionBlockedCount,
      right.summary.codeActionBlockedCount,
    ),
    projectContextItems: createCountDelta(left.summary.projectContextCount, right.summary.projectContextCount),
    projectContextCoverage: createCountDelta(
      left.summary.projectContextDiagnosticCoverageCount,
      right.summary.projectContextDiagnosticCoverageCount,
    ),
    projectContextDefinitions: createCountDelta(
      left.summary.projectContextDefinitionCount,
      right.summary.projectContextDefinitionCount,
    ),
    projectContextImplementations: createCountDelta(
      left.summary.projectContextImplementationCount,
      right.summary.projectContextImplementationCount,
    ),
    projectContextReferences: createCountDelta(
      left.summary.projectContextReferenceCount,
      right.summary.projectContextReferenceCount,
    ),
    projectContextDocumentSymbols: createCountDelta(
      left.summary.projectContextDocumentSymbolCount,
      right.summary.projectContextDocumentSymbolCount,
    ),
    projectContextFiles: createCountDelta(
      left.summary.projectContextFileCount,
      right.summary.projectContextFileCount,
    ),
    blockingDiagnostics: compareBlockingDiagnostics(left, right),
  };

  summary.hasChanges = hasVerifierInspectCompareChanges(summary);
  return summary;
}

function compareBlockingDiagnostics(
  left: VerifierInspectReport,
  right: VerifierInspectReport,
): VerifierInspectCompareSummary["blockingDiagnostics"] {
  const before = collectBlockingDiagnosticFingerprintsFromVerifierInspectReport(left);
  const after = collectBlockingDiagnosticFingerprintsFromVerifierInspectReport(right);
  const beforeIndex = new Map(before.map((entry) => [entry.fingerprint, entry]));
  const afterIndex = new Map(after.map((entry) => [entry.fingerprint, entry]));
  const resolved = before.filter((entry) => !afterIndex.has(entry.fingerprint));
  const persisted = before.filter((entry) => afterIndex.has(entry.fingerprint));
  const introduced = after.filter((entry) => !beforeIndex.has(entry.fingerprint));
  return {
    comparable: true,
    beforeCount: before.length,
    afterCount: after.length,
    resolvedCount: resolved.length,
    persistedCount: persisted.length,
    introducedCount: introduced.length,
    resolved,
    persisted,
    introduced,
    summary: renderBlockingDiagnosticsDeltaSummary({
      beforeCount: before.length,
      afterCount: after.length,
      resolvedCount: resolved.length,
      persistedCount: persisted.length,
      introducedCount: introduced.length,
    }),
  };
}

function hasVerifierInspectCompareChanges(
  summary: VerifierInspectCompareSummary,
): boolean {
  return summary.finalOutcome.changed
    || summary.latestVerifierStatus.changed
    || summary.latestRepairStatus.changed
    || summary.latestRepairProgress.changed
    || summary.latestDiagnosticEngine.changed
    || summary.latestFixHintAvailable.changed
    || summary.latestCodeActionAvailable.changed
    || summary.latestProjectContextAvailable.changed
    || summary.verifierRuns.changed
    || summary.repairLoops.changed
    || summary.repairAttempts.changed
    || summary.diagnosticErrors.changed
    || summary.diagnosticWarnings.changed
    || summary.diagnosticInfo.changed
    || summary.repairResolved.changed
    || summary.repairImproved.changed
    || summary.repairUnchanged.changed
    || summary.repairRegressed.changed
    || summary.resolvedDiagnostics.changed
    || summary.persistedDiagnostics.changed
    || summary.introducedDiagnostics.changed
    || summary.fixHints.changed
    || summary.recommendedFixHints.changed
    || summary.fixHintFiles.changed
    || summary.codeActionCandidates.changed
    || summary.codeActionAllowlisted.changed
    || summary.codeActionApplied.changed
    || summary.codeActionBlocked.changed
    || summary.projectContextItems.changed
    || summary.projectContextCoverage.changed
    || summary.projectContextDefinitions.changed
    || summary.projectContextImplementations.changed
    || summary.projectContextReferences.changed
    || summary.projectContextDocumentSymbols.changed
    || summary.projectContextFiles.changed
    || summary.blockingDiagnostics.resolvedCount > 0
    || summary.blockingDiagnostics.persistedCount > 0
    || summary.blockingDiagnostics.introducedCount > 0
    || summary.blockingDiagnostics.beforeCount !== summary.blockingDiagnostics.afterCount;
}

function createValueChange<T>(
  before: T,
  after: T,
): VerifierInspectValueChange<T> {
  return {
    before,
    after,
    changed: before !== after,
  };
}

function createCountDelta(before: number, after: number): VerifierInspectCountDelta {
  const delta = after - before;
  return {
    before,
    after,
    delta,
    changed: delta !== 0,
  };
}

function renderBlockingDiagnosticsDeltaSummary(input: {
  beforeCount: number;
  afterCount: number;
  resolvedCount: number;
  persistedCount: number;
  introducedCount: number;
}): string {
  if (
    input.beforeCount === 0 &&
    input.afterCount === 0 &&
    input.resolvedCount === 0 &&
    input.persistedCount === 0 &&
    input.introducedCount === 0
  ) {
    return "No blocking diagnostics on either side.";
  }
  return `Blocking diagnostics ${input.beforeCount} -> ${input.afterCount}; resolved ${input.resolvedCount}, persisted ${input.persistedCount}, introduced ${input.introducedCount}.`;
}

function resolveLatestDiagnosticCount(
  report: VerifierInspectReport,
  severity: "error" | "warning" | "info",
): number {
  const latest = report.latest.verifierRun?.summary;
  if (!latest) {
    return 0;
  }
  switch (severity) {
    case "error":
      return Number(latest.diagnosticErrorCount ?? 0);
    case "warning":
      return Number(latest.diagnosticWarningCount ?? 0);
    case "info":
      return Number(latest.diagnosticInfoCount ?? 0);
    default:
      return 0;
  }
}

function formatVerifierInspectReferenceLabel(input: {
  kind: VerifierInspectReferenceKind;
  scope: VerifierInspectScope;
  reference: string | null;
  sessionId: string | null;
  traceId: string | null;
  replayReference: string | null;
  snapshotId: string | null;
  baselineName: string | null;
}): string {
  switch (input.kind) {
    case "current":
      return "current";
    case "trace":
      return "trace";
    case "replay":
      return `replay:${input.replayReference ?? input.sessionId ?? input.reference ?? "unknown"}`;
    case "snapshot":
      return `snapshot:${input.snapshotId ?? input.reference ?? "unknown"}`;
    case "baseline":
      return `baseline:${input.baselineName ?? input.reference ?? "unknown"}`;
    default:
      return `${input.scope}:${input.reference ?? "unknown"}`;
  }
}

function createGateReason(input: {
  kind: VerifierRegressionGateReasonKind;
  severity: VerifierRegressionGateReason["severity"];
  summary: string;
  finalOutcome?: VerifierRegressionGateReason["evidence"]["finalOutcome"];
  latestVerifierStatus?: VerifierRegressionGateReason["evidence"]["latestVerifierStatus"];
  latestRepairStatus?: VerifierRegressionGateReason["evidence"]["latestRepairStatus"];
  latestRepairProgress?: VerifierRegressionGateReason["evidence"]["latestRepairProgress"];
  countDelta?: VerifierRegressionGateReason["evidence"]["countDelta"];
  blockingDiagnostics?: VerifierRegressionGateReason["evidence"]["blockingDiagnostics"];
  availabilityChange?: VerifierRegressionGateReason["evidence"]["availabilityChange"];
}): VerifierRegressionGateReason {
  return {
    kind: input.kind,
    severity: input.severity,
    summary: input.summary,
    evidence: {
      finalOutcome: input.finalOutcome ?? null,
      latestVerifierStatus: input.latestVerifierStatus ?? null,
      latestRepairStatus: input.latestRepairStatus ?? null,
      latestRepairProgress: input.latestRepairProgress ?? null,
      countDelta: input.countDelta ?? null,
      blockingDiagnostics: input.blockingDiagnostics ?? null,
      availabilityChange: input.availabilityChange ?? null,
    },
  };
}

function summarizeVerifierRegressionGateDecision(input: {
  pass: boolean;
  failureCount: number;
  noticeCount: number;
}): string {
  if (input.pass) {
    return input.noticeCount > 0
      ? `Gate passed with ${input.noticeCount} notice(s).`
      : "Gate passed with no regression reasons triggered.";
  }
  return input.noticeCount > 0
    ? `Gate failed with ${input.failureCount} failure reason(s) and ${input.noticeCount} notice(s).`
    : `Gate failed with ${input.failureCount} failure reason(s).`;
}

function isVerifierInspectOutcomeRegression(
  before: VerifierInspectFinalOutcome,
  after: VerifierInspectFinalOutcome,
): boolean {
  return rankVerifierInspectOutcome(after) < rankVerifierInspectOutcome(before);
}

function isVerifierStatusRegression(
  before: VerifierInspectSummary["latestVerifierStatus"],
  after: VerifierInspectSummary["latestVerifierStatus"],
): boolean {
  return rankVerifierStatus(after) < rankVerifierStatus(before);
}

function isRepairStatusRegression(
  before: VerifierInspectSummary["latestRepairStatus"],
  after: VerifierInspectSummary["latestRepairStatus"],
): boolean {
  return rankRepairStatus(after) < rankRepairStatus(before);
}

function rankVerifierInspectOutcome(value: VerifierInspectFinalOutcome): number {
  switch (value) {
    case "success":
      return 4;
    case "stopped":
      return 3;
    case "degraded":
      return 2;
    case "unknown":
      return 1;
    case "failed":
    default:
      return 0;
  }
}

function rankVerifierStatus(
  value: VerifierInspectSummary["latestVerifierStatus"],
): number {
  switch (value) {
    case "passed":
      return 4;
    case "skipped":
      return 3;
    case "unavailable":
      return 2;
    case "failed":
      return 1;
    case "none":
    default:
      return 0;
  }
}

function rankRepairStatus(
  value: VerifierInspectSummary["latestRepairStatus"],
): number {
  switch (value) {
    case "succeeded":
      return 5;
    case "retrying":
      return 4;
    case "exhausted":
      return 3;
    case "stopped":
      return 2;
    case "failed":
      return 1;
    case "none":
    default:
      return 0;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function isVerifierRunRecord(value: unknown): value is VerifierRunRecord {
  return isObject(value) &&
    typeof value.startedAt === "string" &&
    typeof value.finishedAt === "string" &&
    "summary" in value &&
    isObject(value.summary) &&
    typeof value.summary.status === "string" &&
    Array.isArray(value.checks);
}

function isRepairLoopRecord(value: unknown): value is RepairLoopRecord {
  return isObject(value) &&
    typeof value.startedAt === "string" &&
    "maxAttempts" in value &&
    typeof value.maxAttempts === "number" &&
    Array.isArray(value.attempts) &&
    "summary" in value &&
    isObject(value.summary) &&
    typeof value.summary.status === "string";
}
