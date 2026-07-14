---
name: feedback-lite
description: The default "chisel" refinement cycle — a lighter PR-feedback pass that fetches review comments, synthesizes them off-context in a subagent, plans a cross-deliverable refactor in native plan mode (asking questions, presenting via ExitPlanMode for your approval), then implements it in the standard loop on the existing branches with no adversarial loops, and offers the --update cascade
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Workflow
  - AskUserQuestion
  - ExitPlanMode
---

Drive PR review comments back into a strapped run as a light, user-observed refinement — the "chisel" pass. This is the lighter sibling of `/strapped:feedback`: it keeps the same structure but **drops BOTH adversarial loops** (the addenda plan-review loop and the per-node code-review/fix loop) and puts you in the loop via Claude's **native plan mode**. Prefer it for the quick polish that plan + implement left 60–90% done; reach for the heavyweight `/strapped:feedback` when the review demands a larger re-work. The main agent here IS the implementer, so synthesis runs OFF its context in a subagent to keep it lean. It mints NO new deliverables/branches/worktrees and never force-pushes or merges — shipping stays a user-approved `/strapped:pr <slug> --update`.

**GitHub via `gh`.** All PR data comes from `gh`; there is no GitLab/`glab` path.

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, naming, budgets, and recipes are in `$PLUGIN_ROOT/conventions.md`, which the plugin's SessionStart hook auto-injects as the **strapped preamble** — assume it is in context (in particular the [Feedback-lite loop](conventions.md#feedback-lite-loop) section). If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/conventions.md` before proceeding. This skill cold-starts entirely from the run root `<runRoot>/<slug>/` plus the per-repo config.

## Arguments

`$ARGUMENTS`: `<slug> [--deliverable <Did>]... [--pr <url>]... [--dry-run]`

- `--deliverable <Did>` — **repeatable**; narrows the in-scope set to the named deliverable(s).
- `--pr <url>` — **repeatable**; narrows to the given PR URL(s).
- When neither narrowing flag is given, the in-scope set is every deliverable with a `pr:` URL that has at least one review comment or a request-changes/comment review.
- `--dry-run` — fetch, synthesize, present the plan and the commands that WOULD run, then stop; mutate nothing (no addenda, no transitions, no implementation, no branch changes).

There is **no `--max-rounds`**: feedback-lite has no adversarial rounds.

## Step 0 — Locate the run root (cwd-independent)

Run the harness script (contract in the conventions' [Harness scripts](conventions.md#harness-scripts) section):

```bash
node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>
```

It performs the conventions' [Cwd-independent slug → run-root resolution](conventions.md#cwd-independent-slug--run-root-resolution) (direct path keyed by slug, no glob, never the cwd) and prints `{ slug, stateRoot, runRoot, runDir, manifest, exists, status, seed, budgets, repos }`. Do not hand-roll the resolution.

If `exists` is `false`, stop with a helpful message (slug not found under `<stateRoot>`; point at `/strapped:plan`).

## Step 1 — Cold-start from disk

Step 0's `resolve` output already carries the manifest `seed`/`budgets` and the per-repo configs: its `repos` array (from the **required** manifest `repos:` map) gives per repo `{ name, root, config, configExists, validations, worktreeRoot, provisioning }`. Read every deliverable's frontmatter (status, deps, branch, worktree, pr, repo) via `node $PLUGIN_ROOT/scripts/state.mjs dag <runDir>` — its `nodes` array is the per-node truth and its `topo` is the stack order Step 6 needs.

Determine the **in-scope deliverable set**: every deliverable with a non-null `pr:` URL, intersected with `--deliverable`/`--pr` filters if given. A deliverable in scope is expected to be at `status: pr-open` (its PR is open, typically with changes requested — the same review `scripts/sync-prs.sh` warns on).

There is **NO** rule snapshot and **NO** `rulesByRound` here: feedback-lite runs no adversarial loop, so `reviews/rules-snapshot.md` is never read or extracted. This is the real simplification over `/strapped:feedback`.

## Step 2 — Fetch PR review comments (GitHub via `gh`)

For each in-scope deliverable, derive `{owner}/{repo}/{n}` from its stored `pr:` URL and fetch ALL THREE categories (the same three the conventions' [Feedback loop](conventions.md#feedback-loop) Step 1 fetches):

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

To keep the main agent's context lean, redirect the raw `gh` JSON to a scratch file under the run dir (e.g. `<runDir>/reviews/feedback-lite-comments-<ts>.json`) rather than dumping large output to stdout, and build the `comments` array from that file. Group the fetched comments by the deliverable whose PR they were left on, but CARRY the anchored `path` on each so synthesis can reassign a comment cross-deliverable. Build a `comments` array of `{ deliverableId, pr, lineComments: [...], reviewBodies: [{state, body}], issueComments: [...] }` to pass to the workflow.

If `gh` is unauthenticated, stop and tell the user to `gh auth login`. If no in-scope PR has any comment/review, report that there is no feedback to process and stop.

## Step 3 — Synthesize off-context (`lite: true`)

Dispatch the `strapped-run` mono-workflow ONCE with a singleton stage list — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/strapped-run.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (all paths absolute; full contract in the conventions' [Composable chains](conventions.md#composable-chains) section):

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "stages": ["feedback-synth"],
  "stageArgs": {
    "feedback-synth": {
      "comments": [<the fetched comments from Step 2>],
      "repos": [ { "name": "<repo>", "root": "<abs>" } ],
      "lite": true
    }
  },
  "scripts": { "state": "$PLUGIN_ROOT/scripts/state.mjs", "worktree": "$PLUGIN_ROOT/scripts/ensure-worktree.sh" },
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "seed": "<manifest seed from resolve>",
  "confidenceMin": 70,
  "planRounds": "<manifest plan_rounds>",
  "codeRounds": "<manifest code_rounds>"
}
```

With `lite: true` the `feedback-synth` stage runs its synthesis subagent (OFF your context) to produce the routed digest ONLY — it writes NO `## Feedback addendum` files and SKIPS the adversarial review loop entirely, returning `{ converged: true, rounds: 0, outstanding: [], addenda, summary }`. `rulesByRound` is unnecessary here (no review loop consumes it). Never dispatch the `plan` stage (that reruns the planner and clobbers the run). Read `results["feedback-synth"].addenda` + `.summary` — the distilled, cross-deliverable digest produced OUTSIDE your context. YOU produce the user-approved plan next, in plan mode.

## Step 4 — Plan mode (the user gate)

Now the main agent plans, in Claude's **native plan mode**. Read the Step 3 digest + every in-scope deliverable plan under `<runDir>/deliverables/` + the existing code across the affected worktrees, and plan a cross-deliverable refactor that closes the review feedback. Resolve any ambiguity fast by asking the user with **AskUserQuestion** (routing decisions, scope calls, competing fixes). Make **NO code edits before approval**. Present the finished plan via **ExitPlanMode** — the native-plan-mode gate that replaces `/strapped:feedback`'s adversarial review + explicit-approval gate. Call out cross-deliverable reassignments explicitly (a comment left on PR X routed to deliverable Y) and state the topological (stack) implement order.

## Step 5 — Approve

The user tweaks/approves the plan. Apply the user's tweaks directly with Edit — **no subagents in this step**, same as `/strapped:plan` final review. For every generalizable correction, append an entry to `critiques/user-critiques.md` per the conventions format with `synthesized: false`.

**With `--dry-run`:** stop HERE after presenting the plan and the commands that WOULD run. Mutate nothing — no addenda, no `state.mjs` transitions, no implementation, no branch changes.

## Step 6 — Implement in the standard loop

No adversarial code review. In `topo` (stack) order over the affected deliverables — parents before children so a parent's fixes land before children rebase — implement the approved plan directly:

1. Work in the deliverable's **EXISTING** worktree/branch (never mint new ones).
2. Record re-entry BEFORE applying: for a node with an open PR (`pr:` non-null, at `pr-open`), `node $PLUGIN_ROOT/scripts/state.mjs transition <deliverableFile> fixing`. A **pre-PR** node (`pr:` null) is dispatched WITHOUT a transition — there is no `done>fixing` edge — and stays `done`.
3. Apply the approved changes to the existing code (a targeted change, not a re-implementation), staying in scope.
4. Run that repo's `validations` (from its config) until green, then commit on the existing branch.
5. Record the exit: for a `pr-open` node, `transition <deliverableFile> in-review` then `transition <deliverableFile> pr-open`; for a pre-PR node, `transition <deliverableFile> done` (an idempotent no-op). Then bump the counter: `node $PLUGIN_ROOT/scripts/state.mjs set <deliverableFile> feedback_rounds_used <n+1>`.

Use the SAME feedback re-entry edge and `feedback_rounds_used` counter the conventions' [Feedback loop](conventions.md#feedback-loop) documents — feedback-lite reuses that lifecycle, it does not invent one. Optionally persist the approved plan as a `## Feedback addendum` section per deliverable for audit/resumability. The freeze rule is preserved; never force-push or merge here. A node whose validations cannot go green parks (`transition <deliverableFile> parked` + `set <deliverableFile> parked_reason ...`) and is reported — never forced through.

## Step 7 — Offer the cascade ONCE

After all fixes land, since parent branches changed, tell the user the single sanctioned next step for the WHOLE batch: `/strapped:pr <slug> --update` — the freeze-rule rebase of stacked children + `gh pr edit` re-push. Do NOT perform any force-push or merge here yourself.

Report: which deliverables got fixes (and any cross-deliverable routing), which nodes' fixes landed vs. parked (with resume guidance where relevant), `feedback_rounds_used` per node, and the `--update` offer.

## A note on the name

The command name `feedback-lite` is **provisional** — the source plan's analogy is a *chisel*, and `chisel`/`refine`/`polish` are naming candidates. Confirm the final name with the user.
