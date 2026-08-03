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
  SpawnOptions,
  SpawnResult,
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

/**
 * Real spawn: `spawnSync('claude', …)` with the prompt on stdin. Threads the
 * per-spawn options — `cwd`, `timeoutMs` (spawnSync `timeout`), and `env`
 * merged over `process.env` — and copies spawnSync's returned `error.code`
 * and termination `signal` onto the result so a timeout (`'ETIMEDOUT'` /
 * `'SIGTERM'`) travels on a distinct channel from an absent CLI (`'ENOENT'`).
 */
export const defaultSpawn: Spawn = (cmd, args, input, opts) => {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs,
    env: opts?.env === undefined ? undefined : { ...process.env, ...opts.env },
  })
  const result: SpawnResult = {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    signal: res.signal,
  }
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string') result.errorCode = code
  return result
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
  // Scenario/agentic knobs — emitted only when the request carries them, so a
  // request without them produces the exact pre-change argv. `maxTurns` has no
  // flag mapping: the installed CLI (`claude --help`, 2.1.x) does not support
  // `--max-turns`, so the field is deliberately left unemitted.
  for (const dir of req.addDirs ?? []) args.push('--add-dir', dir)
  if (req.permissionMode !== undefined) args.push('--permission-mode', req.permissionMode)
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

  // Prefer the parsed, schema-forced object; fall back to parsing stringified
  // `result`. The CLI intermittently omits `structured_output` on multi-turn
  // runs — carry its stop/terminal reasons in the error so the ledger records
  // WHY (runClaude then makes one schema-forced `--resume` retry).
  let output = envelope.structured_output
  if (output === undefined || output === null) {
    const why = `stop_reason=${String(envelope.stop_reason)} terminal_reason=${String(envelope.terminal_reason)}`
    if (typeof envelope.result !== 'string') {
      return gradedResult(envelope, req, { ok: false, error: `no structured_output and no string result to parse (${why})` })
    }
    try {
      output = JSON.parse(envelope.result)
    } catch {
      return gradedResult(envelope, req, { ok: false, error: `unparseable result JSON (${why})` })
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

  const spawnOpts: SpawnOptions = {}
  if (req.cwd !== undefined) spawnOpts.cwd = req.cwd
  if (req.timeoutMs !== undefined) spawnOpts.timeoutMs = req.timeoutMs
  if (req.env !== undefined) spawnOpts.env = req.env

  let res
  try {
    res = spawn('claude', buildArgs(req), req.prompt, spawnOpts)
  } catch {
    return { ...failureNoMetrics(req, 'claude CLI unavailable'), skipped: true }
  }

  // Spawn-level failures travel on distinct channels: ONLY an absent binary
  // (`ENOENT`) is the availability skip; any other spawn error or a kill
  // signal (a `timeoutMs` expiry surfaces as `ETIMEDOUT` and/or `SIGTERM`) is
  // a graded `ok:false` failure — never a throw, never `skipped`.
  if (res.errorCode === 'ENOENT') {
    return { ...failureNoMetrics(req, 'claude CLI unavailable'), skipped: true }
  }
  if (res.errorCode !== undefined || (res.signal !== undefined && res.signal !== null)) {
    const parts: string[] = []
    if (res.errorCode !== undefined) parts.push(res.errorCode)
    if (res.signal !== undefined && res.signal !== null) parts.push(`signal ${res.signal}`)
    return failureNoMetrics(req, `claude spawn failed: ${parts.join(', ')}`)
  }

  if (res.status !== 0 && res.stdout.trim() === '') {
    return { ...failureNoMetrics(req, 'claude CLI unavailable'), skipped: true }
  }

  let result = parseEnvelope(res.stdout, req)
  if (!result.ok && result.skipped === undefined) {
    result = retryStructured(req, res.stdout, result, spawn, spawnOpts)
  }
  if (cache && key && result.ok) cache.set(key, result)
  return result
}

const RETRY_PROMPT =
  'Your previous turn ended without emitting the required structured output. Evaluate the work you already completed in this session and emit the structured output now, conforming exactly to the required schema. Take no further actions.'

/** Sum both calls' metrics so the retry cost is never hidden from the ledger. */
function sumMetrics(first: EvalResult, second: EvalResult): EvalResult {
  return {
    ...second,
    cost: first.cost + second.cost,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      cacheReadInputTokens: first.usage.cacheReadInputTokens + second.usage.cacheReadInputTokens,
      cacheCreationInputTokens: first.usage.cacheCreationInputTokens + second.usage.cacheCreationInputTokens,
    },
    durationMs: first.durationMs + second.durationMs,
    apiDurationMs: first.apiDurationMs + second.apiDurationMs,
    numTurns: first.numTurns + second.numTurns,
  }
}

/**
 * ONE schema-forced follow-up turn against the SAME session when a success
 * envelope ended without usable structured output (missing field, no
 * extractable JSON, or a schema miss). `--resume <session_id>` re-enters the
 * run with the full argv — including `--json-schema` — so the CLI's
 * structured-output forcing produces the value; the model re-evaluates what it
 * already did and returns it in contract. Envelope-level claude errors and
 * spawn failures are NOT retried: they are real run failures, not formatting.
 */
function retryStructured(req: EvalRequest, stdout: string, first: EvalResult, spawn: Spawn, spawnOpts: SpawnOptions): EvalResult {
  let envelope: Envelope
  try {
    envelope = JSON.parse(stdout) as Envelope
  } catch {
    return first
  }
  if (envelope.is_error === true || (envelope.subtype !== undefined && envelope.subtype !== 'success')) return first
  const sessionId = envelope.session_id
  if (typeof sessionId !== 'string' || sessionId === '') return first

  let res: SpawnResult
  try {
    res = spawn('claude', [...buildArgs(req), '--resume', sessionId], RETRY_PROMPT, spawnOpts)
  } catch {
    return first
  }
  if (res.errorCode !== undefined || (res.signal !== undefined && res.signal !== null) || res.stdout.trim() === '') return first

  const second = parseEnvelope(res.stdout, req)
  if (!second.ok) return sumMetrics(first, { ...first, cost: second.cost, usage: second.usage, durationMs: second.durationMs, apiDurationMs: second.apiDurationMs, numTurns: second.numTurns })
  return sumMetrics(first, second)
}

/** Probe whether the `claude` CLI is invokable via `claude --version`. */
export function isAvailable(spawn: Spawn = defaultSpawn): boolean {
  try {
    return spawn('claude', ['--version']).status === 0
  } catch {
    return false
  }
}
