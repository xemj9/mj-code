import { createSearchProviderError } from "./web-errors.mjs";
import { BraveSearchProvider } from "./web-provider-brave.mjs";
import { FallbackSearchProvider } from "./web-provider-fallback.mjs";
import { SearXngSearchProvider } from "./web-provider-searxng.mjs";

import type {
  WebSearchProvider,
  WebSearchProviderName,
  WebSearchProviderResultRow,
  WebSearchProviderSearchInput,
} from "../types/contracts.js";

type RuntimeEventHandler = ((event: Record<string, unknown>) => Promise<void> | void) | null | undefined;

export interface WebSearchProviderConfig {
  webProvider?: WebSearchProviderName | string | null;
  webProviderApiKey?: string | null;
  webCacheTtlMs?: number;
  webFallbackEndpoint?: string | null;
  webBraveEndpoint?: string | null;
  webSearxngEndpoint?: string | null;
}

export interface WebSearchProviderRuntime {
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

const SUPPORTED_WEB_PROVIDERS = new Set<WebSearchProviderName>(["fallback", "brave", "searxng"]);

export function createSearchProvider(
  config: WebSearchProviderConfig,
  runtime: WebSearchProviderRuntime,
): WebSearchProvider {
  const providerName = normalizeWebSearchProviderName(config.webProvider);
  if (providerName !== "fallback" && providerName !== "brave" && providerName !== "searxng") {
    throw createSearchProviderError({
      provider: `${config.webProvider ?? ""}`.trim().toLowerCase() || "fallback",
      unavailable: true,
      message: `Unsupported web search provider "${`${config.webProvider ?? ""}`.trim().toLowerCase() || "fallback"}".`,
      retryable: false,
    });
  }

  if (providerName === "brave") {
    if (!runtime.requestJson) {
      throw createSearchProviderError({
        provider: "brave",
        unavailable: true,
        message: "Brave search provider requires requestJson on the runtime, but it is not available.",
        retryable: false,
      });
    }
    return new BraveSearchProvider(config, runtime as BraveSearchProviderRuntime);
  }

  if (providerName === "searxng") {
    if (!runtime.requestJson) {
      throw createSearchProviderError({
        provider: "searxng",
        unavailable: true,
        message: "SearXNG search provider requires requestJson on the runtime, but it is not available.",
        retryable: false,
      });
    }
    return new SearXngSearchProvider(config, runtime as SearXngSearchProviderRuntime);
  }

  return new FallbackSearchProvider(config, runtime);
}

type BraveSearchProviderRuntime = {
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
  requestText?(input: {
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
};

type SearXngSearchProviderRuntime = {
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
};

export function listSupportedWebProviders(): WebSearchProviderName[] {
  return [...SUPPORTED_WEB_PROVIDERS];
}

function normalizeWebSearchProviderName(value: unknown): WebSearchProviderName | string {
  const normalized = `${value ?? "fallback"}`.trim().toLowerCase();
  if (normalized === "fallback" || normalized === "brave" || normalized === "searxng") {
    return normalized;
  }
  return normalized;
}
