---
name: implement
description: Execute an approved strapped DAG wave-by-wave — persistent worktree per deliverable, fresh implementer, validations, bounded adversarial code-review/fix loop, park-don't-spin
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Workflow
  - AskUserQuestion
---

Implement an approved strapped plan.

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, naming, budgets, and recipes are in `$PLUGIN_ROOT/conventions.md`. Your always-injected operating model is the slim `context.md` preamble (sentinel `strapped-preamble-v1`); do not front-load research or re-read the whole conventions on invocation — the procedure below is self-sufficient; pull the specific `conventions.md` section only at the step that needs the exact format. If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/context.md` to re-establish the operating model. This skill cold-starts entirely from the run root `<runRoot>/<slug>/` (resolved per the conventions' Config resolution) plus the per-repo config — it needs no memory of the planning session.

## Arguments

`$ARGUMENTS`: `<slug> [--only <Did>] [--max-rounds N]`

- `--only` restricts execution to one deliverable (used to resume a parked node after the user unblocks it).
- `--max-rounds` overrides the `code_rounds` budget (default from the manifest, 3).

## Step 0 — Locate the run root (cwd-independent)

`/strapped:implement` is invoked with only a `<slug>`, and the cwd may be a plans dir or anything unrelated to the work. Run the harness script (contract in the conventions' **Harness scripts** section):

```bash
node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>
```

It performs the conventions' **Cwd-independent slug → run-root resolution** (direct path keyed by slug, no glob, never the cwd) and prints `{ slug, stateRoot, runRoot, runDir, manifest, exists, status, seed, budgets, repos }`. Do not hand-roll the resolution.

If `exists` is `false`, stop with a helpful message: the slug was not found under `<stateRoot>` (point at `/strapped:plan`).

## Step 1 — Cold-start from disk

The `resolve` output already carries the manifest `status`, `seed`, `budgets`, and per-repo configs. The manifest must be `status: approved` or `implementing` — otherwise stop and say why. Do NOT flip it yourself: the `implementing` flip is owned by the implement stage's first coordinator pass inside the workflow (idempotent on resume).

**Per-repo config.** `resolve`'s `repos` array (from the **required** manifest `repos:` map — a manifest without one is invalid input) gives per repo `{ name, root, config, configExists, validations, worktreeRoot, provisioning }`. If any target repo has `configExists: false`, stop and point the user at `/strapped:plan`, which generates one per repo.

Each deliverable's `repo:` field is **required** and names one of the `repos:` entries — a deliverable with no `repo:` is invalid input.

## Step 2 — Rule assignments

As in /strapped:plan: read `reviews/rules-snapshot.md` (re-extract if missing — discover every applicable CLAUDE.md AND recurse into any skills/files it loads for additional rules, per the conventions' **Rule extraction**), compute the per-round rule splits (id-only `{"a": ["R1", "R4"], "b": ["R2", "R3"]}` pairs over the snapshot's sorted rule-id list) for rounds `1..code_rounds` using `random.Random(seed + round)` from the manifest seed. The args carry ids only — the snapshot stays the single source of rule text, which the workflow's review agents Read via `rulesFile`.

## Step 3 — Dispatch the implement stage of the mono-workflow

The ENTIRE wave loop lives in the workflow: its coordinator executor agents own the ready-set computation (`state.mjs dag`), worktree creation (`ensure-worktree.sh` + provisioning), the `worktree`/`in-progress` frontmatter flips, resumeNote composition for re-dispatched nodes, and the `manifest-status implementing` flip; its outcome-applier agents own the `done`/`parked`/`parked_reason`/`review_rounds_used` writes; a wave with zero newly-done progress terminates the loop (park-don't-spin). Do not hand-roll any of it.

Dispatch the `strapped-run` mono-workflow with a singleton stage list — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/strapped-run.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (absolute paths; full contract in the conventions' **Composable chains** section):

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "stages": ["implement"],
  "stageArgs": {
    "implement": { "only": "<Did or omit when --only not given>" }
  },
  "scripts": { "state": "$PLUGIN_ROOT/scripts/state.mjs", "worktree": "$PLUGIN_ROOT/scripts/ensure-worktree.sh" },
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "codeRounds": 3,
  "planRounds": 3,
  "confidenceMin": 70,
  "seed": 42,
  "rulesFile": "<runRoot>/<slug>/reviews/rules-snapshot.md",
  "rulesByRound": [<the id-only per-round splits from step 2>]
}
```

`codeRounds` = the `--max-rounds` override or the manifest `budgets.code_rounds`; `seed` = the manifest seed. `stageArgs.implement.only` threads `--only` through to every coordinator `dag` call (readmitting a `parked`/`in-progress` node and restricting the ready set to it).

## Step 4 — Report

The workflow returns `{slug, stages, completed, stoppedAt, results}` — read `results.implement` for `{outcomes, allDone, blocked}`. Summarize: done nodes (with branches and rounds used), parked nodes (with `parkedReason` and the resume command `/strapped:implement <slug> --only <Did>`), blocked-pending children (the `blocked` list), and accumulated non-gating `suggestions` worth a human glance. If `allDone` is true, remind the user of `/strapped:pr <slug> --dry-run`. If the user gives corrective feedback here that generalizes, append it to `critiques/user-critiques.md` (`synthesized: false`).

Never merge to `main`, never push, never delete worktrees — those belong to `/strapped:pr` and the cleanup recipe.
