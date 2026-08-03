// Test harness for the strapped workflow files.
//
// The workflow sources are NOT importable ES modules: they use ambient helpers
// (`args`, `agent`, `phase`, `workflow`, `parallel`, `pipeline`, `log`),
// top-level `await`, top-level `return`, and a single `export const meta`
// statement. This harness loads a workflow source unmodified except for
// rewriting `export const meta` → `const meta`, wraps the body in an
// AsyncFunction whose parameters are the ambient helpers, and injects
// recording stubs so tests can assert on every agent/workflow invocation.

import { readFileSync } from 'node:fs'

// The `Function` constructor typed to build the AsyncFunction the executor
// mirrors: seven string parameter names + a string body, yielding a variadic
// async function. Cast once here so the eval site stays fully typed.
const AsyncFunction = (async function () {}).constructor as new (
  ...names: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>

/** Options an agent dispatch may carry (mirrors the executor's `agent(prompt, opts)`). */
export interface AgentOpts {
  label?: string
  phase?: string
  effort?: string
  schema?: object
}

/** A stub for `agent(prompt, opts)`; may be sync or async, returns the agent result. */
export type AgentStub = (prompt: string, opts?: AgentOpts) => unknown

/** A stub for `workflow(ref, args)`; may be sync or async. */
export type WorkflowStub = (ref: unknown, args?: unknown) => unknown

/** A recorded `agent()` invocation. */
export interface AgentCall {
  kind: 'agent'
  prompt: string
  opts: AgentOpts | undefined
  result?: unknown
}

/** A recorded `workflow()` invocation. */
export interface WorkflowCall {
  kind: 'workflow'
  ref: unknown
  args: unknown
  result?: unknown
}

export type RecordedCall = AgentCall | WorkflowCall

export interface RunWorkflowOptions {
  /** The cfg object (or JSON string) exposed to the workflow body as `args`. */
  args?: unknown
  /** Stub for `agent(prompt, opts)`; defaults to throwing on any call. */
  agent?: AgentStub
  /** Stub for `workflow(ref, args)`; defaults to throwing on any call. */
  workflow?: WorkflowStub
}

export interface RunWorkflowResult<R> {
  result: R
  calls: RecordedCall[]
  phases: string[]
  logs: string[]
}

// --- Shapes the mono-workflow returns (the surface these tests assert on) ----

export interface Deliverable {
  id: string
  file: string
  title: string
  deps: string[]
}

export interface PlanStageResult {
  converged: boolean
  rounds: number
  deliverables: Deliverable[]
  outstanding: { id: string }[]
  summary?: string
}

export interface ImplementOutcome {
  id: string
  outcome: string
  parkedReason?: string | null
  roundsUsed?: number
}

export interface ImplementStageResult {
  allDone: boolean
  outcomes: ImplementOutcome[]
  blocked: { id: string; blockedOn: string[] }[]
}

export interface PrEntry {
  id: string
  url: string | null
  skipped: boolean
  reason: string | null
}

export interface PrStageResult {
  prs: PrEntry[]
  summary: string
  dryRun?: boolean
  gateFailed?: boolean
  notDone?: string[]
}

export interface FeedbackSynthStageResult {
  converged: boolean
  addenda: unknown[]
  summary: string
}

export interface StageResults {
  plan: PlanStageResult
  implement: ImplementStageResult
  pr: PrStageResult
  'feedback-synth': FeedbackSynthStageResult
}

export interface WorkflowResult {
  completed: string[]
  stoppedAt: string | null
  slug: string
  stages: string[]
  results: StageResults
}

/**
 * Run a workflow source file with injected ambient helpers.
 *
 * `calls` records every agent/workflow invocation in order. Rejections from the
 * workflow body propagate (for `assert.rejects`). `R` is the workflow's return
 * shape; it defaults to the mono-workflow's {@link WorkflowResult}.
 */
export async function runWorkflow<R = WorkflowResult>(
  file: string,
  { args = {}, agent, workflow }: RunWorkflowOptions = {}
): Promise<RunWorkflowResult<R>> {
  const src = readFileSync(file, 'utf8').replace(/^export const meta\b/m, 'const meta')
  const fn = new AsyncFunction('args', 'agent', 'phase', 'workflow', 'parallel', 'pipeline', 'log', src)

  const calls: RecordedCall[] = []
  const phases: string[] = []
  const logs: string[] = []

  const agentStub: AgentStub =
    agent ??
    ((prompt, opts) => {
      throw new Error(`unexpected agent call: ${opts?.label ?? prompt}`)
    })
  const workflowStub: WorkflowStub =
    workflow ??
    (ref => {
      throw new Error(`unexpected workflow call: ${JSON.stringify(ref)}`)
    })

  const recordedAgent = async (prompt: string, opts?: AgentOpts): Promise<unknown> => {
    const call: AgentCall = { kind: 'agent', prompt, opts }
    calls.push(call)
    call.result = await agentStub(prompt, opts)
    return call.result
  }

  const recordedWorkflow = async (ref: unknown, wfArgs?: unknown): Promise<unknown> => {
    const call: WorkflowCall = { kind: 'workflow', ref, args: wfArgs }
    calls.push(call)
    call.result = await workflowStub(ref, wfArgs)
    return call.result
  }

  // parallel(thunks) → Promise.all(thunks.map(t => t())) — thunks, not promises.
  const parallel = (thunks: Array<() => unknown>): Promise<unknown[]> =>
    Promise.all(thunks.map(t => t()))

  // pipeline(items, ...stages) → for each item concurrently, run the stages
  // sequentially, each stage receiving the previous stage's return value (the
  // first receives the item); returns the array of final results.
  const pipeline = (items: unknown[], ...stages: Array<(acc: unknown) => unknown>): Promise<unknown[]> =>
    Promise.all(
      items.map(async item => {
        let acc: unknown = item
        for (const stage of stages) acc = await stage(acc)
        return acc
      })
    )

  const result = (await fn(
    args,
    recordedAgent,
    (title: string) => phases.push(title),
    recordedWorkflow,
    parallel,
    pipeline,
    (msg: string) => logs.push(msg)
  )) as R
  return { result, calls, phases, logs }
}

/** A per-label handler: a fixed result value or a function producing one. */
export type LabelHandler = unknown | AgentStub

/** Agent stub that dispatches on `opts.label`; unknown labels throw. */
export function agentByLabel(handlers: Record<string, LabelHandler>): AgentStub {
  return (prompt, opts = {}) => {
    const label = opts.label
    const handler = label === undefined ? undefined : handlers[label]
    if (handler === undefined) throw new Error(`unexpected agent label: ${opts.label}`)
    return typeof handler === 'function' ? (handler as AgentStub)(prompt, opts) : handler
  }
}

/** All agent calls whose label starts with the given prefix. */
export function callsWithLabelPrefix(calls: RecordedCall[], prefix: string): AgentCall[] {
  return calls.filter(
    (c): c is AgentCall => c.kind === 'agent' && c.opts !== undefined && String(c.opts.label).startsWith(prefix)
  )
}

/** The single agent call with exactly this label; throws if absent or ambiguous. */
export function callWithLabel(calls: RecordedCall[], label: string): AgentCall {
  const matches = calls.filter(
    (c): c is AgentCall => c.kind === 'agent' && c.opts !== undefined && c.opts.label === label
  )
  const only = matches[0]
  if (matches.length !== 1 || only === undefined) {
    throw new Error(`expected 1 call labeled ${label}, saw ${matches.length}`)
  }
  return only
}
