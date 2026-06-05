import path from "node:path";

export const INTERACTIVE_SHELL_PROMPT = "  › ";

export interface TerminalUiAnsiLike {
  dim(value: string): string;
  bold(value: string): string;
  cyan(value: string): string;
  brightCyan(value: string): string;
  green(value: string): string;
  brightGreen(value: string): string;
  blue(value: string): string;
  magenta(value: string): string;
  brightMagenta(value: string): string;
  yellow(value: string): string;
  red(value: string): string;
  brightRed(value: string): string;
  white(value: string): string;
  brightWhite(value: string): string;
  italic(value: string): string;
  reset: string;
}

export interface TerminalUiStatusLike {
  provider: string;
  model?: string | null;
  permissionMode: string;
  approvalPolicy: string;
  networkMode: string;
  cwd: string;
}

export function buildShellChromeLines(
  ansi: TerminalUiAnsiLike,
  status: TerminalUiStatusLike,
  sessionPath: string,
  options: {
    isTTY?: boolean;
  } = {},
): string[] {
  const isTTY = options.isTTY !== false;
  const repoLabel = path.basename(status.cwd) || status.cwd;
  if (!isTTY) {
    return [
      `MJ Code · ${status.provider}/${status.model ?? "auto"}`,
      `repo=${repoLabel}`,
    ];
  }

  const brandLine = ansi.bold(ansi.brightCyan("◆ MJ Code"));
  const providerLine = ansi.dim(`${status.provider}/${status.model ?? "auto"}`);
  const repoLine = repoLabel;

  return [
    ``,
    `${ansi.brightCyan("┌──────────────────────────────────────────┐")}`,
    `${ansi.brightCyan("│")} ${brandLine} ${ansi.dim("·")} ${providerLine}`,
    `${ansi.brightCyan("│")} ${ansi.dim(`  ${repoLine} · ${status.permissionMode} · net=${status.networkMode}`)}`,
    `${ansi.brightCyan("└──────────────────────────────────────────┘")}`,
    ``,
  ];
}

function formatSessionLabel(sessionPath: string): string {
  const basename = path.basename(sessionPath || "", ".jsonl");
  if (!basename) {
    return "none";
  }
  const isoLikeMatch = basename.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-\d{3})?Z(?:-(.+))?$/);
  if (isoLikeMatch) {
    const [, date, hour, minute, _second, suffix] = isoLikeMatch;
    return `${date} ${hour}:${minute}${suffix ? ` #${suffix.length <= 10 ? suffix : suffix.slice(0, 6)}` : ""}`;
  }
  return basename.length > 28
    ? `${basename.slice(0, 25)}...`
    : basename;
}

export function replaceReadlineLine(
  currentRl: {
    write?: (value: string | null, key?: { ctrl?: boolean; name?: string }) => void;
    line?: string;
    cursor?: number;
    prompt?: (preserveCursor?: boolean) => void;
  } | null | undefined,
  value: string,
  options: {
    prompt?: boolean;
  } = {},
): void {
  if (!currentRl || typeof currentRl.write !== "function") {
    return;
  }
  currentRl.write(null, { ctrl: true, name: "u" });
  if (typeof currentRl.line === "string") {
    currentRl.line = "";
  }
  if (typeof currentRl.cursor === "number") {
    currentRl.cursor = 0;
  }
  if (options.prompt !== false && typeof currentRl.prompt === "function") {
    currentRl.prompt(true);
  }
  currentRl.write(value);
}

export function question(
  rl: { question: (prompt: string, callback: (answer: string) => void) => void },
  prompt: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

export function formatInputPreview(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }

  const preview = Object.entries(input)
    .slice(0, 2)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");

  return preview ? ` (${preview.slice(0, 120)})` : "";
}

export function summarizeResult(result: unknown): string {
  if (result == null) {
    return "ok";
  }

  if (typeof result === "string") {
    return result.length > 100 ? `${result.slice(0, 100)}...` : result;
  }

  if (typeof result === "object") {
    const pairs = Object.entries(result)
      .slice(0, 3)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    return pairs.join(", ");
  }

  return String(result);
}

export function extractFinalContentFromJson(rawText: string): string | null {
  const typeMatch = rawText.match(/"type"\s*:\s*"([^"]*)"/);
  if (!typeMatch || typeMatch[1] !== "final") {
    return null;
  }

  const contentKeyMatch = rawText.match(/"content"\s*:\s*"/);
  if (!contentKeyMatch) {
    return "";
  }

  const startIndex = (contentKeyMatch.index ?? 0) + contentKeyMatch[0].length;
  let decoded = "";
  let escaped = false;

  for (let index = startIndex; index < rawText.length; index += 1) {
    const char = rawText[index];

    if (escaped) {
      decoded += decodeEscapedChar(char, rawText, index);
      if (char === "u") {
        index += 4;
      }
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      return decoded;
    }

    decoded += char;
  }

  return decoded;
}

function decodeEscapedChar(char: string, rawText: string, index: number): string {
  if (char === "n") {
    return "\n";
  }
  if (char === "r") {
    return "\r";
  }
  if (char === "t") {
    return "\t";
  }
  if (char === '"') {
    return '"';
  }
  if (char === "\\") {
    return "\\";
  }
  if (char === "u") {
    const codePoint = rawText.slice(index + 1, index + 5);
    if (/^[0-9a-fA-F]{4}$/.test(codePoint)) {
      return String.fromCharCode(Number.parseInt(codePoint, 16));
    }
    return "";
  }
  return char;
}
