import type {
  DiagnosticFingerprint,
  VerifierArtifactWorkflowProvenance,
  VerifierArtifactUploadMetadata,
  VerifierGitHubActionsBackfillInput,
  VerifierGitHubChecksAnnotation,
  VerifierGitHubChecksPayload,
  VerifierGitHubMutationRecord,
  VerifierReleaseAffectedFileSummary,
  VerifierReleaseHandoffRecord,
  VerifierReleaseHandoffSelection,
  VerifierReleaseTriageSummary,
} from "../types/contracts.js";

const MAX_TRIAGE_REASONS = 5;
const MAX_CHECK_ANNOTATIONS = 5;

export function createUnavailableVerifierReleaseTriageSummary(
  reason: string | null = null,
): VerifierReleaseTriageSummary {
  return {
    available: false,
    reason: reason ?? "No verifier release handoff is available.",
    createdAt: new Date().toISOString(),
    sourceKind: "unavailable",
    status: "unavailable",
    pass: null,
    policyProfileId: null,
    baselineName: null,
    baselineReferenceLabel: null,
    targetReferenceLabel: null,
    handoffId: null,
    primaryArtifactId: null,
    artifactIds: [],
    bundleId: null,
    snapshotIds: [],
    sourceReferences: [],
    finalOutcome: null,
    latestVerifierStatus: null,
    latestRepairStatus: null,
    promotionStatus: "unavailable",
    promotionEligible: null,
    promotionSummary: null,
    topReasons: [],
    blockingDiagnostics: null,
    topAffectedFiles: [],
    githubMutation: null,
    workflow: null,
    upload: null,
    summary: reason ?? "No verifier release handoff is available.",
  };
}

export function createVerifierReleaseTriageSummaryFromSelection(
  selection: VerifierReleaseHandoffSelection,
  options: {
    githubMutation?: VerifierGitHubMutationRecord | null;
  } = {},
): VerifierReleaseTriageSummary {
  if (!selection.handoff) {
    return createUnavailableVerifierReleaseTriageSummary(selection.reason);
  }
  return createVerifierReleaseTriageSummaryFromHandoff(selection.handoff, options);
}

export function createVerifierReleaseTriageSummaryFromHandoff(
  handoff: VerifierReleaseHandoffRecord,
  options: {
    githubMutation?: VerifierGitHubMutationRecord | null;
  } = {},
): VerifierReleaseTriageSummary {
  const baselineReference = handoff.sourceReferences.find((entry) => entry.kind === "baseline") ?? null;
  const targetReference = [...handoff.sourceReferences]
    .reverse()
    .find((entry) => entry.kind !== "baseline")
    ?? handoff.sourceReferences.at(-1)
    ?? null;
  const promotion = resolvePromotionStatus(handoff);
  return {
    available: true,
    reason: null,
    createdAt: handoff.metadata.createdAt,
    sourceKind: handoff.metadata.sourceKind,
    status: handoff.metadata.status,
    pass: handoff.metadata.pass,
    policyProfileId: handoff.metadata.policyProfileId,
    baselineName: handoff.baselineName ?? handoff.metadata.baselineNames[0] ?? null,
    baselineReferenceLabel: baselineReference?.label ?? null,
    targetReferenceLabel: targetReference?.label ?? null,
    handoffId: handoff.metadata.handoffId,
    primaryArtifactId: handoff.metadata.primaryArtifactId,
    artifactIds: structuredClone(handoff.metadata.artifactIds),
    bundleId: handoff.metadata.bundleId,
    snapshotIds: structuredClone(handoff.metadata.snapshotIds),
    sourceReferences: handoff.sourceReferences.map((entry) => structuredClone(entry)),
    finalOutcome: handoff.finalOutcome?.after ?? null,
    latestVerifierStatus: handoff.latestVerifierStatus?.after ?? null,
    latestRepairStatus: handoff.latestRepairStatus?.after ?? null,
    promotionStatus: promotion.status,
    promotionEligible: promotion.eligible,
    promotionSummary: promotion.summary,
    topReasons: handoff.topReasons.slice(0, MAX_TRIAGE_REASONS).map((entry) => structuredClone(entry)),
    blockingDiagnostics: handoff.blockingDiagnostics ? structuredClone(handoff.blockingDiagnostics) : null,
    topAffectedFiles: collectTopAffectedFiles(handoff),
    githubMutation: options.githubMutation ? structuredClone(options.githubMutation) : null,
    workflow: handoff.metadata.workflow ? structuredClone(handoff.metadata.workflow) : null,
    upload: handoff.metadata.upload ? structuredClone(handoff.metadata.upload) : null,
    summary: buildTriageSummary(handoff, promotion.summary),
  };
}

export function createVerifierGitHubChecksPayloadFromSelection(
  selection: VerifierReleaseHandoffSelection,
  input: {
    name?: string | null;
    githubMutation?: VerifierGitHubMutationRecord | null;
  } = {},
): VerifierGitHubChecksPayload {
  const triage = createVerifierReleaseTriageSummaryFromSelection(selection, {
    githubMutation: input.githubMutation ?? null,
  });
  return createVerifierGitHubChecksPayload(triage, input);
}

export function createVerifierGitHubChecksPayload(
  triage: VerifierReleaseTriageSummary,
  input: {
    name?: string | null;
  } = {},
): VerifierGitHubChecksPayload {
  const annotations = triage.blockingDiagnostics
    ? collectAnnotations(triage.blockingDiagnostics.introduced, triage.blockingDiagnostics.persisted)
    : {
        items: [],
        total: 0,
        truncated: false,
      };
  const name = `${input.name ?? "verifier-release-gate"}`.trim() || "verifier-release-gate";
  const available = triage.available;
  const conclusion = !available
    ? "neutral"
    : triage.pass === false
      ? "failure"
      : "success";
  const title = !available
    ? "Verifier continuity unavailable"
    : triage.pass === false
      ? "Verifier regression gate failed"
      : triage.sourceKind === "baseline_promotion"
        ? "Verifier baseline promotion applied"
        : "Verifier regression gate passed";
  return {
    available,
    reason: triage.reason,
    createdAt: triage.createdAt,
    name,
    status: "completed",
    conclusion,
    title,
    summary: triage.summary,
    text: buildChecksText(triage),
    policyProfileId: triage.policyProfileId,
    baselineReferenceLabel: triage.baselineReferenceLabel,
    targetReferenceLabel: triage.targetReferenceLabel,
    handoffId: triage.handoffId,
    artifactIds: structuredClone(triage.artifactIds),
    bundleId: triage.bundleId,
    topReasons: triage.topReasons.map((entry) => structuredClone(entry)),
    topAffectedFiles: triage.topAffectedFiles.map((entry) => structuredClone(entry)),
    annotations: annotations.items,
    annotationTotal: annotations.total,
    annotationTruncated: annotations.truncated,
    triage: structuredClone(triage),
    workflow: triage.workflow ? structuredClone(triage.workflow) : null,
    upload: triage.upload ? structuredClone(triage.upload) : null,
  };
}

export function createVerifierGitHubActionsBackfillInputFromEnv(
  env: NodeJS.ProcessEnv,
): VerifierGitHubActionsBackfillInput | null {
  const workflow = createWorkflowProvenanceFromEnv(env);
  const upload = createUploadMetadataFromEnv(env);
  if (!workflow && !upload) {
    return null;
  }
  return {
    workflow,
    upload,
  };
}

function resolvePromotionStatus(
  handoff: VerifierReleaseHandoffRecord,
): {
  status: VerifierReleaseTriageSummary["promotionStatus"];
  eligible: boolean | null;
  summary: string | null;
} {
  if (handoff.metadata.sourceKind === "baseline_promotion") {
    return {
      status: "applied",
      eligible: true,
      summary: handoff.summary,
    };
  }
  if (
    handoff.metadata.sourceKind !== "gate"
    && handoff.metadata.sourceKind !== "eval"
  ) {
    return {
      status: "unavailable",
      eligible: null,
      summary: "Promotion eligibility requires a gate or baseline-aware eval handoff.",
    };
  }
  if (!(handoff.baselineName ?? handoff.metadata.baselineNames[0])) {
    return {
      status: "unavailable",
      eligible: null,
      summary: "Promotion eligibility is unavailable because the handoff is not tied to a named baseline.",
    };
  }
  if (handoff.metadata.pass === false) {
    return {
      status: "blocked",
      eligible: false,
      summary: `Promotion is blocked because the latest ${handoff.metadata.sourceKind} handoff failed.`,
    };
  }
  return {
    status: "eligible",
    eligible: true,
    summary: `Promotion is eligible because the latest ${handoff.metadata.sourceKind} handoff passed under policy ${handoff.metadata.policyProfileId ?? "default"}.`,
  };
}

function buildTriageSummary(
  handoff: VerifierReleaseHandoffRecord,
  promotionSummary: string | null,
): string {
  const base = handoff.metadata.pass === false
    ? `Verifier ${handoff.metadata.sourceKind} handoff ${handoff.metadata.handoffId} failed.`
    : handoff.metadata.sourceKind === "baseline_promotion"
      ? `Verifier baseline promotion ${handoff.baselinePromotionId ?? handoff.metadata.handoffId} applied.`
      : `Verifier ${handoff.metadata.sourceKind} handoff ${handoff.metadata.handoffId} passed.`;
  return promotionSummary
    ? `${base} ${promotionSummary}`
    : base;
}

function buildChecksText(
  triage: VerifierReleaseTriageSummary,
): string {
  const lines = [
    `policy profile: ${triage.policyProfileId ?? "none"}`,
    `baseline: ${triage.baselineReferenceLabel ?? triage.baselineName ?? "none"}`,
    `target: ${triage.targetReferenceLabel ?? "none"}`,
    `promotion: ${triage.promotionStatus}${triage.promotionSummary ? ` (${triage.promotionSummary})` : ""}`,
    `handoff: ${triage.handoffId ?? "none"}`,
    `primary artifact: ${triage.primaryArtifactId ?? "none"}`,
    `bundle: ${triage.bundleId ?? "none"}`,
  ];
  if (triage.topReasons.length > 0) {
    lines.push("", "top reasons:");
    for (const reason of triage.topReasons) {
      lines.push(`- [${reason.severity}] ${reason.summary}`);
    }
  }
  if (triage.blockingDiagnostics) {
    lines.push(
      "",
      `blocking diagnostics: introduced ${triage.blockingDiagnostics.introducedCount}, resolved ${triage.blockingDiagnostics.resolvedCount}, persisted ${triage.blockingDiagnostics.persistedCount}`,
    );
  }
  if (triage.topAffectedFiles.length > 0) {
    lines.push("", "top affected files:");
    for (const file of triage.topAffectedFiles.slice(0, 3)) {
      lines.push(`- ${file.path}: introduced ${file.introducedCount}, persisted ${file.persistedCount}, total ${file.totalCount}`);
    }
  }
  if (triage.githubMutation) {
    lines.push(
      "",
      `github mutation: ${triage.githubMutation.status}${triage.githubMutation.reason ? ` (${triage.githubMutation.reason})` : ""}`,
    );
  }
  if (triage.upload?.artifactUrl) {
    lines.push("", `artifact url: ${triage.upload.artifactUrl}`);
  }
  return lines.join("\n");
}

function collectTopAffectedFiles(
  handoff: VerifierReleaseHandoffRecord,
): VerifierReleaseAffectedFileSummary[] {
  const blockingDiagnostics = handoff.blockingDiagnostics;
  if (!blockingDiagnostics) {
    return [];
  }
  const counts = new Map<string, VerifierReleaseAffectedFileSummary>();
  for (const item of blockingDiagnostics.introduced) {
    const path = `${item.path ?? ""}`.trim();
    if (!path) {
      continue;
    }
    const current = counts.get(path) ?? {
      path,
      introducedCount: 0,
      persistedCount: 0,
      totalCount: 0,
    };
    current.introducedCount += 1;
    current.totalCount = current.introducedCount + current.persistedCount;
    counts.set(path, current);
  }
  for (const item of blockingDiagnostics.persisted) {
    const path = `${item.path ?? ""}`.trim();
    if (!path) {
      continue;
    }
    const current = counts.get(path) ?? {
      path,
      introducedCount: 0,
      persistedCount: 0,
      totalCount: 0,
    };
    current.persistedCount += 1;
    current.totalCount = current.introducedCount + current.persistedCount;
    counts.set(path, current);
  }
  return [...counts.values()]
    .sort((left, right) => right.totalCount - left.totalCount
      || right.introducedCount - left.introducedCount
      || left.path.localeCompare(right.path))
    .slice(0, 5);
}

function collectAnnotations(
  introduced: DiagnosticFingerprint[],
  persisted: DiagnosticFingerprint[],
): {
  items: VerifierGitHubChecksAnnotation[];
  total: number;
  truncated: boolean;
} {
  const combined = [...introduced, ...persisted]
    .sort(compareDiagnosticFingerprints)
    .slice(0, MAX_CHECK_ANNOTATIONS)
    .map((entry) => createAnnotation(entry));
  const total = introduced.length + persisted.length;
  return {
    items: combined,
    total,
    truncated: total > combined.length,
  };
}

function createAnnotation(
  fingerprint: DiagnosticFingerprint,
): VerifierGitHubChecksAnnotation {
  const titleParts = [fingerprint.code, fingerprint.source].filter((entry) => entry);
  return {
    fingerprint: structuredClone(fingerprint),
    path: fingerprint.path,
    startLine: fingerprint.line,
    endLine: fingerprint.line,
    startColumn: fingerprint.column,
    endColumn: fingerprint.column,
    level: "failure",
    title: titleParts.length > 0 ? titleParts.join(" / ") : "blocking diagnostic",
    message: fingerprint.message,
  };
}

function compareDiagnosticFingerprints(
  left: DiagnosticFingerprint,
  right: DiagnosticFingerprint,
): number {
  return compareNullableString(left.path, right.path)
    || compareNullableNumber(left.line, right.line)
    || compareNullableNumber(left.column, right.column)
    || compareNullableString(left.code, right.code)
    || compareNullableString(left.message, right.message);
}

function compareNullableString(
  left: string | null,
  right: string | null,
): number {
  const leftValue = left ?? "";
  const rightValue = right ?? "";
  if (leftValue < rightValue) {
    return -1;
  }
  if (leftValue > rightValue) {
    return 1;
  }
  return 0;
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
): number {
  return (left ?? -1) - (right ?? -1);
}

function createWorkflowProvenanceFromEnv(
  env: NodeJS.ProcessEnv,
): VerifierArtifactWorkflowProvenance | null {
  const runId = trimEnv(env.GITHUB_RUN_ID);
  const workflow = trimEnv(env.GITHUB_WORKFLOW);
  const job = trimEnv(env.GITHUB_JOB);
  const sha = trimEnv(env.GITHUB_SHA);
  const ref = trimEnv(env.GITHUB_REF);
  const eventName = trimEnv(env.GITHUB_EVENT_NAME);
  const repository = trimEnv(env.GITHUB_REPOSITORY);
  const serverUrl = trimEnv(env.GITHUB_SERVER_URL);
  const runAttempt = trimEnv(env.GITHUB_RUN_ATTEMPT);
  const actor = trimEnv(env.GITHUB_ACTOR);
  if (![runId, workflow, job, sha, ref, eventName, repository, serverUrl, runAttempt, actor].some(Boolean)) {
    return null;
  }
  return {
    provider: "github_actions",
    runId,
    runAttempt,
    workflow,
    job,
    sha,
    ref,
    eventName,
    repository,
    serverUrl,
    actor,
  };
}

function createUploadMetadataFromEnv(
  env: NodeJS.ProcessEnv,
): VerifierArtifactUploadMetadata | null {
  const artifactName = trimEnv(env.MJ_VERIFIER_UPLOAD_NAME);
  const artifactId = trimEnv(env.MJ_VERIFIER_UPLOAD_ARTIFACT_ID);
  const artifactUrl = trimEnv(env.MJ_VERIFIER_UPLOAD_ARTIFACT_URL);
  const artifactDigest = trimEnv(env.MJ_VERIFIER_UPLOAD_ARTIFACT_DIGEST);
  const retentionDays = trimIntegerEnv(env.MJ_VERIFIER_UPLOAD_RETENTION_DAYS);
  if (![artifactName, artifactId, artifactUrl, artifactDigest, retentionDays].some((entry) => entry != null)) {
    return null;
  }
  return {
    provider: "github_actions_upload_artifact",
    artifactName,
    artifactId,
    artifactUrl,
    artifactDigest,
    retentionDays,
    uploadedAt: new Date().toISOString(),
  };
}

function trimEnv(value: string | undefined): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function trimIntegerEnv(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}
