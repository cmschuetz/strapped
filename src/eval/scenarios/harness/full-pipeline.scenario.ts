// Scenario: full-pipeline — plan → implement → pr over the tiny calc fixture,
// with the pr stage forced dry-run by the executor (a scenario can never push
// or open real PRs). The ask is deliberately ONE-FUNCTION scale: every agent
// call is a real multi-turn `claude -p` run, so this scenario costs real
// dollars and minutes live.
//
// Expected terminal manifest status is `implementing`: the implement stage's
// first coordinator pass flips approved → implementing, and neither the pr
// stage nor state.mjs ever advances the manifest further during a run (the
// `complete` rung belongs to post-run skill flows).

import { DEFAULT_MODEL } from '../../runner.ts'
import { artifactAssert, commandGrader, scenarioJudge } from '../../scenario/grade.ts'
import type { Scenario } from '../../scenario/types.ts'
import { FIXTURE_RULES, deliverableFiles, fixtureRepo, renderProducedDiffs, stageResults } from './fixtures/repo.ts'

/** The pr stage's result surface the dry-run grader reads. */
interface PrStageView {
  dryRun?: unknown
  prs?: unknown
}

export const fullPipelineScenario: Scenario = {
  id: 'full-pipeline',
  tags: ['scenario', 'pipeline'],
  stages: ['plan', 'implement', 'pr'],
  ask: `Add an exported \`subtract(a: number, b: number): number\` function to src/calc.ts returning \`a - b\`, and a test in tests/calc.test.ts asserting \`subtract(5, 3)\` returns 2. Nothing else — this is a one-function, one-deliverable change.`,
  repos: [fixtureRepo()],
  rules: FIXTURE_RULES,
  correctness: [
    commandGrader('fixture-validations-green', 'bun test', { cwd: '{worktree:D1}' }),
    artifactAssert('deliverable-produced', o => deliverableFiles(o).length >= 1),
    artifactAssert('pr-dry-run-entries', o => {
      const pr = stageResults(o).pr as PrStageView | undefined
      return pr !== undefined && pr.dryRun === true && Array.isArray(pr.prs) && pr.prs.length >= 1
    }),
    scenarioJudge(
      'You are judging the diff a workflow run produced for the ask "add an exported subtract(a, b) function returning a - b, plus a test asserting subtract(5, 3) === 2". Score 1.0 when the diff adds exactly the asked function (with an explicit return type) and its test and nothing extraneous; deduct for missing or wrong behavior, unrelated changes, added comments, or bloat.',
      { model: DEFAULT_MODEL, name: 'diff-quality', render: renderProducedDiffs }
    ),
  ],
  expect: { completed: ['plan', 'implement', 'pr'], stoppedAt: null, manifestStatus: 'implementing' },
  seed: 11,
  planRounds: 1,
  codeRounds: 1,
  confidenceMin: 70,
}
