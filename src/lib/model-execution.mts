import {
  normalizeProviderError,
  serializeProviderError,
} from "./provider-errors.mjs";
import type { SerializedProviderError } from "./provider-errors.mjs";
import type {
  ModelDecision,
  ProviderCompletionRequest,
  ProviderCompletionResult,
} from "../types/contracts.js";

export interface ModelExecutionOptions {
  provider: { complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResult> };
  request: ProviderCompletionRequest & {
    endpoint?: string | null;
    traceId?: string | null;
    tools?: unknown[];
    streamOutput?: boolean;
  };
  modelDecision: ModelDecision | null | undefined;
  configuredModel?: string | null;
  providerName?: string | null;
  requestType?: string;
  isFallbackSafe?: (context: {
    error: unknown;
    attemptedModels: Array<{ model: string; error: SerializedProviderError }>;
  }) => boolean;
  onFallback?: (event: {
    fromModel: string;
    toModel: string;
    requestType: string;
    error: SerializedProviderError;
    attemptedModels: string[];
  }) => Promise<void>;
}

export async function executeCompletionWithFallback({
  provider,
  request,
  modelDecision,
  configuredModel = null,
  providerName = null,
  requestType = inferProviderRequestType(request),
  isFallbackSafe = defaultFallbackSafetyCheck,
  onFallback = async () => {},
}: ModelExecutionOptions) {
  const attempts: Array<{ model: string; error: SerializedProviderError }> = [];
  const chain = buildModelExecutionChain(modelDecision, configuredModel);
  let lastError: unknown = null;

  for (let index = 0; index < chain.length; index += 1) {
    const model = chain[index];
    try {
      const completion = await provider.complete({
        ...request,
        model,
      });
      return {
        completion,
        selectedModel: model,
        attemptedModels: [...attempts.map((entry) => entry.model), model],
        fallbackCount: attempts.length,
        fallbackHistory: attempts,
      };
    } catch (error) {
      const normalized = normalizeProviderError(error, {
        provider: providerName,
        requestType,
        endpoint: request.endpoint ?? null,
        traceId: request.traceId ?? null,
      });
      const attempt = {
        model,
        error: serializeProviderError(normalized),
      };
      attempts.push(attempt);
      lastError = normalized;

      const nextModel = chain[index + 1] ?? null;
      if (!nextModel || !shouldFallbackToNextModel(normalized) || !isFallbackSafe({ error: normalized, attemptedModels: attempts })) {
        normalized.attemptedModels = [...attempts.map((entry) => entry.model)];
        throw normalized;
      }

      await onFallback({
        fromModel: model,
        toModel: nextModel,
        requestType,
        error: attempt.error,
        attemptedModels: [...attempts.map((entry) => entry.model)],
      });
    }
  }

  throw lastError ?? new Error("Model execution failed without a captured provider error.");
}

export function buildModelExecutionChain(modelDecision: ModelDecision | null | undefined, configuredModel: string | null = null): string[] {
  const chain: string[] = [];
  for (const model of [
    modelDecision?.chosenModel ?? null,
    ...(modelDecision?.fallbackModels ?? []),
    configuredModel,
  ]) {
    if (typeof model !== "string" || !model.trim() || chain.includes(model)) {
      continue;
    }
    chain.push(model);
  }
  return chain;
}

export function shouldFallbackToNextModel(error: unknown): boolean {
  const normalized = normalizeProviderError(error);
  const message = `${normalized.message ?? ""}`.toLowerCase();
  const rawText = `${normalized.rawText ?? ""}`.toLowerCase();
  const code = `${normalized.code ?? ""}`.toLowerCase();

  if (normalized.taxonomy === "provider_circuit_open" || normalized.partialStream === true) {
    return false;
  }

  if (
    normalized.retryExhausted === true ||
    ["provider_timeout", "provider_rate_limit"].includes(normalized.taxonomy)
  ) {
    return true;
  }

  return (
    code.includes("model") ||
    message.includes("model not found") ||
    rawText.includes("model_not_found") ||
    rawText.includes("unknown model") ||
    rawText.includes("unsupported model")
  );
}

export function inferProviderRequestType(
  request: Pick<ProviderCompletionRequest, "tools" | "streamOutput"> = {},
): string {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    return "tool_calling_completion";
  }
  return request.streamOutput ? "completion_stream" : "completion_non_stream";
}

function defaultFallbackSafetyCheck({
  error,
}: {
  error: unknown;
  attemptedModels: Array<{ model: string; error: SerializedProviderError }>;
}): boolean {
  return !error || typeof error !== "object" || !("partialStream" in error) || error.partialStream !== true;
}
