import type { LoadedConfig } from "../config.mjs";
import { readSseStream } from "../lib/sse.mjs";
import {
  normalizeProviderError,
  serializeProviderError,
  shouldFallbackFromStreamError,
} from "../lib/provider-errors.mjs";
import { ProviderRuntime } from "../lib/provider-runtime.mjs";

import type {
  ProviderCompletionRequest,
  ProviderCompletionResult,
  ProviderListModelsOptions,
  ProviderMessage,
  ProviderToolCall,
  ProviderToolDefinition,
  ProviderUsageSummary,
} from "../types/contracts.js";

type OpenAiCompatibleConfig = Pick<
  LoadedConfig,
  | "provider"
  | "apiKey"
  | "baseUrl"
  | "extraHeaders"
  | "providerTimeoutMs"
  | "providerMaxRetries"
  | "providerRetryBudgetMs"
>;

interface ProviderOptions {
  runtimeHealth?: unknown;
}

interface OpenAiContentPart {
  text?: string;
  content?: string;
}

interface OpenAiResponseToolCall {
  id?: string | null;
  function?: {
    name?: string | null;
    arguments?: string | null;
  } | null;
}

interface OpenAiChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string | OpenAiContentPart[] | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAiResponseToolCall[] | null;
    } | null;
  }>;
  usage?: ProviderUsageSummary | null;
}

interface OpenAiToolCallDelta {
  index?: number | null;
  id?: string | null;
  function?: {
    name?: string | null;
    arguments?: string | null;
  } | null;
}

interface OpenAiStreamPayload {
  choices?: Array<{
    delta?: {
      content?: string | OpenAiContentPart[] | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAiToolCallDelta[] | null;
    } | null;
  }>;
  usage?: ProviderUsageSummary | null;
}

interface OpenAiModelsPayload {
  data?: Array<{
    id?: string | null;
  }>;
}

interface OpenAiRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface OpenAiRequestBody {
  model: string;
  messages: OpenAiRequestMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: ProviderToolDefinition["inputSchema"];
    };
  }>;
  tool_choice?: "auto";
}

interface StreamedToolCallBuilder {
  id: string | null;
  name: string;
  arguments: string;
}

interface SseMessageEvent {
  data?: string | null;
}

export class OpenAiCompatibleProvider {
  readonly config: OpenAiCompatibleConfig;
  readonly runtime: ProviderRuntime;
  readonly capabilities: {
    nativeToolCalling: true;
    modelListing: true;
    streaming: true;
  };

  constructor(config: OpenAiCompatibleConfig, options: ProviderOptions = {}) {
    this.config = config;
    this.runtime = new ProviderRuntime(config, {
      providerName: "openai-compatible",
      runtimeHealth: options.runtimeHealth ?? null,
    });
    this.capabilities = {
      nativeToolCalling: true,
      modelListing: true,
      streaming: true,
    };
  }

  async complete({
    systemPrompt,
    messages,
    model,
    maxTokens,
    temperature,
    streamOutput = false,
    onTextDelta = null,
    tools = [],
    traceId = null,
    onProviderEvent = null,
  }: ProviderCompletionRequest): Promise<ProviderCompletionResult> {
    if (!this.config.apiKey) {
      throw new Error("Missing API key for the OpenAI-compatible provider.");
    }

    if (!this.config.baseUrl) {
      throw new Error("Missing base URL for the OpenAI-compatible provider.");
    }

    if (!model) {
      throw new Error("Missing model for the OpenAI-compatible provider.");
    }

    const endpoint = buildOpenAiEndpoint(this.config.baseUrl);
    const requestBody: OpenAiRequestBody = {
      model,
      messages: normalizeMessages(systemPrompt, messages),
      temperature,
      max_tokens: maxTokens,
    };

    if (Array.isArray(tools) && tools.length > 0) {
      requestBody.tools = normalizeTools(tools);
      requestBody.tool_choice = "auto";
    }

    const requestType =
      Array.isArray(tools) && tools.length > 0
        ? "tool_completion"
        : streamOutput
          ? "stream_completion"
          : "non_stream_completion";

    if (streamOutput) {
      try {
        return await this.completeWithStreaming(endpoint, requestBody, onTextDelta, {
          traceId,
          onProviderEvent,
          requestType,
        });
      } catch (error) {
        if (!shouldFallbackFromStreamError(error)) {
          throw error;
        }
        await onProviderEvent?.({
          type: "provider_stream_fallback",
          provider: "openai-compatible",
          requestType,
          traceId: typeof error === "object" && error && "traceId" in error
            ? (error.traceId as string | null | undefined) ?? traceId
            : traceId,
          error: serializeProviderError(error),
        });
      }
    }

    const response = await this.runtime.requestText({
      url: endpoint,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        ...normalizeHeaderMap(this.config.extraHeaders),
      },
      body: JSON.stringify(requestBody),
      requestType,
      traceId,
      onEvent: onProviderEvent,
    });
    const payload = JSON.parse(response.rawText) as OpenAiChatCompletionPayload;
    const content = payload.choices?.[0]?.message?.content;
    const reasoningContent = payload.choices?.[0]?.message?.reasoning_content;
    const toolCalls = normalizeToolCalls(payload.choices?.[0]?.message?.tool_calls);

    // Combine reasoning and content for thinking models like GLM-5
    const mainText = extractText(content);
    const reasoning = typeof reasoningContent === "string" && reasoningContent.trim()
      ? reasoningContent.trim()
      : "";

    return {
      text: reasoning && !mainText
        ? reasoning
        : mainText
          ? mainText
          : reasoning,
      usage: payload.usage ?? null,
      toolCalls,
      meta: {
        ...response.meta,
        fallbackUsed: streamOutput,
      },
    };
  }

  async listModels({
    traceId = null,
    onProviderEvent = null,
  }: ProviderListModelsOptions = {}): Promise<string[]> {
    if (!this.config.apiKey) {
      throw new Error("Missing API key for the OpenAI-compatible provider.");
    }
    if (!this.config.baseUrl) {
      throw new Error("Missing base URL for the OpenAI-compatible provider.");
    }

    const response = await this.runtime.requestText({
      url: buildModelsEndpoint(this.config.baseUrl),
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...normalizeHeaderMap(this.config.extraHeaders),
      },
      requestType: "models_list",
      traceId,
      onEvent: onProviderEvent,
    });
    const payload = JSON.parse(response.rawText) as OpenAiModelsPayload;
    return Array.isArray(payload.data)
      ? payload.data.map((item) => item.id).filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  }

  async completeWithStreaming(
    endpoint: string,
    requestBody: OpenAiRequestBody,
    onTextDelta: ProviderCompletionRequest["onTextDelta"],
    {
      traceId,
      onProviderEvent,
      requestType,
    }: {
      traceId: string | null;
      onProviderEvent: ProviderCompletionRequest["onProviderEvent"];
      requestType: string;
    },
  ): Promise<ProviderCompletionResult> {
    const streamResponse = await this.runtime.requestStream({
      url: endpoint,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        ...normalizeHeaderMap(this.config.extraHeaders),
      },
      body: JSON.stringify({
        ...requestBody,
        stream: true,
        stream_options: { include_usage: true },
      }),
      requestType,
      traceId,
      onEvent: onProviderEvent,
    });

    let text = "";
    let reasoningText = "";
    let hasContentStarted = false;
    let usage: ProviderUsageSummary | null = null;
    const toolCallBuilders: StreamedToolCallBuilder[] = [];

    try {
      await readSseStream(streamResponse.response.body, async (event: SseMessageEvent) => {
        if (!event.data || event.data === "[DONE]") {
          return;
        }

        const payload = JSON.parse(event.data) as OpenAiStreamPayload;
        if (payload.usage) {
          usage = payload.usage;
        }

        // Handle reasoning_content (used by thinking models like GLM-5)
        const reasoningDelta = payload.choices?.[0]?.delta?.reasoning_content;
        if (typeof reasoningDelta === "string" && reasoningDelta) {
          reasoningText += reasoningDelta;
        }

        const delta = extractTextDelta(payload.choices?.[0]?.delta?.content);
        if (delta) {
          if (!hasContentStarted) {
            hasContentStarted = true;
            // When content starts, signal the reasoning-to-content transition
            // by emitting a newline separator if there was reasoning before
            if (reasoningText && typeof onTextDelta === "function") {
              await onTextDelta("\n");
            }
          }
          text += delta;
          if (typeof onTextDelta === "function") {
            await onTextDelta(delta);
          }
        }

        const deltaToolCalls = payload.choices?.[0]?.delta?.tool_calls;
        if (Array.isArray(deltaToolCalls)) {
          for (const toolCallDelta of deltaToolCalls) {
            const index = Number.isInteger(toolCallDelta.index) ? Number(toolCallDelta.index) : 0;
            const current = toolCallBuilders[index] ?? {
              id: null,
              name: "",
              arguments: "",
            };

            if (toolCallDelta.id) {
              current.id = toolCallDelta.id;
            }

            if (typeof toolCallDelta.function?.name === "string") {
              current.name += toolCallDelta.function.name;
            }

            if (typeof toolCallDelta.function?.arguments === "string") {
              current.arguments += toolCallDelta.function.arguments;
            }

            toolCallBuilders[index] = current;
          }
        }
      });
    } catch (error) {
      const normalized = normalizeProviderError(error, {
        provider: "openai-compatible",
        requestType,
        traceId: streamResponse.meta.traceId,
        attempt: streamResponse.meta.attemptCount,
        streamAttempt: true,
      });
      normalized.partialStream = text.length > 0 || toolCallBuilders.length > 0;
      normalized.fallbackSuggested = normalized.fallbackSuggested && !normalized.partialStream;
      throw normalized;
    }

    return {
      text: text || reasoningText,
      usage,
      toolCalls: toolCallBuilders
        .filter(Boolean)
        .map((item, index) => normalizeToolCall(item, index))
        .filter((item): item is ProviderToolCall => item != null),
      meta: {
        ...streamResponse.meta,
      },
    };
  }
}

function buildOpenAiEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

function buildModelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function extractText(content: string | OpenAiContentPart[] | null | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractTextDelta(deltaContent: string | OpenAiContentPart[] | null | undefined): string {
  if (typeof deltaContent === "string") {
    return deltaContent;
  }

  if (Array.isArray(deltaContent)) {
    return deltaContent
      .map((item) => item?.text ?? item?.content ?? "")
      .filter(Boolean)
      .join("");
  }

  return "";
}

function normalizeMessages(systemPrompt: string, messages: ProviderMessage[]): OpenAiRequestMessage[] {
  const normalized: OpenAiRequestMessage[] = [{ role: "system", content: systemPrompt }];

  for (const message of messages) {
    if (message.role === "user") {
      normalized.push({
        role: "user",
        content: message.content,
      });
      continue;
    }

    if (message.role === "assistant") {
      normalized.push({
        role: "assistant",
        content: message.content || null,
        ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.input ?? {}),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    if (message.role === "tool") {
      normalized.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
    }
  }

  return normalized;
}

function normalizeTools(
  tools: ProviderToolDefinition[],
): NonNullable<OpenAiRequestBody["tools"]> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function normalizeToolCalls(toolCalls: OpenAiResponseToolCall[] | null | undefined): ProviderToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall, index) =>
      normalizeToolCall(
        {
          id: toolCall.id ?? null,
          name: toolCall.function?.name ?? "",
          arguments: toolCall.function?.arguments ?? "{}",
        },
        index,
      ),
    )
    .filter((item): item is ProviderToolCall => item != null);
}

function normalizeToolCall(
  toolCall: StreamedToolCallBuilder,
  index: number,
): ProviderToolCall | null {
  if (!toolCall || !toolCall.name) {
    return null;
  }

  return {
    id: toolCall.id || `tool_call_${index + 1}`,
    name: toolCall.name,
    input: parseArguments(toolCall.arguments),
    rawArguments: toolCall.arguments ?? "{}",
  };
}

function parseArguments(rawArguments: string | null | undefined): Record<string, unknown> {
  if (typeof rawArguments !== "string" || !rawArguments.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {
      _raw: rawArguments,
    };
  }
}

function normalizeHeaderMap(headers: Record<string, unknown> | null | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value == null) {
      continue;
    }
    normalized[key] = `${value}`;
  }
  return normalized;
}
