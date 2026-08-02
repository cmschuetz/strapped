// Types for scenario (full-workflow) evals: a Scenario describes a sandboxed
// synthetic repo + ask + stage subset; the executor runs the REAL shipped
// deployable `plugins/strapped/workflows/strapped-run.js` against it, lowering
// every `agent()` call into a `claude -p` run through the eval engine, and
// returns a ScenarioOutcome with a per-agent cost/latency/turns ledger.

import type { EvalUsage } from '../types.ts'

/** One review rule fed to the workflow's seeded rule-partition machinery. */
export interface ScenarioRule {
  id: string
  source: string
  text: string
}

/**
 * A fixture repo the sandbox materializes. Two tiers: `files` (synthetic —
 * declarative path → content map) and/or `snapshotPath` (heavy — absolute path
 * to a real repo snapshot recursively copied into the sandbox, with `files`
 * applied as an overlay when both are present). At least one is required.
 */
export interface ScenarioRepo {
  name: string
  /** Declarative file map, path (repo-relative) → content. Contents support sandbox tokens. */
  files?: Record<string, string>
  /** Absolute path to a real repo snapshot copied into the sandbox at build time. */
  snapshotPath?: string
  /** Validation commands recorded in the repo's state config.json. */
  validations: string[]
}

/**
 * Extra stage args a scenario may pass through to the workflow config.
 * Deliberately NARROW: `pr` args are not expressible here — the executor
 * always forces `pr: { dryRun: true }`, so a scenario spec can never cause
 * the pr stage to push or open real PRs.
 */
export interface ScenarioStageArgs {
  implement?: Record<string, unknown>
}

/** One self-contained end-to-end workflow evaluation unit. */
export interface Scenario {
  id: string
  tags: string[]
  /** Ordered stage subset dispatched natively via the workflow's `args.stages`. */
  stages: string[]
  /** The synthetic ask, written to `<sandbox>/plans/<slug>.md` as the source plan. */
  ask: string
  repos: ScenarioRepo[]
  /**
   * Declarative run-state seed for stage-scoped scenarios (e.g. implement-only):
   * paths relative to the runDir, contents support sandbox tokens.
   */
  seedRunState?: { files: Record<string, string> }
  rules: ScenarioRule[]
  seed: number
  planRounds: number
  codeRounds: number
  confidenceMin: number
  /** Default model for every agent call; DEFAULT_MODEL when omitted. */
  model?: string
  /** Per-agent-label model override, keyed by the workflow's `opts.label`. */
  modelByLabel?: Record<string, string>
  /** Per-agent spawn timeout; defaults to 20 minutes. */
  agentTimeoutMs?: number
  stageArgs?: ScenarioStageArgs
}

/** A sandbox repo's resolved absolute paths. */
export interface ScenarioSandboxRepo {
  name: string
  /** Absolute repo root inside the sandbox. */
  root: string
  /** Absolute path of the repo's state config.json (`<stateRoot>/repos/<name>/config.json`). */
  configPath: string
  /** Absolute worktree root (`<sandbox>/worktrees/<name>__worktrees`). */
  worktreeRoot: string
}

/** Absolute paths of a built scenario sandbox. Everything lives under `root`. */
export interface ScenarioSandbox {
  /** The mkdtemp root; `removeSandbox` deletes this whole tree. */
  root: string
  /** Run slug (the scenario id, kebab-cased). */
  slug: string
  /** Git-initialized state root (`<root>/state`) — exported to agents via $STRAPPED_STATE_ROOT. */
  stateRoot: string
  /** The scaffolded run dir (`<stateRoot>/runs/<slug>`). */
  runDir: string
  /** The source plan file carrying the scenario ask (`<root>/plans/<slug>.md`). */
  sourcePlan: string
  repos: ScenarioSandboxRepo[]
  /**
   * The state root's seed-commit SHA. Adherence checks count the transition
   * auto-commits `state.mjs` produces BEYOND this commit.
   */
  stateSeedCommit: string
}

/** One agent call's metrics, lifted from its engine result. */
export interface AgentLedgerEntry {
  label: string
  prompt?: string
  model: string
  ok: boolean
  error: string | null
  cost: number
  usage: EvalUsage
  durationMs: number
  apiDurationMs: number
  numTurns: number
}

/** Ledger sums for the whole scenario run. */
export interface ScenarioTotals {
  costUsd: number
  turns: number
  agentCalls: number
  durationMs: number
  apiDurationMs: number
}

/** The graded outcome of one scenario run. A workflow throw lands in `error`. */
export interface ScenarioOutcome {
  scenario: Scenario
  /** Sandbox paths — NOT torn down by the executor; callers grade, then call `removeSandbox`. */
  sandbox: ScenarioSandbox
  /** The mono-workflow's RunResult (`completed`/`stoppedAt`/`results`), or null when it threw. */
  runResult: unknown | null
  /** The workflow throw's message, or null on a clean return. */
  error: string | null
  ledger: AgentLedgerEntry[]
  /**
   * Wall clock around the workflow invocation. KNOWN LIMITATION (accepted for
   * v1): `runClaude` is spawnSync-based, so each agent call blocks the event
   * loop and the workflow's `parallel()`/`pipeline()` degrade to fully serial
   * execution — this is the SERIALIZED SUM of agent calls, not the real
   * workflow's parallel shape. Time verdicts should lean on Σturns /
   * ΣapiDurationMs instead; an async spawn path is future work.
   */
  wallClockMs: number
  totals: ScenarioTotals
  /** `phase(title)` calls recorded in dispatch order. */
  phases: string[]
  /** `log(msg)` calls recorded in dispatch order. */
  logs: string[]
}
