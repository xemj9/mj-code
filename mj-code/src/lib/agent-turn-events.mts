import { summarizeText } from "./agent-utils.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";

import type {
  ContextPlanMeta,
  ProviderCompletionMeta,
  ProviderToolCall,
  ProviderUsageSummary,
  RepairDecision,
  RepairLoopRecord,
  RepairLoopSummary,
  VerifierRunSummary,
} from "../types/contracts.js";

interface MessageLike {
  role?: string;
  content?: unknown;
  toolCalls?: ProviderToolCall[];
  [key: string]: unknown;
}

interface TurnStateLike {
  traceId: string;
  sourceIds: string[];
}

interface SessionStoreLike {
  append(type: string, payload?: unknown): Promise<unknown>;
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "append" | "recordPhase">;

export type AgentTurnEvent =
  | {
      type: "turn_user_input";
      traceId: string;
      prompt: string;
      promptSummary: string;
    }
  | {
      type: "turn_context_prepared";
      traceId: string;
      step: number;
      promptSummary: string;
      durationMs: number;
      meta: ContextPlanMeta;
    }
  | {
      type: "turn_assistant_message";
      traceId: string;
      step: number;
      content: string;
      contentSummary: string;
      durationMs: number;
      usage: ProviderUsageSummary | null;
      toolCalls: ProviderToolCall[];
      providerMeta: ProviderCompletionMeta | null;
    }
  | {
      type: "turn_repair_loop";
      traceId: string;
      step: number;
      repairLoop: RepairLoopRecord;
      decision: RepairDecision;
      repair: RepairLoopSummary;
    }
  | {
      type: "turn_finalized";
      traceId: string;
      step: number;
      content: string;
      contentSummary: string;
      success: boolean;
      stopped: boolean;
      printed: boolean;
      origin: "assistant_final" | "tool_fatal" | "provider_error" | "max_steps" | "verifier_failed";
      errorTaxonomy: string | null;
      sourceIds: string[];
      verifier?: VerifierRunSummary | null;
      repair?: RepairLoopSummary | null;
    };

export type AgentTurnEventSink = (
  event: AgentTurnEvent,
) => Promise<void> | void;

interface BaseTurnPersistenceDependencies {
  messages: MessageLike[];
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): Promise<unknown>;
  emitTurnEvent?: AgentTurnEventSink | null;
}

interface CompleteTurnDependencies extends BaseTurnPersistenceDependencies {
  recordTurnMemory(
    turnState: TurnStateLike,
    content: string,
    success: boolean,
    stopped: boolean,
  ): Promise<void>;
  finalizeTrace(
    turnState: TurnStateLike,
    input: {
      content: string;
      success: boolean;
      stopped: boolean;
      steps: number;
      errorTaxonomy?: string | null;
    },
  ): Promise<void>;
  printAssistant(content: string): boolean;
}

export async function recordAcceptedUserInput(
  dependencies: BaseTurnPersistenceDependencies,
  input: {
    turnState: TurnStateLike;
    prompt: string;
  },
): Promise<void> {
  const promptSummary = summarizeText(input.prompt, 180);
  dependencies.messages.push({ role: "user", content: input.prompt });
  await dependencies.sessionStore.append("user", {
    content: input.prompt,
    traceId: input.turnState.traceId,
  });
  await dependencies.executionJournal.recordPhase({
    traceId: input.turnState.traceId,
    stepId: 0,
    phase: "planning",
    inputSummary: promptSummary,
    outputSummary: "Accepted user input.",
    snapshot: await dependencies.captureStateSnapshot({
      traceId: input.turnState.traceId,
      phase: "planning",
      stepId: 0,
      outputSummary: "User message appended.",
    }),
  });
  await emitTurnEvent(dependencies, {
    type: "turn_user_input",
    traceId: input.turnState.traceId,
    prompt: input.prompt,
    promptSummary,
  });
}

export async function recordContextPrepared(
  dependencies: BaseTurnPersistenceDependencies,
  input: {
    turnState: TurnStateLike;
    step: number;
    prompt: string;
    meta: ContextPlanMeta;
    durationMs: number;
  },
): Promise<void> {
  await dependencies.sessionStore.append("context_prepared", {
    traceId: input.turnState.traceId,
    step: input.step,
    ...input.meta,
  });
  await dependencies.executionJournal.recordPhase({
    traceId: input.turnState.traceId,
    stepId: input.step,
    phase: "context_prepare",
    inputSummary: summarizeText(input.prompt, 120),
    outputSummary: `Prepared context with ${input.meta.memoryItems} memory item(s).`,
    metrics: {
      durationMs: input.durationMs,
      compactedMessages: input.meta.compactedMessages,
      estimatedInputTokens: input.meta.estimatedInputTokens,
    },
    snapshot: await dependencies.captureStateSnapshot({
      traceId: input.turnState.traceId,
      phase: "context_prepare",
      stepId: input.step,
      outputSummary: `Context prepared for step ${input.step}.`,
    }),
  });
  await emitTurnEvent(dependencies, {
    type: "turn_context_prepared",
    traceId: input.turnState.traceId,
    step: input.step,
    promptSummary: summarizeText(input.prompt, 120),
    durationMs: input.durationMs,
    meta: input.meta,
  });
}

export async function recordAssistantMessage(
  dependencies: BaseTurnPersistenceDependencies,
  input: {
    turnState: TurnStateLike;
    step: number;
    content: string;
    durationMs: number;
    usage: ProviderUsageSummary | null;
    toolCalls: ProviderToolCall[];
    providerMeta: ProviderCompletionMeta | null;
  },
): Promise<void> {
  dependencies.messages.push({
    role: "assistant",
    content: input.content,
    ...(input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
  });
  await dependencies.sessionStore.append("assistant", {
    traceId: input.turnState.traceId,
    step: input.step,
    content: input.content,
    usage: input.usage,
    toolCalls: input.toolCalls,
  });
  const contentSummary = summarizeText(input.content, 180);
  await dependencies.executionJournal.recordPhase({
    traceId: input.turnState.traceId,
    stepId: input.step,
    phase: "model_complete",
    outputSummary: contentSummary || "Model returned tool calls.",
    metrics: {
      durationMs: input.durationMs,
      toolCalls: input.toolCalls.length,
      usage: input.usage,
      provider: input.providerMeta,
    },
    snapshot: await dependencies.captureStateSnapshot({
      traceId: input.turnState.traceId,
      phase: "model_complete",
      stepId: input.step,
      outputSummary: `Model completion finished for step ${input.step}.`,
    }),
  });
  await emitTurnEvent(dependencies, {
    type: "turn_assistant_message",
    traceId: input.turnState.traceId,
    step: input.step,
    content: input.content,
    contentSummary,
    durationMs: input.durationMs,
    usage: input.usage,
    toolCalls: input.toolCalls,
    providerMeta: input.providerMeta,
  });
}

export async function completeTurn(
  dependencies: CompleteTurnDependencies,
  input: {
    turnState: TurnStateLike;
    step: number;
    content: string;
    success: boolean;
    stopped: boolean;
    origin: "assistant_final" | "tool_fatal" | "provider_error" | "max_steps" | "verifier_failed";
    errorTaxonomy?: string | null;
    sourceIds: string[];
    print?: boolean;
    finalPayload?: Record<string, unknown>;
  },
): Promise<{ printed: boolean }> {
  const sourceIds = [...new Set(input.sourceIds)];
  await dependencies.sessionStore.append("final", {
    traceId: input.turnState.traceId,
    content: input.content,
    ...(input.stopped ? { stopped: true } : {}),
    steps: input.step,
    sourceIds,
    ...(input.finalPayload ?? {}),
  });
  await dependencies.recordTurnMemory(
    input.turnState,
    input.content,
    input.success,
    input.stopped,
  );
  await dependencies.finalizeTrace(input.turnState, {
    content: input.content,
    success: input.success,
    stopped: input.stopped,
    steps: input.step,
    errorTaxonomy: input.errorTaxonomy ?? null,
  });
  const printed = input.print === false ? false : dependencies.printAssistant(input.content);
  await emitTurnEvent(dependencies, {
    type: "turn_finalized",
    traceId: input.turnState.traceId,
    step: input.step,
    content: input.content,
    contentSummary: summarizeText(input.content, 180),
    success: input.success,
    stopped: input.stopped,
    printed,
    origin: input.origin,
    errorTaxonomy: input.errorTaxonomy ?? null,
    sourceIds,
    verifier: (input.finalPayload?.verifier as VerifierRunSummary | undefined) ?? null,
    repair: (input.finalPayload?.repair as RepairLoopSummary | undefined) ?? null,
  });
  return { printed };
}

export async function recordRepairLoop(
  dependencies: BaseTurnPersistenceDependencies,
  input: {
    turnState: TurnStateLike;
    step: number;
    repairLoop: RepairLoopRecord;
    decision: RepairDecision;
  },
): Promise<void> {
  await dependencies.sessionStore.append("repair_loop", {
    traceId: input.turnState.traceId,
    step: input.step,
    loop: input.repairLoop,
    decision: input.decision,
  });
  await dependencies.executionJournal.append({
    type: "repair_loop",
    traceId: input.turnState.traceId,
    stepId: input.step,
    phase: "repair",
    payload: {
      loop: input.repairLoop,
      decision: input.decision,
    },
  });
  await dependencies.executionJournal.recordPhase({
    traceId: input.turnState.traceId,
    stepId: input.step,
    phase: "repair",
    outputSummary: input.repairLoop.summary.summary,
    metrics: {
      summary: input.repairLoop.summary,
      decision: input.decision,
      lastAttempt: input.repairLoop.attempts.at(-1) ?? null,
    },
    error: input.decision.decision === "stop"
      ? {
          taxonomy: "repair_stopped",
          summary: input.decision.summary,
          stopReason: input.decision.stopReason,
        }
      : null,
    snapshot: await dependencies.captureStateSnapshot({
      traceId: input.turnState.traceId,
      phase: "repair",
      stepId: input.step,
      outputSummary: input.repairLoop.summary.summary,
    }),
  });
  await emitTurnEvent(dependencies, {
    type: "turn_repair_loop",
    traceId: input.turnState.traceId,
    step: input.step,
    repairLoop: input.repairLoop,
    decision: input.decision,
    repair: input.repairLoop.summary,
  });
}

async function emitTurnEvent(
  dependencies: BaseTurnPersistenceDependencies,
  event: AgentTurnEvent,
): Promise<void> {
  await dependencies.emitTurnEvent?.(event);
}
