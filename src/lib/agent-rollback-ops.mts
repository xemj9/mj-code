import crypto from "node:crypto";

import type { ExecutionJournalLike as SharedExecutionJournalLike } from "./execution-journal.mjs";

interface RollbackResult {
  changeSetId: string;
  restorePointId: string | null;
  rolledBack: boolean;
  partial: boolean;
  results: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
}

interface RollbackStoreLike {
  rollback(
    changeSetId: string,
    options?: {
      sessionId?: string | null;
      traceId?: string | null;
    },
  ): Promise<RollbackResult>;
  listCheckpoints(limit?: number): Promise<Array<{
    id: string;
    status: string;
    origin: string;
  }>>;
}

interface SessionStoreLike {
  append(type: string, payload?: Record<string, unknown>): Promise<unknown>;
}

type ExecutionJournalLike = Pick<SharedExecutionJournalLike, "recordPhase">;

interface UndoDependencies {
  sessionId: string | null;
  rollbackStore: RollbackStoreLike;
  sessionStore: SessionStoreLike;
  executionJournal: ExecutionJournalLike;
  captureStateSnapshot(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): Promise<string>;
}

export async function pickLatestUndoTarget(
  rollbackStore: RollbackStoreLike,
): Promise<string> {
  const checkpoints = await rollbackStore.listCheckpoints(20);
  const candidate = checkpoints.find((entry) =>
    ["applied", "apply_partial_failure"].includes(entry.status) &&
    entry.origin !== "rollback_restore_point",
  );

  if (!candidate) {
    throw new Error("No applied change-set is available to undo.");
  }

  return candidate.id;
}

export async function undoAgentChange(
  dependencies: UndoDependencies,
  changeSetId: string | null = null,
): Promise<RollbackResult> {
  const targetId = changeSetId ?? await pickLatestUndoTarget(dependencies.rollbackStore);
  const traceId = crypto.randomUUID().slice(0, 12);
  const result = await dependencies.rollbackStore.rollback(targetId, {
    sessionId: dependencies.sessionId,
    traceId,
  });
  await dependencies.sessionStore.append("rollback", {
    traceId,
    ...result,
  });
  await dependencies.executionJournal.recordPhase({
    traceId,
    stepId: "undo",
    phase: "rollback",
    outputSummary: result.rolledBack
      ? `Rolled back change-set ${targetId}.`
      : `Rollback partially failed for ${targetId}.`,
    metrics: {
      errors: result.errors.length,
      restorePointId: result.restorePointId,
    },
    error: result.errors.length > 0
      ? {
          taxonomy: "rollback_error",
          details: result.errors,
        }
      : null,
    snapshot: await dependencies.captureStateSnapshot({
      traceId,
      phase: "rollback",
      stepId: "undo",
      outputSummary: `Undo finished for ${targetId}.`,
    }),
  });
  return result;
}
