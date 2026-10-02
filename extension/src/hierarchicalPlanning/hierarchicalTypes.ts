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
import type { DestinationDeclaration } from '../planning/destinationNormalizer';

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

  /**
   * POST-17.10 Step 7 — the user's own destination intent, normalized once from
   * `rawUserPrompt` and carried as TYPED metadata alongside the goal.
   *
   * It is deliberately NOT folded into `sanitizedGoalDescription`, and NOT
   * encoded in `targetEntities`: that field already carries content/query
   * entities (see `extractEntitiesAndConstraints`), and `targetEntity` on a
   * `Subgoal` is already load-bearing for element identity and for
   * `ELEMENT_EXISTS`. Reusing either would make `LISTING` indistinguishable
   * from "the product to search for".
   *
   * Direction of flow is ONE WAY and is fixed by the type: the declaration is
   * derived from the USER PROMPT only. Nothing in the runtime may write to it —
   * every field is `readonly`, and no browser state, page classification, model
   * output, action, or execution result is an input to producing it. The
   * declaration therefore cannot be laundered from an observation.
   */
  destinationDeclaration?: DestinationDeclaration;
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
    /**
     * POST-17.10 Step 7. The subgoal's completion condition is the USER's
     * declared destination, verified against OBSERVED page identity by
     * `verifyDestination`.
     *
     * This is the eighth condition type, and it exists because the destination
     * claim is not expressible with any of the other seven. It is also the
     * ONLY condition type that can be satisfied, so a destination subgoal
     * cannot complete by dispatch success, by an affordance merely existing,
     * or by navigation having occurred.
     */
    | 'DESTINATION_VERIFIED'
    | 'CUSTOM';
  /**
   * Intentionally NEVER used for destination semantics. A destination subgoal
   * carries its constraint in `Subgoal.destination`, typed. Putting `LISTING`
   * here would overload a generic string field that other condition types read
   * as a URL fragment, an element name or an affordance name.
   */
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
  /**
   * POST-17.10 Step 7 — the destination constraint this subgoal must satisfy,
   * for a `DESTINATION_VERIFIED` subgoal.
   *
   * Copied verbatim from `HighLevelGoal.destinationDeclaration` at decomposition
   * time. Structurally distinguishable from every other subgoal field: a
   * destination subgoal is the ONLY subgoal that has one, so "is this a
   * destination subgoal" is a type question, not a string-matching question.
   *
   * Its `entryUrl` is carried for provenance only. The verifier never reads it
   * (N18 in `destinationNormalizer.ts`), so an entry site can never become a
   * destination constraint by arriving here.
   */
  destination?: DestinationDeclaration;
  failureReason?: string;
  suggestedAction?: BrowserAction;
  provenance?: ActionProvenance;
}

/**
 * POST-17.10 Step 10 — the user-declared destination, in the exact shape the
 * REASONER receives it.
 *
 * Step 9 measured the provider egress payload and found it to be exactly
 * `{task, context, previousActions}`: the typed declaration, the active subgoal
 * and its description were all absent. The reasoner was told the raw prompt and
 * nothing else, so a `role = LISTING` destination could not influence the route
 * it chose. This is the representation that closes that gap.
 *
 * Design constraints, each one enforced elsewhere and re-asserted by tests:
 *
 *  - `provenance` is a required literal, not a debug string. A constraint whose
 *    origin is not the user's own words cannot be expressed here at all.
 *  - `role` is a list drawn from the EXISTING `SemanticPageType` enum. There is
 *    no new ontology and no way to name a page the system cannot classify.
 *  - `destinationUrl` is present ONLY when the user explicitly named the
 *    destination as a URL. It is never synthesised from a role, from the entry
 *    site, from the current URL, or from any page content.
 *  - `entryUrl` is carried for provenance and is explicitly NOT a destination
 *    constraint. Nothing in the verifier or the navigator reads it.
 *  - There is no `text`, `value` or `input` field. Those keys are rejected at
 *    any nesting depth by `backend/app/security.py`, and a destination
 *    declaration has no business carrying prose.
 *
 * Direction of flow is one way and fixed by the type: this is serialized FROM a
 * readonly `DestinationDeclaration`. Nothing writes back into it.
 */
export interface DeclaredDestinationConstraint {
  readonly provenance: 'USER_DECLARED_DESTINATION';
  /** Closed-enum page roles. Absent when the user named a URL instead. */
  readonly role?: readonly string[];
  /** Present ONLY when the user explicitly declared the destination as a URL. */
  readonly destinationUrl?: string;
  /** Where the browser should start. Never a destination constraint. */
  readonly entryUrl?: string;
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
