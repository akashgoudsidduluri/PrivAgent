/**
 * PHASE 18.5 / I-2 — model-facing action-history contract.
 *
 * Regression coverage for the live 422 raised against `body.history[1]`:
 * "Action 'type' requires a non-empty 'text' field" — one malformed HISTORICAL
 * entry invalidating an entire, otherwise valid, reasoning request.
 *
 * The contract lives in `historyContract.ts` and mirrors the backend's
 * `BrowserActionModel` applicability rules. The backend's strictness is
 * deliberately NOT relaxed; the fix is on the sending side.
 *
 * These tests also pin the two things that must NOT change: the effect /
 * scrollDelta enrichment that lets the model distinguish a scroll that moved
 * from one that did not (Phase 18.2), and the negative controls proving the
 * filter is a contract check and not a permission bypass.
 */
import { describe, it, expect } from 'vitest';
import {
  conformsToHistoryContract,
  filterToHistoryContract,
} from '../extension/src/agent/historyContract';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const A = (o: Record<string, unknown>) => o as unknown as BrowserAction;

describe('PHASE 18.5 model-facing history contract', () => {
  it('accepts every history state the extension actually produces', () => {
    const states: BrowserAction[] = [
      // ACTION_NO_EFFECT
      A({ action: 'scroll', direction: 'down', amount: 500, effect: 'ACTION_NO_EFFECT', scrollDelta: 0 }),
      // ACTION_CHANGED / SCROLL_CHANGED
      A({ action: 'scroll', direction: 'down', amount: 500, effect: 'SCROLL_CHANGED', scrollDelta: 500 }),
      // ACTION_REJECTED
      A({ action: 'click', target: 'element_details', effect: 'ACTION_REJECTED', scrollDelta: 0 }),
      // NAVIGATION_RESULT
      A({ action: 'navigate', url: 'https://example.com/', effect: 'URL_NAVIGATION_OBSERVED', scrollDelta: 0 }),
    ];
    for (const s of states) {
      expect(conformsToHistoryContract(s)).toBe(true);
    }
  });

  it('REJECTS a type action with no text — the exact live 422 trigger', () => {
    const bad = A({
      action: 'type',
      target: 'search-box',
      reason: 'Typing a broad query into the search box.',
      effect: 'VALUE_STATE_CHANGED',
    });
    expect(conformsToHistoryContract(bad)).toBe(false);
  });

  it('rejects other per-action-type applicability violations', () => {
    expect(conformsToHistoryContract(A({ action: 'type', target: 'x' }))).toBe(false);
    expect(conformsToHistoryContract(A({ action: 'click' }))).toBe(false);
    expect(conformsToHistoryContract(A({ action: 'select', target: 'x' }))).toBe(false);
    expect(conformsToHistoryContract(A({ action: 'navigate' }))).toBe(false);
    expect(conformsToHistoryContract(A({ action: 'pressKey' }))).toBe(false);
  });

  it('rejects blank/whitespace-only required fields', () => {
    expect(conformsToHistoryContract(A({ action: 'type', target: 'x', text: '   ' }))).toBe(false);
    expect(conformsToHistoryContract(A({ action: 'click', target: '' }))).toBe(false);
  });

  it('rejects unknown action types', () => {
    expect(conformsToHistoryContract(A({ action: 'screenshot' }))).toBe(false);
    expect(conformsToHistoryContract(A({ action: 'eval' }))).toBe(false);
  });

  it('filters a mixed history and reports the dropped COUNT only', () => {
    const mixed: BrowserAction[] = [
      A({ action: 'scroll', direction: 'down', amount: 500, effect: 'SCROLL_CHANGED', scrollDelta: 500 }),
      A({ action: 'type', target: 'search-box' }),        // non-conforming
      A({ action: 'navigate', url: 'https://example.com/', effect: 'URL_NAVIGATION_OBSERVED' }),
      A({ action: 'click' }),                              // non-conforming
    ];
    const { history, dropped } = filterToHistoryContract(mixed);
    expect(dropped).toBe(2);
    expect(history).toHaveLength(2);
    expect(history[0]?.action).toBe('scroll');
    expect(history[1]?.action).toBe('navigate');
  });

  it('preserves the effect enrichment that Phase 18.2 depends on', () => {
    // The contract filter must not strip the observed effect or the measured
    // scroll delta — that is what lets the model see a no-effect scroll.
    const entry = A({
      action: 'scroll', direction: 'down', amount: 500,
      effect: 'ACTION_NO_EFFECT', scrollDelta: 0,
    });
    const { history } = filterToHistoryContract([entry]);
    const kept = history[0] as unknown as Record<string, unknown>;
    expect(kept.effect).toBe('ACTION_NO_EFFECT');
    expect(kept.scrollDelta).toBe(0);
  });

  it('is a shape check, not a permission decision', () => {
    // Dropping history grants nothing: the same action still has to pass M5,
    // the Security Critic and containment to execute. The filter only decides
    // what the MODEL is told about the past.
    const dropped = A({ action: 'type', target: 'x' });
    const { history } = filterToHistoryContract([dropped]);
    expect(history).toHaveLength(0);
    // The action itself is untouched and still present for the live pipeline.
    expect((dropped as unknown as { target: string }).target).toBe('x');
  });

  it('handles an empty history without error', () => {
    expect(filterToHistoryContract([])).toEqual({ history: [], dropped: 0 });
  });
});