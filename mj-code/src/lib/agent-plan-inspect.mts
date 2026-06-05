import type {
  ExecutionPlan,
  PlanBlockedReasonKind,
  PlanCommandSuggestion,
  PlanCurrentReport,
  PlanEvent,
  PlanGoalStatus,
  PlanInspectResolvedReference,
  PlanRenderProfile,
  PlanStep,
  PlanStepBlockedReason,
  PlanTimelineReport,
  SessionReplay,
  TraceSummary,
} from "../types/contracts.js";

interface PlanInspectSnapshotLike {
  state?: {
    lastExecutionPlan?: ExecutionPlan | null;
    lastTrace?: TraceSummary | null;
    [key: string]: unknown;
  } | null;
}

interface PlanInspectSessionStoreLike {
  buildReplay(reference: string): Promise<SessionReplay>;
}

interface PlanInspectExecutionJournalLike {
  loadLatestSnapshot(sessionId: string): Promise<PlanInspectSnapshotLike | null>;
}

export interface PlanInspectTarget {
  sessionId: string | null;
  lastTrace: TraceSummary | null;
  lastExecutionPlan: ExecutionPlan | null;
  sessionStore: PlanInspectSessionStoreLike;
  executionJournal: PlanInspectExecutionJournalLike;
}

export async function resolvePlanReference(
  target: PlanInspectTarget,
  reference: string = "current",
): Promise<{
  source: PlanInspectResolvedReference;
  plan: ExecutionPlan | null;
}> {
  const normalized = `${reference ?? "current"}`.trim() || "current";
  if (normalized === "current" || normalized === "latest") {
    const plan = clonePlan(target.lastExecutionPlan);
    return {
      source: {
        kind: normalized === "latest" ? "latest" : "current",
        reference: null,
        sessionId: target.sessionId,
        traceId: target.lastTrace?.traceId ?? null,
        planId: plan?.planId ?? null,
      },
      plan,
    };
  }

  if (normalized === "trace") {
    const plan = clonePlan(target.lastTrace?.executionPlan ?? target.lastExecutionPlan);
    return {
      source: {
        kind: "trace",
        reference: null,
        sessionId: target.sessionId,
        traceId: target.lastTrace?.traceId ?? null,
        planId: plan?.planId ?? null,
      },
      plan,
    };
  }

  if (normalized.startsWith("replay:")) {
    const replayReference = normalized.slice("replay:".length);
    const replay = await target.sessionStore.buildReplay(replayReference);
    const snapshot = await target.executionJournal.loadLatestSnapshot(replay.session.id).catch(() => null);
    const plan = clonePlan(snapshot?.state?.lastExecutionPlan ?? null);
    const trace = snapshot?.state?.lastTrace ?? null;
    return {
      source: {
        kind: "replay",
        reference: replayReference,
        sessionId: replay.session.id,
        traceId: trace?.traceId ?? null,
        planId: plan?.planId ?? null,
      },
      plan,
    };
  }

  throw new Error(`Unsupported plan reference: ${reference}`);
}

export function buildPlanCurrentReport(
  source: PlanInspectResolvedReference,
  plan: ExecutionPlan | null,
): PlanCurrentReport {
  if (!hasPlanSteps(plan)) {
    return {
      source,
      available: false,
      plan: null,
      goal: null,
      currentStep: null,
      blockers: [],
      latestReplan: null,
      recentEvents: [],
      suggestedCommands: buildPlanSuggestions(source, null, null, [], null),
      summary: {
        status: "pending",
        totalSteps: 0,
        completedSteps: 0,
        blockerCount: 0,
        replanCount: 0,
        verificationRequired: false,
      },
    };
  }

  const blockers = collectBlockedReasons(plan);
  const currentStep = getCurrentStep(plan);
  const latestReplan = [...(plan.events ?? [])].reverse().find((entry) => entry.kind === "replanned") ?? null;
  const recentEvents = (plan.events ?? []).slice(-6);
  return {
    source,
    available: true,
    plan,
    goal: plan.goal ?? null,
    currentStep,
    blockers,
    latestReplan,
    recentEvents,
    suggestedCommands: buildPlanSuggestions(source, plan, currentStep, blockers, latestReplan),
    summary: {
      status: normalizePlanStatus(plan.status),
      totalSteps: plan.steps.length,
      completedSteps: (plan.completedSteps ?? []).length,
      blockerCount: blockers.length,
      replanCount: Number(plan.replanCount ?? 0),
      verificationRequired: Boolean(plan.verificationBias),
    },
  };
}

export function buildPlanTimelineReport(
  source: PlanInspectResolvedReference,
  plan: ExecutionPlan | null,
): PlanTimelineReport {
  if (!hasPlanSteps(plan)) {
    return {
      source,
      available: false,
      plan: null,
      latestState: {
        status: "pending",
        currentStepId: null,
        stopCondition: null,
        replanCount: 0,
      },
      leadingProblemEvent: null,
      events: [],
      blockers: [],
      suggestedCommands: buildPlanSuggestions(source, null, null, [], null),
    };
  }

  const events = (plan.events ?? []).slice(-10);
  const blockers = collectBlockedReasons(plan);
  const preferredReasonKind = mapStopConditionToReasonKind(plan.stopCondition?.kind ?? null);
  const preferredProblemEvent = preferredReasonKind
    ? [...(plan.events ?? [])].reverse().find((entry) => entry.reasonKind === preferredReasonKind) ?? null
    : null;
  const fallbackProblemEvent = [...(plan.events ?? [])].reverse().find((entry) =>
    entry.kind === "step_failed" ||
    entry.kind === "step_blocked" ||
    (entry.kind === "replanned" && entry.reasonKind !== "waiting_on_verification")
  ) ?? null;
  const leadingProblemEvent = preferredProblemEvent ?? fallbackProblemEvent ?? synthesizeLeadingProblemEvent(plan);
  const currentStep = getCurrentStep(plan);
  return {
    source,
    available: true,
    plan,
    latestState: {
      status: normalizePlanStatus(plan.status),
      currentStepId: currentStep?.id ?? null,
      stopCondition: plan.stopCondition ?? null,
      replanCount: Number(plan.replanCount ?? 0),
    },
    leadingProblemEvent,
    events,
    blockers,
    suggestedCommands: buildPlanSuggestions(source, plan, currentStep, blockers, leadingProblemEvent),
  };
}

export function normalizePlanRenderProfile(value: string | null | undefined): PlanRenderProfile {
  return value === "summary" || value === "failures" ? value : "json";
}

export function renderPlanCurrentReport(
  report: PlanCurrentReport,
  profile: PlanRenderProfile = "summary",
): string {
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (!report.available || !report.plan) {
    return "Plan unavailable.";
  }

  const lines = [
    `Plan Current: ${report.goal?.summary ?? report.plan.promptSummary ?? report.source.kind}`,
    `source=${renderPlanSource(report.source)} status=${report.summary.status} current=${report.currentStep?.title ?? "none"} replanCount=${report.summary.replanCount}`,
  ];
  if (profile === "failures") {
    return [
      ...lines,
      formatBlockers(report.blockers),
      formatLatestReplan(report.latestReplan),
      formatStopCondition(report.plan.stopCondition ?? null),
      formatCommandSuggestions(report.suggestedCommands),
    ].filter(Boolean).join("\n");
  }

  lines.push(formatBlockers(report.blockers));
  lines.push(formatLatestReplan(report.latestReplan));
  lines.push("Recent Events:");
  for (const event of report.recentEvents.slice(-4)) {
    lines.push(`- ${event.createdAt} [${event.kind}] ${event.summary}`);
  }
  lines.push(formatCommandSuggestions(report.suggestedCommands));
  return lines.filter(Boolean).join("\n");
}

export function renderPlanTimelineReport(
  report: PlanTimelineReport,
  profile: PlanRenderProfile = "summary",
): string {
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (!report.available || !report.plan) {
    return "Plan timeline unavailable.";
  }
  const lines = [
    `Plan Timeline: ${report.plan.goal?.summary ?? report.plan.promptSummary ?? report.source.kind}`,
    `source=${renderPlanSource(report.source)} status=${report.latestState.status} current=${report.latestState.currentStepId ?? "none"} replanCount=${report.latestState.replanCount}`,
  ];

  if (profile === "failures") {
    return [
      ...lines,
      report.leadingProblemEvent ? `Leading Problem: ${report.leadingProblemEvent.createdAt} ${report.leadingProblemEvent.summary}` : "",
      formatBlockers(report.blockers),
      formatStopCondition(report.latestState.stopCondition),
      formatCommandSuggestions(report.suggestedCommands),
    ].filter(Boolean).join("\n");
  }

  lines.push(report.leadingProblemEvent
    ? `Leading Problem: ${report.leadingProblemEvent.createdAt} ${report.leadingProblemEvent.summary}`
    : "Leading Problem: none");
  lines.push("Events:");
  for (const event of report.events) {
    lines.push(`- ${event.createdAt} [${event.kind}] ${event.summary}`);
  }
  lines.push(formatBlockers(report.blockers));
  lines.push(formatCommandSuggestions(report.suggestedCommands));
  return lines.filter(Boolean).join("\n");
}

function buildPlanSuggestions(
  source: PlanInspectResolvedReference,
  plan: ExecutionPlan | null,
  currentStep: PlanStep | null,
  blockers: PlanStepBlockedReason[],
  focalEvent: PlanEvent | null,
): PlanCommandSuggestion[] {
  const suggestions: PlanCommandSuggestion[] = [];
  const sourceRef = source.kind === "replay"
    ? `replay:${source.reference}`
    : source.kind;

  suggestions.push({
    command: `node src/cli.mjs plan timeline ${sourceRef} summary`,
    reason: "查看最近的 plan 演化和 replan 连续性。",
    priority: 100,
  });

  const blockerKinds = new Set(blockers.map((entry) => entry.kind));
  if (blockerKinds.has("verifier_failed") || focalEvent?.reasonKind === "verifier_failed") {
    suggestions.push({
      command: "node src/cli.mjs verifier trace summary",
      reason: "当前主要阻塞来自 verifier 失败，先看 verifier surface。",
      priority: 95,
    });
  }
  if (blockerKinds.has("provider_retry_exhausted") || blockerKinds.has("provider_circuit_open")) {
    suggestions.push({
      command: "node src/cli.mjs runtime circuits",
      reason: "当前计划被 provider/circuit 状态阻塞。",
      priority: 94,
    });
  }
  if (blockerKinds.has("permission_denied") || blockerKinds.has("approval_denied") || blockerKinds.has("boundary_blocked")) {
    suggestions.push({
      command: "node src/cli.mjs why tool",
      reason: "当前路径被权限或边界阻塞，先看 tool/risk 决策。",
      priority: 93,
    });
  }
  if (currentStep?.type === "verify" || Boolean(plan?.verificationBias)) {
    suggestions.push({
      command: "node src/cli.mjs why plan",
      reason: "查看当前为什么停在这个 step，以及何时需要验证才能停止。",
      priority: 90,
    });
  }
  if (source.sessionId) {
    suggestions.push({
      command: `node src/cli.mjs replay "${source.sessionId}"`,
      reason: "回放对应 session，交叉核对 tool/phases/verifier 连续性。",
      priority: 80,
    });
  }

  return suggestions
    .sort((left, right) => right.priority - left.priority || left.command.localeCompare(right.command))
    .slice(0, 4);
}

function formatBlockers(blockers: PlanStepBlockedReason[]): string {
  if (blockers.length === 0) {
    return "Blockers: none";
  }
  return [
    "Blockers:",
    ...blockers.slice(-3).map((entry) => `- ${entry.kind}: ${entry.summary}`),
  ].join("\n");
}

function formatLatestReplan(event: PlanEvent | null): string {
  return event
    ? `Latest Replan: ${event.createdAt} ${event.summary}`
    : "Latest Replan: none";
}

function formatStopCondition(stopCondition: ExecutionPlan["stopCondition"] | null): string {
  return stopCondition
    ? `Stop Condition: ${stopCondition.kind}/${stopCondition.status} ${stopCondition.summary}`
    : "Stop Condition: continue";
}

function formatCommandSuggestions(suggestions: PlanCommandSuggestion[]): string {
  if (suggestions.length === 0) {
    return "Next Commands: none";
  }
  return [
    "Next Commands:",
    ...suggestions.map((entry) => `- ${entry.command}  # ${entry.reason}`),
  ].join("\n");
}

function renderPlanSource(source: PlanInspectResolvedReference): string {
  if (source.kind === "replay") {
    return `replay:${source.reference}`;
  }
  return source.kind;
}

function mapStopConditionToReasonKind(kind: string | null): PlanBlockedReasonKind | null {
  if (kind === "repair_exhausted") {
    return "repair_exhausted";
  }
  if (kind === "verifier_failed") {
    return "verifier_failed";
  }
  if (kind === "provider_failed") {
    return "provider_retry_exhausted";
  }
  if (kind === "max_steps_exhausted") {
    return "max_steps_exhausted";
  }
  return null;
}

function synthesizeLeadingProblemEvent(plan: ExecutionPlan): PlanEvent | null {
  if (!plan.stopCondition || plan.stopCondition.status !== "stop") {
    return null;
  }
  return {
    id: `synthetic-${plan.planId ?? "plan"}-${plan.stopCondition.kind}`,
    createdAt: plan.stopCondition.satisfiedAt ?? plan.lastUpdatedAt ?? plan.createdAt ?? new Date(0).toISOString(),
    kind: "replanned",
    status: "failed",
    summary: plan.stopCondition.summary,
    stepId: plan.stopCondition.stepId ?? null,
    linkedStepIds: [],
    linkedEventId: null,
    reasonKind: mapStopConditionToReasonKind(plan.stopCondition.kind),
    replan: null,
  };
}

function collectBlockedReasons(plan: ExecutionPlan): PlanStepBlockedReason[] {
  const blockers = [
    ...(Array.isArray(plan.blockedReasons) ? plan.blockedReasons : []),
    ...plan.steps
      .map((step) => step.blockedReason ?? null)
      .filter((entry): entry is PlanStepBlockedReason => entry != null),
  ];
  const seen = new Set<string>();
  return blockers.filter((entry) => {
    const key = `${entry.kind}:${entry.summary}:${entry.stepId ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getCurrentStep(plan: ExecutionPlan): PlanStep | null {
  return plan.currentStep
    ? (plan.steps.find((step) => step.id === plan.currentStep) ?? null)
    : null;
}

function normalizePlanStatus(value: unknown): PlanGoalStatus {
  return value === "active" || value === "blocked" || value === "degraded" || value === "failed" || value === "completed"
    ? value
    : "pending";
}

function hasPlanSteps(plan: ExecutionPlan | null): plan is ExecutionPlan & { steps: PlanStep[] } {
  return Boolean(plan && Array.isArray(plan.steps));
}

function clonePlan(plan: ExecutionPlan | null | undefined): ExecutionPlan | null {
  return plan ? structuredClone(plan) : null;
}
