import {
  buildInteractiveShellPrompt,
  type InteractiveShellPromptMode,
  resolveInteractiveShellPromptMode,
} from "./interactive-shell-prompt.mjs";
import {
  resolveInteractiveShellAnswer,
  resolveInteractiveShellContinuation,
} from "./interactive-shell-ui-helpers.mjs";
import {
  normalizeInteractiveShellAnswer,
  shouldHydrateInteractiveShellAnswer,
} from "./interactive-shell-commands.mjs";
import {
  replaceReadlineLine,
} from "./terminal-ui-support.mjs";
import type {
  InteractiveCommandPaletteReport,
  InteractiveSessionPickerReport,
} from "../types/contracts.js";

export interface InteractiveShellPaletteStateLike {
  visible?: boolean;
  mode?: "palette" | "picker";
  selectedCommand?: string | null;
  currentInputLine?: string | null;
  report?: InteractiveCommandPaletteReport | InteractiveSessionPickerReport | null;
}

export interface InteractiveShellPaletteControllerLike {
  syncFromLine(line: string): Promise<void>;
  syncFromContinuation(inputLine: string, continuationLine: string): Promise<void>;
  getState(): InteractiveShellPaletteStateLike;
}

export async function resolveSubmittedInteractivePaletteState(input: {
  answer: unknown;
  interactivePaletteEnabled: boolean;
  palette: InteractiveShellPaletteControllerLike;
}): Promise<InteractiveShellPaletteStateLike> {
  const trimmedAnswer = typeof input.answer === "string"
    ? normalizeInteractiveShellAnswer(input.answer)
    : "";
  if (!input.interactivePaletteEnabled || !shouldHydrateInteractiveShellAnswer(trimmedAnswer)) {
    return input.palette.getState();
  }
  await input.palette.syncFromLine(trimmedAnswer);
  return input.palette.getState();
}

export async function runInteractiveShellAskLoop(input: {
  interactivePaletteEnabled: boolean;
  palette: InteractiveShellPaletteControllerLike;
  rl: {
    setPrompt?: (prompt: string) => void;
    prompt?: (preserveCursor?: boolean) => void;
  };
  askQuestion: (prompt: string) => Promise<string>;
  applyPromptMode: (mode: InteractiveShellPromptMode) => void;
}): Promise<unknown> {
  let seededLine: string | null = null;
  let seededContinuationLine: string | null = null;

  while (true) {
    const promptMode = seededContinuationLine
      ? resolveInteractiveShellPromptMode({
        visible: true,
        mode: "picker",
        report: { step: "action" },
      })
      : resolveInteractiveShellPromptMode(input.palette.getState());
    input.applyPromptMode(promptMode);
    const answerPromise = input.askQuestion(buildInteractiveShellPrompt(promptMode));
    if (seededLine != null) {
      replaceReadlineLine(input.rl, seededLine, { prompt: false });
      if (seededContinuationLine) {
        await input.palette.syncFromContinuation(seededLine, seededContinuationLine);
        input.applyPromptMode(resolveInteractiveShellPromptMode(input.palette.getState()));
      }
      seededLine = null;
      seededContinuationLine = null;
    }
    const answer = await answerPromise;
    const normalizedAnswer = typeof answer === "string"
      ? normalizeInteractiveShellAnswer(answer)
      : answer;
    const paletteState = await resolveSubmittedInteractivePaletteState({
      answer: normalizedAnswer,
      interactivePaletteEnabled: input.interactivePaletteEnabled,
      palette: input.palette,
    });
    input.applyPromptMode(resolveInteractiveShellPromptMode(paletteState));
    const continuation = resolveInteractiveShellContinuation(normalizedAnswer, paletteState);
    if (input.interactivePaletteEnabled && continuation) {
      seededLine = continuation.displayLine;
      seededContinuationLine = continuation.continuationLine;
      continue;
    }
    input.applyPromptMode("input");
    return resolveInteractiveShellAnswer(normalizedAnswer, paletteState);
  }
}
