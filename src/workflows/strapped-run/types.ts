// Typed counterparts of the strapped-run agent JSON schemas (schemas.ts) plus
// the run config and the shapes flowing between the stages. Every agent<T>()
// call site names its result interface from here — the schemas constrain the
// agent at runtime, these constrain the workflow at compile time.

// --- run config ---------------------------------------------------------------

export type StageName = 'plan' | 'feedback-synth' | 'implement' | 'pr'

export interface Rule {
  id: string
  source: string
  text: string
}

/** One round's seeded rule split between the two reviewers. */
export interface RulePartition {
  a: Rule[]
  b: Rule[]
}

export interface RepoRef {
  name: string
  root: string
}

export interface RunScripts {
  state?: string
  worktree?: string
}

export interface PlanStageArgs {
  sourcePlan?: string
  repos?: RepoRef[]
}

export interface FeedbackSynthStageArgs {
  /** The fetched PR review comments — embedded verbatim via JSON.stringify. */
  comments?: unknown
  repos?: RepoRef[]
  /**
   * Feedback-lite mode: synthesize the routed digest only — write no
   * `## Feedback addendum` files and skip the adversarial review loop. The main
   * agent (the lite skill's plan-mode gate) produces the user-approved plan.
   */
  lite?: boolean
}

export interface ImplementStageArgs {
  addendumMode?: boolean
  recordSuffix?: string
  only?: string
}

export interface PrStageArgs {
  dryRun?: boolean
}

export interface StageArgsMap {
  plan?: PlanStageArgs
  'feedback-synth'?: FeedbackSynthStageArgs
  implement?: ImplementStageArgs
  pr?: PrStageArgs
}

export interface RunConfig {
  slug: string
  dir: string
  conventionsFile: string
  scripts: RunScripts
  seed: number
  confidenceMin: number
  planRounds: number
  codeRounds: number
  rulesByRound: RulePartition[]
  stages: StageName[]
  stageArgs: StageArgsMap
}

// --- agent results (one interface per schema) ----------------------------------

export interface PlanDeliverable {
  id: string
  file: string
  title: string
  deps: string[]
}

/** PLAN_SCHEMA */
export interface PlanResult {
  deliverables: PlanDeliverable[]
  summary: string
}

export type Severity = 'blocking' | 'concern' | 'suggestion'

export interface Finding {
  id: string
  /** <rule-id-or-gap>:<location>, stable across rounds for dedup */
  key: string
  rule: string | null
  severity: Severity
  location: string
  what: string
  why: string
  evidence: string
  /**
   * @minimum 0
   * @maximum 100
   */
  confidence: number
  recommendation: string
}

export interface RuleCheck {
  rule: string
  verdict: 'pass' | 'violation' | 'na'
  evidence: string
}

/** FINDINGS_SCHEMA */
export interface FindingsResult {
  findings: Finding[]
  rule_checklist: RuleCheck[]
}

/** REFUTE_SCHEMA */
export interface RefuteResult {
  verdict: 'confirmed' | 'refuted' | 'uncertain'
  /**
   * @minimum 0
   * @maximum 100
   */
  confidence: number
  evidence: string
}

/** CONSOLIDATE_SCHEMA */
export interface ConsolidateResult {
  new_confirmed_ids: string[]
  duplicate_ids: string[]
}

export interface SynthAddendum {
  deliverableId: string
  sourcePr: string
  crossDeliverable: boolean
  tasks: string[]
}

/** SYNTH_SCHEMA */
export interface SynthResult {
  addenda: SynthAddendum[]
  summary: string
}

/** IMPLEMENT_SCHEMA */
export interface ImplementResult {
  status: 'implemented' | 'blocked'
  summary: string
  validations_green: boolean
  blocker: string | null
}

export interface WaveItem {
  id: string
  repo: string
  repoRoot: string
  validations: string[]
  planFile: string
  worktree: string
  branch: string
  base: string
  resumeNote: string | null
  /** the node's `pr:` frontmatter URL, null for a pre-PR node */
  pr: string | null
}

export interface BlockedNode {
  id: string
  blockedOn: string[]
}

/** WAVE_SCHEMA */
export interface WaveResult {
  items: WaveItem[]
  remaining: number
  blocked: BlockedNode[]
}

/** APPLY_SCHEMA */
export interface ApplyResult {
  applied: Array<{ id: string; status: 'done' | 'parked' | 'pr-open' }>
}

/** APPROVE_SCHEMA */
export interface ApproveResult {
  changed: boolean
}

/** PROBE_SCHEMA */
export interface ProbeResult {
  remaining: number
  notDone: string[]
}

export interface PrEntry {
  id: string
  url: string | null
  skipped: boolean
  reason: string | null
}

/** PR_SCHEMA */
export interface PrResult {
  prs: PrEntry[]
  summary: string
}

// --- review-loop shapes ---------------------------------------------------------

export type ReviewerId = 'a' | 'b'

/** A finding annotated with the refuter's vote — null when the vote was not cast. */
export type Refuted<F extends Finding> = F & { refute: RefuteResult | null }

/** A code-review finding tagged with the reviewer that raised it. */
export interface CodeFinding extends Finding {
  reviewer: ReviewerId
}

/** A confirmed finding carried across rounds in the seen digest. */
export interface SeenFinding extends Finding {
  round: number
  status: 'open' | 'fixed'
}

export interface OutstandingFinding {
  id: string
  key: string
  severity: Severity
  what: string
}

export interface ReviewLoopResult {
  converged: boolean
  rounds: number
  outstanding: OutstandingFinding[]
}

// --- stage results ----------------------------------------------------------------

export interface StageCtx {
  hasLaterStage: boolean
  ranImplement: boolean
}

export interface PlanStageResult {
  converged: boolean
  rounds: number
  deliverables: PlanDeliverable[]
  outstanding: OutstandingFinding[]
  summary: string
}

export interface FeedbackSynthStageResult {
  converged: boolean
  rounds: number
  outstanding: OutstandingFinding[]
  addenda: SynthAddendum[]
  summary: string
}

export type RoundsField = 'review_rounds_used' | 'feedback_rounds_used'

export interface CoordinatorCtx {
  only: string | null
  addendumMode: boolean
  recordSuffix: string
  roundsField: RoundsField
}

/** A node's state after the implementer, before the review/fix loop. */
export type NodeState =
  | { item: WaveItem; outcome: 'implemented'; roundsUsed: number; summary?: string }
  | { item: WaveItem; outcome: 'parked'; roundsUsed: number; parkedReason: string; summary?: string }

/** A node's final per-wave outcome after the review/fix loop. */
export interface NodeOutcome {
  item: WaveItem
  outcome: 'done' | 'parked'
  roundsUsed: number
  parkedReason?: string
  summary?: string
  suggestions: Finding[]
}

export interface SuggestionRef {
  key: string
  what: string
  location: string
}

export interface ProcessedOutcome {
  id: string
  outcome: 'done' | 'parked'
  roundsUsed: number
  parkedReason: string | null
  summary: string | null
  suggestions: SuggestionRef[]
}

export interface ImplementStageResult {
  outcomes: ProcessedOutcome[]
  allDone: boolean
  blocked: BlockedNode[]
}

export interface PrStageResult {
  gateFailed?: boolean
  notDone?: string[]
  prs: PrEntry[]
  dryRun: boolean
  summary: string
}

export type StageResult = PlanStageResult | FeedbackSynthStageResult | ImplementStageResult | PrStageResult

export interface RunResult {
  slug: string
  stages: StageName[]
  completed: StageName[]
  stoppedAt: StageName | null
  results: Partial<Record<StageName, StageResult>>
}
