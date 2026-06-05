import fs from "node:fs/promises";
import path from "node:path";

import { CircuitBreaker } from "./circuit-breaker.mjs";

import type {
  ResolvedConfig,
  RuntimeCircuitGate,
  RuntimeCircuitOutcome,
  RuntimeCircuitSnapshot,
  RuntimeCircuitState,
  RuntimeHealthOverview,
  RuntimeHealthScorecard,
  RuntimeLayerName,
  RuntimeLayerScoreSummary,
  RuntimeMcpServerSummary,
  RuntimeRequestMetrics,
  RuntimeShellSummary,
} from "../types/contracts.js";

const LATENCY_BUCKETS = [250, 500, 1000, 2500, 5000, 10000] as const;

type RuntimeHealthConfig = Pick<ResolvedConfig, "projectStateDir"> & {
  runtimeCircuitFailureThreshold?: number;
  runtimeCircuitCooldownMs?: number;
  runtimeCircuitHalfOpenMaxRequests?: number;
};

interface RuntimeSessionContext {
  sessionId: string | null;
  parentSessionId: string | null;
  rootSessionId: string | null;
  resumedFromSessionId: string | null;
  boundAt: string;
}

interface LayerCircuitEntry extends RuntimeCircuitSnapshot {
  layer?: string;
  provider?: string | null;
  requestClass?: string;
  endpoint?: string | null;
  serverId?: string;
  serverName?: string | null;
}

interface RuntimeRequestLayerState {
  requestClasses: Record<string, RuntimeRequestMetrics>;
  circuits: Record<string, LayerCircuitEntry>;
}

interface RuntimeMcpLayerState extends RuntimeRequestLayerState {
  servers: RuntimeMcpServerSummary[];
}

interface RuntimeShellLayerState {
  summary: RuntimeShellSummary;
}

interface RuntimeState {
  version: number;
  updatedAt: string;
  lastSessionContext: RuntimeSessionContext | null;
  layers: {
    provider: RuntimeRequestLayerState;
    web: RuntimeRequestLayerState;
    mcp: RuntimeMcpLayerState;
    shell: RuntimeShellLayerState;
  };
}

interface RuntimeCircuitEvent extends Record<string, unknown> {
  type: string;
  requestClass: string;
  endpoint: string | null;
  circuit: LayerCircuitEntry | RuntimeCircuitSnapshot;
  reason: string;
  traceId?: string | null;
  provider?: string;
  requestType?: string;
  serverId?: string;
  serverName?: string | null;
}

interface ProviderRequestOptions {
  provider: string;
  requestType: string;
  endpoint: string | null;
  traceId?: string | null;
}

interface WebRequestOptions {
  provider?: string | null;
  requestType: string;
  endpoint: string | null;
  traceId?: string | null;
}

interface McpRequestOptions {
  serverId: string;
  serverName?: string | null;
  requestClass: string;
  endpoint: string | null;
  traceId?: string | null;
}

interface OutcomeOptions {
  success: boolean;
  totalDurationMs: number;
  error?: unknown;
}

interface WebRuntimeEvent extends Record<string, unknown> {
  type: string;
  requestType?: string;
  provider?: string | null;
  durationMs?: number;
  error?: unknown;
}

interface McpRuntimeEvent extends Record<string, unknown> {
  type: string;
  method?: string;
  serverId?: string;
  serverName?: string | null;
  latencyMs?: number;
  error?: unknown;
}

interface McpServerInput extends Partial<RuntimeMcpServerSummary> {
  id?: string | null;
  name?: string | null;
}

interface ShellJobSnapshot {
  live?: boolean;
  status?: string;
  background?: boolean;
  continuityState?: string;
  reattached?: boolean;
  historicalOnly?: boolean;
  timedOut?: boolean;
}

interface ShellSnapshotMetadata {
  sessionId?: string | null;
}

interface CircuitLayerSummary {
  total: number;
  open: number;
  halfOpen: number;
  closed: number;
  [key: string]: number;
}

interface RuntimeInspectLayer {
  layer: RuntimeLayerName | string;
  requestClasses?: Record<string, RuntimeRequestMetrics>;
  circuits?: LayerCircuitEntry[];
  servers?: RuntimeMcpServerSummary[];
  summary?: RuntimeShellSummary;
  error?: string;
}
export class RuntimeHealth {
  readonly config: RuntimeHealthConfig;
  readonly runtimeDir: string;
  readonly filePath: string;
  initialized: boolean;
  circuitBreakers: Map<string, CircuitBreaker>;
  state: RuntimeState;

  constructor(config: RuntimeHealthConfig) {
    this.config = config;
    this.runtimeDir = path.join(config.projectStateDir, "runtime");
    this.filePath = path.join(this.runtimeDir, "health.json");
    this.initialized = false;
    this.circuitBreakers = new Map();
    this.state = createDefaultState();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.runtimeDir, { recursive: true });
    const contents = await fs.readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (contents) {
      const parsed = JSON.parse(contents) as unknown;
      this.state = normalizeState(parsed);
    }
    this.initialized = true;
  }

  async bindSession(context: Partial<RuntimeSessionContext> = {}): Promise<void> {
    await this.initialize();
    this.state.lastSessionContext = {
      sessionId: context.sessionId ?? null,
      parentSessionId: context.parentSessionId ?? null,
      rootSessionId: context.rootSessionId ?? null,
      resumedFromSessionId: context.resumedFromSessionId ?? null,
      boundAt: new Date().toISOString(),
    };
    this.touch();
    await this.persist();
  }

  async beforeProviderRequest({
    provider,
    requestType,
    endpoint,
    traceId = null,
  }: ProviderRequestOptions): Promise<{
    requestClass: string;
    circuit: LayerCircuitEntry;
    allowed: boolean;
    blocked: boolean;
    retryAt: number | null;
    events: RuntimeCircuitEvent[];
  }> {
    await this.initialize();
    const requestClass = normalizeRequestClass(requestType);
    const circuit = this.getProviderCircuit(provider, requestClass);
    const gate = circuit.beforeRequest(Date.now());
    this.state.layers.provider.circuits[circuit.key] = {
      provider,
      requestClass,
      endpoint,
      ...gate.snapshot,
    };

    if (!gate.allowed) {
      const metrics = getMetrics(
        this.state.layers.provider.requestClasses,
        buildMetricsKey("provider", provider, requestClass),
        {
          layer: "provider",
          provider,
          requestClass,
        },
      );
      metrics.blockedByCircuitCount += 1;
      metrics.lastBlockedAt = new Date().toISOString();
      this.refreshRequestHealth(metrics, gate.snapshot.state);
    }

    this.touch();
    await this.persist();
    return {
      requestClass,
      circuit: this.state.layers.provider.circuits[circuit.key],
      allowed: gate.allowed,
      blocked: gate.blocked,
      retryAt: gate.retryAt ?? null,
      events: gate.transitions.map((transition) => ({
        type:
          transition.type === "half_open"
            ? "provider_circuit_half_open"
            : transition.type === "closed"
              ? "provider_circuit_closed"
              : "provider_circuit_opened",
        provider,
        requestType,
        requestClass,
        endpoint,
        traceId,
        circuit: this.state.layers.provider.circuits[circuit.key],
        reason: transition.reason,
      })),
    };
  }

  async beforeWebRequest({
    provider = null,
    requestType,
    endpoint,
    traceId = null,
  }: WebRequestOptions): Promise<{
    requestClass: string;
    circuit: LayerCircuitEntry;
    allowed: boolean;
    blocked: boolean;
    retryAt: number | null;
    events: RuntimeCircuitEvent[];
  }> {
    await this.initialize();
    const requestClass = normalizeWebRequestClass(requestType);
    const providerKey = provider ?? "default";
    const circuit = this.getWebCircuit(providerKey, requestClass);
    const gate = circuit.beforeRequest(Date.now());
    this.state.layers.web.circuits[circuit.key] = {
      layer: "web",
      provider: providerKey,
      requestClass,
      endpoint,
      ...gate.snapshot,
    };

    this.touch();
    await this.persist();
    return {
      requestClass,
      circuit: this.state.layers.web.circuits[circuit.key],
      allowed: gate.allowed,
      blocked: gate.blocked,
      retryAt: gate.retryAt ?? null,
      events: gate.transitions.map((transition) => ({
        type:
          transition.type === "half_open"
            ? "web_circuit_half_open"
            : transition.type === "closed"
              ? "web_circuit_closed"
              : "web_circuit_opened",
        provider: providerKey,
        requestType,
        requestClass,
        endpoint,
        traceId,
        circuit: this.state.layers.web.circuits[circuit.key],
        reason: transition.reason,
      })),
    };
  }

  async noteWebOutcome({
    provider = null,
    requestType,
    endpoint,
    success,
    totalDurationMs,
    error = null,
  }: WebRequestOptions & OutcomeOptions): Promise<{
    requestClass: string;
    circuit: LayerCircuitEntry;
    events: RuntimeCircuitEvent[];
  }> {
    await this.initialize();
    const requestClass = normalizeWebRequestClass(requestType);
    const providerKey = provider ?? "default";
    const circuit = this.getWebCircuit(providerKey, requestClass);
    const now = Date.now();
    let events: RuntimeCircuitEvent[] = [];

    if (success) {
      const outcome = circuit.onSuccess(now, { latencyMs: totalDurationMs });
      events = outcome.transitions.map((transition) => ({
        type:
          transition.type === "closed"
            ? "web_circuit_closed"
            : "web_circuit_half_open",
        provider: providerKey,
        requestType,
        requestClass,
        endpoint,
        circuit: outcome.snapshot,
        reason: transition.reason,
      }));
      this.state.layers.web.circuits[circuit.key] = {
        layer: "web",
        provider: providerKey,
        requestClass,
        endpoint,
        ...outcome.snapshot,
      };
    } else if (shouldTripCircuit(error)) {
      const outcome = circuit.onFailure(now, { latencyMs: totalDurationMs, error });
      events = outcome.transitions.map((transition) => ({
        type:
          transition.type === "open"
            ? "web_circuit_opened"
            : transition.type === "half_open"
              ? "web_circuit_half_open"
              : "web_circuit_closed",
        provider: providerKey,
        requestType,
        requestClass,
        endpoint,
        circuit: outcome.snapshot,
        reason: transition.reason,
      }));
      this.state.layers.web.circuits[circuit.key] = {
        layer: "web",
        provider: providerKey,
        requestClass,
        endpoint,
        ...outcome.snapshot,
      };
    } else {
      this.state.layers.web.circuits[circuit.key] = {
        layer: "web",
        provider: providerKey,
        requestClass,
        endpoint,
        ...circuit.getSnapshot(),
      };
    }

    this.touch();
    await this.persist();
    return {
      requestClass,
      circuit: cloneValue(this.state.layers.web.circuits[circuit.key]),
      events,
    };
  }

  async beforeMcpRequest({
    serverId,
    serverName = null,
    requestClass,
    endpoint,
    traceId = null,
  }: McpRequestOptions): Promise<{
    requestClass: string;
    circuit: LayerCircuitEntry;
    allowed: boolean;
    blocked: boolean;
    retryAt: number | null;
    events: RuntimeCircuitEvent[];
  }> {
    await this.initialize();
    const normalizedRequestClass = normalizeMcpRequestClass(requestClass);
    const circuit = this.getMcpCircuit(serverId, normalizedRequestClass);
    const gate = circuit.beforeRequest(Date.now());
    this.state.layers.mcp.circuits[circuit.key] = {
      layer: "mcp",
      provider: serverId,
      serverId,
      serverName,
      requestClass: normalizedRequestClass,
      endpoint,
      ...gate.snapshot,
    };

    this.touch();
    await this.persist();
    return {
      requestClass: normalizedRequestClass,
      circuit: this.state.layers.mcp.circuits[circuit.key],
      allowed: gate.allowed,
      blocked: gate.blocked,
      retryAt: gate.retryAt ?? null,
      events: gate.transitions.map((transition) => ({
        type:
          transition.type === "half_open"
            ? "mcp_circuit_half_open"
            : transition.type === "closed"
              ? "mcp_circuit_closed"
              : "mcp_circuit_opened",
        serverId,
        serverName,
        requestClass: normalizedRequestClass,
        endpoint,
        traceId,
        circuit: this.state.layers.mcp.circuits[circuit.key],
        reason: transition.reason,
      })),
    };
  }

  async noteMcpOutcome({
    serverId,
    serverName = null,
    requestClass,
    endpoint,
    success,
    totalDurationMs,
    error = null,
  }: McpRequestOptions & OutcomeOptions): Promise<{
    requestClass: string;
    circuit: LayerCircuitEntry;
    events: RuntimeCircuitEvent[];
  }> {
    await this.initialize();
    const normalizedRequestClass = normalizeMcpRequestClass(requestClass);
    const circuit = this.getMcpCircuit(serverId, normalizedRequestClass);
    const now = Date.now();
    let events: RuntimeCircuitEvent[] = [];

    if (success) {
      const outcome = circuit.onSuccess(now, { latencyMs: totalDurationMs });
      events = outcome.transitions.map((transition) => ({
        type:
          transition.type === "closed"
            ? "mcp_circuit_closed"
            : "mcp_circuit_half_open",
        serverId,
        serverName,
        requestClass: normalizedRequestClass,
        endpoint,
        circuit: outcome.snapshot,
        reason: transition.reason,
      }));
      this.state.layers.mcp.circuits[circuit.key] = {
        layer: "mcp",
        provider: serverId,
        serverId,
        serverName,
        requestClass: normalizedRequestClass,
        endpoint,
        ...outcome.snapshot,
      };
    } else if (shouldTripCircuit(error)) {
      const outcome = circuit.onFailure(now, { latencyMs: totalDurationMs, error });
      events = outcome.transitions.map((transition) => ({
        type:
          transition.type === "open"
            ? "mcp_circuit_opened"
            : transition.type === "half_open"
              ? "mcp_circuit_half_open"
              : "mcp_circuit_closed",
        serverId,
        serverName,
        requestClass: normalizedRequestClass,
        endpoint,
        circuit: outcome.snapshot,
        reason: transition.reason,
      }));
      this.state.layers.mcp.circuits[circuit.key] = {
        layer: "mcp",
        provider: serverId,
        serverId,
        serverName,
        requestClass: normalizedRequestClass,
        endpoint,
        ...outcome.snapshot,
      };
    } else {
      this.state.layers.mcp.circuits[circuit.key] = {
        layer: "mcp",
        provider: serverId,
        serverId,
        serverName,
        requestClass: normalizedRequestClass,
        endpoint,
        ...circuit.getSnapshot(),
      };
    }

    this.touch();
    await this.persist();
    return {
      requestClass: normalizedRequestClass,
      circuit: cloneValue(this.state.layers.mcp.circuits[circuit.key]),
      events,
    };
  }

  async noteProviderRetry({
    provider,
    requestType,
    endpoint,
    delayMs = 0,
  }: ProviderRequestOptions & { delayMs?: number }): Promise<void> {
    await this.initialize();
    const requestClass = normalizeRequestClass(requestType);
    const metrics = getMetrics(
      this.state.layers.provider.requestClasses,
      buildMetricsKey("provider", provider, requestClass),
      {
        layer: "provider",
        provider,
        requestClass,
        endpoint,
      },
    );
    metrics.totalRetries += 1;
    metrics.retryDelayMs += Math.max(0, Number(delayMs) || 0);
    this.refreshRequestHealth(
      metrics,
      this.getProviderCircuit(provider, requestClass).getSnapshot().state,
    );
    this.touch();
    await this.persist();
  }

  async noteProviderFallback({
    provider,
    requestType,
  }: Pick<ProviderRequestOptions, "provider" | "requestType">): Promise<void> {
    await this.initialize();
    const requestClass = normalizeRequestClass(requestType);
    const metrics = getMetrics(
      this.state.layers.provider.requestClasses,
      buildMetricsKey("provider", provider, requestClass),
      {
        layer: "provider",
        provider,
        requestClass,
      },
    );
    metrics.fallbackCount += 1;
    this.refreshRequestHealth(
      metrics,
      this.getProviderCircuit(provider, requestClass).getSnapshot().state,
    );
    this.touch();
    await this.persist();
  }

  async noteProviderOutcome({
    provider,
    requestType,
    endpoint,
    success,
    totalDurationMs,
    error = null,
  }: ProviderRequestOptions & OutcomeOptions): Promise<{
    requestClass: string;
    metrics: RuntimeRequestMetrics;
    circuit: LayerCircuitEntry;
    events: RuntimeCircuitEvent[];
  }> {
    await this.initialize();
    const requestClass = normalizeRequestClass(requestType);
    const key = buildMetricsKey("provider", provider, requestClass);
    const metrics = getMetrics(this.state.layers.provider.requestClasses, key, {
      layer: "provider",
      provider,
      requestClass,
      endpoint,
    });
    const circuit = this.getProviderCircuit(provider, requestClass);
    const now = Date.now();
    metrics.totalRequests += 1;
    metrics.lastRequestAt = new Date(now).toISOString();
    pushLatency(metrics, totalDurationMs);

    let events: RuntimeCircuitEvent[] = [];
    if (success) {
      metrics.successCount += 1;
      metrics.lastSuccessAt = new Date(now).toISOString();
      const outcome = circuit.onSuccess(now, { latencyMs: totalDurationMs });
      events = outcome.transitions.map((transition) => ({
        type:
          transition.type === "closed"
            ? "provider_circuit_closed"
            : "provider_circuit_half_open",
        provider,
        requestType,
        requestClass,
        endpoint,
        circuit: outcome.snapshot,
        reason: transition.reason,
      }));
      this.state.layers.provider.circuits[circuit.key] = {
        provider,
        requestClass,
        endpoint,
        ...outcome.snapshot,
      };
      this.refreshRequestHealth(metrics, outcome.snapshot.state);
    } else {
      const normalizedError = toRecord(error);
      metrics.failureCount += 1;
      metrics.lastFailureAt = new Date(now).toISOString();
      metrics.lastError = error ?? null;
      if (normalizedError.retryExhausted === true) {
        metrics.retryExhaustedCount += 1;
        updateRetryFingerprint(metrics, normalizedError);
      }
      if (
        normalizedError.taxonomy === "provider_timeout" ||
        normalizedError.reasonTaxonomy === "provider_timeout"
      ) {
        metrics.timeoutCount += 1;
      }
      if (Number(normalizedError.status) === 429) {
        metrics.http429Count += 1;
      }
      if (Number(normalizedError.status) >= 500 && Number(normalizedError.status) <= 599) {
        metrics.http5xxCount += 1;
      }

      if (shouldTripCircuit(normalizedError)) {
        const outcome = circuit.onFailure(now, { latencyMs: totalDurationMs, error });
        events = outcome.transitions.map((transition) => ({
          type:
            transition.type === "open"
              ? "provider_circuit_opened"
              : transition.type === "half_open"
                ? "provider_circuit_half_open"
                : "provider_circuit_closed",
          provider,
          requestType,
          requestClass,
          endpoint,
          circuit: outcome.snapshot,
          reason: transition.reason,
        }));
        this.state.layers.provider.circuits[circuit.key] = {
          provider,
          requestClass,
          endpoint,
          ...outcome.snapshot,
        };
        this.refreshRequestHealth(metrics, outcome.snapshot.state);
      } else {
        this.state.layers.provider.circuits[circuit.key] = {
          provider,
          requestClass,
          endpoint,
          ...circuit.getSnapshot(),
        };
        this.refreshRequestHealth(metrics, circuit.getSnapshot().state);
      }
    }

    this.touch();
    await this.persist();
    return {
      requestClass,
      metrics: cloneValue(metrics),
      circuit: cloneValue(this.state.layers.provider.circuits[circuit.key]),
      events,
    };
  }

  async recordWebEvent(event: WebRuntimeEvent): Promise<void> {
    await this.initialize();
    const requestClass = normalizeWebRequestClass(toString(event.requestType) ?? "unknown");
    const metrics = getMetrics(
      this.state.layers.web.requestClasses,
      buildMetricsKey("web", toString(event.provider), requestClass),
      {
        layer: "web",
        provider: toString(event.provider),
        requestClass,
      },
    );

    if (event.type === "web_retry_scheduled") {
      metrics.totalRetries += 1;
    }
    if (event.type === "web_cache_hit") {
      metrics.cacheHitCount += 1;
    }
    if (event.type === "web_attempt_succeeded") {
      metrics.totalRequests += 1;
      metrics.successCount += 1;
      metrics.lastSuccessAt = new Date().toISOString();
      pushLatency(metrics, Number(event.durationMs) || 0);
    }
    if (event.type === "web_attempt_exhausted") {
      const error = toRecord(event.error);
      metrics.totalRequests += 1;
      metrics.failureCount += 1;
      metrics.retryExhaustedCount += 1;
      metrics.lastFailureAt = new Date().toISOString();
      pushLatency(metrics, Number(event.durationMs) || 0);
      if (Number(error.status) === 429) {
        metrics.http429Count += 1;
      }
      if (Number(error.status) >= 500 && Number(error.status) <= 599) {
        metrics.http5xxCount += 1;
      }
      if (error.taxonomy === "fetch_timeout") {
        metrics.timeoutCount += 1;
      }
      updateRetryFingerprint(metrics, error);
    }

    if (event.type === "web_circuit_blocked") {
      metrics.blockedByCircuitCount += 1;
      metrics.lastBlockedAt = new Date().toISOString();
      metrics.lastError = event.error ?? null;
    }

    const circuitState = getLayerCircuitState(
      this.state.layers.web.circuits,
      buildCircuitKey("web", toString(event.provider) ?? "default", requestClass),
    );
    this.refreshRequestHealth(metrics, circuitState);
    this.touch();
    await this.persist();
  }

  async recordMcpEvent(event: McpRuntimeEvent, servers: McpServerInput[] = []): Promise<void> {
    await this.initialize();
    const requestClass = classifyMcpRequestClass(event);
    const metrics = getMetrics(
      this.state.layers.mcp.requestClasses,
      buildMetricsKey("mcp", event.serverId ?? toString(event.serverName) ?? "mcp", requestClass),
      {
        layer: "mcp",
        provider: event.serverId ?? null,
        requestClass,
      },
    );

    if (event.type === "mcp_client_retry_scheduled") {
      metrics.totalRetries += 1;
    }
    if (
      ["mcp_client_initialized", "mcp_client_ping_succeeded", "mcp_client_tools_listed", "mcp_client_tool_called"].includes(event.type)
    ) {
      metrics.totalRequests += 1;
      metrics.successCount += 1;
      metrics.lastSuccessAt = new Date().toISOString();
      pushLatency(metrics, Number(event.latencyMs) || 0);
    }
    if (["mcp_client_request_exhausted", "mcp_registry_server_failed"].includes(event.type)) {
      metrics.totalRequests += 1;
      metrics.failureCount += 1;
      metrics.retryExhaustedCount += 1;
      metrics.lastFailureAt = new Date().toISOString();
      updateRetryFingerprint(metrics, toRecord(event.error));
    }

    if (event.type === "mcp_circuit_blocked") {
      metrics.blockedByCircuitCount += 1;
      metrics.lastBlockedAt = new Date().toISOString();
      metrics.lastError = event.error ?? null;
    }

    this.state.layers.mcp.servers = servers.map((server) => ({
      id: toString(server.id),
      name: toString(server.name),
      status: toString(server.status),
      healthScore: toNullableNumber(server.healthScore),
      latencyMs: toNullableNumber(server.latencyMs),
      errorRate: toNullableNumber(server.errorRate),
      lastFailureAt: toString(server.lastFailureAt),
      lastSuccessAt: toString(server.lastSuccessAt),
    }));
    const circuitState = getLayerCircuitState(
      this.state.layers.mcp.circuits,
      buildCircuitKey("mcp", event.serverId ?? toString(event.serverName) ?? "mcp", requestClass),
    );
    this.refreshRequestHealth(metrics, circuitState);
    this.touch();
    await this.persist();
  }

  async setMcpServers(servers: McpServerInput[] = []): Promise<void> {
    await this.initialize();
    this.state.layers.mcp.servers = servers.map((server) => ({
      id: toString(server.id),
      name: toString(server.name),
      status: toString(server.status),
      healthScore: toNullableNumber(server.healthScore),
      latencyMs: toNullableNumber(server.latencyMs),
      errorRate: toNullableNumber(server.errorRate),
      lastFailureAt: toString(server.lastFailureAt),
      lastSuccessAt: toString(server.lastSuccessAt),
    }));
    this.touch();
    await this.persist();
  }

  async noteShellSnapshot(
    jobs: ShellJobSnapshot[] = [],
    metadata: ShellSnapshotMetadata = {},
  ): Promise<void> {
    await this.initialize();
    const summary: RuntimeShellSummary = {
      totalJobs: jobs.length,
      liveJobs: jobs.filter((job) => job.live).length,
      runningJobs: jobs.filter((job) => job.status === "running").length,
      backgroundJobs: jobs.filter((job) => job.background).length,
      orphanedJobs: jobs.filter((job) => job.continuityState === "orphaned" || job.status === "orphaned").length,
      reattachedJobs: jobs.filter((job) => job.reattached).length,
      historicalJobs: jobs.filter((job) => job.historicalOnly).length,
      timedOutJobs: jobs.filter((job) => job.timedOut).length,
      failedJobs: jobs.filter((job) => job.status === "failed").length,
      lastSessionId: metadata.sessionId ?? this.state.lastSessionContext?.sessionId ?? null,
      updatedAt: new Date().toISOString(),
      healthScore: 100,
    };
    summary.healthScore = computeShellHealthScore(summary);
    this.state.layers.shell.summary = summary;
    this.touch();
    await this.persist();
  }

  getOverview(): RuntimeHealthOverview {
    return {
      updatedAt: this.state.updatedAt,
      lastSessionContext: this.state.lastSessionContext,
      scorecard: this.getScorecard(),
      provider: {
        requestClasses: cloneValue(this.state.layers.provider.requestClasses),
        circuits: cloneValue(this.state.layers.provider.circuits),
      },
      web: cloneValue(this.state.layers.web),
      mcp: cloneValue(this.state.layers.mcp),
      shell: cloneValue(this.state.layers.shell),
    };
  }

  getScorecard(): RuntimeHealthScorecard {
    const providerEntries = Object.values(this.state.layers.provider.requestClasses);
    const providerCircuits = Object.values(this.state.layers.provider.circuits);
    const webEntries = Object.values(this.state.layers.web.requestClasses);
    const webCircuits = Object.values(this.state.layers.web.circuits);
    const mcpEntries = Object.values(this.state.layers.mcp.requestClasses);
    const mcpCircuits = Object.values(this.state.layers.mcp.circuits);
    const shellSummary = this.state.layers.shell.summary;
    const allCircuits = [...providerCircuits, ...webCircuits, ...mcpCircuits];

    const circuitSummary = {
      total: allCircuits.length,
      open: allCircuits.filter((entry) => entry.state === "open").length,
      halfOpen: allCircuits.filter((entry) => entry.state === "half_open").length,
      closed: allCircuits.filter((entry) => entry.state === "closed").length,
      byLayer: {
        provider: summarizeCircuitLayer(providerCircuits),
        web: summarizeCircuitLayer(webCircuits),
        mcp: summarizeCircuitLayer(mcpCircuits),
      },
    };

    const retryPressure = calculateRetryPressure(providerEntries);
    const degradedFlags: string[] = [];
    if (circuitSummary.open > 0) {
      if (circuitSummary.byLayer.provider.open > 0) {
        degradedFlags.push("provider_circuit_open");
      }
      if (circuitSummary.byLayer.web.open > 0) {
        degradedFlags.push("web_circuit_open");
      }
      if (circuitSummary.byLayer.mcp.open > 0) {
        degradedFlags.push("mcp_circuit_open");
      }
    }
    if (circuitSummary.byLayer.provider.halfOpen > 0) {
      degradedFlags.push("provider_half_open");
    }
    if (circuitSummary.byLayer.web.halfOpen > 0) {
      degradedFlags.push("web_half_open");
    }
    if (circuitSummary.byLayer.mcp.halfOpen > 0) {
      degradedFlags.push("mcp_half_open");
    }
    if (retryPressure >= 0.35) {
      degradedFlags.push("high_retry_pressure");
    }
    if ((shellSummary.orphanedJobs ?? 0) > 0) {
      degradedFlags.push("shell_orphaned_jobs");
    }

    return {
      provider: summarizeLayer(providerEntries),
      web: summarizeLayer(webEntries),
      mcp: summarizeLayer(mcpEntries),
      shell: shellSummary,
      circuits: circuitSummary,
      retryPressure,
      degradedFlags,
    };
  }

  listCircuits(layer: RuntimeLayerName = "provider"): LayerCircuitEntry[] {
    if (layer === "provider") {
      return sortCircuits(this.state.layers.provider.circuits);
    }
    if (layer === "web") {
      return sortCircuits(this.state.layers.web.circuits);
    }
    if (layer === "mcp") {
      return sortCircuits(this.state.layers.mcp.circuits);
    }
    if (layer === "all") {
      return [
        ...sortCircuits(this.state.layers.provider.circuits),
        ...sortCircuits(this.state.layers.web.circuits),
        ...sortCircuits(this.state.layers.mcp.circuits),
      ];
    }
    return [];
  }

  inspectLayer(layer: RuntimeLayerName | string = "provider"): RuntimeInspectLayer {
    if (layer === "provider") {
      return {
        layer,
        requestClasses: cloneValue(this.state.layers.provider.requestClasses),
        circuits: this.listCircuits("provider"),
      };
    }
    if (layer === "web") {
      return {
        layer,
        requestClasses: cloneValue(this.state.layers.web.requestClasses),
        circuits: this.listCircuits("web"),
      };
    }
    if (layer === "mcp") {
      return {
        layer,
        requestClasses: cloneValue(this.state.layers.mcp.requestClasses),
        circuits: this.listCircuits("mcp"),
        servers: cloneValue(this.state.layers.mcp.servers),
      };
    }
    if (layer === "shell") {
      return {
        layer,
        summary: cloneValue(this.state.layers.shell.summary),
      };
    }
    return {
      layer,
      error: `Unknown runtime layer "${layer}".`,
    };
  }

  exportState(): RuntimeState {
    return cloneValue(this.state);
  }

  getProviderCircuit(provider: string, requestClass: string): CircuitBreaker {
    const key = buildCircuitKey("provider", provider, requestClass);
    if (!this.circuitBreakers.has(key)) {
      this.circuitBreakers.set(
        key,
        new CircuitBreaker(
          key,
          {
            failureThreshold: Number(this.config.runtimeCircuitFailureThreshold ?? 3),
            cooldownMs: Number(this.config.runtimeCircuitCooldownMs ?? 15000),
            halfOpenMaxRequests: Number(this.config.runtimeCircuitHalfOpenMaxRequests ?? 1),
          },
          this.state.layers.provider.circuits[key],
        ),
      );
    }
    return this.circuitBreakers.get(key) as CircuitBreaker;
  }

  getWebCircuit(provider: string, requestClass: string): CircuitBreaker {
    const key = buildCircuitKey("web", provider, requestClass);
    if (!this.circuitBreakers.has(key)) {
      this.circuitBreakers.set(
        key,
        new CircuitBreaker(
          key,
          {
            failureThreshold: Number(this.config.runtimeCircuitFailureThreshold ?? 3),
            cooldownMs: Number(this.config.runtimeCircuitCooldownMs ?? 15000),
            halfOpenMaxRequests: Number(this.config.runtimeCircuitHalfOpenMaxRequests ?? 1),
          },
          this.state.layers.web.circuits[key],
        ),
      );
    }
    return this.circuitBreakers.get(key) as CircuitBreaker;
  }

  getMcpCircuit(serverId: string, requestClass: string): CircuitBreaker {
    const key = buildCircuitKey("mcp", serverId, requestClass);
    if (!this.circuitBreakers.has(key)) {
      this.circuitBreakers.set(
        key,
        new CircuitBreaker(
          key,
          {
            failureThreshold: Number(this.config.runtimeCircuitFailureThreshold ?? 3),
            cooldownMs: Number(this.config.runtimeCircuitCooldownMs ?? 15000),
            halfOpenMaxRequests: Number(this.config.runtimeCircuitHalfOpenMaxRequests ?? 1),
          },
          this.state.layers.mcp.circuits[key],
        ),
      );
    }
    return this.circuitBreakers.get(key) as CircuitBreaker;
  }

  refreshRequestHealth(
    metrics: RuntimeRequestMetrics,
    circuitState: RuntimeCircuitState = "closed",
  ): void {
    metrics.avgLatencyMs = average(metrics.totalLatencyMs, metrics.totalRequests);
    metrics.approxP95Ms = estimatePercentile(metrics.latencyBuckets, 0.95);
    metrics.approxP99Ms = estimatePercentile(metrics.latencyBuckets, 0.99);
    metrics.retryPressure = Number(
      (metrics.totalRetries / Math.max(1, metrics.totalRequests)).toFixed(3),
    );
    metrics.healthScore = computeRequestHealthScore(metrics, circuitState);
  }

  async persist(): Promise<void> {
    await this.initialize();
    this.touch();
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }
}

export function scopeRuntimeHealthOverviewToProvider(
  overview: RuntimeHealthOverview,
  provider: string | null | undefined,
): RuntimeHealthOverview {
  const scoped = cloneValue(overview);
  const normalizedProvider = typeof provider === "string" && provider.length > 0
    ? provider
    : null;
  if (!normalizedProvider) {
    return scoped;
  }

  const providerRequestClasses = Object.fromEntries(
    Object.entries(scoped.provider.requestClasses).filter(([, metrics]) => metrics.provider === normalizedProvider),
  );
  const providerCircuits = Object.fromEntries(
    Object.entries(scoped.provider.circuits).filter(([, circuit]) => circuit.provider === normalizedProvider),
  );
  const providerEntries = Object.values(providerRequestClasses);
  const providerCircuitEntries = Object.values(providerCircuits);
  const webCircuitSummary = summarizeCircuitLayer(Object.values(scoped.web.circuits));
  const mcpCircuitSummary = summarizeCircuitLayer(Object.values(scoped.mcp.circuits));
  const providerCircuitSummary = summarizeCircuitLayer(providerCircuitEntries);
  const retryPressure = calculateRetryPressure(providerEntries);

  scoped.provider.requestClasses = providerRequestClasses;
  scoped.provider.circuits = providerCircuits;
  scoped.scorecard = {
    ...scoped.scorecard,
    provider: summarizeLayer(providerEntries),
    retryPressure,
    degradedFlags: buildScopedDegradedFlags(
      scoped.scorecard.degradedFlags ?? [],
      providerCircuitSummary,
      retryPressure,
    ),
    circuits: {
      ...(scoped.scorecard.circuits ?? {}),
      total: providerCircuitSummary.total + webCircuitSummary.total + mcpCircuitSummary.total,
      open: providerCircuitSummary.open + webCircuitSummary.open + mcpCircuitSummary.open,
      halfOpen: providerCircuitSummary.halfOpen + webCircuitSummary.halfOpen + mcpCircuitSummary.halfOpen,
      closed: providerCircuitSummary.closed + webCircuitSummary.closed + mcpCircuitSummary.closed,
      byLayer: {
        ...(scoped.scorecard.circuits?.byLayer ?? {}),
        provider: providerCircuitSummary,
        web: webCircuitSummary,
        mcp: mcpCircuitSummary,
      },
    },
  };
  return scoped;
}

function createDefaultState(): RuntimeState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    lastSessionContext: null,
    layers: {
      provider: {
        requestClasses: {},
        circuits: {},
      },
      web: {
        requestClasses: {},
        circuits: {},
      },
      mcp: {
        requestClasses: {},
        circuits: {},
        servers: [],
      },
      shell: {
        summary: {
          totalJobs: 0,
          liveJobs: 0,
          runningJobs: 0,
          backgroundJobs: 0,
          orphanedJobs: 0,
          reattachedJobs: 0,
          historicalJobs: 0,
          timedOutJobs: 0,
          failedJobs: 0,
          lastSessionId: null,
          updatedAt: null,
          healthScore: 100,
        },
      },
    },
  };
}

function normalizeState(value: unknown): RuntimeState {
  const state = createDefaultState();
  const record = toRecord(value);
  const layers = toRecord(record.layers);
  const provider = toRecord(layers.provider);
  const web = toRecord(layers.web);
  const mcp = toRecord(layers.mcp);
  const shell = toRecord(layers.shell);

  state.updatedAt = toString(record.updatedAt) ?? state.updatedAt;
  state.lastSessionContext = normalizeSessionContext(record.lastSessionContext);
  state.layers.provider.requestClasses = normalizeRequestClasses(provider.requestClasses);
  state.layers.provider.circuits = normalizeCircuitEntries(provider.circuits);
  state.layers.web.requestClasses = normalizeRequestClasses(web.requestClasses);
  state.layers.web.circuits = normalizeCircuitEntries(web.circuits);
  state.layers.mcp.requestClasses = normalizeRequestClasses(mcp.requestClasses);
  state.layers.mcp.circuits = normalizeCircuitEntries(mcp.circuits);
  state.layers.mcp.servers = Array.isArray(mcp.servers)
    ? mcp.servers.map((entry) => normalizeMcpServer(entry))
    : [];
  state.layers.shell.summary = {
    ...state.layers.shell.summary,
    ...normalizeShellSummary(shell.summary),
  };
  return state;
}

function normalizeSessionContext(value: unknown): RuntimeSessionContext | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = toRecord(value);
  return {
    sessionId: toString(record.sessionId),
    parentSessionId: toString(record.parentSessionId),
    rootSessionId: toString(record.rootSessionId),
    resumedFromSessionId: toString(record.resumedFromSessionId),
    boundAt: toString(record.boundAt) ?? new Date().toISOString(),
  };
}

function normalizeRequestClasses(value: unknown): Record<string, RuntimeRequestMetrics> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const output: Record<string, RuntimeRequestMetrics> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = normalizeMetrics(entry, key);
  }
  return output;
}

function normalizeCircuitEntries(value: unknown): Record<string, LayerCircuitEntry> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const output: Record<string, LayerCircuitEntry> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = normalizeCircuitEntry(key, entry);
  }
  return output;
}

function normalizeMcpServer(value: unknown): RuntimeMcpServerSummary {
  const record = toRecord(value);
  return {
    id: toString(record.id),
    name: toString(record.name),
    status: toString(record.status),
    healthScore: toNullableNumber(record.healthScore),
    latencyMs: toNullableNumber(record.latencyMs),
    errorRate: toNullableNumber(record.errorRate),
    lastFailureAt: toString(record.lastFailureAt),
    lastSuccessAt: toString(record.lastSuccessAt),
  };
}

function normalizeShellSummary(value: unknown): Partial<RuntimeShellSummary> {
  const record = toRecord(value);
  return {
    totalJobs: toNumber(record.totalJobs),
    liveJobs: toNumber(record.liveJobs),
    runningJobs: toNumber(record.runningJobs),
    backgroundJobs: toNumber(record.backgroundJobs),
    orphanedJobs: toNumber(record.orphanedJobs),
    reattachedJobs: toNumber(record.reattachedJobs),
    historicalJobs: toNumber(record.historicalJobs),
    timedOutJobs: toNumber(record.timedOutJobs),
    failedJobs: toNumber(record.failedJobs),
    lastSessionId: toString(record.lastSessionId),
    updatedAt: toString(record.updatedAt),
    healthScore: toNumber(record.healthScore) || 100,
  };
}

function normalizeMetrics(value: unknown, key: string): RuntimeRequestMetrics {
  const record = toRecord(value);
  const metrics = getMetrics({} as Record<string, RuntimeRequestMetrics>, key, {
    layer: toString(record.layer) ?? "provider",
    provider: toString(record.provider),
    requestClass: toString(record.requestClass) ?? "unknown",
    endpoint: toString(record.endpoint),
  });
  metrics.totalRequests = toNumber(record.totalRequests);
  metrics.successCount = toNumber(record.successCount);
  metrics.failureCount = toNumber(record.failureCount);
  metrics.totalRetries = toNumber(record.totalRetries);
  metrics.retryExhaustedCount = toNumber(record.retryExhaustedCount);
  metrics.fallbackCount = toNumber(record.fallbackCount);
  metrics.timeoutCount = toNumber(record.timeoutCount);
  metrics.http5xxCount = toNumber(record.http5xxCount);
  metrics.http429Count = toNumber(record.http429Count);
  metrics.cacheHitCount = toNumber(record.cacheHitCount);
  metrics.blockedByCircuitCount = toNumber(record.blockedByCircuitCount);
  metrics.totalLatencyMs = toNumber(record.totalLatencyMs);
  metrics.avgLatencyMs = toNumber(record.avgLatencyMs);
  metrics.approxP95Ms = toNumber(record.approxP95Ms);
  metrics.approxP99Ms = toNumber(record.approxP99Ms);
  metrics.retryPressure = toNullableNumber(record.retryPressure) ?? 0;
  metrics.healthScore = toNullableNumber(record.healthScore) ?? 100;
  metrics.retryDelayMs = toNumber(record.retryDelayMs);
  metrics.lastRequestAt = toString(record.lastRequestAt);
  metrics.lastSuccessAt = toString(record.lastSuccessAt);
  metrics.lastFailureAt = toString(record.lastFailureAt);
  metrics.lastBlockedAt = toString(record.lastBlockedAt);
  metrics.lastError = record.lastError ?? null;
  metrics.retryExhaustionFingerprints = Array.isArray(record.retryExhaustionFingerprints)
    ? record.retryExhaustionFingerprints
      .map((entry) => {
        const item = toRecord(entry);
        const fingerprint = toString(item.fingerprint);
        const lastSeenAt = toString(item.lastSeenAt);
        if (!fingerprint || !lastSeenAt) {
          return null;
        }
        return {
          fingerprint,
          count: Math.max(1, toNumber(item.count) || 1),
          lastSeenAt,
        };
      })
      .filter((entry): entry is RuntimeRequestMetrics["retryExhaustionFingerprints"][number] => Boolean(entry))
    : [];
  metrics.latencyBuckets = normalizeLatencyBuckets(record.latencyBuckets);
  return metrics;
}

function normalizeLatencyBuckets(value: unknown): Record<string, number> {
  const base = createLatencyBuckets();
  const record = toRecord(value);
  for (const key of Object.keys(base)) {
    base[key] = toNumber(record[key]);
  }
  return base;
}

function normalizeCircuitEntry(key: string, value: unknown): LayerCircuitEntry {
  const record = toRecord(value);
  return {
    key,
    layer: toString(record.layer) ?? undefined,
    provider: toString(record.provider),
    requestClass: toString(record.requestClass) ?? undefined,
    endpoint: toString(record.endpoint),
    serverId: toString(record.serverId) ?? undefined,
    serverName: toString(record.serverName),
    state: normalizeCircuitState(record.state),
    failureStreak: toNumber(record.failureStreak),
    openCount: toNumber(record.openCount),
    blockedRequests: toNumber(record.blockedRequests),
    cooldownMs: toNumber(record.cooldownMs),
    cooldownUntilMs: toNumber(record.cooldownUntilMs),
    lastStateChangedAt: toString(record.lastStateChangedAt),
    lastRequestAt: toString(record.lastRequestAt),
    lastSuccessAt: toString(record.lastSuccessAt),
    lastFailureAt: toString(record.lastFailureAt),
    lastBlockedAt: toString(record.lastBlockedAt),
    lastFailure: record.lastFailure ?? null,
    lastLatencyMs: toNullableNumber(record.lastLatencyMs),
    lastOpenReason: toString(record.lastOpenReason),
    halfOpenInFlight: toNumber(record.halfOpenInFlight),
    halfOpenSuccesses: toNumber(record.halfOpenSuccesses),
  };
}

function getMetrics(
  store: Record<string, RuntimeRequestMetrics>,
  key: string,
  defaults: {
    layer: string;
    provider?: string | null;
    requestClass: string;
    endpoint?: string | null;
  },
): RuntimeRequestMetrics {
  if (!store[key]) {
    store[key] = {
      key,
      layer: defaults.layer,
      provider: defaults.provider ?? null,
      requestClass: defaults.requestClass,
      endpoint: defaults.endpoint ?? null,
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      totalRetries: 0,
      retryExhaustedCount: 0,
      fallbackCount: 0,
      timeoutCount: 0,
      http5xxCount: 0,
      http429Count: 0,
      cacheHitCount: 0,
      blockedByCircuitCount: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      approxP95Ms: 0,
      approxP99Ms: 0,
      retryPressure: 0,
      healthScore: 100,
      retryDelayMs: 0,
      lastRequestAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastBlockedAt: null,
      lastError: null,
      retryExhaustionFingerprints: [],
      latencyBuckets: createLatencyBuckets(),
    };
  }
  return store[key];
}

function createLatencyBuckets(): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (const threshold of LATENCY_BUCKETS) {
    buckets[`<=${threshold}`] = 0;
  }
  buckets[">10000"] = 0;
  return buckets;
}

function pushLatency(metrics: RuntimeRequestMetrics, durationMs: number): void {
  const duration = Math.max(0, Number(durationMs) || 0);
  metrics.totalLatencyMs += duration;
  const bucketKey = LATENCY_BUCKETS.find((threshold) => duration <= threshold);
  if (bucketKey != null) {
    metrics.latencyBuckets[`<=${bucketKey}`] += 1;
  } else {
    metrics.latencyBuckets[">10000"] += 1;
  }
}

function updateRetryFingerprint(
  metrics: RuntimeRequestMetrics,
  error: Record<string, unknown>,
): void {
  const fingerprint = [
    toString(error.provider),
    toString(error.requestType) ?? toString(error.requestClass),
    toString(error.taxonomy),
    normalizeScalar(error.status),
    normalizeScalar(error.code),
  ]
    .filter((value): value is string => value != null && value !== "")
    .join(":");
  if (!fingerprint) {
    return;
  }

  const existing = metrics.retryExhaustionFingerprints.find((entry) => entry.fingerprint === fingerprint);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = new Date().toISOString();
  } else {
    metrics.retryExhaustionFingerprints.unshift({
      fingerprint,
      count: 1,
      lastSeenAt: new Date().toISOString(),
    });
    metrics.retryExhaustionFingerprints = metrics.retryExhaustionFingerprints.slice(0, 8);
  }
}

function shouldTripCircuit(error: unknown): boolean {
  const record = toRecord(error);
  if (!Object.keys(record).length) {
    return false;
  }

  if (record.taxonomy === "provider_retry_exhausted" || record.retryExhausted === true) {
    return true;
  }
  if (record.taxonomy === "provider_timeout") {
    return true;
  }
  if (Number(record.status) === 429) {
    return true;
  }
  return Number(record.status) >= 500 && Number(record.status) <= 599;
}

function normalizeRequestClass(requestType: string): string {
  if (requestType === "models_list") {
    return "models";
  }
  if (requestType === "non_stream_completion") {
    return "completion_non_stream";
  }
  if (requestType === "stream_completion") {
    return "completion_stream";
  }
  if (requestType === "tool_completion") {
    return "tool_calling_completion";
  }
  return `${requestType ?? "unknown"}`;
}

function classifyMcpRequestClass(event: McpRuntimeEvent): string {
  if (
    event.method === "tools/call" ||
    event.type === "mcp_client_tool_called" ||
    event.type === "mcp_tool_invocation_completed"
  ) {
    return "invoke";
  }
  return "connect";
}

function normalizeWebRequestClass(requestType: string): string {
  return `${requestType ?? "unknown"}`;
}

function normalizeMcpRequestClass(requestClass: string): string {
  return requestClass === "invoke" ? "invoke" : "connect";
}

function buildCircuitKey(layer: "provider" | "web" | "mcp", provider: string, requestClass: string): string {
  return `${layer}:${provider}:${requestClass}`;
}

function buildMetricsKey(layer: "provider" | "web" | "mcp", provider: string | null, requestClass: string): string {
  return provider ? `${layer}:${provider}:${requestClass}` : `${layer}:${requestClass}`;
}

function computeRequestHealthScore(
  metrics: RuntimeRequestMetrics,
  circuitState: RuntimeCircuitState,
): number {
  const total = Math.max(1, metrics.totalRequests);
  const failureRate = metrics.failureCount / total;
  const retryRate = metrics.totalRetries / total;
  const latencyPenalty = Math.min(20, Math.round((metrics.avgLatencyMs ?? 0) / 300));
  const failurePenalty = Math.min(45, Math.round(failureRate * 70));
  const retryPenalty = Math.min(20, Math.round(retryRate * 30));
  const timeoutPenalty = Math.min(10, metrics.timeoutCount * 2);
  const circuitPenalty = circuitState === "open" ? 30 : circuitState === "half_open" ? 15 : 0;
  return clampScore(100 - latencyPenalty - failurePenalty - retryPenalty - timeoutPenalty - circuitPenalty);
}

function computeShellHealthScore(summary: RuntimeShellSummary): number {
  const score = 100
    - Math.min(35, summary.orphanedJobs * 15)
    - Math.min(20, summary.failedJobs * 4)
    - Math.min(10, summary.timedOutJobs * 3);
  return clampScore(score);
}

function summarizeLayer(entries: RuntimeRequestMetrics[]): RuntimeLayerScoreSummary {
  if (!entries.length) {
    return {
      requestClasses: 0,
      totalRequests: 0,
      totalRetries: 0,
      avgHealthScore: 100,
      avgLatencyMs: 0,
    };
  }

  const totalRequests = entries.reduce((sum, entry) => sum + entry.totalRequests, 0);
  const totalRetries = entries.reduce((sum, entry) => sum + entry.totalRetries, 0);
  const avgHealthScore = Math.round(
    entries.reduce((sum, entry) => sum + entry.healthScore, 0) / entries.length,
  );
  const avgLatencyMs = Math.round(
    entries.reduce((sum, entry) => sum + entry.avgLatencyMs, 0) / entries.length,
  );
  return {
    requestClasses: entries.length,
    totalRequests,
    totalRetries,
    avgHealthScore,
    avgLatencyMs,
  };
}

function calculateRetryPressure(entries: RuntimeRequestMetrics[]): number {
  const totalRequests = entries.reduce((sum, entry) => sum + entry.totalRequests, 0);
  const totalRetries = entries.reduce((sum, entry) => sum + entry.totalRetries, 0);
  return Number((totalRetries / Math.max(1, totalRequests)).toFixed(3));
}

function summarizeCircuitLayer(
  entries: Array<Pick<RuntimeCircuitSnapshot, "state">>,
): CircuitLayerSummary {
  return {
    total: entries.length,
    open: entries.filter((entry) => entry.state === "open").length,
    halfOpen: entries.filter((entry) => entry.state === "half_open").length,
    closed: entries.filter((entry) => entry.state === "closed").length,
  };
}

function sortCircuits(circuits: Record<string, LayerCircuitEntry>): LayerCircuitEntry[] {
  return Object.values(circuits).sort((left, right) => `${left.key}`.localeCompare(`${right.key}`));
}

function getLayerCircuitState(
  circuits: Record<string, LayerCircuitEntry>,
  key: string,
): RuntimeCircuitState {
  return circuits[key]?.state ?? "closed";
}

function estimatePercentile(buckets: Record<string, number>, percentile: number): number {
  const entries = Object.entries(buckets);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) {
    return 0;
  }
  const threshold = Math.ceil(total * percentile);
  let seen = 0;
  for (const [bucket, count] of entries) {
    seen += count;
    if (seen >= threshold) {
      if (bucket.startsWith("<=")) {
        return Number(bucket.slice(2));
      }
      return 12000;
    }
  }
  return 12000;
}

function average(total: number, count: number): number {
  return Math.round(total / Math.max(1, count));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildScopedDegradedFlags(
  degradedFlags: string[],
  providerCircuits: CircuitLayerSummary,
  retryPressure: number,
): string[] {
  const next = degradedFlags.filter((flag) => !isProviderScopedDegradedFlag(flag));
  if (providerCircuits.open > 0) {
    next.push("provider_circuit_open");
  }
  if (providerCircuits.halfOpen > 0) {
    next.push("provider_half_open");
  }
  if (retryPressure >= 0.35) {
    next.push("high_retry_pressure");
  }
  return [...new Set(next)];
}

function isProviderScopedDegradedFlag(flag: string): boolean {
  return flag === "provider_circuit_open" || flag === "provider_half_open" || flag === "high_retry_pressure";
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeScalar(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  return null;
}

function normalizeCircuitState(value: unknown): RuntimeCircuitState {
  return value === "open" || value === "half_open" ? value : "closed";
}
