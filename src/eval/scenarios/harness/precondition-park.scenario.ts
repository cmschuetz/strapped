// Scenario: precondition-park — the parking policy for externally-landing
// prerequisites, exercised end to end on a two-repo fixture. Seeded state: D1
// in svc-a already `done` (its branch pre-committed), D2 in svc-b `pending`
// with `deps: [D1]`, `base: main`, and a `## Preconditions` section whose
// stated condition (the parent's helper landed on svc-b `main` as
// vendor/helper.ts) is verifiably FALSE in the sandbox. Stages ["implement"].
//
// A policy-following run dispatches D2 (its dep is done), and the implementer
// PARKS it: status `parked`, `parked_reason` naming the unmet precondition,
// and svc-b's tree untouched — the implement gate then fails on not-allDone
// (stoppedAt: implement). Why the graders discriminate: an implementer that
// improvises around the precondition (vendoring/stubbing the helper and
// implementing anyway) leaves commits or dirt on the child branch and a
// non-parked status — failing child-tree-untouched and the expected end-state
// — while an empty or unrelated parked_reason fails the reason-naming graders.
// Budget and seed are FIXED per the determinism contract; both round budgets
// are 0 (a parked node never reaches code review, and the 0-round path keeps
// the run at coordinator + one implementer + applier).

import { existsSync } from 'node:fs'
import { artifactAssert } from '../../scenario/grade.ts'
import type { Scenario, ScenarioOutcome } from '../../scenario/types.ts'
import { FIXTURE_RULES, changedLines, deliverable, git } from './fixtures/repo.ts'
import { preconditionParkSeed, svcARepo, svcBRepo } from './fixtures/two-repo.ts'

/** D2 parked with a parked_reason that names the unmet precondition. */
function parkedNamingPrecondition(o: ScenarioOutcome): boolean {
  const { data } = deliverable(o, 'D2')
  if (data.status !== 'parked') return false
  const reason = typeof data.parked_reason === 'string' ? data.parked_reason : ''
  return /recondition|vendor\/helper/.test(reason)
}

/** svc-b carries NO improvised work: no commits beyond main, no dirty worktree. */
function childTreeUntouched(o: ScenarioOutcome): boolean {
  const { data } = deliverable(o, 'D2')
  const worktree = data.worktree
  if (typeof worktree === 'string' && worktree.length > 0 && existsSync(worktree)) {
    if (git(worktree, 'status', '--porcelain').trim() !== '') return false
    return changedLines(worktree, 'main') === 0
  }
  const repo = o.sandbox.repos.find(r => r.name === 'svc-b')
  if (repo === undefined) return false
  try {
    const count = git(repo.root, 'rev-list', '--count', `main..${String(data.branch)}`)
    return Number(count.trim()) === 0
  } catch {
    return true
  }
}

export const preconditionParkScenario: Scenario = {
  id: 'precondition-park',
  tags: ['scenario', 'implement', 'precondition-park'],
  stages: ['implement'],
  ask: `Have svc-b's describeApp use the shared helper D1 produced, once that helper has landed in svc-b through its external landing step. (The implement stage reads the seeded deliverables, not this source plan.)`,
  repos: [svcARepo(), svcBRepo()],
  seedRunState: preconditionParkSeed(),
  rules: FIXTURE_RULES,
  correctness: [
    artifactAssert('child-parked-naming-precondition', parkedNamingPrecondition),
    artifactAssert('child-tree-untouched', childTreeUntouched),
  ],
  expect: {
    completed: [],
    stoppedAt: 'implement',
    manifestStatus: 'implementing',
    deliverables: [
      { id: 'D1', status: 'done' },
      { id: 'D2', status: 'parked', parkedReasonPattern: 'recondition|vendor/helper' },
    ],
  },
  seed: 19,
  planRounds: 0,
  codeRounds: 0,
  confidenceMin: 70,
}
