import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JobStore } from "../src/lib/job-store.mjs";
import { ShellRuntime } from "../src/lib/shell-runtime.mjs";

test("shell runtime tracks job lifecycle and output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-shell-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const jobStore = new JobStore(projectStateDir);
  const events = [];
  const runtime = new ShellRuntime({
    cwd: root,
    projectStateDir,
    shellTimeoutMs: 1000,
    shellBufferChars: 4000,
    maxOutputChars: 2000,
  }, jobStore, {
    onEvent: async (event) => {
      events.push(event.type);
    },
  });
  await runtime.initialize();

  const result = await runtime.run({
    command: "printf 'hello'; printf 'oops' 1>&2",
    shell: "/bin/sh",
  }, {
    traceId: "trace-shell",
  });

  assert.equal(result.status, "exited");
  assert.match(result.stdout, /hello/);
  assert.match(result.stderr, /oops/);
  assert.ok(events.includes("shell_job_started"));
  assert.ok(events.includes("shell_job_completed"));

  const jobs = await runtime.listJobs();
  assert.equal(jobs[0].status, "exited");
});

test("shell runtime supports background jobs, cancel, and timeout metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-shell-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const jobStore = new JobStore(projectStateDir);
  const runtime = new ShellRuntime({
    cwd: root,
    projectStateDir,
    shellTimeoutMs: 200,
    shellBufferChars: 4000,
    maxOutputChars: 2000,
  }, jobStore);
  await runtime.initialize();

  const background = await runtime.run({
    command: "sleep 5",
    shell: "/bin/sh",
    background: true,
  }, {
    traceId: "trace-bg",
  });

  assert.equal(background.background, true);
  assert.equal(background.status, "running");

  const cancelResult = await runtime.cancelJob(background.jobId);
  assert.equal(cancelResult.cancelled, true);

  const cancelledJob = await waitForJob(jobStore, background.jobId, (job) => job.status === "cancelled");
  assert.equal(cancelledJob.status, "cancelled");

  const timedOut = await runtime.run({
    command: "sleep 2",
    shell: "/bin/sh",
    timeoutMs: 50,
  }, {
    traceId: "trace-timeout",
  });
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.timedOut, true);
});

test("shell runtime persists background jobs and reattaches them from a resumed runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-shell-reattach-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const scriptPath = path.join(root, "ticker.mjs");
  await fs.writeFile(scriptPath, [
    "let count = 0;",
    "setInterval(() => {",
    "  count += 1;",
    "  console.log(`tick-${count}`);",
    "}, 40);",
  ].join("\n"));

  const jobStore = new JobStore(projectStateDir);
  const runtimeA = new ShellRuntime({
    cwd: root,
    projectStateDir,
    shellTimeoutMs: 5000,
    shellBufferChars: 4000,
    maxOutputChars: 2000,
  }, jobStore);
  await runtimeA.initialize();
  await runtimeA.bindSession({
    sessionId: "session-a",
    rootSessionId: "session-a",
  });

  const background = await runtimeA.run({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
    shell: "/bin/sh",
    background: true,
  }, {
    sessionId: "session-a",
    traceId: "trace-bg",
  });

  await waitForTail(runtimeA, background.jobId, (tail) => tail.stdoutTail.includes("tick-"));

  const runtimeB = new ShellRuntime({
    cwd: root,
    projectStateDir,
    shellTimeoutMs: 5000,
    shellBufferChars: 4000,
    maxOutputChars: 2000,
  }, new JobStore(projectStateDir));
  await runtimeB.initialize();
  await runtimeB.bindSession({
    sessionId: "session-b",
    parentSessionId: "session-a",
    rootSessionId: "session-a",
  });

  const jobs = await runtimeB.listJobs("running");
  const resumedJob = jobs.find((entry) => entry.id === background.jobId);
  assert.equal(resumedJob.continuityState, "reattached");
  assert.equal(resumedJob.canCancel, true);
  assert.equal(resumedJob.reattachPolicy, "live_attach");
  assert.equal(resumedJob.cursorTailAvailable, true);
  assert.equal(resumedJob.stdinAttachAvailable, false);

  const attach = await runtimeB.attachJob(background.jobId);
  assert.equal(attach.mode, "live_attach");
  assert.equal(attach.live, true);
  assert.equal(attach.cursorTailAvailable, true);
  assert.equal(attach.stdinAttachAvailable, false);

  const tail = await runtimeB.tailJob(background.jobId);
  assert.match(tail.stdoutTail, /tick-/);
  assert.equal(tail.live, true);
  assert.equal(tail.reattached, true);

  await new Promise((resolve) => setTimeout(resolve, 80));
  const incremental = await runtimeB.tailJob(background.jobId, {
    cursor: tail.nextCursor,
  });
  assert.ok(incremental.stdoutTail.length > 0);
  assert.equal(incremental.cursorTailAvailable, true);

  const cancelResult = await runtimeB.cancelJob(background.jobId);
  assert.equal(cancelResult.cancelled, true);

  const cancelledJob = await waitForJob(runtimeB.jobStore, background.jobId, (job) => job.status === "cancelled");
  assert.equal(cancelledJob.status, "cancelled");
  assert.equal(cancelledJob.historicalOnly, true);
});

test("shell runtime makes PTY degrade explicit when best-effort PTY is unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-shell-pty-"));
  const projectStateDir = path.join(root, ".mj-code");
  await fs.mkdir(projectStateDir, { recursive: true });
  const jobStore = new JobStore(projectStateDir);
  const runtime = new ShellRuntime({
    cwd: root,
    projectStateDir,
    shellTimeoutMs: 1000,
    shellBufferChars: 4000,
    maxOutputChars: 2000,
  }, jobStore);
  await runtime.initialize();

  const result = await runtime.run({
    command: "printf 'hello'",
    shell: "/bin/sh",
    pty: true,
  }, {
    traceId: "trace-pty",
  });

  assert.ok(["exited", "failed", "timed_out"].includes(result.status));
  if (process.platform === "darwin") {
    assert.equal(result.ptyEnabled, true);
    assert.equal(result.ttyMode, "pty");
  } else {
    assert.equal(result.ptyEnabled, false);
    assert.equal(result.ttyMode, "pty_degraded_pipe");
    assert.ok(result.ptyDegradedReason);
  }
});

async function waitForJob(jobStore, jobId, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await jobStore.getJob(jobId);
    if (predicate(job)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for job ${jobId}.`);
}

async function waitForTail(runtime, jobId, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tail = await runtime.tailJob(jobId);
    if (predicate(tail)) {
      return tail;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  throw new Error(`Timed out waiting for tail on job ${jobId}.`);
}
