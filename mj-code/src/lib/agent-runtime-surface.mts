import {
  attachAgentJob,
  cancelAgentJob,
  clearAgentConversation,
  compactAgentConversation,
  disableAgentPlugin,
  disableAgentSkill,
  drilldownAgentVerifier,
  enableAgentPlugin,
  enableAgentSkill,
  explainAgentDecision,
  exportAgentVerifierSnapshot,
  exportAgentVerifierGitHubChecksPayload,
  exportAgentVerifierBundle,
  gateAgentVerifierReports,
  getAgentApprovalMode,
  getAgentCapabilities,
  getAgentLastDiff,
  getAgentMcpServers,
  getAgentMcpTools,
  getAgentDecisionNext,
  getAgentDecisionRecovery,
  getAgentPlanCurrent,
  getAgentPlanTimeline,
  getAgentMemorySnapshot,
  getAgentNetworkMode,
  getAgentPlugins,
  getAgentPolicySummary,
  getAgentRuntimeCircuits,
  getAgentRuntimeHealth,
  getAgentShellHistory,
  getAgentSkills,
  getAgentSources,
  getAgentVerifierReport,
  inspectAgentVerifierArtifact,
  inspectAgentVerifierGitHubMutation,
  inspectAgentVerifierHandoff,
  listAgentVerifierSnapshots,
  listAgentVerifierBaselines,
  listAgentVerifierArtifacts,
  listAgentVerifierGatePolicyProfiles,
  listAgentVerifierBaselinePromotionHistory,
  pruneAgentVerifierArtifacts,
  inspectAgentCapability,
  inspectAgentMcpServer,
  inspectAgentPlugin,
  inspectAgentRuntimeLayer,
  inspectAgentSkill,
  inspectAgentSource,
  inspectAgentVerifierReplay,
  compareAgentVerifierReports,
  pinAgentVerifierBaseline,
  planAgentVerifierBaselinePromotion,
  approveAgentVerifierBaselinePromotion,
  applyAgentVerifierGitHubMutation,
  browseAgentSessionHistory,
  listAgentChangeHistory,
  listAgentJobs,
  listAgentModels,
  listAgentSessions,
  recommendAgentSessionResume,
  rememberAgentMemory,
  searchAgentMemory,
  tailAgentJob,
  testAgentMcpServer,
  timelineAgentVerifier,
  undoAgentChangeFromSurface,
  writeAgentVerifierEvalArtifact,
  summarizeAgentVerifierReleaseTriage,
  type AgentCommandSurfaceTarget,
} from "./agent-command-surface.mjs";
import { MJCodeAgentIntelligenceSurface } from "./agent-intelligence-surface.mjs";
import { pickLatestUndoTarget } from "./agent-rollback-ops.mjs";
import { buildAgentReplay } from "./agent-session-ops.mjs";
import { runAgentTurnLoop } from "./agent-turn-engine.mjs";
import {
  handleAgentToolExecution,
  noteAgentProviderMeta,
  pushAgentToolFeedback,
  recordAgentHookEvent,
  recordAgentMcpEvent,
  recordAgentProviderEvent,
  recordAgentShellEvent,
  recordAgentTurnMemory,
  recordAgentWebEvent,
  updateAgentUsageTotals,
  type AgentRuntimeEventsTarget,
} from "./agent-runtime-events.mjs";

type TurnLoopTarget = Parameters<typeof runAgentTurnLoop>[0];
type ReplayTarget = {
  sessionStore: Parameters<typeof buildAgentReplay>[0]["sessionStore"];
  executionJournal: Parameters<typeof buildAgentReplay>[0]["executionJournal"];
};

export class MJCodeAgentRuntimeSurface extends MJCodeAgentIntelligenceSurface {
  async runUserInput(userInput: string): ReturnType<typeof runAgentTurnLoop> {
    const prompt = `${userInput ?? ""}`.trim();
    if (!prompt) {
      return { content: "", steps: 0, printed: false };
    }
    return runAgentTurnLoop(asTurnLoopTarget(this), prompt);
  }

  clearConversation(): void {
    clearAgentConversation(asCommandSurfaceTarget(this));
  }

  async listModels(): ReturnType<typeof listAgentModels> {
    return listAgentModels(asCommandSurfaceTarget(this));
  }

  async listSessions(limit: number = 20): ReturnType<typeof listAgentSessions> {
    return listAgentSessions(asCommandSurfaceTarget(this), limit);
  }

  async browseSessionHistory(
    scope: "all" | "changes" | "sessions" | "lineage" | "replay" = "all",
    reference: string = "current",
  ): ReturnType<typeof browseAgentSessionHistory> {
    return browseAgentSessionHistory(asCommandSurfaceTarget(this), scope, reference);
  }

  async recommendSessionResume(
    reference: string = "current",
  ): ReturnType<typeof recommendAgentSessionResume> {
    return recommendAgentSessionResume(asCommandSurfaceTarget(this), reference);
  }

  async replaySession(reference: string): ReturnType<typeof buildAgentReplay> {
    const target = asReplayTarget(this);
    return buildAgentReplay({
      sessionStore: target.sessionStore,
      executionJournal: target.executionJournal,
    }, reference);
  }

  async getVerifierReport(
    which: "current" | "trace" = "current",
  ): ReturnType<typeof getAgentVerifierReport> {
    return getAgentVerifierReport(asCommandSurfaceTarget(this), which);
  }

  async getPlanCurrent(): ReturnType<typeof getAgentPlanCurrent> {
    return getAgentPlanCurrent(asCommandSurfaceTarget(this));
  }

  async getPlanTimeline(
    reference: string = "current",
  ): ReturnType<typeof getAgentPlanTimeline> {
    return getAgentPlanTimeline(asCommandSurfaceTarget(this), reference);
  }

  async explainWhy(
    scope: string = "overview",
    reference: string = "current",
  ): ReturnType<typeof explainAgentDecision> {
    return explainAgentDecision(
      asCommandSurfaceTarget(this),
      normalizeDecisionScope(scope),
      reference,
    );
  }

  async getNextDecision(
    reference: string = "current",
  ): ReturnType<typeof getAgentDecisionNext> {
    return getAgentDecisionNext(asCommandSurfaceTarget(this), reference);
  }

  async getRecoveryDecision(
    reference: string = "current",
  ): ReturnType<typeof getAgentDecisionRecovery> {
    return getAgentDecisionRecovery(asCommandSurfaceTarget(this), reference);
  }

  async inspectVerifierReplay(
    reference: string,
  ): ReturnType<typeof inspectAgentVerifierReplay> {
    return inspectAgentVerifierReplay(asCommandSurfaceTarget(this), reference);
  }

  async exportVerifierReport(
    reference: Parameters<typeof exportAgentVerifierSnapshot>[1] = { kind: "current", reference: null },
  ): ReturnType<typeof exportAgentVerifierSnapshot> {
    return exportAgentVerifierSnapshot(asCommandSurfaceTarget(this), reference);
  }

  async listVerifierSnapshots(
    limit: number = 20,
  ): ReturnType<typeof listAgentVerifierSnapshots> {
    return listAgentVerifierSnapshots(asCommandSurfaceTarget(this), limit);
  }

  async pinVerifierBaseline(
    reference: Parameters<typeof pinAgentVerifierBaseline>[1],
    name: Parameters<typeof pinAgentVerifierBaseline>[2],
    options?: Parameters<typeof pinAgentVerifierBaseline>[3],
  ): ReturnType<typeof pinAgentVerifierBaseline> {
    return pinAgentVerifierBaseline(asCommandSurfaceTarget(this), reference, name, options);
  }

  async listVerifierBaselines(
    limit: number = 20,
  ): ReturnType<typeof listAgentVerifierBaselines> {
    return listAgentVerifierBaselines(asCommandSurfaceTarget(this), limit);
  }

  async planVerifierBaselinePromotion(
    baselineName: string,
    reference: string = "latest",
    options?: Parameters<typeof planAgentVerifierBaselinePromotion>[3],
  ): ReturnType<typeof planAgentVerifierBaselinePromotion> {
    return planAgentVerifierBaselinePromotion(asCommandSurfaceTarget(this), baselineName, reference, options);
  }

  async approveVerifierBaselinePromotion(
    reference: string,
    options?: Parameters<typeof approveAgentVerifierBaselinePromotion>[2],
  ): ReturnType<typeof approveAgentVerifierBaselinePromotion> {
    return approveAgentVerifierBaselinePromotion(asCommandSurfaceTarget(this), reference, options);
  }

  async applyVerifierGitHubMutation(
    reference: string = "latest",
    options?: Parameters<typeof applyAgentVerifierGitHubMutation>[2],
  ): ReturnType<typeof applyAgentVerifierGitHubMutation> {
    return applyAgentVerifierGitHubMutation(asCommandSurfaceTarget(this), reference, options);
  }

  async listVerifierBaselinePromotionHistory(
    baselineName: string,
  ): ReturnType<typeof listAgentVerifierBaselinePromotionHistory> {
    return listAgentVerifierBaselinePromotionHistory(asCommandSurfaceTarget(this), baselineName);
  }

  async listVerifierGatePolicyProfiles(): ReturnType<typeof listAgentVerifierGatePolicyProfiles> {
    return listAgentVerifierGatePolicyProfiles();
  }

  async listVerifierArtifacts(
    limit: number = 20,
  ): ReturnType<typeof listAgentVerifierArtifacts> {
    return listAgentVerifierArtifacts(asCommandSurfaceTarget(this), limit);
  }

  async inspectVerifierArtifact(
    artifactId: Parameters<typeof inspectAgentVerifierArtifact>[1],
  ): ReturnType<typeof inspectAgentVerifierArtifact> {
    return inspectAgentVerifierArtifact(asCommandSurfaceTarget(this), artifactId);
  }

  async inspectVerifierHandoff(
    reference: Parameters<typeof inspectAgentVerifierHandoff>[1] = "latest",
  ): ReturnType<typeof inspectAgentVerifierHandoff> {
    return inspectAgentVerifierHandoff(asCommandSurfaceTarget(this), reference);
  }

  async inspectVerifierGitHubMutation(
    reference: string = "latest",
  ): ReturnType<typeof inspectAgentVerifierGitHubMutation> {
    return inspectAgentVerifierGitHubMutation(asCommandSurfaceTarget(this), reference);
  }

  async drilldownVerifier(
    reference: string = "latest",
    options?: Parameters<typeof drilldownAgentVerifier>[2],
  ): ReturnType<typeof drilldownAgentVerifier> {
    return drilldownAgentVerifier(asCommandSurfaceTarget(this), reference, options);
  }

  async timelineVerifier(
    reference: string = "latest",
    options?: Parameters<typeof timelineAgentVerifier>[2],
  ): ReturnType<typeof timelineAgentVerifier> {
    return timelineAgentVerifier(asCommandSurfaceTarget(this), reference, options);
  }

  async summarizeVerifierReleaseTriage(
    reference: string = "latest",
    options?: Parameters<typeof summarizeAgentVerifierReleaseTriage>[2],
  ): ReturnType<typeof summarizeAgentVerifierReleaseTriage> {
    return summarizeAgentVerifierReleaseTriage(asCommandSurfaceTarget(this), reference, options);
  }

  async exportVerifierGitHubChecksPayload(
    reference: string = "latest",
    options?: Parameters<typeof exportAgentVerifierGitHubChecksPayload>[2],
  ): ReturnType<typeof exportAgentVerifierGitHubChecksPayload> {
    return exportAgentVerifierGitHubChecksPayload(asCommandSurfaceTarget(this), reference, options);
  }

  async exportVerifierBundle(
    reference: Parameters<typeof exportAgentVerifierBundle>[1] = "latest",
  ): ReturnType<typeof exportAgentVerifierBundle> {
    return exportAgentVerifierBundle(asCommandSurfaceTarget(this), reference);
  }

  async compareVerifierReports(
    left: Parameters<typeof compareAgentVerifierReports>[1],
    right: Parameters<typeof compareAgentVerifierReports>[2],
    options?: Parameters<typeof compareAgentVerifierReports>[3],
  ): ReturnType<typeof compareAgentVerifierReports> {
    return compareAgentVerifierReports(asCommandSurfaceTarget(this), left, right, options);
  }

  async gateVerifierReports(
    left: Parameters<typeof gateAgentVerifierReports>[1],
    right: Parameters<typeof gateAgentVerifierReports>[2],
    policy?: Parameters<typeof gateAgentVerifierReports>[3],
    options?: Parameters<typeof gateAgentVerifierReports>[4],
  ): ReturnType<typeof gateAgentVerifierReports> {
    return gateAgentVerifierReports(asCommandSurfaceTarget(this), left, right, policy, options);
  }

  async writeVerifierEvalArtifact(
    result: Parameters<typeof writeAgentVerifierEvalArtifact>[1],
    options?: Parameters<typeof writeAgentVerifierEvalArtifact>[2],
  ): ReturnType<typeof writeAgentVerifierEvalArtifact> {
    return writeAgentVerifierEvalArtifact(asCommandSurfaceTarget(this), result, options);
  }

  async pruneVerifierArtifacts(
    policy?: Parameters<typeof pruneAgentVerifierArtifacts>[1],
  ): ReturnType<typeof pruneAgentVerifierArtifacts> {
    return pruneAgentVerifierArtifacts(asCommandSurfaceTarget(this), policy);
  }

  async getMemorySnapshot(): ReturnType<typeof getAgentMemorySnapshot> {
    return getAgentMemorySnapshot(asCommandSurfaceTarget(this));
  }

  async getSources(which: string = "current"): ReturnType<typeof getAgentSources> {
    return getAgentSources(asCommandSurfaceTarget(this), which);
  }

  async inspectSource(
    sourceId: string,
    which: string = "current",
  ): ReturnType<typeof inspectAgentSource> {
    return inspectAgentSource(asCommandSurfaceTarget(this), sourceId, which);
  }

  getNetworkMode(): ReturnType<typeof getAgentNetworkMode> {
    return getAgentNetworkMode(asCommandSurfaceTarget(this));
  }

  getCapabilities(
    filters: Parameters<typeof getAgentCapabilities>[1] = {},
  ): ReturnType<typeof getAgentCapabilities> {
    return getAgentCapabilities(asCommandSurfaceTarget(this), filters);
  }

  getPolicySummary(): ReturnType<typeof getAgentPolicySummary> {
    return getAgentPolicySummary(asCommandSurfaceTarget(this));
  }

  inspectCapability(idOrName: string): ReturnType<typeof inspectAgentCapability> {
    return inspectAgentCapability(asCommandSurfaceTarget(this), idOrName);
  }

  getSkills(): ReturnType<typeof getAgentSkills> {
    return getAgentSkills(asCommandSurfaceTarget(this));
  }

  inspectSkill(skillId: string): ReturnType<typeof inspectAgentSkill> {
    return inspectAgentSkill(asCommandSurfaceTarget(this), skillId);
  }

  async enableSkill(skillId: string): ReturnType<typeof enableAgentSkill> {
    return enableAgentSkill(asCommandSurfaceTarget(this), skillId);
  }

  async disableSkill(skillId: string): ReturnType<typeof disableAgentSkill> {
    return disableAgentSkill(asCommandSurfaceTarget(this), skillId);
  }

  getPlugins(): ReturnType<typeof getAgentPlugins> {
    return getAgentPlugins(asCommandSurfaceTarget(this));
  }

  inspectPlugin(pluginId: string): ReturnType<typeof inspectAgentPlugin> {
    return inspectAgentPlugin(asCommandSurfaceTarget(this), pluginId);
  }

  async enablePlugin(pluginId: string): ReturnType<typeof enableAgentPlugin> {
    return enableAgentPlugin(asCommandSurfaceTarget(this), pluginId);
  }

  async disablePlugin(pluginId: string): ReturnType<typeof disableAgentPlugin> {
    return disableAgentPlugin(asCommandSurfaceTarget(this), pluginId);
  }

  getMcpServers(): ReturnType<typeof getAgentMcpServers> {
    return getAgentMcpServers(asCommandSurfaceTarget(this));
  }

  getMcpTools(): ReturnType<typeof getAgentMcpTools> {
    return getAgentMcpTools(asCommandSurfaceTarget(this));
  }

  inspectMcpServer(serverId: string): ReturnType<typeof inspectAgentMcpServer> {
    return inspectAgentMcpServer(asCommandSurfaceTarget(this), serverId);
  }

  async testMcpServer(serverId: string): ReturnType<typeof testAgentMcpServer> {
    return testAgentMcpServer(asCommandSurfaceTarget(this), serverId);
  }

  async listJobs(
    status: string | null = null,
    limit: number = 50,
  ): ReturnType<typeof listAgentJobs> {
    return listAgentJobs(asCommandSurfaceTarget(this), status, limit);
  }

  async cancelJob(jobId: string): ReturnType<typeof cancelAgentJob> {
    return cancelAgentJob(asCommandSurfaceTarget(this), jobId);
  }

  async tailJob(
    jobId: string,
    options?: Parameters<typeof tailAgentJob>[2],
  ): ReturnType<typeof tailAgentJob> {
    const target = asCommandSurfaceWithConfig(this);
    return tailAgentJob(target, jobId, options ?? target.config.maxOutputChars);
  }

  async getShellHistory(limit: number = 20): ReturnType<typeof getAgentShellHistory> {
    return getAgentShellHistory(asCommandSurfaceTarget(this), limit);
  }

  async attachJob(
    jobId: string,
    options: Parameters<typeof attachAgentJob>[2] = {},
  ): ReturnType<typeof attachAgentJob> {
    return attachAgentJob(asCommandSurfaceTarget(this), jobId, options);
  }

  getRuntimeHealth(): ReturnType<typeof getAgentRuntimeHealth> {
    return getAgentRuntimeHealth(asCommandSurfaceTarget(this));
  }

  getRuntimeCircuits(): ReturnType<typeof getAgentRuntimeCircuits> {
    return getAgentRuntimeCircuits(asCommandSurfaceTarget(this));
  }

  inspectRuntimeLayer(
    layer: Parameters<typeof inspectAgentRuntimeLayer>[1] = "provider",
  ): ReturnType<typeof inspectAgentRuntimeLayer> {
    return inspectAgentRuntimeLayer(asCommandSurfaceTarget(this), layer);
  }

  async searchMemory(
    query: string,
    scopes?: string[],
    limit?: number,
  ): ReturnType<typeof searchAgentMemory> {
    return searchAgentMemory(asCommandSurfaceTarget(this), query, scopes, limit);
  }

  async rememberMemory(
    input: Parameters<typeof rememberAgentMemory>[1],
  ): ReturnType<typeof rememberAgentMemory> {
    return rememberAgentMemory(asCommandSurfaceTarget(this), input);
  }

  async compactConversation(): ReturnType<typeof compactAgentConversation> {
    return compactAgentConversation(asCommandSurfaceTarget(this));
  }

  async undoChange(
    changeSetId: string | null = null,
  ): ReturnType<typeof undoAgentChangeFromSurface> {
    return undoAgentChangeFromSurface(asCommandSurfaceTarget(this), changeSetId);
  }

  async listChangeHistory(limit: number = 20): ReturnType<typeof listAgentChangeHistory> {
    return listAgentChangeHistory(asCommandSurfaceTarget(this), limit);
  }

  getLastDiff(filePath: string | null = null): ReturnType<typeof getAgentLastDiff> {
    return getAgentLastDiff(asCommandSurfaceTarget(this), filePath);
  }

  getApprovalMode(): ReturnType<typeof getAgentApprovalMode> {
    return getAgentApprovalMode(asCommandSurfaceWithApprovalStats(this));
  }

  printAssistant(content: string): boolean {
    if (!content) {
      return false;
    }

    (this as { ui?: { printAssistant?(message: string): void } }).ui?.printAssistant?.(content);
    return true;
  }

  async handleToolExecution(
    payload: Parameters<typeof handleAgentToolExecution>[1],
  ): ReturnType<typeof handleAgentToolExecution> {
    return handleAgentToolExecution(asRuntimeEventsTarget(this), payload);
  }

  async pushToolFeedback(
    payload: Parameters<typeof pushAgentToolFeedback>[1],
  ): ReturnType<typeof pushAgentToolFeedback> {
    return pushAgentToolFeedback(asRuntimeEventsTarget(this), payload);
  }

  async recordTurnMemory(
    turnState: Parameters<typeof recordAgentTurnMemory>[1],
    content: string,
    success: boolean,
    stopped: boolean,
  ): ReturnType<typeof recordAgentTurnMemory> {
    return recordAgentTurnMemory(asRuntimeEventsTarget(this), turnState, content, success, stopped);
  }

  async pickLatestUndoTarget(): ReturnType<typeof pickLatestUndoTarget> {
    return pickLatestUndoTarget(asCommandSurfaceTarget(this).rollbackStore);
  }

  updateUsageTotals(usage: Parameters<typeof updateAgentUsageTotals>[1]): void {
    updateAgentUsageTotals(asRuntimeEventsTarget(this), usage);
  }

  async recordProviderEvent(
    event: Parameters<typeof recordAgentProviderEvent>[1],
    turnState: Parameters<typeof recordAgentProviderEvent>[2],
    step: Parameters<typeof recordAgentProviderEvent>[3],
  ): ReturnType<typeof recordAgentProviderEvent> {
    return recordAgentProviderEvent(asRuntimeEventsTarget(this), event, turnState, step);
  }

  noteProviderMeta(
    turnState: Parameters<typeof noteAgentProviderMeta>[0],
    meta: Parameters<typeof noteAgentProviderMeta>[1],
  ): void {
    noteAgentProviderMeta(turnState, meta);
  }

  async recordMcpEvent(
    event: Parameters<typeof recordAgentMcpEvent>[1],
  ): ReturnType<typeof recordAgentMcpEvent> {
    return recordAgentMcpEvent(asRuntimeEventsTarget(this), event);
  }

  async recordWebEvent(
    event: Parameters<typeof recordAgentWebEvent>[1],
    turnState: Parameters<typeof recordAgentWebEvent>[2],
    step: Parameters<typeof recordAgentWebEvent>[3],
  ): ReturnType<typeof recordAgentWebEvent> {
    return recordAgentWebEvent(asRuntimeEventsTarget(this), event, turnState, step);
  }

  async recordShellEvent(
    event: Parameters<typeof recordAgentShellEvent>[1],
  ): ReturnType<typeof recordAgentShellEvent> {
    return recordAgentShellEvent(asRuntimeEventsTarget(this), event);
  }

  async recordHookEvent(
    event: Parameters<typeof recordAgentHookEvent>[1],
  ): ReturnType<typeof recordAgentHookEvent> {
    return recordAgentHookEvent(asRuntimeEventsTarget(this), event);
  }
}

function asCommandSurfaceTarget(value: unknown): AgentCommandSurfaceTarget {
  return value as AgentCommandSurfaceTarget;
}

function asCommandSurfaceWithConfig(
  value: unknown,
): AgentCommandSurfaceTarget & { config: { maxOutputChars: number } } {
  return value as AgentCommandSurfaceTarget & { config: { maxOutputChars: number } };
}

function asCommandSurfaceWithApprovalStats(
  value: unknown,
): AgentCommandSurfaceTarget & { approvalStats: { asked: number; approved: number; denied: number } } {
  return value as AgentCommandSurfaceTarget & {
    approvalStats: { asked: number; approved: number; denied: number };
  };
}

function asRuntimeEventsTarget(value: unknown): AgentRuntimeEventsTarget {
  return value as AgentRuntimeEventsTarget;
}

function asTurnLoopTarget(value: unknown): TurnLoopTarget {
  return value as TurnLoopTarget;
}

function asReplayTarget(value: unknown): ReplayTarget {
  return value as ReplayTarget;
}

function normalizeDecisionScope(
  value: string,
): Parameters<typeof explainAgentDecision>[1] {
  return value === "route"
    || value === "model"
    || value === "tool"
    || value === "plan"
    || value === "verifier"
    ? value
    : "overview";
}
