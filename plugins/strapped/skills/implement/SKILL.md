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

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, naming, budgets, and recipes are in `$PLUGIN_ROOT/conventions.md` — read it first, every time. This skill cold-starts entirely from the run root `<runRoot>/<slug>/` (resolved per the conventions' Config resolution) plus the per-repo config — it needs no memory of the planning session.

## Arguments

`$ARGUMENTS`: `<slug> [--primary-repo <name>] [--only <Did>] [--max-rounds N]`

- `--primary-repo <name>` disambiguates when the same `<slug>` exists under more than one primary-repo namespace (see Step 0).
- `--only` restricts execution to one deliverable (used to resume a parked node after the user unblocks it).
- `--max-rounds` overrides the `code_rounds` budget (default from the manifest, 3).

## Step 0 — Locate the run root (cwd-independent)

`/strapped:implement` is invoked with only a `<slug>`, and the cwd may be a plans dir or anything unrelated to the work. Resolve `<runRoot>/<slug>` per the conventions' **Cwd-independent slug → run-root resolution** — NEVER derive the primary repo from `git rev-parse` on cwd:

- **Shared mode** (absolute `stateRoot`): glob `<stateRoot>/*/<slug>/manifest.md`.
  - **Zero** matches — stop with a helpful message: the slug was not found under `<stateRoot>` (point at `/strapped:plan`).
  - **Exactly one** match — its directory is `<runRoot>/<slug>`; its parent is `<runRoot> = <stateRoot>/<primaryRepo>/`.
  - **More than one** match (same slug under two primary-repo namespaces) — present the matched primary-repo namespaces via **AskUserQuestion** and select `<stateRoot>/<chosen>/<slug>/` from the answer. When `--primary-repo <name>` is given, skip the prompt and use that path directly.
- **Legacy repo-relative mode** (relative `stateRoot`): `<runRoot>/<slug>` = `<repoAbs>/<stateRoot>/<slug>/` for the current repo (state is already repo-scoped, so cwd resolution is correct here).

## Step 1 — Cold-start from disk

Read `manifest.md` (must be `status: approved` or `implementing` — otherwise stop and say why) and every `deliverables/*.md` frontmatter. Set manifest `status: implementing` if not already. Build the DAG from the manifest `deliverables` list; per-node truth (status, branch, worktree, rounds used) comes from the deliverable files only.

**Resolve every target repo's config.** Read the manifest `repos:` map. For **each** repo in it, resolve that repo's per-repo config per the conventions' Config resolution — parameterized by repo name+root, first match wins: `<rAbs>/.claude/strapped-config.json`, else shared-mode `<stateRoot>/<repo>/strapped-config.json`. Build a lookup `repo → { root, validations, worktreeRoot, provisioning }`. If any target repo's config is missing, stop and point the user at `/strapped:plan`, which generates one per repo.

**Legacy on-disk back-compat.** If the manifest has **no** `repos:` map (a run predating this re-spec), treat the run as single-repo per the conventions' Legacy on-disk back-compat: synthesize a one-entry `repos:` map whose sole primary repo is derived from the resolved run root (the `<primaryRepo>` segment of `<stateRoot>/<primaryRepo>/<slug>/` in shared mode, or the current repo in legacy mode), flagged `primary: true`; resolve that repo's config normally and proceed. Do NOT stop as "config missing" for such a run — stop only if the synthesized primary's own config cannot be resolved.

## Step 2 — Rule assignments

As in /strapped:plan: read `reviews/rules-snapshot.md` (re-extract if missing), compute the per-round rule splits (full rule objects) for rounds `1..code_rounds` using `random.Random(seed + round)` from the manifest seed.

## Step 3 — Wave loop

Repeat until no deliverable is runnable:

1. **Ready set**: deliverables with `status: pending` (or `parked`/`in-progress` when named by `--only`) whose deps are all `done` or later (`pr-open`, `merged`). If `--only` was given, intersect with it. If the ready set is empty and nothing is `in-progress`, stop.
2. **Worktrees** (idempotent, per the conventions). For each ready node, read its `repo:` frontmatter (default to the synthesized primary when absent, per the legacy back-compat in Step 1) and look up that repo's `{ root, worktreeRoot, provisioning }` from Step 1. The worktree path is `<worktreeRoot>/<slug>/<Did>`.
   - If `worktree` frontmatter is set and the path exists with the right branch (scoped to this deliverable's repo), reuse it.
   - Otherwise run `git -C <repoRoot> worktree add <worktreeRoot>/<slug>/<Did> -b <branch> <base>` **inside that repo's root**. `<base>` follows the conventions' cross-repo base rule: the parent deliverable's branch **when the parent is in the same repo**; otherwise (a root, or a cross-repo parent) that repo's `main`.
   - Write `worktree` and set `status: in-progress` in the frontmatter. Apply that repo's config `provisioning` instructions to the fresh worktree (placeholder values only — never real secrets).
3. **Resume note**: for a node being re-dispatched (was `in-progress`, `fixing`, or `parked`), compose a short `resumeNote` string from its frontmatter (`parked_reason`, `review_rounds_used`) and the latest `reviews/<Did>-code-round-*.md` — open findings and what was already done.
4. **Dispatch** the `strapped-implement-wave` workflow — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/implement-wave.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (absolute paths):

Each `items[]` entry carries its own repo context (`repo`, `repoRoot`, and that repo's `validations`) — there is no single global `repoRoot`/`validations` used for execution.

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "primaryRepoRoot": "<abs primary repo root, for messaging only>",
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "items": [
    { "id": "D1", "repo": "<repoName>", "repoRoot": "<abs repo root for D1's repo>", "validations": [<that repo's validations>], "planFile": "<abs>", "worktree": "<abs>", "branch": "strapped/<slug>/D1-...", "base": "main", "resumeNote": null }
  ],
  "codeReviewScript": "$PLUGIN_ROOT/workflows/code-review.js",
  "codeRounds": 3,
  "confidenceMin": 70,
  "seed": 42,
  "rulesByRound": [<per-round splits from step 2>]
}
```

5. **Apply outcomes** to each deliverable's frontmatter: `done` → `status: done`; `parked` → `status: parked`, `parked_reason: <reason>`; always update `review_rounds_used`. A parked node's children stay `pending` — they are simply never ready.
6. Recompute the ready set (children of newly-`done` nodes become eligible) and loop.

## Step 4 — Report

Summarize: done nodes (with branches and rounds used), parked nodes (with reasons and the resume command `/strapped:implement <slug> --only <Did>`), blocked-pending children, and accumulated non-gating suggestions worth a human glance. If everything is `done`, remind the user of `/strapped:pr <slug> --dry-run`. If the user gives corrective feedback here that generalizes, append it to `critiques/user-critiques.md` (`synthesized: false`).

Never merge to `main`, never push, never delete worktrees — those belong to `/strapped:pr` and the cleanup recipe.
