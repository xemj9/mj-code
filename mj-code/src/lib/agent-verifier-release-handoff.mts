import crypto from "node:crypto";

import type {
  VerifierEvalArtifactRecord,
  VerifierInspectArtifactMetadata,
  VerifierInspectArtifactRecord,
  VerifierInspectBaselinePromotionRecord,
  VerifierInspectBaselineRecord,
  VerifierInspectBlockingDiagnosticDelta,
  VerifierInspectCompareArtifactRecord,
  VerifierInspectCompareSummary,
  VerifierInspectFinalOutcome,
  VerifierInspectResolvedReference,
  VerifierInspectSummary,
  VerifierInspectValueChange,
  VerifierRegressionGateArtifactRecord,
  VerifierRegressionGateReason,
  VerifierReleaseHandoffBlockingDiagnosticSummary,
  VerifierReleaseHandoffMetadata,
  VerifierReleaseHandoffReasonSummary,
  VerifierReleaseHandoffRecord,
  VerifierReleaseHandoffSelection,
  VerifierReleaseHandoffSourceKind,
  VerifierReleaseHandoffStatus,
} from "../types/contracts.js";

import {
  createVerifierReleaseTriageSummaryFromHandoff,
} from "./agent-verifier-release-triage.mjs";

const MAX_HANDOFF_REASONS = 5;
const MAX_HANDOFF_BLOCKING_DIAGNOSTICS = 3;

export function createVerifierReleaseHandoffFromArtifactRecord(
  artifact: VerifierInspectArtifactRecord,
): VerifierReleaseHandoffRecord {
  const createdAt = new Date().toISOString();
  if (isCompareArtifactRecord(artifact)) {
    return createCompareArtifactHandoff(artifact, createdAt);
  }
  if (isGateArtifactRecord(artifact)) {
    return createGateArtifactHandoff(artifact, createdAt);
  }
  if (isEvalArtifactRecord(artifact)) {
    return createEvalArtifactHandoff(artifact, createdAt);
  }
  throw new Error("Unsupported verifier artifact kind for handoff.");
}

export function createVerifierReleaseHandoffFromBaselinePromotion(input: {
  baseline: VerifierInspectBaselineRecord;
  promotion: VerifierInspectBaselinePromotionRecord;
}): VerifierReleaseHandoffRecord {
  const sourceReferences: VerifierInspectResolvedReference[] = [
    structuredClone(input.promotion.previousSource),
    structuredClone(input.promotion.nextSource),
  ];
  const summary = `Baseline ${input.baseline.metadata.name} promoted from ${input.promotion.previousSnapshotId} to ${input.promotion.nextSnapshotId}.`;
  const topReasons: VerifierReleaseHandoffReasonSummary[] = [{
    kind: "baseline_promoted",
    severity: "info",
    summary,
  }];
  if (input.promotion.approval) {
    topReasons.push({
      kind: "baseline_promoted",
      severity: "notice",
      summary: `Approved by ${input.promotion.approval.actor.displayName ?? input.promotion.approval.actor.id ?? input.promotion.approval.actor.kind} via ${input.promotion.approval.source} (${input.promotion.approval.approvalMode}).`,
    });
  }
  const record: VerifierReleaseHandoffRecord = {
    metadata: {
      handoffId: createVerifierReleaseHandoffId(),
      createdAt: input.promotion.createdAt,
      sourceKind: "baseline_promotion",
      status: "promoted",
      policyProfileId: input.promotion.nextPolicyProfileId,
      primaryArtifactId: null,
      artifactIds: [],
      snapshotIds: [
        input.promotion.previousSnapshotId,
        input.promotion.nextSnapshotId,
      ],
      baselineNames: [input.baseline.metadata.name],
      pass: null,
      bundleId: null,
      workflow: null,
      upload: null,
      summary,
    },
    sourceReferences,
    primaryArtifact: null,
    sourceArtifactIds: [],
    baselinePromotionId: input.promotion.promotionId,
    baselineId: input.baseline.metadata.baselineId,
    baselineName: input.baseline.metadata.name,
    finalOutcome: createValueChange(
      input.promotion.previousSummary.finalOutcome,
      input.promotion.nextSummary.finalOutcome,
    ),
    latestVerifierStatus: createValueChange(
      input.promotion.previousSummary.latestVerifierStatus,
      input.promotion.nextSummary.latestVerifierStatus,
    ),
    latestRepairStatus: createValueChange(
      input.promotion.previousSummary.latestRepairStatus,
      input.promotion.nextSummary.latestRepairStatus,
    ),
    topReasons,
    blockingDiagnostics: null,
    triage: null,
    summary,
  };
  record.triage = createVerifierReleaseTriageSummaryFromHandoff(record);
  return record;
}

export function createVerifierReleaseHandoffSelection(input: {
  reference: string | null;
  handoff: VerifierReleaseHandoffRecord | null;
  latestArtifactId?: string | null;
  latestCompareArtifactId?: string | null;
  latestGateArtifactId?: string | null;
  latestEvalArtifactId?: string | null;
  reason?: string | null;
}): VerifierReleaseHandoffSelection {
  return {
    available: input.handoff != null,
    reason: input.handoff ? null : (input.reason ?? "No verifier release handoff is available."),
    reference: input.reference,
    latestArtifactId: input.latestArtifactId ?? null,
    latestCompareArtifactId: input.latestCompareArtifactId ?? null,
    latestGateArtifactId: input.latestGateArtifactId ?? null,
    latestEvalArtifactId: input.latestEvalArtifactId ?? null,
    handoff: input.handoff ? structuredClone(input.handoff) : null,
  };
}

export function createVerifierReleaseHandoffId(): string {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
  return `vih-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function createCompareArtifactHandoff(
  artifact: VerifierInspectCompareArtifactRecord,
  createdAt: string,
): VerifierReleaseHandoffRecord {
  const topReasons = collectCompareReasons(artifact.compare.summary);
  const summary = artifact.metadata.summary;
  const record: VerifierReleaseHandoffRecord = {
    metadata: createHandoffMetadata({
      createdAt,
      sourceKind: "compare",
      status: artifact.compare.summary.hasChanges ? "changed" : "steady",
      artifact: artifact.metadata,
      pass: null,
      summary,
    }),
    sourceReferences: collectArtifactSourceReferences(artifact.metadata),
    primaryArtifact: structuredClone(artifact.metadata),
    sourceArtifactIds: [artifact.metadata.artifactId],
    baselinePromotionId: null,
    baselineId: null,
    baselineName: artifact.metadata.baselineNames[0] ?? null,
    finalOutcome: structuredClone(artifact.compare.summary.finalOutcome),
    latestVerifierStatus: structuredClone(artifact.compare.summary.latestVerifierStatus),
    latestRepairStatus: structuredClone(artifact.compare.summary.latestRepairStatus),
    topReasons,
    blockingDiagnostics: summarizeBlockingDiagnostics(artifact.compare.summary.blockingDiagnostics),
    triage: null,
    summary,
  };
  record.triage = createVerifierReleaseTriageSummaryFromHandoff(record);
  return record;
}

function createGateArtifactHandoff(
  artifact: VerifierRegressionGateArtifactRecord,
  createdAt: string,
): VerifierReleaseHandoffRecord {
  const decision = artifact.decision;
  const summary = artifact.metadata.summary;
  const record: VerifierReleaseHandoffRecord = {
    metadata: createHandoffMetadata({
      createdAt,
      sourceKind: "gate",
      status: decision.pass ? "pass" : "fail",
      artifact: artifact.metadata,
      pass: decision.pass,
      summary,
    }),
    sourceReferences: collectArtifactSourceReferences(artifact.metadata),
    primaryArtifact: structuredClone(artifact.metadata),
    sourceArtifactIds: [artifact.metadata.artifactId],
    baselinePromotionId: null,
    baselineId: null,
    baselineName: artifact.metadata.baselineNames[0] ?? null,
    finalOutcome: structuredClone(decision.compare.summary.finalOutcome),
    latestVerifierStatus: structuredClone(decision.compare.summary.latestVerifierStatus),
    latestRepairStatus: structuredClone(decision.compare.summary.latestRepairStatus),
    topReasons: decision.reasons
      .slice(0, MAX_HANDOFF_REASONS)
      .map((reason) => summarizeGateReason(reason)),
    blockingDiagnostics: summarizeBlockingDiagnostics(decision.compare.summary.blockingDiagnostics),
    triage: null,
    summary,
  };
  record.triage = createVerifierReleaseTriageSummaryFromHandoff(record);
  return record;
}

function createEvalArtifactHandoff(
  artifact: VerifierEvalArtifactRecord,
  createdAt: string,
): VerifierReleaseHandoffRecord {
  const baselineGate = artifact.result.baselineGate ?? null;
  const topReasons = baselineGate
    ? baselineGate.reasons.slice(0, MAX_HANDOFF_REASONS).map((reason) => summarizeGateReason(reason))
    : [];
  const summary = artifact.metadata.summary;
  const record: VerifierReleaseHandoffRecord = {
    metadata: createHandoffMetadata({
      createdAt,
      sourceKind: "eval",
      status: artifact.metadata.pass === false ? "fail" : "pass",
      artifact: artifact.metadata,
      pass: artifact.metadata.pass,
      summary,
    }),
    sourceReferences: collectArtifactSourceReferences(artifact.metadata),
    primaryArtifact: structuredClone(artifact.metadata),
    sourceArtifactIds: [artifact.metadata.artifactId],
    baselinePromotionId: null,
    baselineId: null,
    baselineName: artifact.metadata.baselineNames[0] ?? null,
    finalOutcome: baselineGate
      ? structuredClone(baselineGate.compare.summary.finalOutcome)
      : null,
    latestVerifierStatus: baselineGate
      ? structuredClone(baselineGate.compare.summary.latestVerifierStatus)
      : null,
    latestRepairStatus: baselineGate
      ? structuredClone(baselineGate.compare.summary.latestRepairStatus)
      : null,
    topReasons,
    blockingDiagnostics: baselineGate
      ? summarizeBlockingDiagnostics(baselineGate.compare.summary.blockingDiagnostics)
      : null,
    triage: null,
    summary,
  };
  record.triage = createVerifierReleaseTriageSummaryFromHandoff(record);
  return record;
}

function createHandoffMetadata(input: {
  createdAt: string;
  sourceKind: VerifierReleaseHandoffSourceKind;
  status: VerifierReleaseHandoffStatus;
  artifact: VerifierInspectArtifactMetadata | null;
  pass: boolean | null;
  summary: string;
}): VerifierReleaseHandoffMetadata {
  return {
    handoffId: createVerifierReleaseHandoffId(),
    createdAt: input.createdAt,
    sourceKind: input.sourceKind,
    status: input.status,
    policyProfileId: input.artifact?.policyProfileId ?? null,
    primaryArtifactId: input.artifact?.artifactId ?? null,
    artifactIds: input.artifact ? [input.artifact.artifactId] : [],
    snapshotIds: structuredClone(input.artifact?.snapshotIds ?? []),
    baselineNames: structuredClone(input.artifact?.baselineNames ?? []),
    pass: input.pass,
    bundleId: input.artifact?.bundleId ?? null,
    workflow: input.artifact?.workflow ? structuredClone(input.artifact.workflow) : null,
    upload: input.artifact?.upload ? structuredClone(input.artifact.upload) : null,
    summary: input.summary,
  };
}

function collectArtifactSourceReferences(
  metadata: VerifierInspectArtifactMetadata,
): VerifierInspectResolvedReference[] {
  return metadata.sourceReferences.map((entry) => structuredClone(entry));
}

function summarizeGateReason(
  reason: VerifierRegressionGateReason,
): VerifierReleaseHandoffReasonSummary {
  return {
    kind: reason.kind,
    severity: reason.severity,
    summary: reason.summary,
  };
}

function collectCompareReasons(
  summary: VerifierInspectCompareSummary,
): VerifierReleaseHandoffReasonSummary[] {
  const reasons: VerifierReleaseHandoffReasonSummary[] = [];
  if (summary.finalOutcome.changed) {
    reasons.push({
      kind: "compare_changed",
      severity: "info",
      summary: `Final outcome changed from ${summary.finalOutcome.before} to ${summary.finalOutcome.after}.`,
    });
  }
  if (summary.diagnosticErrors.delta !== 0) {
    reasons.push({
      kind: "compare_changed",
      severity: summary.diagnosticErrors.delta > 0 ? "failure" : "info",
      summary: `Diagnostic errors changed by ${summary.diagnosticErrors.delta} (${summary.diagnosticErrors.before} -> ${summary.diagnosticErrors.after}).`,
    });
  }
  if (summary.blockingDiagnostics.introducedCount > 0 || summary.blockingDiagnostics.resolvedCount > 0) {
    reasons.push({
      kind: "compare_changed",
      severity: summary.blockingDiagnostics.introducedCount > 0 ? "failure" : "info",
      summary: `Blocking diagnostics: introduced ${summary.blockingDiagnostics.introducedCount}, resolved ${summary.blockingDiagnostics.resolvedCount}, persisted ${summary.blockingDiagnostics.persistedCount}.`,
    });
  }
  return reasons.slice(0, MAX_HANDOFF_REASONS);
}

function summarizeBlockingDiagnostics(
  value: VerifierInspectBlockingDiagnosticDelta,
): VerifierReleaseHandoffBlockingDiagnosticSummary {
  return {
    comparable: value.comparable,
    beforeCount: value.beforeCount,
    afterCount: value.afterCount,
    resolvedCount: value.resolvedCount,
    persistedCount: value.persistedCount,
    introducedCount: value.introducedCount,
    resolved: value.resolved.slice(0, MAX_HANDOFF_BLOCKING_DIAGNOSTICS).map((entry) => structuredClone(entry)),
    persisted: value.persisted.slice(0, MAX_HANDOFF_BLOCKING_DIAGNOSTICS).map((entry) => structuredClone(entry)),
    introduced: value.introduced.slice(0, MAX_HANDOFF_BLOCKING_DIAGNOSTICS).map((entry) => structuredClone(entry)),
    summary: value.summary,
  };
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

function isCompareArtifactRecord(
  artifact: VerifierInspectArtifactRecord,
): artifact is VerifierInspectCompareArtifactRecord {
  return artifact.metadata.kind === "compare" && "compare" in artifact;
}

function isGateArtifactRecord(
  artifact: VerifierInspectArtifactRecord,
): artifact is VerifierRegressionGateArtifactRecord {
  return artifact.metadata.kind === "gate" && "decision" in artifact;
}

function isEvalArtifactRecord(
  artifact: VerifierInspectArtifactRecord,
): artifact is VerifierEvalArtifactRecord {
  return artifact.metadata.kind === "eval" && "result" in artifact;
}
