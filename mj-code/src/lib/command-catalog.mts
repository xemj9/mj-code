import { getAgentBrandProfile } from "./agent-branding.mjs";

import type {
  CommandDefinition,
  CommandSection,
  CommandSurface,
  InteractiveCommandPaletteCategory,
  InteractiveCommandPaletteEntry,
  InteractiveSelectionPreview,
  InteractiveCommandPaletteReport,
  InteractiveCommandPaletteSection,
} from "../types/contracts.js";

const COMMAND_GROUPS: { cli: CommandSurface; repl: CommandSurface } = {
  cli: {
    core: [
      ["node src/cli.mjs status [json|summary]", "Show a bounded session, token, context, and runtime status summary"],
      ["node src/cli.mjs about [json|summary]", "Show MJ Code attribution and edition identity"],
      ['node src/cli.mjs run "prompt"', "Run the main coding loop for one task"],
      ["node src/cli.mjs sessions", "List resumable sessions with branch metadata"],
      ['node src/cli.mjs resume "<id>"', "Resume a prior session as a child branch"],
      ["node src/cli.mjs resume recommend [current|latest|<session-id>] [json|summary|failures]", "Recommend the best session to continue, with lineage-aware reasons and blockers"],
      ["node src/cli.mjs resume lineage [current|latest|<session-id>] [json|summary|failures]", "Inspect the focused session lineage before deciding whether to resume it"],
      ['node src/cli.mjs replay "<id>"', "Replay a past session"],
      ["node src/cli.mjs history [all|changes|sessions|lineage|replay] [current|latest|<session-id>] [json|summary|failures]", "Browse session continuity, lineage, replay state, and recent changes"],
      ["node src/cli.mjs continue [current|latest|<session-id>] [json|summary|failures]", "Open the highest-value continue path across current, recommended, replay, and lineage continuity"],
      ["node src/cli.mjs jobs", "List tracked shell jobs"],
      ['node src/cli.mjs tail "<id>"', "Read job output or resume from cursors"],
      ['node src/cli.mjs attach "<id>"', "Inspect attach mode and tail a live job"],
      ['node src/cli.mjs cancel "<id>"', "Cancel a running job"],
    ],
    advanced: [
      ['node src/cli.mjs route [task|last]', "Inspect or preview task routing"],
      ['node src/cli.mjs plan [task|last|current [json|summary|failures]|timeline [current|trace|replay:<id>|latest] [json|summary|failures]]', "Inspect the current plan state, replayable plan timeline, or preview a task plan"],
      ["node src/cli.mjs why [overview|route|model|tool|plan|verifier] [current|trace|replay:<id>|latest] [json|summary|failures]", "Explain the current decision state, why the loop chose it, and where it is blocked or degraded"],
      ["node src/cli.mjs next [current|trace|replay:<id>|latest] [json|summary|failures]", "Show the most grounded next-step guidance from the current decision state"],
      ["node src/cli.mjs recover [current|trace|replay:<id>|latest] [json|summary|failures]", "Show bounded recovery guidance for the current blocking or degraded state"],
      ["node src/cli.mjs eval [suite] [--baseline baseline:<name>] [--baseline-target <ref>] [--policy <profile>] [--write-artifact] [--write-bundle]", "Run the local regression harness with optional baseline gating, policy profiles, durable artifacts, and CI-friendly bundles"],
      ['node src/cli.mjs search "query"', "Search the web"],
      ['node src/cli.mjs fetch "<url>"', "Fetch a URL with policy checks"],
      ['node src/cli.mjs extract "<url>"', "Fetch and extract readable content"],
      ["node src/cli.mjs sources", "Inspect recent source registry entries"],
      ["node src/cli.mjs mcp servers", "List configured MCP servers"],
      ["node src/cli.mjs mcp tools", "List discovered MCP tools"],
      ["node src/cli.mjs skills", "List loaded skills"],
      ["node src/cli.mjs plugins", "List loaded plugins"],
    ],
    debug: [
      ['node src/cli.mjs verifier [trace|replay "<id>"] [json|summary|failures|repair|context]', "Inspect verifier and repair reports with optional render profiles"],
      ['node src/cli.mjs verifier export [current|trace|replay "<id>"] [json|summary]', "Export a managed verifier snapshot"],
      ["node src/cli.mjs verifier exports [json|summary]", "List exported verifier snapshots"],
      ['node src/cli.mjs verifier baseline pin <current|trace|replay:<id>|snapshot:<id>> <name> [json|summary] [--policy <profile>]', "Pin or promote a durable verifier baseline alias with auditable history"],
      ["node src/cli.mjs verifier baselines [json|summary]", "List pinned verifier baselines"],
      ['node src/cli.mjs verifier promotion plan <baseline-name> [latest|<artifact-id>] [json|summary|failures] [--policy <profile>]', "Plan a policy-aware baseline promotion from a gate or baseline-aware eval artifact without auto-applying it"],
      ['node src/cli.mjs verifier promotion approve <plan-id> [json|summary|failures] [--approver-id <id>] [--approver-name <name>] [--approval-source <source>] [--approval-mode <mode>]', "Explicitly approve and apply a planned baseline promotion with auditable governance metadata"],
      ['node src/cli.mjs verifier promotion history <baseline-name> [json|summary]', "Inspect auditable baseline promotion history for one baseline alias"],
      ["node src/cli.mjs verifier policies [json|summary]", "List named verifier gate policy profiles"],
      ['node src/cli.mjs verifier compare <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> [json|summary|failures] [--write-artifact] [--write-bundle]', "Compare two verifier continuity references and optionally persist a compare artifact plus CI-friendly bundle"],
      ['node src/cli.mjs verifier gate <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> [json|summary|failures] [--policy <profile>] [--write-artifact] [--write-bundle]', "Evaluate the typed verifier regression gate between two references with release-friendly policy profiles and optional artifacts/bundles"],
      ["node src/cli.mjs verifier artifacts [json|summary]", "List durable verifier compare/gate/eval artifacts"],
      ['node src/cli.mjs verifier artifacts prune [json|summary] [--dry-run] [--max-count <n>] [--max-age-days <n>]', "Preview or prune managed verifier artifacts, handoffs, and bundles with a conservative retention policy"],
      ['node src/cli.mjs verifier artifact <id> [json|summary|failures]', "Inspect one durable verifier artifact"],
      ['node src/cli.mjs verifier handoff [<artifact-id>|latest] [json|summary|failures]', "Inspect the typed release handoff derived from a verifier artifact or the latest managed continuity state"],
      ['node src/cli.mjs verifier handoff export [<artifact-id>|latest] [json|summary]', "Export a CI-friendly verifier bundle containing the handoff summary plus related artifacts"],
      ['node src/cli.mjs verifier triage summary [<artifact-id>|latest] [json|summary|failures] [--github-actions]', "Summarize CI/release failure triage, promotion eligibility, and artifact continuity from the latest handoff"],
      ['node src/cli.mjs verifier drilldown [<reference>|latest] [json|summary|failures] [--github-actions]', "Show one bounded operator-friendly drill-down across verifier, triage, handoff, artifacts, bundle, and GitHub mutation continuity"],
      ['node src/cli.mjs verifier timeline [<reference>|latest] [json|summary|failures] [--github-actions]', "Browse one bounded continuity timeline across verifier runs, repair loops, artifacts, handoffs, bundles, promotion, and GitHub mutation state"],
      ['node src/cli.mjs verifier checks summary [<artifact-id>|latest] [json|summary] [--github-actions]', "Inspect the GitHub checks and annotation payload without mutating GitHub state"],
      ['node src/cli.mjs verifier checks export [<artifact-id>|latest] [json|summary] [--github-actions]', "Export a GitHub checks and annotation friendly payload from typed verifier continuity state"],
      ['node src/cli.mjs verifier github apply [<artifact-id>|latest] [json|summary|failures] [--github-actions]', "Optionally create or update a GitHub check run from the typed verifier checks payload, with safe fallback when repository, sha, token, or permission state is unavailable"],
      ['node src/cli.mjs verifier github result [<mutation-id>|latest] [json|summary|failures]', "Inspect the latest durable GitHub mutation attempt and its live/fallback result"],
      ["node src/cli.mjs model", "Show the latest model routing decision"],
      ["node src/cli.mjs provider", "Show provider selection and provider health"],
      ["node src/cli.mjs runtime health", "Show runtime scorecard and health"],
      ["node src/cli.mjs runtime circuits", "Show provider/web/MCP circuit states"],
      ["node src/cli.mjs runtime inspect <layer>", "Inspect one runtime layer"],
      ["node src/cli.mjs tools", "Show the callable tool surface"],
      ["node src/cli.mjs capabilities", "Show the unified capability surface"],
      ["node src/cli.mjs memory", "Show memory snapshot"],
      ["node src/cli.mjs config", "Show resolved config"],
      ["node src/cli.mjs models", "List models from the active provider"],
      ["node src/cli.mjs shell-history", "Inspect historical shell jobs"],
    ],
  },
  repl: {
    core: [
      ["/", "Open the slash command palette"],
      ["/help", "Show the core command surface"],
      ["/about", "Show MJ Code attribution and edition identity"],
      ["/status [json|summary]", "Show session, token, context, plan, and runtime status"],
      ["/diff", "Inspect the last diff preview"],
      ["/undo", "Roll back the latest or named change-set"],
      ["/history [all|changes|sessions|lineage|replay] [current|latest|<session-id>] [json|summary|failures]", "Browse session continuity, lineage, replay state, and recent changes"],
      ["/continue [current|latest|<session-id>] [json|summary|failures]", "Open the default continue browser instead of picking resume vs history first"],
      ["/jobs", "Inspect tracked shell jobs"],
      ["/tail <job-id>", "Read shell job output"],
      ["/attach <job-id>", "Inspect attach mode and live tail surface"],
      ["/cancel <job-id>", "Cancel a running shell job"],
      ["/resume <session-id>", "Resume a prior session"],
      ["/resume recommend [current|latest|<session-id>] [json|summary|failures]", "Recommend the best session to continue from the current continuity view"],
      ["/resume lineage [current|latest|<session-id>] [json|summary|failures]", "Inspect one session lineage before resuming it"],
      ["/replay <session-id>", "Replay a prior session"],
      ["/clear", "Clear conversation history"],
      ["/effort <low|medium|high|max>", "Set the reasoning effort level (low=concise, medium=balanced, high=thorough, max=deepest)"],
      ["/compact", "Compress conversation context into a rolling summary"],
      ["/memory", "View stored memories and project facts"],
      ["/cost", "Show token usage and cost summary"],
      ["/exit", "Exit MJ Code"],
    ],
    advanced: [
      ["/help advanced", "Show optional advanced commands"],
      ["/route [task|last]", "Inspect or preview routing decisions"],
      ["/plan [task|last|current [json|summary|failures]|timeline [current|trace|replay:<id>|latest] [json|summary|failures]]", "Inspect the current plan state, replayable plan timeline, or preview a task plan"],
      ["/why [overview|route|model|tool|plan|verifier] [current|trace|replay:<id>|latest] [json|summary|failures]", "Explain the current decision state, why the loop chose it, and where it is blocked or degraded"],
      ["/next [current|trace|replay:<id>|latest] [json|summary|failures]", "Show the most grounded next-step guidance from the current decision state"],
      ["/recover [current|trace|replay:<id>|latest] [json|summary|failures]", "Show bounded recovery guidance for the current blocking or degraded state"],
      ["/eval [suite] [--baseline baseline:<name>] [--baseline-target <ref>] [--policy <profile>] [--write-artifact] [--write-bundle]", "Run the local regression harness with optional baseline gating, policy profiles, durable artifacts, and CI-friendly bundles"],
      ["/search <query>", "Search the web"],
      ["/fetch <url>", "Fetch a URL with policy checks"],
      ["/extract <url>", "Fetch and extract readable content"],
      ["/sources", "Inspect the source registry"],
      ["/mcp", "Inspect MCP servers and tools"],
      ["/skills", "Inspect loaded skills"],
      ["/plugins", "Inspect loaded plugins"],
      ["/memory", "Inspect or update memory"],
    ],
    debug: [
      ["/help debug", "Show debug and internal inspection commands"],
      ["/runtime", "Inspect runtime health and circuit state"],
      ["/trace", "Inspect trace and journal data"],
      ["/verifier [trace|replay <id>] [json|summary|failures|repair|context]", "Inspect verifier and repair reports with optional render profiles"],
      ["/verifier export [current|trace|replay <id>] [json|summary]", "Export a managed verifier snapshot"],
      ["/verifier exports [json|summary]", "List exported verifier snapshots"],
      ["/verifier baseline pin <current|trace|replay:<id>|snapshot:<id>> <name> [json|summary] [--policy <profile>]", "Pin or promote a durable verifier baseline alias with auditable history"],
      ["/verifier baselines [json|summary]", "List pinned verifier baselines"],
      ["/verifier promotion plan <baseline-name> [latest|<artifact-id>] [json|summary|failures] [--policy <profile>]", "Plan a policy-aware baseline promotion from a gate or baseline-aware eval artifact without auto-applying it"],
      ["/verifier promotion approve <plan-id> [json|summary|failures] [--approver-id <id>] [--approver-name <name>] [--approval-source <source>] [--approval-mode <mode>]", "Explicitly approve and apply a planned baseline promotion with auditable governance metadata"],
      ["/verifier promotion history <baseline-name> [json|summary]", "Inspect auditable baseline promotion history for one baseline alias"],
      ["/verifier policies [json|summary]", "List named verifier gate policy profiles"],
      ["/verifier compare <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> [json|summary|failures] [--write-artifact] [--write-bundle]", "Compare two verifier continuity references and optionally persist a compare artifact plus CI-friendly bundle"],
      ["/verifier gate <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> <current|trace|replay:<id>|snapshot:<id>|baseline:<name>> [json|summary|failures] [--policy <profile>] [--write-artifact] [--write-bundle]", "Evaluate the typed verifier regression gate between two references with release-friendly policy profiles and optional artifacts/bundles"],
      ["/verifier artifacts [json|summary]", "List durable verifier compare/gate/eval artifacts"],
      ["/verifier artifacts prune [json|summary] [--dry-run] [--max-count <n>] [--max-age-days <n>]", "Preview or prune managed verifier artifacts, handoffs, and bundles with a conservative retention policy"],
      ["/verifier artifact <id> [json|summary|failures]", "Inspect one durable verifier artifact"],
      ["/verifier handoff [<artifact-id>|latest] [json|summary|failures]", "Inspect the typed release handoff derived from a verifier artifact or the latest managed continuity state"],
      ["/verifier handoff export [<artifact-id>|latest] [json|summary]", "Export a CI-friendly verifier bundle containing the handoff summary plus related artifacts"],
      ["/verifier triage summary [<artifact-id>|latest] [json|summary|failures] [--github-actions]", "Summarize CI/release failure triage, promotion eligibility, and artifact continuity from the latest handoff"],
      ["/verifier drilldown [<reference>|latest] [json|summary|failures] [--github-actions]", "Show one bounded operator-friendly drill-down across verifier, triage, handoff, artifacts, bundle, and GitHub mutation continuity"],
      ["/verifier timeline [<reference>|latest] [json|summary|failures] [--github-actions]", "Browse one bounded continuity timeline across verifier runs, repair loops, artifacts, handoffs, bundles, promotion, and GitHub mutation state"],
      ["/verifier checks summary [<artifact-id>|latest] [json|summary] [--github-actions]", "Inspect the GitHub checks and annotation payload without mutating GitHub state"],
      ["/verifier checks export [<artifact-id>|latest] [json|summary] [--github-actions]", "Export a GitHub checks and annotation friendly payload from typed verifier continuity state"],
      ["/verifier github apply [<artifact-id>|latest] [json|summary|failures] [--github-actions]", "Optionally create or update a GitHub check run from the typed verifier checks payload, with safe fallback when repository, sha, token, or permission state is unavailable"],
      ["/verifier github result [<mutation-id>|latest] [json|summary|failures]", "Inspect the latest durable GitHub mutation attempt and its live/fallback result"],
      ["/approve-mode", "Inspect approval and risk settings"],
      ["/tools", "Show tool list"],
      ["/capabilities", "Show capability surface"],
      ["/model", "Show the latest model routing decision"],
      ["/provider", "Show provider selection and health"],
      ["/models", "List provider models"],
      ["/config", "Show resolved config"],
      ["/cost", "Show token usage and latest context plan"],
      ["/shell-history", "Inspect historical shell jobs"],
      ["/session", "Show current session log path"],
      ["/instructions", "Show loaded MJ.md files"],
      ["/network-mode", "Show active network policy"],
    ],
  },
};

const SURFACE_TITLES: Record<CommandSection, string> = {
  core: "Core Workflow",
  advanced: "Advanced Optional",
  debug: "Debug / Internal",
};

interface PaletteSeed {
  command: string;
  label: string;
  description: string;
  category: InteractiveCommandPaletteCategory;
  section: CommandSection;
  featured?: boolean;
  suggested?: boolean;
  keywords?: string[];
}

const PALETTE_CATEGORY_TITLES: Record<InteractiveCommandPaletteCategory, string> = {
  query_matches: "Top Matches",
  core: "Core",
  navigation: "Navigation",
  decision_recovery: "Decision / Recovery",
  session_history_resume: "Session / History / Resume",
  verifier_plan: "Verifier / Plan",
  advanced_debug: "Advanced / Debug",
};

const PALETTE_CHOOSER_ROOTS = new Set<string>([
  "/continue",
  "/resume",
  "/resume recommend",
  "/resume lineage",
  "/history sessions",
  "/history lineage",
  "/history replay",
]);

const PALETTE_INTENT_FAMILIES: Array<{
  queries: string[];
  roots: string[];
  variants: string[];
}> = [
  {
    queries: ["con", "cont", "continue", "open"],
    roots: ["/continue", "/resume", "/history sessions"],
    variants: ["/continue current summary", "/resume recommend current summary", "/history sessions summary"],
  },
  {
    queries: ["res", "resume"],
    roots: ["/resume", "/resume recommend", "/resume lineage"],
    variants: ["/resume recommend current summary", "/resume lineage current summary"],
  },
  {
    queries: ["hist", "history"],
    roots: ["/history sessions", "/history replay", "/history lineage"],
    variants: [
      "/history sessions summary",
      "/history replay latest summary",
      "/history lineage current summary",
    ],
  },
  {
    queries: ["lin", "line", "lineage"],
    roots: ["/history lineage", "/resume lineage"],
    variants: ["/history lineage current summary", "/resume lineage current summary"],
  },
  {
    queries: ["rep", "repl", "replay"],
    roots: ["/history replay"],
    variants: [
      "/history replay latest summary",
      "/history sessions",
      "/history lineage",
      "/resume recommend current summary",
    ],
  },
  {
    queries: ["why"],
    roots: ["/why overview current summary", "/why plan current summary"],
    variants: ["/next current summary", "/plan current summary", "/recover current summary"],
  },
  {
    queries: ["sta", "stat", "status"],
    roots: ["/continue", "/status summary"],
    variants: ["/next current summary", "/history sessions summary"],
  },
  {
    queries: ["pla", "plan"],
    roots: ["/plan current summary", "/plan timeline current summary"],
    variants: ["/next current summary", "/why plan current summary"],
  },
  {
    queries: ["mod", "mode", "model"],
    roots: ["/model", "/models", "/provider"],
    variants: ["/route last", "/config"],
  },
];

const REPL_PALETTE_ENTRIES: PaletteSeed[] = [
  {
    command: "/status summary",
    label: "/status",
    description: "Show session, token, context, plan, and runtime state first.",
    category: "core",
    section: "core",
    featured: true,
    suggested: true,
    keywords: ["status", "tokens", "context", "runtime"],
  },
  {
    command: "/about",
    label: "/about",
    description: "Show MJ Code identity, edition, and attribution details.",
    category: "core",
    section: "core",
    featured: true,
    keywords: ["brand", "identity", "designer"],
  },
  {
    command: "/diff",
    label: "/diff",
    description: "Inspect the latest diff preview before approving or reverting.",
    category: "core",
    section: "core",
    keywords: ["change", "patch", "preview"],
  },
  {
    command: "/undo",
    label: "/undo",
    description: "Roll back the latest or a named change-set.",
    category: "core",
    section: "core",
    keywords: ["rollback", "revert"],
  },
  {
    command: "/clear",
    label: "/clear",
    description: "Clear the current conversation state without leaving the session.",
    category: "core",
    section: "core",
    keywords: ["reset", "conversation"],
  },
  {
    command: "/exit",
    label: "/exit",
    description: "Exit the current MJ Code REPL session.",
    category: "core",
    section: "core",
    keywords: ["quit", "leave"],
  },
  {
    command: "/help",
    label: "/help",
    description: "Show the core slash command surface.",
    category: "navigation",
    section: "core",
    featured: true,
    keywords: ["commands", "discover"],
  },
  {
    command: "/help advanced",
    label: "/help advanced",
    description: "Inspect advanced commands after the core path is clear.",
    category: "navigation",
    section: "advanced",
    keywords: ["advanced", "optional"],
  },
  {
    command: "/help debug",
    label: "/help debug",
    description: "Inspect debug and internal inspection commands.",
    category: "navigation",
    section: "debug",
    keywords: ["debug", "internal"],
  },
  {
    command: "/session",
    label: "/session",
    description: "Show the current session file path and anchor yourself quickly.",
    category: "navigation",
    section: "debug",
    keywords: ["session", "path", "current"],
  },
  {
    command: "/why overview current summary",
    label: "/why overview",
    description: "Explain why the current loop is in its present state.",
    category: "decision_recovery",
    section: "advanced",
    featured: true,
    suggested: true,
    keywords: ["why", "overview", "decision"],
  },
  {
    command: "/why plan current summary",
    label: "/why plan",
    description: "Explain the current blocker, replan reason, or stop condition.",
    category: "decision_recovery",
    section: "advanced",
    featured: true,
    keywords: ["plan", "blocker", "replan"],
  },
  {
    command: "/next current summary",
    label: "/next",
    description: "Show the most grounded next-step guidance from current state.",
    category: "decision_recovery",
    section: "advanced",
    featured: true,
    suggested: true,
    keywords: ["next", "guidance", "continue"],
  },
  {
    command: "/recover current summary",
    label: "/recover",
    description: "Show bounded recovery guidance for the active blocker or failure.",
    category: "decision_recovery",
    section: "advanced",
    featured: true,
    suggested: true,
    keywords: ["recovery", "failure", "blocked"],
  },
  {
    command: "/continue",
    label: "/continue",
    description: "Open the default continue browser across current, recommended, replay, and lineage paths.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    suggested: true,
    keywords: ["continue", "open", "recommended", "session", "next"],
  },
  {
    command: "/resume",
    label: "/resume",
    description: "Open the resume picker and choose a session target directly.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    suggested: true,
    keywords: ["resume", "picker", "session", "continue"],
  },
  {
    command: "/history sessions",
    label: "/history sessions",
    description: "Open the session browser picker and choose replay, resume, why, or plan actions.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    suggested: true,
    keywords: ["history", "sessions", "picker", "browser", "continue", "open"],
  },
  {
    command: "/history sessions summary",
    label: "/history sessions summary",
    description: "Inspect the ranked continuity card directly from the current focus.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    keywords: ["history", "sessions", "recent"],
  },
  {
    command: "/history lineage",
    label: "/history lineage",
    description: "Open the lineage picker and jump to a session-specific lineage view.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    keywords: ["history", "lineage", "picker", "branch"],
  },
  {
    command: "/history lineage current summary",
    label: "/history lineage current",
    description: "See the current session lineage before replaying or resuming.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    suggested: true,
    keywords: ["lineage", "branch", "parent", "child"],
  },
  {
    command: "/history replay",
    label: "/history replay",
    description: "Open the replay chooser and jump to a session-specific replay view.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    keywords: ["history", "replay", "picker", "chooser"],
  },
  {
    command: "/history replay latest summary",
    label: "/history replay latest",
    description: "Inspect recent replay continuity, plan, and verifier availability.",
    category: "session_history_resume",
    section: "core",
    keywords: ["replay", "continuity", "latest"],
  },
  {
    command: "/resume recommend",
    label: "/resume recommend",
    description: "Open the recommendation picker and choose between direct resume or inspect-reason actions.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    keywords: ["resume", "recommend", "picker"],
  },
  {
    command: "/resume recommend current summary",
    label: "/resume recommend summary",
    description: "Recommend which session should be resumed and explain why.",
    category: "session_history_resume",
    section: "core",
    featured: true,
    suggested: true,
    keywords: ["resume", "recommend", "continue"],
  },
  {
    command: "/resume lineage",
    label: "/resume lineage",
    description: "Open the lineage picker before creating a new resume branch.",
    category: "session_history_resume",
    section: "core",
    keywords: ["resume", "lineage", "picker"],
  },
  {
    command: "/resume lineage current summary",
    label: "/resume lineage summary",
    description: "Inspect the focused lineage before creating a child branch.",
    category: "session_history_resume",
    section: "core",
    keywords: ["resume", "lineage", "branch"],
  },
  {
    command: "/plan current summary",
    label: "/plan current",
    description: "Inspect the current goal, step, blockers, and verification bias.",
    category: "verifier_plan",
    section: "advanced",
    featured: true,
    keywords: ["plan", "current", "goal"],
  },
  {
    command: "/plan timeline current summary",
    label: "/plan timeline",
    description: "Browse recent plan events and see where the problem was introduced.",
    category: "verifier_plan",
    section: "advanced",
    featured: true,
    keywords: ["timeline", "events", "plan"],
  },
  {
    command: "/verifier summary",
    label: "/verifier",
    description: "Inspect recent verifier and repair continuity for the current session.",
    category: "verifier_plan",
    section: "debug",
    keywords: ["verifier", "repair", "gate"],
  },
  {
    command: "/verifier drilldown latest summary",
    label: "/verifier drilldown",
    description: "Open the operator-friendly verifier failure drill-down surface.",
    category: "verifier_plan",
    section: "debug",
    keywords: ["drilldown", "triage", "handoff"],
  },
  {
    command: "/runtime",
    label: "/runtime",
    description: "Inspect runtime health, degraded layers, and circuit state.",
    category: "advanced_debug",
    section: "debug",
    keywords: ["runtime", "health", "circuit"],
  },
  {
    command: "/model",
    label: "/model",
    description: "Inspect the latest model routing decision.",
    category: "advanced_debug",
    section: "debug",
    keywords: ["model", "routing"],
  },
  {
    command: "/provider",
    label: "/provider",
    description: "Inspect provider selection, fallback, and health information.",
    category: "advanced_debug",
    section: "debug",
    keywords: ["provider", "health", "fallback", "model", "routing"],
  },
  {
    command: "/jobs",
    label: "/jobs",
    description: "Inspect tracked background shell jobs and attach points.",
    category: "advanced_debug",
    section: "core",
    keywords: ["jobs", "shell", "attach"],
  },
  {
    command: "/effort max",
    label: "/effort max",
    description: "Set reasoning effort to MAX — deepest analysis, exhaustive reasoning, maximum capability.",
    category: "core",
    section: "core",
    featured: true,
    keywords: ["effort", "max", "deep", "reasoning", "quality"],
  },
  {
    command: "/effort high",
    label: "/effort high",
    description: "Set reasoning effort to HIGH — thorough, detailed responses with careful verification.",
    category: "core",
    section: "core",
    featured: true,
    keywords: ["effort", "high", "thorough", "detailed"],
  },
  {
    command: "/effort medium",
    label: "/effort medium",
    description: "Set reasoning effort to MEDIUM — balanced responses with moderate detail.",
    category: "core",
    section: "core",
    keywords: ["effort", "medium", "balanced"],
  },
  {
    command: "/effort low",
    label: "/effort low",
    description: "Set reasoning effort to LOW — quick, concise answers. Minimal exploration.",
    category: "core",
    section: "core",
    keywords: ["effort", "low", "quick", "concise"],
  },
  {
    command: "/compact",
    label: "/compact",
    description: "Compress conversation context into a rolling summary to free up context window.",
    category: "core",
    section: "core",
    featured: true,
    keywords: ["compact", "compress", "context", "memory"],
  },
  {
    command: "/cost",
    label: "/cost",
    description: "Show token usage and cost summary for the current session.",
    category: "core",
    section: "core",
    keywords: ["cost", "tokens", "usage", "billing"],
  },
  {
    command: "/memory",
    label: "/memory",
    description: "View stored memories — facts, preferences, project conventions, and failure learnings.",
    category: "core",
    section: "core",
    keywords: ["memory", "recall", "facts", "preferences"],
  },
  {
    command: "/memory search",
    label: "/memory search",
    description: "Search stored memories by query to find prior context and learnings.",
    category: "core",
    section: "core",
    keywords: ["memory", "search", "recall"],
  },
];

export function getCommandGroups(surface: "cli" | "repl" = "repl"): CommandSurface {
  return COMMAND_GROUPS[surface] ?? COMMAND_GROUPS.repl;
}

export function formatCommandHelp(surface: "cli" | "repl" = "repl", section: string = "core"): string {
  const resolvedSection = normalizeSection(section);
  const groups = getCommandGroups(surface);
  const visibleCommands: CommandDefinition[] = groups[resolvedSection];
  const header = surface === "cli" ? "MJ Code CLI" : "MJ Code REPL";
  const intro = surface === "cli"
    ? "Default help only shows the terminal-coding core path. Use `node src/cli.mjs help advanced` or `node src/cli.mjs help debug` for deeper surfaces."
    : "Default help only shows the terminal-coding core path. Use `/help advanced` or `/help debug` for deeper surfaces.";

  return [
    header,
    "",
    intro,
    "",
    `${SURFACE_TITLES[resolvedSection]}:`,
    ...visibleCommands.map(([usage, description]) => `  ${usage.padEnd(32)} ${description}`),
  ].join("\n");
}

export function getBannerCommands() {
  return {
    core: ["/", "/help", "/about", "/status", "/continue", "/history", "/resume", "/jobs", "/clear", "/effort", "/exit"],
    more: ["/help advanced", "/help debug", "/next", "/recover"],
  };
}

export function normalizeSection(section?: string): CommandSection {
  const normalized = `${section ?? ""}`.trim().toLowerCase();
  return normalized === "advanced" || normalized === "debug"
    ? normalized
    : "core";
}

export function getInteractiveCommandPalette(query: string | null = null): InteractiveCommandPaletteReport {
  const normalizedQuery = `${query ?? ""}`.trim().toLowerCase();
  const sections = normalizedQuery
    ? buildQueryPaletteSections(normalizedQuery)
    : (
      [
        "core",
        "navigation",
        "decision_recovery",
        "session_history_resume",
        "verifier_plan",
        "advanced_debug",
      ] as const
    )
      .map((category) => createPaletteSection(category))
      .filter((section) => section.entries.length > 0);
  const selectedCommand = normalizedQuery
    ? sections[0]?.entries[0]?.command ?? null
    : resolvePaletteDefaultCommand(sections);
  const selectedPreview = resolvePalettePreview(sections, selectedCommand)
    ?? buildUnavailablePalettePreview(normalizedQuery);
  return {
    query: normalizedQuery || null,
    brand: getAgentBrandProfile(),
    sections,
    totalMatches: sections.reduce((count, section) => count + section.entries.length, 0),
    selectedCommand,
    selectedPreview,
    fallbackMode: "text",
    footerHints: [
      "TTY mode: type `/`, keep typing to filter, use ↑↓ to select, Tab/→ to jump sections, Enter to run, Esc to close.",
      "Pipe/non-TTY mode falls back to this one-shot text palette.",
      "Use `/help advanced` or `/help debug` for the wider surface after the core path.",
    ],
  };
}

function resolvePaletteDefaultCommand(
  sections: InteractiveCommandPaletteSection[],
): string | null {
  const entries = sections.flatMap((section) => section.entries);
  return entries.find((entry) => entry.command === "/continue")?.command
    ?? entries[0]?.command
    ?? null;
}

function createPaletteSection(
  category: InteractiveCommandPaletteCategory,
): InteractiveCommandPaletteSection {
  const entries = REPL_PALETTE_ENTRIES
    .filter((entry) => entry.category === category)
    .map((entry) => createPaletteEntry(entry))
    .sort(compareDefaultPaletteEntries)
    .slice(0, category === "core" || category === "session_history_resume" ? 4 : 3);
  return {
    category,
    title: PALETTE_CATEGORY_TITLES[category],
    entries,
  };
}

function buildQueryPaletteSections(query: string): InteractiveCommandPaletteSection[] {
  const entries = REPL_PALETTE_ENTRIES
    .map((entry) => createPaletteEntry(entry))
    .map((entry) => ({
      entry,
      score: scorePaletteEntry(entry, query),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score
      || compareDefaultPaletteEntries(left.entry, right.entry))
    .map(({ entry }) => entry)
    .slice(0, 8);

  return entries.length > 0
    ? [{
      category: "query_matches",
      title: PALETTE_CATEGORY_TITLES.query_matches,
      entries,
    }]
    : [];
}

function createPaletteEntry(seed: PaletteSeed): InteractiveCommandPaletteEntry {
  return {
    command: seed.command,
    label: seed.label,
    description: seed.description,
    category: seed.category,
    section: seed.section,
    featured: seed.featured === true,
    suggested: seed.suggested === true,
    keywords: seed.keywords ?? [],
    preview: buildPaletteEntryPreview({
      command: seed.command,
      label: seed.label,
      description: seed.description,
      category: seed.category,
      section: seed.section,
      featured: seed.featured === true,
      suggested: seed.suggested === true,
    }),
  };
}

function compareDefaultPaletteEntries(
  left: InteractiveCommandPaletteEntry,
  right: InteractiveCommandPaletteEntry,
): number {
  const defaultPriority = (entry: InteractiveCommandPaletteEntry) => {
    if (entry.command === "/continue") {
      return 3;
    }
    if (entry.command === "/status summary") {
      return 2;
    }
    if (entry.command === "/history sessions") {
      return 1;
    }
    return 0;
  };
  return defaultPriority(right) - defaultPriority(left)
    || Number(right.suggested) - Number(left.suggested)
    || Number(right.featured) - Number(left.featured)
    || left.label.localeCompare(right.label);
}

function scorePaletteEntry(
  entry: InteractiveCommandPaletteEntry,
  query: string,
): number {
  if (!query) {
    return 0;
  }
  const lowerQuery = query.toLowerCase().trim();
  const values = [
    { value: entry.command, weight: 260 },
    { value: entry.label, weight: 240 },
    ...entry.keywords.map((value) => ({ value, weight: 180 })),
    { value: entry.description, weight: 90 },
    { value: entry.category, weight: 30 },
    { value: entry.section, weight: 20 },
  ];
  const bestFieldScore = values.reduce((best, candidate) =>
    Math.max(best, scorePaletteField(lowerQuery, candidate.value, candidate.weight)), 0);
  if (bestFieldScore === 0) {
    return 0;
  }
  const queryPrefersChooser = !lowerQuery.includes("summary") && !lowerQuery.includes("json");
  const chooserBoost = queryPrefersChooser && PALETTE_CHOOSER_ROOTS.has(entry.command) ? 42 : 0;
  const summaryPenalty = queryPrefersChooser && isPaletteSummaryCommand(entry.command) ? 18 : 0;
  const intentFamily = resolvePaletteIntentFamily(lowerQuery);
  const intentBoost = intentFamily
    ? scorePaletteIntentMatch(intentFamily, entry.command)
    : 0;
  const intentPenalty = intentFamily && intentBoost === 0 && bestFieldScore < 1500
    ? 240
    : 0;
  const lowIntentPenalty = scorePaletteLowIntentPenalty(lowerQuery, entry.command, bestFieldScore);
  const querySpecificPenalty = scorePaletteQuerySpecificPenalty(lowerQuery, entry.command);
  return bestFieldScore
    + intentBoost
    + chooserBoost
    - intentPenalty
    - lowIntentPenalty
    - querySpecificPenalty
    - summaryPenalty
    + (entry.suggested ? 26 : 0)
    + (entry.featured ? 14 : 0);
}

function scorePaletteField(query: string, value: string, weight: number): number {
  const normalized = normalizePaletteValue(value);
  if (!normalized) {
    return 0;
  }
  if (normalized === `/${query}` || normalized === query) {
    return 2000 + weight;
  }
  if (normalized.startsWith(`/${query}`) || normalized.startsWith(query)) {
    return 1700 + weight - Math.max(0, normalized.length - query.length);
  }
  const tokens = tokenizePaletteValue(normalized);
  const exactTokenIndex = tokens.findIndex((token) => token === query);
  if (exactTokenIndex >= 0) {
    return 1480 + weight - (exactTokenIndex * 8);
  }
  const prefixTokenIndex = tokens.findIndex((token) => token.startsWith(query));
  if (prefixTokenIndex >= 0) {
    return 1320 + weight - (prefixTokenIndex * 8) - Math.max(0, tokens[prefixTokenIndex].length - query.length);
  }
  const boundaryIndex = findPaletteBoundaryMatchIndex(normalized, query);
  if (boundaryIndex >= 0) {
    return 980 + weight - boundaryIndex;
  }
  const substringIndex = normalized.indexOf(query);
  if (substringIndex >= 0) {
    return 760 + weight - substringIndex;
  }
  const fuzzyScore = fuzzyPaletteScore(query, normalized);
  return fuzzyScore > 0 ? fuzzyScore + weight : 0;
}

function fuzzyPaletteScore(query: string, value: string): number {
  if (!query) {
    return 0;
  }
  const spacedQuery = query.replace(/\s+/g, " ");
  if (value.includes(spacedQuery)) {
    return 480 - Math.max(0, value.indexOf(spacedQuery));
  }
  let lastIndex = -1;
  let score = 0;
  for (const char of query.replace(/\s+/g, "")) {
    const nextIndex = value.indexOf(char, lastIndex + 1);
    if (nextIndex < 0) {
      return 0;
    }
    score += nextIndex === lastIndex + 1 ? 18 : 7;
    if (nextIndex === 0 || value[nextIndex - 1] === " " || value[nextIndex - 1] === "/") {
      score += 6;
    }
    lastIndex = nextIndex;
  }
  return score;
}

function normalizePaletteValue(value: string): string {
  return `${value ?? ""}`.trim().toLowerCase();
}

function tokenizePaletteValue(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function findPaletteBoundaryMatchIndex(value: string, query: string): number {
  const matches = [
    value.indexOf(`/${query}`),
    value.indexOf(` ${query}`),
    value.indexOf(`-${query}`),
    value.indexOf(`_${query}`),
  ].filter((index) => index >= 0);
  if (matches.length === 0) {
    return -1;
  }
  return Math.min(...matches);
}

function isPaletteSummaryCommand(command: string): boolean {
  return /\s(summary|json|failures)$/.test(command) || command.includes(" current summary") || command.includes(" latest summary");
}

function resolvePaletteIntentFamily(query: string): (typeof PALETTE_INTENT_FAMILIES)[number] | null {
  return PALETTE_INTENT_FAMILIES.find((family) =>
    family.queries.some((candidate) => candidate.startsWith(query) || query.startsWith(candidate)))
    ?? null;
}

function scorePaletteIntentMatch(
  family: (typeof PALETTE_INTENT_FAMILIES)[number],
  command: string,
): number {
  if (family.roots.some((root) => command === root)) {
    return 180;
  }
  if (family.variants.some((root) => command === root)) {
    return 120;
  }
  if (family.roots.some((root) => command.startsWith(root))) {
    return 96;
  }
  if (family.variants.some((root) => command.startsWith(root))) {
    return 64;
  }
  return 0;
}

function scorePaletteLowIntentPenalty(
  query: string,
  command: string,
  bestFieldScore: number,
): number {
  if (bestFieldScore >= 1700) {
    return 0;
  }
  let penalty = 0;
  if (/^\/continue\b/.test(command)) {
    penalty -= 42;
  }
  if (/(^\/help\b|^\/about\b|^\/clear\b|^\/exit\b)/.test(command)) {
    penalty += 110;
  }
  if (/(^\/model\b|^\/provider\b|^\/config\b|^\/memory\b|^\/tools\b|^\/capabilities\b)/.test(command)) {
    penalty += query.length < 4 ? 80 : 36;
  }
  if (/(^\/help debug\b|^\/runtime\b|^\/trace\b|^\/network-mode\b)/.test(command)) {
    penalty += 72;
  }
  if (isPaletteSummaryCommand(command) && query.length <= 4) {
    penalty += 20;
  }
  return penalty;
}

function scorePaletteQuerySpecificPenalty(query: string, command: string): number {
  if (query.startsWith("rep")) {
    if (/^\/why\b/.test(command) || /^\/verifier\b/.test(command)) {
      return 520;
    }
  }
  if (query.startsWith("why")) {
    if (!/^\/why\b/.test(command) && !/^\/next\b/.test(command) && !/^\/recover\b/.test(command) && !/^\/plan\b/.test(command)) {
      return 1600;
    }
  }
  if (query.startsWith("pla")) {
    if (!/^\/plan\b/.test(command) && !/^\/why plan\b/.test(command) && !/^\/next\b/.test(command)) {
      return 620;
    }
  }
  if (query.startsWith("sta")) {
    if (!/^\/status\b/.test(command) && !/^\/continue\b/.test(command) && !/^\/history sessions\b/.test(command)) {
      return 1480;
    }
    if (/^\/continue\b/.test(command)) {
      return -140;
    }
    if (/^\/history sessions summary\b/.test(command)) {
      return 260;
    }
  }
  if (query.startsWith("mod")) {
    if (!/^\/model\b/.test(command) && !/^\/models\b/.test(command) && !/^\/provider\b/.test(command) && !/^\/route\b/.test(command)) {
      return 680;
    }
  }
  if (query.startsWith("con")) {
    if (!/^\/continue\b/.test(command) && !/^\/resume\b/.test(command) && !/^\/history sessions\b/.test(command)) {
      return 1240;
    }
    if (/^\/continue\b/.test(command)) {
      return -220;
    }
    if (/^\/history sessions$/.test(command)) {
      return -160;
    }
    if (/^\/history sessions summary\b/.test(command)) {
      return 320;
    }
    if (/^\/clear\b/.test(command) || /^\/config\b/.test(command)) {
      return 980;
    }
    if (/^\/resume recommend current summary\b/.test(command)) {
      return 920;
    }
    if (/^\/next\b/.test(command) || /^\/status\b/.test(command)) {
      return 420;
    }
    if (isPaletteSummaryCommand(command) && !/^\/continue current summary\b/.test(command)) {
      return 260;
    }
  }
  if (query.startsWith("rep")) {
    if (/^\/resume\b/.test(command) && !/^\/resume recommend\b/.test(command)) {
      return 180;
    }
  }
  if (query.startsWith("lin") && /^\/continue\b/.test(command)) {
    return 80;
  }
  return 0;
}

function resolvePalettePreview(
  sections: InteractiveCommandPaletteSection[],
  selectedCommand: string | null,
): InteractiveSelectionPreview | null {
  if (!selectedCommand) {
    return null;
  }
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.command === selectedCommand) {
        return entry.preview;
      }
    }
  }
  return null;
}

function buildUnavailablePalettePreview(query: string): InteractiveSelectionPreview {
  const looksLikePlainMessage = /[\u3400-\u9fff]/.test(query) || /\s/.test(query);
  return {
    previewKind: "command",
    selectedCommand: null,
    resolvedCommandTemplate: null,
    selectedTargetSummary: looksLikePlainMessage
      ? "No slash command matched this input."
      : "No command matched the current filter.",
    decisionState: "unavailable",
    relationSummary: null,
    availabilitySummary: null,
    continuitySnippet: query ? `filter=/${query}` : "type / to open the palette",
    whySelected: query
      ? looksLikePlainMessage
        ? "This looks more like a normal message than a slash command name."
        : "The current filter did not match any command, session, or keyword."
      : "The palette is ready; move through the highest-value commands first.",
    nextEffect: query
      ? looksLikePlainMessage
        ? "Press Esc, then remove the leading `/` to keep typing a normal message."
        : "Broaden the filter or clear part of the line to restore matches."
      : "Keep typing, then press Enter to inject or run the selected command.",
    available: false,
    unavailableReason: query ? "no_match" : "no_selection",
  };
}

function buildPaletteEntryPreview(input: {
  command: string;
  label: string;
  description: string;
  category: InteractiveCommandPaletteCategory;
  section: CommandSection;
  featured: boolean;
  suggested: boolean;
}): InteractiveSelectionPreview {
  return {
    previewKind: "command",
    selectedCommand: input.command,
    resolvedCommandTemplate: input.command,
    selectedTargetSummary: buildPaletteTargetSummary(input.label, input.description),
    decisionState: input.suggested ? "recommended" : input.featured ? "suggested" : "neutral",
    relationSummary: buildPaletteRelationSummary(input.command),
    availabilitySummary: buildPaletteAvailabilitySummary(input.command),
    continuitySnippet: buildPaletteContinuitySnippet(input.command, input.category, input.section),
    whySelected: buildPaletteWhySelected(input),
    nextEffect: buildPaletteNextEffect(input.command),
    available: true,
    unavailableReason: null,
  };
}

function buildPaletteTargetSummary(label: string, description: string): string {
  return `${label} · ${description}`;
}

function buildPaletteContinuitySnippet(
  command: string,
  category: InteractiveCommandPaletteCategory,
  section: CommandSection,
): string {
  if (command === "/continue") {
    return "continue browser · current first when live · otherwise recommended session with replay/lineage fallback";
  }
  if (command === "/resume") {
    return "resume chooser · recommended target first · lineage-aware session continuity";
  }
  if (command === "/resume recommend") {
    return "recommendation chooser · direct resume or inspect-reason follow-through";
  }
  if (command === "/resume lineage") {
    return "lineage chooser · inspect parent/child continuity before branching";
  }
  if (command === "/history sessions") {
    return "session browser chooser · pick a target first, then choose resume, replay, plan, or why";
  }
  if (command === "/history sessions summary") {
    return "recent sessions · recommended resume target · replay/plan/verifier navigation";
  }
  if (command === "/history lineage") {
    return "lineage chooser · branch ancestry and descendants before replay or resume";
  }
  if (command === "/history replay") {
    return "replay chooser · jump to plan/why/verifier continuity for one session";
  }
  if (command === "/status summary") {
    return "current session · context budget · plan/verifier/runtime control card";
  }
  if (command.startsWith("/why")) {
    return "decision continuity · explain why the loop is here before changing state";
  }
  if (command.startsWith("/plan")) {
    return "plan continuity · blockers, replan history, and verification bias";
  }
  if (command.startsWith("/verifier")) {
    return "verifier continuity · failures, repair loops, and release-facing drilldown";
  }
  return `category=${category} · section=${section}`;
}

function buildPaletteRelationSummary(command: string): string | null {
  if (command === "/continue" || command === "/resume" || command === "/resume recommend" || command === "/resume lineage") {
    return "session continuity";
  }
  if (command === "/history sessions") {
    return "session browser";
  }
  if (command.startsWith("/history")) {
    return "session browser";
  }
  if (command.startsWith("/why") || command.startsWith("/next") || command.startsWith("/recover")) {
    return "decision / recovery";
  }
  if (command.startsWith("/plan") || command.startsWith("/verifier")) {
    return "plan / verifier";
  }
  return "launcher";
}

function buildPaletteAvailabilitySummary(command: string): string | null {
  if (command === "/continue") {
    return "continue browser";
  }
  if (command === "/resume") {
    return "target chooser";
  }
  if (command === "/resume recommend") {
    return "recommendation chooser";
  }
  if (command === "/resume lineage") {
    return "lineage chooser";
  }
  if (command === "/history sessions") {
    return "session browser chooser";
  }
  if (command.startsWith("/history")) {
    return "browser";
  }
  if (command === "/status summary") {
    return "control card";
  }
  return "direct command";
}

function buildPaletteWhySelected(input: {
  command: string;
  category: InteractiveCommandPaletteCategory;
  featured: boolean;
  suggested: boolean;
}): string {
  if (input.command === "/continue") {
    return "Start here when you want the shell to pick the best continue path before you decide between resume, replay, lineage, or plan.";
  }
  if (input.command === "/resume" || input.command === "/history replay" || input.command === "/history lineage") {
    return "This entry opens a bounded chooser instead of forcing you to remember a session id first.";
  }
  if (input.command === "/status summary") {
    return "Start here when you need the fastest control-card view of current state and next navigation.";
  }
  if (input.suggested) {
    return "This is a high-frequency command on the current default navigation path.";
  }
  if (input.featured) {
    return "This is a featured command in the daily terminal workflow.";
  }
  return `This command belongs to the ${input.category} surface and stays one step away from the core path.`;
}

function buildPaletteNextEffect(command: string): string {
  if (command === "/continue") {
    return "Enter -> continue browser -> choose the best next action for the current or recommended thread.";
  }
  if (command === "/resume") {
    return "Enter -> resume chooser -> `/resume <session-id>`.";
  }
  if (command === "/resume recommend") {
    return "Enter -> recommendation chooser -> resume or inspect.";
  }
  if (command === "/resume lineage") {
    return "Enter -> lineage chooser -> `/history lineage <session-id> summary`.";
  }
  if (command === "/history lineage") {
    return "Enter -> lineage chooser -> session-scoped lineage.";
  }
  if (command === "/history replay") {
    return "Enter -> replay chooser -> `/history replay <session-id> summary`.";
  }
  if (command === "/history sessions") {
    return "Enter -> session browser chooser -> resume, replay, plan, or why.";
  }
  if (command === "/history sessions summary") {
    return "Enter -> bounded session browser summary.";
  }
  return `Enter -> ${command}.`;
}
