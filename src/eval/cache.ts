// Content-addressed response cache for eval results. The key is a SHA-256 over a
// CANONICAL (sorted-key) JSON of every request field that changes the model's
// output — prompt, both system-prompt knobs, model, schema, tool policy, and
// settings. Include every such field or an A/B would collide; a changed prompt
// naturally misses. Results are stored one JSON file per key; no eviction.

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
  return JSON.stringify(
    sortKeys({
      prompt: req.prompt,
      systemPrompt: req.systemPrompt ?? null,
      appendSystemPrompt: req.appendSystemPrompt ?? null,
      model: req.model,
      schema: req.schema,
      tools: req.tools ?? null,
      settings: req.settings ?? null,
    })
  )
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
