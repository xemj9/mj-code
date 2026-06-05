import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpRegistry, loadMcpServerConfigs } from "../src/lib/mcp-registry.mjs";

const FIXTURE_SERVER = path.resolve("fixtures/mock-mcp-server.mjs");

test("mcp registry merges config scopes and exposes normalized tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-mcp-registry-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });

  const userConfigPath = path.join(root, "user-mcp.json");
  const projectConfigPath = path.join(root, ".mcp.json");
  const localConfigPath = path.join(projectStateDir, "mcp.local.json");

  await fs.writeFile(userConfigPath, JSON.stringify({
    mcpServers: {
      shared: {
        command: process.execPath,
        args: [FIXTURE_SERVER],
        env: {
          TEST_SCOPE: "user",
        },
      },
    },
  }, null, 2));
  await fs.writeFile(projectConfigPath, JSON.stringify({
    mcpServers: {
      shared: {
        command: process.execPath,
        args: [FIXTURE_SERVER],
        env: {
          TEST_SCOPE: "project",
        },
      },
      secondary: {
        command: process.execPath,
        args: [FIXTURE_SERVER],
      },
    },
  }, null, 2));
  await fs.writeFile(localConfigPath, JSON.stringify({
    mcpServers: {
      shared: {
        command: process.execPath,
        args: [FIXTURE_SERVER],
        env: {
          TEST_SCOPE: "local",
        },
        timeoutMs: 2000,
      },
    },
  }, null, 2));

  const config = {
    cwd: root,
    projectStateDir,
    mcpEnabled: true,
    mcpTimeoutMs: 3000,
    mcpMaxRetries: 0,
    mcpRetryBudgetMs: 1000,
    mcpConfigPaths: [
      { scope: "user", path: userConfigPath },
      { scope: "project", path: projectConfigPath },
      { scope: "local", path: localConfigPath },
    ],
  };

  const loaded = await loadMcpServerConfigs(config);
  const shared = loaded.servers.find((entry) => entry.id === "shared");
  assert.equal(shared.scope, "local");
  assert.equal(shared.env.TEST_SCOPE, "local");

  const registry = new McpRegistry(config);
  await registry.initialize();

  const servers = registry.listServers();
  assert.equal(servers.length, 2);
  assert.ok(servers.every((entry) => entry.healthScore >= 0));

  const tools = registry.listTools();
  assert.ok(tools.some((entry) => entry.name === "mcp__shared__echo"));

  const result = await registry.invokeTool("mcp__shared__echo", { text: "registry" }, {
    traceId: "trace-registry",
    step: 1,
  });
  assert.equal(result.summary, "echo:registry");

  const inspected = registry.inspectServer("shared");
  assert.equal(inspected.timeoutMs, 2000);

  await registry.close();
});
