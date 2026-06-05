import crypto from "node:crypto";

import type { CapabilityRegistryLike } from "./capability-registry.mjs";

import type {
  CapabilityBudget,
  CapabilityRouteEntry,
  CapabilitySummary,
  RouteDecision,
  RuntimeHealthScorecard,
  TaskClassification,
} from "../types/contracts.js";

interface ActiveSkillLike {
  id?: string;
  toolPreferences?: {
    prefer?: string[];
    avoid?: string[];
  };
}

interface RoutePolicyLike {
  sources?: Array<{
    id?: string;
    title?: string | null;
  }>;
}

interface RouteContext {
  prompt: string;
  taskClassification: TaskClassification | null | undefined;
  capabilityRegistry: Pick<CapabilityRegistryLike, "list"> | null | undefined;
  runtimeHealth?: { scorecard?: RuntimeHealthScorecard; getScorecard?: () => RuntimeHealthScorecard } | RuntimeHealthScorecard | null;
  policy?: RoutePolicyLike | null;
  networkMode: "off" | "docs-only" | "open-web";
  permissionMode: "read-only" | "workspace-write" | "full-access";
  approvalPolicy: "always" | "on-write" | "never";
  activeSkills?: ActiveSkillLike[];
  mcpEnabled?: boolean;
}

interface CapabilityEvaluation {
  blocked: boolean;
  blockedReason?: string;
  score: number;
  reasons: string[];
  rejectedReason?: string;
}

interface RouterGovernanceContext {
  taskClassification: TaskClassification | null | undefined;
  networkMode: string;
  permissionMode: string;
  blockedCapabilities: CapabilityRouteEntry[];
  scorecard: RuntimeHealthScorecard;
}

interface EvaluationContext {
  prompt: string;
  taskClassification: TaskClassification | null | undefined;
  scorecard: RuntimeHealthScorecard;
  routingMode: string;
  networkMode: string;
  permissionMode: string;
  preferredTools: Set<string>;
  avoidedTools: Set<string>;
  mcpEnabled: boolean;
}

export class CapabilityRouter {
  readonly config: Record<string, unknown>;

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
  }

  route({
    prompt,
    taskClassification,
    capabilityRegistry,
    runtimeHealth,
    policy,
    networkMode,
    permissionMode,
    approvalPolicy,
    activeSkills = [],
    mcpEnabled = true,
  }: RouteContext): RouteDecision {
    const capabilities = capabilityRegistry?.list?.() ?? [];
    const scorecard = resolveRuntimeScorecard(runtimeHealth);
    const taskClass = taskClassification?.taskClass ?? "repo_understanding";
    const routingMode = inferRoutingMode({
      taskClassification,
      activeSkills,
      networkMode,
      permissionMode,
      scorecard,
    });
    const capabilityBudget = buildCapabilityBudget({
      taskClassification,
      routingMode,
      scorecard,
      approvalPolicy,
    });
    const preferredTools = collectSkillToolPreferences(activeSkills, "prefer");
    const avoidedTools = collectSkillToolPreferences(activeSkills, "avoid");

    const selectedCapabilities: CapabilityRouteEntry[] = [];
    const rejectedCapabilities: CapabilityRouteEntry[] = [];
    const blockedCapabilities: CapabilityRouteEntry[] = [];

    for (const capability of capabilities) {
      const evaluation = evaluateCapability(capability, {
        prompt,
        taskClassification,
        scorecard,
        routingMode,
        networkMode,
        permissionMode,
        preferredTools,
        avoidedTools,
        mcpEnabled,
      });

      const payload = {
        id: capability.id,
        name: capability.name,
        displayName: capability.displayName,
        source: capability.source,
        type: capability.type,
        riskCategory: capability.riskCategory,
        score: Number(evaluation.score.toFixed(4)),
        reasons: evaluation.reasons.slice(0, 4),
      };

      if (evaluation.blocked) {
        blockedCapabilities.push({
          ...payload,
          blockedReason: evaluation.blockedReason,
        });
        continue;
      }

      if (!capability.enabled || !capability.active) {
        rejectedCapabilities.push({
          ...payload,
          rejectedReason: "Capability is currently disabled or inactive.",
        });
        continue;
      }

      if (evaluation.score >= capabilityBudget.selectThreshold && selectedCapabilities.length < capabilityBudget.maxSelected) {
        selectedCapabilities.push(payload);
      } else {
        rejectedCapabilities.push({
          ...payload,
          rejectedReason: evaluation.rejectedReason ?? "Lower priority than the selected capability budget.",
        });
      }
    }

    selectedCapabilities.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id));
    rejectedCapabilities.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id));
    blockedCapabilities.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id));

    const requiredCapabilities = inferRequiredCapabilities(taskClassification, routingMode);
    ensureBlockedCategory(requiredCapabilities, blockedCapabilities, selectedCapabilities, {
      networkMode,
      mcpEnabled,
      scorecard,
    });

    const degraded = Boolean(
      scorecard?.degradedFlags?.length ||
      blockedCapabilities.some((entry) => requiredCapabilities.includes(mapCapabilityToRequired(entry))),
    );

    const reasons = dedupeStrings([
      ...(taskClassification?.reasons ?? []),
      ...explainRoutingMode(routingMode),
      ...explainGovernance({
        taskClassification,
        networkMode,
        permissionMode,
        blockedCapabilities,
        scorecard,
      }),
      ...explainPolicy(policy),
    ]).slice(0, 8);

    return {
      routeId: crypto.randomUUID().slice(0, 12),
      taskClass,
      selectedCapabilities: selectedCapabilities.slice(0, capabilityBudget.maxSelected),
      rejectedCapabilities: rejectedCapabilities.slice(0, 12),
      requiredCapabilities,
      blockedCapabilities: blockedCapabilities.slice(0, 12),
      routingMode,
      reasons,
      degraded,
      capabilityBudget,
      selectedSkillIds: activeSkills.map((skill) => skill.id).filter((id): id is string => typeof id === "string"),
      rankingMode: inferRankingMode(taskClassification, routingMode),
      governance: {
        permissionMode,
        approvalPolicy,
        networkMode,
        degradedFlags: scorecard?.degradedFlags ?? [],
      },
    };
  }
}

function inferRoutingMode({
  taskClassification,
  activeSkills,
  networkMode,
  permissionMode,
  scorecard,
}: {
  taskClassification: TaskClassification | null | undefined;
  activeSkills: ActiveSkillLike[];
  networkMode: string;
  permissionMode: string;
  scorecard: RuntimeHealthScorecard;
}): string {
  if (
    permissionMode === "read-only" &&
    (taskClassification?.likelyWrites || taskClassification?.likelyShell)
  ) {
    return "constrained-safe-mode";
  }
  if ((scorecard?.degradedFlags ?? []).includes("provider_circuit_open")) {
    return "constrained-safe-mode";
  }
  if (taskClassification?.taskClass === "official_docs_lookup") {
    return "official-first";
  }
  if (
    taskClassification?.taskClass === "web_retrieval" &&
    (networkMode === "docs-only" || activeSkills.some((skill) => skill.id?.includes("docs")))
  ) {
    return "docs-first";
  }
  if (taskClassification?.taskClass === "mcp_delegation") {
    return "external-capability-first";
  }
  return "local-first";
}

function buildCapabilityBudget({
  taskClassification,
  routingMode,
  scorecard,
  approvalPolicy,
}: {
  taskClassification: TaskClassification | null | undefined;
  routingMode: string;
  scorecard: RuntimeHealthScorecard;
  approvalPolicy: string;
}): CapabilityBudget {
  const degradedPressure = (scorecard?.degradedFlags ?? []).length;
  const base = {
    mode: routingMode,
    maxSelected: 6,
    selectThreshold: 0.44,
    preferredCategories: [],
    expensiveCategories: ["plugin-tool", "mcp-tool", "web-tool"],
  };

  if (routingMode === "constrained-safe-mode") {
    return {
      ...base,
      maxSelected: 4,
      selectThreshold: 0.5,
      preferredCategories: ["builtin-tool", "memory", "instruction/policy"],
      reason: "Safety-constrained routing prefers local and lower-risk capabilities.",
      degradedPressure,
    };
  }

  if (routingMode === "official-first" || routingMode === "docs-first") {
    return {
      ...base,
      maxSelected: 5,
      selectThreshold: 0.4,
      preferredCategories: ["web-tool", "skill", "memory"],
      reason: "Documentation retrieval favors web tools plus supporting skills.",
      degradedPressure,
    };
  }

  if (routingMode === "external-capability-first") {
    return {
      ...base,
      maxSelected: 6,
      selectThreshold: 0.38,
      preferredCategories: ["mcp-tool", "plugin-tool", "memory"],
      expensiveCategories: approvalPolicy === "always" ? ["plugin-tool"] : ["plugin-tool", "web-tool"],
      reason: "External delegation prioritizes MCP and attached integrations.",
      degradedPressure,
    };
  }

  return {
    ...base,
    preferredCategories: taskClassification?.likelyWrites
      ? ["builtin-tool", "memory", "skill"]
      : ["builtin-tool", "memory", "instruction/policy"],
    reason: "Local-first routing prefers builtin tools, memory, and active skills.",
    degradedPressure,
  };
}

function evaluateCapability(
  capability: CapabilitySummary,
  context: EvaluationContext,
): CapabilityEvaluation {
  const taskClass = context.taskClassification?.taskClass ?? "repo_understanding";
  const name = capability.name ?? capability.id;
  const scorecard = context.scorecard ?? { degradedFlags: [], circuits: { byLayer: {} } };
  const reasons = [];
  let score = 0.06;

  if (capability.type === "instruction/policy") {
    score = 0.24;
    reasons.push("Policies remain in scope as routing guardrails.");
  }
  if (capability.type === "skill" && capability.active) {
    score = 0.34;
    reasons.push("Active skills can influence routing and prompt assembly.");
  }
  if (capability.type === "memory") {
    score = taskClass === "memory_lookup" ? 0.9 : 0.42;
    reasons.push(taskClass === "memory_lookup"
      ? "Memory retrieval is a primary path for this task."
      : "Memory can provide prior decisions and conventions.");
  }

  if (["builtin-tool", "web-tool", "mcp-tool", "plugin-tool"].includes(capability.type)) {
    score = computeToolScore(capability, taskClass);
  }

  if (context.preferredTools.has(name)) {
    score += 0.12;
    reasons.push("An active skill explicitly prefers this tool.");
  }
  if (context.avoidedTools.has(name)) {
    score -= 0.15;
    reasons.push("An active skill prefers avoiding this tool unless necessary.");
  }

  if (capability.riskCategory === "write" && context.permissionMode === "read-only") {
    return blockedResult(score, reasons, "Write capabilities are blocked in read-only mode.");
  }
  if (capability.riskCategory === "exec" && context.permissionMode === "read-only") {
    return blockedResult(score, reasons, "Shell execution is blocked in read-only mode.");
  }
  if (capability.type === "web-tool" && context.networkMode === "off") {
    return blockedResult(score, reasons, "Web capabilities are blocked because network mode is off.");
  }
  if (capability.type === "mcp-tool" && context.mcpEnabled === false) {
    return blockedResult(score, reasons, "MCP capabilities are disabled in the current runtime.");
  }
  if (capability.type === "web-tool" && (scorecard.degradedFlags ?? []).includes("web_circuit_open")) {
    return blockedResult(score, reasons, "The web runtime circuit is open, so web capabilities are currently suppressed.");
  }
  if (capability.type === "mcp-tool" && (scorecard.degradedFlags ?? []).includes("mcp_circuit_open")) {
    return blockedResult(score, reasons, "The MCP runtime circuit is open, so external delegation is currently suppressed.");
  }
  if (capability.type === "plugin-tool" && context.routingMode !== "external-capability-first") {
    score -= 0.16;
    reasons.push("Plugin tools stay behind builtin/web/MCP unless the task clearly needs them.");
  }

  if (context.routingMode === "constrained-safe-mode") {
    if (["web-tool", "mcp-tool", "plugin-tool"].includes(capability.type)) {
      score -= 0.2;
      reasons.push("Constrained-safe-mode de-prioritizes external capabilities.");
    }
  } else if (context.routingMode === "official-first" || context.routingMode === "docs-first") {
    if (capability.type === "web-tool") {
      score += 0.1;
      reasons.push("Documentation-first routing boosts web retrieval tools.");
    }
  } else if (context.routingMode === "external-capability-first" && capability.type === "mcp-tool") {
    score += 0.14;
    reasons.push("External-capability-first routing boosts MCP tools.");
  }

  if ((scorecard.degradedFlags ?? []).includes("shell_orphaned_jobs") && name === "run_shell") {
    score -= 0.05;
    reasons.push("Shell continuity is degraded, so shell usage is slightly de-prioritized.");
  }

  return {
    blocked: false,
    score: Math.max(0, Math.min(1.2, score)),
    reasons: dedupeStrings(reasons),
    rejectedReason: inferRejectedReason(capability, taskClass),
  };
}

function computeToolScore(capability: CapabilitySummary, taskClass: string): number {
  const name = capability.name ?? capability.id;
  const byTask: Record<string, Record<string, number>> = {
    repo_understanding: {
      list_dir: 0.78,
      read_file: 0.92,
      search_files: 0.94,
      pwd: 0.38,
      search_memory: 0.4,
    },
    code_edit: {
      list_dir: 0.68,
      read_file: 0.9,
      search_files: 0.92,
      apply_patch: 0.93,
      replace_in_file: 0.83,
      write_file: 0.7,
      run_shell: 0.56,
      search_memory: 0.38,
    },
    bug_fix: {
      read_file: 0.9,
      search_files: 0.94,
      apply_patch: 0.9,
      replace_in_file: 0.8,
      run_shell: 0.78,
      search_memory: 0.42,
    },
    refactor: {
      read_file: 0.86,
      search_files: 0.9,
      apply_patch: 0.92,
      replace_in_file: 0.88,
      write_file: 0.74,
      run_shell: 0.52,
    },
    test_repair: {
      read_file: 0.84,
      search_files: 0.88,
      apply_patch: 0.88,
      replace_in_file: 0.78,
      run_shell: 0.94,
      write_file: 0.62,
    },
    shell_execution: {
      run_shell: 0.98,
      search_files: 0.35,
      read_file: 0.28,
    },
    web_retrieval: {
      web_search: 0.94,
      fetch_url: 0.72,
      extract_content: 0.9,
      search_memory: 0.24,
    },
    official_docs_lookup: {
      web_search: 0.92,
      fetch_url: 0.74,
      extract_content: 0.94,
      search_memory: 0.2,
    },
    mcp_delegation: {
      run_shell: 0.2,
    },
    memory_lookup: {
      search_memory: 0.96,
      remember_memory: 0.38,
      read_file: 0.18,
    },
    config_inspection: {
      read_file: 0.7,
      search_files: 0.74,
      list_dir: 0.44,
      pwd: 0.3,
    },
    risk_review: {
      read_file: 0.64,
      search_files: 0.7,
      web_search: 0.34,
      extract_content: 0.3,
    },
  };

  if (capability.type === "mcp-tool") {
    return taskClass === "mcp_delegation" ? 0.94 : 0.22;
  }
  if (capability.type === "plugin-tool") {
    return taskClass === "mcp_delegation" ? 0.42 : 0.18;
  }
  if (capability.type === "web-tool") {
    return byTask[taskClass]?.[name] ?? (taskClass === "official_docs_lookup" ? 0.7 : 0.32);
  }
  return byTask[taskClass]?.[name] ?? 0.16;
}

function inferRequiredCapabilities(
  taskClassification: TaskClassification | null | undefined,
  routingMode: string,
): string[] {
  const taskClass = taskClassification?.taskClass ?? "repo_understanding";
  const required = new Set(["policy"]);

  if (["repo_understanding", "code_edit", "bug_fix", "refactor", "test_repair", "config_inspection", "risk_review"].includes(taskClass)) {
    required.add("local-read");
  }
  if (["code_edit", "bug_fix", "refactor", "test_repair"].includes(taskClass)) {
    required.add("edit-path");
  }
  if (taskClassification?.likelyShell) {
    required.add("shell");
  }
  if (taskClassification?.likelyWeb || routingMode === "docs-first" || routingMode === "official-first") {
    required.add("web");
  }
  if (taskClassification?.likelyMcp || routingMode === "external-capability-first") {
    required.add("mcp");
  }
  if (taskClass === "memory_lookup") {
    required.add("memory");
  }

  return [...required];
}

function ensureBlockedCategory(
  requiredCapabilities: string[],
  blockedCapabilities: CapabilityRouteEntry[],
  selectedCapabilities: CapabilityRouteEntry[],
  context: {
    networkMode: string;
    mcpEnabled: boolean;
    scorecard: RuntimeHealthScorecard;
  },
): void {
  if (requiredCapabilities.includes("web") && !selectedCapabilities.some((entry) => entry.type === "web-tool")) {
    blockedCapabilities.push({
      id: "category:web",
      name: "web",
      displayName: "Web Retrieval",
      source: "web",
      type: "web-tool",
      riskCategory: "network",
      score: 0,
      reasons: [],
      blockedReason:
        context.networkMode === "off"
          ? "Web routing is blocked because network mode is off."
          : (context.scorecard?.degradedFlags ?? []).includes("web_circuit_open")
            ? "Web routing is blocked because the web circuit is open."
            : "No active web capability met the routing budget.",
    });
  }
  if (requiredCapabilities.includes("mcp") && !selectedCapabilities.some((entry) => entry.type === "mcp-tool")) {
    blockedCapabilities.push({
      id: "category:mcp",
      name: "mcp",
      displayName: "MCP Delegation",
      source: "mcp",
      type: "mcp-tool",
      riskCategory: "external",
      score: 0,
      reasons: [],
      blockedReason:
        context.mcpEnabled === false
          ? "MCP routing is blocked because MCP is disabled."
          : (context.scorecard?.degradedFlags ?? []).includes("mcp_circuit_open")
            ? "MCP routing is blocked because the MCP circuit is open."
            : "No active MCP capability met the routing budget.",
    });
  }
}

function inferRankingMode(
  taskClassification: TaskClassification | null | undefined,
  routingMode: string,
): string {
  if (routingMode === "official-first") {
    return "official-first";
  }
  if (routingMode === "docs-first" || taskClassification?.taskClass === "official_docs_lookup") {
    return "docs-first";
  }
  return "balanced";
}

function explainRoutingMode(routingMode: string): string[] {
  switch (routingMode) {
    case "constrained-safe-mode":
      return ["Routing is constrained by current safety or runtime degradation signals."];
    case "official-first":
      return ["Routing prioritizes official documentation and canonical sources."];
    case "docs-first":
      return ["Routing prioritizes documentation-oriented retrieval before broader capabilities."];
    case "external-capability-first":
      return ["Routing prioritizes external capabilities because the task explicitly targets them."];
    default:
      return ["Routing prefers local capabilities first and expands outward only when needed."];
  }
}

function explainGovernance({
  taskClassification,
  networkMode,
  permissionMode,
  blockedCapabilities,
  scorecard,
}: RouterGovernanceContext): string[] {
  const reasons = [];
  if (permissionMode === "read-only" && taskClassification?.likelyWrites) {
    reasons.push("Write-oriented capabilities are constrained by read-only mode.");
  }
  if (networkMode === "off" && taskClassification?.likelyWeb) {
    reasons.push("Web retrieval is suppressed because network mode is off.");
  }
  if ((scorecard?.degradedFlags ?? []).includes("web_circuit_open")) {
    reasons.push("Web routing is degraded because the web circuit is open.");
  }
  if ((scorecard?.degradedFlags ?? []).includes("mcp_circuit_open")) {
    reasons.push("MCP routing is degraded because the MCP circuit is open.");
  }
  if (blockedCapabilities.some((entry) => entry.type === "plugin-tool")) {
    reasons.push("Plugin tools stay behind builtin/web/MCP unless the task clearly justifies them.");
  }
  return reasons;
}

function explainPolicy(policy: RoutePolicyLike | null | undefined): string[] {
  return (policy?.sources ?? [])
    .slice(0, 2)
    .map((entry) => `Policy source in scope: ${entry.title ?? entry.id}.`);
}

function mapCapabilityToRequired(capability: CapabilityRouteEntry): string {
  if (capability.type === "web-tool") {
    return "web";
  }
  if (capability.type === "mcp-tool") {
    return "mcp";
  }
  if (capability.type === "memory") {
    return "memory";
  }
  if (capability.riskCategory === "exec") {
    return "shell";
  }
  if (capability.riskCategory === "write") {
    return "edit-path";
  }
  if (capability.type === "instruction/policy") {
    return "policy";
  }
  return "local-read";
}

function inferRejectedReason(capability: CapabilitySummary, taskClass: string): string {
  if (capability.type === "plugin-tool") {
    return "Plugin capability is available but higher-cost than builtin/web/MCP paths for this task.";
  }
  if (capability.type === "mcp-tool" && taskClass !== "mcp_delegation") {
    return "MCP delegation is available but not the primary path for this task.";
  }
  if (capability.type === "web-tool" && !["web_retrieval", "official_docs_lookup"].includes(taskClass)) {
    return "Web retrieval is available but not preferred for this task class.";
  }
  return "Capability remained below the current routing budget.";
}

function collectSkillToolPreferences(activeSkills: ActiveSkillLike[], key: "prefer" | "avoid"): Set<string> {
  const entries = new Set<string>();
  for (const skill of activeSkills) {
    for (const toolName of skill?.toolPreferences?.[key] ?? []) {
      entries.add(toolName);
    }
  }
  return entries;
}

function blockedResult(score: number, reasons: string[], blockedReason: string): CapabilityEvaluation {
  return {
    blocked: true,
    blockedReason,
    score: Math.max(0, Math.min(1.2, score)),
    reasons: dedupeStrings(reasons),
  };
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean) as string[])];
}

function resolveRuntimeScorecard(
  runtimeHealth: RouteContext["runtimeHealth"],
): RuntimeHealthScorecard {
  if (!runtimeHealth) {
    return {
      degradedFlags: [],
      circuits: { byLayer: {} },
    };
  }
  if (typeof runtimeHealth === "object" && runtimeHealth !== null && "scorecard" in runtimeHealth) {
    const candidate = runtimeHealth.scorecard;
    if (candidate && typeof candidate === "object") {
      return candidate as RuntimeHealthScorecard;
    }
  }
  if (typeof runtimeHealth === "object" && runtimeHealth !== null && "getScorecard" in runtimeHealth) {
    const getter = runtimeHealth.getScorecard;
    if (typeof getter === "function") {
      return getter.call(runtimeHealth) as RuntimeHealthScorecard;
    }
  }
  return runtimeHealth as RuntimeHealthScorecard;
}
