import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySource,
  normalizeRankingMode,
  rankSources,
} from "../src/lib/source-ranker.mjs";

test("source ranker prefers official docs in docs-first mode and returns breakdown", () => {
  const ranked = rankSources([
    {
      title: "OpenAI API Reference",
      url: "https://developers.openai.com/docs/api-reference/responses",
      snippet: "Official API reference for responses and tools.",
      query: "openai responses api reference",
      provider: "fallback",
      retrievedAt: "2026-04-02T00:00:00.000Z",
      publishedAt: "2026-03-15T00:00:00.000Z",
    },
    {
      title: "Blog post about responses API",
      url: "https://example-blog.test/posts/openai-responses-api",
      snippet: "Community overview of the API.",
      query: "openai responses api reference",
      provider: "fallback",
      retrievedAt: "2026-04-02T00:00:00.000Z",
      publishedAt: "2026-03-10T00:00:00.000Z",
    },
  ], {
    query: "openai responses api reference",
    mode: "docs-first",
  });

  assert.equal(ranked[0].domain, "developers.openai.com");
  assert.equal(ranked[0].official, true);
  assert.match(ranked[0].sourceKind, /^official-/);
  assert.ok(ranked[0].scoreBreakdown.docsHint > 0);
  assert.deepEqual(Object.keys(ranked[0].scoreBreakdown).sort(), [
    "allowlistBonus",
    "docsHint",
    "freshness",
    "mirrorPenalty",
    "modeBonus",
    "officialness",
    "querySnippetOverlap",
    "queryTitleOverlap",
    "queryUrlOverlap",
    "spamPenalty",
    "total",
    "trustGraph",
  ]);
  assert.equal(ranked[0].score, ranked[0].scoreBreakdown.total);
  assert.ok(ranked[0].score > ranked[1].score);
});

test("source ranker collapses canonical duplicates", () => {
  const ranked = rankSources([
    {
      title: "Docs A",
      url: "https://developers.openai.com/docs?utm_source=test",
      snippet: "one",
      query: "openai docs",
      provider: "fallback",
      retrievedAt: "2026-04-02T00:00:00.000Z",
    },
    {
      title: "Docs B",
      url: "https://developers.openai.com/docs",
      snippet: "two",
      query: "openai docs",
      provider: "fallback",
      retrievedAt: "2026-04-02T00:00:00.000Z",
    },
  ], {
    query: "openai docs",
    mode: "official-first",
  });

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].canonicalUrl, "https://developers.openai.com/docs");
});

test("source ranker prefers official results in official-first mode", () => {
  const ranked = rankSources([
    {
      id: "community",
      title: "Community post",
      url: "https://community.example.com/posts/responses-api",
      canonicalUrl: "https://community.example.com/posts/responses-api",
      domain: "community.example.com",
      snippet: "Community explanation of the API.",
      query: "responses api docs",
      provider: "fallback",
      retrievedAt: "2026-04-02T00:00:00.000Z",
      publishedAt: null,
      cacheHit: false,
      official: false,
      sourceKind: "blog",
      trustLayer: "community",
    },
    {
      id: "official",
      title: "API Docs",
      url: "https://docs.example.com/api/responses",
      canonicalUrl: "https://docs.example.com/api/responses",
      domain: "docs.example.com",
      snippet: "Official responses API docs.",
      query: "responses api docs",
      provider: "fallback",
      retrievedAt: "2026-04-02T00:00:00.000Z",
      publishedAt: null,
      cacheHit: false,
      official: true,
      sourceKind: "official-doc",
      trustLayer: "official",
    },
  ], {
    query: "responses api docs",
    mode: "official-first",
  });

  assert.equal(ranked[0].official, true);
  assert.equal(ranked[0].sourceKind, "official-doc");
  assert.ok(ranked[0].score > ranked[1].score);
});

test("source ranker keeps classification and ranking-mode normalization stable", () => {
  assert.equal(normalizeRankingMode("DOCS-FIRST"), "docs-first");
  assert.equal(normalizeRankingMode("something-else"), "balanced");

  const classification = classifySource(
    "https://github.com/openai/openai-node/releases/tag/v1.0.0",
    "Release notes",
    "Latest release",
    "openai node release notes",
  );
  assert.equal(classification.sourceKind, "release-notes");
  assert.equal(classification.official, true);
  assert.equal(classification.trustLayer, "release");
});
