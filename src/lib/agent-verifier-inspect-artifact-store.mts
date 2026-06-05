import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  EvalSuiteResult,
  VerifierArtifactUploadMetadata,
  VerifierArtifactWorkflowProvenance,
  VerifierInspectArtifactEvidence,
  VerifierInspectArtifactKind,
  VerifierInspectArtifactList,
  VerifierInspectArtifactMetadata,
  VerifierInspectArtifactRecord,
  VerifierInspectCompareArtifactRecord,
  VerifierInspectCompareReport,
  VerifierInspectResolvedReference,
  VerifierRegressionGateArtifactRecord,
  VerifierRegressionGateDecision,
  VerifierEvalArtifactRecord,
} from "../types/contracts.js";

import {
  createVerifierInspectArtifactEvidenceFromCompareSummary,
} from "./agent-verifier-inspect.mjs";

import {
  VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
} from "./agent-verifier-inspect-store.mjs";

export const VERIFIER_INSPECT_ARTIFACT_DIRNAME = "artifacts";

export class VerifierInspectArtifactStore {
  readonly projectStateDir: string;
  readonly artifactDir: string;

  constructor(projectStateDir: string) {
    this.projectStateDir = projectStateDir;
    this.artifactDir = path.join(
      projectStateDir,
      VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
      VERIFIER_INSPECT_ARTIFACT_DIRNAME,
    );
  }

  async writeCompareArtifact(
    compare: VerifierInspectCompareReport,
  ): Promise<VerifierInspectCompareArtifactRecord> {
    await fs.mkdir(this.artifactDir, { recursive: true });
    const metadata = createArtifactMetadata({
      kind: "compare",
      sourceReferences: [compare.left.reference, compare.right.reference],
      policyProfileId: null,
      pass: null,
      hasChanges: compare.summary.hasChanges,
      summary: summarizeCompareArtifact(compare),
    });
    const record: VerifierInspectCompareArtifactRecord = {
      metadata,
      compare: {
        ...structuredClone(compare),
        artifact: structuredClone(metadata),
        handoff: null,
        bundle: null,
      },
      evidence: createVerifierInspectArtifactEvidenceFromCompareSummary(compare.summary),
    };
    await this.writeArtifactRecord(record);
    return structuredClone(record);
  }

  async writeGateArtifact(
    decision: VerifierRegressionGateDecision,
  ): Promise<VerifierRegressionGateArtifactRecord> {
    await fs.mkdir(this.artifactDir, { recursive: true });
    const metadata = createArtifactMetadata({
      kind: "gate",
      sourceReferences: [
        decision.compare.left.reference,
        decision.compare.right.reference,
      ],
      policyProfileId: decision.profile.id,
      pass: decision.pass,
      hasChanges: decision.compare.summary.hasChanges,
      summary: decision.summary,
    });
    const record: VerifierRegressionGateArtifactRecord = {
      metadata,
      decision: {
        ...structuredClone(decision),
        artifact: structuredClone(metadata),
        handoff: null,
        bundle: null,
      },
      evidence: createVerifierInspectArtifactEvidenceFromCompareSummary(
        decision.compare.summary,
      ),
    };
    await this.writeArtifactRecord(record);
    return structuredClone(record);
  }

  async writeEvalArtifact(
    result: EvalSuiteResult,
  ): Promise<VerifierEvalArtifactRecord> {
    await fs.mkdir(this.artifactDir, { recursive: true });
    const baselineGate = result.baselineGate ?? null;
    const metadata = createArtifactMetadata({
      kind: "eval",
      sourceReferences: baselineGate
        ? [
            baselineGate.compare.left.reference,
            baselineGate.compare.right.reference,
          ]
        : [],
      policyProfileId: result.baselinePolicyProfile?.id ?? baselineGate?.profile.id ?? null,
      pass: baselineGate?.pass ?? result.summary.failed === 0,
      hasChanges: baselineGate?.compare.summary.hasChanges ?? null,
      summary: summarizeEvalArtifact(result),
    });
    const record: VerifierEvalArtifactRecord = {
      metadata,
      result: {
        ...structuredClone(result),
        baselinePolicyProfile: structuredClone(
          result.baselinePolicyProfile ?? baselineGate?.profile ?? null,
        ),
        artifact: structuredClone(metadata),
        handoff: null,
        bundle: null,
      },
      evidence: baselineGate
        ? createVerifierInspectArtifactEvidenceFromCompareSummary(
            baselineGate.compare.summary,
          )
        : null,
    };
    await this.writeArtifactRecord(record);
    return structuredClone(record);
  }

  async listArtifacts(limit = 20): Promise<VerifierInspectArtifactList> {
    await fs.mkdir(this.artifactDir, { recursive: true });
    const entries = await fs.readdir(this.artifactDir, { withFileTypes: true });
    const artifacts = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readArtifactFromPath(path.join(this.artifactDir, entry.name))),
    );
    const items = artifacts
      .map((entry) => entry.metadata)
      .sort(compareArtifactMetadataNewestFirst);
    return {
      total: items.length,
      items: items.slice(0, limit),
    };
  }

  async loadArtifact(reference: string): Promise<VerifierInspectArtifactRecord> {
    const artifactId = await this.resolveArtifactId(reference);
    return this.readArtifactFromPath(this.getArtifactPath(artifactId));
  }

  async resolveArtifactId(reference: string): Promise<string> {
    const normalized = `${reference ?? ""}`.trim();
    if (!normalized) {
      throw new Error("Missing verifier artifact reference.");
    }
    await fs.mkdir(this.artifactDir, { recursive: true });
    const directPath = this.getArtifactPath(normalized);
    try {
      await fs.access(directPath);
      return normalized;
    } catch {}

    const entries = await fs.readdir(this.artifactDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.basename(entry.name, ".json"))
      .filter((entry) => entry === normalized || entry.startsWith(normalized));
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(`Could not resolve verifier artifact "${normalized}".`);
  }

  getArtifactPath(artifactId: string): string {
    return path.join(this.artifactDir, `${artifactId}.json`);
  }

  async updateArtifactMetadata(
    artifactId: string,
    metadata: VerifierInspectArtifactMetadata,
  ): Promise<VerifierInspectArtifactRecord> {
    const record = await this.loadArtifact(artifactId);
    const updated = applyArtifactMetadata(record, metadata);
    await this.writeArtifactRecord(updated);
    return structuredClone(updated);
  }

  private async writeArtifactRecord(record: VerifierInspectArtifactRecord): Promise<void> {
    await fs.writeFile(
      this.getArtifactPath(record.metadata.artifactId),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }

  private async readArtifactFromPath(filePath: string): Promise<VerifierInspectArtifactRecord> {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeArtifactRecord(payload, path.basename(filePath, ".json"));
  }
}

function createArtifactMetadata(input: {
  kind: VerifierInspectArtifactKind;
  sourceReferences: VerifierInspectResolvedReference[];
  policyProfileId: string | null;
  pass: boolean | null;
  hasChanges: boolean | null;
  summary: string;
}): VerifierInspectArtifactMetadata {
  const createdAt = new Date().toISOString();
  return {
    artifactId: createArtifactId(input.kind),
    createdAt,
    kind: input.kind,
    sourceReferences: structuredClone(input.sourceReferences),
    policyProfileId: input.policyProfileId,
    snapshotIds: collectSnapshotIds(input.sourceReferences),
    baselineNames: collectBaselineNames(input.sourceReferences),
    pass: input.pass,
    hasChanges: input.hasChanges,
    bundleId: null,
    workflow: null,
    upload: null,
    summary: input.summary,
  };
}

function applyArtifactMetadata(
  record: VerifierInspectArtifactRecord,
  metadata: VerifierInspectArtifactMetadata,
): VerifierInspectArtifactRecord {
  if ("compare" in record) {
    return {
      metadata: structuredClone(metadata),
      compare: {
        ...structuredClone(record.compare),
        artifact: structuredClone(metadata),
      },
      evidence: structuredClone(record.evidence),
    };
  }
  if ("decision" in record) {
    return {
      metadata: structuredClone(metadata),
      decision: {
        ...structuredClone(record.decision),
        artifact: structuredClone(metadata),
      },
      evidence: structuredClone(record.evidence),
    };
  }
  return {
    metadata: structuredClone(metadata),
    result: {
      ...structuredClone(record.result),
      artifact: structuredClone(metadata),
    },
    evidence: record.evidence ? structuredClone(record.evidence) : null,
  };
}

function createArtifactId(kind: VerifierInspectArtifactKind): string {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
  return `via-${kind}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function collectSnapshotIds(
  references: VerifierInspectResolvedReference[],
): string[] {
  return Array.from(new Set(
    references
      .map((entry) => entry.snapshotId)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  ));
}

function collectBaselineNames(
  references: VerifierInspectResolvedReference[],
): string[] {
  return Array.from(new Set(
    references
      .map((entry) => entry.baselineName)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  ));
}

function summarizeCompareArtifact(compare: VerifierInspectCompareReport): string {
  if (!compare.summary.hasChanges) {
    return `Compare ${compare.left.reference.label} -> ${compare.right.reference.label} recorded no continuity delta.`;
  }
  return `Compare ${compare.left.reference.label} -> ${compare.right.reference.label} changed: final outcome ${compare.summary.finalOutcome.before} -> ${compare.summary.finalOutcome.after}, diagnostic errors ${compare.summary.diagnosticErrors.before} -> ${compare.summary.diagnosticErrors.after}, blocking diagnostics introduced ${compare.summary.blockingDiagnostics.introducedCount}.`;
}

function summarizeEvalArtifact(result: EvalSuiteResult): string {
  const passed = result.summary.passed;
  const total = result.summary.total;
  if (!result.baselineGate) {
    return `Eval suite ${result.suite} completed ${passed}/${total} passed without baseline gate.`;
  }
  return `Eval suite ${result.suite} completed ${passed}/${total} passed with baseline gate ${result.baselineGate.status} under profile ${result.baselinePolicyProfile?.id ?? result.baselineGate.profile.id}.`;
}

function compareArtifactMetadataNewestFirst(
  left: VerifierInspectArtifactMetadata,
  right: VerifierInspectArtifactMetadata,
): number {
  return compareValue(right.createdAt, left.createdAt)
    || compareValue(right.artifactId, left.artifactId);
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

function normalizeArtifactRecord(
  value: unknown,
  fallbackId: string,
): VerifierInspectArtifactRecord {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    throw new Error(`Invalid verifier artifact payload "${fallbackId}".`);
  }
  const metadata = normalizeArtifactMetadata(value.metadata, fallbackId);
  if (metadata.kind === "compare") {
    if (!isRecord(value.compare) || !isRecord(value.evidence)) {
      throw new Error(`Invalid compare artifact payload "${fallbackId}".`);
    }
    return {
      metadata,
      compare: structuredClone({
        ...value.compare,
        artifact: structuredClone(metadata),
      }) as VerifierInspectCompareArtifactRecord["compare"],
      evidence: normalizeArtifactEvidence(value.evidence),
    };
  }
  if (metadata.kind === "gate") {
    if (!isRecord(value.decision) || !isRecord(value.evidence)) {
      throw new Error(`Invalid gate artifact payload "${fallbackId}".`);
    }
    return {
      metadata,
      decision: structuredClone({
        ...value.decision,
        artifact: structuredClone(metadata),
      }) as VerifierRegressionGateArtifactRecord["decision"],
      evidence: normalizeArtifactEvidence(value.evidence),
    };
  }
  if (!isRecord(value.result)) {
    throw new Error(`Invalid eval artifact payload "${fallbackId}".`);
  }
  return {
    metadata,
    result: structuredClone({
      ...value.result,
      artifact: structuredClone(metadata),
    }) as VerifierEvalArtifactRecord["result"],
    evidence: isRecord(value.evidence)
      ? normalizeArtifactEvidence(value.evidence)
      : null,
  };
}

function normalizeArtifactMetadata(
  value: unknown,
  fallbackId: string,
): VerifierInspectArtifactMetadata {
  const record = isRecord(value) ? value : {};
  const kind = toArtifactKind(record.kind) ?? "compare";
  const sourceReferences = Array.isArray(record.sourceReferences)
    ? record.sourceReferences.filter(isRecord).map((entry) => normalizeResolvedReference(entry))
    : [];
  return {
    artifactId: toNonEmptyString(record.artifactId) ?? fallbackId,
    createdAt: toNonEmptyString(record.createdAt) ?? new Date(0).toISOString(),
    kind,
    sourceReferences,
    policyProfileId: toNullableString(record.policyProfileId),
    snapshotIds: toStringArray(record.snapshotIds),
    baselineNames: toStringArray(record.baselineNames),
    pass: typeof record.pass === "boolean" ? record.pass : null,
    hasChanges: typeof record.hasChanges === "boolean" ? record.hasChanges : null,
    bundleId: toNullableString(record.bundleId),
    workflow: normalizeWorkflowProvenance(record.workflow),
    upload: normalizeUploadMetadata(record.upload),
    summary: toNonEmptyString(record.summary) ?? `Verifier ${kind} artifact.`,
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

function normalizeArtifactEvidence(
  value: unknown,
): VerifierInspectArtifactEvidence {
  if (!isRecord(value)) {
    throw new Error("Invalid verifier artifact evidence.");
  }
  return {
    finalOutcome: normalizeValueChange(value.finalOutcome),
    latestVerifierStatus: normalizeValueChange(value.latestVerifierStatus),
    latestRepairStatus: normalizeValueChange(value.latestRepairStatus),
    latestRepairProgress: normalizeValueChange(value.latestRepairProgress),
    diagnosticErrors: normalizeCountDelta(value.diagnosticErrors),
    diagnosticWarnings: normalizeCountDelta(value.diagnosticWarnings),
    diagnosticInfo: normalizeCountDelta(value.diagnosticInfo),
    repairRegressed: normalizeCountDelta(value.repairRegressed),
    blockingDiagnostics: normalizeBlockingDiagnosticsEvidence(value.blockingDiagnostics),
  };
}

function normalizeResolvedReference(
  value: Record<string, unknown>,
): VerifierInspectResolvedReference {
  const kind = toReferenceKind(value.kind) ?? "current";
  const reference = toNullableString(value.reference);
  const scope = toScope(value.scope) ?? "current";
  const snapshotId = toNullableString(value.snapshotId);
  const baselineName = toNullableString(value.baselineName);
  const label = toNonEmptyString(value.label)
    ?? (kind === "snapshot"
      ? `snapshot:${snapshotId ?? reference ?? "unknown"}`
      : kind === "baseline"
        ? `baseline:${baselineName ?? reference ?? "unknown"}`
        : reference ?? kind);
  return {
    kind,
    label,
    reference,
    scope,
    sessionId: toNullableString(value.sessionId),
    traceId: toNullableString(value.traceId),
    replayReference: toNullableString(value.replayReference),
    snapshotId,
    baselineName,
  };
}

function normalizeValueChange<T>(
  value: unknown,
): { before: T; after: T; changed: boolean } | null {
  if (!isRecord(value) || !("changed" in value) || typeof value.changed !== "boolean") {
    return null;
  }
  return {
    before: value.before as T,
    after: value.after as T,
    changed: value.changed,
  };
}

function normalizeCountDelta(
  value: unknown,
): VerifierInspectArtifactEvidence["diagnosticErrors"] {
  if (
    !isRecord(value)
    || typeof value.before !== "number"
    || typeof value.after !== "number"
    || typeof value.delta !== "number"
    || typeof value.changed !== "boolean"
  ) {
    return null;
  }
  return {
    before: value.before,
    after: value.after,
    delta: value.delta,
    changed: value.changed,
  };
}

function normalizeBlockingDiagnosticsEvidence(
  value: unknown,
): VerifierInspectArtifactEvidence["blockingDiagnostics"] {
  if (
    !isRecord(value)
    || typeof value.beforeCount !== "number"
    || typeof value.afterCount !== "number"
    || typeof value.resolvedCount !== "number"
    || typeof value.persistedCount !== "number"
    || typeof value.introducedCount !== "number"
    || typeof value.summary !== "string"
  ) {
    return null;
  }
  return {
    beforeCount: value.beforeCount,
    afterCount: value.afterCount,
    resolvedCount: value.resolvedCount,
    persistedCount: value.persistedCount,
    introducedCount: value.introducedCount,
    summary: value.summary,
  };
}

function toArtifactKind(value: unknown): VerifierInspectArtifactKind | null {
  return value === "compare" || value === "gate" || value === "eval"
    ? value
    : null;
}

function toReferenceKind(
  value: unknown,
): VerifierInspectResolvedReference["kind"] | null {
  return value === "current" || value === "trace" || value === "replay" || value === "snapshot" || value === "baseline"
    ? value
    : null;
}

function toScope(
  value: unknown,
): VerifierInspectResolvedReference["scope"] | null {
  return value === "current" || value === "trace" || value === "replay"
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
