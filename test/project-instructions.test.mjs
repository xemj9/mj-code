import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadProjectInstructions,
  summarizeInstructionPack,
} from "../src/lib/project-instructions.mjs";

test("instruction resolver preserves hierarchy order, local overrides, imports, and provenance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-instructions-"));
  const userStateDir = path.join(root, ".user-state");
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });
  await fs.mkdir(path.join(root, "instructions"), { recursive: true });
  await fs.mkdir(userStateDir, { recursive: true });

  await fs.writeFile(path.join(userStateDir, "MJ.md"), "Global instruction.\n", "utf8");
  await fs.writeFile(
    path.join(root, "MJ.md"),
    [
      "@import ./instructions/shared.md",
      "@rule output.tone: concise",
      "",
      "Workspace instruction.",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(root, "instructions", "shared.md"), "Imported workspace note.\n", "utf8");
  await fs.writeFile(path.join(root, ".mj-code", "MJ.md"), "Overlay instruction.\n", "utf8");
  await fs.writeFile(path.join(root, ".mj-code", "MJ.local.md"), "Local override instruction.\n", "utf8");

  const pack = await loadProjectInstructions({
    cwd: root,
    userStateDir,
  });

  assert.deepEqual(
    pack.entries.map((entry) => entry.layer),
    [
      "user-global",
      "workspace-root",
      "workspace-root",
      "project-overlay",
      "local-override",
    ],
  );
  assert.equal(pack.entries[1].importedFrom, path.join(root, "MJ.md"));
  assert.equal(pack.entries[2].originPath, path.join(root, "MJ.md"));
  assert.equal(pack.entries[4].originPath, path.join(root, ".mj-code", "MJ.local.md"));
  assert.match(pack.content, /Global instruction/);
  assert.match(pack.content, /Imported workspace note/);
  assert.match(pack.content, /Workspace instruction/);
  assert.match(pack.content, /Overlay instruction/);
  assert.match(pack.content, /Local override instruction/);
  assert.equal(pack.rules.length, 1);
  assert.equal(pack.rules[0].name, "output.tone");
  assert.equal(pack.rules[0].value, "concise");

  const summary = summarizeInstructionPack(pack, {
    includeContent: false,
  });
  assert.equal(summary.entryCount, 5);
  assert.equal(summary.ruleCount, 1);
});

test("instruction resolver blocks import cycles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-instruction-cycle-"));
  await fs.mkdir(path.join(root, "instructions"), { recursive: true });
  await fs.writeFile(path.join(root, "MJ.md"), "@import ./instructions/a.md\n", "utf8");
  await fs.writeFile(path.join(root, "instructions", "a.md"), "@import ./b.md\nA\n", "utf8");
  await fs.writeFile(path.join(root, "instructions", "b.md"), "@import ./a.md\nB\n", "utf8");

  await assert.rejects(
    () => loadProjectInstructions({
      cwd: root,
      userStateDir: path.join(root, ".user-state"),
    }),
    /Instruction import cycle detected/,
  );
});

test("instruction resolver blocks imports that escape the allowed root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-instruction-escape-"));
  await fs.mkdir(path.join(root, "instructions"), { recursive: true });
  await fs.writeFile(path.join(root, "MJ.md"), "@import ../outside.md\n", "utf8");
  await fs.writeFile(path.join(root, "..", "outside.md"), "outside\n", "utf8");

  await assert.rejects(
    () => loadProjectInstructions({
      cwd: root,
      userStateDir: path.join(root, ".user-state"),
    }),
    /escapes the allowed root/,
  );
});
