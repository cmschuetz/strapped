// Scenario executor: run the REAL shipped deployable
// plugins/strapped/workflows/strapped-run.js in-process against a throwaway
// sandbox, lowering every workflow `agent()` call into a `claude -p` run
// through the eval engine — tools enabled, cwd pinned to the sandbox — while
// recording a per-agent cost/latency/turns ledger. The deterministic
// orchestration stays real (the actual deployable executes); the ONE fakeable
// boundary remains `Spawn`, so scenario tests script canned envelopes and stay
// fully offline.

import { join } from 'node:path'
import { runClaude } from '../engine.ts'
import { DEFAULT_MODEL } from '../runner.ts'
import type { EvalRequest, JsonSchema, Spawn } from '../types.ts'
import { loadWorkflow, pluginDirFor, resolveDeployable, type WorkflowAgentOpts } from './loader.ts'
import { splitRules } from './rules.ts'
import { buildSandbox } from './sandbox.ts'
import type { AgentLedgerEntry, Scenario, ScenarioOutcome, ScenarioSandbox } from './types.ts'

/** The real toolset every scenario agent runs with (fidelity to live subagents). */
export const SCENARIO_AGENT_TOOLS: readonly string[] = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'TodoWrite',
]

/**
 * The agent label also travels on the child env. It is inert for the real CLI
 * (a stray env var), useful when inspecting live child processes, and it is
 * the key the scripted per-label fake spawn dispatches its envelope queues on.
 */
export const AGENT_LABEL_ENV = 'STRAPPED_AGENT_LABEL'

/** Generous per-agent default so a wedged agent cannot hang the suite. */
export const DEFAULT_AGENT_TIMEOUT_MS = 20 * 60_000

export interface RunScenarioOptions {
  /** Injected subprocess boundary; defaults to the real `claude` spawn. */
  spawn?: Spawn
  /** Explicit deployable path; defaults to the repo's shipped strapped-run.js. */
  deployable?: string
}

/**
 * Run one scenario end-to-end. Contract: the sandbox is NOT torn down here —
 * the outcome carries its paths so callers can grade artifacts on disk first,
 * then call `removeSandbox(outcome.sandbox)` themselves. A workflow throw is
 * captured on `outcome.error` (a failed scenario is a graded outcome, not a
 * suite crash). Agent results are NEVER cached: agents have side effects on
 * the sandbox, so a cache hit would be wrong.
 */
export async function runScenario(scenario: Scenario, opts: RunScenarioOptions = {}): Promise<ScenarioOutcome> {
  const deployable = resolveDeployable(opts.deployable)
  const pluginDir = pluginDirFor(deployable)
  const sandbox = buildSandbox(scenario)
  const ledger: AgentLedgerEntry[] = []
  const phases: string[] = []
  const logs: string[] = []

  const workflow = loadWorkflow(deployable)
  const helpers = {
    args: composeArgs(scenario, sandbox, pluginDir),
    agent: makeAgent(scenario, sandbox, ledger, opts.spawn),
    phase: (title: string) => {
      phases.push(title)
    },
    // The mono-workflow never dispatches nested workflows — a call is a bug.
    workflow: (ref: unknown): Promise<unknown> => {
      throw new Error(`unexpected workflow() call in scenario "${scenario.id}": ${JSON.stringify(ref)}`)
    },
    // parallel(thunks) → Promise.all(thunks.map(t => t())) — same semantics as
    // the executor contract. NOTE: with the spawnSync-based engine each agent
    // call blocks the event loop, so these degrade to serial execution (see
    // ScenarioOutcome.wallClockMs).
    parallel: (thunks: ReadonlyArray<() => unknown>): Promise<unknown[]> => Promise.all(thunks.map(t => t())),
    // pipeline(items, ...stages) → per-item sequential stage chain, concurrent
    // across items.
    pipeline: (items: readonly unknown[], ...stages: Array<(acc: unknown) => unknown>): Promise<unknown[]> =>
      Promise.all(
        items.map(async item => {
          let acc: unknown = item
          for (const stage of stages) acc = await stage(acc)
          return acc
        })
      ),
    log: (msg: string) => {
      logs.push(msg)
    },
  }

  let runResult: unknown | null = null
  let error: string | null = null
  const started = Date.now()
  try {
    runResult = await workflow(helpers)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const wallClockMs = Date.now() - started

  const totals = {
    costUsd: ledger.reduce((sum, e) => sum + e.cost, 0),
    turns: ledger.reduce((sum, e) => sum + e.numTurns, 0),
    agentCalls: ledger.length,
    durationMs: ledger.reduce((sum, e) => sum + e.durationMs, 0),
    apiDurationMs: ledger.reduce((sum, e) => sum + e.apiDurationMs, 0),
  }

  return { scenario, sandbox, runResult, error, ledger, wallClockMs, totals, phases, logs }
}

/**
 * Compose the mono-workflow's `args` for a scenario, mirroring the skills'
 * dispatch shape: `rulesByRound` carries id-only partitions with an entry per
 * round up to Math.max(planRounds, codeRounds) — BOTH review loops index it by
 * round number, so a scenario with `codeRounds > planRounds` must still find
 * an entry for every code-review round — and `rulesFile` names the sandbox's
 * materialized rules snapshot (the single source of rule TEXT, which review
 * agents Read). The pr stage is ALWAYS forced `dryRun: true` — a scenario can
 * never push or open real PRs.
 */
function composeArgs(scenario: Scenario, sandbox: ScenarioSandbox, pluginDir: string): Record<string, unknown> {
  const maxRounds = Math.max(scenario.planRounds, scenario.codeRounds)
  return {
    slug: sandbox.slug,
    dir: sandbox.runDir,
    conventionsFile: join(pluginDir, 'conventions.md'),
    scripts: {
      state: join(pluginDir, 'scripts', 'state.mjs'),
      worktree: join(pluginDir, 'scripts', 'ensure-worktree.sh'),
    },
    seed: scenario.seed,
    confidenceMin: scenario.confidenceMin,
    planRounds: scenario.planRounds,
    codeRounds: scenario.codeRounds,
    rulesByRound: splitRules(scenario.rules, scenario.seed, maxRounds),
    rulesFile: join(sandbox.runDir, 'reviews', 'rules-snapshot.md'),
    stages: scenario.stages,
    stageArgs: {
      plan: {
        sourcePlan: sandbox.sourcePlan,
        repos: sandbox.repos.map(r => ({ name: r.name, root: r.root })),
      },
      implement: scenario.stageArgs?.implement ?? {},
      pr: { dryRun: true },
    },
  }
}

/**
 * The injected `agent()`: lower one workflow agent call into an engine run.
 * Every spawn carries `env.STRAPPED_STATE_ROOT = <sandbox>/state` — the
 * implement/pr stages tell agents to run `node <state.mjs> resolve <slug>`,
 * which resolves via $STRAPPED_STATE_ROOT → the ~/.claude anchor and NEVER via
 * the workflow's `dir`; without it a live agent would resolve the user's REAL
 * state root (garbage grades at best, a sandbox escape on slug collision).
 * An `ok:false` engine result returns `null` into the workflow (its own error
 * paths engage, per the globals.d.ts contract) and still lands in the ledger.
 */
function makeAgent(
  scenario: Scenario,
  sandbox: ScenarioSandbox,
  ledger: AgentLedgerEntry[],
  spawn: Spawn | undefined
): (prompt: string, opts?: WorkflowAgentOpts) => Promise<unknown> {
  return async (prompt: string, opts: WorkflowAgentOpts = {}): Promise<unknown> => {
    const label = opts.label ?? '(unlabeled)'
    const model = scenario.modelByLabel?.[label] ?? scenario.model ?? DEFAULT_MODEL
    const req: EvalRequest = {
      prompt,
      model,
      schema: (opts.schema ?? {}) as JsonSchema,
      tools: [...SCENARIO_AGENT_TOOLS],
      cwd: sandbox.root,
      addDirs: [sandbox.root],
      permissionMode: 'bypassPermissions',
      env: { STRAPPED_STATE_ROOT: sandbox.stateRoot, [AGENT_LABEL_ENV]: label },
      timeoutMs: scenario.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    }
    const result = runClaude(req, spawn === undefined ? {} : { spawn })
    ledger.push({
      label,
      prompt,
      model,
      ok: result.ok,
      error: result.error,
      cost: result.cost,
      usage: result.usage,
      durationMs: result.durationMs,
      apiDurationMs: result.apiDurationMs,
      numTurns: result.numTurns,
    })
    return result.ok ? result.output : null
  }
}
