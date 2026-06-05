export type InteractiveShellPromptMode =
  | "input"
  | "launcher"
  | "target"
  | "action";

export function resolveInteractiveShellPromptMode(input: {
  visible?: boolean;
  mode?: "palette" | "picker";
  report?: unknown;
} | null | undefined): InteractiveShellPromptMode {
  if (!input?.visible) {
    return "input";
  }
  if (input.mode === "palette") {
    return "launcher";
  }
  const report = input.report != null && typeof input.report === "object"
    ? input.report as { step?: "target" | "action" }
    : null;
  return report?.step === "action"
    ? "action"
    : "target";
}

export function buildInteractiveShellPrompt(
  mode: InteractiveShellPromptMode = "input",
): string {
  switch (mode) {
    case "launcher":
      return "  / ";
    case "target":
      return "  pick › ";
    case "action":
      return "  do › ";
    case "input":
    default:
      return "  › ";
  }
}

export function applyInteractiveShellPrompt(
  rl: {
    setPrompt?: (prompt: string) => void;
    prompt?: (preserveCursor?: boolean) => void;
  } | null | undefined,
  prompt: string,
  options: {
    redraw?: boolean;
  } = {},
): void {
  if (!rl || typeof rl.setPrompt !== "function" || typeof rl.prompt !== "function") {
    return;
  }
  rl.setPrompt(prompt);
  if (options.redraw === true) {
    rl.prompt(true);
  }
}
