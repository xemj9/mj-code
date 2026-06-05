import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  WebCacheLookupResult,
  WebCacheNegativeRecord,
  WebCacheOptions,
  WebCachePositiveRecord,
  WebCacheRecord,
} from "../types/contracts.js";

interface WebCacheMetadata {
  ttlMs?: number;
  provider?: string | null;
  query?: string | null;
  url?: string | null;
  hash?: string | null;
}

export interface WebCacheLike<TValue = unknown> {
  initialize(): Promise<void>;
  get(namespace: string, key: string): Promise<WebCacheLookupResult<TValue>>;
  set(
    namespace: string,
    key: string,
    value: TValue,
    metadata?: WebCacheMetadata,
  ): Promise<WebCachePositiveRecord<TValue>>;
  setNegative(
    namespace: string,
    key: string,
    error: unknown,
    metadata?: WebCacheMetadata,
  ): Promise<WebCacheNegativeRecord>;
  buildPath(namespace: string, key: string): string;
  pruneNamespace(namespace: string): Promise<void>;
}

export class WebCache<TValue = unknown> implements WebCacheLike<TValue> {
  readonly projectStateDir: string;
  readonly cacheDir: string;
  readonly defaultTtlMs: number;
  readonly negativeTtlMs: number;
  readonly maxEntriesPerNamespace: number;

  constructor(projectStateDir: string, options: WebCacheOptions = {}) {
    this.projectStateDir = projectStateDir;
    this.cacheDir = options.cacheDir ?? path.join(projectStateDir, "web-cache");
    this.defaultTtlMs = options.defaultTtlMs ?? 60 * 60 * 1000;
    this.negativeTtlMs = options.negativeTtlMs ?? 5 * 60 * 1000;
    this.maxEntriesPerNamespace = options.maxEntriesPerNamespace ?? 200;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async get(namespace: string, key: string): Promise<WebCacheLookupResult<TValue>> {
    await this.initialize();
    const filePath = this.buildPath(namespace, key);

    try {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const normalized = normalizeWebCacheRecord<TValue>(payload, namespace, key);
      if (isExpired(normalized.expiresAt)) {
        await fs.rm(filePath, { force: true });
        return null;
      }

      const nextRecord = {
        ...normalized,
        cacheHitCount: Number(normalized.cacheHitCount ?? 0) + 1,
        lastAccessedAt: new Date().toISOString(),
      } satisfies WebCacheRecord<TValue>;
      await fs.writeFile(filePath, `${JSON.stringify(nextRecord, null, 2)}\n`);

      if (nextRecord.negative) {
        return {
          hit: true,
          negative: true,
          value: null,
          meta: nextRecord,
        };
      }

      return {
        hit: true,
        negative: false,
        value: nextRecord.value,
        meta: nextRecord,
      };
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async set(
    namespace: string,
    key: string,
    value: TValue,
    metadata: WebCacheMetadata = {},
  ): Promise<WebCachePositiveRecord<TValue>> {
    await this.initialize();
    await fs.mkdir(path.join(this.cacheDir, namespace), { recursive: true });
    const now = new Date();
    const ttlMs = Number(metadata.ttlMs ?? this.defaultTtlMs);
    const record: WebCachePositiveRecord<TValue> = {
      namespace,
      keyHash: hashKey(key),
      key,
      negative: false,
      value,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      provider: metadata.provider ?? null,
      query: metadata.query ?? null,
      url: metadata.url ?? null,
      hash: metadata.hash ?? hashValue(value),
      cacheHitCount: 0,
      lastAccessedAt: now.toISOString(),
    };
    await fs.writeFile(this.buildPath(namespace, key), `${JSON.stringify(record, null, 2)}\n`);
    await this.pruneNamespace(namespace);
    return record;
  }

  async setNegative(
    namespace: string,
    key: string,
    error: unknown,
    metadata: WebCacheMetadata = {},
  ): Promise<WebCacheNegativeRecord> {
    await this.initialize();
    await fs.mkdir(path.join(this.cacheDir, namespace), { recursive: true });
    const now = new Date();
    const ttlMs = Number(metadata.ttlMs ?? this.negativeTtlMs);
    const record: WebCacheNegativeRecord = {
      namespace,
      keyHash: hashKey(key),
      key,
      negative: true,
      value: null,
      error,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      provider: metadata.provider ?? null,
      query: metadata.query ?? null,
      url: metadata.url ?? null,
      hash: null,
      cacheHitCount: 0,
      lastAccessedAt: now.toISOString(),
    };
    await fs.writeFile(this.buildPath(namespace, key), `${JSON.stringify(record, null, 2)}\n`);
    await this.pruneNamespace(namespace);
    return record;
  }

  buildPath(namespace: string, key: string): string {
    return path.join(this.cacheDir, namespace, `${hashKey(key)}.json`);
  }

  async pruneNamespace(namespace: string): Promise<void> {
    const targetDir = path.join(this.cacheDir, namespace);
    const entries = await fs.readdir(targetDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });

    const files: Array<{
      filePath: string;
      mtimeMs: number;
    }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(targetDir, entry.name);
      const stat = await fs.stat(filePath);
      files.push({
        filePath,
        mtimeMs: stat.mtimeMs,
      });
    }

    if (files.length <= this.maxEntriesPerNamespace) {
      return;
    }

    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const stale = files.slice(this.maxEntriesPerNamespace);
    await Promise.all(stale.map((entry) => fs.rm(entry.filePath, { force: true })));
  }
}

function normalizeWebCacheRecord<TValue>(
  value: unknown,
  fallbackNamespace: string,
  fallbackKey: string,
): WebCacheRecord<TValue> {
  const record = value && typeof value === "object"
    ? value as Partial<WebCacheRecord<TValue>>
    : {};
  const namespace = typeof record.namespace === "string" ? record.namespace : fallbackNamespace;
  const key = typeof record.key === "string" ? record.key : fallbackKey;
  const base = {
    namespace,
    keyHash: typeof record.keyHash === "string" && record.keyHash ? record.keyHash : hashKey(key),
    key,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : new Date(0).toISOString(),
    provider: normalizeNullableString(record.provider),
    query: normalizeNullableString(record.query),
    url: normalizeNullableString(record.url),
    cacheHitCount: normalizeCount(record.cacheHitCount),
    lastAccessedAt:
      typeof record.lastAccessedAt === "string" ? record.lastAccessedAt : new Date(0).toISOString(),
  };

  if (record.negative === true) {
    return {
      ...base,
      negative: true,
      value: null,
      error: "error" in record ? record.error ?? null : null,
      hash: null,
    };
  }

  return {
    ...base,
    negative: false,
    value: (record.value ?? null) as TValue,
    hash:
      typeof record.hash === "string" && record.hash
        ? record.hash
        : hashValue((record.value ?? null) as TValue),
  };
}

function hashKey(key: string): string {
  return crypto.createHash("sha1").update(`${key ?? ""}`).digest("hex");
}

function hashValue(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value ?? null)).digest("hex");
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isExpired(expiresAt: string): boolean {
  return Boolean(expiresAt) && new Date(expiresAt).getTime() <= Date.now();
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object";
}
