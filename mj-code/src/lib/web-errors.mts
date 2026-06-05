const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export type WebAttemptRecord = Record<string, unknown>;

interface WebErrorOptions {
  cause?: unknown;
  message?: string | null;
  taxonomy?: string;
  code?: string;
  status?: number | null;
  url?: string | null;
  method?: string;
  provider?: string | null;
  requestType?: string | null;
  traceId?: string | null;
  attempt?: number;
  retryable?: boolean;
  retryExhausted?: boolean;
  details?: Record<string, unknown> | null;
  attempts?: WebAttemptRecord[];
}

interface FetchTimeoutErrorOptions extends WebErrorOptions {
  timeoutMs?: number | null;
}

interface FetchTooLargeErrorOptions extends WebErrorOptions {
  maxBytes?: number | null;
  receivedBytes?: number | null;
}

interface UnsupportedContentTypeErrorOptions extends WebErrorOptions {
  contentType?: string | null;
  allowContentTypes?: string[];
}

interface DomainBlockedErrorOptions extends WebErrorOptions {
  reason?: string | null;
  domain?: string | null;
  networkMode?: string | null;
}

interface SearchProviderErrorOptions extends WebErrorOptions {
  unavailable?: boolean;
  message?: string | null;
  bodyPreview?: string | null;
}

interface WebCircuitOpenErrorOptions extends WebErrorOptions {
  message?: string | null;
  circuit?: unknown;
}

interface WebErrorDefaults extends Partial<WebErrorOptions> {
  timeoutMs?: number | null;
}

export interface SerializedWebError {
  name: string;
  message: string;
  taxonomy: string;
  code: string;
  status: number | null;
  url: string | null;
  method: string;
  provider: string | null;
  requestType: string | null;
  traceId: string | null;
  attempt: number;
  retryable: boolean;
  retryExhausted: boolean;
  details: Record<string, unknown> | null;
  attempts: WebAttemptRecord[];
}

export class WebError extends Error {
  taxonomy: string;
  code: string;
  status: number | null;
  url: string | null;
  method: string;
  provider: string | null;
  requestType: string | null;
  traceId: string | null;
  attempt: number;
  retryable: boolean;
  retryExhausted: boolean;
  details: Record<string, unknown> | null;
  attempts: WebAttemptRecord[];

  constructor(message: string, options: WebErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WebError";
    this.taxonomy = options.taxonomy ?? "network_error";
    this.code = options.code ?? "network_error";
    this.status = options.status ?? null;
    this.url = options.url ?? null;
    this.method = options.method ?? "GET";
    this.provider = options.provider ?? null;
    this.requestType = options.requestType ?? null;
    this.traceId = options.traceId ?? null;
    this.attempt = options.attempt ?? 1;
    this.retryable = options.retryable ?? false;
    this.retryExhausted = options.retryExhausted ?? false;
    this.details = options.details ?? null;
    this.attempts = Array.isArray(options.attempts) ? options.attempts : [];
  }
}

export function createFetchTimeoutError(options: FetchTimeoutErrorOptions = {}): WebError {
  return new WebError(
    `Web request timed out after ${options.timeoutMs}ms.`,
    {
      ...options,
      taxonomy: "fetch_timeout",
      code: "timeout",
      retryable: true,
      details: {
        timeoutMs: options.timeoutMs ?? null,
      },
    },
  );
}

export function createFetchTooLargeError(options: FetchTooLargeErrorOptions = {}): WebError {
  return new WebError(
    `Web response exceeded the limit of ${options.maxBytes} bytes.`,
    {
      ...options,
      taxonomy: "fetch_too_large",
      code: "too_large",
      retryable: false,
      details: {
        maxBytes: options.maxBytes ?? null,
        receivedBytes: options.receivedBytes ?? null,
      },
    },
  );
}

export function createUnsupportedContentTypeError(
  options: UnsupportedContentTypeErrorOptions = {},
): WebError {
  return new WebError(
    `Unsupported content type "${options.contentType ?? "unknown"}".`,
    {
      ...options,
      taxonomy: "fetch_unsupported_content_type",
      code: "unsupported_content_type",
      retryable: false,
      details: {
        contentType: options.contentType ?? null,
        allowContentTypes: options.allowContentTypes ?? [],
      },
    },
  );
}

export function createDomainBlockedError(options: DomainBlockedErrorOptions = {}): WebError {
  return new WebError(
    options.reason ?? `Domain "${options.domain ?? "unknown"}" is blocked.`,
    {
      ...options,
      taxonomy: "domain_blocked",
      code: "domain_blocked",
      retryable: false,
      details: {
        domain: options.domain ?? null,
        networkMode: options.networkMode ?? null,
      },
    },
  );
}

export function createRobotsBlockedError(options: WebErrorOptions = {}): WebError {
  return new WebError(
    `robots.txt blocks access to "${options.url ?? "unknown"}".`,
    {
      ...options,
      taxonomy: "robots_blocked",
      code: "robots_blocked",
      retryable: false,
    },
  );
}

export function createSearchProviderError(options: SearchProviderErrorOptions = {}): WebError {
  const taxonomy = options.unavailable ? "search_provider_unavailable" : "search_provider_error";
  return new WebError(
    options.message ?? `Search provider "${options.provider ?? "unknown"}" failed.`,
    {
      ...options,
      taxonomy,
      code: options.code ?? taxonomy,
      retryable: options.retryable ?? Boolean(options.status && RETRYABLE_STATUS_CODES.has(options.status)),
      details: {
        bodyPreview: abbreviate(options.bodyPreview),
        ...(options.details ?? {}),
      },
    },
  );
}

export function createWebCircuitOpenError(options: WebCircuitOpenErrorOptions = {}): WebError {
  return new WebError(
    options.message ?? `Web circuit is open for ${options.requestType ?? "request"}.`,
    {
      ...options,
      taxonomy: "network_circuit_open",
      code: "circuit_open",
      retryable: false,
      details: {
        circuit: options.circuit ?? null,
        ...(options.details ?? {}),
      },
    },
  );
}

export function createExtractionError(options: WebErrorOptions = {}): WebError {
  return new WebError(
    options.message ?? "Failed to extract readable content from the document.",
    {
      ...options,
      taxonomy: "extraction_error",
      code: options.code ?? "extraction_error",
      retryable: false,
      details: options.details ?? null,
    },
  );
}

export function normalizeWebError(error: unknown, defaults: WebErrorDefaults = {}): WebError {
  if (error instanceof WebError) {
    if (!error.traceId && defaults.traceId) {
      error.traceId = defaults.traceId;
    }
    if (!error.requestType && defaults.requestType) {
      error.requestType = defaults.requestType;
    }
    if (!error.url && defaults.url) {
      error.url = defaults.url;
    }
    if (!error.provider && defaults.provider) {
      error.provider = defaults.provider;
    }
    if (error.attempt == null && defaults.attempt != null) {
      error.attempt = defaults.attempt;
    }
    return error;
  }

  if (getErrorName(error) === "AbortError") {
    return createFetchTimeoutError({
      ...defaults,
      timeoutMs: defaults.timeoutMs ?? null,
      cause: error,
    });
  }

  const message = getErrorMessage(error).toLowerCase();
  const code = getErrorCode(error)?.toLowerCase() ?? "";
  const retryable =
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("reset") ||
    message.includes("socket") ||
    code === "econnreset" ||
    code === "eai_again" ||
    code === "etimedout";

  return new WebError(
    `Web request failed: ${getErrorMessage(error)}`,
    {
      ...defaults,
      taxonomy: message.includes("timeout") ? "fetch_timeout" : "network_error",
      code: code || "network_error",
      retryable,
      details: {
        message: getErrorMessage(error),
        code: getErrorCode(error),
        name: getErrorName(error),
      },
      cause: error,
    },
  );
}

export function finalizeWebError(error: unknown, attempts: WebAttemptRecord[] = []): WebError {
  const normalized = normalizeWebError(error);
  normalized.attempts = attempts;
  if (normalized.retryable && attempts.length > 0) {
    normalized.retryExhausted = true;
  }
  return normalized;
}

export function isRetryableWebError(error: unknown): boolean {
  return normalizeWebError(error).retryable === true;
}

export function serializeWebError(error: unknown): SerializedWebError {
  const normalized = normalizeWebError(error);
  return {
    name: normalized.name,
    message: normalized.message,
    taxonomy: normalized.taxonomy,
    code: normalized.code,
    status: normalized.status,
    url: normalized.url,
    method: normalized.method,
    provider: normalized.provider,
    requestType: normalized.requestType,
    traceId: normalized.traceId,
    attempt: normalized.attempt,
    retryable: normalized.retryable,
    retryExhausted: normalized.retryExhausted,
    details: normalized.details,
    attempts: normalized.attempts,
  };
}

function abbreviate(value: string | null | undefined, maxChars = 320): string | null {
  if (typeof value !== "string") {
    return value ?? null;
  }

  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function getErrorName(error: unknown): string | null {
  if (isRecord(error) && typeof error.name === "string") {
    return error.name;
  }
  return null;
}

function getErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return `${error ?? ""}`;
}

function getErrorCode(error: unknown): string | null {
  if (isRecord(error) && (typeof error.code === "string" || typeof error.code === "number")) {
    return `${error.code}`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
