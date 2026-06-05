import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.mjs";

async function createConfigProject(config) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mj-config-"));
  await fs.writeFile(
    path.join(cwd, "mjcode.config.json"),
    JSON.stringify(config, null, 2),
  );
  return cwd;
}

test("project config is not silently overridden by generic OpenAI environment variables", async () => {
  const cwd = await createConfigProject({
    provider: "openai-compatible",
    model: "project-model",
    baseUrl: "https://project.example/v1",
    apiKey: "project-key",
  });

  const config = await loadConfig({
    cwd,
    env: {
      OPENAI_MODEL: "ambient-model",
      OPENAI_BASE_URL: "https://ambient.example/v1",
      OPENAI_API_KEY: "ambient-key",
    },
  });

  assert.equal(config.model, "project-model");
  assert.equal(config.baseUrl, "https://project.example/v1");
  assert.equal(config.apiKey, "project-key");
});

test("MJ_CODE environment variables intentionally override project config", async () => {
  const cwd = await createConfigProject({
    provider: "openai-compatible",
    model: "project-model",
    baseUrl: "https://project.example/v1",
    apiKey: "project-key",
  });

  const config = await loadConfig({
    cwd,
    env: {
      MJ_CODE_MODEL: "override-model",
      MJ_CODE_BASE_URL: "https://override.example/v1",
      MJ_CODE_API_KEY: "override-key",
    },
  });

  assert.equal(config.model, "override-model");
  assert.equal(config.baseUrl, "https://override.example/v1");
  assert.equal(config.apiKey, "override-key");
});
