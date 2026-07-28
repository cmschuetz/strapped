// A fixture implementation plan for the reviewer case, carrying a DELIBERATELY
// SEEDED GAP: the JSON output mode (requirement 3 of the source ask, and AC2
// below) has NO covering test, and the ask's requirement 4 (the "Dry run" docs
// section) is silently dropped — no deliverable produces it. A completeness
// reviewer should surface both as blocking gaps and mark AC2 a violation.
//
// The plan is embedded inline in the reviewer prompt because a single-shot eval
// has no filesystem to read the artifact files from (fidelity note in the D3 plan).

export const SEEDED_GAP_PLAN = `=== manifest.md ===
---
status: in-review
seed: 1
budgets: { plan_rounds: 2, code_rounds: 2, confidence_min: 70 }
repos:
  - name: strapped
    root: /home/user/strapped
    config: plugins/strapped/conventions.md
deliverables:
  - id: D1
    file: deliverables/D1-dry-run-resolver.md
    repo: strapped
    deps: []
---
Theme: add an offline \`--dry-run\` mode to the CLI. One deliverable extracts a
pure DAG resolver and wires the flag.

DAG:
  D1

=== deliverables/D1-dry-run-resolver.md ===
---
id: D1
title: Dry-run resolver + --dry-run flag
deps: []
repo: strapped
status: pending
branch: strapped/eval-fixture/D1-dry-run-resolver
base: main
worktree: null
pr: null
review_rounds_used: 0
feedback_rounds_used: 0
parked_reason: null
estimated_diff_lines: 300
---
## Context
Extract the wave-planning logic from the implement stage into a pure,
side-effect-free resolver, then add a \`--dry-run\` flag that prints the wave plan
without spawning agents or mutating state.

## Files to touch
- src/workflows/strapped-run/resolver.ts — NEW pure resolver.
- src/scripts/run.ts — wire the \`--dry-run\` flag.

## Implementation steps
1. Move the topological wave-planning code into \`resolver.ts\` as a pure function.
2. Add \`--dry-run\` to the run command: resolve, print the wave plan, exit without
   side effects.
3. Add a \`--json\` sub-mode that emits the wave plan as a machine-readable object.

## Acceptance criteria
1. \`--dry-run\` prints the wave plan and performs no state mutation, spawn, or
   worktree creation.
2. \`--dry-run --json\` emits the wave plan as a machine-readable JSON object.

## Tests
- resolver.test.ts — the pure resolver returns the correct topological wave order.
- dry-run.test.ts — \`--dry-run\` performs no state mutation (asserts no files change).

## Out of scope
- Changing the live implement-stage dispatch behavior.`
