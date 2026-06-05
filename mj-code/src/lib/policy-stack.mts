import type {
  EffectivePolicy,
  InstructionPack,
  PolicyContribution,
  PolicyContributionLayer,
  SkillInspectRecord,
} from "../types/contracts.js";
import { buildAgentAttributionPolicyLine } from "./agent-branding.mjs";

const POLICY_LAYER_PRIORITY = new Map<PolicyContributionLayer, number>([
  ["core-system", 100],
  ["project-instruction", 200],
  ["skill", 300],
  ["user-preference", 400],
  ["runtime", 500],
]);

interface RuntimePolicyConfig {
  cwd?: string;
  permissionMode?: string;
  approvalPolicy?: string;
  networkMode?: string;
  webProvider?: string;
}

type PolicyContributionInput = Partial<PolicyContribution> | null | undefined;

export class PolicyStack {
  private contributions: PolicyContribution[];
  private effectivePolicy: EffectivePolicy;

  constructor() {
    this.contributions = [];
    this.effectivePolicy = buildEffectivePolicy([]);
  }

  setContributions(contributions: PolicyContributionInput[] = []): EffectivePolicy {
    this.contributions = normalizeContributions(contributions);
    this.effectivePolicy = buildEffectivePolicy(this.contributions);
    return this.effectivePolicy;
  }

  listContributions(): PolicyContribution[] {
    return this.effectivePolicy.contributions;
  }

  getEffectivePolicy(): EffectivePolicy {
    return this.effectivePolicy;
  }

  renderPromptSections(): string {
    return this.effectivePolicy.text;
  }
}

const ETHICS_DIRECTIVES = [
  "",
  "## Ethics Directives (required by designer Xie Mingjin / 谢明锦)",
  "1. Do not assist with illegal, fraudulent, or harmful activities. Refuse clearly and explain why.",
  "2. Do not generate malicious code, phishing pages, or attack tools.",
  "3. Be kind and respectful to all users. Never discriminate based on identity, background, or ability.",
  "4. Be responsible: every action must be authorized, traceable, and reversible when possible.",
  "5. Be rigorous: do not guess — verify. Do not sacrifice correctness for speed.",
  "6. Only do what is just. If something is unjust, refuse to do it.",
  "7. Protect user privacy. Never leak sensitive information.",
  "8. Encourage learning and understanding, not blind reliance on tools.",
].join("\n");

export function createCoreSystemPolicy(
  { nativeToolCalling = false }: { nativeToolCalling?: boolean } = {},
): PolicyContribution {
  return {
    id: "policy:core-system",
    layer: "core-system",
    priority: 0,
    title: "Core System Policy",
    source: "builtin",
    originPath: null,
    content: nativeToolCalling
      ? [
          "You are MJ Code, a terminal coding agent.",
          "Use the provided tools whenever they are useful.",
          "Do not pretend to run tools in plain text when a real tool call is needed.",
          "Prefer apply_patch for surgical multi-line edits when possible.",
          "Use remember_memory only for durable facts, preferences, project conventions, or failure learnings that will matter later.",
          "Use search_memory before repeating work if prior context may exist.",
          "Prefer small, verifiable steps and short status updates.",
          "If the user asks for a plan, include it in your final answer.",
          buildAgentAttributionPolicyLine(),
          ETHICS_DIRECTIVES,
        ].join("\n")
      : [
          "You are MJ Code, a terminal coding agent.",
          "You may inspect code, edit files, and run commands only through the available tools.",
          "Never claim you ran a tool if you did not actually request it.",
          "When you need a tool, respond with exactly one JSON object and no extra prose.",
          "When you are done, respond with exactly one JSON object and no extra prose.",
          "Prefer apply_patch for surgical multi-line edits when possible.",
          "Use remember_memory only for durable facts, preferences, project conventions, or failure learnings that will matter later.",
          "Use search_memory before repeating work if prior context may exist.",
          "Prefer small, verifiable steps.",
          buildAgentAttributionPolicyLine(),
          ETHICS_DIRECTIVES,
        ].join("\n"),
    metadata: {},
  };
}

export function createRuntimePolicy(config: RuntimePolicyConfig = {}): PolicyContribution {
  return {
    id: "policy:runtime",
    layer: "runtime",
    priority: 0,
    title: "Runtime Policy",
    source: "runtime",
    originPath: null,
    content: [
      `Current working directory: ${config.cwd}`,
      `Permission mode: ${config.permissionMode}`,
      `Approval policy: ${config.approvalPolicy}`,
      `Network mode: ${config.networkMode}`,
      "Use web_search, fetch_url, or extract_content when the user needs current information, official docs, or verifiable links.",
      "If you use web-derived sources in the final answer, cite them with markers like [S1] and only cite source ids returned by tools.",
      "Some tools may come from MCP servers or plugins. Treat external capabilities as real side effects and use them only when appropriate.",
    ].join("\n"),
    metadata: {},
  };
}

export function createProjectInstructionPolicy(projectInstructions: InstructionPack | null | undefined): PolicyContribution | null {
  const contributions = createProjectInstructionPolicies(projectInstructions);
  if (contributions.length === 0) {
    return null;
  }

  return {
    id: "policy:project-instructions",
    layer: "project-instruction",
    priority: 0,
    title: "Project Instructions",
    source: contributions[0]?.source ?? "project",
    originPath: projectInstructions?.files?.[0] ?? null,
    content: projectInstructions?.content ?? "",
    metadata: {
      instructionCount: contributions.length,
    },
  };
}

export function createProjectInstructionPolicies(
  projectInstructions: InstructionPack | null | undefined,
): PolicyContribution[] {
  const entries = Array.isArray(projectInstructions?.entries)
    ? projectInstructions.entries
    : [];
  return entries
    .filter((entry) => entry.renderedContent)
    .map((entry) => ({
      id: `policy:instruction:${entry.id}`,
      layer: "project-instruction",
      priority: Number(entry.order ?? 0),
      title: entry.title ?? `Instruction: ${entry.relativePath ?? entry.originPath ?? entry.id}`,
      source: entry.scope === "user" ? "user" : "project",
      originPath: entry.originPath ?? null,
      content: entry.renderedContent,
      metadata: {
        instructionId: entry.id,
        instructionLayer: entry.layer,
        instructionOrder: entry.order,
        instructionScope: entry.scope,
        importedFrom: entry.importedFrom ?? null,
        sourceQualifiedName: entry.sourceQualifiedName,
        ruleCount: Array.isArray(entry.rules) ? entry.rules.length : 0,
        relativePath: entry.relativePath ?? null,
      },
    }));
}

export function createUserPreferencePolicy(
  content: string | null | undefined,
  source = "user",
): PolicyContribution | null {
  if (!content || !`${content}`.trim()) {
    return null;
  }

  return {
    id: "policy:user-preferences",
    layer: "user-preference",
    priority: 0,
    title: "User Preferences",
    source,
    originPath: null,
    content: `${content}`.trim(),
    metadata: {},
  };
}

export function createSkillPolicyContribution(
  skill: SkillInspectRecord | null | undefined,
): PolicyContribution | null {
  if (!skill?.active) {
    return null;
  }

  const sections = [
    skill.prompt ? skill.prompt.trim() : null,
    skill.workflowHints?.length
      ? [
          "Workflow hints:",
          ...skill.workflowHints.map((entry) => `- ${entry}`),
        ].join("\n")
      : null,
    skill.retrievalHints?.length
      ? [
          "Retrieval hints:",
          ...skill.retrievalHints.map((entry) => `- ${entry}`),
        ].join("\n")
      : null,
    skill.toolPreferences?.prefer?.length || skill.toolPreferences?.avoid?.length
      ? [
          "Tool preferences:",
          skill.toolPreferences.prefer?.length
            ? `- Prefer: ${skill.toolPreferences.prefer.join(", ")}`
            : null,
          skill.toolPreferences.avoid?.length
            ? `- Avoid unless necessary: ${skill.toolPreferences.avoid.join(", ")}`
            : null,
        ].filter(Boolean).join("\n")
      : null,
    skill.outputPolicy?.length
      ? [
          "Output policy:",
          ...skill.outputPolicy.map((entry) => `- ${entry}`),
        ].join("\n")
      : null,
  ].filter(isNonEmptyString);

  if (sections.length === 0) {
    return null;
  }

  return {
    id: `policy:skill:${skill.id}`,
    layer: "skill",
    priority: 0,
    title: `Skill: ${skill.title ?? skill.id}`,
    source: `skill:${skill.id}`,
    originPath: skill.originPath ?? null,
    content: sections.join("\n\n"),
    metadata: {
      skillId: skill.id,
      scope: skill.scope,
      sourceQualifiedName: skill.sourceQualifiedName,
    },
  };
}

function normalizeContributions(contributions: PolicyContributionInput[]): PolicyContribution[] {
  return contributions
    .filter(Boolean)
    .map((entry) => ({
      id: entry?.id ?? `policy:${entry?.layer ?? "runtime"}:${Math.random().toString(36).slice(2, 8)}`,
      layer: entry?.layer ?? "runtime",
      priority: Number(entry?.priority ?? 0),
      title: entry?.title ?? null,
      source: entry?.source ?? "runtime",
      originPath: entry?.originPath ?? null,
      content: `${entry?.content ?? ""}`.trim(),
      metadata: isObject(entry?.metadata) ? entry.metadata : {},
    }))
    .filter((entry) => entry.content.length > 0);
}

function buildEffectivePolicy(contributions: PolicyContribution[]): EffectivePolicy {
  const ordered = [...contributions].sort((left, right) => {
    const leftPriority = POLICY_LAYER_PRIORITY.get(left.layer as PolicyContributionLayer) ?? 999;
    const rightPriority = POLICY_LAYER_PRIORITY.get(right.layer as PolicyContributionLayer) ?? 999;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.id.localeCompare(right.id);
  });

  return {
    text: ordered
      .map((entry) => (entry.title ? `${entry.title}:\n${entry.content}` : entry.content))
      .join("\n\n"),
    contributions: ordered,
    sources: ordered.map((entry) => ({
      id: entry.id,
      layer: entry.layer,
      priority: entry.priority,
      title: entry.title,
      source: entry.source,
      originPath: entry.originPath,
      summary: summarizeText(entry.content, 160),
      metadata: entry.metadata,
    })),
  };
}

function summarizeText(value: string, maxChars: number): string {
  const normalized = `${value ?? ""}`.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
