---
name: plan
description: Turn a large plans/<name>.md ask into a converged DAG implementation plan — research, adversarial rule-partitioned plan review loop, then interactive final review with the user
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Workflow
---

Turn one large source plan document into an approved, implementation-ready DAG of deliverables.

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, budgets, and procedures are defined in `$PLUGIN_ROOT/conventions.md` — read it first, every time. State lives in the **project being worked on** (the cwd), never in the plugin.

## Arguments

`$ARGUMENTS`: `<path-to-plan.md> [--seed N] [--max-rounds N]`

- `--seed` defaults to 42; recorded in the manifest so reviews are reproducible.
- `--max-rounds` defaults to the `plan_rounds` budget (3).

## Step 1 — Config, then scaffold or resume

Resolve `<repo>`, `stateRoot`, and the run root `<runRoot>` per the **Config resolution** section of the conventions (env → repo-local config → `~/.claude/strapped.json` anchor → `plans/strapped`; absolute → `<stateRoot>/<repo>/`, relative → `<stateRoot>/` in the repo). `<runRoot>` is where all run state lives — every path below uses it.

Ensure a per-repo config exists (repo-local `.claude/strapped-config.json`, else `<runRoot>/strapped-config.json`). If none does, generate one and confirm the values with the user before continuing:

```json
{
  "validations": ["<derived from the project CLAUDE.md validation/check commands>"],
  "worktreeRoot": "<repo-parent>/<repo-name>__worktrees",
  "provisioning": "<untracked files worktrees need for validations (placeholder values only, never real secrets), or empty>"
}
```

Write the new config to `<runRoot>/strapped-config.json` when `stateRoot` is a shared/absolute base (the default). If there is no anchor and no repo-local config, ask the user whether to set up a global anchor (`~/.claude/strapped.json` with their chosen `stateRoot`) or keep state repo-relative — only then finalize `<runRoot>` and where the config goes.

Derive the slug from the source plan filename (`plans/foo_bar.md` → `foo-bar`). If `<runRoot>/<slug>/manifest.md` exists, read its `status` and resume at the matching step below (`draft`/`in-review` → step 3; `approved` or later → tell the user this run is already approved and stop, pointing at `/strapped:status`). Otherwise scaffold:

```bash
mkdir -p <runRoot>/<slug>/{deliverables,reviews,critiques}
touch <runRoot>/<slug>/critiques/user-critiques.md
```

## Step 2 — Rule snapshot and per-round assignments

1. Extract the guideline rules per the conventions (discover every applicable CLAUDE.md, one numbered rule per normative imperative, skip validation-command boilerplate) and write `reviews/rules-snapshot.md`.
2. Compute the per-round rule split with the seeded-shuffle recipe from the conventions, adapted to emit full rule objects — for each round `1..max_rounds`, a `{"a": [{"id", "source", "text"}...], "b": [...]}` pair, shuffled with `random.Random(seed + round)` and split in half. Save the JSON output; it goes into the workflow args verbatim. Never use ad-hoc randomness — the seed is the only entropy source.

## Step 3 — Run the plan loop workflow

Invoke the `strapped-plan-loop` workflow — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/plan-loop.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (all paths absolute):

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "sourcePlan": "<abs path to the source plan.md>",
  "repoRoot": "<abs repo root>",
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "rulesByRound": [<the per-round splits from step 2>],
  "maxRounds": 3,
  "confidenceMin": 70,
  "seed": 42
}
```

The workflow runs the planner (which writes `research.md`, `manifest.md`, and the deliverable files), then up to `maxRounds` adversarial review rounds. It returns `{converged, rounds, deliverables, outstanding, summary}`.

## Step 4 — Handle the outcome

- **Converged**: proceed to step 5.
- **Not converged** (budget exhausted): do not proceed silently. Present the `outstanding` findings to the user with the round files as reference. Work through them with the user directly (main agent, no subagents) — either fix the plan yourself per their guidance or get their explicit okay to proceed despite a finding. Only then continue.

## Step 5 — Interactive final review with the user

Walk the user through the plan: theme summary, the DAG (render it), then each deliverable briefly. Apply their tweaks directly with Edit — **no subagents in this step**. For every substantive correction the user makes (anything expressible as a general guideline, not just a plan-specific tweak), append an entry to `critiques/user-critiques.md` per the conventions format with `synthesized: false`.

## Step 6 — Approve

Set `status: approved` in `manifest.md`. Tell the user the next command: `/strapped:implement <slug>`, and that `/strapped:status <slug>` shows state at any time.
