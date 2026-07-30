// Shared tiny fixture repo for the harness scenario suite: a minimal bun
// project (package.json, one source file, one test file, CLAUDE.md) whose
// validations run in seconds. The CLAUDE.md carries the suite's declared
// review rules VERBATIM (FIXTURE_RULES) so adherence and review behavior have
// something real to bite on. Also home to the small outcome-reading helpers
// the scenario definitions share (frontmatter reads, git probes, run-result
// views) — all throw-on-failure, which `artifactAssert`/`scenarioJudge` turn
// into failed verdicts rather than crashes.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFrontmatterFile, type Die, type Frontmatter, type FrontmatterFile } from '../../../../lib/frontmatter.ts'
import type { ScenarioOutcome, ScenarioRepo, ScenarioRule } from '../../../scenario/types.ts'

export const FIXTURE_REPO_NAME = 'calc'

export const FIXTURE_VALIDATIONS: string[] = ['bun test']

/** The fixture CLAUDE.md rules, fed verbatim to the review machinery. */
export const FIXTURE_RULES: ScenarioRule[] = [
  { id: 'FIX-1', source: 'CLAUDE.md', text: 'No code comments — source files stay comment-free and self-explanatory.' },
  { id: 'FIX-2', source: 'CLAUDE.md', text: 'Every exported function declares an explicit return type.' },
  { id: 'FIX-3', source: 'CLAUDE.md', text: 'Every exported function has a covering test under tests/.' },
]

const CLAUDE_MD = `# Guidelines

${FIXTURE_RULES.map(r => `- **${r.id}**: ${r.text}`).join('\n')}
`

/** Declarative file map of the fixture repo (path → content). */
export const FIXTURE_REPO_FILES: Record<string, string> = {
  'package.json': `{
  "name": "calc-fixture",
  "private": true,
  "type": "module"
}
`,
  'CLAUDE.md': CLAUDE_MD,
  'src/calc.ts': `export function add(a: number, b: number): number {
  return a + b
}
`,
  'tests/calc.test.ts': `import { expect, test } from 'bun:test'
import { add } from '../src/calc.ts'

test('add sums two numbers', () => {
  expect(add(2, 3)).toBe(5)
})
`,
}

/** A fresh ScenarioRepo declaration for the shared fixture. */
export function fixtureRepo(): ScenarioRepo {
  return { name: FIXTURE_REPO_NAME, files: { ...FIXTURE_REPO_FILES }, validations: [...FIXTURE_VALIDATIONS] }
}

// --- shared outcome-reading helpers -------------------------------------------

const raise: Die = msg => {
  throw new Error(msg)
}

/** Sorted deliverable-file basenames under the outcome's runDir. */
export function deliverableFiles(outcome: ScenarioOutcome): string[] {
  const dir = join(outcome.sandbox.runDir, 'deliverables')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
}

/** Read one deliverable file by basename; throws on a missing/malformed file. */
export function readDeliverable(outcome: ScenarioOutcome, basename: string): FrontmatterFile {
  return readFrontmatterFile(join(outcome.sandbox.runDir, 'deliverables', basename), raise)
}

/** Read the deliverable whose file matches `<id>-*.md`; throws when absent. */
export function deliverable(outcome: ScenarioOutcome, id: string): FrontmatterFile {
  const file = deliverableFiles(outcome).find(f => f.startsWith(`${id}-`))
  if (file === undefined) throw new Error(`no deliverable ${id}-*.md under ${outcome.sandbox.runDir}`)
  return readDeliverable(outcome, file)
}

/** A deliverable's frontmatter `worktree` path; throws when unset. */
export function worktreeOf(outcome: ScenarioOutcome, id: string): string {
  const wt = deliverable(outcome, id).data.worktree
  if (typeof wt !== 'string' || wt.length === 0) throw new Error(`deliverable ${id} has no worktree recorded`)
  return wt
}

/** The RunResult's per-stage `results` map ({} when the workflow threw). */
export function stageResults(outcome: ScenarioOutcome): Record<string, unknown> {
  const run = outcome.runResult
  if (run === null || typeof run !== 'object') return {}
  const results = (run as { results?: unknown }).results
  return typeof results === 'object' && results !== null ? (results as Record<string, unknown>) : {}
}

/** Run git in a directory; returns stdout, throws on failure (graders catch). */
export function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (res.error) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr.trim()}`)
  return res.stdout
}

/** Total changed lines (insertions + deletions) between base and HEAD in a worktree. */
export function changedLines(worktree: string, base: string): number {
  const numstat = git(worktree, 'diff', '--numstat', `${base}...HEAD`)
  let total = 0
  for (const line of numstat.split('\n')) {
    if (line.trim() === '') continue
    const [insertions, deletions] = line.split('\t')
    total += (Number(insertions) || 0) + (Number(deletions) || 0)
  }
  return total
}

/**
 * Judge evidence: per deliverable, its full body plus the worktree branch's
 * diff against its base. Git/worktree problems become inline notes (never a
 * throw) so a partially-produced run still renders judgeable evidence.
 */
export function renderProducedDiffs(outcome: ScenarioOutcome): string {
  const sections = deliverableFiles(outcome).map(file => {
    const { data, content } = readDeliverable(outcome, file)
    const base = typeof data.base === 'string' && data.base.length > 0 ? data.base : 'main'
    let diff: string
    try {
      const wt = data.worktree
      diff =
        typeof wt === 'string' && wt.length > 0
          ? git(wt, 'diff', '--no-color', `${base}...HEAD`)
          : '(no worktree recorded)'
    } catch (e) {
      diff = `(diff unavailable: ${e instanceof Error ? e.message : String(e)})`
    }
    return `## ${file}\n${content.trim()}\n\n### diff vs ${base}\n${diff}`
  })
  return sections.length > 0 ? sections.join('\n\n') : '(no deliverables produced)'
}
