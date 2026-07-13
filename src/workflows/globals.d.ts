// Ambient declarations for the seven helpers the Claude Code workflow executor
// injects when it evaluates a workflow file body as an AsyncFunction (mirrored
// exactly by tests/helpers/workflow-harness.js:61-74). Workflow modules
// reference these as free identifiers and never import them: bundlers do not
// rename free identifiers, so the deployable's references bind to the
// AsyncFunction parameters at eval time.

/** Options accepted by an `agent()` dispatch. */
interface AgentOpts {
  label?: string
  phase?: string
  effort?: string
  schema?: object
}

/** The workflow arguments: a config object, or its JSON string. */
declare const args: unknown

/**
 * Dispatch a sub-agent and resolve to its schema-shaped result. A failed
 * agent (or one that casts no result) resolves to null — call sites must
 * handle it, never dereference blindly.
 */
declare function agent<T>(prompt: string, opts?: AgentOpts): Promise<T | null>

/** Report the current phase title. */
declare function phase(title: string): void

/** Dispatch a nested workflow. The mono-workflow never calls this. */
declare function workflow(ref: unknown, workflowArgs?: unknown): Promise<unknown>

/** parallel(thunks) → Promise.all(thunks.map(t => t())) — thunks, not promises. */
declare function parallel<T>(thunks: ReadonlyArray<() => T | Promise<T>>): Promise<T[]>

/**
 * pipeline(items, ...stages) → for each item concurrently, run the stages
 * sequentially, each stage receiving the previous stage's return value (the
 * first receives the item); resolves to the array of final results.
 */
declare function pipeline<T, A>(items: readonly T[], stage1: (input: T) => A | Promise<A>): Promise<A[]>
declare function pipeline<T, A, B>(
  items: readonly T[],
  stage1: (input: T) => A | Promise<A>,
  stage2: (input: A) => B | Promise<B>
): Promise<B[]>

/** Append one progress message to the workflow log. */
declare function log(msg: string): void
