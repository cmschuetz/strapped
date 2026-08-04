// Scenario: many-rules — D2's own evidence row for rules-as-files. The
// review-loop defect fixture with a ~30-rule guideline set (fixtures/
// many-rules.ts): before D2, every rule's verbatim text traveled inline
// through the dispatch args and both reviewer prompts, ballooning the
// dispatch; after D2 the args carry id-only partitions plus a `rulesFile`
// path and the agents Read the snapshot. Stages ["implement"] with
// codeRounds 1 (the 1-round-default representative) over the seeded
// fix-defects deliverable.
//
// Why the graders discriminate:
//   (a) defect-tests-green     — the reviewers/fixer still catch and fix the
//                                seeded defects with the rule text living
//                                only on disk;
//   (b) converged-within-budget — the run still converges to done within the
//                                1-round budget;
//   (c) adherence:rule-ids-recorded — the round-1 record's frontmatter lists
//                                the EXACT seeded id split for BOTH reviewers
//                                (every one of the ~30 ids, each exactly
//                                once), proving the full per-id checklist
//                                contract survives the rules-file
//                                indirection. A harness that drops, truncates,
//                                or invents ids fails this grader.
// Budget and seed are FIXED per the determinism contract (seed 16 matches the
// seeded manifest).

import { join } from 'node:path'
import { readFrontmatterFile, type Die } from '../../../lib/frontmatter.ts'
import { adherenceGraders, artifactAssert, commandGrader } from '../../scenario/grade.ts'
import { splitRules } from '../../scenario/rules.ts'
import type { Scenario, ScenarioOutcome } from '../../scenario/types.ts'
import { MANY_RULES, manyRulesRepo } from './fixtures/many-rules.ts'
import { deliverable } from './fixtures/repo.ts'
import { manyRulesSeed } from './fixtures/seeded-run-state.ts'

const SEED = 16
const CODE_ROUNDS = 1

const raise: Die = msg => {
  throw new Error(msg)
}

/** The frontmatter id list under `key`, as sorted strings (throws when absent). */
function idList(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (!Array.isArray(value)) throw new Error(`round record frontmatter has no ${key} array`)
  return value.map(String).sort()
}

/**
 * The round-1 record frontmatter must carry the exact seeded id split for both
 * reviewers — the same `splitRules(MANY_RULES, SEED, 1)` partition the
 * executor dispatched, order-insensitive per reviewer.
 */
function ruleIdsRecorded(o: ScenarioOutcome): boolean {
  const record = readFrontmatterFile(join(o.sandbox.runDir, 'reviews', 'D1-code-round-1.md'), raise)
  const expected = splitRules(MANY_RULES, SEED, Math.max(1, CODE_ROUNDS))[0]
  if (expected === undefined) throw new Error('splitRules produced no round-1 partition')
  return (
    JSON.stringify(idList(record.data, 'reviewer_a_rules')) === JSON.stringify([...expected.a].sort()) &&
    JSON.stringify(idList(record.data, 'reviewer_b_rules')) === JSON.stringify([...expected.b].sort())
  )
}

export const manyRulesScenario: Scenario = {
  id: 'many-rules',
  tags: ['scenario', 'implement', 'many-rules'],
  stages: ['implement'],
  ask: `Fix the three seeded defects in src/calc.ts (add subtracts, max returns the smaller argument, isEven is inverted) so bun test passes, changing nothing else. (The implement stage reads the seeded deliverable, not this source plan.)`,
  repos: [manyRulesRepo()],
  seedRunState: manyRulesSeed(),
  rules: MANY_RULES,
  correctness: [
    commandGrader('defect-tests-green', 'bun test', { cwd: '{worktree:D1}' }),
    artifactAssert('converged-within-budget', o => {
      const { data } = deliverable(o, 'D1')
      const rounds = typeof data.review_rounds_used === 'number' ? data.review_rounds_used : Number.POSITIVE_INFINITY
      return data.status === 'done' && rounds <= CODE_ROUNDS
    }),
  ],
  adherence: [...adherenceGraders(), artifactAssert('adherence:rule-ids-recorded', ruleIdsRecorded)],
  expect: {
    completed: ['implement'],
    stoppedAt: null,
    manifestStatus: 'implementing',
    deliverables: [{ id: 'D1', status: 'done' }],
  },
  seed: SEED,
  planRounds: 1,
  codeRounds: CODE_ROUNDS,
  confidenceMin: 70,
}
