import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpClient } from "../src/lib/mcp-client.mjs";
import { RuntimeHealth } from "../src/lib/runtime-health.mjs";

const FIXTURE_SERVER = path.resolve("fixtures/mock-mcp-server.mjs");

test("mcp client initializes, paginates tools, and calls a tool over stdio", async () => {
  const events = [];
  const client = new McpClient({
    id: "mock",
    name: "mock",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE_SERVER],
    cwd: process.cwd(),
    env: process.env,
    envKeys: [],
    enabled: true,
    timeoutMs: 3000,
    maxRetries: 0,
  }, {
    onEvent: async (event) => events.push(event.type),
  });

  try {
    const server = await client.initialize();
    assert.equal(server.id, "mock");

    const tools = await client.listTools();
    assert.equal(tools.length, 2);
    assert.equal(tools[0].normalizedName, "mcp__mock__echo");

    const result = await client.callTool("echo", { text: "hello" });
    assert.equal(result.summary, "echo:hello");
    assert.ok(events.includes("mcp_client_initialized"));
    assert.ok(events.includes("mcp_client_tool_called"));
  } finally {
    await client.close();
  }
});

test("mcp client opens a circuit after repeated exhausted failures and blocks until cooldown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-mcp-circuit-"));
  const runtimeHealth = new RuntimeHealth({
    projectStateDir: path.join(root, ".mj-code"),
    runtimeCircuitFailureThreshold: 2,
    runtimeCircuitCooldownMs: 20,
    runtimeCircuitHalfOpenMaxRequests: 1,
  });
  await runtimeHealth.initialize();

  const client = new McpClient({
    id: "slow",
    name: "slow",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE_SERVER],
    cwd: process.cwd(),
    env: process.env,
    envKeys: [],
    enabled: true,
    timeoutMs: 200,
    maxRetries: 0,
  }, {
    runtimeHealth,
  });

  try {
    await client.initialize();
    await assert.rejects(() => client.callTool("slow_echo", { text: "later", delayMs: 150 }, { timeoutMs: 40 }));
    await assert.rejects(() => client.callTool("slow_echo", { text: "later", delayMs: 150 }, { timeoutMs: 40 }));

    await assert.rejects(
      () => client.callTool("slow_echo", { text: "later", delayMs: 150 }, { timeoutMs: 40 }),
      (error) => error.taxonomy === "mcp_circuit_open",
    );
    assert.ok(runtimeHealth.listCircuits("mcp").some((entry) => entry.requestClass === "invoke" && entry.state === "open"));

    await new Promise((resolve) => setTimeout(resolve, 25));
    const result = await client.callTool("echo", { text: "after" }, { timeoutMs: 200 });
    assert.equal(result.summary, "echo:after");
    assert.ok(runtimeHealth.listCircuits("mcp").some((entry) => entry.requestClass === "invoke" && entry.state === "closed"));
  } finally {
    await client.close();
  }
});

test("mcp client surfaces timeout as structured error", async () => {
  const client = new McpClient({
    id: "slow",
    name: "slow",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE_SERVER],
    cwd: process.cwd(),
    env: process.env,
    envKeys: [],
    enabled: true,
    timeoutMs: 200,
    maxRetries: 0,
  });

  try {
    await client.initialize();
    await assert.rejects(
      client.callTool("slow_echo", { text: "later", delayMs: 150 }, { timeoutMs: 40 }),
      (error) => error.taxonomy === "mcp_retry_exhausted" || error.taxonomy === "mcp_timeout",
    );
  } finally {
    await client.close();
  }
});
