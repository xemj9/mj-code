# Phase 1 TS Closeout Audit

Date: 2026-04-12

This document was refreshed after the latest interaction-shell polish round. It is still a handoff document, not a claim that the tree is already all-TS.
Verifier/LSP work has now moved further still: the future-facing diagnostics seam is no longer a no-op, a real TypeScript/JavaScript diagnostics provider v1 is landed on top of the verifier base, a bounded same-turn repair loop now sits above verifier failures, there is now a dedicated verifier inspect surface on top of those records, repair now records typed diagnostics deltas plus improved/unchanged/regressed/resolved convergence state instead of only retry/stop outcomes, the landed `tsserver` transport now also exposes bounded typed fix-hint/code-action assist plus carefully bounded code-action apply into verifier, repair, inspect, and eval, the latest transport slice extends project context into slightly richer bounded symbol/document context with implementations, enclosing scope, navtree-backed document symbols, stable prioritization, and live turn-engine continuity, the operator-facing inspect slice now has a dedicated verifier inspect render layer with stable `json|summary|failures|repair|context` profiles on top of the unchanged JSON-first report contract, the continuity store now adds managed verifier export/list/compare plus durable baseline pin/promote/list/resolve on top of that same typed report instead of pushing operators back to raw JSON or ad hoc text parsing, and the newest release-facing slice adds governance-aware baseline promotion plan/approve/history, typed release triage plus GitHub-checks/annotation-friendly payloads, artifact upload metadata backfill, CI-friendly bundle export, conservative prune, overnight verifier-handoff summaries, and an optional live GitHub check-run mutation seam with durable result records and safe fallback so that continuity is now consumable by nightly/release automation rather than inspection-only. On top of that, the default agent loop now has a stronger planning/control-plane v1: dependency-aware plan graphs, bounded task decomposition, failure-aware replanning for tool/provider/verifier paths, verification-aware stop conditions, JSON-first `plan current` / `plan timeline` inspection on the same replayable continuity seam, and a unified decision/recovery interaction plane with bounded `why` / `next` / `recover` surfaces over route/model/tool/plan/verifier/runtime continuity. The newest user-visible interaction pack then tightens the daily terminal path itself: bare `/` now opens a quieter boxed launcher sheet in empty state instead of a flat overlay dump, query-state ranking is now a bounded intent-aware v5 instead of generic substring order, launcher and chooser states now share one bounded panel language, non-TTY bare `/` now falls back to a quieter compact launcher instead of a full text palette, the prompt chrome is now a two-line dialog-like input zone (`message or /continue` + `╰─ input ›`) rather than the older raw `xmj>` shell, prompt chrome now also switches by interaction state (`input`, `launcher`, `target chooser`, `action chooser`) instead of feeling like one static readline bar, `/continue` now acts as a bounded umbrella continue browser over current/recommended session continuity, `history sessions` is now a more natural ranked browser with less `focus/availability/relation` summary tone and clearer `here now` / `continue this` / `look here` language, and `/history replay`, `/history lineage`, and `/resume recommend` read more like decision cards than inspect dumps. Validation now includes controller coverage, a stronger fake-TTY `readline + raw-key` harness, direct fake-TTY coverage for `/resume`, `/history replay`, and `/history lineage` chooser injection, direct PTY smoke of `createTerminalUi.ask()` covering bare `/` plus bounded chooser continuation, and actual CLI PTY automated checks for the compact slash path plus `/history replay`, `/resume recommend`, `/history sessions`, `/history lineage`, and `/continue` chooser chains. The raw-key “open on bare `/` while still typing” proof still primarily lives in the fake/direct TTY layers; the actual CLI PTY layer is stronger on submitted-command behavior than on byte-perfect live redraw. Full PR-comment/review lifecycle, broader GitHub dashboard work, stronger planner search/memory, interactive recovery boards, a full-screen session explorer, stronger fuzzy launcher behavior, and cross-session recovery memory are still not landed.

## Scope

This audit is intentionally narrow:

- inventory the remaining `.mjs` files under `src/`
- separate compatibility shims from real business logic
- reassess the remaining JS/TS interop seams after the control-plane/capability slice
- compare the next realistic migration slices before picking the next one

This refresh documents the latest landed slice and updates the remaining closeout order. It does not itself migrate the next candidate files. The largest remaining daily-use non-shim JS seam is still `src/lib/ui.mjs`; `agent-loop-legacy.mjs` still matters, but it is no longer the biggest user-facing JS debt. This round did split more of the interaction shell boundary out of that file again: prompt chrome, panel frame/layout, visible overlay report building, ask-loop submission flow, and readline/raw-key orchestration now have clearer seams even if `ui.mjs` is still too large.

## Validation Baseline

The repository was revalidated during and after the verifier + diagnostics-provider + bounded-repair-loop + inspect-surface + transport-backed follow-through + inspect continuity + baseline/gate + release-policy/artifact + release-handoff/automation + promotion/checks/triage + planner-control-plane + decision/recovery + interaction-shell-v7 round with the standard commands:

- `npm run typecheck`
- `npm run build`
- `npm test`
- `node --import tsx --test test/agent.mock.test.mjs`
- `node --import tsx --test test/ui-command-palette.test.mjs`
- `node --import tsx --test test/ui-pty-harness.test.mjs`
- `node --import tsx --test test/interaction-render.test.mjs`
- `node --import tsx --test test/session-browser.test.mjs`
- `node --import tsx --test test/cli-interaction.test.mjs`
- `node --import tsx --test test/verifier-inspect.test.mjs`
- `node --import tsx --test test/eval-runner.test.mjs`
- `node --import tsx --test test/overnight-director.test.mjs`
- `node --import tsx --test test/cli-help.test.mjs`
- `node --import tsx --test test/verifier-release-workflow.test.mjs`
- `node src/cli.mjs help`
- `node dist/cli.mjs help`
- `node src/cli.mjs verifier --format summary`
- `node src/cli.mjs verifier trace --format failures`
- `node src/cli.mjs verifier export --format summary`
- `node src/cli.mjs verifier exports summary`
- `node src/cli.mjs verifier baseline pin current <name> --format summary`
- `node src/cli.mjs verifier baselines summary`
- `node src/cli.mjs verifier promotion plan <name> latest summary --policy release`
- `node src/cli.mjs verifier promotion approve <plan-id> summary --approver-id ci-bot --approval-source workflow_dispatch --approval-mode workflow_apply`
- `node src/cli.mjs verifier promotion history <name> summary`
- `node src/cli.mjs verifier policies summary`
- `node src/cli.mjs verifier compare baseline:<name> current summary --write-artifact`
- `node src/cli.mjs verifier gate baseline:<name> current summary --policy release --write-artifact`
- `node src/cli.mjs verifier artifacts summary`
- `node src/cli.mjs verifier handoff latest summary`
- `node src/cli.mjs verifier triage summary latest summary`
- `node src/cli.mjs verifier checks summary latest summary`
- `node src/cli.mjs verifier checks export latest json --github-actions`
- `node src/cli.mjs verifier github apply latest summary --github-actions`
- `node src/cli.mjs verifier github result latest summary`
- `node src/cli.mjs verifier handoff export latest summary`
- `node src/cli.mjs verifier artifacts prune summary --dry-run --max-count 5`
- `node src/cli.mjs verifier artifact <artifact-id> summary`
- `node src/cli.mjs eval verification --provider mock --baseline baseline:<name> --baseline-target current --policy release --write-artifact --write-bundle`
- `node src/cli.mjs why`
- `node src/cli.mjs why plan`
- `node src/cli.mjs next current summary`
- `node src/cli.mjs recover current summary`
- `node src/cli.mjs status summary`
- `node src/cli.mjs history sessions summary`
- `node src/cli.mjs history replay latest summary`
- `node src/cli.mjs history lineage latest summary`
- `node src/cli.mjs resume recommend latest summary`
- `printf '/\n/status\n/history sessions summary\n/about\n/exit\n' | node src/cli.mjs --provider mock`
- `printf '/res\n/exit\n' | node src/cli.mjs --provider mock`
- `node --import tsx --input-type=module -e 'import { createTerminalUi } from "./src/lib/ui.mjs"; const ui = createTerminalUi(); const answer = await ui.ask("xmj> "); console.log(JSON.stringify(answer)); ui.close();'`
- `node --import tsx --test test/plugin-loader.test.mjs`

All of them passed on 2026-04-13, with the PTY note above: the repo now has controller coverage, fake-TTY coverage, a direct PTY smoke for `createTerminalUi.ask()` that reaches the second-step chooser path, actual CLI PTY automated assertions for the compact slash path, bare `/` -> `/history replay`, `/resume recommend`, `/history sessions`, `/history lineage`, and `/continue` chooser chains, plus separate manual PTY smoke for those paths; it still does not claim a byte-perfect redraw oracle or full actual-CLI chooser automation for every path in the shell.

The reported `node_modules/@types/node/stream/promises.d.ts` issue still does not reproduce under `npm run typecheck` or `npm run build`, so it remains an editor/tooling-only complaint for now and was not patched in `node_modules`.

## Current Source Counts

- `33` `.mjs`
- `100` `.mts`
- `2` `.ts`

The tree is now clearly TS-first. The remaining work is no longer the main agent loop, the edit/write substrate, the web/context retrieval plane, the runtime/session utility batch, or the control-plane/capability batch. Diagnostics-aware verifier, bounded repair follow-through, a dedicated verifier inspect surface, verifier-aware inspect render profiles, transport-aware repair hardening, repair-loop convergence eval, diagnostics-aware `tsserver` transport, bounded fix-hint/code-action assist, carefully bounded verifier-aware code-action apply, slightly richer bounded read-only code-intel context, live turn-engine verifier/code-action hardening, managed verifier export/list/compare plus baseline pin/promote/gate continuity with named policy profiles and durable compare/gate/eval artifacts, typed release handoff/bundle/prune plus governance-aware promotion/triage/checks/upload-backfill/overnight/optional-live-mutation/CI automation, a planner/control-plane v1 that the default loop actually consumes, and now a unified `why` / `next` / `recover` plus session-navigation interaction seam are in place. The next work is no longer "make continuity real" or "add more release plumbing"; it should stay on more user-visible interaction and stronger agent reasoning on top of the now-landed plan/verifier substrate, plus a handful of small non-shim JS wrappers.

## Remaining `.mjs` Inventory

Columns:

- `LOC`: current line count from `wc -l`
- `Role`: `compat shim`, `source entry`, `core runtime`, `tool implementation`, `product UX`, or `utility infra`
- `Action`: `keep`, `next`, `bundle`, `defer`, or `opportunistic`

### Compatibility Shims And Source Entry Shells

| Path | LOC | Role | Action |
| --- | ---: | --- | --- |
| `src/agent.mjs` | 2 | compat shim | Keep. Typed public facade already lives in `src/agent.mts`. |
| `src/lib/agent-core.mjs` | 2 | compat shim | Keep. Typed lifecycle core already lives in `src/lib/agent-core.mts`. |
| `src/lib/agent-loop.mjs` | 2 | compat shim | Keep. Typed loop entry already lives in `src/lib/agent-loop.mts`. |
| `src/lib/project-instructions.mjs` | 5 | compat shim | Keep. Typed instruction resolver already lives in `src/lib/project-instructions.mts`. |
| `src/lib/skill-loader.mjs` | 2 | compat shim | Keep. Typed skill plane already lives in `src/lib/skill-loader.mts`. |
| `src/lib/web-policy.mjs` | 16 | compat shim | Keep. Typed web-policy plane already lives in `src/lib/web-policy.mts`. |
| `src/lib/apply-patch.mjs` | 7 | compat shim | Keep. Typed patch engine already lives in `src/lib/apply-patch.mts`. |
| `src/lib/circuit-breaker.mjs` | 5 | compat shim | Keep. Typed circuit state and snapshot logic already live in `src/lib/circuit-breaker.mts`. |
| `src/lib/capability-registry.mjs` | 2 | compat shim | Keep. Typed registry surface already lives in `src/lib/capability-registry.mts`. |
| `src/lib/capability-types.mjs` | 11 | compat shim | Keep. Typed capability taxonomy already lives in `src/lib/capability-types.mts`. |
| `src/lib/execution-journal.mjs` | 2 | compat shim | Keep. Typed journal and shared `ExecutionJournalLike` contract already live in `src/lib/execution-journal.mts`. |
| `src/lib/extension-state-store.mjs` | 2 | compat shim | Keep. Typed extension-state persistence already lives in `src/lib/extension-state-store.mts`. |
| `src/lib/json-protocol.mjs` | 6 | compat shim | Keep. Typed system-prompt / action-parse / tool-feedback logic already lives in `src/lib/json-protocol.mts`. |
| `src/lib/path-utils.mjs` | 7 | compat shim | Keep. Typed path helpers already live in `src/lib/path-utils.mts`. |
| `src/lib/mcp-errors.mjs` | 14 | compat shim | Keep. Typed MCP error envelope and serialization already live in `src/lib/mcp-errors.mts`. |
| `src/tools/filesystem.mjs` | 10 | compat shim | Keep. Typed filesystem tools already live in `src/tools/filesystem.mts`. |
| `src/tools/patch.mjs` | 2 | compat shim | Keep. Typed patch wrapper already lives in `src/tools/patch.mts`. |
| `src/tools/web.mjs` | 6 | compat shim | Keep. Typed web tool orchestration already lives in `src/tools/web.mts`. |
| `src/lib/source-ranker.mjs` | 6 | compat shim | Keep. Typed ranking/provenance logic already lives in `src/lib/source-ranker.mts`. |
| `src/lib/content-extractor.mjs` | 2 | compat shim | Keep. Typed extraction logic already lives in `src/lib/content-extractor.mts`. |
| `src/lib/web-cache.mjs` | 2 | compat shim | Keep. Typed positive/negative cache persistence already lives in `src/lib/web-cache.mts`. |
| `src/lib/web-provider-fallback.mjs` | 5 | compat shim | Keep. Typed fallback provider parsing already lives in `src/lib/web-provider-fallback.mts`. |
| `src/lib/web-provider-brave.mjs` | 5 | compat shim | Keep. Typed Brave provider parsing already lives in `src/lib/web-provider-brave.mts`. |
| `src/lib/web-search-providers.mjs` | 5 | compat shim | Keep. Typed provider selection already lives in `src/lib/web-search-providers.mts`. |
| `src/cli.mjs` | 48 | source entry | Keep for source-runtime compatibility until the source entry strategy changes. |

### Core Runtime And Control-Plane Residue

| Path | LOC | Role | Action |
| --- | ---: | --- | --- |
| `src/lib/agent-loop-legacy.mjs` | 69 | core runtime | Opportunistic. It is now a very small compatibility-oriented residue, not the next high-value dedicated slice. |
| `src/lib/model-metadata.mjs` | 72 | utility infra | Defer. Small helper, not a blocker. |
| `src/lib/process-utils.mjs` | 61 | utility infra | Defer. Shell helper, easy later. |
| `src/lib/sse.mjs` | 66 | utility infra | Defer. Provider helper, stable, no urgent interop pain today. |

### Tool Implementations And Product UX

| Path | LOC | Role | Action |
| --- | ---: | --- | --- |
| `src/tools/shell.mjs` | 60 | tool implementation | Defer. Shell runtime is already typed; this wrapper can wait. |
| `src/tools/memory.mjs` | 52 | tool implementation | Defer. Memory core is already typed; this small tool wrapper can wait. |
| `src/lib/ui.mjs` | 300 | product UX | Next. This is still the main non-shim daily-use UX seam: prompt-adjacent overlay state, chooser navigation, prompt/input orchestration, and PTY-specific interaction behavior still live here even though they now consume typed preview/picker contracts and a split panel/layout helper. |
| `src/lib/ansi.mjs` | 37 | product UX helper | Bundle with `ui.mjs`. Small, but directly coupled to overlay redraw and prompt-adjacent rendering behavior. |

## Migration Value Ranking

The next cuts should not be chosen by line count alone. The highest-value remaining targets are now:

1. Continue the planner/control-plane line from the now landed plan graph + replan + plan-inspect + decision/recovery workflow.
   - Why: the default coding loop now has typed task classification, governed routing, model routing, dependency-aware plan graphs, bounded subtask decomposition, failure-aware replanning for tool/provider/verifier paths, verification-aware stop conditions, JSON-first `plan current` / `plan timeline` continuity on replayable state, and bounded `why` / `next` / `recover` surfaces over the same typed decision state. The next highest-value cut is not more release plumbing; it is to make this control plane reason better and feel more user-visible before any TUI or multi-agent work.
   - Control-plane relevance: highest.
   - Safety relevance: high.
   - Verifier/LSP prerequisite value: direct, because verifier outcomes now feed plan stop/replan decisions.
   - Typed-neighbor readiness: high.

2. `src/lib/ui.mjs` + `src/lib/ansi.mjs`
   - Why: if verifier/LSP work immediately hits terminal presentation friction, this is the last meaningful UX batch still in JS.
   - Control-plane relevance: low.
   - Safety relevance: low.
   - Verifier/LSP prerequisite value: situational.
   - Typed-neighbor readiness: high, but leverage is still secondary to verifier itself.

3. `src/lib/agent-loop-legacy.mjs` + small wrappers such as `src/tools/shell.mjs`, `src/tools/memory.mjs`, `src/lib/model-metadata.mjs`, `src/lib/process-utils.mjs`, and `src/lib/sse.mjs`
   - Why: residual cleanup.
   - Control-plane relevance: low to medium depending on file.
   - Safety relevance: low.
   - Verifier/LSP prerequisite value: low.
   - Conclusion: retire opportunistically, not as the next dedicated slice.

## Interop Seam Inventory

### Must Clear Before Phase 1 Closeout

No broad runtime constructor bridges remain from the previous audit:

- `src/lib/runtime-health.mts` now instantiates the typed `CircuitBreaker` directly
- `src/lib/web-runtime.mts` now instantiates the typed `WebCache` directly
- `src/lib/mcp-registry.mts` now instantiates `McpClient` directly
- repeated anonymous `ExecutionJournalLike` shapes were replaced by imports from `src/lib/execution-journal.mts`
- the old `extractAction(...) as ...` cast in `src/lib/agent-turn-engine.mts` is gone
- repeated anonymous `CapabilityRegistryLike` / `ExtensionStateStoreLike` definitions were replaced in the direct control-plane consumers by shared exported interfaces

### Can Clear Alongside The Next Migration Slices

| File | Seam | Why It Can Wait |
| --- | --- | --- |
| `src/lib/agent-loop.mts` | narrow helper-target delegation casts into session/observability helpers | Local and narrow now that the public loop entry is typed. |
| `src/lib/agent-runtime-surface.mts` | command/runtime/tool target casts | These should shrink naturally as remaining tool/runtime modules migrate. |
| `src/lib/agent-runtime-surface.mts` | `ui.printAssistant` narrow cast | Small presentation seam, not a core runtime blocker. |
| `src/lib/agent-intelligence-surface.mts:101-102` | `asIntelligenceTarget()` | Final typed surface bridge to the tiny legacy base. Remove when the legacy shell disappears. |
| `src/lib/agent-components.mts` | remaining JS module instantiation seams | No longer broad `unknown` bridges, but still a hub that instantiates non-shim JS modules. |

### Better Left For A Later Schema/Hardening Pass

| File | Seam | Why It Is Not A Phase 1 Blocker |
| --- | --- | --- |
| `src/lib/agent-tool-execution.mts:979-983` | `Record<string, unknown>` to `JsonObject` casts | JSON-shape normalization, better handled in a schema/hardening slice. |
| `src/lib/mcp-registry.mts` | `JSON.parse(...) as Record<string, unknown>` style normalization casts | Data-shape hardening issue, not a broad JS bridge. |
| `src/lib/runtime-health.mts` | JSON normalization casts | Same category: schema/data hygiene, not a Phase 1 blocker. |

## A/B/C/D Candidate Comparison

### Option A: `apply-patch.mjs` + related coding-loop utility

Status:

- completed
- no longer the next candidate

### Option B: `source-ranker.mjs` + `content-extractor.mjs` + `tools/web.mjs` web/context slice

Status:

- completed
- now represented by typed seams in `src/tools/web.mts`, `src/lib/source-ranker.mts`, `src/lib/content-extractor.mts`, `src/lib/web-provider-fallback.mts`, `src/lib/web-provider-brave.mts`, and `src/lib/web-search-providers.mts`

Why it mattered:

- it closed the retrieval/provenance slice directly under `web-policy`, `source-registry`, and the web tools
- it made search/fetch/extract results, provider rows, extraction output, and ranking breakdowns stable and serializable

### Option C: runtime/session utility batch

Status:

- completed
- now represented by typed seams in `src/lib/circuit-breaker.mts`, `src/lib/web-cache.mts`, `src/lib/execution-journal.mts`, and `src/lib/mcp-errors.mts`

Why it mattered:

- it cleared the sharpest remaining runtime constructor/runtime bridges
- it made cache records, circuit snapshots, journal entries, and serialized MCP errors stable enough for later replay/verifier/runtime-hardening work

### Option D: stop Phase 1 here and continue verifier/LSP

Why it is more plausible now than before:

- the edit/write substrate is typed end to end
- the web/context retrieval path is typed end to end
- the public loop, session continuity, instruction assembly, skill plane, runtime utility plane, and web-policy plane are already in TS
- the control-plane/capability batch is now also typed, including `json-protocol`, capability taxonomy/registry, and extension-state persistence

Verdict:

- diagnostics-aware verifier plus bounded repair, verifier inspect, a verifier-aware inspect render layer, transport-aware repair hardening, and repair-loop convergence eval are now the active mainline
- diagnostics-aware `tsserver` transport plus bounded fix-hint/code-action assist, carefully bounded verifier-aware code-action apply, slightly richer bounded read-only code-intel context, and live turn-engine hardening are now also landed on that mainline, but this is still not a full LSP client or a general auto-fix loop
- managed verifier inspect export/list/compare continuity plus baseline pin/promote/gate/eval workflow with named policy profiles and durable compare/gate/eval artifacts is now also landed on that same mainline, and typed release handoffs, CI-friendly bundles, conservative prune, policy-aware promotion governance, release triage/checks payloads, upload metadata backfill, overnight summaries, a first GitHub Actions verifier workflow, and an optional live GitHub check-run mutation seam are now on top of it, but this is still not a verifier-aware TUI, a full LSP client, a general auto-fix loop, a full PR-comment/review lifecycle, or a full live GitHub Checks governance/dashboard plane
- the next dedicated slice should continue shifting from release/operator plumbing toward more user-visible inspect/interaction improvements on top of the now-landed verifier handoff/automation substrate and the new decision/recovery surface, not jump sideways into another generic TS cleanup round
- only fall back to a dedicated `ui.mjs` / `ansi.mjs` cleanup if verifier/LSP work immediately exposes a real UX or terminal-surface blocker

## Conclusion

The control-plane/capability batch is complete and diagnostics-aware verifier plus bounded repair follow-through plus verifier inspect plus verifier-aware inspect render profiles plus transport-aware repair hardening plus repair-loop convergence eval plus diagnostics-aware `tsserver` transport plus bounded fix-hint/code-action assist plus carefully bounded verifier-aware code-action apply plus slightly richer bounded transport-backed code-intel context plus live turn-engine hardening plus managed verifier inspect export/list/compare continuity plus durable baseline pin/promote/gate/eval workflow with named policy profiles and compare/gate/eval artifacts plus typed release handoff/bundle/prune/promotion-governance/triage/checks/optional-live-mutation/overnight/CI follow-through plus planner-backed `why` / `next` / `recover` decision/recovery interaction are now landed. The next recommended slice is no longer a generic Phase 1 migration batch, and it is no longer more release plumbing; it should shift toward more user-visible inspect/interaction work on top of the now-real diagnostics + repair + convergence + inspect + render + eval + transport + assist + apply + project-context + continuity seam.

Why this is now the best cut:

- the main control-plane contracts that verifier depends on are typed: prompt assembly, JSON action parsing, capability taxonomy, registry state, edit/write substrate, retrieval/provenance, session replay, runtime health, and MCP/web boundaries
- the remaining JS is mostly shims, UI/presentation code, or smaller helper wrappers rather than central control-plane logic
- another generic cleanup-only slice buys less strategic value than extending verifier/LSP on top of the typed substrate that now exists

## What “Effectively All-TS” Still Requires

Reasonable remaining closeout sequence if Phase 1 continues:

1. continue verifier/LSP post-edit work from the landed diagnostics-aware verifier + bounded repair + inspect + render + diagnostics-transport + project-context seam
2. continue from the landed verifier-aware inspect render layer and inspect export/list/compare continuity with a small policy/promotion/CI-consumer slice before any verifier-aware TUI work
3. if verifier work exposes a terminal-surface blocker, take a focused `ui` / `ansi` cleanup slice
4. retire the remaining small helper/tool wrappers opportunistically alongside product work

Expected remaining effort:

- `0` more dedicated Phase 1 infrastructure slices before continuing verifier/LSP
- `1` more cleanup slice if `ui.mjs` / `ansi.mjs` or another residual helper proves to be a concrete blocker

## When It Becomes Reasonable To Switch To Verifier/LSP

Switch once these conditions are true:

1. the core edit/write path is typed end to end
2. the web/context retrieval path is typed end to end
3. the remaining broad constructor bridges in runtime infrastructure are gone or isolated to clearly non-critical areas
4. the remaining JS is mostly shims, UX shells, or small helpers rather than core runtime/tool logic
5. repo validation is still green after those migrations

Under the current codebase state, that now points to:

- continue verifier/LSP next from the landed diagnostics-aware verifier + bounded repair + inspect + render + transport-backed project-context seam
- keep `ui.mjs` / `ansi.mjs` as the only likely dedicated cleanup follow-up if verifier work proves they are still in the way
- leave the remaining small wrappers as opportunistic debt rather than a blocking prerequisite
