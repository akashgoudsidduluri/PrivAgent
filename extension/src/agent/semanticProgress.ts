/**
 * PrivAgent — PHASE 18.7 / I-8: SEMANTIC PROGRESS.
 *
 * THE DEFECT THIS MODULE EXISTS TO PREVENT
 * -----------------------------------------
 * `scrollY` participated in the loop fingerprint BY DESIGN (Phase 17.4), and
 * `assessProgress` counted a changed document hash as `observedChange`. The
 * structural consequence, proven in the closure plan, was that EVERY successful
 * scroll looked like progress:
 *
 *   • the fingerprint changed every time, so `maxRepeatedStates` could never
 *     fire on real scrolling;
 *   • `consecutiveNoProgress` never advanced, so `detectStall` could never fire;
 *   • the DOWN→UP→DOWN→UP period-2 detector needed exact alternation of
 *     fingerprints, and a monotonically increasing `scrollY` never alternates.
 *
 * The loop was therefore stopped by `maxSteps`, not by anything that noticed
 * the task was going nowhere: unbounded, individually-"productive",
 * goal-ineffective scrolling.
 *
 * THE RULE
 * --------
 * GEOMETRY IS NOT PROGRESS. Moving the viewport changes *where we are looking*,
 * not *what we know*. Only a change to the task's SEMANTIC state counts:
 *
 *   • new evidence records (the ledger grew),
 *   • a genuinely new document,
 *   • newly discovered entities / candidates / sanitized facts / affordances,
 *   • a change in the targeted value's LENGTH.
 *
 * A scroll that moves `scrollY` by 500 px and discovers nothing records
 * `GEOMETRY_CHANGED` and is NOT progress. That is the whole fix.
 *
 * WHY THIS IS NOT A SECOND PROGRESS AUTHORITY
 * --------------------------------------------
 * `LongHorizonTracker.observe()` in `longHorizon.ts` remains the single owner of
 * progress, stall and loop semantics. This module is its arithmetic: it exports
 * ONE pure classifier and ONE small stateful budget tracker, and
 * `assessProgress` — the pre-existing exported decision function — is now a
 * thin wrapper over the classifier. No other production module may import this
 * file; `tests/phase18_7_i8SemanticProgress.test.ts` asserts that structurally.
 *
 * AUTHORITY
 * ---------
 * None. Nothing here authorizes an action, dispatches one, grants a permission
 * or decides a task outcome. It reports `meaningful: boolean` plus a bounded
 * budget verdict. Every gate — Grounding, M5, the Security Critic, M5/Privacy,
 * Risk/Confirmation, Containment, EffectVerifier, DestinationVerifier,
 * GoalVerifier — is untouched and still runs in its original order.
 *
 * PRIVACY
 * -------
 * IDs and counts only. `factIds` / `affordanceIds` are sanitized structural
 * identifiers that already exist in the model-facing semantic context; no
 * display text, no attribute values, no OCR text and no screenshot ever reaches
 * this module.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** A scroll direction. Only these two exist; anything else is not a scroll. */
export type ScrollDirection = 'up' | 'down';

/**
 * The ONLY signals that may make a cycle meaningful. Each is a change in what
 * the task KNOWS, not in where the viewport sits.
 */
export type SemanticProgressSignal =
  /** The evidence ledger grew during this cycle. */
  | 'EVIDENCE_DELTA'
  /** A different document (origin/path/query), not a fragment change. */
  | 'PAGE_IDENTITY_CHANGED'
  /** An entity id present now that was not present before. */
  | 'NEW_ENTITY'
  /** An interactive candidate id present now that was not present before. */
  | 'NEW_CANDIDATE'
  /** A sanitized display fact present now that was not present before. */
  | 'NEW_SEMANTIC_FACT'
  /** An affordance id present now that was not present before. */
  | 'NEW_AFFORDANCE'
  /** The targeted field's value LENGTH changed. Never its value. */
  | 'TARGET_VALUE_CHANGED';

/**
 * What the GEOMETRY did. Recorded for the trace and for the reasoner-facing
 * history. Never sufficient on its own to make a cycle meaningful.
 */
export type GeometricSignal = 'GEOMETRY_CHANGED' | 'GEOMETRY_UNCHANGED' | 'GEOMETRY_UNOBSERVABLE';

/**
 * Bounded, deterministic stagnation verdicts.
 *
 * `NO_EFFECT` — the same-direction scroll budget drained without a single
 * semantic signal. `OSCILLATION` — the agent is alternating up/down with no
 * signal between the alternations.
 *
 * `NONE` is the only value that means "keep going", and it is what a genuinely
 * productive cycle always produces.
 */
export type StagnationKind = 'NONE' | 'NO_EFFECT' | 'OSCILLATION';

// ── Observation (structural only, never a value) ─────────────────────────────

/**
 * The minimum a cycle must expose to be judged. Deliberately narrower than
 * `TaskObservation`: this module needs the ids and the numbers, nothing else.
 */
export interface SemanticObservation {
  /** Origin+path+query, fragment already removed by the caller. */
  documentIdentity: string;
  entityIds: readonly string[];
  candidateIds: readonly string[];
  factIds: readonly string[];
  affordanceIds: readonly string[];
  scrollY: number;
  /** LENGTH ONLY. Never the value. */
  targetValueLength: number;
  /**
   * `false` when the geometry numbers are the Phase 17.1 all-zero fallback —
   * i.e. the ABSENCE of a reading. `undefined` keeps pre-17.4 behaviour.
   */
  viewportObservable?: boolean;
}

// ── Bounds ───────────────────────────────────────────────────────────────────

export interface SemanticProgressBounds {
  /**
   * Consecutive scrolls in ONE direction, none of which produced a semantic
   * signal, before the scroll strategy is declared to have had no effect.
   * Distinct from `maxSteps`: this bounds a STRATEGY, not the whole task.
   */
  maxSameDirectionWithoutProgress: number;
  /**
   * Length of a strictly alternating up/down sequence with no semantic signal
   * between any two members, before it is declared OSCILLATION.
   */
  maxAlternatingWithoutProgress: number;
}

export const DEFAULT_SEMANTIC_PROGRESS_BOUNDS: SemanticProgressBounds = Object.freeze({
  maxSameDirectionWithoutProgress: 3,
  maxAlternatingWithoutProgress: 4,
});

/** Bound on the retained direction ring. Never grows with task length. */
const MAX_DIRECTION_HISTORY = 16;

// ── Verdict ──────────────────────────────────────────────────────────────────

/**
 * Budget state carried between cycles. Structural counts and two-valued
 * directions; nothing else.
 */
export interface SemanticProgressBudgetState {
  /** Consecutive same-direction scrolls with no semantic signal. */
  sameDirectionRun: number;
  /** Bounded ring of recent scroll directions, oldest first. */
  directionSequence: readonly ScrollDirection[];
}

export const EMPTY_SEMANTIC_PROGRESS_BUDGET: SemanticProgressBudgetState = Object.freeze({
  sameDirectionRun: 0,
  directionSequence: Object.freeze([]) as readonly ScrollDirection[],
});

export interface SemanticProgressVerdict extends SemanticProgressBudgetState {
  /** THE answer to "did this cycle move the task forward?". */
  meaningful: boolean;
  signals: SemanticProgressSignal[];
  geometry: GeometricSignal;
  stagnation: StagnationKind;
  /**
   * True when the scroll strategy has demonstrably had no effect — the budget
   * drained, or the agent is oscillating. Recovery consumes this; it is not a
   * verdict about the task.
   */
  budgetExhausted: boolean;
}

export interface SemanticProgressInput {
  previous: SemanticObservation | null;
  current: SemanticObservation;
  /** New evidence-ledger records observed this cycle. */
  evidenceDelta?: number;
  /**
   * The direction of the scroll DISPATCHED this cycle, or null/undefined when
   * the last action was not a scroll. Taken from the retained action, never
   * from the provider's prose.
   */
  scrollDirection?: ScrollDirection | null;
}

// ── Pure classifier ──────────────────────────────────────────────────────────

function hasNewIds(current: readonly string[], previous: readonly string[]): boolean {
  if (current.length === 0) return false;
  if (previous.length === 0) return true;
  const seen = new Set(previous);
  for (const id of current) {
    if (!seen.has(id)) return true;
  }
  return false;
}

/**
 * Geometry, read honestly.
 *
 * An UNOBSERVABLE viewport is never "unchanged" — it is "we do not know", and
 * the Phase 17.4 contract keeps those two distinct. Note that none of the three
 * outcomes can produce a semantic signal: geometry is recorded, never counted.
 */
export function classifyGeometry(
  previous: SemanticObservation | null,
  current: SemanticObservation
): GeometricSignal {
  if (current.viewportObservable === false) return 'GEOMETRY_UNOBSERVABLE';
  if (!previous || previous.viewportObservable === false) return 'GEOMETRY_UNCHANGED';
  return previous.scrollY === current.scrollY ? 'GEOMETRY_UNCHANGED' : 'GEOMETRY_CHANGED';
}

/**
 * The semantic signals between two observations. GEOMETRY IS NOT AMONG THEM.
 *
 * The first observation (`previous === null`) is meaningful by construction:
 * a page is genuinely new relative to nothing. Everything after that must earn
 * it with one of the listed signals.
 */
export function semanticSignalsBetween(
  previous: SemanticObservation | null,
  current: SemanticObservation,
  evidenceDelta = 0
): SemanticProgressSignal[] {
  const signals: SemanticProgressSignal[] = [];

  // The ledger grew. This is the rule that actually stops the observed loop:
  // the page moved, but nothing new was learned, so nothing was gained.
  if (evidenceDelta > 0) signals.push('EVIDENCE_DELTA');

  if (!previous) {
    // A page relative to nothing is new. Do NOT fabricate the id-level signals
    // here: they are all subsumed by "we had no prior observation".
    return signals.length > 0 ? signals : ['PAGE_IDENTITY_CHANGED'];
  }

  if (previous.documentIdentity !== current.documentIdentity) signals.push('PAGE_IDENTITY_CHANGED');
  if (hasNewIds(current.entityIds, previous.entityIds)) signals.push('NEW_ENTITY');
  if (hasNewIds(current.candidateIds, previous.candidateIds)) signals.push('NEW_CANDIDATE');
  if (hasNewIds(current.factIds, previous.factIds)) signals.push('NEW_SEMANTIC_FACT');
  if (hasNewIds(current.affordanceIds, previous.affordanceIds)) signals.push('NEW_AFFORDANCE');

  // LENGTH ONLY — the sanitized context carries no value, and this module never
  // asks for one. "The field got longer" is a real state change; "the viewport
  // moved down 500px" is not.
  if (previous.targetValueLength !== current.targetValueLength) signals.push('TARGET_VALUE_CHANGED');

  return signals;
}

/** Length of the trailing strictly-alternating run in a direction ring. */
export function trailingAlternatingRun(sequence: readonly ScrollDirection[]): number {
  if (sequence.length < 2) return sequence.length;
  let run = 1;
  for (let i = sequence.length - 1; i > 0; i--) {
    if (sequence[i] === sequence[i - 1]) break;
    run += 1;
  }
  return run;
}

/**
 * THE classifier. One implementation, used by `assessProgress` (stateless) and
 * by `SemanticProgressTracker` (budget-carrying). There is no other definition
 * of "meaningful progress" in the codebase.
 *
 * Pure: the same input and the same carried budget always yield the same
 * verdict. No model, no network, no clock.
 */
export function classifySemanticProgress(
  input: SemanticProgressInput,
  carry: SemanticProgressBudgetState = EMPTY_SEMANTIC_PROGRESS_BUDGET,
  bounds: SemanticProgressBounds = DEFAULT_SEMANTIC_PROGRESS_BOUNDS
): SemanticProgressVerdict {
  const { previous, current, evidenceDelta = 0, scrollDirection = null } = input;

  const signals = semanticSignalsBetween(previous, current, evidenceDelta);
  const meaningful = signals.length > 0;
  const geometry = classifyGeometry(previous, current);

  if (meaningful || !scrollDirection) {
    // A productive cycle clears the budget completely, and a non-scroll cycle
    // is not evidence about the SCROLL strategy either way.
    return {
      meaningful,
      signals,
      geometry,
      sameDirectionRun: meaningful ? 0 : carry.sameDirectionRun,
      directionSequence: meaningful ? [] : [...carry.directionSequence],
      stagnation: 'NONE',
      budgetExhausted: false,
    };
  }

  const last = carry.directionSequence[carry.directionSequence.length - 1];
  const sameDirectionRun = last === scrollDirection ? carry.sameDirectionRun + 1 : 1;

  const sequence = [...carry.directionSequence, scrollDirection].slice(-MAX_DIRECTION_HISTORY);
  const alternatingRun = trailingAlternatingRun(sequence);

  const oscillation = alternatingRun >= bounds.maxAlternatingWithoutProgress;
  const budgetExhausted = sameDirectionRun >= bounds.maxSameDirectionWithoutProgress;
  // OSCILLATION dominates: alternating forever is strictly worse than running
  // in one direction, and reporting it as NO_EFFECT would understate it.
  const stagnation: StagnationKind = oscillation ? 'OSCILLATION' : budgetExhausted ? 'NO_EFFECT' : 'NONE';

  return {
    meaningful,
    signals,
    geometry,
    sameDirectionRun,
    directionSequence: sequence,
    stagnation,
    budgetExhausted: oscillation || budgetExhausted,
  };
}

// ── Budget tracker ───────────────────────────────────────────────────────────

/**
 * Per-task budget state. Owns nothing but the two counters above and never
 * leaves the device.
 */
export class SemanticProgressTracker {
  readonly bounds: SemanticProgressBounds;
  private sameDirectionRun = 0;
  private directionSequence: ScrollDirection[] = [];
  private last: SemanticProgressVerdict = {
    meaningful: false,
    signals: [],
    geometry: 'GEOMETRY_UNCHANGED',
    sameDirectionRun: 0,
    directionSequence: [],
    stagnation: 'NONE',
    budgetExhausted: false,
  };

  constructor(bounds: SemanticProgressBounds = DEFAULT_SEMANTIC_PROGRESS_BOUNDS) {
    this.bounds = { ...bounds };
  }

  /** Task-lifetime reset. */
  reset(): void {
    this.sameDirectionRun = 0;
    this.directionSequence = [];
    this.last = {
      meaningful: false,
      signals: [],
      geometry: 'GEOMETRY_UNCHANGED',
      sameDirectionRun: 0,
      directionSequence: [],
      stagnation: 'NONE',
      budgetExhausted: false,
    };
  }

  /** Advance one cycle. Returns the verdict; also readable via `snapshot()`. */
  evaluate(input: SemanticProgressInput): SemanticProgressVerdict {
    const verdict = classifySemanticProgress(
      input,
      { sameDirectionRun: this.sameDirectionRun, directionSequence: this.directionSequence },
      this.bounds
    );
    this.sameDirectionRun = verdict.sameDirectionRun;
    this.directionSequence = [...verdict.directionSequence];
    this.last = verdict;
    return verdict;
  }

  /** The most recent verdict. Read-only copy. */
  snapshot(): SemanticProgressVerdict {
    return { ...this.last, signals: [...this.last.signals], directionSequence: [...this.last.directionSequence] };
  }

  /** The budget state as `classifySemanticProgress` expects it. */
  carry(): SemanticProgressBudgetState {
    return { sameDirectionRun: this.sameDirectionRun, directionSequence: [...this.directionSequence] };
  }
}
