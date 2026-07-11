import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentByLabel, callWithLabel, runWorkflow } from './helpers/workflow-harness.js'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/implement-wave.js', import.meta.url))

const ITEM = {
  id: 'D1',
  repo: 'alpha',
  repoRoot: '/repos/alpha',
  worktree: '/worktrees/test-run/D1',
  branch: 'strapped/test-run/D1-thing',
  base: 'main',
  planFile: '/state/runs/test-run/deliverables/D1-thing.md',
  validations: ['npm test'],
}

function baseCfg(overrides = {}) {
  const codeRounds = overrides.codeRounds || 2
  return {
    slug: 'test-run',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    seed: 7,
    rulesByRound: Array.from({ length: codeRounds }, (_, i) => ({
      a: [{ id: `A${i + 1}`, source: 'CLAUDE.md', text: 'rule a' }],
      b: [{ id: `B${i + 1}`, source: 'CLAUDE.md', text: 'rule b' }],
    })),
    confidenceMin: 70,
    codeReviewScript: '/plugin/workflows/code-review.js',
    items: [ITEM],
    ...overrides,
    codeRounds,
  }
}

const IMPLEMENTED = { status: 'implemented', summary: 'built the thing', validations_green: true, blocker: null }

function confirmedFinding(id) {
  return {
    id,
    key: `gap:${id}`,
    severity: 'blocking',
    location: 'src/thing.js',
    what: `what-${id}`,
    recommendation: `fix-${id}`,
  }
}

/** Workflow stub answering each code-review call by its round ('1', '2', '1-confirm', ...). */
function reviewByRound(byRound) {
  return (ref, wfArgs) => {
    const round = String(wfArgs.round)
    if (!(round in byRound)) throw new Error(`unexpected code-review round: ${round}`)
    return byRound[round]
  }
}

test('implementer returns blocked → outcome parked with the blocker as parkedReason', async () => {
  const { result } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      'implement:D1': { status: 'blocked', summary: 'partial', validations_green: false, blocker: 'missing dependency X' },
    }),
  })
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'D1')
  assert.equal(result[0].outcome, 'parked')
  assert.equal(result[0].parkedReason, 'missing dependency X')
})

test('implement ok + converged review round 1 → outcome done, roundsUsed 1', async () => {
  const cfg = baseCfg()
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({ 'implement:D1': IMPLEMENTED }),
    workflow: reviewByRound({ 1: { converged: true, newConfirmed: [], suggestions: [] } }),
  })
  assert.equal(result[0].outcome, 'done')
  assert.equal(result[0].roundsUsed, 1)
  assert.equal(result[0].summary, 'built the thing')
  // Review is dispatched via the explicit scriptPath, never the bare name.
  const wf = calls.filter(c => c.kind === 'workflow')
  assert.equal(wf.length, 1)
  assert.deepEqual(wf[0].ref, { scriptPath: cfg.codeReviewScript })
})

test('fix loop: round 1 findings fixed, round 2 converged → done, roundsUsed 2, fix prompt names round record', async () => {
  const cfg = baseCfg()
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'implement:D1': IMPLEMENTED,
      'fix:D1:r1': IMPLEMENTED,
    }),
    workflow: reviewByRound({
      1: { converged: false, newConfirmed: [confirmedFinding('a-f1')], suggestions: [] },
      2: { converged: true, newConfirmed: [], suggestions: [] },
    }),
  })
  assert.equal(result[0].outcome, 'done')
  assert.equal(result[0].roundsUsed, 2)
  const fix = callWithLabel(calls, 'fix:D1:r1')
  assert.ok(fix.prompt.includes(`${cfg.dir}/reviews/D1-code-round-1.md`))
})

test('recordSuffix threads into the code-review workflow args and the fix prompt read path', async () => {
  const cfg = baseCfg({ recordSuffix: '-feedback' })
  const { calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'implement:D1': IMPLEMENTED,
      'fix:D1:r1': IMPLEMENTED,
    }),
    workflow: reviewByRound({
      1: { converged: false, newConfirmed: [confirmedFinding('a-f1')], suggestions: [] },
      2: { converged: true, newConfirmed: [], suggestions: [] },
    }),
  })
  for (const wf of calls.filter(c => c.kind === 'workflow')) {
    assert.equal(wf.args.recordSuffix, '-feedback')
  }
  const fix = callWithLabel(calls, 'fix:D1:r1')
  assert.ok(fix.prompt.includes(`${cfg.dir}/reviews/D1-code-round-1-feedback.md`))
})

test('addendumMode: implement prompt targets the Feedback addendum, not the from-scratch preamble', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ addendumMode: true }),
    agent: agentByLabel({ 'implement:D1': IMPLEMENTED }),
    workflow: reviewByRound({ 1: { converged: true, newConfirmed: [], suggestions: [] } }),
  })
  const implement = callWithLabel(calls, 'implement:D1')
  assert.ok(implement.prompt.includes('Feedback addendum'))
  assert.ok(!implement.prompt.includes('You are the implementation agent'))
  assert.equal(result[0].outcome, 'done')
})

test('confirmation mirror: codeRounds 1, round 1 fixed-all, confirm converged → done', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ codeRounds: 1 }),
    agent: agentByLabel({
      'implement:D1': IMPLEMENTED,
      'fix:D1:r1': IMPLEMENTED,
    }),
    workflow: reviewByRound({
      1: { converged: false, newConfirmed: [confirmedFinding('a-f1')], suggestions: [] },
      '1-confirm': { converged: true, newConfirmed: [], suggestions: [] },
    }),
  })
  const rounds = calls.filter(c => c.kind === 'workflow').map(c => String(c.args.round))
  assert.deepEqual(rounds, ['1', '1-confirm'])
  assert.equal(result[0].outcome, 'done')
  assert.equal(result[0].roundsUsed, 1)
})

test('confirmation mirror: confirm pass non-converged → parked with a confirmation-pass reason', async () => {
  const { result } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ codeRounds: 1 }),
    agent: agentByLabel({
      'implement:D1': IMPLEMENTED,
      'fix:D1:r1': IMPLEMENTED,
    }),
    workflow: reviewByRound({
      1: { converged: false, newConfirmed: [confirmedFinding('a-f1')], suggestions: [] },
      '1-confirm': { converged: false, newConfirmed: [confirmedFinding('a-f2')], suggestions: [] },
    }),
  })
  assert.equal(result[0].outcome, 'parked')
  assert.ok(result[0].parkedReason.includes('confirmation pass'))
  assert.ok(result[0].parkedReason.includes('gap:a-f2'))
})
