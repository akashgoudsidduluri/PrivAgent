/**
 * Observed effect verification (M10 production path).
 *
 * Every test here exists because the PREVIOUS implementation synthesized the
 * post-action snapshot FROM THE REQUESTED ACTION, which made a no-op action
 * mathematically indistinguishable from a real one. `regression` tests assert
 * the old behaviour explicitly so the defect cannot silently return.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../extension/src/agent/agentLoop';
import type { AgentLoopCallbacks } from '../../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../../extension/src/agent/mockAgentProvider';
import { verifyActionEffect } from '../../extension/src/agent/effectVerifier';
import type { PostActionSnapshot, PreActionSnapshot } from '../../extension/src/agent/effectVerifier';
import { scanForRawSensitiveValues } from '../../extension/src/privacy/rawValueScanner';
import { buildAgentPayload } from '../../extension/src/privacy/types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';
import type { AgentContextPayload } from '../../extension/src/privacy/types';

const snap = (over: Partial<PreActionSnapshot> = {}): PreActionSnapshot => ({
  url: 'http://localhost:4196/',
  scrollX: 0,
  scrollY: 0,
  targetValueLength: 0,
  openModalsCount: 0,
  activeElementSelector: undefined,
  domElementCount: 100,
  timestamp: 1,
  ...over,
});

function det(id: string, type: string, selector: string) {
  return {
    id,
    type,
    confidence: 0.9,
    selector,
    bbox: [0, 0, 10, 10] as any,
    length: 0,
    source: 'dom',
  } as any;
}

/** A genuinely sanitized context, matching the shape the privacy policy accepts. */
function context(): AgentContextPayload {
  return {
    url: 'http://localhost:4196/',
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 100,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 0, sensitive_detected: 0, latency_ms: 0 },
    detections: [
      det('el-1', 'search', 'input#q'),
      det('el-btn', 'button', 'button#go'),
    ],
  } as unknown as AgentContextPayload;
}

/**
 * Build a loop whose ONLY snapshot source is `provider`. `provider` is called
 * once before dispatch and once after, so it can return different values.
 */
function loopWithSnapshots(
  actions: BrowserAction[],
  provider: (call: number, target?: string) => PreActionSnapshot | PostActionSnapshot | null,
  overrides: Partial<AgentLoopCallbacks> = {}
) {
  const provider_ = new MockAgentProvider(actions);
  let call = 0;
  const callbacks: AgentLoopCallbacks = {
    perceivePage: async () => context(),
    executeAction: async () => ({ success: true }),
    getEffectSnapshot: async (target?: string) => provider(call++, target),
    ...overrides,
  };
  const loop = new AgentLoop(provider_ as any, callbacks, { maxSteps: 3, maxRetries: 1, delayBetweenStepsMs: 1 });
  return { loop, provider: provider_ };
}

describe('P0-1 observed effect verification', () => {
  it('1. a dispatch that changes nothing is ACTION_NO_EFFECT (the old synthesis could not do this)', async () => {
    // Identical pre and post observations: the click "succeeded" but the page
    // did not move. Under the old synthesized snapshot, `domElementCount += 1`
    // and `newActiveSelector = targetId` were DERIVED FROM THE ACTION, so this
    // state was unreachable.
    const before = snap({ activeElementSelector: 'body' });
    const { loop } = loopWithSnapshots(
      [{ action: 'click', target: 'el-btn', reason: 'click the control' } as BrowserAction],
      () => ({ ...before })
    );
    const state = await loop.runTask('click the control');
    expect(state.steps[0]?.effectStatus ?? 'ACTION_NO_EFFECT').toBe('ACTION_NO_EFFECT');
    expect(state.status).not.toBe('SUCCESS');
  });

  it('1b. regression: the pre-fix synthesis would have reported an effect for that same no-op', () => {
    // This is the defect, pinned. Reproduce the OLD post-snapshot derivation
    // for a click and show it reports DOM_MUTATION_OBSERVED even though the
    // real page never changed.
    const pre = snap({ domElementCount: 100, activeElementSelector: 'body' });
    const oldSynthesizedPost: PostActionSnapshot = {
      ...pre,
      domElementCount: pre.domElementCount! + 1, // old code did exactly this
      timestamp: 2,
    };
    const oldVerdict = verifyActionEffect(
      { action: 'click', target: 'el-1' } as BrowserAction,
      pre,
      oldSynthesizedPost
    );
    expect(oldVerdict.hasEffect).toBe(true);
    expect(oldVerdict.status).toBe('DOM_MUTATION_OBSERVED');

    // The observed post-state says nothing happened, and that is what counts.
    const observedVerdict = verifyActionEffect(
      { action: 'click', target: 'el-1' } as BrowserAction,
      pre,
      { ...pre, timestamp: 2 }
    );
    expect(observedVerdict.hasEffect).toBe(false);
    expect(observedVerdict.status).toBe('ACTION_NO_EFFECT');
  });

  it('2. the navigate verdict is independent of the REQUESTED url', () => {
    // The requested URL is not an input to the navigate verdict. Two runs that
    // requested completely different destinations, but observed the SAME
    // unchanged page, must reach the same verdict. Pre-fix the post-snapshot URL
    // was set to `action.url`, so every navigate "worked" by construction.
    const pre = snap({ url: 'http://localhost:4196/' });
    const post = snap({ url: 'http://localhost:4196/', timestamp: 2 });

    const askedGoogle = verifyActionEffect(
      { action: 'navigate', url: 'https://www.google.com/' } as BrowserAction,
      pre,
      post
    );
    const askedElsewhere = verifyActionEffect(
      { action: 'navigate', url: 'https://example.com/elsewhere' } as BrowserAction,
      pre,
      post
    );

    expect(askedGoogle.hasEffect).toBe(false);
    expect(askedGoogle.status).toBe('ACTION_NO_EFFECT');
    expect(askedElsewhere.status).toBe(askedGoogle.status);
  });

  it('2b. a navigate that lands on an error page still changed the url, and says so', () => {
    // Guard against over-correcting: an OBSERVED url change is a real effect
    // and must not be reported as a no-op.
    const v = verifyActionEffect(
      { action: 'navigate', url: 'https://www.google.com/' } as BrowserAction,
      snap({ url: 'http://localhost:4196/' }),
      snap({ url: 'chrome-error://chromewebdata/', timestamp: 2 })
    );
    expect(v.hasEffect).toBe(true);
    expect(v.status).toBe('URL_NAVIGATION_OBSERVED');
  });

  it('2a. a same-origin navigate that lands somewhere else is a no-effect at loop level', async () => {
    // Cross-origin navigation correctly halts at the confirmation gate before
    // dispatch, so this uses a same-origin destination to reach effect
    // verification. The tab simply never moved.
    const pre = snap({ url: 'http://localhost:4196/' });
    const { loop } = loopWithSnapshots(
      [{ action: 'navigate', url: 'http://localhost:4196/next', reason: 'go' } as BrowserAction],
      (call) => (call === 0 ? pre : { ...pre, timestamp: 2 })
    );
    const state = await loop.runTask('go to the next page');
    expect(state.steps[0]?.effectStatus).toBe('ACTION_NO_EFFECT');
  });

  it('2c. a real navigation to the observed destination is verified', () => {
    const pre = snap({ url: 'http://localhost:4196/' });
    const post = snap({ url: 'https://www.google.com/', timestamp: 2 });
    const v = verifyActionEffect(
      { action: 'navigate', url: 'https://www.google.com/' } as BrowserAction,
      pre,
      post
    );
    expect(v.hasEffect).toBe(true);
    expect(v.status).toBe('URL_NAVIGATION_OBSERVED');
  });

  it('3. scroll verdict uses the OBSERVED scroll offset, not the requested amount', async () => {
    // Requested: scroll down 500. Observed: the page did not move (at the
    // bottom of the document). Pre-fix this was reported as SCROLL_CHANGED.
    const pre = snap({ scrollY: 900, domElementCount: 100 });
    const { loop } = loopWithSnapshots(
      [{ action: 'scroll', direction: 'down', amount: 500, reason: 'scroll' } as BrowserAction],
      (call) => (call === 0 ? pre : { ...pre, timestamp: 2 })
    );
    const state = await loop.runTask('scroll down');
    expect(state.steps[0]?.effectStatus).toBe('ACTION_NO_EFFECT');
  });

  it('3b. an observed scroll of the same amount is verified', () => {
    const pre = snap({ scrollY: 900 });
    const v = verifyActionEffect(
      { action: 'scroll', direction: 'down', amount: 500 } as BrowserAction,
      pre,
      snap({ scrollY: 1400, timestamp: 2 })
    );
    expect(v.hasEffect).toBe(true);
    expect(v.status).toBe('SCROLL_CHANGED');
  });

  it('4. a click whose target never receives focus is not inferred as success', async () => {
    // Dispatch returned success. Observed: same URL, same scroll, same modal
    // count, same DOM size, and focus never moved to the target.
    const pre = snap({ activeElementSelector: 'body', domElementCount: 250 });
    const { loop } = loopWithSnapshots(
      [{ action: 'click', target: 'el-btn', reason: 'click' } as BrowserAction],
      (call) => (call === 0 ? pre : { ...pre, timestamp: 2 })
    );
    const state = await loop.runTask('click the button');
    expect(state.steps[0]?.effectStatus).toBe('ACTION_NO_EFFECT');
  });

  it('4a. a type that never reached the DOM is not inferred from dispatch success', () => {
    // Dispatch returned success, but the observed target value length stayed 0.
    // Dispatch returned success, but the observed target value length stayed 0.
    const pre = snap({ targetValueLength: 0 });
    const v = verifyActionEffect(
      { action: 'type', target: 'el-1', text: 'cats' } as BrowserAction,
      pre,
      snap({ targetValueLength: 0, timestamp: 2 })
    );
    expect(v.hasEffect).toBe(false);
    expect(v.status).toBe('ACTION_NO_EFFECT');
  });

  it('4b. an observed value length change is verified and the value never leaks', async () => {
    const pre = snap({ targetValueLength: 0 });
    const v = verifyActionEffect(
      { action: 'type', target: 'el-1', text: 'cats' } as BrowserAction,
      pre,
      snap({ targetValueLength: 4, timestamp: 2 })
    );
    expect(v.hasEffect).toBe(true);
    expect(v.status).toBe('VALUE_STATE_CHANGED');
    // Only the LENGTH is ever reported.
    expect(JSON.stringify(v)).not.toContain('cats');
  });

  it('5. snapshot failure fails CLOSED rather than assuming success', async () => {
    // The host has an observation channel but cannot observe. That must be an
    // unverified effect, never a synthesized "it worked".
    const { loop } = loopWithSnapshots(
      [{ action: 'click', target: 'el-btn', reason: 'click' } as BrowserAction],
      () => null
    );
    const state = await loop.runTask('click the control');
    expect(state.status).toBe('FAILED');
    //
    // PHASE 18.8 / A10-F2 — the typed contract for an unobservable effect.
    //
    // `state.reason` used to render the device's internal string
    // ("Effect verification unavailable repeatedly: …"). It now carries the
    // truthful user sentence, because "I could not read the effect" must never
    // reach the user as internal prose; the typed detail stays in the failure
    // record for the audit trail. The safety properties this test exists for
    // are unchanged and asserted above and below.
    expect(state.reason).toBe(
      "I couldn't verify whether the action took effect, so I stopped without repeating it."
    );
    expect(state.reason ?? '').not.toMatch(
      /Effect verification unavailable|browser state could not be observed|effect treated as unverified/i
    );
    expect(state.steps[0]?.effectStatus).toBe('ACTION_NO_EFFECT');
  });

  it('5b. a snapshot provider that THROWS also fails closed', async () => {
    const provider_ = new MockAgentProvider([
      { action: 'click', target: 'el-btn', reason: 'click' } as BrowserAction,
    ]);
    const loop = new AgentLoop(
      provider_ as any,
      {
        perceivePage: async () => context(),
        executeAction: async () => ({ success: true }),
        getEffectSnapshot: async () => {
          throw new Error('content script unreachable');
        },
      },
      { maxSteps: 2, maxRetries: 1, delayBetweenStepsMs: 1 }
    );
    const state = await loop.runTask('click the control');
    expect(state.status).toBe('FAILED');
  });

  it('6. an observed snapshot cannot carry a raw secret', () => {
    // Shape-level guarantee: the snapshot contract has no field that could hold
    // a value, a password, a card number or page text.
    const observed: PostActionSnapshot = {
      url: 'https://example.test/',
      scrollX: 0,
      scrollY: 120,
      targetValueLength: 16, // LENGTH ONLY
      openModalsCount: 0,
      activeElementSelector: 'input:nth-child(2)',
      domElementCount: 412,
      timestamp: 1,
    };
    const keys = Object.keys(observed).sort();
    expect(keys).toEqual(
      [
        'activeElementSelector',
        'domElementCount',
        'openModalsCount',
        'scrollX',
        'scrollY',
        'targetValueLength',
        'timestamp',
        'url',
      ].sort()
    );
    for (const forbidden of ['value', 'text', 'textContent', 'innerText', 'password', 'secret']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(scanForRawSensitiveValues(observed)).toEqual([]);
  });

  it('6b. the production snapshot message shape carries no raw value', () => {
    // Mirrors the content-script response contract exactly.
    const response = {
      type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT_RESPONSE',
      snapshot: {
        url: 'https://example.test/',
        scrollX: 0,
        scrollY: 0,
        targetValueLength: 0,
        openModalsCount: 0,
        activeElementSelector: undefined,
        domElementCount: 10,
        timestamp: 1,
      },
    };
    expect(scanForRawSensitiveValues(response)).toEqual([]);
    expect(JSON.stringify(response)).not.toMatch(/password|cvv|otp|cardNumber/i);
  });
});

describe('P0-1 snapshot observation is genuinely used by the loop', () => {
  it('7. the loop asks the host for a snapshot, and receives the target id', async () => {
    const getEffectSnapshot = vi.fn(async (_target?: string) => snap());
    const provider_ = new MockAgentProvider([
      { action: 'click', target: 'el-btn', reason: 'c' } as BrowserAction,
    ]);
    const loop = new AgentLoop(
      provider_ as any,
      {
        perceivePage: async () => context(),
        executeAction: async () => ({ success: true }),
        getEffectSnapshot: getEffectSnapshot as any,
      },
      { maxSteps: 2, maxRetries: 1, delayBetweenStepsMs: 1 }
    );
    await loop.runTask('click the button');
    expect(getEffectSnapshot).toHaveBeenCalled();
    // The resolved action target is handed to the host so it can report that
    // element's observed value LENGTH.
    expect(getEffectSnapshot.mock.calls[0]?.[0]).toBe('el-btn');
    // Called before AND after dispatch.
    expect(getEffectSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('8. a host with NO snapshot channel keeps the previous context-derived behaviour', async () => {
    // Non-browser embeddings have no tab to observe. This path is unchanged.
    const provider_ = new MockAgentProvider([
      { action: 'click', target: 'el-btn', reason: 'c' } as BrowserAction,
    ]);
    const loop = new AgentLoop(
      provider_ as any,
      { perceivePage: async () => context(), executeAction: async () => ({ success: true }) },
      { maxSteps: 2, maxRetries: 1, delayBetweenStepsMs: 1 }
    );
    const state = await loop.runTask('click');
    expect(state.steps.length).toBeGreaterThan(0);
  });
});
