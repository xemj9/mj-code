import crypto from "node:crypto";

import type {
  VerifierGitHubChecksPayload,
  VerifierGitHubMutationAction,
  VerifierGitHubMutationRecord,
  VerifierGitHubMutationReasonKind,
  VerifierGitHubMutationRequest,
  VerifierGitHubMutationRequestPayloadSummary,
  VerifierGitHubMutationResponse,
  VerifierGitHubMutationTarget,
} from "../types/contracts.js";

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<FetchLikeResponse>;

export async function applyVerifierGitHubMutation(input: {
  reference: string;
  payload: VerifierGitHubChecksPayload;
  existing: VerifierGitHubMutationRecord | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}): Promise<VerifierGitHubMutationRecord> {
  const env = input.env ?? process.env;
  const createdAt = new Date().toISOString();
  const mutationId = createGitHubMutationId();
  const token = trimEnv(env.GITHUB_TOKEN);
  const payload = structuredClone(input.payload);
  const apiUrl = trimEnv(env.GITHUB_API_URL) ?? "https://api.github.com";
  const repository = payload.workflow?.repository ?? trimEnv(env.GITHUB_REPOSITORY);
  const headSha = payload.workflow?.sha ?? trimEnv(env.GITHUB_SHA);
  const existingCheckRunId = input.existing?.response?.checkRunId ?? null;
  const target = createMutationTarget({
    apiUrl,
    repository,
    headSha,
    checkRunId: existingCheckRunId,
  });
  const request = createMutationRequest({
    mutationId,
    createdAt,
    reference: input.reference,
    payload,
    target,
  });

  if (!payload.available) {
    return createMutationResult({
      mutationId,
      createdAt,
      reference: input.reference,
      payload,
      request,
      status: "unavailable",
      reasonKind: "payload_unavailable",
      reason: payload.reason ?? "Verifier checks payload is unavailable.",
      attempted: false,
      response: null,
    });
  }
  if (!repository && !payload.workflow?.repository) {
    return createMutationResult({
      mutationId,
      createdAt,
      reference: input.reference,
      payload,
      request,
      status: "unavailable",
      reasonKind: "repository_missing",
      reason: "GitHub repository context is unavailable for live mutation.",
      attempted: false,
      response: null,
    });
  }
  if (!headSha) {
    return createMutationResult({
      mutationId,
      createdAt,
      reference: input.reference,
      payload,
      request,
      status: "unavailable",
      reasonKind: "sha_missing",
      reason: "GitHub head SHA is unavailable for live mutation.",
      attempted: false,
      response: null,
    });
  }
  if (!token) {
    return createMutationResult({
      mutationId,
      createdAt,
      reference: input.reference,
      payload,
      request,
      status: "unavailable",
      reasonKind: "token_missing",
      reason: "GITHUB_TOKEN is unavailable; live GitHub mutation was skipped.",
      attempted: false,
      response: null,
    });
  }

  const owner = target.owner;
  const repo = target.repo;
  if (!owner || !repo) {
    return createMutationResult({
      mutationId,
      createdAt,
      reference: input.reference,
      payload,
      request,
      status: "unavailable",
      reasonKind: "repository_missing",
      reason: "GitHub repository owner/name could not be resolved for live mutation.",
      attempted: false,
      response: null,
    });
  }

  const action: VerifierGitHubMutationAction = existingCheckRunId != null
    ? "update"
    : "create";
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) {
    return createMutationResult({
      mutationId,
      createdAt,
      reference: input.reference,
      payload,
      request: {
        ...request,
        action,
      },
      status: "unavailable",
      reasonKind: "github_context_missing",
      reason: "No fetch implementation is available for live GitHub mutation.",
      attempted: false,
      response: null,
    });
  }

  const endpoint = action === "create"
    ? `${apiUrl}/repos/${owner}/${repo}/check-runs`
    : `${apiUrl}/repos/${owner}/${repo}/check-runs/${existingCheckRunId}`;
  const body = JSON.stringify(buildCheckRunBody(payload, headSha, existingCheckRunId));
  try {
    const response = await fetchImpl(endpoint, {
      method: action === "create" ? "POST" : "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body,
    });
    if (!response.ok) {
      const errorBody = await readResponseBody(response);
      return createMutationResult({
        mutationId,
        createdAt,
        reference: input.reference,
        payload,
        request: {
          ...request,
          action,
        },
        status: response.status === 403 ? "blocked" : "failed",
        reasonKind: response.status === 403 ? "permission_denied" : "api_error",
        reason: `GitHub check run ${action} failed with HTTP ${response.status}. ${errorBody}`.trim(),
        attempted: true,
        response: {
          httpStatus: response.status,
          checkRunId: existingCheckRunId,
          checkRunUrl: null,
          detailsUrl: payload.upload?.artifactUrl ?? null,
          summary: `GitHub API returned HTTP ${response.status}.`,
        },
      });
    }
    const data = await response.json();
    const parsed = parseCheckRunResponse(data);
    return createMutationResult({
      mutationId,
      createdAt,
      reference: input.reference,
      payload,
      request: {
        ...request,
        action,
      },
      status: "success",
      reasonKind: null,
      reason: null,
      attempted: true,
      response: {
        httpStatus: response.status,
        checkRunId: parsed.id,
        checkRunUrl: parsed.htmlUrl,
        detailsUrl: parsed.detailsUrl,
        summary: `GitHub check run ${action} succeeded as ${parsed.id != null ? `#${parsed.id}` : "unknown id"}.`,
      },
    });
  } catch (error) {
    return createMutationResult({
      mutationId,
      createdAt,
      reference: input.reference,
      payload,
      request: {
        ...request,
        action,
      },
      status: "failed",
      reasonKind: "network_error",
      reason: error instanceof Error
        ? `GitHub check run ${action} failed: ${error.message}`
        : "GitHub check run mutation failed with an unknown network error.",
      attempted: true,
      response: null,
    });
  }
}

function buildCheckRunBody(
  payload: VerifierGitHubChecksPayload,
  headSha: string,
  existingCheckRunId: number | null,
): Record<string, unknown> {
  return {
    name: payload.name,
    head_sha: headSha,
    status: payload.status,
    conclusion: payload.conclusion,
    external_id: payload.handoffId ?? payload.artifactIds[0] ?? null,
    details_url: payload.upload?.artifactUrl ?? null,
    output: {
      title: payload.title,
      summary: payload.summary,
      text: payload.text,
      annotations: payload.annotations.map((annotation) => ({
        path: annotation.path ?? ".",
        start_line: annotation.startLine ?? 1,
        end_line: annotation.endLine ?? annotation.startLine ?? 1,
        start_column: annotation.startColumn ?? undefined,
        end_column: annotation.endColumn ?? annotation.endLine ?? undefined,
        annotation_level: annotation.level,
        title: annotation.title,
        message: annotation.message,
      })),
    },
    ...(existingCheckRunId == null ? {} : {}),
  };
}

function createMutationTarget(input: {
  apiUrl: string;
  repository: string | null;
  headSha: string | null;
  checkRunId: number | null;
}): VerifierGitHubMutationTarget {
  const [owner, repo] = (input.repository ?? "").split("/", 2);
  return {
    apiUrl: input.apiUrl,
    repository: input.repository,
    owner: owner?.trim() || null,
    repo: repo?.trim() || null,
    headSha: input.headSha,
    checkRunId: input.checkRunId,
  };
}

function createMutationRequest(input: {
  mutationId: string;
  createdAt: string;
  reference: string;
  payload: VerifierGitHubChecksPayload;
  target: VerifierGitHubMutationTarget;
}): VerifierGitHubMutationRequest {
  return {
    mutationId: input.mutationId,
    createdAt: input.createdAt,
    mode: "check_run",
    action: null,
    reference: input.reference,
    handoffId: input.payload.handoffId,
    artifactIds: structuredClone(input.payload.artifactIds),
    bundleId: input.payload.bundleId,
    payload: createPayloadSummary(input.payload),
    target: input.target,
  };
}

function createPayloadSummary(
  payload: VerifierGitHubChecksPayload,
): VerifierGitHubMutationRequestPayloadSummary {
  return {
    name: payload.name,
    title: payload.title,
    conclusion: payload.conclusion,
    summary: payload.summary,
    text: payload.text,
    annotationCount: payload.annotationTotal,
    annotationTruncated: payload.annotationTruncated,
  };
}

function createMutationResult(input: {
  mutationId: string;
  createdAt: string;
  reference: string;
  payload: VerifierGitHubChecksPayload;
  request: VerifierGitHubMutationRequest;
  status: VerifierGitHubMutationRecord["status"];
  reasonKind: VerifierGitHubMutationReasonKind | null;
  reason: string | null;
  attempted: boolean;
  response: VerifierGitHubMutationResponse | null;
}): VerifierGitHubMutationRecord {
  const summary = summarizeMutationResult(input.status, input.reason, input.response);
  return {
    mutationId: input.mutationId,
    createdAt: input.createdAt,
    mode: "check_run",
    status: input.status,
    reasonKind: input.reasonKind,
    reason: input.reason,
    attempted: input.attempted,
    requested: true,
    reference: input.reference,
    handoffId: input.payload.handoffId,
    artifactIds: structuredClone(input.payload.artifactIds),
    bundleId: input.payload.bundleId,
    request: structuredClone(input.request),
    response: input.response ? structuredClone(input.response) : null,
    payload: structuredClone(input.payload),
    workflow: input.payload.workflow ? structuredClone(input.payload.workflow) : null,
    upload: input.payload.upload ? structuredClone(input.payload.upload) : null,
    summary,
  };
}

function summarizeMutationResult(
  status: VerifierGitHubMutationRecord["status"],
  reason: string | null,
  response: VerifierGitHubMutationResponse | null,
): string {
  if (status === "success") {
    return response?.summary ?? "GitHub check run mutation succeeded.";
  }
  if (reason) {
    return reason;
  }
  return `GitHub check run mutation ended with status ${status}.`;
}

async function readResponseBody(
  response: FetchLikeResponse,
): Promise<string> {
  try {
    const json = await response.json();
    if (isRecord(json) && typeof json.message === "string" && json.message.trim()) {
      return json.message.trim();
    }
    return JSON.stringify(json);
  } catch {
    try {
      return (await response.text()).trim();
    } catch {
      return "";
    }
  }
}

function parseCheckRunResponse(
  value: unknown,
): {
  id: number | null;
  htmlUrl: string | null;
  detailsUrl: string | null;
} {
  if (!isRecord(value)) {
    return {
      id: null,
      htmlUrl: null,
      detailsUrl: null,
    };
  }
  return {
    id: typeof value.id === "number" ? value.id : null,
    htmlUrl: typeof value.html_url === "string" && value.html_url.trim()
      ? value.html_url.trim()
      : null,
    detailsUrl: typeof value.details_url === "string" && value.details_url.trim()
      ? value.details_url.trim()
      : null,
  };
}

function createGitHubMutationId(): string {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replaceAll(".", "");
  return `vigm-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function trimEnv(value: string | undefined): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
