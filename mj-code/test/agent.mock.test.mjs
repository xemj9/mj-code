import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MJCodeAgent } from "../src/agent.mjs";
import { MJCodeAgentIntelligenceSurface } from "../src/lib/agent-intelligence-surface.mjs";
import { MJCodeAgentCore as AgentLoopEntry } from "../src/lib/agent-loop.mjs";
import { MJCodeAgentCore as LegacyLoopBase } from "../src/lib/agent-loop-legacy.mjs";
import {
  renderVerifierInspectArtifactList,
  renderVerifierInspectArtifactPruneResult,
  renderVerifierInspectArtifactRecord,
  renderVerifierInspectBaselineRecord,
  renderVerifierInspectCompareReport,
  renderVerifierInspectReport,
  renderVerifierReleaseBundle,
  renderVerifierReleaseHandoff,
  renderVerifierRegressionGatePolicyProfiles,
  renderVerifierRegressionGateDecision,
  renderVerifierInspectSnapshotRecord,
} from "../src/lib/agent-verifier-inspect-render.mjs";
import { MJCodeAgentRuntimeSurface } from "../src/lib/agent-runtime-surface.mjs";
import { createVerifierGitHubActionsBackfillInputFromEnv } from "../src/lib/agent-verifier-release-triage.mjs";
import { ProviderError } from "../src/lib/provider-errors.mjs";

function createUi(options = {}) {
  const confirmResult = options.confirmResult ?? true;
  return {
    ask() {
      throw new Error("ask should not be called in this test");
    },
    async confirm() {
      return confirmResult;
    },
    async confirmAction() {
      return confirmResult;
    },
    close() {},
  };
}

test("agent loop works with the mock provider", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );
  try {
    const result = await agent.runUserInput("What is the current working directory?");
    assert.match(result.content, /current working directory/i);
    assert.match(result.content, /mj-code/);

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /tool_result/);
    assert.match(sessionContents, /mock_tool_call_pwd/);
  } finally {
    await agent.close();
  }
});

test("agent turn engine routes native provider tool calls through the native tool path", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    const toolCalls = [];
    const originalHandleToolExecution = agent.handleToolExecution.bind(agent);
    agent.handleToolExecution = async (payload) => {
      toolCalls.push(payload);
      return originalHandleToolExecution(payload);
    };

    const result = await agent.runUserInput("What is the current working directory?");
    assert.match(result.content, /current working directory/i);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].nativeToolCall, true);
    assert.equal(toolCalls[0].toolCallId, "mock_tool_call_pwd");
    assert.equal(toolCalls[0].toolName, "pwd");

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.phases.some((entry) => entry.phase === "planning"));
    assert.ok(replay.phases.some((entry) => entry.phase === "context_prepare"));
    assert.ok(replay.phases.some((entry) => entry.phase === "model_complete"));
    assert.ok(replay.phases.some((entry) => entry.phase === "finalize"));
  } finally {
    await agent.close();
  }
});

test("agent turn engine falls back to JSON tool_call mode when native tool calling is disabled", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    const toolCalls = [];
    const originalHandleToolExecution = agent.handleToolExecution.bind(agent);
    agent.handleToolExecution = async (payload) => {
      toolCalls.push(payload);
      return originalHandleToolExecution(payload);
    };

    let sawToolSpecs = false;
    agent.provider.complete = async (request) => {
      sawToolSpecs = Array.isArray(request.tools) && request.tools.length > 0;
      const lastMessage = request.messages[request.messages.length - 1];
      if (
        lastMessage?.role === "user" &&
        typeof lastMessage.content === "string" &&
        lastMessage.content.startsWith('Tool result for "pwd"')
      ) {
        return {
          text: JSON.stringify({
            type: "final",
            content: `The current working directory is ${process.cwd()}.`,
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "json-final",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "tool_call",
          tool: "pwd",
          input: {},
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "json-tool",
        },
      };
    };

    const result = await agent.runUserInput("What is the current working directory?");
    assert.match(result.content, /current working directory/i);
    assert.equal(sawToolSpecs, false);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].nativeToolCall, false);
    assert.equal(toolCalls[0].toolCallId, null);
    assert.equal(toolCalls[0].toolName, "pwd");

    const trace = await agent.getTrace("all");
    assert.ok(trace.phases.some((entry) => entry.phase === "model_complete"));
    assert.ok(trace.phases.some((entry) => entry.phase === "finalize"));
  } finally {
    await agent.close();
  }
});

test("agent turn engine retries with JSON tool protocol when native tools are incompatible", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    const toolCalls = [];
    const originalHandleToolExecution = agent.handleToolExecution.bind(agent);
    agent.handleToolExecution = async (payload) => {
      toolCalls.push(payload);
      return originalHandleToolExecution(payload);
    };

    let calls = 0;
    const sawTools = [];
    const sawJsonProtocolPrompt = [];
    agent.provider.complete = async (request) => {
      calls += 1;
      sawTools.push(Array.isArray(request.tools) && request.tools.length > 0);
      sawJsonProtocolPrompt.push(request.systemPrompt.includes("respond with exactly one JSON object"));
      if (calls === 1) {
        throw new ProviderError("Provider network failure: terminated", {
          provider: "mock",
          taxonomy: "provider_retry_exhausted",
          requestType: "tool_completion",
          code: "network_error",
          retryable: true,
          retryExhausted: true,
          details: {
            message: "terminated",
          },
        });
      }

      const lastMessage = request.messages[request.messages.length - 1];
      if (
        lastMessage?.role === "user" &&
        typeof lastMessage.content === "string" &&
        lastMessage.content.startsWith('Tool result for "pwd"')
      ) {
        return {
          text: JSON.stringify({
            type: "final",
            content: `The current working directory is ${process.cwd()}.`,
          }),
          usage: null,
        };
      }

      return {
        text: JSON.stringify({
          type: "tool_call",
          tool: "pwd",
          input: {},
        }),
        usage: null,
      };
    };

    const result = await agent.runUserInput("What is the current working directory?");
    assert.match(result.content, /current working directory/i);
    assert.deepEqual(sawTools, [true, false, false]);
    assert.deepEqual(sawJsonProtocolPrompt, [false, true, true]);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].nativeToolCall, false);
    assert.equal(toolCalls[0].toolName, "pwd");

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /provider_native_tool_protocol_fallback/);
  } finally {
    await agent.close();
  }
});

test("agent prefetches explicitly mentioned local files before the first model call", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-prefetch-"));
  await fs.writeFile(path.join(root, "README.md"), "# Prefetched Project\n\nLocal context.", "utf8");
  const agent = await MJCodeAgent.create(
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
    let sawPrefetch = false;
    agent.provider.complete = async (request) => {
      sawPrefetch = request.messages.some((message) =>
        message.name === "local_context" &&
        typeof message.content === "string" &&
        message.content.includes("# Prefetched Project"));
      return {
        text: "I saw the prefetched README.",
        usage: null,
      };
    };

    const result = await agent.runUserInput("Read README.md and summarize the title.");
    assert.match(result.content, /prefetched README/i);
    assert.equal(sawPrefetch, true);

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /local_context_prefetch/);
  } finally {
    await agent.close();
  }
});

test("agent exposes routing, planning, and explainability metadata", async () => {
  const agent = await MJCodeAgent.inspect(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    const preview = agent.previewRoute("Implement a new CLI flag and update the README.");
    assert.equal(preview.taskClassification.taskClass, "code_edit");
    assert.equal(preview.routeDecision.routingMode, "local-first");
    assert.ok(preview.executionPlan.steps.some((entry) => entry.type === "edit"));

    const explanation = await agent.explainWhy("route");
    assert.equal(explanation.routeDecision, null);

    await agent.prepareIntelligence("Implement a new CLI flag and update the README.");
    const status = agent.getStatus();
    assert.equal(status.taskClassification.taskClass, "code_edit");
    assert.equal(status.routeDecision.routingMode, "local-first");
    assert.ok(status.executionPlan.steps.some((entry) => entry.type === "edit"));

    const why = await agent.explainWhy("model");
    assert.equal(why.modelDecision.chosenProvider, "mock");
    const next = await agent.getNextDecision();
    const recover = await agent.getRecoveryDecision();
    assert.equal(next.available, true);
    assert.ok(next.nextSteps.length > 0);
    assert.equal(recover.available, true);
    assert.ok(recover.recovery.length > 0);
  } finally {
    await agent.close();
  }
});

test("typed surface classes own the drained legacy wrapper layer", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(LegacyLoopBase.prototype, "previewRoute"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(LegacyLoopBase.prototype, "listModels"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(LegacyLoopBase.prototype, "handleToolExecution"),
    false,
  );

  assert.equal(
    Object.prototype.hasOwnProperty.call(MJCodeAgentIntelligenceSurface.prototype, "previewRoute"),
    true,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(MJCodeAgentRuntimeSurface.prototype, "listModels"),
    true,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(MJCodeAgentRuntimeSurface.prototype, "handleToolExecution"),
    true,
  );
  assert.equal(Object.getPrototypeOf(AgentLoopEntry.prototype), MJCodeAgentRuntimeSurface.prototype);
});

test("agent runUserInput still short-circuits empty prompts after typed surface extraction", async () => {
  const agent = await MJCodeAgent.inspect(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    const result = await agent.runUserInput("   ");
    assert.deepEqual(result, {
      content: "",
      steps: 0,
    });
  } finally {
    await agent.close();
  }
});

test("agent post-edit verifier passes and stays visible in status, trace, and replay", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-verifier-pass-"));
  await fs.writeFile(path.join(tempRoot, "config.json"), JSON.stringify({ before: true }, null, 2), "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    let callCount = 0;
    agent.provider.complete = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "config.json",
              content: JSON.stringify({ after: true }, null, 2),
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "verifier-write",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "final",
          content: "Updated config.json.",
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "verifier-final",
        },
      };
    };

    const result = await agent.runUserInput("Update config.json and finalize.");
    assert.equal(result.content, "Updated config.json.");

    const status = agent.getStatus();
    assert.equal(status.lastTrace.success, true);
    assert.equal(status.lastTrace.verifier.status, "passed");
    assert.equal(status.lastVerifierRun.summary.status, "passed");

    const trace = await agent.getTrace("all");
    assert.equal(trace.current.verifier.status, "passed");
    assert.ok(trace.verifierRuns.some((entry) => entry.payload?.summary?.status === "passed"));

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.verifierRuns.some((entry) => entry.run.summary.status === "passed"));
    assert.ok(replay.phases.some((entry) => entry.phase === "verify"));
  } finally {
    await agent.close();
  }
});

test("agent post-edit verifier failure prevents final success", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-verifier-fail-"));
  await fs.writeFile(path.join(tempRoot, "broken.json"), JSON.stringify({ before: true }, null, 2), "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    let callCount = 0;
    agent.provider.complete = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "broken.json",
              content: "{\n",
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "verifier-write-invalid",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "final",
          content: "Updated broken.json.",
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "verifier-final",
        },
      };
    };

    const result = await agent.runUserInput("Break broken.json and finalize.");
    assert.match(result.content, /verification failed/i);

    const status = agent.getStatus();
    assert.equal(status.lastTrace.success, false);
    assert.equal(status.lastTrace.errorTaxonomy, "verifier_failed");
    assert.equal(status.lastVerifierRun.summary.status, "failed");
    assert.equal(status.lastRepairLoop.summary.status, "exhausted");
    assert.equal(status.lastRepairLoop.summary.attemptsUsed, 1);
    assert.equal(status.executionPlan.stopCondition.kind, "repair_exhausted");
    assert.ok(status.executionPlan.events.some((entry) => entry.kind === "replanned" && entry.reasonKind === "verifier_failed"));

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /verifier_run/);
    assert.match(sessionContents, /repair_loop/);

    const trace = await agent.getTrace("all");
    assert.equal(trace.current.repair.status, "exhausted");
    assert.ok(trace.repairLoops.some((entry) => entry.payload?.loop?.summary?.status === "retrying"));
    assert.ok(trace.repairLoops.some((entry) => entry.payload?.loop?.summary?.status === "exhausted"));

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.verifierRuns.some((entry) => entry.run.summary.status === "failed"));
    assert.ok(replay.repairLoops.some((entry) => entry.loop.summary.status === "retrying"));
    assert.ok(replay.repairLoops.some((entry) => entry.loop.summary.status === "exhausted"));
    assert.ok(replay.phases.some((entry) =>
      entry.phase === "verify" && entry.error?.taxonomy === "verifier_failed"));

    const currentPlan = await agent.getPlanCurrent();
    const replayTimeline = await agent.getPlanTimeline(`replay:${agent.sessionId}`);
    const whyVerifier = await agent.explainWhy("verifier");
    const replayWhyPlan = await agent.explainWhy("plan", `replay:${agent.sessionId}`);
    const recover = await agent.getRecoveryDecision();
    assert.equal(currentPlan.summary.status, "failed");
    assert.ok(currentPlan.blockers.some((entry) => entry.kind === "verifier_failed"));
    assert.ok(currentPlan.suggestedCommands.some((entry) => entry.command.includes("verifier trace summary")));
    assert.equal(replayTimeline.latestState.stopCondition.kind, "repair_exhausted");
    assert.match(replayTimeline.leadingProblemEvent.summary, /Repair budget/);
    assert.equal(whyVerifier.leadingProblem?.kind, "repair_exhausted");
    assert.equal(replayWhyPlan.leadingProblem?.kind, "repair_exhausted");
    assert.equal(recover.leadingProblem?.kind, "repair_exhausted");
    assert.equal(recover.recovery[0]?.kind, "repair_exhausted");
  } finally {
    await agent.close();
  }
});

test("agent bounded repair loop retries once and succeeds when the repair fixes the verifier failure", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-repair-success-"));
  await fs.writeFile(path.join(tempRoot, "config.json"), JSON.stringify({ before: true }, null, 2), "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    let callCount = 0;
    agent.provider.complete = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "config.json",
              content: "{\n",
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "repair-invalid-write",
          },
        };
      }
      if (callCount === 2) {
        return {
          text: JSON.stringify({
            type: "final",
            content: "Initial update applied.",
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "repair-first-final",
          },
        };
      }
      if (callCount === 3) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "config.json",
              content: JSON.stringify({ repaired: true }, null, 2),
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "repair-fix-write",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "final",
          content: "Repair completed.",
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "repair-final",
        },
      };
    };

    const result = await agent.runUserInput("Update config.json and keep fixing it until verification passes.");
    assert.equal(result.content, "Repair completed.");

    const status = agent.getStatus();
    assert.equal(status.lastTrace.success, true);
    assert.equal(status.lastVerifierRun.summary.status, "passed");
    assert.equal(status.lastRepairLoop.summary.status, "succeeded");
    assert.equal(status.lastRepairLoop.summary.attemptsUsed, 1);

    const trace = await agent.getTrace("all");
    assert.equal(trace.current.repair.status, "succeeded");
    assert.ok(trace.repairLoops.some((entry) => entry.payload?.loop?.summary?.status === "retrying"));
    assert.ok(trace.repairLoops.some((entry) => entry.payload?.loop?.summary?.status === "succeeded"));

    const verifierCurrent = await agent.getVerifierReport();
    assert.equal(verifierCurrent.scope, "current");
    assert.equal(verifierCurrent.summary.latestVerifierStatus, "passed");
    assert.equal(verifierCurrent.summary.latestRepairStatus, "succeeded");

    const verifierTrace = await agent.getVerifierReport("trace");
    assert.equal(verifierTrace.scope, "trace");
    assert.equal(verifierTrace.summary.failedVerifierRunCount, 1);
    assert.equal(verifierTrace.summary.passedVerifierRunCount, 1);
    assert.equal(verifierTrace.summary.repairLoopCount, 1);
    assert.equal(verifierTrace.summary.repairSucceededCount, 1);

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.repairLoops.some((entry) => entry.loop.summary.status === "retrying"));
    assert.ok(replay.repairLoops.some((entry) => entry.loop.summary.status === "succeeded"));
    assert.ok(replay.verifierRuns.some((entry) => entry.run.summary.status === "failed"));
    assert.ok(replay.verifierRuns.some((entry) => entry.run.summary.status === "passed"));

    const verifierReplay = await agent.inspectVerifierReplay(agent.sessionId);
    assert.equal(verifierReplay.scope, "replay");
    assert.equal(verifierReplay.summary.repairLoopCount, 1);
    assert.equal(verifierReplay.summary.repairSucceededCount, 1);
  } finally {
    await agent.close();
  }
});

test("agent auto-applies an allowlisted verifier code action and re-verifies before final success", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-code-action-apply-"));
  await fs.writeFile(path.join(tempRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(
    path.join(tempRoot, "helper.ts"),
    "export function helper() {\n  return \"ok\";\n}\n",
    "utf8",
  );

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    let callCount = 0;
    agent.provider.complete = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "apply.ts",
              content: "export const data = helper();\n",
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "code-action-apply-write",
          },
        };
      }
      if (callCount === 2) {
        return {
          text: JSON.stringify({
            type: "final",
            content: "Initial update applied.",
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "code-action-apply-first-final",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "final",
          content: "Bounded code action repair completed.",
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "code-action-apply-final",
        },
      };
    };

    const result = await agent.runUserInput("Create apply.ts and let bounded verifier repair finish the turn.");
    assert.equal(result.content, "Bounded code action repair completed.");
    assert.equal(callCount, 3);

    const fileContents = await fs.readFile(path.join(tempRoot, "apply.ts"), "utf8");
    assert.match(fileContents, /import \{ helper \} from ["']\.\/helper(?:\.js)?["'];/);
    assert.match(fileContents, /export const data = helper\(\);/);

    const status = agent.getStatus();
    assert.equal(status.lastTrace.success, true);
    assert.equal(status.lastVerifierRun.summary.status, "passed");
    assert.equal(status.lastRepairLoop.summary.status, "succeeded");
    assert.equal(status.lastRepairLoop.summary.codeActionAppliedCount, 1);
    assert.equal(status.lastRepairLoop.attempts[0].codeAction.status, "applied");
    assert.equal(status.lastRepairLoop.attempts[0].codeAction.toolName, "write_file");
    assert.ok(status.lastRepairLoop.attempts[0].codeAction.changeSetId);
    assert.equal(status.lastRepairLoop.attempts[0].convergence.state, "resolved");
    assert.ok((status.lastRepairLoop.attempts[0].directive?.projectContext.summary.documentSymbolCount ?? 0) > 0);

    const verifierTrace = await agent.getVerifierReport("trace");
    assert.equal(verifierTrace.summary.failedVerifierRunCount, 1);
    assert.equal(verifierTrace.summary.passedVerifierRunCount, 1);
    assert.equal(verifierTrace.summary.codeActionAppliedCount, 1);
    assert.equal(verifierTrace.summary.latestCodeActionStatus, "applied");
    assert.ok(verifierTrace.summary.projectContextCount > 0);
    assert.ok(verifierTrace.summary.projectContextDocumentSymbolCount > 0);

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.changes.filter((entry) => entry.type === "change_preview").length >= 2);
    assert.ok(replay.changes.filter((entry) => entry.type === "change_applied").length >= 2);
    assert.ok(replay.repairLoops.some((entry) => entry.loop.summary.status === "retrying"));
    assert.ok(replay.repairLoops.some((entry) => entry.loop.summary.status === "succeeded"));
    assert.ok(replay.verifierRuns.some((entry) => entry.run.summary.status === "failed"));
    assert.ok(replay.verifierRuns.some((entry) => entry.run.summary.status === "passed"));
    assert.ok(replay.repairLoops.some((entry) =>
      (entry.loop.attempts[0]?.directive?.projectContext.summary.documentSymbolCount ?? 0) > 0
    ));

    const verifierReplay = await agent.inspectVerifierReplay(agent.sessionId);
    assert.equal(verifierReplay.summary.codeActionAppliedCount, 1);
    assert.equal(verifierReplay.summary.finalOutcome, "success");
    assert.ok(verifierReplay.summary.projectContextCount > 0);
    assert.ok(verifierReplay.summary.projectContextDocumentSymbolCount > 0);

    const exportedReplay = await agent.exportVerifierReport({
      kind: "replay",
      reference: agent.sessionId,
    });
    assert.equal(exportedReplay.metadata.source.kind, "replay");
    assert.equal(exportedReplay.metadata.source.replayReference, agent.sessionId);
    assert.equal(exportedReplay.metadata.summary.finalOutcome, "success");

    const snapshotList = await agent.listVerifierSnapshots();
    assert.ok(snapshotList.items.some((entry) => entry.snapshotId === exportedReplay.metadata.snapshotId));

    const policyProfiles = await agent.listVerifierGatePolicyProfiles();
    assert.deepEqual(policyProfiles.items.map((entry) => entry.id), ["default", "strict", "release"]);

    const pinnedBaseline = await agent.pinVerifierBaseline(
      { kind: "snapshot", reference: exportedReplay.metadata.snapshotId },
      "live-success",
      { policyProfileId: "release" },
    );
    assert.equal(pinnedBaseline.metadata.name, "live-success");
    assert.equal(pinnedBaseline.metadata.snapshotId, exportedReplay.metadata.snapshotId);
    assert.equal(pinnedBaseline.metadata.policyProfileId, "release");

    const baselineList = await agent.listVerifierBaselines();
    assert.ok(baselineList.items.some((entry) => entry.name === "live-success"));

    const promotedSnapshot = await agent.exportVerifierReport({
      kind: "replay",
      reference: agent.sessionId,
    });
    const promotedBaseline = await agent.pinVerifierBaseline(
      { kind: "snapshot", reference: promotedSnapshot.metadata.snapshotId },
      "live-success",
      { policyProfileId: "strict" },
    );
    assert.equal(promotedBaseline.metadata.snapshotId, promotedSnapshot.metadata.snapshotId);
    assert.equal(promotedBaseline.metadata.policyProfileId, "strict");
    assert.equal(promotedBaseline.metadata.promotionCount, 1);
    assert.equal(promotedBaseline.history.length, 1);
    assert.equal(promotedBaseline.history[0].previousSnapshotId, exportedReplay.metadata.snapshotId);
    assert.equal(promotedBaseline.history[0].nextSnapshotId, promotedSnapshot.metadata.snapshotId);

    const continuityCompare = await agent.compareVerifierReports(
      { kind: "baseline", reference: "live-success" },
      { kind: "replay", reference: agent.sessionId },
      { writeArtifact: true },
    );
    assert.equal(continuityCompare.summary.hasChanges, false);
    assert.equal(continuityCompare.summary.codeActionApplied.delta, 0);
    assert.equal(continuityCompare.summary.projectContextDocumentSymbols.delta, 0);
    assert.equal(continuityCompare.summary.blockingDiagnostics.beforeCount, 0);
    assert.equal(continuityCompare.summary.blockingDiagnostics.afterCount, 0);
    assert.ok(continuityCompare.artifact?.artifactId);

    const continuityGate = await agent.gateVerifierReports(
      { kind: "baseline", reference: "live-success" },
      { kind: "replay", reference: agent.sessionId },
      undefined,
      { writeArtifact: true },
    );
    assert.equal(continuityGate.pass, true);
    assert.equal(continuityGate.failureCount, 0);
    assert.equal(continuityGate.profile.id, "strict");
    assert.ok(continuityGate.artifact?.artifactId);

    const artifactList = await agent.listVerifierArtifacts();
    assert.ok(artifactList.items.some((entry) => entry.artifactId === continuityCompare.artifact?.artifactId));
    assert.ok(artifactList.items.some((entry) => entry.artifactId === continuityGate.artifact?.artifactId));

    const inspectedGateArtifact = await agent.inspectVerifierArtifact(continuityGate.artifact.artifactId.slice(0, 12));
    assert.equal(inspectedGateArtifact.metadata.artifactId, continuityGate.artifact.artifactId);
    assert.equal(inspectedGateArtifact.metadata.kind, "gate");

    const exportRender = renderVerifierInspectSnapshotRecord(exportedReplay, { profile: "summary" });
    assert.match(exportRender, /^Verifier Export/m);
    assert.match(exportRender, new RegExp(exportedReplay.metadata.snapshotId));

    const baselineRender = renderVerifierInspectBaselineRecord(promotedBaseline, { profile: "summary" });
    assert.match(baselineRender, /^Verifier Baseline/m);
    assert.match(baselineRender, /name: live-success/);
    assert.match(baselineRender, /promotions: 1;/);

    const compareRender = renderVerifierInspectCompareReport(continuityCompare, { profile: "summary" });
    assert.match(compareRender, /^Verifier Compare/m);
    assert.match(compareRender, /no continuity deltas detected\./);
    assert.match(compareRender, /artifact:/);

    const gateRender = renderVerifierRegressionGateDecision(continuityGate, { profile: "summary" });
    assert.match(gateRender, /^Verifier Gate/m);
    assert.match(gateRender, /status: pass/);
    assert.match(gateRender, /policy profile: strict/);
    assert.match(gateRender, /artifact:/);
    assert.match(renderVerifierRegressionGatePolicyProfiles(policyProfiles, { profile: "summary" }), /^Verifier Gate Policies/m);
    assert.match(renderVerifierInspectArtifactList(artifactList, { profile: "summary" }), /^Verifier Artifacts/m);
    assert.match(renderVerifierInspectArtifactRecord(inspectedGateArtifact, { profile: "summary" }), /^Verifier Artifact/m);

    const evalResult = agent.runEval({
      suite: "verification",
      baselineGate: continuityGate,
    });
    assert.ok(evalResult.baselineGate);
    assert.equal(evalResult.baselineGate.pass, true);
    const evalArtifact = await agent.writeVerifierEvalArtifact(evalResult);
    assert.equal(evalArtifact.metadata.kind, "eval");
    assert.equal(evalArtifact.result.baselinePolicyProfile?.id, "strict");
    assert.ok(evalArtifact.metadata.artifactId);

    const evalHandoff = await agent.inspectVerifierHandoff(evalArtifact.metadata.artifactId);
    assert.equal(evalHandoff.available, true);
    assert.equal(evalHandoff.handoff?.metadata.primaryArtifactId, evalArtifact.metadata.artifactId);
    assert.equal(evalHandoff.latestGateArtifactId, continuityGate.artifact.artifactId);
    assert.equal(evalHandoff.latestEvalArtifactId, evalArtifact.metadata.artifactId);
    assert.match(renderVerifierReleaseHandoff(evalHandoff, { profile: "summary" }), /^Verifier Release Handoff/m);

    const evalBundle = await agent.exportVerifierBundle(evalArtifact.metadata.artifactId);
    assert.equal(evalBundle.metadata.primaryArtifactId, evalArtifact.metadata.artifactId);
    assert.ok(evalBundle.files.some((entry) => entry.role === "summary"));
    assert.match(renderVerifierReleaseBundle(evalBundle, { profile: "summary" }), /^Verifier Bundle/m);

    const blockedPromotionPlan = await agent.planVerifierBaselinePromotion(
      "live-success",
      continuityCompare.artifact.artifactId,
    );
    assert.equal(blockedPromotionPlan.decision.status, "blocked");
    assert.equal(blockedPromotionPlan.approvalStatus, "blocked");
    assert.ok(blockedPromotionPlan.decision.reasons.some((entry) => entry.kind === "source_unsupported"));

    const releaseCandidate = await agent.pinVerifierBaseline(
      { kind: "snapshot", reference: exportedReplay.metadata.snapshotId },
      "release-candidate",
      { policyProfileId: "default" },
    );
    assert.equal(releaseCandidate.metadata.name, "release-candidate");
    assert.equal(releaseCandidate.metadata.policyProfileId, "default");

    const eligiblePromotionPlan = await agent.planVerifierBaselinePromotion(
      "release-candidate",
      evalArtifact.metadata.artifactId,
      { policyProfileId: "release" },
    );
    assert.equal(eligiblePromotionPlan.candidate.source.sourceKind, "eval");
    assert.equal(eligiblePromotionPlan.decision.status, "eligible");
    assert.equal(eligiblePromotionPlan.approvalStatus, "pending");
    assert.equal(eligiblePromotionPlan.candidate.policyProfileId, "release");

    const appliedPromotionPlan = await agent.approveVerifierBaselinePromotion(
      eligiblePromotionPlan.planId,
      { approverKind: "automation", approverId: "mock-ci" },
    );
    assert.equal(appliedPromotionPlan.approvalStatus, "applied");
    assert.equal(appliedPromotionPlan.approval?.approverKind, "automation");
    assert.equal(appliedPromotionPlan.approval?.approverId, "mock-ci");
    assert.ok(appliedPromotionPlan.appliedPromotionId);
    assert.ok(appliedPromotionPlan.handoffId);

    const promotionHistory = await agent.listVerifierBaselinePromotionHistory("release-candidate");
    assert.equal(promotionHistory.total, 1);
    assert.equal(promotionHistory.items[0].promotionId, appliedPromotionPlan.appliedPromotionId);
    assert.equal(promotionHistory.items[0].candidate?.source.sourceKind, "eval");

    const githubActionsBackfill = createVerifierGitHubActionsBackfillInputFromEnv({
      GITHUB_RUN_ID: "501",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW: "verifier-release-gate",
      GITHUB_JOB: "verifier-release-gate",
      GITHUB_SHA: "abc123def456",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "demo/mj-code",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_ACTOR: "mock-ci",
      MJ_VERIFIER_UPLOAD_NAME: "verifier-release-501",
      MJ_VERIFIER_UPLOAD_ARTIFACT_ID: "artifact-777",
      MJ_VERIFIER_UPLOAD_ARTIFACT_URL: "https://github.com/demo/mj-code/actions/runs/501/artifacts/777",
      MJ_VERIFIER_UPLOAD_ARTIFACT_DIGEST: "sha256:998877",
      MJ_VERIFIER_UPLOAD_RETENTION_DAYS: "14",
    });
    assert.ok(githubActionsBackfill);

    const triage = await agent.summarizeVerifierReleaseTriage(
      evalArtifact.metadata.artifactId,
      { githubActionsBackfill },
    );
    assert.equal(triage.available, true);
    assert.equal(triage.sourceKind, "eval");
    assert.equal(triage.policyProfileId, "strict");
    assert.equal(triage.baselineName, "live-success");
    assert.equal(triage.bundleId, evalBundle.metadata.bundleId);
    assert.equal(triage.workflow?.runId, "501");
    assert.equal(triage.upload?.artifactId, "artifact-777");
    assert.equal(triage.promotionStatus, "eligible");

    const checksPayload = await agent.exportVerifierGitHubChecksPayload(
      evalArtifact.metadata.artifactId,
      {
        githubActionsBackfill,
        name: "mock-release-gate",
      },
    );
    assert.equal(checksPayload.available, true);
    assert.equal(checksPayload.name, "mock-release-gate");
    assert.equal(checksPayload.conclusion, "success");
    assert.equal(checksPayload.policyProfileId, "strict");
    assert.equal(checksPayload.bundleId, evalBundle.metadata.bundleId);
    assert.equal(checksPayload.workflow?.workflow, "verifier-release-gate");
    assert.equal(checksPayload.upload?.artifactDigest, "sha256:998877");
    assert.equal(checksPayload.annotationTotal, 0);

    const prunePreview = await agent.pruneVerifierArtifacts({
      dryRun: true,
      maxArtifactCount: 1,
    });
    assert.ok(prunePreview.deleted.some((entry) => entry.kind === "artifact"));
    assert.match(renderVerifierInspectArtifactPruneResult(prunePreview, { profile: "summary" }), /^Verifier Artifact Prune/m);
  } finally {
    await agent.close();
  }
});

test("agent repair replay and inspect keep richer project context continuity for manual verifier fixes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-project-context-repair-"));
  await fs.writeFile(path.join(tempRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
    },
    include: ["*.ts"],
  }, null, 2), "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    let callCount = 0;
    agent.provider.complete = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "context.ts",
              content: [
                "export interface Worker {",
                "  run(): string;",
                "}",
                "",
                "export class RealWorker implements Worker {",
                "  run(): number {",
                "    return 1;",
                "  }",
                "}",
                "",
                "export const worker = new RealWorker();",
                "",
              ].join("\n"),
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "project-context-write",
          },
        };
      }
      if (callCount === 2) {
        return {
          text: JSON.stringify({
            type: "final",
            content: "Initial project context file written.",
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "project-context-first-final",
          },
        };
      }
      if (callCount === 3) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "context.ts",
              content: [
                "export interface Worker {",
                "  run(): string;",
                "}",
                "",
                "export class RealWorker implements Worker {",
                "  run(): string {",
                "    return \"ok\";",
                "  }",
                "}",
                "",
                "export const worker = new RealWorker();",
                "",
              ].join("\n"),
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "project-context-repair-write",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "final",
          content: "Manual project-context repair completed.",
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "project-context-final",
        },
      };
    };

    const result = await agent.runUserInput("Create context.ts, let verifier fail, then repair it.");
    assert.equal(result.content, "Manual project-context repair completed.");
    assert.equal(callCount, 4);

    const status = agent.getStatus();
    assert.equal(status.lastTrace.success, true);
    assert.equal(status.lastVerifierRun.summary.status, "passed");
    assert.equal(status.lastRepairLoop.summary.status, "succeeded");
    assert.ok((status.lastRepairLoop.attempts[0].directive?.projectContext.summary.implementationCount ?? 0) > 0);
    assert.ok((status.lastRepairLoop.attempts[0].directive?.projectContext.summary.documentSymbolCount ?? 0) > 0);
    const richerContextItem = status.lastRepairLoop.attempts[0].directive?.items.find(
      (item) =>
        (item.projectContext?.implementations.length ?? 0) > 0
        && (item.projectContext?.documentSymbols.length ?? 0) > 0,
    );
    assert.ok(richerContextItem);
    assert.equal(typeof richerContextItem.projectContext?.enclosingSymbol?.name, "string");

    const verifierTrace = await agent.getVerifierReport("trace");
    assert.equal(verifierTrace.summary.failedVerifierRunCount, 1);
    assert.equal(verifierTrace.summary.passedVerifierRunCount, 1);
    assert.ok(verifierTrace.summary.projectContextImplementationCount > 0);
    assert.ok(verifierTrace.summary.projectContextDocumentSymbolCount > 0);

    const replay = await agent.replaySession(agent.sessionId);
    const retryingRepair = replay.repairLoops.find((entry) => entry.loop.summary.status === "retrying");
    assert.ok(retryingRepair);
    assert.ok((retryingRepair.loop.attempts[0]?.directive?.projectContext.summary.implementationCount ?? 0) > 0);
    assert.ok((retryingRepair.loop.attempts[0]?.directive?.projectContext.summary.documentSymbolCount ?? 0) > 0);

    const verifierReplay = await agent.inspectVerifierReplay(agent.sessionId);
    assert.equal(verifierReplay.summary.finalOutcome, "success");
    assert.ok(verifierReplay.summary.projectContextImplementationCount > 0);
    assert.ok(verifierReplay.summary.projectContextDocumentSymbolCount > 0);

    const summaryRender = renderVerifierInspectReport(verifierReplay, { profile: "summary" }).split("\n");
    assert.deepEqual(summaryRender.slice(0, 5), [
      "Verifier Summary",
      "scope: replay",
      `session: ${agent.sessionId}`,
      verifierReplay.traceId ? `trace: ${verifierReplay.traceId}` : "trace: none",
      "final outcome: success",
    ]);
    assert.ok(summaryRender.some((line) => line.includes("latest repair: succeeded (resolved)")));
    assert.ok(summaryRender.some((line) => line.includes("assist totals:")));

    const contextRender = renderVerifierInspectReport(verifierReplay, { profile: "context" }).split("\n");
    assert.equal(contextRender[0], "Verifier Context");
    assert.ok(contextRender.some((line) => line.includes("context totals: items")));
    assert.ok(contextRender.some((line) => line.includes("top context groups:")));
    assert.ok(contextRender.some((line) => line.includes("latest blocking diagnostics with context:")));
  } finally {
    await agent.close();
  }
});

test("agent post-edit diagnostics pass keeps final success for TypeScript edits", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-diagnostics-pass-"));

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    let callCount = 0;
    agent.provider.complete = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "typed.ts",
              content: "export const typed: string = \"ok\";\n",
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "diagnostics-pass-write",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "final",
          content: "Updated typed.ts.",
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "diagnostics-pass-final",
        },
      };
    };

    const result = await agent.runUserInput("Create typed.ts and finalize.");
    assert.equal(result.content, "Updated typed.ts.");

    const status = agent.getStatus();
    assert.equal(status.lastTrace.success, true);
    assert.equal(status.lastVerifierRun.summary.status, "passed");
    assert.equal(status.lastVerifierRun.summary.diagnosticProviderAvailable, true);
    assert.equal(status.lastVerifierRun.summary.diagnosticErrorCount, 0);
    assert.ok(status.lastVerifierRun.checks.some((check) =>
      check.kind === "diagnostics" && check.status === "passed"
    ));

    const trace = await agent.getTrace("all");
    assert.equal(trace.current.verifier.status, "passed");
    assert.equal(trace.current.verifier.diagnosticProviderAvailable, true);

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.verifierRuns.some((entry) =>
      entry.run.checks.some((check) => check.kind === "diagnostics" && check.status === "passed")
    ));
  } finally {
    await agent.close();
  }
});

test("agent post-edit diagnostics failure prevents final success for TypeScript edits", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-diagnostics-fail-"));

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    let callCount = 0;
    agent.provider.complete = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: JSON.stringify({
            type: "tool_call",
            tool: "write_file",
            input: {
              path: "broken.ts",
              content: "export const broken: string = 1;\n",
            },
          }),
          usage: null,
          meta: {
            provider: "mock",
            mode: "diagnostics-fail-write",
          },
        };
      }

      return {
        text: JSON.stringify({
          type: "final",
          content: "Updated broken.ts.",
        }),
        usage: null,
        meta: {
          provider: "mock",
          mode: "diagnostics-fail-final",
        },
      };
    };

    const result = await agent.runUserInput("Break broken.ts semantically and finalize.");
    assert.match(result.content, /verification failed/i);

    const status = agent.getStatus();
    assert.equal(status.lastTrace.success, false);
    assert.equal(status.lastTrace.errorTaxonomy, "verifier_failed");
    assert.equal(status.lastVerifierRun.summary.status, "failed");
    assert.equal(status.lastVerifierRun.summary.diagnosticProviderAvailable, true);
    assert.ok((status.lastVerifierRun.summary.diagnosticErrorCount ?? 0) > 0);
    assert.equal(status.lastRepairLoop.summary.status, "exhausted");
    assert.ok(status.lastVerifierRun.checks.some((check) =>
      check.kind === "diagnostics" && check.status === "failed"
    ));

    const trace = await agent.getTrace("all");
    assert.equal(trace.current.verifier.status, "failed");
    assert.ok((trace.current.verifier.diagnosticErrorCount ?? 0) > 0);
    assert.equal(trace.current.repair.status, "exhausted");

    const verifierCurrent = await agent.getVerifierReport();
    assert.equal(verifierCurrent.summary.latestVerifierStatus, "failed");
    assert.equal(verifierCurrent.summary.latestRepairStatus, "exhausted");

    const verifierReplay = await agent.inspectVerifierReplay(agent.sessionId);
    assert.equal(verifierReplay.summary.repairLoopCount, 1);
    assert.equal(verifierReplay.summary.repairExhaustedCount, 1);

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.verifierRuns.some((entry) =>
      entry.run.checks.some((check) => check.kind === "diagnostics" && check.status === "failed")
    ));
    assert.ok(replay.repairLoops.some((entry) => entry.loop.summary.status === "exhausted"));
    assert.ok(replay.phases.some((entry) =>
      entry.phase === "verify" && entry.error?.taxonomy === "verifier_failed"
    ));
  } finally {
    await agent.close();
  }
});

test("agent create initializes session, journal, and bootstrap snapshot through the typed entry", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    assert.ok(agent.sessionId);
    assert.ok(agent.sessionFilePath);

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /session_started/);
    assert.match(sessionContents, /memory_initialized/);

    const journalEntries = await agent.executionJournal.readEntries(agent.sessionId);
    assert.ok(journalEntries.some((entry) => entry.type === "journal_started"));

    const snapshot = await agent.executionJournal.loadLatestSnapshot(agent.sessionId);
    assert.ok(snapshot?.filePath);
    assert.equal(snapshot?.state?.sessionId, agent.sessionId);
    assert.ok(snapshot?.state?.runtimeContinuity);
  } finally {
    await agent.close();
  }
});

test("agent inspect initializes runtime bootstrap surfaces without opening a session", async () => {
  const agent = await MJCodeAgent.inspect(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    const models = await agent.listModels();
    assert.ok(models.includes("mock-mj-code-v1"));

    assert.equal(agent.sessionFilePath, null);
    assert.equal(agent.sessionId, null);
    assert.match(agent.memoryStore.sessionMemoryPath ?? "", /_inspect\.json$/);

    const status = agent.getStatus();
    assert.equal(status.sessionId, null);
    assert.equal(status.parentSessionId, null);
    assert.ok(status.runtimeHealth.scorecard);

    const usage = agent.getUsageSummary();
    assert.ok(usage.runtimeHealth.scorecard);

    const trace = await agent.getTrace("all");
    assert.equal(trace.current, null);
    assert.ok(Array.isArray(trace.phases));
    assert.ok(Array.isArray(trace.providerEvents));
  } finally {
    await agent.close();
  }
});

test("agent instruction hierarchy feeds prompt assembly, status, context meta, and replay continuity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-instructions-"));
  const userStateDir = path.join(root, ".user-state");
  await fs.mkdir(userStateDir, { recursive: true });
  await fs.mkdir(path.join(root, ".mj-code"), { recursive: true });
  await fs.mkdir(path.join(root, "instructions"), { recursive: true });

  await fs.writeFile(path.join(userStateDir, "MJ.md"), "Global instruction.\n", "utf8");
  await fs.writeFile(
    path.join(root, "MJ.md"),
    [
      "@import ./instructions/shared.md",
      "@rule output.style: terse",
      "",
      "Workspace instruction.",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(root, "instructions", "shared.md"), "Imported workspace note.\n", "utf8");
  await fs.writeFile(path.join(root, ".mj-code", "MJ.md"), "Overlay instruction.\n", "utf8");
  await fs.writeFile(path.join(root, ".mj-code", "MJ.local.md"), "Local override instruction.\n", "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: root,
      overrides: {
        userStateDir,
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    let capturedBaseSystemPrompt = "";
    const originalPrepare = agent.contextManager.prepare.bind(agent.contextManager);
    agent.contextManager.prepare = async (input) => {
      capturedBaseSystemPrompt = input.baseSystemPrompt;
      return originalPrepare(input);
    };

    agent.provider.complete = async () => ({
      text: JSON.stringify({
        type: "final",
        content: "instruction check complete",
      }),
      usage: null,
      meta: {
        provider: "mock",
        mode: "instruction-check",
      },
    });

    const result = await agent.runUserInput("Explain the loaded instruction hierarchy.");
    assert.equal(result.content, "instruction check complete");
    assert.match(capturedBaseSystemPrompt, /Global instruction/);
    assert.match(capturedBaseSystemPrompt, /Imported workspace note/);
    assert.match(capturedBaseSystemPrompt, /Workspace instruction/);
    assert.match(capturedBaseSystemPrompt, /Overlay instruction/);
    assert.match(capturedBaseSystemPrompt, /Local override instruction/);
    assert.match(capturedBaseSystemPrompt, /Rules:\n- output\.style: terse/);

    const status = agent.getStatus();
    assert.equal(status.instructions.entryCount, 5);
    assert.deepEqual(status.context.instructionLayers, [
      "user-global",
      "workspace-root",
      "project-overlay",
      "local-override",
    ]);
    assert.equal(status.context.instructionRuleIds.length, 1);
    assert.deepEqual(status.context.instructionSummary, {
      entryCount: 5,
      ruleCount: 1,
      layers: [
        "user-global",
        "workspace-root",
        "project-overlay",
        "local-override",
      ],
      files: status.context.instructionFiles,
    });
    assert.ok(status.instructions.entries.some((entry) =>
      entry.layer === "local-override" && entry.originPath.endsWith(path.join(".mj-code", "MJ.local.md"))));

    const usage = agent.getUsageSummary();
    assert.equal(usage.instructions.entryCount, 5);
    assert.equal(usage.lastContextPlan.instructionSummary.entryCount, 5);

    const trace = await agent.getTrace("all");
    assert.equal(trace.instructions.entryCount, 5);
    assert.ok(trace.policy.sources.length > 0);
    assert.ok(trace.phases.some((entry) => entry.phase === "context_prepare"));

    const replay = await agent.replaySession(agent.sessionId);
    assert.equal(replay.runtimeContinuity.instructions.entryCount, 5);
  } finally {
    await agent.close();
  }
});

test("agent turn engine finalizes provider failures and keeps model_complete error phases replayable", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    agent.provider = {
      capabilities: {
        nativeToolCalling: true,
      },
      async complete() {
        throw new ProviderError("provider timed out", {
          provider: "mock",
          taxonomy: "provider_timeout",
          requestType: "tool_calling_completion",
          retryable: true,
        });
      },
    };

    const result = await agent.runUserInput("Summarize the repository.");
    assert.match(result.content, /provider request failed/i);
    assert.equal(agent.getStatus().lastTrace.errorTaxonomy, "provider_timeout");
    assert.equal(agent.getStatus().executionPlan.stopCondition.kind, "provider_failed");
    assert.equal(agent.getStatus().executionPlan.currentStep, null);

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /provider_timeout/);

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.phases.some((entry) =>
      entry.phase === "model_complete" && entry.error?.taxonomy === "provider_timeout"));

    const planCurrent = await agent.getPlanCurrent();
    const whyModel = await agent.explainWhy("model");
    const recover = await agent.getRecoveryDecision();
    assert.ok(planCurrent.blockers.some((entry) => entry.kind === "provider_retry_exhausted"));
    assert.ok(planCurrent.suggestedCommands.some((entry) => entry.command.includes("runtime circuits")));
    assert.equal(whyModel.leadingProblem?.kind, "provider_retry_exhausted");
    assert.ok(whyModel.degradedLayers.some((entry) => entry.layer === "provider"));
    assert.equal(recover.recovery[0]?.kind, "provider_retry_exhausted");
  } finally {
    await agent.close();
  }
});

test("decision surface records permission-denied continuity and bounded recovery guidance", async () => {
  const agent = await MJCodeAgent.inspect(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    const turnState = agent.startTrace("Write outside the workspace.");
    await agent.prepareIntelligence("Write a file outside the workspace root.", turnState.traceId);

    const result = await agent.handleToolExecution({
      toolName: "write_file",
      input: {
        path: path.join(os.tmpdir(), "mj-code-outside-workspace.txt"),
        content: "blocked",
      },
      toolCallId: null,
      turnState,
      step: 1,
      nativeToolCall: false,
    });

    assert.equal(result.ok, false);
    const whyTool = await agent.explainWhy("tool");
    const recover = await agent.getRecoveryDecision();
    assert.equal(whyTool.leadingProblem?.kind, "permission_denied");
    assert.equal(whyTool.toolContext?.latestBoundaryDecision?.blocked, true);
    assert.equal(recover.leadingProblem?.kind, "permission_denied");
    assert.equal(recover.recovery[0]?.kind, "permission_denied");
    assert.ok(recover.recovery[0]?.commands.some((entry) => entry.command.includes("why tool")));
  } finally {
    await agent.close();
  }
});

test("agent falls back to the next routed model when the preferred model exhausts retries", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  try {
    agent.config.model = "gpt-5.4";
    agent.config.availableModels = ["gpt-5.4", "gpt-5-mini"];
    agent.provider = {
      capabilities: {
        nativeToolCalling: true,
      },
      async complete({ model }) {
        if (model === "gpt-5.4") {
          throw new ProviderError("preferred model exhausted", {
            provider: "mock",
            taxonomy: "provider_retry_exhausted",
            requestType: "completion_non_stream",
            retryable: true,
            retryExhausted: true,
          });
        }
        return {
          text: `Recovered with ${model}.`,
          usage: null,
        };
      },
    };

    const result = await agent.runUserInput("Implement a new CLI flag and update the README.");
    assert.match(result.content, /Recovered with gpt-5-mini/);
    assert.equal(agent.getModelDecision().selectedModel, "gpt-5-mini");
    assert.equal(agent.getModelDecision().fallbackChainUsed, true);
    assert.equal(agent.getUsageSummary().providerRuntime.modelFallbacks, 1);
  } finally {
    await agent.close();
  }
});

test("agent turn engine stops cleanly at maxSteps and keeps trace continuity", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
        maxSteps: 1,
      },
    },
    createUi(),
  );

  try {
    agent.nativeToolCalling = false;
    agent.refreshSystemPrompt();

    const result = await agent.runUserInput("What is the current working directory?");
    assert.match(result.content, /stopped after 1 steps without reaching a final answer/i);
    assert.equal(agent.getStatus().lastTrace.stopped, true);

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.phases.some((entry) => entry.phase === "planning"));
    assert.ok(replay.phases.some((entry) => entry.phase === "context_prepare"));
    assert.ok(replay.phases.some((entry) => entry.phase === "model_complete"));
    assert.ok(replay.phases.some((entry) => entry.phase === "finalize"));
  } finally {
    await agent.close();
  }
});

test("agent can resume a prior session from the execution journal snapshot", async () => {
  const agent = await MJCodeAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  await agent.runUserInput("What is the current working directory?");
  const parentSessionId = agent.sessionId;

  const resumed = await MJCodeAgent.resume(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
    parentSessionId,
  );
  try {
    assert.notEqual(resumed.sessionId, parentSessionId);
    assert.equal(resumed.parentSessionId, parentSessionId);
    assert.ok(resumed.messages.length > 0);
    const resumedStatus = resumed.getStatus();
    assert.ok(resumedStatus.lastTrace);
    assert.ok(resumedStatus.inheritedRuntimeContinuity);
    assert.equal(
      resumedStatus.inheritedRuntimeContinuity.instructions.entryCount,
      resumedStatus.instructions.entryCount,
    );

    const sessions = await resumed.listSessions();
    const childSession = sessions.find((entry) => entry.id === resumed.sessionId);
    assert.equal(childSession.parentSessionId, parentSessionId);
    assert.equal(childSession.branchDepth, 1);

    const resumedContents = await fs.readFile(resumed.sessionFilePath, "utf8");
    assert.match(resumedContents, /session_resumed/);
    assert.match(resumedContents, /resume_state_loaded/);

    const replay = await resumed.replaySession(resumed.sessionId);
    assert.equal(replay.lineage.parentSessionId, parentSessionId);
    assert.equal(
      replay.runtimeContinuity.instructions.entryCount,
      resumedStatus.instructions.entryCount,
    );

    const resumedUsage = resumed.getUsageSummary();
    assert.ok(resumedUsage.runtimeContinuity);

    const resumedTrace = await resumed.getTrace("all");
    assert.ok(Array.isArray(resumedTrace.phases));
    assert.equal(
      resumedTrace.runtimeContinuity.instructions.entryCount,
      resumedStatus.instructions.entryCount,
    );

    const resumedSnapshot = await resumed.executionJournal.loadLatestSnapshot(resumed.sessionId);
    assert.ok(resumedSnapshot?.filePath);
    assert.equal(resumedSnapshot?.state?.parentSessionId, parentSessionId);
  } finally {
    await resumed.close();
    await agent.close();
  }
});

test("session browser and resume recommendation keep lineage, replay, and branch continuity grounded", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-session-browser-agent-"));
  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );

  await agent.runUserInput("What is the current working directory?");
  const parentSessionId = agent.sessionId;

  const resumed = await MJCodeAgent.resume(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
    parentSessionId,
  );

  try {
    const sessionsReport = await resumed.browseSessionHistory("sessions", "current");
    assert.ok(sessionsReport.sessions.some((entry) => entry.sessionId === resumed.sessionId));

    const lineageReport = await resumed.browseSessionHistory("lineage", "current");
    assert.equal(lineageReport.reference.resolvedSessionId, resumed.sessionId);
    assert.equal(lineageReport.lineage?.focus?.parentSessionId, parentSessionId);
    assert.ok(lineageReport.lineage?.ancestors.some((entry) => entry.sessionId === parentSessionId));
    assert.ok(lineageReport.suggestedCommands.some((entry) => /history replay/.test(entry.command)));

    const replayReport = await resumed.browseSessionHistory("replay", parentSessionId);
    assert.equal(replayReport.replay?.sessionId, parentSessionId);
    assert.ok(replayReport.replay?.suggestedCommands.some((entry) => /why plan replay:/.test(entry.command)));
    assert.ok(replayReport.replay?.suggestedCommands.some((entry) => /history lineage/.test(entry.command)));
    assert.equal(replayReport.replay?.availability.verifierAvailable, false);

    const currentRecommendation = await resumed.recommendSessionResume("current");
    assert.equal(currentRecommendation.recommendation.status, "not_needed");
    assert.equal(currentRecommendation.recommendation.reasonKind, "already_current");

    const latestRecommendation = await resumed.recommendSessionResume("latest");
    assert.ok(latestRecommendation.recommendation.recommendedSessionId);
    assert.ok(["recommended", "discouraged", "not_needed"].includes(latestRecommendation.recommendation.status));
  } finally {
    await resumed.close();
    await agent.close();
  }
});

test("agent static session entry preserves subclass instances across create inspect and resume", async () => {
  class DerivedAgent extends MJCodeAgent {}

  const inspectAgent = await DerivedAgent.inspect(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );
  assert.ok(inspectAgent instanceof DerivedAgent);
  await inspectAgent.close();

  const createdAgent = await DerivedAgent.create(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
  );
  assert.ok(createdAgent instanceof DerivedAgent);

  const resumedAgent = await DerivedAgent.resume(
    {
      cwd: process.cwd(),
      overrides: {
        provider: "mock",
        permissionMode: "workspace-write",
        approvalPolicy: "on-write",
      },
    },
    createUi(),
    createdAgent.sessionId,
  );
  try {
    assert.ok(resumedAgent instanceof DerivedAgent);
    assert.equal(resumedAgent.parentSessionId, createdAgent.sessionId);
    assert.ok(resumedAgent.getStatus().runtimeHealth);
  } finally {
    await resumedAgent.close();
    await createdAgent.close();
  }
});

test("agent write execution produces a change-set and supports undo", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-write-"));
  await fs.writeFile(path.join(tempRoot, "note.txt"), "before\n", "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );
  try {
    const turnState = agent.startTrace("Update note");
    const execution = await agent.handleToolExecution({
      toolName: "write_file",
      input: {
        path: "note.txt",
        content: "after\n",
      },
      toolCallId: null,
      turnState,
      step: 1,
      nativeToolCall: false,
    });

    assert.equal(execution.ok, true);
    assert.ok(agent.getLastDiff());

    const history = await agent.listChangeHistory();
    assert.equal(history[0].status, "applied");

    const changed = await fs.readFile(path.join(tempRoot, "note.txt"), "utf8");
    assert.equal(changed, "after\n");

    const undoResult = await agent.undoChange(history[0].id);
    assert.equal(undoResult.rolledBack, true);

    const restored = await fs.readFile(path.join(tempRoot, "note.txt"), "utf8");
    assert.equal(restored, "before\n");
  } finally {
    await agent.close();
  }
});

test("agent tool execution respects approval denial without applying writes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-approval-"));
  const notePath = path.join(tempRoot, "note.txt");
  await fs.writeFile(notePath, "before\n", "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "on-write",
      },
    },
    createUi({ confirmResult: false }),
  );
  try {
    const turnState = agent.startTrace("Denied write");
    const execution = await agent.handleToolExecution({
      toolName: "write_file",
      input: {
        path: "note.txt",
        content: "after\n",
      },
      toolCallId: null,
      turnState,
      step: 1,
      nativeToolCall: false,
    });

    assert.equal(execution.ok, false);
    assert.equal(execution.error, "User denied approval.");
    assert.equal(agent.approvalStats.asked, 1);
    assert.equal(agent.approvalStats.denied, 1);
    assert.equal(turnState.approvalsDenied, 1);

    const contents = await fs.readFile(notePath, "utf8");
    assert.equal(contents, "before\n");

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /tool_approval/);
    assert.match(sessionContents, /"approved":false/);
  } finally {
    await agent.close();
  }
});

test("agent tool execution returns preview failure for preview-required tools", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-preview-"));
  await fs.writeFile(path.join(tempRoot, "note.txt"), "before\n", "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );
  try {
    let executeCalled = false;
    agent.toolRegistry.preview = async (toolName) => {
      if (toolName === "write_file") {
        throw new Error("preview exploded");
      }
      return null;
    };
    agent.toolRegistry.execute = async () => {
      executeCalled = true;
      return { ok: true };
    };

    const turnState = agent.startTrace("Preview write");
    const execution = await agent.handleToolExecution({
      toolName: "write_file",
      input: {
        path: "note.txt",
        content: "after\n",
      },
      toolCallId: null,
      turnState,
      step: 1,
      nativeToolCall: false,
    });

    assert.equal(execution.ok, false);
    assert.match(execution.error, /Preview failed for write_file: preview exploded/);
    assert.equal(executeCalled, false);

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /Preview failed for write_file: preview exploded/);
  } finally {
    await agent.close();
  }
});

test("agent tool execution blocks when a before_tool hook fails in closed mode", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-hook-block-"));

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
        hooks: [
          {
            id: "before-tool-guard",
            event: "before_tool",
            command: "echo",
            args: ["guard"],
            failMode: "closed",
          },
        ],
      },
    },
    createUi(),
  );
  try {
    let executeCalled = false;
    agent.hookRunner.shellRuntime.run = async () => {
      throw Object.assign(new Error("hook failed"), {
        taxonomy: "shell_error",
      });
    };
    agent.toolRegistry.execute = async () => {
      executeCalled = true;
      return { ok: true };
    };

    const turnState = agent.startTrace("Blocked tool");
    const execution = await agent.handleToolExecution({
      toolName: "pwd",
      input: {},
      toolCallId: null,
      turnState,
      step: 1,
      nativeToolCall: false,
    });

    assert.equal(execution.ok, false);
    assert.equal(executeCalled, false);
    assert.equal(execution.error, 'Hook "before-tool-guard" failed in closed mode.');

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /hook_event/);
    assert.match(sessionContents, /before-tool-guard/);
    assert.match(sessionContents, /tool_denied/);
  } finally {
    await agent.close();
  }
});

test("agent tool execution emits after_apply hooks and persists advisories", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-after-apply-"));
  const notePath = path.join(tempRoot, "note.txt");
  await fs.writeFile(notePath, "before\n", "utf8");

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
        hooks: [
          {
            id: "after-apply-format",
            event: "after_apply",
            command: "echo",
            args: ["format"],
            failMode: "open",
            filters: {
              writeOnly: true,
            },
          },
        ],
      },
    },
    createUi(),
  );
  try {
    agent.hookRunner.shellRuntime.run = async (hookInput) => {
      assert.equal(hookInput.command, "echo");
      return {
        jobId: "hook-job-1",
        status: "exited",
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 2,
        stdout: JSON.stringify({
          advisory: "formatted",
          trace: { formatter: "mock" },
        }),
        stderr: "",
      };
    };

    const turnState = agent.startTrace("After apply hook");
    const execution = await agent.handleToolExecution({
      toolName: "write_file",
      input: {
        path: "note.txt",
        content: "after\n",
      },
      toolCallId: null,
      turnState,
      step: 1,
      nativeToolCall: false,
    });

    assert.equal(execution.ok, true);
    assert.equal(await fs.readFile(notePath, "utf8"), "after\n");

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /hook_event/);
    assert.match(sessionContents, /formatted/);

    const journalEntries = await agent.executionJournal.readEntries(agent.sessionId);
    assert.ok(journalEntries.some((entry) =>
      entry.type === "hook_event" &&
      entry.payload?.hookId === "after-apply-format" &&
      entry.payload?.advisory === "formatted"));

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.hookEvents.some((entry) =>
      entry.hookId === "after-apply-format" &&
      entry.advisory === "formatted"));
    assert.ok(replay.boundaryDecisions.some((entry) =>
      entry.toolName === "write_file" &&
      entry.type === "execution_boundary_decision"));

    const trace = await agent.getTrace();
    assert.ok(trace.hookEvents.some((entry) =>
      entry.payload?.hookId === "after-apply-format" &&
      entry.payload?.advisory === "formatted"));
    assert.ok(trace.boundaryDecisions.some((entry) =>
      entry.payload?.toolName === "write_file" &&
      entry.payload?.type === "execution_boundary_decision"));
  } finally {
    await agent.close();
  }
});

test("agent lifecycle hooks emit session_start on create and resume", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-session-start-"));
  const startupContext = "Session startup context from hook";
  const hookScriptPath = path.join(tempRoot, "session-start-hook.sh");
  await fs.writeFile(
    hookScriptPath,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ startupContext })}'\n`,
    "utf8",
  );
  await fs.chmod(hookScriptPath, 0o755);

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
        hooks: [
          {
            id: "session-start-hook",
            event: "session_start",
            command: hookScriptPath,
            args: [],
            failMode: "open",
          },
        ],
      },
    },
    createUi(),
  );

  let resumed = null;
  try {
    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /session_start/);
    assert.match(sessionContents, /Session startup context from hook/);

    let capturedSystemPrompt = "";
    const originalPrepare = agent.contextManager.prepare.bind(agent.contextManager);
    agent.contextManager.prepare = async (input) => {
      capturedSystemPrompt = input.baseSystemPrompt;
      return originalPrepare(input);
    };

    await agent.runUserInput("What is the current working directory?");
    assert.match(capturedSystemPrompt, /Hook-injected lifecycle context/);
    assert.match(capturedSystemPrompt, /Session startup context from hook/);

    resumed = await MJCodeAgent.resume(
      {
        cwd: tempRoot,
        overrides: {
          provider: "mock",
          permissionMode: "full-access",
          approvalPolicy: "never",
          hooks: [
            {
              id: "session-start-hook",
              event: "session_start",
              command: hookScriptPath,
              args: [],
              failMode: "open",
            },
          ],
        },
      },
      createUi(),
      agent.sessionId,
    );

    const resumedContents = await fs.readFile(resumed.sessionFilePath, "utf8");
    assert.match(resumedContents, /session_start/);
    assert.match(resumedContents, /Session startup context from hook/);
  } finally {
    await resumed?.close();
    await agent.close();
  }
});

test("agent lifecycle hooks emit session_end on close", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-session-end-"));
  const advisory = "session-end-recorded";
  const hookScriptPath = path.join(tempRoot, "session-end-hook.sh");
  await fs.writeFile(
    hookScriptPath,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ advisory })}'\n`,
    "utf8",
  );
  await fs.chmod(hookScriptPath, 0o755);
  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
        hooks: [
          {
            id: "session-end-hook",
            event: "session_end",
            command: hookScriptPath,
            args: [],
            failMode: "open",
          },
        ],
      },
    },
    createUi(),
  );

  const sessionPath = agent.sessionFilePath;
  await agent.close();

  const sessionContents = await fs.readFile(sessionPath, "utf8");
  assert.match(sessionContents, /session_end/);
  assert.match(sessionContents, /session-end-recorded/);
});

test("user_prompt_submit hook can block prompt processing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-prompt-block-"));
  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
        hooks: [
          {
            id: "prompt-guard",
            event: "user_prompt_submit",
            command: "echo",
            args: ["guard"],
            failMode: "closed",
          },
        ],
      },
    },
    createUi(),
  );

  try {
    let providerCalled = false;
    agent.provider.complete = async () => {
      providerCalled = true;
      return {
        text: "should not run",
        usage: null,
        meta: {},
      };
    };
    agent.hookRunner.shellRuntime.run = async () => ({
      jobId: "hook-job-guard",
      status: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 2,
      stdout: JSON.stringify({
        block: true,
        reason: "Prompt blocked by lifecycle hook.",
      }),
      stderr: "",
    });

    const result = await agent.runUserInput("Do not process this prompt.");
    assert.equal(result.content, "Prompt blocked by lifecycle hook.");
    assert.equal(providerCalled, false);
    assert.equal(agent.messages.length, 0);

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /user_prompt_submit/);
    assert.match(sessionContents, /Prompt blocked by lifecycle hook/);
  } finally {
    await agent.close();
  }
});

test("user_prompt_submit hook can inject additional context into the current turn", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-prompt-context-"));
  const injectedContext = "Prefer concise filesystem answers.";
  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
        hooks: [
          {
            id: "prompt-context-hook",
            event: "user_prompt_submit",
            command: "echo",
            args: ["context"],
            failMode: "open",
          },
        ],
      },
    },
    createUi(),
  );

  try {
    agent.hookRunner.shellRuntime.run = async () => ({
      jobId: "hook-job-context",
      status: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      stdout: JSON.stringify({
        additionalContext: injectedContext,
      }),
      stderr: "",
    });

    let capturedSystemPrompt = "";
    const originalPrepare = agent.contextManager.prepare.bind(agent.contextManager);
    agent.contextManager.prepare = async (input) => {
      capturedSystemPrompt = input.baseSystemPrompt;
      return originalPrepare(input);
    };

    await agent.runUserInput("What is the current working directory?");
    assert.match(capturedSystemPrompt, /Hook-injected lifecycle context/);
    assert.match(capturedSystemPrompt, /Prefer concise filesystem answers/);

    const replay = await agent.replaySession(agent.sessionId);
    assert.ok(replay.hookEvents.some((entry) =>
      entry.event === "user_prompt_submit" &&
      entry.injectedContext?.content === injectedContext));
  } finally {
    await agent.close();
  }
});

test("pre_compact hook fires before compactConversation", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-pre-compact-"));
  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
        hooks: [
          {
            id: "pre-compact-hook",
            event: "pre_compact",
            command: "echo",
            args: ["compact"],
            failMode: "open",
          },
        ],
      },
    },
    createUi(),
  );

  try {
    agent.messages.push(
      { role: "user", content: "alpha" },
      { role: "assistant", content: "beta" },
    );
    agent.hookRunner.shellRuntime.run = async () => ({
      jobId: "hook-job-compact",
      status: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      stdout: JSON.stringify({
        advisory: "compact-notified",
      }),
      stderr: "",
    });

    await agent.compactConversation();

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /pre_compact/);
    assert.match(sessionContents, /compact-notified/);
  } finally {
    await agent.close();
  }
});

test("agent exposes MCP tools and can invoke them through the unified tool path", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-mcp-"));
  const fixtureServer = path.resolve("fixtures/mock-mcp-server.mjs");
  await fs.writeFile(path.join(tempRoot, ".mcp.json"), JSON.stringify({
    mcpServers: {
      demo: {
        command: process.execPath,
        args: [fixtureServer],
      },
    },
  }, null, 2));

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );
  try {
    const tools = agent.toolRegistry.getToolSpecs();
    assert.ok(tools.some((entry) => entry.name === "mcp__demo__echo"));

    const result = await agent.invokeCommandTool("mcp__demo__echo", { text: "agent" });
    assert.equal(result.summary, "echo:agent");

    const status = agent.getStatus();
    assert.equal(status.lastTrace.steps, 1);
    assert.ok(status.lastTrace.toolsUsed.includes("mcp__demo__echo"));

    const usage = agent.getUsageSummary();
    assert.equal(usage.lastTrace.traceId, status.lastTrace.traceId);
    assert.ok(usage.runtimeHealth.scorecard);

    const trace = await agent.getTrace();
    assert.equal(trace.current.traceId, status.lastTrace.traceId);
    assert.ok(trace.phases.some((entry) => entry.phase === "finalize"));
    assert.ok(Array.isArray(trace.boundaryDecisions));
    assert.ok(trace.mcpEvents.some((entry) => entry.payload?.type === "mcp_tool_invocation_completed" || entry.type === "mcp_tool_invocation_completed"));

    const sessionContents = await fs.readFile(agent.sessionFilePath, "utf8");
    assert.match(sessionContents, /"standaloneTool":true/);
  } finally {
    await agent.close();
  }
});

test("resumed agent can see and control background jobs from the parent session", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-shell-"));
  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  const background = await agent.invokeCommandTool("run_shell", {
    command: "sleep 5",
    shell: "/bin/sh",
    background: true,
  });

  const resumed = await MJCodeAgent.resume(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
    agent.sessionId,
  );
  try {
    const jobs = await resumed.listJobs("running");
    const visible = jobs.find((entry) => entry.id === background.jobId);
    assert.ok(visible);
    assert.equal(visible.continuityState, "reattached");

    const runtimeHealth = resumed.getRuntimeHealth();
    assert.ok(runtimeHealth.scorecard.shell.totalJobs >= 1);

    const attach = await resumed.attachJob(background.jobId);
    assert.equal(attach.mode, "live_attach");

    const shellHistory = await resumed.getShellHistory();
    assert.ok(shellHistory.some((entry) => entry.id === background.jobId));

    const cancelled = await resumed.cancelJob(background.jobId);
    assert.equal(cancelled.cancelled, true);
  } finally {
    await resumed.close();
    await agent.close();
  }
});

test("agent exposes unified capability surface with project skills and plugin tools", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-capabilities-"));
  const skillDir = path.join(tempRoot, ".mj-code", "skills", "repo-runtime");
  const pluginDir = path.join(tempRoot, ".mj-code", "plugins", "echo-fixture");

  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });

  await fs.writeFile(path.join(skillDir, "skill.json"), JSON.stringify({
    id: "repo-runtime",
    title: "Repo Runtime",
    description: "Project runtime policy.",
    promptFile: "prompt.md",
    workflowHints: ["Inspect runtime modules before editing."],
    toolPreferences: {
      prefer: ["read_file", "apply_patch"],
    },
  }, null, 2));
  await fs.writeFile(path.join(skillDir, "prompt.md"), "Prefer runtime-safe changes.\n");

  await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
    id: "echo-fixture",
    name: "Echo Fixture",
    version: "0.1.0",
    description: "Echo plugin used in the agent mock test.",
    entry: "index.mjs",
    permissionsHints: ["read"],
    capabilities: [
      {
        type: "plugin-tool",
        name: "echo_text",
        description: "Echo incoming text.",
        riskCategory: "read",
      },
    ],
  }, null, 2));
  await fs.writeFile(path.join(pluginDir, "index.mjs"), [
    "export async function register(context) {",
    "  return {",
    "    tools: [",
    "      {",
    "        name: 'echo_text',",
    "        description: 'Echo incoming text.',",
    "        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },",
    "        riskCategory: 'read',",
    "        async handler(input) {",
    "          return { echo: `${context.plugin.id}:${input.text}` };",
    "        }",
    "      }",
    "    ]",
    "  };",
    "}",
    "",
  ].join("\n"));

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );
  try {
    const status = agent.getStatus();
    assert.ok(status.activeSkills.some((entry) => entry.id === "repo-runtime"));
    assert.ok(status.policy.sources.some((entry) => entry.layer === "skill"));

    const capabilities = agent.getCapabilities();
    assert.ok(capabilities.capabilities.some((entry) => entry.type === "skill" && entry.name === "repo-runtime"));
    assert.ok(capabilities.capabilities.some((entry) => entry.type === "plugin-tool" && entry.displayName === "echo_text"));
    assert.ok(capabilities.capabilities.some((entry) => entry.type === "memory"));
    assert.ok(capabilities.capabilities.some((entry) => entry.type === "instruction/policy"));

    const tools = agent.toolRegistry.getToolSpecs();
    assert.ok(tools.some((entry) => entry.name === "plugin__echo_fixture__echo_text"));

    const result = await agent.invokeCommandTool("plugin__echo_fixture__echo_text", { text: "hello" });
    assert.equal(result.echo, "echo-fixture:hello");

    await agent.enableSkill("repo-maintainer");
    assert.ok(agent.getStatus().activeSkills.some((entry) => entry.id === "repo-maintainer"));
  } finally {
    await agent.close();
  }
});

test("agent command surfaces keep sources, memory, skills, plugins, runtime, and prompt sync working", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mj-agent-command-surface-"));
  const skillDir = path.join(tempRoot, ".mj-code", "skills", "repo-runtime");
  const pluginDir = path.join(tempRoot, ".mj-code", "plugins", "echo-fixture");

  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });

  await fs.writeFile(path.join(skillDir, "skill.json"), JSON.stringify({
    id: "repo-runtime",
    title: "Repo Runtime",
    description: "Project runtime policy.",
    promptFile: "prompt.md",
    workflowHints: ["Inspect runtime modules before editing."],
    toolPreferences: {
      prefer: ["read_file", "apply_patch"],
    },
  }, null, 2));
  await fs.writeFile(path.join(skillDir, "prompt.md"), "Prefer runtime-safe changes.\n");

  await fs.writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify({
    id: "echo-fixture",
    name: "Echo Fixture",
    version: "0.1.0",
    description: "Echo plugin used in the command surface test.",
    entry: "index.mjs",
    permissionsHints: ["read"],
    capabilities: [
      {
        type: "plugin-tool",
        name: "echo_text",
        description: "Echo incoming text.",
        riskCategory: "read",
      },
    ],
  }, null, 2));
  await fs.writeFile(path.join(pluginDir, "index.mjs"), [
    "export async function register(context) {",
    "  return {",
    "    tools: [",
    "      {",
    "        name: 'echo_text',",
    "        description: 'Echo incoming text.',",
    "        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },",
    "        riskCategory: 'read',",
    "        async handler(input) {",
    "          return { echo: `${context.plugin.id}:${input.text}` };",
    "        }",
    "      }",
    "    ]",
    "  };",
    "}",
    "",
  ].join("\n"));

  const agent = await MJCodeAgent.create(
    {
      cwd: tempRoot,
      overrides: {
        provider: "mock",
        permissionMode: "full-access",
        approvalPolicy: "never",
      },
    },
    createUi(),
  );

  try {
    const models = await agent.listModels();
    assert.ok(models.includes("mock-mj-code-v1"));

    const sessions = await agent.listSessions();
    assert.ok(sessions.some((entry) => entry.id === agent.sessionId));

    await agent.sourceRegistry.registerPack([
      {
        url: "https://example.com/docs/mj-code",
        title: "Example MJ Code Docs",
        domain: "example.com",
        sourceKind: "web",
        official: true,
      },
    ], {
      toolName: "web_search",
      query: "mj code docs",
      provider: "fixture",
    });

    const sources = await agent.getSources();
    assert.equal(sources.sources.length, 1);
    assert.equal(sources.sources[0].title, "Example MJ Code Docs");

    const inspectedSource = await agent.inspectSource(sources.sources[0].sourceId);
    assert.equal(inspectedSource?.domain, "example.com");

    const approvalMode = agent.getApprovalMode();
    assert.equal(approvalMode.permissionMode, "full-access");
    assert.equal(approvalMode.approvalPolicy, "never");
    assert.equal(approvalMode.networkMode, "docs-only");

    await agent.rememberMemory({
      scope: "session",
      text: "Command surface memory note",
      summary: "command-surface-note",
      source: "manual-test",
    });
    const memoryResults = await agent.searchMemory("command surface memory note");
    assert.ok(memoryResults.some((entry) => entry.summary === "command-surface-note"));

    const runtimeHealth = agent.getRuntimeHealth();
    assert.ok(runtimeHealth.scorecard);
    assert.ok(Array.isArray(agent.getRuntimeCircuits()));

    let capturedSystemPrompt = "";
    const originalPrepare = agent.contextManager.prepare.bind(agent.contextManager);
    agent.contextManager.prepare = async (input) => {
      capturedSystemPrompt = input.baseSystemPrompt;
      return originalPrepare(input);
    };
    agent.provider.complete = async () => ({
      text: JSON.stringify({
        type: "final",
        content: "command surface check complete",
      }),
      usage: null,
      meta: {
        provider: "mock",
        mode: "command-surface-check",
      },
    });

    await agent.runUserInput("Summarize the current command surface.");
    assert.match(capturedSystemPrompt, /Prefer runtime-safe changes/);
    assert.match(capturedSystemPrompt, /plugin__echo_fixture__echo_text/);
    assert.ok(agent.getPolicySummary().sources.some((entry) => entry.layer === "skill"));

    await agent.disableSkill("repo-runtime");
    await agent.disablePlugin("echo-fixture");

    const inactiveCapabilities = agent.getCapabilities({ active: true });
    assert.ok(!inactiveCapabilities.capabilities.some((entry) => entry.type === "skill" && entry.name === "repo-runtime"));
    assert.ok(!inactiveCapabilities.capabilities.some((entry) => entry.type === "plugin-tool" && entry.displayName === "echo_text"));
    assert.ok(agent.getPlugins().plugins.some((entry) => entry.id === "echo-fixture" && entry.status === "disabled"));
    assert.ok(!agent.getPolicySummary().sources.some((entry) => entry.layer === "skill"));

    capturedSystemPrompt = "";
    await agent.runUserInput("Summarize the current command surface after disable.");
    assert.doesNotMatch(capturedSystemPrompt, /Prefer runtime-safe changes/);
    assert.doesNotMatch(capturedSystemPrompt, /plugin__echo_fixture__echo_text/);

    await agent.enableSkill("repo-runtime");
    await agent.enablePlugin("echo-fixture");

    const activeCapabilities = agent.getCapabilities({ active: true });
    assert.ok(activeCapabilities.capabilities.some((entry) => entry.type === "skill" && entry.name === "repo-runtime"));
    assert.ok(activeCapabilities.capabilities.some((entry) => entry.type === "plugin-tool" && entry.displayName === "echo_text"));
    assert.ok(agent.getPlugins().plugins.some((entry) => entry.id === "echo-fixture" && entry.status === "active"));
    assert.ok(agent.getPolicySummary().sources.some((entry) => entry.layer === "skill"));

    capturedSystemPrompt = "";
    await agent.runUserInput("Summarize the current command surface after re-enable.");
    assert.match(capturedSystemPrompt, /Prefer runtime-safe changes/);
    assert.match(capturedSystemPrompt, /plugin__echo_fixture__echo_text/);
  } finally {
    await agent.close();
  }
});
