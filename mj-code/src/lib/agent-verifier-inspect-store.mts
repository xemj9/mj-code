import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  VerifierBaselinePromotionApprovalRecord,
  VerifierBaselinePromotionCandidate,
  VerifierBaselinePromotionDecision,
  VerifierInspectBaselineList,
  VerifierInspectBaselineMetadata,
  VerifierInspectBaselinePromotionRecord,
  VerifierInspectBaselineRecord,
  VerifierInspectBaselineResolution,
  VerifierInspectReference,
  VerifierInspectSnapshotList,
  VerifierInspectSnapshotMetadata,
  VerifierInspectSnapshotRecord,
  VerifierRegressionGatePolicyProfileId,
} from "../types/contracts.js";

import {
  createVerifierInspectBaselineMetadata,
  createVerifierInspectResolvedReference,
  createVerifierInspectSnapshotMetadata,
} from "./agent-verifier-inspect.mjs";

export const VERIFIER_INSPECT_SNAPSHOT_DIRNAME = "verifier-inspect";
export const VERIFIER_INSPECT_BASELINE_DIRNAME = "baselines";

export class VerifierInspectSnapshotStore {
  readonly projectStateDir: string;
  readonly snapshotDir: string;
  readonly baselineDir: string;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.snapshotDir = path.join(projectStateDir, VERIFIER_INSPECT_SNAPSHOT_DIRNAME);
    this.baselineDir = path.join(this.snapshotDir, VERIFIER_INSPECT_BASELINE_DIRNAME);
  }

  async exportSnapshot(input: {
    source: VerifierInspectSnapshotMetadata["source"];
    report: VerifierInspectSnapshotRecord["report"];
  }): Promise<VerifierInspectSnapshotRecord> {
    await fs.mkdir(this.snapshotDir, { recursive: true });
    const snapshotId = createSnapshotId();
    const createdAt = new Date().toISOString();
    const metadata = createVerifierInspectSnapshotMetadata({
      snapshotId,
      createdAt,
      source: input.source,
      report: input.report,
    });
    const record: VerifierInspectSnapshotRecord = {
      metadata,
      report: structuredClone(input.report),
    };
    await fs.writeFile(
      this.getSnapshotPath(snapshotId),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    return record;
  }

  async listSnapshots(limit = 20): Promise<VerifierInspectSnapshotList> {
    await fs.mkdir(this.snapshotDir, { recursive: true });
    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const snapshots = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readSnapshotFromPath(path.join(this.snapshotDir, entry.name))),
    );
    const items = snapshots
      .map((entry) => entry.metadata)
      .sort(compareSnapshotMetadataNewestFirst);
    return {
      total: items.length,
      items: items.slice(0, limit),
    };
  }

  async pinBaseline(input: {
    name: string;
    snapshot: VerifierInspectSnapshotRecord;
    policyProfileId?: VerifierRegressionGatePolicyProfileId | null;
  }, options: {
    planId?: string | null;
    candidate?: VerifierBaselinePromotionCandidate | null;
    decision?: VerifierBaselinePromotionDecision | null;
    approval?: VerifierBaselinePromotionApprovalRecord | null;
  } = {}): Promise<{
    baseline: VerifierInspectBaselineRecord;
    promotion: VerifierInspectBaselinePromotionRecord | null;
  }> {
    const name = normalizeBaselineName(input.name);
    if (!name) {
      throw new Error("Missing verifier baseline name.");
    }
    await fs.mkdir(this.baselineDir, { recursive: true });
    const existing = await this.loadBaseline({ kind: "baseline", reference: name }).catch(() => null);
    const policyProfileId = input.policyProfileId ?? existing?.metadata.policyProfileId ?? "default";
    if (
      existing &&
      existing.metadata.snapshotId === input.snapshot.metadata.snapshotId &&
      existing.metadata.policyProfileId === policyProfileId
    ) {
      return {
        baseline: structuredClone(existing),
        promotion: null,
      };
    }
    const updatedAt = new Date().toISOString();
    const metadata = createVerifierInspectBaselineMetadata({
      baselineId: existing?.metadata.baselineId ?? createBaselineId(name),
      name,
      createdAt: existing?.metadata.createdAt ?? updatedAt,
      updatedAt,
      snapshotId: input.snapshot.metadata.snapshotId,
      policyProfileId,
      source: input.snapshot.metadata.source,
      report: input.snapshot.report,
    });
    const promotion = existing
      ? createBaselinePromotionRecord({
          updatedAt,
          existing,
          snapshot: input.snapshot,
          policyProfileId,
          planId: options.planId ?? null,
          candidate: options.candidate ?? null,
          decision: options.decision ?? null,
          approval: options.approval ?? null,
        })
      : null;
    const record: VerifierInspectBaselineRecord = {
      metadata: {
        ...metadata,
        promotionCount: existing
          ? existing.metadata.promotionCount + (promotion ? 1 : 0)
          : 0,
        latestPromotionId: promotion?.promotionId ?? null,
      },
      history: promotion
        ? existing
          ? [promotion, ...existing.history]
          : [promotion]
        : existing?.history.slice() ?? [],
    };
    await fs.writeFile(
      this.getBaselinePath(name),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    return {
      baseline: record,
      promotion,
    };
  }

  async listBaselines(limit = 20): Promise<VerifierInspectBaselineList> {
    await fs.mkdir(this.baselineDir, { recursive: true });
    const entries = await fs.readdir(this.baselineDir, { withFileTypes: true });
    const baselines = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readBaselineFromPath(path.join(this.baselineDir, entry.name))),
    );
    const items = baselines
      .map((entry) => entry.metadata)
      .sort(compareBaselineMetadataNewestFirst);
    return {
      total: items.length,
      items: items.slice(0, limit),
    };
  }

  async loadSnapshot(reference: string | VerifierInspectReference): Promise<VerifierInspectSnapshotRecord> {
    const normalized = normalizeSnapshotReference(reference);
    const snapshotId = await this.resolveSnapshotId(normalized);
    return this.readSnapshotFromPath(this.getSnapshotPath(snapshotId));
  }

  async loadBaseline(reference: string | VerifierInspectReference): Promise<VerifierInspectBaselineRecord> {
    const baselineName = await this.resolveBaselineName(reference);
    return this.readBaselineFromPath(this.getBaselinePath(baselineName));
  }

  async resolveBaseline(reference: string | VerifierInspectReference): Promise<VerifierInspectBaselineResolution> {
    const baseline = await this.loadBaseline(reference);
    const snapshot = await this.loadSnapshot(baseline.metadata.snapshotId);
    return {
      baseline,
      snapshot,
      reference: createVerifierInspectResolvedReference({
        kind: "baseline",
        reference: baseline.metadata.name,
        scope: snapshot.report.scope,
        sessionId: snapshot.report.sessionId,
        traceId: snapshot.report.traceId,
        replayReference: baseline.metadata.source.replayReference,
        snapshotId: baseline.metadata.snapshotId,
        baselineName: baseline.metadata.name,
      }),
      report: structuredClone(snapshot.report),
    };
  }

  async resolveSnapshotId(reference: string | VerifierInspectReference): Promise<string> {
    const normalized = normalizeSnapshotReference(reference);
    if (!normalized) {
      throw new Error("Missing verifier snapshot reference.");
    }
    await fs.mkdir(this.snapshotDir, { recursive: true });
    const directPath = this.getSnapshotPath(normalized);
    try {
      await fs.access(directPath);
      return normalized;
    } catch {}

    const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.basename(entry.name, ".json"))
      .filter((entry) => entry === normalized || entry.startsWith(normalized));
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(`Could not resolve verifier snapshot "${normalized}".`);
  }

  getSnapshotPath(snapshotId: string): string {
    return path.join(this.snapshotDir, `${snapshotId}.json`);
  }

  getBaselinePath(name: string): string {
    return path.join(this.baselineDir, `${encodeURIComponent(name)}.json`);
  }

  private async readSnapshotFromPath(filePath: string): Promise<VerifierInspectSnapshotRecord> {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeSnapshotRecord(payload, path.basename(filePath, ".json"));
  }

  private async readBaselineFromPath(filePath: string): Promise<VerifierInspectBaselineRecord> {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const fallbackName = decodeURIComponent(path.basename(filePath, ".json"));
    return normalizeBaselineRecord(payload, fallbackName);
  }

  private async resolveBaselineName(reference: string | VerifierInspectReference): Promise<string> {
    const normalized = normalizeBaselineReference(reference);
    if (!normalized) {
      throw new Error("Missing verifier baseline reference.");
    }
    await fs.mkdir(this.baselineDir, { recursive: true });
    const directPath = this.getBaselinePath(normalized);
    try {
      await fs.access(directPath);
      return normalized;
    } catch {}

    const entries = await fs.readdir(this.baselineDir, { withFileTypes: true });
    const baselines = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readBaselineFromPath(path.join(this.baselineDir, entry.name))),
    );
    const matches = baselines.filter((entry) =>
      entry.metadata.name === normalized
      || entry.metadata.baselineId === normalized
      || entry.metadata.baselineId.startsWith(normalized)
    );
    if (matches.length === 1) {
      return matches[0].metadata.name;
    }
    throw new Error(`Could not resolve verifier baseline "${normalized}".`);
  }
}

function createSnapshotId(): string {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
  return `vis-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function createBaselineId(name: string): string {
  return `vib-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 12)}`;
}

function createBaselinePromotionId(name: string, updatedAt: string): string {
  return `vibp-${crypto.createHash("sha1").update(`${name}:${updatedAt}:${crypto.randomUUID()}`).digest("hex").slice(0, 12)}`;
}

function normalizeSnapshotReference(reference: string | VerifierInspectReference): string {
  if (typeof reference === "string") {
    return reference.trim().replace(/^snapshot:/, "");
  }
  if (reference.kind !== "snapshot") {
    throw new Error(`Expected snapshot reference but received "${reference.kind}".`);
  }
  return `${reference.reference ?? ""}`.trim().replace(/^snapshot:/, "");
}

function normalizeBaselineReference(reference: string | VerifierInspectReference): string {
  if (typeof reference === "string") {
    return normalizeBaselineName(reference.replace(/^baseline:/, ""));
  }
  if (reference.kind !== "baseline") {
    throw new Error(`Expected baseline reference but received "${reference.kind}".`);
  }
  return normalizeBaselineName(reference.reference);
}

function normalizeBaselineName(value: string | null | undefined): string {
  return `${value ?? ""}`.trim();
}

function normalizeSnapshotRecord(
  value: unknown,
  fallbackId: string,
): VerifierInspectSnapshotRecord {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.report)) {
    throw new Error(`Invalid verifier snapshot payload "${fallbackId}".`);
  }
  const metadata = value.metadata;
  const report = value.report;
  if (!isVerifierInspectReport(report)) {
    throw new Error(`Invalid verifier snapshot report "${fallbackId}".`);
  }
  return {
    metadata: {
      snapshotId: toNonEmptyString(metadata.snapshotId) ?? fallbackId,
      createdAt: toNonEmptyString(metadata.createdAt) ?? new Date(0).toISOString(),
      source: normalizeSourceMetadata(metadata.source, report),
      summary: normalizeSummary(report.summary),
    },
    report: structuredClone(report),
  };
}

function normalizeBaselineRecord(
  value: unknown,
  fallbackName: string,
): VerifierInspectBaselineRecord {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    throw new Error(`Invalid verifier baseline payload "${fallbackName}".`);
  }
  const metadata = value.metadata;
  const name = toNonEmptyString(metadata.name) ?? fallbackName;
  const snapshotId = toNonEmptyString(metadata.snapshotId);
  if (!snapshotId) {
    throw new Error(`Invalid verifier baseline snapshot reference "${fallbackName}".`);
  }
  const history = normalizeBaselinePromotionHistory(value.history, {
    fallbackName: name,
    fallbackBaselineId: metadata.baselineId,
    fallbackSnapshotId: snapshotId,
    fallbackSource: metadata.source,
    fallbackSummary: metadata.summary,
  });
  return {
    metadata: {
      baselineId: toNonEmptyString(metadata.baselineId) ?? createBaselineId(name),
      name,
      createdAt: toNonEmptyString(metadata.createdAt) ?? new Date(0).toISOString(),
      updatedAt: toNonEmptyString(metadata.updatedAt)
        ?? toNonEmptyString(metadata.createdAt)
        ?? new Date(0).toISOString(),
      snapshotId,
      policyProfileId: toNullableString(metadata.policyProfileId),
      source: normalizeSourceMetadata(metadata.source, metadata.summary),
      summary: normalizeSummary(metadata.summary),
      promotionCount: toNonNegativeInteger(metadata.promotionCount) ?? history.length,
      latestPromotionId: toNullableString(metadata.latestPromotionId) ?? history.at(0)?.promotionId ?? null,
    },
    history,
  };
}

function normalizeBaselinePromotionHistory(
  value: unknown,
  input: {
    fallbackName: string;
    fallbackBaselineId: unknown;
    fallbackSnapshotId: string;
    fallbackSource: unknown;
    fallbackSummary: unknown;
  },
): VerifierInspectBaselinePromotionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((entry, index) => ({
      promotionId: toNonEmptyString(entry.promotionId) ?? `vibp-${index}`,
      createdAt: toNonEmptyString(entry.createdAt) ?? new Date(0).toISOString(),
      baselineId: toNonEmptyString(entry.baselineId)
        ?? toNonEmptyString(input.fallbackBaselineId)
        ?? createBaselineId(input.fallbackName),
      name: toNonEmptyString(entry.name) ?? input.fallbackName,
      previousSnapshotId: toNonEmptyString(entry.previousSnapshotId) ?? input.fallbackSnapshotId,
      nextSnapshotId: toNonEmptyString(entry.nextSnapshotId) ?? input.fallbackSnapshotId,
      previousSource: normalizeSourceMetadata(entry.previousSource, input.fallbackSource),
      nextSource: normalizeSourceMetadata(entry.nextSource, input.fallbackSource),
      previousSummary: normalizeSummary(entry.previousSummary ?? input.fallbackSummary),
      nextSummary: normalizeSummary(entry.nextSummary ?? input.fallbackSummary),
      previousPolicyProfileId: toNullableString(entry.previousPolicyProfileId),
      nextPolicyProfileId: toNullableString(entry.nextPolicyProfileId),
      planId: toNullableString(entry.planId),
      candidate: isRecord(entry.candidate)
        ? cloneTyped<VerifierBaselinePromotionCandidate>(entry.candidate)
        : null,
      decision: isRecord(entry.decision)
        ? cloneTyped<VerifierBaselinePromotionDecision>(entry.decision)
        : null,
      approval: isRecord(entry.approval)
        ? cloneTyped<VerifierBaselinePromotionApprovalRecord>(entry.approval)
        : null,
    }))
    .sort((left, right) =>
      compareValue(right.createdAt, left.createdAt)
      || compareValue(right.promotionId, left.promotionId)
    );
}

function createBaselinePromotionRecord(input: {
  updatedAt: string;
  existing: VerifierInspectBaselineRecord;
  snapshot: VerifierInspectSnapshotRecord;
  policyProfileId: VerifierRegressionGatePolicyProfileId | null;
  planId: string | null;
  candidate: VerifierBaselinePromotionCandidate | null;
  decision: VerifierBaselinePromotionDecision | null;
  approval: VerifierBaselinePromotionApprovalRecord | null;
}): VerifierInspectBaselinePromotionRecord {
  return {
    promotionId: createBaselinePromotionId(input.existing.metadata.name, input.updatedAt),
    createdAt: input.updatedAt,
    baselineId: input.existing.metadata.baselineId,
    name: input.existing.metadata.name,
    previousSnapshotId: input.existing.metadata.snapshotId,
    nextSnapshotId: input.snapshot.metadata.snapshotId,
    previousSource: structuredClone(input.existing.metadata.source),
    nextSource: structuredClone(input.snapshot.metadata.source),
    previousSummary: structuredClone(input.existing.metadata.summary),
    nextSummary: structuredClone(input.snapshot.report.summary),
    previousPolicyProfileId: input.existing.metadata.policyProfileId,
    nextPolicyProfileId: input.policyProfileId,
    planId: input.planId,
    candidate: input.candidate ? structuredClone(input.candidate) : null,
    decision: input.decision ? structuredClone(input.decision) : null,
    approval: input.approval ? structuredClone(input.approval) : null,
  };
}

function normalizeSourceMetadata(
  value: unknown,
  sourceFallback: Record<string, unknown> | unknown,
): VerifierInspectSnapshotMetadata["source"] {
  const record = isRecord(value) ? value : {};
  const fallback = isRecord(sourceFallback) ? sourceFallback : {};
  const scope = toScope(record.scope) ?? toScope(fallback.scope) ?? "current";
  const sessionId = toNullableString(record.sessionId) ?? toNullableString(fallback.sessionId);
  const traceId = toNullableString(record.traceId) ?? toNullableString(fallback.traceId);
  const reference = toNullableString(record.reference);
  const replayReference = toNullableString(record.replayReference);
  const snapshotId = toNullableString(record.snapshotId);
  const baselineName = toNullableString(record.baselineName);
  const kind = toReferenceKind(record.kind) ?? "snapshot";
  const label = toNonEmptyString(record.label)
    ?? (kind === "snapshot"
      ? `snapshot:${snapshotId ?? reference ?? "unknown"}`
      : kind === "baseline"
        ? `baseline:${baselineName ?? reference ?? "unknown"}`
      : `${kind}`);
  return {
    kind,
    label,
    reference,
    scope,
    sessionId,
    traceId,
    replayReference,
    snapshotId,
    baselineName,
  };
}

function normalizeSummary(value: unknown): VerifierInspectSnapshotMetadata["summary"] {
  if (!isVerifierInspectSummary(value)) {
    throw new Error("Invalid verifier snapshot summary.");
  }
  return structuredClone(value);
}

function compareSnapshotMetadataNewestFirst(
  left: VerifierInspectSnapshotMetadata,
  right: VerifierInspectSnapshotMetadata,
): number {
  return compareValue(right.createdAt, left.createdAt)
    || compareValue(right.snapshotId, left.snapshotId);
}

function compareBaselineMetadataNewestFirst(
  left: VerifierInspectBaselineMetadata,
  right: VerifierInspectBaselineMetadata,
): number {
  return compareValue(right.updatedAt, left.updatedAt)
    || compareValue(left.name, right.name);
}

function compareValue(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function toScope(value: unknown): VerifierInspectSnapshotMetadata["source"]["scope"] | null {
  return value === "current" || value === "trace" || value === "replay"
    ? value
    : null;
}

function toReferenceKind(value: unknown): VerifierInspectSnapshotMetadata["source"]["kind"] | null {
  return value === "current" || value === "trace" || value === "replay" || value === "snapshot" || value === "baseline"
    ? value
    : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string"
    ? (value.trim() ? value.trim() : null)
    : null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function toNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function cloneTyped<T>(value: unknown): T {
  return structuredClone(value) as T;
}

function isVerifierInspectReport(value: unknown): value is VerifierInspectSnapshotRecord["report"] {
  return isRecord(value)
    && (value.scope === "current" || value.scope === "trace" || value.scope === "replay")
    && Array.isArray(value.verifierRuns)
    && Array.isArray(value.repairLoops)
    && isRecord(value.summary)
    && isVerifierInspectSummary(value.summary);
}

function isVerifierInspectSummary(value: unknown): value is VerifierInspectSnapshotMetadata["summary"] {
  return isRecord(value)
    && typeof value.hasData === "boolean"
    && typeof value.verifierRunCount === "number"
    && typeof value.repairLoopCount === "number"
    && typeof value.finalOutcome === "string";
}
