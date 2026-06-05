import type {
  CapabilityInput,
  CapabilityRiskCategory,
  CapabilityScope,
  CapabilitySummary,
  CapabilitySurfaceSummary,
  CapabilityType,
  JsonObject,
  JsonValue,
  NormalizedCapability,
  ToolCapabilityType,
} from "../types/contracts.js";

export const CAPABILITY_TYPES: CapabilityType[] = [
  "builtin-tool",
  "web-tool",
  "mcp-tool",
  "plugin-tool",
  "skill",
  "memory",
  "instruction/policy",
];

export const TOOL_CAPABILITY_TYPES: ToolCapabilityType[] = [
  "builtin-tool",
  "web-tool",
  "mcp-tool",
  "plugin-tool",
];

const CAPABILITY_TYPE_SET = new Set<CapabilityType>(CAPABILITY_TYPES);
const TOOL_CAPABILITY_TYPE_SET = new Set<ToolCapabilityType>(TOOL_CAPABILITY_TYPES);

const DEFAULT_RISK_BY_TYPE: Record<CapabilityType, CapabilityRiskCategory> = {
  "builtin-tool": "read",
  "web-tool": "network",
  "mcp-tool": "external",
  "plugin-tool": "external",
  skill: "policy",
  memory: "state",
  "instruction/policy": "policy",
};

export function normalizeCapabilityType(type: unknown): CapabilityType {
  return isCapabilityType(type) ? type : "instruction/policy";
}

export function normalizeCapability(value: CapabilityInput = {}): NormalizedCapability {
  const type = normalizeCapabilityType(value.type);
  const source = `${value.source ?? "unknown"}`.trim() || "unknown";
  const name = normalizeOptionalString(value.name);
  const enabled = normalizeBoolean(value.enabled, true);
  const active = normalizeBoolean(value.active, enabled);
  const id = normalizeOptionalString(value.id) ?? buildCapabilityId({ type, source, name });
  const riskCategory =
    normalizeOptionalString(value.riskCategory) ?? DEFAULT_RISK_BY_TYPE[type];
  const tags = normalizeTags(value.tags);
  const sourceQualifiedName =
    normalizeOptionalString(value.sourceQualifiedName) ??
    (name ? `${source}:${name}` : id);
  const normalizedScope =
    normalizeCapabilityScope(value.scope) ?? inferScope(source);

  return {
    id,
    name: name ?? id,
    displayName: normalizeOptionalString(value.displayName) ?? name ?? id,
    type,
    source,
    enabled,
    active,
    riskCategory,
    provenance: normalizeJsonObject(value.provenance),
    description: normalizeOptionalString(value.description) ?? "",
    inputSchema: normalizeNullableJsonObject(value.inputSchema),
    tags,
    scope: normalizedScope,
    originPath: normalizeOptionalString(value.originPath),
    sourceQualifiedName,
    projectAttached: normalizeBoolean(
      value.projectAttached,
      inferProjectAttached(normalizedScope, source),
    ),
    inherited: normalizeBoolean(value.inherited, false),
    external: normalizeBoolean(value.external, isExternalType(type)),
    risky: normalizeBoolean(value.risky, isRiskCategoryRisky(riskCategory)),
    groupKey: normalizeOptionalString(value.groupKey),
    metadata: normalizeJsonObject(value.metadata),
  };
}

export function isCapabilityType(value: unknown): value is CapabilityType {
  return typeof value === "string" && CAPABILITY_TYPE_SET.has(value as CapabilityType);
}

export function isToolCapability(type: unknown): type is ToolCapabilityType {
  return typeof type === "string" && TOOL_CAPABILITY_TYPE_SET.has(type as ToolCapabilityType);
}

export function isExternalType(type: CapabilityType | string): boolean {
  return type === "web-tool" || type === "mcp-tool" || type === "plugin-tool";
}

export function isRiskCategoryRisky(riskCategory: unknown): boolean {
  return (
    riskCategory === "write" ||
    riskCategory === "exec" ||
    riskCategory === "network" ||
    riskCategory === "external" ||
    riskCategory === "destructive"
  );
}

export function summarizeCapabilitySurface(
  capabilities: ReadonlyArray<CapabilityInput | CapabilitySummary> = [],
): CapabilitySurfaceSummary {
  const normalized = capabilities.map((entry) => normalizeCapability({
    ...entry,
  }));
  const byType = Object.fromEntries(
    CAPABILITY_TYPES.map((type) => [
      type,
      normalized.filter((entry) => entry.type === type).length,
    ]),
  ) as CapabilitySurfaceSummary["byType"];

  return {
    total: normalized.length,
    active: normalized.filter((entry) => entry.active).length,
    disabled: normalized.filter((entry) => !entry.enabled).length,
    external: normalized.filter((entry) => entry.external).length,
    risky: normalized.filter((entry) => entry.risky).length,
    projectAttached: normalized.filter((entry) => entry.projectAttached).length,
    inherited: normalized.filter((entry) => entry.inherited).length,
    byType,
  };
}

export function sortCapabilities<T extends CapabilitySummary>(capabilities: ReadonlyArray<T> = []): T[] {
  return [...capabilities].sort((left, right) => {
    const activeDiff = Number(right.active) - Number(left.active);
    if (activeDiff !== 0) {
      return activeDiff;
    }

    const typeDiff = left.type.localeCompare(right.type);
    if (typeDiff !== 0) {
      return typeDiff;
    }

    const sourceDiff = left.source.localeCompare(right.source);
    if (sourceDiff !== 0) {
      return sourceDiff;
    }

    return (left.displayName ?? left.id).localeCompare(right.displayName ?? right.id);
  });
}

function buildCapabilityId(input: {
  type: CapabilityType;
  source: string;
  name: string | null;
}): string {
  return `${input.type}:${input.source}:${input.name ?? input.type}`;
}

function inferScope(source: string): CapabilityScope {
  if (source === "builtin") {
    return "builtin";
  }
  if (source === "project" || source.startsWith("project:")) {
    return "project";
  }
  if (source === "local" || source.startsWith("local:")) {
    return "local";
  }
  if (source.startsWith("mcp:")) {
    return "external";
  }
  return "runtime";
}

function inferProjectAttached(scope: CapabilityScope, source: string): boolean {
  return scope === "project" || source === "project" || source.startsWith("project:");
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((entry) => `${entry}`.trim()).filter(Boolean))];
}

function normalizeOptionalString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const normalized = `${value}`.trim();
  return normalized || null;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }
  return Boolean(value);
}

function normalizeCapabilityScope(value: unknown): CapabilityScope | null {
  if (
    value === "builtin" ||
    value === "project" ||
    value === "local" ||
    value === "runtime" ||
    value === "user" ||
    value === "external"
  ) {
    return value;
  }
  return null;
}

function normalizeNullableJsonObject(value: unknown): JsonObject | null {
  if (!isRecord(value)) {
    return null;
  }
  return normalizeJsonObject(value);
}

function normalizeJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const jsonValue = normalizeJsonValue(entry);
    if (jsonValue !== undefined) {
      normalized[key] = jsonValue;
    }
  }
  return normalized;
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (isRecord(value)) {
    return normalizeJsonObject(value);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
