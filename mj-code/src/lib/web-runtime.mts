import crypto from "node:crypto";

import { WebCache } from "./web-cache.mjs";
import {
  WebError,
  createWebCircuitOpenError,
  createFetchTimeoutError,
  createFetchTooLargeError,
  createSearchProviderError,
  createUnsupportedContentTypeError,
  finalizeWebError,
  isRetryableWebError,
  normalizeWebError,
  serializeWebError,
} from "./web-errors.mjs";
import type { WebAttemptRecord as WebErrorAttemptRecord } from "./web-errors.mjs";
import type {
  WebCacheLookupResult,
  WebCacheNegativeRecord,
  WebCachePositiveRecord,
} from "../types/contracts.js";

type RuntimeEvent = Record<string, unknown>;
type RuntimeEventHandler = (event: RuntimeEvent) => Promise<void> | void;
type WebRequestType = "search" | "fetch" | "extract" | "robots" | string;
type RequestHeaders = RequestInit["headers"];
type RequestBody = Exclude<RequestInit["body"], undefined>;
type RequestRedirectMode = RequestInit["redirect"];

interface WebPolicy {
  timeoutMs: number;
  maxRetries: number;
  retryBudgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxBytes: number;
}

export interface WebRuntimeConfig {
  projectStateDir: string;
  webCacheTtlMs?: number;
  webTimeoutMs?: number;
  webMaxRetries?: number;
  webRetryBudgetMs?: number;
  webMaxBodyBytes?: number;
}

type CachedWebValue<TPayload = unknown> = {
  payload: TPayload;
  meta: WebRequestMeta;
};

interface WebCacheLike {
  initialize(): Promise<void>;
  get(namespace: string, key: string): Promise<WebCacheLookupResult<CachedWebValue>>;
  set(
    namespace: string,
    key: string,
    value: CachedWebValue,
    metadata?: Record<string, unknown>,
  ): Promise<WebCachePositiveRecord<CachedWebValue>>;
  setNegative(
    namespace: string,
    key: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ): Promise<WebCacheNegativeRecord>;
}

interface WebRequestGate {
  allowed?: boolean;
  circuit?: unknown;
  events?: RuntimeEvent[];
}

interface WebOutcomeResult {
  circuit?: unknown;
  events?: RuntimeEvent[];
}

interface WebRuntimeHealth {
  beforeWebRequest?(input: {
    provider?: string | null;
    requestType: WebRequestType;
    endpoint: string;
    traceId: string;
  }): Promise<WebRequestGate | null | undefined> | WebRequestGate | null | undefined;
  noteWebOutcome?(input: {
    provider?: string | null;
    requestType: WebRequestType;
    endpoint: string;
    success: boolean;
    totalDurationMs: number;
    error?: unknown;
  }): Promise<WebOutcomeResult | null | undefined> | WebOutcomeResult | null | undefined;
}

export interface WebRuntimeOptions {
  cache?: WebCacheLike | null;
  runtimeHealth?: WebRuntimeHealth | null;
}

type WebAttemptRecord = WebErrorAttemptRecord & {
  attempt: number;
  ok: boolean;
  durationMs: number;
  status: number | null;
  taxonomy?: string;
  retryable?: boolean;
  delayMs?: number;
};

interface WebRequestMeta {
  traceId: string;
  url: string;
  finalUrl: string;
  method: string;
  requestType: WebRequestType;
  status: number;
  contentType: string | null;
  redirected: boolean;
  cacheHit: boolean;
  attemptCount: number;
  attempts: WebAttemptRecord[];
  circuit?: unknown;
}

interface WebExecuteParseInput {
  response: Response;
  maxBytes: number;
}

interface WebExecuteOptions<TPayload> {
  requestType?: WebRequestType;
  traceId?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  retryBudgetMs?: number;
  maxBytes?: number;
  method?: string;
  url: string;
  headers?: RequestHeaders;
  body?: RequestBody | null;
  redirect?: RequestRedirectMode;
  onEvent?: RuntimeEventHandler | null;
  provider?: string | null;
  cacheNamespace?: string;
  cacheKey?: string;
  cache?: boolean;
  cacheTtlMs?: number;
  negativeTtlMs?: number;
  query?: string | null;
  allowContentTypes?: string[];
  parse: (input: WebExecuteParseInput) => Promise<TPayload>;
}

interface WebTextRequestOptions extends Omit<WebExecuteOptions<string>, "parse" | "url"> {
  url: string;
}

interface WebJsonRequestOptions extends Omit<WebExecuteOptions<unknown>, "parse" | "url"> {
  url: string;
}

interface HttpErrorOptions {
  provider?: string | null;
  requestType: WebRequestType;
  traceId: string;
  attempt: number;
  method: string;
  url: string;
}

const REQUEST_POLICIES: Record<string, WebPolicy> = {
  search: {
    timeoutMs: 12000,
    maxRetries: 2,
    retryBudgetMs: 12000,
    baseDelayMs: 250,
    maxDelayMs: 1600,
    maxBytes: 300000,
  },
  fetch: {
    timeoutMs: 15000,
    maxRetries: 2,
    retryBudgetMs: 15000,
    baseDelayMs: 350,
    maxDelayMs: 2000,
    maxBytes: 800000,
  },
  extract: {
    timeoutMs: 15000,
    maxRetries: 2,
    retryBudgetMs: 15000,
    baseDelayMs: 350,
    maxDelayMs: 2000,
    maxBytes: 800000,
  },
  robots: {
    timeoutMs: 6000,
    maxRetries: 1,
    retryBudgetMs: 5000,
    baseDelayMs: 200,
    maxDelayMs: 800,
    maxBytes: 120000,
  },
};

export class WebRuntime {
  readonly config: WebRuntimeConfig;
  readonly cache: WebCacheLike;
  readonly runtimeHealth: WebRuntimeHealth | null;

  constructor(config: WebRuntimeConfig, options: WebRuntimeOptions = {}) {
    this.config = config;
    this.cache =
      options.cache ??
      new WebCache(config.projectStateDir, {
        defaultTtlMs: config.webCacheTtlMs,
      });
    this.runtimeHealth = options.runtimeHealth ?? null;
  }

  async initialize(): Promise<void> {
    await this.cache.initialize();
  }

  async requestText(options: WebTextRequestOptions): Promise<{
    payload: string;
    content: string;
    meta: WebRequestMeta;
  }> {
    const result = await this.execute({
      ...options,
      parse: async ({ response, maxBytes }) => {
        const body = await readBodyAsText(response, maxBytes);
        validateContentType(response.headers.get("content-type"), options.allowContentTypes, options);
        return body;
      },
    });

    return {
      ...result,
      content: result.payload,
    };
  }

  async requestJson<TJson = unknown>(options: WebJsonRequestOptions): Promise<{
    payload: TJson;
    json: TJson;
    meta: WebRequestMeta;
  }> {
    const result = await this.execute<TJson>({
      ...options,
      parse: async ({ response, maxBytes }) => {
        const body = await readBodyAsText(response, maxBytes);
        validateContentType(response.headers.get("content-type"), [
          "application/json",
          "text/json",
        ], options);
        return JSON.parse(body) as TJson;
      },
    });

    return {
      ...result,
      json: result.payload,
    };
  }

  async execute<TPayload>(options: WebExecuteOptions<TPayload>): Promise<{
    payload: TPayload;
    meta: WebRequestMeta;
  }> {
    await this.initialize();
    const requestType = options.requestType ?? "fetch";
    const traceId = options.traceId ?? crypto.randomUUID().slice(0, 12);
    const policy = resolvePolicy(this.config, requestType, options);
    const method = options.method ?? "GET";
    const url = options.url;
    const attempts: WebAttemptRecord[] = [];
    const cacheNamespace = options.cacheNamespace ?? requestType;
    const cacheKey = options.cacheKey ?? `${method}:${url}:${String(options.body ?? "")}`;
    const shouldUseCache = options.cache !== false;
    const startedAt = Date.now();
    const gate = await this.runtimeHealth?.beforeWebRequest?.({
      provider: options.provider ?? null,
      requestType,
      endpoint: url,
      traceId,
    });
    if (gate?.events?.length) {
      for (const event of gate.events) {
        await emitEvent(options.onEvent, event);
      }
    }
    if (gate?.allowed === false) {
      const error = createWebCircuitOpenError({
        requestType,
        url,
        method,
        traceId,
        provider: options.provider ?? null,
        circuit: (gate.circuit ?? null) as Record<string, unknown> | null,
      });
      await emitEvent(options.onEvent, {
        type: "web_circuit_blocked",
        traceId,
        requestType,
        url,
        method,
        provider: options.provider ?? null,
        circuit: gate.circuit,
        error: serializeWebError(error),
      });
      throw error;
    }

    if (shouldUseCache) {
      const cached = await this.cache.get(cacheNamespace, cacheKey);
      if (cached?.negative) {
        await emitEvent(options.onEvent, {
          type: "web_negative_cache_hit",
          traceId,
          requestType,
          url,
          method,
          provider: options.provider ?? null,
          cacheNamespace,
        });
        throw normalizeWebError(
          new WebError("Cached negative web result.", {
            taxonomy: "network_error",
            code: "negative_cache_hit",
            url,
            method,
            requestType,
            traceId,
            retryable: false,
            details: asRecord(cached.meta?.error),
          }),
        );
      }

      if (cached?.hit) {
        await emitEvent(options.onEvent, {
          type: "web_cache_hit",
          traceId,
          requestType,
          url,
          method,
          provider: options.provider ?? null,
          cacheNamespace,
        });
        return {
          payload: cached.value.payload as TPayload,
          meta: {
            ...cached.value.meta,
            traceId,
            cacheHit: true,
            attemptCount: 0,
            attempts: [],
          },
        };
      }
    }

    for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt += 1) {
      const attemptStartedAt = Date.now();
      await emitEvent(options.onEvent, {
        type: "web_attempt_started",
        traceId,
        requestType,
        url,
        method,
        provider: options.provider ?? null,
        attempt,
      });

      try {
        const response = await fetchWithTimeout(
          url,
          {
            method,
            headers: options.headers,
            body: options.body,
            redirect: options.redirect ?? "follow",
          },
          policy.timeoutMs,
        );

        if (!response.ok) {
          throw createHttpError(response, {
            ...options,
            requestType,
            traceId,
            attempt,
            method,
            url,
          });
        }

        const payload = await options.parse({
          response,
          maxBytes: policy.maxBytes,
        });
        const durationMs = Date.now() - attemptStartedAt;
        const meta: WebRequestMeta = {
          traceId,
          url,
          finalUrl: response.url || url,
          method,
          requestType,
          status: response.status,
          contentType: response.headers.get("content-type") ?? null,
          redirected: response.redirected,
          cacheHit: false,
          attemptCount: attempt,
          attempts: [...attempts, { attempt, ok: true, durationMs, status: response.status }],
        };

        if (shouldUseCache) {
          await this.cache.set(
            cacheNamespace,
            cacheKey,
            {
              payload,
              meta,
            },
            {
              ttlMs: options.cacheTtlMs ?? this.config.webCacheTtlMs,
              provider: options.provider ?? null,
              query: options.query ?? null,
              url,
            },
          );
        }

        await emitEvent(options.onEvent, {
          type: "web_attempt_succeeded",
          traceId,
          requestType,
          url,
          method,
          provider: options.provider ?? null,
          attempt,
          durationMs,
          status: response.status,
          cacheHit: false,
        });
        const healthResult = await this.runtimeHealth?.noteWebOutcome?.({
          provider: options.provider ?? null,
          requestType,
          endpoint: url,
          success: true,
          totalDurationMs: Date.now() - startedAt,
        });
        if (healthResult?.events?.length) {
          for (const event of healthResult.events) {
            await emitEvent(options.onEvent, {
              ...event,
              traceId,
            });
          }
        }
        meta.circuit = healthResult?.circuit ?? gate?.circuit ?? null;

        return {
          payload,
          meta,
        };
      } catch (error) {
        const normalized = normalizeWebError(error, {
          url,
          method,
          requestType,
          traceId,
          attempt,
          timeoutMs: policy.timeoutMs,
          provider: options.provider ?? null,
        }) as {
          status?: number | null;
          taxonomy?: string;
          retryable?: boolean;
          details?: Record<string, unknown> | null;
        } & Error;
        const durationMs = Date.now() - attemptStartedAt;
        const exhausted = attempt > policy.maxRetries ||
          Date.now() - startedAt >= policy.retryBudgetMs ||
          !isRetryableWebError(normalized);
        const delayMs = exhausted ? 0 : computeBackoffDelay(policy, attempt);
        attempts.push({
          attempt,
          ok: false,
          durationMs,
          status: normalized.status ?? null,
          taxonomy: normalized.taxonomy,
          retryable: normalized.retryable,
          delayMs,
        });

        await emitEvent(options.onEvent, {
          type: exhausted ? "web_attempt_exhausted" : "web_attempt_failed",
          traceId,
          requestType,
          url,
          method,
          provider: options.provider ?? null,
          attempt,
          durationMs,
          error: serializeWebError(normalized),
        });

        if (exhausted) {
          const finalError = finalizeWebError(normalized, attempts) as {
            details?: Record<string, unknown> | null;
          } & Error;
          const healthResult = await this.runtimeHealth?.noteWebOutcome?.({
            provider: options.provider ?? null,
            requestType,
            endpoint: url,
            success: false,
            totalDurationMs: Date.now() - startedAt,
            error: finalError,
          });
          if (healthResult?.events?.length) {
            for (const event of healthResult.events) {
              await emitEvent(options.onEvent, {
                ...event,
                traceId,
              });
            }
          }
          if (!finalError.details || typeof finalError.details !== "object") {
            finalError.details = {};
          }
          finalError.details.circuit = healthResult?.circuit ?? gate?.circuit ?? null;
          if (shouldUseCache && normalized.retryable === false) {
            await this.cache.setNegative(cacheNamespace, cacheKey, serializeWebError(finalError), {
              ttlMs: options.negativeTtlMs,
              provider: options.provider ?? null,
              query: options.query ?? null,
              url,
            });
          }
          throw finalError;
        }

        await emitEvent(options.onEvent, {
          type: "web_retry_scheduled",
          traceId,
          requestType,
          url,
          method,
          provider: options.provider ?? null,
          attempt,
          delayMs,
          error: serializeWebError(normalized),
        });
        await sleep(delayMs);
      }
    }

    throw finalizeWebError(
      new WebError("Web request exhausted retries.", {
        taxonomy: "network_error",
        code: "retry_exhausted",
        url,
        method,
        requestType,
        traceId,
        retryable: true,
      }),
      attempts,
    );
  }
}

function resolvePolicy(
  config: WebRuntimeConfig,
  requestType: WebRequestType,
  options: Pick<WebExecuteOptions<unknown>, "timeoutMs" | "maxRetries" | "retryBudgetMs" | "maxBytes">,
): WebPolicy {
  const base = REQUEST_POLICIES[requestType] ?? REQUEST_POLICIES.fetch;
  return {
    timeoutMs: Number(options.timeoutMs ?? config.webTimeoutMs ?? base.timeoutMs),
    maxRetries: Number(options.maxRetries ?? config.webMaxRetries ?? base.maxRetries),
    retryBudgetMs: Number(options.retryBudgetMs ?? config.webRetryBudgetMs ?? base.retryBudgetMs),
    baseDelayMs: base.baseDelayMs,
    maxDelayMs: base.maxDelayMs,
    maxBytes: Number(options.maxBytes ?? config.webMaxBodyBytes ?? base.maxBytes),
  };
}

function computeBackoffDelay(policy: WebPolicy, attempt: number): number {
  const rawDelay = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)),
  );
  const jitter = Math.max(20, Math.round(rawDelay * 0.25 * Math.random()));
  return rawDelay + jitter;
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
      throw createFetchTimeoutError({
        url,
        method: init.method ?? "GET",
        timeoutMs,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyAsText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const textBytes = Buffer.byteLength(text, "utf8");
    if (textBytes > maxBytes) {
      throw createFetchTooLargeError({
        maxBytes,
        receivedBytes: textBytes,
      });
    }
    return text;
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      throw createFetchTooLargeError({
        maxBytes,
        receivedBytes,
      });
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function validateContentType(
  contentType: string | null,
  allowContentTypes: string[] | undefined,
  options: Pick<WebExecuteOptions<unknown>, "url" | "method" | "requestType" | "traceId" | "provider">,
): void {
  if (!Array.isArray(allowContentTypes) || allowContentTypes.length === 0) {
    return;
  }

  const normalized = `${contentType ?? ""}`.toLowerCase();
  const supported = allowContentTypes.some((entry) => normalized.includes(`${entry}`.toLowerCase()));
  if (!supported) {
    throw createUnsupportedContentTypeError({
      contentType,
      allowContentTypes,
      url: options.url,
      method: options.method ?? "GET",
      requestType: options.requestType,
      traceId: options.traceId ?? null,
      provider: options.provider ?? null,
    });
  }
}

function createHttpError(response: Response, options: HttpErrorOptions): Error {
  if (options.requestType === "search") {
    return createSearchProviderError({
      provider: options.provider ?? "unknown",
      status: response.status,
      url: options.url,
      method: options.method,
      requestType: options.requestType,
      traceId: options.traceId,
      attempt: options.attempt,
      retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
      message: `Search provider request failed (${response.status}).`,
    }) as Error;
  }

  return new WebError(`Web request failed (${response.status}).`, {
    taxonomy: "network_error",
    code: `http_${response.status}`,
    status: response.status,
    url: options.url,
    method: options.method,
    requestType: options.requestType,
    traceId: options.traceId,
    attempt: options.attempt,
    retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

async function emitEvent(onEvent: RuntimeEventHandler | null | undefined, event: RuntimeEvent): Promise<void> {
  if (typeof onEvent === "function") {
    await onEvent(event);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
