import {
  getAgentBrandProfile,
  renderAgentAboutCard,
} from "./agent-branding.mjs";
import { getInteractiveCommandPalette } from "./command-catalog.mjs";
import {
  renderCompactDialogDivider,
  renderCompactDialogPanel,
  truncateText,
  visibleTextLength,
} from "./interactive-shell-panel.mjs";
import { createAnsi } from "./ansi.mjs";

import type {
  AgentInteractionHistoryReport,
  AgentInteractionHistoryScope,
  AgentInteractionStatusReport,
  ContextPlanMeta,
  InteractionRenderProfile,
  InteractiveCommandPaletteReport,
  InteractiveSelectionPreview,
  InteractiveSessionPickerReport,
  RollbackCheckpointListEntry,
  SessionBrowserReport,
  SessionIndexEntry,
  SessionResumeRecommendationReport,
} from "../types/contracts.js";

export function buildAgentInteractionStatusReport(
  status: unknown,
  options: {
    lineage?: SessionBrowserReport | null;
    recommendation?: SessionResumeRecommendationReport | null;
  } = {},
): AgentInteractionStatusReport {
  const value = asRecord(status);
  const usage = asRecord(value?.usage);
  const context = asContextPlanMeta(value?.context);
  const executionPlan = asRecord(value?.executionPlan);
  const lastVerifierRun = asRecord(value?.lastVerifierRun);
  const lastRepairLoop = asRecord(value?.lastRepairLoop);
  const runtimeHealth = asRecord(value?.runtimeHealth);
  const scorecard = asRecord(runtimeHealth?.scorecard);
  const provider = asRecord(scorecard?.provider);
  const circuits = asRecord(scorecard?.circuits);

  return {
    brand: getAgentBrandProfile(),
    createdAt: new Date().toISOString(),
    session: {
      active: typeof value?.sessionId === "string" && value.sessionId.length > 0,
      sessionId: toNullableString(value?.sessionId),
      parentSessionId: toNullableString(value?.parentSessionId),
      sessionFilePath: toNullableString(value?.sessionFilePath),
      resumeSnapshotPath: toNullableString(value?.resumeSnapshotPath),
    },
    model: {
      provider: toNullableString(value?.provider),
      model: toNullableString(value?.model),
      streamOutput: value?.streamOutput === true,
      nativeToolCalling: value?.nativeToolCalling === true,
      permissionMode: toNullableString(value?.permissionMode),
      approvalPolicy: toNullableString(value?.approvalPolicy),
      networkMode: toNullableString(value?.networkMode),
    },
    usage: {
      calls: toNumber(usage?.calls),
      promptTokens: toNumber(usage?.promptTokens),
      completionTokens: toNumber(usage?.completionTokens),
      totalTokens: toNumber(usage?.totalTokens),
    },
    context: {
      available: Boolean(context),
      model: context?.model ?? null,
      contextWindow: context?.contextWindow ?? null,
      estimatedInputTokens: context?.estimatedInputTokens ?? null,
      inputBudget: context?.budgets.totalInputBudget ?? null,
      remainingInputTokens: context
        ? Math.max(0, context.budgets.totalInputBudget - context.estimatedInputTokens)
        : null,
      outputReserve: context?.outputReserve ?? null,
      compactedMessages: context?.compactedMessages ?? null,
      memoryItems: context?.memoryItems ?? null,
      contextSlicingMode: context?.contextSlicingMode ?? null,
      memoryArbitration: context?.memoryArbitration ?? null,
    },
    plan: {
      available: Boolean(executionPlan),
      status: toNullableString(executionPlan?.status),
      currentStepTitle: findCurrentStepTitle(executionPlan),
      replanCount: countPlanEvents(executionPlan, "replanned"),
      blockerCount: Array.isArray(executionPlan?.failedSteps) ? executionPlan.failedSteps.length : null,
      verificationRequired: hasVerificationStep(executionPlan),
    },
    verifier: {
      available: Boolean(lastVerifierRun || lastRepairLoop),
      latestStatus: toNullableString(asRecord(lastVerifierRun?.summary)?.status),
      repairStatus: toNullableString(asRecord(lastRepairLoop?.summary)?.status),
      finalOutcome: toNullableString(asRecord(asRecord(value?.lastTrace)?.verifier)?.status),
    },
    runtime: {
      providerHealthScore: typeof provider?.avgHealthScore === "number"
        ? provider.avgHealthScore
        : typeof provider?.healthScore === "number"
          ? provider.healthScore
          : null,
      degradedFlags: toStringArray(scorecard?.degradedFlags),
      openCircuitCount: typeof circuits?.open === "number" ? circuits.open : null,
    },
    continuity: {
      available: Boolean(options.lineage?.lineage?.focus),
      focusSessionId: options.lineage?.lineage?.focus?.sessionId ?? toNullableString(value?.sessionId),
      rootSessionId: options.lineage?.lineage?.rootSessionId ?? null,
      branchDepth: options.lineage?.lineage?.branchDepth ?? null,
      continuityStatus: options.lineage?.lineage?.focus?.continuityStatus ?? null,
      recommendedResumeSessionId: options.recommendation?.recommendation.recommendedSessionId
        ?? options.lineage?.summary.recommendedResumeSessionId
        ?? null,
      replayAvailable: options.lineage?.lineage?.focus?.availability.replayAvailable ?? false,
    },
    drilldown: {
      primary: executionPlan
        ? "/why plan current summary"
        : options.lineage?.lineage?.focus?.sessionId
          ? `/history replay ${options.lineage.lineage.focus.sessionId} summary`
          : "/history sessions summary",
      whyPlan: executionPlan ? "/why plan current summary" : null,
      replay: options.lineage?.lineage?.focus?.availability.replayAvailable
        ? `/history replay ${options.lineage.lineage.focus?.sessionId ?? "latest"} summary`
        : null,
      verifier: Boolean(lastVerifierRun || lastRepairLoop)
        ? "/verifier trace failures"
        : null,
    },
    suggestedCommands: compactStrings([
      executionPlan ? "/why plan current summary" : "/route <task>",
      lastRepairLoop ? "/recover current summary" : "/next current summary",
      options.lineage?.lineage?.focus?.availability.replayAvailable
        ? `/history replay ${options.lineage.lineage.focus.sessionId} summary`
        : typeof value?.sessionId === "string" && value.sessionId.length > 0
          ? "/history lineage current summary"
          : "/history sessions summary",
      options.recommendation?.recommendation.recommendedSessionId
        ? `/resume ${options.recommendation.recommendation.recommendedSessionId}`
        : "/about",
    ]).slice(0, 4),
  };
}

export function renderAgentInteractionStatusReport(
  report: AgentInteractionStatusReport,
  profile: InteractionRenderProfile = "summary",
): string {
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  const primary = report.suggestedCommands[0] ?? "none";
  const then = report.suggestedCommands.slice(1, 3);
  const recommendedResume = report.continuity.recommendedResumeSessionId
    ? renderCompactSessionRef(report.continuity.recommendedResumeSessionId)
    : "none";
  return [
    "Status",
    `Now: session=${report.session.sessionId ? renderCompactSessionRef(report.session.sessionId) : "inspect-only"} · continuity=${report.continuity.continuityStatus ?? "unavailable"} · context=${report.context.available ? `${report.context.remainingInputTokens ?? 0}/${report.context.inputBudget ?? 0}` : "unavailable"}`,
    `Work: ${renderStatusBlocker(report)} · verifier=${report.verifier.latestStatus ?? report.verifier.finalOutcome ?? "none"} · runtime=${renderStatusRuntime(report)}`,
    `Continuity: recommended=${recommendedResume} · replay=${report.continuity.replayAvailable ? "yes" : "no"} · drilldown=${report.drilldown.primary ?? "none"}`,
    `Mode: ${report.model.provider ?? "none"}/${report.model.model ?? "auto"} · approval=${report.model.approvalPolicy ?? "unknown"} · net=${report.model.networkMode ?? "unknown"} · tokens=${report.usage.totalTokens}`,
    `Next: ${primary}`,
    then.length > 0 ? `Then: ${then.join(" · ")}` : null,
  ].filter(Boolean).join("\n");
}

export function buildAgentInteractionHistoryReport(input: {
  scope: AgentInteractionHistoryScope;
  changes?: unknown;
  sessions?: unknown;
}): AgentInteractionHistoryReport {
  const changes = normalizeChangeHistory(input.changes);
  const sessions = normalizeSessionHistory(input.sessions);
  return {
    brand: getAgentBrandProfile(),
    createdAt: new Date().toISOString(),
    scope: input.scope,
    changes,
    sessions,
    summary: {
      changeCount: changes.length,
      sessionCount: sessions.length,
      latestChangeId: changes[0]?.id ?? null,
      latestSessionId: sessions[0]?.id ?? null,
    },
    suggestedCommands: compactStrings([
      sessions[0]?.id ? `/resume ${sessions[0].id}` : null,
      changes[0]?.id ? `/undo ${changes[0].id}` : null,
      sessions[0]?.id ? `/replay ${sessions[0].id}` : null,
      "/status summary",
    ]).slice(0, 4),
  };
}

export function renderAgentInteractionHistoryReport(
  report: AgentInteractionHistoryReport,
  profile: InteractionRenderProfile = "summary",
): string {
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  const lines = [
    `History · ${report.scope}`,
    `Now: latestSession=${report.summary.latestSessionId ?? "none"} latestChange=${report.summary.latestChangeId ?? "none"}`,
    `Continue: sessions=${report.summary.sessionCount} changes=${report.summary.changeCount}`,
  ];
  if (report.sessions.length > 0) {
    lines.push("Sessions:");
    for (const session of report.sessions.slice(0, 5)) {
      lines.push(`- ${session.id} ${session.provider ?? "unknown"}/${session.model ?? "auto"} branch=${session.branchType} depth=${session.branchDepth}`);
    }
  }
  if (report.changes.length > 0) {
    lines.push("Changes:");
    for (const change of report.changes.slice(0, 5)) {
      lines.push(`- ${change.id} status=${change.status} tool=${change.toolName} files=${change.touchedFiles.length}`);
    }
  }
  lines.push("Next:");
  for (const command of report.suggestedCommands.slice(0, 3)) {
    lines.push(`- ${command}`);
  }
  return lines.join("\n");
}

export function renderInteractiveCommandPalette(
  report: InteractiveCommandPaletteReport = getInteractiveCommandPalette(),
  options: {
    mode?: "text" | "overlay";
    selectedCommand?: string | null;
  } = {},
): string {
  const mode = options.mode ?? "text";
  const selectedCommand = options.selectedCommand ?? report.selectedCommand;
  if (mode === "overlay") {
    return renderInteractiveCommandPaletteOverlay(report, selectedCommand);
  }
  return renderInteractiveCommandPaletteFallback(report, selectedCommand);
}

export function renderInteractiveSessionPicker(
  report: InteractiveSessionPickerReport,
  options: {
    mode?: "text" | "overlay";
    selectedCommand?: string | null;
  } = {},
): string {
  const mode = options.mode ?? "overlay";
  const selectedCommand = options.selectedCommand ?? report.selectedCommand;
  if (mode === "overlay") {
    return renderInteractiveSessionPickerOverlay(report, selectedCommand);
  }
  const lines = [
    report.title,
  ];
  lines.push(report.brand.attributionSummary);
  if (report.subtitle) {
    lines.push(report.subtitle);
  }
  if (report.query) {
    lines.push(`Filter: ${report.query} · matches=${report.totalMatches}`);
  }
  for (const section of report.sections) {
    lines.push(`${section.title}:`);
    for (const entry of section.entries) {
      const prefix = selectedCommand === entry.command ? ">" : "-";
      const badgeText = entry.badges.length > 0 ? ` [${entry.badges.join(", ")}]` : "";
      lines.push(`${prefix} ${entry.label}${badgeText}`);
      lines.push(`  ${entry.command}`);
      lines.push(`  ${entry.description}`);
    }
  }
  if (report.sections.length === 0) {
    lines.push("No session target matched this filter.");
  }
  appendSelectionPreview(lines, report.selectedPreview);
  if (report.step === "action" && report.anchorSessionId) {
    lines.push(`Action target: ${report.anchorSessionId}`);
  }
  lines.push("Hints:");
  for (const hint of report.footerHints.slice(0, 2)) {
    lines.push(`- ${hint}`);
  }
  return lines.join("\n");
}

export function renderAgentAbout(
  profile: InteractionRenderProfile = "summary",
): string {
  if (profile === "json") {
    return JSON.stringify(getAgentBrandProfile(), null, 2);
  }
  return renderAgentAboutCard();
}

function normalizeChangeHistory(value: unknown): RollbackCheckpointListEntry[] {
  return Array.isArray(value)
    ? value
      .map((entry) => asRollbackCheckpointListEntry(entry))
      .filter((entry): entry is RollbackCheckpointListEntry => Boolean(entry))
    : [];
}

function normalizeSessionHistory(value: unknown): SessionIndexEntry[] {
  return Array.isArray(value)
    ? value
      .map((entry) => asSessionIndexEntry(entry))
      .filter((entry): entry is SessionIndexEntry => Boolean(entry))
    : [];
}

function asRollbackCheckpointListEntry(value: unknown): RollbackCheckpointListEntry | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") {
    return null;
  }
  return {
    id: record.id,
    createdAt: toNullableString(record.createdAt) ?? new Date(0).toISOString(),
    status: normalizeRollbackCheckpointStatus(record.status),
    origin: toNullableString(record.origin) ?? "unknown",
    toolName: toNullableString(record.toolName) ?? "unknown",
    risk: null,
    sessionId: toNullableString(record.sessionId),
    traceId: toNullableString(record.traceId),
    restorePointId: toNullableString(record.restorePointId),
    touchedFiles: toStringArray(record.touchedFiles),
  };
}

function normalizeRollbackCheckpointStatus(
  value: unknown,
): RollbackCheckpointListEntry["status"] {
  return value === "checkpointed"
    || value === "applied"
    || value === "apply_failed"
    || value === "apply_partial_failure"
    || value === "rolled_back"
    || value === "rollback_partial_failure"
    ? value
    : "applied";
}

function asSessionIndexEntry(value: unknown): SessionIndexEntry | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") {
    return null;
  }
  return {
    id: record.id,
    filePath: toNullableString(record.filePath) ?? "",
    eventCount: toNumber(record.eventCount),
    startedAt: toNullableString(record.startedAt),
    lastUpdatedAt: toNullableString(record.lastUpdatedAt),
    provider: toNullableString(record.provider),
    model: toNullableString(record.model),
    cwd: toNullableString(record.cwd),
    networkMode: toNullableString(record.networkMode),
    webProvider: toNullableString(record.webProvider),
    finalContent: toNullableString(record.finalContent),
    parentSessionId: toNullableString(record.parentSessionId),
    branchType: toNullableString(record.branchType) ?? "root",
    resumedAt: toNullableString(record.resumedAt),
    resumedFromSnapshot: toNullableString(record.resumedFromSnapshot),
    children: toStringArray(record.children),
    branchDepth: toNumber(record.branchDepth),
    rootSessionId: toNullableString(record.rootSessionId) ?? record.id,
  };
}

function asContextPlanMeta(value: unknown): ContextPlanMeta | null {
  const record = asRecord(value);
  if (!record || typeof record.model !== "string" || typeof record.contextWindow !== "number") {
    return null;
  }
  const budgets = asRecord(record.budgets);
  return {
    model: record.model,
    contextWindow: record.contextWindow,
    outputReserve: toNumber(record.outputReserve),
    budgets: {
      totalInputBudget: toNumber(budgets?.totalInputBudget),
      system: toNumber(budgets?.system),
      summary: toNumber(budgets?.summary),
      memory: toNumber(budgets?.memory),
      recentMessages: toNumber(budgets?.recentMessages),
      currentMessageTokens: toNumber(budgets?.currentMessageTokens),
    },
    estimatedInputTokens: toNumber(record.estimatedInputTokens),
    compactedMessages: toNumber(record.compactedMessages),
    rollingSummaryTokens: toNumber(record.rollingSummaryTokens),
    memoryItems: toNumber(record.memoryItems),
    memoryTokens: toNumber(record.memoryTokens),
    selectedContextKinds: toStringArray(record.selectedContextKinds),
    skippedContextKinds: toStringArray(record.skippedContextKinds),
    selectedSourceIds: toStringArray(record.selectedSourceIds),
    selectedSkillIds: toStringArray(record.selectedSkillIds),
    selectedMemoryIds: toStringArray(record.selectedMemoryIds),
    policySources: toStringArray(record.policySources),
    instructionEntryIds: toStringArray(record.instructionEntryIds),
    instructionLayers: toStringArray(record.instructionLayers) as ContextPlanMeta["instructionLayers"],
    instructionFiles: toStringArray(record.instructionFiles),
    instructionRuleIds: toStringArray(record.instructionRuleIds),
    instructionSummary: {
      entryCount: toNumber(asRecord(record.instructionSummary)?.entryCount),
      ruleCount: toNumber(asRecord(record.instructionSummary)?.ruleCount),
      layers: toStringArray(asRecord(record.instructionSummary)?.layers) as ContextPlanMeta["instructionSummary"]["layers"],
      files: toStringArray(asRecord(record.instructionSummary)?.files),
    },
    contextSlicingMode: toNullableString(record.contextSlicingMode) ?? "balanced",
    memoryArbitration: toNullableString(record.memoryArbitration) ?? "memory-balanced",
    routingMode: toNullableString(record.routingMode),
  };
}

function findCurrentStepTitle(executionPlan: Record<string, unknown> | null): string | null {
  const steps = Array.isArray(executionPlan?.steps) ? executionPlan.steps : [];
  for (const step of steps) {
    const record = asRecord(step);
    if (record?.status === "in_progress") {
      return toNullableString(record.title) ?? toNullableString(record.type);
    }
  }
  return null;
}

function hasVerificationStep(executionPlan: Record<string, unknown> | null): boolean | null {
  if (!executionPlan) {
    return null;
  }
  const steps = Array.isArray(executionPlan.steps) ? executionPlan.steps : [];
  return steps.some((step) => asRecord(step)?.type === "verify");
}

function countPlanEvents(executionPlan: Record<string, unknown> | null, kind: string): number | null {
  if (!executionPlan) {
    return null;
  }
  const events = Array.isArray(executionPlan.events) ? executionPlan.events : [];
  return events.filter((event) => asRecord(event)?.kind === kind).length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value
    : null;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function renderInteractiveCommandPaletteOverlay(
  report: InteractiveCommandPaletteReport,
  selectedCommand: string | null,
): string {
  const ansi = createAnsi(true);
  const allEntries = flattenPaletteEntries(report);
  if (report.query && allEntries.length === 0) {
    return renderLauncherNoMatchPanel(report, "overlay");
  }
  const entries = report.query
    ? buildVisibleEntryWindow(allEntries, selectedCommand, 5)
    : buildLauncherSpotlightEntries(report, selectedCommand);
  const rows = entries.length > 0
    ? entries.map((entry) => renderCompactLauncherRow(
      selectedCommand === entry.command ? "◆" : "·",
      entry.label,
      entry.description,
      report.query ? 40 : 34,
    ))
    : ["  no command matches"];
  if (!report.query) {
    const secondary = renderLauncherSecondaryStrip(report, entries);
    if (secondary) {
      rows.push(ansi.dim(secondary));
    }
  }
  const preview = buildCompactDialogPreview(report.selectedPreview, { minimal: !report.query });
  const titleText = report.query
    ? `${ansi.bold(ansi.brightCyan("◆"))} ${ansi.dim("Launcher")} ${ansi.brightCyan("·")} ${ansi.dim("search")}`
    : `${ansi.bold(ansi.brightCyan("◆"))} ${ansi.dim("Launcher")} ${ansi.brightCyan("·")} ${ansi.dim("start")}`;
  return renderCompactDialogPanel({
    title: titleText,
    stateLabel: `  ${ansi.dim("mode · quick actions")}`,
    meta: report.query
      ? `${ansi.dim("query")} ${ansi.brightCyan(`/${report.query}`)} ${ansi.dim("·")} ${ansi.dim(`${report.totalMatches} match${report.totalMatches === 1 ? "" : "es"}`)}`
      : `${ansi.dim("start with")} ${ansi.brightCyan("/continue")} ${ansi.dim("·")} ${ansi.brightCyan("/status")} ${ansi.dim("·")} ${ansi.brightCyan("/effort")}`,
    rows,
    preview,
    previewLabel: report.query ? "selected" : "default",
    footerHint: report.query
      ? `${ansi.dim("keep typing to refine · esc clears")}`
      : `${ansi.dim("type to filter · ↵ inserts the selected command")}`,
    footer: report.query
      ? `${ansi.brightCyan("↑↓")} ${ansi.dim("move")} ${ansi.brightCyan("↵")} ${ansi.dim("insert")} ${ansi.brightCyan("esc")} ${ansi.dim("close")}`
      : `${ansi.dim("filter ·")} ${ansi.brightCyan("↵")} ${ansi.dim("insert ·")} ${ansi.brightCyan("esc")} ${ansi.dim("close")}`,
  });
}

function renderInteractiveCommandPaletteFallback(
  report: InteractiveCommandPaletteReport,
  selectedCommand: string | null,
): string {
  const allEntries = flattenPaletteEntries(report);
  if (report.query && allEntries.length === 0) {
    return renderLauncherNoMatchPanel(report, "text");
  }
  const entries = report.query
    ? allEntries
    : buildLauncherSpotlightEntries(report, selectedCommand);
  const rows: string[] = [];
  for (const entry of entries.slice(0, report.query ? 6 : 3)) {
    const prefix = selectedCommand === entry.command ? "◆" : "·";
    rows.push(renderCompactLauncherRow(prefix, entry.label, entry.description));
  }
  if (!report.query) {
    const secondary = renderLauncherSecondaryStrip(report, entries);
    if (secondary) {
      rows.push(secondary);
    }
  }
  if (entries.length === 0) {
    rows.push("  no command matches");
  }
  return renderCompactDialogPanel({
    title: report.query ? "Launcher · search" : "Launcher · start",
    stateLabel: "  mode · quick actions",
    meta: report.query
      ? `query /${report.query} · ${report.totalMatches} match${report.totalMatches === 1 ? "" : "es"}`
      : "start with /continue, /status, or /history",
    rows,
    preview: buildCompactDialogPreview(report.selectedPreview, {
      showWhy: false,
      showContinuity: false,
      minimal: true,
    }),
    previewLabel: report.query ? "selected" : "default",
    footerHint: report.query
      ? "refine the filter or jump to /continue"
      : "more → /help · /help advanced · /help debug",
    footer: report.query
      ? "refine · /continue · /help"
      : "open /continue · /status · /help",
  });
}

function renderInteractiveSessionPickerOverlay(
  report: InteractiveSessionPickerReport,
  selectedCommand: string | null,
): string {
  const ansi = createAnsi(true);
  const entries = buildVisibleEntryWindow(flattenPickerEntries(report), selectedCommand, 4);
  const rows = buildInteractiveSessionPickerRows(report, entries, selectedCommand);
  const preview = buildCompactDialogPreview(report.selectedPreview, {
    minimal: false,
    showWhy: report.step === "action" || Boolean(report.query),
    showContinuity: true,
  });
  const stepLabel = report.step === "action"
    ? `${ansi.dim("step 2 ·")} ${ansi.brightCyan("action chooser")}`
    : `${ansi.dim("step 1 ·")} ${ansi.brightCyan("target chooser")}`;
  const metaText = report.query
    ? `${ansi.dim("filter")} ${ansi.brightCyan(`/${report.query}`)} ${ansi.dim("·")} ${ansi.dim(`${report.totalMatches} match${report.totalMatches === 1 ? "" : "es"}`)}`
    : report.step === "action"
      ? `${ansi.dim(`target=${report.anchorSessionId ?? "none"} actions=${report.totalMatches}`)}`
      : `${ansi.dim(`targets=${report.totalMatches}`)} ${ansi.dim("·")} ${ansi.dim("enter opens actions")}`;
  return renderCompactDialogPanel({
    title: `${ansi.bold(ansi.brightCyan("◆"))} ${report.title}`,
    stateLabel: `  ${stepLabel}`,
    meta: report.subtitle ? `${ansi.dim(report.subtitle)}` : metaText,
    rows,
    preview,
    previewLabel: report.step === "action" ? "next action" : "selected target",
    footerHint: report.step === "action"
      ? `${ansi.dim("↵ marks the default path · ◆ tracks your current selection")}`
      : `${ansi.dim("pick a target first, then open its session-specific actions")}`,
    footer: report.step === "action"
      ? `${ansi.brightCyan("↑↓")} ${ansi.dim("move ·")} ${ansi.brightCyan("↵")} ${ansi.dim("primary ·")} ${ansi.brightCyan("esc")} ${ansi.dim("back")}`
      : `${ansi.brightCyan("↑↓")} ${ansi.dim("move ·")} ${ansi.brightCyan("↵")} ${ansi.dim("actions ·")} ${ansi.brightCyan("esc")} ${ansi.dim("close")}`,
  });
}

function buildInteractiveSessionPickerRows(
  report: InteractiveSessionPickerReport,
  entries: Array<{
    label: string;
    description: string;
    command: string;
    targetSessionId: string | null;
    badges: string[];
  }>,
  selectedCommand: string | null,
): string[] {
  const rows: string[] = [];
  if (report.step === "action") {
    rows.push(`  target · ${truncateText(report.anchorSessionId ?? "current", 46)}`);
    rows.push(renderCompactDialogDivider("actions"));
  } else if (report.subtitle) {
    rows.push(`  ${truncateText(report.subtitle, 52)}`);
    rows.push(renderCompactDialogDivider("targets"));
  }
  if (entries.length === 0) {
    rows.push("  no target matches");
    return rows;
  }
  rows.push(...entries.map((entry, index) => renderCompactLauncherRow(
    resolveInteractiveSessionPickerPrefix(report, entry.command, selectedCommand, index),
    entry.label,
    compactPickerDescription(entry),
    36,
  )));
  return rows;
}

function resolveInteractiveSessionPickerPrefix(
  report: InteractiveSessionPickerReport,
  command: string,
  selectedCommand: string | null,
  index: number,
): string {
  if (selectedCommand === command) {
    return "◆";
  }
  if (report.step === "action" && index === 0) {
    return "↵";
  }
  return "·";
}

function buildCompactPanelHeader(title: string, meta: string | null): string[] {
  const lines = [title];
  if (meta) {
    lines.push(`  ${truncateText(meta, 74)}`);
  }
  return lines;
}

function flattenPaletteEntries(report: InteractiveCommandPaletteReport): Array<{
  label: string;
  description: string;
  command: string;
}> {
  return report.sections.flatMap((section) =>
    section.entries.map((entry) => ({
      label: entry.label,
      description: entry.description,
      command: entry.command,
    })));
}

function flattenPickerEntries(report: InteractiveSessionPickerReport): Array<{
  label: string;
  description: string;
  command: string;
  targetSessionId: string | null;
  badges: string[];
}> {
  return report.sections.flatMap((section) =>
    section.entries.map((entry) => ({
      label: entry.label,
      description: entry.description,
      command: entry.command,
      targetSessionId: entry.targetSessionId,
      badges: entry.badges,
    })));
}

function buildLauncherSpotlightEntries(
  report: InteractiveCommandPaletteReport,
  selectedCommand: string | null,
): Array<{
  label: string;
  description: string;
  command: string;
}> {
  const entries = flattenPaletteEntries(report);
  const commandMap = new Map(entries.map((entry) => [entry.command, entry]));
  const preferred = [
    "/continue",
    "/status summary",
    "/history sessions",
    "/resume",
    "/why overview current summary",
    "/plan current summary",
    "/help",
  ]
    .map((command) => commandMap.get(command))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const ordered: Array<(typeof preferred)[number]> = [];
  const seen = new Set<string>();
  const pushEntry = (entry: (typeof preferred)[number] | null | undefined) => {
    if (!entry || seen.has(entry.command)) {
      return;
    }
    seen.add(entry.command);
    ordered.push(entry);
  };
  for (const entry of preferred) {
    pushEntry(entry);
  }
  pushEntry(selectedCommand ? commandMap.get(selectedCommand) : null);
  for (const entry of entries) {
    pushEntry(entry);
    if (ordered.length >= 7) {
      break;
    }
  }
  return buildVisibleEntryWindow(ordered, selectedCommand, 5);
}

function buildVisibleEntryWindow<Entry extends { command: string }>(
  entries: Entry[],
  selectedCommand: string | null,
  maxVisible: number,
): Entry[] {
  if (entries.length <= maxVisible) {
    return entries;
  }
  const selectedIndex = selectedCommand
    ? entries.findIndex((entry) => entry.command === selectedCommand)
    : 0;
  const anchorIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const start = Math.max(0, Math.min(anchorIndex - 1, entries.length - maxVisible));
  return entries.slice(start, start + maxVisible);
}

function renderLauncherSecondaryStrip(
  report: InteractiveCommandPaletteReport,
  visibleEntries: Array<{ label: string; command: string }>,
): string | null {
  const entries = flattenPaletteEntries(report);
  const visibleCommands = new Set(visibleEntries.map((entry) => entry.command));
  const secondaryLabels = [
    "/resume recommend",
    "/history lineage",
    "/why overview current summary",
    "/plan current summary",
    "/help",
  ]
    .map((command) => entries.find((entry) => entry.command === command))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .filter((entry) => !visibleCommands.has(entry.command))
    .slice(0, 3)
    .map((entry) => entry.label);
  return secondaryLabels.length > 0
    ? `  more: ${secondaryLabels.join(" · ")}`
    : null;
}

function renderCompactLauncherRow(
  prefix: string,
  label: string,
  description: string,
  descriptionWidth = 52,
): string {
  const ansi = createAnsi(true);
  const isSelected = prefix === "◆";
  const styledPrefix = isSelected ? ansi.brightCyan("◆") : ansi.dim("·");
  const styledLabel = isSelected ? ansi.bold(ansi.brightCyan(truncateText(label, 18))) : ansi.bold(truncateText(label, 18));
  const labelPadding = " ".repeat(Math.max(0, 19 - visibleTextLength(truncateText(label, 18))));
  const styledDesc = isSelected ? ansi.dim(truncateText(description, descriptionWidth)) : ansi.dim(truncateText(description, descriptionWidth));
  return `${styledPrefix} ${styledLabel}${labelPadding}${styledDesc}`;
}

function buildCompactDialogPreview(
  preview: InteractiveSelectionPreview | null,
  options: {
    minimal?: boolean;
    showWhy?: boolean;
    showContinuity?: boolean;
  },
): string[] {
  if (!preview) {
    return [];
  }
  const lead = preview.resolvedCommandTemplate ?? preview.selectedCommand ?? preview.selectedTargetSummary ?? "none";
  if (options.minimal) {
    const effect = preview.nextEffect ?? preview.whySelected ?? preview.continuitySnippet;
    return compactStrings([
      `  ↵ ${truncateText(lead, 50)}`,
      effect ? `  ${truncateText(summarizePreviewEffect(lead, effect), 50)}` : null,
    ]);
  }
  const detail = preview.nextEffect
    ?? (options.showWhy ? preview.whySelected : null)
    ?? (options.showContinuity ? preview.continuitySnippet : null)
    ?? preview.availabilitySummary
    ?? preview.relationSummary;
  return compactStrings([
    `  ↵ ${truncateText(lead, 50)}`,
    detail ? `  ${truncateText(summarizePreviewEffect(lead, detail), 50)}` : null,
  ]);
}

function renderLauncherNoMatchPanel(
  report: InteractiveCommandPaletteReport,
  mode: "overlay" | "text",
): string {
  const query = report.query ?? "";
  const looksLikePlainMessage = /[\u3400-\u9fff]/.test(query) || /\s/.test(query);
  return renderCompactDialogPanel({
    title: "Launcher · search",
    stateLabel: "  state · launcher",
    meta: `filter /${query} · no slash match`,
    rows: looksLikePlainMessage
      ? [
        "  this looks like a normal message",
        "  try /continue, /status, or remove the leading /",
      ]
      : [
        "  no slash command matched this filter",
        "  try /continue, /status, or /history sessions",
      ],
    preview: buildCompactDialogPreview(report.selectedPreview, {
      minimal: false,
      showWhy: true,
      showContinuity: false,
    }),
    previewLabel: "hint",
    footerHint: looksLikePlainMessage
      ? "normal chat input works better without the leading slash"
      : "keep refining or jump to a high-value root command",
    footer: looksLikePlainMessage
      ? mode === "overlay"
        ? "esc close · remove / · /help"
        : "remove leading / · /continue"
      : mode === "overlay"
        ? "type more · esc close · /help"
        : "refine query · /continue · /help",
  });
}

function cleanPreviewEffect(value: string): string {
  return value
    .replace(/Enter -> /g, "↵ ")
    .replace(/chooser -> /g, "")
    .replace(/actions: /g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizePreviewEffect(lead: string, value: string): string {
  const cleaned = cleanPreviewEffect(value);
  if (cleaned === `↵ ${lead}` || cleaned === `↵ ${lead}.`) {
    return "runs now";
  }
  if (cleaned.startsWith(`↵ ${lead} then `)) {
    return cleaned.replace(`↵ ${lead} then `, "then ");
  }
  return cleaned;
}

function compactPickerDescription(entry: {
  description: string;
  badges: string[];
}): string {
  const badgeSummary = entry.badges.slice(0, 2).join(", ");
  return badgeSummary
    ? `${badgeSummary} · ${entry.description}`
    : entry.description;
}

function renderStatusBlocker(report: AgentInteractionStatusReport): string {
  if (report.plan.status === "blocked") {
    return `plan=blocked blockers=${report.plan.blockerCount ?? 0}`;
  }
  if ((report.plan.blockerCount ?? 0) > 0) {
    return `plan=degraded blockers=${report.plan.blockerCount ?? 0}`;
  }
  if (report.verifier.repairStatus === "failed" || report.verifier.finalOutcome === "failed") {
    return "plan=waiting_on_repair";
  }
  if (report.plan.currentStepTitle) {
    return `plan=${report.plan.status ?? "active"} step=${report.plan.currentStepTitle}`;
  }
  return `plan=${report.plan.status ?? "idle"}`;
}

function renderStatusRuntime(report: AgentInteractionStatusReport): string {
  const flags = report.runtime.degradedFlags.length > 0
    ? report.runtime.degradedFlags.join(",")
    : "steady";
  const providerScore = typeof report.runtime.providerHealthScore === "number"
    && report.runtime.providerHealthScore > 0
    ? `${report.runtime.providerHealthScore}`
    : "n/a";
  return `provider=${providerScore} circuits=${report.runtime.openCircuitCount ?? 0} flags=${flags}`;
}

function renderCompactSessionRef(sessionId: string): string {
  const isoLikeMatch = sessionId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d{3})?Z(?:-(.+))?$/);
  if (isoLikeMatch) {
    const [, date, hour, minute, _second, suffix] = isoLikeMatch;
    return `${date} ${hour}:${minute}${suffix ? ` #${suffix.length <= 10 ? suffix : suffix.slice(0, 6)}` : ""}`;
  }
  return sessionId.length > 28
    ? `${sessionId.slice(0, 25)}...`
    : sessionId;
}

function appendSelectionPreview(
  lines: string[],
  preview: InteractiveSelectionPreview | null,
): void {
  if (!preview) {
    return;
  }
  lines.push("Preview:");
  lines.push(`- target=${preview.selectedTargetSummary ?? "none"}`);
  lines.push(`- state=${preview.decisionState}`);
  if (preview.relationSummary) {
    lines.push(`- relation=${preview.relationSummary}`);
  }
  if (preview.availabilitySummary) {
    lines.push(`- availability=${preview.availabilitySummary}`);
  }
  lines.push(`- continuity=${preview.continuitySnippet ?? "none"}`);
  lines.push(`- why=${preview.whySelected ?? "none"}`);
  lines.push(`- effect=${preview.nextEffect ?? "none"}`);
  if (!preview.available && preview.unavailableReason) {
    lines.push(`- unavailable=${preview.unavailableReason}`);
  }
}

function appendCompactPreview(
  lines: string[],
  preview: InteractiveSelectionPreview | null,
  options: {
    showWhy: boolean;
    showContinuity: boolean;
    minimal?: boolean;
  },
): void {
  if (!preview) {
    return;
  }
  const lead = preview.resolvedCommandTemplate ?? preview.selectedCommand ?? preview.selectedTargetSummary ?? "none";
  lines.push(renderCompactPanelDivider());
  lines.push(`Primary → ${truncateText(lead, 66)}`);
  if (options.minimal) {
    const compactFollowup = preview.nextEffect ?? preview.whySelected ?? preview.continuitySnippet;
    if (compactFollowup) {
      lines.push(`  ${truncateText(compactFollowup, 74)}`);
    }
    return;
  }
  const metaParts = [
    preview.decisionState !== "neutral" ? preview.decisionState : null,
    preview.relationSummary,
    preview.availabilitySummary,
  ].filter((value): value is string => Boolean(value));
  const detail = preview.nextEffect
    ?? (options.showWhy ? preview.whySelected : null)
    ?? (metaParts.length > 0 ? metaParts.join(" · ") : null)
    ?? (options.showContinuity ? preview.continuitySnippet : null);
  if (detail) {
    lines.push(`  ${truncateText(detail, 74)}`);
  }
}

function renderCompactPanelDivider(): string {
  return "────────────────────────────────────────────────────────────────────────";
}
