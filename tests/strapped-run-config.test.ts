// Config-shape regression tests for the strapped-run mono-workflow that live
// OUTSIDE the frozen regression oracle (tests/strapped-run.test.js), which the
// D3 plan mandates stay byte-identical to its pre-port form. This file holds
// additive coverage of the round-1 config fix (absent rulesByRound → []) so the
// oracle can remain untouched.

import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { agentByLabel, callWithLabel, runWorkflow } from './helpers/workflow-harness.ts'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/strapped-run.js', import.meta.url))

const PR_RESULT = {
  prs: [
    { id: 'D1', url: 'https://github.com/o/r/pull/1', skipped: false, reason: null },
    { id: 'D2', url: null, skipped: true, reason: 'branch has no commits beyond base' },
  ],
  summary: 'opened 1 PR, skipped 1',
}

test('pr: the /strapped:pr singleton config omits rulesByRound entirely and still dispatches', async () => {
  // Matches plugins/strapped/skills/pr/SKILL.md's documented args block verbatim
  // in shape: no rulesByRound field. rulesByRound is read only lazily inside
  // review rounds, so a pr-only dispatch must not require it (pre-port contract).
  const cfg = {
    slug: 'test-run',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    scripts: { state: '/plugin/scripts/state.mjs', worktree: '/plugin/scripts/ensure-worktree.sh' },
    seed: 42,
    confidenceMin: 70,
    planRounds: 3,
    codeRounds: 3,
    stages: ['pr'],
    stageArgs: { pr: { dryRun: false } },
  }
  const { result } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'pr-gate': { remaining: 0, notDone: [] },
      'pr-create': PR_RESULT,
    }),
  })
  assert.deepEqual(result.results.pr, { prs: PR_RESULT.prs, summary: PR_RESULT.summary, dryRun: false })
})

function planOnlyCfg(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'test-run',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    scripts: { state: '/plugin/scripts/state.mjs', worktree: '/plugin/scripts/ensure-worktree.sh' },
    seed: 42,
    confidenceMin: 70,
    planRounds: 0,
    codeRounds: 1,
    stages: ['plan'],
    stageArgs: { plan: { sourcePlan: '/plans/test-run.md', repos: [{ name: 'alpha', root: '/repos/alpha' }] } },
    ...overrides,
  }
}

const LEAD_PLAN = {
  deliverables: [{ id: 'D1', file: 'deliverables/D1-thing.md', title: 'Thing', deps: [] }],
  summary: 'one deliverable covering the thing',
  research_requests: [],
}

test('researchRounds: absent defaults to 2; an explicit value threads into the planner budgets instruction', async () => {
  const dflt = await runWorkflow(WORKFLOW, {
    args: planOnlyCfg(),
    agent: agentByLabel({ planner: LEAD_PLAN }),
  })
  assert.ok(callWithLabel(dflt.calls, 'planner').prompt.includes('research_rounds: 2'))

  const three = await runWorkflow(WORKFLOW, {
    args: planOnlyCfg({ researchRounds: 3 }),
    agent: agentByLabel({ planner: LEAD_PLAN }),
  })
  assert.ok(callWithLabel(three.calls, 'planner').prompt.includes('research_rounds: 3'))
})

test('researchRounds: zero or a non-number is rejected at config parse', async () => {
  await assert.rejects(
    runWorkflow(WORKFLOW, { args: planOnlyCfg({ researchRounds: 0 }), agent: agentByLabel({}) }),
    /config field "researchRounds" must be a number >= 1/
  )
  await assert.rejects(
    runWorkflow(WORKFLOW, { args: planOnlyCfg({ researchRounds: '2' }), agent: agentByLabel({}) }),
    /config field "researchRounds" must be a number >= 1/
  )
})

test('the retired feedback-synth stage is rejected at config parse as an unknown stage', async () => {
  const cfg = {
    slug: 'test-run',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    scripts: { state: '/plugin/scripts/state.mjs', worktree: '/plugin/scripts/ensure-worktree.sh' },
    seed: 42,
    confidenceMin: 70,
    planRounds: 3,
    codeRounds: 3,
    stages: ['feedback-synth'],
  }
  await assert.rejects(
    runWorkflow(WORKFLOW, { args: cfg, agent: agentByLabel({}) }),
    /unknown stage "feedback-synth" — canonical stages: plan, implement, pr/
  )
})
