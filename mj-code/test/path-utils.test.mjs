import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  abbreviate,
  appendLimited,
  isSubPath,
  resolveUserPath,
} from "../src/lib/path-utils.mjs";

test("resolveUserPath resolves relative and absolute paths from cwd", () => {
  const cwd = "/tmp/workspace";

  assert.equal(resolveUserPath("src/app.ts", cwd), path.join(cwd, "src/app.ts"));
  assert.equal(resolveUserPath("/tmp/absolute.txt", cwd), path.normalize("/tmp/absolute.txt"));
});

test("isSubPath distinguishes inside and outside paths", () => {
  const cwd = "/tmp/workspace";

  assert.equal(isSubPath(cwd, path.join(cwd, "src/app.ts")), true);
  assert.equal(isSubPath(cwd, "/tmp/other/app.ts"), false);
});

test("abbreviate and appendLimited keep truncation behavior stable", () => {
  assert.equal(abbreviate("short", 10), "short");
  assert.match(abbreviate("abcdefghijklmnop", 5), /truncated 11 chars/);

  assert.equal(appendLimited("abc", "def", 10), "abcdef");
  assert.equal(appendLimited("abc", "def", 4), "abcd");
});
