import crypto from "node:crypto";
import { spawn } from "node:child_process";

import {
  createMcpProtocolError,
  createMcpTimeoutError,
  createMcpTransportError,
} from "./mcp-errors.mjs";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "../types/contracts.js";

type JsonRpcId = string | number;

interface McpTransportEvent extends Record<string, unknown> {
  type: string;
}

interface McpStdioTransportOptions {
  onEvent?: ((event: McpTransportEvent) => Promise<void> | void) | null;
}

export interface McpTransportRequestOptions {
  requestId?: JsonRpcId;
  timeoutMs?: number;
}

interface PendingRequest {
  method: string;
  resolve: (response: unknown) => void;
  reject: (error: unknown) => void;
}

interface JsonRpcResponseMessage extends Record<string, unknown> {
  id: JsonRpcId;
  result?: unknown;
  error?: Record<string, unknown> | null;
}

interface JsonRpcNotificationMessage extends Record<string, unknown> {
  method: string;
  params?: unknown;
}

export class McpStdioTransport {
  readonly serverConfig: McpServerConfig;
  readonly onEvent: ((event: McpTransportEvent) => Promise<void> | void) | null;
  child: ChildProcessWithoutNullStreams | null;
  buffer: string;
  pending: Map<JsonRpcId, PendingRequest>;
  connected: boolean;
  closed: boolean;
  stderrTail: string;

  constructor(serverConfig: McpServerConfig, options: McpStdioTransportOptions = {}) {
    this.serverConfig = serverConfig;
    this.onEvent = options.onEvent ?? null;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.connected = false;
    this.closed = false;
    this.stderrTail = "";
  }

  async connect(): Promise<void> {
    if (this.child && !this.closed) {
      return;
    }

    if (!this.serverConfig.command) {
      throw createMcpTransportError(`MCP server "${this.serverConfig.id}" is missing a command.`, {
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        retryable: false,
      });
    }

    this.child = spawn(this.serverConfig.command, this.serverConfig.args ?? [], {
      cwd: this.serverConfig.cwd,
      env: this.serverConfig.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.closed = false;

    const child = this.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string | Buffer) => {
      this.handleStdout(`${chunk}`).catch((error: unknown) => {
        this.failAllPending(error);
      });
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = `${chunk}`;
      this.stderrTail = `${this.stderrTail}${text}`.slice(-4000);
      void this.emitEvent({
        type: "mcp_transport_stderr",
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        text: text.slice(-400),
      }).catch(() => {});
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.failAllPending(createMcpTransportError(`MCP process error: ${error.message}`, {
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        code: error.code ?? "spawn_error",
        details: {
          stderrTail: this.stderrTail || null,
        },
      }));
    });
    child.on("exit", (code, signal) => {
      const error = createMcpTransportError(
        `MCP process exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`,
        {
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          code: code == null ? "process_exit" : `exit_${code}`,
          retryable: true,
          details: {
            exitCode: code,
            signal,
            stderrTail: this.stderrTail || null,
          },
        },
      );
      this.connected = false;
      this.closed = true;
      this.failAllPending(error);
      void this.emitEvent({
        type: "mcp_transport_exit",
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        exitCode: code,
        signal,
      }).catch(() => {});
    });

    this.connected = true;
    await this.emitEvent({
      type: "mcp_transport_connected",
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      pid: child.pid ?? null,
    });
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    options: McpTransportRequestOptions = {},
  ): Promise<unknown> {
    await this.connect();

    const child = this.requireChild();
    const requestId = options.requestId ?? crypto.randomUUID().slice(0, 12);
    const timeoutMs = Number(options.timeoutMs ?? 10000);
    const payload = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method,
      params,
    };

    await this.emitEvent({
      type: "mcp_transport_request_sent",
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      requestId,
      method,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(createMcpTimeoutError({
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          method,
          requestId,
          timeoutMs,
          details: {
            stderrTail: this.stderrTail || null,
          },
        }));
      }, timeoutMs);
      timer.unref();

      this.pending.set(requestId, {
        method,
        resolve: (response: unknown) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.connect();
    const payload = {
      jsonrpc: "2.0" as const,
      method,
      params,
    };
    this.requireChild().stdin.write(`${JSON.stringify(payload)}\n`);
    await this.emitEvent({
      type: "mcp_transport_notification_sent",
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      method,
    });
  }

  async close(): Promise<void> {
    if (!this.child || this.closed) {
      return;
    }
    this.closed = true;
    this.connected = false;
    const child = this.child;
    if (child.exitCode != null || child.killed) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 500);
      timer.unref();

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      child.stdin.end();
      child.kill("SIGTERM");
    });
  }

  async handleStdout(chunk: string): Promise<void> {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        throw createMcpProtocolError(`Invalid JSON from MCP server "${this.serverConfig.id}".`, {
          serverId: this.serverConfig.id,
          serverName: this.serverConfig.name,
          details: {
            line: line.slice(0, 300),
            stderrTail: this.stderrTail || null,
          },
          cause: error,
        });
      }

      if (Array.isArray(message)) {
        for (const entry of message) {
          await this.handleMessage(entry);
        }
        continue;
      }

      await this.handleMessage(message);
    }
  }

  async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    if (isJsonRpcResponseMessage(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        const errorDetails = isRecord(message.error) ? message.error : {};
        pending.reject(createMcpProtocolError(
          `MCP request ${pending.method} failed: ${getErrorMessage(errorDetails.message) ?? "unknown error"}`,
          {
            serverId: this.serverConfig.id,
            serverName: this.serverConfig.name,
            method: pending.method,
            requestId: message.id,
            code: getErrorCode(errorDetails.code) ?? "jsonrpc_error",
            details: errorDetails,
          },
        ));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (isJsonRpcNotificationMessage(message)) {
      await this.emitEvent({
        type: "mcp_transport_notification_received",
        serverId: this.serverConfig.id,
        serverName: this.serverConfig.name,
        method: message.method,
        params: message.params ?? null,
      });
    }
  }

  failAllPending(error: unknown): void {
    for (const [requestId, pending] of this.pending.entries()) {
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  async emitEvent(event: McpTransportEvent): Promise<void> {
    if (typeof this.onEvent === "function") {
      await this.onEvent(event);
    }
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }

    throw createMcpTransportError(`MCP server "${this.serverConfig.id}" is not connected.`, {
      serverId: this.serverConfig.id,
      serverName: this.serverConfig.name,
      retryable: true,
    });
  }
}

function isJsonRpcResponseMessage(message: Record<string, unknown>): message is JsonRpcResponseMessage {
  return message.id != null && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
}

function isJsonRpcNotificationMessage(message: Record<string, unknown>): message is JsonRpcNotificationMessage {
  return typeof message.method === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getErrorMessage(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return `${value}`;
  }
  return null;
}

function getErrorCode(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return `${value}`;
  }
  return null;
}
