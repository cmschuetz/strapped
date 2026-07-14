// Stage: feedback-synth — synthesize fetched PR review comments into
// `## Feedback addendum` sections on the existing deliverables, then run the
// same bounded adversarial review loop over the amended deliverable set.

import { stageArgsFor } from '../config.ts'
import { runReviewLoop } from '../review-loop.ts'
import { SYNTH_SCHEMA } from '../schemas.generated.ts'
import type { FeedbackSynthStageResult, RunConfig, SynthResult } from '../types.ts'

export async function feedbackSynthStage(cfg: RunConfig): Promise<FeedbackSynthStageResult> {
  const a = stageArgsFor(cfg, 'feedback-synth')
  const lite = Boolean(a.lite)

  // Feedback-lite: the synthesis agent returns the routed digest ONLY — it
  // writes no `## Feedback addendum` files (the main agent's plan-mode gate
  // produces the user-approved plan). The heavyweight path writes the addenda.
  const task2 = lite
    ? `2. Return the routed digest ONLY — do NOT append \`## Feedback addendum\` sections and write NO files. The main agent will produce the user-approved plan from this digest.`
    : `2. Append a \`## Feedback addendum\` section to each affected deliverable's file at ${cfg.dir}/deliverables/<id>-*.md. The section lists concrete, in-scope fix tasks (imperative, testable), each referencing the originating comment/PR. Keep the file conformant to ${cfg.conventionsFile}. If a deliverable already has a \`## Feedback addendum\` section from a prior feedback pass, append new tasks under it rather than duplicating the heading.`

  const synth = await agent<SynthResult>(
    `You are the PR-feedback synthesis agent for strapped run "${cfg.slug}". Turn fetched PR review comments into ONE consolidated, cross-deliverable set of fix tasks, each placed on the CORRECT existing deliverable.

State root for this run: ${cfg.dir}
- Read the DAG + repos map: ${cfg.dir}/manifest.md
- Read EVERY deliverable file under ${cfg.dir}/deliverables/ — each one's \`## Files to touch\` map tells you which files that deliverable owns, so you can route a comment's anchored file path to the deliverable that actually owns it (which may DIFFER from the PR the comment was left on).

Fetched PR review comments (grouped by the deliverable whose PR they were left on; each carries the anchored \`path\`/\`line\` where present, plus the three categories: line-anchored review comments, review-SUBMISSION bodies with their \`state\` — a CHANGES_REQUESTED/COMMENTED/APPROVED summary — and global/issue comments):
${JSON.stringify(a.comments, null, 2)}

Tasks:
1. For each comment (or cluster of related comments), decide which EXISTING deliverable should carry the fix. Use the anchored file path against each deliverable's \`Files to touch\` map — a comment left on a child PR may belong on its parent (or another node). A non-empty CHANGES_REQUESTED review-submission body states the overarching problem: treat it as GLOBAL feedback for that deliverable and route its implied fixes to the owning node(s).
${task2}
3. Do NOT create new deliverable files, branches, or worktrees. Every fix attaches to an EXISTING deliverable.

Return, per affected deliverable: its id, the source PR the comments came from, whether any task was routed cross-deliverable (placed on a node different from the PR it was left on), and the list of tasks. Plus a one-paragraph summary of the consolidated feedback plan.`,
    { label: 'feedback-synth', schema: SYNTH_SCHEMA }
  )
  if (!synth) throw new Error('feedback-synth stage: synthesis agent failed')
  log(`feedback addenda produced for ${synth.addenda.length} deliverable(s)`)

  // Feedback-lite skips the adversarial review loop entirely (its whole point:
  // fast, observable, user-gated). No `rulesByRound`/rounds are consumed.
  if (lite) {
    return { converged: true, rounds: 0, outstanding: [], addenda: synth.addenda, summary: synth.summary }
  }

  const review = await runReviewLoop(cfg, {
    ask: `The fetched PR review comments for strapped run "${cfg.slug}" (line-anchored review comments, review-submission bodies including CHANGES_REQUESTED summaries, and global/issue comments):\n${JSON.stringify(a.comments, null, 2)}`,
    repos: a.repos,
    artifactDescription: 'the amended deliverable set — every file in deliverables/ including the newly-added `## Feedback addendum` sections synthesized from the PR review comments',
    artifactLocation: 'every file in deliverables/ including the newly-added `## Feedback addendum` sections synthesized from the PR review comments',
    artifactNoun: 'deliverable set',
    refuteArtifactPhrase: 'the amended deliverable set',
    roundFilePrefix: 'feedback-round',
    maxRounds: cfg.planRounds,
    reviserPromptFn: (newConfirmed, roundFile) =>
      `You are the PR-feedback addenda reviser for strapped run "${cfg.slug}". Close every confirmed review finding by editing ONLY the \`## Feedback addendum\` sections of the affected deliverable files under ${cfg.dir}/deliverables/, keeping every file conformant to ${cfg.conventionsFile}. Original ask (the fetched PR review comments) for reference: ${cfg.slug} feedback batch. You MUST NOT edit ${cfg.dir}/manifest.md or ${cfg.dir}/research.md, and you MUST NOT create new deliverable files, branches, or worktrees — the feedback flow attaches fixes only to EXISTING deliverables' \`## Feedback addendum\` sections.

Confirmed findings to close (full bodies also in ${roundFile}):
${JSON.stringify(newConfirmed.map(f => ({ id: f.id, key: f.key, location: f.location, what: f.what, recommendation: f.recommendation })), null, 2)}

For each finding: apply the fix by editing the relevant deliverable's \`## Feedback addendum\` section only (add/correct/reassign fix tasks; keep them concrete, in-scope, and testable). Do not touch any \`## Files to touch\`, \`## Implementation steps\`, or other original plan sections, and never touch manifest.md/research.md. Then update ${roundFile}: flip each addressed finding's status from open to fixed. Return one line per finding: id — what you changed.`,
  })

  return {
    converged: review.converged,
    rounds: review.rounds,
    outstanding: review.outstanding,
    addenda: synth.addenda,
    summary: synth.summary,
  }
}
