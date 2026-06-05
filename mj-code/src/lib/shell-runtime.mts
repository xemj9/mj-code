import crypto from "node:crypto";

import { resolveUserPath } from "./path-utils.mjs";
import {
  buildBackgroundStartResult,
  buildJobLineage,
  buildOutputPreview,
  buildShellResult,
  changedJobShape,
  classifyExitStatus,
  classifyReattachPolicy,
  computeDurationMs,
  createShellError,
  describeAttachStrategy,
  launchBackgroundProcess,
  launchForegroundProcess,
  normalizePositiveNumber,
  normalizeTailOptions,
  serializeShellError,
  summarizeJob,
  syncJobOutputFromFiles,
  terminateJobProcess,
  uniqueIds,
  updateJobOutput,
} from "./shell-runtime-support.mjs";

import type {
  JobRecord,
  JobTailResult,
  ShellAttachResult,
  ShellAttachStrategy,
  ShellBackgroundStartResult,
  ShellRunResult,
} from "../types/contracts.js";
import type {
  JobStoreLike,
  RunningJobState,
  ShellErrorShape,
  ShellExecutionContext,
  ShellRunInput,
  ShellRuntimeConfig,
  ShellSessionContext,
  ShellTailOptions,
} from "./shell-runtime-support.mjs";

const OUTPUT_SUMMARY_INTERVAL_MS = 300;

type ShellEvent = Record<string, unknown>;
type ShellEventHandler = (event: ShellEvent) => Promise<void> | void;

export interface ShellRuntimeOptions {
  onEvent?: ShellEventHandler | null;
}

interface ShellStartResult {
  job: JobRecord;
  completion: Promise<ShellRunResult>;
}

interface CancelResult {
  jobId: string;
  cancelled: boolean;
  status: string;
  continuityState: string | null | undefined;
  message?: string;
  error?: Record<string, unknown>;
}

type ShellTailResponse = JobTailResult & {
  attachStrategy: ShellAttachStrategy;
  cursorRequest: {
    stdout: number;
    stderr: number;
  };
};

export class ShellRuntime {
  readonly config: ShellRuntimeConfig;
  readonly jobStore: JobStoreLike;
  readonly onEvent: ShellEventHandler | null;
  readonly runningJobs: Map<string, RunningJobState>;
  sessionContext: ShellSessionContext | null;

  constructor(config: ShellRuntimeConfig, jobStore: JobStoreLike, options: ShellRuntimeOptions = {}) {
    this.config = config;
    this.jobStore = jobStore;
    this.onEvent = options.onEvent ?? null;
    this.runningJobs = new Map();
    this.sessionContext = null;
  }

  async initialize(): Promise<void> {
    await this.jobStore.initialize();
  }

  async bindSession(context: Partial<ShellSessionContext> = {}): Promise<JobRecord[]> {
    this.sessionContext = {
      sessionId: context.sessionId ?? null,
      parentSessionId: context.parentSessionId ?? null,
      rootSessionId: context.rootSessionId ?? context.sessionId ?? null,
      resumedFromSessionId: context.resumedFromSessionId ?? null,
    };
    return this.reconcileJobs({ emitEvents: true });
  }

  async run(
    input: ShellRunInput,
    executionContext: ShellExecutionContext = {},
  ): Promise<ShellRunResult | ShellBackgroundStartResult> {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) {
      throw createShellError("run_shell requires a command string.", "tool_schema_error");
    }

    const shell = input.shell || process.env.SHELL || "/bin/zsh";
    const cwd = input.cwd ? resolveUserPath(input.cwd, this.config.cwd) : this.config.cwd;
    const timeoutMs = normalizePositiveNumber(input.timeoutMs, this.config.shellTimeoutMs);
    const background = Boolean(input.background);
    const stream = input.stream !== false;
    const ptyRequested = Boolean(input.pty);
    const jobId = crypto.randomUUID().slice(0, 12);
    const createdAt = new Date().toISOString();

    const lineage = buildJobLineage(this.sessionContext, executionContext);
    const job: JobRecord = {
      id: jobId,
      command,
      cwd,
      shell,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      endedAt: null,
      completedAt: null,
      sessionId: executionContext.sessionId ?? this.sessionContext?.sessionId ?? null,
      parentSessionId: executionContext.parentSessionId ?? this.sessionContext?.parentSessionId ?? null,
      traceId: executionContext.traceId ?? null,
      step: executionContext.step ?? null,
      status: "queued",
      background,
      stream,
      timeoutMs,
      ptyRequested,
      ptyEnabled: false,
      ttyMode: ptyRequested ? "pty_requested" : "pipe",
      ptyDegradedReason: null,
      pid: null,
      pgid: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelRequested: false,
      durationMs: null,
      stdoutTail: "",
      stderrTail: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0,
      totalStdoutBytes: 0,
      totalStderrBytes: 0,
      bufferTruncated: false,
      lastUpdateAt: createdAt,
      live: false,
      reattached: false,
      historicalOnly: false,
      canReattach: false,
      canCancel: false,
      canTail: true,
      cursorTailAvailable: background,
      stdinAttachAvailable: false,
      continuityState: "historical",
      reattachPolicy: "historical_only",
      outputPaths: null,
      lifecycle: [],
      error: null,
      createdBySessionId: lineage.createdBySessionId,
      visibleFromSessionId: lineage.visibleFromSessionId,
      resumedIntoSessionId: lineage.resumedIntoSessionId,
      resumedIntoSessionIds: lineage.resumedIntoSessionIds,
    };

    await this.jobStore.createJob(job);
    await this.emitEvent({
      type: "shell_job_created",
      phase: "shell_spawn",
      job: summarizeJob(job),
    });

    const runner = await this.startJob(job);
    if (background) {
      runner.completion.catch(() => {});
      return buildBackgroundStartResult(runner.job, job.traceId);
    }

    return runner.completion;
  }

  async listJobs(
    status: string | null = null,
    limit = 50,
  ): Promise<Array<JobRecord & { attachStrategy: ShellAttachStrategy }>> {
    await this.reconcileJobs({ emitEvents: false });
    const jobs = await this.jobStore.listJobs({ status, limit });
    return jobs.map((job) => ({
      ...job,
      attachStrategy: describeAttachStrategy(job, this.runningJobs.has(job.id)),
    }));
  }

  async cancelJob(jobId: string): Promise<CancelResult> {
    await this.reconcileJob(jobId, { emitEvents: false });
    const running = this.runningJobs.get(jobId);
    const current = await this.jobStore.getJob(jobId);

    if (!current.canCancel) {
      return {
        jobId,
        cancelled: false,
        status: current.status,
        continuityState: current.continuityState,
        message: "Job cannot be cancelled from the current runtime state.",
      };
    }

    current.cancelRequested = true;
    current.updatedAt = new Date().toISOString();
    current.lastUpdateAt = current.updatedAt;
    await this.jobStore.writeJob(current);
    await this.jobStore.appendEvent(jobId, {
      type: "cancel_requested",
      phase: "shell_cancel",
      status: current.status,
      continuityState: current.continuityState,
    });

    if (running?.child) {
      running.job = current;
      try {
        terminateJobProcess(current, "SIGTERM");
      } catch {}
      setTimeout(() => {
        if (this.runningJobs.has(jobId)) {
          try {
            terminateJobProcess(current, "SIGKILL");
          } catch {}
        }
      }, 1000).unref();
    } else {
      try {
        terminateJobProcess(current, "SIGTERM");
      } catch (error) {
        return {
          jobId,
          cancelled: false,
          status: current.status,
          continuityState: current.continuityState,
          error: serializeShellError(
            createShellError((error as Error).message, "shell_error"),
          ),
        };
      }
    }

    await this.emitEvent({
      type: "shell_job_cancel_requested",
      phase: "shell_cancel",
      job: summarizeJob(current),
    });

    return {
      jobId,
      cancelled: true,
      status: current.status,
      continuityState: current.continuityState,
    };
  }

  async tailJob(jobId: string, options: number | ShellTailOptions = this.config.maxOutputChars): Promise<ShellTailResponse> {
    const job = await this.reconcileJob(jobId, { emitEvents: false });
    const normalized = normalizeTailOptions(options, this.config.maxOutputChars);
    const tail = await this.jobStore.tailJobSince(jobId, normalized.cursor, normalized.maxChars) as JobTailResult;
    return {
      ...tail,
      attachStrategy: describeAttachStrategy(job, this.runningJobs.has(jobId)),
      cursorRequest: normalized.cursor ?? { stdout: 0, stderr: 0 },
    };
  }

  async attachJob(jobId: string, options: ShellTailOptions = {}): Promise<ShellAttachResult> {
    const job = await this.reconcileJob(jobId, { emitEvents: true });
    const tail = await this.tailJob(jobId, {
      maxChars: options.maxChars ?? this.config.maxOutputChars,
      cursor: options.cursor ?? null,
    });
    await this.jobStore.appendEvent(job.id, {
      type: "attached",
      phase: "shell_reattach",
      status: job.status,
      reattachPolicy: job.reattachPolicy,
      cursor: options.cursor ?? null,
    });
    await this.emitEvent({
      type: "shell_job_attached",
      phase: "shell_reattach",
      job: summarizeJob(job),
      cursor: options.cursor ?? null,
    });

    const message =
      job.reattachPolicy === "live_attach"
        ? "Live supervision is available. MJ Code can tail new output and send signals, but interactive stdin passthrough is degraded or unavailable."
        : job.reattachPolicy === "read_only_tail"
          ? "Live control is not available; falling back to read-only tail."
          : "Only historical inspection is available for this job.";

    return {
      jobId,
      mode: job.reattachPolicy ?? "historical_only",
      attached: job.reattachPolicy === "live_attach",
      live: Boolean(job.live),
      canCancel: Boolean(job.canCancel),
      canReattach: Boolean(job.canReattach),
      historicalOnly: Boolean(job.historicalOnly),
      cursorTailAvailable: Boolean(job.cursorTailAvailable),
      stdinAttachAvailable: Boolean(job.stdinAttachAvailable),
      ttyMode: job.ttyMode ?? null,
      ptyRequested: Boolean(job.ptyRequested),
      ptyEnabled: Boolean(job.ptyEnabled),
      ptyDegradedReason: job.ptyDegradedReason ?? null,
      continuityState: job.continuityState ?? null,
      attachStrategy: describeAttachStrategy(job, this.runningJobs.has(jobId)),
      message,
      tail,
    };
  }

  async getShellHistory(limit = 20): Promise<JobRecord[]> {
    await this.reconcileJobs({ emitEvents: false });
    return this.jobStore.listJobs({ limit });
  }

  async startJob(initialJob: JobRecord): Promise<ShellStartResult> {
    if (initialJob.background) {
      return this.startBackgroundJob(initialJob);
    }
    return this.startForegroundJob(initialJob);
  }

  async startForegroundJob(initialJob: JobRecord): Promise<ShellStartResult> {
    const launched = launchForegroundProcess({
      shell: initialJob.shell,
      command: initialJob.command,
      cwd: initialJob.cwd,
      ptyRequested: Boolean(initialJob.ptyRequested),
    });

    const startedAt = new Date().toISOString();
    const job: JobRecord = {
      ...initialJob,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      lastUpdateAt: startedAt,
      pid: launched.child.pid ?? null,
      pgid: launched.child.pid ?? null,
      ptyEnabled: launched.ptyEnabled,
      ttyMode: launched.ttyMode,
      ptyDegradedReason:
        launched.ptyRequested && !launched.ptyEnabled
          ? launched.degradedReason ?? "pty_unavailable"
          : null,
      live: true,
      continuityState: "live",
      reattachPolicy: "live_attach",
      canReattach: true,
      canCancel: true,
      cursorTailAvailable: true,
      stdinAttachAvailable: false,
      lifecycle: [...(Array.isArray(initialJob.lifecycle) ? initialJob.lifecycle : []), { type: "running", at: startedAt }],
    };
    await this.jobStore.writeJob(job);
    await this.jobStore.appendEvent(job.id, {
      type: "started",
      phase: "shell_spawn",
      status: "running",
      pid: job.pid,
      ptyEnabled: job.ptyEnabled,
      ttyMode: job.ttyMode,
    });
    await this.emitEvent({
      type: "shell_job_started",
      phase: "shell_spawn",
      job: summarizeJob(job),
    });

    const running: RunningJobState = {
      child: launched.child,
      job,
      lastSummaryAt: 0,
      outputMode: "pipe",
    };
    this.runningJobs.set(job.id, running);

    const completion = new Promise<ShellRunResult>((resolve, reject) => {
      const rejectOnce = async (error: unknown) => {
        clearTimeout(timer);
        await this.finalizeFailedJob(running, reject, error);
      };

      const timer = setTimeout(async () => {
        running.job.timedOut = true;
        running.job.status = "timed_out";
        running.job.updatedAt = new Date().toISOString();
        running.job.lastUpdateAt = running.job.updatedAt;
        await this.jobStore.writeJob(running.job);
        await this.jobStore.appendEvent(job.id, {
          type: "timeout",
          phase: "shell_timeout",
          status: "timed_out",
          timeoutMs: job.timeoutMs,
        });
        await this.emitEvent({
          type: "shell_job_timeout",
          phase: "shell_timeout",
          job: summarizeJob(running.job),
        });
        try {
          terminateJobProcess(running.job, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            terminateJobProcess(running.job, "SIGKILL");
          } catch {}
        }, 1000).unref();
      }, job.timeoutMs ?? this.config.shellTimeoutMs);
      timer.unref();

      const onChunk = async (streamName: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        updateJobOutput(running.job, streamName, text, this.config.shellBufferChars);
        running.job.lastUpdateAt = new Date().toISOString();
        if (!running.job.background && running.job.stream) {
          await this.maybeEmitOutputSummary(running);
        }
      };

      launched.child.stdout?.on("data", (chunk: Buffer | string) => {
        onChunk("stdout", chunk).catch(rejectOnce);
      });
      launched.child.stderr?.on("data", (chunk: Buffer | string) => {
        onChunk("stderr", chunk).catch(rejectOnce);
      });

      launched.child.on("error", async (error) => {
        clearTimeout(timer);
        await this.finalizeFailedJob(running, reject, error);
      });

      launched.child.on("close", async (code, signal) => {
        clearTimeout(timer);
        await this.finalizeCompletedJob(running, resolve, code, signal);
      });
    });

    return {
      job: running.job,
      completion,
    };
  }

  async startBackgroundJob(initialJob: JobRecord): Promise<ShellStartResult> {
    const outputPaths = await this.jobStore.prepareOutputFiles(initialJob.id);
    const launched = await launchBackgroundProcess({
      shell: initialJob.shell,
      command: initialJob.command,
      cwd: initialJob.cwd,
      outputPaths,
      ptyRequested: Boolean(initialJob.ptyRequested),
    });
    const startedAt = new Date().toISOString();
    const reattachPolicy = "live_attach";
    const job: JobRecord = {
      ...initialJob,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      lastUpdateAt: startedAt,
      pid: launched.child.pid ?? null,
      pgid: launched.child.pid ?? null,
      ptyEnabled: false,
      ttyMode: launched.ttyMode,
      ptyDegradedReason:
        launched.degradedReason ?? (initialJob.ptyRequested ? "background_persistence_disables_pty" : null),
      live: true,
      continuityState: "live",
      reattachPolicy,
      canReattach: true,
      canCancel: true,
      cursorTailAvailable: true,
      stdinAttachAvailable: false,
      outputPaths,
      lifecycle: [...(Array.isArray(initialJob.lifecycle) ? initialJob.lifecycle : []), { type: "running", at: startedAt }],
    };

    await this.jobStore.writeJob(job);
    await this.jobStore.appendEvent(job.id, {
      type: "started",
      phase: "shell_spawn",
      status: "running",
      pid: job.pid,
      pgid: job.pgid,
      detached: true,
      reattachPolicy,
    });
    await this.emitEvent({
      type: "shell_job_started",
      phase: "shell_spawn",
      job: summarizeJob(job),
    });

    const running: RunningJobState = {
      child: launched.child,
      job,
      lastSummaryAt: 0,
      outputMode: "file",
    };
    this.runningJobs.set(job.id, running);

    const completion = new Promise<ShellRunResult>((resolve, reject) => {
      const timer = setTimeout(async () => {
        running.job.timedOut = true;
        running.job.status = "timed_out";
        running.job.updatedAt = new Date().toISOString();
        running.job.lastUpdateAt = running.job.updatedAt;
        await this.jobStore.writeJob(running.job);
        await this.jobStore.appendEvent(job.id, {
          type: "timeout",
          phase: "shell_timeout",
          status: "timed_out",
          timeoutMs: job.timeoutMs,
        });
        await this.emitEvent({
          type: "shell_job_timeout",
          phase: "shell_timeout",
          job: summarizeJob(running.job),
        });
        try {
          terminateJobProcess(running.job, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            terminateJobProcess(running.job, "SIGKILL");
          } catch {}
        }, 1000).unref();
      }, job.timeoutMs ?? this.config.shellTimeoutMs);
      timer.unref();

      launched.child.on("error", async (error) => {
        clearTimeout(timer);
        await this.finalizeFailedJob(running, reject, error);
      });

      launched.child.on("close", async (code, signal) => {
        clearTimeout(timer);
        await syncJobOutputFromFiles(this.jobStore, running.job, this.config.shellBufferChars);
        await this.finalizeCompletedJob(running, resolve, code, signal);
      });
    });

    return {
      job: running.job,
      completion,
    };
  }

  async finalizeFailedJob(
    running: RunningJobState,
    reject: (reason?: unknown) => void,
    error: unknown,
  ): Promise<void> {
    if (!this.runningJobs.has(running.job.id)) {
      return;
    }
    const rawError = error as NodeJS.ErrnoException;
    const shellError = createShellError(rawError.message, "shell_error", {
      code: rawError.code ?? null,
    });
    running.job.status = "failed";
    running.job.error = serializeShellError(shellError);
    running.job.endedAt = new Date().toISOString();
    running.job.completedAt = running.job.endedAt;
    running.job.durationMs = computeDurationMs(running.job.startedAt, running.job.completedAt);
    running.job.updatedAt = running.job.completedAt;
    running.job.lastUpdateAt = running.job.completedAt;
    running.job.live = false;
    running.job.historicalOnly = true;
    running.job.canCancel = false;
    running.job.canReattach = false;
    running.job.continuityState = "historical";
    running.job.reattachPolicy = "historical_only";
    await this.jobStore.writeJob(running.job);
    await this.jobStore.appendEvent(running.job.id, {
      type: "spawn_error",
      phase: "shell_spawn",
      status: "failed",
      error: running.job.error,
    });
    await this.emitEvent({
      type: "shell_job_failed",
      phase: "shell_spawn",
      job: summarizeJob(running.job),
      error: running.job.error,
    });
    this.runningJobs.delete(running.job.id);
    reject(shellError);
  }

  async finalizeCompletedJob(
    running: RunningJobState,
    resolve: (value: ShellRunResult) => void,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (!this.runningJobs.has(running.job.id)) {
      return;
    }
    const persisted = await this.jobStore.getJob(running.job.id).catch(() => null);
    if (persisted?.cancelRequested) {
      running.job.cancelRequested = true;
    }
    if (Array.isArray(persisted?.resumedIntoSessionIds)) {
      running.job.resumedIntoSessionIds = uniqueIds([
        ...(running.job.resumedIntoSessionIds ?? []),
        ...persisted.resumedIntoSessionIds,
      ]);
      running.job.resumedIntoSessionId = persisted.resumedIntoSessionId ?? running.job.resumedIntoSessionId ?? null;
    }
    running.job.exitCode = code;
    running.job.signal = signal;
    running.job.endedAt = new Date().toISOString();
    running.job.completedAt = running.job.endedAt;
    running.job.durationMs = computeDurationMs(running.job.startedAt, running.job.completedAt);
    running.job.status = classifyExitStatus(running.job, code);
    running.job.updatedAt = running.job.completedAt;
    running.job.lastUpdateAt = running.job.completedAt;
    running.job.live = false;
    running.job.historicalOnly = true;
    running.job.canCancel = false;
    running.job.canReattach = false;
    running.job.continuityState = "historical";
    running.job.reattachPolicy = "historical_only";
    running.job.lifecycle = [
      ...(Array.isArray(running.job.lifecycle) ? running.job.lifecycle : []),
      { type: running.job.status, at: running.job.completedAt, exitCode: code, signal },
    ];
    await this.jobStore.writeJob(running.job);
    await this.jobStore.appendEvent(running.job.id, {
      type: "completed",
      phase: "shell_wait",
      status: running.job.status,
      exitCode: code,
      signal,
      durationMs: running.job.durationMs,
    });
    await this.emitEvent({
      type: "shell_job_completed",
      phase: "shell_wait",
      job: summarizeJob(running.job),
    });
    this.runningJobs.delete(running.job.id);
    resolve(buildShellResult(running.job));
  }

  async maybeEmitOutputSummary(running: RunningJobState): Promise<void> {
    const now = Date.now();
    if (now - running.lastSummaryAt < OUTPUT_SUMMARY_INTERVAL_MS) {
      return;
    }
    running.lastSummaryAt = now;
    await this.jobStore.writeJob(running.job);
    await this.jobStore.appendEvent(running.job.id, {
      type: "output_summary",
      phase: "shell_stream",
      status: running.job.status,
      stdoutBytes: running.job.stdoutBytes,
      stderrBytes: running.job.stderrBytes,
    });
    await this.emitEvent({
      type: "shell_job_output",
      phase: "shell_stream",
      job: summarizeJob(running.job),
      preview: buildOutputPreview(running.job),
    });
  }

  async reconcileJobs({ emitEvents = false }: { emitEvents?: boolean } = {}): Promise<JobRecord[]> {
    const jobs = await this.jobStore.listJobs({ limit: 200 });
    const updated: JobRecord[] = [];
    for (const job of jobs) {
      updated.push(await this.reconcilePersistedJob(job, { emitEvents }));
    }
    return updated;
  }

  async reconcileJob(jobId: string, { emitEvents = false }: { emitEvents?: boolean } = {}): Promise<JobRecord> {
    const job = await this.jobStore.getJob(jobId);
    return this.reconcilePersistedJob(job, { emitEvents });
  }

  async reconcilePersistedJob(
    job: JobRecord,
    { emitEvents = false }: { emitEvents?: boolean } = {},
  ): Promise<JobRecord> {
    const wasStatus = job.status;
    const wasContinuity = job.continuityState;
    const live = ["queued", "running"].includes(job.status) && isProcessAlive(job.pid);
    const next: JobRecord = {
      ...job,
      live,
      canTail: true,
      totalStdoutBytes: job.totalStdoutBytes ?? job.stdoutBytes ?? 0,
      totalStderrBytes: job.totalStderrBytes ?? job.stderrBytes ?? 0,
      bufferTruncated: Boolean(job.bufferTruncated || job.stdoutDroppedBytes || job.stderrDroppedBytes),
    };

    if (live) {
      const inherited =
        Boolean(this.sessionContext?.sessionId && next.createdBySessionId) &&
        this.sessionContext!.sessionId !== next.createdBySessionId;
      next.status = "running";
      next.historicalOnly = false;
      next.canCancel = true;
      next.canReattach = Boolean(next.background || this.runningJobs.has(next.id));
      next.reattachPolicy = classifyReattachPolicy(next, this.runningJobs.has(next.id));
      next.cursorTailAvailable = Boolean(
        next.outputPaths?.stdoutPath || next.outputPaths?.stderrPath || this.runningJobs.has(next.id),
      );
      next.stdinAttachAvailable = false;
      next.continuityState = inherited ? "reattached" : "live";
      next.reattached = inherited || Boolean(next.reattached);
      if (inherited && this.sessionContext?.sessionId) {
        next.resumedIntoSessionId = this.sessionContext.sessionId;
        next.resumedIntoSessionIds = uniqueIds([
          ...(Array.isArray(next.resumedIntoSessionIds) ? next.resumedIntoSessionIds : []),
          this.sessionContext.sessionId,
        ]);
      }
      if (next.outputPaths?.stdoutPath || next.outputPaths?.stderrPath) {
        await syncJobOutputFromFiles(this.jobStore, next, this.config.shellBufferChars);
      }
    } else {
      if (next.status === "running" || next.status === "queued") {
        next.status = next.cancelRequested ? "cancelled" : next.background ? "orphaned" : "failed";
      }
      next.historicalOnly = true;
      next.canCancel = false;
      next.canReattach = false;
      next.cursorTailAvailable = Boolean(next.outputPaths?.stdoutPath || next.outputPaths?.stderrPath);
      next.stdinAttachAvailable = false;
      next.reattachPolicy = "historical_only";
      next.continuityState = next.status === "orphaned" ? "orphaned" : "historical";
      next.reattached = Boolean(next.reattached);
      if (next.outputPaths?.stdoutPath || next.outputPaths?.stderrPath) {
        await syncJobOutputFromFiles(this.jobStore, next, this.config.shellBufferChars);
      }
      if (!next.endedAt && next.status === "orphaned") {
        next.endedAt = new Date().toISOString();
      }
      next.updatedAt = new Date().toISOString();
      next.lastUpdateAt = next.updatedAt;
    }

    if (changedJobShape(job, next)) {
      await this.jobStore.writeJob(next);
      if (emitEvents && next.continuityState === "reattached" && wasContinuity !== "reattached") {
        await this.jobStore.appendEvent(next.id, {
          type: "reattached",
          phase: "shell_reattach",
          status: next.status,
          sessionId: this.sessionContext?.sessionId ?? null,
          reattachPolicy: next.reattachPolicy,
        });
        await this.emitEvent({
          type: "shell_job_reattached",
          phase: "shell_reattach",
          job: summarizeJob(next),
        });
      }
      if (emitEvents && next.status === "orphaned" && wasStatus !== "orphaned") {
        await this.jobStore.appendEvent(next.id, {
          type: "orphaned",
          phase: "shell_reattach",
          status: next.status,
        });
        await this.emitEvent({
          type: "shell_job_orphaned",
          phase: "shell_reattach",
          job: summarizeJob(next),
        });
      }
    }

    return next;
  }

  async emitEvent(event: ShellEvent): Promise<void> {
    if (typeof this.onEvent === "function") {
      await this.onEvent(event);
    }
  }
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
