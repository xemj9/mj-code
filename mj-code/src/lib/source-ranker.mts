import {
  canonicalizeUrl,
  getUrlMetadata,
  isDomainAllowed,
  isOfficialLikeUrl,
  normalizeDomain,
} from "./web-policy.mjs";

import type {
  RankingMode,
  RankedSourceResult,
  SourceClassification,
  SourceKind,
  SourceScoreBreakdown,
  WebSearchProviderResultRow,
} from "../types/contracts.js";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "your",
  "about",
  "what",
  "when",
  "where",
  "how",
  "why",
  "can",
  "use",
  "using",
  "guide",
]);

type RankedTrustKind =
  | "official-api"
  | "official-doc"
  | "official-blog"
  | "release-notes"
  | "source-code"
  | "issue"
  | "community-forum"
  | "blog"
  | "unknown";

const TRUST_GRAPH_WEIGHTS: Record<RankedTrustKind, number> = {
  "official-api": 34,
  "official-doc": 32,
  "official-blog": 24,
  "release-notes": 22,
  "source-code": 20,
  issue: 12,
  "community-forum": 6,
  blog: 8,
  unknown: 0,
};

const MIRROR_HOST_PATTERNS = [
  /readthedocs\.io$/,
  /mirror/i,
  /translation/i,
  /aggregator/i,
];

const SPAMMY_PATH_PATTERNS = [
  /\/amp\//,
  /\/tag\//,
  /\/category\//,
  /utm_/,
];

export function rankSources(
  results: ReadonlyArray<WebSearchProviderResultRow>,
  options: {
    query?: string | null;
    mode?: RankingMode | string | null;
    allowDomains?: string[] | null;
  } = {},
): RankedSourceResult[] {
  const query = `${options.query ?? ""}`.trim();
  const mode = normalizeRankingMode(options.mode);
  const allowDomains = Array.isArray(options.allowDomains) ? options.allowDomains : [];
  const collapsed = collapseDuplicateResults(results);
  const ranked = collapsed.map((entry) => scoreResult(entry, { query, mode, allowDomains }));

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.url.localeCompare(right.url);
  });

  return ranked.map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));
}

export function classifySource(
  url: string,
  title: string = "",
  snippet: string = "",
  query: string = "",
): SourceClassification {
  const metadata = getUrlMetadata(url);
  const domain = metadata.ok ? metadata.domain : normalizeDomain(url);
  const pathname = metadata.ok ? metadata.pathname : "";
  const lowerTitle = `${title}`.toLowerCase();
  const lowerSnippet = `${snippet}`.toLowerCase();
  const official = isOfficialLikeUrl(url, { query });

  if (domain === "github.com" || domain === "www.github.com") {
    if (/\/releases?(?:\/|$)/.test(pathname ?? "")) {
      return { sourceKind: "release-notes", official: true, trustLayer: "release" };
    }
    if (/\/issues?(?:\/|$)|\/discussions?(?:\/|$)/.test(pathname ?? "")) {
      return { sourceKind: "issue", official: true, trustLayer: "issues" };
    }
    return { sourceKind: "source-code", official: true, trustLayer: "repos" };
  }

  if (official && /blog/.test(`${domain ?? ""}${pathname ?? ""}`)) {
    return { sourceKind: "official-blog", official: true, trustLayer: "official" };
  }

  if (official && /api|reference/.test(`${domain ?? ""}${pathname ?? ""}`)) {
    return { sourceKind: "official-api", official: true, trustLayer: "official" };
  }

  if (official && /docs|guide|manual|help|support|developer|platform/.test(`${domain ?? ""}${pathname ?? ""}${lowerTitle}`)) {
    return { sourceKind: "official-doc", official: true, trustLayer: "official" };
  }

  if (/release|changelog/.test(`${pathname ?? ""}${lowerTitle}${lowerSnippet}`)) {
    return {
      sourceKind: "release-notes",
      official,
      trustLayer: official ? "release" : "community",
    };
  }

  if (/issue|discussion|bug|pull request/.test(`${pathname ?? ""}${lowerTitle}${lowerSnippet}`)) {
    return {
      sourceKind: "issue",
      official,
      trustLayer: official ? "issues" : "community",
    };
  }

  if (/forum|community|reddit|stack/.test(`${domain ?? ""}${pathname ?? ""}${lowerTitle}`)) {
    return { sourceKind: "community-forum", official: false, trustLayer: "community" };
  }

  if (/blog|post|article/.test(`${domain ?? ""}${pathname ?? ""}${lowerTitle}`)) {
    return {
      sourceKind: official ? "official-blog" : "blog",
      official,
      trustLayer: official ? "official" : "community",
    };
  }

  return {
    sourceKind: official ? "official-doc" : "unknown",
    official,
    trustLayer: official ? "official" : "community",
  };
}

export function normalizeRankingMode(value: unknown): RankingMode {
  const normalized = `${value ?? "balanced"}`.trim().toLowerCase();
  if (normalized === "balanced" || normalized === "docs-first" || normalized === "official-first") {
    return normalized;
  }
  return "balanced";
}

function scoreResult(
  result: WebSearchProviderResultRow,
  input: {
    query: string;
    mode: RankingMode;
    allowDomains: string[];
  },
): RankedSourceResult {
  const title = `${result.title ?? ""}`;
  const snippet = `${result.snippet ?? ""}`;
  const canonicalUrl = canonicalizeUrl(result.canonicalUrl || result.url);
  const metadata = getUrlMetadata(canonicalUrl);
  const domain = metadata.ok ? metadata.domain : normalizeDomain(canonicalUrl);
  const classification = classifySource(canonicalUrl, title, snippet, input.query);
  const titleOverlap = tokenOverlap(input.query, title);
  const snippetOverlap = tokenOverlap(input.query, snippet);
  const urlOverlap = tokenOverlap(
    input.query,
    canonicalUrl.replace(/https?:\/\//, "").replace(/[/?#._-]+/g, " "),
  );
  const docsHint = countPatternMatches(metadata.ok ? metadata.pathname : canonicalUrl, [
    /docs/i,
    /reference/i,
    /api/i,
    /guide/i,
    /release/i,
    /changelog/i,
  ]);
  const freshnessScore = scoreFreshness(result.publishedAt);
  const allowlistBonus = isDomainAllowed(domain, input.allowDomains) ? 18 : 0;
  const mirrorPenalty = MIRROR_HOST_PATTERNS.some((pattern) => pattern.test(domain ?? "")) ? -12 : 0;
  const spamPenalty = SPAMMY_PATH_PATTERNS.some((pattern) => pattern.test(canonicalUrl)) ? -8 : 0;
  const official = result.official ?? classification.official;
  const sourceKind = result.sourceKind ?? classification.sourceKind;
  const trustLayer = result.trustLayer ?? classification.trustLayer;
  const officialBonus = official ? 12 : 0;
  const trustBase = TRUST_GRAPH_WEIGHTS[toRankedTrustKind(sourceKind)] ?? 0;
  const modeBonus = scoreModeBonus(input.mode, {
    sourceKind,
    official,
    trustLayer,
  });

  const scoreBreakdownWithoutTotal: Omit<SourceScoreBreakdown, "total"> = {
    trustGraph: trustBase,
    officialness: officialBonus,
    queryTitleOverlap: titleOverlap * 6,
    querySnippetOverlap: snippetOverlap * 3,
    queryUrlOverlap: urlOverlap * 2,
    docsHint: Math.min(12, docsHint * 4),
    freshness: freshnessScore,
    allowlistBonus,
    mirrorPenalty,
    spamPenalty,
    modeBonus,
  };
  const total = Object.values(scoreBreakdownWithoutTotal).reduce((sum, value) => sum + value, 0);
  const scoreBreakdown: SourceScoreBreakdown = {
    ...scoreBreakdownWithoutTotal,
    total,
  };

  return {
    ...result,
    url: canonicalUrl,
    canonicalUrl,
    domain: domain ?? normalizeDomain(canonicalUrl),
    sourceKind,
    official,
    trustLayer,
    score: total,
    scoreBreakdown,
    rank: 0,
  };
}

function collapseDuplicateResults(
  results: ReadonlyArray<WebSearchProviderResultRow>,
): WebSearchProviderResultRow[] {
  const seen = new Map<string, WebSearchProviderResultRow>();
  for (const result of results ?? []) {
    if (!result?.url) {
      continue;
    }
    const canonicalUrl = canonicalizeUrl(result.canonicalUrl || result.url);
    const candidate: WebSearchProviderResultRow = {
      ...result,
      url: canonicalUrl,
      canonicalUrl,
    };
    const existing = seen.get(canonicalUrl);
    if (!existing) {
      seen.set(canonicalUrl, candidate);
      continue;
    }

    if ((candidate.title ?? "").length > (existing.title ?? "").length) {
      seen.set(canonicalUrl, {
        ...existing,
        ...candidate,
      });
    }
  }

  return [...seen.values()];
}

function tokenOverlap(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const textTokens = new Set(tokenize(text));
  return queryTokens.filter((token) => textTokens.has(token)).length;
}

function tokenize(value: string): string[] {
  return `${value ?? ""}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((entry) => entry.length >= 3 && !STOP_WORDS.has(entry));
}

function countPatternMatches(value: string | null, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(`${value ?? ""}`) ? 1 : 0), 0);
}

function scoreFreshness(publishedAt: string | null): number {
  if (!publishedAt) {
    return 0;
  }

  const timestamp = new Date(publishedAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  const ageDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  if (ageDays <= 30) {
    return 10;
  }
  if (ageDays <= 180) {
    return 6;
  }
  if (ageDays <= 365) {
    return 3;
  }
  return 0;
}

function scoreModeBonus(mode: RankingMode, classification: SourceClassification): number {
  if (mode === "docs-first") {
    if (classification.sourceKind === "official-api" || classification.sourceKind === "official-doc") {
      return 16;
    }
    if (classification.sourceKind === "source-code" || classification.sourceKind === "release-notes") {
      return 8;
    }
  }

  if (mode === "official-first") {
    return classification.official ? 16 : -4;
  }

  return 0;
}

function toRankedTrustKind(value: SourceKind): RankedTrustKind {
  switch (value) {
    case "official-api":
      return "official-api";
    case "official-doc":
      return "official-doc";
    case "official-blog":
      return "official-blog";
    case "release-notes":
      return "release-notes";
    case "source-code":
      return "source-code";
    case "issue":
      return "issue";
    case "community-forum":
      return "community-forum";
    case "blog":
      return "blog";
    default:
      return "unknown";
  }
}
