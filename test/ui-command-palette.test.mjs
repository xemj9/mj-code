import test from "node:test";
import assert from "node:assert/strict";

import { createAnsi } from "../src/lib/ansi.mjs";
import { getInteractiveCommandPalette } from "../src/lib/command-catalog.mjs";
import { shouldBypassInteractiveShellOverlay } from "../src/lib/interactive-shell-commands.mjs";
import { createSlashPaletteController } from "../src/lib/ui.mjs";
import { buildInteractiveSessionPickerReport } from "../src/lib/agent-session-browser.mjs";

function createFakeOutput() {
  return {
    chunks: "",
    write(value) {
      this.chunks += value;
    },
    reset() {
      this.chunks = "";
    },
  };
}

function createFakeReadline(line = "") {
  return {
    line,
    write(value, key) {
      if (key?.ctrl === true && key?.name === "u") {
        this.line = "";
        return;
      }
      if (typeof value === "string") {
        this.line += value;
      }
    },
  };
}

function createBrowserReport() {
  return {
    brand: {
      productName: "MJ Code",
      editionName: "xiemingjin edition",
      attributionSummary: "Designed by 谢明锦 / Xie Mingjin",
    },
    createdAt: "2026-04-09T00:00:00.000Z",
    scope: "sessions",
    reference: {
      requestedReference: "current",
      requestedKind: "current",
      resolution: "current",
      resolvedSessionId: "session-current",
      currentSessionId: "session-current",
    },
    available: true,
    changes: [],
    sessions: [
      {
        sessionId: "session-current",
        filePath: "/tmp/session-current.jsonl",
        provider: "mock",
        model: "gpt-5.4",
        cwd: "/repo",
        networkMode: "offline",
        webProvider: "none",
        rootSessionId: "session-root",
        parentSessionId: null,
        children: [],
        branchDepth: 0,
        branchType: "root",
        startedAt: "2026-04-09T00:00:00.000Z",
        lastUpdatedAt: "2026-04-09T00:05:00.000Z",
        resumedAt: null,
        resumedFromSnapshot: null,
        eventCount: 12,
        finalContentPreview: "current preview",
        relationToCurrent: "current",
        relationToReference: "self",
        continuityStatus: "active",
        ageDays: 0,
        availability: {
          snapshotAvailable: true,
          replayAvailable: true,
          planAvailable: true,
          verifierAvailable: true,
          decisionAvailable: true,
        },
        latest: {
          activityAt: "2026-04-09T00:05:00.000Z",
          planStatus: "active",
          verifierStatus: "passed",
          repairStatus: "succeeded",
        },
        resume: {
          status: "not_needed",
          reasonKind: "already_current",
          summary: "already current",
        },
        suggestedCommands: [],
      },
      {
        sessionId: "session-branch-1",
        filePath: "/tmp/session-branch-1.jsonl",
        provider: "mock",
        model: "gpt-5.4",
        cwd: "/repo",
        networkMode: "offline",
        webProvider: "none",
        rootSessionId: "session-root",
        parentSessionId: "session-root",
        children: [],
        branchDepth: 1,
        branchType: "resume",
        startedAt: "2026-04-08T00:00:00.000Z",
        lastUpdatedAt: "2026-04-09T00:02:00.000Z",
        resumedAt: "2026-04-08T00:00:00.000Z",
        resumedFromSnapshot: null,
        eventCount: 9,
        finalContentPreview: "branch preview",
        relationToCurrent: "related",
        relationToReference: "related",
        continuityStatus: "recent",
        ageDays: 0,
        availability: {
          snapshotAvailable: true,
          replayAvailable: true,
          planAvailable: true,
          verifierAvailable: false,
          decisionAvailable: true,
        },
        latest: {
          activityAt: "2026-04-09T00:02:00.000Z",
          planStatus: "blocked",
          verifierStatus: null,
          repairStatus: null,
        },
        resume: {
          status: "recommended",
          reasonKind: "related_recent_session",
          summary: "worth resuming",
        },
        suggestedCommands: [],
      },
    ],
    lineage: null,
    replay: null,
    summary: {
      sessionCount: 2,
      changeCount: 0,
      activeSessionId: "session-current",
      recommendedResumeSessionId: "session-branch-1",
      staleSessionCount: 0,
      planAvailableCount: 2,
      verifierAvailableCount: 1,
      decisionAvailableCount: 2,
    },
    suggestedCommands: [],
  };
}

function createRecommendationReport() {
  return {
    brand: {
      productName: "MJ Code",
      editionName: "xiemingjin edition",
      attributionSummary: "Designed by 谢明锦 / Xie Mingjin",
    },
    createdAt: "2026-04-09T00:00:00.000Z",
    reference: {
      requestedReference: "current",
      requestedKind: "current",
      resolution: "current",
      resolvedSessionId: "session-current",
      currentSessionId: "session-current",
    },
    available: true,
    anchorSession: null,
    relatedSessions: [],
    recommendation: {
      status: "recommended",
      reasonKind: "related_recent_session",
      recommendedSessionId: "session-branch-1",
      relationToCurrent: "related",
      relationToReference: "related",
      continuityStatus: "recent",
      summary: "resume session-branch-1",
      blockers: [],
      suggestedCommands: [],
    },
    suggestedCommands: [],
  };
}

function createPickerReportFromLine(line) {
  if (line.startsWith("/continue __actions__ session-current")) {
    const browserReport = createBrowserReport();
    return buildInteractiveSessionPickerReport({
      mode: "continue_actions",
      browserReport: {
        ...browserReport,
        reference: {
          ...browserReport.reference,
          requestedReference: "session-current",
          requestedKind: "session",
          resolution: "session",
          resolvedSessionId: "session-current",
        },
      },
      recommendationReport: createRecommendationReport(),
    });
  }
  if (line.startsWith("/history lineage __actions__ session-branch-1")) {
    const browserReport = createBrowserReport();
    return buildInteractiveSessionPickerReport({
      mode: "history_lineage_actions",
      browserReport: {
        ...browserReport,
        reference: {
          ...browserReport.reference,
          requestedReference: "session-branch-1",
          requestedKind: "session",
          resolution: "session",
          resolvedSessionId: "session-branch-1",
        },
      },
      recommendationReport: createRecommendationReport(),
    });
  }
  if (line.startsWith("/resume __actions__ session-branch-1")) {
    const browserReport = createBrowserReport();
    return buildInteractiveSessionPickerReport({
      mode: "resume_actions",
      browserReport: {
        ...browserReport,
        reference: {
          ...browserReport.reference,
          requestedReference: "session-branch-1",
          requestedKind: "session",
          resolution: "session",
          resolvedSessionId: "session-branch-1",
        },
      },
      recommendationReport: createRecommendationReport(),
    });
  }
  if (line.startsWith("/history lineage")) {
    return buildInteractiveSessionPickerReport({
      mode: "history_lineage",
      browserReport: createBrowserReport(),
      recommendationReport: createRecommendationReport(),
    });
  }
  if (line.startsWith("/continue")) {
    return buildInteractiveSessionPickerReport({
      mode: "continue",
      browserReport: createBrowserReport(),
      recommendationReport: createRecommendationReport(),
    });
  }
  if (line.startsWith("/resume")) {
    return buildInteractiveSessionPickerReport({
      mode: "resume",
      browserReport: createBrowserReport(),
      recommendationReport: createRecommendationReport(),
    });
  }
  return null;
}

test("tty slash palette controller opens, filters, navigates, and injects the selected command", async () => {
  const output = createFakeOutput();
  const ansi = createAnsi(true);
  const controller = createSlashPaletteController({
    ansi,
    output,
    resolvePicker: async (line) => createPickerReportFromLine(line),
  });
  const rl = createFakeReadline("/");

  await controller.syncFromLine(rl.line);
  let state = controller.getState();
  assert.equal(state.visible, true);
  assert.equal(state.selectedCommand, "/continue");
  assert.equal(state.selectedPreview.selectedCommand, "/continue");
  assert.match(state.selectedPreview.nextEffect, /continue browser/i);
  assert.match(output.chunks, /\u001b\[s/);
  assert.match(output.chunks, /╭─+ Launcher · start/);
  assert.match(output.chunks, /start with \/continue, \/status, or \/history/);
  assert.match(output.chunks, /\/continue/);
  assert.match(output.chunks, /\/status/);
  assert.match(output.chunks, /◆ \/continue/);
  assert.match(output.chunks, /\/history sessions/);
  assert.match(output.chunks, /type to filter · enter inserts the selected command/);
  assert.match(output.chunks, /╰─+ filter · ↵ insert · esc close/);
  assert.match(output.chunks, /↵ \/continue/);
  assert.doesNotMatch(output.chunks, /\/about/);
  assert.doesNotMatch(output.chunks, /Core:/);
  assert.doesNotMatch(output.chunks, /Preview:/);
  assert.doesNotMatch(output.chunks, /Keys:/);
  assert.doesNotMatch(output.chunks, /MJ Code Command Palette · xiemingjin edition/);

  output.reset();
  await controller.syncFromLine(rl.line);
  assert.equal(output.chunks, "");

  output.reset();
  rl.line = "/resume";
  await controller.syncFromLine(rl.line);
  state = controller.getState();
  assert.equal(state.visible, true);
  assert.equal(state.mode, "picker");
  assert.equal(state.selectedCommand, "/resume session-branch-1");
  assert.equal(state.selectedPreview.selectedCommand, "/resume session-branch-1");
  assert.match(state.selectedPreview.whySelected, /recommended/i);
  assert.match(output.chunks, /Resume Picker/);
  assert.match(output.chunks, /session-branch-1/);
  assert.match(output.chunks, /↑↓ move · ↵ actions · esc close/);
  assert.match(output.chunks, /↵ \/resume session-branch-1/);
  assert.doesNotMatch(output.chunks, /Preview:/);

  output.reset();
  rl.line = "/";
  await controller.syncFromLine(rl.line);
  const initiallySelected = controller.getState().selectedCommand;
  const initiallyPreviewTarget = controller.getState().selectedPreview.selectedTargetSummary;
  controller.handleKeypress({ name: "down" }, rl);
  state = controller.getState();
  assert.notEqual(state.selectedCommand, initiallySelected);
  assert.notEqual(state.selectedPreview.selectedTargetSummary, initiallyPreviewTarget);

  rl.line = "/stat";
  await controller.syncFromLine(rl.line);
  controller.handleKeypress({ name: "return" }, rl);
  state = controller.getState();
  assert.equal(state.visible, false);
  assert.equal(rl.line, "/status summary");

  rl.line = "/resume";
  await controller.syncFromLine(rl.line);
  const continuation = controller.handleKeypress({ name: "return" }, rl);
  assert.equal(continuation.continuationLine, "/resume __actions__ session-branch-1");
  await controller.syncFromContinuation("/resume", continuation.continuationLine);
  state = controller.getState();
  assert.equal(state.report.step, "action");
  assert.equal(state.selectedCommand, "/resume session-branch-1");
  assert.match(state.selectedPreview.whySelected, /Create a new branch from this session immediately/);
  assert.match(state.selectedPreview.nextEffect, /Enter -> \/resume session-branch-1/);
  assert.match(output.chunks, /Resume Action Picker/);
  assert.doesNotMatch(output.chunks, /Preview:/);
  output.reset();
  controller.handleKeypress({ name: "return" }, rl);
  assert.equal(rl.line, "/resume session-branch-1");
});

test("palette query ranking prioritizes strong prefix matches over generic keyword hits", () => {
  const cases = [
    {
      query: "con",
      top: ["/continue", "/history sessions", "/resume"],
    },
    {
      query: "res",
      top: ["/resume", "/resume recommend", "/resume lineage"],
    },
    {
      query: "hist",
      top: ["/history sessions", "/history replay", "/history lineage"],
    },
    {
      query: "lin",
      top: ["/history lineage", "/resume lineage"],
    },
    {
      query: "rep",
      top: ["/history replay", "/history replay latest summary", "/history sessions"],
    },
    {
      query: "why",
      top: ["/why overview current summary", "/why plan current summary"],
    },
    {
      query: "pla",
      top: ["/plan current summary", "/plan timeline current summary"],
    },
    {
      query: "sta",
      top: ["/status summary", "/continue"],
    },
    {
      query: "mod",
      top: ["/model", "/provider"],
    },
  ];

  for (const item of cases) {
    const report = getInteractiveCommandPalette(item.query);
    const entries = report.sections.flatMap((section) => section.entries);
    assert.deepEqual(
      entries.slice(0, item.top.length).map((entry) => entry.command),
      item.top,
    );
  }

  const resumeReport = getInteractiveCommandPalette("res");
  const resumeEntries = resumeReport.sections.flatMap((section) => section.entries);
  assert.equal(resumeReport.selectedCommand, "/resume");
  assert.equal(resumeEntries[3]?.command, "/resume recommend current summary");
  assert.ok(!resumeEntries.slice(0, 4).some((entry) => entry.command === "/clear"));

  const plainTextMiss = getInteractiveCommandPalette("介绍");
  assert.equal(plainTextMiss.selectedPreview.unavailableReason, "no_match");
  assert.match(plainTextMiss.selectedPreview.whySelected ?? "", /normal message/i);
  assert.match(plainTextMiss.selectedPreview.nextEffect ?? "", /remove the leading/i);
});

test("interactive shell bypasses overlay once a direct slash command is fully formed", () => {
  assert.equal(shouldBypassInteractiveShellOverlay("/status"), true);
  assert.equal(shouldBypassInteractiveShellOverlay("/status summary"), true);
  assert.equal(shouldBypassInteractiveShellOverlay("/about"), true);
  assert.equal(shouldBypassInteractiveShellOverlay("/search query"), true);
  assert.equal(shouldBypassInteractiveShellOverlay("/history replay latest summary"), true);
  assert.equal(shouldBypassInteractiveShellOverlay("/continue"), false);
  assert.equal(shouldBypassInteractiveShellOverlay("/resume"), false);
  assert.equal(shouldBypassInteractiveShellOverlay("/history replay"), false);
  assert.equal(shouldBypassInteractiveShellOverlay("/stat"), false);
});

test("tty slash palette controller can enter the continue browser and inject a bounded next step", async () => {
  const output = createFakeOutput();
  const controller = createSlashPaletteController({
    ansi: createAnsi(true),
    output,
    resolvePicker: async (line) => createPickerReportFromLine(line),
  });
  const rl = createFakeReadline("/continue");

  await controller.syncFromLine(rl.line);
  assert.equal(controller.getState().selectedCommand, "/history lineage session-current summary");
  assert.match(output.chunks, /Continue Browser/);

  const continuation = controller.handleKeypress({ name: "return" }, rl);
  assert.equal(continuation.continuationLine, "/continue __actions__ session-current");
  await controller.syncFromContinuation("/continue", continuation.continuationLine);

  assert.match(output.chunks, /Continue Actions/);
  assert.match(controller.getState().selectedPreview.nextEffect ?? "", /\/history lineage session-current summary/);
});

test("tty slash palette controller closes on escape and stays dismissed until the line changes", async () => {
  const output = createFakeOutput();
  const controller = createSlashPaletteController({ ansi: createAnsi(true), output });
  const rl = createFakeReadline("/hist");

  await controller.syncFromLine(rl.line);
  assert.equal(controller.getState().visible, true);

  controller.handleKeypress({ name: "escape" }, rl);
  assert.equal(controller.getState().visible, false);

  output.reset();
  await controller.syncFromLine(rl.line);
  assert.equal(controller.getState().visible, false);
  assert.equal(output.chunks, "");

  rl.line = "/histo";
  await controller.syncFromLine(rl.line);
  assert.equal(controller.getState().visible, true);
});

test("tty slash palette controller gets out of the way for direct slash execution", async () => {
  const output = createFakeOutput();
  const controller = createSlashPaletteController({ ansi: createAnsi(true), output });
  const rl = createFakeReadline("/stat");

  await controller.syncFromLine(rl.line);
  assert.equal(controller.getState().visible, true);

  rl.line = "/status";
  await controller.syncFromLine(rl.line);
  assert.equal(controller.getState().visible, false);

  rl.line = "/history replay latest summary";
  await controller.syncFromLine(rl.line);
  assert.equal(controller.getState().visible, false);
});

test("tty slash palette controller supports section jumps across palette sections", async () => {
  const output = createFakeOutput();
  const controller = createSlashPaletteController({ ansi: createAnsi(true), output });
  const rl = createFakeReadline("/");

  await controller.syncFromLine(rl.line);
  assert.equal(controller.getState().selectedCommand, "/continue");

  controller.handleKeypress({ name: "tab" }, rl);
  assert.equal(controller.getState().selectedCommand, "/plan current summary");

  controller.handleKeypress({ name: "right" }, rl);
  assert.equal(controller.getState().selectedCommand, "/jobs");

  controller.handleKeypress({ name: "left" }, rl);
  assert.equal(controller.getState().selectedCommand, "/plan current summary");
});
