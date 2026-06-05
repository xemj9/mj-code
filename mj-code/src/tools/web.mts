import { extractContentFromDocument } from "../lib/content-extractor.mjs";
import {
  createDomainBlockedError,
  createRobotsBlockedError,
} from "../lib/web-errors.mjs";
import {
  normalizeRankingMode,
  rankSources,
} from "../lib/source-ranker.mjs";
import {
  evaluateUrlAgainstNetworkMode,
  filterSearchResultsForNetworkMode,
  getUrlMetadata,
} from "../lib/web-policy.mjs";

import type {
  CitationSummary,
  ExtractContentResult,
  ExtractedContent,
  FetchUrlResult,
  NetworkMode,
  RankingMode,
  SourcePackSummary,
  UrlAccessDecision,
  WebSearchProvider,
  WebSearchResult,
} from "../types/contracts.js";

const FETCHABLE_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
];

type RuntimeEventHandler = ((event: Record<string, unknown>) => Promise<void> | void) | null | undefined;

interface WebToolContext {
  networkMode: NetworkMode;
  webAllowDomains: string[];
  webDenyDomains: string[];
  webCacheTtlMs: number;
  webMaxExtractChars: number;
  webMaxResults: number;
  webRankingMode: RankingMode | string;
  maxOutputChars: number;
  webRuntime: {
    requestText(input: {
      url: string;
      method: string;
      requestType: string;
      traceId?: string | null;
      onEvent?: RuntimeEventHandler;
      cacheNamespace: string;
      cacheKey: string;
      cacheTtlMs: number;
      allowContentTypes: string[];
    }): Promise<{
      content: string;
      meta: {
        finalUrl: string;
        contentType: string | null;
        redirected: boolean;
        cacheHit: boolean;
      };
    }>;
  };
  sourceRegistry: {
    registerPack(
      entries: Array<Record<string, unknown>>,
      metadata?: Record<string, unknown>,
    ): Promise<{
      pack: {
        id: string;
        sourceIds: string[];
      };
      sources: SourcePackSummary["sources"];
      citations: CitationSummary[];
    }>;
  };
  searchProvider: WebSearchProvider;
}

interface WebToolExecutionContext {
  traceId?: string | null;
  onWebEvent?: RuntimeEventHandler;
}

interface WebFetchResponse {
  content: string;
  meta: {
    finalUrl: string;
    contentType: string | null;
    redirected: boolean;
    cacheHit: boolean;
  };
}

interface SourcePackRegistrationResult {
  pack: {
    id: string;
    sourceIds: string[];
  };
  sources: SourcePackSummary["sources"];
  citations: CitationSummary[];
}

export async function webSearch(
  input: Record<string, unknown> | null | undefined,
  context: WebToolContext,
  executionContext: WebToolExecutionContext = {},
): Promise<WebSearchResult> {
  const query = `${input?.query ?? ""}`.trim();
  if (!query) {
    throw new Error("web_search requires a query.");
  }

  const maxResults = normalizeCount(input?.maxResults, context.webMaxResults);
  const rankingMode = normalizeRankingMode(input?.rankingMode ?? context.webRankingMode ?? "balanced");
  const results = await context.searchProvider.search({
    query,
    maxResults,
    traceId: executionContext.traceId ?? null,
    onEvent: executionContext.onWebEvent,
  });
  const filtered = filterSearchResultsForNetworkMode(results, {
    query,
    networkMode: context.networkMode,
    allowDomains: context.webAllowDomains,
    denyDomains: context.webDenyDomains,
  });
  const ranked = rankSources(filtered, {
    query,
    mode: rankingMode,
    allowDomains: context.webAllowDomains,
  });

  const sourcePack = await context.sourceRegistry.registerPack(
    ranked.map((entry): Record<string, unknown> => ({ ...entry })),
    {
      toolName: "web_search",
      query,
      provider: context.searchProvider.name,
      reasonUsed: "search result",
    },
  );
  const byCanonicalUrl = new Map(sourcePack.sources.map((entry) => [entry.canonicalUrl, entry]));

  return {
    query,
    provider: context.searchProvider.name,
    networkMode: context.networkMode,
    rankingMode,
    filteredOut: Math.max(0, results.length - filtered.length),
    results: ranked.map((entry) => ({
      ...entry,
      sourceId: byCanonicalUrl.get(entry.canonicalUrl)?.sourceId ?? null,
    })),
    sourcePack: summarizeSourcePack(sourcePack),
    citations: sourcePack.citations,
  };
}

export async function fetchUrl(
  input: Record<string, unknown> | null | undefined,
  context: WebToolContext,
  executionContext: WebToolExecutionContext = {},
): Promise<FetchUrlResult> {
  const url = `${input?.url ?? ""}`.trim();
  if (!url) {
    throw new Error("fetch_url requires a URL.");
  }

  const access = ensureUrlAllowed(url, context, input?.query);
  await maybeCheckRobots(url, context, executionContext);
  const response = await fetchDocument(url, context, executionContext, "fetch");
  const extracted = safelyExtract(response, context.webMaxExtractChars);
  const sourcePack = await context.sourceRegistry.registerPack([
    {
      url,
      canonicalUrl: extracted?.canonicalUrl ?? response.meta.finalUrl ?? url,
      title: extracted?.title ?? response.meta.finalUrl ?? url,
      domain: extracted?.domain ?? access.metadata.domain,
      sourceKind: extracted ? "official-doc" : "unknown",
      trustLayer: access.official ? "official" : "community",
      official: access.official,
      provider: "direct-fetch",
      query: `${input?.query ?? ""}`.trim() || null,
      fetchedAt: new Date().toISOString(),
      excerpt: extracted?.excerpt ?? previewText(response.content, 280),
      cacheHit: response.meta.cacheHit,
      author: extracted?.author ?? null,
      publishedAt: extracted?.publishedAt ?? null,
      headings: extracted?.headings ?? [],
    },
  ], {
    toolName: "fetch_url",
    url,
    provider: "direct-fetch",
    reasonUsed: "fetched URL",
  });

  return {
    url,
    finalUrl: response.meta.finalUrl,
    contentType: response.meta.contentType,
    redirected: response.meta.redirected,
    cacheHit: response.meta.cacheHit,
    bodyPreview: previewText(response.content, context.maxOutputChars),
    extractedMeta: extracted
      ? {
          title: extracted.title,
          canonicalUrl: extracted.canonicalUrl,
          excerpt: extracted.excerpt,
          headings: extracted.headings,
        }
      : null,
    sourcePack: summarizeSourcePack(sourcePack),
    citations: sourcePack.citations,
  };
}

export async function extractContent(
  input: Record<string, unknown> | null | undefined,
  context: WebToolContext,
  executionContext: WebToolExecutionContext = {},
): Promise<ExtractContentResult> {
  const url = `${input?.url ?? ""}`.trim();
  if (!url) {
    throw new Error("extract_content requires a URL.");
  }

  const access = ensureUrlAllowed(url, context, input?.query);
  await maybeCheckRobots(url, context, executionContext);
  const response = await fetchDocument(url, context, executionContext, "extract");
  const extracted = extractContentFromDocument({
    url: response.meta.finalUrl || url,
    contentType: response.meta.contentType,
    body: response.content,
    maxChars: context.webMaxExtractChars,
  });
  const sourcePack = await context.sourceRegistry.registerPack([
    {
      url,
      canonicalUrl: extracted.canonicalUrl,
      title: extracted.title,
      domain: extracted.domain,
      sourceKind: access.official ? "official-doc" : "unknown",
      trustLayer: access.official ? "official" : "community",
      official: access.official,
      provider: "direct-fetch",
      query: `${input?.query ?? ""}`.trim() || null,
      fetchedAt: new Date().toISOString(),
      excerpt: extracted.excerpt,
      cacheHit: response.meta.cacheHit,
      author: extracted.author,
      publishedAt: extracted.publishedAt,
      headings: extracted.headings,
    },
  ], {
    toolName: "extract_content",
    url,
    provider: "direct-fetch",
    reasonUsed: "readable extraction",
  });

  return {
    url,
    finalUrl: response.meta.finalUrl,
    contentType: response.meta.contentType,
    cacheHit: response.meta.cacheHit,
    extracted,
    sourcePack: summarizeSourcePack(sourcePack),
    citations: sourcePack.citations,
    primaryCitation: sourcePack.citations[0] ?? null,
  };
}

async function fetchDocument(
  url: string,
  context: WebToolContext,
  executionContext: WebToolExecutionContext,
  requestType: "fetch" | "extract",
): Promise<WebFetchResponse> {
  return context.webRuntime.requestText({
    url,
    method: "GET",
    requestType,
    traceId: executionContext.traceId ?? null,
    onEvent: executionContext.onWebEvent,
    cacheNamespace: requestType === "extract" ? "fetch-extract" : "fetch-url",
    cacheKey: `${requestType}:${url}`,
    cacheTtlMs: context.webCacheTtlMs,
    allowContentTypes: FETCHABLE_CONTENT_TYPES,
  });
}

function ensureUrlAllowed(
  url: string,
  context: WebToolContext,
  query: unknown = null,
): UrlAccessDecision {
  const access = evaluateUrlAgainstNetworkMode(url, {
    networkMode: context.networkMode,
    allowDomains: context.webAllowDomains,
    denyDomains: context.webDenyDomains,
    query: `${query ?? ""}`.trim() || null,
  });
  if (!access.allowed) {
    throw createDomainBlockedError({
      url,
      domain: access.domain,
      networkMode: access.networkMode,
      reason: access.reason,
    });
  }
  return access;
}

async function maybeCheckRobots(
  url: string,
  context: WebToolContext,
  executionContext: WebToolExecutionContext,
): Promise<void> {
  const metadata = getUrlMetadata(url);
  if (!metadata.ok || !metadata.origin) {
    return;
  }

  const robotsUrl = new URL("/robots.txt", metadata.origin).toString();

  try {
    const response = await context.webRuntime.requestText({
      url: robotsUrl,
      method: "GET",
      requestType: "robots",
      traceId: executionContext.traceId ?? null,
      onEvent: executionContext.onWebEvent,
      cacheNamespace: "robots",
      cacheKey: robotsUrl,
      cacheTtlMs: 24 * 60 * 60 * 1000,
      allowContentTypes: ["text/plain"],
    });
    if (isBlockedByRobots(response.content, metadata.pathname)) {
      throw createRobotsBlockedError({ url });
    }
  } catch (error) {
    if (isRobotsBlockedError(error)) {
      throw error;
    }
    if (isNotFoundError(error)) {
      return;
    }
  }
}

function isBlockedByRobots(robotsText: string, pathname: string | null): boolean {
  const lines = `${robotsText ?? ""}`.split(/\r?\n/);
  let inWildcard = false;
  const disallowRules: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      inWildcard = value === "*";
      continue;
    }

    if (inWildcard && key === "disallow" && value) {
      disallowRules.push(value);
    }
  }

  return disallowRules.some((rule) => `${pathname ?? ""}`.startsWith(rule));
}

function safelyExtract(response: WebFetchResponse, maxChars: number): ExtractedContent | null {
  try {
    return extractContentFromDocument({
      url: response.meta.finalUrl,
      contentType: response.meta.contentType,
      body: response.content,
      maxChars,
    });
  } catch {
    return null;
  }
}

function summarizeSourcePack(sourcePack: SourcePackRegistrationResult): SourcePackSummary {
  return {
    packId: sourcePack.pack.id,
    sourceIds: sourcePack.pack.sourceIds,
    sources: sourcePack.sources,
  };
}

function previewText(text: string, maxChars = 1200): string {
  const normalized = `${text ?? ""}`.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 19)}\n...<preview truncated>`;
}

function normalizeCount(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(10, Math.max(1, Math.floor(parsed)));
}

function isRobotsBlockedError(error: unknown): error is { taxonomy: string } {
  return error != null && typeof error === "object" && "taxonomy" in error && error.taxonomy === "robots_blocked";
}

function isNotFoundError(error: unknown): error is { status?: number; message?: string } {
  return error != null &&
    typeof error === "object" &&
    (("status" in error && error.status === 404) ||
      ("message" in error && /404/.test(`${error.message ?? ""}`)));
}
