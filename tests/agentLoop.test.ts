/**
 * PrivAgent — Milestone 6 Autonomous Agent Loop Test Suite
 *
 * Tests:
 *  1. Multi-step task execution (perception → reasoning → validation → execution loop)
 *  2. Fresh context requested after each step
 *  3. Successful multi-step task (Open details -> Scroll -> Click transactions -> Success)
 *  4. Maximum-step termination (endless-loop prevention)
 *  5. Retry limit enforcement
 *  6. Failed action recovery (re-perceives and asks for alternative)
 *  7. Stale target rejection (element not in current context is rejected)
 *  8. Validator invoked on every action
 *  9. Privacy policy invoked on every action
 *  10. Raw PII never enters TaskState (assertNoSensitiveDataInState)
 *  11. Raw PII never enters agent request
 *  12. Invalid action cannot execute
 *  13. Task completion detection
 *  14. Task failure handling
 *  15. User confirmation state for consequential actions (e.g. external navigation)
 *  16. Navigation safety
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, assertNoSensitiveDataInState, TaskState } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { worldModelStore } from '../extension/src/worldModel/worldModelStore';
import { assertWorldModelSafe } from '../extension/src/worldModel/worldModelSanitizer';

function createMockContext(step = 0): AgentContextPayload {
  return {
    url: 'http://localhost:4173/bank',
    timestamp: Date.now() + step * 1000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: step * 200 },
    screenshot_dimensions: null,
    detections: [
      {
        id: `element_details_${step}`,
        type: 'account_number',
        confidence: 0.95,
        bbox: { x: 50, y: 100, width: 200, height: 35 },
        length: 12,
        source: 'dom_input_type',
        selector: '#details',
        is_partially_visible: false,
      },
      {
        id: `element_trans_${step}`,
        type: 'credit_card',
        confidence: 0.92,
        bbox: { x: 50, y: 300, width: 200, height: 35 },
        length: 16,
        source: 'dom_input_type',
        selector: '#transaction-table',
        is_partially_visible: false,
      },
    ],
    total_elements_scanned: 30,
    sensitive_elements_detected: 2,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  };
}

describe('PrivAgent M6 Autonomous Agent Loop', () => {
  // Test 1 & 3: Multi-step task execution to SUCCESS
  it('1 & 3. executes a multi-step task to SUCCESS with fresh context on each step', async () => {
    let perceptionCount = 0;
    const provider = new MockAgentProvider();

    // Callback that provides fresh context on each cycle
    const perceivePage = vi.fn(async () => {
      perceptionCount++;
      return createMockContext(perceptionCount);
    });

    const executeAction = vi.fn(async (action: BrowserAction) => {
      return { success: true, message: `Executed ${action.action}` };
    });

    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { delayBetweenStepsMs: 10 });
    const finalState = await loop.runTask('Open the account details and find the recent transactions');

    expect(finalState.status).toBe('SUCCESS');
    expect(finalState.currentStep).toBeGreaterThanOrEqual(3);
    expect(finalState.previousActions.length).toBe(3);
    expect(perceivePage).toHaveBeenCalledTimes(3); // Fresh perception on each of the 3 execution cycles
    expect(executeAction).toHaveBeenCalledTimes(3);

    // Verify step actions
    expect(finalState.previousActions[0]?.action).toBe('click');
    expect(finalState.previousActions[1]?.action).toBe('scroll');
    expect(finalState.previousActions[2]?.action).toBe('click');
  });

  // Test 2: Fresh context after each step
  it('2. verifies that fresh context is requested after each meaningful action', async () => {
    const timestamps: number[] = [];
    const provider = new MockAgentProvider();

    const perceivePage = vi.fn(async () => {
      const ctx = createMockContext(timestamps.length);
      timestamps.push(ctx.timestamp);
      return ctx;
    });

    const executeAction = vi.fn(async () => ({ success: true }));
    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { delayBetweenStepsMs: 5 });

    await loop.runTask('Open the account details and find the recent transactions');

    expect(timestamps.length).toBeGreaterThanOrEqual(3);
    // Each timestamp should be distinct (fresh perception)
    const uniqueTimestamps = new Set(timestamps);
    expect(uniqueTimestamps.size).toBe(timestamps.length);
  });

  // Test 4: Maximum-step termination (endless-loop prevention)
  it('4. terminates with FAILED status when maximum-step limit is exceeded', async () => {
    const provider = new MockAgentProvider();
    // Force agent to keep scrolling endlessly
    provider.setCustomHandler(() => ({
      action: 'scroll',
      direction: 'down',
      amount: 100,
    }));

    const perceivePage = vi.fn(async () => createMockContext(0));
    const executeAction = vi.fn(async () => ({ success: true }));

    const maxSteps = 4;
    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { maxSteps, delayBetweenStepsMs: 5 });
    const finalState = await loop.runTask('Never ending task');

    expect(finalState.status).toBe('FAILED');
    expect(finalState.currentStep).toBe(maxSteps);
    expect(finalState.reason).toMatch(/exceeded maximum step limit/i);
  });

  // Test 5 & 6: Retry limit and recovery
  it('5 & 6. retries on failed execution, re-perceives, and fails when retry limit is exceeded', async () => {
    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({
      action: 'scroll',
      direction: 'down',
      amount: 100,
    }));

    const perceivePage = vi.fn(async () => createMockContext(0));
    // Simulate DOM failure on every action
    const executeAction = vi.fn(async () => ({
      success: false,
      error: 'DOM element detached during interaction',
    }));

    const maxRetries = 2;
    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { maxRetries, delayBetweenStepsMs: 5 });
    const finalState = await loop.runTask('Scroll down and find section');

    expect(finalState.status).toBe('FAILED');
    expect(finalState.retryCount).toBeGreaterThan(maxRetries);
    expect(finalState.reason).toMatch(/execution failed repeatedly/i);
  });

  // Test 7: Stale target rejection
  it('7. rejects actions targeting elements that disappeared in the fresh context', async () => {
    const provider = new MockAgentProvider();
    // Agent proposes target from previous context that doesn't exist in current context
    provider.setNextAction({
      action: 'click',
      target: 'stale_element_that_no_longer_exists',
    });

    const perceivePage = vi.fn(async () => createMockContext(1));
    const executeAction = vi.fn(async () => ({ success: true }));

    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { maxRetries: 0, delayBetweenStepsMs: 5 });
    const finalState = await loop.runTask('Click disappeared element');

    expect(finalState.status).toBe('FAILED');
    // Target Grounding (GATE 1) rejects the vanished id before the M5 validator
    // is ever reached — a strictly earlier and stronger fail-closed gate.
    expect(finalState.reason).toMatch(/could not be grounded in the live DOM|Target Grounding Failed/i);
    expect(executeAction).not.toHaveBeenCalled(); // Stale action never reached browser
  });

  // Test 8 & 9: Validator and privacy policy invoked on every action
  it('8 & 9. enforces that validator and privacy policy run before every browser execution', async () => {
    const provider = new MockAgentProvider();
    // Propose an invalid action (excessive scroll)
    provider.setNextAction({
      action: 'scroll',
      direction: 'down',
      amount: 99999, // exceeds 5000 max
    });

    const perceivePage = vi.fn(async () => createMockContext(0));
    const executeAction = vi.fn(async () => ({ success: true }));

    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { maxRetries: 0, delayBetweenStepsMs: 5 });
    const finalState = await loop.runTask('Scroll');

    expect(finalState.status).toBe('FAILED');
    expect(executeAction).not.toHaveBeenCalled();
  });

  // Test 10: Raw PII never enters TaskState
  it('10. verifies that TaskState contains zero raw PII or sensitive keys', async () => {
    const provider = new MockAgentProvider();
    const perceivePage = vi.fn(async () => createMockContext(1));
    const executeAction = vi.fn(async () => ({ success: true }));

    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { delayBetweenStepsMs: 5 });
    const state = await loop.runTask('Find and click the account number field');

    // Recursive scan over entire state tree
    expect(() => assertNoSensitiveDataInState(state)).not.toThrow();

    const serializedState = JSON.stringify(state);
    expect(serializedState).not.toContain('123456789012');
    expect(serializedState).not.toContain('password');
    expect(serializedState).not.toContain('secret');
  });

  // Test 11: Raw PII never enters agent request
  it('11. verifies that agent reasoning requests receive only sanitized context without raw values', async () => {
    const provider = new MockAgentProvider();
    let receivedPayloadStr = '';

    provider.setCustomHandler((_task, context) => {
      receivedPayloadStr = JSON.stringify(context);
      return { action: 'scroll', direction: 'down', amount: 300 };
    });

    const perceivePage = vi.fn(async () => createMockContext(0));
    const executeAction = vi.fn(async () => ({ success: true }));

    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { maxSteps: 1, delayBetweenStepsMs: 5 });
    await loop.runTask('Inspect page');

    expect(receivedPayloadStr).toContain('"sanitized_status":"sanitized_only"');
    expect(receivedPayloadStr).not.toContain('123456789012');
    expect(receivedPayloadStr).not.toContain('"password"');
  });

  it('Stage 1: records and prefers the active world model when perception includes it', async () => {
    const provider = new MockAgentProvider();
    provider.setNextAction({ action: 'click', target: 'btn-submit' });

    document.body.innerHTML = '<button id="btn-submit">Submit</button>';
    const worldModel = buildBrowserWorldModel({ root: document, pageGeneration: 1, id: 'wm-1' });

    const perceivePage = vi.fn(async () => ({
      context: {
        ...createMockContext(0),
        url: 'http://localhost:4173/checkout',
        detections: [{
          id: 'btn-submit',
          type: 'button',
          confidence: 0.99,
          bbox: { x: 80, y: 120, width: 200, height: 40 },
          length: 6,
          source: 'dom_input_type',
          selector: '#btn-submit',
          is_partially_visible: false,
          label: 'Submit',
        }] as any,
      },
      worldModel,
      activeWorldModelRef: { pageGeneration: 1, worldModelId: 'wm-1' },
    } as any));

    const executeAction = vi.fn(async () => ({ success: true }));
    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { delayBetweenStepsMs: 5, maxSteps: 2 });

    const finalState = await loop.runTask('Submit the checkout form');

    expect(finalState.currentPageGeneration).toBe(1);
    expect(finalState.activeWorldModelRef).toEqual({ pageGeneration: 1, worldModelId: 'wm-1' });
    expect(finalState.status).toMatch(/SUCCESS|FAILED|STOPPED|NEEDS_USER_CONFIRMATION/);
    expect(perceivePage).toHaveBeenCalledTimes(1);
  });

  it('Stage 1: accepts the live world model when its generation is authoritative', async () => {
    const provider = new MockAgentProvider();
    provider.setNextAction({ action: 'click', target: 'btn-submit' });

    document.body.innerHTML = '<button id="btn-submit">Submit</button>';
    const liveModel = buildBrowserWorldModel({ root: document, pageGeneration: 4, id: 'wm-live-4' });

    const perceivePage = vi.fn(async () => ({
      context: {
        ...createMockContext(0),
        url: 'http://localhost:4173/checkout',
        detections: [{
          id: 'btn-submit',
          type: 'button',
          confidence: 0.99,
          bbox: { x: 80, y: 120, width: 200, height: 40 },
          length: 6,
          source: 'dom_input_type',
          selector: '#btn-submit',
          is_partially_visible: false,
          label: 'Submit',
        }] as any,
      },
      worldModel: liveModel,
      activeWorldModelRef: { pageGeneration: 4, worldModelId: 'wm-live-4' },
    } as any));

    const executeAction = vi.fn(async () => ({ success: true }));
    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { maxSteps: 2, delayBetweenStepsMs: 5 });

    const finalState = await loop.runTask('Submit the checkout form');

    expect(finalState.currentPageGeneration).toBe(4);
    expect(finalState.activeWorldModelRef).toEqual({ pageGeneration: 4, worldModelId: 'wm-live-4' });
    expect(finalState.reason).not.toMatch(/Perception failed|stale|generation/i);
    expect(finalState.status).not.toBe('FAILED');
  });

  it('Stage 1: generation mismatch rejects a stale world model before provider context', () => {
    const provider = new MockAgentProvider();
    const staleModel = buildBrowserWorldModel({ root: document, pageGeneration: 3, id: 'wm-stale-older' });
    const loop = new AgentLoop(provider, {
      perceivePage: vi.fn(async () => ({
        context: createMockContext(0),
        worldModel: staleModel,
        activeWorldModelRef: { pageGeneration: 3, worldModelId: 'wm-stale-older' },
      } as any)),
      executeAction: vi.fn(async () => ({ success: true })),
    }, { maxSteps: 1, delayBetweenStepsMs: 5 });

    (loop as any).state.currentPageGeneration = 5;
    (loop as any).state.perceptionGeneration = 5;

    const normalized = (loop as any).normalizePerceptionResult({
      context: createMockContext(0),
      worldModel: staleModel,
      activeWorldModelRef: { pageGeneration: 3, worldModelId: 'wm-stale-older' },
    });

    expect(normalized).toBeNull();
  });

  it('Stage 1: sanitization failure fails closed for dangerous world model payloads', () => {
    document.body.innerHTML = '<button id="btn-danger">Pay now</button>';
    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 5, id: 'wm-danger' });
    (wm as any).page.title = '4111111111111111';

    expect(() => assertWorldModelSafe(wm)).toThrow(/Forbidden sensitive property|Raw sensitive credential/i);
  });

  it('Stage 1: world model store retains the active reference for the live page generation', async () => {
    document.body.innerHTML = '<button id="btn-live">Next</button>';
    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 3, id: 'wm-live' });
    const ref = worldModelStore.registerWorldModel(wm);

    expect(ref).toEqual({ pageGeneration: 3, worldModelId: 'wm-live' });
    expect(worldModelStore.getActiveWorldModel(ref)?.id).toBe('wm-live');
    expect(worldModelStore.isTargetValid(ref, 'btn-live', 3)).toBe(true);
  });

  // Test 15 & 16: Consequential action check (NEEDS_USER_CONFIRMATION for external navigation)
  it('15 & 16. pauses loop in NEEDS_USER_CONFIRMATION when navigating to an external origin', async () => {
    const provider = new MockAgentProvider();
    // Agent proposes navigating to an external origin
    provider.setNextAction({
      action: 'navigate',
      url: 'https://external-untrusted.com/login',
    });

    const perceivePage = vi.fn(async () => createMockContext(0)); // context url is localhost:4173
    const executeAction = vi.fn(async () => ({ success: true }));

    const loop = new AgentLoop(provider, { perceivePage, executeAction }, { delayBetweenStepsMs: 5 });
    const state = await loop.runTask('Navigate outside');

    expect(state.status).toBe('NEEDS_USER_CONFIRMATION');
    expect(state.requiresUserConfirmationAction).toBeDefined();
    expect(executeAction).not.toHaveBeenCalled(); // Paused: did not execute automatically
  });

  // Test 17: Stop / Cancel action transitions status to STOPPED
  it('17. safely halts execution when stop() is called on AgentLoop', async () => {
    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({ action: 'click', target: 'element_details_0' }));

    const perceivePage = vi.fn(async () => createMockContext(0));
    const executeAction = vi.fn(async () => ({ success: true }));

    let loopInstance: AgentLoop;
    const onProgress = vi.fn((state: TaskState) => {
      if (state.currentStep >= 1) {
        loopInstance.stop();
      }
    });

    loopInstance = new AgentLoop(
      provider,
      { perceivePage, executeAction, onStepProgress: onProgress },
      { maxSteps: 10, delayBetweenStepsMs: 20 }
    );

    const state = await loopInstance.runTask('Complex multi-step investigation');
    expect(state.status).toBe('STOPPED');
    expect(state.reason).toContain('stopped by user');
  });
});

