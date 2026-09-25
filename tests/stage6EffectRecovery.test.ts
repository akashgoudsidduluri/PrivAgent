/**
 * PrivAgent — Phase 7.5 Stage 6: Action Effect Verification + Bounded Recovery Integration
 *
 * Verifies that the LIVE AgentLoop:
 *  1. Authoritatively verifies the observable effect of every executed action using effectVerifier.
 *  2. Distinguishes ACTION_EXECUTED + EFFECT_VERIFIED vs ACTION_EXECUTED + ACTION_NO_EFFECT.
 *  3. Triggers bounded recovery and re-perception upon detecting ACTION_NO_EFFECT.
 *  4. Enforces that recovery actions go through the full Stage 5 security pipeline (Target Grounding, M5, Privacy, Risk).
 *  5. Ensures goals cannot succeed without verified effect.
 *  6. Guarantees fail-closed termination upon recovery exhaustion (no infinite loops).
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { AgentContextPayload } from '../extension/src/privacy/types';

function createMockContext(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: 'https://example.com/shop',
    timestamp: Date.now(),
    scanLatencyMs: 5,
    redactionLatencyMs: 2,
    totalElementsScanned: 10,
    sensitiveElementsDetected: 0,
    elementsProtected: 0,
    leakageCount: 0,
    categories: {
      password: 0,
      email: 0,
      phone: 0,
      credit_card: 0,
      account_number: 0,
      person_name: 0,
      pan: 0,
      otp: 0,
      cvv: 0,
      address: 0,
    },
    detections: [
      {
        id: 'search-input',
        type: 'input',
        selector: 'input#search-box',
        confidence: 0.95,
        bbox: [10, 10, 200, 30],
        length: 0,
        source: 'dom_attribute',
      },
      {
        id: 'search-button',
        type: 'button',
        selector: 'button#btn-submit',
        confidence: 0.98,
        bbox: [220, 10, 80, 30],
        length: 0,
        source: 'dom_attribute',
      },
      {
        id: 'inert-button',
        type: 'button',
        selector: 'button#btn-inert',
        confidence: 0.90,
        bbox: [320, 10, 80, 30],
        length: 0,
        source: 'dom_attribute',
      },
      {
        id: 'scroll-anchor',
        type: 'element',
        selector: 'div#footer',
        confidence: 0.85,
        bbox: [0, 800, 1000, 100],
        length: 0,
        source: 'dom_attribute',
      },
    ],
    status: 'Sanitized Context — Local Privacy Check Passed',
    redactionMode: 'mask',
    ...overrides,
  };
}

describe('PrivAgent Stage 6: Action Effect Verification + Bounded Recovery', () => {
  // 1. successful action + verified effect
  it('1. successful action with verified observable effect succeeds and marks step effectVerified', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'type', target: 'search-input', text: 'cats', reason: 'Type search query' },
    ]);

    const loop = new AgentLoop(provider, {
      perceivePage: async () => context,
      executeAction: async (action) => ({
        success: true,
        message: 'Dispatched input into DOM',
        // Post snapshot shows valueLengthChanged
        postSnapshot: {
          url: context.url,
          scrollX: 0,
          scrollY: 0,
          domElementCount: context.detections.length,
          targetValueLength: 4,
          timestamp: Date.now(),
        },
      }),
    });

    const state = await loop.runTask('Search query');
    expect(state.steps.length).toBeGreaterThan(0);
    expect(state.steps[0]?.executionSuccess).toBe(true);
    expect(state.steps[0]?.effectVerified).toBe(true);
    expect(state.steps[0]?.effectStatus).toBe('VALUE_STATE_CHANGED');
    expect(state.previousActions.length).toBe(1);
  });

  // 2. action executes but produces no effect
  it('2. action executes successfully but produces no observable effect -> detected as ACTION_NO_EFFECT', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Click inert button' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async () => ({
          success: true,
          noEffect: true, // Controlled fixture / inert element returns no observable DOM change
        }),
      },
      { maxRetries: 0 } // Single attempt
    );

    const state = await loop.runTask('Click inert element');
    expect(state.steps[0]?.executionSuccess).toBe(false);
    expect(state.steps[0]?.effectVerified).toBe(false);
    expect(state.steps[0]?.effectStatus).toBe('ACTION_NO_EFFECT');
    expect(state.lastFailure?.category).toBe('ACTION_NO_EFFECT');
    expect(state.previousActions.length).toBe(0); // Did not falsely record in successful previousActions
  });

  // 3. no-effect triggers recovery
  it('3. detecting ACTION_NO_EFFECT triggers bounded recovery and logs FailureRecord', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Click inert element' },
      { action: 'scroll', direction: 'down', amount: 200, reason: 'Observation scroll recovery' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          if (action.action === 'click') {
            return { success: true, noEffect: true };
          }
          return { success: true, scrollDelta: 200 };
        },
      },
      { maxRetries: 2 }
    );

    const state = await loop.runTask('Perform button action');
    expect(state.recoveryCount).toBeGreaterThanOrEqual(1);
    expect(state.failureHistory?.some((f) => f.category === 'ACTION_NO_EFFECT')).toBe(true);
  });

  // 4. recovery re-perceives before retry
  it('4. recovery re-perceives fresh page context before attempting retry', async () => {
    const context = createMockContext();
    let perceiveCount = 0;

    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Attempt 1' },
      { action: 'scroll', direction: 'down', amount: 200, reason: 'Attempt 2 recovery' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => {
          perceiveCount++;
          return context;
        },
        executeAction: async (action) => {
          if (action.action === 'click') {
            return { success: true, noEffect: true };
          }
          return { success: true, scrollDelta: 200 };
        },
      },
      { maxRetries: 1 }
    );

    await loop.runTask('Perform interaction');
    // perceivePage must be called: 1 (initial) + 1 (after no-effect recovery)
    expect(perceiveCount).toBeGreaterThanOrEqual(2);
  });

  // 5. recovery retry succeeds
  it('5. recovery retry successfully completes task with verified effect', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Attempt 1 inert' },
      { action: 'type', target: 'search-input', text: 'shoes', reason: 'Attempt 2 retry' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          if (action.action === 'click') {
            return { success: true, noEffect: true };
          }
          return {
            success: true,
            postSnapshot: {
              url: context.url,
              scrollX: 0,
              scrollY: 0,
              domElementCount: context.detections.length,
              targetValueLength: 5,
              timestamp: Date.now(),
            },
          };
        },
      },
      { maxRetries: 2 }
    );

    const state = await loop.runTask('Search for items');
    expect(state.recoveryCount).toBe(1);
    expect(state.steps.length).toBe(2);
    expect(state.steps[0]?.effectVerified).toBe(false);
    expect(state.steps[1]?.effectVerified).toBe(true);
    expect(state.previousActions.length).toBe(1);
    expect(state.previousActions[0]?.action).toBe('type');
  });

  // 6. recovery exhaustion fails closed
  it('6. recovery exhaustion fails closed with RECOVERY_EXHAUSTED', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Attempt 1' },
      { action: 'click', target: 'inert-button', reason: 'Attempt 2' },
      { action: 'click', target: 'inert-button', reason: 'Attempt 3' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async () => ({ success: true, noEffect: true }),
      },
      { maxRetries: 1 } // Allow 1 retry, then exhaust
    );

    const state = await loop.runTask('Repeatedly inert action');
    expect(state.status).toBe('FAILED');
    expect(state.goalStatus).toBe('FAILED');
    expect(state.lastFailure?.category).toBe('RECOVERY_EXHAUSTED');
    expect(state.reason).toContain('Recovery limit exceeded');
  });

  // 7. stale target after recovery is rejected
  it('7. target ID from prior generation is rejected as stale after recovery advances generation', async () => {
    const context = createMockContext();
    // Simulate generation advancement in context
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Click inert' },
      // Attempt to reuse stale target from generation 0 in generation 1
      {
        action: 'click',
        target: 'search-input',
        pageGeneration: 0, // Explicitly stale generation
        reason: 'Stale target reference',
      } as any,
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          if (action.action === 'click' && (action as any).target === 'inert-button') {
            return { success: true, noEffect: true };
          }
          return { success: true };
        },
      },
      { maxRetries: 2 }
    );

    const state = await loop.runTask('Interact with page');
    // Step 2 should be rejected by Target Grounding / M5 due to stale generation
    expect(state.steps[1]?.validationAllowed).toBe(false);
    expect(state.steps[1]?.validationReason).toContain('generation');
  });

  // 8. recovery action still passes through Stage 5
  it('8. recovery action proposal must pass full Stage 5 security pipeline (fail closed on malicious recovery)', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Attempt 1' },
      // Reasoner attempts malicious action during recovery
      {
        action: 'navigate',
        url: 'javascript:alert(document.cookie)',
        reason: 'Malicious recovery action',
      },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          if (action.action === 'click') {
            return { success: true, noEffect: true };
          }
          return { success: true };
        },
      },
      { maxRetries: 2 }
    );

    const state = await loop.runTask('Recovery task');
    expect(state.steps[1]?.validationAllowed).toBe(false);
    expect(state.steps[1]?.validationReason).toContain('unsafe or non-web protocol');
  });

  // 9. goal cannot be marked SUCCESS without verified effect
  it('9. goal cannot be marked SUCCESS if action produced NO effect', async () => {
    const context = createMockContext();
    // Task is "Scroll down the page"
    const provider = new MockAgentProvider([
      { action: 'scroll', direction: 'down', amount: 500, reason: 'Scroll' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async () => ({
          success: true,
          // scroll produced 0 delta (scroll boundary reached / no effect)
          scrollDelta: 0,
          noEffect: true,
        }),
      },
      { maxRetries: 0 }
    );

    const state = await loop.runTask('Scroll down');
    // The goal requires scroll effect, but action had no effect
    expect(state.status).not.toBe('SUCCESS');
    expect(state.goalStatus).not.toBe('SUCCESS');
    expect(state.steps[0]?.effectVerified).toBe(false);
  });

  // 10. no infinite recovery loop
  it('10. bounds enforce termination with zero infinite loops', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Loop attempt' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async () => ({ success: true, noEffect: true }),
      },
      { maxRetries: 2, maxSteps: 5 }
    );

    const start = Date.now();
    const state = await loop.runTask('Infinite loop test');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000); // Must terminate quickly
    expect(state.status).toBe('FAILED');
    expect(state.retryCount).toBeGreaterThan(2); // Exhausted
  });
});
