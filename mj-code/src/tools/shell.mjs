import { spawn } from "node:child_process";

import { resolveUserPath } from "../lib/path-utils.mjs";

export async function runShell(input, context, executionContext = {}) {
  if (context.shellRuntime) {
    return context.shellRuntime.run(input, executionContext);
  }

  const command = typeof input.command === "string" ? input.command : "";
  if (!command) {
    throw new Error("run_shell requires a command string.");
  }

  const shell = input.shell || process.env.SHELL || "/bin/zsh";
  const cwd = input.cwd ? resolveUserPath(input.cwd, context.cwd) : context.cwd;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(shell, ["-lc", command], {
      cwd,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, context.shellTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}
