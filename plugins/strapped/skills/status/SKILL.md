---
name: status
description: Read-only dashboard for strapped runs — DAG, per-deliverable statuses, worktrees, branches, PRs, parked reasons, and the next runnable action
---

Render the state of strapped runs entirely from disk (formats in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`)). Your always-injected operating model is the slim `context.md` preamble (sentinel `strapped-preamble-v1`); do not front-load research or re-read the whole conventions on invocation — the procedure below is self-sufficient; pull the specific `conventions.md` section only at the step that needs the exact format. If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/context.md` to re-establish the operating model. Strictly read-only: no Edit/Write, no git mutations.

## Arguments

`$ARGUMENTS`: `[<slug>]`

- `<slug>` — omit to list all runs (see [No-slug mode](#no-slug-mode)).

## Locating the run root (cwd-independent)

Run the harness script (contract in the conventions' **Harness scripts** section):

```bash
node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>
```

It performs the conventions' *Cwd-independent slug → run-root resolution* (direct path keyed by slug, no glob, never the cwd — it may be a plans dir or `~`) and prints `{ slug, stateRoot, runRoot, runDir, manifest, exists, …, repos }`. Do not hand-roll the resolution.

If `exists` is `false` → stop with a helpful message (`slug <slug> not found under <stateRoot>`).

## Resolving the repos map

`resolve`'s `repos` array (from the **required** manifest `repos:` map) gives each repo's `name`, absolute `root`, `config` path, and config values. Every repo-scoped check for a deliverable resolves through `repos[<deliverable.repo>]`. Each deliverable's `repo:` field is required.

## With a slug

1. Run `node $PLUGIN_ROOT/scripts/state.mjs dag <runDir>` — its `manifest`, `nodes` (full per-deliverable frontmatter), `ready`, `topo`, `blocked`, and `remaining` are the dashboard's data source; never recompute ready-sets or topo order by hand. This skill uses ONLY the read commands `resolve` and `dag` — never `set`, `transition`, or `manifest-status` (strictly read-only).
2. Cross-check reality (report drift, don't fix it), running each git/gh check **in the deliverable's own repo** — resolve the node's repo root from `repos[<deliverable.repo>]` and pass `git -C <repoRoot> …`: does each recorded `worktree` path exist (`git -C <repoRoot> worktree list`)? Does each `branch` exist in that repo? For `pr-open` nodes, `gh pr view <url> --json state` when `gh` is available. Do not assume all deliverables share one repo.
3. Render:
   - Header: slug, manifest status, source plan, seed, budgets.
   - A **Repos** section: each target repo's `name → root` (an unordered set — no repo is marked special).
   - An ASCII DAG sketch with per-node status markers, grouped or labeled by repo where it aids reading.
   - A table: id, title, status, **repo**, deps, branch, worktree (✓/missing), PR, rounds used.
   - Parked nodes with `parked_reason` and their blocked descendants.
   - Latest review-round outcomes (plan rounds and per-deliverable code rounds) from `reviews/`. If a run has had feedback applied, also surface each node's `feedback_rounds_used` count alongside `review_rounds_used`, plus whether any deliverable carries a `## Feedback addendum` section (an optional audit record of an approved feedback plan).
   - Unsynthesized critique count from `critiques/user-critiques.md`.
## No-slug mode

List every run with one summary line each (slug, status, done/total deliverables), then stop: glob `<stateRoot>/runs/*/manifest.md` — a single tier that never touches `repos/` (its sibling dir). Show each run's target repos alongside its slug. To enumerate the outstanding (non-merged) work itself across every run — each deliverable with its repo root resolved — use the read-only batch primitive `node $PLUGIN_ROOT/scripts/state.mjs outstanding` (the same command the SessionStart sync job gathers from); scope it to one run with `outstanding <runDir>`.

## Next action

End with **Next action** — exactly one suggestion, the first that applies:
   - manifest `draft`/`in-review` → `/strapped:plan <source-plan>` (resume).
   - `approved`/`implementing` with runnable nodes → `/strapped:implement <slug>`.
   - parked nodes only → `/strapped:implement <slug> --only <Did>` after addressing the parked reason.
   - all done, PRs missing → `/strapped:pr <slug> --dry-run`.
   - unsynthesized critiques pending → `/strapped:learn`.
   - everything merged and synthesized → cleanup recipe from the conventions.
