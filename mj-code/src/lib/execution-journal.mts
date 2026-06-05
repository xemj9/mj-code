import fs from "node:fs/promises";
import path from "node:path";

import type {
  ExecutionJournalAppendInput,
  ExecutionJournalEntry,
  ExecutionJournalLoadedSnapshot,
  ExecutionJournalPhaseEntry,
  ExecutionJournalRecordPhaseInput,
  ExecutionJournalSnapshotRef,
  ExecutionJournalStartedEntry,
} from "../types/contracts.js";

export interface ExecutionJournalSnapshotWriteMeta {
  traceId: string | null;
  phase: string;
  stepId: string | number;
  outputSummary: string;
}

export interface ExecutionJournalLike {
  start(sessionId: string, metadata?: Record<string, unknown>): Promise<string>;
  open(sessionId: string): Promise<string>;
  append(entry: ExecutionJournalAppendInput): Promise<void>;
  writeStateSnapshot(
    state: Record<string, unknown>,
    metadata: ExecutionJournalSnapshotWriteMeta,
  ): Promise<string>;
  recordPhase(entry: ExecutionJournalRecordPhaseInput): Promise<void>;
  loadLatestSnapshot(sessionId?: string | null): Promise<ExecutionJournalLoadedSnapshot | null>;
  listPhases(sessionId?: string | null, limit?: number): Promise<ExecutionJournalPhaseEntry[]>;
  readEntries(sessionId?: string | null): Promise<ExecutionJournalEntry[]>;
  initialize(): Promise<void>;
}

export class ExecutionJournal implements ExecutionJournalLike {
  readonly projectStateDir: string;
  readonly journalDir: string;
  readonly snapshotDir: string;
  filePath: string | null;
  sessionId: string | null;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.journalDir = path.join(projectStateDir, "journal");
    this.snapshotDir = path.join(this.journalDir, "snapshots");
    this.filePath = null;
    this.sessionId = null;
  }

  async start(sessionId: string, metadata: Record<string, unknown> = {}): Promise<string> {
    await this.initialize();
    this.sessionId = sessionId;
    this.filePath = path.join(this.journalDir, `${sessionId}.jsonl`);
    await fs.access(this.filePath).catch(async () => {
      await fs.writeFile(this.filePath!, "");
    });
    await this.append({
      type: "journal_started",
      phase: "planning",
      payload: metadata,
    });
    return this.filePath;
  }

  async open(sessionId: string): Promise<string> {
    await this.initialize();
    const filePath = path.join(this.journalDir, `${sessionId}.jsonl`);
    await fs.access(filePath);
    this.sessionId = sessionId;
    this.filePath = filePath;
    return filePath;
  }

  async append(entry: ExecutionJournalAppendInput): Promise<void> {
    if (!this.filePath || !this.sessionId) {
      throw new Error("Execution journal is not initialized.");
    }

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      ...entry,
    });
    await fs.appendFile(this.filePath, `${line}\n`);
  }

  async writeStateSnapshot(
    state: Record<string, unknown>,
    metadata: ExecutionJournalSnapshotWriteMeta,
  ): Promise<string> {
    if (!this.sessionId) {
      throw new Error("Execution journal is not initialized.");
    }

    const ref = this.createSnapshotRef(metadata);
    const targetDir = path.join(this.snapshotDir, this.sessionId);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(ref.filePath, `${JSON.stringify(state, null, 2)}\n`);
    return ref.filePath;
  }

  async recordPhase(entry: ExecutionJournalRecordPhaseInput): Promise<void> {
    await this.append({
      type: "phase",
      traceId: entry.traceId ?? null,
      stepId: entry.stepId ?? null,
      phase: entry.phase,
      inputSummary: entry.inputSummary ?? null,
      outputSummary: entry.outputSummary ?? null,
      metrics: entry.metrics ?? null,
      error: entry.error ?? null,
      retry: entry.retry ?? null,
      snapshot: entry.snapshot ?? null,
    });
  }

  async loadLatestSnapshot(sessionId: string | null = this.sessionId): Promise<ExecutionJournalLoadedSnapshot | null> {
    if (!sessionId) {
      return null;
    }

    const targetDir = path.join(this.snapshotDir, sessionId);
    const entries = await fs.readdir(targetDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    if (files.length === 0) {
      return null;
    }

    const filePath = path.join(targetDir, files[0]);
    const [contents, stat] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath),
    ]);
    return normalizeLoadedSnapshot(sessionId, filePath, contents, stat.mtime.toISOString());
  }

  async listPhases(
    sessionId: string | null = this.sessionId,
    limit = 200,
  ): Promise<ExecutionJournalPhaseEntry[]> {
    const events = await this.readEntries(sessionId);
    return events
      .filter((entry): entry is ExecutionJournalPhaseEntry => entry.type === "phase")
      .slice(-limit);
  }

  async readEntries(sessionId: string | null = this.sessionId): Promise<ExecutionJournalEntry[]> {
    const resolvedSessionId = requireSessionId(sessionId);
    const filePath = path.join(this.journalDir, `${resolvedSessionId}.jsonl`);
    const contents = await fs.readFile(filePath, "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => normalizeExecutionJournalEntry(JSON.parse(line) as unknown, resolvedSessionId));
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.journalDir, { recursive: true }),
      fs.mkdir(this.snapshotDir, { recursive: true }),
    ]);
  }

  private createSnapshotRef(metadata: ExecutionJournalSnapshotWriteMeta): ExecutionJournalSnapshotRef {
    const sessionId = requireSessionId(this.sessionId);
    const createdAt = new Date().toISOString();
    const stepToken = `${metadata.stepId ?? "state"}`;
    const phaseToken = metadata.phase ?? "snapshot";
    const fileName = `${createdAt.replaceAll(":", "-").replaceAll(".", "-")}-${stepToken}-${phaseToken}.json`;
    return {
      filePath: path.join(this.snapshotDir, sessionId, fileName),
      sessionId,
      traceId: metadata.traceId ?? null,
      phase: phaseToken,
      stepId: metadata.stepId,
      outputSummary: metadata.outputSummary,
      createdAt,
    };
  }
}

function normalizeExecutionJournalEntry(
  value: unknown,
  fallbackSessionId: string,
): ExecutionJournalEntry {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const timestamp = typeof record.timestamp === "string"
    ? record.timestamp
    : new Date(0).toISOString();
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : fallbackSessionId;
  const type = typeof record.type === "string" ? record.type : "event";

  if (type === "journal_started") {
    return {
      timestamp,
      sessionId,
      type: "journal_started",
      phase: typeof record.phase === "string" ? record.phase : "planning",
      payload: asRecord(record.payload),
    };
  }

  if (type === "phase") {
    return {
      timestamp,
      sessionId,
      type: "phase",
      traceId: typeof record.traceId === "string" ? record.traceId : null,
      stepId: normalizeStepId(record.stepId),
      phase: typeof record.phase === "string" ? record.phase : "unknown",
      inputSummary: typeof record.inputSummary === "string" ? record.inputSummary : null,
      outputSummary: typeof record.outputSummary === "string" ? record.outputSummary : null,
      metrics: record.metrics ?? null,
      error: record.error ?? null,
      retry: record.retry ?? null,
      snapshot: record.snapshot ?? null,
    };
  }

  return {
    timestamp,
    sessionId,
    ...(record as ExecutionJournalAppendInput),
    type,
  };
}

function normalizeLoadedSnapshot(
  sessionId: string,
  filePath: string,
  contents: string,
  createdAt: string,
): ExecutionJournalLoadedSnapshot {
  const state = JSON.parse(contents) as unknown;

  return {
    filePath,
    sessionId,
    traceId: null,
    phase: "snapshot",
    stepId: "state",
    outputSummary: `Loaded snapshot ${path.basename(filePath)}.`,
    createdAt,
    state: state && typeof state === "object" ? state as Record<string, unknown> : {},
  };
}

function normalizeStepId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value) {
    return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function requireSessionId(sessionId: string | null | undefined): string {
  if (!sessionId) {
    throw new Error("Execution journal is not initialized.");
  }
  return sessionId;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object";
}
