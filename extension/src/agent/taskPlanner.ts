/**
 * PrivAgent — Multi-Step Task Planner & Dynamic Replanner (Features 3 & 4)
 *
 * Provides structured multi-step task representation, progress tracking,
 * failure diagnosis, and bounded replanning.
 *
 * Security Invariant:
 *  - Plans NEVER store raw sensitive PII, credentials, or raw OCR values.
 *  - Replanning is strictly bounded (max 2 recovery attempts per task) to prevent infinite loops.
 */

import { BrowserAction, ActionType } from './actionTypes';
import { AgentContextPayload } from '../privacy/types';

export type PlanStepStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface PlanStep {
  id: string;
  stepNumber: number;
  description: string;
  expectedActionType: ActionType | 'inspect' | 'verify';
  status: PlanStepStatus;
  targetHint?: string;
  completedAction?: BrowserAction;
  error?: string;
}

export type TaskPlanStatus =
  | 'PLANNED'
  | 'RUNNING'
  | 'WAITING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REPLANNING'
  | 'STOPPED';

export interface TaskPlan {
  taskId: string;
  goal: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: TaskPlanStatus;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  createdAt: number;
  updatedAt: number;
  failureDiagnosis?: string;
}

export type FailureDiagnosis =
  | 'STALE_TARGET'
  | 'DOM_MUTATED'
  | 'ACTION_TIMEOUT'
  | 'MISALIGNED_TARGET'
  | 'POLICY_BLOCKED'
  | 'UNRECOVERABLE';

export interface ReplanningDecision {
  canRecover: boolean;
  diagnosis: FailureDiagnosis;
  recoveryAction?: BrowserAction;
  reason: string;
}

/**
 * Creates an initial deterministic multi-step plan for a user task.
 */
export function createTaskPlan(task: string, initialUrl?: string): TaskPlan {
  const lower = task.toLowerCase();
  const steps: PlanStep[] = [];
  const taskId = `plan-${Date.now()}`;

  // Decompose based on intent semantics
  if (lower.includes('account number') || lower.includes('account')) {
    steps.push({
      id: `${taskId}-s1`,
      stepNumber: 1,
      description: 'Locate account overview section',
      expectedActionType: 'inspect',
      status: 'PENDING',
      targetHint: 'account details',
    });
    steps.push({
      id: `${taskId}-s2`,
      stepNumber: 2,
      description: 'Select account details view',
      expectedActionType: 'click',
      status: 'PENDING',
      targetHint: 'btn-account-details',
    });
    steps.push({
      id: `${taskId}-s3`,
      stepNumber: 3,
      description: 'Verify account number on-device with zero network transmission',
      expectedActionType: 'verify',
      status: 'PENDING',
    });
  } else if (lower.includes('transaction')) {
    steps.push({
      id: `${taskId}-s1`,
      stepNumber: 1,
      description: 'Navigate to activity / transaction section',
      expectedActionType: 'click',
      status: 'PENDING',
      targetHint: 'transactions',
    });
    steps.push({
      id: `${taskId}-s2`,
      stepNumber: 2,
      description: 'Scroll through transaction entries',
      expectedActionType: 'scroll',
      status: 'PENDING',
    });
    steps.push({
      id: `${taskId}-s3`,
      stepNumber: 3,
      description: 'Inspect recent transaction history',
      expectedActionType: 'inspect',
      status: 'PENDING',
    });
  } else if (lower.includes('scroll')) {
    steps.push({
      id: `${taskId}-s1`,
      stepNumber: 1,
      description: 'Perform downward page scroll',
      expectedActionType: 'scroll',
      status: 'PENDING',
    });
  } else {
    // Default 2-step exploratory plan
    steps.push({
      id: `${taskId}-s1`,
      stepNumber: 1,
      description: `Perceive and inspect ${initialUrl || 'target page'}`,
      expectedActionType: 'inspect',
      status: 'PENDING',
    });
    steps.push({
      id: `${taskId}-s2`,
      stepNumber: 2,
      description: 'Execute requested goal action safely',
      expectedActionType: 'click',
      status: 'PENDING',
    });
  }

  return {
    taskId,
    goal: task,
    steps,
    currentStepIndex: 0,
    status: 'PLANNED',
    recoveryAttempts: 0,
    maxRecoveryAttempts: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Updates the status of the current step in the task plan.
 */
export function updateTaskPlanProgress(
  plan: TaskPlan,
  stepIndex: number,
  status: PlanStepStatus,
  action?: BrowserAction,
  error?: string
): TaskPlan {
  const updatedSteps = plan.steps.map((s, idx) => {
    if (idx === stepIndex) {
      return {
        ...s,
        status,
        completedAction: action || s.completedAction,
        error: error || s.error,
      };
    }
    return s;
  });

  const nextIndex = status === 'COMPLETED' ? stepIndex + 1 : stepIndex;
  const allCompleted = updatedSteps.every((s) => s.status === 'COMPLETED');
  const anyFailed = updatedSteps.some((s) => s.status === 'FAILED');

  let overallStatus: TaskPlanStatus = plan.status;
  if (allCompleted) overallStatus = 'COMPLETED';
  else if (anyFailed && plan.recoveryAttempts >= plan.maxRecoveryAttempts) overallStatus = 'FAILED';
  else overallStatus = 'RUNNING';

  return {
    ...plan,
    steps: updatedSteps,
    currentStepIndex: nextIndex,
    status: overallStatus,
    updatedAt: Date.now(),
  };
}

/**
 * Diagnoses an action failure and determines whether bounded replanning / recovery is possible.
 */
export function diagnoseFailureAndReplan(
  plan: TaskPlan,
  failedAction: BrowserAction,
  errorMessage: string,
  context: AgentContextPayload
): ReplanningDecision {
  const errLower = errorMessage.toLowerCase();

  // 1. Check recovery bounds
  if (plan.recoveryAttempts >= plan.maxRecoveryAttempts) {
    return {
      canRecover: false,
      diagnosis: 'UNRECOVERABLE',
      reason: `Exceeded maximum recovery limit (${plan.maxRecoveryAttempts} attempts). Failing closed to prevent loop.`,
    };
  }

  // 2. Diagnose failure type
  let diagnosis: FailureDiagnosis = 'UNRECOVERABLE';

  if (errLower.includes('does not exist') || errLower.includes('not found') || errLower.includes('missing')) {
    diagnosis = 'STALE_TARGET';
  } else if (errLower.includes('timeout') || errLower.includes('timed out')) {
    diagnosis = 'ACTION_TIMEOUT';
  } else if (errLower.includes('policy denied') || errLower.includes('forbidden')) {
    diagnosis = 'POLICY_BLOCKED';
  } else if (errLower.includes('mutated') || errLower.includes('changed')) {
    diagnosis = 'DOM_MUTATED';
  } else {
    diagnosis = 'MISALIGNED_TARGET';
  }

  // Policy blocks cannot be recovered automatically (requires explicit user change or abort)
  if (diagnosis === 'POLICY_BLOCKED') {
    return {
      canRecover: false,
      diagnosis,
      reason: `Action was denied by security policy: ${errorMessage}. Automated recovery is blocked.`,
    };
  }

  // Timeouts can be retried once with a gentle observation step
  if (diagnosis === 'ACTION_TIMEOUT') {
    return {
      canRecover: true,
      diagnosis,
      recoveryAction: { action: 'scroll', direction: 'down', amount: 200, reason: 'Recovering after action timeout' },
      reason: 'DOM interaction timed out; performing observation scroll to settle page state.',
    };
  }

  // Stale targets or mutated DOM trigger self-healing target resolution
  if (diagnosis === 'STALE_TARGET' || diagnosis === 'DOM_MUTATED') {
    return {
      canRecover: true,
      diagnosis,
      reason: `Target was stale or missing (${diagnosis}). Triggering self-healing selector recovery.`,
    };
  }

  return {
    canRecover: false,
    diagnosis: 'UNRECOVERABLE',
    reason: `Unrecoverable execution error: ${errorMessage}`,
  };
}
