// Fixture repo for the dirty-branch scenario: genuinely DIRTY mid-flight work
// committed on main, so the deliverable branch (cut from main) carries it all
// and the code-review loop reviews real flaws instead of the implementer-
// cleaned F≈0 regime the other seeded rows produce. src/calc.ts plants ~6
// flaws in the ONE file the deliverable touches:
//   - 2 functional defects exposed by failing fixture tests (`add` subtracts,
//     `max` returns the smaller argument) — the implementer's narrow job;
//   - 4 guideline violations of the fixture CLAUDE.md that the tests do NOT
//     catch: a comment (DR-1), a `var` declaration (DR-3), an exported
//     function with no return type using string concatenation (DR-2 + DR-5),
//     and a dead export nothing uses or tests (DR-4). The deliverable plan
//     deliberately does NOT mention them — they are the review loop's to find.
// FLAW_PROBES maps each guideline flaw to a predicate over the final
// src/calc.ts so a grader can assert the review-fix rounds actually cleaned
// it; DIRTY_CHURN_THRESHOLD_LINES bounds the total diff (the six fixes are
// ~15 lines — a rewrite blows past it).

import type { ScenarioRepo, ScenarioRule } from '../../../scenario/types.ts'

export const DIRTY_REPO_NAME = 'calc'

export const DIRTY_VALIDATIONS: string[] = ['bun test']

/** Documented churn ceiling for the dirty-branch scenario. */
export const DIRTY_CHURN_THRESHOLD_LINES = 60

/** The dirty-repo CLAUDE.md rules, fed verbatim to the review machinery. */
export const DIRTY_RULES: ScenarioRule[] = [
  { id: 'DR-1', source: 'CLAUDE.md', text: 'No code comments — source files stay comment-free and self-explanatory.' },
  { id: 'DR-2', source: 'CLAUDE.md', text: 'Every exported function declares an explicit return type.' },
  { id: 'DR-3', source: 'CLAUDE.md', text: 'Use const or let — never var.' },
  { id: 'DR-4', source: 'CLAUDE.md', text: 'No dead code: every export is used by the app or covered by a test; delete leftovers.' },
  { id: 'DR-5', source: 'CLAUDE.md', text: 'Use template literals — never string concatenation with +.' },
  { id: 'DR-6', source: 'CLAUDE.md', text: 'bun test must pass before any work is considered done.' },
]

const CLAUDE_MD = `# Guidelines

${DIRTY_RULES.map(r => `- **${r.id}**: ${r.text}`).join('\n')}
`

/** The seeded dirty source file — every planted flaw lives here. */
const DIRTY_CALC = `// TODO: clean this file up before shipping
var callCount = 0

export function add(a: number, b: number): number {
  callCount = callCount + 1
  return a - b
}

export function max(a: number, b: number): number {
  return a < b ? a : b
}

export function greet(name: string) {
  return "Hello, " + name
}

export function legacyHelper(): number {
  return callCount
}
`

/**
 * One predicate per guideline flaw over the FINAL src/calc.ts content — true
 * means the flaw is gone. Keyed by the rule the flaw violates.
 */
export const FLAW_PROBES: Record<string, (calc: string) => boolean> = {
  'DR-1 comment removed': calc => !calc.includes('//'),
  'DR-3 var removed': calc => !/\bvar\s/.test(calc),
  'DR-2 greet return type': calc => /export function greet\([^)]*\): string/.test(calc),
  'DR-5 concatenation removed': calc => !/["']\s*\+/.test(calc) && !/\+\s*["']/.test(calc),
  'DR-4 dead export removed': calc => !calc.includes('legacyHelper'),
}

/** Declarative file map of the dirty fixture repo (path → content). */
export const DIRTY_REPO_FILES: Record<string, string> = {
  'package.json': `{
  "name": "calc-dirty-fixture",
  "private": true,
  "type": "module"
}
`,
  'CLAUDE.md': CLAUDE_MD,
  'src/calc.ts': DIRTY_CALC,
  'tests/calc.test.ts': `import { expect, test } from 'bun:test'
import { add, greet, max } from '../src/calc.ts'

test('add sums two numbers', () => {
  expect(add(2, 3)).toBe(5)
})

test('max returns the larger argument', () => {
  expect(max(2, 7)).toBe(7)
})

test('greet greets by name', () => {
  expect(greet('Ada')).toBe('Hello, Ada')
})
`,
}

/** A fresh ScenarioRepo declaration for the dirty fixture. */
export function dirtyRepo(): ScenarioRepo {
  return { name: DIRTY_REPO_NAME, files: { ...DIRTY_REPO_FILES }, validations: [...DIRTY_VALIDATIONS] }
}
