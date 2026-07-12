// Consolidated tests for the strapped-run mono-workflow: stage validation,
// the DI'd dispatch loop with gate semantics, and the transplanted stage
// machinery (plan + review loop, implement wave loop + code review, pr,
// feedback-synth). Replaces the retired per-workflow test files.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  agentByLabel,
  callWithLabel,
  callsWithLabelPrefix,
  runWorkflow,
} from './helpers/workflow-harness.js'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/strapped-run.js', import.meta.url))

const REPOS = [{ name: 'alpha', root: '/repos/alpha' }]

const RULES = {
  a: [{ id: 'A1', source: 'CLAUDE.md', text: 'rule a' }],
  b: [{ id: 'B1', source: 'CLAUDE.md', text: 'rule b' }],
}

function baseCfg(overrides = {}) {
  return {
    slug: 'test-run',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    scripts: { state: '/plugin/scripts/state.mjs', worktree: '/plugin/scripts/ensure-worktree.sh' },
    seed: 7,
    confidenceMin: 70,
    planRounds: 3,
    codeRounds: 2,
    rulesByRound: [RULES, RULES, RULES],
    stages: ['plan'],
    stageArgs: { plan: { sourcePlan: '/plans/test-run.md', repos: REPOS } },
    ...overrides,
  }
}

const NO_FINDINGS = { findings: [], rule_checklist: [{ rule: 'A1', verdict: 'pass', evidence: 'ok' }] }
const EMPTY_CONSOLIDATION = { new_confirmed_ids: [], duplicate_ids: [] }
const CONFIRMED = { verdict: 'confirmed', confidence: 95, evidence: 'real' }

const PLAN = {
  deliverables: [{ id: 'D1', file: 'deliverables/D1-thing.md', title: 'Thing', deps: [] }],
  summary: 'one deliverable covering the thing',
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

/** Agent stubs for a plan stage that converges in review round 1. */
function planConverges() {
  return {
    planner: PLAN,
    'plan-review:a:r1': NO_FINDINGS,
    'plan-review:b:r1': NO_FINDINGS,
    'consolidate:r1': EMPTY_CONSOLIDATION,
  }
}

function item(id, pr = null) {
  return {
    id,
    repo: 'alpha',
    repoRoot: '/repos/alpha',
    validations: ['npm test'],
    planFile: `/state/runs/test-run/deliverables/${id}-thing.md`,
    worktree: `/worktrees/test-run/${id}`,
    branch: `strapped/test-run/${id}-thing`,
    base: 'main',
    resumeNote: null,
    pr,
  }
}

const IMPLEMENTED = { status: 'implemented', summary: 'built the thing', validations_green: true, blocker: null }
const BLOCKED = { status: 'blocked', summary: 'partial', validations_green: false, blocker: 'missing dependency X' }

/** Agent stubs for one node implementing cleanly and converging in code-review round 1. */
function nodeConverges(id) {
  return {
    [`implement:${id}`]: IMPLEMENTED,
    [`review:${id}:a:r1`]: NO_FINDINGS,
    [`review:${id}:b:r1`]: NO_FINDINGS,
    [`consolidate:${id}:r1`]: EMPTY_CONSOLIDATION,
  }
}

const PR_RESULT = {
  prs: [
    { id: 'D1', url: 'https://github.com/o/r/pull/1', skipped: false, reason: null },
    { id: 'D2', url: null, skipped: true, reason: 'branch has no commits beyond base' },
  ],
  summary: 'opened 1 PR, skipped 1',
}

// --- AC1: stage validation + zero workflow() calls ---------------------------

test('stage validation: unknown / out-of-order / duplicate / empty stages throw', async () => {
  await assert.rejects(runWorkflow(WORKFLOW, { args: baseCfg({ stages: [] }) }), /non-empty ordered subset/)
  await assert.rejects(runWorkflow(WORKFLOW, { args: baseCfg({ stages: ['plan', 'bogus'] }) }), /unknown stage "bogus"/)
  await assert.rejects(runWorkflow(WORKFLOW, { args: baseCfg({ stages: ['implement', 'plan'] }) }), /out of canonical order/)
  await assert.rejects(runWorkflow(WORKFLOW, { args: baseCfg({ stages: ['plan', 'plan'] }) }), /duplicate stage "plan"/)
})

test('the mono-workflow source makes zero workflow() calls', () => {
  const src = readFileSync(WORKFLOW, 'utf8')
  // `workflow()` in prose is fine; an actual dispatch would pass arguments.
  assert.equal(src.match(/\bworkflow\((?!\))/), null)
})

// --- AC1 + AC2: dispatch loop, approve gating -------------------------------

test('full chain [plan, implement, pr]: stage order, approve exactly once between plan and implement, completed all, stoppedAt null', async () => {
  const cfg = baseCfg({
    stages: ['plan', 'implement', 'pr'],
    stageArgs: {
      plan: { sourcePlan: '/plans/test-run.md', repos: REPOS },
      pr: { dryRun: false },
    },
  })
  const { result, calls, phases } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      ...planConverges(),
      approve: { changed: true },
      'coordinate:1': { items: [item('D1')], remaining: 1, blocked: [] },
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': { items: [], remaining: 0, blocked: [] },
      'pr-create': PR_RESULT,
    }),
  })

  assert.deepEqual(result.completed, ['plan', 'implement', 'pr'])
  assert.equal(result.stoppedAt, null)
  assert.equal(result.slug, 'test-run')
  assert.deepEqual(result.stages, cfg.stages)
  assert.equal(result.results.plan.converged, true)
  assert.deepEqual(result.results.plan.deliverables, PLAN.deliverables)
  assert.equal(result.results.implement.allDone, true)
  assert.deepEqual(result.results.pr.prs, PR_RESULT.prs)

  // Stage phases in dispatch order.
  const stagePhases = phases.filter(p => cfg.stages.includes(p))
  assert.deepEqual(stagePhases, ['plan', 'implement', 'pr'])

  // Approve fires exactly once, after plan review converges and before the
  // first implement coordinator pass.
  assert.equal(callsWithLabelPrefix(calls, 'approve').length, 1)
  const approveIdx = calls.indexOf(callWithLabel(calls, 'approve'))
  const coordinateIdx = calls.indexOf(callWithLabel(calls, 'coordinate:1'))
  assert.ok(approveIdx < coordinateIdx, 'approve must precede the implement stage')
  const approve = callWithLabel(calls, 'approve')
  assert.ok(approve.prompt.includes(`manifest-status ${cfg.dir} approved`))

  // Implement ran, so pr never probes the dag itself.
  assert.equal(callsWithLabelPrefix(calls, 'pr-gate').length, 0)
})

test('singleton ["plan"]: converges with NO approve agent dispatched', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel(planConverges()),
  })
  assert.equal(result.results.plan.converged, true)
  assert.deepEqual(result.completed, ['plan'])
  assert.equal(result.stoppedAt, null)
  assert.equal(callsWithLabelPrefix(calls, 'approve').length, 0)
})

test('plan non-convergence → stoppedAt plan, no approve, no later stages', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({
      stages: ['plan', 'implement', 'pr'],
      stageArgs: { plan: { sourcePlan: '/plans/test-run.md', repos: REPOS }, pr: {} },
    }),
    agent: agentByLabel({
      planner: PLAN,
      'plan-review:a:r1': { findings: [finding('f1')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'refute:r1-a-f1': CONFIRMED,
      'consolidate:r1': { new_confirmed_ids: ['r1-a-f1'], duplicate_ids: [] },
      'revise:r1': () => null, // reviser fails → loop stops non-converged
    }),
  })
  assert.equal(result.stoppedAt, 'plan')
  assert.deepEqual(result.completed, [])
  assert.equal(result.results.plan.converged, false)
  assert.equal(result.results.plan.outstanding.length, 1)
  assert.equal(result.results.plan.outstanding[0].id, 'r1-a-f1')
  assert.equal(callsWithLabelPrefix(calls, 'approve').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'coordinate:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'pr-').length, 0)
})

test('null refuter result → finding handled as vote-not-cast, loop completes without crash', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      planner: PLAN,
      'plan-review:a:r1': { findings: [finding('f1')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'refute:r1-a-f1': () => null,
      'consolidate:r1': EMPTY_CONSOLIDATION,
    }),
  })
  assert.equal(result.results.plan.converged, true)
  assert.equal(result.stoppedAt, null)
  // The vote-not-cast finding never reaches the consolidator's surviving set.
  const consolidate = callWithLabel(calls, 'consolidate:r1')
  assert.ok(!consolidate.prompt.includes('"r1-a-f1"'))
})

// --- AC3: implement stage -----------------------------------------------------

test('implement: two waves then allDone; manifest-status implementing in first coordinator prompt only', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': { items: [item('D1')], remaining: 2, blocked: [{ id: 'D2', blockedOn: ['D1'] }] },
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': { items: [item('D2')], remaining: 1, blocked: [] },
      ...nodeConverges('D2'),
      'apply:2': { applied: [{ id: 'D2', status: 'done' }] },
      'coordinate:3': { items: [], remaining: 0, blocked: [] },
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  assert.equal(result.stoppedAt, null)
  assert.deepEqual(
    result.results.implement.outcomes.map(o => ({ id: o.id, outcome: o.outcome })),
    [{ id: 'D1', outcome: 'done' }, { id: 'D2', outcome: 'done' }]
  )
  const flip = `manifest-status ${baseCfg().dir} implementing`
  assert.ok(callWithLabel(calls, 'coordinate:1').prompt.includes(flip))
  assert.ok(!callWithLabel(calls, 'coordinate:2').prompt.includes(flip))
  assert.ok(!callWithLabel(calls, 'coordinate:3').prompt.includes(flip))
})

test('implement: node already pr-open at entry → allDone true with no implementer dispatched', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': { items: [], remaining: 0, blocked: [] },
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  assert.deepEqual(result.results.implement.outcomes, [])
  assert.equal(result.stoppedAt, null)
  assert.equal(callsWithLabelPrefix(calls, 'implement:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'apply:').length, 0)
})

test('implement: parked node blocks children → stoppedAt implement, no pr stage', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement', 'pr'], stageArgs: { pr: {} } }),
    agent: agentByLabel({
      'coordinate:1': { items: [item('D1')], remaining: 2, blocked: [{ id: 'D2', blockedOn: ['D1'] }] },
      'implement:D1': BLOCKED,
      'apply:1': { applied: [{ id: 'D1', status: 'parked' }] },
    }),
  })
  assert.equal(result.stoppedAt, 'implement')
  assert.deepEqual(result.completed, [])
  assert.equal(result.results.implement.allDone, false)
  assert.equal(result.results.implement.outcomes[0].outcome, 'parked')
  assert.equal(result.results.implement.outcomes[0].parkedReason, 'missing dependency X')
  assert.deepEqual(result.results.implement.blocked, [{ id: 'D2', blockedOn: ['D1'] }])
  assert.equal(callsWithLabelPrefix(calls, 'pr-gate').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'pr-create').length, 0)
})

test('implement: zero-progress wave terminates the loop', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': { items: [item('D1')], remaining: 3, blocked: [] },
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': { items: [item('D2')], remaining: 2, blocked: [] },
      'implement:D2': BLOCKED,
      'apply:2': { applied: [{ id: 'D2', status: 'parked' }] },
      // No coordinate:3 handler: dispatching it would throw. Zero newly-done
      // progress on pass 2 must terminate the loop instead.
    }),
  })
  assert.equal(result.results.implement.allDone, false)
  assert.equal(result.stoppedAt, 'implement')
  assert.equal(callsWithLabelPrefix(calls, 'coordinate:').length, 2)
})

test('addendumMode + recordSuffix thread through to the review-record path and feedback_rounds_used', async () => {
  const cfg = baseCfg({
    stages: ['implement'],
    stageArgs: { implement: { addendumMode: true, recordSuffix: '-feedback' } },
  })
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'coordinate:1': { items: [item('D1')], remaining: 1, blocked: [] },
      'implement:D1': IMPLEMENTED,
      'review:D1:a:r1': { findings: [finding('f1')], rule_checklist: [] },
      'review:D1:b:r1': NO_FINDINGS,
      'refute:D1:r1-a-f1': CONFIRMED,
      'consolidate:D1:r1': { new_confirmed_ids: ['r1-a-f1'], duplicate_ids: [] },
      'fix:D1:r1': IMPLEMENTED,
      'review:D1:a:r2': NO_FINDINGS,
      'review:D1:b:r2': NO_FINDINGS,
      'consolidate:D1:r2': EMPTY_CONSOLIDATION,
      'apply:1': { applied: [{ id: 'D1', status: 'pr-open' }] },
      'coordinate:2': { items: [], remaining: 0, blocked: [] },
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  assert.equal(result.results.implement.outcomes[0].outcome, 'done')
  assert.equal(result.results.implement.outcomes[0].roundsUsed, 2)

  // Addendum-mode implementer prompt, not the from-scratch preamble.
  const implement = callWithLabel(calls, 'implement:D1')
  assert.ok(implement.prompt.includes('Feedback addendum'))
  assert.ok(!implement.prompt.includes('You are the implementation agent'))

  // recordSuffix in the round-record write path (consolidator) and the fix
  // agent's read path — writer and reader agree.
  const consolidate = callWithLabel(calls, 'consolidate:D1:r1')
  assert.ok(consolidate.prompt.includes(`${cfg.dir}/reviews/D1-code-round-1-feedback.md`))
  const fix = callWithLabel(calls, 'fix:D1:r1')
  assert.ok(fix.prompt.includes(`${cfg.dir}/reviews/D1-code-round-1-feedback.md`))

  // The outcome applier drives the feedback counter and re-entry edges.
  const apply = callWithLabel(calls, 'apply:1')
  assert.ok(apply.prompt.includes('feedback_rounds_used'))
  assert.ok(!apply.prompt.includes('set <deliverableFile> review_rounds_used'))
  assert.ok(apply.prompt.includes('pr-open'))

  // The coordinator runs the feedback re-entry, not fresh worktree creation.
  const coordinate = callWithLabel(calls, 'coordinate:1')
  assert.ok(coordinate.prompt.includes('Feedback addendum'))
  assert.ok(coordinate.prompt.includes('transition <deliverableFile> fixing'))
})

test('addendumMode: apply prompt carries each node\'s real pr value; done/pre-PR entry and exit contracts agree', async () => {
  const cfg = baseCfg({
    stages: ['implement'],
    stageArgs: { implement: { addendumMode: true, recordSuffix: '-feedback' } },
  })
  const PR_URL = 'https://github.com/o/r/pull/9'
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      // One node with an open PR, one pre-PR node still at done (pr: null).
      'coordinate:1': { items: [item('D1', PR_URL), item('D2')], remaining: 2, blocked: [] },
      ...nodeConverges('D1'),
      ...nodeConverges('D2'),
      'apply:1': { applied: [{ id: 'D1', status: 'pr-open' }, { id: 'D2', status: 'done' }] },
      'coordinate:2': { items: [], remaining: 0, blocked: [] },
    }),
  })
  assert.equal(result.results.implement.allDone, true)

  // The coordinator is told to return pr from the node frontmatter, to flip
  // fixing only for nodes with an open PR, and to dispatch a done/pre-PR node
  // WITHOUT the (illegal) done>fixing transition instead of hard-stopping.
  const coordinate = callWithLabel(calls, 'coordinate:1')
  assert.ok(coordinate.prompt.includes('resumeNote, pr'))
  assert.ok(coordinate.prompt.includes('transition <deliverableFile> fixing'))
  assert.ok(coordinate.prompt.includes('WITHOUT any transition'))
  assert.ok(coordinate.prompt.includes('no `done>fixing` edge'))

  // The applier sees each node's REAL pr value (not unconditionally null) and
  // keys the pr-open-vs-done exit on it; the pre-PR exit never routes through
  // in-review (illegal from done).
  const apply = callWithLabel(calls, 'apply:1')
  assert.ok(apply.prompt.includes(`"pr": "${PR_URL}"`))
  assert.ok(apply.prompt.includes('"pr": null'))
  assert.ok(apply.prompt.includes('with a non-null `pr`'))
  assert.ok(apply.prompt.includes('never entered `fixing`'))
})

// --- AC4: pr stage -------------------------------------------------------------

test('pr: guardrails + report-and-skip in prompt; dryRun print-only; skipped/reason surfaced', async () => {
  const cfg = baseCfg({ stages: ['pr'], stageArgs: { pr: { dryRun: false } } })
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'pr-gate': { remaining: 0, notDone: [] },
      'pr-create': PR_RESULT,
    }),
  })
  const prompt = callWithLabel(calls, 'pr-create').prompt
  assert.ok(prompt.includes(cfg.scripts.state))
  assert.ok(prompt.includes(`resolve ${cfg.slug}`))
  assert.ok(prompt.includes(`dag ${cfg.dir}`))
  assert.ok(prompt.includes('Never push `main`'))
  assert.ok(prompt.includes('never merge PRs'))
  assert.ok(prompt.includes('never `--force`'))
  assert.ok(prompt.includes('--force-with-lease'))
  assert.ok(prompt.includes('unauthenticated'))
  assert.ok(prompt.includes('no commits beyond its base'))
  assert.ok(prompt.includes('skipped: true'))
  assert.ok(!prompt.includes('DRY RUN'))
  assert.deepEqual(result.results.pr, { prs: PR_RESULT.prs, summary: PR_RESULT.summary, dryRun: false })

  // dryRun variant: print-only instruction + dryRun in the return.
  const dry = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['pr'], stageArgs: { pr: { dryRun: true } } }),
    agent: agentByLabel({
      'pr-gate': { remaining: 0, notDone: [] },
      'pr-create': PR_RESULT,
    }),
  })
  const dryPrompt = callWithLabel(dry.calls, 'pr-create').prompt
  assert.ok(dryPrompt.includes('DRY RUN'))
  assert.ok(dryPrompt.includes('print-only'))
  assert.ok(dryPrompt.includes('execute NOTHING that mutates'))
  assert.equal(dry.result.results.pr.dryRun, true)
})

test('pr as first stage: dag probe gate blocks when a node is earlier than done', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['pr'], stageArgs: { pr: {} } }),
    agent: agentByLabel({
      'pr-gate': { remaining: 2, notDone: ['D1', 'D2'] },
    }),
  })
  assert.equal(result.stoppedAt, 'pr')
  assert.deepEqual(result.completed, [])
  assert.equal(result.results.pr.gateFailed, true)
  assert.deepEqual(result.results.pr.notDone, ['D1', 'D2'])
  assert.deepEqual(result.results.pr.prs, [])
  assert.ok(result.results.pr.summary.includes('D1, D2'))
  assert.equal(callsWithLabelPrefix(calls, 'pr-create').length, 0)
})

// --- AC5: feedback-synth --------------------------------------------------------

test('feedback-synth: synthesis agent then review loop with feedback-round prefix', async () => {
  const comments = [
    {
      deliverableId: 'D1',
      pr: 'https://github.com/o/r/pull/1',
      lineComments: [{ path: 'src/thing.js', line: 3, body: 'rename this' }],
      reviewBodies: [{ state: 'CHANGES_REQUESTED', body: 'needs a test' }],
      issueComments: [],
    },
  ]
  const synth = {
    addenda: [{ deliverableId: 'D1', sourcePr: 'https://github.com/o/r/pull/1', crossDeliverable: false, tasks: ['rename thing', 'add the missing test'] }],
    summary: 'two fixes on D1',
  }
  const cfg = baseCfg({
    stages: ['feedback-synth'],
    stageArgs: { 'feedback-synth': { comments, repos: REPOS } },
  })
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'feedback-synth': synth,
      'plan-review:a:r1': NO_FINDINGS,
      'plan-review:b:r1': NO_FINDINGS,
      'consolidate:r1': EMPTY_CONSOLIDATION,
    }),
  })
  const stageResult = result.results['feedback-synth']
  assert.equal(stageResult.converged, true)
  assert.deepEqual(stageResult.addenda, synth.addenda)
  assert.equal(stageResult.summary, synth.summary)
  assert.deepEqual(result.completed, ['feedback-synth'])
  assert.equal(result.stoppedAt, null)

  // The synthesis agent saw the fetched comments; the review loop writes
  // feedback-round records, distinct from plan-round.
  const synthCall = callWithLabel(calls, 'feedback-synth')
  assert.ok(synthCall.prompt.includes('rename this'))
  assert.ok(synthCall.prompt.includes('Feedback addendum'))
  const consolidate = callWithLabel(calls, 'consolidate:r1')
  assert.ok(consolidate.prompt.includes(`${cfg.dir}/reviews/feedback-round-1.md`))
})
