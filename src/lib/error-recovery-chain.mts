/**
 * ErrorRecoveryChain — Systematic error recovery inspired by Claude Code.
 *
 * Claude Code handles errors through:
 * - Automatic protocol fallback (native tools → JSON protocol)
 * - Model fallback chains
 * - Tool result repair
 * - Context window overflow recovery
 *
 * MJ Code extends this with:
 * - Error taxonomy classification
 * - Recovery strategy selection per error type
 * - Progressive degradation (try expensive recovery first, then cheap)
 * - Recovery attempt tracking and circuit breaking
 * - Structured recovery messages for the LLM
 */

import type { ProviderCompletionRequest, RouteDecision, TaskClassification } from "../types/contracts.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ErrorTaxonomy =
  | "provider_timeout"
  | "provider_rate_limit"
  | "provider_auth"
  | "provider_circuit_open"
  | "provider_model_not_found"
  | "provider_context_overflow"
  | "provider_stream_interrupted"
  | "provider_unknown"
  | "tool_execution_failed"
  | "tool_permission_denied"
  | "tool_timeout"
  | "tool_not_found"
  | "context_budget_exceeded"
  | "verification_failed"
  | "memory_error"
  | "network_error"
  | "sandbox_violation"
  | "unknown";

export type RecoveryStrategy =
  | "retry_with_backoff"
  | "fallback_model"
  | "compact_and_retry"
  | "fallback_protocol"
  | "reduce_scope"
  | "graceful_degradation"
  | "report_and_stop";

export interface RecoveryAttempt {
  id: string;
  taxonomy: ErrorTaxonomy;
  strategy: RecoveryStrategy;
  startedAt: string;
  completedAt: string | null;
  success: boolean;
  details: string;
  tokensSaved: number;
}

export interface RecoveryDecision {
  taxonomy: ErrorTaxonomy;
  strategy: RecoveryStrategy;
  reason: string;
  shouldRetry: boolean;
  maxAttempts: number;
  backoffMs: number;
  recoveryPrompt: string | null;
  degradedMode: string | null;
}

export interface RecoveryChainResult {
  recovered: boolean;
  attempts: RecoveryAttempt[];
  finalDecision: RecoveryDecision;
  totalTokensSaved: number;
  degradedMode: string | null;
}

export interface RecoveryChainConfig {
  maxRecoveryAttempts: number;
  enableModelFallback: boolean;
  enableProtocolFallback: boolean;
  enableContextCompaction: boolean;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

// ─── Error Taxonomy Classification ──────────────────────────────────────────

const TAXONOMY_PATTERNS: Array<{ patterns: RegExp[]; taxonomy: ErrorTaxonomy }> = [
  {
    patterns: [/timeout/i, /timed?\s*out/i, /ETIMEDOUT/i],
    taxonomy: "provider_timeout",
  },
  {
    patterns: [/rate\s*limit/i, /429/, /too\s*many\s*requests/i],
    taxonomy: "provider_rate_limit",
  },
  {
    patterns: [/401/, /403/, /unauthorized/i, /forbidden/i, /auth/i],
    taxonomy: "provider_auth",
  },
  {
    patterns: [/circuit\s*open/i, /circuit_breaker/i],
    taxonomy: "provider_circuit_open",
  },
  {
    patterns: [/model\s*not\s*found/i, /unknown\s*model/i, /unsupported\s*model/i],
    taxonomy: "provider_model_not_found",
  },
  {
    patterns: [/context\s*window/i, /max_tokens/i, /token\s*limit/i, /context_length/i, /too\s*many\s*tokens/i],
    taxonomy: "provider_context_overflow",
  },
  {
    patterns: [/stream\s*interrupted/i, /partial\s*stream/i, /premature\s*close/i, /socket\s*hang\s*up/i],
    taxonomy: "provider_stream_interrupted",
  },
  {
    patterns: [/permission\s*denied/i, /EACCES/, /read-only/i, /outside\s*workspace/i],
    taxonomy: "tool_permission_denied",
  },
  {
    patterns: [/ENOENT/, /not\s*found/i, /does\s*not\s*exist/i],
    taxonomy: "tool_not_found",
  },
  {
    patterns: [/verification\s*failed/i, /verifier/i, /diagnostic/i],
    taxonomy: "verification_failed",
  },
  {
    patterns: [/network/i, /ECONNREFUSED/, /ENOTFOUND/, /fetch\s*failed/i],
    taxonomy: "network_error",
  },
  {
    patterns: [/sandbox/i, /isolation/i, /seatbelt/i],
    taxonomy: "sandbox_violation",
  },
];

// ─── Recovery Strategy Selection ─────────────────────────────────────────────

const TAXONOMY_STRATEGIES: Record<ErrorTaxonomy, RecoveryStrategy[]> = [
  // Try each in order until one succeeds
];

const RECOVERY_STRATEGIES: Record<ErrorTaxonomy, { primary: RecoveryStrategy; fallbacks: RecoveryStrategy[]; maxAttempts: number; backoffMs: number }> = {
  provider_timeout: {
    primary: "retry_with_backoff",
    fallbacks: ["fallback_model", "reduce_scope"],
    maxAttempts: 2,
    backoffMs: 2000,
  },
  provider_rate_limit: {
    primary: "retry_with_backoff",
    fallbacks: ["fallback_model"],
    maxAttempts: 3,
    backoffMs: 5000,
  },
  provider_auth: {
    primary: "report_and_stop",
    fallbacks: [],
    maxAttempts: 0,
    backoffMs: 0,
  },
  provider_circuit_open: {
    primary: "fallback_model",
    fallbacks: ["graceful_degradation"],
    maxAttempts: 1,
    backoffMs: 0,
  },
  provider_model_not_found: {
    primary: "fallback_model",
    fallbacks: ["report_and_stop"],
    maxAttempts: 1,
    backoffMs: 0,
  },
  provider_context_overflow: {
    primary: "compact_and_retry",
    fallbacks: ["reduce_scope", "graceful_degradation"],
    maxAttempts: 2,
    backoffMs: 500,
  },
  provider_stream_interrupted: {
    primary: "retry_with_backoff",
    fallbacks: ["fallback_model", "fallback_protocol"],
    maxAttempts: 1,
    backoffMs: 1000,
  },
  provider_unknown: {
    primary: "retry_with_backoff",
    fallbacks: ["fallback_model", "graceful_degradation"],
    maxAttempts: 1,
    backoffMs: 1000,
  },
  tool_execution_failed: {
    primary: "retry_with_backoff",
    fallbacks: ["graceful_degradation"],
    maxAttempts: 1,
    backoffMs: 500,
  },
  tool_permission_denied: {
    primary: "report_and_stop",
    fallbacks: [],
    maxAttempts: 0,
    backoffMs: 0,
  },
  tool_timeout: {
    primary: "retry_with_backoff",
    fallbacks: ["reduce_scope"],
    maxAttempts: 1,
    backoffMs: 1000,
  },
  tool_not_found: {
    primary: "report_and_stop",
    fallbacks: [],
    maxAttempts: 0,
    backoffMs: 0,
  },
  context_budget_exceeded: {
    primary: "compact_and_retry",
    fallbacks: ["reduce_scope", "graceful_degradation"],
    maxAttempts: 2,
    backoffMs: 300,
  },
  verification_failed: {
    primary: "graceful_degradation",
    fallbacks: ["report_and_stop"],
    maxAttempts: 0,
    backoffMs: 0,
  },
  memory_error: {
    primary: "graceful_degradation",
    fallbacks: [],
    maxAttempts: 0,
    backoffMs: 0,
  },
  network_error: {
    primary: "retry_with_backoff",
    fallbacks: ["graceful_degradation"],
    maxAttempts: 2,
    backoffMs: 3000,
  },
  sandbox_violation: {
    primary: "reduce_scope",
    fallbacks: ["graceful_degradation"],
    maxAttempts: 1,
    backoffMs: 0,
  },
  unknown: {
    primary: "retry_with_backoff",
    fallbacks: ["graceful_degradation"],
    maxAttempts: 1,
    backoffMs: 1000,
  },
};

// ─── Recovery Prompt Templates ───────────────────────────────────────────────

const RECOVERY_PROMPTS: Record<RecoveryStrategy, string> = {
  retry_with_backoff: "A temporary error occurred. Retrying with adjusted parameters. Please wait.",
  fallback_model: "The primary model is unavailable. Switching to a fallback model. Output quality may vary slightly.",
  compact_and_retry: "The context window is nearly full. Compressing conversation history and retrying. Some earlier context may be summarized.",
  fallback_protocol: "Native tool calling is not supported by this provider. Switching to JSON tool protocol.",
  reduce_scope: "The current task scope is too large. Reducing the scope and retrying with a more focused approach.",
  graceful_degradation: "A non-recoverable error occurred. Switching to degraded mode with reduced capabilities. Some features may be unavailable.",
  report_and_stop: "A critical error occurred that cannot be automatically recovered. Please check the error details and adjust your request.",
};

// ─── ErrorRecoveryChain ─────────────────────────────────────────────────────

export class ErrorRecoveryChain {
  readonly config: RecoveryChainConfig;
  private attempts: RecoveryAttempt[] = [];
  private taxonomyHitCounts: Map<ErrorTaxonomy, number> = new Map();

  constructor(config: Partial<RecoveryChainConfig> = {}) {
    this.config = {
      maxRecoveryAttempts: 3,
      enableModelFallback: true,
      enableProtocolFallback: true,
      enableContextCompaction: true,
      backoffBaseMs: 1000,
      backoffMaxMs: 10000,
      ...config,
    };
  }

  /**
   * Classify an error into a taxonomy.
   */
  classifyError(error: unknown): ErrorTaxonomy {
    const message = extractErrorMessage(error);
    const code = extractErrorCode(error);
    const haystack = `${message} ${code}`.toLowerCase();

    for (const { patterns, taxonomy } of TAXONOMY_PATTERNS) {
      if (patterns.some((pattern) => pattern.test(haystack))) {
        return taxonomy;
      }
    }

    return "unknown";
  }

  /**
   * Decide on a recovery strategy for a given error.
   */
  decideRecovery(taxonomy: ErrorTaxonomy, context?: { attemptCount?: number; step?: number }): RecoveryDecision {
    const strategyConfig = RECOVERY_STRATEGIES[taxonomy];
    const attemptCount = context?.attemptCount ?? this.getAttemptCount(taxonomy);

    // Check if we've exhausted attempts for this error type
    if (attemptCount >= strategyConfig.maxAttempts) {
      return {
        taxonomy,
        strategy: "report_and_stop",
        reason: `Exhausted recovery attempts for ${taxonomy} (${attemptCount}/${strategyConfig.maxAttempts})`,
        shouldRetry: false,
        maxAttempts: strategyConfig.maxAttempts,
        backoffMs: 0,
        recoveryPrompt: RECOVERY_PROMPTS.report_and_stop,
        degradedMode: taxonomy,
      };
    }

    // Select strategy based on attempt count and config
    const strategy = this.selectStrategy(taxonomy, attemptCount);

    // Filter out disabled strategies
    const effectiveStrategy = this.applyConfigFilters(strategy);

    const backoffMs = Math.min(
      this.config.backoffMaxMs,
      strategyConfig.backoffMs * (2 ** attemptCount),
    );

    return {
      taxonomy,
      strategy: effectiveStrategy,
      reason: `Recovery attempt ${attemptCount + 1}/${strategyConfig.maxAttempts} for ${taxonomy}: using ${effectiveStrategy}`,
      shouldRetry: effectiveStrategy !== "report_and_stop",
      maxAttempts: strategyConfig.maxAttempts,
      backoffMs,
      recoveryPrompt: RECOVERY_PROMPTS[effectiveStrategy],
      degradedMode: effectiveStrategy === "graceful_degradation" ? taxonomy : null,
    };
  }

  /**
   * Record a recovery attempt.
   */
  recordAttempt(attempt: RecoveryAttempt): void {
    this.attempts.push(attempt);
    const current = this.taxonomyHitCounts.get(attempt.taxonomy) ?? 0;
    this.taxonomyHitCounts.set(attempt.taxonomy, current + 1);
  }

  /**
   * Get the number of attempts for a specific error taxonomy.
   */
  getAttemptCount(taxonomy: ErrorTaxonomy): number {
    return this.taxonomyHitCounts.get(taxonomy) ?? 0;
  }

  /**
   * Get all recovery attempts.
   */
  getAttempts(): RecoveryAttempt[] {
    return [...this.attempts];
  }

  /**
   * Generate a structured recovery message for the LLM.
   *
   * This message is injected into the conversation to help the LLM
   * understand what happened and adjust its behavior accordingly.
   */
  generateRecoveryMessage(decision: RecoveryDecision): string {
    const parts = [
      `[System Recovery Notice]`,
      `Error type: ${decision.taxonomy}`,
      `Recovery strategy: ${decision.strategy}`,
    ];

    if (decision.recoveryPrompt) {
      parts.push(decision.recoveryPrompt);
    }

    if (decision.degradedMode) {
      parts.push(`Currently operating in degraded mode: ${decision.degradedMode}. Some capabilities may be limited.`);
    }

    if (decision.shouldRetry) {
      parts.push(`This turn will be retried automatically. Please adjust your approach if the same error recurs.`);
    }

    return parts.join("\n");
  }

  /**
   * Select recovery strategy based on attempt count.
   */
  private selectStrategy(taxonomy: ErrorTaxonomy, attemptCount: number): RecoveryStrategy {
    const strategyConfig = RECOVERY_STRATEGIES[taxonomy];

    if (attemptCount === 0) {
      return strategyConfig.primary;
    }

    const fallbackIndex = attemptCount - 1;
    if (fallbackIndex < strategyConfig.fallbacks.length) {
      return strategyConfig.fallbacks[fallbackIndex];
    }

    // Use last fallback or report_and_stop
    return strategyConfig.fallbacks[strategyConfig.fallbacks.length - 1] ?? "report_and_stop";
  }

  /**
   * Apply config-based filters to strategy selection.
   */
  private applyConfigFilters(strategy: RecoveryStrategy): RecoveryStrategy {
    if (strategy === "fallback_model" && !this.config.enableModelFallback) {
      return "graceful_degradation";
    }
    if (strategy === "fallback_protocol" && !this.config.enableProtocolFallback) {
      return "retry_with_backoff";
    }
    if (strategy === "compact_and_retry" && !this.config.enableContextCompaction) {
      return "reduce_scope";
    }
    return strategy;
  }

  /**
   * Reset the recovery chain state.
   */
  reset(): void {
    this.attempts = [];
    this.taxonomyHitCounts.clear();
  }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return `${(error as { message: unknown }).message}`;
  }
  return `${error ?? ""}`;
}

function extractErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    if ("code" in error) {
      return `${(error as { code: unknown }).code}`;
    }
    if ("taxonomy" in error) {
      return `${(error as { taxonomy: unknown }).taxonomy}`;
    }
  }
  return "";
}
