import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";

import { createTerminalUi } from "../src/lib/ui.mjs";
import { buildInteractiveSessionPickerReport } from "../src/lib/agent-session-browser.mjs";

class FakeTTYInput extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
    this.rawModes = [];
  }

  setRawMode(value) {
    this.rawModes.push(value);
  }
}

class FakeTTYOutput extends Writable {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = 120;
    this.rows = 40;
    this.chunks = "";
  }

  _write(chunk, _encoding, callback) {
    this.chunks += chunk.toString("utf8");
    callback();
  }
}

function createSessionBrowserReport() {
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
      sessionCount: 1,
      changeCount: 0,
      activeSessionId: "session-current",
      recommendedResumeSessionId: "session-branch-1",
      staleSessionCount: 0,
      planAvailableCount: 1,
      verifierAvailableCount: 0,
      decisionAvailableCount: 1,
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
    available: true,
    reference: {
      requestedReference: "current",
      requestedKind: "current",
      resolution: "current",
      resolvedSessionId: "session-current",
      currentSessionId: "session-current",
    },
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
  if (line.startsWith("/continue __actions__ session-branch-1")) {
    const browserReport = createSessionBrowserReport();
    return buildInteractiveSessionPickerReport({
      mode: "continue_actions",
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
  if (line.startsWith("/continue __actions__ session-current")) {
    const browserReport = createSessionBrowserReport();
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
    const browserReport = createSessionBrowserReport();
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
  if (line.startsWith("/history replay __actions__ session-branch-1")) {
    const browserReport = createSessionBrowserReport();
    return buildInteractiveSessionPickerReport({
      mode: "history_replay_actions",
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
    const browserReport = createSessionBrowserReport();
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
  if (!line.startsWith("/resume")) {
    if (line.startsWith("/continue")) {
      return buildInteractiveSessionPickerReport({
        mode: "continue",
        browserReport: createSessionBrowserReport(),
        recommendationReport: createRecommendationReport(),
      });
    }
    if (line.startsWith("/history replay")) {
      return buildInteractiveSessionPickerReport({
        mode: "history_replay",
        browserReport: createSessionBrowserReport(),
        recommendationReport: createRecommendationReport(),
      });
    }
    if (line.startsWith("/history lineage")) {
      return buildInteractiveSessionPickerReport({
        mode: "history_lineage",
        browserReport: createSessionBrowserReport(),
        recommendationReport: createRecommendationReport(),
      });
    }
    return null;
  }
  return buildInteractiveSessionPickerReport({
    mode: "resume",
    browserReport: createSessionBrowserReport(),
    recommendationReport: createRecommendationReport(),
  });
}

async function runInteractivePrompt({
  resolver = null,
  writes,
  timeoutMs = 2000,
}) {
  const input = new FakeTTYInput();
  const output = new FakeTTYOutput();
  const ui = createTerminalUi({ input, output, useColor: false });
  if (resolver) {
    ui.setInteractiveResolver(resolver);
  }
  const promptPromise = ui.ask("xmj> ");
  for (const [delayMs, chunk] of writes) {
    setTimeout(() => {
      input.write(chunk);
    }, delayMs);
  }
  const result = await Promise.race([
    promptPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("interactive prompt timed out")), timeoutMs)),
  ]);
  ui.close();
  return { result, output, input };
}

test("tty harness opens the bare slash overlay once and enters the default continue path", async () => {
  const { result, output, input } = await runInteractivePrompt({
    resolver: async (line) => createPickerReportFromLine(line),
    timeoutMs: 3200,
    writes: [
      [40, "/"],
      [130, "\r"],
      [520, "\r"],
      [980, "\r"],
      [1460, "\r"],
    ],
  });

  assert.equal(result, "/resume session-branch-1");
  assert.equal((output.chunks.match(/Launcher/g) ?? []).length, 1);
  assert.match(output.chunks, /╭─+ Launcher · start/);
  assert.match(output.chunks, /start with \/continue, \/status, or \/history/);
  assert.match(output.chunks, /\/continue/);
  assert.match(output.chunks, /\/history sessions/);
  assert.match(output.chunks, /Continue Browser/);
  assert.match(output.chunks, /Continue Actions/);
  assert.match(output.chunks, /╰─+ filter · ↵ insert · esc close/);
  assert.match(output.chunks, /↵ \/resume session-branch-1/);
  assert.doesNotMatch(output.chunks, /Preview:/);
  assert.doesNotMatch(output.chunks, /MJ Code Command Palette · xiemingjin edition/);
  assert.equal(input.rawModes.includes(true), true);
  assert.equal(input.rawModes.at(-1), false);
});

test("tty harness drives the resume chooser and injects a session-aware command", async () => {
  const { result, output } = await runInteractivePrompt({
    resolver: async (line) => createPickerReportFromLine(line),
    writes: [
      [40, "/resume"],
      [160, "\r"],
      [320, "\r"],
    ],
  });

  assert.equal(result, "/resume session-branch-1");
  assert.match(output.chunks, /Resume Picker/);
  assert.match(output.chunks, /Resume Action Picker/);
  assert.match(output.chunks, /target · session-branch-1/);
  assert.match(output.chunks, /actions ─/);
  assert.doesNotMatch(output.chunks, /Preview:/);
  assert.match(output.chunks, /↵ \/resume session-branch-1/);
  assert.match(output.chunks, /↵ resume, lineage, replay\./);
  assert.match(output.chunks, /runs now/);
  assert.match(output.chunks, /↑↓ move · ↵ primary · esc back/);
});

test("tty harness submits exact direct slash commands on the first enter", async () => {
  const { result, output } = await runInteractivePrompt({
    resolver: async (line) => createPickerReportFromLine(line),
    writes: [
      [40, "/status"],
      [120, "\r"],
    ],
  });

  assert.equal(result, "/status");
  assert.doesNotMatch(output.chunks, /Launcher/);
  assert.doesNotMatch(output.chunks, /Continue Browser/);
  assert.doesNotMatch(output.chunks, /Resume Picker/);
});

test("tty harness replaces a seeded chooser root when a new slash command starts", async () => {
  const { result, output } = await runInteractivePrompt({
    resolver: async (line) => createPickerReportFromLine(line),
    writes: [
      [40, "/"],
      [140, "\r"],
      [320, "/exit"],
      [520, "\r"],
    ],
  });

  assert.equal(result, "/exit");
  assert.match(output.chunks, /Continue Browser/);
  assert.doesNotMatch(output.chunks, /\/continue\/exit/);
  assert.doesNotMatch(output.chunks, /filter \/continue\/exit/);
});

test("tty harness replaces a seeded chooser root when a fresh plain message starts", async () => {
  const { result, output } = await runInteractivePrompt({
    resolver: async (line) => createPickerReportFromLine(line),
    writes: [
      [40, "/"],
      [140, "\r"],
      [320, "hello there"],
      [520, "\r"],
    ],
  });

  assert.equal(result, "hello there");
  assert.match(output.chunks, /Continue Browser/);
  assert.doesNotMatch(output.chunks, /\/continuehello there/);
});

test("tty harness bypasses the chooser when a direct leaf under a chooser root is fully typed", async () => {
  const { result, output } = await runInteractivePrompt({
    resolver: async (line) => createPickerReportFromLine(line),
    writes: [
      [40, "/history replay latest summary"],
      [120, "\r"],
    ],
  });

  assert.equal(result, "/history replay latest summary");
  assert.doesNotMatch(output.chunks, /Replay Chooser/);
  assert.doesNotMatch(output.chunks, /Replay Action Picker/);
});

test("tty harness drives the history replay chooser and injects a replay-aware command", async () => {
  const { result, output } = await runInteractivePrompt({
    resolver: async (line) => createPickerReportFromLine(line),
    writes: [
      [40, "/history replay"],
      [160, "\r"],
      [320, "\r"],
    ],
  });

  assert.equal(result, "/history replay session-branch-1 summary");
  assert.match(output.chunks, /Replay Chooser/);
  assert.match(output.chunks, /Replay Action Picker/);
  assert.match(output.chunks, /Inspect replay continuity and final output|Open replay/);
  assert.match(output.chunks, /↵ \/history replay session-branch-1 summary/);
});

test("tty harness drives the history lineage chooser and injects a lineage-aware command", async () => {
  const { result, output } = await runInteractivePrompt({
    resolver: async (line) => createPickerReportFromLine(line),
    writes: [
      [40, "/history lineage"],
      [160, "\r"],
      [320, "\r"],
    ],
  });

  assert.equal(result, "/history lineage session-branch-1 summary");
  assert.match(output.chunks, /Lineage Picker/);
  assert.match(output.chunks, /Lineage Action Picker/);
  assert.match(output.chunks, /Open lineage|Inspect ancestors and children/);
  assert.match(output.chunks, /↵ \/history lineage session-branch-1 summary/);
});
