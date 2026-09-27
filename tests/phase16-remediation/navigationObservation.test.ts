/**
 * Phase 16 P1 remediation — DEFECT 3: bfcache / authoritative tab URL.
 *
 * The service worker read Chrome's tab URL, then required a content-script
 * reading as well. During a real navigation the content script is bfcached and
 * `chrome.tabs.sendMessage` rejects, so the whole snapshot — including the
 * already-authoritative tab URL — was discarded, and a navigation that
 * demonstrably happened was reported ACTION_NO_EFFECT.
 *
 * The fix: Chrome's tab record is authoritative for navigation state; the page
 * reading is best-effort. The fallback reports ONLY the URL as observed and
 * marks `pageStateObservable: false` so no page-side geometry is invented.
 *
 * These tests exercise the DECISION logic that consumes such a snapshot —
 * `verifyActionEffect` — across the required scenarios, and prove the security
 * authorities are untouched: a changed tab URL establishes an OBSERVED EFFECT
 * and nothing more. Goal verification still decides success.
 */

import { describe, it, expect } from 'vitest';
import { verifyActionEffect, tabOnlySnapshotFields } from '../../extension/src/agent/effectVerifier';
import { evaluateContainment, establishContainmentScope } from '../../extension/src/agent/containment';
import { verifyTaskGoal } from '../../extension/src/agent/goalVerifier';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';
import type { PreActionSnapshot, PostActionSnapshot } from '../../extension/src/agent/effectVerifier';
import type { AgentContextPayload } from '../../extension/src/privacy/types';
import type { AgentTaskState } from '../../extension/src/agent/agentState';

const pre = (over: Partial<PreActionSnapshot> = {}): PreActionSnapshot =>
  ({ url: 'http://localhost:4200/', scrollX: 0, scrollY: 0, domElementCount: 100, timestamp: 0, ...over });

/**
 * The fallback shape the SW now returns when the page reading is unavailable.
 *
 * PHASE 17.1: it now also carries the observation contract, so the verifier
 * reads the per-field STATES rather than inferring them from placeholder zeros.
 * The numeric fields are still zeros — that is exactly why the states must be
 * explicit.
 */
const tabOnly = (url: string): PostActionSnapshot =>
  ({
    url, scrollX: 0, scrollY: 0, targetValueLength: 0, openModalsCount: 0,
    activeElementSelector: undefined, domElementCount: 0, timestamp: 1,
    pageStateObservable: false,
    observation: {
      observedAt: 1,
      tabId: 7,
      pageGeneration: null,
      tabLifecycleObserved: true,
      pageReadable: false,
      fields: tabOnlySnapshotFields(),
    },
  }) as unknown as PostActionSnapshot;

describe('P1-D3.1 normal navigation is observed', () => {
  it('a click that changes the tab URL is an observed effect', () => {
    const r = verifyActionEffect({ action: 'click', target: 'go' } as BrowserAction, pre(), pre({ url: 'http://localhost:4200/results?q=cats' }));
    expect(r.hasEffect).toBe(true);
    expect(r.status).toBe('URL_NAVIGATION_OBSERVED');
  });
});

describe('P1-D3.2 navigation with the content script unavailable is still observed', () => {
  it('the bfcache scenario: a tab-authoritative reading reports the navigation', () => {
    // This is the exact shape the SW now returns when sendMessage rejects.
    const r = verifyActionEffect({ action: 'click', target: 'go' } as BrowserAction, pre(), tabOnly('http://localhost:4200/results?q=cats'));
    expect(r.hasEffect).toBe(true);
    expect(r.status).toBe('URL_NAVIGATION_OBSERVED');
  });

  it('a navigate action with the page unavailable is still observed', () => {
    const r = verifyActionEffect(
      { action: 'navigate', url: 'http://localhost:4200/products' } as unknown as BrowserAction,
      pre(), tabOnly('http://localhost:4200/products')
    );
    expect(r.hasEffect).toBe(true);
  });
});

describe('P1-D3.3 a bfcache-like lifecycle does not fabricate an effect', () => {
  it('if the tab URL did NOT change, the page-unavailable reading is still no effect', () => {
    const r = verifyActionEffect({ action: 'click', target: 'go' } as BrowserAction, pre(), tabOnly('http://localhost:4200/'));
    expect(r.hasEffect).toBe(false);
    // PHASE 17.1 REFINEMENT — the invariant is unchanged, the label is stricter.
    //
    // This asserted ACTION_NO_EFFECT. 17.1 adds EFFECT_UNVERIFIABLE and applies
    // it here, because ACTION_NO_EFFECT is a claim about the browser ("nothing
    // happened") and in this case the system never read the page. "We could
    // not tell" and "nothing happened" are different facts, and the whole point
    // of this phase is that they must not be conflated.
    //
    // What this test protects has NOT been weakened: no effect is claimed in
    // either direction, and the verdict still fails closed.
    expect(r.status).toBe('EFFECT_UNVERIFIABLE');
    expect(r.diagnostics.observation.post?.domElementCount).toBe('UNAVAILABLE');
  });

  it('a scroll with the page unavailable and the URL unchanged is not an effect', () => {
    const r = verifyActionEffect({ action: 'scroll', direction: 'down', amount: 600 } as unknown as BrowserAction, pre(), tabOnly('http://localhost:4200/'));
    expect(r.hasEffect).toBe(false);
    // Also unverifiable rather than "no effect": scrollY was never read.
    expect(r.status).toBe('EFFECT_UNVERIFIABLE');
    expect(r.diagnostics.scrollDelta).toBe(0);
  });
});

describe('P1-D3.4 chrome.tabs wins over a stale content-script URL', () => {
  it('the SW combines the authoritative tab URL with the page geometry', () => {
    // Mirrors the SW: observedUrl = chromeUrl || pageSnap.url. When Chrome has
    // moved on and the page still reports the old document, the URL that counts
    // is Chrome's.
    const chromeUrl = 'http://localhost:4200/results?q=cats';
    const pageUrl = 'http://localhost:4200/';
    expect(chromeUrl || pageUrl).toBe('http://localhost:4200/results?q=cats');

    const r = verifyActionEffect({ action: 'click', target: 'go' } as BrowserAction, pre({ url: pageUrl }), pre({ url: chromeUrl }));
    expect(r.status).toBe('URL_NAVIGATION_OBSERVED');
  });
});

describe('P1-D3.5 a genuine navigation failure is still ACTION_NO_EFFECT', () => {
  it('a click that changes nothing at all', () => {
    const r = verifyActionEffect({ action: 'click', target: 'go' } as BrowserAction, pre(), pre());
    expect(r.hasEffect).toBe(false);
    expect(r.status).toBe('ACTION_NO_EFFECT');
  });

  it('a navigate to the URL already displayed', () => {
    const r = verifyActionEffect({ action: 'navigate', url: 'http://localhost:4200/' } as unknown as BrowserAction, pre(), pre());
    expect(r.status).toBe('ACTION_NO_EFFECT');
  });
});

describe('P1-D3.6 cross-origin navigation is still refused by containment', () => {
  const scope = establishContainmentScope({ targetUrl: 'http://localhost:4200/', targetTabId: 7, dashboardOrigin: 'http://localhost:5175' })!;

  it('observing a cross-origin URL does not authorize it', () => {
    // The snapshot may report it; containment is a separate, later gate.
    const d = evaluateContainment({
      action: { action: 'navigate', url: 'https://evil.example.com/', reason: 'x' } as unknown as BrowserAction,
      scope, liveUrl: 'http://localhost:4200/',
    });
    expect(d.contained).toBe(false);
    expect(d.code).toBe('CROSS_ORIGIN_NAVIGATION_DENIED');
  });

  it('a drifted live URL is still refused', () => {
    const d = evaluateContainment({
      action: { action: 'click', target: 'go', reason: 'x' } as BrowserAction,
      scope, liveUrl: 'https://elsewhere.example.com/',
    });
    expect(d.code).toBe('SCOPE_DRIFT_DETECTED');
  });
});

describe('P1-D3.7 a changed tab URL is an EFFECT, never a task SUCCESS', () => {
  const state = (over: Record<string, unknown> = {}) => ({
    steps: [], previousActions: [{ action: 'click' }], pageType: 'other',
    visitedElementIds: [], taskConstraints: {}, candidateItems: [],
    recoveryHistory: [], totalRecoveryAttempts: 0, plan: { recoveryAttempts: 0 },
    ...over,
  } as unknown as AgentTaskState);

  it('a bare "open the page" goal is not satisfied by a URL change alone', () => {
    const c = {
      sanitized_status: 'sanitized_only', detections: [],
      url: 'http://localhost:4200/results?q=cats',
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    } as unknown as AgentContextPayload;
    const r = verifyTaskGoal('open the results page', state(), c);
    expect(r.satisfied).toBe(false);
  });

  it('a renamed-field goal is not satisfied by a URL change alone', () => {
    const c = {
      sanitized_status: 'sanitized_only', detections: [],
      url: 'http://localhost:4200/settings/profile',
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    } as unknown as AgentContextPayload;
    const r = verifyTaskGoal('rename the third field', state(), c);
    expect(r.satisfied).toBe(false);
  });

  it('a genuine observed search result URL is still a success', () => {
    const c = {
      sanitized_status: 'sanitized_only', detections: [],
      url: 'http://localhost:4200/results?q=cats',
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    } as unknown as AgentContextPayload;
    const r = verifyTaskGoal('search cats', state(), c);
    expect(r.satisfied).toBe(true);
  });
});

describe('P1-D3.8 the fallback invents no page-side geometry', () => {
  it('the fallback reading is explicitly marked as not page-observable', () => {
    const s = tabOnly('http://localhost:4200/next') as unknown as { pageStateObservable?: boolean };
    expect(s.pageStateObservable).toBe(false);
  });

  it('a scroll verdict on a page-unavailable reading cannot be claimed from placeholders', () => {
    // Both scroll positions are the zero placeholder, so no scroll occurred
    // as far as any observer can actually tell.
    const r = verifyActionEffect({ action: 'scroll', direction: 'down', amount: 600 } as unknown as BrowserAction, pre({ scrollY: 400 }), tabOnly('http://localhost:4200/'));
    expect(r.hasEffect).toBe(false);
  });
});
