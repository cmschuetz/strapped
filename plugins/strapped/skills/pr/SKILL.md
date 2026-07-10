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
---

Create/update stacked PRs for `done` deliverables of one strapped run. Formats and naming are in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`) — read it first. Cold-starts from the run root `<runRoot>/<slug>/` alone (`<runRoot>` resolved per the conventions' Config resolution).

## Arguments

`$ARGUMENTS`: `<slug> [--dry-run] [--no-push] [--update]`

- `--dry-run`: print every git/gh command and every PR body; execute nothing.
- `--no-push`: prepare bodies and print commands but skip `git push` and `gh pr create` (alias-level equivalent of `--dry-run`; both mean nothing leaves this machine).
- `--update`: instead of creating PRs, propagate parent-branch changes down the stack (see below).

## Create mode (default)

1. Read the manifest and all deliverable frontmatter. Candidates: `status: done` nodes whose parents are all `done`, `pr-open`, or `merged`. Order them topologically (parents before children).
2. For each candidate, generate a PR body from the deliverable file:
   - One-paragraph summary (from the deliverable title + plan Context).
   - The acceptance criteria as a checklist.
   - A `## Stack` table of the whole DAG: id, title, PR link (or `pending`), deps.
   - For non-roots: `Depends on #<parent PR number>` on its own line. If a parent has no PR yet it is created earlier in this same topological pass, so the number exists by the time the child body is built.
3. Per node, from the primary repo (not the worktree):
   ```bash
   git push -u origin <branch>
   gh pr create --head <branch> --base <parent-branch-or-main> --title "<Did>: <title>" --body-file <generated>
   ```
4. Write the returned PR URL into the deliverable frontmatter (`pr:`) and set `status: pr-open`. After all creations, refresh every stack table via `gh pr edit <num> --body-file <regenerated>` so earlier PRs link the later ones.
5. With `--dry-run`/`--no-push`: print steps 3–4's commands and full bodies instead of running them; change no frontmatter.

## Update mode (`--update`)

For when a parent branch changed after children branched (the only sanctioned way per the conventions' freeze rule):

1. Detect stale children: for each edge parent→child, if `git merge-base <parent-branch> <child-branch>` is not the parent's tip, the child is stale.
2. For each stale child, in topological order, inside the child's worktree:
   ```bash
   git rebase --onto <new-parent-tip> <old-parent-tip> <child-branch>
   git push --force-with-lease
   ```
   `<old-parent-tip>` is the recorded merge-base from step 1. On rebase conflict: abort the rebase, mark the child `parked` with `parked_reason: "rebase conflict onto <parent>"`, and report — never force through a conflict.
3. Refresh PR bodies/bases with `gh pr edit`.

## Guardrails

- Never push `main`, never merge PRs, never `--force` (only `--force-with-lease`).
- If `gh` is unauthenticated or the branch has no commits beyond its base, report and skip that node rather than failing the whole run.
- When a PR is merged externally, a later invocation should notice via `gh pr view --json state` and flip frontmatter to `merged`. This also happens automatically at session start: the plugin's SessionStart hook runs `scripts/sync-prs.sh`, which performs the same idempotent flip.
