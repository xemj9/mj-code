import type {
  VerifierBaselinePromotionHistoryRenderProfile,
  VerifierBaselinePromotionRenderProfile,
  VerifierDrilldownRenderProfile,
  VerifierGitHubChecksRenderProfile,
  VerifierGitHubMutationRenderProfile,
  VerifierInspectArtifactListRenderProfile,
  VerifierInspectArtifactPruneRenderProfile,
  VerifierInspectArtifactRenderProfile,
  VerifierInspectBaselineRenderProfile,
  VerifierInspectCompareRenderProfile,
  VerifierInspectArtifactRetentionPolicy,
  VerifierInspectReference,
  VerifierInspectRenderProfile,
  VerifierInspectSnapshotRenderProfile,
  VerifierReleaseBundleRenderProfile,
  VerifierReleaseHandoffRenderProfile,
  VerifierReleaseTriageRenderProfile,
  VerifierRegressionGatePolicyProfileRenderProfile,
  VerifierRegressionGateRenderProfile,
  VerifierTimelineRenderProfile,
} from "../types/contracts.js";

import {
  normalizeVerifierBaselinePromotionHistoryRenderProfile,
  normalizeVerifierBaselinePromotionRenderProfile,
  normalizeVerifierDrilldownRenderProfile,
  normalizeVerifierGitHubChecksRenderProfile,
  normalizeVerifierGitHubMutationRenderProfile,
  normalizeVerifierInspectArtifactListRenderProfile,
  normalizeVerifierInspectArtifactPruneRenderProfile,
  normalizeVerifierInspectArtifactRenderProfile,
  normalizeVerifierInspectBaselineRenderProfile,
  normalizeVerifierInspectCompareRenderProfile,
  normalizeVerifierInspectRenderProfile,
  normalizeVerifierInspectSnapshotRenderProfile,
  normalizeVerifierReleaseBundleRenderProfile,
  normalizeVerifierReleaseHandoffRenderProfile,
  normalizeVerifierReleaseTriageRenderProfile,
  normalizeVerifierRegressionGatePolicyProfileRenderProfile,
  normalizeVerifierRegressionGateRenderProfile,
  normalizeVerifierTimelineRenderProfile,
} from "./agent-verifier-inspect-render.mjs";

export interface ParsedVerifierInspectInspectCommand {
  kind: "inspect";
  reference: VerifierInspectReference;
  profile: VerifierInspectRenderProfile;
}

export interface ParsedVerifierInspectExportCommand {
  kind: "export";
  reference: VerifierInspectReference;
  profile: VerifierInspectSnapshotRenderProfile;
}

export interface ParsedVerifierInspectExportsCommand {
  kind: "exports";
  limit: number;
  profile: VerifierInspectSnapshotRenderProfile;
}

export interface ParsedVerifierInspectBaselinePinCommand {
  kind: "baseline_pin";
  reference: VerifierInspectReference;
  name: string;
  profile: VerifierInspectBaselineRenderProfile;
  policyProfileId: string | null;
}

export interface ParsedVerifierInspectBaselinesCommand {
  kind: "baselines";
  limit: number;
  profile: VerifierInspectBaselineRenderProfile;
}

export interface ParsedVerifierInspectCompareCommand {
  kind: "compare";
  left: VerifierInspectReference;
  right: VerifierInspectReference;
  profile: VerifierInspectCompareRenderProfile;
  writeArtifact: boolean;
  writeBundle: boolean;
}

export interface ParsedVerifierInspectGateCommand {
  kind: "gate";
  left: VerifierInspectReference;
  right: VerifierInspectReference;
  profile: VerifierRegressionGateRenderProfile;
  policyProfileId: string | null;
  writeArtifact: boolean;
  writeBundle: boolean;
}

export interface ParsedVerifierInspectPoliciesCommand {
  kind: "policies";
  profile: VerifierRegressionGatePolicyProfileRenderProfile;
}

export interface ParsedVerifierInspectArtifactsCommand {
  kind: "artifacts";
  limit: number;
  profile: VerifierInspectArtifactListRenderProfile;
}

export interface ParsedVerifierInspectArtifactCommand {
  kind: "artifact";
  artifactId: string;
  profile: VerifierInspectArtifactRenderProfile;
}

export interface ParsedVerifierInspectHandoffCommand {
  kind: "handoff";
  reference: string;
  profile: VerifierReleaseHandoffRenderProfile;
}

export interface ParsedVerifierInspectHandoffExportCommand {
  kind: "handoff_export";
  reference: string;
  profile: VerifierReleaseBundleRenderProfile;
}

export interface ParsedVerifierInspectArtifactsPruneCommand {
  kind: "artifacts_prune";
  profile: VerifierInspectArtifactPruneRenderProfile;
  policy: Partial<VerifierInspectArtifactRetentionPolicy>;
}

export interface ParsedVerifierBaselinePromotionPlanCommand {
  kind: "promotion_plan";
  baselineName: string;
  reference: string;
  profile: VerifierBaselinePromotionRenderProfile;
  policyProfileId: string | null;
}

export interface ParsedVerifierBaselinePromotionApproveCommand {
  kind: "promotion_approve";
  reference: string;
  profile: VerifierBaselinePromotionRenderProfile;
  approverId: string | null;
  approverDisplayName: string | null;
  approvalSource: "cli" | "workflow_dispatch" | "schedule" | "pull_request" | "automation" | null;
  approvalMode: "explicit_apply" | "workflow_apply" | null;
}

export interface ParsedVerifierBaselinePromotionHistoryCommand {
  kind: "promotion_history";
  baselineName: string;
  profile: VerifierBaselinePromotionHistoryRenderProfile;
}

export interface ParsedVerifierChecksCommand {
  kind: "checks_summary" | "checks_export";
  reference: string;
  profile: VerifierGitHubChecksRenderProfile;
  githubActions: boolean;
}

export interface ParsedVerifierTriageCommand {
  kind: "triage_summary";
  reference: string;
  profile: VerifierReleaseTriageRenderProfile;
  githubActions: boolean;
}

export interface ParsedVerifierDrilldownCommand {
  kind: "drilldown";
  reference: string;
  profile: VerifierDrilldownRenderProfile;
  githubActions: boolean;
}

export interface ParsedVerifierTimelineCommand {
  kind: "timeline";
  reference: string;
  profile: VerifierTimelineRenderProfile;
  githubActions: boolean;
}

export interface ParsedVerifierGitHubApplyCommand {
  kind: "github_apply";
  reference: string;
  profile: VerifierGitHubMutationRenderProfile;
  githubActions: boolean;
}

export interface ParsedVerifierGitHubResultCommand {
  kind: "github_result";
  reference: string;
  profile: VerifierGitHubMutationRenderProfile;
}

export type ParsedVerifierInspectCommand =
  | ParsedVerifierInspectInspectCommand
  | ParsedVerifierInspectExportCommand
  | ParsedVerifierInspectExportsCommand
  | ParsedVerifierInspectBaselinePinCommand
  | ParsedVerifierInspectBaselinesCommand
  | ParsedVerifierInspectCompareCommand
  | ParsedVerifierInspectGateCommand
  | ParsedVerifierInspectPoliciesCommand
  | ParsedVerifierInspectArtifactsCommand
  | ParsedVerifierInspectArtifactCommand
  | ParsedVerifierInspectHandoffCommand
  | ParsedVerifierInspectHandoffExportCommand
  | ParsedVerifierInspectArtifactsPruneCommand
  | ParsedVerifierBaselinePromotionPlanCommand
  | ParsedVerifierBaselinePromotionApproveCommand
  | ParsedVerifierBaselinePromotionHistoryCommand
  | ParsedVerifierChecksCommand
  | ParsedVerifierTriageCommand
  | ParsedVerifierDrilldownCommand
  | ParsedVerifierTimelineCommand
  | ParsedVerifierGitHubApplyCommand
  | ParsedVerifierGitHubResultCommand;

interface TokenizedVerifierInspectArgs {
  format: string | null;
  limit: number | null;
  policy: string | null;
  writeArtifact: boolean;
  writeBundle: boolean;
  dryRun: boolean;
  maxCount: number | null;
  maxAgeDays: number | null;
  githubActions: boolean;
  approverId: string | null;
  approverName: string | null;
  approvalSource: "cli" | "workflow_dispatch" | "schedule" | "pull_request" | "automation" | null;
  approvalMode: "explicit_apply" | "workflow_apply" | null;
  positionals: string[];
}

export function parseVerifierInspectCommandArgs(
  parts: string[],
  usage: string,
  optionFormat: string | null,
  options: {
    limit?: number | null;
    policy?: string | null;
    writeArtifact?: boolean;
    writeBundle?: boolean;
    dryRun?: boolean;
    maxCount?: number | null;
    maxAgeDays?: number | null;
    githubActions?: boolean;
    approverId?: string | null;
    approverName?: string | null;
    approvalSource?: TokenizedVerifierInspectArgs["approvalSource"];
    approvalMode?: TokenizedVerifierInspectArgs["approvalMode"];
  } = {},
): ParsedVerifierInspectCommand {
  const parsedTokens = tokenizeVerifierInspectArgs(parts);
  const tokens: TokenizedVerifierInspectArgs = {
    format: parsedTokens.format ?? optionFormat,
    limit: parsedTokens.limit ?? options.limit ?? null,
    policy: parsedTokens.policy ?? options.policy ?? null,
    writeArtifact: parsedTokens.writeArtifact || options.writeArtifact === true,
    writeBundle: parsedTokens.writeBundle || options.writeBundle === true,
    dryRun: parsedTokens.dryRun || options.dryRun === true,
    maxCount: parsedTokens.maxCount ?? options.maxCount ?? null,
    maxAgeDays: parsedTokens.maxAgeDays ?? options.maxAgeDays ?? null,
    githubActions: parsedTokens.githubActions || options.githubActions === true,
    approverId: parsedTokens.approverId ?? options.approverId ?? null,
    approverName: parsedTokens.approverName ?? options.approverName ?? null,
    approvalSource: parsedTokens.approvalSource ?? options.approvalSource ?? null,
    approvalMode: parsedTokens.approvalMode ?? options.approvalMode ?? null,
    positionals: parsedTokens.positionals,
  };
  const subcommand = tokens.positionals[0] ?? null;
  if (subcommand === "export") {
    return parseVerifierExportCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "exports") {
    return parseVerifierExportsCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "baseline") {
    return parseVerifierBaselineCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "baselines") {
    return parseVerifierBaselinesCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "compare") {
    return parseVerifierCompareCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "gate") {
    return parseVerifierGateCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "policies") {
    return parseVerifierPoliciesCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "artifacts") {
    return parseVerifierArtifactsCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "artifact") {
    return parseVerifierArtifactCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "handoff") {
    return parseVerifierHandoffCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "promotion") {
    return parseVerifierPromotionCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "checks") {
    return parseVerifierChecksCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "triage") {
    return parseVerifierTriageCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "drilldown") {
    return parseVerifierDrilldownCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "timeline") {
    return parseVerifierTimelineCommand(tokens, usage, optionFormat);
  }
  if (subcommand === "github") {
    return parseVerifierGitHubCommand(tokens, usage, optionFormat);
  }
  return parseVerifierInspectCommand(tokens, usage, optionFormat);
}

function parseVerifierInspectCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectInspectCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals;
  let profile = normalizeVerifierInspectRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length === 0 || positionals[0] === "current") {
    const trailing = positionals.length > 0 ? positionals.slice(1) : [];
    if (trailing.length > 1) {
      throw new Error(`Usage: ${usage}`);
    }
    if (trailing[0]) {
      profile = normalizeVerifierInspectRenderProfile(trailing[0]);
    }
    return {
      kind: "inspect",
      reference: { kind: "current", reference: null },
      profile,
    };
  }
  if (positionals[0] === "trace") {
    if (positionals.length > 2) {
      throw new Error(`Usage: ${usage}`);
    }
    if (positionals[1]) {
      profile = normalizeVerifierInspectRenderProfile(positionals[1]);
    }
    return {
      kind: "inspect",
      reference: { kind: "trace", reference: null },
      profile,
    };
  }
  if (positionals[0] === "replay") {
    const reference = positionals[1] ?? null;
    if (!reference || positionals.length > 3) {
      throw new Error(`Usage: ${usage}`);
    }
    if (positionals[2]) {
      profile = normalizeVerifierInspectRenderProfile(positionals[2]);
    }
    return {
      kind: "inspect",
      reference: { kind: "replay", reference },
      profile,
    };
  }
  if (isVerifierInspectRenderProfileToken(positionals[0])) {
    if (positionals.length > 1) {
      throw new Error(`Usage: ${usage}`);
    }
    return {
      kind: "inspect",
      reference: { kind: "current", reference: null },
      profile: normalizeVerifierInspectRenderProfile(positionals[0]),
    };
  }
  throw new Error(`Usage: ${usage}`);
}

function parseVerifierExportCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectExportCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  let profile = normalizeVerifierInspectSnapshotRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length === 0 || positionals[0] === "current") {
    const trailing = positionals.length > 0 ? positionals.slice(1) : [];
    if (trailing.length > 1) {
      throw new Error(`Usage: ${usage}`);
    }
    if (trailing[0]) {
      profile = normalizeVerifierInspectSnapshotRenderProfile(trailing[0]);
    }
    return {
      kind: "export",
      reference: { kind: "current", reference: null },
      profile,
    };
  }
  if (positionals[0] === "trace") {
    if (positionals.length > 2) {
      throw new Error(`Usage: ${usage}`);
    }
    if (positionals[1]) {
      profile = normalizeVerifierInspectSnapshotRenderProfile(positionals[1]);
    }
    return {
      kind: "export",
      reference: { kind: "trace", reference: null },
      profile,
    };
  }
  if (positionals[0] === "replay") {
    const reference = positionals[1] ?? null;
    if (!reference || positionals.length > 3) {
      throw new Error(`Usage: ${usage}`);
    }
    if (positionals[2]) {
      profile = normalizeVerifierInspectSnapshotRenderProfile(positionals[2]);
    }
    return {
      kind: "export",
      reference: { kind: "replay", reference },
      profile,
    };
  }
  if (isVerifierInspectSnapshotRenderProfileToken(positionals[0])) {
    if (positionals.length > 1) {
      throw new Error(`Usage: ${usage}`);
    }
    return {
      kind: "export",
      reference: { kind: "current", reference: null },
      profile: normalizeVerifierInspectSnapshotRenderProfile(positionals[0]),
    };
  }
  throw new Error(`Usage: ${usage}`);
}

function parseVerifierExportsCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectExportsCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  let profile = normalizeVerifierInspectSnapshotRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length > 1) {
    throw new Error(`Usage: ${usage}`);
  }
  if (positionals[0]) {
    profile = normalizeVerifierInspectSnapshotRenderProfile(positionals[0]);
  }
  return {
    kind: "exports",
    limit: tokens.limit ?? 20,
    profile,
  };
}

function parseVerifierBaselineCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectBaselinePinCommand {
  if (
    tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  if (positionals[0] !== "pin") {
    throw new Error(`Usage: ${usage}`);
  }
  let profile = normalizeVerifierInspectBaselineRenderProfile(tokens.format ?? optionFormat);
  const args = positionals.slice(1);
  if (args.length < 2 || args.length > 3) {
    throw new Error(`Usage: ${usage}`);
  }
  if (args[2]) {
    profile = normalizeVerifierInspectBaselineRenderProfile(args[2]);
  }
  const reference = parseVerifierInspectReferenceToken(args[0], usage);
  if (reference.kind === "baseline") {
    throw new Error(`Usage: ${usage}`);
  }
  return {
    kind: "baseline_pin",
    reference,
    name: args[1],
    profile,
    policyProfileId: tokens.policy,
  };
}

function parseVerifierBaselinesCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectBaselinesCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  let profile = normalizeVerifierInspectBaselineRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length > 1) {
    throw new Error(`Usage: ${usage}`);
  }
  if (positionals[0]) {
    profile = normalizeVerifierInspectBaselineRenderProfile(positionals[0]);
  }
  return {
    kind: "baselines",
    limit: tokens.limit ?? 20,
    profile,
  };
}

function parseVerifierCompareCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectCompareCommand {
  if (tokens.policy || tokens.dryRun || tokens.maxCount != null || tokens.maxAgeDays != null) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  let profile = normalizeVerifierInspectCompareRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length < 2 || positionals.length > 3) {
    throw new Error(`Usage: ${usage}`);
  }
  if (positionals[2]) {
    profile = normalizeVerifierInspectCompareRenderProfile(positionals[2]);
  }
  return {
    kind: "compare",
    left: parseVerifierInspectReferenceToken(positionals[0], usage),
    right: parseVerifierInspectReferenceToken(positionals[1], usage),
    profile,
    writeArtifact: tokens.writeArtifact,
    writeBundle: tokens.writeBundle,
  };
}

function parseVerifierGateCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectGateCommand {
  const positionals = tokens.positionals.slice(1);
  let profile = normalizeVerifierRegressionGateRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length < 2 || positionals.length > 3) {
    throw new Error(`Usage: ${usage}`);
  }
  if (positionals[2]) {
    profile = normalizeVerifierRegressionGateRenderProfile(positionals[2]);
  }
  return {
    kind: "gate",
    left: parseVerifierInspectReferenceToken(positionals[0], usage),
    right: parseVerifierInspectReferenceToken(positionals[1], usage),
    profile,
    policyProfileId: tokens.policy,
    writeArtifact: tokens.writeArtifact,
    writeBundle: tokens.writeBundle,
  };
}

function parseVerifierPoliciesCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectPoliciesCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  let profile = normalizeVerifierRegressionGatePolicyProfileRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length > 1) {
    throw new Error(`Usage: ${usage}`);
  }
  if (positionals[0]) {
    profile = normalizeVerifierRegressionGatePolicyProfileRenderProfile(positionals[0]);
  }
  return {
    kind: "policies",
    profile,
  };
}

function parseVerifierArtifactsCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectArtifactsCommand | ParsedVerifierInspectArtifactsPruneCommand {
  if (tokens.policy || tokens.writeArtifact || tokens.writeBundle) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  if (positionals[0] === "prune") {
    return parseVerifierArtifactsPruneCommand(tokens, usage, optionFormat);
  }
  if (tokens.dryRun || tokens.maxCount != null || tokens.maxAgeDays != null) {
    throw new Error(`Usage: ${usage}`);
  }
  let profile = normalizeVerifierInspectArtifactListRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length > 1) {
    throw new Error(`Usage: ${usage}`);
  }
  if (positionals[0]) {
    profile = normalizeVerifierInspectArtifactListRenderProfile(positionals[0]);
  }
  return {
    kind: "artifacts",
    limit: tokens.limit ?? 20,
    profile,
  };
}

function parseVerifierArtifactCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectArtifactCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  let profile = normalizeVerifierInspectArtifactRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length < 1 || positionals.length > 2) {
    throw new Error(`Usage: ${usage}`);
  }
  if (positionals[1]) {
    profile = normalizeVerifierInspectArtifactRenderProfile(positionals[1]);
  }
  const artifactId = `${positionals[0] ?? ""}`.trim();
  if (!artifactId) {
    throw new Error(`Usage: ${usage}`);
  }
  return {
    kind: "artifact",
    artifactId,
    profile,
  };
}

function parseVerifierHandoffCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectHandoffCommand | ParsedVerifierInspectHandoffExportCommand {
  if (tokens.policy || tokens.limit != null || tokens.maxCount != null || tokens.maxAgeDays != null || tokens.dryRun) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  if (positionals[0] === "export") {
    if (tokens.writeArtifact || tokens.writeBundle) {
      throw new Error(`Usage: ${usage}`);
    }
    let profile = normalizeVerifierReleaseBundleRenderProfile(tokens.format ?? optionFormat);
    const args = positionals.slice(1);
    if (args.length > 2) {
      throw new Error(`Usage: ${usage}`);
    }
    const reference = isVerifierReleaseBundleRenderProfileToken(args[0] ?? "")
      ? "latest"
      : (args[0] ?? "latest").trim() || "latest";
    if (args.length === 2 || (args.length === 1 && isVerifierReleaseBundleRenderProfileToken(args[0] ?? ""))) {
      profile = normalizeVerifierReleaseBundleRenderProfile(
        args.length === 2 ? args[1] : args[0],
      );
    }
    return {
      kind: "handoff_export",
      reference,
      profile,
    };
  }
  if (tokens.writeArtifact || tokens.writeBundle) {
    throw new Error(`Usage: ${usage}`);
  }
  let profile = normalizeVerifierReleaseHandoffRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length > 2) {
    throw new Error(`Usage: ${usage}`);
  }
  const reference = isVerifierReleaseHandoffRenderProfileToken(positionals[0] ?? "")
    ? "latest"
    : (positionals[0] ?? "latest").trim() || "latest";
  if (positionals.length === 2 || (positionals.length === 1 && isVerifierReleaseHandoffRenderProfileToken(positionals[0] ?? ""))) {
    profile = normalizeVerifierReleaseHandoffRenderProfile(
      positionals.length === 2 ? positionals[1] : positionals[0],
    );
  }
  return {
    kind: "handoff",
    reference,
    profile,
  };
}

function parseVerifierPromotionCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierBaselinePromotionPlanCommand
  | ParsedVerifierBaselinePromotionApproveCommand
  | ParsedVerifierBaselinePromotionHistoryCommand {
  if (
    tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
    || tokens.githubActions
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  const action = positionals[0] ?? null;
  if (action === "plan") {
    if (
      tokens.approverId != null
      || tokens.approverName != null
      || tokens.approvalSource != null
      || tokens.approvalMode != null
    ) {
      throw new Error(`Usage: ${usage}`);
    }
    let profile = normalizeVerifierBaselinePromotionRenderProfile(tokens.format ?? optionFormat);
    const args = positionals.slice(1);
    if (args.length < 1 || args.length > 3) {
      throw new Error(`Usage: ${usage}`);
    }
    const baselineName = `${args[0] ?? ""}`.trim();
    if (!baselineName) {
      throw new Error(`Usage: ${usage}`);
    }
    let reference = "latest";
    if (args[1] && !isVerifierBaselinePromotionRenderProfileToken(args[1])) {
      reference = args[1];
    }
    const profileToken = args.length === 3
      ? args[2]
      : (args[1] && isVerifierBaselinePromotionRenderProfileToken(args[1]) ? args[1] : null);
    if (profileToken) {
      profile = normalizeVerifierBaselinePromotionRenderProfile(profileToken);
    }
    return {
      kind: "promotion_plan",
      baselineName,
      reference,
      profile,
      policyProfileId: tokens.policy,
    };
  }
  if (action === "approve") {
    if (tokens.policy) {
      throw new Error(`Usage: ${usage}`);
    }
    let profile = normalizeVerifierBaselinePromotionRenderProfile(tokens.format ?? optionFormat);
    const args = positionals.slice(1);
    if (args.length < 1 || args.length > 2) {
      throw new Error(`Usage: ${usage}`);
    }
    if (args[1]) {
      profile = normalizeVerifierBaselinePromotionRenderProfile(args[1]);
    }
    return {
      kind: "promotion_approve",
      reference: `${args[0] ?? ""}`.trim(),
      profile,
      approverId: tokens.approverId,
      approverDisplayName: tokens.approverName,
      approvalSource: tokens.approvalSource,
      approvalMode: tokens.approvalMode,
    };
  }
  if (action === "history") {
    if (
      tokens.policy
      || tokens.approverId != null
      || tokens.approverName != null
      || tokens.approvalSource != null
      || tokens.approvalMode != null
    ) {
      throw new Error(`Usage: ${usage}`);
    }
    let profile = normalizeVerifierBaselinePromotionHistoryRenderProfile(tokens.format ?? optionFormat);
    const args = positionals.slice(1);
    if (args.length < 1 || args.length > 2) {
      throw new Error(`Usage: ${usage}`);
    }
    if (args[1]) {
      profile = normalizeVerifierBaselinePromotionHistoryRenderProfile(args[1]);
    }
    return {
      kind: "promotion_history",
      baselineName: `${args[0] ?? ""}`.trim(),
      profile,
    };
  }
  throw new Error(`Usage: ${usage}`);
}

function parseVerifierGitHubCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierGitHubApplyCommand | ParsedVerifierGitHubResultCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
    || tokens.approverId != null
    || tokens.approverName != null
    || tokens.approvalSource != null
    || tokens.approvalMode != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  const action = positionals[0] ?? null;
  if (action === "apply") {
    let profile = normalizeVerifierGitHubMutationRenderProfile(tokens.format ?? optionFormat);
    const args = positionals.slice(1);
    if (args.length > 2) {
      throw new Error(`Usage: ${usage}`);
    }
    const reference = isVerifierGitHubMutationRenderProfileToken(args[0] ?? "")
      ? "latest"
      : `${args[0] ?? "latest"}`.trim() || "latest";
    if (args.length === 2 || (args.length === 1 && isVerifierGitHubMutationRenderProfileToken(args[0] ?? ""))) {
      profile = normalizeVerifierGitHubMutationRenderProfile(args.length === 2 ? args[1] : args[0]);
    }
    return {
      kind: "github_apply",
      reference,
      profile,
      githubActions: tokens.githubActions,
    };
  }
  if (action === "result") {
    let profile = normalizeVerifierGitHubMutationRenderProfile(tokens.format ?? optionFormat);
    const args = positionals.slice(1);
    if (args.length > 2 || tokens.githubActions) {
      throw new Error(`Usage: ${usage}`);
    }
    const reference = isVerifierGitHubMutationRenderProfileToken(args[0] ?? "")
      ? "latest"
      : `${args[0] ?? "latest"}`.trim() || "latest";
    if (args.length === 2 || (args.length === 1 && isVerifierGitHubMutationRenderProfileToken(args[0] ?? ""))) {
      profile = normalizeVerifierGitHubMutationRenderProfile(args.length === 2 ? args[1] : args[0]);
    }
    return {
      kind: "github_result",
      reference,
      profile,
    };
  }
  throw new Error(`Usage: ${usage}`);
}

function parseVerifierChecksCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierChecksCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  const mode = positionals[0] ?? "summary";
  if (mode !== "summary" && mode !== "export") {
    throw new Error(`Usage: ${usage}`);
  }
  let profile = normalizeVerifierGitHubChecksRenderProfile(tokens.format ?? optionFormat);
  const args = positionals.slice(1);
  if (args.length > 2) {
    throw new Error(`Usage: ${usage}`);
  }
  const reference = isVerifierGitHubChecksRenderProfileToken(args[0] ?? "")
    ? "latest"
    : (args[0] ?? "latest").trim() || "latest";
  if (args.length === 2 || (args.length === 1 && isVerifierGitHubChecksRenderProfileToken(args[0] ?? ""))) {
    profile = normalizeVerifierGitHubChecksRenderProfile(args.length === 2 ? args[1] : args[0]);
  }
  return {
    kind: mode === "export" ? "checks_export" : "checks_summary",
    reference,
    profile,
    githubActions: tokens.githubActions,
  };
}

function parseVerifierTriageCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierTriageCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(1);
  if ((positionals[0] ?? "summary") !== "summary") {
    throw new Error(`Usage: ${usage}`);
  }
  let profile = normalizeVerifierReleaseTriageRenderProfile(tokens.format ?? optionFormat);
  const args = positionals.slice(1);
  if (args.length > 2) {
    throw new Error(`Usage: ${usage}`);
  }
  const reference = isVerifierReleaseTriageRenderProfileToken(args[0] ?? "")
    ? "latest"
    : (args[0] ?? "latest").trim() || "latest";
  if (args.length === 2 || (args.length === 1 && isVerifierReleaseTriageRenderProfileToken(args[0] ?? ""))) {
    profile = normalizeVerifierReleaseTriageRenderProfile(args.length === 2 ? args[1] : args[0]);
  }
  return {
    kind: "triage_summary",
    reference,
    profile,
    githubActions: tokens.githubActions,
  };
}

function parseVerifierDrilldownCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierDrilldownCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
    || tokens.approverId != null
    || tokens.approverName != null
    || tokens.approvalSource != null
    || tokens.approvalMode != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  let profile = normalizeVerifierDrilldownRenderProfile(tokens.format ?? optionFormat);
  const positionals = tokens.positionals.slice(1);
  if (positionals.length > 2) {
    throw new Error(`Usage: ${usage}`);
  }
  const reference = isVerifierDrilldownRenderProfileToken(positionals[0] ?? "")
    ? "latest"
    : (positionals[0] ?? "latest").trim() || "latest";
  if (positionals.length === 2 || (positionals.length === 1 && isVerifierDrilldownRenderProfileToken(positionals[0] ?? ""))) {
    profile = normalizeVerifierDrilldownRenderProfile(
      positionals.length === 2 ? positionals[1] : positionals[0],
    );
  }
  return {
    kind: "drilldown",
    reference,
    profile,
    githubActions: tokens.githubActions,
  };
}

function parseVerifierTimelineCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierTimelineCommand {
  if (
    tokens.policy
    || tokens.writeArtifact
    || tokens.writeBundle
    || tokens.limit != null
    || tokens.dryRun
    || tokens.maxCount != null
    || tokens.maxAgeDays != null
    || tokens.approverId != null
    || tokens.approverName != null
    || tokens.approvalSource != null
    || tokens.approvalMode != null
  ) {
    throw new Error(`Usage: ${usage}`);
  }
  let profile = normalizeVerifierTimelineRenderProfile(tokens.format ?? optionFormat);
  const positionals = tokens.positionals.slice(1);
  if (positionals.length > 2) {
    throw new Error(`Usage: ${usage}`);
  }
  const reference = isVerifierTimelineRenderProfileToken(positionals[0] ?? "")
    ? "latest"
    : (positionals[0] ?? "latest").trim() || "latest";
  if (positionals.length === 2 || (positionals.length === 1 && isVerifierTimelineRenderProfileToken(positionals[0] ?? ""))) {
    profile = normalizeVerifierTimelineRenderProfile(
      positionals.length === 2 ? positionals[1] : positionals[0],
    );
  }
  return {
    kind: "timeline",
    reference,
    profile,
    githubActions: tokens.githubActions,
  };
}

function parseVerifierArtifactsPruneCommand(
  tokens: TokenizedVerifierInspectArgs,
  usage: string,
  optionFormat: string | null,
): ParsedVerifierInspectArtifactsPruneCommand {
  if (tokens.limit != null) {
    throw new Error(`Usage: ${usage}`);
  }
  const positionals = tokens.positionals.slice(2);
  let profile = normalizeVerifierInspectArtifactPruneRenderProfile(tokens.format ?? optionFormat);
  if (positionals.length > 1) {
    throw new Error(`Usage: ${usage}`);
  }
  if (positionals[0]) {
    profile = normalizeVerifierInspectArtifactPruneRenderProfile(positionals[0]);
  }
  return {
    kind: "artifacts_prune",
    profile,
    policy: {
      maxArtifactCount: tokens.maxCount ?? undefined,
      maxArtifactAgeDays: tokens.maxAgeDays ?? undefined,
      dryRun: tokens.dryRun,
    },
  };
}

export function parseVerifierInspectReferenceToken(
  token: string,
  usage: string,
): VerifierInspectReference {
  const normalized = `${token ?? ""}`.trim();
  if (normalized === "current") {
    return { kind: "current", reference: null };
  }
  if (normalized === "trace") {
    return { kind: "trace", reference: null };
  }
  if (normalized.startsWith("replay:")) {
    const reference = normalized.slice("replay:".length).trim();
    if (reference) {
      return { kind: "replay", reference };
    }
  }
  if (normalized.startsWith("snapshot:")) {
    const reference = normalized.slice("snapshot:".length).trim();
    if (reference) {
      return { kind: "snapshot", reference };
    }
  }
  if (normalized.startsWith("baseline:")) {
    const reference = normalized.slice("baseline:".length).trim();
    if (reference) {
      return { kind: "baseline", reference };
    }
  }
  throw new Error(`Usage: ${usage}`);
}

function tokenizeVerifierInspectArgs(parts: string[]): TokenizedVerifierInspectArgs {
  let format: string | null = null;
  let limit: number | null = null;
  let policy: string | null = null;
  let writeArtifact = false;
  let writeBundle = false;
  let dryRun = false;
  let maxCount: number | null = null;
  let maxAgeDays: number | null = null;
  let githubActions = false;
  let approverId: string | null = null;
  let approverName: string | null = null;
  let approvalSource: TokenizedVerifierInspectArgs["approvalSource"] = null;
  let approvalMode: TokenizedVerifierInspectArgs["approvalMode"] = null;
  const positionals: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const token = `${parts[index] ?? ""}`.trim();
    if (!token) {
      continue;
    }
    if (token === "--format") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing verifier inspect format value.");
      }
      format = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--format=")) {
      format = token.slice("--format=".length).trim() || null;
      continue;
    }
    if (token === "--limit") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing verifier inspect limit value.");
      }
      limit = parseLimit(next);
      index += 1;
      continue;
    }
    if (token.startsWith("--limit=")) {
      limit = parseLimit(token.slice("--limit=".length));
      continue;
    }
    if (token === "--policy") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing verifier gate policy profile.");
      }
      policy = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--policy=")) {
      policy = token.slice("--policy=".length).trim() || null;
      continue;
    }
    if (token === "--write-artifact") {
      writeArtifact = true;
      continue;
    }
    if (token === "--write-bundle") {
      writeBundle = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--github-actions") {
      githubActions = true;
      continue;
    }
    if (token === "--approver-id") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing verifier promotion approver id.");
      }
      approverId = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--approver-id=")) {
      approverId = token.slice("--approver-id=".length).trim() || null;
      continue;
    }
    if (token === "--approver-name") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing verifier promotion approver name.");
      }
      approverName = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--approver-name=")) {
      approverName = token.slice("--approver-name=".length).trim() || null;
      continue;
    }
    if (token === "--approval-source") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      const parsed = parseApprovalSource(next);
      if (!parsed) {
        throw new Error("Usage: invalid verifier promotion approval source.");
      }
      approvalSource = parsed;
      index += 1;
      continue;
    }
    if (token.startsWith("--approval-source=")) {
      const parsed = parseApprovalSource(token.slice("--approval-source=".length));
      if (!parsed) {
        throw new Error("Usage: invalid verifier promotion approval source.");
      }
      approvalSource = parsed;
      continue;
    }
    if (token === "--approval-mode") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      const parsed = parseApprovalMode(next);
      if (!parsed) {
        throw new Error("Usage: invalid verifier promotion approval mode.");
      }
      approvalMode = parsed;
      index += 1;
      continue;
    }
    if (token.startsWith("--approval-mode=")) {
      const parsed = parseApprovalMode(token.slice("--approval-mode=".length));
      if (!parsed) {
        throw new Error("Usage: invalid verifier promotion approval mode.");
      }
      approvalMode = parsed;
      continue;
    }
    if (token === "--max-count") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing verifier artifact prune max-count value.");
      }
      maxCount = parseLimit(next);
      index += 1;
      continue;
    }
    if (token.startsWith("--max-count=")) {
      maxCount = parseLimit(token.slice("--max-count=".length));
      continue;
    }
    if (token === "--max-age-days") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing verifier artifact prune max-age-days value.");
      }
      maxAgeDays = parseLimit(next);
      index += 1;
      continue;
    }
    if (token.startsWith("--max-age-days=")) {
      maxAgeDays = parseLimit(token.slice("--max-age-days=".length));
      continue;
    }
    positionals.push(token);
  }
  return {
    format,
    limit,
    policy,
    writeArtifact,
    writeBundle,
    dryRun,
    maxCount,
    maxAgeDays,
    githubActions,
    approverId,
    approverName,
    approvalSource,
    approvalMode,
    positionals,
  };
}

function parseApprovalSource(
  value: string,
): TokenizedVerifierInspectArgs["approvalSource"] {
  const normalized = `${value ?? ""}`.trim();
  return normalized === "cli"
    || normalized === "workflow_dispatch"
    || normalized === "schedule"
    || normalized === "pull_request"
    || normalized === "automation"
    ? normalized
    : null;
}

function parseApprovalMode(
  value: string,
): TokenizedVerifierInspectArgs["approvalMode"] {
  const normalized = `${value ?? ""}`.trim();
  return normalized === "explicit_apply" || normalized === "workflow_apply"
    ? normalized
    : null;
}

function parseLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("Usage: verifier inspect limit must be a positive integer.");
  }
  return parsed;
}

function isVerifierInspectRenderProfileToken(value: string): boolean {
  return ["json", "summary", "failures", "repair", "context"].includes(value.trim().toLowerCase());
}

function isVerifierInspectSnapshotRenderProfileToken(value: string): boolean {
  return ["json", "summary"].includes(value.trim().toLowerCase());
}

function isVerifierReleaseHandoffRenderProfileToken(value: string): boolean {
  return ["json", "summary", "failures"].includes(value.trim().toLowerCase());
}

function isVerifierReleaseBundleRenderProfileToken(value: string): boolean {
  return ["json", "summary"].includes(value.trim().toLowerCase());
}

function isVerifierBaselinePromotionRenderProfileToken(value: string): boolean {
  return ["json", "summary", "failures"].includes(value.trim().toLowerCase());
}

function isVerifierBaselinePromotionHistoryRenderProfileToken(value: string): boolean {
  return ["json", "summary"].includes(value.trim().toLowerCase());
}

function isVerifierGitHubChecksRenderProfileToken(value: string): boolean {
  return ["json", "summary"].includes(value.trim().toLowerCase());
}

function isVerifierGitHubMutationRenderProfileToken(value: string): boolean {
  return ["json", "summary", "failures"].includes(value.trim().toLowerCase());
}

function isVerifierDrilldownRenderProfileToken(value: string): boolean {
  return ["json", "summary", "failures"].includes(value.trim().toLowerCase());
}

function isVerifierTimelineRenderProfileToken(value: string): boolean {
  return ["json", "summary", "failures"].includes(value.trim().toLowerCase());
}

function isVerifierReleaseTriageRenderProfileToken(value: string): boolean {
  return ["json", "summary", "failures"].includes(value.trim().toLowerCase());
}
