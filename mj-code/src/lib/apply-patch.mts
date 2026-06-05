import fs from "node:fs/promises";
import path from "node:path";

import { isSubPath, resolveUserPath } from "./path-utils.mjs";

import type {
  ApplyPatchResult,
  PatchFileChange,
  PatchOperation,
  PatchPreview,
  PatchUpdateHunk,
} from "../types/contracts.js";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

export async function applyPatchText(
  patchText: string,
  cwd: string,
): Promise<ApplyPatchResult> {
  const preview = await previewPatchText(patchText, cwd);
  const touchedFiles: string[] = [];

  for (const fileChange of preview.fileChanges) {
    await applyFileChange(fileChange);
    touchedFiles.push(...fileChange.touchedFiles);
  }

  return {
    touchedFiles,
    operationCount: preview.fileChanges.length,
  };
}

export function extractPatchPaths(patchText: string, cwd: string): string[] {
  return parsePatchText(patchText).flatMap((operation) => getOperationPaths(operation, cwd));
}

export async function previewPatchText(
  patchText: string,
  cwd: string,
): Promise<PatchPreview> {
  const operations = parsePatchText(patchText);
  const fileChanges: PatchFileChange[] = [];

  for (const operation of operations) {
    const targetPaths = getOperationPaths(operation, cwd);
    for (const targetPath of targetPaths) {
      if (!isSubPath(cwd, targetPath)) {
        throw new Error(`Patch path "${targetPath}" is outside the workspace.`);
      }
    }

    const result = await simulateOperation(operation, cwd);
    fileChanges.push(result);
  }

  return {
    fileChanges,
    touchedFiles: fileChanges.flatMap((entry) => entry.touchedFiles),
    operationCount: fileChanges.length,
  };
}

export function parsePatchText(patchText: string): PatchOperation[] {
  const lines = `${patchText ?? ""}`.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== BEGIN_PATCH) {
    throw new Error('Patch must start with "*** Begin Patch".');
  }

  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line === END_PATCH) {
      return operations;
    }

    if (line.startsWith(ADD_FILE)) {
      const filePath = line.slice(ADD_FILE.length);
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const entry = lines[index] ?? "";
        if (!entry.startsWith("+")) {
          throw new Error(`Add file line must start with "+": ${entry}`);
        }
        contentLines.push(entry.slice(1));
        index += 1;
      }

      operations.push({
        type: "add",
        path: filePath,
        content: contentLines.join("\n"),
      });
      continue;
    }

    if (line.startsWith(DELETE_FILE)) {
      operations.push({
        type: "delete",
        path: line.slice(DELETE_FILE.length),
      });
      index += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE)) {
      const filePath = line.slice(UPDATE_FILE.length);
      index += 1;
      let moveTo: string | null = null;
      if (lines[index]?.startsWith(MOVE_TO)) {
        moveTo = lines[index]?.slice(MOVE_TO.length) ?? null;
        index += 1;
      }

      const blockLines: string[] = [];
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        if (lines[index] !== END_OF_FILE) {
          blockLines.push(lines[index] ?? "");
        }
        index += 1;
      }

      operations.push({
        type: "update",
        path: filePath,
        moveTo,
        hunks: parseUpdateHunks(blockLines),
      });
      continue;
    }

    throw new Error(`Unknown patch directive: ${line}`);
  }

  throw new Error('Patch must end with "*** End Patch".');
}

function parseUpdateHunks(blockLines: string[]): PatchUpdateHunk[] {
  if (blockLines.length === 0) {
    return [];
  }

  const hunks: PatchUpdateHunk[] = [];
  let current: PatchUpdateHunk = [];

  for (const line of blockLines) {
    if (line.startsWith("@@")) {
      if (current.length > 0) {
        hunks.push(current);
        current = [];
      }
      continue;
    }

    if (![" ", "+", "-"].includes(line[0] ?? "")) {
      throw new Error(`Unsupported patch line: ${line}`);
    }

    current.push(line);
  }

  if (current.length > 0) {
    hunks.push(current);
  }

  return hunks;
}

async function simulateOperation(
  operation: PatchOperation,
  cwd: string,
): Promise<PatchFileChange> {
  if (operation.type === "add") {
    const filePath = resolveUserPath(operation.path, cwd);
    try {
      await fs.access(filePath);
      throw new Error(`File "${operation.path}" already exists.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    return {
      operation: "add",
      path: filePath,
      previousPath: null,
      beforeContent: null,
      afterContent: operation.content,
      touchedFiles: [filePath],
    };
  }

  if (operation.type === "delete") {
    const filePath = resolveUserPath(operation.path, cwd);
    const original = await fs.readFile(filePath, "utf8");
    return {
      operation: "delete",
      path: filePath,
      previousPath: null,
      beforeContent: original,
      afterContent: null,
      touchedFiles: [filePath],
    };
  }

  const originalPath = resolveUserPath(operation.path, cwd);
  const original = await fs.readFile(originalPath, "utf8");
  const updated = applyUpdateHunks(original, operation.hunks);

  if (operation.moveTo) {
    const nextPath = resolveUserPath(operation.moveTo, cwd);
    return {
      operation: "rename",
      path: nextPath,
      previousPath: originalPath,
      beforeContent: original,
      afterContent: updated,
      touchedFiles: [originalPath, nextPath],
    };
  }

  return {
    operation: "update",
    path: originalPath,
    previousPath: null,
    beforeContent: original,
    afterContent: updated,
    touchedFiles: [originalPath],
  };
}

async function applyFileChange(fileChange: PatchFileChange): Promise<void> {
  if (fileChange.operation === "add") {
    await fs.mkdir(path.dirname(fileChange.path), { recursive: true });
    await fs.writeFile(fileChange.path, fileChange.afterContent ?? "", "utf8");
    return;
  }

  if (fileChange.operation === "delete") {
    await fs.rm(fileChange.path);
    return;
  }

  if (fileChange.operation === "rename") {
    await fs.mkdir(path.dirname(fileChange.path), { recursive: true });
    await fs.writeFile(fileChange.path, fileChange.afterContent ?? "", "utf8");
    if (!fileChange.previousPath) {
      throw new Error("Rename patch is missing a previous path.");
    }
    await fs.rm(fileChange.previousPath);
    return;
  }

  await fs.writeFile(fileChange.path, fileChange.afterContent ?? "", "utf8");
}

function applyUpdateHunks(original: string, hunks: PatchUpdateHunk[]): string {
  const normalized = original.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const originalLines = trailingNewline
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const oldChunk = hunk
      .filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1));
    const newChunk = hunk
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1));
    const position = findChunkPosition(originalLines, oldChunk, cursor);

    if (position === -1) {
      throw new Error("Failed to apply patch hunk: context not found.");
    }

    output.push(...originalLines.slice(cursor, position));
    output.push(...newChunk);
    cursor = position + oldChunk.length;
  }

  output.push(...originalLines.slice(cursor));
  return output.join("\n") + (trailingNewline ? "\n" : "");
}

function findChunkPosition(lines: string[], chunk: string[], start: number): number {
  if (chunk.length === 0) {
    return start;
  }

  for (let index = start; index <= lines.length - chunk.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < chunk.length; offset += 1) {
      if (lines[index + offset] !== chunk[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return index;
    }
  }

  return -1;
}

function getOperationPaths(operation: PatchOperation, cwd: string): string[] {
  if (operation.type === "update") {
    return [
      resolveUserPath(operation.path, cwd),
      ...(operation.moveTo ? [resolveUserPath(operation.moveTo, cwd)] : []),
    ];
  }

  return [resolveUserPath(operation.path, cwd)];
}
