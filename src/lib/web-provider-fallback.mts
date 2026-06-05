import { canonicalizeUrl, normalizeDomain } from "./web-policy.mjs";

import type {
  WebSearchProviderName,
  WebSearchProviderResultRow,
} from "../types/contracts.js";

const DEFAULT_DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";

type RuntimeEventHandler = ((event: Record<string, unknown>) => Promise<void> | void) | null | undefined;

interface FallbackSearchProviderConfig {
  webFallbackEndpoint?: string | null;
  webCacheTtlMs?: number;
}

interface FallbackSearchRuntime {
  requestText(input: {
    url: string;
    method: string;
    requestType: string;
    provider: WebSearchProviderName;
    traceId?: string | null;
    onEvent?: RuntimeEventHandler;
    cacheNamespace: string;
    cacheKey: string;
    query: string;
    allowContentTypes: string[];
    cacheTtlMs?: number;
  }): Promise<{
    content: string;
    meta: {
      cacheHit: boolean;
    };
  }>;
  requestJson?<TJson = unknown>(input: {
    url: string;
    method: string;
    requestType: string;
    provider: WebSearchProviderName;
    traceId?: string | null;
    onEvent?: RuntimeEventHandler;
    cacheNamespace: string;
    cacheKey: string;
    query: string;
    headers: Record<string, string>;
    cacheTtlMs?: number;
  }): Promise<{
    json: TJson;
    meta: {
      cacheHit: boolean;
    };
  }>;
}

export interface FallbackParseContext {
  query: string;
  provider: WebSearchProviderName;
  retrievedAt: string;
  cacheHit: boolean;
  maxResults: number;
}

export class FallbackSearchProvider {
  readonly config: FallbackSearchProviderConfig;
  readonly runtime: FallbackSearchRuntime;
  readonly name: WebSearchProviderName;
  readonly endpoint: string;

  constructor(config: FallbackSearchProviderConfig, runtime: FallbackSearchRuntime) {
    this.config = config;
    this.runtime = runtime;
    this.name = "fallback";
    this.endpoint = config.webFallbackEndpoint ?? DEFAULT_DUCKDUCKGO_ENDPOINT;
  }

  async search(input: {
    query: string;
    maxResults: number;
    traceId?: string | null;
    onEvent?: RuntimeEventHandler;
  }): Promise<WebSearchProviderResultRow[]> {
    // Strategy 1: Try DuckDuckGo HTML parsing
    try {
      const results = await this.searchDuckDuckGo(input);
      if (results.length > 0) {
        return results;
      }
    } catch {
      // DuckDuckGo failed, try fallback
    }

    // Strategy 2: Try DuckDuckGo Lite HTML parsing (different endpoint)
    try {
      const results = await this.searchDuckDuckGoLiteHtml(input);
      if (results.length > 0) {
        return results;
      }
    } catch {
      // Lite HTML also failed
    }

    // Strategy 3: Try DuckDuckGo Instant Answer API (JSON)
    try {
      const results = await this.searchDuckDuckGoLite(input);
      if (results.length > 0) {
        return results;
      }
    } catch {
      // Lite API also failed
    }

    return [];
  }

  private async searchDuckDuckGo(input: {
    query: string;
    maxResults: number;
    traceId?: string | null;
    onEvent?: RuntimeEventHandler;
  }): Promise<WebSearchProviderResultRow[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", input.query);

    const response = await this.runtime.requestText({
      url: url.toString(),
      method: "GET",
      requestType: "search",
      provider: this.name,
      traceId: input.traceId ?? null,
      onEvent: input.onEvent,
      cacheNamespace: "search-fallback",
      cacheKey: `fallback:${input.query}:${input.maxResults}`,
      query: input.query,
      allowContentTypes: ["text/html", "application/xhtml+xml"],
      cacheTtlMs: this.config.webCacheTtlMs,
    });

    return parseFallbackHtml(response.content, {
      query: input.query,
      provider: this.name,
      retrievedAt: new Date().toISOString(),
      cacheHit: response.meta.cacheHit,
      maxResults: input.maxResults,
    });
  }

  private async searchDuckDuckGoLiteHtml(input: {
    query: string;
    maxResults: number;
    traceId?: string | null;
    onEvent?: RuntimeEventHandler;
  }): Promise<WebSearchProviderResultRow[]> {
    // DuckDuckGo Lite endpoint — often more reliable than HTML endpoint
    const url = new URL("https://lite.duckduckgo.com/lite/");
    url.searchParams.set("q", input.query);
    url.searchParams.set("kl", "us-en");

    const response = await this.runtime.requestText({
      url: url.toString(),
      method: "GET",
      requestType: "search",
      provider: this.name,
      traceId: input.traceId ?? null,
      onEvent: input.onEvent,
      cacheNamespace: "search-fallback-lite-html",
      cacheKey: `fallback-lite-html:${input.query}:${input.maxResults}`,
      query: input.query,
      allowContentTypes: ["text/html", "application/xhtml+xml"],
      cacheTtlMs: this.config.webCacheTtlMs,
    });

    return parseLiteHtml(response.content, {
      query: input.query,
      provider: this.name,
      retrievedAt: new Date().toISOString(),
      cacheHit: response.meta.cacheHit,
      maxResults: input.maxResults,
    });
  }

  private async searchDuckDuckGoLite(input: {
    query: string;
    maxResults: number;
    traceId?: string | null;
    onEvent?: RuntimeEventHandler;
  }): Promise<WebSearchProviderResultRow[]> {
    // DuckDuckGo Instant Answer API — no API key needed
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");

    if (typeof this.runtime.requestJson !== "function") {
      return [];
    }

    const response = await this.runtime.requestJson<DuckDuckGoApiResponse>({
      url: url.toString(),
      method: "GET",
      requestType: "search",
      provider: this.name,
      traceId: input.traceId ?? null,
      onEvent: input.onEvent,
      cacheNamespace: "search-fallback-lite",
      cacheKey: `fallback-lite:${input.query}`,
      query: input.query,
      headers: { Accept: "application/json" },
      cacheTtlMs: this.config.webCacheTtlMs,
    });

    const results: WebSearchProviderResultRow[] = [];
    const now = new Date().toISOString();

    // Abstract (main answer)
    if (response.json.AbstractURL && response.json.AbstractText) {
      const rawUrl = response.json.AbstractURL;
      results.push({
        id: `fallback-lite-1`,
        title: response.json.Heading || response.json.AbstractText.slice(0, 80),
        url: canonicalizeUrl(rawUrl),
        canonicalUrl: canonicalizeUrl(rawUrl),
        domain: normalizeDomain(rawUrl),
        snippet: response.json.AbstractText,
        query: input.query,
        provider: this.name,
        retrievedAt: now,
        publishedAt: null,
        cacheHit: response.meta.cacheHit,
        official: null,
        sourceKind: null,
        trustLayer: null,
      });
    }

    // Related topics with URLs
    for (const topic of response.json.RelatedTopics ?? []) {
      if (results.length >= input.maxResults) break;
      if (!topic.FirstURL || !topic.Text) continue;
      const rawUrl = topic.FirstURL;
      results.push({
        id: `fallback-lite-${results.length + 1}`,
        title: topic.Text.slice(0, 100),
        url: canonicalizeUrl(rawUrl),
        canonicalUrl: canonicalizeUrl(rawUrl),
        domain: normalizeDomain(rawUrl),
        snippet: topic.Text,
        query: input.query,
        provider: this.name,
        retrievedAt: now,
        publishedAt: null,
        cacheHit: response.meta.cacheHit,
        official: null,
        sourceKind: null,
        trustLayer: null,
      });
    }

    // Results (from !bang redirects or explicit results)
    for (const result of response.json.Results ?? []) {
      if (results.length >= input.maxResults) break;
      if (!result.FirstURL || !result.Text) continue;
      const rawUrl = result.FirstURL;
      results.push({
        id: `fallback-lite-${results.length + 1}`,
        title: result.Text.slice(0, 100),
        url: canonicalizeUrl(rawUrl),
        canonicalUrl: canonicalizeUrl(rawUrl),
        domain: normalizeDomain(rawUrl),
        snippet: result.Text,
        query: input.query,
        provider: this.name,
        retrievedAt: now,
        publishedAt: null,
        cacheHit: response.meta.cacheHit,
        official: null,
        sourceKind: null,
        trustLayer: null,
      });
    }

    return results;
  }
}

// DuckDuckGo Instant Answer API response type
interface DuckDuckGoApiResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{
    FirstURL?: string;
    Text?: string;
    Result?: string;
  }>;
  Results?: Array<{
    FirstURL?: string;
    Text?: string;
  }>;
}

export function parseFallbackHtml(
  html: string,
  context: FallbackParseContext,
): WebSearchProviderResultRow[] {
  const results: WebSearchProviderResultRow[] = [];

  // Strategy 1: DuckDuckGo result__a / result__snippet pattern (original)
  const anchors = [...html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const anchorMatch of anchors) {
    const rawUrl = decodeHtml(anchorMatch[1]);
    const canonicalUrl = canonicalizeUrl(rawUrl);
    const title = decodeHtml(anchorMatch[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const searchStart = (anchorMatch.index ?? 0) + anchorMatch[0].length;
    const nearby = html.slice(searchStart, searchStart + 800);
    const snippetMatch = nearby.match(/<(?:a|div|span|p)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span|p)>/i);
    const snippet = decodeHtml(
      snippetMatch?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "",
    );
    if (!rawUrl || !title) {
      continue;
    }

    results.push({
      id: `fallback-${results.length + 1}`,
      title,
      url: canonicalUrl,
      canonicalUrl,
      domain: normalizeDomain(rawUrl),
      snippet,
      query: context.query,
      provider: context.provider,
      retrievedAt: context.retrievedAt,
      publishedAt: null,
      cacheHit: context.cacheHit,
      official: null,
      sourceKind: null,
      trustLayer: null,
    });

    if (results.length >= context.maxResults) {
      break;
    }
  }

  // Strategy 2: DuckDuckGo redirect links (uddg= parameter)
  if (results.length === 0) {
    const allLinks = [...html.matchAll(/<a[^>]+href=["'][^"']*uddg=([^"&#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const linkMatch of allLinks) {
      if (results.length >= context.maxResults) break;
      const encodedUrl = linkMatch[1];
      if (!encodedUrl) continue;
      let rawUrl: string;
      try {
        rawUrl = decodeURIComponent(encodedUrl);
      } catch {
        rawUrl = encodedUrl;
      }
      const canonicalUrl = canonicalizeUrl(rawUrl);
      const title = decodeHtml(linkMatch[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (!rawUrl || !title || canonicalUrl.startsWith("https://duckduckgo.com")) continue;

      results.push({
        id: `fallback-${results.length + 1}`,
        title,
        url: canonicalUrl,
        canonicalUrl,
        domain: normalizeDomain(rawUrl),
        snippet: "",
        query: context.query,
        provider: context.provider,
        retrievedAt: context.retrievedAt,
        publishedAt: null,
        cacheHit: context.cacheHit,
        official: null,
        sourceKind: null,
        trustLayer: null,
      });
    }
  }

  // Strategy 3: Broader link extraction — any href with duckduckgo redirect
  if (results.length === 0) {
    const allLinks = [...html.matchAll(/<a[^>]+href=["'](\/\/duckduckgo\.com\/l\/\?uddg=([^"']+))?["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const linkMatch of allLinks) {
      if (results.length >= context.maxResults) break;
      const encodedUrl = linkMatch[2];
      if (!encodedUrl) continue;
      let rawUrl: string;
      try {
        rawUrl = decodeURIComponent(encodedUrl);
      } catch {
        rawUrl = encodedUrl;
      }
      const canonicalUrl = canonicalizeUrl(rawUrl);
      const title = decodeHtml(linkMatch[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (!rawUrl || !title || canonicalUrl.startsWith("https://duckduckgo.com")) continue;

      results.push({
        id: `fallback-${results.length + 1}`,
        title,
        url: canonicalUrl,
        canonicalUrl,
        domain: normalizeDomain(rawUrl),
        snippet: "",
        query: context.query,
        provider: context.provider,
        retrievedAt: context.retrievedAt,
        publishedAt: null,
        cacheHit: context.cacheHit,
        official: null,
        sourceKind: null,
        trustLayer: null,
      });
    }
  }

  return results;
}

/**
 * Parse DuckDuckGo Lite HTML — different layout than the main HTML endpoint.
 * The Lite version uses a table-based layout with result links.
 */
export function parseLiteHtml(
  html: string,
  context: FallbackParseContext,
): WebSearchProviderResultRow[] {
  const results: WebSearchProviderResultRow[] = [];

  // DuckDuckGo Lite uses <a class="result-link"> for result URLs
  // and <td class="result-snippet"> for snippets
  const linkPattern = /<a[^>]+class=["'][^"']*result-link[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const linkMatches = [...html.matchAll(linkPattern)];

  for (const linkMatch of linkMatches) {
    if (results.length >= context.maxResults) break;
    const rawUrl = decodeHtml(linkMatch[1]);
    const title = decodeHtml(linkMatch[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!rawUrl || !title) continue;

    // Skip duckduckgo internal URLs
    const canonicalUrl = canonicalizeUrl(rawUrl);
    if (canonicalUrl.includes("duckduckgo.com")) continue;

    // Try to find snippet in the nearby HTML
    const searchStart = (linkMatch.index ?? 0) + linkMatch[0].length;
    const nearby = html.slice(searchStart, searchStart + 1200);
    const snippetMatch = nearby.match(/<td[^>]+class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)
      ?? nearby.match(/class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
    const snippet = decodeHtml(
      snippetMatch?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "",
    );

    results.push({
      id: `fallback-lite-${results.length + 1}`,
      title,
      url: canonicalUrl,
      canonicalUrl,
      domain: normalizeDomain(rawUrl),
      snippet,
      query: context.query,
      provider: context.provider,
      retrievedAt: context.retrievedAt,
      publishedAt: null,
      cacheHit: context.cacheHit,
      official: null,
      sourceKind: null,
      trustLayer: null,
    });
  }

  // Fallback: try to extract links from the lite HTML using a broader pattern
  if (results.length === 0) {
    // Lite DDG sometimes puts results as regular links in <td> elements
    const allLinks = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/(?!duckduckgo\.com)[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const linkMatch of allLinks) {
      if (results.length >= context.maxResults) break;
      const rawUrl = linkMatch[1];
      const title = decodeHtml(linkMatch[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (!rawUrl || !title) continue;
      // Skip very short titles (likely nav links)
      if (title.length < 5) continue;

      const canonicalUrl = canonicalizeUrl(rawUrl);
      results.push({
        id: `fallback-lite-${results.length + 1}`,
        title,
        url: canonicalUrl,
        canonicalUrl,
        domain: normalizeDomain(rawUrl),
        snippet: "",
        query: context.query,
        provider: context.provider,
        retrievedAt: context.retrievedAt,
        publishedAt: null,
        cacheHit: context.cacheHit,
        official: null,
        sourceKind: null,
        trustLayer: null,
      });
    }
  }

  return results;
}

function decodeHtml(value: string): string {
  return `${value ?? ""}`
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
