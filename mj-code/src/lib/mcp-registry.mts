import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpClient } from "./mcp-client.mjs";
import { createMcpProtocolError, serializeMcpError } from "./mcp-errors.mjs";

import type {
  McpNormalizedToolSpec,
  McpRegistryServerView,
  McpServerConfig,
  ResolvedConfig,
} from "../types/contracts.js";

const DEFAULT_SERVER_TIMEOUT_MS = 10000;

export type McpRegistryConfig = Partial<ResolvedConfig> & Record<string, unknown> & {
  cwd: string;
  projectStateDir: string;
  mcpConfigPaths?: Array<{ scope?: string; path: string }>;
  mcpServers?: Record<string, unknown>;
  mcpTimeoutMs?: number;
  mcpMaxRetries?: number;
  mcpRetryBudgetMs?: number;
};

interface McpRuntimeHealthLike {
  beforeMcpRequest?(input: {
    serverId: string;
    serverName: string;
    requestClass: "connect" | "invoke";
    endpoint: string;
    traceId?: string | null;
  }): Promise<{
    allowed?: boolean;
    circuit?: unknown;
    events?: Record<string, unknown>[];
  } | null | undefined> | {
    allowed?: boolean;
    circuit?: unknown;
    events?: Record<string, unknown>[];
  } | null | undefined;
  noteMcpOutcome?(input: {
    serverId: string;
    serverName: string;
    requestClass: "connect" | "invoke";
    endpoint: string;
    success: boolean;
    totalDurationMs: number;
    error?: unknown;
  }): Promise<{
    circuit?: unknown;
    events?: Record<string, unknown>[];
  } | null | undefined> | {
    circuit?: unknown;
    events?: Record<string, unknown>[];
  } | null | undefined;
}

interface RegistryServerEntry extends McpServerConfig {
  client: McpClient;
}

export interface McpRegistryOptions {
  onEvent?: ((event: Record<string, unknown>) => Promise<void> | void) | null;
  runtimeHealth?: McpRuntimeHealthLike | null;
}

interface McpConfigCandidate {
  scope: string;
  path: string;
  inline?: Record<string, unknown>;
}

interface McpConfigLoadResult {
  configPaths: string[];
  servers: McpServerConfig[];
}

export class McpRegistry {
  readonly config: McpRegistryConfig;
  readonly onEvent: McpRegistryOptions["onEvent"];
  readonly runtimeHealth: McpRuntimeHealthLike | null | undefined;
  servers: Map<string, RegistryServerEntry>;
  tools: Map<string, McpNormalizedToolSpec>;
  initialized: boolean;

  constructor(config: McpRegistryConfig, options: McpRegistryOptions = {}) {
    this.config = config;
    this.onEvent = options.onEvent ?? null;
    this.runtimeHealth = options.runtimeHealth ?? null;
    this.servers = new Map();
    this.tools = new Map();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const resolved = await loadMcpServerConfigs(this.config);
    for (const serverConfig of resolved.servers) {
      const client = new McpClient(serverConfig, {
        onEvent: async (event) => {
          await this.handleClientEvent(event);
        },
        runtimeHealth: this.runtimeHealth,
      });
      this.servers.set(serverConfig.id, {
        ...serverConfig,
        scope: serverConfig.scope,
        sourcePath: serverConfig.sourcePath,
        client,
      });
    }

    await Promise.all([...this.servers.values()].map(async (server) => {
      if (!server.enabled) {
        return;
      }

      try {
        await server.client.initialize();
        const tools = await server.client.listTools();
        this.updateToolCache(server.id, tools);
      } catch (error) {
        await this.emitEvent({
          type: "mcp_registry_server_failed",
          serverId: server.id,
          serverName: server.name,
          error: serializeMcpError(error),
        });
      }
    }));

    this.initialized = true;
  }

  getNormalizedToolSpecs(): McpNormalizedToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      ...tool,
      name: tool.normalizedName ?? tool.name,
      description: `[MCP:${tool.serverName}] ${tool.description}`,
      source: "mcp",
      toolName: tool.name,
    }));
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  describeTool(name: string): McpNormalizedToolSpec | null {
    return this.tools.get(name) ?? null;
  }

  async invokeTool(
    name: string,
    input: Record<string, unknown> = {},
    executionContext: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const spec = this.tools.get(name);
    if (!spec) {
      throw createMcpProtocolError(`Unknown MCP tool "${name}".`, {
        retryable: false,
      });
    }

    const server = this.servers.get(spec.serverId);
    if (!server) {
      throw createMcpProtocolError(`Unknown MCP server "${spec.serverId}" for tool "${name}".`, {
        retryable: false,
      });
    }

    const traceId = asNullableString(executionContext.traceId);
    const step = asNullableStep(executionContext.step);

    await this.emitEvent({
      type: "mcp_tool_invocation_started",
      traceId,
      step,
      serverId: server.id,
      serverName: server.name,
      toolName: spec.name,
      normalizedToolName: spec.normalizedName,
    });

    try {
      const result = await server.client.callTool(spec.name, input, {
        timeoutMs: server.timeoutMs,
        traceId,
      });
      await this.emitEvent({
        type: "mcp_tool_invocation_completed",
        traceId,
        step,
        serverId: server.id,
        serverName: server.name,
        toolName: spec.name,
        normalizedToolName: spec.normalizedName,
      });
      return {
        ...result,
        normalizedToolName: spec.normalizedName,
        annotations: spec.annotations,
      };
    } catch (error) {
      await this.emitEvent({
        type: "mcp_tool_invocation_failed",
        traceId,
        step,
        serverId: server.id,
        serverName: server.name,
        toolName: spec.name,
        normalizedToolName: spec.normalizedName,
        error: serializeMcpError(error),
      });
      throw error;
    }
  }

  listServers(): McpRegistryServerView[] {
    return [...this.servers.values()].map((server) => {
      const clientView = server.client.describe();
      return {
        ...clientView,
        id: server.id,
        name: server.name,
        scope: server.scope,
        sourcePath: server.sourcePath,
        transport: server.transport,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        envKeys: server.envKeys,
        enabled: server.enabled,
      };
    });
  }

  listTools(): McpNormalizedToolSpec[] {
    return this.getNormalizedToolSpecs();
  }

  inspectServer(serverId: string): (McpRegistryServerView & {
    timeoutMs: number;
    maxRetries: number;
    retryBudgetMs: number;
    baseDelayMs: number;
    maxDelayMs: number;
    client: Record<string, unknown>;
    tools: McpNormalizedToolSpec[];
  }) | null {
    const server = this.servers.get(serverId);
    if (!server) {
      return null;
    }

    const clientView = server.client.describe();
    return {
      ...clientView,
      id: server.id,
      name: server.name,
      scope: server.scope,
      sourcePath: server.sourcePath,
      transport: server.transport,
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      envKeys: server.envKeys,
      enabled: server.enabled,
      timeoutMs: server.timeoutMs,
      maxRetries: server.maxRetries,
      retryBudgetMs: server.retryBudgetMs,
      baseDelayMs: server.baseDelayMs,
      maxDelayMs: server.maxDelayMs,
      client: clientView,
      tools: [...this.tools.values()].filter((tool) => tool.serverId === serverId),
    };
  }

  async testServer(serverId: string): Promise<unknown> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw createMcpProtocolError(`Unknown MCP server "${serverId}".`, {
        retryable: false,
      });
    }

    const result = await server.client.testConnection();
    const tools = await server.client.listTools({ forceRefresh: true });
    this.updateToolCache(server.id, tools);
    return result;
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.client.close()));
  }

  updateToolCache(serverId: string, tools: McpNormalizedToolSpec[]): void {
    for (const [name, spec] of this.tools.entries()) {
      if (spec.serverId === serverId) {
        this.tools.delete(name);
      }
    }
    for (const tool of tools) {
      this.tools.set(tool.normalizedName ?? tool.name, tool);
    }
  }

  async handleClientEvent(event: Record<string, unknown>): Promise<void> {
    await this.emitEvent(event);
    if (
      event.type === "mcp_transport_notification_received" &&
      event.method === "notifications/tools/list_changed"
    ) {
      const serverId = typeof event.serverId === "string" ? event.serverId : null;
      const server = serverId ? this.servers.get(serverId) : null;
      if (!server) {
        return;
      }

      try {
        const tools = await server.client.listTools({ forceRefresh: true });
        this.updateToolCache(server.id, tools);
        await this.emitEvent({
          type: "mcp_registry_tools_refreshed",
          serverId: server.id,
          serverName: server.name,
          toolCount: tools.length,
        });
      } catch (error) {
        await this.emitEvent({
          type: "mcp_registry_tools_refresh_failed",
          serverId: server.id,
          serverName: server.name,
          error: serializeMcpError(error),
        });
      }
    }
  }

  async emitEvent(event: Record<string, unknown>): Promise<void> {
    if (typeof this.onEvent === "function") {
      await this.onEvent(event);
    }
  }
}

export async function loadMcpServerConfigs(config: McpRegistryConfig): Promise<McpConfigLoadResult> {
  const candidates = buildMcpConfigCandidates(config);
  const byId = new Map<string, McpServerConfig>();

  for (const candidate of candidates) {
    const payload = candidate.inline
      ? { mcpServers: candidate.inline }
      : await readMcpConfigFile(candidate.path);
    if (!payload) {
      continue;
    }

    const servers = normalizeServerMap(payload.mcpServers, {
      config,
      scope: candidate.scope,
      sourcePath: candidate.path,
    });
    for (const server of servers) {
      byId.set(server.id, server);
    }
  }

  return {
    configPaths: candidates.map((entry) => entry.path),
    servers: [...byId.values()],
  };
}

function buildMcpConfigCandidates(config: McpRegistryConfig): McpConfigCandidate[] {
  if (Array.isArray(config.mcpConfigPaths) && config.mcpConfigPaths.length > 0) {
    return config.mcpConfigPaths.map((entry, index) => ({
      scope: entry.scope ?? `custom-${index + 1}`,
      path: entry.path,
    }));
  }

  return [
    {
      scope: "user",
      path: path.join(os.homedir(), ".mj-code", "mcp.json"),
    },
    {
      scope: "project",
      path: path.join(config.cwd, ".mcp.json"),
    },
    {
      scope: "local",
      path: path.join(config.projectStateDir, "mcp.local.json"),
    },
    ...(config.mcpServers && typeof config.mcpServers === "object"
      ? [
          {
            scope: "inline",
            path: "<inline-config>",
            inline: config.mcpServers,
          },
        ]
      : []),
  ];
}

async function readMcpConfigFile(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return JSON.parse(contents) as Record<string, unknown>;
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read MCP config "${filePath}": ${message}`);
  }
}

function normalizeServerMap(
  serverMap: unknown,
  context: {
    config: McpRegistryConfig;
    scope: string;
    sourcePath: string;
  },
): McpServerConfig[] {
  if (!serverMap || typeof serverMap !== "object" || Array.isArray(serverMap)) {
    return [];
  }

  return Object.entries(serverMap)
    .map(([serverId, raw]) => normalizeServerConfig(serverId, raw, context))
    .filter((entry): entry is McpServerConfig => Boolean(entry));
}

function normalizeServerConfig(
  serverId: string,
  raw: unknown,
  {
    config,
    scope,
    sourcePath,
  }: {
    config: McpRegistryConfig;
    scope: string;
    sourcePath: string;
  },
): McpServerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const enabled = record.enabled !== false;
  const transport = normalizeTransport(
    record.transport ?? record.type ?? (record.command ? "stdio" : "unknown"),
  );
  const cwd = resolveConfigPath(
    expandTemplate(record.cwd, {
      PROJECT_ROOT: config.cwd,
    }) ?? config.cwd,
    config.cwd,
  );
  const env = resolveEnvironment(record.env, {
    PROJECT_ROOT: config.cwd,
  });
  const command = expandTemplate(record.command, {
    PROJECT_ROOT: config.cwd,
  });
  const args = Array.isArray(record.args)
    ? record.args.map((entry) =>
      expandTemplate(entry, {
        PROJECT_ROOT: config.cwd,
      }) ?? "",
    )
    : [];

  return {
    id: sanitizeId(serverId),
    name: toString(record.name) ?? serverId,
    scope,
    sourcePath,
    transport,
    command,
    args,
    cwd,
    env,
    envKeys: Object.keys(env),
    enabled,
    timeoutMs: Number(record.timeoutMs ?? config.mcpTimeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS),
    maxRetries: Number(record.maxRetries ?? config.mcpMaxRetries ?? 0),
    retryBudgetMs: Number(record.retryBudgetMs ?? config.mcpRetryBudgetMs ?? 4000),
    baseDelayMs: Number(record.baseDelayMs ?? 200),
    maxDelayMs: Number(record.maxDelayMs ?? 1500),
    protocolVersion: toString(record.protocolVersion) ?? "2025-03-26",
  };
}

function resolveEnvironment(
  envObject: unknown,
  templateContext: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(
    envObject && typeof envObject === "object" && !Array.isArray(envObject)
      ? envObject as Record<string, unknown>
      : {},
  );
  return Object.fromEntries(entries.map(([key, value]) => [
    key,
    expandTemplate(value, templateContext) ?? "",
  ]));
}

function expandTemplate(
  value: unknown,
  templateContext: Record<string, string>,
): string | null {
  if (value == null) {
    return null;
  }

  return `${value}`.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, key: string, fallback: string) => {
    if (Object.hasOwn(templateContext, key)) {
      return templateContext[key];
    }
    return process.env[key] ?? fallback ?? "";
  });
}

function resolveConfigPath(value: string | null, cwd: string): string {
  if (!value) {
    return cwd;
  }

  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function normalizeTransport(value: unknown): string {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (normalized === "stdio") {
    return "stdio";
  }

  throw createMcpProtocolError(`Unsupported MCP transport "${value}".`, {
    retryable: false,
  });
}

function sanitizeId(value: string): string {
  return `${value ?? ""}`.trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error != null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function toString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableStep(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}
