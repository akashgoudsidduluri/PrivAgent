/**
 * PrivAgent — Stateful Browser Agent Task State (Phase 1)
 *
 * Implements a rich, persistent state representation for autonomous browser agent tasks.
 *
 * Security Invariants:
 *  - State NEVER stores raw sensitive PII, credentials, passwords, tokens, cards, or raw OCR values.
 *  - Property names are strictly chosen to avoid collision with `FORBIDDEN_STATE_KEYS`.
 *  - targetTabId represents the STABLE execution target across page generations.
 *  - Dynamic page attributes (DOM targets, generation, pageType) update per page transition.
 */

import { BrowserAction, ActionType } from './actionTypes';
import { ActionRiskAssessment } from './riskEngine';
import { SemanticVerificationResult } from './semanticVerifier';
import { ConfidenceEvaluation } from './confidenceScorer';
import { SelfHealingResult } from './selfHealing';
import { TaskPlan } from './taskPlanner';
import { AgentDecisionTracer } from './decisionTrace';
import { BrowserWorldModel, ActiveWorldModelRef } from '../worldModel/types';
import { worldModelStore } from '../worldModel/worldModelStore';

export type TaskStatus = 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'NEEDS_USER_CONFIRMATION' | 'STOPPED';

export type PageCategory =
  | 'search'
  | 'login'
  | 'article'
  | 'listing'
  | 'form'
  | 'checkout'
  | 'settings'
  | 'dashboard'
  | 'error'
  | 'unknown'
  // Preserved for backwards-compatibility:
  | 'landing'
  | 'results'
  | 'product_detail'
  | 'banking';

export type ConfirmationStatus = 'NONE' | 'PENDING' | 'AUTHORIZED' | 'REJECTED';

export type FailureCategory =
  | 'TARGET_NOT_FOUND'
  | 'STALE_TARGET'
  | 'TARGET_MISMATCH'
  | 'ACTION_NO_EFFECT'
  | 'PAGE_CHANGED'
  | 'TARGET_TAB_NOT_FOUND'
  | 'TARGET_TAB_UNRESPONSIVE'
  | 'NAVIGATION_TIMEOUT'
  | 'PERCEPTION_TIMEOUT'
  | 'PROVIDER_TIMEOUT'
  | 'LLM_RATE_LIMIT'
  | 'INVALID_MODEL_RESPONSE'
  | 'CONFIRMATION_REQUIRED'
  | 'GOAL_NOT_SATISFIED'
  | 'RECOVERY_EXHAUSTED'
  /**
   * Phase 12 Containment: the action was refused by the ENVIRONMENTAL
   * boundary, not by an action-authorization gate. Terminal — the task does
   * not retry into an environment containment has refused.
   */
  | 'CONTAINMENT_DENIED';

export interface FailureRecord {
  category: FailureCategory;
  reason: string;
  pageGeneration: number;
  attemptedAction?: BrowserAction;
  recoveryAttempted: boolean;
  finalState: TaskStatus;
  timestamp: number;
}

export interface StructuredConstraints {
  category?: string;
  style?: string;
  color?: string;
  size?: string;
  maxPrice?: number;
  currency?: string;
  brand?: string;
  requiresAuth?: boolean;
}

export interface SubGoalItem {
  id: string;
  order: number;
  description: string;
  expectedActionType: ActionType | 'inspect' | 'verify';
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  targetHint?: string;
  completionNotes?: string;
}

export interface CandidateProductItem {
  id: string;
  title: string;
  price: number;
  currency: string;
  size?: string;
  color?: string;
  itemUrl?: string;
  targetId?: string;
  matchesConstraints: boolean;
  constraintNotes: string;
  confidence: number;
}

export interface ExpectedStateChange {
  actionType: ActionType;
  expectedTransition: 'URL_CHANGE' | 'DOM_UPDATE' | 'MODAL_OPEN' | 'PAGE_SETTLED';
  description: string;
  targetHint?: string;
}

// ══════════════════════════════════════════════════════════════════════════
// RETAINED ACTIONS — the value-free projection the loop is allowed to KEEP
// ══════════════════════════════════════════════════════════════════════════
//
// The header of this file states the invariant: state never stores raw sensitive
// PII. `StepRecord` broke it. It held the live `BrowserAction`, so a refused or
// executed `type` action left its entire `text` sitting in task state — and task
// state is what `getState()` returns, what the service worker hands to
// `sendToDashboard`, and what the popup renders with `formatActionForDisplay`.
//
// The live action object the authorization and dispatch pipeline uses is
// UNTOUCHED. This is a projection made at the moment of retention, and nothing
// in the pipeline ever reads it back. See `sanitizeRetainedAction`.
//
// What survives is what something genuinely still needs AFTER the gates have
// run. The audit that produced this type found the real consumers:
//   - `fingerprintObservation` reads `action` and `target` (long-horizon stall
//     detection), so both are preserved verbatim.
//   - the popup step trail and the frontend adapter render `action`, `target`,
//     `direction`, `amount` and `url`, all preserved.
//   - a VALUE length is retained instead of the value, so a step can still be
//     audited for "did this type something, and how much", which is the only
//     thing any consumer ever wanted from it.

export type RetainedAction =
  | { action: 'click'; target: string; reason?: string }
  | { action: 'scroll'; direction: string; amount: number; reason?: string }
  | { action: 'type'; target: string; valueLength: number; reason?: string }
  | { action: 'select'; target: string; valueLength: number; reason?: string }
  | { action: 'navigate'; url: string; reason?: string }
  | { action: 'pressKey'; key: string; target?: string; reason?: string };

/**
 * Project a live action down to what may be RETAINED.
 *
 * The `text` of a `type` action and the `option` of a `select` are the two
 * fields that can carry a raw user value, and they are replaced by their
 * LENGTH. Nothing else is dropped: `action`, `target` and the geometric or
 * routing fields are what the fingerprint, the step trail and the adapters read.
 *
 * `reason` is retained. It is model-authored free text that M5 already screens
 * at the moment of authorization, and it is the only record of why a proposal
 * was made. Removing it would lose diagnostics without closing a boundary —
 * the `person_name` false positive is a separate, explicitly tracked issue.
 */
export function sanitizeRetainedAction(action: BrowserAction): RetainedAction {
  switch (action.action) {
    case 'type':
      return { action: 'type', target: action.target, valueLength: action.text.length, reason: action.reason };
    case 'select':
      return { action: 'select', target: action.target, valueLength: action.option.length, reason: action.reason };
    case 'click':
      return { action: 'click', target: action.target, reason: action.reason };
    case 'scroll':
      return { action: 'scroll', direction: action.direction, amount: action.amount, reason: action.reason };
    case 'navigate':
      return { action: 'navigate', url: action.url, reason: action.reason };
    case 'pressKey':
      return { action: 'pressKey', key: action.key, target: action.target, reason: action.reason };
  }
}

/**
 * The self-healing record as RETAINED. `recoveredAction` is a full
 * `BrowserAction` and therefore carries the same raw value the original did, so
 * it is projected too. Only `recovered` (a boolean) is read back by any
 * production consumer, so this costs nothing.
 */
export interface RetainedSelfHealing extends Omit<SelfHealingResult, 'recoveredAction'> {
  recoveredAction?: RetainedAction;
}

export function sanitizeRetainedSelfHealing(result: SelfHealingResult | undefined): RetainedSelfHealing | undefined {
  if (!result) return undefined;
  return {
    ...result,
    recoveredAction: result.recoveredAction ? sanitizeRetainedAction(result.recoveredAction) : undefined,
  };
}

export interface StepRecord {
  step: number;
  action: RetainedAction;
  validationAllowed: boolean;
  validationReason: string;
  executionSuccess: boolean;
  executionError?: string;
  targetId?: string;
  targetType?: string;
  url: string;
  timestamp: number;
  riskAssessment?: ActionRiskAssessment;
  semanticVerification?: SemanticVerificationResult;
  confidenceEvaluation?: ConfidenceEvaluation;
  selfHealing?: RetainedSelfHealing;
  /**
   * Populated for navigate actions — the REQUESTED destination URL.
   *
   * PHASE 17.2A: this is an INTENT, not an OBSERVATION. It is set from
   * `action.url` BEFORE dispatch and is populated whether or not the
   * navigation ever committed. It is retained for diagnostics/telemetry and
   * MUST NOT be read as evidence that the browser reached that URL, that the
   * page loaded, or that any goal was met. Goal verification reads the
   * OBSERVED tab URL (`step.url` / `context.url`) instead.
   */
  navigationDestination?: string;
  /** True if post-navigation page setup (load + re-inject) succeeded. */
  postNavigationSettled?: boolean;
  /** Monotonic counter: which perception cycle produced the context used this step. */
  perceptionGeneration?: number;
  expectedStateChange?: ExpectedStateChange | null;
  currentPageGeneration?: number;
  pageType?: PageCategory;
  semanticContext?: import('../semanticUnderstanding/semanticTypes').SanitizedSemanticContext;
  effectVerified?: boolean;
  effectStatus?: import('./effectVerifier').EffectStatus;
  effectDetails?: string;
}

export interface TaskState {
  task: string;
  currentStep: number;
  status: TaskStatus;
  previousActions: BrowserAction[];
  steps: StepRecord[];
  currentUrl: string;
  visitedElementIds: string[];
  retryCount: number;
  maxSteps: number;
  maxRetries: number;
  /**
   * M7 Phase 4: total provider reasoning attempts across the WHOLE task,
   * tracked separately from `retryCount` (which counts validator/execution
   * retries within M6). Observable and explicitly bounded:
   * total ≤ maxSteps × (1 + providerRetries).
   */
  providerAttempts: number;
  reason?: string;
  requiresUserConfirmationAction?: BrowserAction;
  plan?: TaskPlan;
  decisionTraceSummary?: ReturnType<AgentDecisionTracer['getSummary']>;
  /**
   * Monotonic counter incremented at the start of each perceivePage call.
   * Lets the dashboard distinguish stale perception context from fresh.
   */
  perceptionGeneration: number;
}

/**
 * Full state contract for an active browser agent task.
 * Extends the existing TaskState to maintain 100% backwards-compatibility
 * while adding first-class multi-page, constraint, and candidate tracking.
 */
export interface AgentTaskState extends TaskState {
  // Goal tracking
  taskGoal: string;
  normalizedGoal: string;

  // Browser targets
  targetTabId: number | null;
  windowId: number | null;

  // Dynamic page context
  currentPageGeneration: number;
  pageType: PageCategory;

  // Constraints & subgoals
  taskConstraints: StructuredConstraints;
  pendingSubgoals: SubGoalItem[];
  completedSteps: string[];

  // Action history
  recentActions: BrowserAction[];
  lastAction: BrowserAction | null;
  lastActionResult: { success: boolean; error?: string } | null;
  expectedStateChange: ExpectedStateChange | null;

  /**
   * PHASE 17.6 (C). Identifiers of actions the USER explicitly confirmed, i.e.
   * that `resumeWithConfirmation` actually dispatched. A `USER_CONFIRMED`
   * subgoal is proven from this list and from nothing else — a *proposal* that
   * needed confirmation is never an entry here, so this can never manufacture
   * consent. Content-free: action type and target id only, no values.
   */
  confirmedActionIds?: string[];

  /**
   * PHASE 17.6 (C). Bounded diagnostic trail of subgoal-verification outcomes
   * that did NOT prove completion. Bounded to 64 entries. Reasons are
   * structural ("marker not in observed state"), never page content.
   */
  subgoalVerificationHistory?: Array<{
    subgoalId: string;
    step: number;
    satisfied: boolean;
    reason: string;
    timestamp: number;
  }>;

  // Findings & candidates
  currentFindings: string[];
  candidateItems: CandidateProductItem[];
  candidateEntities?: any[];
  semanticGroups?: any[];
  semanticContext?: import('../semanticUnderstanding/semanticTypes').SanitizedSemanticContext;

  // Execution & failure metrics
  goalStatus: TaskStatus;
  failureCount: number;
  recoveryCount: number;
  confirmationState: ConfirmationStatus;
  activeWorldModelRef?: ActiveWorldModelRef | null;
  lastFailure?: FailureRecord | null;
  failureHistory?: FailureRecord[];

  // Hierarchical Planning & Memory (Phase 4)
  highLevelGoal?: import('../hierarchicalPlanning/hierarchicalTypes').HighLevelGoal;
  activeSubgoal?: import('../hierarchicalPlanning/hierarchicalTypes').Subgoal;
  subgoalGraphData?: import('../hierarchicalPlanning/hierarchicalTypes').SubgoalGraphData;
  planningEngineState?: import('../hierarchicalPlanning/hierarchicalTypes').PlanningEngineState;
  memoryHints?: import('../memory/memoryRetriever').MemoryHints;

  /**
   * OBSERVED viewport scroll position at the moment the task began, and the
   * latest observed position. Read from the live perception context
   * (`context.viewport.scroll_y`) — never from a requested or proposed action.
   *
   * These exist so a scroll goal can be decided from where the browser
   * actually IS, rather than from the fact that a scroll was once requested.
   * Purely observational: they grant no permission, and they are never
   * compared against an action's requested `amount`.
   */
  initialScrollY?: number | null;
  observedScrollY?: number | null;

  /**
   * Phase 8: verdict of the most recent independent Security Critic review.
   * Codes and reasons only — never any value.
   */
  lastSecurityCritic?: import('./securityCritic').SecurityCriticResult;

  /**
   * Phase 9: long-horizon task state. Remembers what this task has already
   * accomplished so long multi-step work does not repeat itself. Observational
   * and bounding only — it grants no permission and bypasses no gate.
   */
  longHorizon?: import('./longHorizon').LongHorizonSnapshot;

  /**
   * Phase 9: how many times a COMPLETED subgoal was re-selected during this
   * task. Should stay at 0 for a well-behaved long-horizon run.
   */
  longHorizonRepeatCount?: number;

  /**
   * Phase 10: sanitized, value-free recovery history. Each entry records the
   * failure CODE, the chosen strategy, the attempt number, the page generation
   * and the outcome — never any raw value or raw page text.
   */
  recoveryHistory?: import('./recoveryEngine').RecoveryHistoryEntry[];

  /** Phase 10: total recovery attempts charged against the task budget. */
  totalRecoveryAttempts?: number;

  /** Phase 10: strategy chosen for the most recent recovery decision. */
  recoveryStrategy?: import('./recoveryEngine').RecoveryStrategy;

  /**
   * Phase 13 Harness: the cycle-coordination record for this task.
   *
   * Verdicts, codes and counters only — never a URL, page text, or any model
   * output. The Harness is NOT a security authority: a CONTINUE verdict is not
   * permission to dispatch, and the full authoritative pipeline still runs,
   * unchanged and in the same order, on every cycle the Harness allows.
   */
  harnessRun?: import('./harness').HarnessRunSummary;

  /**
   * Phase 12 Containment: the most recent environmental boundary decision.
   * Codes and reasons only — never a URL, page text, or any model output.
   */
  containmentDecision?: {
    code: import('./containment').ContainmentCode;
    contained: boolean;
    reason: string;
    /** Short scope summary, e.g. `contained:example.com`. */
    scope: string;
  } | null;
}

/**
 * Initializes a clean AgentTaskState for a given goal.
 */
export function createAgentTaskState(
  task: string,
  options: {
    targetTabId?: number | null;
    windowId?: number | null;
    currentUrl?: string;
    maxSteps?: number;
    maxRetries?: number;
    normalizedGoal?: string;
    constraints?: StructuredConstraints;
    subgoals?: SubGoalItem[];
  } = {}
): AgentTaskState {
  const maxSteps = options.maxSteps ?? 10;
  const maxRetries = options.maxRetries ?? 2;

  return {
    // Existing TaskState fields
    task,
    currentStep: 0,
    status: 'IN_PROGRESS',
    previousActions: [],
    steps: [],
    currentUrl: options.currentUrl ?? '',
    visitedElementIds: [],
    confirmedActionIds: [],
    subgoalVerificationHistory: [],
    retryCount: 0,
    maxSteps,
    maxRetries,
    providerAttempts: 0,
    perceptionGeneration: 0,

    // Extended AgentTaskState fields
    taskGoal: task,
    normalizedGoal: options.normalizedGoal ?? task,
    targetTabId: options.targetTabId ?? null,
    windowId: options.windowId ?? null,
    currentPageGeneration: 0,
    pageType: 'unknown',
    taskConstraints: options.constraints ?? {},
    pendingSubgoals: options.subgoals ?? [],
    completedSteps: [],
    recentActions: [],
    lastAction: null,
    lastActionResult: null,
    expectedStateChange: null,
    currentFindings: [],
    candidateItems: [],
    candidateEntities: [],
    semanticGroups: [],
    goalStatus: 'IN_PROGRESS',
    failureCount: 0,
    recoveryCount: 0,
    confirmationState: 'NONE',
    activeWorldModelRef: null,
    lastFailure: null,
    failureHistory: [],
  };
}

/**
 * Invalidate the state derived from a page generation, WITHOUT advancing the
 * generation counter.
 *
 * Stale-target protection needs the invalidation on its own. `AgentLoop` anchors
 * `currentPageGeneration` to the generation the content script actually reported
 * (`worldModel.page.pageGeneration`), and the stale-world-model guard in
 * `normalizePerceptionResult` compares a received model against it
 * (`liveGeneration < localGeneration`). Advancing the counter without a matching
 * content-script world-model build therefore pushes it ahead of the page's own
 * generation, and the NEXT genuinely fresh model is rejected as stale: the task
 * aborts with "Perception failed" before Goal Verification is ever consulted.
 * That is fail-closed, but it is a false positive - the model was not stale.
 */
export function invalidatePageGenerationState(
  state: AgentTaskState,
  generation: number = state.currentPageGeneration
): AgentTaskState {
  // Old element IDs and active world model ref belong to destroyed or mutated DOM tree; clear them
  state.visitedElementIds = [];
  state.activeWorldModelRef = null;
  if (generation > 0) {
    worldModelStore.invalidateGeneration(generation);
  }
  return state;
}

/**
 * Advance page generation on meaningful navigation or DOM re-render.
 * Clears stale DOM references from visited elements and resets transient failure count.
 */
export function advancePageGeneration(
  state: AgentTaskState,
  newUrl?: string,
  detectedPageType?: PageCategory
): AgentTaskState {
  const previousGeneration = state.currentPageGeneration;
  state.currentPageGeneration += 1;
  state.perceptionGeneration = state.currentPageGeneration;
  if (newUrl) {
    state.currentUrl = newUrl;
  }
  if (detectedPageType) {
    state.pageType = detectedPageType;
  }
  invalidatePageGenerationState(state, previousGeneration);
  return state;
}
