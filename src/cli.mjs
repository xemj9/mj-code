#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const currentFilePath = fileURLToPath(import.meta.url);
const sourceCliMainEntry = fileURLToPath(new URL("./cli-main.mts", import.meta.url));
const isBuiltRuntime = path.dirname(currentFilePath).endsWith(`${path.sep}dist`);
const hasTsxLoader = process.execArgv.some((entry, index, args) => (
  entry === "tsx" ||
  entry.includes("tsx/") ||
  (entry === "--import" && `${args[index + 1] ?? ""}`.includes("tsx"))
));

if (isBuiltRuntime || hasTsxLoader || process.env.MJ_CODE_TSX_BOOTSTRAPPED === "1") {
  const { main } = await import("./cli-main.mjs");
  await main();
} else {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", sourceCliMainEntry, ...process.argv.slice(2)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MJ_CODE_TSX_BOOTSTRAPPED: "1",
      },
      stdio: ["inherit", "inherit", "inherit"],
    },
  );

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exitCode = code ?? 1;
      }
      resolve();
    });
  });
}
