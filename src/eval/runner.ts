// The eval RUNNER: drives cases through the D1 engine and grades them, in three
// modes.
//   - `runSuite(cases, …)`  — every case × its models, in BOUNDED parallel.
//   - `runAB(case, base, cand, {model})` — same case body, two prompt variants,
//     one model → a delta record (Δcorrectness / Δcost / Δlatency / Δturns).
//   - `runMatrix(case, models)` — one case across a model grid.
// Every mode takes an injected `spawn` + optional `cache`, so `bun test` runs
// fully offline against the `fakeSpawn` stub. A case whose engine call reports the
// CLI is unavailable is marked `skipped` — a notice, never a failure.
//
// NOTE on "parallel": the D1 spawn boundary is synchronous, so the pool bounds
// how many case promises are in flight rather than truly interleaving blocking
// spawns; the shape is correct and the bound is enforced (`mapPool`). Deltas are
// what the performance verdict rests on — the CLI-boot latency offset cancels.

import { toRequest, type EvalCase, type Variant } from './case.ts'
import { runClaude } from './engine.ts'
import { gradeCase, type GradeContext, type GradeResult } from './grade.ts'
import type { Cache, EvalResult, Spawn } from './types.ts'

/** Default model when a case/run names none. */
export const DEFAULT_MODEL = 'claude-haiku-4-5'
/** Default model grid for `--matrix` when none is given. */
export const DEFAULT_MODELS: readonly string[] = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']

/** The graded outcome of running one case at one model (one variant). */
export interface CaseResult {
  caseId: string
  model: string
  /** Variant label when produced by an A/B leg; absent for plain/matrix runs. */
  variantLabel?: string
  /** Weighted correctness in [0,1]. */
  correctness: number
  grades: GradeResult[]
  /** The full engine result — measured cost/latency/turns/usage live here. */
  result: EvalResult
  /** True when the `claude` CLI was unavailable — a skip, not a failure. */
  skipped: boolean
}

export interface CaseRunOptions {
  model: string
  /** Substitute the case prompt (used by A/B to swap in a variant). */
  prompt?: string
  variantLabel?: string
  spawn?: Spawn
  cache?: Cache
}

/** Run one case at one model, then grade it. Never throws. */
export function runCase(c: EvalCase, opts: CaseRunOptions): CaseResult {
  const result = runClaude(toRequest(c, opts.model, opts.prompt), { spawn: opts.spawn, cache: opts.cache })
  const base = { caseId: c.id, model: opts.model, ...(opts.variantLabel ? { variantLabel: opts.variantLabel } : {}) }
  if (result.skipped === true) {
    return { ...base, correctness: 0, grades: [], result, skipped: true }
  }
  const ctx: GradeContext = { spawn: opts.spawn, cache: opts.cache }
  const { correctness, grades } = gradeCase(c.graders, result.output, result, ctx)
  return { ...base, correctness, grades, result, skipped: false }
}

/**
 * Bounded-concurrency map: at most `concurrency` workers run at once, results
 * preserve input order. No dependency — a fixed pool draining a shared cursor.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const limit = Math.max(1, Math.min(concurrency, items.length || 1))
  let cursor = 0
  async function drain(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await worker(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => drain()))
  return results
}

export interface SuiteOptions {
  /** Override the models each case runs on. */
  models?: string[]
  /** Max cases in flight (default 4). */
  concurrency?: number
  cache?: Cache
  spawn?: Spawn
}

/** Run every case × its resolved models in bounded parallel. */
export function runSuite(cases: readonly EvalCase[], opts: SuiteOptions = {}): Promise<CaseResult[]> {
  const jobs: { c: EvalCase; model: string }[] = []
  for (const c of cases) {
    const models = opts.models ?? c.models ?? [DEFAULT_MODEL]
    for (const model of models) jobs.push({ c, model })
  }
  return mapPool(jobs, opts.concurrency ?? 4, job =>
    Promise.resolve(runCase(job.c, { model: job.model, spawn: opts.spawn, cache: opts.cache }))
  )
}

/** A baseline-vs-candidate delta record at one fixed model. */
export interface ABResult {
  caseId: string
  model: string
  baselineLabel: string
  candidateLabel: string
  baseline: CaseResult
  candidate: CaseResult
  /** candidate − baseline: positive = candidate more correct. */
  deltaCorrectness: number
  /** baseline − candidate cost: positive = candidate CHEAPER (a saving). */
  deltaCostUsd: number
  /** baseline − candidate latency: positive = candidate FASTER. */
  deltaLatencyMs: number
  /** baseline − candidate turns: positive = candidate converged in FEWER turns. */
  deltaTurns: number
}

export interface ABOptions {
  model?: string
  spawn?: Spawn
  cache?: Cache
}

/**
 * Run the same case body with two prompt variants at one model and compute the
 * trade-off deltas. Cost/latency/turn deltas are baseline−candidate so a cheaper,
 * faster, tighter candidate reads as POSITIVE across the board; correctness is
 * candidate−baseline so a regression reads as NEGATIVE (what the CLI gate keys on).
 */
export function runAB(c: EvalCase, baseline: Variant, candidate: Variant, opts: ABOptions = {}): ABResult {
  const model = opts.model ?? c.models?.[0] ?? DEFAULT_MODEL
  const b = runCase(c, { model, prompt: baseline.prompt, variantLabel: baseline.label, spawn: opts.spawn, cache: opts.cache })
  const cand = runCase(c, { model, prompt: candidate.prompt, variantLabel: candidate.label, spawn: opts.spawn, cache: opts.cache })
  return {
    caseId: c.id,
    model,
    baselineLabel: baseline.label,
    candidateLabel: candidate.label,
    baseline: b,
    candidate: cand,
    deltaCorrectness: cand.correctness - b.correctness,
    deltaCostUsd: b.result.cost - cand.result.cost,
    deltaLatencyMs: b.result.durationMs - cand.result.durationMs,
    deltaTurns: b.result.numTurns - cand.result.numTurns,
  }
}

/** A per-model grid for one case. */
export interface MatrixResult {
  caseId: string
  rows: CaseResult[]
}

export interface MatrixOptions {
  spawn?: Spawn
  cache?: Cache
  concurrency?: number
}

/** Run one case across a model grid; one row per model, input order preserved. */
export function runMatrix(c: EvalCase, models: readonly string[], opts: MatrixOptions = {}): Promise<MatrixResult> {
  const grid = models.length > 0 ? models : DEFAULT_MODELS
  return mapPool(grid, opts.concurrency ?? grid.length, model =>
    Promise.resolve(runCase(c, { model, spawn: opts.spawn, cache: opts.cache }))
  ).then(rows => ({ caseId: c.id, rows }))
}
