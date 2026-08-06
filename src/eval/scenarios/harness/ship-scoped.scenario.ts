// Scenario: ship-scoped — a per-deliverable ship: stages ["implement", "pr"]
// with BOTH stage scopes pinned to D1 over a seeded two-node run (D2 depends
// on D1, both pending). The scoped dag makes `remaining` count D1 alone, so
// the implement gate reports allDone once D1 is done even though D2 is still
// pending, and the chained pr stage runs (dry-run forced by the executor, so
// D1 stays `done` — no `pr-open` flip) instead of the dispatch stopping at
// implement. D2 must end exactly as seeded: pending, untouched.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { artifactAssert, commandGrader } from '../../scenario/grade.ts'
import type { Scenario } from '../../scenario/types.ts'
import { FIXTURE_RULES, deliverable, fixtureRepo, git, stageResults } from './fixtures/repo.ts'
import { shipScopedSeed } from './fixtures/seeded-run-state.ts'

export const shipScopedScenario: Scenario = {
  id: 'ship-scoped',
  tags: ['scenario', 'ship', 'pr'],
  stages: ['implement', 'pr'],
  ask: `Ship deliverable D1 alone: add an exported \`subtract(a: number, b: number): number\` to src/calc.ts plus its test, then run its PR pass — D2 (multiply) stays pending. (The implement stage reads the seeded deliverables, not this source plan.)`,
  repos: [fixtureRepo()],
  seedRunState: shipScopedSeed(),
  rules: FIXTURE_RULES,
  stageArgs: { implement: { only: 'D1' }, pr: { only: 'D1' } },
  correctness: [
    commandGrader('fixture-validations-green', 'bun test', { cwd: '{worktree:D1}' }),
    artifactAssert('scoped-node-done-with-commit', o => {
      const { data } = deliverable(o, 'D1')
      if (data.status !== 'done') return false
      const repo = o.sandbox.repos[0]
      if (repo === undefined) return false
      const base = typeof data.base === 'string' && data.base.length > 0 ? data.base : 'main'
      const count = git(repo.root, 'rev-list', '--count', `${base}..${String(data.branch)}`)
      return Number(count.trim()) > 0
    }),
    artifactAssert('out-of-scope-untouched', o => {
      const { data } = deliverable(o, 'D2')
      const worktree = data.worktree
      return data.status === 'pending' && (worktree === null || worktree === undefined || worktree === '')
    }),
    artifactAssert('scoped-gate-reports-alldone', o => {
      const implement = stageResults(o).implement as { allDone?: unknown } | undefined
      return implement !== undefined && implement.allDone === true
    }),
    artifactAssert('pr-stage-ran-dry', o => {
      const pr = stageResults(o).pr as { dryRun?: unknown; gateFailed?: unknown } | undefined
      return pr !== undefined && pr.dryRun === true && pr.gateFailed !== true
    }),
    artifactAssert('code-round-record', o => {
      const dir = join(o.sandbox.runDir, 'reviews')
      return existsSync(dir) && readdirSync(dir).some(f => /^D1-code-round-.*\.md$/.test(f))
    }),
  ],
  expect: {
    completed: ['implement', 'pr'],
    stoppedAt: null,
    manifestStatus: 'implementing',
    deliverables: [
      { id: 'D1', status: 'done' },
      { id: 'D2', status: 'pending' },
    ],
  },
  seed: 21,
  planRounds: 1,
  codeRounds: 1,
  confidenceMin: 70,
}
