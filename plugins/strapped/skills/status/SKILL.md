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

`$ARGUMENTS`: `[<slug>] [--primary-repo <name>]`

- `<slug>` — omit to list all runs (see [No-slug mode](#no-slug-mode)).
- `--primary-repo <name>` — disambiguator used only when a `<slug>` resolves to more than one primary-repo namespace under `<stateRoot>` (see below).

## Locating the run root (cwd-independent)

Resolve `<runRoot>/<slug>` from the `<slug>` alone, per the conventions' *Cwd-independent slug → run-root resolution*. **Never** derive the primary repo from `git rev-parse` on the cwd — the cwd may be a plans dir or `~`:

- **Shared mode** (absolute `stateRoot`): glob `<stateRoot>/*/<slug>/manifest.md`.
  - Zero matches → stop with a helpful message (`slug <slug> not found under <stateRoot>`).
  - Exactly one → use its directory as `<runRoot>/<slug>`.
  - More than one (same slug under two primary-repo namespaces) → stop and ask the user to disambiguate; honor `--primary-repo <name>` to select `<stateRoot>/<name>/<slug>/`.
- **Legacy repo-relative mode** (relative `stateRoot`): `<runRoot>` = `<repoAbs>/<stateRoot>/` for the current repo; state at `<runRoot>/<slug>/`.

## Resolving the repos map

Read the manifest `repos:` map — each entry gives a repo `name`, absolute `root`, `config` path, and the `primary` flag. Every repo-scoped check for a deliverable resolves through `repos[<deliverable.repo>]`.

**Legacy on-disk back-compat** (per the conventions' *Legacy on-disk back-compat*): when `repos:` is absent, synthesize a single-entry map whose sole entry is the primary repo derived from the resolved run root (the `<primaryRepo>` path segment in shared mode, or the current repo in legacy mode), flagged `primary: true`, its root/config resolved via the normal per-repo config resolution. When a deliverable has no `repo:` field, default it to that synthesized primary. A pre-existing single-repo run thus still renders unchanged.

## With a slug

1. Read `manifest.md` and every `deliverables/*.md` frontmatter. Resolve the `repos:` map (synthesizing per the back-compat rule when absent).
2. Cross-check reality (report drift, don't fix it), running each git/gh check **in the deliverable's own repo** — resolve the node's repo root from `repos[<deliverable.repo>]` and pass `git -C <repoRoot> …`: does each recorded `worktree` path exist (`git -C <repoRoot> worktree list`)? Does each `branch` exist in that repo? For `pr-open` nodes, `gh pr view <url> --json state` when `gh` is available. Do not assume all deliverables share one repo.
3. Render:
   - Header: slug, manifest status, source plan, seed, budgets.
   - A **Repos** section: each target repo's `name → root`, with the primary marked; for a synthesized single-repo (legacy) run, show the one repo.
   - An ASCII DAG sketch with per-node status markers, grouped or labeled by repo where it aids reading.
   - A table: id, title, status, **repo**, deps, branch, worktree (✓/missing), PR, rounds used.
   - Parked nodes with `parked_reason` and their blocked descendants.
   - Latest review-round outcomes (plan rounds and per-deliverable code rounds) from `reviews/`.
   - Unsynthesized critique count from `critiques/user-critiques.md`.
## No-slug mode

List every run with one summary line each (slug, status, done/total deliverables), then stop.

- **Shared mode:** discover runs across **all** repos — glob `<stateRoot>/*/*/manifest.md` (every `<primaryRepo>/<slug>/`), not just the cwd/primary repo. Show each run's primary repo alongside its slug.
- **Legacy repo-relative mode:** list runs under the current repo's `<runRoot>/*` as before.

## Next action

End with **Next action** — exactly one suggestion, the first that applies:
   - manifest `draft`/`in-review` → `/strapped:plan <source-plan>` (resume).
   - `approved`/`implementing` with runnable nodes → `/strapped:implement <slug>`.
   - parked nodes only → `/strapped:implement <slug> --only <Did>` after addressing the parked reason.
   - all done, PRs missing → `/strapped:pr <slug> --dry-run`.
   - unsynthesized critiques pending → `/strapped:learn`.
   - everything merged and synthesized → cleanup recipe from the conventions.
