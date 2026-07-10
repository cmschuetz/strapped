---
name: status
description: Read-only dashboard for strapped runs — DAG, per-deliverable statuses, worktrees, branches, PRs, parked reasons, and the next runnable action
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

Render the state of strapped runs entirely from disk (formats in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`)). Strictly read-only: no Edit/Write, no git mutations.

## Arguments

`$ARGUMENTS`: `[<slug>]` — omit to list all runs under this repo's run root `<runRoot>/` (resolved per the conventions' Config resolution) with one summary line each (slug, status, done/total deliverables), then stop. In shared mode, other repos' runs live under sibling `<stateRoot>/<repo>/` roots.

## With a slug

1. Read `manifest.md` and every `deliverables/*.md` frontmatter.
2. Cross-check reality (report drift, don't fix it): does each recorded `worktree` path exist (`git worktree list`)? Does each `branch` exist? For `pr-open` nodes, `gh pr view <url> --json state` when `gh` is available.
3. Render:
   - Header: slug, manifest status, source plan, seed, budgets.
   - An ASCII DAG sketch with per-node status markers.
   - A table: id, title, status, deps, branch, worktree (✓/missing), PR, rounds used.
   - Parked nodes with `parked_reason` and their blocked descendants.
   - Latest review-round outcomes (plan rounds and per-deliverable code rounds) from `reviews/`.
   - Unsynthesized critique count from `critiques/user-critiques.md`.
4. End with **Next action** — exactly one suggestion, the first that applies:
   - manifest `draft`/`in-review` → `/strapped:plan <source-plan>` (resume).
   - `approved`/`implementing` with runnable nodes → `/strapped:implement <slug>`.
   - parked nodes only → `/strapped:implement <slug> --only <Did>` after addressing the parked reason.
   - all done, PRs missing → `/strapped:pr <slug> --dry-run`.
   - unsynthesized critiques pending → `/strapped:learn`.
   - everything merged and synthesized → cleanup recipe from the conventions.
