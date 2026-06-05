import { extractPatchPaths } from "./apply-patch.mjs";
import { isSubPath, resolveUserPath } from "./path-utils.mjs";
import { evaluateUrlAgainstNetworkMode, summarizeNetworkInput } from "./web-policy.mjs";
import type {
  NetworkInputSummary,
  McpPermissionMeta,
  PermissionCategory,
  PermissionDecision,
  PluginPermissionMeta,
  ToolMetadata,
} from "../types/contracts.js";

type ToolSource = "local" | "plugin" | "mcp" | string;
type ToolInput = Record<string, unknown> | undefined;
type NetworkSummary = NetworkInputSummary | null;

const READ_TOOLS = new Set(["pwd", "list_dir", "read_file", "search_files"]);
const WRITE_TOOLS = new Set(["write_file", "replace_in_file", "apply_patch"]);
const EXEC_TOOLS = new Set(["run_shell"]);
const INTERNAL_STATE_TOOLS = new Set(["remember_memory", "search_memory"]);
const NETWORK_TOOLS = new Set(["web_search", "fetch_url", "extract_content"]);

export function evaluateToolPermission({
  toolName,
  toolSource = "local",
  toolMeta = null,
  input,
  permissionMode,
  approvalPolicy,
  workspaceRoot,
  networkMode = "docs-only",
  webProvider = "fallback",
  webAllowDomains = [],
  webDenyDomains = [],
}: {
  toolName: string;
  toolSource?: ToolSource;
  toolMeta?: ToolMetadata | null;
  input?: ToolInput;
  permissionMode: string;
  approvalPolicy: string;
  workspaceRoot: string;
  networkMode?: string;
  webProvider?: string;
  webAllowDomains?: string[];
  webDenyDomains?: string[];
}): PermissionDecision {
  if (!toolName) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "Missing tool name.",
      category: "unknown",
      targetPaths: [],
    };
  }

  const category = READ_TOOLS.has(toolName)
    ? "read"
    : WRITE_TOOLS.has(toolName)
      ? "write"
      : EXEC_TOOLS.has(toolName)
        ? "exec"
        : NETWORK_TOOLS.has(toolName)
          ? "network"
        : toolSource === "plugin"
          ? "plugin"
        : toolSource === "mcp"
          ? "mcp"
        : INTERNAL_STATE_TOOLS.has(toolName)
          ? "state"
          : "unknown";

  if (toolSource === "mcp") {
    return resolveMcpPermission({
      toolName,
      toolMeta,
      permissionMode,
      approvalPolicy,
    });
  }

  if (toolSource === "plugin") {
    return resolvePluginPermission({
      toolName,
      toolMeta,
      permissionMode,
      approvalPolicy,
    });
  }

  if (
    permissionMode === "read-only" &&
    !READ_TOOLS.has(toolName) &&
    !NETWORK_TOOLS.has(toolName) &&
    !INTERNAL_STATE_TOOLS.has(toolName)
  ) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Tool "${toolName}" is blocked in read-only mode.`,
      category,
      targetPaths: [],
    };
  }

  if (NETWORK_TOOLS.has(toolName)) {
    return resolveNetworkPermission({
      toolName,
      input,
      approvalPolicy,
      networkMode,
      webProvider,
      webAllowDomains,
      webDenyDomains,
    });
  }

  if (permissionMode === "workspace-write") {
    if (INTERNAL_STATE_TOOLS.has(toolName)) {
      return {
        allowed: true,
        requiresApproval: false,
        reason: null,
        category,
        targetPaths: [],
      };
    }

    if (EXEC_TOOLS.has(toolName)) {
      // In workspace-write mode, allow shell commands but let the
      // execution boundary classify them as read-only vs. dangerous.
      // Read-only commands (ls, cat, git status, etc.) are allowed
      // and may require approval depending on the boundary decision.
      return {
        allowed: true,
        requiresApproval: true,
        reason: null,
        category,
        targetPaths: [],
      };
    }

    if (WRITE_TOOLS.has(toolName)) {
      let targetPaths;
      try {
        targetPaths = resolveTargetPaths(toolName, input, workspaceRoot);
      } catch (error) {
        return {
          allowed: false,
          requiresApproval: false,
          reason: error instanceof Error ? error.message : `${error ?? "Unknown path resolution error."}`,
          category,
          targetPaths: [],
        };
      }

      if (!targetPaths || targetPaths.length === 0) {
        return {
          allowed: false,
          requiresApproval: false,
          reason: `Tool "${toolName}" requires a path input.`,
          category,
          targetPaths: [],
        };
      }

      for (const targetPath of targetPaths) {
        if (!isSubPath(workspaceRoot, targetPath)) {
          return {
            allowed: false,
            requiresApproval: false,
            reason: `Path "${targetPath}" is outside the workspace root.`,
            category,
            targetPaths,
          };
        }
      }

      return finalizePermission({
        category,
        toolName,
        approvalPolicy,
        targetPaths,
      });
    }
  }

  return finalizePermission({
    category,
    toolName,
    approvalPolicy,
    targetPaths: [],
    network: NETWORK_TOOLS.has(toolName)
      ? summarizeNetworkInput(toolName, input, {
          networkMode,
          webProvider,
          allowDomains: webAllowDomains,
          denyDomains: webDenyDomains,
        })
      : null,
  });
}

function resolveTargetPaths(toolName: string, input: ToolInput, workspaceRoot: string): string[] | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  if (toolName === "write_file" || toolName === "replace_in_file" || toolName === "read_file") {
    return typeof input.path === "string" ? [resolveUserPath(input.path, workspaceRoot)] : null;
  }

  if (toolName === "apply_patch") {
    return typeof input.patch === "string" ? extractPatchPaths(input.patch, workspaceRoot) : null;
  }

  return null;
}

function finalizePermission({
  category,
  toolName,
  approvalPolicy,
  targetPaths,
  network = null,
}: {
  category: PermissionCategory;
  toolName: string;
  approvalPolicy: string;
  targetPaths: string[];
  network?: NetworkSummary;
}): PermissionDecision {
  const risky = WRITE_TOOLS.has(toolName) || EXEC_TOOLS.has(toolName);
  const requiresApproval =
    approvalPolicy === "always" ? true : approvalPolicy === "on-write" ? risky : false;
  const targetDomain = typeof network?.domain === "string" ? network.domain : null;

  return {
    allowed: true,
    requiresApproval,
    reason: null,
    category,
    targetPaths,
    targetDomains: targetDomain ? [targetDomain] : [],
    network,
  };
}

function resolveNetworkPermission({
  toolName,
  input,
  approvalPolicy,
  networkMode,
  webProvider,
  webAllowDomains,
  webDenyDomains,
}: {
  toolName: string;
  input?: ToolInput;
  approvalPolicy: string;
  networkMode: string;
  webProvider: string;
  webAllowDomains: string[];
  webDenyDomains: string[];
}): PermissionDecision {
  const network = summarizeNetworkInput(toolName, input, {
    networkMode,
    webProvider,
    allowDomains: webAllowDomains,
    denyDomains: webDenyDomains,
  });

  if (networkMode === "off") {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "Network mode is off.",
      category: "network",
      targetPaths: [],
      targetDomains: [],
      network,
    };
  }

  if (toolName === "web_search") {
    return finalizePermission({
      category: "network",
      toolName,
      approvalPolicy,
      targetPaths: [],
      network,
    });
  }

  const evaluation = network?.decision ?? evaluateUrlAgainstNetworkMode(input?.url, {
    networkMode,
    allowDomains: webAllowDomains,
    denyDomains: webDenyDomains,
    query: typeof input?.query === "string" ? input.query : null,
  });

  if (!evaluation.allowed) {
    const blockedDomain = typeof evaluation.domain === "string" ? evaluation.domain : null;
    return {
      allowed: false,
      requiresApproval: false,
      reason: evaluation.reason ?? "Network policy blocked the request.",
      category: "network",
      targetPaths: [],
      targetDomains: blockedDomain ? [blockedDomain] : [],
      network: {
        ...network,
        decision: evaluation,
        domain: blockedDomain,
        official: evaluation.official,
      },
    };
  }

  return finalizePermission({
    category: "network",
    toolName,
    approvalPolicy,
    targetPaths: [],
    network: {
      ...network,
      decision: evaluation,
      domain: evaluation.domain,
      official: evaluation.official,
    },
  });
}

function resolveMcpPermission({
  toolName,
  toolMeta,
  permissionMode,
  approvalPolicy,
}: {
  toolName: string;
  toolMeta?: ToolMetadata | null;
  permissionMode: string;
  approvalPolicy: string;
}): PermissionDecision {
  if (permissionMode === "read-only") {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `MCP tool "${toolName}" is blocked in read-only mode.`,
      category: "mcp",
      targetPaths: [],
      targetDomains: [],
      mcp: {
        serverId: toolMeta?.serverId ?? null,
        serverName: toolMeta?.serverName ?? null,
        toolName: toolMeta?.name ?? toolName,
        annotations: toolMeta?.annotations ?? {},
      },
    };
  }

  return {
    allowed: true,
    requiresApproval: approvalPolicy !== "never",
    reason: null,
    category: "mcp",
    targetPaths: [],
    targetDomains: [],
    mcp: {
      serverId: toolMeta?.serverId ?? null,
      serverName: toolMeta?.serverName ?? null,
      toolName: toolMeta?.name ?? toolName,
      annotations: toolMeta?.annotations ?? {},
    },
  };
}

function resolvePluginPermission({
  toolName,
  toolMeta,
  permissionMode,
  approvalPolicy,
}: {
  toolName: string;
  toolMeta?: ToolMetadata | null;
  permissionMode: string;
  approvalPolicy: string;
}): PermissionDecision {
  const riskCategory = toolMeta?.riskCategory ?? "external";
  const permissionsHints = Array.isArray(toolMeta?.permissionsHints) ? toolMeta.permissionsHints : [];
  const readLike = ["read", "state"].includes(riskCategory);
  const writeLike = riskCategory === "write";

  if (permissionMode === "read-only" && !readLike) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Plugin tool "${toolName}" is blocked in read-only mode.`,
      category: "plugin",
      targetPaths: [],
      targetDomains: [],
      plugin: buildPluginPermissionMeta(toolName, toolMeta, riskCategory, permissionsHints),
    };
  }

  if (permissionMode === "workspace-write" && !readLike && !writeLike) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Plugin tool "${toolName}" requires full-access mode.`,
      category: "plugin",
      targetPaths: [],
      targetDomains: [],
      plugin: buildPluginPermissionMeta(toolName, toolMeta, riskCategory, permissionsHints),
    };
  }

  return {
    allowed: true,
    requiresApproval: approvalPolicy === "never" ? false : true,
    reason: null,
    category: "plugin",
    targetPaths: [],
    targetDomains: [],
    plugin: buildPluginPermissionMeta(toolName, toolMeta, riskCategory, permissionsHints),
  };
}

function buildPluginPermissionMeta(
  toolName: string,
  toolMeta: ToolMetadata | null | undefined,
  riskCategory: string,
  permissionsHints: string[],
): PluginPermissionMeta {
  return {
    pluginId: toolMeta?.pluginId ?? null,
    pluginName: toolMeta?.pluginName ?? null,
    toolName: toolMeta?.displayName ?? toolMeta?.name ?? toolName,
    riskCategory,
    permissionsHints,
  };
}
