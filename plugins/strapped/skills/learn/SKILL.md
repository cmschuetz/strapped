---
name: learn
description: Synthesize captured user critiques from strapped runs into proposed guidelines, routed by scope to the harness (stage prompts / SKILLs / conventions) or the pertaining repo's CLAUDE.md — presented as a diff for approval, never auto-applied
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---

Turn the user's recurring corrections into durable guidelines. Source format is in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`). The plugin's SessionStart hook auto-injects the conventions as the **strapped preamble** — assume they are in context; if the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/conventions.md` before proceeding.

## Step 1 — Collect

Resolve the run root the SAME way every other strapped skill does — via the canonical resolver, never by hand-rolling the config chain or reading `~/.claude/strapped.json` yourself (a mis-resolved root silently globs to zero and is indistinguishable from "no critiques"):

```bash
node $PLUGIN_ROOT/scripts/state.mjs runroot   # → { "stateRoot": "<abs>", "runRoot": "<abs>/runs" }
```

If that command exits non-zero (unresolvable or non-absolute anchor), **stop and report the resolution error** — do NOT treat it as "no critiques."

Then collect every critique entry with `synthesized: false` across all runs: glob `<runRoot>/*/critiques/user-critiques.md` — every run under the global state root, so critiques from **every** run are collected. The `runs/` tier never touches `repos/` (its sibling dir). State the resolved `runRoot` and how many critique files matched, so a zero is legibly "root X held no unsynthesized critiques" and not a swallowed resolution failure.

If the root resolved cleanly but there are genuinely no unsynthesized entries, say so and stop.

## Step 2 — Cluster and filter

1. Group entries expressing the same underlying rule (across runs).
2. Drop clusters already covered by an existing rule — compare **meaning**, not wording, against wherever a rule of that scope would already live (per Step 3's routing): every applicable `CLAUDE.md`, `$PLUGIN_ROOT/conventions.md`, and the stage prompts under `$PLUGIN_ROOT/../../src/workflows/strapped-run/`. A critique whose lesson is already encoded in a stage prompt is covered even if no `CLAUDE.md` mentions it.
3. Drop entries marked `generalizable: no` or that are plan-specific one-offs; flip those to `synthesized: no` with a short reason appended to the entry.

## Step 3 — Classify scope and route

Critiques captured during runs are usually corrections about **how the harness behaves**, not about how to develop the plugin repo — and a rule only fires where it is actually loaded. Classify each surviving cluster and pick its target file accordingly (a cluster may be **both**, landing in more than one place):

- **harness-behavior** — how the strapped harness itself plans, reviews, implements, creates PRs, or otherwise operates; it must shape FUTURE runs against ANY repo. Route to the harness, most specific first: the exact agent prompt under `src/workflows/strapped-run/stages/*.ts` (or `review-loop.ts`) when the rule governs one agent's behavior; the relevant skill's `SKILL.md` step when it is an orchestrator/interactive concern; `conventions.md` when it is a cross-cutting format/procedure rule seeded to every subagent. Editing any `src/**` stage prompt requires a rebuild (`bun run build`) of the generated `plugins/strapped/workflows/strapped-run.js` and a plugin-version bump (per the repo's own CLAUDE.md).
- **repo-development** — how to develop a specific repo's code (its naming, testing style, build, architecture). Route to **that repo's** `CLAUDE.md`, NOT the plugin's. Determine the pertaining repo from the cluster's source critiques: each lives under `<runRoot>/<slug>/critiques/`, so resolve that run via `node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>` and use its `repos[].root` — the guideline lands in that repo root's `CLAUDE.md`. Only when the pertaining repo genuinely IS the strapped plugin does it land in this repo's `CLAUDE.md`.

Draft one guideline line per cluster in the target file's existing voice (terse imperative, no explanations), and pick the section it belongs in (or a new section only when nothing fits). Prefer editing an existing rule over a near-duplicate.

## Step 4 — Propose (the gate)

Present a **unified diff per target file**, and for each proposed guideline state its scope (harness-behavior/repo-development), its destination file, and the source critiques that motivated it. Ask the user to approve/reject each proposed guideline (AskUserQuestion with one question per guideline when few, or a single multi-select). **Apply nothing without explicit approval.**

## Step 5 — Apply approved changes only

Edit each approved guideline into its routed target file (rebuild + bump the plugin version if any `src/**` stage prompt changed). Flip each consumed entry to `synthesized: true` (rejected clusters: `synthesized: no`). Report what was applied, where each guideline landed, and what was rejected.
