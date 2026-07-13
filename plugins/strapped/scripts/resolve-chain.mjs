#!/usr/bin/env node
// Chain-name → validated stage list for /strapped:run. Chain resolution is
// global and cwd-independent: built-ins overlaid by the `chains` map of the
// anchor file ~/.claude/strapped.json — the anchor is the ONLY config source
// ($STRAPPED_STATE_ROOT carries no chains; repo-local configs do not exist).
//
// Usage (one JSON object on stdout; misuse = one-line stderr + exit 1):
//   resolve-chain.mjs <name>    → { name, stages, source: "builtin" | "anchor" }
//   resolve-chain.mjs --list    → { chains: [{ name, stages, source }] }
//
// Zero dependencies. Contract documented in plugins/strapped/conventions.md
// ("Harness scripts" and "Chain configs").

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function die(msg) {
  process.stderr.write(`resolve-chain.mjs: ${msg}\n`)
  process.exit(1)
}

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n')

const VALID_STAGES = ['plan', 'implement', 'pr']
// Interactive by design — never chainable (documented in conventions.md).
const EXCLUDED_STAGES = new Set(['feedback', 'feedback-synth', 'learn', 'status'])
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/

const BUILTINS = {
  auto: ['plan', 'implement', 'pr'],
  ship: ['implement', 'pr'],
}

function validateChain({ name, stages, source }) {
  if (!NAME_SHAPE.test(name)) {
    die(`chain "${name}" (${source}): invalid name — chain names must match ${NAME_SHAPE} (they become skill directory names)`)
  }
  if (!Array.isArray(stages)) {
    die(`chain "${name}" (${source}): stages must be an array of stage names — valid stages: ${VALID_STAGES.join(', ')}`)
  }
  if (stages.length === 0) {
    die(`chain "${name}" (${source}): empty — a chain must list at least one of: ${VALID_STAGES.join(', ')}`)
  }
  const seen = new Set()
  let prev = -1
  for (const stage of stages) {
    const idx = VALID_STAGES.indexOf(stage)
    if (idx === -1) {
      const why = EXCLUDED_STAGES.has(String(stage)) ? ' (interactive by design — excluded from chains)' : ''
      die(`chain "${name}" (${source}): unknown stage "${stage}"${why} — valid stages: ${VALID_STAGES.join(', ')}`)
    }
    if (seen.has(stage)) {
      die(`chain "${name}" (${source}): duplicate stage "${stage}" — each stage may appear at most once`)
    }
    if (idx < prev) {
      die(`chain "${name}" (${source}): stage "${stage}" out of canonical order — chains must follow ${VALID_STAGES.join(' → ')}`)
    }
    seen.add(stage)
    prev = idx
  }
}

function loadChains() {
  const chains = new Map()
  for (const [name, stages] of Object.entries(BUILTINS)) {
    chains.set(name, { name, stages, source: 'builtin' })
  }
  const home = process.env.HOME || homedir()
  const anchor = join(home, '.claude', 'strapped.json')
  if (existsSync(anchor)) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(anchor, 'utf8'))
    } catch {
      die(`invalid JSON in anchor file ${anchor}`)
    }
    const configured = parsed?.chains
    if (configured !== undefined && configured !== null) {
      if (typeof configured !== 'object' || Array.isArray(configured)) {
        die(`"chains" in ${anchor} must be an object mapping chain names to stage lists`)
      }
      // A same-name anchor chain overrides its built-in.
      for (const [name, stages] of Object.entries(configured)) {
        chains.set(name, { name, stages, source: 'anchor' })
      }
    }
  }
  for (const chain of chains.values()) validateChain(chain)
  return chains
}

const USAGE = 'usage: resolve-chain.mjs <chain-name> | --list'
const args = process.argv.slice(2)
if (args.length !== 1) die(USAGE)
const [arg] = args

const chains = loadChains()
if (arg === '--list') {
  out({ chains: [...chains.values()] })
} else if (arg.startsWith('--')) {
  die(USAGE)
} else {
  const chain = chains.get(arg)
  if (!chain) {
    const available = [...chains.values()].map(c => `${c.name} (${c.stages.join(', ')})`).join('; ')
    die(`unknown chain "${arg}" — available chains: ${available}`)
  }
  out(chain)
}
