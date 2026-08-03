// Scenario: implement-only — stages ["implement"] standing on seeded run
// state: an APPROVED manifest plus one pending, self-contained deliverable
// (fixtures/seeded-run-state.ts), so the implement stage runs with no plan
// stage before it. The seeded manifest's `repos:` map uses the sandbox
// build-time tokens ({{repoRoot:calc}} / {{configPath:calc}}) and therefore
// resolves to real absolute sandbox paths after materialization — the real
// `state.mjs dag` accepts the runDir as-is (proven hermetically in
// tests/eval/harness-scenarios.test.ts).

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { artifactAssert, commandGrader } from '../../scenario/grade.ts'
import type { Scenario } from '../../scenario/types.ts'
import { FIXTURE_RULES, deliverable, fixtureRepo, git } from './fixtures/repo.ts'
import { implementOnlySeed } from './fixtures/seeded-run-state.ts'

export const implementOnlyScenario: Scenario = {
  id: 'implement-only',
  tags: ['scenario', 'implement'],
  stages: ['implement'],
  ask: `Add an exported \`subtract(a: number, b: number): number\` function to src/calc.ts returning \`a - b\`, plus its test. (The implement stage reads the seeded deliverable, not this source plan.)`,
  repos: [fixtureRepo()],
  seedRunState: implementOnlySeed(),
  rules: FIXTURE_RULES,
  correctness: [
    commandGrader('fixture-validations-green', 'bun test', { cwd: '{worktree:D1}' }),
    artifactAssert('deliverable-done-with-commit', o => {
      const { data } = deliverable(o, 'D1')
      if (data.status !== 'done') return false
      const repo = o.sandbox.repos[0]
      if (repo === undefined) return false
      const base = typeof data.base === 'string' && data.base.length > 0 ? data.base : 'main'
      const count = git(repo.root, 'rev-list', '--count', `${base}..${String(data.branch)}`)
      return Number(count.trim()) > 0
    }),
    artifactAssert('code-round-record', o => {
      const dir = join(o.sandbox.runDir, 'reviews')
      return existsSync(dir) && readdirSync(dir).some(f => /^D1-code-round-.*\.md$/.test(f))
    }),
  ],
  expect: { completed: ['implement'], stoppedAt: null, manifestStatus: 'implementing' },
  seed: 13,
  planRounds: 1,
  codeRounds: 1,
  confidenceMin: 70,
}
