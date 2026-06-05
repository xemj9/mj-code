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

type AnthropicCompatibleConfig = Pick<
  LoadedConfig,
  | "provider"
  | "apiKey"
  | "baseUrl"
  | "authMode"
  | "extraHeaders"
  | "providerTimeoutMs"
  | "providerMaxRetries"
  | "providerRetryBudgetMs"
>;

interface ProviderOptions {
  runtimeHealth?: unknown;
}

// --- Anthropic API types ---

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema: ProviderToolDefinition["inputSchema"];
}

interface AnthropicRequestMessage {
  role: "assistant" | "user";
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequestBody {
  model: string;
  system: string;
  max_tokens?: number;
  messages: AnthropicRequestMessage[];
  tools?: AnthropicToolDefinition[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "none" };
  stream?: boolean;
}

interface AnthropicMessagePayload {
  content?: AnthropicContentBlock[] | null;
  usage?: ProviderUsageSummary | null;
}

interface AnthropicStreamPayload {
  type?: string | null;
  delta?: {
    text?: string | null;
    stop_reason?: string | null;
    partial_json?: string | null;
  } | null;
  content_block?: {
    type?: string | null;
    id?: string | null;
    name?: string | null;
    input?: Record<string, unknown>;
  } | null;
  message?: {
    usage?: ProviderUsageSummary | null;
  } | null;
  usage?: ProviderUsageSummary | null;
  index?: number;
}

interface AnthropicModelsPayload {
  data?: Array<{
    id?: string | null;
  }>;
}

interface SseMessageEvent {
  data?: string | null;
}

export class AnthropicCompatibleProvider {
  readonly config: AnthropicCompatibleConfig;
  readonly runtime: ProviderRuntime;
  readonly capabilities: {
    nativeToolCalling: true;
    modelListing: true;
    streaming: true;
  };

  constructor(config: AnthropicCompatibleConfig, options: ProviderOptions = {}) {
    this.config = config;
    this.runtime = new ProviderRuntime(config, {
      providerName: "anthropic-compatible",
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
    streamOutput = false,
    onTextDelta = null,
    tools = [],
    traceId = null,
    onProviderEvent = null,
  }: ProviderCompletionRequest): Promise<ProviderCompletionResult> {
    if (!this.config.apiKey) {
      throw new Error("Missing API key for the Anthropic-compatible provider.");
    }

    if (!this.config.baseUrl) {
      throw new Error("Missing base URL for the Anthropic-compatible provider.");
    }

    if (!model) {
      throw new Error("Missing model for the Anthropic-compatible provider.");
    }

    const endpoint = buildAnthropicEndpoint(this.config.baseUrl);
    const requestBody: AnthropicRequestBody = {
      model,
      system: systemPrompt,
      max_tokens: maxTokens,
      messages: normalizeMessages(messages),
    };

    if (Array.isArray(tools) && tools.length > 0) {
      requestBody.tools = normalizeTools(tools);
      requestBody.tool_choice = { type: "auto" };
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
          provider: "anthropic-compatible",
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
      headers: buildHeaders(this.config),
      body: JSON.stringify(requestBody),
      requestType,
      traceId,
      onEvent: onProviderEvent,
    });
    const payload = JSON.parse(response.rawText) as AnthropicMessagePayload;
    const toolCalls = extractToolCalls(payload.content);

    return {
      text: extractAnthropicText(payload.content),
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
      throw new Error("Missing API key for the Anthropic-compatible provider.");
    }
    if (!this.config.baseUrl) {
      throw new Error("Missing base URL for the Anthropic-compatible provider.");
    }

    const response = await this.runtime.requestText({
      url: buildModelsEndpoint(this.config.baseUrl),
      method: "GET",
      headers: buildHeaders(this.config),
      requestType: "models_list",
      traceId,
      onEvent: onProviderEvent,
    });
    const payload = JSON.parse(response.rawText) as AnthropicModelsPayload;
    return Array.isArray(payload.data)
      ? payload.data.map((item) => item.id).filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  }

  async completeWithStreaming(
    endpoint: string,
    requestBody: AnthropicRequestBody,
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
      headers: buildHeaders(this.config),
      body: JSON.stringify({
        ...requestBody,
        stream: true,
      }),
      requestType,
      traceId,
      onEvent: onProviderEvent,
    });

    let text = "";
    let usage: ProviderUsageSummary | null = null;

    // Streaming tool call builders indexed by content block index
    const toolCallBuilders: Map<number, {
      id: string;
      name: string;
      arguments: string;
    }> = new Map();

    try {
      await readSseStream(streamResponse.response.body, async (event: SseMessageEvent) => {
        if (!event.data) {
          return;
        }

        const payload = JSON.parse(event.data) as AnthropicStreamPayload;

        // Text delta
        if (payload.type === "content_block_delta" && typeof payload.delta?.text === "string") {
          text += payload.delta.text;
          if (typeof onTextDelta === "function") {
            await onTextDelta(payload.delta.text);
          }
        }

        // Tool use input JSON delta (Anthropic streams tool input as partial JSON)
        if (payload.type === "content_block_delta" && typeof payload.delta?.partial_json === "string") {
          const index = payload.index ?? 0;
          const current = toolCallBuilders.get(index);
          if (current) {
            current.arguments += payload.delta.partial_json;
          }
        }

        // New content block start — could be a tool_use block
        if (payload.type === "content_block_start" && payload.content_block?.type === "tool_use") {
          const index = payload.index ?? toolCallBuilders.size;
          toolCallBuilders.set(index, {
            id: payload.content_block.id ?? `tool_call_${index + 1}`,
            name: payload.content_block.name ?? "",
            arguments: "",
          });
        }

        if (payload.type === "message_start" && payload.message?.usage) {
          usage = payload.message.usage;
        }

        if (payload.type === "message_delta" && payload.usage) {
          usage = payload.usage;
        }
      });
    } catch (error) {
      const normalized = normalizeProviderError(error, {
        provider: "anthropic-compatible",
        requestType,
        traceId: streamResponse.meta.traceId,
        attempt: streamResponse.meta.attemptCount,
        streamAttempt: true,
      });
      normalized.partialStream = text.length > 0 || toolCallBuilders.size > 0;
      normalized.fallbackSuggested = normalized.fallbackSuggested && !normalized.partialStream;
      throw normalized;
    }

    // Build tool calls from streamed builders
    const toolCalls: ProviderToolCall[] = [];
    for (const [index, builder] of toolCallBuilders) {
      if (!builder.name) continue;
      toolCalls.push({
        id: builder.id || `tool_call_${index + 1}`,
        name: builder.name,
        input: parseToolInput(builder.arguments),
        rawArguments: builder.arguments,
      });
    }

    return {
      text,
      usage,
      toolCalls,
      meta: {
        ...streamResponse.meta,
      },
    };
  }
}

function buildAnthropicEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

function buildModelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function normalizeMessages(messages: ProviderMessage[]): AnthropicRequestMessage[] {
  const normalized: AnthropicRequestMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      normalized.push({
        role: "user",
        content: message.content,
      });
      continue;
    }

    if (message.role === "assistant") {
      // If the assistant message contains tool calls, represent them as content blocks
      if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        const content: AnthropicContentBlock[] = [];
        // Add text block if there is any text content
        if (message.content) {
          content.push({ type: "text", text: message.content });
        }
        // Add tool_use blocks
        for (const toolCall of message.toolCalls) {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input ?? {},
          });
        }
        normalized.push({ role: "assistant", content });
      } else {
        normalized.push({
          role: "assistant",
          content: message.content,
        });
      }
      continue;
    }

    if (message.role === "tool") {
      // Anthropic expects tool_result inside a user message
      // If the last message is also a user message with tool_result, append to it
      const toolResultBlock: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      };

      const lastMessage = normalized[normalized.length - 1];
      if (lastMessage && lastMessage.role === "user" && Array.isArray(lastMessage.content)) {
        // Append to existing user message (multiple tool results go in one user message)
        (lastMessage.content as AnthropicContentBlock[]).push(toolResultBlock);
      } else {
        normalized.push({
          role: "user",
          content: [toolResultBlock],
        });
      }
      continue;
    }

    // Fallback: treat unknown roles as user
    normalized.push({
      role: "user",
      content: message.content,
    });
  }

  return normalized;
}

function normalizeTools(tools: ProviderToolDefinition[]): AnthropicToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function extractToolCalls(content: AnthropicContentBlock[] | null | undefined): ProviderToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
    .map((block, index) => ({
      id: block.id ?? `tool_call_${index + 1}`,
      name: block.name,
      input: block.input ?? {},
      rawArguments: JSON.stringify(block.input ?? {}),
    }));
}

function extractAnthropicText(content: AnthropicContentBlock[] | null | undefined): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function parseToolInput(rawArguments: string): Record<string, unknown> {
  if (!rawArguments || !rawArguments.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // Partial JSON from streaming — try to accumulate, return empty for now
    return {};
  }
}

function buildHeaders(config: AnthropicCompatibleConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...normalizeHeaderMap(config.extraHeaders),
  };

  const authMode = config.authMode ?? "auto";
  const useOfficialHeaders =
    authMode === "x-api-key" ||
    (authMode === "auto" && typeof config.baseUrl === "string" && config.baseUrl.includes("anthropic.com"));

  if (useOfficialHeaders) {
    headers["x-api-key"] = config.apiKey ?? "";
  } else {
    headers.Authorization = `Bearer ${config.apiKey ?? ""}`;
  }

  return headers;
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
