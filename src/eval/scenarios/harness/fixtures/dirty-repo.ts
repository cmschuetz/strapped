// Fixture repo for the dirty-branch scenario: main carries a pre-work calc
// stub (tests red), and a PRE-COMMITTED branch carries the mid-flight work the
// review loop must judge — so findings deterministically exist AT REVIEW TIME
// (the other seeded rows let the implementer clean everything first, leaving
// review the F≈0 regime where the constant-verifier win cannot show):
//   - src/calc.ts (branch): 2 functional defects exposed by failing fixture
//     tests (`add` subtracts, `max` returns the smaller argument) — the
//     implementer's narrow job per the seeded deliverable;
//   - src/report.ts (branch): 4 guideline violations of the fixture CLAUDE.md
//     that tests do NOT catch — a comment (DR-1), `var` (DR-3), a missing
//     return type (DR-2), string concatenation (DR-5) — and DR-4 (smallest
//     diff, never delete files) is a constraint, not a planted flaw: it bars
//     the fixer from "cleaning" by deleting the module and its test.
//     The seeded deliverable's Files to touch / AC2 ("changes only
//     src/calc.ts") fence the implementer OUT of this file, so the flaws
//     survive to review; formatReport is test-covered so the fixer cannot
//     simply delete the file.
// FLAW_PROBES maps each flaw to a predicate over the final src/report.ts so a
// grader can assert the review-fix rounds actually cleaned them.

import type { ScenarioRepo, ScenarioRule } from '../../../scenario/types.ts'

export const DIRTY_REPO_NAME = 'calc'

export const DIRTY_VALIDATIONS: string[] = ['bun test']

/** Documented churn ceiling for the dirty-branch scenario. */
export const DIRTY_CHURN_THRESHOLD_LINES = 90

/** The dirty-repo CLAUDE.md rules, fed verbatim to the review machinery. */
export const DIRTY_RULES: ScenarioRule[] = [
  { id: 'DR-1', source: 'CLAUDE.md', text: 'No code comments — source files stay comment-free and self-explanatory.' },
  { id: 'DR-2', source: 'CLAUDE.md', text: 'Every exported function declares an explicit return type.' },
  { id: 'DR-3', source: 'CLAUDE.md', text: 'Use const or let — never var.' },
  { id: 'DR-4', source: 'CLAUDE.md', text: 'Smallest possible diff: never delete existing files or tests; fix flaws in place.' },
  { id: 'DR-5', source: 'CLAUDE.md', text: 'Use template literals — never string concatenation with +.' },
  { id: 'DR-6', source: 'CLAUDE.md', text: 'bun test must pass before any work is considered done.' },
]

const CLAUDE_MD = `# Guidelines

${DIRTY_RULES.map(r => `- **${r.id}**: ${r.text}`).join('\n')}
`

/** Main's pre-work calc stub — tests are red until the branch work lands. */
const STUB_CALC = `export function add(a: number, b: number): number {
  return 0
}

export function max(a: number, b: number): number {
  return 0
}

export function greet(name: string): string {
  return \`Hello, \${name}\`
}
`

/** The seeded BRANCH's mid-flight calc — the two test-breaking defects live here. */
const DIRTY_CALC = `export function add(a: number, b: number): number {
  return a - b
}

export function max(a: number, b: number): number {
  return a < b ? a : b
}

export function greet(name: string): string {
  return \`Hello, \${name}\`
}
`

/**
 * The seeded BRANCH's flawed side file — every guideline flaw lives here, and
 * the seeded deliverable's Files to touch / AC2 ("changes only src/calc.ts")
 * fence the implementer out of it, so the flaws deterministically survive to
 * review. formatReport is covered by a test (the file is not deletable as
 * dead code).
 */
const DIRTY_REPORT = `// TODO: tidy before shipping
var reportCount = 0

export function formatReport(name: string, total: number) {
  reportCount = reportCount + 1
  return "Report for " + name + ": " + total
}
`

/**
 * One predicate per guideline flaw over the FINAL src/report.ts content — true
 * means the flaw is gone. Keyed by the rule the flaw violates.
 */
export const FLAW_PROBES: Record<string, (report: string) => boolean> = {
  'DR-1 comment removed': report => !report.includes('//'),
  'DR-3 var removed': report => !/\bvar\s/.test(report),
  'DR-2 formatReport return type': report => /export function formatReport\([^)]*\): string/.test(report),
  'DR-5 concatenation removed': report => !/["']\s*\+/.test(report) && !/\+\s*["']/.test(report),
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
  'src/calc.ts': STUB_CALC,
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

/** The seeded branch name — must match the deliverable frontmatter's branch. */
export const DIRTY_BRANCH = 'strapped/dirty-branch/D1-green-tests'

/** Branch overlay: the mid-flight commit review must run against. */
export const DIRTY_BRANCH_FILES: Record<string, string> = {
  'src/calc.ts': DIRTY_CALC,
  'src/report.ts': DIRTY_REPORT,
  'tests/report.test.ts': `import { expect, test } from 'bun:test'
import { formatReport } from '../src/report.ts'

test('formatReport names the report', () => {
  expect(formatReport('Ada', 3)).toBe('Report for Ada: 3')
})
`,
}

/** A fresh ScenarioRepo declaration for the dirty fixture. */
export function dirtyRepo(): ScenarioRepo {
  return {
    name: DIRTY_REPO_NAME,
    files: { ...DIRTY_REPO_FILES },
    branches: { [DIRTY_BRANCH]: { ...DIRTY_BRANCH_FILES } },
    validations: [...DIRTY_VALIDATIONS],
  }
}
