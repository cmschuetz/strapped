// Cache tests: key stability, per-field isolation, file round-trip in a temp
// dir, and the runClaude hit/miss integration (a hit must NOT spawn).

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { cacheKey, ResponseCache } from '../../src/eval/cache.ts'
import { runClaude } from '../../src/eval/engine.ts'
import type { EvalRequest, JsonSchema, Spawn } from '../../src/eval/types.ts'
import { fakeSpawn, successEnvelope, throwingSpawn } from '../helpers/fake-claude.ts'

const SCHEMA: JsonSchema = {
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'number' } },
  additionalProperties: false,
}

const baseReq = (overrides: Partial<EvalRequest> = {}): EvalRequest => ({
  prompt: 'What is 6 * 7?',
  model: 'claude-haiku-4-5',
  schema: SCHEMA,
  ...overrides,
})

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'eval-cache-'))

// --- key stability + isolation (acceptance criterion 4) ----------------------

test('cacheKey is stable for identical requests', () => {
  assert.equal(cacheKey(baseReq()), cacheKey(baseReq()))
})

test('cacheKey is insensitive to schema key ordering (canonical JSON)', () => {
  const a = baseReq({ schema: { type: 'object', required: ['answer'], additionalProperties: false } })
  const b = baseReq({ schema: { additionalProperties: false, required: ['answer'], type: 'object' } })
  assert.equal(cacheKey(a), cacheKey(b))
})

test('cacheKey changes when any output-affecting field changes', () => {
  const base = cacheKey(baseReq())
  const variants: EvalRequest[] = [
    baseReq({ prompt: 'different' }),
    baseReq({ model: 'claude-opus-4-8' }),
    baseReq({ schema: { type: 'object', required: ['result'] } }),
    baseReq({ systemPrompt: 'You are terse.' }),
    baseReq({ appendSystemPrompt: 'Context.' }),
    baseReq({ tools: ['Read'] }),
    baseReq({ settings: '{"x":1}' }),
    baseReq({ cwd: '/sandbox/a' }),
    baseReq({ addDirs: ['/sandbox/a'] }),
    baseReq({ permissionMode: 'bypassPermissions' }),
    baseReq({ env: { STRAPPED_STATE_ROOT: '/sandbox/a/state' } }),
    baseReq({ timeoutMs: 60_000 }),
    baseReq({ maxTurns: 3 }),
  ]
  for (const v of variants) {
    assert.notEqual(cacheKey(v), base)
  }
  // All variants are distinct from each other too.
  const keys = new Set(variants.map(cacheKey))
  assert.equal(keys.size, variants.length)
})

test('cacheKey separates two requests differing only in an agentic field', () => {
  // Two sandboxes, same prompt/model/schema: the keys must NOT collide, or a
  // cache-using caller would serve sandbox A's answer to sandbox B.
  const a = baseReq({ cwd: '/sandbox/a', env: { STRAPPED_STATE_ROOT: '/sandbox/a/state' } })
  const b = baseReq({ cwd: '/sandbox/b', env: { STRAPPED_STATE_ROOT: '/sandbox/b/state' } })
  assert.notEqual(cacheKey(a), cacheKey(b))
})

// --- file round-trip ---------------------------------------------------------

test('ResponseCache round-trips a result and marks it cached on read', () => {
  const cache = new ResponseCache(tempDir())
  const key = cacheKey(baseReq())
  assert.equal(cache.get(key), null)

  const result = runClaude(baseReq(), { spawn: fakeSpawn(successEnvelope({ answer: 42 })) })
  cache.set(key, result)

  const hit = cache.get(key)
  assert.ok(hit)
  assert.equal(hit.cached, true)
  assert.deepEqual(hit.output, { answer: 42 })
  assert.equal(hit.cost, result.cost)
})

test('ResponseCaches in separate dirs are isolated', () => {
  const a = new ResponseCache(tempDir())
  const b = new ResponseCache(tempDir())
  const key = cacheKey(baseReq())
  a.set(key, runClaude(baseReq(), { spawn: fakeSpawn(successEnvelope({ answer: 1 })) }))
  assert.ok(a.get(key))
  assert.equal(b.get(key), null)
})

// --- runClaude cache integration ---------------------------------------------

test('runClaude serves an identical request from cache without spawning', () => {
  const cache = new ResponseCache(tempDir())
  let spawnCalls = 0
  const countingSpawn: Spawn = (cmd, args, input) => {
    spawnCalls++
    return fakeSpawn(successEnvelope({ answer: 42 }))(cmd, args, input)
  }

  const first = runClaude(baseReq(), { spawn: countingSpawn, cache })
  assert.equal(first.ok, true)
  assert.equal(first.cached, false)
  assert.equal(spawnCalls, 1)

  // Second identical call: cache hit, no further spawn (throwingSpawn proves it).
  const second = runClaude(baseReq(), { spawn: throwingSpawn(), cache })
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.deepEqual(second.output, { answer: 42 })
  assert.equal(spawnCalls, 1)
})

test('runClaude misses the cache when a keyed field changes', () => {
  const cache = new ResponseCache(tempDir())
  runClaude(baseReq(), { spawn: fakeSpawn(successEnvelope({ answer: 42 })) , cache })

  let spawned = false
  const spawn: Spawn = (cmd, args, input) => {
    spawned = true
    return fakeSpawn(successEnvelope({ answer: 7 }))(cmd, args, input)
  }
  const result = runClaude(baseReq({ model: 'claude-opus-4-8' }), { spawn, cache })
  assert.equal(spawned, true)
  assert.equal(result.cached, false)
  assert.deepEqual(result.output, { answer: 7 })
})

test('runClaude does not cache a graded failure', () => {
  const cache = new ResponseCache(tempDir())
  // A schema-miss success envelope grades ok:false and must not be cached.
  runClaude(baseReq(), { spawn: fakeSpawn(successEnvelope({ wrong: 1 })), cache })
  assert.equal(cache.get(cacheKey(baseReq())), null)
})
