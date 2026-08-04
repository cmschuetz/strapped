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

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, naming, budgets, and recipes are in `$PLUGIN_ROOT/conventions.md` (in particular the **Feedback loop** section). Your always-injected operating model is the slim `context.md` preamble (sentinel `strapped-preamble-v1`); do not front-load research or re-read the whole conventions on invocation — the procedure below is self-sufficient; pull the specific `conventions.md` section only at the step that needs the exact format. If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/context.md` to re-establish the operating model. This skill cold-starts entirely from the run root `<runRoot>/<slug>/` plus the per-repo config.

## Arguments

`$ARGUMENTS`: `<slug> [--deliverable <Did>]... [--pr <url>]... [--dry-run] [--max-rounds N]`

- `--deliverable <Did>` — **repeatable**; narrows the in-scope set to the named deliverable(s).
- `--pr <url>` — **repeatable**; narrows to the given PR URL(s).
- When neither narrowing flag is given, the in-scope set is every deliverable with a `pr:` URL that has at least one review comment or a request-changes/comment review.
- `--dry-run` — fetch, synthesize, review, print the plan and the commands that WOULD run, then stop; mutate nothing (no addenda written, no implementation, no branch changes).
- `--max-rounds N` — overrides both the plan-review budget (for the addenda review) and the code-review budget (for the fix path); defaults to the manifest's `plan_rounds`/`code_rounds` (1). `0` is legal and skips the adversarial rounds entirely.

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

1. Read `reviews/rules-snapshot.md` (re-extract per the conventions' **Rule extraction** if missing — discover every applicable CLAUDE.md AND recurse into any skills/files it loads for additional rules).
2. Compute the per-round rule split with the conventions' **Seeded rule split** recipe — for each round `1..max_rounds`, an id-only `{"a": ["R1", "R4"], "b": ["R2", "R3"]}` pair shuffled with `random.Random(seed + round)` over the sorted rule-id list (seed from the manifest). Save the JSON — it becomes `rulesByRound`. Ids only: the snapshot stays the single source of rule text, which the workflow's review agents Read via `rulesFile`.

This single `rulesByRound` and the `rulesFile` path (plus `seed`, `confidenceMin`, `planRounds`, `codeRounds`) are threaded into BOTH mono-workflow dispatches — the `feedback-synth` stage (the addenda review loop consumes them at `rulesByRound[round-1]`) AND the Step 6 `implement` stage (the code-review/fix loop consumes them the same way). Omitting them makes the adversarial reviewers receive `undefined` rule halves (and a non-empty `rulesByRound` without `rulesFile` fails the config parse).

## Step 3 — Fetch PR review comments, index them, cross-check (GitHub via `gh`)

For each in-scope deliverable, derive `{owner}/{repo}/{n}` from its stored `pr:` URL and fetch ALL THREE categories:

1. **Line-anchored review comments** via the GraphQL **`reviewThreads`** query — NOT the REST `/pulls/{n}/comments` endpoint, which carries no thread-resolution field. Fetch **ALL** threads, resolved and unresolved alike:
   ```bash
   gh api graphql -f query='
   query($owner:String!,$repo:String!,$pr:Int!){
     repository(owner:$owner,name:$repo){
       pullRequest(number:$pr){
         reviewThreads(first:100){
           nodes{ id isResolved isOutdated
             comments(first:100){ nodes{ databaseId body path startLine originalStartLine line originalLine diffSide diffHunk author{login} } } }
         }
       }
     }
   }' -F owner={owner} -F repo={repo} -F pr={n}
   ```
   For each thread, carry its `isResolved` onto its comments as `githubResolved`, its node `id` as `threadId`, and the first comment's `databaseId` (stringified) as `externalId`. **Do NOT drop resolved threads** — a thread a reviewer self-resolved must still reach upsert (else its entry stays `unaddressed` forever and is re-fed every round). `isOutdated` is deliberately **ignored** (outdated ≠ addressed). Capture the full anchored RANGE, not just one line: `path`, `startLine`/`originalStartLine`, `line`/`originalLine`, `diffSide`, and the `diffHunk` block (the multi-line context — always keep it), plus `body` and `author.login`. A single-line comment has a null `startLine`; a multi-line comment spans `startLine..line`.
2. **Review-SUBMISSION bodies** (a DISTINCT category — the summary a reviewer types on submit):
   ```bash
   gh api repos/{owner}/{repo}/pulls/{n}/reviews --paginate
   ```
   Capture `state` (APPROVED / CHANGES_REQUESTED / COMMENTED) and `body`. Feed each **non-empty** submission `body` — especially a CHANGES_REQUESTED one — into synthesis as GLOBAL feedback for that deliverable, and index it under `externalId = "review:<id>"`, `threadId: null`, `githubResolved: false`.
3. **Global/issue comments**:
   ```bash
   gh pr view <url> --json comments
   ```
   Index each under `externalId = "issue:<id>"`, `threadId: null`, `githubResolved: false`.

Group the fetched comments by the deliverable whose PR they were left on, but CARRY the anchored `path` on each so synthesis can reassign a comment cross-deliverable. Each line-comment record keeps its full `startLine..line` range + the `diffHunk` block, never collapsed to a single line.

**Upsert then cross-check** (the dedup that keeps already-addressed comments out of synthesis — see the conventions' [Feedback index](conventions.md#feedback-index)). Write every fetched record — each carrying `externalId`/`threadId`/`deliverableId`/`pr`/`path`/`startLine`/`originalStartLine`/`line`/`originalLine`/`diffSide`/`diffHunk`/`author`/`body`/`githubResolved` — as a JSON array to a scratch file under `<runDir>/reviews/` (e.g. `feedback-comments-<ts>.json`), then:

```bash
node $PLUGIN_ROOT/scripts/state.mjs feedback-index upsert <runDir> --from <scratch>
node $PLUGIN_ROOT/scripts/state.mjs feedback-index read <runDir>
```

The upsert reconciles upstream-resolved threads to `resolved`; the read returns the whole index. The index read is the **status filter** only — the index stores the identity fields (`externalId`/`threadId`/`status`/`path`/`line`/…), not the full `diffHunk` block — so build the Step 4 `comments` array from the **scratch records whose `externalId` is `status: unaddressed` in the index**, as `{ deliverableId, pr, lineComments: [{ path, startLine, originalStartLine, line, originalLine, diffSide, diffHunk, body }], reviewBodies: [{state, body}], issueComments: [...] }` — every `lineComments` entry carrying the full `startLine..line` range + `diffHunk` block from the scratch record. If no comment is `unaddressed`, report "no outstanding feedback" and stop — the index already covers everything.

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
  "rulesFile": "<runRoot>/<slug>/reviews/rules-snapshot.md",
  "rulesByRound": [<the id-only per-round splits from Step 2>],
  "planRounds": "<--max-rounds or the manifest plan_rounds>",
  "codeRounds": "<--max-rounds or the manifest code_rounds>",
  "confidenceMin": 70,
  "seed": "<the manifest seed>"
}
```

The `feedback-synth` stage (a) synthesizes ONE consolidated cross-deliverable plan — routing each comment to the deliverable that OWNS the anchored file (which may differ from the PR it was left on) via each deliverable's `Files to touch` map — writing a `## Feedback addendum` section into each affected EXISTING deliverable file, then (b) runs the mono-workflow's shared review loop (ask = the fetched PR review comments; artifact = the amended deliverable set; `roundFilePrefix: feedback-round`), so the addenda pass through the SAME find → verify-consolidate → act cycle (2 reviewers, then one batch verify-consolidate agent that adjudicates every finding, dedups, and writes the round record, then the reviser) + the confirmation pass, writing `reviews/feedback-round-<N>.md` records (distinct from `plan-round-*`). Never dispatch the `plan` stage here (that would run the planner and clobber the addenda). Read `results["feedback-synth"]` from the return — `{ converged, rounds, outstanding, addenda, summary }`. Honor `--max-rounds` via `planRounds`.

**With `--dry-run`:** the synthesis/review still runs to produce the plan, but you must NOT let it mutate the run — pass `--dry-run` intent by NOT writing addenda: instead, run only the fetch + a synthesis DRAFT in-conversation, print the routed addenda plan and the commands that WOULD run, then stop. (Do not dispatch the mutating workflow under `--dry-run`.)

If the review did **not** converge (budget exhausted), present `outstanding` with the `feedback-round-*.md` files and work through them with the user before proceeding.

**Record the routing map.** The `feedback-synth` stage/schema are frozen — they return per-deliverable prose addenda only, no `externalId`-keyed structure — so the comment→deliverable map used for post-implement marking (Step 6) must be produced skill-side. Dispatch a **fresh subagent** (Task/agent, OFF the main context) that reads the synthesized `## Feedback addendum` sections on every affected deliverable plus the `unaddressed` records from Step 3 (each carrying `externalId`, its anchored `path`/`line` or `review:`/`issue:` id, and `body`) and writes an explicit `[{ "externalId": "...", "routedDeliverableId": "..." }]` array to `<runDir>/reviews/feedback-routing.json`. It routes each comment to the addendum task that addresses it — falling back to the same anchored-`path`→`Files to touch` rule synthesis uses, so the recorded map agrees with synthesis's placement by construction; the `threadId:null` `review:`/`issue:` entries route to the deliverable(s) their CHANGES_REQUESTED body / global point was folded into. **Every** `unaddressed` comment fed to synthesis gets exactly one `routedDeliverableId`. (With `--dry-run` you already stopped; no routing file is written.)

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
  "codeRounds": "<--max-rounds or the manifest code_rounds>",
  "planRounds": "<--max-rounds or the manifest plan_rounds>",
  "confidenceMin": 70,
  "seed": "<the manifest seed>",
  "rulesFile": "<runRoot>/<slug>/reviews/rules-snapshot.md",
  "rulesByRound": [<the id-only per-round splits from Step 2>]
}
```

- `addendumMode: true` swaps the implementer's prompt to "apply the `## Feedback addendum` section to the EXISTING code on this branch, staying in scope" — a targeted change, NOT a re-implementation — and switches the coordinator/applier to the feedback re-entry lifecycle: `pr-open → fixing ⇄ in-review → pr-open` (a pre-PR node whose `pr:` is null is dispatched at `done` without the `fixing` flip — there is no `done>fixing` edge — and converges back to `done` in place), never back through `pending`/`ready`/`in-progress`, every flip via the guarded `state.mjs transition`. A node that parks gets `parked` + `parked_reason` and is reported — never forced through.
- `recordSuffix: "-feedback"` makes feedback code-review rounds write `<Did>-code-round-<N>-feedback.md` (not clobbering the original `<Did>-code-round-<N>.md`); the fix agent's round-record READ path derives from the same suffix — writer and reader agree.
- The rounds counter is the separate `feedback_rounds_used` field, NOT the original `review_rounds_used`.
- `rulesFile`/`rulesByRound`/`seed`/`confidenceMin`/`codeRounds` are threaded exactly as `/strapped:implement` does, because the code-review/fix loop reads `rulesByRound[round-1]` per round and its reviewers Read the rule text from `rulesFile`.

Read `results.implement` from the return — `{outcomes, allDone, blocked}` — for the per-node report in Step 7.

**Mark the index (post-fix).** After `implement` returns, read `<runDir>/reviews/feedback-routing.json` and, for every `{externalId, routedDeliverableId}` pair whose `routedDeliverableId` reached `done`/converged (skip a **parked** deliverable — its `outcomes` entry shows it), read that deliverable's fix commit and flip the entry:

```bash
sha=$(git -C <routedDeliverableWorktree> rev-parse HEAD)
node $PLUGIN_ROOT/scripts/state.mjs feedback-index set <runDir> <externalId> addressed --commit "$sha"
```

This covers the `review:`/`issue:` entries too (they route like any other comment). Comments routed to a parked deliverable stay `unaddressed` and are re-fed next round. The `--update` cascade (Step 7) later writes these `addressed` comments back to GitHub and flips them to `resolved`.

## Step 7 — Offer the cascade ONCE

After all fixes land, since parent branches changed, tell the user the single sanctioned next step for the WHOLE batch: `/strapped:pr <slug> --update` — the freeze-rule rebase of stacked children + `gh pr edit` re-push. Do NOT perform any force-push or merge here yourself.

Report: which deliverables got addenda (and any cross-deliverable routing), the review outcome (converged/parked, rounds used, `feedback-round-*` records), which nodes' fixes landed vs. parked (with resume via `/strapped:implement <slug> --only <Did>` where relevant), `feedback_rounds_used` per node, and the `--update` offer.
