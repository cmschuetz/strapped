// splitRules: deterministic seeded per-round rule-id partitions (ids only —
// rule text never enters the workflow args).

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

test('partitions carry id strings only — no rule text or source objects', () => {
  const partitions = splitRules(RULES, 42, 2)
  for (const { a, b } of partitions) {
    for (const entry of [...a, ...b]) {
      assert.equal(typeof entry, 'string')
      assert.ok(RULES.some(r => r.id === entry), `${entry} is a known rule id`)
    }
  }
})

test('every rule id appears exactly once per round, halves sized evenly and sorted', () => {
  const partitions = splitRules(RULES, 42, 4)
  assert.equal(partitions.length, 4)
  const allIds = RULES.map(r => r.id).sort()
  for (const { a, b } of partitions) {
    assert.deepEqual([...a, ...b].sort(), allIds) // exactly once: union is the full set, sizes match
    assert.ok(Math.abs(a.length - b.length) <= 1)
    assert.deepEqual(a, [...a].sort())
    assert.deepEqual(b, [...b].sort())
  }
})

test('the shuffle actually varies across rounds and seeds', () => {
  const partitions = splitRules(RULES, 42, 6)
  const shapes = new Set(partitions.map(p => JSON.stringify(p.a)))
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
