import crypto from "node:crypto";

import {
  buildAgentDecisionReport,
} from "./agent-decision-inspect.mjs";
import {
  buildPlanCurrentReport as buildPlanCurrentInspectReport,
  buildPlanTimelineReport as buildPlanTimelineInspectReport,
  resolvePlanReference as resolvePlanInspectReference,
} from "./agent-plan-inspect.mjs";
import {
  buildSessionBrowserReport,
  buildSessionResumeRecommendationReport,
} from "./agent-session-browser.mjs";
import {
  buildCurrentVerifierInspectReport,
  buildReplayVerifierInspectReport,
  buildTraceVerifierInspectReport,
  compareVerifierInspectReports,
  createVerifierInspectResolvedReference,
  evaluateVerifierRegressionGate,
  listVerifierRegressionGatePolicyProfiles,
  resolveVerifierRegressionGatePolicyProfile,
} from "./agent-verifier-inspect.mjs";
import { VerifierBaselinePromotionStore } from "./agent-verifier-baseline-promotion.mjs";
import { applyVerifierGitHubMutation } from "./agent-verifier-github.mjs";
import { VerifierGitHubMutationStore } from "./agent-verifier-github-store.mjs";
import { VerifierInspectArtifactStore } from "./agent-verifier-inspect-artifact-store.mjs";
import { VerifierReleaseStore } from "./agent-verifier-release-store.mjs";
import {
  createVerifierGitHubChecksPayloadFromSelection,
  createVerifierReleaseTriageSummaryFromSelection,
} from "./agent-verifier-release-triage.mjs";
import { VerifierInspectSnapshotStore } from "./agent-verifier-inspect-store.mjs";
import { selectChangeSetDiff } from "./change-set.mjs";
import type { CapabilityRegistryLike } from "./capability-registry.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";
import { undoAgentChange } from "./agent-rollback-ops.mjs";

import type {
  AgentDecisionReport,
  ChangeSetRecord,
  DiagnosticFingerprint,
  EvalSuiteResult,
  EffectivePolicy,
  ExecutionPlan,
  RepairDirectiveFileGroup,
  RepairDirectiveItem,
  RepairLoopRecord,
  RollbackCheckpointListEntry,
  PlanCurrentReport,
  PlanTimelineReport,
  SessionBrowserReport,
  SessionIndexEntry,
  SessionReplay,
  SessionResumeRecommendationReport,
  SkillInfluenceEntry,
  SkillInspectRecord,
  SkillListEntry,
  TraceSummary,
  VerifierBaselinePromotionHistory,
  VerifierBaselinePromotionPlanRecord,
  VerifierDrilldownBlockingDiagnosticSummary,
  VerifierDrilldownCommandSuggestion,
  VerifierDrilldownReasonSummary,
  VerifierDrilldownReport,
  VerifierGitHubActionsBackfillInput,
  VerifierGitHubChecksPayload,
  VerifierGitHubMutationRecord,
  VerifierGitHubMutationSelection,
  VerifierEvalArtifactRecord,
  VerifierInspectArtifactList,
  VerifierInspectArtifactPruneResult,
  VerifierInspectArtifactRecord,
  VerifierInspectArtifactRetentionPolicy,
  VerifierInspectBaselineList,
  VerifierInspectBaselinePromotionRecord,
  VerifierInspectBaselineRecord,
  VerifierInspectCompareReport,
  VerifierInspectFinalOutcome,
  VerifierInspectReference,
  VerifierInspectReport,
  VerifierInspectResolvedReference,
  VerifierInspectSummary,
  VerifierInspectSnapshotList,
  VerifierInspectSnapshotRecord,
  VerifierReleaseAffectedFileSummary,
  VerifierReleaseBundleRecord,
  VerifierReleaseHandoffRecord,
  VerifierReleaseHandoffReasonSummary,
  VerifierReleaseHandoffSelection,
  VerifierReleaseTriageSummary,
  VerifierRegressionGateDecision,
  VerifierRegressionGatePolicy,
  VerifierRegressionGatePolicyProfile,
  VerifierRegressionGatePolicyProfileId,
  VerifierRegressionGatePolicyProfileList,
  VerifierSeverity,
  VerifierTimelineCommandSuggestion,
  VerifierTimelineContinuity,
  VerifierTimelineEvent,
  VerifierTimelineLinkedIds,
  VerifierTimelineReport,
  VerifierRunRecord,
} from "../types/contracts.js";

interface SourceRecordLike {
  sourceId: string;
  [key: string]: unknown;
}

interface SourceRegistryLike {
  sessionId: string | null;
  initialize(sessionId: string): Promise<void>;
  loadLatestFromSessions(sessionIds: string[]): Promise<unknown>;
  getLastPack(): unknown;
  listSources(limit?: number): SourceRecordLike[];
}

interface SessionStoreLike {
  listSessions(limit: number): Promise<SessionIndexEntry[]>;
  append(type: string, payload?: unknown): Promise<unknown>;
  buildReplay(reference: string): Promise<SessionReplay>;
}

interface ProviderLike {
  listModels?(options?: Record<string, unknown>): Promise<string[]>;
}

interface SkillLoaderLike {
  getInfluenceSummary(): SkillInfluenceEntry[];
  listSkills(): SkillListEntry[];
  inspectSkill(skillId: string): SkillInspectRecord | null;
  enableSkill(skillId: string): Promise<SkillInspectRecord>;
  disableSkill(skillId: string): Promise<SkillInspectRecord>;
}

interface PluginLoaderLike {
  listPlugins(): unknown[];
  inspectPlugin(pluginId: string): unknown;
  enablePlugin(pluginId: string): Promise<unknown>;
  disablePlugin(pluginId: string): Promise<unknown>;
}

interface McpRegistryLike {
  listServers(): unknown[];
  listTools(): unknown[];
  inspectServer(serverId: string): unknown;
  testServer(serverId: string): Promise<unknown>;
}

interface RuntimeHealthLike {
  getOverview(): unknown;
  listCircuits(layer?: "all"): unknown;
  inspectLayer(layer: string): unknown;
}

interface MemoryStoreLike {
  listSnapshot(): Promise<unknown>;
  search(query: string, options?: {
    scopes?: string[];
    limit?: number;
  }): Promise<unknown>;
  remember(input: Record<string, unknown>): Promise<{
    id: string;
    scope: string;
    kind?: string;
    summary?: string;
    source?: string;
  }>;
}

interface ContextManagerLike {
  compact(messages: unknown[]): {
    messages: unknown[];
    compactedMessages: number;
    rollingSummary: string;
  };
  reset(): void;
}

interface PolicyStackLike {
  getEffectivePolicy(): EffectivePolicy;
}

interface RollbackStoreLike {
  rollback(
    changeSetId: string,
    options?: {
      sessionId?: string | null;
      traceId?: string | null;
    },
  ): Promise<{
    changeSetId: string;
    restorePointId: string | null;
    rolledBack: boolean;
    partial: boolean;
    results: Array<Record<string, unknown>>;
    errors: Array<Record<string, unknown>>;
  }>;
  listCheckpoints(limit?: number): Promise<RollbackCheckpointListEntry[]>;
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "recordPhase" | "readEntries" | "loadLatestSnapshot">;

interface ShellRuntimeLike {
  listJobs(status?: string | null, limit?: number): Promise<unknown>;
  cancelJob(jobId: string): Promise<unknown>;
  tailJob(jobId: string, options?: unknown): Promise<unknown>;
  getShellHistory(limit?: number): Promise<unknown>;
  attachJob(jobId: string, options?: unknown): Promise<unknown>;
}

interface ProviderRuntimeStatsLike {
  lastEvent: unknown;
}

export interface AgentCommandSurfaceTarget {
  config: {
    projectStateDir: string;
    provider: string | null;
    model: string | null;
    permissionMode: string;
    approvalPolicy: string;
    networkMode: string;
    webProvider: string;
    webRankingMode?: string;
    webAllowDomains?: unknown;
    webDenyDomains?: unknown;
    mcpEnabled?: boolean;
  };
  provider: ProviderLike;
  providerRuntimeStats: ProviderRuntimeStatsLike;
  sessionId: string | null;
  sessionStore: SessionStoreLike;
  sourceRegistry: SourceRegistryLike;
  capabilityRegistry: CapabilityRegistryLike;
  policyStack: PolicyStackLike;
  skillLoader: SkillLoaderLike;
  pluginLoader: PluginLoaderLike;
  mcpRegistry: McpRegistryLike;
  runtimeHealth: RuntimeHealthLike;
  memoryStore: MemoryStoreLike;
  contextManager: ContextManagerLike;
  shellRuntime: ShellRuntimeLike;
  rollbackStore: RollbackStoreLike;
  executionJournal: ExecutionJournalLike;
  messages: unknown[];
  lastTrace: TraceSummary | null;
  lastChangeSet: ChangeSetRecord | null;
  lastTaskClassification: unknown;
  lastRouteDecision: unknown;
  lastModelDecision: unknown;
  lastExecutionPlan: ExecutionPlan | null;
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
  rebuildCapabilitySurface(): void;
  refreshSystemPrompt(): void;
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): Promise<string>;
}

export async function getAgentPlanCurrent(
  target: Pick<AgentCommandSurfaceTarget, "executionJournal" | "lastExecutionPlan" | "lastTrace" | "sessionId" | "sessionStore">,
): Promise<PlanCurrentReport> {
  const resolved = await resolvePlanInspectReference(target, "current");
  return buildPlanCurrentInspectReport(resolved.source, resolved.plan);
}

export async function getAgentPlanTimeline(
  target: Pick<AgentCommandSurfaceTarget, "executionJournal" | "lastExecutionPlan" | "lastTrace" | "sessionId" | "sessionStore">,
  reference: string = "current",
): Promise<PlanTimelineReport> {
  const resolved = await resolvePlanInspectReference(target, reference);
  return buildPlanTimelineInspectReport(resolved.source, resolved.plan);
}

export async function explainAgentDecision(
  target: Pick<
    AgentCommandSurfaceTarget,
    | "config"
    | "executionJournal"
    | "lastChangeSet"
    | "lastExecutionPlan"
    | "lastModelDecision"
    | "lastRepairLoop"
    | "lastRouteDecision"
    | "lastTaskClassification"
    | "lastTrace"
    | "lastVerifierRun"
    | "runtimeHealth"
    | "sessionId"
    | "sessionStore"
  >,
  scope: AgentDecisionReport["scope"] = "overview",
  reference: string = "current",
): Promise<AgentDecisionReport> {
  return buildAgentDecisionReport(target, scope, reference);
}

export async function getAgentDecisionNext(
  target: Pick<
    AgentCommandSurfaceTarget,
    | "config"
    | "executionJournal"
    | "lastChangeSet"
    | "lastExecutionPlan"
    | "lastModelDecision"
    | "lastRepairLoop"
    | "lastRouteDecision"
    | "lastTaskClassification"
    | "lastTrace"
    | "lastVerifierRun"
    | "runtimeHealth"
    | "sessionId"
    | "sessionStore"
  >,
  reference: string = "current",
): Promise<AgentDecisionReport> {
  return buildAgentDecisionReport(target, "overview", reference);
}

export async function getAgentDecisionRecovery(
  target: Pick<
    AgentCommandSurfaceTarget,
    | "config"
    | "executionJournal"
    | "lastChangeSet"
    | "lastExecutionPlan"
    | "lastModelDecision"
    | "lastRepairLoop"
    | "lastRouteDecision"
    | "lastTaskClassification"
    | "lastTrace"
    | "lastVerifierRun"
    | "runtimeHealth"
    | "sessionId"
    | "sessionStore"
  >,
  reference: string = "current",
): Promise<AgentDecisionReport> {
  return buildAgentDecisionReport(target, "overview", reference);
}

export async function getAgentMemorySnapshot(
  target: AgentCommandSurfaceTarget,
): Promise<unknown> {
  return target.memoryStore.listSnapshot();
}

export async function getAgentVerifierReport(
  target: Pick<AgentCommandSurfaceTarget, "executionJournal" | "lastRepairLoop" | "lastTrace" | "lastVerifierRun" | "sessionId">,
  which: "current" | "trace" = "current",
): Promise<VerifierInspectReport> {
  if (which === "trace") {
    const entries = target.sessionId
      ? await target.executionJournal.readEntries(target.sessionId).catch(() => [])
      : [];
    return buildTraceVerifierInspectReport({
      sessionId: target.sessionId,
      lastTrace: target.lastTrace,
      lastVerifierRun: target.lastVerifierRun,
      lastRepairLoop: target.lastRepairLoop,
      entries,
    });
  }

  return buildCurrentVerifierInspectReport({
    sessionId: target.sessionId,
    lastTrace: target.lastTrace,
    lastVerifierRun: target.lastVerifierRun,
    lastRepairLoop: target.lastRepairLoop,
  });
}

export async function inspectAgentVerifierReplay(
  target: Pick<AgentCommandSurfaceTarget, "sessionStore">,
  reference: string,
): Promise<VerifierInspectReport> {
  const replay = await target.sessionStore.buildReplay(reference);
  return buildReplayVerifierInspectReport(replay);
}

async function resolveVerifierGatePolicyProfileForInput(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  left: VerifierInspectReference,
  policy: VerifierRegressionGatePolicy | undefined,
  profileId: VerifierRegressionGatePolicyProfileId | null,
): Promise<VerifierRegressionGatePolicyProfile> {
  if (policy) {
    return resolveVerifierRegressionGatePolicyProfile({
      profileId,
      policy,
    });
  }
  if (profileId) {
    return resolveVerifierRegressionGatePolicyProfile({ profileId });
  }
  if (left.kind === "baseline") {
    const store = new VerifierInspectSnapshotStore(target.config.projectStateDir);
    const baseline = await store.loadBaseline(left);
    return resolveVerifierRegressionGatePolicyProfile({
      profileId: baseline.metadata.policyProfileId ?? "default",
    });
  }
  return resolveVerifierRegressionGatePolicyProfile({ profileId: "default" });
}

export async function exportAgentVerifierSnapshot(
  target: Pick<AgentCommandSurfaceTarget, "config" | "executionJournal" | "lastRepairLoop" | "lastTrace" | "lastVerifierRun" | "sessionId" | "sessionStore">,
  reference: VerifierInspectReference = { kind: "current", reference: null },
): Promise<VerifierInspectSnapshotRecord> {
  const resolved = await resolveAgentVerifierReference(target, reference);
  const store = new VerifierInspectSnapshotStore(target.config.projectStateDir);
  const snapshot = await store.exportSnapshot({
    source: resolved.reference,
    report: resolved.report,
  });
  await target.sessionStore.append("verifier_inspect_export", {
    snapshotId: snapshot.metadata.snapshotId,
    createdAt: snapshot.metadata.createdAt,
    source: snapshot.metadata.source,
    summary: snapshot.metadata.summary,
  });
  return snapshot;
}

export async function listAgentVerifierSnapshots(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  limit = 20,
): Promise<VerifierInspectSnapshotList> {
  const store = new VerifierInspectSnapshotStore(target.config.projectStateDir);
  return store.listSnapshots(limit);
}

export async function pinAgentVerifierBaseline(
  target: Pick<AgentCommandSurfaceTarget, "config" | "executionJournal" | "lastRepairLoop" | "lastTrace" | "lastVerifierRun" | "sessionId" | "sessionStore">,
  reference: VerifierInspectReference,
  name: string,
  options: {
    policyProfileId?: VerifierRegressionGatePolicyProfileId | null;
  } = {},
): Promise<VerifierInspectBaselineRecord> {
  const store = new VerifierInspectSnapshotStore(target.config.projectStateDir);
  const snapshot = reference.kind === "snapshot"
    ? await store.loadSnapshot(reference)
    : await exportAgentVerifierSnapshot(target, reference);
  const { baseline, promotion } = await store.pinBaseline({
    name,
    snapshot,
    policyProfileId: options.policyProfileId ?? null,
  });
  if (promotion) {
    const releaseStore = new VerifierReleaseStore(target.config.projectStateDir);
    const handoff = await releaseStore.writeBaselinePromotionHandoff({
      baseline,
      promotion,
    });
    await target.sessionStore.append("verifier_release_handoff", {
      handoffId: handoff.metadata.handoffId,
      createdAt: handoff.metadata.createdAt,
      sourceKind: handoff.metadata.sourceKind,
      summary: handoff.summary,
      baselineName: handoff.baselineName,
      baselinePromotionId: handoff.baselinePromotionId,
    });
  }
  await target.sessionStore.append("verifier_inspect_baseline_pin", {
    baselineId: baseline.metadata.baselineId,
    name: baseline.metadata.name,
    createdAt: baseline.metadata.createdAt,
    updatedAt: baseline.metadata.updatedAt,
    snapshotId: baseline.metadata.snapshotId,
    policyProfileId: baseline.metadata.policyProfileId,
    source: baseline.metadata.source,
    summary: baseline.metadata.summary,
    promotion,
  });
  return baseline;
}

export async function listAgentVerifierBaselines(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  limit = 20,
): Promise<VerifierInspectBaselineList> {
  const store = new VerifierInspectSnapshotStore(target.config.projectStateDir);
  return store.listBaselines(limit);
}

export async function planAgentVerifierBaselinePromotion(
  target: Pick<AgentCommandSurfaceTarget, "config" | "sessionStore">,
  baselineName: string,
  reference: string = "latest",
  options: {
    policyProfileId?: VerifierRegressionGatePolicyProfileId | null;
  } = {},
): Promise<VerifierBaselinePromotionPlanRecord> {
  const store = new VerifierBaselinePromotionStore(target.config.projectStateDir);
  const plan = await store.createPlan({
    baselineName,
    reference,
    policyProfileId: options.policyProfileId ?? null,
  });
  await target.sessionStore.append("verifier_baseline_promotion_plan", {
    planId: plan.planId,
    baselineName: plan.baselineName,
    sourceArtifactId: plan.candidate.source.artifactId,
    sourceKind: plan.candidate.source.sourceKind,
    targetSnapshotId: plan.candidate.targetSnapshotId,
    decisionStatus: plan.decision.status,
    approvalStatus: plan.approvalStatus,
    summary: plan.summary,
  });
  return plan;
}

export async function approveAgentVerifierBaselinePromotion(
  target: Pick<AgentCommandSurfaceTarget, "config" | "sessionStore">,
  reference: string,
  options: {
    approverKind?: "operator" | "automation" | "workflow";
    approverId?: string | null;
    approvalSource?: "cli" | "workflow_dispatch" | "schedule" | "pull_request" | "automation";
    approvalMode?: "explicit_apply" | "workflow_apply";
    approverDisplayName?: string | null;
  } = {},
): Promise<VerifierBaselinePromotionPlanRecord> {
  const store = new VerifierBaselinePromotionStore(target.config.projectStateDir);
  const plan = await store.approvePlan({
    reference,
    approverKind: options.approverKind,
    approverId: options.approverId ?? null,
    approvalSource: options.approvalSource,
    approvalMode: options.approvalMode,
    approverDisplayName: options.approverDisplayName ?? null,
  });
  await target.sessionStore.append("verifier_baseline_promotion_apply", {
    planId: plan.planId,
    baselineName: plan.baselineName,
    approvalStatus: plan.approvalStatus,
    appliedSnapshotId: plan.appliedSnapshotId,
    appliedPromotionId: plan.appliedPromotionId,
    handoffId: plan.handoffId,
    summary: plan.summary,
  });
  return plan;
}

export async function listAgentVerifierBaselinePromotionHistory(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  baselineName: string,
): Promise<VerifierBaselinePromotionHistory> {
  const store = new VerifierBaselinePromotionStore(target.config.projectStateDir);
  return store.listHistory(baselineName);
}

export async function compareAgentVerifierReports(
  target: Pick<AgentCommandSurfaceTarget, "config" | "executionJournal" | "lastRepairLoop" | "lastTrace" | "lastVerifierRun" | "sessionId" | "sessionStore">,
  left: VerifierInspectReference,
  right: VerifierInspectReference,
  options: {
    writeArtifact?: boolean;
    writeBundle?: boolean;
  } = {},
): Promise<VerifierInspectCompareReport> {
  const [resolvedLeft, resolvedRight] = await Promise.all([
    resolveAgentVerifierReference(target, left),
    resolveAgentVerifierReference(target, right),
  ]);
  const report = compareVerifierInspectReports({
    leftReference: resolvedLeft.reference,
    leftReport: resolvedLeft.report,
    rightReference: resolvedRight.reference,
    rightReport: resolvedRight.report,
  });
  if (options.writeArtifact || options.writeBundle) {
    const artifactStore = new VerifierInspectArtifactStore(target.config.projectStateDir);
    const artifact = await artifactStore.writeCompareArtifact(report);
    report.artifact = structuredClone(artifact.metadata);
    const releaseStore = new VerifierReleaseStore(target.config.projectStateDir);
    const handoff = await releaseStore.writeArtifactHandoff(artifact);
    report.handoff = structuredClone(handoff.metadata);
    if (options.writeBundle) {
      const bundle = await releaseStore.exportBundleForArtifact(artifact);
      report.bundle = structuredClone(bundle.metadata);
    }
    await target.sessionStore.append("verifier_inspect_compare_artifact", {
      artifactId: artifact.metadata.artifactId,
      createdAt: artifact.metadata.createdAt,
      kind: artifact.metadata.kind,
      summary: artifact.metadata.summary,
      hasChanges: artifact.metadata.hasChanges,
      sourceReferences: artifact.metadata.sourceReferences,
    });
    await target.sessionStore.append("verifier_release_handoff", {
      handoffId: handoff.metadata.handoffId,
      createdAt: handoff.metadata.createdAt,
      sourceKind: handoff.metadata.sourceKind,
      primaryArtifactId: handoff.metadata.primaryArtifactId,
      summary: handoff.summary,
      bundleId: report.bundle?.bundleId ?? null,
    });
  }
  return report;
}

export async function gateAgentVerifierReports(
  target: Pick<AgentCommandSurfaceTarget, "config" | "executionJournal" | "lastRepairLoop" | "lastTrace" | "lastVerifierRun" | "sessionId" | "sessionStore">,
  left: VerifierInspectReference,
  right: VerifierInspectReference,
  policy?: VerifierRegressionGatePolicy,
  options: {
    profileId?: VerifierRegressionGatePolicyProfileId | null;
    writeArtifact?: boolean;
    writeBundle?: boolean;
  } = {},
): Promise<VerifierRegressionGateDecision> {
  const compare = await compareAgentVerifierReports(target, left, right);
  const profile = await resolveVerifierGatePolicyProfileForInput(target, left, policy, options.profileId ?? null);
  const decision = evaluateVerifierRegressionGate(
    profile.builtin
      ? {
          compare,
          profileId: profile.id,
        }
      : {
          compare,
          profileId: profile.id,
          policy: profile.policy,
        },
  );
  if (options.writeArtifact || options.writeBundle) {
    const artifactStore = new VerifierInspectArtifactStore(target.config.projectStateDir);
    const artifact = await artifactStore.writeGateArtifact(decision);
    decision.artifact = structuredClone(artifact.metadata);
    const releaseStore = new VerifierReleaseStore(target.config.projectStateDir);
    const handoff = await releaseStore.writeArtifactHandoff(artifact);
    decision.handoff = structuredClone(handoff.metadata);
    if (options.writeBundle) {
      const bundle = await releaseStore.exportBundleForArtifact(artifact);
      decision.bundle = structuredClone(bundle.metadata);
    }
    await target.sessionStore.append("verifier_inspect_gate_artifact", {
      artifactId: artifact.metadata.artifactId,
      createdAt: artifact.metadata.createdAt,
      kind: artifact.metadata.kind,
      summary: artifact.metadata.summary,
      pass: artifact.metadata.pass,
      policyProfileId: artifact.metadata.policyProfileId,
      sourceReferences: artifact.metadata.sourceReferences,
    });
    await target.sessionStore.append("verifier_release_handoff", {
      handoffId: handoff.metadata.handoffId,
      createdAt: handoff.metadata.createdAt,
      sourceKind: handoff.metadata.sourceKind,
      primaryArtifactId: handoff.metadata.primaryArtifactId,
      summary: handoff.summary,
      bundleId: decision.bundle?.bundleId ?? null,
    });
  }
  return decision;
}

export async function listAgentVerifierGatePolicyProfiles(): Promise<VerifierRegressionGatePolicyProfileList> {
  return listVerifierRegressionGatePolicyProfiles();
}

export async function listAgentVerifierArtifacts(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  limit = 20,
): Promise<VerifierInspectArtifactList> {
  const store = new VerifierInspectArtifactStore(target.config.projectStateDir);
  return store.listArtifacts(limit);
}

export async function inspectAgentVerifierArtifact(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  artifactId: string,
): Promise<VerifierInspectArtifactRecord> {
  const store = new VerifierInspectArtifactStore(target.config.projectStateDir);
  return store.loadArtifact(artifactId);
}

export async function inspectAgentVerifierHandoff(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  reference: string = "latest",
): Promise<VerifierReleaseHandoffSelection> {
  const store = new VerifierReleaseStore(target.config.projectStateDir);
  return store.loadHandoff(reference);
}

export async function summarizeAgentVerifierReleaseTriage(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  reference: string = "latest",
  options: {
    githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null;
  } = {},
): Promise<VerifierReleaseTriageSummary> {
  const store = new VerifierReleaseStore(target.config.projectStateDir);
  const selection = options.githubActionsBackfill
    ? await store.backfillGitHubActionsMetadata(reference, options.githubActionsBackfill)
    : await store.loadHandoff(reference);
  const mutationStore = new VerifierGitHubMutationStore(target.config.projectStateDir);
  const githubMutation = selection.handoff
    ? await mutationStore.findLatestByHandoffId(selection.handoff.metadata.handoffId)
    : null;
  return createVerifierReleaseTriageSummaryFromSelection(selection, {
    githubMutation,
  });
}

export async function exportAgentVerifierGitHubChecksPayload(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  reference: string = "latest",
  options: {
    githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null;
    name?: string | null;
  } = {},
): Promise<VerifierGitHubChecksPayload> {
  const store = new VerifierReleaseStore(target.config.projectStateDir);
  const selection = options.githubActionsBackfill
    ? await store.backfillGitHubActionsMetadata(reference, options.githubActionsBackfill)
    : await store.loadHandoff(reference);
  const mutationStore = new VerifierGitHubMutationStore(target.config.projectStateDir);
  const githubMutation = selection.handoff
    ? await mutationStore.findLatestByHandoffId(selection.handoff.metadata.handoffId)
    : null;
  return createVerifierGitHubChecksPayloadFromSelection(selection, {
    name: options.name ?? null,
    githubMutation,
  });
}

export async function applyAgentVerifierGitHubMutation(
  target: Pick<AgentCommandSurfaceTarget, "config" | "sessionStore">,
  reference: string = "latest",
  options: {
    githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<VerifierGitHubMutationRecord> {
  const releaseStore = new VerifierReleaseStore(target.config.projectStateDir);
  const selection = options.githubActionsBackfill
    ? await releaseStore.backfillGitHubActionsMetadata(reference, options.githubActionsBackfill)
    : await releaseStore.loadHandoff(reference);
  const mutationStore = new VerifierGitHubMutationStore(target.config.projectStateDir);
  const existing = selection.handoff
    ? await mutationStore.findLatestByHandoffId(selection.handoff.metadata.handoffId)
    : null;
  const payload = createVerifierGitHubChecksPayloadFromSelection(selection, {
    githubMutation: existing,
  });
  const result = await applyVerifierGitHubMutation({
    reference,
    payload,
    existing,
    env: options.env,
  });
  const persisted = await mutationStore.writeResult(result);
  await target.sessionStore.append("verifier_github_mutation", {
    mutationId: persisted.mutationId,
    status: persisted.status,
    reasonKind: persisted.reasonKind,
    handoffId: persisted.handoffId,
    summary: persisted.summary,
    checkRunId: persisted.response?.checkRunId ?? null,
  });
  return persisted;
}

export async function inspectAgentVerifierGitHubMutation(
  target: Pick<AgentCommandSurfaceTarget, "config">,
  reference: string = "latest",
): Promise<VerifierGitHubMutationSelection> {
  const store = new VerifierGitHubMutationStore(target.config.projectStateDir);
  return store.loadResult(reference);
}

export async function drilldownAgentVerifier(
  target: Pick<AgentCommandSurfaceTarget, "config" | "executionJournal" | "lastRepairLoop" | "lastTrace" | "lastVerifierRun" | "sessionId" | "sessionStore">,
  reference: string = "latest",
  options: {
    githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null;
  } = {},
): Promise<VerifierDrilldownReport> {
  const inspectReference = tryParseVerifierDrilldownInspectReference(reference);
  if (inspectReference) {
    const resolved = await resolveAgentVerifierReference(target, inspectReference);
    return createVerifierInspectDrilldownReport(reference, resolved.reference, resolved.report);
  }

  const releaseStore = new VerifierReleaseStore(target.config.projectStateDir);
  const selection = options.githubActionsBackfill
    ? await releaseStore.backfillGitHubActionsMetadata(reference, options.githubActionsBackfill)
    : await releaseStore.loadHandoff(reference);
  const mutationStore = new VerifierGitHubMutationStore(target.config.projectStateDir);
  const githubMutation = selection.handoff
    ? await mutationStore.findLatestByHandoffId(selection.handoff.metadata.handoffId)
    : null;
  const triage = createVerifierReleaseTriageSummaryFromSelection(selection, {
    githubMutation,
  });
  return createVerifierReleaseDrilldownReport(reference, selection, triage, githubMutation);
}

export async function timelineAgentVerifier(
  target: Pick<AgentCommandSurfaceTarget, "config" | "executionJournal" | "lastRepairLoop" | "lastTrace" | "lastVerifierRun" | "sessionId" | "sessionStore">,
  reference: string = "latest",
  options: {
    githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null;
  } = {},
): Promise<VerifierTimelineReport> {
  const inspectReference = tryParseVerifierDrilldownInspectReference(reference);
  if (inspectReference) {
    const resolved = await resolveAgentVerifierReference(target, inspectReference);
    const focus = createVerifierInspectDrilldownReport(reference, resolved.reference, resolved.report);
    return createVerifierInspectTimelineReport(reference, resolved.reference, resolved.report, focus);
  }

  const releaseStore = new VerifierReleaseStore(target.config.projectStateDir);
  const selection = options.githubActionsBackfill
    ? await releaseStore.backfillGitHubActionsMetadata(reference, options.githubActionsBackfill)
    : await releaseStore.loadHandoff(reference);
  const mutationStore = new VerifierGitHubMutationStore(target.config.projectStateDir);
  const githubMutation = selection.handoff
    ? await mutationStore.findLatestByHandoffId(selection.handoff.metadata.handoffId)
    : null;
  const triage = createVerifierReleaseTriageSummaryFromSelection(selection, {
    githubMutation,
  });
  const focus = createVerifierReleaseDrilldownReport(reference, selection, triage, githubMutation);
  const artifactStore = new VerifierInspectArtifactStore(target.config.projectStateDir);
  const artifact = triage.primaryArtifactId
    ? await artifactStore.loadArtifact(triage.primaryArtifactId).catch(() => null)
    : null;
  const promotionStore = new VerifierBaselinePromotionStore(target.config.projectStateDir);
  const promotionHistory = triage.baselineName
    ? await promotionStore.listHistory(triage.baselineName).catch(() => null)
    : null;
  const bundle = selection.handoff?.metadata.bundleId
    ? await releaseStore.loadBundle(selection.handoff.metadata.bundleId).catch(() => null)
    : null;
  return createVerifierReleaseTimelineReport({
    reference,
    selection,
    triage,
    githubMutation,
    focus,
    artifact,
    promotionHistory,
    bundle,
  });
}

export async function exportAgentVerifierBundle(
  target: Pick<AgentCommandSurfaceTarget, "config" | "sessionStore">,
  reference: string = "latest",
): Promise<VerifierReleaseBundleRecord> {
  const store = new VerifierReleaseStore(target.config.projectStateDir);
  const bundle = await store.exportBundle(reference);
  await target.sessionStore.append("verifier_release_bundle", {
    bundleId: bundle.metadata.bundleId,
    createdAt: bundle.metadata.createdAt,
    handoffId: bundle.metadata.handoffId,
    primaryArtifactId: bundle.metadata.primaryArtifactId,
    sourceKind: bundle.metadata.sourceKind,
    bundlePath: bundle.metadata.bundlePath,
    summary: bundle.metadata.summary,
  });
  return bundle;
}

export async function pruneAgentVerifierArtifacts(
  target: Pick<AgentCommandSurfaceTarget, "config" | "sessionStore">,
  policy: Partial<VerifierInspectArtifactRetentionPolicy> = {},
): Promise<VerifierInspectArtifactPruneResult> {
  const store = new VerifierReleaseStore(target.config.projectStateDir);
  const result = await store.pruneArtifacts(policy);
  await target.sessionStore.append("verifier_artifact_prune", {
    policy: result.policy,
    dryRun: result.dryRun,
    keptCount: result.keptCount,
    deletedCount: result.deletedCount,
    summary: result.summary,
  });
  return result;
}

function tryParseVerifierDrilldownInspectReference(
  reference: string,
): VerifierInspectReference | null {
  const normalized = `${reference ?? ""}`.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "current") {
    return { kind: "current", reference: null };
  }
  if (normalized === "trace") {
    return { kind: "trace", reference: null };
  }
  if (normalized.startsWith("replay:")) {
    const replayReference = normalized.slice("replay:".length).trim();
    return replayReference
      ? { kind: "replay", reference: replayReference }
      : null;
  }
  if (normalized.startsWith("snapshot:")) {
    const snapshotReference = normalized.slice("snapshot:".length).trim();
    return snapshotReference
      ? { kind: "snapshot", reference: snapshotReference }
      : null;
  }
  if (normalized.startsWith("baseline:")) {
    const baselineReference = normalized.slice("baseline:".length).trim();
    return baselineReference
      ? { kind: "baseline", reference: baselineReference }
      : null;
  }
  return null;
}

function createVerifierInspectDrilldownReport(
  reference: string,
  resolvedReference: VerifierInspectResolvedReference,
  report: VerifierInspectReport,
): VerifierDrilldownReport {
  const topReasons = collectInspectDrilldownReasons(report);
  const topAffectedFiles = collectInspectDrilldownAffectedFiles(report);
  const blockingDiagnostics = collectInspectDrilldownBlockingDiagnostics(report);
  const recommendedCommands = createInspectDrilldownRecommendations(resolvedReference, report, blockingDiagnostics);
  return {
    available: true,
    reason: null,
    createdAt: new Date().toISOString(),
    sourceKind: "inspect",
    reference,
    inspectReference: structuredClone(resolvedReference),
    releaseReference: null,
    policyProfileId: null,
    handoffSourceKind: "inspect",
    handoffStatus: "inspect",
    promotionStatus: "unavailable",
    finalOutcome: report.summary.finalOutcome,
    latestVerifierStatus: report.summary.latestVerifierStatus,
    latestRepairStatus: report.summary.latestRepairStatus,
    primaryArtifactId: null,
    handoffId: null,
    bundleId: null,
    latestArtifactId: null,
    latestGateArtifactId: null,
    latestEvalArtifactId: null,
    topReasons,
    topAffectedFiles,
    blockingDiagnostics,
    githubMutation: null,
    recommendedCommands,
    summary: topReasons.length > 0
      ? `Verifier drilldown for ${resolvedReference.label} shows ${topReasons.length} top issue(s) across ${topAffectedFiles.length} file group(s).`
      : `Verifier drilldown for ${resolvedReference.label} has no blocking verifier issues recorded.`,
  };
}

function createVerifierReleaseDrilldownReport(
  reference: string,
  selection: VerifierReleaseHandoffSelection,
  triage: VerifierReleaseTriageSummary,
  githubMutation: VerifierGitHubMutationRecord | null,
): VerifierDrilldownReport {
  const topReasons = [
    ...triage.topReasons.map((entry) => toDrilldownReasonFromHandoff(entry)),
    ...toDrilldownReasonFromGitHubMutation(githubMutation),
  ].slice(0, 5);
  const blockingDiagnostics = triage.blockingDiagnostics
    ? {
        available: true,
        comparable: triage.blockingDiagnostics.comparable,
        summary: triage.blockingDiagnostics.summary,
        currentCount: triage.blockingDiagnostics.introducedCount + triage.blockingDiagnostics.persistedCount,
        introducedCount: triage.blockingDiagnostics.introducedCount,
        persistedCount: triage.blockingDiagnostics.persistedCount,
        resolvedCount: triage.blockingDiagnostics.resolvedCount,
        current: [
          ...triage.blockingDiagnostics.introduced.map((entry) => structuredClone(entry)),
          ...triage.blockingDiagnostics.persisted.map((entry) => structuredClone(entry)),
        ],
        introduced: triage.blockingDiagnostics.introduced.map((entry) => structuredClone(entry)),
        persisted: triage.blockingDiagnostics.persisted.map((entry) => structuredClone(entry)),
        resolved: triage.blockingDiagnostics.resolved.map((entry) => structuredClone(entry)),
      } satisfies VerifierDrilldownBlockingDiagnosticSummary
    : null;
  const recommendedCommands = createReleaseDrilldownRecommendations(reference, triage, githubMutation);
  return {
    available: triage.available,
    reason: triage.reason,
    createdAt: triage.createdAt,
    sourceKind: "release",
    reference,
    inspectReference: null,
    releaseReference: selection.reference,
    policyProfileId: triage.policyProfileId,
    handoffSourceKind: triage.available ? triage.sourceKind : "unavailable",
    handoffStatus: triage.available ? triage.status : "unavailable",
    promotionStatus: triage.promotionStatus,
    finalOutcome: triage.finalOutcome,
    latestVerifierStatus: triage.latestVerifierStatus,
    latestRepairStatus: triage.latestRepairStatus,
    primaryArtifactId: triage.primaryArtifactId,
    handoffId: triage.handoffId,
    bundleId: triage.bundleId,
    latestArtifactId: selection.latestArtifactId,
    latestGateArtifactId: selection.latestGateArtifactId,
    latestEvalArtifactId: selection.latestEvalArtifactId,
    topReasons,
    topAffectedFiles: triage.topAffectedFiles.map((entry) => structuredClone(entry)),
    blockingDiagnostics,
    githubMutation: githubMutation ? structuredClone(githubMutation) : null,
    recommendedCommands,
    summary: triage.summary,
  };
}

function collectInspectDrilldownReasons(
  report: VerifierInspectReport,
): VerifierDrilldownReasonSummary[] {
  const latestAttempt = report.latest.repairLoop?.attempts.at(-1) ?? null;
  if (latestAttempt?.directive?.items && latestAttempt.directive.items.length > 0) {
    return latestAttempt.directive.items
      .slice()
      .sort(compareInspectDirectiveItems)
      .slice(0, 5)
      .map((item) => ({
        kind: item.category ?? item.kind,
        severity: toDrilldownSeverity(item.severity),
        source: "inspect",
        path: item.path,
        summary: `${formatDrilldownLocation(item.path, item.line, item.column)}${item.code ? ` ${item.code}` : ""} ${item.message}`.trim(),
      }));
  }
  const failedRun = findLatestFailedVerifierRunForDrilldown(report);
  if (!failedRun) {
    return [];
  }
  const reasons = failedRun.checks
    .filter((check) => check.status === "failed")
    .flatMap((check) => {
      const failedFindings = check.findings.filter((entry) => entry.status === "failed");
      if (failedFindings.length === 0) {
        return [{
          kind: check.category ?? check.kind,
          severity: "failure" as const,
          source: "inspect" as const,
          path: check.filePath ?? null,
          summary: `${formatDrilldownLocation(check.filePath ?? null, null, null)} ${check.summary}`.trim(),
        }];
      }
      return failedFindings.map((finding) => ({
        kind: finding.category ?? finding.kind,
        severity: toDrilldownSeverity(finding.severity),
        source: "inspect" as const,
        path: finding.path ?? check.filePath ?? null,
        summary: `${formatDrilldownLocation(finding.path ?? check.filePath ?? null, finding.line ?? null, finding.column ?? null)}${finding.code ? ` ${finding.code}` : ""} ${finding.message}`.trim(),
      }));
    });
  return reasons
    .sort(compareDrilldownReasons)
    .slice(0, 5);
}

function collectInspectDrilldownAffectedFiles(
  report: VerifierInspectReport,
): VerifierReleaseAffectedFileSummary[] {
  const latestAttempt = report.latest.repairLoop?.attempts.at(-1) ?? null;
  if (latestAttempt?.directive?.fileGroups && latestAttempt.directive.fileGroups.length > 0) {
    return latestAttempt.directive.fileGroups
      .slice()
      .sort(compareInspectDirectiveFileGroups)
      .slice(0, 4)
      .map((group) => ({
        path: group.path ?? "(no path)",
        introducedCount: 0,
        persistedCount: group.diagnosticCount,
        totalCount: Math.max(group.itemCount, group.diagnosticCount),
      }));
  }
  const failedRun = findLatestFailedVerifierRunForDrilldown(report);
  if (!failedRun) {
    return [];
  }
  const groups = new Map<string, VerifierReleaseAffectedFileSummary>();
  for (const check of failedRun.checks.filter((entry) => entry.status === "failed")) {
    const findings = check.findings.filter((entry) => entry.status === "failed");
    if (findings.length === 0) {
      const path = check.filePath ?? "(no path)";
      const existing = groups.get(path) ?? { path, introducedCount: 0, persistedCount: 0, totalCount: 0 };
      existing.totalCount += 1;
      existing.persistedCount += 1;
      groups.set(path, existing);
      continue;
    }
    for (const finding of findings) {
      const path = finding.path ?? check.filePath ?? "(no path)";
      const existing = groups.get(path) ?? { path, introducedCount: 0, persistedCount: 0, totalCount: 0 };
      existing.totalCount += 1;
      existing.persistedCount += 1;
      groups.set(path, existing);
    }
  }
  return [...groups.values()]
    .sort(compareAffectedFiles)
    .slice(0, 4);
}

function collectInspectDrilldownBlockingDiagnostics(
  report: VerifierInspectReport,
): VerifierDrilldownBlockingDiagnosticSummary | null {
  const failedRun = findLatestFailedVerifierRunForDrilldown(report);
  if (!failedRun) {
    return null;
  }
  const current = failedRun.checks
    .filter((check) => check.status === "failed")
    .flatMap((check) =>
      check.findings
        .filter((finding) => finding.status === "failed" && finding.severity === "error")
        .map((finding) => createDiagnosticFingerprintFromFinding(check.filePath ?? null, finding)),
    );
  if (current.length === 0) {
    return null;
  }
  return {
    available: true,
    comparable: false,
    summary: `${current.length} current blocking diagnostic(s) in the latest failed verifier run.`,
    currentCount: current.length,
    introducedCount: 0,
    persistedCount: 0,
    resolvedCount: 0,
    current,
    introduced: [],
    persisted: [],
    resolved: [],
  };
}

function createInspectDrilldownRecommendations(
  reference: VerifierInspectResolvedReference,
  report: VerifierInspectReport,
  blockingDiagnostics: VerifierDrilldownBlockingDiagnosticSummary | null,
): VerifierDrilldownCommandSuggestion[] {
  const recommendations: VerifierDrilldownCommandSuggestion[] = [];
  if (blockingDiagnostics?.currentCount) {
    recommendations.push({
      priority: 1,
      command: createInspectFailuresCommand(reference),
      reason: "查看最值得先处理的 blocking verifier findings。",
    });
  }
  if (report.summary.latestProjectContextAvailable) {
    const contextCommand = createInspectContextCommand(reference);
    if (contextCommand) {
      recommendations.push({
        priority: 2,
        command: contextCommand,
        reason: "继续看 diagnostic-linked project context、definitions、references 和 document symbols。",
      });
    }
  }
  if (report.summary.latestRepairStatus !== "none") {
    const repairCommand = createInspectRepairCommand(reference);
    if (repairCommand) {
      recommendations.push({
        priority: 3,
        command: repairCommand,
        reason: "回看最近 repair loop 的 directive、progress 和是否已经收敛。",
      });
    }
  }
  const exportCommand = createInspectExportCommand(reference);
  if (exportCommand) {
    recommendations.push({
      priority: 4,
      command: exportCommand,
      reason: "把当前 verifier state 固化成 managed snapshot，后续可 compare 或 pin baseline。",
    });
  }
  return finalizeDrilldownRecommendations(recommendations);
}

function createReleaseDrilldownRecommendations(
  reference: string,
  triage: VerifierReleaseTriageSummary,
  githubMutation: VerifierGitHubMutationRecord | null,
): VerifierDrilldownCommandSuggestion[] {
  const recommendations: VerifierDrilldownCommandSuggestion[] = [];
  if (triage.primaryArtifactId) {
    recommendations.push({
      priority: 1,
      command: `node src/cli.mjs verifier artifact ${triage.primaryArtifactId} failures`,
      reason: "查看这次 handoff 背后的 primary artifact，确认 gate/eval/compare 的具体 failure evidence。",
    });
  }
  if ((triage.blockingDiagnostics?.introducedCount ?? 0) > 0 || (triage.blockingDiagnostics?.persistedCount ?? 0) > 0) {
    recommendations.push({
      priority: 2,
      command: `node src/cli.mjs verifier handoff ${reference} failures`,
      reason: "直接查看 blocking diagnostics continuity 和 top regression reasons。",
    });
  }
  if (triage.bundleId) {
    recommendations.push({
      priority: 3,
      command: `node src/cli.mjs verifier handoff export ${reference} summary`,
      reason: "定位这次 handoff 对应的 bundle 和离线 triage 文件。",
    });
  }
  if (!githubMutation && (triage.workflow || triage.upload)) {
    recommendations.push({
      priority: 4,
      command: `node src/cli.mjs verifier github apply ${reference} summary --github-actions`,
      reason: "在 GitHub Actions 上尝试把当前 typed checks payload 发布成 live check run。",
    });
  } else if (githubMutation && githubMutation.status !== "success") {
    recommendations.push({
      priority: 4,
      command: "node src/cli.mjs verifier github result latest summary",
      reason: "检查最近一次 GitHub mutation 为什么 unavailable/blocked/failed。",
    });
  }
  if (triage.handoffId) {
    recommendations.push({
      priority: 5,
      command: `node src/cli.mjs verifier checks summary ${reference} summary --github-actions`,
      reason: "查看 check payload、annotations 和 workflow/upload provenance。",
    });
  }
  return finalizeDrilldownRecommendations(recommendations);
}

function finalizeDrilldownRecommendations(
  recommendations: VerifierDrilldownCommandSuggestion[],
): VerifierDrilldownCommandSuggestion[] {
  const seen = new Set<string>();
  return recommendations
    .slice()
    .sort((left, right) => left.priority - right.priority || left.command.localeCompare(right.command))
    .filter((entry) => {
      if (seen.has(entry.command)) {
        return false;
      }
      seen.add(entry.command);
      return true;
    })
    .slice(0, 4)
    .map((entry, index) => ({
      priority: index + 1,
      command: entry.command,
      reason: entry.reason,
    }));
}

function createVerifierInspectTimelineReport(
  reference: string,
  resolvedReference: VerifierInspectResolvedReference,
  report: VerifierInspectReport,
  focus: VerifierDrilldownReport,
): VerifierTimelineReport {
  const events = collectInspectTimelineEvents(report);
  const primaryIssueEventId = resolveTimelinePrimaryIssueEventId(events, focus);
  const recommendedCommands = createInspectTimelineRecommendations(resolvedReference, focus);
  const continuity = createInspectTimelineContinuity(resolvedReference, report, focus);
  const latestStateSummary = createInspectTimelineLatestStateSummary(resolvedReference, report, focus);
  return {
    available: true,
    reason: null,
    createdAt: new Date().toISOString(),
    sourceKind: "inspect",
    reference,
    continuity,
    latestStateSummary,
    primaryIssueEventId,
    focus: structuredClone(focus),
    events,
    recommendedCommands,
    summary: `Verifier timeline for ${resolvedReference.label} captures ${events.length} bounded continuity event(s). ${latestStateSummary}`,
  };
}

function createVerifierReleaseTimelineReport(input: {
  reference: string;
  selection: VerifierReleaseHandoffSelection;
  triage: VerifierReleaseTriageSummary;
  githubMutation: VerifierGitHubMutationRecord | null;
  focus: VerifierDrilldownReport;
  artifact: VerifierInspectArtifactRecord | null;
  promotionHistory: VerifierBaselinePromotionHistory | null;
  bundle: VerifierReleaseBundleRecord | null;
}): VerifierTimelineReport {
  const events = collectReleaseTimelineEvents(input);
  const primaryIssueEventId = resolveTimelinePrimaryIssueEventId(events, input.focus);
  const recommendedCommands = createReleaseTimelineRecommendations(input.reference, input.triage, input.focus, input.githubMutation);
  const continuity = createReleaseTimelineContinuity(input);
  const latestStateSummary = createReleaseTimelineLatestStateSummary(input.triage, input.focus);
  return {
    available: input.focus.available,
    reason: input.focus.reason,
    createdAt: input.triage.createdAt,
    sourceKind: "release",
    reference: input.reference,
    continuity,
    latestStateSummary,
    primaryIssueEventId,
    focus: structuredClone(input.focus),
    events,
    recommendedCommands,
    summary: input.focus.available
      ? `Verifier timeline for ${input.reference} captures ${events.length} bounded release continuity event(s). ${latestStateSummary}`
      : (input.focus.reason ?? "No verifier release continuity is available."),
  };
}

function collectInspectTimelineEvents(
  report: VerifierInspectReport,
): VerifierTimelineEvent[] {
  const runEvents = report.verifierRuns
    .slice(-4)
    .map((run) => createVerifierRunTimelineEvent(run));
  const repairEvents = report.repairLoops
    .slice(-3)
    .map((loop) => createRepairLoopTimelineEvent(loop));
  return [...runEvents, ...repairEvents]
    .sort(compareTimelineEventsNewestFirst)
    .slice(0, 6);
}

function collectReleaseTimelineEvents(input: {
  triage: VerifierReleaseTriageSummary;
  githubMutation: VerifierGitHubMutationRecord | null;
  artifact: VerifierInspectArtifactRecord | null;
  promotionHistory: VerifierBaselinePromotionHistory | null;
  bundle: VerifierReleaseBundleRecord | null;
  selection: VerifierReleaseHandoffSelection;
}): VerifierTimelineEvent[] {
  const events: VerifierTimelineEvent[] = [];
  const inspectContinuity = input.artifact
    ? extractTimelineInspectContinuityFromArtifact(input.artifact)
    : null;
  if (inspectContinuity) {
    events.push(...collectInspectTimelineEvents(inspectContinuity.report).slice(0, 3));
  }
  if (input.artifact) {
    events.push(createArtifactTimelineEvent(input.artifact));
  }
  if (input.selection.handoff) {
    events.push(createHandoffTimelineEvent(input.selection.handoff));
  }
  if (input.bundle) {
    events.push(createBundleTimelineEvent(input.bundle));
  }
  const promotionPlanEvent = createPromotionPlannedTimelineEvent(input.triage);
  if (promotionPlanEvent) {
    events.push(promotionPlanEvent);
  }
  const latestPromotion = input.promotionHistory?.items.at(-1) ?? null;
  if (latestPromotion) {
    events.push(createPromotionAppliedTimelineEvent(
      latestPromotion,
      input.promotionHistory?.baselineName ?? null,
      input.triage.handoffId,
      input.triage.bundleId,
    ));
  }
  if (input.githubMutation) {
    events.push(createGitHubMutationTimelineEvent(input.githubMutation));
  }
  return events
    .sort(compareTimelineEventsNewestFirst)
    .slice(0, 6);
}

function extractTimelineInspectContinuityFromArtifact(
  artifact: VerifierInspectArtifactRecord,
): { reference: VerifierInspectResolvedReference; report: VerifierInspectReport } | null {
  if ("compare" in artifact) {
    return {
      reference: structuredClone(artifact.compare.right.reference),
      report: structuredClone(artifact.compare.right.report),
    };
  }
  if ("decision" in artifact) {
    return {
      reference: structuredClone(artifact.decision.compare.right.reference),
      report: structuredClone(artifact.decision.compare.right.report),
    };
  }
  if (artifact.result.baselineGate) {
    return {
      reference: structuredClone(artifact.result.baselineGate.compare.right.reference),
      report: structuredClone(artifact.result.baselineGate.compare.right.report),
    };
  }
  return null;
}

function createInspectTimelineContinuity(
  resolvedReference: VerifierInspectResolvedReference,
  report: VerifierInspectReport,
  focus: VerifierDrilldownReport,
): VerifierTimelineContinuity {
  return {
    sessionId: resolvedReference.sessionId,
    traceId: resolvedReference.traceId,
    replayReference: resolvedReference.replayReference,
    snapshotId: resolvedReference.snapshotId,
    baselineId: null,
    baselineName: resolvedReference.baselineName,
    latestVerifierRunId: report.latest.verifierRun?.startedAt ?? null,
    latestRepairLoopId: report.latest.repairLoop?.startedAt ?? null,
    primaryArtifactId: focus.primaryArtifactId,
    latestArtifactId: focus.latestArtifactId,
    latestGateArtifactId: focus.latestGateArtifactId,
    latestEvalArtifactId: focus.latestEvalArtifactId,
    handoffId: focus.handoffId,
    bundleId: focus.bundleId,
    promotionId: null,
    githubMutationId: focus.githubMutation?.mutationId ?? null,
    workflowRunId: null,
    uploadArtifactId: null,
  };
}

function createReleaseTimelineContinuity(input: {
  triage: VerifierReleaseTriageSummary;
  githubMutation: VerifierGitHubMutationRecord | null;
  artifact: VerifierInspectArtifactRecord | null;
  promotionHistory: VerifierBaselinePromotionHistory | null;
  bundle: VerifierReleaseBundleRecord | null;
  focus: VerifierDrilldownReport;
}): VerifierTimelineContinuity {
  const inspectContinuity = input.artifact
    ? extractTimelineInspectContinuityFromArtifact(input.artifact)
    : null;
  const latestPromotion = input.promotionHistory?.items.at(-1) ?? null;
  return {
    sessionId: inspectContinuity?.reference.sessionId ?? null,
    traceId: inspectContinuity?.reference.traceId ?? null,
    replayReference: inspectContinuity?.reference.replayReference ?? null,
    snapshotId: inspectContinuity?.reference.snapshotId ?? input.triage.snapshotIds[0] ?? null,
    baselineId: latestPromotion?.baselineId ?? null,
    baselineName: input.triage.baselineName,
    latestVerifierRunId: inspectContinuity?.report.latest.verifierRun?.startedAt ?? null,
    latestRepairLoopId: inspectContinuity?.report.latest.repairLoop?.startedAt ?? null,
    primaryArtifactId: input.triage.primaryArtifactId,
    latestArtifactId: input.focus.latestArtifactId,
    latestGateArtifactId: input.focus.latestGateArtifactId,
    latestEvalArtifactId: input.focus.latestEvalArtifactId,
    handoffId: input.triage.handoffId,
    bundleId: input.triage.bundleId,
    promotionId: latestPromotion?.promotionId ?? null,
    githubMutationId: input.githubMutation?.mutationId ?? null,
    workflowRunId: input.triage.workflow?.runId ?? input.bundle?.metadata.workflow?.runId ?? null,
    uploadArtifactId: input.triage.upload?.artifactId ?? input.bundle?.metadata.upload?.artifactId ?? null,
  };
}

function createInspectTimelineLatestStateSummary(
  resolvedReference: VerifierInspectResolvedReference,
  report: VerifierInspectReport,
  focus: VerifierDrilldownReport,
): string {
  if (!report.summary.hasData) {
    return `No verifier history is recorded for ${resolvedReference.label}.`;
  }
  return `Latest state is verifier ${report.summary.latestVerifierStatus}, repair ${report.summary.latestRepairStatus}, final outcome ${report.summary.finalOutcome}, with ${focus.topReasons.length} top reason(s) and ${focus.topAffectedFiles.length} affected file group(s).`;
}

function createReleaseTimelineLatestStateSummary(
  triage: VerifierReleaseTriageSummary,
  focus: VerifierDrilldownReport,
): string {
  if (!triage.available) {
    return triage.reason ?? "No verifier release continuity is available.";
  }
  return `Latest state is ${triage.sourceKind} handoff ${triage.status} under policy ${triage.policyProfileId ?? "none"}, promotion ${triage.promotionStatus}, final outcome ${triage.finalOutcome ?? "none"}, with ${focus.topReasons.length} top reason(s).`;
}

function createInspectTimelineRecommendations(
  reference: VerifierInspectResolvedReference,
  focus: VerifierDrilldownReport,
): VerifierTimelineCommandSuggestion[] {
  const recommendations: VerifierTimelineCommandSuggestion[] = [{
    priority: 1,
    command: createInspectTimelineDrilldownCommand(reference),
    reason: "先切到当前 continuity 的 bounded drilldown，确认最新 blocking reason 和 next commands。",
  }];
  if (focus.recommendedCommands.length > 0) {
    recommendations.push(...focus.recommendedCommands.map((entry) => ({
      priority: entry.priority + 1,
      command: entry.command,
      reason: entry.reason,
    })));
  }
  return finalizeTimelineRecommendations(recommendations);
}

function createReleaseTimelineRecommendations(
  reference: string,
  triage: VerifierReleaseTriageSummary,
  focus: VerifierDrilldownReport,
  githubMutation: VerifierGitHubMutationRecord | null,
): VerifierTimelineCommandSuggestion[] {
  const recommendations: VerifierTimelineCommandSuggestion[] = [{
    priority: 1,
    command: `node src/cli.mjs verifier drilldown ${reference} summary`,
    reason: "先回到当前 continuity 的问题概览，确认最新 top reasons、affected files 和建议动作。",
  }];
  if (triage.handoffId) {
    recommendations.push({
      priority: 2,
      command: `node src/cli.mjs verifier handoff ${reference} failures`,
      reason: "继续沿 handoff 看 blocking diagnostics continuity 和 release triage 结论。",
    });
  }
  if (triage.baselineName && triage.promotionStatus !== "unavailable") {
    recommendations.push({
      priority: 3,
      command: `node src/cli.mjs verifier promotion history ${triage.baselineName} summary`,
      reason: "查看同一 baseline 的 promotion continuity，确认是否已经 promote 或仍被阻塞。",
    });
  }
  if (githubMutation) {
    recommendations.push({
      priority: 4,
      command: "node src/cli.mjs verifier github result latest summary",
      reason: "查看这条 continuity 最新 GitHub mutation 的 fallback/live 状态和阻塞原因。",
    });
  } else if (focus.handoffId) {
    recommendations.push({
      priority: 4,
      command: `node src/cli.mjs verifier checks summary ${reference} summary --github-actions`,
      reason: "查看同一 handoff 的 checks payload、annotations 与 workflow/upload provenance。",
    });
  }
  return finalizeTimelineRecommendations(recommendations);
}

function finalizeTimelineRecommendations(
  recommendations: VerifierTimelineCommandSuggestion[],
): VerifierTimelineCommandSuggestion[] {
  const seen = new Set<string>();
  return recommendations
    .slice()
    .sort((left, right) => left.priority - right.priority || left.command.localeCompare(right.command))
    .filter((entry) => {
      if (seen.has(entry.command)) {
        return false;
      }
      seen.add(entry.command);
      return true;
    })
    .slice(0, 4)
    .map((entry, index) => ({
      priority: index + 1,
      command: entry.command,
      reason: entry.reason,
    }));
}

function createInspectTimelineDrilldownCommand(
  reference: VerifierInspectResolvedReference,
): string {
  switch (reference.kind) {
    case "trace":
      return "node src/cli.mjs verifier drilldown trace summary";
    case "replay":
      return `node src/cli.mjs verifier drilldown replay:${reference.reference ?? reference.replayReference ?? "<session-id>"} summary`;
    case "snapshot":
      return `node src/cli.mjs verifier drilldown snapshot:${reference.snapshotId ?? reference.reference ?? "<snapshot-id>"} summary`;
    case "baseline":
      return `node src/cli.mjs verifier drilldown baseline:${reference.baselineName ?? reference.reference ?? "<baseline-name>"} summary`;
    case "current":
    default:
      return "node src/cli.mjs verifier drilldown current summary";
  }
}

function resolveTimelinePrimaryIssueEventId(
  events: VerifierTimelineEvent[],
  focus: VerifierDrilldownReport,
): string | null {
  if (events.length === 0) {
    return null;
  }
  if (focus.githubMutation && focus.githubMutation.status !== "success") {
    const mutationEvent = events.find((entry) => entry.kind === "github_mutation");
    if (mutationEvent) {
      return mutationEvent.id;
    }
  }
  if (focus.sourceKind === "release" && focus.handoffStatus === "fail") {
    const handoffEvent = events.find((entry) => entry.kind === "handoff_created" && entry.status === "failure");
    if (handoffEvent) {
      return handoffEvent.id;
    }
  }
  if (focus.latestRepairStatus === "failed" || focus.latestRepairStatus === "exhausted") {
    const repairEvent = events.find((entry) => entry.kind === "repair_loop" && entry.status === "failure");
    if (repairEvent) {
      return repairEvent.id;
    }
  }
  if (focus.latestVerifierStatus === "failed") {
    const verifierEvent = events.find((entry) => entry.kind === "verifier_run" && entry.status === "failure");
    if (verifierEvent) {
      return verifierEvent.id;
    }
  }
  return events.find((entry) => entry.status === "failure")?.id
    ?? events[0]?.id
    ?? null;
}

function createVerifierRunTimelineEvent(
  run: VerifierRunRecord,
): VerifierTimelineEvent {
  const diagnostics = collectRunBlockingDiagnostics(run);
  const affectedFiles = collectRunAffectedFiles(run);
  const errorCount = diagnostics.length;
  const contextCount = run.summary.projectContextCount ?? 0;
  return {
    id: createTimelineEventId("verifier_run", run.startedAt),
    createdAt: run.finishedAt || run.startedAt,
    kind: "verifier_run",
    status: toTimelineEventStatusFromVerifierStatus(run.summary.status),
    summary: `Verifier ${run.summary.status} with ${run.summary.failedChecks}/${run.summary.totalChecks} failed check(s), ${errorCount} blocking diagnostic(s), and ${contextCount} project-context item(s).`,
    reason: run.summary.status === "failed"
      ? run.checks.find((entry) => entry.status === "failed")?.summary ?? run.summary.failureCategories[0] ?? null
      : null,
    path: affectedFiles[0] ?? null,
    linkedIds: createEmptyTimelineLinkedIds({
      verifierRunId: run.startedAt,
    }),
    affectedFiles,
    diagnostics,
  };
}

function createRepairLoopTimelineEvent(
  loop: RepairLoopRecord,
): VerifierTimelineEvent {
  const latestAttempt = loop.attempts.at(-1) ?? null;
  const affectedFiles = latestAttempt?.directive?.filePaths.slice(0, 4)
    ?? latestAttempt?.directive?.fileGroups.map((entry) => entry.path ?? "(no path)").slice(0, 4)
    ?? [];
  const diagnostics = latestAttempt?.directive?.items
    .slice(0, 3)
    .filter((entry) => entry.severity === "error")
    .map((entry) => ({
      fingerprint: entry.fingerprint ?? [entry.path ?? "", entry.line ?? "", entry.column ?? "", entry.code ?? "", entry.message].join("|"),
      path: entry.path,
      line: entry.line,
      column: entry.column,
      code: entry.code,
      message: entry.message,
      source: entry.source,
      scope: entry.scope,
      category: entry.category,
      rule: entry.rule,
    })) ?? [];
  return {
    id: createTimelineEventId("repair_loop", loop.startedAt),
    createdAt: loop.finishedAt || loop.startedAt,
    kind: "repair_loop",
    status: toTimelineEventStatusFromRepairStatus(loop.summary.status, loop.summary.latestProgress),
    summary: `Repair loop ${loop.summary.status} after ${loop.summary.attemptsUsed}/${loop.summary.maxAttempts} attempt(s); latest progress ${loop.summary.latestProgress}; code actions applied ${loop.summary.codeActionAppliedCount}.`,
    reason: latestAttempt?.summary ?? loop.summary.summary,
    path: affectedFiles[0] ?? null,
    linkedIds: createEmptyTimelineLinkedIds({
      repairLoopId: loop.startedAt,
      verifierRunId: loop.initialVerifierStartedAt,
    }),
    affectedFiles,
    diagnostics,
  };
}

function createArtifactTimelineEvent(
  artifact: VerifierInspectArtifactRecord,
): VerifierTimelineEvent {
  const baseDiagnostics = "decision" in artifact
    ? artifact.decision.compare.summary.blockingDiagnostics.introduced.slice(0, 3)
    : "compare" in artifact
      ? artifact.compare.summary.blockingDiagnostics.introduced.slice(0, 3)
      : artifact.result.baselineGate?.compare.summary.blockingDiagnostics.introduced.slice(0, 3) ?? [];
  const pass = artifact.metadata.pass;
  const status = artifact.metadata.kind === "compare"
    ? (artifact.metadata.hasChanges ? "notice" : "info")
    : pass === false
      ? "failure"
      : "success";
  return {
    id: createTimelineEventId("artifact_created", artifact.metadata.artifactId),
    createdAt: artifact.metadata.createdAt,
    kind: "artifact_created",
    status,
    summary: `Created ${artifact.metadata.kind} artifact ${artifact.metadata.artifactId}${artifact.metadata.policyProfileId ? ` under policy ${artifact.metadata.policyProfileId}` : ""}. ${artifact.metadata.summary}`,
    reason: artifact.metadata.pass === false ? artifact.metadata.summary : null,
    path: artifact.metadata.sourceReferences[1]?.label ?? artifact.metadata.sourceReferences[0]?.label ?? null,
    linkedIds: createEmptyTimelineLinkedIds({
      artifactId: artifact.metadata.artifactId,
      baselineName: artifact.metadata.baselineNames[0] ?? null,
      snapshotIds: artifact.metadata.snapshotIds,
    }),
    affectedFiles: artifact.metadata.sourceReferences.map((entry) => entry.label).slice(0, 4),
    diagnostics: baseDiagnostics,
  };
}

function createHandoffTimelineEvent(
  handoff: VerifierReleaseHandoffRecord,
): VerifierTimelineEvent {
  const affectedFiles = collectHandoffTimelineAffectedFiles(handoff);
  const topPath = affectedFiles[0] ?? null;
  return {
    id: createTimelineEventId("handoff_created", handoff.metadata.handoffId),
    createdAt: handoff.metadata.createdAt,
    kind: "handoff_created",
    status: toTimelineEventStatusFromHandoffStatus(handoff.metadata.status),
    summary: `Created ${handoff.metadata.sourceKind} handoff ${handoff.metadata.handoffId} with status ${handoff.metadata.status}${handoff.metadata.policyProfileId ? ` under policy ${handoff.metadata.policyProfileId}` : ""}.`,
    reason: handoff.topReasons[0]?.summary ?? handoff.summary,
    path: typeof topPath === "string" ? topPath : null,
    linkedIds: createEmptyTimelineLinkedIds({
      artifactId: handoff.metadata.primaryArtifactId,
      handoffId: handoff.metadata.handoffId,
      bundleId: handoff.metadata.bundleId,
      baselineName: handoff.baselineName ?? handoff.metadata.baselineNames[0] ?? null,
      promotionId: handoff.baselinePromotionId,
      snapshotIds: handoff.metadata.snapshotIds,
    }),
    affectedFiles,
    diagnostics: handoff.blockingDiagnostics
      ? [...handoff.blockingDiagnostics.introduced, ...handoff.blockingDiagnostics.persisted].slice(0, 3)
      : [],
  };
}

function createBundleTimelineEvent(
  bundle: VerifierReleaseBundleRecord,
): VerifierTimelineEvent {
  return {
    id: createTimelineEventId("bundle_exported", bundle.metadata.bundleId),
    createdAt: bundle.metadata.createdAt,
    kind: "bundle_exported",
    status: "info",
    summary: `Exported release bundle ${bundle.metadata.bundleId} for handoff ${bundle.metadata.handoffId} with ${bundle.files.length} file(s).`,
    reason: bundle.metadata.summary,
    path: bundle.metadata.bundlePath,
    linkedIds: createEmptyTimelineLinkedIds({
      artifactId: bundle.metadata.primaryArtifactId,
      handoffId: bundle.metadata.handoffId,
      bundleId: bundle.metadata.bundleId,
      baselineName: bundle.metadata.baselineNames[0] ?? null,
      snapshotIds: bundle.metadata.snapshotIds,
    }),
    affectedFiles: bundle.includedArtifacts.map((entry) => entry.artifactId).slice(0, 4),
    diagnostics: bundle.handoff.blockingDiagnostics
      ? [...bundle.handoff.blockingDiagnostics.introduced, ...bundle.handoff.blockingDiagnostics.persisted].slice(0, 3)
      : [],
  };
}

function createPromotionPlannedTimelineEvent(
  triage: VerifierReleaseTriageSummary,
): VerifierTimelineEvent | null {
  if (!triage.available || !triage.baselineName || triage.promotionStatus === "unavailable") {
    return null;
  }
  return {
    id: createTimelineEventId("promotion_planned", triage.handoffId ?? triage.createdAt),
    createdAt: triage.createdAt,
    kind: "promotion_planned",
    status: triage.promotionStatus === "eligible"
      ? "success"
      : triage.promotionStatus === "blocked"
        ? "failure"
        : triage.promotionStatus === "applied"
          ? "success"
          : "notice",
    summary: triage.promotionSummary ?? `Promotion state is ${triage.promotionStatus} for baseline ${triage.baselineName}.`,
    reason: triage.topReasons[0]?.summary ?? triage.promotionSummary,
    path: triage.topAffectedFiles[0]?.path ?? null,
    linkedIds: createEmptyTimelineLinkedIds({
      artifactId: triage.primaryArtifactId,
      handoffId: triage.handoffId,
      bundleId: triage.bundleId,
      baselineName: triage.baselineName,
      snapshotIds: triage.snapshotIds,
    }),
    affectedFiles: triage.topAffectedFiles.map((entry) => entry.path).slice(0, 4),
    diagnostics: triage.blockingDiagnostics
      ? [...triage.blockingDiagnostics.introduced, ...triage.blockingDiagnostics.persisted].slice(0, 3)
      : [],
  };
}

function createPromotionAppliedTimelineEvent(
  promotion: VerifierInspectBaselinePromotionRecord,
  baselineName: string | null,
  handoffId: string | null,
  bundleId: string | null,
): VerifierTimelineEvent {
  return {
    id: createTimelineEventId("promotion_applied", promotion.promotionId),
    createdAt: promotion.createdAt,
    kind: "promotion_applied",
    status: "success",
    summary: `Applied promotion ${promotion.promotionId} for baseline ${baselineName ?? promotion.name}, moving ${promotion.previousSnapshotId} -> ${promotion.nextSnapshotId}.`,
    reason: promotion.approval?.summary ?? promotion.decision?.summary ?? null,
    path: promotion.nextSource.label,
    linkedIds: createEmptyTimelineLinkedIds({
      handoffId,
      bundleId,
      baselineName: baselineName ?? promotion.name,
      promotionId: promotion.promotionId,
      snapshotIds: [promotion.previousSnapshotId, promotion.nextSnapshotId],
    }),
    affectedFiles: [promotion.previousSource.label, promotion.nextSource.label].filter(Boolean).slice(0, 4),
    diagnostics: [],
  };
}

function createGitHubMutationTimelineEvent(
  mutation: VerifierGitHubMutationRecord,
): VerifierTimelineEvent {
  return {
    id: createTimelineEventId("github_mutation", mutation.mutationId),
    createdAt: mutation.createdAt,
    kind: "github_mutation",
    status: mutation.status === "success"
      ? "success"
      : mutation.status === "skipped"
        ? "notice"
      : "failure",
    summary: mutation.summary,
    reason: mutation.reason,
    path: mutation.request.target.repository ?? null,
    linkedIds: createEmptyTimelineLinkedIds({
      artifactId: mutation.artifactIds[0] ?? null,
      handoffId: mutation.handoffId,
      bundleId: mutation.bundleId,
      mutationId: mutation.mutationId,
    }),
    affectedFiles: mutation.payload.topAffectedFiles.map((entry) => entry.path).slice(0, 4),
    diagnostics: mutation.payload.annotations
      .slice(0, 3)
      .flatMap((entry) => entry.fingerprint ? [entry.fingerprint] : []),
  };
}

function collectHandoffTimelineAffectedFiles(
  handoff: VerifierReleaseHandoffRecord,
): string[] {
  if (handoff.triage?.topAffectedFiles?.length) {
    return handoff.triage.topAffectedFiles.map((entry) => entry.path).slice(0, 4);
  }
  const groups = new Set<string>();
  for (const fingerprint of handoff.blockingDiagnostics?.introduced ?? []) {
    if (fingerprint.path) {
      groups.add(fingerprint.path);
    }
  }
  for (const fingerprint of handoff.blockingDiagnostics?.persisted ?? []) {
    if (fingerprint.path) {
      groups.add(fingerprint.path);
    }
  }
  return [...groups].slice(0, 4);
}

function createTimelineEventId(
  kind: VerifierTimelineEvent["kind"],
  rawId: string,
): string {
  return `${kind}:${rawId}`;
}

function createEmptyTimelineLinkedIds(
  input: Partial<VerifierTimelineLinkedIds>,
): VerifierTimelineLinkedIds {
  return {
    verifierRunId: input.verifierRunId ?? null,
    repairLoopId: input.repairLoopId ?? null,
    artifactId: input.artifactId ?? null,
    handoffId: input.handoffId ?? null,
    bundleId: input.bundleId ?? null,
    baselineName: input.baselineName ?? null,
    promotionId: input.promotionId ?? null,
    mutationId: input.mutationId ?? null,
    snapshotIds: input.snapshotIds ? [...input.snapshotIds] : [],
  };
}

function collectRunBlockingDiagnostics(
  run: VerifierRunRecord,
): DiagnosticFingerprint[] {
  return run.checks
    .filter((entry) => entry.status === "failed")
    .flatMap((check) =>
      check.findings
        .filter((finding) => finding.status === "failed" && finding.severity === "error")
        .map((finding) => createDiagnosticFingerprintFromFinding(check.filePath ?? null, finding)),
    )
    .slice(0, 3);
}

function collectRunAffectedFiles(
  run: VerifierRunRecord,
): string[] {
  const groups = new Set<string>();
  for (const check of run.checks) {
    if (check.filePath) {
      groups.add(check.filePath);
    }
    for (const finding of check.findings) {
      if (finding.path) {
        groups.add(finding.path);
      }
    }
  }
  return [...groups].slice(0, 4);
}

function toTimelineEventStatusFromVerifierStatus(
  status: VerifierRunRecord["summary"]["status"],
): VerifierTimelineEvent["status"] {
  switch (status) {
    case "passed":
      return "success";
    case "failed":
      return "failure";
    case "skipped":
      return "notice";
    default:
      return "info";
  }
}

function toTimelineEventStatusFromRepairStatus(
  status: RepairLoopRecord["summary"]["status"],
  latestProgress: RepairLoopRecord["summary"]["latestProgress"],
): VerifierTimelineEvent["status"] {
  if (status === "failed" || status === "exhausted") {
    return "failure";
  }
  if (status === "succeeded" || latestProgress === "resolved") {
    return "success";
  }
  if (status === "stopped" || latestProgress === "unchanged") {
    return "notice";
  }
  return "info";
}

function toTimelineEventStatusFromHandoffStatus(
  status: VerifierReleaseTriageSummary["status"],
): VerifierTimelineEvent["status"] {
  switch (status) {
    case "fail":
      return "failure";
    case "pass":
    case "promoted":
      return "success";
    case "changed":
      return "notice";
    case "steady":
      return "info";
    case "unavailable":
    default:
      return "unavailable";
  }
}

function compareTimelineEventsNewestFirst(
  left: VerifierTimelineEvent,
  right: VerifierTimelineEvent,
): number {
  return comparePrimitiveLists(
    [
      -Date.parse(left.createdAt),
      timelineEventPriority(left.kind),
      left.id,
    ],
    [
      -Date.parse(right.createdAt),
      timelineEventPriority(right.kind),
      right.id,
    ],
  );
}

function timelineEventPriority(
  kind: VerifierTimelineEvent["kind"],
): number {
  switch (kind) {
    case "github_mutation":
      return 0;
    case "promotion_applied":
      return 1;
    case "promotion_planned":
      return 2;
    case "bundle_exported":
      return 3;
    case "handoff_created":
      return 4;
    case "artifact_created":
      return 5;
    case "repair_loop":
      return 6;
    case "verifier_run":
    default:
      return 7;
  }
}

function createInspectFailuresCommand(reference: VerifierInspectResolvedReference): string {
  switch (reference.kind) {
    case "trace":
      return "node src/cli.mjs verifier trace failures";
    case "replay":
      return `node src/cli.mjs verifier replay ${reference.reference ?? reference.replayReference ?? "<session-id>"} failures`;
    case "snapshot":
      return `node src/cli.mjs verifier compare snapshot:${reference.snapshotId ?? reference.reference ?? "<snapshot-id>"} current failures`;
    case "baseline":
      return `node src/cli.mjs verifier compare baseline:${reference.baselineName ?? reference.reference ?? "<baseline-name>"} current failures`;
    case "current":
    default:
      return "node src/cli.mjs verifier failures";
  }
}

function createInspectContextCommand(reference: VerifierInspectResolvedReference): string | null {
  switch (reference.kind) {
    case "trace":
      return "node src/cli.mjs verifier trace context";
    case "replay":
      return `node src/cli.mjs verifier replay ${reference.reference ?? reference.replayReference ?? "<session-id>"} context`;
    case "current":
      return "node src/cli.mjs verifier context";
    default:
      return null;
  }
}

function createInspectRepairCommand(reference: VerifierInspectResolvedReference): string | null {
  switch (reference.kind) {
    case "trace":
      return "node src/cli.mjs verifier trace repair";
    case "replay":
      return `node src/cli.mjs verifier replay ${reference.reference ?? reference.replayReference ?? "<session-id>"} repair`;
    case "current":
      return "node src/cli.mjs verifier repair";
    default:
      return null;
  }
}

function createInspectExportCommand(reference: VerifierInspectResolvedReference): string | null {
  switch (reference.kind) {
    case "trace":
      return "node src/cli.mjs verifier export trace summary";
    case "replay":
      return `node src/cli.mjs verifier export replay ${reference.reference ?? reference.replayReference ?? "<session-id>"} summary`;
    case "current":
      return "node src/cli.mjs verifier export current summary";
    default:
      return null;
  }
}

function findLatestFailedVerifierRunForDrilldown(
  report: VerifierInspectReport,
): VerifierRunRecord | null {
  for (let index = report.verifierRuns.length - 1; index >= 0; index -= 1) {
    if (report.verifierRuns[index]?.summary.status === "failed") {
      return report.verifierRuns[index];
    }
  }
  return null;
}

function createDiagnosticFingerprintFromFinding(
  fallbackPath: string | null,
  finding: VerifierRunRecord["checks"][number]["findings"][number],
): DiagnosticFingerprint {
  const path = finding.path ?? fallbackPath ?? null;
  const line = finding.line ?? null;
  const column = finding.column ?? null;
  const code = finding.code ?? null;
  const message = finding.message;
  const source = finding.source ?? null;
  const scope = finding.scope ?? null;
  const category = finding.category ?? null;
  const rule = finding.rule ?? null;
  return {
    fingerprint: [path ?? "", line ?? "", column ?? "", code ?? "", source ?? "", scope ?? "", category ?? "", rule ?? "", message].join("|"),
    path,
    line,
    column,
    code,
    message,
    source,
    scope,
    category,
    rule,
  };
}

function toDrilldownReasonFromHandoff(
  entry: VerifierReleaseHandoffReasonSummary,
): VerifierDrilldownReasonSummary {
  return {
    kind: entry.kind,
    severity: entry.severity,
    source: "triage",
    path: null,
    summary: entry.summary,
  };
}

function toDrilldownReasonFromGitHubMutation(
  mutation: VerifierGitHubMutationRecord | null,
): VerifierDrilldownReasonSummary[] {
  if (!mutation || mutation.status === "success" || !mutation.reason) {
    return [];
  }
  return [{
    kind: mutation.reasonKind ?? mutation.status,
    severity: mutation.status === "blocked" || mutation.status === "failed" ? "failure" : "notice",
    source: "github_mutation",
    path: null,
    summary: mutation.reason,
  }];
}

function toDrilldownSeverity(
  severity: VerifierSeverity,
): VerifierDrilldownReasonSummary["severity"] {
  switch (severity) {
    case "warning":
      return "notice";
    case "info":
      return "info";
    case "error":
    default:
      return "failure";
  }
}

function compareInspectDirectiveItems(left: RepairDirectiveItem, right: RepairDirectiveItem): number {
  return comparePrimitiveLists(
    [
      drilldownCategoryPriority(left.category),
      left.path ?? "",
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
      left.code ?? "",
      left.message,
    ],
    [
      drilldownCategoryPriority(right.category),
      right.path ?? "",
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
      right.code ?? "",
      right.message,
    ],
  );
}

function compareInspectDirectiveFileGroups(left: RepairDirectiveFileGroup, right: RepairDirectiveFileGroup): number {
  return comparePrimitiveLists(
    [
      -(left.diagnosticCount ?? 0),
      -(left.itemCount ?? 0),
      -(left.codeActionCount ?? 0),
      -(left.projectContextCount ?? 0),
      left.path ?? "",
    ],
    [
      -(right.diagnosticCount ?? 0),
      -(right.itemCount ?? 0),
      -(right.codeActionCount ?? 0),
      -(right.projectContextCount ?? 0),
      right.path ?? "",
    ],
  );
}

function compareAffectedFiles(
  left: VerifierReleaseAffectedFileSummary,
  right: VerifierReleaseAffectedFileSummary,
): number {
  return comparePrimitiveLists(
    [
      -(left.totalCount ?? 0),
      -(left.persistedCount ?? 0),
      -(left.introducedCount ?? 0),
      left.path,
    ],
    [
      -(right.totalCount ?? 0),
      -(right.persistedCount ?? 0),
      -(right.introducedCount ?? 0),
      right.path,
    ],
  );
}

function compareDrilldownReasons(
  left: VerifierDrilldownReasonSummary,
  right: VerifierDrilldownReasonSummary,
): number {
  return comparePrimitiveLists(
    [
      drilldownSeverityPriority(left.severity),
      left.path ?? "",
      left.kind,
      left.summary,
    ],
    [
      drilldownSeverityPriority(right.severity),
      right.path ?? "",
      right.kind,
      right.summary,
    ],
  );
}

function comparePrimitiveLists(
  left: Array<string | number>,
  right: Array<string | number>,
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return leftValue - rightValue;
    }
    return `${leftValue ?? ""}`.localeCompare(`${rightValue ?? ""}`);
  }
  return 0;
}

function drilldownSeverityPriority(
  severity: VerifierDrilldownReasonSummary["severity"],
): number {
  switch (severity) {
    case "failure":
      return 0;
    case "notice":
      return 1;
    case "info":
    default:
      return 2;
  }
}

function drilldownCategoryPriority(
  category: string | null | undefined,
): number {
  switch (category) {
    case "syntax_error":
      return 0;
    case "config_error":
      return 1;
    case "diagnostic_error":
      return 2;
    case "command_failed":
      return 3;
    case "timeout":
      return 4;
    default:
      return 9;
  }
}

function formatDrilldownLocation(
  filePath: string | null,
  line: number | null,
  column: number | null,
): string {
  const base = filePath ?? "(no path)";
  if (line != null && column != null) {
    return `${base}:${line}:${column}`;
  }
  if (line != null) {
    return `${base}:${line}`;
  }
  return base;
}

export async function writeAgentVerifierEvalArtifact(
  target: Pick<AgentCommandSurfaceTarget, "config" | "sessionStore">,
  result: EvalSuiteResult,
  options: {
    writeBundle?: boolean;
  } = {},
): Promise<VerifierEvalArtifactRecord> {
  const store = new VerifierInspectArtifactStore(target.config.projectStateDir);
  const artifact = await store.writeEvalArtifact(result);
  const releaseStore = new VerifierReleaseStore(target.config.projectStateDir);
  const handoff = await releaseStore.writeArtifactHandoff(artifact);
  result.handoff = structuredClone(handoff.metadata);
  if (options.writeBundle) {
    const bundle = await releaseStore.exportBundleForArtifact(artifact);
    result.bundle = structuredClone(bundle.metadata);
  }
  await target.sessionStore.append("verifier_eval_artifact", {
    artifactId: artifact.metadata.artifactId,
    createdAt: artifact.metadata.createdAt,
    kind: artifact.metadata.kind,
    summary: artifact.metadata.summary,
    pass: artifact.metadata.pass,
    policyProfileId: artifact.metadata.policyProfileId,
    sourceReferences: artifact.metadata.sourceReferences,
  });
  await target.sessionStore.append("verifier_release_handoff", {
    handoffId: handoff.metadata.handoffId,
    createdAt: handoff.metadata.createdAt,
    sourceKind: handoff.metadata.sourceKind,
    primaryArtifactId: handoff.metadata.primaryArtifactId,
    summary: handoff.summary,
    bundleId: result.bundle?.bundleId ?? null,
  });
  return artifact;
}

export function clearAgentConversation(target: AgentCommandSurfaceTarget): void {
  target.messages = [];
  target.contextManager.reset();
  target.lastChangeSet = null;
  target.lastTaskClassification = null;
  target.lastRouteDecision = null;
  target.lastModelDecision = null;
  target.lastExecutionPlan = null;
}

export async function listAgentModels(
  target: Pick<AgentCommandSurfaceTarget, "provider" | "providerRuntimeStats">,
): Promise<string[]> {
  if (typeof target.provider.listModels !== "function") {
    return [];
  }

  return target.provider.listModels({
    traceId: crypto.randomUUID().slice(0, 12),
    onProviderEvent: async (event: unknown) => {
      target.providerRuntimeStats.lastEvent = event;
    },
  });
}

async function resolveAgentVerifierReference(
  target: Pick<AgentCommandSurfaceTarget, "config" | "executionJournal" | "lastRepairLoop" | "lastTrace" | "lastVerifierRun" | "sessionId" | "sessionStore">,
  reference: VerifierInspectReference,
): Promise<{
  reference: VerifierInspectResolvedReference;
  report: VerifierInspectReport;
}> {
  switch (reference.kind) {
    case "current": {
      const report = await getAgentVerifierReport(target, "current");
      return {
        reference: createVerifierInspectResolvedReference({
          kind: "current",
          scope: report.scope,
          sessionId: report.sessionId,
          traceId: report.traceId,
        }),
        report,
      };
    }
    case "trace": {
      const report = await getAgentVerifierReport(target, "trace");
      return {
        reference: createVerifierInspectResolvedReference({
          kind: "trace",
          scope: report.scope,
          sessionId: report.sessionId,
          traceId: report.traceId,
        }),
        report,
      };
    }
    case "replay": {
      const replayReference = `${reference.reference ?? ""}`.trim();
      if (!replayReference) {
        throw new Error("Missing replay reference.");
      }
      const report = await inspectAgentVerifierReplay(target, replayReference);
      return {
        reference: createVerifierInspectResolvedReference({
          kind: "replay",
          reference: replayReference,
          scope: report.scope,
          sessionId: report.sessionId,
          traceId: report.traceId,
          replayReference,
        }),
        report,
      };
    }
    case "snapshot": {
      const store = new VerifierInspectSnapshotStore(target.config.projectStateDir);
      const snapshot = await store.loadSnapshot(reference);
      return {
        reference: createVerifierInspectResolvedReference({
          kind: "snapshot",
          reference: snapshot.metadata.snapshotId,
          scope: snapshot.report.scope,
          sessionId: snapshot.report.sessionId,
          traceId: snapshot.report.traceId,
          replayReference: snapshot.metadata.source.replayReference,
          snapshotId: snapshot.metadata.snapshotId,
        }),
        report: structuredClone(snapshot.report),
      };
    }
    case "baseline": {
      const store = new VerifierInspectSnapshotStore(target.config.projectStateDir);
      const resolved = await store.resolveBaseline(reference);
      return {
        reference: resolved.reference,
        report: structuredClone(resolved.report),
      };
    }
    default:
      throw new Error(`Unsupported verifier reference "${reference.kind}".`);
  }
}

export async function listAgentSessions(
  target: Pick<AgentCommandSurfaceTarget, "sessionStore">,
  limit = 20,
): Promise<SessionIndexEntry[]> {
  return target.sessionStore.listSessions(limit);
}

export async function browseAgentSessionHistory(
  target: Pick<
    AgentCommandSurfaceTarget,
    | "executionJournal"
    | "lastExecutionPlan"
    | "lastModelDecision"
    | "lastRepairLoop"
    | "lastRouteDecision"
    | "lastTaskClassification"
    | "lastTrace"
    | "lastVerifierRun"
    | "rollbackStore"
    | "sessionId"
    | "sessionStore"
  >,
  scope: SessionBrowserReport["scope"] = "all",
  reference: string = "current",
): Promise<SessionBrowserReport> {
  return buildSessionBrowserReport(target, { scope, reference });
}

export async function recommendAgentSessionResume(
  target: Pick<
    AgentCommandSurfaceTarget,
    | "executionJournal"
    | "lastExecutionPlan"
    | "lastModelDecision"
    | "lastRepairLoop"
    | "lastRouteDecision"
    | "lastTaskClassification"
    | "lastTrace"
    | "lastVerifierRun"
    | "rollbackStore"
    | "sessionId"
    | "sessionStore"
  >,
  reference: string = "current",
): Promise<SessionResumeRecommendationReport> {
  return buildSessionResumeRecommendationReport(target, reference);
}

export async function getAgentSources(
  target: AgentCommandSurfaceTarget,
  which = "current",
): Promise<{
  sessionId: string | null;
  pack: unknown;
  sources: SourceRecordLike[];
}> {
  if (which === "last") {
    const sessions = await target.sessionStore.listSessions(20);
    await target.sourceRegistry.loadLatestFromSessions(
      sessions.map((entry) => entry.id),
    );
  } else if (target.sessionId) {
    await target.sourceRegistry.initialize(target.sessionId);
  }

  return {
    sessionId: target.sourceRegistry.sessionId ?? target.sessionId,
    pack: target.sourceRegistry.getLastPack(),
    sources: target.sourceRegistry.listSources(),
  };
}

export async function inspectAgentSource(
  target: AgentCommandSurfaceTarget,
  sourceId: string,
  which = "current",
): Promise<SourceRecordLike | null> {
  const payload = await getAgentSources(target, which);
  return payload.sources.find((entry) => entry.sourceId === sourceId) ?? null;
}

export function getAgentNetworkMode(
  target: AgentCommandSurfaceTarget,
): {
  networkMode: string;
  webProvider: string;
  rankingMode?: string;
  allowDomains?: unknown;
  denyDomains?: unknown;
} {
  return {
    networkMode: target.config.networkMode,
    webProvider: target.config.webProvider,
    rankingMode: target.config.webRankingMode,
    allowDomains: target.config.webAllowDomains,
    denyDomains: target.config.webDenyDomains,
  };
}

export function getAgentApprovalMode(
  target: Pick<
    AgentCommandSurfaceTarget,
    "config" | "lastChangeSet" | "mcpRegistry"
  > & {
    approvalStats: {
      asked: number;
      approved: number;
      denied: number;
    };
  },
): {
  permissionMode: string;
  approvalPolicy: string;
  networkMode: string;
  webProvider: string;
  approvals: {
    asked: number;
    approved: number;
    denied: number;
  };
  lastChangeRisk: unknown;
  mcp: {
    enabled: boolean | undefined;
    servers: number;
    tools: number;
  };
} {
  return {
    permissionMode: target.config.permissionMode,
    approvalPolicy: target.config.approvalPolicy,
    networkMode: target.config.networkMode,
    webProvider: target.config.webProvider,
    approvals: target.approvalStats,
    lastChangeRisk: target.lastChangeSet?.risk ?? null,
    mcp: {
      enabled: target.config.mcpEnabled,
      servers: target.mcpRegistry.listServers().length,
      tools: target.mcpRegistry.listTools().length,
    },
  };
}

export function getAgentCapabilities(
  target: AgentCommandSurfaceTarget,
  filters: Record<string, unknown> = {},
): unknown {
  target.rebuildCapabilitySurface();
  target.refreshSystemPrompt();
  return target.capabilityRegistry.describe(filters);
}

export function getAgentPolicySummary(
  target: AgentCommandSurfaceTarget,
): EffectivePolicy {
  return target.policyStack.getEffectivePolicy();
}

export function inspectAgentCapability(
  target: AgentCommandSurfaceTarget,
  idOrName: string,
): unknown {
  target.rebuildCapabilitySurface();
  return target.capabilityRegistry.inspect(idOrName);
}

export function getAgentSkills(target: AgentCommandSurfaceTarget): {
  active: SkillInfluenceEntry[];
  skills: SkillListEntry[];
} {
  return {
    active: target.skillLoader.getInfluenceSummary(),
    skills: target.skillLoader.listSkills(),
  };
}

export function inspectAgentSkill(
  target: AgentCommandSurfaceTarget,
  skillId: string,
): SkillInspectRecord | null {
  return target.skillLoader.inspectSkill(skillId);
}

export async function enableAgentSkill(
  target: AgentCommandSurfaceTarget,
  skillId: string,
): Promise<SkillInspectRecord> {
  const result = await target.skillLoader.enableSkill(skillId);
  target.rebuildCapabilitySurface();
  target.refreshSystemPrompt();
  await target.sessionStore.append("skill_state_changed", {
    action: "enable",
    skillId: result.id ?? skillId,
    enabled: result.enabled,
    active: result.active,
  });
  return result;
}

export async function disableAgentSkill(
  target: AgentCommandSurfaceTarget,
  skillId: string,
): Promise<SkillInspectRecord> {
  const result = await target.skillLoader.disableSkill(skillId);
  target.rebuildCapabilitySurface();
  target.refreshSystemPrompt();
  await target.sessionStore.append("skill_state_changed", {
    action: "disable",
    skillId: result.id ?? skillId,
    enabled: result.enabled,
    active: result.active,
  });
  return result;
}

export function getAgentPlugins(target: AgentCommandSurfaceTarget): {
  plugins: unknown[];
} {
  return {
    plugins: target.pluginLoader.listPlugins(),
  };
}

export function inspectAgentPlugin(
  target: AgentCommandSurfaceTarget,
  pluginId: string,
): unknown {
  return target.pluginLoader.inspectPlugin(pluginId);
}

export async function enableAgentPlugin(
  target: AgentCommandSurfaceTarget,
  pluginId: string,
): Promise<unknown> {
  const result = await target.pluginLoader.enablePlugin(pluginId);
  target.rebuildCapabilitySurface();
  target.refreshSystemPrompt();
  const record = asRecord(result);
  await target.sessionStore.append("plugin_state_changed", {
    action: "enable",
    pluginId: asString(record?.id) ?? pluginId,
    enabled: asBoolean(record?.enabled) ?? true,
    active: asBoolean(record?.active) ?? true,
    status: asString(record?.status) ?? "active",
  });
  return result;
}

export async function disableAgentPlugin(
  target: AgentCommandSurfaceTarget,
  pluginId: string,
): Promise<unknown> {
  const result = await target.pluginLoader.disablePlugin(pluginId);
  target.rebuildCapabilitySurface();
  target.refreshSystemPrompt();
  const record = asRecord(result);
  await target.sessionStore.append("plugin_state_changed", {
    action: "disable",
    pluginId: asString(record?.id) ?? pluginId,
    enabled: asBoolean(record?.enabled) ?? false,
    active: asBoolean(record?.active) ?? false,
    status: asString(record?.status) ?? "disabled",
  });
  return result;
}

export function getAgentMcpServers(target: AgentCommandSurfaceTarget): unknown {
  return target.mcpRegistry.listServers();
}

export function getAgentMcpTools(target: AgentCommandSurfaceTarget): unknown {
  return target.mcpRegistry.listTools();
}

export function inspectAgentMcpServer(
  target: AgentCommandSurfaceTarget,
  serverId: string,
): unknown {
  return target.mcpRegistry.inspectServer(serverId);
}

export async function testAgentMcpServer(
  target: AgentCommandSurfaceTarget,
  serverId: string,
): Promise<unknown> {
  return target.mcpRegistry.testServer(serverId);
}

export function getAgentRuntimeHealth(target: AgentCommandSurfaceTarget): unknown {
  return target.runtimeHealth.getOverview();
}

export function getAgentRuntimeCircuits(target: AgentCommandSurfaceTarget): unknown {
  return target.runtimeHealth.listCircuits("all");
}

export function inspectAgentRuntimeLayer(
  target: AgentCommandSurfaceTarget,
  layer = "provider",
): unknown {
  return target.runtimeHealth.inspectLayer(layer);
}

export async function searchAgentMemory(
  target: AgentCommandSurfaceTarget,
  query: string,
  scopes?: string[],
  limit?: number,
): Promise<unknown> {
  return target.memoryStore.search(query, { scopes, limit });
}

export async function rememberAgentMemory(
  target: AgentCommandSurfaceTarget,
  input: Record<string, unknown>,
): Promise<unknown> {
  const item = await target.memoryStore.remember(input);
  await target.sessionStore.append("memory_write", {
    source: "slash-command",
    memory: {
      id: item.id,
      scope: item.scope,
      kind: item.kind,
      summary: item.summary,
      source: item.source,
    },
  });
  return item;
}

export async function compactAgentConversation(
  target: AgentCommandSurfaceTarget,
): Promise<{
  messages: unknown[];
  compactedMessages: number;
  rollingSummary: string;
}> {
  const result = target.contextManager.compact(target.messages);
  target.messages = result.messages;
  await target.sessionStore.append("conversation_compacted", {
    compactedMessages: result.compactedMessages,
    rollingSummary: result.rollingSummary,
  });
  await target.captureStateSnapshot({
    traceId: target.lastTrace?.traceId ?? null,
    phase: "context_prepare",
    stepId: "manual-compact",
    outputSummary: `Compacted ${result.compactedMessages} message(s).`,
  });
  return result;
}

export async function listAgentJobs(
  target: Pick<AgentCommandSurfaceTarget, "shellRuntime">,
  status: string | null = null,
  limit = 50,
): Promise<unknown> {
  return target.shellRuntime.listJobs(status, limit);
}

export async function cancelAgentJob(
  target: Pick<AgentCommandSurfaceTarget, "shellRuntime">,
  jobId: string,
): Promise<unknown> {
  return target.shellRuntime.cancelJob(jobId);
}

export async function tailAgentJob(
  target: Pick<AgentCommandSurfaceTarget, "shellRuntime">,
  jobId: string,
  options?: unknown,
): Promise<unknown> {
  return target.shellRuntime.tailJob(jobId, options);
}

export async function getAgentShellHistory(
  target: Pick<AgentCommandSurfaceTarget, "shellRuntime">,
  limit = 20,
): Promise<unknown> {
  return target.shellRuntime.getShellHistory(limit);
}

export async function attachAgentJob(
  target: Pick<AgentCommandSurfaceTarget, "shellRuntime">,
  jobId: string,
  options?: unknown,
): Promise<unknown> {
  return target.shellRuntime.attachJob(jobId, options);
}

export async function undoAgentChangeFromSurface(
  target: AgentCommandSurfaceTarget,
  changeSetId: string | null = null,
): Promise<unknown> {
  return undoAgentChange(
    {
      sessionId: target.sessionId,
      rollbackStore: target.rollbackStore,
      sessionStore: target.sessionStore,
      executionJournal: target.executionJournal,
      captureStateSnapshot: async (input) => target.captureStateSnapshot(input),
    },
    changeSetId,
  );
}

export async function listAgentChangeHistory(
  target: AgentCommandSurfaceTarget,
  limit = 20,
): Promise<unknown> {
  return target.rollbackStore.listCheckpoints(limit);
}

export function getAgentLastDiff(
  target: AgentCommandSurfaceTarget,
  filePath: string | null = null,
): unknown {
  return selectChangeSetDiff(target.lastChangeSet, filePath);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
