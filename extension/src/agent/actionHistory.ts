/**
 * PHASE 18.7 / A6 — TRUTHFUL ACTION HISTORY.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 * --------------------------------------
 * Action history is the ONLY channel through which the reasoner learns what
 * actually happened on its previous proposals. Before this module the loop
 * pushed raw `BrowserAction`s into that channel and bolted on an `effect`
 * string derived ad hoc at the call site. That conflated three independent
 * facts into one:
 *
 *   1. Did the action get DISPATCHED at all?      (a gate may have refused it)
 *   2. Did EXECUTION succeed?                     (dispatched, then threw)
 *   3. Did an EFFECT get independently VERIFIED?  (EffectVerifier observed it)
 *
 * An action that was refused by Grounding/M5/Security Critic/Containment never
 * ran, but it was indistinguishable from one that ran and changed the page. An
 * action that ran and threw was indistinguishable from one that ran and had no
 * effect. The reasoner could not tell "the page did not move" from "nothing
 * happened because I was blocked", so it re-proposed the same blocked action.
 *
 * That is not a prompt-quality problem. It is a missing type.
 *
 * THE CONTRACT
 * ------------
 * `DispatchStatus` answers "did it run?". `EffectStatus` answers "did an
 * independent observer see a change?". They are separate unions and are never
 * derived from one another. Specifically:
 *
 *   - `POLICY_BLOCKED`   — a gate refused it. NOTHING executed.
 *   - `EXECUTION_FAILED` — it was dispatched and threw.
 *   - `DISPATCHED`       — it ran. Says nothing about effect.
 *   - `NOT_DISPATCHED`   — proposed, never handed to the executor at all.
 *
 * and effect is `NOT_APPLICABLE` unless EffectVerifier actually observed
 * something; `EFFECT_UNVERIFIABLE` when observation was attempted but could
 * not settle it. `EFFECT_VERIFIED` is only reachable from a real observed
 * effect status — never from `executionSuccess`, never from "it dispatched".
 *
 * SECURITY POSTURE — UNCHANGED
 * ----------------------------
 * This module is a PROJECTION, not a gate. It grants no permission, reorders
 * no gate, and cannot make a blocked action look executable. Its only power is
 * the negative one: `assertTruthfulHistory` REFUSES to hand out a history that
 * claims an effect nobody verified. That is strictly more conservative than the
 * pre-existing behaviour.
 *
 * The existing `historyContract.ts` shape gate is untouched and still runs
 * AFTER this projection, so the 422-prevention behaviour is preserved.
 */
import type { BrowserAction } from './actionTypes';
import type { EffectStatus } from './effectVerifier';
import type { StepRecord } from './agentState';

/**
 * Did the action reach the executor?
 *
 * `DISPATCHED` means ONLY that it ran. It is never evidence that anything
 * changed, and never evidence that the goal advanced.
 */
export type DispatchStatus =
  | 'NOT_DISPATCHED'
  | 'DISPATCHED'
  | 'POLICY_BLOCKED'
  | 'EXECUTION_FAILED';

/**
 * Did an independent observer see a change?
 *
 * `EFFECT_UNVERIFIABLE` and `NO_EFFECT` are deliberately distinct: "I looked
 * and nothing changed" is evidence, "I could not look" is not. Collapsing them
 * is how a loop talks itself into retrying an action that was never observable.
 */
export type HistoryEffectStatus =
  | 'EFFECT_VERIFIED'
  | 'NO_EFFECT'
  | 'EFFECT_UNVERIFIABLE'
  | 'NOT_APPLICABLE';

/**
 * Observation provenance for a single history entry. `STALE` is preserved and
 * never silently downgraded — an entry observed on a superseded page generation
 * must not be read as describing the current page.
 */
export type HistoryObservationState = 'CURRENT' | 'STALE' | 'NOT_APPLICABLE';

export interface ActionHistoryEntry {
  action: BrowserAction;
  dispatchStatus: DispatchStatus;
  effectStatus: HistoryEffectStatus;
  /** Measured scroll movement. `null` when the action was not a scroll. */
  scrollDelta: number | null;
  /** Net change in ledger record count attributable to this step. */
  evidenceDelta: number;
  /** Structural failure code. Never a message, value or page text. */
  failureCode: string | null;
  pageGeneration: number | null;
  observationState: HistoryObservationState;
}

/**
 * Effect statuses that constitute a VERIFIED effect.
 *
 * This set is the ONLY way to reach `EFFECT_VERIFIED`. It is derived from
 * EffectVerifier's own observed-state vocabulary, so the two cannot drift.
 */
const OBSERVED_EFFECT_STATUSES: ReadonlySet<EffectStatus> = new Set<EffectStatus>([
  'EFFECT_OBSERVED',
  'URL_NAVIGATION_OBSERVED',
  'DOM_MUTATION_OBSERVED',
  'MODAL_STATE_CHANGED',
  'SCROLL_CHANGED',
  'VALUE_STATE_CHANGED',
  'FOCUS_SHIFT_OBSERVED',
]);

/**
 * Derive DISPATCH status from a step record.
 *
 * `validationAllowed === false` is the load-bearing signal: the loop sets it
 * when a gate (Grounding, M5, Security Critic, risk/confirmation, containment)
 * refused the action, so NOTHING executed. Treating that as a dispatched action
 * is precisely the conflation that made the model retry blocked work.
 */
export function classifyDispatchStatus(step: Pick<StepRecord, 'validationAllowed' | 'executionSuccess'>): DispatchStatus {
  if (!step.validationAllowed) return 'POLICY_BLOCKED';
  if (!step.executionSuccess) return 'EXECUTION_FAILED';
  return 'DISPATCHED';
}

/**
 * Derive EFFECT status from a step record.
 *
 * Deliberately reads `effectVerified` + `effectStatus` ONLY. It never reads
 * `executionSuccess`, and never infers an effect from the action's shape.
 */
export function classifyEffectStatus(
  step: Pick<StepRecord, 'effectVerified' | 'effectStatus' | 'executionSuccess' | 'validationAllowed'>,
  dispatchStatus: DispatchStatus,
): HistoryEffectStatus {
  // Nothing ran, so there is nothing to have had an effect. Not `NO_EFFECT`:
  // that would claim an observer looked and saw nothing.
  if (dispatchStatus === 'POLICY_BLOCKED' || dispatchStatus === 'NOT_DISPATCHED') {
    return 'NOT_APPLICABLE';
  }
  // It ran and threw. The EffectVerifier verdict is still whatever it recorded.
  if (!step.effectVerified && !step.effectStatus) return 'EFFECT_UNVERIFIABLE';
  if (step.effectStatus === 'ACTION_NO_EFFECT') return 'NO_EFFECT';
  if (step.effectStatus === 'EFFECT_UNVERIFIABLE') return 'EFFECT_UNVERIFIABLE';
  if (step.effectVerified && step.effectStatus && OBSERVED_EFFECT_STATUSES.has(step.effectStatus)) {
    return 'EFFECT_VERIFIED';
  }
  return 'EFFECT_UNVERIFIABLE';
}

/** Build one truthful history entry from a recorded step. */
export function buildActionHistoryEntry(
  step: StepRecord,
  options: { evidenceDelta?: number; currentPageGeneration?: number } = {},
): ActionHistoryEntry {
  const dispatchStatus = classifyDispatchStatus(step);
  const effectStatus = classifyEffectStatus(step, dispatchStatus);
  const generation =
    typeof step.currentPageGeneration === 'number' ? step.currentPageGeneration : null;
  const observationState: HistoryObservationState =
    dispatchStatus === 'NOT_DISPATCHED'
      ? 'NOT_APPLICABLE'
      : generation === null
        ? 'NOT_APPLICABLE'
        : options.currentPageGeneration !== undefined && generation !== options.currentPageGeneration
          ? 'STALE'
          : 'CURRENT';
  const action = step.action as unknown as BrowserAction;
  const scrollDelta =
    action && action.action === 'scroll' && typeof action.scrollDelta === 'number' ? action.scrollDelta : null;
  return {
    action,
    dispatchStatus,
    effectStatus,
    scrollDelta,
    evidenceDelta: options.evidenceDelta ?? 0,
    // A failure code is carried by every NON-DISPATCHED entry. Reading
    // `executionSuccess` here instead is wrong: the confirmed-dispatch path
    // sets `executionSuccess: true` even when a gate refused, so a blocked
    // action would have reported no reason at all — exactly the entry the
    // reasoner most needs to be told about.
    failureCode:
      dispatchStatus === 'DISPATCHED'
        ? null
        : (step.validationReason || step.executionError || dispatchStatus),
    pageGeneration: generation,
    observationState,
  };
}

/**
 * THE TRUTHFULNESS INVARIANT.
 *
 * Returns a list of violated rules — empty means the history is internally
 * consistent. Every rule below is a shortcut that, if taken, lets the reasoner
 * believe something the system never established.
 */
export function findHistoryTruthfulnessViolations(
  entries: readonly ActionHistoryEntry[],
): string[] {
  const violations: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const at = `history[${i}]`;

    // 1. A refused action never executed, so it cannot have had an effect.
    if (e.dispatchStatus === 'POLICY_BLOCKED' && e.effectStatus !== 'NOT_APPLICABLE') {
      violations.push(`${at}: POLICY_BLOCKED must have effectStatus NOT_APPLICABLE, saw ${e.effectStatus}`);
    }
    if (e.dispatchStatus === 'NOT_DISPATCHED' && e.effectStatus !== 'NOT_APPLICABLE') {
      violations.push(`${at}: NOT_DISPATCHED must have effectStatus NOT_APPLICABLE, saw ${e.effectStatus}`);
    }

    // 2. A failed execution has no verified effect.
    if (e.dispatchStatus === 'EXECUTION_FAILED' && e.effectStatus === 'EFFECT_VERIFIED') {
      violations.push(`${at}: EXECUTION_FAILED cannot be EFFECT_VERIFIED`);
    }

    // 3. THE headline shortcut: dispatch is not effect. An action that merely
    //    ran may report any non-verified status; it may never report a verified
    //    one unless the EffectVerifier recorded an OBSERVED status — which
    //    `classifyEffectStatus` already guarantees. The invariant below catches
    //    any caller that constructs an entry directly.
    //
    //    The specific, SOUND case: the verifier recorded `SCROLL_CHANGED`
    //    (i.e. it observed the page move) while the measured delta is 0. Those
    //    two facts contradict each other, so the entry is not trustworthy.
    //    A zero-delta scroll that produced new evidence is NOT a violation —
    //    lazy-loaded content legitimately adds evidence without moving — so
    //    that case is deliberately permitted.
    if (
      e.action &&
      e.action.action === 'scroll' &&
      e.scrollDelta === 0 &&
      (e.action as unknown as { effect?: string }).effect === 'SCROLL_CHANGED'
    ) {
      violations.push(`${at}: SCROLL_CHANGED observed with scrollDelta 0 is self-contradictory`);
    }

    // 5. Stale observation must not be presented as current.
    if (e.observationState === 'STALE' && e.pageGeneration === null) {
      violations.push(`${at}: STALE entry must retain its pageGeneration`);
    }
  }
  return violations;
}

/**
 * Fail-closed assertion over the projected history.
 *
 * Called at the ONE model-facing egress. If the projection is internally
 * inconsistent the turn is refused rather than sending the reasoner a history
 * that claims unverified effects — the same fail-closed posture the whole
 * privacy/verification architecture uses elsewhere.
 */
export function assertTruthfulHistory(entries: readonly ActionHistoryEntry[]): void {
  const violations = findHistoryTruthfulnessViolations(entries);
  if (violations.length > 0) {
    throw new Error(
      `[PrivAgent History] refusing to send a non-truthful action history: ${violations.join('; ')}`,
    );
  }
}

/**
 * Project a truthful entry back into the wire shape the backend accepts.
 *
 * The backend's `BrowserActionModel` is `extra='forbid'`; this projection adds
 * nothing new to the wire. It exists so the reasoner can read the verdict from
 * the `effect` string, which it already accepts.
 */
export function toWireAction(entry: ActionHistoryEntry): BrowserAction {
  const a = entry.action as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = { ...a, effect: entry.effectStatus };
  if (entry.scrollDelta !== null) projected.scrollDelta = entry.scrollDelta;
  // A policy-blocked or failed entry must not look like it ran.
  if (entry.dispatchStatus !== 'DISPATCHED') projected.reason = entry.failureCode ?? 'NOT_DISPATCHED';
  return projected as unknown as BrowserAction;
}

/** Compact, value-free description used in the model-facing decision state. */
export function describeActionHistory(entry: ActionHistoryEntry): string {
  const parts = [
    `${entry.action.action}`,
    `dispatch=${entry.dispatchStatus}`,
    `effect=${entry.effectStatus}`,
  ];
  if (entry.scrollDelta !== null) parts.push(`scrollDelta=${entry.scrollDelta}`);
  if (entry.evidenceDelta !== 0) parts.push(`evidenceDelta=${entry.evidenceDelta}`);
  if (entry.observationState !== 'NOT_APPLICABLE') parts.push(`observation=${entry.observationState}`);
  return parts.join(' ');
}