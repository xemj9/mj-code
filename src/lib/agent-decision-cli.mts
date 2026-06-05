import type {
  AgentDecisionRenderProfile,
  AgentDecisionScope,
} from "../types/contracts.js";

import { normalizeAgentDecisionRenderProfile } from "./agent-decision-inspect.mjs";

const SCOPES = new Set<AgentDecisionScope>([
  "overview",
  "route",
  "model",
  "tool",
  "plan",
  "verifier",
]);

export interface ParsedWhyCommand {
  scope: AgentDecisionScope;
  reference: string;
  profile: AgentDecisionRenderProfile;
}

export interface ParsedDecisionActionCommand {
  reference: string;
  profile: AgentDecisionRenderProfile;
}

export function parseWhyCommandArgs(
  parts: string[],
  usage: string,
  format: string | null = null,
): ParsedWhyCommand {
  if (parts.length > 3) {
    throw new Error(`Usage: ${usage}`);
  }
  const [first, second, third] = parts;
  const scope = isScopeToken(first) ? first : "overview";
  const referenceToken = isScopeToken(first)
    ? second
    : first;
  const reference = referenceToken && !isRenderProfileToken(referenceToken)
    ? normalizeDecisionReference(referenceToken)
    : "current";
  const profileToken = isRenderProfileToken(referenceToken)
    ? referenceToken
    : isRenderProfileToken(second)
      ? second
      : third ?? format;
  return {
    scope,
    reference,
    profile: normalizeAgentDecisionRenderProfile(profileToken),
  };
}

export function parseDecisionActionArgs(
  parts: string[],
  usage: string,
  format: string | null = null,
): ParsedDecisionActionCommand {
  if (parts.length > 2) {
    throw new Error(`Usage: ${usage}`);
  }
  const [first, second] = parts;
  const reference = first && !isRenderProfileToken(first)
    ? normalizeDecisionReference(first)
    : "current";
  const profileToken = isRenderProfileToken(first) ? first : second ?? format;
  return {
    reference,
    profile: normalizeAgentDecisionRenderProfile(profileToken),
  };
}

function isScopeToken(value: string | undefined): value is AgentDecisionScope {
  return Boolean(value) && SCOPES.has(value as AgentDecisionScope);
}

function isRenderProfileToken(value: string | undefined): boolean {
  return value === "json" || value === "summary" || value === "failures";
}

function normalizeDecisionReference(value: string): string {
  if (value === "current" || value === "trace" || value === "latest" || value.startsWith("replay:")) {
    return value;
  }
  return `replay:${value}`;
}
