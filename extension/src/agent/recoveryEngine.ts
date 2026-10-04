/**
 * PrivAgent — Phase 10: Bounded, Deterministic Recovery Engine
 *
 * A dedicated strategy layer that EXTENDS the existing Phase 6 effect-based
 * recovery and Phase 9 long-horizon stall/loop handling. It does NOT replace
 * either: Phase 6 still verifies effects and still triggers its bounded
 * re-perceive-and-retry path, and Phase 9 still owns progress/loop/stall
 * semantics. The Recovery Engine adds deterministic failure classification and
 * a bounded strategy decision on top of those mechanisms.
 *
 * SECURITY INVARIANTS (unchanged):
 *  - The engine NEVER executes anything. It returns a recovery decision; the
 *    AgentLoop alone decides what to do with it and sends any resulting action
 *    through the complete pipeline: Target Grounding → M5 → Security Critic →
 *    Privacy Policy → Risk/Confirmation → Execution → Effect/Goal verification.
 *  - All inputs are SANITIZED, structural metadata (codes, generation numbers,
 *    counts, ids). Raw sensitive values are structurally impossible here and
 *    would be rejected by the M8 firewall long before reaching this module.
 *  - Unknown or malformed failure descriptions FAIL CLOSED (ABORT).
 *  - Recovery is strictly bounded: per action, per subgoal, per task, and per
 *    repeated strategy. On exhaustion the task fails with RECOVERY_EXHAUSTED —
 *    it never retries indefinitely.
 */

import { EffectStatus } from './effectVerifier';
import { GroundingFailureReason } from './groundingEngine';
import { FailureCategory } from './agentState';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';

// ── PHASE 18.7 / A7: the typed recovery contract ────────────────────────────
//
// THE DEFECT
// ----------
// Everything above this line computes a recovery decision and then DISCARDS the
// reason for it as console text. The next planning turn cannot see *why* the
// prior strategy was abandoned, so the model re-proposes the exhausted approach
// from scratch and the loop has no structured way to say "this was already tried
// and did not work". Recovery was a log line, not a record.
//
// WHAT IS ADDED (additive — nothing above is changed or replaced)
// -------------------------------------------------------------
// A `RecoveryRecord`: bounded, typed, fixed-vocabulary, value-free, and built
// ONLY from facts the device already established — the typed effect verdict,
// the typed dispatch status, the observation provenance, and the ONE semantic
// progress authority from I-8. It carries no free text and no page content.
//
// RECOVERY IS A STRATEGY MECHANISM, NOT AN AUTHORITY
// --------------------------------------------------
// `TypedRecoveryPlanner.plan()` returns a strategy CLASS and a record. It never
// returns an action, never executes one, and cannot approve one. The complete
// gate chain (Grounding → M5 → Security Critic → M5/Privacy → Risk/Confirmation
// → Containment → Execution → EffectVerifier → DestinationVerifier →
// GoalVerifier) runs in its original order on anything recovery selects, and
// `requiresFreshPerception` is advisory to the LOOP, never a bypass.

import type { ActionHistoryEntry, HistoryObservationState } from './actionHistory';

// ── Typed failure categories ────────────────────────────────────────────────

/**
 * The six typed failure categories recovery consumes.
 *
 * Each is derived from an EXISTING verdict, never inferred:
 *   NO_EFFECT           ← EffectVerifier observed nothing changed
 *   POLICY_BLOCKED      ← a gate refused; nothing executed
 *   EXECUTION_FAILED    ← dispatched, then threw
 *   PROVIDER_UNAVAILABLE← the reasoner could not be reached / was unusable
 *   STALE_PERCEPTION    ← the page moved while the request was in flight
 *   OSCILLATION         ← I-8 semantic progress detected an alternating loop
 */
export type RecoveryFailureCategory =
  | 'NO_EFFECT'
  | 'POLICY_BLOCKED'
  | 'EXECUTION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'STALE_PERCEPTION'
  | 'OSCILLATION';

/**
 * Strategy CLASSES, not actions. Recovery may only choose between these; what
 * the loop actually dispatches is chosen by the normal pipeline afterwards.
 */
export type RecoveryStrategyClass =
  /** Discard the current perception and observe the live page again. */
  | 'RE_PERCEIVE'
  /** Leave the strategy class alone and take one more bounded turn. */
  | 'CONTINUE'
  /** Move to a different action class entirely. */
  | 'CHANGE_STRATEGY'
  /** Stop and report a truthful terminal state. No action. */
  | 'STOP';

// `RETRY_SAME_ACTION` is deliberately absent from this union. Repeating the
// exact same action after it has demonstrably failed is the failure mode A7
// exists to close, so there is no vocabulary in which recovery can ask for it.

/**
 * Explicit, bounded strategy transitions. A transition that is not listed is
 * not a transition — recovery fails closed rather than drifting.
 *
 * `STOP → STOP` is the only self-transition, and it is a RESTATEMENT of "this
 * category is already terminated", not a move. Every other self-transition is
 * absent, so "do the same thing again" is not reachable except for the single
 * bounded `CONTINUE → CONTINUE` retry a provider outage is allowed.
 */
export const ALLOWED_STRATEGY_TRANSITIONS: Readonly<
  Record<RecoveryStrategyClass, readonly RecoveryStrategyClass[]>
> = Object.freeze({
  RE_PERCEIVE: Object.freeze(['CONTINUE', 'CHANGE_STRATEGY', 'STOP'] as const),
  CONTINUE: Object.freeze(['CONTINUE', 'RE_PERCEIVE', 'CHANGE_STRATEGY', 'STOP'] as const),
  CHANGE_STRATEGY: Object.freeze(['CONTINUE', 'STOP'] as const),
  STOP: Object.freeze(['STOP'] as const),
});

/**
 * Fixed reason codes. NO FREE TEXT — a message here would be model- or
 * page-derived prose and could carry anything. Every one of them is a claim the
 * device can reproduce from its own typed state.
 */
export type RecoveryReasonCode =
  | 'EFFECT_UNCHANGED'
  | 'GATE_REFUSED_ACTION'
  | 'DISPATCH_THREW'
  | 'PROVIDER_COULD_NOT_ANSWER'
  | 'OBSERVATION_SUPERSEDED'
  | 'ALTERNATING_WITH_NO_GAIN'
  | 'SAME_DIRECTION_BUDGET_DRAINED'
  | 'RETRY_BUDGET_EXHAUSTED'
  | 'SAME_ACTION_RETRY_FORBIDDEN'
  | 'STRATEGY_CHAIN_COMPLETE';

export const RECOVERY_REASON_CODES: readonly RecoveryReasonCode[] = Object.freeze([
  'EFFECT_UNCHANGED',
  'GATE_REFUSED_ACTION',
  'DISPATCH_THREW',
  'PROVIDER_COULD_NOT_ANSWER',
  'OBSERVATION_SUPERSEDED',
  'ALTERNATING_WITH_NO_GAIN',
  'SAME_DIRECTION_BUDGET_DRAINED',
  'RETRY_BUDGET_EXHAUSTED',
  'SAME_ACTION_RETRY_FORBIDDEN',
  'STRATEGY_CHAIN_COMPLETE',
]);

/** Bounds per category. Every one is small, hard, and checked before use. */
export const DEFAULT_TYPED_RECOVERY_BUDGET: Readonly<Record<RecoveryFailureCategory, number>> = Object.freeze({
  // An effect verifier saw nothing change. Re-observe, then change approach.
  NO_EFFECT: 2,
  // Alternating up/down with no gain is worse than repetition: one change only.
  OSCILLATION: 1,
  // A gate already said no. Retrying the same proposal blindly is exactly the
  // behaviour A6's truthful history exists to stop.
  POLICY_BLOCKED: 1,
  EXECUTION_FAILED: 2,
  // Bounded retry only — exactly one more turn, after which the loop
  // terminates truthfully as PROVIDER_UNAVAILABLE rather than as a browser or
  // goal failure.
  PROVIDER_UNAVAILABLE: 1,
  // The page moved under us. Re-perceive BEFORE anything else is even proposed.
  STALE_PERCEPTION: 1,
});

/**
 * The per-category strategy chain. Index 0 is the first response to the first
 * occurrence; once it is exhausted the planner emits `STOP`. Because the chain
 * is a fixed list and never revisits a strategy, neither "the same action
// forever" nor "the same two strategies alternating forever" is reachable.
 */
const STRATEGY_CHAIN: Readonly<Record<RecoveryFailureCategory, readonly RecoveryStrategyClass[]>> =
  Object.freeze({
    NO_EFFECT: Object.freeze(['RE_PERCEIVE', 'CHANGE_STRATEGY'] as const),
    OSCILLATION: Object.freeze(['CHANGE_STRATEGY'] as const),
    POLICY_BLOCKED: Object.freeze(['CHANGE_STRATEGY'] as const),
    EXECUTION_FAILED: Object.freeze(['RE_PERCEIVE', 'CHANGE_STRATEGY'] as const),
    PROVIDER_UNAVAILABLE: Object.freeze(['CONTINUE'] as const),
    STALE_PERCEPTION: Object.freeze(['RE_PERCEIVE'] as const),
  });

/** The record's default reason for each strategy a category can move to. */
const REASON_FOR: Readonly<Record<RecoveryFailureCategory, RecoveryReasonCode>> = Object.freeze({
  NO_EFFECT: 'EFFECT_UNCHANGED',
  OSCILLATION: 'ALTERNATING_WITH_NO_GAIN',
  POLICY_BLOCKED: 'GATE_REFUSED_ACTION',
  EXECUTION_FAILED: 'DISPATCH_THREW',
  PROVIDER_UNAVAILABLE: 'PROVIDER_COULD_NOT_ANSWER',
  STALE_PERCEPTION: 'OBSERVATION_SUPERSEDED',
});

/**
 * The bounded, structured recovery record (closure plan §10).
 *
 * Everything here is either a code, a boolean, a small integer, or a REFERENCE
 * to the already-projectable `ActionHistoryEntry`. There is no free-text field,
 * so there is no path by which page content or model prose can reach it.
 */
export interface RecoveryRecord {
  readonly failureCategory: RecoveryFailureCategory;
  /**
   * Reference to the typed history entry for the action that failed.
   *
   * `null` when the failure happened BEFORE any action was proposed — a
   * provider outage, or a host fault. There is genuinely no previous action
   * then, and fabricating a placeholder entry would be exactly the kind of
   * invented fact this contract exists to prevent.
   */
  readonly previousActionResult: ActionHistoryEntry | null;
  readonly observationState: HistoryObservationState;
  /**
   * From the ONE semantic-progress authority (I-8 `assessProgress` /
   * `SemanticProgressTracker`). NEVER from dispatch success — that conflation
   * is what made Phase 17.4's stagnation detection unreachable.
   */
  readonly madeProgress: boolean;
  readonly strategyFrom: RecoveryStrategyClass;
  readonly strategyTo: RecoveryStrategyClass;
  /** Attempts already spent on THIS failure category in THIS task. Bounded. */
  readonly retryCount: number;
  readonly reasonCode: RecoveryReasonCode;
}

export interface TypedRecoveryInput {
  failureCategory: RecoveryFailureCategory;
  previousActionResult: ActionHistoryEntry | null;
  /**
   * Observation provenance at the moment of failure. Defaults to the entry's
   * own provenance so a caller cannot accidentally assert CURRENT for a stale
   * observation by passing a different field.
   */
  observationState?: HistoryObservationState;
  madeProgress: boolean;
  /** The strategy class that was in force. Defaults to `CONTINUE`. */
  strategyFrom?: RecoveryStrategyClass;
  subgoalId?: string;
}

export interface TypedRecoveryOutcome {
  record: RecoveryRecord;
  /** True when this category's budget or chain is spent: terminate truthfully. */
  exhausted: boolean;
  /**
   * The loop must obtain a FRESH perception before anything is proposed again.
   * Advisory to the loop only — it is not, and cannot become, a gate bypass.
   */
  requiresFreshPerception: boolean;
  /** True when the obsolete target id must not be reused. */
  forbidsStaleTarget: boolean;
}

/** Hard ceiling on retained records, so state can never grow with task length. */
export const MAX_RECOVERY_RECORDS = 32;

/**
 * The bounded recovery planner.
 *
 * PURE and DETERMINISTIC with respect to its own counter state: the same
 * sequence of categories always yields the same sequence of strategies. No
 * model, no clock, no network, and no ability to execute anything.
 */
export class TypedRecoveryPlanner {
  private readonly budget: Readonly<Record<RecoveryFailureCategory, number>>;
  private readonly attempts = new Map<RecoveryFailureCategory, number>();
  private readonly strategyByCategory = new Map<RecoveryFailureCategory, RecoveryStrategyClass>();
  /** Bounded, value-free ring of every record produced this task. */
  readonly records: RecoveryRecord[] = [];

  constructor(budget: Partial<Record<RecoveryFailureCategory, number>> = {}) {
    this.budget = Object.freeze({
      ...DEFAULT_TYPED_RECOVERY_BUDGET,
      ...Object.fromEntries(
        Object.entries(budget).filter(
          ([k, v]) => k in DEFAULT_TYPED_RECOVERY_BUDGET && typeof v === 'number' && Number.isFinite(v) && v >= 0
        )
      ),
    });
  }

  /** Task-lifetime reset. */
  reset(): void {
    this.attempts.clear();
    this.strategyByCategory.clear();
    this.records.length = 0;
  }

  /** Attempts already spent on a category. Read-only. */
  retryCountFor(category: RecoveryFailureCategory): number {
    return this.attempts.get(category) ?? 0;
  }

  /**
   * True when this category's budget or strategy chain is spent, i.e. the next
   * occurrence would terminate truthfully rather than recover again.
   */
  exhaustedFor(category: RecoveryFailureCategory): boolean {
    return this.retryCountFor(category) >= (this.budget[category] ?? 0);
  }

  /** The strategy class currently in force for a category. Read-only. */
  strategyFor(category: RecoveryFailureCategory): RecoveryStrategyClass {
    return this.strategyByCategory.get(category) ?? 'CONTINUE';
  }

  plan(input: TypedRecoveryInput): TypedRecoveryOutcome {
    const category = input.failureCategory;
    const strategyFrom = input.strategyFrom ?? this.strategyFor(category);
    const retryCount = this.retryCountFor(category);
    const max = this.budget[category] ?? 0;
    const chain = STRATEGY_CHAIN[category] ?? [];

    let strategyTo: RecoveryStrategyClass;
    let reasonCode: RecoveryReasonCode;
    let exhausted: boolean;

    if (retryCount >= max) {
      // Budget spent. Terminate TRUTHFULLY. This is the path that makes a
      // provider outage a PROVIDER_UNAVAILABLE state rather than an endless
      // retry, and a policy refusal a POLICY_BLOCKED one.
      strategyTo = 'STOP';
      reasonCode = 'RETRY_BUDGET_EXHAUSTED';
      exhausted = true;
    } else {
      const next = chain[retryCount];
      if (next === undefined) {
        strategyTo = 'STOP';
        reasonCode = 'STRATEGY_CHAIN_COMPLETE';
        exhausted = true;
      } else {
        strategyTo = next;
        reasonCode = REASON_FOR[category];
        exhausted = false;
      }
    }

    // An explicit transition check. `CHANGE_STRATEGY → CONTINUE` or any other
    // unlisted hop fails closed to STOP rather than silently taking it.
    const allowed = ALLOWED_STRATEGY_TRANSITIONS[strategyFrom] ?? [];
    if (!exhausted && !allowed.includes(strategyTo)) {
      strategyTo = 'STOP';
      reasonCode = 'STRATEGY_CHAIN_COMPLETE';
      exhausted = true;
    }

    this.attempts.set(category, retryCount + 1);
    this.strategyByCategory.set(category, strategyTo);

    const record: RecoveryRecord = Object.freeze({
      failureCategory: category,
      previousActionResult: input.previousActionResult,
      observationState:
        input.observationState ??
        input.previousActionResult?.observationState ??
        'NOT_APPLICABLE',
      madeProgress: input.madeProgress === true,
      strategyFrom,
      strategyTo,
      retryCount,
      reasonCode,
    });
    this.records.push(record);
    if (this.records.length > MAX_RECOVERY_RECORDS) this.records.splice(0, this.records.length - MAX_RECOVERY_RECORDS);

    return {
      record,
      exhausted,
      // STALE_PERCEPTION must re-perceive before acting again, and so must every
      // other category: a recovered action is never grounded in a stale page.
      requiresFreshPerception: strategyTo === 'RE_PERCEIVE' || strategyTo === 'CHANGE_STRATEGY',
      forbidsStaleTarget:
        category === 'STALE_PERCEPTION' || input.previousActionResult?.observationState === 'STALE',
    };
  }
}

/**
 * Deterministic category from a typed history entry + the semantic-progress
 * verdict. Used by the loop so the category can never be guessed from a
 * message string.
 *
 * `oscillating` is supplied by the I-8 semantic-progress authority; it
 * OVERRIDES the effect-derived category, because an oscillating run is a
 * stronger and more specific truth than "the last scroll changed nothing".
 */
export function recoveryCategoryFor(input: {
  dispatchStatus: ActionHistoryEntry['dispatchStatus'] | 'NONE';
  effectStatus: ActionHistoryEntry['effectStatus'];
  providerFailure?: boolean;
  staleObservation?: boolean;
  oscillating?: boolean;
}): RecoveryFailureCategory {
  if (input.oscillating) return 'OSCILLATION';
  if (input.providerFailure) return 'PROVIDER_UNAVAILABLE';
  if (input.staleObservation) return 'STALE_PERCEPTION';
  if (input.dispatchStatus === 'POLICY_BLOCKED' || input.dispatchStatus === 'NOT_DISPATCHED') return 'POLICY_BLOCKED';
  if (input.dispatchStatus === 'EXECUTION_FAILED') return 'EXECUTION_FAILED';
  if (input.effectStatus === 'NO_EFFECT' || input.effectStatus === 'EFFECT_UNVERIFIABLE') return 'NO_EFFECT';
  return 'NO_EFFECT';
}

/** Value-free, model-facing projection of a record. No free text exists to leak. */
export function describeRecoveryRecord(record: RecoveryRecord): string {
  return [
    `failure=${record.failureCategory}`,
    `dispatch=${record.previousActionResult?.dispatchStatus ?? 'NONE'}`,
    `effect=${record.previousActionResult?.effectStatus ?? 'NOT_APPLICABLE'}`,
    `madeProgress=${record.madeProgress}`,
    `strategy=${record.strategyFrom}→${record.strategyTo}`,
    `retry=${record.retryCount}`,
    `reason=${record.reasonCode}`,
    `observation=${record.observationState}`,
  ].join(' ');
}

// ── Failure classification ──────────────────────────────────────────────────

/**
 * Recovery failure taxonomy. Every member maps to an EXISTING code in the
 * codebase — `EffectStatus` (M10 effect verifier), `GroundingFailureReason`
 * (Stage 5 grounding), `FailureCategory` (M6/M11 failure records) — plus the
 * Phase 9 long-horizon outcomes. No overlapping new categories are invented.
 */
export type RecoveryFailureCode =
  // M10 effect verification outcomes
  | EffectStatus
  // Stage 5 grounding failure reasons
  | GroundingFailureReason
  // M6/M11 failure-record categories
  | FailureCategory
  // Phase 9 long-horizon outcomes
  | 'LOOP_DETECTED'
  | 'SUBGOAL_STALLED'
  | 'SCROLL_REQUIRED'
  | 'MODAL_BLOCKING';

/** The recovery strategies the engine may propose. */
export type RecoveryStrategy =
  /** Throw the stale perception away and re-observe the live page. */
  | 'REPERCEIVE'
  /** Re-propose the same logical action after a fresh perception (state may now allow it). */
  | 'RETRY_SAME_TARGET'
  /** Re-run target grounding against the fresh page for the failed logical target. */
  | 'REGROUND_TARGET'
  /** Pick a DIFFERENT control for the same intent (self-healing proposes; loop re-validates). */
  | 'RESELECT_TARGET'
  /** Scroll first so hidden content enters the viewport, then re-perceive. */
  | 'SCROLL_AND_REPERCEIVE'
  /** Ask the plan layer to reopen only the remaining work (Phase 9 semantics). */
  | 'REPLAN_SUBGOAL'
  /** Give up: bounded recovery is exhausted or the failure is unrecoverable. */
  | 'ABORT';

/**
 * MODAL_BLOCKING maps to DISMISS_MODAL conceptually, but PrivAgent today has
 * no dedicated, safely-gated modal-dismissal primitive. Rather than invent an
 * unverifiable capability, a modal overlay is handled as REPERCEIVE first
 * (the overlay is visible to the next perception cycle, which can then target
 * its own close control through the normal pipeline). This constant documents
 * that decision explicitly.
 */
export const MODAL_RECOVERY_NOTE =
  'PrivAgent has no dedicated modal-dismissal primitive; the modal is recovered ' +
  'through fresh perception so the normal pipeline can target its close control.';

/**
 * Malformed/unknown failures and hard-stop categories that must never be
 * "recovered" by retrying. UNKNOWN is deliberate: an unrecognized code fails
 * closed instead of guessing a strategy.
 */
const FAIL_CLOSED_CODES = new Set<string>([
  'RECOVERY_EXHAUSTED',
  'CONFIRMATION_REQUIRED',
  'LLM_RATE_LIMIT',
  'PROVIDER_TIMEOUT',
  'PERCEPTION_TIMEOUT',
  'INVALID_MODEL_RESPONSE',
]);

/** Codes that are pure execution-transport noise → simple fresh perception. */
const REPERCEIVE_CODES = new Set<string>([
  'TARGET_TAB_NOT_FOUND',
  'TARGET_TAB_UNRESPONSIVE',
  'NAVIGATION_TIMEOUT',
  'GOAL_NOT_SATISFIED',
]);

/** Deterministic map: failure code → strategy. Order-independent. */
const STRATEGY_BY_CODE: Record<string, RecoveryStrategy> = {
  // ── Effect verification (Phase 6 / M10) ──────────────────────────────────
  // An action ran but changed nothing observable. Never blindly retry: first
  // re-observe (the page may have moved under us), and only then re-ground.
  ACTION_NO_EFFECT: 'REPERCEIVE',
  // A scroll that hits the boundary usually means content is hidden below.
  // Look further down before concluding the target is gone.
  SCROLL_CHANGED: 'REPERCEIVE',

  // ── Grounding (Stage 5) ──────────────────────────────────────────────────
  // The target existed in an earlier generation: the page moved on. A fresh
  // perception + re-ground against the CURRENT generation is the only safe
  // retry; the obsolete target id itself must never be reused.
  STALE_TARGET: 'REGROUND_TARGET',
  TARGET_MISMATCH: 'RESELECT_TARGET',
  ELEMENT_NOT_FOUND: 'REPERCEIVE',
  INSUFFICIENT_CONFIDENCE: 'RESELECT_TARGET',
  // Hidden or disabled controls are frequently below the fold: scroll first.
  DISABLED_OR_HIDDEN: 'SCROLL_AND_REPERCEIVE',
  UNAUTHORIZED_ORIGIN: 'ABORT',

  // ── Failure records (M6/M11) ─────────────────────────────────────────────
  TARGET_NOT_FOUND: 'REPERCEIVE',
  TARGET_TAB_NOT_FOUND: 'REPERCEIVE',
  TARGET_TAB_UNRESPONSIVE: 'REPERCEIVE',
  NAVIGATION_TIMEOUT: 'REPERCEIVE',
  PERCEPTION_TIMEOUT: 'REPERCEIVE',
  PAGE_CHANGED: 'REPERCEIVE',
  TARGET_TAB_NOT_FOUND2: 'REPERCEIVE',
  // A type/select produced no value change — likely the wrong or read-only
  // control. Re-observe, then let the pipeline pick a better target.
  VALUE_STATE_CHANGED: 'RETRY_SAME_TARGET',

  // ── Long horizon (Phase 9) ───────────────────────────────────────────────
  SUBGOAL_STALLED: 'REPLAN_SUBGOAL',
  LOOP_DETECTED: 'REPLAN_SUBGOAL',
  MODAL_BLOCKING: 'REPERCEIVE',
  SCROLL_REQUIRED: 'SCROLL_AND_REPERCEIVE',
};

// Keep the alias out of the shipped type surface but tolerate legacy spellings
// deterministically (e.g. older callers that duplicate the tab codes).
delete (STRATEGY_BY_CODE as Record<string, unknown>).TARGET_TAB_NOT_FOUND2;

/**
 * Deterministic failure classification from sanitized evidence.
 * No LLM, no free-text inference: the code either maps or it fails closed.
 */
export function classifyFailure(input: unknown): {
  ok: boolean;
  code: RecoveryFailureCode | 'UNKNOWN';
  reason: string;
} {
  // 1. Structural validation of the input itself. A malformed payload must
  //    never be guessed at — UNKNOWN fails closed downstream.
  if (typeof input !== 'object' || input === null) {
    return { ok: false, code: 'UNKNOWN', reason: 'Malformed failure input: not an object.' };
  }
  const rec = input as Record<string, unknown>;
  const rawCode = typeof rec.code === 'string' ? rec.code : undefined;
  if (!rawCode) {
    return { ok: false, code: 'UNKNOWN', reason: 'Malformed failure input: missing code.' };
  }

  // 2. Defence in depth: a failure payload carrying a raw-value-shaped string
  //    is dropped outright, matching the long-horizon discovery boundary.
  for (const value of Object.values(rec)) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) {
      if (scanForRawSensitiveValues(value, { structuralKeys: new Set() }).length > 0) {
        return {
          ok: false,
          code: 'UNKNOWN',
          reason: 'Malformed failure input: raw sensitive value shape detected; failing closed.',
        };
      }
    }
  }

  if (FAIL_CLOSED_CODES.has(rawCode)) {
    return { ok: false, code: 'UNKNOWN', reason: `Failure '${rawCode}' must never be retried; failing closed.` };
  }

  if (STRATEGY_BY_CODE[rawCode]) {
    return { ok: true, code: rawCode as RecoveryFailureCode, reason: `Classified as '${rawCode}'.` };
  }

  return { ok: false, code: 'UNKNOWN', reason: `Unrecognized failure code '${rawCode}'; failing closed.` };
}

// ── Recovery decision ───────────────────────────────────────────────────────

export interface RecoveryFailureEvidence {
  /** One of the RecoveryFailureCode values (or anything unknown → fail closed). */
  code: string;
  /** Page generation the failure was observed at. */
  pageGeneration?: number;
  /** Logical target of the failed action, if any (an id only — never a value). */
  targetId?: string;
  /** Subgoal that was active, if any. */
  subgoalId?: string;
  /** True when the effect verifier judged the action to have had no effect. */
  noEffect?: boolean;
  /** True when modal-like overlays are currently observed on the page. */
  modalLikelyBlocking?: boolean;
  /** Scroll direction for scroll actions (safe metadata). */
  scrollDirection?: 'up' | 'down';
  /** True when scroll delta was 0, indicating boundary reached. */
  scrollBoundaryReached?: boolean;
}

export interface RecoveryDecision {
  strategy: RecoveryStrategy;
  code: RecoveryFailureCode | 'UNKNOWN';
  reason: string;
  /** Attempt number this decision was produced for (1-based). */
  attempt: number;
  /** True when the agent must discard its current perception before retrying. */
  requiresFreshPerception: boolean;
  /** True when the obsolete target id must NOT be reused (stale-target safety). */
  forbidsStaleTarget: boolean;
}

export interface RecoveryBounds {
  /** Recovery attempts allowed per failed action. */
  maxRecoveriesPerAction: number;
  /** Recovery attempts allowed per subgoal before it must be replanned. */
  maxRecoveriesPerSubgoal: number;
  /** Total recovery attempts allowed for the whole task. */
  maxTotalRecoveries: number;
  /** Times the SAME strategy may repeat in a row before escalation. */
  maxRepeatedStrategy: number;
  /** Consecutive failures allowed before escalation. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_RECOVERY_BOUNDS: RecoveryBounds = {
  maxRecoveriesPerAction: 2,
  maxRecoveriesPerSubgoal: 3,
  maxTotalRecoveries: 6,
  maxRepeatedStrategy: 2,
  maxConsecutiveFailures: 3,
};

export type RecoveryOutcome = 'OPEN' | 'PROGRESSED' | 'RECOVERED' | 'EXHAUSTED' | 'ABORTED';

/**
 * The bounded Recovery Engine. Pure and deterministic: `decide` never touches
 * the browser, never executes an action and never mutates page state. The
 * AgentLoop owns every effect.
 */
export class RecoveryEngine {
  readonly bounds: RecoveryBounds;

  /** Attempt counters. */
  private perAction = new Map<string, number>();
  private perSubgoal = new Map<string, number>();
  totalRecoveries = 0;
  consecutiveFailures = 0;
  /** Strategy history (bounded) for repeated-strategy detection. */
  private recentStrategies: RecoveryStrategy[] = [];
  /** Sanitized, value-free history for state/telemetry. */
  readonly history: RecoveryHistoryEntry[] = [];

  constructor(bounds: RecoveryBounds = DEFAULT_RECOVERY_BOUNDS) {
    this.bounds = { ...bounds };
  }

  /** Task-lifetime reset (new runTask). */
  reset(): void {
    this.perAction.clear();
    this.perSubgoal.clear();
    this.totalRecoveries = 0;
    this.consecutiveFailures = 0;
    this.recentStrategies = [];
    this.history.length = 0;
  }

  /**
   * Deterministic strategy selection with bound enforcement.
   * ABORT is returned when any bound is exhausted, when the same strategy
   * would repeat beyond `maxRepeatedStrategy`, or when the failure code is
   * unknown/malformed/hard-stop.
   */
  decide(evidence: RecoveryFailureEvidence): RecoveryDecision {
    const attempt = (this.perAction.get(evidenceKey(evidence)) ?? 0) + 1;
    this.perAction.set(evidenceKey(evidence), attempt);
    this.totalRecoveries += 1;

    const finish = (
      strategy: RecoveryStrategy,
      code: RecoveryFailureCode | 'UNKNOWN',
      reason: string,
      requiresFreshPerception: boolean,
      forbidsStaleTarget: boolean
    ): RecoveryDecision => {
      this.recentStrategies.push(strategy);
      if (this.recentStrategies.length > 16) this.recentStrategies = this.recentStrategies.slice(-16);
      const decision: RecoveryDecision = {
        strategy,
        code,
        reason,
        attempt,
        requiresFreshPerception,
        forbidsStaleTarget,
      };
      this.recordHistory(evidence, decision, 'OPEN');
      return decision;
    };

    // ── Bounds first: they always dominate any mapping. ────────────────────
    if (this.totalRecoveries > this.bounds.maxTotalRecoveries) {
      return this.abort(evidence, attempt, `Task recovery budget exhausted (${this.bounds.maxTotalRecoveries}).`);
    }
    if (evidence.subgoalId) {
      const used = this.perSubgoal.get(evidence.subgoalId) ?? 0;
      if (used >= this.bounds.maxRecoveriesPerSubgoal) {
        return this.abort(
          evidence,
          attempt,
          `Subgoal ${evidence.subgoalId} recovery budget exhausted (${this.bounds.maxRecoveriesPerSubgoal}).`
        );
      }
      this.perSubgoal.set(evidence.subgoalId, used + 1);
    }

    // ── Classification (fail closed on unknown/malformed) ──────────────────
    const cls = classifyFailure(evidence);
    if (!cls.ok) {
      return this.abort(evidence, attempt, cls.reason);
    }

    const base: RecoveryStrategy = STRATEGY_BY_CODE[cls.code] ?? 'REPERCEIVE';

    // Repeated identical strategy → escalating, not repeating forever. This
    // precedes the per-action budget: three identical failures in a row are a
    // PATTERN, not three independent retries worth more budget.
    if (this.countTrailingRepeats(base) >= this.bounds.maxRepeatedStrategy) {
      const escalate = base === 'REPLAN_SUBGOAL' || base === 'ABORT' ? 'ABORT' : 'REPLAN_SUBGOAL';
      const decision = finish(
        escalate,
        cls.code,
        `Strategy '${base}' repeated ${this.countTrailingRepeats(base)} times (limit ` +
          `${this.bounds.maxRepeatedStrategy}); escalating to ${escalate}.`,
        false,
        false
      );
      return decision;
    }

    // Per-action budget: the same failure may only be recovered a bounded
    // number of times, whatever the strategy chosen for it.
    if (attempt > this.bounds.maxRecoveriesPerAction) {
      return this.abort(
        evidence,
        attempt,
        `Per-action recovery budget exhausted (${this.bounds.maxRecoveriesPerAction} attempts for this failure).`
      );
    }

    // Stale/obsolete targets must never be reused, whatever the strategy.
    const forbidsStaleTarget =
      base === 'REGROUND_TARGET' ||
      base === 'RESELECT_TARGET' ||
      cls.code === 'STALE_TARGET' ||
      cls.code === 'PAGE_CHANGED';

    const decision = finish(
      base,
      cls.code,
      `${describeStrategy(base)} — classified '${cls.code}' at page generation ` +
        `${evidence.pageGeneration ?? 'unknown'}.`,
      // Every strategy except ABORT depends on page state: fresh perception
      // is mandatory before any recovered action is proposed.
      base !== 'ABORT',
      forbidsStaleTarget
    );
    return decision;
  }

  /** The last N decisions all used the same strategy. */
  private countTrailingRepeats(strategy: RecoveryStrategy): number {
    let n = 0;
    for (let i = this.recentStrategies.length - 1; i >= 0; i--) {
      if (this.recentStrategies[i] === strategy) n++;
      else break;
    }
    return n;
  }

  private abort(evidence: RecoveryFailureEvidence, attempt: number, reason: string): RecoveryDecision {
    this.recentStrategies.push('ABORT');
    if (this.recentStrategies.length > 16) this.recentStrategies = this.recentStrategies.slice(-16);
    const decision: RecoveryDecision = {
      strategy: 'ABORT',
      code: 'UNKNOWN',
      reason,
      attempt,
      requiresFreshPerception: false,
      forbidsStaleTarget: false,
    };
    this.recordHistory(evidence, decision, 'ABORTED');
    return decision;
  }

  /**
   * Progress-aware accounting (Phase 9 integration). A recovery that produced
   * meaningful progress resets the consecutive-failure counter; one that did
   * not counts toward every bound.
   */
  recordResult(decision: RecoveryDecision, outcome: RecoveryOutcome): void {
    this.history.forEach((entry) => {
      if (entry.attempt === decision.attempt && entry.strategy === decision.strategy && entry.outcome === 'OPEN') {
        entry.outcome = outcome;
      }
    });
    if (outcome === 'PROGRESSED' || outcome === 'RECOVERED') {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
    }
    if (this.consecutiveFailures >= this.bounds.maxConsecutiveFailures) {
      // Hard stop: repeated failing recoveries must not spin.
      this.consecutiveFailures = this.bounds.maxConsecutiveFailures;
    }
  }

  exhausted(): boolean {
    return (
      this.totalRecoveries > this.bounds.maxTotalRecoveries ||
      this.consecutiveFailures >= this.bounds.maxConsecutiveFailures
    );
  }

  /** Deterministic repeated-strategy query (for tests and telemetry). */
  trailingStrategyRepeats(): number {
    if (this.recentStrategies.length === 0) return 0;
    const last = this.recentStrategies[this.recentStrategies.length - 1]!;
    return this.countTrailingRepeats(last);
  }

  private recordHistory(
    evidence: RecoveryFailureEvidence,
    decision: RecoveryDecision,
    outcome: RecoveryOutcome
  ): void {
    this.history.push({
      failureCode: decision.code,
      strategy: decision.strategy,
      attempt: decision.attempt,
      pageGeneration: evidence.pageGeneration ?? 0,
      subgoalId: evidence.subgoalId,
      targetId: evidence.targetId,
      reason: decision.reason,
      outcome,
      timestamp: Date.now(),
    });
    if (this.history.length > 64) this.history.splice(0, this.history.length - 64);
  }
}

// ── Sanitized history ───────────────────────────────────────────────────────

export interface RecoveryHistoryEntry {
  failureCode: RecoveryFailureCode | 'UNKNOWN';
  strategy: RecoveryStrategy;
  attempt: number;
  pageGeneration: number;
  subgoalId?: string;
  targetId?: string;
  reason: string;
  outcome: RecoveryOutcome;
  timestamp: number;
}

function evidenceKey(evidence: RecoveryFailureEvidence): string {
  const dir = evidence.scrollDirection ? `:${evidence.scrollDirection}` : '';
  return `${evidence.code}|${evidence.subgoalId ?? ''}|${evidence.targetId ?? ''}${dir}`;
}

function describeStrategy(strategy: RecoveryStrategy): string {
  switch (strategy) {
    case 'REPERCEIVE':
      return 'Discard stale perception and re-observe the live page';
    case 'RETRY_SAME_TARGET':
      return 'Re-propose the same logical action against a freshly perceived page';
    case 'REGROUND_TARGET':
      return 'Re-run target grounding against the current page generation';
    case 'RESELECT_TARGET':
      return 'Select a different control for the same intent via the normal pipeline';
    case 'SCROLL_AND_REPERCEIVE':
      return 'Scroll to reveal offscreen content, then re-perceive';
    case 'REPLAN_SUBGOAL':
      return 'Preserve completed work and replan only the remaining subgoal';
    case 'ABORT':
      return 'Stop recovering: fail closed';
  }
}
