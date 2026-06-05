const DEFAULT_CONTEXT_WINDOW = 64000;

const MODEL_RULES = [
  {
    pattern: /(claude|sonnet|opus|haiku)/i,
    contextWindow: 200000,
    family: "claude",
  },
  {
    pattern: /(gpt-5|gpt-4\.1|gpt-4o|o1|o3|o4)/i,
    contextWindow: 128000,
    family: "openai-modern",
  },
  {
    pattern: /gpt-4/i,
    contextWindow: 32000,
    family: "gpt-4",
  },
  {
    pattern: /gpt-3\.5/i,
    contextWindow: 16000,
    family: "gpt-3.5",
  },
];

export function getModelMetadata({ model, provider, maxOutputTokens }) {
  const normalizedModel = `${model ?? ""}`.trim();
  const matchedRule = MODEL_RULES.find((rule) => rule.pattern.test(normalizedModel));
  const contextWindow = matchedRule?.contextWindow ?? inferDefaultContextWindow(provider);

  return {
    model: normalizedModel || "unknown",
    provider,
    family: matchedRule?.family ?? "generic",
    contextWindow,
    maxOutputTokens: clampInteger(maxOutputTokens, 256, Math.floor(contextWindow * 0.3)),
  };
}

export function estimateTokensFromText(text) {
  const value = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return Math.max(1, Math.ceil(value.length / 4));
}

export function estimateTokensFromMessages(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((total, message) => {
    const contentTokens = estimateTokensFromText(message?.content ?? "");
    const toolTokens = estimateTokensFromText(message?.toolCalls ?? []);
    return total + contentTokens + toolTokens + 12;
  }, 0);
}

function inferDefaultContextWindow(provider) {
  if (provider === "anthropic-compatible") {
    return 200000;
  }

  if (provider === "openai-compatible") {
    return 128000;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

function clampInteger(value, minValue, maxValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return minValue;
  }

  return Math.max(minValue, Math.min(maxValue, Math.floor(parsed)));
}
