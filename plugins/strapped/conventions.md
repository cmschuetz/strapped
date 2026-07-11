# Harness conventions

Shared reference for the `strapped` skill suite. Every skill and workflow script defers to this file for state layout, formats, naming, budgets, and procedures. All state is designed so any skill can cold-start from disk alone after a full context clear.

## Repos

A strapped run targets one or more **target repos** — the repos where code changes actually land. Repo identity is an **explicit input** to `/strapped:plan` (see [Config resolution](#config-resolution)), never derived from the cwd: the cwd may be a plans repo, `~`, or any directory unrelated to the work.

`repos:` is an **unordered set** — no repo is special. Runs↔repos is **one-to-many**: a run may span several repos, and repos have **no concept of runs**. Every target repo has its own per-repo config in an isolated repo namespace, and every deliverable declares which repo it targets. The full set is recorded in the manifest's [`repos:` map](#manifestmd).

## Directory layout

Under `stateRoot`, strapped writes exactly two sibling namespaces — `runs/` (run state, keyed by slug) and `repos/` (per-repo config, keyed by repo name). No run state ever lives under `repos/`, and no config ever lives under `runs/`.

```
<stateRoot>/
  runs/<slug>/                   # RUN state — owned by the run, keyed by slug
    manifest.md                  # DAG structure + repos map + plan-level status
    research.md                  # distilled research digest (~300 line cap)
    deliverables/D1-<kebab>.md   # one self-contained plan per DAG node
    reviews/rules-snapshot.md    # numbered rules + sources + per-round assignments
    reviews/plan-round-<N>.md    # plan review round records (the "seen" set)
    reviews/<Did>-code-round-<N>.md
    critiques/user-critiques.md  # append-only log feeding /strapped:learn
  repos/<repoName>/config.json   # REPO config — owned by repos, keyed by repo name; NO runs here
```

All state for one strapped run lives under a single **run root** `<runRoot>/<slug>/`, keyed by the run's slug, never by a repo. A run is never split across repos: one run = one run root = one `manifest.md`, regardless of how many repos it touches. `<runRoot>` is always `<stateRoot>/runs/`, with `stateRoot` resolved by the [Config resolution](#config-resolution) algorithm below.

`<slug>` is derived from the source plan filename: `plans/foo_bar.md` → `foo-bar` (lowercase kebab-case). The slug is globally unique under one `stateRoot`.

## manifest.md

DAG *structure*, the target-repo map, and plan-level status only. Per-deliverable status lives solely in the deliverable file — never duplicate it here.

```markdown
---
slug: <slug>
source_plan: plans/<name>.md
created: <YYYY-MM-DD>
status: draft | in-review | approved | implementing | complete
seed: 42
budgets:
  plan_rounds: 3
  code_rounds: 3
  confidence_min: 70
repos:
  - { name: fraud-override-service, root: /abs/path, config: <stateRoot>/repos/fraud-override-service/config.json }
  - { name: risk-decisioning, root: /abs/path, config: <stateRoot>/repos/risk-decisioning/config.json }
deliverables:
  - { id: D1, file: deliverables/D1-foo.md, deps: [] }
  - { id: D2, file: deliverables/D2-bar.md, deps: [D1] }
---
# <Theme title>

One-paragraph theme summary. ASCII DAG sketch. Link to research.md.
```

The `repos:` map is an unordered set of every repo the run touches. Each entry:

- `name` — the canonical `<repo>` name (basename of `root`); a deliverable's `repo:` field references it.
- `root` — absolute repo top-level (a real git worktree top-level).
- `config` — absolute path to that repo's per-repo config (see [Config resolution](#config-resolution)).

The `repos:` map is **required**. For a single-repo run the map has one entry. Consumers derive every repo-scoped value (root, config, worktreeRoot, validations, provisioning) for a deliverable by looking up `repos[<deliverable.repo>]`.

## deliverables/D#-<kebab>.md

The single channel from planning to implementation. A fresh implementer seeded with only this file (plus `research.md`) must be able to do the work. **Split deliverables by discrete theme, not by size** — keep one coherent theme in a single deliverable so a reviewer can grasp the whole change in one PR. Split a theme into multiple deliverables only when its estimated *meaningful* diff exceeds ~1,000 changed lines. Meaningful diff excludes mechanical churn: generated code, dependency/lockfile bumps, generated clients/schemas, vendored code, and large fixtures/snapshots. Prefer a few cohesive, independently-shippable nodes over many fragments that scatter one theme across PRs.

```markdown
---
id: D2
title: <title>
deps: [D1]
repo: <repoName>                          # one of manifest.repos[].name (required)
status: pending | ready | in-progress | implemented | in-review | fixing | done | parked | pr-open | merged
branch: strapped/<slug>/D2-<kebab>
base: strapped/<slug>/D1-<kebab>          # a branch IN repo:; or main for roots (see cross-repo base rule)
worktree: /abs/path | null                # resumability marker
pr: null | <url>
review_rounds_used: 0
feedback_rounds_used: 0                   # PR-feedback code-review rounds (see Feedback loop); separate from review_rounds_used
parked_reason: null
estimated_diff_lines: 450                 # estimate of MEANINGFUL diff (excludes generated code, dep bumps, fixtures)
---
## Context
Distilled research slice relevant to THIS node: architecture, decisions, pitfalls.

## Files to touch
Navigation map (path — one-line role) so the implementer skips rediscovery.

## Implementation steps

## Acceptance criteria
Each independently testable.

## Tests
Named tests mapped to ACs. Integration-style per CLAUDE.md: public interfaces, no mocking, aiohttp test servers for network, polyfactory for stubs.

## Out of scope
```

`repo:` is **required** (no defaulting) and must be one of the manifest `repos[].name`. Every repo-scoped value for the deliverable derives from it: `manifest.repos[repo]` supplies the repo root and config path, and that config supplies `worktreeRoot`, `validations`, and `provisioning`. For a single-repo plan `repo:` is that one repo.

Status lifecycle: `pending → ready → in-progress → implemented → in-review → (fixing ⇄ in-review) → done → pr-open → merged`, with `parked` reachable from any implementation state. `ready` = all deps `done`. The [Feedback loop](#feedback-loop) adds a **re-entry edge** `pr-open → fixing ⇄ in-review → pr-open`: an already-open PR whose review requested changes drops back into a `fixing`/`in-review` sub-cycle for the feedback fix, then returns to `pr-open` (the PR is still open; `/strapped:pr --update` re-pushes the branch, it does not reopen). Feedback re-entry never goes back through `pending`/`ready`/`in-progress`, and its rounds increment `feedback_rounds_used`, not `review_rounds_used`.

## Review round records

`reviews/plan-round-<N>.md` and `reviews/<Did>-code-round-<N>.md`. These double as the dedup seen-set and the audit trail. Written by the consolidator agent at the end of each round.

```markdown
---
round: 2
seed_used: 44
reviewer_a_rules: [R1, R4, R7]
reviewer_b_rules: [R2, R3, R5]
new_confirmed: 1
outcome: revise | converged | budget-exhausted
findings:
  - { id: pr2-f1, key: "R4:deliverables/D2#tests", severity: blocking,
      verdict: confirmed, confidence: 85, status: open | fixed | refuted | duplicate }
---
Full finding bodies per id: what / why / evidence / recommendation.
```

Finding `key` format: `<rule-id-or-gap>:<location>` — used for dedup across rounds. A finding whose key matches a prior round's is a duplicate unless it regressed.

## critiques/user-critiques.md

Append-only. One entry per substantive user correction given during final plan review or when relaying gaps.

```markdown
## <ISO timestamp> (phase: final-plan-review | implementation-feedback)
critique: "<verbatim or lightly paraphrased user correction>"
generalizable: yes | no
synthesized: false
```

`/strapped:learn` consumes entries with `synthesized: false` and flips them to `true` after an approved CLAUDE.md update (or `no` — rejected).

## Rule extraction

Performed by the skill at review time (the hierarchy may grow):

1. Discover: every `CLAUDE.md` in the repo (exclude `.venv`, worktrees) plus `~/.claude/CLAUDE.md` if present.
2. Extract every normative imperative (bullets and prose commands) as `R1..Rn` with verbatim text and source path. Exclude the validation-commands boilerplate — that is enforced by the validate stage, not reviewers.
3. Write `reviews/rules-snapshot.md`:

```markdown
---
extracted: <ISO timestamp>
sources: [CLAUDE.md]
---
- R1 (CLAUDE.md): Do not under any circumstances add comments when generating code
- R2 (CLAUDE.md): Use the most up-to-date python typing annotations for everything
...
```

## Seeded rule split

Deterministic, reshuffled each round with `seed + round`. Each rule is owned by exactly one reviewer. Computed in the skill (workflow scripts cannot use `Math.random()`), passed into workflow args as `rulesByRound`.

```bash
python3 - <<'EOF'
import json, random

seed = 42
max_rounds = 3
rule_ids = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]

rounds = []
for rnd in range(1, max_rounds + 1):
    rng = random.Random(seed + rnd)
    shuffled = rule_ids[:]
    rng.shuffle(shuffled)
    half = (len(shuffled) + 1) // 2
    rounds.append({"a": sorted(shuffled[:half]), "b": sorted(shuffled[half:])})
print(json.dumps(rounds))
EOF
```

## Reviewer lenses

Two reviewers per round, disjoint rule halves, plus a distinct lens each so the pair differs by concern:

- Plan review — **A: completeness** (every element of the ask covered? missing requirements, edge cases, test-per-AC gaps). **B: soundness** (wrong assumptions, DAG dependency errors, deliverables that mix unrelated themes or whose meaningful diff exceeds ~1,000 lines and should be split, undeclared cross-deliverable dependencies). Soundness cuts both ways — also flag over-fragmentation: deliverables that are fragments of one theme, or a linear chain whose combined meaningful diff (excluding generated code, dependency bumps, and fixtures) is under the ~1,000-line threshold and could be a single deliverable/PR, and should be consolidated.
- Code review — **A: correctness** (logic bugs, edge cases, race conditions, error paths, AC compliance). **B: convention & test fidelity** (guideline adherence, test quality: integration-style, no mocking, aiohttp test servers, polyfactory).

## Critique loop shape (both loops)

1. **Find** — 2 reviewers in parallel, fresh contexts, each with its rule half + lens + the seen digest ("known/addressed — do not re-report unless regressed").
2. **Refute** — for every `blocking`/`concern` finding, a fresh refuter (never the finder), stance: "NOT a real issue unless the artifact proves otherwise". Drop `refuted` and anything below `confidence_min` (70). `suggestion` findings skip refute and never drive the loop — recorded for the human only.
3. **Dedup-vs-seen** — merge same-root-cause findings by `key` against all prior rounds; only truly-NEW confirmed findings count.
4. **Act** — plan loop: reviser edits plan files. Code loop: fixer (same worktree) fixes, re-runs all validations, commits.
5. **Terminate** — zero NEW confirmed findings in a round → converged. Else next round until the budget (3). When the FINAL budgeted round's new findings were all fixed/revised (rather than the round finding zero new), the loop does not trust the fixer: it runs ONE **confirmation determination** — a single extra review pass that does NOT consume budget and NEVER starts a new loop — to check honestly for remaining gaps. Zero-new on that pass → converged (a fully-fixed final round is not falsely parked); any surviving NEW confirmed finding → **park with `parked_reason`** naming the genuinely-open findings. Any genuinely-open finding (fixer/reviser blocked, validations not green, or a finding that survived the confirmation pass) still parks — never proceed silently, never spin.

Verdict order per deliverable, first match wins: `parked` (budget exhausted with open blocking findings) > `fixing` (new confirmed findings this round) > `done` (converged + validations green).

## Config resolution

Configuration is split so per-repo settings live *with* the state, never inside a worked repo — worked repos gain zero strapped files:

- **Anchor** — carries only `stateRoot`, the **absolute** base directory under which all run state lives. It is the single bootstrap value (everything else is found relative to it) and never lives inside a worked repo. Two forms: `$STRAPPED_STATE_ROOT`, or `~/.claude/strapped.json` = `{ "stateRoot": "<abs path>" }`.
- **Per-repo config** — carries `validations`, `worktreeRoot`, `provisioning` (never `stateRoot` — its own location depends on it). One per target repo at `<stateRoot>/repos/<repoName>/config.json`, generated by `/strapped:plan` on first run and confirmed by the user.

### Repo is an explicit input, never cwd-derived

Repo identity is an **explicit input** to `/strapped:plan` (the `--repo <path|name>` argument, repeatable; when omitted the skill infers candidates and confirms with the user). It is **never** derived from the cwd — the cwd may be a plans repo, `~`, or any directory unrelated to the work. `git rev-parse --show-toplevel` is used **only** to canonicalize an *input* repo path to its absolute top-level (and it must run in that repo's main checkout, not a worktree, where `--show-toplevel` points at the worktree); it is never run on the cwd to *pick* which repo the work targets.

Each input resolves to an absolute repo root (a real git top-level) and a canonical `<repo>` name = its basename. Both are stored in the manifest `repos:` map. (Limitation: two repos with the same basename share a namespace — the same assumption the `worktreeRoot` default already makes.)

### Target repos

A run names N **target repos** (all `--repo` inputs) — an unordered set with no distinguished member. State lives in ONE run root keyed by the run's slug under `runs/` — one manifest per run; a run is never split across repos. Every target repo has its own per-repo config under `repos/`; `worktreeRoot`, `validations`, and `provisioning` may differ per repo (a Python service vs. a Ruby service).

### Resolving stateRoot (the anchor; first match wins)

1. `$STRAPPED_STATE_ROOT` — explicit, forceful override.
2. `~/.claude/strapped.json` → `stateRoot` (the anchor file).
3. Default: `~/.claude/strapped` — a sibling of Claude Code's own `~/.claude/plans/`; works on a fresh machine with no setup step.

Expand a leading `~` to `$HOME`. `stateRoot` is **always an absolute directory**: if the resolved value is still relative after expansion it is invalid input — skills stop with a clear message; the SessionStart hook (`scripts/sync-prs.sh`) exits 0 silently instead (it must never break session start).

### Resolving the run root

`<runRoot>` is slug-less; the run's state lives at `<runRoot>/<slug>/` (see [Directory layout](#directory-layout)): `<runRoot>` = `<stateRoot>/runs/`, unconditionally — run state at `<stateRoot>/runs/<slug>/`.

#### Cwd-independent slug → run-root resolution

The slug-addressed invocations — the downstream skills `/strapped:implement`, `/strapped:status`, `/strapped:pr`, **and** the `/strapped:plan` resume path (re-invoked with `--repo` omitted) — receive only a `<slug>` and a cwd that may be a plans dir. They MUST locate the run root **without** consulting the cwd. This is the authoritative resolution for **any** slug-only invocation. Because run state is keyed by slug under `runs/`, resolution is a **direct path** — no glob, no fallback: the run root is `<stateRoot>/runs/<slug>/`; probe `<stateRoot>/runs/<slug>/manifest.md`.

If `manifest.md` is absent it is a hard miss (caller-dependent): a slug-addressed downstream skill (implement/status/pr) stops with a helpful message (slug not found under `<stateRoot>`); the plan skill treats a miss as "no existing run" and proceeds to fresh inference/scaffold.

Once `manifest.md` is located, its `repos:` map supplies every target repo — cwd is **never** consulted. This is the source the slug-only invocations (downstream skills and plan-resume) defer to; the plan resume path recovers an existing run's `repos:` map off disk this way before re-inferring or re-confirming repos.

### Resolving the per-repo config

For a target repo named `<r>`, the location is fixed outright — no fallback chain, never inside the repo itself: `<stateRoot>/repos/<r>/config.json` (isolated repo namespace, sibling of `runs/`).

Every target repo resolves its own config by its own name — never "the cwd repo". `/strapped:plan` generates/confirms a config for **each** target repo on first run.

```json
{
  "validations": ["uv run pytest", "uv run ruff check", "uv run ruff format --check", "uv run pyright"],
  "worktreeRoot": "/abs/path/<repo-name>__worktrees",
  "provisioning": "Untracked files worktrees need for validations, with placeholder values — never real secrets."
}
```

The `validations` values above are an example.

## Harness scripts

Deterministic executables under `$PLUGIN_ROOT/scripts/`, invocable via Bash by skills and by workflow-dispatched agents. They are the **single source of truth** for config/run-root resolution, ready-set/topo computation, status transitions, and worktree creation — skills and workflow prompts invoke them and consume their JSON output; they must never hand-roll these mechanics in prose or reasoning. Every command prints exactly one JSON object on stdout and, on misuse, a one-line message on stderr with exit code 1. (`scripts/sync-prs.sh` is the exception: a SessionStart hook that must never break session start, so it always exits 0.)

### state.mjs — `node $PLUGIN_ROOT/scripts/state.mjs <command> ...`

Zero-dependency Node CLI. Frontmatter writes preserve every untouched line byte-for-byte and keep the single-space `key: value` line shape, so grep-based consumers (`sync-prs.sh`) keep working.

- **`resolve <slug>`** — resolves `stateRoot` per [Config resolution](#config-resolution) (`$STRAPPED_STATE_ROOT` → `~/.claude/strapped.json` → default `~/.claude/strapped`; leading `~` expanded; a value still relative after expansion is invalid input → exit 1) and probes `<stateRoot>/runs/<slug>/manifest.md` — the cwd-independent direct path, no glob. Output: `{ slug, stateRoot, runRoot, runDir, manifest, exists, status, seed, budgets, repos: [{ name, root, config, configExists, validations, worktreeRoot, provisioning }] }`, where `repos` comes from the manifest `repos:` map joined with each repo's config at `<stateRoot>/repos/<name>/config.json`. A missing manifest is NOT an error: `exists: false`, exit 0 (the plan skill treats a miss as "no existing run"; slug-addressed downstream skills stop themselves).
- **`dag <runDir> [--only <Did>]`** — reads the manifest `deliverables` list and every deliverable file's frontmatter. Output: `{ manifest: {status, seed, budgets}, nodes: [{id, file, title, status, deps, repo, branch, base, worktree, pr, review_rounds_used, feedback_rounds_used, parked_reason, estimated_diff_lines}], ready, topo, blocked: [{id, blockedOn}], remaining }`. `ready` = `status: pending` nodes whose deps are all `done`/`pr-open`/`merged`; with `--only`, a `parked`/`in-progress` node is additionally admitted (implement's `--only` resume semantics) and `ready` is intersected with the named node. `topo` = stable topological order, parents before children, ties broken by id. `remaining` = count of nodes NOT yet `done`/`pr-open`/`merged` — done-or-later counts as complete, so a partially-shipped run reports the true remaining work; consumers read this field verbatim and never recompute it. Unknown dep id or dependency cycle → exit 1 naming the offender.
- **`set <file> <field> <value>`** — idempotent single-field frontmatter write; `value` is written verbatim after `<field>: ` (`null` writes literal `null`). `value` must be a single line: a value containing `\n` or `\r` → exit 1, no write (a multi-line value would inject extra frontmatter lines). A field not already present in the file's frontmatter → exit 1 (no silent field invention). Output: `{file, field, old, new}`.
- **`transition <file> <to> [--from <expected>]`** — guarded deliverable status flip over the on-disk edge table below. `--from` adds an exact-current-status guard. Transitioning to the current status is an idempotent no-op: exit 0, `{changed: false}`. An illegal edge → exit 1 naming the current status and requested edge, no write. Output: `{file, from, to, changed}`.
- **`manifest-status <runDir> <to>`** — guarded manifest-level flip along `draft → in-review → approved → implementing → complete`, **forward-only**. Same-status flip is an idempotent no-op (exit 0, `{changed: false}`) — a resumed chain re-running it must not error; backward flips exit 1. Output: `{file, from, to, changed}`.

#### On-disk transition edge table

The lifecycle prose in [deliverables/D#-\<kebab\>.md](#deliverablesd-kebabmd) is the *conceptual* chain; this table is what `transition` enforces. `ready`, `implemented`, and the mid-wave `in-review` are **virtual** statuses — they exist in the conceptual chain and in agent schemas but are never written to deliverable frontmatter by any skill or workflow (implement flips `pending → in-progress` directly and applies wave outcomes as `in-progress → done`/`parked`), so the guard encodes the skip-edges actually written to disk:

| from | to | written by |
| --- | --- | --- |
| pending | in-progress | implement (wave dispatch) |
| parked | in-progress | implement `--only` resume |
| in-progress | done | implement (wave outcome) |
| in-progress | parked | implement (wave outcome) |
| fixing | parked | fix loop exhausted/blocked |
| in-review | parked | review loop exhausted |
| done | parked | pr `--update` rebase conflict (pre-PR child) |
| pr-open | parked | pr `--update` rebase conflict |
| done | pr-open | pr |
| pr-open | merged | sync-prs.sh / pr |
| pr-open | fixing | feedback re-entry |
| fixing | in-review | feedback fix sub-cycle |
| in-review | fixing | feedback fix sub-cycle |
| in-review | pr-open | feedback fix converged |
| in-review | done | feedback fix converged (pre-PR node) |

Everything else — including virtual-status edges like `pending → ready` or `in-progress → implemented` — is rejected.

### ensure-worktree.sh — `$PLUGIN_ROOT/scripts/ensure-worktree.sh <repoRoot> <worktreePath> <branch> <base>`

The idempotent worktree recipe from [Worktrees and branches](#worktrees-and-branches) as pure git + bash:

- `<worktreePath>` exists and its checked-out branch equals `<branch>` → reuse: `{"worktree": ..., "branch": ..., "created": false}`, exit 0.
- `<worktreePath>` exists on a different branch (or is not a git worktree) → one-line stderr, exit 1.
- `<branch>` already exists in the repo but has no worktree → re-attach: `git -C <repoRoot> worktree add <worktreePath> <branch>` (no `-b`).
- Otherwise create: `git -C <repoRoot> worktree add <worktreePath> -b <branch> <base>`.

Output is one JSON object `{"worktree", "branch", "created"}` on stdout; git failures exit non-zero with git's stderr passed through.

## Composable chains

Status: **partially shipped**. The chain architecture (a chain-run orchestrator workflow sequencing plan → implement → pr stage workflows, plus an implement-run wave-loop workflow) is blocked on the verified Workflow-tool nesting limit below; only the pr stage workflow (`strapped-pr-run`) exists.

### Workflow nesting limit (verified)

Verified 2026-07-11 against the real Workflow tool, with throwaway scriptPath chains dispatched at depths 2, 3, and 4:

- **Depth 2** — a root workflow dispatching one child via `workflow({ scriptPath })` — **works**: the child's return value and its `phase`/`log` output surface at the root.
- **Depth 3 and depth 4 fail**: a CHILD workflow may not call `workflow()` at all. Exact runtime error: `workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.`

Consequence: a chain-run orchestrator workflow cannot dispatch the existing stage workflows, because `plan-loop.js → review-loop.js` and `implement-wave.js → code-review.js` each already consume the single allowed nesting level. Neither the planned depth-4 chain (chain-run → implement-run → implement-wave → code-review) nor its flatten-to-3-levels fallback (chain-run absorbing the wave loop and dispatching implement-wave directly) is buildable. Chain sequencing therefore cannot live in a workflow above the existing stage workflows: it must live in a skill that dispatches each stage workflow as a ROOT workflow in order (each stage then keeps its one nesting level), and the implement wave loop must stay skill-side (as in `/strapped:implement` today) unless the review dispatch inside `implement-wave.js` is restructured.

### strapped-pr-run

The stacked-PR create pass as a workflow stage. Safe to dispatch either as a root workflow or as another workflow's child, because it dispatches no sub-workflows — it is a single PR agent.

- cfg: `{ slug, dir, conventionsFile, stateScript, dryRun }` — `stateScript` is the absolute path to `scripts/state.mjs`, `dir` the run root.
- One `pr-create` agent runs the [Stacked PRs](#stacked-prs) create procedure mechanically through `state.mjs` (`resolve` for the repos map, `dag` for nodes + topo order, then per created PR `set <file> pr <url>` and `transition <file> pr-open`), and carries the pr skill's guardrails verbatim: never push `main`, never merge PRs, never `--force` (only `--force-with-lease`), enforced per repo via `-C <deliverableRepoRoot>`; an unauthenticated `gh` or a branch with no commits beyond its base is reported and skipped (`prs[].skipped: true` with a human-readable `reason`), never failing the stage.
- `dryRun: true` → print-only: no push, no PR create/edit, no state writes; the would-be commands are returned in `summary`, every `url` is null and every node `skipped: true`.
- Returns `{ slug, dryRun, prs: [{id, url, skipped, reason}], summary }`.

## Validations

Every command in the **deliverable's repo's** config `validations` must be green before code review and after every fix round, run inside the deliverable's worktree.

## Worktrees and branches

All repo-scoped values below come from the **deliverable's repo** — `manifest.repos[deliverable.repo]` for the root, and that repo's config for `worktreeRoot`, `validations`, and `provisioning`.

- Branch: `strapped/<slug>/<Did>-<kebab>`; base = parent deliverable's branch **when the parent is in the same repo** (roots, and cross-repo children: `main` — see below).
- Worktree: `<worktreeRoot>/<slug>/<Did>` (from the deliverable's repo's config; default `<repo-parent>/<repo-name>__worktrees`) — persistent, outside the repo tree. `git worktree add` runs **inside the deliverable's repo root**:

```bash
git -C <deliverableRepoRoot> worktree add <worktreeRoot>/<slug>/<Did> -b strapped/<slug>/<Did>-<kebab> <base>
```

- Idempotent on resume: if the worktree path exists and its branch matches the frontmatter, reuse it.
- Provisioning: apply the deliverable's repo's config `provisioning` instructions to every fresh worktree (e.g. a placeholder `.env`) — never copy real secrets into a worktree.
- **Freeze rule**: once any child has branched off a deliverable's branch, that branch changes only via `/strapped:pr --update`, which rebases each child: `git rebase --onto <new-parent-tip> <old-parent-tip> <child-branch>` then `git push --force-with-lease`. This applies **within a single repo only** — cross-repo children root on `main`, so there is no cross-repo rebase.

### Cross-repo base rule

`base:` must be a branch **in the same repo as the deliverable** (its `repo:`). A deliverable whose parent is in a *different* repo cannot branch off that parent — it bases on its **own repo's `main`**. Cross-repo deps may still order the child after the parent for wave scheduling.

### Cross-repo deps are ordering-only — never a code dependency

A cross-repo dep expresses **scheduling order only**, not a code dependency. Because a cross-repo child bases on its own repo's `main`, it does **not** have its parent's unmerged branch available; it MUST NOT rely on code produced by its parent's deliverable. The planner must **reject or restructure** any plan where a cross-repo child has a true code dependency on its parent — either:

- (a) require the shared/contract change to land and merge to the parent repo's `main` before the run (or in an earlier, already-merged deliverable), or
- (b) keep both sides of the dependency in the **same repo** (same deliverable, or a same-repo chain so normal branch stacking supplies the code).

This is a hard rule reviewers and the planner enforce.

## Stacked PRs

Topological order over `done` deliverables. Per node: push/create in the **deliverable's own repo** — `git -C <deliverableRepoRoot> push -u origin <branch>`, then `gh pr create --head <branch> --base <parent-branch|main>` in that repo. Parent→child branch stacking only applies **within a single repo**; a cross-repo child roots on `main`, so its PR bases on `main` (not the parent branch) — no cross-repo rebase. PR body: summary + ACs + a `Stack:` table of the whole DAG with PR links + `Depends on #<parent-PR>` for same-repo non-roots. The `Stack:` table may span repos; group or label rows by repo. Record the URL in frontmatter, set status `pr-open`. `--dry-run` prints every git/gh command and PR body without pushing anything.

The `pr-open → merged` transition is owned by `scripts/sync-prs.sh`, run automatically by the plugin's SessionStart hook (startup/resume only, never per subagent): it checks each `pr-open` deliverable's PR via `gh`, flips merged ones, warns on closed-unmerged or changes-requested PRs, and hints at newly unblocked children. `/strapped:pr` performs the same idempotent flip when invoked manually.

## Feedback loop

`/strapped:feedback <slug> [--deliverable <Did>]... [--pr <url>]... [--dry-run] [--max-rounds N]` closes the loop from PR review comments back into the plan→implement lifecycle. It is built ENTIRELY from existing building blocks — it hand-rolls no planning or fix logic.

**GitHub via `gh`.** All PR data comes from `gh` (`gh api repos/{owner}/{repo}/pulls/{n}/comments|reviews`, `gh pr view --json comments`). There is no GitLab/`glab` code path and no provider-abstraction layer.

Flow, **batched over the whole run** (stacked-PR comments are interdependent — never process one PR at a time as an isolated unit):

1. **Fetch** review comments from every in-scope deliverable PR (default: every deliverable with a `pr:` URL that has review comments or a request-changes/comment review; `--deliverable`/`--pr` narrows). THREE categories: line-anchored review comments (`/pulls/{n}/comments`), review-SUBMISSION bodies (`/pulls/{n}/reviews` — `state` + `body`, where a CHANGES_REQUESTED reviewer states the overarching problem; fed into synthesis as GLOBAL feedback), and global/issue comments (`gh pr view --json comments`). The anchored `path` is carried so synthesis can reassign a comment cross-deliverable.
2. **Synthesize cross-deliverable addenda** — ONE consolidated plan. A comment left on one PR can produce a fix task on a DIFFERENT deliverable (routed via each deliverable's `Files to touch` map); each fix is appended as a `## Feedback addendum` section on the CORRECT **existing** deliverable file. **No new deliverables, branches, or worktrees are minted.**
3. **Adversarial review** the synthesized addenda through the SAME machinery — the plan-review loop, extracted into the standalone workflow `review-loop.js` and invoked via the ambient `workflow({ scriptPath })` helper (NOT a JS `import`; a workflow file is not a loadable module). Reviewers/refute/dedup/consolidate/revise + the final-round confirmation pass run bounded by the budget. Records land as `reviews/feedback-round-<N>.md` — **distinct from** the original run's `plan-round-<N>.md`.
4. **Explicit user approval** — the same final-review gate `/strapped:plan` uses, before any implementation. `--dry-run` stops here after printing the plan and the would-run commands, mutating nothing.
5. **Implement in topological (stack) order** so a parent's fixes land before children rebase. Reuse `implement-wave.js` on each affected deliverable's EXISTING branch/worktree via its `addendumMode` seam (the implement stage APPLIES the `## Feedback addendum` to the existing code instead of re-implementing), and `code-review.js` threaded with a `recordSuffix` so feedback code-review rounds write `<Did>-code-round-<N>-feedback.md` (not clobbering the original `<Did>-code-round-<N>.md`); `implement-wave.js` derives the fix agent's round-record READ path from the SAME suffix so writer and reader agree. Freeze rule preserved. Never force-push or merge here.
6. **Cascade** — after fixes change a parent branch, the stacked-child rebase/re-push is the existing `/strapped:pr <slug> --update` freeze-rule path, offered ONCE for the whole batch.

**Reuse mechanism.** The plan-review loop lives in `review-loop.js` (its own `export const meta` + injected ambient helpers). BOTH `plan-loop.js`'s planner phase (ask = the source plan, `roundFilePrefix: plan-round`) and `feedback-synth.js` (ask = the fetched PR review comments, artifact = the amended deliverable set, `roundFilePrefix: feedback-round`) invoke it via `workflow(cfg.reviewLoopScript ? { scriptPath: cfg.reviewLoopScript } : 'strapped-review-loop', …)` — a bare-string NAME fallback, an absolute path only ever inside `{ scriptPath }`, exactly mirroring `implement-wave.js`'s `codeReviewScript` call to `code-review.js`. Both the plan flow and the feedback flow pass the explicit absolute scriptPath (never the name fallback), honoring "scriptPath, not name". Neither invokes `strapped-plan-loop` for feedback (that would run the planner phase and clobber the addenda).

**Status re-entry & counters.** Feedback enters when a deliverable is already `pr-open` (triggered off `sync-prs.sh`'s `CHANGES_REQUESTED` warning). The re-entry edge is `pr-open → fixing ⇄ in-review → pr-open`: the deliverable drops into the `fixing`/`in-review` sub-cycle for the fix, then returns to `pr-open` (its PR stays open; `--update` re-pushes the branch, it does not reopen). It never returns to `pending`/`ready`/`in-progress`. Feedback rounds use a **separate counter** `feedback_rounds_used` (a frontmatter field, default 0), NOT the original `review_rounds_used`, mirroring the separate record-file naming — so the original run's round budget/audit stays intact.

## Cleanup recipe

Worktree/branch cleanup runs per deliverable, in that deliverable's repo (`-C <deliverableRepoRoot>`); the run root is removed once for the whole run.

```bash
git -C <deliverableRepoRoot> worktree list
git -C <deliverableRepoRoot> worktree remove <worktreeRoot>/<slug>/<Did>
git -C <deliverableRepoRoot> branch -D strapped/<slug>/<Did>-<kebab>
rm -rf <runRoot>/<slug>
```
