// Harness SCENARIO suite smoke test — fully hermetic (no real `claude`).
//
// Proves the scenario CONTENT is sound without spending a cent:
//   - the CLI loads exactly the eight scenarios from the suite directory and
//     `--filter` narrows by id and by tag (agent calls answered by a stub
//     spawn returning error envelopes — the REAL deployable still executes);
//   - every scenario is well-formed (unique ids, canonical stage order,
//     ask/rules/graders/fixtures present, rules verbatim in the fixture
//     CLAUDE.md);
//   - per scenario, a canned GOOD outcome (sandbox materialized + seeded
//     with the artifacts a correct run would produce) grades to
//     correctness 1 / adherence 1, and a canned BAD outcome grades strictly
//     below 1 on the axis it violates;
//   - the implement-only and review-loop seedRunStates produce runDirs the
//     REAL `node plugins/strapped/scripts/state.mjs dag` accepts, with
//     materialized `repos:` roots that are existing absolute sandbox paths;
//   - the docs cover the scenario layer and conventions.md no longer claims
//     only `--ab` gates;
//   - the review-loop graders discriminate on the anti-saturation axes:
//     an unfixed defect, a churned nit site, and excess total churn each
//     fail their own grader.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'bun:test'
import { loadScenarios, main } from '../../src/eval/cli.ts'
import { gradeScenario, type ScenarioGrade } from '../../src/eval/scenario/grade.ts'
import { buildSandbox, removeSandbox } from '../../src/eval/scenario/sandbox.ts'
import type { Scenario, ScenarioOutcome, ScenarioSandbox } from '../../src/eval/scenario/types.ts'
import { scenarios } from '../../src/eval/scenarios/harness/index.ts'
import { dirtyBranchScenario } from '../../src/eval/scenarios/harness/dirty-branch.scenario.ts'
import { fullPipelineScenario } from '../../src/eval/scenarios/harness/full-pipeline.scenario.ts'
import { manyRulesScenario } from '../../src/eval/scenarios/harness/many-rules.scenario.ts'
import { planOnlyScenario } from '../../src/eval/scenarios/harness/plan-only.scenario.ts'
import { preconditionParkScenario } from '../../src/eval/scenarios/harness/precondition-park.scenario.ts'
import { implementOnlyScenario } from '../../src/eval/scenarios/harness/implement-only.scenario.ts'
import { reviewLoopScenario } from '../../src/eval/scenarios/harness/review-loop.scenario.ts'
import { zeroRoundsScenario } from '../../src/eval/scenarios/harness/zero-rounds.scenario.ts'
import { CHURN_THRESHOLD_LINES, NIT_SITES } from '../../src/eval/scenarios/harness/fixtures/defect-repo.ts'
import { FLAW_PROBES } from '../../src/eval/scenarios/harness/fixtures/dirty-repo.ts'
import { MANY_RULES } from '../../src/eval/scenarios/harness/fixtures/many-rules.ts'
import { splitRules } from '../../src/eval/scenario/rules.ts'
import { readFrontmatterFile, writeFrontmatterFile, type Die } from '../../src/lib/frontmatter.ts'
import type { GradeResult } from '../../src/eval/grade.ts'
import type { ScenarioReportJSON } from '../../src/eval/scenario/compare.ts'
import type { Spawn } from '../../src/eval/types.ts'
import { errorEnvelope, fakeSpawn, successEnvelope } from '../helpers/fake-claude.ts'
import { NODE } from '../helpers/node-bin.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SCENARIOS_DIR = join(ROOT, 'src', 'eval', 'scenarios', 'harness')
const STATE_MJS = join(ROOT, 'plugins', 'strapped', 'scripts', 'state.mjs')
const CONVENTIONS_MD = join(ROOT, 'plugins', 'strapped', 'conventions.md')
const CLAUDE_MD = join(ROOT, 'CLAUDE.md')
const CONTRIBUTING_MD = join(ROOT, 'CONTRIBUTING.md')

const STAGE_ORDER = ['plan', 'feedback-synth', 'implement', 'pr']
const ALL_IDS = ['dirty-branch', 'full-pipeline', 'implement-only', 'many-rules', 'plan-only', 'precondition-park', 'review-loop', 'zero-rounds']

const raise: Die = msg => {
  throw new Error(msg)
}

/** Every judge call answered with a full-score verdict (the ONE model boundary). */
const JUDGE_PASS = fakeSpawn(successEnvelope({ score: 1, pass: true, reason: 'stubbed judge' }))

// --- canned repo states --------------------------------------------------------

const GOOD_CALC = `export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a - b
}
`

const BROKEN_CALC = `export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a + b
}
`

const GOOD_CALC_TEST = `import { expect, test } from 'bun:test'
import { add, subtract } from '../src/calc.ts'

test('add sums two numbers', () => {
  expect(add(2, 3)).toBe(5)
})

test('subtract subtracts', () => {
  expect(subtract(5, 3)).toBe(2)
})
`

/** All three review-loop defects fixed. */
const FIXED_DEFECT_CALC = `export function add(a: number, b: number): number {
  return a + b
}

export function max(a: number, b: number): number {
  return a > b ? a : b
}

export function isEven(n: number): boolean {
  return n % 2 === 0
}
`

/** Two defects fixed, isEven still inverted. */
const PARTIALLY_FIXED_CALC = `export function add(a: number, b: number): number {
  return a + b
}

export function max(a: number, b: number): number {
  return a > b ? a : b
}

export function isEven(n: number): boolean {
  return n % 2 === 1
}
`

/** A "cleaned up" quirks file — the over-correction a disciplined run avoids. */
const CHURNED_QUIRKS = `let legacyCounter = 0

export function bumpCounter(): string {
  legacyCounter += 1
  return \`bumped: \${legacyCounter}\`
}
`

const ROUND_RECORD = '---\nround: 1\n---\nno confirmed findings\n'

// --- helpers -------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')} in ${cwd}: ${res.stderr}`)
  return res.stdout
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Create a real git worktree for D1 off main and return its path. */
function addWorktree(sandbox: ScenarioSandbox, branch: string): string {
  const repo = sandbox.repos[0]
  assert.ok(repo !== undefined, 'sandbox has a repo')
  const wt = join(repo.worktreeRoot, sandbox.slug, 'D1')
  mkdirSync(dirname(wt), { recursive: true })
  const exists = spawnSync('git', ['rev-parse', '--verify', '-q', branch], { cwd: repo.root }).status === 0
  if (exists) git(repo.root, 'worktree', 'add', '-q', wt, branch)
  else git(repo.root, 'worktree', 'add', '-q', wt, '-b', branch, 'main')
  return wt
}

function commitWorktree(wt: string, message: string): void {
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', message)
}

/** Simulate the state.mjs transition auto-commits beyond the sandbox seed. */
function commitState(sandbox: ScenarioSandbox): void {
  git(sandbox.stateRoot, 'add', '-A')
  git(sandbox.stateRoot, 'commit', '-q', '-m', 'state: canned transitions')
}

function patchFrontmatter(file: string, patch: Record<string, unknown>): void {
  const { data, content } = readFrontmatterFile(file, raise)
  Object.assign(data, patch)
  writeFrontmatterFile(file, data, content)
}

function outcomeFor(scenario: Scenario, sandbox: ScenarioSandbox, runResult: unknown): ScenarioOutcome {
  return {
    scenario,
    sandbox,
    runResult,
    error: null,
    ledger: [],
    wallClockMs: 0,
    totals: { costUsd: 0, turns: 0, agentCalls: 0, durationMs: 0, apiDurationMs: 0 },
    phases: [],
    logs: [],
  }
}

function grade(outcome: ScenarioOutcome): ScenarioGrade {
  return gradeScenario(outcome, { spawn: JUDGE_PASS })
}

function byName(grades: readonly GradeResult[], name: string): GradeResult {
  const found = grades.find(g => g.name === name)
  assert.ok(found !== undefined, `no grade named ${name}`)
  return found
}

function describeGrades(grades: readonly GradeResult[]): string {
  return grades.map(g => `${g.name}=${g.score} (${g.detail})`).join(' | ')
}

/** Canned RunResult for a clean run of the given stage subset. */
function runResultFor(scenario: Scenario, results: Record<string, unknown>): unknown {
  return {
    slug: scenario.id,
    stages: [...scenario.stages],
    completed: [...scenario.stages],
    stoppedAt: null,
    results,
  }
}

const IMPLEMENT_RESULT = { allDone: true, outcomes: [], blocked: [] }

/** Seed a full-pipeline/plan-only runDir with the artifacts a plan run writes. */
function seedPlanArtifacts(
  sandbox: ScenarioSandbox,
  opts: { manifestStatus: string; deliverable: Record<string, unknown>; basename: string }
): void {
  const repo = sandbox.repos[0]
  assert.ok(repo !== undefined)
  writeFrontmatterFile(
    join(sandbox.runDir, 'manifest.md'),
    {
      slug: sandbox.slug,
      source_plan: `plans/${sandbox.slug}.md`,
      created: '2026-07-29',
      status: opts.manifestStatus,
      seed: 1,
      budgets: { plan_rounds: 1, code_rounds: 1, confidence_min: 70 },
      repos: [{ name: repo.name, root: repo.root, config: repo.configPath }],
      deliverables: [{ id: 'D1', file: `deliverables/${opts.basename}`, deps: [] }],
    },
    `# ${sandbox.slug}\n\nCanned theme summary. DAG: D1.\n`
  )
  writeFrontmatterFile(
    join(sandbox.runDir, 'deliverables', opts.basename),
    opts.deliverable,
    '## Context\ncanned\n\n## Files to touch\n- src/calc.ts\n\n## Implementation steps\n1. do it\n\n## Acceptance criteria\n- AC1: subtract works\n\n## Tests\n- tests/calc.test.ts\n\n## Out of scope\n- everything else\n'
  )
  write(join(sandbox.runDir, 'research.md'), '# Research digest — canned\n')
  write(join(sandbox.runDir, 'reviews', 'plan-round-1.md'), ROUND_RECORD)
}

function baseDeliverable(slug: string, kebab: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'D1',
    title: 'Canned deliverable',
    deps: [],
    repo: 'calc',
    status: 'pending',
    branch: `strapped/${slug}/D1-${kebab}`,
    base: 'main',
    worktree: null,
    pr: null,
    review_rounds_used: 0,
    feedback_rounds_used: 0,
    parked_reason: null,
    estimated_diff_lines: 10,
    ...over,
  }
}

/** Build the canned GOOD full-pipeline outcome (plan+implement+pr artifacts). */
function goodFullPipeline(): { sandbox: ScenarioSandbox; outcome: ScenarioOutcome; worktree: string } {
  const sandbox = buildSandbox(fullPipelineScenario)
  const wt = addWorktree(sandbox, 'strapped/full-pipeline/D1-subtract')
  write(join(wt, 'src', 'calc.ts'), GOOD_CALC)
  write(join(wt, 'tests', 'calc.test.ts'), GOOD_CALC_TEST)
  commitWorktree(wt, 'feat(full-pipeline): add subtract')
  seedPlanArtifacts(sandbox, {
    manifestStatus: 'implementing',
    basename: 'D1-subtract.md',
    deliverable: baseDeliverable('full-pipeline', 'subtract', { status: 'done', worktree: wt, review_rounds_used: 1 }),
  })
  write(join(sandbox.runDir, 'reviews', 'D1-code-round-1.md'), ROUND_RECORD)
  commitState(sandbox)
  const runResult = runResultFor(fullPipelineScenario, {
    plan: {
      converged: true,
      rounds: 1,
      deliverables: [{ id: 'D1', file: 'deliverables/D1-subtract.md', title: 'Canned deliverable', deps: [] }],
      outstanding: [],
      summary: 'one deliverable',
    },
    implement: IMPLEMENT_RESULT,
    pr: { dryRun: true, prs: [{ id: 'D1', url: null, skipped: true, reason: 'dry run' }], summary: 'dry run' },
  })
  return { sandbox, outcome: outcomeFor(fullPipelineScenario, sandbox, runResult), worktree: wt }
}

/** Build the canned GOOD plan-only outcome (plan artifacts only). */
function goodPlanOnly(): { sandbox: ScenarioSandbox; outcome: ScenarioOutcome } {
  const sandbox = buildSandbox(planOnlyScenario)
  seedPlanArtifacts(sandbox, {
    manifestStatus: 'in-review',
    basename: 'D1-subtract.md',
    deliverable: baseDeliverable('plan-only', 'subtract'),
  })
  commitState(sandbox)
  const runResult = runResultFor(planOnlyScenario, {
    plan: { converged: true, rounds: 1, deliverables: [], outstanding: [], summary: 'one deliverable' },
  })
  return { sandbox, outcome: outcomeFor(planOnlyScenario, sandbox, runResult) }
}

/** Flip a seeded stage-scoped runDir to the state a clean implement run leaves. */
function markImplemented(sandbox: ScenarioSandbox, basename: string, wt: string): void {
  patchFrontmatter(join(sandbox.runDir, 'deliverables', basename), {
    status: 'done',
    worktree: wt,
    review_rounds_used: 1,
  })
  patchFrontmatter(join(sandbox.runDir, 'manifest.md'), { status: 'implementing' })
  write(join(sandbox.runDir, 'reviews', 'D1-code-round-1.md'), ROUND_RECORD)
  commitState(sandbox)
}

/** Build the canned GOOD implement-only outcome over its seeded run state. */
function goodImplementOnly(): { sandbox: ScenarioSandbox; outcome: ScenarioOutcome } {
  const sandbox = buildSandbox(implementOnlyScenario)
  const wt = addWorktree(sandbox, 'strapped/implement-only/D1-subtract')
  write(join(wt, 'src', 'calc.ts'), GOOD_CALC)
  write(join(wt, 'tests', 'calc.test.ts'), GOOD_CALC_TEST)
  commitWorktree(wt, 'feat(implement-only): add subtract')
  markImplemented(sandbox, 'D1-subtract.md', wt)
  const runResult = runResultFor(implementOnlyScenario, { implement: IMPLEMENT_RESULT })
  return { sandbox, outcome: outcomeFor(implementOnlyScenario, sandbox, runResult) }
}

/** Build a canned review-loop outcome; `mutate` shapes the produced branch. */
function reviewLoopOutcome(mutate: (wt: string) => void): { sandbox: ScenarioSandbox; outcome: ScenarioOutcome } {
  const sandbox = buildSandbox(reviewLoopScenario)
  const wt = addWorktree(sandbox, 'strapped/review-loop/D1-fix-defects')
  mutate(wt)
  commitWorktree(wt, 'fix(review-loop): close the seeded defects')
  markImplemented(sandbox, 'D1-fix-defects.md', wt)
  const runResult = runResultFor(reviewLoopScenario, { implement: IMPLEMENT_RESULT })
  return { sandbox, outcome: outcomeFor(reviewLoopScenario, sandbox, runResult) }
}

/** A Spawn answering the CLI probe, and every agent/judge with an error envelope. */
function stubSpawn(): Spawn {
  return (_cmd, args) =>
    args.includes('--version')
      ? { status: 0, stdout: 'claude 2.1.207', stderr: '' }
      : { status: 0, stdout: JSON.stringify(errorEnvelope()), stderr: '' }
}

// --- scenario well-formedness ---------------------------------------------------

test('every scenario is well-formed: ids, tags, canonical stages, ask, rules, graders, fixtures', () => {
  assert.equal(scenarios.length, 8)
  const ids = scenarios.map(s => s.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  for (const s of scenarios) {
    assert.ok(s.id.length > 0)
    assert.ok(s.tags.includes('scenario'), `${s.id} carries the shared "scenario" tag`)
    assert.ok(s.stages.length > 0, `${s.id} has stages`)
    let prev = -1
    for (const stage of s.stages) {
      const idx = STAGE_ORDER.indexOf(stage)
      assert.ok(idx > prev, `${s.id}: stage "${stage}" unknown or out of canonical order`)
      prev = idx
    }
    assert.ok(s.ask.trim().length > 0, `${s.id} has an ask`)
    assert.ok(s.rules.length > 0, `${s.id} has rules`)
    for (const rule of s.rules) {
      assert.ok(rule.id.length > 0 && rule.source.length > 0 && rule.text.length > 0, `${s.id} rule ${rule.id}`)
    }
    assert.ok(s.correctness.length >= 1, `${s.id} has correctness graders`)
    assert.ok(s.repos.length >= 1, `${s.id} has a fixture repo`)
    for (const repo of s.repos) {
      const files = repo.files ?? {}
      assert.ok(Object.keys(files).length > 0, `${s.id}/${repo.name} fixture file map is non-empty`)
      assert.ok(repo.validations.length > 0, `${s.id}/${repo.name} declares validations`)
      const claudeMd = files['CLAUDE.md']
      assert.ok(claudeMd !== undefined, `${s.id}/${repo.name} fixture carries a CLAUDE.md`)
      for (const rule of s.rules) {
        assert.ok(claudeMd.includes(rule.text), `${s.id}: rule ${rule.id} appears verbatim in the fixture CLAUDE.md`)
      }
    }
    assert.ok(s.expect !== undefined, `${s.id} declares an expected end-state`)
    if (s.seedRunState !== undefined) {
      assert.ok(Object.keys(s.seedRunState.files).length > 0, `${s.id} seedRunState is non-empty`)
      assert.ok(s.seedRunState.files['manifest.md'] !== undefined, `${s.id} seeds a manifest`)
    }
  }
})

test('stage-scoped scenarios seed run state; plan-bearing scenarios do not', () => {
  assert.equal(fullPipelineScenario.seedRunState, undefined)
  assert.equal(planOnlyScenario.seedRunState, undefined)
  assert.ok(implementOnlyScenario.seedRunState !== undefined)
  assert.ok(reviewLoopScenario.seedRunState !== undefined)
  assert.ok(zeroRoundsScenario.seedRunState !== undefined)
  assert.ok(manyRulesScenario.seedRunState !== undefined)
  assert.ok(dirtyBranchScenario.seedRunState !== undefined)
  assert.ok(preconditionParkScenario.seedRunState !== undefined)
})

// --- loader + filter through the CLI --------------------------------------------

test('loadScenarios loads exactly the seven harness scenarios from the suite directory', async () => {
  const loaded = await loadScenarios(SCENARIOS_DIR)
  assert.deepEqual(loaded.map(s => s.id).sort(), ALL_IDS)
})

test('the imported scenario objects are identical to the suite export', () => {
  assert.ok(scenarios.includes(fullPipelineScenario))
  assert.ok(scenarios.includes(planOnlyScenario))
  assert.ok(scenarios.includes(implementOnlyScenario))
  assert.ok(scenarios.includes(reviewLoopScenario))
  assert.ok(scenarios.includes(zeroRoundsScenario))
  assert.ok(scenarios.includes(manyRulesScenario))
  assert.ok(scenarios.includes(dirtyBranchScenario))
  assert.ok(scenarios.includes(preconditionParkScenario))
})

test('the CLI loads the suite directory and --filter narrows by id and by tag', async () => {
  const rowsOf = (output: string): string[] =>
    (JSON.parse(output) as ScenarioReportJSON).rows.map(r => r.scenarioId).sort()

  const all = await main(['--scenarios', SCENARIOS_DIR, '--filter', 'scenario', '--json'], { spawn: stubSpawn() })
  assert.equal(all.code, 0)
  assert.deepEqual(rowsOf(all.output), ALL_IDS)

  const byId = await main(['--scenarios', SCENARIOS_DIR, '--filter', 'plan-only', '--json'], { spawn: stubSpawn() })
  assert.deepEqual(rowsOf(byId.output), ['plan-only'])

  const byTag = await main(['--scenarios', SCENARIOS_DIR, '--filter', 'implement', '--json'], { spawn: stubSpawn() })
  assert.deepEqual(rowsOf(byTag.output), ['dirty-branch', 'implement-only', 'many-rules', 'precondition-park', 'review-loop', 'zero-rounds'])

  const byLoopTag = await main(['--scenarios', SCENARIOS_DIR, '--filter', 'review-loop', '--json'], {
    spawn: stubSpawn(),
  })
  assert.deepEqual(rowsOf(byLoopTag.output), ['review-loop'])

  const none = await main(['--scenarios', SCENARIOS_DIR, '--filter', 'nope'], { spawn: stubSpawn() })
  assert.equal(none.code, 0)
  assert.match(none.output, /no scenarios matched/)
})

// --- canned good/bad discrimination per scenario --------------------------------

test('full-pipeline: canned good grades 1/1; validation-failing code grades below 1', () => {
  const { sandbox, outcome, worktree } = goodFullPipeline()
  try {
    const good = grade(outcome)
    assert.equal(good.correctness, 1, describeGrades(good.correctnessGrades))
    assert.equal(good.adherence, 1, describeGrades(good.adherenceGrades))

    write(join(worktree, 'src', 'calc.ts'), BROKEN_CALC)
    const bad = grade(outcome)
    assert.ok(bad.correctness < 1, 'broken worktree code must dent correctness')
    assert.equal(byName(bad.correctnessGrades, 'fixture-validations-green').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

test('full-pipeline: a non-dry-run pr result fails the pr grader', () => {
  const { sandbox, outcome } = goodFullPipeline()
  try {
    const runResult = runResultFor(fullPipelineScenario, {
      ...(outcome.runResult as { results: Record<string, unknown> }).results,
      pr: { dryRun: false, prs: [], summary: 'pushed for real' },
    })
    const bad = grade(outcomeFor(fullPipelineScenario, sandbox, runResult))
    assert.ok(bad.correctness < 1)
    assert.equal(byName(bad.correctnessGrades, 'pr-dry-run-entries').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

test('plan-only: canned good grades 1/1; a missing round record dents both axes', () => {
  const { sandbox, outcome } = goodPlanOnly()
  try {
    const good = grade(outcome)
    assert.equal(good.correctness, 1, describeGrades(good.correctnessGrades))
    assert.equal(good.adherence, 1, describeGrades(good.adherenceGrades))

    unlinkSync(join(sandbox.runDir, 'reviews', 'plan-round-1.md'))
    const bad = grade(outcome)
    assert.ok(bad.correctness < 1, 'missing plan-round-1.md must dent correctness')
    assert.equal(byName(bad.correctnessGrades, 'plan-round-record').pass, false)
    assert.ok(bad.adherence < 1, 'missing plan-round-1.md must dent adherence too')
    assert.equal(byName(bad.adherenceGrades, 'adherence:plan-review-records').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

test('implement-only: canned good grades 1/1; a not-done deliverable grades below 1', () => {
  const { sandbox, outcome } = goodImplementOnly()
  try {
    const good = grade(outcome)
    assert.equal(good.correctness, 1, describeGrades(good.correctnessGrades))
    assert.equal(good.adherence, 1, describeGrades(good.adherenceGrades))

    patchFrontmatter(join(sandbox.runDir, 'deliverables', 'D1-subtract.md'), { status: 'in-progress' })
    const bad = grade(outcome)
    assert.ok(bad.correctness < 1, 'a deliverable stuck before done must dent correctness')
    assert.equal(byName(bad.correctnessGrades, 'deliverable-done-with-commit').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

/** Build the canned GOOD zero-rounds outcome: done, zero rounds, NO round record. */
function goodZeroRounds(): { sandbox: ScenarioSandbox; outcome: ScenarioOutcome } {
  const sandbox = buildSandbox(zeroRoundsScenario)
  const wt = addWorktree(sandbox, 'strapped/zero-rounds/D1-subtract')
  write(join(wt, 'src', 'calc.ts'), GOOD_CALC)
  write(join(wt, 'tests', 'calc.test.ts'), GOOD_CALC_TEST)
  commitWorktree(wt, 'feat(zero-rounds): add subtract')
  patchFrontmatter(join(sandbox.runDir, 'deliverables', 'D1-subtract.md'), {
    status: 'done',
    worktree: wt,
    review_rounds_used: 0,
  })
  patchFrontmatter(join(sandbox.runDir, 'manifest.md'), { status: 'implementing' })
  commitState(sandbox)
  const runResult = runResultFor(zeroRoundsScenario, { implement: IMPLEMENT_RESULT })
  return { sandbox, outcome: outcomeFor(zeroRoundsScenario, sandbox, runResult) }
}

test('zero-rounds: canned good grades 1/1; a round record, or a non-done status, fails its grader', () => {
  const { sandbox, outcome } = goodZeroRounds()
  try {
    const good = grade(outcome)
    assert.equal(good.correctness, 1, describeGrades(good.correctnessGrades))
    assert.equal(good.adherence, 1, describeGrades(good.adherenceGrades))

    // Any round record at budget 0 means review ran — the cost floor is broken.
    write(join(sandbox.runDir, 'reviews', 'D1-code-round-1.md'), ROUND_RECORD)
    const withRecord = grade(outcome)
    assert.ok(withRecord.adherence < 1, 'a round record at budget 0 must dent adherence')
    assert.equal(byName(withRecord.adherenceGrades, 'adherence:no-round-records').pass, false)
    unlinkSync(join(sandbox.runDir, 'reviews', 'D1-code-round-1.md'))

    // A green node the harness failed to send to done (e.g. the old
    // budget-exhausted park path) fails both axes.
    patchFrontmatter(join(sandbox.runDir, 'deliverables', 'D1-subtract.md'), { status: 'parked' })
    const notDone = grade(outcome)
    assert.ok(notDone.correctness < 1)
    assert.equal(byName(notDone.correctnessGrades, 'done-with-zero-rounds').pass, false)
    assert.ok(notDone.adherence < 1)
    assert.equal(byName(notDone.adherenceGrades, 'adherence:deliverable-end-state').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

test('zero-rounds: a non-zero review_rounds_used fails done-with-zero-rounds', () => {
  const { sandbox, outcome } = goodZeroRounds()
  try {
    patchFrontmatter(join(sandbox.runDir, 'deliverables', 'D1-subtract.md'), { review_rounds_used: 1 })
    const graded = grade(outcome)
    assert.ok(graded.correctness < 1)
    assert.equal(byName(graded.correctnessGrades, 'done-with-zero-rounds').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

// --- seeded state stands on the real state.mjs -----------------------------------

for (const scenario of [implementOnlyScenario, reviewLoopScenario, zeroRoundsScenario, manyRulesScenario, dirtyBranchScenario]) {
  test(`${scenario.id}: the seeded runDir is accepted by the real state.mjs dag with D1 ready`, () => {
    const sandbox = buildSandbox(scenario)
    try {
      const res = spawnSync(NODE, [STATE_MJS, 'dag', sandbox.runDir], { encoding: 'utf8' })
      assert.equal(res.status, 0, res.stderr)
      const dag = JSON.parse(res.stdout) as {
        manifest: { status: string }
        ready: unknown[]
        remaining: number
      }
      assert.deepEqual(dag.ready, ['D1'], 'the seeded node must be ready')
      assert.equal(dag.remaining, 1)
      assert.equal(dag.manifest.status, 'approved')

      // The materialized manifest's repos map carries existing absolute sandbox paths.
      const { data } = readFrontmatterFile(join(sandbox.runDir, 'manifest.md'), raise)
      const repos = data.repos as Array<{ name?: unknown; root?: unknown; config?: unknown }>
      assert.ok(Array.isArray(repos) && repos.length === 1)
      const entry = repos[0]
      assert.ok(entry !== undefined)
      assert.equal(entry.name, 'calc')
      assert.ok(typeof entry.root === 'string' && isAbsolute(entry.root) && existsSync(entry.root))
      assert.equal(entry.root, sandbox.repos[0]?.root)
      assert.ok(typeof entry.config === 'string' && isAbsolute(entry.config) && existsSync(entry.config))
      assert.equal(entry.config, sandbox.repos[0]?.configPath)

      // The seeded deliverable parses with the conventions' frontmatter shape.
      const files = scenario.seedRunState === undefined ? [] : Object.keys(scenario.seedRunState.files)
      const deliverableRel = files.find(f => f.startsWith('deliverables/'))
      assert.ok(deliverableRel !== undefined)
      const deliverable = readFrontmatterFile(join(sandbox.runDir, deliverableRel), raise)
      assert.equal(deliverable.data.id, 'D1')
      assert.equal(deliverable.data.status, 'pending')
      assert.equal(deliverable.data.repo, 'calc')
      assert.match(String(deliverable.data.branch), new RegExp(`^strapped/${sandbox.slug}/D1-`))
    } finally {
      removeSandbox(sandbox)
    }
  })
}

// --- review-loop anti-saturation discrimination ----------------------------------

test('review-loop: defects fixed + nits untouched + small churn grades 1/1', () => {
  const { sandbox, outcome } = reviewLoopOutcome(wt => {
    write(join(wt, 'src', 'calc.ts'), FIXED_DEFECT_CALC)
  })
  try {
    const good = grade(outcome)
    assert.equal(good.correctness, 1, describeGrades(good.correctnessGrades))
    assert.equal(good.adherence, 1, describeGrades(good.adherenceGrades))
  } finally {
    removeSandbox(sandbox)
  }
})

test('review-loop: an unfixed defect fails defect-tests-green and only that grader', () => {
  const { sandbox, outcome } = reviewLoopOutcome(wt => {
    write(join(wt, 'src', 'calc.ts'), PARTIALLY_FIXED_CALC)
  })
  try {
    const graded = grade(outcome)
    assert.ok(graded.correctness < 1)
    assert.equal(byName(graded.correctnessGrades, 'defect-tests-green').pass, false)
    assert.equal(byName(graded.correctnessGrades, 'nits-untouched').pass, true)
    assert.equal(byName(graded.correctnessGrades, 'churn-within-threshold').pass, true)
    assert.equal(byName(graded.correctnessGrades, 'converged-within-budget').pass, true)
  } finally {
    removeSandbox(sandbox)
  }
})

test('review-loop: a churned nit site fails nits-untouched and only that grader', () => {
  const { sandbox, outcome } = reviewLoopOutcome(wt => {
    write(join(wt, 'src', 'calc.ts'), FIXED_DEFECT_CALC)
    write(join(wt, 'src', 'quirks.ts'), CHURNED_QUIRKS)
  })
  try {
    const graded = grade(outcome)
    assert.ok(graded.correctness < 1)
    assert.equal(byName(graded.correctnessGrades, 'nits-untouched').pass, false)
    assert.equal(byName(graded.correctnessGrades, 'defect-tests-green').pass, true)
    assert.equal(byName(graded.correctnessGrades, 'churn-within-threshold').pass, true)
  } finally {
    removeSandbox(sandbox)
  }
})

test('review-loop: excess total churn fails churn-within-threshold and only that grader', () => {
  const filler = Array.from({ length: CHURN_THRESHOLD_LINES + 10 }, (_, i) => `export const filler${i} = ${i}`).join(
    '\n'
  )
  const { sandbox, outcome } = reviewLoopOutcome(wt => {
    write(join(wt, 'src', 'calc.ts'), FIXED_DEFECT_CALC)
    write(join(wt, 'src', 'extra.ts'), `${filler}\n`)
  })
  try {
    const graded = grade(outcome)
    assert.ok(graded.correctness < 1)
    assert.equal(byName(graded.correctnessGrades, 'churn-within-threshold').pass, false)
    assert.equal(byName(graded.correctnessGrades, 'defect-tests-green').pass, true)
    assert.equal(byName(graded.correctnessGrades, 'nits-untouched').pass, true)
  } finally {
    removeSandbox(sandbox)
  }
})

// --- many-rules rules-as-files discrimination ------------------------------------

/** The seeded round-1 id split the many-rules record must carry verbatim. */
const MANY_RULES_SPLIT = (() => {
  const split = splitRules(MANY_RULES, manyRulesScenario.seed, 1)[0]
  assert.ok(split !== undefined)
  return split
})()

/** Canned many-rules outcome: fixed worktree + a round record with the given id split. */
function manyRulesOutcome(
  calc: string,
  record: { a: string[]; b: string[] }
): { sandbox: ScenarioSandbox; outcome: ScenarioOutcome } {
  const sandbox = buildSandbox(manyRulesScenario)
  const wt = addWorktree(sandbox, 'strapped/many-rules/D1-fix-defects')
  write(join(wt, 'src', 'calc.ts'), calc)
  commitWorktree(wt, 'fix(many-rules): close the seeded defects')
  markImplemented(sandbox, 'D1-fix-defects.md', wt)
  writeFrontmatterFile(
    join(sandbox.runDir, 'reviews', 'D1-code-round-1.md'),
    {
      round: 1,
      seed_used: manyRulesScenario.seed + 1,
      reviewer_a_rules: record.a,
      reviewer_b_rules: record.b,
      new_confirmed: 0,
      outcome: 'converged',
      findings: [],
    },
    'no confirmed findings; both rule checklists returned in full\n'
  )
  const runResult = runResultFor(manyRulesScenario, { implement: IMPLEMENT_RESULT })
  return { sandbox, outcome: outcomeFor(manyRulesScenario, sandbox, runResult) }
}

test('many-rules: the fixture is genuinely 30 rules and the seeded split covers every id exactly once', () => {
  assert.equal(MANY_RULES.length, 30)
  assert.equal(new Set(MANY_RULES.map(r => r.id)).size, 30)
  assert.deepEqual([...MANY_RULES_SPLIT.a, ...MANY_RULES_SPLIT.b].sort(), MANY_RULES.map(r => r.id).sort())
})

test('many-rules: canned good (fixed defects + full per-id record) grades 1/1', () => {
  const { sandbox, outcome } = manyRulesOutcome(FIXED_DEFECT_CALC, MANY_RULES_SPLIT)
  try {
    const good = grade(outcome)
    assert.equal(good.correctness, 1, describeGrades(good.correctnessGrades))
    assert.equal(good.adherence, 1, describeGrades(good.adherenceGrades))
  } finally {
    removeSandbox(sandbox)
  }
})

test('many-rules: a round record missing assigned ids fails rule-ids-recorded and only that grader', () => {
  const truncated = { a: MANY_RULES_SPLIT.a.slice(0, 3), b: MANY_RULES_SPLIT.b }
  const { sandbox, outcome } = manyRulesOutcome(FIXED_DEFECT_CALC, truncated)
  try {
    const graded = grade(outcome)
    assert.equal(graded.correctness, 1, describeGrades(graded.correctnessGrades))
    assert.ok(graded.adherence < 1)
    assert.equal(byName(graded.adherenceGrades, 'adherence:rule-ids-recorded').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

test('many-rules: an unfixed defect fails defect-tests-green and only that grader', () => {
  const { sandbox, outcome } = manyRulesOutcome(PARTIALLY_FIXED_CALC, MANY_RULES_SPLIT)
  try {
    const graded = grade(outcome)
    assert.ok(graded.correctness < 1)
    assert.equal(byName(graded.correctnessGrades, 'defect-tests-green').pass, false)
    assert.equal(byName(graded.correctnessGrades, 'converged-within-budget').pass, true)
    assert.equal(byName(graded.adherenceGrades, 'adherence:rule-ids-recorded').pass, true)
  } finally {
    removeSandbox(sandbox)
  }
})

// --- dirty-branch finding-heavy discrimination -----------------------------------

/** The fixed calc the implementer produces on the seeded branch. */
const FIXED_CALC = `export function add(a: number, b: number): number {
  return a + b
}

export function max(a: number, b: number): number {
  return a > b ? a : b
}

export function greet(name: string): string {
  return \`Hello, \${name}\`
}
`

/** All five report flaws fixed: guidelines hold, dead export gone, test kept green. */
const CLEANED_DIRTY_REPORT = `let reportCount = 0

export function formatReport(name: string, total: number): string {
  reportCount = reportCount + 1
  return \`Report for \${name}: \${total}\`
}
`

/** Report test green but the guideline flaws (comment, var, …) remain. */
const HALF_CLEANED_DIRTY_REPORT = `// TODO: tidy before shipping
var reportCount = 0

export function formatReport(name: string, total: number) {
  reportCount = reportCount + 1
  return "Report for " + name + ": " + total
}
`

const DIRTY_FINDINGS = [
  { id: 'r1-a-f1', key: 'DR-1:src/report.ts', severity: 'blocking', verdict: 'confirmed', confidence: 90, status: 'fixed' },
  { id: 'r1-b-f1', key: 'DR-4:src/report.ts', severity: 'concern', verdict: 'confirmed', confidence: 85, status: 'fixed' },
]

/** Canned dirty-branch outcome: mutated worktree + a round record with the given findings. */
function dirtyBranchOutcome(
  report: string,
  findings: unknown[]
): { sandbox: ScenarioSandbox; outcome: ScenarioOutcome } {
  const sandbox = buildSandbox(dirtyBranchScenario)
  const wt = addWorktree(sandbox, 'strapped/dirty-branch/D1-green-tests')
  write(join(wt, 'src', 'calc.ts'), FIXED_CALC)
  write(join(wt, 'src', 'report.ts'), report)
  commitWorktree(wt, 'fix(dirty-branch): green the tests and clean the flaws')
  markImplemented(sandbox, 'D1-green-tests.md', wt)
  writeFrontmatterFile(
    join(sandbox.runDir, 'reviews', 'D1-code-round-1.md'),
    {
      round: 1,
      seed_used: dirtyBranchScenario.seed + 1,
      reviewer_a_rules: ['DR-1', 'DR-2', 'DR-3'],
      reviewer_b_rules: ['DR-4', 'DR-5', 'DR-6'],
      new_confirmed: findings.length,
      outcome: 'revise',
      findings,
    },
    'full finding bodies\n'
  )
  const runResult = runResultFor(dirtyBranchScenario, { implement: IMPLEMENT_RESULT })
  return { sandbox, outcome: outcomeFor(dirtyBranchScenario, sandbox, runResult) }
}

test('dirty-branch: the seeded repo is genuinely red and every flaw probe fails as seeded', () => {
  const sandbox = buildSandbox(dirtyBranchScenario)
  try {
    const repo = sandbox.repos[0]
    assert.ok(repo !== undefined)
    const res = spawnSync('bun', ['test'], { cwd: repo.root, encoding: 'utf8' })
    assert.notEqual(res.status, 0, 'the seeded fixture tests must fail until the defects are fixed')
    const shown = spawnSync('git', ['show', 'strapped/dirty-branch/D1-green-tests:src/report.ts'], { cwd: repo.root, encoding: 'utf8' })
    assert.equal(shown.status, 0, 'the seeded branch must pre-exist with src/report.ts committed')
    for (const [name, probe] of Object.entries(FLAW_PROBES)) {
      assert.equal(probe(shown.stdout), false, `flaw probe "${name}" must fail on the seeded branch file`)
    }
    for (const [name, probe] of Object.entries(FLAW_PROBES)) {
      assert.equal(probe(CLEANED_DIRTY_REPORT), true, `flaw probe "${name}" must pass on the cleaned file`)
    }
  } finally {
    removeSandbox(sandbox)
  }
})

test('dirty-branch: canned good (flaws fixed + per-finding verdicts recorded) grades 1/1', () => {
  const { sandbox, outcome } = dirtyBranchOutcome(CLEANED_DIRTY_REPORT, DIRTY_FINDINGS)
  try {
    const good = grade(outcome)
    assert.equal(good.correctness, 1, describeGrades(good.correctnessGrades))
    assert.equal(good.adherence, 1, describeGrades(good.adherenceGrades))
  } finally {
    removeSandbox(sandbox)
  }
})

test('dirty-branch: surviving guideline flaws fail flaws-cleaned and only that grader', () => {
  const { sandbox, outcome } = dirtyBranchOutcome(HALF_CLEANED_DIRTY_REPORT, DIRTY_FINDINGS)
  try {
    const graded = grade(outcome)
    assert.ok(graded.correctness < 1)
    assert.equal(byName(graded.correctnessGrades, 'flaws-cleaned').pass, false)
    assert.equal(byName(graded.correctnessGrades, 'defect-tests-green').pass, true)
    assert.equal(byName(graded.correctnessGrades, 'churn-within-threshold').pass, true)
  } finally {
    removeSandbox(sandbox)
  }
})

test('dirty-branch: a findings-free round record fails per-finding-verdicts (review never saw the dirt)', () => {
  const { sandbox, outcome } = dirtyBranchOutcome(CLEANED_DIRTY_REPORT, [])
  try {
    const graded = grade(outcome)
    assert.equal(graded.correctness, 1, describeGrades(graded.correctnessGrades))
    assert.ok(graded.adherence < 1)
    assert.equal(byName(graded.adherenceGrades, 'adherence:per-finding-verdicts').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

test('dirty-branch: findings without cast verdicts fail per-finding-verdicts', () => {
  const voteless = [{ id: 'r1-a-f1', key: 'DR-1:src/report.ts', severity: 'blocking', status: 'open' }]
  const { sandbox, outcome } = dirtyBranchOutcome(CLEANED_DIRTY_REPORT, voteless)
  try {
    const graded = grade(outcome)
    assert.equal(byName(graded.adherenceGrades, 'adherence:per-finding-verdicts').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

// --- precondition-park park-don't-improvise discrimination -----------------------

/** Create a real git worktree for a node in a NAMED repo and return its path. */
function addWorktreeIn(sandbox: ScenarioSandbox, repoName: string, id: string, branch: string): string {
  const repo = sandbox.repos.find(r => r.name === repoName)
  assert.ok(repo !== undefined, `sandbox has repo ${repoName}`)
  const wt = join(repo.worktreeRoot, sandbox.slug, id)
  mkdirSync(dirname(wt), { recursive: true })
  const exists = spawnSync('git', ['rev-parse', '--verify', '-q', branch], { cwd: repo.root }).status === 0
  if (exists) git(repo.root, 'worktree', 'add', '-q', wt, branch)
  else git(repo.root, 'worktree', 'add', '-q', wt, '-b', branch, 'main')
  return wt
}

const PARKED_REASON =
  'unmet precondition: vendor/helper.ts has not landed on svc-b main via the external landing step'

/** Canned GOOD precondition-park outcome: D2 parked naming the precondition, tree untouched. */
function goodPreconditionPark(): { sandbox: ScenarioSandbox; outcome: ScenarioOutcome; worktree: string } {
  const sandbox = buildSandbox(preconditionParkScenario)
  const wt = addWorktreeIn(sandbox, 'svc-b', 'D2', 'strapped/precondition-park/D2-consume-helper')
  patchFrontmatter(join(sandbox.runDir, 'deliverables', 'D2-consume-helper.md'), {
    status: 'parked',
    worktree: wt,
    parked_reason: PARKED_REASON,
  })
  patchFrontmatter(join(sandbox.runDir, 'manifest.md'), { status: 'implementing' })
  commitState(sandbox)
  const runResult = {
    slug: 'precondition-park',
    stages: ['implement'],
    completed: [],
    stoppedAt: 'implement',
    results: {
      implement: {
        allDone: false,
        outcomes: [{ id: 'D2', outcome: 'parked', roundsUsed: 0, parkedReason: PARKED_REASON }],
        blocked: [],
      },
    },
  }
  return { sandbox, outcome: outcomeFor(preconditionParkScenario, sandbox, runResult), worktree: wt }
}

test('precondition-park: the seeded two-repo runDir is accepted by the real state.mjs dag with D2 ready', () => {
  const sandbox = buildSandbox(preconditionParkScenario)
  try {
    const res = spawnSync(NODE, [STATE_MJS, 'dag', sandbox.runDir], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    const dag = JSON.parse(res.stdout) as {
      manifest: { status: string }
      ready: unknown[]
      remaining: number
      nodes: Array<{ id: string; status: string }>
    }
    assert.deepEqual(dag.ready, ['D2'], 'the child must be ready — its parent is done')
    assert.equal(dag.remaining, 1, 'the done parent counts complete')
    assert.equal(dag.manifest.status, 'approved')
    assert.equal(dag.nodes.find(n => n.id === 'D1')?.status, 'done')

    // The materialized manifest carries BOTH repos as existing absolute paths.
    const { data } = readFrontmatterFile(join(sandbox.runDir, 'manifest.md'), raise)
    const repos = data.repos as Array<{ name?: unknown; root?: unknown; config?: unknown }>
    assert.ok(Array.isArray(repos) && repos.length === 2)
    for (const entry of repos) {
      assert.ok(typeof entry.root === 'string' && isAbsolute(entry.root) && existsSync(entry.root))
      assert.ok(typeof entry.config === 'string' && isAbsolute(entry.config) && existsSync(entry.config))
    }

    // D1's branch pre-exists in svc-a with the helper committed.
    const svcA = sandbox.repos.find(r => r.name === 'svc-a')
    assert.ok(svcA !== undefined)
    const shown = spawnSync('git', ['show', 'strapped/precondition-park/D1-shared-helper:src/helper.ts'], {
      cwd: svcA.root,
      encoding: 'utf8',
    })
    assert.equal(shown.status, 0, 'the seeded D1 branch must carry src/helper.ts')

    // The declared precondition is genuinely UNMET in the sandbox.
    const svcB = sandbox.repos.find(r => r.name === 'svc-b')
    assert.ok(svcB !== undefined)
    assert.ok(!existsSync(join(svcB.root, 'vendor', 'helper.ts')), 'vendor/helper.ts must be absent on svc-b main')
  } finally {
    removeSandbox(sandbox)
  }
})

test('precondition-park: canned good (parked child naming the precondition, untouched tree) grades 1/1', () => {
  const { sandbox, outcome } = goodPreconditionPark()
  try {
    const good = grade(outcome)
    assert.equal(good.correctness, 1, describeGrades(good.correctnessGrades))
    assert.equal(good.adherence, 1, describeGrades(good.adherenceGrades))
  } finally {
    removeSandbox(sandbox)
  }
})

test('precondition-park: an implemented child (improvised around the precondition) fails its graders', () => {
  const { sandbox, outcome, worktree } = goodPreconditionPark()
  try {
    write(
      join(worktree, 'vendor', 'helper.ts'),
      'export function describeSum(a: number, b: number): string {\n  return `sum: ${a + b}`\n}\n'
    )
    commitWorktree(worktree, 'feat(precondition-park): vendor the helper and implement anyway')
    patchFrontmatter(join(sandbox.runDir, 'deliverables', 'D2-consume-helper.md'), {
      status: 'done',
      parked_reason: null,
    })
    const bad = grade(outcome)
    assert.ok(bad.correctness < 1)
    assert.equal(byName(bad.correctnessGrades, 'child-tree-untouched').pass, false)
    assert.ok(bad.adherence < 1)
    assert.equal(byName(bad.adherenceGrades, 'adherence:deliverable-end-state').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

test('precondition-park: a parked child with an EMPTY parked_reason fails the reason-naming graders', () => {
  const { sandbox, outcome } = goodPreconditionPark()
  try {
    patchFrontmatter(join(sandbox.runDir, 'deliverables', 'D2-consume-helper.md'), { parked_reason: '' })
    const bad = grade(outcome)
    assert.ok(bad.correctness < 1)
    assert.equal(byName(bad.correctnessGrades, 'child-parked-naming-precondition').pass, false)
    assert.equal(byName(bad.correctnessGrades, 'child-tree-untouched').pass, true)
    assert.ok(bad.adherence < 1)
    assert.equal(byName(bad.adherenceGrades, 'adherence:deliverable-end-state').pass, false)
  } finally {
    removeSandbox(sandbox)
  }
})

test('the seeded defect repo is genuinely red before the fix (the tests expose the defects)', () => {
  const sandbox = buildSandbox(reviewLoopScenario)
  try {
    const repo = sandbox.repos[0]
    assert.ok(repo !== undefined)
    const res = spawnSync('bun', ['test'], { cwd: repo.root, encoding: 'utf8' })
    assert.notEqual(res.status, 0, 'the seeded fixture tests must fail until the defects are fixed')
    // Every nit site is present as seeded.
    for (const [rel, content] of Object.entries(NIT_SITES)) {
      assert.equal(readFileSync(join(repo.root, rel), 'utf8'), content)
    }
  } finally {
    removeSandbox(sandbox)
  }
})

// --- docs -----------------------------------------------------------------------

test('conventions.md stays user-facing: no contributor-only guidance survives there', () => {
  const conventions = readFileSync(CONVENTIONS_MD, 'utf8')
  assert.ok(!conventions.includes('only `--ab` gates'), 'the stale "only --ab gates" claim must not survive')
  assert.ok(!conventions.includes('Prompt evaluation suite'), 'the eval-suite section is contributor-only and lives in CONTRIBUTING.md')
  assert.ok(!conventions.includes('Scenario evaluations'), 'scenario-eval guidance is contributor-only and lives in CONTRIBUTING.md')
  assert.ok(!conventions.includes('Workflow nesting limit'), 'the nesting-limit record is contributor-only and lives in CONTRIBUTING.md')
})

test('CONTRIBUTING.md documents the eval layers and no longer claims only --ab gates', () => {
  const contributing = readFileSync(CONTRIBUTING_MD, 'utf8')
  assert.ok(!contributing.includes('only `--ab` gates'), 'the stale "only --ab gates" claim must not survive')
  assert.match(contributing, /only `--ab` and scenario `--compare` gate/)
  assert.match(contributing, /Scenario evaluations/)
  assert.match(contributing, /--scenarios src\/eval\/scenarios\/harness/)
  assert.match(contributing, /SERIALIZED sum of agent calls/)
  assert.match(contributing, /Workflow nesting limit/)
})

test('CONTRIBUTING.md documents the per-node baseline-vs-candidate runbook with --deployable scoped', () => {
  const contributing = readFileSync(CONTRIBUTING_MD, 'utf8')
  assert.match(contributing, /Per-node baseline-vs-candidate runbook/)
  assert.match(contributing, /git worktree add .*baseline/)
  assert.match(contributing, /self-consistent/)
  assert.match(contributing, /--compare .*--tolerance/)
  assert.match(contributing, /--deployable/)
  assert.match(contributing, /contract-compatible/)
})

test('CLAUDE.md documents the scenario layer, the compare workflow, and the cost warning', () => {
  const claudeMd = readFileSync(CLAUDE_MD, 'utf8')
  assert.match(claudeMd, /--scenarios src\/eval\/scenarios\/harness/)
  assert.match(claudeMd, /--compare/)
  assert.match(claudeMd, /PER SCENARIO/)
})
