// Behavioral proof that oxlint, driven by the repo's committed .oxlintrc.json,
// actually ENFORCES the two ported eslint rules — not merely that the config file
// has the right JSON shape. It spawns the real oxlint binary over temp fixtures
// and asserts each banned construct is flagged (by rule id) and clean TS is not.
//
// This is the guard that catches a silently non-firing rule: a missing
// `plugins: ["typescript"]`, a renamed rule id, or a semantics gap (e.g. a
// described `@ts-expect-error` slipping through as allow-with-description) would
// leave `bun run lint` green with zero real enforcement. A shape assertion of
// .oxlintrc.json can never catch that.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint')
const CONFIG = join(ROOT, '.oxlintrc.json')

interface Diagnostic {
  code: string
  severity: string
  filename: string
}

/**
 * Write `source` to a fixture file in a fresh temp dir, run the real oxlint with
 * the repo's .oxlintrc.json, and return the parsed diagnostics + exit status.
 */
function lint(source: string): { status: number | null; codes: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'oxlint-parity-'))
  const file = join(dir, 'fixture.ts')
  writeFileSync(file, source)
  const res = spawnSync(OXLINT, ['--config', CONFIG, '--format', 'json', file], {
    encoding: 'utf8',
  })
  const parsed = JSON.parse(res.stdout) as { diagnostics: Diagnostic[] }
  return { status: res.status, codes: parsed.diagnostics.map(d => d.code) }
}

/** Every diagnostic code carries the rule id in parentheses, e.g. `typescript(no-explicit-any)`. */
function flagsRule(codes: string[], ruleId: string): boolean {
  return codes.some(c => c.includes(ruleId))
}

test('flags `: any` type annotation (no-explicit-any)', () => {
  const { status, codes } = lint('const x: any = 1;\nexport { x }\n')
  assert.notEqual(status, 0, 'oxlint must exit non-zero on an error')
  assert.ok(flagsRule(codes, 'no-explicit-any'), `expected no-explicit-any, got ${codes.join(', ')}`)
})

test('flags `as any` assertion (no-explicit-any)', () => {
  const { codes } = lint('declare const z: unknown;\nconst y = z as any;\nexport { y }\n')
  assert.ok(flagsRule(codes, 'no-explicit-any'), `expected no-explicit-any, got ${codes.join(', ')}`)
})

test('flags `<any>` angle-bracket cast (no-explicit-any)', () => {
  const { codes } = lint('declare const z: unknown;\nconst w = <any>z;\nexport { w }\n')
  assert.ok(flagsRule(codes, 'no-explicit-any'), `expected no-explicit-any, got ${codes.join(', ')}`)
})

test('flags @ts-ignore (ban-ts-comment)', () => {
  const { codes } = lint('// @ts-ignore\nconst a = 1;\nexport { a }\n')
  assert.ok(flagsRule(codes, 'ban-ts-comment'), `expected ban-ts-comment, got ${codes.join(', ')}`)
})

test('flags @ts-expect-error (ban-ts-comment)', () => {
  const { codes } = lint('// @ts-expect-error\nconst b = 1;\nexport { b }\n')
  assert.ok(flagsRule(codes, 'ban-ts-comment'), `expected ban-ts-comment, got ${codes.join(', ')}`)
})

test('flags @ts-nocheck (ban-ts-comment)', () => {
  const { codes } = lint('// @ts-nocheck\nconst c = 1;\nexport { c }\n')
  assert.ok(flagsRule(codes, 'ban-ts-comment'), `expected ban-ts-comment, got ${codes.join(', ')}`)
})

// The single most important fixture: `ts-expect-error: true` was configured to
// close the allow-with-description hole. Rule defaults would leave a described
// directive-with-reason permitted; this proves `true` bans even the described form.
test('flags a DESCRIBED @ts-expect-error (ban-ts-comment, allow-with-description hole closed)', () => {
  const { codes } = lint('// @ts-expect-error a description here\nconst d = 1;\nexport { d }\n')
  assert.ok(
    flagsRule(codes, 'ban-ts-comment'),
    `described @ts-expect-error must still be banned, got ${codes.join(', ')}`
  )
})

test('does NOT flag clean TypeScript (no over-firing)', () => {
  const { status, codes } = lint('const n: number = 1;\nconst s = `${n}`;\nexport { n, s }\n')
  assert.equal(status, 0, `clean TS must exit 0, got status ${status} with ${codes.join(', ')}`)
  assert.deepEqual(codes, [], `clean TS must produce zero diagnostics, got ${codes.join(', ')}`)
})
