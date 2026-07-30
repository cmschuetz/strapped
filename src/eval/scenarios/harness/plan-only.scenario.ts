// Scenario: plan-only — stages ["plan"] over the calc fixture, grading the
// produced plan artifacts (manifest/research/deliverables), the round-1 review
// record, and convergence. A singleton ["plan"] dispatch never auto-approves,
// so the expected terminal manifest status is `in-review` (approval belongs to
// the skill's interactive gate). Cheapest scenario in the suite, but still a
// real multi-agent `claude -p` run live.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFrontmatterFile } from '../../../lib/frontmatter.ts'
import { DEFAULT_MODEL } from '../../runner.ts'
import { artifactAssert, scenarioJudge } from '../../scenario/grade.ts'
import type { Scenario, ScenarioOutcome } from '../../scenario/types.ts'
import { FIXTURE_RULES, deliverableFiles, fixtureRepo, readDeliverable } from './fixtures/repo.ts'

/** The plan stage's result surface the convergence grader reads. */
interface PlanStageView {
  converged?: unknown
}

function planResult(outcome: ScenarioOutcome): PlanStageView | undefined {
  const run = outcome.runResult
  if (run === null || typeof run !== 'object') return undefined
  const results = (run as { results?: Record<string, unknown> }).results
  return results?.plan as PlanStageView | undefined
}

/** Judge evidence: the manifest plus every deliverable body, verbatim. */
function renderPlanArtifacts(outcome: ScenarioOutcome): string {
  const { runDir } = outcome.sandbox
  const manifest = existsSync(join(runDir, 'manifest.md'))
    ? readFileSync(join(runDir, 'manifest.md'), 'utf8')
    : '(no manifest.md)'
  const sections = deliverableFiles(outcome).map(
    f => `## ${f}\n${readFileSync(join(runDir, 'deliverables', f), 'utf8')}`
  )
  return `# manifest.md\n${manifest}\n\n${sections.join('\n\n')}`
}

export const planOnlyScenario: Scenario = {
  id: 'plan-only',
  tags: ['scenario', 'plan'],
  stages: ['plan'],
  ask: `Add an exported \`subtract(a: number, b: number): number\` function to src/calc.ts returning \`a - b\`, and a test in tests/calc.test.ts asserting \`subtract(5, 3)\` returns 2. Nothing else — this is a one-function, one-deliverable change.`,
  repos: [fixtureRepo()],
  rules: FIXTURE_RULES,
  correctness: [
    artifactAssert(
      'plan-artifacts-exist',
      o => existsSync(join(o.sandbox.runDir, 'manifest.md')) && existsSync(join(o.sandbox.runDir, 'research.md'))
    ),
    artifactAssert('manifest-parses', o => {
      const { data } = readFrontmatterFile(join(o.sandbox.runDir, 'manifest.md'), msg => {
        throw new Error(msg)
      })
      return typeof data.status === 'string' && data.status.length > 0
    }),
    artifactAssert('deliverables-have-acs-and-tests', o => {
      const files = deliverableFiles(o)
      return (
        files.length >= 1 &&
        files.every(f => {
          const { content } = readDeliverable(o, f)
          return content.includes('## Acceptance criteria') && content.includes('## Tests')
        })
      )
    }),
    artifactAssert('plan-round-record', o => existsSync(join(o.sandbox.runDir, 'reviews', 'plan-round-1.md'))),
    artifactAssert('plan-converged', o => planResult(o)?.converged === true),
    scenarioJudge(
      'You are judging an implementation plan produced for the ask "add an exported subtract(a, b) function returning a - b, plus a test". Score 1.0 when the plan is a single self-contained one-deliverable DAG with concrete files to touch, testable acceptance criteria, and named tests; deduct for missing sections, vague criteria, invented scope, or a needlessly split DAG.',
      { model: DEFAULT_MODEL, name: 'plan-quality', render: renderPlanArtifacts }
    ),
  ],
  expect: { completed: ['plan'], stoppedAt: null, manifestStatus: 'in-review' },
  seed: 12,
  planRounds: 1,
  codeRounds: 1,
  confidenceMin: 70,
}
