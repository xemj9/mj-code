import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeHealth } from "../src/lib/runtime-health.mjs";

test("runtime health aggregates provider, web, mcp, and shell surfaces", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-runtime-health-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });

  const runtimeHealth = new RuntimeHealth({
    projectStateDir,
    runtimeCircuitFailureThreshold: 2,
    runtimeCircuitCooldownMs: 10,
    runtimeCircuitHalfOpenMaxRequests: 1,
  });
  await runtimeHealth.initialize();
  await runtimeHealth.bindSession({
    sessionId: "session-a",
    rootSessionId: "session-a",
  });

  await runtimeHealth.beforeProviderRequest({
    provider: "openai-compatible",
    requestType: "models_list",
    endpoint: "https://example.test/v1/models",
  });
  await runtimeHealth.noteProviderRetry({
    provider: "openai-compatible",
    requestType: "models_list",
    endpoint: "https://example.test/v1/models",
    delayMs: 50,
  });
  await runtimeHealth.noteProviderOutcome({
    provider: "openai-compatible",
    requestType: "models_list",
    endpoint: "https://example.test/v1/models",
    success: false,
    totalDurationMs: 120,
    error: {
      provider: "openai-compatible",
      requestType: "models_list",
      taxonomy: "provider_retry_exhausted",
      reasonTaxonomy: "provider_error",
      status: 503,
      code: "http_503",
      retryExhausted: true,
    },
  });
  await runtimeHealth.beforeProviderRequest({
    provider: "openai-compatible",
    requestType: "models_list",
    endpoint: "https://example.test/v1/models",
  });
  await runtimeHealth.noteProviderOutcome({
    provider: "openai-compatible",
    requestType: "models_list",
    endpoint: "https://example.test/v1/models",
    success: false,
    totalDurationMs: 140,
    error: {
      provider: "openai-compatible",
      requestType: "models_list",
      taxonomy: "provider_retry_exhausted",
      reasonTaxonomy: "provider_error",
      status: 503,
      code: "http_503",
      retryExhausted: true,
    },
  });

  await runtimeHealth.beforeWebRequest({
    provider: "fallback",
    requestType: "search",
    endpoint: "https://search.example.test/query",
  });
  await runtimeHealth.noteWebOutcome({
    provider: "fallback",
    requestType: "search",
    endpoint: "https://search.example.test/query",
    success: false,
    totalDurationMs: 90,
    error: {
      provider: "fallback",
      requestType: "search",
      taxonomy: "network_error",
      status: 503,
      retryExhausted: true,
    },
  });
  await runtimeHealth.beforeWebRequest({
    provider: "fallback",
    requestType: "search",
    endpoint: "https://search.example.test/query",
  });
  await runtimeHealth.noteWebOutcome({
    provider: "fallback",
    requestType: "search",
    endpoint: "https://search.example.test/query",
    success: false,
    totalDurationMs: 95,
    error: {
      provider: "fallback",
      requestType: "search",
      taxonomy: "network_error",
      status: 503,
      retryExhausted: true,
    },
  });

  await runtimeHealth.beforeMcpRequest({
    serverId: "demo",
    serverName: "demo",
    requestClass: "invoke",
    endpoint: "tools/call",
  });
  await runtimeHealth.noteMcpOutcome({
    serverId: "demo",
    serverName: "demo",
    requestClass: "invoke",
    endpoint: "tools/call",
    success: false,
    totalDurationMs: 50,
    error: {
      serverId: "demo",
      method: "tools/call",
      taxonomy: "mcp_retry_exhausted",
      retryExhausted: true,
    },
  });
  await runtimeHealth.beforeMcpRequest({
    serverId: "demo",
    serverName: "demo",
    requestClass: "invoke",
    endpoint: "tools/call",
  });
  await runtimeHealth.noteMcpOutcome({
    serverId: "demo",
    serverName: "demo",
    requestClass: "invoke",
    endpoint: "tools/call",
    success: false,
    totalDurationMs: 55,
    error: {
      serverId: "demo",
      method: "tools/call",
      taxonomy: "mcp_retry_exhausted",
      retryExhausted: true,
    },
  });

  await runtimeHealth.recordWebEvent({
    type: "web_attempt_succeeded",
    requestType: "search",
    provider: "fallback",
    durationMs: 80,
  });
  await runtimeHealth.recordMcpEvent({
    type: "mcp_client_tool_called",
    serverId: "demo",
    latencyMs: 30,
    method: "tools/call",
  }, [{
    id: "demo",
    name: "demo",
    status: "ready",
    healthScore: 92,
    latencyMs: 30,
    errorRate: 0,
    lastFailureAt: null,
    lastSuccessAt: new Date().toISOString(),
  }]);
  await runtimeHealth.noteShellSnapshot([
    { id: "job-1", status: "running", background: true, live: true, reattached: true, historicalOnly: false, timedOut: false, continuityState: "reattached" },
    { id: "job-2", status: "orphaned", background: true, live: false, reattached: false, historicalOnly: true, timedOut: false, continuityState: "orphaned" },
  ], {
    sessionId: "session-a",
  });

  const scorecard = runtimeHealth.getScorecard();
  assert.ok(scorecard.provider.totalRequests >= 2);
  assert.ok(scorecard.web.totalRequests >= 1);
  assert.ok(scorecard.mcp.totalRequests >= 1);
  assert.equal(scorecard.shell.orphanedJobs, 1);
  assert.ok(scorecard.degradedFlags.includes("provider_circuit_open"));
  assert.ok(scorecard.degradedFlags.includes("web_circuit_open"));
  assert.ok(scorecard.degradedFlags.includes("mcp_circuit_open"));
  assert.ok(scorecard.degradedFlags.includes("shell_orphaned_jobs"));
  assert.equal(typeof scorecard.retryPressure, "number");
  assert.equal(scorecard.circuits.byLayer.web.open, 1);
  assert.equal(scorecard.circuits.byLayer.mcp.open, 1);

  const circuits = runtimeHealth.listCircuits("all");
  assert.equal(circuits.length, 3);
  assert.equal(runtimeHealth.listCircuits("provider")[0].state, "open");
  assert.equal(runtimeHealth.listCircuits("web")[0].state, "open");
  assert.equal(runtimeHealth.listCircuits("mcp")[0].state, "open");
  assert.equal(circuits[0].state, "open");
});
