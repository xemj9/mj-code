import {
  isToolCapability,
  normalizeCapability,
  sortCapabilities,
  summarizeCapabilitySurface,
} from "./capability-types.mjs";

import type {
  CapabilityFilters,
  CapabilityInput,
  CapabilitySurfaceSummary,
  NormalizedCapability,
} from "../types/contracts.js";

export interface CapabilityRegistryDescription {
  summary: CapabilitySurfaceSummary;
  capabilities: NormalizedCapability[];
}

export interface CapabilityRegistryLike {
  upsert(capability: CapabilityInput): NormalizedCapability;
  upsertMany(capabilities?: CapabilityInput[]): NormalizedCapability[];
  replaceGroup(groupKey: string, capabilities?: CapabilityInput[]): NormalizedCapability[];
  clearGroup(groupKey: string): void;
  get(idOrName: string | null | undefined): NormalizedCapability | null;
  inspect(idOrName: string | null | undefined): NormalizedCapability | null;
  list(filters?: CapabilityFilters): NormalizedCapability[];
  listTools(filters?: CapabilityFilters): NormalizedCapability[];
  getSurfaceMap(filters?: CapabilityFilters): CapabilitySurfaceSummary;
  describe(filters?: CapabilityFilters): CapabilityRegistryDescription;
}

export class CapabilityRegistry implements CapabilityRegistryLike {
  private readonly capabilities: Map<string, NormalizedCapability>;

  constructor() {
    this.capabilities = new Map();
  }

  upsert(capability: CapabilityInput): NormalizedCapability {
    const normalized = normalizeCapability(capability);
    this.capabilities.set(normalized.id, normalized);
    return normalized;
  }

  upsertMany(capabilities: CapabilityInput[] = []): NormalizedCapability[] {
    return capabilities.map((entry) => this.upsert(entry));
  }

  replaceGroup(groupKey: string, capabilities: CapabilityInput[] = []): NormalizedCapability[] {
    this.clearGroup(groupKey);
    return this.upsertMany(
      capabilities.map((entry) => ({
        ...entry,
        groupKey,
      })),
    );
  }

  clearGroup(groupKey: string): void {
    if (!groupKey) {
      return;
    }

    for (const [id, capability] of this.capabilities.entries()) {
      if (capability.groupKey === groupKey) {
        this.capabilities.delete(id);
      }
    }
  }

  get(idOrName: string | null | undefined): NormalizedCapability | null {
    if (!idOrName) {
      return null;
    }

    if (this.capabilities.has(idOrName)) {
      return this.capabilities.get(idOrName) ?? null;
    }

    const normalized = `${idOrName}`.trim();
    for (const capability of this.capabilities.values()) {
      if (
        capability.name === normalized ||
        capability.displayName === normalized ||
        capability.sourceQualifiedName === normalized
      ) {
        return capability;
      }
    }

    return null;
  }

  inspect(idOrName: string | null | undefined): NormalizedCapability | null {
    const capability = this.get(idOrName);
    return capability ? cloneCapability(capability) : null;
  }

  list(filters: CapabilityFilters = {}): NormalizedCapability[] {
    return sortCapabilities([...this.capabilities.values()])
      .filter((entry) => matchesFilters(entry, filters))
      .map((entry) => cloneCapability(entry));
  }

  listTools(filters: CapabilityFilters = {}): NormalizedCapability[] {
    return this.list(filters).filter((entry) => isToolCapability(entry.type));
  }

  getSurfaceMap(filters: CapabilityFilters = {}): CapabilitySurfaceSummary {
    return summarizeCapabilitySurface(this.list(filters));
  }

  describe(filters: CapabilityFilters = {}): CapabilityRegistryDescription {
    const capabilities = this.list(filters);
    return {
      summary: summarizeCapabilitySurface(capabilities),
      capabilities,
    };
  }
}

function matchesFilters(
  capability: NormalizedCapability,
  filters: CapabilityFilters,
): boolean {
  if (filters.type && capability.type !== filters.type) {
    return false;
  }
  if (filters.enabled != null && capability.enabled !== Boolean(filters.enabled)) {
    return false;
  }
  if (filters.active != null && capability.active !== Boolean(filters.active)) {
    return false;
  }
  if (filters.source && capability.source !== filters.source) {
    return false;
  }
  if (filters.scope && capability.scope !== filters.scope) {
    return false;
  }
  if (filters.external != null && capability.external !== Boolean(filters.external)) {
    return false;
  }
  if (filters.risky != null && capability.risky !== Boolean(filters.risky)) {
    return false;
  }
  if (
    filters.projectAttached != null &&
    capability.projectAttached !== Boolean(filters.projectAttached)
  ) {
    return false;
  }
  if (filters.inherited != null && capability.inherited !== Boolean(filters.inherited)) {
    return false;
  }
  if (filters.groupKey && capability.groupKey !== filters.groupKey) {
    return false;
  }
  if (filters.tag && !capability.tags.includes(filters.tag)) {
    return false;
  }
  if (filters.query) {
    const query = filters.query.toLowerCase();
    const haystack = [
      capability.id,
      capability.name,
      capability.displayName,
      capability.sourceQualifiedName,
      capability.description,
      capability.source,
      ...capability.tags,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }
  return true;
}

function cloneCapability(capability: NormalizedCapability): NormalizedCapability {
  return structuredClone(capability);
}
