import {
  createMcpCircuitOpenError,
  createMcpProtocolError,
  createMcpServerError,
  createMcpToolError,
  finalizeMcpError,
  isRetryableMcpError,
  normalizeMcpError,
  serializeMcpError,
} from "./mcp-errors.mjs";
import { McpStdioTransport } from "./mcp-transport-stdio.mjs";

import type {
  JsonObject,
  McpAttemptRecord,
  McpClientStats,
  McpNormalizedToolSpec,
  McpServerConfig,
  McpToolCallResult,
  SerializedMcpError,
} from "../types/contracts.js";

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-03-26",
  "2025-06-18",
  "2025-11-05",
]);

type RuntimeEvent = Record<string, unknown>;
type RuntimeEventHandler = (event: RuntimeEvent) => Promise<void> | void;
type McpRequestClass = "connect" | "invoke";

interface McpRequestGate {
  allowed?: boolean;
  circuit?: unknown;
  events?: RuntimeEvent[];
}

interface McpOutcomeResult {
  circuit?: unknown;
  events?: RuntimeEvent[];
}

interface McpRuntimeHealth {
  beforeMcpRequest?(input: {
    serverId: string;
    serverName: string;
    requestClass: McpRequestClass;
    endpoint: string;
    traceId?: string | null;
  }): Promise<McpRequestGate | null | undefined> | McpRequestGate | null | undefined;
  noteMcpOutcome?(input: {
    serverId: string;
    serverName: string;
    requestClass: McpRequestClass;
    endpoint: string;
    success: boolean;
    totalDurationMs: number;
    error?: unknown;
  }): Promise<McpOutcomeResult | null | undefined> | McpOutcomeResult | null | undefined;
}

interface McpClientOptions {
  onEvent?: RuntimeEventHandler | null;
  runtimeHealth?: McpRuntimeHealth | null;
}

interface McpServerInitializeResult {
  protocolVersion: string;
  serverInfo?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown>;
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, boolean | string | number | null | undefined>;
  title?: string | null;
}

interface McpListToolsResult {
  tools?: McpToolDescriptor[];
  nextCursor?: string | null;
}

interface McpToolCallResponseContent {
  type?: string;
  text?: string;
  resource?: {
    uri?: string;
  };
  [key: string]: unknown;
}

interface McpToolCallResponse {
  content?: McpToolCallResponseContent[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

interface McpTransportRequestOptions {
  timeoutMs?: number;
  requestId?: string;
}

interface McpTransportLike {
  request(method: string, params?: Record<string, unknown>, options?: McpTransportRequestOptions): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

interface McpRequestOptions {
  timeoutMs?: number;
  toolName?: string | null;
  traceId?: string | null;
  requestClass?: McpRequestClass;
  maxRetries?: number;
}

interface McpClientDescription extends Omit<McpServerConfig, "protocolVersion"> {
  protocolVersion: string | null;
  status: string;
  healthScore: number;
  lastConnectedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  latencyMs: number | null;
  errorRate: number;
  serverInfo: Record<string, unknown> | null;
  toolCount: number;
  lastError: SerializedMcpError | null;
}

export class McpClient {
  readonly serverConfig: McpServerConfig;
  readonly onEvent: RuntimeEventHandler | null;
  readonly runtimeHealth: McpRuntimeHealth | null;
  readonly transport: McpTransportLike;
  connected: boolean;
  serverInfo: Record<string, unknown> | null;
  serverCapabilities: Record<string, unknown>;
  protocolVersion: string | null;
  toolCache: McpNormalizedToolSpec[];
  stats: McpClientStats;

  constructor(serverConfig: McpServerConfig, options: McpClientOptions = {}) {
    this.serverConfig = serverConfig;
    this.onEvent = options.onEvent ?? null;
    this.runtimeHealth = options.runtimeHealth ?? null;
    this.transport = createTransport(serverConfig, {
      onEvent: async (event) => {
        await this.emitEvent(event);
      },
    });
    this.connected = false;
    this.serverInfo = null;
    this.serverCapabilities = {};
    this.protocolVersion = null;
    this.toolCache = [];
    this.stats = {
      calls: 0,
      successes: 0,
      failures: 0,
      errorRate: 0,
      healthScore: 100,
      latencyMs: null,
      lastConnectedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      status: "idle",
    };
  }

  async initialize(): Promise<McpClientDescription> {
    if (this.connected) {
      return this.describe();
    }

    this.stats.status = "connecting";
    const startedAt = Date.now();
    try {
      const result = await this.requestWithRetry("initialize", {
        protocolVersion: this.serverConfig.protocolVersion ?? "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "MJ Code",
          version: "0.1.0",
        },
      }, {
        timeoutMs: getConnectTimeoutMs(this.serverConfig),
        requestClass: "connect",
      }) as McpServerInitializeResult;

      if (!SUPPORTED_PROTOCOL_VERSIONS.has(result.protocolVersion)) {
        throw createMcpProtocolError(
          `Unsupported MCP protocol version "${result.protocolVersion}" from server "${this.serverConfig.id}".`,
          {
            serverId: this.serverConfig.id,
            serverName: this.serverConfig.name,
            method: "initialize",
            retryable: false,
          },
        );
      }

      this.protocolVersion = result.protocolVersion;
      this.serverInfo = result.serverInfo ?? null;
      this.serverCapabilities = result.capabilities ?? {};
      await this.transport.notify("notifications/initialized");
      this.connected = true;
      this.noteSuccess(Date.now() - startedAt);
      this.stats.lastConnectedAt = new Date().toISOString();
      await this.emitEvent({
        type: "mcp_client_initialized",
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        protocolVersion: this.protocolVersion,
        serverInfo: this.serverInfo,
        latencyMs: this.stats.latencyMs,
      });
      return this.describe();
    } catch (error) {
      this.noteFailure(error);
      throw error;
    }
  }

  async ping(): Promise<{
    ok: true;
    result: unknown;
    latencyMs: number | null;
  }> {
    await this.initialize();
    const startedAt = Date.now();
    const result = await this.requestWithRetry("ping", {}, {
      timeoutMs: Math.min(getConnectTimeoutMs(this.serverConfig), 5000),
      requestClass: "connect",
    });
    this.noteSuccess(Date.now() - startedAt);
    await this.emitEvent({
      type: "mcp_client_ping_succeeded",
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      latencyMs: this.stats.latencyMs,
    });
    return {
      ok: true,
      result,
      latencyMs: this.stats.latencyMs,
    };
  }

  async listTools({ forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<McpNormalizedToolSpec[]> {
    await this.initialize();
    if (!forceRefresh && this.toolCache.length > 0) {
      return this.toolCache;
    }

    const tools: McpNormalizedToolSpec[] = [];
    let cursor: string | undefined;
    do {
      const startedAt = Date.now();
      const result = await this.requestWithRetry("tools/list", cursor ? { cursor } : {}, {
        timeoutMs: getConnectTimeoutMs(this.serverConfig),
        requestClass: "connect",
      }) as McpListToolsResult;
      this.noteSuccess(Date.now() - startedAt);
      const page = Array.isArray(result.tools) ? result.tools : [];
      tools.push(...page.map((tool) => normalizeMcpTool(tool, this.serverConfig)));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    this.toolCache = dedupeToolsByName(tools);
    await this.emitEvent({
      type: "mcp_client_tools_listed",
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      toolCount: this.toolCache.length,
    });
    return this.toolCache;
  }

  async callTool(
    toolName: string,
    input: Record<string, unknown> = {},
    options: {
      timeoutMs?: number;
      traceId?: string | null;
    } = {},
  ): Promise<McpToolCallResult> {
    await this.initialize();
    const startedAt = Date.now();
    const result = await this.requestWithRetry("tools/call", {
      name: toolName,
      arguments: input,
    }, {
      timeoutMs: options.timeoutMs ?? this.serverConfig.timeoutMs,
      toolName,
      traceId: options.traceId ?? null,
      requestClass: "invoke",
    }) as McpToolCallResponse;
    this.noteSuccess(Date.now() - startedAt);

    if (result?.isError === true) {
      const text = summarizeMcpContent(result.content);
      const error = createMcpToolError(
        text || `MCP tool "${toolName}" reported an error result.`,
        {
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          method: "tools/call",
          toolName,
          details: result,
        },
      );
      this.noteFailure(error);
      throw error;
    }

    await this.emitEvent({
      type: "mcp_client_tool_called",
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      toolName,
      latencyMs: this.stats.latencyMs,
    });

    return normalizeToolCallResult(result, this.serverConfig, toolName);
  }

  async testConnection(): Promise<{
    server: McpClientDescription;
    ping: Awaited<ReturnType<McpClient["ping"]>>;
    toolCount: number;
  }> {
    await this.initialize();
    const ping = await this.ping();
    const tools = await this.listTools({ forceRefresh: true });
    return {
      server: this.describe(),
      ping,
      toolCount: tools.length,
    };
  }

  describe(): McpClientDescription {
    return {
      id: this.serverConfig.id,
      name: this.serverConfig.name,
      scope: this.serverConfig.scope,
      sourcePath: this.serverConfig.sourcePath,
      transport: this.serverConfig.transport,
      command: this.serverConfig.command,
      args: this.serverConfig.args,
      cwd: this.serverConfig.cwd,
      env: this.serverConfig.env,
      envKeys: this.serverConfig.envKeys,
      enabled: this.serverConfig.enabled,
      timeoutMs: this.serverConfig.timeoutMs,
      maxRetries: this.serverConfig.maxRetries,
      retryBudgetMs: this.serverConfig.retryBudgetMs,
      baseDelayMs: this.serverConfig.baseDelayMs,
      maxDelayMs: this.serverConfig.maxDelayMs,
      protocolVersion: this.protocolVersion,
      status: this.stats.status,
      healthScore: this.stats.healthScore,
      lastConnectedAt: this.stats.lastConnectedAt,
      lastSuccessAt: this.stats.lastSuccessAt,
      lastFailureAt: this.stats.lastFailureAt,
      latencyMs: this.stats.latencyMs,
      errorRate: this.stats.errorRate,
      serverInfo: this.serverInfo,
      toolCount: this.toolCache.length,
      lastError: this.stats.lastError,
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
    this.connected = false;
    this.stats.status = "closed";
  }

  async requestWithRetry(
    method: string,
    params: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<unknown> {
    const maxRetries = Number(options.maxRetries ?? this.serverConfig.maxRetries ?? 0);
    const attempts: McpAttemptRecord[] = [];
    const requestClass = options.requestClass ?? (method === "tools/call" ? "invoke" : "connect");
    const gate = await this.runtimeHealth?.beforeMcpRequest?.({
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      requestClass,
      endpoint: method,
      traceId: options.traceId ?? null,
    });
    if (gate?.events?.length) {
      for (const event of gate.events) {
        await this.emitEvent(event);
      }
    }
    if (gate?.allowed === false) {
      const error = createMcpCircuitOpenError(
        `MCP circuit is open for ${this.serverConfig.id}:${requestClass}.`,
        {
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          method,
          toolName: options.toolName ?? null,
          traceId: options.traceId ?? null,
          details: {
            circuit: gate.circuit,
          },
        },
      );
      await this.emitEvent({
        type: "mcp_circuit_blocked",
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        method,
        requestClass,
        traceId: options.traceId ?? null,
        toolName: options.toolName ?? null,
        circuit: gate.circuit,
        error: serializeMcpError(error),
      });
      throw error;
    }

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const startedAt = Date.now();
      try {
        const result = await this.transport.request(method, params, {
          timeoutMs: options.timeoutMs ?? this.serverConfig.timeoutMs,
        });
        attempts.push({
          attempt,
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        const healthResult = await this.runtimeHealth?.noteMcpOutcome?.({
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          requestClass,
          endpoint: method,
          success: true,
          totalDurationMs: Date.now() - startedAt,
        });
        if (healthResult?.events?.length) {
          for (const event of healthResult.events) {
            await this.emitEvent({
              ...event,
              traceId: options.traceId ?? null,
            });
          }
        }
        return result;
      } catch (error) {
        const normalized = normalizeMcpError(error, {
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          method,
          toolName: options.toolName ?? null,
          traceId: options.traceId ?? null,
          attempt,
        });
        const exhausted = attempt > maxRetries || !isRetryableMcpError(normalized);
        attempts.push({
          attempt,
          ok: false,
          durationMs: Date.now() - startedAt,
          taxonomy: normalized.taxonomy,
          code: normalized.code,
        });

        await this.emitEvent({
          type: exhausted ? "mcp_client_request_exhausted" : "mcp_client_request_failed",
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          method,
          toolName: options.toolName ?? null,
          attempt,
          requestClass,
          error: serializeMcpError(normalized),
        });

        if (exhausted) {
          const finalError = finalizeMcpError(normalized, attempts);
          const healthResult = await this.runtimeHealth?.noteMcpOutcome?.({
            serverId: this.serverConfig.id,
            serverName: this.serverConfig.name,
            requestClass,
            endpoint: method,
            success: false,
            totalDurationMs: attempts.reduce((sum, entry) => sum + entry.durationMs, 0),
            error: finalError,
          });
          if (healthResult?.events?.length) {
            for (const event of healthResult.events) {
              await this.emitEvent({
                ...event,
                traceId: options.traceId ?? null,
              });
            }
          }
          if (!finalError.details || typeof finalError.details !== "object") {
            finalError.details = {};
          }
          finalError.details.circuit = healthResult?.circuit ?? gate?.circuit ?? null;
          throw finalError;
        }

        const delayMs = computeRetryDelay(this.serverConfig, attempt);
        await this.emitEvent({
          type: "mcp_client_retry_scheduled",
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          method,
          toolName: options.toolName ?? null,
          requestClass,
          attempt,
          delayMs,
        });
        await sleep(delayMs);
      }
    }

    throw createMcpServerError(`MCP request ${method} exhausted without a result.`, {
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      method,
    });
  }

  noteSuccess(latencyMs: number): void {
    this.stats.calls += 1;
    this.stats.successes += 1;
    this.stats.status = "ready";
    this.stats.lastSuccessAt = new Date().toISOString();
    this.stats.latencyMs = this.stats.latencyMs == null
      ? latencyMs
      : Math.round((this.stats.latencyMs * 0.7) + (latencyMs * 0.3));
    this.stats.errorRate = this.stats.failures === 0
      ? 0
      : Number((this.stats.failures / Math.max(1, this.stats.successes + this.stats.failures)).toFixed(3));
    this.stats.healthScore = clampHealthScore(
      100 - Math.round(this.stats.errorRate * 100) - Math.round((this.stats.latencyMs ?? 0) / 200),
    );
  }

  noteFailure(error: unknown): void {
    const serialized = serializeMcpError(error);
    this.stats.calls += 1;
    this.stats.failures += 1;
    this.stats.status = this.stats.successes > 0 ? "degraded" : "failed";
    this.stats.lastFailureAt = new Date().toISOString();
    this.stats.lastError = serialized;
    this.stats.errorRate = Number(
      (this.stats.failures / Math.max(1, this.stats.successes + this.stats.failures)).toFixed(3),
    );
    this.stats.healthScore = clampHealthScore(100 - Math.round(this.stats.errorRate * 100) - 20);
  }

  async emitEvent(event: RuntimeEvent): Promise<void> {
    if (typeof this.onEvent === "function") {
      await this.onEvent(event);
    }
  }
}

function createTransport(
  serverConfig: McpServerConfig,
  options: { onEvent?: RuntimeEventHandler | null },
): McpTransportLike {
  if (serverConfig.transport !== "stdio") {
    throw createMcpProtocolError(`Unsupported MCP transport "${serverConfig.transport}".`, {
      serverId: serverConfig.id,
      serverName: serverConfig.name,
      retryable: false,
    });
  }

  return new McpStdioTransport(serverConfig, options);
}

function normalizeMcpTool(tool: McpToolDescriptor, serverConfig: McpServerConfig): McpNormalizedToolSpec {
  return {
    source: "mcp",
    serverId: serverConfig.id,
    serverName: serverConfig.name,
    name: tool.name,
    normalizedName: `mcp__${serverConfig.id}__${tool.name}`,
    description: tool.description || `MCP tool ${tool.name} from ${serverConfig.name}`,
    inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as JsonObject,
    annotations: tool.annotations ?? {},
    title: tool.title ?? null,
    type: "mcp-tool",
  };
}

function normalizeToolCallResult(
  result: McpToolCallResponse,
  serverConfig: McpServerConfig,
  toolName: string,
): McpToolCallResult {
  return {
    serverId: serverConfig.id,
    serverName: serverConfig.name,
    toolName,
    content: Array.isArray(result?.content) ? result.content : [],
    structuredContent: result?.structuredContent ?? null,
    isError: Boolean(result?.isError),
    summary: summarizeMcpContent(result?.content),
    raw: result,
  };
}

function summarizeMcpContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry: McpToolCallResponseContent) => {
      if (entry?.type === "text") {
        return entry.text ?? "";
      }
      if (entry?.type === "resource" && entry.resource?.uri) {
        return `${entry.resource.uri}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function dedupeToolsByName(tools: McpNormalizedToolSpec[]): McpNormalizedToolSpec[] {
  const seen = new Map<string | undefined, McpNormalizedToolSpec>();
  for (const tool of tools) {
    seen.set(tool.normalizedName, tool);
  }
  return [...seen.values()];
}

function computeRetryDelay(serverConfig: McpServerConfig, attempt: number): number {
  const baseDelayMs = Number(serverConfig.baseDelayMs ?? 200);
  const maxDelayMs = Number(serverConfig.maxDelayMs ?? 1500);
  const raw = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = Math.max(20, Math.round(raw * 0.2 * Math.random()));
  return raw + jitter;
}

function getConnectTimeoutMs(serverConfig: McpServerConfig): number {
  const explicit = Number((serverConfig as McpServerConfig & { connectTimeoutMs?: number }).connectTimeoutMs ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const fallback = Number(serverConfig.timeoutMs ?? 10000);
  return Math.max(fallback, 1000);
}

function clampHealthScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
