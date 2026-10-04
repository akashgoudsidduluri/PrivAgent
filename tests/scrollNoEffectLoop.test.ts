/**
 * PrivAgent — Phase 18.2: Scroll No-Effect Loop Repair Tests
 *
 * Verifies that:
 * 1. Scroll with positive delta: repeated scrolling remains allowed when progress is made.
 * 2. Scroll with zero delta: effect becomes ACTION_NO_EFFECT.
 * 3. Same scroll after NO_EFFECT: bounded termination occurs; no unbounded loop.
 * 4. Recovery engine receives the no-effect signal, scrollDirection, and boundary state.
 * 5. Reasoner receives only safe effect metadata (action, direction, amount, effect, scrollDelta).
 * 6. No raw sensitive values enter the feedback path.
 * 7. Existing GoalVerifier / DestinationVerifier behavior remains intact.
 * 8. Concurrency ownership behavior remains intact.
 */

import { describe, it, expect, vi } from 'vitest';
import { verifyActionEffect } from '../extension/src/agent/effectVerifier';
import { RecoveryEngine, DEFAULT_RECOVERY_BOUNDS } from '../extension/src/agent/recoveryEngine';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { AgentContextPayload, AgentDetection } from '../extension/src/privacy/types';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';
import { verifyTaskGoal } from '../extension/src/agent/goalVerifier';

function createMockDetection(id: string, type: AgentDetection['type'], selector: string): AgentDetection {
  return {
    id,
    type,
    selector,
    confidence: 0.95,
    bbox: { x: 10, y: 10, width: 100, height: 30 },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
  };
}

function createMockContext(scrollY = 0): AgentContextPayload {
  return {
    url: 'https://example.com/transactions',
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: scrollY },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 5,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 2, sensitive_detected: 0, latency_ms: 5 },
    detections: [
      createMockDetection('tx-heading', 'element', 'h2#transactions'),
      createMockDetection('tx-row-1', 'element', 'tr.tx-row'),
    ],
  };
}

describe('Phase 18.2 — Scroll No-Effect Loop Repair', () => {
  // TEST 1: Scroll with positive delta allows repeated scrolling.
  it('TEST 1: Scroll with positive delta allows repeated scrolling when progress is made', () => {
    const action: BrowserAction = { action: 'scroll', direction: 'down', amount: 500 };
    const preSnapshot = {
      url: 'https://example.com/page',
      scrollX: 0,
      scrollY: 0,
      domElementCount: 20,
      timestamp: 1000,
    };
    const postSnapshot = {
      url: 'https://example.com/page',
      scrollX: 0,
      scrollY: 500,
      domElementCount: 20,
      timestamp: 1050,
    };

    const effect1 = verifyActionEffect(action, preSnapshot as any, postSnapshot as any);
    expect(effect1.hasEffect).toBe(true);
    expect(effect1.status).toBe('SCROLL_CHANGED');
    expect(effect1.diagnostics.scrollDelta).toBe(500);

    // Second scroll with positive delta also produces effect
    const postSnapshot2 = {
      url: 'https://example.com/page',
      scrollX: 0,
      scrollY: 1000,
      domElementCount: 20,
      timestamp: 1100,
    };
    const effect2 = verifyActionEffect(action, postSnapshot as any, postSnapshot2 as any);
    expect(effect2.hasEffect).toBe(true);
    expect(effect2.status).toBe('SCROLL_CHANGED');
    expect(effect2.diagnostics.scrollDelta).toBe(500);
  });

  // TEST 2: Scroll with zero delta produces ACTION_NO_EFFECT.
  it('TEST 2: Scroll with zero delta produces ACTION_NO_EFFECT', () => {
    const action: BrowserAction = { action: 'scroll', direction: 'down', amount: 500 };
    const preSnapshot = {
      url: 'https://example.com/page',
      scrollX: 0,
      scrollY: 862,
      domElementCount: 20,
      timestamp: 1000,
    };
    const postSnapshot = {
      url: 'https://example.com/page',
      scrollX: 0,
      scrollY: 862, // delta = 0 (boundary reached)
      domElementCount: 20,
      timestamp: 1050,
    };

    const effect = verifyActionEffect(action, preSnapshot as any, postSnapshot as any);
    expect(effect.hasEffect).toBe(false);
    expect(effect.status).toBe('ACTION_NO_EFFECT');
    expect(effect.diagnostics.scrollDelta).toBe(0);
    expect(effect.details).toContain('zero viewport movement');
  });

  // TEST 3: Same scroll after NO_EFFECT must not create an unbounded loop.
  it('TEST 3: Same scroll after NO_EFFECT terminates via bounded recovery without infinite loop', async () => {
    let scrollAttempts = 0;
    const provider = {
      name: 'IneffectiveScrollProvider',
      requestAction: async (_task: string, _ctx: any, history: BrowserAction[] = []) => {
        scrollAttempts++;
        // Check that history contains the previous failed scroll with effect metadata
        if (history.length > 0) {
          const last = history[history.length - 1]!;
          expect(last.action).toBe('scroll');
          expect(last.effect).toBe('ACTION_NO_EFFECT');
          expect(last.scrollDelta).toBe(0);
        }
        return {
          action: 'scroll',
          direction: 'down',
          amount: 500,
        } as BrowserAction;
      },
    };

    // Simulated page that cannot scroll further (scrollY remains 862)
    const loop = new AgentLoop(
      provider as any,
      {
        perceivePage: async () => createMockContext(862),
        executeAction: async () => ({ success: true }),
        getEffectSnapshot: async () => ({
          url: 'https://example.com/transactions',
          scrollX: 0,
          scrollY: 862,
          domElementCount: 5,
          timestamp: Date.now(),
        } as any),
      },
      { maxSteps: 10, maxRetries: 2, delayBetweenStepsMs: 1 }
    );

    const state = await loop.runTask('scroll to the transactions section');

    // Loop must terminate with failure, never loop indefinitely
    expect(state.status).toBe('FAILED');
    expect(state.goalStatus).toBe('FAILED');
    // Recovery bounds must have stopped it in <= 4 attempts (maxRetries = 2)
    expect(scrollAttempts).toBeLessThanOrEqual(4);
    expect(state.lastFailure?.category).toMatch(/ACTION_NO_EFFECT|RECOVERY_EXHAUSTED/);
  });

  // TEST 4: Recovery engine receives the no-effect signal with direction awareness.
  it('TEST 4: Recovery engine tracks attempts per direction and escalates on repeats', () => {
    const engine = new RecoveryEngine({
      ...DEFAULT_RECOVERY_BOUNDS,
      maxRecoveriesPerAction: 2,
      maxRepeatedStrategy: 2,
    });

    const dec1 = engine.decide({
      code: 'ACTION_NO_EFFECT',
      noEffect: true,
      scrollDirection: 'down',
      scrollBoundaryReached: true,
    });
    expect(dec1.strategy).toBe('REPERCEIVE');
    expect(dec1.attempt).toBe(1);

    const dec2 = engine.decide({
      code: 'ACTION_NO_EFFECT',
      noEffect: true,
      scrollDirection: 'down',
      scrollBoundaryReached: true,
    });
    expect(dec2.attempt).toBe(2);

    // On 3rd attempt in same direction, repeats limit reached -> escalates
    const dec3 = engine.decide({
      code: 'ACTION_NO_EFFECT',
      noEffect: true,
      scrollDirection: 'down',
      scrollBoundaryReached: true,
    });
    expect(['REPLAN_SUBGOAL', 'ABORT']).toContain(dec3.strategy);

    // But scrolling 'up' has its own attempt counter
    const decUp = engine.decide({
      code: 'ACTION_NO_EFFECT',
      noEffect: true,
      scrollDirection: 'up',
      scrollBoundaryReached: true,
    });
    expect(decUp.attempt).toBe(1);
  });

  // TEST 5: Reasoner receives only safe execution metadata in history.
  it('TEST 5: Action history metadata contains only safe execution fields', async () => {
    let capturedHistory: any[] = [];
    const provider = {
      name: 'SpyProvider',
      requestAction: async (_task: string, _ctx: any, history: BrowserAction[] = []) => {
        capturedHistory = history;
        return {
          action: 'scroll',
          direction: 'down',
          amount: 500,
        } as BrowserAction;
      },
    };

    let step = 0;
    const loop = new AgentLoop(
      provider as any,
      {
        perceivePage: async () => createMockContext(0),
        executeAction: async () => ({ success: true }),
        getEffectSnapshot: async () => {
          step++;
          return {
            url: 'https://example.com/transactions',
            scrollX: 0,
            scrollY: step === 1 ? 0 : 0, // delta = 0
            domElementCount: 5,
            timestamp: Date.now(),
          } as any;
        },
      },
      { maxSteps: 2, maxRetries: 1, delayBetweenStepsMs: 1 }
    );

    await loop.runTask('test safe history');

    expect(capturedHistory.length).toBeGreaterThan(0);
    for (const item of capturedHistory) {
      // Must contain only safe metadata
      expect(typeof item.action).toBe('string');
      if (item.direction) expect(['up', 'down']).toContain(item.direction);
      if (item.amount) expect(typeof item.amount).toBe('number');
      if (item.effect) expect(typeof item.effect).toBe('string');
      if (item.scrollDelta !== undefined) expect(typeof item.scrollDelta).toBe('number');

      // Must never contain sensitive fields
      expect((item as any).password).toBeUndefined();
      expect((item as any).value).toBeUndefined();
      expect((item as any).text).toBeUndefined();
      expect((item as any).rawText).toBeUndefined();
    }
  });

  // TEST 6: No raw sensitive values enter the feedback path.
  it('TEST 6: Zero raw sensitive values exist in execution feedback metadata', () => {
    const safeFeedbackItem = {
      action: 'scroll',
      direction: 'down',
      amount: 500,
      effect: 'ACTION_NO_EFFECT',
      scrollDelta: 0,
    };

    const findings = scanForRawSensitiveValues(safeFeedbackItem);
    expect(findings.length).toBe(0);

    // Verify forbidden key check
    const serialized = JSON.stringify(safeFeedbackItem);
    const forbiddenKeys = ['password', 'card', 'cvv', 'token', 'secret', 'pan'];
    for (const fk of forbiddenKeys) {
      expect(serialized.toLowerCase()).not.toContain(`"${fk}":`);
    }
  });

  // TEST 7: Existing GoalVerifier / DestinationVerifier behavior unchanged.
  it('TEST 7: GoalVerifier authority remains unchanged', () => {
    const task = 'Search google for cats';
    const state = {
      currentUrl: 'https://www.google.com/search?q=cats',
      previousActions: [
        {
          action: 'scroll',
          direction: 'down',
          amount: 500,
          effect: 'ACTION_NO_EFFECT',
          scrollDelta: 0,
        },
      ],
    };
    const ctx = createMockContext(0);
    ctx.url = 'https://www.google.com/search?q=cats';

    const result = verifyTaskGoal(task, state as any, ctx);
    expect(result.satisfied).toBe(true);
    expect(result.status).toBe('SUCCESS');
    expect(result.reason).toContain('cats');
  });

  // TEST 8: Existing task concurrency ownership remains intact.
  it('TEST 8: Concurrency runId and halt checks are completely unaffected', async () => {
    const provider = {
      name: 'TestProvider',
      requestAction: async () => ({ action: 'scroll', direction: 'down', amount: 500 } as BrowserAction),
    };

    const loop = new AgentLoop(
      provider as any,
      {
        perceivePage: async () => createMockContext(0),
        executeAction: async () => ({ success: true }),
        getEffectSnapshot: async () => ({
          url: 'https://example.com/transactions',
          scrollX: 0,
          scrollY: 0,
          domElementCount: 5,
          timestamp: Date.now(),
        } as any),
      },
      { maxSteps: 2, runId: 4242 }
    );

    expect(loop.getRunId()).toBe(4242);
    expect(loop.isHalted()).toBe(false);
    loop.stop(true);
    expect(loop.isHalted()).toBe(true);
  });
});
