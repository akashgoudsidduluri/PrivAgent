/**
 * PHASE 18.8 / A14 — SIDE-EFFECT IDEMPOTENCY / UNCERTAIN COMMIT.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * A consequential action that fails (`success: false`, a navigation that may or
 * may not have committed, a submit whose response never arrived) used to count
 * as an ordinary execution failure. The recovery path then RETRIED it. For
 * "buy", "submit", "send", "delete", "transfer" and "create", that retry is not
 * a recovery — it is a possible SECOND order, SECOND message or SECOND
 * transfer, produced by an agent that never established whether the first one
 * happened.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * `COMMIT_UNKNOWN` is a first-class outcome, not a flavour of failure:
 *
 *   1. `executionSuccess` is NOT proof of a commit, and neither is model prose;
 *   2. an unresolved commit BLOCKS the same class of action from being
 *      dispatched again — the guard is on the ACTION CLASS, not on equality
 *      with the previous action;
 *   3. the only way out is to re-perceive and VERIFY EXTERNAL STATE (an order
 *      id, a cart count, a confirmation heading, a changed URL) or to ask the
 *      user. Nothing else retries;
 *   4. the verdict is derived from OBSERVED state only. "The model said it
 *      worked" is never an input to it.
 *
 * This module is PURE and local: no I/O, no clock, no model. It grants no
 * authority — grounding, M5, the security critic, risk/confirmation and effect
 * verification all still run before anything is dispatched, and this contract
 * can only ever REMOVE a dispatch, never authorise one.
 *
 * ── How an open commit is closed ────────────────────────────────────────────
 * Exactly two things can settle it:
 *
 *   a. the effect verifier's own OBSERVED verdict for the step (a real DOM, URL,
 *      value or modal change), or
 *   b. a re-perception that shows CONFIRMATION wording or FAILURE wording on the
 *      page itself.
 *
 * Absent both, the commit STAYS open and the run stops for the user. Note the
 * asymmetry that makes this fail-safe: the device may only conclude "it
 * committed" or "it failed" from POSITIVE page evidence. Observing a page that
 * merely does not mention the outcome is not evidence of failure, and is never
 * treated as one — that inference is exactly what a duplicate order is built on.
 */

import type { EffectStatus } from './effectVerifier';

/** What kind of externally mutating work the action represents. */
export type ConsequentialClass = 'NONE' | 'BUY' | 'SUBMIT' | 'SEND' | 'DELETE' | 'TRANSFER' | 'CREATE';

/**
 * The certainty of an externally visible commit. These are deliberately
 * distinct from the effect verifier's own vocabulary: the effect verifier asks
 * "did the DOM change", this asks "did the WORLD change, and do we know".
 */
export type CommitCertainty =
  | 'EFFECT_VERIFIED'
  | 'EFFECT_NOT_OBSERVABLE'
  | 'EFFECT_UNVERIFIED'
  | 'COMMIT_UNKNOWN';

export type CommitCode =
  | 'NOT_CONSEQUENTIAL'
  | 'EFFECT_OBSERVED'
  | 'EFFECT_NOT_OBSERVABLE'
  | 'EXECUTION_FAILED'
  | 'EFFECT_UNVERIFIED'
  | 'RESOLVED_COMMITTED'
  | 'RESOLVED_NOT_COMMITTED';

/**
 * Page-derived wording that a consequential action could have produced. Bounded,
 * local and deliberately specific: a pre-action page does not contain an "order
 * confirmed" or "payment declined" sentence, so observing one after the action
 * is evidence about the action. Matched against page-derived labels only — never
 * against the model's narration.
 */
const CONFIRMATION_MARKERS: readonly string[] = [
  'order confirmed',
  'order placed',
  'order complete',
  'order number',
  'order #',
  'your order',
  'thank you for your order',
  'purchase complete',
  'payment successful',
  'payment received',
  'payment complete',
  'confirmation number',
  'reference number',
  'successfully submitted',
  'submitted successfully',
  'message sent',
  'sent successfully',
  'transfer complete',
  'transfer successful',
  'successfully deleted',
  'deletion complete',
  'account created',
  'successfully created',
  "you're all set",
] as const;

const FAILURE_MARKERS: readonly string[] = [
  'payment failed',
  'payment declined',
  'order failed',
  'transaction failed',
  'transfer failed',
  'failed to submit',
  'could not be sent',
  'could not be completed',
  "couldn't be completed",
  'unable to complete',
  'was not placed',
  'not been placed',
  'failed to send',
  'could not send',
  'not sent',
  'unsuccessful',
  'try again',
  'something went wrong',
  'error occurred',
] as const;

export type CommitResolution =
  | 'PROCEED'
  | 'BLOCK_DUPLICATE'
  | 'RE_PERCEIVE'
  | 'VERIFY_EXTERNAL'
  | 'CONFIRM_WITH_USER';

export interface CommitRecord {
  readonly step: number;
  readonly actionClass: ConsequentialClass;
  /** Fixed vocabulary — never the model's own words about what happened. */
  readonly certainty: CommitCertainty;
  readonly code: CommitCode;
  /** True while the commit has NOT been established either way. */
  readonly unresolved: boolean;
  readonly at: number;
}

/**
 * Classify an action locally. Deterministic, keyword-driven, and it only ever
 * makes an action MORE careful — the words are matched against the ACTION the
 * device is about to dispatch, plus the user's own task, never against model
 * narration of a past event.
 *
 * Two deliberate limits keep this from over-reaching:
 *
 *   1. an action that cannot dispatch a mutation (scroll, navigate) is NEVER
 *      classified from wording, so a task that mentions deleting something
 *      cannot make a scroll look like a deletion;
 *   2. the TASK's wording may only elevate a dispatch-capable action (click,
 *      pressKey) — that is the case where a vague target id hides what the
 *      button really is.
 */
export function classifyConsequential(input: {
  action: { action: string; type?: string; target?: unknown; url?: unknown; text?: unknown };
  task?: string;
}): ConsequentialClass {
  const type = String(input.action?.type ?? '').toLowerCase();
  const act = String(input.action?.action ?? '').toLowerCase();
  const target = String(input.action?.target ?? input.action?.text ?? '').toLowerCase();
  const url = String(input.action?.url ?? '').toLowerCase();
  const task = String(input.task ?? '').toLowerCase();

  const dispatchesMutation = act === 'click' || act === 'presskey' || act === 'type' || act === 'select';
  const wording = dispatchesMutation ? `${target} ${url}` : '';
  const taskWording = act === 'click' || act === 'presskey' ? task : '';

  const says = (words: readonly string[], haystack: string) =>
    haystack.length > 0 && words.some((w) => haystack.includes(w));

  if (type === 'buy' || says(['buy now', 'place order', 'checkout now', 'complete purchase'], wording)) {
    return 'BUY';
  }
  if (says(['delete', 'remove item', 'cancel order', 'close account'], wording) || says(['delete '], taskWording)) {
    return 'DELETE';
  }
  if (says(['transfer', 'send money', 'wire', 'remit'], wording) || says(['transfer ', 'send money'], taskWording)) {
    return 'TRANSFER';
  }
  if (
    says(['submit', 'send message', 'send email', 'post comment', 'reply'], wording) ||
    (type === 'submit' && !url)
  ) {
    return 'SUBMIT';
  }
  if (says(['send'], wording) && !url.startsWith('mailto:')) return 'SEND';
  if (type === 'create' || says(['create account', 'sign up', 'add new', 'new order'], wording)) {
    return 'CREATE';
  }
  return 'NONE';
}

/** True for every class that can change the world outside this browser. */
export function isConsequential(actionClass: ConsequentialClass): boolean {
  return actionClass !== 'NONE';
}

export interface CommitAssessmentInput {
  readonly actionClass: ConsequentialClass;
  readonly executionSuccess: boolean;
  readonly step?: number;
  readonly at?: number;
}

export interface CommitAssessment {
  readonly certainty: CommitCertainty;
  readonly code: CommitCode;
  readonly resolution: CommitResolution;
  readonly unresolved: boolean;
  readonly record: CommitRecord | null;
}

/**
 * Decide what the device knows about a commit AFTER an action was dispatched.
 *
 * `executionSuccess` says the call returned, not that the world changed, so it
 * is deliberately insufficient on its own: a successful click whose navigation
 * was swallowed is still unverified.
 */
export function assessCommit(input: CommitAssessmentInput): CommitAssessment {
  const { actionClass, executionSuccess } = input;
  const at = input.at ?? 0;
  const step = input.step ?? 0;

  const finish = (
    certainty: CommitCertainty,
    code: CommitCode,
    resolution: CommitResolution,
    unresolved: boolean
  ): CommitAssessment => ({
    certainty,
    code,
    resolution,
    unresolved,
    record: isConsequential(actionClass)
      ? { step, actionClass, certainty, code, unresolved, at }
      : null,
  });

  if (!isConsequential(actionClass)) {
    return finish('EFFECT_VERIFIED', 'NOT_CONSEQUENTIAL', 'PROCEED', false);
  }
  if (!executionSuccess) {
    // The call failed. Whether the server acted is unknown.
    return finish('COMMIT_UNKNOWN', 'EXECUTION_FAILED', 'VERIFY_EXTERNAL', true);
  }
  // The call returned, but at assessment time nothing has been observed either
  // way. On a consequential action this is the classic double-submit shape, so
  // the commit starts UNRESOLVED and only the effect verifier or a fresh
  // perception can close it.
  return finish('EFFECT_UNVERIFIED', 'EFFECT_UNVERIFIED', 'VERIFY_EXTERNAL', true);
}

/**
 * Close an open commit with the effect verifier's own verdict for the step.
 *
 * `hasEffect` true means the browser was OBSERVED to change (URL, DOM, value,
 * modal, scroll, focus). On a consequential action that observed change is
 * treated as the commit having landed, which is the fail-SAFE direction: the
 * cost of wrongly believing a purchase succeeded is a report the user can check,
 * while the cost of wrongly believing it failed is a SECOND purchase. Everything
 * the verifier could not observe leaves the commit open.
 */
export function settleCommitWithEffect(
  record: CommitRecord,
  effect: { readonly effectVerified: boolean; readonly effectStatus: EffectStatus }
): CommitRecord {
  if (effect.effectVerified) {
    return Object.freeze({
      ...record,
      certainty: 'EFFECT_VERIFIED' as const,
      code: 'RESOLVED_COMMITTED' as const,
      unresolved: false,
    });
  }
  if (effect.effectStatus === 'EFFECT_UNVERIFIABLE') {
    // The verifier looked and could not tell. Not a failure — unknown.
    return Object.freeze({
      ...record,
      certainty: 'EFFECT_NOT_OBSERVABLE' as const,
      code: 'EFFECT_NOT_OBSERVABLE' as const,
      unresolved: true,
    });
  }
  // Observed and nothing moved. The action is still unresolved in the world:
  // a swallowed response can look exactly like this.
  return Object.freeze({
    ...record,
    certainty: 'EFFECT_UNVERIFIED' as const,
    code: 'EFFECT_UNVERIFIED' as const,
    unresolved: true,
  });
}

/**
 * May THIS action be dispatched, given the commits already made?
 *
 * The guard is on the ACTION CLASS: a pending `SUBMIT` blocks another submit
 * whether or not the two actions are textually identical, because the failure
 * mode being prevented is the duplicate commit, not the duplicate string.
 */
export function mayDispatchConsequential(
  actionClass: ConsequentialClass,
  openCommits: readonly CommitRecord[]
): { allowed: boolean; blockedBy?: CommitRecord } {
  if (!isConsequential(actionClass)) return { allowed: true };
  const open = openCommits.find((c) => c.unresolved && c.actionClass === actionClass);
  return open ? { allowed: false, blockedBy: open } : { allowed: true };
}

export interface ExternalStateObservation {
  /** Observed, page-derived markers. Empty means "nothing observed". */
  readonly markers?: readonly string[];
  readonly currentUrl?: string | null;
  /** The marker the device expected this action to produce, if any. */
  readonly expectedMarker?: string | null;
  /** The URL the action was expected to land on, if any. */
  readonly expectedUrl?: string | null;
}

export interface ExternalVerification {
  readonly status: 'COMMITTED' | 'NOT_COMMITTED' | 'UNKNOWN';
  readonly code:
    | 'EXPECTED_MARKER_PRESENT'
    | 'EXPECTED_URL_REACHED'
    | 'CONFIRMATION_OBSERVED'
    | 'FAILURE_OBSERVED'
    | 'NOTHING_OBSERVED';
  readonly certainty: CommitCertainty;
  readonly resolved: boolean;
  /** The page wording the verdict is built on, for the evidence ledger. */
  readonly evidence: string | null;
}

/** True for the codes that mean "the world shows it happened". */
export function isCommittedCode(code: ExternalVerification['code']): boolean {
  return (
    code === 'EXPECTED_MARKER_PRESENT' ||
    code === 'EXPECTED_URL_REACHED' ||
    code === 'CONFIRMATION_OBSERVED'
  );
}

/**
 * Verify an UNRESOLVED commit against freshly observed external state.
 *
 * Pure: it reads what the device observed and nothing else. Model prose is not
 * an input — there is no parameter for it.
 */
export function verifyExternalCommit(
  observation: ExternalStateObservation,
  open: CommitRecord
): ExternalVerification {
  const markers = (observation.markers ?? [])
    .map((m) => String(m).toLowerCase())
    .filter((m) => m.length > 0);
  const url = (observation.currentUrl ?? '').toLowerCase();
  const expectedMarker = (observation.expectedMarker ?? '').toLowerCase();
  const expectedUrl = (observation.expectedUrl ?? '').toLowerCase();

  const seen = (words: readonly string[]): string | null =>
    words.find((w) => markers.some((m) => m.includes(w))) ?? null;

  if (expectedMarker && markers.some((m) => m.includes(expectedMarker))) {
    return {
      status: 'COMMITTED',
      code: 'EXPECTED_MARKER_PRESENT',
      certainty: 'EFFECT_VERIFIED',
      resolved: true,
      evidence: expectedMarker,
    };
  }
  if (expectedUrl && url && url.includes(expectedUrl)) {
    return {
      status: 'COMMITTED',
      code: 'EXPECTED_URL_REACHED',
      certainty: 'EFFECT_VERIFIED',
      resolved: true,
      evidence: expectedUrl,
    };
  }
  const confirmed = seen(CONFIRMATION_MARKERS);
  if (confirmed) {
    return {
      status: 'COMMITTED',
      code: 'CONFIRMATION_OBSERVED',
      certainty: 'EFFECT_VERIFIED',
      resolved: true,
      evidence: confirmed,
    };
  }
  // Only POSITIVE failure wording is allowed to unblock a retry. An observed
  // page that merely fails to mention the outcome proves nothing about the
  // world, and is deliberately left UNKNOWN below.
  const failed = seen(FAILURE_MARKERS);
  if (failed) {
    return {
      status: 'NOT_COMMITTED',
      code: 'FAILURE_OBSERVED',
      certainty: 'EFFECT_UNVERIFIED',
      resolved: true,
      evidence: failed,
    };
  }
  return {
    status: 'UNKNOWN',
    code: 'NOTHING_OBSERVED',
    certainty: 'COMMIT_UNKNOWN',
    resolved: false,
    evidence: null,
  };
}

/** The user-facing sentence for an unresolved commit. Never an internal code. */
export function unresolvedCommitMessage(actionClass: ConsequentialClass): string {
  const noun =
    actionClass === 'BUY'
      ? 'the purchase'
      : actionClass === 'SUBMIT'
        ? 'the form submission'
        : actionClass === 'SEND'
          ? 'the message'
          : actionClass === 'DELETE'
            ? 'the deletion'
            : actionClass === 'TRANSFER'
              ? 'the transfer'
              : actionClass === 'CREATE'
                ? 'the new item'
                : 'the action';
  return `I could not confirm whether ${noun} went through, so I stopped instead of trying again and risking a duplicate.`;
}

/**
 * Replace the open record with the verified outcome. Returns a NEW array.
 *
 * An INCONCLUSIVE verification leaves the record open — it may never be closed
 * by the absence of evidence, because that is the state a duplicate commit would
 * be dispatched from.
 */
export function resolveCommit(
  records: readonly CommitRecord[],
  open: CommitRecord,
  verification: ExternalVerification
): CommitRecord[] {
  if (!verification.resolved) {
    return records.map((r) =>
      r === open ? Object.freeze({ ...r, certainty: verification.certainty, unresolved: true }) : r
    );
  }
  return records.map((r) =>
    r === open
      ? Object.freeze({
          ...r,
          certainty: verification.certainty,
          code: isCommittedCode(verification.code)
            ? ('RESOLVED_COMMITTED' as const)
            : ('RESOLVED_NOT_COMMITTED' as const),
          unresolved: false,
        })
      : r
  );
}