import path from "node:path";
import { CapabilityRegistry } from "./capability-registry.mjs";
import { AgentPolicy } from "./agent-policy.mjs";
import { ContextManager } from "./context-manager.mjs";
import { TypeScriptDiagnosticProvider } from "./diagnostic-provider-typescript.mjs";
import { ExtensionStateStore } from "./extension-state-store.mjs";
import { ExecutionBoundary } from "./execution-boundary.mjs";
import { ExecutionJournal } from "./execution-journal.mjs";
import { EvalRunner } from "./eval-runner.mjs";
import { HookRunner } from "./hook-runner.mjs";
import { JobStore } from "./job-store.mjs";
import {
  McpRegistry,
  type McpRegistryConfig,
  type McpRegistryOptions,
} from "./mcp-registry.mjs";
import { MemoryStore } from "./memory-store.mjs";
import { ModelRouter } from "./model-router.mjs";
import { Planner } from "./planner.mjs";
import { RollbackStore } from "./rollback-store.mjs";
import { RuntimeHealth } from "./runtime-health.mjs";
import { SandboxRuntime } from "./sandbox-runtime.mjs";
import {
  ShellRuntime,
  type ShellRuntimeOptions,
} from "./shell-runtime.mjs";
import type {
  JobStoreLike,
  ShellRuntimeConfig,
} from "./shell-runtime-support.mjs";
import { PluginLoader } from "./plugin-loader.mjs";
import { PolicyStack } from "./policy-stack.mjs";
import { SkillLoader } from "./skill-loader.mjs";
import { SourceRegistry } from "./source-registry.mjs";
import { SessionStore } from "./session-store.mjs";
import { CapabilityRouter } from "./capability-router.mjs";
import { TaskClassifier } from "./task-classifier.mjs";
import {
  createSearchProvider,
} from "./web-search-providers.mjs";
import {
  WebRuntime,
  type WebRuntimeConfig,
  type WebRuntimeOptions,
} from "./web-runtime.mjs";
import { createToolRegistry } from "../tools/index.mjs";

import type { LoadedConfig } from "../config.mjs";
import type {
  DiagnosticProvider,
  ToolRegistrySurface,
  WebSearchProvider,
} from "../types/contracts.js";

interface ProviderLike {
  capabilities?: {
    nativeToolCalling?: boolean;
  };
}

interface AgentComponentCallbacks {
  onMcpEvent: (event: Record<string, unknown>) => Promise<void>;
  onShellEvent: (event: Record<string, unknown>) => Promise<void>;
  onHookEvent: (event: Record<string, unknown>) => Promise<void>;
}

export interface AgentComponentBundle {
  nativeToolCalling: boolean;
  memoryStore: MemoryStore;
  contextManager: ContextManager;
  rollbackStore: RollbackStore;
  executionJournal: ExecutionJournal;
  executionBoundary: ExecutionBoundary;
  jobStore: JobStore;
  runtimeHealth: RuntimeHealth;
  sourceRegistry: SourceRegistry;
  capabilityRegistry: CapabilityRegistry;
  taskClassifier: TaskClassifier;
  capabilityRouter: CapabilityRouter;
  modelRouter: ModelRouter;
  planner: Planner;
  diagnosticProvider: DiagnosticProvider;
  extensionStateStore: ExtensionStateStore;
  skillLoader: SkillLoader;
  pluginLoader: PluginLoader;
  policyStack: PolicyStack;
  webRuntime: WebRuntime;
  searchProvider: WebSearchProvider;
  mcpRegistry: McpRegistry;
  shellRuntime: ShellRuntime;
  sandboxRuntime: SandboxRuntime;
  hookRunner: HookRunner;
  toolRegistry: ToolRegistrySurface;
  evalRunner: EvalRunner;
  agentPolicy: AgentPolicy;
  sessionStore: SessionStore;
}

type AgentComponentConfig = LoadedConfig;

export interface AgentStatsBundle {
  usageTotals: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  approvalStats: {
    asked: number;
    approved: number;
    denied: number;
  };
  providerRuntimeStats: {
    attempts: number;
    retries: number;
    fallbacks: number;
    modelFallbacks: number;
    lastEvent: unknown;
  };
  shellRuntimeStats: {
    jobsStarted: number;
    jobsCompleted: number;
    jobsCancelled: number;
    jobsTimedOut: number;
    lastEvent: unknown;
  };
  webRuntimeStats: {
    requests: number;
    retries: number;
    cacheHits: number;
    lastEvent: unknown;
  };
  mcpRuntimeStats: {
    servers: number;
    tools: number;
    calls: number;
    failures: number;
    retries: number;
    lastEvent: unknown;
  };
}

export function createAgentComponents(
  config: AgentComponentConfig,
  provider: ProviderLike,
  runtimeHealth: RuntimeHealth | null,
  callbacks: AgentComponentCallbacks,
): AgentComponentBundle {
  const resolvedRuntimeHealth = runtimeHealth ?? new RuntimeHealth(config);
  const memoryStore = new MemoryStore(config);
  const contextManager = new ContextManager(config);
  const rollbackStore = new RollbackStore(config.projectStateDir);
  const executionJournal = new ExecutionJournal(config.projectStateDir);
  const executionBoundary = new ExecutionBoundary({
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    approvalPolicy: config.approvalPolicy,
    networkMode: config.networkMode,
    webProvider: config.webProvider,
    webAllowDomains: Array.isArray(config.webAllowDomains) ? config.webAllowDomains : [],
    webDenyDomains: Array.isArray(config.webDenyDomains) ? config.webDenyDomains : [],
    shellTimeoutMs: config.shellTimeoutMs,
    hookTimeoutMs: typeof config.hookTimeoutMs === "number" ? config.hookTimeoutMs : 5_000,
    executionBoundaryMode:
      typeof config.executionBoundaryMode === "string"
        ? config.executionBoundaryMode
        : null,
    executionEnvAllowlist:
      Array.isArray(config.executionEnvAllowlist) || typeof config.executionEnvAllowlist === "string"
        ? config.executionEnvAllowlist
        : null,
  });
  const jobStore = new JobStore(config.projectStateDir);
  const sourceRegistry = new SourceRegistry(config.projectStateDir);
  const capabilityRegistry = new CapabilityRegistry();
  const taskClassifier = new TaskClassifier(config);
  const capabilityRouter = new CapabilityRouter(config);
  const modelRouter = new ModelRouter(config);
  const planner = new Planner();
  const diagnosticProvider = new TypeScriptDiagnosticProvider({
    cwd: config.cwd,
  });
  const extensionStateStore = new ExtensionStateStore(config.projectStateDir);
  const skillLoader = new SkillLoader(config, {
    stateStore: extensionStateStore,
  });
  const pluginLoader = new PluginLoader(config, {
    stateStore: extensionStateStore,
  });
  const policyStack = new PolicyStack();
  const webRuntimeConfig: WebRuntimeConfig = config;
  const webRuntimeOptions: WebRuntimeOptions = {
    runtimeHealth: {
      beforeWebRequest: async (input) => {
        const outcome = await resolvedRuntimeHealth.beforeWebRequest(input);
        return {
          allowed: outcome.allowed,
          circuit: outcome.circuit,
          events: outcome.events.map((event) => ({ ...event })),
        };
      },
      noteWebOutcome: async (input) => {
        const outcome = await resolvedRuntimeHealth.noteWebOutcome(input);
        return {
          circuit: outcome.circuit,
          events: outcome.events.map((event) => ({ ...event })),
        };
      },
    },
  };
  const webRuntime = new WebRuntime(webRuntimeConfig, webRuntimeOptions);
  const searchProvider = createSearchProvider(config, webRuntime);
  const mcpRegistryConfig: McpRegistryConfig = {
    ...config,
    mcpConfigPaths: normalizeMcpConfigPaths(config.mcpConfigPaths),
  };
  const mcpRegistryOptions: McpRegistryOptions = {
    onEvent: callbacks.onMcpEvent,
    runtimeHealth: {
      beforeMcpRequest: async (input) =>
        resolvedRuntimeHealth.beforeMcpRequest(normalizeMcpRequestHealthInput(input)),
      noteMcpOutcome: async (input) =>
        resolvedRuntimeHealth.noteMcpOutcome(normalizeMcpOutcomeHealthInput(input)),
    },
  };
  const mcpRegistry = new McpRegistry(mcpRegistryConfig, mcpRegistryOptions);
  const shellRuntimeConfig: ShellRuntimeConfig = config;
  const shellRuntimeOptions: ShellRuntimeOptions = {
    onEvent: callbacks.onShellEvent,
  };
  const shellRuntime = new ShellRuntime(
    shellRuntimeConfig,
    createShellRuntimeJobStore(jobStore),
    shellRuntimeOptions,
  );
  const sandboxRuntime = new SandboxRuntime({
    cwd: config.cwd,
    projectStateDir: config.projectStateDir,
    sandboxDir: path.join(config.projectStateDir, "sandbox"),
    isolationLevel: typeof config.sandboxIsolationLevel === "string"
      ? config.sandboxIsolationLevel
      : "os",
    allowNetwork: false,
    allowedWritePaths: [config.cwd],
    allowedReadPaths: [config.cwd],
    envAllowlist: Array.isArray(config.executionEnvAllowlist)
      ? config.executionEnvAllowlist
      : undefined,
    shellTimeoutMs: config.shellTimeoutMs,
    maxOutputChars: config.maxOutputChars,
  });
  const hookRunner = new HookRunner({
    cwd: config.cwd,
    projectStateDir: config.projectStateDir,
    hooks: Array.isArray(config.hooks) ? config.hooks : [],
    hookTimeoutMs: typeof config.hookTimeoutMs === "number" ? config.hookTimeoutMs : 5_000,
  }, {
    executionBoundary,
    shellRuntime,
    onEvent: callbacks.onHookEvent,
  });
  const toolRegistry = createToolRegistry({
    ...config,
    memoryStore,
    shellRuntime,
    sandboxRuntime,
    sourceRegistry,
    webRuntime,
    searchProvider,
    mcpRegistry,
    pluginLoader,
    capabilityRegistry,
  });
  const evalRunner = new EvalRunner(
    config,
    {
      taskClassifier,
      capabilityRouter,
      modelRouter,
      planner,
    },
  );
  const agentPolicy = new AgentPolicy({
    config,
    runtimeHealth: resolvedRuntimeHealth,
    capabilityRegistry,
    taskClassifier,
    capabilityRouter,
    modelRouter,
    planner,
    evalRunner,
    skillLoader,
    policyStack,
    sourceRegistry,
    mcpRegistry,
  });
  const sessionStore = new SessionStore(config.sessionDir);

  return {
    nativeToolCalling: Boolean(provider.capabilities?.nativeToolCalling),
    memoryStore,
    contextManager,
    rollbackStore,
    executionJournal,
    executionBoundary,
    jobStore,
    runtimeHealth: resolvedRuntimeHealth,
    sourceRegistry,
    capabilityRegistry,
    taskClassifier,
    capabilityRouter,
    modelRouter,
    planner,
    diagnosticProvider,
    extensionStateStore,
    skillLoader,
    pluginLoader,
    policyStack,
    webRuntime,
    searchProvider,
    mcpRegistry,
    shellRuntime,
    sandboxRuntime,
    hookRunner,
    toolRegistry,
    evalRunner,
    agentPolicy,
    sessionStore,
  };
}

function normalizeMcpConfigPaths(
  entries: LoadedConfig["mcpConfigPaths"],
): McpRegistryConfig["mcpConfigPaths"] {
  if (!Array.isArray(entries)) {
    return undefined;
  }

  return entries.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{
        scope: "config",
        path: entry,
      }];
    }

    if (entry && typeof entry.path === "string" && entry.path) {
      return [{
        scope: "config",
        path: entry.path,
      }];
    }

    return [];
  });
}

function normalizeMcpRequestHealthInput(input: Record<string, unknown>) {
  return {
    serverId: typeof input.serverId === "string" ? input.serverId : "unknown",
    serverName: typeof input.serverName === "string" ? input.serverName : null,
    requestClass: typeof input.requestClass === "string" ? input.requestClass : "tool_call",
    endpoint: typeof input.endpoint === "string" ? input.endpoint : null,
    traceId: typeof input.traceId === "string" ? input.traceId : null,
  };
}

function normalizeMcpOutcomeHealthInput(input: Record<string, unknown>) {
  return {
    ...normalizeMcpRequestHealthInput(input),
    success: input.success !== false,
    totalDurationMs: Number.isFinite(Number(input.totalDurationMs))
      ? Number(input.totalDurationMs)
      : 0,
    error: input.error,
  };
}

function createShellRuntimeJobStore(jobStore: JobStore): JobStoreLike {
  return {
    initialize: () => jobStore.initialize(),
    createJob: (job: Parameters<JobStore["createJob"]>[0]) => jobStore.createJob(job),
    writeJob: (job: Parameters<JobStore["writeJob"]>[0]) => jobStore.writeJob(job),
    getJob: (jobId: string) => jobStore.getJob(jobId),
    listJobs: (options?: Parameters<JobStore["listJobs"]>[0]) => jobStore.listJobs(options),
    appendEvent: (jobId: string, event: Record<string, unknown>) => jobStore.appendEvent(jobId, event),
    tailJobSince: (
      jobId: string,
      cursor?: {
        stdout?: number;
        stderr?: number;
      } | null,
      maxChars?: number,
    ) =>
      jobStore.tailJobSince(
        jobId,
        cursor
          ? {
              stdout: Number.isFinite(Number(cursor.stdout)) ? Number(cursor.stdout) : 0,
              stderr: Number.isFinite(Number(cursor.stderr)) ? Number(cursor.stderr) : 0,
            }
          : undefined,
        maxChars,
      ),
    prepareOutputFiles: (jobId: string) => jobStore.prepareOutputFiles(jobId),
    readJobOutput: (
      job: Parameters<JobStore["readJobOutput"]>[0] | null | undefined,
      options?: {
        maxChars?: number;
        cursor?: {
          stdout?: number;
          stderr?: number;
        } | null;
      },
    ) =>
      jobStore.readJobOutput(job ?? undefined, {
        maxChars: options?.maxChars,
        cursor: options?.cursor ?? undefined,
      }),
  };
}

export function createInitialAgentStats(): AgentStatsBundle {
  return {
    usageTotals: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    approvalStats: {
      asked: 0,
      approved: 0,
      denied: 0,
    },
    providerRuntimeStats: {
      attempts: 0,
      retries: 0,
      fallbacks: 0,
      modelFallbacks: 0,
      lastEvent: null,
    },
    shellRuntimeStats: {
      jobsStarted: 0,
      jobsCompleted: 0,
      jobsCancelled: 0,
      jobsTimedOut: 0,
      lastEvent: null,
    },
    webRuntimeStats: {
      requests: 0,
      retries: 0,
      cacheHits: 0,
      lastEvent: null,
    },
    mcpRuntimeStats: {
      servers: 0,
      tools: 0,
      calls: 0,
      failures: 0,
      retries: 0,
      lastEvent: null,
    },
  };
}
