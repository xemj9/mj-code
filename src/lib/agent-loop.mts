import { MJCodeAgentRuntimeSurface } from "./agent-runtime-surface.mjs";
import {
  buildAgentSessionRuntimeContinuity,
  captureAgentSessionSnapshot,
  hydrateAgentSessionState,
  resumeAgentSession,
} from "./agent-session-continuity.mjs";
import {
  createAgentSessionEntry,
  inspectAgentSessionEntry,
  resumeAgentSessionEntry,
  type AgentSessionEntryConstructor,
} from "./agent-session-entry.mjs";
import {
  finalizeAgentTrace,
  getAgentStatus,
  getAgentTrace,
  getAgentUsageSummary,
  invokeStandaloneCommandTool,
  startAgentTrace,
  type AgentTraceState,
} from "./agent-observability.mjs";

import type { LoadedConfig } from "../config.mjs";
import type { ProviderAdapter } from "../providers/index.mjs";
import type { AgentBootstrapOptions, AgentTerminalUi } from "../types/agent-facade.js";
import type {
  ChangeSetRecord,
  ExecutionPlan,
  InstructionPack,
  ModelDecision,
  RepairLoopRecord,
  RouteDecision,
  TaskClassification,
  ToolRegistrySurface,
  TraceSummary,
  VerifierRunRecord,
} from "../types/contracts.js";
import type { AgentComponentBundle, AgentStatsBundle } from "./agent-components.mjs";
import type { RuntimeHealth } from "./runtime-health.mjs";

type CaptureSnapshotResult = ReturnType<typeof captureAgentSessionSnapshot>;
type StartTraceResult = ReturnType<typeof startAgentTrace>;
type GetTraceResult = Awaited<ReturnType<typeof getAgentTrace>>;
type StatusResult = ReturnType<typeof getAgentStatus>;
type UsageSummaryResult = ReturnType<typeof getAgentUsageSummary>;
type InvokeCommandToolResult = ReturnType<typeof invokeStandaloneCommandTool>;
type BuildContinuityResult = ReturnType<typeof buildAgentSessionRuntimeContinuity>;
type AgentLoopEntryConstructor = AgentSessionEntryConstructor<MJCodeAgentCore>;
type ProviderLike = ProviderAdapter;
type ProjectInstructionsLike = InstructionPack;

export class MJCodeAgentCore extends MJCodeAgentRuntimeSurface {
  declare config: LoadedConfig;
  declare ui: AgentTerminalUi;
  declare provider: ProviderLike;
  declare projectInstructions: ProjectInstructionsLike;
  declare nativeToolCalling: AgentComponentBundle["nativeToolCalling"];
  declare memoryStore: AgentComponentBundle["memoryStore"];
  declare contextManager: AgentComponentBundle["contextManager"] & {
    getRollingSummary(): string;
    getLastPlan(): unknown;
    hydrate(input: {
      rollingSummary?: string;
      lastPlan?: unknown;
    }): void;
  };
  declare executionJournal: AgentComponentBundle["executionJournal"];
  declare executionBoundary: AgentComponentBundle["executionBoundary"];
  declare rollbackStore: AgentComponentBundle["rollbackStore"];
  declare jobStore: AgentComponentBundle["jobStore"];
  declare runtimeHealth: RuntimeHealth;
  declare sourceRegistry: AgentComponentBundle["sourceRegistry"];
  declare capabilityRegistry: AgentComponentBundle["capabilityRegistry"];
  declare planner: AgentComponentBundle["planner"];
  declare diagnosticProvider: AgentComponentBundle["diagnosticProvider"];
  declare toolRegistry: ToolRegistrySurface;
  declare skillLoader: AgentComponentBundle["skillLoader"];
  declare pluginLoader: AgentComponentBundle["pluginLoader"];
  declare policyStack: AgentComponentBundle["policyStack"];
  declare mcpRegistry: AgentComponentBundle["mcpRegistry"];
  declare shellRuntime: AgentComponentBundle["shellRuntime"];
  declare sessionStore: AgentComponentBundle["sessionStore"] & {
    sessionId: string | null;
    start(metadata?: Record<string, unknown>): Promise<string>;
  };
  declare messages: unknown[];
  declare baseSystemPrompt: string;
  declare sessionFilePath: string | null;
  declare sessionId: string | null;
  declare parentSessionId: string | null;
  declare resumedFromSessionId: string | null;
  declare resumeSnapshotPath: string | null;
  declare inheritedRuntimeContinuity: unknown;
  declare usageTotals: AgentStatsBundle["usageTotals"];
  declare approvalStats: AgentStatsBundle["approvalStats"];
  declare providerRuntimeStats: AgentStatsBundle["providerRuntimeStats"];
  declare shellRuntimeStats: AgentStatsBundle["shellRuntimeStats"];
  declare webRuntimeStats: AgentStatsBundle["webRuntimeStats"];
  declare mcpRuntimeStats: AgentStatsBundle["mcpRuntimeStats"];
  declare lastChangeSet: ChangeSetRecord | null;
  declare lastTaskClassification: TaskClassification | null;
  declare lastRouteDecision: RouteDecision | null;
  declare lastModelDecision: ModelDecision | null;
  declare lastExecutionPlan: ExecutionPlan | null;
  declare lastTrace: TraceSummary | null;
  declare traceHistory: TraceSummary[];
  declare lastVerifierRun: VerifierRunRecord | null;
  declare lastRepairLoop: RepairLoopRecord | null;
  declare bindRuntimeSession: () => Promise<void>;

  static async create<TSelf extends AgentLoopEntryConstructor>(
    this: TSelf,
    options: AgentBootstrapOptions,
    ui: AgentTerminalUi,
  ): Promise<InstanceType<TSelf>> {
    return createAgentSessionEntry(this, options, ui);
  }

  static async inspect<TSelf extends AgentLoopEntryConstructor>(
    this: TSelf,
    options: AgentBootstrapOptions,
    ui: AgentTerminalUi,
  ): Promise<InstanceType<TSelf>> {
    return inspectAgentSessionEntry(this, options, ui);
  }

  static async resume<TSelf extends AgentLoopEntryConstructor>(
    this: TSelf,
    options: AgentBootstrapOptions,
    ui: AgentTerminalUi,
    sessionReference: string,
  ): Promise<InstanceType<TSelf>> {
    return resumeAgentSessionEntry(this, options, ui, sessionReference);
  }

  async resumeFromSession(reference: string) {
    return resumeAgentSession(asResumeTarget(this), reference);
  }

  async captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): CaptureSnapshotResult {
    return captureAgentSessionSnapshot(asSnapshotTarget(this), input) as CaptureSnapshotResult;
  }

  hydrateFromSnapshot(snapshot: Record<string, unknown>): void {
    hydrateAgentSessionState(asHydrateTarget(this), snapshot);
  }

  startTrace(prompt: string): StartTraceResult {
    return startAgentTrace(asStartTraceTarget(this), prompt);
  }

  async finalizeTrace(
    turnState: AgentTraceState,
    input: {
      content: string;
      success: boolean;
      stopped: boolean;
      steps: number;
      errorTaxonomy?: string | null;
    },
  ): Promise<void> {
    await finalizeAgentTrace(asFinalizeTraceTarget(this), turnState, input);
  }

  async getTrace(which: string = "last"): Promise<GetTraceResult> {
    return getAgentTrace(asTraceTarget(this), normalizeTraceSelection(which)) as Promise<GetTraceResult>;
  }

  getUsageSummary(): UsageSummaryResult {
    return getAgentUsageSummary(asUsageSummaryTarget(this)) as UsageSummaryResult;
  }

  getStatus(): StatusResult {
    return getAgentStatus(asStatusTarget(this)) as StatusResult;
  }

  async invokeCommandTool(
    toolName: string,
    input?: Record<string, unknown>,
  ): InvokeCommandToolResult {
    return invokeStandaloneCommandTool(asCommandToolTarget(this), toolName, input) as InvokeCommandToolResult;
  }

  async buildRuntimeContinuitySnapshot(): BuildContinuityResult {
    return buildAgentSessionRuntimeContinuity(asContinuityTarget(this)) as BuildContinuityResult;
  }
}

function normalizeTraceSelection(which: string): "last" | "all" {
  return which === "last" ? "last" : "all";
}

function asResumeTarget(value: unknown): Parameters<typeof resumeAgentSession>[0] {
  return value as Parameters<typeof resumeAgentSession>[0];
}

function asSnapshotTarget(value: unknown): Parameters<typeof captureAgentSessionSnapshot>[0] {
  return value as Parameters<typeof captureAgentSessionSnapshot>[0];
}

function asHydrateTarget(value: unknown): Parameters<typeof hydrateAgentSessionState>[0] {
  return value as Parameters<typeof hydrateAgentSessionState>[0];
}

function asStartTraceTarget(value: unknown): Parameters<typeof startAgentTrace>[0] {
  return value as Parameters<typeof startAgentTrace>[0];
}

function asFinalizeTraceTarget(value: unknown): Parameters<typeof finalizeAgentTrace>[0] {
  return value as Parameters<typeof finalizeAgentTrace>[0];
}

function asTraceTarget(value: unknown): Parameters<typeof getAgentTrace>[0] {
  return value as Parameters<typeof getAgentTrace>[0];
}

function asUsageSummaryTarget(value: unknown): Parameters<typeof getAgentUsageSummary>[0] {
  return value as Parameters<typeof getAgentUsageSummary>[0];
}

function asStatusTarget(value: unknown): Parameters<typeof getAgentStatus>[0] {
  return value as Parameters<typeof getAgentStatus>[0];
}

function asCommandToolTarget(value: unknown): Parameters<typeof invokeStandaloneCommandTool>[0] {
  return value as Parameters<typeof invokeStandaloneCommandTool>[0];
}

function asContinuityTarget(value: unknown): Parameters<typeof buildAgentSessionRuntimeContinuity>[0] {
  return value as Parameters<typeof buildAgentSessionRuntimeContinuity>[0];
}
