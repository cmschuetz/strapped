# Strapped operating context

Injected at every session start by `scripts/preamble.sh` as the `strapped-preamble-v1`
preamble. This is the always-on operating model — enough to know what strapped is,
which skill to run, and where the deep detail lives. It is deliberately slim: the exact
formats, budgets, and procedures live in `conventions.md` and are read on demand, never
front-loaded.

## What strapped is

An adversarial **plan → implement → stacked-PR** coding harness. A run is planned (with
adversarial plan review), implemented wave-by-wave across a DAG of deliverables in
persistent worktrees, and shipped as a stack of dependency-ordered PRs. A CLAUDE.md
learning loop and a PR-feedback loop close back into planning.

## The skills — run one when

- **/strapped:plan** — turn a large ask into a converged DAG plan (recursive
  multi-source research fan-out + adversarial plan-review loop + interactive
  final review). Use to start a run.
- **/strapped:implement** — execute an approved DAG wave-by-wave: a persistent worktree
  per deliverable, a fresh implementer, validations, a bounded code-review/fix loop.
- **/strapped:pr** — create/update the stacked GitHub PRs for a run's `done`
  deliverables, each child based on its parent's branch.
- **/strapped:feedback** — heavyweight PR-feedback cycle: synthesize review comments into
  cross-deliverable addenda, run the adversarial plan-review loop, gate on approval, then
  apply fixes on the existing branches. For larger re-works.
- **/strapped:feedback-lite** — the default "chisel" polish: synthesize comments
  off-context, plan the refactor in native plan mode, implement in the standard loop on
  the existing branches. For quick, user-observed refinement.
- **/strapped:run** — compose plan → implement → pr into one autonomous chain that runs
  until complete (it substitutes the interactive gates and discloses which).
- **/strapped:learn** — synthesize captured user critiques into proposed CLAUDE.md
  guideline additions, presented as a diff for approval.
- **/strapped:status** — read-only dashboard of runs: DAG, per-deliverable statuses,
  worktrees, branches, PRs, parked reasons, and the next runnable action.

## Core mental model

- **State is keyed by slug**, on disk at `<stateRoot>/runs/<slug>/`. Every skill
  cold-starts from that directory alone after any context clear — no session memory.
- Under `stateRoot` live exactly two sibling namespaces: **`runs/`** (run state, keyed by
  slug) and **`repos/`** (per-repo config, keyed by repo name). No run state under
  `repos/`, no config under `runs/`.
- A run's deliverables form a **DAG**; each has its own self-contained plan file and
  targets one repo. One run = one run root = one `manifest.md`, however many repos it
  spans.
- `stateRoot` is resolved by the conventions' **Config resolution** algorithm (anchor
  file `~/.claude/strapped.json`), never derived from the cwd.

## Disclosure map — read on demand, do not front-load

Exact formats, budgets, naming, and step procedures live in **`conventions.md`** (same
directory as this file, `$PLUGIN_ROOT/conventions.md`). You do NOT need it loaded to be
competent — each skill's own steps are self-sufficient and point you at the one section
they need, when they need it. Pull that section then, not on invocation. The sections
that exist as levers:

Repos · Directory layout · manifest.md · deliverables · Review round records · critiques
· Rule extraction · Seeded rule split · Reviewer lenses · Critique loop · Config
resolution · Harness scripts · Composable chains · Validations · Worktrees and branches ·
PR titles and bodies · Stacked PRs · Feedback index · Feedback loop · Feedback-lite loop ·
Cleanup recipe.

The live **state summary** below lists every run currently on disk.
