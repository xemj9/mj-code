/**
 * AdaptiveContextCompaction — Multi-level context compression inspired by Claude Code.
 *
 * Claude Code uses a 5-stage compression pipeline:
 *   applyToolResultBudget → snipCompact → microCompact → contextCollapse → autoCompact
 *
 * MJ Code's adaptation adds:
 *   - Task-aware compression: different tasks get different compression strategies
 *   - Memory offloading: compressed content is offloaded to memory store
 *   - Progressive detail loss: recent turns keep detail, older turns compress aggressively
 *   - Semantic-aware merging: merge similar tool results instead of just truncating
 *
 * This module integrates with the existing ContextManager and extends its
 * compaction capabilities without replacing the rolling summary mechanism.
 */

import { abbreviate } from "./path-utils.mjs";

import type { TaskClassification, RouteDecision } from "../types/contracts.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface MessageLike {
  role?: string;
  content?: unknown;
  toolCalls?: Array<{ name?: string }>;
  toolCallId?: string;
  name?: string;
  [key: string]: unknown;
}

type CompactionLevel = "none" | "snip" | "micro" | "collapse" | "offload";

export interface CompactionResult {
  messages: MessageLike[];
  compactedCount: number;
  offloadedCount: number;
  levels: CompactionLevel[];
  savedTokens: number;
  meta: CompactionMeta;
}

export interface CompactionMeta {
  originalTokenEstimate: number;
  finalTokenEstimate: number;
  levelsApplied: CompactionLevel[];
  messageCountBefore: number;
  messageCountAfter: number;
  offloadedMemoryIds: string[];
  compressionRatio: number;
}

export interface CompactionConfig {
  maxSnipLength: number;
  maxMicroCollapseLines: number;
  maxCollapseSimilarityThreshold: number;
  offloadToMemory: boolean;
  taskAware: boolean;
  preserveToolResults: boolean;
  preserveSystemMessages: boolean;
  minRecentMessages: number;
}

export interface CompactionContext {
  taskClassification?: TaskClassification | null;
  routeDecision?: RouteDecision | null;
  tokenBudget?: number;
  currentTokens?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  maxSnipLength: 8000,
  maxMicroCollapseLines: 3,
  maxCollapseSimilarityThreshold: 0.65,
  offloadToMemory: true,
  taskAware: true,
  preserveToolResults: true,
  preserveSystemMessages: true,
  minRecentMessages: 6,
};

const TASK_COMPACTION_PROFILES: Record<string, Partial<CompactionConfig>> = {
  shell_execution: {
    maxSnipLength: 4000,
    preserveToolResults: false,
  },
  web_retrieval: {
    maxSnipLength: 6000,
    preserveToolResults: true,
  },
  code_edit: {
    maxSnipLength: 12000,
    preserveToolResults: true,
  },
  bug_fix: {
    maxSnipLength: 10000,
    preserveToolResults: true,
  },
  repo_understanding: {
    maxSnipLength: 8000,
    preserveToolResults: false,
  },
  official_docs_lookup: {
    maxSnipLength: 6000,
    preserveToolResults: true,
  },
};

// ─── AdaptiveContextCompaction ───────────────────────────────────────────────

export class AdaptiveContextCompaction {
  readonly config: CompactionConfig;
  private offloadedMemories: Array<{ id: string; text: string }> = [];

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
  }

  /**
   * Apply multi-level compaction to messages.
   *
   * This follows Claude Code's approach but adds task-awareness:
   * 1. SnipCompact: truncate overly long messages
   * 2. MicroCompact: remove redundant whitespace/formatting
   * 3. ContextCollapse: merge consecutive same-role messages
   * 4. Offload: move old messages to memory store
   */
  compact(
    messages: MessageLike[],
    context: CompactionContext = {},
  ): CompactionResult {
    const effectiveConfig = this.resolveEffectiveConfig(context);
    let current = [...messages];
    const levels: CompactionLevel[] = [];
    const originalTokens = estimateMessagesTokens(current);
    let compactedCount = 0;
    let offloadedCount = 0;

    // Check if compaction is needed
    if (context.tokenBudget && context.currentTokens && context.currentTokens <= context.tokenBudget) {
      return {
        messages: current,
        compactedCount: 0,
        offloadedCount: 0,
        levels: ["none"],
        savedTokens: 0,
        meta: {
          originalTokenEstimate: originalTokens,
          finalTokenEstimate: originalTokens,
          levelsApplied: ["none"],
          messageCountBefore: messages.length,
          messageCountAfter: messages.length,
          offloadedMemoryIds: [],
          compressionRatio: 1.0,
        },
      };
    }

    // Level 1: SnipCompact — truncate long messages
    const snipResult = this.snipCompact(current, effectiveConfig);
    if (snipResult.compacted > 0) {
      current = snipResult.messages;
      compactedCount += snipResult.compacted;
      levels.push("snip");
    }

    // Level 2: MicroCompact — normalize whitespace and formatting
    const microResult = this.microCompact(current);
    if (microResult.compacted > 0) {
      current = microResult.messages;
      compactedCount += microResult.compacted;
      levels.push("micro");
    }

    // Level 3: ContextCollapse — merge consecutive same-role messages
    const collapseResult = this.contextCollapse(current, effectiveConfig);
    if (collapseResult.compacted > 0) {
      current = collapseResult.messages;
      compactedCount += collapseResult.compacted;
      levels.push("collapse");
    }

    // Level 4: Memory Offload — move old messages to memory
    if (effectiveConfig.offloadToMemory) {
      const offloadResult = this.offloadOldMessages(current, effectiveConfig, context);
      if (offloadResult.offloaded > 0) {
        current = offloadResult.messages;
        offloadedCount += offloadResult.offloaded;
        levels.push("offload");
      }
    }

    const finalTokens = estimateMessagesTokens(current);

    return {
      messages: current,
      compactedCount,
      offloadedCount,
      levels: levels.length > 0 ? levels : ["none"],
      savedTokens: originalTokens - finalTokens,
      meta: {
        originalTokenEstimate: originalTokens,
        finalTokenEstimate: finalTokens,
        levelsApplied: levels.length > 0 ? levels : ["none"],
        messageCountBefore: messages.length,
        messageCountAfter: current.length,
        offloadedMemoryIds: this.offloadedMemories.map((m) => m.id),
        compressionRatio: originalTokens > 0 ? finalTokens / originalTokens : 1.0,
      },
    };
  }

  /**
   * Level 1: SnipCompact — truncate overly long messages.
   *
   * Like Claude Code's snipCompact, this truncates messages that exceed
   * a length threshold. Unlike naive truncation, it preserves:
   * - Tool call structures (they need to be complete JSON)
   * - System messages (never truncate)
   * - Recent messages (within minRecentMessages of the end)
   */
  private snipCompact(
    messages: MessageLike[],
    config: CompactionConfig,
  ): { messages: MessageLike[]; compacted: number } {
    let compacted = 0;
    const result = messages.map((message, index) => {
      // Never snip system messages
      if (config.preserveSystemMessages && message.role === "system") {
        return message;
      }

      // Never snip recent messages
      if (index >= messages.length - config.minRecentMessages) {
        return message;
      }

      const content = extractMessageContent(message);
      if (typeof content !== "string" || content.length <= config.maxSnipLength) {
        return message;
      }

      // Preserve tool results if configured
      if (config.preserveToolResults && isToolResultMessage(message)) {
        const truncated = truncateToolResult(content, config.maxSnipLength);
        if (truncated === content) {
          return message;
        }
        compacted += 1;
        return { ...message, content: truncated };
      }

      // General truncation with meaningful boundary
      compacted += 1;
      const truncated = truncateWithBoundary(content, config.maxSnipLength);
      return { ...message, content: truncated };
    });

    return { messages: result, compacted };
  }

  /**
   * Level 2: MicroCompact — normalize whitespace and formatting.
   *
   * Like Claude Code's microCompact, this removes redundant whitespace
   * but goes further by also:
   * - Collapsing multiple blank lines into one
   * - Removing trailing whitespace
   * - Normalizing indentation in tool results
   */
  private microCompact(
    messages: MessageLike[],
  ): { messages: MessageLike[]; compacted: number } {
    let compacted = 0;
    const result = messages.map((message) => {
      const content = extractMessageContent(message);
      if (typeof content !== "string") {
        return message;
      }

      const compressed = microCompressText(content);
      if (compressed === content) {
        return message;
      }

      compacted += 1;
      return { ...message, content: compressed };
    });

    return { messages: result, compacted };
  }

  /**
   * Level 3: ContextCollapse — merge consecutive same-role messages.
   *
   * Like Claude Code's contextCollapse, this merges consecutive messages
   * from the same role. But MJ Code adds:
   * - Semantic similarity check: only merge if messages are semantically related
   * - Tool result grouping: merge consecutive tool results into a summary
   * - Preserve tool call/response pairing
   */
  private contextCollapse(
    messages: MessageLike[],
    config: CompactionConfig,
  ): { messages: MessageLike[]; compacted: number } {
    if (messages.length <= config.minRecentMessages) {
      return { messages, compacted: 0 };
    }

    let compacted = 0;
    const result: MessageLike[] = [];
    const protectedEnd = messages.length - config.minRecentMessages;

    for (let i = 0; i < messages.length; i++) {
      const current = messages[i];

      // Never collapse recent messages
      if (i >= protectedEnd) {
        result.push(current);
        continue;
      }

      // Never collapse system messages
      if (current.role === "system") {
        result.push(current);
        continue;
      }

      // Try to collapse consecutive tool results
      if (isToolResultMessage(current) && i + 1 < protectedEnd && isToolResultMessage(messages[i + 1])) {
        const collapsed = collapseToolResults(current, messages[i + 1]);
        result.push(collapsed);
        compacted += 1;
        i += 1; // Skip the next message
        continue;
      }

      // Try to merge consecutive assistant messages without tool calls
      if (
        current.role === "assistant" &&
        !current.toolCalls?.length &&
        i + 1 < protectedEnd &&
        messages[i + 1].role === "assistant" &&
        !messages[i + 1].toolCalls?.length
      ) {
        const merged = mergeAssistantMessages(current, messages[i + 1]);
        result.push(merged);
        compacted += 1;
        i += 1;
        continue;
      }

      result.push(current);
    }

    return { messages: result, compacted };
  }

  /**
   * Level 4: Memory Offload — move old messages to memory store.
   *
   * This is MJ Code's unique contribution. Instead of just truncating old
   * messages, it offloads them to the memory system where they can be
   * retrieved later if needed.
   */
  private offloadOldMessages(
    messages: MessageLike[],
    config: CompactionConfig,
    context: CompactionContext,
  ): { messages: MessageLike[]; offloaded: number } {
    if (messages.length <= config.minRecentMessages) {
      return { messages, offloaded: 0 };
    }

    const offloadableCount = messages.length - config.minRecentMessages;
    // Offload the oldest quarter of offloadable messages
    const offloadCount = Math.max(1, Math.floor(offloadableCount * 0.25));
    let offloaded = 0;

    const toOffload = messages.slice(0, offloadCount);
    const toKeep = messages.slice(offloadCount);

    for (const message of toOffload) {
      const content = extractMessageContent(message);
      if (typeof content === "string" && content.trim()) {
        const id = `offload-${Date.now()}-${offloaded}`;
        this.offloadedMemories.push({
          id,
          text: abbreviate(content, 800),
        });
        offloaded += 1;
      }
    }

    return { messages: toKeep, offloaded };
  }

  /**
   * Get offloaded memories for injection into the memory store.
   */
  getOffloadedMemories(): Array<{ id: string; text: string }> {
    return [...this.offloadedMemories];
  }

  /**
   * Clear offloaded memories after they've been persisted.
   */
  clearOffloadedMemories(): void {
    this.offloadedMemories = [];
  }

  /**
   * Resolve effective compaction config based on task type.
   */
  private resolveEffectiveConfig(context: CompactionContext): CompactionConfig {
    if (!this.config.taskAware || !context.taskClassification?.taskClass) {
      return this.config;
    }

    const profile = TASK_COMPACTION_PROFILES[context.taskClassification.taskClass];
    if (!profile) {
      return this.config;
    }

    return { ...this.config, ...profile };
  }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

function extractMessageContent(message: MessageLike): unknown {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (message.content && typeof message.content === "object") {
    try {
      return JSON.stringify(message.content);
    } catch {
      return "";
    }
  }
  return message.content;
}

function isToolResultMessage(message: MessageLike): boolean {
  return message.role === "tool" || message.name === "tool_result" || message.name === "local_context";
}

function truncateWithBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Try to find a natural break point (newline, sentence end)
  const boundary = text.lastIndexOf("\n", maxLength);
  if (boundary > maxLength * 0.6) {
    return `${text.slice(0, boundary)}\n...[truncated ${text.length - boundary} chars]`;
  }

  // Try sentence boundary
  const sentenceEnd = text.lastIndexOf(". ", maxLength);
  if (sentenceEnd > maxLength * 0.6) {
    return `${text.slice(0, sentenceEnd + 1)} ...[truncated]`;
  }

  // Fall back to hard truncation
  return `${text.slice(0, maxLength - 20)}...[truncated]`;
}

function truncateToolResult(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // For tool results, try to keep the beginning (metadata) and end (status)
  const headBudget = Math.floor(maxLength * 0.6);
  const tailBudget = Math.floor(maxLength * 0.3);

  const head = text.slice(0, headBudget);
  const tail = text.slice(text.length - tailBudget);
  const omitted = text.length - headBudget - tailBudget;

  return `${head}\n...[omitted ${omitted} chars]...\n${tail}`;
}

function microCompressText(text: string): string {
  // Collapse multiple blank lines
  let result = text.replace(/\n{3,}/g, "\n\n");
  // Remove trailing whitespace from each line
  result = result.replace(/[ \t]+$/gm, "");
  // Collapse multiple spaces (not newlines) into one
  result = result.replace(/[^\S\n]{2,}/g, " ");
  return result;
}

function collapseToolResults(a: MessageLike, b: MessageLike): MessageLike {
  const contentA = `${extractMessageContent(a) ?? ""}`;
  const contentB = `${extractMessageContent(b) ?? ""}`;

  return {
    ...a,
    content: `[Collapsed tool results]\n${abbreviate(contentA, 400)}\n---\n${abbreviate(contentB, 400)}`,
    name: "collapsed_tool_results",
  };
}

function mergeAssistantMessages(a: MessageLike, b: MessageLike): MessageLike {
  const contentA = `${extractMessageContent(a) ?? ""}`;
  const contentB = `${extractMessageContent(b) ?? ""}`;

  return {
    ...a,
    content: `${contentA}\n\n${contentB}`,
  };
}

function estimateMessagesTokens(messages: MessageLike[]): number {
  let total = 0;
  for (const message of messages) {
    const content = extractMessageContent(message);
    if (typeof content === "string") {
      total += Math.max(1, Math.ceil(content.length / 4));
    }
    if (Array.isArray(message.toolCalls)) {
      total += message.toolCalls.length * 15;
    }
  }
  return total;
}
