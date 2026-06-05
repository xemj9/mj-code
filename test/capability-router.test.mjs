import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry } from "../src/lib/capability-registry.mjs";
import { CapabilityRouter } from "../src/lib/capability-router.mjs";

function buildRegistry() {
  const registry = new CapabilityRegistry();
  registry.upsertMany([
    {
      id: "tool:read_file",
      name: "read_file",
      displayName: "read_file",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "read",
      sourceQualifiedName: "builtin:read_file",
    },
    {
      id: "tool:search_files",
      name: "search_files",
      displayName: "search_files",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "read",
      sourceQualifiedName: "builtin:search_files",
    },
    {
      id: "tool:apply_patch",
      name: "apply_patch",
      displayName: "apply_patch",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "write",
      sourceQualifiedName: "builtin:apply_patch",
    },
    {
      id: "tool:run_shell",
      name: "run_shell",
      displayName: "run_shell",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "exec",
      sourceQualifiedName: "builtin:run_shell",
    },
    {
      id: "tool:web_search",
      name: "web_search",
      displayName: "web_search",
      type: "web-tool",
      source: "web",
      enabled: true,
      active: true,
      riskCategory: "network",
      sourceQualifiedName: "web:web_search",
    },
    {
      id: "mcp-tool:demo:lookup",
      name: "mcp__demo__lookup",
      displayName: "lookup",
      type: "mcp-tool",
      source: "mcp:demo",
      enabled: true,
      active: true,
      riskCategory: "external",
      sourceQualifiedName: "mcp:demo:lookup",
    },
  ]);
  return registry;
}

test("capability router prefers local edit path for code edits", () => {
  const router = new CapabilityRouter({});
  const decision = router.route({
    prompt: "Implement a new CLI flag and update the README.",
    taskClassification: {
      taskClass: "code_edit",
      reasons: ["The task implies code changes."],
      likelyWrites: true,
      likelyShell: false,
      likelyWeb: false,
      likelyMcp: false,
    },
    capabilityRegistry: buildRegistry(),
    runtimeHealth: { scorecard: { degradedFlags: [], circuits: { byLayer: {} } } },
    policy: { sources: [] },
    networkMode: "docs-only",
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    activeSkills: [],
    mcpEnabled: true,
  });

  assert.equal(decision.routingMode, "local-first");
  assert.ok(decision.selectedCapabilities.some((entry) => entry.name === "read_file"));
  assert.ok(decision.selectedCapabilities.some((entry) => entry.name === "apply_patch"));
  assert.ok(!decision.selectedCapabilities.some((entry) => entry.type === "web-tool"));
});

test("capability router blocks web when the web circuit is open", () => {
  const router = new CapabilityRouter({});
  const decision = router.route({
    prompt: "Find the latest official docs for MCP.",
    taskClassification: {
      taskClass: "official_docs_lookup",
      reasons: ["The task needs official docs."],
      likelyWrites: false,
      likelyShell: false,
      likelyWeb: true,
      likelyMcp: false,
      freshnessRequired: true,
    },
    capabilityRegistry: buildRegistry(),
    runtimeHealth: {
      scorecard: {
        degradedFlags: ["web_circuit_open"],
        circuits: {
          byLayer: {
            web: { open: 1 },
          },
        },
      },
    },
    policy: { sources: [] },
    networkMode: "docs-only",
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    activeSkills: [],
    mcpEnabled: true,
  });

  assert.equal(decision.degraded, true);
  assert.ok(decision.blockedCapabilities.some((entry) => entry.type === "web-tool"));
});
