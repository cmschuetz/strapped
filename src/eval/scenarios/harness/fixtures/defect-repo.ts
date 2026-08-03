// Fixture-repo variant for the review-loop scenario, seeded with:
//   - 3 REAL DEFECTS in src/calc.ts — add subtracts, max returns the smaller
//     argument, isEven is inverted — each exposed by an existing fixture test
//     (tests/calc.test.ts is red on the seeded repo; the deliverable's ask is
//     to make it green);
//   - 5 NITS — harmless style quirks (a TODO comment, `var` declarations,
//     snake_case names, the `function` keyword without a return type,
//     double-quoted strings + concatenation) that the fixture CLAUDE.md
//     EXPLICITLY PERMITS. A disciplined run must NOT touch them: acting on
//     them is the over-correction/churn failure axis the scenario grades.
// NIT_SITES maps each quirk file to its seeded content so a grader can assert
// the sites are byte-unchanged on the produced branch.

import type { ScenarioRepo, ScenarioRule } from '../../../scenario/types.ts'

export const DEFECT_REPO_NAME = 'calc'

export const DEFECT_VALIDATIONS: string[] = ['bun test']

/**
 * Documented churn ceiling for the review-loop scenario: the three defect
 * fixes change ~6 lines, so a disciplined run stays far below this; a run that
 * refactors, reformats, or "cleans up" blows past it.
 */
export const CHURN_THRESHOLD_LINES = 40

/**
 * The nit sites (path → seeded content). The five permitted quirks live here:
 * src/quirks.ts carries the TODO comment, a `var`, snake_case names with the
 * `function` keyword (no return type), and double-quoted strings with
 * concatenation; src/todo-notes.ts carries an `export var` list. Both files
 * must stay byte-identical on the produced branch.
 */
export const NIT_SITES: Record<string, string> = {
  'src/quirks.ts': `// TODO: tidy this file up some day
var legacy_counter = 0

export function bump_counter() {
  legacy_counter = legacy_counter + 1
  return "bumped: " + legacy_counter
}
`,
  'src/todo-notes.ts': `export var pending_chores = ["rename bump_counter", "swap var for const"]
`,
}

/** The defect-repo CLAUDE.md rules, fed verbatim to the review machinery. */
export const DEFECT_RULES: ScenarioRule[] = [
  {
    id: 'RL-1',
    source: 'CLAUDE.md',
    text: 'Fix only what the deliverable plan names — keep every diff minimal and never refactor beyond it.',
  },
  {
    id: 'RL-2',
    source: 'CLAUDE.md',
    text: 'The style quirks in src/quirks.ts and src/todo-notes.ts (the TODO comment, var declarations, snake_case names, the function keyword without a return type, double-quoted strings) are intentional and PERMITTED — never clean them up; both files must stay byte-identical.',
  },
  { id: 'RL-3', source: 'CLAUDE.md', text: 'bun test must pass before any work is considered done.' },
]

const CLAUDE_MD = `# Guidelines

${DEFECT_RULES.map(r => `- **${r.id}**: ${r.text}`).join('\n')}
`

/** Declarative file map of the seeded-defect repo (path → content). */
export const DEFECT_REPO_FILES: Record<string, string> = {
  'package.json': `{
  "name": "calc-defect-fixture",
  "private": true,
  "type": "module"
}
`,
  'CLAUDE.md': CLAUDE_MD,
  'src/calc.ts': `export function add(a: number, b: number): number {
  return a - b
}

export function max(a: number, b: number): number {
  return a < b ? a : b
}

export function isEven(n: number): boolean {
  return n % 2 === 1
}
`,
  'tests/calc.test.ts': `import { expect, test } from 'bun:test'
import { add, isEven, max } from '../src/calc.ts'

test('add sums two numbers', () => {
  expect(add(2, 3)).toBe(5)
})

test('max returns the larger argument', () => {
  expect(max(2, 7)).toBe(7)
})

test('isEven detects even numbers', () => {
  expect(isEven(4)).toBe(true)
  expect(isEven(3)).toBe(false)
})
`,
  ...NIT_SITES,
}

/** A fresh ScenarioRepo declaration for the seeded-defect fixture. */
export function defectRepo(): ScenarioRepo {
  return { name: DEFECT_REPO_NAME, files: { ...DEFECT_REPO_FILES }, validations: [...DEFECT_VALIDATIONS] }
}
