import {
  createAgentComponents,
  createInitialAgentStats,
  type AgentComponentBundle,
  type AgentStatsBundle,
} from "./agent-components.mjs";

import type { LoadedConfig } from "../config.mjs";
import type { ProviderAdapter } from "../providers/index.mjs";
import type { AgentTerminalUi } from "../types/agent-facade.js";
import type {
  ExecutionPlan,
  InstructionPack,
  ModelDecision,
  RepairLoopRecord,
  RouteDecision,
  TaskClassification,
  TraceSummary,
  VerifierRunRecord,
} from "../types/contracts.js";
import type { RuntimeHealth } from "./runtime-health.mjs";

type ProviderLike = ProviderAdapter;

export interface AgentConstructionTarget {
  recordMcpEvent(event: Record<string, unknown>): Promise<void>;
  recordShellEvent(event: Record<string, unknown>): Promise<void>;
  recordHookEvent(event: Record<string, unknown>): Promise<void>;
}

export interface AgentConstructionState extends AgentComponentBundle, AgentStatsBundle {
  config: LoadedConfig;
  ui: AgentTerminalUi;
  messages: unknown[];
  provider: ProviderLike;
  projectInstructions: InstructionPack;
  baseSystemPrompt: string;
  sessionFilePath: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  resumedFromSessionId: string | null;
  resumeSnapshotPath: string | null;
  inheritedRuntimeContinuity: unknown;
  lastChangeSet: null;
  lastTaskClassification: TaskClassification | null;
  lastRouteDecision: RouteDecision | null;
  lastModelDecision: ModelDecision | null;
  lastExecutionPlan: ExecutionPlan | null;
  lastTrace: TraceSummary | null;
  traceHistory: TraceSummary[];
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
}

interface AgentConstructionInput {
  config: LoadedConfig;
  ui: AgentTerminalUi;
  provider: ProviderLike;
  projectInstructions: InstructionPack;
  runtimeHealth: RuntimeHealth | null;
}

export function buildAgentConstructionState(
  target: AgentConstructionTarget,
  input: AgentConstructionInput,
): AgentConstructionState {
  const components = createAgentComponents(
    input.config,
    input.provider,
    input.runtimeHealth,
    {
      onMcpEvent: async (event) => {
        await target.recordMcpEvent(event);
      },
      onShellEvent: async (event) => {
        await target.recordShellEvent(event);
      },
      onHookEvent: async (event) => {
        await target.recordHookEvent(event);
      },
    },
  );
  const stats = createInitialAgentStats();

  return {
    config: input.config,
    ui: input.ui,
    messages: [],
    provider: input.provider,
    projectInstructions: input.projectInstructions,
    ...components,
    baseSystemPrompt: "",
    sessionFilePath: null,
    sessionId: null,
    parentSessionId: null,
    resumedFromSessionId: null,
    resumeSnapshotPath: null,
    inheritedRuntimeContinuity: null,
    ...stats,
    lastChangeSet: null,
    lastTaskClassification: null,
    lastRouteDecision: null,
    lastModelDecision: null,
    lastExecutionPlan: null,
    lastTrace: null,
    traceHistory: [],
    lastVerifierRun: null,
    lastRepairLoop: null,
  };
}
