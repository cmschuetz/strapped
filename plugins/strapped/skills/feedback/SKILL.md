---
name: feedback
description: The "chisel" refinement cycle for a strapped run's PR feedback — fetch review comments via gh, synthesize and route them in-band, plan a cross-deliverable refactor in native plan mode (asking questions, presenting via ExitPlanMode for your approval), then implement it on the existing branches with no adversarial loops, and offer the --update cascade
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - EnterPlanMode
  - ExitPlanMode
---

Drive PR review comments back into a strapped run as a light, user-observed refinement — the "chisel" pass. It **runs no adversarial loops** (no addenda plan-review loop, no per-node code-review/fix loop) and puts you in the loop via Claude's **native plan mode**: the main agent fetches the comments, synthesizes and routes the cross-deliverable fix plan itself inside plan mode, gates on your ExitPlanMode approval, then implements the approved plan directly on the existing branches. It mints NO new deliverables/branches/worktrees and never force-pushes or merges — shipping stays a user-approved `/strapped:pr <slug> --update`.

**GitHub via `gh`.** All PR data comes from `gh`; there is no GitLab/`glab` path.

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, naming, budgets, and recipes are in `$PLUGIN_ROOT/conventions.md` (in particular the [Feedback loop](conventions.md#feedback-loop) section). Your always-injected operating model is the slim `context.md` preamble (sentinel `strapped-preamble-v1`); do not front-load research or re-read the whole conventions on invocation — the procedure below is self-sufficient; pull the specific `conventions.md` section only at the step that needs the exact format. If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/context.md` to re-establish the operating model. This skill cold-starts entirely from the run root `<runRoot>/<slug>/` plus the per-repo config.

## Arguments

`$ARGUMENTS`: `<slug> [--deliverable <Did>]... [--pr <url>]... [--dry-run]`

- `--deliverable <Did>` — **repeatable**; narrows the in-scope set to the named deliverable(s).
- `--pr <url>` — **repeatable**; narrows to the given PR URL(s).
- When neither narrowing flag is given, the in-scope set is every deliverable with a `pr:` URL that has at least one review comment or a request-changes/comment review.
- `--dry-run` — fetch, synthesize, present the plan and the commands that WOULD run, then stop; mutate nothing (no transitions, no implementation, no branch changes).

There is **no `--max-rounds`**: the feedback cycle has no adversarial rounds.

## Step 0 — Locate the run root (cwd-independent)

Run the harness script (contract in the conventions' [Harness scripts](conventions.md#harness-scripts) section):

```bash
node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>
```

It performs the conventions' [Cwd-independent slug → run-root resolution](conventions.md#cwd-independent-slug--run-root-resolution) (direct path keyed by slug, no glob, never the cwd) and prints `{ slug, stateRoot, runRoot, runDir, manifest, exists, status, seed, budgets, repos }`. Do not hand-roll the resolution.

If `exists` is `false`, stop with a helpful message (slug not found under `<stateRoot>`; point at `/strapped:plan`).

## Step 1 — Cold-start from disk

Step 0's `resolve` output already carries the manifest `seed`/`budgets` and the per-repo configs: its `repos` array (from the **required** manifest `repos:` map) gives per repo `{ name, root, config, configExists, validations, worktreeRoot, provisioning }`. Read every deliverable's frontmatter (status, deps, branch, worktree, pr, repo) via `node $PLUGIN_ROOT/scripts/state.mjs dag <runDir>` — its `nodes` array is the per-node truth and its `topo` is the stack order Step 5 needs.

Determine the **in-scope deliverable set**: every deliverable with a non-null `pr:` URL, intersected with `--deliverable`/`--pr` filters if given. A deliverable in scope is expected to be at `status: pr-open` (its PR is open, typically with changes requested — the same review `scripts/sync-prs.sh` warns on).

There is **NO** rule snapshot and **NO** `rulesByRound` here: the feedback cycle runs no adversarial loop, so `reviews/rules-snapshot.md` is never read or extracted.

## Step 2 — Fetch PR review comments (GitHub via `gh`)

For each in-scope deliverable, derive `{owner}/{repo}/{n}` from its stored `pr:` URL and fetch ALL THREE categories (the same three the conventions' [Feedback loop](conventions.md#feedback-loop) Step 1 fetches):

1. **Line-anchored review comments** via the GraphQL **`reviewThreads`** query (NOT REST `/pulls/{n}/comments` — no resolution field there). Fetch **ALL** threads, resolved and unresolved:
   ```bash
   gh api graphql -f query='
   query($owner:String!,$repo:String!,$pr:Int!){
     repository(owner:$owner,name:$repo){
       pullRequest(number:$pr){
         reviewThreads(first:100){
           nodes{ id isResolved isOutdated diffSide startDiffSide
             comments(first:100){ nodes{ databaseId body path startLine originalStartLine line originalLine diffHunk author{login} } } }
         }
       }
     }
   }' -F owner={owner} -F repo={repo} -F pr={n}
   ```
   `diffSide` and `startDiffSide` are **fields of the THREAD node**, not of the comment nodes — selecting `diffSide` on the comment selection makes GitHub reject the whole query with an `undefinedField` error. Carry each thread's `diffSide`/`startDiffSide` onto every comment record it contains, along with its `isResolved` as `githubResolved`, its node `id` as `threadId`, and the first comment's `databaseId` (stringified) as `externalId`. Do NOT drop resolved threads; `isOutdated` is ignored. Capture the full anchored RANGE, not just one line: `path`, `startLine`/`originalStartLine`, `line`/`originalLine`, and the `diffHunk` block (the multi-line context — always keep it), plus `body` and `author.login`. A single-line comment has a null `startLine`; a multi-line comment spans `startLine..line`.
2. **Review-SUBMISSION bodies** (a DISTINCT category — the summary a reviewer types on submit):
   ```bash
   gh api repos/{owner}/{repo}/pulls/{n}/reviews --paginate
   ```
   Capture `state` (APPROVED / CHANGES_REQUESTED / COMMENTED) and `body`. Feed each **non-empty** submission `body` — especially a CHANGES_REQUESTED one — into the Step 3 synthesis as GLOBAL feedback, indexed under `externalId = "review:<id>"`, `threadId: null`, `githubResolved: false`.
3. **Global/issue comments**:
   ```bash
   gh pr view <url> --json comments
   ```
   Indexed under `externalId = "issue:<id>"`, `threadId: null`, `githubResolved: false`.

To keep your context lean before plan mode, redirect the raw `gh` JSON to a scratch file under the run dir (e.g. `<runDir>/reviews/feedback-comments-<ts>.json`) rather than dumping large output to stdout. Group the fetched comments by the deliverable whose PR they were left on, but CARRY the anchored `path` on each so Step 3 can reassign a comment cross-deliverable. Each line-comment record keeps its full `startLine..line` range + the `diffHunk` block, never collapsed to a single line.

**Upsert then cross-check** (dedup — see the conventions' [Feedback index](conventions.md#feedback-index)). Write the fetched records (each carrying `externalId`/`threadId`/`deliverableId`/`pr`/`path`/`startLine`/`originalStartLine`/`line`/`originalLine`/`diffSide`/`startDiffSide`/`diffHunk`/`author`/`body`/`githubResolved` — the thread-level `diffSide`/`startDiffSide` carried onto each comment) as a JSON array to that scratch file, then:

```bash
node $PLUGIN_ROOT/scripts/state.mjs feedback-index upsert <runDir> --from <scratch>
node $PLUGIN_ROOT/scripts/state.mjs feedback-index read <runDir>
```

The index read is the **status filter** only (it stores identity fields, not the full `diffHunk` block) — the Step 3 working set is the **scratch records whose `externalId` is `status: unaddressed` in the index**, each keeping its full `startLine..line` range + `diffHunk` block. If nothing is `unaddressed`, report "no outstanding feedback" and stop.

If `gh` is unauthenticated, stop and tell the user to `gh auth login`. If no in-scope PR has any comment/review, report that there is no feedback to process and stop.

## Step 3 — Plan mode: synthesize, route, and plan in-band (the user gate)

**Call `EnterPlanMode` FIRST — before reading anything or asking anything.** This is a required step of this skill, not optional: once plan mode is active, Claude Code's harness blocks every mutating tool (Edit/Write/etc.) until `ExitPlanMode`, so the user's gate is real *while you are in it*. Be honest about the boundary of that guarantee, though — entering plan mode is the model's own action (there is no hook forcing it), so treat "call `EnterPlanMode` before touching anything" as a hard rule you follow, not a wall the harness erects for you. Invoking `/strapped:feedback` IS the entry consent — the whole command is a plan-then-implement gate — so enter without deliberating over it.

With plan mode engaged, YOU synthesize the feedback **in-band** — no subagent and no workflow dispatch. Read the unaddressed comment records from the Step 2 scratch file, every in-scope deliverable plan under `<runDir>/deliverables/`, and the existing code across the affected worktrees, then produce ONE consolidated, cross-deliverable fix plan yourself:

- **Route each comment (or cluster of related comments) to the EXISTING deliverable that owns the fix**: match the comment's anchored `path` against each deliverable's `## Files to touch` map — a comment left on one PR may belong on a different node. A `review:` entry's CHANGES_REQUESTED body states the overarching problem: fold its implied fixes into the owning node(s); `issue:` entries route the same way. Every unaddressed comment gets exactly one target node — you need that per-node routing for the Step 5 index marking.
- **Plan the fix per routed node**: concrete, in-scope, testable changes to the existing code (a targeted change, not a re-implementation).

Resolve any ambiguity fast by asking the user with **AskUserQuestion** (routing decisions, scope calls, competing fixes). Make **NO code edits before approval** (plan mode enforces this — but never try to work around it). Present the finished plan via **ExitPlanMode** — the native-plan-mode approval gate; there is no adversarial review and no separate explicit-approval step. Call out cross-deliverable reassignments explicitly (a comment left on PR X routed to deliverable Y) and state the topological (stack) implement order.

## Step 4 — Approve

The user tweaks/approves the plan. Apply the user's tweaks directly with Edit — **no subagents in this step**, same as `/strapped:plan` final review. For every generalizable correction, append an entry to `critiques/user-critiques.md` per the conventions format with `synthesized: false`.

**With `--dry-run`:** stop HERE after presenting the plan and the commands that WOULD run. Mutate nothing — no `state.mjs` transitions, no implementation, no branch changes.

## Step 5 — Implement in the standard loop

No adversarial code review. In `topo` (stack) order over the affected deliverables — parents before children so a parent's fixes land before children rebase — implement the approved plan directly:

1. Work in the deliverable's **EXISTING** worktree/branch (never mint new ones).
2. Record re-entry BEFORE applying: for a node with an open PR (`pr:` non-null, at `pr-open`), `node $PLUGIN_ROOT/scripts/state.mjs transition <deliverableFile> fixing`. A **pre-PR** node (`pr:` null) is dispatched WITHOUT a transition — there is no `done>fixing` edge — and stays `done`.
3. Apply the approved changes to the existing code (a targeted change, not a re-implementation), staying in scope.
4. Run that repo's `validations` (from its config) until green, then commit on the existing branch.
5. **Mark the index** for the comments the plan routed to THIS node (you routed every comment in-context in Step 3). With the node's fix commit `sha=$(git -C <worktree> rev-parse HEAD)`, for each such `externalId`: `node $PLUGIN_ROOT/scripts/state.mjs feedback-index set <runDir> <externalId> addressed --commit "$sha"` (covering its `review:`/`issue:` entries too). Leave comments routed to a **parked** node `unaddressed`.
6. Record the exit: for a `pr-open` node, `transition <deliverableFile> in-review` then `transition <deliverableFile> pr-open`; for a pre-PR node, `transition <deliverableFile> done` (an idempotent no-op). Then bump the counter: `node $PLUGIN_ROOT/scripts/state.mjs set <deliverableFile> feedback_rounds_used <n+1>`.

Use the SAME feedback re-entry edge and `feedback_rounds_used` counter the conventions' [Feedback loop](conventions.md#feedback-loop) documents. Optionally persist the approved plan as a `## Feedback addendum` section per deliverable for audit/resumability. The freeze rule is preserved; never force-push or merge here. A node whose validations cannot go green parks (`transition <deliverableFile> parked` + `set <deliverableFile> parked_reason ...`) and is reported — never forced through.

## Step 6 — Offer the cascade ONCE

After all fixes land, since parent branches changed, tell the user the single sanctioned next step for the WHOLE batch: `/strapped:pr <slug> --update` — the freeze-rule rebase of stacked children + `gh pr edit` re-push. Do NOT perform any force-push or merge here yourself.

Report: which deliverables got fixes (and any cross-deliverable routing), which nodes' fixes landed vs. parked (with resume guidance where relevant), `feedback_rounds_used` per node, and the `--update` offer.
