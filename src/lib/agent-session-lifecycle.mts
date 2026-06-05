import {
  emitLifecycleHook,
  formatLifecycleContext,
  mergeLifecycleContexts,
} from "./agent-lifecycle-hooks.mjs";

import type { LoadedConfig } from "../config.mjs";
import type {
  HookEmitResult,
  TraceSummary,
} from "../types/contracts.js";
import type { LifecycleContextEntry } from "./agent-lifecycle-hooks.mjs";

interface HookRunnerLike {
  emit: (
    eventName: string,
    payload?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<HookEmitResult>;
}

interface LifecycleAgentLike {
  config: LoadedConfig;
  hookRunner: HookRunnerLike | null;
  sessionId: string | null;
  parentSessionId: string | null;
  resumedFromSessionId: string | null;
  sessionFilePath: string | null;
  messages: Array<{ role?: string; content?: unknown }>;
  projectInstructions: {
    files?: string[];
    content?: string | null;
  };
  contextManager: {
    getRollingSummary(): string;
  };
  lastTrace: TraceSummary | null;
  lifecycleSessionContexts: LifecycleContextEntry[];
  lifecycleTurnContexts: LifecycleContextEntry[];
  refreshSystemPrompt(): void;
}

export async function runSessionStartHooks(
  agent: LifecycleAgentLike,
  trigger: "create" | "resume" | "resume_command",
): Promise<void> {
  const outcome = await emitLifecycleHook(
    agent.hookRunner,
    "session_start",
    {
      trigger,
      sessionId: agent.sessionId,
      parentSessionId: agent.parentSessionId,
      resumedFromSessionId: agent.resumedFromSessionId,
      sessionFilePath: agent.sessionFilePath,
      provider: agent.config.provider,
      model: agent.config.model,
      cwd: agent.config.cwd,
      instructionFiles: agent.projectInstructions.files ?? [],
    },
    buildLifecycleContext(agent),
    { allowBlock: false },
  );

  if (outcome.contextEntries.length > 0) {
    agent.lifecycleSessionContexts = mergeLifecycleContexts(
      agent.lifecycleSessionContexts,
      outcome.contextEntries.filter((entry) => entry.scope === "session"),
    );
    agent.refreshSystemPrompt();
  }
}

export async function runSessionEndHooks(agent: LifecycleAgentLike): Promise<void> {
  await emitLifecycleHook(
    agent.hookRunner,
    "session_end",
    {
      sessionId: agent.sessionId,
      parentSessionId: agent.parentSessionId,
      resumedFromSessionId: agent.resumedFromSessionId,
      sessionFilePath: agent.sessionFilePath,
      messageCount: agent.messages.length,
      rollingSummary: agent.contextManager.getRollingSummary(),
      lastTraceId: agent.lastTrace?.traceId ?? null,
    },
    buildLifecycleContext(agent),
    { allowBlock: false },
  );
}

export async function runPromptSubmitHooks(
  agent: LifecycleAgentLike,
  prompt: string,
): Promise<{
  blocked: boolean;
  blockReason: string | null;
  contextEntries: LifecycleContextEntry[];
}> {
  const outcome = await emitLifecycleHook(
    agent.hookRunner,
    "user_prompt_submit",
    {
      prompt,
      sessionId: agent.sessionId,
      parentSessionId: agent.parentSessionId,
      messageCount: agent.messages.length,
      lastTraceId: agent.lastTrace?.traceId ?? null,
    },
    buildLifecycleContext(agent),
    { allowBlock: true },
  );

  return {
    blocked: outcome.blocked,
    blockReason: outcome.blockReason,
    contextEntries: outcome.contextEntries.filter((entry) => entry.scope === "turn"),
  };
}

export async function runPreCompactHooks(agent: LifecycleAgentLike): Promise<void> {
  await emitLifecycleHook(
    agent.hookRunner,
    "pre_compact",
    {
      sessionId: agent.sessionId,
      parentSessionId: agent.parentSessionId,
      messageCount: agent.messages.length,
      hasRollingSummary: Boolean(agent.contextManager.getRollingSummary()),
      lastTraceId: agent.lastTrace?.traceId ?? null,
    },
    buildLifecycleContext(agent),
    { allowBlock: false },
  );
}

export function applyTurnLifecycleContexts(
  agent: LifecycleAgentLike,
  entries: LifecycleContextEntry[],
): void {
  agent.lifecycleTurnContexts = entries;
}

export function clearTurnLifecycleContexts(agent: LifecycleAgentLike): void {
  agent.lifecycleTurnContexts = [];
}

export function renderLifecycleContextBlock(agent: LifecycleAgentLike): string {
  return formatLifecycleContext([
    ...agent.lifecycleSessionContexts,
    ...agent.lifecycleTurnContexts,
  ]);
}

function buildLifecycleContext(agent: LifecycleAgentLike): {
  sessionId: string | null;
  parentSessionId: string | null;
  rootSessionId: string | null;
} {
  return {
    sessionId: agent.sessionId,
    parentSessionId: agent.parentSessionId,
    rootSessionId: agent.parentSessionId ?? agent.sessionId,
  };
}
