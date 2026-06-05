import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CapabilityRegistry } from "../src/lib/capability-registry.mjs";
import { ExtensionStateStore } from "../src/lib/extension-state-store.mjs";
import { PluginLoader } from "../src/lib/plugin-loader.mjs";

test("plugin loader activates local plugins, isolates failures, and exposes capability metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-plugin-loader-"));
  const projectStateDir = path.join(root, ".mj-code");
  const userStateDir = path.join(root, ".user-state");
  const pluginDir = path.join(projectStateDir, "plugins", "echo-fixture");
  const brokenDir = path.join(projectStateDir, "plugins", "broken-fixture");

  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.mkdir(userStateDir, { recursive: true });

  await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
    id: "echo-fixture",
    name: "Echo Fixture",
    version: "0.1.0",
    description: "Echo plugin used in tests.",
    entry: "index.mjs",
    permissionsHints: ["read"],
    capabilities: [
      {
        type: "plugin-tool",
        name: "echo_text",
        description: "Echo incoming text.",
        riskCategory: "read",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    ],
  }, null, 2));
  await fs.writeFile(path.join(pluginDir, "index.mjs"), [
    "export async function register(context) {",
    "  return {",
    "    tools: [",
    "      {",
    "        name: 'echo_text',",
    "        description: 'Echo incoming text.',",
    "        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },",
    "        riskCategory: 'read',",
    "        async handler(input) {",
    "          return { echo: `${context.plugin.id}:${input.text}` };",
    "        }",
    "      }",
    "    ]",
    "  };",
    "}",
    "",
  ].join("\n"));

  await fs.writeFile(path.join(brokenDir, "plugin.json"), JSON.stringify({
    id: "broken-fixture",
    name: "Broken Fixture",
    version: "0.1.0",
    description: "Broken plugin used in tests.",
    entry: "index.mjs",
    capabilities: [
      {
        type: "plugin-tool",
        name: "noop",
        description: "No-op placeholder.",
      },
    ],
  }, null, 2));
  await fs.writeFile(path.join(brokenDir, "index.mjs"), "export default 42;\n");

  const stateStore = new ExtensionStateStore(projectStateDir);
  await stateStore.initialize();

  const loader = new PluginLoader({
    cwd: root,
    projectStateDir,
    userStateDir,
    permissionMode: "full-access",
    approvalPolicy: "never",
    networkMode: "docs-only",
  }, {
    stateStore,
  });
  await loader.initialize();

  const plugins = loader.listPlugins();
  assert.ok(plugins.some((entry) => entry.id === "echo-fixture" && entry.status === "active"));
  assert.ok(plugins.some((entry) => entry.id === "broken-fixture" && entry.status === "error"));

  const result = await loader.invokeTool("plugin__echo_fixture__echo_text", { text: "hello" });
  assert.deepEqual(result, { echo: "echo-fixture:hello" });

  const capabilityRegistry = new CapabilityRegistry();
  loader.registerCapabilities(capabilityRegistry);
  const described = capabilityRegistry.describe({ type: "plugin-tool" });
  assert.ok(described.capabilities.some((entry) => entry.displayName === "echo_text" && entry.active));
  assert.ok(described.capabilities.some((entry) => entry.displayName === "noop" && !entry.active));

  await loader.disablePlugin("echo-fixture");
  assert.equal(loader.getNormalizedToolSpecs().length, 0);
  assert.equal(loader.inspectPlugin("echo-fixture").enabled, false);
});
