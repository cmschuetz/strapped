import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentByLabel, runWorkflow } from './helpers/workflow-harness.js'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/feedback-synth.js', import.meta.url))

function baseCfg(overrides = {}) {
  return {
    slug: 'test-run',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    comments: [
      {
        deliverableId: 'D1',
        pr: 'https://github.com/o/r/pull/1',
        lineComments: [{ path: 'src/thing.js', line: 3, body: 'rename this' }],
        reviewBodies: [{ state: 'CHANGES_REQUESTED', body: 'needs a test' }],
        issueComments: [],
      },
    ],
    repos: [{ name: 'alpha', root: '/repos/alpha' }],
    seed: 7,
    maxRounds: 3,
    rulesByRound: [{ a: [{ id: 'A1', source: 'CLAUDE.md', text: 'rule a' }], b: [{ id: 'B1', source: 'CLAUDE.md', text: 'rule b' }] }],
    confidenceMin: 60,
    reviewLoopScript: '/plugin/workflows/review-loop.js',
    ...overrides,
  }
}

const SYNTH = {
  addenda: [
    { deliverableId: 'D1', sourcePr: 'https://github.com/o/r/pull/1', crossDeliverable: false, tasks: ['rename thing', 'add the missing test'] },
  ],
  summary: 'two fixes on D1',
}

const CONVERGED_REVIEW = { converged: true, rounds: 1, outstanding: [] }

test('synthesis + converged review → result carries addenda/converged/rounds/summary', async () => {
  const { result } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({ 'feedback-synth': SYNTH }),
    workflow: () => CONVERGED_REVIEW,
  })
  assert.deepEqual(result.addenda, SYNTH.addenda)
  assert.equal(result.converged, true)
  assert.equal(result.rounds, 1)
  assert.equal(result.summary, SYNTH.summary)
  assert.deepEqual(result.outstanding, [])
})

test('review loop is invoked via { scriptPath } with feedback-round prefix and an addendum-scoped reviser prompt', async () => {
  const cfg = baseCfg()
  const { calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({ 'feedback-synth': SYNTH }),
    workflow: () => CONVERGED_REVIEW,
  })
  const wf = calls.filter(c => c.kind === 'workflow')
  assert.equal(wf.length, 1)
  // Never the bare 'strapped-plan-loop' name — that would re-run the planner and clobber the addenda.
  assert.deepEqual(wf[0].ref, { scriptPath: cfg.reviewLoopScript })
  assert.equal(wf[0].args.roundFilePrefix, 'feedback-round')
  assert.ok(wf[0].args.reviserPrompt.includes('Feedback addendum'))
})
