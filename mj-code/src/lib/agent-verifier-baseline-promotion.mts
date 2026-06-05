import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  VerifierBaselinePromotionApprovalRecord,
  VerifierBaselinePromotionApprovalActor,
  VerifierBaselinePromotionApprovalMode,
  VerifierBaselinePromotionApprovalSource,
  VerifierBaselinePromotionApprovalStatus,
  VerifierBaselinePromotionApproverKind,
  VerifierBaselinePromotionBaselineScope,
  VerifierBaselinePromotionBlockingEvidence,
  VerifierBaselinePromotionCandidate,
  VerifierBaselinePromotionDecision,
  VerifierBaselinePromotionDecisionReason,
  VerifierBaselinePromotionDecisionReasonKind,
  VerifierBaselinePromotionEligibilityEvidence,
  VerifierBaselinePromotionHistory,
  VerifierBaselinePromotionPlanRecord,
  VerifierBaselinePromotionPolicyInheritanceSource,
  VerifierInspectArtifactRecord,
  VerifierInspectBaselineRecord,
  VerifierInspectCompareReport,
  VerifierInspectReference,
  VerifierInspectReport,
  VerifierInspectResolvedReference,
  VerifierInspectSnapshotRecord,
  VerifierRegressionGatePolicyProfileId,
  VerifierRegressionGateReason,
} from "../types/contracts.js";

import {
  VerifierInspectArtifactStore,
} from "./agent-verifier-inspect-artifact-store.mjs";

import {
  VerifierInspectSnapshotStore,
  VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
} from "./agent-verifier-inspect-store.mjs";

import {
  VerifierReleaseStore,
} from "./agent-verifier-release-store.mjs";

const PROMOTION_PLAN_DIRNAME = "promotion-plans";

interface PromotionSourceSelection {
  artifact: VerifierInspectArtifactRecord;
  handoffId: string | null;
  bundleId: string | null;
  compare: VerifierInspectCompareReport;
  sourceKind: VerifierBaselinePromotionCandidate["source"]["sourceKind"];
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  pass: boolean | null;
  gateReasons: VerifierRegressionGateReason[];
  evalFailedCount: number | null;
  evalSummary: VerifierBaselinePromotionBlockingEvidence["evalSummary"];
}

interface ResolvedPromotionPolicyProfile {
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  inheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
}

export class VerifierBaselinePromotionStore {
  readonly projectStateDir: string;
  readonly planDir: string;
  readonly artifactStore: VerifierInspectArtifactStore;
  readonly snapshotStore: VerifierInspectSnapshotStore;
  readonly releaseStore: VerifierReleaseStore;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.planDir = path.join(
      projectStateDir,
      VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
      PROMOTION_PLAN_DIRNAME,
    );
    this.artifactStore = new VerifierInspectArtifactStore(projectStateDir);
    this.snapshotStore = new VerifierInspectSnapshotStore(projectStateDir);
    this.releaseStore = new VerifierReleaseStore(projectStateDir);
  }

  async createPlan(input: {
    baselineName: string;
    reference?: string | null;
    policyProfileId?: VerifierRegressionGatePolicyProfileId | null;
  }): Promise<VerifierBaselinePromotionPlanRecord> {
    const baselineName = `${input.baselineName ?? ""}`.trim();
    if (!baselineName) {
      throw new Error("Missing verifier baseline name for promotion plan.");
    }
    await fs.mkdir(this.planDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const baseline = await this.snapshotStore.loadBaseline({ kind: "baseline", reference: baselineName }).catch(() => null);
    const source = await this.resolvePromotionSource(input.reference ?? "latest");
    const targetSnapshot = await this.snapshotStore.exportSnapshot({
      source: source.compare.right.reference,
      report: source.compare.right.report,
    });
    const policyResolution = resolvePromotionPolicyProfile({
      explicitPolicyProfileId: input.policyProfileId ?? null,
      baselinePolicyProfileId: baseline?.metadata.policyProfileId ?? null,
      artifactPolicyProfileId: source.policyProfileId,
    });
    const baselineScope = createBaselineScope(
      baselineName,
      source.compare.right.reference,
    );
    const candidate = createPromotionCandidate({
      baselineName,
      createdAt,
      baseline,
      source,
      targetSnapshot,
      policyProfileId: policyResolution.policyProfileId,
      policyInheritanceSource: policyResolution.inheritanceSource,
      baselineScope,
    });
    const decision = createPromotionDecision({
      baseline,
      candidate,
      source,
    });
    const plan: VerifierBaselinePromotionPlanRecord = {
      planId: createPlanId(),
      createdAt,
      baselineName,
      baselineId: baseline?.metadata.baselineId ?? null,
      candidate,
      decision,
      approvalStatus: decision.eligible ? "pending" : "blocked",
      approval: null,
      appliedBaselineId: null,
      appliedSnapshotId: null,
      appliedPromotionId: null,
      handoffId: null,
      policyInheritanceSource: candidate.policyInheritanceSource,
      baselineScope: structuredClone(candidate.baselineScope),
      summary: decision.summary,
    };
    await this.writePlan(plan);
    return structuredClone(plan);
  }

  async approvePlan(input: {
    reference: string;
    approverKind?: VerifierBaselinePromotionApproverKind;
    approverId?: string | null;
    approvalSource?: VerifierBaselinePromotionApprovalSource;
    approvalMode?: VerifierBaselinePromotionApprovalMode;
    approverDisplayName?: string | null;
  }): Promise<VerifierBaselinePromotionPlanRecord> {
    const plan = await this.loadPlan(input.reference);
    if (plan.approvalStatus === "applied") {
      return structuredClone(plan);
    }
    const approvalCreatedAt = new Date().toISOString();
    const approverKind = input.approverKind ?? "operator";
    const approverId = input.approverId ?? null;
    const actor = createApprovalActor({
      kind: approverKind,
      id: approverId,
      displayName: input.approverDisplayName ?? null,
    });
    const approvalSource = input.approvalSource
      ?? deriveApprovalSourceFromApproverKind(approverKind);
    const approvalMode = input.approvalMode ?? "explicit_apply";
    if (!plan.decision.eligible) {
      const blockedApproval = createApprovalRecord({
        createdAt: approvalCreatedAt,
        status: "blocked",
        actor,
        source: approvalSource,
        approvalMode,
        policyInheritanceSource: plan.policyInheritanceSource,
        baselineScope: plan.baselineScope,
        eligibilityEvidence: plan.decision.eligibilityEvidence,
        summary: `Promotion plan ${plan.planId} remains blocked: ${plan.decision.summary}`,
      });
      const blockedPlan: VerifierBaselinePromotionPlanRecord = {
        ...structuredClone(plan),
        approvalStatus: "blocked",
        approval: blockedApproval,
        summary: blockedApproval.summary,
      };
      await this.writePlan(blockedPlan);
      return blockedPlan;
    }

    const approval = createApprovalRecord({
      createdAt: approvalCreatedAt,
      status: "applied",
      actor,
      source: approvalSource,
      approvalMode,
      policyInheritanceSource: plan.policyInheritanceSource,
      baselineScope: plan.baselineScope,
      eligibilityEvidence: plan.decision.eligibilityEvidence,
      summary: `Promotion plan ${plan.planId} approved and applied for baseline ${plan.baselineName}.`,
    });
    const targetSnapshot = await this.snapshotStore.loadSnapshot(plan.candidate.targetSnapshotId);
    const { baseline, promotion } = await this.snapshotStore.pinBaseline({
      name: plan.baselineName,
      snapshot: targetSnapshot,
      policyProfileId: plan.candidate.policyProfileId,
    }, {
      planId: plan.planId,
      candidate: plan.candidate,
      decision: plan.decision,
      approval,
    });
    const handoff = promotion
      ? await this.releaseStore.writeBaselinePromotionHandoff({
          baseline,
          promotion,
        })
      : null;
    const appliedPlan: VerifierBaselinePromotionPlanRecord = {
      ...structuredClone(plan),
      baselineId: baseline.metadata.baselineId,
      approvalStatus: "applied",
      approval,
      appliedBaselineId: baseline.metadata.baselineId,
      appliedSnapshotId: baseline.metadata.snapshotId,
      appliedPromotionId: promotion?.promotionId ?? null,
      handoffId: handoff?.metadata.handoffId ?? null,
      summary: promotion
        ? `Promotion plan ${plan.planId} applied baseline ${baseline.metadata.name} to snapshot ${baseline.metadata.snapshotId} with promotion audit ${promotion.promotionId}.`
        : `Promotion plan ${plan.planId} created baseline ${baseline.metadata.name} at snapshot ${baseline.metadata.snapshotId}.`,
    };
    await this.writePlan(appliedPlan);
    return appliedPlan;
  }

  async loadPlan(reference: string): Promise<VerifierBaselinePromotionPlanRecord> {
    const planId = await this.resolvePlanId(reference);
    const payload = JSON.parse(await fs.readFile(this.getPlanPath(planId), "utf8")) as unknown;
    return normalizePlanRecord(payload, planId);
  }

  async listHistory(baselineName: string): Promise<VerifierBaselinePromotionHistory> {
    const baseline = await this.snapshotStore.loadBaseline({ kind: "baseline", reference: baselineName }).catch(() => null);
    return {
      baselineName,
      baselineId: baseline?.metadata.baselineId ?? null,
      total: baseline?.history.length ?? 0,
      items: baseline?.history.map((entry) => structuredClone(entry)) ?? [],
    };
  }

  getPlanPath(planId: string): string {
    return path.join(this.planDir, `${planId}.json`);
  }

  private async writePlan(plan: VerifierBaselinePromotionPlanRecord): Promise<void> {
    await fs.mkdir(this.planDir, { recursive: true });
    await fs.writeFile(
      this.getPlanPath(plan.planId),
      `${JSON.stringify(plan, null, 2)}\n`,
      "utf8",
    );
  }

  private async resolvePlanId(reference: string): Promise<string> {
    const normalized = `${reference ?? ""}`.trim();
    if (!normalized) {
      throw new Error("Missing verifier promotion plan reference.");
    }
    await fs.mkdir(this.planDir, { recursive: true });
    const directPath = this.getPlanPath(normalized);
    try {
      await fs.access(directPath);
      return normalized;
    } catch {}
    const entries = await fs.readdir(this.planDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.basename(entry.name, ".json"))
      .filter((entry) => entry === normalized || entry.startsWith(normalized));
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(`Could not resolve verifier promotion plan "${normalized}".`);
  }

  private async resolvePromotionSource(reference: string): Promise<PromotionSourceSelection> {
    const selection = await this.releaseStore.loadHandoff(reference).catch(() => null);
    if (selection?.handoff?.metadata.primaryArtifactId) {
      const artifact = await this.artifactStore.loadArtifact(selection.handoff.metadata.primaryArtifactId);
      return createPromotionSourceSelection(artifact, selection.handoff.metadata.handoffId, selection.handoff.metadata.bundleId);
    }
    const artifact = await this.artifactStore.loadArtifact(reference);
    const handoff = await this.releaseStore.loadHandoff(artifact.metadata.artifactId).catch(() => null);
    return createPromotionSourceSelection(
      artifact,
      handoff?.handoff?.metadata.handoffId ?? null,
      handoff?.handoff?.metadata.bundleId ?? null,
    );
  }
}

function createPromotionSourceSelection(
  artifact: VerifierInspectArtifactRecord,
  handoffId: string | null,
  bundleId: string | null,
): PromotionSourceSelection {
  if ("compare" in artifact) {
    return {
      artifact,
      handoffId,
      bundleId,
      compare: structuredClone(artifact.compare),
      sourceKind: "compare",
      policyProfileId: artifact.metadata.policyProfileId,
      pass: null,
      gateReasons: [],
      evalFailedCount: null,
      evalSummary: null,
    };
  }
  if ("decision" in artifact) {
    return {
      artifact,
      handoffId,
      bundleId,
      compare: structuredClone(artifact.decision.compare),
      sourceKind: "gate",
      policyProfileId: artifact.decision.profile.id,
      pass: artifact.decision.pass,
      gateReasons: artifact.decision.reasons.map((entry) => structuredClone(entry)),
      evalFailedCount: null,
      evalSummary: null,
    };
  }
  const baselineGate = artifact.result.baselineGate;
  if (!baselineGate) {
    throw new Error("Verifier promotion plan requires a gate artifact or a baseline-aware eval artifact.");
  }
  return {
    artifact,
    handoffId,
    bundleId,
    compare: structuredClone(baselineGate.compare),
    sourceKind: "eval",
    policyProfileId: artifact.result.baselinePolicyProfile?.id ?? baselineGate.profile.id,
    pass: baselineGate.pass && artifact.result.summary.failed === 0,
    gateReasons: baselineGate.reasons.map((entry) => structuredClone(entry)),
    evalFailedCount: artifact.result.summary.failed,
    evalSummary: structuredClone(artifact.result.summary),
  };
}

function createPromotionCandidate(input: {
  baselineName: string;
  createdAt: string;
  baseline: VerifierInspectBaselineRecord | null;
  source: PromotionSourceSelection;
  targetSnapshot: VerifierInspectSnapshotRecord;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  policyInheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
  baselineScope: VerifierBaselinePromotionBaselineScope;
}): VerifierBaselinePromotionCandidate {
  return {
    candidateId: createCandidateId(),
    createdAt: input.createdAt,
    baselineName: input.baselineName,
    baselineId: input.baseline?.metadata.baselineId ?? null,
    source: {
      sourceKind: input.source.sourceKind,
      artifactKind: input.source.artifact.metadata.kind,
      artifactId: input.source.artifact.metadata.artifactId,
      handoffId: input.source.handoffId,
      bundleId: input.source.bundleId,
      policyProfileId: input.source.policyProfileId,
      policyInheritanceSource: input.policyInheritanceSource,
      baselineName: input.source.artifact.metadata.baselineNames[0] ?? null,
      summary: input.source.artifact.metadata.summary,
    },
    baselineScope: structuredClone(input.baselineScope),
    currentSnapshotId: input.baseline?.metadata.snapshotId ?? null,
    currentSummary: input.baseline?.metadata.summary ? structuredClone(input.baseline.metadata.summary) : null,
    targetReference: structuredClone(input.source.compare.right.reference),
    targetSnapshotId: input.targetSnapshot.metadata.snapshotId,
    targetSummary: structuredClone(input.targetSnapshot.report.summary),
    policyProfileId: input.policyProfileId,
    policyInheritanceSource: input.policyInheritanceSource,
    summary: `Promotion candidate for baseline ${input.baselineName} targets snapshot ${input.targetSnapshot.metadata.snapshotId} from ${input.source.sourceKind} artifact ${input.source.artifact.metadata.artifactId}.`,
  };
}

function createPromotionDecision(input: {
  baseline: VerifierInspectBaselineRecord | null;
  candidate: VerifierBaselinePromotionCandidate;
  source: PromotionSourceSelection;
}): VerifierBaselinePromotionDecision {
  const reasons: VerifierBaselinePromotionDecisionReason[] = [];
  if (input.source.sourceKind === "compare") {
    reasons.push({
      kind: "source_unsupported",
      severity: "failure",
      summary: "Compare artifacts are not eligible for baseline promotion; use a gate or baseline-aware eval artifact.",
    });
  }
  if (input.source.sourceKind === "gate" && input.source.pass !== true) {
    reasons.push({
      kind: "gate_failed",
      severity: "failure",
      summary: "Gate artifact failed and blocks baseline promotion.",
    });
  }
  if (input.source.sourceKind === "eval" && input.source.pass !== true) {
    reasons.push({
      kind: "eval_failed",
      severity: "failure",
      summary: input.source.evalFailedCount != null
        ? `Eval artifact failed ${input.source.evalFailedCount} case(s) and blocks baseline promotion.`
        : "Eval artifact failed and blocks baseline promotion.",
    });
  }
  if (
    input.baseline
    && input.baseline.metadata.snapshotId === input.candidate.targetSnapshotId
    && input.baseline.metadata.policyProfileId === input.candidate.policyProfileId
  ) {
    reasons.push({
      kind: "baseline_already_current",
      severity: "notice",
      summary: `Baseline ${input.candidate.baselineName} already points to snapshot ${input.candidate.targetSnapshotId} with policy ${input.candidate.policyProfileId ?? "default"}.`,
    });
  }
  if (input.baseline == null) {
    reasons.push({
      kind: "baseline_missing",
      severity: "info",
      summary: `Baseline ${input.candidate.baselineName} does not exist yet; approval will create it from the candidate snapshot.`,
    });
  }
  reasons.push({
    kind: input.candidate.policyInheritanceSource === "explicit" ? "policy_overridden" : "policy_inherited",
    severity: "info",
    summary: input.candidate.policyInheritanceSource === "explicit"
      ? `Promotion will use explicit policy profile ${input.candidate.policyProfileId ?? "default"}.`
      : `Promotion will inherit policy profile ${input.candidate.policyProfileId ?? "default"} from ${input.candidate.policyInheritanceSource}.`,
  });

  const failureCount = reasons.filter((entry) => entry.severity === "failure").length;
  const blockedByNoChange = reasons.some((entry) => entry.kind === "baseline_already_current");
  const eligible = failureCount === 0 && !blockedByNoChange;
  if (eligible) {
    reasons.push({
      kind: "ready_for_promotion",
      severity: "info",
      summary: `Baseline ${input.candidate.baselineName} is eligible for promotion to snapshot ${input.candidate.targetSnapshotId}.`,
    });
    reasons.push({
      kind: "approval_required",
      severity: "notice",
      summary: "Promotion requires an explicit approval/apply step; no automatic baseline overwrite occurs.",
    });
  }
  const blockingEvidence: VerifierBaselinePromotionBlockingEvidence = {
    finalOutcome: createValueChange(
      input.source.compare.summary.finalOutcome.before,
      input.source.compare.summary.finalOutcome.after,
    ),
    latestVerifierStatus: createValueChange(
      input.source.compare.summary.latestVerifierStatus.before,
      input.source.compare.summary.latestVerifierStatus.after,
    ),
    latestRepairStatus: createValueChange(
      input.source.compare.summary.latestRepairStatus.before,
      input.source.compare.summary.latestRepairStatus.after,
    ),
    diagnosticErrors: structuredClone(input.source.compare.summary.diagnosticErrors),
    blockingDiagnostics: structuredClone(input.source.compare.summary.blockingDiagnostics),
    gateReasons: input.source.gateReasons.map((entry) => structuredClone(entry)),
    evalSummary: input.source.evalSummary ? structuredClone(input.source.evalSummary) : null,
  };
  const eligibilityEvidence: VerifierBaselinePromotionEligibilityEvidence = {
    sourceKind: input.source.sourceKind,
    sourceArtifactKind: input.source.artifact.metadata.kind,
    sourceArtifactId: input.source.artifact.metadata.artifactId,
    sourceHandoffId: input.source.handoffId,
    sourceBundleId: input.source.bundleId,
    sourcePass: input.source.pass,
    sourceHasChanges: input.source.compare.summary.hasChanges,
    sourcePolicyProfileId: input.source.policyProfileId,
    policyInheritanceSource: input.candidate.policyInheritanceSource,
    baselineScope: structuredClone(input.candidate.baselineScope),
    diagnosticErrorDelta: input.source.compare.summary.diagnosticErrors?.delta ?? null,
    blockingDiagnosticIntroducedCount:
      input.source.compare.summary.blockingDiagnostics?.introducedCount ?? null,
    gateFailureReasonKinds: input.source.gateReasons.map((entry) => entry.kind),
    evalFailedCount: input.source.evalFailedCount,
  };
  const blockReason = !eligible
    ? resolvePromotionBlockReason(reasons)
    : null;
  return {
    status: eligible ? "eligible" : "blocked",
    eligible,
    reasons,
    blockingEvidence,
    policyInheritanceSource: input.candidate.policyInheritanceSource,
    baselineScope: structuredClone(input.candidate.baselineScope),
    eligibilityEvidence,
    blockReason,
    summary: eligible
      ? `Promotion plan is eligible: ${input.candidate.baselineName} can move to ${input.candidate.targetSnapshotId}.`
      : `Promotion plan is blocked for ${input.candidate.baselineName}.`,
  };
}

function createApprovalRecord(input: {
  createdAt: string;
  status: VerifierBaselinePromotionApprovalStatus;
  actor: VerifierBaselinePromotionApprovalActor;
  source: VerifierBaselinePromotionApprovalSource;
  approvalMode: VerifierBaselinePromotionApprovalMode;
  policyInheritanceSource: VerifierBaselinePromotionPolicyInheritanceSource;
  baselineScope: VerifierBaselinePromotionBaselineScope;
  eligibilityEvidence: VerifierBaselinePromotionEligibilityEvidence | null;
  summary: string;
}): VerifierBaselinePromotionApprovalRecord {
  return {
    approvalId: createApprovalId(),
    createdAt: input.createdAt,
    status: input.status,
    approverKind: input.actor.kind,
    approverId: input.actor.id,
    actor: structuredClone(input.actor),
    source: input.source,
    approvalMode: input.approvalMode,
    policyInheritanceSource: input.policyInheritanceSource,
    baselineScope: structuredClone(input.baselineScope),
    eligibilityEvidence: input.eligibilityEvidence
      ? structuredClone(input.eligibilityEvidence)
      : null,
    summary: input.summary,
  };
}

function createPlanId(): string {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
  return `vipp-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function createCandidateId(): string {
  return `vipc-${crypto.randomUUID().slice(0, 12)}`;
}

function createApprovalId(): string {
  return `vipa-${crypto.randomUUID().slice(0, 12)}`;
}

function normalizePlanRecord(
  value: unknown,
  fallbackId: string,
): VerifierBaselinePromotionPlanRecord {
  if (!isRecord(value) || !isRecord(value.candidate) || !isRecord(value.decision)) {
    throw new Error(`Invalid verifier promotion plan payload "${fallbackId}".`);
  }
  const candidate = normalizePromotionCandidate(value.candidate);
  const decision = normalizePromotionDecision(value.decision);
  return {
    planId: toNonEmptyString(value.planId) ?? fallbackId,
    createdAt: toNonEmptyString(value.createdAt) ?? new Date(0).toISOString(),
    baselineName: toNonEmptyString(value.baselineName) ?? candidate.baselineName,
    baselineId: toNullableString(value.baselineId),
    candidate,
    decision,
    approvalStatus: toApprovalStatus(value.approvalStatus) ?? "pending",
    approval: isRecord(value.approval)
      ? normalizePromotionApproval(value.approval)
      : null,
    appliedBaselineId: toNullableString(value.appliedBaselineId),
    appliedSnapshotId: toNullableString(value.appliedSnapshotId),
    appliedPromotionId: toNullableString(value.appliedPromotionId),
    handoffId: toNullableString(value.handoffId),
    policyInheritanceSource: toPolicyInheritanceSource(value.policyInheritanceSource)
      ?? candidate.policyInheritanceSource,
    baselineScope: isRecord(value.baselineScope)
      ? normalizeBaselineScope(value.baselineScope)
      : structuredClone(candidate.baselineScope),
    summary: toNonEmptyString(value.summary) ?? decision.summary,
  };
}

function normalizePromotionCandidate(
  value: Record<string, unknown>,
): VerifierBaselinePromotionCandidate {
  const source = isRecord(value.source) ? value.source : {};
  const targetReference = isRecord(value.targetReference) ? value.targetReference : {};
  return {
    candidateId: toNonEmptyString(value.candidateId) ?? createCandidateId(),
    createdAt: toNonEmptyString(value.createdAt) ?? new Date(0).toISOString(),
    baselineName: toNonEmptyString(value.baselineName) ?? "unknown",
    baselineId: toNullableString(value.baselineId),
    source: {
      sourceKind: source.sourceKind === "gate" || source.sourceKind === "eval" || source.sourceKind === "compare"
        ? source.sourceKind
        : "unknown",
      artifactKind: source.artifactKind === "compare" || source.artifactKind === "gate" || source.artifactKind === "eval"
        ? source.artifactKind
        : null,
      artifactId: toNullableString(source.artifactId),
      handoffId: toNullableString(source.handoffId),
      bundleId: toNullableString(source.bundleId),
      policyProfileId: toNullableString(source.policyProfileId),
      policyInheritanceSource: toPolicyInheritanceSource(source.policyInheritanceSource) ?? "default",
      baselineName: toNullableString(source.baselineName),
      summary: toNullableString(source.summary),
    },
    baselineScope: isRecord(value.baselineScope)
      ? normalizeBaselineScope(value.baselineScope)
      : createBaselineScope(
          toNonEmptyString(value.baselineName) ?? "unknown",
          {
            kind: "current",
            label: "current",
            reference: null,
            scope: "current",
            sessionId: null,
            traceId: null,
            replayReference: null,
            snapshotId: null,
            baselineName: null,
          },
        ),
    currentSnapshotId: toNullableString(value.currentSnapshotId),
    currentSummary: isRecord(value.currentSummary)
      ? cloneTyped<VerifierBaselinePromotionCandidate["currentSummary"]>(value.currentSummary)
      : null,
    targetReference: {
      kind: targetReference.kind === "current"
        || targetReference.kind === "trace"
        || targetReference.kind === "replay"
        || targetReference.kind === "snapshot"
        || targetReference.kind === "baseline"
        ? targetReference.kind
        : "current",
      label: toNonEmptyString(targetReference.label) ?? "current",
      reference: toNullableString(targetReference.reference),
      scope: targetReference.scope === "current" || targetReference.scope === "trace" || targetReference.scope === "replay"
        ? targetReference.scope
        : "current",
      sessionId: toNullableString(targetReference.sessionId),
      traceId: toNullableString(targetReference.traceId),
      replayReference: toNullableString(targetReference.replayReference),
      snapshotId: toNullableString(targetReference.snapshotId),
      baselineName: toNullableString(targetReference.baselineName),
    },
    targetSnapshotId: toNonEmptyString(value.targetSnapshotId) ?? "unknown",
    targetSummary: isRecord(value.targetSummary)
      ? cloneTyped<VerifierBaselinePromotionCandidate["targetSummary"]>(value.targetSummary)
      : cloneTyped<VerifierBaselinePromotionCandidate["targetSummary"]>({}),
    policyProfileId: toNullableString(value.policyProfileId),
    policyInheritanceSource: toPolicyInheritanceSource(value.policyInheritanceSource) ?? "default",
    summary: toNonEmptyString(value.summary) ?? "Verifier baseline promotion candidate.",
  };
}

function normalizePromotionDecision(
  value: Record<string, unknown>,
): VerifierBaselinePromotionDecision {
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter(isRecord).map((entry) => ({
        kind: toDecisionReasonKind(entry.kind) ?? "source_unsupported",
        severity: toDecisionReasonSeverity(entry.severity) ?? "info",
        summary: toNonEmptyString(entry.summary) ?? "Verifier baseline promotion decision reason.",
      }))
    : [];
  return {
    status: value.status === "eligible" ? "eligible" : "blocked",
    eligible: value.eligible === true,
    reasons,
    blockingEvidence: isRecord(value.blockingEvidence)
      ? cloneTyped<VerifierBaselinePromotionDecision["blockingEvidence"]>(value.blockingEvidence)
      : null,
    policyInheritanceSource: toPolicyInheritanceSource(value.policyInheritanceSource) ?? "default",
    baselineScope: isRecord(value.baselineScope)
      ? normalizeBaselineScope(value.baselineScope)
      : {
          channel: "unknown",
          branchScope: null,
        },
    eligibilityEvidence: isRecord(value.eligibilityEvidence)
      ? cloneTyped<VerifierBaselinePromotionDecision["eligibilityEvidence"]>(value.eligibilityEvidence)
      : {
          sourceKind: "unknown",
          sourceArtifactKind: null,
          sourceArtifactId: null,
          sourceHandoffId: null,
          sourceBundleId: null,
          sourcePass: null,
          sourceHasChanges: false,
          sourcePolicyProfileId: null,
          policyInheritanceSource: "default",
          baselineScope: {
            channel: "unknown",
            branchScope: null,
          },
          diagnosticErrorDelta: null,
          blockingDiagnosticIntroducedCount: null,
          gateFailureReasonKinds: [],
          evalFailedCount: null,
        },
    blockReason: toDecisionReasonKind(value.blockReason),
    summary: toNonEmptyString(value.summary) ?? "Verifier baseline promotion decision.",
  };
}

function normalizePromotionApproval(
  value: Record<string, unknown>,
): VerifierBaselinePromotionApprovalRecord {
  const actor = isRecord(value.actor)
    ? normalizeApprovalActor(value.actor)
    : createApprovalActor({
        kind: value.approverKind === "automation" || value.approverKind === "workflow"
          ? value.approverKind
          : "operator",
        id: toNullableString(value.approverId),
        displayName: null,
      });
  return {
    approvalId: toNonEmptyString(value.approvalId) ?? createApprovalId(),
    createdAt: toNonEmptyString(value.createdAt) ?? new Date(0).toISOString(),
    status: toApprovalStatus(value.status) ?? "pending",
    approverKind: actor.kind,
    approverId: actor.id,
    actor,
    source: toApprovalSource(value.source) ?? deriveApprovalSourceFromApproverKind(actor.kind),
    approvalMode: toApprovalMode(value.approvalMode) ?? "explicit_apply",
    policyInheritanceSource: toPolicyInheritanceSource(value.policyInheritanceSource) ?? "default",
    baselineScope: isRecord(value.baselineScope)
      ? normalizeBaselineScope(value.baselineScope)
      : {
          channel: "unknown",
          branchScope: null,
        },
    eligibilityEvidence: isRecord(value.eligibilityEvidence)
      ? cloneTyped<VerifierBaselinePromotionApprovalRecord["eligibilityEvidence"]>(value.eligibilityEvidence)
      : null,
    summary: toNonEmptyString(value.summary) ?? "Verifier baseline promotion approval.",
  };
}

function normalizeApprovalActor(
  value: Record<string, unknown>,
): VerifierBaselinePromotionApprovalActor {
  return createApprovalActor({
    kind: value.kind === "automation" || value.kind === "workflow"
      ? value.kind
      : "operator",
    id: toNullableString(value.id),
    displayName: toNullableString(value.displayName),
  });
}

function normalizeBaselineScope(
  value: Record<string, unknown>,
): VerifierBaselinePromotionBaselineScope {
  return {
    channel: toNonEmptyString(value.channel) ?? "unknown",
    branchScope: toNullableString(value.branchScope),
  };
}

function createApprovalActor(input: {
  kind: VerifierBaselinePromotionApproverKind;
  id: string | null;
  displayName: string | null;
}): VerifierBaselinePromotionApprovalActor {
  return {
    kind: input.kind,
    id: input.id,
    displayName: input.displayName,
  };
}

function createBaselineScope(
  baselineName: string,
  targetReference: VerifierInspectResolvedReference,
): VerifierBaselinePromotionBaselineScope {
  return {
    channel: baselineName,
    branchScope: targetReference.kind === "current"
      ? null
      : targetReference.label,
  };
}

function resolvePromotionPolicyProfile(input: {
  explicitPolicyProfileId: VerifierRegressionGatePolicyProfileId | null;
  baselinePolicyProfileId: VerifierRegressionGatePolicyProfileId | null;
  artifactPolicyProfileId: VerifierRegressionGatePolicyProfileId | null;
}): ResolvedPromotionPolicyProfile {
  if (input.explicitPolicyProfileId) {
    return {
      policyProfileId: input.explicitPolicyProfileId,
      inheritanceSource: "explicit",
    };
  }
  if (input.baselinePolicyProfileId) {
    return {
      policyProfileId: input.baselinePolicyProfileId,
      inheritanceSource: "baseline",
    };
  }
  if (input.artifactPolicyProfileId) {
    return {
      policyProfileId: input.artifactPolicyProfileId,
      inheritanceSource: "artifact",
    };
  }
  return {
    policyProfileId: "default",
    inheritanceSource: "default",
  };
}

function resolvePromotionBlockReason(
  reasons: VerifierBaselinePromotionDecisionReason[],
): VerifierBaselinePromotionDecisionReasonKind | null {
  return reasons.find((entry) => entry.severity === "failure")?.kind
    ?? reasons.find((entry) => entry.kind === "baseline_already_current")?.kind
    ?? null;
}

function deriveApprovalSourceFromApproverKind(
  approverKind: VerifierBaselinePromotionApproverKind,
): VerifierBaselinePromotionApprovalSource {
  if (approverKind === "workflow") {
    return "workflow_dispatch";
  }
  if (approverKind === "automation") {
    return "automation";
  }
  return "cli";
}

function createValueChange<T>(
  before: T,
  after: T,
): { before: T; after: T; changed: boolean } {
  return {
    before,
    after,
    changed: before !== after,
  };
}

function toApprovalStatus(
  value: unknown,
): VerifierBaselinePromotionApprovalStatus | null {
  return value === "pending" || value === "blocked" || value === "approved" || value === "applied"
    ? value
    : null;
}

function toApprovalSource(
  value: unknown,
): VerifierBaselinePromotionApprovalSource | null {
  return value === "cli"
    || value === "workflow_dispatch"
    || value === "schedule"
    || value === "pull_request"
    || value === "automation"
    ? value
    : null;
}

function toApprovalMode(
  value: unknown,
): VerifierBaselinePromotionApprovalMode | null {
  return value === "explicit_apply" || value === "workflow_apply"
    ? value
    : null;
}

function toPolicyInheritanceSource(
  value: unknown,
): VerifierBaselinePromotionPolicyInheritanceSource | null {
  return value === "explicit"
    || value === "baseline"
    || value === "artifact"
    || value === "default"
    ? value
    : null;
}

function toDecisionReasonKind(
  value: unknown,
): VerifierBaselinePromotionDecision["reasons"][number]["kind"] | null {
  return value === "source_unsupported"
    || value === "baseline_missing"
    || value === "baseline_already_current"
    || value === "gate_failed"
    || value === "eval_failed"
    || value === "policy_inherited"
    || value === "policy_overridden"
    || value === "ready_for_promotion"
    || value === "approval_required"
    || value === "approval_blocked"
    || value === "promotion_applied"
    ? value
    : null;
}

function toDecisionReasonSeverity(
  value: unknown,
): VerifierBaselinePromotionDecision["reasons"][number]["severity"] | null {
  return value === "failure" || value === "notice" || value === "info"
    ? value
    : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function cloneTyped<T>(value: unknown): T {
  return structuredClone(value) as T;
}
