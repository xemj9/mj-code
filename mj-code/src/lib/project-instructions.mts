import fs from "node:fs/promises";
import path from "node:path";

import type {
  InstructionEntry,
  InstructionPackSummary,
  InstructionLayer,
  InstructionPack,
  InstructionRuleEntry,
} from "../types/contracts.js";

interface LoadProjectInstructionsOptions {
  cwd: string;
  userStateDir?: string | null;
}

interface ResolveInstructionFileInput {
  filePath: string;
  allowedRoot: string;
  cwd: string;
  layer: InstructionLayer;
  scope: "user" | "project";
  importedFrom: string | null;
  importDepth: number;
  orderState: {
    value: number;
  };
  chain: string[];
  loadedPaths: Set<string>;
}

interface ParsedInstructionDirectives {
  body: string;
  imports: string[];
  rules: Array<{
    name: string;
    value: string;
  }>;
}

interface SummarizeInstructionPackOptions {
  includeContent?: boolean;
}

const ROOT_INSTRUCTION_CANDIDATES: Array<{
  layer: InstructionLayer;
  scope: "user" | "project";
  relativePath: string[];
}> = [
  {
    layer: "user-global",
    scope: "user",
    relativePath: ["MJ.md"],
  },
  {
    layer: "workspace-root",
    scope: "project",
    relativePath: ["MJ.md"],
  },
  {
    layer: "project-overlay",
    scope: "project",
    relativePath: [".mj-code", "MJ.md"],
  },
  {
    layer: "local-override",
    scope: "project",
    relativePath: [".mj-code", "MJ.local.md"],
  },
];

export async function loadProjectInstructions(
  input: string | LoadProjectInstructionsOptions,
): Promise<InstructionPack> {
  const options = normalizeLoadOptions(input);
  const entries: InstructionEntry[] = [];
  const rules: InstructionRuleEntry[] = [];
  const loadedPaths = new Set<string>();
  const orderState = { value: 0 };

  for (const candidate of ROOT_INSTRUCTION_CANDIDATES) {
    const rootPath =
      candidate.scope === "user"
        ? options.userStateDir
        : options.cwd;
    if (!rootPath) {
      continue;
    }

    const filePath = path.join(rootPath, ...candidate.relativePath);
    const result = await resolveRootInstructionFile({
      filePath,
      allowedRoot: rootPath,
      cwd: options.cwd,
      layer: candidate.layer,
      scope: candidate.scope,
      orderState,
      loadedPaths,
    });
    entries.push(...result.entries);
    rules.push(...result.rules);
  }

  const uniqueFiles = [...loadedPaths];
  const orderedEntries = [...entries].sort((left, right) => left.order - right.order);
  return {
    files: uniqueFiles,
    content: renderInstructionPack(orderedEntries),
    entries: orderedEntries,
    rules: [...rules].sort((left, right) => left.order - right.order),
  };
}

export function summarizeInstructionPack(
  pack: InstructionPack,
  options: SummarizeInstructionPackOptions = {},
): InstructionPackSummary {
  return {
    files: pack.files,
    entryCount: pack.entries.length,
    ruleCount: pack.rules.length,
    entries: pack.entries.map((entry) => ({
      id: entry.id,
      layer: entry.layer,
      order: entry.order,
      scope: entry.scope,
      title: entry.title,
      originPath: entry.originPath,
      relativePath: entry.relativePath,
      sourceQualifiedName: entry.sourceQualifiedName,
      importedFrom: entry.importedFrom,
      importDepth: entry.importDepth,
      imports: entry.importRequests,
      rules: entry.rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        value: rule.value,
      })),
      ...(options.includeContent ? {
        content: entry.content,
        renderedContent: entry.renderedContent,
      } : {}),
    })),
    rules: pack.rules.map((rule) => ({
      id: rule.id,
      layer: rule.layer,
      order: rule.order,
      originPath: rule.originPath,
      importedFrom: rule.importedFrom,
      name: rule.name,
      value: rule.value,
      sourceQualifiedName: rule.sourceQualifiedName,
    })),
    ...(options.includeContent ? {
      content: pack.content,
    } : {}),
  };
}

function normalizeLoadOptions(
  input: string | LoadProjectInstructionsOptions,
): LoadProjectInstructionsOptions {
  if (typeof input === "string") {
    return {
      cwd: path.resolve(input),
      userStateDir: null,
    };
  }

  return {
    cwd: path.resolve(input.cwd),
    userStateDir: input.userStateDir ? path.resolve(input.userStateDir) : null,
  };
}

async function resolveRootInstructionFile(
  input: Omit<ResolveInstructionFileInput, "importedFrom" | "importDepth" | "chain">,
): Promise<{
  entries: InstructionEntry[];
  rules: InstructionRuleEntry[];
}> {
  try {
    await fs.access(input.filePath);
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        entries: [],
        rules: [],
      };
    }
    throw error;
  }

  return resolveInstructionFile({
    ...input,
    importedFrom: null,
    importDepth: 0,
    chain: [],
  });
}

async function resolveInstructionFile(
  input: ResolveInstructionFileInput,
): Promise<{
  entries: InstructionEntry[];
  rules: InstructionRuleEntry[];
}> {
  const normalizedFilePath = path.resolve(input.filePath);
  if (input.chain.includes(normalizedFilePath)) {
    const cycle = [...input.chain, normalizedFilePath]
      .map((entry) => path.basename(entry))
      .join(" -> ");
    throw new Error(`Instruction import cycle detected: ${cycle}`);
  }

  input.loadedPaths.add(normalizedFilePath);
  const rawContent = await fs.readFile(normalizedFilePath, "utf8");
  const parsed = parseInstructionDirectives(rawContent);
  const nextChain = [...input.chain, normalizedFilePath];
  const entries: InstructionEntry[] = [];
  const rules: InstructionRuleEntry[] = [];

  for (const request of parsed.imports) {
    const resolvedImportPath = resolveInstructionImportPath({
      request,
      importerPath: normalizedFilePath,
      allowedRoot: input.allowedRoot,
    });
    const imported = await resolveInstructionFile({
      ...input,
      filePath: resolvedImportPath,
      importedFrom: normalizedFilePath,
      importDepth: input.importDepth + 1,
      chain: nextChain,
    });
    entries.push(...imported.entries);
    rules.push(...imported.rules);
  }

  const entryRules = parsed.rules.map((rule) =>
    createInstructionRuleEntry({
      ...rule,
      filePath: normalizedFilePath,
      rootPath: input.allowedRoot,
      layer: input.layer,
      scope: input.scope,
      importedFrom: input.importedFrom,
      order: input.orderState.value++,
    })
  );
  rules.push(...entryRules);

  const body = parsed.body.trim();
  const renderedContent = renderInstructionEntryContent(body, entryRules);
  if (renderedContent) {
    const relativePath = formatInstructionRelativePath(normalizedFilePath, input);
    const order = input.orderState.value++;
    entries.push({
      id: buildInstructionId(input.layer, order, relativePath),
      layer: input.layer,
      order,
      scope: input.scope,
      title: buildInstructionTitle(input.layer, normalizedFilePath),
      originPath: normalizedFilePath,
      relativePath,
      sourceQualifiedName: `${input.scope}:instruction:${input.layer}:${relativePath}`,
      importedFrom: input.importedFrom,
      importDepth: input.importDepth,
      importRequests: parsed.imports,
      content: body,
      renderedContent,
      rules: entryRules,
    });
  }

  return {
    entries,
    rules,
  };
}

function parseInstructionDirectives(content: string): ParsedInstructionDirectives {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const bodyLines: string[] = [];
  const imports: string[] = [];
  const rules: Array<{ name: string; value: string }> = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      bodyLines.push(line);
      continue;
    }

    if (!inFence) {
      const importMatch = trimmed.match(/^@import\s+(.+)$/);
      if (importMatch) {
        imports.push(importMatch[1].trim());
        continue;
      }

      const ruleMatch = trimmed.match(/^@rule\s+([A-Za-z0-9._-]+)\s*:\s*(.+)$/);
      if (ruleMatch) {
        rules.push({
          name: ruleMatch[1].trim(),
          value: ruleMatch[2].trim(),
        });
        continue;
      }
    }

    bodyLines.push(line);
  }

  return {
    body: bodyLines.join("\n").trim(),
    imports,
    rules,
  };
}

function resolveInstructionImportPath(input: {
  request: string;
  importerPath: string;
  allowedRoot: string;
}): string {
  const raw = `${input.request ?? ""}`.trim();
  if (!raw) {
    throw new Error(`Instruction import in ${input.importerPath} is empty.`);
  }
  if (path.isAbsolute(raw)) {
    throw new Error(`Instruction import "${raw}" must be relative.`);
  }
  if (!raw.startsWith("./") && !raw.startsWith("../")) {
    throw new Error(`Instruction import "${raw}" must start with "./" or "../".`);
  }

  const resolved = path.resolve(path.dirname(input.importerPath), raw);
  if (!isPathInsideRoot(resolved, input.allowedRoot)) {
    throw new Error(
      `Instruction import "${raw}" from ${input.importerPath} escapes the allowed root ${input.allowedRoot}.`,
    );
  }
  return resolved;
}

function renderInstructionEntryContent(
  body: string,
  rules: InstructionRuleEntry[],
): string {
  const sections = [];
  if (body) {
    sections.push(body);
  }
  if (rules.length > 0) {
    sections.push([
      "Rules:",
      ...rules.map((rule) => `- ${rule.name}: ${rule.value}`),
    ].join("\n"));
  }
  return sections.join("\n\n").trim();
}

function renderInstructionPack(entries: InstructionEntry[]): string {
  return entries
    .map((entry) => [
      `Instructions from ${entry.originPath} [${entry.layer}]${entry.importedFrom ? ` imported via ${entry.importedFrom}` : ""}:`,
      entry.renderedContent,
    ].join("\n"))
    .join("\n\n")
    .trim();
}

function createInstructionRuleEntry(input: {
  name: string;
  value: string;
  filePath: string;
  rootPath: string;
  layer: InstructionLayer;
  scope: "user" | "project";
  importedFrom: string | null;
  order: number;
}): InstructionRuleEntry {
  const relativePath = formatRelativePathForRule(input.filePath, input.rootPath);
  return {
    id: `rule:${input.layer}:${input.order}:${input.name}`,
    name: input.name,
    value: input.value,
    layer: input.layer,
    order: input.order,
    originPath: input.filePath,
    sourceQualifiedName: `${input.scope}:rule:${input.layer}:${relativePath}:${input.name}`,
    importedFrom: input.importedFrom,
  };
}

function formatInstructionRelativePath(
  filePath: string,
  input: Pick<ResolveInstructionFileInput, "cwd" | "allowedRoot" | "scope">,
): string {
  if (input.scope === "user") {
    return normalizeRelativePath(path.relative(input.allowedRoot, filePath) || "MJ.md");
  }
  return normalizeRelativePath(path.relative(input.cwd, filePath) || "MJ.md");
}

function formatRelativePathForRule(
  filePath: string,
  rootPath: string,
): string {
  return normalizeRelativePath(path.relative(rootPath, filePath) || "MJ.md");
}

function buildInstructionId(
  layer: InstructionLayer,
  order: number,
  relativePath: string,
): string {
  return `instruction:${layer}:${String(order).padStart(4, "0")}:${relativePath}`;
}

function buildInstructionTitle(layer: InstructionLayer, filePath: string): string {
  return `${layer}: ${path.basename(filePath)}`;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
