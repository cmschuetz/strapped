# Guidelines

Guidelines for developing **this** repo (the strapped plugin), loaded only when working in the strapped repo. Rules for how the *harness itself* should plan/review/implement live in `plugins/strapped/conventions.md` and the stage prompts under `src/workflows/strapped-run/stages/` — those reach every run against any repo, so put harness-behavior guidance there, not here.

- **Always bump the plugin version when building new changes.** Any PR that changes the plugin's behavior (skills, workflows, scripts, hooks, conventions) must bump `version` in `plugins/strapped/.claude-plugin/plugin.json`. `claude plugin update` compares versions only — with an unbumped version, installed copies silently stay pinned to a stale commit even after the change merges.

## Design

- **This is a new repo — breaking changes are fine.** Don't preserve backward compatibility or carry compat weight when it complicates the design.
- **Don't add machinery for cases that carry no actionable signal.** Scope each mechanism to the state it can actually act on.
