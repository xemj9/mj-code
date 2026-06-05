import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { previewPatchText } from "./apply-patch.mjs";
import { abbreviate, resolveUserPath } from "./path-utils.mjs";

import type {
  ChangeImpactSummary,
  ChangeSetDiffSelection,
  ChangeSetDiffStats,
  ChangeSetFileEntry,
  ChangeSetFileState,
  ChangeSetRecord,
  ChangeSetSummary,
  PatchFileChangeOperation,
} from "../types/contracts.js";

const MAX_COMBINED_DIFF_CHARS = 16000;
const MAX_FILE_DIFF_CHARS = 6000;
const MAX_IMPACT_FILES = 12;
const MAX_SCAN_FILES = 1200;
const EXACT_DIFF_LINE_LIMIT = 400;
const EXACT_DIFF_COMPLEXITY = 160000;
const MAX_IMPACT_TOKENS = 8;
const impactIndexCache = new Map<string, ImpactIndexCacheEntry>();
const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: {
    cwd: string;
    timeout?: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

interface ChangeSetPreviewContext {
  cwd: string;
  impactDeadlineMs?: number;
  impactCacheTtlMs?: number;
}

interface FileChangeInput {
  operation?: PatchFileChangeOperation;
  path: string;
  previousPath?: string | null;
  beforeContent?: unknown;
  afterContent?: unknown;
  touchedFiles?: string[];
}

interface ImpactOptions {
  deadlineMs?: number;
  cacheTtlMs?: number;
}

interface CreateChangeSetInput {
  toolName: string;
  cwd: string;
  fileChanges: FileChangeInput[];
  input: unknown;
  impactOptions?: ImpactOptions;
}

interface FileDiffArtifact {
  text: string;
  truncated: boolean;
  stats: ChangeSetDiffStats;
}

interface IndexedImpactData {
  engine: string;
  files: string[];
  tokenMap: Map<string, Set<string>>;
}

interface ImpactIndexCacheEntry extends IndexedImpactData {
  createdAt: number;
}

interface ContentSearchResult {
  engine: string;
  matches: string[];
  scannedFiles: number;
  deadlineHit: boolean;
}

interface ExecFileErrorLike {
  code?: string | number;
  killed?: boolean;
}

function getRequiredInputPath(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function previewWriteFileChangeSet(
  input: Record<string, unknown>,
  context: ChangeSetPreviewContext,
): Promise<ChangeSetRecord> {
  const targetPath = resolveUserPath(getRequiredInputPath(input.path), context.cwd);
  const beforeContent = await readOptionalText(targetPath);
  const afterContent = typeof input.content === "string" ? input.content : "";

  return createChangeSet({
    toolName: "write_file",
    cwd: context.cwd,
    fileChanges: [
      {
        operation: beforeContent == null ? "add" : "update",
        path: targetPath,
        previousPath: null,
        beforeContent,
        afterContent,
        touchedFiles: [targetPath],
      },
    ],
    input,
    impactOptions: {
      deadlineMs: context.impactDeadlineMs,
      cacheTtlMs: context.impactCacheTtlMs,
    },
  });
}

export async function previewReplaceInFileChangeSet(
  input: Record<string, unknown>,
  context: ChangeSetPreviewContext,
): Promise<ChangeSetRecord> {
  const targetPath = resolveUserPath(getRequiredInputPath(input.path), context.cwd);
  const beforeContent = await fs.readFile(targetPath, "utf8");
  const search = typeof input.search === "string" ? input.search : "";
  const replace = typeof input.replace === "string" ? input.replace : "";
  const replaceAll = Boolean(input.all);

  if (!search) {
    throw new Error("replace_in_file requires a non-empty search string.");
  }

  if (!beforeContent.includes(search)) {
    throw new Error(`Search string was not found in "${targetPath}".`);
  }

  const afterContent = replaceAll
    ? beforeContent.split(search).join(replace)
    : beforeContent.replace(search, replace);
  const replacements = replaceAll ? beforeContent.split(search).length - 1 : 1;

  return createChangeSet({
    toolName: "replace_in_file",
    cwd: context.cwd,
    fileChanges: [
      {
        operation: "update",
        path: targetPath,
        previousPath: null,
        beforeContent,
        afterContent,
        touchedFiles: [targetPath],
      },
    ],
    input: {
      ...input,
      replacements,
    },
    impactOptions: {
      deadlineMs: context.impactDeadlineMs,
      cacheTtlMs: context.impactCacheTtlMs,
    },
  });
}

export async function previewApplyPatchChangeSet(
  input: Record<string, unknown>,
  context: ChangeSetPreviewContext,
): Promise<ChangeSetRecord> {
  const patch = typeof input.patch === "string" ? input.patch : "";
  if (!patch) {
    throw new Error("apply_patch requires a patch string.");
  }

  const preview = await previewPatchText(patch, context.cwd);
  return createChangeSet({
    toolName: "apply_patch",
    cwd: context.cwd,
    fileChanges: preview.fileChanges,
    input,
    impactOptions: {
      deadlineMs: context.impactDeadlineMs,
      cacheTtlMs: context.impactCacheTtlMs,
    },
  });
}

export async function createChangeSet({
  toolName,
  cwd,
  fileChanges,
  input,
  impactOptions = {},
}: CreateChangeSetInput): Promise<ChangeSetRecord> {
  const normalizedFiles = (fileChanges ?? []).map((fileChange): ChangeSetFileEntry & {
    beforeContent: string | null;
    afterContent: string | null;
  } => {
    const operation = fileChange.operation ?? inferOperation(fileChange);
    const targetPath = fileChange.path;
    const previousPath = fileChange.previousPath ?? null;
    const beforeContent = normalizeTextContent(fileChange.beforeContent);
    const afterContent = normalizeTextContent(fileChange.afterContent);
    const diff = buildFileDiffArtifact({
      beforeContent,
      afterContent,
      beforeLabel: previousPath ?? targetPath,
      afterLabel: targetPath,
      operation,
      maxChars: MAX_FILE_DIFF_CHARS,
    });

    return {
      operation,
      path: targetPath,
      previousPath,
      touchedFiles: fileChange.touchedFiles ?? uniquePaths([previousPath, targetPath]),
      beforeExists: beforeContent != null,
      afterExists: afterContent != null,
      beforeBytes: beforeContent == null ? 0 : Buffer.byteLength(beforeContent, "utf8"),
      afterBytes: afterContent == null ? 0 : Buffer.byteLength(afterContent, "utf8"),
      stats: diff.stats,
      diff: diff.text,
      diffTruncated: diff.truncated,
      summary: summarizeFileChange({
        operation,
        path: targetPath,
        previousPath,
        stats: diff.stats,
      }),
      beforeContent,
      afterContent,
    };
  });

  const touchedFiles = uniquePaths(normalizedFiles.flatMap((entry) => entry.touchedFiles));
  const combinedDiff = combineDiffs(normalizedFiles.map((entry) => entry.diff));
  const impact = await analyzeChangeImpact({
    cwd,
    touchedFiles,
    deadlineMs: impactOptions.deadlineMs,
    cacheTtlMs: impactOptions.cacheTtlMs,
  });

  return {
    id: crypto.randomUUID().slice(0, 12),
    createdAt: new Date().toISOString(),
    toolName,
    dryRun: true,
    input: sanitizeInputPreview(input),
    touchedFiles,
    operations: countOperations(normalizedFiles),
    files: normalizedFiles.map((entry) => ({
      operation: entry.operation,
      path: entry.path,
      previousPath: entry.previousPath,
      touchedFiles: entry.touchedFiles,
      beforeExists: entry.beforeExists,
      afterExists: entry.afterExists,
      beforeBytes: entry.beforeBytes,
      afterBytes: entry.afterBytes,
      stats: entry.stats,
      diff: entry.diff,
      diffTruncated: entry.diffTruncated,
      summary: entry.summary,
    })),
    diff: combinedDiff.text,
    diffTruncated: combinedDiff.truncated,
    impact,
    rollbackAvailable: false,
    checkpointId: null,
    risk: null,
    _internal: {
      cwd,
      fileStates: normalizedFiles.map((entry) => ({
        operation: entry.operation,
        path: entry.path,
        previousPath: entry.previousPath ?? null,
        beforeContent: entry.beforeContent,
        afterContent: entry.afterContent,
        touchedFiles: entry.touchedFiles,
      })),
    },
  };
}

export function withChangeSetMeta<TChangeSet extends ChangeSetRecord>(
  changeSet: TChangeSet,
  extra: Record<string, unknown> = {},
): TChangeSet & Record<string, unknown> {
  return {
    ...changeSet,
    ...extra,
  };
}

export function summarizeChangeSet(changeSet: ChangeSetRecord | null | undefined): ChangeSetSummary | null {
  if (!changeSet) {
    return null;
  }

  return {
    id: changeSet.id,
    createdAt: changeSet.createdAt,
    toolName: changeSet.toolName,
    touchedFiles: changeSet.touchedFiles,
    operations: changeSet.operations,
    diffTruncated: changeSet.diffTruncated,
    rollbackAvailable: changeSet.rollbackAvailable,
    checkpointId: changeSet.checkpointId,
    risk: changeSet.risk,
    impact: changeSet.impact,
    files: changeSet.files.map((entry) => ({
      operation: entry.operation,
      path: entry.path,
      previousPath: entry.previousPath,
      stats: entry.stats,
      summary: entry.summary,
      diffTruncated: entry.diffTruncated,
    })),
    diff: changeSet.diff,
  };
}

export function buildFileDiffArtifact({
  beforeContent,
  afterContent,
  beforeLabel,
  afterLabel,
  operation,
  maxChars = MAX_FILE_DIFF_CHARS,
}: {
  beforeContent: string | null;
  afterContent: string | null;
  beforeLabel: string;
  afterLabel: string;
  operation: string;
  maxChars?: number;
}): FileDiffArtifact {
  return createUnifiedDiff({
    beforeContent,
    afterContent,
    beforeLabel,
    afterLabel,
    operation,
    maxChars,
  });
}

export function selectChangeSetDiff(
  changeSet: ChangeSetRecord | null | undefined,
  filePath: string | null = null,
): ChangeSetDiffSelection | null {
  if (!changeSet) {
    return null;
  }

  if (!filePath) {
    return {
      id: changeSet.id,
      toolName: changeSet.toolName,
      diff: changeSet.diff,
      files: changeSet.files,
      risk: changeSet.risk,
      impact: changeSet.impact,
      rollbackAvailable: changeSet.rollbackAvailable,
      checkpointId: changeSet.checkpointId,
    };
  }

  const normalizedTarget = path.normalize(filePath);
  const fileEntry = changeSet.files.find((entry) => {
    const targetPath = path.normalize(entry.path);
    const previousPath = entry.previousPath ? path.normalize(entry.previousPath) : null;
    return targetPath === normalizedTarget || previousPath === normalizedTarget;
  });

  if (!fileEntry) {
    return null;
  }

  return {
    id: changeSet.id,
    toolName: changeSet.toolName,
    file: fileEntry,
    risk: changeSet.risk,
    impact: changeSet.impact,
    rollbackAvailable: changeSet.rollbackAvailable,
    checkpointId: changeSet.checkpointId,
  };
}

function inferOperation(fileChange: FileChangeInput): string {
  if (fileChange.previousPath && fileChange.path && fileChange.previousPath !== fileChange.path) {
    return "rename";
  }

  if (fileChange.beforeContent == null && fileChange.afterContent != null) {
    return "add";
  }

  if (fileChange.beforeContent != null && fileChange.afterContent == null) {
    return "delete";
  }

  return "update";
}

function summarizeFileChange({
  operation,
  path: targetPath,
  previousPath,
  stats,
}: {
  operation: string;
  path: string;
  previousPath: string | null;
  stats: ChangeSetDiffStats;
}): string {
  const location =
    operation === "rename" && previousPath
      ? `${previousPath} -> ${targetPath}`
      : targetPath;

  return `${operation} ${location} (+${stats.added}/-${stats.removed})`;
}

function normalizeTextContent(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  return typeof value === "string" ? value : `${value}`;
}

function combineDiffs(diffTexts: string[]): { text: string; truncated: boolean } {
  const combined = diffTexts.filter(Boolean).join("\n");
  if (combined.length <= MAX_COMBINED_DIFF_CHARS) {
    return { text: combined, truncated: false };
  }

  return {
    text: `${combined.slice(0, MAX_COMBINED_DIFF_CHARS)}\n...<diff truncated ${combined.length - MAX_COMBINED_DIFF_CHARS} chars>`,
    truncated: true,
  };
}

function countOperations(files: Array<{ operation: string }>): Record<string, number> {
  const operations: Record<string, number> = {
    add: 0,
    update: 0,
    delete: 0,
    rename: 0,
  };

  for (const entry of files) {
    operations[entry.operation] = (operations[entry.operation] ?? 0) + 1;
  }

  return operations;
}

export async function analyzeChangeImpact({
  cwd,
  touchedFiles,
  deadlineMs = 250,
  cacheTtlMs = 30000,
}: {
  cwd: string;
  touchedFiles: string[];
  deadlineMs?: number;
  cacheTtlMs?: number;
}): Promise<ChangeImpactSummary> {
  const startedAt = Date.now();
  const touchedRelative = touchedFiles.map((filePath) => path.relative(cwd, filePath));
  const candidateTokens = buildImpactTokens(touchedRelative);

  const likelyTests = new Set<string>();
  const relatedFiles = new Set<string>();
  let scannedFiles = 0;
  let deadlineHit = false;

  const index = await getImpactIndex(cwd, cacheTtlMs);
  for (const token of candidateTokens) {
    if (Date.now() - startedAt >= deadlineMs) {
      deadlineHit = true;
      break;
    }

    const matches = index.tokenMap.get(token);
    if (!matches) {
      continue;
    }

    for (const relativePath of matches) {
      scannedFiles += 1;
      if (scannedFiles >= MAX_SCAN_FILES) {
        deadlineHit = deadlineHit || Date.now() - startedAt >= deadlineMs;
        break;
      }
      if (touchedRelative.includes(relativePath)) {
        continue;
      }
      relatedFiles.add(relativePath);
      if (isLikelyTestFile(relativePath)) {
        likelyTests.add(relativePath);
      }
      if (relatedFiles.size >= MAX_IMPACT_FILES) {
        break;
      }
    }

    if (relatedFiles.size >= MAX_IMPACT_FILES || scannedFiles >= MAX_SCAN_FILES) {
      break;
    }
  }

  let engine = index.engine;
  if (relatedFiles.size < MAX_IMPACT_FILES && !deadlineHit && candidateTokens.length > 0) {
    const contentSearch = await searchImpactContentWithRg(cwd, candidateTokens, deadlineMs - (Date.now() - startedAt));
    engine = contentSearch.engine ?? engine;
    scannedFiles += contentSearch.scannedFiles;
    deadlineHit = deadlineHit || contentSearch.deadlineHit;
    for (const relativePath of contentSearch.matches) {
      if (touchedRelative.includes(relativePath)) {
        continue;
      }
      relatedFiles.add(relativePath);
      if (isLikelyTestFile(relativePath)) {
        likelyTests.add(relativePath);
      }
      if (relatedFiles.size >= MAX_IMPACT_FILES) {
        break;
      }
    }
  }

  const needsTests = likelyTests.size > 0 || touchedRelative.some((relativePath) => !isLikelyTestFile(relativePath));

  return {
    touchedFiles: touchedRelative,
    relatedFiles: Array.from(relatedFiles).slice(0, MAX_IMPACT_FILES),
    likelyTests: Array.from(likelyTests).slice(0, MAX_IMPACT_FILES),
    needsTestRerun: needsTests,
    engine,
    scannedFiles,
    scanTruncated: scannedFiles >= MAX_SCAN_FILES,
    cacheHit: index.cacheHit,
    deadlineHit,
    quality: relatedFiles.size > 0 ? "heuristic" : "low_confidence",
    cost: {
      engine,
      scannedFiles,
      scanTruncated: scannedFiles >= MAX_SCAN_FILES,
      cacheHit: index.cacheHit,
      deadlineHit,
    },
  };
}

function isLikelyTestFile(relativePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(relativePath) || /\.(test|spec)\.[^.]+$/i.test(relativePath);
}

async function walkWorkspace(
  startPath: string,
  onFile: (filePath: string) => Promise<boolean> | boolean,
): Promise<boolean> {
  const entries = await fs.readdir(startPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".mj-code") {
      continue;
    }

    const fullPath = path.join(startPath, entry.name);
    if (entry.isDirectory()) {
      const stop = await walkWorkspace(fullPath, onFile);
      if (stop) {
        return true;
      }
      continue;
    }

    if (entry.isFile()) {
      const stop = await onFile(fullPath);
      if (stop) {
        return true;
      }
    }
  }

  return false;
}

async function getImpactIndex(cwd: string, cacheTtlMs: number): Promise<IndexedImpactData & { cacheHit: boolean }> {
  const cached = impactIndexCache.get(cwd);
  if (cached && Date.now() - cached.createdAt <= cacheTtlMs) {
    return {
      ...cached,
      cacheHit: true,
    };
  }

  const built = await buildImpactIndex(cwd);
  const entry = {
    ...built,
    createdAt: Date.now(),
  };
  impactIndexCache.set(cwd, entry);
  return {
    ...entry,
    cacheHit: false,
  };
}

async function buildImpactIndex(cwd: string): Promise<IndexedImpactData> {
  try {
    const { stdout } = await execFileAsync("rg", [
      "--files",
      "--hidden",
      "-g",
      "!node_modules",
      "-g",
      "!.git",
      "-g",
      "!.mj-code",
    ], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    const files = stdout.split("\n").filter(Boolean);
    return {
      engine: "rg",
      files,
      tokenMap: buildTokenMap(files),
    };
  } catch {
    const files: string[] = [];
    await walkWorkspace(cwd, async (filePath) => {
      files.push(path.relative(cwd, filePath));
      return false;
    });
    return {
      engine: "fallback",
      files,
      tokenMap: buildTokenMap(files),
    };
  }
}

function buildTokenMap(relativePaths: string[]): Map<string, Set<string>> {
  const tokenMap = new Map<string, Set<string>>();
  for (const relativePath of relativePaths) {
    const tokens = buildImpactTokens([relativePath]);
    for (const token of tokens) {
      const paths = tokenMap.get(token) ?? new Set();
      paths.add(relativePath);
      tokenMap.set(token, paths);
    }
  }
  return tokenMap;
}

function buildImpactTokens(relativePaths: string[]): string[] {
  const tokens = new Set<string>();
  for (const relativePath of relativePaths) {
    const normalized = relativePath.replace(/\\/g, "/");
    const parsed = path.parse(normalized);
    for (const token of [
      parsed.base,
      parsed.name,
      ...normalized.split("/"),
      ...normalized.split(/[\/._-]+/),
    ]) {
      const cleaned = `${token ?? ""}`.trim().toLowerCase();
      if (cleaned.length < 2 || cleaned === "src" || cleaned === "test" || cleaned === "tests") {
        continue;
      }
      tokens.add(cleaned);
    }
  }
  return Array.from(tokens).slice(0, MAX_IMPACT_TOKENS);
}

async function searchImpactContentWithRg(
  cwd: string,
  tokens: string[],
  timeoutMs: number,
): Promise<ContentSearchResult> {
  if (tokens.length === 0 || timeoutMs <= 0) {
    return {
      engine: "rg",
      matches: [],
      scannedFiles: 0,
      deadlineHit: timeoutMs <= 0,
    };
  }

  const args = [
    "-l",
    "-F",
    "--hidden",
    "-g",
    "!node_modules",
    "-g",
    "!.git",
    "-g",
    "!.mj-code",
  ];
  for (const token of tokens) {
    args.push("-e", token);
  }
  args.push(".");

  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd,
      timeout: Math.max(50, timeoutMs),
      maxBuffer: 8 * 1024 * 1024,
    });
    const matches = stdout.split("\n").filter(Boolean).slice(0, MAX_IMPACT_FILES * 2);
    return {
      engine: "rg",
      matches,
      scannedFiles: matches.length,
      deadlineHit: false,
    };
  } catch (error) {
    const typedError = error as ExecFileErrorLike;
    if (typedError.code === 1) {
      return {
        engine: "rg",
        matches: [],
        scannedFiles: 0,
        deadlineHit: false,
      };
    }
    return {
      engine: "fallback",
      matches: [],
      scannedFiles: 0,
      deadlineHit: Boolean(typedError.killed),
    };
  }
}

function createUnifiedDiff({
  beforeContent,
  afterContent,
  beforeLabel,
  afterLabel,
  operation,
  maxChars,
}: {
  beforeContent: string | null;
  afterContent: string | null;
  beforeLabel: string;
  afterLabel: string;
  operation: string;
  maxChars: number;
}): FileDiffArtifact {
  if (operation === "add") {
    const text = formatDiffBlock({
      beforeLabel: "/dev/null",
      afterLabel,
      beforeLines: [],
      afterLines: splitLines(afterContent ?? ""),
      maxChars,
    });
    return {
      text,
      truncated: text.includes("...<diff truncated"),
      stats: countLineStats([], splitLines(afterContent ?? "")),
    };
  }

  if (operation === "delete") {
    const text = formatDiffBlock({
      beforeLabel,
      afterLabel: "/dev/null",
      beforeLines: splitLines(beforeContent ?? ""),
      afterLines: [],
      maxChars,
    });
    return {
      text,
      truncated: text.includes("...<diff truncated"),
      stats: countLineStats(splitLines(beforeContent ?? ""), []),
    };
  }

  const beforeLines = splitLines(beforeContent ?? "");
  const afterLines = splitLines(afterContent ?? "");
  const stats = countLineStats(beforeLines, afterLines);
  const editLengthProduct = beforeLines.length * afterLines.length;

  if (
    beforeLines.length <= EXACT_DIFF_LINE_LIMIT &&
    afterLines.length <= EXACT_DIFF_LINE_LIMIT &&
    editLengthProduct <= EXACT_DIFF_COMPLEXITY
  ) {
    const text = formatExactUnifiedDiff({
      beforeLabel,
      afterLabel,
      beforeLines,
      afterLines,
      maxChars,
    });

    return {
      text,
      truncated: text.includes("...<diff truncated"),
      stats,
    };
  }

  const text = formatDiffBlock({
    beforeLabel,
    afterLabel,
    beforeLines,
    afterLines,
    maxChars,
  });

  return {
    text,
    truncated: text.includes("...<diff truncated"),
    stats,
  };
}

function formatExactUnifiedDiff({
  beforeLabel,
  afterLabel,
  beforeLines,
  afterLines,
  maxChars,
}: {
  beforeLabel: string;
  afterLabel: string;
  beforeLines: string[];
  afterLines: string[];
  maxChars: number;
}): string {
  const diffOps = computeDiffOps(beforeLines, afterLines);
  const body = diffOps.map((entry) => `${entry.type}${entry.line}`).join("\n");
  const text = [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    body,
  ].join("\n");

  return limitDiff(text, maxChars);
}

function formatDiffBlock({
  beforeLabel,
  afterLabel,
  beforeLines,
  afterLines,
  maxChars,
}: {
  beforeLabel: string;
  afterLabel: string;
  beforeLines: string[];
  afterLines: string[];
  maxChars: number;
}): string {
  const body = [
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");

  const text = [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    body,
  ].join("\n");

  return limitDiff(text, maxChars);
}

function computeDiffOps(beforeLines: string[], afterLines: string[]): Array<{ type: string; line: string }> {
  const matrix = Array.from({ length: beforeLines.length + 1 }, () =>
    Array(afterLines.length + 1).fill(0),
  );

  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      matrix[left][right] =
        beforeLines[left] === afterLines[right]
          ? matrix[left + 1][right + 1] + 1
          : Math.max(matrix[left + 1][right], matrix[left][right + 1]);
    }
  }

  const diff = [];
  let left = 0;
  let right = 0;

  while (left < beforeLines.length && right < afterLines.length) {
    if (beforeLines[left] === afterLines[right]) {
      diff.push({ type: " ", line: beforeLines[left] });
      left += 1;
      right += 1;
      continue;
    }

    if (matrix[left + 1][right] >= matrix[left][right + 1]) {
      diff.push({ type: "-", line: beforeLines[left] });
      left += 1;
      continue;
    }

    diff.push({ type: "+", line: afterLines[right] });
    right += 1;
  }

  while (left < beforeLines.length) {
    diff.push({ type: "-", line: beforeLines[left] });
    left += 1;
  }

  while (right < afterLines.length) {
    diff.push({ type: "+", line: afterLines[right] });
    right += 1;
  }

  return diff;
}

function countLineStats(beforeLines: string[], afterLines: string[]): ChangeSetDiffStats {
  if (beforeLines.length * afterLines.length > EXACT_DIFF_COMPLEXITY) {
    return {
      added: Math.max(0, afterLines.length - beforeLines.length),
      removed: Math.max(0, beforeLines.length - afterLines.length),
    };
  }

  const ops = computeDiffOps(beforeLines, afterLines);
  let added = 0;
  let removed = 0;

  for (const entry of ops) {
    if (entry.type === "+") {
      added += 1;
    } else if (entry.type === "-") {
      removed += 1;
    }
  }

  return {
    added,
    removed,
  };
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }

  return text.replace(/\r\n/g, "\n").split("\n");
}

function limitDiff(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...<diff truncated ${text.length - maxChars} chars>`;
}

function sanitizeInputPreview(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input ?? null;
  }

  const preview: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      preview[key] = abbreviate(value, 200);
      continue;
    }

    preview[key] = value;
  }

  return preview;
}

function uniquePaths(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    if (contents.includes("\u0000")) {
      throw new Error(`File "${filePath}" appears to be binary.`);
    }
    return contents;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error;
}
