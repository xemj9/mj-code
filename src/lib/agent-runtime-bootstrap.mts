import type { ExtensionStateStoreLike } from "./extension-state-store.mjs";

interface RollbackStoreLike {
  initialize(): Promise<void>;
}

interface ShellRuntimeLike {
  initialize(): Promise<void>;
  bindSession(input: {
    sessionId: string | null;
    parentSessionId: string | null;
    rootSessionId: string | null;
    resumedFromSessionId?: string | null;
  }): Promise<void>;
}

interface WebRuntimeLike {
  initialize(): Promise<void>;
}

interface RuntimeHealthLike {
  initialize(): Promise<void>;
  bindSession(input: {
    sessionId: string | null;
    parentSessionId: string | null;
    rootSessionId: string | null;
    resumedFromSessionId?: string | null;
  }): Promise<void>;
  noteShellSnapshot(
    jobs: unknown[],
    metadata: {
      sessionId: string | null;
      parentSessionId: string | null;
    },
  ): Promise<unknown>;
  setMcpServers(servers: unknown[]): Promise<unknown>;
}

interface HookRunnerLike {
  initialize(): Promise<void>;
}

interface SkillLoaderLike {
  initialize(): Promise<void>;
}

interface PluginLoaderLike {
  initialize(): Promise<void>;
}

interface McpRegistryLike {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listServers(): unknown[];
  listTools(): unknown[];
}

interface DiagnosticProviderLike {
  close?(): Promise<void>;
}

interface JobStoreLike {
  listJobs(options?: { limit?: number }): Promise<unknown[]>;
}

export interface AgentRuntimeBootstrapTarget {
  config: {
    mcpEnabled?: boolean;
  };
  extensionStateStore: ExtensionStateStoreLike;
  rollbackStore: RollbackStoreLike;
  shellRuntime: ShellRuntimeLike;
  webRuntime: WebRuntimeLike;
  runtimeHealth: RuntimeHealthLike;
  hookRunner: HookRunnerLike;
  skillLoader: SkillLoaderLike;
  pluginLoader: PluginLoaderLike;
  mcpRegistry: McpRegistryLike;
  diagnosticProvider: DiagnosticProviderLike;
  jobStore: JobStoreLike;
  mcpRuntimeStats: {
    servers: number;
    tools: number;
  };
  sessionId: string | null;
  parentSessionId: string | null;
  resumedFromSessionId: string | null;
  rebuildCapabilitySurface(): void;
  refreshSystemPrompt(): void;
}

export async function initializeAgentRuntimeStores(
  target: AgentRuntimeBootstrapTarget,
): Promise<void> {
  await Promise.all([
    target.extensionStateStore.initialize(),
    target.rollbackStore.initialize(),
    target.shellRuntime.initialize(),
    target.webRuntime.initialize(),
    target.runtimeHealth.initialize(),
    target.hookRunner.initialize(),
  ]);
  await Promise.all([
    target.skillLoader.initialize(),
    target.pluginLoader.initialize(),
  ]);
  if (target.config.mcpEnabled !== false) {
    await target.mcpRegistry.initialize();
    target.mcpRuntimeStats.servers = target.mcpRegistry.listServers().length;
    target.mcpRuntimeStats.tools = target.mcpRegistry.listTools().length;
    await target.runtimeHealth.setMcpServers(target.mcpRegistry.listServers());
  }
  target.rebuildCapabilitySurface();
  target.refreshSystemPrompt();
}

export async function closeAgentRuntime(
  target: Pick<AgentRuntimeBootstrapTarget, "mcpRegistry" | "diagnosticProvider">,
): Promise<void> {
  await Promise.all([
    target.mcpRegistry.close(),
    target.diagnosticProvider.close?.(),
  ]);
}

export async function bindAgentRuntimeSession(
  target: Pick<
    AgentRuntimeBootstrapTarget,
    | "runtimeHealth"
    | "shellRuntime"
    | "sessionId"
    | "parentSessionId"
    | "resumedFromSessionId"
  > & {
    syncRuntimeContinuity(): Promise<void>;
  },
): Promise<void> {
  const rootSessionId = target.parentSessionId ?? target.sessionId;
  await target.runtimeHealth.bindSession({
    sessionId: target.sessionId,
    parentSessionId: target.parentSessionId,
    rootSessionId,
    resumedFromSessionId: target.resumedFromSessionId,
  });
  await target.shellRuntime.bindSession({
    sessionId: target.sessionId,
    parentSessionId: target.parentSessionId,
    rootSessionId,
    resumedFromSessionId: target.resumedFromSessionId,
  });
  await target.syncRuntimeContinuity();
}

export async function syncAgentRuntimeContinuity(
  target: Pick<
    AgentRuntimeBootstrapTarget,
    | "jobStore"
    | "runtimeHealth"
    | "sessionId"
    | "parentSessionId"
    | "mcpRegistry"
  >,
): Promise<void> {
  const jobs = await target.jobStore.listJobs({ limit: 100 });
  await target.runtimeHealth.noteShellSnapshot(jobs, {
    sessionId: target.sessionId,
    parentSessionId: target.parentSessionId,
  });
  await target.runtimeHealth.setMcpServers(target.mcpRegistry.listServers());
}
