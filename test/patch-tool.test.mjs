import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyPatch, previewApplyPatch } from "../src/tools/patch.mjs";

test("applyPatch wrapper rejects empty patch input", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-tool-empty-"));

  await assert.rejects(
    applyPatch({ patch: "" }, { cwd: workspace }),
    /requires a patch string/,
  );
});

test("previewApplyPatch wrapper preserves preview semantics", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-tool-preview-"));
  await fs.writeFile(path.join(workspace, "note.txt"), "before\n", "utf8");

  const preview = await previewApplyPatch({
    patch: [
      "*** Begin Patch",
      "*** Update File: note.txt",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n"),
  }, {
    cwd: workspace,
  });

  assert.equal(preview.toolName, "apply_patch");
  assert.deepEqual(preview.touchedFiles, [path.join(workspace, "note.txt")]);
  assert.equal(preview.files.length, 1);
});
