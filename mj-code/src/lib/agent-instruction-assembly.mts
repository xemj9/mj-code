import { buildSystemPrompt } from "./json-protocol.mjs";
import {
  createCoreSystemPolicy,
  createProjectInstructionPolicies,
  createRuntimePolicy,
  createUserPreferencePolicy,
} from "./policy-stack.mjs";
import { summarizeInstructionPack } from "./project-instructions.mjs";
import type { CapabilityRegistryLike } from "./capability-registry.mjs";

import type { LoadedConfig } from "../config.mjs";
import type {
  EffectivePolicy,
  InstructionPack,
  InstructionPackSummary,
  PolicyContribution,
  ToolRegistrySurface,
} from "../types/contracts.js";

interface PolicyStackLike {
  setContributions(contributions?: PolicyContribution[]): EffectivePolicy;
  renderPromptSections?(): string;
}

interface SkillLoaderLike {
  getPolicyContributions(): PolicyContribution[];
}

interface AgentInstructionAssemblyTarget {
  policyStack: PolicyStackLike;
  capabilityRegistry: CapabilityRegistryLike;
  skillLoader: SkillLoaderLike;
  toolRegistry: ToolRegistrySurface;
  config: LoadedConfig;
  nativeToolCalling: boolean;
  projectInstructions: InstructionPack;
  baseSystemPrompt: string;
}

export function refreshAgentInstructionPrompt(
  target: AgentInstructionAssemblyTarget,
): EffectivePolicy {
  const effectivePolicy = target.policyStack.setContributions(
    buildAgentPolicyContributions({
      nativeToolCalling: target.nativeToolCalling,
      projectInstructions: target.projectInstructions,
      skillContributions: target.skillLoader.getPolicyContributions(),
      userPolicy: target.config.userPolicy,
      config: target.config,
    }),
  );
  registerPolicyCapabilities(target.capabilityRegistry, effectivePolicy);
  target.baseSystemPrompt = buildSystemPrompt({
    tools: target.toolRegistry.getToolSpecs(),
    config: target.config,
    projectInstructions: target.projectInstructions.content,
    nativeToolCalling: target.nativeToolCalling,
    policyStack: target.policyStack,
  });
  return effectivePolicy;
}

export function buildAgentPolicyContributions(input: {
  nativeToolCalling: boolean;
  projectInstructions: InstructionPack;
  skillContributions: PolicyContribution[];
  userPolicy: string;
  config: LoadedConfig;
}): PolicyContribution[] {
  return [
    createCoreSystemPolicy({
      nativeToolCalling: input.nativeToolCalling,
    }),
    ...createProjectInstructionPolicies(input.projectInstructions),
    ...input.skillContributions,
    createUserPreferencePolicy(input.userPolicy),
    createRuntimePolicy(input.config),
  ].filter(Boolean) as PolicyContribution[];
}

export function registerPolicyCapabilities(
  capabilityRegistry: CapabilityRegistryLike,
  effectivePolicy: EffectivePolicy,
): void {
  capabilityRegistry.replaceGroup(
    "policy-capabilities",
    effectivePolicy.contributions.map((entry) => {
      const instructionLayer = typeof entry.metadata?.instructionLayer === "string"
        ? entry.metadata.instructionLayer
        : null;
      const instructionScope = typeof entry.metadata?.instructionScope === "string"
        ? entry.metadata.instructionScope
        : null;
      const importedFrom = typeof entry.metadata?.importedFrom === "string"
        ? entry.metadata.importedFrom
        : null;
      const instructionOrder = typeof entry.metadata?.instructionOrder === "number"
        ? entry.metadata.instructionOrder
        : null;
      const ruleCount = typeof entry.metadata?.ruleCount === "number"
        ? entry.metadata.ruleCount
        : 0;
      return {
        id: entry.id,
        name: entry.title ?? entry.id,
        displayName: entry.title ?? entry.id,
        type: "instruction/policy",
        source: entry.source,
        enabled: true,
        active: true,
        riskCategory: "policy",
        provenance: {
          layer: entry.layer,
          instructionLayer,
          importedFrom,
          order: instructionOrder,
        },
        description: entry.title ?? entry.id,
        tags: [entry.layer, ...(instructionLayer ? [instructionLayer] : [])],
        scope: instructionScope === "user"
          ? "user"
          : entry.source === "project" ? "project" : "runtime",
        originPath: entry.originPath ?? null,
        sourceQualifiedName:
          typeof entry.metadata?.sourceQualifiedName === "string"
            ? entry.metadata.sourceQualifiedName
            : `${entry.source}:${entry.id}`,
        projectAttached: instructionScope === "project" || entry.source === "project",
        metadata: {
          layer: entry.layer,
          summary: entry.content.slice(0, 160),
          instructionLayer,
          importedFrom,
          instructionOrder,
          ruleCount,
        },
      };
    }),
  );
}

export function summarizeAgentInstructions(pack: InstructionPack): InstructionPackSummary {
  return summarizeInstructionPack(pack, {
    includeContent: false,
  });
}
