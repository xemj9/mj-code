import path from "node:path";

import { buildRuntimeContinuitySnapshot } from "./agent-runtime.mjs";
import {
  buildAgentReplay,
  captureAgentStateSnapshot,
  hydrateAgentState,
} from "./agent-session-ops.mjs";
import type { CapabilityRegistryLike } from "./capability-registry.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";

import type { LoadedConfig } from "../config.mjs";
import type {
  ChangeSetSummary,
  ExecutionPlan,
  InstructionPack,
  JobRecord,
  ModelDecision,
  RouteDecision,
  RuntimeHealthOverview,
  SessionReplay,
  SkillInfluenceEntry,
  TaskClassification,
  TraceSummary,
} from "../types/contracts.js";

interface SessionStoreLike {
  buildReplay(reference: string): Promise<SessionReplay>;
  resolveSessionPath(reference: string): Promise<string>;
  resume(reference: string, metadata?: Record<string, unknown>): Promise<{
    filePath: string;
    sessionId: string;
    parentSessionId: string | null;
  }>;
  append(type: string, payload?: unknown): Promise<unknown>;
}

type ExecutionJournalLike = Pick<
  SharedExecutionJournalLike,
  "start" | "recordPhase" | "writeStateSnapshot" | "listPhases" | "loadLatestSnapshot" | "readEntries"
>;

interface ContextManagerLike {
  getRollingSummary(): string;
  getLastPlan(): unknown;
  hydrate(input: {
    rollingSummary?: string;
    lastPlan?: unknown;
  }): void;
}

interface MemoryStoreLike {
  initialize(input: {
    sessionFilePath: string;
    projectInstructions?: { files?: string[] } | null;
  }): Promise<void>;
  listSnapshot(): Promise<unknown>;
}

interface SourceRegistryLike {
  initialize(sessionId: string): Promise<void>;
  exportState(): unknown;
  hydrate(input: unknown): void;
  getLastPack(): unknown;
}

interface RuntimeHealthLike {
  getOverview(): RuntimeHealthOverview;
  listCircuits(layer?: "all"): unknown[];
}

interface SkillLoaderLike {
  getInfluenceSummary(): SkillInfluenceEntry[];
}

interface PolicyStackLike {
  getEffectivePolicy(): {
    sources: unknown[];
    [key: string]: unknown;
  };
}

interface McpRegistryLike {
  listServers(): Array<{
    id: string;
    status: string;
    healthScore: number;
    latencyMs: number | null;
  }>;
}

interface JobStoreLike {
  listJobs(options?: { limit?: number }): Promise<JobRecord[]>;
}

interface SnapshotCaptureInput {
  traceId: string | null;
  phase: string;
  stepId: string | number;
  outputSummary: string;
}

export interface SessionContinuityAgentLike {
  config: Pick<
    LoadedConfig,
    | "provider"
    | "model"
    | "cwd"
    | "permissionMode"
    | "approvalPolicy"
    | "networkMode"
    | "webProvider"
  >;
  projectInstructions: InstructionPack;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  sourceRegistry: SourceRegistryLike;
  memoryStore: MemoryStoreLike;
  contextManager: ContextManagerLike;
  runtimeHealth: RuntimeHealthLike;
  jobStore: JobStoreLike;
  capabilityRegistry: CapabilityRegistryLike;
  skillLoader: SkillLoaderLike;
  policyStack: PolicyStackLike;
  mcpRegistry: McpRegistryLike;
  sessionId: string | null;
  parentSessionId: string | null;
  resumedFromSessionId: string | null;
  resumeSnapshotPath: string | null;
  inheritedRuntimeContinuity: unknown;
  messages: unknown[];
  usageTotals: Record<string, unknown>;
  approvalStats: Record<string, unknown>;
  providerRuntimeStats: Record<string, unknown>;
  shellRuntimeStats: Record<string, unknown>;
  webRuntimeStats: Record<string, unknown>;
  mcpRuntimeStats: Record<string, unknown>;
  lastChangeSet: ChangeSetSummary | Record<string, unknown> | null;
  lastTaskClassification: TaskClassification | null;
  lastRouteDecision: RouteDecision | null;
  lastModelDecision: ModelDecision | null;
  lastExecutionPlan: ExecutionPlan | null;
  lastTrace: TraceSummary | null;
  sessionFilePath: string | null;
  bindRuntimeSession(): Promise<void>;
}

export async function replayAgentSession(
  agent: Pick<SessionContinuityAgentLike, "sessionStore" | "executionJournal">,
  reference: string,
): Promise<SessionReplay & {
  phases: unknown[];
  shellEvents: unknown[];
  runtimeContinuity: unknown;
}> {
  return buildAgentReplay({
    sessionStore: agent.sessionStore,
    executionJournal: agent.executionJournal,
  }, reference);
}

export async function resumeAgentSession(
  agent: SessionContinuityAgentLike,
  reference: string,
): Promise<{
  sessionId: string;
  sessionFilePath: string;
  parentSessionId: string | null;
  snapshot: string;
}> {
  const parentSessionId = path.basename(
    await agent.sessionStore.resolveSessionPath(reference),
    ".jsonl",
  );
  const snapshot = await agent.executionJournal.loadLatestSnapshot(parentSessionId);
  const branch = await agent.sessionStore.resume(reference, {
    cwd: agent.config.cwd,
    provider: agent.config.provider,
    model: agent.config.model,
    permissionMode: agent.config.permissionMode,
    approvalPolicy: agent.config.approvalPolicy,
    networkMode: agent.config.networkMode,
    webProvider: agent.config.webProvider,
    resumedFromSnapshot: snapshot?.filePath ?? null,
  });
  const sessionFilePath = branch.filePath;
  const sessionId = branch.sessionId;
  await agent.sourceRegistry.initialize(sessionId);
  await agent.memoryStore.initialize({
    sessionFilePath,
    projectInstructions: agent.projectInstructions,
  });
  await agent.executionJournal.start(sessionId, {
    provider: agent.config.provider,
    model: agent.config.model,
    cwd: agent.config.cwd,
    parentSessionId: branch.parentSessionId,
    resumedFromSnapshot: snapshot?.filePath ?? null,
  });
  if (!snapshot?.state) {
    throw new Error(`No resumable snapshot found for session "${reference}".`);
  }

  agent.sessionFilePath = sessionFilePath;
  agent.sessionId = sessionId;
  agent.parentSessionId = branch.parentSessionId;
  agent.resumedFromSessionId = branch.parentSessionId;
  agent.resumeSnapshotPath = snapshot.filePath;
  hydrateAgentSessionState(agent, snapshot.state);
  await agent.bindRuntimeSession();
  await agent.sessionStore.append("resume_state_loaded", {
    parentSessionId: branch.parentSessionId,
    snapshot: snapshot.filePath,
  });
  await captureAgentSessionSnapshot(agent, {
    traceId: null,
    phase: "planning",
    stepId: "resume",
    outputSummary: "Resumed session initialized.",
  });
  return {
    sessionId,
    sessionFilePath,
    parentSessionId: branch.parentSessionId,
    snapshot: snapshot.filePath,
  };
}

export async function captureAgentSessionSnapshot(
  agent: SessionContinuityAgentLike,
  input: SnapshotCaptureInput,
): Promise<string> {
  return captureAgentStateSnapshot({
    sessionId: agent.sessionId,
    resumedFromSessionId: agent.resumedFromSessionId,
    parentSessionId: agent.parentSessionId,
    resumeSnapshotPath: agent.resumeSnapshotPath,
    config: agent.config,
    messages: agent.messages,
    contextManager: agent.contextManager,
    usageTotals: agent.usageTotals,
    approvalStats: agent.approvalStats,
    providerRuntimeStats: agent.providerRuntimeStats,
    shellRuntimeStats: agent.shellRuntimeStats,
    webRuntimeStats: agent.webRuntimeStats,
    mcpRuntimeStats: agent.mcpRuntimeStats,
    lastChangeSet: agent.lastChangeSet,
    lastTaskClassification: agent.lastTaskClassification,
    lastRouteDecision: agent.lastRouteDecision,
    lastModelDecision: agent.lastModelDecision,
    lastExecutionPlan: agent.lastExecutionPlan,
    lastTrace: agent.lastTrace,
    capabilityRegistry: agent.capabilityRegistry,
    skillLoader: agent.skillLoader,
    policyStack: agent.policyStack,
    buildRuntimeContinuitySnapshot: async () => buildAgentSessionRuntimeContinuity(agent),
    sourceRegistry: agent.sourceRegistry,
    memoryStore: agent.memoryStore,
    executionJournal: agent.executionJournal,
  }, input);
}

export function hydrateAgentSessionState(
  agent: SessionContinuityAgentLike,
  snapshot: Record<string, unknown>,
): void {
  hydrateAgentState(agent, snapshot);
}

export async function buildAgentSessionRuntimeContinuity(
  agent: Pick<
    SessionContinuityAgentLike,
    | "sessionId"
    | "parentSessionId"
    | "projectInstructions"
    | "runtimeHealth"
    | "jobStore"
    | "sourceRegistry"
    | "capabilityRegistry"
    | "skillLoader"
    | "policyStack"
    | "mcpRegistry"
    | "lastTaskClassification"
    | "lastRouteDecision"
    | "lastModelDecision"
    | "lastExecutionPlan"
  >,
): Promise<Record<string, unknown>> {
  return buildRuntimeContinuitySnapshot({
    sessionId: agent.sessionId,
    parentSessionId: agent.parentSessionId,
    projectInstructions: agent.projectInstructions,
    runtimeHealth: agent.runtimeHealth,
    jobStore: agent.jobStore,
    sourceRegistry: agent.sourceRegistry,
    capabilityRegistry: agent.capabilityRegistry,
    skillLoader: agent.skillLoader,
    policyStack: agent.policyStack,
    mcpRegistry: agent.mcpRegistry,
    lastTaskClassification: agent.lastTaskClassification,
    lastRouteDecision: agent.lastRouteDecision,
    lastModelDecision: agent.lastModelDecision,
    lastExecutionPlan: agent.lastExecutionPlan,
  });
}
