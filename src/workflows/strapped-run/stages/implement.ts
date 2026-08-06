// Stage: implement — DAG wave loop: coordinator executor per pass, fresh
// implementer per node, bounded code-review/fix rounds (implement-review.ts),
// outcome applier. Park-don't-spin: zero newly-done progress stops the loop.

import { stageArgsFor } from '../config.ts'
import { APPLY_SCHEMA, IMPLEMENT_SCHEMA, WAVE_SCHEMA } from '../schemas.generated.ts'
import { runCodeReviewRound } from './implement-review.ts'
import type {
  ApplyResult,
  BlockedNode,
  CodeFinding,
  ImplementResult,
  ImplementStageResult,
  NodeOutcome,
  NodeState,
  ProcessedOutcome,
  RunConfig,
  SeenFinding,
  WaveItem,
  WaveResult,
} from '../types.ts'

function implementPrompt(cfg: RunConfig, item: WaveItem): string {
  return `You are the implementation agent for deliverable ${item.id} of strapped run "${cfg.slug}". You have fresh context — everything you need is in the files below.

Work EXCLUSIVELY inside the worktree: ${item.worktree} (branch ${item.branch}, based on ${item.base}). This deliverable targets repo "${item.repo}" — never touch ${item.repoRoot} directly.

1. Read your deliverable plan in full: ${item.planFile}
2. Read the shared research digest: ${cfg.dir}/research.md
3. Read the project guidelines: every CLAUDE.md that applies (repo root at minimum).
${item.resumeNote ? `\nThis deliverable is being RESUMED. Prior state:\n${item.resumeNote}\n` : ''}
If the plan declares a \`## Preconditions\` section, verify each stated precondition FIRST. If any is not currently satisfied, do NOT implement and do NOT improvise around it (no vendoring, stubbing, or re-creating work the precondition says must land externally first): return status "blocked" with the blocker naming the unmet precondition — the node parks with that reason and is re-kicked later once the precondition holds.

Implement exactly what the plan specifies — its acceptance criteria are the contract. Write the tests the plan names (integration-style, public interfaces). Stay in scope: anything under "Out of scope" is off limits; note side-discoveries in your summary instead of fixing them.

Before finishing, ALL validations must pass inside the worktree:
${item.validations.map(v => `- ${v}`).join('\n')}

Commit your work on ${item.branch} with a Conventional-Commits message (\`<type>(${cfg.slug}): <description>\` — scope is the run slug, no \`${item.id}:\` title prefix; reference ${item.id} in the body). If validations pass, commit and return status "implemented" with validations_green true. If you hit a blocker you cannot resolve (missing dependency, contradictory plan, validation failure you cannot fix), commit what is safe, return status "blocked" with the blocker described — do NOT loop indefinitely.`
}

function fixPrompt(cfg: RunConfig, item: WaveItem, findings: readonly CodeFinding[], round: number): string {
  return `You are the fix agent for deliverable ${item.id} of strapped run "${cfg.slug}", code-review round ${round}. Fresh context — everything you need is below.

Work EXCLUSIVELY inside the worktree: ${item.worktree} (branch ${item.branch}, based on ${item.base}). This deliverable targets repo "${item.repo}" — never touch ${item.repoRoot} directly.

1. Read the deliverable plan: ${item.planFile}
2. Read the research digest: ${cfg.dir}/research.md
3. Read the full round record: ${cfg.dir}/reviews/${item.id}-code-round-${round}.md

Confirmed findings you must fix:
${JSON.stringify(findings.map(f => ({ id: f.id, key: f.key, severity: f.severity, location: f.location, what: f.what, recommendation: f.recommendation })), null, 2)}

Fix every finding. Then re-run ALL validations inside the worktree until green:
${item.validations.map(v => `- ${v}`).join('\n')}

Commit the fixes on ${item.branch}. Update the round record: flip each fixed finding's status from open to fixed. Return status "implemented" with validations_green true, or "blocked" with the blocker if a finding cannot be fixed as recommended (do not silently skip it).`
}

async function implementOne(cfg: RunConfig, item: WaveItem): Promise<NodeState> {
  const result = await agent<ImplementResult>(implementPrompt(cfg, item), {
    label: `implement:${item.id}`,
    phase: 'Implement',
    schema: IMPLEMENT_SCHEMA,
  })
  if (!result) return { item, outcome: 'parked', parkedReason: 'implementer agent failed', roundsUsed: 0 }
  if (result.status === 'blocked' || !result.validations_green) {
    return { item, outcome: 'parked', parkedReason: result.blocker || 'validations not green after implementation', roundsUsed: 0, summary: result.summary }
  }
  return { item, outcome: 'implemented', summary: result.summary, roundsUsed: 0 }
}

async function reviewFixLoop(cfg: RunConfig, state: NodeState): Promise<NodeOutcome> {
  if (state.outcome === 'parked') return { ...state, suggestions: [] }
  const item = state.item
  // A 0-round code-review budget means "skip adversarial review entirely and
  // trust the implementer" (its validations already ran green) — the node goes
  // straight to done and the confirmation pass never fires.
  if (cfg.codeRounds === 0) {
    log(`${item.id}: code-review budget 0 — skipping adversarial review`)
    return { item, outcome: 'done', roundsUsed: 0, summary: state.summary, suggestions: [] }
  }
  const seen: SeenFinding[] = []
  const suggestions: CodeFinding[] = []
  let converged = false
  let roundsUsed = 0
  let parkedReason: string | null = null

  let lastRoundFixedAll = false
  for (let round = 1; round <= cfg.codeRounds; round++) {
    roundsUsed = round
    lastRoundFixedAll = false
    const review = await runCodeReviewRound(cfg, { item, round, confirmation: false, seen })
    suggestions.push(...review.suggestions)
    if (review.converged) {
      converged = true
      break
    }
    for (const f of review.newConfirmed) seen.push({ ...f, round, status: 'open' })

    const fix = await agent<ImplementResult>(fixPrompt(cfg, item, review.newConfirmed, round), {
      label: `fix:${item.id}:r${round}`,
      phase: 'Fix',
      schema: IMPLEMENT_SCHEMA,
    })
    if (!fix || fix.status === 'blocked' || !fix.validations_green) {
      parkedReason = (fix && fix.blocker) || `fix agent failed on round ${round}`
      break
    }
    for (const f of seen) if (f.status === 'open') f.status = 'fixed'
    lastRoundFixedAll = true
  }

  if (!converged && !parkedReason && lastRoundFixedAll) {
    const confirm = await runCodeReviewRound(cfg, { item, round: cfg.codeRounds, confirmation: true, seen })
    suggestions.push(...confirm.suggestions)
    if (confirm.converged) {
      converged = true
    } else {
      for (const f of confirm.newConfirmed) seen.push({ ...f, round: cfg.codeRounds, status: 'open' })
      parkedReason = `confirmation pass after round ${cfg.codeRounds} surfaced open findings: ${confirm.newConfirmed.map(f => f.key).join(', ')}`
    }
  }

  if (converged) {
    return { item, outcome: 'done', roundsUsed, summary: state.summary, suggestions }
  }
  const open = seen.filter(f => f.status === 'open').map(f => f.key)
  return {
    item,
    outcome: 'parked',
    roundsUsed,
    parkedReason:
      parkedReason ||
      `code-review budget (${cfg.codeRounds}) exhausted with open findings: ${open.join(', ')}`,
    summary: state.summary,
    suggestions,
  }
}

function coordinatorPrompt(cfg: RunConfig, pass: number, only: string | null): string {
  const stateScript = cfg.scripts.state
  const worktreeScript = cfg.scripts.worktree
  const header = `You are the wave coordinator (pass ${pass}) of the implement stage of strapped run "${cfg.slug}". You are a mechanical executor: run exactly the commands below via Bash and return the JSON described — the scripts do all the computing, you are a pipe. Contract for every script: the "Harness scripts" section of ${cfg.conventionsFile}.

Run root: ${cfg.dir}
State script: node ${stateScript} <command> ...
Worktree script: ${worktreeScript}
${pass === 1 ? `\nFirst pass only — flip the manifest first: run \`node ${stateScript} manifest-status ${cfg.dir} implementing\` (a same-status flip is an idempotent no-op on resume).\n` : ''}`

  const sweepRule = only
    ? `PLUS ${only} when its status in the dag's \`nodes\` list is \`in-progress\` with a recorded worktree (an interrupted implementation to resume — compose its resumeNote from its frontmatter). This dispatch is SCOPED to ${only}: never sweep any other in-progress node into the wave.`
    : `PLUS every node whose status in the dag's \`nodes\` list is \`in-progress\` with a recorded worktree (an interrupted implementation to resume — compose its resumeNote from its frontmatter).`
  const resumableRule = only
    ? `\`resumable\` = [${only}] when that same output's \`nodes\` entry for ${only} has status \`in-progress\`, else [] — never any other id (the scope is ${only} alone)`
    : `\`resumable\` = the ids from that same output's \`nodes\` list whose status is \`in-progress\` ([] when none)`
  return `${header}
1. Run \`node ${stateScript} dag ${cfg.dir}${only ? ` --only ${only}` : ''}\` EXACTLY ONCE, FIRST — its \`ready\`, \`topo\`, \`blocked\`, and \`remaining\` fields are authoritative; consume them verbatim, never recompute readiness or remaining yourself, and NEVER re-run dag after a transition (your paste below is THIS first output). This pass's wave = every node in \`ready\` ${sweepRule}
2. Run \`node ${stateScript} resolve ${cfg.slug}\` for the repos map (per repo: root, validations, worktreeRoot, provisioning).
3. For EACH node in \`ready\` (this pass's wave):
   - Look up its repo's { root, validations, worktreeRoot, provisioning } via the node's \`repo\` field.
   - Worktree path: <worktreeRoot>/${cfg.slug}/<id>; branch comes from the node's frontmatter.
   - Effective base: the node's frontmatter \`base:\` — EXCEPT when a same-repo parent (a dep whose \`repo\` equals the node's) has status \`merged\` in the dag's \`nodes\`: that parent's work is already in main and its pre-merge branch is a dead tip, so run \`git -C <repoRoot> fetch origin main\` and use the repo's **main** as the effective base, then record it back with \`node ${stateScript} set <deliverableFile> base main\` (the pr stage bases the child's PR consistently off the recorded value). Parents at done/pr-open keep the frontmatter \`base:\` unchanged.
   - Run \`${worktreeScript} <repoRoot> <worktreePath> <branch> <effectiveBase>\` (idempotent: reuses a matching worktree, re-attaches an existing branch, otherwise creates from base; a non-zero exit is a hard stop — report it, don't improvise). Apply the repo's \`provisioning\` instructions only to a FRESH worktree (\`created: true\`), placeholder values only, never real secrets.
   - Record: \`node ${stateScript} set <deliverableFile> worktree <worktreePath>\` then \`node ${stateScript} transition <deliverableFile> in-progress\` (a \`parked\` node readmitted via --only flips parked → in-progress; in-progress → in-progress is an idempotent no-op).
   - resumeNote: null for a fresh (\`pending\`) node. For a re-dispatched node (was \`in-progress\` or \`parked\`), compose a short string from its frontmatter (\`parked_reason\`, \`review_rounds_used\`) and the latest ${cfg.dir}/reviews/<id>-code-round-*.md record — open findings and what was already done.
Return \`items\` (one per ready node: id, repo, repoRoot, validations, planFile as the ABSOLUTE deliverable file path, worktree, branch, base — the EFFECTIVE base from step 3, resumeNote, pr — the node's \`pr:\` frontmatter URL, null when none), \`dag\` = an object with EXACTLY four keys — \`ready\`, \`remaining\`, \`blocked\` copied unchanged from your FIRST dag run's printed JSON, plus ${resumableRule}; include NO other dag fields (nodes, topo, manifest are rejected by the schema). The workflow validates your wave against this paste — a wave that omits a ready node is rejected. When the dag's \`remaining\` is 0, return items: [].`
}

function applyPrompt(cfg: RunConfig, pass: number, results: readonly NodeOutcome[]): string {
  const stateScript = cfg.scripts.state
  const outcomes = results.map(r => ({
    id: r.item.id,
    deliverableFile: r.item.planFile,
    outcome: r.outcome,
    roundsUsed: r.roundsUsed,
    parkedReason: r.parkedReason || null,
    pr: r.item.pr || null,
  }))
  return `You are the outcome applier (pass ${pass}) of the implement stage of strapped run "${cfg.slug}". You are a mechanical executor: apply each outcome below to its deliverable's frontmatter by running exactly the state-script commands described (contract: the "Harness scripts" section of ${cfg.conventionsFile}) and return the JSON described. Never hand-edit frontmatter.

State script: node ${stateScript} <command> ...

Wave outcomes:
${JSON.stringify(outcomes, null, 2)}

Per outcome:
- outcome "done": \`node ${stateScript} transition <deliverableFile> done\`.
- outcome "parked": \`node ${stateScript} transition <deliverableFile> parked\` then \`node ${stateScript} set <deliverableFile> parked_reason "<parkedReason>"\`.
- always: \`node ${stateScript} set <deliverableFile> review_rounds_used <roundsUsed>\`.

Return applied: one entry per outcome { id, status } with the final on-disk status. Do not run anything else.`
}

export async function implementStage(cfg: RunConfig): Promise<ImplementStageResult> {
  const a = stageArgsFor(cfg, 'implement')
  const only = a.only || null

  const outcomes: ProcessedOutcome[] = []
  let blocked: BlockedNode[] = []
  let allDone = false
  let pass = 0
  let maxPasses = Infinity

  while (pass < maxPasses) {
    pass++
    let wave = await agent<WaveResult>(coordinatorPrompt(cfg, pass, only), {
      label: `coordinate:${pass}`,
      phase: 'Implement',
      schema: WAVE_SCHEMA,
    })
    if (!wave) throw new Error(`implement stage: coordinator agent failed on pass ${pass}`)

    // Trust the pasted dag, not the agent's summary; mismatch → one retry, then
    // hard stop. Under a scope, an out-of-scope id in the paste's resumable is
    // NOT dispatchable (ready is already scoped at the state.ts source), so a
    // wave sweeping in unrelated interrupted work is rejected here.
    const matchesDag = (w: WaveResult) => {
      const itemIds = new Set(w.items.map(i => i.id))
      const dispatchable = new Set([...w.dag.ready, ...w.dag.resumable].filter(id => only === null || id === only))
      return w.dag.ready.every(id => itemIds.has(id)) && [...itemIds].every(id => dispatchable.has(id))
    }
    if (!matchesDag(wave)) {
      log(`pass ${pass}: coordinator wave [${wave.items.map(i => i.id).join(', ')}] does not match dag ready [${wave.dag.ready.join(', ')}] — re-dispatching once`)
      const mismatchNote = `\n\nRETRY — your previous wave was REJECTED: its items [${wave.items.map(i => i.id).join(', ')}] did not match its own dag paste's ready [${wave.dag.ready.join(', ')}]. Return EXACTLY one items entry per node in the dag command's ready list — no omissions, no extras.`
      wave = await agent<WaveResult>(coordinatorPrompt(cfg, pass, only) + mismatchNote, {
        label: `coordinate:${pass}:retry`,
        phase: 'Implement',
        schema: WAVE_SCHEMA,
      })
      if (!wave) throw new Error(`implement stage: coordinator agent failed on pass ${pass} retry`)
      if (!matchesDag(wave)) {
        throw new Error(
          `implement stage: coordinator wave [${wave.items.map(i => i.id).join(', ')}] does not match its own dag ready [${wave.dag.ready.join(', ')}] after a retry on pass ${pass}`
        )
      }
    }
    const remaining = wave.dag.remaining
    if (pass === 1) maxPasses = remaining + 1
    blocked = wave.dag.blocked

    if (remaining === 0) {
      allDone = true
      break
    }
    if (!wave.items.length) {
      // Nothing dispatchable but work remains (parked nodes / blocked children):
      // park, don't spin.
      log(`pass ${pass}: no dispatchable node with ${remaining} remaining — stopping`)
      break
    }

    log(`pass ${pass} wave: ${wave.items.map(i => i.id).join(', ')}`)
    const results = await pipeline(
      wave.items,
      item => implementOne(cfg, item),
      state => reviewFixLoop(cfg, state)
    )
    const waveResults = results.filter(Boolean)

    const applied = await agent<ApplyResult>(applyPrompt(cfg, pass, waveResults), {
      label: `apply:${pass}`,
      phase: 'Implement',
      effort: 'low',
      schema: APPLY_SCHEMA,
    })
    if (!applied) throw new Error(`implement stage: outcome-applier agent failed on pass ${pass}`)

    outcomes.push(
      ...waveResults.map(r => ({
        id: r.item.id,
        outcome: r.outcome,
        roundsUsed: r.roundsUsed,
        parkedReason: r.parkedReason || null,
        summary: r.summary || null,
        suggestions: (r.suggestions || []).map(s => ({ key: s.key, what: s.what, location: s.location })),
      }))
    )

    if (!waveResults.some(r => r.outcome === 'done')) {
      // Zero newly-done progress terminates the loop (park-don't-spin).
      log(`pass ${pass}: zero newly-done progress — stopping`)
      break
    }

    // Deterministic wrap-up: the pasted dag makes remaining computable, so a
    // pass that finishes everything needs no confirming coordinator dispatch.
    const doneResults = waveResults.filter(r => r.outcome === 'done')
    const remainingAfter = wave.dag.remaining - doneResults.length
    if (remainingAfter <= 0) {
      // Safety net: the shortcut trusts wave outcomes, so first cross-check
      // the applier's returned per-node ON-DISK statuses. A done outcome
      // whose transition silently failed must not yield allDone — defer to
      // the next coordinator pass, which re-reads the real dag.
      const appliedStatus = new Map(applied.applied.map(n => [n.id, n.status]))
      const unapplied = doneResults.filter(r => appliedStatus.get(r.item.id) !== 'done')
      if (unapplied.length) {
        log(`pass ${pass}: wrap-up shortcut skipped — on-disk status disagrees with done outcome for [${unapplied.map(r => r.item.id).join(', ')}] — dispatching the next coordinator pass`)
      } else {
        const doneIds = new Set(doneResults.map(r => r.item.id))
        blocked = wave.dag.blocked.filter(b => !doneIds.has(b.id))
        allDone = true
        log(`pass ${pass}: all ${doneResults.length} remaining node(s) done — skipping wrap-up coordinator`)
        break
      }
    }
  }

  return { outcomes, allDone, blocked }
}
