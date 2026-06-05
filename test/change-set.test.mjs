import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  analyzeChangeImpact,
  previewApplyPatchChangeSet,
  previewReplaceInFileChangeSet,
  previewWriteFileChangeSet,
} from "../src/lib/change-set.mjs";
import { assessChangeSetRisk } from "../src/lib/risk-engine.mjs";

test("change-set previews produce diff summaries and impact metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-changeset-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.js"), "export function hello() {\n  return 'hello';\n}\n");
  await fs.writeFile(path.join(root, "test", "app.test.js"), "import { hello } from '../src/app.js';\n");

  const context = { cwd: root };
  const replacePreview = await previewReplaceInFileChangeSet({
    path: "src/app.js",
    search: "hello",
    replace: "goodbye",
    all: true,
  }, context);

  assert.equal(replacePreview.files.length, 1);
  assert.equal(replacePreview.files[0].operation, "update");
  assert.match(replacePreview.files[0].diff, /---/);
  assert.equal(replacePreview.impact.needsTestRerun, true);

  const writePreview = await previewWriteFileChangeSet({
    path: "src/new-file.js",
    content: "export const value = 1;\n",
  }, context);

  assert.equal(writePreview.files[0].operation, "add");
  assert.ok(writePreview.diff.includes("new-file.js"));

  const patchPreview = await previewApplyPatchChangeSet({
    patch: [
      "*** Begin Patch",
      "*** Update File: src/app.js",
      "@@",
      " export function hello() {",
      "-  return 'hello';",
      "+  return 'patched';",
      " }",
      "*** End Patch",
    ].join("\n"),
  }, context);

  const risk = assessChangeSetRisk({
    toolName: "apply_patch",
    changeSet: patchPreview,
  });

  assert.ok(["low", "medium", "high", "critical"].includes(risk.level));
  assert.ok(patchPreview.impact.relatedFiles.includes(path.join("test", "app.test.js")) || patchPreview.impact.likelyTests.includes(path.join("test", "app.test.js")));
});

test("impact analyzer exposes fast-path cost metadata and cache hits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-impact-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "server.js"), "export const server = true;\n");
  await fs.writeFile(path.join(root, "tests", "server.test.js"), "import '../src/server.js';\n");

  const target = path.join(root, "src", "server.js");
  const first = await analyzeChangeImpact({
    cwd: root,
    touchedFiles: [target],
    deadlineMs: 500,
    cacheTtlMs: 30_000,
  });
  const second = await analyzeChangeImpact({
    cwd: root,
    touchedFiles: [target],
    deadlineMs: 500,
    cacheTtlMs: 30_000,
  });

  assert.ok(["rg", "fallback"].includes(first.engine));
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(typeof first.scannedFiles, "number");
  assert.equal(typeof first.deadlineHit, "boolean");
});
