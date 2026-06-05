import type {
  NetworkInputSummary,
  NetworkMode,
  UrlAccessDecision,
  UrlMetadata,
  WebSearchProviderName,
} from "../types/contracts.js";

const TRACKING_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "ref",
  "ref_src",
  "source",
  "s",
]);

const DOCS_ONLY_HOST_PATTERNS = [
  /^docs\./,
  /^doc\./,
  /^developer\./,
  /^developers\./,
  /^api\./,
  /^platform\./,
  /^help\./,
  /^support\./,
];

const DOCS_ONLY_PATH_PATTERNS = [
  /\/docs?(?:\/|$)/,
  /\/reference(?:\/|$)/,
  /\/api(?:\/|$)/,
  /\/api-reference(?:\/|$)/,
  /\/sdk(?:\/|$)/,
  /\/manual(?:\/|$)/,
  /\/guide(?:\/|$)/,
  /\/guides(?:\/|$)/,
  /\/release(?:\/|$)/,
  /\/releases(?:\/|$)/,
  /\/changelog(?:\/|$)/,
  /\/blog(?:\/|$)/,
  /\/issues?(?:\/|$)/,
  /\/discussions?(?:\/|$)/,
];

const COMMUNITY_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "stackoverflow.com",
  "stackexchange.com",
  "medium.com",
  "dev.to",
  "news.ycombinator.com",
]);

const SOURCE_CODE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
]);

const RELEASE_HOSTS = new Set([
  "github.com",
  "www.github.com",
]);

interface WebPolicyOptions {
  networkMode?: NetworkMode | string | null;
  allowDomains?: string[] | string | null;
  denyDomains?: string[] | string | null;
  query?: string | null;
  webProvider?: string | null;
}

interface DocsOnlyAllowance {
  allowed: boolean;
  reason: string | null;
  matchedAllowDomain: string | null;
  matchedDenyDomain: string | null;
}

export function normalizeNetworkMode(value: unknown): NetworkMode {
  if (value == null) {
    return "docs-only";
  }

  const normalized = `${value}`.trim().toLowerCase();
  if (normalized === "off" || normalized === "docs-only" || normalized === "open-web") {
    return normalized;
  }

  throw new Error(`Unsupported network mode "${value}".`);
}

export function normalizeDomainList(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => normalizeDomain(entry)).filter(Boolean))];
  }

  if (typeof value === "string") {
    return [...new Set(
      value
        .split(/[,\s]+/)
        .map((entry) => normalizeDomain(entry))
        .filter(Boolean),
    )];
  }

  return [];
}

export function normalizeDomain(value: unknown): string {
  const raw = `${value ?? ""}`.trim().toLowerCase();
  if (!raw) {
    return "";
  }

  return raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^\.*/, "")
    .replace(/\/.*$/, "");
}

export function getUrlMetadata(rawUrl: unknown): UrlMetadata {
  const input = `${rawUrl ?? ""}`.trim();
  try {
    const url = new URL(input);
    return {
      ok: true,
      input,
      href: url.toString(),
      origin: url.origin,
      domain: normalizeDomain(url.hostname),
      pathname: url.pathname || "/",
      protocol: url.protocol,
      error: null,
    };
  } catch {
    return {
      ok: false,
      input,
      href: null,
      origin: null,
      domain: null,
      pathname: null,
      protocol: null,
      error: `Invalid URL "${rawUrl}".`,
    };
  }
}

export function canonicalizeUrl(rawUrl: unknown): string {
  const metadata = getUrlMetadata(rawUrl);
  if (!metadata.ok || !metadata.href) {
    return `${rawUrl ?? ""}`;
  }

  const url = new URL(metadata.href);
  url.hash = "";

  const nextSearchParams = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      continue;
    }
    nextSearchParams.append(key, value);
  }

  const normalizedEntries = [...nextSearchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  url.search = "";
  for (const [key, value] of normalizedEntries) {
    url.searchParams.append(key, value);
  }
  return url.toString();
}

export function matchesDomainRule(domain: unknown, rule: unknown): boolean {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedRule = normalizeDomain(rule);
  if (!normalizedDomain || !normalizedRule) {
    return false;
  }

  return normalizedDomain === normalizedRule || normalizedDomain.endsWith(`.${normalizedRule}`);
}

export function isDomainAllowed(domain: unknown, allowDomains: string[] = []): boolean {
  return findMatchingDomainRule(domain, allowDomains) !== null;
}

export function isDomainDenied(domain: unknown, denyDomains: string[] = []): boolean {
  return findMatchingDomainRule(domain, denyDomains) !== null;
}

export function isOfficialLikeUrl(
  rawUrl: unknown,
  { allowDomains = [], query = "" }: { allowDomains?: string[] | string | null; query?: string | null } = {},
): boolean {
  const metadata = getUrlMetadata(rawUrl);
  if (!metadata.ok || !metadata.domain || !metadata.pathname) {
    return false;
  }

  const normalizedAllowDomains = normalizeDomainList(allowDomains);
  const { domain, pathname } = metadata;
  if (findMatchingDomainRule(domain, normalizedAllowDomains)) {
    return true;
  }

  if (COMMUNITY_HOSTS.has(domain)) {
    return false;
  }

  const hostLooksOfficial = DOCS_ONLY_HOST_PATTERNS.some((pattern) => pattern.test(domain));
  const pathLooksOfficial = DOCS_ONLY_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
  const queryTokens = tokenizeQuery(query);
  const domainTokens = domain.split(/[.\-]/).filter(Boolean);
  const queryOverlap = queryTokens.filter((token) => domainTokens.includes(token)).length;

  return hostLooksOfficial || (pathLooksOfficial && queryOverlap > 0);
}

export function isDocsOnlyUrlAllowed(
  rawUrl: unknown,
  options: Omit<WebPolicyOptions, "networkMode" | "query" | "webProvider"> = {},
): boolean {
  const normalized = normalizeWebPolicyOptions(options);
  return evaluateDocsOnlyAllowance(getUrlMetadata(rawUrl), normalized).allowed;
}

export function evaluateUrlAgainstNetworkMode(
  rawUrl: unknown,
  options: WebPolicyOptions = {},
): UrlAccessDecision {
  const normalized = normalizeWebPolicyOptions(options);
  const metadata = getUrlMetadata(rawUrl);

  if (!metadata.ok) {
    return {
      allowed: false,
      reason: metadata.error,
      domain: null,
      official: false,
      networkMode: normalized.networkMode,
      metadata,
      matchedAllowDomain: null,
      matchedDenyDomain: null,
      docsOnlyAllowed: false,
    };
  }

  if (!metadata.protocol || !["http:", "https:"].includes(metadata.protocol)) {
    return {
      allowed: false,
      reason: `Unsupported URL protocol "${metadata.protocol}".`,
      domain: metadata.domain,
      official: false,
      networkMode: normalized.networkMode,
      metadata,
      matchedAllowDomain: null,
      matchedDenyDomain: null,
      docsOnlyAllowed: false,
    };
  }

  const docsOnlyAllowance = evaluateDocsOnlyAllowance(metadata, normalized);

  if (docsOnlyAllowance.matchedDenyDomain) {
    return {
      allowed: false,
      reason: docsOnlyAllowance.reason,
      domain: metadata.domain,
      official: false,
      networkMode: normalized.networkMode,
      metadata,
      matchedAllowDomain: docsOnlyAllowance.matchedAllowDomain,
      matchedDenyDomain: docsOnlyAllowance.matchedDenyDomain,
      docsOnlyAllowed: false,
    };
  }

  if (normalized.networkMode === "off") {
    return {
      allowed: false,
      reason: "Network mode is off.",
      domain: metadata.domain,
      official: false,
      networkMode: normalized.networkMode,
      metadata,
      matchedAllowDomain: docsOnlyAllowance.matchedAllowDomain,
      matchedDenyDomain: docsOnlyAllowance.matchedDenyDomain,
      docsOnlyAllowed: docsOnlyAllowance.allowed,
    };
  }

  if (normalized.networkMode === "docs-only" && !docsOnlyAllowance.allowed) {
    return {
      allowed: false,
      reason: docsOnlyAllowance.reason ?? `URL "${rawUrl}" is not permitted in docs-only mode.`,
      domain: metadata.domain,
      official: false,
      networkMode: normalized.networkMode,
      metadata,
      matchedAllowDomain: docsOnlyAllowance.matchedAllowDomain,
      matchedDenyDomain: docsOnlyAllowance.matchedDenyDomain,
      docsOnlyAllowed: false,
    };
  }

  return {
    allowed: true,
    reason: null,
    domain: metadata.domain,
    official: isOfficialLikeUrl(rawUrl, {
      allowDomains: normalized.allowDomains,
      query: normalized.query,
    }),
    networkMode: normalized.networkMode,
    metadata,
    matchedAllowDomain: docsOnlyAllowance.matchedAllowDomain,
    matchedDenyDomain: docsOnlyAllowance.matchedDenyDomain,
    docsOnlyAllowed: docsOnlyAllowance.allowed,
  };
}

export function filterSearchResultsForNetworkMode<T extends { url?: unknown; query?: unknown }>(
  results: T[],
  options: WebPolicyOptions = {},
): T[] {
  return results.filter((entry) => {
    if (!entry?.url) {
      return false;
    }
    return evaluateUrlAgainstNetworkMode(entry.url, {
      networkMode: options.networkMode,
      allowDomains: options.allowDomains,
      denyDomains: options.denyDomains,
      query: `${entry.query ?? options.query ?? ""}`,
    }).allowed;
  });
}

export function summarizeNetworkInput(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  options: WebPolicyOptions = {},
): NetworkInputSummary {
  const normalized = normalizeWebPolicyOptions(options);

  if (toolName === "web_search") {
    return {
      kind: "search",
      query: `${input?.query ?? ""}`.trim(),
      provider: normalized.webProvider,
      networkMode: normalized.networkMode,
      domain: null,
      official: false,
      url: null,
      decision: null,
    };
  }

  const rawUrl = `${input?.url ?? ""}`.trim();
  const decision = evaluateUrlAgainstNetworkMode(rawUrl, {
    networkMode: normalized.networkMode,
    allowDomains: normalized.allowDomains,
    denyDomains: normalized.denyDomains,
    query: normalized.query,
    webProvider: normalized.webProvider,
  });
  return {
    kind: "fetch",
    query: null,
    provider: normalized.webProvider,
    networkMode: decision.networkMode,
    domain: decision.domain,
    official: decision.official,
    url: rawUrl,
    decision,
  };
}

function findMatchingDomainRule(domain: unknown, rules: string[]): string | null {
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (matchesDomainRule(domain, rule)) {
      return normalizeDomain(rule);
    }
  }
  return null;
}

function evaluateDocsOnlyAllowance(
  metadata: UrlMetadata,
  options: ReturnType<typeof normalizeWebPolicyOptions>,
): DocsOnlyAllowance {
  if (!metadata.ok || !metadata.domain || !metadata.pathname) {
    return {
      allowed: false,
      reason: metadata.error ?? `Invalid URL "${metadata.input}".`,
      matchedAllowDomain: null,
      matchedDenyDomain: null,
    };
  }

  if (!metadata.protocol || !["http:", "https:"].includes(metadata.protocol)) {
    return {
      allowed: false,
      reason: `Unsupported URL protocol "${metadata.protocol}".`,
      matchedAllowDomain: null,
      matchedDenyDomain: null,
    };
  }

  const matchedDenyDomain = findMatchingDomainRule(metadata.domain, options.denyDomains);
  if (matchedDenyDomain) {
    return {
      allowed: false,
      reason: `Domain "${metadata.domain}" is blocked by the deny list.`,
      matchedAllowDomain: null,
      matchedDenyDomain,
    };
  }

  const matchedAllowDomain = findMatchingDomainRule(metadata.domain, options.allowDomains);
  if (matchedAllowDomain) {
    return {
      allowed: true,
      reason: null,
      matchedAllowDomain,
      matchedDenyDomain: null,
    };
  }

  if (SOURCE_CODE_HOSTS.has(metadata.domain) || RELEASE_HOSTS.has(metadata.domain)) {
    return {
      allowed: true,
      reason: null,
      matchedAllowDomain: null,
      matchedDenyDomain: null,
    };
  }

  if (COMMUNITY_HOSTS.has(metadata.domain)) {
    return {
      allowed: false,
      reason: `URL "${metadata.href ?? metadata.input}" is not permitted in docs-only mode.`,
      matchedAllowDomain: null,
      matchedDenyDomain: null,
    };
  }

  const { domain, pathname } = metadata;

  if (domain && DOCS_ONLY_HOST_PATTERNS.some((pattern) => pattern.test(domain))) {
    return {
      allowed: true,
      reason: null,
      matchedAllowDomain: null,
      matchedDenyDomain: null,
    };
  }

  if (pathname && DOCS_ONLY_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return {
      allowed: true,
      reason: null,
      matchedAllowDomain: null,
      matchedDenyDomain: null,
    };
  }

  return {
    allowed: false,
    reason: `URL "${metadata.href ?? metadata.input}" is not permitted in docs-only mode.`,
    matchedAllowDomain: null,
    matchedDenyDomain: null,
  };
}

function normalizeWebPolicyOptions(options: WebPolicyOptions = {}) {
  return {
    networkMode: normalizeNetworkMode(options.networkMode),
    allowDomains: normalizeDomainList(options.allowDomains),
    denyDomains: normalizeDomainList(options.denyDomains),
    query: `${options.query ?? ""}`,
    webProvider: normalizeWebProviderName(options.webProvider),
  };
}

function normalizeWebProviderName(value: unknown): WebSearchProviderName | null {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (normalized === "fallback" || normalized === "brave") {
    return normalized;
  }
  return null;
}

function tokenizeQuery(query: unknown): string[] {
  return `${query ?? ""}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((entry) => entry.length >= 3);
}
