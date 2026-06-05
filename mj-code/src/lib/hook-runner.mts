import fs from "node:fs/promises";
import path from "node:path";

import type { LoadedConfig } from "../config.mjs";
import { createChangeSet, summarizeChangeSet } from "./change-set.mjs";
import { summarizeBoundaryDecision } from "./execution-boundary.mjs";
import { resolveUserPath } from "./path-utils.mjs";

import type {
  ChangeSetRecord,
  ExecutionBoundaryDecision,
  HookDefinition,
  HookDefinitionInput,
  HookEmitResult,
  HookEventName,
  HookFileSnapshot,
  HookFilters,
  HookInjectedContext,
  HookParsedOutput,
  HookRunResult,
  HookShellResultSummary,
} from "../types/contracts.js";

const SUPPORTED_HOOK_EVENTS = new Set<HookEventName>([
  "session_start",
  "user_prompt_submit",
  "before_tool",
  "after_tool",
  "before_apply",
  "after_apply",
  "pre_compact",
  "session_end",
  "error",
]);

const SUPPORTED_FAIL_MODES = new Set(["open", "closed"]);

type HookRunnerConfig = Pick<LoadedConfig, "cwd" | "hooks" | "hookTimeoutMs" | "projectStateDir">;
type HookEvent = Record<string, unknown>;
type HookEventHandler = (event: HookEvent) => Promise<void> | void;

interface HookRunnerOptions {
  shellRuntime: ShellRuntimeLike;
  executionBoundary: ExecutionBoundaryLike;
  onEvent?: HookEventHandler | null;
}

interface HookRunnerContext {
  traceId?: string | null;
  step?: string | number | null;
  sessionId?: string | null;
  parentSessionId?: string | null;
  rootSessionId?: string | null;
  observePaths?: string[];
}

interface ShellRunResultLike {
  jobId?: string;
  status: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  durationMs?: number | null;
  stdout?: string;
  stderr?: string;
}

interface ShellRuntimeLike {
  run(
    input: Record<string, unknown>,
    executionContext?: Record<string, unknown>,
  ): Promise<ShellRunResultLike>;
}

interface ExecutionBoundaryLike {
  evaluateHook(input: {
    hook: HookDefinition;
    payload: Record<string, unknown>;
    traceId?: string | null;
    step?: string | number | null;
  }): ExecutionBoundaryDecision;
}

interface NormalizeHookContext {
  index: number;
  scope: string;
  sourcePath: string;
  cwd: string;
  defaultTimeoutMs: number;
}

interface HookFileSource {
  hooks?: HookDefinitionInput[];
}

interface ObservedHookChangeSet extends ChangeSetRecord {
  origin: "hook_apply";
}

export class HookRunner {
  readonly config: HookRunnerConfig;
  readonly shellRuntime: ShellRuntimeLike;
  readonly executionBoundary: ExecutionBoundaryLike;
  readonly onEvent: HookEventHandler | null;
  hooks: HookDefinition[];

  constructor(config: HookRunnerConfig, options: HookRunnerOptions) {
    this.config = config;
    this.shellRuntime = options.shellRuntime;
    this.executionBoundary = options.executionBoundary;
    this.onEvent = options.onEvent ?? null;
    this.hooks = [];
  }

  async initialize(): Promise<void> {
    this.hooks = await loadHooks(this.config);
  }

  listHooks(): HookDefinition[] {
    return this.hooks.map((hook) => ({
      id: hook.id,
      event: hook.event,
      enabled: hook.enabled,
      command: hook.command,
      args: hook.args,
      cwd: hook.cwd,
      timeoutMs: hook.timeoutMs,
      failMode: hook.failMode,
      filters: hook.filters,
      scope: hook.scope,
      sourcePath: hook.sourcePath,
    }));
  }

  async emit(
    eventName: HookEventName,
    payload: Record<string, unknown> = {},
    context: HookRunnerContext = {},
  ): Promise<HookEmitResult> {
    const matchingHooks = this.hooks.filter(
      (hook) => hook.enabled && hook.event === eventName && matchesHookFilters(hook, payload),
    );
    if (matchingHooks.length === 0) {
      return {
        event: eventName,
        matched: 0,
        blocked: false,
        results: [],
      };
    }

    const results: HookRunResult[] = [];
    let blocked = false;
    let blockReason: string | null = null;

    for (const hook of matchingHooks) {
      const result = await this.runHook(hook, payload, context);
      results.push(result);
      if (result.blocked && !blocked) {
        blocked = true;
        blockReason = result.blockReason;
      }
    }

    return {
      event: eventName,
      matched: matchingHooks.length,
      blocked,
      blockReason,
      results,
      advisories: results.map((entry) => entry.advisory).filter((entry): entry is string => Boolean(entry)),
      observedChangeSets: results
        .map((entry) => entry.observedChangeSet)
        .filter((entry): entry is NonNullable<HookRunResult["observedChangeSet"]> => entry != null),
      injectedContexts: results
        .map((entry) => entry.injectedContext)
        .filter((entry): entry is HookInjectedContext => entry != null),
    };
  }

  async runHook(
    hook: HookDefinition,
    payload: Record<string, unknown>,
    context: HookRunnerContext,
  ): Promise<HookRunResult> {
    const startedAt = Date.now();
    const boundaryDecision = this.executionBoundary.evaluateHook({
      hook,
      payload,
      traceId: context.traceId ?? null,
      step: context.step ?? null,
    });
    await this.emitEvent({
      type: "execution_boundary_decision",
      traceId: context.traceId ?? null,
      step: context.step ?? null,
      source: "hook",
      boundary: boundaryDecision.event,
    });

    if (boundaryDecision.blocked) {
      const result: HookRunResult = {
        hookId: hook.id,
        event: hook.event,
        status: "blocked",
        success: false,
        blocked: true,
        blockReason: boundaryDecision.reasons[0] ?? `Hook "${hook.id}" was blocked by the execution boundary.`,
        durationMs: Date.now() - startedAt,
        failMode: hook.failMode,
        advisory: null,
        traceMeta: null,
        boundary: summarizeBoundaryDecision(boundaryDecision),
        shellResult: null,
        observedChangeSet: null,
        injectedContext: null,
        rawObservedChangeSet: null,
      };
      await this.emitEvent({
        type: "hook_event",
        event: hook.event,
        hookId: hook.id,
        status: result.status,
        success: result.success,
        blocked: true,
        blockReason: result.blockReason,
        durationMs: result.durationMs,
        boundary: result.boundary,
        injectedContext: null,
      });
      return result;
    }

    const observedBefore = context.observePaths?.length
      ? await snapshotFiles(context.observePaths, this.config.cwd)
      : null;

    let shellResult: ShellRunResultLike | null = null;
    let shellError: Error | null = null;
    try {
      shellResult = await this.shellRuntime.run(boundaryDecision.effectiveInput as Record<string, unknown>, {
        traceId: context.traceId ?? null,
        step: context.step ?? null,
        sessionId: context.sessionId ?? null,
        parentSessionId: context.parentSessionId ?? null,
        rootSessionId: context.rootSessionId ?? null,
        sourceKind: "hook",
        hookId: hook.id,
        hookEvent: hook.event,
      });
    } catch (error) {
      shellError = error instanceof Error ? error : new Error(`${error ?? "Unknown hook execution error"}`);
    }

    const parsedOutput = parseHookOutput(shellResult?.stdout, shellResult?.stderr);
    const failed = shellError != null || shellResult?.status !== "exited";
    const blocked =
      Boolean(parsedOutput.block) ||
      (failed && hook.failMode === "closed" && isBlockingHookEvent(hook.event));
    const blockReason =
      parsedOutput.reason ??
      (failed && hook.failMode === "closed" ? `Hook "${hook.id}" failed in closed mode.` : null);
    const observedChangeSet = observedBefore
      ? await detectObservedChangeSet({
          before: observedBefore,
          watchPaths: context.observePaths ?? [],
          cwd: this.config.cwd,
          eventName: hook.event,
          hookId: hook.id,
        })
      : null;
    const injectedContext = !blocked
      ? buildInjectedContext(hook.event, parsedOutput)
      : null;

    const result: HookRunResult = {
      hookId: hook.id,
      event: hook.event,
      status: blocked ? "blocked" : failed ? "failed" : "exited",
      success: !failed,
      blocked,
      blockReason,
      failMode: hook.failMode,
      durationMs: Date.now() - startedAt,
      advisory: parsedOutput.advisory ?? null,
      traceMeta: parsedOutput.trace ?? null,
      boundary: summarizeBoundaryDecision(boundaryDecision),
      shellResult: shellResult
        ? summarizeHookShellResult(shellResult)
        : shellError
          ? {
              status: "failed",
              error: {
                message: shellError.message,
                taxonomy: (shellError as Error & { taxonomy?: string }).taxonomy ?? "shell_error",
              },
            }
          : null,
      observedChangeSet: observedChangeSet ? summarizeChangeSet(observedChangeSet) : null,
      injectedContext,
      rawObservedChangeSet: observedChangeSet,
    };

    await this.emitEvent({
      type: "hook_event",
      event: hook.event,
      hookId: hook.id,
      status: result.status,
      success: result.success,
      blocked: result.blocked,
      blockReason: result.blockReason,
      advisory: result.advisory,
      traceMeta: result.traceMeta,
      durationMs: result.durationMs,
      failMode: hook.failMode,
      boundary: result.boundary,
      shellResult: result.shellResult,
      observedChangeSet: result.observedChangeSet,
      injectedContext: result.injectedContext,
    });

    return result;
  }

  async emitEvent(event: HookEvent): Promise<void> {
    if (typeof this.onEvent === "function") {
      await this.onEvent(event);
    }
  }
}

export async function loadHooks(config: HookRunnerConfig): Promise<HookDefinition[]> {
  const sources: Array<{
    hooks?: HookDefinitionInput[];
    scope: string;
    sourcePath: string;
  }> = [];

  if (Array.isArray(config.hooks)) {
    sources.push({
      hooks: config.hooks as HookDefinitionInput[],
      scope: "config",
      sourcePath: "config.hooks",
    });
  }

  const hookFilePath = path.join(config.projectStateDir, "hooks.json");
  const hookFile = await readHookFile(hookFilePath);
  if (hookFile) {
    sources.push({
      hooks: Array.isArray(hookFile) ? hookFile : hookFile.hooks,
      scope: "project",
      sourcePath: hookFilePath,
    });
  }

  const byId = new Map<string, HookDefinition>();
  for (const source of sources) {
    for (const [index, definition] of (source.hooks ?? []).entries()) {
      const hook = normalizeHook(definition, {
        index,
        scope: source.scope,
        sourcePath: source.sourcePath,
        cwd: config.cwd,
        defaultTimeoutMs: config.hookTimeoutMs,
      });
      if (!hook) {
        continue;
      }
      byId.set(hook.id, hook);
    }
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function readHookFile(
  filePath: string,
): Promise<HookDefinitionInput[] | HookFileSource | null> {
  const contents = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!contents) {
    return null;
  }
  return JSON.parse(contents) as HookDefinitionInput[] | HookFileSource;
}

function normalizeHook(
  definition: HookDefinitionInput,
  context: NormalizeHookContext,
): HookDefinition | null {
  if (!definition || typeof definition !== "object") {
    return null;
  }
  const event = `${definition.event ?? ""}`.trim();
  const command = `${definition.command ?? ""}`.trim();
  if (!SUPPORTED_HOOK_EVENTS.has(event as HookEventName) || !command) {
    return null;
  }

  const id = `${definition.id ?? `${event}-${context.index + 1}`}`.trim();
  const failMode = SUPPORTED_FAIL_MODES.has(`${definition.failMode ?? ""}`)
    ? `${definition.failMode}` as HookDefinition["failMode"]
    : "open";

  return {
    id,
    event: event as HookEventName,
    enabled: definition.enabled !== false,
    command,
    args: Array.isArray(definition.args)
      ? definition.args.map((entry) => `${entry ?? ""}`).filter(Boolean)
      : [],
    cwd: definition.cwd ? resolveUserPath(definition.cwd, context.cwd) : context.cwd,
    timeoutMs: normalizeTimeout(definition.timeoutMs, context.defaultTimeoutMs),
    failMode,
    filters: normalizeHookFilters(definition.filters),
    scope: context.scope,
    sourcePath: context.sourcePath,
  };
}

function normalizeHookFilters(filters: unknown): HookFilters {
  if (!filters || typeof filters !== "object") {
    return {
      toolName: null,
      category: null,
      success: null,
      writeOnly: null,
    };
  }

  const typedFilters = filters as Record<string, unknown>;
  return {
    toolName: normalizeStringOrArray(typedFilters.toolName),
    category: normalizeStringOrArray(typedFilters.category),
    success: typeof typedFilters.success === "boolean" ? typedFilters.success : null,
    writeOnly: typeof typedFilters.writeOnly === "boolean" ? typedFilters.writeOnly : null,
  };
}

function normalizeStringOrArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => `${entry ?? ""}`.trim()).filter(Boolean);
  }
  return null;
}

export function matchesHookFilters(hook: HookDefinition, payload: Record<string, unknown>): boolean {
  const filters = hook.filters;
  if (filters.toolName?.length && !filters.toolName.includes(`${payload.toolName ?? ""}`)) {
    return false;
  }
  if (filters.category?.length && !filters.category.includes(`${payload.category ?? ""}`)) {
    return false;
  }
  if (typeof filters.success === "boolean" && Boolean(payload.success) !== filters.success) {
    return false;
  }
  if (typeof filters.writeOnly === "boolean") {
    const writeLike = Boolean(payload.changeSet || ["write", "apply"].includes(`${payload.category ?? ""}`));
    if (writeLike !== filters.writeOnly) {
      return false;
    }
  }
  return true;
}

export function parseHookOutput(stdout = "", stderr = ""): HookParsedOutput {
  const trimmed = `${stdout ?? ""}`.trim();
  if (!trimmed) {
    return {
      advisory: stderr?.trim() ? stderr.trim() : null,
      trace: null,
      block: false,
      reason: null,
      additionalContext: null,
      startupContext: null,
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      advisory:
        typeof parsed.advisory === "string"
          ? parsed.advisory
          : typeof parsed.message === "string"
            ? parsed.message
            : null,
      trace: isRecord(parsed.trace)
        ? parsed.trace
        : isRecord(parsed.traceMeta)
          ? parsed.traceMeta
          : null,
      block: parsed.block === true || parsed.allow === false,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      additionalContext:
        typeof parsed.additionalContext === "string"
          ? parsed.additionalContext
          : typeof parsed.additional_context === "string"
            ? parsed.additional_context
            : typeof parsed.context === "string"
              ? parsed.context
              : null,
      startupContext:
        typeof parsed.startupContext === "string"
          ? parsed.startupContext
          : typeof parsed.startup_context === "string"
            ? parsed.startup_context
            : null,
    };
  } catch {
    return {
      advisory: trimmed,
      trace: null,
      block: false,
      reason: null,
      additionalContext: null,
      startupContext: null,
    };
  }
}

function summarizeHookShellResult(result: ShellRunResultLike): HookShellResultSummary {
  return {
    jobId: result.jobId,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function snapshotFiles(filePaths: string[], cwd: string): Promise<HookFileSnapshot[]> {
  const entries: HookFileSnapshot[] = [];
  for (const filePath of filePaths ?? []) {
    const absolutePath = resolveUserPath(filePath, cwd);
    const content = await fs.readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    entries.push({
      path: absolutePath,
      content,
    });
  }
  return entries;
}

async function detectObservedChangeSet({
  before,
  watchPaths,
  cwd,
  eventName,
  hookId,
}: {
  before: HookFileSnapshot[];
  watchPaths: string[];
  cwd: string;
  eventName: HookEventName;
  hookId: string;
}): Promise<ObservedHookChangeSet | null> {
  const fileChanges: Array<{
    operation: "add" | "delete" | "update";
    path: string;
    previousPath: null;
    beforeContent: string | null;
    afterContent: string | null;
    touchedFiles: string[];
  }> = [];
  for (const previous of before) {
    const nextContent = await fs.readFile(previous.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (nextContent === previous.content) {
      continue;
    }
    fileChanges.push({
      operation:
        previous.content == null && nextContent != null
          ? "add"
          : previous.content != null && nextContent == null
            ? "delete"
            : "update",
      path: previous.path,
      previousPath: null,
      beforeContent: previous.content,
      afterContent: nextContent,
      touchedFiles: [previous.path],
    });
  }

  if (fileChanges.length === 0) {
    return null;
  }

  const changeSet = await createChangeSet({
    toolName: `hook:${eventName}`,
    cwd,
    fileChanges,
    input: {
      hookId,
      watchPaths,
    },
    impactOptions: {},
  });
  return {
    ...changeSet,
    origin: "hook_apply",
  };
}

function isBlockingHookEvent(eventName: HookEventName): boolean {
  return ["before_tool", "before_apply", "user_prompt_submit"].includes(eventName);
}

function normalizeTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildInjectedContext(
  eventName: HookEventName,
  parsedOutput: HookParsedOutput,
): HookInjectedContext | null {
  if (eventName === "session_start" && parsedOutput.startupContext) {
    return {
      scope: "session",
      label: "startup_context",
      content: parsedOutput.startupContext,
    };
  }
  if (eventName === "user_prompt_submit" && parsedOutput.additionalContext) {
    return {
      scope: "turn",
      label: "additional_context",
      content: parsedOutput.additionalContext,
    };
  }
  return null;
}
