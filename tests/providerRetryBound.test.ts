/**
 * PrivAgent — M7 Phase 4: Provider Retry Observability & Bound Proof
 *
 * Proves the TOTAL number of provider reasoning calls is explicitly bounded:
 *
 *   total provider calls ≤ maxSteps × (1 + providerRetries)
 *
 * for the worst case (every attempt fails with a RETRYABLE error), and that
 * non-retryable failures stop after ONE attempt. `providerAttempts` is
 * tracked separately from M6 `retryCount` and exposed on TaskState.
 *
 * No test performs a live network call.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, TaskState } from '../extension/src/agent/agentLoop';
import { AgentProvider } from '../extension/src/agent/agentProvider';
import { ProviderError } from '../extension/src/agent/openRouterProvider';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';

const CONTEXT: AgentContextPayload = {
  url: 'https://bank.example.com/portal',
  timestamp: 1720000000000,
  viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
  screenshot_dimensions: null,
  detections: [
    {
      id: 'element_account_num',
      type: 'account_number',
      confidence: 0.97,
      bbox: { x: 120, y: 180, width: 220, height: 35 },
      length: 12,
      source: 'dom_input_type',
      selector: '#account-number',
      is_partially_visible: false,
    },
  ],
  total_elements_scanned: 15,
  sensitive_elements_detected: 1,
  sanitized_status: 'sanitized_only',
  ocr_metrics: null,
};

function makeLoop(
  provider: AgentProvider,
  opts: { maxSteps?: number; providerRetries?: number } = {}
): AgentLoop {
  return new AgentLoop(provider, {
    perceivePage: async () => CONTEXT,
    executeAction: async () => ({ success: true }),
  }, {
    maxSteps: opts.maxSteps ?? 10,
    maxRetries: 2,
    delayBetweenStepsMs: 1,
    providerRetries: opts.providerRetries ?? 2,
    providerRetryDelayMs: 1,
  });
}

describe('Provider retry bound proof (Phase 4)', () => {
  it('worst case reaching the product bound: fail providerRetries times, succeed on final attempt, every step', async () => {
    let calls = 0;
    const perStepBudget = 1 + 3; // providerRetries = 3
    const boundedFlaky: AgentProvider = {
      name: 'BoundedFlaky',
      async requestAction(): Promise<BrowserAction> {
        calls++;
        // Fail the first `providerRetries` attempts of every step, succeed on
        // the final allowed attempt so the loop continues to the next step.
        if (calls % perStepBudget !== 0) {
          throw new ProviderError('simulated 5xx', 'http_error', { retryable: true });
        }
        return { action: 'scroll', direction: 'down', amount: 300 };
      },
    };

    const maxSteps = 4;
    const providerRetries = 3;
    const loop = makeLoop(boundedFlaky, { maxSteps, providerRetries });
    const state: TaskState = await loop.runTask('Inspect the page thoroughly');

    // Task ends at the max-step bound (goal never satisfied by scrolls).
    expect(state.status).toBe('FAILED');
    // EXACT worst case: every step consumed its full 1 + providerRetries budget.
    expect(calls).toBe(maxSteps * (1 + providerRetries));
    expect(state.providerAttempts).toBe(calls);
  });

  it('all-attempts-fail case: task fails closed after one step (≤ bound)', async () => {
    let calls = 0;
    const alwaysRetryable: AgentProvider = {
      name: 'AlwaysRetryable',
      async requestAction(): Promise<BrowserAction> {
        calls++;
        throw new ProviderError('simulated 5xx', 'http_error', { retryable: true });
      },
    };

    const maxSteps = 4;
    const providerRetries = 3;
    const loop = makeLoop(alwaysRetryable, { maxSteps, providerRetries });
    const state: TaskState = await loop.runTask('Find the account number field');

    expect(state.status).toBe('FAILED');
    // Fail-closed: a fully-failed reasoning step ends the task immediately.
    expect(calls).toBe(1 + providerRetries);
    expect(state.providerAttempts).toBe(calls);
    expect(state.providerAttempts).toBeLessThanOrEqual(maxSteps * (1 + providerRetries));
  });

  it('non-retryable failure stops after exactly ONE attempt', async () => {
    let calls = 0;
    const authFailure: AgentProvider = {
      name: 'AuthFailure',
      async requestAction(): Promise<BrowserAction> {
        calls++;
        throw new ProviderError('bad key', 'auth', { retryable: false });
      },
    };

    const loop = makeLoop(authFailure, { maxSteps: 10, providerRetries: 3 });
    const state = await loop.runTask('Find the account number field');

    expect(state.status).toBe('FAILED');
    expect(calls).toBe(1);
    expect(state.providerAttempts).toBe(1);
  });

  it('retryable failure retries are bounded per step (1 + providerRetries)', async () => {
    let calls = 0;
    const flakyThenSuccess: AgentProvider = {
      name: 'FlakyThenSuccess',
      async requestAction(): Promise<BrowserAction> {
        calls++;
        if (calls < 3) {
          throw new ProviderError('transient', 'network', { retryable: true });
        }
        return { action: 'click', target: 'element_account_num' };
      },
    };

    const loop = makeLoop(flakyThenSuccess, { providerRetries: 2 });
    const state = await loop.runTask('Find the account number field');

    expect(calls).toBe(3); // 2 failed + 1 success — bounded by 1 + providerRetries
    expect(state.providerAttempts).toBe(3);
    expect(state.status === 'SUCCESS' || state.status === 'IN_PROGRESS' || state.status === 'NEEDS_USER_CONFIRMATION').toBe(true);
  });

  it('providerAttempts resets per task and is exposed on TaskState', async () => {
    const okProvider: AgentProvider = {
      name: 'Ok',
      async requestAction(): Promise<BrowserAction> {
        return { action: 'scroll', direction: 'down', amount: 300 };
      },
    };

    const loop = makeLoop(okProvider, { maxSteps: 1 });
    const state1 = await loop.runTask('Scroll down and find the transaction section');
    expect(state1.providerAttempts).toBe(1);

    const state2 = await loop.runTask('Scroll down and find the transaction section');
    expect(state2.providerAttempts).toBe(1); // reset on runTask
  });

  it('state invariant: providerAttempts never exceeds the provable bound', async () => {
    let calls = 0;
    const perStepBudget = 1 + 2; // providerRetries = 2
    const boundedFlaky: AgentProvider = {
      name: 'BoundedFlaky',
      async requestAction(): Promise<BrowserAction> {
        calls++;
        if (calls % perStepBudget !== 0) {
          throw new ProviderError('simulated timeout', 'timeout', { retryable: true });
        }
        return { action: 'scroll', direction: 'down', amount: 300 };
      },
    };

    const maxSteps = 3;
    const providerRetries = 2;
    const loop = makeLoop(boundedFlaky, { maxSteps, providerRetries });
    const state = await loop.runTask('Inspect the page thoroughly');

    expect(state.providerAttempts).toBe(calls);
    expect(state.providerAttempts).toBeLessThanOrEqual(maxSteps * (1 + providerRetries));
    expect(state.providerAttempts).toBe(9); // 3 steps × (1 fail + 1 fail + 1 success)
  });
});
