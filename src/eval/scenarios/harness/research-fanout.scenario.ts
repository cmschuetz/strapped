// Scenario: research-fanout — stages ["plan"] with the default researchRounds 2
// over a two-repo fixture, grading the plan stage's BFS research delegation: a
// multi-theme ask spanning both repos should make the lead planner enqueue
// research topics, each dispatched as a `researcher:<topic-slug>` agent that
// writes a fragment under `<runDir>/research/`, consolidated by the plan-writer
// into research.md + the plan artifacts. Deterministic graders pin fan-out
// occurrence, topic uniqueness, and the harness-barred final round (no enqueue
// language in researcher prompts); a scenarioJudge grades research fidelity.
// planRounds is 0 (the review loop is not under test), and a singleton ["plan"]
// dispatch never auto-approves, so the terminal manifest status is `in-review`.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MODEL } from '../../runner.ts'
import { artifactAssert, scenarioJudge } from '../../scenario/grade.ts'
import type { AgentLedgerEntry, Scenario, ScenarioOutcome, ScenarioRepo } from '../../scenario/types.ts'
import { FIXTURE_RULES } from './fixtures/repo.ts'
import { svcARepo, svcBRepo } from './fixtures/two-repo.ts'

/** The two-repo fixture without precondition-park's pre-seeded branches. */
function plainRepo(repo: ScenarioRepo): ScenarioRepo {
  const { branches, ...rest } = repo
  void branches
  return rest
}

function researcherEntries(outcome: ScenarioOutcome): AgentLedgerEntry[] {
  return outcome.ledger.filter(e => e.label.startsWith('researcher:'))
}

/** Fragment file basenames under `<runDir>/research/` ([] when the dir is absent). */
function fragmentFiles(outcome: ScenarioOutcome): string[] {
  const dir = join(outcome.sandbox.runDir, 'research')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
}

/** Judge evidence: the consolidated digest plus every research fragment, verbatim. */
function renderResearch(outcome: ScenarioOutcome): string {
  const { runDir } = outcome.sandbox
  const digest = existsSync(join(runDir, 'research.md'))
    ? readFileSync(join(runDir, 'research.md'), 'utf8')
    : '(no research.md)'
  const fragments = fragmentFiles(outcome).map(
    f => `## research/${f}\n${readFileSync(join(runDir, 'research', f), 'utf8')}`
  )
  return `# research.md\n${digest}\n\n${fragments.join('\n\n') || '(no research fragments)'}`
}

export const researchFanoutScenario: Scenario = {
  id: 'research-fanout',
  tags: ['scenario', 'plan', 'research'],
  stages: ['plan'],
  ask: `Three small, discrete, mostly unrelated additions spanning both services:
1. In svc-a, add an exported \`triple(n: number): number\` returning \`n * 3\`, with a test in tests/.
2. In svc-b, add an exported \`shout(s: string): string\` returning the upper-cased input with a trailing "!", with a test in tests/.
3. In svc-b, add an exported \`clamp(n: number, lo: number, hi: number): number\` bounding n to [lo, hi], with a test in tests/.
Each theme stands alone — nothing else changes.`,
  repos: [plainRepo(svcARepo()), plainRepo(svcBRepo())],
  rules: FIXTURE_RULES,
  correctness: [
    artifactAssert(
      'fan-out-occurred',
      o => researcherEntries(o).length >= 1 && fragmentFiles(o).length >= 1
    ),
    artifactAssert('topics-unique', o => {
      const labels = researcherEntries(o).map(e => e.label)
      return new Set(labels).size === labels.length
    }),
    // researchRounds 2 makes every researcher final-round: the harness must
    // dispatch them with no enqueue capability in prompt or schema.
    artifactAssert('final-round-no-enqueue', o =>
      researcherEntries(o).every(e => {
        const prompt = e.prompt ?? ''
        return !prompt.includes('research_requests') && !/enqueue/i.test(prompt)
      })
    ),
    artifactAssert(
      'plan-artifacts-exist',
      o =>
        existsSync(join(o.sandbox.runDir, 'manifest.md')) &&
        existsSync(join(o.sandbox.runDir, 'research.md')) &&
        existsSync(join(o.sandbox.runDir, 'deliverables'))
    ),
    scenarioJudge(
      'You are judging the research produced by a plan stage that fanned research out to delegated researcher agents for a three-theme ask (triple() in svc-a; shout() and clamp() in svc-b). Score 1.0 when the consolidated research.md plus the fragments are FAITHFUL to the ask and the two fixture repos (accurate file paths, real repo structure, no invented APIs), cover each theme with useful depth (key files, test patterns, decisions), and the digest actually consolidates the fragments rather than ignoring them; deduct for fabricated findings, themes left unresearched, fragments contradicting the digest, or padding without substance.',
      { model: DEFAULT_MODEL, name: 'research-fidelity', render: renderResearch }
    ),
  ],
  expect: { completed: ['plan'], stoppedAt: null, manifestStatus: 'in-review' },
  seed: 29,
  planRounds: 0,
  codeRounds: 1,
  researchRounds: 2,
  confidenceMin: 70,
}
