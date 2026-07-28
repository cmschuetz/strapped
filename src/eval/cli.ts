// `bun src/eval/cli.ts` — the eval suite entrypoint (npm: `bun run eval`). Loads
// case modules from a suite directory, runs them in one of three modes, and
// prints a report. This is the HEAVY, opt-in test layer for prompt changes — it
// is deliberately NOT part of `bun test` (that stays hermetic/offline).
//
// Exit code: a plain/matrix run is REPORT-ONLY (always 0). Only `--ab` gates —
// exit 1 iff some case's Δcorrectness dips past `--tolerance` (a regression). An
// absent `claude` CLI is a graceful skip: print a notice, exit 0, never fail.
//
// Flags: --suite <dir>  --filter <tag|id>  --ab  --matrix  --models a,b
//        --json  --tolerance <pct>
//
// `main` returns { code, output } (does not exit) so tests can drive the exact
// exit-code semantics through the injected spawn; the bottom guard is the only
// place that touches the process.

import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EvalCase } from './case.ts'
import { isAvailable } from './engine.ts'
import { formatReport, toJSON, type Report } from './report.ts'
import {
  DEFAULT_MODEL,
  runAB,
  runMatrix,
  runSuite,
  type ABResult,
  type MatrixResult,
} from './runner.ts'
import type { Cache, Spawn } from './types.ts'

export interface EvalFlags {
  suite?: string
  filter?: string
  ab: boolean
  matrix: boolean
  models?: string[]
  json: boolean
  tolerance: number
}

/** Hand-rolled argv parser (no dependency). Unknown flags are ignored. */
export function parseArgs(argv: readonly string[]): EvalFlags {
  const flags: EvalFlags = { ab: false, matrix: false, json: false, tolerance: 0 }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--suite':
        flags.suite = argv[++i]
        break
      case '--filter':
        flags.filter = argv[++i]
        break
      case '--ab':
        flags.ab = true
        break
      case '--matrix':
        flags.matrix = true
        break
      case '--models':
        flags.models = (argv[++i] ?? '').split(',').filter(Boolean)
        break
      case '--json':
        flags.json = true
        break
      case '--tolerance':
        flags.tolerance = Number(argv[++i] ?? '0')
        break
      default:
        break
    }
  }
  return flags
}

/** Load every case exported by the modules in a suite directory (sorted). */
export async function loadSuite(dir: string): Promise<EvalCase[]> {
  const abs = resolve(dir)
  const files = readdirSync(abs)
    .filter(f => /\.(ts|mjs|js)$/.test(f) && !f.endsWith('.d.ts'))
    .sort()
  const cases: EvalCase[] = []
  for (const file of files) {
    const mod = (await import(join(abs, file))) as { cases?: unknown; default?: unknown }
    const exported = mod.cases ?? mod.default
    if (Array.isArray(exported)) cases.push(...(exported as EvalCase[]))
    else if (exported) cases.push(exported as EvalCase)
  }
  return cases
}

/** A case matches a filter if the filter equals its id or one of its tags. */
function matchesFilter(c: EvalCase, filter: string): boolean {
  return c.id === filter || c.tags.includes(filter)
}

/**
 * A/B gate: exit 1 iff any case regressed correctness past the tolerance. A
 * tolerance of `5` means "a 5-percentage-point dip is allowed"; anything worse
 * gates. Cost/latency wins never gate — a human judges the trade from the report.
 */
export function abExitCode(results: readonly ABResult[], tolerancePct: number): number {
  const tol = tolerancePct / 100
  return results.some(r => r.deltaCorrectness < -tol) ? 1 : 0
}

export interface CliDeps {
  spawn?: Spawn
  cache?: Cache
  /** Test override: supply cases directly instead of loading from `--suite`. */
  cases?: EvalCase[]
}

export interface CliResult {
  code: number
  output: string
}

/**
 * Parse argv, run the selected mode, and return an exit code + text to print.
 * Never touches the process — the bottom guard does that. An absent CLI short
 * circuits to a skip notice + exit 0 before any case runs.
 */
export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<CliResult> {
  const flags = parseArgs(argv)
  const spawn = deps.spawn

  if (!isAvailable(spawn)) {
    return { code: 0, output: 'eval: claude CLI unavailable — skipping suite (exit 0)\n' }
  }

  let cases = deps.cases ?? (flags.suite ? await loadSuite(flags.suite) : [])
  if (flags.filter) cases = cases.filter(c => matchesFilter(c, flags.filter as string))

  if (cases.length === 0) {
    return { code: 0, output: 'eval: no cases matched (nothing to run)\n' }
  }

  let report: Report
  let code = 0

  if (flags.ab) {
    const results: ABResult[] = []
    for (const c of cases) {
      if (!c.variants) continue
      results.push(runAB(c, c.variants.baseline, c.variants.candidate, { model: flags.models?.[0] ?? DEFAULT_MODEL, spawn, cache: deps.cache }))
    }
    report = { mode: 'ab', cases: results }
    code = abExitCode(results, flags.tolerance)
  } else if (flags.matrix) {
    const grids: MatrixResult[] = []
    for (const c of cases) {
      grids.push(await runMatrix(c, flags.models ?? c.models ?? [], { spawn, cache: deps.cache }))
    }
    report = { mode: 'matrix', cases: grids }
  } else {
    const results = await runSuite(cases, { models: flags.models, spawn, cache: deps.cache })
    report = { mode: 'suite', cases: results }
  }

  const output = flags.json ? `${JSON.stringify(toJSON(report), null, 2)}\n` : `${formatReport(report)}\n`
  return { code, output }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then(({ code, output }) => {
      process.stdout.write(output)
      process.exit(code)
    })
    .catch((e: unknown) => {
      process.stderr.write(`eval: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(2)
    })
}
