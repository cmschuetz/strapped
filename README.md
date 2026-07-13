# strapped

Get strapped in. An agentic coding harness for Claude Code: a big themed `plan.md` goes in; a converged DAG plan, parallel worktree implementation with adversarial rule-partitioned review loops, and stacked GitHub PRs come out. Your corrections get synthesized back into CLAUDE.md guidelines (with your approval).

## Skills

| Invocation | What it does |
|---|---|
| `/strapped:plan <plan.md> [--repo <path-or-name>]... [--seed N] [--max-rounds N]` | Research → DAG of theme-scoped deliverables → adversarial plan-review loop (2 reviewers with disjoint CLAUDE.md rule halves + distinct lenses, refute pass, dedup-vs-seen, bounded at 3 rounds) → interactive final review. `--repo` names the target repo(s) the work lands in (repeatable); omit to be prompted. A run may span multiple repos. |
| `/strapped:implement <slug> [--only Did]` | Execute the DAG wave-by-wave: persistent worktree per deliverable, fresh implementer, validations, bounded code-review/fix loop, park-don't-spin |
| `/strapped:pr <slug> [--dry-run] [--update]` | Stacked PRs via git + gh: child PRs based on their parent deliverable's branch, dependency-annotated bodies; `--update` rebases children after parent changes |
| `/strapped:feedback <slug> [--deliverable Did]... [--pr url]... [--dry-run] [--max-rounds N]` | Turn PR review comments into reviewed, approved fixes: fetch comments across the run's PRs (GitHub via `gh`), synthesize cross-deliverable addenda, run the adversarial plan-review loop, gate on approval, apply fixes on the existing branches, then offer `/strapped:pr <slug> --update` |
| `/strapped:run <chain> <plan.md\|slug> [--yes] [--dry-run]` | Compose strapped skills into one workflow that runs until complete: resolve a built-in (`auto`, `ship`) or config-defined chain of stages, confirm once which interactive gates it skips (`--yes` to skip asking), then dispatch the whole chain as a single autonomous run. `--dry-run` previews everything without writing state. See [Composable chains](#composable-chains) |
| `/strapped:learn` | Cluster your captured critiques into proposed CLAUDE.md additions — shown as a diff, applied only on approval |
| `/strapped:status [<slug>]` | Read-only dashboard: DAG, statuses, worktrees, PRs, parked reasons, next action |

The target repo(s) are chosen explicitly (via `--repo`, or by confirming an inferred set) — never derived from the cwd, which may be a plans repo or anywhere else. A run's state is keyed by the run itself: all of it lives under one run root at `<stateRoot>/runs/<slug>/` with a single manifest, regardless of how many repos the run touches. Runs↔repos is **one-to-many**, and repos have no concept of runs. Each target repo gets its own config in an isolated namespace at `<stateRoot>/repos/<repoName>/config.json` (a sibling of `runs/`), so a run spanning e.g. a Python and a Ruby service uses each repo's own validations and worktree root. `stateRoot` defaults to `~/.claude/strapped` and can be overridden via `$STRAPPED_STATE_ROOT` or `~/.claude/strapped.json` (`{"stateRoot": "<abs path>"}`); it is always a global absolute directory — worked repos carry no strapped files. Design details: `plugins/strapped/conventions.md`.

## Setup (each machine)

```
/plugin marketplace add cmschuetz/strapped
/plugin install strapped@strapped
```

Private repo access uses your existing git/gh credentials. For background auto-update to reach the private repo, export `GITHUB_TOKEN`.

## Getting updates

- Enable auto-update: `/plugin` → Marketplaces tab → strapped → auto-update on (checks at session start).
- Or manually: `/plugin marketplace update strapped`, then `/reload-plugins` if mid-session.

## Iterating (dev machine)

Add the marketplace by local path instead of GitHub so edits are live without pushing:

```
/plugin marketplace add ~/Projects/strapped
/plugin install strapped@strapped
```

Edit, then `/reload-plugins`. Push when happy; other machines pick it up via marketplace update.

**TypeScript sources vs committed deployables.** Development happens in TypeScript under `src/` (bundled) and runs on [bun](https://bun.sh), managed by [asdf](https://asdf-vm.com). One-time toolchain setup in the repo root:

```
asdf install      # materializes the pinned .tool-versions (bun + node)
bun install       # dev dependencies (typescript, @types/bun); runtime deps stay zero
```

The files the plugin actually ships — e.g. `plugins/strapped/scripts/resolve-chain.mjs` and `plugins/strapped/workflows/strapped-run.js` — are **generated, committed artifacts**: plain node-runnable ESM with zero runtime dependencies, at the exact paths skills and conventions reference (marketplace installs run node, never bun). The full pipeline is:

```
# edit src/ …
bun run typecheck   # tsc --noEmit, strict mode over src/, tools/, tests/
bun run build       # regenerate the committed deployables from src/
bun test            # behavioral suite (or `npm test` for every gate — see Testing)
git commit          # commit the regenerated artifacts ALONGSIDE the sources
```

Never hand-edit a file with a `// GENERATED` header. Two guard tests keep source and deployables honest: `tests/build-sync.test.ts` runs `bun tools/build.ts --check` and fails whenever a committed artifact is stale or hand-edited, and `tests/no-stray-js.test.ts` fails if any tracked `.js`/`.mjs`/`.cjs` is not one of those four marker-carrying deployables — so the only JavaScript in the repo is, and stays, the generated output (everything else is TypeScript or bash).

## Testing

```
npm test
```

Requires the asdf-pinned toolchain (`asdf install`, then `bun install`). `npm test` is the canonical entry point kept as a working alias for CI/validation compatibility — npm just runs the script, and bun is on `PATH` via asdf; `bun run test` is equivalent. Runtime dependencies remain zero — `typescript` and `@types/bun` are dev-only. The suite chains four gates:

1. `claude plugin validate . --strict` — marketplace manifest (warnings are errors),
2. `claude plugin validate plugins/strapped --strict` — plugin manifest, skills, hooks,
3. `bun run typecheck` (`tsc --noEmit`) — strict-mode TypeScript over `src/`, `tools/`, and all of `tests/` (the entire suite is TypeScript),
4. `bun test` — behavioral tests: each workflow in `plugins/strapped/workflows/` runs unmodified through a tiny eval harness (`tests/helpers/workflow-harness.ts`) with recording `agent`/`workflow` stubs, `scripts/sync-prs.sh` runs for real against a temp state root with a stub `gh` and an isolated `HOME`, `tests/build-sync.test.ts` verifies the committed generated artifacts are byte-identical to a fresh `bun run build`, and `tests/no-stray-js.test.ts` enforces both the deployables-only JS rule and a zero-`any`/no-suppression scan across every `.ts` source. Tests spawn the deployables under `node` (deploy parity — under `bun test`, `process.execPath` is bun).

For interactive testing, load the plugin straight from your checkout: `claude --plugin-dir ~/Projects/strapped/plugins/strapped` (then `/reload-plugins` after edits).

## Session preamble

The strapped operating context loads itself: a SessionStart hook runs `plugins/strapped/scripts/preamble.sh`, which injects the full `plugins/strapped/conventions.md` plus a live state summary (every run under `<stateRoot>/runs/` with its manifest status and per-status deliverable counts) into the orchestrator's context. The injection's first line carries the sentinel `strapped-preamble-v1`. It fires on `startup`, `clear`, and `compact` — deliberately NOT on `resume`, because a resumed session's transcript already contains the earlier injection (clear/compact evict it, so those re-inject) — and never fires for subagents (workflows seed subagents with the conventions file explicitly). Skills assume the preamble is present and fall back to reading `conventions.md` themselves only when the sentinel is missing from context.

## PR tracking

Deliverable statuses refresh automatically at session start: a SessionStart hook runs `plugins/strapped/scripts/sync-prs.sh`, which checks every `pr-open` deliverable via `gh`, flips merged ones to `merged`, warns on closed or changes-requested PRs, and notes newly unblocked children. It exits silently in milliseconds when a project has no strapped state or nothing is `pr-open`, and it never fires for subagents. Manual refresh: run the script directly or re-invoke `/strapped:pr <slug>`.

## Feedback loop

When reviewers request changes on a run's stacked PRs, `/strapped:feedback <slug>` closes the loop back into planning. It fetches every in-scope PR's review comments via `gh` — line-anchored comments, review-submission bodies (including `CHANGES_REQUESTED` summaries), and global comments — synthesizes them into ONE consolidated **cross-deliverable** plan (a comment left on one PR can land a fix on a different deliverable), attaches each fix as a `## Feedback addendum` on the existing deliverable file, then runs the addenda through the SAME adversarial plan-review loop the original plan used before gating on your explicit approval. Approved fixes apply on each deliverable's EXISTING branch/worktree in stack order (no new branches, no force-push, no merge), and the run ends by offering `/strapped:pr <slug> --update` once to rebase the stack. Feedback rounds record separately (`feedback-round-<N>.md`, `feedback_rounds_used`) so the original run's audit stays intact.

## Composable chains

`/strapped:run <chain>` composes the plan → implement → pr stages into ONE workflow that runs until complete. Two chains are built in — `auto` (plan, implement, pr) and `ship` (implement, pr) — and you can define your own in `~/.claude/strapped.json`, the same anchor file that holds `stateRoot` (the anchor is the only place chains live):

```json
{
  "stateRoot": "/abs/path",
  "chains": {
    "automode": ["plan", "implement", "pr"]
  }
}
```

A chain is a non-empty ordered subset of `plan`, `implement`, `pr` in that order; a config chain named like a built-in overrides it. `feedback`, `learn`, and `status` are excluded — they exist to put a human in the loop, which is exactly what a chain removes.

**Full-auto is risky.** A chain substitutes the interactive gates: a converged plan is auto-approved without your final review, and PRs open without a human look at the diffs. That can work when you aren't available — but be sure it's what you want. `/strapped:run` discloses the skipped gates and asks once up front (skip with `--yes`), and `--dry-run` previews the resolved chain, would-be paths, and dispatch args without writing anything. Non-convergence, parked deliverables, or a failed gate stop the chain with a precise report and the resume command — it never proceeds silently.

**Autocomplete wrappers (best-effort).** `node plugins/strapped/scripts/sync-chain-skills.mjs` generates a thin personal skill per chain at `~/.claude/skills/strapped-run-<chain>/`, so e.g. `/strapped-run-automode` autocompletes; each wrapper only delegates to `/strapped:run <chain>`. Wrappers are marked `generated_by: strapped`, re-syncing is idempotent, wrappers for removed chains are pruned, and unmarked skills are never touched. `/strapped:run` offers the sync after a run when you have config-defined chains.

## Per-project setup

None required in any repo itself — no strapped file ever lands in a worked repo. `/strapped:plan` generates a config **per target repo** (validation commands, worktree root, worktree provisioning) on first run and asks you to confirm each. The cwd need not be any target repo. Each config lives in its isolated namespace at `<stateRoot>/repos/<repoName>/config.json`. `stateRoot` defaults to `~/.claude/strapped` (a sibling of Claude Code's own `~/.claude/plans/`) and works with zero setup; to relocate it, write `~/.claude/strapped.json` (`{"stateRoot": "<abs path>"}`) once or export `$STRAPPED_STATE_ROOT`. Each deliverable carries a `repo:` field naming the target repo it lands in, so its branch, worktree, and validations use that repo's config.
