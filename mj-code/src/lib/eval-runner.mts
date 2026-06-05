import { TaskClassifier } from "./task-classifier.mjs";
import { buildReplayVerifierInspectReport } from "./agent-verifier-inspect.mjs";
import {
  compareVerifierRunDiagnostics,
  createDiagnosticSnapshotFromVerifierRun,
} from "./agent-verifier.mjs";
import { CapabilityRouter } from "./capability-router.mjs";
import { ModelRouter } from "./model-router.mjs";
import { Planner } from "./planner.mjs";
import { scopeRuntimeHealthOverviewToProvider } from "./runtime-health.mjs";
import type { CapabilityRegistryLike } from "./capability-registry.mjs";

import type {
  DiagnosticSnapshotSummary,
  EvalCaseResult,
  EvalScorecard,
  EvalSuiteResult,
  EvalSummary,
  ModelDecision,
  RepairAttemptConvergenceRecord,
  RepairLoopRecord,
  RepairProgressState,
  RepairProgressTrend,
  RepairStatus,
  RuntimeHealthOverview,
  SessionReplay,
  RouteDecision,
  TaskClassification,
  VerifierCheckResult,
  VerifierFailureCategory,
  VerifierInspectReport,
  VerifierRegressionGateDecision,
  VerifierRunRecord,
  VerifierStatus,
} from "../types/contracts.js";

interface EvalRunnerConfig {
  provider?: string | null;
  model?: string | null;
  maxTokens?: number;
  [key: string]: unknown;
}

interface TaskClassifierLike {
  classify(prompt: string, context: Record<string, unknown>): TaskClassification;
}

type CapabilityRouterLike = Pick<CapabilityRouter, "route">;
type ModelRouterLike = Pick<ModelRouter, "route">;
type PlannerLike = Pick<Planner, "createPlan">;

interface EvalRunnerOptions {
  taskClassifier?: TaskClassifierLike;
  capabilityRouter?: CapabilityRouterLike;
  modelRouter?: ModelRouterLike;
  planner?: PlannerLike;
}

interface EvalSuiteCaseDefinition {
  name: string;
  capabilityTags: string[];
  run: () => EvalCaseInput;
}

interface EvalCaseInput {
  pass: boolean;
  score?: number;
  metrics?: Record<string, unknown> | null;
  failureReason?: string | null;
}

interface EvalSuiteContext {
  capabilityRegistry?: Pick<CapabilityRegistryLike, "upsertMany" | "list">;
  runtimeHealth?: Record<string, unknown>;
  activeSkills?: Array<Record<string, unknown>>;
  policy?: { sources?: Array<Record<string, unknown>> };
  availableModels?: string[];
  runtimeContinuity?: {
    shellJobs?: Array<Record<string, unknown>>;
    lastSourcePack?: Record<string, unknown> | null;
    intelligence?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
  shellSamples?: Array<{
    id: string;
    attachStrategy?: { mode?: string | null } | null;
    live?: boolean;
    historicalOnly?: boolean;
    [key: string]: unknown;
  }>;
  baselineGate?: VerifierRegressionGateDecision | null;
}

export class EvalRunner {
  readonly config: EvalRunnerConfig;
  readonly taskClassifier: TaskClassifierLike;
  readonly capabilityRouter: CapabilityRouterLike;
  readonly modelRouter: ModelRouterLike;
  readonly planner: PlannerLike;

  constructor(config: EvalRunnerConfig = {}, options: EvalRunnerOptions = {}) {
    this.config = config;
    this.taskClassifier = options.taskClassifier ?? new TaskClassifier(config);
    this.capabilityRouter = options.capabilityRouter ?? new CapabilityRouter(config);
    this.modelRouter = options.modelRouter ?? new ModelRouter(config);
    this.planner = options.planner ?? new Planner();
  }

  runSuite(suite = "all", context: EvalSuiteContext = {}): EvalSuiteResult {
    const startedAt = Date.now();
    const suites = buildEvalSuites(this, context);
    const selectedEntries = suite === "all"
      ? Object.entries(suites)
      : Object.entries(suites).filter(([name]) => name === suite);

    const cases: EvalCaseResult[] = [];
    for (const [suiteName, suiteCases] of selectedEntries) {
      for (const entry of suiteCases) {
        const caseStartedAt = Date.now();
        try {
          const result = entry.run();
          const normalized = normalizeEvalCaseResult(suiteName, entry, result, Date.now() - caseStartedAt);
          cases.push(normalized);
        } catch (error) {
          cases.push({
            suite: suiteName,
            name: entry.name,
            pass: false,
            score: 0,
            durationMs: Date.now() - caseStartedAt,
            failureReason: error instanceof Error ? error.message : `${error}`,
            capabilityTags: entry.capabilityTags,
            metrics: null,
          });
        }
      }
    }

    return {
      suite,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      cases,
      summary: summarizeCases(cases),
      scorecard: buildCapabilityScorecard(cases),
      baselineGate: context.baselineGate ? structuredClone(context.baselineGate) : null,
      baselinePolicyProfile: context.baselineGate?.profile
        ? structuredClone(context.baselineGate.profile)
        : null,
      artifact: null,
      handoff: null,
      bundle: null,
    };
  }
}

interface VerificationEvalMetrics {
  verifierStatus: VerifierStatus | "none";
  repairStatus: RepairStatus | "none";
  finalOutcome: VerifierInspectReport["summary"]["finalOutcome"];
  verifierRunCount: number;
  repairLoopCount: number;
  repairAttemptCount: number;
  repairProgress: RepairLoopRecord["summary"]["latestProgress"] | "none";
  repairProgressTrend: RepairProgressTrend;
  repairResolvedCount: number;
  repairImprovedCount: number;
  repairUnchangedCount: number;
  repairRegressedCount: number;
  repairNotApplicableCount: number;
  resolvedDiagnosticCount: number;
  persistedDiagnosticCount: number;
  introducedDiagnosticCount: number;
  diagnosticErrorCount: number;
  diagnosticWarningCount: number;
  diagnosticEngine: VerifierRunRecord["summary"]["diagnosticEngine"] | "none";
  diagnosticFallbackUsed: boolean;
  diagnosticFallbackReason: string | null;
  diagnosticTransportAvailable: boolean | null;
  fixHintAvailable: boolean;
  fixHintSource: VerifierInspectReport["summary"]["latestFixHintSource"];
  fixHintCount: number;
  recommendedFixHintCount: number;
  fixHintFileCount: number;
  fixHintReason: string | null;
  codeActionAvailable: boolean;
  codeActionSource: VerifierInspectReport["summary"]["latestCodeActionSource"];
  codeActionCandidateCount: number;
  codeActionAllowlistedCount: number;
  codeActionAppliedCount: number;
  codeActionBlockedCount: number;
  latestCodeActionApplied: boolean;
  latestCodeActionStatus: VerifierInspectReport["summary"]["latestCodeActionStatus"];
  latestCodeActionBlockedReason: VerifierInspectReport["summary"]["latestCodeActionBlockedReason"];
  projectContextAvailable: boolean;
  projectContextSource: VerifierInspectReport["summary"]["latestProjectContextSource"];
  projectContextCount: number;
  projectContextDiagnosticCoverageCount: number;
  projectContextQuickInfoCount: number;
  projectContextDefinitionCount: number;
  projectContextImplementationCount: number;
  projectContextReferenceCount: number;
  projectContextDocumentSymbolCount: number;
  projectContextReason: string | null;
  failureCategories: VerifierFailureCategory[];
  stopReason: RepairLoopRecord["summary"]["stopReason"] | null;
  duplicateDiagnosticsSuppressed: boolean;
  inspectSummaryMatches: boolean;
  [key: string]: unknown;
}

function buildEvalSuites(
  runtime: EvalRunner,
  context: EvalSuiteContext,
): Record<string, EvalSuiteCaseDefinition[]> {
  const capabilityRegistry = context.capabilityRegistry;
  const baseRuntimeHealth = context.runtimeHealth ?? {
    scorecard: {
      degradedFlags: [],
      circuits: { byLayer: { provider: {}, web: {}, mcp: {} } },
    },
  };
  const runtimeHealth = isRuntimeHealthOverview(baseRuntimeHealth)
    ? scopeRuntimeHealthOverviewToProvider(baseRuntimeHealth, runtime.config.provider ?? null)
    : baseRuntimeHealth;
  const activeSkills = context.activeSkills ?? [];
  const policy = context.policy ?? { sources: [] };
  const availableModels = (context.availableModels ?? [runtime.config.model])
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

  return {
    routing: [
      {
        name: "code-edit-local-first",
        capabilityTags: ["routing", "builtin", "edit"],
        run: () => {
          const classification = runtime.taskClassifier.classify("Implement a CLI flag and update the README.", {
            capabilityRegistry,
            runtimeHealth,
            activeSkills,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
          });
          const route = runtime.capabilityRouter.route({
            prompt: "Implement a CLI flag and update the README.",
            taskClassification: classification,
            capabilityRegistry,
            runtimeHealth,
            policy,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
            approvalPolicy: "on-write",
            activeSkills,
          });
          return {
            pass: classification.taskClass === "code_edit" && route.routingMode === "local-first",
            score: classification.taskClass === "code_edit" && route.routingMode === "local-first" ? 1 : 0.35,
            metrics: {
              taskClass: classification.taskClass,
              routingMode: route.routingMode,
              selected: route.selectedCapabilities.map((entry) => entry.name),
            },
            failureReason: classification.taskClass !== "code_edit"
              ? `expected code_edit, got ${classification.taskClass}`
              : route.routingMode !== "local-first"
                ? `expected local-first, got ${route.routingMode}`
                : null,
          };
        },
      },
      {
        name: "official-docs-prefers-web",
        capabilityTags: ["routing", "web", "docs"],
        run: () => {
          const classification = runtime.taskClassifier.classify("Look up the official API docs for the Continue context providers.", {
            capabilityRegistry,
            runtimeHealth,
            activeSkills,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
          });
          const route = runtime.capabilityRouter.route({
            prompt: "Look up the official API docs for the Continue context providers.",
            taskClassification: classification,
            capabilityRegistry,
            runtimeHealth,
            policy,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
            approvalPolicy: "on-write",
            activeSkills,
          });
          const selectedTypes = route.selectedCapabilities.map((entry) => entry.type);
          return {
            pass:
              classification.taskClass === "official_docs_lookup" &&
              ["official-first", "docs-first"].includes(route.routingMode) &&
              selectedTypes.includes("web-tool"),
            score:
              classification.taskClass === "official_docs_lookup" &&
              selectedTypes.includes("web-tool")
                ? 1
                : 0.4,
            metrics: {
              taskClass: classification.taskClass,
              routingMode: route.routingMode,
              selectedTypes,
            },
            failureReason: null,
          };
        },
      },
      {
        name: "mixed-capability-code-task-stays-local-first",
        capabilityTags: ["routing", "mixed", "governance"],
        run: () => {
          const classification = runtime.taskClassifier.classify(
            "Inspect the repo, patch the CLI parser, run tests, and only use docs if local evidence is insufficient.",
            {
              capabilityRegistry,
              runtimeHealth,
              activeSkills,
              networkMode: "docs-only",
              permissionMode: "workspace-write",
            },
          );
          const route = runtime.capabilityRouter.route({
            prompt: "Inspect the repo, patch the CLI parser, run tests, and only use docs if local evidence is insufficient.",
            taskClassification: classification,
            capabilityRegistry,
            runtimeHealth,
            policy,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
            approvalPolicy: "on-write",
            activeSkills,
            mcpEnabled: true,
          });
          return {
            pass:
              route.routingMode === "local-first" &&
              route.selectedCapabilities.some((entry) => entry.type === "builtin-tool") &&
              !route.selectedCapabilities.some((entry) => entry.type === "plugin-tool"),
            score: route.routingMode === "local-first" ? 1 : 0.35,
            metrics: {
              taskClass: classification.taskClass,
              routingMode: route.routingMode,
              selectedTypes: route.selectedCapabilities.map((entry) => entry.type),
            },
            failureReason: route.routingMode !== "local-first"
              ? `expected local-first, got ${route.routingMode}`
              : null,
          };
        },
      },
    ],
    runtime: [
      {
        name: "degraded-web-routing-falls-back",
        capabilityTags: ["routing", "runtime", "degraded"],
        run: () => {
          const degradedHealth = {
            scorecard: {
              degradedFlags: ["web_circuit_open"],
              circuits: {
                byLayer: {
                  provider: { total: 0, open: 0, halfOpen: 0, closed: 0 },
                  web: { total: 1, open: 1, halfOpen: 0, closed: 0 },
                  mcp: { total: 0, open: 0, halfOpen: 0, closed: 0 },
                },
              },
            },
          };
          const classification = runtime.taskClassifier.classify("Search the web for the latest Claude Code docs.", {
            capabilityRegistry,
            runtimeHealth: degradedHealth,
            activeSkills,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
          });
          const route = runtime.capabilityRouter.route({
            prompt: "Search the web for the latest Claude Code docs.",
            taskClassification: classification,
            capabilityRegistry,
            runtimeHealth: degradedHealth,
            policy,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
            approvalPolicy: "on-write",
            activeSkills,
          });
          return {
            pass: route.degraded === true && route.blockedCapabilities.some((entry) => entry.type === "web-tool"),
            score: route.degraded === true ? 1 : 0.45,
            metrics: {
              degraded: route.degraded,
              blocked: route.blockedCapabilities.map((entry) => entry.id),
            },
            failureReason: null,
          };
        },
      },
      {
        name: "provider-retry-pressure-builds-adaptive-fallback-chain",
        capabilityTags: ["runtime", "model-routing", "fallback"],
        run: () => {
          const degradedHealth = {
            scorecard: {
              degradedFlags: ["high_retry_pressure", "provider_half_open"],
              retryPressure: 0.52,
              provider: { avgHealthScore: 61 },
              circuits: {
                byLayer: {
                  provider: { total: 1, open: 0, halfOpen: 1, closed: 0 },
                  web: { total: 0, open: 0, halfOpen: 0, closed: 0 },
                  mcp: { total: 0, open: 0, halfOpen: 0, closed: 0 },
                },
              },
            },
          };
          const classification = runtime.taskClassifier.classify("Refactor the CLI parser and run tests.", {
            capabilityRegistry,
            runtimeHealth: degradedHealth,
            activeSkills,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
          });
          const route = runtime.capabilityRouter.route({
            prompt: "Refactor the CLI parser and run tests.",
            taskClassification: classification,
            capabilityRegistry,
            runtimeHealth: degradedHealth,
            policy,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
            approvalPolicy: "on-write",
            activeSkills,
          });
          const modelDecision = runtime.modelRouter.route({
            taskClassification: classification,
            routeDecision: route,
            runtimeHealth: degradedHealth,
            availableModels,
            currentModel: runtime.config.model,
            provider: runtime.config.provider,
          });
          return {
            pass:
              modelDecision.runtimePressure?.mode === "conservative" &&
              Array.isArray(modelDecision.fallbackChain) &&
              modelDecision.fallbackChain.length > 0,
            score: modelDecision.runtimePressure?.mode === "conservative" ? 1 : 0.4,
            metrics: {
              chosenModel: modelDecision.chosenModel,
              runtimePressure: modelDecision.runtimePressure,
              fallbackChain: modelDecision.fallbackChain,
            },
            failureReason: null,
          };
        },
      },
    ],
    web: [
      {
        name: "web-classifier-demands-freshness",
        capabilityTags: ["web", "classification", "provenance"],
        run: () => {
          const classification = runtime.taskClassifier.classify("Find the latest official pricing docs with citations.", {
            capabilityRegistry,
            runtimeHealth,
            activeSkills,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
          });
          return {
            pass: classification.freshnessRequired && classification.likelyWeb,
            score: classification.freshnessRequired && classification.likelyWeb ? 1 : 0.3,
            metrics: classification,
            failureReason: null,
          };
        },
      },
    ],
    mcp: [
      {
        name: "mcp-routing-prefers-mcp-tools",
        capabilityTags: ["mcp", "routing", "external"],
        run: () => {
          const classification = runtime.taskClassifier.classify("Use the MCP git server to inspect recent branches.", {
            capabilityRegistry,
            runtimeHealth,
            activeSkills,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
          });
          const route = runtime.capabilityRouter.route({
            prompt: "Use the MCP git server to inspect recent branches.",
            taskClassification: classification,
            capabilityRegistry,
            runtimeHealth,
            policy,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
            approvalPolicy: "on-write",
            activeSkills,
            mcpEnabled: true,
          });
          return {
            pass: route.routingMode === "external-capability-first",
            score: route.routingMode === "external-capability-first" ? 1 : 0.35,
            metrics: {
              routingMode: route.routingMode,
              taskClass: classification.taskClass,
            },
            failureReason: null,
          };
        },
      },
    ],
    planning: [
      {
        name: "planner-adds-verification-for-code-edit",
        capabilityTags: ["planning", "verification", "edit"],
        run: () => {
          const classification = runtime.taskClassifier.classify("Refactor the CLI parser and run tests.", {
            capabilityRegistry,
            runtimeHealth,
            activeSkills,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
          });
          const route = runtime.capabilityRouter.route({
            prompt: "Refactor the CLI parser and run tests.",
            taskClassification: classification,
            capabilityRegistry,
            runtimeHealth,
            policy,
            networkMode: "docs-only",
            permissionMode: "workspace-write",
            approvalPolicy: "on-write",
            activeSkills,
          });
          const modelDecision = runtime.modelRouter.route({
            taskClassification: classification,
            routeDecision: route,
            runtimeHealth,
            availableModels,
            currentModel: runtime.config.model,
            provider: runtime.config.provider,
          });
          const plan = runtime.planner.createPlan({
            prompt: "Refactor the CLI parser and run tests.",
            taskClassification: classification,
            routeDecision: route,
            modelDecision,
          });
          return {
            pass: plan.steps.some((entry) => entry.type === "verify"),
            score: plan.steps.some((entry) => entry.type === "verify") ? 1 : 0.4,
            metrics: {
              planId: plan.planId,
              stepTypes: plan.steps.map((entry) => entry.type),
            },
            failureReason: null,
          };
        },
      },
    ],
    verification: [
      {
        name: "verifier-pass-without-repair",
        capabilityTags: ["verification", "diagnostics", "baseline"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "passed",
                summary: "Verifier passed without requiring repair.",
                checks: [
                  createVerifierCheckResult({
                    id: "diagnostics:ok",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "passed",
                    summary: "No diagnostics errors were found.",
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({ success: true, stopped: false })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.verifierStatus === "passed" &&
              metrics.repairStatus === "none" &&
              metrics.finalOutcome === "success",
            score: metrics.finalOutcome === "success" ? 1 : 0.35,
            metrics,
            failureReason: metrics.finalOutcome !== "success"
              ? `expected success without repair, got verifier=${metrics.verifierStatus} repair=${metrics.repairStatus} final=${metrics.finalOutcome}`
              : null,
          };
        },
      },
      {
        name: "verifier-fail-repair-retry-pass",
        capabilityTags: ["verification", "repair", "convergence"],
        run: () => {
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            startedAt: "2026-04-05T00:00:00.000Z",
            finishedAt: "2026-04-05T00:00:01.000Z",
            summary: "Verifier failed because diagnostics reported errors.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:broken",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "TypeScript diagnostics reported errors.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Type 'number' is not assignable to type 'string'.",
                    path: "/repo/src/broken.ts",
                    line: 3,
                    column: 14,
                    code: "TS2322",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const secondPass = createVerifierRunRecord({
            status: "passed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Verifier passed after repair.",
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:fixed",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "passed",
                summary: "Diagnostics passed after the repair attempt.",
              }),
            ],
          });
          const repairLoop = createRepairLoopRecord({
            status: "succeeded",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:02.750Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "succeeded",
                summary: "Repair attempt 1/1 succeeded.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondPass.startedAt,
                resultVerifierStep: secondPass.step,
                resultVerifierSummary: secondPass.summary.summary,
                resultVerifierRun: secondPass,
                directive: createRepairDirective({
                  traceId: "trace-verification",
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  attempt: 1,
                  maxAttempts: 1,
                  summary: "Fix the TypeScript diagnostics and rerun verification.",
                  instruction: "Repair the failing typed diagnostics before claiming success.",
                  failureCategories: ["diagnostic_error"],
                  filePaths: ["/repo/src/broken.ts"],
                }),
                continuationMessage: "Repair the diagnostic failure and wait for verification to pass.",
              }),
            ],
            stopReason: null,
            summary: "Repair loop succeeded after 1 attempt(s).",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondPass],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({ success: true, stopped: false })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.verifierStatus === "passed" &&
              metrics.repairStatus === "succeeded" &&
              metrics.finalOutcome === "success" &&
              metrics.repairAttemptCount === 1 &&
              metrics.repairProgress === "resolved",
            score: metrics.finalOutcome === "success" ? 1 : 0.35,
            metrics,
            failureReason: metrics.finalOutcome !== "success"
              ? `expected repair convergence, got verifier=${metrics.verifierStatus} repair=${metrics.repairStatus} final=${metrics.finalOutcome}`
              : null,
          };
        },
      },
      {
        name: "verifier-fail-no-actionable-stop",
        capabilityTags: ["verification", "repair", "stopping"],
        run: () => {
          const failedRun = createVerifierRunRecord({
            status: "failed",
            step: 1,
            summary: "Verifier failed because the explicit command exited non-zero without actionable typed findings.",
            failureCategories: ["command_failed"],
            checks: [
              createVerifierCheckResult({
                id: "command:npm-test",
                kind: "command",
                label: "Run npm test",
                status: "failed",
                category: "command_failed",
                summary: "The configured command failed.",
                command: {
                  id: "command:npm-test",
                  command: "npm test",
                  cwd: "/repo",
                  source: "configured",
                  reason: "Run tests before finishing.",
                },
                exitCode: 1,
                stderrSummary: "Tests failed before producing a typed diagnostic payload.",
              }),
            ],
          });
          const repairLoop = createRepairLoopRecord({
            status: "stopped",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:01.250Z",
            initialVerifierStartedAt: failedRun.startedAt,
            initialVerifierStep: failedRun.step,
            initialFailureCategories: ["command_failed"],
            attempts: [],
            stopReason: "no_actionable_findings",
            summary: "Repair loop stopped because the verifier failure did not expose actionable typed findings.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [failedRun],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.verifierStatus === "failed" &&
              metrics.repairStatus === "stopped" &&
              metrics.stopReason === "no_actionable_findings" &&
              metrics.finalOutcome === "failed",
            score: metrics.stopReason === "no_actionable_findings" ? 1 : 0.35,
            metrics,
            failureReason: metrics.stopReason !== "no_actionable_findings"
              ? `expected no_actionable_findings stop, got ${metrics.stopReason}`
              : null,
          };
        },
      },
      {
        name: "verifier-fail-repair-exhausted",
        capabilityTags: ["verification", "repair", "exhaustion"],
        run: () => {
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            startedAt: "2026-04-05T00:00:00.000Z",
            finishedAt: "2026-04-05T00:00:01.000Z",
            summary: "Verifier failed because diagnostics reported errors.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:first",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "TypeScript diagnostics reported errors.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Type 'number' is not assignable to type 'string'.",
                    path: "/repo/src/broken.ts",
                    line: 3,
                    column: 14,
                    code: "TS2322",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const secondFailure = createVerifierRunRecord({
            status: "failed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Verifier still failed after repair.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:second",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "Diagnostics still report an error after repair.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Type 'number' is not assignable to type 'string'.",
                    path: "/repo/src/broken.ts",
                    line: 3,
                    column: 14,
                    code: "TS2322",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const repairLoop = createRepairLoopRecord({
            status: "exhausted",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:03.100Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "failed",
                summary: "Repair attempt 1/1 failed to clear the verifier findings.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondFailure.startedAt,
                resultVerifierStep: secondFailure.step,
                resultVerifierSummary: secondFailure.summary.summary,
                resultVerifierRun: secondFailure,
                directive: createRepairDirective({
                  traceId: "trace-verification",
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  attempt: 1,
                  maxAttempts: 1,
                  summary: "Retry the typed repair once and rerun verification.",
                  instruction: "Repair the remaining failing diagnostics before success is allowed.",
                  failureCategories: ["diagnostic_error"],
                  filePaths: ["/repo/src/broken.ts"],
                }),
                continuationMessage: "Repair the diagnostics failure and rerun verification once.",
              }),
            ],
            stopReason: "attempts_exhausted",
            summary: "Repair loop exhausted after 1/1 attempt(s); verification is still failing.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondFailure],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.verifierStatus === "failed" &&
              metrics.repairStatus === "exhausted" &&
              metrics.stopReason === "attempts_exhausted" &&
              metrics.finalOutcome === "failed" &&
              metrics.repairProgress === "unchanged",
            score: metrics.repairStatus === "exhausted" ? 1 : 0.35,
            metrics,
            failureReason: metrics.repairStatus !== "exhausted"
              ? `expected repair exhaustion, got ${metrics.repairStatus}`
              : null,
          };
        },
      },
      {
        name: "repair-improves-but-does-not-fully-resolve",
        capabilityTags: ["verification", "repair", "convergence"],
        run: () => {
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            startedAt: "2026-04-05T00:00:00.000Z",
            finishedAt: "2026-04-05T00:00:01.000Z",
            summary: "Verifier failed because diagnostics reported two errors.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 2,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:first-improving",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "Two TypeScript diagnostics reported errors.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Type 'number' is not assignable to type 'string'.",
                    path: "/repo/src/broken.ts",
                    line: 3,
                    column: 14,
                    code: "TS2322",
                    source: "typescript",
                    scope: "file",
                  }),
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Property 'trim' does not exist on type 'number'.",
                    path: "/repo/src/broken.ts",
                    line: 8,
                    column: 9,
                    code: "TS2339",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const secondFailure = createVerifierRunRecord({
            status: "failed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Verifier still failed after repair, but fewer diagnostics remain.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:second-improving",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "One TypeScript diagnostic still reports an error after repair.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Type 'number' is not assignable to type 'string'.",
                    path: "/repo/src/broken.ts",
                    line: 3,
                    column: 14,
                    code: "TS2322",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const repairLoop = createRepairLoopRecord({
            status: "exhausted",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:03.100Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "failed",
                summary: "Repair attempt 1/1 reduced the diagnostics surface but did not clear it.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondFailure.startedAt,
                resultVerifierStep: secondFailure.step,
                resultVerifierSummary: secondFailure.summary.summary,
                resultVerifierRun: secondFailure,
                directive: createRepairDirective({
                  traceId: "trace-verification",
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  attempt: 1,
                  maxAttempts: 1,
                  summary: "Reduce the remaining TypeScript diagnostics and rerun verification.",
                  instruction: "Continue repairing the remaining diagnostics before success is allowed.",
                  failureCategories: ["diagnostic_error"],
                  filePaths: ["/repo/src/broken.ts"],
                }),
              }),
            ],
            stopReason: "attempts_exhausted",
            summary: "Repair loop exhausted after making partial diagnostics progress.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondFailure],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.repairStatus === "exhausted" &&
              metrics.repairProgress === "improved" &&
              metrics.resolvedDiagnosticCount === 1 &&
              metrics.persistedDiagnosticCount === 1 &&
              metrics.introducedDiagnosticCount === 0,
            score: metrics.repairProgress === "improved" ? 1 : 0.35,
            metrics,
            failureReason: metrics.repairProgress !== "improved"
              ? `expected improved repair progress, got ${metrics.repairProgress}`
              : null,
          };
        },
      },
      {
        name: "repair-makes-no-progress",
        capabilityTags: ["verification", "repair", "convergence"],
        run: () => {
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            summary: "Verifier failed because diagnostics reported one error.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:first-unchanged",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "One TypeScript diagnostic reported an error.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Cannot find name 'missingValue'.",
                    path: "/repo/src/unchanged.ts",
                    line: 4,
                    column: 2,
                    code: "TS2304",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const secondFailure = createVerifierRunRecord({
            status: "failed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Verifier still failed with the same diagnostic surface after repair.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:second-unchanged",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "The same TypeScript diagnostic still reports an error after repair.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Cannot find name 'missingValue'.",
                    path: "/repo/src/unchanged.ts",
                    line: 4,
                    column: 2,
                    code: "TS2304",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const repairLoop = createRepairLoopRecord({
            status: "exhausted",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:03.100Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "failed",
                summary: "Repair attempt 1/1 made no measurable diagnostics progress.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondFailure.startedAt,
                resultVerifierStep: secondFailure.step,
                resultVerifierSummary: secondFailure.summary.summary,
                resultVerifierRun: secondFailure,
              }),
            ],
            stopReason: "attempts_exhausted",
            summary: "Repair loop exhausted without diagnostics progress.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondFailure],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.repairStatus === "exhausted" &&
              metrics.repairProgress === "unchanged" &&
              metrics.resolvedDiagnosticCount === 0 &&
              metrics.persistedDiagnosticCount === 1 &&
              metrics.introducedDiagnosticCount === 0,
            score: metrics.repairProgress === "unchanged" ? 1 : 0.35,
            metrics,
            failureReason: metrics.repairProgress !== "unchanged"
              ? `expected unchanged repair progress, got ${metrics.repairProgress}`
              : null,
          };
        },
      },
      {
        name: "repair-regresses-diagnostics",
        capabilityTags: ["verification", "repair", "convergence"],
        run: () => {
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            summary: "Verifier failed because diagnostics reported one error.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:first-regressed",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "One TypeScript diagnostic reported an error.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Cannot find module './missing'.",
                    path: "/repo/src/regressed.ts",
                    line: 1,
                    column: 21,
                    code: "TS2307",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const secondFailure = createVerifierRunRecord({
            status: "failed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Verifier failed with more diagnostics after repair.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 2,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:second-regressed",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "Two TypeScript diagnostics now report errors after repair.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Cannot find module './missing'.",
                    path: "/repo/src/regressed.ts",
                    line: 1,
                    column: 21,
                    code: "TS2307",
                    source: "typescript",
                    scope: "file",
                  }),
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Type 'boolean' is not assignable to type 'string'.",
                    path: "/repo/src/regressed.ts",
                    line: 5,
                    column: 7,
                    code: "TS2322",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
              }),
            ],
          });
          const repairLoop = createRepairLoopRecord({
            status: "exhausted",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:03.100Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "failed",
                summary: "Repair attempt 1/1 introduced more diagnostics.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondFailure.startedAt,
                resultVerifierStep: secondFailure.step,
                resultVerifierSummary: secondFailure.summary.summary,
                resultVerifierRun: secondFailure,
              }),
            ],
            stopReason: "attempts_exhausted",
            summary: "Repair loop exhausted after regressing the diagnostics surface.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondFailure],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.repairStatus === "exhausted" &&
              metrics.repairProgress === "regressed" &&
              metrics.resolvedDiagnosticCount === 0 &&
              metrics.persistedDiagnosticCount === 1 &&
              metrics.introducedDiagnosticCount === 1,
            score: metrics.repairProgress === "regressed" ? 1 : 0.35,
            metrics,
            failureReason: metrics.repairProgress !== "regressed"
              ? `expected regressed repair progress, got ${metrics.repairProgress}`
              : null,
          };
        },
      },
      {
        name: "compiler-api-fallback-still-produces-convergence-metrics",
        capabilityTags: ["verification", "repair", "diagnostics", "fallback"],
        run: () => {
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            summary: "Compiler API fallback diagnostics reported two errors.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 2,
            diagnosticEngine: "compiler_api",
            diagnosticFallbackUsed: true,
            diagnosticFallbackReason: "tsserver transport exited unexpectedly",
            diagnosticTransportAvailable: false,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:first-fallback",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "Compiler API fallback found two diagnostics.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Type 'number' is not assignable to type 'string'.",
                    path: "/repo/src/fallback.ts",
                    line: 2,
                    column: 7,
                    code: "TS2322",
                    source: "typescript",
                    scope: "fallback",
                  }),
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Cannot find name 'laterValue'.",
                    path: "/repo/src/fallback.ts",
                    line: 5,
                    column: 3,
                    code: "TS2304",
                    source: "typescript",
                    scope: "fallback",
                  }),
                ],
              }),
            ],
          });
          const secondFailure = createVerifierRunRecord({
            status: "failed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Compiler API fallback diagnostics still found one remaining error.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            diagnosticEngine: "compiler_api",
            diagnosticFallbackUsed: true,
            diagnosticFallbackReason: "tsserver transport exited unexpectedly",
            diagnosticTransportAvailable: false,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:second-fallback",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "Compiler API fallback found one remaining diagnostic.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Type 'number' is not assignable to type 'string'.",
                    path: "/repo/src/fallback.ts",
                    line: 2,
                    column: 7,
                    code: "TS2322",
                    source: "typescript",
                    scope: "fallback",
                  }),
                ],
              }),
            ],
          });
          const repairLoop = createRepairLoopRecord({
            status: "exhausted",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:03.100Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "failed",
                summary: "Repair attempt 1/1 improved the fallback diagnostics but did not resolve them.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondFailure.startedAt,
                resultVerifierStep: secondFailure.step,
                resultVerifierSummary: secondFailure.summary.summary,
                resultVerifierRun: secondFailure,
              }),
            ],
            stopReason: "attempts_exhausted",
            summary: "Repair loop exhausted under compiler API fallback diagnostics.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondFailure],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.repairProgress === "improved" &&
              metrics.diagnosticEngine === "compiler_api" &&
              metrics.diagnosticFallbackUsed === true &&
              metrics.diagnosticTransportAvailable === false &&
              metrics.resolvedDiagnosticCount === 1,
            score: metrics.repairProgress === "improved" ? 1 : 0.35,
            metrics,
            failureReason: metrics.diagnosticEngine !== "compiler_api"
              ? `expected compiler_api diagnostics, got ${metrics.diagnosticEngine}`
              : null,
          };
        },
      },
      {
        name: "tsserver-diagnostics-expose-fix-hints",
        capabilityTags: ["verification", "diagnostics", "fix-hints"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "failed",
                summary: "Verifier failed with tsserver diagnostics and bounded fix hints.",
                failureCategories: ["diagnostic_error"],
                diagnosticErrorCount: 1,
                checks: [
                  createVerifierCheckResult({
                    id: "diagnostics:tsserver-fix-hints",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "failed",
                    category: "diagnostic_error",
                    summary: "TypeScript diagnostics reported a blocking error.",
                    findings: [
                      createVerifierFinding({
                        kind: "diagnostics",
                        status: "failed",
                        severity: "error",
                        category: "diagnostic_error",
                        message: "Type 'number' is not assignable to type 'string'.",
                        path: "/repo/src/broken.ts",
                        line: 3,
                        column: 14,
                        code: "TS2322",
                        source: "typescript",
                        scope: "file",
                      }),
                    ],
                    fixHints: createTsServerEvalFixHints({
                      diagnosticFingerprints: ["diag-broken-ts2322"],
                      filePaths: ["/repo/src/broken.ts"],
                      titles: [
                        "Change the initializer to a string literal.",
                        "Update the declaration to accept a numeric value.",
                      ],
                      recommendedCount: 1,
                    }),
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.verifierStatus === "failed" &&
              metrics.fixHintAvailable === true &&
              metrics.fixHintSource === "tsserver" &&
              metrics.fixHintCount === 2 &&
              metrics.recommendedFixHintCount === 1 &&
              metrics.fixHintFileCount === 1,
            score: metrics.fixHintAvailable ? 1 : 0.35,
            metrics,
            failureReason: metrics.fixHintSource !== "tsserver"
              ? `expected tsserver fix hints, got ${metrics.fixHintSource}`
              : null,
          };
        },
      },
      {
        name: "compiler-api-fallback-fix-hints-stay-unavailable",
        capabilityTags: ["verification", "diagnostics", "fallback", "fix-hints"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "failed",
                summary: "Compiler API fallback diagnostics stayed actionable but fix hints remained unavailable.",
                failureCategories: ["diagnostic_error"],
                diagnosticErrorCount: 1,
                diagnosticEngine: "compiler_api",
                diagnosticFallbackUsed: true,
                diagnosticFallbackReason: "tsserver transport exited unexpectedly",
                diagnosticTransportAvailable: false,
                checks: [
                  createVerifierCheckResult({
                    id: "diagnostics:fallback-fix-hints",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "failed",
                    category: "diagnostic_error",
                    summary: "Compiler API fallback reported a blocking diagnostic.",
                    findings: [
                      createVerifierFinding({
                        kind: "diagnostics",
                        status: "failed",
                        severity: "error",
                        category: "diagnostic_error",
                        message: "Cannot find name 'missingValue'.",
                        path: "/repo/src/fallback.ts",
                        line: 2,
                        column: 3,
                        code: "TS2304",
                        source: "typescript",
                        scope: "fallback",
                      }),
                    ],
                    fixHints: createUnavailableEvalFixHints(
                      "Fix hints are unavailable because diagnostics used compiler_api fallback.",
                    ),
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.diagnosticEngine === "compiler_api" &&
              metrics.diagnosticFallbackUsed === true &&
              metrics.fixHintAvailable === false &&
              metrics.fixHintSource === "unavailable" &&
              metrics.fixHintCount === 0,
            score: metrics.fixHintSource === "unavailable" ? 1 : 0.35,
            metrics,
            failureReason: metrics.fixHintSource !== "unavailable"
              ? `expected unavailable fix hints under compiler_api fallback, got ${metrics.fixHintSource}`
              : null,
          };
        },
      },
      {
        name: "allowlisted-code-action-can-be-previewed-and-applied",
        capabilityTags: ["verification", "repair", "code-actions"],
        run: () => {
          const failingCheck = createVerifierCheckResult({
            id: "diagnostics:code-action-apply-before",
            kind: "diagnostics",
            label: "Collect diagnostics",
            status: "failed",
            category: "diagnostic_error",
            summary: "TypeScript diagnostics exposed an allowlisted import fix.",
            findings: [
              createVerifierFinding({
                kind: "diagnostics",
                status: "failed",
                severity: "error",
                category: "diagnostic_error",
                message: "Cannot find name 'readFileSync'.",
                path: "/repo/src/apply.ts",
                line: 1,
                column: 21,
                code: "TS2304",
                source: "typescript",
                scope: "file",
              }),
            ],
            codeActions: createTsServerEvalCodeActions({
              diagnosticFingerprints: ["diag-apply-ts2304"],
              filePaths: ["/repo/src/apply.ts"],
              titles: ["Add import from \"node:fs\""],
              allowlistedCount: 1,
            }),
          });
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            startedAt: "2026-04-05T00:00:00.000Z",
            finishedAt: "2026-04-05T00:00:01.000Z",
            summary: "Verifier failed with an allowlisted tsserver code action candidate.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [failingCheck],
          });
          const secondPass = createVerifierRunRecord({
            status: "passed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Verifier passed after the bounded code action was applied.",
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:code-action-apply-after",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "passed",
                summary: "Diagnostics passed after the bounded code action was applied.",
                codeActions: createTsServerEvalCodeActions({
                  diagnosticFingerprints: [],
                  filePaths: ["/repo/src/apply.ts"],
                  titles: [],
                  allowlistedCount: 0,
                }),
              }),
            ],
          });
          const appliedAction = failingCheck.codeActions?.actions[0];
          const repairLoop = createRepairLoopRecord({
            status: "succeeded",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:02.750Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "succeeded",
                summary: "Repair attempt 1/1 applied an allowlisted code action and then passed verification.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondPass.startedAt,
                resultVerifierStep: secondPass.step,
                resultVerifierSummary: secondPass.summary.summary,
                resultVerifierRun: secondPass,
                directive: createRepairDirective({
                  traceId: "trace-verification",
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  attempt: 1,
                  maxAttempts: 1,
                  summary: "Apply the allowlisted import quick fix before re-verifying.",
                  instruction: "Use the bounded allowlisted code action, then require verifier re-pass before success.",
                  failureCategories: ["diagnostic_error"],
                  filePaths: ["/repo/src/apply.ts"],
                  codeActions: failingCheck.codeActions ?? createUnavailableEvalCodeActions("missing code actions"),
                }),
                codeAction: createEvalCodeActionApplyResult({
                  status: "applied",
                  candidate: appliedAction ?? null,
                  approvalStatus: "approved",
                  approvalRequired: true,
                  toolName: "write_file",
                  changeSetId: "change-apply-1",
                  touchedFiles: ["/repo/src/apply.ts"],
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  summary: "Applied allowlisted code action through write_file and waited for verifier re-pass.",
                }),
              }),
            ],
            stopReason: null,
            summary: "Repair loop succeeded after applying one allowlisted code action.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondPass],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({ success: true, stopped: false })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.finalOutcome === "success" &&
              metrics.codeActionCandidateCount === 1 &&
              metrics.codeActionAllowlistedCount === 1 &&
              metrics.codeActionAppliedCount === 1 &&
              metrics.latestCodeActionApplied === true &&
              metrics.latestCodeActionStatus === "applied",
            score: metrics.codeActionAppliedCount === 1 ? 1 : 0.35,
            metrics,
            failureReason: metrics.latestCodeActionStatus !== "applied"
              ? `expected applied code action status, got ${metrics.latestCodeActionStatus}`
              : null,
          };
        },
      },
      {
        name: "non-allowlisted-code-action-is-blocked-with-stable-reason",
        capabilityTags: ["verification", "repair", "code-actions"],
        run: () => {
          const failingCheck = createVerifierCheckResult({
            id: "diagnostics:code-action-blocked",
            kind: "diagnostics",
            label: "Collect diagnostics",
            status: "failed",
            category: "diagnostic_error",
            summary: "TypeScript diagnostics exposed a code action that the allowlist rejected.",
            findings: [
              createVerifierFinding({
                kind: "diagnostics",
                status: "failed",
                severity: "error",
                category: "diagnostic_error",
                message: "Cannot find name 'helper'.",
                path: "/repo/src/blocked.ts",
                line: 2,
                column: 12,
                code: "TS2304",
                source: "typescript",
                scope: "file",
              }),
            ],
            codeActions: createTsServerEvalCodeActions({
              diagnosticFingerprints: ["diag-blocked-ts2304"],
              filePaths: ["/repo/src/blocked.ts"],
              titles: ["Convert default export to named export"],
              allowlistedCount: 0,
            }),
          });
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            summary: "Verifier failed with a tsserver code action candidate that was blocked by policy.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [failingCheck],
          });
          const blockedAction = failingCheck.codeActions?.actions[0];
          const repairLoop = createRepairLoopRecord({
            status: "exhausted",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:02.250Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "failed",
                summary: "Repair attempt 1/1 could not apply the code action because it was not allowlisted.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                directive: createRepairDirective({
                  traceId: "trace-verification",
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  attempt: 1,
                  maxAttempts: 1,
                  summary: "The available code action is outside the bounded allowlist.",
                  instruction: "Do not auto-apply a blocked code action; continue only if another repair path exists.",
                  failureCategories: ["diagnostic_error"],
                  filePaths: ["/repo/src/blocked.ts"],
                  codeActions: failingCheck.codeActions ?? createUnavailableEvalCodeActions("missing code actions"),
                }),
                codeAction: createEvalCodeActionApplyResult({
                  status: "blocked",
                  candidate: blockedAction ?? null,
                  blockedReason: "not_allowlisted",
                  approvalStatus: "blocked",
                  touchedFiles: ["/repo/src/blocked.ts"],
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  summary: "Blocked the primary code action because it was not on the bounded allowlist.",
                }),
              }),
            ],
            stopReason: "attempts_exhausted",
            summary: "Repair loop exhausted after the only code action candidate was blocked.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.finalOutcome === "failed" &&
              metrics.codeActionCandidateCount === 1 &&
              metrics.codeActionAllowlistedCount === 0 &&
              metrics.codeActionBlockedCount === 1 &&
              metrics.latestCodeActionStatus === "blocked" &&
              metrics.latestCodeActionBlockedReason === "not_allowlisted",
            score: metrics.codeActionBlockedCount === 1 ? 1 : 0.35,
            metrics,
            failureReason: metrics.latestCodeActionBlockedReason !== "not_allowlisted"
              ? `expected not_allowlisted block reason, got ${metrics.latestCodeActionBlockedReason}`
              : null,
          };
        },
      },
      {
        name: "compiler-api-fallback-code-actions-stay-unavailable",
        capabilityTags: ["verification", "diagnostics", "fallback", "code-actions"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "failed",
                summary: "Compiler API fallback diagnostics stayed actionable but code actions remained unavailable.",
                failureCategories: ["diagnostic_error"],
                diagnosticErrorCount: 1,
                diagnosticEngine: "compiler_api",
                diagnosticFallbackUsed: true,
                diagnosticFallbackReason: "tsserver transport exited unexpectedly",
                diagnosticTransportAvailable: false,
                checks: [
                  createVerifierCheckResult({
                    id: "diagnostics:fallback-code-actions",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "failed",
                    category: "diagnostic_error",
                    summary: "Compiler API fallback reported a blocking diagnostic with no code actions.",
                    findings: [
                      createVerifierFinding({
                        kind: "diagnostics",
                        status: "failed",
                        severity: "error",
                        category: "diagnostic_error",
                        message: "Cannot find name 'missingValue'.",
                        path: "/repo/src/fallback-actions.ts",
                        line: 2,
                        column: 3,
                        code: "TS2304",
                        source: "typescript",
                        scope: "fallback",
                      }),
                    ],
                    codeActions: createUnavailableEvalCodeActions(
                      "Code actions are unavailable because diagnostics used compiler_api fallback.",
                    ),
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.diagnosticEngine === "compiler_api" &&
              metrics.diagnosticFallbackUsed === true &&
              metrics.codeActionAvailable === false &&
              metrics.codeActionSource === "unavailable" &&
              metrics.codeActionCandidateCount === 0,
            score: metrics.codeActionSource === "unavailable" ? 1 : 0.35,
            metrics,
            failureReason: metrics.codeActionSource !== "unavailable"
              ? `expected unavailable code actions under compiler_api fallback, got ${metrics.codeActionSource}`
              : null,
          };
        },
      },
      {
        name: "tsserver-richer-project-context-is-available-and-counted",
        capabilityTags: ["verification", "diagnostics", "project-context"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "failed",
                summary: "tsserver diagnostics carried bounded project context for the blocking symbol.",
                failureCategories: ["diagnostic_error"],
                diagnosticErrorCount: 1,
                checks: [
                  createVerifierCheckResult({
                    id: "diagnostics:project-context",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "failed",
                    category: "diagnostic_error",
                    summary: "TypeScript diagnostics reported a blocking symbol error with project context.",
                    findings: [
                      createVerifierFinding({
                        kind: "diagnostics",
                        status: "failed",
                        severity: "error",
                        category: "diagnostic_error",
                        message: "Cannot find name 'value'.",
                        path: "/repo/src/context.ts",
                        line: 1,
                        column: 8,
                        code: "TS2304",
                        source: "typescript",
                        scope: "file",
                      }),
                    ],
                    projectContext: createTsServerEvalProjectContext({
                      diagnosticFingerprint: "diag-project-context-ts2304",
                      filePath: "/repo/src/context.ts",
                      implementationPaths: [
                        "/repo/src/context.ts",
                        "/repo/src/worker.ts",
                      ],
                      referencePaths: [
                        "/repo/src/context.ts",
                        "/repo/src/consumer.ts",
                      ],
                      documentSymbolNames: ["Worker", "run", "typed"],
                    }),
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.projectContextAvailable === true &&
              metrics.projectContextSource === "tsserver" &&
              metrics.projectContextCount === 1 &&
              metrics.projectContextDiagnosticCoverageCount === 1 &&
              metrics.projectContextQuickInfoCount === 1 &&
              metrics.projectContextDefinitionCount === 1 &&
              metrics.projectContextImplementationCount === 2 &&
              metrics.projectContextReferenceCount === 2 &&
              metrics.projectContextDocumentSymbolCount === 3,
            score: metrics.projectContextAvailable ? 1 : 0.35,
            metrics,
            failureReason: metrics.projectContextSource !== "tsserver"
              ? `expected tsserver project context, got ${metrics.projectContextSource}`
              : null,
          };
        },
      },
      {
        name: "compiler-api-fallback-richer-project-context-stays-unavailable",
        capabilityTags: ["verification", "diagnostics", "fallback", "project-context"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "failed",
                summary: "Compiler API fallback diagnostics stayed actionable but project context remained unavailable.",
                failureCategories: ["diagnostic_error"],
                diagnosticErrorCount: 1,
                diagnosticEngine: "compiler_api",
                diagnosticFallbackUsed: true,
                diagnosticFallbackReason: "tsserver transport exited unexpectedly",
                diagnosticTransportAvailable: false,
                checks: [
                  createVerifierCheckResult({
                    id: "diagnostics:fallback-project-context",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "failed",
                    category: "diagnostic_error",
                    summary: "Compiler API fallback reported a blocking diagnostic with no project context.",
                    findings: [
                      createVerifierFinding({
                        kind: "diagnostics",
                        status: "failed",
                        severity: "error",
                        category: "diagnostic_error",
                        message: "Cannot find name 'missingValue'.",
                        path: "/repo/src/fallback-context.ts",
                        line: 2,
                        column: 3,
                        code: "TS2304",
                        source: "typescript",
                        scope: "fallback",
                      }),
                    ],
                    projectContext: createUnavailableEvalProjectContext(
                      "Project context is unavailable because diagnostics used compiler_api fallback.",
                      true,
                    ),
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.diagnosticEngine === "compiler_api" &&
              metrics.projectContextAvailable === false &&
              metrics.projectContextSource === "unavailable" &&
              metrics.projectContextCount === 0 &&
              metrics.projectContextImplementationCount === 0 &&
              metrics.projectContextDocumentSymbolCount === 0,
            score: metrics.projectContextSource === "unavailable" ? 1 : 0.35,
            metrics,
            failureReason: metrics.projectContextSource !== "unavailable"
              ? `expected unavailable project context under compiler_api fallback, got ${metrics.projectContextSource}`
              : null,
          };
        },
      },
      {
        name: "inspect-summary-matches-richer-project-context-counters",
        capabilityTags: ["verification", "inspect", "project-context"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "failed",
                summary: "Verifier recorded richer project context counters.",
                failureCategories: ["diagnostic_error"],
                diagnosticErrorCount: 1,
                checks: [
                  createVerifierCheckResult({
                    id: "diagnostics:inspect-project-context",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "failed",
                    category: "diagnostic_error",
                    summary: "Project context carried implementations and document symbols.",
                    findings: [
                      createVerifierFinding({
                        kind: "diagnostics",
                        status: "failed",
                        severity: "error",
                        category: "diagnostic_error",
                        message: "Type 'string' is not assignable to type 'number'.",
                        path: "/repo/src/inspect-context.ts",
                        line: 8,
                        column: 14,
                        code: "TS2322",
                        source: "typescript",
                        scope: "file",
                      }),
                    ],
                    projectContext: createTsServerEvalProjectContext({
                      diagnosticFingerprint: "diag-inspect-project-context-ts2322",
                      filePath: "/repo/src/inspect-context.ts",
                      implementationPaths: ["/repo/src/inspect-context.ts"],
                      referencePaths: ["/repo/src/inspect-context.ts"],
                      documentSymbolNames: ["Worker", "run", "typed"],
                    }),
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.inspectSummaryMatches === true &&
              metrics.projectContextImplementationCount === 1 &&
              metrics.projectContextDocumentSymbolCount === 3,
            score: metrics.inspectSummaryMatches ? 1 : 0.35,
            metrics,
            failureReason: metrics.inspectSummaryMatches
              ? null
              : "expected inspect summary to match richer project-context counters",
          };
        },
      },
      {
        name: "code-action-apply-still-requires-verifier-re-pass",
        capabilityTags: ["verification", "repair", "code-actions"],
        run: () => {
          const failingCheck = createVerifierCheckResult({
            id: "diagnostics:code-action-rerun-before",
            kind: "diagnostics",
            label: "Collect diagnostics",
            status: "failed",
            category: "diagnostic_error",
            summary: "Verifier failed with an allowlisted code action candidate.",
            findings: [
              createVerifierFinding({
                kind: "diagnostics",
                status: "failed",
                severity: "error",
                category: "diagnostic_error",
                message: "Cannot find name 'readFileSync'.",
                path: "/repo/src/repass.ts",
                line: 1,
                column: 21,
                code: "TS2304",
                source: "typescript",
                scope: "file",
              }),
            ],
            codeActions: createTsServerEvalCodeActions({
              diagnosticFingerprints: ["diag-repass-ts2304"],
              filePaths: ["/repo/src/repass.ts"],
              titles: ["Add import from \"node:fs\""],
              allowlistedCount: 1,
            }),
          });
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            startedAt: "2026-04-05T00:00:00.000Z",
            finishedAt: "2026-04-05T00:00:01.000Z",
            summary: "Verifier failed before a bounded code action was applied.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [failingCheck],
          });
          const secondFailure = createVerifierRunRecord({
            status: "failed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Verifier still failed after the allowlisted code action was applied.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:code-action-rerun-after",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "A different blocking diagnostic still remains after the code action apply.",
                findings: [
                  createVerifierFinding({
                    kind: "diagnostics",
                    status: "failed",
                    severity: "error",
                    category: "diagnostic_error",
                    message: "Property 'trim' does not exist on type 'number'.",
                    path: "/repo/src/repass.ts",
                    line: 5,
                    column: 19,
                    code: "TS2339",
                    source: "typescript",
                    scope: "file",
                  }),
                ],
                codeActions: createTsServerEvalCodeActions({
                  diagnosticFingerprints: ["diag-repass-ts2339"],
                  filePaths: ["/repo/src/repass.ts"],
                  titles: [],
                  allowlistedCount: 0,
                }),
              }),
            ],
          });
          const appliedAction = failingCheck.codeActions?.actions[0];
          const repairLoop = createRepairLoopRecord({
            status: "exhausted",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:03.250Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "failed",
                summary: "Repair attempt 1/1 applied the allowlisted code action but verifier still failed afterward.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondFailure.startedAt,
                resultVerifierStep: secondFailure.step,
                resultVerifierSummary: secondFailure.summary.summary,
                resultVerifierRun: secondFailure,
                directive: createRepairDirective({
                  traceId: "trace-verification",
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  attempt: 1,
                  maxAttempts: 1,
                  summary: "Apply the bounded import fix, then rerun verifier.",
                  instruction: "Even after bounded auto-apply, the turn must still wait for verifier to pass.",
                  failureCategories: ["diagnostic_error"],
                  filePaths: ["/repo/src/repass.ts"],
                  codeActions: failingCheck.codeActions ?? createUnavailableEvalCodeActions("missing code actions"),
                }),
                codeAction: createEvalCodeActionApplyResult({
                  status: "applied",
                  candidate: appliedAction ?? null,
                  approvalStatus: "approved",
                  approvalRequired: true,
                  toolName: "write_file",
                  changeSetId: "change-repass-1",
                  touchedFiles: ["/repo/src/repass.ts"],
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  summary: "Applied the allowlisted code action, but verifier still needed to pass again.",
                }),
              }),
            ],
            stopReason: "attempts_exhausted",
            summary: "Repair loop exhausted because verifier still failed after bounded code-action apply.",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondFailure],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.codeActionAppliedCount === 1 &&
              metrics.latestCodeActionStatus === "applied" &&
              metrics.verifierStatus === "failed" &&
              metrics.finalOutcome === "failed",
            score: metrics.codeActionAppliedCount === 1 ? 1 : 0.35,
            metrics,
            failureReason: metrics.finalOutcome !== "failed"
              ? `expected verifier failure after code action apply until re-pass, got ${metrics.finalOutcome}`
              : null,
          };
        },
      },
      {
        name: "diagnostics-warning-only-does-not-fail",
        capabilityTags: ["verification", "diagnostics", "warnings"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "passed",
                summary: "Verifier passed with warning-only diagnostics.",
                diagnosticWarningCount: 1,
                checks: [
                  createVerifierCheckResult({
                    id: "diagnostics:warning",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "passed",
                    summary: "Diagnostics produced warnings only.",
                    findings: [
                      createVerifierFinding({
                        kind: "diagnostics",
                        status: "passed",
                        severity: "warning",
                        category: null,
                        message: "This is only a warning.",
                        path: "/repo/src/warning.ts",
                        line: 1,
                        column: 1,
                        code: "mock-warning",
                        source: "typescript",
                        scope: "file",
                        rule: "mock-rule",
                      }),
                    ],
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({ success: true, stopped: false })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.verifierStatus === "passed" &&
              metrics.diagnosticWarningCount === 1 &&
              metrics.finalOutcome === "success",
            score: metrics.finalOutcome === "success" ? 1 : 0.35,
            metrics,
            failureReason: metrics.finalOutcome !== "success"
              ? `expected warning-only diagnostics to pass, got ${metrics.finalOutcome}`
              : null,
          };
        },
      },
      {
        name: "parse-failure-suppresses-duplicate-diagnostics",
        capabilityTags: ["verification", "diagnostics", "noise-control"],
        run: () => {
          const report = createVerificationEvalReport({
            verifierRuns: [
              createVerifierRunRecord({
                status: "failed",
                summary: "Verifier failed on syntax parsing and suppressed duplicate diagnostics noise.",
                failureCategories: ["syntax_error"],
                checks: [
                  createVerifierCheckResult({
                    id: "file_parse:broken",
                    kind: "file_parse",
                    label: "Parse changed file",
                    status: "failed",
                    category: "syntax_error",
                    summary: "TypeScript syntax parsing failed.",
                    filePath: "/repo/src/broken.ts",
                    findings: [
                      createVerifierFinding({
                        kind: "file_parse",
                        status: "failed",
                        severity: "error",
                        category: "syntax_error",
                        message: "Expression expected.",
                        path: "/repo/src/broken.ts",
                        line: 1,
                        column: 22,
                        source: "typescript",
                        scope: "file",
                      }),
                    ],
                  }),
                  createVerifierCheckResult({
                    id: "diagnostics:broken",
                    kind: "diagnostics",
                    label: "Collect diagnostics",
                    status: "skipped",
                    summary: "Diagnostics were skipped to avoid duplicate noise after parse failure.",
                    skippedReason: "duplicate_noise_after_parse_failure",
                  }),
                ],
              }),
            ],
            finals: [createReplayFinalEvent({
              success: false,
              stopped: true,
              errorTaxonomy: "verifier_failed",
            })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          return {
            pass:
              metrics.verifierStatus === "failed" &&
              metrics.duplicateDiagnosticsSuppressed === true &&
              metrics.diagnosticErrorCount === 0,
            score: metrics.duplicateDiagnosticsSuppressed ? 1 : 0.35,
            metrics,
            failureReason: metrics.duplicateDiagnosticsSuppressed !== true
              ? "expected duplicate diagnostics suppression after parse failure"
              : null,
          };
        },
      },
      {
        name: "inspect-report-matches-recorded-outcome",
        capabilityTags: ["verification", "inspect", "replay"],
        run: () => {
          const firstFailure = createVerifierRunRecord({
            status: "failed",
            step: 1,
            startedAt: "2026-04-05T00:00:00.000Z",
            finishedAt: "2026-04-05T00:00:01.000Z",
            summary: "Verifier failed because diagnostics reported errors.",
            failureCategories: ["diagnostic_error"],
            diagnosticErrorCount: 1,
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:first",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "failed",
                category: "diagnostic_error",
                summary: "TypeScript diagnostics reported errors.",
                codeActions: createTsServerEvalCodeActions({
                  diagnosticFingerprints: ["diag-inspect-first"],
                  filePaths: ["/repo/src/broken.ts"],
                  titles: ["Add import from \"node:fs\""],
                  allowlistedCount: 1,
                }),
              }),
            ],
          });
          const secondPass = createVerifierRunRecord({
            status: "passed",
            step: 2,
            startedAt: "2026-04-05T00:00:02.000Z",
            finishedAt: "2026-04-05T00:00:03.000Z",
            summary: "Verifier passed after repair.",
            checks: [
              createVerifierCheckResult({
                id: "diagnostics:second",
                kind: "diagnostics",
                label: "Collect diagnostics",
                status: "passed",
                summary: "Diagnostics passed after repair.",
                codeActions: createTsServerEvalCodeActions({
                  diagnosticFingerprints: [],
                  filePaths: ["/repo/src/broken.ts"],
                  titles: [],
                  allowlistedCount: 0,
                }),
              }),
            ],
          });
          const appliedAction = firstFailure.checks[0]?.codeActions?.actions[0] ?? null;
          const repairLoop = createRepairLoopRecord({
            status: "succeeded",
            startedAt: "2026-04-05T00:00:01.250Z",
            finishedAt: "2026-04-05T00:00:02.750Z",
            initialVerifierStartedAt: firstFailure.startedAt,
            initialVerifierStep: firstFailure.step,
            initialFailureCategories: ["diagnostic_error"],
            attempts: [
              createRepairAttemptRecord({
                attempt: 1,
                status: "succeeded",
                summary: "Repair attempt 1/1 succeeded.",
                triggerVerifierStartedAt: firstFailure.startedAt,
                triggerVerifierStep: firstFailure.step,
                triggerVerifierSummary: firstFailure.summary.summary,
                triggerVerifierRun: firstFailure,
                resultVerifierStartedAt: secondPass.startedAt,
                resultVerifierStep: secondPass.step,
                resultVerifierSummary: secondPass.summary.summary,
                resultVerifierRun: secondPass,
                directive: createRepairDirective({
                  traceId: "trace-verification",
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  attempt: 1,
                  maxAttempts: 1,
                  summary: "Fix the typed diagnostics and rerun verification.",
                  instruction: "Repair the failing diagnostics before success is allowed.",
                  failureCategories: ["diagnostic_error"],
                  filePaths: ["/repo/src/broken.ts"],
                  codeActions: firstFailure.checks[0]?.codeActions ?? createUnavailableEvalCodeActions("missing code actions"),
                }),
                codeAction: createEvalCodeActionApplyResult({
                  status: "applied",
                  candidate: appliedAction,
                  approvalStatus: "approved",
                  approvalRequired: true,
                  toolName: "write_file",
                  changeSetId: "change-inspect-1",
                  touchedFiles: ["/repo/src/broken.ts"],
                  verifierRunStartedAt: firstFailure.startedAt,
                  verifierStep: firstFailure.step,
                  summary: "Applied the allowlisted code action before verifier re-pass.",
                }),
              }),
            ],
            stopReason: null,
            summary: "Repair loop succeeded after 1 attempt(s).",
          });
          const report = createVerificationEvalReport({
            verifierRuns: [firstFailure, secondPass],
            repairLoops: [repairLoop],
            finals: [createReplayFinalEvent({ success: true, stopped: false })],
          });
          const metrics = collectVerificationEvalMetrics(report);
          const expected = report.latest.verifierRun?.summary.status === secondPass.summary.status &&
            report.latest.repairLoop?.summary.status === repairLoop.summary.status &&
            report.summary.repairAttemptCount === repairLoop.attempts.length &&
            report.summary.diagnosticErrorCount === 1 &&
            report.summary.codeActionCandidateCount === 1 &&
            report.summary.codeActionAppliedCount === 1 &&
            report.summary.latestCodeActionApplied === true &&
            report.summary.latestCodeActionStatus === "applied" &&
            report.summary.finalOutcome === "success";
          return {
            pass: expected && metrics.inspectSummaryMatches === true,
            score: expected ? 1 : 0.35,
            metrics,
            failureReason: expected ? null : "inspect report did not match the recorded verifier/repair outcome",
          };
        },
      },
    ],
    continuity: [
      {
        name: "resume-continuity-preserves-core-runtime-surfaces",
        capabilityTags: ["continuity", "resume", "runtime"],
        run: () => {
          const continuity = context.runtimeContinuity ?? {
            shellJobs: [{ id: "job-1", continuityState: "reattached", canCancel: true }],
            lastSourcePack: { sourceIds: ["S1"] },
            intelligence: { taskClassification: { taskClass: "bug_fix" } },
          };
          return {
            pass:
              Array.isArray(continuity.shellJobs) &&
              continuity.shellJobs.length > 0 &&
              Boolean(continuity.lastSourcePack) &&
              Boolean(continuity.intelligence),
            score: continuity.shellJobs?.length ? 1 : 0.45,
            metrics: continuity,
            failureReason: null,
          };
        },
      },
    ],
    shell: [
      {
        name: "shell-attach-boundary-stays-honest",
        capabilityTags: ["shell", "continuity", "safety"],
        run: () => {
          const samples = context.shellSamples ?? [
            { id: "job-live", attachStrategy: { mode: "live_attach_supervised" }, live: true, historicalOnly: false },
            { id: "job-old", attachStrategy: { mode: "historical_only" }, live: false, historicalOnly: true },
          ];
          const invalid = samples.find((entry) =>
            entry.historicalOnly === true &&
            entry.attachStrategy?.mode !== "historical_only",
          );
          return {
            pass: !invalid,
            score: invalid ? 0.2 : 1,
            metrics: {
              samples,
            },
            failureReason: invalid ? `historical job ${invalid.id} was marked attachable` : null,
          };
        },
      },
    ],
  };
}

function createVerificationEvalReport(input: {
  verifierRuns: VerifierRunRecord[];
  repairLoops?: RepairLoopRecord[];
  finals?: SessionReplay["finals"];
}): VerifierInspectReport {
  return buildReplayVerifierInspectReport({
    session: {
      id: "eval-verification-session",
      provider: "mock",
      model: "mock-mj-code-v1",
      cwd: "/repo",
      networkMode: "docs-only",
      webProvider: "fallback",
      parentSessionId: null,
      branchType: "root",
    },
    lineage: {
      rootSessionId: "eval-verification-session",
      parentSessionId: null,
      branchDepth: 0,
      branchType: "root",
      resumedAt: null,
      resumedFromSnapshot: null,
      ancestors: [],
      children: [],
    },
    branchEventsSessionId: "eval-verification-session",
    prompts: [],
    context: [],
    approvals: [],
    toolCalls: [],
    webEvents: [],
    mcpEvents: [],
    hookEvents: [],
    boundaryDecisions: [],
    sourcePacks: [],
    changes: [],
    verifierRuns: input.verifierRuns.map((run) => ({
      timestamp: run.finishedAt,
      run,
    })),
    repairLoops: (input.repairLoops ?? []).map((loop) => ({
      timestamp: loop.finishedAt ?? loop.startedAt,
      loop,
    })),
    finals: input.finals ?? [],
  });
}

function createVerifierRunRecord(input: {
  status: VerifierStatus;
  step?: number;
  startedAt?: string;
  finishedAt?: string;
  summary: string;
  checks?: VerifierCheckResult[];
  failureCategories?: VerifierFailureCategory[];
  diagnosticErrorCount?: number;
  diagnosticWarningCount?: number;
  diagnosticInfoCount?: number;
  diagnosticEngine?: VerifierRunRecord["summary"]["diagnosticEngine"];
  diagnosticFallbackUsed?: boolean;
  diagnosticFallbackReason?: string | null;
  diagnosticTransportAvailable?: boolean;
  fixHintAvailable?: boolean;
  fixHintSource?: VerifierRunRecord["summary"]["fixHintSource"];
  fixHintCount?: number;
  recommendedFixHintCount?: number;
  fixHintFileCount?: number;
  fixHintReason?: string | null;
  codeActionAvailable?: boolean;
  codeActionSource?: VerifierRunRecord["summary"]["codeActionSource"];
  codeActionCandidateCount?: number;
  codeActionAllowlistedCount?: number;
  codeActionBlockedCount?: number;
  codeActionReason?: string | null;
  projectContextAvailable?: boolean;
  projectContextSource?: VerifierRunRecord["summary"]["projectContextSource"];
  projectContextCount?: number;
  projectContextDiagnosticCoverageCount?: number;
  projectContextQuickInfoCount?: number;
  projectContextDefinitionCount?: number;
  projectContextImplementationCount?: number;
  projectContextReferenceCount?: number;
  projectContextDocumentSymbolCount?: number;
  projectContextFileCount?: number;
  projectContextReason?: string | null;
}): VerifierRunRecord {
  const checks = input.checks ?? [];
  const status = input.status;
  const hasDiagnosticsCheck = checks.some((entry) => entry.kind === "diagnostics");
  const diagnosticsCheck = checks.find((entry) => entry.kind === "diagnostics");
  const fixHintSummary = diagnosticsCheck?.fixHints?.summary ?? null;
  const codeActionSummary = diagnosticsCheck?.codeActions?.summary ?? null;
  return {
    traceId: "trace-verification",
    step: input.step ?? 1,
    startedAt: input.startedAt ?? "2026-04-05T00:00:00.000Z",
    finishedAt: input.finishedAt ?? "2026-04-05T00:00:01.000Z",
    plan: {
      required: true,
      trigger: "files_changed",
      reason: "Verifier required because files changed.",
      checks: [],
    },
    checks,
    summary: {
      status,
      passed: status !== "failed",
      totalChecks: checks.length,
      passedChecks: checks.filter((entry) => entry.status === "passed").length,
      failedChecks: checks.filter((entry) => entry.status === "failed").length,
      skippedChecks: checks.filter((entry) => entry.status === "skipped" || entry.status === "unavailable").length,
      findings: checks.reduce((total, entry) => total + entry.findings.length, 0),
      failureCategories: input.failureCategories ?? dedupeFailureCategories(checks),
      diagnosticErrorCount: input.diagnosticErrorCount ?? 0,
      diagnosticWarningCount: input.diagnosticWarningCount ?? 0,
      diagnosticInfoCount: input.diagnosticInfoCount ?? 0,
      diagnosticProviderAvailable: true,
      diagnosticEngine: input.diagnosticEngine ?? (hasDiagnosticsCheck ? "tsserver" : "none"),
      diagnosticFallbackUsed: input.diagnosticFallbackUsed ?? false,
      diagnosticFallbackReason: input.diagnosticFallbackReason ?? null,
      diagnosticTransportAvailable: input.diagnosticTransportAvailable ?? hasDiagnosticsCheck,
      fixHintAvailable: input.fixHintAvailable ?? fixHintSummary?.available ?? false,
      fixHintSource: input.fixHintSource ?? fixHintSummary?.source ?? "none",
      fixHintCount: input.fixHintCount ?? fixHintSummary?.total ?? 0,
      recommendedFixHintCount: input.recommendedFixHintCount ?? fixHintSummary?.recommendedCount ?? 0,
      fixHintFileCount: input.fixHintFileCount ?? fixHintSummary?.fileCount ?? 0,
      fixHintReason: input.fixHintReason ?? fixHintSummary?.reason ?? null,
      codeActionAvailable: input.codeActionAvailable ?? codeActionSummary?.available ?? false,
      codeActionSource: input.codeActionSource ?? codeActionSummary?.source ?? "none",
      codeActionCandidateCount: input.codeActionCandidateCount ?? codeActionSummary?.total ?? 0,
      codeActionAllowlistedCount: input.codeActionAllowlistedCount ?? codeActionSummary?.allowlistedCount ?? 0,
      codeActionBlockedCount: input.codeActionBlockedCount ?? codeActionSummary?.blockedCount ?? 0,
      codeActionReason: input.codeActionReason ?? codeActionSummary?.reason ?? null,
      projectContextAvailable: input.projectContextAvailable ?? diagnosticsCheck?.projectContext?.summary.available ?? false,
      projectContextSource: input.projectContextSource ?? diagnosticsCheck?.projectContext?.summary.source ?? "none",
      projectContextCount: input.projectContextCount ?? diagnosticsCheck?.projectContext?.summary.total ?? 0,
      projectContextDiagnosticCoverageCount:
        input.projectContextDiagnosticCoverageCount
        ?? diagnosticsCheck?.projectContext?.summary.diagnosticCoverageCount
        ?? 0,
      projectContextQuickInfoCount:
        input.projectContextQuickInfoCount
        ?? diagnosticsCheck?.projectContext?.summary.quickInfoCount
        ?? 0,
      projectContextDefinitionCount:
        input.projectContextDefinitionCount
        ?? diagnosticsCheck?.projectContext?.summary.definitionCount
        ?? 0,
      projectContextImplementationCount:
        input.projectContextImplementationCount
        ?? diagnosticsCheck?.projectContext?.summary.implementationCount
        ?? 0,
      projectContextReferenceCount:
        input.projectContextReferenceCount
        ?? diagnosticsCheck?.projectContext?.summary.referenceCount
        ?? 0,
      projectContextDocumentSymbolCount:
        input.projectContextDocumentSymbolCount
        ?? diagnosticsCheck?.projectContext?.summary.documentSymbolCount
        ?? 0,
      projectContextFileCount:
        input.projectContextFileCount
        ?? diagnosticsCheck?.projectContext?.summary.fileCount
        ?? 0,
      projectContextReason: input.projectContextReason ?? diagnosticsCheck?.projectContext?.summary.reason ?? null,
      summary: input.summary,
      durationMs: 100,
    },
  };
}

function createVerifierCheckResult(input: {
  id: string;
  kind: VerifierCheckResult["kind"];
  label: string;
  status: VerifierStatus;
  summary: string;
  findings?: VerifierCheckResult["findings"];
  category?: VerifierFailureCategory | null;
  filePath?: string | null;
  command?: VerifierCheckResult["command"];
  exitCode?: number | null;
  stdoutSummary?: string | null;
  stderrSummary?: string | null;
  skippedReason?: string | null;
  fixHints?: VerifierCheckResult["fixHints"];
  codeActions?: VerifierCheckResult["codeActions"];
  projectContext?: VerifierCheckResult["projectContext"];
}): VerifierCheckResult {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    status: input.status,
    passed: input.status !== "failed",
    summary: input.summary,
    durationMs: 20,
    filePath: input.filePath ?? null,
    command: input.command ?? null,
    findings: input.findings ?? [],
    category: input.category ?? null,
    exitCode: input.exitCode ?? null,
    stdoutSummary: input.stdoutSummary ?? null,
    stderrSummary: input.stderrSummary ?? null,
    skippedReason: input.skippedReason ?? null,
    fixHints: input.fixHints ?? null,
    codeActions: input.codeActions ?? null,
    projectContext: input.projectContext ?? null,
    metadata: null,
  };
}

function createVerifierFinding(input: {
  kind: VerifierCheckResult["kind"];
  status: VerifierStatus;
  severity: "error" | "warning" | "info";
  message: string;
  category?: VerifierFailureCategory | null;
  path?: string | null;
  line?: number | null;
  column?: number | null;
  code?: string | null;
  source?: string | null;
  scope?: string | null;
  rule?: string | null;
}): VerifierCheckResult["findings"][number] {
  return {
    kind: input.kind,
    status: input.status,
    severity: input.severity,
    category: input.category ?? null,
    message: input.message,
    path: input.path ?? null,
    line: input.line ?? null,
    column: input.column ?? null,
    code: input.code ?? null,
    source: input.source ?? null,
    scope: input.scope ?? null,
    rule: input.rule ?? null,
    related: [],
    excerpt: null,
    meta: null,
  };
}

function createTsServerEvalFixHints(input: {
  diagnosticFingerprints: string[];
  filePaths: string[];
  titles?: string[];
  recommendedCount?: number;
}): NonNullable<VerifierCheckResult["fixHints"]> {
  const titles = input.titles ?? ["Update the typed value to match the declared type."];
  const recommendedCount = Math.max(0, Math.min(
    titles.length,
    input.recommendedCount ?? Math.min(1, titles.length),
  ));
  const hints = titles.map((title, index) => ({
    id: `fix-hint-${index + 1}-${titles.length}`,
    source: "tsserver" as const,
    title,
    kind: index === 0 ? "quickfix" as const : "fix_all" as const,
    reason: "Suggested by tsserver from the recorded diagnostics.",
    recommended: index < recommendedCount,
    diagnosticFingerprints: [...input.diagnosticFingerprints],
    filePaths: [...input.filePaths],
    edits: [{
      path: input.filePaths[0] ?? null,
      isNewFile: false,
      changeCount: 1,
      changes: [{
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
        newTextPreview: "const fixedValue = /* ... */;",
        newTextLength: 29,
      }],
    }],
    fixName: index === 0 ? "fix-typed-value" : "fix-typed-value-all",
    fixId: index === 0 ? null : JSON.stringify({ fixId: "fix-typed-value-all" }),
  }));
  return {
    availability: {
      available: true,
      source: "tsserver",
      reason: null,
      transportAvailable: true,
      fallbackUsed: false,
      fallbackReason: null,
    },
    hints,
    summary: {
      total: hints.length,
      recommendedCount: hints.filter((hint) => hint.recommended).length,
      fileCount: new Set(input.filePaths).size,
      available: true,
      source: "tsserver",
      reason: null,
    },
  };
}

function createTsServerEvalCodeActions(input: {
  diagnosticFingerprints: string[];
  filePaths: string[];
  titles?: string[];
  allowlistedCount?: number;
}): NonNullable<VerifierCheckResult["codeActions"]> {
  const titles = input.titles ?? ["Add import from \"node:path\""];
  const allowlistedCount = Math.max(0, Math.min(
    titles.length,
    input.allowlistedCount ?? Math.min(1, titles.length),
  ));
  const actions = titles.map((title, index) => ({
    id: `code-action-${index + 1}-${titles.length}`,
    source: "tsserver" as const,
    title,
    kind: "quickfix" as const,
    reason: "Suggested by tsserver from the recorded diagnostics.",
    recommended: index === 0,
    diagnosticFingerprints: [...input.diagnosticFingerprints],
    filePaths: [...input.filePaths],
    edits: [{
      path: input.filePaths[0] ?? null,
      isNewFile: false,
      changeCount: 1,
      changes: [{
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
        newText: "import { join } from \"node:path\";\n",
        newTextPreview: "import { join } from \"node:path\";",
        newTextLength: 34,
        textTruncated: false,
      }],
    }],
    fixName: index === 0 ? "import" : "fixUnexpectedValue",
    fixId: null,
    allowlisted: index < allowlistedCount,
    allowlistRule: index < allowlistedCount ? "add_import_single_file" : null,
    blockedReason: index < allowlistedCount ? null : "not_allowlisted" as const,
  }));
  return {
    availability: {
      available: true,
      source: "tsserver",
      reason: null,
      transportAvailable: true,
      fallbackUsed: false,
      fallbackReason: null,
    },
    actions,
    summary: {
      total: actions.length,
      allowlistedCount: actions.filter((action) => action.allowlisted).length,
      blockedCount: actions.filter((action) => !action.allowlisted).length,
      fileCount: new Set(input.filePaths).size,
      available: true,
      source: "tsserver",
      reason: null,
    },
  };
}

function createUnavailableEvalFixHints(
  reason: string,
): NonNullable<VerifierCheckResult["fixHints"]> {
  return {
    availability: {
      available: false,
      source: "unavailable",
      reason,
      transportAvailable: false,
      fallbackUsed: false,
      fallbackReason: null,
    },
    hints: [],
    summary: {
      total: 0,
      recommendedCount: 0,
      fileCount: 0,
      available: false,
      source: "unavailable",
      reason,
    },
  };
}

function createUnavailableEvalCodeActions(
  reason: string,
): NonNullable<VerifierCheckResult["codeActions"]> {
  return {
    availability: {
      available: false,
      source: "unavailable",
      reason,
      transportAvailable: false,
      fallbackUsed: false,
      fallbackReason: null,
    },
    actions: [],
    summary: {
      total: 0,
      allowlistedCount: 0,
      blockedCount: 0,
      fileCount: 0,
      available: false,
      source: "unavailable",
      reason,
    },
  };
}

function createTsServerEvalProjectContext(input: {
  diagnosticFingerprint: string;
  filePath: string;
  symbolDisplayText?: string;
  definitionPath?: string;
  implementationPaths?: string[];
  referencePaths?: string[];
  documentSymbolNames?: string[];
}): NonNullable<VerifierCheckResult["projectContext"]> {
  const definitionPath = input.definitionPath ?? input.filePath;
  const implementationPaths = input.implementationPaths ?? [definitionPath];
  const referencePaths = input.referencePaths ?? [input.filePath];
  const documentSymbolNames = input.documentSymbolNames ?? ["value", "typed"];
  const references = referencePaths.map((referencePath, index) => ({
    path: referencePath,
    line: index + 1,
    column: 1,
    endLine: index + 1,
    endColumn: 8,
    lineText: `const symbolUse${index + 1} = value;`,
    isDefinition: index === 0,
    isWriteAccess: false,
  }));
  const implementations = implementationPaths.map((implementationPath, index) => ({
    path: implementationPath,
    line: index + 2,
    column: 1,
    endLine: index + 2,
    endColumn: 12,
    contextStartLine: index + 2,
    contextStartColumn: 1,
    contextEndLine: index + 4,
    contextEndColumn: 1,
  }));
  const documentSymbols = documentSymbolNames.map((name, index) => ({
    path: input.filePath,
    line: index + 1,
    column: 1,
    endLine: index + 1,
    endColumn: Math.max(2, name.length + 1),
    name,
    kind: index === 0 ? "interface" : index === 1 ? "memberFunction" : "const",
    kindModifiers: index === 0 ? "export" : "",
    containerName: index > 0 ? documentSymbolNames[0] : null,
    depth: index > 0 ? 1 : 0,
    childCount: 0,
  }));
  return {
    availability: {
      available: true,
      source: "tsserver",
      reason: null,
      transportAvailable: true,
      fallbackUsed: false,
      fallbackReason: null,
    },
    items: [{
      diagnosticFingerprint: input.diagnosticFingerprint,
      path: input.filePath,
      line: 1,
      column: 1,
      code: "TS2304",
      message: "Cannot find name 'value'.",
      source: "typescript",
      scope: "file",
      quickInfo: {
        path: null,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 6,
        kind: "const",
        kindModifiers: "export",
        displayText: input.symbolDisplayText ?? "const value: string",
        documentation: "Synthetic tsserver quick info.",
      },
      definitions: [{
        path: definitionPath,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 6,
        kind: "const",
        name: "value",
        containerName: null,
      }],
      implementations,
      implementationCount: implementations.length,
      implementationsTruncated: false,
      references,
      referenceCount: references.length,
      referencesTruncated: false,
      enclosingSymbol: documentSymbols[1] ?? documentSymbols[0] ?? null,
      documentSymbols,
      documentSymbolCount: documentSymbols.length,
      documentSymbolsTruncated: false,
    }],
    summary: {
      total: 1,
      diagnosticCoverageCount: 1,
      quickInfoCount: 1,
      definitionCount: 1,
      implementationCount: implementations.length,
      referenceCount: references.length,
      documentSymbolCount: documentSymbols.length,
      fileCount: new Set([input.filePath, definitionPath, ...implementationPaths, ...referencePaths]).size,
      available: true,
      source: "tsserver",
      reason: null,
    },
  };
}

function createUnavailableEvalProjectContext(
  reason: string,
  fallbackUsed = false,
): NonNullable<VerifierCheckResult["projectContext"]> {
  return {
    availability: {
      available: false,
      source: "unavailable",
      reason,
      transportAvailable: false,
      fallbackUsed,
      fallbackReason: fallbackUsed ? reason : null,
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
      reason,
    },
  };
}

function createEvalCodeActionApplyResult(input: {
  status: NonNullable<RepairLoopRecord["attempts"][number]["codeAction"]>["status"];
  candidate: NonNullable<VerifierCheckResult["codeActions"]>["actions"][number] | null;
  summary: string;
  blockedReason?: NonNullable<RepairLoopRecord["attempts"][number]["codeAction"]>["blockedReason"];
  approvalRequired?: boolean;
  approvalStatus?: NonNullable<RepairLoopRecord["attempts"][number]["codeAction"]>["approvalStatus"];
  toolName?: string | null;
  changeSetId?: string | null;
  touchedFiles?: string[];
  verifierRunStartedAt: string | null;
  verifierStep: string | number | null;
}): NonNullable<RepairLoopRecord["attempts"][number]["codeAction"]> {
  const blockedReason = input.status === "blocked"
    ? input.blockedReason ?? input.candidate?.blockedReason ?? "not_allowlisted"
    : input.blockedReason ?? null;
  const candidate = input.candidate;
  return {
    status: input.status,
    source: candidate?.source ?? "unavailable",
    applied: input.status === "applied",
    candidateId: candidate?.id ?? null,
    title: candidate?.title ?? null,
    kind: candidate?.kind ?? null,
    allowlisted: candidate?.allowlisted ?? false,
    summary: input.summary,
    blockedReason,
    failureReason: input.status === "failed"
      ? input.summary
      : null,
    approvalRequired: input.approvalRequired ?? false,
    approvalStatus: input.approvalStatus ?? (input.status === "applied" ? "not_required" : "blocked"),
    toolName: input.toolName ?? null,
    changeSetId: input.changeSetId ?? null,
    touchedFiles: [...(input.touchedFiles ?? candidate?.filePaths ?? [])],
    verifierRunStartedAt: input.verifierRunStartedAt,
    verifierStep: input.verifierStep,
  };
}

function createRepairDirective(input: {
  traceId: string | null;
  verifierRunStartedAt: string;
  verifierStep: string | number | null;
  attempt: number;
  maxAttempts: number;
  summary: string;
  instruction: string;
  failureCategories: VerifierFailureCategory[];
  filePaths: string[];
  fixHints?: NonNullable<RepairLoopRecord["attempts"][number]["directive"]>["fixHints"];
  codeActions?: NonNullable<RepairLoopRecord["attempts"][number]["directive"]>["codeActions"];
  projectContext?: NonNullable<RepairLoopRecord["attempts"][number]["directive"]>["projectContext"];
}): RepairLoopRecord["attempts"][number]["directive"] {
  const fixHints = input.fixHints ?? createUnavailableEvalFixHints(
    "Fix hints were not recorded for this synthetic repair directive.",
  );
  const codeActions = input.codeActions ?? createUnavailableEvalCodeActions(
    "Code actions were not recorded for this synthetic repair directive.",
  );
  const projectContext = input.projectContext ?? createUnavailableEvalProjectContext(
    "Project context was not recorded for this synthetic repair directive.",
  );
  return {
    traceId: input.traceId,
    verifierRunStartedAt: input.verifierRunStartedAt,
    verifierStep: input.verifierStep,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    summary: input.summary,
    instruction: input.instruction,
    failureCategories: input.failureCategories,
    failedChecks: [],
    items: [],
    fileGroups: input.filePaths.map((filePath) => ({
      path: filePath,
      itemCount: 0,
      diagnosticCount: 0,
      hintCount: 0,
      recommendedHintCount: 0,
      codeActionCount: 0,
      allowlistedCodeActionCount: 0,
      projectContextCount: 0,
      categories: [],
      codes: [],
      items: [],
      definitions: [],
      implementations: [],
      documentSymbols: [],
      hintGroup: {
        path: filePath,
        diagnosticFingerprints: [],
        source: fixHints.availability.source,
        available: fixHints.availability.available,
        reason: fixHints.availability.reason,
        hintCount: 0,
        recommendedHintCount: 0,
        hints: [],
      },
      codeActions: [],
    })),
    fixHints,
    hintGroups: input.filePaths.map((filePath) => ({
      path: filePath,
      diagnosticFingerprints: [],
      source: fixHints.availability.source,
      available: fixHints.availability.available,
      reason: fixHints.availability.reason,
      hintCount: 0,
      recommendedHintCount: 0,
      hints: [],
    })),
    codeActions,
    projectContext,
    filePaths: input.filePaths,
    commands: [],
  };
}

function createRepairAttemptRecord(input: {
  attempt: number;
  status: RepairStatus;
  summary: string;
  triggerVerifierStartedAt: string;
  triggerVerifierStep: string | number | null;
  triggerVerifierSummary: string;
  triggerVerifierRun?: VerifierRunRecord | null;
  resultVerifierStartedAt?: string | null;
  resultVerifierStep?: string | number | null;
  resultVerifierSummary?: string | null;
  resultVerifierRun?: VerifierRunRecord | null;
  directive?: RepairLoopRecord["attempts"][number]["directive"];
  codeAction?: RepairLoopRecord["attempts"][number]["codeAction"];
  continuationMessage?: string | null;
}): RepairLoopRecord["attempts"][number] {
  const baselineDiagnostics = input.triggerVerifierRun
    ? createDiagnosticSnapshotFromVerifierRun(input.triggerVerifierRun)
    : createEmptyDiagnosticSnapshot();
  const convergence = input.triggerVerifierRun && input.resultVerifierRun
    ? createEvalRepairConvergence(input.triggerVerifierRun, input.resultVerifierRun)
    : null;
  return {
    attempt: input.attempt,
    startedAt: "2026-04-05T00:00:01.250Z",
    finishedAt: input.status === "retrying" ? null : "2026-04-05T00:00:02.250Z",
    status: input.status,
    summary: input.summary,
    decision: "retry",
    directive: input.directive ?? null,
    triggerVerifierStartedAt: input.triggerVerifierStartedAt,
    triggerVerifierStep: input.triggerVerifierStep,
    triggerVerifierSummary: input.triggerVerifierSummary,
    baselineDiagnostics,
    convergence,
    codeAction: input.codeAction ?? null,
    resultVerifierStartedAt: input.resultVerifierStartedAt ?? null,
    resultVerifierStep: input.resultVerifierStep ?? null,
    resultVerifierSummary: input.resultVerifierSummary ?? null,
    continuationMessage: input.continuationMessage ?? null,
  };
}

function createRepairLoopRecord(input: {
  status: RepairStatus;
  startedAt: string;
  finishedAt: string | null;
  initialVerifierStartedAt: string;
  initialVerifierStep: string | number | null;
  initialFailureCategories: VerifierFailureCategory[];
  attempts: RepairLoopRecord["attempts"];
  stopReason: RepairLoopRecord["summary"]["stopReason"];
  summary: string;
}): RepairLoopRecord {
  const progress = summarizeEvalRepairAttempts(input.attempts);
  return {
    traceId: "trace-verification",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    maxAttempts: 1,
    initialVerifierStartedAt: input.initialVerifierStartedAt,
    initialVerifierStep: input.initialVerifierStep,
    initialFailureCategories: input.initialFailureCategories,
    attempts: input.attempts,
    summary: {
      status: input.status,
      attemptsUsed: input.attempts.length,
      maxAttempts: 1,
      attemptsRemaining: Math.max(0, 1 - input.attempts.length),
      lastDecision: input.attempts.length > 0 ? input.attempts.at(-1)?.decision ?? null : "stop",
      stopReason: input.stopReason,
      triggeredByVerifierStartedAt: input.initialVerifierStartedAt,
      latestProgress: progress.latestProgress,
      progressTrend: progress.progressTrend,
      resolvedAttemptCount: progress.resolvedAttemptCount,
      improvedAttemptCount: progress.improvedAttemptCount,
      unchangedAttemptCount: progress.unchangedAttemptCount,
      regressedAttemptCount: progress.regressedAttemptCount,
      notApplicableAttemptCount: progress.notApplicableAttemptCount,
      resolvedDiagnosticCount: progress.resolvedDiagnosticCount,
      persistedDiagnosticCount: progress.persistedDiagnosticCount,
      introducedDiagnosticCount: progress.introducedDiagnosticCount,
      codeActionAppliedCount: progress.codeActionAppliedCount,
      codeActionBlockedCount: progress.codeActionBlockedCount,
      latestCodeActionStatus: progress.latestCodeActionStatus,
      summary: input.summary,
    },
  };
}

function createReplayFinalEvent(input: {
  success: boolean;
  stopped: boolean;
  errorTaxonomy?: string;
}): SessionReplay["finals"][number] {
  return {
    timestamp: "2026-04-05T00:00:04.000Z",
    success: input.success,
    stopped: input.stopped,
    errorTaxonomy: input.errorTaxonomy,
    content: null,
    steps: 2,
    sourceIds: [],
  };
}

function collectVerificationEvalMetrics(report: VerifierInspectReport): VerificationEvalMetrics {
  const latestVerifier = report.latest.verifierRun;
  const latestRepair = report.latest.repairLoop;
  const verifierCodeActionCandidateCount = report.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.codeActionCandidateCount ?? 0),
    0,
  );
  const verifierCodeActionAllowlistedCount = report.verifierRuns.reduce(
    (total, entry) => total + Number(entry.summary.codeActionAllowlistedCount ?? 0),
    0,
  );
  const repairAttempts = report.repairLoops.flatMap((entry) => entry.attempts);
  const appliedCodeActionCount = repairAttempts.filter((entry) => entry.codeAction?.status === "applied").length;
  const blockedCodeActionCount = repairAttempts.filter((entry) => entry.codeAction?.status === "blocked").length;
  const latestCodeAction = latestRepair?.attempts.at(-1)?.codeAction ?? null;
  return {
    verifierStatus: report.summary.latestVerifierStatus,
    repairStatus: report.summary.latestRepairStatus,
    finalOutcome: report.summary.finalOutcome,
    verifierRunCount: report.summary.verifierRunCount,
    repairLoopCount: report.summary.repairLoopCount,
    repairAttemptCount: report.summary.repairAttemptCount,
    repairProgress: report.summary.latestRepairProgress,
    repairProgressTrend: report.summary.repairProgressTrend,
    repairResolvedCount: report.summary.repairResolvedCount,
    repairImprovedCount: report.summary.repairImprovedCount,
    repairUnchangedCount: report.summary.repairUnchangedCount,
    repairRegressedCount: report.summary.repairRegressedCount,
    repairNotApplicableCount: report.summary.repairNotApplicableCount,
    resolvedDiagnosticCount: report.summary.resolvedDiagnosticCount,
    persistedDiagnosticCount: report.summary.persistedDiagnosticCount,
    introducedDiagnosticCount: report.summary.introducedDiagnosticCount,
    diagnosticErrorCount: report.summary.diagnosticErrorCount,
    diagnosticWarningCount: report.summary.diagnosticWarningCount,
    diagnosticEngine: report.summary.latestDiagnosticEngine,
    diagnosticFallbackUsed: report.summary.latestDiagnosticFallbackUsed,
    diagnosticFallbackReason: report.summary.latestDiagnosticFallbackReason,
    diagnosticTransportAvailable: report.summary.latestDiagnosticTransportAvailable,
    fixHintAvailable: report.summary.latestFixHintAvailable,
    fixHintSource: report.summary.latestFixHintSource,
    fixHintCount: report.summary.fixHintCount,
    recommendedFixHintCount: report.summary.recommendedFixHintCount,
    fixHintFileCount: report.summary.fixHintFileCount,
    fixHintReason: report.summary.latestFixHintReason,
    codeActionAvailable: report.summary.latestCodeActionAvailable,
    codeActionSource: report.summary.latestCodeActionSource,
    codeActionCandidateCount: report.summary.codeActionCandidateCount,
    codeActionAllowlistedCount: report.summary.codeActionAllowlistedCount,
    codeActionAppliedCount: report.summary.codeActionAppliedCount,
    codeActionBlockedCount: report.summary.codeActionBlockedCount,
    latestCodeActionApplied: report.summary.latestCodeActionApplied,
    latestCodeActionStatus: report.summary.latestCodeActionStatus,
    latestCodeActionBlockedReason: report.summary.latestCodeActionBlockedReason,
    projectContextAvailable: report.summary.latestProjectContextAvailable,
    projectContextSource: report.summary.latestProjectContextSource,
    projectContextCount: report.summary.projectContextCount,
    projectContextDiagnosticCoverageCount: report.summary.projectContextDiagnosticCoverageCount,
    projectContextQuickInfoCount: report.summary.projectContextQuickInfoCount,
    projectContextDefinitionCount: report.summary.projectContextDefinitionCount,
    projectContextImplementationCount: report.summary.projectContextImplementationCount,
    projectContextReferenceCount: report.summary.projectContextReferenceCount,
    projectContextDocumentSymbolCount: report.summary.projectContextDocumentSymbolCount,
    projectContextReason: report.summary.latestProjectContextReason,
    failureCategories: latestVerifier?.summary.failureCategories ?? [],
    stopReason: latestRepair?.summary.stopReason ?? null,
    duplicateDiagnosticsSuppressed: hasSuppressedDuplicateDiagnostics(latestVerifier),
    inspectSummaryMatches:
      report.summary.latestVerifierStatus === (latestVerifier?.summary.status ?? "none") &&
      report.summary.latestRepairStatus === (latestRepair?.summary.status ?? "none") &&
      report.summary.repairAttemptCount === (latestRepair?.attempts.length ?? 0) &&
      report.summary.latestRepairProgress === (latestRepair?.summary.latestProgress ?? "none") &&
      report.summary.repairProgressTrend === (latestRepair?.summary.progressTrend ?? "none") &&
      report.summary.latestFixHintAvailable === (latestVerifier?.summary.fixHintAvailable === true) &&
      report.summary.latestFixHintSource === (latestVerifier?.summary.fixHintSource ?? "none") &&
      report.summary.latestFixHintCount === Number(latestVerifier?.summary.fixHintCount ?? 0) &&
      report.summary.codeActionCandidateCount === verifierCodeActionCandidateCount &&
      report.summary.codeActionAllowlistedCount === verifierCodeActionAllowlistedCount &&
      report.summary.codeActionAppliedCount === appliedCodeActionCount &&
      report.summary.codeActionBlockedCount === blockedCodeActionCount &&
      report.summary.latestCodeActionAvailable === (
        latestCodeAction != null
          ? latestCodeAction.source !== "unavailable"
          : latestVerifier?.summary.codeActionAvailable === true
      ) &&
      report.summary.latestCodeActionSource === (
        latestCodeAction?.source
          ?? latestVerifier?.summary.codeActionSource
          ?? "none"
      ) &&
      report.summary.latestCodeActionApplied === (latestCodeAction?.applied === true) &&
      report.summary.latestCodeActionStatus === (latestRepair?.summary.latestCodeActionStatus ?? "none") &&
      report.summary.latestCodeActionBlockedReason === (latestCodeAction?.blockedReason ?? null) &&
      report.summary.latestProjectContextAvailable === (latestVerifier?.summary.projectContextAvailable === true) &&
      report.summary.latestProjectContextSource === (latestVerifier?.summary.projectContextSource ?? "none") &&
      report.summary.latestProjectContextCount === Number(latestVerifier?.summary.projectContextCount ?? 0) &&
      report.summary.latestProjectContextDiagnosticCoverageCount ===
        Number(latestVerifier?.summary.projectContextDiagnosticCoverageCount ?? 0) &&
      report.summary.latestProjectContextQuickInfoCount ===
        Number(latestVerifier?.summary.projectContextQuickInfoCount ?? 0) &&
      report.summary.latestProjectContextDefinitionCount ===
        Number(latestVerifier?.summary.projectContextDefinitionCount ?? 0) &&
      report.summary.latestProjectContextImplementationCount ===
        Number(latestVerifier?.summary.projectContextImplementationCount ?? 0) &&
      report.summary.latestProjectContextReferenceCount ===
        Number(latestVerifier?.summary.projectContextReferenceCount ?? 0) &&
      report.summary.latestProjectContextDocumentSymbolCount ===
        Number(latestVerifier?.summary.projectContextDocumentSymbolCount ?? 0),
  };
}

function createEmptyDiagnosticSnapshot(): DiagnosticSnapshotSummary {
  return {
    comparable: false,
    reason: "No triggering diagnostics baseline was provided for this synthetic repair attempt.",
    total: 0,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    engine: "none",
    fallbackUsed: false,
    transportAvailable: null,
    fingerprints: [],
  };
}

function createEvalRepairConvergence(
  before: VerifierRunRecord,
  after: VerifierRunRecord,
): RepairAttemptConvergenceRecord {
  const delta = compareVerifierRunDiagnostics(before, after);
  const state = classifyEvalRepairProgress(delta, after);
  return {
    compared: delta.comparable,
    state,
    summary: renderEvalRepairProgressSummary(state, delta),
    delta,
  };
}

function classifyEvalRepairProgress(
  delta: RepairAttemptConvergenceRecord["delta"],
  verifierRun: VerifierRunRecord,
): RepairProgressState {
  if (!delta?.comparable) {
    return "not_applicable";
  }
  if (verifierRun.summary.status === "passed" && delta.afterErrorCount === 0 && delta.introducedCount === 0) {
    return "resolved";
  }
  const beforeScore = (delta.beforeErrorCount * 100) + (delta.beforeWarningCount * 10) + delta.beforeInfoCount;
  const afterScore = (delta.afterErrorCount * 100) + (delta.afterWarningCount * 10) + delta.afterInfoCount;
  if (afterScore < beforeScore || delta.resolvedCount > delta.introducedCount) {
    return "improved";
  }
  if (afterScore > beforeScore || delta.introducedCount > delta.resolvedCount) {
    return "regressed";
  }
  return "unchanged";
}

function renderEvalRepairProgressSummary(
  state: RepairProgressState,
  delta: RepairAttemptConvergenceRecord["delta"],
): string {
  if (!delta?.comparable) {
    return delta?.summary ?? "Diagnostics delta was not comparable.";
  }
  const prefix = state === "resolved"
    ? "Repair resolved the blocking diagnostics."
    : state === "improved"
      ? "Repair improved the diagnostics surface."
      : state === "regressed"
        ? "Repair regressed the diagnostics surface."
        : "Repair made no measurable diagnostics progress.";
  return `${prefix} ${delta.summary}`;
}

function summarizeEvalRepairAttempts(
  attempts: RepairLoopRecord["attempts"],
): Pick<RepairLoopRecord["summary"],
  | "latestProgress"
  | "progressTrend"
  | "resolvedAttemptCount"
  | "improvedAttemptCount"
  | "unchangedAttemptCount"
  | "regressedAttemptCount"
  | "notApplicableAttemptCount"
  | "resolvedDiagnosticCount"
  | "persistedDiagnosticCount"
  | "introducedDiagnosticCount"
  | "codeActionAppliedCount"
  | "codeActionBlockedCount"
  | "latestCodeActionStatus"
> {
  const convergences = attempts
    .map((entry) => entry.convergence)
    .filter((entry): entry is NonNullable<(typeof attempts)[number]["convergence"]> => entry != null);
  const latestProgress = convergences.at(-1)?.state ?? "none";
  const latestCodeActionStatus = attempts.at(-1)?.codeAction?.status ?? "none";
  const states = [...new Set(convergences.map((entry) => entry.state))];
  const progressTrend: RepairProgressTrend = states.length === 0
    ? "none"
    : states.length === 1
      ? states[0]
      : "mixed";

  return convergences.reduce((accumulator, convergence) => {
    if (convergence.state === "resolved") {
      accumulator.resolvedAttemptCount += 1;
    } else if (convergence.state === "improved") {
      accumulator.improvedAttemptCount += 1;
    } else if (convergence.state === "unchanged") {
      accumulator.unchangedAttemptCount += 1;
    } else if (convergence.state === "regressed") {
      accumulator.regressedAttemptCount += 1;
    } else {
      accumulator.notApplicableAttemptCount += 1;
    }
    accumulator.resolvedDiagnosticCount += convergence.delta?.resolvedCount ?? 0;
    accumulator.persistedDiagnosticCount += convergence.delta?.persistedCount ?? 0;
    accumulator.introducedDiagnosticCount += convergence.delta?.introducedCount ?? 0;
    return accumulator;
  }, {
    latestProgress,
    progressTrend,
    latestCodeActionStatus,
    resolvedAttemptCount: 0,
    improvedAttemptCount: 0,
    unchangedAttemptCount: 0,
    regressedAttemptCount: 0,
    notApplicableAttemptCount: 0,
    resolvedDiagnosticCount: 0,
    persistedDiagnosticCount: 0,
    introducedDiagnosticCount: 0,
    codeActionAppliedCount: attempts.filter((entry) => entry.codeAction?.status === "applied").length,
    codeActionBlockedCount: attempts.filter((entry) => entry.codeAction?.status === "blocked").length,
  });
}

function hasSuppressedDuplicateDiagnostics(run: VerifierRunRecord | null): boolean {
  if (!run) {
    return false;
  }
  const parseFailed = run.checks.some((check) => check.kind === "file_parse" && check.status === "failed");
  const diagnosticsSkipped = run.checks.some((check) =>
    check.kind === "diagnostics" &&
    check.status === "skipped" &&
    /duplicate noise/i.test(check.summary),
  );
  return parseFailed && diagnosticsSkipped;
}

function dedupeFailureCategories(checks: VerifierCheckResult[]): VerifierFailureCategory[] {
  return [...new Set(
    checks
      .map((check) => check.category)
      .filter((entry): entry is VerifierFailureCategory => typeof entry === "string" && entry.length > 0),
  )];
}

function isRuntimeHealthOverview(value: unknown): value is RuntimeHealthOverview {
  return typeof value === "object" &&
    value != null &&
    "scorecard" in value &&
    "updatedAt" in value &&
    "lastSessionContext" in value &&
    "provider" in value &&
    "web" in value &&
    "mcp" in value &&
    "shell" in value;
}

function normalizeEvalCaseResult(
  suiteName: string,
  entry: EvalSuiteCaseDefinition,
  result: EvalCaseInput,
  durationMs: number,
): EvalCaseResult {
  return {
    suite: suiteName,
    name: entry.name,
    pass: Boolean(result.pass),
    score: Number((result.score ?? (result.pass ? 1 : 0)).toFixed(4)),
    durationMs,
    failureReason: result.pass ? null : result.failureReason ?? "Case failed.",
    capabilityTags: entry.capabilityTags ?? [],
    metrics: result.metrics ?? null,
  };
}

function summarizeCases(cases: EvalCaseResult[]): EvalSummary {
  const total = cases.length;
  const passed = cases.filter((entry) => entry.pass).length;
  const failed = total - passed;
  const averageScore = total === 0
    ? 0
    : Number((cases.reduce((sum, entry) => sum + (entry.score ?? 0), 0) / total).toFixed(4));
  return {
    total,
    passed,
    failed,
    averageScore,
  };
}

function buildCapabilityScorecard(cases: EvalCaseResult[]): EvalScorecard {
  const scoreByTag = new Map<string, {
    tag: string;
    total: number;
    passed: number;
    totalScore: number;
  }>();
  for (const entry of cases) {
    for (const tag of entry.capabilityTags ?? []) {
      const current = scoreByTag.get(tag) ?? {
        tag,
        total: 0,
        passed: 0,
        totalScore: 0,
      };
      current.total += 1;
      current.totalScore += entry.score ?? 0;
      if (entry.pass) {
        current.passed += 1;
      }
      scoreByTag.set(tag, current);
    }
  }

  return {
    capabilities: [...scoreByTag.values()].map((entry) => ({
      tag: entry.tag,
      total: entry.total,
      passed: entry.passed,
      averageScore: Number((entry.totalScore / Math.max(1, entry.total)).toFixed(4)),
    })).sort((left, right) => left.tag.localeCompare(right.tag)),
  };
}
