import {
  buildAgentPolicyContributions,
  refreshAgentInstructionPrompt,
  registerPolicyCapabilities,
} from "./agent-instruction-assembly.mjs";
import type { CapabilityRegistryLike } from "./capability-registry.mjs";
import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";
import { persistPreparedIntelligence } from "./agent-events.mjs";
import { summarizeChangeSet } from "./change-set.mjs";

import type { LoadedConfig } from "../config.mjs";
import type {
  AgentIntelligence,
  EvalRunRequest,
  EvalSuiteResult,
  AgentPolicyState,
  ChangeSetRecord,
  EffectivePolicy,
  ExecutionPlan,
  InstructionPack,
  ModelDecision,
  PolicyContribution,
  RouteDecision,
  TaskClassification,
  TraceSummary,
} from "../types/contracts.js";
import type { ToolRegistrySurface } from "../types/contracts.js";

type ExplainScope = "overview" | "route" | "model" | "tool" | "plan";
type RouteSelection = "last" | "all";

interface SkillLoaderLike {
  getPolicyContributions(): PolicyContribution[];
  registerCapabilities(capabilityRegistry: CapabilityRegistryLike): void;
}

interface PolicyStackLike {
  setContributions(contributions?: PolicyContribution[]): EffectivePolicy;
  getEffectivePolicy(): EffectivePolicy;
}

interface SessionStoreLike {
  append(eventType: string, payload: unknown): Promise<unknown>;
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "append" | "recordPhase">;

interface AgentPolicyLike {
  previewRoute(
    prompt: string,
    state?: AgentPolicyState,
    refresh?: (() => void) | null,
  ): AgentIntelligence | {
    taskClassification: TaskClassification | null;
    routeDecision: RouteDecision | null;
    modelDecision: ModelDecision | null;
    executionPlan: ExecutionPlan | null;
  };
  getRoute(which?: RouteSelection, state?: AgentPolicyState): RouteDecision | {
    taskClassification: TaskClassification | null;
    routeDecision: RouteDecision | null;
    modelDecision: ModelDecision | null;
    executionPlan: ExecutionPlan | null;
  } | null;
  getExecutionPlan(which?: RouteSelection, state?: AgentPolicyState): ExecutionPlan | {
    taskClassification: TaskClassification | null;
    routeDecision: RouteDecision | null;
    modelDecision: ModelDecision | null;
    executionPlan: ExecutionPlan | null;
  } | null;
  getModelDecision(state?: AgentPolicyState): ModelDecision;
  getProviderDecision(state?: AgentPolicyState): unknown;
  explainWhy(scope?: ExplainScope, state?: AgentPolicyState): unknown;
  runEval(input?: string | EvalRunRequest): EvalSuiteResult;
  computeIntelligence(prompt: string, state?: AgentPolicyState): AgentIntelligence;
}

export interface AgentIntelligenceTarget {
  config: LoadedConfig;
  nativeToolCalling: boolean;
  projectInstructions: InstructionPack;
  baseSystemPrompt: string;
  toolRegistry: ToolRegistrySurface;
  capabilityRegistry: CapabilityRegistryLike;
  skillLoader: SkillLoaderLike;
  policyStack: PolicyStackLike;
  agentPolicy: AgentPolicyLike;
  messages: unknown[];
  lastTrace: TraceSummary | null;
  lastChangeSet: ChangeSetRecord | null;
  lastTaskClassification: TaskClassification | null;
  lastRouteDecision: RouteDecision | null;
  lastModelDecision: ModelDecision | null;
  lastExecutionPlan: ExecutionPlan | null;
  sessionFilePath: string | null;
  sessionId: string | null;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  refreshSystemPrompt?(): void;
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string;
    outputSummary: string;
  }): Promise<unknown>;
}

const MEMORY_CAPABILITIES = [
  {
    id: "memory:store",
    name: "memory_store",
    displayName: "Memory Store",
    type: "memory",
    source: "builtin",
    enabled: true,
    active: true,
    riskCategory: "state",
    description: "Session, project, user, and failure memory system.",
    tags: ["memory", "state"],
    scope: "runtime" as const,
    sourceQualifiedName: "builtin:memory_store",
  },
];

export function refreshAgentSystemPrompt(target: AgentIntelligenceTarget): EffectivePolicy {
  return refreshAgentInstructionPrompt(target);
}

export function rebuildAgentCapabilitySurface(target: AgentIntelligenceTarget): void {
  target.toolRegistry.getToolSpecs();
  target.skillLoader.registerCapabilities(target.capabilityRegistry);
  target.capabilityRegistry.replaceGroup("memory-capabilities", MEMORY_CAPABILITIES);
}

export function buildAgentPolicyContributionsFromTarget(
  target: AgentIntelligenceTarget,
): PolicyContribution[] {
  return buildAgentPolicyContributions({
    nativeToolCalling: target.nativeToolCalling,
    projectInstructions: target.projectInstructions,
    skillContributions: target.skillLoader.getPolicyContributions(),
    userPolicy: target.config.userPolicy,
    config: target.config,
  });
}

export function registerAgentPolicyCapabilities(
  target: AgentIntelligenceTarget,
  effectivePolicy: EffectivePolicy,
): void {
  registerPolicyCapabilities(target.capabilityRegistry, effectivePolicy);
}

export function buildAgentPolicyState(target: AgentIntelligenceTarget): AgentPolicyState {
  return {
    messages: target.messages,
    lastTrace: target.lastTrace,
    lastTaskClassification: target.lastTaskClassification,
    lastRouteDecision: target.lastRouteDecision,
    lastModelDecision: target.lastModelDecision,
    lastExecutionPlan: target.lastExecutionPlan,
  };
}

export function previewAgentRoute(
  target: AgentIntelligenceTarget,
  prompt: string,
): ReturnType<AgentPolicyLike["previewRoute"]> {
  return target.agentPolicy.previewRoute(prompt, buildAgentPolicyState(target), () => {
    rebuildAgentCapabilitySurface(target);
    refreshAgentPromptSurface(target);
  });
}

export function getAgentRoute(
  target: AgentIntelligenceTarget,
  which: RouteSelection = "last",
): ReturnType<AgentPolicyLike["getRoute"]> {
  return target.agentPolicy.getRoute(which, buildAgentPolicyState(target));
}

export function getAgentExecutionPlan(
  target: AgentIntelligenceTarget,
  which: RouteSelection = "last",
): ReturnType<AgentPolicyLike["getExecutionPlan"]> {
  return target.agentPolicy.getExecutionPlan(which, buildAgentPolicyState(target));
}

export function getAgentModelDecision(target: AgentIntelligenceTarget): ModelDecision {
  return target.agentPolicy.getModelDecision(buildAgentPolicyState(target));
}

export function getAgentProviderDecision(target: AgentIntelligenceTarget): unknown {
  return target.agentPolicy.getProviderDecision(buildAgentPolicyState(target));
}

export function explainAgentIntelligence(
  target: AgentIntelligenceTarget,
  scope: ExplainScope = "overview",
): unknown {
  return target.agentPolicy.explainWhy(scope, {
    ...buildAgentPolicyState(target),
    lastChangeSet: target.lastChangeSet ? summarizeChangeSet(target.lastChangeSet) : null,
  });
}

export function runAgentEval(
  target: AgentIntelligenceTarget,
  input: string | EvalRunRequest = "all",
): EvalSuiteResult {
  rebuildAgentCapabilitySurface(target);
  return target.agentPolicy.runEval(input);
}

export function computeAgentIntelligence(
  target: AgentIntelligenceTarget,
  prompt: string,
): AgentIntelligence {
  rebuildAgentCapabilitySurface(target);
  refreshAgentPromptSurface(target);
  return target.agentPolicy.computeIntelligence(prompt, buildAgentPolicyState(target));
}

export async function prepareAgentIntelligence(
  target: AgentIntelligenceTarget,
  prompt: string,
  traceId: string | null = null,
): Promise<AgentIntelligence> {
  const intelligence = computeAgentIntelligence(target, prompt);
  target.lastTaskClassification = intelligence.taskClassification;
  target.lastRouteDecision = intelligence.routeDecision;
  target.lastModelDecision = intelligence.modelDecision;
  target.lastExecutionPlan = intelligence.executionPlan;

  await persistPreparedIntelligence(
    {
      sessionFilePath: target.sessionFilePath,
      sessionId: target.sessionId,
      sessionStore: target.sessionStore,
      executionJournal: target.executionJournal,
      captureStateSnapshot: async (input) => target.captureStateSnapshot(input),
    },
    {
      prompt,
      traceId,
      intelligence,
    },
  );

  return intelligence;
}

function refreshAgentPromptSurface(target: AgentIntelligenceTarget): void {
  if (typeof target.refreshSystemPrompt === "function") {
    target.refreshSystemPrompt();
    return;
  }
  refreshAgentSystemPrompt(target);
}
