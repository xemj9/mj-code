import { summarizeText } from "./agent-utils.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";

import type { AgentIntelligence } from "../types/contracts.js";

const PROVIDER_ATTEMPT_EVENTS = new Set([
  "provider_attempt_succeeded",
  "provider_attempt_failed",
  "provider_attempt_exhausted",
]);

const PROVIDER_FALLBACK_EVENTS = new Set([
  "provider_stream_fallback",
  "provider_model_fallback",
]);

const SHELL_SNAPSHOT_EVENTS = new Set([
  "shell_job_started",
  "shell_job_completed",
  "shell_job_timeout",
  "shell_job_reattached",
  "shell_job_orphaned",
]);

interface ProviderRuntimeEvent extends Record<string, unknown> {
  type: string;
  provider?: string | null;
  requestType?: string | null;
}

interface WebRuntimeEvent extends Record<string, unknown> {
  type: string;
}

interface McpRuntimeEvent extends Record<string, unknown> {
  type: string;
  traceId?: string | null;
  step?: string | number | null;
}

interface ShellJobEvent extends Record<string, unknown> {
  type: string;
  job?: {
    id: string;
    status?: string | null;
    traceId?: string | null;
    step?: string | number | null;
    stdoutBytes?: number | null;
    stderrBytes?: number | null;
    continuityState?: string | null;
    command?: unknown;
  };
  preview?: unknown;
}

interface ProviderRuntimeStats {
  attempts: number;
  retries: number;
  fallbacks: number;
  modelFallbacks: number;
  lastEvent: unknown;
}

interface WebRuntimeStats {
  requests: number;
  retries: number;
  cacheHits: number;
  lastEvent: unknown;
}

interface McpRuntimeStats {
  servers: number;
  tools: number;
  calls: number;
  failures: number;
  retries: number;
  lastEvent: unknown;
}

interface ShellRuntimeStats {
  jobsStarted: number;
  jobsCompleted: number;
  jobsCancelled: number;
  jobsTimedOut: number;
  lastEvent: unknown;
}

interface TurnStateLike {
  traceId: string;
  providerEvents: ProviderRuntimeEvent[];
  providerAttempts: number;
  providerRetries: number;
  providerFallbacks: number;
  modelFallbacks: number;
  providerMeta: unknown;
  webRequests: number;
  webRetries: number;
  webCacheHits: number;
}

interface SessionStoreLike {
  append(eventType: string, payload: unknown): Promise<unknown>;
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "append" | "recordPhase">;

interface RuntimeHealthLike {
  noteProviderFallback(input: {
    provider: string | null;
    requestType?: string | null;
  }): Promise<unknown>;
  recordMcpEvent(event: McpRuntimeEvent, servers: unknown[]): Promise<unknown>;
  recordWebEvent(event: WebRuntimeEvent): Promise<unknown>;
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
  printInfo?(label: string, message: string): void;
}

interface ProviderEventContext {
  configProvider: string | null;
  providerRuntimeStats: ProviderRuntimeStats;
  runtimeHealth: RuntimeHealthLike;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
}

interface McpEventContext {
  mcpRuntimeStats: McpRuntimeStats;
  mcpRegistry: McpRegistryLike;
  runtimeHealth: RuntimeHealthLike;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  sessionFilePath: string | null;
  sessionId: string | null;
}

interface WebEventContext {
  webRuntimeStats: WebRuntimeStats;
  runtimeHealth: RuntimeHealthLike;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
}

interface ShellEventContext {
  shellRuntimeStats: ShellRuntimeStats;
  jobStore: JobStoreLike;
  runtimeHealth: RuntimeHealthLike;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  ui: UiLike;
  sessionFilePath: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
}

interface PreparedIntelligenceContext {
  sessionFilePath: string | null;
  sessionId: string | null;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string;
    outputSummary: string;
  }): Promise<unknown>;
}

interface PersistPreparedIntelligenceInput {
  prompt: string;
  traceId: string | null;
  intelligence: AgentIntelligence;
}

export async function recordProviderEvent(
  context: ProviderEventContext,
  event: ProviderRuntimeEvent,
  turnState: TurnStateLike,
  step: string | number,
): Promise<void> {
  context.providerRuntimeStats.lastEvent = event;
  if (PROVIDER_ATTEMPT_EVENTS.has(event.type)) {
    context.providerRuntimeStats.attempts += 1;
  }
  if (event.type === "provider_retry_scheduled") {
    context.providerRuntimeStats.retries += 1;
  }
  if (PROVIDER_FALLBACK_EVENTS.has(event.type)) {
    context.providerRuntimeStats.fallbacks += 1;
    if (event.type === "provider_model_fallback") {
      context.providerRuntimeStats.modelFallbacks += 1;
    }
    await context.runtimeHealth.noteProviderFallback({
      provider: event.provider ?? context.configProvider,
      requestType: asNullableString(event.requestType),
    });
  }

  turnState.providerEvents.push(event);
  if (PROVIDER_ATTEMPT_EVENTS.has(event.type)) {
    turnState.providerAttempts += 1;
  }
  if (event.type === "provider_retry_scheduled") {
    turnState.providerRetries += 1;
  }
  if (PROVIDER_FALLBACK_EVENTS.has(event.type)) {
    turnState.providerFallbacks += 1;
    if (event.type === "provider_model_fallback") {
      turnState.modelFallbacks += 1;
    }
  }

  await context.sessionStore.append("provider_event", {
    traceId: turnState.traceId,
    step,
    ...event,
  });
  await context.executionJournal.append({
    type: "provider_event",
    traceId: turnState.traceId,
    stepId: step,
    phase: "model_complete",
    payload: event,
  });
}

export function noteProviderMeta(turnState: TurnStateLike, meta: unknown): void {
  if (!meta) {
    return;
  }
  turnState.providerMeta = meta;
}

export async function recordMcpEvent(
  context: McpEventContext,
  event: McpRuntimeEvent,
): Promise<void> {
  context.mcpRuntimeStats.lastEvent = event;
  if (event.type === "mcp_client_retry_scheduled") {
    context.mcpRuntimeStats.retries += 1;
  }
  if (event.type === "mcp_client_tool_called") {
    context.mcpRuntimeStats.calls += 1;
  }
  if ([
    "mcp_client_request_failed",
    "mcp_client_request_exhausted",
    "mcp_registry_server_failed",
  ].includes(event.type)) {
    context.mcpRuntimeStats.failures += 1;
  }
  context.mcpRuntimeStats.servers = context.mcpRegistry.listServers().length;
  context.mcpRuntimeStats.tools = context.mcpRegistry.listTools().length;
  await context.runtimeHealth.recordMcpEvent(event, context.mcpRegistry.listServers());

  if (context.sessionFilePath) {
    await context.sessionStore.append("mcp_event", event);
  }
  if (context.sessionId) {
    await context.executionJournal.append({
      type: "mcp_event",
      traceId: asNullableString(event.traceId),
      stepId: asStepId(event.step),
      phase: "tool_execute",
      payload: event,
    });
  }
}

export async function recordWebEvent(
  context: WebEventContext,
  event: WebRuntimeEvent,
  turnState: TurnStateLike,
  step: string | number,
): Promise<void> {
  context.webRuntimeStats.lastEvent = event;
  if ([
    "web_attempt_succeeded",
    "web_attempt_failed",
    "web_attempt_exhausted",
  ].includes(event.type)) {
    context.webRuntimeStats.requests += 1;
    turnState.webRequests += 1;
  }
  if (event.type === "web_retry_scheduled") {
    context.webRuntimeStats.retries += 1;
    turnState.webRetries += 1;
  }
  if (event.type === "web_cache_hit") {
    context.webRuntimeStats.cacheHits += 1;
    turnState.webCacheHits += 1;
  }
  await context.runtimeHealth.recordWebEvent(event);

  await context.sessionStore.append("web_event", {
    traceId: turnState.traceId,
    step,
    ...event,
  });
  await context.executionJournal.append({
    type: "web_event",
    traceId: turnState.traceId,
    stepId: step,
    phase: "tool_execute",
    payload: event,
  });
}

export async function recordShellEvent(
  context: ShellEventContext,
  event: ShellJobEvent,
): Promise<void> {
  context.shellRuntimeStats.lastEvent = event;
  if (event.type === "shell_job_started") {
    context.shellRuntimeStats.jobsStarted += 1;
  }
  if (event.type === "shell_job_completed") {
    context.shellRuntimeStats.jobsCompleted += 1;
    if (event.job?.status === "cancelled") {
      context.shellRuntimeStats.jobsCancelled += 1;
    }
    if (event.job?.status === "timed_out") {
      context.shellRuntimeStats.jobsTimedOut += 1;
    }
  }
  if (SHELL_SNAPSHOT_EVENTS.has(event.type)) {
    const jobs = await context.jobStore.listJobs({ limit: 100 });
    await context.runtimeHealth.noteShellSnapshot(jobs, {
      sessionId: context.sessionId,
      parentSessionId: context.parentSessionId,
    });
  }

  if (context.sessionFilePath) {
    await context.sessionStore.append("shell_job_event", event);
  }
  if (context.sessionId) {
    await context.executionJournal.append({
      type: "shell_job_event",
      traceId: asNullableString(event.job?.traceId),
      stepId: asStepId(event.job?.step),
      phase: "tool_execute",
      payload: event,
    });
  }

  if (event.type === "shell_job_output" && event.job) {
    context.ui.printInfo?.(
      "shell",
      `job=${event.job.id} stdout=${event.job.stdoutBytes ?? 0} stderr=${event.job.stderrBytes ?? 0} ${event.preview ? `tail=${JSON.stringify(event.preview)}` : ""}`.trim(),
    );
    return;
  }

  if (SHELL_SNAPSHOT_EVENTS.has(event.type) && event.job) {
    context.ui.printInfo?.(
      "shell",
      `job=${event.job.id} status=${event.job.status ?? "unknown"} continuity=${event.job.continuityState ?? "n/a"} command=${JSON.stringify(event.job.command).slice(0, 120)}`,
    );
  }
}

export async function persistPreparedIntelligence(
  context: PreparedIntelligenceContext,
  input: PersistPreparedIntelligenceInput,
): Promise<void> {
  const { intelligence, prompt, traceId } = input;

  if (context.sessionFilePath) {
    await context.sessionStore.append("task_classified", {
      traceId,
      taskClassification: intelligence.taskClassification,
    });
    await context.sessionStore.append("route_decided", {
      traceId,
      routeDecision: intelligence.routeDecision,
    });
    await context.sessionStore.append("model_routed", {
      traceId,
      modelDecision: intelligence.modelDecision,
    });
    await context.sessionStore.append("plan_created", {
      traceId,
      executionPlan: intelligence.executionPlan,
    });
  }

  if (!context.sessionId) {
    return;
  }

  await context.executionJournal.recordPhase({
    traceId,
    stepId: 0,
    phase: "planning",
    inputSummary: summarizeText(prompt, 140),
    outputSummary: `Task classified as ${intelligence.taskClassification.taskClass}.`,
    metrics: {
      taskClassification: intelligence.taskClassification,
    },
  });
  await context.executionJournal.recordPhase({
    traceId,
    stepId: 0,
    phase: "planning",
    inputSummary: summarizeText(prompt, 140),
    outputSummary: `Route ${intelligence.routeDecision.routingMode} selected.`,
    metrics: {
      routeDecision: intelligence.routeDecision,
      modelDecision: intelligence.modelDecision,
    },
    snapshot: await context.captureStateSnapshot({
      traceId,
      phase: "planning",
      stepId: "intelligence",
      outputSummary: "Intelligence layer prepared classification, route, and plan.",
    }),
  });
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStepId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}
