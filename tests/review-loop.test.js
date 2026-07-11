import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  agentByLabel,
  callWithLabel,
  callsWithLabelPrefix,
  runWorkflow,
} from './helpers/workflow-harness.js'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/review-loop.js', import.meta.url))

const CONFIDENCE_MIN = 70

function rules(round) {
  return {
    a: [{ id: `A${round}`, source: 'CLAUDE.md', text: 'rule a' }],
    b: [{ id: `B${round}`, source: 'CLAUDE.md', text: 'rule b' }],
  }
}

function baseCfg(overrides = {}) {
  const maxRounds = overrides.maxRounds || 3
  return {
    slug: 'test-run',
    dir: '/state/runs/test-run',
    ask: '/plans/test-run.md',
    conventionsFile: '/plugin/conventions.md',
    repos: [{ name: 'alpha', root: '/repos/alpha' }],
    seed: 7,
    rulesByRound: Array.from({ length: maxRounds }, (_, i) => rules(i + 1)),
    confidenceMin: CONFIDENCE_MIN,
    roundFilePrefix: 'plan-round',
    ...overrides,
    maxRounds,
  }
}

function finding(id, severity = 'blocking') {
  return {
    id,
    key: `gap:${id}`,
    rule: null,
    severity,
    location: 'deliverables/D1-thing.md',
    what: `what-${id}`,
    why: `why-${id}`,
    evidence: `evidence-${id}`,
    confidence: 90,
    recommendation: `fix-${id}`,
  }
}

const NO_FINDINGS = { findings: [], rule_checklist: [{ rule: 'A1', verdict: 'pass', evidence: 'ok' }] }
const EMPTY_CONSOLIDATION = { new_confirmed_ids: [], duplicate_ids: [] }
const CONFIRMED = { verdict: 'confirmed', confidence: 95, evidence: 'real' }

test('round-1 convergence: zero findings from both reviewers → converged, one round, no reviser', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      'plan-review:a:r1': NO_FINDINGS,
      'plan-review:b:r1': NO_FINDINGS,
      'consolidate:r1': EMPTY_CONSOLIDATION,
    }),
  })
  assert.equal(result.converged, true)
  assert.equal(result.rounds, 1)
  assert.deepEqual(result.outstanding, [])
  assert.equal(callsWithLabelPrefix(calls, 'revise:').length, 0)
})

test('revise-then-converge: round 1 confirmed blocking finding, reviser fixes, round 2 clean', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      'plan-review:a:r1': { findings: [finding('f1')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'refute:r1-a-f1': CONFIRMED,
      'consolidate:r1': { new_confirmed_ids: ['r1-a-f1'], duplicate_ids: [] },
      'revise:r1': 'r1-a-f1 — fixed',
      'plan-review:a:r2': NO_FINDINGS,
      'plan-review:b:r2': NO_FINDINGS,
      'consolidate:r2': EMPTY_CONSOLIDATION,
    }),
  })
  assert.equal(result.converged, true)
  assert.equal(result.rounds, 2)
  assert.deepEqual(result.outstanding, [])
  assert.equal(callsWithLabelPrefix(calls, 'revise:').length, 1)
})

test('final-round confirmation pass: maxRounds 1, round 1 finds+fixes → ONE extra r1-confirm pass, converged', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ maxRounds: 1 }),
    agent: agentByLabel({
      'plan-review:a:r1': { findings: [finding('f1')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'refute:r1-a-f1': CONFIRMED,
      'consolidate:r1': { new_confirmed_ids: ['r1-a-f1'], duplicate_ids: [] },
      'revise:r1': 'r1-a-f1 — fixed',
      'plan-review:a:r1-confirm': NO_FINDINGS,
      'plan-review:b:r1-confirm': NO_FINDINGS,
      'consolidate:r1-confirm': EMPTY_CONSOLIDATION,
    }),
  })
  assert.equal(result.converged, true)
  assert.deepEqual(result.outstanding, [])
  // Exactly one extra review pass beyond the budgeted round, labeled r1-confirm.
  assert.equal(callsWithLabelPrefix(calls, 'plan-review:a:').length, 2)
  callWithLabel(calls, 'plan-review:a:r1-confirm')
  callWithLabel(calls, 'plan-review:b:r1-confirm')
})

test('confirmation pass surfaces a new confirmed finding → not converged, outstanding non-empty', async () => {
  const { result } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ maxRounds: 1 }),
    agent: agentByLabel({
      'plan-review:a:r1': { findings: [finding('f1')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'refute:r1-a-f1': CONFIRMED,
      'consolidate:r1': { new_confirmed_ids: ['r1-a-f1'], duplicate_ids: [] },
      'revise:r1': 'r1-a-f1 — fixed',
      'plan-review:a:r1-confirm': { findings: [finding('f2')], rule_checklist: [] },
      'plan-review:b:r1-confirm': NO_FINDINGS,
      'refute:r1-confirm-a-f2': CONFIRMED,
      'consolidate:r1-confirm': { new_confirmed_ids: ['r1-confirm-a-f2'], duplicate_ids: [] },
    }),
  })
  assert.equal(result.converged, false)
  assert.equal(result.outstanding.length, 1)
  assert.equal(result.outstanding[0].id, 'r1-confirm-a-f2')
})

test('refuted findings and confidence below confidenceMin are dropped → converged with no reviser call', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ maxRounds: 1 }),
    agent: agentByLabel({
      'plan-review:a:r1': { findings: [finding('f1'), finding('f2')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'refute:r1-a-f1': { verdict: 'refuted', confidence: 90, evidence: 'covered elsewhere' },
      'refute:r1-a-f2': { verdict: 'uncertain', confidence: CONFIDENCE_MIN - 1, evidence: 'shaky' },
      'consolidate:r1': EMPTY_CONSOLIDATION,
    }),
  })
  assert.equal(result.converged, true)
  assert.equal(result.rounds, 1)
  assert.equal(callsWithLabelPrefix(calls, 'revise:').length, 0)
  // Neither dropped finding reaches the consolidator's surviving set.
  const consolidate = callWithLabel(calls, 'consolidate:r1')
  assert.ok(!consolidate.prompt.includes('"r1-a-f1"'))
  assert.ok(!consolidate.prompt.includes('"r1-a-f2"'))
})

test('roundFilePrefix appears in the consolidator round-file path; suggestions never trigger revision', async () => {
  const cfg = baseCfg({ maxRounds: 1, roundFilePrefix: 'feedback-round' })
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'plan-review:a:r1': { findings: [finding('s1', 'suggestion')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'consolidate:r1': EMPTY_CONSOLIDATION,
    }),
  })
  const consolidate = callWithLabel(calls, 'consolidate:r1')
  assert.ok(consolidate.prompt.includes(`${cfg.dir}/reviews/feedback-round-1.md`))
  assert.equal(result.converged, true)
  // A suggestion is not gating: no refute pass, no reviser.
  assert.equal(callsWithLabelPrefix(calls, 'refute:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'revise:').length, 0)
})
