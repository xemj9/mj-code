import test from "node:test";
import assert from "node:assert/strict";

import {
  parseInteractionAboutArgs,
  parseInteractionHistoryArgs,
  parseInteractionResumeArgs,
  parseInteractionStatusArgs,
} from "../src/lib/agent-interaction-cli.mjs";
import {
  parseDecisionActionArgs,
  parseWhyCommandArgs,
} from "../src/lib/agent-decision-cli.mjs";
import { parsePlanCommandArgs } from "../src/lib/agent-plan-cli.mjs";
import {
  renderAgentDecisionReport,
} from "../src/lib/agent-decision-inspect.mjs";
import {
  buildPlanCurrentReport as buildPlanCurrentInspectReport,
  buildPlanTimelineReport as buildPlanTimelineInspectReport,
  renderPlanCurrentReport as renderPlanCurrentInspectReport,
  renderPlanTimelineReport as renderPlanTimelineInspectReport,
} from "../src/lib/agent-plan-inspect.mjs";
import { Planner } from "../src/lib/planner.mjs";

test("plan cli parser keeps bounded current and timeline semantics stable", () => {
  assert.deepEqual(
    parsePlanCommandArgs(["current", "summary"], "plan usage"),
    {
      kind: "current",
      profile: "summary",
    },
  );
  assert.deepEqual(
    parsePlanCommandArgs(["timeline", "replay:session-1", "failures"], "plan usage"),
    {
      kind: "timeline",
      reference: "replay:session-1",
      profile: "failures",
    },
  );
  assert.deepEqual(
    parsePlanCommandArgs(["replay", "session-1", "summary"], "plan usage"),
    {
      kind: "timeline",
      reference: "replay:session-1",
      profile: "summary",
    },
  );
  assert.deepEqual(
    parsePlanCommandArgs(["last"], "plan usage"),
    {
      kind: "legacy_last",
    },
  );
});

test("plan current and timeline renderers stay bounded and stable", () => {
  const planner = new Planner();
  let plan = planner.createPlan({
    prompt: "Fix the planner and verify the result.",
    taskClassification: {
      taskClass: "bug_fix",
      likelyWrites: true,
      likelyShell: true,
    },
    routeDecision: {
      routeId: "route-render",
      selectedCapabilities: [
        { name: "apply_patch" },
        { name: "run_shell" },
      ],
    },
    modelDecision: {
      chosenProvider: "mock",
      chosenModel: "gpt-5.4",
      fallbackModels: [],
      fallbackChain: [],
      reason: "primary",
    },
  });

  plan = planner.noteToolExecution(plan, "apply_patch", {}, true);
  plan = planner.noteVerificationStarted(plan, { note: "Verifier started." });
  plan = planner.noteVerificationResult(plan, {
    success: false,
    note: "Verification failed on changed files.",
  });

  const current = buildPlanCurrentInspectReport({
    kind: "current",
    reference: null,
    sessionId: "session-render",
    traceId: "trace-render",
    planId: plan.planId,
  }, plan);
  const timeline = buildPlanTimelineInspectReport({
    kind: "current",
    reference: null,
    sessionId: "session-render",
    traceId: "trace-render",
    planId: plan.planId,
  }, plan);

  const currentSummary = renderPlanCurrentInspectReport(current, "summary");
  const timelineFailures = renderPlanTimelineInspectReport(timeline, "failures");

  assert.match(currentSummary, /Plan Current:/);
  assert.match(currentSummary, /Latest Replan:/);
  assert.match(currentSummary, /Next Commands:/);
  assert.match(timelineFailures, /Plan Timeline:/);
  assert.match(timelineFailures, /Leading Problem:/);
  assert.match(timelineFailures, /Blockers:/);
});

test("decision cli parsers keep why/next/recover reference semantics stable", () => {
  assert.deepEqual(
    parseWhyCommandArgs(["plan", "replay:session-1", "failures"], "why usage"),
    {
      scope: "plan",
      reference: "replay:session-1",
      profile: "failures",
    },
  );
  assert.deepEqual(
    parseDecisionActionArgs(["latest", "summary"], "next usage"),
    {
      reference: "latest",
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseDecisionActionArgs(["session-2", "failures"], "recover usage"),
    {
      reference: "replay:session-2",
      profile: "failures",
    },
  );
});

test("interaction cli parsers keep status/history/about semantics stable", () => {
  assert.deepEqual(
    parseInteractionStatusArgs(["json"], "status usage"),
    {
      profile: "json",
    },
  );
  assert.deepEqual(
    parseInteractionHistoryArgs(["sessions", "summary"], "history usage"),
    {
      scope: "sessions",
      reference: "current",
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseInteractionHistoryArgs(["lineage", "latest", "failures"], "history usage"),
    {
      scope: "lineage",
      reference: "latest",
      profile: "failures",
    },
  );
  assert.deepEqual(
    parseInteractionResumeArgs(["recommend", "current", "summary"], "resume usage"),
    {
      kind: "recommend",
      reference: "current",
      profile: "summary",
    },
  );
  assert.deepEqual(
    parseInteractionResumeArgs(["lineage", "session-1", "failures"], "resume usage"),
    {
      kind: "lineage",
      reference: "session-1",
      profile: "failures",
    },
  );
  assert.deepEqual(
    parseInteractionAboutArgs([], "about usage"),
    {
      profile: "summary",
    },
  );
});

test("decision renderer keeps unavailable and bounded recovery output stable", () => {
  const report = {
    scope: "overview",
    source: {
      kind: "current",
      reference: null,
      sessionId: null,
      traceId: null,
      planId: null,
    },
    available: false,
    status: "unavailable",
    assessment: {
      bounded: false,
      confidence: "low",
      unavailableReason: "No state.",
    },
    taskClassification: null,
    routeDecision: null,
    modelDecision: null,
    executionPlan: null,
    planCurrent: null,
    planTimeline: null,
    verifier: null,
    runtimeScorecard: null,
    toolContext: null,
    githubMutation: null,
    leadingProblem: null,
    degradedLayers: [],
    blockingReasons: [],
    nextSteps: [],
    recovery: [],
  };

  assert.match(renderAgentDecisionReport(report, "summary", "why"), /Why report unavailable/);
  assert.match(renderAgentDecisionReport(report, "summary", "next"), /Next steps unavailable/);
  assert.match(renderAgentDecisionReport(report, "summary", "recover"), /Recovery guidance unavailable/);
});
