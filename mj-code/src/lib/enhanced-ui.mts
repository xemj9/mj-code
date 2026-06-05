#!/usr/bin/env node

/**
 * Enhanced UI for MJ Code — polished, Claude Code-inspired terminal experience.
 *
 * Features:
 *   - Beautiful gradient banner with ASCII art logo
 *   - Polished user/AI dialog bubbles with rounded borders
 *   - Animated loading spinner with pulsing effect
 *   - Color-coded tool call panels with scope-aware styling
 *   - Context window progress bar
 *   - Effort level indicator (low / medium / high / max)
 *   - Rich assistant streaming with markdown-aware rendering
 */

import { createInterface } from "node:readline";
import process from "node:process";

import { createAnsi } from "./ansi.mjs";
import { createTerminalUi } from "./ui.mjs";
import { renderAgentAboutCard } from "./agent-branding.mjs";
import {
  setInteractiveRawMode,
  shouldScheduleInteractiveShellSyncFromRawInput,
  supportsInteractiveShell,
} from "./interactive-shell-ui-helpers.mjs";
import {
  applyInteractiveShellPrompt,
  buildInteractiveShellPrompt,
  resolveInteractiveShellPromptMode,
} from "./interactive-shell-prompt.mjs";
import {
  installInteractiveShellReadlineDriver,
} from "./interactive-shell-readline-driver.mjs";
import {
  createSlashPaletteController,
} from "./interactive-shell-palette-controller.mjs";
import {
  runInteractiveShellAskLoop,
} from "./interactive-shell-session-loop.mjs";
import {
  buildShellChromeLines,
  extractFinalContentFromJson,
  formatInputPreview,
  INTERACTIVE_SHELL_PROMPT,
  question,
  summarizeResult,
} from "./terminal-ui-support.mjs";
import {
  renderCompactDialogPanel,
  truncateText,
} from "./interactive-shell-panel.mjs";
export { createSlashPaletteController };

// ─── Effort Level ─────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  max: "MAX",
};

let currentEffortLevel: EffortLevel = "high";

export function getEffortLevel(): EffortLevel {
  return currentEffortLevel;
}

export function setEffortLevel(level: EffortLevel): void {
  currentEffortLevel = level;
}

export function isValidEffortLevel(value: string): value is EffortLevel {
  return ["low", "medium", "high", "max"].includes(value);
}

// ─── Spinner Animation ────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// ─── Color Theme Constants ────────────────────────────────────

const COLOR_USER_BORDER = "brightBlue";
const COLOR_AI_MARKER = "brightCyan";
const COLOR_TOOL_READ = "blue";
const COLOR_TOOL_WRITE = "yellow";
const COLOR_TOOL_NETWORK = "magenta";
const COLOR_TOOL_SHELL = "brightRed";
const COLOR_TOOL_MEMORY = "cyan";
const COLOR_TOOL_DEFAULT = "green";
const COLOR_SUCCESS = "green";
const COLOR_WARNING = "yellow";
const COLOR_ERROR = "brightRed";

// ─── Dialog Bubble Rendering ──────────────────────────────────

/**
 * Render a user message in a beautiful bubble with rounded borders.
 */
function renderUserBubble(ansi: ReturnType<typeof createAnsi>, content: string): string {
  const maxContentWidth = 80;
  const wrappedLines = wrapText(content, maxContentWidth);
  const label = ansi.bold(ansi[COLOR_USER_BORDER](" You "));

  const bodyLines = wrappedLines.map((line) => {
    return `${ansi[COLOR_USER_BORDER]("  │ ")}${line}`;
  });

  return [
    "",
    `${ansi[COLOR_USER_BORDER]("  ╭")}${label}${ansi[COLOR_USER_BORDER]("───────────────────────────────────────────")}`,
    ...bodyLines,
    `${ansi[COLOR_USER_BORDER]("  ╰")}${ansi.dim("──────────────────────────────────────────────╯")}`,
    "",
  ].join("\n");
}

/**
 * Render an AI response with a sleek branded marker and separator.
 */
function renderAssistantBubble(ansi: ReturnType<typeof createAnsi>, content: string): string {
  const maxContentWidth = 80;
  const wrappedLines = wrapText(content, maxContentWidth);

  const bodyLines = wrappedLines.map((line) => {
    return `${line}`;
  });

  return [
    "",
    `${ansi.bold(ansi[COLOR_AI_MARKER]("  ◆ MJ Code"))} ${ansi.dim("│")}`,
    ...bodyLines,
    "",
  ].join("\n");
}

// ─── Enhanced Banner ──────────────────────────────────────────

/**
 * Render a stunning, gradient-inspired banner — the first thing users see.
 */
function renderEnhancedBanner(
  ansi: ReturnType<typeof createAnsi>,
  status: {
    provider: string;
    model?: string | null;
    permissionMode: string;
    approvalPolicy: string;
    networkMode: string;
    cwd: string;
    effortLevel?: EffortLevel;
  },
  sessionPath: string,
  options: {
    isTTY?: boolean;
    contextUsed?: number;
    contextMax?: number;
  } = {},
): string {
  const isTTY = options.isTTY !== false;
  if (!isTTY) {
    return buildShellChromeLines(ansi, status, sessionPath, { isTTY: false }).join("\n");
  }

  const repoLabel = status.cwd.split("/").pop() || status.cwd;
  const providerLabel = `${status.provider}/${status.model ?? "auto"}`;
  const effort = status.effortLevel ?? "high";
  const effortColor = effort === "max" ? "brightMagenta" : effort === "high" ? "brightCyan" : effort === "medium" ? "yellow" : "dim";
  const effortDisplay = ansi[effortColor](EFFORT_LABELS[effort]);

  // ASCII art logo for MJ Code
  const logo = [
    ansi.bold(ansi.brightCyan("  ███╗   ███╗")),
    ansi.bold(ansi.brightCyan("  ████╗ ████║")),
    ansi.bold(ansi.brightCyan("  ██╔████╔██║")),
    ansi.bold(ansi.brightCyan("  ██║╚██╔╝██║")),
    ansi.bold(ansi.brightCyan("  ██║ ╚═╝ ██║")),
  ];

  const title = [
    ansi.bold(ansi.brightWhite("     MJ Code")),
    ansi.dim(" · Terminal Coding Agent"),
  ];

  const infoLine = ansi.dim(`  ${repoLabel} · ${status.permissionMode} · net=${status.networkMode}`);
  const configLine = ansi.dim(`  ${providerLabel}`) + ansi.dim(" · effort ") + effortDisplay;

  const topBar = ansi.brightCyan("  ┌─────────────────────────────────────────────────────────────┐");
  const botBar = ansi.brightCyan("  └─────────────────────────────────────────────────────────────┘");

  const lines = [
    "",
    topBar,
    `  │ ${logo[0]}${title[0]}${ansi.dim("                    │")}`,
    `  │ ${logo[1]}${title[1]}${ansi.dim("             │")}`,
    `  │ ${logo[2]}${ansi.dim("                                         │")}`,
    `  │ ${logo[3]}  ${infoLine}`,
    `  │ ${logo[4]}  ${configLine}`,
    botBar,
    "",
  ];

  return lines.join("\n");
}

/**
 * Render a context window usage progress bar.
 */
function renderContextBar(
  ansi: ReturnType<typeof createAnsi>,
  used: number,
  max: number,
): string {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  const percent = Math.round(ratio * 100);
  const barWidth = 30;
  const filledWidth = Math.round(ratio * barWidth);
  const emptyWidth = barWidth - filledWidth;

  let fillColor: string;
  let label: string;
  if (ratio < 0.5) {
    fillColor = ansi.green("█");
    label = ansi.green(`${percent}%`);
  } else if (ratio < 0.8) {
    fillColor = ansi.yellow("█");
    label = ansi.yellow(`${percent}%`);
  } else {
    fillColor = ansi.red("█");
    label = ansi.brightRed(`${percent}%`);
  }

  const bar = fillColor.repeat(filledWidth) + ansi.dim("░".repeat(emptyWidth));
  return `${ansi.dim("ctx [")}${bar}${ansi.dim("]")} ${label} ${ansi.dim(`· ${formatTokenCount(used)}/${formatTokenCount(max)}`)}`;
}

// ─── Enhanced Tool Panel ──────────────────────────────────────

/**
 * Color-coded tool call panel by scope — elegant and informative.
 */
function renderEnhancedToolPanel(
  ansi: ReturnType<typeof createAnsi>,
  name: string,
  inputValue: Record<string, unknown>,
): string {
  const scope = inferToolScope(name);
  let accentColor: "cyan" | "green" | "yellow" | "red" | "magenta" | "blue";

  if (scope.includes("local read")) {
    accentColor = "blue";
  } else if (scope.includes("workspace write")) {
    accentColor = "yellow";
  } else if (scope.includes("network")) {
    accentColor = "magenta";
  } else if (scope.includes("shell")) {
    accentColor = "red";
  } else if (scope.includes("memory")) {
    accentColor = "cyan";
  } else {
    accentColor = "green";
  }

  const entries = Object.entries(inputValue || {})
    .filter(([, v]) => v != null && v !== "")
    .slice(0, 4)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  const inputSummary = entries.length > 0
    ? truncateText(entries.join(" · "), 58)
    : "none";

  return renderCompactDialogPanel({
    title: `${ansi[accentColor]("⚙")} ${name}`,
    stateLabel: "  state · running",
    meta: scope,
    rows: [`  input · ${inputSummary}`],
    preview: [],
    footerHint: "governed by permission and approval policy",
    footer: "executing through real tool surface",
    accentColor,
  });
}

/**
 * Enhanced tool result panel with color coding.
 */
function renderEnhancedToolResultPanel(
  ansi: ReturnType<typeof createAnsi>,
  name: string,
  result: unknown,
): string {
  const meta = buildToolResultMeta(name, result);
  return renderCompactDialogPanel({
    title: `${ansi.green("✓")} ${name}`,
    stateLabel: "  state · complete",
    meta,
    rows: buildToolResultRows(name, result),
    preview: buildToolResultPreview(result),
    previewLabel: "preview",
    footerHint: "tool output fed back into agent loop",
    footer: "continue with grounded context",
    accentColor: "green",
  });
}

// ─── Spinner Controller ───────────────────────────────────────

interface SpinnerState {
  active: boolean;
  frameIndex: number;
  timer: ReturnType<typeof setInterval> | null;
  label: string;
  output: NodeJS.WriteStream;
  ansi: ReturnType<typeof createAnsi>;
}

function startSpinner(state: SpinnerState, label: string): void {
  if (state.active) {
    stopSpinner(state);
  }
  state.active = true;
  state.label = label;
  state.frameIndex = 0;

  state.timer = setInterval(() => {
    if (!state.active) return;
    const frame = SPINNER_FRAMES[state.frameIndex % SPINNER_FRAMES.length];
    state.frameIndex += 1;
    const line = `${state.ansi.brightCyan(frame)} ${state.ansi.dim(state.label)}${state.ansi.dim("…")}`;
    state.output.write(`\r${state.ansi.clearLine()}${line}`);
  }, SPINNER_INTERVAL_MS);
}

function stopSpinner(state: SpinnerState): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.active) {
    state.output.write(`\r${state.ansi.clearLine()}`);
    state.active = false;
  }
}

// ─── Main Enhanced UI Factory ─────────────────────────────────

export function createEnhancedTerminalUi(options: {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  useColor?: boolean;
} = {}): ReturnType<typeof createTerminalUi> & {
  printUserMessage(content: string): void;
  printContextBar(used: number, max: number): void;
  printEffortLevel(level: EffortLevel): void;
} {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const useColor = options.useColor ?? Boolean(output.isTTY);
  const ansi = createAnsi(useColor);
  const interactivePaletteEnabled = supportsInteractiveShell(input, output);

  let promptActive = false;
  let rl: ReturnType<typeof createInterface> | null = null;
  let removeReadlineDriver: (() => void) | null = null;
  let lineSyncScheduled = false;
  let lineSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let promptMode: "input" | "launcher" | "target" | "action" = "input";
  const slashPalette = createSlashPaletteController({ ansi, output });

  const spinner: SpinnerState = {
    active: false,
    frameIndex: 0,
    timer: null,
    label: "thinking",
    output,
    ansi,
  };

  function syncPromptMode(): void {
    if (!interactivePaletteEnabled || !promptActive || !rl) {
      return;
    }
    const nextMode = resolveInteractiveShellPromptMode(slashPalette.getState());
    if (nextMode === promptMode) {
      return;
    }
    promptMode = nextMode;
    applyInteractiveShellPrompt(rl, buildInteractiveShellPrompt(promptMode), { redraw: true });
  }

  function schedulePaletteSync(): void {
    if (!interactivePaletteEnabled || !promptActive || !rl || lineSyncScheduled) {
      return;
    }
    lineSyncScheduled = true;
    lineSyncTimer = setTimeout(() => {
      lineSyncScheduled = false;
      lineSyncTimer = null;
      if (!interactivePaletteEnabled || !promptActive || !rl) {
        return;
      }
      void slashPalette.syncFromLine(rl.line).then(() => {
        syncPromptMode();
      });
    }, 0);
  }

  function handleKeypress(value: unknown, key: unknown, currentRl: unknown) {
    if (!interactivePaletteEnabled || !promptActive || !rl) {
      return { handled: false, selectedCommand: null, continuationLine: null };
    }
    const result = slashPalette.handleKeypress(
      key as Parameters<typeof slashPalette.handleKeypress>[0],
      currentRl as Parameters<typeof slashPalette.handleKeypress>[1],
      value,
    );
    if (result.continuationLine) {
      void slashPalette.syncFromContinuation(rl.line, result.continuationLine).then(() => {
        syncPromptMode();
      });
      return result;
    }
    if (result.handled) {
      syncPromptMode();
      return result;
    }
    return result;
  }

  function handleRawInput(chunk: unknown): void {
    if (!interactivePaletteEnabled || !promptActive || !rl || !shouldScheduleInteractiveShellSyncFromRawInput(chunk)) {
      return;
    }
    schedulePaletteSync();
  }

  function ensureInterface() {
    if (rl) {
      return rl;
    }
    rl = createInterface({ input, output, terminal: Boolean(output.isTTY) });
    if (interactivePaletteEnabled && !removeReadlineDriver) {
      removeReadlineDriver = installInteractiveShellReadlineDriver(input, rl, {
        handleKeypress,
        handleContinuation(continuationLine: string) {
          void slashPalette.syncFromContinuation(rl!.line, continuationLine).then(() => {
            syncPromptMode();
          });
        },
        scheduleSync: handleRawInput,
      });
    }
    return rl;
  }

  // ─── Public API ──────────────────────────────────────────────

  return {
    async ask(prompt: string) {
      promptActive = true;
      promptMode = "input";
      slashPalette.close();
      try {
        const currentRl = ensureInterface();
        setInteractiveRawMode(input, interactivePaletteEnabled, true);
        return runInteractiveShellAskLoop({
          interactivePaletteEnabled,
          palette: slashPalette,
          rl: currentRl,
          askQuestion: (currentPrompt: string) => question(currentRl, currentPrompt || prompt),
          applyPromptMode(nextMode) {
            promptMode = nextMode;
            applyInteractiveShellPrompt(currentRl, buildInteractiveShellPrompt(nextMode));
          },
        });
      } finally {
        promptActive = false;
        slashPalette.close();
        setInteractiveRawMode(input, interactivePaletteEnabled, false);
      }
    },

    readBatchLines() {
      if (interactivePaletteEnabled) {
        return null;
      }
      return ensureInterface()[Symbol.asyncIterator]();
    },

    setInteractiveResolver(resolver: unknown) {
      slashPalette.setPickerResolver(
        resolver as Parameters<typeof slashPalette.setPickerResolver>[0],
      );
    },

    async confirm(prompt: string) {
      const currentRl = ensureInterface();
      output.write(`${ansi.bold(ansi.yellow("?"))} ${prompt} ${ansi.dim("[y/N]")} `);
      const answer = (await question(currentRl, "")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },

    async confirmAction(context: Record<string, unknown>) {
      const currentRl = ensureInterface();

      const paths = summarizeCompactValues(context.touchedPaths as string[], { limit: 3, formatter: compactPath });

      // Beautiful approval prompt — Claude Code style
      const verb = inferToolVerb(String(context.toolName ?? "tool"));
      const riskLevel = String((context.risk as Record<string, unknown>)?.level ?? "LOW").toUpperCase();
      const riskIcon = riskLevel === "HIGH" ? ansi.brightRed("●") : riskLevel === "MEDIUM" ? ansi.yellow("●") : ansi.green("●");

      output.write(`\n${ansi.dim("╭───────────────────────────────────────────────────")}\n`);
      output.write(`${ansi.dim("│")} ${ansi.bold(ansi.yellow(`Allow ${verb}?`))} ${riskIcon} ${ansi.dim(`risk=${riskLevel}`)}\n`);
      output.write(`${ansi.dim("│")} ${ansi.dim(`${paths} · rollback ${context.rollbackAvailable ? "yes" : "no"}`)}\n`);

      // Show a small preview of changes
      const previewLines = buildApprovalPreviewLines(context as Parameters<typeof buildApprovalPreviewLines>[0]);
      for (const line of previewLines.slice(0, 3)) {
        output.write(`${ansi.dim("│")} ${ansi.dim(line)}\n`);
      }
      output.write(`${ansi.dim("╰───────────────────────────────────────────────────")}\n`);

      const answer = (await question(currentRl, `  ${ansi.bold(ansi.brightCyan("▸"))} ${ansi.dim("[y/N]")} `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },

    printBanner(status: Record<string, unknown>, sessionPath: string | null) {
      const typedStatus = {
        provider: String(status.provider ?? "unknown"),
        model: status.model ? String(status.model) : null,
        permissionMode: String(status.permissionMode ?? "default"),
        approvalPolicy: String(status.approvalPolicy ?? "ask"),
        networkMode: String(status.networkMode ?? "off"),
        cwd: String(status.cwd ?? process.cwd()),
        effortLevel: currentEffortLevel,
      };
      const contextUsed = typeof status.contextUsed === "number" ? status.contextUsed : 0;
      const contextMax = typeof status.contextMax === "number" ? status.contextMax : 200000;

      output.write(
        renderEnhancedBanner(ansi, typedStatus, sessionPath ?? "", {
          isTTY: Boolean(output.isTTY),
          contextUsed,
          contextMax,
        }) + "\n",
      );
    },

    beginAssistantStream() {
      startSpinner(spinner, "thinking");
      return {
        raw: "",
        buffer: "",
        displayed: false,
        emittedContent: "",
      };
    },

    pushAssistantDelta(state: Record<string, unknown>, delta: string) {
      state.raw = (state.raw ?? "") + delta;
      state.buffer = (state.buffer ?? "") + delta;

      const raw = state.raw as string;
      const buffer = state.buffer as string;

      const jsonContent = extractFinalContentFromJson(raw);
      if (jsonContent != null) {
        const emittedContent = state.emittedContent as string;
        const nextText = jsonContent.slice(emittedContent.length);
        if (!nextText) {
          return;
        }

        if (!state.displayed) {
          stopSpinner(spinner);
          output.write(`\r${ansi.clearLine()}`);
          state.displayed = true;
          output.write(`\n${ansi.bold(ansi[COLOR_AI_MARKER]("  ◆ MJ Code"))} ${ansi.dim("│")}\n${nextText}`);
        } else {
          output.write(nextText);
        }

        state.emittedContent = jsonContent;
        return;
      }

      if (!state.displayed) {
        const trimmed = buffer.trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
          return;
        }

        stopSpinner(spinner);
        output.write(`\r${ansi.clearLine()}`);
        state.displayed = true;
        output.write(`\n${ansi.bold(ansi[COLOR_AI_MARKER]("  ◆ MJ Code"))} ${ansi.dim("│")}\n${buffer}`);
        return;
      }

      output.write(delta);
    },

    finishAssistantStream(state: Record<string, unknown>) {
      stopSpinner(spinner);
      if (state?.displayed) {
        output.write("\n\n");
      }
    },

    printAssistant(content: string) {
      output.write(renderAssistantBubble(ansi, content) + "\n");
    },

    printUserMessage(content: string) {
      // Clear the readline echo line first, then draw the user bubble
      output.write(`\r${ansi.clearLine()}`);
      output.write(renderUserBubble(ansi, content) + "\n");
    },

    printInfo(label: string, value: string) {
      // Suppress noisy intermediate info messages
      const noisyLabels = ["context", "repair", "fallback", "provider"];
      if (noisyLabels.includes(label)) {
        return;
      }
      output.write(`${ansi.dim(`  ${label} ${value}`)}\n`);
    },

    printWarning(value: string) {
      output.write(`${ansi[COLOR_WARNING]("⚠")} ${ansi.yellow(value)}\n`);
    },

    printError(value: string) {
      output.write(`${ansi[COLOR_ERROR]("✖")} ${ansi.red(value)}\n`);
    },

    printProviderFailure(details: Record<string, unknown>) {
      const message = details?.message ?? "Provider request failed";
      const provider = details?.provider ?? "provider";
      output.write(`${ansi[COLOR_ERROR]("✖")} ${ansi.red(`${provider}: ${truncateText(String(message), 70)}`)}\n`);
    },

    printProviderEvent(event: Record<string, unknown>) {
      // Suppress provider event noise
    },

    printLocalContextPrefetch(result: Record<string, unknown>) {
      // Suppress local context prefetch panel
    },

    printToolCall(name: string, inputValue: Record<string, unknown>) {
      // Polished Claude Code-style tool call box
      stopSpinner(spinner);
      const primaryArg = inferToolPrimaryArg(name, inputValue);
      const verb = inferToolVerb(name);
      const detail = primaryArg
        ? ` ${ansi.dim(primaryArg)}`
        : "";

      const accent = toolAccentColor(name);
      const label = ansi[accent](`${verb}`);
      const borderLen = Math.max(visibleTextLength(verb) + (primaryArg ? visibleTextLength(String(primaryArg)) + 1 : 0) + 8, 20);
      const border = "─".repeat(Math.min(borderLen, 60));

      output.write(`\r${ansi.clearLine()}`);
      output.write(`${ansi[accent]("╭─")} ${label}${detail} ${ansi[accent]("─╮")}\n`);
      if (primaryArg) {
        output.write(`${ansi[accent]("│")} ${ansi.dim(name)}${detail}\n`);
      }
      output.write(`${ansi[accent]("╰")}${border}${ansi[accent]("╯")}\n`);
    },

    printToolResult(name: string, result: unknown) {
      // Polished tool result with ✓ indicator
      const summary = buildToolResultSummary(name, result);
      const accent = toolAccentColor(name);
      output.write(`${ansi[COLOR_SUCCESS]("  ✓")} ${ansi[accent](name)}${summary ? ansi.dim(` · ${truncateText(summary, 60)}`) : ""}\n`);
    },

    printChangePreview(changeSet: Record<string, unknown>) {
      if (!changeSet) {
        return;
      }
      const touchedFiles = Array.isArray(changeSet.touchedFiles) ? (changeSet.touchedFiles as string[]) : [];
      const fileSummary = touchedFiles.length > 0
        ? touchedFiles.slice(0, 2).map(compactPath).join(", ")
        : "changes";

      output.write(`${ansi.dim(`  → ${touchedFiles.length} file(s) · ${fileSummary}`)}\n`);
    },

    printSection(title: string, body: string) {
      output.write(`${ansi.bold(ansi[COLOR_AI_MARKER](`◆ ${title}`))}\n${body}\n`);
    },

    printAbout() {
      output.write(`${renderAgentAboutCard()}\n`);
    },

    printContextBar(used: number, max: number) {
      output.write(renderContextBar(ansi, used, max) + "\n");
    },

    printEffortLevel(level: EffortLevel) {
      const color = level === "max" ? "brightMagenta" : level === "high" ? "brightCyan" : level === "medium" ? "yellow" : "dim";
      output.write(`  ${ansi.dim("effort")} ${ansi.bold(ansi[color](EFFORT_LABELS[level]))} ${ansi.dim(`(${level})`)}\n`);
    },

    isInteractiveShell() {
      return interactivePaletteEnabled;
    },

    close() {
      stopSpinner(spinner);
      if (lineSyncTimer) {
        clearTimeout(lineSyncTimer);
        lineSyncTimer = null;
        lineSyncScheduled = false;
      }
      if (removeReadlineDriver) {
        removeReadlineDriver();
        removeReadlineDriver = null;
      }
      rl?.close();
    },
  };
}

// ─── Utility Functions ────────────────────────────────────────

function visibleTextLength(value: string): number {
  return `${value}`.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padToWidth(value: string, width: number): string {
  const len = visibleTextLength(value);
  if (len >= width) return value;
  return value + " ".repeat(width - len);
}

function wrapText(text: string, maxWidth: number): string[] {
  const rawLines = text.split(/\r?\n/);
  const result: string[] = [];
  for (const line of rawLines) {
    if (visibleTextLength(line) <= maxWidth) {
      result.push(line);
      continue;
    }
    let current = "";
    const words = line.split(" ");
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (visibleTextLength(test) > maxWidth && current) {
        result.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) {
      result.push(current);
    }
  }
  return result.length > 0 ? result : [""];
}

function compactPath(value: string | unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) {
    return normalized;
  }
  return `.../${parts.slice(-3).join("/")}`;
}

function summarizeCompactValues(
  values: string[] | unknown,
  options: { limit?: number; formatter?: (v: string) => string } = {},
): string {
  const limit = options.limit ?? 3;
  const formatter = typeof options.formatter === "function"
    ? options.formatter
    : (v: string) => v;
  const items = Array.isArray(values)
    ? values
      .map((v) => formatter(v))
      .filter((v) => typeof v === "string" && v.length > 0)
    : [];
  if (items.length === 0) {
    return "none";
  }
  const visible = items.slice(0, limit).join(" · ");
  const remaining = items.length - limit;
  return remaining > 0
    ? `${visible} +${remaining} more`
    : visible;
}

function inferToolScope(name: string): string {
  if (["pwd", "list_dir", "read_file", "search_files"].includes(name)) {
    return "scope · local read";
  }
  if (["write_file", "replace_in_file", "apply_patch"].includes(name)) {
    return "scope · workspace write";
  }
  if (["web_search", "fetch_url", "extract_content"].includes(name)) {
    return "scope · network";
  }
  if (name === "run_shell") {
    return "scope · shell";
  }
  if (["remember_memory", "search_memory"].includes(name)) {
    return "scope · memory";
  }
  if (["list_docs", "read_doc", "search_docs"].includes(name)) {
    return "scope · docs";
  }
  return "scope · tool";
}

function inferToolIcon(name: string): string {
  if (["read_file", "list_dir", "search_files", "pwd"].includes(name)) {
    return "📖";
  }
  if (["write_file", "replace_in_file", "apply_patch"].includes(name)) {
    return "✏️";
  }
  if (["web_search", "fetch_url", "extract_content"].includes(name)) {
    return "🌐";
  }
  if (name === "run_shell") {
    return "⚡";
  }
  if (["remember_memory", "search_memory"].includes(name)) {
    return "💭";
  }
  return "⚙️";
}

function inferToolVerb(name: string): string {
  if (name === "read_file") return "Reading";
  if (name === "write_file") return "Writing";
  if (name === "replace_in_file") return "Editing";
  if (name === "apply_patch") return "Patching";
  if (name === "list_dir") return "Listing";
  if (name === "search_files") return "Searching";
  if (name === "pwd") return "Resolving";
  if (name === "run_shell") return "Running";
  if (name === "web_search") return "Searching";
  if (name === "fetch_url") return "Fetching";
  if (name === "extract_content") return "Extracting";
  if (name === "remember_memory") return "Remembering";
  if (name === "search_memory") return "Recalling";
  return name.replace(/_/g, " ");
}

function toolAccentColor(name: string): "cyan" | "green" | "yellow" | "red" | "magenta" | "blue" {
  if (["read_file", "list_dir", "search_files", "pwd"].includes(name)) return "blue";
  if (["write_file", "replace_in_file", "apply_patch"].includes(name)) return "yellow";
  if (["web_search", "fetch_url", "extract_content"].includes(name)) return "magenta";
  if (name === "run_shell") return "red";
  if (["remember_memory", "search_memory"].includes(name)) return "cyan";
  return "green";
}

function buildToolResultSummary(name: string, result: unknown): string {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (name === "read_file" && typeof r.path === "string") {
      return `${compactPath(r.path)} · lines ${r.startLine ?? "?"}-${r.endLine ?? "?"}`;
    }
    if (name === "list_dir" && Array.isArray(r.entries)) {
      return `${(r.entries as unknown[]).length} entries`;
    }
    if (name === "search_files" && Array.isArray(r.matches)) {
      return `${(r.matches as unknown[]).length} matches`;
    }
    if (name === "run_shell" && r.jobId) {
      return `${r.status ?? "unknown"}`;
    }
    if (r.bytesWritten != null) {
      return `${r.bytesWritten} bytes`;
    }
  }
  return "";
}

function inferToolPrimaryArg(name: string, input: Record<string, unknown>): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  if (input.path && typeof input.path === "string") {
    return compactPath(input.path);
  }
  if (input.query && typeof input.query === "string") {
    return truncateText(input.query, 60);
  }
  if (input.url && typeof input.url === "string") {
    return truncateText(input.url, 60);
  }
  if (input.command && typeof input.command === "string") {
    return truncateText(input.command, 60);
  }
  if (input.directory && typeof input.directory === "string") {
    return compactPath(input.directory);
  }
  if (input.pattern && typeof input.pattern === "string") {
    return truncateText(input.pattern, 60);
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.length > 0 && value.length < 200) {
      return truncateText(value, 60);
    }
  }
  return null;
}

function renderApprovalScopeLine(context: {
  network?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  plugin?: Record<string, unknown>;
  targetDomains?: string[];
  toolName?: string;
}): string {
  if (context.network) {
    return [
      "network",
      `mode=${context.network.networkMode}`,
      context.network.provider ? `provider=${context.network.provider}` : null,
      context.network.domain ? `domain=${context.network.domain}` : null,
      `official=${context.network.official ? "yes" : "no"}`,
    ].filter(Boolean).join(" · ");
  }
  if (context.mcp) {
    return [
      "mcp",
      context.mcp.serverName ?? context.mcp.serverId ?? "unknown",
      context.mcp.toolName ?? context.toolName,
      `readonly=${(context.mcp.annotations as Record<string, unknown>)?.readOnlyHint ? "yes" : "no"}`,
    ].join(" · ");
  }
  if (context.plugin) {
    return [
      "plugin",
      context.plugin.pluginName ?? context.plugin.pluginId ?? "unknown",
      context.plugin.toolName ?? context.toolName,
      `risk=${context.plugin.riskCategory ?? "unknown"}`,
    ].join(" · ");
  }
  return `domains · ${summarizeCompactValues(context.targetDomains, { limit: 2 })}`;
}

function buildApprovalPreviewLines(context: {
  previewSummary?: string[];
  touchedPaths?: string[];
}): string[] {
  const preview = Array.isArray(context.previewSummary) && context.previewSummary.length > 0
    ? context.previewSummary
    : context.touchedPaths;
  return preview
    ?.slice(0, 4)
    .map((line) => `  ${truncateText(line, 58)}`) ?? [];
}

function buildChangePreviewLines(changeSet: Record<string, unknown>): string[] {
  if (typeof changeSet?.diff === "string" && changeSet.diff.trim().length > 0) {
    return clipPanelLines(changeSet.diff, { maxLines: 10, maxWidth: 58 });
  }
  return (changeSet?.files as Record<string, unknown>[])?.slice(0, 4)
    .map((entry) => `  ${truncateText(String(entry.summary ?? entry.path ?? "change"), 58)}`) ?? [];
}

function clipPanelLines(value: string, options: { maxLines?: number; maxWidth?: number } = {}): string[] {
  const maxLines = options.maxLines ?? 6;
  const maxWidth = options.maxWidth ?? 58;
  const lines = `${value ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }
  const visible = lines.slice(0, maxLines).map((line) => `  ${truncateText(line, maxWidth)}`);
  const remaining = lines.length - visible.length;
  if (remaining > 0) {
    visible.push(`  ... ${remaining} more line${remaining === 1 ? "" : "s"}`);
  }
  return visible;
}

function buildProviderFailureRows(details: Record<string, unknown>): string[] {
  const attempts = Array.isArray(details?.attempts) ? details.attempts.length : (details?.attempt ?? 0);
  const detailMessage = details?.details && typeof details.details === "object"
    ? (details.details as Record<string, unknown>).message
    : null;
  const message = typeof detailMessage === "string" && detailMessage.length > 0
    ? detailMessage
    : details?.message ?? "provider request failed";

  return [
    `taxonomy · ${details?.taxonomy ?? "provider_error"}`,
    `provider · ${details?.provider ?? "unknown"}`,
    `request · ${details?.requestType ?? "unknown"}`,
    `attempts · ${attempts || "unknown"} · retryable=${details?.retryable ? "yes" : "no"}`,
    details?.status != null ? `status · ${details.status}` : `reason · ${truncateText(String(message), 58)}`,
    details?.circuitState ? `circuit · ${details.circuitState}` : null,
  ].filter(Boolean) as string[];
}

function buildProviderAttemptLines(details: Record<string, unknown>): string[] {
  const attempts = Array.isArray(details?.attempts) ? details.attempts : [];
  if (attempts.length === 0) {
    const detailMessage = details?.details && typeof details.details === "object"
      ? (details.details as Record<string, unknown>).message
      : null;
    const message = typeof detailMessage === "string" && detailMessage.length > 0
      ? detailMessage
      : details?.message ?? "provider request failed";
    return [`  ${truncateText(String(message), 58)}`];
  }
  return attempts.slice(-4).map((attempt: Record<string, unknown>) => [
    `  #${attempt.attempt ?? "?"}`,
    attempt.status != null ? `status=${attempt.status}` : "network",
    attempt.code ? `code=${attempt.code}` : null,
    attempt.durationMs != null ? `${attempt.durationMs}ms` : null,
    attempt.delayMs ? `retry+${attempt.delayMs}ms` : null,
  ].filter(Boolean).join(" · "));
}

function buildProviderEventLine(event: Record<string, unknown>): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  if (event.type === "provider_attempt_started") {
    return `model ${event.provider ?? "provider"} · ${event.requestType ?? "request"} · attempt ${event.attempt ?? 1}`;
  }
  if (event.type === "provider_retry_scheduled") {
    return `retry ${event.requestType ?? "request"} · attempt ${event.attempt ?? "?"} · in ${event.delayMs ?? 0}ms`;
  }
  if (event.type === "provider_attempt_succeeded" && Number(event.durationMs ?? 0) >= 2000) {
    return `model ok · ${event.requestType ?? "request"} · ${event.durationMs}ms`;
  }
  if (event.type === "provider_native_tool_protocol_fallback") {
    return "native tool protocol failed · retrying with JSON tool protocol";
  }
  return null;
}

function buildLocalContextRows(result: Record<string, unknown>): string[] {
  return (result.attachments as Record<string, unknown>[])?.slice(0, 4).map((entry) =>
    `file · ${truncateText(`${entry.relativePath} · ${entry.lineCount} lines · ${entry.bytes} bytes${entry.truncated ? " · clipped" : ""}`, 58)}`,
  ) ?? [];
}

function buildToolResultRows(name: string, result: unknown): string[] {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const rows: string[] = [];
    if (typeof r.path === "string") {
      rows.push(`path · ${compactPath(r.path) ?? r.path}`);
    }
    if (r.startLine != null || r.endLine != null) {
      rows.push(`lines · ${r.startLine ?? "?"}-${r.endLine ?? "?"}`);
    }
    if (Array.isArray(r.entries)) {
      rows.push(`entries · ${(r.entries as unknown[]).length}${r.truncated ? " · truncated" : ""}`);
    }
    if (Array.isArray(r.matches)) {
      rows.push(`matches · ${(r.matches as unknown[]).length} · engine=${r.engine ?? "unknown"}`);
    }
    if (r.bytesWritten != null) {
      rows.push(`write · ${r.bytesWritten} bytes`);
    }
    if (r.jobId) {
      rows.push(`job · ${r.jobId} · status=${r.status ?? "unknown"}`);
    }
    if (rows.length > 0) {
      return rows;
    }
  }
  return [`summary · ${truncateText(summarizeResult(result), 58)}`];
}

function buildToolResultMeta(name: string, result: unknown): string {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (name === "read_file" && typeof r.path === "string") {
      return `${compactPath(r.path) ?? r.path} · lines ${r.startLine ?? "?"}-${r.endLine ?? "?"}`;
    }
    if (name === "list_dir" && Array.isArray(r.entries)) {
      return `${compactPath(r.path as string) || "directory"} · ${(r.entries as unknown[]).length} entries${r.truncated ? " · clipped" : ""}`;
    }
    if (name === "search_files" && Array.isArray(r.matches)) {
      return `${(r.matches as unknown[]).length} matches · ${r.engine ?? "search"}`;
    }
    if (name === "run_shell" && r.jobId) {
      return `job ${r.jobId} · ${r.status ?? "unknown"}`;
    }
    if (r.bytesWritten != null) {
      return `${r.bytesWritten} bytes written`;
    }
  }
  return truncateText(summarizeResult(result), 58);
}

function buildToolResultPreview(result: unknown): string[] {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") {
      return clipPanelLines(r.content, { maxLines: 4, maxWidth: 58 });
    }
    if (Array.isArray(r.matches)) {
      return (r.matches as Record<string, unknown>[]).slice(0, 4).map((entry) =>
        `  ${truncateText(`${compactPath(String(entry.path)) ?? entry.path}:${entry.line ?? "?"} ${entry.preview ?? ""}`, 58)}`,
      );
    }
    if (Array.isArray(r.entries)) {
      return (r.entries as Record<string, unknown>[]).slice(0, 4).map((entry) =>
        `  ${truncateText(`${entry.kind ?? "item"} ${entry.name ?? ""}`, 58)}`,
      );
    }
  }
  return [];
}

function formatSessionLabel(sessionPath: string): string {
  const basename = sessionPath?.replace(/\\/g, "/").split("/").pop()?.replace(".jsonl", "") ?? "";
  if (!basename) {
    return "none";
  }
  const isoLikeMatch = basename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d{3})?Z(?:-(.+))?$/);
  if (isoLikeMatch) {
    const [, date, hour, minute, , suffix] = isoLikeMatch;
    return `${date} ${hour}:${minute}${suffix ? ` #${suffix.length <= 10 ? suffix : suffix.slice(0, 6)}` : ""}`;
  }
  return basename.length > 28 ? `${basename.slice(0, 25)}...` : basename;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return String(count);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
