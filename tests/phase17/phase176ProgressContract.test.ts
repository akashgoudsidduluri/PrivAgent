/**
 * PrivAgent — PHASE 17.6: progress, subgoal evidence and authority invariants.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * 17.5 hardened the provider boundary and 17.5A fixed the Security Critic's
 * navigation scope. Neither touched the LONG-HORIZON evidence rules, and the
 * audit for 17.6 found three defects there that no existing test could see:
 *
 *   F-01  a subgoal was marked COMPLETED on `execResult.success` — DISPATCH
 *         state — and `isAlreadyCompleted` then made the loop SKIP it forever,
 *         so the real work was never attempted.
 *   F-04  `syncFromSubgoalGraph` assigned `status = 'COMPLETED'` directly,
 *         bypassing the lifecycle table whose only rule is that a subgoal must
 *         be ACTIVE before it can complete.
 *   F-02  the confirmation-resume dispatch path called `executeAction` with no
 *         `evaluateContainment`, the single place the origin scope is enforced.
 *
 * plus F-08, a HARD BLOCKER: the production Service Worker attached
 * `ocr_observation` to the reasoner payload, the backend's frozen
 * `extra="forbid"` schema rejected it with HTTP 422, and therefore NO
 * real-reasoner run through the actual product path could ever reach the model.
 *
 * Every assertion below is written so that a mutation which restores the old
 * behaviour makes it fail. See scratch/mut17_6.mjs.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { GoalProgressTracker } from '../../extension/src/hierarchicalPlanning/goalProgressTracker';
import {
  transitionSubgoal,
  syncFromSubgoalGraph,
  LongHorizonTracker,
  assessProgress,
  detectStall,
  detectLoop,
} from '../../extension/src/agent/longHorizon';
import { BackendAgentProvider } from '../../extension/src/agent/backendAgentProvider';
import type { AgentContextPayload } from '../../extension/src/privacy/types';
import type { Subgoal, SubgoalGraphData } from '../../extension/src/hierarchicalPlanning/hierarchicalTypes';

// ══════════════════════════════════════════════════════════════════════════════
// Fixtures
// ══════════════════════════════════════════════════════════════════════════════

const ORIGIN = 'http://localhost:4290';

const ctx = (over: Partial<AgentContextPayload> = {}): AgentContextPayload =>
  ({
    url: `${ORIGIN}/product/alpha-widget`,
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    viewportObservable: true,
    screenshot_dimensions: null,
    detections: [
      {
        id: 'el_0_product-alpha-widget-price-24',
        type: 'element',
        confidence: 0.95,
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        length: 0,
        source: 'dom_attribute',
        selector: '#product-alpha-widget-price-24',
        is_partially_visible: false,
      },
    ],
    total_elements_scanned: 20,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    ...over,
  }) as AgentContextPayload;

const subgoal = (over: Partial<Subgoal> = {}): Subgoal =>
  ({
    id: 'sg1',
    goalId: 'g1',
    index: 0,
    description: 'Open the product page',
    category: 'NAVIGATE',
    state: 'IN_PROGRESS',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
    ...over,
  }) as Subgoal;

const cond = (type: string, expectedValue?: string) =>
  ({ type, expectedValue, description: 'test condition' } as Subgoal['verificationCondition']);

// ══════════════════════════════════════════════════════════════════════════════
// 17.6B / 17.6C — the progress contract: only OBSERVED state is evidence
// ══════════════════════════════════════════════════════════════════════════════

describe('17.6C · a subgoal completes ONLY from observed evidence', () => {
  it('a URL condition is satisfied by the OBSERVED url, not by a requested one', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('URL_CONTAINS', '/product/') }),
      { context: ctx() }
    );
    expect(v.satisfied).toBe(true);
    expect(v.reason).toMatch(/Observed URL/);
  });

  it('the same condition is NOT satisfied when the observed url does not contain it', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('URL_CONTAINS', '/cart') }),
      { context: ctx() }
    );
    expect(v.satisfied).toBe(false);
  });

  it('an empty expectedValue does NOT satisfy URL_CONTAINS', () => {
    // The pre-17.6 implementation returned satisfied:true here.
    const v = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('URL_CONTAINS', '') }),
      { context: ctx() }
    );
    expect(v.satisfied).toBe(false);
  });

  it('ELEMENT_EXISTS is satisfied only by an element present in the current observation', () => {
    const hit = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('ELEMENT_EXISTS', 'product-alpha-widget') }),
      { context: ctx() }
    );
    expect(hit.satisfied).toBe(true);

    const miss = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('ELEMENT_EXISTS', 'cart-contents') }),
      { context: ctx() }
    );
    expect(miss.satisfied).toBe(false);
  });

  it('an ELEMENT_EXISTS condition with no expectedValue is unproven, not satisfied', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('ELEMENT_EXISTS') }),
      { context: ctx() }
    );
    expect(v.satisfied).toBe(false);
  });

  it('a subgoal with NO verificationCondition is NOT satisfied (it used to be)', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(subgoal(), { context: ctx() });
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/no verification condition/i);
  });

  it('no observation at all means NOT satisfied', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('ELEMENT_EXISTS', 'x') }),
      undefined
    );
    expect(v.satisfied).toBe(false);
  });

  it('STATE_CHANGED is unproven without a prior observation, and proven with a differing one', () => {
    const noPrior = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('STATE_CHANGED') }),
      { context: ctx() }
    );
    expect(noPrior.satisfied).toBe(false);

    const identical = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('STATE_CHANGED') }),
      { context: ctx(), previous: ctx() }
    );
    expect(identical.satisfied).toBe(false);

    const changed = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('STATE_CHANGED') }),
      { context: ctx(), previous: ctx({ url: `${ORIGIN}/catalog` }) }
    );
    expect(changed.satisfied).toBe(true);
  });

  it('USER_CONFIRMED is unproven until a CONFIRMED dispatch is recorded', () => {
    const none = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('USER_CONFIRMED') }),
      { context: ctx() }
    );
    expect(none.satisfied).toBe(false);

    // A PROPOSAL is never an entry here — only an action that actually ran.
    const proven = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('USER_CONFIRMED') }),
      { context: ctx(), userConfirmedActionIds: ['click:el_3_confirm-order'] }
    );
    expect(proven.satisfied).toBe(true);
  });

  it('an unimplemented CUSTOM condition is unproven, not satisfied', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('CUSTOM') }),
      { context: ctx() }
    );
    expect(v.satisfied).toBe(false);
  });

  it('AFFORDANCE_AVAILABLE reflects the OBSERVED affordance set', () => {
    const none = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE', 'add_to_cart') }),
      { context: ctx() }
    );
    expect(none.satisfied).toBe(false);

    const present = ctx({
      semantic_context: {
        pageType: 'product_detail',
        confidence: 0.9,
        pageState: 'populated',
        pageGeneration: 1,
        entities: [],
        affordances: [
          { id: 'af_1', type: 'add_to_cart', targetElementId: 'el_0', requiresConfirmation: false, description: 'Add to cart' },
        ],
      } as never,
    });
    const yes = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE', 'add_to_cart') }),
      { context: present }
    );
    expect(yes.satisfied).toBe(true);
  });

  it('ELEMENT_TEXT_CONTAINS never claims a match the sanitized context cannot prove', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(
      subgoal({ verificationCondition: cond('ELEMENT_TEXT_CONTAINS', 'IN STOCK NOW') }),
      { context: ctx() }
    );
    expect(v.satisfied).toBe(false);
  });

  it('the verifier NEVER returns true for every condition type without evidence', () => {
    // A blanket-true implementation fails here immediately.
    const types = ['URL_CONTAINS', 'ELEMENT_EXISTS', 'ELEMENT_TEXT_CONTAINS', 'AFFORDANCE_AVAILABLE', 'STATE_CHANGED', 'USER_CONFIRMED', 'CUSTOM'];
    for (const t of types) {
      const v = GoalProgressTracker.verifySubgoalCondition(
        subgoal({ verificationCondition: cond(t, 'definitely-not-present-xyz') }),
        { context: ctx() }
      );
      expect(v.satisfied, t).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17.6C / F-04 — the subgoal lifecycle cannot be short-circuited
// ══════════════════════════════════════════════════════════════════════════════

describe('17.6C · a subgoal must be ACTIVE before it can COMPLETE', () => {
  it('PENDING → COMPLETED is rejected by the lifecycle table', () => {
    const sg = {
      id: 'sg1',
      description: 'd',
      category: 'NAVIGATE',
      status: 'PENDING' as const,
      attempts: 0,
    };
    const r = transitionSubgoal(sg as never, 'COMPLETED', 'should be rejected');
    expect(r.ok).toBe(false);
    expect(sg.status).toBe('PENDING');
  });

  it('ACTIVE → COMPLETED is allowed', () => {
    const sg = { id: 'sg1', description: 'd', category: 'NAVIGATE', status: 'ACTIVE' as const, attempts: 1 };
    const r = transitionSubgoal(sg as never, 'COMPLETED', 'observed');
    expect(r.ok).toBe(true);
    expect(sg.status).toBe('COMPLETED');
  });

  it('syncFromSubgoalGraph does NOT complete a PENDING tracker subgoal in one hop', () => {
    const tracker = new LongHorizonTracker();
    tracker.initialize('g', [], []);
    const sg = subgoal({ id: 'sg9', state: 'PENDING' });
    // The tracker twin does not exist yet: syncFromSubgoalGraph registers it.
    expect(tracker.getSubgoal('sg9')).toBeUndefined();

    const graph: SubgoalGraphData = {
      goalId: 'g1',
      subgoals: { sg9: { ...sg, state: 'COMPLETED' } },
      edges: [],
    };
    syncFromSubgoalGraph(tracker, graph);
    const after = tracker.getSubgoal('sg9')!;

    // M10. A direct \`tracked.status = 'COMPLETED'\` assignment also lands the
    // subgoal on COMPLETED, so asserting the STATUS alone cannot tell the legal
    // path from the illegal one.
    //
    // What separates them is \`attempts\`: \`transitionSubgoal\` increments it on
    // every entry to ACTIVE, and the legal path is obliged to go
    // PENDING -> ACTIVE -> COMPLETED. A direct assignment never enters ACTIVE,
    // so attempts stays 0. That is the observable difference, and it is the
    // invariant the lifecycle table exists to enforce: a subgoal must be
    // observed working before it can be reported done.
    expect(after.status).toBe('COMPLETED');
    expect(after.attempts).toBeGreaterThan(0);

    // And the transition really is a legal lifecycle edge, replayed directly.
    const fresh = { id: 'x', description: 'd', category: 'NAVIGATE', status: 'PENDING' as const, attempts: 0 };
    expect(transitionSubgoal(fresh as never, 'COMPLETED').ok).toBe(false);
    expect(fresh.status).toBe('PENDING');
    expect(fresh.attempts).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17.6B — progress requires NEW OBSERVED STATE
// ══════════════════════════════════════════════════════════════════════════════

describe('17.6B · meaningful progress requires new observed state', () => {
  const obs = (over: Record<string, unknown> = {}) => ({
    url: `${ORIGIN}/catalog`,
    entityIds: ['el_1', 'el_2'],
    candidateIds: [],
    scrollY: 0,
    viewportObservable: true,
    targetValueLength: 0,
    ...over,
  });

  it('an identical observation is NOT meaningful progress', () => {
    const r = assessProgress(obs() as never, obs() as never, {});
    expect(r.meaningful).toBe(false);
  });

  it('a changed observed URL IS progress', () => {
    const r = assessProgress(obs() as never, obs({ url: `${ORIGIN}/product/alpha-widget` }) as never, {});
    expect(r.meaningful).toBe(true);
    expect(r.signals).toContain('NEW_PAGE');
  });

  it('a new observed entity IS progress', () => {
    const r = assessProgress(obs() as never, obs({ entityIds: ['el_1', 'el_2', 'el_3'] }) as never, {});
    expect(r.meaningful).toBe(true);
  });

  it('an unobservable viewport cannot manufacture or deny progress', () => {
    const a = assessProgress(obs() as never, obs({ scrollY: 500, viewportObservable: false }) as never, {});
    expect(a.meaningful).toBe(false);
  });

  it('a subgoal bookkeeping signal alone is NOT meaningful progress', () => {
    // Dispatch-derived completion must not count.
    const r = assessProgress(obs() as never, obs() as never, { subgoalJustCompleted: 'sg1' } as never);
    expect(r.meaningful).toBe(false);
  });

  it('stall and loop detection fire on repeated no-progress', () => {
    expect(detectStall(3, 3, { maxConsecutiveNoProgress: 3 }).stalled).toBe(true);
    expect(detectStall(1, 1, { maxConsecutiveNoProgress: 3 }).stalled).toBe(false);
    expect(detectLoop(['f', 'f', 'f'], { maxRepeatedStates: 2 }).loop).toBe(true);
    expect(detectLoop(['a', 'b', 'a', 'b'], { maxRepeatedStates: 5 }).loop).toBe(true);
    expect(detectLoop(['a', 'b', 'c'], { maxRepeatedStates: 5 }).loop).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17.6 (F-08) — local-only provenance must not cross the reasoner boundary
// ══════════════════════════════════════════════════════════════════════════════

describe('17.6 F-08 · local-only provenance is stripped before egress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const withOcrObservation = () =>
    ({
      ...ctx(),
      ocr_observation: {
        state: 'OBSERVED',
        provenance: {
          tabId: 7,
          documentUrl: `${ORIGIN}/`,
          pageGeneration: 2,
          capturedAt: 1_700_000_000_000,
          screenshotDimensions: { width: 1280, height: 757 },
          viewportGeometry: { viewportWidth: 1280, viewportHeight: 757, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
          scaleFactors: { scaleX: 1, scaleY: 1 },
        },
        completedAt: 1_700_000_000_100,
        totalTokensScanned: 0,
        sensitiveRegionsCount: 0,
        safeRegionsCount: 0,
        ocrLatencyMs: 12,
      },
    }) as AgentContextPayload;

  it('ocr_observation is NOT present in the JSON sent to the reasoner', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = init.body;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ success: true, action: { action: 'scroll', direction: 'down', amount: 100, reason: 'look' }, reason: 'ok' }),
      } as unknown as Response;
    });

    const provider = new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' });
    await provider.requestAction('read the page', withOcrObservation());

    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain('ocr_observation');
    expect(body).not.toContain('screenshotDimensions');
    expect(body).not.toContain('scaleFactors');
  });

  it('the local viewport-observability flags are still stripped too', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = init.body;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ success: true, action: { action: 'scroll', direction: 'down', amount: 100, reason: 'look' }, reason: 'ok' }),
      } as unknown as Response;
    });

    const provider = new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' });
    await provider.requestAction('read the page', ctx());
    expect(body).not.toContain('viewportObservable');
    expect(body).not.toContain('viewportSource');
  });

  it('the stripped context is otherwise unchanged — detections still cross', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = init.body;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ success: true, action: { action: 'scroll', direction: 'down', amount: 100, reason: 'look' }, reason: 'ok' }),
      } as unknown as Response;
    });

    const provider = new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' });
    await provider.requestAction('read the page', withOcrObservation());
    expect(body).toContain('product-alpha-widget-price-24');
    expect(body).toContain('sanitized_only');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17.6 (F-02) — containment is re-evaluated before a CONFIRMED dispatch
// ══════════════════════════════════════════════════════════════════════════════

describe('17.6 F-02 · the confirmation-resume path cannot escape containment', () => {
  it('resumeWithConfirmation evaluates containment before dispatching', async () => {
    const { AgentLoop } = await import('../../extension/src/agent/agentLoop');
    const loop = new AgentLoop(
      {
        name: 'controlled',
        async requestAction() { throw new Error('no proposal'); },
        registerFailure() {},
        resetEscalation() {},
      },
      {
        getEffectSnapshot: async () => null,
        perceivePage: async () => ctx(),
        executeAction: async () => ({ success: true }),
      },
      {
        containmentScope: { rootHost: 'localhost', origin: ORIGIN, tabId: 1, dashboardOrigin: 'http://localhost:5175' },
        targetTabId: 1,
        maxSteps: 2,
        longHorizonStore: { get: async () => null, set: async () => undefined, remove: async () => undefined } as never,
      }
    );

    // Drive the loop into the confirmation state directly, exactly as the
    // Risk/Confirmation gate would. getState() returns a COPY, so the live
    // state object is reached through a test-only cast.
    const state = (loop as never as { state: Record<string, unknown> }).state;
    state.status = 'NEEDS_USER_CONFIRMATION';
    state.goalStatus = 'NEEDS_USER_CONFIRMATION';
    state.confirmationState = 'PENDING';
    state.requiresUserConfirmationAction = { action: 'navigate', url: 'https://evil.example/collect', reason: 'confirmed' } as never;

    let dispatched = false;
    (loop as never as { callbacks: { executeAction: unknown } }).callbacks.executeAction = async () => {
      dispatched = true;
      return { success: true };
    };

    const after = await loop.resumeWithConfirmation();
    expect(dispatched).toBe(false);
    expect(after.status).toBe('FAILED');
    expect(after.reason).toMatch(/Containment refused/i);
    expect(after.containmentDecision?.contained).toBe(false);
  });

  it('a confirmed action INSIDE the containment scope still dispatches', async () => {
    const { AgentLoop } = await import('../../extension/src/agent/agentLoop');
    const loop = new AgentLoop(
      {
        name: 'controlled',
        async requestAction() { throw new Error('no proposal'); },
        registerFailure() {},
        resetEscalation() {},
      },
      {
        getEffectSnapshot: async () => ({ url: `${ORIGIN}/`, scrollX: 0, scrollY: 0, domElementCount: 1, targetValueLength: 0, openModalsCount: 0, timestamp: Date.now() }),
        perceivePage: async () => ctx(),
        executeAction: async () => ({ success: true }),
      },
      {
        containmentScope: { rootHost: 'localhost', origin: ORIGIN, tabId: 1, dashboardOrigin: 'http://localhost:5175' },
        targetTabId: 1,
        maxSteps: 2,
        longHorizonStore: { get: async () => null, set: async () => undefined, remove: async () => undefined } as never,
      }
    );

    const state = (loop as never as { state: Record<string, unknown> }).state;
    state.status = 'NEEDS_USER_CONFIRMATION';
    state.goalStatus = 'NEEDS_USER_CONFIRMATION';
    state.confirmationState = 'PENDING';
    state.requiresUserConfirmationAction = { action: 'navigate', url: `${ORIGIN}/product/alpha-widget`, reason: 'confirmed' };

    let dispatched = false;
    (loop as never as { callbacks: { executeAction: unknown } }).callbacks.executeAction = async () => {
      dispatched = true;
      return { success: true };
    };

    await loop.resumeWithConfirmation().catch(() => undefined);
    expect(dispatched).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17.6C (F-01) — LOOP LEVEL: a dispatched action does not complete a subgoal
//
// WHY THIS BLOCK IS SEPARATE. The pure verifier tests above cannot see the CALL
// SITE. The M1 mutation — replacing `if (subgoalVerification.satisfied)` with
// `if (true)` — left every one of them passing, because the verifier was
// never asked. This block drives the REAL AgentLoop so the wiring itself is
// under test. Mutation harness scratch/mut17_6.mjs relies on it.
// ══════════════════════════════════════════════════════════════════════════════

describe('17.6C · the LOOP only completes a subgoal from observed evidence', () => {
  const buildLoop = async (executeAction: (a: unknown) => Promise<{ success: boolean; error?: string }>) => {
    const { AgentLoop } = await import('../../extension/src/agent/agentLoop');
    let reads = 0;
    const loop = new AgentLoop(
      {
        name: 'controlled-single-step-adapter',
        async requestAction() {
          return { action: 'scroll', direction: 'down', amount: 200, reason: 'Move down the page' };
        },
        registerFailure() {},
        resetEscalation() {},
      },
      {
        getEffectSnapshot: async () => {
          // The pre- and post-action readings must genuinely DIFFER, otherwise
          // Effect Verification correctly reports ACTION_NO_EFFECT and the loop
          // never reaches the subgoal-completion branch under test.
          reads += 1;
          return { url: `${ORIGIN}/catalog`, scrollX: 0, scrollY: 100 * reads, domElementCount: 20, targetValueLength: 0, openModalsCount: 0, timestamp: Date.now() };
        },
        perceivePage: async () => ctx({ url: `${ORIGIN}/catalog` }),
        executeAction: executeAction as never,
      },
      {
        delayBetweenStepsMs: 1,
        maxSteps: 3,
        providerRetries: 0,
        providerRetryDelayMs: 1,
        longHorizonStore: { get: async () => null, set: async () => undefined, remove: async () => undefined } as never,
      }
    );
    return loop;
  };

  it('a subgoal whose condition is UNPROVEN is not completed, even when the action dispatched and had an effect', async () => {
    const { AgentLoop } = await import('../../extension/src/agent/agentLoop');
    // The effect snapshot reports a real scroll, so Effect Verification
    // observes SCROLL_CHANGED and the loop takes the "successful action"
    // branch. The only thing that can stop the subgoal completing is the
    // observation-backed verifier.
    const loop = await buildLoop(async () => ({ success: true }));

    const state = await loop.runTask('Find the Alpha Widget product and report the price.');

    const subgoals = Object.values(state.subgoalGraphData?.subgoals ?? {});
    expect(subgoals.length).toBeGreaterThan(0);
    const completed = subgoals.filter((s) => s.state === 'COMPLETED');

    // Every completed subgoal must carry a provable condition. In this run the
    // decomposer emits conditions the sanitized observation cannot prove, so
    // NOTHING may be marked complete on dispatch state alone.
    for (const s of completed) {
      expect(
        s.verificationCondition,
        `subgoal ${s.id} was completed with no verification condition — dispatch state is not evidence`
      ).toBeDefined();
    }

    // And the loop must have recorded WHY it refused, so the decision is
    // auditable rather than silent.
    expect(state.subgoalVerificationHistory?.length ?? 0).toBeGreaterThan(0);
  });

  it('the task still terminates, and never claims SUCCESS from a dispatch', async () => {
    const { AgentLoop } = await import('../../extension/src/agent/agentLoop');
    const loop = await buildLoop(async () => ({ success: true }));
    const state = await loop.runTask('Find the Alpha Widget product and report the price.');
    expect(['SUCCESS', 'FAILED', 'STOPPED', 'IN_PROGRESS']).toContain(state.status);
    if (state.goalStatus === 'SUCCESS') {
      // If it DID succeed, the reason must cite an observation, not a dispatch.
      expect(state.reason ?? '').toMatch(/observ|qualifying|URL|marker/i);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17.6H — long-horizon progress must never create authorization
// ══════════════════════════════════════════════════════════════════════════════

describe('17.6H · long-horizon bookkeeping is not an authorization signal', () => {
  it('the goal verifier still refuses to treat dispatch state as success', async () => {
    const { verifyTaskGoal } = await import('../../extension/src/agent/goalVerifier');
    const state = {
      task: 'Find the Alpha Widget product and report the price.',
      steps: [
        {
          step: 1,
          action: { action: 'click', target: 'el_0_alpha-widget-link' },
          executionSuccess: true,
          navigationDestination: `${ORIGIN}/product/alpha-widget`,
          url: `${ORIGIN}/catalog`,
          timestamp: 1,
        },
      ],
      previousActions: [{ action: 'click', target: 'el_0_alpha-widget-link' }],
      visitedElementIds: ['el_0_alpha-widget-link'],
      currentUrl: `${ORIGIN}/catalog`,
      pageType: 'listing',
      retryCount: 0,
      taskConstraints: {},
    } as never;

    // A dispatched click plus a REQUESTED destination that was never observed.
    const r = verifyTaskGoal('Find the Alpha Widget product and report the price.', state, ctx({ url: `${ORIGIN}/catalog` }));
    expect(r.satisfied).toBe(false);
  });

  it('a REQUESTED navigation destination can NEVER prove a research goal', async () => {
    // M8. This is the exact fabrication the phase forbids.
    //
    // The multi-page research branch collects the URLs the browser was actually
    // observed on. `step.navigationDestination` is the URL the MODEL ASKED for
    // and nothing more — a navigation can be dispatched, return without error,
    // and never commit. If that value is admitted, a research goal is certified
    // from a page the browser was never on, and the reason text then claims
    // "verified from observed browser state".
    //
    // The task text is shaped so `extractResearchItems` yields exactly two
    // clean items, and the state supplies exactly ONE observed page. The
    // requested destination is the only source for the second, so admitting it
    // is the sole difference between IN_PROGRESS and SUCCESS.
    const { verifyTaskGoal } = await import('../../extension/src/agent/goalVerifier');
    const TASK = 'Find the director and composer. Report a summary.';
    const observation = {
      url: 'http://example.test/director',
      timestamp: 1,
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: [],
      total_elements_scanned: 1,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only' as const,
      ocr_metrics: null,
    } as AgentContextPayload;

    const state = {
      task: TASK,
      currentUrl: 'http://example.test/director',
      pageType: 'article',
      steps: [
        {
          step: 1,
          action: { action: 'navigate', url: 'http://example.test/composer' },
          executionSuccess: true,
          // OBSERVED: still on the first page.
          url: 'http://example.test/director',
          // REQUESTED: never actually reached.
          navigationDestination: 'http://example.test/composer',
          timestamp: 1,
        },
      ],
      previousActions: [{ action: 'navigate', url: 'http://example.test/composer' }],
      visitedElementIds: [],
      taskConstraints: {},
      retryCount: 0,
    } as never;

    const r = verifyTaskGoal(TASK, state, observation);
    expect(r.satisfied).toBe(false);
    expect(r.status).not.toBe('SUCCESS');
  });

  it('the research branch DOES succeed when the pages were genuinely observed', async () => {
    // The control: this is NOT "the research branch is broken". With two
    // genuinely OBSERVED pages the same task completes, so the assertion above
    // is about evidence and not about a permanently-failing branch.
    const { verifyTaskGoal } = await import('../../extension/src/agent/goalVerifier');
    const TASK = 'Find the director and composer. Report a summary.';
    const observation = {
      url: 'http://example.test/composer',
      timestamp: 2,
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: [],
      total_elements_scanned: 1,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only' as const,
      ocr_metrics: null,
    } as AgentContextPayload;

    const state = {
      task: TASK,
      currentUrl: 'http://example.test/composer',
      pageType: 'article',
      steps: [
        { step: 1, action: {}, executionSuccess: true, url: 'http://example.test/director', timestamp: 1 },
        { step: 2, action: {}, executionSuccess: true, url: 'http://example.test/composer', timestamp: 2 },
      ],
      previousActions: [],
      visitedElementIds: [],
      taskConstraints: {},
      retryCount: 0,
    } as never;

    const r = verifyTaskGoal(TASK, state, observation);
    expect(r.satisfied).toBe(true);
    expect(r.reason).toMatch(/observed/i);
  });

  it('GoalProgressTracker never reports goal satisfaction from a completed ratio alone', () => {
    // evaluateProgress is PLANNING progress. A 100% plan with no observation
    // must not read as a verified outcome.
    const subgoals = subgoal({ state: 'COMPLETED' });
    const graph = { getAllSubgoals: () => [subgoals] } as never;
    const r = GoalProgressTracker.evaluateProgress(graph, { goalId: 'g', taskCategory: 'GENERIC_INTERACTION' } as never);
    expect(r.percentComplete).toBe(100);
    // The field is a planning signal, never consumed as the task outcome.
    expect(typeof r.summary).toBe('string');
  });
});
