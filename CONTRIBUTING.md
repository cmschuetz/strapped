# Contributing to strapped

Guidance for developing the strapped repo itself — the eval layers, the workflow
architecture record, and anything else that concerns contributors rather than users.
User-facing runtime conventions (state machine, chains, worktrees, PRs, feedback) live in
`plugins/strapped/conventions.md` and are deliberately kept free of contributor material:
that file ships inside the plugin and its sections load into users' context on demand.

## Prompt evaluation suite

The strapped repo carries a prompt-effectiveness eval suite under `src/eval/` (run via `bun run eval`, not bundled into any plugin deployable). It grades the harness's own agent prompts on three axes — **correctness** (layered graders: schema-conformance, assertion predicates, an optional LLM judge), **cost** (`total_cost_usd` + token usage), and **latency** (`duration_ms` / `num_turns`) — by shelling out to `claude -p` (never the Anthropic SDK) and reading the `--output-format json` envelope. It supports **A/B** (baseline vs candidate prompt at one model, reporting Δcorrectness / Δcost / Δlatency side by side so a human judges the trade — a correctness dip that buys a large cost/latency win is a WIN) and a **model matrix** (`--models opus,sonnet,haiku`).

It is the **heavy, opt-in test layer for prompt changes**: it needs a real `claude` and spends cost, so it is deliberately kept OUT of `bun test` (which stays hermetic/offline). When you change an agent prompt (`src/workflows/strapped-run/**` or a skill's `SKILL.md` step prose), run the eval suite alongside `bun test` and keep both green — it is the evidence that the prompt change is a real improvement. An absent `claude` CLI is a graceful skip (notice + exit 0), and only `--ab` and scenario `--compare` gate: exit non-zero on a correctness (for `--compare`: correctness or adherence) regression past `--tolerance`.

**Scenario evaluations.** The same `src/eval/` tree also carries *scenario* evals (`src/eval/scenarios/harness/`, run via `bun run eval --scenarios src/eval/scenarios/harness`): each scenario materializes a sandboxed synthetic fixture repo + ask, drives the REAL shipped workflow deployable (`plugins/strapped/workflows/strapped-run.js`) through a stage subset with every `agent()` call lowered into a real `claude -p` run, and grades the whole run on **correctness**, **adherence** (the workflow's own state/frontmatter rules), **time**, and **price**. Run them when changing WORKFLOW behavior — stage logic, review budgets, orchestration prompts — and capture a `--json` report before and after the change: the offline `bun run eval --compare <baseline.json> <candidate.json>` diff is the before/after evidence for a workflow change. Scenarios are much heavier than prompt cases: every agent call is a real multi-turn agentic run, so expect minutes of wall clock and real cost per scenario (keep asks tiny; the pr stage is always forced dry-run). Known limitation: the engine's sync spawn boundary serializes the workflow's `parallel()`/`pipeline()`, so scenario wall clock is the SERIALIZED sum of agent calls — rest time verdicts on Σturns / ΣapiDurationMs deltas, never on the wall column.

**Per-node baseline-vs-candidate runbook.** When a branch changes workflow behavior, its merge evidence is a baseline-vs-candidate compare over the scenario suite, and the baseline MUST come from a **self-consistent checkout** — the old executor, old scenarios, and old deployable together, run from INSIDE a worktree of the baseline commit. Per node:

1. **Baseline** — from the node's checkout, add a worktree of its BASE commit (the commit the branch forked from) and run that tree's own suite from inside it:

   ```bash
   git worktree add /tmp/<node>-baseline "$(git merge-base HEAD main)"
   cd /tmp/<node>-baseline && bun install
   bun run eval --scenarios src/eval/scenarios/harness --json > /tmp/baseline.json
   ```

   Remove the worktree afterwards (`git worktree remove /tmp/<node>-baseline`).
2. **Candidate** — from the node's own checkout: `bun run eval --scenarios src/eval/scenarios/harness --json > /tmp/candidate.json`.
3. **Gate** — `bun run eval --compare /tmp/baseline.json /tmp/candidate.json --tolerance 5`: exit 1 on a correctness/adherence regression past tolerance; cost/turn deltas never gate — read them off the table (Σturns / ΣapiDurationMs, never wall clock). A scenario that exists only on the candidate side (the node's own new scenario) appears as a candidate-only row: it must be green but has no baseline delta.

`--deployable <path>` runs the scenario suite against a named workflow deployable instead of the shipped one. Scope it honestly: it is ONLY for **contract-compatible** builds — e.g. A/B-ing two candidate builds of the same tree. Never use it to fake a cross-contract baseline (the new executor pointed at an old deployable): when the args contract changed between the commits, `parseConfig` in the old deployable can crash at config parse and fabricate an all-failure baseline. Cross-contract baselines always come from the self-consistent worktree above.

## Workflow nesting limit (verified; moot by design)

Verified 2026-07-11 against the real Workflow tool, with throwaway scriptPath chains dispatched at depths 2, 3, and 4:

- **Depth 2** — a root workflow dispatching one child via `workflow({ scriptPath })` — **works**: the child's return value and its `phase`/`log` output surface at the root.
- **Depth 3 and depth 4 fail**: a CHILD workflow may not call `workflow()` at all. Exact runtime error: `workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.`

This limit is why the retired multi-file architecture (stage workflows dispatching each other — the planner and feedback flows each dispatching a shared review-loop file, the wave workflow dispatching a code-review file, and a chain orchestrator above them) could not be built, and why everything was consolidated into the single strapped-run file: with zero `workflow()` calls the limit never engages. Kept as the record for anyone tempted to reintroduce sub-workflow dispatch.
