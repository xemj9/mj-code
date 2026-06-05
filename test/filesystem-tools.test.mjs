import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  listDir,
  readFile,
  replaceInFile,
  searchFiles,
  writeFile,
} from "../src/tools/filesystem.mjs";

function createContext(cwd, overrides = {}) {
  return {
    cwd,
    maxReadChars: 80,
    maxOutputChars: 40,
    ...overrides,
  };
}

test("listDir returns entries and truncation semantics", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-fs-list-"));
  for (let index = 0; index < 205; index += 1) {
    await fs.writeFile(path.join(workspace, `file-${index}.txt`), `${index}\n`, "utf8");
  }

  const result = await listDir({ path: "." }, createContext(workspace));

  assert.equal(result.path, workspace);
  assert.equal(result.entries.length, 200);
  assert.equal(result.truncated, true);
  assert.ok(result.entries.every((entry) => entry.kind === "file"));
});

test("readFile preserves startLine endLine and truncation behavior", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-fs-read-"));
  const filePath = path.join(workspace, "notes.txt");
  await fs.writeFile(
    filePath,
    ["alpha", "beta beta beta beta beta", "gamma gamma gamma gamma", "delta"].join("\n"),
    "utf8",
  );

  const result = await readFile(
    { path: "notes.txt", startLine: 2, endLine: 3 },
    createContext(workspace, { maxReadChars: 12 }),
  );

  assert.equal(result.path, filePath);
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 3);
  assert.match(result.content, /truncated/);
});

test("readFile rejects binary files", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-fs-binary-"));
  await fs.writeFile(path.join(workspace, "blob.bin"), Buffer.from([0, 1, 2, 3]));

  await assert.rejects(
    readFile({ path: "blob.bin" }, createContext(workspace)),
    /appears to be binary/,
  );
});

test("writeFile creates parent directories", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-fs-write-"));

  const result = await writeFile(
    { path: "nested/deep/file.txt", content: "hello\n" },
    createContext(workspace),
  );

  assert.equal(result.path, path.join(workspace, "nested/deep/file.txt"));
  assert.equal(result.bytesWritten, Buffer.byteLength("hello\n", "utf8"));
  assert.equal(
    await fs.readFile(path.join(workspace, "nested/deep/file.txt"), "utf8"),
    "hello\n",
  );
});

test("replaceInFile supports single and all replacement modes", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-fs-replace-"));
  const filePath = path.join(workspace, "sample.txt");
  await fs.writeFile(filePath, "one two two\n", "utf8");

  const single = await replaceInFile(
    { path: "sample.txt", search: "two", replace: "TWO" },
    createContext(workspace),
  );
  assert.equal(single.replacements, 1);
  assert.equal(await fs.readFile(filePath, "utf8"), "one TWO two\n");

  const all = await replaceInFile(
    { path: "sample.txt", search: "two", replace: "2", all: true },
    createContext(workspace),
  );
  assert.equal(all.replacements, 1);
  assert.equal(await fs.readFile(filePath, "utf8"), "one TWO 2\n");
});

test("replaceInFile errors when the search string is missing", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-fs-replace-miss-"));
  await fs.writeFile(path.join(workspace, "sample.txt"), "alpha\n", "utf8");

  await assert.rejects(
    replaceInFile(
      { path: "sample.txt", search: "beta", replace: "BETA" },
      createContext(workspace),
    ),
    /was not found/,
  );
});

test("searchFiles fallback engine returns stable matches when rg is unavailable", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mj-code-fs-search-"));
  await fs.writeFile(path.join(workspace, "a.txt"), "alpha\nbeta\n", "utf8");
  await fs.writeFile(path.join(workspace, "b.txt"), "beta\n", "utf8");

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = await searchFiles(
      { path: ".", query: "beta" },
      createContext(workspace, { maxOutputChars: 20 }),
    );

    assert.equal(result.engine, "fallback");
    assert.equal(result.path, workspace);
    assert.equal(result.query, "beta");
    assert.equal(result.matches.length, 2);
    assert.ok(result.matches.every((entry) => entry.preview.includes("beta")));
  } finally {
    process.env.PATH = originalPath;
  }
});
