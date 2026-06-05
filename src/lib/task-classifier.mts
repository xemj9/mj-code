import type { CapabilityRegistryLike } from "./capability-registry.mjs";

import type {
  CapabilitySummary,
  RuntimeHealthScorecard,
  TaskClassification,
  TraceSummary,
} from "../types/contracts.js";

const TASK_CLASSES = [
  "repo_understanding",
  "code_edit",
  "bug_fix",
  "refactor",
  "test_repair",
  "shell_execution",
  "web_retrieval",
  "official_docs_lookup",
  "mcp_delegation",
  "memory_lookup",
  "config_inspection",
  "risk_review",
] as const;

type TaskClass = (typeof TASK_CLASSES)[number];

interface TaskClassifierConfig {
  [key: string]: unknown;
}

interface TaskClassifierContext {
  activeSkills?: unknown[];
  capabilities?: CapabilitySummary[];
  capabilityRegistry?: Pick<CapabilityRegistryLike, "list"> | null;
  runtimeScorecard?: RuntimeHealthScorecard | null;
  runtimeHealth?: {
    scorecard?: RuntimeHealthScorecard | null;
  } | null;
  networkMode?: string;
  permissionMode?: string;
  lastTrace?: TraceSummary | null;
}

interface RankedTaskCandidate {
  taskClass: TaskClass;
  score: number;
  reasons: string[];
}

export class TaskClassifier {
  readonly config: TaskClassifierConfig;

  constructor(config: TaskClassifierConfig = {}) {
    this.config = config;
  }

  classify(prompt: string, context: TaskClassifierContext = {}): TaskClassification {
    const text = `${prompt ?? ""}`.trim();
    const normalized = text.toLowerCase();
    const activeSkills = Array.isArray(context.activeSkills) ? context.activeSkills : [];
    const capabilitySurface = Array.isArray(context.capabilities)
      ? context.capabilities
      : context.capabilityRegistry?.list() ?? [];
    const runtimeScorecard = context.runtimeScorecard ?? context.runtimeHealth?.scorecard ?? null;

    const scores = new Map<TaskClass, RankedTaskCandidate>(
      TASK_CLASSES.map((taskClass) => [
        taskClass,
        {
          taskClass,
          score: 0.08,
          reasons: [],
        },
      ]),
    );

    applyRule(scores, "repo_understanding", normalized, [
      /\b(understand|overview|architecture|how does|where is|find where|walk through|explain the repo|understand the codebase)\b/,
    ], 0.55, "The prompt asks for repository understanding or explanation.");

    applyRule(scores, "code_edit", normalized, [
      /\b(implement|add|edit|modify|change|update|create|build|wire up|integrate)\b/,
      /\b(file|module|function|class|component|readme|cli)\b/,
    ], 0.32, "The prompt implies code or file edits.");

    applyRule(scores, "bug_fix", normalized, [
      /\b(bug|fix|broken|issue|error|regression|not working|fails|failure)\b/,
    ], 0.6, "The prompt is framed as a bug or failure to fix.");

    applyRule(scores, "refactor", normalized, [
      /\b(refactor|reorganize|rename|extract|clean up|simplify|restructure)\b/,
    ], 0.72, "The prompt asks for structural code changes.");

    applyRule(scores, "test_repair", normalized, [
      /\b(test repair|repair tests|make tests pass|failing tests|broken tests|fix tests|update tests)\b/,
      /\b(pytest|vitest|jest|mocha|ava|cargo test|npm test|pnpm test|bun test)\b/,
    ], 0.8, "The prompt is explicitly about failing tests or verification.");

    applyRule(scores, "shell_execution", normalized, [
      /\b(run|execute|shell|terminal|command|script|build|compile|install|tail logs|jobs)\b/,
      /\b(npm|pnpm|yarn|bun|pytest|vitest|jest|cargo|make|git|bash|zsh)\b/,
    ], 0.46, "The prompt expects terminal or command execution.");

    applyRule(scores, "web_retrieval", normalized, [
      /\b(search|look up|browse|web|internet|online|website|release notes|pricing|news|latest|today|recent|current)\b/,
      /\b(link|citation|source|official site|documentation)\b/,
    ], 0.44, "The prompt calls for fresh or web-derived information.");

    applyRule(scores, "official_docs_lookup", normalized, [
      /\b(official docs|official documentation|api docs|sdk docs|reference docs|manual|reference)\b/,
      /\b(openai|anthropic|claude|codex|continue|openhands|aider|mcp)\b/,
    ], 0.62, "The prompt explicitly asks for official documentation.");

    applyRule(scores, "mcp_delegation", normalized, [
      /\b(mcp|model context protocol|external tool|server tool|connector|delegat(e|ion) to mcp)\b/,
    ], 0.82, "The prompt explicitly references MCP or external tool servers.");

    applyRule(scores, "memory_lookup", normalized, [
      /\b(memory|remember|recall|what did we decide|previously|earlier session|history preference)\b/,
    ], 0.76, "The prompt asks to retrieve or use stored memory.");

    applyRule(scores, "config_inspection", normalized, [
      /\b(config|configuration|settings|env|environment variable|permission mode|approval policy|network mode|provider|model)\b/,
      /\b(show|inspect|check|what is|which)\b/,
    ], 0.56, "The prompt asks about configuration or runtime settings.");

    applyRule(scores, "risk_review", normalized, [
      /\b(review|audit|risk|safety|approval|permission|dangerous|should we|governance)\b/,
    ], 0.5, "The prompt asks for review, safety, or risk assessment.");

    if (/\b(latest|current|today|recent|up-to-date|fresh)\b/.test(normalized)) {
      boostScore(scores, "web_retrieval", 0.18, "The task requires fresh information.");
      boostScore(scores, "official_docs_lookup", 0.12, "The task benefits from current documentation.");
    }

    if (
      /\b(claude code|codex|openclaw|goose|openhands|continue|aider)\b/.test(normalized) &&
      /\b(compare|benchmark|docs|workflow|planning|route|eval)\b/.test(normalized)
    ) {
      boostScore(
        scores,
        "official_docs_lookup",
        0.16,
        "The task references public tooling/docs that benefit from official documentation.",
      );
    }

    if (/\b(continue|resume|again|keep going)\b/.test(normalized) && context.lastTrace?.filesChanged?.length) {
      boostScore(
        scores,
        "code_edit",
        0.08,
        "The session context suggests continuation of prior implementation work.",
      );
    }

    const webCapabilities = capabilitySurface.filter(
      (entry) => entry.type === "web-tool" && entry.active,
    );
    const mcpCapabilities = capabilitySurface.filter(
      (entry) => entry.type === "mcp-tool" && entry.active,
    );
    if (webCapabilities.length === 0) {
      dampenScore(scores, "web_retrieval", 0.08, "No active web capabilities are currently available.");
      dampenScore(
        scores,
        "official_docs_lookup",
        0.05,
        "No active web capabilities are currently available.",
      );
    }
    if (mcpCapabilities.length === 0) {
      dampenScore(scores, "mcp_delegation", 0.18, "No active MCP capabilities are currently available.");
    }

    const preferredTools = collectPreferredTools(activeSkills);
    if (preferredTools.has("web_search") || preferredTools.has("extract_content")) {
      boostScore(
        scores,
        "official_docs_lookup",
        0.08,
        "Active skills prefer docs-oriented retrieval tools.",
      );
      boostScore(scores, "web_retrieval", 0.05, "Active skills prefer retrieval tools.");
    }
    if (preferredTools.has("run_shell")) {
      boostScore(scores, "shell_execution", 0.05, "Active skills prefer shell execution.");
    }

    const degradedFlags = runtimeScorecard?.degradedFlags ?? [];
    if (degradedFlags.includes("web_circuit_open")) {
      dampenScore(scores, "web_retrieval", 0.04, "The web runtime is degraded right now.");
      dampenScore(scores, "official_docs_lookup", 0.03, "The web runtime is degraded right now.");
    }
    if (degradedFlags.includes("mcp_circuit_open")) {
      dampenScore(scores, "mcp_delegation", 0.08, "The MCP runtime is degraded right now.");
    }
    if (degradedFlags.includes("provider_circuit_open")) {
      boostScore(
        scores,
        "risk_review",
        0.06,
        "The provider runtime is degraded, so routing should stay conservative.",
      );
    }

    if (context.networkMode === "off") {
      dampenScore(scores, "web_retrieval", 0.1, "Network mode is off.");
      dampenScore(scores, "official_docs_lookup", 0.08, "Network mode is off.");
    }

    const ranked = [...scores.values()].sort(
      (left, right) => right.score - left.score || left.taskClass.localeCompare(right.taskClass),
    );
    const winner = ranked[0];
    const runnerUp = ranked[1] ?? { score: 0 };
    const confidence = clampScore(
      0.34 + winner.score * 0.48 + Math.max(0, winner.score - runnerUp.score) * 0.45,
      0.18,
      0.99,
    );

    const likelyWrites = ["code_edit", "bug_fix", "refactor", "test_repair"].includes(winner.taskClass);
    const likelyShell =
      winner.taskClass === "shell_execution" ||
      winner.taskClass === "test_repair" ||
      /\b(run|execute|test|build|lint|check|tail|attach)\b/.test(normalized);
    const likelyWeb =
      ["web_retrieval", "official_docs_lookup"].includes(winner.taskClass) ||
      /\b(search|web|browse|latest|docs|documentation|citation|source)\b/.test(normalized);
    const likelyMcp =
      winner.taskClass === "mcp_delegation" ||
      /\b(mcp|connector|external server|tool server)\b/.test(normalized);
    const freshnessRequired =
      winner.taskClass === "official_docs_lookup" ||
      /\b(latest|current|today|recent|up-to-date|fresh|official docs)\b/.test(normalized);
    const externalCapabilityNeeded = likelyWeb || likelyMcp;

    return {
      taskClass: winner.taskClass,
      confidence: Number(confidence.toFixed(4)),
      lowConfidence: confidence < 0.6 || winner.score - runnerUp.score < 0.08,
      reasons: dedupeStrings(winner.reasons).slice(0, 6),
      freshnessRequired,
      externalCapabilityNeeded,
      likelyWrites,
      likelyShell,
      likelyWeb,
      likelyMcp,
      riskHint: classifyRiskHint({
        taskClass: winner.taskClass,
        likelyWrites,
        likelyShell,
        likelyWeb,
        likelyMcp,
        permissionMode: context.permissionMode,
      }),
      runtimeSignals: dedupeStrings(degradedFlags).slice(0, 8),
      capabilitySignals: {
        activeWeb: webCapabilities.length,
        activeMcp: mcpCapabilities.length,
        activeSkills: activeSkills.length,
      },
      rankedCandidates: ranked.slice(0, 4).map((entry) => ({
        taskClass: entry.taskClass,
        score: Number(entry.score.toFixed(4)),
        reasons: dedupeStrings(entry.reasons).slice(0, 3),
      })),
    };
  }
}

function applyRule(
  scores: Map<TaskClass, RankedTaskCandidate>,
  taskClass: TaskClass,
  normalizedPrompt: string,
  patterns: RegExp[],
  weight: number,
  reason: string,
): void {
  const matched = patterns.some((pattern) => pattern.test(normalizedPrompt));
  if (!matched) {
    return;
  }
  boostScore(scores, taskClass, weight, reason);
}

function boostScore(
  scores: Map<TaskClass, RankedTaskCandidate>,
  taskClass: TaskClass,
  amount: number,
  reason: string,
): void {
  const current = scores.get(taskClass);
  if (!current) {
    return;
  }
  current.score += amount;
  if (reason) {
    current.reasons.push(reason);
  }
}

function dampenScore(
  scores: Map<TaskClass, RankedTaskCandidate>,
  taskClass: TaskClass,
  amount: number,
  reason: string,
): void {
  const current = scores.get(taskClass);
  if (!current) {
    return;
  }
  current.score = Math.max(0.01, current.score - amount);
  if (reason) {
    current.reasons.push(reason);
  }
}

function collectPreferredTools(activeSkills: unknown[]): Set<string> {
  const preferred = new Set<string>();
  for (const skill of activeSkills) {
    const toolPreferences = isObject(skill) && isObject(skill.toolPreferences)
      ? skill.toolPreferences
      : null;
    const preferredTools = Array.isArray(toolPreferences?.prefer)
      ? toolPreferences.prefer
      : [];
    for (const toolName of preferredTools) {
      if (typeof toolName === "string" && toolName.length > 0) {
        preferred.add(toolName);
      }
    }
  }
  return preferred;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function classifyRiskHint(input: {
  taskClass: TaskClass;
  likelyWrites: boolean;
  likelyShell: boolean;
  likelyWeb: boolean;
  likelyMcp: boolean;
  permissionMode?: string;
}): "low" | "medium" | "high" {
  if (input.permissionMode === "read-only" && (input.likelyWrites || input.likelyShell)) {
    return "high";
  }
  if (["risk_review", "mcp_delegation"].includes(input.taskClass)) {
    return "high";
  }
  if (input.likelyWrites && input.likelyShell) {
    return "high";
  }
  if (input.likelyWrites || input.likelyWeb || input.likelyMcp || input.likelyShell) {
    return "medium";
  }
  return "low";
}

function clampScore(value: number, minValue = 0, maxValue = 1): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function dedupeStrings(values: unknown[]): string[] {
  return [...new Set((Array.isArray(values) ? values : []).filter(isNonEmptyString))];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
