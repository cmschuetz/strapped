// Deployable workflow loader for scenario runs. The shipped workflow file
// (plugins/strapped/workflows/strapped-run.js) is NOT an importable ES module:
// it uses ambient helpers (`args`, `agent`, `phase`, `workflow`, `parallel`,
// `pipeline`, `log`), top-level `await`/`return`, and a single
// `export const meta` statement. Mirroring the proven harness technique
// (tests/helpers/workflow-harness.ts — deliberately NOT imported: src must not
// depend on tests), we rewrite `export const meta` → `const meta` and wrap the
// body in an AsyncFunction whose parameters are the ambient helpers.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The `Function` constructor typed to build the AsyncFunction the workflow
// executor mirrors: seven string parameter names + a string body.
const AsyncFunction = (async function () {}).constructor as new (
  ...names: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>

/** Options an agent dispatch may carry (mirrors `src/workflows/globals.d.ts`). */
export interface WorkflowAgentOpts {
  label?: string
  phase?: string
  effort?: string
  schema?: object
}

/** The seven ambient helpers injected into the workflow body. */
export interface WorkflowHelpers {
  args: unknown
  agent: (prompt: string, opts?: WorkflowAgentOpts) => Promise<unknown>
  phase: (title: string) => void
  workflow: (ref: unknown, workflowArgs?: unknown) => Promise<unknown>
  parallel: (thunks: ReadonlyArray<() => unknown>) => Promise<unknown[]>
  pipeline: (items: readonly unknown[], ...stages: Array<(acc: unknown) => unknown>) => Promise<unknown[]>
  log: (msg: string) => void
}

/** A loaded workflow: invoke it with the injected helpers to run the deployable. */
export type LoadedWorkflow = (helpers: WorkflowHelpers) => Promise<unknown>

/** Load a script-shaped workflow deployable into an invokable AsyncFunction. */
export function loadWorkflow(file: string): LoadedWorkflow {
  const src = readFileSync(file, 'utf8').replace(/^export const meta\b/m, 'const meta')
  const fn = new AsyncFunction('args', 'agent', 'phase', 'workflow', 'parallel', 'pipeline', 'log', src)
  return helpers =>
    fn(helpers.args, helpers.agent, helpers.phase, helpers.workflow, helpers.parallel, helpers.pipeline, helpers.log)
}

const DEPLOYABLE_REL = join('plugins', 'strapped', 'workflows', 'strapped-run.js')

/**
 * Resolve the deployable's absolute path: an explicit path wins; otherwise
 * walk up from this file's directory to the repo root that carries
 * plugins/strapped/workflows/strapped-run.js.
 */
export function resolveDeployable(explicit?: string): string {
  if (explicit !== undefined) return explicit
  let dir = import.meta.dir
  for (;;) {
    const candidate = join(dir, DEPLOYABLE_REL)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`cannot locate ${DEPLOYABLE_REL} above ${import.meta.dir}`)
    dir = parent
  }
}

/** The plugin dir (`<repo>/plugins/strapped`) a deployable path lives under. */
export function pluginDirFor(deployable: string): string {
  return dirname(dirname(deployable))
}
