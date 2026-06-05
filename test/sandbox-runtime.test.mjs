import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SandboxRuntime } from "../src/lib/sandbox-runtime.mjs";

test("sandbox runtime detects platform and availability", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-sandbox-"));
  const sandbox = new SandboxRuntime({ cwd: root, projectStateDir: root });
  await sandbox.initialize();

  assert.ok(["macos", "linux", "unknown"].includes(sandbox.platform));

  const avail = await sandbox.checkAvailability();
  assert.equal(typeof avail.available, "boolean");
  assert.ok(["off", "policy", "os", "container"].includes(avail.isolationLevel));
  assert.ok(Array.isArray(avail.mechanisms));
  assert.ok(Array.isArray(avail.limitations));
});

test("sandbox runs a command and returns result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-sandbox-"));
  const sandbox = new SandboxRuntime({ cwd: root, projectStateDir: root, isolationLevel: "policy" });
  await sandbox.initialize();

  const result = await sandbox.run({ command: "echo hello sandbox" });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("hello sandbox"));
  assert.equal(result.sandboxed, true);
  assert.equal(result.isolationLevel, "policy");
  assert.ok(result.durationMs >= 0);
});

test("sandbox blocks network when allowNetwork is false", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-sandbox-"));
  const sandbox = new SandboxRuntime({ cwd: root, projectStateDir: root, isolationLevel: "os" });
  await sandbox.initialize();

  const avail = await sandbox.checkAvailability();
  if (!avail.available) {
    // Skip on platforms without OS sandboxing
    return;
  }

  const result = await sandbox.run({
    command: "curl -s --connect-timeout 3 https://httpbin.org/ip 2>&1; echo EXIT:$?",
    allowNetwork: false,
  });

  assert.equal(result.metadata.networkBlocked, true);
  // curl should fail (either exit code != 0 or output contains error)
  const failed = result.exitCode !== 0 || result.stdout.includes("could not") || result.stdout.includes("EXIT:6") || result.stdout.includes("EXIT:7");
  assert.ok(failed, "Network request should be blocked in sandbox");
});

test("sandbox filters environment variables", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-sandbox-"));
  const sandbox = new SandboxRuntime({ cwd: root, projectStateDir: root, isolationLevel: "policy" });
  await sandbox.initialize();

  const result = await sandbox.run({ command: "echo MJ_CODE_SANDBOX=$MJ_CODE_SANDBOX" });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("MJ_CODE_SANDBOX=1"));
});

test("sandbox respects timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-sandbox-"));
  const sandbox = new SandboxRuntime({ cwd: root, projectStateDir: root, isolationLevel: "policy", shellTimeoutMs: 2000 });
  await sandbox.initialize();

  const result = await sandbox.run({ command: "sleep 10", timeoutMs: 1000 });
  assert.equal(result.timedOut, true);
});
