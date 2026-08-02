// runScenario against the REAL shipped deployable strapped-run.js, with every
// agent call answered by a scripted per-label fake spawn.
// Fully offline: the sandbox is real (temp dirs + git), the workflow is the
// real deployable, only the `claude` subprocess boundary is scripted.

import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { AGENT_LABEL_ENV, runScenario } from '../../src/eval/scenario/executor.ts'
import { removeSandbox } from '../../src/eval/scenario/sandbox.ts'
import type { Scenario, ScenarioOutcome } from '../../src/eval/scenario/types.ts'
import { errorEnvelope, scriptedSpawn, successEnvelope, type ScriptedHandler } from '../helpers/fake-claude.ts'

// --- canned agent outputs (top-level shape matches each label's forced schema) --

const NO_FINDINGS = {
  findings: [],
  rule_checklist: [{ rule: 'A1', verdict: 'pass', evidence: 'ok' }],
  ac_checklist: [],
}
const EMPTY_CONSOLIDATION = { new_confirmed_ids: [], duplicate_ids: [] }
const CONFIRMED = { verdict: 'confirmed', confidence: 95, evidence: 'real' }
const PLAN = {
  deliverables: [{ id: 'D1', file: 'deliverables/D1-thing.md', title: 'Thing', deps: [] }],
  summary: 'one deliverable covering the thing',
}
const IMPLEMENTED = { status: 'implemented', summary: 'built the thing', validations_green: true, blocker: null }
const PR_RESULT = {
  prs: [{ id: 'D1', url: null, skipped: true, reason: 'dry run' }],
  summary: 'dry run: 1 PR printed',
}

function finding(id: string) {
  return {
    id,
    key: `gap:${id}`,
    rule: null,
    severity: 'blocking',
    location: 'deliverables/D1-thing.md',
    what: `what-${id}`,
    why: `why-${id}`,
    evidence: `evidence-${id}`,
    confidence: 90,
    recommendation: `fix-${id}`,
  }
}

function waveItem(id: string) {
  return {
    id,
    repo: 'alpha',
    repoRoot: '/repos/alpha',
    validations: ['bun test'],
    planFile: `/state/runs/exec-test/deliverables/${id}-thing.md`,
    worktree: `/worktrees/exec-test/${id}`,
    branch: `strapped/exec-test/${id}-thing`,
    base: 'main',
    resumeNote: null,
    pr: null,
  }
}

/** Each label answered once with a canned success envelope (fixed cost/turns). */
function envelopes(outputs: Record<string, unknown>): Record<string, ScriptedHandler> {
  return Object.fromEntries(
    Object.entries(outputs).map(([label, output]) => [label, successEnvelope(output, { cost: 0.01, numTurns: 2 })])
  )
}

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'exec-test',
    tags: ['test'],
    stages: ['plan'],
    ask: 'Add a subtract function and a test for it.',
    repos: [{ name: 'alpha', files: { 'CLAUDE.md': '# fixture', 'README.md': 'fixture' }, validations: ['bun test'] }],
    rules: [
      { id: 'A1', source: 'CLAUDE.md', text: 'rule a' },
      { id: 'B1', source: 'CLAUDE.md', text: 'rule b' },
    ],
    seed: 7,
    planRounds: 2,
    codeRounds: 2,
    confidenceMin: 70,
    ...overrides,
  }
}

/** The mono-workflow RunResult surface these tests assert on. */
interface RunResultShape {
  slug: string
  stages: string[]
  completed: string[]
  stoppedAt: string | null
  results: Record<string, Record<string, unknown> | undefined>
}

async function runAndClean(
  scenario: Scenario,
  handlers: Record<string, ScriptedHandler>
): Promise<{ outcome: ScenarioOutcome; scripted: ReturnType<typeof scriptedSpawn> }> {
  const scripted = scriptedSpawn(handlers)
  const outcome = await runScenario(scenario, { spawn: scripted.spawn })
  removeSandbox(outcome.sandbox)
  return { outcome, scripted }
}

const FULL_CHAIN_HANDLERS = {
  planner: PLAN,
  'plan-review:a:r1': NO_FINDINGS,
  'plan-review:b:r1': NO_FINDINGS,
  'consolidate:r1': EMPTY_CONSOLIDATION,
  approve: { changed: true },
  'coordinate:1': { items: [waveItem('D1')], remaining: 1, blocked: [] },
  'implement:D1': IMPLEMENTED,
  'review:D1:a:r1': NO_FINDINGS,
  'review:D1:b:r1': NO_FINDINGS,
  'consolidate:D1:r1': EMPTY_CONSOLIDATION,
  'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
  'coordinate:2': { items: [], remaining: 0, blocked: [] },
  'pr-create': PR_RESULT,
}

test('full chain against the real deployable: RunResult shape, ledger entries, totals', async () => {
  const scenario = baseScenario({ stages: ['plan', 'implement', 'pr'] })
  const { outcome, scripted } = await runAndClean(scenario, envelopes(FULL_CHAIN_HANDLERS))

  assert.deepEqual(scripted.unexpected, [])
  assert.equal(outcome.error, null)
  const run = outcome.runResult as RunResultShape
  assert.equal(run.slug, 'exec-test')
  assert.deepEqual(run.stages, ['plan', 'implement', 'pr'])
  assert.deepEqual(run.completed, ['plan', 'implement', 'pr'])
  assert.equal(run.stoppedAt, null)
  assert.equal(run.results.plan?.converged, true)
  assert.deepEqual(run.results.plan?.deliverables, PLAN.deliverables)
  assert.equal(run.results.implement?.allDone, true)
  assert.deepEqual(run.results.pr?.prs, PR_RESULT.prs)

  // One ledger entry per agent call, metrics lifted from each envelope.
  const labelCount = Object.keys(FULL_CHAIN_HANDLERS).length
  assert.equal(outcome.ledger.length, labelCount)
  assert.equal(scripted.calls.length, labelCount)
  const planner = outcome.ledger[0]
  assert.ok(planner !== undefined)
  assert.equal(planner.label, 'planner')
  assert.equal(planner.ok, true)
  assert.equal(planner.cost, 0.01)
  assert.equal(planner.numTurns, 2)
  assert.equal(planner.durationMs, 1000)
  assert.equal(planner.apiDurationMs, 950)
  assert.equal(planner.model, 'claude-haiku-4-5')
  assert.ok(planner.prompt !== undefined && planner.prompt.length > 0)

  // Totals summed over the ledger.
  assert.ok(Math.abs(outcome.totals.costUsd - labelCount * 0.01) < 1e-9)
  assert.equal(outcome.totals.turns, labelCount * 2)
  assert.equal(outcome.totals.agentCalls, labelCount)
  assert.equal(outcome.totals.durationMs, labelCount * 1000)
  assert.equal(outcome.totals.apiDurationMs, labelCount * 950)
  assert.ok(outcome.wallClockMs >= 0)

  // The recorded phases include the dispatched stages, in order.
  const stagePhases = outcome.phases.filter(p => scenario.stages.includes(p))
  assert.deepEqual(stagePhases, ['plan', 'implement', 'pr'])
})

test('every agent spawn is sandbox-pinned: state-root env, cwd, add-dir, bypass permissions, tools', async () => {
  const { outcome, scripted } = await runAndClean(
    baseScenario({ stages: ['plan', 'implement', 'pr'] }),
    envelopes(FULL_CHAIN_HANDLERS)
  )
  assert.deepEqual(scripted.unexpected, [])
  assert.ok(scripted.calls.length > 0)
  for (const call of scripted.calls) {
    assert.equal(call.opts?.env?.STRAPPED_STATE_ROOT, outcome.sandbox.stateRoot, `label ${call.label}`)
    assert.equal(call.opts?.cwd, outcome.sandbox.root)
    assert.equal(call.opts?.timeoutMs, 20 * 60_000)
    assert.deepEqual(call.args.slice(call.args.indexOf('--add-dir'), call.args.indexOf('--add-dir') + 2), [
      '--add-dir',
      outcome.sandbox.root,
    ])
    assert.deepEqual(
      call.args.slice(call.args.indexOf('--permission-mode'), call.args.indexOf('--permission-mode') + 2),
      ['--permission-mode', 'bypassPermissions']
    )
    assert.deepEqual(call.args.slice(call.args.indexOf('--allowedTools'), call.args.indexOf('--allowedTools') + 2), [
      '--allowedTools',
      'Bash Read Write Edit Glob Grep TodoWrite',
    ])
    // Default system prompt kept for fidelity — never overridden.
    assert.ok(!call.args.includes('--system-prompt'))
  }
})

test('stage subset: stages ["plan"] dispatches only the plan stage', async () => {
  const { outcome, scripted } = await runAndClean(
    baseScenario(),
    envelopes({
      planner: PLAN,
      'plan-review:a:r1': NO_FINDINGS,
      'plan-review:b:r1': NO_FINDINGS,
      'consolidate:r1': EMPTY_CONSOLIDATION,
    })
  )
  assert.deepEqual(scripted.unexpected, [])
  assert.equal(outcome.error, null)
  const run = outcome.runResult as RunResultShape
  assert.deepEqual(run.completed, ['plan'])
  assert.equal(run.stoppedAt, null)
  const labels = outcome.ledger.map(e => e.label)
  assert.ok(!labels.some(l => l.startsWith('coordinate') || l.startsWith('pr-')))
  assert.ok(!labels.includes('approve'), 'singleton plan never dispatches approve')
})

test('pr always runs dry: the scenario spec cannot unset dryRun', async () => {
  const { outcome, scripted } = await runAndClean(
    baseScenario({ stages: ['plan', 'implement', 'pr'] }),
    envelopes(FULL_CHAIN_HANDLERS)
  )
  const run = outcome.runResult as RunResultShape
  assert.equal(run.results.pr?.dryRun, true)
  const prCall = scripted.calls.find(c => c.label === 'pr-create')
  assert.ok(prCall !== undefined)
  assert.ok(prCall.input?.includes('DRY RUN'))
  assert.ok(prCall.input?.includes('print-only'))
  // The Scenario type itself admits no pr stage args — only implement passes through.
})

test('a failed agent returns null into the workflow and still lands in the ledger', async () => {
  // Mirrors the harness's plan-non-convergence contract: the reviser fails
  // (error envelope → engine ok:false → null), so the review loop stops
  // non-converged and the dispatch halts at plan.
  const scenario = baseScenario({ planRounds: 3, codeRounds: 1 })
  const { outcome, scripted } = await runAndClean(scenario, {
    ...envelopes({
      planner: PLAN,
      'plan-review:a:r1': { findings: [finding('f1')], rule_checklist: [], ac_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'refute:r1-a-f1': CONFIRMED,
      'consolidate:r1': { new_confirmed_ids: ['r1-a-f1'], duplicate_ids: [] },
    }),
    'revise:r1': errorEnvelope('error_during_execution'),
  })
  assert.deepEqual(scripted.unexpected, [])
  assert.equal(outcome.error, null) // the workflow handled the null itself
  const run = outcome.runResult as RunResultShape
  assert.equal(run.stoppedAt, 'plan')
  assert.equal(run.results.plan?.converged, false)

  const revise = outcome.ledger.find(e => e.label === 'revise:r1')
  assert.ok(revise !== undefined)
  assert.equal(revise.ok, false)
  assert.match(revise.error ?? '', /error_during_execution/)
  assert.equal(revise.cost, 0.002) // failed calls still cost money and are counted
  const expected = outcome.ledger.reduce((sum, e) => sum + e.cost, 0)
  assert.ok(Math.abs(outcome.totals.costUsd - expected) < 1e-9)
})

test('a workflow throw is captured on the outcome, not propagated', async () => {
  const { outcome, scripted } = await runAndClean(baseScenario({ stages: ['bogus'] }), {})
  assert.match(outcome.error ?? '', /unknown stage "bogus"/)
  assert.equal(outcome.runResult, null)
  assert.deepEqual(outcome.ledger, [])
  assert.deepEqual(scripted.calls, [])
  assert.ok(outcome.sandbox.root.length > 0) // paths still returned for grading/cleanup
})

test('codeRounds > planRounds: rulesByRound covers every code-review round', async () => {
  // planRounds 1, codeRounds 2, and the code review actually reaches round 2.
  // If the executor sized rulesByRound by planRounds alone, round 2's lookup
  // would throw "rulesByRound has no entry for round 2".
  const scenario = baseScenario({ stages: ['implement'], planRounds: 1, codeRounds: 2 })
  const { outcome, scripted } = await runAndClean(
    scenario,
    envelopes({
      'coordinate:1': { items: [waveItem('D1')], remaining: 1, blocked: [] },
      'implement:D1': IMPLEMENTED,
      'review:D1:a:r1': { findings: [finding('f1')], rule_checklist: [], ac_checklist: [] },
      'review:D1:b:r1': NO_FINDINGS,
      'refute:D1:r1-a-f1': CONFIRMED,
      'consolidate:D1:r1': { new_confirmed_ids: ['r1-a-f1'], duplicate_ids: [] },
      'fix:D1:r1': IMPLEMENTED,
      'review:D1:a:r2': NO_FINDINGS,
      'review:D1:b:r2': NO_FINDINGS,
      'consolidate:D1:r2': EMPTY_CONSOLIDATION,
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': { items: [], remaining: 0, blocked: [] },
    })
  )
  assert.deepEqual(scripted.unexpected, [])
  assert.equal(outcome.error, null)
  const run = outcome.runResult as RunResultShape
  assert.equal(run.results.implement?.allDone, true)
  assert.equal(run.stoppedAt, null)
})

test('modelByLabel overrides the scenario model per agent label', async () => {
  const { outcome, scripted } = await runAndClean(
    baseScenario({ model: 'claude-sonnet-5', modelByLabel: { planner: 'claude-opus-4-8' } }),
    envelopes({
      planner: PLAN,
      'plan-review:a:r1': NO_FINDINGS,
      'plan-review:b:r1': NO_FINDINGS,
      'consolidate:r1': EMPTY_CONSOLIDATION,
    })
  )
  assert.deepEqual(scripted.unexpected, [])
  const plannerCall = scripted.calls.find(c => c.label === 'planner')
  const reviewCall = scripted.calls.find(c => c.label === 'plan-review:a:r1')
  assert.ok(plannerCall !== undefined && reviewCall !== undefined)
  assert.deepEqual(plannerCall.args.slice(plannerCall.args.indexOf('--model'), plannerCall.args.indexOf('--model') + 2), [
    '--model',
    'claude-opus-4-8',
  ])
  assert.deepEqual(reviewCall.args.slice(reviewCall.args.indexOf('--model'), reviewCall.args.indexOf('--model') + 2), [
    '--model',
    'claude-sonnet-5',
  ])
  assert.equal(outcome.ledger.find(e => e.label === 'planner')?.model, 'claude-opus-4-8')
})

test('the agent label travels on the spawn env for scripted dispatch', async () => {
  const { scripted } = await runAndClean(
    baseScenario(),
    envelopes({
      planner: PLAN,
      'plan-review:a:r1': NO_FINDINGS,
      'plan-review:b:r1': NO_FINDINGS,
      'consolidate:r1': EMPTY_CONSOLIDATION,
    })
  )
  const labels = scripted.calls.map(c => c.opts?.env?.[AGENT_LABEL_ENV])
  assert.deepEqual(labels, ['planner', 'plan-review:a:r1', 'plan-review:b:r1', 'consolidate:r1'])
})
