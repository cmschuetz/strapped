#!/usr/bin/env node
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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

function die(msg) {
  process.stderr.write(`state.mjs: ${msg}\n`)
  process.exit(1)
}

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n')

// --- frontmatter -----------------------------------------------------------
// The exact `key: value` single-space line shape from conventions.md, plus the
// manifest's two nested forms: an indented `key: value` map (budgets) and an
// indented `- { ... }` inline-flow list (repos, deliverables). Writes must
// preserve every untouched line byte-for-byte so grep-based consumers
// (sync-prs.sh) keep working.

function splitFrontmatter(src, file) {
  const lines = src.split('\n')
  if (lines[0] !== '---') die(`${file}: no frontmatter`)
  const end = lines.indexOf('---', 1)
  if (end === -1) die(`${file}: unterminated frontmatter`)
  return { lines, start: 1, end }
}

function parseScalar(raw) {
  const v = raw.trim()
  if (v === '' || v === 'null') return null
  if (/^-?\d+$/.test(v)) return Number(v)
  return v
}

function parseBracketList(raw) {
  const inner = raw.trim().slice(1, -1).trim()
  return inner === '' ? [] : inner.split(',').map(s => s.trim())
}

function parseInlineMap(raw) {
  const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '')
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of inner) {
    if (ch === '[') depth++
    if (ch === ']') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim() !== '') parts.push(cur)
  const obj = {}
  for (const part of parts) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    obj[key] = value.startsWith('[') ? parseBracketList(value) : parseScalar(value)
  }
  return obj
}

function parseFrontmatter(src, file) {
  const { lines, start, end } = splitFrontmatter(src, file)
  const fm = {}
  let i = start
  while (i < end) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):(.*)$/)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    const rest = m[2].trim()
    if (rest === '') {
      const items = []
      const map = {}
      let isList = false
      let isMap = false
      i++
      while (i < end && /^\s+\S/.test(lines[i])) {
        const line = lines[i].trim()
        if (line.startsWith('- ')) {
          isList = true
          const body = line.slice(2).trim()
          items.push(body.startsWith('{') ? parseInlineMap(body) : parseScalar(body))
        } else {
          const mm = line.match(/^([\w-]+):\s*(.*)$/)
          if (mm) {
            isMap = true
            map[mm[1]] = parseScalar(mm[2])
          }
        }
        i++
      }
      fm[key] = isList ? items : isMap ? map : null
      continue
    }
    fm[key] = rest.startsWith('[') ? parseBracketList(rest) : parseScalar(rest)
    i++
  }
  return fm
}

function findFieldLine(lines, start, end, field) {
  for (let i = start; i < end; i++) {
    if (lines[i] === `${field}:` || lines[i].startsWith(`${field}: `)) return i
  }
  return -1
}

function readField(file, field) {
  if (!existsSync(file)) die(`no such file: ${file}`)
  const src = readFileSync(file, 'utf8')
  const { lines, start, end } = splitFrontmatter(src, file)
  const idx = findFieldLine(lines, start, end, field)
  return { lines, idx, value: idx === -1 ? null : lines[idx].slice(field.length + 1).trim() }
}

function writeField(file, lines, idx, field, value) {
  lines[idx] = `${field}: ${value}`
  writeFileSync(file, lines.join('\n'))
}

// --- resolve ---------------------------------------------------------------

function resolveStateRoot() {
  const home = process.env.HOME || homedir()
  let value = null
  let source = null
  if (process.env.STRAPPED_STATE_ROOT) {
    value = process.env.STRAPPED_STATE_ROOT
    source = '$STRAPPED_STATE_ROOT'
  } else {
    const anchor = join(home, '.claude', 'strapped.json')
    if (existsSync(anchor)) {
      let parsed
      try {
        parsed = JSON.parse(readFileSync(anchor, 'utf8'))
      } catch {
        die(`invalid JSON in anchor file ${anchor}`)
      }
      if (parsed && typeof parsed.stateRoot === 'string' && parsed.stateRoot !== '') {
        value = parsed.stateRoot
        source = anchor
      }
    }
    if (value === null) {
      value = join(home, '.claude', 'strapped')
      source = 'default'
    }
  }
  if (value === '~' || value.startsWith('~/')) value = home + value.slice(1)
  if (!isAbsolute(value)) die(`stateRoot is not absolute: "${value}" (from ${source})`)
  return value
}

function cmdResolve(slug) {
  const stateRoot = resolveStateRoot()
  const runRoot = join(stateRoot, 'runs')
  const runDir = join(runRoot, slug)
  const manifest = join(runDir, 'manifest.md')
  const base = { slug, stateRoot, runRoot, runDir, manifest }
  if (!existsSync(manifest)) {
    out({ ...base, exists: false, status: null, seed: null, budgets: null, repos: [] })
    return
  }
  const fm = parseFrontmatter(readFileSync(manifest, 'utf8'), manifest)
  const repos = (Array.isArray(fm.repos) ? fm.repos : []).map(entry => {
    const config = join(stateRoot, 'repos', String(entry.name), 'config.json')
    const configExists = existsSync(config)
    let cfg = null
    if (configExists) {
      try {
        cfg = JSON.parse(readFileSync(config, 'utf8'))
      } catch {
        die(`invalid JSON in repo config ${config}`)
      }
    }
    return {
      name: entry.name ?? null,
      root: entry.root ?? null,
      config,
      configExists,
      validations: cfg?.validations ?? null,
      worktreeRoot: cfg?.worktreeRoot ?? null,
      provisioning: cfg?.provisioning ?? null,
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

const COMPLETE_STATUSES = new Set(['done', 'pr-open', 'merged'])

function cmdDag(runDir, only) {
  const manifestFile = join(runDir, 'manifest.md')
  if (!existsSync(manifestFile)) die(`no manifest at ${manifestFile}`)
  const mfm = parseFrontmatter(readFileSync(manifestFile, 'utf8'), manifestFile)
  const list = Array.isArray(mfm.deliverables) ? mfm.deliverables : []
  if (list.length === 0) die(`manifest has no deliverables list: ${manifestFile}`)

  const nodes = list.map(entry => {
    const file = isAbsolute(String(entry.file)) ? String(entry.file) : join(runDir, String(entry.file))
    if (!existsSync(file)) die(`deliverable file missing: ${file} (listed in manifest as ${entry.id})`)
    const fm = parseFrontmatter(readFileSync(file, 'utf8'), file)
    return {
      id: fm.id ?? entry.id,
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

  const byId = new Map(nodes.map(n => [n.id, n]))
  if (byId.size !== nodes.length) die(`duplicate deliverable ids in ${manifestFile}`)
  for (const n of nodes) {
    for (const dep of n.deps) {
      if (!byId.has(dep)) die(`unknown dep ${dep} (referenced by ${n.id})`)
    }
  }
  if (only && !byId.has(only)) die(`--only ${only}: no such deliverable`)

  // Kahn's algorithm; deterministic tiebreak by id.
  const indegree = new Map(nodes.map(n => [n.id, n.deps.length]))
  const children = new Map(nodes.map(n => [n.id, []]))
  for (const n of nodes) for (const dep of n.deps) children.get(dep).push(n.id)
  const queue = nodes.filter(n => n.deps.length === 0).map(n => n.id)
  const topo = []
  while (queue.length > 0) {
    queue.sort()
    const id = queue.shift()
    topo.push(id)
    for (const child of children.get(id)) {
      indegree.set(child, indegree.get(child) - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }
  if (topo.length !== nodes.length) {
    const stuck = nodes.map(n => n.id).filter(id => !topo.includes(id)).sort()
    die(`dependency cycle involving: ${stuck.join(', ')}`)
  }

  const complete = id => COMPLETE_STATUSES.has(byId.get(id).status)
  const depsMet = n => n.deps.every(complete)
  let ready = nodes.filter(n => n.status === 'pending' && depsMet(n)).map(n => n.id)
  if (only) {
    const node = byId.get(only)
    const resumable = node.status === 'parked' || node.status === 'in-progress'
    if (resumable && depsMet(node) && !ready.includes(only)) ready.push(only)
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

function cmdSet(file, field, value) {
  // A multi-line value would inject extra frontmatter lines (e.g. a forged
  // second `status:` line), silently breaking the single-field-write contract.
  if (/[\r\n]/.test(value)) die('value must be a single line')
  const { lines, idx, value: old } = readField(file, field)
  if (idx === -1) die(`unknown frontmatter field "${field}" in ${file}`)
  if (lines[idx] !== `${field}: ${value}`) writeField(file, lines, idx, field, value)
  out({ file, field, old, new: value })
}

// --- transition ------------------------------------------------------------
// The ON-DISK edge set (see conventions.md "Harness scripts"): `ready`,
// `implemented`, and the mid-wave `in-review` of the conceptual lifecycle are
// virtual — never written to frontmatter — so the guard encodes the skip-edges
// the skills and workflows actually write.

const DELIVERABLE_EDGES = new Set([
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

function cmdTransition(file, to, from) {
  const { lines, idx, value: current } = readField(file, 'status')
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

const MANIFEST_LADDER = ['draft', 'in-review', 'approved', 'implementing', 'complete']

function cmdManifestStatus(runDir, to) {
  const file = join(runDir, 'manifest.md')
  if (!existsSync(file)) die(`no manifest at ${file}`)
  const { lines, idx, value: current } = readField(file, 'status')
  if (idx === -1) die(`no status field in ${file}`)
  const toIdx = MANIFEST_LADDER.indexOf(to)
  if (toIdx === -1) die(`unknown manifest status "${to}"`)
  const currentIdx = MANIFEST_LADDER.indexOf(current)
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

function takeFlag(args, flag) {
  const i = args.indexOf(flag)
  if (i === -1) return null
  const value = args[i + 1]
  if (!value) die(`${flag} requires a value`)
  args.splice(i, 2)
  return value
}

switch (cmd) {
  case 'resolve': {
    if (!rest[0]) die('usage: state.mjs resolve <slug>')
    cmdResolve(rest[0])
    break
  }
  case 'dag': {
    const only = takeFlag(rest, '--only')
    if (!rest[0]) die('usage: state.mjs dag <runDir> [--only <Did>]')
    cmdDag(resolve(rest[0]), only)
    break
  }
  case 'set': {
    if (rest.length < 3) die('usage: state.mjs set <file> <field> <value>')
    cmdSet(resolve(rest[0]), rest[1], rest.slice(2).join(' '))
    break
  }
  case 'transition': {
    const from = takeFlag(rest, '--from')
    if (!rest[0] || !rest[1]) die('usage: state.mjs transition <file> <to> [--from <expected>]')
    cmdTransition(resolve(rest[0]), rest[1], from)
    break
  }
  case 'manifest-status': {
    if (!rest[0] || !rest[1]) die('usage: state.mjs manifest-status <runDir> <to>')
    cmdManifestStatus(resolve(rest[0]), rest[1])
    break
  }
  default:
    die(USAGE)
}
