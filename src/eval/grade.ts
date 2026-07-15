// Correctness graders for the eval framework. A `Grader` inspects one engine
// result (the parsed output + the full envelope-derived `EvalResult`) and returns
// a `GradeResult`. Three built-ins ship here:
//   - `schemaConforms()` — intrinsic: did the forced schema validate? (`result.ok`)
//   - `assert(name, predicate)` — a pure predicate over the parsed output.
//   - `judge(rubric, {model})` — an LLM-judge that ITSELF routes through the D1
//     engine (so it is cached/stubbable/hermetic), scoring fuzzy quality.
// `gradeCase` aggregates a case's graders into a weighted correctness score in
// [0,1]. Graders are synchronous — the D1 engine (`runClaude`) is synchronous —
// and NEVER throw: a thrown predicate becomes a failed `GradeResult`.

import { runClaude } from './engine.ts'
import type { Cache, EvalRequest, EvalResult, JsonSchema, Spawn } from './types.ts'

/** The verdict of one grader over an engine result. `score` is in [0,1]. */
export interface GradeResult {
  /** Stable grader name — appears in the report and JSON. */
  name: string
  /** Boolean pass/fail (a threshold view of `score`). */
  pass: boolean
  /** Continuous quality in [0,1]; `schemaConforms`/`assert` emit 0 or 1. */
  score: number
  /** Human-readable reason — why it passed/failed. */
  detail: string
  /** Relative weight in the correctness aggregate (default 1). */
  weight?: number
}

/**
 * Runtime context threaded to every grader by `gradeCase`. Only `judge` reads it
 * (to route its rubric call through the same injected spawn/cache as the case),
 * so `bun test` stays hermetic. Intrinsic graders ignore it.
 */
export interface GradeContext {
  spawn?: Spawn
  cache?: Cache
}

/** A grader: inspect the parsed output + full result, return a verdict. */
export type Grader = (output: unknown, result: EvalResult, ctx: GradeContext) => GradeResult

/** Intrinsic grader: passes iff the forced schema validated (`result.ok`). */
export function schemaConforms(opts: { weight?: number } = {}): Grader {
  return (_output, result) => ({
    name: 'schemaConforms',
    pass: result.ok,
    score: result.ok ? 1 : 0,
    detail: result.ok ? 'output conforms to the forced schema' : (result.error ?? 'schema nonconforming'),
    weight: opts.weight,
  })
}

/**
 * Assertion grader: run a pure predicate over the parsed output. A `false` return
 * fails; a thrown predicate fails with the throw message (never propagates).
 */
export function assert(name: string, predicate: (output: unknown) => boolean, opts: { weight?: number } = {}): Grader {
  return output => {
    try {
      const pass = predicate(output)
      return { name, pass, score: pass ? 1 : 0, detail: pass ? 'assertion passed' : 'assertion failed', weight: opts.weight }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { name, pass: false, score: 0, detail: `assertion threw: ${msg}`, weight: opts.weight }
    }
  }
}

/** The schema the judge forces on itself — a single scored verdict. */
const JUDGE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['score', 'pass', 'reason'],
  properties: {
    score: { type: 'number' },
    pass: { type: 'boolean' },
    reason: { type: 'string' },
  },
  additionalProperties: false,
}

/** Parsed shape of a judge verdict (post schema-validation). */
interface JudgeVerdict {
  score?: number
  pass?: boolean
  reason?: string
}

export interface JudgeOptions {
  /** Model the judge itself runs on (`--model`). */
  model: string
  /** Grader name in the report (default `judge`). */
  name?: string
  /** Weight in the correctness aggregate. */
  weight?: number
}

/**
 * LLM-judge grader. Composes an `EvalRequest` from `rubric` + the output under
 * test and a fixed `{score,pass,reason}` schema, then calls the D1 engine through
 * the injected spawn/cache — so the judge is itself cacheable and hermetically
 * stubbable. A judge engine failure grades the case as a failed rubric, not a crash.
 */
export function judge(rubric: string, opts: JudgeOptions): Grader {
  const name = opts.name ?? 'judge'
  return (output, _result, ctx) => {
    const req: EvalRequest = {
      prompt: `${rubric}\n\nOutput under evaluation:\n${JSON.stringify(output, null, 2)}`,
      model: opts.model,
      schema: JUDGE_SCHEMA,
    }
    const verdict = runClaude(req, { spawn: ctx.spawn, cache: ctx.cache })
    if (!verdict.ok || verdict.output === null || typeof verdict.output !== 'object') {
      return { name, pass: false, score: 0, detail: verdict.error ?? 'judge produced no verdict', weight: opts.weight }
    }
    const v = verdict.output as JudgeVerdict
    const score = typeof v.score === 'number' ? Math.max(0, Math.min(1, v.score)) : 0
    return { name, pass: v.pass === true, score, detail: v.reason ?? '', weight: opts.weight }
  }
}

/** A case's aggregate correctness plus the individual grader verdicts. */
export interface CaseGrade {
  /** Weighted mean grader score in [0,1]. */
  correctness: number
  grades: GradeResult[]
}

/**
 * Run every grader over one engine result and aggregate into a weighted
 * correctness score. Correctness = Σ(weight·score) / Σweight (weight defaults to
 * 1). An empty grader set yields correctness 0.
 */
export function gradeCase(graders: readonly Grader[], output: unknown, result: EvalResult, ctx: GradeContext = {}): CaseGrade {
  const grades = graders.map(g => g(output, result, ctx))
  let weightedSum = 0
  let totalWeight = 0
  for (const grade of grades) {
    const weight = grade.weight ?? 1
    weightedSum += weight * grade.score
    totalWeight += weight
  }
  const correctness = totalWeight > 0 ? weightedSum / totalWeight : 0
  return { correctness, grades }
}
