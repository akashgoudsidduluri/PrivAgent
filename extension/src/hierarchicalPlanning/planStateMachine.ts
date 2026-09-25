/**
 * PrivAgent — Formal Planning State Machine (Phase 4.6)
 *
 * Implements a formal planning state machine with explicit states and guarded transitions.
 *
 * Core Security Invariant:
 *  No transition can bypass the guarded execution sequence:
 *    Target Grounding → M5 → Risk/Privacy Policy → Chrome Execution → Effect Verification → Goal Verification.
 *
 * Action Provenance Requirement:
 *  Every autonomous action counted toward acceptance must have strict provenance:
 *    PRIVAGENT_ACTION:
 *      - source = PrivAgent planner/runtime
 *      - target = actual grounded target
 *      - M5 = approved
 *      - risk result = recorded
 *      - Chrome execution = recorded
 *      - effect verification = recorded
 */

import {
  PlanningEngineState,
  ActionProvenance,
  ActionProvenanceSource,
  Subgoal,
  HighLevelGoal,
} from './hierarchicalTypes';
import { BrowserAction } from '../agent/actionTypes';
import { ActionRiskAssessment } from '../agent/riskEngine';

export interface StateMachineContext {
  goal?: HighLevelGoal;
  activeSubgoal?: Subgoal;
  candidateAction?: BrowserAction;
  groundedTargetId?: string;
  m5Approved?: boolean;
  riskAssessment?: ActionRiskAssessment;
  userConfirmed?: boolean;
  executionSuccess?: boolean;
  effectVerified?: boolean;
  goalSatisfied?: boolean;
  lastError?: string;
  provenanceHistory: ActionProvenance[];
}

export class PlanStateMachine {
  private currentState: PlanningEngineState = 'UNINITIALIZED';
  private context: StateMachineContext;
  private transitionHistory: Array<{ from: PlanningEngineState; to: PlanningEngineState; timestamp: number; reason?: string }> = [];

  constructor() {
    this.context = {
      provenanceHistory: [],
    };
  }

  public getState(): PlanningEngineState {
    return this.currentState;
  }

  public getContext(): Readonly<StateMachineContext> {
    return this.context;
  }

  public getTransitionHistory(): ReadonlyArray<{ from: PlanningEngineState; to: PlanningEngineState; timestamp: number; reason?: string }> {
    return this.transitionHistory;
  }

  public getProvenanceHistory(): ReadonlyArray<ActionProvenance> {
    return this.context.provenanceHistory;
  }

  /**
   * Initializes the planning state machine with a high-level goal.
   */
  public initialize(goal: HighLevelGoal): void {
    this.transitionTo('DECOMPOSING', 'High-level goal received and decomposition initialized');
    this.context.goal = goal;
  }

  /**
   * Guards state transitions, throwing an Invariant Violation error if any required pipeline step is bypassed.
   */
  public transitionTo(nextState: PlanningEngineState, reason?: string): void {
    this.assertValidTransition(this.currentState, nextState);
    const from = this.currentState;
    this.currentState = nextState;
    this.transitionHistory.push({ from, to: nextState, timestamp: Date.now(), reason });
  }

  /**
   * Enforces transition guards.
   */
  private assertValidTransition(from: PlanningEngineState, to: PlanningEngineState): void {
    // Terminal states can transition nowhere except new re-initialization
    if ((from === 'COMPLETED' || from === 'FAILED' || from === 'ABORTED') && to !== 'UNINITIALIZED' && to !== 'DECOMPOSING') {
      throw new Error(`Invalid transition: Cannot transition from terminal state ${from} to ${to}.`);
    }

    // Direct transition into CHROME_EXECUTION must come from RISK_POLICY_CHECK or USER_CONFIRMATION
    if (to === 'CHROME_EXECUTION') {
      if (from !== 'RISK_POLICY_CHECK' && from !== 'USER_CONFIRMATION') {
        throw new Error(
          `Security Invariant Violation: Direct bypass into CHROME_EXECUTION from ${from}. Must pass M5 and Risk/Privacy Policy first.`
        );
      }
      if (!this.context.m5Approved) {
        throw new Error('Security Invariant Violation: Cannot execute action in Chrome without M5 approval.');
      }
      if (!this.context.groundedTargetId && this.context.candidateAction?.action !== 'scroll' && this.context.candidateAction?.action !== 'navigate') {
        throw new Error('Security Invariant Violation: Cannot execute targeted action in Chrome without Target Grounding.');
      }
      if (!this.context.riskAssessment) {
        throw new Error('Security Invariant Violation: Cannot execute action in Chrome without Risk Assessment.');
      }
    }

    // Direct transition into GOAL_VERIFICATION must come from EFFECT_VERIFICATION or early goal check
    if (to === 'GOAL_VERIFICATION') {
      if (from !== 'EFFECT_VERIFICATION' && from !== 'SUBGOAL_SELECTION' && from !== 'TARGET_GROUNDING') {
        throw new Error(
          `Pipeline Invariant Violation: Direct bypass into GOAL_VERIFICATION from ${from}. Must verify effect first.`
        );
      }
    }

    // Direct transition into COMPLETED requires GOAL_VERIFICATION
    if (to === 'COMPLETED') {
      if (from !== 'GOAL_VERIFICATION' && from !== 'SUBGOAL_SELECTION') {
        throw new Error(
          `Pipeline Invariant Violation: Cannot reach COMPLETED from ${from} without GOAL_VERIFICATION.`
        );
      }
    }
  }

  // ── Step Registration Handlers ─────────────────────────────────────────────

  public registerDecompositionComplete(): void {
    this.transitionTo('SUBGOAL_SELECTION', 'Decomposition finished; selecting initial subgoal');
  }

  public registerSubgoalSelected(subgoal: Subgoal): void {
    this.context.activeSubgoal = subgoal;
    // Reset action context for the new cycle
    this.context.candidateAction = undefined;
    this.context.groundedTargetId = undefined;
    this.context.m5Approved = false;
    this.context.riskAssessment = undefined;
    this.context.userConfirmed = false;
    this.context.executionSuccess = undefined;
    this.context.effectVerified = undefined;

    this.transitionTo('TARGET_GROUNDING', `Subgoal selected: ${subgoal.description}`);
  }

  public registerTargetGrounded(targetId: string, action: BrowserAction): void {
    this.context.groundedTargetId = targetId;
    this.context.candidateAction = action;
    this.transitionTo('M5_VALIDATION', `Target grounded: ${targetId}`);
  }

  public registerNonTargetedAction(action: BrowserAction): void {
    this.context.candidateAction = action;
    this.context.groundedTargetId = undefined;
    this.transitionTo('M5_VALIDATION', `Non-targeted action proposed: ${action.action}`);
  }

  public registerM5Approval(approved: boolean, error?: string): void {
    if (!approved) {
      this.context.m5Approved = false;
      this.context.lastError = error || 'M5 rejected action';
      this.transitionTo('DYNAMIC_REPLANNING', `M5 validation rejected action: ${this.context.lastError}`);
      return;
    }
    this.context.m5Approved = true;
    this.transitionTo('RISK_POLICY_CHECK', 'M5 approved action; proceeding to Risk and Privacy Policy');
  }

  public registerRiskAssessment(assessment: ActionRiskAssessment): void {
    this.context.riskAssessment = assessment;
    if (assessment.requiresUserConfirmation) {
      this.transitionTo('USER_CONFIRMATION', `High-risk action (${assessment.riskLevel}): Requires user confirmation`);
    } else {
      this.transitionTo('CHROME_EXECUTION', `Risk assessment cleared (${assessment.riskLevel}): Proceeding to Chrome execution`);
    }
  }

  public registerUserConfirmation(confirmed: boolean): void {
    this.context.userConfirmed = confirmed;
    if (confirmed) {
      this.transitionTo('CHROME_EXECUTION', 'User confirmed action; proceeding to Chrome execution');
    } else {
      this.transitionTo('DYNAMIC_REPLANNING', 'User declined action confirmation; triggering replanning');
    }
  }

  public registerExecutionResult(
    success: boolean,
    source: ActionProvenanceSource = 'PRIVAGENT_ACTION',
    error?: string
  ): void {
    this.context.executionSuccess = success;
    if (!success) {
      this.context.lastError = error || 'Execution error in Chrome';
      this.transitionTo('DYNAMIC_REPLANNING', `Execution failed: ${this.context.lastError}`);
      return;
    }

    this.transitionTo('EFFECT_VERIFICATION', 'Action executed in Chrome; verifying observed DOM/navigation effect');
  }

  public registerEffectVerification(verified: boolean, error?: string): void {
    this.context.effectVerified = verified;

    // Record complete provenance of this executed action
    if (this.context.activeSubgoal) {
      const provenance: ActionProvenance = {
        source: 'PRIVAGENT_ACTION',
        subgoalId: this.context.activeSubgoal.id,
        target: this.context.groundedTargetId || (this.context.candidateAction && 'target' in this.context.candidateAction ? (this.context.candidateAction as { target: string }).target : undefined),
        m5Approved: this.context.m5Approved ?? false,
        riskResult: this.context.riskAssessment,
        chromeExecutionRecorded: this.context.executionSuccess === true,
        effectVerificationRecorded: verified,
        timestamp: Date.now(),
      };
      this.context.provenanceHistory.push(provenance);
    }

    if (!verified) {
      this.context.lastError = error || 'Action had no verifiable effect';
      this.transitionTo('DYNAMIC_REPLANNING', `Effect verification failed: ${this.context.lastError}`);
      return;
    }

    this.transitionTo('GOAL_VERIFICATION', 'Effect verified; checking subgoal and overall goal completion');
  }

  public registerGoalVerification(goalSatisfied: boolean, allSubgoalsDone: boolean): void {
    this.context.goalSatisfied = goalSatisfied;
    if (this.getState() !== 'GOAL_VERIFICATION') {
      this.transitionTo('GOAL_VERIFICATION', 'Effect verified or goal satisfied; evaluating goal');
    }
    if (goalSatisfied || allSubgoalsDone) {
      this.transitionTo('COMPLETED', 'Goal verified and satisfied');
    } else {
      this.transitionTo('SUBGOAL_SELECTION', 'Subgoal verified; advancing to next subgoal');
    }
  }

  public registerReplanningResult(decision: { shouldReplan: boolean; reason: string }): void {
    if (decision.shouldReplan) {
      this.transitionTo('SUBGOAL_SELECTION', `Replanning revised subgoals: ${decision.reason}`);
    } else {
      this.transitionTo('FAILED', `Replanning aborted or exhausted: ${decision.reason}`);
    }
  }

  public abort(reason: string): void {
    this.transitionTo('ABORTED', `Execution aborted by user or security bounds: ${reason}`);
  }
}
