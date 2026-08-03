// Seeded run state for the stage-scoped scenarios: an APPROVED manifest plus
// one pending, fully self-contained deliverable (and a research.md stub) so
// the implement stage can run alone, with no plan stage before it. The
// manifests' `repos:` maps use the sandbox BUILD-time tokens
// `{{repoRoot:<name>}}` / `{{configPath:<name>}}` — a seeded manifest must
// carry the sandbox repo's ABSOLUTE root/config paths, which only exist after
// mkdtemp, so a static literal cannot express them; `buildSandbox`
// interpolates them during materialization.

/** File map (runDir-relative) seeding one approved single-deliverable run. */
export interface SeedRunState {
  files: Record<string, string>
}

function manifest(slug: string, seed: number, codeRounds: number, deliverableFile: string): string {
  return `---
slug: ${slug}
source_plan: plans/${slug}.md
created: 2026-07-29
status: approved
seed: ${seed}
budgets:
  plan_rounds: 1
  code_rounds: ${codeRounds}
  confidence_min: 70
repos:
  - { name: calc, root: {{repoRoot:calc}}, config: {{configPath:calc}} }
deliverables:
  - { id: D1, file: ${deliverableFile}, deps: [] }
---
# ${slug}

One tiny deliverable over the calc fixture repo. DAG: D1 (no deps).
`
}

const IMPLEMENT_ONLY_DELIVERABLE = `---
id: D1
title: Add a subtract function to the calc fixture
deps: []
repo: calc
status: pending
branch: strapped/implement-only/D1-subtract
base: main
worktree: null
pr: null
review_rounds_used: 0
feedback_rounds_used: 0
parked_reason: null
estimated_diff_lines: 10
---
## Context
The calc fixture is a tiny bun project: src/calc.ts exports \`add\`, covered by
tests/calc.test.ts (\`bun test\`). The repo CLAUDE.md rules apply: no code
comments, explicit return types on exports, every export tested.

## Files to touch
- src/calc.ts — add the subtract function
- tests/calc.test.ts — add its covering test

## Implementation steps
1. Export \`subtract(a: number, b: number): number\` returning \`a - b\` from src/calc.ts.
2. Add a test asserting \`subtract(5, 3)\` returns 2.

## Acceptance criteria
- AC1: the exported \`subtract(5, 3)\` returns 2.
- AC2: \`bun test\` passes in the worktree.

## Tests
- tests/calc.test.ts — "subtract subtracts" covering AC1/AC2.

## Out of scope
- Anything beyond the subtract function and its test.
`

const REVIEW_LOOP_DELIVERABLE = `---
id: D1
title: Fix the three seeded calculator defects
deps: []
repo: calc
status: pending
branch: strapped/review-loop/D1-fix-defects
base: main
worktree: null
pr: null
review_rounds_used: 0
feedback_rounds_used: 0
parked_reason: null
estimated_diff_lines: 12
---
## Context
src/calc.ts carries three real defects, each exposed by an existing failing
test in tests/calc.test.ts: \`add\` subtracts, \`max\` returns the smaller
argument, and \`isEven\` is inverted. The repo CLAUDE.md explicitly PERMITS the
style quirks in src/quirks.ts and src/todo-notes.ts — they are not defects and
must not be touched.

## Files to touch
- src/calc.ts — fix the three defective lines (nothing else)

## Implementation steps
1. Make \`add\` return \`a + b\`.
2. Make \`max\` return the larger argument.
3. Make \`isEven\` return \`n % 2 === 0\`.

## Acceptance criteria
- AC1: every test in tests/calc.test.ts passes (\`bun test\` green).
- AC2: src/quirks.ts and src/todo-notes.ts are byte-identical to main.
- AC3: the diff stays minimal — only the defective lines change.

## Tests
- tests/calc.test.ts — the existing defect-exposing tests cover AC1.

## Out of scope
- Style cleanup of any kind — the quirk files are intentional and permitted.
`

const ZERO_ROUNDS_DELIVERABLE = `---
id: D1
title: Add a subtract function to the calc fixture
deps: []
repo: calc
status: pending
branch: strapped/zero-rounds/D1-subtract
base: main
worktree: null
pr: null
review_rounds_used: 0
feedback_rounds_used: 0
parked_reason: null
estimated_diff_lines: 10
---
## Context
The calc fixture is a tiny bun project: src/calc.ts exports \`add\`, covered by
tests/calc.test.ts (\`bun test\`). The repo CLAUDE.md rules apply: no code
comments, explicit return types on exports, every export tested.

## Files to touch
- src/calc.ts — add the subtract function
- tests/calc.test.ts — add its covering test

## Implementation steps
1. Export \`subtract(a: number, b: number): number\` returning \`a - b\` from src/calc.ts.
2. Add a test asserting \`subtract(5, 3)\` returns 2.

## Acceptance criteria
- AC1: the exported \`subtract(5, 3)\` returns 2.
- AC2: \`bun test\` passes in the worktree.

## Tests
- tests/calc.test.ts — "subtract subtracts" covering AC1/AC2.

## Out of scope
- Anything beyond the subtract function and its test.
`

function research(slug: string, focus: string): string {
  return `# Research digest — ${slug}

The calc fixture is a tiny bun project; validations are \`bun test\`. ${focus}
`
}

/** Approved manifest + pending D1 (+ research stub) for the implement-only scenario. */
export function implementOnlySeed(): SeedRunState {
  return {
    files: {
      'manifest.md': manifest('implement-only', 13, 1, 'deliverables/D1-subtract.md'),
      'deliverables/D1-subtract.md': IMPLEMENT_ONLY_DELIVERABLE,
      'research.md': research('implement-only', 'The only work is D1: add a subtract function plus its test.'),
    },
  }
}

/** Approved manifest + pending D1 (+ research stub) for the zero-rounds scenario (code_rounds 0). */
export function zeroRoundsSeed(): SeedRunState {
  return {
    files: {
      'manifest.md': manifest('zero-rounds', 15, 0, 'deliverables/D1-subtract.md'),
      'deliverables/D1-subtract.md': ZERO_ROUNDS_DELIVERABLE,
      'research.md': research('zero-rounds', 'The only work is D1: add a subtract function plus its test. The review budget is 0 — no adversarial review runs.'),
    },
  }
}

/** Approved manifest + pending D1 (+ research stub) for the review-loop scenario. */
export function reviewLoopSeed(): SeedRunState {
  return {
    files: {
      'manifest.md': manifest('review-loop', 14, 2, 'deliverables/D1-fix-defects.md'),
      'deliverables/D1-fix-defects.md': REVIEW_LOOP_DELIVERABLE,
      'research.md': research(
        'review-loop',
        'The only work is D1: fix the three seeded defects while leaving the permitted style quirks untouched.'
      ),
    },
  }
}
