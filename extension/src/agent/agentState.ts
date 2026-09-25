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
  | 'RECOVERY_EXHAUSTED';

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

export interface StepRecord {
  step: number;
  action: BrowserAction;
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
  selfHealing?: SelfHealingResult;
  /** Populated for navigate actions — the destination URL. */
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
  // Old element IDs and active world model ref belong to destroyed or mutated DOM tree; clear them
  state.visitedElementIds = [];
  state.activeWorldModelRef = null;
  if (previousGeneration > 0) {
    worldModelStore.invalidateGeneration(previousGeneration);
  }
  return state;
}
