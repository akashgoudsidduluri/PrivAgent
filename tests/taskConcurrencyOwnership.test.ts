/**
 * PHASE 18.1 — TASK CONCURRENCY & STALE LOOP OWNERSHIP TESTS
 *
 * TEST 1: Start Task A. Before A finishes, start Task B. Verify A is stopped.
 * TEST 2: After Task B starts, force Task A's async continuation to resume. Verify A cannot execute an action.
 * TEST 3: After Task B starts, force Task A to emit an event. Verify the event is rejected/ignored.
 * TEST 4: Task B provider calls must not contain Task A's request.
 * TEST 5: Task B timeline contains only Task B events.
 * TEST 6: Normal single-task execution remains unchanged.
 * TEST 7: Rapid sequence A -> B -> C: A stops, B stops, C remains active, zero cross-talk.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { ExtensionAgentAdapter } from '../frontend/src/adapters/extensionAdapter';
import { observingHost, simulatedBrowser, type ObservedPageState } from './helpers/observingHost';

function createMockContext(step = 0, url = 'http://localhost:4173/bank'): AgentContextPayload {
  const detailsOpened = step >= 4;
  return {
    url,
    timestamp: Date.now() + step * 1000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: step * 100 },
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
      ...(detailsOpened
        ? [
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
          ]
        : []),
    ],
    total_elements_scanned: 10,
    sensitive_elements_detected: detailsOpened ? 2 : 1,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  } as AgentContextPayload;
}

describe('PHASE 18.1 — Task Concurrency and Stale Loop Repair', () => {
  // TEST 1: Start Task A. Before A finishes, start Task B. Verify A is stopped.
  it('TEST 1: Start Task A. Before A finishes, start Task B. Verify A is stopped.', async () => {
    let loopAStarted = false;
    let loopAEnded = false;

    const providerA = new MockAgentProvider([
      { action: 'scroll', direction: 'down', amount: 200 },
      { action: 'scroll', direction: 'down', amount: 200 },
    ]);

    const loopA = new AgentLoop(
      providerA,
      {
        perceivePage: async () => {
          loopAStarted = true;
          // Delay context acquisition to keep loop A in-flight
          await new Promise((resolve) => setTimeout(resolve, 30));
          return createMockContext(0);
        },
        executeAction: async () => ({ success: true }),
        getEffectSnapshot: async () => ({
          url: 'http://localhost:4173/bank',
          domElementCount: 5,
          scrollX: 0,
          scrollY: 0,
          timestamp: Date.now(),
        } as any),
      },
      { maxSteps: 5, runId: 1 }
    );

    const runAPromise = loopA.runTask('Task A - Scroll down').then((state) => {
      loopAEnded = true;
      return state;
    });

    // Wait until Loop A has started
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loopA.isHalted()).toBe(false);

    // Now Task B starts: supersedes and explicitly halts loop A
    loopA.stop(true);
    expect(loopA.isHalted()).toBe(true);

    const finalStateA = await runAPromise;
    expect(loopAEnded).toBe(true);
    expect(finalStateA.status).toBe('STOPPED');
  });

  // TEST 2: After Task B starts, force Task A's async continuation to resume. Verify A cannot execute an action.
  it("TEST 2: After Task B starts, force Task A's async continuation to resume. Verify A cannot execute an action.", async () => {
    let actionExecutedByA = false;
    let resumeContinuationA: () => void = () => {};

    const providerA = new MockAgentProvider([
      { action: 'click', target: 'element_details_0' },
    ]);

    const loopA = new AgentLoop(
      providerA,
      {
        perceivePage: async () => {
          // Pause A in async context resolution
          await new Promise<void>((resolve) => {
            resumeContinuationA = resolve;
          });
          return createMockContext(0);
        },
        executeAction: async () => {
          actionExecutedByA = true;
          return { success: true };
        },
        getEffectSnapshot: async () => ({
          url: 'http://localhost:4173/bank',
          domElementCount: 5,
          scrollX: 0,
          scrollY: 0,
          timestamp: Date.now(),
        } as any),
      },
      { maxSteps: 5, runId: 101 }
    );

    const runAPromise = loopA.runTask('Task A - Click button');

    // Wait a tick for perception to begin
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Task B arrives and supersedes Task A
    loopA.stop(true);

    // Force Task A's async continuation to resume
    resumeContinuationA();

    const stateA = await runAPromise;
    expect(stateA.status).toBe('STOPPED');
    // Task A must not have executed its action
    expect(actionExecutedByA).toBe(false);
  });

  // TEST 3: After Task B starts, force Task A to emit an event. Verify the event is rejected/ignored by frontend.
  it("TEST 3: After Task B starts, force Task A to emit an event. Verify the event is rejected/ignored.", async () => {
    const adapter = new ExtensionAgentAdapter();
    const observedEvents: any[] = [];

    adapter.onStateChange((state) => {
      observedEvents.push(JSON.parse(JSON.stringify(state)));
    });

    // Simulate Task B starting on adapter
    vi.spyOn(adapter, 'checkExtensionConnected').mockResolvedValue(true);
    await adapter.startTask('Task B: New Task');

    const stateAfterB = adapter.getState();
    expect(stateAfterB.task).toBe('Task B: New Task');
    expect(stateAfterB.status).toBe('RUNNING');

    const runIdB = (adapter as any).currentRunId;

    // Now an old event arrives from superseded Task A with stale runId
    const stalePayloadA = {
      runId: runIdB - 1,
      task: 'Task A: Old Task',
      status: 'RUNNING',
      currentStep: 1,
      maxSteps: 10,
      steps: [
        {
          step: 1,
          action: { action: 'scroll', direction: 'down', amount: 500 },
          validationAllowed: true,
          executionSuccess: true,
        },
      ],
    };

    // Dispatch stale message to adapter
    (adapter as any).handleExtensionProgress(stalePayloadA);

    // Verify adapter state was NOT updated with Task A's payload
    const currentState = adapter.getState();
    expect(currentState.task).toBe('Task B: New Task');
    expect(currentState.steps.length).toBe(0); // Task A's scroll step was rejected!

    // Verify legitimate Task B progress IS accepted
    const legitimatePayloadB = {
      runId: runIdB,
      task: 'Task B: New Task',
      status: 'RUNNING',
      currentStep: 1,
      maxSteps: 10,
      steps: [
        {
          step: 1,
          action: { action: 'click', target: '#catalog' },
          validationAllowed: true,
          executionSuccess: true,
        },
      ],
    };
    (adapter as any).handleExtensionProgress(legitimatePayloadB);

    const updatedState = adapter.getState();
    expect(updatedState.task).toBe('Task B: New Task');
    expect(updatedState.steps.length).toBe(1);
    expect(updatedState.steps[0]?.targetDescription).toBe('#catalog');

    adapter.destroy();
  });

  // TEST 4: Task B provider calls must not contain Task A's request.
  it("TEST 4: Task B provider calls must not contain Task A's request.", async () => {
    let capturedTaskPromptInB: string | null = null;

    const providerB = {
      name: 'TestProviderB',
      requestAction: async (task: string) => {
        capturedTaskPromptInB = task;
        return {
          action: 'scroll',
          direction: 'down',
          amount: 100,
        } as BrowserAction;
      },
    };

    const loopB = new AgentLoop(
      providerB as any,
      {
        perceivePage: async () => createMockContext(0),
        executeAction: async () => ({ success: true }),
        getEffectSnapshot: async () => ({
          url: 'http://localhost:4173/shop',
          domElementCount: 5,
          scrollX: 0,
          scrollY: 0,
          timestamp: Date.now(),
        } as any),
      },
      { maxSteps: 1, runId: 2 }
    );

    await loopB.runTask('Task B: Open Catalog');

    expect(capturedTaskPromptInB).toBe('Task B: Open Catalog');
    expect(capturedTaskPromptInB).not.toContain('Task A');
  });

  // TEST 5: Task B timeline contains only Task B events.
  it('TEST 5: Task B timeline contains only Task B events.', async () => {
    const adapter = new ExtensionAgentAdapter();
    vi.spyOn(adapter, 'checkExtensionConnected').mockResolvedValue(true);

    // Start Task A
    await adapter.startTask('Task A: Scroll page');
    const runIdA = (adapter as any).currentRunId;

    // Task A progress arrives
    (adapter as any).handleExtensionProgress({
      runId: runIdA,
      task: 'Task A: Scroll page',
      status: 'RUNNING',
      currentStep: 1,
      steps: [{ step: 1, action: { action: 'scroll', amount: 500 } }],
    });
    expect(adapter.getState().steps.length).toBe(1);

    // Now start Task B (superseding A)
    await adapter.startTask('Task B: Open Catalog');
    const runIdB = (adapter as any).currentRunId;
    expect(runIdB).toBeGreaterThan(runIdA);

    // Timeline for Task B starts completely clean
    expect(adapter.getState().task).toBe('Task B: Open Catalog');
    expect(adapter.getState().steps.length).toBe(0);

    // Stale delayed event from Task A arrives
    (adapter as any).handleExtensionProgress({
      runId: runIdA,
      task: 'Task A: Scroll page',
      status: 'RUNNING',
      currentStep: 2,
      steps: [
        { step: 1, action: { action: 'scroll', amount: 500 } },
        { step: 2, action: { action: 'scroll', amount: 500 } },
      ],
    });

    // Verify timeline STILL has 0 steps (stale Task A steps rejected)
    expect(adapter.getState().steps.length).toBe(0);

    // Task B event arrives
    (adapter as any).handleExtensionProgress({
      runId: runIdB,
      task: 'Task B: Open Catalog',
      status: 'RUNNING',
      currentStep: 1,
      steps: [{ step: 1, action: { action: 'click', target: '#catalog-link' } }],
    });

    expect(adapter.getState().steps.length).toBe(1);
    expect(adapter.getState().steps[0]?.targetDescription).toBe('#catalog-link');

    adapter.destroy();
  });

  // TEST 6: Normal single-task execution remains unchanged.
  it('TEST 6: Normal single-task execution remains unchanged.', async () => {
    let executedAction = false;
    let stepCount = 0;

    const page: ObservedPageState = { url: 'https://example.com/dashboard', domElementCount: 0 };
    const provider = new MockAgentProvider();

    let perceptionCount = 0;
    const perceivePage = vi.fn(async () => {
      perceptionCount++;
      return createMockContext(perceptionCount >= 3 ? 4 : perceptionCount);
    });

    const executeAction = vi.fn(async (action: BrowserAction) => {
      executedAction = true;
      return simulatedBrowser(page)(action);
    });

    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(page),
        perceivePage,
        executeAction,
        onStepProgress: () => {
          stepCount++;
        },
      },
      { delayBetweenStepsMs: 5, runId: 999 }
    );

    const state = await loop.runTask('Open the account details and find the recent transactions');

    expect(state.status).toBe('SUCCESS');
    expect(executedAction).toBe(true);
    expect(stepCount).toBeGreaterThanOrEqual(1);
    expect(loop.getRunId()).toBe(999);
  });

  // TEST 7: Rapid sequence A -> B -> C: A stops, B stops, C remains active, zero cross-talk.
  it('TEST 7: Rapid sequence A -> B -> C: A stops, B stops, C remains active, zero cross-talk.', async () => {
    const adapter = new ExtensionAgentAdapter();
    vi.spyOn(adapter, 'checkExtensionConnected').mockResolvedValue(true);

    // Rapidly invoke A -> B -> C
    const promiseA = adapter.startTask('Task A: Search shoes');
    const promiseB = adapter.startTask('Task B: Filter prices');
    const promiseC = adapter.startTask('Task C: Checkout cart');

    await Promise.all([promiseA, promiseB, promiseC]);

    const finalRunId = (adapter as any).currentRunId;
    const currentState = adapter.getState();

    // Only Task C is active
    expect(currentState.task).toBe('Task C: Checkout cart');
    expect(currentState.status).toBe('RUNNING');

    // Any delayed events from A or B must be rejected
    (adapter as any).handleExtensionProgress({
      runId: finalRunId - 2,
      task: 'Task A: Search shoes',
      status: 'RUNNING',
      currentStep: 1,
      steps: [{ step: 1, action: { action: 'scroll', amount: 500 } }],
    });
    (adapter as any).handleExtensionProgress({
      runId: finalRunId - 1,
      task: 'Task B: Filter prices',
      status: 'RUNNING',
      currentStep: 1,
      steps: [{ step: 1, action: { action: 'click', target: '#filter' } }],
    });

    expect(adapter.getState().steps.length).toBe(0);

    // Event for Task C is accepted
    (adapter as any).handleExtensionProgress({
      runId: finalRunId,
      task: 'Task C: Checkout cart',
      status: 'RUNNING',
      currentStep: 1,
      steps: [{ step: 1, action: { action: 'click', target: '#checkout-btn' } }],
    });

    expect(adapter.getState().steps.length).toBe(1);
    expect(adapter.getState().steps[0]?.targetDescription).toBe('#checkout-btn');

    adapter.destroy();
  });
});
