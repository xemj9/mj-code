import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("cli route and plan commands support inspect and preview flows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-intel-cli-"));
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });

  const routePreviewResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "route",
    "Refactor",
    "the",
    "CLI",
    "parser",
    "and",
    "run",
    "tests",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  const routePreview = JSON.parse(routePreviewResult.stdout);
  assert.equal(routePreview.taskClassification.taskClass, "refactor");
  assert.ok(routePreview.routeDecision);
  assert.ok(routePreview.executionPlan?.steps?.length > 0);

  const routeInspectResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "route",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  const routeInspect = JSON.parse(routeInspectResult.stdout);
  assert.ok(Object.prototype.hasOwnProperty.call(routeInspect, "taskClassification"));
  assert.ok(Object.prototype.hasOwnProperty.call(routeInspect, "routeDecision"));

  const planPreviewResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "plan",
    "Investigate",
    "the",
    "failing",
    "shell",
    "reattach",
    "path",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  const planPreview = JSON.parse(planPreviewResult.stdout);
  assert.equal(planPreview.graphType, "dependency_graph_v1");
  assert.ok(Array.isArray(planPreview.subtasks));
  assert.ok(planPreview.steps.some((step) => step.type === "verify"));

  const planCurrentResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "plan",
    "current",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  assert.match(planCurrentResult.stdout, /Plan unavailable/);

  const planTimelineResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "plan",
    "timeline",
    "current",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  assert.match(planTimelineResult.stdout, /Plan timeline unavailable/);

  const whyOverviewResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "why",
    "overview",
    "current",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  assert.match(whyOverviewResult.stdout, /Why Overview: status=ok source=current/);
  assert.match(whyOverviewResult.stdout, /No route decision is recorded/);

  const nextResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "next",
    "current",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  assert.match(nextResult.stdout, /Next Overview: status=ok source=current/);
  assert.match(nextResult.stdout, /plan timeline current summary/);

  const recoverResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "recover",
    "current",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  assert.match(recoverResult.stdout, /Recover Overview: status=ok source=current/);
  assert.match(recoverResult.stdout, /No focused recovery path is needed/);

  const historySessionsResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "history",
    "sessions",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  assert.match(historySessionsResult.stdout, /History · sessions/);

  const resumeRecommendResult = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "resume",
    "recommend",
    "current",
    "summary",
    "--cwd",
    root,
    "--provider",
    "mock",
  ], {
    cwd: process.cwd(),
  });
  assert.match(resumeRecommendResult.stdout, /^Resume$/m);
});
