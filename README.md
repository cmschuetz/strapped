# strapped

Get strapped in. An agentic coding harness for Claude Code: a big themed `plan.md` goes in; a converged DAG plan, parallel worktree implementation with adversarial rule-partitioned review loops, and stacked GitHub PRs come out. Your corrections get synthesized back into CLAUDE.md guidelines (with your approval).

## Skills

| Invocation | What it does |
|---|---|
| `/strapped:plan <plan.md> [--repo <path-or-name>]... [--seed N] [--max-rounds N]` | Research → DAG of ~500-line deliverables → adversarial plan-review loop (2 reviewers with disjoint CLAUDE.md rule halves + distinct lenses, refute pass, dedup-vs-seen, bounded at 3 rounds) → interactive final review. `--repo` names the target repo(s) the work lands in (repeatable); omit to be prompted. A run may span multiple repos. |
| `/strapped:implement <slug> [--only Did]` | Execute the DAG wave-by-wave: persistent worktree per deliverable, fresh implementer, validations, bounded code-review/fix loop, park-don't-spin |
| `/strapped:pr <slug> [--dry-run] [--update]` | Stacked PRs via git + gh: child PRs based on their parent deliverable's branch, dependency-annotated bodies; `--update` rebases children after parent changes |
| `/strapped:learn` | Cluster your captured critiques into proposed CLAUDE.md additions — shown as a diff, applied only on approval |
| `/strapped:status [<slug>]` | Read-only dashboard: DAG, statuses, worktrees, PRs, parked reasons, next action |

The target repo(s) are chosen explicitly (via `--repo`, or by confirming an inferred set) — never derived from the cwd, which may be a plans repo or anywhere else. A run is anchored to a **primary repo**'s namespace: all its state lives under one run root at `<stateRoot>/<primaryRepo>/<slug>/` with a single manifest, regardless of how many repos the run touches. Each **target repo** gets its own config at `<stateRoot>/<repoName>/strapped-config.json`, so a run spanning e.g. a Python and a Ruby service uses each repo's own validations and worktree root. `stateRoot` comes from `$STRAPPED_STATE_ROOT` or `~/.claude/strapped.json`; a repo can instead keep state in-repo via a local `.claude/strapped-config.json`. Design details: `plugins/strapped/conventions.md`.

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

## PR tracking

Deliverable statuses refresh automatically at session start: a SessionStart hook runs `plugins/strapped/scripts/sync-prs.sh`, which checks every `pr-open` deliverable via `gh`, flips merged ones to `merged`, warns on closed or changes-requested PRs, and notes newly unblocked children. It exits silently in milliseconds when a project has no strapped state or nothing is `pr-open`, and it never fires for subagents. Manual refresh: run the script directly or re-invoke `/strapped:pr <slug>`.

## Per-project setup

None required in any repo itself — `/strapped:plan` generates a config **per target repo** (validation commands, worktree root, worktree provisioning) on first run and asks you to confirm each. The cwd need not be any target repo. By default each config lives with the state at `<stateRoot>/<repoName>/strapped-config.json`; set `stateRoot` once via `~/.claude/strapped.json` (`{"stateRoot": "..."}`) or `$STRAPPED_STATE_ROOT`. Each deliverable carries a `repo:` field naming the target repo it lands in, so its branch, worktree, and validations use that repo's config.
