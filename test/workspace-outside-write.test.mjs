import test from "node:test";
import assert from "node:assert/strict";

import { evaluateToolPermission } from "../src/lib/permissions.mjs";
import { ExecutionBoundary, classifyShellCommand } from "../src/lib/execution-boundary.mjs";

// ─── Fix 1: workspace-outside write path should require approval, not hard-block ───

test("write_file to path outside workspace requires approval instead of hard-blocking", () => {
  const workspaceRoot = "/Users/tester/mj-code";
  const outsidePath = "/Users/tester/.qoder/output.md";

  const decision = evaluateToolPermission({
    toolName: "write_file",
    toolSource: "local",
    input: { path: outsidePath, content: "hello" },
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    workspaceRoot,
    networkMode: "open-web",
  });

  // Previously: allowed=false, requiresApproval=false (hard-blocked)
  // Now: allowed=true, requiresApproval=true (user can approve)
  assert.equal(decision.allowed, true, "Should be allowed (with approval)");
  assert.equal(decision.requiresApproval, true, "Should require approval for outside-workspace paths");
  assert.ok(decision.reason?.includes("outside workspace"), "Reason should mention 'outside workspace'");
  assert.ok(Array.isArray(decision.targetPaths));
  assert.ok(decision.targetPaths.includes(outsidePath));
});

test("write_file to path inside workspace is allowed normally", () => {
  const workspaceRoot = "/Users/tester/mj-code";
  const insidePath = "/Users/tester/mj-code/output.md";

  const decision = evaluateToolPermission({
    toolName: "write_file",
    toolSource: "local",
    input: { path: insidePath, content: "hello" },
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    workspaceRoot,
    networkMode: "open-web",
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true); // on-write policy
  assert.equal(decision.reason, null);
});

// ─── Fix 2: safe write commands (mkdir, touch) should be allowed in workspace-write mode ───

test("mkdir command is allowed in workspace-write mode", () => {
  const workspaceRoot = "/Users/tester/mj-code";
  const boundary = new ExecutionBoundary({
    cwd: workspaceRoot,
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    networkMode: "open-web",
    shellTimeoutMs: 30000,
    hookTimeoutMs: 5000,
  });

  const decision = boundary.evaluateTool({
    toolName: "run_shell",
    input: { command: "mkdir -p /Users/tester/.qoder" },
  });

  // Should not be blocked — mkdir is a safe write command
  assert.equal(decision.blocked, false, "mkdir should not be hard-blocked");
  // It may still require approval
  assert.ok(decision.requiresApproval !== undefined);
});

test("touch command is allowed in workspace-write mode", () => {
  const workspaceRoot = "/Users/tester/mj-code";
  const boundary = new ExecutionBoundary({
    cwd: workspaceRoot,
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    networkMode: "open-web",
    shellTimeoutMs: 30000,
    hookTimeoutMs: 5000,
  });

  const decision = boundary.evaluateTool({
    toolName: "run_shell",
    input: { command: "touch /Users/tester/.qoder/new-file.md" },
  });

  assert.equal(decision.blocked, false, "touch should not be hard-blocked");
});

test("dangerous command (rm -rf) is still blocked in workspace-write mode", () => {
  const workspaceRoot = "/Users/tester/mj-code";
  const boundary = new ExecutionBoundary({
    cwd: workspaceRoot,
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    networkMode: "open-web",
    shellTimeoutMs: 30000,
    hookTimeoutMs: 5000,
  });

  const decision = boundary.evaluateTool({
    toolName: "run_shell",
    input: { command: "rm -rf /tmp/something" },
  });

  assert.equal(decision.blocked, true, "rm -rf should still be blocked");
});

test("classifyShellCommand identifies mkdir as not destructive", () => {
  const classification = classifyShellCommand("mkdir", ["-p", "/some/path"], "shell");
  assert.equal(classification.destructive, false);
  assert.equal(classification.highRisk, false);
});
