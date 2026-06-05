import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import ts from "typescript";

import { summarizeText } from "./agent-utils.mjs";
import { createUnavailableCodeActionCollection } from "./code-action-assist.mjs";

import type {
  CodeActionCollection,
  ChangeSetRecord,
  DiagnosticCollectionResult,
  DiagnosticDeltaSummary,
  DiagnosticFingerprint,
  DiagnosticProjectContext,
  DiagnosticSnapshotSummary,
  DiagnosticRecord,
  DiagnosticProvider,
  ExecutionPlan,
  ExecutionJournalRecordPhaseInput,
  FixHintCollection,
  JsonObject,
  ProjectContextCollection,
  ShellBackgroundStartResult,
  ShellRunResult,
  VerificationPlan,
  VerificationPlanCheck,
  VerifierCheckResult,
  VerifierCommandSpec,
  VerifierFailureCategory,
  VerifierFinding,
  VerifierRunRecord,
  VerifierRunSummary,
  VerifierSeverity,
  VerifierStatus,
} from "../types/contracts.js";
import type {
  ShellExecutionContext,
  ShellRunInput,
} from "./shell-runtime-support.mjs";

const execFileAsync = promisify(execFile);
const VERIFY_COMMAND_PATTERN = /\b(test|lint|check|build|verify)\b/i;
const SUPPORTED_DIAGNOSTIC_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const MAX_DIAGNOSTIC_TARGETS = 16;

type ToolEventRecord = Record<string, unknown>;

interface ShellRuntimeLike {
  run(
    input: ShellRunInput,
    executionContext?: ShellExecutionContext,
  ): Promise<ShellRunResult | ShellBackgroundStartResult>;
}

interface SessionStoreLike {
  append(type: string, payload?: unknown): Promise<unknown>;
}

interface DiagnosticIdentityLike {
  path?: string | null;
  line?: number | null;
  column?: number | null;
  code?: string | null;
  message: string;
  source?: string | null;
  scope?: string | null;
  category?: string | null;
  rule?: string | null;
}

interface ExecutionJournalLike {
  append(entry: {
    type: string;
    traceId?: string | null;
    stepId?: string | number | null;
    phase?: string;
    payload?: unknown;
  }): Promise<void>;
  recordPhase(entry: ExecutionJournalRecordPhaseInput): Promise<void>;
}

export interface VerifierTurnState {
  traceId: string;
  filesChanged: Set<string> | string[];
  toolEvents: ToolEventRecord[];
  executionPlan: ExecutionPlan | null;
}

export interface PostEditVerifierDependencies {
  cwd: string;
  shellRuntime: ShellRuntimeLike;
  sessionStore?: SessionStoreLike | null;
  executionJournal?: ExecutionJournalLike | null;
  captureStateSnapshot?(input: {
    traceId: string | null;
    phase: string;
    stepId: string | number;
    outputSummary: string;
  }): Promise<unknown>;
  diagnosticProvider?: DiagnosticProvider | null;
}

export interface PostEditVerifierInput {
  turnState: VerifierTurnState;
  step: string | number;
  lastChangeSet?: ChangeSetRecord | null;
}

export function shouldRunVerifier(input: {
  filesChanged: Set<string> | string[];
  executionPlan: ExecutionPlan | null;
}): boolean {
  return buildVerificationPlan({
    filesChanged: input.filesChanged,
    executionPlan: input.executionPlan,
    toolEvents: [],
    cwd: "",
    lastChangeSet: null,
  }).required;
}

export function buildVerificationPlan(input: {
  cwd: string;
  filesChanged: Set<string> | string[];
  toolEvents: ToolEventRecord[];
  executionPlan: ExecutionPlan | null;
  lastChangeSet?: ChangeSetRecord | null;
}): VerificationPlan {
  const filesChanged = normalizeFiles(input.filesChanged);
  const diagnosticTargets = collectDiagnosticTargets({
    cwd: input.cwd,
    filesChanged,
    lastChangeSet: input.lastChangeSet ?? null,
  });
  const explicitCommands = collectExplicitVerifierCommands(input.toolEvents, input.cwd);
  const targetedCommand = explicitCommands.length === 0
    ? deriveTargetedCommand(input.cwd, input.lastChangeSet ?? null)
    : null;
  const hasVerifyStep = planHasVerifyStep(input.executionPlan);
  const verificationBias = Boolean(input.executionPlan?.verificationBias);

  const checks: VerificationPlanCheck[] = [
    ...filesChanged.map((filePath) => ({
      id: createCheckId("file_parse", filePath),
      kind: "file_parse" as const,
      label: `Parse ${path.basename(filePath)}`,
      filePath,
      reason: "Validate changed-file syntax before final success.",
    })),
    ...(diagnosticTargets.length > 0
      ? [{
          id: createCheckId("diagnostics", diagnosticTargets.join("|")),
          kind: "diagnostics" as const,
          label: "Collect diagnostics",
          paths: diagnosticTargets,
          reason: "Collect project-aware diagnostics for changed and related TypeScript/JavaScript files.",
        }]
      : []),
    ...explicitCommands.map((command) => ({
      id: command.id,
      kind: "command" as const,
      label: `Reuse verify command: ${command.command}`,
      command,
      reason: command.reason ?? "Reuse the explicit verify command already executed during this turn.",
    })),
    ...(targetedCommand
      ? [{
          id: targetedCommand.id,
          kind: "targeted_command" as const,
          label: `Run targeted verifier: ${targetedCommand.command}`,
          command: targetedCommand,
          reason: targetedCommand.reason ?? "Run the most relevant targeted test command for the changed files.",
        }]
      : []),
  ];

  if (filesChanged.length > 0) {
    return {
      required: true,
      trigger: "files_changed",
      reason: `Verifier required because this turn changed ${filesChanged.length} file(s).`,
      checks,
    };
  }

  if (explicitCommands.length > 0) {
    return {
      required: true,
      trigger: "explicit_command",
      reason: "Verifier required because this turn already executed explicit verification command(s).",
      checks,
    };
  }

  if (hasVerifyStep) {
    return {
      required: true,
      trigger: "plan_verify",
      reason: "Verifier required because the execution plan contains a verify step.",
      checks,
    };
  }

  if (verificationBias) {
    return {
      required: true,
      trigger: "verification_bias",
      reason: "Verifier required because the execution plan is verification-biased.",
      checks,
    };
  }

  return {
    required: false,
    trigger: "none",
    reason: "No changed files and no verification-biased plan were present.",
    checks: [],
  };
}

export async function runChangedFileParseVerifier(
  filePath: string,
  cwd: string,
): Promise<VerifierCheckResult> {
  const startedAt = Date.now();
  const label = `Parse ${path.basename(filePath)}`;
  const relativePath = toDisplayPath(filePath, cwd);

  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return createSkippedCheck({
        id: createCheckId("file_parse", filePath),
        label,
        filePath,
        category: "unsupported_file",
        summary: `${relativePath} no longer exists after the edit and was skipped.`,
        durationMs: Date.now() - startedAt,
      });
    }
    return createFailedCheck({
      id: createCheckId("file_parse", filePath),
      kind: "file_parse",
      label,
      filePath,
      category: "internal_error",
      summary: `Could not read ${relativePath}: ${toErrorMessage(error)}`,
      durationMs: Date.now() - startedAt,
      findings: [
        createFinding({
          kind: "file_parse",
          status: "failed",
          severity: "error",
          category: "internal_error",
          path: filePath,
          message: `Could not read file: ${toErrorMessage(error)}`,
        }),
      ],
    });
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") {
    return verifyJsonFile(filePath, contents, startedAt);
  }
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return verifyNodeSyntaxFile(filePath, startedAt);
  }
  if ([".ts", ".mts", ".cts", ".tsx"].includes(extension)) {
    return verifyTypeScriptSyntaxFile(filePath, contents, startedAt);
  }

  return createSkippedCheck({
    id: createCheckId("file_parse", filePath),
    label,
    filePath,
    category: "unsupported_file",
    summary: `${relativePath} uses an unsupported verifier extension and was skipped.`,
    durationMs: Date.now() - startedAt,
  });
}

export async function runCommandVerifier(
  dependencies: Pick<PostEditVerifierDependencies, "shellRuntime" | "cwd">,
  command: VerifierCommandSpec,
  executionContext: ShellExecutionContext = {},
): Promise<VerifierCheckResult> {
  const startedAt = Date.now();
  try {
    const result = await dependencies.shellRuntime.run({
      command: command.command,
      cwd: command.cwd || dependencies.cwd,
      background: false,
      stream: false,
      pty: false,
    }, executionContext);
    if (isBackgroundStartResult(result)) {
      return createSkippedCheck({
        id: command.id,
        label: `Run ${command.command}`,
        filePath: null,
        category: "unavailable",
        summary: `Verifier command "${command.command}" started in the background and was skipped.`,
        durationMs: Date.now() - startedAt,
        kind: "targeted_command",
        command,
      });
    }
    return buildCommandResult(command, result, Date.now() - startedAt, "targeted_command");
  } catch (error) {
    const category = classifyCommandFailure(error);
    return createFailedCheck({
      id: command.id,
      kind: "targeted_command",
      label: `Run ${command.command}`,
      command,
      category,
      summary: `Verifier command "${command.command}" failed to start: ${toErrorMessage(error)}`,
      durationMs: Date.now() - startedAt,
      findings: [
        createFinding({
          kind: "targeted_command",
          status: "failed",
          severity: "error",
          category,
          message: toErrorMessage(error),
          meta: toJsonObject({
            command: command.command,
            cwd: command.cwd,
          }),
        }),
      ],
    });
  }
}

export async function runPostEditVerifier(
  dependencies: PostEditVerifierDependencies,
  input: PostEditVerifierInput,
): Promise<VerifierRunRecord> {
  const startedAt = new Date().toISOString();
  const plan = buildVerificationPlan({
    cwd: dependencies.cwd,
    filesChanged: input.turnState.filesChanged,
    toolEvents: input.turnState.toolEvents,
    executionPlan: input.turnState.executionPlan,
    lastChangeSet: input.lastChangeSet ?? null,
  });
  const runStartedAt = Date.now();

  if (!plan.required) {
    return {
      traceId: input.turnState.traceId,
      step: input.step,
      startedAt,
      finishedAt: new Date().toISOString(),
      plan,
      checks: [],
      summary: {
        status: "skipped",
        passed: true,
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: 0,
        skippedChecks: 0,
        findings: 0,
        failureCategories: [],
        summary: "Verifier skipped because no explicit checks were available.",
        durationMs: Date.now() - runStartedAt,
      },
    };
  }

  if (plan.checks.length === 0) {
    const run: VerifierRunRecord = {
      traceId: input.turnState.traceId,
      step: input.step,
      startedAt,
      finishedAt: new Date().toISOString(),
      plan,
      checks: [],
      summary: {
        status: "skipped",
        passed: true,
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: 0,
        skippedChecks: 0,
        findings: 0,
        failureCategories: [],
        summary: "Verifier ran but no explicit checks were available.",
        durationMs: Date.now() - runStartedAt,
      },
    };
    await persistVerifierRun(dependencies, input, run);
    return run;
  }

  const explicitResults = indexExplicitShellResults(input.turnState.toolEvents);
  const checks: VerifierCheckResult[] = [];
  const parseFailedPaths = new Set<string>();
  for (const check of plan.checks) {
    if (check.kind === "file_parse" && check.filePath) {
      const parseResult = await runChangedFileParseVerifier(check.filePath, dependencies.cwd);
      checks.push(parseResult);
      if (parseResult.status === "failed") {
        parseFailedPaths.add(normalizeVerifierPath(check.filePath));
      }
      continue;
    }

    if (check.kind === "diagnostics") {
      checks.push(await runDiagnosticsVerifier({
        check,
        cwd: dependencies.cwd,
        diagnosticProvider: dependencies.diagnosticProvider ?? null,
        parseFailedPaths,
      }));
      continue;
    }

    if (!check.command) {
      checks.push(createSkippedCheck({
        id: check.id,
        label: check.label,
        summary: `${check.label} was skipped because no command was available.`,
        durationMs: 0,
        category: "unavailable",
        kind: check.kind,
      }));
      continue;
    }

    if (check.command.source === "tool_execution") {
      const shellResult = explicitResults.get(check.command.command);
      if (!shellResult) {
        checks.push(createSkippedCheck({
          id: check.id,
          label: check.label,
          summary: `Verifier command "${check.command.command}" could not be replayed from tool execution and was skipped.`,
          durationMs: 0,
          category: "unavailable",
          kind: "command",
          command: check.command,
        }));
        continue;
      }
      checks.push(buildCommandResult(check.command, shellResult, 0, "command"));
      continue;
    }

    checks.push(await runCommandVerifier(dependencies, check.command, {
      traceId: input.turnState.traceId,
      step: input.step,
    }));
  }

  const summary = summarizeVerifierRun(checks, Date.now() - runStartedAt);
  const run: VerifierRunRecord = {
    traceId: input.turnState.traceId,
    step: input.step,
    startedAt,
    finishedAt: new Date().toISOString(),
    plan,
    checks,
    summary,
  };

  await persistVerifierRun(dependencies, input, run);
  return run;
}

function verifyJsonFile(filePath: string, contents: string, startedAt: number): VerifierCheckResult {
  try {
    JSON.parse(contents);
    return createPassedCheck({
      id: createCheckId("file_parse", filePath),
      kind: "file_parse",
      label: `Parse ${path.basename(filePath)}`,
      filePath,
      summary: `${filePath} parsed as JSON successfully.`,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return createFailedCheck({
      id: createCheckId("file_parse", filePath),
      kind: "file_parse",
      label: `Parse ${path.basename(filePath)}`,
      filePath,
      category: "syntax_error",
      summary: `${filePath} contains invalid JSON.`,
      durationMs: Date.now() - startedAt,
      findings: [
        createFinding({
          kind: "file_parse",
          status: "failed",
          severity: "error",
          category: "syntax_error",
          path: filePath,
          message: toErrorMessage(error),
        }),
      ],
    });
  }
}

async function verifyNodeSyntaxFile(filePath: string, startedAt: number): Promise<VerifierCheckResult> {
  try {
    await execFileAsync(process.execPath, ["--check", filePath], {
      cwd: path.dirname(filePath),
      maxBuffer: 1024 * 1024,
    });
    return createPassedCheck({
      id: createCheckId("file_parse", filePath),
      kind: "file_parse",
      label: `Parse ${path.basename(filePath)}`,
      filePath,
      summary: `${filePath} passed node --check.`,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const stderr = extractExecStderr(error);
    return createFailedCheck({
      id: createCheckId("file_parse", filePath),
      kind: "file_parse",
      label: `Parse ${path.basename(filePath)}`,
      filePath,
      category: "syntax_error",
      summary: `${filePath} failed node --check.`,
      durationMs: Date.now() - startedAt,
      findings: [
        createFinding({
          kind: "file_parse",
          status: "failed",
          severity: "error",
          category: "syntax_error",
          path: filePath,
          message: summarizeText(stderr || toErrorMessage(error), 220),
        }),
      ],
      stderrSummary: summarizeText(stderr, 240) || null,
    });
  }
}

async function runDiagnosticsVerifier(input: {
  check: VerificationPlanCheck;
  cwd: string;
  diagnosticProvider: DiagnosticProvider | null;
  parseFailedPaths: Set<string>;
}): Promise<VerifierCheckResult> {
  const startedAt = Date.now();
  const targetPaths = normalizeDiagnosticCheckPaths(input.check.paths, input.cwd);
  const eligiblePaths = targetPaths.filter((filePath) =>
    !input.parseFailedPaths.has(normalizeVerifierPath(filePath))
  );
  const skippedForParse = targetPaths
    .filter((filePath) => input.parseFailedPaths.has(normalizeVerifierPath(filePath)))
    .map((filePath) => ({
      path: filePath,
      reason: "Skipped because parse verification already failed for this file.",
    }));

  if (!input.diagnosticProvider) {
    return createUnavailableCheck({
      id: input.check.id,
      kind: "diagnostics",
      label: input.check.label,
      summary: "Diagnostic provider is not configured for this verifier run.",
      durationMs: Date.now() - startedAt,
      category: "unavailable",
      fixHints: createUnavailableFixHints({
        reason: "Fix hints are unavailable because no diagnostics provider was configured for this verifier run.",
        transportAvailable: false,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      projectContext: createUnavailableProjectContext({
        reason: "Project context is unavailable because no diagnostics provider was configured for this verifier run.",
        transportAvailable: false,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      metadata: toJsonObject({
        providerAvailable: false,
        provider: null,
        mode: "unavailable",
        engine: null,
        fallbackUsed: false,
        fallbackReason: null,
        transportAvailable: false,
        fixHintSummary: createUnavailableFixHints({
          reason: "Fix hints are unavailable because no diagnostics provider was configured for this verifier run.",
          transportAvailable: false,
          fallbackUsed: false,
          fallbackReason: null,
        }).summary,
        projectContextSummary: createUnavailableProjectContext({
          reason: "Project context is unavailable because no diagnostics provider was configured for this verifier run.",
          transportAvailable: false,
          fallbackUsed: false,
          fallbackReason: null,
        }).summary,
        targetCount: targetPaths.length,
        processedPaths: [],
        skippedPaths: skippedForParse,
      }),
    });
  }

  if (!input.diagnosticProvider.available) {
    return createUnavailableCheck({
      id: input.check.id,
      kind: "diagnostics",
      label: input.check.label,
      summary: `${input.diagnosticProvider.provider} diagnostics are currently unavailable.`,
      durationMs: Date.now() - startedAt,
      category: "unavailable",
      fixHints: createUnavailableFixHints({
        reason: `${input.diagnosticProvider.provider} fix hints are unavailable because diagnostics are currently unavailable.`,
        transportAvailable: false,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      projectContext: createUnavailableProjectContext({
        reason: `${input.diagnosticProvider.provider} project context is unavailable because diagnostics are currently unavailable.`,
        transportAvailable: false,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      metadata: toJsonObject({
        providerAvailable: false,
        provider: input.diagnosticProvider.provider,
        mode: "unavailable",
        engine: null,
        fallbackUsed: false,
        fallbackReason: null,
        transportAvailable: false,
        fixHintSummary: createUnavailableFixHints({
          reason: `${input.diagnosticProvider.provider} fix hints are unavailable because diagnostics are currently unavailable.`,
          transportAvailable: false,
          fallbackUsed: false,
          fallbackReason: null,
        }).summary,
        projectContextSummary: createUnavailableProjectContext({
          reason: `${input.diagnosticProvider.provider} project context is unavailable because diagnostics are currently unavailable.`,
          transportAvailable: false,
          fallbackUsed: false,
          fallbackReason: null,
        }).summary,
        targetCount: targetPaths.length,
        processedPaths: [],
        skippedPaths: skippedForParse,
      }),
    });
  }

  if (eligiblePaths.length === 0) {
    return createSkippedCheck({
      id: input.check.id,
      label: input.check.label,
      summary: "Diagnostics were skipped because parse verification already failed for all eligible targets, avoiding duplicate noise.",
      durationMs: Date.now() - startedAt,
      category: "unavailable",
      kind: "diagnostics",
      fixHints: createUnavailableFixHints({
        reason: "Fix hints were skipped because parse verification already failed for all eligible diagnostics targets.",
        transportAvailable: true,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      projectContext: createUnavailableProjectContext({
        reason: "Project context was skipped because parse verification already failed for all eligible diagnostics targets.",
        transportAvailable: true,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      metadata: toJsonObject({
        providerAvailable: true,
        provider: input.diagnosticProvider.provider,
        mode: "project",
        engine: null,
        fallbackUsed: false,
        fallbackReason: null,
        transportAvailable: true,
        fixHintSummary: createUnavailableFixHints({
          reason: "Fix hints were skipped because parse verification already failed for all eligible diagnostics targets.",
          transportAvailable: true,
          fallbackUsed: false,
          fallbackReason: null,
        }).summary,
        projectContextSummary: createUnavailableProjectContext({
          reason: "Project context was skipped because parse verification already failed for all eligible diagnostics targets.",
          transportAvailable: true,
          fallbackUsed: false,
          fallbackReason: null,
        }).summary,
        targetCount: targetPaths.length,
        processedPaths: [],
        skippedPaths: skippedForParse,
      }),
    });
  }

  try {
    const result = await input.diagnosticProvider.collectDiagnostics({
      cwd: input.cwd,
      paths: eligiblePaths,
    });
    return buildDiagnosticsCheckResult({
      id: input.check.id,
      label: input.check.label,
      provider: input.diagnosticProvider.provider,
      result,
      durationMs: Date.now() - startedAt,
      targetPaths,
      skippedForParse,
    });
  } catch (error) {
    return createFailedCheck({
      id: input.check.id,
      kind: "diagnostics",
      label: input.check.label,
      category: "internal_error",
      summary: `Diagnostics collection failed: ${toErrorMessage(error)}`,
      durationMs: Date.now() - startedAt,
      findings: [
        createFinding({
          kind: "diagnostics",
          status: "failed",
          severity: "error",
          category: "internal_error",
          message: toErrorMessage(error),
          meta: toJsonObject({
            provider: input.diagnosticProvider.provider,
          }),
        }),
      ],
      fixHints: createUnavailableFixHints({
        reason: `Fix hints are unavailable because diagnostics collection failed: ${toErrorMessage(error)}`,
        transportAvailable: false,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      projectContext: createUnavailableProjectContext({
        reason: `Project context is unavailable because diagnostics collection failed: ${toErrorMessage(error)}`,
        transportAvailable: false,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      metadata: toJsonObject({
        providerAvailable: true,
        provider: input.diagnosticProvider.provider,
        mode: "unavailable",
        engine: null,
        fallbackUsed: false,
        fallbackReason: null,
        transportAvailable: false,
        fixHintSummary: createUnavailableFixHints({
          reason: `Fix hints are unavailable because diagnostics collection failed: ${toErrorMessage(error)}`,
          transportAvailable: false,
          fallbackUsed: false,
          fallbackReason: null,
        }).summary,
        projectContextSummary: createUnavailableProjectContext({
          reason: `Project context is unavailable because diagnostics collection failed: ${toErrorMessage(error)}`,
          transportAvailable: false,
          fallbackUsed: false,
          fallbackReason: null,
        }).summary,
        targetCount: targetPaths.length,
        processedPaths: [],
        skippedPaths: skippedForParse,
      }),
    });
  }
}

function verifyTypeScriptSyntaxFile(
  filePath: string,
  contents: string,
  startedAt: number,
): VerifierCheckResult {
  const transpileResult = ts.transpileModule(contents, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  const diagnostics = transpileResult.diagnostics ?? [];
  if (diagnostics.length === 0) {
    return createPassedCheck({
      id: createCheckId("file_parse", filePath),
      kind: "file_parse",
      label: `Parse ${path.basename(filePath)}`,
      filePath,
      summary: `${filePath} parsed as TypeScript successfully.`,
      durationMs: Date.now() - startedAt,
    });
  }

  return createFailedCheck({
    id: createCheckId("file_parse", filePath),
    kind: "file_parse",
    label: `Parse ${path.basename(filePath)}`,
      filePath,
      category: "syntax_error",
      summary: `${filePath} contains TypeScript syntax errors.`,
      durationMs: Date.now() - startedAt,
      findings: diagnostics.map((diagnostic: ts.Diagnostic) => {
        const lineInfo = diagnostic.start != null
          ? ts.getLineAndCharacterOfPosition(
              ts.createSourceFile(filePath, contents, ts.ScriptTarget.Latest, true),
              diagnostic.start,
            )
          : null;
        return createFinding({
          kind: "file_parse",
          status: "failed",
          severity: "error",
          category: "syntax_error",
          path: filePath,
          line: lineInfo ? lineInfo.line + 1 : null,
          column: lineInfo ? lineInfo.character + 1 : null,
          code: diagnostic.code ? `${diagnostic.code}` : null,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        });
      }),
  });
}

function buildCommandResult(
  command: VerifierCommandSpec,
  result: ShellRunResult,
  durationMs: number,
  kind: "command" | "targeted_command",
): VerifierCheckResult {
  const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled;
  const category = passed
    ? null
    : result.timedOut
      ? "timeout"
      : "command_failed";
  const stdoutSummary = summarizeText(result.stdout, 240) || null;
  const stderrSummary = summarizeText(result.stderr, 240) || null;
  const findings = passed
    ? []
    : [
        createFinding({
          kind,
          status: "failed",
          severity: "error",
          category,
          message: stderrSummary || stdoutSummary || `Command "${command.command}" failed.`,
          meta: toJsonObject({
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
          }),
        }),
      ];

  return {
    id: command.id,
    kind,
    label: `Run ${command.command}`,
    status: passed ? "passed" : "failed",
    passed,
    summary: passed
      ? `Verifier command "${command.command}" passed.`
      : `Verifier command "${command.command}" failed with exit code ${result.exitCode ?? "unknown"}.`,
    durationMs,
    command,
    findings,
    category,
    exitCode: result.exitCode,
    stdoutSummary,
    stderrSummary,
    metadata: toJsonObject({
      status: result.status,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      background: result.background,
    }),
  };
}

function summarizeVerifierRun(
  checks: VerifierCheckResult[],
  durationMs: number,
): VerifierRunSummary {
  const passedChecks = checks.filter((check) => check.status === "passed").length;
  const failedChecks = checks.filter((check) => check.status === "failed").length;
  const skippedChecks = checks.filter((check) => check.status === "skipped").length;
  const unavailableChecks = checks.filter((check) => check.status === "unavailable").length;
  const findings = checks.reduce((total, check) => total + check.findings.length, 0);
  const diagnosticFindings = checks.flatMap((check) => check.kind === "diagnostics" ? check.findings : []);
  const diagnosticErrorCount = diagnosticFindings.filter((finding) => finding.severity === "error").length;
  const diagnosticWarningCount = diagnosticFindings.filter((finding) => finding.severity === "warning").length;
  const diagnosticInfoCount = diagnosticFindings.filter((finding) => finding.severity === "info").length;
  const diagnosticsCheck = checks.find((check) => check.kind === "diagnostics");
  const diagnosticProviderAvailable = (() => {
    const metadata = asRecord(diagnosticsCheck?.metadata);
    if (typeof metadata?.providerAvailable === "boolean") {
      return metadata.providerAvailable;
    }
    if (diagnosticsCheck) {
      return diagnosticsCheck.status !== "unavailable";
    }
    return undefined;
  })();
  const diagnosticEngine = (() => {
    const metadata = asRecord(diagnosticsCheck?.metadata);
    const engine = metadata?.engine;
    return engine === "tsserver" || engine === "compiler_api" ? engine : "none";
  })();
  const diagnosticFallbackUsed = (() => {
    const metadata = asRecord(diagnosticsCheck?.metadata);
    return typeof metadata?.fallbackUsed === "boolean" ? metadata.fallbackUsed : undefined;
  })();
  const diagnosticFallbackReason = (() => {
    const metadata = asRecord(diagnosticsCheck?.metadata);
    return typeof metadata?.fallbackReason === "string" ? metadata.fallbackReason : null;
  })();
  const diagnosticTransportAvailable = (() => {
    const metadata = asRecord(diagnosticsCheck?.metadata);
    return typeof metadata?.transportAvailable === "boolean" ? metadata.transportAvailable : undefined;
  })();
  const fixHintAvailable = diagnosticsCheck?.fixHints?.summary.available;
  const fixHintSource = diagnosticsCheck?.fixHints?.summary.source ?? "none";
  const fixHintCount = diagnosticsCheck?.fixHints?.summary.total ?? 0;
  const recommendedFixHintCount = diagnosticsCheck?.fixHints?.summary.recommendedCount ?? 0;
  const fixHintFileCount = diagnosticsCheck?.fixHints?.summary.fileCount ?? 0;
  const fixHintReason = diagnosticsCheck?.fixHints?.summary.reason ?? null;
  const codeActionAvailable = diagnosticsCheck?.codeActions?.summary.available;
  const codeActionSource = diagnosticsCheck?.codeActions?.summary.source ?? "none";
  const codeActionCandidateCount = diagnosticsCheck?.codeActions?.summary.total ?? 0;
  const codeActionAllowlistedCount = diagnosticsCheck?.codeActions?.summary.allowlistedCount ?? 0;
  const codeActionBlockedCount = diagnosticsCheck?.codeActions?.summary.blockedCount ?? 0;
  const codeActionReason = diagnosticsCheck?.codeActions?.summary.reason ?? null;
  const projectContextAvailable = diagnosticsCheck?.projectContext?.summary.available;
  const projectContextSource = diagnosticsCheck?.projectContext?.summary.source ?? "none";
  const projectContextCount = diagnosticsCheck?.projectContext?.summary.total ?? 0;
  const projectContextDiagnosticCoverageCount =
    diagnosticsCheck?.projectContext?.summary.diagnosticCoverageCount ?? 0;
  const projectContextQuickInfoCount = diagnosticsCheck?.projectContext?.summary.quickInfoCount ?? 0;
  const projectContextDefinitionCount = diagnosticsCheck?.projectContext?.summary.definitionCount ?? 0;
  const projectContextImplementationCount = diagnosticsCheck?.projectContext?.summary.implementationCount ?? 0;
  const projectContextReferenceCount = diagnosticsCheck?.projectContext?.summary.referenceCount ?? 0;
  const projectContextDocumentSymbolCount = diagnosticsCheck?.projectContext?.summary.documentSymbolCount ?? 0;
  const projectContextFileCount = diagnosticsCheck?.projectContext?.summary.fileCount ?? 0;
  const projectContextReason = diagnosticsCheck?.projectContext?.summary.reason ?? null;
  const failureCategories = [...new Set(
    checks
      .map((check) => check.category ?? null)
      .filter((category): category is VerifierFailureCategory => Boolean(category) && category !== "unsupported_file")
  )];
  const status: VerifierStatus = failedChecks > 0
    ? "failed"
    : checks.length === 0 || skippedChecks === checks.length
      ? "skipped"
      : unavailableChecks === checks.length
        ? "unavailable"
      : "passed";

  return {
    status,
    passed: failedChecks === 0,
    totalChecks: checks.length,
    passedChecks,
    failedChecks,
    skippedChecks,
    unavailableChecks,
    findings,
    failureCategories,
    diagnosticErrorCount,
    diagnosticWarningCount,
    diagnosticInfoCount,
    diagnosticProviderAvailable,
    diagnosticEngine,
    diagnosticFallbackUsed,
    diagnosticFallbackReason,
    diagnosticTransportAvailable,
    fixHintAvailable,
    fixHintSource,
    fixHintCount,
    recommendedFixHintCount,
    fixHintFileCount,
    fixHintReason,
    codeActionAvailable,
    codeActionSource,
    codeActionCandidateCount,
    codeActionAllowlistedCount,
    codeActionBlockedCount,
    codeActionReason,
    projectContextAvailable,
    projectContextSource,
    projectContextCount,
    projectContextDiagnosticCoverageCount,
    projectContextQuickInfoCount,
    projectContextDefinitionCount,
    projectContextImplementationCount,
    projectContextReferenceCount,
    projectContextDocumentSymbolCount,
    projectContextFileCount,
    projectContextReason,
    summary: failedChecks > 0
      ? `Verifier failed: ${failedChecks} check(s) failed, ${passedChecks} passed, ${skippedChecks} skipped, ${unavailableChecks} unavailable.`
      : checks.length === 0
        ? "Verifier skipped because no checks were available."
        : status === "unavailable"
          ? `Verifier was unavailable: ${unavailableChecks} check(s) could not run.`
          : `Verifier passed: ${passedChecks} check(s) passed, ${skippedChecks} skipped, ${unavailableChecks} unavailable.`,
    durationMs,
  };
}

async function persistVerifierRun(
  dependencies: PostEditVerifierDependencies,
  input: PostEditVerifierInput,
  run: VerifierRunRecord,
): Promise<void> {
  await dependencies.sessionStore?.append("verifier_run", {
    traceId: input.turnState.traceId,
    step: input.step,
    run,
  });
  await dependencies.executionJournal?.append({
    type: "verifier_run",
    traceId: input.turnState.traceId,
    stepId: input.step,
    phase: "verify",
    payload: run,
  });
  const snapshot = dependencies.captureStateSnapshot
    ? await dependencies.captureStateSnapshot({
        traceId: input.turnState.traceId,
        phase: "verify",
        stepId: input.step,
        outputSummary: run.summary.summary,
      })
    : null;
  await dependencies.executionJournal?.recordPhase({
    traceId: input.turnState.traceId,
    stepId: input.step,
    phase: "verify",
    outputSummary: run.summary.summary,
    metrics: {
      summary: run.summary,
      checks: run.checks.map((check) => ({
        id: check.id,
        kind: check.kind,
        status: check.status,
        summary: check.summary,
        filePath: check.filePath ?? null,
        command: check.command?.command ?? null,
        exitCode: check.exitCode ?? null,
      })),
    },
    error: run.summary.passed
      ? null
      : {
          taxonomy: "verifier_failed",
          categories: run.summary.failureCategories,
          summary: run.summary.summary,
        },
    snapshot,
  });
}

function collectExplicitVerifierCommands(
  toolEvents: ToolEventRecord[],
  cwd: string,
): VerifierCommandSpec[] {
  const commands = new Map<string, VerifierCommandSpec>();
  for (const event of toolEvents) {
    if (event.tool !== "run_shell") {
      continue;
    }
    const result = toShellRunResult(event.result);
    if (!result || result.background) {
      continue;
    }
    const command = readCommandFromToolEvent(event, result);
    if (!command || !VERIFY_COMMAND_PATTERN.test(command)) {
      continue;
    }
    const commandCwd = typeof result.cwd === "string" && result.cwd
      ? result.cwd
      : cwd;
    commands.set(command, {
      id: createCheckId("command", `${commandCwd}:${command}`),
      command,
      cwd: commandCwd,
      source: "tool_execution",
      reason: "Reuse the explicit verification command already executed during this turn.",
    });
  }
  return [...commands.values()];
}

function indexExplicitShellResults(toolEvents: ToolEventRecord[]): Map<string, ShellRunResult> {
  const results = new Map<string, ShellRunResult>();
  for (const event of toolEvents) {
    if (event.tool !== "run_shell") {
      continue;
    }
    const shellResult = toShellRunResult(event.result);
    const command = readCommandFromToolEvent(event, shellResult);
    if (!shellResult || !command || !VERIFY_COMMAND_PATTERN.test(command) || shellResult.background) {
      continue;
    }
    results.set(command, shellResult);
  }
  return results;
}

function deriveTargetedCommand(
  cwd: string,
  lastChangeSet: ChangeSetRecord | null,
): VerifierCommandSpec | null {
  const likelyTests = Array.isArray(lastChangeSet?.impact?.likelyTests)
    ? lastChangeSet?.impact?.likelyTests.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const supportedTests = likelyTests.filter(isNodeTestFile).slice(0, 6);
  if (supportedTests.length === 0) {
    return null;
  }

  const renderedTests = supportedTests
    .map((relativePath) => quoteShellArg(relativePath))
    .join(" ");
  return {
    id: createCheckId("targeted_command", supportedTests.join("|")),
    command: `node --import tsx --test ${renderedTests}`,
    cwd,
    source: "targeted",
    reason: `Targeted from change impact likelyTests (${supportedTests.join(", ")}).`,
  };
}

function createPassedCheck(input: {
  id: string;
  kind: "file_parse" | "command" | "targeted_command" | "diagnostics";
  label: string;
  summary: string;
  durationMs: number;
  filePath?: string | null;
  command?: VerifierCommandSpec | null;
  findings?: VerifierFinding[];
  fixHints?: FixHintCollection | null;
  codeActions?: CodeActionCollection | null;
  projectContext?: ProjectContextCollection | null;
  metadata?: JsonObject | null;
}): VerifierCheckResult {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    status: "passed",
    passed: true,
    summary: input.summary,
    durationMs: input.durationMs,
    filePath: input.filePath ?? null,
    command: input.command ?? null,
    findings: input.findings ?? [],
    category: null,
    stdoutSummary: null,
    stderrSummary: null,
    fixHints: input.fixHints ?? null,
    codeActions: input.codeActions ?? null,
    projectContext: input.projectContext ?? null,
    metadata: input.metadata ?? null,
  };
}

function createFailedCheck(input: {
  id: string;
  kind: "file_parse" | "command" | "targeted_command" | "diagnostics";
  label: string;
  summary: string;
  durationMs: number;
  findings: VerifierFinding[];
  category: VerifierFailureCategory;
  filePath?: string | null;
  command?: VerifierCommandSpec | null;
  stderrSummary?: string | null;
  fixHints?: FixHintCollection | null;
  codeActions?: CodeActionCollection | null;
  projectContext?: ProjectContextCollection | null;
  metadata?: JsonObject | null;
}): VerifierCheckResult {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    status: "failed",
    passed: false,
    summary: input.summary,
    durationMs: input.durationMs,
    filePath: input.filePath ?? null,
    command: input.command ?? null,
    findings: input.findings,
    category: input.category,
    stdoutSummary: null,
    stderrSummary: input.stderrSummary ?? null,
    fixHints: input.fixHints ?? null,
    codeActions: input.codeActions ?? null,
    projectContext: input.projectContext ?? null,
    metadata: input.metadata ?? null,
  };
}

function createSkippedCheck(input: {
  id: string;
  label: string;
  summary: string;
  durationMs: number;
  category: VerifierFailureCategory;
  kind?: "file_parse" | "command" | "targeted_command" | "diagnostics";
  filePath?: string | null;
  command?: VerifierCommandSpec | null;
  fixHints?: FixHintCollection | null;
  codeActions?: CodeActionCollection | null;
  projectContext?: ProjectContextCollection | null;
  metadata?: JsonObject | null;
}): VerifierCheckResult {
  return {
    id: input.id,
    kind: input.kind ?? "file_parse",
    label: input.label,
    status: "skipped",
    passed: true,
    summary: input.summary,
    durationMs: input.durationMs,
    filePath: input.filePath ?? null,
    command: input.command ?? null,
    findings: [
      createFinding({
        kind: input.kind ?? "file_parse",
        status: "skipped",
        severity: "info",
        category: input.category,
        path: input.filePath ?? null,
        message: input.summary,
      }),
    ],
    category: input.category,
    stdoutSummary: null,
    stderrSummary: null,
    skippedReason: input.summary,
    fixHints: input.fixHints ?? null,
    codeActions: input.codeActions ?? null,
    projectContext: input.projectContext ?? null,
    metadata: input.metadata ?? null,
  };
}

function createUnavailableCheck(input: {
  id: string;
  label: string;
  summary: string;
  durationMs: number;
  category: VerifierFailureCategory;
  kind: "file_parse" | "command" | "targeted_command" | "diagnostics";
  filePath?: string | null;
  command?: VerifierCommandSpec | null;
  fixHints?: FixHintCollection | null;
  codeActions?: CodeActionCollection | null;
  projectContext?: ProjectContextCollection | null;
  metadata?: JsonObject | null;
}): VerifierCheckResult {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    status: "unavailable",
    passed: true,
    summary: input.summary,
    durationMs: input.durationMs,
    filePath: input.filePath ?? null,
    command: input.command ?? null,
    findings: [
      createFinding({
        kind: input.kind,
        status: "unavailable",
        severity: "info",
        category: input.category,
        path: input.filePath ?? null,
        message: input.summary,
      }),
    ],
    category: input.category,
    stdoutSummary: null,
    stderrSummary: null,
    skippedReason: input.summary,
    fixHints: input.fixHints ?? null,
    codeActions: input.codeActions ?? null,
    projectContext: input.projectContext ?? null,
    metadata: input.metadata ?? null,
  };
}

function createFinding(input: {
  kind: "file_parse" | "command" | "targeted_command" | "diagnostics";
  status: VerifierStatus;
  severity: VerifierSeverity;
  message: string;
  category?: VerifierFailureCategory | null;
  path?: string | null;
  line?: number | null;
  column?: number | null;
  code?: string | null;
  source?: string | null;
  scope?: string | null;
  rule?: string | null;
  related?: VerifierFinding["related"];
  excerpt?: string | null;
  meta?: JsonObject | null;
}): VerifierFinding {
  return {
    kind: input.kind,
    status: input.status,
    severity: input.severity,
    message: input.message,
    category: input.category ?? null,
    path: input.path ?? null,
    line: input.line ?? null,
    column: input.column ?? null,
    code: input.code ?? null,
    source: input.source ?? null,
    scope: input.scope ?? null,
    rule: input.rule ?? null,
    related: input.related ?? null,
    excerpt: input.excerpt ?? null,
    meta: input.meta ?? null,
  };
}

function planHasVerifyStep(executionPlan: ExecutionPlan | null): boolean {
  return Array.isArray(executionPlan?.steps) &&
    executionPlan.steps.some((step) => step?.type === "verify");
}

function normalizeFiles(filesChanged: Set<string> | string[]): string[] {
  const values = Array.isArray(filesChanged) ? filesChanged : [...filesChanged];
  return [...new Set(values.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

function collectDiagnosticTargets(input: {
  cwd: string;
  filesChanged: string[];
  lastChangeSet: ChangeSetRecord | null;
}): string[] {
  if (input.filesChanged.length === 0) {
    return [];
  }
  const targets: string[] = [];
  const pushTarget = (entry: string) => {
    if (targets.length >= MAX_DIAGNOSTIC_TARGETS) {
      return;
    }
    const resolved = path.resolve(input.cwd, entry);
    if (!isDiagnosticsCandidatePath(resolved) || targets.includes(resolved)) {
      return;
    }
    targets.push(resolved);
  };

  for (const filePath of input.filesChanged) {
    pushTarget(filePath);
  }

  const relatedFiles = Array.isArray(input.lastChangeSet?.impact?.relatedFiles)
    ? input.lastChangeSet.impact.relatedFiles
    : [];
  for (const relatedPath of relatedFiles) {
    if (typeof relatedPath === "string" && relatedPath.length > 0) {
      pushTarget(relatedPath);
    }
  }

  return targets;
}

function normalizeDiagnosticCheckPaths(paths: string[] | null | undefined, cwd: string): string[] {
  const values = Array.isArray(paths) ? paths : [];
  return [...new Set(values
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map((entry) => path.resolve(cwd, entry)))];
}

function isDiagnosticsCandidatePath(filePath: string): boolean {
  return SUPPORTED_DIAGNOSTIC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function createCheckId(kind: string, seed: string): string {
  return `${kind}-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)}`;
}

function toDisplayPath(filePath: string, cwd: string): string {
  if (!cwd) {
    return filePath;
  }
  const relativePath = path.relative(cwd, filePath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

function toShellRunResult(value: unknown): ShellRunResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (!("command" in value) || !("status" in value)) {
    return null;
  }
  return value as ShellRunResult;
}

function readCommandFromToolEvent(event: ToolEventRecord, result: ShellRunResult | null): string | null {
  const directInput = asRecord(event.input);
  const effectiveInput = asRecord(event.effectiveInput);
  const fromInputs = [directInput?.command, effectiveInput?.command]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  if (fromInputs) {
    return fromInputs;
  }
  return typeof result?.command === "string" && result.command ? result.command : null;
}

function isNodeTestFile(relativePath: string): boolean {
  return /\.(test|spec)\.(mjs|cjs|js|mts|cts|ts)$/i.test(relativePath);
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function classifyCommandFailure(error: unknown): VerifierFailureCategory {
  const message = toErrorMessage(error).toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  return "internal_error";
}

function extractExecStderr(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
    return error.stderr;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildDiagnosticsCheckResult(input: {
  id: string;
  label: string;
  provider: string;
  result: DiagnosticCollectionResult;
  durationMs: number;
  targetPaths: string[];
  skippedForParse: Array<{
    path: string;
    reason: string;
  }>;
}): VerifierCheckResult {
  const allSkippedPaths = [...input.result.skippedPaths, ...input.skippedForParse];
  const fixHints = input.result.fixHints ?? createUnavailableFixHints({
    reason: "Fix hints were not returned by the diagnostics provider.",
    transportAvailable: input.result.availability.transportAvailable,
    fallbackUsed: input.result.fallbackUsed,
    fallbackReason: input.result.fallbackReason,
  });
  const codeActions = input.result.codeActions ?? createUnavailableCodeActions({
    reason: "Code actions were not returned by the diagnostics provider.",
    transportAvailable: input.result.availability.transportAvailable,
    fallbackUsed: input.result.fallbackUsed,
    fallbackReason: input.result.fallbackReason,
  });
  const projectContext = input.result.projectContext ?? createUnavailableProjectContext({
    reason: "Project context was not returned by the diagnostics provider.",
    transportAvailable: input.result.availability.transportAvailable,
    fallbackUsed: input.result.fallbackUsed,
    fallbackReason: input.result.fallbackReason,
  });
  const metadata = toJsonObject({
    providerAvailable: input.result.availability.available,
    provider: input.provider,
    mode: input.result.availability.mode,
    reason: input.result.availability.reason,
    engine: input.result.engine,
    fallbackUsed: input.result.fallbackUsed,
    fallbackReason: input.result.fallbackReason,
    transportAvailable: input.result.availability.transportAvailable,
    configPaths: input.result.availability.configPaths,
    targetCount: input.targetPaths.length,
    processedPaths: input.result.processedPaths,
    skippedPaths: allSkippedPaths,
    diagnosticSummary: input.result.summary,
    fixHintSummary: fixHints.summary,
    codeActionSummary: codeActions.summary,
    projectContextSummary: projectContext.summary,
  });
  if (!input.result.availability.available) {
    return createUnavailableCheck({
      id: input.id,
      kind: "diagnostics",
      label: input.label,
      summary: input.result.availability.reason ?? "Diagnostics provider was unavailable for the requested targets.",
      durationMs: input.durationMs,
      category: "unavailable",
      fixHints,
      codeActions,
      projectContext,
      metadata,
    });
  }

  const findings = input.result.diagnostics.map((diagnostic) =>
    createFinding({
      kind: "diagnostics",
      status: input.result.summary.errorCount > 0 ? "failed" : "passed",
      severity: diagnostic.severity,
      category: toDiagnosticFailureCategory(diagnostic),
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code,
      source: diagnostic.source,
      scope: diagnostic.scope,
      rule: diagnostic.rule,
      related: diagnostic.related,
      message: diagnostic.message,
    })
  );

  if (input.result.summary.errorCount > 0) {
    return createFailedCheck({
      id: input.id,
      kind: "diagnostics",
      label: input.label,
      category: findings.some((finding) => finding.category === "config_error")
        ? "config_error"
        : "diagnostic_error",
      summary: renderDiagnosticsSummary(input.result, input.skippedForParse.length),
      durationMs: input.durationMs,
      findings,
      fixHints,
      codeActions,
      projectContext,
      metadata,
    });
  }

  if (input.result.processedPaths.length === 0 && input.result.diagnostics.length === 0) {
    return createSkippedCheck({
      id: input.id,
      kind: "diagnostics",
      label: input.label,
      summary: renderDiagnosticsSummary(input.result, input.skippedForParse.length),
      durationMs: input.durationMs,
      category: "unavailable",
      fixHints,
      codeActions,
      projectContext,
      metadata,
    });
  }

  return createPassedCheck({
    id: input.id,
    kind: "diagnostics",
    label: input.label,
    summary: renderDiagnosticsSummary(input.result, input.skippedForParse.length),
    durationMs: input.durationMs,
    findings,
    fixHints,
    codeActions,
    projectContext,
    metadata,
  });
}

function createUnavailableFixHints(input: {
  reason: string;
  transportAvailable: boolean | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}): FixHintCollection {
  return {
    availability: {
      available: false,
      source: "unavailable",
      reason: input.reason,
      transportAvailable: input.transportAvailable,
      fallbackUsed: input.fallbackUsed,
      fallbackReason: input.fallbackReason,
    },
    hints: [],
    summary: {
      total: 0,
      recommendedCount: 0,
      fileCount: 0,
      available: false,
      source: "unavailable",
      reason: input.reason,
    },
  };
}

function createUnavailableCodeActions(input: {
  reason: string;
  transportAvailable: boolean | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}): CodeActionCollection {
  return createUnavailableCodeActionCollection({
    reason: input.reason,
    transportAvailable: input.transportAvailable,
    fallbackUsed: input.fallbackUsed,
    fallbackReason: input.fallbackReason,
  });
}

function createUnavailableProjectContext(input: {
  reason: string;
  transportAvailable: boolean | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}): ProjectContextCollection {
  return {
    availability: {
      available: false,
      source: "unavailable",
      reason: input.reason,
      transportAvailable: input.transportAvailable,
      fallbackUsed: input.fallbackUsed,
      fallbackReason: input.fallbackReason,
    },
    items: [],
    summary: {
      total: 0,
      diagnosticCoverageCount: 0,
      quickInfoCount: 0,
      definitionCount: 0,
      implementationCount: 0,
      referenceCount: 0,
      documentSymbolCount: 0,
      fileCount: 0,
      available: false,
      source: "unavailable",
      reason: input.reason,
    },
  };
}

function renderDiagnosticsSummary(
  result: DiagnosticCollectionResult,
  parseSkippedCount: number,
): string {
  const base = result.summary.errorCount > 0
    ? `Diagnostics found ${result.summary.errorCount} error(s), ${result.summary.warningCount} warning(s), and ${result.summary.infoCount} info item(s) across ${result.summary.processedTargetCount}/${result.summary.targetCount} target(s).`
    : result.summary.total > 0
      ? `Diagnostics passed with ${result.summary.warningCount} warning(s) and ${result.summary.infoCount} info item(s) across ${result.summary.processedTargetCount}/${result.summary.targetCount} target(s).`
      : result.summary.processedTargetCount > 0
        ? `Diagnostics passed cleanly for ${result.summary.processedTargetCount}/${result.summary.targetCount} target(s).`
        : result.availability.reason ?? "Diagnostics did not process any requested targets.";
  return parseSkippedCount > 0
    ? `${base} ${parseSkippedCount} parse-failed target(s) were skipped to avoid duplicate noise.`
    : base;
}

function toDiagnosticFailureCategory(diagnostic: DiagnosticRecord): VerifierFailureCategory {
  return diagnostic.scope === "config" || diagnostic.category === "config"
    ? "config_error"
    : "diagnostic_error";
}

export function createDiagnosticFingerprint(
  diagnostic: DiagnosticIdentityLike,
): DiagnosticFingerprint {
  const normalized = {
    path: typeof diagnostic.path === "string" && diagnostic.path.length > 0
      ? normalizeVerifierPath(diagnostic.path)
      : null,
    line: typeof diagnostic.line === "number" ? diagnostic.line : null,
    column: typeof diagnostic.column === "number" ? diagnostic.column : null,
    code: typeof diagnostic.code === "string" && diagnostic.code.length > 0 ? diagnostic.code : null,
    message: normalizeDiagnosticMessage(diagnostic.message),
    source: typeof diagnostic.source === "string" && diagnostic.source.length > 0 ? diagnostic.source : null,
    scope: typeof diagnostic.scope === "string" && diagnostic.scope.length > 0 ? diagnostic.scope : null,
    category: typeof diagnostic.category === "string" && diagnostic.category.length > 0 ? diagnostic.category : null,
    rule: typeof diagnostic.rule === "string" && diagnostic.rule.length > 0 ? diagnostic.rule : null,
  };
  const fingerprint = crypto
    .createHash("sha1")
    .update(JSON.stringify([
      normalized.path,
      normalized.line,
      normalized.column,
      normalized.code,
      normalized.message,
      normalized.source,
      normalized.scope,
      normalized.category,
      normalized.rule,
    ]))
    .digest("hex");

  return {
    fingerprint,
    path: normalized.path,
    line: normalized.line,
    column: normalized.column,
    code: normalized.code,
    message: normalized.message,
    source: normalized.source,
    scope: normalized.scope,
    category: normalized.category,
    rule: normalized.rule,
  };
}

export function collectDiagnosticFingerprintsFromVerifierRun(
  run: VerifierRunRecord,
): DiagnosticFingerprint[] {
  const fingerprints = new Map<string, DiagnosticFingerprint>();
  for (const finding of collectDiagnosticsFindings(run)) {
    const fingerprint = createDiagnosticFingerprint(finding);
    if (!fingerprints.has(fingerprint.fingerprint)) {
      fingerprints.set(fingerprint.fingerprint, fingerprint);
    }
  }
  return [...fingerprints.values()].sort(compareDiagnosticFingerprints);
}

export function createDiagnosticSnapshotFromVerifierRun(
  run: VerifierRunRecord,
): DiagnosticSnapshotSummary {
  const comparable = hasComparableDiagnosticsCheck(run);
  return {
    comparable,
    reason: comparable
      ? null
      : "Verifier run did not produce comparable diagnostics.",
    total: resolveDiagnosticTotal(run),
    errorCount: resolveDiagnosticCount(run, "error"),
    warningCount: resolveDiagnosticCount(run, "warning"),
    infoCount: resolveDiagnosticCount(run, "info"),
    engine: resolveDiagnosticEngine(run),
    fallbackUsed: resolveDiagnosticFallbackUsed(run),
    transportAvailable: resolveDiagnosticTransportAvailable(run),
    fingerprints: comparable
      ? collectDiagnosticFingerprintsFromVerifierRun(run)
      : [],
  };
}

export function compareVerifierRunDiagnostics(
  before: VerifierRunRecord,
  after: VerifierRunRecord,
): DiagnosticDeltaSummary {
  return compareDiagnosticSnapshotToVerifierRun(
    createDiagnosticSnapshotFromVerifierRun(before),
    after,
  );
}

export function compareDiagnosticSnapshotToVerifierRun(
  before: DiagnosticSnapshotSummary,
  after: VerifierRunRecord,
): DiagnosticDeltaSummary {
  const afterComparable = hasComparableDiagnosticsCheck(after);
  const beforeFingerprints = before.comparable ? before.fingerprints : [];
  const afterFingerprints = afterComparable
    ? collectDiagnosticFingerprintsFromVerifierRun(after)
    : [];

  const beforeIndex = new Map(beforeFingerprints.map((entry) => [entry.fingerprint, entry]));
  const afterIndex = new Map(afterFingerprints.map((entry) => [entry.fingerprint, entry]));
  const resolved = beforeFingerprints
    .filter((entry) => !afterIndex.has(entry.fingerprint))
    .sort(compareDiagnosticFingerprints);
  const persisted = beforeFingerprints
    .filter((entry) => afterIndex.has(entry.fingerprint))
    .sort(compareDiagnosticFingerprints);
  const introduced = afterFingerprints
    .filter((entry) => !beforeIndex.has(entry.fingerprint))
    .sort(compareDiagnosticFingerprints);
  const comparable = before.comparable && afterComparable;
  const beforeErrorCount = before.errorCount;
  const afterErrorCount = resolveDiagnosticCount(after, "error");
  const beforeWarningCount = before.warningCount;
  const afterWarningCount = resolveDiagnosticCount(after, "warning");
  const beforeInfoCount = before.infoCount;
  const afterInfoCount = resolveDiagnosticCount(after, "info");

  return {
    comparable,
    summary: comparable
      ? renderDiagnosticDeltaSummary({
          beforeErrorCount,
          afterErrorCount,
          beforeWarningCount,
          afterWarningCount,
          beforeInfoCount,
          afterInfoCount,
          resolvedCount: resolved.length,
          persistedCount: persisted.length,
          introducedCount: introduced.length,
        })
      : renderDiagnosticComparisonUnavailable(before, after),
    beforeTotal: before.total,
    afterTotal: resolveDiagnosticTotal(after),
    beforeErrorCount,
    afterErrorCount,
    beforeWarningCount,
    afterWarningCount,
    beforeInfoCount,
    afterInfoCount,
    resolvedCount: comparable ? resolved.length : 0,
    persistedCount: comparable ? persisted.length : 0,
    introducedCount: comparable ? introduced.length : 0,
    resolved: comparable ? resolved : [],
    persisted: comparable ? persisted : [],
    introduced: comparable ? introduced : [],
    beforeEngine: before.engine,
    afterEngine: resolveDiagnosticEngine(after),
    beforeFallbackUsed: before.fallbackUsed,
    afterFallbackUsed: resolveDiagnosticFallbackUsed(after),
    beforeTransportAvailable: before.transportAvailable,
    afterTransportAvailable: resolveDiagnosticTransportAvailable(after),
  };
}

function normalizeVerifierPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

function isBackgroundStartResult(value: ShellRunResult | ShellBackgroundStartResult): value is ShellBackgroundStartResult {
  return Boolean(value && "background" in value && value.background === true && !("stdout" in value));
}

function toJsonObject(value: Record<string, unknown>): JsonObject | null {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  } catch {
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return `${error ?? "Unknown verifier error"}`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error != null && typeof error === "object" && "code" in error;
}

function collectDiagnosticsFindings(run: VerifierRunRecord): VerifierFinding[] {
  return run.checks.flatMap((check) => check.kind === "diagnostics" ? check.findings : []);
}

function hasComparableDiagnosticsCheck(run: VerifierRunRecord): boolean {
  const check = run.checks.find((entry) => entry.kind === "diagnostics");
  return Boolean(check) && check?.status !== "skipped" && check?.status !== "unavailable";
}

function resolveDiagnosticCount(
  run: VerifierRunRecord,
  severity: VerifierSeverity,
): number {
  const summaryField = severity === "error"
    ? run.summary.diagnosticErrorCount
    : severity === "warning"
      ? run.summary.diagnosticWarningCount
      : run.summary.diagnosticInfoCount;
  if (typeof summaryField === "number") {
    return summaryField;
  }
  return collectDiagnosticsFindings(run).filter((finding) => finding.severity === severity).length;
}

function resolveDiagnosticTotal(run: VerifierRunRecord): number {
  return resolveDiagnosticCount(run, "error") +
    resolveDiagnosticCount(run, "warning") +
    resolveDiagnosticCount(run, "info");
}

function resolveDiagnosticEngine(run: VerifierRunRecord): DiagnosticDeltaSummary["beforeEngine"] {
  return run.summary.diagnosticEngine === "tsserver" || run.summary.diagnosticEngine === "compiler_api"
    ? run.summary.diagnosticEngine
    : "none";
}

function resolveDiagnosticFallbackUsed(run: VerifierRunRecord): boolean {
  return run.summary.diagnosticFallbackUsed === true;
}

function resolveDiagnosticTransportAvailable(run: VerifierRunRecord): boolean | null {
  return typeof run.summary.diagnosticTransportAvailable === "boolean"
    ? run.summary.diagnosticTransportAvailable
    : null;
}

function renderDiagnosticDeltaSummary(input: {
  beforeErrorCount: number;
  afterErrorCount: number;
  beforeWarningCount: number;
  afterWarningCount: number;
  beforeInfoCount: number;
  afterInfoCount: number;
  resolvedCount: number;
  persistedCount: number;
  introducedCount: number;
}): string {
  return [
    `Diagnostics delta: errors ${input.beforeErrorCount} -> ${input.afterErrorCount}`,
    `warnings ${input.beforeWarningCount} -> ${input.afterWarningCount}`,
    `info ${input.beforeInfoCount} -> ${input.afterInfoCount}`,
    `resolved ${input.resolvedCount}`,
    `persisted ${input.persistedCount}`,
    `introduced ${input.introducedCount}.`,
  ].join(", ");
}

function renderDiagnosticComparisonUnavailable(
  before: DiagnosticSnapshotSummary,
  after: VerifierRunRecord,
): string {
  if (!before.comparable) {
    return before.reason ?? "Diagnostics delta unavailable because the triggering verifier run did not produce comparable diagnostics.";
  }
  if (!hasComparableDiagnosticsCheck(after)) {
    return "Diagnostics delta unavailable because the repair result verifier run did not produce comparable diagnostics.";
  }
  return "Diagnostics delta unavailable.";
}

function normalizeDiagnosticMessage(message: string): string {
  return `${message}`.replace(/\s+/g, " ").trim();
}

function compareDiagnosticFingerprints(
  left: DiagnosticFingerprint,
  right: DiagnosticFingerprint,
): number {
  return JSON.stringify([
    left.path,
    left.line,
    left.column,
    left.code,
    left.message,
    left.source,
    left.scope,
    left.category,
    left.rule,
  ]).localeCompare(JSON.stringify([
    right.path,
    right.line,
    right.column,
    right.code,
    right.message,
    right.source,
    right.scope,
    right.category,
    right.rule,
  ]));
}
