// Integration tests for plugins/strapped/scripts/plan-lock.sh — the harness
// plan-gate lock that makes /strapped:feedback-lite's plan gate unbypassable.
// Spawns the REAL script with an isolated HOME (so the lock dir under
// $HOME/.claude/.strapped-plan-locks is a throwaway) and feeds it the JSON a
// UserPromptExpansion / PreToolUse hook would put on stdin.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('../plugins/strapped/scripts/plan-lock.sh', import.meta.url))

const makeHome = (): string => mkdtempSync(join(tmpdir(), 'strapped-planlock-'))
const lockDir = (home: string): string => join(home, '.claude', '.strapped-plan-locks')
const lockFile = (home: string, sid: string): string => join(lockDir(home), sid)

function run(home: string, args: string[], input = ''): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', input, env: { ...process.env, HOME: home } })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

const expansion = (sid: string, commandName: string, commandArgs: string): string =>
  JSON.stringify({
    session_id: sid,
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    command_name: commandName,
    command_args: commandArgs,
  })

const pretool = (sid: string): string =>
  JSON.stringify({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Write' })

test('set: locks the session for a feedback-lite invocation, storing the slug as contents', () => {
  const home = makeHome()
  const r = run(home, ['set'], expansion('sid-1', 'strapped:feedback-lite', 'my-slug --pr https://x/1'))
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(lockFile(home, 'sid-1')), 'lock file created')
  assert.equal(readFileSync(lockFile(home, 'sid-1'), 'utf8'), 'my-slug')
})

test('set: bare skill command_name (no plugin prefix) also matches', () => {
  const home = makeHome()
  run(home, ['set'], expansion('sid-1b', 'feedback-lite', 'my-slug'))
  assert.equal(readFileSync(lockFile(home, 'sid-1b'), 'utf8'), 'my-slug')
})

test('set: ignores a non-feedback-lite command (no lock written)', () => {
  const home = makeHome()
  const r = run(home, ['set'], expansion('sid-2', 'strapped:implement', 'my-slug'))
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(lockDir(home)) || readdirSync(lockDir(home)).length === 0, 'no lock for non-feedback-lite')
})

test('guard: denies edits while the same session holds a lock', () => {
  const home = makeHome()
  run(home, ['set'], expansion('sid-3', 'feedback-lite', 'my-slug'))
  const r = run(home, ['guard'], pretool('sid-3'))
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
})

test('guard: does NOT deny a different session (no cross-session bleed)', () => {
  const home = makeHome()
  run(home, ['set'], expansion('sid-4', 'feedback-lite', 'my-slug'))
  const r = run(home, ['guard'], pretool('a-different-session'))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '', 'no deny emitted for an unlocked session')
})

test('guard: no-op when nothing is locked', () => {
  const home = makeHome()
  const r = run(home, ['guard'], pretool('sid-5'))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '')
})

test('clear <slug>: releases the lock, so a later guard passes', () => {
  const home = makeHome()
  run(home, ['set'], expansion('sid-6', 'feedback-lite', 'my-slug'))
  assert.ok(existsSync(lockFile(home, 'sid-6')))
  const r = run(home, ['clear', 'my-slug'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(lockFile(home, 'sid-6')), 'lock removed')
  assert.equal(run(home, ['guard'], pretool('sid-6')).stdout.trim(), '')
})

test('clear <slug>: leaves a lock for a different slug intact', () => {
  const home = makeHome()
  run(home, ['set'], expansion('sid-a', 'feedback-lite', 'slug-a'))
  run(home, ['set'], expansion('sid-b', 'feedback-lite', 'slug-b'))
  run(home, ['clear', 'slug-a'])
  assert.ok(!existsSync(lockFile(home, 'sid-a')), 'slug-a lock removed')
  assert.ok(existsSync(lockFile(home, 'sid-b')), 'slug-b lock intact')
})

test('unknown subcommand exits non-zero', () => {
  const home = makeHome()
  const r = run(home, ['bogus'])
  assert.notEqual(r.status, 0)
})
