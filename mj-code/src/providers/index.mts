import { AnthropicCompatibleProvider } from "./anthropic-compatible.mjs";
import { MockProvider } from "./mock.mjs";
import { OpenAiCompatibleProvider } from "./openai-compatible.mjs";

import type {
  ProviderCompletionRequest,
  ProviderCompletionResult,
  ProviderListModelsOptions,
} from "../types/contracts.js";

export interface ProviderAdapter {
  capabilities?: {
    nativeToolCalling?: boolean;
    modelListing?: boolean;
    streaming?: boolean;
  };
  listModels?(options?: ProviderListModelsOptions): Promise<string[]>;
  complete?(request: ProviderCompletionRequest): Promise<ProviderCompletionResult>;
}

export function createProvider(
  config: Record<string, unknown> & { provider?: string | null },
  options: Record<string, unknown> = {},
): ProviderAdapter {
  if (config.provider === "mock") {
    return new MockProvider() as ProviderAdapter;
  }

  if (config.provider === "anthropic-compatible") {
    return new AnthropicCompatibleProvider(config as never, options as never);
  }

  if (config.provider === "openai-compatible") {
    return new OpenAiCompatibleProvider(config as never, options as never);
  }

  throw new Error(`Unsupported provider "${config.provider}".`);
}
