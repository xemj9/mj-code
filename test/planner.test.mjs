import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { buildAgentDecisionReport } from "../src/lib/agent-decision-inspect.mjs";
import {
  buildPlanCurrentReport,
  buildPlanTimelineReport,
} from "../src/lib/agent-plan-inspect.mjs";
import { Planner } from "../src/lib/planner.mjs";

test("planner builds a verification-biased graph for code edits", () => {
  const planner = new Planner();
  const plan = planner.createPlan({
    prompt: "Refactor the CLI parser and rerun tests.",
    taskClassification: {
      taskClass: "refactor",
    },
    routeDecision: {
      routeId: "route-1",
      selectedCapabilities: [
        { name: "read_file" },
        { name: "apply_patch" },
        { name: "run_shell" },
      ],
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
    },
  });

  assert.equal(plan.taskClass, "refactor");
  assert.equal(plan.verificationBias, true);
  assert.ok(plan.steps.some((entry) => entry.type === "verify"));
  assert.ok(plan.steps.some((entry) => entry.type === "fallback"));
  assert.ok(plan.edges.some((entry) => entry.condition === "if verification fails"));
});

test("planner progresses through inspect, edit, and verify steps", () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Fix the failing tests and verify the build.",
    taskClassification: {
      taskClass: "test_repair",
    },
    routeDecision: {
      routeId: "route-1",
      selectedCapabilities: [
        { name: "read_file" },
        { name: "apply_patch" },
        { name: "run_shell" },
      ],
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
    },
  });

  plan = planner.noteContextPrepared(plan);
  plan = planner.noteToolExecution(plan, "read_file", {}, true);
  plan = planner.noteToolExecution(plan, "apply_patch", {}, true);
  plan = planner.noteToolExecution(plan, "run_shell", { command: "npm test" }, true);

  assert.ok(plan.completedSteps.length >= 2);
  assert.ok(plan.steps.some((entry) => entry.type === "verify" && entry.status === "completed"));
});

test("planner noteFinal marks summarize blocked on failure and clears the active step", () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Fix the failing tests and verify the build.",
    taskClassification: {
      taskClass: "test_repair",
    },
    routeDecision: {
      routeId: "route-1",
      selectedCapabilities: [
        { name: "read_file" },
        { name: "apply_patch" },
        { name: "run_shell" },
      ],
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
    },
  });

  plan = planner.noteContextPrepared(plan);
  plan = planner.noteFinal(plan, { success: false });

  assert.equal(plan.status, "failed");
  assert.equal(plan.currentStep, null);
  assert.ok(plan.failedSteps.length >= 1);
  assert.ok(plan.blockedSteps.length >= 1);
  assert.ok(plan.steps.some((entry) => entry.type === "summarize" && entry.status === "blocked"));
});

test("planner exposes explicit verification progression and fallback visibility", () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Fix the bug, verify changed files, and report back.",
    taskClassification: {
      taskClass: "bug_fix",
    },
    routeDecision: {
      routeId: "route-verify",
      selectedCapabilities: [
        { name: "read_file" },
        { name: "write_file" },
      ],
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
    },
  });

  plan = planner.noteContextPrepared(plan);
  plan = planner.noteToolExecution(plan, "write_file", {}, true);
  plan = planner.noteVerificationStarted(plan, {
    note: "Verifier started for changed files.",
  });

  assert.ok(plan.steps.some((entry) => entry.type === "verify" && entry.status === "in_progress"));

  plan = planner.noteVerificationResult(plan, {
    success: false,
    note: "Changed-file parse verifier failed.",
  });

  assert.equal(plan.status, "degraded");
  assert.ok(plan.steps.some((entry) => entry.type === "verify" && entry.status === "failed"));
  assert.ok(plan.steps.some((entry) => entry.type === "fallback" && entry.status === "in_progress"));
});

test("planner tracks repair attempts through fallback start and exhaustion", () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Fix the bug, verify, then retry once if verification fails.",
    taskClassification: {
      taskClass: "bug_fix",
    },
    routeDecision: {
      routeId: "route-repair",
      selectedCapabilities: [
        { name: "write_file" },
        { name: "run_shell" },
      ],
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
    },
  });

  plan = planner.noteContextPrepared(plan);
  plan = planner.noteToolExecution(plan, "write_file", {}, true);
  plan = planner.noteVerificationStarted(plan, {
    note: "Verifier started for changed files.",
  });
  plan = planner.noteVerificationResult(plan, {
    success: false,
    note: "Diagnostics failed.",
  });
  plan = planner.noteRepairStarted(plan, {
    attempt: 1,
    maxAttempts: 1,
    note: "Repair attempt 1/1 started.",
  });

  assert.ok(plan.steps.some((entry) =>
    entry.type === "fallback" &&
    entry.status === "in_progress" &&
    entry.note === "Repair attempt 1/1 started."
  ));

  plan = planner.noteRepairResult(plan, {
    success: false,
    exhausted: true,
    note: "Repair budget exhausted.",
  });

  assert.equal(plan.status, "failed");
  assert.ok(plan.steps.some((entry) =>
    entry.type === "fallback" &&
    entry.status === "failed" &&
    entry.note === "Repair budget exhausted."
  ));
});

test("planner marks repair success without losing the verify path", () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Fix the bug, verify, repair once, then finish.",
    taskClassification: {
      taskClass: "bug_fix",
    },
    routeDecision: {
      routeId: "route-repair-success",
      selectedCapabilities: [
        { name: "write_file" },
      ],
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
    },
  });

  plan = planner.noteContextPrepared(plan);
  plan = planner.noteVerificationStarted(plan);
  plan = planner.noteVerificationResult(plan, {
    success: false,
    note: "Initial verification failed.",
  });
  plan = planner.noteRepairStarted(plan, {
    attempt: 1,
    maxAttempts: 1,
  });
  plan = planner.noteRepairResult(plan, {
    success: true,
    note: "Repair succeeded and verification can proceed.",
  });

  assert.equal(plan.status, "active");
  assert.ok(plan.steps.some((entry) => entry.type === "fallback" && entry.status === "completed"));
});

test("planner creates bounded decomposition, dependencies, and verification requirements", () => {
  const planner = new Planner();
  const plan = planner.createPlan({
    prompt: "Refactor the planner, update the loop, and verify the result.",
    taskClassification: {
      taskClass: "refactor",
      riskHint: "Likely edits core orchestration files.",
      likelyWrites: true,
      likelyShell: true,
    },
    routeDecision: {
      routeId: "route-plan",
      selectedCapabilities: [
        { name: "read_file" },
        { name: "apply_patch" },
        { name: "run_shell" },
      ],
      governance: {
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
        networkMode: "docs-only",
        degradedFlags: [],
      },
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
      chosenProvider: "mock",
      fallbackModels: [],
      fallbackChain: [],
      reason: "primary model",
    },
  });

  assert.equal(plan.graphType, "dependency_graph_v1");
  assert.equal(plan.goal.taskClass, "refactor");
  assert.ok(plan.subtasks.some((entry) => entry.id === "context"));
  assert.ok(plan.subtasks.some((entry) => entry.id === "verification"));
  const edit = plan.steps.find((entry) => entry.type === "edit");
  const analyze = plan.steps.find((entry) => entry.type === "analyze");
  const verify = plan.steps.find((entry) => entry.type === "verify");
  assert.deepEqual(edit.dependsOn, [analyze.id]);
  assert.equal(edit.verification.required, true);
  assert.equal(verify.verification.trigger, "before_finalize");
  assert.ok(edit.riskHints.some((entry) => entry.kind === "approval"));
});

test("planner records blocked-step replanning and terminal provider stop conditions", () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Edit the file, then verify and summarize.",
    taskClassification: {
      taskClass: "bug_fix",
      likelyWrites: true,
      likelyShell: true,
    },
    routeDecision: {
      routeId: "route-blocked",
      selectedCapabilities: [
        { name: "apply_patch" },
        { name: "run_shell" },
      ],
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
      chosenProvider: "mock",
      fallbackModels: [],
      fallbackChain: [],
      reason: "primary model",
    },
  });

  plan = planner.noteToolBlocked(plan, {
    toolName: "apply_patch",
    reasonKind: "permission_denied",
    summary: "Write access denied for apply_patch.",
    commandInput: {},
  });

  assert.equal(plan.status, "active");
  assert.equal(plan.replanCount, 1);
  assert.ok(plan.blockedReasons.some((entry) => entry.kind === "permission_denied"));
  assert.ok(plan.steps.some((entry) => entry.type === "analyze" && entry.status === "in_progress"));

  plan = planner.noteProviderFailure(plan, {
    taxonomy: "provider_circuit_open",
    summary: "Provider circuit opened during completion.",
  });

  assert.equal(plan.status, "failed");
  assert.equal(plan.stopCondition.kind, "provider_failed");
  assert.equal(plan.stopCondition.status, "stop");
  assert.equal(plan.currentStep, null);
});

test("planner reports expose blockers, replan continuity, and next commands", () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Fix the failing tests and keep verification bounded.",
    taskClassification: {
      taskClass: "test_repair",
      likelyWrites: true,
      likelyShell: true,
    },
    routeDecision: {
      routeId: "route-report",
      selectedCapabilities: [
        { name: "apply_patch" },
        { name: "run_shell" },
      ],
    },
    modelDecision: {
      chosenModel: "gpt-5.4",
      chosenProvider: "mock",
      fallbackModels: [],
      fallbackChain: [],
      reason: "primary model",
    },
  });

  plan = planner.noteToolExecution(plan, "apply_patch", {}, true);
  plan = planner.noteVerificationStarted(plan, { note: "Verifier started for changed files." });
  plan = planner.noteVerificationResult(plan, {
    success: false,
    note: "Verification failed on ts diagnostics.",
  });
  plan = planner.noteRepairResult(plan, {
    success: false,
    exhausted: true,
    note: "Repair budget exhausted.",
  });

  const current = buildPlanCurrentReport({
    kind: "current",
    reference: null,
    sessionId: "session-1",
    traceId: "trace-1",
    planId: plan.planId,
  }, plan);
  const timeline = buildPlanTimelineReport({
    kind: "current",
    reference: null,
    sessionId: "session-1",
    traceId: "trace-1",
    planId: plan.planId,
  }, plan);

  assert.equal(current.summary.status, "failed");
  assert.ok(current.blockers.some((entry) => entry.kind === "verifier_failed"));
  assert.ok(current.suggestedCommands.some((entry) => entry.command.includes("verifier trace summary")));
  assert.equal(timeline.latestState.stopCondition.kind, "repair_exhausted");
  assert.match(timeline.leadingProblemEvent.summary, /Repair budget/);
  assert.ok(timeline.suggestedCommands.some((entry) => entry.command.includes("plan timeline current summary")));
});

test("decision report reuses planner continuity for why/recovery on repair exhaustion", async () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Fix the verifier failure and stop once repair is exhausted.",
    taskClassification: {
      taskClass: "bug_fix",
      confidence: 0.92,
      reasons: ["Bug fix task."],
      freshnessRequired: false,
      externalCapabilityNeeded: false,
      likelyWrites: true,
      likelyShell: true,
      likelyWeb: false,
      likelyMcp: false,
      riskHint: "Core code edit.",
    },
    routeDecision: {
      taskClass: "bug_fix",
      selectedCapabilities: [{ name: "write_file" }],
      rejectedCapabilities: [],
      requiredCapabilities: ["write_file"],
      blockedCapabilities: [],
      routingMode: "local-first",
      reasons: ["Local edit path is enough."],
      degraded: false,
    },
    modelDecision: {
      chosenProvider: "mock",
      chosenModel: "gpt-5.4",
      fallbackModels: [],
      fallbackChain: [],
      reason: "Primary reasoning model.",
    },
  });

  plan = planner.noteVerificationStarted(plan);
  plan = planner.noteVerificationResult(plan, {
    success: false,
    note: "Verifier failed on changed files.",
  });
  plan = planner.noteRepairStarted(plan, {
    attempt: 1,
    maxAttempts: 1,
    note: "Repair attempt 1/1.",
  });
  plan = planner.noteRepairResult(plan, {
    success: false,
    exhausted: true,
    note: "Repair budget exhausted.",
  });

  const report = await buildAgentDecisionReport({
    config: {
      projectStateDir: path.join(os.tmpdir(), "mj-decision-planner-test"),
    },
    sessionId: "session-planner",
    lastTrace: {
      traceId: "trace-planner",
      success: false,
      stopped: true,
      steps: 4,
      durationMs: 10,
      toolsUsed: ["write_file"],
      approvalsAsked: 0,
      approvalsApproved: 0,
      approvalsDenied: 0,
      executionPlan: plan,
    },
    lastChangeSet: null,
    lastTaskClassification: null,
    lastRouteDecision: null,
    lastModelDecision: null,
    lastExecutionPlan: plan,
    lastVerifierRun: null,
    lastRepairLoop: null,
    runtimeHealth: {
      getScorecard() {
        return {
          degradedFlags: [],
          provider: {},
        };
      },
    },
    sessionStore: {
      async buildReplay() {
        throw new Error("replay not required");
      },
    },
    executionJournal: {
      async loadLatestSnapshot() {
        return null;
      },
      async readEntries() {
        return [];
      },
    },
  }, "plan", "current");

  assert.equal(report.available, true);
  assert.equal(report.status, "failed");
  assert.equal(report.leadingProblem?.kind, "repair_exhausted");
  assert.equal(report.recovery[0]?.kind, "repair_exhausted");
  assert.ok(report.nextSteps.some((entry) => entry.command.includes("plan timeline")));
});
