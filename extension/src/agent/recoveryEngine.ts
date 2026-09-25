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
  return `${evidence.code}|${evidence.subgoalId ?? ''}|${evidence.targetId ?? ''}`;
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
