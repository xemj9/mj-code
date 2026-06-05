import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CapabilityRegistryLike } from "./capability-registry.mjs";
import { createSkillPolicyContribution } from "./policy-stack.mjs";
import type { ExtensionStateStoreLike } from "./extension-state-store.mjs";

import type { LoadedConfig } from "../config.mjs";
import type {
  ExtensionExplicitState,
  PolicyContribution,
  SkillInfluenceEntry,
  SkillInspectRecord,
  SkillListEntry,
  SkillScope,
  SkillToolPreferences,
  SkillVariantSummary,
} from "../types/contracts.js";

const BUILTIN_SKILL_DIR = fileURLToPath(new URL("../builtin/skills", import.meta.url));

export type SkillLoaderConfig = Pick<
  LoadedConfig,
  "projectStateDir" | "userStateDir"
> & {
  skillDirs?: string[];
  skillsEnabled?: string[];
  skillsDisabled?: string[];
};

export interface SkillLoaderOptions {
  stateStore?: ExtensionStateStoreLike | null;
}

interface SkillSource {
  scope: SkillScope;
  precedence: number;
  path: string;
}

interface ResolveExtensionStateInput {
  kind: "skills";
  id: string;
  manifestEnabled: boolean;
  stateStore?: ExtensionStateStoreLike | null;
  config: SkillLoaderConfig;
}

interface LoadedSkillManifest {
  id: string;
  title: string;
  description: string;
  version: string;
  scope: SkillScope;
  precedence: number;
  originPath: string;
  sourceQualifiedName: string;
  manifestEnabled: boolean;
  autoAttach: boolean;
  tags: string[];
  prompt: string;
  workflowHints: string[];
  retrievalHints: string[];
  toolPreferences: SkillToolPreferences;
  outputPolicy: string[];
}

interface ResolvedSkillRecord extends SkillInspectRecord {}

export class SkillLoader {
  readonly config: SkillLoaderConfig;
  readonly stateStore: ExtensionStateStoreLike | null;

  private skills: ResolvedSkillRecord[];
  private byId: Map<string, ResolvedSkillRecord>;

  constructor(config: SkillLoaderConfig, options: SkillLoaderOptions = {}) {
    this.config = config;
    this.stateStore = options.stateStore ?? null;
    this.skills = [];
    this.byId = new Map();
  }

  async initialize(): Promise<void> {
    this.skills = await loadSkills(this.config, this.stateStore);
    this.byId = new Map(this.skills.map((skill) => [skill.id, skill]));
  }

  listSkills(): SkillListEntry[] {
    return this.skills.map((skill) => cloneSkillListEntry(skill));
  }

  inspectSkill(idOrName: string): SkillInspectRecord | null {
    const skill = this.resolveSkill(idOrName);
    return skill ? cloneSkillInspectRecord(skill) : null;
  }

  getActiveSkills(): SkillInspectRecord[] {
    return this.skills
      .filter((skill) => skill.active)
      .map((skill) => cloneSkillInspectRecord(skill));
  }

  getPolicyContributions(): PolicyContribution[] {
    return this.getActiveSkills()
      .map((skill) => createSkillPolicyContribution(skill))
      .filter((entry): entry is PolicyContribution => Boolean(entry));
  }

  getInfluenceSummary(): SkillInfluenceEntry[] {
    return this.skills
      .filter((skill) => skill.active)
      .map((skill) => cloneSkillInfluenceEntry(skill.influence));
  }

  async enableSkill(idOrName: string): Promise<SkillInspectRecord> {
    const skill = this.resolveSkill(idOrName);
    if (!skill) {
      throw new Error(`Unknown skill "${idOrName}".`);
    }
    await this.stateStore?.setEnabled("skills", skill.id, true);
    await this.initialize();
    return this.inspectSkill(skill.id) as SkillInspectRecord;
  }

  async disableSkill(idOrName: string): Promise<SkillInspectRecord> {
    const skill = this.resolveSkill(idOrName);
    if (!skill) {
      throw new Error(`Unknown skill "${idOrName}".`);
    }
    await this.stateStore?.setEnabled("skills", skill.id, false);
    await this.initialize();
    return this.inspectSkill(skill.id) as SkillInspectRecord;
  }

  registerCapabilities(capabilityRegistry: CapabilityRegistryLike): void {
    capabilityRegistry.replaceGroup(
      "skills",
      this.skills.map((skill) => ({
        id: `skill:${skill.id}`,
        name: skill.id,
        displayName: skill.title,
        type: "skill",
        source: skill.scope,
        enabled: skill.enabled,
        active: skill.active,
        riskCategory: "policy",
        provenance: {
          scope: skill.scope,
          variants: skill.variants.map((entry) => cloneSkillVariantSummary(entry)),
        },
        description: skill.description,
        tags: [...skill.tags],
        scope: skill.scope,
        originPath: skill.originPath,
        sourceQualifiedName: skill.sourceQualifiedName,
        projectAttached: skill.scope === "project" && skill.autoAttach,
        metadata: {
          autoAttach: skill.autoAttach,
          influenceSummary: skill.influenceSummary,
          influence: cloneSkillInfluenceEntry(skill.influence),
        },
      })),
    );
  }

  private resolveSkill(idOrName: string): ResolvedSkillRecord | null {
    if (!idOrName) {
      return null;
    }

    if (this.byId.has(idOrName)) {
      return this.byId.get(idOrName) ?? null;
    }

    return this.skills.find((skill) =>
      skill.title === idOrName || skill.sourceQualifiedName === idOrName
    ) ?? null;
  }
}

async function loadSkills(
  config: SkillLoaderConfig,
  stateStore: ExtensionStateStoreLike | null,
): Promise<ResolvedSkillRecord[]> {
  const sources = buildSkillSources(config);
  const variantsById = new Map<string, LoadedSkillManifest[]>();

  for (const source of sources) {
    const manifestPaths = await discoverManifestPaths(source.path, "skill.json");
    for (const manifestPath of manifestPaths) {
      const loaded = await loadSkillManifest(manifestPath, source);
      if (!loaded) {
        continue;
      }
      const variants = variantsById.get(loaded.id) ?? [];
      variants.push(loaded);
      variantsById.set(loaded.id, variants);
    }
  }

  const resolved: ResolvedSkillRecord[] = [];
  for (const variants of variantsById.values()) {
    variants.sort((left, right) => left.precedence - right.precedence);
    const selected = variants.at(-1);
    if (!selected) {
      continue;
    }

    const state = resolveExtensionState({
      kind: "skills",
      id: selected.id,
      manifestEnabled: selected.manifestEnabled,
      stateStore,
      config,
    });
    const enabled = state.enabled;
    const active = enabled && (state.explicitState === "enabled" || selected.autoAttach === true);
    const influence = buildSkillInfluenceEntry(selected);

    resolved.push({
      ...selected,
      enabled,
      active,
      explicitState: state.explicitState,
      influenceSummary: influence.summary,
      influence,
      variants: variants.map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        originPath: entry.originPath,
        precedence: entry.precedence,
      })),
    });
  }

  return resolved.sort((left, right) => left.id.localeCompare(right.id));
}

async function loadSkillManifest(
  manifestPath: string,
  source: SkillSource,
): Promise<LoadedSkillManifest | null> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  const id = normalizeIdentifier(raw.id ?? raw.name);
  if (!id) {
    return null;
  }

  const manifestDir = path.dirname(manifestPath);
  const prompt = raw.promptFile
    ? await fs.readFile(path.resolve(manifestDir, `${raw.promptFile}`), "utf8")
    : `${raw.prompt ?? ""}`;

  return {
    id,
    title: `${raw.title ?? raw.name ?? id}`,
    description: `${raw.description ?? ""}`,
    version: `${raw.version ?? "0.0.0"}`,
    scope: source.scope,
    precedence: source.precedence,
    originPath: manifestPath,
    sourceQualifiedName: `${source.scope}:${id}`,
    manifestEnabled: raw.enabled !== false,
    autoAttach: typeof raw.autoAttach === "boolean" ? raw.autoAttach : source.scope === "project",
    tags: normalizeStringArray(raw.tags),
    prompt: prompt.trim(),
    workflowHints: normalizeStringArray(raw.workflowHints),
    retrievalHints: normalizeStringArray(raw.retrievalHints),
    toolPreferences: normalizeToolPreferences(raw.toolPreferences ?? raw.toolPreferenceHints),
    outputPolicy: normalizeStringArray(raw.outputPolicy),
  };
}

function buildSkillSources(config: SkillLoaderConfig): SkillSource[] {
  const configured = Array.isArray(config.skillDirs) ? config.skillDirs : [];
  const rawSources: SkillSource[] = [
    { scope: "builtin", precedence: 100, path: BUILTIN_SKILL_DIR },
    { scope: "project", precedence: 200, path: path.join(config.projectStateDir, "skills") },
    { scope: "local", precedence: 300, path: path.join(config.userStateDir, "skills") },
    ...configured.map((entry, index) => ({
      scope: inferConfiguredScope(entry, config),
      precedence: inferConfiguredPrecedence(entry, config, index),
      path: entry,
    })),
  ];

  const seen = new Set<string>();
  return rawSources.filter((entry) => {
    const resolvedPath = path.resolve(entry.path);
    if (seen.has(resolvedPath)) {
      return false;
    }
    seen.add(resolvedPath);
    entry.path = resolvedPath;
    return true;
  });
}

function inferConfiguredScope(entry: string, config: SkillLoaderConfig): SkillScope {
  const resolved = path.resolve(entry);
  if (resolved === path.resolve(path.join(config.projectStateDir, "skills"))) {
    return "project";
  }
  if (resolved === path.resolve(path.join(config.userStateDir, "skills"))) {
    return "local";
  }
  return "local";
}

function inferConfiguredPrecedence(
  entry: string,
  config: SkillLoaderConfig,
  index: number,
): number {
  const scope = inferConfiguredScope(entry, config);
  return scope === "project" ? 200 + index : 300 + index;
}

async function discoverManifestPaths(
  rootDir: string,
  manifestBasename: string,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const manifests: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isDirectory()) {
        manifests.push(path.join(rootDir, entry.name, manifestBasename));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        manifests.push(path.join(rootDir, entry.name));
      }
    }
    return manifests;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function buildSkillInfluenceEntry(
  skill: Pick<
    LoadedSkillManifest,
    | "id"
    | "title"
    | "scope"
    | "sourceQualifiedName"
    | "workflowHints"
    | "retrievalHints"
    | "toolPreferences"
    | "outputPolicy"
  >,
): SkillInfluenceEntry {
  const summary = [
    skill.workflowHints.length ? `${skill.workflowHints.length} workflow hint(s)` : null,
    skill.retrievalHints.length ? `${skill.retrievalHints.length} retrieval hint(s)` : null,
    skill.toolPreferences.prefer.length ? `prefer ${skill.toolPreferences.prefer.join(", ")}` : null,
    skill.outputPolicy.length ? `${skill.outputPolicy.length} output rule(s)` : null,
  ].filter((entry): entry is string => Boolean(entry)).join(" | ");

  return {
    id: skill.id,
    title: skill.title,
    scope: skill.scope,
    sourceQualifiedName: skill.sourceQualifiedName,
    summary,
    workflowHintCount: skill.workflowHints.length,
    retrievalHintCount: skill.retrievalHints.length,
    preferredTools: [...skill.toolPreferences.prefer],
    avoidedTools: [...skill.toolPreferences.avoid],
    outputRuleCount: skill.outputPolicy.length,
  };
}

function cloneSkillListEntry(skill: ResolvedSkillRecord): SkillListEntry {
  return {
    id: skill.id,
    title: skill.title,
    description: skill.description,
    version: skill.version,
    enabled: skill.enabled,
    active: skill.active,
    scope: skill.scope,
    autoAttach: skill.autoAttach,
    explicitState: skill.explicitState,
    precedence: skill.precedence,
    originPath: skill.originPath,
    sourceQualifiedName: skill.sourceQualifiedName,
    tags: [...skill.tags],
    influenceSummary: skill.influenceSummary,
    influence: cloneSkillInfluenceEntry(skill.influence),
    variants: skill.variants.map((entry) => cloneSkillVariantSummary(entry)),
  };
}

function cloneSkillInspectRecord(skill: ResolvedSkillRecord): SkillInspectRecord {
  return {
    ...cloneSkillListEntry(skill),
    manifestEnabled: skill.manifestEnabled,
    prompt: skill.prompt,
    workflowHints: [...skill.workflowHints],
    retrievalHints: [...skill.retrievalHints],
    toolPreferences: cloneSkillToolPreferences(skill.toolPreferences),
    outputPolicy: [...skill.outputPolicy],
  };
}

function cloneSkillInfluenceEntry(entry: SkillInfluenceEntry): SkillInfluenceEntry {
  return {
    id: entry.id,
    title: entry.title,
    scope: entry.scope,
    sourceQualifiedName: entry.sourceQualifiedName,
    summary: entry.summary,
    workflowHintCount: entry.workflowHintCount,
    retrievalHintCount: entry.retrievalHintCount,
    preferredTools: [...entry.preferredTools],
    avoidedTools: [...entry.avoidedTools],
    outputRuleCount: entry.outputRuleCount,
  };
}

function cloneSkillToolPreferences(value: SkillToolPreferences): SkillToolPreferences {
  return {
    prefer: [...value.prefer],
    avoid: [...value.avoid],
  };
}

function cloneSkillVariantSummary(entry: SkillVariantSummary): SkillVariantSummary {
  return {
    id: entry.id,
    scope: entry.scope,
    originPath: entry.originPath,
    precedence: entry.precedence,
  };
}

function normalizeToolPreferences(value: unknown): SkillToolPreferences {
  const raw = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return {
    prefer: normalizeStringArray(raw.prefer),
    avoid: normalizeStringArray(raw.avoid),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => `${entry}`.trim()).filter(Boolean))];
}

function normalizeIdentifier(value: unknown): string | null {
  const normalized = `${value ?? ""}`.trim();
  return normalized || null;
}

function resolveExtensionState(
  { kind, id, manifestEnabled, stateStore, config }: ResolveExtensionStateInput,
): {
  enabled: boolean;
  explicitState: ExtensionExplicitState;
} {
  if (Array.isArray(config.skillsEnabled) && config.skillsEnabled.includes(id)) {
    return {
      enabled: true,
      explicitState: "enabled",
    };
  }

  if (Array.isArray(config.skillsDisabled) && config.skillsDisabled.includes(id)) {
    return {
      enabled: false,
      explicitState: "disabled",
    };
  }

  const resolved = stateStore?.resolve(kind, id, manifestEnabled);
  return {
    enabled: resolved?.enabled ?? manifestEnabled !== false,
    explicitState:
      resolved?.explicitState === "enabled" || resolved?.explicitState === "disabled"
        ? resolved.explicitState
        : null,
  };
}

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return (error as NodeJS.ErrnoException).code === code;
}
