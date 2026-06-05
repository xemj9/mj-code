import test from "node:test";
import assert from "node:assert/strict";

import {
  PolicyStack,
  createCoreSystemPolicy,
  createProjectInstructionPolicies,
  createRuntimePolicy,
  createSkillPolicyContribution,
  createUserPreferencePolicy,
} from "../src/lib/policy-stack.mjs";

test("policy stack preserves layer precedence and source summaries", () => {
  const stack = new PolicyStack();
  const skillContribution = createSkillPolicyContribution({
    id: "repo-maintainer",
    title: "Repo Maintainer",
    active: true,
    prompt: "Bias toward surgical edits.",
    workflowHints: ["Inspect before editing."],
    retrievalHints: ["Open README.md first."],
    toolPreferences: {
      prefer: ["read_file", "apply_patch"],
      avoid: ["write_file"],
    },
    outputPolicy: ["Summarize verification."],
    scope: "builtin",
    sourceQualifiedName: "builtin:repo-maintainer",
  });

  const instructionPolicies = createProjectInstructionPolicies({
    files: ["/tmp/demo/MJ.md", "/tmp/demo/.mj-code/MJ.local.md"],
    content: "ignored",
    rules: [],
    entries: [
      {
        id: "instruction:user-global",
        layer: "user-global",
        order: 10,
        scope: "user",
        title: "user-global: MJ.md",
        originPath: "/tmp/user/MJ.md",
        relativePath: "MJ.md",
        sourceQualifiedName: "user:instruction:user-global:MJ.md",
        importedFrom: null,
        importDepth: 0,
        importRequests: [],
        content: "Global defaults.",
        renderedContent: "Global defaults.",
        rules: [],
      },
      {
        id: "instruction:workspace-root",
        layer: "workspace-root",
        order: 20,
        scope: "project",
        title: "workspace-root: MJ.md",
        originPath: "/tmp/demo/MJ.md",
        relativePath: "MJ.md",
        sourceQualifiedName: "project:instruction:workspace-root:MJ.md",
        importedFrom: null,
        importDepth: 0,
        importRequests: ["./shared.md"],
        content: "Keep README in sync.",
        renderedContent: "Keep README in sync.",
        rules: [],
      },
      {
        id: "instruction:local-override",
        layer: "local-override",
        order: 30,
        scope: "project",
        title: "local-override: MJ.local.md",
        originPath: "/tmp/demo/.mj-code/MJ.local.md",
        relativePath: ".mj-code/MJ.local.md",
        sourceQualifiedName: "project:instruction:local-override:.mj-code/MJ.local.md",
        importedFrom: null,
        importDepth: 0,
        importRequests: [],
        content: "Local overrides win.",
        renderedContent: "Local overrides win.",
        rules: [],
      },
    ],
  });

  const effective = stack.setContributions([
    createRuntimePolicy({
      cwd: "/tmp/demo",
      permissionMode: "workspace-write",
      approvalPolicy: "on-write",
      networkMode: "docs-only",
    }),
    createUserPreferencePolicy("Use concise answers."),
    skillContribution,
    createCoreSystemPolicy({
      nativeToolCalling: true,
    }),
    ...instructionPolicies,
  ]);

  assert.deepEqual(
    effective.sources.map((entry) => entry.layer),
    [
      "core-system",
      "project-instruction",
      "project-instruction",
      "project-instruction",
      "skill",
      "user-preference",
      "runtime",
    ],
  );
  assert.match(effective.text, /Core System Policy/);
  assert.match(effective.text, /user-global: MJ.md/);
  assert.match(effective.text, /workspace-root: MJ.md/);
  assert.match(effective.text, /local-override: MJ.local.md/);
  assert.match(effective.text, /Skill: Repo Maintainer/);
  assert.match(effective.text, /Prefer: read_file, apply_patch/);
  assert.match(effective.text, /Use concise answers/);
  assert.match(effective.text, /Permission mode: workspace-write/);
  assert.equal(effective.sources[1].metadata.instructionLayer, "user-global");
  assert.equal(effective.sources[2].originPath, "/tmp/demo/MJ.md");
  assert.equal(effective.sources[3].metadata.sourceQualifiedName, "project:instruction:local-override:.mj-code/MJ.local.md");
});
