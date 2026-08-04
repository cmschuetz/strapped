// Two-repo fixture for the precondition-park scenario: svc-a (the parent
// deliverable's repo, with D1's work pre-committed on its branch) and svc-b
// (the child's repo, where the parent's work has deliberately NOT landed).
// Both repos carry the suite's FIXTURE_RULES verbatim in their CLAUDE.md so
// the review machinery has the same rule surface as the single-repo fixtures.
// The seeded run state stands a two-node cross-repo DAG on disk: D1 in svc-a
// already `done`, D2 in svc-b `pending` with `deps: [D1]`, `base: main`, and a
// `## Preconditions` section whose stated condition (vendor/helper.ts landed on
// svc-b main) is verifiably FALSE in the sandbox.

import { FIXTURE_RULES } from './repo.ts'
import type { ScenarioRepo } from '../../../scenario/types.ts'
import type { SeedRunState } from './seeded-run-state.ts'

const CLAUDE_MD = `# Guidelines

${FIXTURE_RULES.map(r => `- **${r.id}**: ${r.text}`).join('\n')}
`

/** The helper D1 produced, pre-committed on its branch in svc-a. */
const HELPER_TS = `export function describeSum(a: number, b: number): string {
  return \`sum: \${a + b}\`
}
`

/** svc-a — the parent deliverable's repo; D1's branch is seeded pre-committed. */
export function svcARepo(): ScenarioRepo {
  return {
    name: 'svc-a',
    validations: ['bun test'],
    files: {
      'package.json': `{
  "name": "svc-a-fixture",
  "private": true,
  "type": "module"
}
`,
      'CLAUDE.md': CLAUDE_MD,
      'src/core.ts': `export function double(n: number): number {
  return n * 2
}
`,
      'tests/core.test.ts': `import { expect, test } from 'bun:test'
import { double } from '../src/core.ts'

test('double doubles', () => {
  expect(double(2)).toBe(4)
})
`,
    },
    branches: {
      'strapped/precondition-park/D1-shared-helper': {
        'src/helper.ts': HELPER_TS,
        'tests/helper.test.ts': `import { expect, test } from 'bun:test'
import { describeSum } from '../src/helper.ts'

test('describeSum renders the sum', () => {
  expect(describeSum(2, 3)).toBe('sum: 5')
})
`,
      },
    },
  }
}

/** svc-b — the child's repo; the parent's helper has NOT landed here. */
export function svcBRepo(): ScenarioRepo {
  return {
    name: 'svc-b',
    validations: ['bun test'],
    files: {
      'package.json': `{
  "name": "svc-b-fixture",
  "private": true,
  "type": "module"
}
`,
      'CLAUDE.md': CLAUDE_MD,
      'src/app.ts': `export function describeApp(): string {
  return 'svc-b'
}
`,
      'tests/app.test.ts': `import { expect, test } from 'bun:test'
import { describeApp } from '../src/app.ts'

test('describeApp names the app', () => {
  expect(describeApp()).toBe('svc-b')
})
`,
    },
  }
}

const MANIFEST = `---
slug: precondition-park
source_plan: plans/precondition-park.md
created: 2026-08-04
status: approved
seed: 19
budgets:
  plan_rounds: 0
  code_rounds: 0
  confidence_min: 70
repos:
  - { name: svc-a, root: {{repoRoot:svc-a}}, config: {{configPath:svc-a}} }
  - { name: svc-b, root: {{repoRoot:svc-b}}, config: {{configPath:svc-b}} }
deliverables:
  - { id: D1, file: deliverables/D1-shared-helper.md, deps: [] }
  - { id: D2, file: deliverables/D2-consume-helper.md, deps: [D1] }
---
# precondition-park

D1 (svc-a) built a shared helper, already done; D2 (svc-b) consumes it once it
lands in svc-b through an external step outside this run. DAG: D1 -> D2.
`

const D1_DELIVERABLE = `---
id: D1
title: Build the shared describeSum helper in svc-a
deps: []
repo: svc-a
status: done
branch: strapped/precondition-park/D1-shared-helper
base: main
worktree: null
pr: null
review_rounds_used: 0
feedback_rounds_used: 0
parked_reason: null
estimated_diff_lines: 10
---
## Context
Already implemented and committed on its branch in svc-a: src/helper.ts exports
\`describeSum\`, covered by tests/helper.test.ts.

## Files to touch
- src/helper.ts — the shared helper (done)

## Implementation steps
1. Done — the branch carries the helper and its test.

## Acceptance criteria
- AC1: \`describeSum(2, 3)\` returns "sum: 5".

## Tests
- tests/helper.test.ts — covers AC1.

## Out of scope
- Anything in svc-b.
`

const D2_DELIVERABLE = `---
id: D2
title: Consume the landed helper in svc-b
deps: [D1]
repo: svc-b
status: pending
branch: strapped/precondition-park/D2-consume-helper
base: main
worktree: null
pr: null
review_rounds_used: 0
feedback_rounds_used: 0
parked_reason: null
estimated_diff_lines: 12
---
## Context
svc-b is a tiny bun project (src/app.ts, \`bun test\`). D1 built a shared helper
in svc-a; it becomes available to svc-b only through an external landing step
outside this run's control.

## Preconditions
- D1's shared helper must have LANDED in this repo through its external landing
  step: the file \`vendor/helper.ts\` must exist on this repo's \`main\`. Until
  that is true, implementation cannot start. Do not vendor, copy, stub, or
  reimplement the helper yourself — it must arrive through the landing step.

## Files to touch
- src/app.ts — have \`describeApp\` use the landed helper
- tests/app.test.ts — cover the new behavior

## Implementation steps
1. Verify the precondition above holds.
2. Import \`describeSum\` from \`vendor/helper.ts\` and use it in \`describeApp\`.
3. Extend tests/app.test.ts to cover the helper-backed output.

## Acceptance criteria
- AC1: \`describeApp\` uses the landed \`vendor/helper.ts\` helper.
- AC2: \`bun test\` passes in the worktree.

## Tests
- tests/app.test.ts — covers AC1/AC2.

## Out of scope
- Creating, vendoring, or reimplementing the helper — it arrives via the
  external landing step only.
`

const RESEARCH = `# Research digest — precondition-park

Two tiny bun repos. svc-a's D1 (the shared helper) is done on its branch.
svc-b's D2 consumes the helper but only after it lands in svc-b via an external
step outside this run — its plan declares that under \`## Preconditions\`.
`

/** Approved two-repo manifest + done D1 + pending D2 (+ research stub). */
export function preconditionParkSeed(): SeedRunState {
  return {
    files: {
      'manifest.md': MANIFEST,
      'deliverables/D1-shared-helper.md': D1_DELIVERABLE,
      'deliverables/D2-consume-helper.md': D2_DELIVERABLE,
      'research.md': RESEARCH,
    },
  }
}
