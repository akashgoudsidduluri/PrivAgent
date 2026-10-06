/**
 * PHASE 18.7 / A3 — STRUCTURED DECISION STATE.
 *
 * WHAT THE SYSTEM KNOWS vs WHAT THE MODEL WAS TOLD
 * -------------------------------------------------
 * The system knows a great deal that the model never sees: whether the last
 * action was refused by a gate, which subgoal is active, how many criteria are
 * satisfied, what the evidence ledger holds, whether the page moved underneath
 * the last perception, what the goal verifier currently believes. The model
 * receives a URL, a viewport, a bounded element list and a list of its own past
 * actions — and from that it is expected to work out what is true.
 *
 * The consequence is that the reasoner re-derives state it was never given, and
 * it guesses. That guessing is not a prompt problem: the information was never
 * put on the wire, so no prompt could have contained it.
 *
 * WHAT THIS IS
 * ------------
 * A single, explicitly ALLOWLISTED projection of local task state for the model.
 * It is a projection — it grants no permission, reorders no gate, and cannot
 * change what any verifier believes. It is strictly informational.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT an authorization channel. Nothing here can dispatch an action,
 * confirm one, mark a subgoal done, or declare the goal satisfied. The
 * Security Critic verdict, risk scores, containment decisions and GoalVerifier
 * internals are DELIBERATELY ABSENT — not because they are unimportant, but
 * because the reasoner has no legitimate use for them and every one of them is
 * an authority input. Sending an authority's verdict to a proposer is how a
 * proposer starts negotiating with an authority.
 *
 * LOCAL-ONLY, BY CONSTRUCTION
 * ---------------------------
 * `projectDecisionStateForModel` rebuilds the object from an explicit key
 * allowlist rather than spreading the source. A field cannot leak by being
 * added upstream, because it has to be added HERE too, deliberately.
 *
 * OBSERVATION STATES ARE NOT COLLAPSED
 * ------------------------------------
 * `OBSERVED | UNAVAILABLE | UNKNOWN | STALE | NOT_APPLICABLE` are preserved
 * exactly. The load-bearing pair is UNKNOWN vs UNAVAILABLE: "we looked and
 * could not read it" is not "we did not look". Collapsing them into a single
 * absence is what lets a loop treat a failure to observe as an absence of facts.
 */
import type { PageCategory, TaskStatus } from './agentState';
import type { ActionHistoryEntry } from './actionHistory';
import type { TaskIntent } from './intentBoundary';

/** Explicitly enumerated. Never derived, never defaulted to a success value. */
export type PageObservationState = 'OBSERVED' | 'UNAVAILABLE' | 'UNKNOWN' | 'STALE' | 'NOT_APPLICABLE';

/** Verbatim from the destination verifier. Never inferred from the URL. */
export type DecisionDestinationStatus = 'UNVERIFIED' | 'VERIFIED' | 'MISMATCH' | 'NOT_APPLICABLE';

/** Verbatim from the goal verifier. Never inferred from "the loop ended". */
export type DecisionGoalStatus =
  | 'PENDING'
  | 'SATISFIED'
  | 'NOT_SATISFIED'
  | 'CANNOT_VERIFY'
  | 'NOT_APPLICABLE';

export type DecisionRecoveryState =
  | 'NONE'
  | 'REPERCEIVE'
  | 'RETRY'
  | 'REGROUND'
  | 'RESELECT'
  | 'SCROLL_AND_REPERCEIVE'
  | 'REPLAN'
  | 'EXHAUSTED';

/** A model-facing POINTER to ledger content. Never the content itself. */
export interface EvidenceReference {
  id: string;
  verificationStatus: 'UNVERIFIED' | 'VERIFIED' | 'CONFLICTED' | 'INVALIDATED';
  freshness: 'CURRENT' | 'STALE';
}

export interface ModelFacingDecisionState {
  task: string;
  intent: TaskIntent;
  requiresEvidence: boolean;
  activeSubgoal: string | null;
  pendingCriteria: string[];
  completedCriteria: string[];
  page: {
    url: string;
    type: PageCategory;
    observationState: PageObservationState;
    generation: number | null;
  };
  lastAction: ActionHistoryEntry | null;
  destination: { status: DecisionDestinationStatus };
  goal: { status: DecisionGoalStatus };
  evidence: EvidenceReference[];
  recovery: {
    state: DecisionRecoveryState;
    attempts: number;
    retryCount: number;
  };
}

/** Everything the builder needs. Assembled by the loop, not by this module. */
export interface DecisionStateInput {
  task: string;
  intent: TaskIntent;
  requiresEvidence: boolean;
  activeSubgoal?: string | null;
  pendingCriteria?: string[];
  completedCriteria?: string[];
  url?: string | null;
  pageType?: PageCategory | null;
  pageObservationState?: PageObservationState;
  pageGeneration?: number | null;
  lastAction?: ActionHistoryEntry | null;
  destinationStatus?: DecisionDestinationStatus;
  goalStatus?: DecisionGoalStatus;
  evidence?: EvidenceReference[];
  recoveryState?: DecisionRecoveryState;
  recoveryAttempts?: number;
  retryCount?: number;
}

/** Hard bound on criteria lists crossing the boundary. */
export const MAX_CRITERIA = 20;
/** Hard bound on evidence references crossing the boundary. */
export const MAX_EVIDENCE_REFERENCES = 20;

function boundedStrings(values: readonly string[] | undefined, limit = MAX_CRITERIA): string[] {
  if (!values) return [];
  return values
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, limit)
    .map((v) => v.slice(0, 120));
}

/**
 * Build the internal decision state. Deterministic and total: a missing input
 * becomes an explicit UNAVAILABLE/UNKNOWN/NOT_APPLICABLE, never a success.
 */
export function buildDecisionState(input: DecisionStateInput): ModelFacingDecisionState {
  return {
    task: input.task,
    intent: input.intent,
    requiresEvidence: input.requiresEvidence,
    activeSubgoal: input.activeSubgoal ? input.activeSubgoal.slice(0, 160) : null,
    pendingCriteria: boundedStrings(input.pendingCriteria),
    completedCriteria: boundedStrings(input.completedCriteria),
    page: {
      url: input.url ?? '',
      type: input.pageType ?? 'unknown',
      observationState: input.pageObservationState ?? 'UNKNOWN',
      generation: typeof input.pageGeneration === 'number' ? input.pageGeneration : null,
    },
    lastAction: input.lastAction ?? null,
    destination: { status: input.destinationStatus ?? 'NOT_APPLICABLE' },
    goal: { status: input.goalStatus ?? 'PENDING' },
    evidence: (input.evidence ?? []).slice(0, MAX_EVIDENCE_REFERENCES),
    recovery: {
      state: input.recoveryState ?? 'NONE',
      attempts: input.recoveryAttempts ?? 0,
      retryCount: input.retryCount ?? 0,
    },
  };
}

/**
 * THE EGRESS PROJECTION.
 *
 * Rebuilds from an explicit key allowlist. Deliberately NOT a spread — if the
 * source object grows a field, it does NOT automatically cross to the model.
 * That is the difference between a boundary and a convention.
 */
export function projectDecisionStateForModel(
  state: ModelFacingDecisionState,
): ModelFacingDecisionState {
  return {
    task: state.task,
    intent: state.intent,
    requiresEvidence: state.requiresEvidence,
    activeSubgoal: state.activeSubgoal,
    pendingCriteria: boundedStrings(state.pendingCriteria),
    completedCriteria: boundedStrings(state.completedCriteria),
    page: {
      url: state.page.url,
      type: state.page.type,
      observationState: state.page.observationState,
      generation: state.page.generation,
    },
    lastAction: state.lastAction,
    destination: { status: state.destination.status },
    goal: { status: state.goal.status },
    evidence: (state.evidence ?? []).slice(0, MAX_EVIDENCE_REFERENCES),
    recovery: {
      state: state.recovery.state,
      attempts: state.recovery.attempts,
      retryCount: state.recovery.retryCount,
    },
  };
}

/** Terminal task statuses, used by the loop when populating `goal.status`. */
export function goalStatusFromTaskStatus(status: TaskStatus): DecisionGoalStatus {
  switch (status) {
    case 'SUCCESS':
      return 'SATISFIED';
    case 'FAILED':
    case 'STOPPED':
      return 'NOT_SATISFIED';
    case 'NEEDS_USER_CONFIRMATION':
    case 'NEEDS_CLARIFICATION':
      return 'NOT_APPLICABLE';
    // PHASE 18.7 / A9. The new information-task states are terminal but they
    // are NOT goal satisfaction, so they must not land in the `default` arm
    // either — reporting a rest state as `PENDING` would tell the model the
    // loop is still working. `CANNOT_VERIFY` is the honest value for every one
    // of them: the goal was never verified as met, and never verified as
    // unattainable.
    case 'ANSWER':
    case 'PARTIAL':
    case 'NEEDS_INFORMATION':
    case 'CANNOT_VERIFY':
    case 'PROVIDER_UNAVAILABLE':
    // PHASE 18.8 / A14 + A16. An unconfirmed commit and a view whose freshness
    // could not be established have exactly the shape described above: the run
    // ended without the goal being verified as met AND without it being verified
    // as unattainable. Mapping them to NOT_SATISFIED would convert "we could not
    // confirm it" into "it did not happen" — the precise claim the A14 contract
    // refuses to make. They must not fall through to `PENDING` either.
    case 'COMMIT_UNKNOWN':
    case 'FRESHNESS_UNVERIFIED':
      return 'CANNOT_VERIFY';
    case 'IN_PROGRESS':
    default:
      return 'PENDING';
  }
}

/**
 * Compact rendering for the model prompt. Fixed key order, bounded, and
 * value-free except for the already-sanitized task and page type.
 */
export function renderDecisionState(state: ModelFacingDecisionState): string {
  const lines: string[] = [];
  lines.push(`Task: ${state.task}`);
  lines.push(`Intent: ${state.intent} (requiresEvidence=${state.requiresEvidence})`);
  lines.push(`Active subgoal: ${state.activeSubgoal ?? 'NONE'}`);
  lines.push(`Pending criteria: ${state.pendingCriteria.length}`);
  lines.push(`Completed criteria: ${state.completedCriteria.length}`);
  lines.push(
    `Page: type=${state.page.type} observation=${state.page.observationState} generation=${
      state.page.generation ?? 'UNKNOWN'
    }`,
  );
  lines.push(`Destination: ${state.destination.status}`);
  lines.push(`Goal: ${state.goal.status}`);
  lines.push(
    `Evidence: ${state.evidence.length} reference(s), verified=${
      state.evidence.filter((e) => e.verificationStatus === 'VERIFIED').length
    }`,
  );
  lines.push(
    `Recovery: ${state.recovery.state} (attempts=${state.recovery.attempts}, retries=${state.recovery.retryCount})`,
  );
  return lines.join('\n');
}