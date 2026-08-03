// `bun src/eval/cli.ts` — the eval suite entrypoint (npm: `bun run eval`). Loads
// case modules from a suite directory, runs them in one of three modes, and
// prints a report. This is the HEAVY, opt-in test layer for prompt changes — it
// is deliberately NOT part of `bun test` (that stays hermetic/offline).
//
// Exit code: a plain/matrix/scenario run is REPORT-ONLY (always 0). Only two
// modes gate: `--ab` — exit 1 iff some case's Δcorrectness dips past
// `--tolerance` (a regression) — and `--compare` — exit 1 iff some scenario's
// Δcorrectness OR Δadherence dips past `--tolerance`. An absent `claude` CLI is
// a graceful skip: print a notice, exit 0, never fail. `--compare` is OFFLINE
// (a pure diff of two saved JSON reports) so it needs no CLI probe at all.
//
// Flags: --suite <dir>  --filter <tag|id>  --ab  --matrix  --models a,b
//        --json  --tolerance <pct>
//        --scenarios <dir>  --keep-sandbox  --deployable <path>
//        --compare <baseline.json> <candidate.json>
//
// `--deployable <path>` (scenario mode only) runs the suite against the named
// workflow deployable instead of the repo's shipped strapped-run.js. Only for
// args-contract-COMPATIBLE builds (e.g. two candidate builds of the same tree)
// — a cross-contract baseline must come from a self-consistent checkout (see
// CONTRIBUTING.md), never from pointing the new executor at an old deployable.
//
// `main` returns { code, output } (does not exit) so tests can drive the exact
// exit-code semantics through the injected spawn; the bottom guard is the only
// place that touches the process.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
import { compareExitCode, compareReports, parseScenarioReport } from './scenario/compare.ts'
import { compareToJSON, formatCompareReport, formatScenarioReport, scenarioReportToJSON } from './scenario/report.ts'
import { runScenarios } from './scenario/run.ts'
import type { Scenario } from './scenario/types.ts'
import type { Cache, Spawn } from './types.ts'

export interface EvalFlags {
  suite?: string
  filter?: string
  ab: boolean
  matrix: boolean
  models?: string[]
  json: boolean
  tolerance: number
  /** Scenario mode: directory of scenario modules. */
  scenarios?: string
  /** Keep each scenario's sandbox on disk and print its path. */
  keepSandbox: boolean
  /** Scenario mode: explicit workflow deployable path (contract-compatible builds only). */
  deployable?: string
  /** Offline compare: the two report paths consumed after `--compare`. */
  compare?: string[]
}

/** Hand-rolled argv parser (no dependency). Unknown flags are ignored. */
export function parseArgs(argv: readonly string[]): EvalFlags {
  const flags: EvalFlags = { ab: false, matrix: false, json: false, tolerance: 0, keepSandbox: false }
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
      case '--scenarios':
        flags.scenarios = argv[++i]
        break
      case '--keep-sandbox':
        flags.keepSandbox = true
        break
      case '--deployable':
        flags.deployable = argv[++i]
        break
      case '--compare':
        // Consumes the next TWO args (baseline, candidate); main validates arity.
        flags.compare = [argv[++i], argv[++i]].filter((a): a is string => a !== undefined)
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

/**
 * Load every scenario exported by the modules in a directory (sorted files).
 * Mirrors `loadSuite`; the magic export name is `scenarios` (or default).
 */
export async function loadScenarios(dir: string): Promise<Scenario[]> {
  const abs = resolve(dir)
  const files = readdirSync(abs)
    .filter(f => /\.(ts|mjs|js)$/.test(f) && !f.endsWith('.d.ts'))
    .sort()
  const scenarios: Scenario[] = []
  for (const file of files) {
    const mod = (await import(join(abs, file))) as { scenarios?: unknown; default?: unknown }
    const exported = mod.scenarios ?? mod.default
    if (Array.isArray(exported)) scenarios.push(...(exported as Scenario[]))
    else if (exported) scenarios.push(exported as Scenario)
  }
  return scenarios
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
  /** Test override: supply scenarios directly instead of loading from `--scenarios`. */
  scenarios?: Scenario[]
}

export interface CliResult {
  code: number
  output: string
}

/** Offline `--compare` dispatch: read, validate, diff, gate. Never probes the CLI. */
function runCompare(flags: EvalFlags): CliResult {
  const [baselinePath, candidatePath] = flags.compare ?? []
  if (baselinePath === undefined || candidatePath === undefined) {
    return { code: 2, output: 'eval: --compare requires two report files: --compare <baseline.json> <candidate.json>\n' }
  }
  try {
    const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown
    const baseline = parseScenarioReport(read(baselinePath), baselinePath)
    const candidate = parseScenarioReport(read(candidatePath), candidatePath)
    const result = compareReports(baseline, candidate)
    const code = compareExitCode(result, flags.tolerance)
    const output = flags.json
      ? `${JSON.stringify(compareToJSON(result), null, 2)}\n`
      : `${formatCompareReport(result)}\n`
    return { code, output }
  } catch (e) {
    return { code: 2, output: `eval: ${e instanceof Error ? e.message : String(e)}\n` }
  }
}

/** Scenario-mode dispatch: load, filter, run, report. Always report-only (exit 0). */
async function runScenarioMode(flags: EvalFlags, deps: CliDeps): Promise<CliResult> {
  if (flags.deployable !== undefined && !existsSync(flags.deployable)) {
    return { code: 2, output: `eval: --deployable file not found: ${flags.deployable}\n` }
  }
  if (!isAvailable(deps.spawn)) {
    return { code: 0, output: 'eval: claude CLI unavailable — skipping scenarios (exit 0)\n' }
  }
  let scenarios = deps.scenarios ?? (await loadScenarios(flags.scenarios as string))
  if (flags.filter !== undefined) {
    const filter = flags.filter
    scenarios = scenarios.filter(s => s.id === filter || s.tags.includes(filter))
  }
  if (scenarios.length === 0) {
    return { code: 0, output: 'eval: no scenarios matched (nothing to run)\n' }
  }
  const rows = await runScenarios(scenarios, {
    spawn: deps.spawn,
    cache: deps.cache,
    keepSandbox: flags.keepSandbox,
    deployable: flags.deployable,
  })
  const output = flags.json
    ? `${JSON.stringify(scenarioReportToJSON(rows), null, 2)}\n`
    : `${formatScenarioReport(rows)}\n`
  return { code: 0, output }
}

/**
 * Parse argv, run the selected mode, and return an exit code + text to print.
 * Never touches the process — the bottom guard does that. Dispatch order:
 * `--compare` first (offline — no CLI probe), then `--scenarios`, then the
 * prompt-eval modes; for the modes that spawn, an absent CLI short circuits to
 * a skip notice + exit 0 before anything runs.
 */
export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<CliResult> {
  const flags = parseArgs(argv)
  const spawn = deps.spawn

  if (flags.compare !== undefined) {
    if (flags.scenarios !== undefined || flags.suite !== undefined || flags.ab || flags.matrix) {
      return { code: 2, output: 'eval: --compare cannot be combined with --scenarios/--suite/--ab/--matrix\n' }
    }
    return runCompare(flags)
  }

  if (flags.scenarios !== undefined) {
    if (flags.suite !== undefined || flags.ab || flags.matrix) {
      return { code: 2, output: 'eval: --scenarios cannot be combined with --suite/--ab/--matrix\n' }
    }
    return runScenarioMode(flags, deps)
  }

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
