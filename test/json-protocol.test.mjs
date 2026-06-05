import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemPrompt,
  extractAction,
  formatToolFeedback,
} from "../src/lib/json-protocol.mjs";

const baseInput = {
  tools: [
    {
      name: "read_file",
      displayName: "Read File",
      source: "builtin",
      description: "Read a file from disk.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    },
  ],
  config: {
    cwd: "/repo",
    permissionMode: "workspace-write",
    approvalPolicy: "on-write",
    networkMode: "docs-only",
  },
};

test("buildSystemPrompt keeps strict JSON fallback wording for non-native tool calling", () => {
  const prompt = buildSystemPrompt({
    ...baseInput,
    projectInstructions: "Prefer small diffs.",
    nativeToolCalling: false,
  });

  assert.match(prompt, /You may inspect code, edit files, and run commands only through the available tools\./);
  assert.match(prompt, /谢明锦/);
  assert.match(prompt, /"type":"tool_call","tool":"read_file"/);
  assert.match(prompt, /Project instructions:\nPrefer small diffs\./);
  assert.match(prompt, /Available tools:\n\n- read_file \(Read File\) \[builtin\]/);
});

test("buildSystemPrompt keeps native tool-calling wording and respects policy stack prompt rendering", () => {
  const rendered = "POLICY SECTION\nLine 2";
  const prompt = buildSystemPrompt({
    ...baseInput,
    nativeToolCalling: true,
    policyStack: {
      renderPromptSections() {
        return rendered;
      },
    },
  });

  assert.ok(prompt.startsWith(`${rendered}\n\nAvailable tools:`));
  assert.doesNotMatch(prompt, /respond with exactly one JSON object/i);
});

test("extractAction prefers the last valid fenced JSON block and normalizes tool input", () => {
  const action = extractAction([
    "```json",
    '{"type":"final","content":"ignore me"}',
    "```",
    "```json",
    '{"tool":"read_file","input":"README.md"}',
    "```",
  ].join("\n"));

  assert.deepEqual(action, {
    type: "tool_call",
    tool: "read_file",
    input: {},
  });
});

test("extractAction parses final JSON and ignores prose or invalid JSON", () => {
  assert.deepEqual(extractAction('{"type":"final","content":"done"}'), {
    type: "final",
    content: "done",
  });
  assert.equal(extractAction("I looked around and I am ready to help."), null);
  assert.equal(extractAction('{"type":"tool_call","tool":"read_file"'), null);
  assert.equal(extractAction('{"type":"tool_call"}'), null);
});

test("formatToolFeedback keeps stable JSON protocol continuation wording", () => {
  const message = formatToolFeedback("read_file", {
    ok: true,
    result: {
      path: "README.md",
      content: "hello",
    },
  });

  assert.match(message, /^Tool result for "read_file":/);
  assert.match(message, /"path": "README\.md"/);
  assert.match(message, /Continue with the JSON protocol\.$/);
});
