const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

type ProviderAttemptRecord = Record<string, unknown>;

interface ProviderErrorOptions {
  cause?: unknown;
  provider?: string | null;
  taxonomy?: string;
  reasonTaxonomy?: string;
  code?: string;
  status?: number | null;
  requestType?: string | null;
  endpoint?: string | null;
  circuitState?: string | null;
  traceId?: string | null;
  attempt?: number;
  retryable?: boolean;
  retryExhausted?: boolean;
  attemptedModels?: string[];
  streamAttempt?: boolean;
  partialStream?: boolean;
  fallbackSuggested?: boolean;
  rawText?: string | null;
  details?: Record<string, unknown> | null;
  attempts?: ProviderAttemptRecord[];
}

interface ProviderHttpErrorInput {
  provider: string;
  status: number;
  rawText: string;
  requestType: string;
  endpoint?: string | null;
  traceId: string;
  attempt?: number;
  streamAttempt?: boolean;
}

interface ProviderTimeoutErrorInput {
  provider?: string | null;
  requestType?: string | null;
  endpoint?: string | null;
  traceId?: string | null;
  attempt?: number;
  timeoutMs: number;
  streamAttempt?: boolean;
  cause?: unknown;
}

interface ProviderNetworkErrorInput {
  provider?: string | null;
  requestType?: string | null;
  endpoint?: string | null;
  traceId?: string | null;
  attempt?: number;
  streamAttempt?: boolean;
  error: unknown;
}

interface ProviderCircuitOpenErrorInput {
  provider: string;
  requestType: string;
  endpoint?: string | null;
  traceId: string;
  circuit?: Record<string, unknown> | null;
}

interface ProviderErrorDefaults extends Partial<ProviderErrorOptions> {
  timeoutMs?: number | null;
}

export interface SerializedProviderError {
  name: string;
  message: string;
  provider: string | null;
  taxonomy: string;
  reasonTaxonomy: string;
  code: string;
  status: number | null;
  requestType: string | null;
  endpoint: string | null;
  circuitState: string | null;
  traceId: string | null;
  attempt: number;
  retryable: boolean;
  retryExhausted: boolean;
  attemptedModels: string[];
  streamAttempt: boolean;
  partialStream: boolean;
  fallbackSuggested: boolean;
  details: Record<string, unknown> | null;
  attempts: ProviderAttemptRecord[];
  rawText: string | null;
}

export class ProviderError extends Error {
  provider: string | null;
  taxonomy: string;
  reasonTaxonomy: string;
  code: string;
  status: number | null;
  requestType: string | null;
  endpoint: string | null;
  circuitState: string | null;
  traceId: string | null;
  attempt: number;
  retryable: boolean;
  retryExhausted: boolean;
  attemptedModels: string[];
  streamAttempt: boolean;
  partialStream: boolean;
  fallbackSuggested: boolean;
  rawText: string | null;
  details: Record<string, unknown> | null;
  attempts: ProviderAttemptRecord[];

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.provider = options.provider ?? null;
    this.taxonomy = options.taxonomy ?? "provider_error";
    this.reasonTaxonomy = options.reasonTaxonomy ?? this.taxonomy;
    this.code = options.code ?? "provider_error";
    this.status = options.status ?? null;
    this.requestType = options.requestType ?? null;
    this.endpoint = options.endpoint ?? null;
    this.circuitState = options.circuitState ?? null;
    this.traceId = options.traceId ?? null;
    this.attempt = options.attempt ?? 1;
    this.retryable = options.retryable ?? false;
    this.retryExhausted = options.retryExhausted ?? false;
    this.attemptedModels = Array.isArray(options.attemptedModels) ? options.attemptedModels : [];
    this.streamAttempt = options.streamAttempt ?? false;
    this.partialStream = options.partialStream ?? false;
    this.fallbackSuggested = options.fallbackSuggested ?? false;
    this.rawText = options.rawText ?? null;
    this.details = options.details ?? null;
    this.attempts = Array.isArray(options.attempts) ? options.attempts : [];
  }
}

export function createProviderHttpError({
  provider,
  status,
  rawText,
  requestType,
  endpoint = null,
  traceId,
  attempt = 1,
  streamAttempt = false,
}: ProviderHttpErrorInput): ProviderError {
  const taxonomy = status === 429
    ? "provider_rate_limit"
    : status === 408
      ? "provider_timeout"
      : "provider_error";
  const retryable = RETRYABLE_STATUSES.has(status) || status === 408;
  const fallbackSuggested = streamAttempt && (
    retryable ||
    status === 404 ||
    status === 405 ||
    status === 501 ||
    rawLooksLikeHtml(rawText) ||
    rawContainsMissingEndpoint(rawText)
  );

  return new ProviderError(
    status === 429
      ? `Provider rate limit (${status}).`
      : `Provider request failed (${status}).`,
    {
      provider,
      taxonomy,
      code: `http_${status}`,
      status,
      requestType,
      endpoint,
      traceId,
      attempt,
      retryable,
      streamAttempt,
      fallbackSuggested,
      rawText,
      details: {
        bodyPreview: abbreviateRaw(rawText),
      },
    },
  );
}

export function createProviderTimeoutError({
  provider,
  requestType,
  endpoint = null,
  traceId,
  attempt = 1,
  timeoutMs,
  streamAttempt = false,
  cause = null,
}: ProviderTimeoutErrorInput): ProviderError {
  return new ProviderError(
    `Provider request timed out after ${timeoutMs}ms.`,
    {
      provider,
      taxonomy: "provider_timeout",
      code: "timeout",
      requestType,
      endpoint,
      traceId,
      attempt,
      retryable: true,
      streamAttempt,
      fallbackSuggested: streamAttempt,
      details: timeoutMs ? { timeoutMs } : null,
      cause,
    },
  );
}

export function createProviderNetworkError({
  provider,
  requestType,
  endpoint = null,
  traceId,
  attempt = 1,
  streamAttempt = false,
  error,
}: ProviderNetworkErrorInput): ProviderError {
  const message = getErrorMessage(error).toLowerCase();
  const code = getErrorCode(error)?.toLowerCase() ?? "";
  const isTimeout =
    getErrorName(error) === "AbortError" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    code === "etimedout";
  const retryable =
    isTimeout ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("reset") ||
    message.includes("aborted") ||
    message.includes("terminated") ||
    code === "econnreset" ||
    code === "ecconnreset" ||
    code === "eai_again" ||
    code === "econnrefused";
  const rawMessage = getErrorMessage(error);
  const rawCode = getErrorCode(error);
  const rawName = getErrorName(error);

  return new ProviderError(
    isTimeout ? "Provider request timed out." : `Provider network failure: ${rawMessage}`,
    {
      provider,
      taxonomy: isTimeout ? "provider_timeout" : "provider_error",
      code: isTimeout ? "timeout" : rawCode || "network_error",
      requestType,
      endpoint,
      traceId,
      attempt,
      retryable,
      streamAttempt,
      fallbackSuggested: streamAttempt && retryable,
      details: {
        message: rawMessage,
        code: rawCode,
        name: rawName,
      },
      cause: error,
    },
  );
}

export function normalizeProviderError(
  error: unknown,
  defaults: ProviderErrorDefaults = {},
): ProviderError {
  if (error instanceof ProviderError) {
    if (defaults.attempt != null && error.attempt == null) {
      error.attempt = defaults.attempt;
    }
    if (defaults.traceId && !error.traceId) {
      error.traceId = defaults.traceId;
    }
    if (defaults.requestType && !error.requestType) {
      error.requestType = defaults.requestType;
    }
    if (defaults.provider && !error.provider) {
      error.provider = defaults.provider;
    }
    if (defaults.endpoint && !error.endpoint) {
      error.endpoint = defaults.endpoint;
    }
    return error;
  }

  if (getErrorName(error) === "AbortError") {
    return createProviderTimeoutError({
      ...defaults,
      timeoutMs: defaults.timeoutMs ?? 0,
      cause: error,
    });
  }

  return createProviderNetworkError({
    ...defaults,
    error,
  });
}

export function createProviderCircuitOpenError({
  provider,
  requestType,
  endpoint = null,
  traceId,
  circuit,
}: ProviderCircuitOpenErrorInput): ProviderError {
  return new ProviderError(
    `Provider circuit is open for ${provider}:${requestType}.`,
    {
      provider,
      taxonomy: "provider_circuit_open",
      reasonTaxonomy: "provider_retry_exhausted",
      code: "circuit_open",
      requestType,
      endpoint,
      traceId,
      attempt: 0,
      retryable: false,
      circuitState: getCircuitState(circuit),
      details: {
        circuit: circuit ?? null,
      },
    },
  );
}

export function finalizeProviderError(
  error: unknown,
  attempts: ProviderAttemptRecord[],
): ProviderError {
  const normalized = normalizeProviderError(error);
  normalized.attempts = attempts;
  if (normalized.retryable && attempts.length > 0) {
    normalized.retryExhausted = true;
    normalized.reasonTaxonomy = normalized.taxonomy;
    normalized.taxonomy = "provider_retry_exhausted";
  }
  return normalized;
}

export function isRetryableProviderError(error: unknown): boolean {
  const normalized = normalizeProviderError(error);
  return normalized.retryable === true;
}

export function shouldFallbackFromStreamError(error: unknown): boolean {
  const normalized = normalizeProviderError(error);
  return normalized.streamAttempt === true &&
    normalized.partialStream !== true &&
    normalized.fallbackSuggested === true;
}

export function serializeProviderError(error: unknown): SerializedProviderError {
  const normalized = normalizeProviderError(error);
  return {
    name: normalized.name,
    message: normalized.message,
    provider: normalized.provider,
    taxonomy: normalized.taxonomy,
    reasonTaxonomy: normalized.reasonTaxonomy,
    code: normalized.code,
    status: normalized.status,
    requestType: normalized.requestType,
    endpoint: normalized.endpoint,
    circuitState: normalized.circuitState,
    traceId: normalized.traceId,
    attempt: normalized.attempt,
    retryable: normalized.retryable,
    retryExhausted: normalized.retryExhausted,
    attemptedModels: normalized.attemptedModels,
    streamAttempt: normalized.streamAttempt,
    partialStream: normalized.partialStream,
    fallbackSuggested: normalized.fallbackSuggested,
    details: normalized.details,
    attempts: normalized.attempts,
    rawText: abbreviateRaw(normalized.rawText),
  };
}

function rawLooksLikeHtml(rawText: string | null | undefined): boolean {
  const normalized = `${rawText ?? ""}`.trim().toLowerCase();
  return normalized.startsWith("<!doctype html") || normalized.startsWith("<html");
}

function rawContainsMissingEndpoint(rawText: string | null | undefined): boolean {
  const normalized = `${rawText ?? ""}`.toLowerCase();
  return normalized.includes("not found") || normalized.includes("method not allowed");
}

function abbreviateRaw(rawText: string | null | undefined): string | null {
  if (typeof rawText !== "string") {
    return rawText ?? null;
  }

  return rawText.length <= 400 ? rawText : `${rawText.slice(0, 397)}...`;
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

function getCircuitState(circuit: Record<string, unknown> | null | undefined): string {
  if (isRecord(circuit) && typeof circuit.state === "string") {
    return circuit.state;
  }
  return "open";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
