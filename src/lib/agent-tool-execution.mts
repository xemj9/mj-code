import {
  buildLegacyApprovalPrompt,
  classifyErrorTaxonomy,
  isPreviewRequiredTool,
  summarizeToolResult,
} from "./agent-utils.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";
import {
  summarizeChangeSet,
  withChangeSetMeta,
} from "./change-set.mjs";
import { summarizeBoundaryDecision } from "./execution-boundary.mjs";
import {
  assessToolRisk,
  buildApprovalContext,
} from "./risk-engine.mjs";

import type {
  ApprovalContext,
  ChangeSetRecord,
  ExecutionBoundaryDecision,
  HookEmitResult,
  JsonObject,
  ResolvedConfig,
  RiskAssessment,
  ToolMetadata,
  ToolRegistrySurface,
} from "../types/contracts.js";

interface TurnStateLike {
  traceId: string;
  toolEvents: Array<Record<string, unknown>>;
  filesChanged: Set<string>;
  approvalsAsked: number;
  approvalsApproved: number;
  approvalsDenied: number;
  shellJobs: Array<Record<string, unknown>>;
  sourceCitations: unknown[];
  sourceIds: string[];
  mcpCalls: Array<Record<string, unknown>>;
  durations: {
    toolExecuteMs: number;
  };
  executionPlan: unknown;
}

interface UiLike {
  printToolCall?(toolName: string, input?: Record<string, unknown>): void;
  printChangePreview?(changeSet: ChangeSetRecord): void;
  printWarning?(message: string): void;
  printError?(message: string): void;
  printToolResult?(toolName: string, result: unknown): void;
  confirmAction?(approvalContext: ApprovalContext): Promise<boolean>;
  confirm?(message: string): Promise<boolean>;
}

interface ApprovalStatsLike {
  asked: number;
  approved: number;
  denied: number;
}

interface SessionStoreLike {
  append(type: string, payload?: unknown): Promise<unknown>;
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "append" | "recordPhase">;

interface RollbackCheckpointLike {
  id: string;
}

interface RollbackStoreLike {
  checkpointChangeSet(
    changeSet: ChangeSetRecord,
    metadata?: {
      sessionId?: string | null;
      traceId?: string | null;
      origin?: string | null;
      sourceTool?: string | null;
    },
  ): Promise<RollbackCheckpointLike>;
  markApplied(
    changeSetId: string,
    payload?: {
      result?: unknown;
    },
  ): Promise<unknown>;
  markApplyFailed(
    changeSetId: string,
    error: unknown,
    payload?: {
      partial?: boolean;
      result?: unknown;
      errorTaxonomy?: string;
    },
  ): Promise<unknown>;
}

interface PlannerLike {
  noteToolExecution(
    executionPlan: unknown,
    toolName: string,
    input?: Record<string, unknown>,
    success?: boolean,
  ): unknown;
  noteToolBlocked?(
    executionPlan: unknown,
    input: {
      toolName: string;
      reasonKind: "permission_denied" | "approval_denied" | "boundary_blocked" | "tool_preview_failed";
      summary: string;
      taxonomy?: string | null;
      commandInput?: Record<string, unknown>;
    },
  ): unknown;
}

interface ExecutionBoundaryLike {
  evaluateTool(input: {
    toolName: string;
    toolMeta?: ToolMetadata | null;
    input?: Record<string, unknown>;
    traceId?: string | null;
    step?: string | number | null;
  }): ExecutionBoundaryDecision;
}

interface HookRunnerLike {
  emit(
    eventName: "before_tool" | "after_tool" | "before_apply" | "after_apply",
    payload?: Record<string, unknown>,
    context?: {
      traceId?: string | null;
      step?: string | number | null;
      sessionId?: string | null;
      parentSessionId?: string | null;
      rootSessionId?: string | null;
      observePaths?: string[];
    },
  ): Promise<HookEmitResult>;
}

interface ExecuteAgentToolInput {
  toolName: string;
  input?: Record<string, unknown>;
  toolCallId: string | null;
  turnState: TurnStateLike;
  step: string | number;
  nativeToolCall: boolean;
}

interface ExecuteAgentToolDependencies {
  config: Pick<
    ResolvedConfig,
    "cwd" | "approvalPolicy" | "permissionMode" | "networkMode"
  >;
  ui: UiLike;
  toolRegistry: ToolRegistrySurface;
  executionBoundary: ExecutionBoundaryLike;
  hookRunner?: HookRunnerLike | null;
  rollbackStore: RollbackStoreLike;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  planner: PlannerLike;
  approvalStats: ApprovalStatsLike;
  sessionId: string | null;
  parentSessionId: string | null;
  getLastExecutionPlan(): unknown;
  setLastExecutionPlan(executionPlan: unknown): void;
  setLastChangeSet(changeSet: ChangeSetRecord | null): void;
  pushToolFeedback(input: {
    nativeToolCall: boolean;
    toolCallId: string | null;
    toolName: string;
    payload: {
      ok: boolean;
      result?: unknown;
      error?: string;
    };
  }): Promise<void>;
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): Promise<unknown>;
  onWebEvent(event: Record<string, unknown>): Promise<void>;
  onMcpEvent(event: Record<string, unknown>): Promise<void>;
}

interface AgentToolExecutionResult {
  ok: boolean;
  fatal?: boolean;
  error?: string;
  result?: unknown;
  changeSet?: ChangeSetRecord | null;
}

export async function executeAgentTool(
  dependencies: ExecuteAgentToolDependencies,
  {
    toolName,
    input = {},
    toolCallId,
    turnState,
    step,
    nativeToolCall,
  }: ExecuteAgentToolInput,
): Promise<AgentToolExecutionResult> {
  dependencies.ui.printToolCall?.(toolName, input);
  const toolMeta = dependencies.toolRegistry.describe?.(toolName) ?? null;
  const boundaryDecision = dependencies.executionBoundary.evaluateTool({
    toolName,
    toolMeta,
    input,
    traceId: turnState.traceId,
    step,
  });
  await appendBoundaryDecision(
    dependencies,
    boundaryDecision,
    inferPhaseFromTool(toolName),
  );

  const effectiveInput = asRecord(boundaryDecision.effectiveInput) ?? cloneInput(input);
  let changeSet: ChangeSetRecord | null = null;
  let risk = assessToolRisk({
    toolName,
    input: effectiveInput,
    permissionDecision: boundaryDecision.permissionDecision,
    workspaceRoot: dependencies.config.cwd,
  });

  if (boundaryDecision.permissionDecision.allowed) {
    try {
      const preview = await dependencies.toolRegistry.preview(toolName, toJsonObject(effectiveInput));
      if (isChangeSetRecord(preview)) {
        risk = assessToolRisk({
          toolName,
          input: effectiveInput,
          changeSet: preview,
          permissionDecision: boundaryDecision.permissionDecision,
          workspaceRoot: dependencies.config.cwd,
        });
        changeSet = withChangeSetMeta(preview, { risk });
        dependencies.setLastChangeSet(changeSet);
        await dependencies.sessionStore.append("change_preview", {
          traceId: turnState.traceId,
          step,
          tool: toolName,
          changeSet: summarizeChangeSet(changeSet),
        });
        await dependencies.executionJournal.recordPhase({
          traceId: turnState.traceId,
          stepId: step,
          phase: "apply_changes",
          inputSummary: `Preview ${toolName}`,
          outputSummary: `Prepared change-set ${changeSet.id}.`,
          metrics: {
            touchedFiles: changeSet.touchedFiles.length,
            risk: changeSet.risk,
          },
          snapshot: await dependencies.captureStateSnapshot({
            traceId: turnState.traceId,
            phase: "apply_changes",
            stepId: step,
            outputSummary: `Preview ready for ${toolName}.`,
          }),
        });
        dependencies.ui.printChangePreview?.(changeSet);
      }
    } catch (error) {
      if (isPreviewRequiredTool(toolName)) {
        const taxonomy = classifyErrorTaxonomy(error, "filesystem_error");
        const message = `Preview failed for ${toolName}: ${toErrorMessage(error)}`;
        dependencies.ui.printError?.(message);
        await dependencies.sessionStore.append("tool_error", {
          traceId: turnState.traceId,
          step,
          tool: toolName,
          input: effectiveInput,
          error: message,
          taxonomy,
        });
        await dependencies.executionJournal.recordPhase({
          traceId: turnState.traceId,
          stepId: step,
          phase: "apply_changes",
          inputSummary: `Preview ${toolName}`,
          outputSummary: message,
          error: {
            taxonomy,
            message,
          },
        });
        await dependencies.pushToolFeedback({
          nativeToolCall,
          toolCallId,
          toolName,
          payload: {
            ok: false,
            error: message,
          },
        });
        turnState.toolEvents.push({
          tool: toolName,
          input,
          effectiveInput,
          ok: false,
          error: message,
          boundary: summarizeBoundaryDecision(boundaryDecision),
        });
        const previewPlan = dependencies.planner.noteToolBlocked?.(
          dependencies.getLastExecutionPlan(),
          {
            toolName,
            reasonKind: "tool_preview_failed",
            summary: message,
            taxonomy,
            commandInput: effectiveInput,
          },
        ) ?? dependencies.getLastExecutionPlan();
        dependencies.setLastExecutionPlan(previewPlan);
        turnState.executionPlan = previewPlan;
        return {
          ok: false,
          fatal: false,
          error: message,
        };
      }
    }
  }

  const approvalContext = buildApprovalContext({
    toolName,
    changeSet,
    risk,
    permissionDecision: boundaryDecision.permissionDecision,
    input: effectiveInput,
  });

  if (!boundaryDecision.permissionDecision.allowed) {
    const rawReason = boundaryDecision.permissionDecision.reason ?? `Tool "${toolName}" was blocked.`;
    // Enrich the feedback for the LLM so it can adapt instead of retrying the
    // same blocked action in a loop.
    const isPathOutside = rawReason.includes("outside the workspace");
    const reason = isPathOutside
      ? `${rawReason} To write files outside the workspace, either: (1) write the file inside the workspace first and then use a shell command to copy it, or (2) ask the user to switch to full-access mode.`
      : rawReason;
    dependencies.ui.printWarning?.(reason);
    turnState.toolEvents.push({
      tool: toolName,
      input,
      effectiveInput,
      ok: false,
      error: reason,
      risk,
      boundary: summarizeBoundaryDecision(boundaryDecision),
    });
    await dependencies.sessionStore.append("tool_denied", {
      traceId: turnState.traceId,
      step,
      tool: toolName,
      input: effectiveInput,
      reason,
      risk,
      boundary: summarizeBoundaryDecision(boundaryDecision),
    });
    await dependencies.pushToolFeedback({
      nativeToolCall,
      toolCallId,
      toolName,
      payload: {
        ok: false,
        error: reason,
      },
    });
    const blockedPlan = dependencies.planner.noteToolBlocked?.(
      dependencies.getLastExecutionPlan(),
      {
        toolName,
        reasonKind: "permission_denied",
        summary: reason,
        commandInput: effectiveInput,
      },
    ) ?? dependencies.getLastExecutionPlan();
    dependencies.setLastExecutionPlan(blockedPlan);
    turnState.executionPlan = blockedPlan;
    return {
      ok: false,
      fatal: false,
      error: reason,
    };
  }

  const beforeToolHook = await emitHook(dependencies, "before_tool", {
    toolName,
    toolMeta,
    input,
    effectiveInput,
    boundaryDecision,
    risk,
    changeSet,
    category: boundaryDecision.permissionDecision.category,
  }, {
    traceId: turnState.traceId,
    step,
    sessionId: dependencies.sessionId,
    parentSessionId: dependencies.parentSessionId,
    rootSessionId: dependencies.parentSessionId ?? dependencies.sessionId,
    observePaths: changeSet?.touchedFiles ?? [],
  });
  if (beforeToolHook?.blocked) {
    return blockToolExecution(dependencies, {
      toolName,
      input,
      effectiveInput,
      toolCallId,
      nativeToolCall,
      turnState,
      step,
      risk,
      boundaryDecision,
      reason: beforeToolHook.blockReason ?? `Hook blocked ${toolName}.`,
      summary: "before_tool hook blocked execution.",
    });
  }

  if (boundaryDecision.requiresApproval) {
    dependencies.approvalStats.asked += 1;
    turnState.approvalsAsked += 1;
    const approved = await confirmApproval(dependencies.ui, approvalContext);
    await dependencies.sessionStore.append("tool_approval", {
      traceId: turnState.traceId,
      step,
      tool: toolName,
      input: effectiveInput,
      approved,
      context: approvalContext,
      boundary: summarizeBoundaryDecision(boundaryDecision),
    });

    if (!approved) {
      dependencies.approvalStats.denied += 1;
      turnState.approvalsDenied += 1;
      // Include contextual hints in the denial message so the LLM can adjust
      // its approach instead of blindly retrying the same path.
      const boundaryReason = boundaryDecision.permissionDecision.reason;
      const isOutsideWorkspace = boundaryReason?.includes("outside workspace");
      const message = isOutsideWorkspace
        ? `User denied approval. ${boundaryReason} Consider writing to the workspace directory instead, or use a shell command to copy the file after creating it within the workspace.`
        : "User denied approval.";
      dependencies.ui.printWarning?.(`Denied ${toolName}.`);
      turnState.toolEvents.push({
        tool: toolName,
        input,
        effectiveInput,
        ok: false,
        error: message,
        risk,
        boundary: summarizeBoundaryDecision(boundaryDecision),
      });
      await dependencies.pushToolFeedback({
        nativeToolCall,
        toolCallId,
        toolName,
        payload: {
          ok: false,
          error: message,
        },
      });
      const deniedPlan = dependencies.planner.noteToolBlocked?.(
        dependencies.getLastExecutionPlan(),
        {
          toolName,
          reasonKind: "approval_denied",
          summary: message,
          commandInput: effectiveInput,
        },
      ) ?? dependencies.getLastExecutionPlan();
      dependencies.setLastExecutionPlan(deniedPlan);
      turnState.executionPlan = deniedPlan;
      return {
        ok: false,
        fatal: false,
        error: message,
      };
    }

    dependencies.approvalStats.approved += 1;
    turnState.approvalsApproved += 1;
  }

  const beforeApplyHook = changeSet
    ? await emitHook(dependencies, "before_apply", {
      toolName,
      toolMeta,
      input,
      effectiveInput,
      boundaryDecision,
      risk,
      changeSet,
      category: "apply",
    }, {
      traceId: turnState.traceId,
      step,
      sessionId: dependencies.sessionId,
      parentSessionId: dependencies.parentSessionId,
      rootSessionId: dependencies.parentSessionId ?? dependencies.sessionId,
      observePaths: changeSet.touchedFiles,
    })
    : null;
  if (beforeApplyHook?.blocked) {
    return blockToolExecution(dependencies, {
      toolName,
      input,
      effectiveInput,
      toolCallId,
      nativeToolCall,
      turnState,
      step,
      risk,
      boundaryDecision,
      reason: beforeApplyHook.blockReason ?? `Hook blocked ${toolName}.`,
      summary: "before_apply hook blocked execution.",
    });
  }

  let checkpoint: RollbackCheckpointLike | null = null;
  if (changeSet) {
    checkpoint = await dependencies.rollbackStore.checkpointChangeSet(changeSet, {
      sessionId: dependencies.sessionId,
      traceId: turnState.traceId,
      origin: "tool_apply",
      sourceTool: toolName,
    });
    changeSet = withChangeSetMeta(changeSet, {
      rollbackAvailable: true,
      checkpointId: checkpoint.id,
    });
    dependencies.setLastChangeSet(changeSet);
    await dependencies.sessionStore.append("change_checkpointed", {
      traceId: turnState.traceId,
      step,
      tool: toolName,
      checkpointId: checkpoint.id,
      changeSet: summarizeChangeSet(changeSet),
    });
  }

  const executionStart = Date.now();
  try {
    const result = await dependencies.toolRegistry.execute(toolName, toJsonObject(effectiveInput), toExecutionContext({
      sessionId: dependencies.sessionId,
      parentSessionId: dependencies.parentSessionId,
      rootSessionId: dependencies.parentSessionId ?? dependencies.sessionId,
      traceId: turnState.traceId,
      step,
      onWebEvent: async (event: Record<string, unknown>) => {
        await dependencies.onWebEvent(event);
      },
      onMcpEvent: async (event: Record<string, unknown>) => {
        await dependencies.onMcpEvent(event);
      },
    }));
    const executionDuration = Date.now() - executionStart;
    turnState.durations.toolExecuteMs += executionDuration;

    if (checkpoint) {
      await dependencies.rollbackStore.markApplied(checkpoint.id, { result });
      await dependencies.sessionStore.append("change_applied", {
        traceId: turnState.traceId,
        step,
        tool: toolName,
        checkpointId: checkpoint.id,
        changeSet: summarizeChangeSet(changeSet),
      });
    }

    if (changeSet) {
      const afterApply = await emitHook(dependencies, "after_apply", {
        toolName,
        toolMeta,
        input,
        effectiveInput,
        boundaryDecision,
        risk,
        changeSet,
        checkpointId: checkpoint?.id ?? null,
        category: "apply",
        success: true,
        resultSummary: summarizeToolResult(result),
      }, {
        traceId: turnState.traceId,
        step,
        sessionId: dependencies.sessionId,
        parentSessionId: dependencies.parentSessionId,
        rootSessionId: dependencies.parentSessionId ?? dependencies.sessionId,
        observePaths: changeSet.touchedFiles,
      });
      noteObservedHookChangeSets(turnState, afterApply);
    }

    const afterTool = await emitHook(dependencies, "after_tool", {
      toolName,
      toolMeta,
      input,
      effectiveInput,
      boundaryDecision,
      risk,
      changeSet,
      category: boundaryDecision.permissionDecision.category,
      success: true,
      resultSummary: summarizeToolResult(result),
    }, {
      traceId: turnState.traceId,
      step,
      sessionId: dependencies.sessionId,
      parentSessionId: dependencies.parentSessionId,
      rootSessionId: dependencies.parentSessionId ?? dependencies.sessionId,
      observePaths: changeSet?.touchedFiles ?? [],
    });
    noteObservedHookChangeSets(turnState, afterTool);

    dependencies.ui.printToolResult?.(toolName, result);
    turnState.toolEvents.push({
      tool: toolName,
      input,
      effectiveInput,
      ok: true,
      result,
      changeSetId: checkpoint?.id ?? null,
      risk,
      boundary: summarizeBoundaryDecision(boundaryDecision),
    });

    if (toolName === "run_shell" && isRecord(result) && result.jobId) {
      turnState.shellJobs.push({
        jobId: result.jobId,
        status: result.status,
        background: result.background,
        durationMs: result.durationMs ?? null,
        exitCode: result.exitCode ?? null,
      });
    }

    if (toolMeta?.source === "mcp") {
      turnState.mcpCalls.push({
        toolName,
        serverId: toolMeta.serverId,
        serverName: toolMeta.serverName,
      });
    }

    if (isRecord(result) && Array.isArray(result.citations)) {
      turnState.sourceCitations.push(...result.citations);
    }
    if (isRecord(result) && isRecord(result.sourcePack) && Array.isArray(result.sourcePack.sourceIds)) {
      turnState.sourceIds.push(...result.sourcePack.sourceIds.map((entry) => `${entry}`));
      await dependencies.sessionStore.append("source_pack", {
        traceId: turnState.traceId,
        step,
        tool: toolName,
        sourcePack: result.sourcePack,
      });
    }

    if (changeSet) {
      for (const filePath of changeSet.touchedFiles) {
        turnState.filesChanged.add(filePath);
      }
    }

    const nextExecutionPlan = dependencies.planner.noteToolExecution(
      dependencies.getLastExecutionPlan(),
      toolName,
      effectiveInput,
      true,
    );
    dependencies.setLastExecutionPlan(nextExecutionPlan);
    turnState.executionPlan = nextExecutionPlan;

    await dependencies.executionJournal.recordPhase({
      traceId: turnState.traceId,
      stepId: step,
      phase: changeSet ? "apply_changes" : "tool_execute",
      inputSummary: `${toolName}${changeSet ? ` (${changeSet.id})` : ""}`,
      outputSummary: summarizeToolResult(result),
      metrics: {
        durationMs: executionDuration,
        risk,
        checkpointId: checkpoint?.id ?? null,
      },
      snapshot: await dependencies.captureStateSnapshot({
        traceId: turnState.traceId,
        phase: changeSet ? "apply_changes" : "tool_execute",
        stepId: step,
        outputSummary: `${toolName} executed successfully.`,
      }),
    });

    await dependencies.pushToolFeedback({
      nativeToolCall,
      toolCallId,
      toolName,
      payload: {
        ok: true,
        result,
      },
    });

    return {
      ok: true,
      result,
      changeSet,
    };
  } catch (error) {
    const executionDuration = Date.now() - executionStart;
    turnState.durations.toolExecuteMs += executionDuration;
    const taxonomy = classifyErrorTaxonomy(error, "filesystem_error");
    const message = toErrorMessage(error);
    dependencies.ui.printError?.(message);
    if (checkpoint) {
      await dependencies.rollbackStore.markApplyFailed(checkpoint.id, error, {
        errorTaxonomy: taxonomy,
      });
    }

    const afterTool = await emitHook(dependencies, "after_tool", {
      toolName,
      toolMeta,
      input,
      effectiveInput,
      boundaryDecision,
      risk,
      changeSet,
      category: boundaryDecision.permissionDecision.category,
      success: false,
      error: message,
    }, {
      traceId: turnState.traceId,
      step,
      sessionId: dependencies.sessionId,
      parentSessionId: dependencies.parentSessionId,
      rootSessionId: dependencies.parentSessionId ?? dependencies.sessionId,
      observePaths: changeSet?.touchedFiles ?? [],
    });
    noteObservedHookChangeSets(turnState, afterTool);

    turnState.toolEvents.push({
      tool: toolName,
      input,
      effectiveInput,
      ok: false,
      error: message,
      changeSetId: checkpoint?.id ?? null,
      risk,
      boundary: summarizeBoundaryDecision(boundaryDecision),
    });
    const nextExecutionPlan = dependencies.planner.noteToolExecution(
      dependencies.getLastExecutionPlan(),
      toolName,
      effectiveInput,
      false,
    );
    dependencies.setLastExecutionPlan(nextExecutionPlan);
    turnState.executionPlan = nextExecutionPlan;
    await dependencies.sessionStore.append("tool_error", {
      traceId: turnState.traceId,
      step,
      tool: toolName,
      input: effectiveInput,
      error: message,
      taxonomy,
      checkpointId: checkpoint?.id ?? null,
    });
    await dependencies.executionJournal.recordPhase({
      traceId: turnState.traceId,
      stepId: step,
      phase: changeSet ? "apply_changes" : "tool_execute",
      inputSummary: toolName,
      outputSummary: message,
      metrics: {
        durationMs: executionDuration,
        checkpointId: checkpoint?.id ?? null,
      },
      error: {
        taxonomy,
        message,
      },
      snapshot: await dependencies.captureStateSnapshot({
        traceId: turnState.traceId,
        phase: changeSet ? "apply_changes" : "tool_execute",
        stepId: step,
        outputSummary: `${toolName} failed.`,
      }),
    });
    await dependencies.pushToolFeedback({
      nativeToolCall,
      toolCallId,
      toolName,
      payload: {
        ok: false,
        error: message,
      },
    });
      return {
        ok: false,
        fatal: false,
        error: message,
      };
  }
}

async function appendBoundaryDecision(
  dependencies: Pick<ExecuteAgentToolDependencies, "sessionStore" | "executionJournal">,
  decision: ExecutionBoundaryDecision,
  phase: "tool_execute" | "apply_changes",
): Promise<void> {
  await dependencies.sessionStore.append("execution_boundary_decision", decision.event);
  try {
    await dependencies.executionJournal.append({
      type: "execution_boundary_decision",
      traceId: decision.event.traceId ?? null,
      stepId: decision.event.step ?? null,
      phase,
      payload: decision.event,
    });
  } catch (error) {
    if (!isJournalUnavailableError(error)) {
      throw error;
    }
  }
}

async function emitHook(
  dependencies: Pick<
    ExecuteAgentToolDependencies,
    "hookRunner" | "sessionId" | "parentSessionId"
  >,
  eventName: "before_tool" | "after_tool" | "before_apply" | "after_apply",
  payload: Record<string, unknown>,
  context: {
    traceId?: string | null;
    step?: string | number | null;
    sessionId?: string | null;
    parentSessionId?: string | null;
    rootSessionId?: string | null;
    observePaths?: string[];
  },
): Promise<HookEmitResult | null> {
  if (!dependencies.hookRunner) {
    return null;
  }
  return dependencies.hookRunner.emit(eventName, payload, context);
}

function buildHookPayload({
  toolName,
  toolMeta,
  input,
  effectiveInput,
  boundaryDecision,
  risk,
  changeSet,
  category,
  success,
  resultSummary,
  error,
  checkpointId = null,
}: {
  toolName: string;
  toolMeta: ToolMetadata | null;
  input: Record<string, unknown>;
  effectiveInput: Record<string, unknown>;
  boundaryDecision: ExecutionBoundaryDecision;
  risk: RiskAssessment;
  changeSet: ChangeSetRecord | null;
  category: string;
  success?: boolean;
  resultSummary?: string | null;
  error?: string | null;
  checkpointId?: string | null;
}): Record<string, unknown> {
  return {
    toolName,
    toolSource: toolMeta?.source ?? "local",
    category,
    input,
    effectiveInput,
    success,
    error: error ?? null,
    resultSummary: resultSummary ?? null,
    requiresApproval: boundaryDecision.requiresApproval,
    boundary: summarizeBoundaryDecision(boundaryDecision),
    permission: boundaryDecision.permissionDecision,
    risk,
    changeSet: summarizeChangeSet(changeSet),
    checkpointId,
  };
}

function isJournalUnavailableError(error: unknown): error is Error {
  return error instanceof Error
    && error.message === "Execution journal is not initialized.";
}

async function blockToolExecution(
  dependencies: ExecuteAgentToolDependencies,
  {
    toolName,
    input,
    effectiveInput,
    toolCallId,
    nativeToolCall,
    turnState,
    step,
    risk,
    boundaryDecision,
    reason,
    summary,
  }: {
    toolName: string;
    input: Record<string, unknown>;
    effectiveInput: Record<string, unknown>;
    toolCallId: string | null;
    nativeToolCall: boolean;
    turnState: TurnStateLike;
    step: string | number;
    risk: RiskAssessment;
    boundaryDecision: ExecutionBoundaryDecision;
    reason: string;
    summary: string;
  },
): Promise<AgentToolExecutionResult> {
  dependencies.ui.printWarning?.(reason);
  turnState.toolEvents.push({
    tool: toolName,
    input,
    effectiveInput,
    ok: false,
    error: reason,
    risk,
    boundary: summarizeBoundaryDecision(boundaryDecision),
  });
  await dependencies.sessionStore.append("tool_denied", {
    traceId: turnState.traceId,
    step,
    tool: toolName,
    input: effectiveInput,
    reason,
    risk,
    boundary: summarizeBoundaryDecision(boundaryDecision),
  });
  await dependencies.executionJournal.recordPhase({
    traceId: turnState.traceId,
    stepId: step,
    phase: inferPhaseFromTool(toolName),
    inputSummary: toolName,
    outputSummary: reason,
    error: {
      taxonomy: "hook_blocked",
      message: summary,
    },
  });
  await dependencies.pushToolFeedback({
    nativeToolCall,
    toolCallId,
    toolName,
    payload: {
      ok: false,
      error: reason,
    },
  });
  const blockedPlan = dependencies.planner.noteToolBlocked?.(
    dependencies.getLastExecutionPlan(),
    {
      toolName,
      reasonKind: "boundary_blocked",
      summary: reason,
      taxonomy: "hook_blocked",
      commandInput: effectiveInput,
    },
  ) ?? dependencies.getLastExecutionPlan();
  dependencies.setLastExecutionPlan(blockedPlan);
  turnState.executionPlan = blockedPlan;
  return {
    ok: false,
    fatal: false,
    error: reason,
  };
}

async function confirmApproval(ui: UiLike, approvalContext: ApprovalContext): Promise<boolean> {
  if (typeof ui.confirmAction === "function") {
    return ui.confirmAction(approvalContext);
  }
  if (typeof ui.confirm === "function") {
    return ui.confirm(buildLegacyApprovalPrompt(approvalContext));
  }
  return true;
}

function noteObservedHookChangeSets(
  turnState: TurnStateLike,
  result: HookEmitResult | null,
): void {
  for (const changeSet of result?.observedChangeSets ?? []) {
    for (const filePath of changeSet.touchedFiles ?? []) {
      turnState.filesChanged.add(filePath);
    }
  }
}

function inferPhaseFromTool(toolName: string): "tool_execute" | "apply_changes" {
  return isPreviewRequiredTool(toolName) ? "apply_changes" : "tool_execute";
}

function isChangeSetRecord(value: unknown): value is ChangeSetRecord {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.touchedFiles);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function cloneInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error ?? "Unknown error"}`;
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}

function toExecutionContext(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}
