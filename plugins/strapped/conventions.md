# Harness conventions

Shared reference for the `strapped` skill suite. Every skill and workflow script defers to this file for state layout, formats, naming, budgets, and procedures. All state is designed so any skill can cold-start from disk alone after a full context clear.

## Directory layout

All state for one strapped run lives in the consuming project under `<stateRoot>/<slug>/`, where `stateRoot` comes from the project config (default `plans/strapped`; commit or gitignore per that project's preference):

```
<stateRoot>/<slug>/
  manifest.md                    # DAG structure + plan-level status
  research.md                    # distilled research digest (~300 line cap)
  deliverables/D1-<kebab>.md     # one self-contained plan per DAG node
  reviews/rules-snapshot.md      # numbered rules + sources + per-round assignments
  reviews/plan-round-<N>.md      # plan review round records (the "seen" set)
  reviews/<Did>-code-round-<N>.md
  critiques/user-critiques.md    # append-only log feeding /strapped:learn
```

`<slug>` is derived from the source plan filename: `plans/foo_bar.md` → `foo-bar` (lowercase kebab-case).

## manifest.md

DAG *structure* and plan-level status only. Per-deliverable status lives solely in the deliverable file — never duplicate it here.

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
deliverables:
  - { id: D1, file: deliverables/D1-foo.md, deps: [] }
  - { id: D2, file: deliverables/D2-bar.md, deps: [D1] }
---
# <Theme title>

One-paragraph theme summary. ASCII DAG sketch. Link to research.md.
```

## deliverables/D#-<kebab>.md

The single channel from planning to implementation. A fresh implementer seeded with only this file (plus `research.md`) must be able to do the work. Target ~500 lines of complex diff per deliverable.

```markdown
---
id: D2
title: <title>
deps: [D1]
status: pending | ready | in-progress | implemented | in-review | fixing | done | parked | pr-open | merged
branch: strapped/<slug>/D2-<kebab>
base: strapped/<slug>/D1-<kebab>          # or main for roots
worktree: /abs/path | null                # resumability marker
pr: null | <url>
review_rounds_used: 0
parked_reason: null
estimated_diff_lines: 450
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

- Plan review — **A: completeness** (every element of the ask covered? missing requirements, edge cases, test-per-AC gaps). **B: soundness** (wrong assumptions, DAG dependency errors, deliverables over the ~500-line complexity target, undeclared cross-deliverable dependencies).
- Code review — **A: correctness** (logic bugs, edge cases, race conditions, error paths, AC compliance). **B: convention & test fidelity** (guideline adherence, test quality: integration-style, no mocking, aiohttp test servers, polyfactory).

## Critique loop shape (both loops)

1. **Find** — 2 reviewers in parallel, fresh contexts, each with its rule half + lens + the seen digest ("known/addressed — do not re-report unless regressed").
2. **Refute** — for every `blocking`/`concern` finding, a fresh refuter (never the finder), stance: "NOT a real issue unless the artifact proves otherwise". Drop `refuted` and anything below `confidence_min` (70). `suggestion` findings skip refute and never drive the loop — recorded for the human only.
3. **Dedup-vs-seen** — merge same-root-cause findings by `key` against all prior rounds; only truly-NEW confirmed findings count.
4. **Act** — plan loop: reviser edits plan files. Code loop: fixer (same worktree) fixes, re-runs all validations, commits.
5. **Terminate** — zero NEW confirmed findings → converged. Else next round until the budget (3), then **park with `parked_reason`** — never proceed silently, never spin.

Verdict order per deliverable, first match wins: `parked` (budget exhausted with open blocking findings) > `fixing` (new confirmed findings this round) > `done` (converged + validations green).

## Project config

Each consuming project carries `.claude/strapped-config.json`, generated by `/strapped:plan` on first run and confirmed by the user:

```json
{
  "stateRoot": "plans/strapped",
  "validations": ["uv run pytest", "uv run ruff check", "uv run ruff format --check", "uv run pyright"],
  "worktreeRoot": "/abs/path/<repo-name>__worktrees",
  "provisioning": "Untracked files worktrees need for validations, with placeholder values — never real secrets."
}
```

`stateRoot` is repo-relative and defaults to `plans/strapped` when absent.

(The values above are the gerald project's, shown as an example.)

## Validations

Every command in the config's `validations` must be green before code review and after every fix round, run inside the deliverable's worktree.

## Worktrees and branches

- Branch: `strapped/<slug>/<Did>-<kebab>`; base = parent deliverable's branch (roots: `main`).
- Worktree: `<worktreeRoot>/<slug>/<Did>` (from the config; default `<repo-parent>/<repo-name>__worktrees`) — persistent, outside the repo tree. Created explicitly:

```bash
git worktree add <worktreeRoot>/<slug>/<Did> -b strapped/<slug>/<Did>-<kebab> <base>
```

- Idempotent on resume: if the worktree path exists and its branch matches the frontmatter, reuse it.
- Provisioning: apply the config's `provisioning` instructions to every fresh worktree (e.g. a placeholder `.env`) — never copy real secrets into a worktree.
- **Freeze rule**: once any child has branched off a deliverable's branch, that branch changes only via `/strapped:pr --update`, which rebases each child: `git rebase --onto <new-parent-tip> <old-parent-tip> <child-branch>` then `git push --force-with-lease`.

## Stacked PRs

Topological order over `done` deliverables. Per node: `git push -u origin <branch>`, then `gh pr create --head <branch> --base <parent-branch|main>`. PR body: summary + ACs + a `Stack:` table of the whole DAG with PR links + `Depends on #<parent-PR>` for non-roots. Record the URL in frontmatter, set status `pr-open`. `--dry-run` prints every git/gh command and PR body without pushing anything.

## Cleanup recipe

```bash
git worktree list
git worktree remove <worktreeRoot>/<slug>/<Did>
git branch -D strapped/<slug>/<Did>-<kebab>
rm -rf <stateRoot>/<slug>
```
