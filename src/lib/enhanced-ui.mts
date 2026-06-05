#!/usr/bin/env node

/**
 * Enhanced UI for MJ Code — polished, Claude Code-inspired terminal experience.
 *
 * Design principles:
 *   - Clean, minimal visual chrome — let content breathe
 *   - Consistent color language: blue=read, yellow=write, magenta=network, red=shell, cyan=memory
 *   - Clear turn separation with subtle dividers
 *   - Informative tool panels with inline data previews
 *   - Smooth streaming with thinking → responding → tool transitions
 *   - Compact footer metrics (tokens, duration, context)
 */

import { createInterface } from "node:readline";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

// ─── Command History ──────────────────────────────────────────

const MAX_HISTORY_SIZE = 500;

function loadHistory(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line: string) => line.trim().length > 0);
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line && !seen.has(line)) {
        seen.add(line);
        deduped.unshift(line);
      }
    }
    return deduped.slice(-MAX_HISTORY_SIZE);
  } catch {
    return [];
  }
}

function saveHistory(filePath: string, history: string[]): void {
  try {
    const content = history.slice(-MAX_HISTORY_SIZE).join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf8");
  } catch {
    // Silently ignore write failures
  }
}

function appendHistory(filePath: string, history: string[], entry: string): void {
  const idx = history.lastIndexOf(entry);
  if (idx !== -1) {
    history.splice(idx, 1);
  }
  history.push(entry);
  if (history.length > MAX_HISTORY_SIZE) {
    history.splice(0, history.length - MAX_HISTORY_SIZE);
  }
  saveHistory(filePath, history);
}

// ─── Spinner Animation ────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// ─── Color Theme ──────────────────────────────────────────────

const C = {
  brand: "brightCyan" as const,
  user: "brightBlue" as const,
  ai: "brightCyan" as const,
  toolRead: "blue" as const,
  toolWrite: "yellow" as const,
  toolNetwork: "magenta" as const,
  toolShell: "brightRed" as const,
  toolMemory: "cyan" as const,
  toolDoc: "blue" as const,
  toolMcp: "green" as const,
  toolDefault: "green" as const,
  success: "green" as const,
  warning: "yellow" as const,
  error: "brightRed" as const,
  dim: "dim" as const,
};

// ─── Turn Counter ─────────────────────────────────────────────

let turnCounter = 0;

function resetTurnCounter(): void {
  turnCounter = 0;
}

function nextTurn(): number {
  turnCounter += 1;
  return turnCounter;
}

// ─── Banner ───────────────────────────────────────────────────

function renderBanner(
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

  return [
    "",
    ansi.bold(ansi[C.brand]("  ◆ MJ Code")) + ansi.dim(` · ${providerLabel}`),
    ansi.dim(`  ${repoLabel} · ${status.permissionMode} · net=${status.networkMode} · effort ${effortDisplay}`),
    ansi.dim("  ─────────────────────────────────────────────────────"),
    "",
  ].join("\n");
}

// ─── User Message ─────────────────────────────────────────────

function renderUserMessage(ansi: ReturnType<typeof createAnsi>, content: string, turnNum: number): string {
  const maxW = 90;
  const wrapped = wrapText(content, maxW);
  const label = ansi.bold(ansi[C.user](`❯`));

  const lines = wrapped.map((line) => `${label} ${line}`);

  return [
    "",
    ...lines,
  ].join("\n");
}

// ─── Assistant Response ───────────────────────────────────────

function renderAssistantBubble(ansi: ReturnType<typeof createAnsi>, content: string): string {
  const maxW = 90;
  const wrapped = wrapText(content, maxW);
  const bodyLines = wrapped.map((line) => `${line}`);
  return [
    "",
    ...bodyLines,
    "",
  ].join("\n");
}

// ─── Context Bar ──────────────────────────────────────────────

function renderContextBar(
  ansi: ReturnType<typeof createAnsi>,
  used: number,
  max: number,
): string {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  const percent = Math.round(ratio * 100);
  const barWidth = 20;
  const filledWidth = Math.round(ratio * barWidth);
  const emptyWidth = barWidth - filledWidth;

  let bar: string;
  let label: string;
  if (ratio < 0.5) {
    bar = ansi.green("■").repeat(filledWidth) + ansi.dim("□").repeat(emptyWidth);
    label = ansi.green(`${percent}%`);
  } else if (ratio < 0.8) {
    bar = ansi.yellow("■").repeat(filledWidth) + ansi.dim("□").repeat(emptyWidth);
    label = ansi.yellow(`${percent}%`);
  } else {
    bar = ansi.red("■").repeat(filledWidth) + ansi.dim("□").repeat(emptyWidth);
    label = ansi.brightRed(`${percent}%`);
  }

  return `${ansi.dim("ctx")}[${bar}] ${label} ${ansi.dim(`${formatTokenCount(used)}/${formatTokenCount(max)}`)}`;
}

// ─── Tool Call Rendering ──────────────────────────────────────

function renderToolCallLine(
  ansi: ReturnType<typeof createAnsi>,
  name: string,
  input: Record<string, unknown>,
): string {
  const verb = inferToolVerb(name);
  const accent = toolAccentColor(name);
  const primaryArg = inferToolPrimaryArg(name, input);
  const icon = inferToolIcon(name);

  // Main action line: icon + verb + primary arg
  const mainPart = primaryArg
    ? `${ansi[accent](verb)} ${ansi.brightWhite(truncateText(primaryArg, 70))}`
    : `${ansi[accent](verb)}`;

  // Indented detail line: dim tool name + key input params
  const detailParts: string[] = [ansi.dim(name)];
  const inputEntries = Object.entries(input || {})
    .filter(([k, v]) => v != null && v !== "" && k !== "path" && k !== "query" && k !== "url" && k !== "command")
    .slice(0, 3)
    .map(([k, v]) => `${k}=${truncateText(JSON.stringify(v), 30)}`);
  if (inputEntries.length > 0) {
    detailParts.push(ansi.dim(inputEntries.join(" ")));
  }
  const detailLine = `${icon}  ${detailParts.join(" · ")}`;

  return `  ${icon} ${mainPart}\n  ${detailLine}`;
}

function renderToolResultLine(
  ansi: ReturnType<typeof createAnsi>,
  name: string,
  result: unknown,
): string {
  const verb = inferToolVerb(name);
  const pastVerb = verb.replace(/ing$/, "ed");
  const summary = buildToolResultSummary(name, result);
  const preview = buildToolResultPreviewShort(name, result);

  const parts: string[] = [ansi[C.success]("  ✓")];
  if (summary) {
    parts.push(ansi.dim(pastVerb));
    parts.push(ansi.dim(truncateText(summary, 70)));
  } else {
    parts.push(ansi.dim(pastVerb));
  }
  let line = parts.join(" ");
  if (preview) {
    line += `\n  ${ansi.dim("│")} ${ansi.dim(truncateText(preview, 80))}`;
  }
  return line;
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
    // Just update label if spinner is already running
    state.label = label;
    return;
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
  printTokenUsage(input: number, output: number): void;
} {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const useColor = options.useColor ?? Boolean(output.isTTY);
  const ansi = createAnsi(useColor);
  const interactivePaletteEnabled = supportsInteractiveShell(input, output);
  const historyFilePath = path.join(os.homedir(), ".mj-code-history");
  let commandHistory: string[] = loadHistory(historyFilePath);

  let promptActive = false;
  let rl: ReturnType<typeof createInterface> | null = null;
  let removeReadlineDriver: (() => void) | null = null;
  let lineSyncScheduled = false;
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
    queueMicrotask(() => {
      lineSyncScheduled = false;
      if (!interactivePaletteEnabled || !promptActive || !rl) {
        return;
      }
      void slashPalette.syncFromLine(rl.line).then(() => {
        syncPromptMode();
      });
    });
  }

  function syncPaletteNow(): void {
    if (!interactivePaletteEnabled || !promptActive || !rl) {
      return;
    }
    lineSyncScheduled = false;
    void slashPalette.syncFromLine(rl.line).then(() => {
      syncPromptMode();
    });
  }

  function handleKeypress(value: unknown, key: unknown, currentRl: unknown) {
    if (!interactivePaletteEnabled || !promptActive || !rl) {
      return { handled: false, selectedCommand: null, continuationLine: null };
    }
    const keyObj = key as { name?: string } | undefined;
    if (keyObj?.name !== "up" && keyObj?.name !== "down" && keyObj?.name !== "return" && keyObj?.name !== "enter") {
      const currentLine = typeof (currentRl as { line?: string })?.line === "string"
        ? (currentRl as { line?: string }).line!
        : "";
      if (currentLine.startsWith("/") || (typeof value === "string" && value === "/")) {
        syncPaletteNow();
      }
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
    rl = createInterface({ input, output, terminal: Boolean(output.isTTY), history: commandHistory });
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
        // Simple prompt indicator — no box frame
        if (Boolean(output.isTTY)) {
          const effortColor = currentEffortLevel === "max" ? "brightMagenta" : currentEffortLevel === "high" ? "brightCyan" : currentEffortLevel === "medium" ? "yellow" : "dim";
          output.write(`\n${ansi.dim("─── ")}${ansi.dim("turn " + (turnCounter + 1))}${ansi.dim(" · effort ")}${ansi[effortColor](EFFORT_LABELS[currentEffortLevel])}${ansi.dim(" ───")}\n`);
        }
        return runInteractiveShellAskLoop({
          interactivePaletteEnabled,
          palette: slashPalette,
          rl: currentRl,
          askQuestion: (currentPrompt: string) => question(currentRl, currentPrompt || prompt),
          applyPromptMode(nextMode) {
            promptMode = nextMode;
            applyInteractiveShellPrompt(currentRl, buildInteractiveShellPrompt(nextMode));
          },
        }).then((answer) => {
          const trimmedAnswer = typeof answer === "string" ? answer.trim() : "";
          if (trimmedAnswer) {
            appendHistory(historyFilePath, commandHistory, trimmedAnswer);
          }
          return answer;
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
      if (!Boolean(output.isTTY)) {
        return true;
      }
      const currentRl = ensureInterface();
      output.write(`\n  ${ansi.bold(ansi.yellow("?"))} ${prompt}\n`);
      const answer = (await question(currentRl, `  ${ansi.brightCyan("▸")} ${ansi.dim("[y/N]")} `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },

    async confirmAction(context: Record<string, unknown>) {
      const riskLevel = String((context.risk as Record<string, unknown>)?.level ?? "LOW").toUpperCase();

      if (!Boolean(output.isTTY) && (riskLevel === "LOW" || riskLevel === "MEDIUM")) {
        return true;
      }

      const currentRl = ensureInterface();

      const verb = inferToolVerb(String(context.toolName ?? "tool"));
      const riskIcon = riskLevel === "HIGH" ? ansi.brightRed("⬤") : riskLevel === "MEDIUM" ? ansi.yellow("●") : ansi.green("●");
      const paths = summarizeCompactValues(context.touchedPaths as string[], { limit: 3, formatter: compactPath });

      output.write(`\n  ${ansi.bold(ansi.yellow(`Allow ${verb}?`))} ${riskIcon} ${ansi.dim(`risk=${riskLevel}`)}\n`);
      if (paths !== "none") {
        output.write(`  ${ansi.dim(`files · ${paths}`)}\n`);
      }

      // Show a small preview of changes
      const previewLines = buildApprovalPreviewLines(context as Parameters<typeof buildApprovalPreviewLines>[0]);
      for (const line of previewLines.slice(0, 3)) {
        output.write(`  ${ansi.dim(line)}\n`);
      }

      const rollbackLabel = context.rollbackAvailable ? ansi.green("available") : ansi.dim("none");
      output.write(`  ${ansi.dim("rollback")} ${rollbackLabel}\n`);

      const answer = (await question(currentRl, `  ${ansi.brightCyan("▸")} ${ansi.dim("[y/N]")} `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },

    printBanner(status: Record<string, unknown>, sessionPath: string | null) {
      resetTurnCounter();
      const typedStatus = {
        provider: String(status.provider ?? "unknown"),
        model: status.model ? String(status.model) : null,
        permissionMode: String(status.permissionMode ?? "default"),
        approvalPolicy: String(status.approvalPolicy ?? "ask"),
        networkMode: String(status.networkMode ?? "off"),
        cwd: String(status.cwd ?? process.cwd()),
        effortLevel: currentEffortLevel,
      };

      output.write(
        renderBanner(ansi, typedStatus, sessionPath ?? "", {
          isTTY: Boolean(output.isTTY),
        }) + "\n",
      );
    },

    beginAssistantStream() {
      const turn = nextTurn();
      startSpinner(spinner, "thinking");
      return {
        raw: "",
        buffer: "",
        displayed: false,
        emittedContent: "",
        reasoningPhase: true,
        turnNum: turn,
      };
    },

    pushAssistantDelta(state: Record<string, unknown>, delta: string) {
      state.raw = (state.raw ?? "") + delta;
      state.buffer = (state.buffer ?? "") + delta;

      const raw = state.raw as string;
      const buffer = state.buffer as string;

      // Update spinner label on first meaningful content
      if (state.reasoningPhase && delta.trim()) {
        state.reasoningPhase = false;
        spinner.label = "responding";
      }

      // Try to extract final content from JSON protocol format
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
          output.write(`\n${ansi.bold(ansi[C.ai]("◆"))} ${nextText}`);
        } else {
          output.write(nextText);
        }

        state.emittedContent = jsonContent;
        return;
      }

      // Check if raw accumulated text looks like a JSON tool call
      const rawTrimmed = raw.trimStart();
      const looksLikeToolCall = rawTrimmed.startsWith('{"type":"tool_call"')
        || rawTrimmed.startsWith('{"type": "tool_call"')
        || rawTrimmed.startsWith('{"tool":')
        || rawTrimmed.startsWith('{"name":');
      if (looksLikeToolCall) {
        if (spinner.label !== "calling tool") {
          spinner.label = "calling tool";
        }
        return;
      }

      if (!state.displayed) {
        const trimmed = buffer.trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
          return;
        }

        const visibleContent = trimmed;
        if (!visibleContent) {
          return;
        }

        stopSpinner(spinner);
        output.write(`\r${ansi.clearLine()}`);
        state.displayed = true;
        output.write(`\n${ansi.bold(ansi[C.ai]("◆"))} ${visibleContent}`);
        return;
      }

      output.write(delta);
    },

    finishAssistantStream(state: Record<string, unknown>) {
      stopSpinner(spinner);
      if (state?.displayed) {
        output.write("\n");
      }
    },

    printAssistant(content: string) {
      output.write(`\n${ansi.bold(ansi[C.ai]("◆"))} ${content}\n`);
    },

    printUserMessage(content: string) {
      output.write(`\r${ansi.clearLine()}`);
      const turn = nextTurn();
      output.write(renderUserMessage(ansi, content, turn) + "\n");
    },

    printInfo(label: string, value: string) {
      const noisyLabels = ["context", "repair", "fallback", "provider"];
      if (noisyLabels.includes(label)) {
        return;
      }

      if (label === "compact") {
        output.write(`  ${ansi[C.brand]("◆")} ${ansi.bold("compacting")} ${ansi.dim(truncateText(value, 100))}\n`);
        return;
      }
      if (label === "summary") {
        output.write(`  ${ansi.dim("│")} ${ansi.dim(truncateText(value, 120))}\n`);
        return;
      }
      if (label === "state") {
        output.write(`  ${ansi[C.success]("✓")} ${ansi.dim(value)}\n`);
        return;
      }
      if (label === "model") {
        output.write(`  ${ansi[C.brand]("◆")} ${ansi.dim(value)}\n`);
        return;
      }
      if (label === "network") {
        output.write(`  ${ansi[C.toolNetwork]("◆")} ${ansi.dim(value)}\n`);
        return;
      }
      if (label === "mcp") {
        output.write(`  ${ansi[C.toolMcp]("◆")} ${ansi.dim(value)}\n`);
        return;
      }
      if (label === "resume") {
        output.write(`  ${ansi[C.brand]("◆")} ${ansi.dim(value)}\n`);
        return;
      }

      output.write(`${ansi.dim(`  ${label} ${value}`)}\n`);
    },

    printWarning(value: string) {
      output.write(`  ${ansi[C.warning]("⚠")} ${ansi.yellow(value)}\n`);
    },

    printError(value: string) {
      output.write(`  ${ansi[C.error]("✖")} ${ansi.red(value)}\n`);
    },

    printProviderFailure(details: Record<string, unknown>) {
      const message = details?.message ?? "Provider request failed";
      const provider = details?.provider ?? "provider";
      const taxonomy = details?.taxonomy ?? "provider_error";
      output.write(`  ${ansi[C.error]("✖")} ${ansi.red(`${provider}`)} ${ansi.dim(`${taxonomy}: ${truncateText(String(message), 60)}`)}\n`);

      // Show retry hint if retryable
      if (details?.retryable) {
        output.write(`  ${ansi.dim("│")} ${ansi.dim("retryable — will attempt again")}\n`);
      }
    },

    printProviderEvent(event: Record<string, unknown>) {
      // Show meaningful provider events only
      const line = buildProviderEventLine(event);
      if (line) {
        output.write(`  ${ansi.dim("│")} ${ansi.dim(line)}\n`);
      }
    },

    printLocalContextPrefetch(result: Record<string, unknown>) {
      // Show file attachments as they're loaded
      const attachments = result?.attachments as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(attachments) && attachments.length > 0) {
        for (const att of attachments.slice(0, 3)) {
          const rel = String(att.relativePath ?? att.path ?? "file");
          const lines = att.lineCount ?? "?";
          output.write(`  ${ansi.dim("📎")} ${ansi.dim(compactPath(rel))} ${ansi.dim(`${lines} lines`)}\n`);
        }
        if (attachments.length > 3) {
          output.write(`  ${ansi.dim(`  +${attachments.length - 3} more`)}\n`);
        }
      }
    },

    printToolCall(name: string, inputValue: Record<string, unknown>) {
      stopSpinner(spinner);
      output.write(`\r${ansi.clearLine()}`);
      output.write(renderToolCallLine(ansi, name, inputValue) + "\n");
      // Restart spinner for the tool execution
      startSpinner(spinner, `executing ${name}`);
    },

    printToolResult(name: string, result: unknown) {
      stopSpinner(spinner);
      output.write(renderToolResultLine(ansi, name, result) + "\n");
    },

    printChangePreview(changeSet: Record<string, unknown>) {
      if (!changeSet) {
        return;
      }
      const touchedFiles = Array.isArray(changeSet.touchedFiles) ? (changeSet.touchedFiles as string[]) : [];
      const fileSummary = touchedFiles.length > 0
        ? touchedFiles.slice(0, 3).map(compactPath).join(", ")
        : "changes";

      output.write(`  ${ansi[C.toolWrite]("✏")} ${ansi.dim(`${touchedFiles.length} file(s) · ${fileSummary}`)}\n`);
    },

    printSection(title: string, body: string) {
      output.write(`\n  ${ansi.bold(ansi[C.brand](`◆ ${title}`))}\n  ${ansi.dim("│")}\n${body}\n`);
    },

    printAbout() {
      output.write(`${renderAgentAboutCard()}\n`);
    },

    printContextBar(used: number, max: number) {
      output.write("  " + renderContextBar(ansi, used, max) + "\n");
    },

    printEffortLevel(level: EffortLevel) {
      const color = level === "max" ? "brightMagenta" : level === "high" ? "brightCyan" : level === "medium" ? "yellow" : "dim";
      output.write(`  ${ansi.dim("effort")} ${ansi.bold(ansi[color](EFFORT_LABELS[level]))} ${ansi.dim(`(${level})`)}\n`);
    },

    printTokenUsage(inputTokens: number, outputTokens: number) {
      const total = inputTokens + outputTokens;
      if (total <= 0) {
        return;
      }
      const inputStr = formatTokenCount(inputTokens);
      const outputStr = formatTokenCount(outputTokens);
      const bar = renderTokenBar(ansi, inputTokens, outputTokens);
      output.write(`  ${bar} ${ansi.dim(`${inputStr} in · ${outputStr} out · ${formatTokenCount(total)} total`)}\n`);
    },

    isInteractiveShell() {
      return interactivePaletteEnabled;
    },

    close() {
      stopSpinner(spinner);
      lineSyncScheduled = false;
      saveHistory(historyFilePath, commandHistory);
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
  return `…/${parts.slice(-3).join("/")}`;
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
    return "read";
  }
  if (["write_file", "replace_in_file", "apply_patch"].includes(name)) {
    return "write";
  }
  if (["web_search", "fetch_url", "extract_content"].includes(name)) {
    return "network";
  }
  if (name === "run_shell") {
    return "shell";
  }
  if (["remember_memory", "search_memory", "forget_memory"].includes(name)) {
    return "memory";
  }
  if (["list_docs", "read_doc", "search_docs"].includes(name)) {
    return "docs";
  }
  if (name === "run_sandbox") {
    return "sandbox";
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const serverId = parts.length >= 2 ? parts[1] : "mcp";
    return `mcp/${serverId}`;
  }
  return "tool";
}

function inferToolIcon(name: string): string {
  if (["read_file"].includes(name)) return "📖";
  if (["list_dir", "pwd"].includes(name)) return "📁";
  if (["search_files"].includes(name)) return "🔍";
  if (["write_file"].includes(name)) return "📝";
  if (["replace_in_file", "apply_patch"].includes(name)) return "✏️";
  if (name === "web_search") return "🔎";
  if (name === "fetch_url") return "🌐";
  if (name === "extract_content") return "📄";
  if (name === "run_shell") return "⚡";
  if (name === "run_sandbox") return "🛡️";
  if (name === "check_sandbox") return "🔒";
  if (name === "remember_memory") return "💭";
  if (name === "search_memory") return "🧠";
  if (name === "forget_memory") return "🗑️";
  if (["list_docs", "read_doc", "search_docs"].includes(name)) return "📚";
  if (name.startsWith("mcp__")) return "🔌";
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
  if (name === "web_search") return "Searching web";
  if (name === "fetch_url") return "Fetching";
  if (name === "extract_content") return "Extracting";
  if (name === "remember_memory") return "Remembering";
  if (name === "search_memory") return "Recalling";
  if (name === "forget_memory") return "Forgetting";
  if (name === "check_sandbox") return "Checking";
  if (name === "run_sandbox") return "Sandboxing";
  if (["list_docs"].includes(name)) return "Listing docs";
  if (["read_doc"].includes(name)) return "Reading doc";
  if (["search_docs"].includes(name)) return "Searching docs";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const toolPart = parts.length >= 3 ? parts.slice(2).join("_") : parts[parts.length - 1];
    return `Calling ${toolPart}`;
  }
  return name.replace(/_/g, " ");
}

function toolAccentColor(name: string): "cyan" | "green" | "yellow" | "red" | "magenta" | "blue" {
  if (["read_file", "list_dir", "search_files", "pwd"].includes(name)) return "blue";
  if (["write_file", "replace_in_file", "apply_patch"].includes(name)) return "yellow";
  if (["web_search", "fetch_url", "extract_content"].includes(name)) return "magenta";
  if (name === "run_shell" || name === "run_sandbox") return "red";
  if (["remember_memory", "search_memory", "forget_memory"].includes(name)) return "cyan";
  if (["list_docs", "read_doc", "search_docs"].includes(name)) return "blue";
  if (name.startsWith("mcp__")) return "green";
  return "green";
}

function buildToolResultSummary(name: string, result: unknown): string {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (name === "read_file" && typeof r.path === "string") {
      return `${compactPath(r.path)} · ${r.lineCount ?? "?"} lines`;
    }
    if (name === "list_dir" && Array.isArray(r.entries)) {
      const dirs = (r.entries as Array<Record<string, unknown>>).filter(e => e.kind === "directory").length;
      const files = (r.entries as Array<Record<string, unknown>>).length - dirs;
      return `${dirs} dirs · ${files} files`;
    }
    if (name === "search_files" && Array.isArray(r.matches)) {
      return `${(r.matches as unknown[]).length} matches`;
    }
    if (name === "web_search" && Array.isArray(r.results)) {
      return `${(r.results as unknown[]).length} results`;
    }
    if (name === "fetch_url" && typeof r.contentType === "string") {
      return `${r.contentType}`;
    }
    if (name === "extract_content" && r.extracted) {
      const extracted = r.extracted as Record<string, unknown>;
      const title = typeof extracted.title === "string" ? extracted.title : "";
      return title ? truncateText(title, 60) : "extracted";
    }
    if (name === "run_shell") {
      const exitCode = r.exitCode ?? r.exit_code ?? null;
      if (exitCode === 0) return "success";
      if (exitCode != null) return `exit ${exitCode}`;
      return r.status ? String(r.status) : "executed";
    }
    if (r.bytesWritten != null) {
      return `${r.bytesWritten} bytes`;
    }
  }
  return "";
}

function buildToolResultPreviewShort(name: string, result: unknown): string {
  if (!result || typeof result !== "object") return "";

  const r = result as Record<string, unknown>;

  if (name === "search_files" && Array.isArray(r.matches)) {
    const matches = (r.matches as Array<Record<string, unknown>>).slice(0, 3);
    return matches.map(m => `${compactPath(String(m.path ?? ""))}:${m.line ?? "?"} ${truncateText(String(m.preview ?? ""), 40)}`).join(" · ");
  }

  if (name === "web_search" && Array.isArray(r.results)) {
    const results = (r.results as Array<Record<string, unknown>>).slice(0, 3);
    return results.map(r => truncateText(String(r.title ?? ""), 30)).join(" · ");
  }

  if (name === "list_dir" && Array.isArray(r.entries)) {
    const entries = (r.entries as Array<Record<string, unknown>>).slice(0, 5);
    return entries.map(e => `${e.kind === "directory" ? "/" : ""}${e.name ?? ""}`).join(" ");
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

function buildApprovalPreviewLines(context: {
  previewSummary?: string[];
  touchedPaths?: string[];
}): string[] {
  const preview = Array.isArray(context.previewSummary) && context.previewSummary.length > 0
    ? context.previewSummary
    : context.touchedPaths;
  return preview
    ?.slice(0, 4)
    .map((line) => truncateText(line, 70)) ?? [];
}

function buildProviderEventLine(event: Record<string, unknown>): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  if (event.type === "provider_attempt_started") {
    return `${event.provider ?? "provider"} · attempt ${event.attempt ?? 1}`;
  }
  if (event.type === "provider_retry_scheduled") {
    return `retrying · attempt ${event.attempt ?? "?"} · in ${event.delayMs ?? 0}ms`;
  }
  if (event.type === "provider_native_tool_protocol_fallback") {
    return "switching to JSON tool protocol";
  }
  return null;
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

/**
 * Render a compact inline token usage bar.
 * Shows input (blue) vs output (green) proportion.
 */
function renderTokenBar(
  ansi: ReturnType<typeof createAnsi>,
  inputTokens: number,
  outputTokens: number,
): string {
  const total = inputTokens + outputTokens;
  if (total <= 0) return "";

  const barWidth = 16;
  const inputRatio = inputTokens / total;
  const inputWidth = Math.max(1, Math.round(inputRatio * barWidth));
  const outputWidth = Math.max(1, barWidth - inputWidth);

  return `${ansi.dim("[")}${ansi.blue("▓").repeat(inputWidth)}${ansi.green("▓").repeat(outputWidth)}${ansi.dim("]")}`;
}
