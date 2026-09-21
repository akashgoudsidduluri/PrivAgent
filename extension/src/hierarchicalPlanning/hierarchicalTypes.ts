/**
 * PrivAgent — Hierarchical Planning & Task Orchestration Types (Phase 4.1)
 *
 * Defines the core data structures for high-level goals, subgoals,
 * dependency DAGs, planning state machines, provenance tracking, and bounded autonomy.
 *
 * Security Invariants:
 *  - "THE MODEL CAN PROPOSE. THE LOCAL SYSTEM DECIDES."
 *  - The planner has zero direct execution authority.
 *  - Every action must transition through:
 *      Target Grounding → M5 → Risk/Privacy Policy → Chrome Execution → Effect Verification → Goal Verification.
 *  - Raw credentials, sensitive PII, or raw OCR values are never stored in plan state or transmitted remotely.
 */

import { BrowserAction, ActionType } from '../agent/actionTypes';
import { ActionRiskAssessment } from '../agent/riskEngine';

// ── Action Execution Provenance ─────────────────────────────────────────────

export type ActionProvenanceSource = 'PRIVAGENT_ACTION' | 'TEST_HARNESS_ACTION';

export interface ActionProvenance {
  source: ActionProvenanceSource;
  subgoalId: string;
  target?: string;
  m5Approved: boolean;
  riskResult?: ActionRiskAssessment;
  chromeExecutionRecorded: boolean;
  effectVerificationRecorded: boolean;
  timestamp: number;
}

// ── High-Level Goals ────────────────────────────────────────────────────────

export type TaskCategory =
  | 'INFORMATION_RETRIEVAL'
  | 'ECOMMERCE_SEARCH'
  | 'FORM_FILL'
  | 'AUTHENTICATION'
  | 'GENERIC_INTERACTION'
  | 'UNSUPPORTED_TASK_TYPE';

export interface HighLevelGoal {
  goalId: string;
  rawUserPrompt: string; // Kept strictly local on-device
  sanitizedGoalDescription: string;
  taskCategory: TaskCategory;
  targetEntities: string[];
  constraints: Record<string, string | number | boolean>;
  createdAt: number;
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ABORTED';
}

// ── Subgoals ────────────────────────────────────────────────────────────────

export type SubgoalCategory =
  | 'NAVIGATE'
  | 'SEARCH'
  | 'LOCATE'
  | 'EXTRACT'
  | 'FILL'
  | 'SELECT'
  | 'CONFIRM'
  | 'VERIFY'
  | 'RECOVER';

export type SubgoalState =
  | 'PENDING'
  | 'READY'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED';

export interface SubgoalVerificationCondition {
  type:
    | 'URL_CONTAINS'
    | 'ELEMENT_EXISTS'
    | 'ELEMENT_TEXT_CONTAINS'
    | 'AFFORDANCE_AVAILABLE'
    | 'STATE_CHANGED'
    | 'USER_CONFIRMED'
    | 'CUSTOM';
  expectedValue?: string;
  description: string;
}

export interface Subgoal {
  id: string;
  goalId: string;
  index: number;
  description: string;
  category: SubgoalCategory;
  targetEntity?: string;
  expectedActionType?: ActionType | 'verify' | 'inspect';
  state: SubgoalState;
  prerequisites: string[]; // IDs of subgoals that must complete before this is READY
  retryCount: number;
  maxRetries: number;
  verificationCondition?: SubgoalVerificationCondition;
  failureReason?: string;
  suggestedAction?: BrowserAction;
  provenance?: ActionProvenance;
}

// ── Dependency DAG ──────────────────────────────────────────────────────────

export interface SubgoalDependencyEdge {
  fromSubgoalId: string;
  toSubgoalId: string;
}

export interface SubgoalGraphData {
  goalId: string;
  subgoals: Record<string, Subgoal>;
  edges: SubgoalDependencyEdge[];
}

// ── Planning State Machine States ───────────────────────────────────────────

export type PlanningEngineState =
  | 'UNINITIALIZED'
  | 'DECOMPOSING'
  | 'SUBGOAL_SELECTION'
  | 'TARGET_GROUNDING'
  | 'M5_VALIDATION'
  | 'RISK_POLICY_CHECK'
  | 'USER_CONFIRMATION'
  | 'CHROME_EXECUTION'
  | 'EFFECT_VERIFICATION'
  | 'GOAL_VERIFICATION'
  | 'DYNAMIC_REPLANNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABORTED';

// ── Replanning & Failure Diagnoses ──────────────────────────────────────────

export type ReplanningTrigger =
  | 'LOGIN_REQUIRED'
  | 'MODAL_INTERCEPTED'
  | 'EMPTY_RESULTS'
  | 'STALE_TARGET'
  | 'ACTION_NO_EFFECT'
  | 'PAGE_MUTATION'
  | 'SUBGOAL_VERIFICATION_FAILED'
  | 'POLICY_REJECTION'
  | 'EXECUTION_ERROR'
  | 'USER_REQUESTED_CHANGE';

export interface ReplanningDecision {
  triggeredBy: ReplanningTrigger;
  shouldReplan: boolean;
  reason: string;
  newSubgoals?: Subgoal[];
  subgoalsToCancel?: string[];
  requiresUserConfirmation?: boolean;
  userConfirmationPrompt?: string;
}

// ── Bounded Autonomy & Constraints ──────────────────────────────────────────

export interface PlanningBounds {
  maxSubgoals: number;         // Default: 10
  maxReplans: number;          // Default: 3
  maxTotalActions: number;     // Default: 15
  maxRepeatedFailures: number; // Default: 2 per target/action
}

export const DEFAULT_PLANNING_BOUNDS: PlanningBounds = {
  maxSubgoals: 10,
  maxReplans: 3,
  maxTotalActions: 15,
  maxRepeatedFailures: 2,
};

// ── Decision Provenance & Telemetry ─────────────────────────────────────────

export interface PlanningTelemetryEntry {
  entryId: string;
  timestamp: number;
  state: PlanningEngineState;
  subgoalId?: string;
  actionProposed?: BrowserAction;
  provenanceSource?: ActionProvenanceSource;
  m5Approved?: boolean;
  riskRating?: string;
  executionSuccess?: boolean;
  effectVerified?: boolean;
  goalProgressPercent?: number;
  notes?: string;

  // Memory Influence Observables
  memoryInfluencedPlanning?: boolean;
  memoryInfluencedRecovery?: boolean;
  memoryConflictDetected?: boolean;
  memoryOverriddenByCurrentWorld?: boolean;
  memoryMetadata?: {
    memoryId: string;
    memoryType: string;
    memoryTrust: number;
    memoryScope: any;
    memoryAgeMs: number;
    memoryConfidence: number;
  }[];
}
