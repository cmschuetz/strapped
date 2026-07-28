// Shared types for the prompt-eval engine. The engine shells out to the Claude
// Code CLI in print mode (`claude -p`) — NEVER the Anthropic SDK — and reads
// cost/latency/usage straight off the `--output-format json` envelope. The one
// faked boundary in tests is `Spawn`; everything else is real.

/**
 * A minimal JSON-Schema shape. The engine only performs a SHALLOW structural
 * check (`required` keys present, no extras when `additionalProperties:false`),
 * so this deliberately does not model the full spec — do NOT add a schema
 * validator dependency. The harness's generated schemas satisfy this shape.
 */
export interface JsonSchema {
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean
  items?: JsonSchema
  [key: string]: unknown
}

/** A single-shot eval request: the prompt, the schema it is forced against, and knobs. */
export interface EvalRequest {
  /** User prompt — passed to `claude -p` on stdin. */
  prompt: string
  /** Replace the CLI's default system prompt (`--system-prompt`) for isolation. */
  systemPrompt?: string
  /** Layer extra context on top of the default system prompt (`--append-system-prompt`). */
  appendSystemPrompt?: string
  /** Model id, e.g. `claude-haiku-4-5` (`--model`). */
  model: string
  /** Schema forced via `--json-schema` and validated against `structured_output`. */
  schema: JsonSchema
  /** Opt into a bounded toolset (`--allowedTools`); omit for a single-shot, tool-free run. */
  tools?: string[]
  /** Inline settings JSON (`--settings`); defaults to `'{}'` to isolate from ambient config. */
  settings?: string
}

/** Normalized token usage lifted from the envelope's snake_case `usage` block. */
export interface EvalUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/**
 * The graded outcome of one eval invocation. A model/CLI error, an unparseable
 * envelope, or a schema-nonconforming output all yield `ok:false` with a
 * descriptive `error` — the engine NEVER throws for these. `skipped:true` is a
 * distinct signal that the CLI itself was unavailable (not a graded failure).
 */
export interface EvalResult {
  ok: boolean
  output: unknown | null
  error: string | null
  cost: number
  usage: EvalUsage
  durationMs: number
  apiDurationMs: number
  numTurns: number
  model: string
  cached: boolean
  /** True only when the `claude` CLI was unavailable — callers skip-with-notice. */
  skipped?: boolean
}

/** Envelope usage block as emitted by `claude --output-format json` (snake_case). */
export interface EnvelopeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  service_tier?: string
}

/**
 * Raw `--output-format json` envelope (verified against installed `claude`
 * 2.1.207). Only the fields the engine reads are typed; the rest are ignored.
 */
export interface Envelope {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  usage?: EnvelopeUsage
  duration_ms?: number
  duration_api_ms?: number
  num_turns?: number
  modelUsage?: Record<string, unknown>
}

/** Result of a subprocess spawn — the single injectable boundary tests fake. */
export interface SpawnResult {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * The injected spawn dependency. Default is a thin `spawnSync('claude', …)`
 * wrapper; tests pass a stub returning a canned envelope. `input` is fed to the
 * child's stdin (the prompt travels there, keeping argv free of large text).
 */
export type Spawn = (cmd: string, args: string[], input?: string) => SpawnResult

/** A response cache the engine can consult before spawning. */
export interface Cache {
  get(key: string): EvalResult | null
  set(key: string, result: EvalResult): void
}
