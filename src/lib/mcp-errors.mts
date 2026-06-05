import type { McpAttemptRecord, SerializedMcpError } from "../types/contracts.js";

interface McpErrorOptions {
  cause?: unknown;
  taxonomy?: string;
  code?: string;
  serverId?: string | null;
  serverName?: string | null;
  method?: string | null;
  toolName?: string | null;
  requestId?: string | number | null;
  traceId?: string | null;
  attempt?: number;
  retryable?: boolean;
  retryExhausted?: boolean;
  details?: Record<string, unknown> | null;
  attempts?: McpAttemptRecord[];
}

interface McpTimeoutErrorOptions extends McpErrorOptions {
  timeoutMs?: number | null;
}

interface McpCircuitOpenErrorOptions extends McpErrorOptions {
  circuit?: unknown;
}

export interface McpErrorDefaults extends Partial<McpErrorOptions> {
  timeoutMs?: number | null;
  circuit?: unknown;
}

export class McpError extends Error {
  taxonomy: string;
  code: string;
  serverId: string | null;
  serverName: string | null;
  method: string | null;
  toolName: string | null;
  requestId: string | number | null;
  traceId: string | null;
  attempt: number;
  retryable: boolean;
  retryExhausted: boolean;
  details: Record<string, unknown> | null;
  attempts: McpAttemptRecord[];

  constructor(message: string, options: McpErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "McpError";
    this.taxonomy = options.taxonomy ?? "mcp_error";
    this.code = options.code ?? "mcp_error";
    this.serverId = options.serverId ?? null;
    this.serverName = options.serverName ?? null;
    this.method = options.method ?? null;
    this.toolName = options.toolName ?? null;
    this.requestId = options.requestId ?? null;
    this.traceId = options.traceId ?? null;
    this.attempt = options.attempt ?? 1;
    this.retryable = options.retryable ?? false;
    this.retryExhausted = options.retryExhausted ?? false;
    this.details = options.details ?? null;
    this.attempts = Array.isArray(options.attempts) ? [...options.attempts] : [];
  }
}

export function createMcpTimeoutError(options: McpTimeoutErrorOptions = {}): McpError {
  return new McpError(
    `${options.method ?? "MCP request"} timed out after ${options.timeoutMs}ms.`,
    {
      ...options,
      taxonomy: "mcp_timeout",
      code: "timeout",
      retryable: true,
      details: {
        timeoutMs: options.timeoutMs ?? null,
      },
    },
  );
}

export function createMcpTransportError(message: string, options: McpErrorOptions = {}): McpError {
  return new McpError(message, {
    ...options,
    taxonomy: "mcp_transport_error",
    code: options.code ?? "transport_error",
    retryable: options.retryable ?? true,
  });
}

export function createMcpProtocolError(message: string, options: McpErrorOptions = {}): McpError {
  return new McpError(message, {
    ...options,
    taxonomy: "mcp_protocol_error",
    code: options.code ?? "protocol_error",
    retryable: false,
  });
}

export function createMcpServerError(message: string, options: McpErrorOptions = {}): McpError {
  return new McpError(message, {
    ...options,
    taxonomy: "mcp_server_error",
    code: options.code ?? "server_error",
    retryable: options.retryable ?? false,
  });
}

export function createMcpToolError(message: string, options: McpErrorOptions = {}): McpError {
  return new McpError(message, {
    ...options,
    taxonomy: "mcp_tool_error",
    code: options.code ?? "tool_error",
    retryable: false,
  });
}

export function createMcpCircuitOpenError(
  message: string,
  options: McpCircuitOpenErrorOptions = {},
): McpError {
  return new McpError(message, {
    ...options,
    taxonomy: "mcp_circuit_open",
    code: options.code ?? "circuit_open",
    retryable: false,
    details: {
      circuit: options.circuit ?? null,
      ...(options.details ?? {}),
    },
  });
}

export function normalizeMcpError(error: unknown, defaults: McpErrorDefaults = {}): McpError {
  if (error instanceof McpError) {
    if (!error.serverId && defaults.serverId) {
      error.serverId = defaults.serverId;
    }
    if (!error.serverName && defaults.serverName) {
      error.serverName = defaults.serverName;
    }
    if (!error.method && defaults.method) {
      error.method = defaults.method;
    }
    if (!error.toolName && defaults.toolName) {
      error.toolName = defaults.toolName;
    }
    if (!error.traceId && defaults.traceId) {
      error.traceId = defaults.traceId;
    }
    if (error.attempt == null && defaults.attempt != null) {
      error.attempt = defaults.attempt;
    }
    return error;
  }

  const message = `${getErrorMessage(error)}`.toLowerCase();
  const code = `${getErrorCode(error)}`.toLowerCase();
  const retryable =
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("closed") ||
    message.includes("broken pipe") ||
    code === "econnreset" ||
    code === "eagain";

  return createMcpTransportError(`MCP transport failure: ${getErrorMessage(error)}`, {
    ...defaults,
    code: code || "transport_error",
    retryable,
    details: {
      message: getErrorMessage(error),
      code: getErrorCode(error),
      name: getErrorName(error),
    },
    cause: error,
  });
}

export function finalizeMcpError(
  error: unknown,
  attempts: McpAttemptRecord[] = [],
): McpError {
  const normalized = normalizeMcpError(error);
  normalized.attempts = [...attempts];
  if (normalized.retryable && attempts.length > 0) {
    normalized.retryExhausted = true;
    normalized.taxonomy = "mcp_retry_exhausted";
  }
  return normalized;
}

export function isRetryableMcpError(error: unknown): boolean {
  return normalizeMcpError(error).retryable === true;
}

export function serializeMcpError(error: unknown): SerializedMcpError {
  const normalized = normalizeMcpError(error);
  return {
    name: normalized.name,
    message: normalized.message,
    taxonomy: normalized.taxonomy,
    code: normalized.code,
    serverId: normalized.serverId,
    serverName: normalized.serverName,
    method: normalized.method,
    toolName: normalized.toolName,
    requestId: normalized.requestId,
    traceId: normalized.traceId,
    attempt: normalized.attempt,
    retryable: normalized.retryable,
    retryExhausted: normalized.retryExhausted,
    details: normalized.details,
    attempts: normalized.attempts.map((entry) => ({ ...entry })),
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return `${error ?? ""}`;
}

function getErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error && "code" in error) {
    return typeof error.code === "string" ? error.code : `${error.code ?? ""}`;
  }
  return null;
}

function getErrorName(error: unknown): string | null {
  if (error instanceof Error) {
    return error.name;
  }
  if (typeof error === "object" && error && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return null;
}
