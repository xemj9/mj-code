import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

import {
  createProviderCircuitOpenError,
  createProviderHttpError,
  createProviderTimeoutError,
  finalizeProviderError,
  isRetryableProviderError,
  normalizeProviderError,
  serializeProviderError,
} from "./provider-errors.mjs";

type ProviderRequestType =
  | "models_list"
  | "non_stream_completion"
  | "stream_completion"
  | "tool_completion"
  | string;

type ProviderRequestClass =
  | "models"
  | "completion_non_stream"
  | "completion_stream"
  | "tool_calling_completion"
  | string;

type RuntimeEvent = Record<string, unknown>;
type RuntimeEventHandler = (event: RuntimeEvent) => Promise<void> | void;
type RequestHeaders = RequestInit["headers"];
type RequestBody = Exclude<RequestInit["body"], undefined>;

interface ProviderPolicy {
  timeoutMs: number;
  maxRetries: number;
  retryBudgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

type ProviderAttemptRecord = Record<string, unknown> & {
  attempt: number;
  durationMs: number;
  ok: boolean;
  status: number | null;
  streamAttempt: boolean;
  retryable?: boolean;
  taxonomy?: string;
  code?: string;
  delayMs?: number;
};

interface ProviderRuntimeConfig {
  provider?: string | null;
  providerTimeoutMs?: number | null;
  providerMaxRetries?: number | null;
  providerRetryBudgetMs?: number | null;
}

interface ProviderRequestGate {
  allowed?: boolean;
  circuit?: unknown;
  events?: RuntimeEvent[];
}

interface ProviderOutcomeResult {
  circuit?: unknown;
  events?: RuntimeEvent[];
}

interface ProviderRuntimeHealth {
  beforeProviderRequest?(input: {
    provider: string;
    requestType: ProviderRequestType;
    endpoint: string | null;
    traceId: string;
  }): Promise<ProviderRequestGate | null | undefined> | ProviderRequestGate | null | undefined;
  noteProviderOutcome?(input: {
    provider: string;
    requestType: ProviderRequestType;
    endpoint: string | null;
    success: boolean;
    totalDurationMs: number;
    error?: unknown;
  }): Promise<ProviderOutcomeResult | null | undefined> | ProviderOutcomeResult | null | undefined;
  noteProviderRetry?(input: {
    provider: string;
    requestType: ProviderRequestType;
    endpoint: string | null;
    delayMs: number;
  }): Promise<void> | void;
}

interface ProviderRuntimeOptions {
  providerName?: string | null;
  runtimeHealth?: ProviderRuntimeHealth | null;
}

interface ProviderResponsePayload {
  response?: Response;
}

interface ProviderRequestMeta {
  provider: string;
  requestType: ProviderRequestType;
  requestClass: ProviderRequestClass;
  endpoint: string | null;
  traceId: string;
  attemptCount: number;
  attempts: ProviderAttemptRecord[];
  policy: ProviderPolicy;
  fallbackUsed: boolean;
  streamAttempt: boolean;
  circuit: unknown;
}

interface ExecuteRequestOptions<TResult extends ProviderResponsePayload> {
  requestType: ProviderRequestType;
  traceId?: string | null;
  streamAttempt?: boolean;
  onEvent?: RuntimeEventHandler | null;
  endpoint?: string | null;
  operation: (input: {
    attempt: number;
    timeoutMs: number;
    traceId: string;
    streamAttempt: boolean;
  }) => Promise<TResult>;
}

interface ProviderTextRequestOptions {
  url: string;
  method?: string;
  headers?: RequestHeaders;
  body?: RequestBody | null;
  requestType?: ProviderRequestType;
  traceId?: string | null;
  streamAttempt?: boolean;
  onEvent?: RuntimeEventHandler | null;
}

interface ProviderStreamRequestOptions {
  url: string;
  method?: string;
  headers?: RequestHeaders;
  body?: RequestBody | null;
  requestType?: ProviderRequestType;
  traceId?: string | null;
  onEvent?: RuntimeEventHandler | null;
}

const REQUEST_POLICIES: Record<string, ProviderPolicy> = {
  models_list: {
    timeoutMs: 12000,
    maxRetries: 2,
    retryBudgetMs: 12000,
    baseDelayMs: 250,
    maxDelayMs: 1500,
  },
  non_stream_completion: {
    timeoutMs: 45000,
    maxRetries: 2,
    retryBudgetMs: 18000,
    baseDelayMs: 350,
    maxDelayMs: 3000,
  },
  stream_completion: {
    timeoutMs: 25000,
    maxRetries: 1,
    retryBudgetMs: 8000,
    baseDelayMs: 500,
    maxDelayMs: 2000,
  },
  tool_completion: {
    timeoutMs: 55000,
    maxRetries: 3,
    retryBudgetMs: 22000,
    baseDelayMs: 450,
    maxDelayMs: 3500,
  },
};

const ORIGINAL_FETCH = globalThis.fetch;

export class ProviderRuntime {
  readonly config: ProviderRuntimeConfig;
  readonly providerName: string;
  readonly runtimeHealth: ProviderRuntimeHealth | null;

  constructor(config: ProviderRuntimeConfig, options: ProviderRuntimeOptions = {}) {
    this.config = config;
    this.providerName = options.providerName ?? config.provider ?? "provider";
    this.runtimeHealth = options.runtimeHealth ?? null;
  }

  async requestText({
    url,
    method = "GET",
    headers = {},
    body = null,
    requestType = "non_stream_completion",
    traceId = null,
    streamAttempt = false,
    onEvent = null,
  }: ProviderTextRequestOptions): Promise<{
    rawText: string;
    response: Response;
    meta: ProviderRequestMeta;
  }> {
    return this.executeRequest({
      requestType,
      traceId,
      streamAttempt,
      onEvent,
      endpoint: url,
      operation: async ({ attempt, timeoutMs, traceId: requestTraceId, streamAttempt: streamMode }) => {
        if (!shouldUseFetchTextTransport()) {
          const rawResponse = await requestRawResponseWithTimeout(url, {
            method,
            headers,
            body,
          }, timeoutMs);
          const response = new Response(rawResponse.rawText, {
            status: rawResponse.status,
            headers: rawResponse.headers,
          });

          if (!response.ok) {
            throw createProviderHttpError({
              provider: this.providerName,
              status: response.status,
              rawText: rawResponse.rawText,
              requestType,
              endpoint: url,
              traceId: requestTraceId,
              attempt,
              streamAttempt: streamMode,
            });
          }

          return {
            rawText: rawResponse.rawText,
            response,
          };
        }

        const response = await fetchWithTimeout(
          url,
          {
            method,
            headers,
            body,
          },
          timeoutMs,
        );

        const rawText = await readProviderResponseText({
          response,
          url,
          method,
          headers,
          body,
          timeoutMs,
          requestType,
          requestClass: normalizeRequestClass(requestType),
          traceId: requestTraceId,
          attempt,
          streamAttempt: streamMode,
          onEvent,
          provider: this.providerName,
        });
        if (!response.ok) {
          throw createProviderHttpError({
            provider: this.providerName,
            status: response.status,
            rawText,
            requestType,
            endpoint: url,
            traceId: requestTraceId,
            attempt,
            streamAttempt: streamMode,
          });
        }

        return {
          rawText,
          response,
        };
      },
    });
  }

  async requestStream({
    url,
    method = "POST",
    headers = {},
    body = null,
    requestType = "stream_completion",
    traceId = null,
    onEvent = null,
  }: ProviderStreamRequestOptions): Promise<{
    response: Response;
    meta: ProviderRequestMeta;
  }> {
    return this.executeRequest({
      requestType,
      traceId,
      streamAttempt: true,
      onEvent,
      endpoint: url,
      operation: async ({ attempt, timeoutMs, traceId: requestTraceId, streamAttempt }) => {
        const response = await fetchWithTimeout(
          url,
          {
            method,
            headers,
            body,
          },
          timeoutMs,
        );

        if (!response.ok) {
          const rawText = await response.text();
          throw createProviderHttpError({
            provider: this.providerName,
            status: response.status,
            rawText,
            requestType,
            endpoint: url,
            traceId: requestTraceId,
            attempt,
            streamAttempt,
          });
        }

        return { response };
      },
    });
  }

  async executeRequest<TResult extends ProviderResponsePayload>({
    requestType,
    traceId = null,
    streamAttempt = false,
    onEvent = null,
    endpoint = null,
    operation,
  }: ExecuteRequestOptions<TResult>): Promise<TResult & { meta: ProviderRequestMeta }> {
    const requestTraceId = traceId ?? crypto.randomUUID().slice(0, 12);
    const policy = resolvePolicy(this.config, requestType);
    const attempts: ProviderAttemptRecord[] = [];
    const startedAt = Date.now();
    const requestClass = normalizeRequestClass(requestType);

    const gate = await this.runtimeHealth?.beforeProviderRequest?.({
      provider: this.providerName,
      requestType,
      endpoint,
      traceId: requestTraceId,
    });
    if (gate?.events?.length) {
      for (const event of gate.events) {
        await emitEvent(onEvent, event);
      }
    }
    if (gate?.allowed === false) {
      const error = createProviderCircuitOpenError({
        provider: this.providerName,
        requestType,
        endpoint,
        traceId: requestTraceId,
        circuit: (gate.circuit ?? null) as Record<string, unknown> | null,
      });
      await emitEvent(onEvent, {
        type: "provider_circuit_blocked",
        provider: this.providerName,
        requestType,
        requestClass,
        endpoint,
        traceId: requestTraceId,
        circuit: gate.circuit,
        error: serializeProviderError(error),
      });
      throw error;
    }

    for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt += 1) {
      const attemptStartedAt = Date.now();
      await emitEvent(onEvent, {
        type: "provider_attempt_started",
        provider: this.providerName,
        requestType,
        requestClass,
        endpoint,
        traceId: requestTraceId,
        attempt,
        streamAttempt,
        policy,
      });

      try {
        const result = await operation({
          attempt,
          timeoutMs: policy.timeoutMs,
          traceId: requestTraceId,
          streamAttempt,
        });
        const durationMs = Date.now() - attemptStartedAt;
        const metadata: ProviderAttemptRecord = {
          attempt,
          durationMs,
          ok: true,
          status: result.response?.status ?? 200,
          streamAttempt,
        };
        attempts.push(metadata);
        const healthResult = await this.runtimeHealth?.noteProviderOutcome?.({
          provider: this.providerName,
          requestType,
          endpoint,
          success: true,
          totalDurationMs: Date.now() - startedAt,
        });
        await emitEvent(onEvent, {
          type: "provider_attempt_succeeded",
          provider: this.providerName,
          requestType,
          requestClass,
          endpoint,
          traceId: requestTraceId,
          ...metadata,
          circuit: healthResult?.circuit ?? gate?.circuit ?? null,
        });
        if (healthResult?.events?.length) {
          for (const event of healthResult.events) {
            await emitEvent(onEvent, {
              ...event,
              traceId: requestTraceId,
            });
          }
        }

        return {
          ...result,
          meta: {
            provider: this.providerName,
            requestType,
            requestClass,
            endpoint,
            traceId: requestTraceId,
            attemptCount: attempt,
            attempts,
            policy,
            fallbackUsed: false,
            streamAttempt,
            circuit: healthResult?.circuit ?? gate?.circuit ?? null,
          },
        };
      } catch (error) {
        const durationMs = Date.now() - attemptStartedAt;
        const normalized = normalizeProviderError(error, {
          provider: this.providerName,
          requestType,
          endpoint,
          traceId: requestTraceId,
          attempt,
          streamAttempt,
        }) as {
          status?: number | null;
          retryable?: boolean;
          taxonomy?: string;
          code?: string;
          circuitState?: string | null;
          details?: Record<string, unknown> | null;
        } & Error;
        const exhausted = attempt > policy.maxRetries ||
          Date.now() - startedAt >= policy.retryBudgetMs ||
          !isRetryableProviderError(normalized);
        const delayMs = exhausted ? 0 : computeBackoffDelay(policy, attempt);

        const attemptRecord: ProviderAttemptRecord = {
          attempt,
          durationMs,
          ok: false,
          status: normalized.status ?? null,
          streamAttempt,
          retryable: normalized.retryable,
          taxonomy: normalized.taxonomy,
          code: normalized.code,
          delayMs,
        };
        attempts.push(attemptRecord);

        await emitEvent(onEvent, {
          type: exhausted ? "provider_attempt_exhausted" : "provider_attempt_failed",
          provider: this.providerName,
          requestType,
          requestClass,
          endpoint,
          traceId: requestTraceId,
          ...attemptRecord,
          error: serializeProviderError(normalized),
        });

        if (exhausted) {
          const finalError = finalizeProviderError(normalized, attempts) as {
            circuitState?: string | null;
            details?: Record<string, unknown> | null;
          } & Error;
          const healthResult = await this.runtimeHealth?.noteProviderOutcome?.({
            provider: this.providerName,
            requestType,
            endpoint,
            success: false,
            totalDurationMs: Date.now() - startedAt,
            error: finalError,
          });
          if (healthResult?.events?.length) {
            for (const event of healthResult.events) {
              await emitEvent(onEvent, {
                ...event,
                traceId: requestTraceId,
              });
            }
          }
          finalError.circuitState =
            (healthResult?.circuit as { state?: string } | undefined)?.state ??
            (gate?.circuit as { state?: string } | undefined)?.state ??
            finalError.circuitState;
          if (!finalError.details || typeof finalError.details !== "object") {
            finalError.details = {};
          }
          finalError.details.circuit = healthResult?.circuit ?? gate?.circuit ?? null;
          throw finalError;
        }

        await this.runtimeHealth?.noteProviderRetry?.({
          provider: this.providerName,
          requestType,
          endpoint,
          delayMs,
        });
        await emitEvent(onEvent, {
          type: "provider_retry_scheduled",
          provider: this.providerName,
          requestType,
          requestClass,
          endpoint,
          traceId: requestTraceId,
          attempt,
          delayMs,
          error: serializeProviderError(normalized),
        });
        await sleep(delayMs);
      }
    }

    throw finalizeProviderError(
      createProviderTimeoutError({
        provider: this.providerName,
        requestType,
        endpoint,
        traceId: requestTraceId,
        attempt: policy.maxRetries + 1,
        timeoutMs: policy.timeoutMs,
      }),
      attempts,
    );
  }
}

function resolvePolicy(config: ProviderRuntimeConfig, requestType: ProviderRequestType): ProviderPolicy {
  const base = REQUEST_POLICIES[requestType] ?? REQUEST_POLICIES.non_stream_completion;
  return {
    timeoutMs: Number(config.providerTimeoutMs ?? base.timeoutMs),
    maxRetries: Number(config.providerMaxRetries ?? base.maxRetries),
    retryBudgetMs: Number(config.providerRetryBudgetMs ?? base.retryBudgetMs),
    baseDelayMs: base.baseDelayMs,
    maxDelayMs: base.maxDelayMs,
  };
}

function normalizeRequestClass(requestType: ProviderRequestType): ProviderRequestClass {
  if (requestType === "models_list") {
    return "models";
  }
  if (requestType === "non_stream_completion") {
    return "completion_non_stream";
  }
  if (requestType === "stream_completion") {
    return "completion_stream";
  }
  if (requestType === "tool_completion") {
    return "tool_calling_completion";
  }
  return `${requestType ?? "unknown"}`;
}

function computeBackoffDelay(policy: ProviderPolicy, attempt: number): number {
  const rawDelay = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)),
  );
  const jitter = Math.max(25, Math.round(rawDelay * 0.2 * Math.random()));
  return rawDelay + jitter;
}

async function readProviderResponseText({
  response,
  url,
  method,
  headers,
  body,
  timeoutMs,
  requestType,
  requestClass,
  traceId,
  attempt,
  streamAttempt,
  onEvent,
  provider,
}: {
  response: Response;
  url: string;
  method: string;
  headers: RequestHeaders;
  body: RequestBody | null;
  timeoutMs: number;
  requestType: ProviderRequestType;
  requestClass: ProviderRequestClass;
  traceId: string;
  attempt: number;
  streamAttempt: boolean;
  onEvent: RuntimeEventHandler | null;
  provider: string;
}): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (!isUndiciContentDecodeError(error)) {
      throw error;
    }

    await emitEvent(onEvent, {
      type: "provider_response_decode_fallback",
      provider,
      requestType,
      requestClass,
      endpoint: url,
      traceId,
      attempt,
      streamAttempt,
      error: {
        name: getUnknownErrorName(error),
        message: getUnknownErrorMessage(error),
        code: getUnknownErrorCode(error),
        causeCode: getNestedErrorCode(error),
      },
    });

    const rawResponse = await requestRawResponseWithTimeout(url, {
      method,
      headers,
      body,
    }, timeoutMs);
    return rawResponse.rawText;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw createProviderTimeoutError({
        timeoutMs,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requestRawResponseWithTimeout(
  rawUrl: string,
  init: {
    method: string;
    headers: RequestHeaders;
    body: RequestBody | null;
  },
  timeoutMs: number,
): Promise<{
  rawText: string;
  status: number;
  headers: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const transport = url.protocol === "https:" ? https : http;
    const requestBody = normalizeRawRequestBody(init.body);
    const requestHeaders = normalizeRawRequestHeaders(init.headers);
    if (requestBody != null && !hasHeader(requestHeaders, "content-length")) {
      requestHeaders["Content-Length"] = String(byteLength(requestBody));
    }
    const request = transport.request(url, {
      method: init.method,
      headers: requestHeaders,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        resolve({
          rawText: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode ?? 0,
          headers: normalizeRawResponseHeaders(response.headers),
        });
      });
    });
    const timer = setTimeout(() => {
      request.destroy(createProviderTimeoutError({ timeoutMs }));
    }, timeoutMs);

    request.on("error", reject);
    request.on("close", () => {
      clearTimeout(timer);
    });
    if (requestBody != null) {
      request.write(requestBody);
    }
    request.end();
  });
}

function hasHeader(headers: Record<string, string | string[]>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function byteLength(value: string | Buffer | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}

function normalizeRawResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key] = value.join(", ");
      continue;
    }
    if (value != null) {
      normalized[key] = `${value}`;
    }
  }
  return normalized;
}

function normalizeRawRequestBody(body: RequestBody | null): string | Buffer | Uint8Array | null {
  if (body == null) {
    return null;
  }
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return body;
  }
  return `${body}`;
}

function normalizeRawRequestHeaders(headers: RequestHeaders): Record<string, string | string[]> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of headers) {
      normalized[key] = value;
    }
    return normalized;
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, Array.isArray(value) ? value.map(String) : `${value}`]),
  );
}

function shouldUseFetchTextTransport(): boolean {
  return globalThis.fetch !== ORIGINAL_FETCH;
}

function isUndiciContentDecodeError(error: unknown): boolean {
  const haystack = [
    getUnknownErrorMessage(error),
    getUnknownErrorCode(error),
    getNestedErrorMessage(error),
    getNestedErrorCode(error),
  ].join(" ").toLowerCase();
  return haystack.includes("incorrect header check") ||
    haystack.includes("z_data_error") ||
    haystack.includes("content-encoding") ||
    haystack.includes("terminated");
}

function getUnknownErrorName(error: unknown): string | null {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string"
    ? error.name
    : null;
}

function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error ?? "Unknown error"}`;
}

function getUnknownErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function getNestedErrorMessage(error: unknown): string | null {
  const cause = getNestedCause(error);
  return cause instanceof Error ? cause.message : null;
}

function getNestedErrorCode(error: unknown): string | null {
  const cause = getNestedCause(error);
  return cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : null;
}

function getNestedCause(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("cause" in error)) {
    return null;
  }
  const cause = error.cause;
  if (cause && typeof cause === "object" && "cause" in cause) {
    return cause.cause;
  }
  return cause;
}

async function emitEvent(onEvent: RuntimeEventHandler | null | undefined, event: RuntimeEvent): Promise<void> {
  if (typeof onEvent === "function") {
    await onEvent(event);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
