import crypto from "node:crypto";

import type { CapabilityRegistryLike } from "./capability-registry.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";
import { summarizeAgentInstructions } from "./agent-instruction-assembly.mjs";
import { summarizeChangeSet } from "./change-set.mjs";
import {
  summarizeText,
  summarizeToolResult,
} from "./agent-utils.mjs";

import type {
  ChangeSetRecord,
  ChangeSetSummary,
  ExecutionPlan,
  InstructionPack,
  ModelDecision,
  RepairLoopRecord,
  RouteDecision,
  RuntimeHealthOverview,
  RuntimeHealthScorecard,
  SkillInfluenceEntry,
  SkillListEntry,
  TaskClassification,
  TraceSummary,
  VerifierRunRecord,
} from "../types/contracts.js";

export interface AgentTraceState {
  traceId: string;
  prompt: string;
  startedAt: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolEvents: Array<Record<string, unknown>>;
  filesChanged: Set<string>;
  approvalsAsked: number;
  approvalsApproved: number;
  approvalsDenied: number;
  providerAttempts: number;
  providerRetries: number;
  providerFallbacks: number;
  modelFallbacks: number;
  providerEvents: Array<Record<string, unknown>>;
  providerMeta: Record<string, unknown> | null;
  shellJobs: Array<Record<string, unknown>>;
  skillInfluence: SkillInfluenceEntry[];
  policySources: unknown;
  taskClassification: TaskClassification | null;
  routeDecision: RouteDecision | null;
  modelDecision: ModelDecision | null;
  executionPlan: ExecutionPlan | null;
  sourceCitations: unknown[];
  sourceIds: string[];
  mcpCalls: Array<Record<string, unknown>>;
  webRequests: number;
  webRetries: number;
  webCacheHits: number;
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
  durations: {
    contextPrepareMs: number;
    modelCompleteMs: number;
    toolExecuteMs: number;
  };
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "readEntries" | "recordPhase">;

interface RuntimeHealthLike {
  getOverview(): RuntimeHealthOverview;
  listCircuits(layer?: "all"): unknown[];
  getScorecard(): RuntimeHealthScorecard;
}

interface SkillLoaderLike {
  getInfluenceSummary(): SkillInfluenceEntry[];
  listSkills(): SkillListEntry[];
}

interface PluginLoaderLike {
  listPlugins(): unknown[];
}

interface PolicyStackLike {
  getEffectivePolicy(): {
    sources: unknown[];
    [key: string]: unknown;
  };
}

interface McpRegistryLike {
  listServers(): unknown[];
  listTools(): unknown[];
}

interface ContextManagerLike {
  getLastPlan(): unknown;
}

interface SessionStoreLike {
  append(type: string, payload?: unknown): Promise<unknown>;
}

interface StandaloneToolExecutionResult {
  ok: boolean;
  error?: string;
  result?: unknown;
}

export interface AgentObservabilityLike {
  config: {
    provider: string | null;
    model: string | null;
    streamOutput?: boolean;
    cwd: string;
    permissionMode: string;
    approvalPolicy: string;
    networkMode: string;
    webProvider: string;
    webRankingMode?: string;
    mcpEnabled?: boolean;
    availableModels?: string[];
    modelDiscoveryError?: unknown;
  };
  projectInstructions: InstructionPack;
  sessionId: string | null;
  parentSessionId: string | null;
  sessionFilePath: string | null;
  resumeSnapshotPath: string | null;
  inheritedRuntimeContinuity: unknown;
  nativeToolCalling: boolean;
  messages: unknown[];
  usageTotals: Record<string, unknown>;
  approvalStats: Record<string, unknown>;
  providerRuntimeStats: Record<string, unknown>;
  shellRuntimeStats: Record<string, unknown>;
  webRuntimeStats: Record<string, unknown>;
  mcpRuntimeStats: Record<string, unknown>;
  lastChangeSet: ChangeSetSummary | ChangeSetRecord | Record<string, unknown> | null;
  lastTaskClassification: TaskClassification | null;
  lastRouteDecision: RouteDecision | null;
  lastModelDecision: ModelDecision | null;
  lastExecutionPlan: ExecutionPlan | null;
  lastTrace: TraceSummary | null;
  traceHistory: TraceSummary[];
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
  runtimeHealth: RuntimeHealthLike;
  capabilityRegistry: CapabilityRegistryLike;
  policyStack: PolicyStackLike;
  skillLoader: SkillLoaderLike;
  pluginLoader: PluginLoaderLike;
  sourceRegistry: {
    getLastPack(): unknown;
  };
  mcpRegistry: McpRegistryLike;
  contextManager: ContextManagerLike;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  handleToolExecution(input: {
    toolName: string;
    input?: Record<string, unknown>;
    toolCallId: string | null;
    turnState: AgentTraceState;
    step: number;
    nativeToolCall: boolean;
  }): Promise<StandaloneToolExecutionResult>;
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): Promise<unknown>;
}

interface FinalizeTraceInput {
  content: string;
  success: boolean;
  stopped: boolean;
  steps: number;
  errorTaxonomy?: string | null;
}

export function startAgentTrace(
  agent: Pick<AgentObservabilityLike, "skillLoader" | "policyStack">,
  prompt: string,
): AgentTraceState {
  return {
    traceId: crypto.randomUUID().slice(0, 12),
    prompt,
    startedAt: Date.now(),
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    toolEvents: [],
    filesChanged: new Set(),
    approvalsAsked: 0,
    approvalsApproved: 0,
    approvalsDenied: 0,
    providerAttempts: 0,
    providerRetries: 0,
    providerFallbacks: 0,
    modelFallbacks: 0,
    providerEvents: [],
    providerMeta: null,
    shellJobs: [],
    skillInfluence: agent.skillLoader.getInfluenceSummary(),
    policySources: agent.policyStack.getEffectivePolicy().sources,
    taskClassification: null,
    routeDecision: null,
    modelDecision: null,
    executionPlan: null,
    sourceCitations: [],
    sourceIds: [],
    mcpCalls: [],
    webRequests: 0,
    webRetries: 0,
    webCacheHits: 0,
    lastVerifierRun: null,
    lastRepairLoop: null,
    durations: {
      contextPrepareMs: 0,
      modelCompleteMs: 0,
      toolExecuteMs: 0,
    },
  };
}

export async function finalizeAgentTrace(
  agent: Pick<
    AgentObservabilityLike,
    "runtimeHealth" | "executionJournal" | "captureStateSnapshot" | "traceHistory"
  > & {
    lastTrace: TraceSummary | null;
  },
  turnState: AgentTraceState,
  { content, success, stopped, steps, errorTaxonomy = null }: FinalizeTraceInput,
): Promise<void> {
  const durationMs = Date.now() - turnState.startedAt;
  const trace: TraceSummary = {
    traceId: turnState.traceId,
    success,
    stopped,
    steps,
    durationMs,
    modelCalls: turnState.modelCalls,
    promptTokens: turnState.promptTokens,
    completionTokens: turnState.completionTokens,
    totalTokens: turnState.totalTokens,
    toolsUsed: [...new Set(turnState.toolEvents.map((event) => `${event.tool ?? ""}`).filter(Boolean))],
    approvalsAsked: turnState.approvalsAsked,
    approvalsApproved: turnState.approvalsApproved,
    approvalsDenied: turnState.approvalsDenied,
    providerAttempts: turnState.providerAttempts,
    providerRetries: turnState.providerRetries,
    providerFallbacks: turnState.providerFallbacks,
    modelFallbacks: turnState.modelFallbacks,
    providerMeta: turnState.providerMeta,
    shellJobs: turnState.shellJobs,
    skillInfluence: turnState.skillInfluence,
    policySources: turnState.policySources,
    taskClassification: turnState.taskClassification,
    routeDecision: turnState.routeDecision,
    modelDecision: turnState.modelDecision,
    executionPlan: turnState.executionPlan,
    mcpCalls: turnState.mcpCalls,
    webRequests: turnState.webRequests,
    webRetries: turnState.webRetries,
    webCacheHits: turnState.webCacheHits,
    sourceIds: [...new Set(turnState.sourceIds)],
    filesChanged: [...turnState.filesChanged],
    durations: turnState.durations,
    verifier: turnState.lastVerifierRun?.summary ?? null,
    repair: turnState.lastRepairLoop?.summary ?? null,
    errorTaxonomy,
    runtimeScorecard: agent.runtimeHealth.getScorecard(),
    finalSummary: summarizeText(content, 180),
  };
  agent.lastTrace = trace;
  agent.traceHistory = [trace, ...agent.traceHistory].slice(0, 20);
  await agent.executionJournal.recordPhase({
    traceId: turnState.traceId,
    stepId: steps,
    phase: "finalize",
    outputSummary: summarizeText(content, 180),
    metrics: trace,
    snapshot: await agent.captureStateSnapshot({
      traceId: turnState.traceId,
      phase: "finalize",
      stepId: steps,
      outputSummary: "Turn finalized.",
    }),
  });
}

export async function getAgentTrace(
  agent: Pick<
    AgentObservabilityLike,
    | "executionJournal"
    | "sessionId"
    | "lastTrace"
    | "traceHistory"
    | "runtimeHealth"
    | "lastTaskClassification"
    | "lastRouteDecision"
    | "lastModelDecision"
    | "lastExecutionPlan"
    | "capabilityRegistry"
    | "policyStack"
    | "projectInstructions"
    | "inheritedRuntimeContinuity"
  >,
  which: "last" | "all" = "last",
): Promise<Record<string, unknown>> {
  const entries = await agent.executionJournal.readEntries(agent.sessionId ?? "").catch(() => []);
  const providerEvents = entries.filter((entry) => entry.type === "provider_event").slice(-100);
  const shellEvents = entries.filter((entry) => entry.type === "shell_job_event").slice(-100);
  const webEvents = entries.filter((entry) => entry.type === "web_event").slice(-100);
  const mcpEvents = entries.filter((entry) => entry.type === "mcp_event").slice(-150);
  const hookEvents = entries.filter((entry) => entry.type === "hook_event").slice(-150);
  const verifierRuns = entries.filter((entry) => entry.type === "verifier_run").slice(-50);
  const repairLoops = entries.filter((entry) => entry.type === "repair_loop").slice(-50);
  const boundaryDecisions = entries
    .filter((entry) => entry.type === "execution_boundary_decision")
    .slice(-150);
  const phases = entries.filter((entry) => entry.type === "phase").slice(-200);
  const base = {
    current: agent.lastTrace,
    runtimeHealth: agent.runtimeHealth.getOverview(),
    runtimeContinuity: agent.inheritedRuntimeContinuity ?? null,
    circuits: agent.runtimeHealth.listCircuits("all"),
    taskClassification: agent.lastTaskClassification,
    routeDecision: agent.lastRouteDecision,
    modelDecision: agent.lastModelDecision,
    executionPlan: agent.lastExecutionPlan,
    capabilities: agent.capabilityRegistry.describe(),
    policy: agent.policyStack.getEffectivePolicy(),
    instructions: summarizeAgentInstructions(agent.projectInstructions),
    phases,
    providerEvents,
    shellEvents,
    webEvents,
    mcpEvents,
    hookEvents,
    verifierRuns,
    repairLoops,
    boundaryDecisions,
  };

  if (which === "last") {
    return base;
  }

  return {
    ...base,
    history: agent.traceHistory,
  };
}

export function getAgentUsageSummary(
  agent: Pick<
    AgentObservabilityLike,
    | "usageTotals"
    | "approvalStats"
    | "providerRuntimeStats"
    | "shellRuntimeStats"
    | "webRuntimeStats"
    | "mcpRuntimeStats"
    | "contextManager"
    | "lastTrace"
    | "lastTaskClassification"
    | "lastRouteDecision"
    | "lastModelDecision"
    | "lastExecutionPlan"
    | "runtimeHealth"
    | "capabilityRegistry"
    | "policyStack"
    | "skillLoader"
    | "pluginLoader"
    | "lastChangeSet"
    | "sourceRegistry"
    | "mcpRegistry"
    | "projectInstructions"
    | "inheritedRuntimeContinuity"
    | "lastVerifierRun"
    | "lastRepairLoop"
  >,
): Record<string, unknown> {
  return {
    ...agent.usageTotals,
    approvals: agent.approvalStats,
    providerRuntime: agent.providerRuntimeStats,
    shellRuntime: agent.shellRuntimeStats,
    webRuntime: agent.webRuntimeStats,
    mcpRuntime: agent.mcpRuntimeStats,
    instructions: summarizeAgentInstructions(agent.projectInstructions),
    runtimeContinuity: agent.inheritedRuntimeContinuity ?? null,
    lastContextPlan: agent.contextManager.getLastPlan(),
    lastTrace: agent.lastTrace,
    taskClassification: agent.lastTaskClassification,
    routeDecision: agent.lastRouteDecision,
    modelDecision: agent.lastModelDecision,
    executionPlan: agent.lastExecutionPlan,
    runtimeHealth: agent.runtimeHealth.getOverview(),
    runtimeCircuits: agent.runtimeHealth.listCircuits("all"),
    capabilitySurface: agent.capabilityRegistry.getSurfaceMap(),
    policy: agent.policyStack.getEffectivePolicy(),
    skills: agent.skillLoader.getInfluenceSummary(),
    plugins: agent.pluginLoader.listPlugins(),
    lastChangeSet: summarizeAgentChangeSet(agent.lastChangeSet),
    lastSourcePack: agent.sourceRegistry.getLastPack(),
    mcpServers: agent.mcpRegistry.listServers(),
    lastVerifierRun: agent.lastVerifierRun,
    lastRepairLoop: agent.lastRepairLoop,
  };
}

export function getAgentStatus(
  agent: Pick<
    AgentObservabilityLike,
    | "config"
    | "nativeToolCalling"
    | "sessionId"
    | "parentSessionId"
    | "sessionFilePath"
    | "resumeSnapshotPath"
    | "projectInstructions"
    | "usageTotals"
    | "approvalStats"
    | "providerRuntimeStats"
    | "shellRuntimeStats"
    | "webRuntimeStats"
    | "mcpRuntimeStats"
    | "runtimeHealth"
    | "inheritedRuntimeContinuity"
    | "contextManager"
    | "lastTaskClassification"
    | "lastRouteDecision"
    | "lastModelDecision"
    | "lastExecutionPlan"
    | "capabilityRegistry"
    | "skillLoader"
    | "pluginLoader"
    | "policyStack"
    | "lastChangeSet"
    | "sourceRegistry"
    | "mcpRegistry"
    | "lastTrace"
    | "lastVerifierRun"
    | "lastRepairLoop"
  >,
): Record<string, unknown> {
  const instructions = summarizeAgentInstructions(agent.projectInstructions);
  return {
    provider: agent.config.provider,
    model: agent.config.model,
    streamOutput: agent.config.streamOutput,
    cwd: agent.config.cwd,
    permissionMode: agent.config.permissionMode,
    approvalPolicy: agent.config.approvalPolicy,
    networkMode: agent.config.networkMode,
    webProvider: agent.config.webProvider,
    webRankingMode: agent.config.webRankingMode,
    mcpEnabled: agent.config.mcpEnabled,
    nativeToolCalling: agent.nativeToolCalling,
    sessionId: agent.sessionId,
    parentSessionId: agent.parentSessionId,
    sessionFilePath: agent.sessionFilePath,
    resumeSnapshotPath: agent.resumeSnapshotPath,
    instructionFiles: agent.projectInstructions.files,
    instructions,
    availableModels: agent.config.availableModels ?? [],
    modelDiscoveryError: agent.config.modelDiscoveryError,
    usage: agent.usageTotals,
    approvals: agent.approvalStats,
    providerRuntime: agent.providerRuntimeStats,
    shellRuntime: agent.shellRuntimeStats,
    webRuntime: agent.webRuntimeStats,
    mcpRuntime: agent.mcpRuntimeStats,
    runtimeHealth: agent.runtimeHealth.getOverview(),
    runtimeCircuits: agent.runtimeHealth.listCircuits("all"),
    inheritedRuntimeContinuity: agent.inheritedRuntimeContinuity,
    context: agent.contextManager.getLastPlan(),
    taskClassification: agent.lastTaskClassification,
    routeDecision: agent.lastRouteDecision,
    modelDecision: agent.lastModelDecision,
    executionPlan: agent.lastExecutionPlan,
    capabilitySurface: agent.capabilityRegistry.describe(),
    activeSkills: agent.skillLoader.getInfluenceSummary(),
    skills: agent.skillLoader.listSkills(),
    plugins: agent.pluginLoader.listPlugins(),
    policy: agent.policyStack.getEffectivePolicy(),
    lastChangeSet: summarizeAgentChangeSet(agent.lastChangeSet),
    lastSourcePack: agent.sourceRegistry.getLastPack(),
    mcpServers: agent.mcpRegistry.listServers(),
    mcpTools: agent.mcpRegistry.listTools().length,
    lastVerifierRun: agent.lastVerifierRun,
    lastRepairLoop: agent.lastRepairLoop,
    lastTrace: agent.lastTrace,
  };
}

export async function invokeStandaloneCommandTool(
  agent: Pick<
    AgentObservabilityLike,
    "sessionStore" | "handleToolExecution"
  > & {
    startTrace(prompt: string): AgentTraceState;
    finalizeTrace(turnState: AgentTraceState, input: FinalizeTraceInput): Promise<void>;
  },
  toolName: string,
  input?: Record<string, unknown>,
): Promise<unknown> {
  const turnState = agent.startTrace(`${toolName} ${JSON.stringify(input ?? {})}`);
  await agent.sessionStore.append("user", {
    content: `[tool:${toolName}] ${JSON.stringify(input ?? {})}`,
    traceId: turnState.traceId,
    standaloneTool: true,
  });
  const execution = await agent.handleToolExecution({
    toolName,
    input,
    toolCallId: null,
    turnState,
    step: 1,
    nativeToolCall: false,
  });

  if (!execution.ok) {
    const failure = execution.error ?? `Tool "${toolName}" failed.`;
    await agent.sessionStore.append("final", {
      traceId: turnState.traceId,
      content: failure,
      stopped: true,
      steps: 1,
      sourceIds: [...new Set(turnState.sourceIds)],
      standaloneTool: true,
    });
    await agent.finalizeTrace(turnState, {
      content: failure,
      success: false,
      stopped: true,
      steps: 1,
    });
    throw new Error(failure);
  }

  const summary = summarizeToolResult(execution.result);
  await agent.sessionStore.append("final", {
    traceId: turnState.traceId,
    content: summary,
    steps: 1,
    standaloneTool: true,
    sourceIds: [...new Set(turnState.sourceIds)],
  });
  await agent.finalizeTrace(turnState, {
    content: summary,
    success: true,
    stopped: false,
    steps: 1,
  });
  return execution.result;
}

function summarizeAgentChangeSet(
  value: ChangeSetSummary | ChangeSetRecord | Record<string, unknown> | null,
): ChangeSetSummary | Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (!isChangeSetRecord(value)) {
    return value;
  }
  return summarizeChangeSet(value);
}

function isChangeSetRecord(value: unknown): value is ChangeSetRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "id" in value &&
    "createdAt" in value &&
    "toolName" in value &&
    "dryRun" in value &&
    "_internal" in value;
}
