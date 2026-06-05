import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";

import { canSignalProcessGroup, signalProcessTarget } from "./process-utils.mjs";

import type {
  JobRecord,
  ShellAttachStrategy,
  ShellBackgroundStartResult,
  ShellRunResult,
  ShellTailCursor,
} from "../types/contracts.js";

export interface ShellRuntimeConfig {
  cwd: string;
  projectStateDir: string;
  shellTimeoutMs: number;
  shellBufferChars: number;
  maxOutputChars: number;
}

export interface ShellSessionContext {
  sessionId: string | null;
  parentSessionId: string | null;
  rootSessionId: string | null;
  resumedFromSessionId: string | null;
}

export interface ShellExecutionContext {
  sessionId?: string | null;
  parentSessionId?: string | null;
  rootSessionId?: string | null;
  traceId?: string | null;
  step?: string | number | null;
}

export interface ShellRunInput {
  command?: string;
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
  stream?: boolean;
  pty?: boolean;
}

export interface ShellTailOptions {
  maxChars?: number;
  cursor?: ShellTailCursor | null;
}

export interface ShellErrorShape extends Error {
  taxonomy?: string;
  details?: unknown;
}

export interface PreparedOutputPaths extends Record<string, unknown> {
  stdoutPath: string;
  stderrPath: string;
}

export interface JobOutputReadResult {
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  bufferTruncated: boolean;
}

export interface JobStoreLike {
  initialize(): Promise<void>;
  createJob(job: JobRecord): Promise<JobRecord>;
  writeJob(job: JobRecord): Promise<JobRecord>;
  getJob(jobId: string): Promise<JobRecord>;
  listJobs(options?: { status?: string | null; limit?: number }): Promise<JobRecord[]>;
  appendEvent(jobId: string, event: Record<string, unknown>): Promise<void>;
  tailJobSince(
    jobId: string,
    cursor?: Partial<ShellTailCursor> | null,
    maxChars?: number,
  ): Promise<Record<string, unknown>>;
  prepareOutputFiles(jobId: string): Promise<PreparedOutputPaths>;
  readJobOutput(
    job: JobRecord | null | undefined,
    options?: {
      maxChars?: number;
      cursor?: Partial<ShellTailCursor> | null;
    },
  ): Promise<JobOutputReadResult>;
}

export interface LaunchedProcess {
  child: ChildProcess;
  ptyEnabled: boolean;
  ptyRequested?: boolean;
  ttyMode: string;
  degradedReason: string | null;
}

export interface RunningJobState {
  child: ChildProcess;
  job: JobRecord;
  lastSummaryAt: number;
  outputMode: "pipe" | "file";
}

export interface ShellJobLineage {
  createdBySessionId: string | null;
  visibleFromSessionId: string | null;
  resumedIntoSessionId: string | null;
  resumedIntoSessionIds: string[];
}

export function launchForegroundProcess({
  shell,
  command,
  cwd,
  ptyRequested,
}: {
  shell: string;
  command: string;
  cwd: string;
  ptyRequested: boolean;
}): LaunchedProcess {
  if (ptyRequested && process.platform === "darwin") {
    return {
      child: spawn("script", ["-q", "/dev/null", shell, "-lc", command], {
        cwd,
        env: process.env,
      }),
      ptyEnabled: true,
      ptyRequested: true,
      ttyMode: "pty",
      degradedReason: null,
    };
  }

  return {
    child: spawn(shell, ["-lc", command], {
      cwd,
      env: process.env,
    }),
    ptyEnabled: false,
    ptyRequested,
    ttyMode: ptyRequested ? "pty_degraded_pipe" : "pipe",
    degradedReason: ptyRequested ? `pty_best_effort_unavailable_${process.platform}` : null,
  };
}

export async function launchBackgroundProcess({
  shell,
  command,
  cwd,
  outputPaths,
  ptyRequested = false,
}: {
  shell: string;
  command: string;
  cwd: string;
  outputPaths: PreparedOutputPaths;
  ptyRequested?: boolean;
}): Promise<LaunchedProcess> {
  const stdoutHandle = await fs.open(outputPaths.stdoutPath, "a");
  const stderrHandle = await fs.open(outputPaths.stderrPath, "a");
  try {
    const child = spawn(shell, ["-lc", command], {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
    });
    child.unref();
    return {
      child,
      ptyEnabled: false,
      ttyMode: ptyRequested ? "pty_degraded_detached_pipe" : "detached_pipe",
      degradedReason: ptyRequested ? "background_persistence_disables_pty" : null,
    };
  } finally {
    await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
  }
}

export function normalizePositiveNumber(value: number | string | null | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function updateJobOutput(
  job: JobRecord,
  streamName: "stdout" | "stderr",
  chunk: string,
  maxChars: number,
): void {
  const isStderr = streamName === "stderr";
  const current = isStderr ? (job.stderrTail ?? "") : (job.stdoutTail ?? "");
  const next = `${current}${chunk}`;
  const chunkBytes = Buffer.byteLength(chunk, "utf8");

  if (isStderr) {
    job.stderrBytes = (job.stderrBytes ?? 0) + chunkBytes;
    job.totalStderrBytes = (job.totalStderrBytes ?? 0) + chunkBytes;
  } else {
    job.stdoutBytes = (job.stdoutBytes ?? 0) + chunkBytes;
    job.totalStdoutBytes = (job.totalStdoutBytes ?? 0) + chunkBytes;
  }

  if (next.length <= maxChars) {
    if (isStderr) {
      job.stderrTail = next;
    } else {
      job.stdoutTail = next;
    }
    return;
  }

  const dropped = next.length - maxChars;
  if (isStderr) {
    job.stderrTail = next.slice(-maxChars);
    job.stderrDroppedBytes = (job.stderrDroppedBytes ?? 0) + dropped;
  } else {
    job.stdoutTail = next.slice(-maxChars);
    job.stdoutDroppedBytes = (job.stdoutDroppedBytes ?? 0) + dropped;
  }
  job.bufferTruncated = true;
}

export function classifyExitStatus(job: JobRecord, code: number | null): string {
  if (job.timedOut) {
    return "timed_out";
  }
  if (job.cancelRequested) {
    return "cancelled";
  }
  if (code === 0) {
    return "exited";
  }
  return "failed";
}

export function summarizeJob(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    command: job.command,
    cwd: job.cwd,
    background: job.background,
    ptyRequested: job.ptyRequested,
    ptyEnabled: job.ptyEnabled,
    ttyMode: job.ttyMode,
    pid: job.pid,
    pgid: job.pgid,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    cancelRequested: job.cancelRequested,
    durationMs: job.durationMs,
    stdoutBytes: job.stdoutBytes,
    stderrBytes: job.stderrBytes,
    totalStdoutBytes: job.totalStdoutBytes,
    totalStderrBytes: job.totalStderrBytes,
    traceId: job.traceId,
    live: job.live,
    reattached: job.reattached,
    continuityState: job.continuityState,
    reattachPolicy: job.reattachPolicy,
    canCancel: job.canCancel,
    canReattach: job.canReattach,
    cursorTailAvailable: job.cursorTailAvailable,
    stdinAttachAvailable: job.stdinAttachAvailable,
    ptyDegradedReason: job.ptyDegradedReason ?? null,
    createdBySessionId: job.createdBySessionId,
    resumedIntoSessionId: job.resumedIntoSessionId ?? null,
  };
}

export function buildOutputPreview(job: JobRecord): string {
  const tail = job.stderrTail?.trim() || job.stdoutTail?.trim() || "";
  return tail.length <= 160 ? tail : `${tail.slice(-157)}...`;
}

export function buildShellResult(job: JobRecord): ShellRunResult {
  return {
    jobId: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    background: Boolean(job.background),
    ptyRequested: Boolean(job.ptyRequested),
    ptyEnabled: Boolean(job.ptyEnabled),
    ttyMode: job.ttyMode ?? null,
    exitCode: job.exitCode ?? null,
    signal: job.signal ?? null,
    timedOut: Boolean(job.timedOut),
    cancelled: Boolean(job.cancelRequested),
    durationMs: job.durationMs ?? null,
    stdout: job.stdoutTail ?? "",
    stderr: job.stderrTail ?? "",
    stdoutBytes: job.stdoutBytes ?? 0,
    stderrBytes: job.stderrBytes ?? 0,
    totalStdoutBytes: job.totalStdoutBytes ?? 0,
    totalStderrBytes: job.totalStderrBytes ?? 0,
    stdoutDroppedBytes: job.stdoutDroppedBytes ?? 0,
    stderrDroppedBytes: job.stderrDroppedBytes ?? 0,
    bufferTruncated: Boolean(job.bufferTruncated),
    lastUpdateAt: job.lastUpdateAt ?? null,
    live: Boolean(job.live),
    reattached: Boolean(job.reattached),
    historicalOnly: Boolean(job.historicalOnly),
    canReattach: Boolean(job.canReattach),
    canCancel: Boolean(job.canCancel),
    continuityState: job.continuityState ?? null,
    reattachPolicy: job.reattachPolicy ?? "historical_only",
    cursorTailAvailable: Boolean(job.cursorTailAvailable),
    stdinAttachAvailable: Boolean(job.stdinAttachAvailable),
    ptyDegradedReason: job.ptyDegradedReason ?? null,
    lifecycle: Array.isArray(job.lifecycle) ? job.lifecycle : [],
  };
}

export function buildBackgroundStartResult(
  job: JobRecord,
  traceId: string | null | undefined,
): ShellBackgroundStartResult {
  return {
    jobId: job.id,
    background: true,
    status: job.status,
    command: job.command,
    cwd: job.cwd,
    traceId,
    ptyRequested: Boolean(job.ptyRequested),
    ptyEnabled: Boolean(job.ptyEnabled),
    ttyMode: job.ttyMode ?? null,
    canReattach: Boolean(job.canReattach),
    reattachPolicy: job.reattachPolicy ?? null,
    cursorTailAvailable: Boolean(job.cursorTailAvailable),
    stdinAttachAvailable: Boolean(job.stdinAttachAvailable),
    ptyDegradedReason: job.ptyDegradedReason ?? null,
  };
}

export function computeDurationMs(startedAt: string | null | undefined, completedAt: string | null | undefined): number | null {
  if (!startedAt || !completedAt) {
    return null;
  }
  return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
}

export function createShellError(
  message: string,
  taxonomy = "shell_error",
  details: unknown = null,
): ShellErrorShape {
  const error = new Error(message) as ShellErrorShape;
  error.taxonomy = taxonomy;
  error.details = details;
  return error;
}

export function serializeShellError(error: unknown): Record<string, unknown> {
  const normalized = error as ShellErrorShape;
  return {
    message: normalized.message,
    taxonomy: normalized.taxonomy ?? "shell_error",
    details: normalized.details ?? null,
  };
}

export async function syncJobOutputFromFiles(
  jobStore: JobStoreLike,
  job: JobRecord,
  maxChars: number,
): Promise<JobRecord> {
  const output = await jobStore.readJobOutput(job, { maxChars });
  job.stdoutTail = output.stdoutTail;
  job.stderrTail = output.stderrTail;
  job.stdoutBytes = output.stdoutBytes;
  job.stderrBytes = output.stderrBytes;
  job.totalStdoutBytes = output.stdoutBytes;
  job.totalStderrBytes = output.stderrBytes;
  job.stdoutDroppedBytes = output.stdoutDroppedBytes;
  job.stderrDroppedBytes = output.stderrDroppedBytes;
  job.bufferTruncated = output.bufferTruncated;
  return job;
}

export function terminateJobProcess(job: JobRecord, signal: NodeJS.Signals): void {
  signalProcessTarget({
    pid: job.pid,
    pgid: canSignalProcessGroup() ? job.pgid ?? job.pid : null,
  }, signal);
}

export function classifyReattachPolicy(job: JobRecord, hasRuntimeHandle: boolean): string {
  if (!job.live) {
    return "historical_only";
  }
  if (hasRuntimeHandle && !job.background) {
    return "live_attach";
  }
  if (job.background && (job.outputPaths?.stdoutPath || job.outputPaths?.stderrPath) && job.canCancel !== false) {
    return "live_attach";
  }
  if (job.outputPaths?.stdoutPath || job.outputPaths?.stderrPath) {
    return "read_only_tail";
  }
  return "historical_only";
}

export function describeAttachStrategy(job: JobRecord, hasRuntimeHandle: boolean): ShellAttachStrategy {
  const interactive = Boolean(job.ptyEnabled && !job.background && hasRuntimeHandle);
  const liveMonitorAvailable =
    Boolean(job.live && (hasRuntimeHandle || job.outputPaths?.stdoutPath || job.outputPaths?.stderrPath));
  let mode = "historical_only";
  let reason = "No live process handle is available.";

  if (job.reattachPolicy === "live_attach" && interactive) {
    mode = "live_attach_interactive";
    reason = "Foreground PTY remains available in the current runtime.";
  } else if (job.reattachPolicy === "live_attach") {
    mode = "live_attach_supervised";
    reason = job.ptyRequested && !job.ptyEnabled
      ? job.ptyDegradedReason ?? "PTY degraded to pipe-backed live supervision."
      : "Detached process can still be supervised through output cursors and signals.";
  } else if (job.reattachPolicy === "read_only_tail") {
    mode = "read_only_tail";
    reason = "Only output tailing is available; live control is not.";
  }

  return {
    policy: job.reattachPolicy ?? "historical_only",
    mode,
    platform: process.platform,
    ttyMode: job.ttyMode ?? null,
    ptyRequested: Boolean(job.ptyRequested),
    ptyEnabled: Boolean(job.ptyEnabled),
    interactive,
    liveMonitorAvailable,
    cursorTailAvailable: Boolean(job.cursorTailAvailable),
    stdinAttachAvailable: Boolean(job.stdinAttachAvailable),
    canCancel: Boolean(job.canCancel),
    reason,
  };
}

export function changedJobShape(previous: JobRecord, next: JobRecord): boolean {
  return JSON.stringify({
    status: previous.status,
    live: previous.live,
    reattached: previous.reattached,
    continuityState: previous.continuityState,
    canReattach: previous.canReattach,
    canCancel: previous.canCancel,
    reattachPolicy: previous.reattachPolicy,
    resumedIntoSessionId: previous.resumedIntoSessionId,
    stdoutBytes: previous.stdoutBytes,
    stderrBytes: previous.stderrBytes,
    cursorTailAvailable: previous.cursorTailAvailable,
    stdinAttachAvailable: previous.stdinAttachAvailable,
    ttyMode: previous.ttyMode,
  }) !== JSON.stringify({
    status: next.status,
    live: next.live,
    reattached: next.reattached,
    continuityState: next.continuityState,
    canReattach: next.canReattach,
    canCancel: next.canCancel,
    reattachPolicy: next.reattachPolicy,
    resumedIntoSessionId: next.resumedIntoSessionId,
    stdoutBytes: next.stdoutBytes,
    stderrBytes: next.stderrBytes,
    cursorTailAvailable: next.cursorTailAvailable,
    stdinAttachAvailable: next.stdinAttachAvailable,
    ttyMode: next.ttyMode,
  });
}

export function buildJobLineage(
  sessionContext: ShellSessionContext | null,
  executionContext: ShellExecutionContext,
): ShellJobLineage {
  const sessionId = executionContext.sessionId ?? sessionContext?.sessionId ?? null;
  const parentSessionId = executionContext.parentSessionId ?? sessionContext?.parentSessionId ?? null;
  const rootSessionId = executionContext.rootSessionId ?? sessionContext?.rootSessionId ?? sessionId;
  return {
    createdBySessionId: sessionId,
    visibleFromSessionId: rootSessionId,
    resumedIntoSessionId: parentSessionId ? sessionId : null,
    resumedIntoSessionIds: parentSessionId && sessionId ? [sessionId] : [],
  };
}

export function normalizeTailOptions(
  options: number | ShellTailOptions | null | undefined,
  fallbackMaxChars: number,
): {
  maxChars: number;
  cursor: ShellTailCursor | null;
} {
  if (typeof options === "number") {
    return {
      maxChars: options,
      cursor: null,
    };
  }

  return {
    maxChars: normalizePositiveNumber(options?.maxChars, fallbackMaxChars),
    cursor: options?.cursor ?? null,
  };
}

export function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter(Boolean) as string[])];
}
