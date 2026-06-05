import {
  noteProviderMeta,
  recordMcpEvent,
  recordProviderEvent,
  recordShellEvent,
  recordWebEvent,
} from "./agent-events.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";
import { executeAgentTool } from "./agent-tool-execution.mjs";
import { formatToolFeedback } from "./json-protocol.mjs";

import type {
  ApprovalContext,
  ChangeSetRecord,
  ExecutionBoundaryDecision,
  HookEmitResult,
  JsonObject,
  ResolvedConfig,
  ToolFeedbackPayload,
  ToolRegistrySurface,
} from "../types/contracts.js";

interface EventRecord extends Record<string, unknown> {
  type: string;
}

interface TurnStateLike {
  traceId: string;
  prompt: string;
  toolEvents: Array<Record<string, unknown>>;
  filesChanged: Set<string>;
  approvalsAsked: number;
  approvalsApproved: number;
  approvalsDenied: number;
  providerAttempts: number;
  providerRetries: number;
  providerFallbacks: number;
  modelFallbacks: number;
  providerEvents: EventRecord[];
  providerMeta: unknown;
  shellJobs: Array<Record<string, unknown>>;
  sourceCitations: unknown[];
  sourceIds: string[];
  mcpCalls: Array<Record<string, unknown>>;
  webRequests: number;
  webRetries: number;
  webCacheHits: number;
  durations: {
    toolExecuteMs: number;
  };
  executionPlan: unknown;
}

interface AgentToolExecutionPayload {
  toolName: string;
  input?: Record<string, unknown>;
  toolCallId: string | null;
  turnState: TurnStateLike;
  step: string | number;
  nativeToolCall: boolean;
}

interface HookRunnerLike {
  emit(
    eventName: string,
    payload?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): Promise<HookEmitResult>;
}

interface MemoryStoreLike {
  recordTurn(input: {
    userInput: string;
    assistantOutput: string;
    toolEvents?: Array<Record<string, unknown>>;
    success?: boolean;
    stopped?: boolean;
  }): Promise<Array<{
    id: string;
    scope: string;
    kind?: string;
    summary?: string;
    source?: string;
  }>>;
}

interface ExecutionBoundaryLike {
  evaluateTool(input: {
    toolName: string;
    toolMeta?: unknown;
    input?: Record<string, unknown>;
    traceId?: string | null;
    step?: string | number | null;
  }): ExecutionBoundaryDecision;
}

interface RollbackStoreLike {
  checkpointChangeSet(changeSet: unknown, metadata?: Record<string, unknown>): Promise<{ id: string }>;
  markApplied(changeSetId: string, payload?: Record<string, unknown>): Promise<unknown>;
  markApplyFailed(changeSetId: string, error: unknown, payload?: Record<string, unknown>): Promise<unknown>;
}

interface PlannerLike {
  noteToolExecution(
    executionPlan: unknown,
    toolName: string,
    input?: Record<string, unknown>,
    success?: boolean,
  ): unknown;
}

interface SessionStoreLike {
  append(type: string, payload?: unknown): Promise<unknown>;
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "append" | "recordPhase">;

interface RuntimeHealthLike {
  noteProviderFallback(input: {
    provider: string | null;
    requestType?: string | null;
  }): Promise<unknown>;
  recordMcpEvent(event: Record<string, unknown>, servers: unknown[]): Promise<unknown>;
  recordWebEvent(event: Record<string, unknown>): Promise<unknown>;
  noteShellSnapshot(
    jobs: unknown[],
    metadata: {
      sessionId: string | null;
      parentSessionId: string | null;
    },
  ): Promise<unknown>;
}

interface McpRegistryLike {
  listServers(): unknown[];
  listTools(): unknown[];
}

interface JobStoreLike {
  listJobs(options?: { limit?: number }): Promise<unknown[]>;
}

interface UiLike {
  printInfo?(tag: string, message: string): void;
  printToolCall?(toolName: string, input?: Record<string, unknown>): void;
  printChangePreview?(changeSet: ChangeSetRecord): void;
  printWarning?(message: string): void;
  printError?(message: string): void;
  printToolResult?(toolName: string, result: unknown): void;
  confirmAction?(approvalContext: ApprovalContext): Promise<boolean>;
  confirm?(message: string): Promise<boolean>;
}

export interface AgentRuntimeEventsTarget {
  config: Pick<
    ResolvedConfig,
    "provider" | "cwd" | "approvalPolicy" | "permissionMode" | "networkMode"
  >;
  ui: UiLike;
  toolRegistry: ToolRegistrySurface;
  executionBoundary: ExecutionBoundaryLike;
  hookRunner?: HookRunnerLike | null;
  rollbackStore: RollbackStoreLike;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  planner: PlannerLike;
  approvalStats: {
    asked: number;
    approved: number;
    denied: number;
  };
  sessionId: string | null;
  parentSessionId: string | null;
  providerRuntimeStats: {
    attempts: number;
    retries: number;
    fallbacks: number;
    modelFallbacks: number;
    lastEvent: unknown;
  };
  mcpRuntimeStats: {
    servers: number;
    tools: number;
    calls: number;
    failures: number;
    retries: number;
    lastEvent: unknown;
  };
  webRuntimeStats: {
    requests: number;
    retries: number;
    cacheHits: number;
    lastEvent: unknown;
  };
  shellRuntimeStats: {
    jobsStarted: number;
    jobsCompleted: number;
    jobsCancelled: number;
    jobsTimedOut: number;
    lastEvent: unknown;
  };
  runtimeHealth: RuntimeHealthLike;
  mcpRegistry: McpRegistryLike;
  sessionFilePath: string | null;
  jobStore: JobStoreLike;
  usageTotals: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  lastExecutionPlan: unknown;
  lastChangeSet: unknown;
  messages: unknown[];
  memoryStore: MemoryStoreLike;
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): Promise<unknown>;
}

export function updateAgentUsageTotals(
  target: Pick<AgentRuntimeEventsTarget, "usageTotals">,
  usage: unknown,
): void {
  if (!usage || typeof usage !== "object") {
    return;
  }

  const record = usage as Record<string, unknown>;
  const promptTokens = Number(record.prompt_tokens ?? record.input_tokens ?? 0);
  const completionTokens = Number(record.completion_tokens ?? record.output_tokens ?? 0);
  const totalTokens = Number(record.total_tokens ?? (promptTokens + completionTokens));

  target.usageTotals.calls += 1;
  target.usageTotals.promptTokens += promptTokens;
  target.usageTotals.completionTokens += completionTokens;
  target.usageTotals.totalTokens += totalTokens;
}

export async function recordAgentProviderEvent(
  target: Pick<
    AgentRuntimeEventsTarget,
    "config" | "providerRuntimeStats" | "runtimeHealth" | "sessionStore" | "executionJournal"
  >,
  event: EventRecord,
  turnState: TurnStateLike,
  step: string | number,
): Promise<void> {
  await recordProviderEvent(
    {
      configProvider: target.config.provider,
      providerRuntimeStats: target.providerRuntimeStats,
      runtimeHealth: target.runtimeHealth,
      sessionStore: target.sessionStore,
      executionJournal: target.executionJournal,
    },
    event,
    turnState,
    step,
  );
}

export function noteAgentProviderMeta(turnState: TurnStateLike, meta: unknown): void {
  noteProviderMeta(turnState, meta);
}

export async function recordAgentMcpEvent(
  target: Pick<
    AgentRuntimeEventsTarget,
    "mcpRuntimeStats" | "mcpRegistry" | "runtimeHealth" | "sessionStore" | "executionJournal" | "sessionFilePath" | "sessionId"
  >,
  event: EventRecord,
): Promise<void> {
  await recordMcpEvent(
    {
      mcpRuntimeStats: target.mcpRuntimeStats,
      mcpRegistry: target.mcpRegistry,
      runtimeHealth: target.runtimeHealth,
      sessionStore: target.sessionStore,
      executionJournal: target.executionJournal,
      sessionFilePath: target.sessionFilePath,
      sessionId: target.sessionId,
    },
    event,
  );
}

export async function recordAgentWebEvent(
  target: Pick<
    AgentRuntimeEventsTarget,
    "webRuntimeStats" | "runtimeHealth" | "sessionStore" | "executionJournal"
  >,
  event: EventRecord,
  turnState: TurnStateLike,
  step: string | number,
): Promise<void> {
  await recordWebEvent(
    {
      webRuntimeStats: target.webRuntimeStats,
      runtimeHealth: target.runtimeHealth,
      sessionStore: target.sessionStore,
      executionJournal: target.executionJournal,
    },
    event,
    turnState,
    step,
  );
}

export async function recordAgentShellEvent(
  target: Pick<
    AgentRuntimeEventsTarget,
    "shellRuntimeStats" | "jobStore" | "runtimeHealth" | "sessionStore" | "executionJournal" | "ui" | "sessionFilePath" | "sessionId" | "parentSessionId"
  >,
  event: EventRecord,
): Promise<void> {
  await recordShellEvent(
    {
      shellRuntimeStats: target.shellRuntimeStats,
      jobStore: target.jobStore,
      runtimeHealth: target.runtimeHealth,
      sessionStore: target.sessionStore,
      executionJournal: target.executionJournal,
      ui: target.ui,
      sessionFilePath: target.sessionFilePath,
      sessionId: target.sessionId,
      parentSessionId: target.parentSessionId,
    },
    event,
  );
}

export async function recordAgentHookEvent(
  target: Pick<AgentRuntimeEventsTarget, "sessionFilePath" | "sessionStore" | "sessionId" | "executionJournal">,
  event: EventRecord,
): Promise<void> {
  const eventType = event.type === "execution_boundary_decision"
    ? "execution_boundary_decision"
    : "hook_event";
  const phase = inferHookPhase(event);
  if (target.sessionFilePath) {
    await target.sessionStore.append(eventType, event);
  }
  if (target.sessionId) {
    await target.executionJournal.append({
      type: eventType,
      traceId: asNullableString(event.traceId),
      stepId: asStepId(event.step),
      phase,
      payload: event,
    });
  }
}

export async function handleAgentToolExecution(
  target: AgentRuntimeEventsTarget,
  {
    toolName,
    input,
    toolCallId,
    turnState,
    step,
    nativeToolCall,
  }: AgentToolExecutionPayload,
): Promise<unknown> {
  return executeAgentTool(
    {
      config: target.config,
      ui: target.ui,
      toolRegistry: target.toolRegistry,
      executionBoundary: target.executionBoundary,
      hookRunner: target.hookRunner,
      rollbackStore: target.rollbackStore,
      sessionStore: target.sessionStore,
      executionJournal: target.executionJournal,
      planner: target.planner,
      approvalStats: target.approvalStats,
      sessionId: target.sessionId,
      parentSessionId: target.parentSessionId,
      getLastExecutionPlan: () => target.lastExecutionPlan,
      setLastExecutionPlan: (executionPlan) => {
        target.lastExecutionPlan = executionPlan;
      },
      setLastChangeSet: (changeSet) => {
        target.lastChangeSet = changeSet;
      },
      pushToolFeedback: async (payload) => pushAgentToolFeedback(target, payload),
      captureStateSnapshot: async (payload) => target.captureStateSnapshot(payload),
      onWebEvent: async (event) => {
        await recordAgentWebEvent(target, event as EventRecord, turnState, step);
      },
      onMcpEvent: async (event) => {
        await recordAgentMcpEvent(target, event as EventRecord);
      },
    },
    {
      toolName,
      input,
      toolCallId,
      turnState,
      step,
      nativeToolCall,
    },
  );
}

export async function pushAgentToolFeedback(
  target: Pick<AgentRuntimeEventsTarget, "messages" | "sessionStore">,
  input: {
    nativeToolCall: boolean;
    toolCallId: string | null;
    toolName: string;
    payload: ToolFeedbackPayload;
  },
): Promise<void> {
  if (input.nativeToolCall) {
    target.messages.push({
      role: "tool",
      toolCallId: input.toolCallId,
      name: input.toolName,
      content: JSON.stringify(input.payload, null, 2),
    });
    await target.sessionStore.append(input.payload.ok ? "tool_result" : "tool_error", {
      tool: input.toolName,
      toolCallId: input.toolCallId,
      ...(input.payload.ok ? { result: input.payload.result } : { error: input.payload.error }),
    });
    return;
  }

  target.messages.push({
    role: "user",
    content: formatToolFeedback(input.toolName, input.payload),
  });
}

export async function recordAgentTurnMemory(
  target: Pick<AgentRuntimeEventsTarget, "memoryStore" | "sessionStore">,
  turnState: TurnStateLike,
  content: string,
  success: boolean,
  stopped: boolean,
): Promise<void> {
  const memories = await target.memoryStore.recordTurn({
    userInput: turnState.prompt,
    assistantOutput: content,
    toolEvents: turnState.toolEvents,
    success,
    stopped,
  });

  await target.sessionStore.append("memory_auto_extract", {
    traceId: turnState.traceId,
    count: memories.length,
    memories: memories.map((item) => ({
      id: item.id,
      scope: item.scope,
      kind: item.kind,
      summary: item.summary,
      source: item.source,
    })),
  });
}

function inferHookPhase(event: Record<string, unknown>): string {
  const hookEvent = typeof event.event === "string"
    ? event.event
    : isRecord(event.meta) && typeof event.meta.hookEvent === "string"
      ? event.meta.hookEvent
      : null;
  if (hookEvent === "session_start" || hookEvent === "session_end") {
    return "session_lifecycle";
  }
  if (hookEvent === "user_prompt_submit") {
    return "planning";
  }
  if (hookEvent === "pre_compact") {
    return "context_prepare";
  }
  return hookEvent?.includes("apply") ? "apply_changes" : "tool_execute";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStepId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number"
    ? value
    : null;
}
