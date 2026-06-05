import test from "node:test";
import assert from "node:assert/strict";

import { CapabilityRegistry } from "../src/lib/capability-registry.mjs";

test("capability registry aggregates active, disabled, risky, and project-attached surfaces", () => {
  const registry = new CapabilityRegistry();

  registry.replaceGroup("builtin-tools", [
    {
      id: "tool:read_file",
      name: "read_file",
      type: "builtin-tool",
      source: "builtin",
      enabled: true,
      active: true,
      riskCategory: "read",
      description: "Read a file.",
      sourceQualifiedName: "builtin:read_file",
    },
  ]);

  registry.upsert({
    id: "skill:repo-runtime",
    name: "repo-runtime",
    type: "skill",
    source: "project",
    enabled: true,
    active: true,
    projectAttached: true,
    description: "Project runtime conventions.",
    sourceQualifiedName: "project:repo-runtime",
  });

  registry.upsert({
    id: "plugin-tool:echo:echo_text",
    name: "plugin__echo__echo_text",
    displayName: "echo_text",
    type: "plugin-tool",
    source: "plugin:echo",
    enabled: false,
    active: false,
    riskCategory: "external",
    description: "Echo text.",
    sourceQualifiedName: "plugin:echo:echo_text",
  });

  const described = registry.describe();
  assert.equal(described.summary.total, 3);
  assert.equal(described.summary.active, 2);
  assert.equal(described.summary.disabled, 1);
  assert.equal(described.summary.external, 1);
  assert.equal(described.summary.risky, 1);
  assert.equal(described.summary.projectAttached, 1);
  assert.equal(described.summary.byType["plugin-tool"], 1);

  const tools = registry.listTools();
  assert.equal(tools.length, 2);
  assert.ok(tools.some((entry) => entry.name === "read_file"));
  assert.ok(tools.some((entry) => entry.displayName === "echo_text"));
});

test("capability registry supports replaceGroup, clearGroup, lookups, filters, and stable inspect clones", () => {
  const registry = new CapabilityRegistry();

  registry.replaceGroup("plugin-tools", [
    {
      id: "plugin-tool:echo:echo_text",
      name: "plugin__echo__echo_text",
      displayName: "Echo Tool",
      type: "plugin-tool",
      source: "plugin:echo",
      enabled: true,
      active: true,
      riskCategory: "external",
      description: "Echo text.",
      sourceQualifiedName: "plugin:echo:echo_text",
      tags: ["plugin", "echo"],
    },
    {
      id: "plugin-tool:echo:disabled_tool",
      name: "plugin__echo__disabled_tool",
      displayName: "Disabled Tool",
      type: "plugin-tool",
      source: "plugin:echo",
      enabled: false,
      active: false,
      riskCategory: "external",
      description: "Disabled plugin tool.",
      sourceQualifiedName: "plugin:echo:disabled_tool",
      tags: ["plugin"],
    },
  ]);

  registry.upsert({
    id: "memory:store",
    name: "memory_store",
    displayName: "Memory Store",
    type: "memory",
    source: "builtin",
    enabled: true,
    active: true,
    riskCategory: "state",
    description: "Memory surface.",
    sourceQualifiedName: "builtin:memory_store",
  });

  assert.equal(registry.get("plugin-tool:echo:echo_text")?.id, "plugin-tool:echo:echo_text");
  assert.equal(registry.get("plugin__echo__echo_text")?.displayName, "Echo Tool");
  assert.equal(registry.get("Echo Tool")?.name, "plugin__echo__echo_text");
  assert.equal(registry.get("plugin:echo:echo_text")?.id, "plugin-tool:echo:echo_text");

  const inspected = registry.inspect("Echo Tool");
  inspected.tags.push("mutated");
  assert.deepEqual(registry.inspect("Echo Tool")?.tags, ["plugin", "echo"]);

  const filtered = registry.list({
    type: "plugin-tool",
    external: true,
    active: true,
    query: "echo",
    tag: "plugin",
  });
  assert.deepEqual(filtered.map((entry) => entry.displayName), ["Echo Tool"]);

  const pluginSurface = registry.getSurfaceMap({ type: "plugin-tool" });
  assert.equal(pluginSurface.total, 2);
  assert.equal(pluginSurface.external, 2);

  registry.clearGroup("plugin-tools");
  assert.equal(registry.list({ type: "plugin-tool" }).length, 0);
  assert.equal(registry.list({ type: "memory" }).length, 1);
});
