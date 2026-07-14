// JS-hygiene guard: the repo migrated to TypeScript, so the ONLY tracked `.js`
// file is the single generated workflow deployable. This test fails the moment
// any other `.js` slips in — especially a `*.test.js`/`*.spec.js` or any `.js`
// under tests/ — the exact stray-file class the TS migration is meant to
// exclude. Enumerates tracked files via `git ls-files` so only
// intentionally-checked-in files count (never node_modules/worktrees/build output).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// The sole generated `.js` deployable a marketplace install runs (bundled by
// tools/build.ts). Every other tracked `.js` is a stray from the TS migration.
const ALLOWLIST = ['plugins/strapped/workflows/strapped-run.js']

function trackedJsFiles(): string[] {
  const res = spawnSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(res.status, 0, `git ls-files failed: ${res.stderr}`)
  return res.stdout.split('\n').filter(Boolean)
}

test('the only tracked .js file is the generated workflow deployable', () => {
  const tracked = trackedJsFiles().sort()
  assert.deepEqual(
    tracked,
    [...ALLOWLIST].sort(),
    `unexpected tracked .js file(s) outside the allowlist: ${tracked
      .filter(f => !ALLOWLIST.includes(f))
      .join(', ')}`
  )
})

test('no tracked *.test.js or *.spec.js exists anywhere (tests are TypeScript)', () => {
  const offenders = trackedJsFiles().filter(f => f.endsWith('.test.js') || f.endsWith('.spec.js'))
  assert.deepEqual(offenders, [], `stray compiled/js test file(s): ${offenders.join(', ')}`)
})

test('no tracked .js exists under tests/', () => {
  const offenders = trackedJsFiles().filter(f => f.startsWith('tests/'))
  assert.deepEqual(offenders, [], `stray .js under tests/: ${offenders.join(', ')}`)
})
