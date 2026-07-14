---
name: pr
description: Create or update the stacked GitHub PRs for a strapped run's DAG — child PRs based on their parent deliverable's branch, dependency-annotated bodies, dry-run support
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

Create/update stacked PRs for `done` deliverables of one strapped run. Formats and naming are in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`), which the plugin's SessionStart hook auto-injects as the **strapped preamble** — assume it is in context. If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/conventions.md` before proceeding. Cold-starts from the run root `<runRoot>/<slug>/` alone.

## Arguments

`$ARGUMENTS`: `<slug> [--dry-run] [--no-push] [--update]`

- `--dry-run`: print every git/gh command and every PR body; execute nothing.
- `--no-push`: prepare bodies and print commands but skip `git push` and `gh pr create` (alias-level equivalent of `--dry-run`; both mean nothing leaves this machine).
- `--update`: instead of creating PRs, propagate parent-branch changes down the stack (see below).

## Locating the run root (cwd-independent)

Run the harness script (contract in the conventions' **Harness scripts** section):

```bash
node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>
```

It performs the conventions' *Cwd-independent slug → run-root resolution* (direct path keyed by slug, no glob, never the cwd) and prints `{ slug, stateRoot, runRoot, runDir, manifest, exists, …, repos }`. If `exists` is `false` → stop (`slug <slug> not found under <stateRoot>`). Do not hand-roll the resolution.

## Resolving the repos map

`resolve`'s `repos` array (from the **required** manifest `repos:` map) gives each repo's `name`, absolute `root`, and `config`. Resolve each deliverable's required `repo:` to its repo root via `repos[<deliverable.repo>]`; all of that deliverable's git/gh operations run in that repo (`git -C <repoRoot> …`).

## Create mode (default)

The entire create pass lives in the `pr` stage of the `strapped-run` mono-workflow: one PR agent runs the conventions' **Stacked PRs** procedure mechanically through `state.mjs` (`resolve` for the repos map, `dag` for nodes + the authoritative `topo` order, then per created PR `set <file> pr <url>` and `transition <file> pr-open`), builds each body (summary, acceptance-criteria checklist, cross-repo `## Stack` table, `Depends on #<parent PR>` for same-repo non-roots), refreshes every stack table after all creations, then `state.mjs snapshot`s the `stateRoot` git repo at the PR-create boundary (see the conventions' **State as a git repository** section; skipped under `--dry-run`), and carries the Guardrails below verbatim. Do not hand-roll any of it.

Dispatch the mono-workflow with a singleton stage list — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/strapped-run.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (full contract in the conventions' **Composable chains** section):

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "stages": ["pr"],
  "stageArgs": { "pr": { "dryRun": false } },
  "scripts": { "state": "$PLUGIN_ROOT/scripts/state.mjs", "worktree": "$PLUGIN_ROOT/scripts/ensure-worktree.sh" },
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "seed": 42, "confidenceMin": 70, "planRounds": 3, "codeRounds": 3
}
```

- With `--dry-run` or `--no-push`, set `stageArgs.pr.dryRun` to `true`: the agent prints every would-be git/gh/state command and full PR bodies, executes nothing that mutates, and changes no frontmatter.
- The stage is gated on every node being done-or-later: dispatched alone, it probes `state.mjs dag` first and stops (returning `gateFailed: true` with the not-done nodes) when any node is earlier than `done`.
- Read `results.pr` from the return — `{prs: [{id, url, skipped, reason}], summary, dryRun}` — and report created vs skipped PRs (with reasons) to the user.

## Update mode (`--update`)

For when a parent branch changed after children branched (the only sanctioned way per the conventions' freeze rule). This is also the sanctioned cascade after `/strapped:feedback <slug>` applies review-feedback fixes on a parent branch: run `--update` ONCE for the whole batch to rebase/re-push the stacked children — the feedback flow changes no branches beyond the fix commits and never rebases itself.

The rebase applies to **same-repo parent→child edges only**. A cross-repo child (its `repo:` differs from its parent's) bases on its own repo's `main` — it never stacked on the parent's branch, so there is nothing to rebase. **Skip cross-repo edges entirely** in staleness detection and rebasing.

1. Detect stale children: for each **same-repo** edge parent→child (resolve both nodes' repos via the `repos:` map; skip the edge if they differ), if `git -C <repoRoot> merge-base <parent-branch> <child-branch>` is not the parent's tip, the child is stale. `<repoRoot>` = `repos[<child.repo>].root` (same as the parent's for a same-repo edge).
2. For each stale child, in topological order, inside the child's worktree (in the child's repo):
   ```bash
   git -C <childWorktree> rebase --onto <new-parent-tip> <old-parent-tip> <child-branch>
   git -C <childWorktree> push --force-with-lease
   ```
   `<old-parent-tip>` is the recorded merge-base from step 1. On rebase conflict: abort the rebase, park the child via `node $PLUGIN_ROOT/scripts/state.mjs transition <deliverableFile> parked` plus `node $PLUGIN_ROOT/scripts/state.mjs set <deliverableFile> parked_reason "rebase conflict onto <parent>"`, and report — never force through a conflict.
3. Refresh PR bodies/bases with `gh pr edit` (run in each deliverable's own repo).

## Guardrails

- Never push `main`, never merge PRs, never `--force` (only `--force-with-lease`) — enforced **per repo** (every git op runs `-C <deliverableRepoRoot>`).
- If `gh` is unauthenticated or the branch has no commits beyond its base, report and skip that node rather than failing the whole run.
- When a PR is merged externally, a later invocation should notice via `gh pr view --json state` and flip the frontmatter with `node $PLUGIN_ROOT/scripts/state.mjs transition <deliverableFile> merged`. This also happens automatically at session start: the plugin's SessionStart hook runs `scripts/sync-prs.sh`, which performs the same idempotent flip.
