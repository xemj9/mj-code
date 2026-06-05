import process from "node:process";

import { createAnsi } from "./ansi.mjs";
import { getInteractiveCommandPalette } from "./command-catalog.mjs";
import {
  isInteractiveSessionPickerRootCommand,
  shouldBypassInteractiveShellOverlay,
} from "./interactive-shell-commands.mjs";
import {
  buildInteractiveShellRenderSignature,
  flattenInteractiveShellEntries,
  getInteractiveShellSectionStartIndexes,
  renderInteractiveShellVisibleFrame,
} from "./interactive-shell-ui-helpers.mjs";
import {
  replaceReadlineLine,
} from "./terminal-ui-support.mjs";
import {
  renderInteractiveCommandPalette,
  renderInteractiveSessionPicker,
} from "./agent-interaction-render.mjs";
import type {
  InteractiveCommandPaletteEntry,
  InteractiveCommandPaletteReport,
  InteractiveSelectionPreview,
  InteractiveSessionPickerEntry,
  InteractiveSessionPickerReport,
} from "../types/contracts.js";

type PaletteReport = InteractiveCommandPaletteReport | InteractiveSessionPickerReport;
type PaletteEntry = InteractiveCommandPaletteEntry | InteractiveSessionPickerEntry;

interface SlashPaletteRenderOptions {
  mode: "text" | "overlay";
  selectedCommand?: string | null;
}

interface SlashPaletteControllerOptions {
  ansi?: ReturnType<typeof createAnsi>;
  output?: NodeJS.WriteStream;
  getPaletteReport?: (query: string | null) => InteractiveCommandPaletteReport;
  resolvePicker?: ((line: string) => Promise<InteractiveSessionPickerReport | null> | InteractiveSessionPickerReport | null) | null;
  renderPalette?: (report: InteractiveCommandPaletteReport, renderOptions: SlashPaletteRenderOptions) => string;
  renderPicker?: (report: InteractiveSessionPickerReport, renderOptions: SlashPaletteRenderOptions) => string;
}

interface SlashPaletteState {
  visible: boolean;
  mode: "palette" | "picker";
  query: string | null;
  selectedIndex: number;
  selectedCommand: string | null;
  selectedPreview: InteractiveSelectionPreview | null;
  currentInputLine: string | null;
  resolverLineOverride: string | null;
  replaceableSeedLine: string | null;
  dismissedLine: string | null;
  report: PaletteReport | null;
  requestId: number;
  lastSignature: string | null;
}

interface ReadlineLike {
  line?: string;
  write?: (value: string | null, key?: { ctrl?: boolean; name?: string }) => void;
}

function isSessionPickerReport(report: PaletteReport | null): report is InteractiveSessionPickerReport {
  return Boolean(report && "step" in report);
}

function isSessionPickerEntry(entry: PaletteEntry | null): entry is InteractiveSessionPickerEntry {
  return Boolean(entry && "enterBehavior" in entry && "nextResolverLine" in entry);
}

export function createSlashPaletteController(options: SlashPaletteControllerOptions = {}) {
  const ansi = options.ansi ?? createAnsi(true);
  const output = options.output ?? process.stdout;
  const getPaletteReport = options.getPaletteReport ?? ((query) => getInteractiveCommandPalette(query));
  let resolvePicker = options.resolvePicker ?? null;
  const renderPalette = options.renderPalette ?? ((report, renderOptions) =>
    renderInteractiveCommandPalette(report, renderOptions));
  const renderPicker = options.renderPicker ?? ((report, renderOptions) =>
    renderInteractiveSessionPicker(report, renderOptions));
  const state: SlashPaletteState = {
    visible: false,
    mode: "palette",
    query: null,
    selectedIndex: 0,
    selectedCommand: null,
    selectedPreview: null,
    currentInputLine: null,
    resolverLineOverride: null,
    replaceableSeedLine: null,
    dismissedLine: null,
    report: null,
    requestId: 0,
    lastSignature: null,
  };

  function currentLine(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  function resolveSelectedPreview(
    report: PaletteReport | null,
    selectedCommand: string | null,
  ): InteractiveSelectionPreview | null {
    if (!report) {
      return null;
    }
    for (const section of report.sections ?? []) {
      for (const entry of section.entries ?? []) {
        if (entry.command === selectedCommand) {
          return entry.preview ?? null;
        }
      }
    }
    return report.selectedPreview ?? null;
  }

  function resolveSelectedEntry(
    report: PaletteReport | null,
    selectedCommand: string | null,
  ): PaletteEntry | null {
    if (!report || !selectedCommand) {
      return null;
    }
    for (const section of report.sections ?? []) {
      for (const entry of section.entries ?? []) {
        if (entry.command === selectedCommand) {
          return entry;
        }
      }
    }
    return null;
  }

  function buildRenderSignature(report: PaletteReport | null, selectedCommand: string | null): string {
    return buildInteractiveShellRenderSignature({
      mode: state.mode,
      query: state.query,
      inputLine: state.currentInputLine,
      resolverLineOverride: state.resolverLineOverride,
      selectedCommand,
      selectedPreview: resolveSelectedPreview(report, selectedCommand),
      totalMatches: report?.totalMatches ?? 0,
    });
  }

  function close(options: { keepDismissedLine?: boolean } = {}) {
    const keepDismissedLine = options.keepDismissedLine === true;
    if (!keepDismissedLine) {
      state.dismissedLine = null;
    }
    if (!state.visible) {
      return;
    }
    state.visible = false;
    state.mode = "palette";
    state.query = null;
    state.selectedIndex = 0;
    state.selectedCommand = null;
    state.selectedPreview = null;
    state.currentInputLine = null;
    state.resolverLineOverride = null;
    state.replaceableSeedLine = null;
    state.report = null;
    state.lastSignature = null;
    output.write(`${ansi.saveCursor()}\n${ansi.eraseDown()}${ansi.restoreCursor()}`);
  }

  function renderVisibleFrame() {
    return renderInteractiveShellVisibleFrame({
      mode: state.mode,
      report: state.report,
      selectedCommand: state.selectedCommand,
      selectedPreview: state.selectedPreview,
      renderPalette,
      renderPicker,
    });
  }

  function redraw() {
    if (!state.visible || !state.report) {
      close();
      return;
    }
    const text = renderVisibleFrame();
    if (!text) {
      close();
      return;
    }
    output.write(
      `${ansi.saveCursor()}\n${ansi.eraseDown()}${ansi.hideCursor()}${text}${ansi.showCursor()}${ansi.restoreCursor()}`,
    );
  }

  async function syncReport(line: string, continuationLine: string | null = null) {
    const normalizedLine = currentLine(line);
    if (state.currentInputLine != null && normalizedLine !== state.currentInputLine) {
      state.resolverLineOverride = null;
    }
    if (state.replaceableSeedLine && normalizedLine !== state.replaceableSeedLine) {
      state.replaceableSeedLine = null;
    }
    state.currentInputLine = normalizedLine;
    if (continuationLine) {
      state.resolverLineOverride = continuationLine;
    }
    const requestId = state.requestId + 1;
    state.requestId = requestId;
    if (state.dismissedLine && normalizedLine !== state.dismissedLine) {
      state.dismissedLine = null;
    }
    if (!normalizedLine.startsWith("/")) {
      close();
      return;
    }
    if (shouldBypassInteractiveShellOverlay(normalizedLine)) {
      close();
      return;
    }
    if (state.dismissedLine === normalizedLine) {
      close({ keepDismissedLine: true });
      return;
    }
    const effectiveLine = state.resolverLineOverride ?? normalizedLine;
    const pickerReport = resolvePicker
      ? await resolvePicker(effectiveLine)
      : null;
    if (requestId !== state.requestId) {
      return;
    }
    const mode: "picker" | "palette" = pickerReport ? "picker" : "palette";
    const query = pickerReport
      ? pickerReport.query ?? null
      : effectiveLine.slice(1).trim() || null;
    const report = pickerReport ?? getPaletteReport(query);
    const entries = flattenInteractiveShellEntries(report);
    const preservedIndex = state.selectedCommand
      ? entries.findIndex((entry) => entry.command === state.selectedCommand)
      : -1;
    const reportSelectedIndex = report.selectedCommand
      ? entries.findIndex((entry) => entry.command === report.selectedCommand)
      : -1;
    const selectedIndex = entries.length === 0
      ? 0
      : preservedIndex >= 0
        ? preservedIndex
        : reportSelectedIndex >= 0
          ? reportSelectedIndex
          : 0;
    const selectedCommand = entries[selectedIndex]?.command ?? null;
    const selectedPreview = resolveSelectedPreview(report, selectedCommand);
    const nextSignature = buildRenderSignature(report, selectedCommand);
    if (
      state.visible
      && state.lastSignature === nextSignature
      && state.mode === mode
      && state.query === (query || null)
    ) {
      return;
    }
    state.visible = true;
    state.mode = mode;
    state.query = query || null;
    state.selectedIndex = selectedIndex;
    state.selectedCommand = selectedCommand;
    state.selectedPreview = selectedPreview;
    state.report = {
      ...report,
      fallbackMode: "tty_overlay",
      selectedCommand,
      selectedPreview,
    };
    state.lastSignature = nextSignature;
    redraw();
  }

  async function syncFromLine(line: string) {
    return syncReport(line, null);
  }

  async function syncFromContinuation(inputLine: string, continuationLine: string) {
    state.dismissedLine = null;
    state.replaceableSeedLine = currentLine(inputLine);
    return syncReport(inputLine, continuationLine);
  }

  function shouldResetReplaceableSeedLine(
    value: unknown,
    currentRl?: ReadlineLike | null,
  ): boolean {
    if (!state.replaceableSeedLine) {
      return false;
    }
    if (currentLine(currentRl?.line) !== state.replaceableSeedLine) {
      return false;
    }
    const rawText = typeof value === "string"
      ? value
      : Buffer.isBuffer(value)
        ? value.toString("utf8")
        : "";
    if (!rawText) {
      return false;
    }
    const firstChar = rawText[0] ?? "";
    if (!firstChar || firstChar === " " || firstChar === "\t") {
      return false;
    }
    return !/[\x00-\x1f\x7f]/.test(firstChar);
  }

  function moveSelection(delta: number) {
    if (!state.visible || !state.report) {
      return;
    }
    const entries = flattenInteractiveShellEntries(state.report);
    if (entries.length === 0) {
      return;
    }
    const nextIndex = (state.selectedIndex + delta + entries.length) % entries.length;
    state.selectedIndex = nextIndex;
    state.selectedCommand = entries[nextIndex]?.command ?? null;
    state.selectedPreview = entries[nextIndex]?.preview ?? resolveSelectedPreview(state.report, state.selectedCommand);
    state.report = {
      ...state.report,
      selectedCommand: state.selectedCommand,
      selectedPreview: state.selectedPreview,
    };
    state.lastSignature = buildRenderSignature(state.report, state.selectedCommand);
    redraw();
  }

  function moveSelectionBySection(delta: number) {
    if (!state.visible || !state.report) {
      return;
    }
    const sectionIndexes = getInteractiveShellSectionStartIndexes(state.report);
    if (sectionIndexes.length === 0) {
      return;
    }
    const currentSectionIndex = sectionIndexes.findIndex((value, index) => {
      const next = sectionIndexes[index + 1] ?? Number.POSITIVE_INFINITY;
      return state.selectedIndex >= value && state.selectedIndex < next;
    });
    const baseIndex = currentSectionIndex >= 0 ? currentSectionIndex : 0;
    const nextSection = (baseIndex + delta + sectionIndexes.length) % sectionIndexes.length;
    state.selectedIndex = sectionIndexes[nextSection];
    state.selectedCommand = flattenInteractiveShellEntries(state.report)[state.selectedIndex]?.command ?? null;
    state.selectedPreview = flattenInteractiveShellEntries(state.report)[state.selectedIndex]?.preview
      ?? resolveSelectedPreview(state.report, state.selectedCommand);
    state.report = {
      ...state.report,
      selectedCommand: state.selectedCommand,
      selectedPreview: state.selectedPreview,
    };
    state.lastSignature = buildRenderSignature(state.report, state.selectedCommand);
    redraw();
  }

  function handleKeypress(
    key: { name?: string; shift?: boolean } | undefined,
    currentRl?: ReadlineLike | null,
    value?: unknown,
  ) {
    if (shouldResetReplaceableSeedLine(value, currentRl)) {
      state.replaceableSeedLine = null;
      return {
        handled: false,
        selectedCommand: null,
        continuationLine: null,
        resetLineBeforeWrite: true,
      };
    }
    if (!key) {
      return { handled: false, selectedCommand: null, continuationLine: null };
    }
    if (key.name === "escape" && state.visible) {
      if (isSessionPickerReport(state.report) && state.report.step === "action" && state.report.anchorCommand) {
        return {
          handled: true,
          selectedCommand: null,
          continuationLine: state.report.anchorCommand,
        };
      }
      state.dismissedLine = currentLine(currentRl?.line);
      close({ keepDismissedLine: true });
      return { handled: true, selectedCommand: null, continuationLine: null };
    }
    if (!state.visible) {
      return { handled: false, selectedCommand: null, continuationLine: null };
    }
    if (key.name === "up") {
      moveSelection(-1);
      return { handled: true, selectedCommand: state.selectedCommand, continuationLine: null };
    }
    if (key.name === "down") {
      moveSelection(1);
      return { handled: true, selectedCommand: state.selectedCommand, continuationLine: null };
    }
    if (key.name === "tab" || key.name === "right") {
      moveSelectionBySection(1);
      return { handled: true, selectedCommand: state.selectedCommand, continuationLine: null };
    }
    if ((key.name === "left") || (key.name === "tab" && key.shift === true)) {
      moveSelectionBySection(-1);
      return { handled: true, selectedCommand: state.selectedCommand, continuationLine: null };
    }
    if ((key.name === "return" || key.name === "enter") && state.selectedCommand) {
      if (shouldBypassInteractiveShellOverlay(currentLine(currentRl?.line))) {
        close();
        return { handled: false, selectedCommand: null, continuationLine: null };
      }
      const selectedEntry = resolveSelectedEntry(state.report, state.selectedCommand);
      const continuationLine = isSessionPickerEntry(selectedEntry) && selectedEntry.enterBehavior === "continue"
        ? selectedEntry.nextResolverLine
        : isInteractiveSessionPickerRootCommand(state.selectedCommand)
          ? state.selectedCommand
          : null;
      if (continuationLine) {
        if (!isSessionPickerEntry(selectedEntry) || selectedEntry.enterBehavior !== "continue") {
          replaceReadlineLine(currentRl, state.selectedCommand);
        }
        return {
          handled: true,
          selectedCommand: state.selectedCommand,
          continuationLine,
        };
      }
      replaceReadlineLine(currentRl, state.selectedCommand);
      const keepDismissedLine = !isInteractiveSessionPickerRootCommand(state.selectedCommand);
      state.dismissedLine = keepDismissedLine ? state.selectedCommand : null;
      close({ keepDismissedLine });
      return { handled: true, selectedCommand: state.selectedCommand, continuationLine: null };
    }
    return { handled: false, selectedCommand: null, continuationLine: null };
  }

  return {
    close,
    handleKeypress,
    syncFromLine,
    syncFromContinuation,
    setPickerResolver(resolver: SlashPaletteControllerOptions["resolvePicker"]) {
      resolvePicker = resolver ?? null;
    },
    getState() {
      return {
        visible: state.visible,
        mode: state.mode,
        query: state.query,
        selectedIndex: state.selectedIndex,
        selectedCommand: state.selectedCommand,
        selectedPreview: state.selectedPreview,
        currentInputLine: state.currentInputLine,
        resolverLineOverride: state.resolverLineOverride,
        report: state.report,
      };
    },
  };
}
