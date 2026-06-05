import { canonicalizeUrl, normalizeDomain } from "./web-policy.mjs";

import type {
  WebSearchProviderName,
  WebSearchProviderResultRow,
} from "../types/contracts.js";

const DEFAULT_BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

type RuntimeEventHandler = ((event: Record<string, unknown>) => Promise<void> | void) | null | undefined;

interface BraveSearchProviderConfig {
  webBraveEndpoint?: string | null;
  webProviderApiKey?: string | null;
  webCacheTtlMs?: number;
}

interface BraveSearchRuntime {
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

interface BraveApiRow {
  title?: string | null;
  meta_title?: string | null;
  url?: string | null;
  description?: string | null;
  extra_snippets?: string[] | null;
  page_age?: string | null;
  published_at?: string | null;
}

interface BraveApiResponse {
  web?: {
    results?: BraveApiRow[] | null;
  } | null;
}

export interface BraveParseContext {
  query: string;
  provider: WebSearchProviderName;
  retrievedAt: string;
  cacheHit: boolean;
  maxResults: number;
}

export class BraveSearchProvider {
  readonly config: BraveSearchProviderConfig;
  readonly runtime: BraveSearchRuntime;
  readonly name: WebSearchProviderName;
  readonly endpoint: string;

  constructor(config: BraveSearchProviderConfig, runtime: BraveSearchRuntime) {
    this.config = config;
    this.runtime = runtime;
    this.name = "brave";
    this.endpoint = config.webBraveEndpoint ?? DEFAULT_BRAVE_ENDPOINT;
  }

  async search(input: {
    query: string;
    maxResults: number;
    traceId?: string | null;
    onEvent?: RuntimeEventHandler;
  }): Promise<WebSearchProviderResultRow[]> {
    if (!this.config.webProviderApiKey) {
      throw new Error("Brave search provider requires MJ_CODE_WEB_PROVIDER_API_KEY.");
    }

    const url = new URL(this.endpoint);
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(input.maxResults));

    const response = await this.runtime.requestJson<BraveApiResponse>({
      url: url.toString(),
      method: "GET",
      requestType: "search",
      provider: this.name,
      traceId: input.traceId ?? null,
      onEvent: input.onEvent,
      cacheNamespace: "search-brave",
      cacheKey: `brave:${input.query}:${input.maxResults}`,
      query: input.query,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.config.webProviderApiKey,
      },
      cacheTtlMs: this.config.webCacheTtlMs,
    });

    return mapBraveSearchResponse(response.json, {
      query: input.query,
      provider: this.name,
      retrievedAt: new Date().toISOString(),
      cacheHit: response.meta.cacheHit,
      maxResults: input.maxResults,
    });
  }
}

export function mapBraveSearchResponse(
  response: BraveApiResponse,
  context: BraveParseContext,
): WebSearchProviderResultRow[] {
  const rows = Array.isArray(response.web?.results) ? response.web.results : [];
  return rows
    .filter((entry): entry is BraveApiRow => Boolean(entry?.url))
    .slice(0, context.maxResults)
    .map((entry, index) => {
      const rawUrl = `${entry.url ?? ""}`;
      const canonicalUrl = canonicalizeUrl(rawUrl);
      return {
        id: `brave-${index + 1}`,
        title: entry.title ?? entry.meta_title ?? rawUrl,
        url: canonicalUrl,
        canonicalUrl,
        domain: normalizeDomain(rawUrl),
        snippet: entry.description ?? entry.extra_snippets?.join(" ") ?? "",
        query: context.query,
        provider: context.provider,
        retrievedAt: context.retrievedAt,
        publishedAt: entry.page_age ?? entry.published_at ?? null,
        cacheHit: context.cacheHit,
        official: null,
        sourceKind: null,
        trustLayer: null,
      };
    });
}
