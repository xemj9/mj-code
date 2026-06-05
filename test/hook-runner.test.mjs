import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ExecutionBoundary } from "../src/lib/execution-boundary.mjs";
import { HookRunner } from "../src/lib/hook-runner.mjs";

function createExecutionBoundary(root) {
  return new ExecutionBoundary({
    cwd: root,
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    networkMode: "docs-only",
    shellTimeoutMs: 5_000,
    hookTimeoutMs: 5_000,
    executionBoundaryMode: "workspace",
  });
}

test("hook runner emits advisory metadata and observed change-sets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-hook-runner-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const notePath = path.join(root, "note.txt");
  await fs.writeFile(notePath, "before\n", "utf8");

  const runner = new HookRunner({
    cwd: root,
    projectStateDir,
    hooks: [
      {
        id: "after-apply-format",
        event: "after_apply",
        command: "echo",
        args: ["format"],
        failMode: "open",
        filters: {
          writeOnly: true,
        },
      },
    ],
    hookTimeoutMs: 5_000,
  }, {
    executionBoundary: createExecutionBoundary(root),
    shellRuntime: {
      async run(input) {
        assert.equal(input.command, "echo");
        await fs.writeFile(notePath, "after\n", "utf8");
        return {
          jobId: "hook-job-1",
          status: "exited",
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 4,
          stdout: JSON.stringify({
            advisory: "formatted",
            trace: { formatter: "mock" },
          }),
          stderr: "",
        };
      },
    },
  });
  await runner.initialize();

  const result = await runner.emit("after_apply", {
    category: "apply",
    changeSet: { id: "change-1" },
  }, {
    traceId: "trace-1",
    observePaths: ["note.txt"],
  });

  assert.equal(result.matched, 1);
  assert.equal(result.blocked, false);
  assert.equal(result.results[0].advisory, "formatted");
  assert.deepEqual(result.results[0].traceMeta, { formatter: "mock" });
  assert.equal(result.observedChangeSets.length, 1);
  assert.ok(result.observedChangeSets[0].touchedFiles.includes(notePath));
});

test("hook runner blocks closed-mode before_tool failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-hook-runner-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });

  const runner = new HookRunner({
    cwd: root,
    projectStateDir,
    hooks: [
      {
        id: "before-tool-guard",
        event: "before_tool",
        command: "echo",
        args: ["guard"],
        failMode: "closed",
      },
    ],
    hookTimeoutMs: 5_000,
  }, {
    executionBoundary: createExecutionBoundary(root),
    shellRuntime: {
      async run() {
        throw Object.assign(new Error("hook failed"), {
          taxonomy: "shell_error",
        });
      },
    },
  });
  await runner.initialize();

  const result = await runner.emit("before_tool", {
    toolName: "run_shell",
    category: "write",
  }, {
    traceId: "trace-2",
  });

  assert.equal(result.blocked, true);
  assert.equal(result.results[0].status, "blocked");
  assert.equal(result.results[0].blockReason, 'Hook "before-tool-guard" failed in closed mode.');
  assert.equal(result.results[0].shellResult.error.taxonomy, "shell_error");
});
