import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentByLabel, runWorkflow } from './helpers/workflow-harness.js'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/plan-loop.js', import.meta.url))

const RULES_BY_ROUND = [
  { a: [{ id: 'A1', source: 'CLAUDE.md', text: 'rule a1' }], b: [{ id: 'B1', source: 'CLAUDE.md', text: 'rule b1' }] },
]

function baseCfg(overrides = {}) {
  return {
    slug: 'test-run',
    sourcePlan: '/plans/test-run.md',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    repos: [{ name: 'alpha', root: '/repos/alpha' }],
    seed: 7,
    maxRounds: 3,
    rulesByRound: RULES_BY_ROUND,
    confidenceMin: 60,
    reviewLoopScript: '/plugin/workflows/review-loop.js',
    ...overrides,
  }
}

const PLAN = {
  deliverables: [{ id: 'D1', file: 'deliverables/D1-thing.md', title: 'Thing', deps: [] }],
  summary: 'one deliverable covering the thing',
}

const CONVERGED_REVIEW = { converged: true, rounds: 1, outstanding: [] }

test('planner + converged review loop → result carries slug/converged/rounds/deliverables/outstanding/summary', async () => {
  const { result } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({ planner: PLAN }),
    workflow: () => CONVERGED_REVIEW,
  })
  assert.deepEqual(result, {
    slug: 'test-run',
    converged: true,
    rounds: 1,
    deliverables: PLAN.deliverables,
    outstanding: [],
    summary: PLAN.summary,
  })
})

test('review loop is invoked via { scriptPath } with plan-round prefix, rules, seed, and repos', async () => {
  const cfg = baseCfg()
  const { calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({ planner: PLAN }),
    workflow: () => CONVERGED_REVIEW,
  })
  const wf = calls.filter(c => c.kind === 'workflow')
  assert.equal(wf.length, 1)
  assert.deepEqual(wf[0].ref, { scriptPath: cfg.reviewLoopScript })
  assert.equal(wf[0].args.roundFilePrefix, 'plan-round')
  assert.deepEqual(wf[0].args.rulesByRound, RULES_BY_ROUND)
  assert.equal(wf[0].args.seed, 7)
  assert.deepEqual(wf[0].args.repos, cfg.repos)
})

test('planner agent returning null → rejects with "planner agent failed"', async () => {
  await assert.rejects(
    runWorkflow(WORKFLOW, {
      args: baseCfg(),
      agent: agentByLabel({ planner: () => null }),
      workflow: () => CONVERGED_REVIEW,
    }),
    /planner agent failed/
  )
})

test('review-loop workflow returning null → rejects with "review-loop workflow failed"', async () => {
  await assert.rejects(
    runWorkflow(WORKFLOW, {
      args: baseCfg(),
      agent: agentByLabel({ planner: PLAN }),
      workflow: () => null,
    }),
    /review-loop workflow failed/
  )
})

test('repos fallback: with only repoRoot set, planner prompt lists the derived repo name', async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ repos: undefined, repoRoot: '/home/user/projects/demo-repo' }),
    agent: agentByLabel({ planner: PLAN }),
    workflow: () => CONVERGED_REVIEW,
  })
  const planner = calls.find(c => c.kind === 'agent' && c.opts.label === 'planner')
  assert.ok(planner.prompt.includes('- demo-repo → /home/user/projects/demo-repo'))
})
