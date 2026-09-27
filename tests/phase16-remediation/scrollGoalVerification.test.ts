/**
 * Phase 16 P0 remediation — DEFECT 2: scroll-goal false success.
 *
 * A scroll goal used to return SUCCESS whenever `previousActions` contained a
 * scroll. It now requires OBSERVED browser state, and fails closed when the
 * observed state cannot establish the claim.
 *
 * These tests encode the six required properties. Every "satisfiable" case is
 * built ONLY from values the real perception pipeline supplies:
 *   - `context.viewport.scroll_y` / `.height`  — live observed viewport
 *   - `context.detections[].bbox`              — document-absolute (rect.top + scrollY)
 *   - `state.initialScrollY` / `.observedScrollY` — captured from those same cycles
 *
 * No synthetic browser state, and never a proposed action or a requested
 * amount as proof.
 */

import { describe, it, expect } from 'vitest';
import { verifyTaskGoal, parseScrollGoal } from '../../extension/src/agent/goalVerifier';
import type { AgentContextPayload, AgentDetection } from '../../extension/src/privacy/types';
import type { AgentTaskState } from '../../extension/src/agent/agentState';

const VIEWPORT_H = 900;

/** A context built exactly as the real pipeline builds one. */
const ctx = (scrollY: number, detections: AgentDetection[] = []): AgentContextPayload =>
  ({
    sanitized_status: 'sanitized_only',
    detections,
    url: 'http://localhost:4200/long',
    viewport: { width: 1280, height: VIEWPORT_H, scroll_x: 0, scroll_y: scrollY },
  }) as unknown as AgentContextPayload;

/** State carrying only observed scroll positions, plus optional action history. */
const state = (o: {
  initialScrollY?: number | null;
  observedScrollY?: number | null;
  previousActions?: unknown[];
}): AgentTaskState =>
  ({
    steps: [],
    previousActions: o.previousActions ?? [],
    pageType: 'other',
    visitedElementIds: [],
    taskConstraints: {},
    candidateItems: [],
    recoveryHistory: [],
    totalRecoveryAttempts: 0,
    plan: { recoveryAttempts: 0 },
    initialScrollY: o.initialScrollY ?? null,
    observedScrollY: o.observedScrollY ?? null,
  }) as unknown as AgentTaskState;

/** A detection at a document-absolute y, as domDetector emits (rect.top + scrollY). */
const detAt = (id: string, y: number, height = 40): AgentDetection =>
  ({
    id, type: 'section', selector: `#${id}`, label: id,
    confidence: 0.9, length: 0, source: 'dom_attribute',
    bbox: { x: 0, y, width: 200, height },
  }) as unknown as AgentDetection;

const TARGET_TASK = 'open http://localhost:4200/long and scroll down to the pricing section';

describe('P0.1 scrollY=0 cannot satisfy a goal requiring a later position', () => {
  it('a section 3000px down is not satisfied at the top of the page', () => {
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 0 }), ctx(0, [detAt('pricing', 3000)]));
    expect(r.satisfied).toBe(false);
    expect(r.status).toBe('IN_PROGRESS');
  });

  it('a section already inside the first viewport IS satisfied at scrollY=0', () => {
    // Correct behaviour, and the reason the fix is observation-based rather
    // than "did we scroll?": at scrollY=0 the viewport spans 0..900, so a
    // section at 500px is genuinely visible and the goal IS met.
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 0 }), ctx(0, [detAt('pricing', 500)]));
    expect(r.satisfied).toBe(true);
  });

  it('a section just below the fold is not satisfied at scrollY=0', () => {
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 0 }), ctx(0, [detAt('pricing', VIEWPORT_H + 1)]));
    expect(r.satisfied).toBe(false);
  });
});

describe('P0.2 scrollY=500 cannot satisfy a goal requiring ~3000px', () => {
  it('the exact Phase 16 live scenario now fails closed', () => {
    // LIVE EVIDENCE THAT PRODUCED THE DEFECT:
    //   requested: scroll toward the pricing section
    //   observed : scrollY 500 on a page where the section is ~3000px down
    //   old      : SUCCESS
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 500 }), ctx(500, [detAt('pricing', 3000)]));
    expect(r.satisfied).toBe(false);
    expect(r.status).toBe('IN_PROGRESS');
  });

  it('an element still below the viewport is not satisfied, whatever the history says', () => {
    const r = verifyTaskGoal(
      TARGET_TASK,
      state({ initialScrollY: 0, observedScrollY: 500, previousActions: [{ action: 'scroll' }, { action: 'scroll' }] }),
      ctx(500, [detAt('pricing', 2999)])
    );
    expect(r.satisfied).toBe(false);
  });
});

describe('P0.3 a genuinely satisfied scroll goal still returns SUCCESS', () => {
  it('the target is inside the observed viewport', () => {
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 2950 }), ctx(2950, [detAt('pricing', 3000)]));
    expect(r.satisfied).toBe(true);
    expect(r.status).toBe('SUCCESS');
    expect(r.reason).toMatch(/observed viewport/);
  });

  it('a partly-visible target counts — reaching the section is enough', () => {
    // section top at 3000, viewport spans 2950..3850; the box straddles the top.
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 2990 }), ctx(2990, [detAt('pricing', 3000)]));
    expect(r.satisfied).toBe(true);
  });

  it('a named section is matched on its real id, selector or label', () => {
    for (const d of [
      detAt('pricing', 3000),
      { ...detAt('other', 3000), selector: '#pricing-section' } as AgentDetection,
      { ...detAt('other', 3000), label: 'Pricing' } as AgentDetection,
    ]) {
      const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 2900 }), ctx(2900, [d]));
      expect(r.satisfied).toBe(true);
    }
  });
});

describe('P0.4 previousActions alone can never cause SUCCESS', () => {
  it('many scroll actions at the top of the page do not satisfy a target goal', () => {
    const r = verifyTaskGoal(
      TARGET_TASK,
      state({ initialScrollY: 0, observedScrollY: 0, previousActions: Array.from({ length: 20 }, () => ({ action: 'scroll' })) }),
      ctx(0, [detAt('pricing', 3000)])
    );
    expect(r.satisfied).toBe(false);
  });

  it('a distance goal with a zero observed delta does not satisfy', () => {
    const r = verifyTaskGoal(
      'scroll down 500px',
      state({ initialScrollY: 100, observedScrollY: 100, previousActions: [{ action: 'scroll', amount: 500 }] }),
      ctx(100)
    );
    expect(r.satisfied).toBe(false);
  });

  it('a distance goal with the OBSERVED delta satisfied does succeed', () => {
    const r = verifyTaskGoal(
      'scroll down 500px',
      state({ initialScrollY: 100, observedScrollY: 640, previousActions: [{ action: 'scroll', amount: 500 }] }),
      ctx(640)
    );
    expect(r.satisfied).toBe(true);
    expect(r.reason).toMatch(/observed 540px of down travel/);
  });

  it('a bare direction goal needs OBSERVED movement, not a recorded action', () => {
    const moved = verifyTaskGoal('scroll down', state({ initialScrollY: 0, observedScrollY: 120 }), ctx(120));
    expect(moved.satisfied).toBe(true);
    const notMoved = verifyTaskGoal('scroll down', state({ initialScrollY: 0, observedScrollY: 0, previousActions: [{ action: 'scroll' }] }), ctx(0));
    expect(notMoved.satisfied).toBe(false);
  });

  it('scrolling the WRONG way does not satisfy a down goal', () => {
    const r = verifyTaskGoal('scroll down 200px', state({ initialScrollY: 1000, observedScrollY: 800 }), ctx(800));
    expect(r.satisfied).toBe(false);
  });
});

describe('P0.5 unavailable or unobservable state fails closed', () => {
  it('no observed scroll position at all', () => {
    const noViewport = { sanitized_status: 'sanitized_only', detections: [detAt('pricing', 3000)], url: 'http://x/' } as unknown as AgentContextPayload;
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: null, observedScrollY: null }), noViewport);
    expect(r.satisfied).toBe(false);
  });

  it('a missing baseline for a distance goal', () => {
    const r = verifyTaskGoal('scroll down 500px', state({ initialScrollY: null, observedScrollY: 900 }), ctx(900));
    expect(r.satisfied).toBe(false);
  });

  it('a named target that matches nothing on the page', () => {
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 2950 }), ctx(2950, [detAt('footer', 3000)]));
    expect(r.satisfied).toBe(false);
  });

  it('"scroll to the bottom" cannot be decided and fails closed', () => {
    // Document height is not carried in the sanitized context, so this must
    // NOT be assumed satisfied.
    const r = verifyTaskGoal('scroll to the bottom of the page', state({ initialScrollY: 0, observedScrollY: 99999, previousActions: [{ action: 'scroll' }] }), ctx(99999));
    expect(r.satisfied).toBe(false);
  });

  it('a detection with no usable geometry', () => {
    const broken = { id: 'pricing', type: 'section', selector: '#pricing', label: 'pricing' } as unknown as AgentDetection;
    const r = verifyTaskGoal(TARGET_TASK, state({ initialScrollY: 0, observedScrollY: 2950 }), ctx(2950, [broken]));
    expect(r.satisfied).toBe(false);
  });
});

describe('P0.6 existing non-scroll goal behaviour is preserved', () => {
  it('a typed-but-unsubmitted search is still not success', () => {
    const s = state({});
    (s as unknown as { previousActions: unknown[] }).previousActions = [{ action: 'type' }];
    const c = { sanitized_status: 'sanitized_only', detections: [], url: 'http://localhost:4200/', viewport: { width: 1, height: 1, scroll_x: 0, scroll_y: 0 } } as unknown as AgentContextPayload;
    const r = verifyTaskGoal('search cats', s, c);
    expect(r.satisfied).toBe(false);
  });

  it('an observed search result URL is still success', () => {
    const s = state({});
    const c = { sanitized_status: 'sanitized_only', detections: [], url: 'http://localhost:4200/results?q=cats', viewport: { width: 1, height: 1, scroll_x: 0, scroll_y: 0 } } as unknown as AgentContextPayload;
    const r = verifyTaskGoal('search cats', s, c);
    expect(r.satisfied).toBe(true);
  });

  it('a "details" goal is unchanged — still click-based', () => {
    const s = state({ previousActions: [{ action: 'click' }] });
    const r = verifyTaskGoal('open the details section', s, ctx(0));
    expect(r.satisfied).toBe(true);
  });
});

describe('P0 parseScrollGoal recognises the real shapes', () => {
  it('classifies each claim shape', () => {
    expect(parseScrollGoal('scroll down 500px')).toMatchObject({ kind: 'distance', direction: 'down', amountPx: 500 });
    expect(parseScrollGoal('scroll up 200 pixels')).toMatchObject({ kind: 'distance', direction: 'up', amountPx: 200 });
    expect(parseScrollGoal('scroll to the pricing section')).toMatchObject({ kind: 'target', targetTerms: ['pricing'] });
    expect(parseScrollGoal('scroll to the bottom')).toMatchObject({ kind: 'boundary' });
    expect(parseScrollGoal('scroll down')).toMatchObject({ kind: 'direction', direction: 'down' });
    expect(parseScrollGoal('open the products page')).toBeNull();
  });

  it('does not treat a distance figure inside a URL as a scroll distance', () => {
    const r = parseScrollGoal('scroll to https://example.com/page500');
    expect(r?.kind).not.toBe('distance');
  });
});
