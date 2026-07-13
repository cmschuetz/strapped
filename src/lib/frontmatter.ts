// Frontmatter parsing + byte-preserving single-field writes, extracted from
// the state CLI. The exact `key: value` single-space line shape from
// conventions.md, plus the manifest's two nested forms: an indented
// `key: value` map (budgets) and an indented `- { ... }` inline-flow list
// (repos, deliverables). Writes must preserve every untouched line
// byte-for-byte so grep-based consumers (sync-prs.sh) keep working.
//
// Error handling is caller-owned: every function that can reject its input
// takes the caller's `die` (each CLI keeps its own stderr prefix).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Never returns — writes one prefixed line to stderr and exits 1. */
export type Die = (msg: string) => never

/** A single frontmatter scalar as parsed by `parseScalar`. */
export type Scalar = string | number | null

/** One `- { ... }` inline-flow list entry (values may be bracket lists). */
export type InlineMap = Record<string, Scalar | string[]>

/** An item of a nested block list: inline map or plain scalar. */
export type ListItem = Scalar | InlineMap

/** Every value shape a top-level frontmatter key can hold. */
export type FrontmatterValue = Scalar | string[] | ListItem[] | Record<string, Scalar>

/** A parsed frontmatter block, keyed by top-level field name. */
export type Frontmatter = Record<string, FrontmatterValue>

export interface FrontmatterSpan {
  lines: string[]
  start: number
  end: number
}

export function splitFrontmatter(src: string, file: string, die: Die): FrontmatterSpan {
  const lines = src.split('\n')
  if (lines[0] !== '---') die(`${file}: no frontmatter`)
  const end = lines.indexOf('---', 1)
  if (end === -1) die(`${file}: unterminated frontmatter`)
  return { lines, start: 1, end }
}

export function parseScalar(raw: string): Scalar {
  const v = raw.trim()
  if (v === '' || v === 'null') return null
  if (/^-?\d+$/.test(v)) return Number(v)
  return v
}

export function parseBracketList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim()
  return inner === '' ? [] : inner.split(',').map(s => s.trim())
}

export function parseInlineMap(raw: string): InlineMap {
  const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '')
  const parts: string[] = []
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
  const obj: InlineMap = {}
  for (const part of parts) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    obj[key] = value.startsWith('[') ? parseBracketList(value) : parseScalar(value)
  }
  return obj
}

export function parseFrontmatter(src: string, file: string, die: Die): Frontmatter {
  const { lines, start, end } = splitFrontmatter(src, file, die)
  const fm: Frontmatter = {}
  let i = start
  while (i < end) {
    const m = (lines[i] ?? '').match(/^([A-Za-z_][\w-]*):(.*)$/)
    if (!m || m[1] === undefined) {
      i++
      continue
    }
    const key = m[1]
    const rest = (m[2] ?? '').trim()
    if (rest === '') {
      const items: ListItem[] = []
      const map: Record<string, Scalar> = {}
      let isList = false
      let isMap = false
      i++
      while (i < end && /^\s+\S/.test(lines[i] ?? '')) {
        const line = (lines[i] ?? '').trim()
        if (line.startsWith('- ')) {
          isList = true
          const body = line.slice(2).trim()
          items.push(body.startsWith('{') ? parseInlineMap(body) : parseScalar(body))
        } else {
          const mm = line.match(/^([\w-]+):\s*(.*)$/)
          if (mm && mm[1] !== undefined) {
            isMap = true
            map[mm[1]] = parseScalar(mm[2] ?? '')
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

export function findFieldLine(lines: string[], start: number, end: number, field: string): number {
  for (let i = start; i < end; i++) {
    const line = lines[i]
    if (line === `${field}:` || (line !== undefined && line.startsWith(`${field}: `))) return i
  }
  return -1
}

export interface FieldRead {
  lines: string[]
  idx: number
  value: string | null
}

export function readField(file: string, field: string, die: Die): FieldRead {
  if (!existsSync(file)) die(`no such file: ${file}`)
  const src = readFileSync(file, 'utf8')
  const { lines, start, end } = splitFrontmatter(src, file, die)
  const idx = findFieldLine(lines, start, end, field)
  return { lines, idx, value: idx === -1 ? null : (lines[idx] ?? '').slice(field.length + 1).trim() }
}

/** Replace exactly one frontmatter line, preserving every other byte. */
export function writeField(file: string, lines: string[], idx: number, field: string, value: string): void {
  lines[idx] = `${field}: ${value}`
  writeFileSync(file, lines.join('\n'))
}
