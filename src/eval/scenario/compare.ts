// OFFLINE compare of two saved scenario JSON reports — the before/after
// measurement for a workflow change: run the suite on the baseline workflow,
// save `--json`, change the workflow, run again, then
// `eval --compare baseline.json candidate.json`. Pure functions over parsed
// JSON — no model calls, no sandbox, no CLI probe.
//
// Sign conventions (the `runAB` precedent):
//   ΔCorrect / ΔAdhere = candidate − baseline  → negative = REGRESSION.
//   ΔCost / ΔWall / ΔTurns = baseline − candidate → positive = candidate
//   cheaper / faster / tighter (a saving).
// Only correctness/adherence regressions past the tolerance gate the exit
// code; cost/latency never gate — a human judges that trade from the report.

import type { ScenarioReportRow } from './run.ts'

/** The stable JSON shape `--scenarios --json` emits and `--compare` consumes. */
export interface ScenarioReportJSON {
  mode: 'scenarios'
  rows: ScenarioReportRow[]
}

/** One scenario's before/after deltas; null deltas when a side is missing. */
export interface CompareRow {
  scenarioId: string
  /** Whether the scenario appears in both reports or only one side. */
  present: 'both' | 'baseline-only' | 'candidate-only'
  baseline: ScenarioReportRow | null
  candidate: ScenarioReportRow | null
  /** candidate − baseline: negative = correctness regression. */
  deltaCorrectness: number | null
  /** candidate − baseline: negative = adherence regression. */
  deltaAdherence: number | null
  /** baseline − candidate: positive = candidate cheaper. */
  deltaCostUsd: number | null
  /** baseline − candidate: positive = candidate faster (serialized wall clock). */
  deltaWallClockMs: number | null
  /** baseline − candidate: positive = candidate converged in fewer turns. */
  deltaTurns: number | null
}

export interface CompareResult {
  rows: CompareRow[]
}

/**
 * Join two reports' rows by scenarioId (baseline order first, then
 * candidate-only rows in candidate order) and compute the per-pair deltas.
 * Rows missing on either side are flagged, never dropped.
 */
export function compareReports(baseline: ScenarioReportJSON, candidate: ScenarioReportJSON): CompareResult {
  const candidateById = new Map(candidate.rows.map(r => [r.scenarioId, r]))
  const seen = new Set<string>()
  const rows: CompareRow[] = []

  for (const base of baseline.rows) {
    seen.add(base.scenarioId)
    const cand = candidateById.get(base.scenarioId)
    if (cand === undefined) {
      rows.push({
        scenarioId: base.scenarioId,
        present: 'baseline-only',
        baseline: base,
        candidate: null,
        deltaCorrectness: null,
        deltaAdherence: null,
        deltaCostUsd: null,
        deltaWallClockMs: null,
        deltaTurns: null,
      })
      continue
    }
    rows.push({
      scenarioId: base.scenarioId,
      present: 'both',
      baseline: base,
      candidate: cand,
      deltaCorrectness: cand.correctness - base.correctness,
      deltaAdherence: cand.adherence - base.adherence,
      deltaCostUsd: base.costUsd - cand.costUsd,
      deltaWallClockMs: base.wallClockMs - cand.wallClockMs,
      deltaTurns: base.turns - cand.turns,
    })
  }

  for (const cand of candidate.rows) {
    if (seen.has(cand.scenarioId)) continue
    rows.push({
      scenarioId: cand.scenarioId,
      present: 'candidate-only',
      baseline: null,
      candidate: cand,
      deltaCorrectness: null,
      deltaAdherence: null,
      deltaCostUsd: null,
      deltaWallClockMs: null,
      deltaTurns: null,
    })
  }

  return { rows }
}

/**
 * Compare gate: exit 1 iff some joined row's Δcorrectness OR Δadherence dips
 * below −tolerance. A tolerance of `5` allows a 5-percentage-point dip.
 * Cost/wall/turn changes and one-sided rows never gate.
 */
export function compareExitCode(result: CompareResult, tolerancePct: number): number {
  const tol = tolerancePct / 100
  const regressed = result.rows.some(
    r =>
      r.present === 'both' &&
      ((r.deltaCorrectness !== null && r.deltaCorrectness < -tol) ||
        (r.deltaAdherence !== null && r.deltaAdherence < -tol))
  )
  return regressed ? 1 : 0
}

/** Is a parsed JSON value one report row? Structural — only what compare reads. */
function isReportRow(value: unknown): value is ScenarioReportRow {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.scenarioId === 'string' &&
    typeof row.correctness === 'number' &&
    typeof row.adherence === 'number' &&
    typeof row.costUsd === 'number' &&
    typeof row.wallClockMs === 'number' &&
    typeof row.turns === 'number'
  )
}

/**
 * Validate a parsed `--json` scenario report (the compare inputs are files a
 * human hands us — fail loudly, not deep in a delta). Throws with the source
 * name on any shape mismatch.
 */
export function parseScenarioReport(value: unknown, source: string): ScenarioReportJSON {
  if (value === null || typeof value !== 'object') throw new Error(`${source}: not a JSON object`)
  const report = value as Record<string, unknown>
  if (report.mode !== 'scenarios') {
    throw new Error(`${source}: not a scenario report (mode "${String(report.mode)}" ≠ "scenarios")`)
  }
  if (!Array.isArray(report.rows)) throw new Error(`${source}: missing rows array`)
  for (const [i, row] of report.rows.entries()) {
    if (!isReportRow(row)) throw new Error(`${source}: rows[${i}] is not a scenario report row`)
  }
  return { mode: 'scenarios', rows: report.rows as ScenarioReportRow[] }
}
