// Integration tests for plugins/strapped/scripts/sync-prs.sh: spawn the REAL
// script with an isolated HOME, a controlled PATH (stub gh at the front, no
// real gh reachable), and STRAPPED_STATE_ROOT pointing at a temp fixture.
// The script is a SessionStart hook: every path must exit 0.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ghStub, makeHookEnv } from './helpers/hook-env.js'

const MERGED = ghStub('{"state":"MERGED","reviewDecision":null}')
const CHANGES_REQUESTED = ghStub('{"state":"OPEN","reviewDecision":"CHANGES_REQUESTED"}')

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
