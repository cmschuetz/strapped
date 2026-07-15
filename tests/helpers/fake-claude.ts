// Hermetic stub for the `claude -p` subprocess boundary. Tests inject `fakeSpawn`
// (or a raw variant) so `bun test` never shells out to a real `claude` — the ONLY
// faked seam in the eval engine. Envelope factories mirror the verified real
// `--output-format json` shape (installed claude 2.1.207).

import type { Envelope, EvalUsage, Spawn } from '../../src/eval/types.ts'

/** A `Spawn` that ignores args/stdin and emits `envelope` as JSON on stdout, exit 0. */
export function fakeSpawn(envelope: Envelope): Spawn {
  return () => ({ status: 0, stdout: JSON.stringify(envelope), stderr: '' })
}

/** A `Spawn` returning a fixed status/stdout/stderr verbatim (for edge cases). */
export function rawSpawn(status: number | null, stdout: string, stderr = ''): Spawn {
  return () => ({ status, stdout, stderr })
}

/** A `Spawn` that throws, modelling a missing binary (ENOENT). */
export function throwingSpawn(): Spawn {
  return () => {
    throw new Error('spawn claude ENOENT')
  }
}

export interface SuccessOptions {
  cost?: number
  usage?: Partial<EvalUsage>
  durationMs?: number
  apiDurationMs?: number
  numTurns?: number
  /** When false, omit `structured_output` so the engine falls back to `result`. */
  structured?: boolean
}

/** A success envelope carrying `output` as both `structured_output` and `result`. */
export function successEnvelope(output: unknown, opts: SuccessOptions = {}): Envelope {
  const {
    cost = 0.001,
    usage = {},
    durationMs = 1000,
    apiDurationMs = 950,
    numTurns = 2,
    structured = true,
  } = opts
  const envelope: Envelope = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(output),
    total_cost_usd: cost,
    duration_ms: durationMs,
    duration_api_ms: apiDurationMs,
    num_turns: numTurns,
    usage: {
      input_tokens: usage.inputTokens ?? 10,
      output_tokens: usage.outputTokens ?? 20,
      cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
    },
  }
  if (structured) envelope.structured_output = output
  return envelope
}

/** An error envelope (`is_error:true`, non-success subtype) with metrics present. */
export function errorEnvelope(subtype = 'error_max_turns'): Envelope {
  return {
    type: 'result',
    subtype,
    is_error: true,
    total_cost_usd: 0.002,
    duration_ms: 500,
    duration_api_ms: 480,
    num_turns: 1,
    usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

/** A success envelope whose `structured_output` omits a required key (schema miss). */
export function schemaMismatchEnvelope(): Envelope {
  return successEnvelope({ unexpected: true })
}
