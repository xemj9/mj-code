import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { AnthropicCompatibleProvider } from "../src/providers/anthropic-compatible.mjs";
import { OpenAiCompatibleProvider } from "../src/providers/openai-compatible.mjs";
import { ProviderRuntime } from "../src/lib/provider-runtime.mjs";
import { RuntimeHealth } from "../src/lib/runtime-health.mjs";

test("provider runtime retries transient failures with structured attempt metadata", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("gateway down", { status: 503 });
    }

    return new Response(JSON.stringify({ data: [{ id: "gpt-5.4" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const runtime = new ProviderRuntime({
      provider: "openai-compatible",
      providerMaxRetries: 2,
      providerRetryBudgetMs: 1000,
      providerTimeoutMs: 500,
    }, {
      providerName: "openai-compatible",
    });
    const events = [];
    const response = await runtime.requestText({
      url: "https://example.test/models",
      requestType: "models_list",
      onEvent: async (event) => {
        events.push(event);
      },
    });

    assert.equal(JSON.parse(response.rawText).data[0].id, "gpt-5.4");
    assert.equal(response.meta.attemptCount, 2);
    assert.ok(events.some((event) => event.type === "provider_retry_scheduled"));
    assert.ok(events.some((event) => event.type === "provider_attempt_succeeded"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai-compatible provider falls back from failed stream establishment to non-stream", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async (url, init = {}) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.stream === true) {
      return new Response("<html>not found</html>", {
        status: 405,
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "fallback ok",
            tool_calls: null,
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const provider = new OpenAiCompatibleProvider({
      provider: "openai-compatible",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      extraHeaders: {},
      providerMaxRetries: 0,
      providerRetryBudgetMs: 1000,
      providerTimeoutMs: 500,
    });
    const events = [];
    const result = await provider.complete({
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-5.4",
      maxTokens: 32,
      temperature: 0,
      streamOutput: true,
      onTextDelta: async () => {},
      onProviderEvent: async (event) => {
        events.push(event);
      },
    });

    assert.equal(result.text, "fallback ok");
    assert.equal(result.meta.fallbackUsed, true);
    assert.equal(calls, 2);
    assert.ok(events.some((event) => event.type === "provider_stream_fallback"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider runtime falls back to raw text when a compatible endpoint mislabels gzip", async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
    });
    response.end(JSON.stringify({
      choices: [
        {
          message: {
            content: "decode fallback ok",
            tool_calls: null,
          },
        },
      ],
    }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("sandbox does not allow binding a local HTTP server");
      return;
    }
    throw error;
  }

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const provider = new OpenAiCompatibleProvider({
      provider: "openai-compatible",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      extraHeaders: {},
      providerMaxRetries: 0,
      providerRetryBudgetMs: 1000,
      providerTimeoutMs: 1000,
    });
    const events = [];
    const result = await provider.complete({
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-5.4",
      maxTokens: 32,
      temperature: 0,
      streamOutput: false,
      onProviderEvent: async (event) => {
        events.push(event);
      },
    });

    assert.equal(result.text, "decode fallback ok");
    assert.ok(events.some((event) => event.type === "provider_response_decode_fallback"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider runtime opens a circuit after repeated exhausted failures and resets after half-open success", async () => {
  const originalFetch = globalThis.fetch;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-provider-circuit-"));
  const runtimeHealth = new RuntimeHealth({
    projectStateDir: path.join(root, ".mj-code"),
    runtimeCircuitFailureThreshold: 2,
    runtimeCircuitCooldownMs: 20,
    runtimeCircuitHalfOpenMaxRequests: 1,
  });
  await runtimeHealth.initialize();

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("gateway down", { status: 503 });
  };

  try {
    const runtime = new ProviderRuntime({
      provider: "openai-compatible",
      providerMaxRetries: 0,
      providerRetryBudgetMs: 200,
      providerTimeoutMs: 200,
      runtimeCircuitFailureThreshold: 2,
      runtimeCircuitCooldownMs: 20,
      runtimeCircuitHalfOpenMaxRequests: 1,
    }, {
      providerName: "openai-compatible",
      runtimeHealth,
    });

    await assert.rejects(() => runtime.requestText({
      url: "https://example.test/models",
      requestType: "models_list",
    }));
    await assert.rejects(() => runtime.requestText({
      url: "https://example.test/models",
      requestType: "models_list",
    }));

    await assert.rejects(
      () => runtime.requestText({
        url: "https://example.test/models",
        requestType: "models_list",
      }),
      (error) => {
        assert.equal(error.taxonomy, "provider_circuit_open");
        return true;
      },
    );
    assert.equal(calls, 2);
    assert.equal(runtimeHealth.listCircuits()[0].state, "open");

    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.4" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await runtime.requestText({
      url: "https://example.test/models",
      requestType: "models_list",
    });
    assert.equal(JSON.parse(response.rawText).data[0].id, "gpt-5.4");
    assert.equal(runtimeHealth.listCircuits()[0].state, "closed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anthropic-compatible provider uses official auth headers and parses text blocks", async () => {
  const originalFetch = globalThis.fetch;
  let observedHeaders = null;

  globalThis.fetch = async (_url, init = {}) => {
    observedHeaders = init.headers;
    return new Response(JSON.stringify({
      content: [
        { type: "text", text: "anthropic ok" },
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 5,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const provider = new AnthropicCompatibleProvider({
      provider: "anthropic-compatible",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com/v1",
      authMode: "auto",
      extraHeaders: {},
      providerMaxRetries: 0,
      providerRetryBudgetMs: 1000,
      providerTimeoutMs: 500,
    });

    const result = await provider.complete({
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      model: "claude-sonnet-4-20250514",
      maxTokens: 64,
      streamOutput: false,
    });

    assert.equal(result.text, "anthropic ok");
    assert.equal(result.usage.input_tokens, 3);
    assert.equal(observedHeaders["x-api-key"], "test-key");
    assert.equal("Authorization" in observedHeaders, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
