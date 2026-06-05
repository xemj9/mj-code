import { getInteractiveCommandPalette } from "./command-catalog.mjs";
import {
  deriveInteractiveContinuationDisplayLine,
  isInteractiveSessionPickerRootCommand,
  normalizeInteractiveShellAnswer,
} from "./interactive-shell-commands.mjs";

import type {
  InteractiveCommandPaletteEntry,
  InteractiveCommandPaletteReport,
  InteractiveSelectionPreview,
  InteractiveSessionPickerEntry,
  InteractiveSessionPickerReport,
} from "../types/contracts.js";

type InteractiveShellReport = InteractiveCommandPaletteReport | InteractiveSessionPickerReport;
type InteractiveShellReportEntry = InteractiveCommandPaletteEntry | InteractiveSessionPickerEntry;

export function flattenInteractiveShellEntries(
  report: InteractiveShellReport | null,
): InteractiveShellReportEntry[] {
  if (!report) {
    return [];
  }
  return report.sections.reduce<InteractiveShellReportEntry[]>((entries, section) => {
    entries.push(...section.entries);
    return entries;
  }, []);
}

export function getInteractiveShellSectionStartIndexes(
  report: InteractiveShellReport | null,
): number[] {
  if (!report) {
    return [];
  }
  const indexes: number[] = [];
  let offset = 0;
  for (const section of report.sections) {
    if (section.entries.length > 0) {
      indexes.push(offset);
      offset += section.entries.length;
    }
  }
  return indexes;
}

export function buildInteractiveShellRenderSignature(input: {
  mode: "palette" | "picker";
  query: string | null;
  inputLine: string | null;
  resolverLineOverride: string | null;
  selectedCommand: string | null;
  selectedPreview: InteractiveSelectionPreview | null;
  totalMatches: number | null | undefined;
}): string {
  return JSON.stringify({
    mode: input.mode,
    query: input.query,
    inputLine: input.inputLine,
    resolverLineOverride: input.resolverLineOverride,
    selectedCommand: input.selectedCommand,
    previewFingerprint: buildInteractiveShellPreviewFingerprint(input.selectedPreview),
    totalMatches: input.totalMatches ?? 0,
  });
}

export function buildInteractiveShellVisibleReport(
  report: InteractiveShellReport | null,
  selectedCommand: string | null,
  selectedPreview: InteractiveSelectionPreview | null,
): InteractiveShellReport | null {
  if (!report) {
    return null;
  }
  return {
    ...report,
    fallbackMode: "tty_overlay",
    selectedCommand,
    selectedPreview,
  };
}

export function renderInteractiveShellVisibleFrame(input: {
  mode: "palette" | "picker";
  report: InteractiveShellReport | null;
  selectedCommand: string | null;
  selectedPreview: InteractiveSelectionPreview | null;
  renderPalette: (
    report: InteractiveCommandPaletteReport,
    options: { mode: "text" | "overlay"; selectedCommand?: string | null },
  ) => string;
  renderPicker: (
    report: InteractiveSessionPickerReport,
    options: { mode: "text" | "overlay"; selectedCommand?: string | null },
  ) => string;
}): string | null {
  const visibleReport = buildInteractiveShellVisibleReport(
    input.report,
    input.selectedCommand,
    input.selectedPreview,
  );
  if (!visibleReport) {
    return null;
  }
  return input.mode === "picker"
    ? input.renderPicker(visibleReport as InteractiveSessionPickerReport, {
      mode: "overlay",
      selectedCommand: input.selectedCommand,
    })
    : input.renderPalette(visibleReport as InteractiveCommandPaletteReport, {
      mode: "overlay",
      selectedCommand: input.selectedCommand,
    });
}

export function supportsInteractiveShell(
  input: { isTTY?: boolean } | null | undefined,
  output: { isTTY?: boolean } | null | undefined,
): boolean {
  return Boolean(input?.isTTY && output?.isTTY);
}

export function setInteractiveRawMode(
  input: { setRawMode?: (enabled: boolean) => void } | null | undefined,
  interactivePaletteEnabled: boolean,
  enabled: boolean,
): void {
  if (!interactivePaletteEnabled || typeof input?.setRawMode !== "function") {
    return;
  }
  input.setRawMode(enabled);
}

export function shouldScheduleInteractiveShellSyncFromRawInput(chunk: unknown): boolean {
  const text = Buffer.isBuffer(chunk)
    ? chunk.toString("utf8")
    : typeof chunk === "string"
      ? chunk
      : "";
  if (!text) {
    return false;
  }
  if (text.includes("\u007f")) {
    return true;
  }
  return /[^\x00-\x1f\x7f]/.test(text);
}

export function resolveInteractiveShellAnswer(
  answer: unknown,
  paletteState: {
    visible?: boolean;
    mode?: "palette" | "picker";
    selectedCommand?: string | null;
    currentInputLine?: string | null;
  } | null,
): unknown {
  const trimmedAnswer = typeof answer === "string"
    ? normalizeInteractiveShellAnswer(answer)
    : "";
  if (trimmedAnswer === "/") {
    return getInteractiveCommandPalette().selectedCommand ?? "/status summary";
  }
  if (!trimmedAnswer.startsWith("/") || !paletteState?.visible || !paletteState.selectedCommand) {
    return answer;
  }
  if (!shouldApplyInteractiveShellSelection(trimmedAnswer, paletteState.currentInputLine)) {
    return trimmedAnswer;
  }
  if (paletteState.mode === "picker") {
    return paletteState.selectedCommand;
  }
  if (trimmedAnswer === "/" || !trimmedAnswer.includes(" ")) {
    return paletteState.selectedCommand;
  }
  return answer;
}

export function resolveInteractiveShellContinuation(
  answer: unknown,
  paletteState: {
    visible?: boolean;
    mode?: "palette" | "picker";
    selectedCommand?: string | null;
    currentInputLine?: string | null;
    report?: InteractiveShellReport | null;
  } | null,
): { displayLine: string; continuationLine: string } | null {
  const trimmedAnswer = typeof answer === "string"
    ? normalizeInteractiveShellAnswer(answer)
    : "";
  if (!trimmedAnswer.startsWith("/") || !paletteState?.visible || !paletteState.selectedCommand) {
    return null;
  }
  if (!shouldApplyInteractiveShellSelection(trimmedAnswer, paletteState.currentInputLine)) {
    return null;
  }
  if (paletteState.mode === "palette" && isInteractiveSessionPickerRootCommand(paletteState.selectedCommand)) {
    return {
      displayLine: paletteState.selectedCommand,
      continuationLine: paletteState.selectedCommand,
    };
  }
  const selectedEntry = resolveInteractiveShellReportEntry(paletteState.report ?? null, paletteState.selectedCommand);
  if (isInteractiveContinuationEntry(selectedEntry) && selectedEntry.enterBehavior === "continue" && selectedEntry.nextResolverLine) {
    return {
      displayLine: deriveInteractiveContinuationDisplayLine(selectedEntry.nextResolverLine, trimmedAnswer),
      continuationLine: selectedEntry.nextResolverLine,
    };
  }
  return null;
}

export function resolveInteractiveShellReportEntry(
  report: InteractiveShellReport | null,
  selectedCommand: string | null,
): InteractiveShellReportEntry | null {
  if (!report || !selectedCommand || !Array.isArray(report.sections)) {
    return null;
  }
  for (const section of report.sections) {
    if (!section || !Array.isArray(section.entries)) {
      continue;
    }
    for (const entry of section.entries) {
      if (entry?.command === selectedCommand) {
        return entry;
      }
    }
  }
  return null;
}

function buildInteractiveShellPreviewFingerprint(preview: InteractiveSelectionPreview | null): string | null {
  if (!preview) {
    return null;
  }
  return JSON.stringify({
    selectedCommand: preview.selectedCommand,
    resolvedCommandTemplate: preview.resolvedCommandTemplate,
    selectedTargetSummary: preview.selectedTargetSummary,
    decisionState: preview.decisionState,
    relationSummary: preview.relationSummary,
    availabilitySummary: preview.availabilitySummary,
    continuitySnippet: preview.continuitySnippet,
    whySelected: preview.whySelected,
    nextEffect: preview.nextEffect,
    available: preview.available,
    unavailableReason: preview.unavailableReason,
  });
}

function isInteractiveContinuationEntry(
  entry: InteractiveShellReportEntry | null,
): entry is InteractiveSessionPickerEntry {
  return Boolean(entry && "enterBehavior" in entry && "nextResolverLine" in entry);
}

function shouldApplyInteractiveShellSelection(
  answer: string,
  currentInputLine: string | null | undefined,
): boolean {
  if (answer === "/") {
    return true;
  }
  return typeof currentInputLine === "string"
    && currentInputLine.trim().length > 0
    && answer === currentInputLine.trim();
}
