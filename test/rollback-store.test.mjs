import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { previewWriteFileChangeSet } from "../src/lib/change-set.mjs";
import { RollbackStore } from "../src/lib/rollback-store.mjs";
import { writeFile } from "../src/tools/filesystem.mjs";

test("rollback store checkpoints a change-set and restores the original file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-rollback-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const filePath = path.join(root, "note.txt");
  await fs.writeFile(filePath, "before\n", "utf8");

  const context = { cwd: root };
  const preview = await previewWriteFileChangeSet({
    path: "note.txt",
    content: "after\n",
  }, context);

  const store = new RollbackStore(projectStateDir);
  const checkpoint = await store.checkpointChangeSet(preview, {
    sessionId: "session-1",
    traceId: "trace-1",
  });

  assert.equal(checkpoint.id, preview.id);

  await writeFile({
    path: "note.txt",
    content: "after\n",
  }, context);
  await store.markApplied(preview.id, {
    result: { path: filePath },
  });
  const checkpoints = await store.listCheckpoints(5);
  assert.equal(checkpoints[0].status, "applied");
  assert.ok(checkpoints[0].touchedFiles.includes(filePath));

  const changed = await fs.readFile(filePath, "utf8");
  assert.equal(changed, "after\n");

  const rollbackResult = await store.rollback(preview.id, {
    sessionId: "session-1",
    traceId: "trace-undo",
  });

  assert.equal(rollbackResult.rolledBack, true);
  const restored = await fs.readFile(filePath, "utf8");
  assert.equal(restored, "before\n");
});
