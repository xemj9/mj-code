import test from "node:test";
import assert from "node:assert/strict";

import {
  McpError,
  createMcpCircuitOpenError,
  createMcpProtocolError,
  createMcpTimeoutError,
  finalizeMcpError,
  isRetryableMcpError,
  normalizeMcpError,
  serializeMcpError,
} from "../src/lib/mcp-errors.mjs";

test("normalizeMcpError classifies retryable transport failures", () => {
  const normalized = normalizeMcpError(Object.assign(new Error("socket closed"), {
    code: "ECONNRESET",
  }), {
    serverId: "server-a",
    method: "tools/call",
    attempt: 2,
  });

  assert.equal(normalized.taxonomy, "mcp_transport_error");
  assert.equal(normalized.code, "econnreset");
  assert.equal(normalized.retryable, true);
  assert.equal(normalized.serverId, "server-a");
});

test("finalizeMcpError marks retry exhaustion and preserves attempts", () => {
  const error = createMcpTimeoutError({
    serverId: "server-b",
    method: "initialize",
    timeoutMs: 2500,
  });
  const finalError = finalizeMcpError(error, [
    { attempt: 1, ok: false, durationMs: 2500, taxonomy: "mcp_timeout", code: "timeout" },
    { attempt: 2, ok: false, durationMs: 2500, taxonomy: "mcp_timeout", code: "timeout" },
  ]);

  assert.equal(finalError.retryExhausted, true);
  assert.equal(finalError.taxonomy, "mcp_retry_exhausted");
  assert.equal(finalError.attempts.length, 2);
  assert.equal(isRetryableMcpError(finalError), true);
});

test("serializeMcpError keeps stable envelope fields", () => {
  const error = createMcpProtocolError("invalid payload", {
    serverId: "server-c",
    serverName: "Server C",
    requestId: 7,
    method: "tools/call",
    toolName: "search",
    details: { field: "arguments" },
  });
  const serialized = serializeMcpError(error);

  assert.deepEqual(serialized, {
    name: "McpError",
    message: "invalid payload",
    taxonomy: "mcp_protocol_error",
    code: "protocol_error",
    serverId: "server-c",
    serverName: "Server C",
    method: "tools/call",
    toolName: "search",
    requestId: 7,
    traceId: null,
    attempt: 1,
    retryable: false,
    retryExhausted: false,
    details: { field: "arguments" },
    attempts: [],
  });
});

test("McpError preserves cause, details, attempts, and circuit metadata", () => {
  const cause = new Error("broken pipe");
  const error = new McpError("transport failed", {
    cause,
    taxonomy: "mcp_transport_error",
    code: "transport_error",
    details: { stderrTail: "oops" },
    attempts: [{ attempt: 1, ok: false, durationMs: 12 }],
  });
  const circuitError = createMcpCircuitOpenError("circuit open", {
    serverId: "server-d",
    circuit: { key: "mcp:server-d:invoke", state: "open" },
  });

  assert.equal(error.cause, cause);
  assert.deepEqual(error.details, { stderrTail: "oops" });
  assert.deepEqual(error.attempts, [{ attempt: 1, ok: false, durationMs: 12 }]);
  assert.deepEqual(circuitError.details, {
    circuit: { key: "mcp:server-d:invoke", state: "open" },
  });
});
