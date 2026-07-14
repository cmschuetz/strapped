// Frontmatter parse + write through js-yaml directly. The hand-rolled
// parser/single-field writer this file used to hold was dropped: one js-yaml
// engine owns BOTH parse and stringify now.
//
// (This previously went through gray-matter, but gray-matter statically pulls in
// its own js-yaml@3 — while the write shape below needs a js-yaml@4 dump engine —
// so the bundle carried TWO copies of js-yaml. gray-matter's only real job here
// was splitting the `---` fences, which is the tiny `FENCE` regex below; dropping
// the wrapper collapses the bundle to a single js-yaml with byte-identical output.)
//
// The one thing the CLI must guarantee is that the two shapes grep-based bash
// consumers depend on survive a write:
//   1. the deliverable `deps: [...]` FLOW array — `sync-prs.sh` parses deps with
//      `sed 's/^deps:[[:space:]]*\[\(.*\)\]/\1/'`, which requires the `[...]` form;
//   2. single-space `key: value` scalar block lines — `sync-prs.sh`/`preamble.sh`
//      grep `^status:`/`^pr:`/`^id:`.
// A default js-yaml dump reflows depth-1 arrays to block sequences (`deps:\n  - D1`),
// which would break (1). So the dump is pinned to `flowLevel: 1` (depth-1 nodes —
// the `deps` array — go flow) + `condenseFlow` + `lineWidth: -1`; scalars stay
// single-space block lines, satisfying both shapes at once. The manifest's
// `repos:`/`deliverables:`/`budgets:` maps are NOT grep-consumed (only state.ts
// reads them), so their reflow to flow style is inconsequential.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import yaml from 'js-yaml'

/** Never returns — writes one prefixed line to stderr and exits 1. */
export type Die = (msg: string) => never

/** A parsed frontmatter block: js-yaml yields arbitrary YAML values. */
export type Frontmatter = Record<string, unknown>

/** Back-compat aliases for consumers that annotated frontmatter values/list items. */
export type FrontmatterValue = unknown
export type ListItem = unknown

// Leading `---` fence block: captures the YAML between the delimiters and consumes
// the trailing newline, so `content` begins exactly where gray-matter's did.
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Dump a data block keeping depth-1 arrays inline and scalars as block lines. */
function dumpBlock(data: Frontmatter): string {
  return yaml.dump(data, { flowLevel: 1, lineWidth: -1, condenseFlow: true })
}

/** Split a source doc into its parsed data block and the remaining body. */
function splitFrontmatter(src: string): FrontmatterFile {
  const match = FENCE.exec(src)
  if (!match) return { data: {}, content: src }
  const consumed = match[0] ?? ''
  const block = match[1] ?? ''
  return { data: (yaml.load(block) ?? {}) as Frontmatter, content: src.slice(consumed.length) }
}

/** Parse a frontmatter document's data block; die on malformed YAML. */
export function parseFrontmatter(src: string, file: string, die: Die): Frontmatter {
  try {
    return splitFrontmatter(src).data
  } catch (err) {
    return die(`invalid frontmatter in ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface FrontmatterFile {
  data: Frontmatter
  content: string
}

/** Read a file's frontmatter + body; die when the file is missing or malformed. */
export function readFrontmatterFile(file: string, die: Die): FrontmatterFile {
  if (!existsSync(file)) die(`no such file: ${file}`)
  try {
    return splitFrontmatter(readFileSync(file, 'utf8'))
  } catch (err) {
    return die(`invalid frontmatter in ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Re-serialize a frontmatter document through the pinned engine (whole-block write). */
export function writeFrontmatterFile(file: string, data: Frontmatter, content: string): void {
  const out = Object.keys(data).length === 0 ? content : `---\n${dumpBlock(data)}---\n${content}`
  writeFileSync(file, out)
}

/**
 * Coerce a CLI-supplied value string to the scalar it denotes (so `set pr null`
 * stores YAML null → `pr: null`, `set x 100` stores 100 → `x: 100`), letting the
 * writer emit it faithfully.
 *
 * We match the original `state.mjs` `parseScalar`/`parseBracketList` shapes
 * EXPLICITLY rather than passing the raw string through the full YAML loader.
 * The loader (js-yaml's core schema) coerces YAML numeric-adjacent tokens that
 * the original CLI stored verbatim — `0x1F` → 31 (hex), `010` → 10, and under a
 * YAML 1.1 loader `12:30` → 750 (sexagesimal) — silently changing a free-text
 * field's on-disk representation. Restricting coercion to the intended forms
 * (empty/`null`, a plain base-10 integer `-?\d+`, and the `[...]` deps flow
 * array) reproduces the original parse behavior exactly; every other value —
 * including colon-bearing free text like `parked_reason "typecheck failed:
 * TS2322"` — is stored as the literal string.
 */
export function coerceValue(value: string): unknown {
  const v = value.trim()
  if (v === '' || v === 'null') return null
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map(s => s.trim())
  }
  return value
}

/** Render a parsed frontmatter value as the string the CLI reports (`null` → "null"). */
export function valueToString(value: unknown): string {
  return value === null ? 'null' : String(value)
}
