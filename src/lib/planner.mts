import crypto from "node:crypto";

import type {
  ExecutionPlan,
  ModelDecision,
  PlanBlockedReasonKind,
  PlanEvent,
  PlanEventKind,
  PlanGoal,
  PlanGoalStatus,
  PlanReplanDecision,
  PlanRiskHint,
  PlanRiskHintKind,
  PlanStep,
  PlanStepBlockedReason,
  PlanStepKind,
  PlanStepStatus,
  PlanStopCondition,
  PlanSubtask,
  PlanVerificationRequirement,
  RouteDecision,
  TaskClassification,
} from "../types/contracts.js";

type PlannerStepType =
  | "inspect"
  | "retrieve"
  | "analyze"
  | "edit"
  | "execute"
  | "verify"
  | "fallback"
  | "summarize";

interface PlannerRouteCapabilityHint {
  name?: string | null;
}

interface PlannerStep extends PlanStep {
  id: string;
  type: PlannerStepType;
  title: string;
  status: PlanStepStatus;
  kind: PlanStepKind;
  capabilityHints: string[];
  dependsOn: string[];
  note: string | null;
  startedAt: string | null;
  completedAt: string | null;
  blockedReason: PlanStepBlockedReason | null;
  verification: PlanVerificationRequirement | null;
  riskHints: PlanRiskHint[];
  approvalRequired: boolean;
}

interface PlannerExecutionPlan extends ExecutionPlan {
  planId: string;
  taskClass: string;
  goal: PlanGoal;
  subtasks: PlanSubtask[];
  promptSummary: string;
  routeId: string | null;
  model: string | null;
  graphType: string;
  steps: PlannerStep[];
  edges: Array<{
    from: string;
    to: string;
    condition: string;
  }>;
  currentStep: string | null;
  completedSteps: string[];
  blockedSteps: string[];
  failedSteps: string[];
  fallbackSteps: string[];
  blockedReasons: PlanStepBlockedReason[];
  doneCriteria: string[];
  verificationBias: boolean;
  status: PlanGoalStatus;
  stopCondition: PlanStopCondition | null;
  replanCount: number;
  events: PlanEvent[];
  createdAt: string;
  lastUpdatedAt: string;
}

interface PlannerCreatePlanInput {
  prompt: string;
  taskClassification?: TaskClassification | null;
  routeDecision?: RouteDecision | null;
  modelDecision?: ModelDecision | null;
}

interface ToolExecutionInput {
  command?: string;
  [key: string]: unknown;
}

interface PlannerFailureInput {
  reasonKind: PlanBlockedReasonKind;
  summary: string;
  stepType?: PlannerStepType | null;
  taxonomy?: string | null;
  preferFallback?: boolean;
}

export class Planner {
  createPlan({
    prompt,
    taskClassification,
    routeDecision,
    modelDecision,
  }: PlannerCreatePlanInput): PlannerExecutionPlan {
    const taskClass = taskClassification?.taskClass ?? "repo_understanding";
    const verificationBias = ["code_edit", "bug_fix", "refactor", "test_repair", "shell_execution"].includes(taskClass);
    const riskHints = buildPlanRiskHints(taskClassification, routeDecision, modelDecision, verificationBias);
    const steps = buildSteps(taskClass, routeDecision, riskHints, verificationBias);
    const createdAt = new Date().toISOString();
    if (steps.length > 0) {
      steps[0].status = "in_progress";
      steps[0].startedAt = createdAt;
    }

    const plan: PlannerExecutionPlan = {
      planId: crypto.randomUUID().slice(0, 12),
      taskClass,
      goal: buildGoal(prompt, taskClass, verificationBias),
      subtasks: buildSubtasks(steps, verificationBias),
      promptSummary: summarizePrompt(prompt),
      routeId: routeDecision?.routeId ?? null,
      model: modelDecision?.chosenModel ?? null,
      graphType: "dependency_graph_v1",
      steps,
      edges: buildEdges(steps),
      currentStep: steps.find((step) => step.status === "in_progress")?.id ?? null,
      completedSteps: [],
      blockedSteps: [],
      failedSteps: [],
      fallbackSteps: steps.filter((step) => step.kind === "fallback").map((step) => step.id),
      blockedReasons: [],
      doneCriteria: buildDoneCriteria(taskClass),
      verificationBias,
      status: "active",
      stopCondition: {
        kind: "unknown",
        status: "continue",
        summary: "Continue until the goal is satisfied and required verification is complete.",
      },
      replanCount: 0,
      events: [],
      createdAt,
      lastUpdatedAt: createdAt,
    };

    appendEvent(plan, {
      kind: "created",
      status: "info",
      summary: `Created ${plan.graphType} for ${taskClass}.`,
    }, createdAt);
    if (steps[0]) {
      appendEvent(plan, {
        kind: "step_started",
        status: "progressed",
        summary: `Started ${steps[0].title}.`,
        stepId: steps[0].id,
      }, createdAt);
    }
    updateGoalAndSubtasks(plan);
    return plan;
  }

  noteContextPrepared(plan: ExecutionPlan | null): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }
    const now = new Date().toISOString();
    const active = getCurrentStep(next);
    if (active && active.type === "inspect") {
      active.note = "Context prepared; inspect local state before taking actions.";
    }
    appendEvent(next, {
      kind: "step_started",
      status: "info",
      summary: "Context preparation finished; plan is ready for tool execution.",
      stepId: active?.id ?? null,
    }, now);
    next.lastUpdatedAt = now;
    updateGoalAndSubtasks(next);
    return next;
  }

  noteToolExecution(
    plan: ExecutionPlan | null,
    toolName: string,
    input: ToolExecutionInput = {},
    ok = true,
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }
    const stepType = mapToolToStepType(toolName, input, next);
    if (!stepType) {
      return next;
    }
    if (!ok) {
      return this.noteFailure(next, {
        reasonKind: "tool_failed",
        summary: `Tool ${toolName} failed.`,
        stepType,
        preferFallback: stepType === "verify" || stepType === "edit" || stepType === "execute",
      });
    }
    return completePlannedStep(next, stepType, `Tool ${toolName} executed successfully.`);
  }

  noteToolBlocked(
    plan: ExecutionPlan | null,
    input: {
      toolName: string;
      reasonKind: Extract<
        PlanBlockedReasonKind,
        "permission_denied" | "approval_denied" | "boundary_blocked" | "tool_preview_failed"
      >;
      summary: string;
      taxonomy?: string | null;
      commandInput?: ToolExecutionInput;
    },
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }
    const stepType = mapToolToStepType(input.toolName, input.commandInput ?? {}, next);
    return this.noteFailure(next, {
      reasonKind: input.reasonKind,
      summary: input.summary,
      taxonomy: input.taxonomy ?? null,
      stepType,
      preferFallback: input.reasonKind === "tool_preview_failed",
    });
  }

  noteProviderFailure(
    plan: ExecutionPlan | null,
    input: {
      taxonomy: string;
      summary: string;
    },
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }
    return this.noteFailure(next, {
      reasonKind: input.taxonomy === "provider_circuit_open"
        ? "provider_circuit_open"
        : "provider_retry_exhausted",
      summary: input.summary,
      taxonomy: input.taxonomy,
      preferFallback: false,
    });
  }

  noteVerificationStarted(
    plan: ExecutionPlan | null,
    { note = "Verifier started." }: { note?: string | null } = {},
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }

    const now = new Date().toISOString();
    const verify = findStep(next, "verify");
    if (!verify) {
      return next;
    }

    const active = getCurrentStep(next);
    if (active && active.id !== verify.id && active.type !== "fallback") {
      markStepCompleted(next, active, active.note ?? `Moved from ${active.type} into verification.`, now);
    }

    verify.status = "in_progress";
    verify.startedAt = verify.startedAt ?? now;
    verify.completedAt = null;
    verify.note = note ?? verify.note;
    verify.blockedReason = null;
    next.failedSteps = next.failedSteps.filter((stepId) => stepId !== verify.id);
    next.blockedSteps = next.blockedSteps.filter((stepId) => stepId !== verify.id);
    next.currentStep = verify.id;
    next.status = "active";
    next.stopCondition = {
      kind: "unknown",
      status: "continue",
      summary: "Verification is in progress.",
      stepId: verify.id,
    };
    appendEvent(next, {
      kind: "verification_started",
      status: "progressed",
      summary: note ?? "Verifier started.",
      stepId: verify.id,
    }, now);
    next.lastUpdatedAt = now;
    updateGoalAndSubtasks(next);
    return next;
  }

  noteVerificationResult(
    plan: ExecutionPlan | null,
    {
      success,
      note = null,
    }: {
      success: boolean;
      note?: string | null;
    },
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }

    const verify = findStep(next, "verify");
    if (!verify) {
      return next;
    }

    const now = new Date().toISOString();
    if (success) {
      markStepCompleted(next, verify, note ?? "Verification passed.", now);
      appendEvent(next, {
        kind: "verification_result",
        status: "done",
        summary: note ?? "Verification passed.",
        stepId: verify.id,
      }, now);
      const summarize = findStep(next, "summarize");
      if (summarize && summarize.status === "pending") {
        startStep(next, summarize, now, "Verification passed; summarize the result.");
      }
      next.status = "active";
      next.stopCondition = {
        kind: "unknown",
        status: "continue",
        summary: "Verification passed; continue to final summary.",
        stepId: summarize?.id ?? verify.id,
      };
      next.lastUpdatedAt = now;
      updateGoalAndSubtasks(next);
      return next;
    }

    return this.noteFailure(next, {
      reasonKind: "verifier_failed",
      summary: note ?? "Verification failed.",
      stepType: "verify",
      preferFallback: true,
    });
  }

  noteRepairStarted(
    plan: ExecutionPlan | null,
    input: {
      attempt: number;
      maxAttempts: number;
      note?: string | null;
    },
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }

    const fallback = findStep(next, "fallback");
    if (!fallback) {
      return next;
    }
    const now = new Date().toISOString();
    startStep(
      next,
      fallback,
      now,
      input.note ?? `Repair attempt ${input.attempt}/${input.maxAttempts} started.`,
    );
    next.status = "degraded";
    next.stopCondition = {
      kind: "unknown",
      status: "continue",
      summary: `Repair attempt ${input.attempt}/${input.maxAttempts} is in progress.`,
      stepId: fallback.id,
    };
    appendEvent(next, {
      kind: "repair_started",
      status: "progressed",
      summary: input.note ?? `Repair attempt ${input.attempt}/${input.maxAttempts} started.`,
      stepId: fallback.id,
    }, now);
    next.lastUpdatedAt = now;
    updateGoalAndSubtasks(next);
    return next;
  }

  noteRepairResult(
    plan: ExecutionPlan | null,
    input: {
      success: boolean;
      exhausted?: boolean;
      note?: string | null;
    },
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }
    const fallback = findStep(next, "fallback");
    if (!fallback) {
      return next;
    }

    const now = new Date().toISOString();
    if (input.success) {
      markStepCompleted(next, fallback, input.note ?? "Repair succeeded.", now);
      appendEvent(next, {
        kind: "repair_result",
        status: "done",
        summary: input.note ?? "Repair succeeded.",
        stepId: fallback.id,
      }, now);
      const verify = findStep(next, "verify");
      if (verify) {
        verify.status = "in_progress";
        verify.note = "Repair succeeded; verification is required before finalizing.";
        verify.startedAt = verify.startedAt ?? now;
        verify.completedAt = null;
        verify.blockedReason = null;
        next.failedSteps = next.failedSteps.filter((stepId) => stepId !== verify.id);
        next.currentStep = verify.id;
      }
      next.status = "active";
      next.stopCondition = {
        kind: "unknown",
        status: "continue",
        summary: "Repair succeeded; re-run verification before finalizing.",
        stepId: verify?.id ?? null,
      };
      next.lastUpdatedAt = now;
      updateGoalAndSubtasks(next);
      return next;
    }

    if (input.exhausted) {
      return this.noteFailure(next, {
        reasonKind: "repair_exhausted",
        summary: input.note ?? "Repair budget exhausted.",
        stepType: "fallback",
        preferFallback: false,
      });
    }

    fallback.status = "in_progress";
    fallback.note = input.note ?? fallback.note;
    appendEvent(next, {
      kind: "repair_result",
      status: "failed",
      summary: input.note ?? "Repair did not converge; continue bounded repair path.",
      stepId: fallback.id,
    }, now);
    next.status = "degraded";
    next.currentStep = fallback.id;
    next.lastUpdatedAt = now;
    updateGoalAndSubtasks(next);
    return next;
  }

  noteFinal(
    plan: ExecutionPlan | null,
    input: {
      success?: boolean;
      reasonKind?: PlanBlockedReasonKind | null;
      note?: string | null;
    } = {},
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }

    const now = new Date().toISOString();
    const success = input.success !== false;
    const summarize = findStep(next, "summarize");
    const active = getCurrentStep(next);

    if (success) {
      if (active && active.type !== "summarize" && active.status === "in_progress") {
        markStepCompleted(next, active, active.note ?? `Completed ${active.title}.`, now);
      }
      if (summarize) {
        summarize.status = "completed";
        summarize.startedAt = summarize.startedAt ?? now;
        summarize.completedAt = now;
        summarize.note = input.note ?? "Summarized the completed work.";
        next.completedSteps = uniqueIds([...next.completedSteps, summarize.id]);
      }
      next.currentStep = null;
      next.status = "completed";
      next.stopCondition = {
        kind: "goal_satisfied",
        status: "done",
        summary: input.note ?? "Goal satisfied and ready to return.",
        stepId: summarize?.id ?? null,
        satisfiedAt: now,
      };
      appendEvent(next, {
        kind: "finalized",
        status: "done",
        summary: input.note ?? "Plan finalized successfully.",
        stepId: summarize?.id ?? null,
      }, now);
      next.lastUpdatedAt = now;
      updateGoalAndSubtasks(next);
      return next;
    }

    const reasonKind = input.reasonKind ?? "unknown";
    const currentType = inferFailureStepType(next, reasonKind);
    const failed = this.noteFailure(next, {
      reasonKind,
      summary: input.note ?? summarizeFinalFailure(reasonKind),
      stepType: currentType,
      preferFallback: false,
    });
    if (hasPlannerSteps(failed)) {
      const summarize = findStep(failed, "summarize");
      if (summarize && summarize.status !== "completed") {
        summarize.status = "blocked";
        summarize.completedAt = now;
        summarize.note = input.note ?? summarizeFinalFailure(reasonKind);
        failed.blockedSteps = uniqueIds([...failed.blockedSteps, summarize.id]);
      }
      failed.currentStep = null;
      failed.status = reasonKind === "permission_denied" || reasonKind === "approval_denied" || reasonKind === "boundary_blocked"
        ? "blocked"
        : "failed";
      if (!failed.stopCondition || failed.stopCondition.status !== "stop" || failed.stopCondition.kind === "verifier_failed") {
        failed.stopCondition = toStopCondition(reasonKind, input.note ?? summarizeFinalFailure(reasonKind), now);
      }
      appendEvent(failed, {
        kind: "finalized",
        status: "failed",
        summary: input.note ?? summarizeFinalFailure(reasonKind),
        stepId: null,
        reasonKind,
      }, now);
      failed.lastUpdatedAt = now;
      updateGoalAndSubtasks(failed);
    }
    return failed;
  }

  private noteFailure(
    plan: ExecutionPlan | null,
    input: PlannerFailureInput,
  ): ExecutionPlan | null {
    const next = clonePlan(plan);
    if (!hasPlannerSteps(next)) {
      return next;
    }

    const now = new Date().toISOString();
    const target = resolveFailureStep(next, input.stepType ?? null);
    const previousStepId = target?.id ?? next.currentStep ?? null;
    const reason = createBlockedReason(input, target?.id ?? null, now);

    if (target) {
      if (input.reasonKind === "permission_denied" || input.reasonKind === "approval_denied" || input.reasonKind === "boundary_blocked") {
        markStepBlocked(next, target, reason, now);
      } else {
        markStepFailed(next, target, reason, now);
      }
    }

    const decision = resolveReplanDecision(next, input.reasonKind, previousStepId, input.preferFallback === true);
    if (decision.action === "fallback" || decision.action === "replan") {
      next.replanCount += 1;
      const targetStep = decision.targetStepId ? getStepById(next, decision.targetStepId) : null;
      if (targetStep) {
        startStep(next, targetStep, now, decision.summary);
        next.status = decision.action === "fallback" ? "degraded" : "active";
      } else {
        next.currentStep = null;
      }
    } else {
      next.currentStep = null;
      next.status = decision.action === "stop"
        ? toTerminalStatus(input.reasonKind)
        : next.status;
      next.stopCondition = toStopCondition(input.reasonKind, input.summary, now, previousStepId);
    }

    appendBlockedReason(next, reason);
    appendEvent(next, {
      kind: target?.status === "blocked" ? "step_blocked" : "step_failed",
      status: target?.status === "blocked" ? "blocked" : "failed",
      summary: input.summary,
      stepId: target?.id ?? null,
      reasonKind: input.reasonKind,
    }, now);
    appendEvent(next, {
      kind: "replanned",
      status: decision.action === "stop" ? "failed" : "replanned",
      summary: decision.summary,
      stepId: decision.targetStepId,
      reasonKind: input.reasonKind,
      replan: decision,
    }, now);
    next.lastUpdatedAt = now;
    updateGoalAndSubtasks(next);
    return next;
  }
}

function buildSteps(
  taskClass: string,
  routeDecision: RouteDecision | null | undefined,
  riskHints: PlanRiskHint[],
  verificationBias: boolean,
): PlannerStep[] {
  const routeCapabilities = (routeDecision?.selectedCapabilities ?? [])
    .map((entry: PlannerRouteCapabilityHint) => entry.name)
    .filter(isNonEmptyString)
    .slice(0, 6);

  const steps: PlannerStep[] = [
    createStep("inspect", "Inspect local context and current state", routeCapabilities, riskHints, verificationBias),
  ];

  if (["web_retrieval", "official_docs_lookup", "mcp_delegation", "memory_lookup"].includes(taskClass)) {
    steps.push(createStep("retrieve", "Retrieve the required external or stored context", routeCapabilities, riskHints, verificationBias));
  }

  steps.push(createStep("analyze", "Decompose the task and choose the next bounded action", routeCapabilities, riskHints, verificationBias));

  if (["code_edit", "bug_fix", "refactor", "test_repair"].includes(taskClass)) {
    steps.push(createStep("edit", "Apply targeted code or file changes", routeCapabilities, riskHints, verificationBias));
  }

  if (["shell_execution", "test_repair"].includes(taskClass)) {
    steps.push(createStep("execute", "Run the required command or shell workflow", routeCapabilities, riskHints, verificationBias));
  }

  if (verificationBias) {
    steps.push(createStep("verify", "Verify the result before finalizing", routeCapabilities, riskHints, verificationBias));
    steps.push(createStep("fallback", "Repair or degrade safely when verification fails", routeCapabilities, riskHints, verificationBias, {
      kind: "fallback",
    }));
  }

  steps.push(createStep("summarize", "Summarize the outcome and remaining risks", routeCapabilities, riskHints, verificationBias));

  for (let index = 0; index < steps.length; index += 1) {
    const current = steps[index];
    const previousPrimary = [...steps.slice(0, index)].reverse().find((step) => step.kind !== "fallback") ?? null;
    if (!current) {
      continue;
    }
    if (current.type === "fallback") {
      const verify = steps.find((step) => step.type === "verify");
      current.dependsOn = verify ? [verify.id] : [];
      current.fallbackPath = {
        summary: "Enter bounded repair or degraded recovery when verification fails.",
        stepIds: [current.id],
        triggerKinds: ["verifier_failed"],
      };
      continue;
    }
    current.dependsOn = previousPrimary ? [previousPrimary.id] : [];
  }

  const fallback = steps.find((step) => step.type === "fallback");
  const verify = steps.find((step) => step.type === "verify");
  if (verify && fallback) {
    verify.fallbackPath = {
      summary: "If verification fails, enter the bounded fallback path.",
      stepIds: [fallback.id],
      triggerKinds: ["verifier_failed"],
    };
  }
  return steps;
}

function buildSubtasks(steps: PlannerStep[], verificationBias: boolean): PlanSubtask[] {
  const groups: Array<{
    id: string;
    title: string;
    summary: string;
    stepTypes: PlannerStepType[];
    dependsOn: string[];
    verificationBias: boolean;
  }> = [
    {
      id: "context",
      title: "Context",
      summary: "Inspect and gather the minimum state needed to act safely.",
      stepTypes: ["inspect", "retrieve", "analyze"],
      dependsOn: [],
      verificationBias: false,
    },
    {
      id: "change",
      title: "Change",
      summary: "Apply bounded edits or commands that advance the goal.",
      stepTypes: ["edit", "execute"],
      dependsOn: ["context"],
      verificationBias: false,
    },
    {
      id: "verification",
      title: "Verification",
      summary: "Verify the result and enter bounded repair when needed.",
      stepTypes: ["verify", "fallback"],
      dependsOn: ["change"],
      verificationBias,
    },
    {
      id: "summary",
      title: "Summary",
      summary: "Return the outcome, blockers, and remaining risk.",
      stepTypes: ["summarize"],
      dependsOn: verificationBias ? ["verification"] : ["change"],
      verificationBias: false,
    },
  ];

  return groups
    .map((group) => {
      const groupSteps = steps.filter((step) => group.stepTypes.includes(step.type));
      if (groupSteps.length === 0) {
        return null;
      }
      return {
        id: group.id,
        title: group.title,
        summary: group.summary,
        status: summarizeSubtaskStatus(groupSteps),
        stepIds: groupSteps.map((step) => step.id),
        dependsOn: group.dependsOn,
        capabilityHints: [...new Set(groupSteps.flatMap((step) => step.capabilityHints))].slice(0, 6),
        verificationBias: group.verificationBias,
        riskHints: dedupeRiskHints(groupSteps.flatMap((step) => step.riskHints)),
        doneCriteria: groupSteps.map((step) => step.title),
      } satisfies PlanSubtask;
    })
    .filter((entry): entry is PlanSubtask => entry != null);
}

function buildEdges(steps: PlannerStep[]): Array<{ from: string; to: string; condition: string }> {
  const edges: Array<{ from: string; to: string; condition: string }> = [];
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      edges.push({
        from: dependency,
        to: step.id,
        condition: step.type === "fallback" ? "if verification fails" : "after dependency completes",
      });
    }
  }
  return edges;
}

function buildGoal(prompt: string, taskClass: string, verificationBias: boolean): PlanGoal {
  const doneCriteria = buildDoneCriteria(taskClass);
  return {
    summary: summarizePrompt(prompt),
    taskClass,
    status: "active",
    verificationBias,
    doneCriteria,
    successSignal: verificationBias
      ? "Return only after the requested work is done or explicitly blocked, and required verification has passed or been clearly reported."
      : "Return only after the requested work is complete or an explicit blocker is reported.",
    fallbackSummary: verificationBias
      ? "If verification fails, enter bounded repair or stop with an explicit blocker."
      : null,
  };
}

function buildDoneCriteria(taskClass: string): string[] {
  const common = ["Return a clear outcome summary."];
  if (["code_edit", "bug_fix", "refactor", "test_repair"].includes(taskClass)) {
    return [
      "Relevant edits are applied or intentionally skipped with explanation.",
      "Verification is attempted or explicitly blocked with a reason.",
      ...common,
    ];
  }
  if (["web_retrieval", "official_docs_lookup"].includes(taskClass)) {
    return [
      "Relevant sources are gathered and cited.",
      "The answer explains the retrieved evidence.",
      ...common,
    ];
  }
  if (taskClass === "shell_execution") {
    return [
      "The required command path is attempted or explicitly blocked.",
      "The final answer states the observed command outcome.",
      ...common,
    ];
  }
  return common;
}

function buildPlanRiskHints(
  taskClassification: TaskClassification | null | undefined,
  routeDecision: RouteDecision | null | undefined,
  modelDecision: ModelDecision | null | undefined,
  verificationBias: boolean,
): PlanRiskHint[] {
  const hints: PlanRiskHint[] = [];
  const riskHintText = normalizeNonEmptyString(taskClassification?.riskHint);
  if (taskClassification?.likelyWrites) {
    hints.push(createRiskHint("writes", "medium", riskHintText ?? "The task likely changes project files."));
  }
  if (taskClassification?.likelyShell) {
    hints.push(createRiskHint("shell", "medium", "The task likely needs shell execution or command verification."));
  }
  if (taskClassification?.likelyWeb) {
    hints.push(createRiskHint("network", "medium", "The task may depend on web retrieval or fresh external context."));
  }
  if ((routeDecision?.governance?.approvalPolicy ?? "") !== "never" && taskClassification?.likelyWrites) {
    hints.push({
      kind: "approval",
      level: "medium",
      summary: `Write actions may require approval under ${routeDecision?.governance?.approvalPolicy ?? "current"} policy.`,
      requiresApproval: true,
    });
  }
  for (const degradedFlag of modelDecision?.degradedFlags ?? routeDecision?.governance?.degradedFlags ?? []) {
    hints.push(createRiskHint("runtime_degraded", "medium", `Runtime degraded flag: ${degradedFlag}.`));
  }
  if (verificationBias) {
    hints.push(createRiskHint("verification", "medium", "Verification should gate the final answer."));
  }
  return dedupeRiskHints(hints);
}

function createRiskHint(kind: PlanRiskHintKind, level: PlanRiskHint["level"], summary: string): PlanRiskHint {
  return {
    kind,
    level,
    summary,
  };
}

function createStep(
  type: PlannerStepType,
  title: string,
  capabilityHints: string[],
  inheritedRiskHints: PlanRiskHint[],
  verificationBias: boolean,
  overrides: {
    kind?: PlanStepKind;
  } = {},
): PlannerStep {
  const stepRiskHints = dedupeRiskHints([
    ...inheritedRiskHints,
    ...(type === "edit" ? [createRiskHint("writes", "medium", "This step changes files or project state.")] : []),
    ...(type === "execute" ? [createRiskHint("shell", "medium", "This step runs commands or test workflows.")] : []),
    ...(type === "verify" ? [createRiskHint("verification", "medium", "This step validates whether the task can safely stop.")] : []),
  ]);
  return {
    id: `${type}-${crypto.randomUUID().slice(0, 6)}`,
    type,
    title,
    status: "pending",
    kind: overrides.kind ?? "primary",
    capabilityHints: capabilityHints.slice(0, 6),
    dependsOn: [],
    note: null,
    startedAt: null,
    completedAt: null,
    blockedReason: null,
    verification: buildVerificationRequirement(type, verificationBias),
    riskHints: stepRiskHints,
    approvalRequired: stepRiskHints.some((entry) => entry.requiresApproval === true),
    fallbackPath: null,
  };
}

function buildVerificationRequirement(
  type: PlannerStepType,
  verificationBias: boolean,
): PlanVerificationRequirement | null {
  if (!verificationBias) {
    return null;
  }
  if (type === "edit") {
    return {
      required: true,
      trigger: "after_edit",
      summary: "Edits should not finalize without verification.",
      blockingOnFailure: true,
    };
  }
  if (type === "execute") {
    return {
      required: true,
      trigger: "after_execute",
      summary: "Execution outcomes should be verified before finalize.",
      blockingOnFailure: true,
    };
  }
  if (type === "verify" || type === "fallback") {
    return {
      required: true,
      trigger: type === "fallback" ? "post_repair" : "before_finalize",
      summary: type === "fallback"
        ? "Repair must converge back into a verified path."
        : "Verification gates the final answer.",
      blockingOnFailure: true,
    };
  }
  return null;
}

function completePlannedStep(
  plan: PlannerExecutionPlan,
  stepType: PlannerStepType,
  summary: string,
): PlannerExecutionPlan {
  const now = new Date().toISOString();
  const active = getCurrentStep(plan);
  const target = findNextStepByType(plan, stepType);

  if (active && active.id !== target?.id && active.kind !== "fallback" && active.status === "in_progress") {
    markStepCompleted(plan, active, active.note ?? `Completed ${active.title}.`, now);
  }

  if (target) {
    markStepCompleted(plan, target, summary, now);
    appendEvent(plan, {
      kind: "step_completed",
      status: "done",
      summary,
      stepId: target.id,
    }, now);
    const nextStep = pickNextStep(plan, target.id);
    if (nextStep) {
      startStep(plan, nextStep, now, nextStep.note);
    } else {
      plan.currentStep = null;
    }
  }

  plan.stopCondition = {
    kind: "unknown",
    status: "continue",
    summary: "Plan can continue.",
    stepId: plan.currentStep,
  };
  plan.status = plan.failedSteps.length > 0 ? "degraded" : "active";
  plan.lastUpdatedAt = now;
  updateGoalAndSubtasks(plan);
  return plan;
}

function startStep(plan: PlannerExecutionPlan, step: PlannerStep, now: string, note: string | null | undefined): void {
  const active = getCurrentStep(plan);
  if (active && active.id !== step.id && active.status === "in_progress") {
    active.status = "completed";
    active.completedAt = now;
    plan.completedSteps = uniqueIds([...plan.completedSteps, active.id]);
  }
  step.status = "in_progress";
  step.startedAt = step.startedAt ?? now;
  step.note = note ?? step.note;
  plan.currentStep = step.id;
  appendEvent(plan, {
    kind: "step_started",
    status: "progressed",
    summary: note ?? `Started ${step.title}.`,
    stepId: step.id,
  }, now);
}

function markStepCompleted(plan: PlannerExecutionPlan, step: PlannerStep, note: string, now: string): void {
  step.status = "completed";
  step.startedAt = step.startedAt ?? now;
  step.completedAt = now;
  step.note = note;
  step.blockedReason = null;
  plan.completedSteps = uniqueIds([...plan.completedSteps, step.id]);
  plan.failedSteps = plan.failedSteps.filter((stepId) => stepId !== step.id);
  plan.blockedSteps = plan.blockedSteps.filter((stepId) => stepId !== step.id);
}

function markStepFailed(plan: PlannerExecutionPlan, step: PlannerStep, reason: PlanStepBlockedReason, now: string): void {
  step.status = "failed";
  step.startedAt = step.startedAt ?? now;
  step.completedAt = now;
  step.note = reason.summary;
  step.blockedReason = reason;
  plan.failedSteps = uniqueIds([...plan.failedSteps, step.id]);
  plan.completedSteps = plan.completedSteps.filter((stepId) => stepId !== step.id);
}

function markStepBlocked(plan: PlannerExecutionPlan, step: PlannerStep, reason: PlanStepBlockedReason, now: string): void {
  step.status = "blocked";
  step.startedAt = step.startedAt ?? now;
  step.completedAt = now;
  step.note = reason.summary;
  step.blockedReason = reason;
  plan.blockedSteps = uniqueIds([...plan.blockedSteps, step.id]);
}

function resolveFailureStep(plan: PlannerExecutionPlan, preferredType: PlannerStepType | null): PlannerStep | null {
  const active = getCurrentStep(plan);
  if (preferredType) {
    return findNextStepByType(plan, preferredType) ?? active ?? null;
  }
  return active ?? null;
}

function resolveReplanDecision(
  plan: PlannerExecutionPlan,
  reasonKind: PlanBlockedReasonKind,
  previousStepId: string | null,
  preferFallback: boolean,
): PlanReplanDecision {
  const fallback = findStep(plan, "fallback");
  const analyze = findStep(plan, "analyze");
  const verify = findStep(plan, "verify");
  if (reasonKind === "verifier_failed" && fallback) {
    return {
      action: "fallback",
      reasonKind,
      summary: "Verification failed; enter the bounded repair path.",
      previousStepId,
      targetStepId: fallback.id,
      verificationRequired: true,
    };
  }
  if (reasonKind === "tool_failed" && preferFallback && fallback) {
    return {
      action: "fallback",
      reasonKind,
      summary: "Execution failed on a change-producing path; move into bounded fallback.",
      previousStepId,
      targetStepId: fallback.id,
      verificationRequired: Boolean(verify),
    };
  }
  if (["permission_denied", "approval_denied", "boundary_blocked", "tool_preview_failed"].includes(reasonKind) && analyze) {
    return {
      action: "replan",
      reasonKind,
      summary: "Current path was blocked; return to analyze and choose a safer action.",
      previousStepId,
      targetStepId: analyze.id,
      verificationRequired: Boolean(verify),
    };
  }
  if (reasonKind === "tool_failed" && analyze) {
    return {
      action: "replan",
      reasonKind,
      summary: "Tool execution failed; return to analyze and select a fallback action.",
      previousStepId,
      targetStepId: analyze.id,
      verificationRequired: Boolean(verify),
    };
  }
  if (reasonKind === "provider_retry_exhausted" || reasonKind === "provider_circuit_open") {
    return {
      action: "stop",
      reasonKind,
      summary: "Provider execution could not continue safely; stop and surface the runtime failure.",
      previousStepId,
      targetStepId: null,
      verificationRequired: Boolean(verify),
    };
  }
  if (reasonKind === "repair_exhausted" || reasonKind === "max_steps_exhausted") {
    return {
      action: "stop",
      reasonKind,
      summary: reasonKind === "repair_exhausted"
        ? "Repair budget is exhausted; stop instead of looping."
        : "Step budget is exhausted; stop instead of looping.",
      previousStepId,
      targetStepId: null,
      verificationRequired: Boolean(verify),
    };
  }
  return {
    action: "stop",
    reasonKind,
    summary: "The plan cannot continue safely; stop and surface the blocker.",
    previousStepId,
    targetStepId: null,
    verificationRequired: Boolean(verify),
  };
}

function appendBlockedReason(plan: PlannerExecutionPlan, reason: PlanStepBlockedReason): void {
  const exists = plan.blockedReasons.some((entry) =>
    entry.kind === reason.kind &&
    entry.summary === reason.summary &&
    entry.stepId === reason.stepId,
  );
  if (!exists) {
    plan.blockedReasons = [...plan.blockedReasons, reason];
  }
}

function createBlockedReason(input: PlannerFailureInput, stepId: string | null, now: string): PlanStepBlockedReason {
  return {
    kind: input.reasonKind,
    summary: input.summary,
    blockedAt: now,
    recoverable: !["repair_exhausted", "provider_retry_exhausted", "provider_circuit_open", "max_steps_exhausted"].includes(input.reasonKind),
    stepId,
    taxonomy: input.taxonomy ?? null,
  };
}

function toTerminalStatus(reasonKind: PlanBlockedReasonKind): PlanGoalStatus {
  return ["permission_denied", "approval_denied", "boundary_blocked"].includes(reasonKind)
    ? "blocked"
    : "failed";
}

function toStopCondition(
  reasonKind: PlanBlockedReasonKind,
  summary: string,
  now: string,
  stepId: string | null = null,
): PlanStopCondition {
  if (reasonKind === "repair_exhausted") {
    return {
      kind: "repair_exhausted",
      status: "stop",
      summary,
      stepId,
      satisfiedAt: now,
    };
  }
  if (reasonKind === "verifier_failed") {
    return {
      kind: "verifier_failed",
      status: "stop",
      summary,
      stepId,
      satisfiedAt: now,
    };
  }
  if (reasonKind === "provider_retry_exhausted" || reasonKind === "provider_circuit_open") {
    return {
      kind: "provider_failed",
      status: "stop",
      summary,
      stepId,
      satisfiedAt: now,
    };
  }
  if (reasonKind === "max_steps_exhausted") {
    return {
      kind: "max_steps_exhausted",
      status: "stop",
      summary,
      stepId,
      satisfiedAt: now,
    };
  }
  return {
    kind: "blocked",
    status: "stop",
    summary,
    stepId,
    satisfiedAt: now,
  };
}

function inferFailureStepType(plan: PlannerExecutionPlan, reasonKind: PlanBlockedReasonKind): PlannerStepType | null {
  if (reasonKind === "verifier_failed") {
    return "verify";
  }
  if (reasonKind === "repair_exhausted") {
    return "fallback";
  }
  return getCurrentStep(plan)?.type ?? null;
}

function summarizeFinalFailure(reasonKind: PlanBlockedReasonKind): string {
  if (reasonKind === "provider_retry_exhausted") {
    return "Provider retries were exhausted.";
  }
  if (reasonKind === "provider_circuit_open") {
    return "Provider circuit is open and blocked further execution.";
  }
  if (reasonKind === "max_steps_exhausted") {
    return "The step budget was exhausted before a final answer was ready.";
  }
  if (reasonKind === "repair_exhausted") {
    return "Repair budget was exhausted before verification could pass.";
  }
  if (reasonKind === "verifier_failed") {
    return "Verification failed and the turn could not safely continue.";
  }
  return "The turn ended with a blocking failure.";
}

function updateGoalAndSubtasks(plan: PlannerExecutionPlan): void {
  const total = plan.steps.length;
  const completed = plan.completedSteps.length;
  if (plan.status === "completed") {
    plan.goal.status = "completed";
  } else if (plan.status === "failed") {
    plan.goal.status = "failed";
  } else if (plan.status === "blocked") {
    plan.goal.status = "blocked";
  } else if (plan.failedSteps.length > 0 || plan.blockedSteps.length > 0) {
    plan.goal.status = "degraded";
  } else if (completed === 0 && total > 0) {
    plan.goal.status = "active";
  } else {
    plan.goal.status = plan.status;
  }

  for (const subtask of plan.subtasks) {
    const steps = subtask.stepIds
      .map((stepId) => getStepById(plan, stepId))
      .filter((step): step is PlannerStep => step != null);
    subtask.status = summarizeSubtaskStatus(steps);
  }
}

function summarizeSubtaskStatus(steps: PlannerStep[]): PlanGoalStatus {
  if (steps.length === 0) {
    return "pending";
  }
  if (steps.every((step) => step.status === "completed")) {
    return "completed";
  }
  if (steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (steps.some((step) => step.status === "blocked")) {
    return "blocked";
  }
  if (steps.some((step) => step.status === "in_progress")) {
    return "active";
  }
  return "pending";
}

function pickNextStep(plan: PlannerExecutionPlan, currentStepId: string): PlannerStep | null {
  const currentIndex = plan.steps.findIndex((step) => step.id === currentStepId);
  for (let index = currentIndex + 1; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    if (!step || step.kind === "fallback" || step.status !== "pending") {
      continue;
    }
    return step;
  }
  return null;
}

function appendEvent(
  plan: PlannerExecutionPlan,
  input: {
    kind: PlanEventKind;
    status: PlanEvent["status"];
    summary: string;
    stepId?: string | null;
    linkedStepIds?: string[];
    linkedEventId?: string | null;
    reasonKind?: PlanBlockedReasonKind | null;
    replan?: PlanReplanDecision | null;
  },
  createdAt: string,
): void {
  plan.events = [
    ...plan.events,
    {
      id: crypto.randomUUID().slice(0, 12),
      createdAt,
      kind: input.kind,
      status: input.status,
      summary: input.summary,
      stepId: input.stepId ?? null,
      linkedStepIds: input.linkedStepIds ?? [],
      linkedEventId: input.linkedEventId ?? null,
      reasonKind: input.reasonKind ?? null,
      replan: input.replan ?? null,
    },
  ];
}

function dedupeRiskHints(hints: PlanRiskHint[]): PlanRiskHint[] {
  const seen = new Set<string>();
  const next: PlanRiskHint[] = [];
  for (const hint of hints) {
    const key = `${hint.kind}:${hint.level}:${hint.summary}:${hint.requiresApproval === true}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(hint);
  }
  return next;
}

function findStep(plan: PlannerExecutionPlan, type: PlannerStepType): PlannerStep | null {
  return plan.steps.find((step) => step.type === type) ?? null;
}

function findNextStepByType(plan: PlannerExecutionPlan, type: PlannerStepType): PlannerStep | null {
  return plan.steps.find((step) => step.type === type && !["completed", "failed", "blocked"].includes(step.status)) ?? null;
}

function getCurrentStep(plan: PlannerExecutionPlan): PlannerStep | null {
  return plan.currentStep ? getStepById(plan, plan.currentStep) : null;
}

function getStepById(plan: PlannerExecutionPlan, stepId: string): PlannerStep | null {
  return plan.steps.find((step) => step.id === stepId) ?? null;
}

function mapToolToStepType(
  toolName: string,
  input: ToolExecutionInput,
  plan: ExecutionPlan | null,
): PlannerStepType | null {
  if (["list_dir", "read_file", "search_files", "pwd"].includes(toolName)) {
    const inspectOpen = hasPlannerSteps(plan) && Boolean(findNextStepByType(plan, "inspect"));
    return inspectOpen ? "inspect" : "analyze";
  }
  if (
    ["web_search", "fetch_url", "extract_content", "search_memory"].includes(toolName) ||
    toolName.startsWith("mcp__")
  ) {
    return "retrieve";
  }
  if (["write_file", "replace_in_file", "apply_patch"].includes(toolName)) {
    return "edit";
  }
  if (toolName === "run_shell") {
    const command = `${input.command ?? ""}`.toLowerCase();
    if (
      /\b(test|lint|check|build|verify)\b/.test(command) &&
      hasPlannerSteps(plan) &&
      plan.steps.some((step) => step?.type === "verify")
    ) {
      return "verify";
    }
    return "execute";
  }
  return "analyze";
}

function summarizePrompt(prompt: string): string {
  const text = `${prompt ?? ""}`.replace(/\s+/g, " ").trim();
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clonePlan<T>(plan: T): T {
  return plan ? structuredClone(plan) : plan;
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter(isNonEmptyString))];
}

function hasPlannerSteps(plan: ExecutionPlan | null): plan is PlannerExecutionPlan {
  return Boolean(plan && Array.isArray(plan.steps) && Array.isArray(plan.events));
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
