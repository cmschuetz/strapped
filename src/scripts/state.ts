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
//   snapshot <runDir> [-m <message>]        commit the whole stateRoot (git) at a boundary
//   sync-rows [--all | <slug>] [--lines]    pr-open deliverables joined with their repoRoot
//   stale-worktrees [--all | <slug>] [--lines]  merged deliverables with a lingering worktree
//
// Zero dependencies. Contracts documented in plugins/strapped/conventions.md
// ("Harness scripts").

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { getProp, resolveStateRoot } from '../lib/anchor.ts'
import { die as cliDie, out } from '../lib/cli.ts'
import {
  coerceValue,
  parseFrontmatter,
  readFrontmatterFile,
  valueToString,
  writeFrontmatterFile,
  type Frontmatter,
  type FrontmatterValue,
  type ListItem,
} from '../lib/frontmatter.ts'

// Deployed artifact keeps the historical name in every message. The explicit
// `never`-returning annotation on the const is what lets tsc treat die() calls
// as control-flow endpoints (an arrow-only annotation is not enough).
const die: (msg: string) => never = msg => cliDie('state.mjs', msg)

/** `entry[key]` when entry is an inline map; undefined for scalar entries. */
function mapField(entry: ListItem, key: string): FrontmatterValue | undefined {
  return getProp(entry, key)
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
  const { data, content } = readFrontmatterFile(file, die)
  if (!(field in data)) die(`unknown frontmatter field "${field}" in ${file}`)
  const old = valueToString(data[field])
  const next = coerceValue(value)
  // Idempotent: only re-serialize when the parsed value actually changes.
  if (JSON.stringify(data[field]) !== JSON.stringify(next)) {
    data[field] = next
    writeFrontmatterFile(file, data, content)
  }
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
  const { data, content } = readFrontmatterFile(file, die)
  if (!('status' in data)) die(`no status field in ${file}`)
  const current = valueToString(data.status)
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
  data.status = to
  writeFrontmatterFile(file, data, content)
  out({ file, from: current, to, changed: true })
}

// --- manifest-status -------------------------------------------------------

const MANIFEST_LADDER: readonly string[] = ['draft', 'in-review', 'approved', 'implementing', 'complete']

function cmdManifestStatus(runDir: string, to: string): void {
  const file = join(runDir, 'manifest.md')
  if (!existsSync(file)) die(`no manifest at ${file}`)
  const { data, content } = readFrontmatterFile(file, die)
  if (!('status' in data)) die(`no status field in ${file}`)
  const current = valueToString(data.status)
  const toIdx = MANIFEST_LADDER.indexOf(to)
  if (toIdx === -1) die(`unknown manifest status "${to}"`)
  const currentIdx = MANIFEST_LADDER.indexOf(current)
  if (currentIdx === -1) die(`manifest has unknown status "${current}" in ${file}`)
  if (current === to) {
    out({ file, from: current, to, changed: false })
    return
  }
  if (toIdx < currentIdx) die(`manifest status is forward-only: ${current} → ${to} rejected`)
  data.status = to
  writeFrontmatterFile(file, data, content)
  out({ file, from: current, to, changed: true })
}

// --- snapshot --------------------------------------------------------------
// The ONLY side-effectful command: commit the WHOLE stateRoot as one git commit
// at a logical boundary (plan converged/approved, each implement wave, PR
// create). Auto-`git init` on first use; a clean tree is a no-op (exit 0,
// committed:false). Uses a strapped fallback identity only when git resolves
// none, so real users keep their own. node:child_process only — no new deps.

interface GitResult {
  status: number | null
  stdout: string
  stderr: string
}

function git(stateRoot: string, args: string[], { allowFail = false }: { allowFail?: boolean } = {}): GitResult {
  const res = spawnSync('git', ['-C', stateRoot, ...args], { encoding: 'utf8' })
  if (res.error) die(`git ${args.join(' ')} failed to spawn: ${res.error.message}`)
  if (!allowFail && res.status !== 0) {
    die(`git ${args.join(' ')} failed: ${(res.stderr || '').trim()}`)
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function cmdSnapshot(runDir: string, message: string | null): void {
  const stateRoot = resolveStateRoot(die)
  const msg = message || `strapped snapshot ${basename(runDir)}`
  if (!existsSync(join(stateRoot, '.git'))) git(stateRoot, ['init', '-b', 'main', '--quiet'])
  git(stateRoot, ['add', '-A'])
  // `git diff --cached --quiet` exits 0 when nothing is staged → clean-tree no-op.
  if (git(stateRoot, ['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) {
    out({ stateRoot, committed: false, sha: null, message: msg })
    return
  }
  // Fallback identity ONLY when none is configured (never override a real one).
  const email = git(stateRoot, ['config', 'user.email'], { allowFail: true })
  const idArgs =
    email.status === 0 && email.stdout.trim() !== ''
      ? []
      : ['-c', 'user.name=strapped', '-c', 'user.email=strapped@localhost']
  git(stateRoot, [...idArgs, 'commit', '--quiet', '-m', msg])
  const sha = git(stateRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim()
  out({ stateRoot, committed: true, sha, message: msg })
}

// --- sync-rows / stale-worktrees --------------------------------------------
// Two pure reads (no git/gh, no writes) sharing one run-scan + row-builder,
// differing only by a status predicate. Both enumerate deliverable FILES
// (`<runDir>/deliverables/*.md`) — NOT the manifest — so a deliverable is
// gathered even when its run has no manifest, matching the SessionStart hook's
// file-scan gather. Each emitted row is joined with its run's manifest `repos:`
// map to carry the `repoRoot` the hook's worktree cleanup needs; an absent
// manifest / unknown repo / missing `repo:` field yields `repoRoot: null`
// (tolerate — the flip still happens, only cleanup is skipped). Fixed 8-column
// row: slug id status repoRoot worktree branch pr file.

/** Parse a frontmatter file, returning null (never dying) on a missing block or malformed YAML. */
function tryParseFrontmatter(file: string): Frontmatter | null {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  if (lines[0] !== '---' || lines.indexOf('---', 1) === -1) return null
  try {
    return parseFrontmatter(src, file, (m: string) => {
      throw new Error(m)
    })
  } catch {
    return null
  }
}

function listRunDirs(stateRoot: string, slug: string | null): string[] {
  const runsRoot = join(stateRoot, 'runs')
  if (!existsSync(runsRoot)) return []
  if (slug !== null) {
    const dir = join(runsRoot, slug)
    return existsSync(dir) ? [dir] : []
  }
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(runsRoot, d.name))
    .sort()
}

function reposRootMap(runDir: string): Record<string, FrontmatterValue> {
  const manifest = join(runDir, 'manifest.md')
  if (!existsSync(manifest)) return {}
  const fm = tryParseFrontmatter(manifest)
  const map: Record<string, FrontmatterValue> = {}
  const repos = fm && Array.isArray(fm.repos) ? fm.repos : []
  for (const entry of repos) {
    const name = getProp(entry, 'name')
    if (entry != null && name != null) map[String(name)] = getProp(entry, 'root') ?? null
  }
  return map
}

interface SyncRow {
  slug: string
  id: FrontmatterValue
  status: FrontmatterValue
  repoRoot: FrontmatterValue
  worktree: FrontmatterValue
  branch: FrontmatterValue
  pr: FrontmatterValue
  file: string
}

function gatherRows(slug: string | null, predicate: (fm: Frontmatter) => boolean): SyncRow[] {
  const stateRoot = resolveStateRoot(die)
  const rows: SyncRow[] = []
  for (const runDir of listRunDirs(stateRoot, slug)) {
    const delivDir = join(runDir, 'deliverables')
    if (!existsSync(delivDir)) continue
    const runSlug = basename(runDir)
    let repos: Record<string, FrontmatterValue> | null = null // lazily read the manifest only for a run that has a match
    const files = readdirSync(delivDir)
      .filter(f => f.endsWith('.md'))
      .sort()
    for (const name of files) {
      const file = join(delivDir, name)
      let fm: Frontmatter | null
      try {
        fm = tryParseFrontmatter(file)
      } catch {
        continue
      }
      if (!fm || !predicate(fm)) continue
      if (repos === null) repos = reposRootMap(runDir)
      const repo = fm.repo ?? null
      const repoRoot = typeof repo === 'string' && repo in repos ? repos[repo] : null
      rows.push({
        slug: runSlug,
        id: fm.id ?? null,
        status: fm.status ?? null,
        repoRoot,
        worktree: fm.worktree ?? null,
        branch: fm.branch ?? null,
        pr: fm.pr ?? null,
        file,
      })
    }
  }
  return rows
}

const COLUMNS: readonly (keyof SyncRow)[] = ['slug', 'id', 'status', 'repoRoot', 'worktree', 'branch', 'pr', 'file']

function emitRows(rows: SyncRow[], lines: boolean): void {
  if (!lines) {
    out({ deliverables: rows })
    return
  }
  let buf = ''
  for (const r of rows) {
    buf += COLUMNS.map(k => (r[k] == null ? 'null' : String(r[k]))).join('\t') + '\n'
  }
  process.stdout.write(buf)
}

/** Shared arg parse for `[--all | <slug>] [--lines]`; default (neither) → --all. */
function parseGatherArgs(args: string[]): { slug: string | null; lines: boolean } {
  const lines = args.includes('--lines')
  const all = args.includes('--all')
  const positional = args.filter(a => a !== '--lines' && a !== '--all')
  const slug = !all && positional[0] ? positional[0] : null
  return { slug, lines }
}

function cmdSyncRows(args: string[]): void {
  const { slug, lines } = parseGatherArgs(args)
  emitRows(
    gatherRows(slug, fm => fm.status === 'pr-open'),
    lines
  )
}

function cmdStaleWorktrees(args: string[]): void {
  const { slug, lines } = parseGatherArgs(args)
  emitRows(
    gatherRows(slug, fm => fm.status === 'merged' && fm.worktree != null),
    lines
  )
}

// --- dispatch ---------------------------------------------------------------

const USAGE =
  'usage: state.mjs <resolve|dag|set|transition|manifest-status|snapshot|sync-rows|stale-worktrees> ...'
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
  case 'snapshot': {
    const message = takeFlag(rest, '-m')
    const runDirArg = rest[0]
    if (!runDirArg) die('usage: state.mjs snapshot <runDir> [-m <message>]')
    cmdSnapshot(resolve(runDirArg), message)
    break
  }
  case 'sync-rows': {
    cmdSyncRows(rest)
    break
  }
  case 'stale-worktrees': {
    cmdStaleWorktrees(rest)
    break
  }
  default:
    die(USAGE)
}
