// Scenario suite driver: run → grade → teardown, one scenario at a time.
// Scenarios run SEQUENTIALLY by design — each one is a heavy multi-agent
// workflow run (real dollars and minutes live), and the sync spawn boundary
// would serialize them anyway. Each scenario's sandbox is removed as soon as
// it is graded (unless `keepSandbox`), so a long suite never accumulates
// temp trees.

import { gradeScenario } from './grade.ts'
import { runScenario } from './executor.ts'
import { removeSandbox } from './sandbox.ts'
import type { Cache, Spawn } from '../types.ts'
import type { GradeResult } from '../grade.ts'
import type { AgentLedgerEntry, Scenario } from './types.ts'

/**
 * A ledger entry as reported: the prompt is STRIPPED (prompts are the bulk of
 * a report's bytes and the JSON report is the `--compare` input — metrics are
 * what compare needs).
 */
export type ScenarioLedgerRow = Omit<AgentLedgerEntry, 'prompt'>

/** One scenario's reportable row — plain data, fully JSON-serializable. */
export interface ScenarioReportRow {
  scenarioId: string
  stages: string[]
  /** Weighted-mean correctness in [0,1]. */
  correctness: number
  /** Weighted-mean adherence in [0,1]. */
  adherence: number
  /** Σ measured envelope cost over the agent ledger. */
  costUsd: number
  /**
   * Wall clock around the workflow run. SERIALIZED: the sync spawn boundary
   * degrades `parallel()`/`pipeline()` to sequential agent calls, so this is
   * the serialized sum — prefer `turns`/ledger api durations for time verdicts.
   */
  wallClockMs: number
  /** Σ numTurns over the agent ledger. */
  turns: number
  agentCalls: number
  /** Reserved: rows are only produced when the CLI probe found `claude`. */
  skipped: boolean
  /** The workflow throw's message, or null on a clean return. */
  error: string | null
  grades: { correctness: GradeResult[]; adherence: GradeResult[] }
  ledger: ScenarioLedgerRow[]
  /** The kept sandbox root (with `keepSandbox`), else null — the tree is gone. */
  sandbox: string | null
}

export interface RunScenariosOptions {
  /** Injected subprocess boundary; defaults to the real `claude` spawn. */
  spawn?: Spawn
  /** Response cache for judge graders (agent calls are never cached). */
  cache?: Cache
  /** Keep each scenario's sandbox on disk and report its path. */
  keepSandbox?: boolean
  /** Explicit deployable path; defaults to the repo's shipped strapped-run.js. */
  deployable?: string
}

/** Strip prompts off the ledger for the report row. */
function toLedgerRows(ledger: readonly AgentLedgerEntry[]): ScenarioLedgerRow[] {
  return ledger.map(({ prompt: _prompt, ...rest }) => rest)
}

/**
 * Run every scenario sequentially: execute against the real deployable, grade
 * both judged axes, lift the time/price axes off the ledger totals, then tear
 * the sandbox down (unless `keepSandbox`). Never throws for a failed scenario
 * — a workflow error is a graded row with `error` set.
 */
export async function runScenarios(
  scenarios: readonly Scenario[],
  opts: RunScenariosOptions = {}
): Promise<ScenarioReportRow[]> {
  const rows: ScenarioReportRow[] = []
  for (const scenario of scenarios) {
    const outcome = await runScenario(scenario, { spawn: opts.spawn, deployable: opts.deployable })
    try {
      const grade = gradeScenario(outcome, { spawn: opts.spawn, cache: opts.cache })
      rows.push({
        scenarioId: scenario.id,
        stages: [...scenario.stages],
        correctness: grade.correctness,
        adherence: grade.adherence,
        costUsd: outcome.totals.costUsd,
        wallClockMs: outcome.wallClockMs,
        turns: outcome.totals.turns,
        agentCalls: outcome.totals.agentCalls,
        skipped: false,
        error: outcome.error,
        grades: { correctness: grade.correctnessGrades, adherence: grade.adherenceGrades },
        ledger: toLedgerRows(outcome.ledger),
        sandbox: opts.keepSandbox === true ? outcome.sandbox.root : null,
      })
    } finally {
      if (opts.keepSandbox !== true) removeSandbox(outcome.sandbox)
    }
  }
  return rows
}
