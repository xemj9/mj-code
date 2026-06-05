import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  DiagnosticFingerprint,
  RepairStatus,
  VerifierArtifactUploadMetadata,
  VerifierArtifactWorkflowProvenance,
  VerifierGitHubActionsBackfillInput,
  VerifierInspectArtifactMetadata,
  VerifierInspectArtifactPruneDecision,
  VerifierInspectArtifactPruneResult,
  VerifierInspectArtifactRecord,
  VerifierInspectArtifactRetentionPolicy,
  VerifierInspectBaselinePromotionRecord,
  VerifierInspectBaselineRecord,
  VerifierInspectFinalOutcome,
  VerifierInspectReferenceKind,
  VerifierReleaseBundleFileEntry,
  VerifierReleaseBundleMetadata,
  VerifierReleaseBundleRecord,
  VerifierReleaseHandoffMetadata,
  VerifierReleaseHandoffBlockingDiagnosticSummary,
  VerifierReleaseHandoffRecord,
  VerifierReleaseHandoffReasonKind,
  VerifierReleaseHandoffReasonSeverity,
  VerifierReleaseHandoffReasonSummary,
  VerifierReleaseHandoffSelection,
  VerifierReleaseHandoffSourceKind,
  VerifierReleaseHandoffStatus,
  VerifierReleaseTriageSummary,
  VerifierInspectResolvedReference,
  VerifierInspectScope,
  VerifierInspectValueChange,
  VerifierStatus,
} from "../types/contracts.js";

import {
  createVerifierReleaseHandoffFromArtifactRecord,
  createVerifierReleaseHandoffFromBaselinePromotion,
} from "./agent-verifier-release-handoff.mjs";

import {
  VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
} from "./agent-verifier-inspect-store.mjs";

import {
  VerifierInspectArtifactStore,
} from "./agent-verifier-inspect-artifact-store.mjs";

export const VERIFIER_RELEASE_HANDOFF_DIRNAME = "handoffs";
export const VERIFIER_RELEASE_BUNDLE_DIRNAME = "bundles";

const DEFAULT_RETENTION_MAX_COUNT = 50;

export class VerifierReleaseStore {
  readonly projectStateDir: string;
  readonly artifactStore: VerifierInspectArtifactStore;
  readonly handoffDir: string;
  readonly bundleDir: string;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.artifactStore = new VerifierInspectArtifactStore(projectStateDir);
    this.handoffDir = path.join(
      projectStateDir,
      VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
      VERIFIER_RELEASE_HANDOFF_DIRNAME,
    );
    this.bundleDir = path.join(
      projectStateDir,
      VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
      VERIFIER_RELEASE_BUNDLE_DIRNAME,
    );
  }

  async writeArtifactHandoff(
    artifact: VerifierInspectArtifactRecord,
  ): Promise<VerifierReleaseHandoffRecord> {
    await fs.mkdir(this.handoffDir, { recursive: true });
    const record = createVerifierReleaseHandoffFromArtifactRecord(artifact);
    await this.writeHandoffRecord(record);
    return structuredClone(record);
  }

  async writeBaselinePromotionHandoff(input: {
    baseline: VerifierInspectBaselineRecord;
    promotion: VerifierInspectBaselinePromotionRecord;
  }): Promise<VerifierReleaseHandoffRecord> {
    await fs.mkdir(this.handoffDir, { recursive: true });
    const record = createVerifierReleaseHandoffFromBaselinePromotion(input);
    await this.writeHandoffRecord(record);
    return structuredClone(record);
  }

  async loadHandoff(reference: string = "latest"): Promise<VerifierReleaseHandoffSelection> {
    const normalized = normalizeHandoffReference(reference);
    const latestArtifacts = await this.collectLatestArtifactIds();
    if (normalized === "latest") {
      const latestHandoff = await this.loadLatestPersistedHandoff();
      if (latestHandoff) {
        return buildSelection({
          reference: "latest",
          handoff: latestHandoff,
          latestArtifacts,
        });
      }
      const latestArtifact = await this.loadLatestArtifactRecord();
      if (!latestArtifact) {
        return buildSelection({
          reference: "latest",
          handoff: null,
          latestArtifacts,
          reason: "No verifier artifact or handoff has been recorded yet.",
        });
      }
      const handoff = await this.writeArtifactHandoff(latestArtifact);
      return buildSelection({
        reference: "latest",
        handoff,
        latestArtifacts,
      });
    }

    const persisted = await this.resolvePersistedHandoff(normalized).catch(() => null);
    if (persisted) {
      return buildSelection({
        reference: normalized,
        handoff: persisted,
        latestArtifacts,
      });
    }

    const artifact = await this.artifactStore.loadArtifact(normalized);
    const handoff = await this.findPersistedHandoffByArtifactId(artifact.metadata.artifactId).catch(() => null)
      ?? await this.writeArtifactHandoff(artifact);
    return buildSelection({
      reference: normalized,
      handoff,
      latestArtifacts,
    });
  }

  async exportBundle(reference: string = "latest"): Promise<VerifierReleaseBundleRecord> {
    const selection = await this.loadHandoff(reference);
    if (!selection.handoff) {
      throw new Error(selection.reason ?? "No verifier handoff is available for bundle export.");
    }
    return this.writeBundleForHandoff(selection.handoff);
  }

  async loadBundle(reference: string): Promise<VerifierReleaseBundleRecord> {
    return this.loadBundleRecord(reference);
  }

  async exportBundleForArtifact(
    artifact: VerifierInspectArtifactRecord,
  ): Promise<VerifierReleaseBundleRecord> {
    const handoff = await this.findPersistedHandoffByArtifactId(artifact.metadata.artifactId).catch(() => null)
      ?? await this.writeArtifactHandoff(artifact);
    return this.writeBundleForHandoff(handoff);
  }

  async backfillGitHubActionsMetadata(
    reference: string = "latest",
    input: VerifierGitHubActionsBackfillInput,
  ): Promise<VerifierReleaseHandoffSelection> {
    const selection = await this.loadHandoff(reference);
    if (!selection.handoff) {
      return selection;
    }

    const handoff: VerifierReleaseHandoffRecord = {
      ...structuredClone(selection.handoff),
      metadata: applyWorkflowMetadataToHandoffMetadata(selection.handoff.metadata, input),
      triage: selection.handoff.triage
        ? {
            ...structuredClone(selection.handoff.triage),
            workflow: input.workflow ? structuredClone(input.workflow) : selection.handoff.triage.workflow,
            upload: input.upload ? structuredClone(input.upload) : selection.handoff.triage.upload,
          }
        : null,
    };
    await this.writeHandoffRecord(handoff);

    for (const artifactId of handoff.sourceArtifactIds) {
      const record = await this.artifactStore.loadArtifact(artifactId).catch(() => null);
      if (!record) {
        continue;
      }
      await this.artifactStore.updateArtifactMetadata(artifactId, applyWorkflowMetadataToArtifactMetadata(record.metadata, input));
    }

    if (handoff.metadata.bundleId) {
      const bundle = await this.loadBundleRecord(handoff.metadata.bundleId).catch(() => null);
      if (bundle) {
        bundle.metadata = applyWorkflowMetadataToBundleMetadata(bundle.metadata, input);
        await this.writeBundleRecord(bundle);
      }
    }

    return buildSelection({
      reference,
      handoff,
      latestArtifacts: await this.collectLatestArtifactIds(),
    });
  }

  async pruneArtifacts(
    policyInput: Partial<VerifierInspectArtifactRetentionPolicy> = {},
  ): Promise<VerifierInspectArtifactPruneResult> {
    const policy = normalizeRetentionPolicy(policyInput);
    const artifacts = await this.artifactStore.listArtifacts(Number.MAX_SAFE_INTEGER);
    const nowMs = Date.now();
    const maxAgeMs = policy.maxArtifactAgeDays != null
      ? policy.maxArtifactAgeDays * 24 * 60 * 60 * 1000
      : null;
    const kept: VerifierInspectArtifactPruneDecision[] = [];
    const deleted: VerifierInspectArtifactPruneDecision[] = [];
    const deletedArtifactIds = new Set<string>();

    for (const [index, metadata] of artifacts.items.entries()) {
      const deleteByCount = index >= policy.maxArtifactCount;
      const deleteByAge = maxAgeMs != null && (nowMs - Date.parse(metadata.createdAt)) > maxAgeMs;
      const shouldDelete = deleteByCount || deleteByAge;
      const decision = createPruneDecision({
        kind: "artifact",
        id: metadata.artifactId,
        createdAt: metadata.createdAt,
        path: this.artifactStore.getArtifactPath(metadata.artifactId),
        action: shouldDelete ? "delete" : "keep",
        reasonKind: shouldDelete
          ? (deleteByAge ? "delete_max_age" : "delete_max_count")
          : (index < policy.maxArtifactCount ? "within_max_count" : "within_max_age"),
        reason: shouldDelete
          ? (deleteByAge
            ? `Artifact exceeds max age of ${policy.maxArtifactAgeDays} day(s).`
            : `Artifact exceeds max count of ${policy.maxArtifactCount}.`)
          : (index < policy.maxArtifactCount
            ? `Artifact is within max count of ${policy.maxArtifactCount}.`
            : `Artifact is within max age of ${policy.maxArtifactAgeDays} day(s).`),
        sourceArtifactId: metadata.artifactId,
      });
      if (shouldDelete) {
        deleted.push(decision);
        deletedArtifactIds.add(metadata.artifactId);
      } else {
        kept.push(decision);
      }
    }

    const handoffs = await this.listPersistedHandoffs();
    for (const handoff of handoffs) {
      const primaryArtifactId = handoff.metadata.primaryArtifactId;
      const protectedRecord = handoff.metadata.sourceKind === "baseline_promotion" || primaryArtifactId == null;
      const shouldDelete = !protectedRecord && deletedArtifactIds.has(primaryArtifactId);
      const decision = createPruneDecision({
        kind: "handoff",
        id: handoff.metadata.handoffId,
        createdAt: handoff.metadata.createdAt,
        path: this.getHandoffPath(handoff.metadata.handoffId),
        action: shouldDelete ? "delete" : "keep",
        reasonKind: protectedRecord
          ? "protected_non_artifact"
          : shouldDelete
            ? "delete_parent_artifact"
            : "within_max_count",
        reason: protectedRecord
          ? "Baseline promotion audit handoffs are retained."
          : shouldDelete
            ? `Handoff follows deleted artifact ${primaryArtifactId}.`
            : `Handoff follows retained artifact ${primaryArtifactId}.`,
        sourceArtifactId: primaryArtifactId,
      });
      if (shouldDelete) {
        deleted.push(decision);
      } else {
        kept.push(decision);
      }
    }

    const bundles = await this.listPersistedBundles();
    for (const bundle of bundles) {
      const primaryArtifactId = bundle.metadata.primaryArtifactId;
      const protectedRecord = bundle.metadata.primaryArtifactId == null;
      const shouldDelete = primaryArtifactId != null && !protectedRecord && deletedArtifactIds.has(primaryArtifactId);
      const decision = createPruneDecision({
        kind: "bundle",
        id: bundle.metadata.bundleId,
        createdAt: bundle.metadata.createdAt,
        path: bundle.metadata.bundlePath,
        action: shouldDelete ? "delete" : "keep",
        reasonKind: protectedRecord
          ? "protected_non_artifact"
          : shouldDelete
            ? "delete_parent_artifact"
            : "within_max_count",
        reason: protectedRecord
          ? "Bundle has no deletable parent artifact."
          : shouldDelete
            ? `Bundle follows deleted artifact ${primaryArtifactId}.`
            : `Bundle follows retained artifact ${primaryArtifactId}.`,
        sourceArtifactId: primaryArtifactId,
      });
      if (shouldDelete) {
        deleted.push(decision);
      } else {
        kept.push(decision);
      }
    }

    if (!policy.dryRun) {
      for (const decision of deleted) {
        if (decision.kind === "bundle") {
          await fs.rm(decision.path, { recursive: true, force: true });
          continue;
        }
        await fs.rm(decision.path, { force: true });
      }
    }

    return {
      policy,
      dryRun: policy.dryRun,
      keptCount: kept.length,
      deletedCount: deleted.length,
      kept,
      deleted,
      summary: policy.dryRun
        ? `Artifact prune preview kept ${kept.length} item(s) and would delete ${deleted.length}.`
        : `Artifact prune kept ${kept.length} item(s) and deleted ${deleted.length}.`,
    };
  }

  getHandoffPath(handoffId: string): string {
    return path.join(this.handoffDir, `${handoffId}.json`);
  }

  getBundlePath(bundleId: string): string {
    return path.join(this.bundleDir, bundleId);
  }

  private async writeBundleForHandoff(
    handoff: VerifierReleaseHandoffRecord,
  ): Promise<VerifierReleaseBundleRecord> {
    await fs.mkdir(this.bundleDir, { recursive: true });
    const bundleId = createBundleId();
    const createdAt = new Date().toISOString();
    const bundlePath = this.getBundlePath(bundleId);
    const artifactDir = path.join(bundlePath, "artifacts");
    await fs.mkdir(artifactDir, { recursive: true });

    const includedArtifactRecords = await Promise.all(
      handoff.sourceArtifactIds.map(async (artifactId) => this.artifactStore.loadArtifact(artifactId)),
    );
    const includedArtifacts = includedArtifactRecords.map((entry) => ({
      ...structuredClone(entry.metadata),
      bundleId,
    }));

    const handoffPath = path.join(bundlePath, "handoff.json");
    const referencesPath = path.join(bundlePath, "references.json");
    const summaryPath = path.join(bundlePath, "summary.md");
    const files: VerifierReleaseBundleFileEntry[] = [];

    const bundledHandoff: VerifierReleaseHandoffRecord = {
      ...structuredClone(handoff),
      metadata: {
        ...structuredClone(handoff.metadata),
        bundleId,
      },
      triage: handoff.triage
        ? {
            ...structuredClone(handoff.triage),
            bundleId,
          }
        : null,
    };
    await fs.writeFile(handoffPath, `${JSON.stringify(bundledHandoff, null, 2)}\n`, "utf8");
    files.push({
      role: "handoff",
      path: handoffPath,
      relativePath: "handoff.json",
    });

    for (const artifact of includedArtifactRecords) {
      const artifactPath = path.join(artifactDir, `${artifact.metadata.artifactId}.json`);
      const artifactRecord = {
        ...structuredClone(artifact),
        metadata: {
          ...structuredClone(artifact.metadata),
          bundleId,
        },
      };
      await fs.writeFile(artifactPath, `${JSON.stringify(artifactRecord, null, 2)}\n`, "utf8");
      files.push({
        role: "artifact",
        path: artifactPath,
        relativePath: path.join("artifacts", `${artifact.metadata.artifactId}.json`),
      });
    }

    const referencesPayload = {
      sourceReferences: handoff.sourceReferences,
      artifactIds: handoff.metadata.artifactIds,
      snapshotIds: handoff.metadata.snapshotIds,
      baselineNames: handoff.metadata.baselineNames,
      primaryArtifactId: handoff.metadata.primaryArtifactId,
      baselinePromotionId: handoff.baselinePromotionId,
    };
    await fs.writeFile(referencesPath, `${JSON.stringify(referencesPayload, null, 2)}\n`, "utf8");
    files.push({
      role: "references",
      path: referencesPath,
      relativePath: "references.json",
    });

    await fs.writeFile(summaryPath, createBundleSummaryMarkdown(bundledHandoff), "utf8");
    files.push({
      role: "summary",
      path: summaryPath,
      relativePath: "summary.md",
    });

    const metadata: VerifierReleaseBundleMetadata = {
      bundleId,
      createdAt,
      handoffId: handoff.metadata.handoffId,
      sourceKind: handoff.metadata.sourceKind,
      primaryArtifactId: handoff.metadata.primaryArtifactId,
      artifactIds: structuredClone(handoff.metadata.artifactIds),
      snapshotIds: structuredClone(handoff.metadata.snapshotIds),
      baselineNames: structuredClone(handoff.metadata.baselineNames),
      bundlePath,
      summaryPath,
      workflow: handoff.metadata.workflow ? structuredClone(handoff.metadata.workflow) : null,
      upload: handoff.metadata.upload ? structuredClone(handoff.metadata.upload) : null,
      summary: `Verifier bundle ${bundleId} exported for ${handoff.metadata.sourceKind} handoff ${handoff.metadata.handoffId}.`,
    };
    const record: VerifierReleaseBundleRecord = {
      metadata,
      handoff: bundledHandoff,
      includedArtifacts,
      files,
    };
    const bundleRecordPath = path.join(bundlePath, "bundle.json");
    await fs.writeFile(bundleRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    record.files.unshift({
      role: "bundle",
      path: bundleRecordPath,
      relativePath: "bundle.json",
    });
    await fs.writeFile(bundleRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await this.attachBundleToHandoffAndArtifacts(handoff, bundleId);
    return structuredClone({
      ...record,
      handoff: {
        ...record.handoff,
        metadata: {
          ...record.handoff.metadata,
          bundleId,
        },
      },
    });
  }

  private async writeHandoffRecord(record: VerifierReleaseHandoffRecord): Promise<void> {
    await fs.writeFile(
      this.getHandoffPath(record.metadata.handoffId),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }

  private async loadLatestArtifactRecord(): Promise<VerifierInspectArtifactRecord | null> {
    const artifacts = await this.artifactStore.listArtifacts(1);
    const latest = artifacts.items[0];
    return latest ? this.artifactStore.loadArtifact(latest.artifactId) : null;
  }

  private async collectLatestArtifactIds(): Promise<{
    latestArtifactId: string | null;
    latestCompareArtifactId: string | null;
    latestGateArtifactId: string | null;
    latestEvalArtifactId: string | null;
  }> {
    const artifacts = await this.artifactStore.listArtifacts(Number.MAX_SAFE_INTEGER);
    const latestArtifactId = artifacts.items[0]?.artifactId ?? null;
    const latestCompareArtifactId = artifacts.items.find((entry) => entry.kind === "compare")?.artifactId ?? null;
    const latestGateArtifactId = artifacts.items.find((entry) => entry.kind === "gate")?.artifactId ?? null;
    const latestEvalArtifactId = artifacts.items.find((entry) => entry.kind === "eval")?.artifactId ?? null;
    return {
      latestArtifactId,
      latestCompareArtifactId,
      latestGateArtifactId,
      latestEvalArtifactId,
    };
  }

  private async loadLatestPersistedHandoff(): Promise<VerifierReleaseHandoffRecord | null> {
    const handoffs = await this.listPersistedHandoffs();
    return handoffs[0] ?? null;
  }

  private async resolvePersistedHandoff(reference: string): Promise<VerifierReleaseHandoffRecord> {
    const handoffs = await this.listPersistedHandoffs();
    const matches = handoffs.filter((entry) =>
      entry.metadata.handoffId === reference
      || entry.metadata.handoffId.startsWith(reference)
    );
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(`Could not resolve verifier handoff "${reference}".`);
  }

  private async findPersistedHandoffByArtifactId(
    artifactId: string,
  ): Promise<VerifierReleaseHandoffRecord> {
    const handoffs = await this.listPersistedHandoffs();
    const matches = handoffs.filter((entry) =>
      entry.metadata.primaryArtifactId === artifactId
      || entry.metadata.artifactIds.includes(artifactId)
    );
    if (matches.length === 0) {
      throw new Error(`Could not resolve handoff for artifact "${artifactId}".`);
    }
    return matches.sort((left, right) => compareHandoffMetadataNewestFirst(left.metadata, right.metadata))[0];
  }

  private async listPersistedHandoffs(): Promise<VerifierReleaseHandoffRecord[]> {
    await fs.mkdir(this.handoffDir, { recursive: true });
    const entries = await fs.readdir(this.handoffDir, { withFileTypes: true });
    const handoffs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readHandoffFromPath(path.join(this.handoffDir, entry.name))),
    );
    return handoffs.sort((left, right) => compareHandoffMetadataNewestFirst(left.metadata, right.metadata));
  }

  private async listPersistedBundles(): Promise<VerifierReleaseBundleRecord[]> {
    await fs.mkdir(this.bundleDir, { recursive: true });
    const entries = await fs.readdir(this.bundleDir, { withFileTypes: true });
    const bundles = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => this.readBundleFromPath(path.join(this.bundleDir, entry.name, "bundle.json"))),
    );
    return bundles.sort((left, right) => compareBundleMetadataNewestFirst(left.metadata, right.metadata));
  }

  private async readHandoffFromPath(filePath: string): Promise<VerifierReleaseHandoffRecord> {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeHandoffRecord(payload, path.basename(filePath, ".json"));
  }

  private async readBundleFromPath(filePath: string): Promise<VerifierReleaseBundleRecord> {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeBundleRecord(payload, path.basename(path.dirname(filePath)));
  }

  private async loadBundleRecord(reference: string): Promise<VerifierReleaseBundleRecord> {
    const bundleId = await this.resolveBundleId(reference);
    return this.readBundleFromPath(path.join(this.bundleDir, bundleId, "bundle.json"));
  }

  private async resolveBundleId(reference: string): Promise<string> {
    const normalized = `${reference ?? ""}`.trim();
    if (!normalized) {
      throw new Error("Missing verifier bundle reference.");
    }
    await fs.mkdir(this.bundleDir, { recursive: true });
    const directPath = path.join(this.bundleDir, normalized, "bundle.json");
    try {
      await fs.access(directPath);
      return normalized;
    } catch {}
    const entries = await fs.readdir(this.bundleDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((entry) => entry === normalized || entry.startsWith(normalized));
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(`Could not resolve verifier bundle "${normalized}".`);
  }

  private async writeBundleRecord(record: VerifierReleaseBundleRecord): Promise<void> {
    await fs.writeFile(
      path.join(record.metadata.bundlePath, "bundle.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }

  private async attachBundleToHandoffAndArtifacts(
    handoff: VerifierReleaseHandoffRecord,
    bundleId: string,
  ): Promise<void> {
    const updatedHandoff: VerifierReleaseHandoffRecord = {
      ...structuredClone(handoff),
      metadata: {
        ...structuredClone(handoff.metadata),
        bundleId,
      },
      triage: handoff.triage
        ? {
            ...structuredClone(handoff.triage),
            bundleId,
          }
        : null,
    };
    await this.writeHandoffRecord(updatedHandoff);
    for (const artifactId of updatedHandoff.sourceArtifactIds) {
      const record = await this.artifactStore.loadArtifact(artifactId).catch(() => null);
      if (!record) {
        continue;
      }
      await this.artifactStore.updateArtifactMetadata(artifactId, {
        ...structuredClone(record.metadata),
        bundleId,
      });
    }
  }
}

function buildSelection(input: {
  reference: string | null;
  handoff: VerifierReleaseHandoffRecord | null;
  latestArtifacts: {
    latestArtifactId: string | null;
    latestCompareArtifactId: string | null;
    latestGateArtifactId: string | null;
    latestEvalArtifactId: string | null;
  };
  reason?: string | null;
}): VerifierReleaseHandoffSelection {
  return {
    available: input.handoff != null,
    reason: input.handoff ? null : (input.reason ?? "No verifier release handoff is available."),
    reference: input.reference,
    latestArtifactId: input.latestArtifacts.latestArtifactId,
    latestCompareArtifactId: input.latestArtifacts.latestCompareArtifactId,
    latestGateArtifactId: input.latestArtifacts.latestGateArtifactId,
    latestEvalArtifactId: input.latestArtifacts.latestEvalArtifactId,
    handoff: input.handoff ? structuredClone(input.handoff) : null,
  };
}

function createBundleId(): string {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
  return `vibundle-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeHandoffReference(reference: string | null | undefined): string {
  const normalized = `${reference ?? "latest"}`.trim();
  return normalized.replace(/^handoff:/, "") || "latest";
}

function normalizeRetentionPolicy(
  input: Partial<VerifierInspectArtifactRetentionPolicy>,
): VerifierInspectArtifactRetentionPolicy {
  const maxArtifactCount = typeof input.maxArtifactCount === "number"
    && Number.isInteger(input.maxArtifactCount)
    && input.maxArtifactCount > 0
    ? input.maxArtifactCount
    : DEFAULT_RETENTION_MAX_COUNT;
  const maxArtifactAgeDays = typeof input.maxArtifactAgeDays === "number"
    && Number.isInteger(input.maxArtifactAgeDays)
    && input.maxArtifactAgeDays > 0
    ? input.maxArtifactAgeDays
    : null;
  return {
    maxArtifactCount,
    maxArtifactAgeDays,
    dryRun: input.dryRun === true,
  };
}

function createPruneDecision(
  input: VerifierInspectArtifactPruneDecision,
): VerifierInspectArtifactPruneDecision {
  return structuredClone(input);
}

function applyWorkflowMetadataToArtifactMetadata(
  metadata: VerifierInspectArtifactMetadata,
  input: VerifierGitHubActionsBackfillInput,
): VerifierInspectArtifactMetadata {
  return {
    ...structuredClone(metadata),
    workflow: input.workflow ? structuredClone(input.workflow) : metadata.workflow,
    upload: input.upload ? structuredClone(input.upload) : metadata.upload,
  };
}

function applyWorkflowMetadataToHandoffMetadata(
  metadata: VerifierReleaseHandoffMetadata,
  input: VerifierGitHubActionsBackfillInput,
): VerifierReleaseHandoffMetadata {
  return {
    ...structuredClone(metadata),
    workflow: input.workflow ? structuredClone(input.workflow) : metadata.workflow,
    upload: input.upload ? structuredClone(input.upload) : metadata.upload,
  };
}

function applyWorkflowMetadataToBundleMetadata(
  metadata: VerifierReleaseBundleMetadata,
  input: VerifierGitHubActionsBackfillInput,
): VerifierReleaseBundleMetadata {
  return {
    ...structuredClone(metadata),
    workflow: input.workflow ? structuredClone(input.workflow) : metadata.workflow,
    upload: input.upload ? structuredClone(input.upload) : metadata.upload,
  };
}

function compareHandoffMetadataNewestFirst(
  left: VerifierReleaseHandoffMetadata,
  right: VerifierReleaseHandoffMetadata,
): number {
  return compareValue(right.createdAt, left.createdAt)
    || compareValue(right.handoffId, left.handoffId);
}

function compareBundleMetadataNewestFirst(
  left: VerifierReleaseBundleMetadata,
  right: VerifierReleaseBundleMetadata,
): number {
  return compareValue(right.createdAt, left.createdAt)
    || compareValue(right.bundleId, left.bundleId);
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

function createBundleSummaryMarkdown(
  handoff: VerifierReleaseHandoffRecord,
): string {
  const lines = [
    "# Verifier Release Handoff",
    "",
    `- Handoff: ${handoff.metadata.handoffId}`,
    `- Source: ${handoff.metadata.sourceKind}`,
    `- Status: ${handoff.metadata.status}`,
    `- Policy profile: ${handoff.metadata.policyProfileId ?? "none"}`,
    `- Primary artifact: ${handoff.metadata.primaryArtifactId ?? "none"}`,
    `- Baseline: ${handoff.baselineName ?? handoff.metadata.baselineNames[0] ?? "none"}`,
    `- Snapshots: ${handoff.metadata.snapshotIds.join(", ") || "none"}`,
    `- Summary: ${handoff.summary}`,
  ];
  if (handoff.topReasons.length > 0) {
    lines.push("", "## Top Reasons");
    for (const reason of handoff.topReasons) {
      lines.push(`- [${reason.severity}] ${reason.summary}`);
    }
  }
  if (handoff.blockingDiagnostics) {
    lines.push(
      "",
      "## Blocking Diagnostics",
      `- Introduced: ${handoff.blockingDiagnostics.introducedCount}`,
      `- Resolved: ${handoff.blockingDiagnostics.resolvedCount}`,
      `- Persisted: ${handoff.blockingDiagnostics.persistedCount}`,
      `- Summary: ${handoff.blockingDiagnostics.summary}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function normalizeBundleRecord(
  value: unknown,
  fallbackId: string,
): VerifierReleaseBundleRecord {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.handoff)) {
    throw new Error(`Invalid verifier bundle payload "${fallbackId}".`);
  }
  const metadata = normalizeBundleMetadata(value.metadata, fallbackId);
  const files = Array.isArray(value.files)
    ? value.files.filter(isRecord).map((entry) => normalizeBundleFileEntry(entry))
    : [];
  const includedArtifacts = Array.isArray(value.includedArtifacts)
    ? value.includedArtifacts.filter(isRecord).map((entry) => normalizeArtifactMetadata(entry))
    : [];
  return {
    metadata,
    handoff: normalizeHandoffRecord(value.handoff, metadata.handoffId),
    includedArtifacts,
    files,
  };
}

function normalizeBundleMetadata(
  value: unknown,
  fallbackId: string,
): VerifierReleaseBundleMetadata {
  const record = isRecord(value) ? value : {};
  return {
    bundleId: toNonEmptyString(record.bundleId) ?? fallbackId,
    createdAt: toNonEmptyString(record.createdAt) ?? new Date(0).toISOString(),
    handoffId: toNonEmptyString(record.handoffId) ?? "unknown",
    sourceKind: toSourceKind(record.sourceKind) ?? "compare",
    primaryArtifactId: toNullableString(record.primaryArtifactId),
    artifactIds: toStringArray(record.artifactIds),
    snapshotIds: toStringArray(record.snapshotIds),
    baselineNames: toStringArray(record.baselineNames),
    bundlePath: toNonEmptyString(record.bundlePath) ?? "",
    summaryPath: toNullableString(record.summaryPath),
    workflow: normalizeWorkflowProvenance(record.workflow),
    upload: normalizeUploadMetadata(record.upload),
    summary: toNonEmptyString(record.summary) ?? `Verifier bundle ${fallbackId}.`,
  };
}

function normalizeBundleFileEntry(
  value: Record<string, unknown>,
): VerifierReleaseBundleFileEntry {
  return {
    role: value.role === "bundle"
      || value.role === "handoff"
      || value.role === "artifact"
      || value.role === "references"
      || value.role === "summary"
      ? value.role
      : "artifact",
    path: toNonEmptyString(value.path) ?? "",
    relativePath: toNonEmptyString(value.relativePath) ?? "",
  };
}

function normalizeHandoffRecord(
  value: unknown,
  fallbackId: string,
): VerifierReleaseHandoffRecord {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    throw new Error(`Invalid verifier handoff payload "${fallbackId}".`);
  }
  const metadata = normalizeHandoffMetadata(value.metadata, fallbackId);
  return {
    metadata,
    sourceReferences: Array.isArray(value.sourceReferences)
      ? value.sourceReferences.filter(isRecord).map((entry) => normalizeResolvedReference(entry))
      : [],
    primaryArtifact: isRecord(value.primaryArtifact)
      ? normalizeArtifactMetadata(value.primaryArtifact)
      : null,
    sourceArtifactIds: toStringArray(value.sourceArtifactIds),
    baselinePromotionId: toNullableString(value.baselinePromotionId),
    baselineId: toNullableString(value.baselineId),
    baselineName: toNullableString(value.baselineName),
    finalOutcome: normalizeFinalOutcomeValueChange(value.finalOutcome),
    latestVerifierStatus: normalizeVerifierStatusValueChange(value.latestVerifierStatus),
    latestRepairStatus: normalizeRepairStatusValueChange(value.latestRepairStatus),
    topReasons: Array.isArray(value.topReasons)
      ? value.topReasons.filter(isRecord).map((entry) => normalizeReasonSummary(entry))
      : [],
    blockingDiagnostics: isRecord(value.blockingDiagnostics)
      ? normalizeBlockingDiagnosticSummary(value.blockingDiagnostics)
      : null,
    triage: isRecord(value.triage)
      ? cloneTyped<VerifierReleaseTriageSummary>(value.triage)
      : null,
    summary: toNonEmptyString(value.summary) ?? metadata.summary,
  };
}

function normalizeHandoffMetadata(
  value: unknown,
  fallbackId: string,
): VerifierReleaseHandoffMetadata {
  const record = isRecord(value) ? value : {};
  return {
    handoffId: toNonEmptyString(record.handoffId) ?? fallbackId,
    createdAt: toNonEmptyString(record.createdAt) ?? new Date(0).toISOString(),
    sourceKind: toSourceKind(record.sourceKind) ?? "compare",
    status: toStatus(record.status) ?? "steady",
    policyProfileId: toNullableString(record.policyProfileId),
    primaryArtifactId: toNullableString(record.primaryArtifactId),
    artifactIds: toStringArray(record.artifactIds),
    snapshotIds: toStringArray(record.snapshotIds),
    baselineNames: toStringArray(record.baselineNames),
    pass: typeof record.pass === "boolean" ? record.pass : null,
    bundleId: toNullableString(record.bundleId),
    workflow: normalizeWorkflowProvenance(record.workflow),
    upload: normalizeUploadMetadata(record.upload),
    summary: toNonEmptyString(record.summary) ?? `Verifier handoff ${fallbackId}.`,
  };
}

function normalizeResolvedReference(
  value: Record<string, unknown>,
): VerifierInspectResolvedReference {
  const kind = toReferenceKind(value.kind) ?? "current";
  const scope = toScope(value.scope) ?? "current";
  return {
    kind,
    label: toNonEmptyString(value.label) ?? "current",
    reference: toNullableString(value.reference),
    scope,
    sessionId: toNullableString(value.sessionId),
    traceId: toNullableString(value.traceId),
    replayReference: toNullableString(value.replayReference),
    snapshotId: toNullableString(value.snapshotId),
    baselineName: toNullableString(value.baselineName),
  };
}

function normalizeArtifactMetadata(
  value: unknown,
): VerifierInspectArtifactMetadata {
  const record = isRecord(value) ? value : {};
  return {
    artifactId: toNonEmptyString(record.artifactId) ?? "unknown",
    createdAt: toNonEmptyString(record.createdAt) ?? new Date(0).toISOString(),
    kind: record.kind === "compare" || record.kind === "gate" || record.kind === "eval"
      ? record.kind
      : "compare",
    sourceReferences: Array.isArray(record.sourceReferences)
      ? record.sourceReferences.filter(isRecord).map((entry) => normalizeResolvedReference(entry))
      : [],
    policyProfileId: toNullableString(record.policyProfileId),
    snapshotIds: toStringArray(record.snapshotIds),
    baselineNames: toStringArray(record.baselineNames),
    pass: typeof record.pass === "boolean" ? record.pass : null,
    hasChanges: typeof record.hasChanges === "boolean" ? record.hasChanges : null,
    bundleId: toNullableString(record.bundleId),
    workflow: normalizeWorkflowProvenance(record.workflow),
    upload: normalizeUploadMetadata(record.upload),
    summary: toNonEmptyString(record.summary) ?? "Verifier artifact.",
  };
}

function normalizeWorkflowProvenance(
  value: unknown,
): VerifierArtifactWorkflowProvenance | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    provider: "github_actions",
    runId: toNullableString(value.runId),
    runAttempt: toNullableString(value.runAttempt),
    workflow: toNullableString(value.workflow),
    job: toNullableString(value.job),
    sha: toNullableString(value.sha),
    ref: toNullableString(value.ref),
    eventName: toNullableString(value.eventName),
    repository: toNullableString(value.repository),
    serverUrl: toNullableString(value.serverUrl),
    actor: toNullableString(value.actor),
  };
}

function normalizeUploadMetadata(
  value: unknown,
): VerifierArtifactUploadMetadata | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    provider: "github_actions_upload_artifact",
    artifactName: toNullableString(value.artifactName),
    artifactId: toNullableString(value.artifactId),
    artifactUrl: toNullableString(value.artifactUrl),
    artifactDigest: toNullableString(value.artifactDigest),
    retentionDays: typeof value.retentionDays === "number" && Number.isFinite(value.retentionDays)
      ? value.retentionDays
      : null,
    uploadedAt: toNonEmptyString(value.uploadedAt) ?? new Date(0).toISOString(),
  };
}

function normalizeReasonSummary(
  value: Record<string, unknown>,
): VerifierReleaseHandoffReasonSummary {
  return {
    kind: toReasonKind(value.kind) ?? "compare_changed",
    severity: toReasonSeverity(value.severity) ?? "info",
    summary: toNonEmptyString(value.summary) ?? "Verifier handoff reason.",
  };
}

function normalizeBlockingDiagnosticSummary(
  value: Record<string, unknown>,
): VerifierReleaseHandoffBlockingDiagnosticSummary {
  return {
    comparable: value.comparable === true,
    beforeCount: toNumber(value.beforeCount),
    afterCount: toNumber(value.afterCount),
    resolvedCount: toNumber(value.resolvedCount),
    persistedCount: toNumber(value.persistedCount),
    introducedCount: toNumber(value.introducedCount),
    resolved: Array.isArray(value.resolved)
      ? value.resolved.filter(isRecord).map((entry) => normalizeDiagnosticFingerprint(entry))
      : [],
    persisted: Array.isArray(value.persisted)
      ? value.persisted.filter(isRecord).map((entry) => normalizeDiagnosticFingerprint(entry))
      : [],
    introduced: Array.isArray(value.introduced)
      ? value.introduced.filter(isRecord).map((entry) => normalizeDiagnosticFingerprint(entry))
      : [],
    summary: toNonEmptyString(value.summary) ?? "Blocking diagnostics unavailable.",
  };
}

function normalizeFinalOutcomeValueChange(
  value: unknown,
): VerifierInspectValueChange<VerifierInspectFinalOutcome> | null {
  return normalizeValueChange(value, toFinalOutcome);
}

function normalizeVerifierStatusValueChange(
  value: unknown,
): VerifierInspectValueChange<VerifierStatus | "none"> | null {
  return normalizeValueChange(value, toVerifierStatusOrNone);
}

function normalizeRepairStatusValueChange(
  value: unknown,
): VerifierInspectValueChange<RepairStatus | "none"> | null {
  return normalizeValueChange(value, toRepairStatusOrNone);
}

function normalizeValueChange<T>(
  value: unknown,
  normalizeMember: (member: unknown) => T | null,
): VerifierInspectValueChange<T> | null {
  if (!isRecord(value) || typeof value.changed !== "boolean") {
    return null;
  }
  const before = normalizeMember(value.before);
  const after = normalizeMember(value.after);
  if (before == null || after == null) {
    return null;
  }
  return {
    before,
    after,
    changed: value.changed,
  };
}

function normalizeDiagnosticFingerprint(
  value: Record<string, unknown>,
): DiagnosticFingerprint {
  return {
    fingerprint: toNonEmptyString(value.fingerprint) ?? "unknown",
    path: toNullableString(value.path),
    line: toNullableNumber(value.line),
    column: toNullableNumber(value.column),
    code: toNullableString(value.code),
    message: toNonEmptyString(value.message) ?? "",
    source: toNullableString(value.source),
    scope: toNullableString(value.scope),
    category: toNullableString(value.category),
    rule: toNullableString(value.rule),
  };
}

function toSourceKind(value: unknown): VerifierReleaseHandoffSourceKind | null {
  return value === "compare" || value === "gate" || value === "eval" || value === "baseline_promotion"
    ? value
    : null;
}

function toStatus(value: unknown): VerifierReleaseHandoffStatus | null {
  return value === "pass"
    || value === "fail"
    || value === "changed"
    || value === "steady"
    || value === "promoted"
    ? value
    : null;
}

function toReferenceKind(value: unknown): VerifierInspectReferenceKind | null {
  return value === "current"
    || value === "trace"
    || value === "replay"
    || value === "snapshot"
    || value === "baseline"
    ? value
    : null;
}

function toScope(value: unknown): VerifierInspectScope | null {
  return value === "current" || value === "trace" || value === "replay"
    ? value
    : null;
}

function toFinalOutcome(value: unknown): VerifierInspectFinalOutcome | null {
  return value === "unknown"
    || value === "success"
    || value === "failed"
    || value === "stopped"
    || value === "degraded"
    ? value
    : null;
}

function toVerifierStatusOrNone(value: unknown): VerifierStatus | "none" | null {
  return value === "none"
    || value === "passed"
    || value === "failed"
    || value === "skipped"
    || value === "unavailable"
    ? value
    : null;
}

function toRepairStatusOrNone(value: unknown): RepairStatus | "none" | null {
  return value === "none"
    || value === "retrying"
    || value === "succeeded"
    || value === "stopped"
    || value === "exhausted"
    || value === "failed"
    ? value
    : null;
}

function toReasonSeverity(value: unknown): VerifierReleaseHandoffReasonSeverity | null {
  return value === "failure" || value === "notice" || value === "info"
    ? value
    : null;
}

function toReasonKind(value: unknown): VerifierReleaseHandoffReasonKind | null {
  return value === "final_outcome_regressed"
    || value === "latest_verifier_failed"
    || value === "latest_verifier_status_regressed"
    || value === "latest_repair_status_regressed"
    || value === "diagnostic_errors_increased"
    || value === "blocking_diagnostics_introduced"
    || value === "repair_regressed_count_increased"
    || value === "latest_repair_progress_regressed"
    || value === "warning_delta_only"
    || value === "info_delta_only"
    || value === "fix_hint_availability_changed"
    || value === "code_action_availability_changed"
    || value === "project_context_availability_changed"
    || value === "compare_changed"
    || value === "baseline_promoted"
    ? value
    : null;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
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

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function cloneTyped<T>(value: unknown): T {
  return structuredClone(value) as T;
}
