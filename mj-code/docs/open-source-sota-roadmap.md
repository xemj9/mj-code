# MJ Code Open-Source SOTA Roadmap

Date: 2026-04-12

## Purpose

This document is the stable execution roadmap for pushing `MJ Code` toward open-source SOTA.

It is intentionally prompt-oriented:

- each numbered item is one recommended coding round
- each round should produce code, tests, verification, and an honest repo-state update
- the sequence matters more than the exact prompt count

The goal is not to copy Claude Code or Codex feature-for-feature.
The goal is to build an open terminal coding agent that is:

- TS-first and auditable
- strong on session continuity and replay
- strong on context engineering and memory governance
- strong on safety, approval, and sandbox boundaries
- strong on verifier-backed coding correctness
- eventually strong on TUI, delegation, MCP, skills, and ecosystem

## Hard Invariants

These do not change unless we make an explicit strategy change.

1. `TypeScript-first` stays the main engineering line until the core runtime is effectively all-TS.
2. Do not expand product surface too early if the control plane is still unstable.
3. Prefer typed seams and explicit contracts over large god objects.
4. Do not patch `node_modules`.
5. Do not claim parity with Claude Code or Codex before the relevant plane is actually implemented.
6. Verifier/LSP comes before TUI and before multi-agent.
7. Memory/context work must stay separate from instruction hierarchy; do not collapse them into one opaque prompt blob.
8. Sandbox, approval, external capability governance, and replayability are product features, not just internal plumbing.

## Strategic North Star

MJ Code should eventually be best-in-class in these areas:

1. Context engineering:
   auditable instruction hierarchy, memory injection, compaction, provenance, and continuity.
2. Session continuity:
   replayable turns, snapshots, resumable sessions, trace continuity, and branch-aware execution history.
3. Safety:
   strong approval UX, explicit execution boundaries, plugin/skill/MCP isolation, and external boundary telemetry.
4. Coding correctness:
   verifier/LSP/post-edit validation, fix loops, and quality gates before claiming task completion.
5. Operator ergonomics:
   clean CLI, useful TUI, understandable traces, and production-grade observability.
6. Agent extensibility:
   hooks, MCP, skills, plugins, feature flags, subagents, and ecosystem surfaces that do not compromise the core loop.

## Current Position

As of this document:

- the core runtime has moved heavily toward TS
- the largest remaining daily-use non-shim JS debt is now `src/lib/ui.mjs`; `src/lib/agent-loop-legacy.mjs` remains legacy debt, but the interaction shell is the more immediate product-facing JS seam
- typed seams now exist for lifecycle, turn engine, turn events, session continuity, observability, runtime bootstrap, intelligence orchestration, command surface, runtime events, and instructions
- verifier/LSP has already started for real: post-edit verifier checks, project-aware diagnostics, bounded repair follow-through, transport-aware diagnostics deltas and convergence state, a dedicated JSON-first inspect surface, verifier-aware inspect render profiles for `json|summary|failures|repair|context`, a repair-loop convergence eval suite, diagnostics-aware `tsserver` transport, bounded typed fix-hint/code-action assist, carefully bounded verifier-aware code-action apply, slightly richer bounded read-only code-intel context with implementations plus document-symbol outline continuity, managed verifier inspect export/list/compare continuity, durable baseline pin/promote/list/resolve, named regression-gate policy profiles, durable compare/gate/eval artifacts, baseline-aware eval workflow, governance-aware baseline promotion plan/approve/history, typed release triage plus GitHub-checks/annotation-friendly payloads, artifact upload metadata backfill, typed release handoff/bundle/prune follow-through, overnight verifier-handoff summaries, optional live GitHub check-run mutation with durable result history and safe fallback, and a first GitHub Actions verifier-release workflow are live on the main agent path
- the next verifier move should no longer stay on release plumbing; now that approval governance and optional live mutation are in place, the next cut should shift toward more user-visible inspect/interaction improvements instead of piling on more operator-only release work, and still not jump ahead to TUI, multi-agent work, or cosmetic UI plumbing
- the planning/control-plane line has now moved past a thin step list: the default loop uses dependency-aware execution plans with bounded subtask decomposition, failure-aware replanning for tool/provider/verifier failures, verification-aware stop conditions, JSON-first `plan current` / `plan timeline` inspection over replayable state, and a unified `why` / `next` / `recover` interaction layer over typed route/model/tool/plan/verifier/runtime state
- the default terminal interaction path is now starting to look like a real daily-use surface: bare `/` opens a bounded command palette, TTY mode now uses a quieter boxed prompt-adjacent launcher sheet in empty state, query-state ranking is now a bounded intent-aware v5 instead of generic substring-first order, non-TTY now falls back to a quieter compact launcher and query-aware filtered fallback instead of a full text dump or unknown-command dead end, the launcher/picker states share one dialog-like bounded sheet structure, the empty-state launcher is explicitly biased toward `/continue`, `/status`, and `/history sessions` before low-frequency inspection commands, the prompt chrome is now a two-line dialog-like input zone (`message or /continue` + `╰─ input ›`) and now also switches by interaction state (`input`, `launcher`, `target chooser`, `action chooser`) instead of the older raw `xmj>` shell, the palette supports section jumps plus bounded target-first + action-second chooser flows for high-frequency resume/history actions, selected commands/targets expose a typed preview contract that drives the live preview panel, `/about` exposes project identity, `/status` shows a leaner bounded control card for session/token/context/runtime plus drill-down continuity, `/history` exposes bounded `sessions|changes|lineage|replay` browser views with a tighter ranked continuity-card shape and less audit/report tone, `/continue` now acts as the umbrella continue/open surface, and `/resume recommend|lineage` now give continuity-aware navigation instead of only low-level resume

This means we are not yet at the phase where TUI, multi-agent, or ecosystem breadth should dominate the roadmap.

Near-term boundary note:

- the current decision/recovery interaction plane is intentionally bounded and JSON-first
- it covers route/model/tool/plan/verifier scopes plus grounded next-step and recovery guidance for permission, approval, boundary, provider/circuit, verifier, repair-exhausted, and GitHub-mutation failure states
- the current interaction shell is also intentionally bounded: it has a prompt-adjacent launcher plus session/history/resume pickers, target previews, and bounded second-step action choosers, but it is not yet a full-screen TUI, a stronger fuzzy launcher, a richer session selector board, cross-session recovery memory, or a multi-agent remediation system
- PTY validation has improved, but remains honest: there is now stronger controller coverage, fake-TTY `readline + raw-key` coverage, direct PTY smoke for `createTerminalUi.ask()` including the second-step chooser path, actual CLI PTY automated checks for the compact slash path plus `/history replay`, `/resume recommend`, `/history sessions`, `/history lineage`, and `/continue` chooser chains, and separate actual CLI PTY smoke for those paths. The raw-key “open while still typing” proof still mostly lives in the fake/direct layers; the actual CLI PTY layer is stronger on submitted-command behavior than on byte-perfect live redraw. This is still not a full redraw oracle or full actual-CLI chooser proof for the whole CLI.

## Roadmap Overview

The roadmap is split into 10 phases:

1. All-TS core closure
2. Schema and contract hardening
3. Verifier and LSP plane
4. Context engineering and memory v2
5. Sandbox and external boundary hardening
6. Hook, plugin, skill, and MCP maturity
7. TUI and session UX
8. Multi-agent orchestration
9. Performance, observability, and release engineering
10. Ecosystem, benchmarks, and open-source leadership

The list below uses a prompt-by-prompt form. Some rounds may merge if progress is unusually smooth. Some may split if complexity is higher than expected.

## Phase 1: All-TS Core Closure

### Prompt 01
Move the remaining static session entry logic out of `src/lib/agent-loop-legacy.mjs` into a new typed seam. Cover `create()`, `inspect()`, and `resume()` with regression tests.

### Prompt 02
Delete or collapse duplicate legacy methods already overridden by `src/lib/agent-loop.mts`, especially old trace/session helpers. Make `agent-loop-legacy.mjs` visibly thinner and more honest.

### Prompt 03
Remove the remaining core JS/TS interop seam around `src/lib/agent-core.mts`. The goal is to stop relying on broad type assertions for lifecycle and session surfaces.

### Prompt 04
Reduce the temporary constructor and component wiring seam in `src/lib/agent-components.mts`. Make the component bundle more explicitly typed and easier to instantiate without legacy shims.

### Prompt 05
Migrate `src/lib/skill-loader.mjs` to TS. Keep behavior stable, but move the runtime, influence, and registry contracts onto typed surfaces.

### Prompt 06
Migrate `src/lib/web-policy.mjs` to TS. Tighten the policy/risk contract so web access is no longer one of the larger business-logic JS holdouts.

### Prompt 07
Audit the biggest remaining non-shim JS files and choose the highest-value next TS migration slice. Do not chase tiny files; continue taking the files that still shape runtime behavior.

### Prompt 08
Raise TS strictness one step where feasible without destabilizing the build. The point is to convert migration progress into stronger guarantees, not just renamed files.

### Prompt 09
Normalize source/runtime entry compatibility so the remaining `.mjs` shims are clearly compatibility-only. Keep `node src/cli.mjs` stable while shrinking real JS logic further.

### Prompt 10
Do a dedicated all-TS audit pass. Update README with exact remaining JS business-logic modules, interop seams, and what still blocks “effectively all-TS” status.

## Phase 2: Schema and Contract Hardening

### Prompt 11
Introduce a schema layer for high-risk tool inputs and config loading. Start with a narrow critical path instead of trying to Zod-wrap the whole repo in one round.

### Prompt 12
Apply runtime validation to tool execution boundaries: builtin tools, plugin tools, MCP tools, and hook payloads. Fail explicitly instead of silently coercing malformed input.

### Prompt 13
Add typed and validated config schemas for provider, execution boundary, network mode, hooks, and plugin settings. Make config errors operator-friendly.

### Prompt 14
Add schema-backed validation to session snapshot hydration and replay paths. The goal is resilient resume/replay, not just stricter types at compile time.

### Prompt 15
Harden provider response normalization with explicit parsing contracts for native tool-calling and JSON fallback paths. This is foundational for later verifier and repair loops.

### Prompt 16
Add schema-aware error taxonomy across providers, tools, hooks, MCP, and shell execution. Use it to improve trace summaries and recovery behavior.

## Phase 3: Verifier and LSP Plane

### Prompt 17
Introduce a typed post-edit verifier seam. It should sit after tool execution and before final success reporting, but it must not yet turn into a large autopilot loop.

### Prompt 18
Add the first verifier implementations: file parse checks, command exit checks, and targeted test-command verification. Keep them explicit and auditable.

### Prompt 19
Add an LSP integration surface for diagnostics collection, at least as a typed abstraction even if provider support is minimal at first. This becomes the basis for coding correctness.

### Prompt 20
Make verifier results visible in session traces, status, and replay. The point is to let later TUI and subagents consume verifier state without scraping logs.

### Prompt 21
Add a repair loop for verifier failures with clear retry limits and telemetry. This is a major step toward agent reliability and a real differentiator if done cleanly.

### Prompt 22
Teach execution planning to factor verifier costs and expected validation steps. Plans should know when the task implies code edits plus validation, not just tool calls.

### Prompt 23
Add specialized evals for post-edit correctness and repair-loop convergence. Do not rely on happy-path mock tests only.

### Prompt 24
Document the verifier plane in README and expose minimal CLI surfaces to inspect verifier output. This is the point where MJ Code starts feeling more serious than a raw edit loop.

## Phase 4: Context Engineering and Memory v2

### Prompt 25
Design and implement a true dual system for instructions vs memory, with clearer lifecycle and provenance. Do not let retrieval output masquerade as authoritative instruction text.

### Prompt 26
Introduce memory classes with different persistence and injection behavior: session, project, user, failure, and optional task-local memory. Make the distinctions explicit in code and docs.

### Prompt 27
Upgrade retrieval ranking with stronger relevance, recency, certainty, and task linkage signals. Keep zero-relevance junk from polluting context.

### Prompt 28
Add memory write policies and memory quality gates. Not every fact observed during a run should become durable memory.

### Prompt 29
Build a typed context budget planner that reasons jointly about instructions, conversation history, memories, source citations, and tool results. This should become the core context governor.

### Prompt 30
Implement multi-stage compaction and collapse strategies inspired by agent-loop designs in strong production tools. Make compaction traceable and reversible in session history.

### Prompt 31
Add continuity-aware context carryover for resumed and branched sessions. The goal is to preserve useful state without accidentally replaying stale assumptions.

### Prompt 32
Expose context-plan introspection clearly in CLI, traces, and status. This is where MJ Code can become stronger than opaque commercial tools on auditability.

## Phase 5: Sandbox and External Boundary Hardening

### Prompt 33
Refine execution-boundary contracts so shell, file write, web, MCP, and plugin surfaces all use one clearer risk language. This is groundwork for stronger policy and UX.

### Prompt 34
Strengthen approval UX with more precise previews, rollback affordances, and risk reasons. Make approvals feel like an operator control plane, not a yes/no speed bump.

### Prompt 35
Introduce stricter plugin boundary metadata and execution restrictions. Even before true sandboxing, the runtime should treat plugins as high-trust but explicit external code.

### Prompt 36
Add a first real plugin sandbox strategy document and minimal runtime enforcement hooks. The goal is to stop leaving plugin isolation as a vague future TODO.

### Prompt 37
Strengthen MCP boundary handling with better capability metadata, server trust surfacing, and clearer policy interplay with network mode. This should reduce blind external delegation.

### Prompt 38
Separate read-only, workspace-write, and full-access semantics more rigorously across all tool families. Avoid capability drift between builtin tools, MCP, and plugins.

### Prompt 39
Add stronger external-boundary telemetry and failure classes to traces and replay. This will matter later for TUI, multi-agent, and benchmark quality.

### Prompt 40
Create dedicated security/regression tests for approvals, boundary blocking, plugin restrictions, and MCP policy behavior. SOTA claims require safety regressions, not just feature tests.

## Phase 6: Hooks, Plugins, Skills, and MCP Maturity

### Prompt 41
Expand lifecycle hooks beyond the current minimal subset, but keep semantics typed and bounded. Avoid creating a giant unstructured hook bag.

### Prompt 42
Add clearer hook scheduling and event contracts so hooks can safely observe or enrich more agent phases. Do not let hook behavior become nondeterministic or hard to replay.

### Prompt 43
Improve skills so they influence instructions, routing, and execution in more explicit ways. Keep them composable rather than magical prompt fragments.

### Prompt 44
Give skills and plugins better metadata, versioning, and inspectability. This is necessary before any serious marketplace or public extension story.

### Prompt 45
Upgrade MCP discovery and tool mapping with better schemas, richer annotations, and more reliable runtime health reporting. This is core to competing on extensibility.

### Prompt 46
Add feature flags for experimental capability planes, but do it after the contracts are stable. Use flags to control rollout, not to hide architectural confusion.

### Prompt 47
Make hooks, skills, plugins, and MCP first-class in replay and trace narratives. Operators should be able to answer “why did the agent do that?” from one session trail.

### Prompt 48
Write a public-facing extension model document. This is the beginning of ecosystem leadership, not just internal plumbing.

## Phase 7: TUI and Session UX

### Prompt 49
Design the TUI around typed event streams that already exist, especially turn events, trace phases, verifier output, and runtime status. Do not build a UI that scrapes logs.

### Prompt 50
Introduce a minimal TUI shell for timeline, current turn, approval view, and runtime status. Keep the first slice narrow and data-driven.

### Prompt 51
Add session navigation in TUI: current session, resumed branch ancestry, replay markers, and snapshot phases. This should feel like an operator console for the agent.

### Prompt 52
Add rich diff/review views tied to change sets, rollback, and verifier results. The coding experience should start feeling better than a plain REPL.

### Prompt 53
Expose context-plan, memory provenance, and instruction hierarchy views in the TUI. This is one of the clearest opportunities to beat opaque tools on usability plus auditability.

### Prompt 54
Add job, shell, web, and MCP runtime panes with circuit and health state. Make degraded runtime state obvious without needing debug commands.

### Prompt 55
Add TUI flows for approvals, retries, verifier repair, and rollback. The operator should be able to steer the loop rather than just watch it.

### Prompt 56
Stabilize the TUI API and state model so future multi-agent views can plug in cleanly. This round is about architecture, not visual polish.

## Phase 8: Multi-Agent Orchestration

### Prompt 57
Design a typed subagent/task contract: task ownership, write scope, memory inheritance, instruction scope, and replay linkage. Do not spawn agents before this exists.

### Prompt 58
Add bounded delegation for well-scoped sidecar tasks first. Start with explorer/reviewer/worker patterns instead of full autonomous swarms.

### Prompt 59
Add session and trace linkage between parent and child agents. This is mandatory if multi-agent work is going to remain auditable.

### Prompt 60
Add approval and sandbox rules for subagent execution. Delegation without policy controls is not a serious product.

### Prompt 61
Teach the planner when delegation is worth it and when it is not. Subagents should be a strategic tool, not a reflex.

### Prompt 62
Add result merge contracts and failure handling for child agents. This is where many multi-agent systems become incoherent; keep MJ Code strict here.

### Prompt 63
Expose multi-agent state in TUI, status, and replay. If users cannot inspect delegation clearly, the feature is not production-grade.

### Prompt 64
Create eval suites for delegation quality, merge correctness, and policy compliance. Only then can multi-agent be considered a stable differentiator.

## Phase 9: Performance, Observability, and Release Engineering

### Prompt 65
Add startup and hot-path benchmarks for config load, provider bootstrap, context planning, tool execution, and replay. Measure first, then optimize.

### Prompt 66
Optimize code search and source-pack preparation around `rg`, cache reuse, and incremental scan behavior. This is a practical advantage users feel immediately.

### Prompt 67
Improve trace and runtime telemetry so durations, retries, compaction costs, verifier cycles, and external boundary failures are easy to inspect. This should serve both CLI and TUI.

### Prompt 68
Add performance-focused evals for large repos, deep session histories, and degraded providers. SOTA requires behavior under pressure, not just on toy runs.

### Prompt 69
Design release-grade feature flags and compatibility policy. Public users need predictable behavior even while advanced planes are still evolving.

### Prompt 70
Harden packaging, build artifacts, and source-vs-dist parity. The release path should be boring and trustworthy.

### Prompt 71
Add automated smoke matrices across providers, modes, and representative commands. Public trust depends on repeatable verification, not anecdotal passes.

### Prompt 72
Create a contributor-quality engineering guide covering architecture, seams, testing, contracts, and migration rules. Open-source leadership requires maintainable contribution paths.

## Phase 10: Ecosystem, Benchmarks, and Open-Source Leadership

### Prompt 73
Publish benchmark scenarios that compare MJ Code with strong open and closed competitors on tasks that matter: edit correctness, replayability, approval clarity, and context auditability.

### Prompt 74
Create canonical demo tasks and trace walkthroughs that show MJ Code’s differentiators. Good open-source projects win partly by being legible.

### Prompt 75
Document the instruction system, memory system, replay model, and verifier plane as first-class product concepts. This is how the project develops its own identity.

### Prompt 76
Add extension author docs for hooks, skills, plugins, and MCP integrations. If the extension model is weak, the ecosystem will stay shallow.

### Prompt 77
Build a curated eval suite for real coding workflows: inspect, patch, test, recover, resume, and verify. This suite should become the public quality bar for releases.

### Prompt 78
Add long-run reliability testing: overnight sessions, repeated resumes, degraded network modes, verifier loops, and large context histories. This is what separates serious tools from demos.

### Prompt 79
Tune the default product experience based on repeated real use. Remove friction from the core terminal coding loop without hiding power-user depth.

### Prompt 80
Publish a public architecture map and roadmap update. At this point the project should present itself as a coherent system, not a pile of features.

## Stretch Rounds Beyond 80

If the product is healthy by Prompt 80, the next rounds should be optimization and category leadership work, not random breadth:

### Prompt 81+
Push on areas where MJ Code can plausibly exceed closed tools:

- more auditable context planning than Claude Code
- stronger replay, trace, and branch continuity than most terminal agents
- better verifier-centric coding loop than tools that stop at “edited files successfully”
- clearer operator control over approvals, sandboxing, and external delegation
- a better open extension model for hooks, skills, plugins, and MCP

## How To Use This Roadmap

For each coding round:

1. pick the next unfinished prompt in order
2. keep the round narrowly scoped
3. require tests, verification, and README/doc honesty
4. record what debt remains before moving on
5. do not jump ahead because a later phase looks more exciting

## Anti-Patterns

Do not drift into these patterns:

1. Migrating tiny files while leaving the main control plane unstable.
2. Building TUI chrome before the underlying typed event surfaces are stable.
3. Adding multi-agent before replay, policy, and sandbox contracts are strong.
4. Treating memory as a single blob instead of a governed system.
5. Using feature flags as a substitute for architecture.
6. Claiming “Claude Code parity” based on superficial feature names.
7. Letting README promise more than the implementation truly does.

## Success Criteria

MJ Code can start credibly claiming open-source SOTA when most of these are true:

- the core runtime is effectively all-TS
- verifier/LSP is part of the default coding loop
- context/memory/instruction provenance is inspectable and trustworthy
- replay/resume/branch continuity is strong and test-backed
- sandbox, approval, and external boundary governance are first-class
- TUI is useful because it reflects real typed runtime state
- multi-agent is auditable and policy-aware
- benchmarks and reliability suites are public and reproducible

Only after that does “surpass Claude Code in some dimensions” become a serious claim.
