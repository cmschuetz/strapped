import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentByLabel, callsWithLabelPrefix, runWorkflow } from './helpers/workflow-harness.js'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/code-review.js', import.meta.url))

function baseCfg(overrides = {}) {
  return {
    slug: 'test-run',
    deliverableId: 'D1',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    worktree: '/worktrees/test-run/D1',
    repo: 'alpha',
    repoRoot: '/repos/alpha',
    validations: ['npm test'],
    branch: 'strapped/test-run/D1-thing',
    base: 'main',
    planFile: '/state/runs/test-run/deliverables/D1-thing.md',
    round: 1,
    seedUsed: 8,
    rules: {
      a: [{ id: 'A1', source: 'CLAUDE.md', text: 'rule a' }],
      b: [{ id: 'B1', source: 'CLAUDE.md', text: 'rule b' }],
    },
    confidenceMin: 70,
    seenDigest: '',
    ...overrides,
  }
}

function finding(id, severity = 'blocking') {
  return {
    id,
    key: `gap:${id}`,
    rule: null,
    severity,
    location: 'src/thing.js',
    what: `what-${id}`,
    why: `why-${id}`,
    evidence: `evidence-${id}`,
    confidence: 90,
    recommendation: `fix-${id}`,
  }
}

const NO_FINDINGS = { findings: [], rule_checklist: [{ rule: 'A1', verdict: 'pass', evidence: 'ok' }] }
const EMPTY_CONSOLIDATION = { new_confirmed_ids: [], duplicate_ids: [] }

test('zero surviving findings → converged, empty newConfirmed, default round-file name', async () => {
  const cfg = baseCfg()
  const { result } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'review:D1:a': NO_FINDINGS,
      'review:D1:b': NO_FINDINGS,
      'consolidate:D1:r1': EMPTY_CONSOLIDATION,
    }),
  })
  assert.equal(result.converged, true)
  assert.deepEqual(result.newConfirmed, [])
  assert.equal(result.roundFile, `${cfg.dir}/reviews/D1-code-round-1.md`)
})

test("recordSuffix '-feedback' → roundFile ends -code-round-<round>-feedback.md", async () => {
  const cfg = baseCfg({ recordSuffix: '-feedback' })
  const { result } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'review:D1:a': NO_FINDINGS,
      'review:D1:b': NO_FINDINGS,
      'consolidate:D1:r1': EMPTY_CONSOLIDATION,
    }),
  })
  assert.equal(result.roundFile, `${cfg.dir}/reviews/D1-code-round-1-feedback.md`)
})

test('suggestions are returned but excluded from gating: no refute call for a suggestion-only review', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      'review:D1:a': { findings: [finding('s1', 'suggestion')], rule_checklist: [] },
      'review:D1:b': NO_FINDINGS,
      'consolidate:D1:r1': EMPTY_CONSOLIDATION,
    }),
  })
  assert.equal(callsWithLabelPrefix(calls, 'refute:').length, 0)
  assert.equal(result.converged, true)
  assert.equal(result.suggestions.length, 1)
  assert.equal(result.suggestions[0].id, 'a-s1')
  assert.deepEqual(result.newConfirmed, [])
})

test('a confirmed blocking finding → not converged, present in newConfirmed', async () => {
  const { result } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      'review:D1:a': { findings: [finding('f1')], rule_checklist: [] },
      'review:D1:b': NO_FINDINGS,
      'refute:a-f1': { verdict: 'confirmed', confidence: 95, evidence: 'real' },
      'consolidate:D1:r1': { new_confirmed_ids: ['a-f1'], duplicate_ids: [] },
    }),
  })
  assert.equal(result.converged, false)
  assert.equal(result.newConfirmed.length, 1)
  assert.equal(result.newConfirmed[0].id, 'a-f1')
  assert.equal(result.newConfirmed[0].key, 'gap:f1')
})
