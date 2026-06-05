import type {
  InteractiveSessionPickerMode,
} from "../types/contracts.js";

export interface ParsedInteractiveSessionPickerLine {
  mode: InteractiveSessionPickerMode;
  query: string | null;
  reference: string | null;
}

const INTERACTIVE_SESSION_PICKER_ROOTS = new Set<string>([
  "/continue",
  "/resume",
  "/resume recommend",
  "/resume lineage",
  "/history sessions",
  "/history lineage",
  "/history replay",
]);

const INTERACTIVE_SLASH_DIRECT_ROOTS = new Set<string>([
  "/help",
  "/about",
  "/effort",
  "/tools",
  "/capabilities",
  "/config",
  "/status",
  "/model",
  "/provider",
  "/instructions",
  "/models",
  "/memory",
  "/skills",
  "/skill",
  "/plugins",
  "/plugin",
  "/search",
  "/fetch",
  "/extract",
  "/sources",
  "/network-mode",
  "/mcp",
  "/runtime",
  "/route",
  "/plan",
  "/why",
  "/next",
  "/recover",
  "/verifier",
  "/eval",
  "/diff",
  "/undo",
  "/history",
  "/replay",
  "/trace",
  "/approve-mode",
  "/jobs",
  "/cancel",
  "/tail",
  "/attach",
  "/shell-history",
  "/compact",
  "/cost",
  "/clear",
  "/session",
  "/exit",
  "/quit",
]);

const INTERACTIVE_EXACT_EXECUTION_COMMANDS = new Set<string>([
  "/status summary",
  "/about",
  "/diff",
  "/undo",
  "/clear",
  "/exit",
  "/help",
  "/help advanced",
  "/help debug",
  "/session",
  "/effort max",
  "/effort high",
  "/effort medium",
  "/effort low",
  "/compact",
  "/cost",
  "/memory",
  "/memory search",
  "/why overview current summary",
  "/why plan current summary",
  "/next current summary",
  "/recover current summary",
  "/history sessions summary",
  "/history lineage current summary",
  "/history replay latest summary",
  "/resume recommend current summary",
  "/resume lineage current summary",
  "/plan current summary",
  "/plan timeline current summary",
  "/verifier summary",
  "/verifier drilldown latest summary",
  "/runtime",
  "/model",
  "/provider",
  "/jobs",
]);

export function isInteractiveSessionPickerRootCommand(command: string): boolean {
  return INTERACTIVE_SESSION_PICKER_ROOTS.has(command);
}

export function normalizeInteractiveShellAnswer(answer: string): string {
  const normalized = `${answer ?? ""}`.trim();
  if (!normalized.startsWith("/")) {
    return normalized;
  }
  const roots = [...INTERACTIVE_SESSION_PICKER_ROOTS].sort((left, right) => right.length - left.length);
  for (const root of roots) {
    if (normalized === root || !normalized.startsWith(root)) {
      continue;
    }
    const suffix = normalized.slice(root.length);
    if (suffix.startsWith("/")) {
      return suffix.trim();
    }
    if (suffix.length > 0 && !/^\s/.test(suffix)) {
      return suffix.trimStart();
    }
  }
  return normalized;
}

export function shouldBypassInteractiveShellOverlay(answer: string): boolean {
  const normalized = normalizeInteractiveShellAnswer(`${answer ?? ""}`).toLowerCase();
  if (!normalized.startsWith("/") || normalized === "/") {
    return false;
  }
  if (INTERACTIVE_EXACT_EXECUTION_COMMANDS.has(normalized)) {
    return true;
  }
  if (isDirectInteractiveSessionReportCommand(normalized)) {
    return true;
  }
  if (parseInteractiveSessionPickerLine(normalized)) {
    return false;
  }
  if (normalized.includes(" ")) {
    return true;
  }
  const command = normalized.split(/\s+/)[0] ?? normalized;
  return INTERACTIVE_SLASH_DIRECT_ROOTS.has(command);
}

export function shouldHydrateInteractiveShellAnswer(answer: string): boolean {
  const normalized = normalizeInteractiveShellAnswer(`${answer ?? ""}`);
  if (!normalized.startsWith("/")) {
    return false;
  }
  if (normalized === "/") {
    return true;
  }
  if (shouldBypassInteractiveShellOverlay(normalized)) {
    return false;
  }
  if (parseInteractiveSessionPickerLine(normalized)) {
    return true;
  }
  return !normalized.includes(" ");
}

export function parseInteractiveSessionPickerLine(
  line: string,
): ParsedInteractiveSessionPickerLine | null {
  const normalized = `${line ?? ""}`.trim();
  if (!normalized.startsWith("/")) {
    return null;
  }
  const parts = normalized.split(/\s+/);
  if (parts.some((part, index) => index > 0 && isSessionBrowserProfile(part))) {
    return null;
  }
  const command = parts[0] ?? "";
  const first = parts[1] ?? null;
  const second = parts[2] ?? null;
  const third = parts[3] ?? null;

  if (command === "/continue") {
    if (first === "__actions__" && second) {
      return { mode: "continue_actions", query: null, reference: second };
    }
    if (!first) {
      return { mode: "continue", query: null, reference: "current" };
    }
    return { mode: "continue", query: first, reference: "current" };
  }

  if (command === "/resume") {
    if (first === "__actions__" && second) {
      return { mode: "resume_actions", query: null, reference: second };
    }
    if (!first) {
      return { mode: "resume", query: null, reference: "current" };
    }
    if (first === "recommend") {
      if (second === "__actions__" && third) {
        return { mode: "resume_recommend_actions", query: null, reference: third };
      }
      if (!second) {
        return { mode: "resume_recommend", query: null, reference: "current" };
      }
      return { mode: "resume_recommend", query: second, reference: "current" };
    }
    if (first === "lineage") {
      if (!second) {
        return { mode: "history_lineage", query: null, reference: "current" };
      }
      return { mode: "history_lineage", query: second, reference: "current" };
    }
    return { mode: "resume", query: first, reference: "current" };
  }

  if (command === "/history") {
    if (first === "sessions") {
      if (second === "__actions__" && third) {
        return { mode: "history_sessions_actions", query: null, reference: third };
      }
      if (!second) {
        return { mode: "history_sessions", query: null, reference: "current" };
      }
      return { mode: "history_sessions", query: second, reference: "current" };
    }
    if (first === "lineage") {
      if (second === "__actions__" && third) {
        return { mode: "history_lineage_actions", query: null, reference: third };
      }
      if (!second) {
        return { mode: "history_lineage", query: null, reference: "current" };
      }
      return { mode: "history_lineage", query: second, reference: "current" };
    }
    if (first === "replay") {
      if (second === "__actions__" && third) {
        return { mode: "history_replay_actions", query: null, reference: third };
      }
      if (!second) {
        return { mode: "history_replay", query: null, reference: "current" };
      }
      return { mode: "history_replay", query: second, reference: "current" };
    }
  }

  return null;
}

export function deriveInteractiveContinuationDisplayLine(
  continuationLine: string,
  fallback: string,
): string {
  if (typeof continuationLine !== "string" || !continuationLine.startsWith("/")) {
    return fallback;
  }
  const parts = continuationLine.split(/\s+/);
  if (parts[0] === "/continue" && parts[1] === "__actions__") {
    return "/continue";
  }
  if (parts[0] === "/resume" && parts[1] === "__actions__") {
    return "/resume";
  }
  if (parts[0] === "/resume" && parts[1] === "recommend" && parts[2] === "__actions__") {
    return "/resume recommend";
  }
  if (parts[0] === "/history" && parts[1] === "sessions" && parts[2] === "__actions__") {
    return "/history sessions";
  }
  if (parts[0] === "/history" && parts[1] === "lineage" && parts[2] === "__actions__") {
    return "/history lineage";
  }
  if (parts[0] === "/history" && parts[1] === "replay" && parts[2] === "__actions__") {
    return "/history replay";
  }
  return fallback;
}

function isSessionBrowserProfile(value: string | null): boolean {
  return value === "json" || value === "summary" || value === "failures";
}

function isDirectInteractiveSessionReportCommand(line: string): boolean {
  const parts = line.split(/\s+/);
  const command = parts[0] ?? "";
  const first = parts[1] ?? null;
  const second = parts[2] ?? null;
  const third = parts[3] ?? null;

  if (command === "/continue") {
    return isSessionBrowserProfile(first) || isSessionBrowserProfile(second);
  }
  if (command === "/resume" && (first === "recommend" || first === "lineage")) {
    return isSessionBrowserProfile(second) || isSessionBrowserProfile(third);
  }
  if (command === "/history" && first === "sessions") {
    return isSessionBrowserProfile(second);
  }
  if (command === "/history" && (first === "lineage" || first === "replay")) {
    return isSessionBrowserProfile(second) || isSessionBrowserProfile(third);
  }
  return false;
}
