// Frontmatter parse + write through gray-matter (a bundled dependency). The
// hand-rolled parser/single-field writer this file used to hold was dropped:
// gray-matter owns BOTH parse and stringify now.
//
// The one thing the CLI must guarantee is that the two shapes grep-based bash
// consumers depend on survive a write:
//   1. the deliverable `deps: [...]` FLOW array — `sync-prs.sh` parses deps with
//      `sed 's/^deps:[[:space:]]*\[\(.*\)\]/\1/'`, which requires the `[...]` form;
//   2. single-space `key: value` scalar block lines — `sync-prs.sh`/`preamble.sh`
//      grep `^status:`/`^pr:`/`^id:`.
// gray-matter serializes via js-yaml; the default dump reflows depth-1 arrays to
// block sequences (`deps:\n  - D1`), which would break (1). So we hand gray-matter
// a js-yaml engine pinned to `flowLevel: 1` (depth-1 nodes — the `deps` array — go
// flow) + `condenseFlow` + `lineWidth: -1`; scalars stay single-space block lines,
// satisfying both shapes at once. The manifest's `repos:`/`deliverables:`/`budgets:`
// maps are NOT grep-consumed (only state.ts reads them, via gray-matter), so their
// reflow to flow style under this engine is inconsequential.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import matter from 'gray-matter'
import yaml from 'js-yaml'

/** Never returns — writes one prefixed line to stderr and exits 1. */
export type Die = (msg: string) => never

/** A parsed frontmatter block: gray-matter yields arbitrary YAML values. */
export type Frontmatter = Record<string, unknown>

/** Back-compat aliases for consumers that annotated frontmatter values/list items. */
export type FrontmatterValue = unknown
export type ListItem = unknown

// A js-yaml engine that keeps depth-1 arrays (the deliverable `deps` list) inline
// while every scalar stays a single-space block line — the two grep-consumed shapes.
const yamlEngine = {
  parse: (input: string): object => (yaml.load(input) ?? {}) as object,
  stringify: (data: object): string =>
    yaml.dump(data, { flowLevel: 1, lineWidth: -1, condenseFlow: true }),
}

const MATTER_OPTIONS = { engines: { yaml: yamlEngine } }

/** Parse a frontmatter document's data block; die on malformed YAML. */
export function parseFrontmatter(src: string, file: string, die: Die): Frontmatter {
  try {
    return matter(src, MATTER_OPTIONS).data
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
    const parsed = matter(readFileSync(file, 'utf8'), MATTER_OPTIONS)
    return { data: parsed.data, content: parsed.content }
  } catch (err) {
    return die(`invalid frontmatter in ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Re-serialize a frontmatter document through the pinned engine (whole-block write). */
export function writeFrontmatterFile(file: string, data: Frontmatter, content: string): void {
  writeFileSync(file, matter.stringify(content, data, MATTER_OPTIONS))
}

/**
 * Coerce a CLI-supplied value string to the scalar it denotes (so `set pr null`
 * stores YAML null → `pr: null`, `set x 100` stores 100 → `x: 100`), letting the
 * writer emit it faithfully. Falls back to the raw string when the input is not a
 * parseable scalar (or parses to nothing).
 */
export function coerceValue(value: string): unknown {
  let parsed: unknown
  try {
    parsed = yaml.load(value)
  } catch {
    return value
  }
  return parsed === undefined ? value : parsed
}

/** Render a parsed frontmatter value as the string the CLI reports (`null` → "null"). */
export function valueToString(value: unknown): string {
  return value === null ? 'null' : String(value)
}
