---
name: implement
description: Execute an approved strapped DAG wave-by-wave — persistent worktree per deliverable, fresh implementer, validations, bounded adversarial code-review/fix loop, park-don't-spin
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

Implement an approved strapped plan.

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, naming, budgets, and recipes are in `$PLUGIN_ROOT/conventions.md` — read it first, every time. This skill cold-starts entirely from the run root `<runRoot>/<slug>/` (resolved per the conventions' Config resolution) plus the per-repo config — it needs no memory of the planning session.

## Arguments

`$ARGUMENTS`: `<slug> [--only <Did>] [--max-rounds N]`

- `--only` restricts execution to one deliverable (used to resume a parked node after the user unblocks it).
- `--max-rounds` overrides the `code_rounds` budget (default from the manifest, 3).

## Step 0 — Locate the run root (cwd-independent)

`/strapped:implement` is invoked with only a `<slug>`, and the cwd may be a plans dir or anything unrelated to the work. Run the harness script (contract in the conventions' **Harness scripts** section):

```bash
node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>
```

It performs the conventions' **Cwd-independent slug → run-root resolution** (direct path keyed by slug, no glob, never the cwd) and prints `{ slug, stateRoot, runRoot, runDir, manifest, exists, status, seed, budgets, repos }`. Do not hand-roll the resolution.

If `exists` is `false`, stop with a helpful message: the slug was not found under `<stateRoot>` (point at `/strapped:plan`).

## Step 1 — Cold-start from disk

The `resolve` output already carries the manifest `status`, `seed`, `budgets`, and per-repo configs. The manifest must be `status: approved` or `implementing` — otherwise stop and say why. Flip it to `implementing` if not already (idempotent — a re-run on an already-`implementing` manifest is a no-op):

```bash
node $PLUGIN_ROOT/scripts/state.mjs manifest-status <runDir> implementing
```

Build the DAG with:

```bash
node $PLUGIN_ROOT/scripts/state.mjs dag <runDir>
```

which reads the manifest `deliverables` list plus every deliverable file's frontmatter (per-node truth: status, branch, worktree, rounds used come from the deliverable files only) and prints `{ manifest, nodes, ready, topo, blocked, remaining }`.

**Per-repo config.** `resolve`'s `repos` array (from the **required** manifest `repos:` map — a manifest without one is invalid input) gives per repo `{ name, root, config, configExists, validations, worktreeRoot, provisioning }`. If any target repo has `configExists: false`, stop and point the user at `/strapped:plan`, which generates one per repo.

Each deliverable's `repo:` field is **required** and names one of the `repos:` entries — a deliverable with no `repo:` is invalid input.

## Step 2 — Rule assignments

As in /strapped:plan: read `reviews/rules-snapshot.md` (re-extract if missing), compute the per-round rule splits (full rule objects) for rounds `1..code_rounds` using `random.Random(seed + round)` from the manifest seed.

## Step 3 — Wave loop

Repeat until no deliverable is runnable:

1. **Ready set**: run `node $PLUGIN_ROOT/scripts/state.mjs dag <runDir>` (append `--only <Did>` when given — it readmits a `parked`/`in-progress` node and restricts `ready` to it) and use its `ready` array **verbatim** — never recompute readiness by hand. If `ready` is empty and nothing is `in-progress`, stop.
2. **Worktrees** (idempotent). For each ready node, read its required `repo:` from the `dag` node and look up that repo's `{ root, worktreeRoot, provisioning }` from Step 0's `resolve` output. The worktree path is `<worktreeRoot>/<slug>/<Did>`; `<base>` follows the conventions' cross-repo base rule: the parent deliverable's branch **when the parent is in the same repo**; otherwise (a root, or a cross-repo parent) that repo's `main`. Run:

   ```bash
   $PLUGIN_ROOT/scripts/ensure-worktree.sh <repoRoot> <worktreeRoot>/<slug>/<Did> <branch> <base>
   ```

   (reuses an existing worktree whose branch matches, re-attaches an existing branch without `-b`, otherwise creates from `<base>`; exits 1 on a path/branch mismatch — stop and report, don't improvise). Then record it in the frontmatter via the harness scripts:

   ```bash
   node $PLUGIN_ROOT/scripts/state.mjs set <deliverableFile> worktree <worktreePath>
   node $PLUGIN_ROOT/scripts/state.mjs transition <deliverableFile> in-progress
   ```

   Apply that repo's config `provisioning` instructions to a fresh worktree (placeholder values only — never real secrets).
3. **Resume note**: for a node being re-dispatched (was `in-progress`, `fixing`, or `parked`), compose a short `resumeNote` string from its frontmatter (`parked_reason`, `review_rounds_used`) and the latest `reviews/<Did>-code-round-*.md` — open findings and what was already done.
4. **Dispatch** the `strapped-implement-wave` workflow — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/implement-wave.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (absolute paths):

Each `items[]` entry carries its own repo context (`repo`, `repoRoot`, and that repo's `validations`) — there is no single global `repoRoot`/`validations` used for execution.

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "items": [
    { "id": "D1", "repo": "<repoName>", "repoRoot": "<abs repo root for D1's repo>", "validations": [<that repo's validations>], "planFile": "<abs>", "worktree": "<abs>", "branch": "strapped/<slug>/D1-...", "base": "main", "resumeNote": null }
  ],
  "codeReviewScript": "$PLUGIN_ROOT/workflows/code-review.js",
  "codeRounds": 3,
  "confidenceMin": 70,
  "seed": 42,
  "rulesByRound": [<per-round splits from step 2>]
}
```

5. **Apply outcomes** to each deliverable's frontmatter via the harness scripts — never hand-edit the files:
   - `done` → `node $PLUGIN_ROOT/scripts/state.mjs transition <deliverableFile> done`
   - `parked` → `node $PLUGIN_ROOT/scripts/state.mjs transition <deliverableFile> parked` and `node $PLUGIN_ROOT/scripts/state.mjs set <deliverableFile> parked_reason <reason>`
   - always `node $PLUGIN_ROOT/scripts/state.mjs set <deliverableFile> review_rounds_used <n>`

   A parked node's children stay `pending` — they are simply never ready.
6. Re-run `state.mjs dag <runDir>` to recompute the ready set (children of newly-`done` nodes become eligible) and loop.

## Step 4 — Report

Summarize: done nodes (with branches and rounds used), parked nodes (with reasons and the resume command `/strapped:implement <slug> --only <Did>`), blocked-pending children, and accumulated non-gating suggestions worth a human glance. If everything is `done`, remind the user of `/strapped:pr <slug> --dry-run`. If the user gives corrective feedback here that generalizes, append it to `critiques/user-critiques.md` (`synthesized: false`).

Never merge to `main`, never push, never delete worktrees — those belong to `/strapped:pr` and the cleanup recipe.
