import type { CitationSummary } from "../types/contracts.js";

export function buildLegacyApprovalPrompt(approvalContext: {
  touchedPaths?: string[];
  rollbackAvailable?: boolean;
  toolName: string;
  risk?: { level?: string; score?: number } | null;
}): string {
  const touched = approvalContext.touchedPaths?.length
    ? ` paths=${approvalContext.touchedPaths.slice(0, 3).join(", ")}`
    : "";
  const rollback = approvalContext.rollbackAvailable ? " rollback=yes" : " rollback=no";
  const risk = approvalContext.risk
    ? ` risk=${approvalContext.risk.level}:${approvalContext.risk.score}`
    : "";
  return `Allow ${approvalContext.toolName}?${risk}${touched}${rollback}`;
}

export function classifyErrorTaxonomy(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === "object" &&
    "taxonomy" in error &&
    typeof error.taxonomy === "string"
  ) {
    return error.taxonomy;
  }

  const message = `${extractMessage(error)}`.toLowerCase();
  if (message.includes("provider")) {
    return "provider_error";
  }
  if (message.includes("mcp")) {
    return "mcp_error";
  }
  if (message.includes("network") || message.includes("search provider") || message.includes("robots")) {
    return "network_error";
  }
  if (message.includes("shell") && message.includes("timeout")) {
    return "shell_timeout";
  }
  if (message.includes("shell")) {
    return "shell_error";
  }
  if (message.includes("approval")) {
    return "approval_denied";
  }
  if (message.includes("permission")) {
    return "permission_error";
  }
  if (message.includes("schema")) {
    return "tool_schema_error";
  }
  if (message.includes("context")) {
    return "context_budget_error";
  }
  if (message.includes("rollback")) {
    return "rollback_error";
  }
  return fallback;
}

export function summarizeText(text: unknown, maxChars = 160): string {
  const normalized = `${text ?? ""}`.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 3)}...`;
}

export function summarizeToolResult(result: unknown): string {
  if (result == null) {
    return "ok";
  }

  if (typeof result === "string") {
    return summarizeText(result, 180);
  }

  if (typeof result === "object") {
    return summarizeText(JSON.stringify(result), 180);
  }

  return `${result}`;
}

export function applySourceCitationsToFinalContent(
  content: string,
  citations: CitationSummary[] | null | undefined,
): string {
  const normalizedCitations = Array.isArray(citations)
    ? citations.filter((entry) => entry?.sourceId && entry?.url)
    : [];
  if (normalizedCitations.length === 0) {
    return content;
  }

  if (/\[S\d+\]/.test(content)) {
    return content;
  }

  const unique: CitationSummary[] = [];
  const seen = new Set<string>();
  for (const citation of normalizedCitations) {
    if (seen.has(citation.sourceId)) {
      continue;
    }
    seen.add(citation.sourceId);
    unique.push(citation);
  }

  const sourceBlock = unique
    .slice(0, 6)
    .map((entry) => `[${entry.sourceId}] ${entry.title} - ${entry.url}`)
    .join("\n");

  return `${content}\n\nSources:\n${sourceBlock}`;
}

export function isPreviewRequiredTool(toolName: string): boolean {
  return ["write_file", "replace_in_file", "apply_patch"].includes(toolName);
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return `${error.message ?? ""}`;
  }
  return `${error ?? ""}`;
}
