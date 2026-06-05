import fs from "node:fs/promises";
import path from "node:path";

import type {
  VerifierGitHubMutationRecord,
  VerifierGitHubMutationSelection,
} from "../types/contracts.js";

import {
  VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
} from "./agent-verifier-inspect-store.mjs";

export const VERIFIER_GITHUB_MUTATION_DIRNAME = "github-mutations";

export class VerifierGitHubMutationStore {
  readonly mutationDir: string;

  constructor(projectStateDir: string) {
    this.mutationDir = path.join(
      projectStateDir,
      VERIFIER_INSPECT_SNAPSHOT_DIRNAME,
      VERIFIER_GITHUB_MUTATION_DIRNAME,
    );
  }

  async writeResult(
    result: VerifierGitHubMutationRecord,
  ): Promise<VerifierGitHubMutationRecord> {
    await fs.mkdir(this.mutationDir, { recursive: true });
    await fs.writeFile(
      this.getResultPath(result.mutationId),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    return structuredClone(result);
  }

  async loadResult(reference: string = "latest"): Promise<VerifierGitHubMutationSelection> {
    await fs.mkdir(this.mutationDir, { recursive: true });
    const normalized = `${reference ?? ""}`.trim() || "latest";
    if (normalized === "latest") {
      const latest = await this.loadLatest();
      return latest
        ? {
            available: true,
            reason: null,
            reference: "latest",
            result: latest,
          }
        : {
            available: false,
            reason: "No verifier GitHub mutation result is available.",
            reference: "latest",
            result: null,
          };
    }
    const mutationId = await this.resolveMutationId(normalized);
    const result = await this.readResultFromPath(this.getResultPath(mutationId));
    return {
      available: true,
      reason: null,
      reference: normalized,
      result,
    };
  }

  async findLatestByHandoffId(
    handoffId: string | null,
  ): Promise<VerifierGitHubMutationRecord | null> {
    if (!handoffId) {
      return null;
    }
    const entries = await this.listAll();
    return entries.find((entry) => entry.handoffId === handoffId) ?? null;
  }

  getResultPath(mutationId: string): string {
    return path.join(this.mutationDir, `${mutationId}.json`);
  }

  private async loadLatest(): Promise<VerifierGitHubMutationRecord | null> {
    const entries = await this.listAll();
    return entries[0] ?? null;
  }

  private async listAll(): Promise<VerifierGitHubMutationRecord[]> {
    await fs.mkdir(this.mutationDir, { recursive: true });
    const entries = await fs.readdir(this.mutationDir, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readResultFromPath(path.join(this.mutationDir, entry.name))),
    );
    return records.sort((left, right) => compareValue(right.createdAt, left.createdAt)
      || compareValue(right.mutationId, left.mutationId));
  }

  private async resolveMutationId(reference: string): Promise<string> {
    const directPath = this.getResultPath(reference);
    try {
      await fs.access(directPath);
      return reference;
    } catch {}
    const entries = await fs.readdir(this.mutationDir, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.basename(entry.name, ".json"))
      .filter((entry) => entry === reference || entry.startsWith(reference));
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(`Could not resolve verifier GitHub mutation "${reference}".`);
  }

  private async readResultFromPath(filePath: string): Promise<VerifierGitHubMutationRecord> {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeMutationRecord(payload, path.basename(filePath, ".json"));
  }
}

function normalizeMutationRecord(
  value: unknown,
  fallbackId: string,
): VerifierGitHubMutationRecord {
  if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.payload)) {
    throw new Error(`Invalid verifier GitHub mutation payload "${fallbackId}".`);
  }
  const request = cloneTyped<VerifierGitHubMutationRecord["request"]>(value.request);
  const payload = cloneTyped<VerifierGitHubMutationRecord["payload"]>(value.payload);
  const response = isRecord(value.response)
    ? cloneTyped<VerifierGitHubMutationRecord["response"]>(value.response)
    : null;
  const workflow = isRecord(value.workflow)
    ? cloneTyped<VerifierGitHubMutationRecord["workflow"]>(value.workflow)
    : null;
  const upload = isRecord(value.upload)
    ? cloneTyped<VerifierGitHubMutationRecord["upload"]>(value.upload)
    : null;
  return {
    mutationId: toNonEmptyString(value.mutationId) ?? fallbackId,
    createdAt: toNonEmptyString(value.createdAt) ?? new Date(0).toISOString(),
    mode: value.mode === "check_run" ? value.mode : "check_run",
    status: toMutationStatus(value.status) ?? "unavailable",
    reasonKind: toReasonKind(value.reasonKind),
    reason: toNullableString(value.reason),
    attempted: value.attempted === true,
    requested: value.requested === true,
    reference: toNonEmptyString(value.reference) ?? "latest",
    handoffId: toNullableString(value.handoffId),
    artifactIds: Array.isArray(value.artifactIds)
      ? value.artifactIds.map((entry) => `${entry ?? ""}`.trim()).filter(Boolean)
      : [],
    bundleId: toNullableString(value.bundleId),
    request,
    response,
    payload,
    workflow,
    upload,
    summary: toNonEmptyString(value.summary) ?? "Verifier GitHub mutation result.",
  };
}

function toMutationStatus(
  value: unknown,
): VerifierGitHubMutationRecord["status"] | null {
  return value === "success"
    || value === "skipped"
    || value === "blocked"
    || value === "unavailable"
    || value === "failed"
    ? value
    : null;
}

function toReasonKind(
  value: unknown,
): VerifierGitHubMutationRecord["reasonKind"] | null {
  return value === "payload_unavailable"
    || value === "github_context_missing"
    || value === "token_missing"
    || value === "repository_missing"
    || value === "sha_missing"
    || value === "permission_denied"
    || value === "api_error"
    || value === "network_error"
    ? value
    : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function cloneTyped<T>(value: unknown): T {
  return structuredClone(value) as T;
}
