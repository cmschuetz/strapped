// Engine tests: pure argv construction, envelope grading over
// success/fallback/error/schema-miss/unparseable, and the isAvailable/skip
// paths — all through the injected `Spawn` stub, never a real `claude`.

import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { buildArgs, isAvailable, parseEnvelope, runClaude } from '../../src/eval/engine.ts'
import type { EvalRequest, JsonSchema } from '../../src/eval/types.ts'
import {
  errorEnvelope,
  fakeSpawn,
  rawSpawn,
  schemaMismatchEnvelope,
  successEnvelope,
  throwingSpawn,
} from '../helpers/fake-claude.ts'

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

// --- buildArgs (acceptance criterion 1) --------------------------------------

test('buildArgs forces print mode, JSON output, schema, model, strict MCP, and settings', () => {
  const args = buildArgs(baseReq())
  assert.ok(args.includes('--print'))
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), [
    '--output-format',
    'json',
  ])
  assert.deepEqual(args.slice(args.indexOf('--json-schema'), args.indexOf('--json-schema') + 2), [
    '--json-schema',
    JSON.stringify(SCHEMA),
  ])
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), [
    '--model',
    'claude-haiku-4-5',
  ])
  assert.ok(args.includes('--strict-mcp-config'))
  assert.deepEqual(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2), ['--settings', '{}'])
})

test('buildArgs disables tools by default and never puts the prompt in argv', () => {
  const args = buildArgs(baseReq())
  assert.ok(args.includes('--disallowedTools'))
  assert.ok(!args.includes('--allowedTools'))
  // The prompt travels on stdin, so it must not appear in argv.
  assert.ok(!args.some(a => a.includes('6 * 7')))
})

test('buildArgs opts into an allow-list when tools are provided', () => {
  const args = buildArgs(baseReq({ tools: ['Read', 'Grep'] }))
  assert.deepEqual(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2), [
    '--allowedTools',
    'Read Grep',
  ])
  assert.ok(!args.includes('--disallowedTools'))
})

test('buildArgs adds system-prompt flags only when set, and passes custom settings', () => {
  const bare = buildArgs(baseReq())
  assert.ok(!bare.includes('--system-prompt'))
  assert.ok(!bare.includes('--append-system-prompt'))

  const withSys = buildArgs(baseReq({ systemPrompt: 'You are terse.', appendSystemPrompt: 'Context.', settings: '{"x":1}' }))
  assert.deepEqual(withSys.slice(withSys.indexOf('--system-prompt'), withSys.indexOf('--system-prompt') + 2), [
    '--system-prompt',
    'You are terse.',
  ])
  assert.deepEqual(
    withSys.slice(withSys.indexOf('--append-system-prompt'), withSys.indexOf('--append-system-prompt') + 2),
    ['--append-system-prompt', 'Context.']
  )
  assert.deepEqual(withSys.slice(withSys.indexOf('--settings'), withSys.indexOf('--settings') + 2), [
    '--settings',
    '{"x":1}',
  ])
})

// --- success + fallback (acceptance criterion 2) -----------------------------

test('a success envelope with structured_output yields ok:true with cost/usage/output', () => {
  const envelope = successEnvelope(
    { answer: 42 },
    { cost: 0.0463, usage: { inputTokens: 10, outputTokens: 158, cacheReadInputTokens: 3 }, durationMs: 2419, apiDurationMs: 2394, numTurns: 2 }
  )
  const result = runClaude(baseReq(), { spawn: fakeSpawn(envelope) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.output, { answer: 42 })
  assert.equal(result.error, null)
  assert.equal(result.cost, 0.0463)
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 158,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 0,
  })
  assert.equal(result.durationMs, 2419)
  assert.equal(result.apiDurationMs, 2394)
  assert.equal(result.numTurns, 2)
  assert.equal(result.model, 'claude-haiku-4-5')
  assert.equal(result.cached, false)
})

test('a missing structured_output falls back to JSON.parse(result)', () => {
  const envelope = successEnvelope({ answer: 7 }, { structured: false })
  assert.equal(envelope.structured_output, undefined)
  const result = runClaude(baseReq(), { spawn: fakeSpawn(envelope) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.output, { answer: 7 })
})

// --- graded failures, no throw (acceptance criterion 3) ----------------------

test('is_error / non-success subtype grades ok:false without throwing', () => {
  const result = runClaude(baseReq(), { spawn: fakeSpawn(errorEnvelope('error_max_turns')) })
  assert.equal(result.ok, false)
  assert.equal(result.output, null)
  assert.match(result.error ?? '', /error_max_turns/)
  // Metrics from the envelope are still surfaced.
  assert.equal(result.cost, 0.002)
})

test('schema-nonconforming output grades ok:false with a descriptive error', () => {
  const result = runClaude(baseReq(), { spawn: fakeSpawn(schemaMismatchEnvelope()) })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /required key: answer/)
})

test('additionalProperties:false rejects an extra key', () => {
  const envelope = successEnvelope({ answer: 1, extra: 2 })
  const result = parseEnvelope(JSON.stringify(envelope), baseReq())
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /unexpected key: extra/)
})

test('unparseable stdout grades ok:false with zeroed metrics, no throw', () => {
  const result = runClaude(baseReq(), { spawn: rawSpawn(0, 'not json at all') })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'unparseable envelope')
  assert.equal(result.cost, 0)
  assert.equal(result.durationMs, 0)
})

// --- availability + skip (acceptance criterion 5) ----------------------------

test('isAvailable is false when claude --version exits non-zero or throws', () => {
  assert.equal(isAvailable(rawSpawn(127, '', 'command not found')), false)
  assert.equal(isAvailable(throwingSpawn()), false)
  assert.equal(isAvailable(rawSpawn(0, 'claude 2.1.207')), true)
})

test('runClaude against an absent CLI returns a skipped result, never throws', () => {
  const viaExit = runClaude(baseReq(), { spawn: rawSpawn(127, '', 'not found') })
  assert.equal(viaExit.skipped, true)
  assert.equal(viaExit.ok, false)
  assert.match(viaExit.error ?? '', /unavailable/)

  const viaThrow = runClaude(baseReq(), { spawn: throwingSpawn() })
  assert.equal(viaThrow.skipped, true)
  assert.equal(viaThrow.ok, false)
})

test('a non-zero exit that still produced envelope stdout is graded, not skipped', () => {
  // The CLI can exit non-zero while emitting an error envelope — that is a
  // graded failure, not an availability skip.
  const result = runClaude(baseReq(), { spawn: rawSpawn(1, JSON.stringify(errorEnvelope('error_during_execution'))) })
  assert.equal(result.skipped, undefined)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /error_during_execution/)
})
