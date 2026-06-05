import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";

import { createTerminalUi } from "../src/lib/ui.mjs";

class CaptureOutput extends Writable {
  constructor() {
    super();
    this.isTTY = false;
    this.chunks = "";
  }

  _write(chunk, _encoding, callback) {
    this.chunks += chunk.toString("utf8");
    callback();
  }
}

function createUi() {
  const input = new PassThrough();
  const output = new CaptureOutput();
  const ui = createTerminalUi({ input, output, useColor: false });
  return { input, output, ui };
}

test("confirmAction renders a compact approval decision panel", async () => {
  const { input, output, ui } = createUi();
  const confirmation = ui.confirmAction({
    toolName: "apply_patch",
    touchedPaths: [
      "/repo/src/lib/ui.mjs",
      "/repo/test/ui-approval-panels.test.mjs",
    ],
    targetDomains: [],
    previewSummary: [
      "update approval panel copy",
      "add compact diff preview coverage",
    ],
    rollbackAvailable: true,
    risk: {
      score: 67,
      level: "medium",
      reasons: ["Touches approval copy.", "Updates test coverage."],
    },
    blockedReason: null,
    network: null,
    mcp: null,
    plugin: null,
  });
  setImmediate(() => {
    input.write("y\n");
  });

  const approved = await confirmation;
  ui.close();

  assert.equal(approved, true);
  assert.match(output.chunks, /Approval · apply_patch/);
  assert.match(output.chunks, /state · review required/);
  assert.match(output.chunks, /risk MEDIUM 67 · rollback yes/);
  assert.match(output.chunks, /paths · .*ui\.mjs · .*ui-approval-panels\.test\.mjs/);
  assert.match(output.chunks, /change preview/);
  assert.match(output.chunks, /y approve · n reject/);
  assert.match(output.chunks, /approve > /);
});

test("printChangePreview renders a compact patch panel with focused diff context", () => {
  const { output, ui } = createUi();

  ui.printChangePreview({
    id: "chg_demo",
    createdAt: "2026-04-27T00:00:00.000Z",
    toolName: "apply_patch",
    dryRun: false,
    input: null,
    touchedFiles: [
      "/repo/src/lib/ui.mjs",
      "/repo/test/ui-approval-panels.test.mjs",
    ],
    operations: { update: 2 },
    files: [
      {
        operation: "update",
        path: "/repo/src/lib/ui.mjs",
        touchedFiles: ["/repo/src/lib/ui.mjs"],
        beforeExists: true,
        afterExists: true,
        beforeBytes: 10,
        afterBytes: 12,
        stats: { added: 8, removed: 2 },
        summary: "update src/lib/ui.mjs (+8 -2)",
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    diff: [
      "@@ -1,3 +1,3 @@",
      "-const oldPanel = true;",
      "+const compactPanel = true;",
    ].join("\n"),
    diffTruncated: false,
    impact: {
      touchedFiles: ["/repo/src/lib/ui.mjs"],
      relatedFiles: ["/repo/src/lib/interactive-shell-panel.mts"],
      likelyTests: ["/repo/test/ui-approval-panels.test.mjs"],
      needsTestRerun: true,
      engine: "mock",
      scannedFiles: 2,
      scanTruncated: false,
      cacheHit: false,
      deadlineHit: false,
      quality: "high",
      cost: {
        engine: "mock",
        scannedFiles: 2,
        scanTruncated: false,
        cacheHit: false,
        deadlineHit: false,
      },
    },
    rollbackAvailable: true,
    checkpointId: null,
    risk: {
      score: 31,
      level: "low",
      reasons: [],
    },
    _internal: {
      cwd: "/repo",
      fileStates: [],
    },
  });
  ui.close();

  assert.match(output.chunks, /Patch Preview · apply_patch/);
  assert.match(output.chunks, /state · staged change-set/);
  assert.match(output.chunks, /impact · related=1 · tests=1 · rerun=yes/);
  assert.match(output.chunks, /focused diff/);
  assert.match(output.chunks, /@@ -1,3 \+1,3 @@/);
  assert.match(output.chunks, /inspect impact and diff before proceeding/);
});

test("printProviderFailure renders a compact diagnostic panel", () => {
  const { output, ui } = createUi();

  ui.printProviderFailure({
    name: "ProviderError",
    message: "Provider network failure: terminated",
    provider: "openai-compatible",
    taxonomy: "provider_retry_exhausted",
    code: "network_error",
    status: null,
    requestType: "tool_completion",
    endpoint: "http://fast.jnm.lol/v1/chat/completions",
    attempt: 2,
    retryable: true,
    circuitState: "closed",
    details: {
      message: "terminated",
    },
    attempts: [
      {
        attempt: 1,
        durationMs: 3120,
        ok: false,
        status: null,
        code: "network_error",
        delayMs: 450,
      },
      {
        attempt: 2,
        durationMs: 2990,
        ok: false,
        status: null,
        code: "network_error",
        delayMs: 0,
      },
    ],
  });
  ui.close();

  assert.match(output.chunks, /Provider Failure/);
  assert.match(output.chunks, /state · request failed/);
  assert.match(output.chunks, /endpoint · fast\.jnm\.lol\/v1\/chat\/completions/);
  assert.match(output.chunks, /attempts/);
  assert.match(output.chunks, /#1 · network · code=network_error · 3120ms · retry\+450ms/);
  assert.match(output.chunks, /check config, endpoint, auth, and provider compatibility/);
});

test("tool call and result output render as compact execution panels", () => {
  const { output, ui } = createUi();

  ui.printToolCall("read_file", {
    path: "README.md",
    startLine: 1,
  });
  ui.printToolResult("read_file", {
    path: "/repo/README.md",
    startLine: 1,
    endLine: 3,
    content: "# Demo\n\nhello",
  });
  ui.close();

  assert.match(output.chunks, /Tool · read_file/);
  assert.match(output.chunks, /state · running/);
  assert.match(output.chunks, /scope · local read/);
  assert.match(output.chunks, /Result · read_file/);
  assert.match(output.chunks, /state · complete/);
  assert.match(output.chunks, /preview/);
  assert.match(output.chunks, /# Demo/);
});
