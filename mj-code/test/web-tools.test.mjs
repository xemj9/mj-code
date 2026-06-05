import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SourceRegistry } from "../src/lib/source-registry.mjs";
import { createSearchProvider } from "../src/lib/web-search-providers.mjs";
import { WebRuntime } from "../src/lib/web-runtime.mjs";
import { extractContent, fetchUrl, webSearch } from "../src/tools/web.mjs";

test("web tools search, filter, fetch, extract, and register citations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-web-tools-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (`${url}` === "https://search.example.test/?q=responses+api+docs") {
      return new Response(`
        <html><body>
          <div class="result">
            <a class="result__a" href="https://docs.example.com/docs/page">Responses API Docs</a>
            <div class="result__snippet">Official docs for the responses API.</div>
          </div>
          <div class="result">
            <a class="result__a" href="https://community.example.com/post">Community Post</a>
            <div class="result__snippet">A community explanation.</div>
          </div>
        </body></html>
      `, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (`${url}` === "https://docs.example.com/robots.txt" || `${url}` === "https://community.example.com/robots.txt") {
      return new Response("User-agent: *\nDisallow: /blocked\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (`${url}` === "https://docs.example.com/docs/page") {
      return new Response(`
        <html>
          <head>
            <title>Responses API Docs</title>
            <meta name="description" content="Official docs page">
          </head>
          <body>
            <h1>Responses API</h1>
            <h2>Streaming</h2>
            <p>The responses API supports streaming output.</p>
          </body>
        </html>
      `, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (`${url}` === "https://docs.example.com/empty") {
      return new Response("", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (`${url}` === "https://community.example.com/post") {
      return new Response("<html><title>Community</title><body><p>community</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  };

  try {
    const config = {
      cwd: root,
      projectStateDir,
      webCacheTtlMs: 10000,
      webTimeoutMs: 500,
      webMaxRetries: 1,
      webRetryBudgetMs: 1000,
      webMaxResults: 5,
      webMaxExtractChars: 4000,
      maxOutputChars: 2000,
      networkMode: "docs-only",
      webProvider: "fallback",
      webRankingMode: "docs-first",
      webAllowDomains: [],
      webDenyDomains: [],
      webFallbackEndpoint: "https://search.example.test/",
    };
    const webRuntime = new WebRuntime(config);
    const sourceRegistry = new SourceRegistry(projectStateDir);
    await sourceRegistry.initialize("session-web");
    const context = {
      ...config,
      webRuntime,
      sourceRegistry,
      searchProvider: createSearchProvider(config, webRuntime),
    };

    const searchResult = await webSearch({ query: "responses api docs" }, context, {
      traceId: "trace-search",
    });
    assert.equal(searchResult.results.length, 1);
    assert.equal(searchResult.rankingMode, "docs-first");
    assert.match(searchResult.results[0].url, /docs\.example\.com\/docs\/page$/);
    assert.equal(searchResult.results[0].sourceId, "S1");
    assert.ok(searchResult.results[0].scoreBreakdown.total > 0);
    assert.equal(searchResult.sourcePack.packId, "pack-1");
    assert.equal(searchResult.sourcePack.sourceIds.length, 1);
    assert.equal(searchResult.citations[0].sourceId, "S1");

    const extracted = await extractContent({ url: "https://docs.example.com/docs/page" }, context, {
      traceId: "trace-extract",
    });
    assert.equal(extracted.extracted.title, "Responses API Docs");
    assert.ok(extracted.extracted.headings.includes("Streaming"));
    assert.equal(extracted.primaryCitation.sourceId, "S1");
    assert.equal(extracted.sourcePack.sources[0].sourceKind, "official-doc");
    assert.equal(extracted.sourcePack.sources[0].trustLayer, "official");

    const fetched = await fetchUrl({ url: "https://docs.example.com/docs/page" }, context, {
      traceId: "trace-fetch",
    });
    assert.match(fetched.bodyPreview, /Responses API/);
    assert.equal(fetched.extractedMeta.title, "Responses API Docs");
    assert.ok(fetched.sourcePack.sourceIds.length >= 1);

    const fetchedWithoutExtraction = await fetchUrl({ url: "https://docs.example.com/empty" }, context, {
      traceId: "trace-fetch-empty",
    });
    assert.equal(fetchedWithoutExtraction.extractedMeta, null);

    await assert.rejects(
      fetchUrl({ url: "https://community.example.com/post" }, context, {
        traceId: "trace-blocked",
      }),
      (error) => error.taxonomy === "domain_blocked",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
