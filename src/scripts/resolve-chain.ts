// Chain-name → validated stage list for /strapped:run. Chain resolution is
// global and cwd-independent: built-ins overlaid by the `chains` map of the
// anchor file ~/.claude/strapped.json — the anchor is the ONLY config source
// ($STRAPPED_STATE_ROOT carries no chains; repo-local configs do not exist).
//
// Usage (one JSON object on stdout; misuse = one-line stderr + exit 1):
//   resolve-chain.mjs <name>    → { name, stages, source: "builtin" | "anchor" }
//   resolve-chain.mjs --list    → { chains: [{ name, stages, source }] }
//
// Zero runtime dependencies. Contract documented in plugins/strapped/conventions.md
// ("Harness scripts" and "Chain configs").

import { anchorPath, getProp, readAnchor } from '../lib/anchor.ts'
import { die as cliDie, out } from '../lib/cli.ts'

// Deployed artifact keeps the historical name in every message. The explicit
// `never`-returning annotation on the const is what lets tsc treat die() calls
// as control-flow endpoints (an arrow-only annotation is not enough).
const die: (msg: string) => never = msg => cliDie('resolve-chain.mjs', msg)

type Source = 'builtin' | 'anchor'

/** A chain as collected from built-ins or the anchor, before validation. */
interface RawChain {
  name: string
  stages: unknown
  source: Source
}

/** A validated chain — the exact JSON shape emitted on stdout. */
interface Chain {
  name: string
  stages: string[]
  source: Source
}

const VALID_STAGES: readonly string[] = ['plan', 'implement', 'pr']
// Interactive by design — never chainable (documented in conventions.md).
const EXCLUDED_STAGES = new Set(['feedback', 'learn', 'status'])
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/

const BUILTINS: Record<string, string[]> = {
  auto: ['plan', 'implement', 'pr'],
  ship: ['implement', 'pr'],
}

function validateChain({ name, stages, source }: RawChain): Chain {
  if (!NAME_SHAPE.test(name)) {
    die(`chain "${name}" (${source}): invalid name — chain names must match ${NAME_SHAPE} (they become skill directory names)`)
  }
  if (!Array.isArray(stages)) {
    die(`chain "${name}" (${source}): stages must be an array of stage names — valid stages: ${VALID_STAGES.join(', ')}`)
  }
  const list: unknown[] = stages
  if (list.length === 0) {
    die(`chain "${name}" (${source}): empty — a chain must list at least one of: ${VALID_STAGES.join(', ')}`)
  }
  const seen = new Set<string>()
  const validated: string[] = []
  let prev = -1
  for (const raw of list) {
    if (typeof raw !== 'string' || !VALID_STAGES.includes(raw)) {
      const why = typeof raw === 'string' && EXCLUDED_STAGES.has(raw) ? ' (interactive by design — excluded from chains)' : ''
      die(`chain "${name}" (${source}): unknown stage "${String(raw)}"${why} — valid stages: ${VALID_STAGES.join(', ')}`)
    }
    const stage = raw
    const idx = VALID_STAGES.indexOf(stage)
    if (seen.has(stage)) {
      die(`chain "${name}" (${source}): duplicate stage "${stage}" — each stage may appear at most once`)
    }
    if (idx < prev) {
      die(`chain "${name}" (${source}): stage "${stage}" out of canonical order — chains must follow ${VALID_STAGES.join(' → ')}`)
    }
    seen.add(stage)
    prev = idx
    validated.push(stage)
  }
  return { name, stages: validated, source }
}

function loadChains(): Map<string, Chain> {
  const collected = new Map<string, RawChain>()
  for (const [name, stages] of Object.entries(BUILTINS)) {
    collected.set(name, { name, stages, source: 'builtin' })
  }
  let parsed: unknown
  try {
    parsed = readAnchor()
  } catch {
    die(`invalid JSON in anchor file ${anchorPath()}`)
  }
  const configured = getProp(parsed, 'chains')
  if (configured !== undefined && configured !== null) {
    if (typeof configured !== 'object' || Array.isArray(configured)) {
      die(`"chains" in ${anchorPath()} must be an object mapping chain names to stage lists`)
    }
    // A same-name anchor chain overrides its built-in.
    for (const [name, stages] of Object.entries(configured as Record<string, unknown>)) {
      collected.set(name, { name, stages, source: 'anchor' })
    }
  }
  const chains = new Map<string, Chain>()
  for (const chain of collected.values()) chains.set(chain.name, validateChain(chain))
  return chains
}

const USAGE = 'usage: resolve-chain.mjs <chain-name> | --list'
const argv = process.argv.slice(2)
const arg = argv[0]
if (argv.length !== 1 || arg === undefined) die(USAGE)

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
