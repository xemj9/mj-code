import path from "node:path";
import type {
  ApprovalContext,
  ChangeSetFileSummary,
  ChangeSetSummary,
  PermissionDecision,
  RiskAssessment,
  RiskLevel,
} from "../types/contracts.js";

export function assessToolRisk({
  toolName,
  input,
  changeSet = null,
  permissionDecision = null,
  workspaceRoot,
}: {
  toolName: string;
  input?: Record<string, unknown> | null;
  changeSet?: ChangeSetSummary | null;
  permissionDecision?: PermissionDecision | null;
  workspaceRoot?: string;
}): RiskAssessment {
  if (toolName === "run_shell") {
    return assessShellRisk({ input, permissionDecision });
  }

  if (permissionDecision?.category === "mcp") {
    return assessMcpRisk({ toolName, permissionDecision });
  }

  if (permissionDecision?.category === "plugin") {
    return assessPluginRisk({ toolName, permissionDecision });
  }

  if (["web_search", "fetch_url", "extract_content"].includes(toolName)) {
    return assessNetworkRisk({ toolName, input, permissionDecision });
  }

  if (changeSet) {
    return assessChangeSetRisk({ toolName, changeSet });
  }

  if (permissionDecision?.allowed === false) {
    return {
      score: 100,
      level: "critical",
      reasons: [permissionDecision.reason ?? "Permission denied."],
    };
  }

  return {
    score: 10,
    level: "low",
    reasons: [`Tool ${toolName} has no filesystem or shell side effects.`],
  };
}

export function assessChangeSetRisk({ toolName, changeSet }: { toolName: string; changeSet: ChangeSetSummary }): RiskAssessment {
  let score = toolName === "apply_patch" ? 28 : 20;
  const reasons = [];
  const files: ChangeSetFileSummary[] = Array.isArray(changeSet?.files) ? changeSet.files : [];
  const operations = changeSet?.operations ?? {};
  const touchedFiles = changeSet?.touchedFiles ?? [];
  const impact = changeSet?.impact ?? {};
  const relatedFiles = Array.isArray(impact.relatedFiles) ? impact.relatedFiles : [];

  if (operations.delete > 0) {
    score += operations.delete * 28;
    reasons.push(`Deletes ${operations.delete} file(s).`);
  }

  if (operations.rename > 0) {
    score += operations.rename * 18;
    reasons.push(`Renames ${operations.rename} file(s).`);
  }

  if (operations.add > 0) {
    score += operations.add * 8;
    reasons.push(`Adds ${operations.add} file(s).`);
  }

  if (touchedFiles.length >= 3) {
    score += Math.min(26, (touchedFiles.length - 2) * 6);
    reasons.push(`Touches ${touchedFiles.length} files.`);
  }

  for (const file of files) {
    if ((file.stats?.added ?? 0) + (file.stats?.removed ?? 0) > 120) {
      score += 12;
      reasons.push(`Large diff in ${path.basename(file.path)}.`);
      break;
    }
  }

  if (relatedFiles.length > 0) {
    score += Math.min(12, relatedFiles.length * 2);
    reasons.push(`May affect ${relatedFiles.length} related file(s).`);
  }

  if (impact.needsTestRerun) {
    score += 8;
    reasons.push("Likely requires rerunning tests.");
  }

  if (files.some((file) => isSensitivePath(file.path))) {
    score += 20;
    reasons.push("Touches config, workflow, or package metadata files.");
  }

  const level = scoreToLevel(score);
  return {
    score,
    level,
    reasons: dedupeReasons(reasons.length > 0 ? reasons : ["Standard workspace edit."]),
  };
}

export function buildApprovalContext({
  toolName,
  changeSet = null,
  risk = null,
  permissionDecision = null,
  input = null,
}: {
  toolName: string;
  changeSet?: ChangeSetSummary | null;
  risk?: RiskAssessment | null;
  permissionDecision?: PermissionDecision | null;
  input?: Record<string, unknown> | null;
}): ApprovalContext {
  const checkpointAvailable = Boolean(changeSet?.rollbackAvailable || changeSet?.checkpointId);
  const touchedPaths = changeSet?.touchedFiles ?? permissionDecision?.targetPaths ?? [];
  const changeSetFiles: ChangeSetFileSummary[] | null = Array.isArray(changeSet?.files) ? changeSet.files : null;
  const summary = changeSetFiles?.map((entry) => entry.summary).slice(0, 3) ??
    (toolName === "run_shell" && input?.command
      ? compactStrings([
          `shell ${input.command}`,
          input?.background ? "background job" : "foreground job",
          input?.pty ? "pty requested" : "pipe mode",
          input?.timeoutMs ? `timeout ${input.timeoutMs}ms` : null,
        ])
      : ["web_search", "fetch_url", "extract_content"].includes(toolName)
        ? compactStrings([
            input?.query ? `query ${input.query}` : null,
            input?.url ? `url ${input.url}` : null,
            permissionDecision?.network?.networkMode ? `mode ${permissionDecision.network.networkMode}` : null,
            permissionDecision?.network?.domain ? `domain ${permissionDecision.network.domain}` : null,
          ])
      : permissionDecision?.category === "mcp"
        ? compactStrings([
            permissionDecision?.mcp?.serverName ? `server ${permissionDecision.mcp.serverName}` : null,
            permissionDecision?.mcp?.toolName ? `tool ${permissionDecision.mcp.toolName}` : null,
            permissionDecision?.mcp?.annotations?.readOnlyHint ? "readOnlyHint" : null,
            permissionDecision?.mcp?.annotations?.destructiveHint ? "destructiveHint" : null,
            permissionDecision?.mcp?.annotations?.openWorldHint ? "openWorldHint" : null,
          ])
      : permissionDecision?.category === "plugin"
        ? compactStrings([
            permissionDecision?.plugin?.pluginName ? `plugin ${permissionDecision.plugin.pluginName}` : null,
            permissionDecision?.plugin?.toolName ? `tool ${permissionDecision.plugin.toolName}` : null,
            permissionDecision?.plugin?.riskCategory ? `risk ${permissionDecision.plugin.riskCategory}` : null,
            permissionDecision?.plugin?.permissionsHints?.length
              ? `hints ${permissionDecision.plugin.permissionsHints.join(",")}`
              : null,
          ])
      : []);

  return {
    toolName,
    touchedPaths,
    targetDomains: permissionDecision?.targetDomains ?? [],
    previewSummary: summary,
    rollbackAvailable: checkpointAvailable,
    risk,
    blockedReason: permissionDecision?.allowed === false ? permissionDecision.reason : null,
    network: permissionDecision?.network ?? null,
    mcp: permissionDecision?.mcp ?? null,
    plugin: permissionDecision?.plugin ?? null,
  };
}

function assessShellRisk({
  input,
  permissionDecision,
}: {
  input?: Record<string, unknown> | null;
  permissionDecision?: PermissionDecision | null;
}): RiskAssessment {
  const command = `${input?.command ?? ""}`.trim();
  const reasons: string[] = [];

  if (permissionDecision?.allowed === false) {
    return {
      score: 100,
      level: "critical",
      reasons: [permissionDecision.reason ?? "Permission denied."],
    };
  }

  if (!command) {
    return {
      score: 55,
      level: "medium",
      reasons: ["Command string is empty or malformed."],
    };
  }

  // Critical patterns that always score high
  const criticalPatterns = [
    /\brm\s+-rf\b/,
    /\bgit\s+reset\b/,
    /\bchmod\b/,
    /\bsudo\b/,
    /\bcurl\b/,
    /\bwget\b/,
    /\bssh\b/,
  ];

  if (criticalPatterns.some((pattern) => pattern.test(command))) {
    return {
      score: 95,
      level: "critical",
      reasons: ["Command matches a high-risk shell pattern."],
    };
  }

  // Read-only command patterns — much lower risk
  const readOnlyPatterns = [
    /^ls\b/i,
    /^cat\b/i,
    /^head\b/i,
    /^tail\b/i,
    /^less\b/i,
    /^more\b/i,
    /^file\b/i,
    /^wc\b/i,
    /^which\b/i,
    /^where\b/i,
    /^whoami\b/i,
    /^pwd\b/i,
    /^echo\b/i,
    /^printenv\b/i,
    /^env\b/i,
    /^type\b/i,
    /^git\s+status\b/i,
    /^git\s+log\b/i,
    /^git\s+diff\b/i,
    /^git\s+branch\b/i,
    /^git\s+remote\s+-v\b/i,
    /^git\s+show\b/i,
    /^git\s+describe\b/i,
    /^git\s+rev-parse\b/i,
    /^git\s+config\b/i,
    /^node\s+-v\b/i,
    /^node\s+--version\b/i,
    /^npm\s+-v\b/i,
    /^npm\s+--version\b/i,
    /^npm\s+list\b/i,
    /^npm\s+ls\b/i,
    /^python\d*\s+--version\b/i,
    /^python\d*\s+-V\b/i,
    /^find\b/i,
    /^grep\b/i,
    /^rg\b/i,
    /^ag\b/i,
    /^sort\b/i,
    /^uniq\b/i,
    /^diff\b/i,
    /^stat\b/i,
    /^basename\b/i,
    /^dirname\b/i,
    /^realpath\b/i,
    /^readlink\b/i,
    /^tree\b/i,
    /^uname\b/i,
    /^date\b/i,
    /^hostname\b/i,
    /^df\b/i,
    /^du\b/i,
  ];

  if (readOnlyPatterns.some((pattern) => pattern.test(command))) {
    return {
      score: 20,
      level: "low",
      reasons: ["Command appears to be a read-only shell operation."],
    };
  }

  // Default: treat as medium-high risk for unknown commands
  return {
    score: 60,
    level: "medium",
    reasons: ["Shell execution can affect the system outside MJ Code's internal model."],
  };
}

function assessNetworkRisk({
  toolName,
  input,
  permissionDecision,
}: {
  toolName: string;
  input?: Record<string, unknown> | null;
  permissionDecision?: PermissionDecision | null;
}): RiskAssessment {
  const network = permissionDecision?.network ?? null;
  let score = toolName === "web_search" ? 18 : 22;
  const reasons = [];

  if (permissionDecision?.allowed === false) {
    score = 90;
    reasons.push(permissionDecision.reason ?? "Network policy blocked the request.");
  }

  if (network?.networkMode === "open-web") {
    score += 10;
    reasons.push("Open-web mode allows general internet retrieval.");
  }

  if (network?.networkMode === "docs-only") {
    score -= 4;
    reasons.push("Docs-only mode restricts retrieval to higher-trust sources.");
  }

  if (toolName !== "web_search") {
    if (network?.official) {
      score -= 6;
      reasons.push("Target URL looks like an official source.");
    } else {
      score += 8;
      reasons.push("Target URL is not classified as official.");
    }
  }

  const searchQuery = `${input?.query ?? ""}`.trim();
  if (toolName === "web_search" && searchQuery) {
    reasons.push(`Search query: ${searchQuery.slice(0, 96)}`);
  }

  if (toolName !== "web_search" && network?.domain) {
    reasons.push(`Target domain: ${network.domain}`);
  }

  return {
    score: Math.max(5, score),
    level: scoreToLevel(score),
    reasons: dedupeReasons(reasons.length > 0 ? reasons : ["Standard network retrieval."]),
  };
}

function assessMcpRisk({
  toolName,
  permissionDecision,
}: {
  toolName: string;
  permissionDecision?: PermissionDecision | null;
}): RiskAssessment {
  const annotations = permissionDecision?.mcp?.annotations ?? {};
  let score = 58;
  const reasons = [
    "MCP tools run through an external server boundary outside MJ Code's built-in tool sandbox.",
  ];

  if (permissionDecision?.allowed === false) {
    score = 95;
    reasons.push(permissionDecision.reason ?? "MCP access was denied.");
  }

  if (annotations.readOnlyHint === true) {
    score -= 10;
    reasons.push("Server advertises readOnlyHint, but this is treated as advisory only.");
  }

  if (annotations.destructiveHint === true) {
    score += 18;
    reasons.push("Server advertises destructiveHint.");
  }

  if (annotations.openWorldHint === true) {
    score += 12;
    reasons.push("Server advertises openWorldHint.");
  }

  if (permissionDecision?.mcp?.serverName) {
    reasons.push(`Server: ${permissionDecision.mcp.serverName}.`);
  }

  if (permissionDecision?.mcp?.toolName) {
    reasons.push(`Tool: ${permissionDecision.mcp.toolName}.`);
  }

  return {
    score: Math.max(20, score),
    level: scoreToLevel(score),
    reasons: dedupeReasons(reasons),
  };
}

function assessPluginRisk({
  toolName,
  permissionDecision,
}: {
  toolName: string;
  permissionDecision?: PermissionDecision | null;
}): RiskAssessment {
  const plugin = permissionDecision?.plugin ?? null;
  const permissionsHints = Array.isArray(plugin?.permissionsHints) ? plugin.permissionsHints : [];
  let score = 62;
  const reasons = [
    "Plugin tools run through locally loaded extension code outside MJ Code's built-in tool implementation.",
  ];

  if (permissionDecision?.allowed === false) {
    score = 96;
    reasons.push(permissionDecision.reason ?? "Plugin access was denied.");
  }

  if (plugin?.riskCategory === "read") {
    score -= 10;
    reasons.push("Plugin tool is declared as read-oriented.");
  }

  if (plugin?.riskCategory === "write") {
    score += 10;
    reasons.push("Plugin tool declares write access.");
  }

  if (plugin?.riskCategory && ["exec", "network", "external"].includes(plugin.riskCategory)) {
    score += 16;
    reasons.push(`Plugin tool declares ${plugin.riskCategory} capability.`);
  }

  if (permissionsHints.length > 0) {
    reasons.push(`Permissions hints: ${permissionsHints.join(", ")}.`);
  }

  if (plugin?.pluginName) {
    reasons.push(`Plugin: ${plugin.pluginName}.`);
  }

  if (plugin?.toolName) {
    reasons.push(`Tool: ${plugin.toolName}.`);
  }

  return {
    score: Math.max(15, score),
    level: scoreToLevel(score),
    reasons: dedupeReasons(reasons),
  };
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.endsWith("package.json") ||
    normalized.endsWith("package-lock.json") ||
    normalized.endsWith("pnpm-lock.yaml") ||
    normalized.endsWith("yarn.lock") ||
    normalized.includes("/.github/") ||
    normalized.endsWith(".env") ||
    normalized.includes("/config/") ||
    normalized.endsWith("README.md")
  );
}

function scoreToLevel(score: number): RiskLevel {
  if (score >= 90) {
    return "critical";
  }

  if (score >= 65) {
    return "high";
  }

  if (score >= 35) {
    return "medium";
  }

  return "low";
}

function dedupeReasons(reasons: Array<string | null | undefined>): string[] {
  const deduped: string[] = [];
  for (const reason of reasons) {
    if (typeof reason !== "string" || !reason.length || deduped.includes(reason)) {
      continue;
    }
    deduped.push(reason);
  }
  return deduped;
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      normalized.push(value);
    }
  }
  return normalized;
}
