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

    for (const item of results) {
      const items = await this.loadScope(item.scope);
      const target = items.find((entry) => entry.id === item.id);
      if (target) {
        target.hits = (target.hits ?? 0) + 1;
        await this.saveScope(item.scope, items);
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
  const relevance = computeTextOverlap(query, [
    item.summary,
    item.text,
    item.source,
    ...(item.tags ?? []),
  ].join(" "));
  const importance = clampScore(item.importance, 0.6);
  const certainty = clampScore(
    ((item.confidence ?? 0.7) * 0.6) + ((item.sourceCertainty ?? 0.7) * 0.4),
    0.7,
  );
  const recency = computeRecencyScore(item.updatedAt, now);

  return {
    importance,
    recency,
    relevance,
    certainty,
    total: (importance * 0.35) + (recency * 0.2) + (relevance * 0.3) + (certainty * 0.15),
  };
}

function computeTextOverlap(query: string, text: string): number {
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

function tokenize(text: string): string[] {
  return [...new Set(
    `${text ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  )];
}

function computeRecencyScore(updatedAt: string, now: number): number {
  const ageMs = Math.max(0, now - Date.parse(updatedAt || "0"));
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return clampScore(Math.exp(-ageDays / 14), 0.5);
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
