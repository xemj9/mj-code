import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WebCache } from "../src/lib/web-cache.mjs";

test("web cache stores and reads positive records with hit metadata updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-web-cache-"));
  const cache = new WebCache(root, {
    defaultTtlMs: 1_000,
  });

  const record = await cache.set("search", "GET:https://docs.example.com", {
    payload: { items: [1, 2, 3] },
  }, {
    provider: "fallback",
    query: "docs",
    url: "https://docs.example.com",
  });
  const beforeAccess = record.lastAccessedAt;
  const lookup = await cache.get("search", "GET:https://docs.example.com");

  assert.equal(lookup?.hit, true);
  assert.equal(lookup?.negative, false);
  assert.deepEqual(lookup?.value, {
    payload: { items: [1, 2, 3] },
  });
  assert.equal(lookup?.meta.provider, "fallback");
  assert.equal(lookup?.meta.query, "docs");
  assert.equal(lookup?.meta.url, "https://docs.example.com");
  assert.equal(lookup?.meta.cacheHitCount, 1);
  assert.notEqual(lookup?.meta.lastAccessedAt, beforeAccess);
});

test("web cache stores and reads negative records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-web-cache-negative-"));
  const cache = new WebCache(root, {
    negativeTtlMs: 1_000,
  });

  await cache.setNegative("fetch", "GET:https://blocked.example.com", {
    message: "blocked",
    code: "domain_blocked",
  }, {
    url: "https://blocked.example.com",
  });
  const lookup = await cache.get("fetch", "GET:https://blocked.example.com");

  assert.equal(lookup?.hit, true);
  assert.equal(lookup?.negative, true);
  assert.equal(lookup?.value, null);
  assert.deepEqual(lookup?.meta.error, {
    message: "blocked",
    code: "domain_blocked",
  });
});

test("web cache removes expired entries on lookup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-web-cache-expired-"));
  const cache = new WebCache(root);

  await cache.set("fetch", "GET:https://stale.example.com", {
    payload: "stale",
  }, {
    ttlMs: -1,
  });
  const filePath = cache.buildPath("fetch", "GET:https://stale.example.com");
  const lookup = await cache.get("fetch", "GET:https://stale.example.com");

  assert.equal(lookup, null);
  await assert.rejects(fs.access(filePath));
});

test("web cache prunes namespaces down to the latest N entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-web-cache-prune-"));
  const cache = new WebCache(root, {
    maxEntriesPerNamespace: 2,
  });

  for (const [index, key] of ["one", "two", "three"].entries()) {
    await cache.set("search", key, { key });
    const filePath = cache.buildPath("search", key);
    const stamp = new Date(Date.now() + (index * 1_000));
    await fs.utimes(filePath, stamp, stamp);
  }

  const entries = await fs.readdir(path.join(root, "web-cache", "search"));
  assert.equal(entries.filter((entry) => entry.endsWith(".json")).length, 2);
  assert.equal(await cache.get("search", "one"), null);
  assert.equal((await cache.get("search", "two"))?.negative, false);
  assert.equal((await cache.get("search", "three"))?.negative, false);
});
