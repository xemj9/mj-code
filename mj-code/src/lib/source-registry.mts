import fs from "node:fs/promises";
import path from "node:path";

import { canonicalizeUrl, normalizeDomain } from "./web-policy.mjs";

import type {
  CitationSummary,
  SourcePackRecord,
  SourceRecord,
  SourceRegistryState,
  SourceScoreBreakdown,
  SourceTrustLayer,
} from "../types/contracts.js";

type SourceEntryInput = Record<string, unknown>;
type SourcePackMetadata = Record<string, unknown>;

interface RegisterPackResult {
  pack: SourcePackRecord;
  sources: SourceRecord[];
  citations: CitationSummary[];
}

export class SourceRegistry {
  readonly projectStateDir: string;
  readonly sourceDir: string;
  sessionId: string | null;
  state: SourceRegistryState;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.sourceDir = path.join(projectStateDir, "sources");
    this.sessionId = null;
    this.state = createEmptyState();
  }

  async initialize(sessionId: string | null = null): Promise<void> {
    await fs.mkdir(this.sourceDir, { recursive: true });
    this.sessionId = sessionId;
    if (sessionId) {
      this.state = await this.loadSessionState(sessionId);
    }
  }

  async registerPack(
    entries: SourceEntryInput[],
    metadata: SourcePackMetadata = {},
  ): Promise<RegisterPackResult> {
    const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const sources: SourceRecord[] = [];

    for (const entry of normalizedEntries) {
      const source = this.upsertSource(entry, metadata);
      sources.push(source);
    }

    const pack: SourcePackRecord = {
      id: `pack-${this.state.packs.length + 1}`,
      createdAt: new Date().toISOString(),
      toolName: toString(metadata.toolName),
      query: toString(metadata.query),
      url: toString(metadata.url),
      provider: toString(metadata.provider),
      reasonUsed: toString(metadata.reasonUsed),
      sourceIds: sources.map((entry) => entry.sourceId),
    };

    this.state.packs.push(pack);
    await this.persist();

    return {
      pack,
      sources,
      citations: sources.map((entry) => buildCitation(entry, toString(metadata.reasonUsed))),
    };
  }

  listSources(limit = 50): SourceRecord[] {
    return this.state.sources.slice(-limit).reverse();
  }

  getLastPack(): SourcePackRecord | null {
    return this.state.packs.at(-1) ?? null;
  }

  getSource(sourceId: string): SourceRecord | null {
    return this.state.sources.find((entry) => entry.sourceId === sourceId) ?? null;
  }

  async loadLatestFromSessions(sessionIds: string[] = []): Promise<SourceRegistryState> {
    for (const sessionId of sessionIds) {
      const state = await this.loadSessionState(sessionId);
      if (state.sources.length > 0) {
        this.sessionId = sessionId;
        this.state = state;
        return state;
      }
    }
    return this.state;
  }

  exportState(): SourceRegistryState {
    return structuredClone(this.state);
  }

  hydrate(snapshot: Partial<SourceRegistryState> | null | undefined): void {
    this.state = {
      nextId: Number(snapshot?.nextId ?? 1),
      sources: Array.isArray(snapshot?.sources) ? snapshot.sources : [],
      packs: Array.isArray(snapshot?.packs) ? snapshot.packs : [],
    };
  }

  async loadSessionState(sessionId: string): Promise<SourceRegistryState> {
    try {
      const filePath = this.getSessionPath(sessionId);
      const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<SourceRegistryState>;
      return {
        nextId: Number(payload.nextId ?? 1),
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        packs: Array.isArray(payload.packs) ? payload.packs : [],
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return createEmptyState();
      }
      throw error;
    }
  }

  async persist(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    await fs.mkdir(this.sourceDir, { recursive: true });
    await fs.writeFile(this.getSessionPath(this.sessionId), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  upsertSource(entry: SourceEntryInput, metadata: SourcePackMetadata): SourceRecord {
    const canonicalUrl = canonicalizeUrl(toString(entry.canonicalUrl) ?? toString(entry.url) ?? "");
    const existing = this.state.sources.find((source) => source.canonicalUrl === canonicalUrl);
    const base: SourceRecord = {
      url: toString(entry.url) ?? canonicalUrl,
      canonicalUrl,
      title: toString(entry.title) ?? toString(entry.url) ?? canonicalUrl,
      domain: normalizeDomain(toString(entry.domain) ?? canonicalUrl),
      sourceKind: toSourceKind(entry.sourceKind),
      trustLayer: toSourceTrustLayer(entry.trustLayer),
      official: Boolean(entry.official),
      provider: toString(entry.provider) ?? toString(metadata.provider),
      query: toString(entry.query) ?? toString(metadata.query),
      fetchedAt: toString(entry.fetchedAt) ?? toString(entry.retrievedAt) ?? new Date().toISOString(),
      publishedAt: toString(entry.publishedAt),
      score: toNullableNumber(entry.score),
      scoreBreakdown: toSourceScoreBreakdown(entry.scoreBreakdown),
      excerpt: toString(entry.excerpt) ?? toString(entry.snippet),
      cacheHit: Boolean(entry.cacheHit),
      author: toString(entry.author),
      headings: Array.isArray(entry.headings)
        ? entry.headings.map((value) => `${value}`)
        : [],
      locator: toString(entry.locator),
      retrievedAt: toString(entry.retrievedAt) ?? new Date().toISOString(),
      sourceId: existing?.sourceId ?? `S${this.state.nextId}`,
    };

    if (existing) {
      Object.assign(existing, {
        ...existing,
        ...base,
        sourceId: existing.sourceId,
      });
      return existing;
    }

    this.state.nextId += 1;
    this.state.sources.push(base);
    return base;
  }

  getSessionPath(sessionId: string): string {
    return path.join(this.sourceDir, `${sessionId}.json`);
  }
}

function createEmptyState(): SourceRegistryState {
  return {
    nextId: 1,
    sources: [],
    packs: [],
  };
}

function buildCitation(
  source: SourceRecord,
  reasonUsed: string | null = null,
): CitationSummary {
  return {
    sourceId: source.sourceId,
    title: source.title,
    url: source.url,
    domain: source.domain,
    reasonUsed,
    locator: source.locator ?? null,
  };
}

function toString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSourceKind(value: unknown): SourceRecord["sourceKind"] {
  return typeof value === "string" && value.trim() ? value : "unknown";
}

function toSourceTrustLayer(value: unknown): SourceTrustLayer | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toSourceScoreBreakdown(value: unknown): SourceScoreBreakdown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const trustGraph = toFiniteNumber(candidate.trustGraph);
  const officialness = toFiniteNumber(candidate.officialness);
  const queryTitleOverlap = toFiniteNumber(candidate.queryTitleOverlap);
  const querySnippetOverlap = toFiniteNumber(candidate.querySnippetOverlap);
  const queryUrlOverlap = toFiniteNumber(candidate.queryUrlOverlap);
  const docsHint = toFiniteNumber(candidate.docsHint);
  const freshness = toFiniteNumber(candidate.freshness);
  const allowlistBonus = toFiniteNumber(candidate.allowlistBonus);
  const mirrorPenalty = toFiniteNumber(candidate.mirrorPenalty);
  const spamPenalty = toFiniteNumber(candidate.spamPenalty);
  const modeBonus = toFiniteNumber(candidate.modeBonus);
  const total = toFiniteNumber(candidate.total);
  if (
    trustGraph === null ||
    officialness === null ||
    queryTitleOverlap === null ||
    querySnippetOverlap === null ||
    queryUrlOverlap === null ||
    docsHint === null ||
    freshness === null ||
    allowlistBonus === null ||
    mirrorPenalty === null ||
    spamPenalty === null ||
    modeBonus === null ||
    total === null
  ) {
    return null;
  }

  return {
    trustGraph,
    officialness,
    queryTitleOverlap,
    querySnippetOverlap,
    queryUrlOverlap,
    docsHint,
    freshness,
    allowlistBonus,
    mirrorPenalty,
    spamPenalty,
    modeBonus,
    total,
  };
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error != null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
