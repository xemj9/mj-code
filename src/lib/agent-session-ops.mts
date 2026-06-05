import path from "node:path";

import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";
import { summarizeChangeSet } from "./change-set.mjs";

import type {
  ChangeSetRecord,
  ChangeSetSummary,
  ExecutionPlan,
  ModelDecision,
  RouteDecision,
  RuntimeHealthOverview,
  SessionReplay,
  SkillInfluenceEntry,
  TaskClassification,
  TraceSummary,
} from "../types/contracts.js";

interface SnapshotConfig {
  provider: string | null;
  model: string | null;
  cwd: string;
  permissionMode: string;
  approvalPolicy: string;
  networkMode: string;
  webProvider: string;
}

interface ContextManagerLike {
  getRollingSummary(): string;
  getLastPlan(): unknown;
  hydrate(input: {
    rollingSummary?: string;
    lastPlan?: unknown;
  }): void;
}

interface SourceRegistryLike {
  exportState(): unknown;
  hydrate(input: unknown): void;
}

interface MemoryStoreLike {
  listSnapshot(): Promise<unknown>;
}

type ExecutionJournalLike = Pick<
  SharedExecutionJournalLike,
  "writeStateSnapshot" | "listPhases" | "loadLatestSnapshot" | "readEntries"
>;

interface SessionStoreLike {
  buildReplay(reference: string): Promise<SessionReplay>;
  resolveSessionPath(reference: string): Promise<string>;
}

interface CaptureStateInput {
  traceId: string | null;
  phase: string;
  stepId: string | number;
  outputSummary: string;
}

interface CaptureStateDependencies {
  sessionId: string | null;
  resumedFromSessionId: string | null;
  parentSessionId: string | null;
  resumeSnapshotPath: string | null;
  config: SnapshotConfig;
  messages: unknown[];
  contextManager: ContextManagerLike;
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
  capabilityRegistry: { getSurfaceMap(): unknown };
  skillLoader: { getInfluenceSummary(): SkillInfluenceEntry[] };
  policyStack: { getEffectivePolicy(): unknown };
  buildRuntimeContinuitySnapshot(): Promise<unknown>;
  sourceRegistry: SourceRegistryLike;
  memoryStore: MemoryStoreLike;
  executionJournal: ExecutionJournalLike;
}

interface HydrateStateTarget {
  messages: unknown[];
  usageTotals: Record<string, unknown>;
  approvalStats: Record<string, unknown>;
  providerRuntimeStats: Record<string, unknown>;
  shellRuntimeStats: Record<string, unknown>;
  webRuntimeStats: Record<string, unknown>;
  mcpRuntimeStats: Record<string, unknown>;
  lastChangeSet: unknown;
  lastTaskClassification: TaskClassification | null;
  lastRouteDecision: RouteDecision | null;
  lastModelDecision: ModelDecision | null;
  lastExecutionPlan: ExecutionPlan | null;
  lastTrace: TraceSummary | null;
  inheritedRuntimeContinuity: unknown;
  parentSessionId: string | null;
  resumeSnapshotPath: string | null;
  config: {
    model: string | null;
  };
  contextManager: ContextManagerLike;
  sourceRegistry: SourceRegistryLike;
}

interface SessionSnapshotRecord extends Record<string, unknown> {
  messages?: unknown[];
  rollingSummary?: string;
  lastPlan?: unknown;
  usageTotals?: Record<string, unknown>;
  approvalStats?: Record<string, unknown>;
  providerRuntimeStats?: Record<string, unknown>;
  shellRuntimeStats?: Record<string, unknown>;
  webRuntimeStats?: Record<string, unknown>;
  mcpRuntimeStats?: Record<string, unknown>;
  lastChangeSet?: unknown;
  lastTaskClassification?: TaskClassification | null;
  lastRouteDecision?: RouteDecision | null;
  lastModelDecision?: ModelDecision | null;
  lastExecutionPlan?: ExecutionPlan | null;
  lastTrace?: TraceSummary | null;
  runtimeContinuity?: unknown;
  parentSessionId?: string | null;
  resumeSnapshotPath?: string | null;
  sourceRegistry?: unknown;
  config?: {
    model?: string | null;
  };
}

export async function buildAgentReplay(
  dependencies: {
    sessionStore: SessionStoreLike;
    executionJournal: ExecutionJournalLike;
  },
  reference: string,
): Promise<SessionReplay & {
  phases: unknown[];
  shellEvents: unknown[];
  runtimeContinuity: unknown;
}> {
  const sessionReplay = await dependencies.sessionStore.buildReplay(reference);
  const sessionId = path.basename(
    await dependencies.sessionStore.resolveSessionPath(reference),
    ".jsonl",
  );
  const phases = await dependencies.executionJournal.listPhases(sessionId).catch(() => []);
  const snapshot = await dependencies.executionJournal.loadLatestSnapshot(sessionId).catch(() => null);
  const shellEvents = await dependencies.executionJournal.readEntries(sessionId)
    .then((entries) => entries.filter((entry) => entry.type === "shell_job_event"))
    .catch(() => []);

  return {
    ...sessionReplay,
    phases,
    shellEvents,
    runtimeContinuity: snapshot?.state?.runtimeContinuity ?? null,
  };
}

export async function captureAgentStateSnapshot(
  dependencies: CaptureStateDependencies,
  { traceId, phase, stepId, outputSummary }: CaptureStateInput,
): Promise<string> {
  const snapshot = {
    sessionId: dependencies.sessionId,
    resumedFromSessionId: dependencies.resumedFromSessionId,
    parentSessionId: dependencies.parentSessionId,
    resumeSnapshotPath: dependencies.resumeSnapshotPath,
    config: {
      provider: dependencies.config.provider,
      model: dependencies.config.model,
      cwd: dependencies.config.cwd,
      permissionMode: dependencies.config.permissionMode,
      approvalPolicy: dependencies.config.approvalPolicy,
      networkMode: dependencies.config.networkMode,
      webProvider: dependencies.config.webProvider,
    },
    messages: dependencies.messages,
    rollingSummary: dependencies.contextManager.getRollingSummary(),
    lastPlan: dependencies.contextManager.getLastPlan(),
    usageTotals: dependencies.usageTotals,
    approvalStats: dependencies.approvalStats,
    providerRuntimeStats: dependencies.providerRuntimeStats,
    shellRuntimeStats: dependencies.shellRuntimeStats,
    webRuntimeStats: dependencies.webRuntimeStats,
    mcpRuntimeStats: dependencies.mcpRuntimeStats,
    lastChangeSet: summarizeSnapshotChangeSet(dependencies.lastChangeSet),
    lastTaskClassification: dependencies.lastTaskClassification,
    lastRouteDecision: dependencies.lastRouteDecision,
    lastModelDecision: dependencies.lastModelDecision,
    lastExecutionPlan: dependencies.lastExecutionPlan,
    lastTrace: dependencies.lastTrace,
    capabilitySurface: dependencies.capabilityRegistry.getSurfaceMap(),
    skillInfluence: dependencies.skillLoader.getInfluenceSummary(),
    policy: dependencies.policyStack.getEffectivePolicy(),
    runtimeContinuity: await dependencies.buildRuntimeContinuitySnapshot(),
    sourceRegistry: dependencies.sourceRegistry.exportState(),
    memorySnapshot: await dependencies.memoryStore.listSnapshot(),
  };

  return dependencies.executionJournal.writeStateSnapshot(snapshot, {
    traceId,
    phase,
    stepId,
    outputSummary,
  });
}

export function hydrateAgentState(
  target: HydrateStateTarget,
  snapshot: SessionSnapshotRecord,
): void {
  target.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  target.contextManager.hydrate({
    rollingSummary: snapshot.rollingSummary,
    lastPlan: snapshot.lastPlan,
  });
  target.usageTotals = snapshot.usageTotals ?? target.usageTotals;
  target.approvalStats = snapshot.approvalStats ?? target.approvalStats;
  target.providerRuntimeStats = {
    ...target.providerRuntimeStats,
    ...(snapshot.providerRuntimeStats ?? {}),
  };
  target.shellRuntimeStats = snapshot.shellRuntimeStats ?? target.shellRuntimeStats;
  target.webRuntimeStats = snapshot.webRuntimeStats ?? target.webRuntimeStats;
  target.mcpRuntimeStats = snapshot.mcpRuntimeStats ?? target.mcpRuntimeStats;
  target.lastChangeSet = snapshot.lastChangeSet ?? null;
  target.lastTaskClassification = snapshot.lastTaskClassification ?? target.lastTaskClassification;
  target.lastRouteDecision = snapshot.lastRouteDecision ?? target.lastRouteDecision;
  target.lastModelDecision = snapshot.lastModelDecision ?? target.lastModelDecision;
  target.lastExecutionPlan = snapshot.lastExecutionPlan ?? target.lastExecutionPlan;
  target.lastTrace = snapshot.lastTrace ?? null;
  target.inheritedRuntimeContinuity = snapshot.runtimeContinuity ?? null;
  target.parentSessionId = snapshot.parentSessionId ?? target.parentSessionId;
  target.resumeSnapshotPath = snapshot.resumeSnapshotPath ?? target.resumeSnapshotPath;
  if (snapshot.sourceRegistry) {
    target.sourceRegistry.hydrate(snapshot.sourceRegistry);
  }
  if (snapshot.config?.model) {
    target.config.model = snapshot.config.model;
  }
}

function summarizeSnapshotChangeSet(
  value: ChangeSetSummary | ChangeSetRecord | Record<string, unknown> | null,
): ChangeSetSummary | null {
  if (!value) {
    return null;
  }
  if (isChangeSetRecord(value)) {
    return summarizeChangeSet(value);
  }
  return value as ChangeSetSummary;
}

function isChangeSetRecord(value: unknown): value is ChangeSetRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "id" in value &&
    "createdAt" in value &&
    "dryRun" in value &&
    "_internal" in value;
}
