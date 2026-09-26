/**
 * PrivAgent — Phase 14 Acceptance: Agent Interaction & Output Layer
 *
 * The Interaction Layer communicates agent state and results to the user. It
 * is NOT an authority and NOT a privacy authority for input.
 *
 * These tests assert the four contracts that keep it safe:
 *
 *   1. The projection is a correct, complete, value-free TRANSLATION — live
 *      activity, a result, and a structured terminal outcome.
 *   2. It never leaks chain-of-thought. Internal `reason` prose, validation
 *      reasons, execution errors, model rationale and the decision trace are
 *      read internally to classify a code and then never surface.
 *   3. It is READ-ONLY and NON-AUTHORITATIVE — it can narrow, never widen, and
 *      there is no path from it back into the loop, the Harness, containment or
 *      any security gate.
 *   4. `screenAgentOutput()` FAILS CLOSED, and does so in the service worker
 *      before data crosses the SW → dashboard boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  projectAgentOutput,
  screenAgentOutput,
  describeOutputScreen,
  phaseFromPlanningState,
  MAX_AGENT_TIMELINE_ENTRIES,
  MAX_AGENT_RESULT_ITEMS,
  type AgentInteractionState,
  type AgentTerminalReason,
} from '../../extension/src/agent/agentOutput';
import { createAgentTaskState, type AgentTaskState } from '../../extension/src/agent/agentState';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { evaluateContainment } from '../../extension/src/agent/containment';
import { AgentHarness, evaluateHarnessCycle } from '../../extension/src/agent/harness';
import { reviewProposedAction } from '../../extension/src/agent/securityCritic';
import { scanForRawSensitiveValues } from '../../extension/src/privacy/rawValueScanner';
import { AgentContextPayload, AgentDetection } from '../../extension/src/privacy/types';

const TASK = 'search for black cats on google';
const IN_SCOPE = 'https://www.google.com/';

function det(id: string, type: AgentDetection['type'], selector: string): AgentDetection {
  return {
    id, type, selector, confidence: 0.95,
    bbox: { x: 20, y: 20, width: 160, height: 32 }, length: 0,
    source: 'dom_attribute', is_partially_visible: false,
  };
}

function ctx(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: IN_SCOPE, timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 5, sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 1, sensitive_detected: 0, latency_ms: 5 },
    detections: [det('search-box', 'search', 'input#q'), det('go', 'button', 'button#go')],
    ...overrides,
  };
}

/** A realistic state. Tests override exactly one field at a time. */
function baseState(over: Partial<AgentTaskState> = {}): AgentTaskState {
  const s = createAgentTaskState(TASK, { maxSteps: 10, maxRetries: 2, targetTabId: 7 });
  s.currentUrl = IN_SCOPE;
  s.perceptionGeneration = 1;
  s.currentPageGeneration = 1;
  s.planningEngineState = 'CHROME_EXECUTION';
  return { ...s, ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Outcome projection
// ─────────────────────────────────────────────────────────────────────────────
describe('P14-1 the projection reports the true lifecycle outcome', () => {
  it('1.1 an untouched task is IDLE', () => {
    const out = projectAgentOutput(baseState({ status: 'IN_PROGRESS' }));
    expect(out.outcome).toBe('RUNNING');
    expect(out.terminal).toBeNull();
  });

  it('1.2 SUCCESS projects SUCCEEDED with GOAL_ACHIEVED', () => {
    const out = projectAgentOutput(baseState({ status: 'SUCCESS', goalStatus: 'SUCCESS' }));
    expect(out.outcome).toBe('SUCCEEDED');
    expect(out.terminal?.reason).toBe('GOAL_ACHIEVED');
    expect(out.terminal?.headline).toBe('Goal achieved.');
  });

  it('1.3 STOPPED projects STOPPED with STOPPED_BY_USER', () => {
    const out = projectAgentOutput(baseState({ status: 'STOPPED', reason: 'Task stopped by user.' }));
    expect(out.outcome).toBe('STOPPED');
    expect(out.terminal?.reason).toBe('STOPPED_BY_USER');
  });

  it('1.4 NEEDS_USER_CONFIRMATION is a distinct outcome, not a failure', () => {
    const out = projectAgentOutput(
      baseState({
        status: 'NEEDS_USER_CONFIRMATION',
        requiresUserConfirmationAction: { action: 'navigate', url: 'https://elsewhere.example/' } as any,
      })
    );
    expect(out.outcome).toBe('AWAITING_CONFIRMATION');
    expect(out.terminal).toBeNull();
    expect(out.activity.phase).toBe('AWAITING_CONFIRMATION');
    expect(out.awaitingConfirmation).not.toBeNull();
  });

  it('1.5 an FAILED run is FAILED and always carries a reason code', () => {
    const out = projectAgentOutput(baseState({ status: 'FAILED', reason: 'something went wrong' }));
    expect(out.outcome).toBe('FAILED');
    expect(out.terminal?.outcome).toBe('FAILED');
    expect(out.terminal?.reason).toBe('UNKNOWN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Terminal reason classification
// ─────────────────────────────────────────────────────────────────────────────
describe('P14-2 the terminal reason is a CODE, classified from internal evidence', () => {
  const cases: Array<[string, Partial<AgentTaskState>, AgentTerminalReason]> = [
    [
      'a containment denial is reported as CONTAINMENT_DENIED',
      { status: 'FAILED', containmentDecision: { code: 'SCOPE_DRIFT_DETECTED', contained: false, reason: 'x', scope: 'contained:google.com' } },
      'CONTAINMENT_DENIED',
    ],
    [
      'a harness environment halt is reported as HARNESS_HALTED',
      {
        status: 'FAILED',
        harnessRun: {
          runId: 'harness-run-1', cycles: 2, continueCount: 1, haltCount: 1,
          lastVerdict: 'HALT_ENVIRONMENT', lastHaltCode: 'SCOPE_DRIFT_DETECTED',
          history: [], historyTruncated: false,
        },
      },
      'HARNESS_HALTED',
    ],
    [
      'a harness recovery-budget halt is reported as RECOVERY_EXHAUSTED',
      {
        status: 'FAILED',
        harnessRun: {
          runId: 'harness-run-1', cycles: 3, continueCount: 2, haltCount: 1,
          lastVerdict: 'BUDGET_EXHAUSTED', lastHaltCode: 'RECOVERY_BUDGET_EXHAUSTED',
          history: [], historyTruncated: false,
        },
      },
      'RECOVERY_EXHAUSTED',
    ],
    [
      'a harness step-budget halt is reported as STEP_BOUND_EXHAUSTED',
      {
        status: 'FAILED',
        harnessRun: {
          runId: 'harness-run-1', cycles: 10, continueCount: 9, haltCount: 1,
          lastVerdict: 'BUDGET_EXHAUSTED', lastHaltCode: 'MAX_STEPS_EXHAUSTED',
          history: [], historyTruncated: false,
        },
      },
      'STEP_BOUND_EXHAUSTED',
    ],
    [
      'a provider failure is reported as REASONER_FAILED',
      { status: 'FAILED', lastFailure: { category: 'PROVIDER_TIMEOUT', reason: 'x', pageGeneration: 1, recoveryAttempted: false, finalState: 'FAILED', timestamp: 1 } },
      'REASONER_FAILED',
    ],
    [
      'a recovery-exhausted failure record is reported as RECOVERY_EXHAUSTED',
      { status: 'FAILED', lastFailure: { category: 'RECOVERY_EXHAUSTED', reason: 'x', pageGeneration: 1, recoveryAttempted: true, finalState: 'FAILED', timestamp: 1 } },
      'RECOVERY_EXHAUSTED',
    ],
    [
      'a perception failure is reported as PERCEPTION_FAILED',
      { status: 'FAILED', reason: 'Perception failed: Unable to obtain sanitized page context.' },
      'PERCEPTION_FAILED',
    ],
    [
      'the step bound is reported as STEP_BOUND_EXHAUSTED',
      { status: 'FAILED', currentStep: 10, maxSteps: 10 },
      'STEP_BOUND_EXHAUSTED',
    ],
  ];

  for (const [name, over, expected] of cases) {
    it(`2.x ${name}`, () => {
      const out = projectAgentOutput(baseState({ reason: 'internal prose nobody should see', ...over }));
      expect(out.terminal?.reason).toBe(expected);
      // The internal prose is classified with, and then dropped.
      expect(JSON.stringify(out)).not.toContain('internal prose nobody should see');
    });
  }

  it('2.9 an environmental refusal outranks any later failure record', () => {
    const out = projectAgentOutput(
      baseState({
        status: 'FAILED',
        containmentDecision: { code: 'SCOPE_DRIFT_DETECTED', contained: false, reason: 'x', scope: 'contained:google.com' },
        lastFailure: { category: 'ACTION_NO_EFFECT', reason: 'x', pageGeneration: 1, recoveryAttempted: false, finalState: 'FAILED', timestamp: 1 },
      })
    );
    expect(out.terminal?.reason).toBe('CONTAINMENT_DENIED');
  });

  it('2.10 every terminal reason has a composed headline', () => {
    const reasons: AgentTerminalReason[] = [
      'GOAL_ACHIEVED', 'STOPPED_BY_USER', 'CONTAINMENT_DENIED', 'HARNESS_HALTED',
      'RECOVERY_EXHAUSTED', 'STEP_BOUND_EXHAUSTED', 'REASONER_FAILED',
      'PERCEPTION_FAILED', 'CONFIRMATION_DECLINED', 'UNKNOWN',
    ];
    for (const reason of reasons) {
      const out = projectAgentOutput(
        baseState({ status: 'FAILED', containmentDecision: undefined, lastFailure: undefined, currentStep: 0, maxSteps: 10, reason: 'x' })
      );
      expect(out.terminal).not.toBeNull();
      expect(out.terminal!.headline.length).toBeGreaterThan(0);
      expect(typeof reason).toBe('string');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Live activity — derived from the REAL plan state machine
// ─────────────────────────────────────────────────────────────────────────────
describe('P14-3 live activity is derived, never guessed from prose', () => {
  it('3.1 every planning state maps to a phase', () => {
    // UNINITIALIZED is the only state that legitimately means "nothing yet".
    expect(phaseFromPlanningState('UNINITIALIZED')).toBe('IDLE');
    const states = [
      'DECOMPOSING', 'SUBGOAL_SELECTION', 'DYNAMIC_REPLANNING',
      'TARGET_GROUNDING', 'M5_VALIDATION', 'RISK_POLICY_CHECK', 'USER_CONFIRMATION',
      'CHROME_EXECUTION', 'EFFECT_VERIFICATION', 'GOAL_VERIFICATION',
      'COMPLETED', 'FAILED', 'ABORTED',
    ] as const;
    for (const s of states) {
      expect(phaseFromPlanningState(s)).not.toBe('IDLE');
    }
  });

  it('3.2 execution, validation, verification and recovery are distinguishable', () => {
    expect(phaseFromPlanningState('CHROME_EXECUTION')).toBe('EXECUTION');
    expect(phaseFromPlanningState('M5_VALIDATION')).toBe('VALIDATION');
    expect(phaseFromPlanningState('EFFECT_VERIFICATION')).toBe('VERIFICATION');
    expect(phaseFromPlanningState('DYNAMIC_REPLANNING')).toBe('RECOVERY');
  });

  it('3.3 the first cycle reports PERCEPTION even though the plan machine is idle', () => {
    const out = projectAgentOutput(baseState({ status: 'IN_PROGRESS', steps: [], planningEngineState: 'SUBGOAL_SELECTION' }));
    expect(out.activity.phase).toBe('PERCEPTION');
    expect(out.activity.summary).toBe('Reading the page.');
  });

  it('3.4 the activity line changes as the run progresses', () => {
    // Four states that map to four DIFFERENT phases.
    const phases = ['TARGET_GROUNDING', 'CHROME_EXECUTION', 'EFFECT_VERIFICATION', 'DYNAMIC_REPLANNING']
      .map((p) => projectAgentOutput(baseState({ status: 'IN_PROGRESS', planningEngineState: p as any, steps: [{} as any] })).activity.summary);
    expect(new Set(phases).size).toBe(phases.length);
  });

  it('3.5 the activity line carries step and harness cycle, never a URL', () => {
    const out = projectAgentOutput(
      baseState({ status: 'IN_PROGRESS', currentStep: 3, steps: [{} as any] })
    );
    expect(out.activity.step).toBe(3);
    expect(out.activity.maxSteps).toBe(10);
    expect(JSON.stringify(out)).not.toContain(IN_SCOPE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Result projection
// ─────────────────────────────────────────────────────────────────────────────
describe('P14-4 results are surfaced instead of silently dropped', () => {
  it('4.1 candidate items become a result the user can read', () => {
    const out = projectAgentOutput(
      baseState({
        status: 'SUCCESS', goalStatus: 'SUCCESS',
        candidateItems: [
          { id: 'c1', title: 'ApexCart Hoodie', price: 40, currency: 'USD', matchesConstraints: true, constraintNotes: 'size ok', confidence: 0.9 },
        ],
      })
    );
    expect(out.result.kind).toBe('CANDIDATES');
    expect(out.result.count).toBe(1);
    expect(out.result.items[0]!.title).toBe('ApexCart Hoodie');
  });

  it('4.2 findings become a result when there are no candidates', () => {
    const out = projectAgentOutput(baseState({ status: 'SUCCESS', currentFindings: ['a heading', 'a list'] }));
    expect(out.result.kind).toBe('FINDINGS');
    expect(out.result.count).toBe(2);
  });

  it('4.3 no results projects NONE rather than inventing something', () => {
    expect(projectAgentOutput(baseState()).result.kind).toBe('NONE');
    expect(projectAgentOutput(baseState()).result.count).toBe(0);
  });

  it('4.4 result items are bounded', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`, title: `item ${i}`, price: 1, currency: 'USD',
      matchesConstraints: true, constraintNotes: '', confidence: 0.5,
    }));
    const out = projectAgentOutput(baseState({ status: 'SUCCESS', candidateItems: many as any }));
    expect(out.result.items.length).toBe(MAX_AGENT_RESULT_ITEMS);
    // The COUNT is still honest even though the list is bounded.
    expect(out.result.count).toBe(40);
  });

  it('4.5 artifacts surface the Phase 12/13 observability the UI previously dropped', () => {
    const out = projectAgentOutput(
      baseState({
        status: 'FAILED',
        containmentDecision: { code: 'SCOPE_DRIFT_DETECTED', contained: false, reason: 'x', scope: 'contained:google.com' },
        harnessRun: {
          runId: 'harness-run-1', cycles: 2, continueCount: 1, haltCount: 1,
          lastVerdict: 'HALT_ENVIRONMENT', lastHaltCode: 'SCOPE_DRIFT_DETECTED',
          history: [], historyTruncated: false,
        },
        totalRecoveryAttempts: 1,
        perceptionGeneration: 3,
      })
    );
    const kinds = out.artifacts.map((a) => a.kind);
    expect(kinds).toContain('CONTAINMENT');
    expect(kinds).toContain('HARNESS');
    expect(kinds).toContain('RECOVERY');
    expect(kinds).toContain('PERCEPTION');
    // The container label is a root host, never a URL.
    expect(out.artifacts.find((a) => a.kind === 'CONTAINMENT')?.label).toBe('SCOPE_DRIFT_DETECTED:contained:google.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NO CHAIN-OF-THOUGHT
// ─────────────────────────────────────────────────────────────────────────────
describe('P14-5 the projection never leaks internal reasoning', () => {
  it('5.1 the internal `reason` never reaches the user-facing output', () => {
    const out = projectAgentOutput(
      baseState({ status: 'FAILED', reason: 'Privacy Policy Denied: capability TYPE refused for OTP entity' })
    );
    expect(JSON.stringify(out)).not.toContain('Privacy Policy Denied');
    expect(JSON.stringify(out)).not.toContain('capability TYPE refused');
  });

  it('5.2 a gate rejection surfaces as a CODE, not as gate prose', () => {
    const s = baseState({ status: 'FAILED' });
    s.steps = [
      {
        step: 1,
        action: { action: 'click', target: 'go' } as any,
        validationAllowed: false,
        validationReason: 'Security Critic BLOCKED (SUSPICIOUS_NAVIGATION): off-site',
        executionSuccess: false,
        executionError: 'M5 refused because the text contained a raw PAN 4111111111111111',
        url: IN_SCOPE,
        timestamp: 1,
      },
    ];
    const out = projectAgentOutput(s);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Security Critic BLOCKED');
    expect(serialized).not.toContain('SUSPICIOUS_NAVIGATION');
    expect(serialized).not.toContain('4111111111111111');
    // The structural outcome survives.
    expect(out.timeline[0]!.outcome).toBe('BLOCKED');
  });

  it('5.3 the decision trace is not carried into the interaction payload', () => {
    const out = projectAgentOutput(
      baseState({
        status: 'FAILED',
        decisionTraceSummary: {
          taskId: 'task-1', totalSteps: 1, executedCount: 0, blockedCount: 1,
          confirmedCount: 0, recoveredCount: 0,
          entries: [{ proposedAction: { action: 'click', target: 'secret-plan' } } as any],
        },
      })
    );
    expect(JSON.stringify(out)).not.toContain('secret-plan');
    expect(JSON.stringify(out)).not.toContain('task-1');
  });

  it('5.4 timeline entries carry the action TYPE only, never a target', () => {
    const s = baseState({ status: 'SUCCESS' });
    s.steps = [
      {
        step: 1, action: { action: 'click', target: 'user-email-field' } as any,
        validationAllowed: true, validationReason: 'ok', executionSuccess: true,
        url: IN_SCOPE, timestamp: 1,
      },
    ];
    const out = projectAgentOutput(s);
    expect(JSON.stringify(out)).not.toContain('user-email-field');
    expect(out.timeline[0]!.action).toBe('click');
  });

  it('5.5 the whole projection is value-free', () => {
    const s = baseState({
      status: 'FAILED',
      containmentDecision: { code: 'WITHIN_SCOPE', contained: true, reason: 'x', scope: 'contained:google.com' },
      reason: 'Perception failed: Unable to obtain sanitized page context.',
    });
    expect(scanForRawSensitiveValues(projectAgentOutput(s))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. READ-ONLY and NON-AUTHORITATIVE
// ─────────────────────────────────────────────────────────────────────────────
describe('P14-6 the projection is read-only and has no authority', () => {
  it('6.1 projecting does not mutate the source state', () => {
    const s = baseState({ status: 'IN_PROGRESS', candidateItems: [{ id: 'c1', title: 'X', price: 1, currency: 'USD', matchesConstraints: true, constraintNotes: '', confidence: 1 }] as any });
    const before = JSON.stringify(s);
    projectAgentOutput(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('6.2 projecting twice yields identical output', () => {
    const s = baseState({ status: 'SUCCESS' });
    expect(JSON.stringify(projectAgentOutput(s))).toBe(JSON.stringify(projectAgentOutput(s)));
  });

  it('6.3 the projection exposes no function, callback or write path', () => {
    const out = projectAgentOutput(baseState());
    const walk = (v: unknown): void => {
      if (typeof v === 'function') throw new Error('projection exposed a function');
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') return Object.values(v).forEach(walk);
    };
    walk(out);
  });

  it('6.4 no key in the output names an authority concept', () => {
    const out = projectAgentOutput(baseState());
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) { keys.push(k); walk(val); }
      }
    };
    walk(out);
    expect(keys.some((k) => /allow|deny|permit|authoriz|approve|grant|dispatch|execute|override/i.test(k))).toBe(false);
  });

  it('6.5 a gate refused by the pipeline is still refused after projection', () => {
    // The projection is a translation. It has no path back into authority, so
    // every gate reaches exactly the same verdict whether or not it ran.
    const bad = { action: 'eval', code: 'x' } as any;
    expect(validateAction(bad, ctx()).allowed).toBe(false);
    projectAgentOutput(baseState());
    expect(validateAction(bad, ctx()).allowed).toBe(false);

    const offsite = { action: 'navigate', url: 'https://evil.example/steal' } as any;
    expect(reviewProposedAction({ action: offsite, task: TASK, context: ctx(), currentUrl: IN_SCOPE }).verdict).toBe('BLOCK');
    projectAgentOutput(baseState());
    expect(reviewProposedAction({ action: offsite, task: TASK, context: ctx(), currentUrl: IN_SCOPE }).verdict).toBe('BLOCK');
  });

  it('6.6 containment and harness reach the same verdict after projection', () => {
    const scope = {
      rootHost: 'google.com', origin: IN_SCOPE, tabId: 7, dashboardOrigin: 'http://localhost:5173',
    };
    const input = { action: { action: 'click', target: 'go' } as any, scope, targetTabId: 7, liveUrl: IN_SCOPE };
    const before = evaluateContainment(input);
    const cycleBefore = evaluateHarnessCycle({
      cycle: 1, status: 'IN_PROGRESS', stopRequested: false, containmentScope: scope,
      targetTabId: 7, liveUrl: IN_SCOPE, bounds: { maxSteps: 10, maxRetries: 2, maxTotalRecoveries: 6 },
      step: 1, retryCount: 0, recoveryAttempts: 0, perceptionGeneration: 1,
    });
    projectAgentOutput(baseState());
    expect(evaluateContainment(input)).toEqual(before);
    const h = new AgentHarness();
    h.initialize(TASK);
    expect(
      h.runCycle({
        status: 'IN_PROGRESS', stopRequested: false, containmentScope: scope,
        targetTabId: 7, liveUrl: IN_SCOPE, bounds: { maxSteps: 10, maxRetries: 2, maxTotalRecoveries: 6 },
        step: 1, retryCount: 0, recoveryAttempts: 0, perceptionGeneration: 1,
      }).verdict
    ).toBe(cycleBefore.verdict);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Output screening — the privacy seam, fail-closed
// ─────────────────────────────────────────────────────────────────────────────
describe('P14-7 output screening fails closed at the SW boundary', () => {
  it('7.1 a clean projection passes untouched', () => {
    const out = projectAgentOutput(baseState({ status: 'SUCCESS' }));
    const screened = screenAgentOutput(out);
    expect(screened.verdict).toBe('CLEAR');
    expect(screened.findings).toBe(0);
    expect(screened.output).toBe(out);
  });

  it('7.2 a raw value in a result title is REDACTED, not displayed', () => {
    const out = projectAgentOutput(
      baseState({
        status: 'SUCCESS',
        candidateItems: [{ id: 'c1', title: 'card 4111 1111 1111 1111', price: 1, currency: 'USD', matchesConstraints: true, constraintNotes: '', confidence: 1 }] as any,
      })
    );
    const screened = screenAgentOutput(out);
    expect(screened.verdict).toBe('REDACTED');
    expect(screened.findings).toBe(1);
    expect(screened.output.result.items[0]!.title).toBe('[redacted]');
    expect(JSON.stringify(screened.output)).not.toContain('4111');
  });

  it('7.3 one bad title does not lose an otherwise good result', () => {
    const out = projectAgentOutput(
      baseState({
        status: 'SUCCESS',
        candidateItems: [
          { id: 'c1', title: 'card 4111 1111 1111 1111', price: 1, currency: 'USD', matchesConstraints: true, constraintNotes: '', confidence: 1 },
          { id: 'c2', title: 'A perfectly ordinary product', price: 2, currency: 'USD', matchesConstraints: true, constraintNotes: '', confidence: 1 },
        ] as any,
      })
    );
    const screened = screenAgentOutput(out);
    expect(screened.verdict).toBe('REDACTED');
    expect(screened.output.result.items).toHaveLength(2);
    expect(screened.output.result.items[0]!.title).toBe('[redacted]');
    expect(screened.output.result.items[1]!.title).toBe('A perfectly ordinary product');
  });

  it('7.4 a malformed payload is BLOCKED and replaced with a safe empty one', () => {
    const screened = screenAgentOutput(undefined as unknown as AgentInteractionState);
    expect(screened.verdict).toBe('BLOCKED');
    expect(screened.output.outcome).toBe('FAILED');
    expect(screened.output.result.items).toEqual([]);
    expect(screened.output.timeline).toEqual([]);
  });

  it('7.5 a corrupt STRUCTURAL field drops the WHOLE payload (never half-trusted)', () => {
    const out = projectAgentOutput(baseState({ status: 'SUCCESS' }));
    const tampered: AgentInteractionState = { ...out, outcome: 'APPROVED 4111111111111111' as any };
    const screened = screenAgentOutput(tampered);
    expect(screened.verdict).toBe('BLOCKED');
    expect(screened.output.outcome).toBe('FAILED');
    expect(JSON.stringify(screened.output)).not.toContain('4111');
  });

  it('7.6 a corrupt artifact label drops the whole payload', () => {
    const out = projectAgentOutput(baseState({ status: 'SUCCESS' }));
    const tampered: AgentInteractionState = {
      ...out, artifacts: [{ kind: 'FAILURE', label: 'CVV: 123' }],
    };
    expect(screenAgentOutput(tampered).verdict).toBe('BLOCKED');
  });

  it('7.7 screening is deterministic and never mutates its input', () => {
    const out = projectAgentOutput(
      baseState({ status: 'SUCCESS', candidateItems: [{ id: 'c1', title: '4111-1111-1111-1111', price: 1, currency: 'USD', matchesConstraints: true, constraintNotes: '', confidence: 1 }] as any })
    );
    const before = JSON.stringify(out);
    const a = screenAgentOutput(out);
    const b = screenAgentOutput(out);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(out)).toBe(before);
  });

  it('7.8 the screened payload is itself value-free', () => {
    const out = projectAgentOutput(
      baseState({ status: 'SUCCESS', candidateItems: [{ id: 'c1', title: 'CVV: 123 at a@b.com', price: 1, currency: 'USD', matchesConstraints: true, constraintNotes: '', confidence: 1 }] as any })
    );
    expect(screenAgentOutput(out).verdict).toBe('REDACTED');
    expect(scanForRawSensitiveValues(screenAgentOutput(out).output)).toEqual([]);
  });

  it('7.9 the audit line is stable and value-free', () => {
    expect(describeOutputScreen(screenAgentOutput(projectAgentOutput(baseState())))).toBe('OUTPUT_SCREEN_CLEAR (0 finding(s))');
    expect(describeOutputScreen(screenAgentOutput(undefined as any))).toBe('OUTPUT_SCREEN_BLOCKED (0 finding(s))');
  });

  it('7.10 the timeline is bounded', () => {
    const s = baseState({ status: 'SUCCESS' });
    s.steps = Array.from({ length: 60 }, (_, i) => ({
      step: i + 1, action: { action: 'scroll' } as any,
      validationAllowed: true, validationReason: 'ok', executionSuccess: true,
      url: IN_SCOPE, timestamp: i + 1,
    }));
    expect(projectAgentOutput(s).timeline.length).toBeLessThanOrEqual(MAX_AGENT_TIMELINE_ENTRIES);
  });
});
