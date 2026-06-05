# MJ Code Technical Plan

Date: 2026-04-01

## Goal

Build an open terminal agent that feels close to Codex, Claude Code, or OpenClaw, but is simple enough to own and evolve.

The target product is a local-first coding agent named `MJ Code`.

## What existing tools get right

### Codex-style strengths

- strong local agent loop
- explicit permission boundaries
- fast codebase interaction
- good terminal ergonomics

Reference:

- OpenAI Codex agent loop article: https://openai.com/index/unrolling-the-codex-agent-loop/
- OpenAI Codex CLI repository: https://github.com/openai/codex

### Claude Code-style strengths

- project-scoped behavior
- memory, hooks, and settings
- practical permission and approval workflows
- direct code-editing ergonomics

Reference:

- Claude Code docs hub: https://docs.anthropic.com/en/docs/claude-code/overview
- Claude Code settings: https://docs.anthropic.com/en/docs/claude-code/settings

### OpenClaw-style strengths

- provider and deployment flexibility
- gateway-oriented architecture
- extension surface for skills and integrations

Reference:

- OpenClaw repository: https://github.com/baryhuang/openclaw

## Product decision

`MJ Code` should start as a local terminal coding agent, not as a hosted agent platform.

That means phase 1 should optimize for:

- one binary or one CLI entrypoint
- clean provider abstraction
- safe tool execution
- readable logs
- workspace-scoped editing

It should not start by optimizing for:

- SaaS multi-tenant control planes
- distributed agents
- web dashboards
- heavy TUI animation

## Recommended tech stack

For the first serious version:

- Language: TypeScript on Node.js
- Runtime: Node 20+
- CLI: native `readline` first, optional TUI later
- Networking: native `fetch`
- Process execution: native `child_process`
- File operations: native `fs/promises`
- Sessions: JSONL files
- Search: `rg` when installed, fallback to JS traversal
- Tests: Node built-in test runner

For this MVP in the repository:

- Language: modern ESM JavaScript
- Dependencies: zero
- Dev provider: built-in `mock` provider for local integration testing

That keeps the first delivery easy to run and easy to audit.

## Core modules

### 1. CLI shell

Responsibilities:

- parse args
- launch interactive REPL
- print config and tool info
- host slash commands

### 2. Agent loop

Responsibilities:

- keep conversation state
- call the model provider
- parse action JSON
- evaluate permissions
- execute tools
- feed tool results back to the model

### 3. Provider layer

Responsibilities:

- abstract OpenAI-compatible APIs
- abstract Anthropic-compatible APIs
- normalize response text
- attach headers and auth safely

### 4. Tool registry

Responsibilities:

- define tool schemas
- execute tools by name
- keep tool contracts stable

### 5. Permission layer

Responsibilities:

- separate read, write, and exec capability
- gate risky tools
- support interactive approval prompts

### 6. Session store

Responsibilities:

- persist prompts, tool calls, approvals, and final answers
- make replay and debugging possible

## MVP feature set

The MVP should support:

- interactive chat loop
- one-shot run mode
- `pwd`
- `list_dir`
- `read_file`
- `search_files`
- `write_file`
- `replace_in_file`
- `run_shell`
- approval prompts
- session logs
- config via env and JSON

## Implemented since the MVP baseline

The repository now also includes:

- native tool calling for OpenAI-compatible providers
- streaming provider paths for OpenAI-compatible and Anthropic-compatible adapters
- streaming fallback for OpenAI-compatible gateways that reject SSE mode
- provider model discovery
- `apply_patch`-style editing
- `MJ.md` project instructions
- rolling context compaction
- multi-scope memory storage and retrieval
- model-window-aware context budgeting
- memory commands and memory-native tools
- change-set preview and diff inspection
- rollback checkpoints and undo
- resumable sessions and replay
- execution journal with state snapshots
- trace phases and richer approval UX
- richer terminal presentation

## Phase roadmap

### Phase 1

Ship the MVP in this repository.

Success criteria:

- it can inspect a repo
- it can edit files in the workspace
- it can ask for approval before risky actions
- it works with at least one OpenAI-compatible or Anthropic-compatible endpoint

### Phase 2

Raise the product to "daily-use developer tool" quality.

Add:

- diff preview and rollback polish
- change-impact refinement
- replay UX improvements
- shell command result rendering
- better slash commands
- token and cost reporting

### Phase 3

Add platform-level features inspired by Claude Code and OpenClaw.

Add:

- hooks
- project memory
- plugin system
- MCP client
- multi-agent delegation
- model routing

## Recommended near-term technical requirements

These are the next serious engineering items after the MVP:

1. Add a native function-calling path for providers that support it.
2. Add streaming so long-running tasks feel alive.
3. Add diff-based edits instead of only full-file writes and string replacement.
4. Add an internal command planner and retry policies.
5. Add diff preview and rollback.
6. Add resumable sessions and replay.
7. Add observability with trace IDs and structured logs.
8. Add a plugin contract for custom tools.

## Open questions

These are the main product decisions to settle before v1:

1. Should `MJ Code` stay terminal-first, or also gain an editor sidebar?
2. Should the first "official" provider be OpenAI-compatible, Anthropic-compatible, or a generic gateway?
3. Do you want a lightweight REPL, or a rich TUI that feels closer to Claude Code?
4. Do you want built-in patch editing early, or is shell-plus-write enough for v1?

## Architecture sketch

```text
User
  -> CLI / REPL
  -> Agent Loop
       -> Provider Adapter
       -> Permission Engine
       -> Tool Registry
            -> FS Tools
            -> Search Tool
            -> Shell Tool
       -> Session Store
```

## Suggested next milestones after this commit

1. Strengthen diff rendering and rollback edge cases for larger edits.
2. Expand approval UX into planned-action previews.
3. Improve impact analysis with language-aware heuristics.
4. Expand memory into richer recall, invalidation, and project indexing.
5. Add a plugin interface.
