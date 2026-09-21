import { describe, it, expect } from 'vitest';
import { PlanStateMachine } from '../extension/src/hierarchicalPlanning/planStateMachine';
import { HighLevelGoal, Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import { PlannerContextBuilder } from '../extension/src/hierarchicalPlanning/plannerContextBuilder';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { PlannerTelemetryLogger } from '../extension/src/hierarchicalPlanning/plannerTelemetry';

describe('PrivAgent Phase 4 — Hierarchical Planning Acceptance Suite', () => {
  const mockGoal: HighLevelGoal = {
    goalId: 'g-acceptance-1',
    rawUserPrompt: 'Find winter jackets on sale',
    sanitizedGoalDescription: 'Find winter jackets on sale',
    taskCategory: 'ECOMMERCE_SEARCH',
    targetEntities: ['winter jackets'],
    constraints: { onSale: true },
    createdAt: Date.now(),
    status: 'ACTIVE',
  };

  const mockSubgoal: Subgoal = {
    id: 'sg-acceptance-1',
    goalId: 'g-acceptance-1',
    index: 0,
    category: 'SELECT',
    description: 'Select jacket item',
    state: 'READY',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
    targetEntity: 'jacket-item-1',
  };

  it('strictly enforces the guarded pipeline: Grounding -> M5 -> Risk -> Exec -> Effect -> Goal', () => {
    const sm = new PlanStateMachine();
    sm.initialize(mockGoal);
    expect(sm.getState()).toBe('DECOMPOSING');

    sm.registerDecompositionComplete();
    expect(sm.getState()).toBe('SUBGOAL_SELECTION');

    sm.registerSubgoalSelected(mockSubgoal);
    expect(sm.getState()).toBe('TARGET_GROUNDING');

    sm.registerTargetGrounded('jacket-item-1', { action: 'click', target: 'jacket-item-1' });
    expect(sm.getState()).toBe('M5_VALIDATION');

    sm.registerM5Approval(true);
    expect(sm.getState()).toBe('RISK_POLICY_CHECK');

    sm.registerRiskAssessment({
      riskLevel: 'LOW',
      level: 'LOW',
      score: 0.1,
      reasons: ['Read-only navigation click'],
      rationale: 'Safe action',
      requiresConfirmation: false,
      requiresUserConfirmation: false,
      allowed: true,
      riskFactors: {
        actionTypeRisk: 'LOW',
        targetSensitivityRisk: 'LOW',
        consequentialImpactRisk: 'LOW',
        navigationRisk: 'LOW',
        destructivenessRisk: 'LOW',
      },
    });
    expect(sm.getState()).toBe('CHROME_EXECUTION');

    sm.registerExecutionResult(true, 'PRIVAGENT_ACTION');
    expect(sm.getState()).toBe('EFFECT_VERIFICATION');

    sm.registerEffectVerification(true);
    expect(sm.getState()).toBe('GOAL_VERIFICATION');

    sm.registerGoalVerification(true, true);
    expect(sm.getState()).toBe('COMPLETED');

    // Provenance verification
    const provenance = sm.getProvenanceHistory();
    expect(provenance.length).toBe(1);
    expect(provenance[0]!.source).toBe('PRIVAGENT_ACTION');
    expect(provenance[0]!.m5Approved).toBe(true);
    expect(provenance[0]!.chromeExecutionRecorded).toBe(true);
    expect(provenance[0]!.effectVerificationRecorded).toBe(true);

  });

  it('security invariant: throws when attempting to bypass M5 or Risk check before execution', () => {
    const sm = new PlanStateMachine();
    sm.initialize(mockGoal);
    sm.registerDecompositionComplete();
    sm.registerSubgoalSelected(mockSubgoal);

    // Attempt direct transition to CHROME_EXECUTION without Grounding/M5
    expect(() => {
      sm.transitionTo('CHROME_EXECUTION');
    }).toThrow(/Security Invariant Violation/);
  });

  it('security invariant: throws when attempting to bypass Effect Verification before Goal Verification', () => {
    const sm = new PlanStateMachine();
    sm.initialize(mockGoal);
    sm.registerDecompositionComplete();
    sm.registerSubgoalSelected(mockSubgoal);

    expect(() => {
      sm.transitionTo('GOAL_VERIFICATION');
    }).toThrow(/Pipeline Invariant Violation/);
  });

  it('enforces planner context budget target <= 2 KB with deterministic relevance ranking', () => {
    // Generate context with many detections
    const detections = [];
    for (let i = 0; i < 40; i++) {
      detections.push({
        id: `btn-${i}`,
        type: 'button' as const,
        confidence: 0.9,
        bbox: { x: i * 10, y: i * 10, width: 50, height: 20 },
        length: 8,
        source: 'dom_attribute' as const,
        selector: `button#btn-${i}`,
        is_partially_visible: false,
        label: i === 5 ? 'Select winter jackets on sale' : `Generic button ${i}`,
      });
    }

    const rawPayload: AgentContextPayload = {
      url: 'https://shop.example.com/catalog',
      timestamp: Date.now(),
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: { width: 1280, height: 800 },
      detections,
      total_elements_scanned: 40,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
    };

    const result = PlannerContextBuilder.buildContext(rawPayload, mockGoal, mockSubgoal);

    // Size must target <= 2048 bytes
    expect(result.byteSize).toBeLessThanOrEqual(2048);
    expect(result.targetBudgetMet).toBe(true);

    // Highest relevance item ('Select winter jackets on sale') MUST be preserved
    const preservedLabels = result.contextPayload.detections.map((d) => d.label);
    expect(preservedLabels).toContain('Select winter jackets on sale');
  });

  it('telemetry distinguishes PRIVAGENT_ACTION from TEST_HARNESS_ACTION', () => {
    const telemetry = new PlannerTelemetryLogger('test-run-1');

    telemetry.logEvent('CHROME_EXECUTION', {
      subgoalId: 'sg1',
      provenanceSource: 'PRIVAGENT_ACTION',
      m5Approved: true,
      executionSuccess: true,
    });

    telemetry.logEvent('CHROME_EXECUTION', {
      subgoalId: 'harness-nav',
      provenanceSource: 'TEST_HARNESS_ACTION',
      m5Approved: false,
      executionSuccess: true,
    });

    const report = telemetry.exportReport();
    expect(report.autonomousActionsCount).toBe(1);
    expect(report.provenanceDistribution.PRIVAGENT_ACTION).toBe(1);
    expect(report.provenanceDistribution.TEST_HARNESS_ACTION).toBe(1);
  });
});
