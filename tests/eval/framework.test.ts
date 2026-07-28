// Framework tests: built-in graders + gradeCase aggregation, the runner's
// runCase/runSuite/runAB/runMatrix over canned envelopes, the bounded-parallel
// pool, report text/JSON, and the CLI exit-code semantics (regression vs clean
// vs CLI-absent). Every model call is faked at the `Spawn` boundary — offline, no
// real `claude`.

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { defineCase, toRequest, type EvalCase } from '../../src/eval/case.ts'
import { assert as assertGrader, gradeCase, judge, schemaConforms, type Grader } from '../../src/eval/grade.ts'
import {
  mapPool,
  runAB,
  runCase,
  runMatrix,
  runSuite,
  type ABResult,
  type CaseResult,
} from '../../src/eval/runner.ts'
import { formatReport, projectCost, toJSON, type Report } from '../../src/eval/report.ts'
import { abExitCode, main, loadSuite, parseArgs } from '../../src/eval/cli.ts'
import type { EvalResult, JsonSchema, Spawn } from '../../src/eval/types.ts'
import { successEnvelope, throwingSpawn } from '../helpers/fake-claude.ts'

const SCHEMA: JsonSchema = {
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'number' } },
  additionalProperties: false,
}

/** A minimal ok result carrying the given output — for grading graders directly. */
function okResult(output: unknown): EvalResult {
  return {
    ok: true,
    output,
    error: null,
    cost: 0.01,
    usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    durationMs: 1000,
    apiDurationMs: 950,
    numTurns: 2,
    model: 'claude-haiku-4-5',
    cached: false,
  }
}

const baseCase = (overrides: Partial<EvalCase> = {}): EvalCase =>
  defineCase({
    id: 'add',
    tags: ['math'],
    prompt: 'What is 6 * 7?',
    schema: SCHEMA,
    graders: [schemaConforms(), assertGrader('is-42', o => (o as { answer?: number }).answer === 42)],
    ...overrides,
  })

// --- graders (acceptance criterion 2) ----------------------------------------

test('schemaConforms passes on an ok result and fails on a graded failure', () => {
  const pass = schemaConforms()(null, okResult({ answer: 42 }), {})
  assert.equal(pass.name, 'schemaConforms')
  assert.equal(pass.pass, true)
  assert.equal(pass.score, 1)

  const failResult = { ...okResult(null), ok: false, error: 'missing key' }
  const fail = schemaConforms()(null, failResult, {})
  assert.equal(fail.pass, false)
  assert.equal(fail.score, 0)
  assert.match(fail.detail, /missing key/)
})

test('assert grades a predicate, and a thrown predicate fails without propagating', () => {
  const pass = assertGrader('is-42', o => (o as { answer: number }).answer === 42)({ answer: 42 }, okResult({ answer: 42 }), {})
  assert.equal(pass.pass, true)
  assert.equal(pass.score, 1)

  const fail = assertGrader('is-42', o => (o as { answer: number }).answer === 42)({ answer: 1 }, okResult({ answer: 1 }), {})
  assert.equal(fail.pass, false)

  const threw = assertGrader('boom', () => {
    throw new Error('kaboom')
  })(null, okResult(null), {})
  assert.equal(threw.pass, false)
  assert.match(threw.detail, /kaboom/)
})

test('judge routes through the engine (stubbed) and maps the verdict to a GradeResult', () => {
  const verdictEnvelope = successEnvelope({ score: 0.8, pass: true, reason: 'clear and complete' })
  const spawn: Spawn = () => ({ status: 0, stdout: JSON.stringify(verdictEnvelope), stderr: '' })
  const grade = judge('Rate the answer 0..1.', { model: 'claude-haiku-4-5' })(
    { answer: 42 },
    okResult({ answer: 42 }),
    { spawn }
  )
  assert.equal(grade.name, 'judge')
  assert.equal(grade.pass, true)
  assert.equal(grade.score, 0.8)
  assert.match(grade.detail, /clear and complete/)
})

test('judge clamps an out-of-range score and fails gracefully when the engine errors', () => {
  const highSpawn: Spawn = () => ({
    status: 0,
    stdout: JSON.stringify(successEnvelope({ score: 5, pass: true, reason: 'over' })),
    stderr: '',
  })
  const clamped = judge('r', { model: 'm' })({ answer: 1 }, okResult({ answer: 1 }), { spawn: highSpawn })
  assert.equal(clamped.score, 1)

  const failed = judge('r', { model: 'm' })({ answer: 1 }, okResult({ answer: 1 }), { spawn: throwingSpawn() })
  assert.equal(failed.pass, false)
  assert.equal(failed.score, 0)
})

// --- gradeCase aggregation (acceptance criterion 2) --------------------------

test('gradeCase computes a weighted correctness across graders', () => {
  // One passing (weight 3) + one failing (weight 1) → 3/4 = 0.75.
  const graders: Grader[] = [
    assertGrader('a', () => true, { weight: 3 }),
    assertGrader('b', () => false, { weight: 1 }),
  ]
  const { correctness, grades } = gradeCase(graders, { answer: 42 }, okResult({ answer: 42 }))
  assert.equal(grades.length, 2)
  assert.equal(correctness, 0.75)
})

test('gradeCase with no graders is 0, not NaN', () => {
  const { correctness } = gradeCase([], null, okResult(null))
  assert.equal(correctness, 0)
})

// --- toRequest (case lowering) -----------------------------------------------

test('toRequest lowers a case to an EvalRequest and honours a prompt override', () => {
  const c = baseCase({ systemPrompt: 'terse', tools: ['Read'] })
  const req = toRequest(c, 'claude-opus-4-8', 'OVERRIDDEN')
  assert.equal(req.prompt, 'OVERRIDDEN')
  assert.equal(req.model, 'claude-opus-4-8')
  assert.equal(req.systemPrompt, 'terse')
  assert.deepEqual(req.tools, ['Read'])
  assert.equal(toRequest(c, 'm').prompt, 'What is 6 * 7?')
})

// --- runCase end-to-end (acceptance criterion 1) -----------------------------

test('runCase runs a case through the engine and surfaces correctness + envelope metrics', () => {
  const spawn: Spawn = () => ({
    status: 0,
    stdout: JSON.stringify(successEnvelope({ answer: 42 }, { cost: 0.0463, durationMs: 2419, numTurns: 2 })),
    stderr: '',
  })
  const r = runCase(baseCase(), { model: 'claude-haiku-4-5', spawn })
  assert.equal(r.caseId, 'add')
  assert.equal(r.correctness, 1) // both graders pass
  assert.equal(r.skipped, false)
  assert.equal(r.result.cost, 0.0463)
  assert.equal(r.result.durationMs, 2419)
  assert.equal(r.result.numTurns, 2)
})

test('runCase marks a case skipped (no failure) when the CLI is unavailable', () => {
  const r = runCase(baseCase(), { model: 'm', spawn: throwingSpawn() })
  assert.equal(r.skipped, true)
  assert.equal(r.grades.length, 0)
})

// --- bounded parallel pool (acceptance criterion 4) --------------------------

test('mapPool never exceeds the concurrency bound and preserves order', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const worker = (n: number): Promise<number> =>
    new Promise(resolve => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => {
        inFlight--
        resolve(n * 2)
      }, 5)
    })
  const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 2, worker)
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14])
  assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight}`)
})

test('runSuite fans a case set across models and returns one result per (case,model)', async () => {
  const spawn: Spawn = () => ({ status: 0, stdout: JSON.stringify(successEnvelope({ answer: 42 })), stderr: '' })
  const results = await runSuite([baseCase({ id: 'a' }), baseCase({ id: 'b' })], {
    models: ['claude-haiku-4-5', 'claude-sonnet-5'],
    concurrency: 2,
    spawn,
  })
  assert.equal(results.length, 4)
  assert.deepEqual(
    results.map(r => `${r.caseId}:${r.model}`),
    ['a:claude-haiku-4-5', 'a:claude-sonnet-5', 'b:claude-haiku-4-5', 'b:claude-sonnet-5']
  )
})

// --- runAB deltas (acceptance criterion 3) -----------------------------------

/** A spawn that returns a cheaper/faster/correct envelope for the candidate prompt. */
const abSpawn: Spawn = (_cmd, _args, input) => {
  const isCandidate = (input ?? '').includes('CANDIDATE')
  const env = isCandidate
    ? successEnvelope({ answer: 42 }, { cost: 0.01, durationMs: 800, numTurns: 1 })
    : successEnvelope({ answer: 42 }, { cost: 0.05, durationMs: 2000, numTurns: 3 })
  return { status: 0, stdout: JSON.stringify(env), stderr: '' }
}

test('runAB reports Δcorrectness/Δcost/Δlatency/Δturns (candidate cheaper/faster → positive)', () => {
  const ab = runAB(
    baseCase(),
    { label: 'baseline', prompt: 'BASELINE: what is 6*7?' },
    { label: 'candidate', prompt: 'CANDIDATE: what is 6*7?' },
    { model: 'claude-haiku-4-5', spawn: abSpawn }
  )
  assert.equal(ab.deltaCorrectness, 0) // both correct
  assert.ok(ab.deltaCostUsd > 0, 'candidate cheaper → positive Δcost')
  assert.ok(ab.deltaLatencyMs > 0, 'candidate faster → positive Δlatency')
  assert.ok(ab.deltaTurns > 0, 'candidate fewer turns → positive Δturns')
  assert.equal(ab.baselineLabel, 'baseline')
  assert.equal(ab.candidateLabel, 'candidate')
})

test('runAB surfaces a negative Δcorrectness when the candidate regresses', () => {
  // Candidate returns a wrong answer → its assertion grader fails.
  const regressSpawn: Spawn = (_c, _a, input) => {
    const answer = (input ?? '').includes('CANDIDATE') ? 0 : 42
    return { status: 0, stdout: JSON.stringify(successEnvelope({ answer })), stderr: '' }
  }
  const ab = runAB(
    baseCase(),
    { label: 'base', prompt: 'BASELINE q' },
    { label: 'cand', prompt: 'CANDIDATE q' },
    { model: 'm', spawn: regressSpawn }
  )
  assert.ok(ab.deltaCorrectness < 0, 'candidate wrong → negative Δcorrectness')
})

// --- runMatrix grid (acceptance criterion 3) ---------------------------------

test('runMatrix produces one row per model', async () => {
  const spawn: Spawn = () => ({ status: 0, stdout: JSON.stringify(successEnvelope({ answer: 42 })), stderr: '' })
  const grid = await runMatrix(baseCase(), ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'], { spawn })
  assert.equal(grid.rows.length, 3)
  assert.deepEqual(grid.rows.map(r => r.model), ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'])
  assert.ok(grid.rows.every(r => r.correctness === 1))
})

// --- report (acceptance criterion 5) -----------------------------------------

const sampleCaseResult = (id: string): CaseResult => ({
  caseId: id,
  model: 'claude-haiku-4-5',
  correctness: 1,
  grades: [],
  result: okResult({ answer: 42 }),
  skipped: false,
})

test('formatReport renders a stable suite text table with all three axes', () => {
  const report: Report = { mode: 'suite', cases: [sampleCaseResult('add')] }
  const text = formatReport(report)
  assert.match(text, /Case/)
  assert.match(text, /Correct/)
  assert.match(text, /Cost \$/)
  assert.match(text, /Latency/)
  assert.match(text, /100\.0%/)
  assert.match(text, /\$0\.01000/)
  assert.match(text, /1000ms/)
})

test('formatReport suite adds a clearly-labelled projected-cost column on request', () => {
  const report: Report = { mode: 'suite', cases: [sampleCaseResult('add')] }
  const text = formatReport(report, { projectModel: 'claude-opus-4-8' })
  assert.match(text, /Proj \$ \(claude-opus-4-8\)/)
})

test('projectCost uses the static table and returns null for an unpriced model', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  assert.equal(projectCost(usage, 'claude-haiku-4-5'), 6) // 1 + 5 per Mtok
  assert.equal(projectCost(usage, 'no-such-model'), null)
})

test('formatReport ab shows the delta columns and a trade-off legend', () => {
  const ab: ABResult = runAB(
    baseCase(),
    { label: 'base', prompt: 'BASELINE q' },
    { label: 'cand', prompt: 'CANDIDATE q' },
    { model: 'm', spawn: abSpawn }
  )
  const text = formatReport({ mode: 'ab', cases: [ab] })
  assert.match(text, /ΔCorrect/)
  assert.match(text, /ΔCost/)
  assert.match(text, /ΔLatency/)
  assert.match(text, /candidate cheaper\/faster/)
})

test('toJSON returns the machine-comparable report object', () => {
  const report: Report = { mode: 'suite', cases: [sampleCaseResult('add')] }
  const json = toJSON(report)
  assert.equal(json.mode, 'suite')
  // Round-trips through JSON.stringify (what --json emits).
  const parsed = JSON.parse(JSON.stringify(json)) as { mode: string; cases: unknown[] }
  assert.equal(parsed.mode, 'suite')
  assert.equal(parsed.cases.length, 1)
})

// --- CLI exit-code semantics (acceptance criterion 5) ------------------------

test('parseArgs reads every flag', () => {
  const f = parseArgs(['--suite', 'd', '--filter', 'planner', '--ab', '--models', 'a,b', '--json', '--tolerance', '5'])
  assert.equal(f.suite, 'd')
  assert.equal(f.filter, 'planner')
  assert.equal(f.ab, true)
  assert.deepEqual(f.models, ['a', 'b'])
  assert.equal(f.json, true)
  assert.equal(f.tolerance, 5)
})

test('abExitCode gates only on a regression past tolerance', () => {
  const mk = (delta: number): ABResult => ({
    caseId: 'c',
    model: 'm',
    baselineLabel: 'b',
    candidateLabel: 'c',
    baseline: sampleCaseResult('c'),
    candidate: sampleCaseResult('c'),
    deltaCorrectness: delta,
    deltaCostUsd: 0,
    deltaLatencyMs: 0,
    deltaTurns: 0,
  })
  // -3pp within a 5% tolerance → 0; -6pp past it → 1; an improvement → 0.
  assert.equal(abExitCode([mk(-0.03)], 5), 0)
  assert.equal(abExitCode([mk(-0.06)], 5), 1)
  assert.equal(abExitCode([mk(0.1)], 5), 0)
})

test('main skips-with-notice and exits 0 when claude is unavailable', async () => {
  const res = await main(['--suite', '/nonexistent', '--ab'], { spawn: throwingSpawn() })
  assert.equal(res.code, 0)
  assert.match(res.output, /unavailable/)
})

/** A spawn where `--version` succeeds (available) and runs return a success envelope. */
const availableSpawn = (envelope: unknown): Spawn => (_cmd, args) => {
  if (args.includes('--version')) return { status: 0, stdout: 'claude 2.1.207', stderr: '' }
  return { status: 0, stdout: JSON.stringify(envelope), stderr: '' }
}

test('main runs a plain suite (report-only, exit 0) over injected cases', async () => {
  const res = await main([], { spawn: availableSpawn(successEnvelope({ answer: 42 })), cases: [baseCase()] })
  assert.equal(res.code, 0)
  assert.match(res.output, /Correct/)
  assert.match(res.output, /add/)
})

test('main --json emits parseable machine JSON', async () => {
  const res = await main(['--json'], { spawn: availableSpawn(successEnvelope({ answer: 42 })), cases: [baseCase()] })
  const parsed = JSON.parse(res.output) as { mode: string }
  assert.equal(parsed.mode, 'suite')
})

test('main --ab exits 1 on a regression past tolerance and 0 when clean', async () => {
  const abCase = (): EvalCase =>
    baseCase({
      variants: { baseline: { label: 'base', prompt: 'BASELINE q' }, candidate: { label: 'cand', prompt: 'CANDIDATE q' } },
    })
  // Candidate wrong → regression → exit 1.
  const regressSpawn: Spawn = (_c, args, input) => {
    if (args.includes('--version')) return { status: 0, stdout: 'claude 2.1.207', stderr: '' }
    const answer = (input ?? '').includes('CANDIDATE') ? 0 : 42
    return { status: 0, stdout: JSON.stringify(successEnvelope({ answer })), stderr: '' }
  }
  const regressed = await main(['--ab', '--tolerance', '5'], { spawn: regressSpawn, cases: [abCase()] })
  assert.equal(regressed.code, 1)

  // Both correct → no regression → exit 0.
  const cleanSpawn: Spawn = (_c, args) => {
    if (args.includes('--version')) return { status: 0, stdout: 'claude 2.1.207', stderr: '' }
    return { status: 0, stdout: JSON.stringify(successEnvelope({ answer: 42 })), stderr: '' }
  }
  const clean = await main(['--ab', '--tolerance', '5'], { spawn: cleanSpawn, cases: [abCase()] })
  assert.equal(clean.code, 0)
})

test('main --filter selects by id or tag', async () => {
  const res = await main(['--json', '--filter', 'nope'], {
    spawn: availableSpawn(successEnvelope({ answer: 42 })),
    cases: [baseCase()],
  })
  assert.match(res.output, /no cases matched/)
})

// --- suite loading (integration: real dynamic import from a temp dir) --------

test('loadSuite dynamically imports case modules from a directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-suite-'))
  const casePath = join(import.meta.dir, '..', '..', 'src', 'eval', 'case.ts').replace(/\\/g, '/')
  writeFileSync(
    join(dir, 'sample.ts'),
    `import { defineCase } from '${casePath}'\n` +
      `export const cases = [defineCase({ id: 'loaded', tags: ['t'], prompt: 'p', schema: { type: 'object' }, graders: [] })]\n`
  )
  const cases = await loadSuite(dir)
  assert.equal(cases.length, 1)
  assert.equal(cases[0]?.id, 'loaded')
})
