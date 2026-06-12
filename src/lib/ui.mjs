import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";

import { createAnsi } from "./ansi.mjs";
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

function compactPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) {
    return normalized;
  }
  return `.../${parts.slice(-3).join("/")}`;
}

function summarizeCompactValues(values, options = {}) {
  const limit = options.limit ?? 3;
  const formatter = typeof options.formatter === "function"
    ? options.formatter
    : (value) => value;
  const items = Array.isArray(values)
    ? values
      .map((value) => formatter(value))
      .filter((value) => typeof value === "string" && value.length > 0)
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

function clipPanelLines(value, options = {}) {
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

function renderApprovalScopeLine(context) {
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
      `readonly=${context.mcp.annotations?.readOnlyHint ? "yes" : "no"}`,
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

function buildApprovalPreviewLines(context) {
  const preview = Array.isArray(context.previewSummary) && context.previewSummary.length > 0
    ? context.previewSummary
    : context.touchedPaths;
  return preview
    .slice(0, 4)
    .map((line) => `  ${truncateText(line, 58)}`);
}

function buildChangePreviewLines(changeSet) {
  if (typeof changeSet?.diff === "string" && changeSet.diff.trim().length > 0) {
    return clipPanelLines(changeSet.diff, { maxLines: 10, maxWidth: 58 });
  }
  return (changeSet?.files ?? [])
    .slice(0, 4)
    .map((entry) => `  ${truncateText(entry.summary ?? entry.path ?? "change", 58)}`);
}

function compactEndpoint(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "unknown";
  }
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return truncateText(value, 58);
  }
}

function getProviderDetailMessage(details) {
  const detailMessage = details?.details && typeof details.details === "object"
    ? details.details.message
    : null;
  return typeof detailMessage === "string" && detailMessage.length > 0
    ? detailMessage
    : details?.message ?? "provider request failed";
}

function buildProviderAttemptLines(details) {
  const attempts = Array.isArray(details?.attempts) ? details.attempts : [];
  if (attempts.length === 0) {
    return [`  ${truncateText(getProviderDetailMessage(details), 58)}`];
  }
  return attempts.slice(-4).map((attempt) => [
    `  #${attempt.attempt ?? "?"}`,
    attempt.status != null ? `status=${attempt.status}` : "network",
    attempt.code ? `code=${attempt.code}` : null,
    attempt.durationMs != null ? `${attempt.durationMs}ms` : null,
    attempt.delayMs ? `retry+${attempt.delayMs}ms` : null,
  ].filter(Boolean).join(" · "));
}

function buildProviderFailureRows(details) {
  const attempts = Array.isArray(details?.attempts) ? details.attempts.length : (details?.attempt ?? 0);
  return [
    `taxonomy · ${details?.taxonomy ?? "provider_error"}`,
    `provider · ${details?.provider ?? "unknown"}`,
    `request · ${details?.requestType ?? "unknown"}`,
    `endpoint · ${compactEndpoint(details?.endpoint)}`,
    `attempts · ${attempts || "unknown"} · retryable=${details?.retryable ? "yes" : "no"}`,
    details?.status != null ? `status · ${details.status}` : `reason · ${truncateText(getProviderDetailMessage(details), 58)}`,
    details?.circuitState ? `circuit · ${details.circuitState}` : null,
  ].filter(Boolean);
}

function summarizeToolInput(value) {
  if (!value || typeof value !== "object") {
    return "input · none";
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue != null && entryValue !== "")
    .slice(0, 4)
    .map(([key, entryValue]) => `${key}=${JSON.stringify(entryValue)}`);
  return entries.length > 0
    ? `input · ${truncateText(entries.join(" · "), 58)}`
    : "input · none";
}

function buildToolResultRows(name, result) {
  if (result && typeof result === "object") {
    const rows = [];
    if (typeof result.path === "string") {
      rows.push(`path · ${compactPath(result.path) ?? result.path}`);
    }
    if (result.startLine != null || result.endLine != null) {
      rows.push(`lines · ${result.startLine ?? "?"}-${result.endLine ?? "?"}`);
    }
    if (Array.isArray(result.entries)) {
      rows.push(`entries · ${result.entries.length}${result.truncated ? " · truncated" : ""}`);
    }
    if (Array.isArray(result.matches)) {
      rows.push(`matches · ${result.matches.length} · engine=${result.engine ?? "unknown"}`);
    }
    if (result.bytesWritten != null) {
      rows.push(`write · ${result.bytesWritten} bytes`);
    }
    if (result.jobId) {
      rows.push(`job · ${result.jobId} · status=${result.status ?? "unknown"}`);
    }
    if (rows.length > 0) {
      return rows;
    }
  }
  return [`summary · ${truncateText(summarizeResult(result), 58)}`];
}

function buildToolResultMeta(name, result) {
  if (result && typeof result === "object") {
    if (name === "read_file" && typeof result.path === "string") {
      return `${compactPath(result.path) ?? result.path} · lines ${result.startLine ?? "?"}-${result.endLine ?? "?"}`;
    }
    if (name === "list_dir" && Array.isArray(result.entries)) {
      return `${compactPath(result.path) ?? "directory"} · ${result.entries.length} entries${result.truncated ? " · clipped" : ""}`;
    }
    if (name === "search_files" && Array.isArray(result.matches)) {
      return `${result.matches.length} matches · ${result.engine ?? "search"}`;
    }
    if (name === "run_shell" && result.jobId) {
      return `job ${result.jobId} · ${result.status ?? "unknown"}`;
    }
    if (result.bytesWritten != null) {
      return `${result.bytesWritten} bytes written`;
    }
  }
  return truncateText(summarizeResult(result), 58);
}

function buildToolResultPreview(result) {
  if (result && typeof result === "object" && typeof result.content === "string") {
    return clipPanelLines(result.content, { maxLines: 4, maxWidth: 58 });
  }
  if (result && typeof result === "object" && Array.isArray(result.matches)) {
    return result.matches.slice(0, 4).map((entry) =>
      `  ${truncateText(`${compactPath(entry.path) ?? entry.path}:${entry.line ?? "?"} ${entry.preview ?? ""}`, 58)}`
    );
  }
  if (result && typeof result === "object" && Array.isArray(result.entries)) {
    return result.entries.slice(0, 4).map((entry) =>
      `  ${truncateText(`${entry.kind ?? "item"} ${entry.name ?? ""}`, 58)}`
    );
  }
  return [];
}

function buildProviderEventLine(event) {
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

function buildLocalContextRows(result) {
  return result.attachments.slice(0, 4).map((entry) =>
    `file · ${truncateText(`${entry.relativePath} · ${entry.lineCount} lines · ${entry.bytes} bytes${entry.truncated ? " · clipped" : ""}`, 58)}`
  );
}

function inferToolScope(name) {
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

function inferToolIcon(name) {
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

function inferToolVerb(name) {
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

function buildToolResultSummarySimple(name, result) {
  if (result && typeof result === "object") {
    const r = result;
    if (name === "read_file" && typeof r.path === "string") {
      return `${compactPath(r.path)} · lines ${r.startLine ?? "?"}-${r.endLine ?? "?"}`;
    }
    if (name === "list_dir" && Array.isArray(r.entries)) {
      return `${r.entries.length} entries`;
    }
    if (name === "search_files" && Array.isArray(r.matches)) {
      return `${r.matches.length} matches`;
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

function inferToolPrimaryArg(name, input) {
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

export function createTerminalUi(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const useColor = options.useColor ?? Boolean(output.isTTY);
  const ansi = createAnsi(useColor);
  const interactivePaletteEnabled = supportsInteractiveShell(input, output);
  let promptActive = false;
  let rl = null;
  let removeReadlineDriver = null;
  let lineSyncScheduled = false;
  let lineSyncTimer = null;
  let promptMode = "input";
  const slashPalette = createSlashPaletteController({ ansi, output });

  function syncPromptMode() {
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

  function schedulePaletteSync() {
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

  function handleKeypress(value, key, currentRl) {
    if (!interactivePaletteEnabled || !promptActive || !rl) {
      return { handled: false, continuationLine: null };
    }
    const result = slashPalette.handleKeypress(key, currentRl ?? rl, value);
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

  function handleRawInput(chunk) {
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
        handleContinuation(continuationLine) {
          void slashPalette.syncFromContinuation(rl.line, continuationLine).then(() => {
            syncPromptMode();
          });
        },
        scheduleSync: handleRawInput,
      });
    }
    return rl;
  }

  return {
    async ask(prompt) {
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
          askQuestion: (currentPrompt) => question(currentRl, currentPrompt || prompt),
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

    setInteractiveResolver(resolver) {
      slashPalette.setPickerResolver(resolver);
    },

    async confirm(prompt) {
      promptActive = true;
      slashPalette.close();
      try {
        const currentRl = ensureInterface();
        setInteractiveRawMode(input, interactivePaletteEnabled, true);
        output.write(`${ansi.yellow("approve")} ${prompt} [y/N] `);
        const answer = (await question(currentRl, "")).trim().toLowerCase();
        return answer === "y" || answer === "yes";
      } finally {
        promptActive = false;
        slashPalette.close();
        setInteractiveRawMode(input, interactivePaletteEnabled, false);
      }
    },

    async confirmAction(context) {
      promptActive = true;
      slashPalette.close();
      try {
        const currentRl = ensureInterface();
        setInteractiveRawMode(input, interactivePaletteEnabled, true);
        const paths = summarizeCompactValues(context.touchedPaths, { limit: 3, formatter: compactPath });

        output.write(`\n${ansi.bold(ansi.yellow(`Allow?`))}\n`);
        output.write(`${ansi.dim(`  ${paths} · rollback ${context.rollbackAvailable ? "yes" : "no"}`)}\n`);

        const previewLines = buildApprovalPreviewLines(context);
        for (const line of previewLines.slice(0, 3)) {
          output.write(`${ansi.dim(line)}\n`);
        }

        const answer = (await question(currentRl, `${ansi.dim("y/N> ")}`)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
      } finally {
        promptActive = false;
        slashPalette.close();
        setInteractiveRawMode(input, interactivePaletteEnabled, false);
      }
    },

    printBanner(status, sessionPath) {
      const isTTY = Boolean(output.isTTY);
      if (!isTTY) {
        const lines = buildShellChromeLines(ansi, status, sessionPath, { isTTY: false });
        output.write(`${lines.join("\n")}\n`);
        return;
      }
      const repoLabel = path.basename(status.cwd || process.cwd());
      const providerLabel = `${status.provider}/${status.model ?? "auto"}`;
      output.write(`\n${ansi.brightCyan("  ┌──────────────────────────────────────────┐")}\n`);
      output.write(`${ansi.brightCyan("  │")} ${ansi.bold(ansi.brightCyan("◆ MJ Code"))} ${ansi.dim(`· ${providerLabel}`)}\n`);
      output.write(`${ansi.brightCyan("  │")} ${ansi.dim(`${repoLabel} · ${status.permissionMode} · net=${status.networkMode}`)}\n`);
      output.write(`${ansi.brightCyan("  └──────────────────────────────────────────┘")}\n\n`);
    },

    beginAssistantStream() {
      return {
        raw: "",
        buffer: "",
        displayed: false,
        emittedContent: "",
      };
    },

    pushAssistantDelta(state, delta) {
      state.raw += delta;
      state.buffer += delta;

      const jsonContent = extractFinalContentFromJson(state.raw);
      if (jsonContent != null) {
        const nextText = jsonContent.slice(state.emittedContent.length);
        if (!nextText) {
          return;
        }

        if (!state.displayed) {
          state.displayed = true;
          output.write(`\n${ansi.dim("  ◆ MJ Code")}\n${nextText}`);
        } else {
          output.write(nextText);
        }

        state.emittedContent = jsonContent;
        return;
      }

      if (!state.displayed) {
        const trimmed = state.buffer.trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
          return;
        }

        state.displayed = true;
        output.write(`\n${ansi.dim("  ◆ MJ Code")}\n${state.buffer}`);
        return;
      }

      output.write(delta);
    },

    finishAssistantStream(state) {
      if (state?.displayed) {
        output.write("\n");
      }
    },

    printAssistant(content) {
      output.write(`${ansi.cyan("ai")} ${content}\n`);
    },

    printInfo(label, value) {
      // Suppress noisy intermediate info messages
      const noisyLabels = ["context", "repair", "fallback", "provider"];
      if (noisyLabels.includes(label)) {
        return;
      }
      output.write(`${ansi.dim(`${label} ${value}`)}\n`);
    },

    printWarning(value) {
      output.write(`${ansi.yellow("warn")} ${value}\n`);
    },

    printError(value) {
      output.write(`${ansi.red("error")} ${value}\n`);
    },

    printProviderFailure(details) {
      const message = details?.message ?? "Provider request failed";
      const provider = details?.provider ?? "provider";
      output.write(`${ansi.red(`${provider}: ${truncateText(String(message), 70)}`)}\n`);
    },

    printProviderEvent(event) {
      // Suppress provider event noise
    },

    printLocalContextPrefetch(result) {
      // Suppress local context prefetch panel
    },

    printToolCall(name, inputValue) {
      // Claude Code-style tool call box
      const primaryArg = inferToolPrimaryArg(name, inputValue);
      const icon = inferToolIcon(name);
      const detail = primaryArg ? ` ${primaryArg}` : "";
      const borderLen = Math.max(name.length + 4, 10);
      const border = "─".repeat(Math.min(borderLen, 60));

      output.write(`${ansi.dim("╭─")} ${ansi.bold(ansi.brightCyan(name))} ${ansi.dim("─╮")}\n`);
      output.write(`${ansi.dim("│")} ${icon} ${ansi.dim(name)}${ansi.dim(detail)}\n`);
      output.write(`${ansi.dim("╰")}${border}${ansi.dim("╯")}\n`);
    },

    printToolResult(name, result) {
      // Claude Code-style result: ✓ ToolName summary
      const summary = buildToolResultSummarySimple(name, result);
      output.write(`${ansi.green("✓")} ${ansi.dim(name)}${summary ? ansi.dim(` · ${truncateText(summary, 60)}`) : ""}\n`);
    },

    printChangePreview(changeSet) {
      if (!changeSet) {
        return;
      }
      const touchedFiles = Array.isArray(changeSet.touchedFiles) ? changeSet.touchedFiles : [];
      const fileSummary = touchedFiles.length > 0
        ? touchedFiles.slice(0, 2).map(compactPath).join(", ")
        : "changes";
      output.write(`${ansi.dim(`  → ${touchedFiles.length} file(s) · ${fileSummary}`)}\n`);
    },

    printSection(title, body) {
      output.write(`${ansi.bold(title)}\n${body}\n`);
    },

    printAbout() {
      output.write(`${renderAgentAboutCard()}\n`);
    },

    isInteractiveShell() {
      return interactivePaletteEnabled;
    },

    close() {
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

export { INTERACTIVE_SHELL_PROMPT };
