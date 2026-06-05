import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCurrentVerifierInspectReport,
  compareVerifierInspectReports,
  createVerifierInspectResolvedReference,
  evaluateVerifierRegressionGate,
} from "../src/lib/agent-verifier-inspect.mjs";
import { applyVerifierGitHubMutation } from "../src/lib/agent-verifier-github.mjs";
import { VerifierGitHubMutationStore } from "../src/lib/agent-verifier-github-store.mjs";
import { VerifierInspectArtifactStore } from "../src/lib/agent-verifier-inspect-artifact-store.mjs";
import { VerifierReleaseStore } from "../src/lib/agent-verifier-release-store.mjs";
import { VerifierInspectSnapshotStore } from "../src/lib/agent-verifier-inspect-store.mjs";
import { EvalRunner } from "../src/lib/eval-runner.mjs";
import {
  createVerifierGitHubActionsBackfillInputFromEnv,
  createVerifierGitHubChecksPayloadFromSelection,
} from "../src/lib/agent-verifier-release-triage.mjs";
import {
  buildWorkerPrompt,
  fillCommandTemplate,
  loadDirectorConfig,
  parseReviewDecision,
  runOvernightDirector,
} from "../src/lib/overnight-director.mjs";

test("parseReviewDecision extracts strict JSON from fenced output", () => {
  const decision = parseReviewDecision([
    "irrelevant preface",
    "```json",
    JSON.stringify({
      status: "continue",
      summary: "Keep going.",
      findings: ["one", "two"],
      next_prompt: "Do the next thing",
      suggested_checks: ["npm test"],
    }),
    "```",
  ].join("\n"));

  assert.equal(decision.status, "continue");
  assert.equal(decision.summary, "Keep going.");
  assert.deepEqual(decision.findings, ["one", "two"]);
  assert.equal(decision.nextPrompt, "Do the next thing");
});

test("fillCommandTemplate replaces prompt and repo placeholders", () => {
  const command = fillCommandTemplate("cmd --repo {repo_root} --prompt {prompt_file}", {
    repo_root: "/tmp/repo",
    prompt_file: "/tmp/repo/prompt.md",
  });

  assert.equal(command, "cmd --repo /tmp/repo --prompt /tmp/repo/prompt.md");
});

test("buildWorkerPrompt carries the reviewer summary and directive", () => {
  const prompt = buildWorkerPrompt({
    goal: "Ship a stable overnight loop",
    workerIteration: 2,
    review: {
      status: "continue",
      summary: "Tighten the automation.",
      findings: ["Add a state file."],
      nextPrompt: "Implement the change.",
      suggestedChecks: ["npm test"],
    },
  }, "Implement the change.");

  assert.match(prompt, /Tighten the automation/);
  assert.match(prompt, /Implement the change/);
  assert.match(prompt, /npm test/);
});

test("runOvernightDirector performs a review-worker-review loop with configurable commands", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-overnight-"));
  const reviewer = path.resolve("fixtures/mock-overnight-reviewer.mjs");
  const worker = path.resolve("fixtures/mock-overnight-worker.mjs");

  const config = await loadDirectorConfig(tempRoot, {
    goal: "Create a small overnight demo artifact.",
    reviewerCommand: `${process.execPath} ${reviewer}`,
    workerCommand: `${process.execPath} ${worker}`,
    maxIterations: 2,
    stateDir: ".mj-code/overnight",
  });
  config.verifyCommands = [];
  config.diffPaths = [];

  const result = await runOvernightDirector(config);

  assert.equal(result.status, "stopped");
  assert.equal(result.workerCount, 1);
  assert.ok(result.lastReviewPath);
  assert.ok(result.lastWorkerPath);

  const artifact = await fs.readFile(path.join(tempRoot, "overnight-demo.txt"), "utf8");
  assert.equal(artifact, "overnight iteration 1\n");

  const latestSummary = await fs.readFile(path.join(tempRoot, ".mj-code/overnight/latest-summary.md"), "utf8");
  assert.match(latestSummary, /status: stopped/i);
  assert.match(latestSummary, /overnight demo change/i);
  assert.match(latestSummary, /Verifier release handoff:/);
  assert.match(latestSummary, /unavailable:/i);
});

test("runOvernightDirector surfaces verifier release handoff continuity when gate and eval artifacts exist", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-overnight-verifier-"));
  const reviewer = path.resolve("fixtures/mock-overnight-reviewer.mjs");
  const worker = path.resolve("fixtures/mock-overnight-worker.mjs");
  const projectStateDir = path.join(tempRoot, ".mj-code");
  const snapshotStore = new VerifierInspectSnapshotStore(projectStateDir);
  const artifactStore = new VerifierInspectArtifactStore(projectStateDir);
  const releaseStore = new VerifierReleaseStore(projectStateDir);
  const report = buildCurrentVerifierInspectReport({
    sessionId: null,
    lastTrace: null,
    lastVerifierRun: null,
    lastRepairLoop: null,
  });
  const currentReference = createVerifierInspectResolvedReference({
    kind: "current",
    scope: report.scope,
    sessionId: report.sessionId,
    traceId: report.traceId,
  });
  const exportedSnapshot = await snapshotStore.exportSnapshot({
    source: currentReference,
    report,
  });
  await snapshotStore.pinBaseline({
    name: "release-main",
    snapshot: exportedSnapshot,
    policyProfileId: "release",
  });

  const compare = compareVerifierInspectReports({
    leftReference: createVerifierInspectResolvedReference({
      kind: "baseline",
      reference: "release-main",
      scope: report.scope,
      sessionId: report.sessionId,
      traceId: report.traceId,
      snapshotId: exportedSnapshot.metadata.snapshotId,
      baselineName: "release-main",
    }),
    leftReport: report,
    rightReference: currentReference,
    rightReport: report,
  });
  const gate = evaluateVerifierRegressionGate({
    compare,
    profileId: "release",
  });
  const evalRunner = new EvalRunner({
    provider: "mock",
    model: "mock-mj-code-v1",
    maxTokens: 1200,
  });
  const evalResult = evalRunner.runSuite("verification", {
    baselineGate: gate,
  });
  const gateArtifact = await artifactStore.writeGateArtifact(gate);
  const evalArtifact = await artifactStore.writeEvalArtifact(evalResult);
  await releaseStore.writeArtifactHandoff(gateArtifact);
  const evalHandoff = await releaseStore.writeArtifactHandoff(evalArtifact);
  const evalBundle = await releaseStore.exportBundle(evalArtifact.metadata.artifactId);
  const backfillInput = createVerifierGitHubActionsBackfillInputFromEnv({
    GITHUB_RUN_ID: "301",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW: "verifier-release-gate",
    GITHUB_JOB: "verifier-release-gate",
    GITHUB_SHA: "abc123def456",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REPOSITORY: "demo/mj-code",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_ACTOR: "nightly-bot",
    MJ_VERIFIER_UPLOAD_NAME: "verifier-release-301",
    MJ_VERIFIER_UPLOAD_ARTIFACT_ID: "artifact-401",
    MJ_VERIFIER_UPLOAD_ARTIFACT_URL: "https://github.com/demo/mj-code/actions/runs/301/artifacts/401",
    MJ_VERIFIER_UPLOAD_ARTIFACT_DIGEST: "sha256:012345",
    MJ_VERIFIER_UPLOAD_RETENTION_DAYS: "14",
  });
  assert.ok(backfillInput);
  await releaseStore.backfillGitHubActionsMetadata(evalArtifact.metadata.artifactId, backfillInput);
  const mutationStore = new VerifierGitHubMutationStore(projectStateDir);
  const mutationSelection = await releaseStore.loadHandoff(evalArtifact.metadata.artifactId);
  const mutationPayload = createVerifierGitHubChecksPayloadFromSelection(mutationSelection);
  const mutation = await applyVerifierGitHubMutation({
    reference: "latest",
    payload: mutationPayload,
    existing: null,
    env: {
      GITHUB_TOKEN: "ghs_demo",
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: "demo/mj-code",
      GITHUB_SHA: "abc123def456",
    },
    fetchImpl: async () => ({
      ok: true,
      status: 201,
      async json() {
        return {
          id: 4401,
          html_url: "https://github.com/demo/mj-code/runs/4401",
          details_url: "https://github.com/demo/mj-code/actions/runs/301",
        };
      },
      async text() {
        return "";
      },
    }),
  });
  await mutationStore.writeResult(mutation);

  const config = await loadDirectorConfig(tempRoot, {
    goal: "Keep overnight summaries verifier-aware.",
    reviewerCommand: `${process.execPath} ${reviewer}`,
    workerCommand: `${process.execPath} ${worker}`,
    maxIterations: 2,
    stateDir: ".mj-code/overnight",
  });
  config.verifyCommands = [];
  config.diffPaths = [];

  const result = await runOvernightDirector(config);

  assert.equal(result.status, "stopped");
  const latestSummary = await fs.readFile(path.join(tempRoot, ".mj-code/overnight/latest-summary.md"), "utf8");
  assert.match(latestSummary, /Verifier release handoff:/);
  assert.match(latestSummary, new RegExp(`handoff=${evalHandoff.metadata.handoffId}`));
  assert.match(latestSummary, /source=eval/);
  assert.match(latestSummary, /policy profile: release/);
  assert.match(latestSummary, /baseline: release-main/);
  assert.match(latestSummary, new RegExp(`latest bundle: ${evalBundle.metadata.bundleId}`));
  assert.match(latestSummary, /target: current/);
  assert.match(latestSummary, /promotion: eligible;/);
  assert.match(latestSummary, new RegExp(`latest gate artifact: ${gateArtifact.metadata.artifactId}`));
  assert.match(latestSummary, new RegExp(`latest eval artifact: ${evalArtifact.metadata.artifactId}`));
  assert.match(latestSummary, /upload artifact: artifact-401/);
  assert.match(latestSummary, /upload url: https:\/\/github\.com\/demo\/mj-code\/actions\/runs\/301\/artifacts\/401/);
  assert.match(latestSummary, /upload digest: sha256:012345/);
  assert.match(latestSummary, /github mutation: success/);
  assert.match(latestSummary, /github mutation id:/);
  assert.match(latestSummary, /github check run: 4401/);

  const verifierSummary = JSON.parse(
    await fs.readFile(path.join(tempRoot, ".mj-code/overnight/verifier-handoff.json"), "utf8"),
  );
  assert.equal(verifierSummary.available, true);
  assert.equal(verifierSummary.handoffId, evalHandoff.metadata.handoffId);
  assert.equal(verifierSummary.sourceKind, "eval");
  assert.equal(verifierSummary.policyProfileId, "release");
  assert.equal(verifierSummary.pass, true);
  assert.equal(verifierSummary.latestGateArtifactId, gateArtifact.metadata.artifactId);
  assert.equal(verifierSummary.latestEvalArtifactId, evalArtifact.metadata.artifactId);
  assert.equal(verifierSummary.latestBundleId, evalBundle.metadata.bundleId);
  assert.equal(verifierSummary.baselineName, "release-main");
  assert.equal(verifierSummary.targetReferenceLabel, "current");
  assert.equal(verifierSummary.promotionStatus, "eligible");
  assert.match(verifierSummary.promotionSummary, /passed under policy release/);
  assert.equal(verifierSummary.uploadArtifactId, "artifact-401");
  assert.equal(verifierSummary.uploadArtifactUrl, "https://github.com/demo/mj-code/actions/runs/301/artifacts/401");
  assert.equal(verifierSummary.uploadArtifactDigest, "sha256:012345");
  assert.equal(verifierSummary.githubMutationStatus, "success");
  assert.equal(verifierSummary.githubCheckRunId, 4401);
  assert.equal(verifierSummary.summary, evalHandoff.summary);

  const state = JSON.parse(
    await fs.readFile(path.join(tempRoot, ".mj-code/overnight/state.json"), "utf8"),
  );
  assert.equal(state.verifier.available, true);
  assert.equal(state.verifier.handoffId, evalHandoff.metadata.handoffId);
  assert.equal(state.verifier.latestEvalArtifactId, evalArtifact.metadata.artifactId);
  assert.equal(state.verifier.latestBundleId, evalBundle.metadata.bundleId);
  assert.equal(state.verifier.promotionStatus, "eligible");
  assert.equal(state.verifier.uploadArtifactId, "artifact-401");
  assert.equal(state.verifier.githubMutationStatus, "success");
  assert.equal(state.verifier.githubCheckRunId, 4401);
});
