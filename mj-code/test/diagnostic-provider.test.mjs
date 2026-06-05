import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TypeScriptDiagnosticProvider } from "../src/lib/diagnostic-provider-typescript.mjs";

async function createTempProject(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function normalizeTestPath(filePath) {
  return path.resolve(filePath).toLowerCase();
}

test("typescript diagnostic provider defaults to tsserver for project-aware semantic diagnostics", async (t) => {
  const root = await createTempProject("mj-diagnostics-project-");
  const filePath = path.join(root, "broken.ts");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(filePath, "export const broken: string = 1;\n", "utf8");

  const provider = new TypeScriptDiagnosticProvider();
  t.after(async () => {
    await provider.close();
  });

  const result = await provider.collectDiagnostics({
    cwd: root,
    paths: [filePath],
  });

  assert.equal(result.availability.available, true);
  assert.equal(result.availability.mode, "project");
  assert.equal(result.engine, "tsserver");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.availability.transportAvailable, true);
  assert.ok(result.processedPaths.includes(filePath));
  assert.ok(result.summary.errorCount > 0);
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.path === filePath &&
    diagnostic.scope === "file" &&
    diagnostic.source === "typescript"
  ));
});

test("typescript diagnostic provider captures tsconfig diagnostics through tsserver events", async (t) => {
  const root = await createTempProject("mj-diagnostics-config-");
  const filePath = path.join(root, "ok.ts");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "invalid-module-kind",
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(filePath, "export const ok = 1;\n", "utf8");

  const provider = new TypeScriptDiagnosticProvider();
  t.after(async () => {
    await provider.close();
  });

  const result = await provider.collectDiagnostics({
    cwd: root,
    paths: [filePath],
  });

  assert.equal(result.availability.available, true);
  assert.equal(result.availability.mode, "project");
  assert.equal(result.engine, "tsserver");
  assert.equal(result.summary.errorCount > 0, true);
  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.scope === "config" &&
    diagnostic.source === "tsconfig" &&
    diagnostic.path === path.join(root, "tsconfig.json")
  ));
});

test("typescript diagnostic provider exposes stable tsserver fix hints and code actions for supported diagnostics", async (t) => {
  const root = await createTempProject("mj-diagnostics-fix-hints-");
  const filePath = path.join(root, "broken.ts");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      types: ["node"],
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(
    filePath,
    "export const data = readFileSync(\"./package.json\", \"utf8\");\n",
    "utf8",
  );

  const provider = new TypeScriptDiagnosticProvider();
  t.after(async () => {
    await provider.close();
  });

  const result = await provider.collectDiagnostics({
    cwd: root,
    paths: [filePath],
  });

  assert.equal(result.engine, "tsserver");
  assert.equal(result.fixHints.availability.available, true);
  assert.equal(result.fixHints.availability.source, "tsserver");
  assert.ok(result.fixHints.summary.total > 0);
  assert.equal(result.summary.fixHintCount, result.fixHints.summary.total);
  assert.equal(result.summary.recommendedFixHintCount, result.fixHints.summary.recommendedCount);
  assert.equal(result.codeActions.availability.available, true);
  assert.equal(result.codeActions.availability.source, "tsserver");
  assert.ok(result.codeActions.summary.total > 0);
  assert.equal(
    result.codeActions.summary.allowlistedCount + result.codeActions.summary.blockedCount,
    result.codeActions.summary.total,
  );
  assert.equal(result.summary.codeActionCandidateCount, result.codeActions.summary.total);
  assert.equal(result.summary.codeActionAllowlistedCount, result.codeActions.summary.allowlistedCount);
  assert.equal(result.summary.codeActionBlockedCount, result.codeActions.summary.blockedCount);

  const hint = result.fixHints.hints[0];
  assert.ok(hint);
  assert.equal(hint.source, "tsserver");
  assert.ok(hint.diagnosticFingerprints.length > 0);
  assert.ok(hint.filePaths.includes(filePath));
  assert.ok(hint.edits.length > 0);
  assert.equal(typeof hint.edits[0].changes[0].newTextPreview, "string");
  assert.ok(hint.edits[0].changes[0].newTextLength > 0);

  const action = result.codeActions.actions[0];
  assert.ok(action);
  assert.equal(action.source, "tsserver");
  assert.ok(action.diagnosticFingerprints.length > 0);
  assert.ok(action.filePaths.includes(filePath));
  assert.ok(action.edits.length > 0);
  assert.equal(typeof action.edits[0].changes[0].newTextPreview, "string");
  assert.equal(typeof action.allowlisted, "boolean");
  assert.equal(action.kind, "quickfix");
  assert.equal(typeof action.blockedReason === "string" || action.blockedReason === null, true);
});

test("typescript diagnostic provider exposes bounded tsserver project context for diagnostic-linked symbols", async (t) => {
  const root = await createTempProject("mj-diagnostics-project-context-");
  const filePath = path.join(root, "context.ts");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(
    filePath,
    [
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
    "utf8",
  );

  const provider = new TypeScriptDiagnosticProvider();
  t.after(async () => {
    await provider.close();
  });

  const result = await provider.collectDiagnostics({
    cwd: root,
    paths: [filePath],
  });

  assert.equal(result.engine, "tsserver");
  assert.equal(result.projectContext.availability.available, true);
  assert.equal(result.projectContext.availability.source, "tsserver");
  assert.ok(result.projectContext.summary.total > 0);
  assert.ok(result.projectContext.summary.quickInfoCount > 0);
  assert.ok(result.projectContext.summary.definitionCount > 0);
  assert.ok(result.projectContext.summary.implementationCount > 0);
  assert.ok(result.projectContext.summary.referenceCount > 0);
  assert.ok(result.projectContext.summary.documentSymbolCount > 0);
  assert.equal(result.summary.projectContextCount, result.projectContext.summary.total);
  assert.equal(
    result.summary.projectContextDiagnosticCoverageCount,
    result.projectContext.summary.diagnosticCoverageCount,
  );
  assert.equal(result.summary.projectContextDefinitionCount, result.projectContext.summary.definitionCount);
  assert.equal(result.summary.projectContextImplementationCount, result.projectContext.summary.implementationCount);
  assert.equal(result.summary.projectContextReferenceCount, result.projectContext.summary.referenceCount);
  assert.equal(result.summary.projectContextDocumentSymbolCount, result.projectContext.summary.documentSymbolCount);

  const item = result.projectContext.items[0];
  assert.ok(item);
  assert.equal(normalizeTestPath(item.path), normalizeTestPath(filePath));
  assert.equal(item.quickInfo?.kind, "method");
  assert.equal(typeof item.quickInfo?.displayText, "string");
  assert.equal(normalizeTestPath(item.definitions[0]?.path), normalizeTestPath(filePath));
  assert.equal(normalizeTestPath(item.implementations[0]?.path), normalizeTestPath(filePath));
  assert.ok(item.referenceCount >= item.references.length);
  assert.equal(typeof item.references[0]?.lineText, "string");
  assert.equal(item.enclosingSymbol?.name, "run");
  assert.ok(item.documentSymbolCount >= item.documentSymbols.length);
  assert.ok(item.documentSymbols.some((entry) => entry.name === "Worker"));
});

test("typescript diagnostic provider uses tsserver inferred-project diagnostics without tsconfig", async (t) => {
  const root = await createTempProject("mj-diagnostics-fallback-");
  const filePath = path.join(root, "fallback.mts");
  await fs.writeFile(filePath, "export const broken: string = 1;\n", "utf8");

  const provider = new TypeScriptDiagnosticProvider();
  t.after(async () => {
    await provider.close();
  });

  const result = await provider.collectDiagnostics({
    cwd: root,
    paths: [filePath],
  });

  assert.equal(result.availability.available, true);
  assert.equal(result.availability.mode, "single_file_fallback");
  assert.equal(result.engine, "tsserver");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.summary.processedTargetCount, 1);
  assert.ok(result.summary.errorCount > 0);
});

test("typescript diagnostic provider falls back to compiler api when tsserver transport fails", async (t) => {
  const root = await createTempProject("mj-diagnostics-transport-fallback-");
  const filePath = path.join(root, "broken.ts");
  await fs.writeFile(filePath, "export const broken: string = 1;\n", "utf8");

  const provider = new TypeScriptDiagnosticProvider({
    serverPath: path.join(root, "missing-tsserver.js"),
  });
  t.after(async () => {
    await provider.close();
  });

  const result = await provider.collectDiagnostics({
    cwd: root,
    paths: [filePath],
  });

  assert.equal(result.availability.available, true);
  assert.equal(result.availability.mode, "single_file_fallback");
  assert.equal(result.engine, "compiler_api");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.availability.transportAvailable, false);
  assert.match(result.fallbackReason ?? "", /tsserver/i);
  assert.ok(result.summary.errorCount > 0);
  assert.equal(result.fixHints.availability.available, false);
  assert.equal(result.fixHints.availability.source, "unavailable");
  assert.equal(result.summary.fixHintCount, 0);
  assert.match(result.fixHints.availability.reason ?? "", /compiler api/i);
  assert.equal(result.codeActions.availability.available, false);
  assert.equal(result.codeActions.availability.source, "unavailable");
  assert.equal(result.summary.codeActionCandidateCount, 0);
  assert.equal(result.summary.codeActionAllowlistedCount, 0);
  assert.equal(result.summary.codeActionBlockedCount, 0);
  assert.match(result.codeActions.availability.reason ?? "", /compiler api/i);
  assert.equal(result.projectContext.availability.available, false);
  assert.equal(result.projectContext.availability.source, "unavailable");
  assert.equal(result.summary.projectContextCount, 0);
  assert.equal(result.summary.projectContextImplementationCount, 0);
  assert.equal(result.summary.projectContextDocumentSymbolCount, 0);
  assert.match(result.projectContext.availability.reason ?? "", /compiler api/i);
});

test("typescript diagnostic provider supports JavaScript targets and keeps transport metadata stable", async (t) => {
  const root = await createTempProject("mj-diagnostics-js-");
  const filePath = path.join(root, "broken.js");
  await fs.writeFile(filePath, "// @ts-check\nconst value = missingSymbol;\nexport { value };\n", "utf8");

  const provider = new TypeScriptDiagnosticProvider();
  t.after(async () => {
    await provider.close();
  });

  const result = await provider.collectDiagnostics({
    cwd: root,
    paths: [filePath],
  });

  assert.equal(result.availability.available, true);
  assert.ok(["single_file_fallback", "project", "mixed"].includes(result.availability.mode));
  assert.equal(result.engine, "tsserver");
  assert.equal(result.availability.transportAvailable, true);
  assert.ok(result.summary.errorCount > 0 || result.summary.processedTargetCount === 1);
});

test("typescript diagnostic provider returns stable unavailable results for unsupported targets", async (t) => {
  const root = await createTempProject("mj-diagnostics-unsupported-");
  const filePath = path.join(root, "note.md");
  await fs.writeFile(filePath, "# note\n", "utf8");

  const provider = new TypeScriptDiagnosticProvider();
  t.after(async () => {
    await provider.close();
  });

  const result = await provider.collectDiagnostics({
    cwd: root,
    paths: [filePath],
  });

  assert.equal(result.availability.available, false);
  assert.equal(result.availability.mode, "unavailable");
  assert.equal(result.engine, null);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.summary.processedTargetCount, 0);
  assert.equal(result.fixHints.availability.available, false);
  assert.equal(result.fixHints.summary.total, 0);
  assert.equal(result.codeActions.availability.available, false);
  assert.equal(result.codeActions.summary.total, 0);
  assert.equal(result.projectContext.availability.available, false);
  assert.equal(result.projectContext.summary.total, 0);
  assert.equal(result.projectContext.summary.implementationCount, 0);
  assert.equal(result.projectContext.summary.documentSymbolCount, 0);
  assert.equal(result.skippedPaths.length, 1);
  assert.equal(result.skippedPaths[0].path, filePath);
});
