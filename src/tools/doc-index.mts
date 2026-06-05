#!/usr/bin/env node

/**
 * Document Index Tool — scan, list, and read documentation directories.
 *
 * This tool lets the agent discover and read markdown documents from
 * configurable document directories (e.g. `.qoder/`). It provides:
 *   - `list_docs`: List all .md files in a directory with metadata
 *   - `read_doc`: Read a specific document with line range support
 *   - `search_docs`: Search for text across documents
 *
 * This solves the problem where the agent cannot "see" documentation
 * directories that aren't part of the source tree.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface DocIndexToolContext {
  cwd: string;
  maxReadChars: number;
  docDirs?: string[];
}

const DEFAULT_DOC_DIRS = [".qoder", "docs"];

interface DocEntry {
  name: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  lineCount: number;
  modifiedAt: string;
  summary: string;
}

// ─── list_docs ────────────────────────────────────────────────

export interface ListDocsInput {
  dir?: string | null;
  query?: string | null;
  limit?: number | string | null;
}

export async function listDocs(
  input: ListDocsInput,
  context: DocIndexToolContext,
): Promise<{
  entries: DocEntry[];
  totalFiles: number;
  dir: string;
  truncated: boolean;
}> {
  const docDirs = context.docDirs ?? DEFAULT_DOC_DIRS;
  const targetDir = input.dir ?? docDirs[0] ?? ".qoder";
  const resolvedDir = path.resolve(context.cwd, targetDir);
  const limit = Math.min(
    typeof input.limit === "number" ? input.limit : 50,
    200,
  );
  const query = input.query?.trim().toLowerCase() ?? null;

  let entries: DocEntry[];
  try {
    entries = await scanDirectory(resolvedDir, context.cwd, query);
  } catch {
    return {
      entries: [],
      totalFiles: 0,
      dir: targetDir,
      truncated: false,
    };
  }

  const truncated = entries.length > limit;
  const visible = entries.slice(0, limit);

  return {
    entries: visible,
    totalFiles: entries.length,
    dir: targetDir,
    truncated,
  };
}

// ─── read_doc ─────────────────────────────────────────────────

export interface ReadDocInput {
  path: string;
  startLine?: number | string | null;
  endLine?: number | string | null;
}

export async function readDoc(
  input: ReadDocInput,
  context: DocIndexToolContext,
): Promise<{
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}> {
  const docDirs = context.docDirs ?? DEFAULT_DOC_DIRS;
  let resolvedPath: string;

  // If the path is absolute or relative to cwd, resolve it directly
  if (path.isAbsolute(input.path)) {
    resolvedPath = input.path;
  } else {
    // Try to find the file in doc dirs first
    resolvedPath = path.resolve(context.cwd, input.path);
    let found = false;
    try {
      await fs.access(resolvedPath);
      found = true;
    } catch {
      // Not found at direct path, try doc dirs
    }

    if (!found) {
      for (const docDir of docDirs) {
        const candidate = path.resolve(context.cwd, docDir, input.path);
        try {
          await fs.access(candidate);
          resolvedPath = candidate;
          found = true;
          break;
        } catch {
          // continue
        }
      }
    }
  }

  const content = await fs.readFile(resolvedPath, "utf-8");
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  const startLine = typeof input.startLine === "number"
    ? Math.max(1, input.startLine)
    : 1;
  const endLine = typeof input.endLine === "number"
    ? Math.min(totalLines, input.endLine)
    : totalLines;

  const sliced = lines.slice(startLine - 1, endLine).join("\n");
  const maxChars = context.maxReadChars ?? 100_000;
  const truncated = sliced.length > maxChars;
  const finalContent = truncated
    ? sliced.slice(0, maxChars) + "\n... (truncated)"
    : sliced;

  return {
    path: input.path,
    content: finalContent,
    startLine,
    endLine,
    totalLines,
    truncated,
  };
}

// ─── search_docs ──────────────────────────────────────────────

export interface SearchDocsInput {
  query: string;
  dir?: string | null;
  maxResults?: number | string | null;
}

export interface DocSearchMatch {
  path: string;
  relativePath: string;
  line: number;
  preview: string;
}

export async function searchDocs(
  input: SearchDocsInput,
  context: DocIndexToolContext,
): Promise<{
  matches: DocSearchMatch[];
  totalMatches: number;
  query: string;
  dir: string;
  truncated: boolean;
}> {
  const docDirs = context.docDirs ?? DEFAULT_DOC_DIRS;
  const targetDir = input.dir ?? docDirs[0] ?? ".qoder";
  const resolvedDir = path.resolve(context.cwd, targetDir);
  const maxResults = Math.min(
    typeof input.maxResults === "number" ? input.maxResults : 30,
    100,
  );
  const queryLower = input.query.toLowerCase();

  const matches: DocSearchMatch[] = [];
  try {
    const files = await collectMarkdownFiles(resolvedDir);
    for (const filePath of files) {
      if (matches.length >= maxResults) break;
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;
          if (lines[i].toLowerCase().includes(queryLower)) {
            matches.push({
              path: filePath,
              relativePath: path.relative(context.cwd, filePath),
              line: i + 1,
              preview: lines[i].trim().slice(0, 120),
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory not found
  }

  return {
    matches,
    totalMatches: matches.length,
    query: input.query,
    dir: targetDir,
    truncated: matches.length >= maxResults,
  };
}

// ─── Internal Helpers ─────────────────────────────────────────

async function scanDirectory(
  dir: string,
  cwd: string,
  query: string | null,
): Promise<DocEntry[]> {
  const files = await collectMarkdownFiles(dir);
  const entries: DocEntry[] = [];

  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split(/\r?\n/);
      const relativePath = path.relative(cwd, filePath);

      // Extract summary from first non-empty, non-heading line
      let summary = "";
      for (const line of lines.slice(0, 20)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---") && !trimmed.startsWith("```")) {
          summary = trimmed.slice(0, 120);
          break;
        }
      }

      // Filter by query if provided
      if (query) {
        const nameMatch = relativePath.toLowerCase().includes(query);
        const summaryMatch = summary.toLowerCase().includes(query);
        const contentMatch = content.toLowerCase().includes(query);
        if (!nameMatch && !summaryMatch && !contentMatch) {
          continue;
        }
      }

      entries.push({
        name: path.basename(filePath),
        relativePath,
        absolutePath: filePath,
        sizeBytes: stat.size,
        lineCount: lines.length,
        modifiedAt: stat.mtime.toISOString(),
        summary,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".qoder") continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".markdown")) {
        result.push(fullPath);
      }
    }
  }

  await walk(dir);
  return result;
}
