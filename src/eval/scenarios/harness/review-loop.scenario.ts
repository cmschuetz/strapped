// Scenario: review-loop — the suite's ANTI-SATURATION scenario. Happy-path
// graders on tiny unambiguous asks saturate at 1.0 and can only detect
// regression; this scenario is what lets `--compare` show IMPROVEMENT between
// workflow variants. Stages ["implement"] with codeRounds 2 over a fixture
// seeded with 3 real defects (each exposed by a failing fixture test) and 5
// permitted nits (fixtures/defect-repo.ts). The four correctness graders
// discriminate on independent axes:
//   (a) defect-tests-green    — the defects were caught AND fixed;
//   (b) nits-untouched        — the permitted quirks were NOT acted on
//                               (over-correction/churn axis);
//   (c) churn-within-threshold — total changed lines stay under the
//                               documented CHURN_THRESHOLD_LINES ceiling;
//   (d) converged-within-budget — D1 reached `done` within the review budget.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactAssert, commandGrader } from '../../scenario/grade.ts'
import type { Scenario } from '../../scenario/types.ts'
import { CHURN_THRESHOLD_LINES, DEFECT_RULES, NIT_SITES, defectRepo } from './fixtures/defect-repo.ts'
import { changedLines, deliverable, worktreeOf } from './fixtures/repo.ts'
import { reviewLoopSeed } from './fixtures/seeded-run-state.ts'

const CODE_ROUNDS = 2

export const reviewLoopScenario: Scenario = {
  id: 'review-loop',
  tags: ['scenario', 'implement', 'review-loop'],
  stages: ['implement'],
  ask: `Fix the three seeded defects in src/calc.ts (add subtracts, max returns the smaller argument, isEven is inverted) so bun test passes, changing nothing else. (The implement stage reads the seeded deliverable, not this source plan.)`,
  repos: [defectRepo()],
  seedRunState: reviewLoopSeed(),
  rules: DEFECT_RULES,
  correctness: [
    commandGrader('defect-tests-green', 'bun test', { cwd: '{worktree:D1}' }),
    artifactAssert('nits-untouched', o => {
      const wt = worktreeOf(o, 'D1')
      return Object.entries(NIT_SITES).every(([rel, content]) => {
        const file = join(wt, rel)
        return existsSync(file) && readFileSync(file, 'utf8') === content
      })
    }),
    artifactAssert('churn-within-threshold', o => {
      const { data } = deliverable(o, 'D1')
      const base = typeof data.base === 'string' && data.base.length > 0 ? data.base : 'main'
      return changedLines(worktreeOf(o, 'D1'), base) <= CHURN_THRESHOLD_LINES
    }),
    artifactAssert('converged-within-budget', o => {
      const { data } = deliverable(o, 'D1')
      const rounds = typeof data.review_rounds_used === 'number' ? data.review_rounds_used : Number.POSITIVE_INFINITY
      return data.status === 'done' && rounds <= CODE_ROUNDS
    }),
  ],
  expect: { completed: ['implement'], stoppedAt: null, manifestStatus: 'implementing' },
  seed: 14,
  planRounds: 1,
  codeRounds: CODE_ROUNDS,
  confidenceMin: 70,
}
