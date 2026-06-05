import path from "node:path";
import ts from "typescript";

import {
  cloneCodeActionCandidate,
  cloneCodeActionCollection,
  createUnavailableCodeActionCollection,
  selectPreferredCodeActionCandidate,
} from "./code-action-assist.mjs";
import {
  compareDiagnosticSnapshotToVerifierRun,
  createDiagnosticFingerprint,
  createDiagnosticSnapshotFromVerifierRun,
} from "./agent-verifier.mjs";

import type {
  CodeActionApplyResult,
  CodeActionCandidate,
  CodeActionCollection,
  DiagnosticProjectContext,
  FixHint,
  FixHintCollection,
  ProjectContextCollection,
  ProjectContextDefinition,
  ProjectContextDocumentSymbol,
  ProjectContextImplementation,
  RepairAttemptConvergenceRecord,
  RepairDecision,
  RepairDirective,
  RepairDirectiveFileGroup,
  RepairDirectiveHintGroup,
  RepairDirectiveItem,
  RepairLoopRecord,
  RepairLoopSummary,
  RepairProgressState,
  RepairStopReason,
  RepairStatus,
  VerifierCheckResult,
  VerifierFailureCategory,
  VerifierFinding,
  VerifierRunRecord,
} from "../types/contracts.js";

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 1;

const MAX_REPAIR_ITEMS = 8;
const MAX_REPAIR_FILE_DEFINITIONS = 3;
const MAX_REPAIR_FILE_IMPLEMENTATIONS = 3;
const MAX_REPAIR_FILE_DOCUMENT_SYMBOLS = 4;
const ACTIONABLE_FAILURE_CATEGORIES = new Set<VerifierFailureCategory>([
  "syntax_error",
  "diagnostic_error",
  "config_error",
  "command_failed",
  "timeout",
]);

interface ProjectContextIndex {
  byFingerprint: Map<string, DiagnosticProjectContext>;
  byReducedKey: Map<string, DiagnosticProjectContext>;
}

interface RepairFailureDecisionInput {
  cwd: string;
  verifierRun: VerifierRunRecord;
  existingLoop?: RepairLoopRecord | null;
  maxAttempts?: number;
  remainingSteps?: number;
}

export function decideRepairLoopOnVerifierFailure(
  input: RepairFailureDecisionInput,
): {
  repairLoop: RepairLoopRecord;
  decision: RepairDecision;
} {
  const now = new Date().toISOString();
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
  const repairLoop = cloneRepairLoop(input.existingLoop) ?? createRepairLoopRecord({
    verifierRun: input.verifierRun,
    maxAttempts,
    startedAt: now,
  });

  closeRetryingAttemptAsFailed(repairLoop, input.verifierRun, now);

  const directiveItems = collectActionableDirectiveItems(input.verifierRun);
  const actionable = directiveItems.length > 0;
  const attemptsUsed = repairLoop.attempts.length;

  if (!actionable) {
    const summary = "Repair loop stopped because the verifier failure did not expose actionable typed findings.";
    const decision: RepairDecision = {
      decision: "stop",
      status: "stopped",
      stopReason: "no_actionable_findings",
      attempt: attemptsUsed,
      maxAttempts,
      actionable: false,
      summary,
      directive: null,
    };
    repairLoop.finishedAt = now;
    repairLoop.summary = createRepairSummary({
      status: "stopped",
      attemptsUsed,
      maxAttempts,
      lastDecision: "stop",
      stopReason: "no_actionable_findings",
      triggeredByVerifierStartedAt: repairLoop.initialVerifierStartedAt,
      attempts: repairLoop.attempts,
      summary,
    });
    return { repairLoop, decision };
  }

  if (attemptsUsed >= maxAttempts) {
    const summary = `Repair loop exhausted after ${attemptsUsed}/${maxAttempts} attempt(s); verification is still failing.`;
    const decision: RepairDecision = {
      decision: "stop",
      status: "exhausted",
      stopReason: "attempts_exhausted",
      attempt: attemptsUsed,
      maxAttempts,
      actionable: true,
      summary,
      directive: null,
    };
    repairLoop.finishedAt = now;
    repairLoop.summary = createRepairSummary({
      status: "exhausted",
      attemptsUsed,
      maxAttempts,
      lastDecision: "stop",
      stopReason: "attempts_exhausted",
      triggeredByVerifierStartedAt: repairLoop.initialVerifierStartedAt,
      attempts: repairLoop.attempts,
      summary,
    });
    return { repairLoop, decision };
  }

  if ((input.remainingSteps ?? 0) <= 0) {
    const summary = "Repair loop stopped because the current turn has no remaining step budget for another repair attempt.";
    const decision: RepairDecision = {
      decision: "stop",
      status: "stopped",
      stopReason: "max_steps_reached",
      attempt: attemptsUsed,
      maxAttempts,
      actionable: true,
      summary,
      directive: null,
    };
    repairLoop.finishedAt = now;
    repairLoop.summary = createRepairSummary({
      status: "stopped",
      attemptsUsed,
      maxAttempts,
      lastDecision: "stop",
      stopReason: "max_steps_reached",
      triggeredByVerifierStartedAt: repairLoop.initialVerifierStartedAt,
      attempts: repairLoop.attempts,
      summary,
    });
    return { repairLoop, decision };
  }

  const attempt = attemptsUsed + 1;
  const directive = buildRepairDirective({
    cwd: input.cwd,
    verifierRun: input.verifierRun,
    items: directiveItems,
    attempt,
    maxAttempts,
  });
  const continuationMessage = renderRepairContinuationMessage(directive, input.cwd);
  const retrySummary = `Repair attempt ${attempt}/${maxAttempts} started from verifier failure.`;
  repairLoop.attempts.push({
    attempt,
    startedAt: now,
    finishedAt: null,
    status: "retrying",
    summary: retrySummary,
    decision: "retry",
    directive,
    triggerVerifierStartedAt: input.verifierRun.startedAt,
    triggerVerifierStep: input.verifierRun.step,
    triggerVerifierSummary: input.verifierRun.summary.summary,
    baselineDiagnostics: createDiagnosticSnapshotFromVerifierRun(input.verifierRun),
    convergence: null,
    codeAction: null,
    continuationMessage,
  });
  repairLoop.finishedAt = null;
  repairLoop.summary = createRepairSummary({
    status: "retrying",
    attemptsUsed: repairLoop.attempts.length,
    maxAttempts,
    lastDecision: "retry",
    stopReason: null,
    triggeredByVerifierStartedAt: repairLoop.initialVerifierStartedAt,
    attempts: repairLoop.attempts,
    summary: retrySummary,
  });

  return {
    repairLoop,
    decision: {
      decision: "retry",
      status: "retrying",
      stopReason: null,
      attempt,
      maxAttempts,
      actionable: true,
      summary: retrySummary,
      directive,
    },
  };
}

export function finalizeRepairLoopOnVerifierPass(input: {
  repairLoop: RepairLoopRecord | null;
  verifierRun: VerifierRunRecord;
}): RepairLoopRecord | null {
  if (!input.repairLoop) {
    return null;
  }

  const repairLoop = cloneRepairLoop(input.repairLoop);
  if (!repairLoop) {
    return null;
  }
  const lastAttempt = repairLoop.attempts.at(-1);
  if (!lastAttempt || lastAttempt.status !== "retrying") {
    return repairLoop;
  }

  const now = new Date().toISOString();
  lastAttempt.finishedAt = now;
  lastAttempt.status = "succeeded";
  const convergence = createRepairAttemptConvergence(lastAttempt, input.verifierRun);
  lastAttempt.convergence = convergence;
  lastAttempt.summary = `Repair attempt ${lastAttempt.attempt}/${repairLoop.maxAttempts} succeeded: ${input.verifierRun.summary.summary} ${convergence.summary}`.trim();
  lastAttempt.resultVerifierStartedAt = input.verifierRun.startedAt;
  lastAttempt.resultVerifierStep = input.verifierRun.step;
  lastAttempt.resultVerifierSummary = input.verifierRun.summary.summary;
  repairLoop.finishedAt = now;
  repairLoop.summary = createRepairSummary({
    status: "succeeded",
    attemptsUsed: repairLoop.attempts.length,
    maxAttempts: repairLoop.maxAttempts,
    lastDecision: "stop",
    stopReason: null,
    triggeredByVerifierStartedAt: repairLoop.initialVerifierStartedAt,
    attempts: repairLoop.attempts,
    summary: `Repair loop succeeded after ${repairLoop.attempts.length} attempt(s).`,
  });
  return repairLoop;
}

export function finalizeRepairLoopOnTurnFailure(input: {
  repairLoop: RepairLoopRecord | null;
  status: "failed" | "stopped";
  stopReason: RepairStopReason;
  summary: string;
}): RepairLoopRecord | null {
  if (!input.repairLoop) {
    return null;
  }

  const repairLoop = cloneRepairLoop(input.repairLoop);
  if (!repairLoop) {
    return null;
  }

  const now = new Date().toISOString();
  const lastAttempt = repairLoop.attempts.at(-1);
  if (lastAttempt?.status === "retrying") {
    lastAttempt.finishedAt = now;
    lastAttempt.status = input.status;
    lastAttempt.summary = input.summary;
  }

  repairLoop.finishedAt = now;
  repairLoop.summary = createRepairSummary({
    status: input.status,
    attemptsUsed: repairLoop.attempts.length,
    maxAttempts: repairLoop.maxAttempts,
    lastDecision: "stop",
    stopReason: input.stopReason,
    triggeredByVerifierStartedAt: repairLoop.initialVerifierStartedAt,
    attempts: repairLoop.attempts,
    summary: input.summary,
  });
  return repairLoop;
}

export function selectRepairCodeActionCandidate(
  repairLoop: RepairLoopRecord | null,
): CodeActionCandidate | null {
  const directive = repairLoop?.attempts.at(-1)?.directive ?? null;
  if (!directive) {
    return null;
  }
  const candidate = selectPreferredCodeActionCandidate(directive.codeActions);
  return candidate ? cloneCodeActionCandidate(candidate) : null;
}

export function recordRepairCodeActionResult(input: {
  repairLoop: RepairLoopRecord | null;
  result: CodeActionApplyResult;
  continuationMessage?: string | null;
}): RepairLoopRecord | null {
  if (!input.repairLoop) {
    return null;
  }

  const repairLoop = cloneRepairLoop(input.repairLoop);
  if (!repairLoop) {
    return null;
  }
  const lastAttempt = repairLoop.attempts.at(-1);
  if (!lastAttempt) {
    return repairLoop;
  }

  lastAttempt.codeAction = {
    ...input.result,
    touchedFiles: [...input.result.touchedFiles],
  };
  if (input.continuationMessage != null) {
    lastAttempt.continuationMessage = input.continuationMessage;
  }
  repairLoop.summary = createRepairSummary({
    status: repairLoop.summary.status,
    attemptsUsed: repairLoop.summary.attemptsUsed,
    maxAttempts: repairLoop.maxAttempts,
    lastDecision: repairLoop.summary.lastDecision,
    stopReason: repairLoop.summary.stopReason,
    triggeredByVerifierStartedAt: repairLoop.initialVerifierStartedAt,
    attempts: repairLoop.attempts,
    summary: repairLoop.summary.summary,
  });
  return repairLoop;
}

export function renderRepairContinuationMessage(
  directive: RepairDirective,
  cwd: string,
): string {
  const lines = [
    `Verification failed. Continue this same turn with repair attempt ${directive.attempt}/${directive.maxAttempts}.`,
    "Do not claim success until verification passes again.",
    directive.summary,
    "",
    "Most actionable verifier findings:",
  ];

  for (const item of directive.items.slice(0, MAX_REPAIR_ITEMS)) {
    const location = renderDirectiveItemLocation(item, cwd);
    const category = item.category ? `${item.category}` : "verifier_issue";
    const code = item.code ? ` ${item.code}` : "";
    const command = item.command ? ` command=${item.command}` : "";
    lines.push(`- [${item.kind}/${category}] ${location}${code}${command} ${item.message}`.trim());
    for (const hint of item.fixHints.slice(0, 2)) {
      const hintFiles = hint.filePaths.length > 0
        ? ` files=${hint.filePaths.map((entry) => toDisplayPath(entry, cwd)).join(",")}`
        : "";
      lines.push(`  suggested fix (${hint.kind}${hint.recommended ? ", recommended" : ""}): ${hint.title}${hintFiles}`);
    }
    for (const action of item.codeActions.slice(0, 2)) {
      const actionFiles = action.filePaths.length > 0
        ? ` files=${action.filePaths.map((entry) => toDisplayPath(entry, cwd)).join(",")}`
        : "";
      const gating = action.allowlisted
        ? `allowlisted via ${action.allowlistRule ?? "rule"}`
        : `blocked=${action.blockedReason ?? "not_allowlisted"}`;
      lines.push(`  code action (${action.kind}${action.recommended ? ", recommended" : ""}, ${gating}): ${action.title}${actionFiles}`);
    }
    if (item.projectContext?.quickInfo?.displayText) {
      lines.push(`  symbol context: ${item.projectContext.quickInfo.displayText}`);
    }
    if (item.projectContext?.enclosingSymbol?.name) {
      const symbolKind = item.projectContext.enclosingSymbol.kind
        ? `${item.projectContext.enclosingSymbol.kind} `
        : "";
      lines.push(`  enclosing scope: ${symbolKind}${item.projectContext.enclosingSymbol.name}`);
    }
    if ((item.projectContext?.definitions.length ?? 0) > 0) {
      const definition = item.projectContext?.definitions[0] ?? null;
      if (definition?.path) {
        lines.push(`  definition: ${toDisplayPath(definition.path, cwd)}:${definition.line ?? 1}:${definition.column ?? 1}`);
      }
    }
    if ((item.projectContext?.implementationCount ?? 0) > 0) {
      const implementation = item.projectContext?.implementations[0] ?? null;
      const implementationLabel = implementation?.path
        ? `${toDisplayPath(implementation.path, cwd)}:${implementation.line ?? 1}:${implementation.column ?? 1}`
        : `${item.projectContext?.implementationCount ?? 0} implementation(s)`;
      lines.push(
        `  implementations: ${item.projectContext?.implementationCount ?? 0}${item.projectContext?.implementationsTruncated ? "+" : ""} total; e.g. ${implementationLabel}`,
      );
    }
    if ((item.projectContext?.referenceCount ?? 0) > 0) {
      const reference = item.projectContext?.references[0] ?? null;
      const referenceLabel = reference?.path
        ? `${toDisplayPath(reference.path, cwd)}:${reference.line ?? 1}:${reference.column ?? 1}`
        : `${item.projectContext?.referenceCount ?? 0} related references`;
      lines.push(
        `  references: ${item.projectContext?.referenceCount ?? 0}${item.projectContext?.referencesTruncated ? "+" : ""} total; e.g. ${referenceLabel}`,
      );
    }
    if ((item.projectContext?.documentSymbolCount ?? 0) > 0) {
      const symbolPreview = (item.projectContext?.documentSymbols ?? [])
        .slice(0, 2)
        .map((documentSymbol) => documentSymbol.name)
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .join(", ");
      lines.push(
        `  nearby symbols: ${item.projectContext?.documentSymbolCount ?? 0}${item.projectContext?.documentSymbolsTruncated ? "+" : ""} total${symbolPreview ? `; e.g. ${symbolPreview}` : ""}`,
      );
    }
  }

  if (directive.filePaths.length > 0) {
    lines.push("");
    lines.push(`Relevant files: ${directive.filePaths.map((entry) => toDisplayPath(entry, cwd)).join(", ")}`);
  }
  if (directive.commands.length > 0) {
    lines.push(`Related verifier commands: ${directive.commands.join(" | ")}`);
  }
  if (!directive.fixHints.summary.available) {
    lines.push(`Fix hints unavailable: ${directive.fixHints.summary.reason ?? "No tsserver fix-hint data was recorded."}`);
  } else if (directive.fixHints.summary.total > 0) {
    lines.push(
      `Fix hints: ${directive.fixHints.summary.total} total, ${directive.fixHints.summary.recommendedCount} recommended across ${directive.fixHints.summary.fileCount} file(s).`,
    );
  }
  if (!directive.codeActions.summary.available) {
    lines.push(`Code actions unavailable: ${directive.codeActions.summary.reason ?? "No code-action data was recorded."}`);
  } else if (directive.codeActions.summary.total > 0) {
    lines.push(
      `Code actions: ${directive.codeActions.summary.total} candidate(s), ${directive.codeActions.summary.allowlistedCount} allowlisted, ${directive.codeActions.summary.blockedCount} blocked.`,
    );
  }
  if (!directive.projectContext.summary.available) {
    lines.push(`Project context unavailable: ${directive.projectContext.summary.reason ?? "No tsserver project context was recorded."}`);
  } else if (directive.projectContext.summary.total > 0) {
    lines.push(
      `Project context: ${directive.projectContext.summary.total} diagnostic-linked item(s), ${directive.projectContext.summary.definitionCount} definition(s), ${directive.projectContext.summary.implementationCount} implementation(s), ${directive.projectContext.summary.referenceCount} reference(s), ${directive.projectContext.summary.documentSymbolCount} document symbol(s).`,
    );
  }

  lines.push("");
  lines.push(directive.instruction);
  return lines.join("\n");
}

function createRepairLoopRecord(input: {
  verifierRun: VerifierRunRecord;
  maxAttempts: number;
  startedAt: string;
}): RepairLoopRecord {
  return {
    traceId: input.verifierRun.traceId,
    startedAt: input.startedAt,
    finishedAt: null,
    maxAttempts: input.maxAttempts,
    initialVerifierStartedAt: input.verifierRun.startedAt,
    initialVerifierStep: input.verifierRun.step,
    initialFailureCategories: [...input.verifierRun.summary.failureCategories],
    attempts: [],
    summary: createRepairSummary({
      status: "stopped",
      attemptsUsed: 0,
      maxAttempts: input.maxAttempts,
      lastDecision: null,
      stopReason: null,
      triggeredByVerifierStartedAt: input.verifierRun.startedAt,
      attempts: [],
      summary: "Repair loop not evaluated yet.",
    }),
  };
}

function createRepairSummary(input: {
  status: RepairStatus;
  attemptsUsed: number;
  maxAttempts: number;
  lastDecision: RepairDecision["decision"] | null;
  stopReason: RepairDecision["stopReason"];
  triggeredByVerifierStartedAt: string | null;
  attempts: RepairLoopRecord["attempts"];
  summary: string;
}): RepairLoopSummary {
  const progress = summarizeRepairProgress(input.attempts);
  return {
    status: input.status,
    attemptsUsed: input.attemptsUsed,
    maxAttempts: input.maxAttempts,
    attemptsRemaining: Math.max(0, input.maxAttempts - input.attemptsUsed),
    lastDecision: input.lastDecision,
    stopReason: input.stopReason,
    triggeredByVerifierStartedAt: input.triggeredByVerifierStartedAt,
    latestProgress: progress.latestProgress,
    progressTrend: progress.progressTrend,
    resolvedAttemptCount: progress.resolvedAttemptCount,
    improvedAttemptCount: progress.improvedAttemptCount,
    unchangedAttemptCount: progress.unchangedAttemptCount,
    regressedAttemptCount: progress.regressedAttemptCount,
    notApplicableAttemptCount: progress.notApplicableAttemptCount,
    resolvedDiagnosticCount: progress.resolvedDiagnosticCount,
    persistedDiagnosticCount: progress.persistedDiagnosticCount,
    introducedDiagnosticCount: progress.introducedDiagnosticCount,
    codeActionAppliedCount: progress.codeActionAppliedCount,
    codeActionBlockedCount: progress.codeActionBlockedCount,
    latestCodeActionStatus: progress.latestCodeActionStatus,
    summary: input.summary,
  };
}

function closeRetryingAttemptAsFailed(
  repairLoop: RepairLoopRecord,
  verifierRun: VerifierRunRecord,
  finishedAt: string,
): void {
  const lastAttempt = repairLoop.attempts.at(-1);
  if (!lastAttempt || lastAttempt.status !== "retrying") {
    return;
  }

  const convergence = createRepairAttemptConvergence(lastAttempt, verifierRun);
  lastAttempt.finishedAt = finishedAt;
  lastAttempt.status = "failed";
  lastAttempt.convergence = convergence;
  lastAttempt.summary = `Repair attempt ${lastAttempt.attempt}/${repairLoop.maxAttempts} failed: ${verifierRun.summary.summary} ${convergence.summary}`.trim();
  lastAttempt.resultVerifierStartedAt = verifierRun.startedAt;
  lastAttempt.resultVerifierStep = verifierRun.step;
  lastAttempt.resultVerifierSummary = verifierRun.summary.summary;
}

function buildRepairDirective(input: {
  cwd: string;
  verifierRun: VerifierRunRecord;
  items: RepairDirectiveItem[];
  attempt: number;
  maxAttempts: number;
}): RepairDirective {
  const fixHints = resolveVerifierFixHints(input.verifierRun);
  const codeActions = resolveVerifierCodeActions(input.verifierRun);
  const projectContext = resolveVerifierProjectContext(input.verifierRun);
  const failedChecks = input.verifierRun.checks
    .filter((check) => check.status === "failed")
    .map((check) => ({
      id: check.id,
      kind: check.kind,
      label: check.label,
      category: check.category ?? null,
      summary: check.summary,
      filePath: check.filePath ?? null,
      command: check.command?.command ?? null,
    }));
  const filePaths = uniqueStrings(
    input.items
      .map((item) => item.path)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const commands = uniqueStrings(
    failedChecks
      .map((check) => check.command)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const failureKinds = uniqueStrings(
    failedChecks.map((check) => `${check.kind}/${check.category ?? "unknown"}`),
  );
  const fileGroups = buildRepairDirectiveFileGroups(input.items, fixHints, codeActions);
  const hintGroups = fileGroups
    .map((group) => group.hintGroup)
    .filter((group): group is RepairDirectiveHintGroup => group != null);

  return {
    traceId: input.verifierRun.traceId,
    verifierRunStartedAt: input.verifierRun.startedAt,
    verifierStep: input.verifierRun.step,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    summary: `Verifier failed on ${failureKinds.join(", ")}. Repair the concrete issues below and keep verification in mind.`,
    instruction: "Use the normal tool path to fix the issues above. After you think the fix is complete, respond normally; verification will run again automatically.",
    failureCategories: [...input.verifierRun.summary.failureCategories],
    failedChecks,
    items: input.items.slice(0, MAX_REPAIR_ITEMS),
    fileGroups,
    fixHints,
    hintGroups,
    codeActions,
    projectContext,
    filePaths,
    commands,
  };
}

function collectActionableDirectiveItems(verifierRun: VerifierRunRecord): RepairDirectiveItem[] {
  const fixHintIndex = indexFixHintsByFingerprint(resolveVerifierFixHints(verifierRun));
  const codeActionIndex = indexCodeActionsByFingerprint(resolveVerifierCodeActions(verifierRun));
  const projectContextIndex = indexProjectContextByFingerprint(resolveVerifierProjectContext(verifierRun));
  const groupedItems = new Map<string, RepairDirectiveItem>();
  const order: string[] = [];

  for (const check of verifierRun.checks.filter((entry) => entry.status === "failed")) {
    const findings = collectActionableFindingsFromCheck(check);
    const sourceItems = findings.length > 0
      ? findings.map((finding) =>
          buildDirectiveItemFromFinding(check, finding, fixHintIndex, codeActionIndex, projectContextIndex)
        )
      : [buildDirectiveItemFromCheck(check)];

    for (const item of sourceItems) {
      if (!item || !isActionableDirectiveItem(item)) {
        continue;
      }
      const key = item.fingerprint ?? JSON.stringify([
        item.kind,
        item.category,
        item.path,
        item.line,
        item.column,
        item.code,
        item.command,
        item.message,
      ]);
      const existing = groupedItems.get(key);
      if (existing) {
        existing.occurrenceCount += item.occurrenceCount;
        existing.related = mergeRelatedLocations(existing.related, item.related);
        existing.fixHints = mergeFixHints(existing.fixHints, item.fixHints);
        existing.codeActions = mergeCodeActions(existing.codeActions, item.codeActions);
        existing.projectContext ??= item.projectContext;
        continue;
      }
      order.push(key);
      groupedItems.set(key, item);
    }
  }

  return order
    .map((entry) => groupedItems.get(entry))
    .filter((entry): entry is RepairDirectiveItem => entry != null)
    .sort(compareRepairDirectiveItems)
    .slice(0, MAX_REPAIR_ITEMS);
}

function collectActionableFindingsFromCheck(check: VerifierCheckResult): VerifierFinding[] {
  return check.findings.filter((finding) => {
    if (finding.severity !== "error" || finding.status !== "failed") {
      return false;
    }
    if (finding.category && ACTIONABLE_FAILURE_CATEGORIES.has(finding.category)) {
      return true;
    }
    return check.category != null && ACTIONABLE_FAILURE_CATEGORIES.has(check.category);
  });
}

function buildDirectiveItemFromFinding(
  check: VerifierCheckResult,
  finding: VerifierFinding,
  fixHintIndex: Map<string, FixHint[]>,
  codeActionIndex: Map<string, CodeActionCandidate[]>,
  projectContextIndex: ProjectContextIndex,
): RepairDirectiveItem {
  const fingerprint = createDiagnosticFingerprint({
    path: finding.path ?? check.filePath ?? null,
    line: finding.line ?? null,
    column: finding.column ?? null,
    code: finding.code ?? null,
    message: finding.message,
    source: finding.source ?? null,
    scope: finding.scope ?? null,
    category: finding.category ?? check.category ?? null,
    rule: finding.rule ?? null,
  }).fingerprint;
  return {
    checkId: check.id,
    checkLabel: check.label,
    kind: check.kind,
    category: finding.category ?? check.category ?? null,
    severity: finding.severity,
    path: finding.path ?? check.filePath ?? null,
    line: finding.line ?? null,
    column: finding.column ?? null,
    code: finding.code ?? null,
    source: finding.source ?? null,
    scope: finding.scope ?? null,
    rule: finding.rule ?? null,
    command: check.command?.command ?? null,
    fingerprint,
    occurrenceCount: 1,
    message: finding.message,
    excerpt: finding.excerpt ?? null,
    related: (finding.related ?? []).map((entry) => ({
      path: entry.path ?? null,
      line: entry.line ?? null,
      column: entry.column ?? null,
      message: entry.message ?? null,
    })),
    fixHints: cloneFixHints(fixHintIndex.get(fingerprint) ?? []),
    codeActions: cloneCodeActions(codeActionIndex.get(fingerprint) ?? []),
    projectContext: resolveProjectContextForFinding(check, finding, fingerprint, projectContextIndex),
  };
}

function buildDirectiveItemFromCheck(check: VerifierCheckResult): RepairDirectiveItem {
  return {
    checkId: check.id,
    checkLabel: check.label,
    kind: check.kind,
    category: check.category ?? null,
    severity: "error",
    path: check.filePath ?? null,
    line: null,
    column: null,
    code: null,
    source: null,
    scope: null,
    rule: null,
    command: check.command?.command ?? null,
    fingerprint: null,
    occurrenceCount: 1,
    message: check.summary,
    excerpt: null,
    related: [],
    fixHints: [],
    codeActions: [],
    projectContext: null,
  };
}

function isActionableDirectiveItem(item: RepairDirectiveItem): boolean {
  return item.category != null && ACTIONABLE_FAILURE_CATEGORIES.has(item.category);
}

function renderDirectiveItemLocation(item: RepairDirectiveItem, cwd: string): string {
  const locationBase = item.path ? toDisplayPath(item.path, cwd) : item.checkLabel;
  if (item.line != null && item.column != null) {
    return `${locationBase}:${item.line}:${item.column}`;
  }
  if (item.line != null) {
    return `${locationBase}:${item.line}`;
  }
  return locationBase;
}

function compareRepairDirectiveItems(
  left: RepairDirectiveItem,
  right: RepairDirectiveItem,
): number {
  return compareRepairValues(
    [
      getRepairCategoryPriority(left.category),
      left.path ?? "",
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
      left.code ?? "",
      left.message,
    ],
    [
      getRepairCategoryPriority(right.category),
      right.path ?? "",
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
      right.code ?? "",
      right.message,
    ],
  );
}

function getRepairCategoryPriority(category: VerifierFailureCategory | null): number {
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

function aggregateFileGroupDefinitions(items: RepairDirectiveItem[]): ProjectContextDefinition[] {
  const grouped = new Map<string, ProjectContextDefinition>();
  for (const definition of items.flatMap((item) => item.projectContext?.definitions ?? [])) {
    const key = JSON.stringify([
      definition.path,
      definition.line,
      definition.column,
      definition.endLine,
      definition.endColumn,
      definition.kind,
      definition.name,
      definition.containerName,
    ]);
    if (!grouped.has(key)) {
      grouped.set(key, { ...definition });
    }
  }
  return [...grouped.values()]
    .sort(compareProjectContextDefinitions)
    .slice(0, MAX_REPAIR_FILE_DEFINITIONS);
}

function aggregateFileGroupImplementations(items: RepairDirectiveItem[]): ProjectContextImplementation[] {
  const grouped = new Map<string, ProjectContextImplementation>();
  for (const implementation of items.flatMap((item) => item.projectContext?.implementations ?? [])) {
    const key = JSON.stringify([
      implementation.path,
      implementation.line,
      implementation.column,
      implementation.endLine,
      implementation.endColumn,
      implementation.contextStartLine,
      implementation.contextStartColumn,
      implementation.contextEndLine,
      implementation.contextEndColumn,
    ]);
    if (!grouped.has(key)) {
      grouped.set(key, { ...implementation });
    }
  }
  return [...grouped.values()]
    .sort(compareProjectContextImplementations)
    .slice(0, MAX_REPAIR_FILE_IMPLEMENTATIONS);
}

function aggregateFileGroupDocumentSymbols(items: RepairDirectiveItem[]): ProjectContextDocumentSymbol[] {
  const grouped = new Map<string, ProjectContextDocumentSymbol>();
  for (const documentSymbol of items.flatMap((item) => item.projectContext?.documentSymbols ?? [])) {
    const key = JSON.stringify([
      documentSymbol.path,
      documentSymbol.line,
      documentSymbol.column,
      documentSymbol.endLine,
      documentSymbol.endColumn,
      documentSymbol.name,
      documentSymbol.kind,
      documentSymbol.kindModifiers,
      documentSymbol.containerName,
      documentSymbol.depth,
    ]);
    if (!grouped.has(key)) {
      grouped.set(key, { ...documentSymbol });
    }
  }
  return [...grouped.values()]
    .sort(compareProjectContextDocumentSymbols)
    .slice(0, MAX_REPAIR_FILE_DOCUMENT_SYMBOLS);
}

function cloneRepairLoop(value: RepairLoopRecord | null | undefined): RepairLoopRecord | null {
  return value ? structuredClone(value) : null;
}

function normalizeMaxAttempts(value: number | undefined): number {
  return Number.isFinite(value) && value != null && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_MAX_REPAIR_ATTEMPTS;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((entry) => typeof entry === "string" && entry.length > 0))];
}

function mergeRelatedLocations(
  left: RepairDirectiveItem["related"],
  right: RepairDirectiveItem["related"],
): RepairDirectiveItem["related"] {
  const merged = [...left];
  for (const entry of right) {
    const key = JSON.stringify([entry.path, entry.line, entry.column, entry.message]);
    if (merged.some((candidate) => JSON.stringify([candidate.path, candidate.line, candidate.column, candidate.message]) === key)) {
      continue;
    }
    merged.push(entry);
  }
  return merged;
}

function buildRepairDirectiveFileGroups(
  items: RepairDirectiveItem[],
  fixHints: FixHintCollection,
  codeActions: CodeActionCollection,
): RepairDirectiveFileGroup[] {
  const groups = new Map<string, RepairDirectiveFileGroup>();
  const order: string[] = [];

  for (const item of items) {
    const key = item.path ?? "__unknown__";
    if (!groups.has(key)) {
      order.push(key);
      groups.set(key, {
        path: item.path ?? null,
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
      });
    }
    const group = groups.get(key);
    if (!group) {
      continue;
    }
    group.itemCount += 1;
    group.diagnosticCount += Math.max(1, item.occurrenceCount);
    if (item.category && !group.categories.includes(item.category)) {
      group.categories.push(item.category);
    }
    if (item.code && !group.codes.includes(item.code)) {
      group.codes.push(item.code);
    }
    group.items.push(item);
  }

  return order
    .map((entry) => groups.get(entry))
    .filter((entry): entry is RepairDirectiveFileGroup => entry != null)
    .map((group) => {
      const hintGroup = buildRepairDirectiveHintGroup(group, fixHints);
      const definitions = aggregateFileGroupDefinitions(group.items);
      const implementations = aggregateFileGroupImplementations(group.items);
      const documentSymbols = aggregateFileGroupDocumentSymbols(group.items);
      return {
        ...group,
        hintCount: hintGroup?.hintCount ?? 0,
        recommendedHintCount: hintGroup?.recommendedHintCount ?? 0,
        hintGroup,
        codeActionCount: dedupeCodeActions(group.items.flatMap((item) => item.codeActions)).length,
        allowlistedCodeActionCount: dedupeCodeActions(group.items.flatMap((item) => item.codeActions))
          .filter((candidate) => candidate.allowlisted).length,
        projectContextCount: group.items.filter((item) => item.projectContext != null).length,
        definitions,
        implementations,
        documentSymbols,
        codeActions: dedupeCodeActions(group.items.flatMap((item) => item.codeActions)),
      };
    });
}

function resolveVerifierFixHints(verifierRun: VerifierRunRecord): FixHintCollection {
  const diagnosticsCheck = verifierRun.checks.find((check) => check.kind === "diagnostics");
  if (diagnosticsCheck?.fixHints) {
    return cloneFixHintCollection(diagnosticsCheck.fixHints);
  }
  return createUnavailableFixHintCollection(
    diagnosticsCheck?.summary
      ? `Fix hints are unavailable for this verifier run: ${diagnosticsCheck.summary}`
      : "Fix hints are unavailable because this verifier run did not record diagnostics assist data.",
  );
}

function resolveVerifierCodeActions(verifierRun: VerifierRunRecord): CodeActionCollection {
  const diagnosticsCheck = verifierRun.checks.find((check) => check.kind === "diagnostics");
  if (diagnosticsCheck?.codeActions) {
    return cloneCodeActionCollection(diagnosticsCheck.codeActions);
  }
  return createUnavailableCodeActionCollection({
    reason: diagnosticsCheck?.summary
      ? `Code actions are unavailable for this verifier run: ${diagnosticsCheck.summary}`
      : "Code actions are unavailable because this verifier run did not record diagnostics action data.",
    transportAvailable: null,
    fallbackUsed: false,
    fallbackReason: null,
  });
}

function resolveVerifierProjectContext(verifierRun: VerifierRunRecord): ProjectContextCollection {
  const diagnosticsCheck = verifierRun.checks.find((check) => check.kind === "diagnostics");
  if (diagnosticsCheck?.projectContext) {
    return cloneProjectContextCollection(diagnosticsCheck.projectContext);
  }
  return createUnavailableProjectContextCollection(
    diagnosticsCheck?.summary
      ? `Project context is unavailable for this verifier run: ${diagnosticsCheck.summary}`
      : "Project context is unavailable because this verifier run did not record transport-backed symbol context.",
  );
}

function indexFixHintsByFingerprint(fixHints: FixHintCollection): Map<string, FixHint[]> {
  const index = new Map<string, FixHint[]>();
  for (const hint of fixHints.hints) {
    for (const fingerprint of hint.diagnosticFingerprints) {
      const grouped = index.get(fingerprint) ?? [];
      grouped.push(cloneFixHint(hint));
      index.set(fingerprint, grouped);
    }
  }
  return index;
}

function indexCodeActionsByFingerprint(codeActions: CodeActionCollection): Map<string, CodeActionCandidate[]> {
  const index = new Map<string, CodeActionCandidate[]>();
  for (const action of codeActions.actions) {
    for (const fingerprint of action.diagnosticFingerprints) {
      const grouped = index.get(fingerprint) ?? [];
      grouped.push(cloneCodeActionCandidate(action));
      index.set(fingerprint, grouped);
    }
  }
  return index;
}

function indexProjectContextByFingerprint(
  projectContext: ProjectContextCollection,
): ProjectContextIndex {
  const byFingerprint = new Map<string, DiagnosticProjectContext>();
  const byReducedKey = new Map<string, DiagnosticProjectContext>();
  for (const item of projectContext.items) {
    const cloned = cloneDiagnosticProjectContext(item);
    if (cloned) {
      byFingerprint.set(item.diagnosticFingerprint, cloned);
      const reducedKey = createProjectContextLookupKey(item);
      if (!byReducedKey.has(reducedKey)) {
        byReducedKey.set(reducedKey, cloneDiagnosticProjectContext(item) ?? cloned);
      }
    }
  }
  return {
    byFingerprint,
    byReducedKey,
  };
}

function resolveProjectContextForFinding(
  check: VerifierCheckResult,
  finding: VerifierFinding,
  fingerprint: string,
  index: ProjectContextIndex,
): DiagnosticProjectContext | null {
  const byFingerprint = index.byFingerprint.get(fingerprint);
  if (byFingerprint) {
    return cloneDiagnosticProjectContext(byFingerprint);
  }
  const reducedKey = createProjectContextLookupKey({
    path: finding.path ?? check.filePath ?? null,
    line: finding.line ?? null,
    column: finding.column ?? null,
    code: finding.code ?? null,
    message: finding.message,
  });
  return cloneDiagnosticProjectContext(index.byReducedKey.get(reducedKey) ?? null);
}

function createProjectContextLookupKey(input: {
  path: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  message: string;
}): string {
  return JSON.stringify([
    normalizeRepairDiagnosticPath(input.path),
    input.line ?? null,
    input.column ?? null,
    input.code ?? null,
    normalizeRepairDiagnosticMessage(input.message),
  ]);
}

function buildRepairDirectiveHintGroup(
  group: RepairDirectiveFileGroup,
  fixHints: FixHintCollection,
): RepairDirectiveHintGroup {
  const diagnosticFingerprints = uniqueStrings(
    group.items
      .map((item) => item.fingerprint)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const hints = dedupeFixHints(
    group.items.flatMap((item) => item.fixHints),
  );
  return {
    path: group.path,
    diagnosticFingerprints,
    source: fixHints.availability.source,
    available: fixHints.availability.available,
    reason: fixHints.availability.reason,
    hintCount: hints.length,
    recommendedHintCount: hints.filter((hint) => hint.recommended).length,
    hints,
  };
}

function cloneFixHints(hints: FixHint[]): FixHint[] {
  return hints.map((hint) => cloneFixHint(hint));
}

function cloneFixHint(hint: FixHint): FixHint {
  return {
    ...hint,
    diagnosticFingerprints: [...hint.diagnosticFingerprints],
    filePaths: [...hint.filePaths],
    edits: hint.edits.map((edit) => ({
      ...edit,
      changes: edit.changes.map((change) => ({ ...change })),
    })),
  };
}

function cloneFixHintCollection(collection: FixHintCollection): FixHintCollection {
  return {
    availability: { ...collection.availability },
    hints: cloneFixHints(collection.hints),
    summary: { ...collection.summary },
  };
}

function createUnavailableFixHintCollection(reason: string): FixHintCollection {
  return {
    availability: {
      available: false,
      source: "unavailable",
      reason,
      transportAvailable: null,
      fallbackUsed: false,
      fallbackReason: null,
    },
    hints: [],
    summary: {
      total: 0,
      recommendedCount: 0,
      fileCount: 0,
      available: false,
      source: "unavailable",
      reason,
    },
  };
}

function cloneDiagnosticProjectContext(
  context: DiagnosticProjectContext | null | undefined,
): DiagnosticProjectContext | null {
  return context
    ? {
        ...context,
        quickInfo: context.quickInfo ? { ...context.quickInfo } : null,
        definitions: context.definitions.map((entry) => ({ ...entry })),
        implementations: context.implementations.map((entry) => ({ ...entry })),
        references: context.references.map((entry) => ({ ...entry })),
        enclosingSymbol: context.enclosingSymbol ? { ...context.enclosingSymbol } : null,
        documentSymbols: context.documentSymbols.map((entry) => ({ ...entry })),
      }
    : null;
}

function cloneProjectContextCollection(
  collection: ProjectContextCollection,
): ProjectContextCollection {
  return {
    availability: { ...collection.availability },
    items: collection.items
      .map((item) => cloneDiagnosticProjectContext(item))
      .filter((item): item is DiagnosticProjectContext => item != null),
    summary: { ...collection.summary },
  };
}

function createUnavailableProjectContextCollection(reason: string): ProjectContextCollection {
  return {
    availability: {
      available: false,
      source: "unavailable",
      reason,
      transportAvailable: null,
      fallbackUsed: false,
      fallbackReason: null,
    },
    items: [],
    summary: {
      total: 0,
      diagnosticCoverageCount: 0,
      quickInfoCount: 0,
      definitionCount: 0,
      implementationCount: 0,
      referenceCount: 0,
      documentSymbolCount: 0,
      fileCount: 0,
      available: false,
      source: "unavailable",
      reason,
    },
  };
}

function mergeFixHints(left: FixHint[], right: FixHint[]): FixHint[] {
  return dedupeFixHints([...left, ...right]);
}

function mergeCodeActions(left: CodeActionCandidate[], right: CodeActionCandidate[]): CodeActionCandidate[] {
  return dedupeCodeActions([...left, ...right]);
}

function dedupeFixHints(hints: FixHint[]): FixHint[] {
  const grouped = new Map<string, FixHint>();
  for (const hint of hints) {
    const existing = grouped.get(hint.id);
    if (!existing) {
      grouped.set(hint.id, cloneFixHint(hint));
      continue;
    }
    existing.recommended ||= hint.recommended;
    existing.diagnosticFingerprints = uniqueStrings([
      ...existing.diagnosticFingerprints,
      ...hint.diagnosticFingerprints,
    ]);
    existing.filePaths = uniqueStrings([
      ...existing.filePaths,
      ...hint.filePaths,
    ]);
  }
  return [...grouped.values()];
}

function compareProjectContextDefinitions(
  left: ProjectContextDefinition,
  right: ProjectContextDefinition,
): number {
  return compareRepairValues(
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
  );
}

function compareProjectContextImplementations(
  left: ProjectContextImplementation,
  right: ProjectContextImplementation,
): number {
  return compareRepairValues(
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
  );
}

function compareProjectContextDocumentSymbols(
  left: ProjectContextDocumentSymbol,
  right: ProjectContextDocumentSymbol,
): number {
  return compareRepairValues(
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
  );
}

function compareRepairValues(
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
    return `${leftValue}`.localeCompare(`${rightValue}`);
  }
  return 0;
}

function normalizeRepairDiagnosticMessage(message: string): string {
  return `${message}`.replace(/\s+/g, " ").trim();
}

function normalizeRepairDiagnosticPath(filePath: string | null): string | null {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return null;
  }
  const resolved = path.resolve(filePath);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

function cloneCodeActions(actions: CodeActionCandidate[]): CodeActionCandidate[] {
  return actions.map((action) => cloneCodeActionCandidate(action));
}

function dedupeCodeActions(actions: CodeActionCandidate[]): CodeActionCandidate[] {
  const grouped = new Map<string, CodeActionCandidate>();
  for (const action of actions) {
    const existing = grouped.get(action.id);
    if (!existing) {
      grouped.set(action.id, cloneCodeActionCandidate(action));
      continue;
    }
    existing.recommended ||= action.recommended;
    existing.allowlisted ||= action.allowlisted;
    existing.allowlistRule ??= action.allowlistRule;
    existing.blockedReason ??= action.blockedReason;
    existing.diagnosticFingerprints = uniqueStrings([
      ...existing.diagnosticFingerprints,
      ...action.diagnosticFingerprints,
    ]);
    existing.filePaths = uniqueStrings([
      ...existing.filePaths,
      ...action.filePaths,
    ]);
  }
  return [...grouped.values()];
}

function createRepairAttemptConvergence(
  attempt: RepairLoopRecord["attempts"][number],
  verifierRun: VerifierRunRecord,
): RepairAttemptConvergenceRecord {
  const delta = compareDiagnosticSnapshotToVerifierRun(attempt.baselineDiagnostics, verifierRun);
  const state = classifyRepairProgress(delta, verifierRun);
  return {
    compared: delta.comparable,
    state,
    summary: renderRepairProgressSummary(state, delta),
    delta,
  };
}

function classifyRepairProgress(
  delta: RepairAttemptConvergenceRecord["delta"],
  verifierRun: VerifierRunRecord,
): RepairProgressState {
  if (!delta?.comparable) {
    return "not_applicable";
  }
  if (verifierRun.summary.status === "passed" && delta.afterErrorCount === 0 && delta.introducedCount === 0) {
    return "resolved";
  }

  const beforeScore = scoreDiagnosticSurface(delta.beforeErrorCount, delta.beforeWarningCount, delta.beforeInfoCount);
  const afterScore = scoreDiagnosticSurface(delta.afterErrorCount, delta.afterWarningCount, delta.afterInfoCount);
  if (afterScore < beforeScore || delta.resolvedCount > delta.introducedCount) {
    return "improved";
  }
  if (afterScore > beforeScore || delta.introducedCount > delta.resolvedCount) {
    return "regressed";
  }
  return "unchanged";
}

function renderRepairProgressSummary(
  state: RepairProgressState,
  delta: RepairAttemptConvergenceRecord["delta"],
): string {
  if (!delta?.comparable) {
    return delta?.summary ?? "Diagnostics delta was not comparable for this repair attempt.";
  }

  const prefix = state === "resolved"
    ? "Repair resolved the blocking diagnostics."
    : state === "improved"
      ? "Repair improved the diagnostics surface."
      : state === "regressed"
        ? "Repair regressed the diagnostics surface."
        : "Repair made no measurable diagnostics progress.";
  return `${prefix} ${delta.summary}`;
}

function scoreDiagnosticSurface(
  errorCount: number,
  warningCount: number,
  infoCount: number,
): number {
  return (errorCount * 100) + (warningCount * 10) + infoCount;
}

function summarizeRepairProgress(
  attempts: RepairLoopRecord["attempts"],
): Pick<RepairLoopSummary,
  | "latestProgress"
  | "progressTrend"
  | "resolvedAttemptCount"
  | "improvedAttemptCount"
  | "unchangedAttemptCount"
  | "regressedAttemptCount"
  | "notApplicableAttemptCount"
  | "resolvedDiagnosticCount"
  | "persistedDiagnosticCount"
  | "introducedDiagnosticCount"
  | "codeActionAppliedCount"
  | "codeActionBlockedCount"
  | "latestCodeActionStatus"
> {
  const completed = attempts.filter((entry) => entry.convergence != null);
  const latestProgress = completed.at(-1)?.convergence?.state ?? "none";
  const latestCodeActionStatus = attempts.at(-1)?.codeAction?.status ?? "none";
  const states = completed
    .map((entry) => entry.convergence?.state)
    .filter((entry): entry is RepairProgressState => typeof entry === "string");
  const uniqueStates = [...new Set(states)];
  const progressTrend = uniqueStates.length === 0
    ? "none"
    : uniqueStates.length === 1
      ? uniqueStates[0]
      : "mixed";
  const convergenceTotals = completed.reduce((accumulator, entry) => {
    const convergence = entry.convergence;
    if (!convergence) {
      return accumulator;
    }
    if (convergence.state === "resolved") {
      accumulator.resolvedAttemptCount += 1;
    } else if (convergence.state === "improved") {
      accumulator.improvedAttemptCount += 1;
    } else if (convergence.state === "unchanged") {
      accumulator.unchangedAttemptCount += 1;
    } else if (convergence.state === "regressed") {
      accumulator.regressedAttemptCount += 1;
    } else {
      accumulator.notApplicableAttemptCount += 1;
    }
    accumulator.resolvedDiagnosticCount += convergence.delta?.resolvedCount ?? 0;
    accumulator.persistedDiagnosticCount += convergence.delta?.persistedCount ?? 0;
    accumulator.introducedDiagnosticCount += convergence.delta?.introducedCount ?? 0;
    return accumulator;
  }, {
    resolvedAttemptCount: 0,
    improvedAttemptCount: 0,
    unchangedAttemptCount: 0,
    regressedAttemptCount: 0,
    notApplicableAttemptCount: 0,
    resolvedDiagnosticCount: 0,
    persistedDiagnosticCount: 0,
    introducedDiagnosticCount: 0,
    codeActionAppliedCount: 0,
    codeActionBlockedCount: 0,
  });

  for (const attempt of attempts) {
    if (attempt.codeAction?.status === "applied") {
      convergenceTotals.codeActionAppliedCount += 1;
    } else if (attempt.codeAction?.status === "blocked") {
      convergenceTotals.codeActionBlockedCount += 1;
    }
  }

  return {
    latestProgress,
    progressTrend,
    latestCodeActionStatus,
    ...convergenceTotals,
  };
}

function toDisplayPath(filePath: string, cwd: string): string {
  const relativePath = path.relative(cwd, filePath);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath
    : filePath;
}
