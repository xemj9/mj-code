import path from "node:path";

import { evaluateToolPermission } from "./permissions.mjs";
import { isSubPath, resolveUserPath } from "./path-utils.mjs";

import type {
  ExecutionBoundaryDecision,
  ExecutionBoundaryDecisionSummary,
  ExecutionBoundaryEnvPolicy,
  ExecutionBoundaryMode,
  ExecutionBoundaryShellPolicy,
  PermissionDecision,
  ShellCommandClassification,
  ShellCommandMatch,
  ToolMetadata,
} from "../types/contracts.js";

const SUPPORTED_BOUNDARY_MODES = new Set<ExecutionBoundaryMode>(["off", "workspace", "strict-policy"]);
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
];

const BLOCKED_SHELL_PATTERNS = [
  { id: "sudo", pattern: /\bsudo\b/i, reason: "Command requests elevated privileges." },
  { id: "rm_rf", pattern: /\brm\s+-rf\b/i, reason: "Command matches a destructive delete pattern." },
  { id: "git_reset_hard", pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Command resets git state destructively." },
  { id: "git_clean_fdx", pattern: /\bgit\s+clean\s+-fdx\b/i, reason: "Command removes untracked files destructively." },
  { id: "mkfs", pattern: /\bmkfs(?:\.[^\s]+)?\b/i, reason: "Command formats a filesystem." },
  { id: "dd_raw", pattern: /\bdd\s+if=/i, reason: "Command writes raw disk-style streams." },
  { id: "shutdown", pattern: /\b(?:shutdown|reboot|halt)\b/i, reason: "Command controls machine power state." },
];

const APPROVAL_SHELL_PATTERNS = [
  { id: "chmod", pattern: /\bchmod\b/i, reason: "Command changes permissions." },
  { id: "chown", pattern: /\bchown\b/i, reason: "Command changes file ownership." },
  { id: "kill", pattern: /\b(?:kill|pkill|killall)\b/i, reason: "Command controls other processes." },
  { id: "git_checkout", pattern: /\bgit\s+checkout\b/i, reason: "Command can replace workspace contents." },
];

const NETWORK_SHELL_PATTERNS = [
  { id: "curl", pattern: /\bcurl\b/i },
  { id: "wget", pattern: /\bwget\b/i },
  { id: "ssh", pattern: /\bssh\b/i },
  { id: "scp", pattern: /\bscp\b/i },
  { id: "sftp", pattern: /\bsftp\b/i },
  { id: "ftp", pattern: /\bftp\b/i },
  { id: "nc", pattern: /\bnc\b/i },
  { id: "telnet", pattern: /\btelnet\b/i },
  { id: "git_network", pattern: /\bgit\s+(?:clone|fetch|pull)\b/i },
  { id: "npm_install", pattern: /\bnpm\s+(?:install|add)\b/i },
  { id: "pnpm_install", pattern: /\bpnpm\s+(?:install|add)\b/i },
  { id: "yarn_add", pattern: /\byarn\s+add\b/i },
];

interface ExecutionBoundaryConfig {
  cwd: string;
  permissionMode: "read-only" | "workspace-write" | "full-access";
  approvalPolicy: "always" | "on-write" | "never";
  networkMode: "off" | "docs-only" | "open-web";
  webProvider?: string;
  webAllowDomains?: string[];
  webDenyDomains?: string[];
  shellTimeoutMs: number;
  hookTimeoutMs: number;
  executionBoundaryMode?: string | null;
  executionEnvAllowlist?: string[] | string | null;
}

type BoundaryToolMeta = ToolMetadata;

interface EvaluateToolInput {
  toolName: string;
  toolMeta?: BoundaryToolMeta | null;
  input?: Record<string, unknown>;
  traceId?: string | null;
  step?: string | number | null;
}

interface HookDefinitionLike {
  id: string;
  event: string;
  enabled?: boolean;
  command: string;
  args?: string[];
  cwd?: string | null;
  timeoutMs?: number | null;
  failMode?: string | null;
  filters?: unknown;
}

interface EvaluateHookInput {
  hook: HookDefinitionLike;
  payload: Record<string, unknown>;
  traceId?: string | null;
  step?: string | number | null;
}

interface PluginBoundaryPolicy {
  blockedReason: string | null;
  forceApproval: boolean;
  degradedReasons: string[];
}

interface McpBoundaryPolicy extends PluginBoundaryPolicy {}

interface ShellBoundaryDecision {
  cwd: string;
  timeoutMs: number;
  passThroughEnv: Record<string, string | undefined>;
  envPolicy: ExecutionBoundaryEnvPolicy;
  shellPolicy: ExecutionBoundaryShellPolicy;
  degradedReasons: string[];
  blockedReason: string | null;
  forceApproval: boolean;
}

interface FinalizeBoundaryDecisionInput {
  subjectType: string;
  subjectId: string;
  traceId?: string | null;
  step?: string | number | null;
  toolName: string | null;
  toolSource: string;
  boundaryMode: ExecutionBoundaryMode;
  permissionDecision: PermissionDecision;
  effectiveInput: unknown;
  shellPolicy?: ExecutionBoundaryShellPolicy | null;
  envPolicy?: ExecutionBoundaryEnvPolicy | null;
  reasons?: string[];
  degradedReasons?: string[];
  meta?: Record<string, unknown> | null;
}

export class ExecutionBoundary {
  readonly config: ExecutionBoundaryConfig;
  readonly mode: ExecutionBoundaryMode;
  readonly envAllowlist: string[];

  constructor(config: ExecutionBoundaryConfig) {
    this.config = config;
    this.mode = normalizeExecutionBoundaryMode(config.executionBoundaryMode);
    this.envAllowlist = normalizeEnvAllowlist(config.executionEnvAllowlist);
  }

  getSummary(): {
    mode: ExecutionBoundaryMode;
    networkMode: string;
    envPolicy: "passthrough" | "allowlist";
    envAllowlist: string[];
    policyOnly: true;
    cwdBoundary: boolean;
  } {
    return {
      mode: this.mode,
      networkMode: this.config.networkMode,
      envPolicy: this.mode === "off" ? "passthrough" : "allowlist",
      envAllowlist: [...this.envAllowlist],
      policyOnly: true,
      cwdBoundary: this.mode !== "off",
    };
  }

  evaluateTool({ toolName, toolMeta = null, input = {}, traceId = null, step = null }: EvaluateToolInput): ExecutionBoundaryDecision {
    const toolSource = toolMeta?.source ?? "local";
    let permissionDecision = evaluateToolPermission({
      toolName,
      toolSource,
      toolMeta,
      input,
      permissionMode: this.config.permissionMode,
      approvalPolicy: this.config.approvalPolicy,
      workspaceRoot: this.config.cwd,
      networkMode: this.config.networkMode,
      webProvider: this.config.webProvider,
      webAllowDomains: this.config.webAllowDomains,
      webDenyDomains: this.config.webDenyDomains,
    });

    let effectiveInput: Record<string, unknown> = cloneInput(input);
    const reasons = [];
    const degradedReasons = [];
    let envPolicy: ExecutionBoundaryEnvPolicy | null = null;
    let shellPolicy: ExecutionBoundaryShellPolicy | null = null;

    if (toolName === "run_shell") {
      const shellDecision = evaluateShellBoundary({
        command: typeof input.command === "string" ? input.command : null,
        args: Array.isArray(input.args) ? input.args : [],
        cwd: typeof input.cwd === "string" ? input.cwd : null,
        env: isPlainObject(input.env) ? input.env : null,
        timeoutMs: toNumberOrNull(input.timeoutMs),
        pty: Boolean(input.pty),
        shell: typeof input.shell === "string" ? input.shell : null,
        boundaryMode: this.mode,
        permissionMode: this.config.permissionMode,
        networkMode: this.config.networkMode,
        workspaceRoot: this.config.cwd,
        defaultTimeoutMs: this.config.shellTimeoutMs,
        envAllowlist: this.envAllowlist,
        spawnMode: "shell",
      });

      envPolicy = shellDecision.envPolicy;
      shellPolicy = shellDecision.shellPolicy;
      effectiveInput = {
        ...effectiveInput,
        cwd: shellDecision.cwd,
        timeoutMs: shellDecision.timeoutMs,
        env: shellDecision.passThroughEnv,
        spawnMode: "shell",
      };

      if (shellDecision.blockedReason) {
        permissionDecision = {
          ...permissionDecision,
          allowed: false,
          requiresApproval: false,
          reason: shellDecision.blockedReason,
        };
      }
      if (shellDecision.forceApproval) {
        permissionDecision = {
          ...permissionDecision,
          requiresApproval: true,
        };
      }
      degradedReasons.push(...shellDecision.degradedReasons);
    }

    if (toolSource === "plugin") {
      const pluginPolicy = evaluatePluginBoundary({
        toolName,
        toolMeta,
        boundaryMode: this.mode,
        networkMode: this.config.networkMode,
      });
      if (pluginPolicy.blockedReason) {
        permissionDecision = {
          ...permissionDecision,
          allowed: false,
          requiresApproval: false,
          reason: pluginPolicy.blockedReason,
        };
      }
      if (pluginPolicy.forceApproval) {
        permissionDecision = {
          ...permissionDecision,
          requiresApproval: true,
        };
      }
      degradedReasons.push(...pluginPolicy.degradedReasons);
    }

    if (toolSource === "mcp") {
      const mcpPolicy = evaluateMcpBoundary({
        toolName,
        toolMeta,
        boundaryMode: this.mode,
        networkMode: this.config.networkMode,
      });
      if (mcpPolicy.blockedReason) {
        permissionDecision = {
          ...permissionDecision,
          allowed: false,
          requiresApproval: false,
          reason: mcpPolicy.blockedReason,
        };
      }
      if (mcpPolicy.forceApproval) {
        permissionDecision = {
          ...permissionDecision,
          requiresApproval: true,
        };
      }
      degradedReasons.push(...mcpPolicy.degradedReasons);
    }

    if (permissionDecision.allowed === false && permissionDecision.reason) {
      reasons.push(permissionDecision.reason);
    }

    return finalizeBoundaryDecision({
      subjectType: "tool",
      subjectId: toolName,
      traceId,
      step,
      toolName,
      toolSource,
      boundaryMode: this.mode,
      permissionDecision,
      effectiveInput,
      shellPolicy,
      envPolicy,
      reasons,
      degradedReasons,
    });
  }

  evaluateHook({ hook, payload, traceId = null, step = null }: EvaluateHookInput): ExecutionBoundaryDecision {
    const shellDecision = evaluateShellBoundary({
      command: hook.command,
      args: hook.args,
      cwd: hook.cwd,
      timeoutMs: hook.timeoutMs,
      boundaryMode: this.mode,
      permissionMode: this.config.permissionMode,
      networkMode: this.config.networkMode,
      workspaceRoot: this.config.cwd,
      defaultTimeoutMs: this.config.hookTimeoutMs,
      envAllowlist: this.envAllowlist,
      spawnMode: "exec",
      extraEnv: buildHookEnvironment(hook, payload),
      allowInWorkspaceWrite: true,
    });

    let allowed = true;
    let reason = null;
    const reasons = [];
    if (this.config.permissionMode === "read-only") {
      allowed = false;
      reason = `Hook "${hook.id}" is blocked in read-only mode.`;
      reasons.push(reason);
    }
    if (shellDecision.blockedReason) {
      allowed = false;
      reason = shellDecision.blockedReason;
      reasons.push(reason);
    }

    return finalizeBoundaryDecision({
      subjectType: "hook",
      subjectId: hook.id,
      traceId,
      step,
      toolName: hook.command,
      toolSource: "hook",
      boundaryMode: this.mode,
      permissionDecision: {
        allowed,
        requiresApproval: false,
        reason,
        category: "hook",
        targetPaths: shellDecision.cwd ? [shellDecision.cwd] : [],
        targetDomains: [],
      },
      effectiveInput: {
        command: hook.command,
        args: hook.args,
        cwd: shellDecision.cwd,
        timeoutMs: shellDecision.timeoutMs,
        env: shellDecision.passThroughEnv,
        stdinText: JSON.stringify(payload, null, 2),
        spawnMode: "exec",
        stream: false,
        background: false,
        pty: false,
        sourceKind: "hook",
      },
      shellPolicy: shellDecision.shellPolicy,
      envPolicy: shellDecision.envPolicy,
      reasons,
      degradedReasons: shellDecision.degradedReasons,
      meta: {
        hookId: hook.id,
        hookEvent: hook.event,
        failMode: hook.failMode,
        filterSummary: hook.filters,
      },
    });
  }
}

export function normalizeExecutionBoundaryMode(
  value: unknown,
  fallback: ExecutionBoundaryMode = "workspace",
): ExecutionBoundaryMode {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return SUPPORTED_BOUNDARY_MODES.has(normalized as ExecutionBoundaryMode)
    ? normalized as ExecutionBoundaryMode
    : fallback;
}

export function normalizeEnvAllowlist(values: string[] | string | null | undefined): string[] {
  const normalized = new Set(DEFAULT_ENV_ALLOWLIST);
  for (const value of Array.isArray(values) ? values : typeof values === "string" ? values.split(",") : []) {
    const key = `${value ?? ""}`.trim();
    if (key) {
      normalized.add(key);
    }
  }
  return [...normalized].sort();
}

export function classifyShellCommand(
  command: unknown,
  args: unknown[] = [],
  spawnMode = "shell",
): ShellCommandClassification {
  const rendered = renderCommand(command, args, spawnMode);
  const blockedMatches: ShellCommandMatch[] = BLOCKED_SHELL_PATTERNS
    .filter((entry) => entry.pattern.test(rendered))
    .map((entry) => ({ id: entry.id, reason: entry.reason }));
  const approvalMatches: ShellCommandMatch[] = APPROVAL_SHELL_PATTERNS
    .filter((entry) => entry.pattern.test(rendered))
    .map((entry) => ({ id: entry.id, reason: entry.reason }));
  const networkMatches = NETWORK_SHELL_PATTERNS
    .filter((entry) => entry.pattern.test(rendered))
    .map((entry) => entry.id);

  return {
    summary: rendered,
    spawnMode,
    blockedMatches,
    approvalMatches,
    networkMatches,
    destructive: blockedMatches.length > 0,
    highRisk: blockedMatches.length > 0 || approvalMatches.length > 0,
    networkAccess: networkMatches.length > 0,
  };
}

function evaluateShellBoundary({
  command,
  args = [],
  cwd,
  env = null,
  timeoutMs,
  pty = false,
  shell = null,
  boundaryMode,
  permissionMode,
  networkMode,
  workspaceRoot,
  defaultTimeoutMs,
  envAllowlist,
  spawnMode = "shell",
  extraEnv = null,
  allowInWorkspaceWrite = false,
}: {
  command: string | null | undefined;
  args?: unknown[];
  cwd?: string | null;
  env?: Record<string, unknown> | null;
  timeoutMs?: number | null;
  pty?: boolean;
  shell?: string | null;
  boundaryMode: ExecutionBoundaryMode;
  permissionMode: ExecutionBoundaryConfig["permissionMode"];
  networkMode: ExecutionBoundaryConfig["networkMode"];
  workspaceRoot: string;
  defaultTimeoutMs: number;
  envAllowlist: string[];
  spawnMode?: string;
  extraEnv?: Record<string, unknown> | null;
  allowInWorkspaceWrite?: boolean;
}): ShellBoundaryDecision {
  const rendered = renderCommand(command, args, spawnMode);
  const classification = classifyShellCommand(command, args, spawnMode);
  const effectiveCwd = cwd ? resolveUserPath(cwd, workspaceRoot) : workspaceRoot;
  const resolvedTimeoutMs = clampTimeout(timeoutMs, defaultTimeoutMs);
  const envPolicy = buildEnvPolicy({
    baseEnv: env ?? process.env,
    extraEnv,
    boundaryMode,
    envAllowlist,
    cwd: effectiveCwd,
  });
  const degradedReasons = [];
  let blockedReason = null;
  let forceApproval = false;

  if (!allowInWorkspaceWrite && permissionMode === "workspace-write") {
    // In workspace-write mode, allow safe read-only commands and safe
    // workspace-modifying commands (mkdir, touch, cp, mv within workspace).
    // Dangerous commands that could modify the system still require full-access.
    const isReadOnlyCommand = looksLikeReadOnlyShellCommand(rendered);
    const isSafeWriteCommand = looksLikeSafeWriteShellCommand(rendered, workspaceRoot);
    if (!isReadOnlyCommand && !isSafeWriteCommand) {
      blockedReason = 'Shell execution requires full-access mode for this command. Read-only commands like ls, cat, git status and safe write commands like mkdir, touch are allowed in workspace-write mode.';
    } else {
      // Even safe commands in workspace-write mode need approval if high-risk
      forceApproval = classification.highRisk;
    }
  }

  if (!blockedReason && boundaryMode !== "off" && !isSubPath(workspaceRoot, effectiveCwd)) {
    blockedReason = `Execution cwd "${effectiveCwd}" is outside the workspace boundary.`;
  }

  if (!blockedReason && classification.networkAccess && networkMode !== "open-web") {
    blockedReason = `Execution boundary blocked network-capable shell execution while network mode is "${networkMode}".`;
  }

  if (!blockedReason && classification.destructive && boundaryMode !== "off") {
    blockedReason = classification.blockedMatches[0]?.reason ?? "Execution boundary blocked a destructive shell command.";
  }

  if (!blockedReason && classification.highRisk) {
    forceApproval = true;
  }

  if (spawnMode === "exec" && pty) {
    degradedReasons.push("PTY is not available for direct exec-mode launches.");
  }
  if (boundaryMode !== "off" && envPolicy.mode === "allowlist" && envPolicy.droppedKeys.length > 0) {
    degradedReasons.push("Execution environment was reduced to the configured allowlist.");
  }
  if (boundaryMode === "off") {
    degradedReasons.push("Execution boundary is in passthrough mode for shell environment restrictions.");
  }

  return {
    cwd: effectiveCwd,
    timeoutMs: resolvedTimeoutMs,
    passThroughEnv: envPolicy.passThroughEnv,
    envPolicy,
    shellPolicy: {
      shell,
      renderedCommand: rendered,
      classification,
      ptyRequested: Boolean(pty),
      networkMode,
      blockedReason,
      forceApproval,
    },
    degradedReasons,
    blockedReason,
    forceApproval,
  };
}

/**
 * Heuristic to determine if a shell command is a safe write operation
 * (mkdir, touch, cp, mv) that is allowed in workspace-write mode.
 * These commands modify the filesystem but are low-risk enough to
 * allow with user approval rather than hard-blocking.
 */
function looksLikeSafeWriteShellCommand(renderedCommand: string, workspaceRoot: string): boolean {
  const trimmed = renderedCommand.trim();

  const safeWritePrefixes = [
    /^mkdir\b/i,
    /^touch\b/i,
    /^cp\b/i,
    /^mv\b/i,
    /^ln\s+-s\b/i,
    /^tee\b/i,
  ];

  for (const pattern of safeWritePrefixes) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Heuristic to determine if a shell command is likely read-only
 * and safe to execute in workspace-write permission mode.
 */
function looksLikeReadOnlyShellCommand(renderedCommand: string): boolean {
  const trimmed = renderedCommand.trim();

  // Safe read-only command prefixes (single commands or pipelines starting with these)
  const readOnlyPrefixes = [
    /^ls\b/i,
    /^cat\b/i,
    /^head\b/i,
    /^tail\b/i,
    /^less\b/i,
    /^more\b/i,
    /^file\b/i,
    /^wc\b/i,
    /^wc\b/i,
    /^which\b/i,
    /^where\b/i,
    /^whoami\b/i,
    /^pwd\b/i,
    /^echo\b/i,
    /^printenv\b/i,
    /^env\b/i,
    /^type\b/i,
    /^command\s+-v\b/i,
    /^git\s+status\b/i,
    /^git\s+log\b/i,
    /^git\s+diff\b/i,
    /^git\s+branch\b/i,
    /^git\s+remote\s+-v\b/i,
    /^git\s+show\b/i,
    /^git\s+describe\b/i,
    /^git\s+rev-parse\b/i,
    /^git\s+config\b/i,
    /^git\s+stash\s+list\b/i,
    /^git\s+tag\s+-l\b/i,
    /^node\s+-v\b/i,
    /^node\s+--version\b/i,
    /^npm\s+-v\b/i,
    /^npm\s+--version\b/i,
    /^npm\s+list\b/i,
    /^npm\s+ls\b/i,
    /^python\d*\s+--version\b/i,
    /^python\d*\s+-V\b/i,
    /^pip\d*\s+list\b/i,
    /^pip\d*\s+show\b/i,
    /^java\s+-version\b/i,
    /^go\s+version\b/i,
    /^rustc\s+--version\b/i,
    /^cargo\s+--version\b/i,
    /^make\s+--version\b/i,
    /^cmake\s+--version\b/i,
    /^docker\s+--version\b/i,
    /^docker\s+ps\b/i,
    /^docker\s+images\b/i,
    /^uname\b/i,
    /^date\b/i,
    /^hostname\b/i,
    /^df\b/i,
    /^du\b/i,
    /^find\b/i,
    /^grep\b/i,
    /^rg\b/i,
    /^ag\b/i,
    /^ack\b/i,
    /^sort\b/i,
    /^uniq\b/i,
    /^awk\b/i,
    /^sed\s+-n\b/i,
    /^test\b/i,
    /^\[\s+/,
    /^diff\b/i,
    /^patch\s+--dry-run\b/i,
    /^stat\b/i,
    /^xargs\s+ls\b/i,
    /^xargs\s+cat\b/i,
    /^xargs\s+file\b/i,
    /^basename\b/i,
    /^dirname\b/i,
    /^realpath\b/i,
    /^readlink\b/i,
    /^tree\b/i,
    /^gh\s+repo\s+view\b/i,
    /^gh\s+pr\s+list\b/i,
    /^gh\s+issue\s+list\b/i,
  ];

  for (const pattern of readOnlyPrefixes) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Pipelines where every segment starts with a read-only command
  if (trimmed.includes("|")) {
    const segments = trimmed.split("|").map((s) => s.trim());
    if (segments.length > 1 && segments.every((segment) => {
      return looksLikeReadOnlyShellCommand(segment);
    })) {
      return true;
    }
  }

  // Command substitution in echo: echo $(ls), echo `git rev-parse HEAD`
  if (/^echo\s+/.test(trimmed) && !trimmed.includes(">") && !trimmed.includes(">>")) {
    return true;
  }

  return false;
}

function evaluatePluginBoundary({
  toolName,
  toolMeta,
  boundaryMode,
  networkMode,
}: {
  toolName: string;
  toolMeta: BoundaryToolMeta | null | undefined;
  boundaryMode: ExecutionBoundaryMode;
  networkMode: ExecutionBoundaryConfig["networkMode"];
}): PluginBoundaryPolicy {
  const riskCategory = toolMeta?.riskCategory ?? "external";
  const degradedReasons = [
    "Plugin execution is policy-only; locally loaded code is not OS-isolated.",
  ];

  if (networkMode !== "open-web" && ["network", "external"].includes(riskCategory)) {
    return {
      blockedReason: `Plugin tool "${toolName}" is blocked because network mode "${networkMode}" cannot safely constrain plugin network behavior.`,
      forceApproval: false,
      degradedReasons,
    };
  }

  if (boundaryMode === "strict-policy" && ["exec", "external"].includes(riskCategory)) {
    return {
      blockedReason: `Strict execution boundary blocks plugin tool "${toolName}" with risk category "${riskCategory}".`,
      forceApproval: false,
      degradedReasons,
    };
  }

  return {
    blockedReason: null,
    forceApproval: ["write", "exec", "network", "external"].includes(riskCategory),
    degradedReasons,
  };
}

function evaluateMcpBoundary({
  toolName,
  toolMeta,
  boundaryMode,
  networkMode,
}: {
  toolName: string;
  toolMeta: BoundaryToolMeta | null | undefined;
  boundaryMode: ExecutionBoundaryMode;
  networkMode: ExecutionBoundaryConfig["networkMode"];
}): McpBoundaryPolicy {
  const annotations = toolMeta?.annotations ?? {};
  const degradedReasons = [
    "MCP execution is policy-only; server annotations are advisory rather than enforced isolation.",
  ];

  if (networkMode !== "open-web" && annotations.openWorldHint === true) {
    return {
      blockedReason: `MCP tool "${toolName}" is blocked because its server advertises open-world behavior while network mode is "${networkMode}".`,
      forceApproval: false,
      degradedReasons,
    };
  }

  if (boundaryMode === "strict-policy" && annotations.readOnlyHint !== true) {
    return {
      blockedReason: `Strict execution boundary requires readOnlyHint for MCP tool "${toolName}".`,
      forceApproval: false,
      degradedReasons,
    };
  }

  return {
    blockedReason: null,
    forceApproval: annotations.destructiveHint === true,
    degradedReasons,
  };
}

function finalizeBoundaryDecision({
  subjectType,
  subjectId,
  traceId,
  step,
  toolName,
  toolSource,
  boundaryMode,
  permissionDecision,
  effectiveInput,
  shellPolicy = null,
  envPolicy = null,
  reasons = [],
  degradedReasons = [],
  meta = null,
}: FinalizeBoundaryDecisionInput): ExecutionBoundaryDecision {
  const blocked = permissionDecision.allowed === false;
  const status = blocked
    ? "blocked"
    : degradedReasons.length > 0
      ? "degraded"
      : boundaryMode === "off"
        ? "passthrough"
        : "allowed";

  return {
    subjectType,
    subjectId,
    toolName,
    toolSource,
    status,
    blocked,
    degraded: degradedReasons.length > 0,
    boundaryMode,
    permissionDecision,
    requiresApproval: permissionDecision.requiresApproval,
    effectiveInput,
    reasons: uniqueStrings([
      ...reasons,
      permissionDecision.reason,
    ]),
    degradedReasons: uniqueStrings(degradedReasons),
    shellPolicy,
    envPolicy,
    meta,
    event: {
      type: "execution_boundary_decision",
      traceId,
      step,
      subjectType,
      subjectId,
      toolName,
      toolSource,
      status,
      blocked,
      boundaryMode,
      category: permissionDecision.category ?? null,
      requiresApproval: Boolean(permissionDecision.requiresApproval),
      reason: permissionDecision.reason ?? null,
      reasons: uniqueStrings([
        ...reasons,
        permissionDecision.reason,
      ]),
      degradedReasons: uniqueStrings(degradedReasons),
      targetPaths: permissionDecision.targetPaths ?? [],
      targetDomains: permissionDecision.targetDomains ?? [],
      envPolicy: envPolicy
        ? {
            mode: envPolicy.mode,
            passedKeys: envPolicy.passedKeys,
            droppedKeys: envPolicy.droppedKeys,
            redactedKeys: envPolicy.redactedKeys,
          }
        : null,
      shellPolicy: shellPolicy
        ? {
            renderedCommand: shellPolicy.renderedCommand,
            classification: shellPolicy.classification,
            ptyRequested: shellPolicy.ptyRequested,
            networkMode: shellPolicy.networkMode,
          }
        : null,
      meta,
    },
  };
}

function buildEnvPolicy({
  baseEnv,
  extraEnv = null,
  boundaryMode,
  envAllowlist,
  cwd,
}: {
  baseEnv: NodeJS.ProcessEnv | Record<string, unknown> | null | undefined;
  extraEnv?: Record<string, unknown> | null;
  boundaryMode: ExecutionBoundaryMode;
  envAllowlist: string[];
  cwd: string;
}): ExecutionBoundaryEnvPolicy {
  const sourceEnv = isPlainObject(baseEnv) ? baseEnv : {};
  const injectedEnv = isPlainObject(extraEnv) ? extraEnv : {};

  if (boundaryMode === "off") {
    const passThroughEnv: Record<string, string | undefined> = {
      ...sourceEnv,
      ...injectedEnv,
      PWD: cwd,
    };
    return {
      mode: "passthrough",
      passThroughEnv,
      passedKeys: Object.keys(passThroughEnv).sort(),
      droppedKeys: [],
      redactedKeys: Object.keys(passThroughEnv).filter(isSensitiveEnvKey).sort(),
    };
  }

  const allowed = new Set(envAllowlist);
  const passThroughEnv: Record<string, string | undefined> = {};
  const passedKeys = [];
  const droppedKeys = [];
  const redactedKeys = [];

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (allowed.has(key)) {
      passThroughEnv[key] = value;
      passedKeys.push(key);
    } else {
      droppedKeys.push(key);
      if (isSensitiveEnvKey(key)) {
        redactedKeys.push(key);
      }
    }
  }

  for (const [key, value] of Object.entries(injectedEnv)) {
    passThroughEnv[key] = value;
    if (!passedKeys.includes(key)) {
      passedKeys.push(key);
    }
  }

  passThroughEnv.PWD = cwd;
  if (!passedKeys.includes("PWD")) {
    passedKeys.push("PWD");
  }

  return {
    mode: "allowlist",
    passThroughEnv,
    passedKeys: passedKeys.sort(),
    droppedKeys: droppedKeys.sort(),
    redactedKeys: uniqueStrings(redactedKeys),
  };
}

function buildHookEnvironment(hook: HookDefinitionLike, payload: Record<string, unknown>): Record<string, string> {
  return {
    MJ_CODE_HOOK_EVENT: hook.event,
    MJ_CODE_HOOK_ID: hook.id,
    MJ_CODE_HOOK_FAIL_MODE: `${hook.failMode ?? ""}`,
    MJ_CODE_SESSION_ID: `${payload.sessionId ?? ""}`,
    MJ_CODE_TRACE_ID: `${payload.traceId ?? ""}`,
    MJ_CODE_TOOL_NAME: `${payload.toolName ?? ""}`,
  };
}

function clampTimeout(value: number | null | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(parsed, fallback);
  }
  return fallback;
}

function renderCommand(command: unknown, args: unknown[] = [], spawnMode = "shell"): string {
  const base = `${command ?? ""}`.trim();
  if (!base) {
    return "";
  }
  if (spawnMode !== "exec") {
    return base;
  }
  const renderedArgs = (Array.isArray(args) ? args : [])
    .map((entry) => `${entry ?? ""}`.trim())
    .filter(Boolean)
    .join(" ");
  return renderedArgs ? `${base} ${renderedArgs}` : base;
}

function cloneInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    return {};
  }
  return structuredClone(input);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set((values ?? []).filter(Boolean) as string[])];
}

function isPlainObject(value: unknown): value is Record<string, string | undefined> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveEnvKey(key: string): boolean {
  return /(token|secret|password|api[_-]?key|auth)/i.test(key);
}

export function summarizeBoundaryDecision(
  decision: ExecutionBoundaryDecision | null | undefined,
): ExecutionBoundaryDecisionSummary | null {
  if (!decision) {
    return null;
  }
  return {
    subjectType: decision.subjectType,
    subjectId: decision.subjectId,
    toolName: decision.toolName,
    toolSource: decision.toolSource,
    status: decision.status,
    blocked: decision.blocked,
    degraded: decision.degraded,
    boundaryMode: decision.boundaryMode,
    requiresApproval: decision.requiresApproval,
    reasons: decision.reasons,
    degradedReasons: decision.degradedReasons,
    shellPolicy: decision.shellPolicy
      ? {
          renderedCommand: decision.shellPolicy.renderedCommand,
          classification: decision.shellPolicy.classification,
          ptyRequested: decision.shellPolicy.ptyRequested,
        }
      : null,
    envPolicy: decision.envPolicy
      ? {
          mode: decision.envPolicy.mode,
          passedKeys: decision.envPolicy.passedKeys,
          droppedKeys: decision.envPolicy.droppedKeys,
          redactedKeys: decision.envPolicy.redactedKeys,
        }
      : null,
    meta: decision.meta ?? null,
  };
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
