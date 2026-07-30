// splitRules: deterministic seeded per-round rule partitions (D1 AC7).

import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { splitRules } from '../../src/eval/scenario/rules.ts'
import type { ScenarioRule } from '../../src/eval/scenario/types.ts'

const RULES: ScenarioRule[] = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'].map(id => ({
  id,
  source: 'CLAUDE.md',
  text: `rule ${id}`,
}))

test('splitRules is deterministic for a fixed (rules, seed, rounds)', () => {
  assert.deepEqual(splitRules(RULES, 42, 3), splitRules(RULES, 42, 3))
})

test('every rule appears exactly once per round, halves sized evenly and sorted by id', () => {
  const partitions = splitRules(RULES, 42, 4)
  assert.equal(partitions.length, 4)
  const allIds = RULES.map(r => r.id).sort()
  for (const { a, b } of partitions) {
    const ids = [...a, ...b].map(r => r.id).sort()
    assert.deepEqual(ids, allIds) // exactly once: union is the full set, sizes match
    assert.ok(Math.abs(a.length - b.length) <= 1)
    assert.deepEqual(a.map(r => r.id), [...a.map(r => r.id)].sort())
    assert.deepEqual(b.map(r => r.id), [...b.map(r => r.id)].sort())
  }
})

test('the shuffle actually varies across rounds and seeds', () => {
  const partitions = splitRules(RULES, 42, 6)
  const shapes = new Set(partitions.map(p => JSON.stringify(p.a.map(r => r.id))))
  assert.ok(shapes.size > 1, 'six rounds should not all pick the identical half')
  assert.notDeepEqual(splitRules(RULES, 1, 1), splitRules(RULES, 2, 1))
})

test('edge cases: zero rounds and empty rule sets', () => {
  assert.deepEqual(splitRules(RULES, 42, 0), [])
  assert.deepEqual(splitRules([], 42, 2), [
    { a: [], b: [] },
    { a: [], b: [] },
  ])
})
