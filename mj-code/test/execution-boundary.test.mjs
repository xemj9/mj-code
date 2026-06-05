import test from "node:test";
import assert from "node:assert/strict";

import { ExecutionBoundary, summarizeBoundaryDecision } from "../src/lib/execution-boundary.mjs";

function createBoundary(overrides = {}) {
  return new ExecutionBoundary({
    cwd: "/tmp/workspace",
    permissionMode: "full-access",
    approvalPolicy: "on-write",
    networkMode: "docs-only",
    webProvider: "fallback",
    webAllowDomains: [],
    webDenyDomains: [],
    shellTimeoutMs: 15_000,
    hookTimeoutMs: 5_000,
    executionBoundaryMode: "workspace",
    executionEnvAllowlist: ["HOME", "PATH"],
    ...overrides,
  });
}

test("execution boundary blocks network-capable shell commands outside open-web", () => {
  const boundary = createBoundary();
  const decision = boundary.evaluateTool({
    toolName: "run_shell",
    input: {
      command: "curl https://example.com",
      cwd: "/tmp/workspace",
      env: {
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        SECRET_TOKEN: "redact-me",
      },
    },
    traceId: "trace-1",
    step: 3,
  });

  assert.equal(decision.blocked, true);
  assert.match(decision.reasons[0], /network-capable shell execution/i);
  assert.equal(decision.envPolicy?.mode, "allowlist");
  assert.ok(decision.envPolicy?.droppedKeys.includes("SECRET_TOKEN"));

  const summary = summarizeBoundaryDecision(decision);
  assert.equal(summary?.blocked, true);
  assert.equal(summary?.shellPolicy?.classification.networkAccess, true);
});

test("strict execution boundary blocks high-risk plugin tools", () => {
  const boundary = createBoundary({
    executionBoundaryMode: "strict-policy",
    networkMode: "open-web",
  });
  const decision = boundary.evaluateTool({
    toolName: "plugin__demo__sync",
    toolMeta: {
      name: "plugin__demo__sync",
      description: "Sync to an external service.",
      inputSchema: { type: "object", properties: {} },
      source: "plugin",
      type: "plugin-tool",
      riskCategory: "external",
      sourceQualifiedName: "plugin:demo:sync",
    },
    input: {},
    traceId: "trace-2",
    step: 1,
  });

  assert.equal(decision.blocked, true);
  assert.match(decision.reasons[0], /Strict execution boundary blocks plugin tool/i);
  assert.ok(decision.degradedReasons.some((entry) => /policy-only/i.test(entry)));
});
