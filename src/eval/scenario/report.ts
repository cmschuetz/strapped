// Scenario / compare report rendering + the stable JSON shapes. Mirrors the
// prompt-eval report conventions (src/eval/report.ts): deterministic aligned
// text — snapshot-testable — and a machine JSON view that is the `--compare`
// input. The four axes render side by side; the tool never collapses them
// into one number.
//
// The wall-clock column is labeled `(ser)` and footnoted: the sync spawn
// boundary serializes the workflow's `parallel()`/`pipeline()`, so scenario
// wall clock is the SERIALIZED SUM of agent calls — time verdicts should lean
// on Σturns / Σapi duration instead (D1 known limitation, accepted for v1).

import type { CompareResult, CompareRow, ScenarioReportJSON } from './compare.ts'
import type { ScenarioLedgerRow, ScenarioReportRow } from './run.ts'

// --- cell formatters (deterministic — same conventions as src/eval/report.ts) --

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const usd = (x: number): string => `$${x.toFixed(5)}`
const ms = (x: number): string => `${Math.round(x)}ms`
const signedPct = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
const signedUsd = (x: number): string => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(5)}`
const signedMs = (x: number): string => `${x >= 0 ? '+' : ''}${Math.round(x)}ms`
const signedInt = (x: number): string => `${x >= 0 ? '+' : ''}${x}`

/** Render aligned columns: header, a dashed rule, then rows (left-padded cells). */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)))
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')
  const rule = widths.map(w => '-'.repeat(w)).join('  ')
  return [fmt(headers), rule, ...rows.map(fmt)].join('\n')
}

/** The serialized-wall-clock footnote every scenario/compare report carries. */
export const WALL_CLOCK_FOOTNOTE =
  'Wall (ser): the sync spawn boundary serializes parallel()/pipeline(), so wall clock is the serialized sum of agent calls — prefer Turns/api duration for time verdicts.'

// --- scenario report ------------------------------------------------------------

/** One label's aggregated slice of a scenario's agent ledger. */
interface LabelBreakdown {
  label: string
  calls: number
  costUsd: number
  turns: number
  durationMs: number
}

/** Aggregate a ledger by label, first-appearance order (deterministic). */
function byLabel(ledger: readonly ScenarioLedgerRow[]): LabelBreakdown[] {
  const order: string[] = []
  const map = new Map<string, LabelBreakdown>()
  for (const entry of ledger) {
    let agg = map.get(entry.label)
    if (agg === undefined) {
      agg = { label: entry.label, calls: 0, costUsd: 0, turns: 0, durationMs: 0 }
      map.set(entry.label, agg)
      order.push(entry.label)
    }
    agg.calls += 1
    agg.costUsd += entry.cost
    agg.turns += entry.numTurns
    agg.durationMs += entry.durationMs
  }
  return order.map(label => map.get(label) as LabelBreakdown)
}

function scenarioTable(rows: readonly ScenarioReportRow[]): string {
  const headers = ['Scenario', 'Stages', 'Correct', 'Adhere', 'Cost $', 'Wall (ser)', 'Turns', 'Agents']
  return renderTable(
    headers,
    rows.map(r => [
      r.scenarioId,
      r.stages.join('+'),
      pct(r.correctness),
      pct(r.adherence),
      usd(r.costUsd),
      ms(r.wallClockMs),
      String(r.turns),
      String(r.agentCalls),
    ])
  )
}

function agentBreakdown(row: ScenarioReportRow): string {
  const headers = ['Label', 'Calls', 'Cost $', 'Turns', 'Latency']
  const rows = byLabel(row.ledger).map(a => [a.label, String(a.calls), usd(a.costUsd), String(a.turns), ms(a.durationMs)])
  return `agents: ${row.scenarioId}\n${renderTable(headers, rows)}`
}

/** Failed-grade detail lines for one row (both axes), empty when all green. */
function failedGrades(row: ScenarioReportRow): string {
  const lines: string[] = []
  for (const [axis, grades] of [
    ['correctness', row.grades.correctness],
    ['adherence', row.grades.adherence],
  ] as const) {
    for (const g of grades) {
      if (!g.pass) lines.push(`  [${axis}] ${g.name}: ${g.detail}`)
    }
  }
  if (row.error !== null) lines.push(`  [workflow] error: ${row.error}`)
  if (lines.length === 0) return ''
  return `failed: ${row.scenarioId}\n${lines.join('\n')}`
}

/** Render the scenario report: table, per-scenario agent breakdowns, failures, footnote. */
export function formatScenarioReport(rows: readonly ScenarioReportRow[]): string {
  if (rows.length === 0) return 'no scenarios matched'
  const sections: string[] = [scenarioTable(rows)]
  for (const row of rows) {
    if (row.ledger.length > 0) sections.push(agentBreakdown(row))
    const failures = failedGrades(row)
    if (failures !== '') sections.push(failures)
    if (row.sandbox !== null) sections.push(`sandbox kept: ${row.scenarioId} → ${row.sandbox}`)
  }
  sections.push(WALL_CLOCK_FOOTNOTE)
  return sections.join('\n\n')
}

/**
 * The stable machine JSON view — plain data (rows carry no functions; ledger
 * prompts were already stripped by `runScenarios` to keep reports small),
 * round-trips losslessly through JSON and is the `--compare` input.
 */
export function scenarioReportToJSON(rows: readonly ScenarioReportRow[]): ScenarioReportJSON {
  return { mode: 'scenarios', rows: [...rows] }
}

// --- compare report -------------------------------------------------------------

const dash = '-'

function compareCells(row: CompareRow): string[] {
  const axes = (r: ScenarioReportRow | null): string => (r === null ? dash : `${pct(r.correctness)}/${pct(r.adherence)}`)
  return [
    row.scenarioId,
    row.deltaCorrectness === null ? dash : signedPct(row.deltaCorrectness),
    row.deltaAdherence === null ? dash : signedPct(row.deltaAdherence),
    row.deltaCostUsd === null ? dash : signedUsd(row.deltaCostUsd),
    row.deltaWallClockMs === null ? dash : signedMs(row.deltaWallClockMs),
    row.deltaTurns === null ? dash : signedInt(row.deltaTurns),
    axes(row.baseline),
    axes(row.candidate),
    row.present === 'both' ? '' : row.present,
  ]
}

/** Render the offline compare report: AB-style delta table + legend + footnote. */
export function formatCompareReport(result: CompareResult): string {
  if (result.rows.length === 0) return 'no scenarios to compare'
  const headers = ['Scenario', 'ΔCorrect', 'ΔAdhere', 'ΔCost', 'ΔWall (ser)', 'ΔTurns', 'Base C/A', 'Cand C/A', 'Note']
  const table = renderTable(headers, result.rows.map(compareCells))
  const legend =
    'ΔCost/ΔWall/ΔTurns: positive = candidate cheaper/faster/tighter. ΔCorrect/ΔAdhere: negative = regression (only these gate).'
  return `${table}\n\n${legend}\n\n${WALL_CLOCK_FOOTNOTE}`
}

/** The compare JSON view — already plain serializable data. */
export function compareToJSON(result: CompareResult): CompareResult {
  return result
}
