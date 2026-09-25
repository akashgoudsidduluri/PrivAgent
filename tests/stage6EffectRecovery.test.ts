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
 *
 * All fixtures below are SYNTHETIC (deterministic mocked context + mocked executor).
 * Real-browser evidence is collected separately under docs/evidence/.
 */

import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { AgentContextPayload, AgentDetection } from '../extension/src/privacy/types';

function detection(
  id: string,
  type: AgentDetection['type'],
  selector: string,
  bbox: [number, number, number, number] = [10, 10, 120, 30]
): AgentDetection {
  return {
    id,
    type,
    selector,
    confidence: 0.95,
    bbox: { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
  };
}

/**
 * Builds a strictly sanitized AgentContextPayload.
 * NEVER contains raw values — only metadata (assertSanitizedContextSafe enforces this).
 */
function createMockContext(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: 'https://example.com/shop',
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 10,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 4, sensitive_detected: 0, latency_ms: 12 },
    detections: [
      detection('search-input', 'input', 'input#search-box', [10, 10, 200, 30]),
      detection('search-button', 'button', 'button#btn-submit', [220, 10, 80, 30]),
      detection('inert-button', 'button', 'button#btn-inert', [320, 10, 80, 30]),
      detection('scroll-anchor', 'element', 'div#footer', [0, 800, 1000, 100]),
    ],
    ...overrides,
  };
}

describe('PrivAgent Stage 6: Action Effect Verification + Bounded Recovery', () => {
  // 1. successful action + verified effect
  it('1. successful action with verified observable effect is recorded as EFFECT_VERIFIED', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'type', target: 'search-input', text: 'cats', reason: 'Type search query' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async () => ({
          success: true,
          message: 'Dispatched input into DOM',
          // Post snapshot shows the value length actually changed in the DOM
          postSnapshot: {
            url: context.url,
            scrollX: 0,
            scrollY: 0,
            domElementCount: context.detections.length,
            targetValueLength: 4,
            timestamp: Date.now(),
          },
        }),
      },
      { maxSteps: 1 }
    );

    const state = await loop.runTask('Search query');
    expect(state.steps.length).toBe(1);
    expect(state.steps[0]?.executionSuccess).toBe(true);
    expect(state.steps[0]?.effectVerified).toBe(true);
    expect(state.steps[0]?.effectStatus).toBe('VALUE_STATE_CHANGED');
    expect(state.previousActions.length).toBe(1);
    expect(state.failureHistory?.some((f) => f.category === 'ACTION_NO_EFFECT')).toBe(false);
  });

  // 2. action executes but produces no effect
  it('2. successful execution without observable effect is ACTION_NO_EFFECT, not success', async () => {
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
          // Controlled fixture / inert element: executor returns no observable change
          noEffect: true,
        }),
      },
      { maxRetries: 0, maxSteps: 3 }
    );

    const state = await loop.runTask('Click inert element');
    expect(state.steps[0]?.executionSuccess).toBe(false);
    expect(state.steps[0]?.effectVerified).toBe(false);
    expect(state.steps[0]?.effectStatus).toBe('ACTION_NO_EFFECT');
    expect(state.failureHistory?.some((f) => f.category === 'ACTION_NO_EFFECT')).toBe(true);
    // The no-effect action must never be recorded as a successful previous action
    expect(state.previousActions.length).toBe(0);
  });

  // 3. no-effect triggers recovery
  it('3. detecting ACTION_NO_EFFECT triggers bounded recovery and records the failure taxonomy', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Click inert element' },
      { action: 'scroll', direction: 'down', amount: 200, reason: 'Observation scroll recovery' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) =>
          action.action === 'click'
            ? { success: true, noEffect: true }
            : { success: true, scrollDelta: 200 },
      },
      { maxRetries: 2, maxSteps: 2 }
    );

    const state = await loop.runTask('Perform button action');
    expect(state.recoveryCount).toBeGreaterThanOrEqual(1);
    expect(state.failureHistory?.some((f) => f.category === 'ACTION_NO_EFFECT')).toBe(true);
    // Recovery produced a verified effect on the retry
    expect(state.steps[1]?.effectVerified).toBe(true);
    expect(state.steps[1]?.effectStatus).toBe('SCROLL_CHANGED');
  });

  // 4. recovery re-perceives before retry
  it('4. recovery re-perceives fresh page context before attempting a retry', async () => {
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
        executeAction: async (action) =>
          action.action === 'click'
            ? { success: true, noEffect: true }
            : { success: true, scrollDelta: 200 },
      },
      { maxRetries: 1, maxSteps: 2 }
    );

    await loop.runTask('Perform interaction');
    // perceivePage must be called: 1 (initial) + 1 (re-perception inside recovery)
    expect(perceiveCount).toBeGreaterThanOrEqual(2);
  });

  // 5. recovery retry succeeds
  it('5. recovery retry successfully completes the step with a verified effect', async () => {
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
      { maxRetries: 2, maxSteps: 2 }
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
      { maxRetries: 1, maxSteps: 5 } // Allow 1 retry, then exhaust
    );

    const state = await loop.runTask('Repeatedly inert action');
    expect(state.status).toBe('FAILED');
    expect(state.goalStatus).toBe('FAILED');
    expect(state.lastFailure?.category).toBe('RECOVERY_EXHAUSTED');
    expect(state.reason).toContain('Recovery limit exceeded');
    // Bounded: exactly one retry was attempted
    expect(state.steps.length).toBe(2);
  });

  // 7. stale target after recovery is rejected
  it('7. target ID from a prior generation is rejected as stale after recovery advances generation', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Click inert' },
      // Attempt to reuse a target grounded in an older page generation
      {
        action: 'click',
        target: 'search-input',
        pageGeneration: 0,
        reason: 'Stale target reference',
      } as unknown as BrowserAction,
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) =>
          action.action === 'click' && (action as { target?: string }).target === 'inert-button'
            ? { success: true, noEffect: true }
            : { success: true },
      },
      { maxRetries: 2, maxSteps: 2 }
    );

    const state = await loop.runTask('Interact with page');
    // Recovery-time proposal is rejected by Gate 1 (Target Grounding / generation guard)
    expect(state.steps[1]?.validationAllowed).toBe(false);
    expect(state.steps[1]?.validationReason).toContain('generation');
    expect(state.steps[1]?.effectVerified).toBeFalsy();
  });

  // 8. recovery action still passes through Stage 5
  it('8. recovery proposals must pass the full Stage 5 security pipeline (fail closed on malicious recovery)', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'click', target: 'inert-button', reason: 'Attempt 1' },
      // Reasoner attempts a malicious action during recovery
      {
        action: 'navigate',
        url: 'javascript:alert(document.cookie)',
        reason: 'Malicious recovery action',
      },
    ]);

    const dispatched: BrowserAction[] = [];
    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          dispatched.push(action);
          return { success: true, noEffect: true };
        },
      },
      { maxRetries: 2, maxSteps: 2 }
    );

    const state = await loop.runTask('Recovery task');
    expect(state.steps[1]?.validationAllowed).toBe(false);
    expect(state.steps[1]?.validationReason).toContain('unsafe or non-web protocol');
    // The malicious recovery action never reached the browser executor
    expect(dispatched.some((a) => a.action === 'navigate')).toBe(false);
    expect(state.previousActions.length).toBe(0);
  });

  // 9. goal cannot be marked SUCCESS without verified effect
  it('9. goal cannot be marked SUCCESS when the action produced NO effect', async () => {
    const context = createMockContext();
    const provider = new MockAgentProvider([
      { action: 'scroll', direction: 'down', amount: 500, reason: 'Scroll' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async () => ({
          success: true,
          // Scroll produced 0 delta (scroll boundary reached) — no observable effect
          scrollDelta: 0,
          noEffect: true,
        }),
      },
      { maxRetries: 0, maxSteps: 3 }
    );

    const state = await loop.runTask('Scroll down');
    expect(state.status).not.toBe('SUCCESS');
    expect(state.goalStatus).not.toBe('SUCCESS');
    expect(state.steps[0]?.effectVerified).toBe(false);
    expect(state.steps[0]?.effectStatus).toBe('ACTION_NO_EFFECT');
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
      { maxRetries: 2, maxSteps: 5, delayBetweenStepsMs: 0 }
    );

    const start = Date.now();
    const state = await loop.runTask('Infinite loop test');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000); // Must terminate quickly
    expect(state.status).toBe('FAILED');
    expect(state.retryCount).toBeGreaterThan(2); // Recovery bounded and exhausted
    expect(state.steps.length).toBeLessThanOrEqual(5); // maxSteps bound respected
  });
});
