import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIXTURE_SERVER = path.resolve("fixtures/mock-mcp-server.mjs");

test("cli can list MCP servers and tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-mcp-cli-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });
  await fs.writeFile(path.join(root, ".mcp.json"), JSON.stringify({
    mcpServers: {
      demo: {
        command: process.execPath,
        args: [FIXTURE_SERVER],
      },
    },
  }, null, 2));

  const serverResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "mcp",
    "servers",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  const servers = JSON.parse(serverResult.stdout);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, "demo");

  const toolResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "mcp",
    "tools",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  const tools = JSON.parse(toolResult.stdout);
  assert.ok(tools.some((entry) => entry.name === "mcp__demo__echo"));
});
