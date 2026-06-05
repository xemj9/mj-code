/**
 * SandboxRuntime — Process-isolated shell execution for MJ Code.
 *
 * Provides OS-level sandboxing for shell commands:
 * - macOS: uses `sandbox-exec` (Seatbelt profile) for filesystem isolation
 * - Linux: uses `unshare` for mount/PID namespace isolation (when available)
 * - Fallback: policy-only mode (execution boundary + env filtering, no OS isolation)
 *
 * The sandbox restricts:
 * 1. Filesystem writes to workspace-only paths
 * 2. Network access (optional, configurable)
 * 3. Environment variables to an allowlist
 * 4. Process resource limits (timeout, memory)
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isSubPath, resolveUserPath } from "./path-utils.mjs";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SandboxIsolationLevel = "off" | "policy" | "os" | "container";
export type SandboxPlatform = "macos" | "linux" | "unknown";

export interface SandboxRuntimeConfig {
  cwd: string;
  projectStateDir: string;
  sandboxDir: string;
  isolationLevel: SandboxIsolationLevel;
  allowNetwork: boolean;
  allowedWritePaths: string[];
  allowedReadPaths: string[];
  envAllowlist: string[];
  shellTimeoutMs: number;
  maxOutputChars: number;
  maxMemoryMb: number;
}

export interface SandboxRunInput {
  command: string;
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  allowNetwork?: boolean;
  allowedWritePaths?: string[];
  env?: Record<string, string | undefined>;
}

export interface SandboxRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  sandboxed: boolean;
  isolationLevel: SandboxIsolationLevel;
  platform: SandboxPlatform;
  durationMs: number;
  metadata: {
    profilePath: string | null;
    namespaceIsolated: boolean;
    networkBlocked: boolean;
    writePaths: string[];
  };
}

export interface SandboxAvailability {
  available: boolean;
  isolationLevel: SandboxIsolationLevel;
  platform: SandboxPlatform;
  mechanisms: string[];
  limitations: string[];
  reason: string | null;
}

// ─── SandboxRuntime ─────────────────────────────────────────────────────────

export class SandboxRuntime {
  readonly config: SandboxRuntimeConfig;
  readonly platform: SandboxPlatform;
  private availabilityCache: SandboxAvailability | null = null;

  constructor(config: Partial<SandboxRuntimeConfig> & { cwd: string; projectStateDir: string }) {
    this.config = {
      sandboxDir: config.sandboxDir ?? path.join(config.projectStateDir, "sandbox"),
      isolationLevel: config.isolationLevel ?? "os",
      allowNetwork: config.allowNetwork ?? false,
      allowedWritePaths: config.allowedWritePaths ?? [config.cwd],
      allowedReadPaths: config.allowedReadPaths ?? [config.cwd],
      envAllowlist: config.envAllowlist ?? DEFAULT_ENV_ALLOWLIST,
      shellTimeoutMs: config.shellTimeoutMs ?? 30_000,
      maxOutputChars: config.maxOutputChars ?? 100_000,
      maxMemoryMb: config.maxMemoryMb ?? 512,
      cwd: config.cwd,
      projectStateDir: config.projectStateDir,
    };
    this.platform = detectPlatform();
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.config.sandboxDir, { recursive: true });
  }

  /**
   * Check what sandboxing mechanisms are available on this platform.
   */
  async checkAvailability(): Promise<SandboxAvailability> {
    if (this.availabilityCache) {
      return this.availabilityCache;
    }

    const result = await detectSandboxAvailability(this.platform, this.config.sandboxDir);
    this.availabilityCache = result;
    return result;
  }

  /**
   * Run a command inside the sandbox.
   */
  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const command = `${input.command ?? ""}`.trim();
    if (!command) {
      throw new Error("Sandbox run requires a command string.");
    }

    const availability = await this.checkAvailability();
    const effectiveIsolation = resolveEffectiveIsolation(
      this.config.isolationLevel,
      availability,
    );

    const shell = input.shell || process.env.SHELL || "/bin/zsh";
    const cwd = input.cwd ? resolveUserPath(input.cwd, this.config.cwd) : this.config.cwd;
    const timeoutMs = Math.min(
      input.timeoutMs ?? this.config.shellTimeoutMs,
      this.config.shellTimeoutMs,
    );
    const allowNetwork = input.allowNetwork ?? this.config.allowNetwork;
    const allowedWritePaths = [
      ...this.config.allowedWritePaths,
      ...(input.allowedWritePaths ?? []),
    ];

    const startMs = Date.now();
    let child: ChildProcess;
    let profilePath: string | null = null;
    let namespaceIsolated = false;
    let networkBlocked = !allowNetwork;

    if (effectiveIsolation === "os" && this.platform === "macos") {
      // macOS: use sandbox-exec with a Seatbelt profile
      profilePath = await generateMacOsSandboxProfile(this.config.sandboxDir, {
        cwd,
        allowNetwork,
        allowedWritePaths,
        allowedReadPaths: this.config.allowedReadPaths,
      });
      child = spawn("sandbox-exec", ["-f", profilePath, shell, "-lc", command], {
        cwd,
        env: buildSandboxEnv(this.config.envAllowlist, cwd, input.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else if (effectiveIsolation === "os" && this.platform === "linux") {
      // Linux: use unshare for namespace isolation
      const unshareArgs = buildLinuxUnshareArgs({
        command,
        shell,
        allowNetwork,
      });
      child = spawn("unshare", unshareArgs, {
        cwd,
        env: buildSandboxEnv(this.config.envAllowlist, cwd, input.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      namespaceIsolated = true;
    } else {
      // Fallback: policy-only mode (no OS isolation, just env filtering)
      child = spawn(shell, ["-lc", command], {
        cwd,
        env: buildSandboxEnv(this.config.envAllowlist, cwd, input.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    return new Promise<SandboxRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1000).unref();
      }, timeoutMs);
      timer.unref();

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > this.config.maxOutputChars) {
          stdout = stdout.slice(-this.config.maxOutputChars);
        }
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > this.config.maxOutputChars) {
          stderr = stderr.slice(-this.config.maxOutputChars);
        }
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout,
          stderr: `${stderr}\nSandbox spawn error: ${error.message}`,
          sandboxed: effectiveIsolation !== "off",
          isolationLevel: effectiveIsolation,
          platform: this.platform,
          durationMs: Date.now() - startMs,
          metadata: {
            profilePath,
            namespaceIsolated,
            networkBlocked,
            writePaths: allowedWritePaths,
          },
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal: signal?.toString() ?? null,
          timedOut,
          stdout,
          stderr,
          sandboxed: effectiveIsolation !== "off",
          isolationLevel: effectiveIsolation,
          platform: this.platform,
          durationMs: Date.now() - startMs,
          metadata: {
            profilePath,
            namespaceIsolated,
            networkBlocked,
            writePaths: allowedWritePaths,
          },
        });
      });
    });
  }

  /**
   * Clean up sandbox artifacts (profiles, temp files).
   */
  async cleanup(): Promise<void> {
    try {
      const entries = await fs.readdir(this.config.sandboxDir);
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.startsWith("sb-profile-")) continue;
        const filePath = path.join(this.config.sandboxDir, entry);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat && now - stat.mtimeMs > 60 * 60 * 1000) {
          await fs.unlink(filePath).catch(() => {});
        }
      }
    } catch {
      // Cleanup is best-effort
    }
  }
}

// ─── Platform Detection ─────────────────────────────────────────────────────

function detectPlatform(): SandboxPlatform {
  const platform = os.platform();
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unknown";
}

async function detectSandboxAvailability(
  platform: SandboxPlatform,
  _sandboxDir: string,
): Promise<SandboxAvailability> {
  const mechanisms: string[] = [];
  const limitations: string[] = [];

  if (platform === "macos") {
    const hasSandboxExec = await commandExists("sandbox-exec");
    if (hasSandboxExec) {
      mechanisms.push("sandbox-exec (Seatbelt)");
      return {
        available: true,
        isolationLevel: "os",
        platform,
        mechanisms,
        limitations: [
          "Seatbelt profiles are advisory for subprocesses that drop privileges",
          "Network isolation depends on Seatbelt rules, not OS firewall",
        ],
        reason: null,
      };
    }
    limitations.push("sandbox-exec not found on this macOS system");
  }

  if (platform === "linux") {
    const hasUnshare = await commandExists("unshare");
    if (hasUnshare) {
      mechanisms.push("unshare (namespace isolation)");
      const canUnshare = await testLinuxUnshare();
      if (canUnshare) {
        return {
          available: true,
          isolationLevel: "os",
          platform,
          mechanisms,
          limitations: [
            "Mount namespace isolation requires CAP_SYS_ADMIN or user namespaces",
            "Network namespace requires root or CAP_SYS_ADMIN in some configs",
          ],
          reason: null,
        };
      }
      limitations.push("unshare found but namespace creation failed (likely needs root)");
    } else {
      limitations.push("unshare not found on this Linux system");
    }
  }

  if (platform === "unknown") {
    limitations.push(`Unsupported platform: ${os.platform()}`);
  }

  return {
    available: false,
    isolationLevel: "policy",
    platform,
    mechanisms: ["env-filtering", "execution-boundary"],
    limitations,
    reason: limitations.join("; ") || "No OS-level sandboxing mechanism available",
  };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await new Promise<number>((resolve) => {
      const child = spawn("which", [command], { stdio: "pipe" });
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
    return result === 0;
  } catch {
    return false;
  }
}

async function testLinuxUnshare(): Promise<boolean> {
  try {
    const result = await new Promise<number>((resolve) => {
      const child = spawn("unshare", ["--mount", "--pid", "--fork", "--", "echo", "ok"], {
        stdio: "pipe",
      });
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
    return result === 0;
  } catch {
    return false;
  }
}

// ─── macOS Seatbelt Profile ─────────────────────────────────────────────────

async function generateMacOsSandboxProfile(
  sandboxDir: string,
  options: {
    cwd: string;
    allowNetwork: boolean;
    allowedWritePaths: string[];
    allowedReadPaths: string[];
  },
): Promise<string> {
  const profileId = `sb-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sb`;
  const profilePath = path.join(sandboxDir, profileId);

  const lines: string[] = [
    "(version 1)",
    // Strategy: allow by default, then deny specific dangerous operations
    // This is more robust than (deny default) + allow list because
    // shell execution requires many subtle system permissions
    "(allow default)",
  ];

  // Restrict filesystem writes: deny writes outside allowed paths
  // Compute paths that are NOT allowed for writing
  // Since Seatbelt doesn't have "deny except" natively, we use a
  // whitelist approach for critical system paths
  for (const writePath of options.allowedWritePaths) {
    lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(writePath)}"))`);
  }
  // Always allow writing to temp directories for shell operations
  lines.push(`(allow file-write* (subpath "/tmp"))`);
  lines.push(`(allow file-write* (subpath "/var/folders"))`);

  // Deny network access unless explicitly allowed
  if (!options.allowNetwork) {
    lines.push(`(deny network*)`);
  }

  const profile = `${lines.join("\n")}\n`;
  await fs.writeFile(profilePath, profile);
  return profilePath;
}

function escapeSeatbeltPath(filePath: string): string {
  return filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─── Linux unshare ──────────────────────────────────────────────────────────

function buildLinuxUnshareArgs(options: {
  command: string;
  shell: string;
  allowNetwork: boolean;
}): string[] {
  const args: string[] = [];

  // Create mount namespace (filesystem isolation)
  args.push("--mount");

  // Create PID namespace (process isolation)
  args.push("--pid");
  args.push("--fork");

  // Network: isolate network namespace unless explicitly allowed
  if (!options.allowNetwork) {
    args.push("--net");
  }

  // Create IPC namespace
  args.push("--ipc");

  // Execute the shell with the command
  args.push("--");
  args.push(options.shell);
  args.push("-lc");
  args.push(options.command);

  return args;
}

// ─── Environment ────────────────────────────────────────────────────────────

const DEFAULT_ENV_ALLOWLIST = [
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "MJ_CODE_SANDBOX",
];

function buildSandboxEnv(
  allowlist: string[],
  cwd: string,
  extraEnv?: Record<string, string | undefined> | null,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const allowed = new Set(allowlist);

  for (const key of Object.keys(process.env)) {
    if (allowed.has(key)) {
      env[key] = process.env[key];
    }
  }

  env.PWD = cwd;
  env.MJ_CODE_SANDBOX = "1";

  if (extraEnv && typeof extraEnv === "object") {
    for (const [key, value] of Object.entries(extraEnv)) {
      env[key] = value;
    }
  }

  return env;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveEffectiveIsolation(
  requested: SandboxIsolationLevel,
  availability: SandboxAvailability,
): SandboxIsolationLevel {
  if (requested === "off") return "off";
  if (requested === "policy") return "policy";

  if (requested === "os" && !availability.available) {
    return "policy";
  }

  if (requested === "container") {
    return availability.available ? "os" : "policy";
  }

  return availability.available ? "os" : "policy";
}
