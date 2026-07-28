// The eval REPORT: a human-readable aligned text table + a machine JSON object,
// over any of the three runner modes. The report surfaces all THREE axes
// (correctness / cost / latency) side by side so a human judges the trade — a
// correctness dip that buys a large cost/latency win is a WIN, and the tool
// refuses to collapse that into a single number.
//
// Cost columns: the "Cost $" column is the MEASURED envelope cost. A separate,
// clearly-labelled "Proj $" column is an OPTIONAL projection of a model-swap the
// CLI did not actually run, computed from a small static pricing table — never
// mixed with measured cost.

import type { CaseResult, ABResult, MatrixResult } from './runner.ts'
import type { EvalUsage } from './types.ts'

/** Static, approximate USD-per-1M-token prices — projection only, NOT measured. */
export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
}

/** A small static pricing table used ONLY to project a model-swap. */
export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-8': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
}

/**
 * Project what a run's token usage WOULD cost on `model` from the static table.
 * Returns `null` for an unpriced model. This is a projection, never a measurement.
 */
export function projectCost(usage: EvalUsage, model: string): number | null {
  const p = PRICING[model]
  if (!p) return null
  return (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000
}

/** A tagged union over the three runner modes the report can render. */
export type Report =
  | { mode: 'suite'; cases: CaseResult[] }
  | { mode: 'ab'; cases: ABResult[] }
  | { mode: 'matrix'; cases: MatrixResult[] }

export interface FormatOptions {
  /** When set, add a projected-cost column for a model the run did not execute. */
  projectModel?: string
}

// --- cell formatters (deterministic — the report text is snapshot-tested) -----

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

function caseRow(r: CaseResult, projectModel?: string): string[] {
  const cells = [
    r.caseId,
    r.model,
    r.skipped ? 'skipped' : pct(r.correctness),
    r.skipped ? '-' : usd(r.result.cost),
    r.skipped ? '-' : ms(r.result.durationMs),
    r.skipped ? '-' : String(r.result.numTurns),
  ]
  if (projectModel) {
    const proj = r.skipped ? null : projectCost(r.result.usage, projectModel)
    cells.push(proj === null ? '-' : usd(proj))
  }
  return cells
}

function suiteHeaders(projectModel?: string): string[] {
  const h = ['Case', 'Model', 'Correct', 'Cost $', 'Latency', 'Turns']
  if (projectModel) h.push(`Proj $ (${projectModel})`)
  return h
}

function formatSuite(cases: CaseResult[], projectModel?: string): string {
  if (cases.length === 0) return 'no cases matched'
  return renderTable(suiteHeaders(projectModel), cases.map(r => caseRow(r, projectModel)))
}

function formatMatrix(cases: MatrixResult[], projectModel?: string): string {
  if (cases.length === 0) return 'no cases matched'
  const rows: string[][] = []
  for (const c of cases) for (const r of c.rows) rows.push(caseRow(r, projectModel))
  return renderTable(suiteHeaders(projectModel), rows)
}

function formatAB(cases: ABResult[]): string {
  if (cases.length === 0) return 'no cases matched'
  const headers = ['Case', 'Model', 'ΔCorrect', 'ΔCost', 'ΔLatency', 'ΔTurns', 'Base', 'Cand']
  const rows = cases.map(r => [
    r.caseId,
    r.model,
    signedPct(r.deltaCorrectness),
    signedUsd(r.deltaCostUsd),
    signedMs(r.deltaLatencyMs),
    signedInt(r.deltaTurns),
    pct(r.baseline.correctness),
    pct(r.candidate.correctness),
  ])
  const legend =
    'Δcost/Δlatency/Δturns: positive = candidate cheaper/faster/tighter. ΔCorrect: negative = regression.'
  return `${renderTable(headers, rows)}\n\n${legend}`
}

/** Render a report to aligned human-readable text. */
export function formatReport(report: Report, opts: FormatOptions = {}): string {
  switch (report.mode) {
    case 'suite':
      return formatSuite(report.cases, opts.projectModel)
    case 'matrix':
      return formatMatrix(report.cases, opts.projectModel)
    case 'ab':
      return formatAB(report.cases)
  }
}

/** The machine-comparable JSON view (already a plain serializable object). */
export function toJSON(report: Report): Report {
  return report
}
