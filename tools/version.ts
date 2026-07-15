// Deterministic plugin-version tool. The ONLY semver in the repo lives in
// plugins/strapped/.claude-plugin/plugin.json ("version"); package.json is
// private with no version, so `npm/bun version` do not apply. This hand-rolls a
// MAJOR.MINOR.PATCH bump (zero dependencies — node:* + src/lib/cli.ts +
// tools/build.ts only) so contributors stop inventing versions by hand.
//
//   bun tools/version.ts read              print {version, major, minor, patch}
//   bun tools/version.ts bump <level>      level ∈ {major,minor,patch}; rewrite
//                                          plugin.json, print {old, new}
//   bun tools/version.ts check [--base R]  build-pipeline guard: fail if a
//                                          generated artifact changed vs the base
//                                          ref without a version bump
//
// The check guard degrades gracefully — an unresolvable base ref/file exits 0
// with a stderr skip note so it never produces a false CI failure.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { die as cliDie, out } from '../src/lib/cli.ts'
import { BUILDS, SCHEMA_BUILDS, WORKFLOW_BUILDS } from './build.ts'

const die: (msg: string) => never = m => cliDie('version.ts', m)

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Repo-relative path of the one semver-bearing manifest. */
const PLUGIN_JSON_REL = 'plugins/strapped/.claude-plugin/plugin.json'

/**
 * The plugin.json the read/bump subcommands operate on: the real committed file
 * (resolved from this module, so it works from any cwd), overridable via
 * STRAPPED_PLUGIN_JSON — the test seam the design calls for, letting the CLI run
 * against a temp copy and never clobber the real file.
 */
function pluginJsonPath(): string {
  return process.env.STRAPPED_PLUGIN_JSON ?? resolve(ROOT, PLUGIN_JSON_REL)
}

export interface Semver {
  major: number
  minor: number
  patch: number
}

export type BumpLevel = 'major' | 'minor' | 'patch'

/** Strict MAJOR.MINOR.PATCH parse; anything else is a hard error. */
export function parseSemver(raw: string): Semver {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw)
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
    die(`not a valid MAJOR.MINOR.PATCH version: "${raw}"`)
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export function formatSemver(sv: Semver): string {
  return `${sv.major}.${sv.minor}.${sv.patch}`
}

/** Increment with standard reset semantics (minor/major zero the lower parts). */
export function bumpSemver(level: BumpLevel, sv: Semver): Semver {
  switch (level) {
    case 'patch':
      return { major: sv.major, minor: sv.minor, patch: sv.patch + 1 }
    case 'minor':
      return { major: sv.major, minor: sv.minor + 1, patch: 0 }
    case 'major':
      return { major: sv.major + 1, minor: 0, patch: 0 }
  }
}

/** Order two versions: major, then minor, then patch. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] < b[key]) return -1
    if (a[key] > b[key]) return 1
  }
  return 0
}

/** Extract a string `version` field from raw plugin.json text. */
function versionFromJson(raw: string): string {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    die('plugin.json is not valid JSON')
  }
  if (typeof obj !== 'object' || obj === null) die('plugin.json is not a JSON object')
  const version = (obj as Record<string, unknown>).version
  if (typeof version !== 'string') die('plugin.json has no string "version" field')
  return version
}

/** Read the raw version string from a plugin.json file. */
export function readVersion(pluginJsonPath: string): string {
  return versionFromJson(readFileSync(pluginJsonPath, 'utf8'))
}

/**
 * Rewrite the version in place, preserving the file's 2-space indent, trailing
 * newline, and key order (JSON.parse keeps insertion order) — the diff is the
 * single version line.
 */
export function writeVersion(pluginJsonPath: string, newVersion: string): void {
  const obj = JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as Record<string, unknown>
  obj.version = newVersion
  writeFileSync(pluginJsonPath, JSON.stringify(obj, null, 2) + '\n')
}

/** Repo-relative committed paths of every generated artifact (never hardcoded). */
export function generatedArtifacts(): string[] {
  return [...SCHEMA_BUILDS, ...BUILDS, ...WORKFLOW_BUILDS].map(spec => spec.outfile)
}

export interface CheckResult {
  changed: string[]
  bumped: boolean
  skipped: boolean
}

/** Read `git show <ref>:<path>` from a repo; ok=false when git errors (absent ref/path). */
function gitShow(ref: string, path: string, cwd: string): { ok: boolean; content: string } {
  const res = spawnSync('git', ['show', `${ref}:${path}`], { cwd, encoding: 'utf8' })
  if (res.status !== 0) return { ok: false, content: '' }
  return { ok: true, content: res.stdout }
}

/**
 * The build-pipeline guard, operating on `cwd` (the working tree). Compares each
 * generated artifact between the base ref and the working tree; a changed
 * artifact must be accompanied by a version strictly greater than the base's.
 * An unresolvable base plugin.json → skipped (never a false failure).
 */
export function check(baseRef: string, cwd: string = process.cwd()): CheckResult {
  const base = gitShow(baseRef, PLUGIN_JSON_REL, cwd)
  if (!base.ok) return { changed: [], bumped: false, skipped: true }

  const baseVersion = parseSemver(versionFromJson(base.content))
  const workingVersion = parseSemver(readVersion(resolve(cwd, PLUGIN_JSON_REL)))
  const bumped = compareSemver(workingVersion, baseVersion) > 0

  const changed: string[] = []
  for (const outfile of generatedArtifacts()) {
    const workingPath = resolve(cwd, outfile)
    if (!existsSync(workingPath)) continue
    const workingBytes = readFileSync(workingPath, 'utf8')
    const baseShow = gitShow(baseRef, outfile, cwd)
    // A git-show miss for an in-tree artifact means it is new at HEAD → changed.
    if (!baseShow.ok || baseShow.content !== workingBytes) changed.push(outfile)
  }

  return { changed, bumped, skipped: false }
}

/** Whether a git ref resolves in `cwd` (used to pick the default base). */
function refExists(ref: string, cwd: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd }).status === 0
}

const USAGE =
  'usage: version.ts read | bump <major|minor|patch> | check [--base <ref>]'

function runBump(level: string | undefined): void {
  if (level !== 'major' && level !== 'minor' && level !== 'patch') {
    die(`bump requires a level: bump <major|minor|patch>`)
  }
  const path = pluginJsonPath()
  const old = formatSemver(parseSemver(readVersion(path)))
  const next = formatSemver(bumpSemver(level, parseSemver(old)))
  writeVersion(path, next)
  out({ old, new: next })
}

function runCheck(argv: string[]): void {
  let baseRef: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') {
      baseRef = argv[i + 1]
      i++
    }
  }
  const cwd = process.cwd()
  // Default base: prefer origin/main, fall back to main (the check itself skips
  // gracefully if neither resolves).
  if (baseRef === undefined) {
    baseRef = refExists('origin/main', cwd) ? 'origin/main' : 'main'
  }

  const result = check(baseRef, cwd)
  if (result.skipped) {
    process.stderr.write(`version.ts: base ref "${baseRef}" unresolvable — skipping version guard\n`)
    return
  }
  if (result.changed.length > 0 && !result.bumped) {
    die(
      `generated artifacts changed vs ${baseRef} without a version bump:\n` +
        result.changed.map(f => `  ${f}`).join('\n') +
        `\nbump the plugin version: bun tools/version.ts bump <major|minor|patch>`
    )
  }
  out({ changed: result.changed, bumped: result.bumped, base: baseRef })
}

if (import.meta.main) {
  const [subcommand, ...rest] = process.argv.slice(2)
  switch (subcommand) {
    case 'read': {
      const version = readVersion(pluginJsonPath())
      const sv = parseSemver(version)
      out({ version, major: sv.major, minor: sv.minor, patch: sv.patch })
      break
    }
    case 'bump':
      runBump(rest[0])
      break
    case 'check':
      runCheck(rest)
      break
    default:
      die(USAGE)
  }
}
