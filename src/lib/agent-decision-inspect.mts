import type {
  AgentDecisionAssessment,
  AgentDecisionLayer,
  AgentDecisionLayerSummary,
  AgentDecisionProblem,
  AgentDecisionProblemKind,
  AgentDecisionRenderProfile,
  AgentDecisionReport,
  AgentDecisionResolvedReference,
  AgentDecisionScope,
  AgentDecisionStatus,
  AgentDecisionSuggestion,
  AgentRecoveryKind,
  AgentRecoveryStatus,
  AgentRecoverySuggestion,
  ChangeSetSummary,
  ExecutionJournalEntry,
  ExecutionBoundaryDecisionSummary,
  ExecutionPlan,
  PlanCurrentReport,
  PlanStepBlockedReason,
  PlanTimelineReport,
  RepairLoopRecord,
  RouteDecision,
  RuntimeHealthScorecard,
  SessionReplay,
  ShellCommandClassification,
  TaskClassification,
  TraceSummary,
  VerifierGitHubMutationSelection,
  VerifierInspectReport,
  VerifierRunRecord,
} from "../types/contracts.js";

import {
  buildPlanCurrentReport,
  buildPlanTimelineReport,
} from "./agent-plan-inspect.mjs";
import {
  VerifierGitHubMutationStore,
} from "./agent-verifier-github-store.mjs";
import {
  buildCurrentVerifierInspectReport,
  buildReplayVerifierInspectReport,
  buildTraceVerifierInspectReport,
} from "./agent-verifier-inspect.mjs";

interface DecisionSnapshotLike {
  state?: {
    lastChangeSet?: ChangeSetSummary | null;
    lastTaskClassification?: TaskClassification | null;
    lastRouteDecision?: RouteDecision | null;
    lastModelDecision?: AgentDecisionReport["modelDecision"] | null;
    lastExecutionPlan?: ExecutionPlan | null;
    lastTrace?: TraceSummary | null;
    [key: string]: unknown;
  } | null;
}

interface DecisionSessionStoreLike {
  buildReplay(reference: string): Promise<SessionReplay>;
}

interface DecisionExecutionJournalLike {
  loadLatestSnapshot(sessionId: string): Promise<DecisionSnapshotLike | null>;
  readEntries(sessionId: string): Promise<ExecutionJournalEntry[]>;
}

interface DecisionRuntimeHealthLike {
  getScorecard?(): RuntimeHealthScorecard;
  getOverview?(): unknown;
}

export interface AgentDecisionInspectTarget {
  config: {
    projectStateDir: string;
  };
  sessionId: string | null;
  lastTrace: TraceSummary | null;
  lastChangeSet: ChangeSetSummary | Record<string, unknown> | null;
  lastTaskClassification: unknown;
  lastRouteDecision: unknown;
  lastModelDecision: unknown;
  lastExecutionPlan: ExecutionPlan | null;
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
  runtimeHealth: DecisionRuntimeHealthLike;
  sessionStore: DecisionSessionStoreLike;
  executionJournal: DecisionExecutionJournalLike;
}

interface DecisionResolvedState {
  source: AgentDecisionResolvedReference;
  taskClassification: TaskClassification | null;
  routeDecision: RouteDecision | null;
  modelDecision: AgentDecisionReport["modelDecision"] | null;
  executionPlan: ExecutionPlan | null;
  trace: TraceSummary | null;
  replay: SessionReplay | null;
  verifier: VerifierInspectReport | null;
  runtimeScorecard: RuntimeHealthScorecard | null;
  lastChangeSet: ChangeSetSummary | null;
  githubMutation: VerifierGitHubMutationSelection | null;
}

type RenderView = "why" | "next" | "recover";

export async function buildAgentDecisionReport(
  target: AgentDecisionInspectTarget,
  scope: AgentDecisionScope = "overview",
  reference: string = "current",
): Promise<AgentDecisionReport> {
  const resolved = await resolveAgentDecisionReference(target, reference);
  if (!resolved.taskClassification && !resolved.routeDecision && !resolved.modelDecision && !resolved.executionPlan && !resolved.verifier) {
    return {
      scope,
      source: resolved.source,
      available: false,
      status: "unavailable",
      assessment: {
        bounded: false,
        confidence: "low",
        unavailableReason: "No decision state is available for this reference.",
      },
      taskClassification: null,
      routeDecision: null,
      modelDecision: null,
      executionPlan: null,
      planCurrent: null,
      planTimeline: null,
      verifier: null,
      runtimeScorecard: resolved.runtimeScorecard,
      toolContext: null,
      githubMutation: normalizeGitHubContext(resolved.githubMutation),
      leadingProblem: null,
      degradedLayers: [],
      blockingReasons: [],
      nextSteps: buildDecisionSuggestions({
        source: resolved.source,
        scope,
        taskClassification: null,
        routeDecision: null,
        modelDecision: null,
        planCurrent: null,
        verifier: null,
        runtimeScorecard: resolved.runtimeScorecard,
        leadingProblem: null,
        githubMutation: resolved.githubMutation,
      }),
      recovery: [{
        kind: "insufficient_context",
        layer: "plan",
        status: "insufficient_context",
        blocking: false,
        summary: "No recovery guidance is available yet.",
        reason: "The selected reference has no task, plan, or verifier continuity state.",
        whyNow: "Run a task first or inspect a replay session with recorded continuity state.",
        commands: [{
          kind: "inspect",
          layer: "plan",
          command: "node src/cli.mjs route last",
          reason: "Check whether the session recorded any prior routing decision.",
          whyNow: "This confirms whether there is reusable intelligence state to inspect.",
          priority: 100,
        }],
      }],
    };
  }

  const planCurrent = buildPlanCurrentReport(resolved.source, resolved.executionPlan);
  const planTimeline = buildPlanTimelineReport(resolved.source, resolved.executionPlan);
  const toolContext = buildToolContext(resolved, planCurrent);
  const degradedLayers = collectLayerSummaries(resolved, planCurrent, toolContext);
  const blockingReasons = collectBlockingReasons(resolved, planCurrent, planTimeline, toolContext);
  const leadingProblem = blockingReasons[0] ?? deriveLeadingProblemFromLayers(degradedLayers);
  const status = deriveDecisionStatus(resolved, planCurrent, blockingReasons, degradedLayers);
  const assessment = buildAssessment(resolved, status);
  const nextSteps = buildDecisionSuggestions({
    source: resolved.source,
    scope,
    taskClassification: resolved.taskClassification,
    routeDecision: resolved.routeDecision,
    modelDecision: resolved.modelDecision,
    planCurrent,
    verifier: resolved.verifier,
    runtimeScorecard: resolved.runtimeScorecard,
    leadingProblem,
    githubMutation: resolved.githubMutation,
  });
  const recovery = buildRecoverySuggestions({
    source: resolved.source,
    planCurrent,
    verifier: resolved.verifier,
    toolContext,
    runtimeScorecard: resolved.runtimeScorecard,
    leadingProblem,
    githubMutation: resolved.githubMutation,
  });

  return {
    scope,
    source: resolved.source,
    available: true,
    status,
    assessment,
    taskClassification: resolved.taskClassification,
    routeDecision: resolved.routeDecision,
    modelDecision: resolved.modelDecision,
    executionPlan: resolved.executionPlan,
    planCurrent,
    planTimeline,
    verifier: resolved.verifier,
    runtimeScorecard: resolved.runtimeScorecard,
    toolContext,
    githubMutation: normalizeGitHubContext(resolved.githubMutation),
    leadingProblem,
    degradedLayers,
    blockingReasons,
    nextSteps,
    recovery,
  };
}

export function normalizeAgentDecisionRenderProfile(
  value: string | null | undefined,
): AgentDecisionRenderProfile {
  return value === "summary" || value === "failures"
    ? value
    : "json";
}

export function renderAgentDecisionReport(
  report: AgentDecisionReport,
  profile: AgentDecisionRenderProfile = "summary",
  view: RenderView = "why",
): string {
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (!report.available) {
    if (view === "next") {
      return "Next steps unavailable.";
    }
    if (view === "recover") {
      return "Recovery guidance unavailable.";
    }
    return "Why report unavailable.";
  }

  const lines = [
    `${view === "why" ? "Why" : view === "next" ? "Next" : "Recover"} ${capitalize(report.scope)}: status=${report.status} source=${renderDecisionSource(report.source)}`,
  ];
  if (report.leadingProblem) {
    lines.push(`Leading Problem: ${report.leadingProblem.summary}`);
  } else {
    lines.push("Leading Problem: none");
  }

  if (view === "why") {
    appendScopedWhy(lines, report, profile);
  } else if (view === "next") {
    lines.push("Next Steps:");
    for (const suggestion of report.nextSteps.slice(0, 4)) {
      lines.push(`- ${suggestion.command}`);
      lines.push(`  ${suggestion.reason} ${suggestion.whyNow}`);
    }
  } else {
    lines.push("Recovery:");
    for (const suggestion of report.recovery.slice(0, 3)) {
      lines.push(`- [${suggestion.status}] ${suggestion.summary}`);
      lines.push(`  ${suggestion.reason} ${suggestion.whyNow}`);
      for (const command of suggestion.commands.slice(0, 2)) {
        lines.push(`  -> ${command.command}`);
      }
    }
  }

  if (profile === "failures") {
    lines.push(formatDecisionBlockingReasons(report.blockingReasons));
    if (view !== "recover") {
      lines.push(formatDecisionRecovery(report.recovery));
    }
    return lines.filter(Boolean).join("\n");
  }

  lines.push(formatDecisionLayers(report.degradedLayers));
  if (view === "why") {
    lines.push(formatDecisionNextSteps(report.nextSteps));
    lines.push(formatDecisionRecovery(report.recovery));
  }
  return lines.filter(Boolean).join("\n");
}

async function resolveAgentDecisionReference(
  target: AgentDecisionInspectTarget,
  reference: string,
): Promise<DecisionResolvedState> {
  const normalized = normalizeDecisionReference(reference);
  if (normalized === "current" || normalized === "latest") {
    const verifier = buildCurrentVerifierInspectReport({
      sessionId: target.sessionId,
      lastTrace: target.lastTrace,
      lastVerifierRun: target.lastVerifierRun,
      lastRepairLoop: target.lastRepairLoop,
    });
    const githubMutation = normalized === "latest"
      ? await loadLatestGitHubMutation(target.config.projectStateDir)
      : null;
    return {
      source: {
        kind: normalized === "latest" ? "latest" : "current",
        reference: null,
        sessionId: target.sessionId,
        traceId: target.lastTrace?.traceId ?? null,
        planId: target.lastExecutionPlan?.planId ?? null,
      },
      taskClassification: asTaskClassification(target.lastTaskClassification),
      routeDecision: asRouteDecision(target.lastRouteDecision),
      modelDecision: asModelDecision(target.lastModelDecision),
      executionPlan: cloneTyped(target.lastExecutionPlan),
      trace: cloneTyped(target.lastTrace),
      replay: await loadReplayIfAvailable(target, target.sessionId),
      verifier,
      runtimeScorecard: resolveRuntimeScorecard(target.runtimeHealth),
      lastChangeSet: asChangeSetSummary(target.lastChangeSet),
      githubMutation,
    };
  }

  if (normalized === "trace") {
    const sessionId = target.sessionId;
    const entries = sessionId
      ? await target.executionJournal.readEntries(sessionId).catch(() => [])
      : [];
    return {
      source: {
        kind: "trace",
        reference: null,
        sessionId,
        traceId: target.lastTrace?.traceId ?? null,
        planId: target.lastTrace?.executionPlan?.planId ?? target.lastExecutionPlan?.planId ?? null,
      },
      taskClassification: asTaskClassification(target.lastTrace?.taskClassification ?? target.lastTaskClassification),
      routeDecision: asRouteDecision(target.lastTrace?.routeDecision ?? target.lastRouteDecision),
      modelDecision: asModelDecision(target.lastTrace?.modelDecision ?? target.lastModelDecision),
      executionPlan: cloneTyped(target.lastTrace?.executionPlan ?? target.lastExecutionPlan),
      trace: cloneTyped(target.lastTrace),
      replay: await loadReplayIfAvailable(target, sessionId),
      verifier: buildTraceVerifierInspectReport({
        sessionId,
        lastTrace: target.lastTrace,
        lastVerifierRun: target.lastVerifierRun,
        lastRepairLoop: target.lastRepairLoop,
        entries,
      }),
      runtimeScorecard: cloneTyped(target.lastTrace?.runtimeScorecard ?? resolveRuntimeScorecard(target.runtimeHealth)),
      lastChangeSet: asChangeSetSummary(target.lastChangeSet),
      githubMutation: null,
    };
  }

  if (normalized.startsWith("replay:")) {
    const replayReference = normalized.slice("replay:".length);
    const replay = await target.sessionStore.buildReplay(replayReference);
    const snapshot = await target.executionJournal.loadLatestSnapshot(replay.session.id).catch(() => null);
    const trace = asTraceSummary(snapshot?.state?.lastTrace ?? null);
    const githubMutation = null;
    return {
      source: {
        kind: "replay",
        reference: replayReference,
        sessionId: replay.session.id,
        traceId: trace?.traceId ?? null,
        planId: asExecutionPlan(snapshot?.state?.lastExecutionPlan)?.planId ?? null,
      },
      taskClassification: asTaskClassification(snapshot?.state?.lastTaskClassification ?? trace?.taskClassification ?? null),
      routeDecision: asRouteDecision(snapshot?.state?.lastRouteDecision ?? trace?.routeDecision ?? null),
      modelDecision: asModelDecision(snapshot?.state?.lastModelDecision ?? trace?.modelDecision ?? null),
      executionPlan: asExecutionPlan(snapshot?.state?.lastExecutionPlan ?? trace?.executionPlan ?? null),
      trace,
      replay,
      verifier: buildReplayVerifierInspectReport(replay),
      runtimeScorecard: cloneTyped(trace?.runtimeScorecard ?? null),
      lastChangeSet: asChangeSetSummary(snapshot?.state?.lastChangeSet ?? null),
      githubMutation,
    };
  }

  throw new Error(`Unsupported decision reference: ${reference}`);
}

function collectLayerSummaries(
  resolved: DecisionResolvedState,
  planCurrent: PlanCurrentReport,
  toolContext: AgentDecisionReport["toolContext"],
): AgentDecisionLayerSummary[] {
  const summaries: AgentDecisionLayerSummary[] = [];
  const runtimeFlags = resolved.runtimeScorecard?.degradedFlags ?? [];
  summaries.push({
    layer: "route",
    status: resolved.routeDecision?.degraded ? "degraded" : resolved.routeDecision ? "ok" : "unavailable",
    summary: resolved.routeDecision
      ? resolved.routeDecision.degraded
        ? "Routing stayed conservative because capabilities or runtime were constrained."
        : "Routing selected a normal capability path."
      : "No route decision is recorded.",
    reasons: resolved.routeDecision?.reasons?.slice(0, 4) ?? [],
    degraded: Boolean(resolved.routeDecision?.degraded),
    blocking: false,
  });
  summaries.push({
    layer: "model",
    status: (resolved.modelDecision?.degradedFlags?.length ?? 0) > 0 ? "degraded" : resolved.modelDecision ? "ok" : "unavailable",
    summary: resolved.modelDecision
      ? resolved.modelDecision.degradedFlags?.length
        ? "Model routing reacted to degraded provider/runtime health."
        : "Model routing selected the primary model without degradation."
      : "No model decision is recorded.",
    reasons: compactStrings([
      resolved.modelDecision?.reason ?? null,
      ...(resolved.modelDecision?.degradedFlags ?? []),
    ]).slice(0, 4),
    degraded: (resolved.modelDecision?.degradedFlags?.length ?? 0) > 0,
    blocking: false,
  });

  const toolBlocked = toolContext?.latestBoundaryDecision?.blocked ?? false;
  const toolDegraded = toolContext?.latestBoundaryDecision?.degraded ?? false;
  summaries.push({
    layer: "tool",
    status: toolBlocked ? "blocked" : toolDegraded ? "degraded" : toolContext ? "ok" : "unavailable",
    summary: toolContext?.latestBoundaryDecision
      ? toolBlocked
        ? "The latest tool path was blocked by permission, approval, or hook boundary state."
        : toolDegraded
          ? "The latest tool path was allowed but degraded by boundary policy."
          : "The latest tool path was allowed without boundary degradation."
      : "No recent tool boundary decision is recorded.",
    reasons: toolContext?.latestBoundaryDecision?.reasons?.slice(0, 4) ?? [],
    degraded: toolDegraded,
    blocking: toolBlocked,
  });

  const providerBlocked = runtimeFlags.includes("provider_circuit_open");
  summaries.push({
    layer: "provider",
    status: providerBlocked ? "blocked" : runtimeFlags.some((entry) => entry.startsWith("provider_")) ? "degraded" : "ok",
    summary: providerBlocked
      ? "Provider runtime is currently blocked by an open circuit."
      : runtimeFlags.some((entry) => entry.startsWith("provider_"))
        ? "Provider runtime is degraded."
        : "Provider runtime is healthy enough for the current decision surface.",
    reasons: runtimeFlags.filter((entry) => entry.startsWith("provider_")).slice(0, 4),
    degraded: runtimeFlags.some((entry) => entry.startsWith("provider_")),
    blocking: providerBlocked,
  });

  const verifierProblem = deriveVerifierProblem(resolved.verifier, resolved.lastChangeSet);
  summaries.push({
    layer: "verifier",
    status: verifierProblem?.status ?? (resolved.verifier ? "ok" : "unavailable"),
    summary: verifierProblem?.summary ?? (resolved.verifier ? "Verifier state is available." : "No verifier state is recorded."),
    reasons: compactStrings([
      verifierProblem?.why ?? null,
      resolved.verifier?.summary.latestDiagnosticFallbackReason ?? null,
      resolved.verifier?.summary.latestFixHintReason ?? null,
      resolved.verifier?.summary.latestProjectContextReason ?? null,
    ]).slice(0, 4),
    degraded: verifierProblem?.status === "degraded",
    blocking: verifierProblem?.status === "blocked" || verifierProblem?.status === "failed",
  });

  summaries.push({
    layer: "plan",
    status: planCurrent.available
      ? mapPlanStatusToDecisionStatus(planCurrent.summary.status)
      : "unavailable",
    summary: planCurrent.available
      ? planCurrent.currentStep
        ? `Plan is currently focused on "${planCurrent.currentStep.title ?? planCurrent.currentStep.type}".`
        : `Plan status is ${planCurrent.summary.status}.`
      : "No execution plan is available.",
    reasons: compactStrings([
      planCurrent.latestReplan?.summary ?? null,
      planCurrent.plan?.stopCondition?.summary ?? null,
    ]).slice(0, 4),
    degraded: planCurrent.summary.status === "degraded",
    blocking: planCurrent.summary.status === "blocked" || planCurrent.summary.status === "failed",
  });

  const githubSelection = resolved.githubMutation;
  if (githubSelection) {
    summaries.push({
      layer: "github",
      status: githubSelection.available && githubSelection.result
        ? mapGitHubMutationStatus(githubSelection.result.status)
        : "unavailable",
      summary: githubSelection.available && githubSelection.result
        ? githubSelection.result.summary
        : githubSelection.reason ?? "No GitHub mutation continuity is available.",
      reasons: compactStrings([
        githubSelection.result?.reason ?? null,
        githubSelection.reason ?? null,
      ]).slice(0, 4),
      degraded: githubSelection.result?.status === "blocked" || githubSelection.result?.status === "unavailable",
      blocking: githubSelection.result?.status === "blocked",
    });
  }

  return summaries.filter((entry) => entry.status !== "ok" || entry.layer === "plan" || entry.layer === "route" || entry.layer === "model");
}

function collectBlockingReasons(
  resolved: DecisionResolvedState,
  planCurrent: PlanCurrentReport,
  planTimeline: PlanTimelineReport,
  toolContext: AgentDecisionReport["toolContext"],
): AgentDecisionProblem[] {
  const problems: AgentDecisionProblem[] = [];
  for (const blocker of planCurrent.blockers) {
    problems.push(mapPlanBlockerToProblem(blocker));
  }
  if (problems.length === 0 && planTimeline.leadingProblemEvent) {
    const problem = deriveProblemFromPlanEvent(planTimeline.leadingProblemEvent);
    if (problem) {
      problems.push(problem);
    }
  }
  const verifierProblem = deriveVerifierProblem(resolved.verifier, resolved.lastChangeSet);
  if (verifierProblem && !problems.some((entry) => entry.kind === verifierProblem.kind && entry.summary === verifierProblem.summary)) {
    problems.push(verifierProblem);
  }
  const toolProblem = deriveToolProblem(toolContext);
  if (toolProblem && !problems.some((entry) => entry.kind === toolProblem.kind && entry.summary === toolProblem.summary)) {
    problems.push(toolProblem);
  }
  const githubProblem = deriveGitHubProblem(resolved.githubMutation);
  if (githubProblem) {
    problems.push(githubProblem);
  }
  return problems
    .sort((left, right) => compareDecisionStatus(right.status, left.status) || left.summary.localeCompare(right.summary))
    .slice(0, 6);
}

function buildAssessment(
  resolved: DecisionResolvedState,
  status: AgentDecisionStatus,
): AgentDecisionAssessment {
  if (!resolved.taskClassification && !resolved.routeDecision && !resolved.modelDecision && !resolved.executionPlan && !resolved.verifier) {
    return {
      bounded: false,
      confidence: "low",
      unavailableReason: "No decision state is available for this reference.",
    };
  }
  const hasReplay = Boolean(resolved.replay);
  const hasTrace = Boolean(resolved.trace);
  const confidence = hasReplay || hasTrace
    ? "high"
    : resolved.runtimeScorecard
      ? "medium"
      : "low";
  return {
    bounded: true,
    confidence,
    unavailableReason: status === "unavailable"
      ? "No usable decision state was resolved."
      : null,
  };
}

function deriveDecisionStatus(
  resolved: DecisionResolvedState,
  planCurrent: PlanCurrentReport,
  blockingReasons: AgentDecisionProblem[],
  degradedLayers: AgentDecisionLayerSummary[],
): AgentDecisionStatus {
  if (!planCurrent.available && !resolved.verifier && !resolved.routeDecision && !resolved.modelDecision) {
    return "unavailable";
  }
  if (blockingReasons.some((entry) => entry.status === "failed")) {
    return "failed";
  }
  if (blockingReasons.some((entry) => entry.status === "blocked")) {
    return "blocked";
  }
  if (planCurrent.available) {
    const mapped = mapPlanStatusToDecisionStatus(planCurrent.summary.status);
    if (mapped !== "ok") {
      return mapped;
    }
  }
  if (degradedLayers.some((entry) => entry.status === "degraded")) {
    return "degraded";
  }
  return "ok";
}

function buildDecisionSuggestions(input: {
  source: AgentDecisionResolvedReference;
  scope: AgentDecisionScope;
  taskClassification: TaskClassification | null;
  routeDecision: RouteDecision | null;
  modelDecision: AgentDecisionReport["modelDecision"] | null;
  planCurrent: PlanCurrentReport | null;
  verifier: VerifierInspectReport | null;
  runtimeScorecard: RuntimeHealthScorecard | null;
  leadingProblem: AgentDecisionProblem | null;
  githubMutation: VerifierGitHubMutationSelection | null;
}): AgentDecisionSuggestion[] {
  const suggestions: AgentDecisionSuggestion[] = [];
  const sourceRef = input.source.kind === "replay"
    ? `replay:${input.source.reference}`
    : input.source.kind;
  suggestions.push({
    kind: "inspect",
    layer: "plan",
    command: `node src/cli.mjs plan timeline ${sourceRef} summary`,
    reason: "Plan continuity is the shortest path to understand the current control state.",
    whyNow: "It shows blockers, replans, and stop conditions on the same reference.",
    priority: 100,
  });

  if (input.leadingProblem?.layer === "tool") {
    suggestions.push({
      kind: "inspect",
      layer: "tool",
      command: `node src/cli.mjs why tool ${sourceRef} summary`,
      reason: "The leading issue is on the tool/boundary path.",
      whyNow: "This narrows the problem to permission, approval, boundary, or hook state.",
      priority: 98,
    });
  }
  if (input.leadingProblem?.layer === "provider" || (input.runtimeScorecard?.degradedFlags ?? []).includes("provider_circuit_open")) {
    suggestions.push({
      kind: "inspect",
      layer: "provider",
      command: "node src/cli.mjs runtime circuits",
      reason: "Provider runtime degradation is affecting the current path.",
      whyNow: "The circuit surface tells you whether retrying now can succeed.",
      priority: 97,
    });
  }
  if (input.leadingProblem?.layer === "verifier" || input.verifier?.summary.latestVerifierStatus === "failed") {
    suggestions.push({
      kind: "inspect",
      layer: "verifier",
      command: input.source.kind === "replay"
        ? `node src/cli.mjs verifier replay ${input.source.reference} summary`
        : "node src/cli.mjs verifier trace summary",
      reason: "Verifier state is the current gate on progress.",
      whyNow: "It exposes diagnostics, repair continuity, and bounded assist availability.",
      priority: 96,
    });
  }
  if (input.scope !== "route" && input.routeDecision) {
    suggestions.push({
      kind: "inspect",
      layer: "route",
      command: `node src/cli.mjs why route ${sourceRef} summary`,
      reason: "Route selection still explains which capability path the loop is trying to use.",
      whyNow: "This is useful when the current path looks too constrained or too broad.",
      priority: 90,
    });
  }
  if (input.scope !== "model" && input.modelDecision) {
    suggestions.push({
      kind: "inspect",
      layer: "model",
      command: `node src/cli.mjs why model ${sourceRef} summary`,
      reason: "Model routing may already be compensating for runtime pressure.",
      whyNow: "Checking it prevents treating provider degradation as a generic plan failure.",
      priority: 89,
    });
  }
  if (input.githubMutation?.available && input.githubMutation.result) {
    suggestions.push({
      kind: "github",
      layer: "github",
      command: `node src/cli.mjs verifier github result ${input.githubMutation.result.mutationId} summary`,
      reason: "A recent GitHub mutation attempt exists for the same continuity plane.",
      whyNow: "This shows whether CI/reporting failed separately from core verifier state.",
      priority: 84,
    });
  }

  return dedupeDecisionSuggestions(suggestions).slice(0, 4);
}

function buildRecoverySuggestions(input: {
  source: AgentDecisionResolvedReference;
  planCurrent: PlanCurrentReport;
  verifier: VerifierInspectReport | null;
  toolContext: AgentDecisionReport["toolContext"];
  runtimeScorecard: RuntimeHealthScorecard | null;
  leadingProblem: AgentDecisionProblem | null;
  githubMutation: VerifierGitHubMutationSelection | null;
}): AgentRecoverySuggestion[] {
  const leading = input.leadingProblem;
  if (!leading) {
    return [{
      kind: "insufficient_context",
      layer: "plan",
      status: "insufficient_context",
      blocking: false,
      summary: "No focused recovery path is needed.",
      reason: "There is no current blocking problem in the selected decision state.",
      whyNow: "Use the next-step suggestions to continue the normal path.",
      commands: [],
    }];
  }
  switch (leading.kind) {
    case "permission_denied":
      return [buildSimpleRecovery(
        "permission_denied",
        "tool",
        "Recovery requires a workspace-safe path or a less privileged action.",
        leading.why,
        "The last tool path was blocked before execution, so retrying blindly will not help.",
        [
          commandSuggestion("permission_change", "tool", "node src/cli.mjs why tool current summary", "Inspect the blocked path and boundary reason.", "Confirm which exact path or command was denied.", 100),
          commandSuggestion("inspect", "plan", "node src/cli.mjs plan current failures", "Check how the plan replanned around the denial.", "This shows whether the loop already has a fallback path.", 95),
        ],
      )];
    case "approval_denied":
      return [buildSimpleRecovery(
        "approval_denied",
        "tool",
        "Recovery requires operator approval or a lower-risk alternative.",
        leading.why,
        "The tool path was otherwise valid but could not proceed without approval.",
        [
          commandSuggestion("approval", "tool", "node src/cli.mjs why tool current summary", "Review the approval context and risk summary.", "This clarifies what the operator would need to approve.", 100),
          commandSuggestion("inspect", "plan", "node src/cli.mjs next current summary", "Check whether the planner already has a non-write next step.", "This helps avoid unnecessary approval if a read path exists.", 94),
        ],
      )];
    case "boundary_blocked":
      return [buildSimpleRecovery(
        "boundary_blocked",
        "tool",
        "Recovery requires changing the blocked hook/boundary path or choosing a different action.",
        leading.why,
        "The boundary layer blocked the call before it could mutate state.",
        [
          commandSuggestion("inspect", "tool", "node src/cli.mjs why tool current failures", "Inspect the boundary and hook reasons.", "The exact block reason determines whether this is policy, shell, or hook related.", 100),
          commandSuggestion("inspect", "plan", "node src/cli.mjs plan timeline current failures", "See whether the planner moved to a fallback or stayed blocked.", "That tells you if manual intervention is required now.", 93),
        ],
      )];
    case "provider_retry_exhausted":
      return [buildSimpleRecovery(
        "provider_retry_exhausted",
        "provider",
        "Recovery should start from provider/runtime health before retrying the task.",
        leading.why,
        "Retries are already exhausted, so immediate repeat attempts are low value.",
        [
          commandSuggestion("inspect", "provider", "node src/cli.mjs runtime circuits", "Inspect provider circuit state and retry pressure.", "This distinguishes transient retry exhaustion from a still-open circuit.", 100),
          commandSuggestion("inspect", "model", "node src/cli.mjs why model current summary", "Inspect whether model routing already fell back to a conservative path.", "This can reveal a better retry target.", 96),
        ],
      )];
    case "provider_circuit_open":
      return [buildSimpleRecovery(
        "provider_circuit_open",
        "provider",
        "Recovery should wait for circuit cooldown or switch to a healthier provider/model path.",
        leading.why,
        "The provider path is currently blocked by circuit state, not by plan logic.",
        [
          commandSuggestion("wait", "provider", "node src/cli.mjs runtime circuits", "Check cooldown and whether the circuit is still open.", "Retrying before cooldown expires is wasted work.", 100),
          commandSuggestion("inspect", "model", "node src/cli.mjs why model current summary", "Inspect fallback candidates and runtime-aware routing.", "This shows whether a safer alternate model path already exists.", 95),
        ],
      )];
    case "verifier_failed":
      return [buildSimpleRecovery(
        "verifier_failed",
        "verifier",
        "Recovery should start from verifier findings and the current repair state.",
        leading.why,
        "The plan cannot legitimately finish until verification passes or stops for a bounded reason.",
        [
          commandSuggestion("verify", "verifier", input.source.kind === "replay"
            ? `node src/cli.mjs verifier replay ${input.source.reference} failures`
            : "node src/cli.mjs verifier trace failures", "Inspect the failing verifier surface directly.", "This shows the blocking diagnostics and repair continuity.", 100),
          commandSuggestion("inspect", "plan", `node src/cli.mjs why plan ${input.source.kind === "replay" ? `replay:${input.source.reference}` : "current"} failures`, "Inspect why the plan stayed on verification.", "This clarifies whether the loop intends to retry, fallback, or stop.", 94),
        ],
      )];
    case "repair_exhausted":
      return [buildSimpleRecovery(
        "repair_exhausted",
        "verifier",
        "Recovery is now operator-driven; the bounded repair loop has already stopped.",
        leading.why,
        "Another automatic retry would violate the existing repair budget semantics.",
        [
          commandSuggestion("inspect", "verifier", input.source.kind === "replay"
            ? `node src/cli.mjs verifier replay ${input.source.reference} failures`
            : "node src/cli.mjs verifier trace failures", "Inspect the final failing diagnostics and repair attempts.", "This is the most grounded source for manual follow-up.", 100),
          commandSuggestion("inspect", "plan", `node src/cli.mjs plan timeline ${input.source.kind === "replay" ? `replay:${input.source.reference}` : "current"} failures`, "Inspect the stop condition and recent replans.", "This confirms that the loop intentionally stopped instead of spinning.", 95),
        ],
      )];
    case "github_mutation_unavailable":
      return [buildSimpleRecovery(
        "github_mutation_unavailable",
        "github",
        "Recovery depends on filling missing GitHub context such as repository, sha, or token.",
        leading.why,
        "The mutation path is unavailable, so CI/reporting continuity cannot advance yet.",
        [
          commandSuggestion("github", "github", "node src/cli.mjs verifier github result latest failures", "Inspect the exact unavailable reason.", "This distinguishes repository/sha/token gaps without guessing.", 100),
        ],
      )];
    case "github_mutation_blocked":
      return [buildSimpleRecovery(
        "github_mutation_blocked",
        "github",
        "Recovery depends on repository permission or API access rather than verifier state.",
        leading.why,
        "The typed payload exists, but the live mutation path is blocked.",
        [
          commandSuggestion("github", "github", "node src/cli.mjs verifier github result latest failures", "Inspect the mutation block reason and request target.", "This shows whether the block is token, permission, or API related.", 100),
        ],
      )];
    default:
      return [{
        kind: "insufficient_context",
        layer: leading.layer,
        status: "insufficient_context",
        blocking: leading.status === "blocked" || leading.status === "failed",
        summary: "No stronger bounded recovery path is available.",
        reason: leading.why,
        whyNow: "The current typed state is enough to explain the problem, but not enough to prescribe a safer automatic recovery.",
        commands: [],
      }];
  }
}

function appendScopedWhy(
  lines: string[],
  report: AgentDecisionReport,
  profile: AgentDecisionRenderProfile,
): void {
  const scope = report.scope;
  if (scope === "route") {
    lines.push(`Route: mode=${report.routeDecision?.routingMode ?? "none"} taskClass=${report.routeDecision?.taskClass ?? report.taskClassification?.taskClass ?? "none"}`);
    for (const reason of report.routeDecision?.reasons?.slice(0, profile === "failures" ? 4 : 3) ?? []) {
      lines.push(`- ${reason}`);
    }
    return;
  }
  if (scope === "model") {
    lines.push(`Model: provider=${report.modelDecision?.chosenProvider ?? "none"} model=${report.modelDecision?.chosenModel ?? "none"}`);
    lines.push(`Reason: ${report.modelDecision?.reason ?? "No model decision is available."}`);
    if ((report.modelDecision?.degradedFlags?.length ?? 0) > 0) {
      lines.push(`Degraded Flags: ${report.modelDecision?.degradedFlags?.join(", ")}`);
    }
    return;
  }
  if (scope === "tool") {
    lines.push(`Tools: ${(report.toolContext?.observedTools ?? []).slice(0, 6).join(", ") || "none"}`);
    if (report.toolContext?.latestBoundaryDecision) {
      lines.push(`Boundary: status=${report.toolContext.latestBoundaryDecision.status} blocked=${report.toolContext.latestBoundaryDecision.blocked ? "yes" : "no"} approval=${report.toolContext.latestBoundaryDecision.requiresApproval ? "yes" : "no"}`);
      for (const reason of report.toolContext.latestBoundaryDecision.reasons.slice(0, 4)) {
        lines.push(`- ${reason}`);
      }
    }
    if (report.toolContext?.latestApproval) {
      lines.push(`Latest Approval: ${renderApprovalSummary(report.toolContext.latestApproval)}`);
    }
    return;
  }
  if (scope === "plan") {
    lines.push(`Plan: status=${report.planCurrent?.summary.status ?? "none"} current=${report.planCurrent?.currentStep?.title ?? "none"} replanCount=${report.planCurrent?.summary.replanCount ?? 0}`);
    if (report.planCurrent?.latestReplan) {
      lines.push(`Latest Replan: ${report.planCurrent.latestReplan.summary}`);
    }
    if (report.planCurrent?.plan?.stopCondition) {
      lines.push(`Stop Condition: ${report.planCurrent.plan.stopCondition.summary}`);
    }
    return;
  }
  if (scope === "verifier") {
    lines.push(`Verifier: outcome=${report.verifier?.summary.finalOutcome ?? "unknown"} latest=${report.verifier?.summary.latestVerifierStatus ?? "none"} repair=${report.verifier?.summary.latestRepairStatus ?? "none"}`);
    lines.push(`Diagnostics: errors=${report.verifier?.summary.diagnosticErrorCount ?? 0} warnings=${report.verifier?.summary.diagnosticWarningCount ?? 0} info=${report.verifier?.summary.diagnosticInfoCount ?? 0}`);
    if (report.verifier?.latest.repairLoop?.attempts.at(-1)?.convergence?.summary) {
      lines.push(`Latest Repair: ${report.verifier.latest.repairLoop?.attempts.at(-1)?.convergence?.summary ?? ""}`);
    }
    return;
  }

  lines.push(`Task: ${report.taskClassification?.taskClass ?? "none"} confidence=${report.taskClassification?.confidence ?? 0}`);
  lines.push(`Route: ${report.routeDecision?.routingMode ?? "none"}  Model: ${report.modelDecision?.chosenModel ?? "none"}`);
  lines.push(`Plan: ${report.planCurrent?.summary.status ?? "none"}  Verifier: ${report.verifier?.summary.finalOutcome ?? "unknown"}`);
}

function formatDecisionLayers(layers: AgentDecisionLayerSummary[]): string {
  if (layers.length === 0) {
    return "Layers: no degraded layers.";
  }
  return [
    "Layers:",
    ...layers.slice(0, 6).map((entry) => `- ${entry.layer}: ${entry.status} ${entry.summary}`),
  ].join("\n");
}

function formatDecisionBlockingReasons(reasons: AgentDecisionProblem[]): string {
  if (reasons.length === 0) {
    return "Blocking Reasons: none";
  }
  return [
    "Blocking Reasons:",
    ...reasons.slice(0, 5).map((entry) => `- [${entry.layer}] ${entry.summary}`),
  ].join("\n");
}

function formatDecisionNextSteps(steps: AgentDecisionSuggestion[]): string {
  if (steps.length === 0) {
    return "Next Steps: none";
  }
  return [
    "Next Steps:",
    ...steps.slice(0, 4).map((entry) => `- ${entry.command} (${entry.reason})`),
  ].join("\n");
}

function formatDecisionRecovery(recovery: AgentRecoverySuggestion[]): string {
  if (recovery.length === 0) {
    return "Recovery: none";
  }
  return [
    "Recovery:",
    ...recovery.slice(0, 3).map((entry) => `- [${entry.status}] ${entry.summary}`),
  ].join("\n");
}

function buildToolContext(
  resolved: DecisionResolvedState,
  planCurrent: PlanCurrentReport,
): AgentDecisionReport["toolContext"] {
  const replay = resolved.replay;
  const synthesizedBoundary = synthesizeBoundaryDecisionFromPlan(planCurrent);
  if (!replay && !resolved.trace && !resolved.lastChangeSet && !synthesizedBoundary) {
    return null;
  }
  return {
    observedTools: replay
      ? uniqueStrings(replay.toolCalls.map((entry) => toNullableString(entry.tool)).filter((entry): entry is string => Boolean(entry)))
      : resolved.trace?.toolsUsed ?? [],
    latestBoundaryDecision: replay
      ? toBoundaryDecisionSummary(replay.boundaryDecisions.at(-1) ?? null)
      : synthesizedBoundary,
    latestApproval: replay?.approvals.at(-1) ?? null,
    latestChangeSet: resolved.lastChangeSet,
  };
}

function synthesizeBoundaryDecisionFromPlan(
  planCurrent: PlanCurrentReport,
): ExecutionBoundaryDecisionSummary | null {
  const blocker = planCurrent.blockers.find((entry) =>
    entry.kind === "permission_denied"
    || entry.kind === "approval_denied"
    || entry.kind === "boundary_blocked"
    || entry.kind === "tool_preview_failed");
  if (!blocker) {
    return null;
  }
  return {
    subjectType: "tool",
    subjectId: blocker.stepId ?? blocker.eventId ?? "plan-blocker",
    toolName: null,
    toolSource: "planner",
    status: blocker.kind === "tool_preview_failed" ? "degraded" : "blocked",
    blocked: blocker.kind !== "tool_preview_failed",
    degraded: blocker.kind === "tool_preview_failed",
    boundaryMode: "workspace",
    requiresApproval: blocker.kind === "approval_denied",
    reasons: [blocker.summary],
    degradedReasons: blocker.kind === "tool_preview_failed" ? [blocker.summary] : [],
    shellPolicy: null,
    envPolicy: null,
    meta: {
      synthesizedFrom: "plan_blocker",
      blockerKind: blocker.kind,
      blockedAt: blocker.blockedAt,
      recoverable: blocker.recoverable,
    },
  };
}

function deriveLeadingProblemFromLayers(
  layers: AgentDecisionLayerSummary[],
): AgentDecisionProblem | null {
  const blocked = layers.find((entry) => entry.blocking);
  if (!blocked) {
    return null;
  }
  return {
    kind: blocked.layer === "provider" ? "provider_circuit_open" : blocked.layer === "github" ? "github_mutation_blocked" : "state_unavailable",
    layer: blocked.layer,
    status: blocked.status,
    summary: blocked.summary,
    why: blocked.reasons[0] ?? blocked.summary,
    filePaths: [],
    stepId: null,
    eventId: null,
    traceId: null,
  };
}

function deriveVerifierProblem(
  verifier: VerifierInspectReport | null,
  lastChangeSet: ChangeSetSummary | null,
): AgentDecisionProblem | null {
  if (!verifier) {
    return null;
  }
  if (verifier.summary.latestRepairStatus === "exhausted" || verifier.summary.repairExhaustedCount > 0) {
    return {
      kind: "repair_exhausted",
      layer: "verifier",
      status: "failed",
      summary: "Repair budget is exhausted; the loop stopped instead of retrying indefinitely.",
      why: "The verifier path kept failing and the bounded repair loop exhausted its retry budget.",
      filePaths: lastChangeSet?.touchedFiles?.slice(0, 4) ?? [],
      stepId: null,
      eventId: null,
      traceId: verifier.traceId,
    };
  }
  if (verifier.summary.latestVerifierStatus === "failed" || verifier.summary.finalOutcome === "failed") {
    return {
      kind: "verifier_failed",
      layer: "verifier",
      status: "blocked",
      summary: verifier.latest.verifierRun?.summary.summary ?? "Verifier failed on the latest continuity state.",
      why: "Verification is the current gate and the latest run did not pass.",
      filePaths: deriveVerifierFilePaths(verifier, lastChangeSet),
      stepId: null,
      eventId: null,
      traceId: verifier.traceId,
    };
  }
  if (verifier.summary.finalOutcome === "degraded") {
    return {
      kind: "verifier_stop",
      layer: "verifier",
      status: "degraded",
      summary: "Verifier continuity is degraded.",
      why: "The verifier surface recorded degraded or partial availability instead of a clean pass.",
      filePaths: deriveVerifierFilePaths(verifier, lastChangeSet),
      stepId: null,
      eventId: null,
      traceId: verifier.traceId,
    };
  }
  return null;
}

function deriveToolProblem(
  toolContext: AgentDecisionReport["toolContext"],
): AgentDecisionProblem | null {
  const boundary = toolContext?.latestBoundaryDecision;
  if (!boundary) {
    return null;
  }
  const primaryReason = boundary.reasons[0] ?? "The latest tool path was blocked.";
  if (boundary.blocked || boundary.degraded) {
    const kind = boundaryReasonToProblemKind(primaryReason, boundary);
    return {
      kind,
      layer: "tool",
      status: boundary.blocked ? "blocked" : "degraded",
      summary: primaryReason,
      why: boundary.degraded
        ? "Boundary policy degraded or blocked the last tool path."
        : "The last tool path could not proceed under the current permission/approval/boundary state.",
      filePaths: toolContext?.latestChangeSet?.touchedFiles?.slice(0, 4) ?? [],
      stepId: null,
      eventId: null,
      traceId: null,
    };
  }
  return null;
}

function deriveGitHubProblem(
  mutation: VerifierGitHubMutationSelection | null,
): AgentDecisionProblem | null {
  if (!mutation?.available || !mutation.result) {
    return null;
  }
  if (mutation.result.status === "unavailable") {
    return {
      kind: "github_mutation_unavailable",
      layer: "github",
      status: "degraded",
      summary: mutation.result.summary,
      why: mutation.result.reason ?? "GitHub mutation context was unavailable.",
      filePaths: [],
      stepId: null,
      eventId: null,
      traceId: null,
    };
  }
  if (mutation.result.status === "blocked") {
    return {
      kind: "github_mutation_blocked",
      layer: "github",
      status: "blocked",
      summary: mutation.result.summary,
      why: mutation.result.reason ?? "GitHub mutation was blocked.",
      filePaths: [],
      stepId: null,
      eventId: null,
      traceId: null,
    };
  }
  return null;
}

function mapPlanBlockerToProblem(
  blocker: PlanStepBlockedReason,
): AgentDecisionProblem {
  return {
    kind: blocker.kind,
    layer: mapProblemLayer(blocker.kind),
    status: blocker.kind === "repair_exhausted" || blocker.kind === "provider_retry_exhausted" || blocker.kind === "tool_failed"
      ? "failed"
      : blocker.recoverable
        ? "blocked"
        : "failed",
    summary: blocker.summary,
    why: blocker.taxonomy
      ? `The plan recorded a ${blocker.taxonomy} blocker.`
      : "The plan recorded this blocker directly in its typed continuity state.",
    filePaths: [],
    stepId: blocker.stepId ?? null,
    eventId: blocker.eventId ?? null,
    traceId: null,
  };
}

function deriveProblemFromPlanEvent(
  event: PlanTimelineReport["leadingProblemEvent"],
): AgentDecisionProblem | null {
  if (!event?.reasonKind) {
    return null;
  }
  return {
    kind: event.reasonKind,
    layer: mapProblemLayer(event.reasonKind),
    status: event.reasonKind === "repair_exhausted" || event.reasonKind === "provider_retry_exhausted"
      ? "failed"
      : "blocked",
    summary: event.summary,
    why: "This is the most recent relevant failure or replan event in the plan timeline.",
    filePaths: [],
    stepId: event.stepId ?? null,
    eventId: event.id,
    traceId: null,
  };
}

function buildSimpleRecovery(
  kind: AgentRecoveryKind,
  layer: AgentDecisionLayer,
  summary: string,
  reason: string,
  whyNow: string,
  commands: AgentDecisionSuggestion[],
): AgentRecoverySuggestion {
  return {
    kind,
    layer,
    status: "available",
    blocking: true,
    summary,
    reason,
    whyNow,
    commands,
  };
}

function commandSuggestion(
  kind: AgentDecisionSuggestion["kind"],
  layer: AgentDecisionLayer,
  command: string,
  reason: string,
  whyNow: string,
  priority: number,
): AgentDecisionSuggestion {
  return { kind, layer, command, reason, whyNow, priority };
}

function normalizeDecisionReference(reference: string | null | undefined): string {
  const normalized = `${reference ?? "current"}`.trim() || "current";
  if (normalized === "current" || normalized === "trace" || normalized === "latest" || normalized.startsWith("replay:")) {
    return normalized;
  }
  return `replay:${normalized}`;
}

function mapProblemLayer(kind: AgentDecisionProblemKind): AgentDecisionLayer {
  switch (kind) {
    case "permission_denied":
    case "approval_denied":
    case "boundary_blocked":
    case "tool_failed":
    case "tool_preview_failed":
      return "tool";
    case "provider_retry_exhausted":
    case "provider_circuit_open":
      return "provider";
    case "verifier_failed":
    case "repair_exhausted":
      return "verifier";
    case "github_mutation_blocked":
    case "github_mutation_unavailable":
      return "github";
    default:
      return "plan";
  }
}

function mapPlanStatusToDecisionStatus(status: PlanCurrentReport["summary"]["status"]): AgentDecisionStatus {
  if (status === "failed") {
    return "failed";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "degraded") {
    return "degraded";
  }
  return "ok";
}

function mapGitHubMutationStatus(status: NonNullable<VerifierGitHubMutationSelection["result"]>["status"]): AgentDecisionStatus {
  return status === "success"
    ? "ok"
    : status === "blocked"
      ? "blocked"
      : status === "failed"
        ? "failed"
        : "degraded";
}

function boundaryReasonToProblemKind(
  reason: string,
  boundary: ExecutionBoundaryDecisionSummary,
): AgentDecisionProblemKind {
  const normalized = reason.toLowerCase();
  if (normalized.includes("approval")) {
    return "approval_denied";
  }
  if (normalized.includes("outside the workspace") || normalized.includes("permission") || normalized.includes("read-only")) {
    return "permission_denied";
  }
  if (boundary.status === "blocked" || normalized.includes("hook")) {
    return "boundary_blocked";
  }
  return "tool_failed";
}

function deriveVerifierFilePaths(
  verifier: VerifierInspectReport,
  lastChangeSet: ChangeSetSummary | null,
): string[] {
  const latestRepair = verifier.latest.repairLoop?.attempts.at(-1)?.directive?.filePaths ?? [];
  if (latestRepair.length > 0) {
    return latestRepair.slice(0, 4);
  }
  return lastChangeSet?.touchedFiles?.slice(0, 4) ?? [];
}

function renderApprovalSummary(value: Record<string, unknown>): string {
  const approved = value.approved === true
    ? "approved"
    : value.approved === false
      ? "denied"
      : "unknown";
  const tool = toNullableString(value.tool) ?? "tool";
  return `${tool} ${approved}`;
}

function renderDecisionSource(source: AgentDecisionResolvedReference): string {
  return source.kind === "replay"
    ? `replay:${source.reference}`
    : source.kind;
}

function compareDecisionStatus(left: AgentDecisionStatus, right: AgentDecisionStatus): number {
  return decisionStatusWeight(left) - decisionStatusWeight(right);
}

function decisionStatusWeight(value: AgentDecisionStatus): number {
  switch (value) {
    case "failed":
      return 5;
    case "blocked":
      return 4;
    case "degraded":
      return 3;
    case "ok":
      return 2;
    default:
      return 1;
  }
}

function dedupeDecisionSuggestions(values: AgentDecisionSuggestion[]): AgentDecisionSuggestion[] {
  const seen = new Set<string>();
  return values
    .sort((left, right) => right.priority - left.priority || left.command.localeCompare(right.command))
    .filter((entry) => {
      if (seen.has(entry.command)) {
        return false;
      }
      seen.add(entry.command);
      return true;
    });
}

function normalizeGitHubContext(
  value: VerifierGitHubMutationSelection | null,
): AgentDecisionReport["githubMutation"] {
  if (!value) {
    return null;
  }
  return {
    available: value.available,
    reason: value.reason,
    reference: value.reference,
    result: value.result,
  };
}

async function loadReplayIfAvailable(
  target: AgentDecisionInspectTarget,
  sessionId: string | null,
): Promise<SessionReplay | null> {
  if (!sessionId) {
    return null;
  }
  try {
    return await target.sessionStore.buildReplay(sessionId);
  } catch {
    return null;
  }
}

async function loadLatestGitHubMutation(
  projectStateDir: string,
): Promise<VerifierGitHubMutationSelection | null> {
  try {
    return await new VerifierGitHubMutationStore(projectStateDir).loadResult("latest");
  } catch {
    return null;
  }
}

function toBoundaryDecisionSummary(
  value: Record<string, unknown> | null,
): ExecutionBoundaryDecisionSummary | null {
  if (!value) {
    return null;
  }
  const shellPolicy = isRecord(value.shellPolicy)
    ? {
        renderedCommand: toNullableString(value.shellPolicy.renderedCommand) ?? "",
        classification: normalizeShellCommandClassification(value.shellPolicy.classification),
        ptyRequested: value.shellPolicy.ptyRequested === true,
      }
    : null;
  const envMode: "passthrough" | "allowlist" = toNullableString(isRecord(value.envPolicy) ? value.envPolicy.mode : null) === "passthrough"
    ? "passthrough"
    : "allowlist";
  const envPolicy = isRecord(value.envPolicy)
    ? {
        mode: envMode,
        passedKeys: toStringArray(value.envPolicy.passedKeys),
        droppedKeys: toStringArray(value.envPolicy.droppedKeys),
        redactedKeys: toStringArray(value.envPolicy.redactedKeys),
      }
    : null;
  return {
    subjectType: toNullableString(value.subjectType) ?? "tool",
    subjectId: toNullableString(value.subjectId) ?? "unknown",
    toolName: toNullableString(value.toolName),
    toolSource: toNullableString(value.toolSource) ?? "local",
    status: toNullableString(value.status) ?? "unknown",
    blocked: value.blocked === true,
    degraded: Array.isArray(value.degradedReasons) && value.degradedReasons.length > 0,
    boundaryMode: toNullableString(value.boundaryMode) === "off"
      ? "off"
      : toNullableString(value.boundaryMode) === "strict-policy"
        ? "strict-policy"
        : "workspace",
    requiresApproval: value.requiresApproval === true,
    reasons: toStringArray(value.reasons),
    degradedReasons: toStringArray(value.degradedReasons),
    shellPolicy,
    envPolicy,
    meta: isRecord(value.meta) ? cloneTyped(value.meta) : null,
  };
}

function asTaskClassification(value: unknown): TaskClassification | null {
  return isRecord(value) && typeof value.taskClass === "string"
    ? structuredClone(value) as TaskClassification
    : null;
}

function asRouteDecision(value: unknown): RouteDecision | null {
  return isRecord(value) && typeof value.taskClass === "string" && Array.isArray(value.selectedCapabilities)
    ? structuredClone(value) as RouteDecision
    : null;
}

function asModelDecision(value: unknown): AgentDecisionReport["modelDecision"] | null {
  if (!isRecord(value) || (!("chosenModel" in value) && !("chosenProvider" in value))) {
    return null;
  }
  return {
    chosenProvider: toNullableString(value.chosenProvider),
    chosenModel: toNullableString(value.chosenModel),
    fallbackModels: toStringArray(value.fallbackModels),
    fallbackChain: Array.isArray(value.fallbackChain) ? cloneTyped(value.fallbackChain) : [],
    reason: toNullableString(value.reason) ?? "No model reason is available.",
    estimatedContextNeed: toNullableString(value.estimatedContextNeed) ?? undefined,
    latencyTarget: toNullableString(value.latencyTarget) ?? undefined,
    costSensitivity: toNullableString(value.costSensitivity) ?? undefined,
    candidates: Array.isArray(value.candidates) ? cloneTyped(value.candidates) : undefined,
    healthAware: value.healthAware === true,
    degradedFlags: Array.isArray(value.degradedFlags) ? toStringArray(value.degradedFlags) : undefined,
    runtimePressure: asRuntimePressure(value.runtimePressure) ?? undefined,
    selectedModel: toNullableString(value.selectedModel) ?? undefined,
    attemptedModels: Array.isArray(value.attemptedModels) ? toStringArray(value.attemptedModels) : undefined,
    fallbackChainUsed: value.fallbackChainUsed === true ? true : value.fallbackChainUsed === false ? false : undefined,
  };
}

function asExecutionPlan(value: unknown): ExecutionPlan | null {
  return isRecord(value) && Array.isArray(value.steps)
    ? structuredClone(value) as ExecutionPlan
    : null;
}

function asTraceSummary(value: unknown): TraceSummary | null {
  if (!isRecord(value) || typeof value.traceId !== "string") {
    return null;
  }
  return {
    traceId: value.traceId,
    success: value.success === true,
    stopped: value.stopped === true,
    steps: typeof value.steps === "number" ? value.steps : 0,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : 0,
    toolsUsed: toStringArray(value.toolsUsed),
    approvalsAsked: typeof value.approvalsAsked === "number" ? value.approvalsAsked : 0,
    approvalsApproved: typeof value.approvalsApproved === "number" ? value.approvalsApproved : 0,
    approvalsDenied: typeof value.approvalsDenied === "number" ? value.approvalsDenied : 0,
    modelCalls: typeof value.modelCalls === "number" ? value.modelCalls : undefined,
    promptTokens: typeof value.promptTokens === "number" ? value.promptTokens : undefined,
    completionTokens: typeof value.completionTokens === "number" ? value.completionTokens : undefined,
    totalTokens: typeof value.totalTokens === "number" ? value.totalTokens : undefined,
    providerAttempts: typeof value.providerAttempts === "number" ? value.providerAttempts : undefined,
    providerRetries: typeof value.providerRetries === "number" ? value.providerRetries : undefined,
    providerFallbacks: typeof value.providerFallbacks === "number" ? value.providerFallbacks : undefined,
    modelFallbacks: typeof value.modelFallbacks === "number" ? value.modelFallbacks : undefined,
    providerMeta: isRecord(value.providerMeta) ? cloneTyped(value.providerMeta) : null,
    shellJobs: Array.isArray(value.shellJobs) ? cloneTyped(value.shellJobs) : undefined,
    skillInfluence: value.skillInfluence ?? undefined,
    policySources: value.policySources ?? undefined,
    taskClassification: asTaskClassification(value.taskClassification),
    routeDecision: asRouteDecision(value.routeDecision),
    modelDecision: asModelDecision(value.modelDecision),
    executionPlan: asExecutionPlan(value.executionPlan),
    mcpCalls: Array.isArray(value.mcpCalls) ? cloneTyped(value.mcpCalls) : undefined,
    webRequests: typeof value.webRequests === "number" ? value.webRequests : undefined,
    webRetries: typeof value.webRetries === "number" ? value.webRetries : undefined,
    webCacheHits: typeof value.webCacheHits === "number" ? value.webCacheHits : undefined,
    sourceIds: Array.isArray(value.sourceIds) ? toStringArray(value.sourceIds) : undefined,
    filesChanged: Array.isArray(value.filesChanged) ? toStringArray(value.filesChanged) : undefined,
    durations: isRecord(value.durations) ? cloneTyped(value.durations) : undefined,
    verifier: asVerifierRunSummary(value.verifier) ?? undefined,
    repair: asRepairLoopSummary(value.repair) ?? undefined,
    runtimeScorecard: asRuntimeHealthScorecard(value.runtimeScorecard) ?? undefined,
    errorTaxonomy: toNullableString(value.errorTaxonomy) ?? undefined,
    finalSummary: toNullableString(value.finalSummary) ?? undefined,
  };
}

function asChangeSetSummary(value: unknown): ChangeSetSummary | null {
  if (!isRecord(value) || !Array.isArray(value.touchedFiles) || typeof value.id !== "string" || typeof value.toolName !== "string" || !isRecord(value.operations) || !Array.isArray(value.files)) {
    return null;
  }
  return {
    id: value.id,
    createdAt: toNullableString(value.createdAt) ?? undefined,
    toolName: value.toolName,
    touchedFiles: toStringArray(value.touchedFiles),
    operations: toNumberRecord(value.operations),
    diffTruncated: value.diffTruncated === true ? true : value.diffTruncated === false ? false : undefined,
    rollbackAvailable: value.rollbackAvailable === true ? true : value.rollbackAvailable === false ? false : undefined,
    checkpointId: toNullableString(value.checkpointId),
    risk: asRiskAssessment(value.risk),
    impact: null,
    files: Array.isArray(value.files) ? cloneTyped(value.files) : [],
    diff: toNullableString(value.diff) ?? undefined,
  };
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values
    .map((entry) => `${entry ?? ""}`.trim())
    .filter(Boolean);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(compactStrings(values))];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => `${entry ?? ""}`.trim()).filter(Boolean)
    : [];
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function cloneTyped<T>(value: T): T {
  return value == null ? value : structuredClone(value);
}

function resolveRuntimeScorecard(runtimeHealth: DecisionRuntimeHealthLike): RuntimeHealthScorecard | null {
  if (typeof runtimeHealth.getScorecard === "function") {
    return cloneTyped(runtimeHealth.getScorecard());
  }
  if (typeof runtimeHealth.getOverview === "function") {
    const overview = runtimeHealth.getOverview();
    if (isRecord(overview) && isRecord(overview.scorecard)) {
      return asRuntimeHealthScorecard(overview.scorecard);
    }
  }
  return null;
}

function asRuntimePressure(value: unknown): NonNullable<NonNullable<AgentDecisionReport["modelDecision"]>["runtimePressure"]> | null {
  if (!isRecord(value) || typeof value.mode !== "string" || typeof value.avgHealthScore !== "number" || typeof value.retryPressure !== "number" || !Array.isArray(value.degradedFlags)) {
    return null;
  }
  return {
    mode: value.mode,
    avgHealthScore: value.avgHealthScore,
    retryPressure: value.retryPressure,
    degradedFlags: toStringArray(value.degradedFlags),
    taskClass: toNullableString(value.taskClass) ?? undefined,
  };
}

function asVerifierRunSummary(value: unknown): TraceSummary["verifier"] | null {
  if (
    !isRecord(value)
    || typeof value.status !== "string"
    || typeof value.passed !== "boolean"
    || typeof value.totalChecks !== "number"
    || typeof value.passedChecks !== "number"
    || typeof value.failedChecks !== "number"
    || typeof value.skippedChecks !== "number"
    || typeof value.findings !== "number"
    || !Array.isArray(value.failureCategories)
    || typeof value.summary !== "string"
    || typeof value.durationMs !== "number"
  ) {
    return null;
  }
  return {
    status: normalizeVerifierStatus(value.status),
    passed: value.passed,
    totalChecks: value.totalChecks,
    passedChecks: value.passedChecks,
    failedChecks: value.failedChecks,
    skippedChecks: value.skippedChecks,
    unavailableChecks: typeof value.unavailableChecks === "number" ? value.unavailableChecks : undefined,
    findings: value.findings,
    failureCategories: toVerifierFailureCategoryArray(value.failureCategories),
    diagnosticErrorCount: typeof value.diagnosticErrorCount === "number" ? value.diagnosticErrorCount : undefined,
    diagnosticWarningCount: typeof value.diagnosticWarningCount === "number" ? value.diagnosticWarningCount : undefined,
    diagnosticInfoCount: typeof value.diagnosticInfoCount === "number" ? value.diagnosticInfoCount : undefined,
    diagnosticProviderAvailable: typeof value.diagnosticProviderAvailable === "boolean" ? value.diagnosticProviderAvailable : undefined,
    diagnosticEngine: normalizeDiagnosticEngine(value.diagnosticEngine),
    diagnosticFallbackUsed: typeof value.diagnosticFallbackUsed === "boolean" ? value.diagnosticFallbackUsed : undefined,
    diagnosticFallbackReason: toNullableString(value.diagnosticFallbackReason) ?? undefined,
    diagnosticTransportAvailable: typeof value.diagnosticTransportAvailable === "boolean" ? value.diagnosticTransportAvailable : undefined,
    fixHintAvailable: typeof value.fixHintAvailable === "boolean" ? value.fixHintAvailable : undefined,
    fixHintSource: normalizeFixHintSource(value.fixHintSource),
    fixHintCount: typeof value.fixHintCount === "number" ? value.fixHintCount : undefined,
    recommendedFixHintCount: typeof value.recommendedFixHintCount === "number" ? value.recommendedFixHintCount : undefined,
    fixHintFileCount: typeof value.fixHintFileCount === "number" ? value.fixHintFileCount : undefined,
    fixHintReason: toNullableString(value.fixHintReason) ?? undefined,
    codeActionAvailable: typeof value.codeActionAvailable === "boolean" ? value.codeActionAvailable : undefined,
    codeActionSource: normalizeCodeActionSource(value.codeActionSource),
    codeActionCandidateCount: typeof value.codeActionCandidateCount === "number" ? value.codeActionCandidateCount : undefined,
    codeActionAllowlistedCount: typeof value.codeActionAllowlistedCount === "number" ? value.codeActionAllowlistedCount : undefined,
    codeActionBlockedCount: typeof value.codeActionBlockedCount === "number" ? value.codeActionBlockedCount : undefined,
    codeActionReason: toNullableString(value.codeActionReason) ?? undefined,
    projectContextAvailable: typeof value.projectContextAvailable === "boolean" ? value.projectContextAvailable : undefined,
    projectContextSource: normalizeProjectContextSource(value.projectContextSource),
    projectContextCount: typeof value.projectContextCount === "number" ? value.projectContextCount : undefined,
    projectContextDiagnosticCoverageCount: typeof value.projectContextDiagnosticCoverageCount === "number" ? value.projectContextDiagnosticCoverageCount : undefined,
    projectContextQuickInfoCount: typeof value.projectContextQuickInfoCount === "number" ? value.projectContextQuickInfoCount : undefined,
    projectContextDefinitionCount: typeof value.projectContextDefinitionCount === "number" ? value.projectContextDefinitionCount : undefined,
    projectContextImplementationCount: typeof value.projectContextImplementationCount === "number" ? value.projectContextImplementationCount : undefined,
    projectContextReferenceCount: typeof value.projectContextReferenceCount === "number" ? value.projectContextReferenceCount : undefined,
    projectContextDocumentSymbolCount: typeof value.projectContextDocumentSymbolCount === "number" ? value.projectContextDocumentSymbolCount : undefined,
    projectContextFileCount: typeof value.projectContextFileCount === "number" ? value.projectContextFileCount : undefined,
    projectContextReason: toNullableString(value.projectContextReason) ?? undefined,
    summary: value.summary,
    durationMs: value.durationMs,
  };
}

function asRepairLoopSummary(value: unknown): TraceSummary["repair"] | null {
  if (
    !isRecord(value)
    || typeof value.status !== "string"
    || typeof value.attemptsUsed !== "number"
    || typeof value.maxAttempts !== "number"
    || typeof value.attemptsRemaining !== "number"
    || typeof value.summary !== "string"
  ) {
    return null;
  }
  return {
    status: normalizeRepairStatus(value.status),
    attemptsUsed: value.attemptsUsed,
    maxAttempts: value.maxAttempts,
    attemptsRemaining: value.attemptsRemaining,
    lastDecision: normalizeRepairDecision(value.lastDecision),
    stopReason: normalizeRepairStopReason(value.stopReason),
    triggeredByVerifierStartedAt: toNullableString(value.triggeredByVerifierStartedAt),
    latestProgress: normalizeRepairProgressState(value.latestProgress),
    progressTrend: normalizeRepairProgressTrend(value.progressTrend),
    resolvedAttemptCount: typeof value.resolvedAttemptCount === "number" ? value.resolvedAttemptCount : 0,
    improvedAttemptCount: typeof value.improvedAttemptCount === "number" ? value.improvedAttemptCount : 0,
    unchangedAttemptCount: typeof value.unchangedAttemptCount === "number" ? value.unchangedAttemptCount : 0,
    regressedAttemptCount: typeof value.regressedAttemptCount === "number" ? value.regressedAttemptCount : 0,
    notApplicableAttemptCount: typeof value.notApplicableAttemptCount === "number" ? value.notApplicableAttemptCount : 0,
    resolvedDiagnosticCount: typeof value.resolvedDiagnosticCount === "number" ? value.resolvedDiagnosticCount : 0,
    persistedDiagnosticCount: typeof value.persistedDiagnosticCount === "number" ? value.persistedDiagnosticCount : 0,
    introducedDiagnosticCount: typeof value.introducedDiagnosticCount === "number" ? value.introducedDiagnosticCount : 0,
    codeActionAppliedCount: typeof value.codeActionAppliedCount === "number" ? value.codeActionAppliedCount : 0,
    codeActionBlockedCount: typeof value.codeActionBlockedCount === "number" ? value.codeActionBlockedCount : 0,
    latestCodeActionStatus: normalizeCodeActionApplyStatus(value.latestCodeActionStatus),
    summary: value.summary,
  };
}

function asRuntimeHealthScorecard(value: unknown): RuntimeHealthScorecard | null {
  if (!isRecord(value) || !Array.isArray(value.degradedFlags) || !isRecord(value.provider)) {
    return null;
  }
  return cloneTyped(value) as RuntimeHealthScorecard;
}

function asRiskAssessment(value: unknown): ChangeSetSummary["risk"] {
  if (!isRecord(value) || typeof value.score !== "number" || typeof value.level !== "string" || !Array.isArray(value.reasons)) {
    return null;
  }
  return {
    score: value.score,
    level: value.level === "low" || value.level === "medium" || value.level === "high" || value.level === "critical"
      ? value.level
      : "medium",
    reasons: toStringArray(value.reasons),
  };
}

function toNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      result[key] = entry;
    }
  }
  return result;
}

function normalizeVerifierStatus(value: unknown): "passed" | "failed" | "skipped" | "unavailable" {
  return value === "passed" || value === "failed" || value === "skipped"
    ? value
    : "unavailable";
}

function toVerifierFailureCategoryArray(value: unknown): Array<
  "syntax_error" | "diagnostic_error" | "config_error" | "command_failed" | "unsupported_file" | "unavailable" | "timeout" | "internal_error"
> {
  return Array.isArray(value)
    ? value.filter((entry) =>
      entry === "syntax_error"
      || entry === "diagnostic_error"
      || entry === "config_error"
      || entry === "command_failed"
      || entry === "unsupported_file"
      || entry === "unavailable"
      || entry === "timeout"
      || entry === "internal_error")
    : [];
}

function normalizeDiagnosticEngine(value: unknown): "tsserver" | "compiler_api" | "none" | undefined {
  return value === "tsserver" || value === "compiler_api" || value === "none"
    ? value
    : undefined;
}

function normalizeFixHintSource(value: unknown): "tsserver" | "unavailable" | "none" | undefined {
  return value === "tsserver" || value === "unavailable" || value === "none"
    ? value
    : undefined;
}

function normalizeCodeActionSource(value: unknown): "tsserver" | "unavailable" | "none" | undefined {
  return value === "tsserver" || value === "unavailable" || value === "none"
    ? value
    : undefined;
}

function normalizeProjectContextSource(value: unknown): "tsserver" | "unavailable" | "none" | undefined {
  return value === "tsserver" || value === "unavailable" || value === "none"
    ? value
    : undefined;
}

function normalizeRepairStatus(value: unknown): "retrying" | "succeeded" | "failed" | "stopped" | "exhausted" {
  return value === "retrying" || value === "succeeded" || value === "failed" || value === "stopped"
    ? value
    : "exhausted";
}

function normalizeRepairDecision(value: unknown): "retry" | "stop" | null {
  return value === "retry" || value === "stop"
    ? value
    : null;
}

function normalizeRepairStopReason(value: unknown): "no_actionable_findings" | "attempts_exhausted" | "max_steps_reached" | "turn_interrupted" | null {
  return value === "no_actionable_findings"
    || value === "attempts_exhausted"
    || value === "max_steps_reached"
    || value === "turn_interrupted"
    ? value
    : null;
}

function normalizeRepairProgressState(value: unknown): "resolved" | "improved" | "unchanged" | "regressed" | "not_applicable" | "none" {
  return value === "resolved"
    || value === "improved"
    || value === "unchanged"
    || value === "regressed"
    || value === "not_applicable"
    ? value
    : "none";
}

function normalizeRepairProgressTrend(value: unknown): "resolved" | "improved" | "unchanged" | "regressed" | "not_applicable" | "mixed" | "none" {
  return value === "resolved"
    || value === "improved"
    || value === "unchanged"
    || value === "regressed"
    || value === "not_applicable"
    || value === "mixed"
    ? value
    : "none";
}

function normalizeCodeActionApplyStatus(value: unknown): "applied" | "blocked" | "failed" | "unavailable" | "none" {
  return value === "applied" || value === "blocked" || value === "failed" || value === "unavailable"
    ? value
    : "none";
}

function normalizeShellCommandClassification(value: unknown): ShellCommandClassification {
  if (isRecord(value)) {
    return {
      summary: toNullableString(value.summary) ?? "",
      spawnMode: toNullableString(value.spawnMode) ?? "shell",
      blockedMatches: Array.isArray(value.blockedMatches) ? cloneTyped(value.blockedMatches) : [],
      approvalMatches: Array.isArray(value.approvalMatches) ? cloneTyped(value.approvalMatches) : [],
      networkMatches: toStringArray(value.networkMatches),
      destructive: value.destructive === true,
      highRisk: value.highRisk === true,
      networkAccess: value.networkAccess === true,
    };
  }
  return {
    summary: "",
    spawnMode: "shell",
    blockedMatches: [],
    approvalMatches: [],
    networkMatches: [],
    destructive: false,
    highRisk: false,
    networkAccess: false,
  };
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
