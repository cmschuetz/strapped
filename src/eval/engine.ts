// The `claude -p` eval substrate. `runClaude` builds the print-mode argv, spawns
// the CLI through an injectable `Spawn`, parses the JSON envelope, validates the
// forced `structured_output` against the request schema, and returns a typed,
// graded result. It shells out to `claude` ONLY — never `@anthropic-ai/sdk`.
//
// Design notes:
//  - The prompt travels on stdin (fed via `Spawn`'s `input`), so argv stays free
//    of arbitrarily large prompt text; `claude -p` reads stdin when given no
//    positional prompt.
//  - Cost/latency/usage are read straight off the envelope — no pricing table.
//  - Every failure mode (CLI error, unparseable envelope, schema miss) is a
//    graded `ok:false` result, never a thrown exception. An ABSENT CLI is a
//    distinct `skipped:true` signal so callers can skip-with-notice.

import { spawnSync } from 'node:child_process'
import type {
  Cache,
  Envelope,
  EvalRequest,
  EvalResult,
  EvalUsage,
  JsonSchema,
  Spawn,
} from './types.ts'
import { cacheKey } from './cache.ts'

/** Tools disabled by default so a case is single-shot, deterministic, cacheable. */
const DEFAULT_DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Glob',
  'Grep',
]

/** Real spawn: `spawnSync('claude', …)` with the prompt on stdin. */
export const defaultSpawn: Spawn = (cmd, args, input) => {
  const res = spawnSync(cmd, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/**
 * Build the pure `claude -p` argv for a request (prompt excluded — it goes on
 * stdin). Always forces print mode, JSON output, the request schema, model,
 * strict MCP isolation, and inline settings; layers system-prompt and tool-policy
 * flags conditionally.
 */
export function buildArgs(req: EvalRequest): string[] {
  const args = [
    '--print',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.schema),
    '--model',
    req.model,
    '--strict-mcp-config',
    '--settings',
    req.settings ?? '{}',
  ]
  if (req.systemPrompt !== undefined) args.push('--system-prompt', req.systemPrompt)
  if (req.appendSystemPrompt !== undefined) args.push('--append-system-prompt', req.appendSystemPrompt)
  if (req.tools && req.tools.length > 0) {
    args.push('--allowedTools', req.tools.join(' '))
  } else {
    args.push('--disallowedTools', DEFAULT_DISALLOWED_TOOLS.join(' '))
  }
  return args
}

/** Lift the envelope's snake_case usage block into the normalized shape. */
function normalizeUsage(envelope: Envelope): EvalUsage {
  const u = envelope.usage ?? {}
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
  }
}

/**
 * Shallow structural check: value is an object, every `required` key is present,
 * and — when `additionalProperties:false` — no keys beyond `properties` appear.
 * Returns an error message or `null`. Intentionally NOT a full JSON-Schema
 * validator (no dependency added).
 */
function validateSchema(value: unknown, schema: JsonSchema): string | null {
  const wantsObject = schema.type === 'object' || schema.properties !== undefined || schema.required !== undefined
  if (!wantsObject) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'output is not an object'
  }
  const obj = value as Record<string, unknown>
  for (const key of schema.required ?? []) {
    if (!(key in obj)) return `output missing required key: ${key}`
  }
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties))
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) return `output has unexpected key: ${key}`
    }
  }
  return null
}

/** Assemble a graded result from envelope metrics + an ok/error verdict. */
function gradedResult(
  envelope: Envelope,
  req: EvalRequest,
  verdict: { ok: true; output: unknown } | { ok: false; error: string }
): EvalResult {
  const base = {
    cost: envelope.total_cost_usd ?? 0,
    usage: normalizeUsage(envelope),
    durationMs: envelope.duration_ms ?? 0,
    apiDurationMs: envelope.duration_api_ms ?? 0,
    numTurns: envelope.num_turns ?? 0,
    model: req.model,
    cached: false,
  }
  return verdict.ok
    ? { ok: true, output: verdict.output, error: null, ...base }
    : { ok: false, output: null, error: verdict.error, ...base }
}

/** A graded failure carrying zeroed metrics (used when the envelope is unusable). */
function failureNoMetrics(req: EvalRequest, error: string): EvalResult {
  return {
    ok: false,
    output: null,
    error,
    cost: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    durationMs: 0,
    apiDurationMs: 0,
    numTurns: 0,
    model: req.model,
    cached: false,
  }
}

/**
 * Parse a `claude --output-format json` envelope into a graded `EvalResult`.
 * Never throws: an unparseable envelope, a CLI/model error, a missing/bad
 * output, or a schema miss all yield `ok:false` with a descriptive `error`.
 */
export function parseEnvelope(stdout: string, req: EvalRequest): EvalResult {
  let envelope: Envelope
  try {
    envelope = JSON.parse(stdout) as Envelope
  } catch {
    return failureNoMetrics(req, 'unparseable envelope')
  }

  if (envelope.is_error === true || (envelope.subtype !== undefined && envelope.subtype !== 'success')) {
    return gradedResult(envelope, req, {
      ok: false,
      error: `claude error: is_error=${String(envelope.is_error)} subtype=${String(envelope.subtype)}`,
    })
  }

  // Prefer the parsed, schema-forced object; fall back to parsing stringified `result`.
  let output = envelope.structured_output
  if (output === undefined || output === null) {
    if (typeof envelope.result !== 'string') {
      return gradedResult(envelope, req, { ok: false, error: 'no structured_output and no string result to parse' })
    }
    try {
      output = JSON.parse(envelope.result)
    } catch {
      return gradedResult(envelope, req, { ok: false, error: 'unparseable result JSON' })
    }
  }

  const schemaError = validateSchema(output, req.schema)
  if (schemaError) return gradedResult(envelope, req, { ok: false, error: schemaError })

  return gradedResult(envelope, req, { ok: true, output })
}

export interface RunOptions {
  /** Injected subprocess boundary; defaults to the real `claude` spawn. */
  spawn?: Spawn
  /** Optional response cache consulted before spawning and written on success. */
  cache?: Cache
}

/**
 * Run one eval request: cache lookup first, else spawn `claude -p`, parse, cache
 * (on success), return. An absent CLI (non-zero exit with empty stdout, or a
 * spawn throw) surfaces as a `skipped` result — distinct from a graded failure.
 */
export function runClaude(req: EvalRequest, { spawn = defaultSpawn, cache }: RunOptions = {}): EvalResult {
  const key = cache ? cacheKey(req) : null
  if (cache && key) {
    const hit = cache.get(key)
    if (hit) return { ...hit, cached: true }
  }

  let res
  try {
    res = spawn('claude', buildArgs(req), req.prompt)
  } catch {
    return { ...failureNoMetrics(req, 'claude CLI unavailable'), skipped: true }
  }

  if (res.status !== 0 && res.stdout.trim() === '') {
    return { ...failureNoMetrics(req, 'claude CLI unavailable'), skipped: true }
  }

  const result = parseEnvelope(res.stdout, req)
  if (cache && key && result.ok) cache.set(key, result)
  return result
}

/** Probe whether the `claude` CLI is invokable via `claude --version`. */
export function isAvailable(spawn: Spawn = defaultSpawn): boolean {
  try {
    return spawn('claude', ['--version']).status === 0
  } catch {
    return false
  }
}
