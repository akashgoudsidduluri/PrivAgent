/**
 * PrivAgent — Phase 14: Agent Interaction & Output Layer
 *
 * A pure, read-only PROJECTION of agent state into a small, value-free,
 * user-facing interaction state — plus the output-privacy boundary that every
 * user-facing string must cross.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * PrivAgent's core is strong: task → Harness → AgentLoop → perception →
 * planning → security gates → browser → verification → recovery. What it has
 * never had is a way to TALK to the user while it does that.
 *
 * The dashboard currently receives the raw `AgentTaskState` and infers a
 * "current stage" by substring-matching an English `reason` string. It drops
 * eleven state fields. There is no result, no live activity line, and no
 * structured terminal outcome — only internal prose.
 *
 * This module is the missing translation. It is a PROJECTION, nothing more.
 *
 * ── The three rules that make it safe ──────────────────────────────────────
 *
 *   1. READ-ONLY AND ONE-WAY. It takes state and returns a new value. It has
 *      no write path back into `AgentTaskState`, no callback, no side effect.
 *      It therefore cannot influence the loop, the Harness, containment, or
 *      any security gate. There is no code path from here back into authority.
 *
 *   2. NARROWING. The projection is strictly smaller than its input. It can
 *      only OMIT. It never invents a fact the agent did not already compute.
 *
 *   3. NO CHAIN-OF-THOUGHT. The user sees operational status, never reasoning.
 *      Internal `reason` prose, validation reasons, execution errors, model
 *      rationale and the decision trace are READ INTERNALLY to classify an
 *      outcome into a stable code, and then DISCARDED. Only closed-vocabulary
 *      codes and composed headlines cross the boundary.
 *
 * ── The output-privacy seam ────────────────────────────────────────────────
 *
 * `screenAgentOutput()` is that seam, and it is deliberately minimal: it uses
 * the EXISTING `scanForRawSensitiveValues` primitive and nothing else. No new
 * classification system, no NLP, no OCR, no fusion engine.
 *
 * It runs in the SERVICE WORKER, immediately before `sendToDashboard` — the
 * same last-line position the service worker already uses for dispatch-time
 * containment. The two are mirror images:
 *
 *     CONTAINMENT (Phase 12)  protects what the agent DOES
 *     OUTPUT SCREEN (Phase 14) protects what the agent SAYS
 *
 * Screening in the frontend would be display-time cosmetics, not a boundary.
 * Anything can be sent from a browser tab; the service worker is the last
 * place the data is still ours.
 *
 * It FAILS CLOSED. A malformed projection is not displayed — it is replaced
 * with a safe, empty, terminal-FAILED interaction state. A raw-value shape
 * found in a STRUCTURAL field (a closed-vocabulary code) means the projection
 * is corrupt, and the whole payload is dropped rather than half-trusted.
 */

import type { AgentTaskState } from './agentState';
import { userFacingMessageForStatus } from './agentState';
// PHASE 18.8 / A14 — the fixed per-action sentence for an unconfirmed commit.
// Imported so the wording lives in ONE place and cannot drift into prose.
import { unresolvedCommitMessage } from './commitCertainty';
// PHASE 18.8 / A16 — the fixed per-state sentence for a freshness stop.
import { freshnessStopMessage } from './actionFreshness';
import type { PlanningEngineState } from '../hierarchicalPlanning/hierarchicalTypes';
import type { ContainmentCode } from './containment';
import { scanForRawSensitiveValues, type RawValueRule } from '../privacy/rawValueScanner';

// ── Public vocabulary ────────────────────────────────────────────────────────

/** The user-visible lifecycle. Closed vocabulary; never free text. */
export type AgentOutcome =
  | 'IDLE'
  | 'RUNNING'
  | 'AWAITING_CONFIRMATION'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'STOPPED'
  /**
   * PHASE 18.8 / B1 — the A9 information outcomes, additively and separately
   * from SUCCEEDED. `ANSWERED` means the device produced an answer (in full or
   * in part) from verified evidence; `UNANSWERED` means this page could not
   * verify anything. NEITHER is a task SUCCESS — only the GoalVerifier may
   * report that, and it is untouched.
   */
  | 'ANSWERED'
  | 'UNANSWERED';

/**
 * Where the agent is, as a coarse operational phase. Derived from the EXISTING
 * `planningEngineState` (14 real states) rather than by guessing from prose.
 */
export type AgentActivityPhase =
  | 'IDLE'
  | 'PERCEPTION'
  | 'PLANNING'
  | 'VALIDATION'
  | 'EXECUTION'
  | 'VERIFICATION'
  | 'RECOVERY'
  | 'AWAITING_CONFIRMATION'
  | 'TERMINAL';

/**
 * Why a run ended, as a stable code. This is what replaces the internal
 * `reason` prose at the user boundary: the classification reads prose locally,
 * and only the CODE is ever surfaced.
 */
export type AgentTerminalReason =
  | 'GOAL_ACHIEVED'
  | 'STOPPED_BY_USER'
  /** PHASE 18.8 / A12 — a newer task replaced this run. */
  | 'SUPERSEDED_BY_NEW_TASK'
  | 'CONTAINMENT_DENIED'
  | 'HARNESS_HALTED'
  | 'RECOVERY_EXHAUSTED'
  | 'STEP_BOUND_EXHAUSTED'
  | 'REASONER_FAILED'
  | 'PERCEPTION_FAILED'
  | 'CONFIRMATION_DECLINED'
  /** PHASE 18.8 / B1 — an information run ended with verified evidence. */
  | 'ANSWERED'
  /** PHASE 18.8 / B1 — an information run ended without a verifiable result. */
  | 'NO_VERIFIABLE_RESULT'
  /** PHASE 18.8 / A13 — a reference the local resolver refused to guess. */
  | 'NEEDS_CLARIFICATION'
  /** PHASE 18.8 / A14 — the run ended with a consequential commit unconfirmed. */
  | 'COMMIT_UNVERIFIED'
  /** PHASE 18.8 / A16 — the run ended because the view had moved on. */
  | 'FRESHNESS_UNVERIFIED'
  /**
   * FINAL ACCEPTANCE AUDIT — an ordinary conversation was answered directly.
   *
   * Distinct from `ANSWERED` on purpose: `ANSWERED` says the device answered
   * from evidence it verified on the page, which is true of the browser pipeline
   * and FALSE of a general knowledge answer. Reusing it here would put "Answered
   * from evidence verified on this page" above an answer about TCP, for a run
   * that never read a page.
   */
  | 'CONVERSATIONAL_ANSWER'
  | 'UNKNOWN';

export interface AgentActivity {
  phase: AgentActivityPhase;
  /** Concise operational status. Composed from a fixed table, never raw. */
  summary: string;
  step: number;
  maxSteps: number;
  /** The Phase 13 harness cycle counter, when a harness is armed. */
  cycle: number | null;
}

export interface AgentTerminal {
  outcome: Extract<AgentOutcome, 'SUCCEEDED' | 'FAILED' | 'STOPPED' | 'ANSWERED' | 'UNANSWERED'>;
  reason: AgentTerminalReason;
  /** Composed headline. Never the internal `state.reason` string. */
  headline: string;
}

export interface AgentResultItem {
  id: string;
  /** Page-derived display text. THE highest-risk field in the output, and
   *  therefore the field `screenAgentOutput` exists to guard. */
  title: string;
  detail: string;
}

export interface AgentResult {
  kind: 'NONE' | 'FINDINGS' | 'CANDIDATES';
  summary: string;
  count: number;
  items: AgentResultItem[];
}

export type AgentArtifactKind =
  | 'CONTAINMENT'
  | 'HARNESS'
  | 'RECOVERY'
  | 'FAILURE'
  | 'PERCEPTION';

export interface AgentArtifact {
  kind: AgentArtifactKind;
  /** Value-free label, e.g. `contained:google.com` or a failure code. */
  label: string;
}

export interface AgentTimelineEntry {
  step: number;
  /** Action type only — 'click', 'navigate', … never a target or a value. */
  action: string;
  outcome: 'EXECUTED' | 'BLOCKED' | 'FAILED' | 'CONFIRMED';
}

export interface AgentInteractionState {
  outcome: AgentOutcome;
  activity: AgentActivity;
  terminal: AgentTerminal | null;
  result: AgentResult;
  artifacts: AgentArtifact[];
  /** Bounded, value-free operational history. Never reasoning. */
  timeline: AgentTimelineEntry[];
  awaitingConfirmation: {
    action: string;
    description: string;
    riskLevel: string;
  } | null;
  /**
   * PHASE 18.8 / B1 — THE FINAL RESULT. Always present; `kind: 'NONE'` before
   * there is one.
   *
   * This is the layer that answers the user: the ANSWER for an information
   * task, the partial result, the cannot-verify notice, the needs-information
   * prompt, or a user-safe failure/provider explanation composed from fixed
   * copy. It is a PROJECTION of typed state, never a channel for the loop's
   * internal `reason` prose — the timeline and this card are complementary and
   * both survive.
   */
  finalResult: AgentFinalResult;
}

/**
 * The terminal result vocabulary (B1). Mirrors the A9 typed statuses plus the
 * always-present `NONE` for "nothing final yet". `ANSWER` is NOT `SUCCESS`: an
 * information answer never claims the goal was verified, and only the
 * GoalVerifier may produce `SUCCESS`.
 */
export type AgentResultKind =
  | 'NONE'
  | 'ANSWER'
  | 'PARTIAL'
  | 'CANNOT_VERIFY'
  | 'NEEDS_INFORMATION'
  // PHASE 18.8 / A13. A reference the local resolver would not guess at.
  | 'NEEDS_CLARIFICATION'
  // PHASE 18.8 / A14. A consequential commit could not be established.
  | 'COMMIT_UNKNOWN'
  // PHASE 18.8 / A16. The page moved before a consequential action ran.
  | 'FRESHNESS_UNVERIFIED'
  | 'SUCCESS'
  | 'FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'STOPPED';

export interface AgentFinalResult {
  kind: AgentResultKind;
  /** Fixed copy per kind. Never internal prose. */
  headline: string;
  /** The answer or explanation. Composed from local verified claims or fixed
   *  copy; never raw `state.reason`, never model prose, never an internal code. */
  body: string | null;
  /** Privacy-safe provenance: a count and a host only. */
  provenance: string | null;
  /** Bounded, fixed-copy list of what remains unresolved. */
  remaining: string[];
}

// ── Fixed copy tables ────────────────────────────────────────────────────────

const PHASE_SUMMARY: Record<AgentActivityPhase, string> = {
  IDLE: 'Idle.',
  PERCEPTION: 'Reading the page.',
  PLANNING: 'Deciding the next step.',
  VALIDATION: 'Checking the action against local policy.',
  EXECUTION: 'Acting in the browser.',
  VERIFICATION: 'Confirming the result.',
  RECOVERY: 'Recovering from a failure.',
  AWAITING_CONFIRMATION: 'Waiting for your confirmation.',
  TERMINAL: 'Finished.',
};

/**
 * PHASE 18.8 / A12 — the user-facing body for each cancellation code. Fixed
 * sentences, selected by code; no internal string is ever interpolated.
 */
const CANCELLATION_RESULT_BODY: Record<string, string> = {
  USER_CANCELLED: 'Stopped at your request. Nothing else was changed.',
  SUPERSEDED_BY_NEW_TASK:
    'Stopped because a newer task took over. Nothing from this task was carried into it.',
};

const TERMINAL_HEADLINE: Record<AgentTerminalReason, string> = {
  GOAL_ACHIEVED: 'Goal achieved.',
  STOPPED_BY_USER: 'Stopped at your request.',
  SUPERSEDED_BY_NEW_TASK: 'Stopped because a newer task took over.',
  CONTAINMENT_DENIED: 'Stopped: the agent left the environment it was allowed to act in.',
  HARNESS_HALTED: 'Stopped: the run was halted before it could continue safely.',
  RECOVERY_EXHAUSTED: 'Failed: recovery attempts were used up.',
  STEP_BOUND_EXHAUSTED: 'Failed: the step limit was reached.',
  REASONER_FAILED: 'Failed: the reasoning model was unavailable.',
  PERCEPTION_FAILED: 'Failed: the page could not be read.',
  CONFIRMATION_DECLINED: 'Stopped: the action was declined.',
  ANSWERED: 'Answered from evidence verified on this page.',
  NO_VERIFIABLE_RESULT: 'No verified result was available on this page.',
  NEEDS_CLARIFICATION: 'Stopped: one detail in your request could not be resolved.',
  CONVERSATIONAL_ANSWER: 'Answered directly.',
  COMMIT_UNVERIFIED:
    'Stopped: whether the last action went through could not be confirmed.',
  FRESHNESS_UNVERIFIED:
    'Stopped: the page was no longer the one that step was planned on.',
  UNKNOWN: 'Failed.',
};

/** Failure-record categories that mean "the reasoner did not answer". */
const REASONER_FAILURES: ReadonlySet<string> = new Set([
  'PROVIDER_TIMEOUT',
  'LLM_RATE_LIMIT',
  'INVALID_MODEL_RESPONSE',
]);

/** PHASE 18.8 / B1 — fixed headline per result kind. */
const FINAL_HEADLINE: Record<AgentResultKind, string> = {
  NONE: '',
  ANSWER: 'Answer',
  PARTIAL: 'Partly answered',
  CANNOT_VERIFY: 'Could not verify',
  NEEDS_INFORMATION: 'More information needed',
  NEEDS_CLARIFICATION: 'One detail is missing',
  COMMIT_UNKNOWN: 'Outcome not confirmed',
  FRESHNESS_UNVERIFIED: 'Page changed before acting',
  SUCCESS: 'Task completed',
  FAILED: 'Task not completed',
  PROVIDER_UNAVAILABLE: 'Reasoning service unavailable',
  STOPPED: 'Stopped',
};

/**
 * PHASE 18.8 / B1 — user-safe failure explanations, keyed by the DEVICE'S OWN
 * typed failure category.
 *
 * This table is why the loop's internal `reason` can stay internal forever: the
 * user-facing sentence is selected from the typed category (and the typed
 * recovery record) rather than copied out of prose. A category with no entry
 * gets the generic sentence, so an unknown failure can never leak its raw text
 * through this card.
 */
const FAILURE_EXPLANATION = Object.freeze({
  DEFAULT: 'The task could not be completed. I stopped safely without repeating actions.',
  RECOVERY_EXHAUSTED:
    'The page stopped responding to the actions I tried, so I stopped instead of repeating them.',
  NO_EFFECT:
    'The page did not change when I acted on it, so I stopped instead of repeating the same action.',
  EFFECT_UNVERIFIABLE:
    "I couldn't verify whether the action took effect, so I stopped without repeating it.",
  OSCILLATION:
    'I kept going back and forth without making progress, so I stopped instead of looping.',
  STALE_PERCEPTION:
    'The page kept changing while I was working, so I stopped rather than act on a stale reading.',
  POLICY_BLOCKED: 'I stopped because the task would have left the site it was allowed to work in.',
  CONTAINMENT_DENIED: 'I stopped because the task would have left the site it was allowed to work in.',
  EXECUTION_FAILED: 'An action could not be completed on the page, so I stopped safely.',
  PROVIDER_TIMEOUT: userFacingMessageForStatus('PROVIDER_UNAVAILABLE'),
  LLM_RATE_LIMIT: userFacingMessageForStatus('PROVIDER_UNAVAILABLE'),
  INVALID_MODEL_RESPONSE: userFacingMessageForStatus('PROVIDER_UNAVAILABLE'),
  PERCEPTION_FAILED: "I couldn't read the page, so I stopped without changing anything.",
});

/**
 * Indexed lookup on the frozen explanation table.
 *
 * An unknown or absent category resolves to `undefined` so the caller can
 * apply its own fallback — the table has no catch-all entry of its own.
 */
function failureExplanationFor(category: string | undefined): string | undefined {
  if (!category) return undefined;
  const table: Readonly<Record<string, string | undefined>> = FAILURE_EXPLANATION;
  return table[category];
}

/**
 * Select the user-safe explanation for a failed run.
 *
 * Reads ONLY typed fields: the failure category and the last typed recovery
 * record. `state.reason` is deliberately never consulted — that string is
 * internal by contract, and B1 exists so it cannot reach the user.
 */
function userSafeFailureExplanation(s: AgentTaskState): string {
  const category = s.lastFailure?.category;
  if (category === 'RECOVERY_EXHAUSTED') {
    const records = Array.isArray(s.recoveryRecords) ? s.recoveryRecords : [];
    const last = records.length > 0 ? records[records.length - 1] : undefined;
    const fromRecord = failureExplanationFor(last?.failureCategory);
    return fromRecord ?? FAILURE_EXPLANATION.RECOVERY_EXHAUSTED;
  }
  return failureExplanationFor(category) ?? FAILURE_EXPLANATION.DEFAULT;
}

/** Hostname only from the current URL; fails closed to no provenance. */
function provenanceFor(s: AgentTaskState): string | null {
  const p = s.answerProvenance;
  if (!p || typeof p.verifiedRecords !== 'number' || p.verifiedRecords <= 0) return null;
  const host = typeof p.sourceHost === 'string' && p.sourceHost ? ` from ${p.sourceHost}` : '';
  return `Based on ${p.verifiedRecords} locally verified observation(s)${host}.`;
}

/**
 * Build the final result card. Pure, deterministic and read-only.
 *
 * Every sentence here is either fixed copy from the tables above, the A9
 * approved user-facing message for a typed status, or the answer the loop
 * composed from LOCAL verified evidence. There is no path from
 * `state.reason` (or any other internal prose, code, stack or file name) into
 * this object.
 */
function buildFinalResult(s: AgentTaskState): AgentFinalResult {
  const status = s.status as AgentTaskState['status'] | 'RUNNING';
  const answer = typeof s.answer === 'string' && s.answer.trim() ? s.answer.trim() : null;
  const provenance = provenanceFor(s);

  if (status === 'ANSWER') {
    return { kind: 'ANSWER', headline: FINAL_HEADLINE.ANSWER, body: answer, provenance, remaining: [] };
  }
  if (status === 'PARTIAL') {
    return {
      kind: 'PARTIAL',
      headline: FINAL_HEADLINE.PARTIAL,
      body: answer,
      provenance,
      remaining: ['Some of what was asked could not be verified on this page.'],
    };
  }
  if (status === 'CANNOT_VERIFY') {
    return {
      kind: 'CANNOT_VERIFY',
      headline: FINAL_HEADLINE.CANNOT_VERIFY,
      body: userFacingMessageForStatus('CANNOT_VERIFY'),
      provenance: null,
      remaining: [],
    };
  }
  if (status === 'NEEDS_CLARIFICATION') {
    //
    // PHASE 18.8 / A13. The question the LOCAL resolver asked, from the typed
    // clarification record. Never `state.reason`, never model prose: the user
    // gets the ambiguity explained and nothing about how it was decided.
    //
    const asked = s.clarification;
    const question =
      asked && typeof asked.question === 'string' && asked.question.trim()
        ? asked.question.trim().slice(0, 240)
        : userFacingMessageForStatus('NEEDS_CLARIFICATION');
    return {
      kind: 'NEEDS_CLARIFICATION',
      headline: FINAL_HEADLINE.NEEDS_CLARIFICATION,
      body: question,
      provenance: null,
      remaining: [],
    };
  }
  if (status === 'FRESHNESS_UNVERIFIED') {
    //
    // PHASE 18.8 / A16. The body is the fixed sentence for the TYPED freshness
    // state (CONFLICT / UNKNOWN / STALE), never a code and never `state.reason`.
    //
    const state = s.actionFreshness?.state ?? null;
    return {
      kind: 'FRESHNESS_UNVERIFIED',
      headline: FINAL_HEADLINE.FRESHNESS_UNVERIFIED,
      body: (state ? freshnessStopMessage(state) : null) ?? userFacingMessageForStatus('FRESHNESS_UNVERIFIED'),
      provenance: null,
      remaining: [],
    };
  }
  if (status === 'COMMIT_UNKNOWN') {
    //
    // PHASE 18.8 / A14. The body is composed from the TYPED commit record — the
    // action class is the only thing that varies, and it selects one fixed
    // sentence. `state.reason` is not read: it may hold harness prose.
    //
    const open = (s.commitRecords ?? []).find((r) => r.unresolved) ?? s.lastCommit ?? null;
    return {
      kind: 'COMMIT_UNKNOWN',
      headline: FINAL_HEADLINE.COMMIT_UNKNOWN,
      body: open
        ? unresolvedCommitMessage(open.actionClass)
        : userFacingMessageForStatus('COMMIT_UNKNOWN'),
      provenance: null,
      remaining: [],
    };
  }
  if (status === 'NEEDS_INFORMATION') {
    return {
      kind: 'NEEDS_INFORMATION',
      headline: FINAL_HEADLINE.NEEDS_INFORMATION,
      body: userFacingMessageForStatus('NEEDS_INFORMATION'),
      provenance: null,
      remaining: [],
    };
  }
  if (status === 'SUCCESS') {
    return { kind: 'SUCCESS', headline: FINAL_HEADLINE.SUCCESS, body: answer, provenance, remaining: [] };
  }
  if (status === 'STOPPED') {
    //
    // PHASE 18.8 / A12 — the result says WHICH cancellation, from a fixed
    // sentence selected by the typed code. `state.reason` is still never read:
    // it can hold harness prose, and the result must not echo it.
    //
    const cancelledBody: string =
      (s.cancellationCode && CANCELLATION_RESULT_BODY[s.cancellationCode]) ||
      userFacingMessageForStatus('STOPPED');
    return {
      kind: 'STOPPED',
      headline: FINAL_HEADLINE.STOPPED,
      body: cancelledBody,
      provenance: null,
      remaining: [],
    };
  }
  if (status === 'PROVIDER_UNAVAILABLE' || (isTerminalStatus(status) && classifyTerminalReason(s) === 'REASONER_FAILED')) {
    return {
      kind: 'PROVIDER_UNAVAILABLE',
      headline: FINAL_HEADLINE.PROVIDER_UNAVAILABLE,
      body: userFacingMessageForStatus('PROVIDER_UNAVAILABLE'),
      provenance: null,
      remaining: [],
    };
  }
  if (status === 'FAILED') {
    return {
      kind: 'FAILED',
      headline: FINAL_HEADLINE.FAILED,
      body: userSafeFailureExplanation(s),
      provenance: null,
      remaining: [],
    };
  }
  return { kind: 'NONE', headline: FINAL_HEADLINE.NONE, body: null, provenance: null, remaining: [] };
}

/** Bounded timelines. A task cannot exceed maxSteps, but the bound is explicit. */
export const MAX_AGENT_TIMELINE_ENTRIES = 32;
/** Bounded result items. */
export const MAX_AGENT_RESULT_ITEMS = 10;

// ── Phase derivation ─────────────────────────────────────────────────────────

/**
 * Map the existing plan-state machine onto a coarse operational phase.
 *
 * This uses the REAL `planningEngineState` the loop already maintains. It does
 * not infer anything from prose, and it introduces no new state machine.
 */
export function phaseFromPlanningState(state?: string): AgentActivityPhase {
  const map: Record<PlanningEngineState, AgentActivityPhase> = {
    UNINITIALIZED: 'IDLE',
    DECOMPOSING: 'PLANNING',
    SUBGOAL_SELECTION: 'PLANNING',
    DYNAMIC_REPLANNING: 'RECOVERY',
    TARGET_GROUNDING: 'VALIDATION',
    M5_VALIDATION: 'VALIDATION',
    RISK_POLICY_CHECK: 'VALIDATION',
    USER_CONFIRMATION: 'AWAITING_CONFIRMATION',
    CHROME_EXECUTION: 'EXECUTION',
    EFFECT_VERIFICATION: 'VERIFICATION',
    GOAL_VERIFICATION: 'VERIFICATION',
    COMPLETED: 'TERMINAL',
    FAILED: 'TERMINAL',
    ABORTED: 'TERMINAL',
  };
  return map[state as PlanningEngineState] ?? 'IDLE';
}

// ── The projection ───────────────────────────────────────────────────────────

function isTerminalStatus(status: string): boolean {
  return (
    status === 'SUCCESS' ||
    // PHASE 18.8 / A14. A run that stopped with an unconfirmed commit has
    // ENDED. It is not a pause: `NEEDS_USER_CONFIRMATION` already models that,
    // and rendering this one as "still going" is what would let a duplicate
    // dispatch look like a resume.
    status === 'COMMIT_UNKNOWN' ||
    // PHASE 18.8 / A16. Same reasoning: nothing was attempted on a view nobody
    // is looking at, and the run has ENDED.
    status === 'FRESHNESS_UNVERIFIED' ||
    status === 'FAILED' ||
    status === 'STOPPED' ||
    // PHASE 18.7 / A8. A provider failure is a TYPED terminal state, so the
    // dashboard must be able to report it as an outcome rather than leaving
    // the panel in a running shape forever.
    status === 'PROVIDER_UNAVAILABLE' ||
    // PHASE 18.8 / B1. The A9 information states are terminal too: the run has
    // ENDED, it just did not end in SUCCESS or FAILED. Before this they fell
    // through to IDLE, so an answered task looked like it had never started.
    status === 'ANSWER' ||
    status === 'PARTIAL' ||
    status === 'CANNOT_VERIFY' ||
    status === 'NEEDS_INFORMATION' ||
    // PHASE 18.8 / A13. A clarification ends the run too; it is not a pause.
    status === 'NEEDS_CLARIFICATION'
  );
}

/**
 * Classify WHY a run ended, using internal evidence.
 *
 * The evidence — including `state.reason` — is read HERE and does not leave.
 * Only the resulting code crosses to the user. This is what keeps chain of
 * thought and internal gate prose off the screen.
 */
function classifyTerminalReason(s: AgentTaskState): AgentTerminalReason {
  // PHASE 18.8 / A14 — read the TYPED status, never the sentence it carries.
  if (s.status === 'COMMIT_UNKNOWN') return 'COMMIT_UNVERIFIED';
  // PHASE 18.8 / A16 — same rule: the status is the verdict.
  if (s.status === 'FRESHNESS_UNVERIFIED') return 'FRESHNESS_UNVERIFIED';
  if (s.status === 'SUCCESS') return 'GOAL_ACHIEVED';
  //
  // FINAL ACCEPTANCE AUDIT. Read the TYPED answer source before the status: an
  // ANSWER produced by the normal-chat route carries no page evidence, so it
  // must not be reported as "answered from evidence verified on this page".
  if (s.status === 'ANSWER' && s.answerSource === 'CONVERSATION') return 'CONVERSATIONAL_ANSWER';
  if (s.status === 'ANSWER' || s.status === 'PARTIAL') return 'ANSWERED';
  if (s.status === 'CANNOT_VERIFY' || s.status === 'NEEDS_INFORMATION') return 'NO_VERIFIABLE_RESULT';
  if (s.status === 'NEEDS_CLARIFICATION') return 'NEEDS_CLARIFICATION';
  if (s.status === 'STOPPED') {
    // PHASE 18.8 / A12 — read the TYPED cancellation code, never the prose.
    // The code is decided by the lifecycle; the sentence is still composed here
    // from the fixed table, so no internal string can reach the user.
    if (s.cancellationCode === 'SUPERSEDED_BY_NEW_TASK') return 'SUPERSEDED_BY_NEW_TASK';
    if (s.cancellationCode === 'USER_CANCELLED') return 'STOPPED_BY_USER';
    return /declin|reject/i.test(s.reason ?? '') ? 'CONFIRMATION_DECLINED' : 'STOPPED_BY_USER';
  }

  // Environmental refusals win: they are why the run ended, not what it hit.
  if (s.containmentDecision && s.containmentDecision.contained === false) {
    return 'CONTAINMENT_DENIED';
  }
  if (s.harnessRun && s.harnessRun.lastVerdict === 'HALT_ENVIRONMENT') {
    return 'HARNESS_HALTED';
  }
  if (s.harnessRun && s.harnessRun.lastVerdict === 'BUDGET_EXHAUSTED') {
    return s.harnessRun.lastHaltCode === 'RECOVERY_BUDGET_EXHAUSTED'
      ? 'RECOVERY_EXHAUSTED'
      : 'STEP_BOUND_EXHAUSTED';
  }

  const lastCategory = s.lastFailure?.category;  if (lastCategory) {
    if (REASONER_FAILURES.has(lastCategory)) return 'REASONER_FAILED';
    if (lastCategory === 'RECOVERY_EXHAUSTED') return 'RECOVERY_EXHAUSTED';
    if (lastCategory === 'CONTAINMENT_DENIED') return 'CONTAINMENT_DENIED';
  }

  if (/^Perception failed/i.test(s.reason ?? '')) return 'PERCEPTION_FAILED';
  if (/^Agent reasoning failed/i.test(s.reason ?? '')) return 'REASONER_FAILED';
  //
  // PHASE 18.7 / A8. The typed status is the RIGHT way to reach this verdict:
  // a message-prefix regex was only ever a proxy for "the reasoner could not
  // answer", and A8 replaced that message with an honest one. Reading the
  // status means the verdict cannot drift from the state it describes.
  if (s.status === 'PROVIDER_UNAVAILABLE') return 'REASONER_FAILED';
  if (s.currentStep >= s.maxSteps) return 'STEP_BOUND_EXHAUSTED';

  return 'UNKNOWN';
}

function buildArtifacts(s: AgentTaskState): AgentArtifact[] {
  const out: AgentArtifact[] = [];
  if (s.containmentDecision) {
    out.push({
      kind: 'CONTAINMENT',
      label: `${s.containmentDecision.code}:${s.containmentDecision.scope}`,
    });
  }
  if (s.harnessRun && s.harnessRun.cycles > 0) {
    out.push({
      kind: 'HARNESS',
      label: `${s.harnessRun.cycles} cycle(s), ${s.harnessRun.haltCount} halt(s)`,
    });
  }
  if (typeof s.totalRecoveryAttempts === 'number' && s.totalRecoveryAttempts > 0) {
    out.push({ kind: 'RECOVERY', label: `${s.totalRecoveryAttempts} attempt(s)` });
  }
  if (s.lastFailure) {
    out.push({ kind: 'FAILURE', label: s.lastFailure.category });
  }
  if (s.perceptionGeneration > 0) {
    out.push({ kind: 'PERCEPTION', label: `${s.perceptionGeneration} cycle(s)` });
  }
  return out;
}

function buildResult(s: AgentTaskState): AgentResult {
  const candidates = Array.isArray(s.candidateItems) ? s.candidateItems : [];
  if (candidates.length > 0) {
    return {
      kind: 'CANDIDATES',
      summary: `${candidates.length} matching result(s) found.`,
      count: candidates.length,
      items: candidates.slice(0, MAX_AGENT_RESULT_ITEMS).map((c) => ({
        id: c.id,
        title: typeof c.title === 'string' ? c.title : 'item',
        detail: c.matchesConstraints ? 'matches the stated constraints' : 'partially matches',
      })),
    };
  }

  const findings = Array.isArray(s.currentFindings) ? s.currentFindings : [];
  if (findings.length > 0) {
    return {
      kind: 'FINDINGS',
      summary: `${findings.length} finding(s).`,
      count: findings.length,
      items: findings.slice(0, MAX_AGENT_RESULT_ITEMS).map((f, i) => ({
        id: `finding-${i + 1}`,
        title: typeof f === 'string' ? f : 'finding',
        detail: 'reported on the current page',
      })),
    };
  }

  return { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] };
}

function buildTimeline(s: AgentTaskState): AgentTimelineEntry[] {
  const steps = Array.isArray(s.steps) ? s.steps : [];
  return steps.slice(-MAX_AGENT_TIMELINE_ENTRIES).map((step) => ({
    step: step.step,
    action: step.action?.action ?? 'unknown',
    // The outcome is structural. The ERROR and REASON strings stay behind.
    outcome: step.executionSuccess
      ? 'EXECUTED'
      : step.validationAllowed
        ? 'FAILED'
        : 'BLOCKED',
  }));
}

/**
 * Project authoritative agent state into the user-facing interaction state.
 *
 * Pure, deterministic, and read-only. It performs no I/O, calls no model, and
 * mutates nothing — including its own argument.
 */
export function projectAgentOutput(state: AgentTaskState): AgentInteractionState {
  if (typeof state !== 'object' || state === null) {
    return safeBlockedProjection('UNKNOWN');
  }

  // The loop only ever produces TaskStatus values, but the service worker's
  // hand-built handshake payloads use 'RUNNING' for the same meaning. It is
  // read here explicitly rather than cast away, so the widening is visible.
  const status = state.status as AgentTaskState['status'] | 'RUNNING';

  // The service worker's hand-built handshake payload carries no
  // planningEngineState, so before the plan state machine has reported
  // anything there is genuinely nothing better to say than "perceiving".
  //
  // It must NOT, however, keep claiming that once the machine HAS reported.
  // `steps` is still empty for the whole first reasoning call — the step is
  // only recorded after an action is dispatched — so keying the override off
  // `isFirstCycle` alone labelled the entire first reasoner request as
  // PERCEPTION, even though the state machine had moved to SUBGOAL_SELECTION.
  // A slow reasoner was therefore indistinguishable from a perception stall.
  const isFirstCycle = !Array.isArray(state.steps) || state.steps.length === 0;
  const planReported =
    typeof state.planningEngineState === 'string' && state.planningEngineState !== 'UNINITIALIZED';
  let phase: AgentActivityPhase = phaseFromPlanningState(state.planningEngineState);
  if ((status === 'IN_PROGRESS' || status === 'RUNNING') && isFirstCycle && !planReported) {
    phase = 'PERCEPTION';
  }
  if (status === 'NEEDS_USER_CONFIRMATION') {
    phase = 'AWAITING_CONFIRMATION';
  }

  let outcome: AgentOutcome = 'IDLE';
  // 'RUNNING' is the status the service worker uses for its hand-built
  // handshakes; 'IN_PROGRESS' is the loop's own status for the same idea.
  if (status === 'IN_PROGRESS' || status === 'RUNNING') outcome = 'RUNNING';
  if (status === 'NEEDS_USER_CONFIRMATION') outcome = 'AWAITING_CONFIRMATION';
  if (isTerminalStatus(status)) {
    outcome =
      status === 'SUCCESS'
        ? 'SUCCEEDED'
        : status === 'STOPPED'
          ? 'STOPPED'
          : status === 'ANSWER' || status === 'PARTIAL'
            ? 'ANSWERED'
            : status === 'CANNOT_VERIFY' ||
                status === 'NEEDS_INFORMATION' ||
                // PHASE 18.8 / A14 — nothing was completed and nothing was
                // verified, so this is UNANSWERED: never SUCCEEDED, and never a
                // claimed failure.
                status === 'COMMIT_UNKNOWN' ||
                // PHASE 18.8 / A16 — the run ended without acting at all.
                status === 'FRESHNESS_UNVERIFIED' ||
                status === 'NEEDS_CLARIFICATION'
              ? 'UNANSWERED'
              : 'FAILED';
  }

  const terminal: AgentTerminal | null = isTerminalStatus(status)
    ? (() => {
        const reason = classifyTerminalReason(state);
        return {
          outcome: outcome as AgentTerminal['outcome'],
          reason,
          headline: TERMINAL_HEADLINE[reason],
        };
      })()
    : null;

  const activity: AgentActivity = {
    phase: terminal ? 'TERMINAL' : phase,
    summary: PHASE_SUMMARY[terminal ? 'TERMINAL' : phase],
    step: state.currentStep ?? 0,
    maxSteps: state.maxSteps ?? 0,
    cycle: state.harnessRun?.cycles ?? null,
  };

  const awaiting =
    status === 'NEEDS_USER_CONFIRMATION' && state.requiresUserConfirmationAction
      ? {
          action: state.requiresUserConfirmationAction.action,
          // Type + risk only. The target id and destination URL are internal.
          description:
            state.requiresUserConfirmationAction.action === 'navigate'
              ? 'Navigate to a requested destination'
              : 'Interact with a control on the current page',
          riskLevel:
            state.steps.length > 0
              ? (state.steps[state.steps.length - 1]?.riskAssessment?.riskLevel ?? 'HIGH')
              : 'HIGH',
        }
      : null;

  return {
    outcome,
    activity,
    terminal,
    result: buildResult(state),
    artifacts: buildArtifacts(state),
    timeline: buildTimeline(state),
    awaitingConfirmation: awaiting,
    finalResult: buildFinalResult(state),
  };
}

// ── Output screening — the privacy seam ─────────────────────────────────────

export type OutputScreenVerdict = 'CLEAR' | 'REDACTED' | 'BLOCKED';

export interface OutputScreenResult {
  verdict: OutputScreenVerdict;
  /** The payload that may be emitted. Never null: a blocked payload is a safe
   *  empty projection, so a caller cannot accidentally forward the original. */
  output: AgentInteractionState;
  /** Number of raw-value shapes found. Count only, never the value. */
  findings: number;
  /** Deterministic, value-free explanation. */
  reason: string;
  /**
   * WHICH structural field tripped, when the closed-vocabulary check failed.
   *
   * Field NAME + rule CODE only — never the value, and never the matched text.
   * The scanner already returns exactly this pair, and without it a dropped
   * payload is undiagnosable in a real run: Phase 18.6/A10 recorded real-Chrome
   * runs whose terminal projection was dropped wholesale with `findings: 1` and
   * no way to tell from the artifact which field caused it.
   *
   * Deciding what to DO about a trip is unchanged: the payload is still dropped.
   */
  structuralViolations?: readonly StructuralViolation[];
}

/** A value-free description of one structural screening trip. */
export interface StructuralViolation {
  /** Path of the offending field inside the interaction projection. */
  readonly field: string;
  /** The scanner rule that matched. */
  readonly rule: RawValueRule;
}

/** Bound on how many structural violations are reported, so a log stays bounded. */
const MAX_STRUCTURAL_VIOLATIONS = 8;

/** The payload emitted when screening fails closed. */
function safeBlockedProjection(reason: AgentTerminalReason): AgentInteractionState {
  return {
    outcome: 'FAILED',
    activity: { phase: 'TERMINAL', summary: PHASE_SUMMARY.TERMINAL, step: 0, maxSteps: 0, cycle: null },
    terminal: { outcome: 'FAILED', reason, headline: TERMINAL_HEADLINE[reason] },
    result: { kind: 'NONE', summary: 'No result available.', count: 0, items: [] },
    artifacts: [],
    timeline: [],
    awaitingConfirmation: null,
    // Fixed, internal-free copy: a blocked payload must never fall back to
    // anything the original state carried.
    finalResult: {
      kind: 'FAILED',
      headline: FINAL_HEADLINE.FAILED,
      body: FAILURE_EXPLANATION.DEFAULT,
      provenance: null,
      remaining: [],
    },
  };
}

function isTripped(value: string): boolean {
  return scanForRawSensitiveValues(value, { structuralKeys: new Set() }).length > 0;
}

/**
 * The closed-vocabulary fields, each with the NAME it is reported under.
 *
 * Names exist so a trip can be attributed without ever logging a value: the
 * projection is a fixed shape, so a field name is not derived from page content.
 */
function structuralFields(o: AgentInteractionState): Array<[string, string]> {
  return [
    ['outcome', o.outcome],
    ['activity.phase', o.activity.phase],
    ['activity.summary', o.activity.summary],
    ['activity.cycle', o.activity.cycle === null ? '' : String(o.activity.cycle)],
    ['terminal.headline', o.terminal?.headline ?? ''],
    ['terminal.reason', o.terminal?.reason ?? ''],
    ['result.kind', o.result.kind],
    ['result.summary', o.result.summary],
    ['finalResult.kind', o.finalResult?.kind ?? ''],
    ['finalResult.headline', o.finalResult?.headline ?? ''],
    ...(o.finalResult?.remaining ?? []).map((v, i): [string, string] => [`finalResult.remaining[${i}]`, v]),
    ...o.timeline.map((t, i): [string, string] => [`timeline[${i}]`, `${t.action}:${t.outcome}`]),
    ...o.artifacts.map((a, i): [string, string] => [`artifacts[${i}]`, `${a.kind}:${a.label}`]),
  ];
}

/** Structural fields come from a closed vocabulary; a hit there means corruption. */
function structureIsClean(o: AgentInteractionState): {
  clean: boolean;
  violations: StructuralViolation[];
} {
  const violations: StructuralViolation[] = [];
  for (const [field, value] of structuralFields(o)) {
    for (const hit of scanForRawSensitiveValues(value, { structuralKeys: new Set() })) {
      violations.push({ field, rule: hit.rule });
    }
  }
  return { clean: violations.length === 0, violations };
}

/**
 * Screen a user-facing projection before it leaves the service worker.
 *
 * MINIMAL BY DESIGN: it establishes the boundary using the existing
 * `scanForRawSensitiveValues` primitive and nothing more. It is not a
 * classification system, and it is where a fuller output-privacy layer would
 * later attach without moving the boundary.
 *
 * FAIL-CLOSED in two distinct ways:
 *  - a malformed projection is replaced wholesale with a safe empty payload;
 *  - a raw-value shape in a CLOSED-VOCABULARY field drops the whole payload,
 *    because a corrupt structural field cannot be half-trusted.
 *
 * A raw-value shape in a page-derived DISPLAY field is redacted in place, so a
 * legitimate result is not lost to one bad title.
 */
export function screenAgentOutput(output: AgentInteractionState): OutputScreenResult {
  if (typeof output !== 'object' || output === null || typeof output.outcome !== 'string') {
    return {
      verdict: 'BLOCKED',
      output: safeBlockedProjection('UNKNOWN'),
      findings: 0,
      reason: 'Malformed interaction payload; failing closed.',
    };
  }

  const structural = structureIsClean(output);
  if (!structural.clean) {
    return {
      verdict: 'BLOCKED',
      output: safeBlockedProjection('UNKNOWN'),
      findings: 1,
      reason: 'Structural field failed output screening; whole payload dropped.',
      structuralViolations: structural.violations.slice(0, MAX_STRUCTURAL_VIOLATIONS),
    };
  }

  let findings = 0;
  const items = output.result.items.map((item) => {
    if (isTripped(item.title)) {
      findings += 1;
      return { ...item, title: '[redacted]', detail: 'withheld by output screening' };
    }
    if (isTripped(item.detail)) {
      findings += 1;
      return { ...item, detail: 'withheld by output screening' };
    }
    return item;
  });

  //
  // PHASE 18.8 / B1 — the final result card crosses the SAME boundary.
  //
  // Its body is composed from ledger claims (already screened at ledger write
  // time), and it is re-screened here at EGRESS exactly like a result item, so
  // the answer renderer is strictly downstream of the privacy rules. `kind`
  // and `headline` are closed vocabulary and were checked structurally above;
  // `remaining` is fixed copy but is checked anyway, because a future edit
  // could make it derived.
  //
  let finalResult = output.finalResult;
  if (finalResult) {
    if (finalResult.body && isTripped(finalResult.body)) {
      findings += 1;
      finalResult = { ...finalResult, body: 'withheld by output screening' };
    }
    if (finalResult.provenance && isTripped(finalResult.provenance)) {
      findings += 1;
      finalResult = { ...finalResult, provenance: null };
    }
    if (Array.isArray(finalResult.remaining) && finalResult.remaining.some((r) => isTripped(r))) {
      findings += 1;
      finalResult = { ...finalResult, remaining: [] };
    }
  }

  if (findings > 0) {
    return {
      verdict: 'REDACTED',
      output: { ...output, result: { ...output.result, items }, finalResult },
      findings,
      reason: `${findings} result field(s) redacted by output screening.`,
    };
  }

  return { verdict: 'CLEAR', output, findings: 0, reason: 'Output passed screening.' };
}

/** Stable, value-free audit line for an output-screening decision. */
export function describeOutputScreen(result: OutputScreenResult): string {
  return `OUTPUT_SCREEN_${result.verdict} (${result.findings} finding(s))`;
}
