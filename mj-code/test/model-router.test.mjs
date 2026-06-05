import test from "node:test";
import assert from "node:assert/strict";

import { ModelRouter } from "../src/lib/model-router.mjs";

test("model router prefers stronger models for code edit work", () => {
  const router = new ModelRouter({
    provider: "openai-compatible",
    model: "gpt-5-mini",
    maxTokens: 1200,
  });

  const decision = router.route({
    taskClassification: {
      taskClass: "code_edit",
    },
    routeDecision: {
      selectedCapabilities: [],
    },
    runtimeHealth: { scorecard: { degradedFlags: [] } },
    availableModels: ["gpt-5-mini", "gpt-5.4"],
    currentModel: "gpt-5-mini",
    provider: "openai-compatible",
  });

  assert.equal(decision.chosenModel, "gpt-5.4");
  assert.ok(decision.fallbackModels.includes("gpt-5-mini"));
});

test("model router can prefer faster smaller models for docs lookup", () => {
  const router = new ModelRouter({
    provider: "openai-compatible",
    model: "gpt-5.4",
    maxTokens: 1200,
  });

  const decision = router.route({
    taskClassification: {
      taskClass: "official_docs_lookup",
    },
    routeDecision: {
      selectedCapabilities: [{ type: "web-tool" }],
    },
    runtimeHealth: { scorecard: { degradedFlags: [] } },
    availableModels: ["gpt-5-mini", "gpt-5.4"],
    currentModel: "gpt-5.4",
    provider: "openai-compatible",
  });

  assert.equal(decision.chosenModel, "gpt-5-mini");
  assert.equal(decision.latencyTarget, "balanced");
});

test("model router exposes conservative runtime pressure and fallback chain under retry pressure", () => {
  const router = new ModelRouter({
    provider: "openai-compatible",
    model: "gpt-5.4",
    maxTokens: 1200,
  });

  const decision = router.route({
    taskClassification: {
      taskClass: "code_edit",
    },
    routeDecision: {
      selectedCapabilities: [{ type: "builtin-tool" }],
    },
    runtimeHealth: {
      scorecard: {
        degradedFlags: ["high_retry_pressure", "provider_half_open"],
        retryPressure: 0.51,
        provider: { avgHealthScore: 63 },
        circuits: { byLayer: { provider: { halfOpen: 1 } } },
      },
    },
    availableModels: ["gpt-5-mini", "gpt-5.4"],
    currentModel: "gpt-5.4",
    provider: "openai-compatible",
  });

  assert.equal(decision.runtimePressure.mode, "conservative");
  assert.ok(Array.isArray(decision.fallbackChain));
  assert.equal(decision.fallbackChain[0].model, "gpt-5-mini");
});
