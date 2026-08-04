// Rule-list fixture for the many-rules scenario: the review-loop defect rules
// (RL-1..RL-3, the ones the graders bite on) inflated with 27 realistic filler
// guidelines to ~30 total — the rule volume that ballooned the pre-D2 dispatch
// args when every rule's verbatim text traveled inline. The filler rules are
// deliberately ones a tiny disciplined calc fix already satisfies (or that are
// n/a), so they inflate the SNAPSHOT and the per-reviewer checklists without
// changing what a correct run must do. The fixture CLAUDE.md carries every
// rule verbatim (the hermetic well-formedness test asserts it), and the repo
// is otherwise the review-loop defect repo unchanged.

import type { ScenarioRepo, ScenarioRule } from '../../../scenario/types.ts'
import { DEFECT_REPO_FILES, DEFECT_REPO_NAME, DEFECT_RULES, DEFECT_VALIDATIONS } from './defect-repo.ts'

/** 27 realistic filler guidelines a disciplined calc fix trivially satisfies. */
const FILLER_RULE_TEXTS: string[] = [
  'Prefer const over let, and never use var.',
  'Every exported function declares an explicit return type.',
  'Test files live under tests/ and end in .test.ts.',
  'Use single quotes for string literals.',
  'Never commit commented-out code.',
  'Keep functions under 40 lines; extract helpers instead of nesting deeply.',
  'Use strict equality (=== / !==) — never == or !=.',
  'Name booleans with an is/has/should prefix.',
  'Never introduce a new runtime dependency without explicit approval.',
  'Prefer early returns over nested if/else pyramids.',
  'Every new source file starts with a one-paragraph header comment explaining its role.',
  'Do not use default exports — named exports only.',
  'Keep import lists sorted alphabetically within each group.',
  'Never mutate function parameters.',
  'Prefer template literals over string concatenation.',
  'Throw Error subclasses with descriptive messages — never bare strings.',
  'Avoid any; type every value precisely or use unknown with narrowing.',
  'Tests assert observable behavior through public interfaces, never internals.',
  'One assertion subject per test — split unrelated checks into separate tests.',
  'Never use Date.now() or Math.random() directly in library code; inject them.',
  'Keep the public API surface minimal: do not export helpers only tests use.',
  'Use descriptive test names that state the expected behavior.',
  'Never swallow errors with an empty catch block.',
  'Prefer array methods (map/filter/reduce) over index-based for loops.',
  'Do not abbreviate identifiers — write calculateTotal, not calcTot.',
  'Keep files under 300 lines; split modules that grow past it.',
  'Never leave TODO comments without an issue reference.',
]

/**
 * The inflated rule list: the three defect-repo rules first (graders and the
 * seeded deliverable depend on their semantics), then MR-4..MR-30.
 */
export const MANY_RULES: ScenarioRule[] = [
  ...DEFECT_RULES,
  ...FILLER_RULE_TEXTS.map((text, i) => ({ id: `MR-${i + 4}`, source: 'CLAUDE.md', text })),
]

const CLAUDE_MD = `# Guidelines

${MANY_RULES.map(r => `- **${r.id}**: ${r.text}`).join('\n')}
`

/** The defect repo overlaid with the 30-rule CLAUDE.md. */
export function manyRulesRepo(): ScenarioRepo {
  return {
    name: DEFECT_REPO_NAME,
    files: { ...DEFECT_REPO_FILES, 'CLAUDE.md': CLAUDE_MD },
    validations: [...DEFECT_VALIDATIONS],
  }
}
