/**
 * PrivAgent — Phase 11 Acceptance: interaction primitives
 *
 * Covers the deterministic, value-free Phase 11 layer:
 *   - pre-flight interactability verdicts
 *   - bounded viewport / scroll planning
 *   - the fixed safe-key allowlist
 *   - deterministic duplicate-interaction suppression
 *
 * These primitives ADD NO AUTHORITY. A scroll plan is only ever emitted as a
 * normal `scroll` action, so it still flows through the validator, the security
 * gates, effect verification and Phase 10 recovery.
 */

import { describe, it, expect } from 'vitest';
import {
  assessInteractability,
  isSafeKey,
  SAFE_KEYS,
  VIEWPORT_BOUNDS,
  isTargetInViewport,
  planScrollToTarget,
  DuplicateClickGuard,
  isTargetedAction,
} from '../../extension/src/agent/humanInteraction';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { groundProposedTarget } from '../../extension/src/agent/groundingEngine';
import { BrowserAction } from '../../extension/src/agent/actionTypes';
import { ctx, det } from './harness';

describe('P11-1 pre-flight interactability is deterministic and value-free', () => {
  it('1.1 reports a healthy target as interactable', () => {
    const r = assessInteractability({});
    expect(r.interactable).toBe(true);
    expect(r.reason).toBe('Target is structurally interactable.');
  });

  it('1.2 fails closed on a detached target', () => {
    const r = assessInteractability({ exists: false });
    expect(r.interactable).toBe(false);
    expect(r.reason).toMatch(/detached/i);
  });

  it('1.3 fails closed on a disabled target', () => {
    const r = assessInteractability({ enabled: false });
    expect(r.interactable).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
  });

  it('1.4 fails closed on a hidden target', () => {
    const r = assessInteractability({ visible: false });
    expect(r.interactable).toBe(false);
    expect(r.reason).toMatch(/hidden/i);
  });

  it('1.5 fails closed on degenerate geometry', () => {
    const r = assessInteractability({ hasGeometry: false });
    expect(r.interactable).toBe(false);
    expect(r.reason).toMatch(/geometry/i);
  });

  it('1.6 fails closed when a modal occludes the target', () => {
    const r = assessInteractability({ occludedByModal: true });
    expect(r.interactable).toBe(false);
    expect(r.reason).toMatch(/modal/i);
  });

  it('1.7 reports an off-screen target as not in the viewport', () => {
    const r = assessInteractability({ inViewport: false });
    expect(r.inViewport).toBe(false);
    expect(r.interactable).toBe(false);
    expect(r.reason).toMatch(/viewport/i);
  });

  it('1.8 the report carries no raw values — only booleans and a reason code', () => {
    const r = assessInteractability({});
    expect(Object.keys(r).sort()).toEqual(
      [
        'enabled',
        'exists',
        'hasGeometry',
        'inViewport',
        'interactable',
        'occludedByModal',
        'reason',
        'visible',
      ].sort()
    );
    for (const v of Object.values(r)) {
      expect(['boolean', 'string']).toContain(typeof v);
    }
  });
});

describe('P11-2 scrolling toward an off-screen target is bounded', () => {
  it('2.1 the published bounds are fixed constants', () => {
    expect(VIEWPORT_BOUNDS.maxAutoScrollPx).toBe(2400);
    expect(VIEWPORT_BOUNDS.scrollStepPx).toBe(600);
    expect(VIEWPORT_BOUNDS.maxScrollWalks).toBe(4);
  });

  it('2.2 a target already in the viewport needs no scroll', () => {
    const plan = planScrollToTarget({ top: 100, bottom: 140 }, { width: 1280, height: 800, scrollY: 0 });
    expect(plan).toBeNull();
    expect(isTargetInViewport({ top: 100, bottom: 140 }, { width: 1280, height: 800, scrollY: 0 })).toBe(true);
  });

  it('2.3 a target below the fold plans a downward scroll', () => {
    const plan = planScrollToTarget({ top: 1800, bottom: 1860 }, { width: 1280, height: 800, scrollY: 0 });
    expect(plan).not.toBeNull();
    expect(plan?.direction).toBe('down');
    expect(plan?.amount).toBeGreaterThan(0);
  });

  it('2.4 a target above the fold plans an upward scroll', () => {
    const plan = planScrollToTarget({ top: -2200, bottom: -2140 }, { width: 1280, height: 800, scrollY: 2400 });
    expect(plan?.direction).toBe('up');
  });

  it('2.5 a near-target still uses at least one bounded step', () => {
    const plan = planScrollToTarget({ top: 900, bottom: 940 }, { width: 1280, height: 800, scrollY: 0 });
    expect(plan?.amount).toBe(VIEWPORT_BOUNDS.scrollStepPx);
  });

  it('2.6 a far target is CLAMPED to maxAutoScrollPx — scrolling never runs away', () => {
    const plan = planScrollToTarget({ top: 90_000, bottom: 90_060 }, { width: 1280, height: 800, scrollY: 0 });
    expect(plan?.amount).toBe(VIEWPORT_BOUNDS.maxAutoScrollPx);
  });

  it('2.7 the scroll plan is emitted as a NORMAL scroll action, not a direct dispatch', () => {
    // The plan only ever returns direction+amount, and M5 still bounds it, so
    // the plan cannot bypass the validator, effect verification or recovery.
    const plan = planScrollToTarget({ top: 3000, bottom: 3060 }, { width: 1280, height: 800, scrollY: 0 });
    expect(Object.keys(plan ?? {}).sort()).toEqual(['amount', 'direction']);

    const action: BrowserAction = {
      action: 'scroll',
      direction: plan!.direction,
      amount: plan!.amount,
      reason: 'Scroll to reach the off-screen target.',
    };
    expect(validateAction(action, ctx()).allowed).toBe(true);
  });
});

describe('P11-3 pressKey is restricted to a fixed safe-key allowlist', () => {
  it('3.1 the allowlist is exactly the five non-destructive keys', () => {
    expect([...SAFE_KEYS]).toEqual(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown']);
  });

  it('3.2 every allowlisted key is accepted by the pure predicate', () => {
    for (const k of SAFE_KEYS) expect(isSafeKey(k)).toBe(true);
  });

  it('3.3 destructive, navigation and arbitrary key text is rejected', () => {
    for (const k of [
      'Delete',
      'Backspace',
      'F5',
      'Escape;',
      'a',
      'Shift',
      'Control',
      'Alt',
      'Meta',
      'PageDown',
      'Home',
      'End',
      '',
      '  ',
    ]) {
      expect(isSafeKey(k)).toBe(false);
    }
  });

  it('3.4 isTargetedAction distinguishes targeted from untargeted actions', () => {
    expect(isTargetedAction({ action: 'click', target: 'submit-button' })).toBe(true);
    expect(isTargetedAction({ action: 'pressKey', key: 'Enter', target: 'search-box' })).toBe(true);
    expect(isTargetedAction({ action: 'pressKey', key: 'Enter' })).toBe(false);
    expect(isTargetedAction({ action: 'scroll', direction: 'down', amount: 200 })).toBe(false);
  });
});

describe('P11-4 duplicate and ambiguous targets are handled deterministically', () => {
  it('4.1 a second click on the same target inside the window is suppressed', () => {
    const g = new DuplicateClickGuard(1200);
    expect(g.shouldClick('t', 1000)).toBe(true);
    expect(g.shouldClick('t', 1500)).toBe(false);
  });

  it('4.2 the window is per target, so a different target is unaffected', () => {
    const g = new DuplicateClickGuard(1200);
    expect(g.shouldClick('a', 0)).toBe(true);
    expect(g.shouldClick('b', 10)).toBe(true);
  });

  it('4.3 the same click becomes allowed again once the window expires', () => {
    const g = new DuplicateClickGuard(1200);
    expect(g.shouldClick('t', 0)).toBe(true);
    expect(g.shouldClick('t', 1300)).toBe(true);
  });

  it('4.4 ambiguous targets resolve deterministically through grounding', () => {
    // Two controls with the SAME label: grounding must be stable, not random.
    const ambiguous = ctx({
      detections: [
        det('submit-a', 'button', 'button#a', [20, 20, 100, 30], 'Submit'),
        det('submit-b', 'button', 'button#b', [140, 20, 100, 30], 'Submit'),
      ],
    });
    const proposed: BrowserAction = { action: 'click', target: 'Submit' };
    const a = groundProposedTarget(proposed, ambiguous.detections);
    const b = groundProposedTarget(proposed, ambiguous.detections);
    expect(a.grounded).toBe(true);
    expect(a.targetId).toBe(b.targetId);
    expect(a.confidence).toBe(b.confidence);
  });
});
