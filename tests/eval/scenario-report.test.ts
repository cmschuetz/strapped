// Scenario report + offline compare (D2 AC4, AC5): deterministic text
// snapshots for the scenario table / agent breakdown / compare table, the
// lossless JSON round-trip, the documented compare sign conventions, and the
// exit-code gate matrix. Pure — no sandboxes, no spawns.

import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  compareExitCode,
  compareReports,
  parseScenarioReport,
  type CompareResult,
  type ScenarioReportJSON,
} from '../../src/eval/scenario/compare.ts'
import {
  WALL_CLOCK_FOOTNOTE,
  compareToJSON,
  formatCompareReport,
  formatScenarioReport,
  scenarioReportToJSON,
} from '../../src/eval/scenario/report.ts'
import type { ScenarioLedgerRow, ScenarioReportRow } from '../../src/eval/scenario/run.ts'

const entry = (label: string, cost: number, turns: number, durationMs: number): ScenarioLedgerRow => ({
  label,
  model: 'claude-haiku-4-5',
  ok: true,
  error: null,
  cost,
  usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  durationMs,
  apiDurationMs: durationMs - 50,
  numTurns: turns,
})

const row = (over: Partial<ScenarioReportRow> = {}): ScenarioReportRow => ({
  scenarioId: 'full-pipeline',
  stages: ['plan', 'implement', 'pr'],
  correctness: 1,
  adherence: 0.875,
  costUsd: 0.13,
  wallClockMs: 12000,
  turns: 26,
  agentCalls: 3,
  skipped: false,
  error: null,
  grades: {
    correctness: [],
    adherence: [
      { name: 'adherence:manifest', pass: false, score: 0, detail: 'manifest status "draft" below expected "approved"' },
    ],
  },
  ledger: [entry('planner', 0.05, 10, 5000), entry('plan-review:a:r1', 0.04, 8, 4000), entry('planner', 0.04, 8, 3000)],
  sandbox: null,
  ...over,
})

/** Trailing pad is cell alignment noise — compare content + inner alignment. */
const lines = (text: string): string[] => text.split('\n').map(l => l.trimEnd())

// --- AC4: scenario report -------------------------------------------------------

test('formatScenarioReport renders the four-axis table deterministically (AC4)', () => {
  assert.deepEqual(lines(formatScenarioReport([row()])), [
    'Scenario       Stages             Correct  Adhere  Cost $    Wall (ser)  Turns  Agents',
    '-------------  -----------------  -------  ------  --------  ----------  -----  ------',
    'full-pipeline  plan+implement+pr  100.0%   87.5%   $0.13000  12000ms     26     3',
    '',
    'agents: full-pipeline',
    'Label             Calls  Cost $    Turns  Latency',
    '----------------  -----  --------  -----  -------',
    'planner           2      $0.09000  18     8000ms',
    'plan-review:a:r1  1      $0.04000  8      4000ms',
    '',
    'failed: full-pipeline',
    '  [adherence] adherence:manifest: manifest status "draft" below expected "approved"',
    '',
    WALL_CLOCK_FOOTNOTE,
  ])
})

test('the agent breakdown aggregates the ledger by label in first-appearance order (AC4)', () => {
  const text = formatScenarioReport([row()])
  // Two `planner` calls fold into one line: 2 calls, summed cost/turns/latency.
  assert.match(text, /planner\s+2\s+\$0\.09000\s+18\s+8000ms/)
  assert.match(text, /plan-review:a:r1\s+1\s+\$0\.04000\s+8\s+4000ms/)
})

test('a workflow error and a kept sandbox surface in the report (AC4)', () => {
  const text = formatScenarioReport([
    row({ error: 'unknown stage "bogus"', sandbox: '/tmp/strapped-scenario-x', ledger: [] }),
  ])
  assert.match(text, /\[workflow\] error: unknown stage "bogus"/)
  assert.match(text, /sandbox kept: full-pipeline → \/tmp\/strapped-scenario-x/)
})

test('the wall column is labeled serialized and the footnote explains it (AC4)', () => {
  const text = formatScenarioReport([row()])
  assert.match(text, /Wall \(ser\)/)
  assert.match(text, /serialized sum of agent calls/)
  assert.equal(formatScenarioReport([]), 'no scenarios matched')
})

test('scenario JSON round-trips through JSON.parse losslessly (AC4)', () => {
  const report = scenarioReportToJSON([row(), row({ scenarioId: 'plan-only', stages: ['plan'] })])
  const parsed = JSON.parse(JSON.stringify(report)) as ScenarioReportJSON
  assert.deepEqual(parsed, report)
  // …and the round-tripped object satisfies the compare-input validator.
  assert.deepEqual(parseScenarioReport(parsed, 'roundtrip.json'), report)
})

// --- AC5: compare ---------------------------------------------------------------

function comparePair(): CompareResult {
  const baseline = scenarioReportToJSON([row(), row({ scenarioId: 'gone' })])
  const candidate = scenarioReportToJSON([
    row({ correctness: 0.9, adherence: 1, costUsd: 0.1, wallClockMs: 11000, turns: 20 }),
    row({ scenarioId: 'fresh' }),
  ])
  return compareReports(baseline, candidate)
}

test('compareReports produces the documented sign conventions (AC5)', () => {
  const result = comparePair()
  const joined = result.rows.find(r => r.scenarioId === 'full-pipeline')
  assert.ok(joined !== undefined)
  assert.equal(joined.present, 'both')
  // ΔCorrect/ΔAdhere: candidate − baseline (negative = regression).
  assert.ok(Math.abs((joined.deltaCorrectness ?? 0) - -0.1) < 1e-9)
  assert.ok(Math.abs((joined.deltaAdherence ?? 0) - 0.125) < 1e-9)
  // ΔCost/ΔWall/ΔTurns: baseline − candidate (positive = candidate cheaper/faster/tighter).
  assert.ok(Math.abs((joined.deltaCostUsd ?? 0) - 0.03) < 1e-9)
  assert.equal(joined.deltaWallClockMs, 1000)
  assert.equal(joined.deltaTurns, 6)
})

test('rows missing on either side are flagged with null deltas (AC5)', () => {
  const result = comparePair()
  const gone = result.rows.find(r => r.scenarioId === 'gone')
  const fresh = result.rows.find(r => r.scenarioId === 'fresh')
  assert.equal(gone?.present, 'baseline-only')
  assert.equal(gone?.candidate, null)
  assert.equal(gone?.deltaCorrectness, null)
  assert.equal(fresh?.present, 'candidate-only')
  assert.equal(fresh?.baseline, null)
  assert.equal(fresh?.deltaTurns, null)
})

test('formatCompareReport renders the AB-style delta table with a legend (AC5)', () => {
  assert.deepEqual(lines(formatCompareReport(comparePair())), [
    'Scenario       ΔCorrect  ΔAdhere  ΔCost      ΔWall (ser)  ΔTurns  Base C/A      Cand C/A      Note',
    '-------------  --------  -------  ---------  -----------  ------  ------------  ------------  --------------',
    'full-pipeline  -10.0%    +12.5%   +$0.03000  +1000ms      +6      100.0%/87.5%  90.0%/100.0%',
    'gone           -         -        -          -            -       100.0%/87.5%  -             baseline-only',
    'fresh          -         -        -          -            -       -             100.0%/87.5%  candidate-only',
    '',
    'ΔCost/ΔWall/ΔTurns: positive = candidate cheaper/faster/tighter. ΔCorrect/ΔAdhere: negative = regression (only these gate).',
    '',
    WALL_CLOCK_FOOTNOTE,
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(compareToJSON(comparePair()))), comparePair())
})

test('compareExitCode gates only on correctness/adherence regressions past tolerance (AC5)', () => {
  const gate = (over: Partial<ScenarioReportRow>): number => {
    const baseline = scenarioReportToJSON([row()])
    const candidate = scenarioReportToJSON([row(over)])
    return compareExitCode(compareReports(baseline, candidate), 5)
  }
  // Correctness: -3pp within a 5pp tolerance → 0; -6pp past it → 1.
  assert.equal(gate({ correctness: 0.97 }), 0)
  assert.equal(gate({ correctness: 0.94 }), 1)
  // Adherence regressions gate the same way.
  assert.equal(gate({ adherence: 0.845 }), 0)
  assert.equal(gate({ adherence: 0.8 }), 1)
  // Cost/wall/turn regressions NEVER gate.
  assert.equal(gate({ costUsd: 99, wallClockMs: 999999, turns: 999 }), 0)
  // Improvements never gate.
  assert.equal(gate({ correctness: 1, adherence: 1 }), 0)

  // One-sided rows never gate.
  const oneSided = compareReports(scenarioReportToJSON([row()]), scenarioReportToJSON([row({ scenarioId: 'other' })]))
  assert.equal(compareExitCode(oneSided, 0), 0)
})

test('parseScenarioReport rejects non-report JSON with the source named (AC5)', () => {
  assert.throws(() => parseScenarioReport({ mode: 'suite', cases: [] }, 'a.json'), /a\.json: not a scenario report/)
  assert.throws(() => parseScenarioReport({ mode: 'scenarios' }, 'b.json'), /b\.json: missing rows array/)
  assert.throws(
    () => parseScenarioReport({ mode: 'scenarios', rows: [{ scenarioId: 42 }] }, 'c.json'),
    /c\.json: rows\[0\]/
  )
  assert.throws(() => parseScenarioReport('nope', 'd.json'), /d\.json: not a JSON object/)
})
