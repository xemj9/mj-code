import type {
  CircuitBreakerOptions,
  RuntimeCircuitGate,
  RuntimeCircuitOutcome,
  RuntimeCircuitSnapshot,
  RuntimeCircuitState,
} from "../types/contracts.js";

const DEFAULTS: Required<CircuitBreakerOptions> = {
  failureThreshold: 3,
  cooldownMs: 15_000,
  maxCooldownMs: 120_000,
  halfOpenMaxRequests: 1,
  successThreshold: 1,
};

type CircuitSnapshotInput = Partial<RuntimeCircuitSnapshot> | null;

export class CircuitBreaker {
  readonly key: string;
  readonly options: Required<CircuitBreakerOptions>;
  private state: RuntimeCircuitSnapshot;

  constructor(
    key: string,
    options: CircuitBreakerOptions = {},
    snapshot: CircuitSnapshotInput = null,
  ) {
    this.key = key;
    this.options = {
      ...DEFAULTS,
      ...options,
    };
    this.state = normalizeSnapshot(key, snapshot, this.options);
  }

  beforeRequest(now = Date.now()): RuntimeCircuitGate {
    const transitions: RuntimeCircuitGate["transitions"] = [];
    if (this.state.state === "open" && now >= this.state.cooldownUntilMs) {
      this.state.state = "half_open";
      this.state.lastStateChangedAt = toIso(now);
      this.state.halfOpenInFlight = 0;
      this.state.halfOpenSuccesses = 0;
      transitions.push({
        type: "half_open",
        at: this.state.lastStateChangedAt,
        reason: "cooldown_elapsed",
      });
    }

    if (this.state.state === "open") {
      this.state.blockedRequests += 1;
      this.state.lastBlockedAt = toIso(now);
      return {
        allowed: false,
        state: this.state.state,
        blocked: true,
        retryAt: this.state.cooldownUntilMs,
        transitions,
        snapshot: this.getSnapshot(),
      };
    }

    if (
      this.state.state === "half_open" &&
      this.state.halfOpenInFlight >= this.options.halfOpenMaxRequests
    ) {
      this.state.blockedRequests += 1;
      this.state.lastBlockedAt = toIso(now);
      return {
        allowed: false,
        state: this.state.state,
        blocked: true,
        retryAt: this.state.cooldownUntilMs,
        transitions,
        snapshot: this.getSnapshot(),
      };
    }

    if (this.state.state === "half_open") {
      this.state.halfOpenInFlight += 1;
    }

    this.state.lastRequestAt = toIso(now);
    return {
      allowed: true,
      state: this.state.state,
      blocked: false,
      transitions,
      snapshot: this.getSnapshot(),
    };
  }

  onSuccess(
    now = Date.now(),
    metadata: {
      latencyMs?: number;
    } = {},
  ): RuntimeCircuitOutcome {
    const transitions: RuntimeCircuitOutcome["transitions"] = [];
    this.state.lastSuccessAt = toIso(now);
    this.state.lastLatencyMs = numberOrNull(metadata.latencyMs);
    this.state.failureStreak = 0;
    this.state.lastFailure = null;

    if (this.state.state === "half_open") {
      this.state.halfOpenInFlight = Math.max(0, this.state.halfOpenInFlight - 1);
      this.state.halfOpenSuccesses += 1;
      if (this.state.halfOpenSuccesses >= this.options.successThreshold) {
        this.resetToClosed(now);
        const at = this.state.lastStateChangedAt ?? toIso(now);
        transitions.push({
          type: "closed",
          at,
          reason: "half_open_success",
        });
      }
    } else if (this.state.state !== "closed") {
      this.resetToClosed(now);
      const at = this.state.lastStateChangedAt ?? toIso(now);
      transitions.push({
        type: "closed",
        at,
        reason: "success_reset",
      });
    }

    return {
      transitions,
      snapshot: this.getSnapshot(),
    };
  }

  onFailure(
    now = Date.now(),
    metadata: {
      latencyMs?: number;
      error?: unknown;
    } = {},
  ): RuntimeCircuitOutcome {
    const transitions: RuntimeCircuitOutcome["transitions"] = [];
    this.state.lastFailureAt = toIso(now);
    this.state.lastFailure = metadata.error ?? null;
    this.state.lastLatencyMs = numberOrNull(metadata.latencyMs);

    if (this.state.state === "half_open") {
      this.state.halfOpenInFlight = Math.max(0, this.state.halfOpenInFlight - 1);
      this.open(now, "half_open_failure");
      const at = this.state.lastStateChangedAt ?? toIso(now);
      transitions.push({
        type: "open",
        at,
        reason: "half_open_failure",
      });
      return {
        transitions,
        snapshot: this.getSnapshot(),
      };
    }

    this.state.failureStreak += 1;
    if (this.state.failureStreak >= this.options.failureThreshold) {
      this.open(now, "failure_threshold");
      const at = this.state.lastStateChangedAt ?? toIso(now);
      transitions.push({
        type: "open",
        at,
        reason: "failure_threshold",
      });
    }

    return {
      transitions,
      snapshot: this.getSnapshot(),
    };
  }

  getSnapshot(): RuntimeCircuitSnapshot {
    return {
      key: this.key,
      state: this.state.state,
      failureStreak: this.state.failureStreak,
      openCount: this.state.openCount,
      blockedRequests: this.state.blockedRequests,
      cooldownMs: this.state.cooldownMs,
      cooldownUntilMs: this.state.cooldownUntilMs,
      lastStateChangedAt: this.state.lastStateChangedAt,
      lastRequestAt: this.state.lastRequestAt,
      lastSuccessAt: this.state.lastSuccessAt,
      lastFailureAt: this.state.lastFailureAt,
      lastBlockedAt: this.state.lastBlockedAt,
      lastFailure: this.state.lastFailure,
      lastLatencyMs: this.state.lastLatencyMs,
      lastOpenReason: this.state.lastOpenReason,
      halfOpenInFlight: this.state.halfOpenInFlight,
      halfOpenSuccesses: this.state.halfOpenSuccesses,
    };
  }

  private resetToClosed(now: number): void {
    this.state.state = "closed";
    this.state.failureStreak = 0;
    this.state.cooldownUntilMs = 0;
    this.state.cooldownMs = this.options.cooldownMs;
    this.state.halfOpenInFlight = 0;
    this.state.halfOpenSuccesses = 0;
    this.state.lastStateChangedAt = toIso(now);
    this.state.lastOpenReason = null;
  }

  private open(now: number, reason: string): void {
    this.state.state = "open";
    this.state.openCount += 1;
    this.state.failureStreak = Math.max(this.state.failureStreak, this.options.failureThreshold);
    this.state.cooldownMs = computeEscalatedCooldown(this.options, this.state.openCount);
    this.state.cooldownUntilMs = now + this.state.cooldownMs;
    this.state.halfOpenInFlight = 0;
    this.state.halfOpenSuccesses = 0;
    this.state.lastStateChangedAt = toIso(now);
    this.state.lastOpenReason = reason;
  }
}

export function createCircuitSnapshot(
  key: string,
  options: CircuitBreakerOptions = {},
  snapshot: CircuitSnapshotInput = null,
): RuntimeCircuitSnapshot {
  return new CircuitBreaker(key, options, snapshot).getSnapshot();
}

function normalizeSnapshot(
  key: string,
  snapshot: CircuitSnapshotInput,
  options: Required<CircuitBreakerOptions>,
): RuntimeCircuitSnapshot {
  const normalized = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    key,
    state: normalizeState(normalized.state),
    failureStreak: numberOrZero(normalized.failureStreak),
    openCount: numberOrZero(normalized.openCount),
    blockedRequests: numberOrZero(normalized.blockedRequests),
    cooldownMs: numberOrZero(normalized.cooldownMs) || options.cooldownMs,
    cooldownUntilMs: numberOrZero(normalized.cooldownUntilMs),
    lastStateChangedAt: normalizeNullableString(normalized.lastStateChangedAt),
    lastRequestAt: normalizeNullableString(normalized.lastRequestAt),
    lastSuccessAt: normalizeNullableString(normalized.lastSuccessAt),
    lastFailureAt: normalizeNullableString(normalized.lastFailureAt),
    lastBlockedAt: normalizeNullableString(normalized.lastBlockedAt),
    lastFailure: normalized.lastFailure ?? null,
    lastLatencyMs: numberOrNull(normalized.lastLatencyMs),
    lastOpenReason: normalizeNullableString(normalized.lastOpenReason),
    halfOpenInFlight: numberOrZero(normalized.halfOpenInFlight),
    halfOpenSuccesses: numberOrZero(normalized.halfOpenSuccesses),
  };
}

function normalizeState(value: unknown): RuntimeCircuitState {
  return value === "open" || value === "half_open" ? value : "closed";
}

function computeEscalatedCooldown(
  options: Required<CircuitBreakerOptions>,
  openCount: number,
): number {
  const multiplier = Math.min(Math.max(openCount, 1), 4);
  return Math.min(options.maxCooldownMs, options.cooldownMs * multiplier);
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
