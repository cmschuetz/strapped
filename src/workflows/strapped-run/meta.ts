// The workflow's meta descriptor — data only. The build imports this module
// natively and serializes it (single-quoted, per the plugin-structure meta
// regex) as the artifact's leading `export const meta` statement. It is NEVER
// imported by main.ts, so it never enters the bundled workflow body.

export const meta = {
  name: 'strapped-run',
  description: 'The strapped mono-workflow: every orchestration loop (plan + adversarial plan review, DAG implement waves with bounded code review, stacked-PR create) lives here as plain stage functions selected by args.stages. Zero workflow() calls anywhere, so the harness one-level nesting limit never engages. The standalone skills dispatch this same file with singleton stage lists.',
  phases: [
    { title: 'plan', detail: 'planner writes research/manifest/deliverables, then the bounded adversarial plan-review loop' },
    { title: 'implement', detail: 'DAG wave loop: coordinator executor per pass, fresh implementer per node, bounded code-review/fix rounds, outcome applier' },
    { title: 'pr', detail: 'stacked-PR create pass, gated on every node being done-or-later' },
  ],
}
