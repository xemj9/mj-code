#!/usr/bin/env node

import process from "node:process";

import { MJCodeAgent } from "./agent.mjs";
import { loadConfig, redactConfig } from "./config.mjs";
import {
  parseDecisionActionArgs,
  parseWhyCommandArgs,
} from "./lib/agent-decision-cli.mjs";
import {
  parseInteractionAboutArgs,
  parseInteractionContinueArgs,
  parseInteractionHistoryArgs,
  parseInteractionResumeArgs,
  parseInteractionStatusArgs,
} from "./lib/agent-interaction-cli.mjs";
import {
  parseInteractiveSessionPickerLine,
} from "./lib/interactive-shell-commands.mjs";
import {
  renderAgentDecisionReport,
} from "./lib/agent-decision-inspect.mjs";
import {
  buildAgentInteractionStatusReport,
  renderAgentAbout,
  renderAgentInteractionStatusReport,
  renderInteractiveCommandPalette,
} from "./lib/agent-interaction-render.mjs";
import {
  buildInteractiveSessionPickerReport,
  renderContinueInspectReport,
  renderSessionBrowserReport,
  renderSessionResumeRecommendationReport,
} from "./lib/agent-session-browser.mjs";
import {
  getInteractiveCommandPalette,
} from "./lib/command-catalog.mjs";
import {
  parsePlanCommandArgs,
} from "./lib/agent-plan-cli.mjs";
import {
  renderPlanCurrentReport as renderPlanCurrentInspectReport,
  renderPlanTimelineReport as renderPlanTimelineInspectReport,
} from "./lib/agent-plan-inspect.mjs";
import {
  renderVerifierBaselinePromotionHistory,
  renderVerifierBaselinePromotionPlan,
  renderVerifierDrilldownReport,
  renderVerifierGitHubChecksPayload,
  renderVerifierGitHubMutationResult,
  renderVerifierInspectArtifactList,
  renderVerifierInspectArtifactPruneResult,
  renderVerifierInspectArtifactRecord,
  renderVerifierInspectBaselineList,
  renderVerifierInspectBaselineRecord,
  renderVerifierInspectCompareReport,
  renderVerifierInspectReport,
  renderVerifierReleaseBundle,
  renderVerifierReleaseHandoff,
  renderVerifierRegressionGatePolicyProfiles,
  renderVerifierRegressionGateDecision,
  renderVerifierInspectSnapshotList,
  renderVerifierInspectSnapshotRecord,
  renderVerifierTimelineReport,
  renderVerifierReleaseTriageSummary,
} from "./lib/agent-verifier-inspect-render.mjs";
import {
  parseVerifierInspectCommandArgs,
  parseVerifierInspectReferenceToken,
} from "./lib/agent-verifier-inspect-cli.mjs";
import {
  createVerifierGitHubActionsBackfillInputFromEnv,
} from "./lib/agent-verifier-release-triage.mjs";
import { formatCommandHelp, normalizeSection } from "./lib/command-catalog.mjs";
import {
  loadProjectInstructions,
  summarizeInstructionPack,
} from "./lib/project-instructions.mjs";
import { createEnhancedTerminalUi, getEffortLevel, setEffortLevel, isValidEffortLevel } from "./lib/enhanced-ui.mjs";
import type { EffortLevel } from "./lib/enhanced-ui.mjs";
import { INTERACTIVE_SHELL_PROMPT } from "./lib/ui.mjs";

import type {
  CommandSection,
  EvalRunRequest,
  InteractiveSessionPickerReport,
  ResolvedConfig,
  VerifierInspectReference,
} from "./types/contracts.js";
import type {
  AgentTerminalUi,
  AgentTailOptions,
} from "./types/agent-facade.js";

type OptionValue = string | boolean;
type OptionMap = Record<string, OptionValue>;
type JsonMap = Record<string, unknown>;
type CliAgent = MJCodeAgent;
type TailOptions = AgentTailOptions;

interface ParsedArgs {
  help: boolean;
  options: OptionMap;
  positionals: string[];
}

const CORELESS_COMMANDS = [
  "about",
  "config",
  "instructions",
  "memory",
  "sessions",
  "status",
  "replay",
  "history",
  "sources",
  "network-mode",
  "search",
  "fetch",
  "extract",
  "mcp",
  "runtime",
  "jobs",
  "tail",
  "attach",
  "cancel",
  "shell-history",
  "skills",
  "plugins",
  "capabilities",
  "tools",
  "route",
  "plan",
  "why",
  "next",
  "recover",
  "verifier",
  "eval",
  "model",
  "provider",
];

const LOCAL_INSPECTION_COMMANDS = new Set<string>([
  "about",
  "memory",
  "sessions",
  "status",
  "replay",
  "history",
  "jobs",
  "tail",
  "attach",
  "cancel",
  "shell-history",
  "sources",
  "network-mode",
  "mcp",
  "runtime",
  "skills",
  "plugins",
  "capabilities",
  "tools",
  "route",
  "plan",
  "why",
  "next",
  "recover",
  "verifier",
  "eval",
  "model",
  "provider",
]);

const VERIFIER_CLI_USAGE = 'node src/cli.mjs verifier [trace|replay "<session-id>"|export [current|trace|replay "<session-id>"]|exports|baseline pin <current|trace|replay:<id>|snapshot:<id>> <name>|baselines|promotion [plan <baseline-name> [latest|<artifact-id>]|approve <plan-id>|history <baseline-name>]|policies|compare <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> <current|trace|replay:<id>|snapshot:<id>|baseline:<name>>|gate <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> <current|trace|replay:<id>|snapshot:<id>|baseline:<name>>|artifacts [prune]|artifact <id>|handoff [<artifact-id|latest>|export <artifact-id|latest>]|checks [summary|export [<reference>]]|triage summary [<reference>]|drilldown [<reference>|latest]|timeline [<reference>|latest]|github [apply [<reference>]|result [<mutation-id>|latest]]] [json|summary|failures|repair|context] [--format <profile>] [--limit <n>] [--policy <profile>] [--write-artifact] [--write-bundle] [--dry-run] [--max-count <n>] [--max-age-days <n>] [--github-actions] [--approver-id <id>] [--approver-name <name>] [--approval-source <source>] [--approval-mode <mode>]';
const VERIFIER_REPL_USAGE = "/verifier [trace|replay <session-id>|export [current|trace|replay <session-id>]|exports|baseline pin <current|trace|replay:<id>|snapshot:<id>> <name>|baselines|promotion [plan <baseline-name> [latest|<artifact-id>]|approve <plan-id>|history <baseline-name>]|policies|compare <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> <current|trace|replay:<id>|snapshot:<id>|baseline:<name>>|gate <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> <current|trace|replay:<id>|snapshot:<id>|baseline:<name>>|artifacts [prune]|artifact <id>|handoff [<artifact-id|latest>|export <artifact-id|latest>]|checks [summary|export [<reference>]]|triage summary [<reference>]|drilldown [<reference>|latest]|timeline [<reference>|latest]|github [apply [<reference>]|result [<mutation-id>|latest]]] [json|summary|failures|repair|context] [--format <profile>] [--limit <n>] [--policy <profile>] [--write-artifact] [--write-bundle] [--dry-run] [--max-count <n>] [--max-age-days <n>] [--github-actions] [--approver-id <id>] [--approver-name <name>] [--approval-source <source>] [--approval-mode <mode>]";
const PLAN_CLI_USAGE = 'node src/cli.mjs plan [task|last|current [json|summary|failures]|timeline [current|trace|replay:<id>|latest] [json|summary|failures]|replay <session-id> [json|summary|failures]]';
const PLAN_REPL_USAGE = '/plan [task|last|current [json|summary|failures]|timeline [current|trace|replay:<id>|latest] [json|summary|failures]|replay <session-id> [json|summary|failures]]';
const WHY_CLI_USAGE = 'node src/cli.mjs why [overview|route|model|tool|plan|verifier] [current|trace|replay:<id>|latest] [json|summary|failures]';
const WHY_REPL_USAGE = '/why [overview|route|model|tool|plan|verifier] [current|trace|replay:<id>|latest] [json|summary|failures]';
const NEXT_CLI_USAGE = 'node src/cli.mjs next [current|trace|replay:<id>|latest] [json|summary|failures]';
const NEXT_REPL_USAGE = '/next [current|trace|replay:<id>|latest] [json|summary|failures]';
const RECOVER_CLI_USAGE = 'node src/cli.mjs recover [current|trace|replay:<id>|latest] [json|summary|failures]';
const RECOVER_REPL_USAGE = '/recover [current|trace|replay:<id>|latest] [json|summary|failures]';
const STATUS_CLI_USAGE = 'node src/cli.mjs status [json|summary]';
const STATUS_REPL_USAGE = '/status [json|summary]';
const HISTORY_CLI_USAGE = 'node src/cli.mjs history [all|changes|sessions|lineage|replay] [current|latest|<session-id>] [json|summary|failures]';
const HISTORY_REPL_USAGE = '/history [all|changes|sessions|lineage|replay] [current|latest|<session-id>] [json|summary|failures]';
const CONTINUE_CLI_USAGE = 'node src/cli.mjs continue [current|latest|<session-id>] [json|summary|failures]';
const CONTINUE_REPL_USAGE = '/continue [current|latest|<session-id>] [json|summary|failures]';
const ABOUT_CLI_USAGE = 'node src/cli.mjs about [json|summary]';
const ABOUT_REPL_USAGE = '/about [json|summary]';
const RESUME_CLI_USAGE = 'node src/cli.mjs resume <session-id> | resume recommend [current|latest|<session-id>] [json|summary|failures] | resume lineage [current|latest|<session-id>] [json|summary|failures]';
const RESUME_REPL_USAGE = '/resume <session-id> | /resume recommend [current|latest|<session-id>] [json|summary|failures] | /resume lineage [current|latest|<session-id>] [json|summary|failures]';

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp("core");
    return;
  }

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    process.exitCode = 0;
    process.exit(0);
  });

  const command = args.positionals[0] ?? "chat";
  const resumeInspectionCommand = command === "resume"
    && (args.positionals[1] === "recommend" || args.positionals[1] === "lineage");
  if (command === "help") {
    printHelp((args.positionals[1] ?? "core") as CommandSection | string);
    return;
  }

  const overrides = buildOverrides(args);
  const config = await loadConfig({
    cwd: toStringOption(args.options, "cwd"),
    configPath: toStringOption(args.options, "config") ?? null,
    overrides,
  });

  if (command === "config") {
    console.log(JSON.stringify(redactConfig(config), null, 2));
    return;
  }

  if (command === "about") {
    const parsed = parseInteractionAboutArgs(
      args.positionals.slice(1),
      ABOUT_CLI_USAGE,
      toStringOption(args.options, "format") ?? null,
    );
    console.log(renderAgentAbout(parsed.profile));
    return;
  }

  if (command === "instructions") {
    const projectInstructions = await loadProjectInstructions({
      cwd: config.cwd,
      userStateDir: config.userStateDir,
    });
    console.log(JSON.stringify(summarizeInstructionPack(projectInstructions, {
      includeContent: true,
    }), null, 2));
    return;
  }

  if (command === "resume" && !args.positionals[1]) {
    console.error(`Usage: ${RESUME_CLI_USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (command === "replay" && !args.positionals[1]) {
    console.error('Usage: node src/cli.mjs replay "<session-id>"');
    process.exitCode = 1;
    return;
  }

  if (
    !CORELESS_COMMANDS.includes(command) &&
    !resumeInspectionCommand &&
    config.provider !== "mock" &&
    !config.apiKey
  ) {
    console.error("");
    console.error("  MJ Code needs an API key to connect to an LLM provider.");
    console.error("");
    console.error("  Set one of these environment variables:");
    console.error("    export OPENAI_API_KEY=\"sk-...\"       # for OpenAI-compatible");
    console.error("    export ANTHROPIC_API_KEY=\"sk-ant-...\" # for Anthropic-compatible");
    console.error("");
    console.error("  Or create mjcode.config.json with your apiKey.");
    console.error("  See mjcode.config.example.json for a template.");
    console.error("");
    process.exitCode = 1;
    return;
  }

  const ui = createEnhancedTerminalUi() as AgentTerminalUi;
  let agent: CliAgent | null = null;

  try {
    agent =
      command === "resume" && !resumeInspectionCommand
        ? await MJCodeAgent.resume(
            {
              cwd: config.cwd,
              configPath: toStringOption(args.options, "config"),
              overrides,
            },
            ui,
            args.positionals[1],
          )
        : LOCAL_INSPECTION_COMMANDS.has(command) || resumeInspectionCommand
          ? await MJCodeAgent.inspect(
              {
                cwd: config.cwd,
                configPath: toStringOption(args.options, "config"),
                overrides,
              },
              ui,
            )
          : await MJCodeAgent.create(
              {
                cwd: config.cwd,
                configPath: toStringOption(args.options, "config"),
                overrides,
              },
              ui,
            );

    if (!agent) {
      throw new Error("Agent initialization failed.");
    }

    if (command === "memory") {
      console.log(JSON.stringify(await agent.getMemorySnapshot(), null, 2));
      return;
    }

    if (command === "status") {
      const parsed = parseInteractionStatusArgs(
        args.positionals.slice(1),
        STATUS_CLI_USAGE,
        toStringOption(args.options, "format") ?? null,
      );
      const report = await buildInteractionStatusReport(agent);
      console.log(renderAgentInteractionStatusReport(report, parsed.profile));
      return;
    }

    if (command === "tools") {
      console.log(JSON.stringify(agent.toolRegistry.getToolSpecs(), null, 2));
      return;
    }

    if (command === "capabilities") {
      if (args.positionals[1] === "inspect") {
        const capabilityId = args.positionals[2];
        if (!capabilityId) {
          console.error('Usage: node src/cli.mjs capabilities inspect "<capability-id>"');
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(agent.inspectCapability(capabilityId), null, 2));
        return;
      }
      console.log(JSON.stringify(agent.getCapabilities(), null, 2));
      return;
    }

    if (command === "route") {
      const prompt = args.positionals.slice(1).join(" ").trim();
      if (!prompt) {
        console.log(JSON.stringify(agent.getRoute("all"), null, 2));
        return;
      }
      if (prompt === "last") {
        console.log(JSON.stringify(agent.getRoute("last"), null, 2));
        return;
      }
      console.log(JSON.stringify(agent.previewRoute(prompt), null, 2));
      return;
    }

    if (command === "plan") {
      const parsed = parsePlanCommandArgs(
        args.positionals.slice(1),
        PLAN_CLI_USAGE,
        toStringOption(args.options, "format") ?? null,
      );
      if (parsed.kind === "legacy_all") {
        console.log(JSON.stringify(agent.getExecutionPlan("all"), null, 2));
        return;
      }
      if (parsed.kind === "legacy_last") {
        console.log(JSON.stringify(agent.getExecutionPlan("last"), null, 2));
        return;
      }
      if (parsed.kind === "legacy_preview") {
        console.log(JSON.stringify(agent.previewRoute(parsed.prompt).executionPlan, null, 2));
        return;
      }
      if (parsed.kind === "current") {
        console.log(renderPlanCurrentInspectReport(await agent.getPlanCurrent(), parsed.profile));
        return;
      }
      console.log(renderPlanTimelineInspectReport(await agent.getPlanTimeline(parsed.reference), parsed.profile));
      return;
    }

    if (command === "why") {
      const parsed = parseWhyCommandArgs(
        args.positionals.slice(1),
        WHY_CLI_USAGE,
        toStringOption(args.options, "format") ?? null,
      );
      console.log(renderAgentDecisionReport(
        await agent.explainWhy(parsed.scope, parsed.reference),
        parsed.profile,
        "why",
      ));
      return;
    }

    if (command === "next") {
      const parsed = parseDecisionActionArgs(
        args.positionals.slice(1),
        NEXT_CLI_USAGE,
        toStringOption(args.options, "format") ?? null,
      );
      console.log(renderAgentDecisionReport(
        await agent.getNextDecision(parsed.reference),
        parsed.profile,
        "next",
      ));
      return;
    }

    if (command === "recover") {
      const parsed = parseDecisionActionArgs(
        args.positionals.slice(1),
        RECOVER_CLI_USAGE,
        toStringOption(args.options, "format") ?? null,
      );
      console.log(renderAgentDecisionReport(
        await agent.getRecoveryDecision(parsed.reference),
        parsed.profile,
        "recover",
      ));
      return;
    }

    if (command === "verifier") {
      try {
        const result = await runVerifierInspectCommand(
          agent,
          args.positionals.slice(1),
          VERIFIER_CLI_USAGE,
          toStringOption(args.options, "format") ?? null,
          toNumberOption(args.options, "limit"),
          toStringOption(args.options, "policy") ?? null,
          isFlagEnabled(args.options, "write-artifact"),
          isFlagEnabled(args.options, "write-bundle"),
          isFlagEnabled(args.options, "dry-run"),
          toNumberOption(args.options, "max-count"),
          toNumberOption(args.options, "max-age-days"),
          isFlagEnabled(args.options, "github-actions"),
          toStringOption(args.options, "approver-id") ?? null,
          toStringOption(args.options, "approver-name") ?? null,
          toVerifierApprovalSourceOption(args.options, "approval-source") ?? null,
          toVerifierApprovalModeOption(args.options, "approval-mode") ?? null,
        );
        console.log(result.output);
        if (result.exitCode !== 0) {
          process.exitCode = result.exitCode;
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
      return;
    }

    if (command === "eval") {
      try {
        console.log(JSON.stringify(await runEvalCommand(
          agent,
          args.positionals.slice(1),
          toStringOption(args.options, "baseline") ?? null,
          toStringOption(args.options, "baseline-target") ?? null,
          toStringOption(args.options, "policy") ?? null,
          isFlagEnabled(args.options, "write-artifact"),
          isFlagEnabled(args.options, "write-bundle"),
        ), null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
      return;
    }

    if (command === "model") {
      console.log(JSON.stringify(agent.getModelDecision(), null, 2));
      return;
    }

    if (command === "provider") {
      console.log(JSON.stringify(agent.getProviderDecision(), null, 2));
      return;
    }

    if (command === "skills") {
      console.log(JSON.stringify(await handleSkillCli(args.positionals.slice(1), agent), null, 2));
      return;
    }

    if (command === "plugins") {
      console.log(JSON.stringify(await handlePluginCli(args.positionals.slice(1), agent), null, 2));
      return;
    }

    if (command === "sessions") {
      console.log(JSON.stringify(await agent.listSessions(), null, 2));
      return;
    }

    if (command === "jobs") {
      console.log(JSON.stringify(await agent.listJobs(args.positionals[1] ?? null), null, 2));
      return;
    }

    if (command === "tail") {
      const jobId = args.positionals[1];
      if (!jobId) {
        console.error('Usage: node src/cli.mjs tail "<job-id>" [--stdout-cursor N] [--stderr-cursor N] [--max-chars N]');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await agent.tailJob(jobId, buildTailOptions(args)), null, 2));
      return;
    }

    if (command === "attach") {
      const jobId = args.positionals[1];
      if (!jobId) {
        console.error('Usage: node src/cli.mjs attach "<job-id>" [--stdout-cursor N] [--stderr-cursor N] [--max-chars N]');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await agent.attachJob(jobId, buildTailOptions(args)), null, 2));
      return;
    }

    if (command === "cancel") {
      const jobId = args.positionals[1];
      if (!jobId) {
        console.error('Usage: node src/cli.mjs cancel "<job-id>"');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await agent.cancelJob(jobId), null, 2));
      return;
    }

    if (command === "shell-history") {
      console.log(JSON.stringify(await agent.getShellHistory(), null, 2));
      return;
    }

    if (command === "sources") {
      if (args.positionals[1] === "inspect") {
        const sourceId = args.positionals[2];
        if (!sourceId) {
          console.error('Usage: node src/cli.mjs sources inspect "<source-id>"');
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(await agent.inspectSource(sourceId, args.positionals[3] ?? "last"), null, 2));
        return;
      }
      console.log(JSON.stringify(await agent.getSources(args.positionals[1] ?? "last"), null, 2));
      return;
    }

    if (command === "network-mode") {
      console.log(JSON.stringify(agent.getNetworkMode(), null, 2));
      return;
    }

    if (command === "mcp") {
      const subcommand = args.positionals[1] ?? "servers";
      if (subcommand === "servers") {
        console.log(JSON.stringify(agent.getMcpServers(), null, 2));
        return;
      }
      if (subcommand === "tools") {
        console.log(JSON.stringify(agent.getMcpTools(), null, 2));
        return;
      }
      if (subcommand === "inspect") {
        const serverId = args.positionals[2];
        if (!serverId) {
          console.error('Usage: node src/cli.mjs mcp inspect "<server-id>"');
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(agent.inspectMcpServer(serverId), null, 2));
        return;
      }
      if (subcommand === "test") {
        const serverId = args.positionals[2];
        if (!serverId) {
          console.error('Usage: node src/cli.mjs mcp test "<server-id>"');
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(await agent.testMcpServer(serverId), null, 2));
        return;
      }
      console.error('Usage: node src/cli.mjs mcp <servers|tools|inspect|test> [server-id]');
      process.exitCode = 1;
      return;
    }

    if (command === "runtime") {
      const subcommand = args.positionals[1] ?? "health";
      if (subcommand === "health") {
        console.log(JSON.stringify(agent.getRuntimeHealth(), null, 2));
        return;
      }
      if (subcommand === "circuits") {
        console.log(JSON.stringify(agent.getRuntimeCircuits(), null, 2));
        return;
      }
      if (subcommand === "inspect") {
        console.log(JSON.stringify(agent.inspectRuntimeLayer(args.positionals[2] ?? "provider"), null, 2));
        return;
      }
      console.error('Usage: node src/cli.mjs runtime <health|circuits|inspect> [layer]');
      process.exitCode = 1;
      return;
    }

    if (command === "replay") {
      const sessionId = args.positionals[1];
      if (!sessionId) {
        console.error('Usage: node src/cli.mjs replay "<session-id>"');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await agent.replaySession(sessionId), null, 2));
      return;
    }

    if (command === "history") {
      const parsed = parseInteractionHistoryArgs(
        args.positionals.slice(1),
        HISTORY_CLI_USAGE,
        toStringOption(args.options, "format") ?? null,
      );
      const report = await agent.browseSessionHistory(parsed.scope, parsed.reference);
      console.log(renderSessionBrowserReport(report, parsed.profile));
      return;
    }

    if (command === "continue") {
      const parsed = parseInteractionContinueArgs(
        args.positionals.slice(1),
        CONTINUE_CLI_USAGE,
        toStringOption(args.options, "format") ?? null,
      );
      console.log(await renderContinueReport(agent, parsed.reference, parsed.profile));
      return;
    }

    if (command === "resume" && resumeInspectionCommand) {
      const parsed = parseInteractionResumeArgs(
        args.positionals.slice(1),
        RESUME_CLI_USAGE,
        toStringOption(args.options, "format") ?? null,
      );
      if (parsed.kind === "recommend") {
        console.log(renderSessionResumeRecommendationReport(
          await agent.recommendSessionResume(parsed.reference),
          parsed.profile,
        ));
        return;
      }
      console.log(renderSessionBrowserReport(
        await agent.browseSessionHistory("lineage", parsed.reference),
        parsed.profile,
      ));
      return;
    }

    if (!agent.config.model && agent.config.provider !== "mock" && !["search", "fetch", "extract"].includes(command)) {
      ui.printError("No model specified. Set one with --model, MJ_CODE_MODEL, or in mjcode.config.json.");
      process.exitCode = 1;
      return;
    }

    if (command === "models") {
      const models = await agent.listModels();
      console.log(JSON.stringify(models, null, 2));
      return;
    }

    if (command === "run") {
      const prompt = args.positionals.slice(1).join(" ").trim();
      if (!prompt) {
        console.error('Usage: node src/cli.mjs run "your prompt"');
        process.exitCode = 1;
        return;
      }

      const result = await agent.runUserInput(prompt);
      if (result.content && !result.printed) {
        console.log(result.content);
      }
      return;
    }

    if (command === "search") {
      const query = args.positionals.slice(1).join(" ").trim();
      if (!query) {
        console.error('Usage: node src/cli.mjs search "query"');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await agent.invokeCommandTool("web_search", { query }), null, 2));
      return;
    }

    if (command === "fetch") {
      const url = args.positionals[1];
      if (!url) {
        console.error('Usage: node src/cli.mjs fetch "<url>"');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await agent.invokeCommandTool("fetch_url", { url }), null, 2));
      return;
    }

    if (command === "extract") {
      const url = args.positionals[1];
      if (!url) {
        console.error('Usage: node src/cli.mjs extract "<url>"');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await agent.invokeCommandTool("extract_content", { url }), null, 2));
      return;
    }

    await runInteractiveSession(agent);
  } finally {
    await agent?.close?.();
    ui.close();
  }
}

async function runInteractiveSession(agent: CliAgent): Promise<void> {
  agent.ui.setInteractiveResolver?.(createInteractiveSessionPickerResolver(agent));
  agent.ui.printBanner(agent.getStatus(), agent.sessionFilePath);

  const batchLines = agent.ui.readBatchLines?.();
  if (batchLines) {
    for await (const rawLine of batchLines) {
      const input = rawLine.trim();
      if (!input) {
        continue;
      }
      if (input.startsWith("/")) {
        const keepRunning = await handleSlashCommand(input, agent);
        if (!keepRunning) {
          break;
        }
        continue;
      }
      try {
        if (typeof (agent.ui as unknown as Record<string, unknown>).printUserMessage === "function") {
          ((agent.ui as unknown as Record<string, unknown>).printUserMessage as (content: string) => void)(input);
        }
        const result = await agent.runUserInput(input);
        if (result.content && !result.printed) {
          console.log(result.content);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        agent.ui.printError(message);
      }
    }
    return;
  }

  while (true) {
    const input = (await agent.ui.ask(INTERACTIVE_SHELL_PROMPT)).trim();
    if (!input) {
      continue;
    }

    if (input.startsWith("/")) {
      const keepRunning = await handleSlashCommand(input, agent);
      if (!keepRunning) {
        break;
      }
      continue;
    }

    try {
      if (typeof (agent.ui as unknown as Record<string, unknown>).printUserMessage === "function") {
        ((agent.ui as unknown as Record<string, unknown>).printUserMessage as (content: string) => void)(input);
      }
      const result = await agent.runUserInput(input);
      if (result.content && !result.printed) {
        console.log(result.content);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agent.ui.printError(message);
    }
  }
}

async function buildInteractionStatusReport(
  agent: CliAgent,
) {
  const lineage = await agent.browseSessionHistory("lineage", "current").catch(() => null);
  const recommendation = await agent.recommendSessionResume("current").catch(() => null);
  return buildAgentInteractionStatusReport(agent.getStatus(), {
    lineage,
    recommendation,
  });
}

async function renderContinueReport(
  agent: CliAgent,
  reference: string,
  profile: "summary" | "json" | "failures" = "summary",
): Promise<string> {
  const browserReport = await agent.browseSessionHistory("sessions", reference);
  const recommendationReport = await agent.recommendSessionResume(reference);
  return renderContinueInspectReport({
    browserReport,
    recommendationReport,
    profile,
  });
}

function createInteractiveSessionPickerResolver(
  agent: CliAgent,
): (line: string) => Promise<InteractiveSessionPickerReport | null> {
  return async (line: string): Promise<InteractiveSessionPickerReport | null> => {
    const parsed = parseInteractiveSessionPickerLine(line);
    if (!parsed) {
      return null;
    }
    const browserReference = parsed.reference ?? "current";
    const browserScope = parsed.mode === "history_replay"
      ? "replay"
      : parsed.mode === "history_lineage"
        ? "lineage"
        : "sessions";
    const browserReport = await agent.browseSessionHistory(browserScope, browserReference).catch(() => null);
    if (!browserReport) {
      return null;
    }
    const recommendationReport = (parsed.mode === "continue" || parsed.mode === "resume" || parsed.mode === "resume_recommend")
      ? await agent.recommendSessionResume(browserReference).catch(() => null)
      : null;
    return buildInteractiveSessionPickerReport({
      mode: parsed.mode,
      query: parsed.query,
      browserReport,
      recommendationReport,
    });
  };
}

async function handleSlashCommand(input: string, agent: CliAgent): Promise<boolean> {
  const [command, ...parts] = input.trim().split(/\s+/);

  switch (command) {
    case "/":
      // The interactive palette overlay is already handled by the palette controller
      // when the user types "/" in the readline. If we reach here, it means the
      // palette was dismissed or not available — show a text fallback.
      console.log(renderInteractiveCommandPalette());
      return true;
    case "/help":
      printInteractiveHelp(parts[0] ?? "core");
      return true;
    case "/about": {
      const parsed = parseInteractionAboutArgs(parts, ABOUT_REPL_USAGE, null);
      console.log(renderAgentAbout(parsed.profile));
      return true;
    }
    case "/effort": {
      const level = parts[0]?.toLowerCase();
      if (!level) {
        // Show current effort level
        const current = getEffortLevel();
        console.log(`Current effort level: ${current}`);
        console.log("Usage: /effort <low|medium|high|max>");
        return true;
      }
      if (!isValidEffortLevel(level)) {
        console.log(`Invalid effort level: "${level}". Must be one of: low, medium, high, max`);
        return true;
      }
      setEffortLevel(level);
      if (typeof (agent.ui as unknown as Record<string, unknown>).printEffortLevel === "function") {
        ((agent.ui as unknown as Record<string, unknown>).printEffortLevel as (level: EffortLevel) => void)(level);
      } else {
        console.log(`Effort level set to: ${level}`);
      }
      return true;
    }
    case "/tools":
      console.log(JSON.stringify(agent.toolRegistry.getToolSpecs(), null, 2));
      return true;
    case "/capabilities":
      if (parts[0] === "inspect") {
        const capabilityId = parts[1];
        if (!capabilityId) {
          console.log("Usage: /capabilities inspect <capability-id>");
          return true;
        }
        console.log(JSON.stringify(agent.inspectCapability(capabilityId), null, 2));
        return true;
      }
      console.log(JSON.stringify(agent.getCapabilities(), null, 2));
      return true;
    case "/config":
      console.log(JSON.stringify(redactConfig(agent.config), null, 2));
      return true;
    case "/status":
      try {
        const parsed = parseInteractionStatusArgs(parts, STATUS_REPL_USAGE, null);
        const report = await buildInteractionStatusReport(agent);
        console.log(renderAgentInteractionStatusReport(report, parsed.profile));
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    case "/model":
      console.log(JSON.stringify(agent.getModelDecision(), null, 2));
      return true;
    case "/provider":
      console.log(JSON.stringify(agent.getProviderDecision(), null, 2));
      return true;
    case "/instructions":
      console.log(JSON.stringify(agent.getStatus().instructions, null, 2));
      return true;
    case "/models":
      console.log(JSON.stringify(await agent.listModels(), null, 2));
      return true;
    case "/memory":
      return handleMemoryCommand(parts, agent);
    case "/skills":
    case "/skill":
      console.log(JSON.stringify(await handleSkillCli(parts, agent), null, 2));
      return true;
    case "/plugins":
    case "/plugin":
      console.log(JSON.stringify(await handlePluginCli(parts, agent), null, 2));
      return true;
    case "/search": {
      const query = parts.join(" ").trim();
      if (!query) {
        console.log("Usage: /search <query>");
        return true;
      }
      console.log(JSON.stringify(await agent.invokeCommandTool("web_search", { query }), null, 2));
      return true;
    }
    case "/fetch": {
      const url = parts[0];
      if (!url) {
        console.log("Usage: /fetch <url>");
        return true;
      }
      console.log(JSON.stringify(await agent.invokeCommandTool("fetch_url", { url }), null, 2));
      return true;
    }
    case "/extract": {
      const url = parts[0];
      if (!url) {
        console.log("Usage: /extract <url>");
        return true;
      }
      console.log(JSON.stringify(await agent.invokeCommandTool("extract_content", { url }), null, 2));
      return true;
    }
    case "/sources":
      return handleSourcesCommand(parts, agent);
    case "/network-mode":
      console.log(JSON.stringify(agent.getNetworkMode(), null, 2));
      return true;
    case "/mcp":
      return handleMcpCommand(parts, agent);
    case "/runtime":
      return handleRuntimeCommand(parts, agent);
    case "/route":
      if (parts[0] === "last" || parts.length === 0) {
        console.log(JSON.stringify(agent.getRoute(parts[0] === "last" ? "last" : "all"), null, 2));
        return true;
      }
      console.log(JSON.stringify(agent.previewRoute(parts.join(" ")), null, 2));
      return true;
    case "/plan":
      try {
        const parsed = parsePlanCommandArgs(parts, PLAN_REPL_USAGE, null);
        if (parsed.kind === "legacy_all") {
          console.log(JSON.stringify(agent.getExecutionPlan("all"), null, 2));
          return true;
        }
        if (parsed.kind === "legacy_last") {
          console.log(JSON.stringify(agent.getExecutionPlan("last"), null, 2));
          return true;
        }
        if (parsed.kind === "legacy_preview") {
          console.log(JSON.stringify(agent.previewRoute(parsed.prompt).executionPlan, null, 2));
          return true;
        }
        if (parsed.kind === "current") {
          console.log(renderPlanCurrentInspectReport(await agent.getPlanCurrent(), parsed.profile));
          return true;
        }
        console.log(renderPlanTimelineInspectReport(await agent.getPlanTimeline(parsed.reference), parsed.profile));
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    case "/why":
      try {
        const parsed = parseWhyCommandArgs(parts, WHY_REPL_USAGE, null);
        console.log(renderAgentDecisionReport(
          await agent.explainWhy(parsed.scope, parsed.reference),
          parsed.profile,
          "why",
        ));
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    case "/next":
      try {
        const parsed = parseDecisionActionArgs(parts, NEXT_REPL_USAGE, null);
        console.log(renderAgentDecisionReport(
          await agent.getNextDecision(parsed.reference),
          parsed.profile,
          "next",
        ));
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    case "/recover":
      try {
        const parsed = parseDecisionActionArgs(parts, RECOVER_REPL_USAGE, null);
        console.log(renderAgentDecisionReport(
          await agent.getRecoveryDecision(parsed.reference),
          parsed.profile,
          "recover",
        ));
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    case "/verifier":
      try {
        const result = await runVerifierInspectCommand(
          agent,
          parts,
          VERIFIER_REPL_USAGE,
          null,
          null,
          null,
          false,
          false,
          false,
          null,
          null,
          false,
          null,
          null,
          null,
          null,
        );
        console.log(result.output);
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    case "/eval":
      try {
        console.log(JSON.stringify(await runEvalCommand(agent, parts, null, null, null, false, false), null, 2));
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    case "/diff":
      return handleDiffCommand(parts, agent);
    case "/undo":
      return handleUndoCommand(parts, agent);
    case "/history":
      try {
        return await handleHistoryCommand(parts, agent);
      } catch (error) {
        if (shouldRenderQueryFallback(input, error)) {
          console.log(renderInteractiveCommandPalette(getInteractiveCommandPalette(input.trim().slice(1))));
          return true;
        }
        console.log(error instanceof Error ? error.message : String(error));
        return true;
      }
    case "/continue":
      try {
        const parsed = parseInteractionContinueArgs(parts, CONTINUE_REPL_USAGE, null);
        console.log(await renderContinueReport(agent, parsed.reference, parsed.profile));
      } catch (error) {
        if (shouldRenderQueryFallback(input, error)) {
          console.log(renderInteractiveCommandPalette(getInteractiveCommandPalette(input.trim().slice(1))));
          return true;
        }
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    case "/resume": {
      try {
        const parsed = parseInteractionResumeArgs(parts, RESUME_REPL_USAGE, null);
        if (parsed.kind === "recommend") {
          console.log(renderSessionResumeRecommendationReport(
            await agent.recommendSessionResume(parsed.reference),
            parsed.profile,
          ));
          return true;
        }
        if (parsed.kind === "lineage") {
          console.log(renderSessionBrowserReport(
            await agent.browseSessionHistory("lineage", parsed.reference),
            parsed.profile,
          ));
          return true;
        }
        const result = await agent.resumeFromSession(parsed.reference);
        agent.ui.printInfo("resume", `Loaded ${result.sessionId} from ${result.snapshot}`);
      } catch (error) {
        if (shouldRenderQueryFallback(input, error)) {
          console.log(renderInteractiveCommandPalette(getInteractiveCommandPalette(input.trim().slice(1))));
          return true;
        }
        console.log(error instanceof Error ? error.message : String(error));
      }
      return true;
    }
    case "/replay": {
      const sessionId = parts[0];
      if (!sessionId) {
        console.log("Usage: /replay <session-id>");
        return true;
      }
      console.log(JSON.stringify(await agent.replaySession(sessionId), null, 2));
      return true;
    }
    case "/trace":
      console.log(JSON.stringify(await agent.getTrace(parts[0] ?? "current"), null, 2));
      return true;
    case "/approve-mode":
      console.log(JSON.stringify(agent.getApprovalMode(), null, 2));
      return true;
    case "/jobs":
      console.log(JSON.stringify(await agent.listJobs(parts[0] ?? null), null, 2));
      return true;
    case "/cancel": {
      const jobId = parts[0];
      if (!jobId) {
        console.log("Usage: /cancel <job-id>");
        return true;
      }
      console.log(JSON.stringify(await agent.cancelJob(jobId), null, 2));
      return true;
    }
    case "/tail": {
      const jobId = parts[0];
      if (!jobId) {
        console.log("Usage: /tail <job-id> [stdoutCursor] [stderrCursor]");
        return true;
      }
      console.log(JSON.stringify(await agent.tailJob(jobId, buildSlashTailOptions(parts.slice(1))), null, 2));
      return true;
    }
    case "/attach": {
      const jobId = parts[0];
      if (!jobId) {
        console.log("Usage: /attach <job-id> [stdoutCursor] [stderrCursor]");
        return true;
      }
      console.log(JSON.stringify(await agent.attachJob(jobId, buildSlashTailOptions(parts.slice(1))), null, 2));
      return true;
    }
    case "/shell-history":
      console.log(JSON.stringify(await agent.getShellHistory(), null, 2));
      return true;
    case "/compact": {
      const result = await agent.compactConversation();
      agent.ui.printInfo(
        "compact",
        result.compactedMessages > 0
          ? `Compacted ${result.compactedMessages} message(s) into rolling summary.`
          : "Nothing to compact yet.",
      );
      return true;
    }
    case "/cost":
      console.log(JSON.stringify(agent.getUsageSummary(), null, 2));
      return true;
    case "/clear":
      agent.clearConversation();
      agent.ui.printInfo("state", "Conversation cleared.");
      return true;
    case "/session":
      console.log(agent.sessionFilePath);
      return true;
    case "/exit":
    case "/quit":
      return false;
    default:
      console.log(renderInteractiveCommandPalette(getInteractiveCommandPalette(input.trim().slice(1))));
      return true;
  }
}

function shouldRenderQueryFallback(input: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) {
    return false;
  }
  if (!message.startsWith("Usage:")) {
    return false;
  }
  const query = input.trim().slice(1).trim();
  if (!query) {
    return false;
  }
  return true;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: OptionMap = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      return { help: true, options, positionals };
    }

    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { help: false, options, positionals };
}

async function runVerifierInspectCommand(
  agent: CliAgent,
  parts: string[],
  usage: string,
  optionFormat: string | null,
  optionLimit: number | null,
  optionPolicy: string | null,
  optionWriteArtifact: boolean,
  optionWriteBundle: boolean,
  optionDryRun: boolean,
  optionMaxCount: number | null,
  optionMaxAgeDays: number | null,
  optionGithubActions: boolean,
  optionApproverId: string | null,
  optionApproverName: string | null,
  optionApprovalSource: "cli" | "workflow_dispatch" | "schedule" | "pull_request" | "automation" | null,
  optionApprovalMode: "explicit_apply" | "workflow_apply" | null,
): Promise<{
  output: string;
  exitCode: number;
}> {
  const parsed = parseVerifierInspectCommandArgs(parts, usage, optionFormat, {
    limit: optionLimit,
    policy: optionPolicy,
    writeArtifact: optionWriteArtifact,
    writeBundle: optionWriteBundle,
    dryRun: optionDryRun,
    maxCount: optionMaxCount,
    maxAgeDays: optionMaxAgeDays,
    githubActions: optionGithubActions,
    approverId: optionApproverId,
    approverName: optionApproverName,
    approvalSource: optionApprovalSource,
    approvalMode: optionApprovalMode,
  });
  const githubActionsBackfill = "githubActions" in parsed && parsed.githubActions
    ? createVerifierGitHubActionsBackfillInputFromEnv(process.env)
    : null;
  switch (parsed.kind) {
    case "inspect": {
      const report = parsed.reference.kind === "replay"
        ? await agent.inspectVerifierReplay(parsed.reference.reference ?? "")
        : await agent.getVerifierReport(parsed.reference.kind === "trace" ? "trace" : "current");
      return {
        output: renderVerifierInspectReport(report, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "export": {
      const record = await agent.exportVerifierReport(parsed.reference);
      return {
        output: renderVerifierInspectSnapshotRecord(record, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "exports": {
      const list = await agent.listVerifierSnapshots(parsed.limit);
      return {
        output: renderVerifierInspectSnapshotList(list, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "baseline_pin": {
      const record = await agent.pinVerifierBaseline(parsed.reference, parsed.name, {
        policyProfileId: parsed.policyProfileId,
      });
      return {
        output: renderVerifierInspectBaselineRecord(record, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "baselines": {
      const list = await agent.listVerifierBaselines(parsed.limit);
      return {
        output: renderVerifierInspectBaselineList(list, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "compare": {
      const report = await agent.compareVerifierReports(parsed.left, parsed.right, {
        writeArtifact: parsed.writeArtifact,
        writeBundle: parsed.writeBundle,
      });
      return {
        output: renderVerifierInspectCompareReport(report, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "gate": {
      const decision = await agent.gateVerifierReports(parsed.left, parsed.right, undefined, {
        profileId: parsed.policyProfileId,
        writeArtifact: parsed.writeArtifact,
        writeBundle: parsed.writeBundle,
      });
      return {
        output: renderVerifierRegressionGateDecision(decision, { profile: parsed.profile }),
        exitCode: decision.pass ? 0 : 1,
      };
    }
    case "policies": {
      const profiles = await agent.listVerifierGatePolicyProfiles();
      return {
        output: renderVerifierRegressionGatePolicyProfiles(profiles, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "artifacts": {
      const list = await agent.listVerifierArtifacts(parsed.limit);
      return {
        output: renderVerifierInspectArtifactList(list, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "artifact": {
      const record = await agent.inspectVerifierArtifact(parsed.artifactId);
      return {
        output: renderVerifierInspectArtifactRecord(record, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "handoff": {
      const selection = await agent.inspectVerifierHandoff(parsed.reference);
      return {
        output: renderVerifierReleaseHandoff(selection, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "handoff_export": {
      const bundle = await agent.exportVerifierBundle(parsed.reference);
      return {
        output: renderVerifierReleaseBundle(bundle, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "artifacts_prune": {
      const result = await agent.pruneVerifierArtifacts(parsed.policy);
      return {
        output: renderVerifierInspectArtifactPruneResult(result, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "promotion_plan": {
      const plan = await agent.planVerifierBaselinePromotion(parsed.baselineName, parsed.reference, {
        policyProfileId: parsed.policyProfileId,
      });
      return {
        output: renderVerifierBaselinePromotionPlan(plan, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "promotion_approve": {
      const plan = await agent.approveVerifierBaselinePromotion(parsed.reference, {
        approverId: parsed.approverId,
        approverDisplayName: parsed.approverDisplayName,
        approvalSource: parsed.approvalSource ?? undefined,
        approvalMode: parsed.approvalMode ?? undefined,
      });
      return {
        output: renderVerifierBaselinePromotionPlan(plan, { profile: parsed.profile }),
        exitCode: plan.approvalStatus === "applied" ? 0 : 1,
      };
    }
    case "promotion_history": {
      const history = await agent.listVerifierBaselinePromotionHistory(parsed.baselineName);
      return {
        output: renderVerifierBaselinePromotionHistory(history, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "triage_summary": {
      const triage = await agent.summarizeVerifierReleaseTriage(parsed.reference, {
        githubActionsBackfill,
      });
      return {
        output: renderVerifierReleaseTriageSummary(triage, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "drilldown": {
      const drilldown = await agent.drilldownVerifier(parsed.reference, {
        githubActionsBackfill,
      });
      return {
        output: renderVerifierDrilldownReport(drilldown, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "timeline": {
      const timeline = await agent.timelineVerifier(parsed.reference, {
        githubActionsBackfill,
      });
      return {
        output: renderVerifierTimelineReport(timeline, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "checks_summary": {
      const payload = await agent.exportVerifierGitHubChecksPayload(parsed.reference, {
        githubActionsBackfill,
      });
      return {
        output: renderVerifierGitHubChecksPayload(payload, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    case "checks_export": {
      const payload = await agent.exportVerifierGitHubChecksPayload(parsed.reference, {
        githubActionsBackfill,
      });
      return {
        output: renderVerifierGitHubChecksPayload(payload, { profile: parsed.profile }),
        exitCode: payload.available && payload.conclusion === "failure" ? 1 : 0,
      };
    }
    case "github_apply": {
      const result = await agent.applyVerifierGitHubMutation(parsed.reference, {
        githubActionsBackfill,
        env: process.env,
      });
      return {
        output: renderVerifierGitHubMutationResult(result, { profile: parsed.profile }),
        exitCode: result.status === "failed" ? 1 : 0,
      };
    }
    case "github_result": {
      const selection = await agent.inspectVerifierGitHubMutation(parsed.reference);
      return {
        output: renderVerifierGitHubMutationResult(selection.result, { profile: parsed.profile }),
        exitCode: 0,
      };
    }
    default:
      throw new Error(`Usage: ${usage}`);
  }
}

async function runEvalCommand(
  agent: CliAgent,
  parts: string[],
  optionBaseline: string | null,
  optionBaselineTarget: string | null,
  optionPolicy: string | null,
  optionWriteArtifact: boolean,
  optionWriteBundle: boolean,
): Promise<unknown> {
  const parsed = parseEvalCommandArgs(
    parts,
    optionBaseline,
    optionBaselineTarget,
    optionPolicy,
    optionWriteArtifact,
    optionWriteBundle,
  );
  if (!parsed.baselineReference) {
    const result = agent.runEval(parsed.suite);
    if (parsed.writeArtifact || parsed.writeBundle) {
      const artifact = await agent.writeVerifierEvalArtifact(result, {
        writeBundle: parsed.writeBundle,
      });
      result.artifact = artifact.metadata;
    }
    return result;
  }
  const baselineGate = await agent.gateVerifierReports(
    parsed.baselineReference,
    parsed.targetReference,
    undefined,
    { profileId: parsed.policyProfileId },
  );
  const request: EvalRunRequest = {
    suite: parsed.suite,
    baselineGate,
  };
  const result = agent.runEval(request);
  if (parsed.writeArtifact || parsed.writeBundle) {
    const artifact = await agent.writeVerifierEvalArtifact(result, {
      writeBundle: parsed.writeBundle,
    });
    result.artifact = artifact.metadata;
  }
  return result;
}

function parseEvalCommandArgs(
  parts: string[],
  optionBaseline: string | null,
  optionBaselineTarget: string | null,
  optionPolicy: string | null,
  optionWriteArtifact: boolean,
  optionWriteBundle: boolean,
): {
  suite: string;
  baselineReference: VerifierInspectReference | null;
  targetReference: VerifierInspectReference;
  policyProfileId: string | null;
  writeArtifact: boolean;
  writeBundle: boolean;
} {
  const tokens = tokenizeEvalArgs(parts);
  const suite = tokens.positionals[0] ?? "all";
  const baselineToken = tokens.baseline ?? optionBaseline;
  const baselineTargetToken = tokens.baselineTarget ?? optionBaselineTarget;
  const policyProfileId = tokens.policy ?? optionPolicy;
  const baselineReference = baselineToken
    ? parseVerifierInspectReferenceToken(baselineToken, "Usage: eval [suite] [--baseline baseline:<name>] [--baseline-target <reference>] [--policy <profile>] [--write-artifact] [--write-bundle]")
    : null;
  if (baselineReference && baselineReference.kind !== "baseline") {
    throw new Error("Usage: eval baseline must use baseline:<name>.");
  }
  return {
    suite,
    baselineReference,
    targetReference: baselineTargetToken
      ? parseVerifierInspectReferenceToken(
          baselineTargetToken,
          "Usage: eval [suite] [--baseline baseline:<name>] [--baseline-target <reference>] [--policy <profile>] [--write-artifact] [--write-bundle]",
        )
      : { kind: "current", reference: null },
    policyProfileId,
    writeArtifact: tokens.writeArtifact || optionWriteArtifact,
    writeBundle: tokens.writeBundle || optionWriteBundle,
  };
}

function tokenizeEvalArgs(parts: string[]): {
  baseline: string | null;
  baselineTarget: string | null;
  policy: string | null;
  writeArtifact: boolean;
  writeBundle: boolean;
  positionals: string[];
} {
  let baseline: string | null = null;
  let baselineTarget: string | null = null;
  let policy: string | null = null;
  let writeArtifact = false;
  let writeBundle = false;
  const positionals: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const token = `${parts[index] ?? ""}`.trim();
    if (!token) {
      continue;
    }
    if (token === "--baseline") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing eval baseline reference.");
      }
      baseline = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--baseline=")) {
      baseline = token.slice("--baseline=".length).trim() || null;
      continue;
    }
    if (token === "--baseline-target") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing eval baseline target reference.");
      }
      baselineTarget = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--baseline-target=")) {
      baselineTarget = token.slice("--baseline-target=".length).trim() || null;
      continue;
    }
    if (token === "--policy") {
      const next = `${parts[index + 1] ?? ""}`.trim();
      if (!next) {
        throw new Error("Usage: missing eval baseline policy profile.");
      }
      policy = next;
      index += 1;
      continue;
    }
    if (token.startsWith("--policy=")) {
      policy = token.slice("--policy=".length).trim() || null;
      continue;
    }
    if (token === "--write-artifact") {
      writeArtifact = true;
      continue;
    }
    if (token === "--write-bundle") {
      writeBundle = true;
      continue;
    }
    positionals.push(token);
  }
  return {
    baseline,
    baselineTarget,
    policy,
    writeArtifact,
    writeBundle,
    positionals,
  };
}

function buildOverrides(args: ParsedArgs): Partial<ResolvedConfig> & JsonMap {
  return compactObject<Partial<ResolvedConfig> & JsonMap>({
    cwd: toStringOption(args.options, "cwd"),
    provider: toStringOption(args.options, "provider"),
    model: toStringOption(args.options, "model"),
    baseUrl: toStringOption(args.options, "base-url"),
    apiKey: toStringOption(args.options, "api-key"),
    permissionMode: toPermissionMode(toStringOption(args.options, "permission-mode")),
    approvalPolicy: toApprovalPolicy(toStringOption(args.options, "approval-policy")),
    authMode: toStringOption(args.options, "auth-mode"),
    networkMode: toNetworkMode(toStringOption(args.options, "network-mode")),
    webProvider: toWebProvider(toStringOption(args.options, "web-provider")),
    webRankingMode: toWebRankingMode(toStringOption(args.options, "web-ranking-mode")),
    mcpEnabled: isFlagEnabled(args.options, "no-mcp")
      ? false
      : isFlagEnabled(args.options, "mcp")
        ? true
        : undefined,
    streamOutput: isFlagEnabled(args.options, "no-stream")
      ? false
      : isFlagEnabled(args.options, "stream")
        ? true
        : undefined,
  });
}

function printHelp(section: CommandSection | string = "core"): void {
  const resolvedSection = normalizeSection(section);
  console.log([
    formatCommandHelp("cli", resolvedSection),
    "",
    "Usage:",
    "  mj-code                          Start interactive REPL",
    "  mj-code run \"<prompt>\"           Run a one-shot task",
    "  mj-code about                    Show project info",
    "",
    "Quick start:",
    "  export OPENAI_API_KEY=\"sk-...\"",
    "  mj-code run \"Explain this project\"",
    "",
    "Common options:",
    "  --provider <openai-compatible|anthropic-compatible|mock>",
    "  --model <model-id>",
    "  --base-url <url>",
    "  --api-key <key>",
    "  --permission-mode <read-only|workspace-write|full-access>",
    "  --approval-policy <always|on-write|never>",
    "  --network-mode <off|docs-only|open-web>",
    "  --config <path>",
    "  --cwd <path>",
    "",
    "Advanced:",
    "  mj-code help advanced             More commands",
    "  mj-code help debug                Debug commands",
    "  --auth-mode <auto|bearer|x-api-key>",
    "  --web-provider <fallback|brave>",
    "  --mcp / --no-mcp",
    "  --stream / --no-stream",
    "",
    "REPL commands:",
    "  /effort <low|medium|high|max>     Set reasoning effort level",
    "  /about                            Show project attribution",
    "  /help                             Show available commands",
    "  /exit                             Exit MJ Code",
  ].join("\n"));
}

function printInteractiveHelp(section: CommandSection | string = "core"): void {
  console.log(formatCommandHelp("repl", section));
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

function buildTailOptions(args: ParsedArgs): TailOptions {
  const stdoutCursor = parseOptionalInteger(args.options["stdout-cursor"]);
  const stderrCursor = parseOptionalInteger(args.options["stderr-cursor"]);
  const maxChars = parseOptionalInteger(args.options["max-chars"]);
  const cursor = stdoutCursor != null || stderrCursor != null
    ? {
        stdout: stdoutCursor ?? 0,
        stderr: stderrCursor ?? 0,
      }
    : undefined;
  return compactObject({
    maxChars: maxChars ?? undefined,
    cursor,
  });
}

function buildSlashTailOptions(parts: string[]): TailOptions {
  const stdoutCursor = parseOptionalInteger(parts[0]);
  const stderrCursor = parseOptionalInteger(parts[1]);
  if (stdoutCursor == null && stderrCursor == null) {
    return {};
  }
  return {
    cursor: {
      stdout: stdoutCursor ?? 0,
      stderr: stderrCursor ?? 0,
    },
  };
}

function parseOptionalInteger(value: string | boolean | undefined): number | null {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function handleMemoryCommand(parts: string[], agent: CliAgent): Promise<boolean> {
  const subcommand = parts[0] ?? "show";

  if (subcommand === "show") {
    console.log(JSON.stringify(await agent.getMemorySnapshot(), null, 2));
    return true;
  }

  if (subcommand === "search") {
    const query = parts.slice(1).join(" ").trim();
    if (!query) {
      console.log("Usage: /memory search <query>");
      return true;
    }

    console.log(JSON.stringify(await agent.searchMemory(query), null, 2));
    return true;
  }

  if (subcommand === "add") {
    const scope = parts[1];
    const text = parts.slice(2).join(" ").trim();
    if (!scope || !text) {
      console.log("Usage: /memory add <session|project|user|failure> <text>");
      return true;
    }

    const item = await agent.rememberMemory({
      scope,
      text,
      source: "slash-command",
    });
    console.log(JSON.stringify(item, null, 2));
    return true;
  }

  console.log("Usage:");
  console.log("/memory");
  console.log("/memory search <query>");
  console.log("/memory add <session|project|user|failure> <text>");
  return true;
}

async function handleSkillCli(parts: string[], agent: CliAgent): Promise<unknown> {
  const subcommand = parts[0] ?? "list";

  if (subcommand === "list") {
    return agent.getSkills();
  }

  if (subcommand === "inspect") {
    const skillId = parts[1];
    if (!skillId) {
      return { usage: 'skills inspect "<skill-id>"' };
    }
    return agent.inspectSkill(skillId);
  }

  if (subcommand === "enable") {
    const skillId = parts[1];
    if (!skillId) {
      return { usage: 'skills enable "<skill-id>"' };
    }
    return agent.enableSkill(skillId);
  }

  if (subcommand === "disable") {
    const skillId = parts[1];
    if (!skillId) {
      return { usage: 'skills disable "<skill-id>"' };
    }
    return agent.disableSkill(skillId);
  }

  return agent.getSkills();
}

async function handlePluginCli(parts: string[], agent: CliAgent): Promise<unknown> {
  const subcommand = parts[0] ?? "list";

  if (subcommand === "list") {
    return agent.getPlugins();
  }

  if (subcommand === "inspect") {
    const pluginId = parts[1];
    if (!pluginId) {
      return { usage: 'plugins inspect "<plugin-id>"' };
    }
    return agent.inspectPlugin(pluginId);
  }

  if (subcommand === "enable") {
    const pluginId = parts[1];
    if (!pluginId) {
      return { usage: 'plugins enable "<plugin-id>"' };
    }
    return agent.enablePlugin(pluginId);
  }

  if (subcommand === "disable") {
    const pluginId = parts[1];
    if (!pluginId) {
      return { usage: 'plugins disable "<plugin-id>"' };
    }
    return agent.disablePlugin(pluginId);
  }

  return agent.getPlugins();
}

async function handleSourcesCommand(parts: string[], agent: CliAgent): Promise<boolean> {
  const subcommand = parts[0] ?? "last";
  if (subcommand === "inspect") {
    const sourceId = parts[1];
    if (!sourceId) {
      console.log("Usage: /sources inspect <source-id>");
      return true;
    }
    console.log(JSON.stringify(await agent.inspectSource(sourceId, parts[2] ?? "current"), null, 2));
    return true;
  }

  console.log(JSON.stringify(await agent.getSources(subcommand), null, 2));
  return true;
}

async function handleMcpCommand(parts: string[], agent: CliAgent): Promise<boolean> {
  const subcommand = parts[0] ?? "servers";

  if (subcommand === "servers") {
    console.log(JSON.stringify(agent.getMcpServers(), null, 2));
    return true;
  }

  if (subcommand === "tools") {
    console.log(JSON.stringify(agent.getMcpTools(), null, 2));
    return true;
  }

  if (subcommand === "inspect") {
    const serverId = parts[1];
    if (!serverId) {
      console.log("Usage: /mcp inspect <server-id>");
      return true;
    }
    console.log(JSON.stringify(agent.inspectMcpServer(serverId), null, 2));
    return true;
  }

  if (subcommand === "test") {
    const serverId = parts[1];
    if (!serverId) {
      console.log("Usage: /mcp test <server-id>");
      return true;
    }
    console.log(JSON.stringify(await agent.testMcpServer(serverId), null, 2));
    return true;
  }

  console.log("Usage:");
  console.log("/mcp servers");
  console.log("/mcp tools");
  console.log("/mcp inspect <server-id>");
  console.log("/mcp test <server-id>");
  return true;
}

async function handleRuntimeCommand(parts: string[], agent: CliAgent): Promise<boolean> {
  const subcommand = parts[0] ?? "health";

  if (subcommand === "health") {
    console.log(JSON.stringify(agent.getRuntimeHealth(), null, 2));
    return true;
  }

  if (subcommand === "circuits") {
    console.log(JSON.stringify(agent.getRuntimeCircuits(), null, 2));
    return true;
  }

  if (subcommand === "inspect") {
    console.log(JSON.stringify(agent.inspectRuntimeLayer(parts[1] ?? "provider"), null, 2));
    return true;
  }

  console.log("Usage:");
  console.log("/runtime health");
  console.log("/runtime circuits");
  console.log("/runtime inspect <provider|web|mcp|shell>");
  return true;
}

async function handleDiffCommand(parts: string[], agent: CliAgent): Promise<boolean> {
  const subcommand = parts[0] ?? "last";
  if (subcommand === "last") {
    console.log(JSON.stringify(agent.getLastDiff(), null, 2));
    return true;
  }

  if (subcommand === "file") {
    const filePath = parts.slice(1).join(" ").trim();
    if (!filePath) {
      console.log("Usage: /diff file <path>");
      return true;
    }
    console.log(JSON.stringify(agent.getLastDiff(filePath), null, 2));
    return true;
  }

  console.log(JSON.stringify(agent.getLastDiff(subcommand), null, 2));
  return true;
}

async function handleUndoCommand(parts: string[], agent: CliAgent): Promise<boolean> {
  const changeSetId = parts[0] ?? null;
  console.log(JSON.stringify(await agent.undoChange(changeSetId), null, 2));
  return true;
}

async function handleHistoryCommand(parts: string[], agent: CliAgent): Promise<boolean> {
  const parsed = parseInteractionHistoryArgs(parts, HISTORY_REPL_USAGE, null);
  const report = await agent.browseSessionHistory(parsed.scope, parsed.reference);
  console.log(renderSessionBrowserReport(report, parsed.profile));
  return true;
}

function toStringOption(options: OptionMap, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toNumberOption(options: OptionMap, key: string): number | null {
  const value = toStringOption(options, key);
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toVerifierApprovalSourceOption(
  options: OptionMap,
  key: string,
): "cli" | "workflow_dispatch" | "schedule" | "pull_request" | "automation" | undefined {
  const value = toStringOption(options, key);
  return value === "cli"
    || value === "workflow_dispatch"
    || value === "schedule"
    || value === "pull_request"
    || value === "automation"
    ? value
    : undefined;
}

function toVerifierApprovalModeOption(
  options: OptionMap,
  key: string,
): "explicit_apply" | "workflow_apply" | undefined {
  const value = toStringOption(options, key);
  return value === "explicit_apply" || value === "workflow_apply"
    ? value
    : undefined;
}

function isFlagEnabled(options: OptionMap, key: string): boolean {
  return options[key] === true;
}

function toPermissionMode(value: string | undefined): ResolvedConfig["permissionMode"] | undefined {
  return value === "read-only" || value === "workspace-write" || value === "full-access"
    ? value
    : undefined;
}

function toApprovalPolicy(value: string | undefined): ResolvedConfig["approvalPolicy"] | undefined {
  return value === "always" || value === "on-write" || value === "never"
    ? value
    : undefined;
}

function toNetworkMode(value: string | undefined): ResolvedConfig["networkMode"] | undefined {
  return value === "off" || value === "docs-only" || value === "open-web"
    ? value
    : undefined;
}

function toWebProvider(value: string | undefined): ResolvedConfig["webProvider"] | undefined {
  return value === "fallback" || value === "brave"
    ? value
    : undefined;
}

function toWebRankingMode(
  value: string | undefined,
): "balanced" | "docs-first" | "official-first" | undefined {
  return value === "balanced" || value === "docs-first" || value === "official-first"
    ? value
    : undefined;
}
