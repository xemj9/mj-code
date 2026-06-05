import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SourceRegistry } from "../src/lib/source-registry.mjs";

test("source registry assigns stable ids, collapses canonical urls, and persists state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-sources-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });

  const registry = new SourceRegistry(projectStateDir);
  await registry.initialize("session-a");

  const pack = await registry.registerPack([
    {
      title: "Docs",
      url: "https://developers.openai.com/docs?utm_source=test",
      query: "openai docs",
      provider: "fallback",
      excerpt: "Official docs",
    },
    {
      title: "Docs Duplicate",
      url: "https://developers.openai.com/docs",
      query: "openai docs",
      provider: "fallback",
      excerpt: "Official docs duplicate",
    },
    {
      title: "Blog",
      url: "https://openai.com/blog/test",
      query: "openai docs",
      provider: "fallback",
      excerpt: "Blog",
    },
  ], {
    toolName: "web_search",
    query: "openai docs",
    provider: "fallback",
  });

  assert.equal(pack.sources.length, 3);
  assert.equal(registry.listSources().length, 2);
  assert.equal(registry.listSources()[1].sourceId, "S1");
  assert.equal(registry.listSources()[0].sourceId, "S2");

  const reloaded = new SourceRegistry(projectStateDir);
  await reloaded.initialize("session-a");
  assert.equal(reloaded.listSources().length, 2);
  assert.equal(reloaded.getLastPack().sourceIds.length, 3);
  assert.equal(reloaded.getSource("S1").canonicalUrl, "https://developers.openai.com/docs");
});
