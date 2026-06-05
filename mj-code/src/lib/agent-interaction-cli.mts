import type {
  AgentInteractionHistoryScope,
  InteractionRenderProfile,
  SessionBrowserRenderProfile,
} from "../types/contracts.js";

export interface ParsedInteractionStatusCommand {
  profile: InteractionRenderProfile;
}

export interface ParsedInteractionHistoryCommand {
  scope: AgentInteractionHistoryScope;
  reference: string;
  profile: SessionBrowserRenderProfile;
}

export interface ParsedInteractionAboutCommand {
  profile: InteractionRenderProfile;
}

export interface ParsedInteractionResumeCommand {
  kind: "resume" | "recommend" | "lineage";
  reference: string;
  profile: SessionBrowserRenderProfile;
}

export interface ParsedInteractionContinueCommand {
  reference: string;
  profile: SessionBrowserRenderProfile;
}

export function parseInteractionStatusArgs(
  parts: string[],
  usage: string,
  format: string | null = null,
): ParsedInteractionStatusCommand {
  if (parts.length > 1) {
    throw new Error(`Usage: ${usage}`);
  }
  return {
    profile: normalizeInteractionRenderProfile(parts[0] ?? format),
  };
}

export function parseInteractionHistoryArgs(
  parts: string[],
  usage: string,
  format: string | null = null,
): ParsedInteractionHistoryCommand {
  if (parts.length > 3) {
    throw new Error(`Usage: ${usage}`);
  }
  const [first, second, third] = parts;
  const scope = isHistoryScope(first) ? first : "all";
  const remaining = isHistoryScope(first) ? [second, third] : [first, second];
  const reference = scope === "lineage" || scope === "replay"
    ? normalizeInteractionReference(remaining[0])
    : "current";
  const profileToken = scope === "lineage" || scope === "replay"
    ? remaining[1] ?? format
    : remaining[0] ?? format;
  return {
    scope,
    reference,
    profile: normalizeSessionBrowserRenderProfile(profileToken),
  };
}

export function parseInteractionAboutArgs(
  parts: string[],
  usage: string,
  format: string | null = null,
): ParsedInteractionAboutCommand {
  if (parts.length > 1) {
    throw new Error(`Usage: ${usage}`);
  }
  return {
    profile: normalizeInteractionRenderProfile(parts[0] ?? format),
  };
}

export function parseInteractionResumeArgs(
  parts: string[],
  usage: string,
  format: string | null = null,
): ParsedInteractionResumeCommand {
  if (parts.length === 0) {
    throw new Error(`Usage: ${usage}`);
  }
  const [first, second, third] = parts;
  if (first !== "recommend" && first !== "lineage") {
    return {
      kind: "resume",
      reference: first,
      profile: "summary",
    };
  }
  return {
    kind: first,
    reference: normalizeInteractionReference(second),
    profile: normalizeSessionBrowserRenderProfile(third ?? format),
  };
}

export function parseInteractionContinueArgs(
  parts: string[],
  usage: string,
  format: string | null = null,
): ParsedInteractionContinueCommand {
  if (parts.length > 2) {
    throw new Error(`Usage: ${usage}`);
  }
  return {
    reference: normalizeInteractionReference(parts[0]),
    profile: normalizeSessionBrowserRenderProfile(parts[1] ?? format),
  };
}

export function normalizeInteractionRenderProfile(
  value: string | null | undefined,
): InteractionRenderProfile {
  return value === "json" ? "json" : "summary";
}

export function normalizeSessionBrowserRenderProfile(
  value: string | null | undefined,
): SessionBrowserRenderProfile {
  return value === "json" || value === "failures"
    ? value
    : "summary";
}

function isHistoryScope(value: string | undefined): value is AgentInteractionHistoryScope {
  return value === "all" || value === "changes" || value === "sessions" || value === "lineage" || value === "replay";
}

function normalizeInteractionReference(value: string | undefined): string {
  if (!value || value === "summary" || value === "json" || value === "failures") {
    return "current";
  }
  return value;
}
