/**
 * PrivAgent — Phase 11 Acceptance: agent-loop human interaction
 *
 * End-to-end (in-process) coverage of multi-step human-like interaction:
 *
 *   - click -> type -> pressKey Enter carrying a real search task to a
 *     VERIFIED success (goal verification against the observed URL)
 *   - a keyboard action with no observable effect surfaces ACTION_NO_EFFECT
 *     and is handed to the AUTHORITATIVE Phase 10 Recovery Engine
 *   - an off-allowlist key is stopped by M5 and never reaches execution
 *   - a long-horizon task terminates on its own bounds, never looping
 *   - an SPA-style URL change alone is not treated as task success
 *   - no raw value ever enters TaskState
 *
 * Real-browser evidence for this phase is collected separately under
 * docs/evidence/phase11-human-interaction/ and is NOT asserted here.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, assertNoSensitiveDataInState } from '../../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../../extension/src/agent/mockAgentProvider';
import { BrowserAction } from '../../extension/src/agent/actionTypes';
import type { PostActionSnapshot } from '../../extension/src/agent/effectVerifier';
import { ctx, det, snapshot } from './harness';

describe('P11-20 the agent loop drives multi-step human-like interaction', () => {
  it('20.1 click -> type -> pressKey Enter carries a search task to verified success', async () => {
    const searchPage = ctx({ url: 'https://example.com/search' });
    const resultsPage = ctx({
      url: 'https://example.com/search?q=black+cats',
      detections: [det('result-1', 'link', 'a#r1', [20, 100, 300, 40])],
    });
    let phase: 'form' | 'results' = 'form';
    const perceivePage = vi.fn(async () => (phase === 'form' ? searchPage : resultsPage));

    const provider = new MockAgentProvider([
      { action: 'click', target: 'search-box' },
      { action: 'type', target: 'search-box', text: 'black cats' },
      { action: 'pressKey', key: 'Enter', target: 'search-box' },
    ]);

    const executeAction = vi.fn(async (action: BrowserAction) => {
      if (action.action === 'pressKey') phase = 'results';
      return { success: true };
    });

    const loop = new AgentLoop(
      provider,
      {
        perceivePage,
        executeAction,
        // Real wiring: the executor reports the live post-action snapshot so
        // the keyboard step is effect-verified against observable state.
        getEffectSnapshot: async (): Promise<PostActionSnapshot> =>
          snapshot({
            url: phase === 'results' ? 'https://example.com/search?q=black+cats' : 'https://example.com/search',
            domElementCount: phase === 'results' ? 6 : 4,
            activeElementSelector: 'search-box',
            targetValueLength: phase === 'results' ? 0 : 10,
            timestamp: 1_700_000_000_001,
          }),
      },
      { delayBetweenStepsMs: 1 }
    );
    const state = await loop.runTask('Search for black cats');

    expect(state.status).toBe('SUCCESS');
    expect(executeAction.mock.calls.map((c) => c[0].action)).toEqual(['click', 'type', 'pressKey']);

    const keyStep = state.steps.find((s) => s.action.action === 'pressKey');
    expect(keyStep?.effectVerified).toBe(true);
    expect(keyStep?.effectStatus).toBe('URL_NAVIGATION_OBSERVED');
  });

  it('20.2 a pressKey with no observable effect triggers Phase 10 recovery', async () => {
    const c = ctx();
    const provider = new MockAgentProvider([
      { action: 'pressKey', key: 'Enter', target: 'search-box' },
      { action: 'scroll', direction: 'down', amount: 300 },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => c,
        executeAction: async (action) =>
          action.action === 'pressKey'
            ? { success: true, noEffect: true }
            : { success: true, scrollDelta: 300 },
      },
      { maxSteps: 2, maxRetries: 2, delayBetweenStepsMs: 1 }
    );

    const state = await loop.runTask('Search for black cats');
    expect(state.recoveryCount).toBeGreaterThanOrEqual(1);
    expect(state.failureHistory?.some((f) => f.category === 'ACTION_NO_EFFECT')).toBe(true);
    // Recovery stays with the authoritative Phase 10 engine, not a Phase 11 copy.
    expect(state.totalRecoveryAttempts).toBeGreaterThanOrEqual(1);
  });

  it('20.3 an off-allowlist key never reaches execution from the live loop', async () => {
    const c = ctx();
    const provider = new MockAgentProvider([
      { action: 'pressKey', key: 'Delete' as never },
      { action: 'scroll', direction: 'down', amount: 300 },
    ]);
    const executed: BrowserAction[] = [];
    const executeAction = vi.fn(async (action: BrowserAction) => {
      executed.push(action);
      return { success: true, scrollDelta: 300 };
    });

    const loop = new AgentLoop(
      provider,
      { perceivePage: async () => c, executeAction },
      { maxSteps: 2, delayBetweenStepsMs: 1 }
    );
    const state = await loop.runTask('Search for black cats');

    // M5 stopped the off-allowlist key: it never reached the executor.
    expect(executed.some((a) => a.action === 'pressKey')).toBe(false);
    expect(state.status).not.toBe('SUCCESS');
  });

  it('20.4 a long-horizon interaction terminates within bounds and never loops forever', async () => {
    const c = ctx();
    // A provider that always proposes the same inert action: the loop must
    // stop on its own bounds rather than spinning.
    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({
      action: 'click',
      target: 'submit-button',
      reason: 'Repeating the same inert step',
    }));

    let executions = 0;
    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => c,
        executeAction: async () => {
          executions += 1;
          return { success: true, noEffect: true };
        },
      },
      { maxSteps: 4, maxRetries: 2, delayBetweenStepsMs: 1 }
    );

    const state = await loop.runTask('Search for black cats');
    expect(executions).toBeLessThanOrEqual(4);
    expect(state.status).not.toBe('SUCCESS');
  });

  it('20.5 an SPA-style URL change alone is not treated as task success', async () => {
    const c = ctx({ url: 'https://example.com/app' });
    const provider = new MockAgentProvider([
      { action: 'click', target: 'results-link' },
      { action: 'scroll', direction: 'down', amount: 300 },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => c,
        executeAction: async (action) =>
          action.action === 'click'
            ? { success: true, urlChanged: 'https://example.com/app?view=results' }
            : { success: true, scrollDelta: 300 },
      },
      { maxSteps: 2, delayBetweenStepsMs: 1 }
    );

    const state = await loop.runTask('Search for black cats');
    expect(state.status).not.toBe('SUCCESS');
  });

  it('20.6 no raw value ever enters TaskState', async () => {
    const c = ctx();
    const provider = new MockAgentProvider([
      { action: 'type', target: 'search-box', text: 'black cats' },
      { action: 'scroll', direction: 'down', amount: 300 },
    ]);
    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => c,
        executeAction: async () => ({ success: true, scrollDelta: 300 }),
      },
      { maxSteps: 2, delayBetweenStepsMs: 1 }
    );
    const state = await loop.runTask('Search for black cats');
    expect(() => assertNoSensitiveDataInState(state)).not.toThrow();
  });
});
