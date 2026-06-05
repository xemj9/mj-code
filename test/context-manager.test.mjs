import test from "node:test";
import assert from "node:assert/strict";

import { ContextManager } from "../src/lib/context-manager.mjs";

test("context manager compacts history and injects retrieved memory", async () => {
  const manager = new ContextManager({
    provider: "openai-compatible",
    model: "gpt-3.5-turbo",
    maxTokens: 4000,
  });

  const longMessages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index + 1}: ${"detail ".repeat(900)}`,
  }));

  const prepared = await manager.prepare({
    baseSystemPrompt: "You are MJ Code.",
    messages: longMessages,
    userPrompt: "Need the repo memory and latest context.",
    memoryStore: {
      async getContextPack() {
        return {
          usedTokens: 60,
          items: [{ id: "mem1" }],
          text: "- [project/semantic] Repo uses Node and JSONL sessions.",
        };
      },
    },
  });

  assert.ok(prepared.meta.compactedMessages > 0);
  assert.ok(prepared.messages.length < longMessages.length);
  assert.match(prepared.systemPrompt, /Retrieved memories:/);
  assert.match(prepared.systemPrompt, /Rolling conversation summary:/);
  assert.ok(prepared.meta.selectedContextKinds.includes("memory"));
});

test("context manager biases sources over memory for docs lookup tasks", async () => {
  const manager = new ContextManager({
    provider: "openai-compatible",
    model: "gpt-5.4",
    maxTokens: 4000,
  });

  const prepared = await manager.prepare({
    baseSystemPrompt: "You are MJ Code.",
    messages: [{ role: "user", content: "Find the latest docs." }],
    userPrompt: "Find the latest official docs.",
    memoryStore: {
      async getContextPack() {
        return {
          usedTokens: 40,
          items: [{ id: "mem-docs" }],
          text: "- [project/policy] Prefer official docs.",
        };
      },
    },
    taskClassification: {
      taskClass: "official_docs_lookup",
      freshnessRequired: true,
    },
    routeDecision: {
      routingMode: "official-first",
      selectedCapabilities: [{ name: "web_search" }],
    },
    sourceRegistry: {
      getLastPack() {
        return {
          sourceIds: ["S1"],
        };
      },
      getSource() {
        return {
          sourceId: "S1",
          title: "Continue Docs",
          domain: "docs.continue.dev",
          excerpt: "Context providers let you inject project data into prompts.",
        };
      },
    },
    activeSkills: [
      {
        id: "docs-research",
        active: true,
        description: "Prefer docs-first retrieval.",
      },
    ],
    policy: {
      sources: [{ id: "policy:runtime", title: "Runtime Policy" }],
    },
    runtimeHealth: {
      scorecard: {
        degradedFlags: [],
      },
    },
  });

  assert.equal(prepared.meta.memoryArbitration, "sources-over-memory");
  assert.ok(prepared.meta.selectedContextKinds.includes("sources"));
  assert.deepEqual(prepared.meta.selectedSourceIds, ["S1"]);
  assert.match(prepared.systemPrompt, /Recent source pack:/);
});
