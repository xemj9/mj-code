import { MJCodeAgentCore as LegacyAgentLoopBase } from "./agent-loop-legacy.mjs";
import {
  buildAgentPolicyContributionsFromTarget,
  buildAgentPolicyState,
  computeAgentIntelligence,
  explainAgentIntelligence,
  getAgentExecutionPlan,
  getAgentModelDecision,
  getAgentProviderDecision,
  getAgentRoute,
  prepareAgentIntelligence,
  previewAgentRoute,
  rebuildAgentCapabilitySurface,
  refreshAgentSystemPrompt,
  registerAgentPolicyCapabilities,
  runAgentEval,
  type AgentIntelligenceTarget,
} from "./agent-intelligence-orchestration.mjs";

export class MJCodeAgentIntelligenceSurface extends LegacyAgentLoopBase {
  refreshSystemPrompt(): ReturnType<typeof refreshAgentSystemPrompt> {
    return refreshAgentSystemPrompt(asIntelligenceTarget(this));
  }

  rebuildCapabilitySurface(): void {
    rebuildAgentCapabilitySurface(asIntelligenceTarget(this));
  }

  buildPolicyContributions(): ReturnType<typeof buildAgentPolicyContributionsFromTarget> {
    return buildAgentPolicyContributionsFromTarget(asIntelligenceTarget(this));
  }

  registerPolicyCapabilities(
    effectivePolicy: Parameters<typeof registerAgentPolicyCapabilities>[1],
  ): void {
    registerAgentPolicyCapabilities(asIntelligenceTarget(this), effectivePolicy);
  }

  buildPolicyState(): ReturnType<typeof buildAgentPolicyState> {
    return buildAgentPolicyState(asIntelligenceTarget(this));
  }

  previewRoute(prompt: string): ReturnType<typeof previewAgentRoute> {
    return previewAgentRoute(asIntelligenceTarget(this), prompt);
  }

  getRoute(which: string = "last"): ReturnType<typeof getAgentRoute> {
    return getAgentRoute(asIntelligenceTarget(this), which === "last" ? "last" : "all");
  }

  getExecutionPlan(
    which: string = "last",
  ): ReturnType<typeof getAgentExecutionPlan> {
    return getAgentExecutionPlan(
      asIntelligenceTarget(this),
      which === "last" ? "last" : "all",
    );
  }

  getModelDecision(): ReturnType<typeof getAgentModelDecision> {
    return getAgentModelDecision(asIntelligenceTarget(this));
  }

  getProviderDecision(): ReturnType<typeof getAgentProviderDecision> {
    return getAgentProviderDecision(asIntelligenceTarget(this));
  }

  explainWhy(scope: string = "overview"): ReturnType<typeof explainAgentIntelligence> {
    return explainAgentIntelligence(
      asIntelligenceTarget(this),
      normalizeExplainScope(scope),
    );
  }

  runEval(
    input: Parameters<typeof runAgentEval>[1] = "all",
  ): ReturnType<typeof runAgentEval> {
    return runAgentEval(asIntelligenceTarget(this), input);
  }

  prepareIntelligence(
    prompt: string,
    traceId: string | null = null,
  ): ReturnType<typeof prepareAgentIntelligence> {
    return prepareAgentIntelligence(asIntelligenceTarget(this), prompt, traceId);
  }

  computeIntelligence(prompt: string): ReturnType<typeof computeAgentIntelligence> {
    return computeAgentIntelligence(asIntelligenceTarget(this), prompt);
  }
}

function normalizeExplainScope(
  scope: string,
): Parameters<typeof explainAgentIntelligence>[1] {
  return scope === "route" || scope === "model" || scope === "tool" || scope === "plan"
    ? scope
    : "overview";
}

function asIntelligenceTarget(value: unknown): AgentIntelligenceTarget {
  return value as AgentIntelligenceTarget;
}
