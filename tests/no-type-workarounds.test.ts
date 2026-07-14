// Ports the old eslint `no-restricted-syntax` selector `TSAsExpression > TSAsExpression`
// (deleted with eslint.config.mjs) as an oxc-parser AST guard: no `.ts` under src/,
// tools/, or tests/ may contain an `x as unknown as T` double-cast — a TSAsExpression
// whose own `.expression` is another TSAsExpression. oxlint has no native rule for this,
// so the check lives here. Matching by AST shape (not text) never false-matches the
// string `as unknown as` inside a comment or literal.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every `.ts` file under the given roots, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...tsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Strip any `ParenthesizedExpression` wrapper(s) oxc-parser inserts around an
 * expression. typescript-eslint elides parens from its ESTree output, so the
 * old `TSAsExpression > TSAsExpression` selector caught the parenthesized
 * `(x as unknown) as T` form; oxc-parser keeps a `ParenthesizedExpression`
 * node between the two casts, so we must unwrap it to preserve parity.
 */
function unwrapParens(node: unknown): unknown {
  let cur = node
  while (
    cur !== null &&
    typeof cur === 'object' &&
    !Array.isArray(cur) &&
    (cur as Record<string, unknown>)['type'] === 'ParenthesizedExpression'
  ) {
    cur = (cur as Record<string, unknown>)['expression']
  }
  return cur
}

/**
 * Recursively walk an oxc-parser TS-ESTree AST and return true if any
 * TSAsExpression node's `.expression` is itself a TSAsExpression (the
 * `x as unknown as T` double-cast), including the parenthesized
 * `(x as unknown) as T` form. Walks arrays/objects defensively.
 */
function hasDoubleCast(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) {
    return node.some(hasDoubleCast)
  }
  const rec = node as Record<string, unknown>
  if (rec['type'] === 'TSAsExpression') {
    const expr = unwrapParens(rec['expression'])
    if (expr !== null && typeof expr === 'object' && (expr as Record<string, unknown>)['type'] === 'TSAsExpression') {
      return true
    }
  }
  for (const key of Object.keys(rec)) {
    if (key === 'type') continue
    if (hasDoubleCast(rec[key])) return true
  }
  return false
}

test('no source file contains an `x as unknown as T` double-cast', () => {
  const files = [join(ROOT, 'src'), join(ROOT, 'tools'), join(ROOT, 'tests')].flatMap(tsFiles)
  assert.ok(files.length > 0, 'expected to find .ts files to scan')
  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const { program } = parseSync(file, source)
    if (hasDoubleCast(program)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `double-cast found in:\n${offenders.join('\n')}`)
})

test('the walker flags a known double-cast snippet (self-check)', () => {
  // Parsed in-test, never committed to the tree — proves the guard would go red.
  const bad = parseSync('scratch.ts', 'const x = 1 as unknown as string;\n')
  assert.ok(hasDoubleCast(bad.program), 'walker must flag `1 as unknown as string`')

  // Parenthesized form: oxc-parser inserts a ParenthesizedExpression between
  // the two casts, so the guard must unwrap it to keep parity with the old
  // typescript-eslint `TSAsExpression > TSAsExpression` selector.
  const badParen = parseSync('scratch.ts', 'const z = (1 as unknown) as string;\n')
  assert.ok(hasDoubleCast(badParen.program), 'walker must flag `(1 as unknown) as string`')

  const good = parseSync('scratch.ts', 'const y = 2 as number;\n')
  assert.equal(hasDoubleCast(good.program), false, 'single cast must not be flagged')
})
