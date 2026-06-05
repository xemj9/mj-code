import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TsServerTransport,
  extractConfigFileDiagnosticEvents,
} from "../src/lib/tsserver-transport.mjs";

async function createTempProject(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("tsserver transport returns project-aware semantic diagnostics", async (t) => {
  const root = await createTempProject("mj-tsserver-transport-project-");
  const filePath = path.join(root, "broken.ts");
  const fileContent = "export const broken: string = 1;\n";
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(filePath, fileContent, "utf8");

  const transport = new TsServerTransport({ cwd: root });
  t.after(async () => {
    await transport.close();
  });

  await transport.openFile({
    filePath,
    fileContent,
    projectRootPath: root,
    scriptKindName: "TS",
  });
  const projectInfo = await transport.getProjectInfo(filePath);
  const diagnostics = await transport.getSemanticDiagnostics(filePath);

  assert.equal(projectInfo.isInferredProject, false);
  assert.equal(projectInfo.languageServiceEnabled, true);
  assert.equal(projectInfo.configFileName, path.join(root, "tsconfig.json"));
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.path === filePath &&
    diagnostic.code === "2322"
  ));
});

test("tsserver transport surfaces configFileDiag events for invalid tsconfig", async (t) => {
  const root = await createTempProject("mj-tsserver-transport-config-");
  const filePath = path.join(root, "ok.ts");
  const fileContent = "export const ok = 1;\n";
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "invalid-module-kind",
    },
    include: ["*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(filePath, fileContent, "utf8");

  const transport = new TsServerTransport({ cwd: root });
  t.after(async () => {
    await transport.close();
  });

  const cursor = transport.getEventCursor();
  await transport.openFile({
    filePath,
    fileContent,
    projectRootPath: root,
    scriptKindName: "TS",
  });
  await transport.getProjectInfo(filePath);

  const configEvents = extractConfigFileDiagnosticEvents(transport.getEventsSince(cursor));
  assert.ok(configEvents.some((event) =>
    event.configFile === path.join(root, "tsconfig.json") &&
    event.diagnostics.some((diagnostic) => diagnostic.code === "6046")
  ));
});

test("tsserver transport times out cleanly when the subprocess never responds", async (t) => {
  const root = await createTempProject("mj-tsserver-transport-timeout-");
  const filePath = path.join(root, "broken.ts");
  await fs.writeFile(filePath, "export const ok = 1;\n", "utf8");

  const transport = new TsServerTransport({
    cwd: root,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    requestTimeoutMs: 100,
  });
  t.after(async () => {
    await transport.close();
  });

  await assert.rejects(
    transport.getProjectInfo(filePath),
    (error) => error instanceof Error && error.name === "TsServerTransportError" && error.code === "transport_timeout",
  );
});
