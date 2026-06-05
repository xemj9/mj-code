import { getAgentBrandProfile } from "./agent-branding.mjs";

import type {
  AgentInteractionHistoryScope,
  ExecutionPlan,
  InteractiveSelectionPreview,
  InteractiveSessionPickerEntry,
  InteractiveSessionPickerMode,
  InteractiveSessionPickerReport,
  InteractiveSessionPickerSection,
  RollbackCheckpointListEntry,
  SessionBrowserRenderProfile,
  SessionBrowserReport,
  SessionBrowserResolvedReference,
  SessionCommandSuggestion,
  SessionContinuityStatus,
  SessionContinuitySummary,
  SessionLineageBrowserSummary,
  SessionLineageRelationKind,
  SessionReplay,
  SessionReplayBrowserSummary,
  SessionResumeRecommendation,
  SessionResumeRecommendationReasonKind,
  SessionResumeRecommendationReport,
  SessionResumeRecommendationStatus,
  SessionIndexEntry,
  TraceSummary,
  VerifierRunRecord,
  RepairLoopRecord,
} from "../types/contracts.js";

interface SessionBrowserSnapshotLike {
  state?: {
    lastExecutionPlan?: ExecutionPlan | null;
    lastTrace?: TraceSummary | null;
    lastTaskClassification?: unknown;
    lastRouteDecision?: unknown;
    lastModelDecision?: unknown;
    [key: string]: unknown;
  } | null;
}

export interface SessionBrowserTarget {
  sessionId: string | null;
  lastExecutionPlan: ExecutionPlan | null;
  lastTrace: TraceSummary | null;
  lastTaskClassification: unknown;
  lastRouteDecision: unknown;
  lastModelDecision: unknown;
  lastVerifierRun: VerifierRunRecord | null;
  lastRepairLoop: RepairLoopRecord | null;
  sessionStore: {
    listSessions(limit?: number): Promise<SessionIndexEntry[]>;
    buildReplay(reference: string): Promise<SessionReplay>;
  };
  executionJournal: {
    loadLatestSnapshot(sessionId: string): Promise<SessionBrowserSnapshotLike | null>;
  };
  rollbackStore: {
    listCheckpoints(limit?: number): Promise<RollbackCheckpointListEntry[]>;
  };
}

interface SessionBrowserContext {
  entry: SessionIndexEntry;
  replay: SessionReplay | null;
  snapshot: SessionBrowserSnapshotLike | null;
  plan: ExecutionPlan | null;
  trace: TraceSummary | null;
  decisionAvailable: boolean;
  verifierStatus: string | null;
  repairStatus: string | null;
}

const SESSION_LIST_LIMIT = 24;
const SESSION_RENDER_LIMIT = 6;
const SESSION_CARD_LIMIT = 3;
const LINEAGE_RENDER_LIMIT = 4;
const CHANGE_RENDER_LIMIT = 5;
const STALE_DAYS = 7;
type RankedSessionRole = "focus" | "continue" | "current" | "nearby" | "stale" | "anchor";

export async function buildSessionBrowserReport(
  target: SessionBrowserTarget,
  input: {
    scope?: AgentInteractionHistoryScope;
    reference?: string;
  } = {},
): Promise<SessionBrowserReport> {
  const scope = input.scope ?? "all";
  const sessions = await target.sessionStore.listSessions(SESSION_LIST_LIMIT);
  const contextMap = await buildSessionContextMap(target, sessions);
  const resolvedReference = await resolveSessionBrowserReference(target, sessions, input.reference ?? "current");
  const focusContext = resolvedReference.resolvedSessionId
    ? contextMap.get(resolvedReference.resolvedSessionId) ?? null
    : null;

  const sessionSummaries = buildSessionSummaryList(
    sessions,
    contextMap,
    target.sessionId,
    resolvedReference.resolvedSessionId,
  );
  const lineage = buildLineageSummary(focusContext, contextMap, target.sessionId);
  const replay = buildReplaySummary(focusContext, target.sessionId);
  const changes = scope === "all" || scope === "changes"
    ? (await target.rollbackStore.listCheckpoints(CHANGE_RENDER_LIMIT)).slice(0, CHANGE_RENDER_LIMIT)
    : [];
  const scopedSessions = selectScopedSessions(scope, sessionSummaries, lineage, focusContext?.entry.id ?? null);
  const recommendedResumeSessionId = pickRecommendedResumeSessionId(sessionSummaries, target.sessionId);
  const suggestedCommands = rankSuggestions(collectBrowserSuggestions({
    scope,
    resolvedReference,
    focus: focusContext ? buildContinuitySummary(focusContext, contextMap, target.sessionId, resolvedReference.resolvedSessionId) : null,
    lineage,
    replay,
    recommendedResumeSessionId,
  })).slice(0, 4);

  return {
    brand: getAgentBrandProfile(),
    createdAt: new Date().toISOString(),
    scope,
    reference: resolvedReference,
    available: true,
    changes,
    sessions: scopedSessions,
    lineage,
    replay,
    summary: {
      sessionCount: sessionSummaries.length,
      changeCount: changes.length,
      activeSessionId: target.sessionId,
      recommendedResumeSessionId,
      staleSessionCount: sessionSummaries.filter((entry) => entry.continuityStatus === "stale").length,
      planAvailableCount: sessionSummaries.filter((entry) => entry.availability.planAvailable).length,
      verifierAvailableCount: sessionSummaries.filter((entry) => entry.availability.verifierAvailable).length,
      decisionAvailableCount: sessionSummaries.filter((entry) => entry.availability.decisionAvailable).length,
    },
    suggestedCommands,
  };
}

export async function buildSessionResumeRecommendationReport(
  target: SessionBrowserTarget,
  reference: string = "current",
): Promise<SessionResumeRecommendationReport> {
  const sessions = await target.sessionStore.listSessions(SESSION_LIST_LIMIT);
  const contextMap = await buildSessionContextMap(target, sessions);
  const resolvedReference = await resolveSessionBrowserReference(target, sessions, reference);
  const anchorContext = resolvedReference.resolvedSessionId
    ? contextMap.get(resolvedReference.resolvedSessionId) ?? null
    : null;
  const anchorSummary = anchorContext
    ? buildContinuitySummary(anchorContext, contextMap, target.sessionId, resolvedReference.resolvedSessionId)
    : null;
  const allSummaries = buildSessionSummaryList(
    sessions,
    contextMap,
    target.sessionId,
    resolvedReference.resolvedSessionId,
  );
  const relatedSessions = allSummaries
    .filter((entry) => entry.sessionId !== anchorSummary?.sessionId)
    .filter((entry) => entry.relationToReference !== "unrelated" && entry.relationToReference !== "none")
    .slice(0, SESSION_RENDER_LIMIT);
  const recommendation = buildResumeRecommendation(
    anchorSummary,
    allSummaries,
    target.sessionId,
    resolvedReference,
  );

  return {
    brand: getAgentBrandProfile(),
    createdAt: new Date().toISOString(),
    reference: resolvedReference,
    available: recommendation.status !== "unavailable",
    anchorSession: anchorSummary,
    relatedSessions,
    recommendation,
    suggestedCommands: recommendation.suggestedCommands.slice(0, 4),
  };
}

export function buildInteractiveSessionPickerReport(input: {
  mode: InteractiveSessionPickerMode;
  query?: string | null;
  browserReport: SessionBrowserReport;
  recommendationReport?: SessionResumeRecommendationReport | null;
}): InteractiveSessionPickerReport {
  const query = normalizePickerQuery(input.query);
  const sections = buildPickerSections(input.mode, input.browserReport, input.recommendationReport ?? null)
    .map((section) => ({
      title: section.title,
      entries: filterPickerEntries(section.entries, query),
    }))
    .filter((section) => section.entries.length > 0);
  const selectedCommand = sections[0]?.entries[0]?.command ?? null;
  const selectedPreview = resolvePickerPreview(sections, selectedCommand)
    ?? buildUnavailablePickerPreview(input.mode, query);

  return {
    mode: input.mode,
    step: isActionPickerMode(input.mode) ? "action" : "target",
    title: renderPickerTitle(input.mode),
    subtitle: renderPickerSubtitle(input.mode, input.browserReport, input.recommendationReport ?? null, sections),
    query: query || null,
    brand: getAgentBrandProfile(),
    anchorSessionId: resolvePickerAnchorSessionId(input.mode, input.browserReport),
    anchorCommand: resolvePickerAnchorCommand(input.mode),
    sections,
    totalMatches: sections.reduce((count, section) => count + section.entries.length, 0),
    selectedCommand,
    selectedPreview,
    fallbackMode: "tty_overlay",
    footerHints: [
      isActionPickerMode(input.mode)
        ? "Use ↑↓ to choose the next action, Enter to inject it, Esc to go back or close."
        : "Use ↑↓ to choose a target, Enter to continue into actions, Esc to close.",
      "Keep typing after the slash command to narrow by session id, model, or continuity.",
    ],
  };
}

export function renderSessionBrowserReport(
  report: SessionBrowserReport,
  profile: SessionBrowserRenderProfile = "summary",
): string {
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }

  if (!report.available) {
    return "Session browser unavailable.";
  }

  const focusSessionId = report.lineage?.focus?.sessionId
    ?? report.replay?.sessionId
    ?? report.reference.resolvedSessionId
    ?? report.summary.activeSessionId;
  const renderSuggestions = report.suggestedCommands.length > 0
    ? report.suggestedCommands
    : buildEmptyBrowserSuggestions(report.scope);
  const primary = renderSuggestions[0] ?? null;
  const lines = [
    `History · ${report.scope}`,
    buildBrowserNowLine(report, focusSessionId),
    buildBrowserContinueLine(report, focusSessionId, primary?.command ?? null),
  ];

  if (report.scope === "lineage") {
    appendLineageSummary(lines, report.lineage);
  } else if (report.scope === "replay") {
    appendReplaySummary(lines, report.replay);
  } else {
    appendSessionList(
      lines,
      report.sessions,
      profile,
      focusSessionId,
      report.summary.recommendedResumeSessionId,
    );
    if ((report.scope === "all" || report.scope === "changes") && report.changes.length > 0) {
      lines.push("Changes:");
      for (const change of report.changes.slice(0, CHANGE_RENDER_LIMIT)) {
        lines.push(`- ${change.id} status=${change.status} tool=${change.toolName} files=${change.touchedFiles.length}`);
      }
    }
  }

  appendSuggestionPlan(lines, renderSuggestions, profile);
  return lines.join("\n");
}

export function renderSessionResumeRecommendationReport(
  report: SessionResumeRecommendationReport,
  profile: SessionBrowserRenderProfile = "summary",
): string {
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  const primary = report.suggestedCommands[0] ?? null;
  const lines = [
    "Resume",
    `Anchor: ${renderReference(report.reference)} · available=${report.available ? "yes" : "no"}`,
    `Guide: target=${renderCompactSessionRef(report.recommendation.recommendedSessionId ?? "none")} · status=${report.recommendation.status} · next=${renderDecisionActionSummary(primary?.command ?? null)}`,
    `Summary: ${report.recommendation.summary}`,
  ];
  if (report.recommendation.reasonKind !== "no_sessions") {
    lines.push(`Why: ${renderRecommendationWhyLine(report)}`);
  }
  if (report.anchorSession) {
    lines.push(`Anchor: ${renderSessionCard(report.anchorSession, "anchor")}`);
  }
  if (report.recommendation.blockers.length > 0) {
    lines.push("Risk:");
    for (const blocker of report.recommendation.blockers.slice(0, 3)) {
      lines.push(`- ${blocker}`);
    }
  }
  if (profile !== "failures" && report.relatedSessions.length > 0) {
    lines.push("Nearby:");
    for (const session of report.relatedSessions.slice(0, SESSION_CARD_LIMIT)) {
      lines.push(`- ${renderRankedSessionCard(session, session.sessionId === report.recommendation.recommendedSessionId ? "continue" : "nearby")}`);
    }
  }
  appendSuggestionPlan(lines, report.suggestedCommands, profile);
  return lines.join("\n");
}

export function renderContinueInspectReport(input: {
  browserReport: SessionBrowserReport;
  recommendationReport: SessionResumeRecommendationReport;
  profile?: SessionBrowserRenderProfile;
}): string {
  const profile = input.profile ?? "summary";
  if (profile === "json") {
    return JSON.stringify({
      browser: input.browserReport,
      recommendation: input.recommendationReport,
    }, null, 2);
  }
  const current = input.browserReport.sessions.find((entry) => entry.relationToCurrent === "current") ?? null;
  const recommendedId = input.recommendationReport.recommendation.recommendedSessionId
    ?? input.browserReport.summary.recommendedResumeSessionId
    ?? null;
  const recommended = recommendedId
    ? input.browserReport.sessions.find((entry) => entry.sessionId === recommendedId) ?? null
    : null;
  const primary = input.recommendationReport.suggestedCommands[0]?.command
    ?? input.browserReport.suggestedCommands[0]?.command
    ?? "/status summary";
  const continueTarget = current?.resume.status === "not_needed"
    ? current
    : recommended ?? current;
  const lines = [
    "Continue",
    `Current: ${current ? `${renderCompactSessionRef(current.sessionId)} · ${renderSessionStatusLabel(current)}` : "inspect-only · no live session yet"}`,
    `Guide: ${continueTarget ? renderContinueWorthLine(continueTarget, input.recommendationReport) : "no session continuity yet; open status or run one task first"}`,
    `Next: ${primary}`,
  ];
  if (continueTarget) {
    lines.push(`Target: ${renderRankedSessionCard(continueTarget, continueTarget === current ? "current" : "continue")}`);
    lines.push(`Why: ${renderContinueWhyLine(continueTarget, input.recommendationReport)}`);
  } else {
    lines.push("Target: nothing live yet");
    lines.push("Why: there is no live or recommended continuity yet, so opening status is the fastest next step.");
  }
  const nearby = input.browserReport.sessions
    .filter((entry) => entry.sessionId !== continueTarget?.sessionId)
    .slice(0, 2);
  if (nearby.length > 0) {
    lines.push("Then:");
    for (const entry of nearby) {
      lines.push(`- ${renderRankedSessionCard(entry, "nearby")}`);
    }
  }
  return lines.join("\n");
}

async function buildSessionContextMap(
  target: SessionBrowserTarget,
  sessions: SessionIndexEntry[],
): Promise<Map<string, SessionBrowserContext>> {
  const map = new Map<string, SessionBrowserContext>();
  for (const entry of sessions) {
    const snapshot = await target.executionJournal.loadLatestSnapshot(entry.id).catch(() => null);
    const currentPlan = entry.id === target.sessionId
      ? target.lastExecutionPlan
      : snapshot?.state?.lastExecutionPlan ?? null;
    const currentTrace = entry.id === target.sessionId
      ? target.lastTrace
      : snapshot?.state?.lastTrace ?? null;
    const replay = shouldLoadReplay(entry, currentPlan, currentTrace)
      ? await target.sessionStore.buildReplay(entry.id).catch(() => null)
      : null;
    const decisionAvailable = entry.id === target.sessionId
      ? hasDecisionState(target.lastTaskClassification, target.lastRouteDecision, target.lastModelDecision, target.lastExecutionPlan)
      : hasDecisionState(
          snapshot?.state?.lastTaskClassification ?? null,
          snapshot?.state?.lastRouteDecision ?? null,
          snapshot?.state?.lastModelDecision ?? null,
          snapshot?.state?.lastExecutionPlan ?? null,
        );
    map.set(entry.id, {
      entry,
      replay,
      snapshot,
      plan: currentPlan,
      trace: currentTrace,
      decisionAvailable,
      verifierStatus: resolveVerifierStatus(
        currentTrace,
        entry.id === target.sessionId ? target.lastVerifierRun : null,
        replay,
      ),
      repairStatus: resolveRepairStatus(
        entry.id === target.sessionId ? target.lastRepairLoop : null,
        replay,
      ),
    });
  }
  return map;
}

async function resolveSessionBrowserReference(
  target: SessionBrowserTarget,
  sessions: SessionIndexEntry[],
  reference: string,
): Promise<SessionBrowserResolvedReference> {
  const normalized = `${reference ?? "current"}`.trim() || "current";
  if (normalized === "latest") {
    return {
      requestedReference: "latest",
      requestedKind: "latest",
      resolution: sessions[0] ? "latest" : "unavailable",
      resolvedSessionId: sessions[0]?.id ?? null,
      currentSessionId: target.sessionId,
    };
  }
  if (normalized === "current") {
    if (target.sessionId) {
      return {
        requestedReference: "current",
        requestedKind: "current",
        resolution: "current",
        resolvedSessionId: target.sessionId,
        currentSessionId: target.sessionId,
      };
    }
    return {
      requestedReference: "current",
      requestedKind: "current",
      resolution: sessions[0] ? "latest_fallback" : "unavailable",
      resolvedSessionId: sessions[0]?.id ?? null,
      currentSessionId: null,
    };
  }

  const replay = await target.sessionStore.buildReplay(normalized).catch(() => null);
  return {
    requestedReference: normalized,
    requestedKind: "session",
    resolution: replay ? "session" : "unavailable",
    resolvedSessionId: replay?.session.id ?? null,
    currentSessionId: target.sessionId,
  };
}

function buildSessionSummaryList(
  sessions: SessionIndexEntry[],
  contextMap: Map<string, SessionBrowserContext>,
  currentSessionId: string | null,
  referenceSessionId: string | null,
): SessionContinuitySummary[] {
  return sessions
    .map((entry) => contextMap.get(entry.id) ?? null)
    .filter((entry): entry is SessionBrowserContext => Boolean(entry))
    .map((context) => buildContinuitySummary(context, contextMap, currentSessionId, referenceSessionId))
    .sort((left, right) =>
      scoreContinuity(right) - scoreContinuity(left)
      || compareIsoDesc(left.lastUpdatedAt, right.lastUpdatedAt)
      || left.sessionId.localeCompare(right.sessionId))
    .slice(0, SESSION_RENDER_LIMIT);
}

function buildContinuitySummary(
  context: SessionBrowserContext,
  contextMap: Map<string, SessionBrowserContext>,
  currentSessionId: string | null,
  referenceSessionId: string | null,
): SessionContinuitySummary {
  const ageDays = calculateAgeDays(context.entry.lastUpdatedAt ?? context.entry.startedAt);
  const continuityStatus = deriveContinuityStatus(context, currentSessionId, ageDays);
  const relationToCurrent = deriveRelation(context.entry.id, currentSessionId, contextMap);
  const relationToReference = deriveRelation(context.entry.id, referenceSessionId, contextMap, true);
  const availability = {
    snapshotAvailable: Boolean(context.snapshot?.state),
    replayAvailable: Boolean(context.replay) || context.entry.eventCount > 0,
    planAvailable: hasPlan(context.plan),
    verifierAvailable: Boolean(context.verifierStatus),
    decisionAvailable: context.decisionAvailable,
  };
  const resume = derivePerSessionResumeState(context, continuityStatus, currentSessionId);

  return {
    sessionId: context.entry.id,
    filePath: context.entry.filePath,
    provider: context.entry.provider,
    model: context.entry.model,
    cwd: context.entry.cwd,
    networkMode: context.entry.networkMode,
    webProvider: context.entry.webProvider,
    rootSessionId: context.entry.rootSessionId,
    parentSessionId: context.entry.parentSessionId,
    children: context.entry.children.slice(),
    branchDepth: context.entry.branchDepth,
    branchType: context.entry.branchType,
    startedAt: context.entry.startedAt,
    lastUpdatedAt: context.entry.lastUpdatedAt,
    resumedAt: context.entry.resumedAt,
    resumedFromSnapshot: context.entry.resumedFromSnapshot,
    eventCount: context.entry.eventCount,
    finalContentPreview: summarizeText(context.entry.finalContent, 120),
    relationToCurrent,
    relationToReference,
    continuityStatus,
    ageDays,
    availability,
    latest: {
      activityAt: context.entry.lastUpdatedAt ?? context.entry.startedAt,
      planStatus: context.plan?.status ?? null,
      verifierStatus: context.verifierStatus,
      repairStatus: context.repairStatus,
    },
    resume,
    suggestedCommands: rankSuggestions(buildSessionSuggestions({
      summarySeed: {
        sessionId: context.entry.id,
        relationToCurrent,
        relationToReference,
        continuityStatus,
        availability,
      },
    })).slice(0, 4),
  };
}

function buildLineageSummary(
  focusContext: SessionBrowserContext | null,
  contextMap: Map<string, SessionBrowserContext>,
  currentSessionId: string | null,
): SessionLineageBrowserSummary | null {
  if (!focusContext) {
    return null;
  }

  const focus = buildContinuitySummary(focusContext, contextMap, currentSessionId, focusContext.entry.id);
  const ancestors: SessionContinuitySummary[] = [];
  let parentId = focusContext.entry.parentSessionId;
  while (parentId) {
    const parent = contextMap.get(parentId);
    if (!parent) {
      break;
    }
    ancestors.push(buildContinuitySummary(parent, contextMap, currentSessionId, focusContext.entry.id));
    parentId = parent.entry.parentSessionId;
  }

  const children = focusContext.entry.children
    .map((id) => contextMap.get(id) ?? null)
    .filter((entry): entry is SessionBrowserContext => Boolean(entry))
    .map((entry) => buildContinuitySummary(entry, contextMap, currentSessionId, focusContext.entry.id))
    .slice(0, LINEAGE_RENDER_LIMIT);

  return {
    focus,
    rootSessionId: focusContext.entry.rootSessionId,
    parentSessionId: focusContext.entry.parentSessionId,
    branchDepth: focusContext.entry.branchDepth,
    ancestors: ancestors.slice(0, LINEAGE_RENDER_LIMIT),
    children,
  };
}

function buildReplaySummary(
  focusContext: SessionBrowserContext | null,
  currentSessionId: string | null,
): SessionReplayBrowserSummary | null {
  if (!focusContext?.replay) {
    return null;
  }
  const replay = focusContext.replay;
  const summarySeed = {
    sessionId: replay.session.id,
    relationToCurrent: focusContext.entry.id === currentSessionId ? "current" as const : "related" as const,
    relationToReference: "self" as const,
    continuityStatus: deriveContinuityStatus(focusContext, currentSessionId, calculateAgeDays(focusContext.entry.lastUpdatedAt)),
    availability: {
      snapshotAvailable: Boolean(focusContext.snapshot?.state),
      replayAvailable: true,
      planAvailable: hasPlan(focusContext.plan),
      verifierAvailable: replay.verifierRuns.length > 0 || Boolean(focusContext.verifierStatus),
      decisionAvailable: focusContext.decisionAvailable,
    },
  };
  return {
    sessionId: replay.session.id,
    branchEventsSessionId: replay.branchEventsSessionId,
    promptCount: replay.prompts.length,
    toolCallCount: replay.toolCalls.length,
    changeCount: replay.changes.length,
    verifierRunCount: replay.verifierRuns.length,
    repairLoopCount: replay.repairLoops.length,
    finalCount: replay.finals.length,
    latestVerifierStatus: replay.verifierRuns.at(-1)?.run.summary.status ?? focusContext.verifierStatus,
    latestRepairStatus: replay.repairLoops.at(-1)?.loop.summary.status ?? focusContext.repairStatus,
    latestFinalContentPreview: summarizeText(
      toNullableString(replay.finals.at(-1)?.content) ?? focusContext.entry.finalContent,
      140,
    ),
    availability: {
      planAvailable: summarySeed.availability.planAvailable,
      verifierAvailable: summarySeed.availability.verifierAvailable,
      decisionAvailable: summarySeed.availability.decisionAvailable,
    },
    suggestedCommands: rankSuggestions([
      summarySeed.availability.planAvailable
        ? suggestion(`/plan timeline replay:${replay.session.id} summary`, "This replay still has plan continuity; open its timeline next.", 100)
        : null,
      summarySeed.availability.decisionAvailable
        ? suggestion(`/why plan replay:${replay.session.id} summary`, "This replay still has decision continuity; inspect why next.", 98)
        : null,
      summarySeed.availability.verifierAvailable
        ? suggestion(`/verifier replay ${replay.session.id} failures`, "This replay still has verifier continuity; open failures next.", 96)
        : null,
      suggestion(`/history lineage ${replay.session.id} summary`, "Switch back to lineage view to place this replay in the branch tree.", 94),
      focusContext.entry.id !== currentSessionId
        ? suggestion(`/resume ${replay.session.id}`, "If the replay still looks strong, resume from its source session.", 92)
        : null,
    ]).slice(0, 4),
  };
}

function buildResumeRecommendation(
  anchor: SessionContinuitySummary | null,
  sessions: SessionContinuitySummary[],
  currentSessionId: string | null,
  reference: SessionBrowserResolvedReference,
): SessionResumeRecommendation {
  if (sessions.length === 0) {
    return {
      status: "unavailable",
      reasonKind: "no_sessions",
      recommendedSessionId: null,
      relationToCurrent: "none",
      relationToReference: "none",
      continuityStatus: null,
      summary: "No recorded session continuity is available yet.",
      blockers: ["No sessions were recorded yet."],
      suggestedCommands: [{
        command: "/status summary",
        reason: "Open status first to check whether you are still in inspect-only mode.",
        priority: 100,
      }],
    };
  }

  if (anchor && anchor.sessionId === currentSessionId) {
    return {
      status: "not_needed",
      reasonKind: "already_current",
      recommendedSessionId: anchor.sessionId,
      relationToCurrent: "current",
      relationToReference: anchor.relationToReference,
      continuityStatus: anchor.continuityStatus,
      summary: "You are already on the strongest live session; inspect lineage, plan, or verifier before creating another resume branch.",
      blockers: [],
      suggestedCommands: [
        suggestion("/history lineage current summary", "Inspect the current branch and its lineage first.", 100),
        suggestion("/plan timeline current summary", "Check the current plan continuity next.", 96),
        suggestion("/why plan current summary", "If the stop point is unclear, inspect why next.", 94),
        suggestion("/verifier current failures", "If verifier is blocking the loop, open failures next.", 92),
      ],
    };
  }

  const primary = pickResumeCandidate(anchor, sessions);
  if (!primary) {
    return {
      status: "unavailable",
      reasonKind: "no_resumable_session",
      recommendedSessionId: null,
      relationToCurrent: "none",
      relationToReference: anchor?.relationToCurrent ?? "none",
      continuityStatus: anchor?.continuityStatus ?? null,
      summary: "No session looks strong enough to resume directly; replay or inspect first.",
      blockers: anchor ? [describeBlockedResume(anchor)] : ["No recent session continuity was found."],
      suggestedCommands: buildUnavailableResumeCommands(reference, anchor),
    };
  }

  const status = primary.continuityStatus === "stale" || primary.continuityStatus === "historical_only"
    ? "discouraged"
    : "recommended";
  const reasonKind = primary.continuityStatus === "stale"
    ? "stale_session"
    : primary.continuityStatus === "historical_only"
      ? "historical_only"
      : anchor && primary.sessionId === anchor.sessionId
        ? "reference_recent_session"
        : anchor
          ? "related_recent_session"
          : "latest_recent_session";

  return {
    status,
    reasonKind,
    recommendedSessionId: primary.sessionId,
    relationToCurrent: primary.relationToCurrent,
    relationToReference: primary.relationToReference,
    continuityStatus: primary.continuityStatus,
    summary: buildResumeSummary(primary, anchor, status),
    blockers: status === "discouraged"
      ? [describeBlockedResume(primary)]
      : [],
    suggestedCommands: rankSuggestions([
      suggestion(`/resume ${primary.sessionId}`, "Resume directly from the recommended session.", 100),
      suggestion(`/history lineage ${primary.sessionId} summary`, "Confirm where it sits in the full lineage first.", 97),
      ...primary.suggestedCommands,
    ]).slice(0, 4),
  };
}

function pickResumeCandidate(
  anchor: SessionContinuitySummary | null,
  sessions: SessionContinuitySummary[],
): SessionContinuitySummary | null {
  const candidates = sessions.filter((entry) => entry.resume.status !== "not_needed");
  if (anchor && anchor.continuityStatus !== "historical_only") {
    return anchor;
  }
  return [...candidates].sort((left, right) =>
    scoreResumeCandidate(right, anchor) - scoreResumeCandidate(left, anchor)
    || compareIsoDesc(left.lastUpdatedAt, right.lastUpdatedAt)
    || left.sessionId.localeCompare(right.sessionId))[0] ?? null;
}

function selectScopedSessions(
  scope: AgentInteractionHistoryScope,
  sessionSummaries: SessionContinuitySummary[],
  lineage: SessionLineageBrowserSummary | null,
  focusSessionId: string | null,
): SessionContinuitySummary[] {
  if (scope === "sessions" || scope === "all" || scope === "changes") {
    return sessionSummaries.slice(0, SESSION_RENDER_LIMIT);
  }
  if (scope === "lineage") {
    return [
      ...(lineage?.focus ? [lineage.focus] : []),
      ...(lineage?.ancestors ?? []),
      ...(lineage?.children ?? []),
    ].slice(0, SESSION_RENDER_LIMIT);
  }
  if (scope === "replay") {
    return sessionSummaries.filter((entry) => entry.sessionId === focusSessionId).slice(0, 1);
  }
  return sessionSummaries.slice(0, SESSION_RENDER_LIMIT);
}

function collectBrowserSuggestions(input: {
  scope: AgentInteractionHistoryScope;
  resolvedReference: SessionBrowserResolvedReference;
  focus: SessionContinuitySummary | null;
  lineage: SessionLineageBrowserSummary | null;
  replay: SessionReplayBrowserSummary | null;
  recommendedResumeSessionId: string | null;
}): SessionCommandSuggestion[] {
  const suggestions: SessionCommandSuggestion[] = [];
  const focusId = input.focus?.sessionId ?? input.resolvedReference.resolvedSessionId;
  if (input.scope !== "lineage" && focusId) {
    suggestions.push(suggestion(`/history lineage ${focusId} summary`, "Inspect the parent/child relationships around this session.", 98));
  }
  if (input.scope !== "replay" && focusId) {
    suggestions.push(suggestion(`/history replay ${focusId} summary`, "Inspect replay, verifier, and repair counts for this session.", 96));
  }
  if (input.recommendedResumeSessionId) {
    suggestions.push(suggestion(`/resume ${input.recommendedResumeSessionId}`, "Resume directly from the recommended session.", 97));
    suggestions.push(suggestion(`/resume recommend ${input.recommendedResumeSessionId} summary`, "Inspect why the system prefers this session.", 95));
  }
  if (input.replay?.availability.planAvailable && focusId) {
    suggestions.push(suggestion(`/plan timeline replay:${focusId} summary`, "This session still has plan continuity; drill into its timeline next.", 94));
  }
  if (input.replay?.availability.decisionAvailable && focusId) {
    suggestions.push(suggestion(`/why plan replay:${focusId} summary`, "This session still has decision continuity; inspect why next.", 93));
  }
  if (input.replay?.availability.verifierAvailable && focusId) {
    suggestions.push(suggestion(`/verifier replay ${focusId} failures`, "This session still has verifier continuity; open failures next.", 92));
  }
  if (input.lineage?.focus?.parentSessionId) {
    suggestions.push(suggestion(`/resume ${input.lineage.focus.parentSessionId}`, "Resume from the parent session if you want to move back upstream.", 88));
  }
  return suggestions;
}

function buildSessionSuggestions(input: {
  summarySeed: {
    sessionId: string;
    relationToCurrent: SessionLineageRelationKind;
    relationToReference: SessionLineageRelationKind;
    continuityStatus: SessionContinuityStatus;
    availability: {
      snapshotAvailable: boolean;
      replayAvailable: boolean;
      planAvailable: boolean;
      verifierAvailable: boolean;
      decisionAvailable: boolean;
    };
  };
}): SessionCommandSuggestion[] {
  const { summarySeed } = input;
  const suggestions: SessionCommandSuggestion[] = [];
  const sessionId = summarySeed.sessionId;

  if (summarySeed.relationToCurrent !== "current") {
    suggestions.push(suggestion(`/resume ${sessionId}`, "Create a new continuation branch from this session.", 100));
  }
  suggestions.push(suggestion(`/history lineage ${sessionId} summary`, "Inspect where it sits in the full lineage.", 98));
  if (summarySeed.availability.replayAvailable) {
    suggestions.push(suggestion(`/history replay ${sessionId} summary`, "Inspect replay, change, and verifier counts.", 96));
  }
  if (summarySeed.availability.planAvailable) {
    suggestions.push(suggestion(`/plan timeline replay:${sessionId} summary`, "Inspect this session's plan continuity.", 94));
  }
  if (summarySeed.availability.decisionAvailable) {
    suggestions.push(suggestion(`/why plan replay:${sessionId} summary`, "Inspect why it stopped in its current plan state.", 92));
  }
  if (summarySeed.availability.verifierAvailable) {
    suggestions.push(suggestion(`/verifier replay ${sessionId} failures`, "Inspect its verifier continuity.", 90));
  }
  return suggestions;
}

function derivePerSessionResumeState(
  context: SessionBrowserContext,
  continuityStatus: SessionContinuityStatus,
  currentSessionId: string | null,
): SessionContinuitySummary["resume"] {
  if (context.entry.id === currentSessionId) {
    return {
      status: "not_needed",
      reasonKind: "already_current",
      summary: "You are already on this session.",
    };
  }
  if (continuityStatus === "recent" || continuityStatus === "active") {
    return {
      status: "recommended",
      reasonKind: "reference_recent_session",
      summary: "This session is still live enough to resume from directly.",
    };
  }
  if (continuityStatus === "stale") {
    return {
      status: "discouraged",
      reasonKind: "stale_session",
      summary: "This session is stale; replay it before resuming.",
    };
  }
  if (continuityStatus === "historical_only") {
    return {
      status: "discouraged",
      reasonKind: "historical_only",
      summary: "This session looks more archival than live; replay it instead of resuming directly.",
    };
  }
  return {
    status: "unavailable",
    reasonKind: "no_resumable_session",
    summary: "This session does not expose enough continuity for a confident resume decision yet.",
  };
}

function deriveContinuityStatus(
  context: SessionBrowserContext,
  currentSessionId: string | null,
  ageDays: number | null,
): SessionContinuityStatus {
  if (context.entry.id === currentSessionId) {
    return "active";
  }
  if (!context.snapshot?.state && !context.replay && context.entry.finalContent) {
    return "historical_only";
  }
  if (!context.snapshot?.state && !context.trace && context.entry.finalContent) {
    return "historical_only";
  }
  if (ageDays != null && ageDays > STALE_DAYS) {
    return "stale";
  }
  return "recent";
}

function deriveRelation(
  sessionId: string,
  referenceSessionId: string | null,
  contextMap: Map<string, SessionBrowserContext>,
  useSelf = false,
): SessionLineageRelationKind {
  if (!referenceSessionId) {
    return "none";
  }
  if (sessionId === referenceSessionId) {
    return useSelf ? "self" : "current";
  }
  const session = contextMap.get(sessionId)?.entry ?? null;
  const reference = contextMap.get(referenceSessionId)?.entry ?? null;
  if (!session || !reference) {
    return "unrelated";
  }
  if (session.parentSessionId === referenceSessionId) {
    return "child";
  }
  if (reference.parentSessionId === sessionId) {
    return "parent";
  }
  if (isAncestor(sessionId, referenceSessionId, contextMap)) {
    return "ancestor";
  }
  if (isAncestor(referenceSessionId, sessionId, contextMap)) {
    return "descendant";
  }
  if (session.parentSessionId && session.parentSessionId === reference.parentSessionId) {
    return "sibling";
  }
  if (session.rootSessionId === reference.rootSessionId) {
    return "related";
  }
  return "unrelated";
}

function isAncestor(
  candidateAncestorId: string,
  sessionId: string,
  contextMap: Map<string, SessionBrowserContext>,
): boolean {
  let currentId = contextMap.get(sessionId)?.entry.parentSessionId ?? null;
  while (currentId) {
    if (currentId === candidateAncestorId) {
      return true;
    }
    currentId = contextMap.get(currentId)?.entry.parentSessionId ?? null;
  }
  return false;
}

function hasDecisionState(
  taskClassification: unknown,
  routeDecision: unknown,
  modelDecision: unknown,
  executionPlan: ExecutionPlan | null,
): boolean {
  return Boolean(taskClassification || routeDecision || modelDecision || hasPlan(executionPlan));
}

function hasPlan(plan: ExecutionPlan | null): boolean {
  return Boolean(plan && Array.isArray(plan.steps) && plan.steps.length > 0);
}

function shouldLoadReplay(
  entry: SessionIndexEntry,
  plan: ExecutionPlan | null,
  trace: TraceSummary | null,
): boolean {
  return !plan || !trace || Boolean(entry.finalContent) || entry.branchDepth > 0;
}

function resolveVerifierStatus(
  trace: TraceSummary | null,
  currentVerifierRun: VerifierRunRecord | null,
  replay: SessionReplay | null,
): string | null {
  return currentVerifierRun?.summary.status
    ?? trace?.verifier?.status
    ?? replay?.verifierRuns.at(-1)?.run.summary.status
    ?? null;
}

function resolveRepairStatus(
  currentRepairLoop: RepairLoopRecord | null,
  replay: SessionReplay | null,
): string | null {
  return currentRepairLoop?.summary.status
    ?? replay?.repairLoops.at(-1)?.loop.summary.status
    ?? null;
}

function calculateAgeDays(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  return diffMs < 0 ? 0 : Math.floor(diffMs / 86_400_000);
}

function pickRecommendedResumeSessionId(
  sessions: SessionContinuitySummary[],
  currentSessionId: string | null,
): string | null {
  const recommended = sessions.find((entry) => entry.resume.status === "recommended" && entry.sessionId !== currentSessionId);
  return recommended?.sessionId ?? null;
}

function scoreContinuity(entry: SessionContinuitySummary): number {
  let score = 0;
  if (entry.relationToCurrent === "current") {
    score += 100;
  }
  if (entry.continuityStatus === "active") {
    score += 80;
  } else if (entry.continuityStatus === "recent") {
    score += 60;
  } else if (entry.continuityStatus === "stale") {
    score += 20;
  }
  if (entry.availability.planAvailable) {
    score += 12;
  }
  if (entry.availability.verifierAvailable) {
    score += 10;
  }
  if (entry.availability.decisionAvailable) {
    score += 8;
  }
  return score;
}

function scoreResumeCandidate(
  entry: SessionContinuitySummary,
  anchor: SessionContinuitySummary | null,
): number {
  let score = scoreContinuity(entry);
  if (anchor && entry.sessionId === anchor.sessionId) {
    score += 40;
  }
  if (entry.relationToReference === "child") {
    score += 22;
  } else if (entry.relationToReference === "parent") {
    score += 18;
  } else if (entry.relationToReference === "sibling") {
    score += 16;
  } else if (entry.relationToReference === "related") {
    score += 10;
  }
  if (entry.continuityStatus === "historical_only") {
    score -= 30;
  }
  if (entry.continuityStatus === "stale") {
    score -= 12;
  }
  return score;
}

function buildResumeSummary(
  primary: SessionContinuitySummary,
  anchor: SessionContinuitySummary | null,
  status: SessionResumeRecommendationStatus,
): string {
  if (anchor && primary.sessionId === anchor.sessionId) {
    return status === "discouraged"
      ? "The anchor session is still resumable, but it looks old enough that replay should come first."
      : "The anchor session itself is still the best continuation point.";
  }
  if (primary.relationToReference === "child" || primary.relationToReference === "parent" || primary.relationToReference === "sibling") {
    return `A nearby ${primary.relationToReference} branch is the best continuation point because its continuity is stronger.`;
  }
  return "The strongest continuation point is the newest session with the best remaining continuity.";
}

function describeBlockedResume(entry: SessionContinuitySummary): string {
  if (entry.continuityStatus === "historical_only") {
    return "This session only looks like historical output without enough live continuity.";
  }
  if (entry.continuityStatus === "stale") {
    return "This session is stale and should be replayed before branching from it.";
  }
  if (!entry.availability.decisionAvailable && !entry.availability.planAvailable && !entry.availability.verifierAvailable) {
    return "This session has very little decision/plan/verifier continuity to anchor a clean resume.";
  }
  return "This session is not the strongest continuation point right now.";
}

function buildUnavailableResumeCommands(
  reference: SessionBrowserResolvedReference,
  anchor: SessionContinuitySummary | null,
): SessionCommandSuggestion[] {
  const anchorId = anchor?.sessionId ?? reference.resolvedSessionId;
  return rankSuggestions([
    anchorId ? suggestion(`/history replay ${anchorId} summary`, "Inspect replay continuity before deciding whether to resume.", 100) : null,
    anchorId ? suggestion(`/history lineage ${anchorId} summary`, "Inspect where this session sits in the lineage first.", 98) : null,
    suggestion("/history sessions summary", "Go back to the session browser overview and pick a stronger target.", 96),
  ]).slice(0, 4);
}

function appendSessionList(
  lines: string[],
  sessions: SessionContinuitySummary[],
  profile: SessionBrowserRenderProfile,
  focusSessionId?: string | null,
  recommendedSessionId?: string | null,
): void {
  if (sessions.length === 0) {
    lines.push("Sessions: none yet");
    lines.push("Why: no recorded session continuity exists yet; start with /status or run one task before replay or resume.");
    return;
  }
  lines.push(`Sessions: top ${Math.min(sessions.length, SESSION_CARD_LIMIT)} of ${sessions.length}`);
  const visible = profile === "failures"
    ? sessions.filter((entry) => entry.continuityStatus === "stale" || entry.resume.status === "discouraged")
    : sessions;
  const ranked: Array<{ session: SessionContinuitySummary; role: RankedSessionRole }> = visible
    .map((session) => ({
      session,
      role: (recommendedSessionId && session.sessionId === recommendedSessionId
        ? "continue"
        : focusSessionId && session.sessionId === focusSessionId
          ? "focus"
          : session.relationToCurrent === "current"
            ? "current"
            : session.continuityStatus === "stale" || session.continuityStatus === "historical_only"
              ? "stale"
            : "nearby") as RankedSessionRole,
    }))
    .sort((left, right) =>
      compareRankedSessionRoles(left.role, right.role)
      || compareIsoDesc(left.session.lastUpdatedAt, right.session.lastUpdatedAt)
      || left.session.sessionId.localeCompare(right.session.sessionId),
    );
  for (const entry of ranked.slice(0, profile === "failures" ? SESSION_RENDER_LIMIT : SESSION_CARD_LIMIT)) {
    lines.push(`- ${renderRankedSessionCard(entry.session, entry.role)}`);
  }
}

function appendLineageSummary(lines: string[], lineage: SessionLineageBrowserSummary | null): void {
  if (!lineage?.focus) {
    lines.push("Lineage: unavailable");
    lines.push("Why: no lineage continuity is available for this reference yet.");
    return;
  }
  lines.push(`Lineage: ${renderSessionCard(lineage.focus, "focus")}`);
  lines.push(`Signals: ${renderDecisionWorthSummary({
    resume: lineage.focus.resume.status,
    replay: lineage.focus.availability.replayAvailable,
    plan: lineage.focus.availability.planAvailable,
    verifier: lineage.focus.availability.verifierAvailable,
  })}`);
  lines.push(`Tree: root=${renderCompactSessionRef(lineage.rootSessionId ?? "none")} parent=${renderCompactSessionRef(lineage.parentSessionId ?? "none")} depth=${lineage.branchDepth ?? 0}`);
  lines.push(`Upstream: ${renderLineageNeighborList(lineage.ancestors)}`);
  lines.push(`Downstream: ${renderLineageNeighborList(lineage.children)}`);
}

function appendReplaySummary(lines: string[], replay: SessionReplayBrowserSummary | null): void {
  if (!replay) {
    lines.push("Replay: unavailable");
    lines.push("Why: no replay continuity is available for this reference yet.");
    return;
  }
  lines.push(`Replay: ${renderCompactSessionRef(replay.sessionId ?? "none")} · prompts=${replay.promptCount} tools=${replay.toolCallCount} changes=${replay.changeCount} finals=${replay.finalCount}`);
  lines.push(`Signals: ${renderReplayWorthSummary(replay)}`);
  if (replay.latestFinalContentPreview) {
    lines.push(`Final: ${replay.latestFinalContentPreview}`);
  }
}

function renderReference(reference: SessionBrowserResolvedReference): string {
  return `ref=${reference.requestedReference ?? "current"} -> ${reference.resolution}${reference.resolvedSessionId ? ` (${renderCompactSessionRef(reference.resolvedSessionId)})` : ""}`;
}

function renderSessionCompact(entry: SessionContinuitySummary): string {
  return `${entry.sessionId} ${entry.provider ?? "unknown"}/${entry.model ?? "auto"} branch=${entry.branchType} depth=${entry.branchDepth} updated=${entry.lastUpdatedAt ?? "unknown"}`;
}

function renderSessionCard(
  entry: SessionContinuitySummary,
  role: RankedSessionRole,
): string {
  const parts = [
    `${role} ${renderCompactSessionRef(entry.sessionId)}`,
    renderSessionStatusLabel(entry),
    renderRankedSessionReason(entry, role),
    renderRankedAvailability(entry, role),
    renderRankedSessionBranch(entry),
  ].filter((value): value is string => Boolean(value));
  return parts.join(" · ");
}

function renderRankedSessionCard(
  entry: SessionContinuitySummary,
  role: RankedSessionRole,
): string {
  const details = [
    renderRankedPrimaryActionLabel(entry, role),
    renderRankedSessionReason(entry, role),
    renderRankedAvailability(entry, role),
    renderRankedSessionBranch(entry),
  ].filter((value): value is string => Boolean(value));
  return `${renderRankedRoleLabel(role)} ${renderCompactSessionRef(entry.sessionId)}${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`;
}

function renderRankedPrimaryActionLabel(
  entry: SessionContinuitySummary,
  role: RankedSessionRole,
): string {
  if (role === "continue" || entry.resume.status === "recommended") {
    return "resume now";
  }
  if (role === "focus" || role === "current") {
    return "open lineage";
  }
  if (role === "stale" || entry.continuityStatus === "historical_only" || entry.continuityStatus === "stale") {
    return "replay first";
  }
  return "open lineage";
}

function renderRankedSessionReason(
  entry: SessionContinuitySummary,
  role: RankedSessionRole,
): string {
  if (role === "continue" || entry.resume.status === "recommended") {
    return renderResumeReasonLabel(entry);
  }
  if (role === "focus" || role === "current" || role === "anchor") {
    return "current thread";
  }
  if (role === "stale") {
    return entry.continuityStatus === "historical_only"
      ? "older saved path"
      : "older branch";
  }
  if (entry.continuityStatus === "stale") {
    return "stale; inspect first";
  }
  if (entry.continuityStatus === "historical_only") {
    return "historical only";
  }
  if (entry.relationToCurrent && entry.relationToCurrent !== "none" && entry.relationToCurrent !== "unrelated") {
    return `${entry.relationToCurrent} branch`;
  }
  return "related continuity";
}

function renderRankedSessionBranch(entry: SessionContinuitySummary): string | null {
  if (entry.branchType === "root" && entry.branchDepth === 0) {
    return null;
  }
  return `${entry.branchType}@${entry.branchDepth}`;
}

function renderRankedAvailability(
  entry: SessionContinuitySummary,
  role: RankedSessionRole,
): string | null {
  const summary = renderAvailabilitySummary(entry);
  if (summary === "none") {
    return null;
  }
  if (role === "focus" || role === "current") {
    return summary === "replay" ? "replay ready" : `inspect ${summary}`;
  }
  if (role === "stale") {
    return summary === "replay"
      ? "replay ready"
      : `inspect ${summary}`;
  }
  return summary;
}

function renderRankedRoleLabel(role: RankedSessionRole): string {
  switch (role) {
    case "continue":
      return "continue this";
    case "focus":
      return "look here";
    case "current":
      return "here now";
    case "nearby":
      return "nearby";
    case "stale":
      return "backup";
    case "anchor":
      return "anchor";
  }
}

function renderCompactSessionRef(sessionId: string): string {
  const isoLikeMatch = sessionId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d{3})?Z(?:-(.+))?$/);
  if (isoLikeMatch) {
    const [, date, hour, minute, _second, suffix] = isoLikeMatch;
    return `${date} ${hour}:${minute}${suffix ? ` #${suffix.length <= 10 ? suffix : suffix.slice(0, 6)}` : ""}`;
  }
  return summarizeText(sessionId, 28) ?? sessionId;
}

function renderLineageNeighborList(entries: SessionContinuitySummary[]): string {
  if (entries.length === 0) {
    return "none";
  }
  return entries
    .slice(0, 2)
    .map((entry) => `${renderCompactSessionRef(entry.sessionId)}(${entry.relationToReference}/${entry.continuityStatus})`)
    .join(", ");
}

function buildBrowserContinueLine(
  report: SessionBrowserReport,
  focusSessionId: string | null,
  primaryCommand: string | null,
): string {
  if (report.scope === "replay") {
    return `Guide: ${renderDecisionActionSummary(primaryCommand)} · replay=${report.replay ? "ready" : "thin"}`;
  }
  if (report.scope === "lineage") {
    return `Guide: ${renderDecisionActionSummary(primaryCommand)} · depth=${report.lineage?.branchDepth ?? 0}`;
  }
  return `Guide: ${renderDecisionActionSummary(primaryCommand)} · recommended=${renderCompactSessionRef(report.summary.recommendedResumeSessionId ?? focusSessionId ?? "none")} · paths=${report.summary.sessionCount}`;
}

function buildBrowserNowLine(
  report: SessionBrowserReport,
  focusSessionId: string | null,
): string {
  const focusRef = focusSessionId ? renderCompactSessionRef(focusSessionId) : "none";
  return `Focus: ${focusRef} · ${renderReference(report.reference)}`;
}

function appendSuggestionPlan(
  lines: string[],
  suggestions: SessionCommandSuggestion[],
  profile: SessionBrowserRenderProfile,
): void {
  const primary = suggestions[0] ?? null;
  const secondary = suggestions.slice(1, 3);
  lines.push(`Next: ${primary?.command ?? "none"}`);
  if (primary && profile !== "failures") {
    lines.push(`  ${primary.reason}`);
  }
  if (secondary.length > 0) {
    lines.push("Then:");
    for (const suggestion of secondary) {
      lines.push(`- ${suggestion.command}`);
      if (profile !== "failures") {
        lines.push(`  ${suggestion.reason}`);
      }
    }
  }
}

function buildEmptyBrowserSuggestions(
  scope: AgentInteractionHistoryScope,
): SessionCommandSuggestion[] {
  return rankSuggestions([
    suggestion("/status summary", "Open status first to confirm whether the agent is still in inspect-only mode.", 100),
    suggestion("/help", "Return to the core command surface if you have not started a session yet.", 96),
    scope !== "changes" ? suggestion("/history changes summary", "Open recent change history if you only need to inspect local edits.", 92) : null,
  ]).slice(0, 3);
}

function summarizeText(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  return compact.length > maxLength
    ? `${compact.slice(0, Math.max(0, maxLength - 3))}...`
    : compact;
}

function compareRankedSessionRoles(
  left: RankedSessionRole,
  right: RankedSessionRole,
): number {
  const order = {
    continue: 0,
    focus: 1,
    current: 2,
    nearby: 3,
    stale: 4,
    anchor: 5,
  } as const;
  return order[left] - order[right];
}

function renderDecisionActionSummary(command: string | null): string {
  if (!command) {
    return "none";
  }
  if (command.startsWith("/resume ")) {
    return "resume now";
  }
  if (command.startsWith("/status")) {
    return "open status";
  }
  if (command.startsWith("/history lineage ")) {
    return "open lineage";
  }
  if (command.startsWith("/history replay ")) {
    return "open replay";
  }
  if (command.startsWith("/plan timeline ")) {
    return "open plan";
  }
  if (command.startsWith("/why ")) {
    return "open why";
  }
  return summarizeText(command, 28) ?? command;
}

function renderSessionStatusLabel(entry: SessionContinuitySummary): string {
  if (entry.resume.status === "recommended") {
    return "best continue";
  }
  if (entry.continuityStatus === "active") {
    return "active";
  }
  if (entry.continuityStatus === "recent") {
    return "recent";
  }
  if (entry.continuityStatus === "historical_only") {
    return "history only";
  }
  if (entry.continuityStatus === "stale") {
    return "stale";
  }
  return entry.continuityStatus;
}

function renderResumeReasonLabel(entry: SessionContinuitySummary): string {
  switch (entry.resume.reasonKind) {
    case "reference_recent_session":
      return "still live";
    case "related_recent_session":
      return "strong nearby branch";
    case "latest_recent_session":
      return "latest live branch";
    case "already_current":
      return "already here";
    case "stale_session":
      return "older branch";
    case "historical_only":
      return "history only";
    default:
      return summarizeText(entry.resume.summary, 28) ?? "worth continuing";
  }
}

function renderDecisionWorthSummary(input: {
  resume: string;
  replay: boolean;
  plan: boolean;
  verifier: boolean;
}): string {
  return [
    `resume=${input.resume}`,
    input.replay ? "replay ready" : "replay thin",
    input.plan ? "plan continuity" : "plan thin",
    input.verifier ? "verifier continuity" : "verifier thin",
  ].join(" · ");
}

function renderReplayWorthSummary(replay: SessionReplayBrowserSummary): string {
  return [
    replay.availability.planAvailable ? "plan continuity" : "plan thin",
    replay.availability.verifierAvailable ? "verifier continuity" : "verifier thin",
    replay.availability.decisionAvailable ? "decision continuity" : "decision thin",
    `latest verifier=${replay.latestVerifierStatus ?? "none"}`,
    `repair=${replay.latestRepairStatus ?? "none"}`,
  ].join(" · ");
}

function renderContinueWorthLine(
  target: SessionContinuitySummary,
  recommendationReport: SessionResumeRecommendationReport,
): string {
  return [
    recommendationReport.recommendation.status === "not_needed"
      ? "stay on current session"
      : recommendationReport.recommendation.status === "recommended"
        ? "recommended continue path"
        : recommendationReport.recommendation.status === "discouraged"
          ? "inspect before branching"
          : "no direct resume path",
    target.continuityStatus === "active" || target.continuityStatus === "recent"
      ? "continuity still live"
      : target.continuityStatus === "stale"
        ? "stale continuity"
        : "mostly historical",
    renderAvailabilitySummary(target),
  ].join(" · ");
}

function renderContinueWhyLine(
  target: SessionContinuitySummary,
  recommendationReport: SessionResumeRecommendationReport,
): string {
  if (recommendationReport.recommendation.status === "not_needed") {
    return "you are already on the strongest live thread, so lineage/replay is a better first move than opening another resume branch";
  }
  if (recommendationReport.recommendation.status === "recommended") {
    return summarizeText(recommendationReport.recommendation.summary, 120)
      ?? `${renderCompactSessionRef(target.sessionId)} is the strongest nearby continue path right now`;
  }
  if (recommendationReport.recommendation.status === "discouraged") {
    return "this path is still visible, but replay or lineage should come before branching";
  }
  return "there is not enough live continuity yet to recommend a direct continue path";
}

function renderRecommendationWhyLine(
  report: SessionResumeRecommendationReport,
): string {
  if (report.recommendation.reasonKind === "already_current") {
    return "the current thread is already the best place to continue, so inspect lineage or replay before branching";
  }
  if (report.recommendation.reasonKind === "related_recent_session") {
    return "a nearby branch is fresher than the current anchor and still has useful continuity attached";
  }
  if (report.recommendation.reasonKind === "reference_recent_session") {
    return "the reference thread itself is still live enough to branch from directly";
  }
  if (report.recommendation.reasonKind === "latest_recent_session") {
    return "the newest live branch is the best continue target from this view";
  }
  if (report.recommendation.reasonKind === "stale_session" || report.recommendation.reasonKind === "historical_only") {
    return "this target still exists, but replay or lineage should come before resuming it";
  }
  return summarizeText(report.recommendation.summary, 120)
    ?? "this is the strongest continue candidate from the current continuity view";
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function suggestion(command: string, reason: string, priority: number): SessionCommandSuggestion {
  return { command, reason, priority };
}

function rankSuggestions(values: Array<SessionCommandSuggestion | null>): SessionCommandSuggestion[] {
  return values
    .filter((value): value is SessionCommandSuggestion => Boolean(value))
    .sort((left, right) => right.priority - left.priority || left.command.localeCompare(right.command))
    .filter((entry, index, array) => array.findIndex((candidate) => candidate.command === entry.command) === index);
}

function compareIsoDesc(left: string | null, right: string | null): number {
  const leftMs = left ? Date.parse(left) : 0;
  const rightMs = right ? Date.parse(right) : 0;
  return rightMs - leftMs;
}

function boolWord(value: boolean): string {
  return value ? "yes" : "no";
}

function buildPickerSections(
  mode: InteractiveSessionPickerMode,
  browserReport: SessionBrowserReport,
  recommendationReport: SessionResumeRecommendationReport | null,
): Array<{ title: string; entries: InteractiveSessionPickerEntry[] }> {
  const recommendedSessionId = recommendationReport?.recommendation.recommendedSessionId
    ?? browserReport.summary.recommendedResumeSessionId
    ?? null;
  const focusSessionId = browserReport.reference.resolvedSessionId ?? null;
  if (isActionPickerMode(mode)) {
    return buildActionPickerSections(mode, browserReport, recommendationReport);
  }

  const recentEntries = browserReport.sessions
    .slice(0, SESSION_RENDER_LIMIT)
    .map((session) => createTargetPickerEntry(
      session,
      mode,
      [
        session.sessionId === focusSessionId ? "focus" : null,
        session.relationToCurrent === "current" ? "current" : null,
        session.sessionId === recommendedSessionId ? "recommended" : null,
      ].filter((value): value is string => Boolean(value)),
      session.sessionId === focusSessionId,
      session.sessionId === recommendedSessionId,
    ));

  if (mode === "resume") {
    const recommendationTarget = recommendationReport?.recommendation.recommendedSessionId
      ? browserReport.sessions.find((entry) => entry.sessionId === recommendationReport.recommendation.recommendedSessionId) ?? null
      : null;
    const recommendedEntries = recommendationTarget
      ? [createTargetPickerEntry(
        recommendationTarget,
        mode,
        ["recommended", recommendationReport?.recommendation.status ?? "recommended"],
        true,
        true,
      )]
      : [];
    const remainingEntries = recommendationTarget
      ? recentEntries.filter((entry) => entry.targetSessionId !== recommendationTarget.sessionId)
      : recentEntries;
    return [
      { title: "Recommended", entries: recommendedEntries },
      { title: "Recent Sessions", entries: remainingEntries },
    ];
  }

  if (mode === "continue") {
    const primaryTarget = recentEntries.find((entry) => entry.badges.includes("current"))
      ?? recentEntries.find((entry) => entry.badges.includes("recommended"))
      ?? recentEntries[0]
      ?? null;
    const primaryEntries = primaryTarget ? [primaryTarget] : [];
    const remainingEntries = primaryTarget
      ? recentEntries.filter((entry) => entry.targetSessionId !== primaryTarget.targetSessionId)
      : recentEntries;
    return [
      { title: "Continue Now", entries: primaryEntries },
      { title: "Nearby Sessions", entries: remainingEntries },
    ];
  }

  if (mode === "resume_recommend") {
    const recommendationTarget = recommendationReport?.recommendation.recommendedSessionId
      ? browserReport.sessions.find((entry) => entry.sessionId === recommendationReport.recommendation.recommendedSessionId) ?? null
      : null;
    const recommendedEntries = recommendationTarget
      ? [createTargetPickerEntry(
        recommendationTarget,
        mode,
        ["recommended_target", recommendationReport?.recommendation.status ?? "recommended"],
        true,
        true,
      )]
      : [];
    const remainingEntries = recommendationTarget
      ? recentEntries.filter((entry) => entry.targetSessionId !== recommendationTarget.sessionId)
      : recentEntries;
    return [
      { title: "Recommended Target", entries: recommendedEntries },
      { title: "Reference Sessions", entries: remainingEntries },
    ];
  }

  return [{
    title: mode === "history_replay" ? "Replay Targets" : "Session Targets",
    entries: recentEntries,
  }];
}

function createTargetPickerEntry(
  session: SessionContinuitySummary,
  mode: InteractiveSessionPickerMode,
  extraBadges: string[] = [],
  featured = false,
  suggested = false,
): InteractiveSessionPickerEntry {
  const primaryCommand = buildPrimaryTargetCommand(session, mode);
  const badges = [
    session.continuityStatus,
    session.availability.planAvailable ? "plan" : null,
    session.availability.verifierAvailable ? "verifier" : null,
    session.availability.decisionAvailable ? "decision" : null,
    ...extraBadges,
  ].filter((value): value is string => Boolean(value));
  return {
    id: `${mode}:${session.sessionId}`,
    label: session.sessionId,
    description: [
      `${session.provider ?? "unknown"}/${session.model ?? "auto"}`,
      `branch=${session.branchType}`,
      `depth=${session.branchDepth}`,
      `resume=${session.resume.status}`,
      session.finalContentPreview ? `final=${session.finalContentPreview}` : null,
    ].filter(Boolean).join(" · "),
    command: primaryCommand,
    enterBehavior: "continue",
    nextResolverLine: buildActionResolverLine(mode, session.sessionId),
    targetSessionId: session.sessionId,
    continuityStatus: session.continuityStatus,
    badges,
    featured,
    suggested,
    preview: buildTargetPickerPreview(session, primaryCommand, mode, badges),
  };
}

function filterPickerEntries(
  entries: InteractiveSessionPickerEntry[],
  query: string,
): InteractiveSessionPickerEntry[] {
  return entries
    .map((entry) => ({
      entry,
      score: scorePickerEntry(entry, query),
    }))
    .filter(({ score }) => !query || score > 0)
    .sort((left, right) =>
      right.score - left.score
      || Number(right.entry.suggested) - Number(left.entry.suggested)
      || Number(right.entry.featured) - Number(left.entry.featured)
      || left.entry.label.localeCompare(right.entry.label))
    .map(({ entry }) => entry)
    .slice(0, 6);
}

function scorePickerEntry(
  entry: InteractiveSessionPickerEntry,
  query: string,
): number {
  if (!query) {
    return 1;
  }
  const haystacks = [
    entry.label,
    entry.description,
    entry.command,
    ...entry.badges,
  ].map((value) => value.toLowerCase());
  return haystacks.reduce((best, haystack) => Math.max(best, fuzzyPickerScore(query, haystack)), 0);
}

function fuzzyPickerScore(query: string, value: string): number {
  if (!query) {
    return 1;
  }
  if (value.startsWith(query)) {
    return 400 - Math.max(0, value.length - query.length);
  }
  if (value.includes(query)) {
    return 250 - Math.max(0, value.indexOf(query));
  }
  let lastIndex = -1;
  let score = 0;
  for (const char of query) {
    const nextIndex = value.indexOf(char, lastIndex + 1);
    if (nextIndex < 0) {
      return 0;
    }
    score += nextIndex === lastIndex + 1 ? 18 : 6;
    lastIndex = nextIndex;
  }
  return score;
}

function normalizePickerQuery(value: string | null | undefined): string {
  return `${value ?? ""}`.trim().toLowerCase();
}

function resolvePickerPreview(
  sections: InteractiveSessionPickerSection[],
  selectedCommand: string | null,
): InteractiveSelectionPreview | null {
  if (!selectedCommand) {
    return null;
  }
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.command === selectedCommand) {
        return entry.preview;
      }
    }
  }
  return null;
}

function buildUnavailablePickerPreview(
  mode: InteractiveSessionPickerMode,
  query: string,
): InteractiveSelectionPreview {
  return {
    previewKind: mode === "history_replay"
      ? "replay_target"
      : mode === "continue"
        ? "session_target"
      : mode === "resume"
        ? "resume_target"
        : mode === "resume_recommend"
          ? "resume_recommendation"
          : mode === "history_sessions"
            ? "session_target"
            : "lineage_target",
    selectedCommand: null,
    resolvedCommandTemplate: null,
    selectedTargetSummary: "No continuity target matched the current filter.",
    decisionState: "unavailable",
    relationSummary: null,
    availabilitySummary: null,
    continuitySnippet: query ? `filter=${query}` : "type after the slash command to narrow the target list",
    whySelected: query
      ? "The current session filter does not match any recent or recommended target."
      : "The chooser is waiting for a target selection.",
    nextEffect: query
      ? "Broaden the filter or clear part of the line."
      : "Move with ↑↓, then press Enter.",
    available: false,
    unavailableReason: query ? "no_match" : "no_selection",
  };
}

function buildTargetPickerPreview(
  session: SessionContinuitySummary,
  command: string,
  mode: InteractiveSessionPickerMode,
  badges: string[],
): InteractiveSelectionPreview {
  return {
    previewKind: mode === "history_replay"
      ? "replay_target"
      : mode === "continue"
        ? "session_target"
      : mode === "resume"
        ? "resume_target"
        : mode === "resume_recommend"
          ? "resume_recommendation"
          : mode === "history_sessions"
            ? "session_target"
            : "lineage_target",
    selectedCommand: command,
    resolvedCommandTemplate: command,
    selectedTargetSummary: `${session.sessionId} · ${session.provider ?? "unknown"}/${session.model ?? "auto"} · branch=${session.branchType} depth=${session.branchDepth}`,
    decisionState: deriveTargetPreviewDecisionState(session, badges),
    relationSummary: `relation=${session.relationToCurrent}/${session.relationToReference}`,
    availabilitySummary: renderAvailabilitySummary(session),
    continuitySnippet: [
      `relation=${session.relationToCurrent}/${session.relationToReference}`,
      `continuity=${session.continuityStatus}`,
      `plan=${session.availability.planAvailable ? "yes" : "no"}`,
      `verifier=${session.availability.verifierAvailable ? "yes" : "no"}`,
      `decision=${session.availability.decisionAvailable ? "yes" : "no"}`,
      badges.includes("recommended") || badges.includes("recommended_target") ? "recommended=yes" : null,
    ].filter((value): value is string => Boolean(value)).join(" · "),
    whySelected: buildTargetPickerWhySelected(session, mode, badges),
    nextEffect: buildTargetPickerNextEffect(session, mode),
    available: true,
    unavailableReason: null,
  };
}

function buildTargetPickerWhySelected(
  session: SessionContinuitySummary,
  mode: InteractiveSessionPickerMode,
  badges: string[],
): string {
  if (badges.includes("recommended") || badges.includes("recommended_target")) {
    return "Recommended because the continuity is still live enough to continue.";
  }
  if (mode === "history_replay") {
    return session.availability.planAvailable || session.availability.verifierAvailable || session.availability.decisionAvailable
      ? "Replay continuity is strong enough to inspect before branching."
      : "Mostly historical; inspect it before branching.";
  }
  if (mode === "continue") {
    return session.resume.status === "not_needed"
      ? "You are already on this thread, so lineage or replay is a better first move than another resume branch."
      : session.resume.status === "recommended"
        ? "This is the strongest live branch to continue from right now."
        : "This is nearby continuity worth opening before choosing a branch.";
  }
  if (mode === "history_lineage" || mode === "resume_recommend") {
    return "Pick the target first, then choose lineage, replay, or resume.";
  }
  if (session.resume.status === "recommended") {
    return "Resumable and still close to the active continuity path.";
  }
  if (session.continuityStatus === "stale") {
    return "Available, but stale enough that replay should come first.";
  }
  if (session.continuityStatus === "historical_only") {
    return "Mostly historical continuity; inspect before resuming.";
  }
  return "Pick the target first, then choose the next action.";
}

function buildTargetPickerNextEffect(
  session: SessionContinuitySummary,
  mode: InteractiveSessionPickerMode,
): string {
  const sessionId = session.sessionId;
  switch (mode) {
    case "continue":
      return "Enter -> actions: resume or inspect the current best path.";
    case "resume":
      return `Enter -> actions: resume, lineage, replay.`;
    case "resume_recommend":
      return `Enter -> actions: resume, why, replay, lineage.`;
    case "history_sessions":
      return `Enter -> actions: resume, replay, why, plan.`;
    case "history_lineage":
      return `Enter -> actions: lineage, replay, resume.`;
    case "history_replay":
      return `Enter -> actions: replay, why/plan, verifier, resume.`;
    default:
      return `Enter -> actions for ${sessionId}.`;
  }
}

function isActionPickerMode(mode: InteractiveSessionPickerMode): boolean {
  return mode === "continue_actions"
    || mode === "resume_actions"
    || mode === "resume_recommend_actions"
    || mode === "history_sessions_actions"
    || mode === "history_lineage_actions"
    || mode === "history_replay_actions";
}

function buildPrimaryTargetCommand(
  session: SessionContinuitySummary,
  mode: InteractiveSessionPickerMode,
): string {
  if (mode === "continue") {
    return session.resume.status === "not_needed"
      ? `/history lineage ${session.sessionId} summary`
      : `/resume ${session.sessionId}`;
  }
  if (mode === "resume" || mode === "resume_recommend") {
    return `/resume ${session.sessionId}`;
  }
  if (mode === "history_replay" || mode === "history_sessions") {
    return `/history replay ${session.sessionId} summary`;
  }
  return `/history lineage ${session.sessionId} summary`;
}

function buildActionResolverLine(
  mode: InteractiveSessionPickerMode,
  sessionId: string,
): string {
  switch (mode) {
    case "continue":
      return `/continue __actions__ ${sessionId}`;
    case "resume":
      return `/resume __actions__ ${sessionId}`;
    case "resume_recommend":
      return `/resume recommend __actions__ ${sessionId}`;
    case "history_sessions":
      return `/history sessions __actions__ ${sessionId}`;
    case "history_lineage":
      return `/history lineage __actions__ ${sessionId}`;
    case "history_replay":
      return `/history replay __actions__ ${sessionId}`;
    default:
      return `/history sessions __actions__ ${sessionId}`;
  }
}

function resolvePickerAnchorSessionId(
  mode: InteractiveSessionPickerMode,
  browserReport: SessionBrowserReport,
): string | null {
  if (!isActionPickerMode(mode)) {
    return null;
  }
  return browserReport.reference.resolvedSessionId;
}

function resolvePickerAnchorCommand(
  mode: InteractiveSessionPickerMode,
): string | null {
  switch (mode) {
    case "continue_actions":
      return "/continue";
    case "resume_actions":
      return "/resume";
    case "resume_recommend_actions":
      return "/resume recommend";
    case "history_sessions_actions":
      return "/history sessions";
    case "history_lineage_actions":
      return "/history lineage";
    case "history_replay_actions":
      return "/history replay";
    default:
      return null;
  }
}

function buildActionPickerSections(
  mode: InteractiveSessionPickerMode,
  browserReport: SessionBrowserReport,
  recommendationReport: SessionResumeRecommendationReport | null,
): Array<{ title: string; entries: InteractiveSessionPickerEntry[] }> {
  const targetSessionId = browserReport.reference.resolvedSessionId;
  const target = targetSessionId
    ? browserReport.sessions.find((entry) => entry.sessionId === targetSessionId)
      ?? browserReport.lineage?.focus
      ?? null
    : null;
  if (!target) {
    return [];
  }
  const commands = buildActionPickerCommands(mode, target, recommendationReport);
  return [{
    title: `Actions For ${target.sessionId}`,
    entries: commands.map((entry, index) => ({
      id: `${mode}:${target.sessionId}:${index}:${entry.command}`,
      label: entry.label,
      description: entry.description,
      command: entry.command,
      enterBehavior: "inject",
      nextResolverLine: null,
      targetSessionId: target.sessionId,
      continuityStatus: target.continuityStatus,
      badges: index === 0 ? ["primary", ...entry.badges] : entry.badges,
      featured: index === 0,
      suggested: index < 2,
      preview: buildActionPickerPreview(target, entry.command, entry.label, entry.description, mode, entry.badges),
    })),
  }];
}

function buildActionPickerCommands(
  mode: InteractiveSessionPickerMode,
  target: SessionContinuitySummary,
  recommendationReport: SessionResumeRecommendationReport | null,
): Array<{
  label: string;
  description: string;
  command: string;
  badges: string[];
}> {
  const sessionId = target.sessionId;
  const values: Array<{
    label: string;
    description: string;
    command: string;
    badges: string[];
    priority: number;
  }> = [];

  if (mode === "continue_actions") {
    const preferCurrentInspect = target.resume.status === "not_needed" || target.relationToCurrent === "current";
    values.push({
      label: preferCurrentInspect ? "Open lineage" : "Resume now",
      description: preferCurrentInspect
        ? "Stay on this thread and inspect branch position before branching."
        : "Continue from this session as the next working branch.",
      command: preferCurrentInspect
        ? `/history lineage ${sessionId} summary`
        : `/resume ${sessionId}`,
      badges: preferCurrentInspect ? ["lineage"] : ["resume", target.resume.status],
      priority: 100,
    });
    values.push({
      label: "Open replay",
      description: "Inspect replay continuity and latest final output first.",
      command: `/history replay ${sessionId} summary`,
      badges: ["replay"],
      priority: 98,
    });
    if (!preferCurrentInspect) {
      values.push({
        label: "Why this target",
        description: "Inspect why this session is being surfaced as the best continue path.",
        command: `/resume recommend ${sessionId} summary`,
        badges: ["why_recommended"],
        priority: 96,
      });
    }
    if (target.availability.planAvailable) {
      values.push({
        label: "Plan timeline",
        description: "Jump straight into plan continuity for this target.",
        command: `/plan timeline replay:${sessionId} summary`,
        badges: ["plan"],
        priority: 94,
      });
    } else if (target.availability.decisionAvailable) {
      values.push({
        label: "Why plan",
        description: "Explain why this target landed in its present state.",
        command: `/why plan replay:${sessionId} summary`,
        badges: ["why"],
        priority: 92,
      });
    }
  } else if (mode === "resume_actions") {
    values.push({
      label: "Resume now",
      description: "Create a new branch from this session immediately.",
      command: `/resume ${sessionId}`,
      badges: ["resume", target.resume.status],
      priority: 100,
    });
    values.push({
      label: "Inspect lineage",
      description: "Look at ancestors and children before branching.",
      command: `/history lineage ${sessionId} summary`,
      badges: ["lineage"],
      priority: 97,
    });
    values.push({
      label: "Replay first",
      description: "Check replay continuity before branching from it.",
      command: `/history replay ${sessionId} summary`,
      badges: ["replay"],
      priority: 95,
    });
  } else if (mode === "resume_recommend_actions") {
    values.push({
      label: "Resume now",
      description: "Accept the recommendation and continue from this session.",
      command: `/resume ${sessionId}`,
      badges: ["resume", recommendationReport?.recommendation.status ?? "recommended"],
      priority: 100,
    });
    values.push({
      label: "Inspect reason",
      description: "Open the recommendation summary for this target.",
      command: `/resume recommend ${sessionId} summary`,
      badges: ["why_recommended"],
      priority: 98,
    });
    values.push({
      label: "Replay first",
      description: "Inspect replay continuity before resuming it.",
      command: `/history replay ${sessionId} summary`,
      badges: ["replay"],
      priority: 96,
    });
    values.push({
      label: "Inspect lineage",
      description: "Confirm branch position before creating a child branch.",
      command: `/history lineage ${sessionId} summary`,
      badges: ["lineage"],
      priority: 94,
    });
  } else if (mode === "history_sessions_actions") {
    const preferReplayFirst = target.relationToCurrent === "current" || target.resume.status === "not_needed";
    values.push({
      label: preferReplayFirst ? "Replay" : "Resume",
      description: preferReplayFirst
        ? "Inspect replay continuity, changes, and final output."
        : "Continue from this session as a new branch.",
      command: preferReplayFirst
        ? `/history replay ${sessionId} summary`
        : `/resume ${sessionId}`,
      badges: preferReplayFirst ? ["replay"] : ["resume", target.resume.status],
      priority: 100,
    });
    values.push({
      label: preferReplayFirst ? "Resume" : "Replay",
      description: preferReplayFirst
        ? "Continue from this session as a new branch."
        : "Inspect replay continuity, changes, and final output.",
      command: preferReplayFirst
        ? `/resume ${sessionId}`
        : `/history replay ${sessionId} summary`,
      badges: preferReplayFirst ? ["resume", target.resume.status] : ["replay"],
      priority: 98,
    });
    if (target.availability.planAvailable) {
      values.push({
        label: "Plan timeline",
        description: "Jump straight to plan continuity for this session.",
        command: `/plan timeline replay:${sessionId} summary`,
        badges: ["plan"],
        priority: 96,
      });
    }
    if (target.availability.decisionAvailable) {
      values.push({
        label: "Why plan",
        description: "Explain the current blocker or replan reason.",
        command: `/why plan replay:${sessionId} summary`,
        badges: ["why"],
        priority: 94,
      });
    }
  } else if (mode === "history_lineage_actions") {
    values.push({
      label: "Open lineage",
      description: "Inspect ancestors and children for this session.",
      command: `/history lineage ${sessionId} summary`,
      badges: ["lineage"],
      priority: 100,
    });
    values.push({
      label: "Replay",
      description: "Inspect replay continuity before branching.",
      command: `/history replay ${sessionId} summary`,
      badges: ["replay"],
      priority: 97,
    });
    values.push({
      label: "Resume",
      description: "Continue from this session as a new branch.",
      command: `/resume ${sessionId}`,
      badges: ["resume", target.resume.status],
      priority: 95,
    });
  } else if (mode === "history_replay_actions") {
    values.push({
      label: "Open replay",
      description: "Inspect replay continuity and final output.",
      command: `/history replay ${sessionId} summary`,
      badges: ["replay"],
      priority: 100,
    });
    if (target.availability.planAvailable) {
      values.push({
        label: "Plan timeline",
        description: "Jump to plan continuity for this replay target.",
        command: `/plan timeline replay:${sessionId} summary`,
        badges: ["plan"],
        priority: 98,
      });
    }
    if (target.availability.decisionAvailable) {
      values.push({
        label: "Why plan",
        description: "Explain why this replay target ended in its current state.",
        command: `/why plan replay:${sessionId} summary`,
        badges: ["why"],
        priority: 96,
      });
    }
    if (target.availability.verifierAvailable) {
      values.push({
        label: "Verifier failures",
        description: "Inspect verifier continuity before resuming.",
        command: `/verifier replay ${sessionId} failures`,
        badges: ["verifier"],
        priority: 94,
      });
    }
    values.push({
      label: "Resume",
      description: "Continue from this session as a new branch.",
      command: `/resume ${sessionId}`,
      badges: ["resume", target.resume.status],
      priority: 92,
    });
  }

  return values
    .sort((left, right) => right.priority - left.priority || left.command.localeCompare(right.command))
    .slice(0, 4)
    .map(({ priority: _priority, ...rest }) => rest);
}

function buildActionPickerPreview(
  session: SessionContinuitySummary,
  command: string,
  label: string,
  description: string,
  mode: InteractiveSessionPickerMode,
  badges: string[],
): InteractiveSelectionPreview {
  return {
    previewKind: resolveActionPreviewKind(mode),
    selectedCommand: command,
    resolvedCommandTemplate: command,
    selectedTargetSummary: `${label} · ${session.sessionId}`,
    decisionState: badges.includes("resume") && session.resume.status === "recommended"
      ? "recommended"
      : badges.includes("verifier")
        ? "risky"
        : "suggested",
    relationSummary: `relation=${session.relationToCurrent}/${session.relationToReference}`,
    availabilitySummary: renderAvailabilitySummary(session),
    continuitySnippet: [
      `target=${session.sessionId}`,
      `continuity=${session.continuityStatus}`,
      session.latest.planStatus ? `plan=${session.latest.planStatus}` : null,
      session.latest.verifierStatus ? `verifier=${session.latest.verifierStatus}` : null,
      session.latest.repairStatus ? `repair=${session.latest.repairStatus}` : null,
    ].filter((value): value is string => Boolean(value)).join(" · "),
    whySelected: description,
    nextEffect: `Enter -> ${command}`,
    available: true,
    unavailableReason: null,
  };
}

function deriveTargetPreviewDecisionState(
  session: SessionContinuitySummary,
  badges: string[],
): InteractiveSelectionPreview["decisionState"] {
  if (badges.includes("recommended") || badges.includes("recommended_target") || session.resume.status === "recommended") {
    return "recommended";
  }
  if (session.continuityStatus === "stale") {
    return "stale";
  }
  if (session.continuityStatus === "historical_only") {
    return "risky";
  }
  if (session.resume.status === "discouraged") {
    return "risky";
  }
  return "suggested";
}

function renderAvailabilitySummary(session: SessionContinuitySummary): string {
  const parts = [
    session.availability.planAvailable ? "plan" : null,
    session.availability.verifierAvailable ? "verifier" : null,
    session.availability.decisionAvailable ? "why" : null,
    session.availability.replayAvailable ? "replay" : null,
  ].filter((value): value is string => Boolean(value));
  if (parts.length === 0) {
    return "none";
  }
  if (parts.length === 1 && parts[0] === "replay") {
    return "replay ready";
  }
  return parts.join(" + ");
}

function resolveActionPreviewKind(mode: InteractiveSessionPickerMode): InteractiveSelectionPreview["previewKind"] {
  switch (mode) {
    case "continue_actions":
    case "resume_actions":
      return "resume_action";
    case "resume_recommend_actions":
    case "history_sessions_actions":
      return "session_action";
    case "history_lineage_actions":
      return "lineage_action";
    case "history_replay_actions":
      return "replay_action";
    default:
      return "session_action";
  }
}

function renderPickerTitle(mode: InteractiveSessionPickerMode): string {
  switch (mode) {
    case "continue":
      return "Continue Browser";
    case "continue_actions":
      return "Continue Actions";
    case "resume":
      return "Resume Picker";
    case "resume_actions":
      return "Resume Action Picker";
    case "resume_recommend":
      return "Resume Recommendation Picker";
    case "resume_recommend_actions":
      return "Recommendation Action Picker";
    case "history_sessions_actions":
      return "Session Action Picker";
    case "history_replay":
      return "Replay Chooser";
    case "history_replay_actions":
      return "Replay Action Picker";
    case "history_lineage":
      return "Lineage Picker";
    case "history_lineage_actions":
      return "Lineage Action Picker";
    case "history_sessions":
      return "Session Browser Picker";
  }
}

function renderPickerSubtitle(
  mode: InteractiveSessionPickerMode,
  browserReport: SessionBrowserReport,
  recommendationReport: SessionResumeRecommendationReport | null,
  sections: InteractiveSessionPickerSection[],
): string | null {
  if (mode === "continue") {
    return recommendationReport?.recommendation.recommendedSessionId
      ? "current or recommended target"
      : "pick the best next session path";
  }
  if (mode === "resume" && recommendationReport?.recommendation.recommendedSessionId) {
    return `recommended=${recommendationReport.recommendation.recommendedSessionId}`;
  }
  if (mode === "resume_recommend") {
    return `sessions=${browserReport.summary.sessionCount} recommended=${browserReport.summary.recommendedResumeSessionId ?? "none"}`;
  }
  if (isActionPickerMode(mode)) {
    const anchorSessionId = resolvePickerAnchorSessionId(mode, browserReport);
    const actionCount = sections.reduce((count, section) => count + section.entries.length, 0);
    return `target=${anchorSessionId ?? "none"} actions=${actionCount}`;
  }
  return `sessions=${browserReport.summary.sessionCount} focus=${browserReport.reference.resolvedSessionId ?? "none"}`;
}
