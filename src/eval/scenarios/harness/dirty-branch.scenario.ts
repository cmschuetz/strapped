// Scenario: dirty-branch — the suite's finding-HEAVY row. Every other seeded
// row has its defects fixed by the implementer BEFORE review, so review always
// sees F≈0 — the regime where D1's constant-cost verify-consolidate agent
// cannot show its win over the retired per-finding refuter fan-out. Here the
// deliverable's branch is PRE-COMMITTED (fixtures/dirty-repo.ts): it carries
// the 2 functional defects the narrowly-scoped deliverable tells the
// implementer to fix in src/calc.ts, plus 4 guideline violations in
// src/report.ts — a file the deliverable's Files to touch / AC2 ("changes
// only src/calc.ts") fence the implementer out of — so the flaws
// deterministically survive to review, the
// reviewers' rule checklists produce real findings AT REVIEW TIME, and one
// batch verifier adjudicates them. This is the live measurement of the
// linear-refute-vs-batch-verify claim that D1 could only prove by hermetic
// call-count test.
//
// Why the graders discriminate:
//   (a) defect-tests-green      — the functional defects are fixed;
//   (b) flaws-cleaned           — every guideline flaw is gone from the final
//                                 file (a review loop that never surfaces or
//                                 never fixes them fails here);
//   (c) converged-within-budget — done within the 2-round budget;
//   (d) churn-within-threshold  — the fixes stay surgical (a rewrite fails);
//   (e) adherence:per-finding-verdicts — the round-1 record carries a
//                                 non-empty findings list with a verdict and
//                                 status per finding (review saw the dirt and
//                                 the verifier cast per-finding votes).
// Budget and seed are FIXED per the determinism contract (seed 17 matches the
// seeded manifest).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFrontmatterFile, type Die } from '../../../lib/frontmatter.ts'
import { adherenceGraders, artifactAssert, commandGrader } from '../../scenario/grade.ts'
import type { Scenario, ScenarioOutcome } from '../../scenario/types.ts'
import { DIRTY_CHURN_THRESHOLD_LINES, DIRTY_RULES, FLAW_PROBES, dirtyRepo } from './fixtures/dirty-repo.ts'
import { changedLines, deliverable, worktreeOf } from './fixtures/repo.ts'
import { dirtyBranchSeed } from './fixtures/seeded-run-state.ts'

const SEED = 17
const CODE_ROUNDS = 2

const raise: Die = msg => {
  throw new Error(msg)
}

/** Every guideline-flaw probe holds on the final src/report.ts. */
function flawsCleaned(o: ScenarioOutcome): boolean {
  const report = readFileSync(join(worktreeOf(o, 'D1'), 'src', 'report.ts'), 'utf8')
  return Object.values(FLAW_PROBES).every(probe => probe(report))
}

/**
 * The round-1 record's frontmatter findings list is non-empty and every entry
 * carries a per-finding verdict and status — review actually surfaced the
 * planted dirt and the batch verifier cast a vote on each finding.
 */
function perFindingVerdicts(o: ScenarioOutcome): boolean {
  const record = readFrontmatterFile(join(o.sandbox.runDir, 'reviews', 'D1-code-round-1.md'), raise)
  const findings = record.data.findings
  if (!Array.isArray(findings) || findings.length === 0) return false
  return findings.every(f => {
    if (typeof f !== 'object' || f === null) return false
    const entry = f as Record<string, unknown>
    return typeof entry.verdict === 'string' && entry.verdict.length > 0 && typeof entry.status === 'string'
  })
}

export const dirtyBranchScenario: Scenario = {
  id: 'dirty-branch',
  tags: ['scenario', 'implement', 'dirty-branch'],
  stages: ['implement'],
  ask: `Make the failing tests in tests/calc.test.ts pass by fixing add and max in src/calc.ts. (The implement stage reads the seeded deliverable, not this source plan.)`,
  repos: [dirtyRepo()],
  seedRunState: dirtyBranchSeed(),
  rules: DIRTY_RULES,
  correctness: [
    commandGrader('defect-tests-green', 'bun test', { cwd: '{worktree:D1}' }),
    artifactAssert('flaws-cleaned', flawsCleaned),
    artifactAssert('converged-within-budget', o => {
      const { data } = deliverable(o, 'D1')
      const rounds = typeof data.review_rounds_used === 'number' ? data.review_rounds_used : Number.POSITIVE_INFINITY
      return data.status === 'done' && rounds <= CODE_ROUNDS
    }),
    artifactAssert('churn-within-threshold', o => {
      const { data } = deliverable(o, 'D1')
      const base = typeof data.base === 'string' && data.base.length > 0 ? data.base : 'main'
      return changedLines(worktreeOf(o, 'D1'), base) <= DIRTY_CHURN_THRESHOLD_LINES
    }),
  ],
  adherence: [...adherenceGraders(), artifactAssert('adherence:per-finding-verdicts', perFindingVerdicts)],
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
