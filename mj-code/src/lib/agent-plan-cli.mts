import type { PlanRenderProfile } from "../types/contracts.js";

import { normalizePlanRenderProfile } from "./agent-plan-inspect.mjs";

export interface ParsedPlanCurrentCommand {
  kind: "current";
  profile: PlanRenderProfile;
}

export interface ParsedPlanTimelineCommand {
  kind: "timeline";
  reference: string;
  profile: PlanRenderProfile;
}

export interface ParsedPlanLegacyAllCommand {
  kind: "legacy_all";
}

export interface ParsedPlanLegacyLastCommand {
  kind: "legacy_last";
}

export interface ParsedPlanLegacyPreviewCommand {
  kind: "legacy_preview";
  prompt: string;
}

export type ParsedPlanCommand =
  | ParsedPlanCurrentCommand
  | ParsedPlanTimelineCommand
  | ParsedPlanLegacyAllCommand
  | ParsedPlanLegacyLastCommand
  | ParsedPlanLegacyPreviewCommand;

export function parsePlanCommandArgs(
  parts: string[],
  usage: string,
  format: string | null = null,
): ParsedPlanCommand {
  if (parts.length === 0) {
    return { kind: "legacy_all" };
  }

  const [head, ...tail] = parts;
  if (head === "last") {
    return { kind: "legacy_last" };
  }
  if (head === "current") {
    if (tail.length > 1) {
      throw new Error(`Usage: ${usage}`);
    }
    return {
      kind: "current",
      profile: normalizePlanRenderProfile(tail[0] ?? format),
    };
  }
  if (head === "timeline") {
    if (tail.length > 2) {
      throw new Error(`Usage: ${usage}`);
    }
    const reference = tail[0] && !isRenderProfileToken(tail[0])
      ? normalizeTimelineReference(tail[0])
      : "current";
    const profileToken = tail[0] && isRenderProfileToken(tail[0])
      ? tail[0]
      : tail[1] ?? format;
    return {
      kind: "timeline",
      reference,
      profile: normalizePlanRenderProfile(profileToken),
    };
  }
  if (head === "replay") {
    if (!tail[0] || tail.length > 2) {
      throw new Error(`Usage: ${usage}`);
    }
    return {
      kind: "timeline",
      reference: `replay:${tail[0]}`,
      profile: normalizePlanRenderProfile(tail[1] ?? format),
    };
  }

  return {
    kind: "legacy_preview",
    prompt: [head, ...tail].join(" ").trim(),
  };
}

function normalizeTimelineReference(value: string): string {
  if (value === "current" || value === "trace" || value === "latest" || value.startsWith("replay:")) {
    return value;
  }
  return `replay:${value}`;
}

function isRenderProfileToken(value: string): boolean {
  return value === "json" || value === "summary" || value === "failures";
}
