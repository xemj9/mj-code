import { emitKeypressEvents } from "node:readline";

export interface InternalTtyWriteKey {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface InteractiveShellReadlineLike {
  line?: string;
  cursor?: number;
  _ttyWrite?: ((value: unknown, key?: InternalTtyWriteKey) => unknown) | undefined;
}

export interface InteractiveShellReadlineDriverInputLike {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface InteractiveShellReadlineDriverHooks {
  handleKeypress: (
    value: unknown,
    key: InternalTtyWriteKey | undefined,
    rl: InteractiveShellReadlineLike,
  ) => { handled: boolean; continuationLine: string | null; resetLineBeforeWrite?: boolean };
  handleContinuation: (continuationLine: string) => void;
  scheduleSync: (chunk: unknown) => void;
}

export function installInteractiveShellReadlineDriver(input: InteractiveShellReadlineDriverInputLike, rl: InteractiveShellReadlineLike, hooks: InteractiveShellReadlineDriverHooks): () => void {
  emitKeypressEvents(input as never, rl as never);

  const handleInputData = (chunk: unknown) => {
    hooks.scheduleSync(chunk);
  };

  input.on("data", handleInputData);

  const originalTtyWrite = typeof rl._ttyWrite === "function"
    ? rl._ttyWrite.bind(rl)
    : null;

  if (!originalTtyWrite) {
    return () => {
      input.removeListener("data", handleInputData);
    };
  }

  rl._ttyWrite = (value: unknown, key?: InternalTtyWriteKey) => {
    const result = hooks.handleKeypress(value, key, rl);
    if (result.continuationLine) {
      hooks.handleContinuation(result.continuationLine);
      return undefined;
    }
    if (result.handled) {
      return undefined;
    }
    if (result.resetLineBeforeWrite === true) {
      originalTtyWrite(null, { ctrl: true, name: "u" });
      if (typeof rl.line === "string") {
        rl.line = "";
      }
      if (typeof rl.cursor === "number") {
        rl.cursor = 0;
      }
    }
    const written = originalTtyWrite(value, key);
    hooks.scheduleSync(value);
    return written;
  };

  return () => {
    input.removeListener("data", handleInputData);
    rl._ttyWrite = originalTtyWrite;
  };
}
