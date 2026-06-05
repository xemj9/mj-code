import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  previewReplaceInFileChangeSet,
  previewWriteFileChangeSet,
} from "../lib/change-set.mjs";
import { abbreviate, appendLimited, resolveUserPath } from "../lib/path-utils.mjs";

import type {
  ListDirResult,
  ReadFileResult,
  ReplaceInFileResult,
  SearchFilesResult,
  WriteFileResult,
} from "../types/contracts.js";

const ENTRY_LIMIT = 200;
const SEARCH_LIMIT = 200;

export interface FilesystemToolContext {
  cwd: string;
  maxReadChars: number;
  maxOutputChars: number;
}

export interface ListDirInput {
  path?: string | null;
}

export interface ReadFileInput {
  path: string;
  startLine?: number | string | null;
  endLine?: number | string | null;
}

export interface WriteFileInput {
  path: string;
  content?: string | null;
}

export interface ReplaceInFileInput {
  path: string;
  search?: string | null;
  replace?: string | null;
  all?: boolean | null;
}

export interface SearchFilesInput {
  query?: string | null;
  path?: string | null;
}

export async function listDir(
  input: ListDirInput | Record<string, unknown> | undefined,
  context: FilesystemToolContext,
): Promise<ListDirResult> {
  const targetPath = resolveUserPath(getOptionalString(input?.path) ?? ".", context.cwd);
  const entries = await fs.readdir(targetPath, { withFileTypes: true });

  const items = await Promise.all(
    entries.slice(0, ENTRY_LIMIT).map(async (entry) => {
      const fullPath = path.join(targetPath, entry.name);
      let size: number | null = null;

      try {
        const stats = await fs.stat(fullPath);
        size = stats.size;
      } catch {
        size = null;
      }

      return {
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
        size,
      } as const;
    }),
  );

  return {
    path: targetPath,
    entries: items,
    truncated: entries.length > ENTRY_LIMIT,
  };
}

export async function readFile(
  input: ReadFileInput | Record<string, unknown> | undefined,
  context: FilesystemToolContext,
): Promise<ReadFileResult> {
  const targetPath = resolveUserPath(getRequiredString(input?.path), context.cwd);
  const contents = await fs.readFile(targetPath, "utf8");

  if (contents.includes("\u0000")) {
    throw new Error(`File "${targetPath}" appears to be binary.`);
  }

  const lines = contents.split(/\r?\n/);
  const startLine = Math.max(1, Number(input?.startLine ?? 1));
  const defaultEnd = Math.min(lines.length, startLine + 249);
  const endLine = input?.endLine ? Math.max(startLine, Number(input.endLine)) : defaultEnd;

  return {
    path: targetPath,
    startLine,
    endLine,
    content: abbreviate(lines.slice(startLine - 1, endLine).join("\n"), context.maxReadChars),
  };
}

export async function writeFile(
  input: WriteFileInput | Record<string, unknown> | undefined,
  context: FilesystemToolContext,
): Promise<WriteFileResult> {
  const targetPath = resolveUserPath(getRequiredString(input?.path), context.cwd);
  const content = typeof input?.content === "string" ? input.content : "";

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");

  return {
    path: targetPath,
    bytesWritten: Buffer.byteLength(content, "utf8"),
  };
}

export async function previewWriteFile(
  input: Record<string, unknown> | undefined,
  context: FilesystemToolContext,
) {
  return previewWriteFileChangeSet(input ?? {}, context);
}

export async function replaceInFile(
  input: ReplaceInFileInput | Record<string, unknown> | undefined,
  context: FilesystemToolContext,
): Promise<ReplaceInFileResult> {
  const targetPath = resolveUserPath(getRequiredString(input?.path), context.cwd);
  const search = typeof input?.search === "string" ? input.search : "";
  const replace = typeof input?.replace === "string" ? input.replace : "";
  const replaceAll = Boolean(input?.all);

  if (!search) {
    throw new Error("replace_in_file requires a non-empty search string.");
  }

  const original = await fs.readFile(targetPath, "utf8");
  if (!original.includes(search)) {
    throw new Error(`Search string was not found in "${targetPath}".`);
  }

  const updated = replaceAll
    ? original.split(search).join(replace)
    : original.replace(search, replace);
  const replacements = replaceAll ? original.split(search).length - 1 : 1;
  await fs.writeFile(targetPath, updated, "utf8");

  return {
    path: targetPath,
    replacements,
  };
}

export async function previewReplaceInFile(
  input: Record<string, unknown> | undefined,
  context: FilesystemToolContext,
) {
  return previewReplaceInFileChangeSet(input ?? {}, context);
}

export async function searchFiles(
  input: SearchFilesInput | Record<string, unknown> | undefined,
  context: FilesystemToolContext,
): Promise<SearchFilesResult> {
  const query = typeof input?.query === "string" ? input.query : "";
  const targetPath = resolveUserPath(getOptionalString(input?.path) ?? ".", context.cwd);

  if (!query) {
    throw new Error("search_files requires a non-empty query.");
  }

  const rgResults = await searchWithRipgrep(query, targetPath);
  if (rgResults) {
    return rgResults;
  }

  return searchWithFallback(query, targetPath, context);
}

function searchWithRipgrep(
  query: string,
  targetPath: string,
): Promise<SearchFilesResult | null> {
  return new Promise((resolve, reject) => {
    const args = [
      "-n",
      "--hidden",
      "--glob",
      "!.git",
      "--glob",
      "!node_modules",
      "--max-count",
      String(SEARCH_LIMIT),
      query,
      targetPath,
    ];

    let stdout = "";
    let stderr = "";
    let unavailable = false;
    const child = spawn("rg", args);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendLimited(stdout, chunk.toString(), 40000);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendLimited(stderr, chunk.toString(), 8000);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        unavailable = true;
        resolve(null);
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      if (unavailable) {
        return;
      }

      if (code !== 0 && code !== 1) {
        reject(new Error(`ripgrep failed: ${stderr || `exit code ${code}`}`));
        return;
      }

      const matches = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(":");
          return {
            path: parts[0] ?? "",
            line: Number(parts[1] ?? 0),
            preview: parts.slice(2).join(":"),
          };
        });

      resolve({
        path: targetPath,
        query,
        engine: "ripgrep",
        matches,
      });
    });
  });
}

async function searchWithFallback(
  query: string,
  targetPath: string,
  context: FilesystemToolContext,
): Promise<SearchFilesResult> {
  const matches: SearchFilesResult["matches"] = [];
  const regex = buildRegex(query);

  await walk(targetPath, async (filePath) => {
    if (matches.length >= SEARCH_LIMIT) {
      return true;
    }

    const contents = await fs.readFile(filePath, "utf8").catch(() => null);
    if (!contents || contents.includes("\u0000")) {
      return false;
    }

    const lines = contents.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (regex.test(line)) {
        matches.push({
          path: filePath,
          line: index + 1,
          preview: abbreviate(line, context.maxOutputChars),
        });
      }

      if (matches.length >= SEARCH_LIMIT) {
        return true;
      }
    }

    return false;
  });

  return {
    path: targetPath,
    query,
    engine: "fallback",
    matches,
  };
}

async function walk(
  startPath: string,
  onFile: (filePath: string) => Promise<boolean | void>,
): Promise<void> {
  const stats = await fs.stat(startPath);
  if (stats.isFile()) {
    await onFile(startPath);
    return;
  }

  const entries = await fs.readdir(startPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const childPath = path.join(startPath, entry.name);
    if (entry.isDirectory()) {
      await walk(childPath, onFile);
      continue;
    }

    if (entry.isFile()) {
      const stop = await onFile(childPath);
      if (stop) {
        return;
      }
    }
  }
}

function buildRegex(query: string): RegExp {
  try {
    return new RegExp(query, "i");
  } catch {
    return new RegExp(escapeForRegex(query), "i");
  }
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getRequiredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
