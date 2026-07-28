// The eval CASE abstraction: a single, self-contained prompt-evaluation unit. A
// case carries the prompt, the schema it is forced against, isolation knobs
// (system prompt / tools / settings), the models it targets, its correctness
// graders, and — for A/B — an optional baseline+candidate prompt pair. A SUITE is
// just a directory of modules that export cases.
//
// Design decision (research §"prompts are eval inputs"): a case owns a VERBATIM
// baseline prompt snapshot copied from the live stage plus a candidate variant to
// A/B. Cases never import the live stage builders — prompts are inputs, not code.

import type { Grader } from './grade.ts'
import type { EvalRequest, JsonSchema } from './types.ts'

/** One labelled prompt variant for A/B comparison. */
export interface Variant {
  /** Short label shown in the report (e.g. `baseline`, `terser`). */
  label: string
  /** The full prompt text for this variant. */
  prompt: string
}

/** A baseline↔candidate variant pair a case can be A/B'd on. */
export interface CaseVariants {
  baseline: Variant
  candidate: Variant
}

/** A single prompt-evaluation case. */
export interface EvalCase {
  /** Unique id (also a `--filter` target). */
  id: string
  /** Tags for `--filter` selection (e.g. `planner`, `reviewer`). */
  tags: string[]
  /** Replace the CLI's default system prompt for isolation (`--system-prompt`). */
  systemPrompt?: string
  /** Layer strapped context on the real system prompt (`--append-system-prompt`). */
  appendSystemPrompt?: string
  /** The user prompt under evaluation. */
  prompt: string
  /** The schema forced via `--json-schema` and validated against the output. */
  schema: JsonSchema
  /** Models this case targets in a plain/matrix run; the runner falls back to a default. */
  models?: string[]
  /** Opt into a bounded toolset; omit for a single-shot, tool-free run. */
  tools?: string[]
  /** Inline settings JSON (`--settings`); defaults to `'{}'` in the engine. */
  settings?: string
  /** The correctness graders aggregated into this case's score. */
  graders: Grader[]
  /** Optional A/B prompt pair — required for a case to appear in `--ab` mode. */
  variants?: CaseVariants
}

/**
 * Identity helper for authoring a case module — validates nothing beyond types,
 * but gives suites a single import and a stable authoring surface.
 */
export function defineCase(spec: EvalCase): EvalCase {
  return spec
}

/**
 * Lower a case (at one model, optionally with a variant's prompt substituted)
 * into the single-shot `EvalRequest` the D1 engine consumes. The prompt override
 * is how A/B swaps baseline vs candidate while holding everything else fixed.
 */
export function toRequest(c: EvalCase, model: string, promptOverride?: string): EvalRequest {
  return {
    prompt: promptOverride ?? c.prompt,
    systemPrompt: c.systemPrompt,
    appendSystemPrompt: c.appendSystemPrompt,
    model,
    schema: c.schema,
    tools: c.tools,
    settings: c.settings,
  }
}
