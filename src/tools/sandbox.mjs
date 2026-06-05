import { SandboxRuntime } from "../lib/sandbox-runtime.mjs";

export async function runSandboxed(input, context) {
  if (!context.sandboxRuntime) {
    throw new Error("Sandbox runtime is not available in this runtime.");
  }

  const result = await context.sandboxRuntime.run({
    command: input.command,
    shell: input.shell,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    allowNetwork: input.allowNetwork ?? false,
    allowedWritePaths: input.allowedWritePaths,
    env: input.env,
  });

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    sandboxed: result.sandboxed,
    isolationLevel: result.isolationLevel,
    platform: result.platform,
    durationMs: result.durationMs,
    metadata: result.metadata,
  };
}

export async function checkSandboxAvailability(input, context) {
  if (!context.sandboxRuntime) {
    return {
      available: false,
      reason: "Sandbox runtime is not available in this runtime.",
    };
  }

  return context.sandboxRuntime.checkAvailability();
}
