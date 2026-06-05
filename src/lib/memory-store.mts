import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { abbreviate } from "./path-utils.mjs";

import type {
  MemoryContextPack,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStatus,
} from "../types/contracts.js";

const SUPPORTED_SCOPES = new Set<MemoryScope>(["session", "project", "user", "failure"]);
const SUPPORTED_KINDS = new Set<MemoryKind>(["episodic", "semantic", "policy"]);
const DEFAULT_SCOPE_KIND: Record<MemoryScope, MemoryKind> = {
  session: "episodic",
  project: "semantic",
  user: "policy",
  failure: "episodic",
};

interface MemoryStoreConfig {
  cwd: string;
  projectStateDir: string;
  userStateDir: string;
}

interface ProjectInstructionsInput {
  files?: string[];
}

interface InitializeMemoryOptions {
  sessionFilePath: string;
  projectInstructions?: ProjectInstructionsInput | null;
}

interface RememberInput {
  scope: MemoryScope;
  key?: string | null;
  kind?: MemoryKind | null;
  source?: string | null;
  text: string;
  summary?: string | null;
  tags?: unknown[];
  confidence?: number | null;
  importance?: number | null;
  sourceCertainty?: number | null;
  lastVerifiedAt?: string | null;
  expiresAt?: string | null;
  expiresInDays?: number | null;
  status?: MemoryStatus | null;
}

interface SearchOptions {
  scopes?: MemoryScope[];
  limit?: number;
}

interface ContextPackOptions extends SearchOptions {
  maxTokens?: number;
}

interface ToolEvent {
  tool?: string | null;
  result?: {
    path?: string;
    paths?: string[];
    [key: string]: unknown;
  } | null;
}

interface RecordTurnOptions {
  userInput: string;
  assistantOutput?: string | null;
  toolEvents?: ToolEvent[];
  success?: boolean;
  stopped?: boolean;
}

type MemoryCache = Map<MemoryScope, MemoryRecord[]>;

export class MemoryStore {
  readonly config: MemoryStoreConfig;
  readonly cache: MemoryCache;
  sessionMemoryPath: string | null;
  readonly projectMemoryPath: string;
  readonly failureMemoryPath: string;
  readonly userMemoryPath: string;

  constructor(config: MemoryStoreConfig) {
    this.config = config;
    this.cache = new Map();
    this.sessionMemoryPath = null;
    this.projectMemoryPath = path.join(config.projectStateDir, "memory", "project.json");
    this.failureMemoryPath = path.join(config.projectStateDir, "memory", "failure.json");
    this.userMemoryPath = path.join(config.userStateDir, "preferences.json");
  }

  async initialize({ sessionFilePath, projectInstructions }: InitializeMemoryOptions): Promise<void> {
    this.attachSessionFilePath(sessionFilePath);

    await Promise.all([
      fs.mkdir(path.dirname(this.requiredSessionMemoryPath()), { recursive: true }),
      fs.mkdir(path.dirname(this.projectMemoryPath), { recursive: true }),
      fs.mkdir(path.dirname(this.failureMemoryPath), { recursive: true }),
      fs.mkdir(path.dirname(this.userMemoryPath), { recursive: true }),
    ]);

    await Promise.all([
      this.ensureScopeFile("session"),
      this.ensureScopeFile("project"),
      this.ensureScopeFile("failure"),
      this.ensureScopeFile("user"),
    ]);

    await this.remember({
      scope: "project",
      key: "workspace-root",
      kind: "semantic",
      source: "workspace",
      confidence: 1,
      importance: 0.8,
      text: `Workspace root: ${this.config.cwd}`,
      summary: `Workspace root is ${this.config.cwd}`,
    });
  }

  attachSessionFilePath(sessionFilePath: string): void {
    const sessionId = path.basename(sessionFilePath, ".jsonl");
    this.sessionMemoryPath = path.join(
      this.config.projectStateDir,
      "memory",
      "sessions",
      `${sessionId}.json`,
    );
  }

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const scope = normalizeScope(input.scope);
    const kind = normalizeKind(input.kind ?? DEFAULT_SCOPE_KIND[scope]);
    const text = `${input.text ?? ""}`.trim();
    if (!text) {
      throw new Error("Memory text must not be empty.");
    }

    const now = new Date().toISOString();
    const items = await this.loadScope(scope);
    const existingIndex = findExistingMemoryIndex(items, input, text);

    const previous = existingIndex === -1 ? null : items[existingIndex];
    const nextItem: MemoryRecord = {
      id: previous?.id ?? crypto.randomUUID().slice(0, 12),
      key: typeof input.key === "string" && input.key.trim() ? input.key.trim() : null,
      scope,
      kind,
      source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : "manual",
      text,
      summary: abbreviate(
        `${input.summary?.trim() || summarizeMemoryText(text)}`,
        400,
      ),
      tags: normalizeTags(input.tags),
      confidence: clampScore(input.confidence, 0.7),
      importance: clampScore(input.importance, defaultImportanceFor(scope, kind)),
      sourceCertainty: clampScore(input.sourceCertainty, inferSourceCertainty(input.source)),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastVerifiedAt: input.lastVerifiedAt || now,
      expiresAt: normalizeExpiry(input.expiresAt, input.expiresInDays),
      status: input.status === "invalidated" ? "invalidated" : "active",
      hits: previous?.hits ?? 0,
    };

    if (existingIndex === -1) {
      items.push(nextItem);
    } else {
      items[existingIndex] = {
        ...items[existingIndex],
        ...nextItem,
      };
    }

    await this.saveScope(scope, items);
    return nextItem;
  }

  async forget({ scope, id }: { scope: MemoryScope; id: string }): Promise<boolean> {
    const normalizedScope = normalizeScope(scope);
    const items = await this.loadScope(normalizedScope);
    const target = items.find((item) => item.id === id);
    if (!target) {
      return false;
    }

    target.status = "invalidated";
    target.updatedAt = new Date().toISOString();
    await this.saveScope(normalizedScope, items);
    return true;
  }

  /**
   * Forget memories by key. If a key is provided, invalidate all active
   * memories in the given scope that match the key.
   */
  async forgetByKey(scope: MemoryScope, key: string): Promise<number> {
    const normalizedScope = normalizeScope(scope);
    const items = await this.loadScope(normalizedScope);
    let count = 0;
    const now = new Date().toISOString();
    for (const item of items) {
      if (item.status === "invalidated") continue;
      if (item.key === key) {
        item.status = "invalidated";
        item.updatedAt = now;
        count += 1;
      }
    }
    if (count > 0) {
      await this.saveScope(normalizedScope, items);
    }
    return count;
  }

  /**
   * Merge similar episodic memories in a scope to reduce redundancy.
   * Two episodic memories are considered similar if:
   *   - They share the same source
   *   - Their token overlap exceeds the similarity threshold (0.6)
   *   - They are both active
   * When merged, the older memory is invalidated and the newer one absorbs
   * the older's text (appended), tags (unioned), and hits (summed).
   */
  async mergeSimilarMemories(
    scope: MemoryScope,
    options: {
      similarityThreshold?: number;
      maxMerges?: number;
    } = {},
  ): Promise<{
    mergedCount: number;
    details: Array<{ survivorId: string; consumedId: string; similarity: number }>;
  }> {
    const threshold = clampScore(options.similarityThreshold, 0.55) || 0.6;
    const maxMerges = clampInteger(options.maxMerges, 1, 50, 10);
    const normalizedScope = normalizeScope(scope);
    const items = await this.loadScope(normalizedScope);
    const active = items.filter((item) => item.status === "invalidated" ? false : item.kind === "episodic");
    const mergedDetails: Array<{ survivorId: string; consumedId: string; similarity: number }> = [];

    const consumed = new Set<string>();
    for (let i = 0; i < active.length && mergedDetails.length < maxMerges; i++) {
      if (consumed.has(active[i].id)) continue;
      for (let j = i + 1; j < active.length && mergedDetails.length < maxMerges; j++) {
        if (consumed.has(active[j].id)) continue;
        if (active[i].source !== active[j].source) continue;

        const similarity = computeTextOverlap(active[i].text, active[j].text);
        if (similarity >= threshold) {
          const [survivor, consumedItem] = compareIso(active[i].updatedAt, active[j].updatedAt) >= 0
            ? [active[j], active[i]]
            : [active[i], active[j]];

          const survivorRecord = items.find((item) => item.id === survivor.id);
          const consumedRecord = items.find((item) => item.id === consumedItem.id);
          if (!survivorRecord || !consumedRecord) continue;

          survivorRecord.text = `${survivorRecord.text}\n[merged from ${consumedRecord.id}]: ${abbreviate(consumedRecord.text, 400)}`;
          survivorRecord.summary = `${survivorRecord.summary} + ${consumedRecord.summary}`;
          survivorRecord.tags = normalizeTags([...(survivorRecord.tags ?? []), ...(consumedRecord.tags ?? [])]);
          survivorRecord.hits = (survivorRecord.hits ?? 0) + (consumedRecord.hits ?? 0);
          survivorRecord.updatedAt = new Date().toISOString();
          survivorRecord.importance = Math.max(survivorRecord.importance, consumedRecord.importance);

          consumedRecord.status = "invalidated";
          consumedRecord.updatedAt = new Date().toISOString();
          consumed.add(consumedRecord.id);

          mergedDetails.push({
            survivorId: survivor.id,
            consumedId: consumedItem.id,
            similarity,
          });
        }
      }
    }

    if (mergedDetails.length > 0) {
      await this.saveScope(normalizedScope, items);
    }

    return { mergedCount: mergedDetails.length, details: mergedDetails };
  }

  /**
   * Prune expired and long-stale memories to keep the store lean.
   * Invalidated memories older than pruneAfterDays are permanently removed.
   */
  async pruneStaleMemories(
    scope: MemoryScope,
    options: {
      pruneAfterDays?: number;
    } = {},
  ): Promise<{
    prunedCount: number;
  }> {
    const pruneAfterDays = clampInteger(options.pruneAfterDays, 1, 365, 30);
    const normalizedScope = normalizeScope(scope);
    const items = await this.loadScope(normalizedScope);
    const now = Date.now();
    const cutoffMs = pruneAfterDays * 24 * 60 * 60 * 1000;

    const remaining: MemoryRecord[] = [];
    let prunedCount = 0;
    for (const item of items) {
      const ageMs = now - Date.parse(item.updatedAt || item.createdAt || "0");
      const shouldPrune =
        (item.status === "invalidated" && ageMs > cutoffMs) ||
        (isExpired(item, now) && ageMs > cutoffMs);
      if (shouldPrune) {
        prunedCount += 1;
      } else {
        remaining.push(item);
      }
    }

    if (prunedCount > 0) {
      await this.saveScope(normalizedScope, remaining);
    }

    return { prunedCount };
  }

  async search(query: string, options: SearchOptions = {}): Promise<MemorySearchResult[]> {
    const searchText = `${query ?? ""}`.trim();
    if (!searchText) {
      return [];
    }

    const scopes = normalizeScopeList(options.scopes);
    const limit = clampInteger(options.limit, 1, 20, 8);
    const now = Date.now();
    const candidates: MemorySearchResult[] = [];

    for (const scope of scopes) {
      const items = await this.loadScope(scope);
      for (const item of items) {
        if (isExpired(item, now) || item.status === "invalidated") {
          continue;
        }

        const scoreBreakdown = scoreMemoryItem(item, searchText, now);
        if (scoreBreakdown.relevance <= 0 || scoreBreakdown.total <= 0.05) {
          continue;
        }

        candidates.push({
          ...item,
          score: Number(scoreBreakdown.total.toFixed(4)),
          scoreBreakdown,
        });
      }
    }

    const results = candidates
      .sort((left, right) => right.score - left.score || compareIso(right.updatedAt, left.updatedAt))
      .slice(0, limit);

    // Batch hit increment: group by scope to minimize I/O
    const scopeUpdates = new Map<MemoryScope, Map<string, number>>();
    for (const item of results) {
      if (!scopeUpdates.has(item.scope)) {
        scopeUpdates.set(item.scope, new Map());
      }
      const idMap = scopeUpdates.get(item.scope)!;
      idMap.set(item.id, (idMap.get(item.id) ?? 0) + 1);
    }

    for (const [scope, idMap] of scopeUpdates) {
      const items = await this.loadScope(scope);
      let dirty = false;
      for (const [id, increment] of idMap) {
        const target = items.find((entry) => entry.id === id);
        if (target) {
          target.hits = (target.hits ?? 0) + increment;
          dirty = true;
        }
      }
      if (dirty) {
        await this.saveScope(scope, items);
      }
    }

    return results;
  }

  async getContextPack(query: string, options: ContextPackOptions = {}): Promise<MemoryContextPack> {
    const maxTokens = clampInteger(options.maxTokens, 120, 4000, 1200);
    const limit = clampInteger(options.limit, 1, 16, 8);
    const results = await this.search(query, {
      scopes: options.scopes,
      limit,
    });

    const lines: string[] = [];
    let usedTokens = 0;

    for (const item of results) {
      const line = formatMemoryLine(item);
      const lineTokens = estimateRoughTokens(line);
      if (usedTokens + lineTokens > maxTokens) {
        break;
      }

      lines.push(line);
      usedTokens += lineTokens;
    }

    return {
      items: results,
      usedTokens,
      text: lines.join("\n"),
    };
  }

  async listSnapshot(): Promise<MemorySnapshot> {
    const scopes: MemoryScope[] = ["session", "project", "user", "failure"];
    const counts = {
      session: 0,
      project: 0,
      user: 0,
      failure: 0,
    };
    const latest: MemorySnapshot["latest"] = {
      session: [],
      project: [],
      user: [],
      failure: [],
    };

    for (const scope of scopes) {
      const items = (await this.loadScope(scope))
        .filter((item) => item.status !== "invalidated")
        .sort((left, right) => compareIso(right.updatedAt, left.updatedAt));
      counts[scope] = items.length;
      latest[scope] = items.slice(0, 5).map((item) => ({
        id: item.id,
        kind: item.kind,
        summary: item.summary,
        source: item.source,
        confidence: item.confidence,
        updatedAt: item.updatedAt,
      }));
    }

    return {
      counts,
      paths: {
        session: this.sessionMemoryPath,
        project: this.projectMemoryPath,
        user: this.userMemoryPath,
        failure: this.failureMemoryPath,
      },
      latest,
    };
  }

  async recordTurn({
    userInput,
    assistantOutput,
    toolEvents = [],
    success = true,
    stopped = false,
  }: RecordTurnOptions): Promise<MemoryRecord[]> {
    const toolNames = [...new Set(toolEvents.map((event) => event.tool).filter(Boolean))] as string[];
    const touchedPaths = [...new Set(
      toolEvents.flatMap((event) => extractPathsFromToolEvent(event)).filter(Boolean),
    )];

    const summaryParts = [`Task: ${summarizeMemoryText(userInput)}`];
    if (toolNames.length > 0) {
      summaryParts.push(`Tools: ${toolNames.join(", ")}`);
    }
    if (touchedPaths.length > 0) {
      summaryParts.push(`Files: ${touchedPaths.slice(0, 4).join(", ")}`);
    }
    summaryParts.push(`Outcome: ${success && !stopped ? "completed" : "incomplete"}`);

    const saved: MemoryRecord[] = [];
    saved.push(await this.remember({
      scope: "session",
      kind: "episodic",
      source: "agent-turn",
      confidence: success ? 0.92 : 0.78,
      importance: success ? 0.55 : 0.72,
      text: [
        `User request: ${abbreviate(userInput, 1200)}`,
        `Assistant outcome: ${abbreviate(assistantOutput || "No final answer.", 1200)}`,
        toolNames.length > 0 ? `Tools used: ${toolNames.join(", ")}` : null,
        touchedPaths.length > 0 ? `Touched files: ${touchedPaths.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
      summary: summaryParts.join(" | "),
      tags: [...toolNames, ...touchedPaths.map((value) => path.basename(value))],
    }));

    if (!success || stopped) {
      saved.push(await this.remember({
        scope: "failure",
        kind: "episodic",
        source: "agent-failure",
        confidence: 0.9,
        importance: 0.82,
        text: [
          `User request: ${abbreviate(userInput, 1200)}`,
          `Failure detail: ${abbreviate(assistantOutput || "The run stopped before finishing.", 1200)}`,
          toolNames.length > 0 ? `Observed tools: ${toolNames.join(", ")}` : null,
        ].filter(Boolean).join("\n"),
        summary: `Failure: ${summarizeMemoryText(userInput)}`,
        tags: ["failure", ...toolNames],
      }));
    }

    // Auto-merge similar episodic memories to prevent unbounded growth
    try {
      await this.mergeSimilarMemories("session", { similarityThreshold: 0.65, maxMerges: 3 });
    } catch {
      // Merge is best-effort; failures should not break the turn
    }

    return saved;
  }

  async loadScope(scope: MemoryScope): Promise<MemoryRecord[]> {
    const normalizedScope = normalizeScope(scope);
    if (this.cache.has(normalizedScope)) {
      return this.cache.get(normalizedScope)!;
    }

    const filePath = this.getScopePath(normalizedScope);
    const raw = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return "[]";
      }
      throw error;
    });
    const items = JSON.parse(raw) as unknown;
    this.cache.set(normalizedScope, Array.isArray(items) ? items as MemoryRecord[] : []);
    return this.cache.get(normalizedScope)!;
  }

  async saveScope(scope: MemoryScope, items: MemoryRecord[]): Promise<void> {
    const normalizedScope = normalizeScope(scope);
    const filePath = this.getScopePath(normalizedScope);
    const stableItems = [...items].sort((left, right) => compareIso(right.updatedAt, left.updatedAt));
    this.cache.set(normalizedScope, stableItems);
    await fs.writeFile(filePath, `${JSON.stringify(stableItems, null, 2)}\n`);
  }

  async ensureScopeFile(scope: MemoryScope): Promise<void> {
    const filePath = this.getScopePath(scope);
    await fs.access(filePath).catch(async () => {
      await fs.writeFile(filePath, "[]\n");
    });
  }

  getScopePath(scope: MemoryScope): string {
    const normalizedScope = normalizeScope(scope);
    if (normalizedScope === "session") {
      return this.requiredSessionMemoryPath();
    }

    if (normalizedScope === "project") {
      return this.projectMemoryPath;
    }

    if (normalizedScope === "failure") {
      return this.failureMemoryPath;
    }

    return this.userMemoryPath;
  }

  private requiredSessionMemoryPath(): string {
    if (!this.sessionMemoryPath) {
      throw new Error("Session memory path is not initialized yet.");
    }
    return this.sessionMemoryPath;
  }
}

function normalizeScope(scope: MemoryScope | string | null | undefined): MemoryScope {
  const value = `${scope ?? ""}`.trim().toLowerCase() as MemoryScope;
  if (!SUPPORTED_SCOPES.has(value)) {
    throw new Error(`Unsupported memory scope "${scope}".`);
  }
  return value;
}

function normalizeKind(kind: MemoryKind | string | null | undefined): MemoryKind {
  const value = `${kind ?? ""}`.trim().toLowerCase() as MemoryKind;
  if (!SUPPORTED_KINDS.has(value)) {
    throw new Error(`Unsupported memory kind "${kind}".`);
  }
  return value;
}

function normalizeScopeList(scopes: MemoryScope[] | undefined): MemoryScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return ["session", "project", "user", "failure"];
  }

  return [...new Set(scopes.map((scope) => normalizeScope(scope)))];
}

function normalizeTags(tags: unknown[] | undefined): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  return [...new Set(
    tags
      .map((tag) => `${tag ?? ""}`.trim())
      .filter(Boolean)
      .slice(0, 12),
  )];
}

function normalizeExpiry(expiresAt: string | null | undefined, expiresInDays: number | null | undefined): string | null {
  if (typeof expiresAt === "string" && expiresAt.trim()) {
    return expiresAt;
  }

  if (expiresInDays == null) {
    return null;
  }

  const days = Number(expiresInDays);
  if (!Number.isFinite(days) || days <= 0) {
    return null;
  }

  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isExpired(item: MemoryRecord, now: number): boolean {
  if (!item.expiresAt) {
    return false;
  }

  return Date.parse(item.expiresAt) <= now;
}

function findExistingMemoryIndex(items: MemoryRecord[], input: RememberInput, text: string): number {
  const key = typeof input.key === "string" && input.key.trim() ? input.key.trim() : null;
  const normalizedText = normalizeMemoryText(text);

  return items.findIndex((item) => {
    if (item.status === "invalidated") {
      return false;
    }

    if (key && item.key === key) {
      return true;
    }

    return normalizeMemoryText(item.text) === normalizedText;
  });
}

function summarizeMemoryText(text: string): string {
  const compact = `${text ?? ""}`.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) {
    return compact;
  }

  return `${compact.slice(0, 117)}...`;
}

function normalizeMemoryText(text: string): string {
  return `${text ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function defaultImportanceFor(scope: MemoryScope, kind: MemoryKind): number {
  const scopeWeight: Record<MemoryScope, number> = {
    session: 0.55,
    project: 0.8,
    user: 0.92,
    failure: 0.86,
  };
  const kindBoost: Record<MemoryKind, number> = {
    episodic: 0,
    semantic: 0.05,
    policy: 0.08,
  };
  return clampScore((scopeWeight[scope] ?? 0.6) + (kindBoost[kind] ?? 0), 0.7);
}

function inferSourceCertainty(source: string | null | undefined): number {
  const value = `${source ?? ""}`.toLowerCase();
  if (value.includes("tool") || value.includes("workspace") || value.includes("agent-turn")) {
    return 0.92;
  }

  if (value.includes("mj.md")) {
    return 0.96;
  }

  return 0.72;
}

function scoreMemoryItem(item: MemoryRecord, query: string, now: number) {
  const expandedQuery = expandQueryWithSynonyms(query);
  const relevance = computeTextOverlap(expandedQuery, [
    item.summary,
    item.text,
    item.source,
    ...(item.tags ?? []),
  ].join(" "));
  const rawImportance = clampScore(item.importance, 0.6);
  const importance = applyImportanceDecay(rawImportance, item, now);
  const certainty = clampScore(
    ((item.confidence ?? 0.7) * 0.6) + ((item.sourceCertainty ?? 0.7) * 0.4),
    0.7,
  );
  const recency = computeRecencyScore(item.updatedAt, now);
  const hitBoost = computeHitBoost(item.hits ?? 0);

  return {
    importance,
    recency,
    relevance,
    certainty,
    total: (importance * 0.30) + (recency * 0.15) + (relevance * 0.35) + (certainty * 0.12) + (hitBoost * 0.08),
  };
}

/**
 * Apply time-based importance decay.
 * Episodic memories decay faster than semantic/policy memories.
 * Failure memories decay slowest (they're important to remember).
 * Decay half-life: episodic=7d, semantic=30d, policy=60d, failure=45d
 */
function applyImportanceDecay(rawImportance: number, item: MemoryRecord, now: number): number {
  const halfLifeDays: Record<MemoryKind, number> = {
    episodic: 7,
    semantic: 30,
    policy: 60,
  };
  const scopeModifier: Record<MemoryScope, number> = {
    session: 0.85,
    project: 1.0,
    user: 1.1,
    failure: 1.2,
  };

  const ageMs = Math.max(0, now - Date.parse(item.updatedAt || item.createdAt || "0"));
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const halfLife = (halfLifeDays[item.kind] ?? 14) * (scopeModifier[item.scope] ?? 1.0);
  const decayFactor = Math.exp(-0.693 * ageDays / halfLife);

  return clampScore(rawImportance * (0.4 + 0.6 * decayFactor), 0.3);
}

/**
 * Frequently accessed memories get a small relevance boost.
 * This helps surface well-established patterns and user preferences.
 */
function computeHitBoost(hits: number): number {
  if (hits <= 0) return 0;
  // Logarithmic scaling: first hit is biggest, diminishing returns
  return Math.min(0.3, Math.log2(hits + 1) * 0.08);
}

/**
 * Expand a search query with synonymous terms to improve recall.
 * This helps when the user uses different wording than what's stored.
 */
function expandQueryWithSynonyms(query: string): string {
  const synonymGroups: string[][] = [
    ["edit", "modify", "change", "update", "write", "patch", "fix", "alter"],
    ["bug", "error", "issue", "problem", "defect", "fault", "failure", "crash"],
    ["refactor", "restructure", "reorganize", "rewrite", "clean", "improve"],
    ["test", "spec", "verify", "validate", "check", "assert"],
    ["config", "configuration", "setting", "preference", "option", "env"],
    ["deploy", "release", "publish", "ship", "build"],
    ["debug", "diagnose", "troubleshoot", "investigate", "trace"],
    ["install", "setup", "init", "bootstrap", "configure"],
    ["delete", "remove", "rm", "drop", "uninstall", "clean"],
    ["create", "add", "new", "init", "generate", "scaffold"],
    ["search", "find", "grep", "lookup", "query", "locate"],
    ["perform", "run", "execute", "launch", "start"],
    ["\u4ee3\u7801", "\u7f16\u8f91", "\u4fee\u6539", "\u4ee3\u7801\u7f16\u8f91", "\u6539\u4ee3\u7801", "\u5199\u4ee3\u7801"],
    ["\u9519\u8bef", "bug", "\u6545\u969c", "\u62a5\u9519", "\u5f02\u5e38", "\u5d29\u6e83"],
    ["\u91cd\u6784", "\u6574\u7406", "\u4f18\u5316", "\u6539\u8fdb"],
    ["\u6d4b\u8bd5", "\u9a8c\u8bc1", "\u68c0\u67e5"],
    ["\u914d\u7f6e", "\u8bbe\u7f6e", "\u73af\u5883", "\u9009\u9879"],
    ["\u90e8\u7f72", "\u53d1\u5e03", "\u4e0a\u7ebf"],
    ["\u8c03\u8bd5", "\u6392\u67e5", "\u8bca\u65ad", "\u8ddf\u8e2a"],
  ];

  const queryLower = query.toLowerCase();
  const expandedTerms: string[] = [];

  for (const group of synonymGroups) {
    const matched = group.some((term) => queryLower.includes(term.toLowerCase()));
    if (matched) {
      expandedTerms.push(...group);
    }
  }

  if (expandedTerms.length === 0) {
    return query;
  }

  return `${query} ${[...new Set(expandedTerms)].join(" ")}`;
}

function computeTextOverlap(query: string, text: string): number {
  const tokenScore = computeTokenOverlap(query, text);
  const trigramScore = computeTrigramOverlap(query, text);
  const prefixScore = computePrefixOverlap(query, text);

  // Take the best score from all three strategies
  // This ensures fuzzy matches (trigram/prefix) can rescue poor exact matches
  return Math.max(tokenScore, trigramScore * 0.88, prefixScore * 0.75);
}

function computeTokenOverlap(query: string, text: string): number {
  const queryTokens = tokenize(query);
  const textTokens = new Set(tokenize(text));
  if (queryTokens.length === 0 || textTokens.size === 0) {
    return 0;
  }

  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      hits += 1;
    }
  }

  return hits / queryTokens.length;
}

/**
 * Trigram-based fuzzy matching. Robust against typos and partial word matches.
 * "conciise" matches "concise" because they share many trigrams.
 */
function computeTrigramOverlap(query: string, text: string): number {
  const queryTrigrams = extractTrigrams(normalizeForNgram(query));
  const textTrigrams = new Set(extractTrigrams(normalizeForNgram(text)));
  if (queryTrigrams.length === 0 || textTrigrams.size === 0) {
    return 0;
  }

  let hits = 0;
  for (const trigram of queryTrigrams) {
    if (textTrigrams.has(trigram)) {
      hits += 1;
    }
  }

  return hits / queryTrigrams.length;
}

/**
 * Prefix-based matching. "conc" matches "concise", "conf" matches "config".
 * Useful for short queries that are prefixes of stored terms.
 */
function computePrefixOverlap(query: string, text: string): number {
  const queryTokens = tokenize(query);
  const textTokens = tokenize(text);
  if (queryTokens.length === 0 || textTokens.length === 0) {
    return 0;
  }

  let hits = 0;
  for (const qToken of queryTokens) {
    for (const tToken of textTokens) {
      if (tToken.startsWith(qToken) || qToken.startsWith(tToken)) {
        hits += 1;
        break;
      }
    }
  }

  return hits / queryTokens.length;
}

function extractTrigrams(text: string): string[] {
  if (text.length < 3) {
    return text.length > 0 ? [text] : [];
  }
  const trigrams: string[] = [];
  for (let i = 0; i <= text.length - 3; i++) {
    trigrams.push(text.slice(i, i + 3));
  }
  return trigrams;
}

function normalizeForNgram(text: string): string {
  // Preserve CJK characters alongside alphanumeric for n-gram matching
  return `${text ?? ""}`.toLowerCase().replace(/[^\w\u3400-\u4dbf\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, "");
}

function tokenize(text: string): string[] {
  const raw = `${text ?? ""}`.toLowerCase();
  const tokens: string[] = [];

  // Extract CJK character sequences (Chinese, Japanese, Korean)
  const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g;
  let cjkMatch: RegExpExecArray | null;
  while ((cjkMatch = cjkPattern.exec(raw)) !== null) {
    const segment = cjkMatch[0];
    for (const char of segment) {
      tokens.push(char);
    }
    for (let i = 0; i < segment.length - 1; i++) {
      tokens.push(segment.slice(i, i + 2));
    }
  }

  // Extract alphanumeric tokens
  const alphaTokens = raw
    .split(/[^\w./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  tokens.push(...alphaTokens);

  return [...new Set(tokens)];
}

function computeRecencyScore(updatedAt: string, now: number): number {
  const ageMs = Math.max(0, now - Date.parse(updatedAt || "0"));
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  // Half-life of 14 days for recency score
  return clampScore(Math.exp(-ageDays / 14), 0.3);
}



function extractPathsFromToolEvent(event: ToolEvent): string[] {
  const result = event?.result;
  if (!result || typeof result !== "object") {
    return [];
  }

  const paths: string[] = [];
  if (typeof result.path === "string") {
    paths.push(result.path);
  }

  if (Array.isArray(result.paths)) {
    paths.push(...result.paths.filter((value): value is string => typeof value === "string"));
  }

  return paths;
}

function formatMemoryLine(item: MemorySearchResult): string {
  const tags = Array.isArray(item.tags) && item.tags.length > 0 ? ` tags=${item.tags.join(",")}` : "";
  return `- [${item.scope}/${item.kind}] ${item.summary} | source=${item.source} | confidence=${item.confidence.toFixed(2)} | score=${item.score?.toFixed(2) ?? "n/a"}${tags}`;
}

function estimateRoughTokens(text: string): number {
  return Math.max(1, Math.ceil(`${text ?? ""}`.length / 4));
}

function clampScore(value: number | null | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, parsed));
}

function clampInteger(
  value: number | null | undefined,
  minValue: number,
  maxValue: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minValue, Math.min(maxValue, Math.floor(parsed)));
}

function compareIso(left: string | null | undefined, right: string | null | undefined): number {
  return Date.parse(left || "0") - Date.parse(right || "0");
}
