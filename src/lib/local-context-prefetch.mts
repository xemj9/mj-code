import fs from "node:fs/promises";
import path from "node:path";

import { abbreviate } from "./path-utils.mjs";

interface PrefetchInput {
  prompt: string;
  cwd: string;
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
}

export interface LocalContextPrefetchAttachment {
  path: string;
  relativePath: string;
  bytes: number;
  lineCount: number;
  content: string;
  truncated: boolean;
}

export interface LocalContextPrefetchResult {
  attachments: LocalContextPrefetchAttachment[];
  skipped: string[];
  message: string | null;
}

const DEFAULT_MAX_FILES = 4;
const DEFAULT_MAX_CHARS_PER_FILE = 6000;
const DEFAULT_MAX_TOTAL_CHARS = 16000;

const PATH_PATTERN = /(?<![\w:/.-])((?:\.{1,2}\/|\/)?[\w@+./-]+?\.(?:md|mdx|txt|json|jsonl|js|jsx|ts|tsx|mts|mjs|py|rs|go|java|c|cc|cpp|h|hpp|css|scss|html|yaml|yml|toml|lock|sql|sh|zsh|fish|rs|vue|svelte))(?:[:#]\d+)?/gi;

const WELL_KNOWN_FILES = [
  "README.md",
  "MJ.md",
  "AGENTS.md",
  "package.json",
  "tsconfig.json",
  "Cargo.toml",
  "pyproject.toml",
];

export async function prefetchLocalContextForPrompt({
  prompt,
  cwd,
  maxFiles = DEFAULT_MAX_FILES,
  maxCharsPerFile = DEFAULT_MAX_CHARS_PER_FILE,
  maxTotalChars = DEFAULT_MAX_TOTAL_CHARS,
}: PrefetchInput): Promise<LocalContextPrefetchResult> {
  const candidates = extractLocalPathCandidates(prompt);
  const attachments: LocalContextPrefetchAttachment[] = [];
  const skipped: string[] = [];
  let remainingChars = maxTotalChars;

  for (const candidate of candidates) {
    if (attachments.length >= maxFiles || remainingChars <= 0) {
      break;
    }
    const resolved = resolveWorkspaceFile(candidate, cwd);
    if (!resolved) {
      skipped.push(candidate);
      continue;
    }

    try {
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) {
        skipped.push(candidate);
        continue;
      }
      if (stats.size > 512 * 1024) {
        skipped.push(`${candidate} (too large)`);
        continue;
      }
      const raw = await fs.readFile(resolved, "utf8");
      if (raw.includes("\u0000")) {
        skipped.push(`${candidate} (binary)`);
        continue;
      }
      const budget = Math.min(maxCharsPerFile, remainingChars);
      const content = abbreviate(raw, budget);
      const lineCount = raw.split(/\r?\n/).length;
      const relativePath = path.relative(cwd, resolved) || path.basename(resolved);
      attachments.push({
        path: resolved,
        relativePath,
        bytes: stats.size,
        lineCount,
        content,
        truncated: content.length < raw.length,
      });
      remainingChars -= content.length;
    } catch {
      skipped.push(candidate);
    }
  }

  return {
    attachments,
    skipped,
    message: attachments.length > 0 ? renderLocalContextMessage(attachments) : null,
  };
}

export function extractLocalPathCandidates(prompt: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value: string) => {
    const normalized = value.trim().replace(/[),.;，。；）]+$/g, "");
    if (!normalized || seen.has(normalized) || /^https?:\/\//i.test(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  for (const known of WELL_KNOWN_FILES) {
    if (new RegExp(`(^|\\s|["'“‘(（])${escapeRegExp(known)}($|\\s|["'”’),，。])`, "i").test(prompt)) {
      push(known);
    }
  }
  for (const match of prompt.matchAll(PATH_PATTERN)) {
    push(match[1] ?? "");
  }
  return candidates;
}

function resolveWorkspaceFile(candidate: string, cwd: string): string | null {
  const cleaned = candidate.replace(/^file:\/\//, "");
  if (cleaned.includes("..")) {
    return null;
  }
  if (cleaned.includes("/node_modules/") || cleaned.includes("/.git/")) {
    return null;
  }
  const resolved = path.isAbsolute(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(cwd, cleaned);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function renderLocalContextMessage(attachments: LocalContextPrefetchAttachment[]): string {
  return [
    "Local context prefetch:",
    "The user mentioned local file paths. These snippets were read before the model call so you can answer about the repository without pretending to inspect files. Use read_file or search_files if more context is needed.",
    ...attachments.map((entry) => [
      `--- ${entry.relativePath} (${entry.lineCount} lines, ${entry.bytes} bytes${entry.truncated ? ", truncated" : ""}) ---`,
      entry.content,
    ].join("\n")),
  ].join("\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
