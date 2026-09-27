/**
 * Test helper — a realistic PRE-action observation channel for AgentLoop.
 *
 * PHASE 17.1.
 *
 * Phase 17.1 removed two fabrications from the AgentLoop:
 *
 *   • the pre-action snapshot, which was invented from the sanitized context
 *     whenever the host had no observation channel, and
 *   • the post-action snapshot, which was synthesized from the requested action.
 *
 * Both were the agent's own plan restated as if the browser had performed it.
 * With them gone, a host that supplies NO observation channel honestly produces
 * `EFFECT_UNVERIFIABLE` for every action — which is the correct answer for such
 * a host, and is what this change is meant to surface.
 *
 * The real product always has an observation channel: the service worker's
 * `getEffectSnapshot`, which reads the live target tab. Test fixtures that were
 * relying on the deleted fabrications were therefore modelling something the
 * product never does.
 *
 * This helper gives a fixture the same thing the product has: a pre-action
 * reading of the page. Fixtures that already supply `postSnapshot` from their
 * `executeAction` are then comparing a real pre reading against a real post
 * reading, which is the situation they always meant to describe.
 *
 * It fabricates nothing: every value is an explicit, readable stand-in for what
 * the content script would report, and the helper is never used by production
 * code.
 */

import type { PostActionSnapshot } from '../../extension/src/agent/effectVerifier';

/** The page state a fixture wants observed BEFORE the action runs. */
export interface ObservedPageState {
  url?: string;
  scrollX?: number;
  scrollY?: number;
  domElementCount?: number;
  targetValueLength?: number | null;
  openModalsCount?: number;
  activeElementSelector?: string;
}

/**
 * Builds a `getEffectSnapshot` callback that reports `state` on every call.
 *
 * The real channel is a function of the live page, so a fixture that needs the
 * reading to change across steps can pass a getter instead of a literal.
 */
export function observingHost(
  state: ObservedPageState | (() => ObservedPageState) = {}
): (target?: string) => Promise<PostActionSnapshot> {
  return async () => {
    const s = typeof state === 'function' ? state() : state;
    return {
      url: s.url ?? 'https://example.com/shop',
      scrollX: s.scrollX ?? 0,
      scrollY: s.scrollY ?? 0,
      domElementCount: s.domElementCount ?? 0,
      targetValueLength: s.targetValueLength ?? 0,
      openModalsCount: s.openModalsCount ?? 0,
      activeElementSelector: s.activeElementSelector,
      timestamp: Date.now(),
    };
  };
}

/**
 * A SIMULATED BROWSER for a test fixture — a test double, and nothing else.
 *
 * PHASE 17.1 note, read this before using it:
 *
 * Phase 17.1 deleted a block of production code that rebuilt a post-action
 * snapshot from the REQUESTED ACTION:
 *
 *     navigate -> post.url         = action.url
 *     scroll   -> post.scrollY    += action.amount
 *     type     -> post.valueLength = action.text.length
 *     click    -> post.domElementCount += 1
 *
 * That was the agent's own plan restated as if the browser had performed it, and
 * it ran in the real product, where it silently manufactured effects for real
 * users. It is gone.
 *
 * A unit test still needs *something* to be the browser, or it cannot assert
 * "a focus shift is detected as FOCUS_SHIFT_OBSERVED". That something used to be
 * the production block above, by accident. This helper is the explicit
 * replacement: the same state transitions, but living in the test where they are
 * visible, named, and impossible to mistake for a real observation.
 *
 * The difference that matters:
 *   • in PRODUCTION, this manufactured evidence a user would act on;
 *   • in a TEST, this is the fixture's own premise, and the production code it
 *     feeds is the part under test.
 *
 * Fixtures that are specifically about effect verification should prefer
 * stating their expected pre/post state explicitly (see tests/stage6*), so the
 * assertion pins a real scenario rather than the simulator's behaviour.
 */
export function simulatedBrowser(
  page: ObservedPageState
): (action: import('../../extension/src/agent/actionTypes').BrowserAction) => Promise<{ success: boolean }> {
  return async (action) => {
    if (action.action === 'navigate') {
      page.url = action.url;
    } else if (action.action === 'scroll') {
      const delta = action.amount ?? 250;
      page.scrollY = Math.max(0, (page.scrollY ?? 0) + (action.direction === 'down' ? delta : -delta));
    } else if (action.action === 'type') {
      page.targetValueLength = (action.text ?? '').length;
      page.activeElementSelector = action.target;
    } else if (action.action === 'select') {
      page.targetValueLength = (action.option ?? '').length;
      page.activeElementSelector = action.target;
    } else if (action.action === 'click') {
      page.activeElementSelector = action.target;
      page.domElementCount = (page.domElementCount ?? 0) + 1;
    }
    return { success: true };
  };
}
