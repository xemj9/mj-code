import crypto from "node:crypto";
import fs from "node:fs/promises";

import type { TsServerProtocolCodeFix } from "./tsserver-transport.mjs";
import type {
  CodeActionApplyBlockedReason,
  CodeActionCandidate,
  CodeActionBlockedReason,
  CodeActionCollection,
  CodeActionEdit,
  CodeActionEditChange,
} from "../types/contracts.js";

const MAX_CODE_ACTIONS = 24;
const MAX_CODE_ACTION_FILES = 4;
const MAX_CODE_ACTION_CHANGES = 6;
const MAX_CODE_ACTION_TEXT = 400;

interface AllowlistRule {
  id: string;
  matches(candidate: Omit<CodeActionCandidate, "allowlisted" | "allowlistRule" | "blockedReason">): boolean;
}

const ALLOWLIST_RULES: AllowlistRule[] = [
  {
    id: "add_import_single_file",
    matches(candidate) {
      return /^Add import from /i.test(candidate.title)
        || /^import$/i.test(candidate.fixName ?? "")
        || /^fixMissingImport$/i.test(candidate.fixName ?? "");
    },
  },
  {
    id: "remove_unused_single_file",
    matches(candidate) {
      return /^Remove unused declaration\b/i.test(candidate.title)
        || /^Delete unused import\b/i.test(candidate.title)
        || /^Delete unused imports$/i.test(candidate.title)
        || /^unusedIdentifier/i.test(candidate.fixName ?? "")
        || /^fixUnused/i.test(candidate.fixName ?? "");
    },
  },
];

export function normalizeTsServerCodeAction(input: {
  fix: TsServerProtocolCodeFix;
  diagnosticFingerprint: string;
  reason: string | null;
  recommended: boolean;
}): CodeActionCandidate {
  const edits = input.fix.changes
    .slice(0, MAX_CODE_ACTION_FILES)
    .map((change) => normalizeCodeActionEdit(change));
  const filePaths = uniqueStrings(
    edits
      .map((edit) => edit.path)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const candidateBase = {
    id: "",
    source: "tsserver" as const,
    title: input.fix.description,
    kind: input.fix.fixId ? "fix_all" as const : "quickfix" as const,
    reason: input.reason,
    recommended: input.recommended,
    diagnosticFingerprints: [input.diagnosticFingerprint],
    filePaths,
    edits,
    fixName: input.fix.fixName,
    fixId: input.fix.fixId,
  };
  const allowlist = evaluateAllowlist(candidateBase);
  const candidate: CodeActionCandidate = {
    ...candidateBase,
    allowlisted: allowlist.allowlisted,
    allowlistRule: allowlist.allowlistRule,
    blockedReason: allowlist.blockedReason,
  };
  return {
    ...candidate,
    id: createCodeActionId(candidate),
  };
}

export function mergeCodeActionCandidate(
  collection: Map<string, CodeActionCandidate>,
  candidate: CodeActionCandidate,
): void {
  const existing = collection.get(candidate.id);
  if (!existing) {
    collection.set(candidate.id, cloneCodeActionCandidate(candidate));
    return;
  }
  existing.recommended ||= candidate.recommended;
  existing.allowlisted ||= candidate.allowlisted;
  existing.allowlistRule ??= candidate.allowlistRule;
  existing.blockedReason ??= candidate.blockedReason;
  existing.reason ??= candidate.reason;
  existing.diagnosticFingerprints = uniqueStrings([
    ...existing.diagnosticFingerprints,
    ...candidate.diagnosticFingerprints,
  ]);
  existing.filePaths = uniqueStrings([
    ...existing.filePaths,
    ...candidate.filePaths,
  ]);
}

export function createTsServerCodeActionCollection(
  candidates: CodeActionCandidate[],
  reason: string | null = null,
): CodeActionCollection {
  const actions = candidates
    .map((candidate) => cloneCodeActionCandidate(candidate))
    .sort(compareCodeActionCandidates)
    .slice(0, MAX_CODE_ACTIONS);
  return {
    availability: {
      available: true,
      source: "tsserver",
      reason,
      transportAvailable: true,
      fallbackUsed: false,
      fallbackReason: null,
    },
    actions,
    summary: summarizeCodeActionCollection(actions, {
      available: true,
      source: "tsserver",
      reason,
    }),
  };
}

export function createUnavailableCodeActionCollection(input: {
  reason: string;
  transportAvailable: boolean | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}): CodeActionCollection {
  return {
    availability: {
      available: false,
      source: "unavailable",
      reason: input.reason,
      transportAvailable: input.transportAvailable,
      fallbackUsed: input.fallbackUsed,
      fallbackReason: input.fallbackReason,
    },
    actions: [],
    summary: {
      total: 0,
      allowlistedCount: 0,
      blockedCount: 0,
      fileCount: 0,
      available: false,
      source: "unavailable",
      reason: input.reason,
    },
  };
}

export function cloneCodeActionCollection(collection: CodeActionCollection): CodeActionCollection {
  return {
    availability: { ...collection.availability },
    actions: collection.actions.map((candidate) => cloneCodeActionCandidate(candidate)),
    summary: { ...collection.summary },
  };
}

export function cloneCodeActionCandidate(candidate: CodeActionCandidate): CodeActionCandidate {
  return {
    ...candidate,
    diagnosticFingerprints: [...candidate.diagnosticFingerprints],
    filePaths: [...candidate.filePaths],
    edits: candidate.edits.map((edit) => ({
      ...edit,
      changes: edit.changes.map((change) => ({ ...change })),
    })),
  };
}

export function selectPreferredCodeActionCandidate(
  collection: CodeActionCollection,
): CodeActionCandidate | null {
  return collection.actions.find((candidate) => candidate.allowlisted) ?? null;
}

export async function prepareCodeActionWriteInput(
  candidate: CodeActionCandidate,
): Promise<{
  path: string;
  content: string;
}> {
  if (!candidate.allowlisted) {
    throw new Error(`Code action "${candidate.title}" is not allowlisted for automatic apply.`);
  }
  const targetPath = candidate.filePaths[0] ?? candidate.edits[0]?.path ?? null;
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new Error("Code action candidate is missing a concrete target path.");
  }
  if (candidate.edits.length !== 1) {
    throw new Error("Automatic code-action apply requires a single edit group.");
  }
  const edit = candidate.edits[0];
  if (edit.isNewFile) {
    throw new Error("Automatic code-action apply does not support creating new files.");
  }
  if (edit.path !== targetPath) {
    throw new Error("Automatic code-action apply requires edit paths to match the candidate target path.");
  }

  const existing = await fs.readFile(targetPath, "utf8");
  const content = applyCodeActionChanges(existing, edit.changes);
  return {
    path: targetPath,
    content,
  };
}

export function toCodeActionApplyBlockedReason(error: unknown): CodeActionApplyBlockedReason {
  const message = toErrorMessage(error).toLowerCase();
  if (message.includes("not allowlisted")) {
    return "not_allowlisted";
  }
  if (message.includes("new files")) {
    return "new_file_edit";
  }
  if (message.includes("single edit group") || message.includes("match the candidate target path")) {
    return "multi_file_edit";
  }
  if (message.includes("target path")) {
    return "missing_edit_path";
  }
  if (message.includes("full text")) {
    return "edit_too_large";
  }
  return "execution_failed";
}

function normalizeCodeActionEdit(
  change: TsServerProtocolCodeFix["changes"][number],
): CodeActionEdit {
  return {
    path: change.path,
    isNewFile: change.isNewFile,
    changeCount: change.changeCount,
    changes: change.changes.slice(0, MAX_CODE_ACTION_CHANGES).map((entry) => normalizeCodeActionEditChange(entry)),
  };
}

function normalizeCodeActionEditChange(
  change: TsServerProtocolCodeFix["changes"][number]["changes"][number],
): CodeActionEditChange {
  const newText = change.newText.length <= MAX_CODE_ACTION_TEXT ? change.newText : null;
  return {
    startLine: change.startLine,
    startColumn: change.startColumn,
    endLine: change.endLine,
    endColumn: change.endColumn,
    newText,
    newTextPreview: summarizeText(change.newText, MAX_CODE_ACTION_TEXT),
    newTextLength: change.newText.length,
    textTruncated: newText == null,
  };
}

function summarizeCodeActionCollection(
  actions: CodeActionCandidate[],
  input: {
    available: boolean;
    source: "tsserver" | "unavailable";
    reason: string | null;
  },
): CodeActionCollection["summary"] {
  return {
    total: actions.length,
    allowlistedCount: actions.filter((candidate) => candidate.allowlisted).length,
    blockedCount: actions.filter((candidate) => !candidate.allowlisted).length,
    fileCount: uniqueStrings(actions.flatMap((candidate) => candidate.filePaths)).length,
    available: input.available,
    source: input.source,
    reason: input.reason,
  };
}

function evaluateAllowlist(
  candidate: Omit<CodeActionCandidate, "allowlisted" | "allowlistRule" | "blockedReason">,
): {
  allowlisted: boolean;
  allowlistRule: string | null;
  blockedReason: CodeActionBlockedReason | null;
} {
  if (candidate.source !== "tsserver") {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "unsupported_source",
    };
  }
  if (candidate.kind !== "quickfix" || candidate.fixId) {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "fix_all_not_allowed",
    };
  }
  if (!candidate.recommended) {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "not_recommended",
    };
  }
  if (candidate.edits.length !== 1 || candidate.filePaths.length !== 1) {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "multi_file_edit",
    };
  }
  const [edit] = candidate.edits;
  const targetPath = candidate.filePaths[0] ?? null;
  if (!targetPath || !edit || edit.path !== targetPath) {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "missing_edit_path",
    };
  }
  if (edit.isNewFile) {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "new_file_edit",
    };
  }
  if (edit.changes.length === 0 || edit.changes.length > MAX_CODE_ACTION_CHANGES) {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "too_many_changes",
    };
  }
  if (edit.changes.some((change) => change.textTruncated || change.newText == null)) {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "edit_too_large",
    };
  }
  const rule = ALLOWLIST_RULES.find((entry) => entry.matches(candidate));
  if (!rule) {
    return {
      allowlisted: false,
      allowlistRule: null,
      blockedReason: "not_allowlisted",
    };
  }
  return {
    allowlisted: true,
    allowlistRule: rule.id,
    blockedReason: null,
  };
}

function createCodeActionId(candidate: Omit<CodeActionCandidate, "id">): string {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify([
      candidate.source,
      candidate.title,
      candidate.kind,
      candidate.reason,
      candidate.recommended,
      candidate.fixName,
      candidate.fixId,
      candidate.allowlisted,
      candidate.allowlistRule,
      candidate.blockedReason,
      [...candidate.diagnosticFingerprints].sort(),
      [...candidate.filePaths].sort(),
      candidate.edits,
    ]))
    .digest("hex");
}

function compareCodeActionCandidates(left: CodeActionCandidate, right: CodeActionCandidate): number {
  if (left.allowlisted !== right.allowlisted) {
    return left.allowlisted ? -1 : 1;
  }
  if (left.recommended !== right.recommended) {
    return left.recommended ? -1 : 1;
  }
  const leftPath = left.filePaths[0] ?? "";
  const rightPath = right.filePaths[0] ?? "";
  return leftPath.localeCompare(rightPath) || left.title.localeCompare(right.title);
}

function applyCodeActionChanges(
  text: string,
  changes: CodeActionEditChange[],
): string {
  const ordered = changes
    .map((change) => ({
      change,
      startOffset: getOffsetFromLineColumn(text, change.startLine, change.startColumn),
      endOffset: getOffsetFromLineColumn(text, change.endLine, change.endColumn),
    }))
    .sort((left, right) => right.startOffset - left.startOffset || right.endOffset - left.endOffset);

  let current = text;
  for (const entry of ordered) {
    const replacement = entry.change.newText;
    if (replacement == null) {
      throw new Error("Automatic code-action apply requires full text for every change.");
    }
    if (entry.startOffset > entry.endOffset) {
      throw new Error("Code action change offsets were invalid.");
    }
    current = `${current.slice(0, entry.startOffset)}${replacement}${current.slice(entry.endOffset)}`;
  }
  return current;
}

function getOffsetFromLineColumn(
  text: string,
  line: number | null,
  column: number | null,
): number {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line == null || column == null || line < 1 || column < 1) {
    throw new Error("Code action change is missing a valid line/column position.");
  }

  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) {
      throw new Error(`Code action line ${line} is outside the current file.`);
    }
    offset = newline + 1;
    currentLine += 1;
  }

  const lineEnd = text.indexOf("\n", offset);
  const currentLineText = lineEnd < 0 ? text.slice(offset) : text.slice(offset, lineEnd);
  const lineOffset = column - 1;
  if (lineOffset > currentLineText.length) {
    throw new Error(`Code action column ${column} is outside line ${line}.`);
  }
  return offset + lineOffset;
}

function summarizeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((entry) => typeof entry === "string" && entry.length > 0))];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return `${error ?? "Unknown code-action error"}`;
}
