import test from "node:test";
import assert from "node:assert/strict";

import {
  createSearchProvider,
  listSupportedWebProviders,
} from "../src/lib/web-search-providers.mjs";
import { mapBraveSearchResponse } from "../src/lib/web-provider-brave.mjs";
import { parseFallbackHtml } from "../src/lib/web-provider-fallback.mjs";

test("fallback provider html parsing returns stable typed rows", () => {
  const rows = parseFallbackHtml(`
    <html><body>
      <div class="result">
        <a class="result__a" href="https://docs.example.com/path?utm_source=test">Docs</a>
        <div class="result__snippet">Official docs.</div>
      </div>
    </body></html>
  `, {
    query: "docs example",
    provider: "fallback",
    retrievedAt: "2026-04-02T00:00:00.000Z",
    cacheHit: true,
    maxResults: 5,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].canonicalUrl, "https://docs.example.com/path");
  assert.equal(rows[0].provider, "fallback");
  assert.equal(rows[0].cacheHit, true);
  assert.equal(rows[0].official, null);
});

test("brave provider json mapping returns stable typed rows", () => {
  const rows = mapBraveSearchResponse({
    web: {
      results: [
        {
          title: "Docs",
          url: "https://docs.example.com/reference?utm_source=test",
          description: "Official docs result",
          page_age: "2026-04-01T00:00:00.000Z",
        },
      ],
    },
  }, {
    query: "docs example",
    provider: "brave",
    retrievedAt: "2026-04-02T00:00:00.000Z",
    cacheHit: false,
    maxResults: 5,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].canonicalUrl, "https://docs.example.com/reference");
  assert.equal(rows[0].provider, "brave");
  assert.equal(rows[0].publishedAt, "2026-04-01T00:00:00.000Z");
});

test("createSearchProvider selects providers and rejects unsupported names", () => {
  const runtime = {
    async requestText() {
      throw new Error("not used");
    },
    async requestJson() {
      throw new Error("not used");
    },
  };

  assert.equal(createSearchProvider({ webProvider: "fallback" }, runtime).name, "fallback");
  assert.equal(
    createSearchProvider({ webProvider: "brave", webProviderApiKey: "test" }, runtime).name,
    "brave",
  );
  assert.deepEqual(listSupportedWebProviders(), ["fallback", "brave"]);

  assert.throws(
    () => createSearchProvider({ webProvider: "custom" }, runtime),
    /Unsupported web search provider/,
  );
});
