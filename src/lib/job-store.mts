import fs from "node:fs/promises";
import path from "node:path";

import type {
  JobEventRecord,
  JobRecord,
  JobTailResult,
} from "../types/contracts.js";

interface JobTailCursor {
  stdout?: number | null;
  stderr?: number | null;
}

interface ReadJobOutputOptions {
  maxChars?: number;
  cursor?: JobTailCursor | null;
}

interface ReadStreamTailResult {
  text: string;
  size: number;
  truncated: boolean;
  startCursor: number;
  nextCursor: number;
  bytesRead: number;
}

interface JobOutputReadResult {
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  bufferTruncated: boolean;
  cursorMode: string;
  cursor: {
    stdout: number;
    stderr: number;
  };
  nextCursor: {
    stdout: number;
    stderr: number;
  };
  readWindow: {
    stdout: {
      start: number;
      end: number;
      bytesRead: number;
      truncated: boolean;
    };
    stderr: {
      start: number;
      end: number;
      bytesRead: number;
      truncated: boolean;
    };
    totalBytesRead: number;
  };
}

type JobPatch = Partial<JobRecord>;

export class JobStore {
  readonly projectStateDir: string;
  readonly jobsDir: string;
  readonly eventsDir: string;
  readonly outputsDir: string;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.jobsDir = path.join(projectStateDir, "jobs");
    this.eventsDir = path.join(this.jobsDir, "events");
    this.outputsDir = path.join(this.jobsDir, "outputs");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.jobsDir, { recursive: true }),
      fs.mkdir(this.eventsDir, { recursive: true }),
      fs.mkdir(this.outputsDir, { recursive: true }),
    ]);
  }

  async createJob(job: JobRecord): Promise<JobRecord> {
    await this.initialize();
    await this.writeJob(job);
    await this.appendEvent(job.id, {
      type: "created",
      status: job.status,
      background: job.background,
    });
    return job;
  }

  async writeJob(job: JobRecord): Promise<JobRecord> {
    await this.initialize();
    const nextJob: JobRecord = {
      ...job,
      updatedAt: toString(job.updatedAt) ?? new Date().toISOString(),
    };
    await fs.writeFile(this.resolveJobPath(job.id), `${JSON.stringify(nextJob, null, 2)}\n`);
    return nextJob;
  }

  async updateJob(jobId: string, patch: JobPatch): Promise<JobRecord> {
    const current = await this.getJob(jobId);
    const nextJob: JobRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.writeJob(nextJob);
    return nextJob;
  }

  async getJob(jobId: string): Promise<JobRecord> {
    const contents = await fs.readFile(this.resolveJobPath(jobId), "utf8");
    return JSON.parse(contents) as JobRecord;
  }

  async appendEvent(jobId: string, event: Omit<JobEventRecord, "timestamp" | "jobId">): Promise<void> {
    await this.initialize();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      jobId,
      ...event,
    });
    await fs.appendFile(this.resolveEventPath(jobId), `${line}\n`);
  }

  async readEvents(jobId: string, limit = 200): Promise<JobEventRecord[]> {
    const contents = await fs.readFile(this.resolveEventPath(jobId), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JobEventRecord)
      .slice(-limit);
  }

  async listJobs({
    status = null,
    limit = 50,
  }: {
    status?: string | null;
    limit?: number;
  } = {}): Promise<JobRecord[]> {
    await this.initialize();
    const entries = await fs.readdir(this.jobsDir, { withFileTypes: true });
    const jobs: JobRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const job = await this.getJob(path.basename(entry.name, ".json"));
      if (status && job.status !== status) {
        continue;
      }
      jobs.push(job);
    }

    return jobs
      .sort((left, right) => `${right.updatedAt ?? ""}`.localeCompare(`${left.updatedAt ?? ""}`))
      .slice(0, limit);
  }

  async tailJob(jobId: string, maxChars = 4000): Promise<JobTailResult> {
    const job = await this.getJob(jobId);
    const output = await this.readJobOutput(job, { maxChars });
    return this.buildTailResult(job, output, await this.readEvents(jobId, 25));
  }

  async tailJobSince(
    jobId: string,
    cursor: JobTailCursor = {},
    maxChars = 4000,
  ): Promise<JobTailResult> {
    const job = await this.getJob(jobId);
    const output = await this.readJobOutput(job, { maxChars, cursor });
    return this.buildTailResult(job, output, await this.readEvents(jobId, 25));
  }

  async prepareOutputFiles(jobId: string): Promise<{
    stdoutPath: string;
    stderrPath: string;
  }> {
    await this.initialize();
    const stdoutPath = this.resolveOutputPath(jobId, "stdout");
    const stderrPath = this.resolveOutputPath(jobId, "stderr");
    await Promise.all([
      fs.writeFile(stdoutPath, ""),
      fs.writeFile(stderrPath, ""),
    ]);
    return {
      stdoutPath,
      stderrPath,
    };
  }

  async readJobOutput(
    job: JobRecord | null | undefined,
    {
      maxChars = 4000,
      cursor = null,
    }: ReadJobOutputOptions = {},
  ): Promise<JobOutputReadResult> {
    if (job?.outputPaths?.stdoutPath || job?.outputPaths?.stderrPath) {
      const stdout = await readFileTail(job.outputPaths?.stdoutPath, maxChars, cursor?.stdout);
      const stderr = await readFileTail(job.outputPaths?.stderrPath, maxChars, cursor?.stderr);
      return {
        stdoutTail: stdout.text,
        stderrTail: stderr.text,
        stdoutBytes: stdout.size,
        stderrBytes: stderr.size,
        stdoutDroppedBytes: stdout.truncated
          ? Math.max(0, stdout.size - Buffer.byteLength(stdout.text, "utf8"))
          : 0,
        stderrDroppedBytes: stderr.truncated
          ? Math.max(0, stderr.size - Buffer.byteLength(stderr.text, "utf8"))
          : 0,
        bufferTruncated: stdout.truncated || stderr.truncated,
        cursorMode: "byte-offset",
        cursor: {
          stdout: normalizeCursor(cursor?.stdout),
          stderr: normalizeCursor(cursor?.stderr),
        },
        nextCursor: {
          stdout: stdout.nextCursor,
          stderr: stderr.nextCursor,
        },
        readWindow: {
          stdout: {
            start: stdout.startCursor,
            end: stdout.nextCursor,
            bytesRead: stdout.bytesRead,
            truncated: stdout.truncated,
          },
          stderr: {
            start: stderr.startCursor,
            end: stderr.nextCursor,
            bytesRead: stderr.bytesRead,
            truncated: stderr.truncated,
          },
          totalBytesRead: stdout.bytesRead + stderr.bytesRead,
        },
      };
    }

    const stdoutTail = tailText(job?.stdoutTail ?? "", maxChars);
    const stderrTail = tailText(job?.stderrTail ?? "", maxChars);
    return {
      stdoutTail,
      stderrTail,
      stdoutBytes: toNumber(job?.stdoutBytes),
      stderrBytes: toNumber(job?.stderrBytes),
      stdoutDroppedBytes: toNumber(job?.stdoutDroppedBytes),
      stderrDroppedBytes: toNumber(job?.stderrDroppedBytes),
      bufferTruncated: Boolean(
        job?.bufferTruncated || job?.stdoutDroppedBytes || job?.stderrDroppedBytes,
      ),
      cursorMode: "buffer-tail",
      cursor: {
        stdout: 0,
        stderr: 0,
      },
      nextCursor: {
        stdout: toNumber(job?.stdoutBytes),
        stderr: toNumber(job?.stderrBytes),
      },
      readWindow: {
        stdout: {
          start: 0,
          end: toNumber(job?.stdoutBytes),
          bytesRead: Buffer.byteLength(stdoutTail, "utf8"),
          truncated: Boolean(job?.stdoutDroppedBytes),
        },
        stderr: {
          start: 0,
          end: toNumber(job?.stderrBytes),
          bytesRead: Buffer.byteLength(stderrTail, "utf8"),
          truncated: Boolean(job?.stderrDroppedBytes),
        },
        totalBytesRead:
          Buffer.byteLength(stdoutTail, "utf8") +
          Buffer.byteLength(stderrTail, "utf8"),
      },
    };
  }

  resolveJobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  resolveEventPath(jobId: string): string {
    return path.join(this.eventsDir, `${jobId}.jsonl`);
  }

  resolveOutputPath(jobId: string, streamName: "stdout" | "stderr"): string {
    return path.join(this.outputsDir, `${jobId}.${streamName}.log`);
  }

  private buildTailResult(
    job: JobRecord,
    output: JobOutputReadResult,
    events: JobEventRecord[],
  ): JobTailResult {
    return {
      id: job.id,
      status: job.status,
      command: job.command,
      cwd: job.cwd,
      stdoutTail: output.stdoutTail,
      stderrTail: output.stderrTail,
      stdoutBytes: output.stdoutBytes,
      stderrBytes: output.stderrBytes,
      stdoutDroppedBytes: output.stdoutDroppedBytes,
      stderrDroppedBytes: output.stderrDroppedBytes,
      bufferTruncated: output.bufferTruncated,
      cursorMode: output.cursorMode,
      cursor: output.cursor,
      nextCursor: output.nextCursor,
      readWindow: output.readWindow,
      live: Boolean(job.live),
      reattached: Boolean(job.reattached),
      historicalOnly: Boolean(job.historicalOnly),
      canReattach: Boolean(job.canReattach),
      canCancel: Boolean(job.canCancel),
      cursorTailAvailable: Boolean(
        job.cursorTailAvailable ?? (job.outputPaths?.stdoutPath || job.outputPaths?.stderrPath),
      ),
      stdinAttachAvailable: Boolean(job.stdinAttachAvailable),
      continuityState: toString(job.continuityState),
      reattachPolicy: toString(job.reattachPolicy) ?? "historical_only",
      ttyMode: toString(job.ttyMode),
      ptyRequested: Boolean(job.ptyRequested),
      ptyEnabled: Boolean(job.ptyEnabled),
      ptyDegradedReason: toString(job.ptyDegradedReason),
      events,
    };
  }
}

function tailText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

async function readFileTail(
  filePath: string | null | undefined,
  maxChars: number,
  cursor: number | null | undefined,
): Promise<ReadStreamTailResult> {
  if (!filePath) {
    return {
      text: "",
      size: 0,
      truncated: false,
      startCursor: 0,
      nextCursor: 0,
      bytesRead: 0,
    };
  }

  const stat = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stat) {
    return {
      text: "",
      size: 0,
      truncated: false,
      startCursor: 0,
      nextCursor: 0,
      bytesRead: 0,
    };
  }

  const size = stat.size;
  const useCursor = Number.isFinite(Number(cursor)) && Number(cursor) >= 0;
  const start = useCursor
    ? Math.min(size, Number(cursor))
    : Math.max(0, size - maxChars);
  const length = Math.max(0, size - start);
  if (length === 0) {
    return {
      text: "",
      size,
      truncated: !useCursor && start > 0,
      startCursor: start,
      nextCursor: size,
      bytesRead: 0,
    };
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      text: buffer.toString("utf8"),
      size,
      truncated: !useCursor && start > 0,
      startCursor: start,
      nextCursor: size,
      bytesRead: length,
    };
  } finally {
    await handle.close();
  }
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeCursor(value: number | null | undefined): number {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}
