/**
 * SandboxMonitor — Resource monitoring and process tree control for SandboxRuntime.
 *
 * Inspired by Claude Code's process isolation and resource management:
 * - Tracks resource usage (CPU, memory, file descriptors) of sandboxed processes
 * - Implements process tree killing (not just the direct child)
 * - Monitors filesystem writes in real-time
 * - Provides resource usage reports for the execution journal
 *
 * This module complements the existing SandboxRuntime by adding observability
 * and control that the OS-level sandboxing alone doesn't provide.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResourceSnapshot {
  timestamp: string;
  cpuPercent: number;
  memoryMb: number;
  fileDescriptors: number;
  openFiles: string[];
  childProcessCount: number;
}

export interface FilesystemEvent {
  type: "create" | "modify" | "delete";
  path: string;
  timestamp: string;
  size?: number;
}

export interface SandboxMonitorResult {
  peakMemoryMb: number;
  avgCpuPercent: number;
  totalFilesystemEvents: number;
  filesystemEvents: FilesystemEvent[];
  resourceSnapshots: ResourceSnapshot[];
  durationMs: number;
  processTreeKilled: boolean;
}

export interface SandboxMonitorConfig {
  cwd: string;
  allowedWritePaths: string[];
  sampleIntervalMs: number;
  maxMemoryMb: number;
  maxFilesystemEvents: number;
  trackFilesystem: boolean;
  trackResources: boolean;
  killProcessTree: boolean;
}

// ─── SandboxMonitor ─────────────────────────────────────────────────────────

export class SandboxMonitor {
  readonly config: SandboxMonitorConfig;
  private snapshots: ResourceSnapshot[] = [];
  private filesystemEvents: FilesystemEvent[] = [];
  private peakMemoryMb: number = 0;
  private totalCpuPercent: number = 0;
  private cpuSampleCount: number = 0;
  private startedAt: number = 0;
  private previousFileSet: Set<string> = new Set();
  private childPid: number | null = null;

  constructor(config: Partial<SandboxMonitorConfig> & { cwd: string }) {
    this.config = {
      allowedWritePaths: [config.cwd ?? process.cwd()],
      sampleIntervalMs: 500,
      maxMemoryMb: 512,
      maxFilesystemEvents: 100,
      trackFilesystem: true,
      trackResources: true,
      killProcessTree: true,
      ...config,
    };
  }

  /**
   * Start monitoring a process.
   */
  start(childPid: number): void {
    this.childPid = childPid;
    this.startedAt = Date.now();
    this.snapshots = [];
    this.filesystemEvents = [];
    this.peakMemoryMb = 0;
    this.totalCpuPercent = 0;
    this.cpuSampleCount = 0;

    // Capture initial file set for filesystem tracking
    if (this.config.trackFilesystem) {
      this.captureFileSet().then((files) => {
        this.previousFileSet = files;
      }).catch(() => {});
    }
  }

  /**
   * Take a resource snapshot.
   */
  async sample(): Promise<ResourceSnapshot | null> {
    if (!this.childPid || !this.config.trackResources) {
      return null;
    }

    try {
      const snapshot = await this.captureResourceSnapshot(this.childPid);
      this.snapshots.push(snapshot);

      // Update running statistics
      this.peakMemoryMb = Math.max(this.peakMemoryMb, snapshot.memoryMb);
      this.totalCpuPercent += snapshot.cpuPercent;
      this.cpuSampleCount += 1;

      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Check filesystem changes since last check.
   */
  async checkFilesystem(): Promise<FilesystemEvent[]> {
    if (!this.config.trackFilesystem) {
      return [];
    }

    try {
      const currentFiles = await this.captureFileSet();
      const events = this.diffFileSets(this.previousFileSet, currentFiles);
      this.previousFileSet = currentFiles;

      for (const event of events) {
        if (this.filesystemEvents.length < this.config.maxFilesystemEvents) {
          this.filesystemEvents.push(event);
        }
      }

      return events;
    } catch {
      return [];
    }
  }

  /**
   * Check if memory limit is exceeded.
   */
  isMemoryLimitExceeded(): boolean {
    return this.peakMemoryMb > this.config.maxMemoryMb;
  }

  /**
   * Kill the entire process tree (not just the direct child).
   *
   * On macOS: uses `pkill -P <pid>` to kill children first
   * On Linux: uses `kill -TERM -- -<pgid>` to kill process group
   */
  async killProcessTree(pid: number): Promise<boolean> {
    if (!this.config.killProcessTree) {
      try {
        process.kill(pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    }

    const platform = os.platform();

    try {
      if (platform === "darwin") {
        // macOS: kill children first, then parent
        return await this.killProcessTreeMacOS(pid);
      } else if (platform === "linux") {
        // Linux: kill the process group
        return await this.killProcessTreeLinux(pid);
      } else {
        // Fallback: kill direct process
        process.kill(pid, "SIGTERM");
        return true;
      }
    } catch {
      return false;
    }
  }

  /**
   * Finalize monitoring and get results.
   */
  async finalize(): Promise<SandboxMonitorResult> {
    // Take final filesystem snapshot
    if (this.config.trackFilesystem) {
      await this.checkFilesystem();
    }

    const durationMs = this.startedAt > 0 ? Date.now() - this.startedAt : 0;

    return {
      peakMemoryMb: this.peakMemoryMb,
      avgCpuPercent: this.cpuSampleCount > 0 ? this.totalCpuPercent / this.cpuSampleCount : 0,
      totalFilesystemEvents: this.filesystemEvents.length,
      filesystemEvents: this.filesystemEvents,
      resourceSnapshots: this.snapshots,
      durationMs,
      processTreeKilled: false,
    };
  }

  /**
   * Validate filesystem events against allowed paths.
   *
   * Returns events that write to paths outside the allowed list.
   */
  findViolations(): FilesystemEvent[] {
    return this.filesystemEvents.filter((event) => {
      if (event.type === "delete") {
        // Deletes of files within allowed paths are fine
        return !this.isPathAllowed(event.path);
      }
      // Creates and modifies outside allowed paths are violations
      return !this.isPathAllowed(event.path);
    });
  }

  /**
   * Reset the monitor for reuse.
   */
  reset(): void {
    this.childPid = null;
    this.snapshots = [];
    this.filesystemEvents = [];
    this.peakMemoryMb = 0;
    this.totalCpuPercent = 0;
    this.cpuSampleCount = 0;
    this.startedAt = 0;
    this.previousFileSet = new Set();
  }

  // ─── Private Methods ───────────────────────────────────────────────────

  private isPathAllowed(filePath: string): boolean {
    const normalized = path.resolve(filePath);
    return this.config.allowedWritePaths.some((allowed) => {
      return normalized.startsWith(path.resolve(allowed));
    });
  }

  private async captureResourceSnapshot(pid: number): Promise<ResourceSnapshot> {
    const platform = os.platform();
    let cpuPercent = 0;
    let memoryMb = 0;
    let fileDescriptors = 0;
    let childProcessCount = 0;

    try {
      if (platform === "darwin" || platform === "linux") {
        // Use `ps` to get resource info
        const result = await this.runCommand("ps", ["-o", "pcpu,rss,nfds", "-p", `${pid}`]);
        const lines = result.trim().split("\n");
        if (lines.length >= 2) {
          const values = lines[1].trim().split(/\s+/);
          cpuPercent = Number(values[0]) || 0;
          memoryMb = (Number(values[1]) || 0) / 1024; // RSS is in KB
          fileDescriptors = Number(values[2]) || 0;
        }

        // Count child processes
        const childResult = await this.runCommand("pgrep", ["-P", `${pid}`]);
        childProcessCount = childResult.trim().split("\n").filter(Boolean).length;
      }
    } catch {
      // ps/pgrep not available, use process.memoryUsage as fallback
      memoryMb = process.memoryUsage().rss / (1024 * 1024);
    }

    return {
      timestamp: new Date().toISOString(),
      cpuPercent,
      memoryMb,
      fileDescriptors,
      openFiles: [],
      childProcessCount,
    };
  }

  private async captureFileSet(): Promise<Set<string>> {
    const files = new Set<string>();

    for (const dir of this.config.allowedWritePaths) {
      try {
        const entries = await listFilesRecursive(dir, 3);
        for (const entry of entries) {
          files.add(entry);
        }
      } catch {
        // Directory might not exist or be unreadable
      }
    }

    return files;
  }

  private diffFileSets(previous: Set<string>, current: Set<string>): FilesystemEvent[] {
    const events: FilesystemEvent[] = [];
    const now = new Date().toISOString();

    // New files (created)
    for (const file of current) {
      if (!previous.has(file)) {
        events.push({ type: "create", path: file, timestamp: now });
      }
    }

    // Deleted files
    for (const file of previous) {
      if (!current.has(file)) {
        events.push({ type: "delete", path: file, timestamp: now });
      }
    }

    // Modified files (exist in both, but might have changed)
    // We can't detect modifications without content hashing, so we skip this
    // for performance reasons. The tool execution layer handles this via ChangeSet.

    return events;
  }

  private async killProcessTreeMacOS(pid: number): Promise<boolean> {
    // First, find all descendant PIDs
    const childPids = await this.findDescendantPids(pid);

    // Kill children first (bottom-up)
    for (const childPid of childPids.reverse()) {
      try {
        process.kill(childPid, "SIGTERM");
      } catch {}
    }

    // Then kill the parent
    try {
      process.kill(pid, "SIGTERM");
    } catch {}

    // Wait briefly, then force-kill any survivors
    await new Promise((resolve) => setTimeout(resolve, 1000));

    for (const childPid of [...childPids, pid]) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }

    return true;
  }

  private async killProcessTreeLinux(pid: number): Promise<boolean> {
    try {
      // Try to kill the process group using negative PID
      process.kill(-pid, "SIGTERM");
    } catch {
      // Fall back to individual process killing
      return this.killProcessTreeMacOS(pid);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      process.kill(-pid, "SIGKILL");
    } catch {}

    return true;
  }

  private async findDescendantPids(pid: number): Promise<number[]> {
    const pids: number[] = [];
    const queue = [pid];

    while (queue.length > 0) {
      const currentPid = queue.shift()!;
      try {
        const result = await this.runCommand("pgrep", ["-P", `${currentPid}`]);
        const childPids = result
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => Number(line.trim()))
          .filter((num) => Number.isFinite(num) && num > 0);

        pids.push(...childPids);
        queue.push(...childPids);
      } catch {
        // No children
      }
    }

    return pids;
  }

  private async runCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: "pipe" });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
        }
      });
      child.on("error", reject);
    });
  }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

async function listFilesRecursive(dir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth <= 0) {
    return [];
  }

  const files: string[] = [];
  const skipDirs = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache"]);

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await listFilesRecursive(fullPath, maxDepth - 1);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory might not be readable
  }

  return files;
}
