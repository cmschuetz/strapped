---
name: pr
description: Create or update the stacked GitHub PRs for a strapped run's DAG — child PRs based on their parent deliverable's branch, dependency-annotated bodies, dry-run support
---

Create/update stacked PRs for `done` deliverables of one strapped run. Formats and naming are in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`). Your always-injected operating model is the slim `context.md` preamble (sentinel `strapped-preamble-v1`); do not front-load research or re-read the whole conventions on invocation — the procedure below is self-sufficient; pull the specific `conventions.md` section only at the step that needs the exact format. If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/context.md` to re-establish the operating model. Cold-starts from the run root `<runRoot>/<slug>/` alone.

## Arguments

`$ARGUMENTS`: `<slug> [--only <Did>] [--dry-run] [--no-push] [--update]`

- `--only <Did>`: create mode only — scope the create pass to ONE deliverable: thread the id into `stageArgs.pr.only` in the dispatch below (the stage's gate probes `dag <runDir> --only <Did>` and its candidates are the scoped node plus its not-yet-PR'd done ancestors, per the conventions' **Stacked PRs** scoped-create rule). Combined with `--update` → stop with a message: scoped update is not supported (the rebase cascade stays run-wide).
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

The entire create pass lives in the `pr` stage of the `strapped-run` mono-workflow: one PR agent runs the conventions' **Stacked PRs** procedure mechanically through `state.mjs` (`resolve` for the repos map, `dag` for nodes + the authoritative `topo` order, then per created PR `set <file> pr <url>` and `transition <file> pr-open`), titles each PR per the conventions' **PR titles and bodies (Conventional Commits)** spec — the DEFAULT that defers: if a PR-title/commit convention is already established in context (repo config, the repo's CLAUDE.md, or the user's Claude settings/guidelines) it honors that instead, and only falls back to `<type>(<slug>): <description>` (run slug as scope, no `Dx:` prefix) when none is supplied — builds each body (imperative what/why prose, summary, acceptance-criteria checklist, cross-repo `## Stack` table, `Depends on #<parent PR>` for same-repo non-roots, breaking-change footer when applicable), refreshes every stack table after all creations, and carries the Guardrails below verbatim. Do not hand-roll any of it.

Dispatch the mono-workflow with a singleton stage list — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/strapped-run.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (full contract in the conventions' **Composable chains** section):

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "stages": ["pr"],
  "stageArgs": { "pr": { "dryRun": false, "only": "<the --only Did, else omit>" } },
  "scripts": { "state": "$PLUGIN_ROOT/scripts/state.mjs", "worktree": "$PLUGIN_ROOT/scripts/ensure-worktree.sh" },
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "seed": "<the manifest seed>", "confidenceMin": 70, "planRounds": 1, "codeRounds": 1
}
```

- With `--dry-run` or `--no-push`, set `stageArgs.pr.dryRun` to `true`: the agent prints every would-be git/gh/state command and full PR bodies, executes nothing that mutates, and changes no frontmatter.
- The stage is gated on every in-scope node being done-or-later: dispatched alone, it probes `state.mjs dag` (with `--only <Did>` when scoped) first and stops (returning `gateFailed: true` with the not-done nodes) when any in-scope node is earlier than `done`.
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
3. Refresh PR bodies/bases with `gh pr edit` (run in each deliverable's own repo), keeping the conventions' **PR titles and bodies (Conventional Commits)** format for any regenerated title/body as the default — unless a PR-title/commit convention already established in context (repo config, the repo's CLAUDE.md, or the user's Claude settings/guidelines) applies, which takes precedence.

### Feedback-index write-back (independent of the rebase)

After the rebase, run an **INDEPENDENT** pass over the run's [Feedback index](conventions.md#feedback-index) — this is NOT gated to same-repo children (the same-repo gating above governs the *rebase* only; the write-back keys off each comment's own stored `pr`/`threadId`, topology-free). Read the index once and act on every `addressed` comment with a **non-null** `threadId` (root, same-repo child, or cross-repo alike):

```bash
node $PLUGIN_ROOT/scripts/state.mjs feedback-index read <runDir>
# for each addressed comment with threadId != null, deriving {owner}/{repo}/{n} from its stored pr URL:
gh api --method POST repos/{owner}/{repo}/pulls/{n}/comments/{externalId}/replies -f body="Fixed in <sha>"
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<threadId>
node $PLUGIN_ROOT/scripts/state.mjs feedback-index set <runDir> <externalId> resolved
```

- Keep the reply **extremely short** — a few words plus the `commit` sha from the index entry.
- **Skip** `ignored`/`not_needed` comments (never written to GitHub) and **skip** null-`threadId` entries (review-body / global comments — no thread to resolve; they stay `addressed`).
- If `gh` is unauthenticated, **report-and-skip** the whole write-back — do not fail the run (Guardrails below).

## Guardrails

- Never push `main`, never merge PRs, never `--force` (only `--force-with-lease`) — enforced **per repo** (every git op runs `-C <deliverableRepoRoot>`).
- If `gh` is unauthenticated or the branch has no commits beyond its base, report and skip that node rather than failing the whole run.
- When a PR is merged externally, a later invocation should notice via `gh pr view --json state` and flip the frontmatter with `node $PLUGIN_ROOT/scripts/state.mjs transition <deliverableFile> merged`. That flip **auto-removes the deliverable's worktree** (and nulls `worktree`) as a best-effort side effect — the branch is deliberately KEPT (a still-open same-repo child needs it for `--update`), so the `/strapped:pr` path needs no separate cleanup step. This also happens automatically at session start: the plugin's SessionStart hook runs `scripts/sync-prs.sh`, which performs the same idempotent flip and an explicit worktree cleanup.
