---
name: plan
description: Turn a large plans/<name>.md ask into a converged DAG implementation plan — research, adversarial rule-partitioned plan review loop, then interactive final review with the user
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

Turn one large source plan document into an approved, implementation-ready DAG of deliverables.

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, budgets, and procedures are defined in `$PLUGIN_ROOT/conventions.md` — read it first, every time. State lives in the **project being worked on** (the cwd), never in the plugin.

## Arguments

`$ARGUMENTS`: `<path-to-plan.md> [--repo <path-or-name>]... [--seed N] [--max-rounds N]`

- `--repo <path-or-name>` — **repeatable**; names the target repo(s) the work will change (an unordered set — no repo is special). Each value is either an absolute/relative path to a repo, or a bare name resolved under the user's repo-parent convention (e.g. `$WORK_DIR_PATH/<name>`, `~/chime/<name>`). When **omitted**, the skill first checks for an existing run to resume, and only if none exists infers candidate repos from the source plan text and confirms them with the user (see Step 1). Repo identity is **never** taken from the cwd.
- `--seed` defaults to 42; recorded in the manifest so reviews are reproducible.
- `--max-rounds` defaults to the `plan_rounds` budget (3).

## Step 1 — Resolve repos, config, then scaffold or resume

Derive the slug from the source plan filename (`plans/foo_bar.md` → `foo-bar`). Everything below defers to the **Config resolution** section of the conventions — read it first.

### 1a — Determine the target repos (never from cwd)

Do **not** run `git rev-parse --show-toplevel` on the cwd to pick the repo — the cwd may be a plans repo, `~`, or anything unrelated. `git rev-parse` is used **only** to canonicalize an *input* repo path (and must run in that repo's main checkout, not a worktree). Follow whichever branch applies:

**`--repo` given** — for each value, resolve to an absolute git top-level: accept a path, or a bare name resolved under the user's repo-parent convention (`$WORK_DIR_PATH/<name>`, `~/chime/<name>`). Canonical `<repoName>` = basename of that root. The `--repo` inputs form an unordered target-repo set. Skip to 1b.

**`--repo` omitted — resume-first, then infer.** Run state is keyed by slug under `runs/`, so an existing run can be detected directly regardless of which repos it touches:

1. Resolve `stateRoot` per conventions (`$STRAPPED_STATE_ROOT` → `~/.claude/strapped.json` → default `plans/strapped`). The repo-local `.claude/strapped-config.json` source in the anchor chain cannot apply yet — no repo is chosen — so skip it here.
2. Apply the conventions' **cwd-independent slug → run-root rule** to look for an existing run — a **direct path**, no glob, no fallback:
   - **Shared mode** (absolute `stateRoot`): probe `<stateRoot>/runs/<slug>/manifest.md`.
   - **Repo-relative mode** (relative `stateRoot`): probe `<repoAbs>/<stateRoot>/runs/<slug>/manifest.md` for the current repo.
3. Handle the probe result:
   - **Manifest present** — this is a **resume**. Read that `manifest.md`'s `repos:` map: its entries are the target repos. **Skip inference and AskUserQuestion entirely — do not re-prompt.** Then jump to 1d with the recovered repos and run root.
   - **Manifest absent** — no existing run. Fall through to inference below.
4. **Inference (manifest absent only):** infer candidate target repos from the source plan text (repo names it mentions, resolved via the repo-parent convention) and present them via **AskUserQuestion** for the user to confirm or correct **before writing any state**. A single-repo plan confirms one repo.

### 1b — Store the target repos

Store each target repo's canonical `<repoName>` and absolute `root`. The set is unordered — no repo is special.

### 1c — Resolve stateRoot and the run root

Resolve `stateRoot` per conventions, first match wins: `$STRAPPED_STATE_ROOT` → a target repo's repo-local `.claude/strapped-config.json`.stateRoot → `~/.claude/strapped.json`.stateRoot → default `plans/strapped`. Expand a leading `~`. Compute `<runRoot>`:

- **Shared mode** (absolute `stateRoot`): `<runRoot>` = `<stateRoot>/runs/`.
- **Repo-relative mode** (relative `stateRoot`): `<runRoot>` = `<repoAbs>/<stateRoot>/runs/`.

`<runRoot>/<slug>/` is where all run state lives — every path below uses it. If there is no anchor and no repo-local config, ask the user whether to set up a global anchor (`~/.claude/strapped.json` with their chosen `stateRoot`) or keep state repo-relative — only then finalize `<runRoot>` and where configs go.

**Unconditional resume probe.** Once `<runRoot>` is known, probe `<runRoot>/<slug>/manifest.md` — **on every path, including `--repo` given**. If it exists, this is a **resume**: read its `repos:` map (its entries are the target repos), and jump to 1e as a resume. So re-invoking with an explicit `--repo` on an in-progress run resumes instead of re-scaffolding. (When `--repo` was omitted and 1a already found the run, that same manifest is the one probed here — no double work.)

### 1d — Per-repo config for EVERY target repo

For **each** target repo, resolve its config per the conventions' *Resolving the per-repo config* rule — the stateRoot mode fixes the location, parameterized by that repo's name+root, never "the cwd repo":

- **Shared mode:** `<stateRoot>/repos/<repoName>/config.json`.
- **Repo-relative mode:** repo-local `<rAbs>/.claude/strapped-config.json`.

If a repo's config is **missing**, generate one and **confirm the values with the user** before continuing. Configs differ per repo — validations come from **that repo's** CLAUDE.md check commands, `worktreeRoot` = **that repo's** `<parent>/<name>__worktrees`, plus provisioning:

```json
{
  "validations": ["<derived from THAT repo's CLAUDE.md validation/check commands>"],
  "worktreeRoot": "<that-repo-parent>/<that-repo-name>__worktrees",
  "provisioning": "<untracked files worktrees need for validations (placeholder values only, never real secrets), or empty>"
}
```

Write each generated config at `<stateRoot>/repos/<repoName>/config.json` in shared mode, or repo-local `.claude/strapped-config.json` in repo-relative mode. **On resume, skip generation for any repo whose config already resolves.**

### 1e — Scaffold or resume

If this is a **resume** (either the 1a match on the `--repo`-omitted path, or the 1c unconditional `<runRoot>/<slug>/manifest.md` probe on the `--repo`-given path), read its `status` and resume at the matching step below (`draft`/`in-review` → step 3; `approved` or later → tell the user this run is already approved and stop, pointing at `/strapped:status`). The target repos come straight off that manifest's `repos:` map — the config-generation loop in 1d is skipped for repos whose config already resolves, and **no re-inference or AskUserQuestion fires**, so the user cannot land on a different run root by answering a confirm step differently.

Otherwise scaffold a fresh run:

```bash
mkdir -p <runRoot>/<slug>/{deliverables,reviews,critiques}
touch <runRoot>/<slug>/critiques/user-critiques.md
```

The manifest (written by the planner agent in step 3) must carry the `repos:` map (name/root/config per the conventions' [manifest schema](../../conventions.md)); the skill supplies the target-repo list to the workflow so the planner can write it.

## Step 2 — Rule snapshot and per-round assignments

1. Extract the guideline rules per the conventions (discover every applicable CLAUDE.md, one numbered rule per normative imperative, skip validation-command boilerplate) and write `reviews/rules-snapshot.md`.
2. Compute the per-round rule split with the seeded-shuffle recipe from the conventions, adapted to emit full rule objects — for each round `1..max_rounds`, a `{"a": [{"id", "source", "text"}...], "b": [...]}` pair, shuffled with `random.Random(seed + round)` and split in half. Save the JSON output; it goes into the workflow args verbatim. Never use ad-hoc randomness — the seed is the only entropy source.

## Step 3 — Run the plan loop workflow

Invoke the `strapped-plan-loop` workflow — invoke the Workflow tool with `scriptPath: $PLUGIN_ROOT/workflows/plan-loop.js` (scriptPath, not name: name resolution can serve a stale registration) — with args (all paths absolute):

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "sourcePlan": "<abs path to the source plan.md>",
  "repos": [
    { "name": "<targetRepo1>", "root": "<abs repo root>", "config": "<abs config path>", "validations": ["<from that repo's config>"] },
    { "name": "<targetRepo2>", "root": "<abs repo root>", "config": "<abs config path>", "validations": ["<from that repo's config>"] }
  ],
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "reviewLoopScript": "$PLUGIN_ROOT/workflows/review-loop.js",
  "rulesByRound": [<the per-round splits from step 2>],
  "maxRounds": 3,
  "confidenceMin": 70,
  "seed": 42
}
```

`reviewLoopScript` is an explicit absolute scriptPath for the extracted plan-review loop (`plan-loop.js` runs its planner phase, then delegates the review loop to `review-loop.js` via `workflow(...)`). Passing it explicitly honors the "scriptPath, not name" convention — name resolution can serve a stale registration — so the plan flow never depends on the bare-string `strapped-review-loop` name fallback.

`repos` is the full target-repo list (one entry per repo, each carrying its resolved `validations`). The planner uses `repos` to (a) write the manifest's `repos:` map (name/root/config), (b) set each deliverable's required `repo:` field to one of `repos[].name`, and (c) verify claims across **all** target repos. The planner must also obey the conventions' **cross-repo base rule**: a deliverable's `base:` is a branch in the *same* repo as its `repo:`, and a deliverable whose parent is in a different repo bases on its own repo's `main` (cross-repo deps are ordering-only, never a code dependency).

The workflow runs the planner (which writes `research.md`, `manifest.md`, and the deliverable files), then up to `maxRounds` adversarial review rounds. It returns `{converged, rounds, deliverables, outstanding, summary}`.

## Step 4 — Handle the outcome

- **Converged**: proceed to step 5.
- **Not converged** (budget exhausted): do not proceed silently. Present the `outstanding` findings to the user with the round files as reference. Work through them with the user directly (main agent, no subagents) — either fix the plan yourself per their guidance or get their explicit okay to proceed despite a finding. Only then continue.

## Step 5 — Interactive final review with the user

Walk the user through the plan: theme summary, the DAG (render it), then each deliverable briefly. Apply their tweaks directly with Edit — **no subagents in this step**. For every substantive correction the user makes (anything expressible as a general guideline, not just a plan-specific tweak), append an entry to `critiques/user-critiques.md` per the conventions format with `synthesized: false`.

## Step 6 — Approve

Set `status: approved` in `manifest.md`. Tell the user the next command: `/strapped:implement <slug>`, and that `/strapped:status <slug>` shows state at any time.
