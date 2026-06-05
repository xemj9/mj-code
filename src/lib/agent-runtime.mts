import crypto from "node:crypto";

import { loadConfig } from "../config.mjs";
import { serializeProviderError } from "./provider-errors.mjs";
import {
  loadProjectInstructions,
  summarizeInstructionPack,
} from "./project-instructions.mjs";
import { RuntimeHealth } from "./runtime-health.mjs";
import { createProvider } from "../providers/index.mjs";
import type { ProviderAdapter } from "../providers/index.mjs";
import type { LoadedConfig } from "../config.mjs";

import type {
  ExecutionPlan,
  InstructionPack,
  JobRecord,
  ModelDecision,
  RouteDecision,
  RuntimeHealthOverview,
  SkillInfluenceEntry,
  TaskClassification,
} from "../types/contracts.js";

interface BootstrapRuntimeResult {
  config: LoadedConfig;
  provider: ProviderAdapter;
  projectInstructions: InstructionPack;
  runtimeHealth: RuntimeHealth;
}

interface RuntimeContinuityDependencies {
  sessionId: string | null;
  parentSessionId: string | null;
  projectInstructions: InstructionPack;
  runtimeHealth: {
    getOverview(): RuntimeHealthOverview;
    listCircuits(layer?: "all"): unknown[];
  };
  jobStore: {
    listJobs(options?: { limit?: number }): Promise<JobRecord[]>;
  };
  sourceRegistry: {
    getLastPack(): unknown;
  };
  capabilityRegistry: {
    getSurfaceMap(): unknown;
  };
  skillLoader: {
    getInfluenceSummary(): SkillInfluenceEntry[];
  };
  policyStack: {
    getEffectivePolicy(): { sources: unknown[] };
  };
  mcpRegistry: {
    listServers(): Array<{
      id: string;
      status: string;
      healthScore: number;
      latencyMs: number | null;
    }>;
  };
  lastTaskClassification: TaskClassification | null;
  lastRouteDecision: RouteDecision | null;
  lastModelDecision: ModelDecision | null;
  lastExecutionPlan: ExecutionPlan | null;
}

export async function bootstrapRuntime(
  options: Record<string, unknown>,
): Promise<BootstrapRuntimeResult> {
  const config = await loadConfig(options) as LoadedConfig;
  const runtimeHealth = new RuntimeHealth(config);
  await runtimeHealth.initialize();
  const provider = createProvider(config, { runtimeHealth });
  config.availableModels = [];
  config.modelDiscoveryError = null;
  if (!config.model && typeof provider.listModels === "function") {
    try {
      const availableModels = await provider.listModels({
        traceId: crypto.randomUUID().slice(0, 12),
      });
      config.model = pickPreferredModel(config.provider, availableModels);
      config.availableModels = availableModels;
    } catch (error) {
      config.modelDiscoveryError = serializeProviderError(error);
    }
  }

  const projectInstructions = await loadProjectInstructions({
    cwd: config.cwd,
    userStateDir: config.userStateDir,
  });
  return {
    config,
    provider,
    projectInstructions,
    runtimeHealth,
  };
}

export async function buildRuntimeContinuitySnapshot(
  dependencies: RuntimeContinuityDependencies,
): Promise<Record<string, unknown>> {
  const jobs = await dependencies.jobStore.listJobs({ limit: 12 });
  return {
    sessionId: dependencies.sessionId,
    parentSessionId: dependencies.parentSessionId,
    runtimeHealth: dependencies.runtimeHealth.getOverview(),
    circuits: dependencies.runtimeHealth.listCircuits("all"),
    shellJobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      continuityState: job.continuityState,
      live: job.live,
      reattached: job.reattached,
      canCancel: job.canCancel,
      canReattach: job.canReattach,
      createdBySessionId: job.createdBySessionId,
      resumedIntoSessionId: job.resumedIntoSessionId ?? null,
    })),
    lastSourcePack: dependencies.sourceRegistry.getLastPack(),
    instructions: summarizeInstructionPack(dependencies.projectInstructions, {
      includeContent: false,
    }),
    capabilitySurface: dependencies.capabilityRegistry.getSurfaceMap(),
    activeSkills: dependencies.skillLoader.getInfluenceSummary(),
    intelligence: {
      taskClassification: dependencies.lastTaskClassification,
      routeDecision: dependencies.lastRouteDecision,
      modelDecision: dependencies.lastModelDecision,
      executionPlan: dependencies.lastExecutionPlan,
    },
    policySources: dependencies.policyStack.getEffectivePolicy().sources,
    mcpServers: dependencies.mcpRegistry.listServers().map((server) => ({
      id: server.id,
      status: server.status,
      healthScore: server.healthScore,
      latencyMs: server.latencyMs,
    })),
  };
}

function pickPreferredModel(provider: string | null | undefined, models: string[]): string | null {
  if (!Array.isArray(models) || models.length === 0) {
    return null;
  }

  const preferences =
    provider === "anthropic-compatible"
      ? ["claude-sonnet", "claude-opus", "claude-haiku", "claude"]
      : ["gpt-5", "gpt-4.1", "gpt-4o", "gpt"];

  for (const pattern of preferences) {
    const match = models.find((model) =>
      model === pattern || model.startsWith(`${pattern}-`) || model.includes(pattern)
    );
    if (match) {
      return match;
    }
  }

  return models[0];
}
