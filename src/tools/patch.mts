import { applyPatchText } from "../lib/apply-patch.mjs";
import { previewApplyPatchChangeSet } from "../lib/change-set.mjs";

import type { ApplyPatchResult } from "../types/contracts.js";

export interface ApplyPatchInput {
  patch?: string | null;
}

export interface PatchToolContext {
  cwd: string;
}

export async function applyPatch(
  input: ApplyPatchInput | Record<string, unknown> | undefined,
  context: PatchToolContext,
): Promise<ApplyPatchResult> {
  const patch = typeof input?.patch === "string" ? input.patch : "";
  if (!patch) {
    throw new Error("apply_patch requires a patch string.");
  }

  return applyPatchText(patch, context.cwd);
}

export async function previewApplyPatch(
  input: Record<string, unknown> | undefined,
  context: PatchToolContext,
) {
  return previewApplyPatchChangeSet(input ?? {}, context);
}
