---
name: learn
description: Synthesize captured user critiques from strapped runs into proposed CLAUDE.md guideline additions — presented as a diff for approval, never auto-applied
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---

Turn the user's recurring corrections into durable guidelines. Source format is in `$PLUGIN_ROOT/conventions.md` (resolve `$PLUGIN_ROOT` = `realpath(<base directory for this skill>/../..)`).

## Step 1 — Collect

Resolve the run root `<runRoot>` per the conventions' Config resolution. Glob `<runRoot>/*/critiques/user-critiques.md` and collect every entry with `synthesized: false`. If there are none, say so and stop.

## Step 2 — Cluster and filter

1. Group entries expressing the same underlying rule (across runs).
2. Drop clusters already covered by an existing rule — read every applicable CLAUDE.md first and compare meaning, not wording.
3. Drop entries marked `generalizable: no` or that are plan-specific one-offs; flip those to `synthesized: no` with a short reason appended to the entry.

## Step 3 — Draft

For each surviving cluster, draft one guideline line in the existing CLAUDE.md voice (terse imperative bullets, no explanations) and pick the section it belongs in (or propose a new section only when nothing fits). Prefer editing an existing rule over adding a near-duplicate.

## Step 4 — Propose (the gate)

Present a **unified diff** of the proposed CLAUDE.md changes plus, per hunk, the source critiques that motivated it. Ask the user to approve/reject each proposed guideline (AskUserQuestion with one question per guideline when few, or a single multi-select). **Apply nothing without explicit approval.**

## Step 5 — Apply approved changes only

Edit CLAUDE.md with the approved hunks only. Flip each consumed entry to `synthesized: true` (rejected clusters: `synthesized: no`). Report what was applied and what was rejected.
