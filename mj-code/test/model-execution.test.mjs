import test from "node:test";
import assert from "node:assert/strict";

import { ProviderError } from "../src/lib/provider-errors.mjs";
import {
  buildModelExecutionChain,
  executeCompletionWithFallback,
  shouldFallbackToNextModel,
} from "../src/lib/model-execution.mjs";

test("buildModelExecutionChain deduplicates chosen, fallback, and configured models", () => {
  const chain = buildModelExecutionChain({
    chosenModel: "gpt-5.4",
    fallbackModels: ["gpt-5-mini", "gpt-5.4", "gpt-5-mini"],
  }, "gpt-5.4");

  assert.deepEqual(chain, ["gpt-5.4", "gpt-5-mini"]);
});

test("shouldFallbackToNextModel rejects circuit-open and partial-stream failures", () => {
  assert.equal(shouldFallbackToNextModel(new ProviderError("open", {
    taxonomy: "provider_circuit_open",
    provider: "openai-compatible",
  })), false);

  assert.equal(shouldFallbackToNextModel(new ProviderError("partial", {
    taxonomy: "provider_error",
    partialStream: true,
    provider: "openai-compatible",
  })), false);
});

test("executeCompletionWithFallback retries the next model when the first model exhausts retries", async () => {
  const calls = [];
  const fallbacks = [];
  const provider = {
    async complete({ model }) {
      calls.push(model);
      if (model === "gpt-5.4") {
        throw new ProviderError("retry exhausted", {
          provider: "openai-compatible",
          taxonomy: "provider_retry_exhausted",
          requestType: "completion_non_stream",
          retryable: true,
          retryExhausted: true,
        });
      }
      return {
        text: `ok:${model}`,
        usage: null,
      };
    },
  };

  const result = await executeCompletionWithFallback({
    provider,
    request: {
      messages: [{ role: "user", content: "test" }],
      streamOutput: false,
      traceId: "trace-1",
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
      fallbackModels: ["gpt-5-mini"],
    },
    configuredModel: "gpt-5.4",
    providerName: "openai-compatible",
    onFallback: async (event) => {
      fallbacks.push(event);
    },
  });

  assert.equal(result.selectedModel, "gpt-5-mini");
  assert.deepEqual(result.attemptedModels, ["gpt-5.4", "gpt-5-mini"]);
  assert.equal(result.fallbackCount, 1);
  assert.equal(fallbacks[0].fromModel, "gpt-5.4");
  assert.equal(calls.length, 2);
});
