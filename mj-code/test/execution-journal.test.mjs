import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ExecutionJournal } from "../src/lib/execution-journal.mjs";

test("execution journal starts, appends entries, and records phases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-journal-"));
  const journal = new ExecutionJournal(root);

  const filePath = await journal.start("session-1", {
    provider: "mock",
  });
  await journal.append({
    type: "shell_job_event",
    traceId: "trace-1",
    payload: { id: "job-1" },
  });
  await journal.recordPhase({
    traceId: "trace-1",
    stepId: 1,
    phase: "planning",
    outputSummary: "Phase recorded.",
  });

  assert.match(filePath, /session-1\.jsonl$/);
  const entries = await journal.readEntries("session-1");
  assert.equal(entries[0].type, "journal_started");
  assert.deepEqual(entries[0].payload, { provider: "mock" });
  assert.equal(entries[1].type, "shell_job_event");
  assert.equal(entries[2].type, "phase");
  assert.equal(entries[2].outputSummary, "Phase recorded.");
  assert.equal((await journal.listPhases("session-1")).length, 1);
});

test("execution journal writes and loads latest snapshots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-journal-snapshot-"));
  const journal = new ExecutionJournal(root);

  await journal.start("session-2");
  const snapshotPath = await journal.writeStateSnapshot({
    usageTotals: { totalTokens: 42 },
  }, {
    traceId: "trace-2",
    phase: "planning",
    stepId: "bootstrap",
    outputSummary: "Snapshot written.",
  });
  const loaded = await journal.loadLatestSnapshot("session-2");

  assert.equal(loaded?.filePath, snapshotPath);
  assert.deepEqual(loaded?.state, {
    usageTotals: { totalTokens: 42 },
  });
  assert.equal(loaded?.sessionId, "session-2");
  assert.equal(loaded?.phase, "snapshot");
});

test("execution journal open() rebinds an existing journal file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-journal-open-"));
  const journal = new ExecutionJournal(root);

  await journal.start("session-3");
  const rebound = new ExecutionJournal(root);
  const filePath = await rebound.open("session-3");

  assert.match(filePath, /session-3\.jsonl$/);
  await rebound.recordPhase({
    phase: "resume",
    outputSummary: "Resumed journal.",
  });
  assert.equal((await rebound.listPhases("session-3")).length, 1);
});

test("execution journal rejects append and snapshot writes before initialization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-journal-uninit-"));
  const journal = new ExecutionJournal(root);

  await assert.rejects(
    journal.append({ type: "custom" }),
    /Execution journal is not initialized/,
  );
  await assert.rejects(
    journal.writeStateSnapshot({}, {
      traceId: null,
      phase: "planning",
      stepId: "bootstrap",
      outputSummary: "No session.",
    }),
    /Execution journal is not initialized/,
  );
});
