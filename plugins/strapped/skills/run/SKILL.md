---
name: run
description: Compose strapped skills into one workflow that runs until complete — resolve a built-in or config-defined chain of stages (plan, implement, pr), disclose the interactive gates it skips, then dispatch the whole chain as a single autonomous mono-workflow run
---

Run a whole chain of strapped stages — e.g. plan → implement → pr — as ONE autonomous dispatch that runs until complete (or stops loudly at the first failed gate).

**Plugin root**: resolve `realpath(<base directory for this skill>/../..)` once at the start — call it `$PLUGIN_ROOT`. All formats, budgets, and procedures are defined in `$PLUGIN_ROOT/conventions.md`. Your always-injected operating model is the slim `context.md` preamble (sentinel `strapped-preamble-v1`); do not front-load research or re-read the whole conventions on invocation — the procedure below is self-sufficient; pull the specific `conventions.md` section only at the step that needs the exact format. If the sentinel `strapped-preamble-v1` is NOT in your context, read `$PLUGIN_ROOT/context.md` to re-establish the operating model. The **Composable chains** section (stage table, args shape, gate semantics, chain configs, wrapper sync) is this skill's contract.

## Arguments

`$ARGUMENTS`: `<chain> <plan.md-path | slug> [--repo <path-or-name>]... [--seed N] [--plan-rounds N] [--code-rounds N] [--research-rounds N] [--dry-run] [--yes]`

- `<chain>` — a chain name: a built-in (`auto` = plan, implement, pr; `ship` = implement, pr) or one from the `chains` map of `~/.claude/strapped.json`. Always resolved via the harness script in Step 0 — never hand-rolled.
- second argument — when the resolved chain **starts with `plan`**, the path to the source plan.md; otherwise the **slug** of an existing run.
- `--repo <path-or-name>` — repeatable; plan-entry only; same semantics as `/strapped:plan` (never derived from cwd).
- `--seed N`, `--plan-rounds N`, `--code-rounds N`, `--research-rounds N` — valid ONLY on a FRESH plan-entry run (Step 1's resume probe found no existing `manifest.md`). Defaults on a fresh run: the seed is generated truly randomly once (e.g. `python3 -c 'import random; print(random.randrange(2**32))'`) when `--seed` is omitted, both review-round budgets default to 1 — `0` is legal for either and skips that review loop entirely — and the research budget defaults to 2 (`--research-rounds 1` disables research delegation entirely; min 1). They set the values threaded into the stage args; the plan stage records the effective `seed`, `plan_rounds`, `code_rounds`, and `research_rounds` in the manifest, so nothing needs patching skill-side and later stages/resumes read the manifest values. On the slug path — and on a plan-entry invocation whose resume probe finds an existing `manifest.md` at ANY status — seed and every budget come from the EXISTING manifest: if any of these flags was passed, stop with a message saying the existing manifest's values are authoritative. (The standalone skills' single `--max-rounds` flag is ambiguous across a chain that spans both review loops, so this skill splits it: `--plan-rounds` overrides the `plan_rounds` budget, `--code-rounds` overrides `code_rounds`; `--research-rounds` overrides `research_rounds` symmetrically.)
- `--dry-run` — print-only preview, evaluated in Step 0 BEFORE any prep; mutates nothing.
- `--yes` — skip the Step 2 consent gate.

## Step 0 — Resolve the chain (and honor `--dry-run`)

Resolve the chain via the harness script (contract in the conventions' **Harness scripts** and **Chain configs** sections):

```bash
node $PLUGIN_ROOT/scripts/resolve-chain.mjs <chain>
```

It prints `{ name, stages, source: "builtin" | "anchor" }`. On a non-zero exit (unknown chain, invalid config chain), relay its stderr message plus the output of `node $PLUGIN_ROOT/scripts/resolve-chain.mjs --list` (the available chains) to the user and STOP. Chains resolve globally from the built-ins overlaid by `~/.claude/strapped.json`'s `chains` map — never from a repo-local config, never from the cwd.

**`--dry-run` is evaluated HERE, before Step 1 runs** — Step 1's prep writes state (scaffold, per-repo configs, rules snapshot), so a post-prep check could not honor a mutate-nothing promise. With `--dry-run`, perform Step 1's resolution strictly READ-ONLY:

- derive the slug (plan entry) or take it verbatim (slug entry), resolve the run root per the conventions, and probe `<runRoot>/<slug>/manifest.md`;
- plan entry: list the target-repo candidates (from `--repo`, or inferred from the plan text) WITHOUT any AskUserQuestion confirmation;
- NOTE — never perform — each write Step 1 would do: the `<runRoot>/<slug>/` scaffold, per-repo config generation for any repo whose config is missing, and the `reviews/rules-snapshot.md` write. This includes the slug path's re-extract-if-missing fallback: when the snapshot is missing, REPORT it as missing instead of writing it.

Then print: the resolved chain (name, stages, source), the entry path, every would-be-created path, and the full args JSON Step 3 would dispatch to `strapped-run.js` — fields that depend on not-yet-performed writes shown as placeholders (e.g. `rulesByRound: "<id splits computed from the unwritten reviews/rules-snapshot.md>"`, `rulesFile: "<the unwritten reviews/rules-snapshot.md's absolute path>"`). Then STOP.

`--dry-run` mutates NOTHING: no scaffold, no config write, no snapshot write, no manifest/deliverable/branch mutation, and no workflow dispatch — the same promise `/strapped:pr --dry-run` makes.

## Step 1 — Prep (per entry shape)

### Chain starts with `plan` — the second argument is a source plan.md

Perform the plan skill's Steps 1–2 exactly (`$PLUGIN_ROOT/skills/plan/SKILL.md` is the model — follow its 1a–1e and Step 2), with one chain-specific override of its resume rule (below):

1. Derive the slug from the plan filename (`plans/foo_bar.md` → `foo-bar`).
2. Resolve the target repos from `--repo`, or infer candidates from the plan text and confirm via AskUserQuestion — this confirmation (plus Step 2's consent gate) is the ONLY interaction before the autonomous stretch. Never from the cwd.
3. Resolve stateRoot and the run root per the conventions' **Config resolution**, and run the **unconditional resume probe** on `<runRoot>/<slug>/manifest.md` exactly as the plan skill's 1c specifies — on every path, including `--repo` given.
4. Generate/confirm missing per-repo configs (plan skill 1d); scaffold `<runRoot>/<slug>/` (fresh runs only); extract the guideline rules and write `reviews/rules-snapshot.md` per the conventions' **Rule extraction**.
5. Compute `rulesByRound` (id-only `{"a": [...], "b": [...]}` pairs — rule text stays in the snapshot, which the workflow's review agents Read via `rulesFile`) with the conventions' **Seeded rule split** recipe for **`max(plan_rounds, code_rounds)` rounds — NOT the plan skill's `1..plan_rounds` default**: Step 3 threads this ONE array into both the plan and implement stage args, and the implement stage indexes it up to `code_rounds`, so a plan-length array under-runs the implement stage whenever `code_rounds > plan_rounds`.

**Chain-specific resume rule (overrides the plan skill's 1c/1e stop-on-approved):**

- ANY probe hit — an existing `manifest.md` at ANY status — rejects `--seed`/`--plan-rounds`/`--code-rounds`/`--research-rounds` per the flag semantics above: the existing manifest's seed and budgets are authoritative; read them from it.
- Probe hit at `approved`/`implementing` (or later): do NOT stop, and do NOT dispatch the plan stage. **Drop `plan` from the dispatched `stages`** and continue from the next stage exactly as the slug path below would (same manifest-status preconditions, same `reviews/rules-snapshot.md` read with the re-extract fallback); report to the user that the plan stage was skipped because the run is already approved. The plan stage must NEVER run against an approved-or-later manifest — its planner unconditionally rewrites `manifest.md` and every `deliverables/*.md` to `status: pending`, clobbering in-flight/done/pr-open state.
- Probe hit at `draft`/`in-review`: the planner re-run IS the intended resume (matching the manual plan skill) — proceed with the plan stage, taking the repos from the manifest's `repos:` map per the plan skill's 1e, with no re-inference, no re-prompt, and no re-scaffold.

### Chain starts at `implement` or `pr` — the second argument is a slug

1. Run `node $PLUGIN_ROOT/scripts/state.mjs resolve <slug>` (cwd-independent, never hand-rolled). If `exists` is `false`, stop with a helpful message pointing at `/strapped:plan`.
2. Preconditions on the manifest status: the chain starts at `implement` → require `approved` or `implementing`; the chain starts at `pr` → require `done` nodes present (via `node $PLUGIN_ROOT/scripts/state.mjs dag <runDir>`). Otherwise stop and say why.
3. Reject `--seed`/`--plan-rounds`/`--code-rounds`/`--research-rounds` (see Arguments) — seed and every budget come from the existing manifest (`resolve`'s `seed`/`budgets`).
4. Read `reviews/rules-snapshot.md` for the rule set. If it is missing, re-extract it per the conventions' **Rule extraction** and write the snapshot — the same fallback as the implement skill's Step 2; never improvise rule ids.
5. Compute `rulesByRound` from the snapshot's rule ids with the seeded recipe (id-only pairs) for **`max(plan_rounds, code_rounds)` rounds** — mirroring the implement skill's Step 2, extended to cover both loops.

## Step 2 — Consent gate

Unless `--yes` was passed: ask ONE AskUserQuestion stating exactly which interactive gates THIS chain skips, then whether to proceed:

- the chain contains `plan` followed by a later stage → the plan skill's interactive final review is SKIPPED: a converged plan is auto-approved (`manifest-status approved`) by the workflow without your walkthrough;
- the chain contains `implement` followed by `pr` → the implement→pr hand-off is automatic: PRs are pushed and opened without a human look at the diffs.

List only the skips that apply to the dispatched stages. If the user declines, stop cleanly (nothing has been dispatched). (`--dry-run` never reaches this step — it stopped in Step 0.)

## Step 3 — Dispatch the mono-workflow ONCE

Invoke the Workflow tool EXACTLY ONCE with `scriptPath: $PLUGIN_ROOT/workflows/strapped-run.js` (scriptPath, not name: name resolution can serve a stale registration) and args per the conventions' **Composable chains** contract — all paths absolute:

```json
{
  "slug": "<slug>",
  "dir": "<runRoot>/<slug>",
  "stages": ["<the resolved chain's stages — minus plan when the resume rule dropped it>"],
  "stageArgs": {
    "plan": {
      "sourcePlan": "<abs path to the source plan.md>",
      "repos": [{ "name": "<repo>", "root": "<abs root>", "config": "<abs config path>", "validations": ["<from that repo's config>"] }]
    },
    "implement": { "only": null },
    "pr": { "dryRun": false }
  },
  "scripts": { "state": "$PLUGIN_ROOT/scripts/state.mjs", "worktree": "$PLUGIN_ROOT/scripts/ensure-worktree.sh" },
  "conventionsFile": "$PLUGIN_ROOT/conventions.md",
  "seed": "<effective seed>",
  "confidenceMin": 70,
  "planRounds": "<effective plan_rounds>",
  "codeRounds": "<effective code_rounds>",
  "researchRounds": "<effective research_rounds>",
  "rulesFile": "<runRoot>/<slug>/reviews/rules-snapshot.md",
  "rulesByRound": ["<the max(plan_rounds, code_rounds) id-only per-round splits from Step 1>"]
}
```

Include a `stageArgs.plan` entry only when the `plan` stage is actually dispatched. `rulesByRound` (ids only) and `rulesFile` thread ONCE and serve BOTH the plan and implement stages. The workflow owns every gate in between: auto-approve after a converged plan (chained dispatch only), the `implementing` manifest flip, the park-don't-spin wave loop, and the done-or-later pr gate.

## Step 4 — Report

The workflow returns `{ slug, stages, completed, stoppedAt, results }`. The effective seed and budgets were recorded in the manifest by the plan stage — nothing to patch skill-side. Report:

- the stages completed, and — when the chain stopped early — `stoppedAt` plus why:
  - `plan` gate failed: the `outstanding` findings with the `reviews/plan-round-<N>.md` files as reference; next command: `/strapped:plan <plan.md>` to work them interactively;
  - `implement` gate failed: parked nodes with their `parkedReason` and the resume command `/strapped:implement <slug> --only <Did>`, plus the `blocked` children;
  - `pr`: created PR URLs, and report-and-skipped nodes with their `reason`.
- the next command for wherever the chain stopped, or `/strapped:status <slug>` when it ran to completion.

Append every generalizable user correction given here to `critiques/user-critiques.md` per the conventions format (`synthesized: false`).
