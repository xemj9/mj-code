import type {
  AgentDecisionReport,
  EvalRunRequest,
  EvalSuiteResult,
  PlanCurrentReport,
  PlanTimelineReport,
  InteractiveSessionPickerReport,
  SessionBrowserReport,
  SessionResumeRecommendationReport,
  VerifierBaselinePromotionHistory,
  VerifierBaselinePromotionPlanRecord,
  VerifierGitHubActionsBackfillInput,
  VerifierGitHubChecksPayload,
  VerifierGitHubMutationRecord,
  VerifierGitHubMutationSelection,
  VerifierDrilldownReport,
  VerifierTimelineReport,
  VerifierEvalArtifactRecord,
  VerifierInspectArtifactList,
  VerifierInspectArtifactPruneResult,
  VerifierInspectArtifactRecord,
  VerifierInspectArtifactRetentionPolicy,
  VerifierInspectCompareReport,
  VerifierInspectBaselineList,
  VerifierInspectBaselineRecord,
  VerifierInspectReference,
  VerifierRegressionGateDecision,
  VerifierRegressionGatePolicy,
  VerifierRegressionGatePolicyProfileId,
  VerifierRegressionGatePolicyProfileList,
  VerifierReleaseBundleRecord,
  VerifierReleaseHandoffSelection,
  ResolvedConfig,
  ToolRegistrySurface,
  VerifierInspectReport,
  VerifierInspectSnapshotList,
  VerifierInspectSnapshotRecord,
  VerifierReleaseTriageSummary,
} from "./contracts.js";

export type AgentJsonMap = Record<string, unknown>;

export interface AgentBootstrapOptions {
  cwd?: string;
  configPath?: string | null;
  overrides?: AgentJsonMap;
}

export interface AgentTailCursor {
  stdout: number;
  stderr: number;
}

export interface AgentTailOptions {
  maxChars?: number;
  cursor?: AgentTailCursor;
}

export interface AgentRunResult {
  content?: string;
  printed?: boolean;
}

export interface AgentResumeResult {
  sessionId: string;
  snapshot: string;
}

export interface AgentTerminalUi {
  printBanner(status: unknown, sessionFilePath: string | null): void;
  ask(prompt: string): Promise<string>;
  readBatchLines?(): AsyncIterable<string> | null;
  setInteractiveResolver?(
    resolver: ((line: string) => Promise<InteractiveSessionPickerReport | null> | InteractiveSessionPickerReport | null) | null,
  ): void;
  printError(message: string): void;
  printInfo(tag: string, message: string): void;
  close(): void;
}

export interface AgentFacade {
  config: ResolvedConfig;
  ui: AgentTerminalUi;
  sessionFilePath: string | null;
  toolRegistry: ToolRegistrySurface;
  close?(): Promise<void> | void;
  getMemorySnapshot(): Promise<unknown>;
  inspectCapability(id: string): unknown;
  getCapabilities(filters?: AgentJsonMap): unknown;
  getRoute(which?: "last" | "all"): unknown;
  getExecutionPlan(which?: "last" | "all"): unknown;
  getPlanCurrent(): Promise<PlanCurrentReport>;
  getPlanTimeline(reference?: string): Promise<PlanTimelineReport>;
  previewRoute(prompt: string): { executionPlan: unknown; [key: string]: unknown };
  explainWhy(scope?: string, reference?: string): Promise<AgentDecisionReport>;
  getNextDecision(reference?: string): Promise<AgentDecisionReport>;
  getRecoveryDecision(reference?: string): Promise<AgentDecisionReport>;
  runEval(input?: string | EvalRunRequest): EvalSuiteResult;
  getModelDecision(): unknown;
  getProviderDecision(): unknown;
  getSkills(): unknown;
  inspectSkill(skillId: string): unknown;
  enableSkill(skillId: string): Promise<unknown>;
  disableSkill(skillId: string): Promise<unknown>;
  getPlugins(): unknown;
  inspectPlugin(pluginId: string): unknown;
  enablePlugin(pluginId: string): Promise<unknown>;
  disablePlugin(pluginId: string): Promise<unknown>;
  listSessions(limit?: number): Promise<unknown>;
  browseSessionHistory(
    scope?: "all" | "changes" | "sessions" | "lineage" | "replay",
    reference?: string,
  ): Promise<SessionBrowserReport>;
  recommendSessionResume(reference?: string): Promise<SessionResumeRecommendationReport>;
  listJobs(status?: string | null, limit?: number): Promise<unknown>;
  tailJob(jobId: string, options?: number | AgentTailOptions): Promise<unknown>;
  attachJob(jobId: string, options?: AgentTailOptions): Promise<unknown>;
  cancelJob(jobId: string): Promise<unknown>;
  getShellHistory(limit?: number): Promise<unknown>;
  inspectSource(sourceId: string, which?: string): Promise<unknown>;
  getSources(which?: string): Promise<unknown>;
  getNetworkMode(): unknown;
  getMcpServers(): unknown;
  getMcpTools(): unknown;
  inspectMcpServer(serverId: string): unknown;
  testMcpServer(serverId: string): Promise<unknown>;
  getRuntimeHealth(): unknown;
  getRuntimeCircuits(): unknown;
  inspectRuntimeLayer(layer?: string): unknown;
  replaySession(reference: string): Promise<unknown>;
  getVerifierReport(which?: "current" | "trace"): Promise<VerifierInspectReport>;
  inspectVerifierReplay(reference: string): Promise<VerifierInspectReport>;
  exportVerifierReport(reference?: VerifierInspectReference): Promise<VerifierInspectSnapshotRecord>;
  listVerifierSnapshots(limit?: number): Promise<VerifierInspectSnapshotList>;
  pinVerifierBaseline(
    reference: VerifierInspectReference,
    name: string,
    options?: { policyProfileId?: VerifierRegressionGatePolicyProfileId | null },
  ): Promise<VerifierInspectBaselineRecord>;
  listVerifierBaselines(limit?: number): Promise<VerifierInspectBaselineList>;
  planVerifierBaselinePromotion(
    baselineName: string,
    reference?: string,
    options?: { policyProfileId?: VerifierRegressionGatePolicyProfileId | null },
  ): Promise<VerifierBaselinePromotionPlanRecord>;
  approveVerifierBaselinePromotion(
    reference: string,
    options?: {
      approverKind?: "operator" | "automation" | "workflow";
      approverId?: string | null;
      approvalSource?: "cli" | "workflow_dispatch" | "schedule" | "pull_request" | "automation";
      approvalMode?: "explicit_apply" | "workflow_apply";
      approverDisplayName?: string | null;
    },
  ): Promise<VerifierBaselinePromotionPlanRecord>;
  applyVerifierGitHubMutation(
    reference?: string,
    options?: {
      githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<VerifierGitHubMutationRecord>;
  inspectVerifierGitHubMutation(reference?: string): Promise<VerifierGitHubMutationSelection>;
  listVerifierBaselinePromotionHistory(
    baselineName: string,
  ): Promise<VerifierBaselinePromotionHistory>;
  listVerifierGatePolicyProfiles(): Promise<VerifierRegressionGatePolicyProfileList>;
  listVerifierArtifacts(limit?: number): Promise<VerifierInspectArtifactList>;
  inspectVerifierArtifact(artifactId: string): Promise<VerifierInspectArtifactRecord>;
  inspectVerifierHandoff(reference?: string): Promise<VerifierReleaseHandoffSelection>;
  summarizeVerifierReleaseTriage(
    reference?: string,
    options?: { githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null },
  ): Promise<VerifierReleaseTriageSummary>;
  drilldownVerifier(
    reference?: string,
    options?: { githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null },
  ): Promise<VerifierDrilldownReport>;
  timelineVerifier(
    reference?: string,
    options?: { githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null },
  ): Promise<VerifierTimelineReport>;
  exportVerifierGitHubChecksPayload(
    reference?: string,
    options?: {
      githubActionsBackfill?: VerifierGitHubActionsBackfillInput | null;
      name?: string | null;
    },
  ): Promise<VerifierGitHubChecksPayload>;
  exportVerifierBundle(reference?: string): Promise<VerifierReleaseBundleRecord>;
  compareVerifierReports(
    left: VerifierInspectReference,
    right: VerifierInspectReference,
    options?: { writeArtifact?: boolean; writeBundle?: boolean },
  ): Promise<VerifierInspectCompareReport>;
  gateVerifierReports(
    left: VerifierInspectReference,
    right: VerifierInspectReference,
    policy?: VerifierRegressionGatePolicy,
    options?: {
      profileId?: VerifierRegressionGatePolicyProfileId | null;
      writeArtifact?: boolean;
      writeBundle?: boolean;
    },
  ): Promise<VerifierRegressionGateDecision>;
  writeVerifierEvalArtifact(
    result: EvalSuiteResult,
    options?: { writeBundle?: boolean },
  ): Promise<VerifierEvalArtifactRecord>;
  pruneVerifierArtifacts(
    policy?: Partial<VerifierInspectArtifactRetentionPolicy>,
  ): Promise<VerifierInspectArtifactPruneResult>;
  getStatus(): AgentJsonMap;
  listModels(): Promise<unknown>;
  runUserInput(prompt: string): Promise<AgentRunResult>;
  invokeCommandTool(name: string, input?: AgentJsonMap): Promise<unknown>;
  resumeFromSession(reference: string): Promise<AgentResumeResult>;
  getTrace(which?: string): Promise<unknown>;
  getApprovalMode(): unknown;
  compactConversation(): Promise<{ compactedMessages: number }>;
  getUsageSummary(): unknown;
  clearConversation(): void;
  searchMemory(query: string, scopes?: string[], limit?: number): Promise<unknown>;
  rememberMemory(input: AgentJsonMap): Promise<unknown>;
  listChangeHistory(): Promise<unknown>;
  getLastDiff(filePath?: string): unknown;
  undoChange(changeSetId?: string | null): Promise<unknown>;
}
