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
//   feedback-index read|upsert|set ...      per-run PR-comment dedup index (JSON)
//   commit [<runDirOrFile>] [--message <m>] git-init-if-absent + commit the state root
//   cleanup <deliverableFile>               remove a merged deliverable's worktree (keep the branch)
//   outstanding [<runDir>]                  every non-merged deliverable across all runs (or one)
//
// Zero dependencies. Contracts documented in plugins/strapped/conventions.md
// ("Harness scripts").

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { getProp, resolveStateRoot } from '../lib/anchor.ts'
import { die as cliDie, out } from '../lib/cli.ts'
import {
  coerceValue,
  parseFrontmatter,
  readFrontmatterFile,
  valueToString,
  writeFrontmatterFile,
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

// --- git-backed state root -------------------------------------------------
// The state root is a git repository committed at semantic boundaries. `commit`
// bootstraps it (git init if absent); `transition`/`manifest-status` auto-commit
// best-effort ONLY when `.git` already exists. `set` never self-commits — its
// field pokes are swept into the next transition's `git add -A`.

/** A git identity self-contained enough to work with no global git config. */
const GIT_IDENTITY: readonly string[] = ['-c', 'user.name=strapped', '-c', 'user.email=strapped@localhost']

/** Run `git -C <cwd> <args>`; never throws — returns the raw spawn result. */
function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

/**
 * Derive the state root from a path under it: the ancestor directory whose
 * immediate child is `runs/` (a deliverable file or a run dir both live below
 * `<stateRoot>/runs/`). Returns null when no `runs` segment is present, so a
 * caller can fall back to `resolveStateRoot()` or skip silently.
 */
function stateRootFromPath(target: string): string | null {
  const parts = resolve(target).split(sep)
  const idx = parts.lastIndexOf('runs')
  if (idx <= 0) return null
  return parts.slice(0, idx).join(sep) || sep
}

/**
 * Best-effort auto-commit of the state root after a semantic transition. Runs
 * ONLY when `<stateRoot>/.git` already exists (no bootstrap on the auto path),
 * swallows every error (spawn failure, git missing, nothing to commit), and
 * NEVER writes stdout, throws, or affects the exit code.
 */
function autoCommitStateRoot(target: string, message: string): void {
  try {
    const stateRoot = stateRootFromPath(target)
    if (stateRoot === null || !existsSync(join(stateRoot, '.git'))) return
    git(stateRoot, 'add', '-A')
    git(stateRoot, ...GIT_IDENTITY, 'commit', '-q', '-m', message)
  } catch {
    // best-effort: a git-backed state root is a convenience, never a contract.
  }
}

// --- commit ----------------------------------------------------------------

function cmdCommit(arg: string | null, message: string): void {
  let stateRoot: string
  if (arg !== null) {
    const derived = stateRootFromPath(arg)
    if (derived === null) die(`cannot derive stateRoot from "${arg}" (no runs/ ancestor)`)
    stateRoot = derived
  } else {
    stateRoot = resolveStateRoot(die)
  }
  let initialized = false
  if (!existsSync(join(stateRoot, '.git'))) {
    const init = git(stateRoot, 'init', '-q', '-b', 'main')
    if (init.error) die(`git is not available: ${init.error.message}`)
    if (init.status !== 0) die(`git init failed in ${stateRoot}: ${init.stderr.trim()}`)
    initialized = true
  }
  const add = git(stateRoot, 'add', '-A')
  if (add.error) die(`git is not available: ${add.error.message}`)
  // `git diff --cached --quiet` exits 0 when nothing is staged, 1 when there is.
  const staged = git(stateRoot, 'diff', '--cached', '--quiet')
  if (staged.status === 0) {
    out({ stateRoot, initialized, committed: false, message })
    return
  }
  const done = git(stateRoot, ...GIT_IDENTITY, 'commit', '-q', '-m', message)
  out({ stateRoot, initialized, committed: !done.error && done.status === 0, message })
}

// --- cleanup ---------------------------------------------------------------

interface CleanupResult {
  file: string
  repo?: FrontmatterValue
  repoRoot?: string
  worktreeRemoved: boolean
  worktree?: FrontmatterValue
  reason?: string
}

/**
 * Best-effort `git worktree remove`: try a plain remove; on failure, if the
 * worktree path is already gone, prune the stale admin record; if it still
 * exists and is CLEAN (locked/administrative failure), retry with `--force`.
 * A DIRTY worktree is never force-removed — its removal reports false and the
 * frontmatter `worktree` is left intact. Returns whether the worktree is gone.
 */
function removeWorktree(repoRoot: string, worktreePath: string): boolean {
  const plain = git(repoRoot, 'worktree', 'remove', worktreePath)
  if (!plain.error && plain.status === 0) return true
  if (!existsSync(worktreePath)) {
    git(repoRoot, 'worktree', 'prune')
    return true
  }
  const status = git(worktreePath, 'status', '--porcelain')
  const clean = !status.error && status.status === 0 && status.stdout.trim() === ''
  if (!clean) return false
  const forced = git(repoRoot, 'worktree', 'remove', '--force', worktreePath)
  return !forced.error && forced.status === 0
}

/**
 * Remove a deliverable's worktree in its own repo and null the frontmatter
 * `worktree` (only when the worktree is actually gone). The branch is
 * deliberately KEPT — a merged parent's branch is still needed by
 * `/strapped:pr --update` to rebase its same-repo children (it resolves the
 * parent by name). The `.md` body and every other run-state file survive.
 * Errors go through `onError` (die for the explicit command; a throw for the
 * best-effort transition-path caller, which swallows it).
 */
function cleanupWorktree(file: string, onError: (msg: string) => never): CleanupResult {
  const { data, content } = readFrontmatterFile(file, onError)
  const worktree = data.worktree
  if (worktree === null || worktree === undefined || worktree === '') {
    return { file, worktreeRemoved: false, reason: 'no worktree' }
  }
  const worktreePath = String(worktree)
  const runDir = dirname(dirname(file))
  const manifestFile = join(runDir, 'manifest.md')
  if (!existsSync(manifestFile)) onError(`no manifest at ${manifestFile} (cannot resolve repo root)`)
  const mfm = parseFrontmatter(readFileSync(manifestFile, 'utf8'), manifestFile, onError)
  const repo = data.repo ?? null
  const repos: ListItem[] = Array.isArray(mfm.repos) ? mfm.repos : []
  const entry = repos.find(r => mapField(r, 'name') === repo)
  const repoRootVal = entry === undefined ? undefined : mapField(entry, 'root')
  if (repoRootVal === undefined || repoRootVal === null) {
    onError(`cannot resolve repo root for repo "${valueToString(repo)}" in ${manifestFile}`)
  }
  const repoRoot = String(repoRootVal)
  const removed = removeWorktree(repoRoot, worktreePath)
  if (removed) {
    data.worktree = null
    writeFrontmatterFile(file, data, content)
  }
  return { file, repo, repoRoot, worktreeRemoved: removed, worktree: removed ? null : worktree }
}

function cmdCleanup(file: string): void {
  out(cleanupWorktree(file, die))
}

// --- outstanding -----------------------------------------------------------

function cmdOutstanding(runDirArg: string | null): void {
  const stateRoot = resolveStateRoot(die)
  let runDirs: string[]
  if (runDirArg !== null) {
    runDirs = [runDirArg]
  } else {
    const runsRoot = join(stateRoot, 'runs')
    runDirs = existsSync(runsRoot)
      ? readdirSync(runsRoot)
          .map(name => join(runsRoot, name))
          .filter(dir => statSync(dir).isDirectory())
          .sort()
      : []
  }
  const deliverables: Record<string, FrontmatterValue>[] = []
  for (const runDir of runDirs) {
    const manifestFile = join(runDir, 'manifest.md')
    if (!existsSync(manifestFile)) continue
    const mfm = parseFrontmatter(readFileSync(manifestFile, 'utf8'), manifestFile, die)
    const slug = basename(runDir)
    const repos: ListItem[] = Array.isArray(mfm.repos) ? mfm.repos : []
    const rootByName = new Map(repos.map(r => [mapField(r, 'name'), mapField(r, 'root') ?? null]))
    const list: ListItem[] = Array.isArray(mfm.deliverables) ? mfm.deliverables : []
    for (const listEntry of list) {
      const fileField = String(mapField(listEntry, 'file'))
      const dfile = isAbsolute(fileField) ? fileField : join(runDir, fileField)
      if (!existsSync(dfile)) continue
      const fm = parseFrontmatter(readFileSync(dfile, 'utf8'), dfile, die)
      if (fm.status === 'merged') continue
      const repo = fm.repo ?? null
      deliverables.push({
        slug,
        id: fm.id ?? mapField(listEntry, 'id') ?? null,
        file: dfile,
        status: fm.status ?? null,
        repo,
        repoRoot: rootByName.get(repo) ?? null,
        branch: fm.branch ?? null,
        base: fm.base ?? null,
        worktree: fm.worktree ?? null,
        pr: fm.pr ?? null,
      })
    }
  }
  out({ stateRoot, deliverables })
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
  // The `pr-open → merged` edge cleans up the deliverable's worktree regardless
  // of which owner drove the flip. Best-effort: it re-reads/rewrites the file to
  // null `worktree`, but ALL errors are swallowed and it never touches the
  // one-JSON-object stdout or the exit code. Run before the auto-commit so the
  // `worktree: null` write is swept into the same commit.
  if (to === 'merged') {
    try {
      cleanupWorktree(file, msg => {
        throw new Error(msg)
      })
    } catch {
      // best-effort: cleanup is a convenience, the transition is the contract.
    }
  }
  autoCommitStateRoot(file, `state: ${basename(file)} ${current}→${to}`)
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
  autoCommitStateRoot(file, `manifest: ${basename(runDir)} ${current}→${to}`)
  out({ file, from: current, to, changed: true })
}

// --- feedback-index ---------------------------------------------------------
// A per-run JSON collection (NOT frontmatter — it is a keyed collection, so it
// bypasses the js-yaml frontmatter helpers) keyed by GitHub external id,
// tracking every fetched PR comment and its lifecycle status so multi-round
// feedback loops dedupe already-addressed comments. Contracts in
// conventions.md ("Feedback index").

const FEEDBACK_STATUSES: ReadonlySet<string> = new Set([
  'unaddressed',
  'addressed',
  'resolved',
  'not_needed',
  'ignored',
])

// Statuses upsert may reconcile to `resolved` when GitHub reports the thread
// resolved. `ignored`/`not_needed` are deliberately excluded — never touched.
const GITHUB_RECONCILABLE: ReadonlySet<string> = new Set(['unaddressed', 'addressed'])

interface FeedbackComment {
  externalId: string
  threadId: string | null
  deliverableId: string | null
  pr: string | null
  path: string | null
  line: number | null
  author: string | null
  body: string | null
  status: string
  commit: string | null
  githubResolved: boolean
  updated: string
}

interface FeedbackIndex {
  version: number
  comments: FeedbackComment[]
}

function feedbackIndexPath(runDir: string): string {
  return join(runDir, 'feedback-index.json')
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** Missing file → an empty v1 index; malformed JSON or shape → die. */
function readFeedbackIndex(path: string): FeedbackIndex {
  if (!existsSync(path)) return { version: 1, comments: [] }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    die(`invalid JSON in feedback index ${path}`)
  }
  if (typeof parsed !== 'object' || parsed === null) die(`malformed feedback index ${path}`)
  const obj = parsed as { version?: unknown; comments?: unknown }
  const version = typeof obj.version === 'number' ? obj.version : 1
  const comments = Array.isArray(obj.comments) ? (obj.comments as FeedbackComment[]) : []
  return { version, comments }
}

function writeFeedbackIndex(path: string, index: FeedbackIndex): void {
  writeFileSync(path, JSON.stringify(index, null, 2) + '\n')
}

function cmdFeedbackIndexRead(runDir: string): void {
  const path = feedbackIndexPath(runDir)
  if (!existsSync(path)) {
    out({ path, exists: false, comments: [] })
    return
  }
  out({ path, exists: true, comments: readFeedbackIndex(path).comments })
}

/** The incoming fetched-comment shape (all fields optional but externalId). */
interface IncomingRecord {
  externalId?: unknown
  threadId?: unknown
  deliverableId?: unknown
  pr?: unknown
  path?: unknown
  line?: unknown
  author?: unknown
  body?: unknown
  githubResolved?: unknown
}

function cmdFeedbackIndexUpsert(runDir: string, fromFile: string): void {
  if (!existsSync(fromFile)) die(`--from file not found: ${fromFile}`)
  let incoming: unknown = null
  try {
    incoming = JSON.parse(readFileSync(fromFile, 'utf8'))
  } catch {
    die(`invalid JSON in --from file ${fromFile}`)
  }
  if (!Array.isArray(incoming)) die(`--from file must contain a JSON array of comments: ${fromFile}`)

  const path = feedbackIndexPath(runDir)
  const index = readFeedbackIndex(path)
  const byId = new Map<string, FeedbackComment>(index.comments.map(c => [c.externalId, c]))
  const now = new Date().toISOString()
  let inserted = 0
  let updated = 0
  let resolvedFromGithub = 0

  for (const rec of incoming as IncomingRecord[]) {
    const externalId = asString(rec.externalId)
    if (externalId === null) die(`incoming comment missing externalId in ${fromFile}`)
    const githubResolved = rec.githubResolved === true
    const existing = byId.get(externalId)
    if (existing === undefined) {
      // New comment: insert as unaddressed, or resolved if it arrived resolved.
      const comment: FeedbackComment = {
        externalId,
        threadId: asString(rec.threadId),
        deliverableId: asString(rec.deliverableId),
        pr: asString(rec.pr),
        path: asString(rec.path),
        line: asNumber(rec.line),
        author: asString(rec.author),
        body: asString(rec.body),
        status: githubResolved ? 'resolved' : 'unaddressed',
        commit: null,
        githubResolved,
        updated: now,
      }
      index.comments.push(comment)
      byId.set(externalId, comment)
      inserted += 1
    } else {
      // Existing comment: refresh github-derived fields, then reconcile status.
      existing.threadId = asString(rec.threadId)
      existing.pr = asString(rec.pr)
      existing.path = asString(rec.path)
      existing.line = asNumber(rec.line)
      existing.author = asString(rec.author)
      existing.body = asString(rec.body)
      existing.githubResolved = githubResolved
      // Reconcile to resolved only from a still-open status — an ignored or
      // not_needed comment is NEVER changed here.
      if (githubResolved && GITHUB_RECONCILABLE.has(existing.status)) {
        existing.status = 'resolved'
        resolvedFromGithub += 1
      }
      existing.updated = now
      updated += 1
    }
  }

  writeFeedbackIndex(path, index)
  out({ inserted, updated, resolvedFromGithub, total: index.comments.length })
}

function cmdFeedbackIndexSet(runDir: string, externalId: string, status: string, commit: string | null): void {
  if (!FEEDBACK_STATUSES.has(status)) die(`unknown feedback status "${status}"`)
  const path = feedbackIndexPath(runDir)
  if (!existsSync(path)) die(`no feedback index at ${path}`)
  const index = readFeedbackIndex(path)
  const comment = index.comments.find(c => c.externalId === externalId)
  if (comment === undefined) die(`unknown externalId "${externalId}" in ${path}`)
  const from = comment.status
  const commitChanges = commit !== null && commit !== comment.commit
  if (from === status && !commitChanges) {
    out({ externalId, from, to: status, commit: comment.commit, changed: false })
    return
  }
  comment.status = status
  if (commit !== null) comment.commit = commit
  comment.updated = new Date().toISOString()
  writeFeedbackIndex(path, index)
  out({ externalId, from, to: status, commit: comment.commit, changed: true })
}

// --- dispatch ---------------------------------------------------------------

const USAGE =
  'usage: state.mjs <resolve|dag|set|transition|manifest-status|feedback-index|commit|cleanup|outstanding> ...'
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
  case 'feedback-index': {
    const sub = rest[0]
    switch (sub) {
      case 'read': {
        const runDirArg = rest[1]
        if (!runDirArg) die('usage: state.mjs feedback-index read <runDir>')
        cmdFeedbackIndexRead(resolve(runDirArg))
        break
      }
      case 'upsert': {
        const from = takeFlag(rest, '--from')
        const runDirArg = rest[1]
        if (!runDirArg || !from) die('usage: state.mjs feedback-index upsert <runDir> --from <jsonFile>')
        cmdFeedbackIndexUpsert(resolve(runDirArg), resolve(from))
        break
      }
      case 'set': {
        const commit = takeFlag(rest, '--commit')
        const runDirArg = rest[1]
        const externalId = rest[2]
        const status = rest[3]
        if (!runDirArg || externalId === undefined || status === undefined) {
          die('usage: state.mjs feedback-index set <runDir> <externalId> <status> [--commit <sha>]')
        }
        cmdFeedbackIndexSet(resolve(runDirArg), externalId, status, commit)
        break
      }
      default:
        die('usage: state.mjs feedback-index <read|upsert|set> ...')
    }
    break
  }
  case 'commit': {
    const message = takeFlag(rest, '--message')
    const arg = rest[0]
    cmdCommit(arg ? resolve(arg) : null, message ?? 'state: checkpoint')
    break
  }
  case 'cleanup': {
    const fileArg = rest[0]
    if (!fileArg) die('usage: state.mjs cleanup <deliverableFile>')
    cmdCleanup(resolve(fileArg))
    break
  }
  case 'outstanding': {
    const runDirArg = rest[0]
    cmdOutstanding(runDirArg ? resolve(runDirArg) : null)
    break
  }
  default:
    die(USAGE)
}
