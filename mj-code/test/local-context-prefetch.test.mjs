import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  extractLocalPathCandidates,
  prefetchLocalContextForPrompt,
} from "../src/lib/local-context-prefetch.mjs";

test("local context prefetch extracts explicit workspace file references", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mj-prefetch-"));
  await fs.writeFile(path.join(cwd, "README.md"), "# Demo\n\ncontent", "utf8");
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "main.ts"), "export const value = 1;\n", "utf8");

  assert.deepEqual(
    extractLocalPathCandidates("Read README.md and src/main.ts, then summarize."),
    ["README.md", "src/main.ts"],
  );

  const result = await prefetchLocalContextForPrompt({
    prompt: "Read README.md and src/main.ts, then summarize.",
    cwd,
  });

  assert.equal(result.attachments.length, 2);
  assert.equal(result.attachments[0].relativePath, "README.md");
  assert.match(result.message, /Local context prefetch/);
  assert.match(result.message, /# Demo/);
  assert.match(result.message, /src\/main\.ts/);
});

test("local context prefetch refuses paths outside the workspace", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mj-prefetch-"));
  const outside = path.join(os.tmpdir(), `mj-outside-${Date.now()}.md`);
  await fs.writeFile(outside, "secret", "utf8");

  const result = await prefetchLocalContextForPrompt({
    prompt: `Read ${outside}`,
    cwd,
  });

  assert.equal(result.attachments.length, 0);
  assert.equal(result.message, null);
});
