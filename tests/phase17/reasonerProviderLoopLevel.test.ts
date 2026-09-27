/**
 * PrivAgent — PHASE 17.5: LOOP-LEVEL provider invariants.
 *
 * WHY THIS FILE EXISTS SEPARATELY:
 * The pure-function suite in `reasonerProviderRobustness.test.ts` cannot see the
 * CALL SITE. Six mutations survived it — stale-response rejection, the retry
 * bound, failure-to-SUCCESS, the M5 bypass and malformed-dispatch — because none
 * of them is observable from the validator in isolation. These tests drive the
 * REAL `AgentLoop` so the wiring itself is under test.
 *
 * The provider here is a CONTROLLED ADAPTER used for failure injection. It is
 * explicitly NOT the real reasoner and is never reported as one. Real-provider
 * evidence lives in `docs/evidence/phase17/17.5-reasoner/`.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../extension/src/agent/agentLoop';
import { ProviderError } from '../../extension/src/agent/openRouterProvider';
import type { AgentContextPayload } from '../../extension/src/privacy/types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';
import { observationIdentity } from '../../extension/src/agent/providerResponse';

const ORIGIN = 'http://localhost:4260';

function perceive(overrides: Partial<AgentContextPayload> = {}) {
  return async () =>
    ({
      url: `${ORIGIN}/`,
      timestamp: Date.now(),
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
      viewportObservable: true,
      screenshot_dimensions: null,
      detections: [
        {
          id: 'el_0_go',
          type: 'button',
          confidence: 0.95,
          bbox: { x: 10, y: 10, width: 220, height: 28 },
          length: 0,
          source: 'dom_attribute',
          selector: '#go',
          is_partially_visible: false,
        },
      ],
      total_elements_scanned: 12,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
      ...overrides,
    }) as unknown as ReturnType<typeof Object> as never;
}

const effectSnapshot = async () => ({
  url: `${ORIGIN}/`,
  scrollX: 0,
  scrollY: 0,
  domElementCount: 12,
  targetValueLength: 0,
  openModalsCount: 0,
  timestamp: Date.now(),
});

/** A provider that always fails, and counts how many times it was called. */
function failingProvider(kind: 'network' | 'timeout' | 'rate_limit', calls: { n: number }) {
  return {
    name: 'FailingControlledProvider',
    registerFailure: () => {},
    requestAction: vi.fn(async () => {
      calls.n += 1;
      throw new ProviderError('controlled failure', kind, { retryable: kind === 'network' || kind === 'timeout' });
    }),
    reviewAction: async () => ({ safe: true, reason: 'ok' }),
  } as never;
}

describe('17.5 loop-level · provider failure never becomes SUCCESS (M5)', () => {
  it('a provider failure ends the task FAILED, never SUCCESS', async () => {
    const calls = { n: 0 };
    const loop = new AgentLoop(
      failingProvider('network', calls),
      { getEffectSnapshot: effectSnapshot, perceivePage: perceive(), executeAction: async () => ({ success: true }) },
      { maxSteps: 3, providerRetries: 1, delayBetweenStepsMs: 0, providerRetryDelayMs: 0 }
    );
    const state = await loop.runTask('Do the thing');
    expect(state.status).toBe('FAILED');
    expect(state.goalStatus).not.toBe('SUCCESS');
    expect(state.reason).toMatch(/Agent reasoning failed/);
  });

  it('a non-retryable provider failure does not retry at all', async () => {
    const calls = { n: 0 };
    const loop = new AgentLoop(
      failingProvider('rate_limit', calls),
      { getEffectSnapshot: effectSnapshot, perceivePage: perceive(), executeAction: async () => ({ success: true }) },
      { maxSteps: 3, providerRetries: 3, delayBetweenStepsMs: 0, providerRetryDelayMs: 0 }
    );
    await loop.runTask('Do the thing');
    // A rate limit is never retried, however high the configured bound.
    expect(calls.n).toBe(1);
  });
});

describe('17.5 loop-level · retries are bounded (M4)', () => {
  it('a permanently failing provider is called at most providerRetries+1 times', async () => {
    for (const retries of [0, 1, 2]) {
      const calls = { n: 0 };
      const loop = new AgentLoop(
        failingProvider('network', calls),
        { getEffectSnapshot: effectSnapshot, perceivePage: perceive(), executeAction: async () => ({ success: true }) },
        { maxSteps: 3, providerRetries: retries, delayBetweenStepsMs: 0, providerRetryDelayMs: 0 }
      );
      const state = await loop.runTask('Do the thing');
      expect(state.status).toBe('FAILED');
      expect(calls.n).toBe(retries + 1);
    }
  });
});

describe('17.5 loop-level · stale response is refused (M3)', () => {
  it('a response computed from a page that has since moved dispatches NOTHING', async () => {
    const dispatched: string[] = [];
    const provider = {
      name: 'StaleControlledProvider',
      registerFailure: () => {},
      // Simulates the real hazard: the page navigates while the request is in
      // flight, so the proposal describes a browser state that no longer exists.
      requestAction: vi.fn(async () => {
        const loopRef = loop as unknown as { state: { currentPageGeneration?: number } };
        if (loopRef.state) loopRef.state.currentPageGeneration = 99;
        return { action: 'click', target: 'el_0_go' } as BrowserAction;
      }),
      reviewAction: async () => ({ safe: true, reason: 'ok' }),
    } as never;

    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: effectSnapshot,
        perceivePage: perceive(),
        executeAction: async (a: BrowserAction) => {
          dispatched.push(a.action);
          return { success: true };
        },
      },
      { maxSteps: 2, providerRetries: 0, delayBetweenStepsMs: 0, providerRetryDelayMs: 0 }
    );
    const state = await loop.runTask('Click the button');
    // The stale proposal was REFUSED: nothing was dispatched and the task did
    // not succeed.
    expect(dispatched).toHaveLength(0);
    expect(state.goalStatus).not.toBe('SUCCESS');
  });

  it('the identity used for the staleness check actually tracks the page generation', () => {
    const a = observationIdentity({ pageGeneration: 1, url: 'u', detectionIds: ['d'] });
    const b = observationIdentity({ pageGeneration: 2, url: 'u', detectionIds: ['d'] });
    expect(a).not.toBe(b);
  });
});

describe('17.5 loop-level · provider output still faces every gate (M6)', () => {
  it('a provider action is refused by the SECURITY CRITIC, not dispatched', async () => {
    const dispatched: string[] = [];
    const provider = {
      name: 'OffGoalNavigationControlledProvider',
      registerFailure: () => {},
      // A consequential, off-goal navigation. It is schema-valid and targets
      // nothing, so it passes the provider boundary AND M5. The gate that must
      // stop it is the Security Critic — which is exactly the gate a naive
      // "fallback may skip a check" optimisation would skip.
      requestAction: vi.fn(
        async () =>
          ({
            action: 'navigate',
            url: 'https://unrelated-external-site.example/collect',
          }) as BrowserAction
      ),
      reviewAction: async () => ({ safe: true, reason: 'ok' }),
    } as never;

    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: effectSnapshot,
        perceivePage: perceive(),
        executeAction: async (a: BrowserAction) => {
          dispatched.push(a.action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        providerRetries: 0,
        delayBetweenStepsMs: 0,
        providerRetryDelayMs: 0,
        maxRetries: 0,
        requireConfirmationForExternalNavigation: false,
      }
    );
    const state = await loop.runTask('Read the local documentation page');
    // The critic ran, and it is the SECURITY CRITIC that stopped this action —
    // not a later gate that happened to catch it. Asserting the specific gate
    // is what makes the mutation observable: with the critic's BLOCK skipped,
    // this action is no longer stopped here.
    expect(state.lastSecurityCritic).toBeDefined();
    expect(state.lastSecurityCritic!.verdict).toBe('BLOCK');
    expect(dispatched).toHaveLength(0);
    expect(state.status).toBe('FAILED');
    expect(state.reason).toMatch(/Security Critic/i);
  });

  it('a hallucinated target is refused by GATE 1 grounding, before M5', async () => {
    const dispatched: string[] = [];
    const provider = {
      name: 'HallucinatingControlledProvider',
      registerFailure: () => {},
      requestAction: vi.fn(
        async () => ({ action: 'click', target: 'element-that-does-not-exist' } as BrowserAction)
      ),
      reviewAction: async () => ({ safe: true, reason: 'ok' }),
    } as never;

    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: effectSnapshot,
        perceivePage: perceive(),
        executeAction: async (a: BrowserAction) => {
          dispatched.push(a.action);
          return { success: true };
        },
      },
      { maxSteps: 2, providerRetries: 0, delayBetweenStepsMs: 0, providerRetryDelayMs: 0, maxRetries: 0 }
    );
    const state = await loop.runTask('Click the button');
    expect(dispatched).toHaveLength(0);
    expect(state.reason).toMatch(/Grounding/i);
  });
});
