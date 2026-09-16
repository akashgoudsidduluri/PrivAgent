import { describe, it, expect } from 'vitest';
import {
  createTaskPlan,
  updateTaskPlanProgress,
  diagnoseFailureAndReplan,
} from '../extension/src/agent/taskPlanner';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';

function makeMockContext(): AgentContextPayload {
  return {
    url: 'https://bank.example.com/app',
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 0,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  };
}

describe('PrivAgent Task Planner & Dynamic Replanner (Features 3 & 4)', () => {
  it('creates structured multi-step plans for complex user goals', () => {
    const plan = createTaskPlan('Open the account details and find the recent transactions');
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(plan.status).toBe('PLANNED');
    expect(plan.recoveryAttempts).toBe(0);
    expect(plan.maxRecoveryAttempts).toBe(2);
  });

  it('tracks progress correctly as steps are completed', () => {
    let plan = createTaskPlan('Scroll down to inspect page');
    expect(plan.currentStepIndex).toBe(0);

    const action: BrowserAction = { action: 'scroll', direction: 'down', amount: 200 };
    plan = updateTaskPlanProgress(plan, 0, 'COMPLETED', action);

    expect(plan.steps[0]!.status).toBe('COMPLETED');
    expect(plan.steps[0]!.completedAction).toEqual(action);
    expect(plan.status).toBe('COMPLETED');
  });

  it('diagnoses stale targets and allows bounded recovery', () => {
    const plan = createTaskPlan('Find account number');
    const ctx = makeMockContext();
    const action: BrowserAction = { action: 'click', target: 'det_stale' };

    const diag = diagnoseFailureAndReplan(
      plan,
      action,
      "Target element 'det_stale' does not exist in context",
      ctx
    );

    expect(diag.canRecover).toBe(true);
    expect(diag.diagnosis).toBe('STALE_TARGET');
  });

  it('fails closed when max recovery attempts (2) are exceeded', () => {
    const plan = createTaskPlan('Find account number');
    plan.recoveryAttempts = 2; // Limit reached
    const ctx = makeMockContext();
    const action: BrowserAction = { action: 'click', target: 'det_stale' };

    const diag = diagnoseFailureAndReplan(
      plan,
      action,
      "Target element 'det_stale' not found",
      ctx
    );

    expect(diag.canRecover).toBe(false);
    expect(diag.diagnosis).toBe('UNRECOVERABLE');
    expect(diag.reason).toMatch(/exceeded maximum recovery limit/i);
  });

  it('strictly rejects automatic recovery for policy-blocked actions', () => {
    const plan = createTaskPlan('Read sensitive document');
    const ctx = makeMockContext();
    const action: BrowserAction = { action: 'click', target: 'det_sensitive' };

    const diag = diagnoseFailureAndReplan(
      plan,
      action,
      'Policy Denied: Action blocked by security policy',
      ctx
    );

    expect(diag.canRecover).toBe(false);
    expect(diag.diagnosis).toBe('POLICY_BLOCKED');
  });
});
