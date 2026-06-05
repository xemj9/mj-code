import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CapabilityRegistry } from "../src/lib/capability-registry.mjs";
import { ExtensionStateStore } from "../src/lib/extension-state-store.mjs";
import { SkillLoader } from "../src/lib/skill-loader.mjs";

test("skill loader supports project auto-attach, builtin inactive defaults, and persistent enable/disable overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-skill-loader-"));
  const projectStateDir = path.join(root, ".mj-code");
  const userStateDir = path.join(root, ".user-state");
  const projectSkillDir = path.join(projectStateDir, "skills", "repo-runtime");

  await fs.mkdir(projectSkillDir, { recursive: true });
  await fs.mkdir(userStateDir, { recursive: true });
  await fs.writeFile(path.join(projectSkillDir, "skill.json"), JSON.stringify({
    id: "repo-runtime",
    title: "Repo Runtime",
    description: "Project-specific runtime guidance.",
    promptFile: "prompt.md",
    workflowHints: ["Run focused tests."],
    retrievalHints: ["Inspect runtime modules first."],
    toolPreferences: {
      prefer: ["read_file", "apply_patch"],
    },
    outputPolicy: ["List residual risks."],
  }, null, 2));
  await fs.writeFile(path.join(projectSkillDir, "prompt.md"), "Prefer runtime-safe changes.\n");

  const stateStore = new ExtensionStateStore(projectStateDir);
  await stateStore.initialize();

  const loader = new SkillLoader({
    projectStateDir,
    userStateDir,
  }, {
    stateStore,
  });
  await loader.initialize();

  const projectSkill = loader.inspectSkill("repo-runtime");
  assert.equal(projectSkill.scope, "project");
  assert.equal(projectSkill.active, true);
  assert.equal(projectSkill.sourceQualifiedName, "project:repo-runtime");
  assert.ok(projectSkill.influence.summary.includes("workflow hint"));

  const builtinSkill = loader.inspectSkill("repo-maintainer");
  assert.equal(builtinSkill.enabled, true);
  assert.equal(builtinSkill.active, false);
  assert.equal(loader.listSkills().find((entry) => entry.id === "repo-maintainer")?.active, false);

  await loader.enableSkill("repo-maintainer");
  assert.equal(loader.inspectSkill("repo-maintainer").active, true);

  await loader.disableSkill("repo-runtime");
  assert.equal(loader.inspectSkill("repo-runtime").enabled, false);
  assert.equal(loader.inspectSkill("repo-runtime").active, false);

  const reloadedStateStore = new ExtensionStateStore(projectStateDir);
  await reloadedStateStore.initialize();
  const reloadedLoader = new SkillLoader({
    projectStateDir,
    userStateDir,
  }, {
    stateStore: reloadedStateStore,
  });
  await reloadedLoader.initialize();
  assert.equal(reloadedLoader.inspectSkill("repo-maintainer").active, true);
  assert.equal(reloadedLoader.inspectSkill("repo-runtime").enabled, false);

  const capabilityRegistry = new CapabilityRegistry();
  loader.registerCapabilities(capabilityRegistry);
  const surface = capabilityRegistry.describe({ type: "skill" });
  const capability = surface.capabilities.find((entry) => entry.name === "repo-runtime");
  assert.ok(capability);
  assert.equal(capability.sourceQualifiedName, "project:repo-runtime");
  assert.equal(capability.metadata.autoAttach, true);
  assert.match(capability.metadata.influenceSummary, /workflow hint/);
});

test("skill loader keeps configured dir precedence, promptFile resolution, duplicate path dedupe, and stable influence summaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-skill-loader-precedence-"));
  const projectStateDir = path.join(root, ".mj-code");
  const userStateDir = path.join(root, ".user-state");
  const projectSkillDir = path.join(projectStateDir, "skills", "repo-runtime");
  const configuredSkillRoot = path.join(root, "extra-skills");
  const configuredSkillDir = path.join(configuredSkillRoot, "repo-runtime");

  await fs.mkdir(projectSkillDir, { recursive: true });
  await fs.mkdir(configuredSkillDir, { recursive: true });
  await fs.mkdir(path.join(configuredSkillDir, "prompts"), { recursive: true });
  await fs.mkdir(userStateDir, { recursive: true });

  await fs.writeFile(path.join(projectSkillDir, "skill.json"), JSON.stringify({
    id: "repo-runtime",
    title: "Project Runtime",
    description: "Project-level runtime guidance.",
    promptFile: "prompt.md",
    workflowHints: ["Inspect project runtime modules first."],
  }, null, 2));
  await fs.writeFile(path.join(projectSkillDir, "prompt.md"), "Project runtime prompt.\n");

  await fs.writeFile(path.join(configuredSkillDir, "skill.json"), JSON.stringify({
    id: "repo-runtime",
    title: "Configured Runtime",
    description: "Configured override for runtime work.",
    promptFile: "prompts/runtime.md",
    autoAttach: true,
    workflowHints: ["Inspect runtime entrypoints before editing."],
    retrievalHints: ["Search session traces before re-running experiments."],
    toolPreferences: {
      prefer: ["search_files", "read_file"],
    },
    outputPolicy: ["Report runtime regressions explicitly."],
  }, null, 2));
  await fs.writeFile(
    path.join(configuredSkillDir, "prompts", "runtime.md"),
    "Configured runtime prompt.\n",
  );

  const loader = new SkillLoader({
    projectStateDir,
    userStateDir,
    skillDirs: [
      configuredSkillRoot,
      configuredSkillRoot,
      path.join(projectStateDir, "skills"),
    ],
  });
  await loader.initialize();

  const record = loader.inspectSkill("repo-runtime");
  assert.equal(record.scope, "local");
  assert.equal(record.sourceQualifiedName, "local:repo-runtime");
  assert.equal(record.originPath, path.join(configuredSkillDir, "skill.json"));
  assert.equal(record.prompt, "Configured runtime prompt.");
  assert.equal(record.variants.length, 2);
  assert.deepEqual(
    record.variants.map((entry) => ({ id: entry.id, scope: entry.scope, precedence: entry.precedence })),
    [
      { id: "repo-runtime", scope: "project", precedence: 200 },
      { id: "repo-runtime", scope: "local", precedence: 300 },
    ],
  );
  assert.match(record.influenceSummary, /workflow hint/);
  assert.match(record.influenceSummary, /retrieval hint/);
  assert.match(record.influenceSummary, /prefer search_files, read_file/);
  assert.match(record.influenceSummary, /output rule/);

  const listEntry = loader.listSkills().find((entry) => entry.id === "repo-runtime");
  assert.equal(listEntry.scope, "local");
  assert.equal(listEntry.sourceQualifiedName, "local:repo-runtime");
  assert.equal(listEntry.influence.summary, listEntry.influenceSummary);
  assert.equal(listEntry.variants.length, 2);

  const influence = loader.getInfluenceSummary().find((entry) => entry.id === "repo-runtime");
  assert.equal(influence.sourceQualifiedName, "local:repo-runtime");
  assert.deepEqual(influence.preferredTools, ["search_files", "read_file"]);
  assert.equal(influence.workflowHintCount, 1);
  assert.equal(influence.retrievalHintCount, 1);
  assert.equal(influence.outputRuleCount, 1);
});

test("skill loader inspect and influence surfaces return stable copies instead of leaking internal references", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mj-skill-loader-clone-"));
  const projectStateDir = path.join(root, ".mj-code");
  const userStateDir = path.join(root, ".user-state");
  const projectSkillDir = path.join(projectStateDir, "skills", "repo-runtime");

  await fs.mkdir(projectSkillDir, { recursive: true });
  await fs.mkdir(userStateDir, { recursive: true });
  await fs.writeFile(path.join(projectSkillDir, "skill.json"), JSON.stringify({
    id: "repo-runtime",
    title: "Repo Runtime",
    description: "Project runtime guidance.",
    promptFile: "prompt.md",
    workflowHints: ["Inspect runtime seams first."],
    retrievalHints: ["Search prior traces before editing."],
    toolPreferences: {
      prefer: ["read_file"],
      avoid: ["write_file"],
    },
    outputPolicy: ["Call out runtime risks."],
  }, null, 2));
  await fs.writeFile(path.join(projectSkillDir, "prompt.md"), "Project runtime prompt.\n");

  const loader = new SkillLoader({
    projectStateDir,
    userStateDir,
  });
  await loader.initialize();

  const inspectA = loader.inspectSkill("repo-runtime");
  inspectA.tags.push("mutated");
  inspectA.workflowHints.push("bad hint");
  inspectA.retrievalHints.push("bad retrieval");
  inspectA.toolPreferences.prefer.push("write_file");
  inspectA.toolPreferences.avoid.length = 0;
  inspectA.variants[0].precedence = 999;
  inspectA.influence.summary = "mutated";
  inspectA.influence.preferredTools.push("mutated_tool");

  const influenceA = loader.getInfluenceSummary();
  influenceA[0].summary = "mutated influence";
  influenceA[0].preferredTools.push("mutated_tool");

  const inspectB = loader.inspectSkill("repo-runtime");
  const listEntry = loader.listSkills().find((entry) => entry.id === "repo-runtime");
  const influenceB = loader.getInfluenceSummary().find((entry) => entry.id === "repo-runtime");

  assert.deepEqual(inspectB.tags, []);
  assert.deepEqual(inspectB.workflowHints, ["Inspect runtime seams first."]);
  assert.deepEqual(inspectB.retrievalHints, ["Search prior traces before editing."]);
  assert.deepEqual(inspectB.toolPreferences, {
    prefer: ["read_file"],
    avoid: ["write_file"],
  });
  assert.equal(inspectB.variants[0].precedence, 200);
  assert.notEqual(inspectB.influence.summary, "mutated");
  assert.deepEqual(inspectB.influence.preferredTools, ["read_file"]);
  assert.equal(listEntry.influence.summary, inspectB.influenceSummary);
  assert.deepEqual(influenceB.preferredTools, ["read_file"]);
});
