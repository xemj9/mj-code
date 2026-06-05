import test from "node:test";
import assert from "node:assert/strict";

import {
  isExternalType,
  isRiskCategoryRisky,
  isToolCapability,
  normalizeCapability,
  normalizeCapabilityType,
  sortCapabilities,
  summarizeCapabilitySurface,
} from "../src/lib/capability-types.mjs";

test("normalizeCapabilityType falls back safely and normalizeCapability fills stable defaults", () => {
  const normalized = normalizeCapability({
    source: "project:repo",
    name: "repo-runtime",
    type: "unknown-type",
    tags: ["runtime", "runtime", ""],
    metadata: {
      summary: "Runtime rules",
    },
  });

  assert.equal(normalizeCapabilityType("plugin-tool"), "plugin-tool");
  assert.equal(normalizeCapabilityType("made-up"), "instruction/policy");
  assert.equal(normalized.type, "instruction/policy");
  assert.equal(normalized.id, "instruction/policy:project:repo:repo-runtime");
  assert.equal(normalized.sourceQualifiedName, "project:repo:repo-runtime");
  assert.equal(normalized.scope, "project");
  assert.equal(normalized.projectAttached, true);
  assert.equal(normalized.external, false);
  assert.equal(normalized.risky, false);
  assert.deepEqual(normalized.tags, ["runtime"]);
  assert.deepEqual(normalized.metadata, { summary: "Runtime rules" });
});

test("normalizeCapability infers risky and external flags while summarizeCapabilitySurface and sorting stay stable", () => {
  const capabilities = [
    normalizeCapability({
      id: "plugin-tool:echo:echo_text",
      name: "plugin__echo__echo_text",
      displayName: "Echo Tool",
      type: "plugin-tool",
      source: "plugin:echo",
      enabled: true,
      active: true,
      riskCategory: "external",
    }),
    normalizeCapability({
      id: "skill:repo-runtime",
      name: "repo-runtime",
      displayName: "Repo Runtime",
      type: "skill",
      source: "project",
      enabled: true,
      active: false,
      projectAttached: true,
    }),
    normalizeCapability({
      id: "tool:read_file",
      name: "read_file",
      displayName: "Read File",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "read",
    }),
  ];

  const summary = summarizeCapabilitySurface(capabilities);
  assert.equal(summary.total, 3);
  assert.equal(summary.active, 2);
  assert.equal(summary.external, 1);
  assert.equal(summary.projectAttached, 1);
  assert.equal(summary.byType["plugin-tool"], 1);

  const sorted = sortCapabilities(capabilities);
  assert.deepEqual(sorted.map((entry) => entry.displayName), [
    "Read File",
    "Echo Tool",
    "Repo Runtime",
  ]);

  assert.equal(isToolCapability("plugin-tool"), true);
  assert.equal(isToolCapability("skill"), false);
  assert.equal(isExternalType("plugin-tool"), true);
  assert.equal(isExternalType("memory"), false);
  assert.equal(isRiskCategoryRisky("external"), true);
  assert.equal(isRiskCategoryRisky("read"), false);
});
