# Changelog

All notable changes to MJ Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-01

### Added
- Interactive terminal REPL with command palette
- One-shot prompt mode (`mj-code run "task"`)
- Pluggable model providers (OpenAI-compatible, Anthropic-compatible, Mock)
- Native tool calling with JSON protocol fallback
- Multi-layer context engineering with rolling compaction
- Persistent memory system (session / project / user / failure stores)
- Multi-dimensional memory retrieval (importance, recency, task relevance, certainty)
- Change-set diff preview for all write operations
- Rollback checkpoints with undo
- Branch-based resumable sessions with lineage tracking
- Replayable execution journal and traces
- File tools: read_file, write_file, replace_in_file, list_dir, search_files
- apply_patch tool for structured diff editing
- Shell job runtime with approval checks, background jobs, cancellation, tailing
- Web knowledge plane: search, fetch, extract with network modes (off / docs-only / open-web)
- Source registry with stable IDs, ranking, and citations
- MCP client plane: stdio transport, server registry, health, tool mapping
- Task classifier (12 task categories)
- Capability router (5 routing modes)
- Model router (dynamic model selection + fallback chain)
- Dependency-aware execution plan graph with replanning
- Policy stack (5 auditable layers: core, instruction, skill, user, runtime)
- Verifier: TypeScript diagnostics via tsserver, test execution, parse checks
- Repair loop: bounded auto-repair with diagnostics delta and code action assist
- Verifier inspect surface: baseline management, compare/gate, release handoff
- Skill system with prompt fragments, tool preferences, precedence resolution
- Plugin system with local manifests, tool registration, capability integration
- Project instructions from MJ.md hierarchy with @import and @rule
- Lifecycle hooks: session_start, user_prompt_submit, before/after_tool, before/after_apply
- Circuit breaker for provider / web / MCP resilience
- Runtime health monitoring with scorecards
- Eval harness for routing, runtime, web, MCP, and verification
- Overnight Director for two-agent reviewer/worker automation
- GitHub Actions verifier release gate workflow
- Zero runtime dependencies
- TypeScript-first source with incremental migration strategy
