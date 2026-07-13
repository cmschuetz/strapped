# Guidelines

- **Always bump the plugin version when building new changes.** Any PR that changes the plugin's behavior (skills, workflows, scripts, hooks, conventions) must bump `version` in `plugins/strapped/.claude-plugin/plugin.json`. `claude plugin update` compares versions only — with an unbumped version, installed copies silently stay pinned to a stale commit even after the change merges.
