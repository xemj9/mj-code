import { canonicalizeUrl, normalizeDomain } from "./web-policy.mjs";

import type {
  WebSearchProviderName,
  WebSearchProviderResultRow,
} from "../types/contracts.js";

const DEFAULT_SEARXNG_ENDPOINT = "https://search.sapti.me/search";

type RuntimeEventHandler = ((event: Record<string, unknown>) => Promise<void> | void) | null | undefined;

interface SearXngSearchProviderConfig {
  webSearxngEndpoint?: string | null;
  webCacheTtlMs?: number;
}

interface SearXngSearchRuntime {
  requestJson<TJson = unknown>(input: {
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

interface SearXngResultRow {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string;
  engine?: string;
  parsed_url?: string[];
  score?: number;
}

interface SearXngApiResponse {
  results?: SearXngResultRow[];
  number_of_results?: number;
  query?: string;
}

export class SearXngSearchProvider {
  readonly config: SearXngSearchProviderConfig;
  readonly runtime: SearXngSearchRuntime;
  readonly name: WebSearchProviderName;
  readonly endpoint: string;

  constructor(config: SearXngSearchProviderConfig, runtime: SearXngSearchRuntime) {
    this.config = config;
    this.runtime = runtime;
    this.name = "searxng";
    this.endpoint = config.webSearxngEndpoint ?? DEFAULT_SEARXNG_ENDPOINT;
  }

  async search(input: {
    query: string;
    maxResults: number;
    traceId?: string | null;
    onEvent?: RuntimeEventHandler;
  }): Promise<WebSearchProviderResultRow[]> {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general,science,it");
    url.searchParams.set("language", "en");

    const response = await this.runtime.requestJson<SearXngApiResponse>({
      url: url.toString(),
      method: "GET",
      requestType: "search",
      provider: this.name,
      traceId: input.traceId ?? null,
      onEvent: input.onEvent,
      cacheNamespace: "search-searxng",
      cacheKey: `searxng:${input.query}:${input.maxResults}`,
      query: input.query,
      headers: { Accept: "application/json" },
      cacheTtlMs: this.config.webCacheTtlMs,
    });

    return mapSearXngResponse(response.json, {
      query: input.query,
      provider: this.name,
      retrievedAt: new Date().toISOString(),
      cacheHit: response.meta.cacheHit,
      maxResults: input.maxResults,
    });
  }
}

interface SearXngParseContext {
  query: string;
  provider: WebSearchProviderName;
  retrievedAt: string;
  cacheHit: boolean;
  maxResults: number;
}

export function mapSearXngResponse(
  response: SearXngApiResponse,
  context: SearXngParseContext,
): WebSearchProviderResultRow[] {
  const rows = Array.isArray(response.results) ? response.results : [];
  return rows
    .filter((entry): entry is SearXngResultRow => Boolean(entry?.url))
    .slice(0, context.maxResults)
    .map((entry, index) => {
      const rawUrl = `${entry.url ?? ""}`;
      const canonicalUrl = canonicalizeUrl(rawUrl);
      return {
        id: `searxng-${index + 1}`,
        title: entry.title ?? rawUrl,
        url: canonicalUrl,
        canonicalUrl,
        domain: normalizeDomain(rawUrl),
        snippet: entry.content ?? "",
        query: context.query,
        provider: context.provider,
        retrievedAt: context.retrievedAt,
        publishedAt: entry.publishedDate ?? null,
        cacheHit: context.cacheHit,
        official: null,
        sourceKind: null,
        trustLayer: null,
      };
    });
}
