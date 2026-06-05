import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry } from "../src/lib/capability-registry.mjs";
import { TaskClassifier } from "../src/lib/task-classifier.mjs";

function buildRegistry() {
  const registry = new CapabilityRegistry();
  registry.upsertMany([
    {
      id: "tool:read_file",
      name: "read_file",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "read",
      sourceQualifiedName: "builtin:read_file",
    },
    {
      id: "tool:apply_patch",
      name: "apply_patch",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "write",
      sourceQualifiedName: "builtin:apply_patch",
    },
    {
      id: "tool:web_search",
      name: "web_search",
      type: "web-tool",
      source: "web",
      enabled: true,
      active: true,
      riskCategory: "network",
      sourceQualifiedName: "web:web_search",
    },
  ]);
  return registry;
}

test("task classifier recognizes official docs lookup with freshness", () => {
  const classifier = new TaskClassifier({});
  const result = classifier.classify(
    "Look up the latest official docs for Continue context providers and cite the source.",
    {
      capabilityRegistry: buildRegistry(),
      runtimeHealth: { scorecard: { degradedFlags: [] } },
      activeSkills: [
        {
          id: "docs-research",
          toolPreferences: {
            prefer: ["web_search", "extract_content"],
          },
        },
      ],
      networkMode: "docs-only",
      permissionMode: "workspace-write",
    },
  );

  assert.equal(result.taskClass, "official_docs_lookup");
  assert.equal(result.freshnessRequired, true);
  assert.equal(result.likelyWeb, true);
  assert.equal(result.externalCapabilityNeeded, true);
  assert.ok(result.confidence >= 0.6);
});

test("task classifier recognizes test repair as write + shell heavy", () => {
  const classifier = new TaskClassifier({});
  const result = classifier.classify(
    "Fix the failing tests, update the implementation, and rerun npm test.",
    {
      capabilityRegistry: buildRegistry(),
      runtimeHealth: { scorecard: { degradedFlags: [] } },
      activeSkills: [],
      networkMode: "docs-only",
      permissionMode: "workspace-write",
    },
  );

  assert.equal(result.taskClass, "test_repair");
  assert.equal(result.likelyWrites, true);
  assert.equal(result.likelyShell, true);
  assert.equal(result.riskHint, "high");
});
