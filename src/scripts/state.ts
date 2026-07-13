// Deterministic state CLI for the strapped skill suite. Single source of truth
// for config/run-root resolution, DAG/ready-set computation, and guarded
// frontmatter transitions — skills and workflow-dispatched agents invoke it
// via Bash and consume its JSON instead of hand-rolling these mechanics.
//
// Commands (all print one JSON object on stdout; misuse = one-line stderr + exit 1):
//   resolve <slug>                          config + run-root resolution
//   dag <runDir> [--only <Did>]             nodes, ready set, topo order, blocked, remaining
//   set <file> <field> <value>              single-field frontmatter write
//   transition <file> <to> [--from <s>]     guarded deliverable status flip
//   manifest-status <runDir> <to>           guarded forward-only manifest status flip
//
// Zero dependencies. Contracts documented in plugins/strapped/conventions.md
// ("Harness scripts").

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { getProp, resolveStateRoot } from '../lib/anchor.ts'
import { die as cliDie, out } from '../lib/cli.ts'
import {
  parseFrontmatter,
  readField,
  writeField,
  type FrontmatterValue,
  type ListItem,
} from '../lib/frontmatter.ts'

// Deployed artifact keeps the historical name in every message. The explicit
// `never`-returning annotation on the const is what lets tsc treat die() calls
// as control-flow endpoints (an arrow-only annotation is not enough).
const die: (msg: string) => never = msg => cliDie('state.mjs', msg)

/** `entry[key]` when entry is an inline map; undefined for scalar entries. */
function mapField(entry: ListItem, key: string): FrontmatterValue | undefined {
  if (typeof entry === 'object' && entry !== null) return entry[key]
  return undefined
}

// --- resolve ---------------------------------------------------------------

function cmdResolve(slug: string): void {
  const stateRoot = resolveStateRoot(die)
  const runRoot = join(stateRoot, 'runs')
  const runDir = join(runRoot, slug)
  const manifest = join(runDir, 'manifest.md')
  const base = { slug, stateRoot, runRoot, runDir, manifest }
  if (!existsSync(manifest)) {
    out({ ...base, exists: false, status: null, seed: null, budgets: null, repos: [] })
    return
  }
  const fm = parseFrontmatter(readFileSync(manifest, 'utf8'), manifest, die)
  const repos = (Array.isArray(fm.repos) ? fm.repos : []).map((entry: ListItem) => {
    const config = join(stateRoot, 'repos', String(mapField(entry, 'name')), 'config.json')
    const configExists = existsSync(config)
    let cfg: unknown = null
    if (configExists) {
      try {
        cfg = JSON.parse(readFileSync(config, 'utf8'))
      } catch {
        die(`invalid JSON in repo config ${config}`)
      }
    }
    return {
      name: mapField(entry, 'name') ?? null,
      root: mapField(entry, 'root') ?? null,
      config,
      configExists,
      validations: getProp(cfg, 'validations') ?? null,
      worktreeRoot: getProp(cfg, 'worktreeRoot') ?? null,
      provisioning: getProp(cfg, 'provisioning') ?? null,
    }
  })
  out({
    ...base,
    exists: true,
    status: fm.status ?? null,
    seed: fm.seed ?? null,
    budgets: fm.budgets ?? null,
    repos,
  })
}

// --- dag -------------------------------------------------------------------

const COMPLETE_STATUSES: ReadonlySet<FrontmatterValue> = new Set(['done', 'pr-open', 'merged'])

/** Node ids come from frontmatter or the manifest entry (deps are ListItems);
 * a malformed entry may yield undefined. */
type NodeId = FrontmatterValue | ListItem | undefined

interface DagNode {
  id: NodeId
  file: string
  title: FrontmatterValue
  status: FrontmatterValue
  deps: ListItem[]
  repo: FrontmatterValue
  branch: FrontmatterValue
  base: FrontmatterValue
  worktree: FrontmatterValue
  pr: FrontmatterValue
  review_rounds_used: FrontmatterValue
  feedback_rounds_used: FrontmatterValue
  parked_reason: FrontmatterValue
  estimated_diff_lines: FrontmatterValue
}

function cmdDag(runDir: string, only: string | null): void {
  const manifestFile = join(runDir, 'manifest.md')
  if (!existsSync(manifestFile)) die(`no manifest at ${manifestFile}`)
  const mfm = parseFrontmatter(readFileSync(manifestFile, 'utf8'), manifestFile, die)
  const list: ListItem[] = Array.isArray(mfm.deliverables) ? mfm.deliverables : []
  if (list.length === 0) die(`manifest has no deliverables list: ${manifestFile}`)

  const nodes: DagNode[] = list.map(entry => {
    const fileField = String(mapField(entry, 'file'))
    const file = isAbsolute(fileField) ? fileField : join(runDir, fileField)
    if (!existsSync(file)) die(`deliverable file missing: ${file} (listed in manifest as ${mapField(entry, 'id')})`)
    const fm = parseFrontmatter(readFileSync(file, 'utf8'), file, die)
    return {
      id: fm.id ?? mapField(entry, 'id'),
      file,
      title: fm.title ?? null,
      status: fm.status ?? null,
      deps: Array.isArray(fm.deps) ? fm.deps : [],
      repo: fm.repo ?? null,
      branch: fm.branch ?? null,
      base: fm.base ?? null,
      worktree: fm.worktree ?? null,
      pr: fm.pr ?? null,
      review_rounds_used: fm.review_rounds_used ?? 0,
      feedback_rounds_used: fm.feedback_rounds_used ?? 0,
      parked_reason: fm.parked_reason ?? null,
      estimated_diff_lines: fm.estimated_diff_lines ?? null,
    }
  })

  const byId = new Map<NodeId, DagNode>(nodes.map(n => [n.id, n]))
  if (byId.size !== nodes.length) die(`duplicate deliverable ids in ${manifestFile}`)
  for (const n of nodes) {
    for (const dep of n.deps) {
      if (!byId.has(dep)) die(`unknown dep ${dep} (referenced by ${n.id})`)
    }
  }
  if (only && !byId.has(only)) die(`--only ${only}: no such deliverable`)

  // Kahn's algorithm; deterministic tiebreak by id.
  const indegree = new Map<NodeId, number>(nodes.map(n => [n.id, n.deps.length]))
  const children = new Map<NodeId, NodeId[]>(nodes.map(n => [n.id, []]))
  for (const n of nodes) for (const dep of n.deps) (children.get(dep) ?? []).push(n.id)
  const queue = nodes.filter(n => n.deps.length === 0).map(n => n.id)
  const topo: NodeId[] = []
  while (queue.length > 0) {
    queue.sort()
    // shift() returns NodeId | undefined, and undefined is already a NodeId.
    const id: NodeId = queue.shift()
    topo.push(id)
    for (const child of children.get(id) ?? []) {
      indegree.set(child, (indegree.get(child) ?? 0) - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  if (topo.length !== nodes.length) {
    const stuck = nodes.map(n => n.id).filter(id => !topo.includes(id)).sort()
    die(`dependency cycle involving: ${stuck.join(', ')}`)
  }

  const complete = (id: NodeId): boolean => COMPLETE_STATUSES.has(byId.get(id)?.status ?? null)
  const depsMet = (n: DagNode): boolean => n.deps.every(complete)
  let ready = nodes.filter(n => n.status === 'pending' && depsMet(n)).map(n => n.id)
  if (only) {
    const node = byId.get(only)
    const resumable = node !== undefined && (node.status === 'parked' || node.status === 'in-progress')
    if (node !== undefined && resumable && depsMet(node) && !ready.includes(only)) ready.push(only)
    ready = ready.filter(id => id === only)
  }
  ready.sort()
  const blocked = nodes
    .filter(n => n.status === 'pending' && !depsMet(n))
    .map(n => ({ id: n.id, blockedOn: n.deps.filter(dep => !complete(dep)) }))
  const remaining = nodes.filter(n => !COMPLETE_STATUSES.has(n.status)).length

  out({
    manifest: { status: mfm.status ?? null, seed: mfm.seed ?? null, budgets: mfm.budgets ?? null },
    nodes,
    ready,
    topo,
    blocked,
    remaining,
  })
}

// --- set -------------------------------------------------------------------

function cmdSet(file: string, field: string, value: string): void {
  // A multi-line value would inject extra frontmatter lines (e.g. a forged
  // second `status:` line), silently breaking the single-field-write contract.
  if (/[\r\n]/.test(value)) die('value must be a single line')
  const { lines, idx, value: old } = readField(file, field, die)
  if (idx === -1) die(`unknown frontmatter field "${field}" in ${file}`)
  if (lines[idx] !== `${field}: ${value}`) writeField(file, lines, idx, field, value)
  out({ file, field, old, new: value })
}

// --- transition ------------------------------------------------------------
// The ON-DISK edge set (see conventions.md "Harness scripts"): `ready`,
// `implemented`, and the mid-wave `in-review` of the conceptual lifecycle are
// virtual — never written to frontmatter — so the guard encodes the skip-edges
// the skills and workflows actually write.

const DELIVERABLE_EDGES: ReadonlySet<string> = new Set([
  'pending>in-progress',
  'parked>in-progress',
  'in-progress>done',
  'in-progress>parked',
  'fixing>parked',
  'in-review>parked',
  'done>parked',
  'pr-open>parked',
  'done>pr-open',
  'pr-open>merged',
  'pr-open>fixing',
  'fixing>in-review',
  'in-review>fixing',
  'in-review>pr-open',
  'in-review>done',
])

function cmdTransition(file: string, to: string, from: string | null): void {
  const { lines, idx, value: current } = readField(file, 'status', die)
  if (idx === -1) die(`no status field in ${file}`)
  if (from !== null && current !== from) {
    die(`expected status "${from}" but found "${current}" in ${file}`)
  }
  if (current === to) {
    out({ file, from: current, to, changed: false })
    return
  }
  if (!DELIVERABLE_EDGES.has(`${current}>${to}`)) {
    die(`illegal transition ${current} → ${to} for ${file}`)
  }
  writeField(file, lines, idx, 'status', to)
  out({ file, from: current, to, changed: true })
}

// --- manifest-status -------------------------------------------------------

const MANIFEST_LADDER: readonly string[] = ['draft', 'in-review', 'approved', 'implementing', 'complete']

function cmdManifestStatus(runDir: string, to: string): void {
  const file = join(runDir, 'manifest.md')
  if (!existsSync(file)) die(`no manifest at ${file}`)
  const { lines, idx, value: current } = readField(file, 'status', die)
  if (idx === -1) die(`no status field in ${file}`)
  const toIdx = MANIFEST_LADDER.indexOf(to)
  if (toIdx === -1) die(`unknown manifest status "${to}"`)
  const currentIdx = current === null ? -1 : MANIFEST_LADDER.indexOf(current)
  if (currentIdx === -1) die(`manifest has unknown status "${current}" in ${file}`)
  if (current === to) {
    out({ file, from: current, to, changed: false })
    return
  }
  if (toIdx < currentIdx) die(`manifest status is forward-only: ${current} → ${to} rejected`)
  writeField(file, lines, idx, 'status', to)
  out({ file, from: current, to, changed: true })
}

// --- dispatch ---------------------------------------------------------------

const USAGE = 'usage: state.mjs <resolve|dag|set|transition|manifest-status> ...'
const [cmd, ...rest] = process.argv.slice(2)

function takeFlag(args: string[], flag: string): string | null {
  const i = args.indexOf(flag)
  if (i === -1) return null
  const value = args[i + 1]
  if (!value) die(`${flag} requires a value`)
  args.splice(i, 2)
  return value
}

switch (cmd) {
  case 'resolve': {
    const slug = rest[0]
    if (!slug) die('usage: state.mjs resolve <slug>')
    cmdResolve(slug)
    break
  }
  case 'dag': {
    const only = takeFlag(rest, '--only')
    const runDirArg = rest[0]
    if (!runDirArg) die('usage: state.mjs dag <runDir> [--only <Did>]')
    cmdDag(resolve(runDirArg), only)
    break
  }
  case 'set': {
    const fileArg = rest[0]
    const fieldArg = rest[1]
    if (rest.length < 3 || fileArg === undefined || fieldArg === undefined) {
      die('usage: state.mjs set <file> <field> <value>')
    }
    cmdSet(resolve(fileArg), fieldArg, rest.slice(2).join(' '))
    break
  }
  case 'transition': {
    const from = takeFlag(rest, '--from')
    const fileArg = rest[0]
    const toArg = rest[1]
    if (!fileArg || !toArg) die('usage: state.mjs transition <file> <to> [--from <expected>]')
    cmdTransition(resolve(fileArg), toArg, from)
    break
  }
  case 'manifest-status': {
    const runDirArg = rest[0]
    const toArg = rest[1]
    if (!runDirArg || !toArg) die('usage: state.mjs manifest-status <runDir> <to>')
    cmdManifestStatus(resolve(runDirArg), toArg)
    break
  }
  default:
    die(USAGE)
}
