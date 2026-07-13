// Spawns the REAL plugins/strapped/scripts/resolve-chain.mjs with an isolated
// HOME (state-env/hook-env pattern) so the user's real ~/.claude/strapped.json
// can never leak in. Chains resolve from built-ins overlaid by the anchor's
// `chains` map — the anchor is the only config source.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../plugins/strapped/scripts/resolve-chain.mjs', import.meta.url))

function makeHome(anchor) {
  const home = mkdtempSync(join(tmpdir(), 'strapped-chain-'))
  if (anchor !== undefined) {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'strapped.json'),
      typeof anchor === 'string' ? anchor : JSON.stringify(anchor)
    )
  }
  return home
}

function run(args, home) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { HOME: home, PATH: process.env.PATH },
  })
}

test('builtins resolve with no config; --list marks source builtin', () => {
  const home = makeHome()

  const auto = run(['auto'], home)
  assert.equal(auto.status, 0, auto.stderr)
  assert.deepEqual(JSON.parse(auto.stdout), {
    name: 'auto',
    stages: ['plan', 'implement', 'pr'],
    source: 'builtin',
  })

  const ship = run(['ship'], home)
  assert.equal(ship.status, 0, ship.stderr)
  assert.deepEqual(JSON.parse(ship.stdout), {
    name: 'ship',
    stages: ['implement', 'pr'],
    source: 'builtin',
  })

  const list = run(['--list'], home)
  assert.equal(list.status, 0, list.stderr)
  const { chains } = JSON.parse(list.stdout)
  assert.deepEqual(
    chains.map(c => c.name).sort(),
    ['auto', 'ship']
  )
  assert.ok(chains.every(c => c.source === 'builtin'))
})

test('anchor chains: automode from ~/.claude/strapped.json resolves with source anchor', () => {
  const home = makeHome({ stateRoot: '/abs/state', chains: { automode: ['plan', 'implement', 'pr'] } })

  const res = run(['automode'], home)
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout), {
    name: 'automode',
    stages: ['plan', 'implement', 'pr'],
    source: 'anchor',
  })

  const list = run(['--list'], home)
  assert.equal(list.status, 0, list.stderr)
  const { chains } = JSON.parse(list.stdout)
  const automode = chains.find(c => c.name === 'automode')
  assert.equal(automode.source, 'anchor')
  // Built-ins still resolve alongside the anchor chain.
  assert.equal(chains.find(c => c.name === 'auto').source, 'builtin')
  assert.equal(chains.find(c => c.name === 'ship').source, 'builtin')
})

test('anchor auto overrides builtin auto (same-name override)', () => {
  const home = makeHome({ chains: { auto: ['implement', 'pr'] } })

  const res = run(['auto'], home)
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout), {
    name: 'auto',
    stages: ['implement', 'pr'],
    source: 'anchor',
  })

  const list = run(['--list'], home)
  const { chains } = JSON.parse(list.stdout)
  assert.equal(chains.filter(c => c.name === 'auto').length, 1, 'override must not duplicate the name')
})

test('invalid: unknown stage / wrong order / duplicate / empty → exit 1 with named rule', () => {
  const cases = [
    {
      anchor: { chains: { bad: ['plan', 'feedback'] } },
      wants: ['bad', 'unknown stage "feedback"', 'plan, implement, pr'],
    },
    {
      anchor: { chains: { bad: ['implement', 'plan'] } },
      wants: ['bad', 'out of canonical order', '"plan"'],
    },
    {
      anchor: { chains: { bad: ['plan', 'plan', 'pr'] } },
      wants: ['bad', 'duplicate stage "plan"'],
    },
    {
      anchor: { chains: { bad: [] } },
      wants: ['bad', 'empty'],
    },
  ]
  for (const { anchor, wants } of cases) {
    const res = run(['bad'], makeHome(anchor))
    assert.equal(res.status, 1, `expected exit 1 for ${JSON.stringify(anchor)}`)
    for (const want of wants) {
      assert.ok(res.stderr.includes(want), `stderr for ${JSON.stringify(anchor)} lacks "${want}": ${res.stderr}`)
    }
  }
})

test('an invalid config chain fails --list too (fail loud, never half-resolve)', () => {
  const res = run(['--list'], makeHome({ chains: { broken: ['status'] } }))
  assert.equal(res.status, 1)
  assert.ok(res.stderr.includes('broken'))
  assert.ok(res.stderr.includes('interactive by design'), `stderr: ${res.stderr}`)
})

test('unknown chain → exit 1 listing available chains', () => {
  const home = makeHome({ chains: { automode: ['plan', 'implement', 'pr'] } })
  const res = run(['nope'], home)
  assert.equal(res.status, 1)
  assert.ok(res.stderr.includes('unknown chain "nope"'), res.stderr)
  for (const name of ['auto', 'ship', 'automode']) {
    assert.ok(res.stderr.includes(name), `available-chain listing lacks ${name}: ${res.stderr}`)
  }
})

test('invalid anchor JSON → exit 1; missing/absent chains key → builtins only', () => {
  const bad = run(['auto'], makeHome('{nope'))
  assert.equal(bad.status, 1)
  assert.ok(bad.stderr.includes('invalid JSON'), bad.stderr)

  const noChains = run(['--list'], makeHome({ stateRoot: '/abs/state' }))
  assert.equal(noChains.status, 0, noChains.stderr)
  assert.deepEqual(
    JSON.parse(noChains.stdout).chains.map(c => c.name).sort(),
    ['auto', 'ship']
  )
})
