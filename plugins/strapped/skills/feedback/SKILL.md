---
name: feedback
description: Turn a strapped run's PR review comments into reviewed, approved, implemented fixes — fetch comments across all in-scope PRs, synthesize cross-deliverable addenda, run the adversarial plan-review loop, gate on explicit approval, then apply fixes on the existing branches and offer the --update cascade
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

Drive PR review comments back into the plan→implement lifecycle for one strapped run. This skill hand-rolls no planning or fix logic: it fetches review comments, then dispatches the `strapped-run` mono-workflow's `feedback-synth` stage (synthesis of cross-deliverable **addenda** onto EXISTING deliverable files + the SAME adversarial review loop the run's original plan used), gates on explicit user approval, then dispatches the same mono-workflow's `implement` stage in `addendumMode` to apply the fixes on each affected deliverable's EXISTING branch/worktree. It mints NO new deliverables/branches/worktrees and never force-pushes or merges — shipping stays a user-approved `/strapped:pr <slug> --update`.

**GitHub via `gh`.** All PR data comes from `gh`; there is no GitLab/`glab` path.

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, naming, budgets, and recipes are in `$PLUGIN_ROOT/conventions.md`, which the plugin's SessionStart hook auto-injects as the **strapped preamble** — assume it is in context (in particular the **Feedback loop** section). If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/conventions.md` before proceeding. This skill cold-starts entirely from the run root `<runRoot>/<slug>/` plus the per-repo config.

## Arguments

`$ARGUMENTS`: `<slug> [--deliverable <Did>]... [--pr <url>]... [--dry-run] [--max-rounds N]`

- `--deliverable <Did>` — **repeatable**; narrows the in-scope set to the named deliverable(s).
- `--pr <url>` — **repeatable**; narrows to the given PR URL(s).
- When neither narrowing flag is given, the in-scope set is every deliverable with a `pr:` URL that has at least one review comment or a request-changes/comment review.
- `--dry-run` — fetch, synthesize, review, print the plan and the commands that WOULD run, then stop; mutate nothing (no addenda written, no implementation, no branch changes).
- `--max-rounds N` — overrides both the plan-review budget (for the addenda review) and the code-review budget (for the fix path); defaults to the manifest's `plan_rounds`/`code_rounds` (3).

## Step 0 — Locate the run root (cwd-independent)

Run the harness script (contract in the conventions' **Harness scripts** section):

```bash
node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>
```

It performs the conventions' **Cwd-independent slug → run-root resolution** (direct path keyed by slug, no glob, never the cwd) and prints `{ slug, stateRoot, runRoot, runDir, manifest, exists, status, seed, budgets, repos }`. Do not hand-roll the resolution.

If `exists` is `false`, stop with a helpful message (slug not found under `<stateRoot>`; point at `/strapped:plan`).

## Step 1 — Cold-start from disk

Step 0's `resolve` output already carries the manifest `seed`/`budgets` and the per-repo configs: its `repos` array (from the **required** manifest `repos:` map) gives per repo `{ name, root, config, configExists, validations, worktreeRoot, provisioning }` — the lookup `repo → { root, validations, worktreeRoot, provisioning }`. Read every deliverable's frontmatter (status, deps, branch, worktree, pr, repo) via `node $PLUGIN_ROOT/scripts/state.mjs dag <runDir>` — its `nodes` array is the per-node truth and its `topo` is the stack order Step 6 needs. Each deliverable's `repo:` field is required and names one of the `repos:` entries.

Determine the **in-scope deliverable set**: every deliverable with a non-null `pr:` URL, intersected with `--deliverable`/`--pr` filters if given. A deliverable in scope is expected to be at `status: pr-open` (its PR is open, typically with changes requested — the same review `scripts/sync-prs.sh` warns on).

## Step 2 — Rule snapshot and per-round assignments

As in `/strapped:plan` and `/strapped:implement` (workflows cannot use `Math.random()`, so the split is computed skill-side):

1. Read `reviews/rules-snapshot.md` (re-extract per the conventions' **Rule extraction** if missing).
2. Compute the per-round rule split with the conventions' **Seeded rule split** recipe — for each round `1..max_rounds`, a `{"a": [{"id","source","text"}...], "b": [...]}` pair shuffled with `random.Random(seed + round)` (seed from the manifest). Save the JSON — it becomes `rulesByRound`.

This single `rulesByRound` (plus `seed`, `confidenceMin`, `planRounds`, `codeRounds`) is threaded into BOTH mono-workflow dispatches — the `feedback-synth` stage (the addenda review loop consumes it at `rulesByRound[round-1]`) AND the Step 6 `implement` stage (the code-review/fix loop consumes it the same way). Omitting it makes the adversarial reviewers receive `undefined` rule halves.

## Step 3 — Fetch PR review comments (GitHub via `gh`)

For each in-scope deliverable, derive `{owner}/{repo}/{n}` from its stored `pr:` URL and fetch ALL THREE categories:

1. **Line-anchored review comments**:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{n}/comments --paginate
   ```
   Capture `path`, `line`/`original_line`, `diff_hunk`, `body`, `user.login`, `in_reply_to_id`.
2. **Review-SUBMISSION bodies** (a DISTINCT third category — the summary a reviewer types on submit):
   ```bash
   gh api repos/{owner}/{repo}/pulls/{n}/reviews --paginate
   ```
   Capture `state` (APPROVED / CHANGES_REQUESTED / COMMENTED) and `body`. Feed each **non-empty** submission `body` — especially a CHANGES_REQUESTED one — into synthesis as GLOBAL feedback for that deliverable.
3. **Global/issue comments**:
   ```bash
   gh pr view <url> --json comments
   ```

Group the fetched comments by the deliverable whose PR they were left on, but CARRY the anchored `path` on each so synthesis can reassign a comment cross-deliverable. Build a `comments` array of `{ deliverableId, pr, lineComments: [...], reviewBodies: [{state, body}], issueComments: [...] }` to pass to the workflow.

If `gh` is unauthenticated, stop and tell the user to `gh auth login`. If no in-scope PR has any comment/review, report that there is no feedback to process and stop.

## Step 4 — Synthesize + review the addenda

Dispatch the `strapped-run` mono-workflow with a singleton stage list — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/strapped-run.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (all paths absolute; full contract in the conventions' **Composable chains** section):

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "stages": ["feedback-synth"],
  "stageArgs": {
    "feedback-synth": {
      "comments": [<the fetched comments from Step 3>],
      "repos": [ { "name": "<repo>", "root": "<abs>" } ]
    }
  },
  "scripts": { "state": "$PLUGIN_ROOT/scripts/state.mjs", "worktree": "$PLUGIN_ROOT/scripts/ensure-worktree.sh" },
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "rulesByRound": [<per-round splits from Step 2>],
  "planRounds": 3,
  "codeRounds": 3,
  "confidenceMin": 70,
  "seed": 42
}
```

The `feedback-synth` stage (a) synthesizes ONE consolidated cross-deliverable plan — routing each comment to the deliverable that OWNS the anchored file (which may differ from the PR it was left on) via each deliverable's `Files to touch` map — writing a `## Feedback addendum` section into each affected EXISTING deliverable file, then (b) runs the mono-workflow's shared review loop (ask = the fetched PR review comments; artifact = the amended deliverable set; `roundFilePrefix: feedback-round`), so the addenda pass through the SAME reviewers/refute/dedup/consolidate/revise cycle + the confirmation pass, writing `reviews/feedback-round-<N>.md` records (distinct from `plan-round-*`). Never dispatch the `plan` stage here (that would run the planner and clobber the addenda). Read `results["feedback-synth"]` from the return — `{ converged, rounds, outstanding, addenda, summary }`. Honor `--max-rounds` via `planRounds`.

**With `--dry-run`:** the synthesis/review still runs to produce the plan, but you must NOT let it mutate the run — pass `--dry-run` intent by NOT writing addenda: instead, run only the fetch + a synthesis DRAFT in-conversation, print the routed addenda plan and the commands that WOULD run, then stop. (Do not dispatch the mutating workflow under `--dry-run`.)

If the review did **not** converge (budget exhausted), present `outstanding` with the `feedback-round-*.md` files and work through them with the user before proceeding.

## Step 5 — Explicit user approval gate

Present the converged feedback plan via **AskUserQuestion**: a per-deliverable summary of what will change, cross-deliverable reassignments called out explicitly (a comment left on PR X routed to deliverable Y), the topological (stack) implement order, and the anticipated `/strapped:pr <slug> --update` cascade. Apply the user's tweaks directly with Edit — **no subagents in this step**, same as `/strapped:plan` final review. For every generalizable correction, append an entry to `critiques/user-critiques.md` per the conventions format with `synthesized: false`.

With `--dry-run`, you already stopped in Step 4 — never reach implementation.

## Step 6 — Implement in topological (stack) order

The feedback fix pass is the mono-workflow's `implement` stage with the feedback seams turned on — its coordinator agents own the affected-set selection (every deliverable with a `## Feedback addendum` section), the feedback re-entry transitions, existing-worktree reuse (mint nothing new), and one topological rank per wave (parents before children so a parent's fixes land before children rebase); its outcome-applier agents own the return-to-`pr-open` (or `done` for a pre-PR node) and `feedback_rounds_used` writes. Do not hand-roll any of it.

Dispatch the `strapped-run` mono-workflow again — Workflow tool, `scriptPath: $PLUGIN_ROOT/workflows/strapped-run.js`:

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "stages": ["implement"],
  "stageArgs": {
    "implement": { "addendumMode": true, "recordSuffix": "-feedback" }
  },
  "scripts": { "state": "$PLUGIN_ROOT/scripts/state.mjs", "worktree": "$PLUGIN_ROOT/scripts/ensure-worktree.sh" },
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "codeRounds": 3,
  "planRounds": 3,
  "confidenceMin": 70,
  "seed": 42,
  "rulesByRound": [<per-round splits from Step 2>]
}
```

- `addendumMode: true` swaps the implementer's prompt to "apply the `## Feedback addendum` section to the EXISTING code on this branch, staying in scope" — a targeted change, NOT a re-implementation — and switches the coordinator/applier to the feedback re-entry lifecycle: `pr-open → fixing ⇄ in-review → pr-open` (a pre-PR node whose `pr:` is null is dispatched at `done` without the `fixing` flip — there is no `done>fixing` edge — and converges back to `done` in place), never back through `pending`/`ready`/`in-progress`, every flip via the guarded `state.mjs transition`. A node that parks gets `parked` + `parked_reason` and is reported — never forced through.
- `recordSuffix: "-feedback"` makes feedback code-review rounds write `<Did>-code-round-<N>-feedback.md` (not clobbering the original `<Did>-code-round-<N>.md`); the fix agent's round-record READ path derives from the same suffix — writer and reader agree.
- The rounds counter is the separate `feedback_rounds_used` field, NOT the original `review_rounds_used`.
- `rulesByRound`/`seed`/`confidenceMin`/`codeRounds` are threaded exactly as `/strapped:implement` does, because the code-review/fix loop reads `rulesByRound[round-1]` per round.

Read `results.implement` from the return — `{outcomes, allDone, blocked}` — for the per-node report in Step 7.

## Step 7 — Offer the cascade ONCE

After all fixes land, since parent branches changed, tell the user the single sanctioned next step for the WHOLE batch: `/strapped:pr <slug> --update` — the freeze-rule rebase of stacked children + `gh pr edit` re-push. Do NOT perform any force-push or merge here yourself.

Report: which deliverables got addenda (and any cross-deliverable routing), the review outcome (converged/parked, rounds used, `feedback-round-*` records), which nodes' fixes landed vs. parked (with resume via `/strapped:implement <slug> --only <Did>` where relevant), `feedback_rounds_used` per node, and the `--update` offer.
