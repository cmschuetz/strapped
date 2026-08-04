// Deterministic seeded rule split for scenario runs: one {a, b} partition of
// rule IDS per review round, computed with a mulberry32 PRNG shuffle seeded by
// `seed + round`. Pure — the same (rules, seed, rounds) always yields the same
// partitions, which is what makes before/after workflow comparisons stable.
// It need not match the python split documented in conventions.md; determinism
// is the contract. The partitions carry ids ONLY — the rule text reaches
// agents through the sandbox's `reviews/rules-snapshot.md` (see sandbox.ts),
// mirroring the skills' rulesFile dispatch shape.

import type { ScenarioRule } from './types.ts'

/** One review round's reviewer split — rule ids only. */
export interface RulePartition {
  a: string[]
  b: string[]
}

/** Classic mulberry32: a tiny deterministic PRNG over a 32-bit state. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates shuffle of a copy, driven by the given PRNG. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const a = out[i]
    const b = out[j]
    if (a !== undefined && b !== undefined) {
      out[i] = b
      out[j] = a
    }
  }
  return out
}

/**
 * Deterministic per-round rule-id partitions: for each 1-indexed round up to
 * `rounds`, shuffle the rule ids with a PRNG seeded by `seed + round`, give
 * reviewer `a` the first half (rounded up) and reviewer `b` the rest, then
 * sort each half. Every rule id appears exactly once per round.
 */
export function splitRules(rules: readonly ScenarioRule[], seed: number, rounds: number): RulePartition[] {
  const ids = rules.map(r => r.id)
  const partitions: RulePartition[] = []
  for (let round = 1; round <= rounds; round++) {
    const shuffled = shuffle(ids, mulberry32(seed + round))
    const half = Math.ceil(shuffled.length / 2)
    partitions.push({
      a: shuffled.slice(0, half).sort(),
      b: shuffled.slice(half).sort(),
    })
  }
  return partitions
}
