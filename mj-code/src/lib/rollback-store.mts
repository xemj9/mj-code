import fs from "node:fs/promises";
import path from "node:path";

import { buildFileDiffArtifact, summarizeChangeSet } from "./change-set.mjs";

import type {
  ChangeSetFileState,
  ChangeSetRecord,
  RollbackCheckpointFileRecord,
  RollbackCheckpointListEntry,
  RollbackCheckpointRecord,
  RollbackErrorEntry,
  RollbackResult,
  RollbackResultEntry,
} from "../types/contracts.js";

interface CheckpointMetadata {
  sessionId?: string | null;
  traceId?: string | null;
  origin?: string | null;
  sourceTool?: string | null;
}

interface MarkAppliedPayload {
  result?: unknown;
}

interface MarkApplyFailedPayload extends MarkAppliedPayload {
  partial?: boolean;
  errorTaxonomy?: string | null;
}

interface RollbackOptions {
  sessionId?: string | null;
  traceId?: string | null;
}

interface WriteFileCheckpointInput {
  blobDir: string;
  index: number;
  fileState: ChangeSetFileState;
}

interface RestoreChangeSetRecord extends ChangeSetRecord {
  _internal: {
    cwd: string;
    fileStates: ChangeSetFileState[];
  };
}

export class RollbackStore {
  readonly projectStateDir: string;
  readonly checkpointDir: string;
  readonly blobDir: string;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.checkpointDir = path.join(projectStateDir, "checkpoints");
    this.blobDir = path.join(this.checkpointDir, "blobs");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.checkpointDir, { recursive: true }),
      fs.mkdir(this.blobDir, { recursive: true }),
    ]);
  }

  async checkpointChangeSet(
    changeSet: RestoreChangeSetRecord,
    metadata: CheckpointMetadata = {},
  ): Promise<RollbackCheckpointRecord> {
    await this.initialize();
    const fileStates = Array.isArray(changeSet?._internal?.fileStates)
      ? changeSet._internal.fileStates
      : [];
    const checkpointBlobDir = path.join(this.blobDir, changeSet.id);
    await fs.mkdir(checkpointBlobDir, { recursive: true });

    const files: RollbackCheckpointFileRecord[] = [];
    for (let index = 0; index < fileStates.length; index += 1) {
      const fileState = fileStates[index];
      const fileRecord = await this.writeFileCheckpoint({
        blobDir: checkpointBlobDir,
        index,
        fileState,
      });
      files.push(fileRecord);
    }

    const summary = summarizeChangeSet({
      ...changeSet,
      rollbackAvailable: true,
      checkpointId: changeSet.id,
    }) ?? {
      id: changeSet.id,
      toolName: changeSet.toolName,
      touchedFiles: Array.isArray(changeSet.touchedFiles) ? changeSet.touchedFiles : [],
      operations: changeSet.operations ?? {},
      files: [],
      rollbackAvailable: true,
      checkpointId: changeSet.id,
      risk: changeSet.risk ?? null,
    };

    const record: RollbackCheckpointRecord = {
      id: changeSet.id,
      sessionId: metadata.sessionId ?? null,
      traceId: metadata.traceId ?? null,
      toolName: changeSet.toolName,
      origin: metadata.origin ?? "tool_apply",
      sourceTool: metadata.sourceTool ?? changeSet.toolName,
      risk: changeSet.risk ?? null,
      createdAt: new Date().toISOString(),
      status: "checkpointed",
      rollbackAvailable: true,
      summary,
      files,
      appliedAt: null,
      applyResult: null,
      applyError: null,
      applyErrorTaxonomy: null,
      rollbackAt: null,
      rollbackError: null,
      restorePointId: null,
    };

    await this.writeRecord(record);
    return record;
  }

  async markApplied(
    changeSetId: string,
    payload: MarkAppliedPayload = {},
  ): Promise<RollbackCheckpointRecord> {
    const record = await this.getCheckpoint(changeSetId);
    record.status = "applied";
    record.appliedAt = new Date().toISOString();
    record.applyResult = payload.result ?? null;
    record.applyError = null;
    record.applyErrorTaxonomy = null;
    await this.writeRecord(record);
    return record;
  }

  async markApplyFailed(
    changeSetId: string,
    error: unknown,
    payload: MarkApplyFailedPayload = {},
  ): Promise<RollbackCheckpointRecord> {
    const record = await this.getCheckpoint(changeSetId);
    record.status = payload.partial ? "apply_partial_failure" : "apply_failed";
    record.applyError = error instanceof Error ? error.message : `${error ?? "Unknown error"}`;
    record.applyErrorTaxonomy = payload.errorTaxonomy ?? "filesystem_error";
    record.applyResult = payload.result ?? null;
    await this.writeRecord(record);
    return record;
  }

  async rollback(changeSetId: string, options: RollbackOptions = {}): Promise<RollbackResult> {
    const record = await this.getCheckpoint(changeSetId);
    const restorePoint = await this.createRestorePoint(record, options);
    record.restorePointId = restorePoint.id;
    const results: RollbackResultEntry[] = [];
    const errors: RollbackErrorEntry[] = [];

    for (const fileEntry of record.files) {
      try {
        await restoreFileEntry(fileEntry);
        results.push({
          path: fileEntry.path,
          previousPath: fileEntry.previousPath,
          operation: fileEntry.operation,
          restored: true,
        });
      } catch (error) {
        errors.push({
          path: fileEntry.path,
          previousPath: fileEntry.previousPath,
          operation: fileEntry.operation,
          error: error instanceof Error ? error.message : `${error ?? "Unknown error"}`,
        });
      }
    }

    record.rollbackAt = new Date().toISOString();
    record.rollbackError = errors.length > 0 ? errors : null;
    record.status = errors.length > 0 ? "rollback_partial_failure" : "rolled_back";
    await this.writeRecord(record);

    return {
      changeSetId: record.id,
      restorePointId: record.restorePointId,
      rolledBack: errors.length === 0,
      partial: errors.length > 0,
      results,
      errors,
    };
  }

  async getCheckpoint(reference: string): Promise<RollbackCheckpointRecord> {
    const filePath = await this.resolveCheckpointPath(reference);
    const contents = await fs.readFile(filePath, "utf8");
    return parseCheckpointRecord(contents);
  }

  async listCheckpoints(limit = 20): Promise<RollbackCheckpointListEntry[]> {
    await this.initialize();
    const entries = await fs.readdir(this.checkpointDir, { withFileTypes: true });
    const jsonFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);

    const records: RollbackCheckpointListEntry[] = [];
    for (const fileName of jsonFiles) {
      const contents = await fs.readFile(path.join(this.checkpointDir, fileName), "utf8");
      const record = parseCheckpointRecord(contents);
      records.push({
        id: record.id,
        createdAt: record.createdAt,
        status: record.status,
        origin: record.origin,
        toolName: record.toolName,
        risk: record.risk,
        sessionId: record.sessionId,
        traceId: record.traceId,
        restorePointId: record.restorePointId,
        touchedFiles: record.summary?.touchedFiles ?? [],
      });
    }

    return records;
  }

  async writeFileCheckpoint({
    blobDir,
    index,
    fileState,
  }: WriteFileCheckpointInput): Promise<RollbackCheckpointFileRecord> {
    const beforeBlob = await writeBlob(blobDir, `${index}-before`, fileState.beforeContent);
    const afterBlob = await writeBlob(blobDir, `${index}-after`, fileState.afterContent);
    const forwardPatch = buildFileDiffArtifact({
      beforeContent: fileState.beforeContent,
      afterContent: fileState.afterContent,
      beforeLabel: fileState.previousPath ?? fileState.path,
      afterLabel: fileState.path,
      operation: fileState.operation,
      maxChars: 10000,
    });
    const reversePatch = buildFileDiffArtifact({
      beforeContent: fileState.afterContent,
      afterContent: fileState.beforeContent,
      beforeLabel: fileState.path,
      afterLabel: fileState.previousPath ?? fileState.path,
      operation: inverseOperation(fileState.operation),
      maxChars: 10000,
    });

    return {
      operation: fileState.operation,
      path: fileState.path,
      previousPath: fileState.previousPath,
      beforeBlob,
      afterBlob,
      forwardPatch: forwardPatch.text,
      reversePatch: reversePatch.text,
    };
  }

  async createRestorePoint(
    record: RollbackCheckpointRecord,
    options: RollbackOptions = {},
  ): Promise<RollbackCheckpointRecord> {
    const fileStates: ChangeSetFileState[] = [];
    for (const fileEntry of record.files) {
      fileStates.push({
        operation: inverseOperation(fileEntry.operation),
        path: fileEntry.previousPath ?? fileEntry.path,
        previousPath: fileEntry.previousPath ? fileEntry.path : null,
        beforeContent: await safeReadBlob(fileEntry.afterBlob),
        afterContent: await safeReadBlob(fileEntry.beforeBlob),
        touchedFiles: [fileEntry.previousPath ?? fileEntry.path, fileEntry.path].filter(Boolean),
      });
    }

    const restoreChangeSet: RestoreChangeSetRecord = {
      id: `${record.id}-restore-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      toolName: "rollback",
      dryRun: true,
      input: {
        restorePointFor: record.id,
      },
      risk: record.risk,
      touchedFiles: fileStates.flatMap((entry) => entry.touchedFiles),
      files: [],
      operations: {},
      diff: "",
      diffTruncated: false,
      impact: {
        touchedFiles: [],
        relatedFiles: [],
        likelyTests: [],
        needsTestRerun: false,
        engine: "rollback",
        scannedFiles: 0,
        scanTruncated: false,
        cacheHit: false,
        deadlineHit: false,
        quality: "restorative",
        cost: {
          engine: "rollback",
          scannedFiles: 0,
          scanTruncated: false,
          cacheHit: false,
          deadlineHit: false,
        },
      },
      rollbackAvailable: false,
      checkpointId: null,
      _internal: {
        cwd: record.summary?.touchedFiles?.[0]
          ? path.dirname(record.summary.touchedFiles[0])
          : this.projectStateDir,
        fileStates,
      },
    };

    return this.checkpointChangeSet(restoreChangeSet, {
      sessionId: options.sessionId ?? record.sessionId,
      traceId: options.traceId ?? record.traceId,
      origin: "rollback_restore_point",
      sourceTool: "rollback",
    });
  }

  async resolveCheckpointPath(reference: string): Promise<string> {
    await this.initialize();
    const normalized = `${reference ?? ""}`.trim();
    if (!normalized) {
      throw new Error("Missing change-set reference.");
    }

    const directPath = path.join(this.checkpointDir, `${normalized}.json`);
    try {
      await fs.access(directPath);
      return directPath;
    } catch {}

    const entries = await fs.readdir(this.checkpointDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .filter((fileName) => fileName === `${normalized}.json` || fileName.startsWith(`${normalized}.json`));

    if (matches.length === 1) {
      return path.join(this.checkpointDir, matches[0]);
    }

    const prefixMatches = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .filter((fileName) => fileName.startsWith(normalized));

    if (prefixMatches.length === 1) {
      return path.join(this.checkpointDir, prefixMatches[0]);
    }

    throw new Error(`Could not resolve change-set "${reference}".`);
  }

  async writeRecord(record: RollbackCheckpointRecord): Promise<void> {
    await this.initialize();
    const filePath = path.join(this.checkpointDir, `${record.id}.json`);
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
    await fs.rename(tempPath, filePath);
  }
}

async function restoreFileEntry(fileEntry: RollbackCheckpointFileRecord): Promise<void> {
  if (fileEntry.operation === "add") {
    await fs.rm(fileEntry.path, { force: true });
    return;
  }

  if (fileEntry.operation === "delete") {
    const beforeContent = await safeReadBlob(fileEntry.beforeBlob);
    if (beforeContent == null) {
      throw new Error(`Missing before-image blob for ${fileEntry.path}.`);
    }
    await fs.mkdir(path.dirname(fileEntry.path), { recursive: true });
    await fs.writeFile(fileEntry.path, beforeContent, "utf8");
    return;
  }

  if (fileEntry.operation === "rename") {
    const beforeContent = await safeReadBlob(fileEntry.beforeBlob);
    if (beforeContent == null || !fileEntry.previousPath) {
      throw new Error(`Missing rename before-image for ${fileEntry.path}.`);
    }
    await fs.mkdir(path.dirname(fileEntry.previousPath), { recursive: true });
    await fs.writeFile(fileEntry.previousPath, beforeContent, "utf8");
    await fs.rm(fileEntry.path, { force: true });
    return;
  }

  const beforeContent = await safeReadBlob(fileEntry.beforeBlob);
  if (beforeContent == null) {
    throw new Error(`Missing update before-image blob for ${fileEntry.path}.`);
  }
  await fs.writeFile(fileEntry.path, beforeContent, "utf8");
}

async function writeBlob(
  blobDir: string,
  key: string,
  content: string | null,
): Promise<string | null> {
  if (content == null) {
    return null;
  }

  const filePath = path.join(blobDir, `${key}.txt`);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function safeReadBlob(blobPath: string | null): Promise<string | null> {
  if (!blobPath) {
    return null;
  }

  return fs.readFile(blobPath, "utf8");
}

function inverseOperation(operation: string): string {
  if (operation === "add") {
    return "delete";
  }

  if (operation === "delete") {
    return "add";
  }

  return operation;
}

function parseCheckpointRecord(contents: string): RollbackCheckpointRecord {
  return JSON.parse(contents) as RollbackCheckpointRecord;
}
