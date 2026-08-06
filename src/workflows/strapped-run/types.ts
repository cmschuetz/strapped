// Typed counterparts of the strapped-run agent JSON schemas (schemas.ts) plus
// the run config and the shapes flowing between the stages. Every agent<T>()
// call site names its result interface from here — the schemas constrain the
// agent at runtime, these constrain the workflow at compile time.

// --- run config ---------------------------------------------------------------

export type StageName = 'plan' | 'implement' | 'pr'

/**
 * One round's seeded rule split between the two reviewers — rule IDS only.
 * The verbatim rule text never travels in workflow args: it lives in the
 * on-disk snapshot named by `RunConfig.rulesFile`, which review agents Read.
 */
export interface RulePartition {
  a: string[]
  b: string[]
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

export interface ImplementStageArgs {
  only?: string
}

export interface PrStageArgs {
  dryRun?: boolean
  /** Scope the create pass (and its gate probe) to one deliverable id. */
  only?: string
}

export interface StageArgsMap {
  plan?: PlanStageArgs
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
  /** BFS research rounds INCLUDING the planner's own round 1 (default 2, min 1). */
  researchRounds: number
  rulesByRound: RulePartition[]
  /**
   * Absolute path to `reviews/rules-snapshot.md` — the single source of rule
   * TEXT. Required whenever `rulesByRound` is non-empty; null on dispatches
   * that run no review rounds (e.g. the pr-only singleton).
   */
  rulesFile: string | null
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

/** One research topic a planner or researcher enqueues for a later BFS round. */
export interface ResearchRequest {
  topic: string
  brief: string
}

/** PLAN_LEAD_SCHEMA — the planner's result when `researchRounds > 1`. */
export interface PlanLeadResult {
  deliverables: PlanDeliverable[]
  summary: string
  /** Empty = the small-ask exit: the planner already wrote every plan artifact itself. */
  research_requests: ResearchRequest[]
}

/** RESEARCH_SCHEMA — a delegated researcher in a non-final BFS round. */
export interface ResearchResult {
  topic: string
  notes_file: string
  summary: string
  research_requests: ResearchRequest[]
}

/** RESEARCH_FINAL_SCHEMA — a final-round researcher (no field to enqueue more work). */
export interface ResearchFinalResult {
  topic: string
  notes_file: string
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

/**
 * One reviewer verdict on a single enumerated acceptance-criterion item. Kept
 * as its OWN required list (not folded into `rule_checklist`) so a reviewer can
 * never silently omit the per-item AC verdicts: a required, separate field is
 * enforced by the structured-output schema every round, giving ACs the same
 * weight as guideline rules.
 */
export interface AcCheck {
  id: string
  verdict: 'pass' | 'violation' | 'na'
  evidence: string
}

/** FINDINGS_SCHEMA */
export interface FindingsResult {
  findings: Finding[]
  rule_checklist: RuleCheck[]
  /** Per-item AC verdicts — required (may be empty when the artifact has no enumerated section). */
  ac_checklist: AcCheck[]
}

/** One per-finding verdict cast by the verify-consolidate agent. */
export interface FindingVerdict {
  /** The adjudicated finding's id. */
  id: string
  verdict: 'confirmed' | 'plausible' | 'refuted'
  /**
   * @minimum 0
   * @maximum 100
   */
  confidence: number
  evidence: string
}

/** VERIFY_SCHEMA */
export interface VerifyResult {
  /** One verdict per gating finding adjudicated this round. */
  verdicts: FindingVerdict[]
  new_confirmed_ids: string[]
  duplicate_ids: string[]
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
/** `ready`/`remaining`/`blocked` copied verbatim from `state.mjs dag` output. */
export interface DagSnapshot {
  ready: string[]
  /** In-progress node ids from the dag's nodes list — interrupted implementations this pass may resume. */
  resumable: string[]
  remaining: number
  blocked: BlockedNode[]
}

export interface WaveResult {
  items: WaveItem[]
  /** The workflow trusts this paste: `remaining`/`blocked` are read from here verbatim. */
  dag: DagSnapshot
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

export type StageResult = PlanStageResult | ImplementStageResult | PrStageResult

export interface RunResult {
  slug: string
  stages: StageName[]
  completed: StageName[]
  stoppedAt: StageName | null
  results: Partial<Record<StageName, StageResult>>
}
