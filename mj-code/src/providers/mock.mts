import type {
  ProviderCompletionRequest,
  ProviderCompletionResult,
  ProviderListModelsOptions,
  ProviderMessage,
} from "../types/contracts.js";

interface MockToolResultPayload {
  result?: {
    cwd?: string;
    [key: string]: unknown;
  };
}

export class MockProvider {
  readonly capabilities: {
    nativeToolCalling: true;
    modelListing: true;
    streaming: true;
  };

  constructor() {
    this.capabilities = {
      nativeToolCalling: true,
      modelListing: true,
      streaming: true,
    };
  }

  async complete({
    messages,
    onTextDelta = null,
    streamOutput = false,
    tools = [],
  }: ProviderCompletionRequest): Promise<ProviderCompletionResult> {
    const lastMessage = messages[messages.length - 1];

    if (lastMessage?.role === "tool" && lastMessage.name === "pwd") {
      const payload = tryParseJsonBlock(lastMessage);
      const resultPayload = payload?.result ?? {};
      const cwd = typeof resultPayload.cwd === "string" ? resultPayload.cwd : "unknown";
      const result: ProviderCompletionResult = {
        text: `The current working directory is ${cwd}.`,
        usage: null,
        meta: {
          provider: "mock",
          mode: streamOutput ? "stream" : "non-stream",
        },
      };
      return maybeStream(result, streamOutput, onTextDelta);
    }

    const lastUserPrompt = [...messages].reverse().find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        !message.content.startsWith('Tool result for "'),
    );

    const prompt = lastUserPrompt?.content?.toLowerCase() ?? "";
    if (prompt.includes("current working directory") || prompt.includes("cwd")) {
      if (Array.isArray(tools) && tools.length > 0) {
        return {
          text: "",
          usage: null,
          toolCalls: [
            {
              id: "mock_tool_call_pwd",
              name: "pwd",
              input: {},
            },
          ],
          meta: {
            provider: "mock",
            mode: "tool-call",
          },
        };
      }

      const legacyResult: ProviderCompletionResult = {
        text: JSON.stringify({
          type: "tool_call",
          tool: "pwd",
          input: {},
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: streamOutput ? "stream-legacy" : "legacy",
        },
      };
      return maybeStream(legacyResult, streamOutput, onTextDelta);
    }

    const result: ProviderCompletionResult = {
      text: "Mock provider response: MJ Code is wired correctly.",
      usage: null,
      meta: {
        provider: "mock",
        mode: streamOutput ? "stream" : "non-stream",
      },
    };
    return maybeStream(result, streamOutput, onTextDelta);
  }

  async listModels(_options: ProviderListModelsOptions = {}): Promise<string[]> {
    return ["mock-mj-code-v1"];
  }
}

function tryParseJsonBlock(message: ProviderMessage | null | undefined): MockToolResultPayload | null {
  if (!message || typeof message.content !== "string") {
    return null;
  }

  const raw = message.content;
  const start = raw.indexOf("{");
  if (start === -1) {
    return null;
  }

  const jsonText = extractBalancedJson(raw.slice(start));
  if (!jsonText) {
    return null;
  }

  try {
    return JSON.parse(jsonText) as MockToolResultPayload;
  } catch {
    return null;
  }
}

function extractBalancedJson(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1);
      }
    }
  }

  return null;
}

async function maybeStream(
  result: ProviderCompletionResult,
  streamOutput: boolean,
  onTextDelta: ProviderCompletionRequest["onTextDelta"],
): Promise<ProviderCompletionResult> {
  if (!streamOutput || typeof onTextDelta !== "function") {
    return result;
  }

  for (const chunk of chunkString(result.text, 18)) {
    await onTextDelta(chunk);
  }

  return result;
}

function chunkString(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks;
}
