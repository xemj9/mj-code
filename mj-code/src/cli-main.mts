#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import process from "node:process";

import { main as runCliRuntime } from "./cli-runtime.mjs";

export async function main(): Promise<void> {
  await runCliRuntime().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`MJ Code failed: ${message}`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
