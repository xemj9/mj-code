import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { VerifierReleaseStore } from "./agent-verifier-release-store.mjs";
import { VerifierGitHubMutationStore } from "./agent-verifier-github-store.mjs";
import {
  createVerifierReleaseTriageSummaryFromSelection,
} from "./agent-verifier-release-triage.mjs";

import type {
  VerifierGitHubMutationRecord,
  VerifierReleaseHandoffSelection,
} from "../types/contracts.js";

type DirectorStatus =
  | "running"
  | "stopped"
  | "needs-human"
  | "failed"
  | "max-iterations-reached";

type ReviewStatus = "continue" | "stop" | "needs-human";

interface CliArgs {
  configPath: string | null;
  goal: string | null;
  reviewerCommand: string | null;
  workerCommand: string | null;
  maxIterations: number | null;
  stateDir: string | null;
}

interface OvernightDirectorConfigInput {
  goal?: string;
  goalFile?: string;
  reviewerCommand?: string;
  workerCommand?: string;
  maxIterations?: number;
  stateDir?: string;
  projectStateDir?: string;
  verifyCommands?: string[];
  diffPaths?: string[];
  diffMaxChars?: number;
  outputMaxChars?: number;
  agentTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

export interface OvernightDirectorConfig {
  repoRoot: string;
  goal: string;
  reviewerCommand: string;
  workerCommand: string;
  maxIterations: number;
  stateDir: string;
  projectStateDir: string;
  verifyCommands: string[];
  diffPaths: string[];
  diffMaxChars: number;
  outputMaxChars: number;
  agentTimeoutMs: number;
  verifyTimeoutMs: number;
}

interface VerifyResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface GitSnapshot {
  available: boolean;
  root: string | null;
  statusShort: string;
  diffStat: string;
  diffPatch: string;
  head: string | null;
  error: string | null;
}

interface RepoSnapshot {
  capturedAt: string;
  git: GitSnapshot;
  verify: VerifyResult[];
}

interface ReviewDecision {
  status: ReviewStatus;
  summary: string;
  findings: string[];
  nextPrompt: string;
  suggestedChecks: string[];
}

interface CommandRunResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface DirectorState {
  status: DirectorStatus;
  startedAt: string;
  updatedAt: string;
  goal: string;
  repoRoot: string;
  maxIterations: number;
  reviewCount: number;
  workerCount: number;
  lastReviewPath: string | null;
  lastWorkerPath: string | null;
  lastSummary: string | null;
  pendingPromptPath: string | null;
  pendingPromptPreview: string | null;
  verifier: OvernightVerifierSummary;
}

interface OvernightVerifierSummary {
  available: boolean;
  reason: string | null;
  handoffId: string | null;
  sourceKind: string | null;
  policyProfileId: string | null;
  pass: boolean | null;
  status: string | null;
  latestGateArtifactId: string | null;
  latestEvalArtifactId: string | null;
  latestBundleId: string | null;
  baselineName: string | null;
  targetReferenceLabel: string | null;
  snapshotIds: string[];
  promotionStatus: string | null;
  promotionSummary: string | null;
  primaryArtifactId: string | null;
  artifactIds: string[];
  uploadArtifactId: string | null;
  uploadArtifactUrl: string | null;
  uploadArtifactDigest: string | null;
  githubMutationId: string | null;
  githubMutationStatus: string | null;
  githubMutationReason: string | null;
  githubCheckRunId: number | null;
  topReasons: string[];
  summary: string | null;
}

interface PromptContext {
  reviewRound: number;
  workerIteration: number;
  goal: string;
  snapshot: RepoSnapshot;
  previousReview: ReviewDecision | null;
  previousWorker: CommandRunResult | null;
}

interface RunDirectories {
  base: string;
  prompts: string;
  reviews: string;
  workers: string;
  verify: string;
}

const DEFAULT_VERIFY_COMMANDS = ["npm run typecheck", "npm run build", "npm test"];
const DEFAULT_DIFF_PATHS = [
  "src",
  "test",
  "README.md",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "tsconfig.typecheck.json",
  "MJ.md",
];

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cliArgs = parseCliArgs(argv);
  const config = await loadDirectorConfig(process.cwd(), cliArgs);
  const result = await runOvernightDirector(config);
  const latestSummary = await fs.readFile(path.join(config.stateDir, "latest-summary.md"), "utf8");
  process.stdout.write(`${latestSummary}\n`);
  if (result.status === "failed" || result.status === "needs-human") {
    process.exitCode = 1;
  }
}

export async function loadDirectorConfig(
  cwd: string,
  args: Partial<CliArgs> = {},
): Promise<OvernightDirectorConfig> {
  let fileConfig: OvernightDirectorConfigInput = {};
  if (args.configPath) {
    const configPath = path.resolve(cwd, args.configPath);
    const raw = await fs.readFile(configPath, "utf8");
    fileConfig = JSON.parse(raw);
  }

  const goal = await resolveGoal(cwd, {
    goal: args.goal ?? fileConfig.goal,
    goalFile: fileConfig.goalFile,
  });
  const reviewerCommand = args.reviewerCommand ?? fileConfig.reviewerCommand ?? "";
  const workerCommand = args.workerCommand ?? fileConfig.workerCommand ?? "";
  const maxIterations = normalizeInteger(args.maxIterations ?? fileConfig.maxIterations, 6);
  const stateDir = path.resolve(cwd, args.stateDir ?? fileConfig.stateDir ?? path.join(".mj-code", "overnight"));
  const projectStateDir = path.resolve(cwd, fileConfig.projectStateDir ?? ".mj-code");

  if (!goal) {
    throw new Error("Overnight director requires a goal or goalFile.");
  }
  if (!reviewerCommand.trim()) {
    throw new Error("Overnight director requires reviewerCommand.");
  }
  if (!workerCommand.trim()) {
    throw new Error("Overnight director requires workerCommand.");
  }

  return {
    repoRoot: cwd,
    goal,
    reviewerCommand,
    workerCommand,
    maxIterations,
    stateDir,
    projectStateDir,
    verifyCommands: Array.isArray(fileConfig.verifyCommands) && fileConfig.verifyCommands.length > 0
      ? fileConfig.verifyCommands
      : DEFAULT_VERIFY_COMMANDS,
    diffPaths: Array.isArray(fileConfig.diffPaths) && fileConfig.diffPaths.length > 0
      ? fileConfig.diffPaths
      : DEFAULT_DIFF_PATHS,
    diffMaxChars: normalizeInteger(fileConfig.diffMaxChars, 14000),
    outputMaxChars: normalizeInteger(fileConfig.outputMaxChars, 14000),
    agentTimeoutMs: normalizeInteger(fileConfig.agentTimeoutMs, 45 * 60 * 1000),
    verifyTimeoutMs: normalizeInteger(fileConfig.verifyTimeoutMs, 20 * 60 * 1000),
  };
}

export function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    configPath: null,
    goal: null,
    reviewerCommand: null,
    workerCommand: null,
    maxIterations: null,
    stateDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1] ?? null;
    if (value === "--config" && next) {
      parsed.configPath = next;
      index += 1;
      continue;
    }
    if (value === "--goal" && next) {
      parsed.goal = next;
      index += 1;
      continue;
    }
    if (value === "--reviewer-cmd" && next) {
      parsed.reviewerCommand = next;
      index += 1;
      continue;
    }
    if (value === "--worker-cmd" && next) {
      parsed.workerCommand = next;
      index += 1;
      continue;
    }
    if (value === "--max-iterations" && next) {
      parsed.maxIterations = normalizeInteger(next, 6);
      index += 1;
      continue;
    }
    if (value === "--state-dir" && next) {
      parsed.stateDir = next;
      index += 1;
    }
  }

  return parsed;
}

export async function runOvernightDirector(config: OvernightDirectorConfig): Promise<DirectorState> {
  const directories = await ensureRunDirectories(config.stateDir);
  const state: DirectorState = {
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goal: config.goal,
    repoRoot: config.repoRoot,
    maxIterations: config.maxIterations,
    reviewCount: 0,
    workerCount: 0,
    lastReviewPath: null,
    lastWorkerPath: null,
    lastSummary: null,
    pendingPromptPath: null,
    pendingPromptPreview: null,
    verifier: createEmptyOvernightVerifierSummary("No verifier release handoff is available."),
  };

  await writeState(config.stateDir, state);

  let previousReview: ReviewDecision | null = null;
  let previousWorker: CommandRunResult | null = null;
  let pendingPrompt = "";

  const initialSnapshot = await captureRepoSnapshot(config);
  const initialReview = await runReviewerRound({
    config,
    directories,
    reviewRound: 0,
    workerIteration: 0,
    snapshot: initialSnapshot,
    previousReview,
    previousWorker,
  });
  previousReview = initialReview.decision;
  state.reviewCount = 1;
  state.lastReviewPath = initialReview.reviewPath;
  state.pendingPromptPath = initialReview.promptPath;
  state.pendingPromptPreview = summarizeText(previousReview.nextPrompt, 200);
  state.lastSummary = previousReview.summary;
  state.updatedAt = new Date().toISOString();

  if (previousReview.status !== "continue" || !previousReview.nextPrompt.trim()) {
    state.status = previousReview.status === "needs-human" ? "needs-human" : "stopped";
    await writeLatestSummary(config, state, previousReview, previousWorker);
    await writeState(config.stateDir, state);
    return state;
  }

  pendingPrompt = previousReview.nextPrompt;

  while (state.workerCount < config.maxIterations) {
    const nextWorkerIteration = state.workerCount + 1;
    const workerRun = await runWorkerRound({
      config,
      directories,
      workerIteration: nextWorkerIteration,
      prompt: pendingPrompt,
      previousReview,
    });

    previousWorker = workerRun.result;
    state.workerCount = nextWorkerIteration;
    state.lastWorkerPath = workerRun.workerPath;
    state.updatedAt = new Date().toISOString();
    await writeState(config.stateDir, state);

    const snapshot = await captureRepoSnapshot(config);
    const reviewRound = state.reviewCount;
    const followUpReview = await runReviewerRound({
      config,
      directories,
      reviewRound,
      workerIteration: state.workerCount,
      snapshot,
      previousReview,
      previousWorker,
    });

    previousReview = followUpReview.decision;
    state.reviewCount += 1;
    state.lastReviewPath = followUpReview.reviewPath;
    state.pendingPromptPath = followUpReview.promptPath;
    state.pendingPromptPreview = summarizeText(previousReview.nextPrompt, 200);
    state.lastSummary = previousReview.summary;
    state.updatedAt = new Date().toISOString();

    if (previousReview.status !== "continue" || !previousReview.nextPrompt.trim()) {
      state.status = previousReview.status === "needs-human" ? "needs-human" : "stopped";
      await writeLatestSummary(config, state, previousReview, previousWorker);
      await writeState(config.stateDir, state);
      return state;
    }

    pendingPrompt = previousReview.nextPrompt;
  }

  state.status = "max-iterations-reached";
  state.updatedAt = new Date().toISOString();
  await writeLatestSummary(config, state, previousReview, previousWorker);
  await writeState(config.stateDir, state);
  return state;
}

async function runReviewerRound({
  config,
  directories,
  reviewRound,
  workerIteration,
  snapshot,
  previousReview,
  previousWorker,
}: {
  config: OvernightDirectorConfig;
  directories: RunDirectories;
  reviewRound: number;
  workerIteration: number;
  snapshot: RepoSnapshot;
  previousReview: ReviewDecision | null;
  previousWorker: CommandRunResult | null;
}): Promise<{ decision: ReviewDecision; promptPath: string; reviewPath: string }> {
  const prompt = buildReviewerPrompt({
    reviewRound,
    workerIteration,
    goal: config.goal,
    snapshot,
    previousReview,
    previousWorker,
  });
  const promptPath = path.join(directories.prompts, `review-${formatIteration(reviewRound)}.md`);
  await fs.writeFile(promptPath, prompt, "utf8");

  const outputPath = path.join(directories.reviews, `review-${formatIteration(reviewRound)}.json`);
  const result = await runAgentCommand({
    command: config.reviewerCommand,
    role: "reviewer",
    prompt,
    promptPath,
    outputPath,
    repoRoot: config.repoRoot,
    stateDir: config.stateDir,
    reviewRound,
    workerIteration,
    outputMaxChars: config.outputMaxChars,
    timeoutMs: config.agentTimeoutMs,
  });
  const decision = parseReviewDecision(result.stdout);

  await fs.writeFile(outputPath, JSON.stringify({
    reviewRound,
    workerIteration,
    command: result.command,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    decision,
  }, null, 2), "utf8");

  return {
    decision,
    promptPath,
    reviewPath: outputPath,
  };
}

async function runWorkerRound({
  config,
  directories,
  workerIteration,
  prompt,
  previousReview,
}: {
  config: OvernightDirectorConfig;
  directories: RunDirectories;
  workerIteration: number;
  prompt: string;
  previousReview: ReviewDecision | null;
}): Promise<{ result: CommandRunResult; workerPath: string }> {
  const workerPrompt = buildWorkerPrompt({
    goal: config.goal,
    workerIteration,
    review: previousReview,
  }, prompt);
  const promptPath = path.join(directories.prompts, `worker-${formatIteration(workerIteration)}.md`);
  await fs.writeFile(promptPath, workerPrompt, "utf8");

  const outputPath = path.join(directories.workers, `worker-${formatIteration(workerIteration)}.json`);
  const result = await runAgentCommand({
    command: config.workerCommand,
    role: "worker",
    prompt: workerPrompt,
    promptPath,
    outputPath,
    repoRoot: config.repoRoot,
    stateDir: config.stateDir,
    reviewRound: workerIteration,
    workerIteration,
    outputMaxChars: config.outputMaxChars,
    timeoutMs: config.agentTimeoutMs,
  });

  await fs.writeFile(outputPath, JSON.stringify({
    workerIteration,
    command: result.command,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  }, null, 2), "utf8");

  return {
    result,
    workerPath: outputPath,
  };
}

async function captureRepoSnapshot(config: OvernightDirectorConfig): Promise<RepoSnapshot> {
  const verify = await runVerifyCommands(
    config.repoRoot,
    config.verifyCommands,
    config.outputMaxChars,
    config.verifyTimeoutMs,
  );
  const git = await captureGitSnapshot(config.repoRoot, config.diffPaths, config.diffMaxChars);
  return {
    capturedAt: new Date().toISOString(),
    git,
    verify,
  };
}

async function runVerifyCommands(
  cwd: string,
  commands: string[],
  outputMaxChars: number,
  timeoutMs: number,
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const command of commands) {
    const result = await runShellCommand({
      command,
      cwd,
      env: process.env,
      stdinText: "",
      outputMaxChars,
      timeoutMs,
    });
    results.push(result);
  }
  return results;
}

async function captureGitSnapshot(
  cwd: string,
  diffPaths: string[],
  diffMaxChars: number,
): Promise<GitSnapshot> {
  const topLevel = await runProcess("git", ["-C", cwd, "rev-parse", "--show-toplevel"], cwd);
  if (!topLevel.ok) {
    return {
      available: false,
      root: null,
      statusShort: "",
      diffStat: "",
      diffPatch: "",
      head: null,
      error: trimCombinedOutput(topLevel.stdout, topLevel.stderr, 400),
    };
  }

  const gitRoot = topLevel.stdout.trim();
  const head = await runProcess("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], cwd);
  const status = await runProcess("git", ["-C", cwd, "status", "--short", "--", ...diffPaths], cwd);
  const diffStat = await runProcess("git", ["-C", cwd, "diff", "--stat", "--", ...diffPaths], cwd);
  const diffPatch = await runProcess("git", ["-C", cwd, "diff", "--unified=1", "--", ...diffPaths], cwd);

  return {
    available: true,
    root: gitRoot,
    statusShort: summarizeText(status.stdout, diffMaxChars),
    diffStat: summarizeText(diffStat.stdout, diffMaxChars),
    diffPatch: summarizeText(diffPatch.stdout, diffMaxChars),
    head: head.ok ? head.stdout.trim() : null,
    error: null,
  };
}

interface RunAgentCommandInput {
  command: string;
  role: "reviewer" | "worker";
  prompt: string;
  promptPath: string;
  outputPath: string;
  repoRoot: string;
  stateDir: string;
  reviewRound: number;
  workerIteration: number;
  outputMaxChars: number;
  timeoutMs: number;
}

async function runAgentCommand(input: RunAgentCommandInput): Promise<CommandRunResult> {
  const command = fillCommandTemplate(input.command, {
    prompt_file: input.promptPath,
    output_file: input.outputPath,
    repo_root: input.repoRoot,
    state_dir: input.stateDir,
    review_round: `${input.reviewRound}`,
    worker_iteration: `${input.workerIteration}`,
    role: input.role,
  });

  return runShellCommand({
    command,
    cwd: input.repoRoot,
    env: {
      ...process.env,
      MJ_OVERNIGHT_ROLE: input.role,
      MJ_OVERNIGHT_PROMPT_FILE: input.promptPath,
      MJ_OVERNIGHT_OUTPUT_FILE: input.outputPath,
      MJ_OVERNIGHT_REPO_ROOT: input.repoRoot,
      MJ_OVERNIGHT_STATE_DIR: input.stateDir,
      MJ_OVERNIGHT_REVIEW_ROUND: `${input.reviewRound}`,
      MJ_OVERNIGHT_WORKER_ITERATION: `${input.workerIteration}`,
    },
    stdinText: input.prompt,
    outputMaxChars: input.outputMaxChars,
    timeoutMs: input.timeoutMs,
  });
}

interface ShellCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinText: string;
  outputMaxChars: number;
  timeoutMs: number;
}

async function runShellCommand(options: ShellCommandOptions): Promise<CommandRunResult> {
  const startedAt = Date.now();
  const child = spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  if (options.stdinText) {
    child.stdin.write(options.stdinText);
  }
  child.stdin.end();

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {}
    const hardKill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 2000);
    hardKill.unref();
  }, options.timeoutMs);
  timer.unref();

  const settled = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
  clearTimeout(timer);

  return {
    command: options.command,
    ok: settled.exitCode === 0 && !timedOut,
    exitCode: settled.exitCode,
    signal: settled.signal,
    stdout: summarizeText(stdout, options.outputMaxChars),
    stderr: summarizeText(stderr, options.outputMaxChars),
    durationMs: Date.now() - startedAt,
    timedOut,
  };
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandRunResult> {
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const settled = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });

  return {
    command: [command, ...args].join(" "),
    ok: settled.exitCode === 0,
    exitCode: settled.exitCode,
    signal: settled.signal,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    timedOut: false,
  };
}

export function parseReviewDecision(rawOutput: string): ReviewDecision {
  const parsed = JSON.parse(extractJsonObject(rawOutput));
  const status = normalizeReviewStatus(parsed?.status);
  const findings = Array.isArray(parsed?.findings)
    ? parsed.findings.map((entry: unknown) => `${entry ?? ""}`.trim()).filter(Boolean)
    : [];
  const suggestedChecks = Array.isArray(parsed?.suggested_checks)
    ? parsed.suggested_checks.map((entry: unknown) => `${entry ?? ""}`.trim()).filter(Boolean)
    : [];
  const nextPrompt = `${parsed?.next_prompt ?? ""}`.trim();
  const summary = `${parsed?.summary ?? ""}`.trim();

  if (!summary) {
    throw new Error("Reviewer response is missing a summary.");
  }

  return {
    status,
    summary,
    findings,
    nextPrompt,
    suggestedChecks,
  };
}

export function buildReviewerPrompt(context: PromptContext): string {
  const verifyBlock = context.snapshot.verify.length > 0
    ? context.snapshot.verify.map((entry) => [
        `- command: ${entry.command}`,
        `  ok: ${entry.ok}`,
        `  exitCode: ${entry.exitCode ?? "null"}`,
        `  timedOut: ${entry.timedOut}`,
        `  durationMs: ${entry.durationMs}`,
        `  stdout: ${indentBlock(entry.stdout || "(empty)", 4)}`,
        `  stderr: ${indentBlock(entry.stderr || "(empty)", 4)}`,
      ].join("\n")).join("\n")
    : "- no verification commands configured";

  const gitBlock = context.snapshot.git.available
    ? [
        `HEAD: ${context.snapshot.git.head ?? "unknown"}`,
        `status:`,
        indentBlock(context.snapshot.git.statusShort || "(clean or unavailable)", 2),
        `diff stat:`,
        indentBlock(context.snapshot.git.diffStat || "(empty)", 2),
        `focused diff:`,
        indentBlock(context.snapshot.git.diffPatch || "(empty)", 2),
      ].join("\n")
    : `git snapshot unavailable: ${context.snapshot.git.error ?? "unknown error"}`;

  const previousReview = context.previousReview
    ? [
        `Previous review summary: ${context.previousReview.summary}`,
        `Previous findings: ${context.previousReview.findings.length > 0 ? context.previousReview.findings.join(" | ") : "(none)"}`,
      ].join("\n")
    : "Previous review summary: (none)";

  const previousWorker = context.previousWorker
    ? [
        `Last worker command: ${context.previousWorker.command}`,
        `Last worker ok: ${context.previousWorker.ok}`,
        `Last worker exitCode: ${context.previousWorker.exitCode ?? "null"}`,
        `Last worker timedOut: ${context.previousWorker.timedOut}`,
        `Last worker stdout:`,
        indentBlock(context.previousWorker.stdout || "(empty)", 2),
        `Last worker stderr:`,
        indentBlock(context.previousWorker.stderr || "(empty)", 2),
      ].join("\n")
    : "No worker run yet. Seed the first implementation step.";

  return [
    "You are the overnight reviewer/director agent for MJ Code.",
    "Your job is to review the latest repo state, assess the worker's last step, and decide the exact next prompt for the worker agent.",
    "Keep momentum toward the mission, but prefer stable, reviewable progress over broad speculative changes.",
    "",
    `Mission: ${context.goal}`,
    `Review Round: ${context.reviewRound}`,
    `Worker Iteration Completed: ${context.workerIteration}`,
    `Snapshot Captured At: ${context.snapshot.capturedAt}`,
    "",
    previousReview,
    "",
    previousWorker,
    "",
    "Verification:",
    verifyBlock,
    "",
    "Repo Snapshot:",
    gitBlock,
    "",
    "Output requirements:",
    "- Return STRICT JSON only. No markdown wrapper.",
    '- Use this exact shape: {"status":"continue|stop|needs-human","summary":"...","findings":["..."],"next_prompt":"...","suggested_checks":["..."]}',
    "- status=continue only if you have a concrete next prompt for the worker.",
    "- status=stop if the goal is sufficiently complete for this overnight loop.",
    "- status=needs-human if you hit ambiguity, risk, or missing credentials that should not be guessed.",
    "- next_prompt should be directly executable by a coding agent working inside this repo.",
  ].join("\n");
}

export function buildWorkerPrompt(
  context: {
    goal: string;
    workerIteration: number;
    review: ReviewDecision | null;
  },
  directive: string,
): string {
  return [
    "You are the implementation agent for MJ Code.",
    "Work inside the current repo only. Make concrete progress on the task below, run the checks you judge necessary, and report back concisely.",
    "Do not ask for confirmation unless you hit a real blocker.",
    "",
    `Mission: ${context.goal}`,
    `Worker Iteration: ${context.workerIteration}`,
    context.review
      ? `Reviewer summary: ${context.review.summary}`
      : "Reviewer summary: (initial pass)",
    context.review && context.review.findings.length > 0
      ? `Reviewer findings: ${context.review.findings.join(" | ")}`
      : "Reviewer findings: (none)",
    context.review && context.review.suggestedChecks.length > 0
      ? `Suggested checks: ${context.review.suggestedChecks.join(" | ")}`
      : "Suggested checks: (none)",
    "",
    "Task:",
    directive.trim(),
    "",
    "Return a concise implementation report with:",
    "- files changed",
    "- checks run",
    "- remaining risks or blockers",
  ].join("\n");
}

export function fillCommandTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (_match, key: string) => values[key] ?? "");
}

function extractJsonObject(rawOutput: string): string {
  const fenced = rawOutput.match(/```json\s*([\s\S]*?)```/i) ?? rawOutput.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = rawOutput.indexOf("{");
  const lastBrace = rawOutput.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Reviewer response did not contain a JSON object.");
  }
  return rawOutput.slice(firstBrace, lastBrace + 1).trim();
}

function normalizeReviewStatus(value: unknown): ReviewStatus {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (normalized === "continue" || normalized === "stop" || normalized === "needs-human") {
    return normalized;
  }
  throw new Error(`Unsupported reviewer status: ${normalized || "(empty)"}`);
}

async function ensureRunDirectories(baseDir: string): Promise<RunDirectories> {
  const directories: RunDirectories = {
    base: baseDir,
    prompts: path.join(baseDir, "prompts"),
    reviews: path.join(baseDir, "reviews"),
    workers: path.join(baseDir, "workers"),
    verify: path.join(baseDir, "verify"),
  };
  for (const directory of Object.values(directories)) {
    await fs.mkdir(directory, { recursive: true });
  }
  return directories;
}

async function writeState(stateDir: string, state: DirectorState): Promise<void> {
  await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

async function writeLatestSummary(
  config: OvernightDirectorConfig,
  state: DirectorState,
  review: ReviewDecision | null,
  worker: CommandRunResult | null,
): Promise<void> {
  const verifier = await loadOvernightVerifierSummary(config.projectStateDir);
  state.verifier = verifier;
  await fs.writeFile(
    path.join(config.stateDir, "verifier-handoff.json"),
    `${JSON.stringify(verifier, null, 2)}\n`,
    "utf8",
  );
  const summary = [
    `Overnight director status: ${state.status}`,
    `Goal: ${config.goal}`,
    `Repo: ${config.repoRoot}`,
    `Review rounds: ${state.reviewCount}`,
    `Worker iterations: ${state.workerCount}/${state.maxIterations}`,
    review ? `Latest review summary: ${review.summary}` : "Latest review summary: (none)",
    review && review.findings.length > 0
      ? `Latest findings: ${review.findings.join(" | ")}`
      : "Latest findings: (none)",
    review && review.suggestedChecks.length > 0
      ? `Suggested checks: ${review.suggestedChecks.join(" | ")}`
      : "Suggested checks: (none)",
    state.pendingPromptPreview
      ? `Pending prompt preview: ${state.pendingPromptPreview}`
      : "Pending prompt preview: (none)",
    worker
      ? `Latest worker result: ok=${worker.ok} exitCode=${worker.exitCode ?? "null"}`
      : "Latest worker result: (none)",
    worker ? `Latest worker timedOut: ${worker.timedOut}` : "Latest worker timedOut: (none)",
    worker?.stdout ? `Latest worker stdout: ${worker.stdout}` : "Latest worker stdout: (empty)",
    state.lastReviewPath ? `Latest review file: ${state.lastReviewPath}` : "Latest review file: (none)",
    state.lastWorkerPath ? `Latest worker file: ${state.lastWorkerPath}` : "Latest worker file: (none)",
    "",
    "Verifier release handoff:",
    verifier.available
      ? `  handoff=${verifier.handoffId} source=${verifier.sourceKind} status=${verifier.status} pass=${verifier.pass == null ? "n/a" : verifier.pass ? "yes" : "no"}`
      : `  unavailable: ${verifier.reason ?? "No verifier release handoff is available."}`,
    `  latest gate artifact: ${verifier.latestGateArtifactId ?? "none"}`,
    `  latest eval artifact: ${verifier.latestEvalArtifactId ?? "none"}`,
    `  latest bundle: ${verifier.latestBundleId ?? "none"}`,
    `  policy profile: ${verifier.policyProfileId ?? "none"}`,
    `  baseline: ${verifier.baselineName ?? "none"}`,
    `  target: ${verifier.targetReferenceLabel ?? "none"}`,
    `  promotion: ${verifier.promotionStatus ?? "none"}${verifier.promotionSummary ? `; ${verifier.promotionSummary}` : ""}`,
    `  primary artifact: ${verifier.primaryArtifactId ?? "none"}`,
    `  artifact ids: ${verifier.artifactIds.join(", ") || "none"}`,
    `  upload artifact: ${verifier.uploadArtifactId ?? "none"}`,
    `  upload url: ${verifier.uploadArtifactUrl ?? "none"}`,
    `  upload digest: ${verifier.uploadArtifactDigest ?? "none"}`,
    `  github mutation: ${verifier.githubMutationStatus ?? "none"}${verifier.githubMutationReason ? `; ${verifier.githubMutationReason}` : ""}`,
    `  github mutation id: ${verifier.githubMutationId ?? "none"}`,
    `  github check run: ${verifier.githubCheckRunId ?? "none"}`,
    `  snapshots: ${verifier.snapshotIds.join(", ") || "none"}`,
    `  summary: ${verifier.summary ?? "none"}`,
    `  top reasons: ${verifier.topReasons.join(" | ") || "(none)"}`,
  ].join("\n");

  await fs.writeFile(path.join(config.stateDir, "latest-summary.md"), summary, "utf8");
}

async function resolveGoal(
  cwd: string,
  input: { goal?: string; goalFile?: string },
): Promise<string> {
  if (input.goal && input.goal.trim()) {
    return input.goal.trim();
  }
  if (input.goalFile) {
    const filePath = path.resolve(cwd, input.goalFile);
    return (await fs.readFile(filePath, "utf8")).trim();
  }
  return "";
}

function formatIteration(iteration: number): string {
  return `${iteration}`.padStart(3, "0");
}

function normalizeInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(`${value ?? ""}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadOvernightVerifierSummary(
  projectStateDir: string,
): Promise<OvernightVerifierSummary> {
  const store = new VerifierReleaseStore(projectStateDir);
  const mutationStore = new VerifierGitHubMutationStore(projectStateDir);
  const latest = await store.loadHandoff("latest");
  const preferred = await selectPreferredOvernightHandoff(store, latest);
  const githubMutation = preferred.handoff
    ? await mutationStore.findLatestByHandoffId(preferred.handoff.metadata.handoffId)
    : null;
  return summarizeOvernightVerifierSelection(preferred, githubMutation);
}

async function selectPreferredOvernightHandoff(
  store: VerifierReleaseStore,
  latest: VerifierReleaseHandoffSelection,
): Promise<VerifierReleaseHandoffSelection> {
  const preferredReference = latest.latestEvalArtifactId
    ?? latest.latestGateArtifactId
    ?? latest.latestArtifactId;
  if (!preferredReference) {
    return latest;
  }
  return store.loadHandoff(preferredReference);
}

function summarizeOvernightVerifierSelection(
  selection: VerifierReleaseHandoffSelection,
  githubMutation: VerifierGitHubMutationRecord | null,
): OvernightVerifierSummary {
  const handoff = selection.handoff;
  if (!handoff) {
    return createEmptyOvernightVerifierSummary(
      selection.reason ?? "No verifier release handoff is available.",
      selection,
    );
  }
  const triage = createVerifierReleaseTriageSummaryFromSelection(selection, {
    githubMutation,
  });
  return {
    available: true,
    reason: null,
    handoffId: handoff.metadata.handoffId,
    sourceKind: handoff.metadata.sourceKind,
    policyProfileId: handoff.metadata.policyProfileId,
    pass: handoff.metadata.pass,
    status: handoff.metadata.status,
    latestGateArtifactId: selection.latestGateArtifactId,
    latestEvalArtifactId: selection.latestEvalArtifactId,
    latestBundleId: handoff.metadata.bundleId,
    baselineName: handoff.baselineName ?? handoff.metadata.baselineNames[0] ?? null,
    targetReferenceLabel: triage.targetReferenceLabel,
    snapshotIds: structuredClone(handoff.metadata.snapshotIds),
    promotionStatus: triage.promotionStatus,
    promotionSummary: triage.promotionSummary,
    primaryArtifactId: handoff.metadata.primaryArtifactId,
    artifactIds: structuredClone(handoff.metadata.artifactIds),
    uploadArtifactId: handoff.metadata.upload?.artifactId ?? null,
    uploadArtifactUrl: handoff.metadata.upload?.artifactUrl ?? null,
    uploadArtifactDigest: handoff.metadata.upload?.artifactDigest ?? null,
    githubMutationId: triage.githubMutation?.mutationId ?? null,
    githubMutationStatus: triage.githubMutation?.status ?? null,
    githubMutationReason: triage.githubMutation?.reason ?? null,
    githubCheckRunId: triage.githubMutation?.response?.checkRunId ?? null,
    topReasons: handoff.topReasons.slice(0, 3).map((entry) => entry.summary),
    summary: handoff.summary,
  };
}

function createEmptyOvernightVerifierSummary(
  reason: string,
  selection: Pick<VerifierReleaseHandoffSelection, "latestGateArtifactId" | "latestEvalArtifactId"> | null = null,
): OvernightVerifierSummary {
  return {
    available: false,
    reason,
    handoffId: null,
    sourceKind: null,
    policyProfileId: null,
    pass: null,
    status: null,
    latestGateArtifactId: selection?.latestGateArtifactId ?? null,
    latestEvalArtifactId: selection?.latestEvalArtifactId ?? null,
    latestBundleId: null,
    baselineName: null,
    targetReferenceLabel: null,
    snapshotIds: [],
    promotionStatus: null,
    promotionSummary: null,
    primaryArtifactId: null,
    artifactIds: [],
    uploadArtifactId: null,
    uploadArtifactUrl: null,
    uploadArtifactDigest: null,
    githubMutationId: null,
    githubMutationStatus: null,
    githubMutationReason: null,
    githubCheckRunId: null,
    topReasons: [],
    summary: null,
  };
}

function summarizeText(text: string, maxChars = 200): string {
  const normalized = `${text ?? ""}`.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function trimCombinedOutput(stdout: string, stderr: string, maxChars: number): string {
  return summarizeText([stdout, stderr].filter(Boolean).join("\n"), maxChars);
}

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return `${text ?? ""}`.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
