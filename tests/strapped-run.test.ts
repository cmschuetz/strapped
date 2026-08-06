// Consolidated tests for the strapped-run mono-workflow: stage validation,
// the DI'd dispatch loop with gate semantics, and the transplanted stage
// machinery (plan + review loop, implement wave loop + code review, pr).
// Replaces the retired per-workflow test files. Config parse-error tests live
// in tests/strapped-run-config.test.ts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
  agentByLabel,
  callWithLabel,
  callsWithLabelPrefix,
  runWorkflow,
} from './helpers/workflow-harness.ts'
import {
  PLAN_SCHEMA,
  RESEARCH_FINAL_SCHEMA,
  RESEARCH_SCHEMA,
} from '../src/workflows/strapped-run/schemas.generated.ts'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/strapped-run.js', import.meta.url))

const REPOS = [{ name: 'alpha', root: '/repos/alpha' }]

const RULES = { a: ['A1'], b: ['B1'] }

const RULES_FILE = '/state/runs/test-run/reviews/rules-snapshot.md'

function baseCfg(overrides: Record<string, unknown> = {}) {
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
    rulesFile: RULES_FILE,
    stages: ['plan'],
    stageArgs: { plan: { sourcePlan: '/plans/test-run.md', repos: REPOS } },
    ...overrides,
  }
}

const NO_FINDINGS = { findings: [], rule_checklist: [{ rule: 'A1', verdict: 'pass', evidence: 'ok' }] }
const EMPTY_VERIFY = { verdicts: [], new_confirmed_ids: [], duplicate_ids: [] }

function confirmedVerify(...ids: string[]) {
  return {
    verdicts: ids.map(id => ({ id, verdict: 'confirmed', confidence: 95, evidence: 'real' })),
    new_confirmed_ids: ids,
    duplicate_ids: [],
  }
}

const PLAN = {
  deliverables: [{ id: 'D1', file: 'deliverables/D1-thing.md', title: 'Thing', deps: [] }],
  summary: 'one deliverable covering the thing',
}

function finding(id: string, severity = 'blocking') {
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
    'verify:r1': EMPTY_VERIFY,
  }
}

function item(id: string, pr: string | null = null) {
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

function wave(items: ReturnType<typeof item>[], remaining: number, blocked: { id: string; blockedOn: string[] }[] = []) {
  return { items, dag: { ready: items.map(i => i.id), resumable: [], remaining, blocked } }
}

const IMPLEMENTED = { status: 'implemented', summary: 'built the thing', validations_green: true, blocker: null }
const BLOCKED = { status: 'blocked', summary: 'partial', validations_green: false, blocker: 'missing dependency X' }

/** Agent stubs for one node implementing cleanly and converging in code-review round 1. */
function nodeConverges(id: string) {
  return {
    [`implement:${id}`]: IMPLEMENTED,
    [`review:${id}:a:r1`]: NO_FINDINGS,
    [`review:${id}:b:r1`]: NO_FINDINGS,
    [`verify:${id}:r1`]: EMPTY_VERIFY,
  }
}

const PR_RESULT = {
  prs: [
    { id: 'D1', url: 'https://github.com/o/r/pull/1', skipped: false, reason: null },
    { id: 'D2', url: null, skipped: true, reason: 'branch has no commits beyond base' },
  ],
  summary: 'opened 1 PR, skipped 1',
}

// --- stage validation + zero workflow() calls --------------------------------

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

// --- dispatch loop, approve gating --------------------------------------------

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
      'coordinate:1': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': wave([], 0),
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

test('zero gating findings → record-writer fast path; findings → full skeptical verifier', async () => {
  const clean = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel(planConverges()),
  })
  const cleanVerify = callWithLabel(clean.calls, 'verify:r1')
  assert.ok(cleanVerify.prompt.includes('record-writer'))
  assert.ok(cleanVerify.prompt.includes('Do NOT re-review'))
  assert.ok(!cleanVerify.prompt.includes('skeptical verifier'))

  const dirty = await runWorkflow(WORKFLOW, {
    args: baseCfg({ planRounds: 1 }),
    agent: agentByLabel({
      planner: PLAN,
      'plan-review:a:r1': { ...NO_FINDINGS, findings: [finding('f1')] },
      'plan-review:b:r1': NO_FINDINGS,
      'verify:r1': confirmedVerify('r1-a-f1'),
      'revise:r1': { revised: ['r1-a-f1'] },
      'plan-review:a:r1-confirm': NO_FINDINGS,
      'plan-review:b:r1-confirm': NO_FINDINGS,
      'verify:r1-confirm': EMPTY_VERIFY,
    }),
  })
  const dirtyVerify = callWithLabel(dirty.calls, 'verify:r1')
  assert.ok(dirtyVerify.prompt.includes('skeptical verifier'))
  assert.ok(!dirtyVerify.prompt.includes('record-writer'))
  // The skeptical verifier is pointed at the rules snapshot for rule text.
  assert.ok(dirtyVerify.prompt.includes(RULES_FILE))
  const confirmVerify = callWithLabel(dirty.calls, 'verify:r1-confirm')
  assert.ok(confirmVerify.prompt.includes('record-writer'))
})

test('reviewer prompts reference rulesFile and assigned ids, not rule text', async () => {
  const cfg = baseCfg({ stages: ['plan', 'implement'] })
  const { calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      ...planConverges(),
      approve: { changed: true },
      'coordinate:1': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': wave([], 0),
    }),
  })

  // Plan reviewers: assigned ids + a Read-the-snapshot instruction, zero inlined rule text.
  const planA = callWithLabel(calls, 'plan-review:a:r1').prompt
  const planB = callWithLabel(calls, 'plan-review:b:r1').prompt
  assert.ok(planA.includes(RULES_FILE))
  assert.ok(planA.includes('A1'))
  assert.ok(!planA.includes('B1'), 'reviewer a never sees reviewer b\'s ids')
  assert.ok(planB.includes(RULES_FILE))
  assert.ok(planB.includes('B1'))
  assert.ok(planA.includes('Read the rules snapshot'))
  assert.ok(!planA.includes('(CLAUDE.md):'), 'no inlined `- <id> (<source>): <text>` rule lines')

  // Code reviewers: same contract.
  const codeA = callWithLabel(calls, 'review:D1:a:r1').prompt
  assert.ok(codeA.includes(RULES_FILE))
  assert.ok(codeA.includes('A1'))
  assert.ok(codeA.includes('Read the rules snapshot'))
  assert.ok(!codeA.includes('(CLAUDE.md):'))

  // Record-writer frontmatter instructions carry the id arrays directly.
  const planVerify = callWithLabel(calls, 'verify:r1').prompt
  assert.ok(planVerify.includes('reviewer_a_rules: ["A1"]'))
  assert.ok(planVerify.includes('reviewer_b_rules: ["B1"]'))
  const codeVerify = callWithLabel(calls, 'verify:D1:r1').prompt
  assert.ok(codeVerify.includes('reviewer_a_rules: ["A1"]'))
})

test('planner prompt carries the preconditions/parking rule, not reject-or-restructure', async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel(planConverges()),
  })
  const planner = callWithLabel(calls, 'planner').prompt
  assert.ok(planner.includes('## Preconditions'), 'planner must instruct the Preconditions section')
  assert.ok(planner.includes('Plan such work IN the DAG'), 'externally-landing prerequisites stay in the DAG')
  assert.ok(planner.includes('parks the node'), 'unmet preconditions park at implement time')
  assert.ok(!planner.includes('Reject or restructure'), 'the reject-or-restructure rule is retired')
  assert.ok(!planner.includes('ordering-only'), 'the ordering-only framing is retired')
})

// --- plan research fan-out -------------------------------------------------------

/** A final-round researcher's canned result for a topic slug. */
function researched(slug: string) {
  return {
    topic: slug,
    notes_file: `/state/runs/test-run/research/${slug}.md`,
    summary: `notes on ${slug}`,
  }
}

/** A delegating planner result (lead schema shape, empty deliverables). */
function delegating(...requests: { topic: string; brief: string }[]) {
  return { deliverables: [], summary: 'delegating research', research_requests: requests }
}

test('plan: empty research_requests keeps the single-planner path', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      ...planConverges(),
      planner: { ...PLAN, research_requests: [] },
    }),
  })
  assert.equal(callsWithLabelPrefix(calls, 'planner').length, 1)
  assert.equal(callsWithLabelPrefix(calls, 'researcher:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'plan-writer').length, 0)
  assert.equal(result.results.plan.converged, true)
  assert.deepEqual(result.results.plan.deliverables, PLAN.deliverables)
  assert.equal(result.results.plan.summary, PLAN.summary)
  // The budget-recording manifest instruction is present even without delegation.
  assert.ok(callWithLabel(calls, 'planner').prompt.includes('research_rounds: 2'))
})

test('plan: researchRounds 1 strips delegation from schema and prompt', async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ researchRounds: 1 }),
    agent: agentByLabel(planConverges()),
  })
  const planner = callWithLabel(calls, 'planner')
  assert.deepEqual(planner.opts?.schema, PLAN_SCHEMA)
  assert.ok(!JSON.stringify(planner.opts?.schema).includes('research_requests'))
  assert.ok(!planner.prompt.includes('research_requests'))
  assert.ok(!/enqueue/i.test(planner.prompt))
  assert.ok(planner.prompt.includes('research_rounds: 1'))
})

test('plan: delegation dispatches deduped researchers then the plan-writer', async () => {
  const WRITTEN = {
    deliverables: [{ id: 'D1', file: 'deliverables/D1-writer.md', title: 'Writer thing', deps: [] }],
    summary: 'written by the plan-writer',
  }
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      ...planConverges(),
      planner: delegating(
        { topic: 'Auth Library', brief: 'find the auth library' },
        { topic: 'auth library', brief: 'duplicate slug of the first' },
        { topic: 'billing', brief: 'billing flows' }
      ),
      'researcher:auth-library': researched('auth-library'),
      'researcher:billing': researched('billing'),
      'plan-writer': WRITTEN,
    }),
  })
  const researchers = callsWithLabelPrefix(calls, 'researcher:')
  assert.deepEqual(researchers.map(c => c.opts?.label).sort(), ['researcher:auth-library', 'researcher:billing'])
  // Default researchRounds 2 makes the researchers the FINAL round: no-enqueue
  // schema and an enqueue-free prompt.
  for (const call of researchers) {
    assert.deepEqual(call.opts?.schema, RESEARCH_FINAL_SCHEMA)
    assert.ok(!call.prompt.includes('research_requests'))
    assert.ok(!/enqueue/i.test(call.prompt))
    assert.ok(call.prompt.includes('already owned by other researchers'))
  }
  assert.ok(callWithLabel(calls, 'researcher:auth-library').prompt.includes('billing'))
  assert.ok(callWithLabel(calls, 'researcher:billing').prompt.includes('auth-library'))
  // The plan-writer runs after every researcher and supplies the stage result.
  assert.equal(callsWithLabelPrefix(calls, 'plan-writer').length, 1)
  const writerIdx = calls.indexOf(callWithLabel(calls, 'plan-writer'))
  for (const call of researchers) assert.ok(calls.indexOf(call) < writerIdx)
  assert.deepEqual(result.results.plan.deliverables, WRITTEN.deliverables)
  assert.equal(result.results.plan.summary, WRITTEN.summary)
})

test('plan: three rounds BFS with mid-round enqueue and hard stop', async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ researchRounds: 3 }),
    agent: agentByLabel({
      ...planConverges(),
      planner: delegating({ topic: 'alpha', brief: 'alpha groundwork' }),
      'researcher:alpha': {
        ...researched('alpha'),
        research_requests: [
          { topic: 'beta', brief: 'discovered in round 2' },
          { topic: 'Alpha', brief: 'duplicate of an assigned topic' },
        ],
      },
      // The round-3 stub returns an enqueue anyway — the harness must ignore it.
      'researcher:beta': { ...researched('beta'), research_requests: [{ topic: 'gamma', brief: 'never dispatched' }] },
      'plan-writer': PLAN,
    }),
  })
  const alpha = callWithLabel(calls, 'researcher:alpha')
  assert.deepEqual(alpha.opts?.schema, RESEARCH_SCHEMA)
  assert.ok(alpha.prompt.includes('research_requests'), 'a non-final researcher MAY enqueue')
  const beta = callWithLabel(calls, 'researcher:beta')
  assert.deepEqual(beta.opts?.schema, RESEARCH_FINAL_SCHEMA)
  assert.ok(!beta.prompt.includes('research_requests'))
  assert.ok(!/enqueue/i.test(beta.prompt))
  // The duplicate is never re-dispatched and round 3's enqueue goes nowhere.
  assert.equal(callsWithLabelPrefix(calls, 'researcher:').length, 2)
})

test('plan: per-round clamp dispatches 6 researchers and logs the overflow', async () => {
  const topics = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
  const stubs = Object.fromEntries(topics.slice(0, 6).map(t => [`researcher:${t}`, researched(t)]))
  const { calls, logs } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      ...planConverges(),
      planner: delegating(...topics.map(t => ({ topic: t, brief: `about ${t}` }))),
      ...stubs,
      'plan-writer': PLAN,
    }),
  })
  assert.equal(callsWithLabelPrefix(calls, 'researcher:').length, 6)
  assert.ok(logs.some(l => l.includes('t7') && l.includes('t8')), 'overflow topics are logged')
})

test('plan: null researcher is skipped, null plan-writer throws', async () => {
  const { result, calls, logs } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      ...planConverges(),
      planner: delegating({ topic: 'alpha', brief: 'a' }, { topic: 'beta', brief: 'b' }),
      'researcher:alpha': () => null,
      'researcher:beta': researched('beta'),
      'plan-writer': PLAN,
    }),
  })
  assert.equal(result.results.plan.converged, true)
  assert.equal(callsWithLabelPrefix(calls, 'plan-writer').length, 1)
  assert.ok(logs.some(l => l.includes('alpha')), 'the failed researcher is logged')

  await assert.rejects(
    runWorkflow(WORKFLOW, {
      args: baseCfg(),
      agent: agentByLabel({
        planner: delegating({ topic: 'alpha', brief: 'a' }),
        'researcher:alpha': researched('alpha'),
        'plan-writer': () => null,
      }),
    }),
    /plan-writer agent failed/
  )
})

test('plan: planner prompt keeps the preconditions/parking contract on the classic path too', async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ researchRounds: 1 }),
    agent: agentByLabel(planConverges()),
  })
  const planner = callWithLabel(calls, 'planner').prompt
  assert.ok(planner.includes('## Preconditions'))
  assert.ok(planner.includes('Plan such work IN the DAG'))
  assert.ok(planner.includes('parks the node'))
  assert.ok(!planner.includes('Reject or restructure'))
  assert.ok(!planner.includes('ordering-only'))
})

test('reviewer b checks precondition declarations instead of flagging cross-repo code deps', async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel(planConverges()),
  })
  const planB = callWithLabel(calls, 'plan-review:b:r1').prompt
  assert.ok(planB.includes('cross-repo base rule'), 'base-rule verification stays')
  assert.ok(planB.includes('## Preconditions'), 'reviewer b checks for the declared precondition')
  assert.ok(planB.includes('flag a MISSING declaration, never the dependency itself'))
  assert.ok(!planB.includes('ordering-only'), 'the ordering-only check is retired')
  assert.ok(!planB.includes('no cross-repo dep is a true code dependency'))
})

test('implement prompt instructs blocking on an unmet declared precondition', async () => {
  const cfg = baseCfg({ stages: ['implement'], stageArgs: { implement: {} } })
  const { calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': wave([], 0),
    }),
  })
  const implement = callWithLabel(calls, 'implement:D1').prompt
  assert.ok(implement.includes('## Preconditions'))
  assert.ok(implement.includes('do NOT improvise around it'))
  assert.ok(implement.includes('return status "blocked" with the blocker naming the unmet precondition'))
})

test('pr prompt has no wrap instruction and keeps short-title guidance', async () => {
  const cfg = baseCfg({ stages: ['pr'], stageArgs: { pr: { dryRun: true } } })
  const { calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'pr-gate': { remaining: 0, notDone: [] },
      'pr-create': PR_RESULT,
    }),
  })
  const pr = callWithLabel(calls, 'pr-create').prompt
  assert.ok(!/\bwrapped\b/.test(pr), 'no column-wrapping instruction survives')
  assert.ok(!pr.includes('~72 cols'), 'no column-wrapping instruction survives')
  assert.ok(pr.includes('aim ~50'), 'short-title guidance stays')
  assert.ok(pr.includes('natural unwrapped paragraphs'), 'the body is natural unwrapped prose')
})

test('missing rulesFile with non-empty rulesByRound throws at config parse', async () => {
  await assert.rejects(
    runWorkflow(WORKFLOW, { args: baseCfg({ rulesFile: undefined }) }),
    /config field "rulesFile" .* is required when "rulesByRound" is non-empty/
  )
  await assert.rejects(runWorkflow(WORKFLOW, { args: baseCfg({ rulesFile: 42 }) }), /"rulesFile" must be a string/)
})

test('pr-only dispatch omitting rulesByRound AND rulesFile still runs (lazy contract)', async () => {
  const cfg = baseCfg({ stages: ['pr'], stageArgs: { pr: { dryRun: true } } }) as Record<string, unknown>
  delete cfg.rulesByRound
  delete cfg.rulesFile
  const { result } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({
      'pr-gate': { remaining: 0, notDone: [] },
      'pr-create': PR_RESULT,
    }),
  })
  assert.deepEqual(result.results.pr, { prs: PR_RESULT.prs, summary: PR_RESULT.summary, dryRun: true })
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
      'verify:r1': confirmedVerify('r1-a-f1'),
      'revise:r1': () => null, // reviser fails → loop stops non-converged
    }),
  })
  assert.equal(result.stoppedAt, 'plan')
  assert.deepEqual(result.completed, [])
  assert.equal(result.results.plan.converged, false)
  assert.equal(result.results.plan.outstanding.length, 1)
  assert.equal(result.results.plan.outstanding[0]?.id, 'r1-a-f1')
  assert.equal(callsWithLabelPrefix(calls, 'approve').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'coordinate:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'pr-').length, 0)
})

test('null verifier result → votes not cast, no finding confirmed, loop completes without crash', async () => {
  const { result, calls, logs } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      planner: PLAN,
      'plan-review:a:r1': { findings: [finding('f1')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'verify:r1': () => null,
    }),
  })
  assert.equal(result.results.plan.converged, true)
  assert.equal(result.stoppedAt, null)
  // No vote cast → the finding never survives, so no reviser runs.
  assert.equal(callsWithLabelPrefix(calls, 'revise:').length, 0)
  assert.ok(logs.some(l => l.includes('verifier cast no vote')))
})

test('a verdict missing from the verifier result is a vote not cast on that finding only', async () => {
  const { result } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      planner: PLAN,
      'plan-review:a:r1': { findings: [finding('f1'), finding('f2')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      // Only f1 gets a verdict — and it is refuted; f2 has no vote at all.
      'verify:r1': {
        verdicts: [{ id: 'r1-a-f1', verdict: 'refuted', confidence: 10, evidence: 'not real' }],
        new_confirmed_ids: [],
        duplicate_ids: [],
      },
    }),
  })
  assert.equal(result.results.plan.converged, true)
  assert.equal(result.stoppedAt, null)
})

test('single verifier per round regardless of finding count', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({
      planner: PLAN,
      'plan-review:a:r1': { findings: [finding('f1'), finding('f2'), finding('f3')], rule_checklist: [] },
      'plan-review:b:r1': NO_FINDINGS,
      'verify:r1': confirmedVerify('r1-a-f1', 'r1-a-f2', 'r1-a-f3'),
      'revise:r1': { ok: true },
      'plan-review:a:r2': NO_FINDINGS,
      'plan-review:b:r2': NO_FINDINGS,
      'verify:r2': EMPTY_VERIFY,
    }),
  })
  assert.equal(result.results.plan.converged, true)
  // Three gating findings in round 1 still dispatch exactly ONE verifier —
  // the per-round agent-call count is constant.
  assert.equal(callsWithLabelPrefix(calls, 'verify:r1').length, 1)
  assert.equal(callsWithLabelPrefix(calls, 'verify:').length, 2)
  // The one verifier saw every finding.
  const verify = callWithLabel(calls, 'verify:r1')
  assert.ok(verify.prompt.includes('"r1-a-f1"'))
  assert.ok(verify.prompt.includes('"r1-a-f2"'))
  assert.ok(verify.prompt.includes('"r1-a-f3"'))
})

test('zero plan rounds: plan stage converges with no review agents and still auto-approves when chained', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({
      planRounds: 0,
      rulesByRound: [],
      stages: ['plan', 'implement'],
      stageArgs: { plan: { sourcePlan: '/plans/test-run.md', repos: REPOS } },
    }),
    agent: agentByLabel({
      planner: PLAN,
      approve: { changed: true },
      'coordinate:1': wave([], 0),
    }),
  })
  assert.equal(result.results.plan.converged, true)
  assert.equal(result.results.plan.rounds, 0)
  assert.deepEqual(result.results.plan.outstanding, [])
  assert.deepEqual(result.completed, ['plan', 'implement'])
  assert.equal(result.stoppedAt, null)
  // Zero review agents of any kind — the planner and approve still ran.
  assert.equal(callsWithLabelPrefix(calls, 'plan-review').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'verify:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'revise:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'planner').length, 1)
  assert.equal(callsWithLabelPrefix(calls, 'approve').length, 1)
})

test('zero code rounds: implemented node goes done without review; a blocked one still parks', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ codeRounds: 0, rulesByRound: [], stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 1),
      'implement:D1': IMPLEMENTED,
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': wave([], 0),
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  assert.equal(result.results.implement.outcomes[0]?.outcome, 'done')
  assert.equal(result.results.implement.outcomes[0]?.roundsUsed, 0)
  assert.equal(callsWithLabelPrefix(calls, 'review:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'verify:').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'fix:').length, 0)
  // review_rounds_used is applied as 0.
  const apply = callWithLabel(calls, 'apply:1')
  assert.ok(apply.prompt.includes('"roundsUsed": 0'))

  // A blocked implementation still parks — 0 rounds never launders a failure.
  const blocked = await runWorkflow(WORKFLOW, {
    args: baseCfg({ codeRounds: 0, rulesByRound: [], stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 1),
      'implement:D1': BLOCKED,
      'apply:1': { applied: [{ id: 'D1', status: 'parked' }] },
    }),
  })
  assert.equal(blocked.result.results.implement.outcomes[0]?.outcome, 'parked')
  assert.equal(blocked.result.results.implement.outcomes[0]?.parkedReason, 'missing dependency X')
})

// --- implement stage -----------------------------------------------------------

test('implement: two waves then allDone; manifest-status implementing in first coordinator prompt only', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 2, [{ id: 'D2', blockedOn: ['D1'] }]),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': wave([item('D2')], 1),
      ...nodeConverges('D2'),
      'apply:2': { applied: [{ id: 'D2', status: 'done' }] },
      // No coordinate:3 handler: the deterministic wrap-up computes remaining
      // 0 from the pass-2 dag paste and never dispatches a third coordinator.
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  assert.equal(result.stoppedAt, null)
  assert.deepEqual(
    result.results.implement.outcomes.map(o => ({ id: o.id, outcome: o.outcome })),
    [{ id: 'D1', outcome: 'done' }, { id: 'D2', outcome: 'done' }]
  )
  assert.equal(callsWithLabelPrefix(calls, 'coordinate:').length, 2)
  const flip = `manifest-status ${baseCfg().dir} implementing`
  assert.ok(callWithLabel(calls, 'coordinate:1').prompt.includes(flip))
  assert.ok(!callWithLabel(calls, 'coordinate:2').prompt.includes(flip))
})

test('implement: wrap-up shortcut cross-checks on-disk apply statuses — a failed done-transition defers to the next coordinator pass', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      // The applier reports the done transition did NOT land on disk: the
      // deterministic wrap-up must not declare allDone from the wave outcome
      // alone — it falls through to a real coordinator pass instead.
      'apply:1': { applied: [{ id: 'D1', status: 'parked' }] },
      'coordinate:2': wave([], 1),
    }),
  })
  assert.equal(result.results.implement.allDone, false)
  assert.equal(callsWithLabelPrefix(calls, 'coordinate:').length, 2)
})

test('implement: node already pr-open at entry → allDone true with no implementer dispatched', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': wave([], 0),
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
      'coordinate:1': wave([item('D1')], 2, [{ id: 'D2', blockedOn: ['D1'] }]),
      'implement:D1': BLOCKED,
      'apply:1': { applied: [{ id: 'D1', status: 'parked' }] },
    }),
  })
  assert.equal(result.stoppedAt, 'implement')
  assert.deepEqual(result.completed, [])
  assert.equal(result.results.implement.allDone, false)
  assert.equal(result.results.implement.outcomes[0]?.outcome, 'parked')
  assert.equal(result.results.implement.outcomes[0]?.parkedReason, 'missing dependency X')
  assert.deepEqual(result.results.implement.blocked, [{ id: 'D2', blockedOn: ['D1'] }])
  assert.equal(callsWithLabelPrefix(calls, 'pr-gate').length, 0)
  assert.equal(callsWithLabelPrefix(calls, 'pr-create').length, 0)
})

test('implement: zero-progress wave terminates the loop', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 3),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': wave([item('D2')], 2),
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

test('implement: coordinator wave contradicting its dag paste is re-dispatched once and the retry wave is used', async () => {
  const lyingWave = { items: [], dag: { ready: ['D1'], resumable: [], remaining: 1, blocked: [] } }
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': lyingWave,
      'coordinate:1:retry': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': wave([], 0),
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  const coordinatorCalls = callsWithLabelPrefix(calls, 'coordinate:1')
  assert.equal(coordinatorCalls.length, 2)
  const retryCall = coordinatorCalls.find(c => c.opts?.label === 'coordinate:1:retry')
  assert.ok(retryCall !== undefined)
  assert.ok(retryCall.prompt.includes('RETRY — your previous wave was REJECTED'), 'retry prompt must explain the mismatch')
  assert.ok(retryCall.prompt.includes("ready [D1]"), 'retry prompt must name the rejected ready set')
  assert.equal(callsWithLabelPrefix(calls, 'implement:').length, 1)
})

test('implement: an interrupted in-progress node is dispatchable via dag.resumable', async () => {
  const resumeWave = { items: [item('D1')], dag: { ready: [], resumable: ['D1'], remaining: 1, blocked: [] } }
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': resumeWave,
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'coordinate:2': wave([], 0),
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  assert.equal(callsWithLabelPrefix(calls, 'coordinate:1').length, 1)
  assert.equal(callsWithLabelPrefix(calls, 'implement:').length, 1)
})

test('implement: a second dag-contradicting wave is a hard error, never a fake allDone', async () => {
  const lyingWave = { items: [], dag: { ready: ['D1'], resumable: [], remaining: 1, blocked: [] } }
  await assert.rejects(
    runWorkflow(WORKFLOW, {
      args: baseCfg({ stages: ['implement'], stageArgs: {} }),
      agent: agentByLabel({
        'coordinate:1': lyingWave,
        'coordinate:1:retry': lyingWave,
      }),
    }),
    /does not match its own dag ready/
  )
})

// --- pr stage -------------------------------------------------------------------

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
  // Conventional-Commits title/body: scope = run slug, type vocabulary, no `Dx: <title>` form.
  assert.ok(prompt.includes(`<type>(${cfg.slug}): <description>`))
  assert.ok(prompt.includes('feat/fix/refactor/perf/docs/test/build/ci/chore'))
  assert.ok(prompt.includes('BREAKING CHANGE:'))
  assert.ok(!prompt.includes('<Did>: <title>'))
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

// --- per-deliverable scoping (--only) -------------------------------------------

test('implement --only: scoped remaining yields allDone with other nodes pending', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: { implement: { only: 'D1' } } }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  assert.equal(result.stoppedAt, null)
  assert.ok(callWithLabel(calls, 'coordinate:1').prompt.includes('--only D1'))
})

test('ship-style chain [implement, pr] scoped to D1 runs pr without a gate probe', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({
      stages: ['implement', 'pr'],
      stageArgs: { implement: { only: 'D1' }, pr: { dryRun: true, only: 'D1' } },
    }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'pr-create': PR_RESULT,
    }),
  })
  assert.deepEqual(result.completed, ['implement', 'pr'])
  assert.equal(result.stoppedAt, null)
  assert.equal(callsWithLabelPrefix(calls, 'pr-gate').length, 0)
  const create = callWithLabel(calls, 'pr-create').prompt
  assert.ok(create.includes('restricted to deliverable D1'), 'scoped create restriction present')
  assert.ok(create.includes('without a `pr:` URL'), 'not-yet-PR\'d done ancestors stay in scope')
})

test('pr --only as first stage: probe uses dag --only and gates on scoped remaining', async () => {
  const open = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['pr'], stageArgs: { pr: { only: 'D1' } } }),
    agent: agentByLabel({
      'pr-gate': { remaining: 0, notDone: [] },
      'pr-create': PR_RESULT,
    }),
  })
  const probe = callWithLabel(open.calls, 'pr-gate').prompt
  assert.ok(probe.includes('dag /state/runs/test-run --only D1'))
  assert.ok(probe.includes('the scope is D1 alone'))
  assert.equal(open.result.stoppedAt, null)
  assert.equal(callsWithLabelPrefix(open.calls, 'pr-create').length, 1)

  const gated = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['pr'], stageArgs: { pr: { only: 'D1' } } }),
    agent: agentByLabel({
      'pr-gate': { remaining: 1, notDone: ['D1'] },
    }),
  })
  assert.equal(gated.result.results.pr.gateFailed, true)
  assert.deepEqual(gated.result.results.pr.notDone, ['D1'])
  assert.equal(callsWithLabelPrefix(gated.calls, 'pr-create').length, 0)
})

test('pr after implement with mismatched scopes re-probes', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({
      stages: ['implement', 'pr'],
      stageArgs: { implement: { only: 'D1' }, pr: { only: 'D2' } },
    }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
      'pr-gate': { remaining: 1, notDone: ['D2'] },
    }),
  })
  assert.equal(callsWithLabelPrefix(calls, 'pr-gate').length, 1, 'a mismatched-scope chain must re-probe')
  assert.ok(callWithLabel(calls, 'pr-gate').prompt.includes('--only D2'))
  assert.equal(result.results.pr.gateFailed, true)
  assert.equal(result.stoppedAt, 'pr')
})

test('pr-create prompt states the merged-parent base rule', async () => {
  const stubs = {
    'pr-gate': { remaining: 0, notDone: [] },
    'pr-create': PR_RESULT,
  }
  const unscoped = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['pr'], stageArgs: { pr: { dryRun: true } } }),
    agent: agentByLabel(stubs),
  })
  const scoped = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['pr'], stageArgs: { pr: { dryRun: true, only: 'D1' } } }),
    agent: agentByLabel(stubs),
  })
  for (const { calls } of [unscoped, scoped]) {
    const prompt = callWithLabel(calls, 'pr-create').prompt
    assert.ok(prompt.includes('MERGED-PARENT CARVE-OUT'))
    assert.ok(prompt.includes('fetch origin main'))
    assert.ok(prompt.includes('rebase --onto origin/main <parent-branch>'))
    assert.ok(prompt.includes('NEVER `git rebase main <branch>` from outside the worktree'))
    assert.ok(
      prompt.includes("resolve `<parent-branch>` from the merged PARENT node's `branch:`"),
      'parent branch comes from the parent node, not the rewritten child base'
    )
    assert.ok(prompt.includes("NEVER from the child's frontmatter `base:`"))
    assert.ok(prompt.includes('headRefOid'))
    assert.ok(prompt.includes('--force-with-lease'))
    assert.ok(prompt.includes('Parents at `done`/`pr-open` keep the parent-branch base'))
  }
})

test('coordinator prompt overrides the base for a merged same-repo parent', async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: {} }),
    agent: agentByLabel({
      'coordinate:1': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
    }),
  })
  const prompt = callWithLabel(calls, 'coordinate:1').prompt
  assert.ok(prompt.includes('Effective base'), 'the worktree step names an effective base')
  assert.ok(prompt.includes('has status `merged`'))
  assert.ok(prompt.includes('fetch origin main'))
  assert.ok(prompt.includes('use the repo\'s **main** as the effective base'))
  assert.ok(prompt.includes('set <deliverableFile> base main'), 'the effective base is written back to frontmatter')
  assert.ok(prompt.includes('Parents at done/pr-open keep the frontmatter `base:` unchanged'))
  assert.ok(prompt.includes('<effectiveBase>'), 'ensure-worktree receives the effective base')
})

test('implement --only scopes the resume sweep and rejects an out-of-scope sweep', async () => {
  const outOfScopeWave = {
    items: [item('D1'), item('D2')],
    dag: { ready: ['D1'], resumable: ['D2'], remaining: 1, blocked: [] },
  }
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ stages: ['implement'], stageArgs: { implement: { only: 'D1' } } }),
    agent: agentByLabel({
      'coordinate:1': outOfScopeWave,
      'coordinate:1:retry': wave([item('D1')], 1),
      ...nodeConverges('D1'),
      'apply:1': { applied: [{ id: 'D1', status: 'done' }] },
    }),
  })
  assert.equal(result.results.implement.allDone, true)
  assert.equal(callsWithLabelPrefix(calls, 'coordinate:1').length, 2, 'the out-of-scope wave is rejected and retried')
  assert.equal(callsWithLabelPrefix(calls, 'implement:').length, 1)
  assert.equal(callsWithLabelPrefix(calls, 'implement:D2').length, 0, 'the out-of-scope node is never dispatched')
  const prompt = callWithLabel(calls, 'coordinate:1').prompt
  assert.ok(prompt.includes('SCOPED to D1'), 'the resume sweep is scoped to the named id')
  assert.ok(prompt.includes('`resumable` = [D1]'), 'resumable covers only the scoped id')
})

test('implement --only: out-of-scope done cannot fake allDone and a chained pr does not run', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({
      stages: ['implement', 'pr'],
      stageArgs: { implement: { only: 'D1' }, pr: { only: 'D1' } },
    }),
    agent: agentByLabel({
      // A lying sweep pulls in-progress D2 into a D1-scoped wave; the retry
      // returns the honest scoped wave, whose only node then parks.
      'coordinate:1': {
        items: [item('D1'), item('D2')],
        dag: { ready: ['D1'], resumable: ['D2'], remaining: 1, blocked: [] },
      },
      'coordinate:1:retry': wave([item('D1')], 1),
      'implement:D1': BLOCKED,
      'apply:1': { applied: [{ id: 'D1', status: 'parked' }] },
    }),
  })
  assert.equal(result.results.implement.allDone, false, 'a parked scoped node must not report allDone')
  assert.equal(result.stoppedAt, 'implement')
  assert.equal(callsWithLabelPrefix(calls, 'implement:D2').length, 0, 'no out-of-scope done can exist')
  assert.equal(callsWithLabelPrefix(calls, 'pr-').length, 0, 'the chained pr stage does not run')
})

test('implement --only on a blocked node stops loudly and a chained pr does not run', async () => {
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({
      stages: ['implement', 'pr'],
      stageArgs: { implement: { only: 'D2' }, pr: { only: 'D2' } },
    }),
    agent: agentByLabel({
      'coordinate:1': {
        items: [],
        dag: { ready: [], resumable: [], remaining: 1, blocked: [{ id: 'D2', blockedOn: ['D1'] }] },
      },
    }),
  })
  assert.equal(result.results.implement.allDone, false)
  assert.deepEqual(result.results.implement.blocked, [{ id: 'D2', blockedOn: ['D1'] }])
  assert.equal(result.stoppedAt, 'implement')
  assert.equal(callsWithLabelPrefix(calls, 'pr-').length, 0)
})
