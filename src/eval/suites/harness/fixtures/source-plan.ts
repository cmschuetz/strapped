// A compact but realistic source-plan ask used by the planner case (and reused
// as the "original ask" the reviewer/verifier check the fixture plan against).
// Small enough to run fast and cache well; concrete enough that a planner must
// split it into more than one deliverable.

export const FIXTURE_SOURCE_PLAN = `Add an offline-friendly \`--dry-run\` mode to the strapped CLI.

Requirements:
1. A new \`--dry-run\` flag on the \`run\` command that resolves the DAG and prints
   the wave plan (which deliverables would dispatch, in what order) WITHOUT
   spawning any agent, mutating any state file, or creating any worktree.
2. The dry-run planner must reuse the existing DAG-resolution code path — no
   forked copy of the topological-sort logic.
3. A JSON output mode (\`--dry-run --json\`) emitting the same wave plan as a
   machine-readable object for CI consumption.
4. Documentation: a short "Dry run" section in the CLI reference explaining the
   flag and its guarantees (no side effects).

Constraints:
- The wave-planning logic lives in the implement stage today; extracting a pure,
  side-effect-free resolver is expected and should be independently testable.
- Every new user-facing behavior ships with a test that exercises it.`
