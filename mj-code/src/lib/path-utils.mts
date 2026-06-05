import path from "node:path";

export function resolveUserPath(targetPath: string, cwd: string): string {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error("Expected a non-empty path string.");
  }

  return path.normalize(
    path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath),
  );
}

export function isSubPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function abbreviate(text: unknown, maxChars: number = 8000): string {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (value.length <= maxChars) {
    return value;
  }

  const remaining = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...<truncated ${remaining} chars>`;
}

export function appendLimited(existing: string, chunk: string, maxChars: number): string {
  const next = `${existing}${chunk}`;
  if (next.length <= maxChars) {
    return next;
  }

  return next.slice(0, maxChars);
}
