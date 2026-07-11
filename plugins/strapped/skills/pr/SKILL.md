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
  - AskUserQuestion
---

Create/update stacked PRs for `done` deliverables of one strapped run. Formats and naming are in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`), which the plugin's SessionStart hook auto-injects as the **strapped preamble** — assume it is in context. If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/conventions.md` before proceeding. Cold-starts from the run root `<runRoot>/<slug>/` alone.

## Arguments

`$ARGUMENTS`: `<slug> [--dry-run] [--no-push] [--update]`

- `--dry-run`: print every git/gh command and every PR body; execute nothing.
- `--no-push`: prepare bodies and print commands but skip `git push` and `gh pr create` (alias-level equivalent of `--dry-run`; both mean nothing leaves this machine).
- `--update`: instead of creating PRs, propagate parent-branch changes down the stack (see below).

## Locating the run root (cwd-independent)

Resolve `<runRoot>/<slug>` from the `<slug>` alone, per the conventions' *Cwd-independent slug → run-root resolution* — a **direct path** keyed by slug, no glob, no fallback. **Never** consult the cwd: the run root is `<stateRoot>/runs/<slug>/`; probe `<stateRoot>/runs/<slug>/manifest.md`. Absent → stop (`slug <slug> not found under <stateRoot>`).

## Resolving the repos map

Read the manifest `repos:` map (**required**) — each entry gives a repo `name`, absolute `root`, and `config`. Resolve each deliverable's required `repo:` to its repo root via `repos[<deliverable.repo>]`; all of that deliverable's git/gh operations run in that repo (`git -C <repoRoot> …`).

## Create mode (default)

1. Read the manifest and all deliverable frontmatter; resolve the `repos:` map. Candidates: `status: done` nodes whose parents are all `done`, `pr-open`, or `merged`. Order them topologically (parents before children).
2. For each candidate, generate a PR body from the deliverable file:
   - One-paragraph summary (from the deliverable title + plan Context).
   - The acceptance criteria as a checklist.
   - A `## Stack` table of the whole DAG spanning **all** repos: id, title, **repo**, PR link (or `pending`), deps. Group or label rows by repo.
   - For non-roots **whose parent is in the same repo**: `Depends on #<parent PR number>` on its own line. A child in a *different* repo from its parent has no `Depends on #` line (there is no cross-repo branch stacking — it rooted on `main`). If a same-repo parent has no PR yet it is created earlier in this same topological pass, so the number exists by the time the child body is built.
3. Per node, resolve `<repoRoot>` = `repos[<deliverable.repo>].root` and run push/create **from that deliverable's own repo** (not the worktree, not some other repo). Base is the parent's branch **only when the parent is in the same repo**; a cross-repo child (or a root) bases on that repo's `main`:
   ```bash
   git -C <repoRoot> push -u origin <branch>
   gh -C <repoRoot> pr create --head <branch> --base <parent-branch-if-same-repo-else-main> --title "<Did>: <title>" --body-file <generated>
   ```
   (`gh` reads the repo from cwd; run it with the working directory set to `<repoRoot>`, e.g. `git -C <repoRoot> …` for git and invoke `gh` inside `<repoRoot>`.)
4. Write the returned PR URL into the deliverable frontmatter (`pr:`) and set `status: pr-open`. After all creations, refresh every stack table via `gh pr edit <num> --body-file <regenerated>` so earlier PRs link the later ones.
5. With `--dry-run`/`--no-push`: print steps 3–4's commands and full bodies instead of running them; change no frontmatter.

## Update mode (`--update`)

For when a parent branch changed after children branched (the only sanctioned way per the conventions' freeze rule). This is also the sanctioned cascade after `/strapped:feedback <slug>` applies review-feedback fixes on a parent branch: run `--update` ONCE for the whole batch to rebase/re-push the stacked children — the feedback flow changes no branches beyond the fix commits and never rebases itself.

The rebase applies to **same-repo parent→child edges only**. A cross-repo child (its `repo:` differs from its parent's) bases on its own repo's `main` — it never stacked on the parent's branch, so there is nothing to rebase. **Skip cross-repo edges entirely** in staleness detection and rebasing.

1. Detect stale children: for each **same-repo** edge parent→child (resolve both nodes' repos via the `repos:` map; skip the edge if they differ), if `git -C <repoRoot> merge-base <parent-branch> <child-branch>` is not the parent's tip, the child is stale. `<repoRoot>` = `repos[<child.repo>].root` (same as the parent's for a same-repo edge).
2. For each stale child, in topological order, inside the child's worktree (in the child's repo):
   ```bash
   git -C <childWorktree> rebase --onto <new-parent-tip> <old-parent-tip> <child-branch>
   git -C <childWorktree> push --force-with-lease
   ```
   `<old-parent-tip>` is the recorded merge-base from step 1. On rebase conflict: abort the rebase, mark the child `parked` with `parked_reason: "rebase conflict onto <parent>"`, and report — never force through a conflict.
3. Refresh PR bodies/bases with `gh pr edit` (run in each deliverable's own repo).

## Guardrails

- Never push `main`, never merge PRs, never `--force` (only `--force-with-lease`) — enforced **per repo** (every git op runs `-C <deliverableRepoRoot>`).
- If `gh` is unauthenticated or the branch has no commits beyond its base, report and skip that node rather than failing the whole run.
- When a PR is merged externally, a later invocation should notice via `gh pr view --json state` and flip frontmatter to `merged`. This also happens automatically at session start: the plugin's SessionStart hook runs `scripts/sync-prs.sh`, which performs the same idempotent flip.
