import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeUrl,
  evaluateUrlAgainstNetworkMode,
  filterSearchResultsForNetworkMode,
  getUrlMetadata,
  isDocsOnlyUrlAllowed,
  isOfficialLikeUrl,
  matchesDomainRule,
  normalizeDomain,
  normalizeDomainList,
  normalizeNetworkMode,
  summarizeNetworkInput,
} from "../src/lib/web-policy.mjs";

test("normalizeNetworkMode accepts supported values and rejects invalid ones", () => {
  assert.equal(normalizeNetworkMode(undefined), "docs-only");
  assert.equal(normalizeNetworkMode("off"), "off");
  assert.equal(normalizeNetworkMode("docs-only"), "docs-only");
  assert.equal(normalizeNetworkMode("open-web"), "open-web");
  assert.throws(() => normalizeNetworkMode("internet"), /Unsupported network mode/);
});

test("normalizeDomain and normalizeDomainList strip protocol and www and dedupe values", () => {
  assert.equal(normalizeDomain("https://www.docs.example.com/path?q=1"), "docs.example.com");
  assert.equal(normalizeDomain("WWW.GITHUB.COM/OpenAI"), "github.com");
  assert.deepEqual(
    normalizeDomainList("https://www.example.com foo.com,example.com"),
    ["example.com", "foo.com"],
  );
});

test("canonicalizeUrl removes hash and tracking params and sorts query keys", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/docs?page=1&utm_source=test&b=2&a=1#intro"),
    "https://example.com/docs?a=1&b=2&page=1",
  );
});

test("matchesDomainRule and allow-deny style matching handle subdomains", () => {
  assert.equal(matchesDomainRule("docs.example.com", "example.com"), true);
  assert.equal(matchesDomainRule("example.com", "example.com"), true);
  assert.equal(matchesDomainRule("example.org", "example.com"), false);
});

test("getUrlMetadata returns stable shapes for valid and invalid URLs", () => {
  const valid = getUrlMetadata("https://developers.openai.com/docs/api-reference/responses");
  assert.equal(valid.ok, true);
  assert.equal(valid.domain, "developers.openai.com");
  assert.equal(valid.pathname, "/docs/api-reference/responses");
  assert.equal(valid.protocol, "https:");
  assert.equal(valid.origin, "https://developers.openai.com");

  const invalid = getUrlMetadata("not a real url");
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Invalid URL/);
  assert.equal(invalid.domain, null);
  assert.equal(invalid.href, null);
});

test("isOfficialLikeUrl detects docs-like urls and keeps community hosts stricter", () => {
  assert.equal(isOfficialLikeUrl("https://docs.example.com/guide/getting-started"), true);
  assert.equal(isOfficialLikeUrl("https://reddit.com/r/node/comments/123/testing"), false);
  assert.equal(
    isOfficialLikeUrl("https://vendor.example.com/changelog", {
      allowDomains: ["vendor.example.com"],
    }),
    true,
  );
});

test("isDocsOnlyUrlAllowed permits docs and github source-release paths and blocks community hosts", () => {
  assert.equal(isDocsOnlyUrlAllowed("https://docs.example.com/api/reference"), true);
  assert.equal(isDocsOnlyUrlAllowed("https://example.com/docs/getting-started"), true);
  assert.equal(
    isDocsOnlyUrlAllowed("https://github.com/openai/openai-node/releases/tag/v1.0.0"),
    true,
  );
  assert.equal(
    isDocsOnlyUrlAllowed("https://github.com/openai/openai-node/blob/main/README.md"),
    true,
  );
  assert.equal(isDocsOnlyUrlAllowed("https://stackoverflow.com/questions/1/example"), false);
});

test("evaluateUrlAgainstNetworkMode returns stable decisions across off docs-only open-web and invalid inputs", () => {
  const offDecision = evaluateUrlAgainstNetworkMode("https://docs.example.com/reference/api", {
    networkMode: "off",
  });
  assert.equal(offDecision.allowed, false);
  assert.equal(offDecision.networkMode, "off");
  assert.equal(offDecision.metadata.ok, true);
  assert.equal(offDecision.docsOnlyAllowed, true);

  const docsOnlyBlocked = evaluateUrlAgainstNetworkMode("https://example.com/random-post", {
    networkMode: "docs-only",
  });
  assert.equal(docsOnlyBlocked.allowed, false);
  assert.match(docsOnlyBlocked.reason, /docs-only/i);
  assert.equal(docsOnlyBlocked.metadata.ok, true);

  const denyBlocked = evaluateUrlAgainstNetworkMode("https://docs.example.com/reference/api", {
    networkMode: "open-web",
    denyDomains: ["docs.example.com"],
  });
  assert.equal(denyBlocked.allowed, false);
  assert.equal(denyBlocked.matchedDenyDomain, "docs.example.com");
  assert.match(denyBlocked.reason, /deny list/i);

  const openDecision = evaluateUrlAgainstNetworkMode("https://example.com/random-post", {
    networkMode: "open-web",
  });
  assert.equal(openDecision.allowed, true);
  assert.equal(openDecision.official, false);
  assert.equal(openDecision.domain, "example.com");

  const invalid = evaluateUrlAgainstNetworkMode("not a real url", {
    networkMode: "docs-only",
  });
  assert.equal(invalid.allowed, false);
  assert.equal(invalid.metadata.ok, false);
  assert.match(invalid.reason, /Invalid URL/);
});

test("filterSearchResultsForNetworkMode keeps docs-friendly results under docs-only mode", () => {
  const filtered = filterSearchResultsForNetworkMode([
    {
      url: "https://docs.example.com/reference/api",
      title: "Docs",
      query: "example api docs",
    },
    {
      url: "https://github.com/openai/openai-node/releases/tag/v1.0.0",
      title: "Release",
      query: "openai node release",
    },
    {
      url: "https://reddit.com/r/node/comments/123",
      title: "Community",
      query: "node discussions",
    },
  ], {
    networkMode: "docs-only",
  });

  assert.equal(filtered.length, 2);
  assert.ok(filtered.some((entry) => entry.url.includes("docs.example.com")));
  assert.ok(filtered.some((entry) => entry.url.includes("github.com/openai/openai-node/releases")));
});

test("summarizeNetworkInput returns stable search and fetch shapes", () => {
  const search = summarizeNetworkInput("web_search", {
    query: "openai responses api",
  }, {
    networkMode: "docs-only",
    webProvider: "fallback",
  });
  assert.deepEqual(search, {
    kind: "search",
    query: "openai responses api",
    provider: "fallback",
    networkMode: "docs-only",
    domain: null,
    official: false,
    url: null,
    decision: null,
  });

  const fetch = summarizeNetworkInput("fetch_url", {
    url: "https://docs.example.com/reference/api",
  }, {
    networkMode: "docs-only",
    webProvider: "fallback",
  });
  assert.equal(fetch.kind, "fetch");
  assert.equal(fetch.provider, "fallback");
  assert.equal(fetch.networkMode, "docs-only");
  assert.equal(fetch.domain, "docs.example.com");
  assert.equal(fetch.url, "https://docs.example.com/reference/api");
  assert.equal(fetch.decision.allowed, true);
  assert.equal(fetch.decision.metadata.domain, "docs.example.com");
});
