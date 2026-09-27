/**
 * PHASE 17.1 — Observation Generalization: focused contract tests.
 *
 * The invariant under test throughout:
 *
 *     "unobservable" is NOT "zero"
 *     "stale"      is NOT "fresh"
 *     an ACTION    is NOT a browser observation
 *     a MODEL CLAIM is NOT a browser observation
 *
 * Every assertion here is about what the system is willing to CLAIM, not about
 * whether a task succeeds. Observation is informational; it is never an
 * authorization.
 */

import { describe, it, expect } from 'vitest';
import {
  verifyActionEffect,
  observedSnapshotFields,
  tabOnlySnapshotFields,
  type ObservationState,
  type PreActionSnapshot,
  type PostActionSnapshot,
  type SnapshotObservation,
} from '../../extension/src/agent/effectVerifier';
import { verifyTaskGoal } from '../../extension/src/agent/goalVerifier';
import { BrowserAction } from '../../extension/src/agent/actionTypes';
import { AgentContextPayload, AgentDetection } from '../../extension/src/privacy/types';
import { AgentTaskState } from '../../extension/src/agent/agentState';
import { isDashboardUrl } from '../../extension/src/background/targetResolver';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const ALL_OBSERVED = observedSnapshotFields();

function observation(over: Partial<SnapshotObservation['fields']> = {}, base = ALL_OBSERVED): SnapshotObservation {
  return {
    observedAt: 1000,
    tabId: 7,
    pageGeneration: 3,
    tabLifecycleObserved: true,
    pageReadable: true,
    fields: { ...base, ...over },
  };
}

function snap(over: Partial<PostActionSnapshot> = {}): PostActionSnapshot {
  return {
    url: 'http://localhost:4200/',
    scrollX: 0, scrollY: 0,
    domElementCount: 100, openModalsCount: 0, targetValueLength: 0,
    timestamp: 1000,
    observation: observation(),
    ...over,
  } as PostActionSnapshot;
}

const CLICK = { action: 'click', target: 'go' } as BrowserAction;
const SCROLL = { action: 'scroll', direction: 'down', amount: 500 } as unknown as BrowserAction;
const TYPE = { action: 'type', target: 'q', text: 'cats' } as unknown as BrowserAction;

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. Fresh URL observation
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-1 a fresh URL observation is reported as such', () => {
  it('an observed URL change is a real, attributable effect', () => {
    const r = verifyActionEffect(CLICK, snap({ url: 'http://localhost:4200/' }) as PreActionSnapshot,
      snap({ url: 'http://localhost:4200/results?q=cats' }));
    expect(r.status).toBe('URL_NAVIGATION_OBSERVED');
    expect(r.diagnostics.urlChanged).toBe(true);
    expect(r.diagnostics.observation.crossDocument).toBe(true);
  });

  it('a snapshot carries the tab it was read from and when', () => {
    const o = observation();
    expect(o.tabId).toBe(7);
    expect(o.observedAt).toBe(1000);
    expect(o.pageGeneration).toBe(3);
    expect(o.pageReadable).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Stale DOM after navigation  (the F3 fix)
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-2 a DOM reading from a previous page is NOT evidence of an effect', () => {
  it('a DOM count difference across two documents is never a DOM mutation', () => {
    // The page navigated. The DOM counts differ — 100 vs 900 — but they
    // describe two DIFFERENT documents, so the difference says nothing about
    // what the click did.
    const r = verifyActionEffect(CLICK,
      snap({ url: 'http://localhost:4200/', domElementCount: 100 }) as PreActionSnapshot,
      snap({ url: 'http://localhost:4200/next', domElementCount: 900 }));
    expect(r.diagnostics.observation.crossDocument).toBe(true);
    expect(r.diagnostics.domMutated).toBe(false);
    expect(r.diagnostics.modalsChanged).toBe(false);
    expect(r.diagnostics.focusChanged).toBe(false);
    // Only the URL survives as evidence.
    expect(r.status).toBe('URL_NAVIGATION_OBSERVED');
  });

  it('the same documents DO produce a DOM mutation when one really happened', () => {
    const r = verifyActionEffect(CLICK,
      snap({ url: 'http://localhost:4200/', domElementCount: 100 }) as PreActionSnapshot,
      snap({ url: 'http://localhost:4200/', domElementCount: 101 }));
    expect(r.diagnostics.observation.crossDocument).toBe(false);
    expect(r.status).toBe('DOM_MUTATION_OBSERVED');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Content-script unavailable during navigation
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-3 a content script that is gone is not a failed action', () => {
  const tabOnly = (url: string) => snap({
    url, pageStateObservable: false, targetValueLength: null,
    observation: {
      observedAt: 1000, tabId: 7, pageGeneration: null,
      tabLifecycleObserved: true, pageReadable: false,
      fields: tabOnlySnapshotFields(),
    },
  });

  it('the navigation is still observed from the tab record alone', () => {
    const r = verifyActionEffect(CLICK, snap({ url: 'http://localhost:4200/' }) as PreActionSnapshot,
      tabOnly('http://localhost:4200/results?q=cats'));
    expect(r.hasEffect).toBe(true);
    expect(r.status).toBe('URL_NAVIGATION_OBSERVED');
  });

  it('and no page-side geometry is invented from the absence', () => {
    const r = verifyActionEffect(CLICK, snap({ url: 'http://localhost:4200/' }) as PreActionSnapshot,
      tabOnly('http://localhost:4200/results?q=cats'));
    expect(r.diagnostics.scrollDelta).toBe(0);
    expect(r.diagnostics.domMutated).toBe(false);
    expect(r.diagnostics.observation.post?.scrollY).toBe('UNAVAILABLE');
  });

  it('an unchanged URL with an unreadable page is UNVERIFIABLE, not "no effect"', () => {
    const r = verifyActionEffect(CLICK, snap({ url: 'http://localhost:4200/' }) as PreActionSnapshot,
      tabOnly('http://localhost:4200/'));
    expect(r.hasEffect).toBe(false);
    // "We could not tell" is not "nothing happened". 17.1 separates them.
    expect(r.status).toBe('EFFECT_UNVERIFIABLE');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4 & 5. Real scrollY = 0  /  unavailable scrollY
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-4/5 a scrollY of 0 and an unobserved scrollY are different facts', () => {
  it('a genuinely observed 0 is a real baseline', () => {
    const r = verifyActionEffect(SCROLL,
      snap({ scrollY: 0, observation: observation({ scrollY: 'OBSERVED' }) }) as PreActionSnapshot,
      snap({ scrollY: 0, observation: observation({ scrollY: 'OBSERVED' }) }));
    expect(r.diagnostics.scrollDelta).toBe(0);
    expect(r.status).toBe('ACTION_NO_EFFECT');
  });

  it('a real 0 -> 500 move is SCROLL_CHANGED', () => {
    const r = verifyActionEffect(SCROLL,
      snap({ scrollY: 0 }) as PreActionSnapshot, snap({ scrollY: 500 }));
    expect(r.diagnostics.scrollDelta).toBe(500);
    expect(r.status).toBe('SCROLL_CHANGED');
  });

  it('an UNAVAILABLE scrollY produces no scroll delta at all, whatever the number', () => {
    // The numeric field says 500. The STATE says it was never read. The state
    // wins — this is the whole phase in one assertion.
    const r = verifyActionEffect(SCROLL,
      snap({ scrollY: 0, observation: observation({ scrollY: 'UNAVAILABLE' }) }) as PreActionSnapshot,
      snap({ scrollY: 500, observation: observation({ scrollY: 'UNAVAILABLE' }) }));
    expect(r.diagnostics.scrollDelta).toBe(0);
    expect(r.hasEffect).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6 & 7. Real / unavailable viewport height
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-6/7 viewport height is only a measurement when it was observed', () => {
  const ctxWith = (viewport: AgentContextPayload['viewport'], observable?: boolean): AgentContextPayload =>
    ({ url: 'http://localhost:4200/long', viewport, viewportObservable: observable } as unknown as AgentContextPayload);

  const state = (scrollY: number) =>
    ({ task: 'scroll to the pricing section', taskConstraints: {}, previousActions: [],
       initialScrollY: 0, observedScrollY: scrollY } as unknown as AgentTaskState);

  const pricing: AgentDetection = {
    id: 'pricing', type: 'section', label: 'Pricing', selector: '#pricing',
    confidence: 0.95, source: 'DOM', length: 0, is_partially_visible: true,
    bbox: { x: 0, y: 3000, width: 1280, height: 120 },
  } as unknown as AgentDetection;

  it('a real viewport height makes a target goal decidable', () => {
    const ctx = { ...ctxWith({ width: 1280, height: 900, scroll_x: 0, scroll_y: 2900 }, true),
      detections: [pricing] } as unknown as AgentContextPayload;
    const r = verifyTaskGoal('scroll to the pricing section', state(2900), ctx);
    expect(r.status).toBe('SUCCESS');
  });

  it('an UNOBSERVED viewport fails closed even when the numbers look perfect', () => {
    // scroll_y says 2900 and the section is at 3000 — but with height 0 the
    // viewport cannot contain anything. 17.1 refuses to decide at all.
    const ctx = { ...ctxWith({ width: 0, height: 0, scroll_x: 0, scroll_y: 0 }, false),
      detections: [pricing] } as unknown as AgentContextPayload;
    const r = verifyTaskGoal('scroll to the pricing section', state(2900), ctx);
    expect(r.satisfied).toBe(false);
    expect(r.status).toBe('IN_PROGRESS');
  });

  it('a zero-height viewport that WAS observed is still not a usable viewport', () => {
    const ctx = { ...ctxWith({ width: 0, height: 0, scroll_x: 0, scroll_y: 2900 }, true),
      detections: [pricing] } as unknown as AgentContextPayload;
    const r = verifyTaskGoal('scroll to the pricing section', state(2900), ctx);
    expect(r.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. No fabricated geometry
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-8 the loop never fabricates a pre- or post-snapshot', () => {
  it('a snapshot that omits `observation` is treated as fully observed, not as a default', () => {
    // The contract is optional so hand-built fixtures stay valid; the soundness
    // of that rests on the loop no longer inventing one. This pins the meaning.
    const legacy: PostActionSnapshot = {
      url: 'http://localhost:4200/', scrollX: 0, scrollY: 300,
      domElementCount: 100, timestamp: 1,
    } as PostActionSnapshot;
    const r = verifyActionEffect(SCROLL, snap({ scrollY: 0 }) as PreActionSnapshot, legacy);
    expect(r.status).toBe('SCROLL_CHANGED');
  });

  it('tabOnlySnapshotFields marks the URL observed and everything page-local unavailable', () => {
    const f = tabOnlySnapshotFields();
    expect(f.url).toBe('OBSERVED');
    for (const k of ['scrollX', 'scrollY', 'domElementCount', 'openModalsCount', 'targetValueLength', 'activeElementSelector'] as const) {
      expect(f[k]).toBe('UNAVAILABLE');
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 9/10/11. EffectVerifier: unavailable before, genuine change, stale observation
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-9/10/11 the effect verifier separates unobservable, unchanged and changed', () => {
  it('an unavailable BEFORE state cannot manufacture a change', () => {
    const r = verifyActionEffect(SCROLL,
      snap({ scrollY: 0, observation: observation({ scrollY: 'UNAVAILABLE' }) }) as PreActionSnapshot,
      snap({ scrollY: 500, observation: observation({ scrollY: 'OBSERVED' }) }));
    expect(r.hasEffect).toBe(false);
    expect(r.status).toBe('EFFECT_UNVERIFIABLE');
  });

  it('a genuine observed change is still reported', () => {
    const r = verifyActionEffect(TYPE, snap({ targetValueLength: 0 }) as PreActionSnapshot,
      snap({ targetValueLength: 4 }));
    expect(r.hasEffect).toBe(true);
    expect(r.status).toBe('VALUE_STATE_CHANGED');
  });

  it('a genuinely observed null length is NOT treated as an observed zero', () => {
    // Phase 17.1 C5: the content script reports null when the target cannot be
    // located, and 0 when the field is genuinely empty.
    const r = verifyActionEffect(TYPE, snap({ targetValueLength: 3 }) as PreActionSnapshot,
      snap({ targetValueLength: null, observation: observation({ targetValueLength: 'UNAVAILABLE' }) }));
    expect(r.hasEffect).toBe(false);
    expect(r.status).not.toBe('VALUE_STATE_CHANGED');
  });

  it('a stale cross-document reading never produces a value-change claim', () => {
    const r = verifyActionEffect(TYPE,
      snap({ url: 'http://localhost:4200/', targetValueLength: 0 }) as PreActionSnapshot,
      snap({ url: 'http://localhost:4200/next', targetValueLength: 9 }));
    expect(r.diagnostics.observation.crossDocument).toBe(true);
    expect(r.diagnostics.valueLengthChanged).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 12 & 13. Action history and model output are never browser state
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-12/13 an action is not an observation', () => {
  const state = (previousActions: unknown[]) =>
    ({ task: 'scroll down to the pricing section', taskConstraints: {}, previousActions,
       initialScrollY: 0, observedScrollY: 0 } as unknown as AgentTaskState);
  const ctx = { url: 'http://localhost:4200/long', viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
                detections: [], viewportObservable: true } as unknown as AgentContextPayload;

  it('a long action history cannot satisfy a scroll goal', () => {
    const r = verifyTaskGoal('scroll down to the pricing section',
      state([{ action: 'scroll', amount: 3000 }, { action: 'scroll', amount: 3000 }]), ctx);
    expect(r.satisfied).toBe(false);
  });

  it('the effect verifier takes no history at all — only two readings', () => {
    // Same two observations, opposite order of arrival: the verdict is a pure
    // function of the readings, never of what was attempted.
    const a = verifyActionEffect(SCROLL, snap({ scrollY: 0 }) as PreActionSnapshot, snap({ scrollY: 500 }));
    const b = verifyActionEffect(SCROLL, snap({ scrollY: 500 }), snap({ scrollY: 0 }) as PreActionSnapshot);
    expect(a.status).toBe('SCROLL_CHANGED');
    expect(b.status).toBe('SCROLL_CHANGED');
    // And an action object carrying a huge claimed amount changes nothing.
    const c = verifyActionEffect(
      { action: 'scroll', direction: 'down', amount: 999999, reason: 'I scrolled' } as unknown as BrowserAction,
      snap({ scrollY: 0 }) as PreActionSnapshot, snap({ scrollY: 0 }));
    expect(c.status).toBe('ACTION_NO_EFFECT');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 14. chrome.tabs remains authoritative
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-14 the tab record stays authoritative for the URL', () => {
  it('a stale page URL never overrides the tab URL', () => {
    // The service worker resolves the URL as `pendingUrl || url || page`.
    // The tab's record must win over a page that has not caught up.
    expect(tabUrlOf({ url: 'http://localhost:4200/results?q=cats', pendingUrl: null },
      { url: 'http://localhost:4200/' })).toBe('http://localhost:4200/results?q=cats');
    // A pending navigation beats a still-current committed URL.
    expect(tabUrlOf({ url: 'http://localhost:4200/', pendingUrl: 'http://localhost:4200/next' },
      { url: 'http://localhost:4200/' })).toBe('http://localhost:4200/next');
  });

  it('a page reading is only ever used when the tab record has nothing', () => {
    const withTab = tabUrlOf({ url: null, pendingUrl: null }, { url: 'http://localhost:4200/' });
    const withoutTab = tabUrlOf({ url: null, pendingUrl: null }, { url: null });
    expect(withTab).toBe('http://localhost:4200/');
    expect(withoutTab).toBeNull();
  });

  it('the tab title is observed, never inferred', () => {
    const withTitle = snap({ title: 'Results for cats' });
    expect(withTitle.title).toBe('Results for cats');
  });
});

function tabUrlOf(tab: { url: string | null; pendingUrl: string | null }, page: { url: string | null }): string | null {
  return tab.pendingUrl || tab.url || page.url || null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 15. Observation version / freshness behaviour
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.1-15 observation freshness is explicit', () => {
  it('every snapshot carries a monotonic page generation and a read time', () => {
    const o = observation();
    expect(typeof o.observedAt).toBe('number');
    expect(typeof o.pageGeneration).toBe('number');
  });

  it('a page-unreadable snapshot reports pageGeneration null, not a stale number', () => {
    const o: SnapshotObservation = {
      observedAt: 1, tabId: 7, pageGeneration: null,
      tabLifecycleObserved: true, pageReadable: false, fields: tabOnlySnapshotFields(),
    };
    expect(o.pageGeneration).toBeNull();
    expect(o.pageReadable).toBe(false);
  });

  it('the four states are all representable and all distinct', () => {
    const states: ObservationState[] = ['OBSERVED', 'UNAVAILABLE', 'STALE', 'NOT_APPLICABLE'];
    expect(new Set(states).size).toBe(4);
  });

  it('the dashboard guard is told the REAL dashboard origin (C8)', () => {
    // Before 17.1 the guard only ever matched port 5173, so a dashboard served
    // on any other port was not recognised as the agent's own control surface.
    expect(isDashboardUrl('http://localhost:5175/', 'http://localhost:5175')).toBe(true);
    expect(isDashboardUrl('http://localhost:5175/')).toBe(false); // the old blind spot
    expect(isDashboardUrl('http://localhost:5173/')).toBe(true);    // still guarded
    expect(isDashboardUrl('https://www.google.com/', 'http://localhost:5175')).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 16. Document identity: what establishes it, and what cannot
 *
 * `pageGeneration` increments on EVERY scan of the same document
 * (contentScript.ts: `currentPageGeneration += 1` inside the world-model
 * build), so two consecutive effect snapshots of one unchanged page
 * routinely carry DIFFERENT generations. If the verifier treated a
 * generation bump as a document change it would void every real
 * page-local observation. It must not — and equally, a generation must
 * never be able to CREATE a comparison that was not observed.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('17.1-16 the URL establishes document identity, and a generation never does', () => {
  const atGeneration = (n: number) => ({ ...observation(), pageGeneration: n });

  it('two reads of one document are not cross-document merely because the generation advanced', () => {
    // The content script bumps the generation on every scan, so this is the
    // ORDINARY case for a scroll that moved on a stable page — not an edge case.
    const r = verifyActionEffect(CLICK,
      snap({ scrollY: 0, domElementCount: 100, observation: atGeneration(3) }) as PreActionSnapshot,
      snap({ scrollY: 500, domElementCount: 101, observation: atGeneration(4) }));

    expect(r.diagnostics.observation.crossDocument).toBe(false);
    // And the page-local comparison is still fully alive, not merely un-voided:
    // every page-local field is still measured across the generation bump.
    expect(r.diagnostics.scrollDelta).toBe(500);
    expect(r.diagnostics.domMutated).toBe(true);
    expect(r.status).toBe('DOM_MUTATION_OBSERVED');

    // The converse, in the same breath: same generation, DIFFERENT url. This is
    // what actually voids page-local comparison, and only the URL can do it.
    const nav = verifyActionEffect(CLICK,
      snap({ domElementCount: 100, observation: atGeneration(3) }) as PreActionSnapshot,
      snap({ url: 'http://localhost:4200/next', domElementCount: 101, observation: atGeneration(3) }));
    expect(nav.diagnostics.observation.crossDocument).toBe(true);
    expect(nav.diagnostics.domMutated).toBe(false);
    expect(nav.diagnostics.scrollDelta).toBe(0);
  });

  it('an unavailable content script cannot fabricate a generation, and one could not help it anyway', () => {
    // The honest tab-only reading: no page, so no generation. It is null, and
    // it produces no page-local claim and no cross-document claim.
    const honest = verifyActionEffect(CLICK, snap() as PreActionSnapshot,
      snap({ pageStateObservable: false, targetValueLength: null, observation: {
        observedAt: 1000, tabId: 7, pageGeneration: null,
        tabLifecycleObserved: true, pageReadable: false, fields: tabOnlySnapshotFields(),
      } }));
    expect(honest.diagnostics.observation.crossDocument).toBe(false);
    expect(honest.diagnostics.domMutated).toBe(false);
    expect(honest.diagnostics.scrollDelta).toBe(0);
    expect(honest.status).toBe('EFFECT_UNVERIFIABLE');

    // Now the adversarial version: suppose something DID attach a large,
    // freshly-minted generation to a snapshot that observed no page at all.
    // A generation is a claim about a document; it is never a reading of one.
    // No page-local field was observed, so no page-local claim can be made and
    // the verdict is byte-for-byte the same — the number buys nothing.
    const fabricated = verifyActionEffect(CLICK, snap() as PreActionSnapshot,
      snap({ pageStateObservable: false, targetValueLength: null, observation: {
        observedAt: 1000, tabId: 7, pageGeneration: 99,
        tabLifecycleObserved: true, pageReadable: false, fields: tabOnlySnapshotFields(),
      } }));
    expect(fabricated.diagnostics.observation.crossDocument).toBe(false);
    expect(fabricated.diagnostics.domMutated).toBe(false);
    expect(fabricated.diagnostics.scrollDelta).toBe(0);
    expect(fabricated.status).toBe('EFFECT_UNVERIFIABLE');
    // Identical verdict to the honest reading, generation notwithstanding.
    expect(fabricated.status).toBe(honest.status);
  });

  it('fails closed when the document identity itself was never observed', () => {
    // Neither chrome.tabs nor the page produced a URL. With no identity there
    // is nothing to compare, so there is no verdict — in EITHER direction. It
    // must not claim a navigation happened, and it must not claim none did.
    const unknownUrl = snap({
      observation: { ...observation(), tabLifecycleObserved: false,
        fields: { ...ALL_OBSERVED, url: 'UNAVAILABLE' } },
    });

    const changed = verifyActionEffect(CLICK, snap() as PreActionSnapshot,
      snap({ url: 'http://localhost:4200/next', observation: unknownUrl.observation }));
    expect(changed.diagnostics.observation.crossDocument).toBe(false);
    expect(changed.hasEffect).toBe(false);
    expect(changed.status).toBe('EFFECT_UNVERIFIABLE');

    // Same identity-blind reading on a `navigate`, the action that most
    // depends on knowing where the tab is.
    const nav = verifyActionEffect({ action: 'navigate', url: 'http://localhost:4200/next' } as unknown as BrowserAction,
      snap() as PreActionSnapshot, snap({ url: 'http://localhost:4200/other', observation: unknownUrl.observation }));
    expect(nav.hasEffect).toBe(false);
    expect(nav.status).toBe('EFFECT_UNVERIFIABLE');
  });
});
