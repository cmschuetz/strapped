# strapped

Get strapped in. An agentic coding harness for Claude Code: a big themed `plan.md` goes in; a converged DAG plan, parallel worktree implementation with adversarial rule-partitioned review loops, and stacked GitHub PRs come out. Your corrections get synthesized back into CLAUDE.md guidelines (with your approval).

## Skills

| Invocation | What it does |
|---|---|
| `/strapped:plan <plan.md> [--seed N] [--max-rounds N]` | Research → DAG of ~500-line deliverables → adversarial plan-review loop (2 reviewers with disjoint CLAUDE.md rule halves + distinct lenses, refute pass, dedup-vs-seen, bounded at 3 rounds) → interactive final review |
| `/strapped:implement <slug> [--only Did]` | Execute the DAG wave-by-wave: persistent worktree per deliverable, fresh implementer, validations, bounded code-review/fix loop, park-don't-spin |
| `/strapped:pr <slug> [--dry-run] [--update]` | Stacked PRs via git + gh: child PRs based on their parent deliverable's branch, dependency-annotated bodies; `--update` rebases children after parent changes |
| `/strapped:learn` | Cluster your captured critiques into proposed CLAUDE.md additions — shown as a diff, applied only on approval |
| `/strapped:status [<slug>]` | Read-only dashboard: DAG, statuses, worktrees, PRs, parked reasons, next action |

All run state lives in the consuming project (`plans/strapped/<slug>/`, `.claude/strapped-config.json`), never in the plugin. Design details: `plugins/strapped/conventions.md`.

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

## Per-project setup

None required — `/strapped:plan` generates `.claude/strapped-config.json` (validation commands, worktree root, worktree provisioning) on first run and asks you to confirm it.
