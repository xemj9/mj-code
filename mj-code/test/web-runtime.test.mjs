import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeHealth } from "../src/lib/runtime-health.mjs";
import { WebRuntime } from "../src/lib/web-runtime.mjs";

test("web runtime retries transient failures and serves cached results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-web-runtime-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "gateway" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ items: ["ok"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const runtime = new WebRuntime({
      projectStateDir,
      webTimeoutMs: 500,
      webMaxRetries: 2,
      webRetryBudgetMs: 1000,
      webCacheTtlMs: 10000,
    });
    const events = [];

    const first = await runtime.requestJson({
      url: "https://search.example.test/query",
      requestType: "search",
      provider: "fallback",
      onEvent: async (event) => events.push(event.type),
      cacheNamespace: "search-test",
    });

    assert.deepEqual(first.json, { items: ["ok"] });
    assert.equal(first.meta.attemptCount, 2);
    assert.ok(events.includes("web_retry_scheduled"));

    const second = await runtime.requestJson({
      url: "https://search.example.test/query",
      requestType: "search",
      provider: "fallback",
      cacheNamespace: "search-test",
    });

    assert.equal(second.meta.cacheHit, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web runtime opens a circuit after repeated exhausted failures and blocks until cooldown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-web-circuit-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const runtimeHealth = new RuntimeHealth({
    projectStateDir,
    runtimeCircuitFailureThreshold: 2,
    runtimeCircuitCooldownMs: 20,
    runtimeCircuitHalfOpenMaxRequests: 1,
  });
  await runtimeHealth.initialize();

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "gateway" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const runtime = new WebRuntime({
      projectStateDir,
      webTimeoutMs: 200,
      webMaxRetries: 0,
      webRetryBudgetMs: 200,
      webCacheTtlMs: 10000,
      runtimeCircuitFailureThreshold: 2,
      runtimeCircuitCooldownMs: 20,
      runtimeCircuitHalfOpenMaxRequests: 1,
    }, {
      runtimeHealth,
    });

    await assert.rejects(() => runtime.requestJson({
      url: "https://search.example.test/query",
      requestType: "search",
      provider: "fallback",
      cacheNamespace: "search-circuit",
    }));
    await assert.rejects(() => runtime.requestJson({
      url: "https://search.example.test/query",
      requestType: "search",
      provider: "fallback",
      cacheNamespace: "search-circuit",
    }));

    await assert.rejects(
      () => runtime.requestJson({
        url: "https://search.example.test/query",
        requestType: "search",
        provider: "fallback",
        cacheNamespace: "search-circuit",
      }),
      (error) => error.taxonomy === "network_circuit_open",
    );
    assert.equal(calls, 2);
    assert.equal(runtimeHealth.listCircuits("web")[0].state, "open");

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ items: ["ok"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await runtime.requestJson({
      url: "https://search.example.test/query",
      requestType: "search",
      provider: "fallback",
      cacheNamespace: "search-circuit",
    });
    assert.deepEqual(response.json, { items: ["ok"] });
    assert.equal(runtimeHealth.listCircuits("web")[0].state, "closed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web runtime classifies timeout and unsupported content type errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-web-runtime-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    if (url.endsWith("/slow")) {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }

    return new Response("png", {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  };

  try {
    const runtime = new WebRuntime({
      projectStateDir,
      webTimeoutMs: 30,
      webMaxRetries: 0,
      webRetryBudgetMs: 100,
      webCacheTtlMs: 10000,
    });

    await assert.rejects(
      runtime.requestText({
        url: "https://fetch.example.test/slow",
        requestType: "fetch",
        allowContentTypes: ["text/plain"],
      }),
      (error) => error.taxonomy === "fetch_timeout",
    );

    await assert.rejects(
      runtime.requestText({
        url: "https://fetch.example.test/binary",
        requestType: "fetch",
        allowContentTypes: ["text/html"],
      }),
      (error) => error.taxonomy === "fetch_unsupported_content_type",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
