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
---

Implement an approved strapped plan.

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, naming, budgets, and recipes are in `$PLUGIN_ROOT/conventions.md` — read it first, every time. This skill cold-starts entirely from the project's `<stateRoot>/<slug>/` (from `.claude/strapped-config.json`, default `plans/strapped`) plus that config — it needs no memory of the planning session.

## Arguments

`$ARGUMENTS`: `<slug> [--only <Did>] [--max-rounds N]`

- `--only` restricts execution to one deliverable (used to resume a parked node after the user unblocks it).
- `--max-rounds` overrides the `code_rounds` budget (default from the manifest, 3).

## Step 1 — Cold-start from disk

Read `manifest.md` (must be `status: approved` or `implementing` — otherwise stop and say why) and every `deliverables/*.md` frontmatter. Set manifest `status: implementing` if not already. Build the DAG from the manifest `deliverables` list; per-node truth (status, branch, worktree, rounds used) comes from the deliverable files only.

Read the project config `.claude/strapped-config.json` (`validations`, `worktreeRoot`, `provisioning`). If it is missing, stop and point the user at `/strapped:plan`, which generates it.

## Step 2 — Rule assignments

As in /strapped:plan: read `reviews/rules-snapshot.md` (re-extract if missing), compute the per-round rule splits (full rule objects) for rounds `1..code_rounds` using `random.Random(seed + round)` from the manifest seed.

## Step 3 — Wave loop

Repeat until no deliverable is runnable:

1. **Ready set**: deliverables with `status: pending` (or `parked`/`in-progress` when named by `--only`) whose deps are all `done` or later (`pr-open`, `merged`). If `--only` was given, intersect with it. If the ready set is empty and nothing is `in-progress`, stop.
2. **Worktrees** (idempotent, per the conventions): for each ready node, if `worktree` frontmatter is set and the path exists with the right branch, reuse it; otherwise `git worktree add <path> -b <branch> <base>` where `<base>` is the parent deliverable's branch (roots: `main`). Write `worktree` and set `status: in-progress` in the frontmatter. Apply the config's `provisioning` instructions to the fresh worktree (placeholder values only — never real secrets).
3. **Resume note**: for a node being re-dispatched (was `in-progress`, `fixing`, or `parked`), compose a short `resumeNote` string from its frontmatter (`parked_reason`, `review_rounds_used`) and the latest `reviews/<Did>-code-round-*.md` — open findings and what was already done.
4. **Dispatch** the `strapped-implement-wave` workflow — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/implement-wave.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (absolute paths):

```json
{
  "slug": "<slug>",
  "dir": "<abs>/<stateRoot>/<slug>",
  "repoRoot": "<abs repo root>",
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "items": [
    { "id": "D1", "planFile": "<abs>", "worktree": "<abs>", "branch": "strapped/<slug>/D1-...", "base": "main", "resumeNote": null }
  ],
  "codeReviewScript": "$PLUGIN_ROOT/workflows/code-review.js",
  "codeRounds": 3,
  "confidenceMin": 70,
  "seed": 42,
  "rulesByRound": [<per-round splits from step 2>],
  "validations": [<the validations array from .claude/strapped-config.json>]
}
```

5. **Apply outcomes** to each deliverable's frontmatter: `done` → `status: done`; `parked` → `status: parked`, `parked_reason: <reason>`; always update `review_rounds_used`. A parked node's children stay `pending` — they are simply never ready.
6. Recompute the ready set (children of newly-`done` nodes become eligible) and loop.

## Step 4 — Report

Summarize: done nodes (with branches and rounds used), parked nodes (with reasons and the resume command `/strapped:implement <slug> --only <Did>`), blocked-pending children, and accumulated non-gating suggestions worth a human glance. If everything is `done`, remind the user of `/strapped:pr <slug> --dry-run`. If the user gives corrective feedback here that generalizes, append it to `critiques/user-critiques.md` (`synthesized: false`).

Never merge to `main`, never push, never delete worktrees — those belong to `/strapped:pr` and the cleanup recipe.
