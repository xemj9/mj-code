import { estimateTokensFromMessages, estimateTokensFromText, getModelMetadata } from "./model-metadata.mjs";
import { abbreviate } from "./path-utils.mjs";

import type {
  ContextPlanMeta,
  ContextRoutingBrief,
  ContextSkillSummary,
  ContextSourceSummary,
  ExecutionPlan,
  InstructionPack,
  MemoryContextPack,
  ModelDecision,
  ResolvedConfig,
  RouteDecision,
  RuntimeHealthOverview,
  TaskClassification,
} from "../types/contracts.js";

const MIN_RECENT_MESSAGES = 6;

interface MessageLike {
  role?: string;
  content?: unknown;
  toolCalls?: Array<{ name?: string }>;
  [key: string]: unknown;
}

interface ContextManagerConfig extends Pick<ResolvedConfig, "provider" | "model" | "maxTokens"> {}

interface PreparedModelMetadata {
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
}

interface BudgetAllocation {
  totalInputBudget: number;
  system: number;
  summary: number;
  memory: number;
  recentMessages: number;
  currentMessageTokens: number;
}

interface MemoryStoreLike {
  getContextPack(query: string, options?: {
    maxTokens?: number;
    limit?: number;
    scopes?: string[];
  }): Promise<MemoryContextPack>;
}

interface SourceRegistryLike {
  getLastPack?(): { sourceIds?: string[] } | null;
  getSource?(sourceId: string): {
    sourceId: string;
    title: string;
    domain: string;
    excerpt?: string | null;
  } | null;
}

interface SkillLike {
  id?: string;
  active?: boolean;
  description?: string;
  influenceSummary?: string;
}

interface PolicyLike {
  sources?: Array<{
    id?: string;
    title?: string;
  }>;
}

interface PrepareContextOptions {
  baseSystemPrompt: string;
  messages: MessageLike[];
  userPrompt: string;
  memoryStore: MemoryStoreLike;
  model?: string | null;
  taskClassification?: TaskClassification | null;
  routeDecision?: RouteDecision | null;
  modelDecision?: ModelDecision | null;
  executionPlan?: ExecutionPlan | null;
  activeSkills?: SkillLike[];
  instructions?: InstructionPack | null;
  sourceRegistry?: SourceRegistryLike | null;
  policy?: PolicyLike | null;
  runtimeHealth?: RuntimeHealthOverview | { scorecard?: { degradedFlags?: string[] } } | null;
}

interface PrepareContextResult {
  systemPrompt: string;
  messages: MessageLike[];
  meta: ContextPlanMeta;
}

interface CompactResult {
  messages: MessageLike[];
  compactedMessages: number;
  rollingSummary: string;
}

interface ContextManagerHydrateState {
  rollingSummary?: string;
  lastPlan?: ContextPlanMeta | null;
}

export class ContextManager {
  readonly config: ContextManagerConfig;
  rollingSummary: string;
  lastPlan: ContextPlanMeta | null;

  constructor(config: ContextManagerConfig) {
    this.config = config;
    this.rollingSummary = "";
    this.lastPlan = null;
  }

  async prepare({
    baseSystemPrompt,
    messages,
    userPrompt,
    memoryStore,
    model = null,
    taskClassification = null,
    routeDecision = null,
    modelDecision = null,
    executionPlan = null,
    activeSkills = [],
    instructions = null,
    sourceRegistry = null,
    policy = null,
    runtimeHealth = null,
  }: PrepareContextOptions): Promise<PrepareContextResult> {
    const metadata = getModelMetadata({
      model: model ?? modelDecision?.chosenModel ?? this.config.model,
      provider: modelDecision?.chosenProvider ?? this.config.provider,
      maxOutputTokens: this.config.maxTokens,
    }) as PreparedModelMetadata;
    const budgets = allocateBudgets({
      baseSystemPrompt,
      messages,
      metadata,
      maxOutputTokens: this.config.maxTokens,
    });

    const preparedMessages = [...messages];
    let compactedMessages = 0;

    while (
      preparedMessages.length > MIN_RECENT_MESSAGES &&
      estimateTokensFromMessages(preparedMessages) > budgets.recentMessages
    ) {
      const chunkSize = Math.min(2, preparedMessages.length - MIN_RECENT_MESSAGES);
      const chunk = preparedMessages.splice(0, chunkSize);
      this.rollingSummary = mergeSummaries(
        this.rollingSummary,
        summarizeMessages(chunk),
        budgets.summary,
      );
      compactedMessages += chunk.length;
    }

    const memoryBudget = adjustMemoryBudget(budgets.memory, taskClassification);
    const memoryPack = await memoryStore.getContextPack(userPrompt, {
      maxTokens: memoryBudget,
      limit: 8,
    });
    const summaryText = abbreviate(this.rollingSummary, budgets.summary * 4);
    const sourceContext = buildSourceContext(sourceRegistry, taskClassification, routeDecision);
    const skillContext = buildSkillContext(activeSkills);
    const routingContext = buildRoutingContext({
      taskClassification,
      routeDecision,
      modelDecision,
      executionPlan,
      policy,
      runtimeHealth,
    });
    const selectedContextKinds: string[] = [];
    const skippedContextKinds: string[] = [];

    const runtimeSections = [
      summaryText
        ? pushSelected(selectedContextKinds, "rolling_summary", `Rolling conversation summary:\n${summaryText}`)
        : pushSkipped(skippedContextKinds, "rolling_summary"),
      memoryPack.text
        ? pushSelected(selectedContextKinds, "memory", `Retrieved memories:\n${memoryPack.text}`)
        : pushSkipped(skippedContextKinds, "memory"),
      routingContext.taskBrief
        ? pushSelected(selectedContextKinds, "task_brief", routingContext.taskBrief)
        : pushSkipped(skippedContextKinds, "task_brief"),
      routingContext.routeBrief
        ? pushSelected(selectedContextKinds, "route_decision", routingContext.routeBrief)
        : pushSkipped(skippedContextKinds, "route_decision"),
      routingContext.planBrief
        ? pushSelected(selectedContextKinds, "execution_plan", routingContext.planBrief)
        : pushSkipped(skippedContextKinds, "execution_plan"),
      skillContext.text
        ? pushSelected(selectedContextKinds, "skills", skillContext.text)
        : pushSkipped(skippedContextKinds, "skills"),
      sourceContext.text
        ? pushSelected(selectedContextKinds, "sources", sourceContext.text)
        : pushSkipped(skippedContextKinds, "sources"),
      routingContext.runtimeBrief
        ? pushSelected(selectedContextKinds, "runtime_health", routingContext.runtimeBrief)
        : pushSkipped(skippedContextKinds, "runtime_health"),
      [
        "Context selection policy:",
        "- retrieved items are ranked by importance + recency + task relevance + certainty",
        "- prefer summaries over raw history when the budget is tight",
        "- treat memory as guidance, not as unquestionable truth",
        sourceContext.mode === "sources-over-memory"
          ? "- prioritize fresh sources over old memory when the task needs current evidence"
          : "- use memory and local context first unless fresh external evidence is clearly needed",
      ].join("\n"),
    ].filter(Boolean);

    const systemPrompt = [baseSystemPrompt, ...runtimeSections].join("\n\n");

    this.lastPlan = {
      instructionSummary: {
        entryCount: (instructions?.entries ?? []).length,
        ruleCount: (instructions?.rules ?? []).length,
        layers: [...new Set((instructions?.entries ?? []).map((entry) => entry.layer))],
        files: instructions?.files ?? [],
      },
      model: metadata.model,
      contextWindow: metadata.contextWindow,
      outputReserve: metadata.maxOutputTokens,
      budgets,
      estimatedInputTokens:
        estimateTokensFromText(systemPrompt) + estimateTokensFromMessages(preparedMessages),
      compactedMessages,
      rollingSummaryTokens: estimateTokensFromText(summaryText),
      memoryItems: memoryPack.items.length,
      memoryTokens: memoryPack.usedTokens,
      selectedContextKinds,
      skippedContextKinds,
      selectedSourceIds: sourceContext.sourceIds,
      selectedSkillIds: skillContext.skillIds,
      selectedMemoryIds: memoryPack.items.map((item) => item.id),
      policySources: (policy?.sources ?? []).map((entry) => entry.id).filter(Boolean) as string[],
      instructionEntryIds: (instructions?.entries ?? []).map((entry) => entry.id),
      instructionLayers: [...new Set((instructions?.entries ?? []).map((entry) => entry.layer))],
      instructionFiles: instructions?.files ?? [],
      instructionRuleIds: (instructions?.rules ?? []).map((rule) => rule.id),
      contextSlicingMode: inferContextSlicingMode(taskClassification, routeDecision),
      memoryArbitration: sourceContext.mode,
      routingMode: routeDecision?.routingMode ?? null,
    };

    return {
      systemPrompt,
      messages: preparedMessages,
      meta: this.lastPlan,
    };
  }

  compact(messages: MessageLike[]): CompactResult {
    const preparedMessages = [...messages];
    if (preparedMessages.length <= MIN_RECENT_MESSAGES) {
      return {
        messages: preparedMessages,
        compactedMessages: 0,
        rollingSummary: this.rollingSummary,
      };
    }

    const chunk = preparedMessages.splice(0, preparedMessages.length - MIN_RECENT_MESSAGES);
    this.rollingSummary = mergeSummaries(this.rollingSummary, summarizeMessages(chunk), 800);
    this.lastPlan = {
      ...(this.lastPlan ?? {
        model: this.config.model ?? "unknown",
        contextWindow: 0,
        outputReserve: this.config.maxTokens,
        budgets: {
          totalInputBudget: 0,
          system: 0,
          summary: 0,
          memory: 0,
          recentMessages: 0,
          currentMessageTokens: 0,
        },
        estimatedInputTokens: 0,
        compactedMessages: 0,
        rollingSummaryTokens: 0,
        memoryItems: 0,
        memoryTokens: 0,
        selectedContextKinds: [],
        skippedContextKinds: [],
        selectedSourceIds: [],
        selectedSkillIds: [],
        selectedMemoryIds: [],
        policySources: [],
        instructionEntryIds: [],
        instructionLayers: [],
        instructionFiles: [],
        instructionRuleIds: [],
        instructionSummary: {
          entryCount: 0,
          ruleCount: 0,
          layers: [],
          files: [],
        },
        contextSlicingMode: "balanced",
        memoryArbitration: "memory-balanced",
        routingMode: null,
      }),
      compactedMessages: chunk.length,
      rollingSummaryTokens: estimateTokensFromText(this.rollingSummary),
      forcedCompaction: true,
    };

    return {
      messages: preparedMessages,
      compactedMessages: chunk.length,
      rollingSummary: this.rollingSummary,
    };
  }

  reset(): void {
    this.rollingSummary = "";
    this.lastPlan = null;
  }

  getLastPlan(): ContextPlanMeta | null {
    return this.lastPlan;
  }

  getRollingSummary(): string {
    return this.rollingSummary;
  }

  hydrate(state: ContextManagerHydrateState = {}): void {
    this.rollingSummary = typeof state.rollingSummary === "string" ? state.rollingSummary : "";
    this.lastPlan = state.lastPlan ?? null;
  }
}

function allocateBudgets({
  baseSystemPrompt,
  messages,
  metadata,
  maxOutputTokens,
}: {
  baseSystemPrompt: string;
  messages: MessageLike[];
  metadata: PreparedModelMetadata;
  maxOutputTokens: number;
}): BudgetAllocation {
  const totalInputBudget = Math.max(
    1200,
    metadata.contextWindow - Math.max(maxOutputTokens, metadata.maxOutputTokens) - 512,
  );
  const basePromptTokens = estimateTokensFromText(baseSystemPrompt);
  const currentMessageTokens = estimateTokensFromMessages(messages);
  const systemBudget = Math.max(basePromptTokens + 120, Math.floor(totalInputBudget * 0.22));
  const summaryBudget = Math.max(200, Math.floor(totalInputBudget * 0.12));
  const memoryBudget = Math.max(240, Math.floor(totalInputBudget * 0.16));
  const recentMessages = Math.max(
    400,
    totalInputBudget - systemBudget - summaryBudget - memoryBudget,
  );

  return {
    totalInputBudget,
    system: systemBudget,
    summary: summaryBudget,
    memory: memoryBudget,
    recentMessages,
    currentMessageTokens,
  };
}

function adjustMemoryBudget(
  memoryBudget: number,
  taskClassification: TaskClassification | null | undefined,
): number {
  const taskClass = taskClassification?.taskClass ?? null;
  if (["web_retrieval", "official_docs_lookup"].includes(taskClass ?? "")) {
    return Math.max(160, Math.floor(memoryBudget * 0.55));
  }
  if (taskClass === "mcp_delegation") {
    return Math.max(160, Math.floor(memoryBudget * 0.7));
  }
  return memoryBudget;
}

function inferContextSlicingMode(
  taskClassification: TaskClassification | null | undefined,
  routeDecision: RouteDecision | null | undefined,
): string {
  if (["official_docs_lookup", "web_retrieval"].includes(taskClassification?.taskClass ?? "")) {
    return "docs_lookup";
  }
  if (taskClassification?.taskClass === "mcp_delegation") {
    return "mcp_heavy";
  }
  if (taskClassification?.likelyShell) {
    return "shell_heavy";
  }
  if (["code_edit", "bug_fix", "refactor", "test_repair"].includes(taskClassification?.taskClass ?? "")) {
    return "edit_refactor";
  }
  if (routeDecision?.routingMode === "local-first") {
    return "repo_understanding";
  }
  return "balanced";
}

function buildRoutingContext({
  taskClassification,
  routeDecision,
  modelDecision,
  executionPlan,
  policy,
  runtimeHealth,
}: {
  taskClassification?: TaskClassification | null;
  routeDecision?: RouteDecision | null;
  modelDecision?: ModelDecision | null;
  executionPlan?: ExecutionPlan | null;
  policy?: PolicyLike | null;
  runtimeHealth?: RuntimeHealthOverview | { scorecard?: { degradedFlags?: string[] } } | null;
}): ContextRoutingBrief {
  const taskBrief = taskClassification
    ? [
        "Task classification:",
        `- class: ${taskClassification.taskClass}`,
        `- confidence: ${taskClassification.confidence}`,
        `- freshnessRequired: ${taskClassification.freshnessRequired ? "yes" : "no"}`,
        `- likelyWrites: ${taskClassification.likelyWrites ? "yes" : "no"}`,
        `- likelyShell: ${taskClassification.likelyShell ? "yes" : "no"}`,
      ].join("\n")
    : null;

  const selectedCapabilities = routeDecision?.selectedCapabilities?.map((entry) => entry.name).filter(Boolean) ?? [];
  const blockedCapabilities = routeDecision?.blockedCapabilities?.slice(0, 3).map((entry) => {
    const blockedReason =
      typeof (entry as { blockedReason?: unknown }).blockedReason === "string"
        ? (entry as { blockedReason?: string }).blockedReason
        : "blocked";
    return `${entry.name ?? entry.id}: ${blockedReason}`;
  }) ?? [];
  const routeBrief = routeDecision
    ? [
        "Routing decision:",
        `- mode: ${routeDecision.routingMode}`,
        `- selected: ${selectedCapabilities.join(", ") || "none"}`,
        `- blocked: ${blockedCapabilities.join(" | ") || "none"}`,
      ].join("\n")
    : null;

  const planBrief = executionPlan
    ? [
        "Execution plan:",
        ...executionPlan.steps.slice(0, 6).map((step, index) => `- ${index + 1}. [${step.status}] ${step.type}: ${step.title}`),
      ].join("\n")
    : null;

  const runtimeFlags = runtimeHealth?.scorecard?.degradedFlags ?? [];
  const runtimeBrief = [
    modelDecision
      ? `Model routing: provider=${modelDecision.chosenProvider} model=${modelDecision.chosenModel} reason=${modelDecision.reason}`
      : null,
    runtimeFlags.length > 0 ? `Runtime degraded flags: ${runtimeFlags.join(", ")}` : null,
    policy?.sources?.length
      ? `Policy sources in scope: ${policy.sources.slice(0, 3).map((entry) => entry.title ?? entry.id).join(", ")}`
      : null,
  ].filter(Boolean).join("\n");

  return {
    taskBrief,
    routeBrief,
    planBrief,
    runtimeBrief: runtimeBrief || null,
  };
}

function buildSkillContext(activeSkills: SkillLike[]): ContextSkillSummary {
  const active = (Array.isArray(activeSkills) ? activeSkills : []).filter((skill) => skill?.active !== false);
  const skillIds = active
    .map((skill) => skill.id)
    .filter(Boolean) as string[];
  if (skillIds.length === 0) {
    return {
      text: null,
      skillIds: [],
    };
  }

  return {
    text: [
      "Active skills:",
      ...active
        .slice(0, 4)
        .map((skill) => `- ${skill.id}: ${skill.description ?? skill.influenceSummary ?? "active"}`),
    ].join("\n"),
    skillIds,
  };
}

function buildSourceContext(
  sourceRegistry: SourceRegistryLike | null | undefined,
  taskClassification: TaskClassification | null | undefined,
  routeDecision: RouteDecision | null | undefined,
): ContextSourceSummary {
  const shouldPreferSources =
    ["official_docs_lookup", "web_retrieval"].includes(taskClassification?.taskClass ?? "") ||
    taskClassification?.freshnessRequired ||
    ["docs-first", "official-first"].includes(routeDecision?.routingMode ?? "");

  const lastPack = sourceRegistry?.getLastPack?.() ?? null;
  const getSource = sourceRegistry?.getSource?.bind(sourceRegistry);
  const sources =
    lastPack?.sourceIds?.map((sourceId) => getSource?.(sourceId)).filter(Boolean) ?? [];
  if (!shouldPreferSources || sources.length === 0) {
    return {
      text: null,
      sourceIds: [],
      mode: shouldPreferSources ? "sources-over-memory" : "memory-balanced",
    };
  }

  return {
    text: [
      "Recent source pack:",
      ...sources.slice(0, 4).map((entry) =>
        `- [${entry!.sourceId}] ${entry!.title} (${entry!.domain})${entry!.excerpt ? ` :: ${abbreviate(entry!.excerpt, 180)}` : ""}`
      ),
    ].join("\n"),
    sourceIds: sources.map((entry) => entry!.sourceId),
    mode: "sources-over-memory",
  };
}

function pushSelected(collection: string[], value: string, text: string): string {
  collection.push(value);
  return text;
}

function pushSkipped(collection: string[], value: string): null {
  collection.push(value);
  return null;
}

function mergeSummaries(existingSummary: string, nextSummary: string, budgetTokens: number): string {
  const combined = [existingSummary, nextSummary].filter(Boolean).join("\n");
  return abbreviate(combined, budgetTokens * 4);
}

function summarizeMessages(messages: MessageLike[]): string {
  return messages
    .map((message) => summarizeMessage(message))
    .filter(Boolean)
    .join("\n");
}

function summarizeMessage(message: MessageLike | null | undefined): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const role = message.role ?? "unknown";
  const toolCallSummary =
    Array.isArray(message.toolCalls) && message.toolCalls.length > 0
      ? ` tool_calls=${message.toolCalls.map((toolCall) => toolCall.name).join(",")}`
      : "";
  const content = summarizeContent(message.content);

  if (!content && !toolCallSummary) {
    return "";
  }

  return `${role}:${toolCallSummary} ${content}`.trim();
}

function summarizeContent(content: unknown): string {
  const text = `${content ?? ""}`.replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.startsWith('Tool result for "')) {
    const toolName = text.match(/Tool result for "([^"]+)"/)?.[1] ?? "unknown";
    const tail = text.slice(0, 220);
    return `${toolName} => ${abbreviate(tail, 220)}`;
  }

  return abbreviate(text, 220);
}
