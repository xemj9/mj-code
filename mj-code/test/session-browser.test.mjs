import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MJCodeAgent } from "../src/agent.mjs";
import {
  renderSessionBrowserReport,
  renderSessionResumeRecommendationReport,
} from "../src/lib/agent-session-browser.mjs";

function createUi() {
  return {
    ask() {
      throw new Error("ask should not be called in this test");
    },
    async confirm() {
      return true;
    },
    async confirmAction() {
      return true;
    },
    close() {},
  };
}

test("session browser keeps empty state and unavailable resume recommendation stable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-session-browser-empty-"));
  const agent = await MJCodeAgent.inspect(
    {
      cwd: root,
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    const report = await agent.browseSessionHistory("sessions", "current");
    assert.equal(report.available, true);
    assert.equal(report.sessions.length, 0);
    const renderedReport = renderSessionBrowserReport(report, "summary");
    assert.match(renderedReport, /History · sessions/);
    assert.match(renderedReport, /Sessions: none yet/);
    assert.match(renderedReport, /Why: no recorded session continuity exists yet/);
    assert.match(renderedReport, /Next: \/status summary/);

    const recommendation = await agent.recommendSessionResume("current");
    assert.equal(recommendation.available, false);
    assert.equal(recommendation.recommendation.reasonKind, "no_sessions");
    const renderedRecommendation = renderSessionResumeRecommendationReport(recommendation, "summary");
    assert.match(renderedRecommendation, /^Resume$/m);
    assert.match(renderedRecommendation, /Guide: target=none · status=unavailable · next=open status/);
    assert.match(renderedRecommendation, /Summary: No recorded session continuity is available yet\./);
  } finally {
    await agent.close();
  }
});

test("session browser marks historical-only sessions and keeps session list bounded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-session-browser-history-"));
  const sessionDir = path.join(root, ".mj-code", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });

  for (let index = 0; index < 8; index += 1) {
    const sessionId = `2026-01-0${index + 1}T00-00-00-000Z-session${index}`;
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
    const startedAt = `2026-01-0${index + 1}T00:00:00.000Z`;
    const finalAt = `2026-01-0${index + 1}T00:05:00.000Z`;
    await fs.writeFile(filePath, [
      JSON.stringify({
        timestamp: startedAt,
        sessionId,
        type: "session_started",
        payload: {
          provider: "mock",
          model: "mock-mj-code-v1",
          cwd: root,
        },
      }),
      JSON.stringify({
        timestamp: finalAt,
        sessionId,
        type: "final",
        payload: {
          content: `Final output ${index}`,
        },
      }),
      "",
    ].join("\n"));
  }

  const agent = await MJCodeAgent.inspect(
    {
      cwd: root,
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    const report = await agent.browseSessionHistory("sessions", "latest");
    assert.equal(report.sessions.length, 6);
    assert.ok(report.sessions.every((entry) => entry.continuityStatus === "historical_only"));
    const renderedReport = renderSessionBrowserReport(report, "summary");
    assert.match(renderedReport, /Guide: open lineage · recommended=.* · paths=6/);
    assert.match(renderedReport, /Sessions: top 3 of 6/);
    assert.match(renderedReport, /backup .* replay first .* older saved path .* replay ready/);
    assert.ok((renderedReport.match(/^- /gm) ?? []).length <= 5);

    const recommendation = await agent.recommendSessionResume("latest");
    assert.ok(["discouraged", "unavailable"].includes(recommendation.recommendation.status));
    assert.ok(["historical_only", "no_resumable_session"].includes(recommendation.recommendation.reasonKind));
  } finally {
    await agent.close();
  }
});
