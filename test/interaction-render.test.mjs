import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentInteractionHistoryReport,
  buildAgentInteractionStatusReport,
  renderAgentAbout,
  renderAgentInteractionHistoryReport,
  renderAgentInteractionStatusReport,
  renderInteractiveCommandPalette,
  renderInteractiveSessionPicker,
} from "../src/lib/agent-interaction-render.mjs";

test("interaction status report summarizes tokens, context, and runtime state", () => {
  const report = buildAgentInteractionStatusReport({
    provider: "mock",
    model: "gpt-5.4",
    streamOutput: true,
    nativeToolCalling: true,
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    networkMode: "docs-only",
    sessionId: "session-1",
    parentSessionId: "root-1",
    usage: {
      calls: 3,
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
    },
    context: {
      model: "gpt-5.4",
      contextWindow: 128000,
      outputReserve: 4000,
      estimatedInputTokens: 3200,
      compactedMessages: 4,
      memoryItems: 2,
      contextSlicingMode: "edit_refactor",
      memoryArbitration: "memory-balanced",
      budgets: {
        totalInputBudget: 9000,
      },
    },
    executionPlan: {
      status: "active",
      failedSteps: [],
      events: [{ kind: "replanned" }, { kind: "progressed" }],
      steps: [
        { status: "completed", type: "inspect", title: "Inspect repo" },
        { status: "in_progress", type: "edit", title: "Patch parser" },
        { status: "pending", type: "verify", title: "Run tests" },
      ],
    },
    lastVerifierRun: {
      summary: {
        status: "passed",
      },
    },
    lastRepairLoop: {
      summary: {
        status: "succeeded",
      },
    },
    runtimeHealth: {
      scorecard: {
        degradedFlags: ["provider_latency_high"],
        provider: { avgHealthScore: 82 },
        circuits: { open: 1 },
      },
    },
  }, {
    lineage: {
      brand: {
        productName: "MJ Code",
        editionName: "xiemingjin edition",
        attributionSummary: "Designed by 谢明锦 / Xie Mingjin",
      },
      createdAt: "2026-04-09T00:00:00.000Z",
      scope: "lineage",
      reference: {
        requestedReference: "current",
        requestedKind: "current",
        resolution: "current",
        resolvedSessionId: "session-1",
        currentSessionId: "session-1",
      },
      available: true,
      changes: [],
      sessions: [],
      lineage: {
        focus: {
          sessionId: "session-1",
          filePath: "/tmp/session-1.jsonl",
          provider: "mock",
          model: "gpt-5.4",
          cwd: "/repo",
          networkMode: "docs-only",
          webProvider: "mock",
          rootSessionId: "root-1",
          parentSessionId: "root-1",
          children: [],
          branchDepth: 1,
          branchType: "resume",
          startedAt: "2026-04-09T00:00:00.000Z",
          lastUpdatedAt: "2026-04-09T00:05:00.000Z",
          resumedAt: null,
          resumedFromSnapshot: null,
          eventCount: 20,
          finalContentPreview: "preview",
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
        rootSessionId: "root-1",
        parentSessionId: "root-1",
        branchDepth: 1,
        ancestors: [],
        children: [],
      },
      replay: null,
      summary: {
        sessionCount: 1,
        changeCount: 0,
        activeSessionId: "session-1",
        recommendedResumeSessionId: "session-2",
        staleSessionCount: 0,
        planAvailableCount: 1,
        verifierAvailableCount: 1,
        decisionAvailableCount: 1,
      },
      suggestedCommands: [],
    },
    recommendation: {
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
        resolvedSessionId: "session-1",
        currentSessionId: "session-1",
      },
      available: true,
      anchorSession: null,
      relatedSessions: [],
      recommendation: {
        status: "recommended",
        reasonKind: "related_recent_session",
        recommendedSessionId: "session-2",
        relationToCurrent: "related",
        relationToReference: "related",
        continuityStatus: "recent",
        summary: "resume session-2",
        blockers: [],
        suggestedCommands: [],
      },
      suggestedCommands: [],
    },
  });

  const rendered = renderAgentInteractionStatusReport(report, "summary");
  assert.match(rendered, /^Status$/m);
  assert.match(rendered, /Now: session=session-1 · continuity=active/);
  assert.match(rendered, /context=5800\/9000/);
  assert.match(rendered, /Work: plan=active step=Patch parser · verifier=passed · runtime=provider=82 circuits=1 flags=provider_latency_high/);
  assert.match(rendered, /Continuity: recommended=session-2 · replay=yes · drilldown=\/why plan current summary/);
  assert.match(rendered, /Mode: mock\/gpt-5.4 · approval=on-write · net=docs-only · tokens=1500/);
  assert.match(rendered, /\/history replay session-1 summary/);
});

test("interaction history report keeps sessions and changes bounded and operator-friendly", () => {
  const report = buildAgentInteractionHistoryReport({
    scope: "all",
    changes: [
      {
        id: "change-1",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "applied",
        origin: "tool_apply",
        toolName: "write_file",
        touchedFiles: ["src/cli-runtime.mts"],
      },
    ],
    sessions: [
      {
        id: "session-1",
        filePath: "/tmp/session-1.jsonl",
        eventCount: 20,
        provider: "mock",
        model: "gpt-5.4",
        cwd: "/repo",
        branchType: "root",
        branchDepth: 0,
        rootSessionId: "session-1",
        children: [],
      },
    ],
  });

  const rendered = renderAgentInteractionHistoryReport(report, "summary");
  assert.match(rendered, /History · all/);
  assert.match(rendered, /Now: latestSession=session-1 latestChange=change-1/);
  assert.match(rendered, /Continue: sessions=1 changes=1/);
  assert.match(rendered, /Sessions:/);
  assert.match(rendered, /Changes:/);
  assert.match(rendered, /Next:/);
  assert.match(rendered, /\/resume session-1/);
  assert.match(rendered, /\/undo change-1/);
});

test("interaction palette and about card surface branded command discovery", () => {
  const palette = renderInteractiveCommandPalette();
  assert.match(palette, /╭─+ Launcher · start/);
  assert.match(palette, /start with \/continue, \/status, or \/history/);
  assert.match(palette, /\/continue/);
  assert.match(palette, /\/status/);
  assert.match(palette, /\/history sessions/);
  assert.match(palette, /default ─/);
  assert.match(palette, /↵ \/continue/);
  assert.match(palette, /open \/continue · \/status · \/help/);
  assert.doesNotMatch(palette, /Core:/);
  assert.doesNotMatch(palette, /Preview:/);

  const about = renderAgentAbout("summary");
  assert.match(about, /谢明锦/);
  assert.match(about, /Xie Mingjin/);
  assert.match(about, /Sun Yat-sen University/);
  assert.match(about, /健康工作/);
});

test("interaction session picker render keeps chooser output bounded and operator-friendly", () => {
  const rendered = renderInteractiveSessionPicker({
    mode: "history_replay",
    title: "Replay Chooser",
    subtitle: "sessions=2 focus=session-1",
    query: null,
    brand: {
      productName: "MJ Code",
      editionName: "xiemingjin edition",
      attributionSummary: "Designed by 谢明锦 / Xie Mingjin",
    },
    sections: [
      {
        title: "Replay Targets",
        entries: [
          {
            id: "replay-1",
            label: "session-1",
            description: "mock/gpt-5.4 · branch=root · depth=0 · resume=not_needed",
            command: "/history replay session-1 summary",
            targetSessionId: "session-1",
            continuityStatus: "active",
            badges: ["active", "plan", "decision"],
            featured: true,
            suggested: true,
            preview: {
              previewKind: "replay_target",
              selectedCommand: "/history replay session-1 summary",
              resolvedCommandTemplate: "/history replay session-1 summary",
              selectedTargetSummary: "session-1 · mock/gpt-5.4 · branch=root depth=0",
              decisionState: "recommended",
              relationSummary: "relation=current/self",
              availabilitySummary: "plan+decision+replay",
              continuitySnippet: "relation=current/self · continuity=active · plan=yes · verifier=no · decision=yes",
              whySelected: "This replay target already has plan/verifier/decision continuity worth inspecting before resuming.",
              nextEffect: "/history replay session-1 summary then /plan timeline replay:session-1 summary is the fastest drill-down path.",
              available: true,
              unavailableReason: null,
            },
          },
        ],
      },
    ],
    totalMatches: 1,
    selectedCommand: "/history replay session-1 summary",
    selectedPreview: {
      previewKind: "replay_target",
      selectedCommand: "/history replay session-1 summary",
      resolvedCommandTemplate: "/history replay session-1 summary",
      selectedTargetSummary: "session-1 · mock/gpt-5.4 · branch=root depth=0",
      decisionState: "recommended",
      relationSummary: "relation=current/self",
      availabilitySummary: "plan+decision+replay",
      continuitySnippet: "relation=current/self · continuity=active · plan=yes · verifier=no · decision=yes",
      whySelected: "This replay target already has plan/verifier/decision continuity worth inspecting before resuming.",
      nextEffect: "/history replay session-1 summary then /plan timeline replay:session-1 summary is the fastest drill-down path.",
      available: true,
      unavailableReason: null,
    },
    fallbackMode: "tty_overlay",
    footerHints: [
      "Use ↑↓ to choose a target, Enter to inject the command template, Esc to close.",
      "Keep typing after the slash command to narrow by session id, model, or continuity.",
    ],
  }, { mode: "overlay" });

  assert.match(rendered, /Replay Chooser/);
  assert.match(rendered, /◆ session-1/);
  assert.match(rendered, /╭─+ Replay Chooser/);
  assert.doesNotMatch(rendered, /Replay Targets:/);
  assert.doesNotMatch(rendered, /Preview:/);
  assert.match(rendered, /↵ \/history replay session-1 summary/);
  assert.match(rendered, /then \/plan time/);
  assert.match(rendered, /selected target ─/);
  assert.match(rendered, /step 1 · target chooser/);
  assert.match(rendered, /pick a target first, then open its session-specific actions/);
  assert.match(rendered, /╰─+ ↑↓ move · ↵ actions · esc close/);
});
