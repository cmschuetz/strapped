// A fixture review finding for the verifier case that is CLEARLY NOT a real issue:
// it claims the plan never states where the resolver lives, but the fixture plan's
// "Files to touch" section names `resolver.ts` explicitly, and the ask itself
// calls for exactly that extraction. A skeptical verifier reading the inline plan
// should cast `verdict: 'refuted'` with low confidence that the gap is real.

export interface FixtureFinding {
  severity: 'blocking' | 'concern' | 'suggestion'
  location: string
  what: string
  why: string
  evidence: string
}

export const WEAK_FINDING: FixtureFinding = {
  severity: 'blocking',
  location: 'deliverables/D1-dry-run-resolver.md',
  what: 'The plan never says which file the new resolver should live in, so an implementer cannot know where to put it.',
  why: 'Without a named file the implementer has to guess, risking a scattered change.',
  evidence: 'I could not find a target path for the resolver anywhere in the deliverable.',
}
