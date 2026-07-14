// Integration tests for plugins/strapped/scripts/sync-prs.sh: spawn the REAL
// script with an isolated HOME, a controlled PATH (stub gh at the front, no
// real gh reachable), and STRAPPED_STATE_ROOT pointing at a temp fixture.
// The script is a SessionStart hook: every path must exit 0.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'bun:test'
import { ghStub, makeHookEnv } from './helpers/hook-env.js'
import { NODE } from './helpers/node-bin.ts'
import { STATE_SCRIPT } from './helpers/state-env.ts'

const MERGED = ghStub('{"state":"MERGED","reviewDecision":null}')
const CHANGES_REQUESTED = ghStub('{"state":"OPEN","reviewDecision":"CHANGES_REQUESTED"}')

// Spawn the REAL state.mjs (under node) to write into the hook env's state root —
// so downstream assertions run against gray-matter-produced files, not fixtures.
function runState(env, args) {
  const res = spawnSync(NODE, [STATE_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: env.home, STRAPPED_STATE_ROOT: env.stateRoot },
  })
  assert.equal(res.status, 0, res.stderr)
  return res
}

// Write a pr-open deliverable fixture under an arbitrary state root (the
// helper's addDeliverable is pinned to its own stateRoot).
function writeDeliverable(stateRoot, slug, filename) {
  const dir = join(stateRoot, 'runs', slug, 'deliverables')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, filename)
  writeFileSync(
    file,
    '---\nid: D1\ntitle: Thing\ndeps: []\nstatus: pr-open\npr: https://github.com/o/r/pull/1\n---\nBody.\n'
  )
  return file
}

test('no state: empty state root → silent exit 0', () => {
  const env = makeHookEnv({ gh: MERGED })
  const res = env.run()
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '')
  assert.equal(res.stderr, '')
})

test('merged flip: pr-open deliverable whose PR merged → status flipped, flip announced', () => {
  const env = makeHookEnv({ gh: MERGED })
  env.addDeliverable('my-run', 'D1-thing.md', {
    id: 'D1',
    title: 'Thing',
    deps: '[]',
    status: 'pr-open',
    pr: 'https://github.com/o/r/pull/1',
  })
  const res = env.run()
  assert.equal(res.status, 0)
  assert.match(res.stdout, /my-run\/D1 PR merged → status merged/)
  assert.ok(res.stdout.includes('https://github.com/o/r/pull/1'))
  const file = env.readDeliverable('my-run', 'D1-thing.md')
  assert.ok(file.includes('status: merged'))
  assert.ok(!file.includes('status: pr-open'))
})

test('changes requested: warning + /strapped:feedback hint, file unchanged, exit 0', () => {
  const env = makeHookEnv({ gh: CHANGES_REQUESTED })
  env.addDeliverable('my-run', 'D1-thing.md', {
    id: 'D1',
    title: 'Thing',
    deps: '[]',
    status: 'pr-open',
    pr: 'https://github.com/o/r/pull/1',
  })
  const res = env.run()
  assert.equal(res.status, 0)
  assert.match(res.stdout, /my-run\/D1 PR has changes requested/)
  assert.match(res.stdout, /\/strapped:feedback my-run/)
  assert.ok(env.readDeliverable('my-run', 'D1-thing.md').includes('status: pr-open'))
})

test('unblocked child: pending D2 with deps [D1] gets an unblocked hint when D1 flips to merged', () => {
  const env = makeHookEnv({ gh: MERGED })
  env.addDeliverable('my-run', 'D1-thing.md', {
    id: 'D1',
    title: 'Thing',
    deps: '[]',
    status: 'pr-open',
    pr: 'https://github.com/o/r/pull/1',
  })
  env.addDeliverable('my-run', 'D2-follow-up.md', {
    id: 'D2',
    title: 'Follow up',
    deps: '[D1]',
    status: 'pending',
    pr: 'null',
  })
  const res = env.run()
  assert.equal(res.status, 0)
  assert.match(res.stdout, /my-run\/D2 is now unblocked → \/strapped:implement my-run --only D2/)
  assert.ok(env.readDeliverable('my-run', 'D1-thing.md').includes('status: merged'))
  assert.ok(env.readDeliverable('my-run', 'D2-follow-up.md').includes('status: pending'))
})

test('real-file round-trip: sync-prs.sh parses the grep shapes state.mjs (gray-matter) actually writes', () => {
  const env = makeHookEnv({ gh: MERGED })
  // Seed two deliverables, then let the gray-matter writer produce every
  // grep-consumed shape: a pr-open status, a single-space `pr:` URL line, and a
  // deps flow array — never hand-authored fixtures.
  const d1 = env.addDeliverable('my-run', 'D1-thing.md', {
    id: 'D1', title: 'Thing', deps: '[]', status: 'done', pr: 'null',
  })
  const d2 = env.addDeliverable('my-run', 'D2-follow.md', {
    id: 'D2', title: 'Follow', deps: '[]', status: 'pending', pr: 'null',
  })
  runState(env, ['transition', d1, 'pr-open'])
  runState(env, ['set', d1, 'pr', 'https://github.com/o/r/pull/1'])
  runState(env, ['set', d2, 'deps', '[D1]'])

  // The writer emits the URL as a single-space `pr:` scalar line (the shape
  // sync-prs.sh greps — js-yaml's core schema leaves this colon-bearing value
  // unquoted) and keeps the deps flow array.
  assert.match(env.readDeliverable('my-run', 'D1-thing.md'), /^pr: https:\/\/github\.com\/o\/r\/pull\/1$/m)
  assert.match(env.readDeliverable('my-run', 'D1-thing.md'), /^status: pr-open$/m)
  assert.match(env.readDeliverable('my-run', 'D2-follow.md'), /^deps: \[D1\]$/m)

  const res = env.run()
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /my-run\/D1 PR merged → status merged/)
  assert.ok(res.stdout.includes('https://github.com/o/r/pull/1'), res.stdout)
  assert.match(res.stdout, /my-run\/D2 is now unblocked → \/strapped:implement my-run --only D2/)
  assert.ok(env.readDeliverable('my-run', 'D1-thing.md').includes('status: merged'))
})

// --- stateRoot resolution: env > ~/.claude/strapped.json > default ~/.claude/strapped ---

test('default resolution: no env, no anchor → state found under $HOME/.claude/strapped', () => {
  const env = makeHookEnv({ gh: MERGED })
  const defaultRoot = join(env.home, '.claude', 'strapped')
  const file = writeDeliverable(defaultRoot, 'my-run', 'D1-thing.md')
  const res = env.run({ env: { STRAPPED_STATE_ROOT: undefined } })
  assert.equal(res.status, 0)
  assert.match(res.stdout, /my-run\/D1 PR merged → status merged/)
  assert.ok(readFileSync(file, 'utf8').includes('status: merged'))
})

test('anchor resolution: ~/.claude/strapped.json wins over the default dir', () => {
  const env = makeHookEnv({ gh: MERGED })
  mkdirSync(join(env.home, '.claude'), { recursive: true })
  writeFileSync(
    join(env.home, '.claude', 'strapped.json'),
    JSON.stringify({ stateRoot: env.stateRoot })
  )
  env.addDeliverable('my-run', 'D1-thing.md', {
    id: 'D1',
    title: 'Thing',
    deps: '[]',
    status: 'pr-open',
    pr: 'https://github.com/o/r/pull/1',
  })
  const decoy = writeDeliverable(join(env.home, '.claude', 'strapped'), 'decoy-run', 'D1-thing.md')
  const res = env.run({ env: { STRAPPED_STATE_ROOT: undefined } })
  assert.equal(res.status, 0)
  assert.match(res.stdout, /my-run\/D1 PR merged → status merged/)
  assert.ok(env.readDeliverable('my-run', 'D1-thing.md').includes('status: merged'))
  assert.ok(readFileSync(decoy, 'utf8').includes('status: pr-open'), 'default-dir decoy must not be scanned')
})

test('precedence: $STRAPPED_STATE_ROOT beats the anchor file', () => {
  const env = makeHookEnv({ gh: MERGED })
  const anchorRoot = join(env.home, 'anchor-root')
  const decoy = writeDeliverable(anchorRoot, 'anchor-run', 'D1-thing.md')
  mkdirSync(join(env.home, '.claude'), { recursive: true })
  writeFileSync(join(env.home, '.claude', 'strapped.json'), JSON.stringify({ stateRoot: anchorRoot }))
  env.addDeliverable('my-run', 'D1-thing.md', {
    id: 'D1',
    title: 'Thing',
    deps: '[]',
    status: 'pr-open',
    pr: 'https://github.com/o/r/pull/1',
  })
  const res = env.run() // STRAPPED_STATE_ROOT=env.stateRoot from the helper
  assert.equal(res.status, 0)
  assert.match(res.stdout, /my-run\/D1 PR merged → status merged/)
  assert.ok(env.readDeliverable('my-run', 'D1-thing.md').includes('status: merged'))
  assert.ok(readFileSync(decoy, 'utf8').includes('status: pr-open'), 'anchor-pointed decoy must not be scanned')
})

test('~ expansion: anchor stateRoot of ~/nested/state resolves under $HOME', () => {
  const env = makeHookEnv({ gh: MERGED })
  mkdirSync(join(env.home, '.claude'), { recursive: true })
  writeFileSync(join(env.home, '.claude', 'strapped.json'), JSON.stringify({ stateRoot: '~/nested/state' }))
  const file = writeDeliverable(join(env.home, 'nested', 'state'), 'my-run', 'D1-thing.md')
  const res = env.run({ env: { STRAPPED_STATE_ROOT: undefined } })
  assert.equal(res.status, 0)
  assert.match(res.stdout, /my-run\/D1 PR merged → status merged/)
  assert.ok(readFileSync(file, 'utf8').includes('status: merged'))
})

test('legacy repo-local .claude/strapped-config.json is ignored: silent exit 0, fixture untouched', () => {
  const env = makeHookEnv({ gh: MERGED })
  // A temp git repo as cwd carrying the dead repo-local config, pointing at a
  // would-flip fixture. No env, no anchor, nothing under $HOME/.claude/strapped.
  const repo = join(env.home, 'worked-repo')
  const legacyRoot = join(env.home, 'legacy-root')
  const legacy = writeDeliverable(legacyRoot, 'legacy-run', 'D1-thing.md')
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'strapped-config.json'), JSON.stringify({ stateRoot: legacyRoot }))
  const init = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' })
  assert.equal(init.status, 0)
  const res = env.run({ cwd: repo, env: { STRAPPED_STATE_ROOT: undefined, CLAUDE_PROJECT_DIR: repo } })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '')
  assert.equal(res.stderr, '')
  assert.ok(readFileSync(legacy, 'utf8').includes('status: pr-open'), 'legacy-pointed fixture must be untouched')
})

test('relative $STRAPPED_STATE_ROOT → silent exit 0, nothing scanned', () => {
  const env = makeHookEnv({ gh: MERGED })
  const relative = writeDeliverable(join(env.home, 'plans', 'strapped'), 'my-run', 'D1-thing.md')
  const res = env.run({ cwd: env.home, env: { STRAPPED_STATE_ROOT: 'plans/strapped' } })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '')
  assert.equal(res.stderr, '')
  assert.ok(readFileSync(relative, 'utf8').includes('status: pr-open'))
})

test('no gh on PATH → silent exit 0 even with pr-open state present', () => {
  const env = makeHookEnv() // coreutils + bash on PATH, but no gh
  env.addDeliverable('my-run', 'D1-thing.md', {
    id: 'D1',
    title: 'Thing',
    deps: '[]',
    status: 'pr-open',
    pr: 'https://github.com/o/r/pull/1',
  })
  const res = env.run()
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '')
  assert.equal(res.stderr, '')
  assert.ok(env.readDeliverable('my-run', 'D1-thing.md').includes('status: pr-open'))
})
