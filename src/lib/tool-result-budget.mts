/**
 * ToolResultBudget — Budget-aware tool result processing inspired by Claude Code.
 *
 * Claude Code applies `applyToolResultBudget` before each model call to ensure
 * tool results don't consume too much of the context window. The strategy is:
 *
 * 1. Each tool result gets a budget based on the number of results
 * 2. Results exceeding the budget are truncated with a summary
 * 3. Binary or non-text results are represented as metadata only
 * 4. Very large results are replaced with "[Result too large, use read_file to inspect]"
 *
 * MJ Code extends this with:
 * - Tool-type-specific budgets (shell output gets more, file reads get less)
 * - Smart truncation that preserves structure (JSON, tables, stack traces)
 * - Budget-aware summarization for repeated tool calls
 * - Metrics tracking for budget utilization
 */

import { abbreviate } from "./path-utils.mjs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolResultBudgetConfig {
  /** Maximum total characters for all tool results in a single turn */
  maxTotalResultChars: number;
  /** Maximum characters for a single tool result */
  maxSingleResultChars: number;
  /** Maximum characters for shell command output */
  maxShellOutputChars: number;
  /** Maximum characters for file read output */
  maxFileReadChars: number;
  /** Maximum characters for web search results */
  maxWebResultChars: number;
  /** Maximum characters for search/grep results */
  maxSearchResultChars: number;
  /** Whether to preserve structure (JSON, tables) when truncating */
  preserveStructure: boolean;
  /** Whether to include metadata for truncated results */
  includeTruncationMeta: boolean;
}

export interface BudgetedToolResult {
  content: string;
  originalLength: number;
  budgetedLength: number;
  truncated: boolean;
  truncationRatio: number;
  metadata: {
    toolName: string;
    resultType: string;
    budget: number;
    used: number;
    truncationStrategy: string | null;
  };
}

export interface BudgetAllocation {
  totalBudget: number;
  perResultBudget: number;
  allocations: Map<string, number>;
}

// ─── Default Config ─────────────────────────────────────────────────────────

const DEFAULT_BUDGET_CONFIG: ToolResultBudgetConfig = {
  maxTotalResultChars: 80_000,
  maxSingleResultChars: 20_000,
  maxShellOutputChars: 15_000,
  maxFileReadChars: 12_000,
  maxWebResultChars: 8_000,
  maxSearchResultChars: 6_000,
  preserveStructure: true,
  includeTruncationMeta: true,
};

// ─── Tool-Type Budget Profiles ──────────────────────────────────────────────

const TOOL_TYPE_BUDGETS: Record<string, { maxChars: number; resultType: string }> = {
  run_shell: { maxChars: 15_000, resultType: "shell_output" },
  read_file: { maxChars: 12_000, resultType: "file_content" },
  write_file: { maxChars: 2_000, resultType: "write_confirmation" },
  replace_in_file: { maxChars: 3_000, resultType: "edit_confirmation" },
  apply_patch: { maxChars: 3_000, resultType: "patch_confirmation" },
  list_dir: { maxChars: 5_000, resultType: "directory_listing" },
  search_files: { maxChars: 6_000, resultType: "search_results" },
  web_search: { maxChars: 8_000, resultType: "web_results" },
  fetch_url: { maxChars: 10_000, resultType: "web_content" },
  extract_content: { maxChars: 10_000, resultType: "extracted_content" },
  search_memory: { maxChars: 4_000, resultType: "memory_results" },
  remember_memory: { maxChars: 1_000, resultType: "memory_confirmation" },
  check_sandbox: { maxChars: 2_000, resultType: "sandbox_status" },
};

// ─── ToolResultBudget ───────────────────────────────────────────────────────

export class ToolResultBudget {
  readonly config: ToolResultBudgetConfig;
  private totalUsed: number = 0;

  constructor(config: Partial<ToolResultBudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /**
   * Apply budget to a single tool result.
   *
   * This is the main entry point. It takes a raw tool result and
   * returns a budgeted version that fits within the allocation.
   */
  applyBudget(
    toolName: string,
    rawContent: string,
    context?: { resultCount?: number; totalResultsSoFar?: number },
  ): BudgetedToolResult {
    const profile = TOOL_TYPE_BUDGETS[toolName] ?? {
      maxChars: this.config.maxSingleResultChars,
      resultType: "unknown",
    };

    // Calculate per-result budget
    const resultCount = context?.resultCount ?? 1;
    const perResultBudget = Math.min(
      profile.maxChars,
      Math.floor(this.config.maxTotalResultChars / Math.max(1, resultCount)),
    );

    const remainingBudget = this.config.maxTotalResultChars - this.totalUsed;
    const effectiveBudget = Math.min(perResultBudget, remainingBudget);

    // Check if budgeting is needed
    if (rawContent.length <= effectiveBudget) {
      this.totalUsed += rawContent.length;
      return {
        content: rawContent,
        originalLength: rawContent.length,
        budgetedLength: rawContent.length,
        truncated: false,
        truncationRatio: 1.0,
        metadata: {
          toolName,
          resultType: profile.resultType,
          budget: effectiveBudget,
          used: rawContent.length,
          truncationStrategy: null,
        },
      };
    }

    // Apply truncation with structure preservation
    const { content, strategy } = this.truncateResult(rawContent, effectiveBudget, toolName, profile.resultType);

    this.totalUsed += content.length;

    return {
      content,
      originalLength: rawContent.length,
      budgetedLength: content.length,
      truncated: true,
      truncationRatio: content.length / rawContent.length,
      metadata: {
        toolName,
        resultType: profile.resultType,
        budget: effectiveBudget,
        used: content.length,
        truncationStrategy: strategy,
      },
    };
  }

  /**
   * Get the current budget utilization.
   */
  getUtilization(): { used: number; budget: number; ratio: number } {
    return {
      used: this.totalUsed,
      budget: this.config.maxTotalResultChars,
      ratio: this.totalUsed / this.config.maxTotalResultChars,
    };
  }

  /**
   * Reset the budget tracker for a new turn.
   */
  reset(): void {
    this.totalUsed = 0;
  }

  /**
   * Truncate a tool result intelligently based on content type.
   */
  private truncateResult(
    content: string,
    budget: number,
    toolName: string,
    resultType: string,
  ): { content: string; strategy: string } {
    if (!this.config.preserveStructure) {
      return {
        content: abbreviate(content, budget),
        strategy: "simple_truncation",
      };
    }

    // Strategy 1: JSON content — preserve structure
    if (isJsonContent(content)) {
      return this.truncateJsonContent(content, budget);
    }

    // Strategy 2: Shell output — preserve start and end
    if (resultType === "shell_output") {
      return this.truncateShellOutput(content, budget);
    }

    // Strategy 3: Table/list content — preserve rows
    if (isTabularContent(content)) {
      return this.truncateTabularContent(content, budget);
    }

    // Strategy 4: Stack trace — preserve the trace
    if (isStackTrace(content)) {
      return this.truncateStackTrace(content, budget);
    }

    // Strategy 5: General content — head + tail with summary
    return this.truncateGeneralContent(content, budget, toolName);
  }

  private truncateJsonContent(content: string, budget: number): { content: string; strategy: string } {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        // Truncate array, keeping first and last items
        const totalItems = parsed.length;
        const itemBudget = budget - 200; // Reserve space for metadata
        const avgItemSize = content.length / totalItems;
        const keepItems = Math.max(3, Math.floor(itemBudget / avgItemSize));

        if (keepItems >= totalItems) {
          return { content: abbreviate(content, budget), strategy: "json_array_truncation" };
        }

        const first = parsed.slice(0, Math.ceil(keepItems / 2));
        const last = parsed.slice(-Math.floor(keepItems / 2));
        const truncated = [
          ...first,
          { _truncated: `... ${totalItems - keepItems} items omitted ...` },
          ...last,
        ];

        const result = JSON.stringify(truncated, null, 2);
        return {
          content: abbreviate(result, budget),
          strategy: "json_array_truncation",
        };
      }

      // Object — try to keep as much as possible
      return { content: abbreviate(content, budget), strategy: "json_object_truncation" };
    } catch {
      return { content: abbreviate(content, budget), strategy: "json_parse_fallback" };
    }
  }

  private truncateShellOutput(content: string, budget: number): { content: string; strategy: string } {
    const lines = content.split("\n");
    const totalLines = lines.length;

    if (totalLines <= 50) {
      return { content: abbreviate(content, budget), strategy: "shell_output_truncation" };
    }

    // Keep first 20 lines, last 15 lines, and a summary in between
    const headLines = lines.slice(0, 20);
    const tailLines = lines.slice(-15);
    const omitted = totalLines - 35;

    const result = [
      ...headLines,
      `... [${omitted} lines omitted] ...`,
      ...tailLines,
    ].join("\n");

    return {
      content: abbreviate(result, budget),
      strategy: "shell_head_tail_truncation",
    };
  }

  private truncateTabularContent(content: string, budget: number): { content: string; strategy: string } {
    const lines = content.split("\n");
    if (lines.length <= 30) {
      return { content: abbreviate(content, budget), strategy: "tabular_truncation" };
    }

    // Keep header + first rows + last rows
    const header = lines.slice(0, 2);
    const firstRows = lines.slice(2, 12);
    const lastRows = lines.slice(-5);
    const omitted = lines.length - 19;

    const result = [
      ...header,
      ...firstRows,
      `... [${omitted} rows omitted] ...`,
      ...lastRows,
    ].join("\n");

    return {
      content: abbreviate(result, budget),
      strategy: "tabular_head_tail_truncation",
    };
  }

  private truncateStackTrace(content: string, budget: number): { content: string; strategy: string } {
    // Stack traces are important — try to keep as much as possible
    // but remove duplicate frames
    const lines = content.split("\n");
    const uniqueLines: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const normalized = line.trim().replace(/\s+/g, " ");
      if (!seen.has(normalized)) {
        seen.add(normalized);
        uniqueLines.push(line);
      }
    }

    return {
      content: abbreviate(uniqueLines.join("\n"), budget),
      strategy: "stack_trace_dedup_truncation",
    };
  }

  private truncateGeneralContent(content: string, budget: number, toolName: string): { content: string; strategy: string } {
    const metaPrefix = this.config.includeTruncationMeta
      ? `[Tool result from ${toolName} was ${content.length} chars, truncated to ~${budget} chars]\n\n`
      : "";

    const headBudget = Math.floor(budget * 0.65) - metaPrefix.length;
    const tailBudget = Math.floor(budget * 0.25);

    const head = content.slice(0, headBudget);
    const tail = content.slice(content.length - tailBudget);
    const omitted = content.length - headBudget - tailBudget;

    return {
      content: `${metaPrefix}${head}\n\n... [${omitted} chars omitted] ...\n\n${tail}`,
      strategy: "general_head_tail_truncation",
    };
  }
}

// ─── Content Type Detection ─────────────────────────────────────────────────

function isJsonContent(content: string): boolean {
  const trimmed = content.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function isTabularContent(content: string): boolean {
  const lines = content.split("\n").slice(0, 5);
  // Check if lines have consistent column separators
  const pipeCount = lines.filter((line) => line.includes("|")).length;
  const tabCount = lines.filter((line) => line.includes("\t")).length;
  return pipeCount >= 3 || tabCount >= 3;
}

function isStackTrace(content: string): boolean {
  const lower = content.toLowerCase();
  return lower.includes("stack trace") ||
    lower.includes("at ") && lower.includes(".js:") ||
    lower.includes("at ") && lower.includes(".ts:") ||
    lower.includes("traceback") ||
    lower.includes("exception") && lower.includes("at ");
}
