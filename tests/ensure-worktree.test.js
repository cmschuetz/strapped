// Integration tests for plugins/strapped/scripts/ensure-worktree.sh against
// real temp git repos: create → reuse → branch-exists re-attach → mismatch.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { makeGitRepo, runEnsureWorktree } from './helpers/state-env.js'

const BRANCH = 'strapped/my-run/D1-thing'

test('create → reuse → branch-exists re-attach → mismatch error', () => {
  const repo = makeGitRepo()
  const worktrees = mkdtempSync(join(tmpdir(), 'strapped-wt-'))
  const wt = join(worktrees, 'my-run', 'D1')

  // create: new branch from base, stdout is pure JSON
  const create = runEnsureWorktree(repo.dir, wt, BRANCH, 'main')
  assert.equal(create.status, 0, create.stderr)
  assert.deepEqual(JSON.parse(create.stdout), { worktree: wt, branch: BRANCH, created: true })
  assert.ok(existsSync(join(wt, 'README.md')))
  assert.equal(repo.git('branch', '--list', BRANCH).stdout.includes(BRANCH), true)
  const head = runEnsureWorktree(repo.dir, wt, BRANCH, 'main') // reuse doubles as HEAD check below

  // reuse: same path, same branch → created false
  assert.equal(head.status, 0, head.stderr)
  assert.deepEqual(JSON.parse(head.stdout), { worktree: wt, branch: BRANCH, created: false })

  // re-attach: worktree removed but branch survives → add WITHOUT -b
  repo.git('worktree', 'remove', wt)
  assert.ok(!existsSync(wt))
  const reattach = runEnsureWorktree(repo.dir, wt, BRANCH, 'main')
  assert.equal(reattach.status, 0, reattach.stderr)
  assert.deepEqual(JSON.parse(reattach.stdout), { worktree: wt, branch: BRANCH, created: true })
  const wtHead = repo.git('worktree', 'list', '--porcelain').stdout
  assert.ok(wtHead.includes(`branch refs/heads/${BRANCH}`))

  // mismatch: path exists but is checked out on a different branch → exit 1
  const mismatch = runEnsureWorktree(repo.dir, wt, 'strapped/my-run/D2-other', 'main')
  assert.equal(mismatch.status, 1)
  assert.equal(mismatch.stdout, '')
  assert.match(mismatch.stderr, /checked out on 'strapped\/my-run\/D1-thing', expected 'strapped\/my-run\/D2-other'/)
})

test('git failure (bad base) → non-zero exit, git stderr passed through, no JSON on stdout', () => {
  const repo = makeGitRepo()
  const wt = join(mkdtempSync(join(tmpdir(), 'strapped-wt-')), 'D1')
  const res = runEnsureWorktree(repo.dir, wt, BRANCH, 'no-such-base')
  assert.notEqual(res.status, 0)
  assert.equal(res.stdout, '')
  assert.ok(res.stderr.length > 0, 'expected git stderr passed through')
})

test('usage error: wrong arg count → exit 1 with usage on stderr', () => {
  const res = runEnsureWorktree('/tmp', '/tmp/x', 'branch-only')
  assert.equal(res.status, 1)
  assert.match(res.stderr, /usage: ensure-worktree.sh/)
})
