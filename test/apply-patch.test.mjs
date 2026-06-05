import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyPatchText,
  extractPatchPaths,
  parsePatchText,
  previewPatchText,
} from "../src/lib/apply-patch.mjs";

test("parsePatchText parses add delete update and moveTo operations", () => {
  const operations = parsePatchText([
    "*** Begin Patch",
    "*** Add File: notes.txt",
    "+hello",
    "*** Delete File: old.txt",
    "*** Update File: app.txt",
    "*** Move to: app-renamed.txt",
    "@@",
    " line one",
    "-line two",
    "+line two updated",
    "*** End Patch",
  ].join("\n"));

  assert.equal(operations.length, 3);
  assert.equal(operations[0].type, "add");
  assert.equal(operations[1].type, "delete");
  assert.equal(operations[2].type, "update");
  assert.equal(operations[2].moveTo, "app-renamed.txt");
});

test("previewPatchText returns stable file change shapes", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-preview-"));
  const filePath = path.join(workspace, "app.txt");
  await fs.writeFile(filePath, "line one\nline two\nline three\n", "utf8");

  const preview = await previewPatchText([
    "*** Begin Patch",
    "*** Update File: app.txt",
    "@@",
    " line one",
    "-line two",
    "+line two updated",
    " line three",
    "*** End Patch",
  ].join("\n"), workspace);

  assert.equal(preview.operationCount, 1);
  assert.equal(preview.touchedFiles.length, 1);
  assert.equal(preview.fileChanges[0].operation, "update");
  assert.equal(preview.fileChanges[0].path, filePath);
  assert.equal(preview.fileChanges[0].previousPath, null);
  assert.match(preview.fileChanges[0].beforeContent, /line two/);
  assert.match(preview.fileChanges[0].afterContent, /line two updated/);
});

test("applyPatchText updates a file in place", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-"));
  const filePath = path.join(workspace, "app.txt");
  await fs.writeFile(filePath, "line one\nline two\nline three\n", "utf8");

  const patch = [
    "*** Begin Patch",
    "*** Update File: app.txt",
    "@@",
    " line one",
    "-line two",
    "+line two updated",
    " line three",
    "*** End Patch",
  ].join("\n");

  const result = await applyPatchText(patch, workspace);
  const contents = await fs.readFile(filePath, "utf8");

  assert.match(contents, /line two updated/);
  assert.equal(result.operationCount, 1);
});

test("previewPatchText reports both touched files for a rename patch", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-rename-preview-"));
  const sourcePath = path.join(workspace, "app.txt");
  await fs.writeFile(sourcePath, "old\n", "utf8");

  const preview = await previewPatchText([
    "*** Begin Patch",
    "*** Update File: app.txt",
    "*** Move to: renamed.txt",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n"), workspace);

  assert.equal(preview.fileChanges[0].operation, "rename");
  assert.deepEqual(preview.fileChanges[0].touchedFiles, [
    path.join(workspace, "app.txt"),
    path.join(workspace, "renamed.txt"),
  ]);
});

test("extractPatchPaths lists every touched file", () => {
  const workspace = "/tmp/workspace";
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/app.js",
    "*** Move to: src/app-new.js",
    "@@",
    " old",
    "+new",
    "*** End Patch",
  ].join("\n");

  const paths = extractPatchPaths(patch, workspace);
  assert.deepEqual(paths, [
    path.join(workspace, "src/app.js"),
    path.join(workspace, "src/app-new.js"),
  ]);
});

test("previewPatchText rejects paths outside the workspace", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-boundary-"));

  await assert.rejects(
    previewPatchText([
      "*** Begin Patch",
      "*** Add File: ../outside.txt",
      "+nope",
      "*** End Patch",
    ].join("\n"), workspace),
    /outside the workspace/,
  );
});

test("previewPatchText fails when hunk context cannot be found", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-context-"));
  await fs.writeFile(path.join(workspace, "app.txt"), "alpha\nbeta\n", "utf8");

  await assert.rejects(
    previewPatchText([
      "*** Begin Patch",
      "*** Update File: app.txt",
      "@@",
      " gamma",
      "-delta",
      "+epsilon",
      "*** End Patch",
    ].join("\n"), workspace),
    /context not found/,
  );
});

test("previewPatchText rejects add-file patches when the file already exists", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-add-exists-"));
  await fs.writeFile(path.join(workspace, "notes.txt"), "existing\n", "utf8");

  await assert.rejects(
    previewPatchText([
      "*** Begin Patch",
      "*** Add File: notes.txt",
      "+new",
      "*** End Patch",
    ].join("\n"), workspace),
    /already exists/,
  );
});

test("applyPatchText deletes a file", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-delete-"));
  const filePath = path.join(workspace, "notes.txt");
  await fs.writeFile(filePath, "remove me\n", "utf8");

  const result = await applyPatchText([
    "*** Begin Patch",
    "*** Delete File: notes.txt",
    "*** End Patch",
  ].join("\n"), workspace);

  await assert.rejects(fs.access(filePath));
  assert.equal(result.operationCount, 1);
  assert.deepEqual(result.touchedFiles, [filePath]);
});

test("applyPatchText renames and updates a file", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-patch-rename-"));
  const sourcePath = path.join(workspace, "app.txt");
  const nextPath = path.join(workspace, "renamed.txt");
  await fs.writeFile(sourcePath, "before\n", "utf8");

  const result = await applyPatchText([
    "*** Begin Patch",
    "*** Update File: app.txt",
    "*** Move to: renamed.txt",
    "@@",
    "-before",
    "+after",
    "*** End Patch",
  ].join("\n"), workspace);

  await assert.rejects(fs.access(sourcePath));
  assert.equal(await fs.readFile(nextPath, "utf8"), "after\n");
  assert.deepEqual(result.touchedFiles, [sourcePath, nextPath]);
});
