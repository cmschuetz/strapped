// Scenario graders: the four-axis verdict layer over a ScenarioOutcome.
//   - correctness: did the run produce good code/artifacts? Built-ins:
//     `commandGrader` (shell command in a sandbox path, pass on exit 0),
//     `artifactAssert` (pure predicate), `scenarioJudge` (the existing LLM
//     `judge()` over rendered scenario evidence, routed through ctx spawn/cache
//     so tests stay hermetic).
//   - adherence: did the run follow the workflow's OWN rules? A deterministic
//     check suite over the sandbox state root (`adherenceGraders()`),
//     parameterized by `Scenario.expect`. Checks that don't apply to the
//     scenario's stage subset are neutral (pass, detail "n/a", weight 0).
// Time and price need no graders — they are read straight off the outcome's
// ledger totals by the report layer.
//
// Verdicts reuse the prompt-eval `GradeResult` shape and the `gradeCase`
// weighted-mean rule; like the prompt-eval graders, scenario graders NEVER
// throw — a thrown predicate/command/render grades as a fail.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFrontmatterFile, type Die, type Frontmatter } from '../../lib/frontmatter.ts'
import { judge, type GradeContext, type GradeResult } from '../grade.ts'
import type { EvalResult } from '../types.ts'
import type { ScenarioOutcome } from './types.ts'

/** A scenario grader: inspect one scenario outcome, return a verdict. */
export type ScenarioGrader = (outcome: ScenarioOutcome, ctx: GradeContext) => GradeResult

// --- sandbox-path tokens ------------------------------------------------------

/**
 * The minimal token set a `commandGrader` cwd/command may carry (single-brace —
 * distinct from the sandbox BUILD-time `{{...}}` tokens, these resolve at
 * GRADE time against the built sandbox):
 *   {sandboxRoot}      — the mkdtemp root
 *   {stateRoot}        — <sandbox>/state
 *   {runDir}           — <stateRoot>/runs/<slug>
 *   {repoRoot}         — the FIRST fixture repo's root
 *   {repoRoot:<name>}  — a named fixture repo's root
 *   {worktree:<Did>}   — the deliverable's frontmatter `worktree` (its branch checkout)
 * An unknown token or a null/missing worktree resolves to a thrown Error,
 * which the calling grader turns into a failed verdict.
 */
export function resolveSandboxTokens(text: string, outcome: ScenarioOutcome): string {
  return text.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const { sandbox } = outcome
    if (name === 'sandboxRoot') return sandbox.root
    if (name === 'stateRoot') return sandbox.stateRoot
    if (name === 'runDir') return sandbox.runDir
    if (name === 'repoRoot') {
      const first = sandbox.repos[0]
      if (first === undefined) throw new Error('{repoRoot}: scenario has no repos')
      return first.root
    }
    const named = /^repoRoot:(.+)$/.exec(name)
    if (named !== null) {
      const repo = sandbox.repos.find(r => r.name === named[1])
      if (repo === undefined) throw new Error(`{${name}}: no sandbox repo named "${named[1]}"`)
      return repo.root
    }
    const worktree = /^worktree:(.+)$/.exec(name)
    if (worktree !== null) return deliverableWorktree(outcome, worktree[1] ?? '')
    throw new Error(`unknown sandbox token {${name}}`)
  })
}

/** Resolve `{worktree:<Did>}`: the deliverable file's frontmatter `worktree`. */
function deliverableWorktree(outcome: ScenarioOutcome, id: string): string {
  const file = deliverableFiles(outcome.sandbox.runDir).find(f => f.startsWith(`${id}-`))
  if (file === undefined) throw new Error(`{worktree:${id}}: no deliverable file ${id}-*.md in runDir`)
  const { data } = readFrontmatter(join(outcome.sandbox.runDir, 'deliverables', file))
  const worktree = data.worktree
  if (typeof worktree !== 'string' || worktree.length === 0) {
    throw new Error(`{worktree:${id}}: deliverable ${file} has no worktree path (found ${JSON.stringify(worktree ?? null)})`)
  }
  return worktree
}

// --- correctness built-ins ----------------------------------------------------

/** Last few lines of a command's combined output, for the verdict detail. */
function outputTail(stdout: string | null, stderr: string | null): string {
  const combined = `${stdout ?? ''}${stderr ?? ''}`.trim()
  if (combined === '') return '(no output)'
  return combined.split('\n').slice(-5).join('\n').slice(-500)
}

export interface CommandGraderOptions {
  /** Working directory; supports sandbox tokens. Defaults to `{sandboxRoot}`. */
  cwd?: string
  /** Kill the command after this many ms (default 5 min). */
  timeoutMs?: number
  weight?: number
}

/**
 * Run a shell command against the sandbox (synchronous, like the engine) and
 * pass on exit 0. Both the command and the cwd support the sandbox tokens
 * documented on `resolveSandboxTokens` — e.g.
 * `commandGrader('tests-green', 'bun test', { cwd: '{worktree:D1}' })`.
 * A spawn failure, timeout, or token error grades as a fail, never a throw.
 */
export function commandGrader(name: string, cmd: string, opts: CommandGraderOptions = {}): ScenarioGrader {
  return outcome => {
    try {
      const command = resolveSandboxTokens(cmd, outcome)
      const cwd = resolveSandboxTokens(opts.cwd ?? '{sandboxRoot}', outcome)
      const res = spawnSync(command, { shell: true, cwd, encoding: 'utf8', timeout: opts.timeoutMs ?? 5 * 60_000 })
      if (res.error) {
        return { name, pass: false, score: 0, detail: `spawn failed: ${res.error.message}`, weight: opts.weight }
      }
      const tail = outputTail(res.stdout, res.stderr)
      const pass = res.status === 0
      return {
        name,
        pass,
        score: pass ? 1 : 0,
        detail: pass ? tail : `exit ${res.status ?? 'null'}: ${tail}`,
        weight: opts.weight,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { name, pass: false, score: 0, detail: `command grader threw: ${msg}`, weight: opts.weight }
    }
  }
}

/**
 * Assertion grader over the whole outcome — throw-safe like the prompt-eval
 * `assert`: a `false` return fails, a thrown predicate fails with the message.
 */
export function artifactAssert(
  name: string,
  predicate: (outcome: ScenarioOutcome) => boolean,
  opts: { weight?: number } = {}
): ScenarioGrader {
  return outcome => {
    try {
      const pass = predicate(outcome)
      return { name, pass, score: pass ? 1 : 0, detail: pass ? 'assertion passed' : 'assertion failed', weight: opts.weight }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { name, pass: false, score: 0, detail: `assertion threw: ${msg}`, weight: opts.weight }
    }
  }
}

/** Inert EvalResult the judge is handed (it only reads the parsed output). */
const EVIDENCE_RESULT: EvalResult = {
  ok: true,
  output: null,
  error: null,
  cost: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  durationMs: 0,
  apiDurationMs: 0,
  numTurns: 0,
  model: '',
  cached: false,
}

export interface ScenarioJudgeOptions {
  /** Model the judge itself runs on. */
  model: string
  /**
   * Render the scenario evidence placed under evaluation — e.g. read produced
   * diffs (`git -C {repoRoot} log --stat` output), deliverable bodies, or the
   * run dir. Defaults to a JSON view of the RunResult + error + logs. A thrown
   * render grades as a fail.
   */
  render?: (outcome: ScenarioOutcome) => string
  /** Grader name in the report (default `scenarioJudge`). */
  name?: string
  weight?: number
}

/**
 * LLM-judge over scenario evidence: reuses the prompt-eval `judge()` verbatim
 * — the rendered evidence becomes the output-under-evaluation, and the judge
 * call routes through ctx spawn/cache, so tests stay hermetic.
 */
export function scenarioJudge(rubric: string, opts: ScenarioJudgeOptions): ScenarioGrader {
  const name = opts.name ?? 'scenarioJudge'
  return (outcome, ctx) => {
    let evidence: string
    try {
      evidence = opts.render
        ? opts.render(outcome)
        : JSON.stringify({ runResult: outcome.runResult, error: outcome.error, logs: outcome.logs }, null, 2)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { name, pass: false, score: 0, detail: `evidence render threw: ${msg}`, weight: opts.weight }
    }
    return judge(rubric, { model: opts.model, name, weight: opts.weight })(evidence, EVIDENCE_RESULT, ctx)
  }
}

// --- adherence suite ------------------------------------------------------------

/** Neutral verdict for a check that doesn't apply to the scenario's stage subset. */
function na(name: string, why: string): GradeResult {
  return { name, pass: true, score: 1, detail: `n/a — ${why}`, weight: 0 }
}

function pass(name: string, detail: string): GradeResult {
  return { name, pass: true, score: 1, detail }
}

function fail(name: string, detail: string): GradeResult {
  return { name, pass: false, score: 0, detail }
}

/** Wrap a check so an unexpected throw grades as a fail, never a suite crash. */
function check(name: string, body: (outcome: ScenarioOutcome) => GradeResult): ScenarioGrader {
  return outcome => {
    try {
      return body(outcome)
    } catch (e) {
      return fail(name, `check threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** `readFrontmatterFile` die → throw, so a parse error surfaces as a fail. */
const throwDie: Die = msg => {
  throw new Error(msg)
}

function readFrontmatter(file: string): { data: Frontmatter; content: string } {
  return readFrontmatterFile(file, throwDie)
}

/** Sorted deliverable file basenames under `<runDir>/deliverables/`. */
function deliverableFiles(runDir: string): string[] {
  const dir = join(runDir, 'deliverables')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
}

/** Frontmatter of every deliverable file, or a thrown parse error. */
function readDeliverables(runDir: string): Array<{ file: string; data: Frontmatter }> {
  return deliverableFiles(runDir).map(file => ({
    file,
    data: readFrontmatter(join(runDir, 'deliverables', file)).data,
  }))
}

/** The manifest's forward-only status ladder (mirrors state.mjs). */
const MANIFEST_LADDER: readonly string[] = ['draft', 'in-review', 'approved', 'implementing', 'complete']

/** Legal on-disk deliverable statuses (conventions.md lifecycle). */
const DELIVERABLE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'ready',
  'in-progress',
  'implemented',
  'in-review',
  'fixing',
  'done',
  'parked',
  'pr-open',
  'merged',
])

/** Deliverable frontmatter fields every file must carry. */
const REQUIRED_DELIVERABLE_FIELDS: readonly string[] = ['id', 'title', 'deps', 'repo', 'status', 'branch', 'base']

/** Stages whose runs flip statuses on disk (and therefore must auto-commit). */
const TRANSITIONING_STAGES: ReadonlySet<string> = new Set(['plan', 'implement', 'pr'])

/** Do the scenario's stages produce/require deliverable files at all? */
function expectsDeliverables(outcome: ScenarioOutcome): boolean {
  return outcome.scenario.stages.includes('plan')
}

/**
 * Deliverable-scoped check scaffold: n/a when no deliverable files exist AND
 * no stage was supposed to produce them; a hard fail when `plan` ran but left
 * no deliverables behind.
 */
function overDeliverables(
  name: string,
  body: (outcome: ScenarioOutcome, deliverables: Array<{ file: string; data: Frontmatter }>) => GradeResult
): ScenarioGrader {
  return check(name, outcome => {
    const files = deliverableFiles(outcome.sandbox.runDir)
    if (files.length === 0) {
      if (expectsDeliverables(outcome)) return fail(name, 'plan ran but produced no deliverable files')
      return na(name, 'no deliverable files and no stage that produces them')
    }
    return body(outcome, readDeliverables(outcome.sandbox.runDir))
  })
}

/** manifest.md exists, parses, has a legal status ≥ the expected rung. */
export const checkManifest: ScenarioGrader = check('adherence:manifest', outcome => {
  const name = 'adherence:manifest'
  const file = join(outcome.sandbox.runDir, 'manifest.md')
  if (!existsSync(file)) return fail(name, 'no manifest.md in runDir')
  const { data } = readFrontmatter(file)
  const status = typeof data.status === 'string' ? data.status : ''
  const idx = MANIFEST_LADDER.indexOf(status)
  if (idx === -1) return fail(name, `manifest status "${status}" is not on the ladder ${MANIFEST_LADDER.join(' → ')}`)
  const expected = outcome.scenario.expect?.manifestStatus
  if (expected !== undefined) {
    const expectedIdx = MANIFEST_LADDER.indexOf(expected)
    if (expectedIdx === -1) return fail(name, `expected manifest status "${expected}" is not on the ladder`)
    if (idx < expectedIdx) return fail(name, `manifest status "${status}" below expected "${expected}"`)
  }
  return pass(name, `manifest status "${status}"${expected === undefined ? '' : ` ≥ "${expected}"`}`)
})

/** Every deliverable file parses with the required fields and a legal status. */
export const checkDeliverableFrontmatter: ScenarioGrader = overDeliverables(
  'adherence:deliverable-frontmatter',
  (_outcome, deliverables) => {
    const name = 'adherence:deliverable-frontmatter'
    const problems: string[] = []
    for (const { file, data } of deliverables) {
      for (const field of REQUIRED_DELIVERABLE_FIELDS) {
        if (!(field in data)) problems.push(`${file}: missing "${field}"`)
      }
      const status = typeof data.status === 'string' ? data.status : String(data.status ?? '')
      if ('status' in data && !DELIVERABLE_STATUSES.has(status)) problems.push(`${file}: illegal status "${status}"`)
    }
    if (problems.length > 0) return fail(name, problems.join('; '))
    return pass(name, `${deliverables.length} deliverable file(s) well-formed`)
  }
)

/** Every deliverable branch matches `strapped/<slug>/D#-<kebab>`. */
export const checkBranchNames: ScenarioGrader = overDeliverables('adherence:branch-names', (outcome, deliverables) => {
  const name = 'adherence:branch-names'
  const pattern = new RegExp(`^strapped/${outcome.sandbox.slug}/D\\d+-[a-z0-9][a-z0-9-]*$`)
  const bad = deliverables
    .filter(({ data }) => typeof data.branch !== 'string' || !pattern.test(data.branch))
    .map(({ file, data }) => `${file}: "${String(data.branch ?? '')}"`)
  if (bad.length > 0) return fail(name, `branch not strapped/${outcome.sandbox.slug}/D#-<kebab>: ${bad.join('; ')}`)
  return pass(name, `${deliverables.length} branch name(s) well-formed`)
})

/** Every declared dep names an existing deliverable id — no dangling edges. */
export const checkDeps: ScenarioGrader = overDeliverables('adherence:deps', (_outcome, deliverables) => {
  const name = 'adherence:deps'
  const ids = new Set(deliverables.map(({ data }) => String(data.id ?? '')))
  const dangling: string[] = []
  for (const { file, data } of deliverables) {
    const deps = Array.isArray(data.deps) ? data.deps : []
    for (const dep of deps) {
      if (!ids.has(String(dep))) dangling.push(`${file}: dep "${String(dep)}"`)
    }
  }
  if (dangling.length > 0) return fail(name, `dangling deps: ${dangling.join('; ')}`)
  return pass(name, 'all deps resolve to existing deliverables')
})

/** `reviews/plan-round-1.md` exists when the plan stage ran a review round. */
export const checkPlanReviewRecords: ScenarioGrader = check('adherence:plan-review-records', outcome => {
  const name = 'adherence:plan-review-records'
  if (!outcome.scenario.stages.includes('plan')) return na(name, 'plan stage not run')
  if (outcome.scenario.planRounds < 1) return na(name, 'planRounds is 0')
  const file = join(outcome.sandbox.runDir, 'reviews', 'plan-round-1.md')
  if (!existsSync(file)) return fail(name, 'no reviews/plan-round-1.md after the plan stage ran')
  return pass(name, 'plan-round-1.md present')
})

/** At least one `<Did>-code-round-*.md` exists when implement ran a review round. */
export const checkCodeReviewRecords: ScenarioGrader = check('adherence:code-review-records', outcome => {
  const name = 'adherence:code-review-records'
  if (!outcome.scenario.stages.includes('implement')) return na(name, 'implement stage not run')
  if (outcome.scenario.codeRounds < 1) return na(name, 'codeRounds is 0')
  const dir = join(outcome.sandbox.runDir, 'reviews')
  const records = existsSync(dir) ? readdirSync(dir).filter(f => /-code-round-.*\.md$/.test(f)) : []
  if (records.length === 0) return fail(name, 'no reviews/<Did>-code-round-*.md after the implement stage ran')
  return pass(name, `${records.length} code-round record(s) present`)
})

/**
 * State-root commit cadence: the state root must still be a git repo (D1's
 * `buildSandbox` git-inits it with one seed commit; without `.git` the
 * `state.mjs` transition auto-commit SILENTLY skips), and when a
 * status-transitioning stage ran (plan/implement/pr) there must be ≥1 commit
 * BEYOND the recorded seed commit — compared against the seed SHA, not a bare
 * count, so a scenario's own seeding never satisfies the check.
 */
export const checkStateCommits: ScenarioGrader = check('adherence:state-commits', outcome => {
  const name = 'adherence:state-commits'
  const { stateRoot, stateSeedCommit } = outcome.sandbox
  if (!existsSync(join(stateRoot, '.git'))) {
    return fail(name, 'state root has no .git — transition auto-commits silently skipped')
  }
  const transitioned = outcome.scenario.stages.some(s => TRANSITIONING_STAGES.has(s))
  if (!transitioned) return na(name, 'no status-transitioning stage ran (commit cadence not exercised)')
  const res = spawnSync('git', ['-C', stateRoot, 'rev-list', '--count', `${stateSeedCommit}..HEAD`], {
    encoding: 'utf8',
  })
  if (res.error || res.status !== 0) {
    return fail(name, `cannot count commits beyond the seed: ${res.error?.message ?? res.stderr.trim()}`)
  }
  const beyond = Number(res.stdout.trim())
  if (!(beyond > 0)) return fail(name, 'no state-root commit beyond the sandbox seed commit')
  return pass(name, `${beyond} commit(s) beyond the seed`)
})

/** RunResult shape the run-result check reads. */
interface RunResultView {
  completed?: unknown
  stoppedAt?: unknown
}

/** `runResult.completed` / `stoppedAt` equal `Scenario.expect` when given. */
export const checkRunResult: ScenarioGrader = check('adherence:run-result', outcome => {
  const name = 'adherence:run-result'
  const expect = outcome.scenario.expect
  const wantsCompleted = expect?.completed !== undefined
  const wantsStoppedAt = expect !== undefined && 'stoppedAt' in expect
  if (!wantsCompleted && !wantsStoppedAt) return na(name, 'no completed/stoppedAt expectation declared')
  if (outcome.runResult === null || typeof outcome.runResult !== 'object') {
    return fail(name, `no RunResult to compare (workflow error: ${outcome.error ?? 'none'})`)
  }
  const run = outcome.runResult as RunResultView
  const problems: string[] = []
  if (wantsCompleted && JSON.stringify(run.completed) !== JSON.stringify(expect.completed)) {
    problems.push(`completed ${JSON.stringify(run.completed)} ≠ expected ${JSON.stringify(expect.completed)}`)
  }
  if (wantsStoppedAt && run.stoppedAt !== expect.stoppedAt) {
    problems.push(`stoppedAt ${JSON.stringify(run.stoppedAt)} ≠ expected ${JSON.stringify(expect.stoppedAt)}`)
  }
  if (problems.length > 0) return fail(name, problems.join('; '))
  return pass(name, 'RunResult matches the declared expectation')
})

/**
 * The built-in deterministic adherence suite — what `gradeScenario` uses when
 * a scenario declares no `adherence` graders of its own.
 */
export function adherenceGraders(): ScenarioGrader[] {
  return [
    checkManifest,
    checkDeliverableFrontmatter,
    checkBranchNames,
    checkDeps,
    checkPlanReviewRecords,
    checkCodeReviewRecords,
    checkStateCommits,
    checkRunResult,
  ]
}

// --- aggregation ----------------------------------------------------------------

/** Both graded axes plus the individual verdicts behind each. */
export interface ScenarioGrade {
  /** Weighted-mean correctness in [0,1]; empty grader set ⇒ 0. */
  correctness: number
  correctnessGrades: GradeResult[]
  /** Weighted-mean adherence in [0,1]; n/a checks carry weight 0. */
  adherence: number
  adherenceGrades: GradeResult[]
}

/** The `gradeCase` weighted-mean rule: Σ(weight·score)/Σweight, empty ⇒ 0. */
function weightedMean(grades: readonly GradeResult[]): number {
  let weightedSum = 0
  let totalWeight = 0
  for (const grade of grades) {
    const weight = grade.weight ?? 1
    weightedSum += weight * grade.score
    totalWeight += weight
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0
}

/** Run one grader throw-safely (a custom grader may not honor the never-throw rule). */
function runGrader(grader: ScenarioGrader, outcome: ScenarioOutcome, ctx: GradeContext): GradeResult {
  try {
    return grader(outcome, ctx)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { name: 'grader', pass: false, score: 0, detail: `grader threw: ${msg}` }
  }
}

/**
 * Grade one scenario outcome on both judged axes: the scenario's `correctness`
 * graders and its `adherence` graders (built-in suite when undeclared), each
 * aggregated by the `gradeCase` weighted-mean rule.
 */
export function gradeScenario(outcome: ScenarioOutcome, ctx: GradeContext = {}): ScenarioGrade {
  const correctnessGrades = outcome.scenario.correctness.map(g => runGrader(g, outcome, ctx))
  const adherenceSuite = outcome.scenario.adherence ?? adherenceGraders()
  const adherenceGrades = adherenceSuite.map(g => runGrader(g, outcome, ctx))
  return {
    correctness: weightedMean(correctnessGrades),
    correctnessGrades,
    adherence: weightedMean(adherenceGrades),
    adherenceGrades,
  }
}
