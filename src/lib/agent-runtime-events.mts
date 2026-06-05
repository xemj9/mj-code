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
    // For native tool calling, format the tool result content to be concise
    // so we don't waste tokens on huge JSON blobs
    const content = formatNativeToolResult(input.toolName, input.payload);
    target.messages.push({
      role: "tool",
      toolCallId: input.toolCallId,
      name: input.toolName,
      content,
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

/**
 * Format tool result content for native tool calling (Anthropic tool_result blocks).
 * Keeps content concise to avoid wasting context window tokens.
 */
function formatNativeToolResult(toolName: string, payload: ToolFeedbackPayload): string {
  if (!payload.ok) {
    return payload.error ?? "Tool execution failed.";
  }

  const result = payload.result;

  // For read_file, return file content directly (not JSON-wrapped)
  if (toolName === "read_file" && result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") {
      // Truncate very large files to save context window
      const maxChars = 12000;
      const content = r.content as string;
      if (content.length > maxChars) {
        return content.slice(0, maxChars) + "\n\n...<truncated>";
      }
      return content;
    }
  }

  // For list_dir, format entries concisely
  if (toolName === "list_dir" && result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const entries = Array.isArray(r.entries) ? (r.entries as Array<Record<string, unknown>>) : [];
    if (entries.length > 0) {
      const lines = entries.slice(0, 60).map((e) => {
        const kind = e.kind === "directory" ? "d" : "f";
        return `${kind}  ${e.name ?? "unknown"}`;
      });
      let output = lines.join("\n");
      if (entries.length > 60) {
        output += `\n... ${entries.length - 60} more entries`;
      }
      return output;
    }
  }

  // For search_files, format matches concisely
  if (toolName === "search_files" && result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const matches = Array.isArray(r.matches) ? (r.matches as Array<Record<string, unknown>>) : [];
    if (matches.length > 0) {
      const lines = matches.slice(0, 30).map((m) =>
        `${m.path}:${m.line ?? "?"} ${m.preview ?? ""}`
      );
      let output = lines.join("\n");
      if (matches.length > 30) {
        output += `\n... ${matches.length - 30} more matches`;
      }
      return output;
    }
  }

  // For web_search, format results clearly
  if (toolName === "web_search" && result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const results = Array.isArray(r.results) ? (r.results as Array<Record<string, unknown>>) : [];
    if (results.length > 0) {
      const lines = results.slice(0, 10).map((item, i) => {
        const title = item.title ?? "No title";
        const url = item.url ?? "";
        const snippet = item.snippet ?? "";
        const sourceId = item.sourceId ?? "";
        const citation = sourceId ? ` [S${i + 1}]` : "";
        return `${i + 1}. ${title}${citation}\n   ${url}\n   ${snippet}`;
      });
      return lines.join("\n\n");
    }
  }

  // For run_shell, format stdout/stderr
  if (toolName === "run_shell" && result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    const exitCode = r.exitCode ?? r.exit_code ?? null;
    const parts: string[] = [];
    if (exitCode != null && exitCode !== 0) {
      parts.push(`Exit code: ${exitCode}`);
    }
    if (stdout.trim()) {
      parts.push(stdout.slice(0, 8000));
    }
    if (stderr.trim()) {
      parts.push(`STDERR:\n${stderr.slice(0, 3000)}`);
    }
    return parts.join("\n") || "Command completed.";
  }

  // For fetch_url/extract_content
  if ((toolName === "fetch_url" || toolName === "extract_content") && result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const extracted = r.extracted as Record<string, unknown> | undefined;
    // Prefer readableText (extracted clean text) over bodyPreview (may be raw HTML)
    if (typeof r.readableText === "string" && (r.readableText as string).length > 0) {
      return (r.readableText as string).slice(0, 15000);
    }
    if (typeof extracted?.readableText === "string") {
      return (extracted.readableText as string).slice(0, 15000);
    }
    if (typeof r.bodyPreview === "string") {
      return (r.bodyPreview as string).slice(0, 15000);
    }
  }

  // For MCP tool results, format the content cleanly
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    // MCP tool results have a 'content' array with text/resource blocks
    if (Array.isArray(r.content)) {
      const textParts: string[] = [];
      for (const block of r.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "resource" && block.resource) {
          const resource = block.resource as Record<string, unknown>;
          textParts.push(`[Resource: ${resource.uri ?? "unknown"}]`);
        }
      }
      const combined = textParts.join("\n");
      if (combined.length > 10000) {
        return combined.slice(0, 10000) + "\n...<truncated>";
      }
      return combined || "MCP tool completed with no text output.";
    }
    // MCP tool results may have a 'summary' field
    if (typeof r.summary === "string" && r.summary.trim()) {
      return r.summary.slice(0, 8000);
    }
  }

  // Default: JSON stringify with truncation
  const serialized = JSON.stringify(result, null, 2);
  if (serialized.length > 8000) {
    return serialized.slice(0, 8000) + "\n...<truncated>";
  }
  return serialized;
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
