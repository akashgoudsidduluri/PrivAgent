/**
 * POST-17.9 — PAGE-GENERATION LIFECYCLE / STALE WORLD MODEL GUARD.
 *
 * THE DEFECT THIS PINS
 *
 * `AgentLoop` anchors `state.currentPageGeneration` to the generation the
 * content script actually reported (`worldModel.page.pageGeneration`), and the
 * stale-world-model guard in `normalizePerceptionResult` refuses a model whose
 * generation is below that anchor (`liveGeneration < localGeneration`).
 *
 * The ACTION_NO_EFFECT recovery path used to call `advancePageGeneration` TWICE
 * for a single mandatory re-perception: once on entering recovery and once after
 * the fresh perception. Each call bumped the counter, so the loop advanced three
 * generation steps (two recovery bumps plus the next cycle's bump) for two
 * content-script world-model builds. The counter therefore ran AHEAD of the
 * page, and the next genuinely fresh world model was refused as stale:
 *
 *     [AgentLoop] rejecting stale world model before attachment
 *     { localGeneration: 11, worldModelGeneration: 10 }
 *     → "Perception failed: Unable to obtain sanitized page context."
 *
 * Reproduced live, 5/5, against the real reasoner and real Chrome. The refusal
 * is fail-closed, but it is a FALSE POSITIVE — the model was the freshest one
 * the page had, and the task aborted before Goal Verification was consulted.
 *
 * WHAT IS FIXED
 *
 * The recovery path now invalidates the failed generation without advancing the
 * counter (`invalidatePageGenerationState`), and re-anchors the counter to the
 * generation the fresh perception OBSERVED. The guard itself is byte-for-byte
 * unchanged: a model older than the last observed generation is still refused.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import {
  createAgentTaskState,
  advancePageGeneration,
  invalidatePageGenerationState,
} from '../extension/src/agent/agentState';
import { verifyTaskGoal } from '../extension/src/agent/goalVerifier';
import { observingHost } from './helpers/observingHost';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const TASK = 'Open the catalog and report the price on the product page';
const PAGE = 'http://localhost:4291/catalog';

const contextAt = (url: string): AgentContextPayload =>
  ({
    sanitized_status: 'sanitized_only',
    detections: [],
    url,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    total_elements_scanned: 1,
    sensitive_elements_detected: 0,
    ocr_metrics: null,
    timestamp: 1,
  }) as unknown as AgentContextPayload;

const worldModel = (generation: number) =>
  buildBrowserWorldModel({ root: document, pageGeneration: generation, id: `wm-g${generation}` });

const perceptionFor = (generation: number) => ({
  context: contextAt(`${PAGE}#g${generation}`),
  worldModel: worldModel(generation),
  activeWorldModelRef: { pageGeneration: generation, worldModelId: `wm-g${generation}` },
});

const normalize = (loop: AgentLoop, generation: number) =>
  (loop as any).normalizePerceptionResult(perceptionFor(generation));

const SCROLL: BrowserAction = {
  action: 'scroll',
  direction: 'down',
  amount: 300,
  reason: 'reveal the price',
} as BrowserAction;

afterEach(() => {
  vi.restoreAllMocks();
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A. The two generation operations are now separable
 * ═════════════════════════════════════════════════════════════════════════ */

describe('post-17.9 generation lifecycle — invalidation vs. advance', () => {
  const seeded = () => {
    const state = createAgentTaskState('task', { currentUrl: PAGE });
    state.currentPageGeneration = 7;
    state.perceptionGeneration = 7;
    state.visitedElementIds = ['el-old'];
    state.activeWorldModelRef = { pageGeneration: 7, worldModelId: 'wm-g7' };
    return state;
  };

  it('invalidatePageGenerationState clears generation-derived state WITHOUT advancing the counter', () => {
    const state = seeded();

    invalidatePageGenerationState(state);

    // The invalidation really happened: nothing from generation 7 is reusable.
    expect(state.visitedElementIds).toEqual([]);
    expect(state.activeWorldModelRef).toBeNull();
    // ...and the counter still points at the generation the page reported.
    expect(state.currentPageGeneration).toBe(7);
    expect(state.perceptionGeneration).toBe(7);
  });

  it('advancePageGeneration keeps its existing contract (counter advances, state cleared)', () => {
    const state = seeded();

    advancePageGeneration(state, 'http://localhost:4291/catalog', 'listing');

    expect(state.currentPageGeneration).toBe(8);
    expect(state.perceptionGeneration).toBe(8);
    expect(state.currentUrl).toBe('http://localhost:4291/catalog');
    expect(state.pageType).toBe('listing');
    expect(state.visitedElementIds).toEqual([]);
    expect(state.activeWorldModelRef).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * B. The stale-world-model guard is UNCHANGED — no weakening
 * ═════════════════════════════════════════════════════════════════════════ */

describe('post-17.9 generation lifecycle — the guard still fails closed', () => {
  const loopAt = (localGeneration: number) => {
    const loop = new AgentLoop(new MockAgentProvider(), {
      perceivePage: vi.fn(async () => null),
      executeAction: vi.fn(async () => ({ success: true })),
    }, { maxSteps: 1, delayBetweenStepsMs: 1 });
    (loop as any).state.currentPageGeneration = localGeneration;
    (loop as any).state.perceptionGeneration = localGeneration;
    return loop;
  };

  it('1. a world model from an EARLIER page generation is rejected', () => {
    expect(normalize(loopAt(5), 3)).toBeNull();
  });

  it('1b. an earlier-generation model is still rejected after a generation advance (navigation)', () => {
    const loop = loopAt(3);
    const state = (loop as any).state;
    advancePageGeneration(state, 'http://localhost:4291/product/a');
    // The perception cycle bumps the counter before observing, exactly as the loop does.
    state.perceptionGeneration += 1;
    state.currentPageGeneration = state.perceptionGeneration;

    // Generation 3 belongs to the pre-navigation document.
    expect(normalize(loop, 3)).toBeNull();
  });

  it('2. a fresh model for the NEW page generation is accepted', () => {
    expect(normalize(loopAt(5), 5)).not.toBeNull();
  });

  it('3. a same-document observation at the current generation is accepted', () => {
    const loop = loopAt(9);
    const normalized = normalize(loop, 9);
    expect(normalized).not.toBeNull();
    expect(normalized!.activeWorldModelRef).toEqual({ pageGeneration: 9, worldModelId: 'wm-g9' });
  });

  it('5. a model whose reference and payload generations disagree is rejected', () => {
    const loop = loopAt(4);
    expect(
      (loop as any).normalizePerceptionResult({
        context: contextAt(PAGE),
        worldModel: worldModel(4),
        activeWorldModelRef: { pageGeneration: 3, worldModelId: 'wm-g4' },
      })
    ).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C. The regression: recovery must not drift the counter ahead of the page
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * A loop whose every action is a scroll the browser reports as a no-op, so the
 * loop is guaranteed to walk the ACTION_NO_EFFECT recovery path.
 *
 * `perceivePage(callIndex)` returns what the page reports for that perception,
 * so a fixture can make the page counter behave the way the real content script
 * does (a fresh world model per scan request) or fail a specific call.
 */
const noEffectLoop = (perceivePage: (callIndex: number) => unknown, maxSteps = 4) => {
  const provider = new MockAgentProvider();
  provider.setCustomHandler(() => SCROLL);
  const executeAction = vi.fn(async () => ({ success: true }));
  const frozen = { url: PAGE, domElementCount: 10, scrollY: 0 };
  let callIndex = 0;
  const loop = new AgentLoop(
    provider,
    {
      perceivePage: vi.fn(async () => perceivePage(callIndex++)) as any,
      executeAction,
      // Identical pre/post readings: the dispatch changed nothing.
      getEffectSnapshot: observingHost(() => frozen),
    },
    { maxSteps, maxRetries: 1, delayBetweenStepsMs: 1 }
  );
  return { loop, executeAction, perceptionCalls: () => callIndex };
};

const staleModelWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.filter((c) => String(c[0]).includes('stale world model'));

describe('post-17.9 generation lifecycle — ACTION_NO_EFFECT recovery', () => {
  it('6. the counter never runs ahead of the newest generation the page reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Every perception reports a strictly newer generation, as the real content
    // script does (it builds a fresh world model per scan request).
    const { loop, perceptionCalls } = noEffectLoop((n) => perceptionFor(3 + n));

    const state = await loop.runTask(TASK);
    const calls = perceptionCalls();

    // The defect: the counter drifted above the page's own generation, so the
    // next fresh model was refused as stale and the run died on "Perception
    // failed" before Goal Verification.
    expect(state.currentPageGeneration).toBeLessThanOrEqual(3 + calls - 1);
    expect(state.reason ?? '').not.toMatch(/Perception failed/i);
    expect(staleModelWarnings(warn)).toEqual([]);

    // The run did reach later cycles' perceptions, i.e. it survived the point
    // where the drift used to abort it.
    expect(calls).toBeGreaterThanOrEqual(3);
    // Every dispatch was a real, observed no-op — nothing was fabricated.
    expect(state.steps.length).toBeGreaterThan(0);
    expect(state.steps.every((s) => s.effectStatus === 'ACTION_NO_EFFECT')).toBe(true);
  });

  it('7. after a recovery the counter equals the generation the fresh perception observed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loop, perceptionCalls } = noEffectLoop((n) => perceptionFor(3 + n), 2);

    const state = await loop.runTask(TASK);

    // The last world model the page reported is the anchor; the counter is not
    // one step past it.
    expect(state.currentPageGeneration).toBe(3 + perceptionCalls() - 1);
    expect(state.perceptionGeneration).toBe(state.currentPageGeneration);
  });

  it('8. a recovery that cannot re-perceive neither drifts the counter nor fabricates an observation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The recovery's mandatory re-perception FAILS, so the page does NOT build
    // a world model for it and its generation does not advance. The next
    // cycle's perception builds generation 4 - one step past the last
    // observation, which is exactly the case a drifted counter refuses.
    let builds = 0;
    const { loop, perceptionCalls } = noEffectLoop((n) => {
      if (n === 1) return null;
      return perceptionFor(3 + builds++);
    }, 3);

    const state = await loop.runTask(TASK);

    expect(perceptionCalls()).toBeGreaterThanOrEqual(3);
    expect(state.reason ?? '').not.toMatch(/Perception failed/i);
    expect(staleModelWarnings(warn)).toEqual([]);
    expect(state.status).not.toBe('SUCCESS');
    expect(state.goalStatus).not.toBe('SUCCESS');
    // No observation means no advancement: the counter stays on what was seen.
    expect(state.currentPageGeneration).toBeLessThanOrEqual(3 + builds - 1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * D. The defect, stated as arithmetic — old path vs. fixed path
 * ═════════════════════════════════════════════════════════════════════════ */

describe('post-17.9 generation lifecycle — the arithmetic that produced the false rejection', () => {
  it('9. the old double-advance rejects a FRESH model; the fixed path accepts it', () => {
    const loop = new AgentLoop(new MockAgentProvider(), {
      perceivePage: vi.fn(async () => null),
      executeAction: vi.fn(async () => ({ success: true })),
    }, { maxSteps: 1, delayBetweenStepsMs: 1 });

    // ── Old path. Last observed generation 8; the page had 9 ready. ────────
    const old = (loop as any).state;
    old.currentPageGeneration = 8;
    old.perceptionGeneration = 8;
    advancePageGeneration(old);                  // (A) entering recovery → 9
    old.perceptionGeneration = 9;
    old.currentPageGeneration = 9;               // re-perception observed wm-g9
    advancePageGeneration(old);                  // (B) → 10   ← the spurious bump
    old.perceptionGeneration += 1;               // next cycle → 11
    old.currentPageGeneration = old.perceptionGeneration;
    // A brand-new model, younger than anything seen, is refused.
    expect((loop as any).normalizePerceptionResult(perceptionFor(10))).toBeNull();

    // ── Fixed path. ────────────────────────────────────────────────────────
    const fixed = (loop as any).state;
    fixed.currentPageGeneration = 8;
    fixed.perceptionGeneration = 8;
    invalidatePageGenerationState(fixed);        // (A') invalidate only → 8
    expect(fixed.currentPageGeneration).toBe(8);
    // The re-perception observed wm-g9 → re-anchor, exactly as the loop does.
    fixed.currentPageGeneration = 9;
    fixed.perceptionGeneration = 9;
    fixed.perceptionGeneration += 1;             // next cycle → 10
    fixed.currentPageGeneration = fixed.perceptionGeneration;
    expect((loop as any).normalizePerceptionResult(perceptionFor(10))).not.toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * E. Reaching the page is not the same as proving the goal
 * ═════════════════════════════════════════════════════════════════════════ */

describe('post-17.9 generation lifecycle — no fabricated success', () => {
  it('10. being ON the product page never fabricates SUCCESS for a value-reading goal', () => {
    //
    // NOTE: this pins TODAY'S contract, not a permanent truth. The goal asks the
    // agent to REPORT a value shown on the page. An observed product URL is not
    // evidence of the value, and the sanitized context carries neither page text
    // nor a product-named element for this fixture, so the verifier must stay
    // IN_PROGRESS. If a text/content goal type is added later, this test is the
    // one to update - and the replacement must still read observed evidence.
    const state = createAgentTaskState(TASK);
    const result = verifyTaskGoal(TASK, state, contextAt('http://localhost:4291/product/alpha-widget'));

    expect(result.satisfied).toBe(false);
    expect(result.status).toBe('IN_PROGRESS');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F. Stale provider response (Phase 17.5 F3) is still refused
 * ═════════════════════════════════════════════════════════════════════════ */

describe('post-17.9 generation lifecycle — stale provider response', () => {
  it('4. a proposal computed from a superseded observation is refused, never dispatched', async () => {
    const provider = new MockAgentProvider();
    provider.setCustomHandler((_task, context) => {
      // The browser moves while the request is in flight: the identity this
      // proposal was computed from no longer describes the page.
      context.url = 'http://localhost:4291/product/moved';
      return SCROLL;
    });
    const executeAction = vi.fn(async () => ({ success: true }));

    const loop = new AgentLoop(provider, {
      perceivePage: vi.fn(async () => perceptionFor(4)) as any,
      executeAction,
      getEffectSnapshot: observingHost({ url: PAGE, domElementCount: 10, scrollY: 0 }),
    }, { maxSteps: 2, delayBetweenStepsMs: 1 });

    const state = await loop.runTask(TASK);

    expect(executeAction).not.toHaveBeenCalled();
    expect(state.status).not.toBe('SUCCESS');
    expect(state.goalStatus).not.toBe('SUCCESS');
    expect(state.reason ?? '').toMatch(/stale/i);
  });
});
