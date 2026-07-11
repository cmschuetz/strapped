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

const AsyncFunction = (async () => {}).constructor

/**
 * Run a workflow source file with injected ambient helpers.
 *
 * @param {string} file absolute path to the workflow source
 * @param {object} [opts]
 * @param {*} [opts.args] the cfg object (or JSON string) exposed as `args`
 * @param {Function} [opts.agent] stub for `agent(prompt, opts)`; defaults to throwing
 * @param {Function} [opts.workflow] stub for `workflow(ref, args)`; defaults to throwing
 * @returns {Promise<{result: *, calls: Array, phases: string[], logs: string[]}>}
 *   `calls` records every agent/workflow invocation in order:
 *   `{ kind: 'agent', prompt, opts, result }` or `{ kind: 'workflow', ref, args, result }`.
 *   Rejections from the workflow body propagate (for `assert.rejects`).
 */
export async function runWorkflow(file, { args = {}, agent, workflow } = {}) {
  const src = readFileSync(file, 'utf8').replace(/^export const meta\b/m, 'const meta')
  const fn = new AsyncFunction('args', 'agent', 'phase', 'workflow', 'parallel', 'pipeline', 'log', src)

  const calls = []
  const phases = []
  const logs = []

  const agentStub =
    agent ||
    ((prompt, opts) => {
      throw new Error(`unexpected agent call: ${(opts && opts.label) || prompt}`)
    })
  const workflowStub =
    workflow ||
    (ref => {
      throw new Error(`unexpected workflow call: ${JSON.stringify(ref)}`)
    })

  const recordedAgent = async (prompt, opts) => {
    const call = { kind: 'agent', prompt, opts }
    calls.push(call)
    call.result = await agentStub(prompt, opts)
    return call.result
  }

  const recordedWorkflow = async (ref, wfArgs) => {
    const call = { kind: 'workflow', ref, args: wfArgs }
    calls.push(call)
    call.result = await workflowStub(ref, wfArgs)
    return call.result
  }

  // parallel(thunks) → Promise.all(thunks.map(t => t())) — thunks, not promises.
  const parallel = thunks => Promise.all(thunks.map(t => t()))

  // pipeline(items, ...stages) → for each item concurrently, run the stages
  // sequentially, each stage receiving the previous stage's return value (the
  // first receives the item); returns the array of final results.
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async item => {
        let acc = item
        for (const stage of stages) acc = await stage(acc)
        return acc
      })
    )

  const result = await fn(
    args,
    recordedAgent,
    title => phases.push(title),
    recordedWorkflow,
    parallel,
    pipeline,
    msg => logs.push(msg)
  )
  return { result, calls, phases, logs }
}

/** Agent stub that dispatches on `opts.label`; unknown labels throw. */
export function agentByLabel(handlers) {
  return (prompt, opts = {}) => {
    const handler = handlers[opts.label]
    if (!handler) throw new Error(`unexpected agent label: ${opts.label}`)
    return typeof handler === 'function' ? handler(prompt, opts) : handler
  }
}

/** All agent calls whose label starts with the given prefix. */
export function callsWithLabelPrefix(calls, prefix) {
  return calls.filter(c => c.kind === 'agent' && c.opts && String(c.opts.label).startsWith(prefix))
}

/** The single agent call with exactly this label; throws if absent or ambiguous. */
export function callWithLabel(calls, label) {
  const matches = calls.filter(c => c.kind === 'agent' && c.opts && c.opts.label === label)
  if (matches.length !== 1) throw new Error(`expected 1 call labeled ${label}, saw ${matches.length}`)
  return matches[0]
}
