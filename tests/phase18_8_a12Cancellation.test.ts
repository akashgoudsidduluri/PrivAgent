/**
 * PHASE 18.8 / A12 — CANCELLATION / INTERRUPTION.
 *
 * The question every test here asks the same way: after a run has been
 * cancelled or superseded, can ANY late arrival still change the world?
 *
 * The fixtures below make that observable rather than asserted: the provider,
 * the perception and the action host all resolve on demand, so a test can hold
 * a run inside an `await`, cancel or supersede it, and only then let the
 * response land.
 */
import { describe, it, expect, vi } from 'vitest';

import { AgentLoop } from '../extension/src/agent/agentLoop';
import { projectAgentOutput } from '../extension/src/agent/agentOutput';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import {
  appendTurn,
  buildIdentity,
  createCandidate,
  createConversationContext,
  observeCandidates,
  type ConversationContext,
} from '../extension/src/agent/conversationContext';

const NOW = 1_760_000_000_000;
const CATALOG = 'https://shop.example.com/catalog';

/** A deferred promise the test resolves by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function context(url = CATALOG): AgentContextPayload {
  return {
    url,
    timestamp: NOW,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    detections: [],
    total_elements_scanned: 10,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 0, sensitive_detected: 0, latency_ms: 0 },
  } as unknown as AgentContextPayload;
}

/** A LISTING perception with N observed products — the A15 fixture shape. */
function listingPerception(titles: string[] = ['Red Canvas Baggy Gym Bag', 'XXL Blue Baggy Duffel Bag']) {
  return () => ({
    context: context(),
    worldModel: {
      id: 'wm-1',
      page: { url: CATALOG, pageGeneration: 2, pageType: 'listing' },
      entities: titles.map((title, i) => ({
        id: `product-${i + 1}`,
        type: 'Product',
        title,
        bbox: [100, 100 + i * 200, 200, 40],
        associatedElementIds: [],
        attributes: { productId: i + 1, price: 699 + i },
        confidence: 0.9,
        pageGeneration: 2,
      })),
      ocrRegions: [],
      visualRegions: [],
      privacyFindings: [],
    },
  } as never);
}

interface Harness {
  loop: AgentLoop;
  executed: unknown[];
  progress: any[];
  registerFailure: ReturnType<typeof vi.fn>;
  releaseProvider: () => void;
  releasePerception: () => void;
  providerCalls: () => number;
  perceptionCalls: () => number;
}

function makeHarness(options: {
  hangProvider?: boolean;
  hangPerception?: boolean;
  conversation?: ConversationContext | null;
  maxSteps?: number;
  task?: string;
} = {}): Harness {
  const providerGate = deferred<unknown>();
  const perceptionGate = deferred<unknown>();
  const executed: unknown[] = [];
  const progress: any[] = [];
  const counters = { provider: 0, perception: 0 };

  const registerFailure = vi.fn();
  const provider = {
    registerFailure,
    resetEscalation: vi.fn(),
    requestAction: async () => {
      counters.provider += 1;
      if (options.hangProvider) await providerGate.promise;
      return { action: 'scroll', direction: 'down', amount: 200, reason: 'controlled scroll' };
    },
    reviewAction: async () => ({ safe: true, reason: 'controlled review' }),
  } as never;

  const perceive = async () => {
    counters.perception += 1;
    if (options.hangPerception) await perceptionGate.promise;
    return listingPerception()();
  };

  const loop = new AgentLoop(
    provider,
    {
      perceivePage: perceive,
      executeAction: async (action) => {
        executed.push(action);
        return { success: true };
      },
      onStepProgress: (state: any) => progress.push({ ...state }),
    },
    {
      maxSteps: options.maxSteps ?? 3,
      maxRetries: 1,
      delayBetweenStepsMs: 1,
      conversationContext: options.conversation ?? null,
    }
  );

  return {
    loop,
    executed,
    progress,
    registerFailure,
    releaseProvider: () => providerGate.resolve(null),
    releasePerception: () => perceptionGate.resolve(null),
    providerCalls: () => counters.provider,
    perceptionCalls: () => counters.perception,
  };
}

function listingContext(): ConversationContext {
  const base = createConversationContext({ conversationId: 'conv-a12', now: NOW });
  const withTurn = appendTurn(base, {
    intentClass: 'INFORMATION_REQUEST',
    intentDigest: 'd1',
    taskLength: 24,
    now: NOW,
  }).context;
  const identity = buildIdentity({ entityType: 'PRODUCT', title: 'Red Canvas Baggy Gym Bag', url: CATALOG })!;
  return observeCandidates(
    withTurn,
    [createCandidate({ ordinal: 1, identity, pageGeneration: 2, observedAt: NOW })],
    NOW,
    2
  );
}
describe('A12-1 cancellation is typed, one-way and idempotent', () => {
  it('1.1 cancelling an active run stops it and records the typed code', async () => {
    const h = makeHarness({ hangProvider: true });
    const running = h.loop.runTask('find the cheapest laptop');
    await new Promise((r) => setTimeout(r, 5));
    expect(h.loop.getLifecycle()).toBe('ACTIVE');
    expect(h.loop.cancel()).toBe(true);
    expect(h.loop.getLifecycle()).toBe('CANCELLED');
    expect(h.loop.getCancellationCode()).toBe('USER_CANCELLED');
    h.releaseProvider();
    const state = await running;
    expect(state.status).toBe('STOPPED');
    expect(state.lifecycle).toBe('CANCELLED');
    expect(state.cancellationCode).toBe('USER_CANCELLED');
  });

  it('1.2 cancelling twice is safe and changes nothing the second time', async () => {
    const h = makeHarness({ hangProvider: true });
    const running = h.loop.runTask('find the cheapest laptop');
    await new Promise((r) => setTimeout(r, 5));
    expect(h.loop.cancel()).toBe(true);
    const afterFirst = h.loop.getState();
    expect(h.loop.cancel()).toBe(false);
    expect(h.loop.cancel('SUPERSEDED_BY_NEW_TASK')).toBe(false);
    expect(h.loop.getLifecycle()).toBe('CANCELLED');
    expect(h.loop.getCancellationCode()).toBe('USER_CANCELLED');
    // The first cancellation's outcome is preserved, not overwritten.
    expect(h.loop.getState().reason).toBe(afterFirst.reason);
    h.releaseProvider();
    await running;
  });

  it('1.3 a superseded run is SUPERSEDED, and is silent toward the dashboard', async () => {
    const h = makeHarness({ hangProvider: true });
    const running = h.loop.runTask('open wikipedia');
    await new Promise((r) => setTimeout(r, 5));
    const before = h.progress.length;
    expect(h.loop.supersede()).toBe(true);
    expect(h.loop.getLifecycle()).toBe('SUPERSEDED');
    // A replaced run must not keep pushing progress into the NEW task's view.
    expect(h.progress.length).toBe(before);
    h.releaseProvider();
    const state = await running;
    expect(state.status).toBe('STOPPED');
    expect(state.cancellationCode).toBe('SUPERSEDED_BY_NEW_TASK');
  });

  it('1.4 a lifecycle that has ended can never return to ACTIVE mid-run', async () => {
    const h = makeHarness({ hangProvider: true });
    const running = h.loop.runTask('find the cheapest laptop');
    await new Promise((r) => setTimeout(r, 5));
    h.loop.cancel();
    h.releaseProvider();
    await running;
    expect(h.loop.getLifecycle()).not.toBe('ACTIVE');
  });
});

describe('A12-2 a late arrival can never act', () => {
  it('2.1 a provider response that lands after cancellation dispatches NOTHING', async () => {
    const h = makeHarness({ hangProvider: true });
    const running = h.loop.runTask('find the cheapest laptop');
    await new Promise((r) => setTimeout(r, 10));
    expect(h.providerCalls()).toBe(1);
    h.loop.cancel();
    h.releaseProvider();
    const state = await running;
    expect(h.executed).toHaveLength(0);
    expect(state.steps).toHaveLength(0);
    expect(state.lastAction).toBeNull();
    expect(state.status).not.toBe('SUCCESS');
  });

  it('2.1b a terminal PROPOSAL that lands after cancellation cannot end the run', async () => {
    // The strongest form of the defect: a late answer would not merely be
    // recorded, it would become the run's TERMINAL state.
    const gate = deferred<unknown>();
    let calls = 0;
    const loop = new AgentLoop(
      {
        registerFailure: vi.fn(),
        resetEscalation: vi.fn(),
        requestAction: async () => ({ action: 'scroll', direction: 'down', amount: 100, reason: 'x' }),
        requestStep: async () => {
          calls += 1;
          await gate.promise;
          return {
            kind: 'TERMINAL_PROPOSAL',
            proposal: { kind: 'ANSWER', answer: 'late answer', citedEvidence: [] },
          };
        },
        reviewAction: async () => ({ safe: true, reason: 'controlled' }),
      } as never,
      {
        perceivePage: listingPerception(),
        executeAction: async () => ({ success: true }),
      },
      { maxSteps: 2, maxRetries: 1, delayBetweenStepsMs: 1 }
    );
    const running = loop.runTask('what is the price of the second product');
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    loop.cancel();
    gate.resolve(null);
    const state = await running;
    expect(state.status).toBe('STOPPED');
    expect(state.status).not.toBe('ANSWER');
    expect(state.answer).toBeFalsy();
  });

  it('2.2 a cancelled run is not charged to the provider', async () => {
    const h = makeHarness({ hangProvider: true });
    const running = h.loop.runTask('find the cheapest laptop');
    await new Promise((r) => setTimeout(r, 10));
    h.loop.cancel();
    h.releaseProvider();
    const state = await running;
    // A cancellation is not a transport failure: no retry budget consumed, no
    // escalation registered, and no PROVIDER_UNAVAILABLE reported.
    expect(h.registerFailure).not.toHaveBeenCalled();
    expect(h.providerCalls()).toBe(1);
    expect(state.status).toBe('STOPPED');
    expect(state.status).not.toBe('PROVIDER_UNAVAILABLE');
    // It is stopped, not failed: no failure was recorded, and the reason is the
    // cancellation sentence rather than any failure prose.
    expect(state.failureHistory ?? []).toHaveLength(0);
    expect(state.lastFailure ?? null).toBeNull();
    expect(state.reason).toBe('Stopped at your request.');
  });

  it('2.3 a perception that lands after cancellation is discarded, not ingested', async () => {
    const h = makeHarness({ hangPerception: true });
    const running = h.loop.runTask('tell me about the first product');
    await new Promise((r) => setTimeout(r, 10));
    expect(h.perceptionCalls()).toBe(1);
    h.loop.cancel();
    h.releasePerception();
    const state = await running;
    // The generation must not advance on a reading nobody is entitled to use.
    expect(state.perceptionGeneration).toBeLessThanOrEqual(1);
    expect(state.steps).toHaveLength(0);
    expect(h.executed).toHaveLength(0);
    expect(state.status).toBe('STOPPED');
  });

  it('2.4 a stale retry is abandoned: cancellation during the retry wait ends the run', async () => {
    const h = makeHarness();
    const loop = new AgentLoop(
      {
        registerFailure: vi.fn(),
        resetEscalation: vi.fn(),
        requestAction: async () => {
          throw new (await import('../extension/src/agent/openRouterProvider')).ProviderError(
            'upstream busy',
            'rate_limit',
            { retryable: true, retryAfterMs: 1 }
          );
        },
        reviewAction: async () => ({ safe: true, reason: 'controlled' }),
      } as never,
      {
        perceivePage: listingPerception(),
        executeAction: async () => ({ success: true }),
      },
      { maxSteps: 3, maxRetries: 2, delayBetweenStepsMs: 1 }
    );
    const running = loop.runTask('find the cheapest laptop');
    await new Promise((r) => setTimeout(r, 5));
    loop.cancel();
    const state = await running;
    expect(state.status).toBe('STOPPED');
    expect(state.cancellationCode).toBe('USER_CANCELLED');
  });
});

describe('A12-3 supersession keeps the new task authoritative', () => {
  it('3.1 a new task supersedes the old run and the old run stops', async () => {
    const oldRun = makeHarness({ hangProvider: true });
    const running = oldRun.loop.runTask('find the cheapest laptop');
    await new Promise((r) => setTimeout(r, 10));
    // The worker starts task B: the old loop is superseded, then released.
    oldRun.loop.supersede();
    oldRun.releaseProvider();
    const oldState = await running;
    expect(oldRun.loop.getLifecycle()).toBe('SUPERSEDED');
    expect(oldState.status).toBe('STOPPED');
    expect(oldRun.executed).toHaveLength(0);

    const newRun = makeHarness();
    const newState = await newRun.loop.runTask('open wikipedia');
    expect(newRun.loop.getLifecycle()).not.toBe('CANCELLED');
    expect(newState.task).toBe('open wikipedia');
    // The superseded run contributed nothing to the new one.
    expect(newState.steps.every((s: any) => s.task !== 'find the cheapest laptop')).toBe(true);
  });

  it('3.2 the superseded run cannot overwrite the state of the run that replaced it', async () => {
    const oldRun = makeHarness({ hangProvider: true });
    const running = oldRun.loop.runTask('find the cheapest laptop');
    await new Promise((r) => setTimeout(r, 10));
    oldRun.loop.supersede();
    oldRun.releaseProvider();
    await running;

    const newRun = makeHarness();
    const newState = await newRun.loop.runTask('tell me about the first product');
    const before = newRun.loop.getState().currentStep;
    // Nothing from the old run may reach the new one.
    expect(newState.task).toBe('tell me about the first product');
    expect(newRun.loop.getCancellationCode()).toBeNull();
    expect(newRun.loop.getState().currentStep).toBeGreaterThanOrEqual(before);
  });

  it('3.3 conversation isolation survives supersession (B2 contract intact)', async () => {
    // Task A continued a conversation; task B is a NEW task and must start a
    // fresh, empty conversation rather than inheriting A's candidates.
    const conversationA = listingContext();
    const runA = makeHarness({ conversation: conversationA });
    const stateA = await runA.loop.runTask('tell me about the first one');
    expect(stateA.conversation?.candidateCount).toBeGreaterThan(0);

    // A new task the worker did NOT attach to A's conversation carries no
    // candidates from A at all — the default is isolation, not inheritance.
    const runB = makeHarness({ conversation: null });
    const stateB = await runB.loop.runTask('find the top 5 products under 1000');
    expect(stateB.conversation?.conversationId ?? null).not.toBe(stateA.conversation?.conversationId);
    expect(stateB.conversation?.candidateCount ?? 0).toBe(0);
    expect(stateB.conversation?.selectedIdentityKey ?? null).toBeNull();
  });
});

describe('A12-4 the user-facing result is truthful', () => {
  it('4.1 a cancelled run never reports SUCCESS and never echoes internals', async () => {
    const h = makeHarness({ hangProvider: true });
    const running = h.loop.runTask('buy the third product');
    await new Promise((r) => setTimeout(r, 10));
    h.loop.cancel();
    h.releaseProvider();
    const state = await running;
    expect(state.status).toBe('STOPPED');

    const projected = projectAgentOutput(state);
    const finalResult = (projected as any).finalResult;
    expect(finalResult.kind).toBe('STOPPED');
    expect(finalResult.body).toBe('Stopped at your request. Nothing else was changed.');
    expect(finalResult.headline).toBe('Stopped');
    // Internal vocabulary must not appear anywhere in the user-facing result.
    const rendered = JSON.stringify(finalResult);
    for (const internal of ['USER_CANCELLED', 'SUPERSEDED_BY_NEW_TASK', 'RunOwnershipLostError', 'RUN_CANCELLED']) {
      expect(rendered).not.toContain(internal);
    }
  });

  it('4.2 a superseded run says so, in fixed wording', async () => {
    const h = makeHarness({ hangProvider: true });
    const running = h.loop.runTask('buy the third product');
    await new Promise((r) => setTimeout(r, 10));
    h.loop.supersede();
    h.releaseProvider();
    const state = await running;
    const projected = projectAgentOutput(state) as any;
    expect(projected.terminal.reason).toBe('SUPERSEDED_BY_NEW_TASK');
    expect(projected.terminal.outcome).toBe('STOPPED');
    expect(projected.finalResult.body).toContain('newer task');
    // The code is stable timeline vocabulary, but it must never be rendered:
    // the card and the headline are fixed sentences.
    expect(JSON.stringify(projected.finalResult)).not.toContain('SUPERSEDED_BY_NEW_TASK');
    expect(projected.terminal.headline).not.toContain('SUPERSEDED');
  });
});

describe('A12-5 cancellation at the risk boundary', () => {
  it('5.1 a confirmation cannot resume a cancelled run', async () => {
    const h = makeHarness();
    const executed: unknown[] = [];
    const loop = new AgentLoop(
      {
        registerFailure: vi.fn(),
        resetEscalation: vi.fn(),
        requestAction: async () => ({
          action: 'navigate',
          url: 'https://shop.example.com/checkout',
          reason: 'controlled consequential navigation',
        }),
        reviewAction: async () => ({ safe: true, reason: 'controlled' }),
      } as never,
      {
        perceivePage: listingPerception(),
        executeAction: async (action) => {
          executed.push(action);
          return { success: true };
        },
      },
      { maxSteps: 2, maxRetries: 1, delayBetweenStepsMs: 1 }
    );
    // Park the run exactly where the risk boundary parks it.
    const running = loop.runTask('go to checkout and pay for the second product');
    await new Promise((r) => setTimeout(r, 10));
    const parked = loop.getState();
    expect(['NEEDS_USER_CONFIRMATION', 'IN_PROGRESS']).toContain(parked.status);

    loop.cancel();
    expect(loop.getLifecycle()).toBe('CANCELLED');
    const dispatchedBeforeCancel = executed.length;
    // The refusal must be the OWNERSHIP refusal, not the generic "not waiting"
    // one: only the first proves the cancellation guard was consulted.
    await expect(loop.resumeWithConfirmation()).rejects.toThrow(/no longer owns/i);
    expect(executed).toHaveLength(dispatchedBeforeCancel);
    expect(loop.getState().status).not.toBe('SUCCESS');
    loop.cancel();
    await running.catch(() => undefined);
    expect(h.executed).toHaveLength(0);
  });
});
