import { MJCodeAgentCore as LegacyAgentCore } from "./agent-loop.mjs";
import {
  applyTurnLifecycleContexts,
  clearTurnLifecycleContexts,
  renderLifecycleContextBlock,
  runPreCompactHooks,
  runPromptSubmitHooks,
  runSessionEndHooks,
  runSessionStartHooks,
} from "./agent-session-lifecycle.mjs";

import type { LoadedConfig } from "../config.mjs";
import type { ProviderAdapter } from "../providers/index.mjs";
import type {
  AgentTerminalUi,
} from "../types/agent-facade.js";
import type {
  HookEmitResult,
  InstructionPack,
  RepairLoopRecord,
  TraceSummary,
  VerifierRunRecord,
} from "../types/contracts.js";
import type { AgentComponentBundle } from "./agent-components.mjs";
import type { LifecycleContextEntry } from "./agent-lifecycle-hooks.mjs";
import type { RuntimeHealth } from "./runtime-health.mjs";

type ProviderLike = ProviderAdapter;

type ProjectInstructionsLike = InstructionPack;

interface HookRunnerLike {
  emit: (
    eventName: string,
    payload?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<HookEmitResult>;
}

type LegacyRunUserInputResult = Awaited<ReturnType<LegacyAgentCore["runUserInput"]>>;
type LegacyResumeFromSessionResult = Awaited<ReturnType<LegacyAgentCore["resumeFromSession"]>>;

export class MJCodeAgentCore extends LegacyAgentCore {
  declare config: LoadedConfig;
  declare ui: AgentTerminalUi;
  declare provider: ProviderLike;
  declare projectInstructions: ProjectInstructionsLike;
  declare runtimeHealth: RuntimeHealth;
  declare hookRunner: HookRunnerLike | null;
  declare sessionId: string | null;
  declare parentSessionId: string | null;
  declare resumedFromSessionId: string | null;
  declare sessionFilePath: string | null;
  declare messages: Array<{ role?: string; content?: unknown }>;
  declare baseSystemPrompt: string;
  declare contextManager: AgentComponentBundle["contextManager"] & {
    getRollingSummary(): string;
    getLastPlan(): unknown;
    hydrate(input: {
      rollingSummary?: string;
      lastPlan?: unknown;
    }): void;
  };
  declare diagnosticProvider: AgentComponentBundle["diagnosticProvider"];
  declare lastTrace: TraceSummary | null;
  declare lastVerifierRun: VerifierRunRecord | null;
  declare lastRepairLoop: RepairLoopRecord | null;
  declare lifecycleSessionContexts: LifecycleContextEntry[];
  declare lifecycleTurnContexts: LifecycleContextEntry[];

  constructor(
    config: LoadedConfig,
    ui: AgentTerminalUi,
    provider: ProviderLike,
    projectInstructions: ProjectInstructionsLike,
    runtimeHealth: RuntimeHealth | null = null,
  ) {
    super(config, ui, provider, projectInstructions, runtimeHealth);
    this.lifecycleSessionContexts = [];
    this.lifecycleTurnContexts = [];
  }

  async afterSessionEntry(trigger: "create" | "resume"): Promise<void> {
    await runSessionStartHooks(this, trigger);
  }

  override refreshSystemPrompt(): ReturnType<LegacyAgentCore["refreshSystemPrompt"]> {
    const effectivePolicy = super.refreshSystemPrompt();
    const lifecycleContextBlock = renderLifecycleContextBlock(this);
    if (lifecycleContextBlock) {
      this.baseSystemPrompt = [this.baseSystemPrompt, lifecycleContextBlock].join("\n\n");
    }
    return effectivePolicy;
  }

  override async runUserInput(
    userInput: string,
  ): Promise<LegacyRunUserInputResult> {
    const prompt = `${userInput ?? ""}`.trim();
    if (!prompt) {
      return { content: "", steps: 0 } as LegacyRunUserInputResult;
    }

    const promptHook = await runPromptSubmitHooks(this, prompt);
    if (promptHook.blocked) {
      return {
        content: promptHook.blockReason ?? 'Prompt blocked by "user_prompt_submit" hook.',
        printed: false,
        steps: 0,
      } as LegacyRunUserInputResult;
    }

    applyTurnLifecycleContexts(this, promptHook.contextEntries);
    this.refreshSystemPrompt();
    try {
      return await super.runUserInput(prompt) as LegacyRunUserInputResult;
    } finally {
      clearTurnLifecycleContexts(this);
      this.refreshSystemPrompt();
    }
  }

  override async resumeFromSession(reference: string): Promise<LegacyResumeFromSessionResult> {
    const result = await super.resumeFromSession(reference) as LegacyResumeFromSessionResult;
    await runSessionStartHooks(this, "resume_command");
    return result;
  }

  override async compactConversation(): Promise<{
    messages: unknown[];
    compactedMessages: number;
    rollingSummary: string;
  }> {
    await runPreCompactHooks(this);
    return super.compactConversation() as Promise<{
      messages: unknown[];
      compactedMessages: number;
      rollingSummary: string;
    }>;
  }

  override async close(): Promise<void> {
    try {
      await runSessionEndHooks(this);
    } finally {
      await super.close();
    }
  }
}
