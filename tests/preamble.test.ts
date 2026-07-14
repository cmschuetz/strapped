// Integration tests for plugins/strapped/scripts/preamble.sh: spawn the REAL
// script with an isolated HOME, a controlled PATH, STRAPPED_STATE_ROOT
// pointing at a temp fixture, and CLAUDE_PLUGIN_ROOT pointing at the real
// plugin. The script is a SessionStart hook: every path must exit 0.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PREAMBLE_SCRIPT, makeHookEnv, type HookEnv, type RunOptions } from './helpers/hook-env.ts'
import { NODE } from './helpers/node-bin.ts'
import { STATE_SCRIPT } from './helpers/state-env.ts'

const PLUGIN_ROOT = fileURLToPath(new URL('../plugins/strapped', import.meta.url))

const SENTINEL_LINE = '=== STRAPPED PREAMBLE (strapped-preamble-v1) ==='

const runPreamble = (env: HookEnv, opts: RunOptions = {}) =>
  env.run({
    script: PREAMBLE_SCRIPT,
    ...opts,
    env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...(opts.env ?? {}) },
  })

test('full injection: sentinel + complete conventions + state summary', () => {
  const env = makeHookEnv()
  env.addManifest('my-run', { slug: 'my-run', status: 'implementing' })
  env.addDeliverable('my-run', 'D1-a.md', { id: 'D1', deps: '[]', status: 'done' })
  env.addDeliverable('my-run', 'D2-b.md', { id: 'D2', deps: '[D1]', status: 'pr-open' })
  env.addDeliverable('my-run', 'D3-c.md', { id: 'D3', deps: '[D2]', status: 'pending' })
  const res = runPreamble(env)
  assert.equal(res.status, 0)
  assert.equal(res.stderr, '')
  assert.ok(res.stdout.startsWith(SENTINEL_LINE), 'stdout must start with the sentinel line')
  // Top-of-file heading AND a deep-in-file marker prove the WHOLE conventions file was injected.
  assert.ok(res.stdout.includes('# Harness conventions'))
  assert.ok(res.stdout.includes('## Cleanup recipe'))
  assert.ok(res.stdout.includes('=== STRAPPED STATE SUMMARY ==='))
  // uniq output is sorted alphabetically by status.
  assert.ok(res.stdout.includes('- my-run [implementing]: 1 done, 1 pending, 1 pr-open'))
  assert.ok(res.stdout.trimEnd().endsWith('=== END STRAPPED PREAMBLE ==='))
})

test('real-file round-trip: preamble.sh reads the manifest status state.mjs (gray-matter) writes', () => {
  const env = makeHookEnv()
  env.addManifest('my-run', { slug: 'my-run', status: 'approved' })
  env.addDeliverable('my-run', 'D1-a.md', { id: 'D1', deps: '[]', status: 'done' })
  const runDir = join(env.stateRoot, 'runs', 'my-run')
  const flip = spawnSync(NODE, [STATE_SCRIPT, 'manifest-status', runDir, 'implementing'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: env.home, STRAPPED_STATE_ROOT: env.stateRoot },
  })
  assert.equal(flip.status, 0, flip.stderr)
  const res = runPreamble(env)
  assert.equal(res.status, 0)
  assert.equal(res.stderr, '')
  assert.ok(res.stdout.includes('- my-run [implementing]: 1 done'), res.stdout)
})

test('no state: static preamble still injected with "No strapped runs found."', () => {
  const env = makeHookEnv()
  const res = runPreamble(env)
  assert.equal(res.status, 0)
  assert.equal(res.stderr, '')
  assert.ok(res.stdout.startsWith(SENTINEL_LINE))
  assert.ok(res.stdout.includes('# Harness conventions'))
  assert.ok(res.stdout.includes('No strapped runs found.'))
})

test('unresolvable stateRoot: static preamble still injected, cwd-independent', () => {
  const env = makeHookEnv()
  const otherCwd = mkdtempSync(join(tmpdir(), 'strapped-preamble-cwd-'))
  const results = [env.home, otherCwd].map(cwd =>
    runPreamble(env, { cwd, env: { STRAPPED_STATE_ROOT: 'plans/strapped' } })
  )
  for (const res of results) {
    assert.equal(res.status, 0)
    assert.equal(res.stderr, '')
    assert.ok(res.stdout.startsWith(SENTINEL_LINE))
    assert.ok(res.stdout.includes('# Harness conventions'))
    assert.ok(res.stdout.includes('## Cleanup recipe'))
    assert.ok(res.stdout.includes('No strapped runs found.'))
  }
  assert.equal(results[0]?.stdout, results[1]?.stdout, 'output must not depend on the cwd')
})

test('missing conventions.md: silent exit 0', () => {
  const env = makeHookEnv()
  const emptyPluginRoot = mkdtempSync(join(tmpdir(), 'strapped-preamble-empty-'))
  const res = runPreamble(env, { env: { CLAUDE_PLUGIN_ROOT: emptyPluginRoot } })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '')
  assert.equal(res.stderr, '')
})

test('degraded run state: runs without deliverables or without a status line do not error', () => {
  const env = makeHookEnv()
  env.addManifest('bare-run', { slug: 'bare-run', status: 'draft' }) // no deliverables at all
  env.addManifest('no-status-run', { slug: 'no-status-run' }) // manifest without a status line
  const res = runPreamble(env)
  assert.equal(res.status, 0)
  assert.equal(res.stderr, '')
  assert.ok(res.stdout.includes('- bare-run [draft]\n'), 'run without deliverables is listed without counts')
  assert.ok(res.stdout.includes('- no-status-run [unknown]\n'), 'run without a status line is still listed')
  assert.ok(!res.stdout.includes('No strapped runs found.'))
})

test('multiple runs summarized: one line each with their own counts', () => {
  const env = makeHookEnv()
  env.addManifest('run-one', { slug: 'run-one', status: 'complete' })
  env.addDeliverable('run-one', 'D1-a.md', { id: 'D1', deps: '[]', status: 'merged' })
  env.addDeliverable('run-one', 'D2-b.md', { id: 'D2', deps: '[D1]', status: 'merged' })
  env.addManifest('run-two', { slug: 'run-two', status: 'implementing' })
  env.addDeliverable('run-two', 'D1-x.md', { id: 'D1', deps: '[]', status: 'in-progress' })
  const res = runPreamble(env)
  assert.equal(res.status, 0)
  assert.equal(res.stderr, '')
  assert.ok(res.stdout.includes('- run-one [complete]: 2 merged'))
  assert.ok(res.stdout.includes('- run-two [implementing]: 1 in-progress'))
})
