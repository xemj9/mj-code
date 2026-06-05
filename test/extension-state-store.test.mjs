import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ExtensionStateStore } from "../src/lib/extension-state-store.mjs";

test("extension state store initializes empty state and resolves manifest defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-extension-state-"));
  const projectStateDir = path.join(root, ".mj-code");
  const store = new ExtensionStateStore(projectStateDir);

  await store.initialize();

  assert.deepEqual(store.exportState(), {
    skills: { enabled: [], disabled: [] },
    plugins: { enabled: [], disabled: [] },
  });
  assert.deepEqual(store.resolve("skills", "repo-runtime"), {
    enabled: true,
    explicitState: null,
  });
  assert.deepEqual(store.resolve("plugins", "echo-fixture", false), {
    enabled: false,
    explicitState: null,
  });
});

test("extension state store persists skill/plugin enable-disable state and returns stable export copies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-extension-state-persist-"));
  const projectStateDir = path.join(root, ".mj-code");
  const store = new ExtensionStateStore(projectStateDir);

  await store.initialize();
  await store.setEnabled("skills", "repo-runtime", true);
  await store.setEnabled("plugins", "echo-fixture", false);

  const exported = store.exportState();
  exported.skills.enabled.push("mutated");

  assert.deepEqual(store.resolve("skills", "repo-runtime"), {
    enabled: true,
    explicitState: "enabled",
  });
  assert.deepEqual(store.resolve("plugins", "echo-fixture"), {
    enabled: false,
    explicitState: "disabled",
  });
  assert.deepEqual(store.exportState(), {
    skills: { enabled: ["repo-runtime"], disabled: [] },
    plugins: { enabled: [], disabled: ["echo-fixture"] },
  });

  const reloaded = new ExtensionStateStore(projectStateDir);
  await reloaded.initialize();
  assert.deepEqual(reloaded.resolve("skills", "repo-runtime"), {
    enabled: true,
    explicitState: "enabled",
  });
  assert.deepEqual(reloaded.resolve("plugins", "echo-fixture"), {
    enabled: false,
    explicitState: "disabled",
  });
});

test("extension state store rejects unsupported kinds when persisting state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-extension-state-invalid-"));
  const projectStateDir = path.join(root, ".mj-code");
  const store = new ExtensionStateStore(projectStateDir);

  await store.initialize();

  await assert.rejects(
    store.setEnabled("themes", "dark", true),
    /Unsupported extension state kind "themes"\./,
  );
});
