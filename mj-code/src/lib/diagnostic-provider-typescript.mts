import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { createDiagnosticFingerprint } from "./agent-verifier.mjs";
import {
  createTsServerCodeActionCollection,
  createUnavailableCodeActionCollection,
  mergeCodeActionCandidate,
  normalizeTsServerCodeAction,
} from "./code-action-assist.mjs";
import {
  TsServerTransport,
  extractConfigFileDiagnosticEvents,
  isTsServerTransportFailure,
  resolveDefaultTsServerPath,
  type TsServerConfigDiagnosticEvent,
  type TsServerProtocolCodeFix,
  type TsServerProtocolDefinition,
  type TsServerProtocolDocumentSymbol,
  type TsServerProtocolImplementation,
  type TsServerProjectInfo,
  type TsServerProtocolDiagnostic,
  type TsServerProtocolQuickInfo,
  type TsServerProtocolReference,
  type TsServerTransportOptions,
} from "./tsserver-transport.mjs";

import type {
  CodeActionCandidate,
  CodeActionCollection,
  DiagnosticProjectContext,
  DiagnosticCollectionResult,
  DiagnosticEngine,
  DiagnosticFingerprint,
  DiagnosticProvider,
  DiagnosticProviderAvailability,
  DiagnosticRecord,
  DiagnosticRequest,
  DiagnosticScope,
  DiagnosticSource,
  DiagnosticSummary,
  FixHint,
  FixHintCollection,
  FixHintEditChangePreview,
  FixHintEditPreview,
  ProjectContextCollection,
  ProjectContextDefinition,
  ProjectContextDocumentSymbol,
  ProjectContextImplementation,
  ProjectContextQuickInfo,
  ProjectContextReference,
  VerifierSeverity,
} from "../types/contracts.js";

const CONFIG_FILE_CANDIDATES = [
  "tsconfig.typecheck.json",
  "tsconfig.json",
  "jsconfig.json",
  "tsconfig.build.json",
];

const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
];

const MAX_FALLBACK_TARGETS = 16;
const MAX_FIX_HINT_DIAGNOSTICS = 12;
const MAX_FIX_HINTS = 24;
const MAX_FIX_HINT_FILES = 4;
const MAX_FIX_HINT_CHANGES = 6;
const MAX_FIX_HINT_TEXT_PREVIEW = 160;
const MAX_PROJECT_CONTEXT_DIAGNOSTICS = 8;
const MAX_PROJECT_CONTEXT_DEFINITIONS = 3;
const MAX_PROJECT_CONTEXT_IMPLEMENTATIONS = 3;
const MAX_PROJECT_CONTEXT_REFERENCES = 5;
const MAX_PROJECT_CONTEXT_DOCUMENT_SYMBOLS = 4;
const MAX_PROJECT_CONTEXT_LINE_PREVIEW = 160;

interface DiagnosticSkipPath {
  path: string;
  reason: string;
}

interface ProjectDiagnosticBatch {
  diagnostics: DiagnosticRecord[];
  processedPaths: string[];
  skippedPaths: DiagnosticSkipPath[];
  mode: Exclude<DiagnosticProviderAvailability["mode"], "unavailable">;
  configPath: string | null;
}

interface CompilerApiDiagnosticBatch {
  availability: DiagnosticProviderAvailability;
  diagnostics: DiagnosticRecord[];
  fixHints: FixHintCollection;
  codeActions: CodeActionCollection;
  projectContext: ProjectContextCollection;
  processedPaths: string[];
  skippedPaths: DiagnosticSkipPath[];
}

interface TsServerDiagnosticBatch {
  availability: DiagnosticProviderAvailability;
  diagnostics: DiagnosticRecord[];
  fixHints: FixHintCollection;
  codeActions: CodeActionCollection;
  projectContext: ProjectContextCollection;
  processedPaths: string[];
  skippedPaths: DiagnosticSkipPath[];
}

interface TsServerFixHintCandidate {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  errorCode: number;
  fingerprint: DiagnosticFingerprint;
  message: string;
}

export interface TypeScriptDiagnosticProviderOptions extends TsServerTransportOptions {}

interface TsServerAssistCollection {
  fixHints: FixHintCollection;
  codeActions: CodeActionCollection;
  projectContext: ProjectContextCollection;
}

export class TypeScriptDiagnosticProvider implements DiagnosticProvider {
  readonly kind = "diagnostics";
  readonly provider = "typescript";
  private readonly transportOptions: TypeScriptDiagnosticProviderOptions;
  private transport: TsServerTransport | null;
  private transportCwd: string | null;

  constructor(options: TypeScriptDiagnosticProviderOptions = {}) {
    this.transportOptions = {
      ...options,
      args: Array.isArray(options.args) ? [...options.args] : undefined,
    };
    this.transport = null;
    this.transportCwd = null;
  }

  get available(): boolean {
    return true;
  }

  async close(): Promise<void> {
    await this.disposeTransport();
  }

  async collectDiagnostics(input: DiagnosticRequest): Promise<DiagnosticCollectionResult> {
    const cwd = path.resolve(input.cwd || process.cwd());
    const normalizedTargets = normalizeTargetPaths(input.paths, cwd);
    const supportedTargets = normalizedTargets.filter((target) => isSupportedExtension(target));
    const skippedPaths: DiagnosticSkipPath[] = normalizedTargets
      .filter((target) => !isSupportedExtension(target))
      .map((target) => ({
        path: target,
        reason: "Unsupported diagnostics target extension.",
      }));

    if (supportedTargets.length === 0) {
      return buildCollectionResult({
        availability: {
          available: false,
          provider: this.provider,
          mode: "unavailable",
          reason: "No supported TypeScript or JavaScript targets were provided.",
          configPaths: [],
          supportedExtensions: [...SUPPORTED_EXTENSIONS],
          transportAvailable: isTransportConfigured(this.transportOptions),
        },
        engine: null,
        fallbackUsed: false,
        fallbackReason: null,
        diagnostics: [],
        fixHints: createUnavailableFixHintCollection({
          reason: "Fix hints require supported TypeScript or JavaScript diagnostics targets.",
          transportAvailable: isTransportConfigured(this.transportOptions),
          fallbackUsed: false,
          fallbackReason: null,
        }),
        codeActions: createUnavailableCodeActionCollection({
          reason: "Code actions require supported TypeScript or JavaScript diagnostics targets.",
          transportAvailable: isTransportConfigured(this.transportOptions),
          fallbackUsed: false,
          fallbackReason: null,
        }),
        projectContext: createUnavailableProjectContextCollection({
          reason: "Project context requires supported TypeScript or JavaScript diagnostics targets.",
          transportAvailable: isTransportConfigured(this.transportOptions),
          fallbackUsed: false,
          fallbackReason: null,
        }),
        processedPaths: [],
        skippedPaths,
        targetCount: normalizedTargets.length,
      });
    }

    let tsserverFailureReason: string | null = null;
    if (isTransportConfigured(this.transportOptions)) {
      try {
        const batch = await this.collectTsServerDiagnostics(supportedTargets, cwd);
        return buildCollectionResult({
          availability: batch.availability,
          engine: "tsserver",
          fallbackUsed: false,
          fallbackReason: null,
          diagnostics: batch.diagnostics,
          fixHints: batch.fixHints,
          codeActions: batch.codeActions,
          projectContext: batch.projectContext,
          processedPaths: batch.processedPaths,
          skippedPaths: [...skippedPaths, ...batch.skippedPaths],
          targetCount: normalizedTargets.length,
        });
      } catch (error) {
        tsserverFailureReason = describeTsServerFailure(error);
        await this.disposeTransport();
      }
    } else {
      tsserverFailureReason = "tsserver transport is unavailable because tsserver.js could not be resolved.";
    }

    const fallbackBatch = collectCompilerApiDiagnostics(supportedTargets, cwd);
    return buildCollectionResult({
      availability: {
        ...fallbackBatch.availability,
        transportAvailable: false,
      },
      engine: "compiler_api",
      fallbackUsed: true,
      fallbackReason: tsserverFailureReason,
      diagnostics: fallbackBatch.diagnostics,
      fixHints: withFixHintFallbackReason(fallbackBatch.fixHints, tsserverFailureReason),
      codeActions: withCodeActionFallbackReason(fallbackBatch.codeActions, tsserverFailureReason),
      projectContext: withProjectContextFallbackReason(fallbackBatch.projectContext, tsserverFailureReason),
      processedPaths: fallbackBatch.processedPaths,
      skippedPaths: [...skippedPaths, ...fallbackBatch.skippedPaths],
      targetCount: normalizedTargets.length,
    });
  }

  private async collectTsServerDiagnostics(
    targetPaths: string[],
    cwd: string,
  ): Promise<TsServerDiagnosticBatch> {
    const transport = await this.getTransport(cwd);
    const cursor = transport.getEventCursor();
    const processedPaths: string[] = [];
    const skippedPaths: DiagnosticSkipPath[] = [];
    const infoByPath = new Map<string, TsServerProjectInfo>();
    const diagnostics: DiagnosticRecord[] = [];
    const fixHintCandidates: TsServerFixHintCandidate[] = [];

    try {
      for (const targetPath of targetPaths) {
        let fileContent: string;
        try {
          fileContent = await fs.readFile(targetPath, "utf8");
        } catch (error) {
          skippedPaths.push({
            path: targetPath,
            reason: `tsserver could not read the target file: ${toErrorMessage(error)}`,
          });
          continue;
        }

        try {
          await transport.openFile({
            filePath: targetPath,
            fileContent,
            projectRootPath: cwd,
            scriptKindName: toTsServerScriptKindName(targetPath),
          });
          const projectInfo = await transport.getProjectInfo(targetPath);
          processedPaths.push(targetPath);
          infoByPath.set(targetPath, projectInfo);
        } catch (error) {
          if (isTsServerTransportFailure(error)) {
            throw error;
          }
          skippedPaths.push({
            path: targetPath,
            reason: `tsserver could not open the target file: ${toErrorMessage(error)}`,
          });
        }
      }

      if (processedPaths.length === 0) {
        return {
          availability: {
            available: false,
            provider: this.provider,
            mode: "unavailable",
            reason: "tsserver did not process any requested targets.",
            configPaths: [],
            supportedExtensions: [...SUPPORTED_EXTENSIONS],
            transportAvailable: true,
          },
          diagnostics: [],
          fixHints: createUnavailableFixHintCollection({
            reason: "Fix hints are unavailable because tsserver did not process any requested targets.",
            transportAvailable: true,
            fallbackUsed: false,
            fallbackReason: null,
          }),
          codeActions: createUnavailableCodeActionCollection({
            reason: "Code actions are unavailable because tsserver did not process any requested targets.",
            transportAvailable: true,
            fallbackUsed: false,
            fallbackReason: null,
          }),
          projectContext: createUnavailableProjectContextCollection({
            reason: "Project context is unavailable because tsserver did not process any requested targets.",
            transportAvailable: true,
            fallbackUsed: false,
            fallbackReason: null,
          }),
          processedPaths: [],
          skippedPaths,
        };
      }

      const configPaths = uniquePaths(
        processedPaths
          .map((targetPath) => infoByPath.get(targetPath)?.configFileName ?? null)
          .filter((entry): entry is string => Boolean(entry) && !isInferredProjectName(entry)),
      );
      for (const targetPath of processedPaths) {
        const projectInfo = infoByPath.get(targetPath);
        const scope = projectInfo?.isInferredProject ? "fallback" : "file";
        const syntaxDiagnostics = await transport.getSyntacticDiagnostics(targetPath);
        const semanticDiagnostics = await transport.getSemanticDiagnostics(targetPath);
        const suggestionDiagnostics = await transport.getSuggestionDiagnostics(targetPath);
        diagnostics.push(
          ...mapTsServerDiagnostics(
            syntaxDiagnostics,
            {
              cwd,
              category: "syntax",
              scope,
              source: "typescript",
            },
          ),
        );
        diagnostics.push(
          ...mapTsServerDiagnostics(
            semanticDiagnostics,
            {
              cwd,
              category: "semantic",
              scope,
              source: "typescript",
            },
          ),
        );
        diagnostics.push(
          ...mapTsServerDiagnostics(
            suggestionDiagnostics,
            {
              cwd,
              category: "suggestion",
              scope,
              source: "typescript",
            },
          ),
        );
        fixHintCandidates.push(
          ...mapTsServerFixHintCandidates(syntaxDiagnostics, {
            scope,
            source: "typescript",
            category: "syntax",
          }),
          ...mapTsServerFixHintCandidates(semanticDiagnostics, {
            scope,
            source: "typescript",
            category: "semantic",
          }),
          ...mapTsServerFixHintCandidates(suggestionDiagnostics, {
            scope,
            source: "typescript",
            category: "suggestion",
          }),
        );
      }

      for (const configPath of configPaths) {
        diagnostics.push(
          ...mapTsServerDiagnostics(
            await transport.getCompilerOptionsDiagnostics(configPath),
            {
              cwd,
              category: "config",
              scope: "config",
              source: inferConfigSource(configPath),
              fallbackPath: configPath,
            },
          ),
        );
      }

      const configEvents = extractConfigFileDiagnosticEvents(transport.getEventsSince(cursor));
      const processedSet = new Set(processedPaths.map(normalizeComparisonPath));
      diagnostics.push(
        ...configEvents
          .filter((event) => processedSet.has(normalizeComparisonPath(event.triggerFile)))
          .flatMap((event) => mapConfigEventDiagnostics(event, cwd)),
      );

      const availability = buildAvailability({
        modes: new Set(processedPaths.map((targetPath) =>
          infoByPath.get(targetPath)?.isInferredProject ? "single_file_fallback" : "project"
        )),
        configPaths: uniquePaths([
          ...configPaths,
          ...configEvents.map((event) => event.configFile),
        ]),
        fallbackCount: processedPaths.filter((targetPath) => infoByPath.get(targetPath)?.isInferredProject).length,
        processedCount: processedPaths.length,
        diagnosticCount: diagnostics.length,
        transportAvailable: true,
      });
      const assist = await collectTsServerAssist({
        transport,
        candidates: fixHintCandidates,
      });

      return {
        availability,
        diagnostics: dedupeDiagnostics(diagnostics),
        fixHints: assist.fixHints,
        codeActions: assist.codeActions,
        projectContext: assist.projectContext,
        processedPaths,
        skippedPaths,
      };
    } finally {
      await Promise.allSettled(processedPaths.map((targetPath) => transport.closeFile(targetPath)));
    }
  }

  private async getTransport(cwd: string): Promise<TsServerTransport> {
    const resolvedCwd = path.resolve(cwd);
    if (this.transport && this.transportCwd === resolvedCwd) {
      return this.transport;
    }
    await this.disposeTransport();
    this.transport = new TsServerTransport({
      ...this.transportOptions,
      cwd: resolvedCwd,
    });
    this.transportCwd = resolvedCwd;
    return this.transport;
  }

  private async disposeTransport(): Promise<void> {
    if (!this.transport) {
      this.transportCwd = null;
      return;
    }
    try {
      await this.transport.close();
    } finally {
      this.transport = null;
      this.transportCwd = null;
    }
  }
}

function collectCompilerApiDiagnostics(
  supportedTargets: string[],
  cwd: string,
): CompilerApiDiagnosticBatch {
  const configGroups = new Map<string, string[]>();
  const fallbackTargets: string[] = [];
  for (const targetPath of supportedTargets) {
    const configPath = findNearestProjectConfig(targetPath, cwd);
    if (configPath) {
      const grouped = configGroups.get(configPath) ?? [];
      grouped.push(targetPath);
      configGroups.set(configPath, grouped);
      continue;
    }
    fallbackTargets.push(targetPath);
  }

  const batches: ProjectDiagnosticBatch[] = [];
  const skippedPaths: DiagnosticSkipPath[] = [];
  for (const [configPath, targetPaths] of configGroups.entries()) {
    batches.push(collectProjectDiagnostics(configPath, targetPaths, cwd));
  }

  for (const targetPath of fallbackTargets.slice(0, MAX_FALLBACK_TARGETS)) {
    batches.push(collectFallbackDiagnostics(targetPath, cwd));
  }
  for (const targetPath of fallbackTargets.slice(MAX_FALLBACK_TARGETS)) {
    skippedPaths.push({
      path: targetPath,
      reason: `Skipped because diagnostics fallback is capped at ${MAX_FALLBACK_TARGETS} targets.`,
    });
  }

  const diagnostics = dedupeDiagnostics(batches.flatMap((batch) => batch.diagnostics));
  const processedPaths = uniquePaths(batches.flatMap((batch) => batch.processedPaths));
  return {
    availability: buildAvailability({
      modes: new Set(batches.map((batch) => batch.mode)),
      configPaths: batches
        .map((batch) => batch.configPath)
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
      fallbackCount: fallbackTargets.length,
      processedCount: processedPaths.length,
      diagnosticCount: diagnostics.length,
      transportAvailable: false,
    }),
    diagnostics,
    fixHints: createUnavailableFixHintCollection({
      reason: "Fix hints are unavailable because diagnostics fell back to the compiler API.",
      transportAvailable: false,
      fallbackUsed: true,
      fallbackReason: null,
    }),
    codeActions: createUnavailableCodeActionCollection({
      reason: "Code actions are unavailable because diagnostics fell back to the compiler API.",
      transportAvailable: false,
      fallbackUsed: true,
      fallbackReason: null,
    }),
    projectContext: createUnavailableProjectContextCollection({
      reason: "Project context is unavailable because diagnostics fell back to the compiler API.",
      transportAvailable: false,
      fallbackUsed: true,
      fallbackReason: null,
    }),
    processedPaths,
    skippedPaths: [
      ...skippedPaths,
      ...batches.flatMap((batch) => batch.skippedPaths),
    ],
  };
}

function collectProjectDiagnostics(
  configPath: string,
  requestedPaths: string[],
  cwd: string,
): ProjectDiagnosticBatch {
  const source = inferConfigSource(configPath);
  const configRead = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configRead.error) {
    return {
      diagnostics: [toDiagnosticRecord(configRead.error, {
        cwd,
        category: "config",
        scope: "config",
        source,
        fallbackPath: configPath,
      })],
      processedPaths: [],
      skippedPaths: requestedPaths.map((entry) => ({
        path: entry,
        reason: `Project config ${path.basename(configPath)} could not be parsed.`,
      })),
      mode: "project",
      configPath,
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    configRead.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );

  const includedTargets: string[] = [];
  const skippedPaths: DiagnosticSkipPath[] = [];
  const normalizedProgramFiles = new Set(parsed.fileNames.map(normalizeComparisonPath));
  for (const requestedPath of requestedPaths) {
    if (normalizedProgramFiles.has(normalizeComparisonPath(requestedPath))) {
      includedTargets.push(requestedPath);
    } else {
      skippedPaths.push({
        path: requestedPath,
        reason: `File is not included by ${path.basename(configPath)}.`,
      });
    }
  }

  const diagnostics: DiagnosticRecord[] = parsed.errors.map((diagnostic) =>
    toDiagnosticRecord(diagnostic, {
      cwd,
      category: "config",
      scope: "config",
      source,
      fallbackPath: configPath,
    })
  );

  if (includedTargets.length === 0) {
    return {
      diagnostics,
      processedPaths: [],
      skippedPaths,
      mode: "project",
      configPath,
    };
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });

  diagnostics.push(
    ...program.getOptionsDiagnostics().map((diagnostic) =>
      toDiagnosticRecord(diagnostic, {
        cwd,
        category: "config",
        scope: "config",
        source,
        fallbackPath: configPath,
      })
    ),
  );
  diagnostics.push(
    ...program.getGlobalDiagnostics().map((diagnostic) =>
      toDiagnosticRecord(diagnostic, {
        cwd,
        category: "project",
        scope: "project",
        source,
        fallbackPath: configPath,
      })
    ),
  );

  const processedPaths: string[] = [];
  for (const requestedPath of includedTargets) {
    const sourceFile = getProgramSourceFile(program, requestedPath);
    if (!sourceFile) {
      skippedPaths.push({
        path: requestedPath,
        reason: `TypeScript program did not materialize ${path.basename(requestedPath)}.`,
      });
      continue;
    }

    processedPaths.push(requestedPath);
    diagnostics.push(
      ...program.getSyntacticDiagnostics(sourceFile).map((diagnostic) =>
        toDiagnosticRecord(diagnostic, {
          cwd,
          category: "syntax",
          scope: "file",
          source: "typescript",
        })
      ),
    );
    diagnostics.push(
      ...program.getSemanticDiagnostics(sourceFile).map((diagnostic) =>
        toDiagnosticRecord(diagnostic, {
          cwd,
          category: "semantic",
          scope: "file",
          source: "typescript",
        })
      ),
    );
  }

  return {
    diagnostics,
    processedPaths,
    skippedPaths,
    mode: "project",
    configPath,
  };
}

function collectFallbackDiagnostics(
  filePath: string,
  cwd: string,
): ProjectDiagnosticBatch {
  const options = buildFallbackCompilerOptions(filePath);
  const program = ts.createProgram({
    rootNames: [filePath],
    options,
  });
  const sourceFile = getProgramSourceFile(program, filePath);
  if (!sourceFile) {
    return {
      diagnostics: [],
      processedPaths: [],
      skippedPaths: [{
        path: filePath,
        reason: "Single-file diagnostics fallback could not load the target file.",
      }],
      mode: "single_file_fallback",
      configPath: null,
    };
  }

  const diagnostics = [
    ...program.getOptionsDiagnostics().map((diagnostic) =>
      toDiagnosticRecord(diagnostic, {
        cwd,
        category: "config",
        scope: "fallback",
        source: "typescript",
      })
    ),
    ...program.getSyntacticDiagnostics(sourceFile).map((diagnostic) =>
      toDiagnosticRecord(diagnostic, {
        cwd,
        category: "syntax",
        scope: "fallback",
        source: "typescript",
      })
    ),
    ...program.getSemanticDiagnostics(sourceFile).map((diagnostic) =>
      toDiagnosticRecord(diagnostic, {
        cwd,
        category: "semantic",
        scope: "fallback",
        source: "typescript",
      })
    ),
  ];

  return {
    diagnostics,
    processedPaths: [filePath],
    skippedPaths: [],
    mode: "single_file_fallback",
    configPath: null,
  };
}

function mapTsServerFixHintCandidates(
  diagnostics: TsServerProtocolDiagnostic[],
  input: {
    source: DiagnosticSource;
    scope: DiagnosticScope;
    category: string;
  },
): TsServerFixHintCandidate[] {
  const candidates = new Map<string, TsServerFixHintCandidate>();
  for (const diagnostic of diagnostics) {
    const numericCode = parseNumericDiagnosticCode(diagnostic.code);
    if (
      typeof diagnostic.path !== "string" ||
      diagnostic.path.length === 0 ||
      diagnostic.line == null ||
      diagnostic.column == null ||
      numericCode == null
    ) {
      continue;
    }
    const fingerprint = createDiagnosticFingerprint({
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code,
      message: diagnostic.message,
      source: input.source,
      scope: input.scope,
      category: input.category,
      rule: diagnostic.source,
    });
    if (candidates.has(fingerprint.fingerprint)) {
      continue;
    }
    candidates.set(fingerprint.fingerprint, {
      filePath: path.resolve(diagnostic.path),
      startLine: diagnostic.line,
      startColumn: diagnostic.column,
      endLine: diagnostic.endLine ?? diagnostic.line,
      endColumn: diagnostic.endColumn ?? diagnostic.column,
      errorCode: numericCode,
      fingerprint,
      message: diagnostic.message,
    });
  }
  return [...candidates.values()];
}

async function collectTsServerAssist(input: {
  transport: TsServerTransport;
  candidates: TsServerFixHintCandidate[];
}): Promise<TsServerAssistCollection> {
  const candidates = [...input.candidates]
    .sort(compareTsServerFixHintCandidates)
    .slice(0, MAX_FIX_HINT_DIAGNOSTICS);
  const projectContext = await collectTsServerProjectContext({
    transport: input.transport,
    candidates,
  });
  if (candidates.length === 0) {
    return {
      fixHints: createTsServerFixHintCollection([]),
      codeActions: createTsServerCodeActionCollection([]),
      projectContext,
    };
  }

  const hints = new Map<string, FixHint>();
  const codeActions = new Map<string, CodeActionCandidate>();
  let partialFailureReason: string | null = null;
  for (const candidate of candidates) {
    try {
      const fixes = await input.transport.getCodeFixes({
        filePath: candidate.filePath,
        startLine: candidate.startLine,
        startOffset: candidate.startColumn,
        endLine: candidate.endLine,
        endOffset: candidate.endColumn,
        errorCodes: [candidate.errorCode],
      });
      for (const [index, fix] of fixes.entries()) {
        const hint = normalizeTsServerFixHint(fix, candidate, index === 0);
        mergeFixHint(hints, hint);
        const action = normalizeTsServerCodeAction({
          fix,
          diagnosticFingerprint: candidate.fingerprint.fingerprint,
          reason: candidate.message,
          recommended: index === 0,
        });
        mergeCodeActionCandidate(codeActions, action);
        if (hints.size >= MAX_FIX_HINTS) {
          break;
        }
      }
      if (hints.size >= MAX_FIX_HINTS) {
        break;
      }
    } catch (error) {
      partialFailureReason = describeTsServerFailure(error);
      break;
    }
  }

  if (hints.size === 0 && partialFailureReason) {
    return {
      fixHints: createUnavailableFixHintCollection({
        reason: `Fix hints are unavailable because tsserver code-fix requests failed: ${partialFailureReason}`,
        transportAvailable: false,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      codeActions: createUnavailableCodeActionCollection({
        reason: `Code actions are unavailable because tsserver code-fix requests failed: ${partialFailureReason}`,
        transportAvailable: false,
        fallbackUsed: false,
        fallbackReason: null,
      }),
      projectContext,
    };
  }

  const partialReason = partialFailureReason
    ? `Fix hints and code actions were partially collected before a tsserver code-fix request failed: ${partialFailureReason}`
    : null;
  return {
    fixHints: createTsServerFixHintCollection(
      [...hints.values()]
        .sort(compareFixHints)
        .slice(0, MAX_FIX_HINTS),
      partialReason,
    ),
    codeActions: createTsServerCodeActionCollection(
      [...codeActions.values()],
      partialReason,
    ),
    projectContext,
  };
}

async function collectTsServerProjectContext(input: {
  transport: TsServerTransport;
  candidates: TsServerFixHintCandidate[];
}): Promise<ProjectContextCollection> {
  const candidates = [...input.candidates]
    .sort(compareTsServerFixHintCandidates)
    .slice(0, MAX_PROJECT_CONTEXT_DIAGNOSTICS);
  if (candidates.length === 0) {
    return createTsServerProjectContextCollection([]);
  }

  const items = new Map<string, DiagnosticProjectContext>();
  const documentSymbolCache = new Map<string, Promise<TsServerProtocolDocumentSymbol[]>>();
  let partialFailureReason: string | null = null;
  for (const candidate of candidates) {
    try {
      const documentSymbolsPromise = getCachedDocumentSymbols(
        documentSymbolCache,
        input.transport,
        candidate.filePath,
      );
      const [quickInfo, definitions, references, directImplementations, documentSymbols] = await Promise.all([
        input.transport.getQuickInfo({
          filePath: candidate.filePath,
          line: candidate.startLine,
          offset: candidate.startColumn,
        }),
        input.transport.getDefinitions({
          filePath: candidate.filePath,
          line: candidate.startLine,
          offset: candidate.startColumn,
        }),
        input.transport.getReferences({
          filePath: candidate.filePath,
          line: candidate.startLine,
          offset: candidate.startColumn,
        }),
        input.transport.getImplementations({
          filePath: candidate.filePath,
          line: candidate.startLine,
          offset: candidate.startColumn,
        }),
        documentSymbolsPromise,
      ]);
      const implementations = await collectTsServerImplementations({
        transport: input.transport,
        candidate,
        directImplementations,
        definitions,
      });
      const item = normalizeDiagnosticProjectContext({
        candidate,
        quickInfo,
        definitions,
        implementations,
        references,
        documentSymbols,
      });
      if (!item) {
        continue;
      }
      items.set(candidate.fingerprint.fingerprint, item);
    } catch (error) {
      partialFailureReason = describeTsServerFailure(error);
      break;
    }
  }

  if (items.size === 0 && partialFailureReason) {
    return createUnavailableProjectContextCollection({
      reason: `Project context is unavailable because tsserver read-only symbol requests failed: ${partialFailureReason}`,
      transportAvailable: false,
      fallbackUsed: false,
      fallbackReason: null,
    });
  }

  return createTsServerProjectContextCollection(
    [...items.values()].sort(compareDiagnosticProjectContexts),
    partialFailureReason
      ? `Project context was partially collected before a tsserver read-only symbol request failed: ${partialFailureReason}`
      : null,
  );
}

function getCachedDocumentSymbols(
  cache: Map<string, Promise<TsServerProtocolDocumentSymbol[]>>,
  transport: TsServerTransport,
  filePath: string,
): Promise<TsServerProtocolDocumentSymbol[]> {
  const resolvedPath = path.resolve(filePath);
  const cached = cache.get(resolvedPath);
  if (cached) {
    return cached;
  }
  const symbolsPromise = transport.getDocumentSymbols(resolvedPath);
  cache.set(resolvedPath, symbolsPromise);
  return symbolsPromise;
}

async function collectTsServerImplementations(input: {
  transport: TsServerTransport;
  candidate: TsServerFixHintCandidate;
  directImplementations: TsServerProtocolImplementation[];
  definitions: TsServerProtocolDefinition[];
}): Promise<TsServerProtocolImplementation[]> {
  const implementations = dedupeTsServerProtocolImplementations(input.directImplementations);
  if (implementations.length > 0 || input.definitions.length === 0) {
    return implementations;
  }

  const prioritizedDefinitions = [...input.definitions]
    .sort((left, right) => compareTsServerDefinitionsForCandidate(input.candidate, left, right))
    .slice(0, MAX_PROJECT_CONTEXT_DEFINITIONS);
  for (const definition of prioritizedDefinitions) {
    if (!definition.path || definition.line == null || definition.column == null) {
      continue;
    }
    const additional = await input.transport.getImplementations({
      filePath: definition.path,
      line: definition.line,
      offset: definition.column,
    });
    implementations.push(
      ...additional.filter((entry) => !hasMatchingImplementation(implementations, entry)),
    );
    if (implementations.length >= MAX_PROJECT_CONTEXT_IMPLEMENTATIONS) {
      break;
    }
  }
  return implementations;
}

function normalizeTsServerFixHint(
  fix: TsServerProtocolCodeFix,
  candidate: TsServerFixHintCandidate,
  recommended: boolean,
): FixHint {
  const edits = fix.changes
    .slice(0, MAX_FIX_HINT_FILES)
    .map((change) => toFixHintEditPreview(change));
  const filePaths = uniquePaths(
    edits
      .map((change) => change.path)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const hint: FixHint = {
    id: "",
    source: "tsserver",
    title: fix.description,
    kind: fix.fixId ? "fix_all" : "quickfix",
    reason: candidate.message,
    recommended,
    diagnosticFingerprints: [candidate.fingerprint.fingerprint],
    filePaths,
    edits,
    fixName: fix.fixName,
    fixId: fix.fixId,
  };
  return {
    ...hint,
    id: createFixHintId(hint),
  };
}

function toFixHintEditPreview(
  change: TsServerProtocolCodeFix["changes"][number],
): FixHintEditPreview {
  return {
    path: change.path,
    isNewFile: change.isNewFile,
    changeCount: change.changeCount,
    changes: change.changes.slice(0, MAX_FIX_HINT_CHANGES).map((entry) => toFixHintEditChangePreview(entry)),
  };
}

function toFixHintEditChangePreview(
  change: TsServerProtocolCodeFix["changes"][number]["changes"][number],
): FixHintEditChangePreview {
  return {
    startLine: change.startLine,
    startColumn: change.startColumn,
    endLine: change.endLine,
    endColumn: change.endColumn,
    newTextPreview: summarizeText(change.newText, MAX_FIX_HINT_TEXT_PREVIEW),
    newTextLength: change.newText.length,
  };
}

function createTsServerFixHintCollection(
  hints: FixHint[],
  reason: string | null = null,
): FixHintCollection {
  const fileCount = uniquePaths(
    hints.flatMap((hint) => hint.filePaths),
  ).length;
  const recommendedCount = hints.filter((hint) => hint.recommended).length;
  return {
    availability: {
      available: true,
      source: "tsserver",
      reason,
      transportAvailable: true,
      fallbackUsed: false,
      fallbackReason: null,
    },
    hints,
    summary: {
      total: hints.length,
      recommendedCount,
      fileCount,
      available: true,
      source: "tsserver",
      reason,
    },
  };
}

function createUnavailableFixHintCollection(input: {
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

function createTsServerProjectContextCollection(
  items: DiagnosticProjectContext[],
  reason: string | null = null,
): ProjectContextCollection {
  const fileCount = uniquePaths(
    items.flatMap((item) => [
      item.path,
      ...item.definitions.map((entry) => entry.path),
      ...item.implementations.map((entry) => entry.path),
      ...item.references.map((entry) => entry.path),
      ...item.documentSymbols.map((entry) => entry.path),
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)),
  ).length;
  const quickInfoCount = items.filter((item) => item.quickInfo != null).length;
  const definitionCount = items.reduce((total, item) => total + item.definitions.length, 0);
  const implementationCount = items.reduce((total, item) => total + item.implementationCount, 0);
  const referenceCount = items.reduce((total, item) => total + item.referenceCount, 0);
  const documentSymbolCount = items.reduce((total, item) => total + item.documentSymbolCount, 0);
  return {
    availability: {
      available: true,
      source: "tsserver",
      reason,
      transportAvailable: true,
      fallbackUsed: false,
      fallbackReason: null,
    },
    items,
    summary: {
      total: items.length,
      diagnosticCoverageCount: items.length,
      quickInfoCount,
      definitionCount,
      implementationCount,
      referenceCount,
      documentSymbolCount,
      fileCount,
      available: true,
      source: "tsserver",
      reason,
    },
  };
}

function createUnavailableProjectContextCollection(input: {
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

function withFixHintFallbackReason(
  collection: FixHintCollection,
  fallbackReason: string | null,
): FixHintCollection {
  if (!collection.availability.fallbackUsed) {
    return collection;
  }
  return {
    availability: {
      ...collection.availability,
      fallbackReason,
    },
    hints: collection.hints.map((hint) => ({
      ...hint,
      diagnosticFingerprints: [...hint.diagnosticFingerprints],
      filePaths: [...hint.filePaths],
      edits: hint.edits.map((edit) => ({
        ...edit,
        changes: edit.changes.map((change) => ({ ...change })),
      })),
    })),
    summary: {
      ...collection.summary,
    },
  };
}

function withProjectContextFallbackReason(
  collection: ProjectContextCollection,
  fallbackReason: string | null,
): ProjectContextCollection {
  if (!collection.availability.fallbackUsed) {
    return collection;
  }
  return {
    availability: {
      ...collection.availability,
      fallbackReason,
    },
    items: collection.items.map((item) => ({
      ...item,
      quickInfo: item.quickInfo ? { ...item.quickInfo } : null,
      definitions: item.definitions.map((entry) => ({ ...entry })),
      implementations: item.implementations.map((entry) => ({ ...entry })),
      references: item.references.map((entry) => ({ ...entry })),
      enclosingSymbol: item.enclosingSymbol ? { ...item.enclosingSymbol } : null,
      documentSymbols: item.documentSymbols.map((entry) => ({ ...entry })),
    })),
    summary: {
      ...collection.summary,
    },
  };
}

function withCodeActionFallbackReason(
  collection: CodeActionCollection,
  fallbackReason: string | null,
): CodeActionCollection {
  if (!collection.availability.fallbackUsed) {
    return collection;
  }
  return {
    availability: {
      ...collection.availability,
      fallbackReason,
    },
    actions: collection.actions.map((action) => ({
      ...action,
      diagnosticFingerprints: [...action.diagnosticFingerprints],
      filePaths: [...action.filePaths],
      edits: action.edits.map((edit) => ({
        ...edit,
        changes: edit.changes.map((change) => ({ ...change })),
      })),
    })),
    summary: {
      ...collection.summary,
    },
  };
}

function createFixHintId(hint: Omit<FixHint, "id">): string {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify([
      hint.source,
      hint.title,
      hint.kind,
      hint.reason,
      hint.fixName,
      hint.fixId,
      [...hint.diagnosticFingerprints].sort(),
      [...hint.filePaths].sort(),
      hint.edits,
    ]))
    .digest("hex");
}

function normalizeDiagnosticProjectContext(input: {
  candidate: TsServerFixHintCandidate;
  quickInfo: TsServerProtocolQuickInfo | null;
  definitions: TsServerProtocolDefinition[];
  implementations: TsServerProtocolImplementation[];
  references: TsServerProtocolReference[];
  documentSymbols: TsServerProtocolDocumentSymbol[];
}): DiagnosticProjectContext | null {
  const quickInfo = input.quickInfo ? toProjectContextQuickInfo(input.quickInfo) : null;
  const definitions = dedupeProjectContextDefinitions(
    [...input.definitions]
      .sort((left, right) => compareTsServerDefinitionsForCandidate(input.candidate, left, right))
      .slice(0, MAX_PROJECT_CONTEXT_DEFINITIONS)
      .map((definition) => toProjectContextDefinition(definition)),
  );
  const implementationCount = input.implementations.length;
  const implementations = dedupeProjectContextImplementations(
    [...input.implementations]
      .sort((left, right) => compareTsServerImplementationsForCandidate(input.candidate, left, right))
      .slice(0, MAX_PROJECT_CONTEXT_IMPLEMENTATIONS)
      .map((implementation) => toProjectContextImplementation(implementation)),
  );
  const referenceCount = input.references.length;
  const references = dedupeProjectContextReferences(
    [...input.references]
      .sort((left, right) => compareTsServerReferencesForCandidate(input.candidate, left, right))
      .slice(0, MAX_PROJECT_CONTEXT_REFERENCES)
      .map((reference) => toProjectContextReference(reference)),
  );
  const prioritizedDocumentSymbols = prioritizeDocumentSymbolsForCandidate({
    candidate: input.candidate,
    documentSymbols: input.documentSymbols,
  });
  if (
    !quickInfo
    && definitions.length === 0
    && implementations.length === 0
    && references.length === 0
    && prioritizedDocumentSymbols.symbols.length === 0
  ) {
    return null;
  }
  return {
    diagnosticFingerprint: input.candidate.fingerprint.fingerprint,
    path: input.candidate.fingerprint.path,
    line: input.candidate.fingerprint.line,
    column: input.candidate.fingerprint.column,
    code: input.candidate.fingerprint.code,
    message: input.candidate.fingerprint.message,
    source: input.candidate.fingerprint.source,
    scope: input.candidate.fingerprint.scope,
    quickInfo,
    definitions,
    implementations,
    implementationCount,
    implementationsTruncated: implementationCount > implementations.length,
    references,
    referenceCount,
    referencesTruncated: referenceCount > references.length,
    enclosingSymbol: prioritizedDocumentSymbols.enclosingSymbol,
    documentSymbols: prioritizedDocumentSymbols.symbols,
    documentSymbolCount: prioritizedDocumentSymbols.totalCount,
    documentSymbolsTruncated: prioritizedDocumentSymbols.truncated,
  };
}

function toProjectContextQuickInfo(
  quickInfo: TsServerProtocolQuickInfo,
): ProjectContextQuickInfo {
  return {
    kind: quickInfo.kind,
    kindModifiers: quickInfo.kindModifiers,
    displayText: quickInfo.displayText,
    documentation: quickInfo.documentation,
    path: null,
    line: quickInfo.startLine,
    column: quickInfo.startColumn,
    endLine: quickInfo.endLine,
    endColumn: quickInfo.endColumn,
  };
}

function toProjectContextDefinition(
  definition: TsServerProtocolDefinition,
): ProjectContextDefinition {
  return {
    path: definition.path,
    line: definition.line,
    column: definition.column,
    endLine: definition.endLine,
    endColumn: definition.endColumn,
    kind: definition.kind,
    name: definition.name,
    containerName: definition.containerName,
  };
}

function toProjectContextImplementation(
  implementation: TsServerProtocolImplementation,
): ProjectContextImplementation {
  return {
    path: implementation.path,
    line: implementation.line,
    column: implementation.column,
    endLine: implementation.endLine,
    endColumn: implementation.endColumn,
    contextStartLine: implementation.contextStartLine,
    contextStartColumn: implementation.contextStartColumn,
    contextEndLine: implementation.contextEndLine,
    contextEndColumn: implementation.contextEndColumn,
  };
}

function toProjectContextReference(
  reference: TsServerProtocolReference,
): ProjectContextReference {
  return {
    path: reference.path,
    line: reference.line,
    column: reference.column,
    endLine: reference.endLine,
    endColumn: reference.endColumn,
    lineText: summarizeText(reference.lineText ?? "", MAX_PROJECT_CONTEXT_LINE_PREVIEW) || null,
    isDefinition: reference.isDefinition,
    isWriteAccess: reference.isWriteAccess,
  };
}

function toProjectContextDocumentSymbol(
  documentSymbol: TsServerProtocolDocumentSymbol,
): ProjectContextDocumentSymbol {
  return {
    path: documentSymbol.path,
    line: documentSymbol.line,
    column: documentSymbol.column,
    endLine: documentSymbol.endLine,
    endColumn: documentSymbol.endColumn,
    name: documentSymbol.name,
    kind: documentSymbol.kind,
    kindModifiers: documentSymbol.kindModifiers,
    containerName: documentSymbol.containerName,
    depth: documentSymbol.depth,
    childCount: documentSymbol.childCount,
  };
}

function dedupeProjectContextDefinitions(
  definitions: ProjectContextDefinition[],
): ProjectContextDefinition[] {
  const seen = new Map<string, ProjectContextDefinition>();
  for (const definition of definitions) {
    const key = JSON.stringify([
      definition.path,
      definition.line,
      definition.column,
      definition.endLine,
      definition.endColumn,
      definition.kind,
      definition.name,
      definition.containerName,
    ]);
    if (!seen.has(key)) {
      seen.set(key, definition);
    }
  }
  return [...seen.values()];
}

function dedupeProjectContextImplementations(
  implementations: ProjectContextImplementation[],
): ProjectContextImplementation[] {
  const seen = new Map<string, ProjectContextImplementation>();
  for (const implementation of implementations) {
    const key = JSON.stringify([
      implementation.path,
      implementation.line,
      implementation.column,
      implementation.endLine,
      implementation.endColumn,
      implementation.contextStartLine,
      implementation.contextStartColumn,
      implementation.contextEndLine,
      implementation.contextEndColumn,
    ]);
    if (!seen.has(key)) {
      seen.set(key, implementation);
    }
  }
  return [...seen.values()];
}

function dedupeProjectContextReferences(
  references: ProjectContextReference[],
): ProjectContextReference[] {
  const seen = new Map<string, ProjectContextReference>();
  for (const reference of references) {
    const key = JSON.stringify([
      reference.path,
      reference.line,
      reference.column,
      reference.endLine,
      reference.endColumn,
      reference.isDefinition,
      reference.isWriteAccess,
      reference.lineText,
    ]);
    if (!seen.has(key)) {
      seen.set(key, reference);
    }
  }
  return [...seen.values()];
}

function dedupeProjectContextDocumentSymbols(
  documentSymbols: ProjectContextDocumentSymbol[],
): ProjectContextDocumentSymbol[] {
  const seen = new Map<string, ProjectContextDocumentSymbol>();
  for (const documentSymbol of documentSymbols) {
    const key = JSON.stringify([
      documentSymbol.path,
      documentSymbol.line,
      documentSymbol.column,
      documentSymbol.endLine,
      documentSymbol.endColumn,
      documentSymbol.name,
      documentSymbol.kind,
      documentSymbol.kindModifiers,
      documentSymbol.containerName,
      documentSymbol.depth,
    ]);
    if (!seen.has(key)) {
      seen.set(key, documentSymbol);
    }
  }
  return [...seen.values()];
}

function prioritizeDocumentSymbolsForCandidate(input: {
  candidate: TsServerFixHintCandidate;
  documentSymbols: TsServerProtocolDocumentSymbol[];
}): {
  enclosingSymbol: ProjectContextDocumentSymbol | null;
  symbols: ProjectContextDocumentSymbol[];
  totalCount: number;
  truncated: boolean;
} {
  const prioritized = dedupeProjectContextDocumentSymbols(
    input.documentSymbols
      .filter((documentSymbol) => documentSymbol.path === input.candidate.filePath)
      .sort((left, right) => compareDocumentSymbolsForCandidate(input.candidate, left, right))
      .map((documentSymbol) => toProjectContextDocumentSymbol(documentSymbol)),
  );
  const containingSymbols = prioritized
    .filter((documentSymbol) => projectContextLocationContains(documentSymbol, input.candidate.startLine, input.candidate.startColumn))
    .sort((left, right) => compareContainingDocumentSymbols(left, right));
  return {
    enclosingSymbol: containingSymbols[0] ?? null,
    symbols: prioritized.slice(0, MAX_PROJECT_CONTEXT_DOCUMENT_SYMBOLS),
    totalCount: prioritized.length,
    truncated: prioritized.length > MAX_PROJECT_CONTEXT_DOCUMENT_SYMBOLS,
  };
}

function compareTsServerFixHintCandidates(
  left: TsServerFixHintCandidate,
  right: TsServerFixHintCandidate,
): number {
  return compareComparableLists(
    [
      left.filePath,
      left.startLine,
      left.startColumn,
      left.errorCode,
      left.message,
      left.fingerprint.fingerprint,
    ],
    [
      right.filePath,
      right.startLine,
      right.startColumn,
      right.errorCode,
      right.message,
      right.fingerprint.fingerprint,
    ],
  );
}

function compareTsServerDefinitionsForCandidate(
  candidate: TsServerFixHintCandidate,
  left: TsServerProtocolDefinition,
  right: TsServerProtocolDefinition,
): number {
  return compareComparableLists(
    [
      left.path !== candidate.filePath ? 1 : 0,
      lineDistance(left.line, candidate.startLine),
      left.path ?? "",
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
      left.name ?? "",
      left.kind ?? "",
    ],
    [
      right.path !== candidate.filePath ? 1 : 0,
      lineDistance(right.line, candidate.startLine),
      right.path ?? "",
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
      right.name ?? "",
      right.kind ?? "",
    ],
  );
}

function compareTsServerImplementationsForCandidate(
  candidate: TsServerFixHintCandidate,
  left: TsServerProtocolImplementation,
  right: TsServerProtocolImplementation,
): number {
  return compareComparableLists(
    [
      left.path !== candidate.filePath ? 1 : 0,
      lineDistance(left.line, candidate.startLine),
      left.path ?? "",
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
    ],
    [
      right.path !== candidate.filePath ? 1 : 0,
      lineDistance(right.line, candidate.startLine),
      right.path ?? "",
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
    ],
  );
}

function compareTsServerReferencesForCandidate(
  candidate: TsServerFixHintCandidate,
  left: TsServerProtocolReference,
  right: TsServerProtocolReference,
): number {
  return compareComparableLists(
    [
      left.path !== candidate.filePath ? 1 : 0,
      left.isDefinition ? 1 : 0,
      lineDistance(left.line, candidate.startLine),
      left.path ?? "",
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
      left.isWriteAccess ? 0 : 1,
    ],
    [
      right.path !== candidate.filePath ? 1 : 0,
      right.isDefinition ? 1 : 0,
      lineDistance(right.line, candidate.startLine),
      right.path ?? "",
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
      right.isWriteAccess ? 0 : 1,
    ],
  );
}

function compareDocumentSymbolsForCandidate(
  candidate: TsServerFixHintCandidate,
  left: TsServerProtocolDocumentSymbol,
  right: TsServerProtocolDocumentSymbol,
): number {
  const leftContains = protocolLocationContains(left, candidate.startLine, candidate.startColumn);
  const rightContains = protocolLocationContains(right, candidate.startLine, candidate.startColumn);
  return compareComparableLists(
    [
      leftContains ? 0 : 1,
      leftContains ? -left.depth : 0,
      lineDistance(left.line, candidate.startLine),
      left.depth,
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
      left.name ?? "",
      left.kind ?? "",
    ],
    [
      rightContains ? 0 : 1,
      rightContains ? -right.depth : 0,
      lineDistance(right.line, candidate.startLine),
      right.depth,
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
      right.name ?? "",
      right.kind ?? "",
    ],
  );
}

function compareContainingDocumentSymbols(
  left: ProjectContextDocumentSymbol,
  right: ProjectContextDocumentSymbol,
): number {
  return compareComparableLists(
    [
      -left.depth,
      left.line ?? Number.MAX_SAFE_INTEGER,
      left.column ?? Number.MAX_SAFE_INTEGER,
      left.name ?? "",
      left.kind ?? "",
    ],
    [
      -right.depth,
      right.line ?? Number.MAX_SAFE_INTEGER,
      right.column ?? Number.MAX_SAFE_INTEGER,
      right.name ?? "",
      right.kind ?? "",
    ],
  );
}

function protocolLocationContains(
  location: TsServerProtocolDocumentSymbol,
  line: number,
  column: number,
): boolean {
  if (location.line == null || location.endLine == null) {
    return false;
  }
  if (line < location.line || line > location.endLine) {
    return false;
  }
  if (line === location.line && location.column != null && column < location.column) {
    return false;
  }
  if (line === location.endLine && location.endColumn != null && column > location.endColumn) {
    return false;
  }
  return true;
}

function projectContextLocationContains(
  location: ProjectContextDocumentSymbol,
  line: number,
  column: number,
): boolean {
  if (location.line == null || location.endLine == null) {
    return false;
  }
  if (line < location.line || line > location.endLine) {
    return false;
  }
  if (line === location.line && location.column != null && column < location.column) {
    return false;
  }
  if (line === location.endLine && location.endColumn != null && column > location.endColumn) {
    return false;
  }
  return true;
}

function dedupeTsServerProtocolImplementations(
  implementations: TsServerProtocolImplementation[],
): TsServerProtocolImplementation[] {
  const seen = new Map<string, TsServerProtocolImplementation>();
  for (const implementation of implementations) {
    const key = JSON.stringify([
      implementation.path,
      implementation.line,
      implementation.column,
      implementation.endLine,
      implementation.endColumn,
      implementation.contextStartLine,
      implementation.contextStartColumn,
      implementation.contextEndLine,
      implementation.contextEndColumn,
    ]);
    if (!seen.has(key)) {
      seen.set(key, implementation);
    }
  }
  return [...seen.values()];
}

function hasMatchingImplementation(
  implementations: TsServerProtocolImplementation[],
  candidate: TsServerProtocolImplementation,
): boolean {
  return implementations.some((implementation) =>
    implementation.path === candidate.path &&
    implementation.line === candidate.line &&
    implementation.column === candidate.column &&
    implementation.endLine === candidate.endLine &&
    implementation.endColumn === candidate.endColumn &&
    implementation.contextStartLine === candidate.contextStartLine &&
    implementation.contextStartColumn === candidate.contextStartColumn &&
    implementation.contextEndLine === candidate.contextEndLine &&
    implementation.contextEndColumn === candidate.contextEndColumn,
  );
}

function lineDistance(line: number | null, targetLine: number): number {
  return typeof line === "number"
    ? Math.abs(line - targetLine)
    : Number.MAX_SAFE_INTEGER;
}

function compareComparableLists(
  left: Array<string | number>,
  right: Array<string | number>,
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return leftValue - rightValue;
    }
    return `${leftValue}`.localeCompare(`${rightValue}`);
  }
  return 0;
}

function compareDiagnosticProjectContexts(
  left: DiagnosticProjectContext,
  right: DiagnosticProjectContext,
): number {
  return JSON.stringify([
    left.path,
    left.line,
    left.column,
    left.code,
    left.message,
  ]).localeCompare(JSON.stringify([
    right.path,
    right.line,
    right.column,
    right.code,
    right.message,
  ]));
}

function mergeFixHint(
  collection: Map<string, FixHint>,
  hint: FixHint,
): void {
  const existing = collection.get(hint.id);
  if (!existing) {
    collection.set(hint.id, hint);
    return;
  }

  existing.recommended ||= hint.recommended;
  existing.reason ??= hint.reason;
  existing.diagnosticFingerprints = [...new Set([
    ...existing.diagnosticFingerprints,
    ...hint.diagnosticFingerprints,
  ])].sort();
  existing.filePaths = uniquePaths([
    ...existing.filePaths,
    ...hint.filePaths,
  ]);
}

function compareFixHints(left: FixHint, right: FixHint): number {
  if (left.recommended !== right.recommended) {
    return left.recommended ? -1 : 1;
  }
  const leftPath = left.filePaths[0] ?? "";
  const rightPath = right.filePaths[0] ?? "";
  return leftPath.localeCompare(rightPath) || left.title.localeCompare(right.title);
}

function parseNumericDiagnosticCode(code: string | null): number | null {
  if (typeof code !== "string" || code.length === 0) {
    return null;
  }
  const numeric = Number.parseInt(code, 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildCollectionResult(input: {
  availability: DiagnosticProviderAvailability;
  engine: DiagnosticEngine | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  diagnostics: DiagnosticRecord[];
  fixHints: FixHintCollection;
  codeActions: CodeActionCollection;
  projectContext: ProjectContextCollection;
  processedPaths: string[];
  skippedPaths: DiagnosticSkipPath[];
  targetCount: number;
}): DiagnosticCollectionResult {
  const summary = buildDiagnosticSummary({
    diagnostics: input.diagnostics,
    fixHints: input.fixHints,
    codeActions: input.codeActions,
    projectContext: input.projectContext,
    availability: input.availability,
    targetCount: input.targetCount,
    processedTargetCount: input.processedPaths.length,
    skippedTargetCount: input.skippedPaths.length,
    engine: input.engine,
    fallbackUsed: input.fallbackUsed,
    fallbackReason: input.fallbackReason,
  });

  return {
    availability: input.availability,
    engine: input.engine,
    fallbackUsed: input.fallbackUsed,
    fallbackReason: input.fallbackReason,
    diagnostics: input.diagnostics,
    fixHints: input.fixHints,
    codeActions: input.codeActions,
    projectContext: input.projectContext,
    summary,
    processedPaths: uniquePaths(input.processedPaths),
    skippedPaths: input.skippedPaths.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    })),
  };
}

function buildDiagnosticSummary(input: {
  diagnostics: DiagnosticRecord[];
  fixHints: FixHintCollection;
  codeActions: CodeActionCollection;
  projectContext: ProjectContextCollection;
  availability: DiagnosticProviderAvailability;
  targetCount: number;
  processedTargetCount: number;
  skippedTargetCount: number;
  engine: DiagnosticEngine | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}): DiagnosticSummary {
  const errorCount = input.diagnostics.filter((entry) => entry.severity === "error").length;
  const warningCount = input.diagnostics.filter((entry) => entry.severity === "warning").length;
  const infoCount = input.diagnostics.filter((entry) => entry.severity === "info").length;

  return {
    total: input.diagnostics.length,
    errorCount,
    warningCount,
    infoCount,
    targetCount: input.targetCount,
    processedTargetCount: input.processedTargetCount,
    skippedTargetCount: input.skippedTargetCount,
    providerAvailable: input.availability.available,
    mode: input.availability.mode,
    engine: input.engine,
    fallbackUsed: input.fallbackUsed,
    fallbackReason: input.fallbackReason,
    transportAvailable: input.availability.transportAvailable,
    fixHintCount: input.fixHints.summary.total,
    recommendedFixHintCount: input.fixHints.summary.recommendedCount,
    fixHintFileCount: input.fixHints.summary.fileCount,
    fixHintAvailable: input.fixHints.summary.available,
    fixHintSource: input.fixHints.summary.source,
    fixHintReason: input.fixHints.summary.reason,
    codeActionCandidateCount: input.codeActions.summary.total,
    codeActionAllowlistedCount: input.codeActions.summary.allowlistedCount,
    codeActionBlockedCount: input.codeActions.summary.blockedCount,
    codeActionAvailable: input.codeActions.summary.available,
    codeActionSource: input.codeActions.summary.source,
    codeActionReason: input.codeActions.summary.reason,
    projectContextCount: input.projectContext.summary.total,
    projectContextDiagnosticCoverageCount: input.projectContext.summary.diagnosticCoverageCount,
    projectContextQuickInfoCount: input.projectContext.summary.quickInfoCount,
    projectContextDefinitionCount: input.projectContext.summary.definitionCount,
    projectContextImplementationCount: input.projectContext.summary.implementationCount,
    projectContextReferenceCount: input.projectContext.summary.referenceCount,
    projectContextDocumentSymbolCount: input.projectContext.summary.documentSymbolCount,
    projectContextFileCount: input.projectContext.summary.fileCount,
    projectContextAvailable: input.projectContext.summary.available,
    projectContextSource: input.projectContext.summary.source,
    projectContextReason: input.projectContext.summary.reason,
  };
}

function buildAvailability(input: {
  modes: Set<Exclude<DiagnosticProviderAvailability["mode"], "unavailable">>;
  configPaths: string[];
  fallbackCount: number;
  processedCount: number;
  diagnosticCount: number;
  transportAvailable: boolean;
}): DiagnosticProviderAvailability {
  const mode = resolveAvailabilityMode(input.modes);
  const available = mode !== "unavailable";
  const reason = available
    ? input.fallbackCount > 0 && input.configPaths.length === 0
      ? "No project config was found for the requested files, so single-file fallback diagnostics were used."
      : input.fallbackCount > 0
        ? "Project diagnostics ran for some files and single-file fallback was used for files without a project config."
        : input.processedCount === 0 && input.diagnosticCount === 0
          ? "No requested files could be processed by the diagnostics provider."
          : null
    : "Diagnostics provider could not find any supported targets.";

  return {
    available,
    provider: "typescript",
    mode,
    reason,
    configPaths: uniquePaths(input.configPaths),
    supportedExtensions: [...SUPPORTED_EXTENSIONS],
    transportAvailable: input.transportAvailable,
  };
}

function resolveAvailabilityMode(
  modes: Set<Exclude<DiagnosticProviderAvailability["mode"], "unavailable">>,
): DiagnosticProviderAvailability["mode"] {
  if (modes.size === 0) {
    return "unavailable";
  }
  if (modes.has("project") && modes.has("single_file_fallback")) {
    return "mixed";
  }
  if (modes.has("project")) {
    return "project";
  }
  return "single_file_fallback";
}

function mapTsServerDiagnostics(
  diagnostics: TsServerProtocolDiagnostic[],
  input: {
    cwd: string;
    category: string;
    scope: DiagnosticScope;
    source: DiagnosticSource;
    fallbackPath?: string | null;
  },
): DiagnosticRecord[] {
  return diagnostics.map((diagnostic) => ({
    path: diagnostic.path ? path.resolve(diagnostic.path) : input.fallbackPath ?? null,
    line: diagnostic.line,
    column: diagnostic.column,
    severity: mapProtocolDiagnosticSeverity(diagnostic.category),
    code: diagnostic.code,
    message: diagnostic.message,
    source: input.source,
    scope: input.scope,
    category: input.category,
    rule: diagnostic.source,
    related: diagnostic.related.map((entry) => ({
      path: entry.path ? path.resolve(entry.path) : null,
      line: entry.line,
      column: entry.column,
      message: entry.message,
    })),
  }));
}

function mapConfigEventDiagnostics(
  event: TsServerConfigDiagnosticEvent,
  cwd: string,
): DiagnosticRecord[] {
  return mapTsServerDiagnostics(event.diagnostics, {
    cwd,
    category: "config",
    scope: "config",
    source: inferConfigSource(event.configFile),
    fallbackPath: event.configFile,
  });
}

function toDiagnosticRecord(
  diagnostic: ts.Diagnostic,
  input: {
    cwd: string;
    category: string;
    scope: DiagnosticScope;
    source: DiagnosticSource;
    fallbackPath?: string | null;
  },
): DiagnosticRecord {
  const lineInfo = diagnostic.file && diagnostic.start != null
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    : null;
  const diagnosticPath = diagnostic.file?.fileName ?? input.fallbackPath ?? null;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

  return {
    path: diagnosticPath ? path.resolve(diagnosticPath) : null,
    line: lineInfo ? lineInfo.line + 1 : null,
    column: lineInfo ? lineInfo.character + 1 : null,
    severity: mapDiagnosticSeverity(diagnostic.category),
    code: diagnostic.code != null ? `${diagnostic.code}` : null,
    message,
    source: input.source,
    scope: input.scope,
    category: input.category,
    rule: typeof diagnostic.source === "string" ? diagnostic.source : null,
    related: (diagnostic.relatedInformation ?? []).map((entry) => {
      const relatedLine = entry.file && entry.start != null
        ? entry.file.getLineAndCharacterOfPosition(entry.start)
        : null;
      return {
        path: entry.file?.fileName ? path.resolve(entry.file.fileName) : null,
        line: relatedLine ? relatedLine.line + 1 : null,
        column: relatedLine ? relatedLine.character + 1 : null,
        message: ts.flattenDiagnosticMessageText(entry.messageText, "\n"),
      };
    }),
  };
}

function mapDiagnosticSeverity(category: ts.DiagnosticCategory): VerifierSeverity {
  if (category === ts.DiagnosticCategory.Warning) {
    return "warning";
  }
  if (category === ts.DiagnosticCategory.Message || category === ts.DiagnosticCategory.Suggestion) {
    return "info";
  }
  return "error";
}

function mapProtocolDiagnosticSeverity(category: string | null | undefined): VerifierSeverity {
  if (category === "warning") {
    return "warning";
  }
  if (category === "message" || category === "suggestion") {
    return "info";
  }
  return "error";
}

function buildFallbackCompilerOptions(filePath: string): ts.CompilerOptions {
  const extension = path.extname(filePath).toLowerCase();
  const isJavaScript = [".js", ".mjs", ".cjs", ".jsx"].includes(extension);
  return {
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: isJavaScript,
    checkJs: isJavaScript,
    jsx: extension === ".tsx" || extension === ".jsx" ? ts.JsxEmit.ReactJSX : undefined,
    strict: true,
    skipLibCheck: true,
  };
}

function findNearestProjectConfig(filePath: string, cwd: string): string | null {
  let current = path.dirname(path.resolve(filePath));
  const workspaceRoot = path.resolve(cwd);
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);
    for (const candidate of CONFIG_FILE_CANDIDATES) {
      const candidatePath = path.join(current, candidate);
      if (ts.sys.fileExists(candidatePath)) {
        return candidatePath;
      }
    }
    if (current === workspaceRoot || current === path.dirname(current)) {
      break;
    }
    current = path.dirname(current);
  }

  return null;
}

function getProgramSourceFile(program: ts.Program, filePath: string): ts.SourceFile | undefined {
  const normalized = normalizeComparisonPath(filePath);
  return program.getSourceFiles().find((entry) => normalizeComparisonPath(entry.fileName) === normalized);
}

function normalizeTargetPaths(paths: string[], cwd: string): string[] {
  return paths
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => path.resolve(cwd, entry))
    .filter((entry, index, values) => values.indexOf(entry) === index);
}

function dedupeDiagnostics(diagnostics: DiagnosticRecord[]): DiagnosticRecord[] {
  const byKey = new Map<string, DiagnosticRecord>();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([
      diagnostic.path,
      diagnostic.line,
      diagnostic.column,
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
      diagnostic.source,
      diagnostic.scope,
      diagnostic.category,
    ]);
    if (!byKey.has(key)) {
      byKey.set(key, diagnostic);
    }
  }
  return [...byKey.values()];
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

function normalizeComparisonPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

function inferConfigSource(configPath: string): DiagnosticSource {
  return path.basename(configPath).startsWith("jsconfig") ? "jsconfig" : "tsconfig";
}

function isSupportedExtension(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function toTsServerScriptKindName(filePath: string): "TS" | "JS" | "TSX" | "JSX" {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") {
    return "TSX";
  }
  if (extension === ".jsx") {
    return "JSX";
  }
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return "JS";
  }
  return "TS";
}

function describeTsServerFailure(error: unknown): string {
  if (isTsServerTransportFailure(error)) {
    return `${error.message}${error.details.stderrTail ? ` stderr: ${summarizeText(error.details.stderrTail, 240)}` : ""}`;
  }
  return toErrorMessage(error);
}

function isTransportConfigured(options: TypeScriptDiagnosticProviderOptions): boolean {
  if (typeof options.command === "string" && options.command.length > 0) {
    return true;
  }
  if (typeof options.serverPath === "string" && options.serverPath.length > 0) {
    return true;
  }
  return Boolean(resolveDefaultTsServerPath());
}

function isInferredProjectName(configFileName: string | null): boolean {
  if (!configFileName) {
    return true;
  }
  return configFileName.startsWith("/dev/null/")
    || configFileName.includes("inferredProject")
    || configFileName.endsWith("*");
}

function summarizeText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`;
}
