export const meta = {
  name: 'strapped-pr-run',
  description: 'Stacked-PR create pass as a workflow stage: one PR agent pushes done deliverables in topo order, opens stacked PRs per the conventions, and records URLs via the state script',
  phases: [{ title: 'PR', detail: 'push branches, open stacked PRs in topo order, record URLs' }],
}

const cfg = typeof args === 'string' ? JSON.parse(args) : args

const PR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prs', 'summary'],
  properties: {
    prs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'url', 'skipped', 'reason'],
        properties: {
          id: { type: 'string' },
          url: { type: ['string', 'null'] },
          skipped: { type: 'boolean' },
          reason: { type: ['string', 'null'] },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const dryRun = Boolean(cfg.dryRun)

phase('PR')
const result = await agent(
  `You are the PR stage of strapped run "${cfg.slug}". Create the stacked GitHub PRs for this run's done deliverables — mechanically, per the documented procedure. All state reads/writes go through the state script: \`node ${cfg.stateScript} <command> ...\` (contract in the "Harness scripts" section of ${cfg.conventionsFile}).

Procedure — the "Stacked PRs" section of ${cfg.conventionsFile} is authoritative; read it first:
1. Run \`node ${cfg.stateScript} resolve ${cfg.slug}\` for the repos map (each repo's absolute root) and \`node ${cfg.stateScript} dag ${cfg.dir}\` for the nodes and the authoritative \`topo\` order — never hand-roll either.
2. Candidates: \`status: done\` nodes whose parents are all done, pr-open, or merged, processed in \`topo\` order.
3. Per candidate, in that deliverable's OWN repo (every git/gh operation pinned to it via \`git -C <repoRoot>\` / running gh inside <repoRoot>):
   - \`git -C <repoRoot> push -u origin <branch>\`
   - \`gh pr create --head <branch> --base <parent-branch-if-same-repo-else-main> --title "<Did>: <title>" --body-file <generated>\` — base per the cross-repo base rule (the parent deliverable's branch only when the parent is in the same repo; a root or cross-repo child bases on that repo's main). Body: one-paragraph summary, the acceptance criteria as a checklist, a Stack table of the whole DAG grouped by repo, and \`Depends on #<parent PR>\` for same-repo non-roots.
   - Record via the state script: \`node ${cfg.stateScript} set <deliverableFile> pr <url>\` then \`node ${cfg.stateScript} transition <deliverableFile> pr-open\`.
4. After all creations, refresh every stack table via \`gh pr edit <num> --body-file <regenerated>\` so earlier PRs link the later ones.

Guardrails (binding):
- Never push \`main\`, never merge PRs, never \`--force\` (only \`--force-with-lease\`) — enforced per repo (every git op runs \`-C <deliverableRepoRoot>\`).
- If \`gh\` is unauthenticated or a branch has no commits beyond its base, report and skip that node rather than failing the stage: return it with \`skipped: true\` and a human-readable \`reason\`, and continue with the remaining nodes.
${dryRun ? '\nDRY RUN — print-only: execute NOTHING that mutates (no push, no pr create/edit, no state-script set/transition). Print every would-be git/gh/state command, return them in `summary`, and return every candidate with `url: null` and `skipped: true`.\n' : ''}
Return \`prs\` — one entry per candidate node \`{ id, url, skipped, reason }\` (\`url\` null when skipped, \`reason\` null when created) — and a one-paragraph \`summary\` of what was created and what was skipped.`,
  { label: 'pr-create', phase: 'PR', schema: PR_SCHEMA }
)
if (!result) throw new Error('pr agent failed')
log(`pr stage: ${result.prs.length} node(s) processed${dryRun ? ' (dry run)' : ''}`)

return { slug: cfg.slug, dryRun, prs: result.prs, summary: result.summary }
