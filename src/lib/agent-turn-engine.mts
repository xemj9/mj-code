import {
  applySourceCitationsToFinalContent,
  classifyErrorTaxonomy,
} from "./agent-utils.mjs";
import {
  decideRepairLoopOnVerifierFailure,
  finalizeRepairLoopOnVerifierPass,
  finalizeRepairLoopOnTurnFailure,
  recordRepairCodeActionResult,
  selectRepairCodeActionCandidate,
} from "./agent-repair-loop.mjs";
import { runPostEditVerifier } from "./agent-verifier.mjs";
import {
  prepareCodeActionWriteInput,
  toCodeActionApplyBlockedReason,
} from "./code-action-assist.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";
import {
  completeTurn,
  recordAcceptedUserInput,
  recordAssistantMessage,
  recordContextPrepared,
  recordRepairLoop,
} from "./agent-turn-events.mjs";
import { buildSystemPrompt, extractAction } from "./json-protocol.mjs";
import {
  executeCompletionWithFallback,
  inferProviderRequestType,
} from "./model-execution.mjs";
import { serializeProviderError } from "./provider-errors.mjs";
import {
  prefetchLocalContextForPrompt,
  type LocalContextPrefetchResult,
} from "./local-context-prefetch.mjs";

import type {
  AgentIntelligence,
  CitationSummary,
  ChangeSetRecord,
  CodeActionApplyResult,
  ContextPlanMeta,
  DiagnosticProvider,
  ExtractedAction,
  ExecutionPlan,
  InstructionPack,
  ModelDecision,
  ProviderCompletionMeta,
  ProviderCompletionRequest,
  ProviderCompletionResult,
  ProviderToolCall,
  ProviderUsageSummary,
  RepairDecision,
  RepairLoopRecord,
  ResolvedConfig,
  RouteDecision,
  RuntimeHealthOverview,
  TaskClassification,
  ToolRegistrySurface,
  TraceSummary,
  VerifierRunRecord,
} from "../types/contracts.js";
import type { AgentTurnEventSink } from "./agent-turn-events.mjs";

interface StreamStateLike {
  displayed?: boolean;
  emittedContent?: string;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  name?: string;
  toolCallId?: string;
  toolCalls?: ProviderToolCall[];
  [key: string]: unknown;
}

interface TurnStateLike {
  traceId: string;
  prompt: string;
  startedAt: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolEvents: Array<Record<string, unknown>>;
  filesChanged: Set<string>;
  approvalsAsked: number;
  approvalsApproved: number;
  approvalsDenied: number;
  providerAttempts: number;
  providerRetries: number;
  providerFallbacks: number;
  modelFallbacks: number;
  providerEvents: Array<Record<string, unknown>>;
  providerMeta: Record<string, unknown> | null;
  shellJobs: Array<Record<string, unknown>>;
  skillInfluence: unknown;
  policySources: unknown;
  taskClassification: TaskClassification | null;
  routeDecision: RouteDecision | null;
  modelDecision: ModelDecision | null;
  executionPlan: ExecutionPlan | null;
  sourceCitations: CitationSummary[];
  sourceIds: string[];
  mcpCalls: Array<Record<string, unknown>>;
  webRequests: number;
  webRetries: number;
  webCacheHits: number;
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
  durations: {
    contextPrepareMs: number;
    modelCompleteMs: number;
    toolExecuteMs: number;
  };
}

interface PreparedContextLike {
  systemPrompt: string;
  messages: MessageLike[];
  meta: ContextPlanMeta;
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "append" | "recordPhase">;

interface ContextManagerLike {
  prepare(input: {
    baseSystemPrompt: string;
    messages: MessageLike[];
    userPrompt: string;
    memoryStore: unknown;
    model?: string | null;
    taskClassification?: TaskClassification | null;
    routeDecision?: RouteDecision | null;
    modelDecision?: ModelDecision | null;
    executionPlan?: ExecutionPlan | null;
    activeSkills?: unknown[];
    instructions?: InstructionPack | null;
    sourceRegistry?: unknown;
    policy?: unknown;
    runtimeHealth?: RuntimeHealthOverview | null;
  }): Promise<PreparedContextLike>;
}

interface PlannerLike {
  noteContextPrepared(plan: ExecutionPlan | null): ExecutionPlan | null;
  noteProviderFailure?(
    plan: ExecutionPlan | null,
    input: {
      taxonomy: string;
      summary: string;
    },
  ): ExecutionPlan | null;
  noteVerificationStarted(
    plan: ExecutionPlan | null,
    input?: {
      note?: string | null;
    },
  ): ExecutionPlan | null;
  noteVerificationResult(
    plan: ExecutionPlan | null,
    input: {
      success: boolean;
      note?: string | null;
    },
  ): ExecutionPlan | null;
  noteRepairStarted(
    plan: ExecutionPlan | null,
    input: {
      attempt: number;
      maxAttempts: number;
      note?: string | null;
    },
  ): ExecutionPlan | null;
  noteRepairResult(
    plan: ExecutionPlan | null,
    input: {
      success: boolean;
      exhausted?: boolean;
      note?: string | null;
    },
  ): ExecutionPlan | null;
  noteFinal(
    plan: ExecutionPlan | null,
    input?: {
      success?: boolean;
      reasonKind?: string | null;
      note?: string | null;
    },
  ): ExecutionPlan | null;
}

interface SessionStoreLike {
  append(type: string, payload?: unknown): Promise<unknown>;
}

interface UiLike {
  beginAssistantStream?(): StreamStateLike | unknown;
  pushAssistantDelta?(state: unknown, delta: string): void;
  finishAssistantStream?(state: unknown): void;
  printInfo?(tag: string, message: string): void;
  printProviderFailure?(details: Record<string, unknown>): void;
  printProviderEvent?(event: Record<string, unknown>): void;
  printLocalContextPrefetch?(result: LocalContextPrefetchResult): void;
}

interface ProviderLike {
  complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResult>;
}

type ShellRuntimeLike = Parameters<typeof runPostEditVerifier>[0]["shellRuntime"];

interface ToolExecutionResult {
  ok: boolean;
  fatal?: boolean;
  error?: string;
  result?: unknown;
}

interface AgentTurnLoopLike {
  config: Pick<
    ResolvedConfig,
    | "cwd"
    | "maxSteps"
    | "maxTokens"
    | "temperature"
    | "streamOutput"
    | "model"
    | "provider"
    | "permissionMode"
    | "approvalPolicy"
    | "networkMode"
    | "maxReadChars"
  >;
  ui: UiLike & {
    printAssistant?(content: string): void;
  };
  messages: MessageLike[];
  baseSystemPrompt: string;
  provider: ProviderLike;
  nativeToolCalling: boolean;
  toolRegistry: ToolRegistrySurface;
  contextManager: ContextManagerLike;
  memoryStore: unknown;
  skillLoader: {
    getActiveSkills(): unknown[];
  };
  projectInstructions: InstructionPack;
  sourceRegistry: unknown;
  policyStack: {
    getEffectivePolicy(): unknown;
  };
  runtimeHealth: {
    getOverview(): RuntimeHealthOverview;
  };
  diagnosticProvider?: DiagnosticProvider | null;
  planner: PlannerLike;
  lastRouteDecision: RouteDecision | null;
  lastExecutionPlan: ExecutionPlan | null;
  lastModelDecision: ModelDecision | null;
  lastChangeSet: ChangeSetRecord | null;
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  shellRuntime: ShellRuntimeLike;
  approvalStats: {
    asked: number;
    approved: number;
    denied: number;
  };
  startTrace(prompt: string): TurnStateLike;
  prepareIntelligence(prompt: string, traceId?: string | null): Promise<AgentIntelligence>;
  handleToolExecution(input: {
    toolName: string;
    input?: Record<string, unknown>;
    toolCallId: string | null;
    turnState: TurnStateLike;
    step: number;
    nativeToolCall: boolean;
  }): Promise<ToolExecutionResult>;
  recordProviderEvent(
    event: Record<string, unknown>,
    turnState: TurnStateLike,
    step: number,
  ): Promise<void>;
  noteProviderMeta(
    turnState: TurnStateLike,
    meta: ProviderCompletionMeta | Record<string, unknown> | null | undefined,
  ): void;
  updateUsageTotals(usage: ProviderUsageSummary | null | undefined): void;
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
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): Promise<unknown>;
  emitTurnEvent?: AgentTurnEventSink | null;
}

export async function runAgentTurnLoop(
  agent: AgentTurnLoopLike,
  prompt: string,
): Promise<{
  content: string;
  steps: number;
  printed: boolean;
}> {
  const turnState = agent.startTrace(prompt);
  let turnNativeToolCalling = agent.nativeToolCalling;
  let turnSystemPrompt = agent.baseSystemPrompt;
  await recordAcceptedUserInput(agent, {
    turnState,
    prompt,
  });

  const intelligence = await agent.prepareIntelligence(prompt, turnState.traceId);
  turnState.taskClassification = intelligence.taskClassification;
  turnState.routeDecision = intelligence.routeDecision;
  turnState.modelDecision = intelligence.modelDecision;
  turnState.executionPlan = intelligence.executionPlan;
  await maybeAttachLocalContextPrefetch(agent, {
    prompt,
    turnState,
  });

  for (let step = 1; step <= agent.config.maxSteps; step += 1) {
    const preparedContext = await prepareTurnContext(agent, {
      prompt,
      turnState,
      intelligence,
      step,
      baseSystemPrompt: turnSystemPrompt,
    });

    const streamState = agent.config.streamOutput
      ? (agent.ui.beginAssistantStream?.() as StreamStateLike | null | undefined) ?? null
      : null;
    let modelRequest: {
      modelExecution: Awaited<ReturnType<typeof executeCompletionWithFallback>>;
      modelDurationMs: number;
    };

    try {
      modelRequest = await requestModelCompletion(agent, {
        turnState,
        intelligence,
        preparedContext,
        step,
        streamState,
        nativeToolCalling: turnNativeToolCalling,
      });
    } catch (error) {
      if (streamState && agent.ui.finishAssistantStream) {
        agent.ui.finishAssistantStream(streamState);
      }
      if (turnNativeToolCalling && shouldRetryWithJsonToolProtocol(error)) {
        turnNativeToolCalling = false;
        turnSystemPrompt = buildJsonToolProtocolPrompt(agent);
        await agent.recordProviderEvent({
          type: "provider_native_tool_protocol_fallback",
          provider: agent.config.provider,
          requestType: "tool_completion",
          traceId: turnState.traceId,
          step,
          error: serializeProviderError(error),
        }, turnState, step);
        agent.ui.printInfo?.(
          "provider",
          "Native tools failed; retrying this turn with JSON tool protocol.",
        );
        continue;
      }
      return finalizeProviderFailure(agent, {
        turnState,
        step,
        error,
      });
    }

    const modelDuration = recordModelUsage(agent, {
      turnState,
      modelExecution: modelRequest.modelExecution,
      modelDurationMs: modelRequest.modelDurationMs,
      intelligence,
    });
    const completion = modelRequest.modelExecution.completion;
    const assistantText = completion.text.trim();
    if (streamState && agent.ui.finishAssistantStream) {
      agent.ui.finishAssistantStream(streamState);
    }

    await recordAssistantMessage(agent, {
      turnState,
      step,
      content: assistantText,
      durationMs: modelDuration,
      usage: completion.usage ?? null,
      toolCalls: completion.toolCalls ?? [],
      providerMeta: completion.meta ?? null,
    });

    if (
      turnNativeToolCalling &&
      Array.isArray(completion.toolCalls) &&
      completion.toolCalls.length > 0
    ) {
      if (assistantText && !streamState?.displayed) {
        agent.printAssistant(assistantText);
      }

      // Execute tool calls — parallelize when safe, sequential when ordered
      const toolCalls = completion.toolCalls;
      if (toolCalls.length === 1) {
        // Single tool call — no need for parallelization overhead
        await agent.handleToolExecution({
          toolName: toolCalls[0].name,
          input: toolCalls[0].input,
          toolCallId: toolCalls[0].id,
          turnState,
          step,
          nativeToolCall: true,
        });
      } else {
        // Multiple tool calls — group by safety, execute independent tools in parallel
        await executeToolCallsWithParallelism(agent, {
          toolCalls,
          turnState,
          step,
        });
      }
      continue;
    }

    const action: ExtractedAction | null = extractAction(assistantText);
    if (!action || action.type === "final") {
      const outcome = await handleAssistantFinalAction(agent, {
        turnState,
        step,
        assistantText,
        streamDisplayed: Boolean(streamState?.displayed),
      });
      if (outcome.retry) {
        continue;
      }
      return outcome.result;
    }

    const execution = await agent.handleToolExecution({
      toolName: action.tool,
      input: action.input,
      toolCallId: null,
      turnState,
      step,
      nativeToolCall: false,
    });

    if (!execution.ok && execution.fatal) {
      const content = execution.error ?? "Tool execution failed.";
      const repairLoop = await maybeFinalizeInterruptedRepair(agent, {
        turnState,
        step,
        origin: "tool_fatal",
        summary: "Repair loop stopped because tool execution failed before verification could pass again.",
      });
      agent.lastExecutionPlan = agent.planner.noteFinal(agent.lastExecutionPlan, {
        success: false,
        reasonKind: "tool_failed",
        note: content,
      });
      turnState.executionPlan = agent.lastExecutionPlan;
      const finalized = await completeTurn(agent, {
        turnState,
        step,
        content,
        success: false,
        stopped: true,
        origin: "tool_fatal",
        sourceIds: turnState.sourceIds,
        finalPayload: repairLoop
          ? {
              repair: repairLoop.summary,
              repairLoop,
            }
          : undefined,
      });
      return {
        content,
        steps: step,
        printed: finalized.printed,
      };
    }
  }

  const content = `MJ Code stopped after ${agent.config.maxSteps} steps without reaching a final answer.`;
  const repairLoop = await maybeFinalizeInterruptedRepair(agent, {
    turnState,
    step: agent.config.maxSteps,
    origin: "max_steps",
    summary: "Repair loop stopped because the turn hit the step budget before verification could pass again.",
  });
  agent.lastExecutionPlan = agent.planner.noteFinal(agent.lastExecutionPlan, {
    success: false,
    reasonKind: "max_steps_exhausted",
    note: content,
  });
  turnState.executionPlan = agent.lastExecutionPlan;
  const finalized = await completeTurn(agent, {
    turnState,
    step: agent.config.maxSteps,
    content,
    success: false,
    stopped: true,
    origin: "max_steps",
    sourceIds: turnState.sourceIds,
    finalPayload: repairLoop
      ? {
          repair: repairLoop.summary,
          repairLoop,
        }
      : undefined,
  });
  return {
    content,
    steps: agent.config.maxSteps,
    printed: finalized.printed,
  };
}

async function handleAssistantFinalAction(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    step: number;
    assistantText: string;
    streamDisplayed: boolean;
  },
): Promise<{
  retry: boolean;
  result: {
    content: string;
    steps: number;
    printed: boolean;
  };
}> {
  const rawContent = extractFinalContent(input.assistantText);
  const content = applySourceCitationsToFinalContent(
    rawContent,
    input.turnState.sourceCitations,
  );
  const verifierRun = await maybeRunTurnVerifier(agent, {
    turnState: input.turnState,
    step: input.step,
  });

  if (verifierRun && !verifierRun.summary.passed) {
    const repairRetry = await maybeRetryVerifierFailure(agent, {
      turnState: input.turnState,
      step: input.step,
      verifierRun,
    });
    if (repairRetry) {
      return {
        retry: true,
        result: {
          content,
          steps: input.step,
          printed: input.streamDisplayed,
        },
      };
    }

    const failureContent = buildVerifierFailureContent(content, verifierRun, agent.lastRepairLoop);
    agent.lastExecutionPlan = agent.planner.noteFinal(agent.lastExecutionPlan, {
      success: false,
      reasonKind: "verifier_failed",
      note: verifierRun.summary.summary,
    });
    input.turnState.executionPlan = agent.lastExecutionPlan;
    const finalized = await completeTurn(agent, {
      turnState: input.turnState,
      step: input.step,
      content: failureContent,
      success: false,
      stopped: true,
      origin: "verifier_failed",
      errorTaxonomy: "verifier_failed",
      sourceIds: input.turnState.sourceIds,
      print: !input.streamDisplayed,
      finalPayload: {
        verifier: verifierRun.summary,
        verifierRun,
        repair: agent.lastRepairLoop?.summary ?? null,
        repairLoop: agent.lastRepairLoop ?? null,
      },
    });
    return {
      retry: false,
      result: {
        content: failureContent,
        steps: input.step,
        printed: input.streamDisplayed ? true : finalized.printed,
      },
    };
  }

  await maybeFinalizeSuccessfulRepair(agent, {
    turnState: input.turnState,
    step: input.step,
    verifierRun,
  });
  agent.lastExecutionPlan = agent.planner.noteFinal(agent.lastExecutionPlan, {
    success: true,
    note: "Final answer is ready.",
  });
  input.turnState.executionPlan = agent.lastExecutionPlan;
  const finalized = await completeTurn(agent, {
    turnState: input.turnState,
    step: input.step,
    content,
    success: true,
    stopped: false,
    origin: "assistant_final",
    sourceIds: input.turnState.sourceIds,
    print: !input.streamDisplayed,
    finalPayload: verifierRun
      ? {
          verifier: verifierRun.summary,
          repair: agent.lastRepairLoop?.summary ?? null,
          repairLoop: agent.lastRepairLoop ?? null,
        }
      : agent.lastRepairLoop
        ? {
            repair: agent.lastRepairLoop.summary,
            repairLoop: agent.lastRepairLoop,
          }
        : undefined,
  });
  if (input.streamDisplayed && content !== rawContent) {
    const delta = content.slice(rawContent.length).trim();
    if (delta) {
      agent.printAssistant(delta);
    }
  }
  return {
    retry: false,
    result: {
      content,
      steps: input.step,
      printed: input.streamDisplayed ? true : finalized.printed,
    },
  };
}

async function prepareTurnContext(
  agent: AgentTurnLoopLike,
  input: {
    prompt: string;
    turnState: TurnStateLike;
    intelligence: AgentIntelligence;
    step: number;
    baseSystemPrompt?: string | null;
  },
): Promise<PreparedContextLike> {
  const contextStart = Date.now();
  const preparedContext = await agent.contextManager.prepare({
    baseSystemPrompt: input.baseSystemPrompt ?? agent.baseSystemPrompt,
    messages: agent.messages,
    userPrompt: input.prompt,
    memoryStore: agent.memoryStore,
    model: input.intelligence.modelDecision?.chosenModel ?? agent.config.model,
    taskClassification: input.intelligence.taskClassification,
    routeDecision: agent.lastRouteDecision,
    modelDecision: input.intelligence.modelDecision,
    executionPlan: agent.lastExecutionPlan,
    activeSkills: agent.skillLoader.getActiveSkills(),
    instructions: agent.projectInstructions,
    sourceRegistry: agent.sourceRegistry,
    policy: agent.policyStack.getEffectivePolicy(),
    runtimeHealth: agent.runtimeHealth.getOverview(),
  });
  agent.lastExecutionPlan = agent.planner.noteContextPrepared(agent.lastExecutionPlan);
  input.turnState.executionPlan = agent.lastExecutionPlan;
  agent.messages = preparedContext.messages;

  const contextDuration = Date.now() - contextStart;
  input.turnState.durations.contextPrepareMs += contextDuration;
  await recordContextPrepared(agent, {
    turnState: input.turnState,
    step: input.step,
    prompt: input.prompt,
    meta: preparedContext.meta,
    durationMs: contextDuration,
  });

  if (preparedContext.meta.compactedMessages > 0) {
    agent.ui.printInfo?.(
      "compact",
      `Auto-compacted ${preparedContext.meta.compactedMessages} message(s) into rolling summary.`,
    );
  }

  return preparedContext;
}

async function requestModelCompletion(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    intelligence: AgentIntelligence;
    preparedContext: PreparedContextLike;
    step: number;
    streamState: StreamStateLike | null;
    nativeToolCalling: boolean;
  },
): Promise<{
  modelExecution: Awaited<ReturnType<typeof executeCompletionWithFallback>>;
  modelDurationMs: number;
}> {
  const tools = input.nativeToolCalling
    ? agent.toolRegistry.getToolSpecs()
    : undefined;
  const modelStart = Date.now();
  const modelExecution = await executeCompletionWithFallback({
    provider: agent.provider,
    request: {
      systemPrompt: input.preparedContext.systemPrompt,
      messages: agent.messages as ProviderCompletionRequest["messages"],
      model: input.intelligence.modelDecision?.chosenModel ?? agent.config.model ?? "mj-code-unspecified-model",
      maxTokens: agent.config.maxTokens,
      temperature: agent.config.temperature,
      streamOutput: agent.config.streamOutput,
      tools,
      traceId: input.turnState.traceId,
      onProviderEvent: async (event) => {
        await agent.recordProviderEvent(event, input.turnState, input.step);
        agent.ui.printProviderEvent?.(event);
      },
      onTextDelta: async (delta) => {
        if (input.streamState && agent.ui.pushAssistantDelta) {
          agent.ui.pushAssistantDelta(input.streamState, delta);
        }
      },
    },
    modelDecision: input.intelligence.modelDecision,
    configuredModel: agent.config.model,
    providerName: agent.config.provider,
    requestType: inferProviderRequestType({
      streamOutput: agent.config.streamOutput,
      tools,
    }),
    isFallbackSafe: ({ error }) =>
      !(input.streamState?.emittedContent?.length) &&
      (typeof error !== "object" ||
        error == null ||
        !("partialStream" in error) ||
        error.partialStream !== true),
    onFallback: async (event) => {
      agent.ui.printInfo?.(
        "fallback",
        `${event.fromModel} -> ${event.toModel} (${event.error.taxonomy})`,
      );
      await agent.recordProviderEvent({
        type: "provider_model_fallback",
        provider: agent.config.provider,
        requestType: event.requestType,
        fromModel: event.fromModel,
        toModel: event.toModel,
        attemptedModels: event.attemptedModels,
        error: event.error,
      }, input.turnState, input.step);
    },
  });
  return {
    modelExecution,
    modelDurationMs: Date.now() - modelStart,
  };
}

function recordModelUsage(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    intelligence: AgentIntelligence;
    modelExecution: Awaited<ReturnType<typeof executeCompletionWithFallback>>;
    modelDurationMs: number;
  },
): number {
  const completion = input.modelExecution.completion;
  const modelDuration = input.modelDurationMs;
  input.turnState.durations.modelCompleteMs += modelDuration;
  input.turnState.modelCalls += 1;
  input.turnState.modelDecision = {
    ...(input.intelligence.modelDecision ?? {}),
    selectedModel: input.modelExecution.selectedModel,
    attemptedModels: input.modelExecution.attemptedModels,
    fallbackChainUsed: input.modelExecution.fallbackCount > 0,
  } as ModelDecision;
  agent.lastModelDecision = input.turnState.modelDecision;
  agent.noteProviderMeta(input.turnState, completion.meta);
  agent.updateUsageTotals(completion.usage);
  input.turnState.promptTokens += Number(
    completion.usage?.prompt_tokens ?? completion.usage?.input_tokens ?? 0,
  );
  input.turnState.completionTokens += Number(
    completion.usage?.completion_tokens ?? completion.usage?.output_tokens ?? 0,
  );
  input.turnState.totalTokens += Number(
    completion.usage?.total_tokens ??
      (Number(completion.usage?.prompt_tokens ?? completion.usage?.input_tokens ?? 0) +
        Number(completion.usage?.completion_tokens ?? completion.usage?.output_tokens ?? 0)),
  );
  return modelDuration;
}

async function finalizeProviderFailure(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    step: number;
    error: unknown;
  },
): Promise<{
  content: string;
  steps: number;
  printed: boolean;
}> {
  const taxonomy = classifyErrorTaxonomy(input.error, "provider_error");
  const message = toErrorMessage(input.error);
  const details = taxonomy.startsWith("provider")
    ? serializeProviderError(input.error)
    : {
        message,
        taxonomy,
      };
  const content = taxonomy === "provider_retry_exhausted"
    ? "MJ Code stopped after provider retries were exhausted."
    : `MJ Code provider request failed: ${message}`;
  agent.ui.printProviderFailure?.(details as Record<string, unknown>);
  const repairLoop = await maybeFinalizeInterruptedRepair(agent, {
    turnState: input.turnState,
    step: input.step,
    origin: "provider_error",
    summary: "Repair loop stopped because provider execution failed before verification could pass again.",
  });

  agent.lastExecutionPlan = agent.planner.noteProviderFailure?.(agent.lastExecutionPlan, {
    taxonomy,
    summary: content,
  }) ?? agent.planner.noteFinal(agent.lastExecutionPlan, {
    success: false,
    reasonKind: taxonomy === "provider_circuit_open" ? "provider_circuit_open" : "provider_retry_exhausted",
    note: content,
  });
  input.turnState.executionPlan = agent.lastExecutionPlan;

  await agent.executionJournal.recordPhase({
    traceId: input.turnState.traceId,
    stepId: input.step,
    phase: "model_complete",
    outputSummary: content,
    error: {
      taxonomy,
      details,
    },
    snapshot: await agent.captureStateSnapshot({
      traceId: input.turnState.traceId,
      phase: "model_complete",
      stepId: input.step,
      outputSummary: "Provider failure captured.",
    }),
  });

  const finalized = await completeTurn(agent, {
    turnState: input.turnState,
    step: input.step,
    content,
    success: false,
    stopped: true,
    origin: "provider_error",
    errorTaxonomy: taxonomy,
    sourceIds: input.turnState.sourceIds,
    finalPayload: {
      error: details,
      ...(repairLoop
        ? {
            repair: repairLoop.summary,
            repairLoop,
          }
        : {}),
    },
  });
  return {
    content,
    steps: input.step,
    printed: finalized.printed,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return `${error ?? "Unknown provider error"}`;
}

async function maybeAttachLocalContextPrefetch(
  agent: AgentTurnLoopLike,
  input: {
    prompt: string;
    turnState: TurnStateLike;
  },
): Promise<void> {
  const prefetch = await prefetchLocalContextForPrompt({
    prompt: input.prompt,
    cwd: agent.config.cwd,
    maxCharsPerFile: Math.min(8000, Math.max(2000, Math.floor(agent.config.maxReadChars / 3))),
    maxTotalChars: Math.min(18000, Math.max(6000, agent.config.maxReadChars)),
  });
  if (!prefetch.message) {
    return;
  }

  agent.messages.push({
    role: "user",
    name: "local_context",
    content: prefetch.message,
  });
  agent.ui.printLocalContextPrefetch?.(prefetch);
  await agent.sessionStore.append("local_context_prefetch", {
    traceId: input.turnState.traceId,
    attachments: prefetch.attachments.map((entry) => ({
      path: entry.path,
      relativePath: entry.relativePath,
      bytes: entry.bytes,
      lineCount: entry.lineCount,
      truncated: entry.truncated,
    })),
    skipped: prefetch.skipped,
  });
  await agent.executionJournal.recordPhase({
    traceId: input.turnState.traceId,
    stepId: 0,
    phase: "context_prefetch",
    inputSummary: input.prompt,
    outputSummary: `Prefetched ${prefetch.attachments.length} local file(s).`,
    metrics: {
      files: prefetch.attachments.map((entry) => entry.relativePath),
      skipped: prefetch.skipped,
    },
    snapshot: await agent.captureStateSnapshot({
      traceId: input.turnState.traceId,
      phase: "context_prefetch",
      stepId: 0,
      outputSummary: "Local file snippets attached before model call.",
    }),
  });
}

function shouldRetryWithJsonToolProtocol(error: unknown): boolean {
  const serialized = serializeProviderError(error);
  if (serialized.requestType !== "tool_completion") {
    return false;
  }
  if (serialized.status === 401 || serialized.status === 403) {
    return false;
  }
  if ([400, 404, 405, 422, 501].includes(Number(serialized.status))) {
    return true;
  }

  const details = serialized.details && typeof serialized.details === "object"
    ? Object.values(serialized.details).join(" ")
    : "";
  const haystack = [
    serialized.message,
    serialized.code,
    serialized.rawText,
    details,
  ].join(" ").toLowerCase();
  return /tool|function|tool_choice|schema|unsupported|not support|invalid request|terminated|socket hang up|premature|unexpected end/.test(haystack);
}

function buildJsonToolProtocolPrompt(agent: AgentTurnLoopLike): string {
  return buildSystemPrompt({
    tools: agent.toolRegistry.getToolSpecs(),
    config: {
      cwd: agent.config.cwd,
      permissionMode: agent.config.permissionMode,
      approvalPolicy: agent.config.approvalPolicy,
      networkMode: agent.config.networkMode,
    },
    projectInstructions: agent.projectInstructions.content,
    nativeToolCalling: false,
    policyStack: null,
  });
}

function extractFinalContent(assistantText: string): string {
  const action = extractAction(assistantText);
  return action?.type === "final"
    ? action.content ?? assistantText.trim()
    : assistantText.trim();
}

async function maybeRetryVerifierFailure(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    step: number;
    verifierRun: VerifierRunRecord;
  },
): Promise<boolean> {
  const repairState = decideRepairLoopOnVerifierFailure({
    cwd: agent.config.cwd,
    verifierRun: input.verifierRun,
    existingLoop: agent.lastRepairLoop,
    remainingSteps: agent.config.maxSteps - input.step,
  });
  let repairLoop = repairState.repairLoop;
  const decision = repairState.decision;

  if (decision.decision === "retry") {
    const applyResult = await maybeApplyVerifierCodeAction(agent, {
      turnState: input.turnState,
      step: input.step,
      verifierRun: input.verifierRun,
      repairLoop,
    });
    if (applyResult) {
      const updatedLoop = recordRepairCodeActionResult({
        repairLoop,
        result: applyResult,
        continuationMessage: renderCodeActionContinuationMessage(
          repairLoop.attempts.at(-1)?.continuationMessage ?? decision.summary,
          applyResult,
        ),
      });
      if (updatedLoop) {
        repairLoop = updatedLoop;
      }
    }
  }

  agent.lastRepairLoop = repairLoop;
  input.turnState.lastRepairLoop = repairLoop;
  const repairNote = repairLoop.attempts.at(-1)?.codeAction?.summary
    ? `${decision.summary} ${repairLoop.attempts.at(-1)?.codeAction?.summary}`
    : decision.summary;

  if (decision.decision === "retry") {
    agent.lastExecutionPlan = agent.planner.noteRepairStarted(agent.lastExecutionPlan, {
      attempt: decision.attempt,
      maxAttempts: decision.maxAttempts,
      note: repairNote,
    });
  } else {
    agent.lastExecutionPlan = agent.planner.noteRepairResult(agent.lastExecutionPlan, {
      success: false,
      exhausted: decision.status === "exhausted",
      note: repairNote,
    });
  }
  input.turnState.executionPlan = agent.lastExecutionPlan;

  await recordRepairLoop(agent, {
    turnState: input.turnState,
    step: input.step,
    repairLoop,
    decision,
  });

  if (decision.decision !== "retry") {
    return false;
  }

  const continuationMessage = repairLoop.attempts.at(-1)?.continuationMessage
    ?? decision.directive?.summary
    ?? decision.summary;
  agent.messages.push({
    role: "user",
    name: "repair_loop",
    content: continuationMessage,
  });
  agent.ui.printInfo?.("repair", repairNote);
  return true;
}

async function maybeApplyVerifierCodeAction(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    step: number;
    verifierRun: VerifierRunRecord;
    repairLoop: RepairLoopRecord;
  },
): Promise<CodeActionApplyResult | null> {
  const directive = input.repairLoop.attempts.at(-1)?.directive ?? null;
  if (!directive) {
    return null;
  }
  if (!directive.codeActions.summary.available) {
    return {
      status: "unavailable",
      source: directive.codeActions.summary.source,
      applied: false,
      candidateId: null,
      title: null,
      kind: null,
      allowlisted: false,
      summary: directive.codeActions.summary.reason
        ?? "Code actions were unavailable for this repair attempt.",
      blockedReason: "candidate_unavailable",
      failureReason: null,
      approvalRequired: false,
      approvalStatus: "blocked",
      toolName: null,
      changeSetId: null,
      touchedFiles: [],
      verifierRunStartedAt: input.verifierRun.startedAt,
      verifierStep: input.verifierRun.step,
    };
  }
  if (directive.codeActions.summary.total === 0) {
    return null;
  }

  const candidate = selectRepairCodeActionCandidate(input.repairLoop);
  if (!candidate) {
    const blocked = directive.codeActions.actions[0] ?? null;
    return {
      status: "blocked",
      source: directive.codeActions.summary.source,
      applied: false,
      candidateId: blocked?.id ?? null,
      title: blocked?.title ?? null,
      kind: blocked?.kind ?? null,
      allowlisted: false,
      summary: blocked
        ? `No allowlisted code action was applied. The primary candidate "${blocked.title}" was blocked: ${blocked.blockedReason ?? "not_allowlisted"}.`
        : "No allowlisted code action was available for this repair attempt.",
      blockedReason: blocked?.blockedReason ?? "not_allowlisted",
      failureReason: null,
      approvalRequired: false,
      approvalStatus: "blocked",
      toolName: null,
      changeSetId: null,
      touchedFiles: blocked?.filePaths ? [...blocked.filePaths] : [],
      verifierRunStartedAt: input.verifierRun.startedAt,
      verifierStep: input.verifierRun.step,
    };
  }

  try {
    const writeInput = await prepareCodeActionWriteInput(candidate);
    const approvalBefore = { ...agent.approvalStats };
    const previousChangeSetId = agent.lastChangeSet?.id ?? null;
    const execution = await agent.handleToolExecution({
      toolName: "write_file",
      input: writeInput,
      toolCallId: null,
      turnState: input.turnState,
      step: input.step,
      nativeToolCall: false,
    });
    const approvalRequired = agent.approvalStats.asked > approvalBefore.asked;
    const approvalStatus = agent.approvalStats.denied > approvalBefore.denied
      ? "denied"
      : agent.approvalStats.approved > approvalBefore.approved
        ? "approved"
        : approvalRequired
          ? "blocked"
          : "not_required";
    const currentChangeSet = agent.lastChangeSet?.id !== previousChangeSetId
      ? agent.lastChangeSet
      : null;

    if (!execution.ok) {
      const errorMessage = execution.error ?? `Code action "${candidate.title}" failed during write_file execution.`;
      const blockedReason = approvalStatus === "denied"
        ? "approval_denied"
        : approvalStatus === "blocked" || /blocked|requires|denied|outside the workspace|read-only/i.test(errorMessage)
          ? "permission_denied"
          : "execution_failed";
      return {
        status: blockedReason === "execution_failed" ? "failed" : "blocked",
        source: candidate.source,
        applied: false,
        candidateId: candidate.id,
        title: candidate.title,
        kind: candidate.kind,
        allowlisted: candidate.allowlisted,
        summary: blockedReason === "approval_denied"
          ? `Allowlisted code action "${candidate.title}" was not applied because approval was denied.`
          : `Allowlisted code action "${candidate.title}" was not applied: ${errorMessage}`,
        blockedReason,
        failureReason: errorMessage,
        approvalRequired,
        approvalStatus,
        toolName: "write_file",
        changeSetId: currentChangeSet?.id ?? null,
        touchedFiles: currentChangeSet?.touchedFiles ?? [writeInput.path],
        verifierRunStartedAt: input.verifierRun.startedAt,
        verifierStep: input.verifierRun.step,
      };
    }

    return {
      status: "applied",
      source: candidate.source,
      applied: true,
      candidateId: candidate.id,
      title: candidate.title,
      kind: candidate.kind,
      allowlisted: candidate.allowlisted,
      summary: `Applied allowlisted code action "${candidate.title}" through write_file. Verification must pass again before this turn can succeed.`,
      blockedReason: null,
      failureReason: null,
      approvalRequired,
      approvalStatus,
      toolName: "write_file",
      changeSetId: currentChangeSet?.id ?? null,
      touchedFiles: currentChangeSet?.touchedFiles ?? [writeInput.path],
      verifierRunStartedAt: input.verifierRun.startedAt,
      verifierStep: input.verifierRun.step,
    };
  } catch (error) {
    return {
      status: "blocked",
      source: candidate.source,
      applied: false,
      candidateId: candidate.id,
      title: candidate.title,
      kind: candidate.kind,
      allowlisted: candidate.allowlisted,
      summary: `Allowlisted code action "${candidate.title}" could not be prepared for apply: ${toErrorMessage(error)}`,
      blockedReason: toCodeActionApplyBlockedReason(error),
      failureReason: toErrorMessage(error),
      approvalRequired: false,
      approvalStatus: "blocked",
      toolName: "write_file",
      changeSetId: null,
      touchedFiles: [...candidate.filePaths],
      verifierRunStartedAt: input.verifierRun.startedAt,
      verifierStep: input.verifierRun.step,
    };
  }
}

function renderCodeActionContinuationMessage(
  baseMessage: string,
  result: CodeActionApplyResult,
): string {
  const prefix = result.status === "applied"
    ? `System-applied bounded code action: ${result.title ?? "unknown action"}. Verification still must pass before success.`
    : `Automatic code-action apply outcome: ${result.summary}`;
  return `${prefix}\n\n${baseMessage}`;
}

async function maybeFinalizeSuccessfulRepair(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    step: number;
    verifierRun: VerifierRunRecord | null;
  },
): Promise<void> {
  if (!input.verifierRun || !agent.lastRepairLoop || agent.lastRepairLoop.summary.status !== "retrying") {
    return;
  }

  const repairLoop = finalizeRepairLoopOnVerifierPass({
    repairLoop: agent.lastRepairLoop,
    verifierRun: input.verifierRun,
  });
  if (!repairLoop) {
    return;
  }

  const decision: RepairDecision = {
    decision: "stop",
    status: "succeeded",
    stopReason: null,
    attempt: repairLoop.attempts.length,
    maxAttempts: repairLoop.maxAttempts,
    actionable: true,
    summary: repairLoop.summary.summary,
    directive: repairLoop.attempts.at(-1)?.directive ?? null,
  };
  agent.lastRepairLoop = repairLoop;
  input.turnState.lastRepairLoop = repairLoop;
  agent.lastExecutionPlan = agent.planner.noteRepairResult(agent.lastExecutionPlan, {
    success: true,
    note: repairLoop.summary.summary,
  });
  input.turnState.executionPlan = agent.lastExecutionPlan;
  await recordRepairLoop(agent, {
    turnState: input.turnState,
    step: input.step,
    repairLoop,
    decision,
  });
}

async function maybeFinalizeInterruptedRepair(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    step: number;
    origin: "tool_fatal" | "provider_error" | "max_steps";
    summary: string;
  },
): Promise<RepairLoopRecord | null> {
  if (!agent.lastRepairLoop || agent.lastRepairLoop.summary.status !== "retrying") {
    return agent.lastRepairLoop;
  }

  const stopReason = input.origin === "max_steps"
    ? "max_steps_reached"
    : "turn_interrupted";
  const status = input.origin === "max_steps"
    ? "stopped"
    : "failed";
  const repairLoop = finalizeRepairLoopOnTurnFailure({
    repairLoop: agent.lastRepairLoop,
    status,
    stopReason,
    summary: input.summary,
  });
  if (!repairLoop) {
    return agent.lastRepairLoop;
  }

  const decision: RepairDecision = {
    decision: "stop",
    status: repairLoop.summary.status,
    stopReason,
    attempt: repairLoop.attempts.length,
    maxAttempts: repairLoop.maxAttempts,
    actionable: true,
    summary: repairLoop.summary.summary,
    directive: repairLoop.attempts.at(-1)?.directive ?? null,
  };
  agent.lastRepairLoop = repairLoop;
  input.turnState.lastRepairLoop = repairLoop;
  await recordRepairLoop(agent, {
    turnState: input.turnState,
    step: input.step,
    repairLoop,
    decision,
  });
  return repairLoop;
}

async function maybeRunTurnVerifier(
  agent: AgentTurnLoopLike,
  input: {
    turnState: TurnStateLike;
    step: number;
  },
): Promise<VerifierRunRecord | null> {
  const filesChanged = [...input.turnState.filesChanged];
  const plan = input.turnState.executionPlan ?? agent.lastExecutionPlan;
  const hasVerifyStep = Array.isArray(plan?.steps) && plan.steps.some((step) => step.type === "verify");
  const shouldRun = filesChanged.length > 0 || hasVerifyStep || Boolean(plan?.verificationBias);
  if (!shouldRun) {
    return null;
  }

  agent.lastExecutionPlan = agent.planner.noteVerificationStarted(agent.lastExecutionPlan, {
    note: filesChanged.length > 0
      ? `Verifier started for ${filesChanged.length} changed file(s).`
      : "Verifier started from plan verification bias.",
  });
  input.turnState.executionPlan = agent.lastExecutionPlan;

  const verifierRun = await runPostEditVerifier({
    cwd: agent.config.cwd,
    shellRuntime: agent.shellRuntime,
    sessionStore: agent.sessionStore,
    executionJournal: agent.executionJournal,
    captureStateSnapshot: async (payload) => agent.captureStateSnapshot(payload),
    diagnosticProvider: agent.diagnosticProvider ?? null,
  }, {
    turnState: input.turnState,
    step: input.step,
    lastChangeSet: agent.lastChangeSet,
  });

  agent.lastVerifierRun = verifierRun;
  input.turnState.lastVerifierRun = verifierRun;
  agent.lastExecutionPlan = agent.planner.noteVerificationResult(agent.lastExecutionPlan, {
    success: verifierRun.summary.passed,
    note: verifierRun.summary.summary,
  });
  input.turnState.executionPlan = agent.lastExecutionPlan;
  return verifierRun;
}

function buildVerifierFailureContent(
  content: string,
  verifierRun: VerifierRunRecord,
  repairLoop: RepairLoopRecord | null,
): string {
  const failingChecks = verifierRun.checks
    .filter((check) => check.status === "failed")
    .map((check) => check.summary)
    .slice(0, 3)
    .join(" ");
  const verifierSummary = failingChecks || verifierRun.summary.summary;
  const repairSummary = repairLoop?.summary.summary
    ? `\nRepair loop: ${repairLoop.summary.summary}`
    : "";
  const prefix = "MJ Code stopped before marking this turn successful because verification failed.";
  if (!content) {
    return `${prefix}\n\n${verifierSummary}${repairSummary}`;
  }
  return `${content}\n\n${prefix}\n${verifierSummary}${repairSummary}`;
}

/**
 * Execute multiple tool calls with parallelism where safe.
 *
 * Strategy:
 * - Write tools (write_file, replace_in_file, apply_patch) are ALWAYS sequential
 *   because they may modify the same files.
 * - Read-only tools (read_file, list_dir, search_files, web_search, etc.) can run in parallel.
 * - Shell commands run sequentially to avoid race conditions.
 * - MCP tools run in parallel (different servers are independent).
 *
 * This mirrors Claude Code's behavior: read-only calls are parallelized,
 * write calls are always sequential.
 */
async function executeToolCallsWithParallelism(
  agent: AgentTurnLoopLike,
  input: {
    toolCalls: ProviderToolCall[];
    turnState: TurnStateLike;
    step: number;
  },
): Promise<void> {
  const { toolCalls, turnState, step } = input;

  // Classify each tool call as parallel-safe or sequential
  type ToolCallWithSafety = {
    toolCall: ProviderToolCall;
    safe: boolean;
  };

  const classified: ToolCallWithSafety[] = toolCalls.map((toolCall) => ({
    toolCall,
    safe: isParallelSafeTool(toolCall.name, toolCall.input),
  }));

  // Group consecutive safe calls into batches for parallel execution
  // Unsafe calls break the batch and are executed sequentially
  let index = 0;
  while (index < classified.length) {
    // Collect a batch of consecutive parallel-safe calls
    const batch: ToolCallWithSafety[] = [];
    while (index < classified.length && classified[index].safe) {
      batch.push(classified[index]);
      index += 1;
    }

    if (batch.length > 0) {
      // Execute the batch in parallel
      await Promise.all(
        batch.map((item) =>
          agent.handleToolExecution({
            toolName: item.toolCall.name,
            input: item.toolCall.input,
            toolCallId: item.toolCall.id,
            turnState,
            step,
            nativeToolCall: true,
          }),
        ),
      );
    }

    // Execute the next unsafe call sequentially
    if (index < classified.length && !classified[index].safe) {
      const item = classified[index];
      await agent.handleToolExecution({
        toolName: item.toolCall.name,
        input: item.toolCall.input,
        toolCallId: item.toolCall.id,
        turnState,
        step,
        nativeToolCall: true,
      });
      index += 1;
    }
  }
}

/**
 * Determine if a tool call is safe to execute in parallel with others.
 *
 * Read-only tools and independent web/network calls are safe.
 * Write tools, shell commands, and tools targeting the same file are not.
 */
function isParallelSafeTool(toolName: string, input: Record<string, unknown>): boolean {
  // Write tools are NEVER parallel-safe
  if (["write_file", "replace_in_file", "apply_patch"].includes(toolName)) {
    return false;
  }

  // Shell commands are not parallel-safe (race conditions on filesystem, env, etc.)
  if (toolName === "run_shell") {
    return false;
  }

  // Memory write operations are not parallel-safe
  if (toolName === "remember_memory" || toolName === "forget_memory") {
    return false;
  }

  // All read-only builtin tools are parallel-safe
  if (["read_file", "list_dir", "search_files", "pwd"].includes(toolName)) {
    return true;
  }

  // Web/network tools are parallel-safe (independent HTTP requests)
  if (["web_search", "fetch_url", "extract_content"].includes(toolName)) {
    return true;
  }

  // Memory search is parallel-safe (read-only)
  if (toolName === "search_memory") {
    return true;
  }

  // Doc tools are parallel-safe (read-only)
  if (["list_docs", "read_doc", "search_docs"].includes(toolName)) {
    return true;
  }

  // Sandbox check is parallel-safe (read-only)
  if (toolName === "check_sandbox") {
    return true;
  }

  // MCP tools: safe if read-only according to annotations, otherwise sequential
  // We can't easily check annotations here, so default to parallel-safe
  // (MCP servers handle their own concurrency)
  if (toolName.startsWith("mcp__")) {
    return true;
  }

  // Default: not parallel-safe (conservative)
  return false;
}
