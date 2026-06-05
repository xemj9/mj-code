import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemoryStore } from "../src/lib/memory-store.mjs";

test("memory store remembers, searches, and records turn memories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-memory-"));
  const config = {
    cwd: root,
    projectStateDir: path.join(root, ".mj-code"),
    userStateDir: path.join(root, ".user-memory"),
  };

  const store = new MemoryStore(config);
  await store.initialize({
    sessionFilePath: path.join(config.projectStateDir, "sessions", "session.jsonl"),
    projectInstructions: {
      files: [path.join(root, "MJ.md")],
      content: "Prefer concise answers and patch-based edits.",
    },
  });

  const remembered = await store.remember({
    scope: "user",
    key: "tone",
    text: "The user prefers concise answers.",
    source: "slash-command",
    confidence: 0.95,
  });

  assert.equal(remembered.scope, "user");
  assert.equal(remembered.kind, "policy");

  const results = await store.search("concise answers", {
    scopes: ["user", "project"],
    limit: 5,
  });

  assert.ok(results.some((item) => item.scope === "user"));

  const turnMemories = await store.recordTurn({
    userInput: "Update README and explain the new memory commands.",
    assistantOutput: "README updated.",
    toolEvents: [
      {
        tool: "write_file",
        result: { path: path.join(root, "README.md") },
      },
    ],
    success: true,
    stopped: false,
  });

  assert.equal(turnMemories.length, 1);

  const snapshot = await store.listSnapshot();
  assert.equal(snapshot.counts.project, 1);
  assert.equal(snapshot.counts.session, 1);
  assert.equal(snapshot.counts.user, 1);
  assert.equal(snapshot.counts.failure, 0);
  const projectResults = await store.search("patch-based edits", {
    scopes: ["project"],
    limit: 5,
  });
  assert.equal(projectResults.length, 0);
});
