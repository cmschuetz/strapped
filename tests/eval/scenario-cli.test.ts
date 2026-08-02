// Scenario CLI mode + offline compare gating: drive `main(argv, deps)`
// with injected scenarios and a scripted per-label fake spawn — the workflow
// executed is the REAL shipped deployable; only the `claude` subprocess
// boundary is scripted, so everything here is fully offline.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { loadScenarios, main } from '../../src/eval/cli.ts'
import { artifactAssert } from '../../src/eval/scenario/grade.ts'
import type { ScenarioReportJSON } from '../../src/eval/scenario/compare.ts'
import { scenarioReportToJSON } from '../../src/eval/scenario/report.ts'
import type { ScenarioReportRow } from '../../src/eval/scenario/run.ts'
import type { Scenario } from '../../src/eval/scenario/types.ts'
import type { Spawn } from '../../src/eval/types.ts'
import { scriptedSpawn, successEnvelope, throwingSpawn, type ScriptedHandler } from '../helpers/fake-claude.ts'

// --- canned agent outputs for a converging plan-only run ----------------------

const NO_FINDINGS = {
  findings: [],
  rule_checklist: [{ rule: 'A1', verdict: 'pass', evidence: 'ok' }],
  ac_checklist: [],
}
const PLAN = {
  deliverables: [{ id: 'D1', file: 'deliverables/D1-thing.md', title: 'Thing', deps: [] }],
  summary: 'one deliverable covering the thing',
}
const PLAN_HANDLERS: Record<string, unknown> = {
  planner: PLAN,
  'plan-review:a:r1': NO_FINDINGS,
  'plan-review:b:r1': NO_FINDINGS,
  'consolidate:r1': { new_confirmed_ids: [], duplicate_ids: [] },
}

function envelopes(outputs: Record<string, unknown>): Record<string, ScriptedHandler> {
  return Object.fromEntries(
    Object.entries(outputs).map(([label, output]) => [label, successEnvelope(output, { cost: 0.01, numTurns: 2 })])
  )
}

/** The scripted spawn plus a `claude --version` probe answer (isAvailable). */
function probedSpawn(spawn: Spawn): Spawn {
  return (cmd, args, input, opts) =>
    args.includes('--version') ? { status: 0, stdout: 'claude 2.1.207', stderr: '' } : spawn(cmd, args, input, opts)
}

/** RunResult view the correctness grader below reads. */
interface PlanRunResult {
  results?: { plan?: { converged?: boolean } }
}

function planScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'cli-plan-only',
    tags: ['cli'],
    stages: ['plan'],
    ask: 'Add a subtract function and a test for it.',
    repos: [{ name: 'alpha', files: { 'CLAUDE.md': '# fixture' }, validations: ['bun test'] }],
    rules: [{ id: 'A1', source: 'CLAUDE.md', text: 'rule a' }],
    correctness: [artifactAssert('plan-converged', o => (o.runResult as PlanRunResult | null)?.results?.plan?.converged === true)],
    seed: 7,
    planRounds: 1,
    codeRounds: 1,
    confidenceMin: 70,
    ...overrides,
  }
}

test('scenario mode runs end-to-end offline: report-only exit 0 with the four-axis table', async () => {
  const scripted = scriptedSpawn(envelopes(PLAN_HANDLERS))
  const res = await main(['--scenarios', 'unused-dir'], { scenarios: [planScenario()], spawn: probedSpawn(scripted.spawn) })
  assert.deepEqual(scripted.unexpected, [])
  assert.equal(res.code, 0)
  assert.match(res.output, /Scenario\s+Stages\s+Correct\s+Adhere\s+Cost \$\s+Wall \(ser\)\s+Turns\s+Agents/)
  assert.match(res.output, /cli-plan-only\s+plan\s+100\.0%/)
  assert.match(res.output, /agents: cli-plan-only/)
  assert.match(res.output, /serialized sum of agent calls/)
})

test('--filter selects scenarios by id or tag; non-matching scenarios never run', async () => {
  const scripted = scriptedSpawn(envelopes(PLAN_HANDLERS))
  const scenarios = [planScenario(), planScenario({ id: 'cli-other', tags: ['other'] })]
  const res = await main(['--scenarios', 'unused-dir', '--filter', 'cli-plan-only', '--json'], {
    scenarios,
    spawn: probedSpawn(scripted.spawn),
  })
  assert.equal(res.code, 0)
  const report = JSON.parse(res.output) as ScenarioReportJSON
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.scenarioId, 'cli-plan-only')

  const none = await main(['--scenarios', 'unused-dir', '--filter', 'nope'], {
    scenarios,
    spawn: probedSpawn(scripted.spawn),
  })
  assert.equal(none.code, 0)
  assert.match(none.output, /no scenarios matched/)
})

test('--json emits the stable machine report: ledger without prompts, metrics summed', async () => {
  const scripted = scriptedSpawn(envelopes(PLAN_HANDLERS))
  const res = await main(['--scenarios', 'unused-dir', '--json'], {
    scenarios: [planScenario()],
    spawn: probedSpawn(scripted.spawn),
  })
  assert.equal(res.code, 0)
  const report = JSON.parse(res.output) as ScenarioReportJSON
  assert.equal(report.mode, 'scenarios')
  const row = report.rows[0]
  assert.ok(row !== undefined)
  assert.equal(row.correctness, 1)
  assert.equal(row.agentCalls, 4)
  assert.equal(row.turns, 8)
  assert.ok(Math.abs(row.costUsd - 0.04) < 1e-9)
  assert.equal(row.sandbox, null)
  for (const entry of row.ledger) assert.ok(!('prompt' in entry), 'report ledger must not carry prompts')
})

test('the sandbox is torn down by default and kept (with its path reported) under --keep-sandbox', async () => {
  const torn = scriptedSpawn(envelopes(PLAN_HANDLERS))
  await main(['--scenarios', 'unused-dir'], { scenarios: [planScenario()], spawn: probedSpawn(torn.spawn) })
  const tornStateRoot = torn.calls[0]?.opts?.env?.STRAPPED_STATE_ROOT
  assert.ok(tornStateRoot !== undefined)
  assert.ok(!existsSync(tornStateRoot), 'sandbox must be removed without --keep-sandbox')

  const kept = scriptedSpawn(envelopes(PLAN_HANDLERS))
  const res = await main(['--scenarios', 'unused-dir', '--keep-sandbox', '--json'], {
    scenarios: [planScenario()],
    spawn: probedSpawn(kept.spawn),
  })
  const row = (JSON.parse(res.output) as ScenarioReportJSON).rows[0]
  assert.ok(row?.sandbox != null, '--keep-sandbox must report the sandbox path')
  assert.ok(existsSync(row.sandbox))
  rmSync(row.sandbox, { recursive: true, force: true })
})

// --- offline compare ------------------------------------------------------------

const reportRow = (over: Partial<ScenarioReportRow> = {}): ScenarioReportRow => ({
  scenarioId: 'full-pipeline',
  stages: ['plan'],
  correctness: 1,
  adherence: 1,
  costUsd: 0.1,
  wallClockMs: 1000,
  turns: 10,
  agentCalls: 4,
  skipped: false,
  error: null,
  grades: { correctness: [], adherence: [] },
  ledger: [],
  sandbox: null,
  ...over,
})

function writeReports(baseline: ScenarioReportRow[], candidate: ScenarioReportRow[]): { a: string; b: string } {
  const dir = mkdtempSync(join(tmpdir(), 'eval-compare-'))
  const a = join(dir, 'baseline.json')
  const b = join(dir, 'candidate.json')
  writeFileSync(a, JSON.stringify(scenarioReportToJSON(baseline)))
  writeFileSync(b, JSON.stringify(scenarioReportToJSON(candidate)))
  return { a, b }
}

test('--compare exits 1 on a seeded regression past tolerance and 0 within it', async () => {
  const { a, b } = writeReports([reportRow()], [reportRow({ correctness: 0.9 })])
  // A 10pp correctness dip past a 5% tolerance gates…
  const gated = await main(['--compare', a, b, '--tolerance', '5'])
  assert.equal(gated.code, 1)
  assert.match(gated.output, /-10\.0%/)
  // …and is allowed under a 15% tolerance (offline: no spawn injected at all).
  const clean = await main(['--compare', a, b, '--tolerance', '15'])
  assert.equal(clean.code, 0)
  assert.match(clean.output, /negative = regression/)
})

test('--compare needs no claude CLI and reports bad inputs as exit 2', async () => {
  const { a, b } = writeReports([reportRow()], [reportRow()])
  // throwingSpawn: if compare probed the CLI this would "skip"; it must diff instead.
  const res = await main(['--compare', a, b], { spawn: throwingSpawn() })
  assert.equal(res.code, 0)
  assert.match(res.output, /full-pipeline/)

  const bad = mkdtempSync(join(tmpdir(), 'eval-compare-bad-'))
  const notJson = join(bad, 'nope.json')
  writeFileSync(notJson, 'not json at all')
  const malformed = await main(['--compare', notJson, a])
  assert.equal(malformed.code, 2)
  assert.match(malformed.output, /^eval: /)

  const onePath = await main(['--compare', a])
  assert.equal(onePath.code, 2)
  assert.match(onePath.output, /requires two report files/)
})

// --- guards and skip semantics --------------------------------------------------

test('flag conflicts error with exit 2 before anything runs', async () => {
  const conflicts = [
    ['--scenarios', 'd', '--suite', 's'],
    ['--scenarios', 'd', '--ab'],
    ['--scenarios', 'd', '--matrix'],
    ['--compare', 'a.json', 'b.json', '--scenarios', 'd'],
    ['--compare', 'a.json', 'b.json', '--ab'],
  ]
  for (const argv of conflicts) {
    const res = await main(argv, { spawn: throwingSpawn() })
    assert.equal(res.code, 2, argv.join(' '))
    assert.match(res.output, /cannot be combined/)
  }
})

test('an absent claude CLI skips scenario mode with a notice and exit 0', async () => {
  const res = await main(['--scenarios', 'unused-dir'], { scenarios: [planScenario()], spawn: throwingSpawn() })
  assert.equal(res.code, 0)
  assert.match(res.output, /claude CLI unavailable — skipping scenarios/)
})

// --- scenario loading (real dynamic import from a temp dir) ---------------------

test('loadScenarios dynamically imports scenario modules via the magic `scenarios` export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-scenarios-'))
  writeFileSync(
    join(dir, 'sample.ts'),
    'export const scenarios = [{ id: "loaded-scenario", tags: ["t"], stages: ["plan"], ask: "a",' +
      ' repos: [], rules: [], correctness: [], seed: 1, planRounds: 1, codeRounds: 1, confidenceMin: 70 }]\n'
  )
  const scenarios = await loadScenarios(dir)
  assert.equal(scenarios.length, 1)
  assert.equal(scenarios[0]?.id, 'loaded-scenario')
})
