// Scenario: zero-rounds — the 0-round-budget cost floor made observable. With
// codeRounds 0 (and planRounds 0) the implement stage must SKIP adversarial
// review entirely: no reviewer/verifier/fix agents run, no round record is
// written, and a validations-green implementation goes straight to `done` with
// `review_rounds_used: 0`. Stages ["implement"] over seeded run state
// (fixtures/seeded-run-state.ts) for cheapness — the only live agents are the
// coordinator, one implementer, and the applier.
//
// Why the graders discriminate: a harness that still runs review at budget 0
// (or one that parks the green node on the old "budget exhausted" path) leaves
// a reviews/*-round-*.md record, a non-zero review_rounds_used, or a non-done
// status — each of which fails its own grader below, while a correct run
// grades 1/1. Budget and seed are FIXED per the determinism contract.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { adherenceGraders, artifactAssert, commandGrader } from '../../scenario/grade.ts'
import type { Scenario, ScenarioOutcome } from '../../scenario/types.ts'
import { FIXTURE_RULES, deliverable, fixtureRepo } from './fixtures/repo.ts'
import { zeroRoundsSeed } from './fixtures/seeded-run-state.ts'

/** True when NO reviews/*-round-*.md record exists in the runDir. */
function noRoundRecords(o: ScenarioOutcome): boolean {
  const dir = join(o.sandbox.runDir, 'reviews')
  return !existsSync(dir) || !readdirSync(dir).some(f => /-round-.*\.md$/.test(f))
}

export const zeroRoundsScenario: Scenario = {
  id: 'zero-rounds',
  tags: ['scenario', 'implement', 'zero-rounds'],
  stages: ['implement'],
  ask: `Add an exported \`subtract(a: number, b: number): number\` function to src/calc.ts returning \`a - b\`, plus its test. (The implement stage reads the seeded deliverable, not this source plan.)`,
  repos: [fixtureRepo()],
  seedRunState: zeroRoundsSeed(),
  rules: FIXTURE_RULES,
  correctness: [
    commandGrader('fixture-validations-green', 'bun test', { cwd: '{worktree:D1}' }),
    artifactAssert('done-with-zero-rounds', o => {
      const { data } = deliverable(o, 'D1')
      return data.status === 'done' && data.review_rounds_used === 0
    }),
  ],
  // The built-in suite (round-record checks are n/a at budget 0) plus the cost
  // floor itself: 0 rounds means NO round record may exist.
  adherence: [...adherenceGraders(), artifactAssert('adherence:no-round-records', noRoundRecords)],
  expect: {
    completed: ['implement'],
    stoppedAt: null,
    manifestStatus: 'implementing',
    deliverables: [{ id: 'D1', status: 'done' }],
  },
  seed: 15,
  planRounds: 0,
  codeRounds: 0,
  confidenceMin: 70,
}
