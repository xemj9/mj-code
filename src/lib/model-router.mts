import { getModelMetadata } from "./model-metadata.mjs";
import type {
  CapabilitySummary,
  ModelDecision,
  ModelFallbackEntry,
  ResolvedConfig,
  RouteDecision,
  RuntimeHealthScorecard,
  RuntimePressure,
  TaskClassification,
} from "../types/contracts.js";

interface ModelMetadata {
  contextWindow: number;
  family?: string;
}

interface RuntimeHealthCarrier {
  scorecard?: RuntimeHealthScorecard;
  getScorecard?: () => RuntimeHealthScorecard;
}

export class ModelRouter {
  private readonly config: Partial<ResolvedConfig>;

  constructor(config: Partial<ResolvedConfig> = {}) {
    this.config = config;
  }

  route({
    taskClassification,
    routeDecision,
    runtimeHealth,
    availableModels = null,
    currentModel = null,
    provider = null,
  }: {
    taskClassification?: TaskClassification | null;
    routeDecision?: RouteDecision | null;
    runtimeHealth?: RuntimeHealthScorecard | RuntimeHealthCarrier | null;
    availableModels?: string[] | null;
    currentModel?: string | null;
    provider?: string | null;
  }): ModelDecision {
    const chosenProvider = provider ?? this.config.provider ?? null;
    const models = normalizeModels(availableModels, currentModel ?? this.config.model);
    const scorecard = resolveRuntimeScorecard(runtimeHealth);
    const taskClass = taskClassification?.taskClass ?? "repo_understanding";
    const estimatedContextNeed = estimateContextNeed(taskClass, routeDecision);
    const latencyTarget = inferLatencyTarget(taskClass);
    const costSensitivity = inferCostSensitivity(taskClass);
    const runtimePressure = inferRuntimePressure(scorecard, taskClass);

    const ranked = models.map((modelName) => {
      const metadata = getModelMetadata({
        model: modelName,
        provider: chosenProvider,
        maxOutputTokens: this.config.maxTokens,
      }) as ModelMetadata;
      const score = scoreModel(modelName, metadata, {
        taskClass,
        estimatedContextNeed,
        latencyTarget,
        costSensitivity,
        runtimePressure,
      });
      return {
        model: modelName,
        score,
        metadata,
      };
    }).sort((left, right) => right.score - left.score || left.model.localeCompare(right.model));

    const chosen = ranked[0] ?? {
      model: currentModel ?? this.config.model ?? "unknown",
      score: 0,
      metadata: getModelMetadata({
        model: currentModel ?? this.config.model ?? "unknown",
        provider: chosenProvider,
        maxOutputTokens: this.config.maxTokens,
      }) as ModelMetadata,
    };
    const fallbackChain = buildFallbackChain(ranked, chosen.model, runtimePressure, taskClass);

    return {
      chosenProvider,
      chosenModel: chosen.model,
      fallbackModels: fallbackChain.map((entry) => entry.model),
      fallbackChain,
      reason: buildReason(chosen, {
        taskClass,
        latencyTarget,
        costSensitivity,
        degradedFlags: scorecard?.degradedFlags ?? [],
        runtimePressure,
      }),
      estimatedContextNeed,
      latencyTarget,
      costSensitivity,
      candidates: ranked.slice(0, 5).map((entry) => ({
        model: entry.model,
        score: Number(entry.score.toFixed(4)),
        contextWindow: entry.metadata.contextWindow,
        family: entry.metadata.family,
      })),
      healthAware: Boolean((scorecard?.degradedFlags ?? []).length),
      degradedFlags: scorecard?.degradedFlags ?? [],
      runtimePressure,
    };
  }
}

function resolveRuntimeScorecard(runtimeHealth: RuntimeHealthScorecard | RuntimeHealthCarrier | null | undefined): RuntimeHealthScorecard {
  if (!runtimeHealth) {
    return {
      degradedFlags: [],
      provider: {},
    };
  }
  const carrier = runtimeHealth as RuntimeHealthCarrier;
  if (carrier.scorecard && Array.isArray(carrier.scorecard.degradedFlags)) {
    return carrier.scorecard;
  }
  if (typeof carrier.getScorecard === "function") {
    const scorecard = carrier.getScorecard();
    if (scorecard && Array.isArray(scorecard.degradedFlags)) {
      return scorecard;
    }
  }
  if ("degradedFlags" in runtimeHealth && Array.isArray(runtimeHealth.degradedFlags)) {
    return runtimeHealth;
  }
  return {
    degradedFlags: [],
    provider: {},
  };
}

function normalizeModels(availableModels: string[] | null | undefined, currentModel: string | null | undefined): string[] {
  const models = new Set<string>();
  for (const entry of Array.isArray(availableModels) ? availableModels : []) {
    if (typeof entry === "string" && entry.trim()) {
      models.add(entry.trim());
    }
  }
  if (currentModel) {
    models.add(currentModel);
  }
  return [...models];
}

function estimateContextNeed(taskClass: string, routeDecision: RouteDecision | null | undefined): string {
  const base = {
    repo_understanding: "high",
    code_edit: "medium",
    bug_fix: "medium",
    refactor: "high",
    test_repair: "medium",
    shell_execution: "low",
    web_retrieval: "medium",
    official_docs_lookup: "medium",
    mcp_delegation: "medium",
    memory_lookup: "low",
    config_inspection: "low",
    risk_review: "medium",
  }[taskClass] ?? "medium";

  const selectedCapabilities: CapabilitySummary[] = Array.isArray(routeDecision?.selectedCapabilities)
    ? routeDecision.selectedCapabilities
    : [];
  if (selectedCapabilities.some((entry) => entry.type === "mcp-tool")) {
    return base === "low" ? "medium" : base;
  }
  return base;
}

function inferLatencyTarget(taskClass: string): string {
  if (["shell_execution", "memory_lookup", "config_inspection"].includes(taskClass)) {
    return "fast";
  }
  if (["web_retrieval", "official_docs_lookup"].includes(taskClass)) {
    return "balanced";
  }
  return "thorough";
}

function inferCostSensitivity(taskClass: string): string {
  if (["shell_execution", "memory_lookup", "config_inspection"].includes(taskClass)) {
    return "high";
  }
  if (["repo_understanding", "web_retrieval", "official_docs_lookup"].includes(taskClass)) {
    return "medium";
  }
  return "low";
}

function scoreModel(modelName: string, metadata: ModelMetadata, context: {
  taskClass: string;
  estimatedContextNeed: string;
  latencyTarget: string;
  costSensitivity: string;
  runtimePressure: RuntimePressure;
}): number {
  let score = 0.2;
  const normalized = modelName.toLowerCase();
  const isSmallVariant = /\b(mini|haiku|nano|flash)\b/.test(normalized);
  const isStrongReasoningFamily = /\b(gpt-5|codex|sonnet|opus|o4|o3)\b/.test(normalized);
  score += normalizeContextScore(metadata.contextWindow, context.estimatedContextNeed);

  if (context.latencyTarget === "fast" && isSmallVariant) {
    score += 0.28;
  }
  if (context.latencyTarget === "thorough" && isStrongReasoningFamily) {
    score += 0.26;
  }
  if (context.taskClass === "official_docs_lookup" && /\b(mini|haiku)\b/.test(normalized)) {
    score += 0.08;
  }
  if (["bug_fix", "refactor", "code_edit", "test_repair"].includes(context.taskClass) && isStrongReasoningFamily) {
    score += 0.22;
  }
  if (context.costSensitivity === "high" && /\b(mini|haiku|nano)\b/.test(normalized)) {
    score += 0.15;
  }
  if (context.costSensitivity === "low" && /\b(opus|sonnet|gpt-5|codex|o4)\b/.test(normalized)) {
    score += 0.1;
  }
  if (["bug_fix", "refactor", "code_edit", "test_repair"].includes(context.taskClass)) {
    score += isSmallVariant ? -0.18 : 0.08;
  }
  if (["web_retrieval", "official_docs_lookup", "memory_lookup", "config_inspection"].includes(context.taskClass) && isSmallVariant) {
    score += 0.06;
  }
  if (context.runtimePressure.mode === "conservative" && isSmallVariant) {
    score += 0.14;
  }
  if (
    context.runtimePressure.mode === "conservative" &&
    !["bug_fix", "refactor", "code_edit", "test_repair"].includes(context.taskClass) &&
    !isSmallVariant
  ) {
    score -= 0.08;
  }
  if (
    context.runtimePressure.mode === "conservative" &&
    ["bug_fix", "refactor", "code_edit", "test_repair"].includes(context.taskClass) &&
    isStrongReasoningFamily &&
    !isSmallVariant
  ) {
    score += 0.04;
  }
  if (/\bpreview|beta|experimental\b/.test(normalized)) {
    score -= 0.04;
  }

  return score;
}

function inferRuntimePressure(scorecard: RuntimeHealthScorecard | null | undefined, taskClass: string): RuntimePressure {
  const providerSummary = scorecard?.provider ?? {};
  const degradedFlags = scorecard?.degradedFlags ?? [];
  const avgHealthScore = Number(providerSummary.avgHealthScore ?? 100);
  const retryPressure = Number(scorecard?.retryPressure ?? 0);
  const providerCircuits = scorecard?.circuits?.byLayer?.provider;
  const severe =
    degradedFlags.includes("provider_circuit_open") ||
    degradedFlags.includes("provider_half_open") ||
    degradedFlags.includes("high_retry_pressure") ||
    avgHealthScore < 72 ||
    retryPressure >= 0.35 ||
    Number(providerCircuits?.halfOpen ?? 0) > 0;

  return {
    mode: severe ? "conservative" : "balanced",
    avgHealthScore,
    retryPressure,
    degradedFlags,
    taskClass,
  };
}

function buildFallbackChain(
  ranked: Array<{ model: string; score: number }>,
  chosenModel: string,
  runtimePressure: RuntimePressure,
  taskClass: string,
): ModelFallbackEntry[] {
  const remaining = ranked.filter((entry) => entry.model !== chosenModel);
  if (remaining.length === 0) {
    return [];
  }

  const isCodingHeavy = ["bug_fix", "refactor", "code_edit", "test_repair"].includes(taskClass);
  const prioritized = runtimePressure.mode === "conservative"
    ? remaining.slice().sort((left, right) => {
        const leftSmall = /\b(mini|haiku|nano|flash)\b/.test(left.model.toLowerCase()) ? 1 : 0;
        const rightSmall = /\b(mini|haiku|nano|flash)\b/.test(right.model.toLowerCase()) ? 1 : 0;
        if (isCodingHeavy) {
          return right.score - left.score || left.model.localeCompare(right.model);
        }
        return rightSmall - leftSmall || right.score - left.score || left.model.localeCompare(right.model);
      })
    : remaining;

  return prioritized.slice(0, 4).map((entry, index) => ({
    model: entry.model,
    score: Number(entry.score.toFixed(4)),
    order: index + 1,
    strategy:
      runtimePressure.mode === "conservative"
        ? "runtime_health_fallback"
        : "ranked_fallback",
  }));
}

function normalizeContextScore(contextWindow: number, estimatedContextNeed: string): number {
  if (estimatedContextNeed === "high") {
    return Math.min(0.4, contextWindow / 300000);
  }
  if (estimatedContextNeed === "medium") {
    return Math.min(0.28, contextWindow / 450000);
  }
  return Math.min(0.18, contextWindow / 700000);
}

function buildReason(chosen: { model: string }, context: {
  taskClass: string;
  latencyTarget: string;
  costSensitivity: string;
  degradedFlags: string[];
  runtimePressure: RuntimePressure;
}): string {
  const parts = [
    `Selected ${chosen.model} for ${context.taskClass}.`,
    `Latency target is ${context.latencyTarget}.`,
    `Cost sensitivity is ${context.costSensitivity}.`,
    context.runtimePressure?.mode === "conservative"
      ? `Runtime pressure is elevated (health=${context.runtimePressure.avgHealthScore}, retryPressure=${context.runtimePressure.retryPressure}).`
      : "Runtime pressure is currently balanced.",
    context.degradedFlags.length > 0
      ? `Runtime degraded flags in scope: ${context.degradedFlags.join(", ")}.`
      : "No runtime degraded flags are currently active.",
  ];
  return parts.join(" ");
}
