---
name: status
description: Read-only dashboard for strapped runs — DAG, per-deliverable statuses, worktrees, branches, PRs, parked reasons, and the next runnable action
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---

Render the state of strapped runs entirely from disk (formats in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`)). Strictly read-only: no Edit/Write, no git mutations.

## Arguments

`$ARGUMENTS`: `[<slug>]`

- `<slug>` — omit to list all runs (see [No-slug mode](#no-slug-mode)).

## Locating the run root (cwd-independent)

Resolve `<runRoot>/<slug>` from the `<slug>` alone, per the conventions' *Cwd-independent slug → run-root resolution* — a **direct path** keyed by slug, no glob, no fallback. **Never** consult the cwd — it may be a plans dir or `~`:

- **Shared mode** (absolute `stateRoot`): the run root is `<stateRoot>/runs/<slug>/`; probe `<stateRoot>/runs/<slug>/manifest.md`.
- **Repo-relative mode** (relative `stateRoot`): the run root is `<repoAbs>/<stateRoot>/runs/<slug>/`; probe `<repoAbs>/<stateRoot>/runs/<slug>/manifest.md` for the current repo.

If `manifest.md` is absent → stop with a helpful message (`slug <slug> not found under <stateRoot>`).

## Resolving the repos map

Read the manifest `repos:` map (**required**) — each entry gives a repo `name`, absolute `root`, and `config` path. Every repo-scoped check for a deliverable resolves through `repos[<deliverable.repo>]`. Each deliverable's `repo:` field is required.

## With a slug

1. Read `manifest.md` and every `deliverables/*.md` frontmatter. Resolve the `repos:` map.
2. Cross-check reality (report drift, don't fix it), running each git/gh check **in the deliverable's own repo** — resolve the node's repo root from `repos[<deliverable.repo>]` and pass `git -C <repoRoot> …`: does each recorded `worktree` path exist (`git -C <repoRoot> worktree list`)? Does each `branch` exist in that repo? For `pr-open` nodes, `gh pr view <url> --json state` when `gh` is available. Do not assume all deliverables share one repo.
3. Render:
   - Header: slug, manifest status, source plan, seed, budgets.
   - A **Repos** section: each target repo's `name → root` (an unordered set — no repo is marked special).
   - An ASCII DAG sketch with per-node status markers, grouped or labeled by repo where it aids reading.
   - A table: id, title, status, **repo**, deps, branch, worktree (✓/missing), PR, rounds used.
   - Parked nodes with `parked_reason` and their blocked descendants.
   - Latest review-round outcomes (plan rounds and per-deliverable code rounds) from `reviews/`.
   - Unsynthesized critique count from `critiques/user-critiques.md`.
## No-slug mode

List every run with one summary line each (slug, status, done/total deliverables), then stop.

- **Shared mode:** glob `<stateRoot>/runs/*/manifest.md` — a single tier that never touches `repos/` (its sibling dir). Show each run's target repos alongside its slug.
- **Repo-relative mode:** glob `<repoAbs>/<stateRoot>/runs/*/manifest.md` for the current repo.

## Next action

End with **Next action** — exactly one suggestion, the first that applies:
   - manifest `draft`/`in-review` → `/strapped:plan <source-plan>` (resume).
   - `approved`/`implementing` with runnable nodes → `/strapped:implement <slug>`.
   - parked nodes only → `/strapped:implement <slug> --only <Did>` after addressing the parked reason.
   - all done, PRs missing → `/strapped:pr <slug> --dry-run`.
   - unsynthesized critiques pending → `/strapped:learn`.
   - everything merged and synthesized → cleanup recipe from the conventions.
