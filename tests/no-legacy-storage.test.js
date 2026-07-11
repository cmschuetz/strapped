// Guard: the repo-local storage concepts removed by the global-only stateRoot
// model must never creep back into the prose/spec surface (conventions.md, the
// SKILL.mds, scripts, README, manifests — every tracked file OUTSIDE tests/).
//
// tests/ is excluded ENTIRELY and by design: test files legitimately embed the
// legacy literals as regression fixtures (sync-prs.test.js creates a
// .claude/strapped-config.json fixture and sets STRAPPED_STATE_ROOT to the old
// relative default), so walking them would make this guard fail on itself.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const LEGACY_TOKENS = ['strapped-config.json', 'repo-relative', 'Repo-relative', 'plans/strapped']

test('no tracked file outside tests/ mentions the removed repo-local storage concepts', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => f && !f.startsWith('tests/'))
  assert.ok(files.length > 0, 'expected tracked files outside tests/')

  const offenders = []
  for (const file of files) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8')
    for (const token of LEGACY_TOKENS) {
      if (src.includes(token)) offenders.push(`${file}: ${token}`)
    }
  }
  assert.deepEqual(offenders, [], `legacy storage concepts crept back in:\n${offenders.join('\n')}`)
})
