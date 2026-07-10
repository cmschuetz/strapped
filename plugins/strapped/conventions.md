# Harness conventions

Shared reference for the `strapped` skill suite. Every skill and workflow script defers to this file for state layout, formats, naming, budgets, and procedures. All state is designed so any skill can cold-start from disk alone after a full context clear.

## Repos

A strapped run targets one or more **target repos** — the repos where code changes actually land. Repo identity is an **explicit input** to `/strapped:plan` (see [Config resolution](#config-resolution)), never derived from the cwd: the cwd may be a plans repo, `~`, or any directory unrelated to the work.

One target repo is the run's **primary repo** — the first `--repo`, or the sole repo when only one is given. The primary repo's namespace holds the run's single state root; every target repo (primary included) has its own per-repo config, and every deliverable declares which repo it targets. The full set is recorded in the manifest's [`repos:` map](#manifestmd).

## Directory layout

All state for one strapped run lives under a single **run root** `<runRoot>/<slug>/`, in the **primary repo's** namespace. A run is never split across repos: one run = one run root = one `manifest.md`, regardless of how many repos it touches. `<runRoot>` is resolved by the [Config resolution](#config-resolution) algorithm below — by default `<stateRoot>/<primaryRepo>/` beneath a shared (often global) state root, or `<stateRoot>/` inside the primary repo in legacy repo-relative mode. Sibling repos may have their own run roots under `<stateRoot>/<otherRepo>/` for *their own* runs; those are unrelated to this run.

```
<runRoot>/<slug>/
  manifest.md                    # DAG structure + repos map + plan-level status
  research.md                    # distilled research digest (~300 line cap)
  deliverables/D1-<kebab>.md     # one self-contained plan per DAG node
  reviews/rules-snapshot.md      # numbered rules + sources + per-round assignments
  reviews/plan-round-<N>.md      # plan review round records (the "seen" set)
  reviews/<Did>-code-round-<N>.md
  critiques/user-critiques.md    # append-only log feeding /strapped:learn
```

`<slug>` is derived from the source plan filename: `plans/foo_bar.md` → `foo-bar` (lowercase kebab-case).

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
  - { name: fraud-override-service, root: /abs/path, config: /abs/strapped-config.json, primary: true }
  - { name: risk-decisioning, root: /abs/path, config: /abs/strapped-config.json }
deliverables:
  - { id: D1, file: deliverables/D1-foo.md, deps: [] }
  - { id: D2, file: deliverables/D2-bar.md, deps: [D1] }
---
# <Theme title>

One-paragraph theme summary. ASCII DAG sketch. Link to research.md.
```

The `repos:` map lists every repo the run touches. Each entry:

- `name` — the canonical `<repo>` name (basename of `root`); a deliverable's `repo:` field references it.
- `root` — absolute repo top-level (a real git worktree top-level).
- `config` — absolute path to that repo's per-repo config (see [Config resolution](#config-resolution)).
- `primary` — present and `true` on **exactly one** entry (the primary repo, whose namespace holds `<runRoot>`).

For a single-repo run the map has one entry, flagged primary. Consumers derive every repo-scoped value (root, config, worktreeRoot, validations, provisioning) for a deliverable by looking up `repos[<deliverable.repo>]`. **Legacy on-disk back-compat:** a manifest written before this re-spec has **no** `repos:` map; see [Legacy on-disk back-compat](#legacy-on-disk-back-compat).

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

`repo:` is **required** and must be one of the manifest `repos[].name`. Every repo-scoped value for the deliverable derives from it: `manifest.repos[repo]` supplies the repo root and config path, and that config supplies `worktreeRoot`, `validations`, and `provisioning`. For a single-repo plan `repo:` is the primary repo. **Legacy back-compat:** a deliverable written before this re-spec has no `repo:` field; consumers default it to the synthesized primary — see [Legacy on-disk back-compat](#legacy-on-disk-back-compat).

Status lifecycle: `pending → ready → in-progress → implemented → in-review → (fixing ⇄ in-review) → done → pr-open → merged`, with `parked` reachable from any implementation state. `ready` = all deps `done`.

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

- Plan review — **A: completeness** (every element of the ask covered? missing requirements, edge cases, test-per-AC gaps). **B: soundness** (wrong assumptions, DAG dependency errors, deliverables that mix unrelated themes or whose meaningful diff exceeds ~1,000 lines and should be split, undeclared cross-deliverable dependencies).
- Code review — **A: correctness** (logic bugs, edge cases, race conditions, error paths, AC compliance). **B: convention & test fidelity** (guideline adherence, test quality: integration-style, no mocking, aiohttp test servers, polyfactory).

## Critique loop shape (both loops)

1. **Find** — 2 reviewers in parallel, fresh contexts, each with its rule half + lens + the seen digest ("known/addressed — do not re-report unless regressed").
2. **Refute** — for every `blocking`/`concern` finding, a fresh refuter (never the finder), stance: "NOT a real issue unless the artifact proves otherwise". Drop `refuted` and anything below `confidence_min` (70). `suggestion` findings skip refute and never drive the loop — recorded for the human only.
3. **Dedup-vs-seen** — merge same-root-cause findings by `key` against all prior rounds; only truly-NEW confirmed findings count.
4. **Act** — plan loop: reviser edits plan files. Code loop: fixer (same worktree) fixes, re-runs all validations, commits.
5. **Terminate** — zero NEW confirmed findings → converged. Else next round until the budget (3), then **park with `parked_reason`** — never proceed silently, never spin.

Verdict order per deliverable, first match wins: `parked` (budget exhausted with open blocking findings) > `fixing` (new confirmed findings this round) > `done` (converged + validations green).

## Config resolution

Configuration is split so per-repo settings can live *with* the state instead of inside a worked repo:

- **Anchor** — carries only `stateRoot`, the base under which all run state lives. It is the single bootstrap value (everything else is found relative to it) and never lives inside a worked repo. Two forms: `$STRAPPED_STATE_ROOT`, or `~/.claude/strapped.json` = `{ "stateRoot": "<path>" }`.
- **Per-repo config** — carries `validations`, `worktreeRoot`, `provisioning` (never `stateRoot` — its own location depends on it). One per target repo, generated by `/strapped:plan` on first run and confirmed by the user.

### Repo is an explicit input, never cwd-derived

Repo identity is an **explicit input** to `/strapped:plan` (the `--repo <path|name>` argument, repeatable; when omitted the skill infers candidates and confirms with the user). It is **never** derived from the cwd — the cwd may be a plans repo, `~`, or any directory unrelated to the work. `git rev-parse --show-toplevel` is used **only** to canonicalize an *input* repo path to its absolute top-level (and it must run in that repo's primary checkout, not a worktree, where `--show-toplevel` points at the worktree); it is never run on the cwd to *pick* which repo the work targets.

Each input resolves to an absolute repo root (a real git top-level) and a canonical `<repo>` name = its basename. Both are stored in the manifest `repos:` map. (Limitation: two repos with the same basename share a namespace — the same assumption the `worktreeRoot` default already makes.)

### Primary repo vs target repos

A run names one **primary repo** (first `--repo`, or the sole repo) plus N **target repos** (all `--repo` inputs, primary included). State lives in ONE run root under the **primary repo's** namespace — one manifest per run; a run is never split across repos. Every target repo has its own per-repo config; `worktreeRoot`, `validations`, and `provisioning` may differ per repo (a Python service vs. a Ruby service).

### Resolving stateRoot (the anchor; first match wins)

1. `$STRAPPED_STATE_ROOT` — explicit, forceful override.
2. repo-local `.claude/strapped-config.json` → `stateRoot` (a repo opting to stay self-contained — back-compat; keyed on a target repo, not the cwd).
3. `~/.claude/strapped.json` → `stateRoot` (the anchor; the new default).
4. `plans/strapped` (default).

Expand a leading `~` to `$HOME`. An **absolute** result → *shared mode*; a **relative** result → *legacy repo-relative mode*.

### Resolving the run root

The run root is addressed by primary repo in shared mode, or is repo-relative in legacy mode. `<runRoot>` is slug-less; the run's state lives at `<runRoot>/<slug>/` (see [Directory layout](#directory-layout)):

- **Shared mode** (absolute `stateRoot`): `<runRoot>` = `<stateRoot>/<primaryRepo>/`.
- **Legacy repo-relative mode** (relative `stateRoot`): `<runRoot>` = `<primaryRepoAbs>/<stateRoot>/`. No `<repo>` segment — state is already repo-scoped.

#### Cwd-independent slug → run-root resolution

The slug-addressed invocations — the downstream skills `/strapped:implement`, `/strapped:status`, `/strapped:pr`, **and** the `/strapped:plan` resume path (re-invoked with `--repo` omitted) — receive only a `<slug>` and a cwd that may be a plans dir. They MUST locate the run root **without** deriving the primary repo from `git rev-parse` on cwd. This is the authoritative resolution for **any** slug-only invocation. Rule (first match wins):

- **Shared mode:** glob `<stateRoot>/*/<slug>/manifest.md` and take the single match's directory as the run's `<runRoot>/<slug>` (its parent is `<runRoot>` = `<stateRoot>/<primaryRepo>/`).
  - **Zero** matches — caller-dependent: a slug-addressed downstream skill (implement/status/pr) stops with a helpful message (slug not found under `<stateRoot>`); the plan skill treats zero matches as "no existing run" and proceeds to fresh inference/scaffold (D2).
  - **Exactly one** match — use it.
  - **More than one** match (same slug under two primary-repo namespaces) — stop and ask the user to disambiguate; they may pass `--primary-repo <name>` to select `<stateRoot>/<name>/<slug>/`.
- **Legacy repo-relative mode:** `<runRoot>` = `<repoAbs>/<stateRoot>/` for the current repo, with the run's state at `<runRoot>/<slug>/`, as today (state is already repo-scoped, so cwd resolution is correct here).

Once `manifest.md` is located, its `repos:` map supplies every target repo — cwd is **never** consulted to pick the primary repo. This is the source the slug-only invocations (downstream skills and plan-resume) defer to; the plan resume path recovers an existing run's primary repo / `repos:` map off disk this way before re-inferring or re-confirming repos.

### Resolving the per-repo config (parameterized by repo; first match wins)

For a target repo named `<r>` with absolute root `<rAbs>`:

1. `<rAbs>/.claude/strapped-config.json` (self-contained repo — back-compat).
2. shared mode: `<stateRoot>/<r>/strapped-config.json` (colocated default); legacy mode: repo-local `<rAbs>/.claude/strapped-config.json` (already covered by 1).

Every target repo resolves its own config by its own name+root — never "the cwd repo". `/strapped:plan` generates/confirms a config for **each** target repo on first run.

```json
{
  "validations": ["uv run pytest", "uv run ruff check", "uv run ruff format --check", "uv run pyright"],
  "worktreeRoot": "/abs/path/<repo-name>__worktrees",
  "provisioning": "Untracked files worktrees need for validations, with placeholder values — never real secrets."
}
```

A legacy repo-local config additionally carries `stateRoot`; a colocated config does not. The `validations` values above are an example.

### Legacy on-disk back-compat

A run created before this re-spec has a manifest with **no** `repos:` map and deliverables with **no** `repo:` field. All consumers (implement, status, pr) treat such a run as **single-repo** with zero migration:

- When `repos:` is absent, synthesize a one-entry `repos:` map whose sole entry is the (primary) repo derived from the **resolved run root** — in shared mode the `<primaryRepo>` path segment of `<stateRoot>/<primaryRepo>/<slug>/` names the repo, whose root/config resolve via the normal per-repo config resolution above; in legacy mode it is the current repo. Flag it `primary: true`.
- When a deliverable has no `repo:`, default it to that synthesized primary.

This mirrors the in-memory back-compat for the stale single-`repoRoot` workflow arg (D4), extended to the disk format so an in-flight pre-existing run still resumes.

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

## Cleanup recipe

Worktree/branch cleanup runs per deliverable, in that deliverable's repo (`-C <deliverableRepoRoot>`); the run root is removed once for the whole run.

```bash
git -C <deliverableRepoRoot> worktree list
git -C <deliverableRepoRoot> worktree remove <worktreeRoot>/<slug>/<Did>
git -C <deliverableRepoRoot> branch -D strapped/<slug>/<Did>-<kebab>
rm -rf <runRoot>/<slug>
```
