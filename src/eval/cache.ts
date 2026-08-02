// Content-addressed response cache for eval results. The key is a SHA-256 over a
// CANONICAL (sorted-key) JSON of every request field that changes the model's
// output — prompt, both system-prompt knobs, model, schema, tool policy,
// settings, and the agentic knobs (cwd, addDirs, permissionMode, env,
// timeoutMs, maxTurns). Include every such field or an A/B would collide; a
// changed prompt naturally misses. The agentic fields enter the canonical JSON
// only when set, so a plain prompt-eval request hashes to the exact pre-agentic
// key. Results are stored one JSON file per key; no eviction.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Cache, EvalRequest, EvalResult } from './types.ts'

/** Recursively sort object keys so key order never perturbs the hash. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** Stable, key-sorted JSON of the output-affecting fields of a request. */
function canonicalRequest(req: EvalRequest): string {
  const canonical: Record<string, unknown> = {
    prompt: req.prompt,
    systemPrompt: req.systemPrompt ?? null,
    appendSystemPrompt: req.appendSystemPrompt ?? null,
    model: req.model,
    schema: req.schema,
    tools: req.tools ?? null,
    settings: req.settings ?? null,
  }
  // Agentic fields also change the model's behavior/output — buildArgs emits
  // --add-dir/--permission-mode from them and defaultSpawn changes the child's
  // cwd/env/timeout. Hash them too, but ONLY when set: a request without them
  // must keep its exact pre-agentic key so existing caches stay valid.
  if (req.cwd !== undefined) canonical.cwd = req.cwd
  if (req.addDirs !== undefined) canonical.addDirs = req.addDirs
  if (req.permissionMode !== undefined) canonical.permissionMode = req.permissionMode
  if (req.env !== undefined) canonical.env = req.env
  if (req.timeoutMs !== undefined) canonical.timeoutMs = req.timeoutMs
  if (req.maxTurns !== undefined) canonical.maxTurns = req.maxTurns
  return JSON.stringify(sortKeys(canonical))
}

/** Hex SHA-256 cache key over a request's output-affecting fields. */
export function cacheKey(req: EvalRequest): string {
  return createHash('sha256').update(canonicalRequest(req)).digest('hex')
}

/** File-backed response cache: one `<dir>/<key>.json` per stored result. */
export class ResponseCache implements Cache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key}.json`)
  }

  /** Return the stored result (marked `cached:true`) or `null` on miss/corruption. */
  get(key: string): EvalResult | null {
    const p = this.path(key)
    if (!existsSync(p)) return null
    try {
      const result = JSON.parse(readFileSync(p, 'utf8')) as EvalResult
      return { ...result, cached: true }
    } catch {
      return null
    }
  }

  /** Persist a result under `key`, creating the cache dir on first write. */
  set(key: string, result: EvalResult): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.path(key), JSON.stringify(result, null, 2))
  }
}
