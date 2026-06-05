import type {
  DiagnosticFingerprint,
  DiagnosticProjectContext,
  ProjectContextDocumentSymbol,
  ProjectContextImplementation,
  ProjectContextDefinition,
  RepairAttemptRecord,
  RepairDirectiveFileGroup,
  RepairDirectiveItem,
  VerifierCheckResult,
  VerifierBaselinePromotionHistory,
  VerifierBaselinePromotionHistoryRenderProfile,
  VerifierBaselinePromotionPlanRecord,
  VerifierBaselinePromotionRenderProfile,
  VerifierDrilldownRenderProfile,
  VerifierDrilldownReport,
  VerifierGitHubChecksPayload,
  VerifierGitHubChecksRenderProfile,
  VerifierGitHubMutationRecord,
  VerifierGitHubMutationRenderProfile,
  VerifierFailureCategory,
  VerifierFinding,
  VerifierInspectBaselineList,
  VerifierInspectBaselinePromotionRecord,
  VerifierInspectBaselineRecord,
  VerifierInspectBaselineRenderProfile,
  VerifierInspectArtifactList,
  VerifierInspectArtifactPruneRenderProfile,
  VerifierInspectArtifactPruneResult,
  VerifierInspectArtifactListRenderProfile,
  VerifierInspectArtifactRecord,
  VerifierInspectArtifactRenderProfile,
  VerifierInspectCompareRenderProfile,
  VerifierInspectCompareReport,
  VerifierInspectRenderProfile,
  VerifierInspectReport,
  VerifierInspectSnapshotList,
  VerifierInspectSnapshotRecord,
  VerifierInspectSnapshotRenderProfile,
  VerifierReleaseBundleRecord,
  VerifierReleaseBundleRenderProfile,
  VerifierReleaseHandoffRenderProfile,
  VerifierReleaseHandoffSelection,
  VerifierReleaseTriageRenderProfile,
  VerifierReleaseTriageSummary,
  VerifierRegressionGatePolicyProfileList,
  VerifierRegressionGatePolicyProfileRenderProfile,
  VerifierRegressionGateDecision,
  VerifierRegressionGateRenderProfile,
  VerifierTimelineEvent,
  VerifierTimelineRenderProfile,
  VerifierTimelineReport,
  VerifierRunRecord,
} from "../types/contracts.js";

const MAX_RENDER_FAILURES = 5;
const MAX_RENDER_FILE_GROUPS = 3;
const MAX_RENDER_CONTEXT_ITEMS = 3;
const MAX_RENDER_LIST_PREVIEW = 3;
const MAX_RENDER_GATE_REASONS = 5;

interface VerifierInspectRenderOptions {
  profile?: VerifierInspectRenderProfile;
}

interface VerifierInspectSnapshotRenderOptions {
  profile?: VerifierInspectSnapshotRenderProfile;
}

interface VerifierInspectCompareRenderOptions {
  profile?: VerifierInspectCompareRenderProfile;
}

interface VerifierInspectBaselineRenderOptions {
  profile?: VerifierInspectBaselineRenderProfile;
}

interface VerifierRegressionGateRenderOptions {
  profile?: VerifierRegressionGateRenderProfile;
}

interface VerifierRegressionGatePolicyProfileRenderOptions {
  profile?: VerifierRegressionGatePolicyProfileRenderProfile;
}

interface VerifierInspectArtifactRenderOptions {
  profile?: VerifierInspectArtifactRenderProfile;
}

interface VerifierInspectArtifactListRenderOptions {
  profile?: VerifierInspectArtifactListRenderProfile;
}

interface VerifierReleaseHandoffRenderOptions {
  profile?: VerifierReleaseHandoffRenderProfile;
}

interface VerifierReleaseBundleRenderOptions {
  profile?: VerifierReleaseBundleRenderProfile;
}

interface VerifierInspectArtifactPruneRenderOptions {
  profile?: VerifierInspectArtifactPruneRenderProfile;
}

interface VerifierBaselinePromotionRenderOptions {
  profile?: VerifierBaselinePromotionRenderProfile;
}

interface VerifierBaselinePromotionHistoryRenderOptions {
  profile?: VerifierBaselinePromotionHistoryRenderProfile;
}

interface VerifierReleaseTriageRenderOptions {
  profile?: VerifierReleaseTriageRenderProfile;
}

interface VerifierGitHubChecksRenderOptions {
  profile?: VerifierGitHubChecksRenderProfile;
}

interface VerifierGitHubMutationRenderOptions {
  profile?: VerifierGitHubMutationRenderProfile;
}

interface VerifierDrilldownRenderOptions {
  profile?: VerifierDrilldownRenderProfile;
}

interface VerifierTimelineRenderOptions {
  profile?: VerifierTimelineRenderProfile;
}

interface RenderFailureEntry {
  path: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  category: VerifierFailureCategory | null;
  message: string;
  fixHintCount: number;
  recommendedFixHintCount: number;
  codeActionCount: number;
  allowlistedCodeActionCount: number;
  projectContext: DiagnosticProjectContext | null;
}

export function normalizeVerifierInspectRenderProfile(
  value: string | null | undefined,
): VerifierInspectRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
    case "repair":
    case "context":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierInspectSnapshotRenderProfile(
  value: string | null | undefined,
): VerifierInspectSnapshotRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return normalized === "summary"
    ? "summary"
    : "json";
}

export function normalizeVerifierInspectBaselineRenderProfile(
  value: string | null | undefined,
): VerifierInspectBaselineRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return normalized === "summary"
    ? "summary"
    : "json";
}

export function normalizeVerifierInspectCompareRenderProfile(
  value: string | null | undefined,
): VerifierInspectCompareRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierRegressionGateRenderProfile(
  value: string | null | undefined,
): VerifierRegressionGateRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierRegressionGatePolicyProfileRenderProfile(
  value: string | null | undefined,
): VerifierRegressionGatePolicyProfileRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return normalized === "summary"
    ? "summary"
    : "json";
}

export function normalizeVerifierInspectArtifactRenderProfile(
  value: string | null | undefined,
): VerifierInspectArtifactRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierInspectArtifactListRenderProfile(
  value: string | null | undefined,
): VerifierInspectArtifactListRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return normalized === "summary"
    ? "summary"
    : "json";
}

export function normalizeVerifierReleaseHandoffRenderProfile(
  value: string | null | undefined,
): VerifierReleaseHandoffRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierReleaseBundleRenderProfile(
  value: string | null | undefined,
): VerifierReleaseBundleRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return normalized === "summary"
    ? "summary"
    : "json";
}

export function normalizeVerifierInspectArtifactPruneRenderProfile(
  value: string | null | undefined,
): VerifierInspectArtifactPruneRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return normalized === "summary"
    ? "summary"
    : "json";
}

export function normalizeVerifierBaselinePromotionRenderProfile(
  value: string | null | undefined,
): VerifierBaselinePromotionRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierBaselinePromotionHistoryRenderProfile(
  value: string | null | undefined,
): VerifierBaselinePromotionHistoryRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return normalized === "summary"
    ? "summary"
    : "json";
}

export function normalizeVerifierReleaseTriageRenderProfile(
  value: string | null | undefined,
): VerifierReleaseTriageRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierGitHubChecksRenderProfile(
  value: string | null | undefined,
): VerifierGitHubChecksRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return normalized === "summary"
    ? "summary"
    : "json";
}

export function normalizeVerifierGitHubMutationRenderProfile(
  value: string | null | undefined,
): VerifierGitHubMutationRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierDrilldownRenderProfile(
  value: string | null | undefined,
): VerifierDrilldownRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function normalizeVerifierTimelineRenderProfile(
  value: string | null | undefined,
): VerifierTimelineRenderProfile {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  switch (normalized) {
    case "summary":
    case "failures":
      return normalized;
    case "json":
    default:
      return "json";
  }
}

export function renderVerifierInspectReport(
  report: VerifierInspectReport,
  options: VerifierInspectRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  switch (profile) {
    case "failures":
      return renderFailureProfile(report);
    case "repair":
      return renderRepairProfile(report);
    case "context":
      return renderContextProfile(report);
    case "summary":
    default:
      return renderSummaryProfile(report);
  }
}

export function renderVerifierInspectSnapshotRecord(
  record: VerifierInspectSnapshotRecord,
  options: VerifierInspectSnapshotRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectSnapshotRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(record, null, 2);
  }
  return renderSnapshotSummary(record);
}

export function renderVerifierInspectSnapshotList(
  list: VerifierInspectSnapshotList,
  options: VerifierInspectSnapshotRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectSnapshotRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(list, null, 2);
  }
  return renderSnapshotListSummary(list);
}

export function renderVerifierInspectBaselineRecord(
  record: VerifierInspectBaselineRecord,
  options: VerifierInspectBaselineRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectBaselineRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(record, null, 2);
  }
  return renderBaselineSummary(record);
}

export function renderVerifierInspectBaselineList(
  list: VerifierInspectBaselineList,
  options: VerifierInspectBaselineRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectBaselineRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(list, null, 2);
  }
  return renderBaselineListSummary(list);
}

export function renderVerifierInspectCompareReport(
  report: VerifierInspectCompareReport,
  options: VerifierInspectCompareRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectCompareRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (profile === "failures") {
    return renderCompareFailures(report);
  }
  return renderCompareSummary(report);
}

export function renderVerifierRegressionGateDecision(
  decision: VerifierRegressionGateDecision,
  options: VerifierRegressionGateRenderOptions = {},
): string {
  const profile = normalizeVerifierRegressionGateRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(decision, null, 2);
  }
  if (profile === "failures") {
    return renderGateFailures(decision);
  }
  return renderGateSummary(decision);
}

export function renderVerifierRegressionGatePolicyProfiles(
  profiles: VerifierRegressionGatePolicyProfileList,
  options: VerifierRegressionGatePolicyProfileRenderOptions = {},
): string {
  const profile = normalizeVerifierRegressionGatePolicyProfileRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(profiles, null, 2);
  }
  return renderGatePolicyProfilesSummary(profiles);
}

export function renderVerifierInspectArtifactRecord(
  record: VerifierInspectArtifactRecord,
  options: VerifierInspectArtifactRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectArtifactRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(record, null, 2);
  }
  if (profile === "failures") {
    return renderArtifactFailures(record);
  }
  return renderArtifactSummary(record);
}

export function renderVerifierInspectArtifactList(
  list: VerifierInspectArtifactList,
  options: VerifierInspectArtifactListRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectArtifactListRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(list, null, 2);
  }
  return renderArtifactListSummary(list);
}

export function renderVerifierReleaseHandoff(
  selection: VerifierReleaseHandoffSelection,
  options: VerifierReleaseHandoffRenderOptions = {},
): string {
  const profile = normalizeVerifierReleaseHandoffRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(selection, null, 2);
  }
  if (profile === "failures") {
    return renderReleaseHandoffFailures(selection);
  }
  return renderReleaseHandoffSummary(selection);
}

export function renderVerifierReleaseBundle(
  record: VerifierReleaseBundleRecord,
  options: VerifierReleaseBundleRenderOptions = {},
): string {
  const profile = normalizeVerifierReleaseBundleRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(record, null, 2);
  }
  return renderReleaseBundleSummary(record);
}

export function renderVerifierInspectArtifactPruneResult(
  result: VerifierInspectArtifactPruneResult,
  options: VerifierInspectArtifactPruneRenderOptions = {},
): string {
  const profile = normalizeVerifierInspectArtifactPruneRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(result, null, 2);
  }
  return renderArtifactPruneSummary(result);
}

export function renderVerifierBaselinePromotionPlan(
  record: VerifierBaselinePromotionPlanRecord,
  options: VerifierBaselinePromotionRenderOptions = {},
): string {
  const profile = normalizeVerifierBaselinePromotionRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(record, null, 2);
  }
  if (profile === "failures") {
    return renderBaselinePromotionFailures(record);
  }
  return renderBaselinePromotionSummary(record);
}

export function renderVerifierBaselinePromotionHistory(
  history: VerifierBaselinePromotionHistory,
  options: VerifierBaselinePromotionHistoryRenderOptions = {},
): string {
  const profile = normalizeVerifierBaselinePromotionHistoryRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(history, null, 2);
  }
  return renderBaselinePromotionHistorySummary(history);
}

export function renderVerifierReleaseTriageSummary(
  summary: VerifierReleaseTriageSummary,
  options: VerifierReleaseTriageRenderOptions = {},
): string {
  const profile = normalizeVerifierReleaseTriageRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(summary, null, 2);
  }
  if (profile === "failures") {
    return renderReleaseTriageFailures(summary);
  }
  return renderReleaseTriageCompactSummary(summary);
}

export function renderVerifierGitHubChecksPayload(
  payload: VerifierGitHubChecksPayload,
  options: VerifierGitHubChecksRenderOptions = {},
): string {
  const profile = normalizeVerifierGitHubChecksRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(payload, null, 2);
  }
  return renderGitHubChecksSummary(payload);
}

export function renderVerifierGitHubMutationResult(
  result: VerifierGitHubMutationRecord | null,
  options: VerifierGitHubMutationRenderOptions = {},
): string {
  const profile = normalizeVerifierGitHubMutationRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (!result) {
    return profile === "failures"
      ? "Verifier GitHub Mutation Failures\nresult: unavailable"
      : "Verifier GitHub Mutation\nresult: unavailable";
  }
  if (profile === "failures") {
    return renderGitHubMutationFailures(result);
  }
  return renderGitHubMutationSummary(result);
}

export function renderVerifierDrilldownReport(
  report: VerifierDrilldownReport,
  options: VerifierDrilldownRenderOptions = {},
): string {
  const profile = normalizeVerifierDrilldownRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (profile === "failures") {
    return renderVerifierDrilldownFailures(report);
  }
  return renderVerifierDrilldownSummary(report);
}

export function renderVerifierTimelineReport(
  report: VerifierTimelineReport,
  options: VerifierTimelineRenderOptions = {},
): string {
  const profile = normalizeVerifierTimelineRenderProfile(options.profile);
  if (profile === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (profile === "failures") {
    return renderVerifierTimelineFailures(report);
  }
  return renderVerifierTimelineSummary(report);
}

function renderSummaryProfile(report: VerifierInspectReport): string {
  const lines = createReportPreamble(report, "Verifier Summary");
  if (!report.summary.hasData) {
    lines.push("no verifier or repair data recorded.");
    return lines.join("\n");
  }
  lines.push(`latest verifier: ${report.summary.latestVerifierStatus}`);
  lines.push(
    `latest repair: ${report.summary.latestRepairStatus}`
      + (report.summary.latestRepairStatus !== "none"
        ? ` (${report.summary.latestRepairProgress})`
        : ""),
  );
  lines.push(
    `latest diagnostics: ${report.summary.latestDiagnosticEngine}`
      + `, fallback ${report.summary.latestDiagnosticFallbackUsed ? "yes" : "no"}`
      + `, errors ${report.summary.diagnosticErrorCount}, warnings ${report.summary.diagnosticWarningCount}, info ${report.summary.diagnosticInfoCount}`,
  );
  lines.push(
    `assist totals: fix hints ${report.summary.fixHintCount} total`
      + `, ${report.summary.recommendedFixHintCount} recommended`
      + `, ${report.summary.fixHintFileCount} files`
      + `; code actions ${report.summary.codeActionCandidateCount} total`
      + `, ${report.summary.codeActionAllowlistedCount} allowlisted`
      + `, ${report.summary.codeActionAppliedCount} applied`
      + `, ${report.summary.codeActionBlockedCount} blocked`,
  );
  lines.push(
    `latest fix hints: ${report.summary.latestFixHintAvailable ? "available" : "unavailable"}`
      + ` via ${report.summary.latestFixHintSource}`,
  );
  lines.push(
    `latest code action: ${report.summary.latestCodeActionStatus}`
      + ` via ${report.summary.latestCodeActionSource}`
      + `${report.summary.latestCodeActionBlockedReason ? ` (${report.summary.latestCodeActionBlockedReason})` : ""}`,
  );
  lines.push(
    `context totals: items ${report.summary.projectContextCount}`
      + `, defs ${report.summary.projectContextDefinitionCount}`
      + `, impls ${report.summary.projectContextImplementationCount}`
      + `, refs ${report.summary.projectContextReferenceCount}`
      + `, symbols ${report.summary.projectContextDocumentSymbolCount}`
      + `; latest ${report.summary.latestProjectContextAvailable ? "available" : "unavailable"}`
      + ` via ${report.summary.latestProjectContextSource}`,
  );
  if (report.summary.latestDiagnosticFallbackReason) {
    lines.push(`latest fallback reason: ${report.summary.latestDiagnosticFallbackReason}`);
  }
  if (report.summary.latestProjectContextReason) {
    lines.push(`latest context reason: ${report.summary.latestProjectContextReason}`);
  }
  lines.push(
    `continuity: verifier runs ${report.summary.verifierRunCount}`
      + ` (passed ${report.summary.passedVerifierRunCount}, failed ${report.summary.failedVerifierRunCount}, skipped ${report.summary.skippedVerifierRunCount})`
      + `; repair loops ${report.summary.repairLoopCount}`
      + ` / attempts ${report.summary.repairAttemptCount}`,
  );
  lines.push(
    `convergence: trend ${report.summary.repairProgressTrend}`
      + `; resolved ${report.summary.repairResolvedCount}`
      + `, improved ${report.summary.repairImprovedCount}`
      + `, unchanged ${report.summary.repairUnchangedCount}`
      + `, regressed ${report.summary.repairRegressedCount}`
      + `; delta resolved ${report.summary.resolvedDiagnosticCount}`
      + `, persisted ${report.summary.persistedDiagnosticCount}`
      + `, introduced ${report.summary.introducedDiagnosticCount}`,
  );
  return lines.join("\n");
}

function renderFailureProfile(report: VerifierInspectReport): string {
  const lines = createReportPreamble(report, "Verifier Failures");
  if (!report.summary.hasData) {
    lines.push("no verifier or repair data recorded.");
    return lines.join("\n");
  }
  lines.push(`latest verifier: ${report.summary.latestVerifierStatus}`);
  lines.push(
    `latest repair: ${report.summary.latestRepairStatus}`
      + (report.summary.latestRepairStatus !== "none"
        ? ` (${report.summary.latestRepairProgress})`
        : ""),
  );

  const failures = collectRenderableFailures(report);
  if (failures.length === 0) {
    lines.push("no blocking diagnostics recorded.");
  } else {
    lines.push("top blocking diagnostics:");
    for (const [index, failure] of failures.slice(0, MAX_RENDER_FAILURES).entries()) {
      lines.push(
        `${index + 1}. ${formatLocation(failure.path, failure.line, failure.column)}`
          + `${failure.code ? ` ${failure.code}` : ""}`
          + `${failure.category ? ` [${failure.category}]` : ""}`,
      );
      lines.push(`   ${normalizeInlineText(failure.message)}`);
      if (failure.fixHintCount > 0) {
        lines.push(
          `   fix hints: ${failure.fixHintCount} total, ${failure.recommendedFixHintCount} recommended`,
        );
      }
      if (failure.codeActionCount > 0) {
        lines.push(
          `   code actions: ${failure.codeActionCount} total, ${failure.allowlistedCodeActionCount} allowlisted`,
        );
      }
      if (failure.projectContext) {
        lines.push(
          `   project context: quick info ${failure.projectContext.quickInfo ? "yes" : "no"}`
            + `, defs ${failure.projectContext.definitions.length}`
            + `, impls ${failure.projectContext.implementations.length}`
            + `, refs ${failure.projectContext.references.length}`
            + `, symbols ${failure.projectContext.documentSymbols.length}`,
        );
      }
    }
    if (failures.length > MAX_RENDER_FAILURES) {
      lines.push(`... ${failures.length - MAX_RENDER_FAILURES} more blocking diagnostic(s) omitted`);
    }
  }

  const fileGroups = collectRenderableFileGroups(report);
  if (fileGroups.length > 0) {
    lines.push("top files:");
    for (const [index, group] of fileGroups.slice(0, MAX_RENDER_FILE_GROUPS).entries()) {
      lines.push(`${index + 1}. ${group.path ?? "(no path)"}`);
      lines.push(
        `   diagnostics ${Number(group.diagnosticCount ?? 0)}, hints ${Number(group.hintCount ?? 0)}, code actions ${Number(group.codeActionCount ?? 0)}, context-linked items ${Number(group.projectContextCount ?? 0)}`,
      );
      const codes = group.codes ?? [];
      if (codes.length > 0) {
        lines.push(`   codes: ${codes.slice(0, MAX_RENDER_LIST_PREVIEW).join(", ")}`);
      }
      const definitions = group.definitions ?? [];
      const implementations = group.implementations ?? [];
      const documentSymbols = group.documentSymbols ?? [];
      if (definitions.length > 0 || implementations.length > 0 || documentSymbols.length > 0) {
        lines.push(
          `   context: defs ${definitions.length}, impls ${implementations.length}, symbols ${documentSymbols.length}`,
        );
      }
    }
    if (fileGroups.length > MAX_RENDER_FILE_GROUPS) {
      lines.push(`... ${fileGroups.length - MAX_RENDER_FILE_GROUPS} more file group(s) omitted`);
    }
  }

  return lines.join("\n");
}

function renderRepairProfile(report: VerifierInspectReport): string {
  const lines = createReportPreamble(report, "Verifier Repair");
  if (!report.summary.hasData) {
    lines.push("no verifier or repair data recorded.");
    return lines.join("\n");
  }
  const repairLoop = report.latest.repairLoop;
  if (!repairLoop) {
    lines.push("no repair loop recorded.");
    lines.push(`latest verifier: ${report.summary.latestVerifierStatus}`);
    return lines.join("\n");
  }
  const latestAttempt = repairLoop.attempts.at(-1) ?? null;
  lines.push(`latest repair: ${repairLoop.summary.status}`);
  lines.push(
    `progress: ${repairLoop.summary.latestProgress}`
      + ` (trend ${repairLoop.summary.progressTrend})`,
  );
  lines.push(
    `attempts: ${repairLoop.summary.attemptsUsed}/${repairLoop.maxAttempts}`
      + ` used, ${repairLoop.summary.attemptsRemaining} remaining`,
  );
  lines.push(
    `delta: resolved ${repairLoop.summary.resolvedDiagnosticCount}`
      + `, persisted ${repairLoop.summary.persistedDiagnosticCount}`
      + `, introduced ${repairLoop.summary.introducedDiagnosticCount}`,
  );
  lines.push(
    `code actions: applied ${repairLoop.summary.codeActionAppliedCount}`
      + `, blocked ${repairLoop.summary.codeActionBlockedCount}`
      + `, latest ${repairLoop.summary.latestCodeActionStatus}`,
  );
  if (repairLoop.summary.stopReason) {
    lines.push(`stop reason: ${repairLoop.summary.stopReason}`);
  }
  if (latestAttempt) {
    lines.push(
      `latest attempt: #${latestAttempt.attempt} ${latestAttempt.status}`
        + `, decision ${latestAttempt.decision}`,
    );
    if (latestAttempt.convergence?.delta) {
      lines.push(
        `latest convergence: ${latestAttempt.convergence.state}; resolved ${latestAttempt.convergence.delta.resolvedCount}, persisted ${latestAttempt.convergence.delta.persistedCount}, introduced ${latestAttempt.convergence.delta.introducedCount}`,
      );
    }
    if (latestAttempt.codeAction) {
      lines.push(
        `latest code action: ${latestAttempt.codeAction.status}`
          + `${latestAttempt.codeAction.title ? ` ${latestAttempt.codeAction.title}` : ""}`
          + `${latestAttempt.codeAction.toolName ? ` via ${latestAttempt.codeAction.toolName}` : ""}`,
      );
    }
    const fileGroups = (latestAttempt.directive?.fileGroups ?? [])
      .slice()
      .sort(compareRenderableFileGroups);
    if (fileGroups.length > 0) {
      lines.push("top repair files:");
      for (const [index, group] of fileGroups.slice(0, MAX_RENDER_FILE_GROUPS).entries()) {
        lines.push(`${index + 1}. ${group.path ?? "(no path)"}`);
        lines.push(
          `   diagnostics ${Number(group.diagnosticCount ?? 0)}, hints ${Number(group.hintCount ?? 0)}, code actions ${Number(group.codeActionCount ?? 0)}, context-linked items ${Number(group.projectContextCount ?? 0)}`,
        );
      }
      if (fileGroups.length > MAX_RENDER_FILE_GROUPS) {
        lines.push(`... ${fileGroups.length - MAX_RENDER_FILE_GROUPS} more repair file group(s) omitted`);
      }
    }
  }
  lines.push(
    `continuity: verifier runs ${report.summary.verifierRunCount}, repair loops ${report.summary.repairLoopCount}, final outcome ${report.summary.finalOutcome}`,
  );
  return lines.join("\n");
}

function renderContextProfile(report: VerifierInspectReport): string {
  const lines = createReportPreamble(report, "Verifier Context");
  if (!report.summary.hasData) {
    lines.push("no verifier or repair data recorded.");
    return lines.join("\n");
  }
  lines.push(
    `context totals: items ${report.summary.projectContextCount}`
      + `, coverage ${report.summary.projectContextDiagnosticCoverageCount}`
      + `, quick info ${report.summary.projectContextQuickInfoCount}`
      + `, defs ${report.summary.projectContextDefinitionCount}`
      + `, impls ${report.summary.projectContextImplementationCount}`
      + `, refs ${report.summary.projectContextReferenceCount}`
      + `, symbols ${report.summary.projectContextDocumentSymbolCount}`,
  );
  lines.push(
    `latest context: ${report.summary.latestProjectContextAvailable ? "available" : "unavailable"}`
      + ` via ${report.summary.latestProjectContextSource}`
      + ` (${report.summary.latestProjectContextCount} items, ${report.summary.latestProjectContextDefinitionCount} defs, ${report.summary.latestProjectContextImplementationCount} impls, ${report.summary.latestProjectContextReferenceCount} refs, ${report.summary.latestProjectContextDocumentSymbolCount} symbols)`,
  );
  if (report.summary.latestProjectContextReason) {
    lines.push(`reason: ${report.summary.latestProjectContextReason}`);
  }

  const groups = collectRenderableFileGroups(report)
    .filter((group) =>
      (group.definitions ?? []).length > 0
      || (group.implementations ?? []).length > 0
      || (group.documentSymbols ?? []).length > 0,
    );
  if (groups.length === 0) {
    lines.push("no richer project-context groups recorded.");
  } else {
    lines.push("top context groups:");
    for (const [index, group] of groups.slice(0, MAX_RENDER_FILE_GROUPS).entries()) {
      lines.push(`${index + 1}. ${group.path ?? "(no path)"}`);
      const definitions = group.definitions ?? [];
      const implementations = group.implementations ?? [];
      const documentSymbols = group.documentSymbols ?? [];
      if (definitions.length > 0) {
        lines.push(`   definitions: ${formatDefinitionList(definitions)}`);
      }
      if (implementations.length > 0) {
        lines.push(`   implementations: ${formatImplementationList(implementations)}`);
      }
      if (documentSymbols.length > 0) {
        lines.push(`   symbols: ${formatDocumentSymbolList(documentSymbols)}`);
      }
    }
    if (groups.length > MAX_RENDER_FILE_GROUPS) {
      lines.push(`... ${groups.length - MAX_RENDER_FILE_GROUPS} more context group(s) omitted`);
    }
  }

  const failuresWithContext = collectRenderableFailures(report)
    .filter((entry) => entry.projectContext != null)
    .slice(0, MAX_RENDER_CONTEXT_ITEMS);
  if (failuresWithContext.length > 0) {
    lines.push("latest blocking diagnostics with context:");
    for (const [index, entry] of failuresWithContext.entries()) {
      lines.push(
        `${index + 1}. ${formatLocation(entry.path, entry.line, entry.column)}`
          + `${entry.code ? ` ${entry.code}` : ""}`,
      );
      if (entry.projectContext?.enclosingSymbol?.name) {
        lines.push(`   enclosing scope: ${entry.projectContext.enclosingSymbol.name}`);
      }
      if (entry.projectContext?.quickInfo?.displayText) {
        lines.push(`   quick info: ${entry.projectContext.quickInfo.displayText}`);
      }
      lines.push(`   ${normalizeInlineText(entry.message)}`);
    }
  }

  return lines.join("\n");
}

function renderSnapshotSummary(record: VerifierInspectSnapshotRecord): string {
  const lines = [
    "Verifier Export",
    `snapshot: ${record.metadata.snapshotId}`,
    `created: ${record.metadata.createdAt}`,
    `source: ${record.metadata.source.label}`,
    `scope: ${record.report.scope}`,
    `session: ${record.report.sessionId ?? "none"}`,
    `trace: ${record.report.traceId ?? "none"}`,
    `final outcome: ${record.report.summary.finalOutcome}`,
  ];
  if (!record.report.summary.hasData) {
    lines.push("no verifier or repair data recorded.");
    return lines.join("\n");
  }
  lines.push(`latest verifier: ${record.report.summary.latestVerifierStatus}`);
  lines.push(
    `latest repair: ${record.report.summary.latestRepairStatus}`
      + (record.report.summary.latestRepairStatus !== "none"
        ? ` (${record.report.summary.latestRepairProgress})`
        : ""),
  );
  lines.push(
    `continuity: verifier runs ${record.report.summary.verifierRunCount}, repair loops ${record.report.summary.repairLoopCount}, attempts ${record.report.summary.repairAttemptCount}`,
  );
  lines.push(
    `assist: fix hints ${record.report.summary.fixHintCount}, code actions ${record.report.summary.codeActionCandidateCount} (${record.report.summary.codeActionAppliedCount} applied), context items ${record.report.summary.projectContextCount}`,
  );
  return lines.join("\n");
}

function renderSnapshotListSummary(list: VerifierInspectSnapshotList): string {
  const lines = [
    "Verifier Exports",
    `total: ${list.total}`,
  ];
  if (list.items.length === 0) {
    lines.push("no exported verifier snapshots.");
    return lines.join("\n");
  }
  for (const [index, item] of list.items.entries()) {
    lines.push(
      `${index + 1}. ${item.snapshotId} ${item.createdAt}`,
    );
    lines.push(
      `   ${item.source.label}; outcome ${item.summary.finalOutcome}; latest verifier ${item.summary.latestVerifierStatus}; latest repair ${item.summary.latestRepairStatus}`,
    );
    lines.push(
      `   runs ${item.summary.verifierRunCount}, loops ${item.summary.repairLoopCount}, attempts ${item.summary.repairAttemptCount}, fix hints ${item.summary.fixHintCount}, code actions ${item.summary.codeActionAppliedCount} applied, context ${item.summary.projectContextCount}`,
    );
  }
  return lines.join("\n");
}

function renderBaselineSummary(record: VerifierInspectBaselineRecord): string {
  const lines = [
    "Verifier Baseline",
    `name: ${record.metadata.name}`,
    `baseline id: ${record.metadata.baselineId}`,
    `created: ${record.metadata.createdAt}`,
    `updated: ${record.metadata.updatedAt}`,
    `snapshot: ${record.metadata.snapshotId}`,
    `policy profile: ${record.metadata.policyProfileId ?? "default"}`,
    `source: ${record.metadata.source.label}`,
    `final outcome: ${record.metadata.summary.finalOutcome}`,
    `latest verifier: ${record.metadata.summary.latestVerifierStatus}`,
    `latest repair: ${record.metadata.summary.latestRepairStatus}`,
    `continuity: verifier runs ${record.metadata.summary.verifierRunCount}, repair loops ${record.metadata.summary.repairLoopCount}, attempts ${record.metadata.summary.repairAttemptCount}`,
  ];
  if (record.metadata.promotionCount > 0) {
    const latestPromotion = record.history[0] ?? null;
    lines.push(
      `promotions: ${record.metadata.promotionCount}`
        + `${latestPromotion ? `; latest ${latestPromotion.previousSnapshotId} -> ${latestPromotion.nextSnapshotId}` : ""}`,
    );
  }
  return lines.join("\n");
}

function renderBaselineListSummary(list: VerifierInspectBaselineList): string {
  const lines = [
    "Verifier Baselines",
    `total: ${list.total}`,
  ];
  if (list.items.length === 0) {
    lines.push("no pinned verifier baselines.");
    return lines.join("\n");
  }
  for (const [index, item] of list.items.entries()) {
    lines.push(`${index + 1}. ${item.name} ${item.updatedAt}`);
    lines.push(
      `   baseline ${item.baselineId}; snapshot ${item.snapshotId}; policy ${item.policyProfileId ?? "default"}; ${item.source.label}; outcome ${item.summary.finalOutcome}`,
    );
    lines.push(
      `   verifier ${item.summary.latestVerifierStatus}, repair ${item.summary.latestRepairStatus}, errors ${item.summary.diagnosticErrorCount}, runs ${item.summary.verifierRunCount}, attempts ${item.summary.repairAttemptCount}, promotions ${item.promotionCount}`,
    );
  }
  return lines.join("\n");
}

function renderCompareSummary(report: VerifierInspectCompareReport): string {
  const lines = [
    "Verifier Compare",
    `left: ${report.left.reference.label}`,
    `right: ${report.right.reference.label}`,
    `final outcome: ${formatTransition(report.summary.finalOutcome.before, report.summary.finalOutcome.after)}`,
    `latest verifier: ${formatTransition(report.summary.latestVerifierStatus.before, report.summary.latestVerifierStatus.after)}`,
    `latest repair: ${formatRepairTransition(report)}`,
    `diagnostics: errors ${formatCountTransition(report.summary.diagnosticErrors)}, warnings ${formatCountTransition(report.summary.diagnosticWarnings)}, info ${formatCountTransition(report.summary.diagnosticInfo)}`,
    `continuity: verifier runs ${formatCountTransition(report.summary.verifierRuns)}, repair loops ${formatCountTransition(report.summary.repairLoops)}, attempts ${formatCountTransition(report.summary.repairAttempts)}`,
    `convergence: resolved ${formatCountTransition(report.summary.repairResolved)}, improved ${formatCountTransition(report.summary.repairImproved)}, unchanged ${formatCountTransition(report.summary.repairUnchanged)}, regressed ${formatCountTransition(report.summary.repairRegressed)}`,
    `assist: fix hints ${formatCountTransition(report.summary.fixHints)}, code actions ${formatCountTransition(report.summary.codeActionCandidates)}, applied ${formatCountTransition(report.summary.codeActionApplied)}, context items ${formatCountTransition(report.summary.projectContextItems)}`,
    `availability: fix hints ${formatBooleanTransition(report.summary.latestFixHintAvailable.before, report.summary.latestFixHintAvailable.after)}, code actions ${formatBooleanTransition(report.summary.latestCodeActionAvailable.before, report.summary.latestCodeActionAvailable.after)}, context ${formatBooleanTransition(report.summary.latestProjectContextAvailable.before, report.summary.latestProjectContextAvailable.after)}`,
    `blocking diagnostics: ${report.summary.blockingDiagnostics.summary}`,
  ];
  if (report.artifact) {
    lines.push(`artifact: ${report.artifact.artifactId}`);
  }
  if (report.handoff) {
    lines.push(`handoff: ${report.handoff.handoffId}`);
  }
  if (report.bundle) {
    lines.push(`bundle: ${report.bundle.bundleId}`);
  }
  if (!report.summary.hasChanges) {
    lines.push("no continuity deltas detected.");
  }
  return lines.join("\n");
}

function renderCompareFailures(report: VerifierInspectCompareReport): string {
  const lines = [
    "Verifier Compare Failures",
    `left: ${report.left.reference.label}`,
    `right: ${report.right.reference.label}`,
    `final outcome: ${formatTransition(report.summary.finalOutcome.before, report.summary.finalOutcome.after)}`,
    `latest verifier: ${formatTransition(report.summary.latestVerifierStatus.before, report.summary.latestVerifierStatus.after)}`,
    `latest repair: ${formatRepairTransition(report)}`,
    `blocking diagnostics: ${report.summary.blockingDiagnostics.summary}`,
  ];
  appendFingerprintSection(lines, "resolved diagnostics:", report.summary.blockingDiagnostics.resolved);
  appendFingerprintSection(lines, "persisted diagnostics:", report.summary.blockingDiagnostics.persisted);
  appendFingerprintSection(lines, "introduced diagnostics:", report.summary.blockingDiagnostics.introduced);
  if (
    report.summary.blockingDiagnostics.resolvedCount === 0 &&
    report.summary.blockingDiagnostics.persistedCount === 0 &&
    report.summary.blockingDiagnostics.introducedCount === 0
  ) {
    lines.push("no blocking diagnostic continuity changes.");
  }
  return lines.join("\n");
}

function renderGateSummary(decision: VerifierRegressionGateDecision): string {
  const lines = [
    "Verifier Gate",
    `status: ${decision.status}`,
    `left: ${decision.compare.left.reference.label}`,
    `right: ${decision.compare.right.reference.label}`,
    `policy profile: ${decision.profile.id}`,
    `policy: ${decision.policy.name}`,
    `summary: ${decision.summary}`,
    `final outcome: ${formatTransition(decision.compare.summary.finalOutcome.before, decision.compare.summary.finalOutcome.after)}`,
    `latest verifier: ${formatTransition(decision.compare.summary.latestVerifierStatus.before, decision.compare.summary.latestVerifierStatus.after)}`,
    `diagnostics: errors ${formatCountTransition(decision.compare.summary.diagnosticErrors)}, warnings ${formatCountTransition(decision.compare.summary.diagnosticWarnings)}, info ${formatCountTransition(decision.compare.summary.diagnosticInfo)}`,
    `blocking diagnostics: ${decision.compare.summary.blockingDiagnostics.summary}`,
  ];
  if (decision.artifact) {
    lines.push(`artifact: ${decision.artifact.artifactId}`);
  }
  if (decision.handoff) {
    lines.push(`handoff: ${decision.handoff.handoffId}`);
  }
  if (decision.bundle) {
    lines.push(`bundle: ${decision.bundle.bundleId}`);
  }
  appendGateReasons(lines, decision.reasons, false);
  return lines.join("\n");
}

function renderGateFailures(decision: VerifierRegressionGateDecision): string {
  const lines = [
    "Verifier Gate Failures",
    `status: ${decision.status}`,
    `left: ${decision.compare.left.reference.label}`,
    `right: ${decision.compare.right.reference.label}`,
    `summary: ${decision.summary}`,
    `blocking diagnostics: ${decision.compare.summary.blockingDiagnostics.summary}`,
  ];
  appendGateReasons(lines, decision.reasons, true);
  if (decision.failureCount === 0) {
    lines.push("no failing regression reasons.");
  }
  return lines.join("\n");
}

function renderGatePolicyProfilesSummary(
  profiles: VerifierRegressionGatePolicyProfileList,
): string {
  const lines = [
    "Verifier Gate Policies",
    `total: ${profiles.total}`,
  ];
  if (profiles.items.length === 0) {
    lines.push("no verifier gate policy profiles.");
    return lines.join("\n");
  }
  for (const [index, item] of profiles.items.entries()) {
    lines.push(`${index + 1}. ${item.id} ${item.builtin ? "(builtin)" : "(custom)"}`);
    lines.push(`   ${normalizeInlineText(item.description)}`);
    lines.push(
      `   policy ${item.policy.name}; fail outcome ${formatBoolean(item.policy.failOnFinalOutcomeRegression)}, fail verifier-status ${formatBoolean(item.policy.failOnLatestVerifierStatusRegression)}, fail repair-status ${formatBoolean(item.policy.failOnLatestRepairStatusRegression)}`,
    );
  }
  return lines.join("\n");
}

function renderArtifactSummary(record: VerifierInspectArtifactRecord): string {
  const lines = [
    "Verifier Artifact",
    `artifact: ${record.metadata.artifactId}`,
    `kind: ${record.metadata.kind}`,
    `created: ${record.metadata.createdAt}`,
    `summary: ${record.metadata.summary}`,
  ];
  if (record.metadata.policyProfileId) {
    lines.push(`policy profile: ${record.metadata.policyProfileId}`);
  }
  if (record.metadata.pass != null) {
    lines.push(`pass: ${record.metadata.pass ? "yes" : "no"}`);
  }
  if (record.metadata.hasChanges != null) {
    lines.push(`has changes: ${record.metadata.hasChanges ? "yes" : "no"}`);
  }
  if (record.metadata.sourceReferences.length > 0) {
    lines.push(
      `sources: ${record.metadata.sourceReferences.map((entry) => entry.label).join(" -> ")}`,
    );
  }
  if ("compare" in record) {
    lines.push(
      `blocking diagnostics: ${record.compare.summary.blockingDiagnostics.summary}`,
    );
  } else if ("decision" in record) {
    lines.push(`gate status: ${record.decision.status}`);
    lines.push(
      `blocking diagnostics: ${record.decision.compare.summary.blockingDiagnostics.summary}`,
    );
  } else {
    lines.push(`eval suite: ${record.result.suite}`);
    lines.push(
      `eval summary: ${record.result.summary.passed}/${record.result.summary.total} passed`,
    );
    if (record.result.baselineGate) {
      lines.push(`baseline gate: ${record.result.baselineGate.status}`);
    }
  }
  if ("compare" in record && record.compare.handoff) {
    lines.push(`handoff: ${record.compare.handoff.handoffId}`);
  } else if ("decision" in record && record.decision.handoff) {
    lines.push(`handoff: ${record.decision.handoff.handoffId}`);
  } else if ("result" in record && record.result.handoff) {
    lines.push(`handoff: ${record.result.handoff.handoffId}`);
  }
  return lines.join("\n");
}

function renderArtifactFailures(record: VerifierInspectArtifactRecord): string {
  const lines = [
    "Verifier Artifact Failures",
    `artifact: ${record.metadata.artifactId}`,
    `kind: ${record.metadata.kind}`,
    `summary: ${record.metadata.summary}`,
  ];
  if ("compare" in record) {
    appendFingerprintSection(lines, "resolved diagnostics:", record.compare.summary.blockingDiagnostics.resolved);
    appendFingerprintSection(lines, "persisted diagnostics:", record.compare.summary.blockingDiagnostics.persisted);
    appendFingerprintSection(lines, "introduced diagnostics:", record.compare.summary.blockingDiagnostics.introduced);
  } else if ("decision" in record) {
    appendGateReasons(lines, record.decision.reasons, true);
    if (record.decision.failureCount === 0) {
      lines.push("no failing regression reasons.");
    }
  } else {
    const failedCases = record.result.cases.filter((entry) => entry.pass === false);
    if (record.result.baselineGate) {
      lines.push(`baseline gate: ${record.result.baselineGate.status}`);
      appendGateReasons(lines, record.result.baselineGate.reasons, true);
    }
    if (failedCases.length === 0) {
      lines.push("no failing eval cases.");
    } else {
      lines.push("top failing eval cases:");
      for (const [index, entry] of failedCases.slice(0, MAX_RENDER_FAILURES).entries()) {
        lines.push(`${index + 1}. ${entry.suite}/${entry.name}`);
        lines.push(`   ${normalizeInlineText(entry.failureReason ?? "failed")}`);
      }
      if (failedCases.length > MAX_RENDER_FAILURES) {
        lines.push(`... ${failedCases.length - MAX_RENDER_FAILURES} more failing eval case(s) omitted`);
      }
    }
  }
  return lines.join("\n");
}

function renderArtifactListSummary(list: VerifierInspectArtifactList): string {
  const lines = [
    "Verifier Artifacts",
    `total: ${list.total}`,
  ];
  if (list.items.length === 0) {
    lines.push("no verifier artifacts.");
    return lines.join("\n");
  }
  for (const [index, item] of list.items.entries()) {
    lines.push(`${index + 1}. ${item.artifactId} ${item.kind} ${item.createdAt}`);
    lines.push(
      `   ${normalizeInlineText(item.summary)}`,
    );
    lines.push(
      `   pass ${item.pass == null ? "n/a" : item.pass ? "yes" : "no"}; changes ${item.hasChanges == null ? "n/a" : item.hasChanges ? "yes" : "no"}; policy ${item.policyProfileId ?? "none"}`,
    );
  }
  return lines.join("\n");
}

function renderReleaseHandoffSummary(
  selection: VerifierReleaseHandoffSelection,
): string {
  const lines = [
    "Verifier Release Handoff",
    `reference: ${selection.reference ?? "latest"}`,
  ];
  if (!selection.available || !selection.handoff) {
    lines.push(`available: no`);
    lines.push(`reason: ${selection.reason ?? "No verifier release handoff is available."}`);
    appendLatestArtifactPointers(lines, selection);
    return lines.join("\n");
  }
  const handoff = selection.handoff;
  lines.push(`available: yes`);
  lines.push(`handoff: ${handoff.metadata.handoffId}`);
  lines.push(`source: ${handoff.metadata.sourceKind}`);
  lines.push(`status: ${handoff.metadata.status}`);
  lines.push(`policy profile: ${handoff.metadata.policyProfileId ?? "none"}`);
  lines.push(`primary artifact: ${handoff.metadata.primaryArtifactId ?? "none"}`);
  lines.push(`baseline: ${handoff.baselineName ?? handoff.metadata.baselineNames[0] ?? "none"}`);
  lines.push(`summary: ${handoff.summary}`);
  if (handoff.topReasons.length > 0) {
    lines.push("top reasons:");
    for (const [index, reason] of handoff.topReasons.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. [${reason.severity}] ${normalizeInlineText(reason.summary)}`);
    }
  }
  if (handoff.blockingDiagnostics) {
    lines.push(
      `blocking diagnostics: introduced ${handoff.blockingDiagnostics.introducedCount}, resolved ${handoff.blockingDiagnostics.resolvedCount}, persisted ${handoff.blockingDiagnostics.persistedCount}`,
    );
  }
  appendLatestArtifactPointers(lines, selection);
  return lines.join("\n");
}

function renderReleaseHandoffFailures(
  selection: VerifierReleaseHandoffSelection,
): string {
  const lines = [
    "Verifier Release Handoff Failures",
    `reference: ${selection.reference ?? "latest"}`,
  ];
  if (!selection.available || !selection.handoff) {
    lines.push(`available: no`);
    lines.push(`reason: ${selection.reason ?? "No verifier release handoff is available."}`);
    appendLatestArtifactPointers(lines, selection);
    return lines.join("\n");
  }
  const handoff = selection.handoff;
  lines.push(`handoff: ${handoff.metadata.handoffId}`);
  lines.push(`source: ${handoff.metadata.sourceKind}`);
  lines.push(`status: ${handoff.metadata.status}`);
  if (handoff.topReasons.length === 0) {
    lines.push("no release regression reasons.");
  } else {
    lines.push("top reasons:");
    for (const [index, reason] of handoff.topReasons.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. [${reason.severity}] ${normalizeInlineText(reason.summary)}`);
    }
  }
  if (handoff.blockingDiagnostics) {
    lines.push(`blocking diagnostics: ${handoff.blockingDiagnostics.summary}`);
    appendFingerprintSection(lines, "introduced diagnostics:", handoff.blockingDiagnostics.introduced);
    appendFingerprintSection(lines, "persisted diagnostics:", handoff.blockingDiagnostics.persisted);
    appendFingerprintSection(lines, "resolved diagnostics:", handoff.blockingDiagnostics.resolved);
  }
  appendLatestArtifactPointers(lines, selection);
  return lines.join("\n");
}

function renderReleaseBundleSummary(
  record: VerifierReleaseBundleRecord,
): string {
  return [
    "Verifier Bundle",
    `bundle: ${record.metadata.bundleId}`,
    `created: ${record.metadata.createdAt}`,
    `handoff: ${record.metadata.handoffId}`,
    `source: ${record.metadata.sourceKind}`,
    `primary artifact: ${record.metadata.primaryArtifactId ?? "none"}`,
    `bundle path: ${record.metadata.bundlePath}`,
    `summary path: ${record.metadata.summaryPath ?? "none"}`,
    `artifacts: ${record.metadata.artifactIds.join(", ") || "none"}`,
    `summary: ${record.metadata.summary}`,
  ].join("\n");
}

function renderArtifactPruneSummary(
  result: VerifierInspectArtifactPruneResult,
): string {
  const lines = [
    "Verifier Artifact Prune",
    `dry run: ${result.dryRun ? "yes" : "no"}`,
    `max artifact count: ${result.policy.maxArtifactCount}`,
    `max artifact age days: ${result.policy.maxArtifactAgeDays ?? "none"}`,
    `kept: ${result.keptCount}`,
    `deleted: ${result.deletedCount}`,
    `summary: ${result.summary}`,
  ];
  if (result.deleted.length > 0) {
    lines.push("top deletions:");
    for (const [index, entry] of result.deleted.slice(0, MAX_RENDER_LIST_PREVIEW).entries()) {
      lines.push(`${index + 1}. ${entry.kind} ${entry.id}`);
      lines.push(`   ${normalizeInlineText(entry.reason)}`);
    }
  }
  return lines.join("\n");
}

function appendLatestArtifactPointers(
  lines: string[],
  selection: VerifierReleaseHandoffSelection,
): void {
  lines.push(`latest artifact: ${selection.latestArtifactId ?? "none"}`);
  lines.push(`latest gate artifact: ${selection.latestGateArtifactId ?? "none"}`);
  lines.push(`latest eval artifact: ${selection.latestEvalArtifactId ?? "none"}`);
}

function createReportPreamble(
  report: VerifierInspectReport,
  title: string,
): string[] {
  return [
    title,
    `scope: ${report.scope}`,
    `session: ${report.sessionId ?? "none"}`,
    `trace: ${report.traceId ?? "none"}`,
    `final outcome: ${report.summary.finalOutcome}`,
  ];
}

function collectRenderableFailures(report: VerifierInspectReport): RenderFailureEntry[] {
  const latestAttempt = report.latest.repairLoop?.attempts.at(-1) ?? null;
  const directiveItems = latestAttempt?.directive?.items ?? [];
  if (directiveItems.length > 0) {
    return directiveItems
      .slice()
      .sort(compareDirectiveItems)
      .map((item) => ({
        path: item.path,
        line: item.line,
        column: item.column,
        code: item.code,
        category: item.category,
        message: item.message,
        fixHintCount: item.fixHints.length,
        recommendedFixHintCount: item.fixHints.filter((entry) => entry.recommended).length,
        codeActionCount: item.codeActions.length,
        allowlistedCodeActionCount: item.codeActions.filter((entry) => entry.allowlisted).length,
        projectContext: item.projectContext,
      }));
  }

  const failedRun = findLatestFailedVerifierRun(report);
  if (!failedRun) {
    return [];
  }

  return failedRun.checks
    .filter((check) => check.status === "failed")
    .flatMap((check) => {
      const findings = check.findings.filter((entry) => entry.status === "failed" && entry.severity === "error");
      if (findings.length === 0) {
        return [{
          path: check.filePath ?? null,
          line: null,
          column: null,
          code: null,
          category: check.category ?? null,
          message: check.summary,
          fixHintCount: 0,
          recommendedFixHintCount: 0,
          codeActionCount: 0,
          allowlistedCodeActionCount: 0,
          projectContext: null,
        }];
      }
      return findings.map((finding) => toRenderableFailureFromFinding(check, finding));
    })
    .sort(compareFailureEntries);
}

function collectRenderableFileGroups(report: VerifierInspectReport): RepairDirectiveFileGroup[] {
  const latestAttempt = report.latest.repairLoop?.attempts.at(-1) ?? null;
  const directiveGroups = latestAttempt?.directive?.fileGroups ?? [];
  if (directiveGroups.length > 0) {
    return directiveGroups.slice().sort(compareRenderableFileGroups);
  }
  const failedRun = findLatestFailedVerifierRun(report);
  if (!failedRun) {
    return [];
  }
  const diagnosticsCheck = failedRun.checks.find((check) => check.kind === "diagnostics" && check.projectContext);
  if (!diagnosticsCheck?.projectContext) {
    return aggregateFallbackFileGroups(failedRun);
  }
  const groups = new Map<string, RepairDirectiveFileGroup>();
  for (const item of diagnosticsCheck.projectContext.items) {
    const key = item.path ?? "(no path)";
    const existing = groups.get(key) ?? {
      path: item.path,
      itemCount: 0,
      diagnosticCount: 0,
      hintCount: 0,
      recommendedHintCount: 0,
      codeActionCount: 0,
      allowlistedCodeActionCount: 0,
      projectContextCount: 0,
      categories: [],
      codes: [],
      items: [],
      definitions: [],
      implementations: [],
      documentSymbols: [],
      hintGroup: null,
      codeActions: [],
    };
    existing.projectContextCount += 1;
    existing.definitions.push(...item.definitions.map((entry) => ({ ...entry })));
    existing.implementations.push(...item.implementations.map((entry) => ({ ...entry })));
    existing.documentSymbols.push(...item.documentSymbols.map((entry) => ({ ...entry })));
    if (item.code) {
      existing.codes.push(item.code);
    }
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      codes: uniqueStrings(group.codes).sort(),
      definitions: dedupeDefinitions(group.definitions),
      implementations: dedupeImplementations(group.implementations),
      documentSymbols: dedupeDocumentSymbols(group.documentSymbols),
    }))
    .sort(compareRenderableFileGroups);
}

function aggregateFallbackFileGroups(run: VerifierRunRecord): RepairDirectiveFileGroup[] {
  const groups = new Map<string, RepairDirectiveFileGroup>();
  for (const check of run.checks.filter((entry) => entry.status === "failed")) {
    for (const finding of check.findings.filter((entry) => entry.status === "failed")) {
      const key = finding.path ?? check.filePath ?? "(no path)";
      const existing = groups.get(key) ?? {
        path: finding.path ?? check.filePath ?? null,
        itemCount: 0,
        diagnosticCount: 0,
        hintCount: 0,
        recommendedHintCount: 0,
        codeActionCount: 0,
        allowlistedCodeActionCount: 0,
        projectContextCount: 0,
        categories: [],
        codes: [],
        items: [],
        definitions: [],
        implementations: [],
        documentSymbols: [],
        hintGroup: null,
        codeActions: [],
      };
      existing.itemCount += 1;
      existing.diagnosticCount += 1;
      if (finding.category) {
        existing.categories.push(finding.category);
      }
      if (finding.code) {
        existing.codes.push(finding.code);
      }
      groups.set(key, existing);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      categories: uniqueCategories(group.categories),
      codes: uniqueStrings(group.codes).sort(),
    }))
    .sort(compareRenderableFileGroups);
}

function findLatestFailedVerifierRun(report: VerifierInspectReport): VerifierRunRecord | null {
  for (let index = report.verifierRuns.length - 1; index >= 0; index -= 1) {
    if (report.verifierRuns[index]?.summary.status === "failed") {
      return report.verifierRuns[index];
    }
  }
  return null;
}

function toRenderableFailureFromFinding(
  check: VerifierCheckResult,
  finding: VerifierFinding,
): RenderFailureEntry {
  return {
    path: finding.path ?? check.filePath ?? null,
    line: finding.line ?? null,
    column: finding.column ?? null,
    code: finding.code ?? null,
    category: finding.category ?? check.category ?? null,
    message: finding.message,
    fixHintCount: 0,
    recommendedFixHintCount: 0,
    codeActionCount: 0,
    allowlistedCodeActionCount: 0,
    projectContext: null,
  };
}

function compareDirectiveItems(left: RepairDirectiveItem, right: RepairDirectiveItem): number {
  return compareValueLists(
    [
      categoryPriority(left.category),
      left.path ?? "",
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
      left.code ?? "",
      normalizeInlineText(left.message),
    ],
    [
      categoryPriority(right.category),
      right.path ?? "",
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
      right.code ?? "",
      normalizeInlineText(right.message),
    ],
  );
}

function compareFailureEntries(left: RenderFailureEntry, right: RenderFailureEntry): number {
  return compareValueLists(
    [
      categoryPriority(left.category),
      left.path ?? "",
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
      left.code ?? "",
      normalizeInlineText(left.message),
    ],
    [
      categoryPriority(right.category),
      right.path ?? "",
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
      right.code ?? "",
      normalizeInlineText(right.message),
    ],
  );
}

function compareRenderableFileGroups(left: RepairDirectiveFileGroup, right: RepairDirectiveFileGroup): number {
  return compareValueLists(
    [
      -Number(left.diagnosticCount ?? 0),
      -Number(left.itemCount ?? 0),
      -Number(left.codeActionCount ?? 0),
      -Number(left.projectContextCount ?? 0),
      left.path ?? "",
    ],
    [
      -Number(right.diagnosticCount ?? 0),
      -Number(right.itemCount ?? 0),
      -Number(right.codeActionCount ?? 0),
      -Number(right.projectContextCount ?? 0),
      right.path ?? "",
    ],
  );
}

function categoryPriority(category: VerifierFailureCategory | null): number {
  switch (category) {
    case "syntax_error":
      return 0;
    case "config_error":
      return 1;
    case "diagnostic_error":
      return 2;
    case "command_failed":
      return 3;
    case "timeout":
      return 4;
    default:
      return 9;
  }
}

function compareValueLists(
  left: Array<string | number>,
  right: Array<string | number>,
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return leftValue - rightValue;
    }
    return `${leftValue ?? ""}`.localeCompare(`${rightValue ?? ""}`);
  }
  return 0;
}

function formatLocation(
  filePath: string | null,
  line: number | null,
  column: number | null,
): string {
  const base = filePath ?? "(no path)";
  if (line != null && column != null) {
    return `${base}:${line}:${column}`;
  }
  if (line != null) {
    return `${base}:${line}`;
  }
  return base;
}

function formatDefinitionList(definitions: ProjectContextDefinition[]): string {
  const list = dedupeDefinitions(definitions).slice(0, MAX_RENDER_LIST_PREVIEW);
  return formatListWithRemainder(
    list.map((entry) =>
      `${entry.name ?? "(anonymous)"}@${entry.line ?? "?"}:${entry.column ?? "?"}`,
    ),
    dedupeDefinitions(definitions).length,
  );
}

function formatImplementationList(implementations: ProjectContextImplementation[]): string {
  const list = dedupeImplementations(implementations).slice(0, MAX_RENDER_LIST_PREVIEW);
  return formatListWithRemainder(
    list.map((entry) => formatLocation(entry.path, entry.line, entry.column)),
    dedupeImplementations(implementations).length,
  );
}

function formatDocumentSymbolList(documentSymbols: ProjectContextDocumentSymbol[]): string {
  const list = dedupeDocumentSymbols(documentSymbols).slice(0, MAX_RENDER_LIST_PREVIEW);
  return formatListWithRemainder(
    list.map((entry) => entry.name ?? "(anonymous)"),
    dedupeDocumentSymbols(documentSymbols).length,
  );
}

function formatListWithRemainder(items: string[], total: number): string {
  const rendered = items.join(", ");
  return total > items.length
    ? `${rendered} (+${total - items.length} more)`
    : rendered;
}

function appendFingerprintSection(
  lines: string[],
  label: string,
  entries: DiagnosticFingerprint[],
): void {
  if (entries.length === 0) {
    return;
  }
  lines.push(label);
  for (const [index, entry] of entries.slice(0, MAX_RENDER_FAILURES).entries()) {
    lines.push(
      `${index + 1}. ${formatLocation(entry.path, entry.line, entry.column)}`
        + `${entry.code ? ` ${entry.code}` : ""}`,
    );
    lines.push(`   ${normalizeInlineText(entry.message)}`);
  }
  if (entries.length > MAX_RENDER_FAILURES) {
    lines.push(`... ${entries.length - MAX_RENDER_FAILURES} more diagnostic(s) omitted`);
  }
}

function appendGateReasons(
  lines: string[],
  reasons: VerifierRegressionGateDecision["reasons"],
  failuresOnly: boolean,
): void {
  const filtered = reasons.filter((entry) => !failuresOnly || entry.severity === "failure");
  if (filtered.length === 0) {
    return;
  }
  const failures = filtered.filter((entry) => entry.severity === "failure");
  const notices = filtered.filter((entry) => entry.severity === "notice");
  if (failures.length > 0) {
    lines.push("failure reasons:");
    for (const [index, entry] of failures.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. ${entry.kind}`);
      lines.push(`   ${entry.summary}`);
    }
    if (failures.length > MAX_RENDER_GATE_REASONS) {
      lines.push(`... ${failures.length - MAX_RENDER_GATE_REASONS} more failure reason(s) omitted`);
    }
  }
  if (!failuresOnly && notices.length > 0) {
    lines.push("notices:");
    for (const [index, entry] of notices.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. ${entry.kind}`);
      lines.push(`   ${entry.summary}`);
    }
    if (notices.length > MAX_RENDER_GATE_REASONS) {
      lines.push(`... ${notices.length - MAX_RENDER_GATE_REASONS} more notice(s) omitted`);
    }
  }
}

function renderBaselinePromotionSummary(
  record: VerifierBaselinePromotionPlanRecord,
): string {
  return [
    "Verifier Promotion Plan",
    `plan: ${record.planId}`,
    `baseline: ${record.baselineName}`,
    `scope: ${record.baselineScope.channel}${record.baselineScope.branchScope ? ` @ ${record.baselineScope.branchScope}` : ""}`,
    `source: ${record.candidate.source.sourceKind}:${record.candidate.source.artifactId ?? "none"}`,
    `target snapshot: ${record.candidate.targetSnapshotId}`,
    `policy profile: ${record.candidate.policyProfileId ?? "default"}`,
    `policy inheritance: ${record.policyInheritanceSource}`,
    `decision: ${record.decision.status}`,
    `block reason: ${record.decision.blockReason ?? "none"}`,
    `approval: ${record.approvalStatus}`,
    `approval actor: ${record.approval?.actor.displayName ?? record.approval?.actor.id ?? "none"}`,
    `approval source: ${record.approval?.source ?? "none"}`,
    `approval mode: ${record.approval?.approvalMode ?? "none"}`,
    `handoff: ${record.handoffId ?? "none"}`,
    `summary: ${record.summary}`,
  ].join("\n");
}

function renderBaselinePromotionFailures(
  record: VerifierBaselinePromotionPlanRecord,
): string {
  const lines = [
    "Verifier Promotion Failures",
    `plan: ${record.planId}`,
    `baseline: ${record.baselineName}`,
    `scope: ${record.baselineScope.channel}${record.baselineScope.branchScope ? ` @ ${record.baselineScope.branchScope}` : ""}`,
    `decision: ${record.decision.status}`,
    `policy inheritance: ${record.decision.policyInheritanceSource}`,
    `block reason: ${record.decision.blockReason ?? "none"}`,
    `approval: ${record.approvalStatus}`,
  ];
  const failures = record.decision.reasons.filter((entry) => entry.severity === "failure");
  if (failures.length === 0) {
    lines.push("failures: none");
  } else {
    lines.push("failures:");
    for (const [index, entry] of failures.entries()) {
      lines.push(`${index + 1}. ${entry.kind}`);
      lines.push(`   ${entry.summary}`);
    }
  }
  if (record.decision.blockingEvidence?.blockingDiagnostics) {
    lines.push(`blocking diagnostics: ${record.decision.blockingEvidence.blockingDiagnostics.summary}`);
  }
  lines.push(
    `eligibility evidence: source ${record.decision.eligibilityEvidence.sourceKind};`
      + ` changes ${record.decision.eligibilityEvidence.sourceHasChanges ? "yes" : "no"};`
      + ` error delta ${record.decision.eligibilityEvidence.diagnosticErrorDelta ?? "n/a"};`
      + ` introduced blocking ${record.decision.eligibilityEvidence.blockingDiagnosticIntroducedCount ?? "n/a"}`,
  );
  return lines.join("\n");
}

function renderBaselinePromotionHistorySummary(
  history: VerifierBaselinePromotionHistory,
): string {
  const lines = [
    "Verifier Promotion History",
    `baseline: ${history.baselineName}`,
    `total: ${history.total}`,
  ];
  if (history.items.length === 0) {
    lines.push("history: none");
    return lines.join("\n");
  }
  for (const [index, entry] of history.items.slice(0, MAX_RENDER_LIST_PREVIEW).entries()) {
    lines.push(
      `${index + 1}. ${entry.promotionId}; ${entry.previousSnapshotId} -> ${entry.nextSnapshotId}; policy ${entry.previousPolicyProfileId ?? "default"} -> ${entry.nextPolicyProfileId ?? "default"}`,
    );
  }
  if (history.items.length > MAX_RENDER_LIST_PREVIEW) {
    lines.push(`... ${history.items.length - MAX_RENDER_LIST_PREVIEW} more promotion(s) omitted`);
  }
  return lines.join("\n");
}

function renderReleaseTriageCompactSummary(
  summary: VerifierReleaseTriageSummary,
): string {
  return [
    "Verifier Triage",
    `available: ${summary.available ? "yes" : "no"}`,
    `source: ${summary.sourceKind}`,
    `status: ${summary.status}`,
    `policy profile: ${summary.policyProfileId ?? "none"}`,
    `baseline: ${summary.baselineReferenceLabel ?? summary.baselineName ?? "none"}`,
    `target: ${summary.targetReferenceLabel ?? "none"}`,
    `promotion: ${summary.promotionStatus}${summary.promotionSummary ? `; ${summary.promotionSummary}` : ""}`,
    `artifacts: ${summary.artifactIds.join(", ") || "none"}`,
    `bundle: ${summary.bundleId ?? "none"}`,
    `top affected files: ${summary.topAffectedFiles.map((entry) => entry.path).join(", ") || "none"}`,
    `github mutation: ${summary.githubMutation ? `${summary.githubMutation.status}; ${summary.githubMutation.response?.checkRunId ?? "no-check-run"}` : "none"}`,
    `summary: ${summary.summary}`,
  ].join("\n");
}

function renderReleaseTriageFailures(
  summary: VerifierReleaseTriageSummary,
): string {
  const lines = [
    "Verifier Triage Failures",
    `available: ${summary.available ? "yes" : "no"}`,
    `status: ${summary.status}`,
    `promotion: ${summary.promotionStatus}`,
  ];
  if (summary.topReasons.length === 0) {
    lines.push("reasons: none");
  } else {
    lines.push("top reasons:");
    for (const [index, reason] of summary.topReasons.entries()) {
      lines.push(`${index + 1}. [${reason.severity}] ${reason.kind}`);
      lines.push(`   ${reason.summary}`);
    }
  }
  if (summary.blockingDiagnostics) {
    lines.push(`blocking diagnostics: ${summary.blockingDiagnostics.summary}`);
  }
  if (summary.topAffectedFiles.length > 0) {
    lines.push("top affected files:");
    for (const [index, entry] of summary.topAffectedFiles.entries()) {
      lines.push(`${index + 1}. ${entry.path}`);
      lines.push(`   introduced ${entry.introducedCount}, persisted ${entry.persistedCount}, total ${entry.totalCount}`);
    }
  }
  if (summary.githubMutation) {
    lines.push(`github mutation: ${summary.githubMutation.status}${summary.githubMutation.reason ? `; ${summary.githubMutation.reason}` : ""}`);
  }
  return lines.join("\n");
}

function renderGitHubChecksSummary(
  payload: VerifierGitHubChecksPayload,
): string {
  return [
    "Verifier GitHub Checks",
    `available: ${payload.available ? "yes" : "no"}`,
    `conclusion: ${payload.conclusion}`,
    `policy profile: ${payload.policyProfileId ?? "none"}`,
    `baseline: ${payload.baselineReferenceLabel ?? "none"}`,
    `target: ${payload.targetReferenceLabel ?? "none"}`,
    `handoff: ${payload.handoffId ?? "none"}`,
    `annotations: ${payload.annotations.length}/${payload.annotationTotal}`,
    `bundle: ${payload.bundleId ?? "none"}`,
    `top affected files: ${payload.topAffectedFiles.map((entry) => entry.path).join(", ") || "none"}`,
    `summary: ${payload.summary}`,
  ].join("\n");
}

function renderGitHubMutationSummary(
  result: VerifierGitHubMutationRecord,
): string {
  return [
    "Verifier GitHub Mutation",
    `mutation: ${result.mutationId}`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `action: ${result.request.action ?? "none"}`,
    `handoff: ${result.handoffId ?? "none"}`,
    `check run: ${result.response?.checkRunId ?? "none"}`,
    `reason: ${result.reason ?? "none"}`,
    `summary: ${result.summary}`,
  ].join("\n");
}

function renderGitHubMutationFailures(
  result: VerifierGitHubMutationRecord,
): string {
  return [
    "Verifier GitHub Mutation Failures",
    `mutation: ${result.mutationId}`,
    `status: ${result.status}`,
    `reason kind: ${result.reasonKind ?? "none"}`,
    `reason: ${result.reason ?? "none"}`,
    `handoff: ${result.handoffId ?? "none"}`,
    `check run: ${result.response?.checkRunId ?? "none"}`,
  ].join("\n");
}

function renderVerifierDrilldownSummary(
  report: VerifierDrilldownReport,
): string {
  const lines = [
    "Verifier Drilldown",
    `available: ${report.available ? "yes" : "no"}`,
    `source: ${report.sourceKind}`,
    `reference: ${report.reference}`,
    `handoff source: ${report.handoffSourceKind}`,
    `handoff status: ${report.handoffStatus}`,
    `promotion: ${report.promotionStatus}`,
    `policy profile: ${report.policyProfileId ?? "none"}`,
    `final outcome: ${report.finalOutcome ?? "none"}`,
    `latest verifier: ${report.latestVerifierStatus ?? "none"}`,
    `latest repair: ${report.latestRepairStatus ?? "none"}`,
    `primary artifact: ${report.primaryArtifactId ?? report.latestArtifactId ?? "none"}`,
    `handoff: ${report.handoffId ?? "none"}`,
    `bundle: ${report.bundleId ?? "none"}`,
    `github mutation: ${formatDrilldownMutation(report.githubMutation)}`,
  ];
  if (report.topReasons.length > 0) {
    lines.push("top reasons:");
    for (const [index, reason] of report.topReasons.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. [${reason.severity}/${reason.source}] ${normalizeInlineText(reason.summary)}`);
    }
  } else {
    lines.push("top reasons: none");
  }
  if (report.topAffectedFiles.length > 0) {
    lines.push(
      `top affected files: ${report.topAffectedFiles
        .slice(0, MAX_RENDER_FILE_GROUPS)
        .map((entry) => `${entry.path} (${entry.totalCount})`)
        .join(", ")}`,
    );
  } else {
    lines.push("top affected files: none");
  }
  if (report.blockingDiagnostics) {
    lines.push(
      `blocking diagnostics: current ${report.blockingDiagnostics.currentCount}, introduced ${report.blockingDiagnostics.introducedCount}, persisted ${report.blockingDiagnostics.persistedCount}, resolved ${report.blockingDiagnostics.resolvedCount}`,
    );
    lines.push(`blocking summary: ${report.blockingDiagnostics.summary}`);
  } else {
    lines.push("blocking diagnostics: none");
  }
  lines.push("next commands:");
  if (report.recommendedCommands.length === 0) {
    lines.push("1. none");
  } else {
    for (const suggestion of report.recommendedCommands) {
      lines.push(`${suggestion.priority}. ${suggestion.command}`);
      lines.push(`   ${suggestion.reason}`);
    }
  }
  lines.push(`summary: ${report.summary}`);
  return lines.join("\n");
}

function renderVerifierDrilldownFailures(
  report: VerifierDrilldownReport,
): string {
  const lines = [
    "Verifier Drilldown Failures",
    `available: ${report.available ? "yes" : "no"}`,
    `source: ${report.sourceKind}`,
    `reference: ${report.reference}`,
    `handoff status: ${report.handoffStatus}`,
    `promotion: ${report.promotionStatus}`,
  ];
  if (report.reason) {
    lines.push(`reason: ${report.reason}`);
  }
  if (report.topReasons.length === 0) {
    lines.push("top reasons: none");
  } else {
    lines.push("top reasons:");
    for (const [index, reason] of report.topReasons.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. [${reason.severity}/${reason.source}] ${reason.kind}`);
      lines.push(`   ${normalizeInlineText(reason.summary)}`);
    }
  }
  if (report.topAffectedFiles.length > 0) {
    lines.push("top affected files:");
    for (const [index, entry] of report.topAffectedFiles.slice(0, MAX_RENDER_FILE_GROUPS).entries()) {
      lines.push(`${index + 1}. ${entry.path}`);
      lines.push(`   introduced ${entry.introducedCount}, persisted ${entry.persistedCount}, total ${entry.totalCount}`);
    }
  }
  if (report.blockingDiagnostics) {
    lines.push(`blocking diagnostics: ${report.blockingDiagnostics.summary}`);
    appendFingerprintSection(lines, "current diagnostics:", report.blockingDiagnostics.current);
    appendFingerprintSection(lines, "introduced diagnostics:", report.blockingDiagnostics.introduced);
    appendFingerprintSection(lines, "persisted diagnostics:", report.blockingDiagnostics.persisted);
    appendFingerprintSection(lines, "resolved diagnostics:", report.blockingDiagnostics.resolved);
  }
  lines.push(`primary artifact: ${report.primaryArtifactId ?? report.latestArtifactId ?? "none"}`);
  lines.push(`handoff: ${report.handoffId ?? "none"}`);
  lines.push(`bundle: ${report.bundleId ?? "none"}`);
  lines.push(`github mutation: ${formatDrilldownMutation(report.githubMutation)}`);
  lines.push("next commands:");
  if (report.recommendedCommands.length === 0) {
    lines.push("1. none");
  } else {
    for (const suggestion of report.recommendedCommands) {
      lines.push(`${suggestion.priority}. ${suggestion.command}`);
      lines.push(`   ${suggestion.reason}`);
    }
  }
  return lines.join("\n");
}

function renderVerifierTimelineSummary(
  report: VerifierTimelineReport,
): string {
  const lines = [
    "Verifier Timeline",
    `available: ${report.available ? "yes" : "no"}`,
    `source: ${report.sourceKind}`,
    `reference: ${report.reference}`,
    `latest state: ${report.latestStateSummary}`,
    `focus event: ${report.primaryIssueEventId ?? "none"}`,
    `artifact: ${report.continuity.primaryArtifactId ?? report.continuity.latestArtifactId ?? "none"}`,
    `handoff: ${report.continuity.handoffId ?? "none"}`,
    `bundle: ${report.continuity.bundleId ?? "none"}`,
    `baseline: ${report.continuity.baselineName ?? "none"}`,
    `github mutation: ${report.continuity.githubMutationId ?? "none"}`,
  ];
  if (report.focus.topReasons.length > 0) {
    lines.push("top reasons:");
    for (const [index, reason] of report.focus.topReasons.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. [${reason.severity}/${reason.source}] ${normalizeInlineText(reason.summary)}`);
    }
  } else {
    lines.push("top reasons: none");
  }
  if (report.focus.topAffectedFiles.length > 0) {
    lines.push(
      `top affected files: ${report.focus.topAffectedFiles
        .slice(0, MAX_RENDER_FILE_GROUPS)
        .map((entry) => `${entry.path} (${entry.totalCount})`)
        .join(", ")}`,
    );
  } else {
    lines.push("top affected files: none");
  }
  lines.push("leading events:");
  if (report.events.length === 0) {
    lines.push("1. none");
  } else {
    for (const [index, event] of report.events.entries()) {
      lines.push(`${index + 1}. [${event.status}] ${event.kind} ${normalizeInlineText(event.summary)}`);
      lines.push(`   ids: ${formatTimelineLinkedIds(event)}`);
    }
  }
  lines.push("next commands:");
  if (report.recommendedCommands.length === 0) {
    lines.push("1. none");
  } else {
    for (const suggestion of report.recommendedCommands) {
      lines.push(`${suggestion.priority}. ${suggestion.command}`);
      lines.push(`   ${suggestion.reason}`);
    }
  }
  lines.push(`summary: ${report.summary}`);
  return lines.join("\n");
}

function renderVerifierTimelineFailures(
  report: VerifierTimelineReport,
): string {
  const lines = [
    "Verifier Timeline Failures",
    `available: ${report.available ? "yes" : "no"}`,
    `source: ${report.sourceKind}`,
    `reference: ${report.reference}`,
    `focus event: ${report.primaryIssueEventId ?? "none"}`,
  ];
  if (report.reason) {
    lines.push(`reason: ${report.reason}`);
  }
  lines.push(`latest state: ${report.latestStateSummary}`);
  if (report.focus.topReasons.length > 0) {
    lines.push("top reasons:");
    for (const [index, reason] of report.focus.topReasons.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. [${reason.severity}/${reason.source}] ${reason.kind}`);
      lines.push(`   ${normalizeInlineText(reason.summary)}`);
    }
  } else {
    lines.push("top reasons: none");
  }
  if (report.focus.blockingDiagnostics) {
    lines.push(`blocking diagnostics: ${report.focus.blockingDiagnostics.summary}`);
    appendFingerprintSection(lines, "current diagnostics:", report.focus.blockingDiagnostics.current);
    appendFingerprintSection(lines, "introduced diagnostics:", report.focus.blockingDiagnostics.introduced);
    appendFingerprintSection(lines, "persisted diagnostics:", report.focus.blockingDiagnostics.persisted);
  } else {
    lines.push("blocking diagnostics: none");
  }
  lines.push("leading events:");
  const failureEvents = report.events.filter((event) => event.status === "failure" || event.status === "unavailable");
  if (failureEvents.length === 0) {
    lines.push("1. none");
  } else {
    for (const [index, event] of failureEvents.slice(0, MAX_RENDER_GATE_REASONS).entries()) {
      lines.push(`${index + 1}. [${event.status}] ${event.kind}`);
      lines.push(`   ${normalizeInlineText(event.summary)}`);
      lines.push(`   ids: ${formatTimelineLinkedIds(event)}`);
    }
  }
  lines.push(`artifact: ${report.continuity.primaryArtifactId ?? report.continuity.latestArtifactId ?? "none"}`);
  lines.push(`handoff: ${report.continuity.handoffId ?? "none"}`);
  lines.push(`bundle: ${report.continuity.bundleId ?? "none"}`);
  lines.push(`baseline: ${report.continuity.baselineName ?? "none"}`);
  lines.push(`github mutation: ${report.continuity.githubMutationId ?? "none"}`);
  lines.push("next commands:");
  if (report.recommendedCommands.length === 0) {
    lines.push("1. none");
  } else {
    for (const suggestion of report.recommendedCommands) {
      lines.push(`${suggestion.priority}. ${suggestion.command}`);
      lines.push(`   ${suggestion.reason}`);
    }
  }
  return lines.join("\n");
}

function formatTimelineLinkedIds(
  event: VerifierTimelineEvent,
): string {
  const pairs = [
    event.linkedIds.verifierRunId ? `verifier:${event.linkedIds.verifierRunId}` : null,
    event.linkedIds.repairLoopId ? `repair:${event.linkedIds.repairLoopId}` : null,
    event.linkedIds.artifactId ? `artifact:${event.linkedIds.artifactId}` : null,
    event.linkedIds.handoffId ? `handoff:${event.linkedIds.handoffId}` : null,
    event.linkedIds.bundleId ? `bundle:${event.linkedIds.bundleId}` : null,
    event.linkedIds.baselineName ? `baseline:${event.linkedIds.baselineName}` : null,
    event.linkedIds.promotionId ? `promotion:${event.linkedIds.promotionId}` : null,
    event.linkedIds.mutationId ? `mutation:${event.linkedIds.mutationId}` : null,
  ].filter((entry): entry is string => entry != null);
  return pairs.join(", ") || "none";
}

function formatDrilldownMutation(
  mutation: VerifierDrilldownReport["githubMutation"],
): string {
  if (!mutation) {
    return "none";
  }
  return mutation.reason
    ? `${mutation.status}; ${mutation.reason}`
    : `${mutation.status}; ${mutation.response?.checkRunId ?? "no-check-run"}`;
}

function formatTransition(before: string, after: string): string {
  return before === after
    ? before
    : `${before} -> ${after}`;
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function formatBooleanTransition(before: boolean, after: boolean): string {
  return before === after
    ? `${before ? "yes" : "no"}`
    : `${before ? "yes" : "no"} -> ${after ? "yes" : "no"}`;
}

function formatRepairTransition(report: VerifierInspectCompareReport): string {
  const left = report.left.report.summary.latestRepairStatus === "none"
    ? report.summary.latestRepairStatus.before
    : `${report.summary.latestRepairStatus.before} (${report.summary.latestRepairProgress.before})`;
  const right = report.right.report.summary.latestRepairStatus === "none"
    ? report.summary.latestRepairStatus.after
    : `${report.summary.latestRepairStatus.after} (${report.summary.latestRepairProgress.after})`;
  return left === right
    ? left
    : `${left} -> ${right}`;
}

function formatCountTransition(delta: { before: number; after: number; delta: number }): string {
  return `${delta.before} -> ${delta.after} (${formatSignedDelta(delta.delta)})`;
}

function formatSignedDelta(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  return `${value}`;
}

function normalizeInlineText(value: string): string {
  return `${value}`.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((entry) => typeof entry === "string" && entry.length > 0))];
}

function uniqueCategories(values: VerifierFailureCategory[]): VerifierFailureCategory[] {
  return [...new Set(values)];
}

function dedupeDefinitions(definitions: ProjectContextDefinition[]): ProjectContextDefinition[] {
  const seen = new Map<string, ProjectContextDefinition>();
  for (const entry of definitions) {
    const key = JSON.stringify([
      entry.path,
      entry.line,
      entry.column,
      entry.endLine,
      entry.endColumn,
      entry.kind,
      entry.name,
      entry.containerName,
    ]);
    if (!seen.has(key)) {
      seen.set(key, { ...entry });
    }
  }
  return [...seen.values()].sort((left, right) =>
    compareValueLists(
      [
        left.path ?? "",
        left.line ?? Number.MAX_SAFE_INTEGER,
        left.column ?? Number.MAX_SAFE_INTEGER,
        left.name ?? "",
        left.kind ?? "",
      ],
      [
        right.path ?? "",
        right.line ?? Number.MAX_SAFE_INTEGER,
        right.column ?? Number.MAX_SAFE_INTEGER,
        right.name ?? "",
        right.kind ?? "",
      ],
    ));
}

function dedupeImplementations(implementations: ProjectContextImplementation[]): ProjectContextImplementation[] {
  const seen = new Map<string, ProjectContextImplementation>();
  for (const entry of implementations) {
    const key = JSON.stringify([
      entry.path,
      entry.line,
      entry.column,
      entry.endLine,
      entry.endColumn,
      entry.contextStartLine,
      entry.contextStartColumn,
      entry.contextEndLine,
      entry.contextEndColumn,
    ]);
    if (!seen.has(key)) {
      seen.set(key, { ...entry });
    }
  }
  return [...seen.values()].sort((left, right) =>
    compareValueLists(
      [
        left.path ?? "",
        left.line ?? Number.MAX_SAFE_INTEGER,
        left.column ?? Number.MAX_SAFE_INTEGER,
        left.contextStartLine ?? Number.MAX_SAFE_INTEGER,
        left.contextStartColumn ?? Number.MAX_SAFE_INTEGER,
      ],
      [
        right.path ?? "",
        right.line ?? Number.MAX_SAFE_INTEGER,
        right.column ?? Number.MAX_SAFE_INTEGER,
        right.contextStartLine ?? Number.MAX_SAFE_INTEGER,
        right.contextStartColumn ?? Number.MAX_SAFE_INTEGER,
      ],
    ));
}

function dedupeDocumentSymbols(documentSymbols: ProjectContextDocumentSymbol[]): ProjectContextDocumentSymbol[] {
  const seen = new Map<string, ProjectContextDocumentSymbol>();
  for (const entry of documentSymbols) {
    const key = JSON.stringify([
      entry.path,
      entry.line,
      entry.column,
      entry.endLine,
      entry.endColumn,
      entry.name,
      entry.kind,
      entry.kindModifiers,
      entry.containerName,
      entry.depth,
    ]);
    if (!seen.has(key)) {
      seen.set(key, { ...entry });
    }
  }
  return [...seen.values()].sort((left, right) =>
    compareValueLists(
      [
        left.depth,
        left.path ?? "",
        left.line ?? Number.MAX_SAFE_INTEGER,
        left.column ?? Number.MAX_SAFE_INTEGER,
        left.name ?? "",
        left.kind ?? "",
      ],
      [
        right.depth,
        right.path ?? "",
        right.line ?? Number.MAX_SAFE_INTEGER,
        right.column ?? Number.MAX_SAFE_INTEGER,
        right.name ?? "",
        right.kind ?? "",
      ],
    ));
}
