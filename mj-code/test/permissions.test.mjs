import test from "node:test";
import assert from "node:assert/strict";

import { evaluateToolPermission } from "../src/lib/permissions.mjs";

test("workspace-write allows writes inside the workspace", () => {
  const result = evaluateToolPermission({
    toolName: "write_file",
    input: { path: "src/app.js" },
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    workspaceRoot: "/tmp/workspace",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requiresApproval, true);
});

test("workspace-write blocks writes outside the workspace", () => {
  const result = evaluateToolPermission({
    toolName: "write_file",
    input: { path: "../outside.js" },
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    workspaceRoot: "/tmp/workspace",
  });

  assert.equal(result.allowed, false);
});

test("read-only blocks shell execution", () => {
  const result = evaluateToolPermission({
    toolName: "run_shell",
    input: { command: "ls" },
    permissionMode: "read-only",
    approvalPolicy: "on-write",
    workspaceRoot: "/tmp/workspace",
  });

  assert.equal(result.allowed, false);
});

test("workspace-write allows apply_patch inside the workspace", () => {
  const result = evaluateToolPermission({
    toolName: "apply_patch",
    input: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/app.js",
        "@@",
        " old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    },
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    workspaceRoot: "/tmp/workspace",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requiresApproval, true);
});

test("network tools respect network mode and docs-only url policy", () => {
  const searchAllowed = evaluateToolPermission({
    toolName: "web_search",
    input: { query: "openai responses api" },
    permissionMode: "read-only",
    approvalPolicy: "on-write",
    workspaceRoot: "/tmp/workspace",
    networkMode: "docs-only",
    webProvider: "fallback",
  });

  assert.equal(searchAllowed.allowed, true);
  assert.equal(searchAllowed.network.kind, "search");
  assert.equal(searchAllowed.network.networkMode, "docs-only");
  assert.equal(searchAllowed.network.query, "openai responses api");
  assert.equal(searchAllowed.network.decision, null);

  const blockedFetch = evaluateToolPermission({
    toolName: "fetch_url",
    input: { url: "https://example.com/random-post" },
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    workspaceRoot: "/tmp/workspace",
    networkMode: "docs-only",
    webProvider: "fallback",
  });

  assert.equal(blockedFetch.allowed, false);
  assert.match(blockedFetch.reason, /docs-only/i);
  assert.equal(blockedFetch.network.kind, "fetch");
  assert.equal(blockedFetch.network.domain, "example.com");
  assert.equal(blockedFetch.network.decision.allowed, false);
  assert.equal(blockedFetch.network.decision.metadata.ok, true);
});

test("mcp tools are blocked in read-only mode and require approval otherwise", () => {
  const blocked = evaluateToolPermission({
    toolName: "mcp__demo__echo",
    toolSource: "mcp",
    toolMeta: {
      serverId: "demo",
      serverName: "demo",
      name: "echo",
      annotations: {
        readOnlyHint: true,
      },
    },
    input: { text: "hello" },
    permissionMode: "read-only",
    approvalPolicy: "on-write",
    workspaceRoot: "/tmp/workspace",
  });
  assert.equal(blocked.allowed, false);

  const allowed = evaluateToolPermission({
    toolName: "mcp__demo__echo",
    toolSource: "mcp",
    toolMeta: {
      serverId: "demo",
      serverName: "demo",
      name: "echo",
      annotations: {
        readOnlyHint: true,
      },
    },
    input: { text: "hello" },
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    workspaceRoot: "/tmp/workspace",
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.requiresApproval, true);
});
