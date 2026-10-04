/**
 * PrivAgent — PHASE 18.7 / I-8: SEMANTIC PROGRESS FOCUSED TESTS.
 *
 * Covers the four required cases plus the positive/negative pairs, and pins the
 * structural claim that there is exactly ONE progress authority.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SEMANTIC_PROGRESS_BOUNDS,
  SemanticProgressTracker,
  classifyGeometry,
  classifySemanticProgress,
  semanticSignalsBetween,
  trailingAlternatingRun,
  type SemanticObservation,
} from '../extension/src/agent/semanticProgress';
import {
  DEFAULT_LONG_HORIZON_BOUNDS,
  LongHorizonTracker,
  assessProgress,
  detectStall,
  observeFromContext,
  toSemanticObservation,
  type TaskObservation,
} from '../extension/src/agent/longHorizon';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import type { BrowserAction } from '../extension/src/agent/actionTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

const DOC = 'https://en.wikipedia.org/wiki/Charminar';

function semObs(over: Partial<SemanticObservation> = {}): SemanticObservation {
  return {
    documentIdentity: DOC,
    entityIds: ['e1', 'e2'],
    candidateIds: ['c1', 'c2'],
    factIds: [],
    affordanceIds: [],
    scrollY: 0,
    targetValueLength: 0,
    viewportObservable: true,
    ...over,
  };
}

function lhObs(over: Partial<TaskObservation> = {}): TaskObservation {
  return {
    url: DOC,
    pageGeneration: 1,
    entityIds: ['e1', 'e2'],
    candidateIds: ['c1', 'c2'],
    scrollY: 0,
    targetValueLength: 0,
    viewportObservable: true,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CASE 4 — geometry alone is NEVER progress
// ═══════════════════════════════════════════════════════════════════════════

describe('I-8 CASE 4 · scrolling geometry is not semantic progress', () => {
  it('a 500px scroll that teaches nothing is NOT meaningful', () => {
    const v = classifySemanticProgress({
      previous: semObs({ scrollY: 0 }),
      current: semObs({ scrollY: 500 }),
      scrollDirection: 'down',
    });
    expect(v.meaningful).toBe(false);
    expect(v.signals).toEqual([]);
    // Geometry is RECORDED, never counted.
    expect(v.geometry).toBe('GEOMETRY_CHANGED');
  });

  it('the same holds through the pre-existing assessProgress decision function', () => {
    const r = assessProgress(lhObs({ scrollY: 0 }), lhObs({ scrollY: 500 }));
    expect(r.meaningful).toBe(false);
    expect(r.signals).toEqual([]);
    expect(r.geometry).toBe('GEOMETRY_CHANGED');
  });

  it('an UNOBSERVABLE viewport is neither progress nor a stall signal', () => {
    // Phase 17.4 contract, preserved: "we could not read it" is not "it did not
    // move", and neither is "the page changed".
    expect(classifyGeometry(semObs(), semObs({ scrollY: 900, viewportObservable: false }))).toBe(
      'GEOMETRY_UNOBSERVABLE'
    );
    const v = classifySemanticProgress({
      previous: semObs({ scrollY: 0, viewportObservable: false }),
      current: semObs({ scrollY: 900, viewportObservable: false }),
      scrollDirection: 'down',
    });
    expect(v.meaningful).toBe(false);
  });

  it('POSITIVE: a real state change IS meaningful', () => {
    const cases: Array<[string, Partial<SemanticObservation>, Partial<SemanticObservation>]> = [
      ['EVIDENCE_DELTA', {}, {}], // asserted separately below (needs a delta arg)
      ['PAGE_IDENTITY_CHANGED', {}, { documentIdentity: `${DOC}#history` + '/other' }],
      ['NEW_ENTITY', {}, { entityIds: ['e1', 'e2', 'e3'] }],
      ['NEW_CANDIDATE', {}, { candidateIds: ['c1', 'c2', 'c3'] }],
      ['NEW_SEMANTIC_FACT', {}, { factIds: ['year'] }],
      ['NEW_AFFORDANCE', {}, { affordanceIds: ['a1'] }],
      ['TARGET_VALUE_CHANGED', {}, { targetValueLength: 7 }],
    ];
    for (const [expected, prevOver, curOver] of cases) {
      if (expected === 'EVIDENCE_DELTA') {
        expect(
          classifySemanticProgress({ previous: semObs(prevOver), current: semObs(curOver), evidenceDelta: 1 })
            .signals
        ).toContain('EVIDENCE_DELTA');
        continue;
      }
      const v = classifySemanticProgress({ previous: semObs(prevOver), current: semObs(curOver) });
      expect(v.signals, expected).toContain(expected);
      expect(v.meaningful, expected).toBe(true);
    }
  });

  it('losing an id is not discovery; gaining one is', () => {
    // Removal alone learns nothing. A genuinely new id does — the vocabulary is
    // deliberately "an id that was not there before", not "the count grew".
    expect(
      classifySemanticProgress({
        previous: semObs({ candidateIds: ['c1', 'c2'] }),
        current: semObs({ candidateIds: ['c1'] }),
      }).meaningful
    ).toBe(false);
    expect(
      classifySemanticProgress({
        previous: semObs({ candidateIds: ['c1'] }),
        current: semObs({ candidateIds: ['c1', 'c9'] }),
      }).meaningful
    ).toBe(true);
  });

  it('a fragment-only URL change is still the same document (17.3 preserved)', () => {
    expect(
      assessProgress(lhObs({ url: 'http://x/p#a' }), lhObs({ url: 'http://x/p#b' })).meaningful
    ).toBe(false);
    expect(
      assessProgress(lhObs({ url: 'http://x/p' }), lhObs({ url: 'http://x/q' })).signals
    ).toContain('NEW_PAGE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CASE 1 — DOWN ×3 with no evidence → NO_EFFECT / NO_PROGRESS
// ═══════════════════════════════════════════════════════════════════════════

describe('I-8 CASE 1 · repeated same-direction scrolling drains a bounded budget', () => {
  it('DOWN, DOWN, DOWN with no new evidence is NO_EFFECT on the third', () => {
    const t = new SemanticProgressTracker();
    // The baseline observation. Its first verdict is meaningful by construction
    // (a page relative to nothing), which is why the budget is charged from the
    // SECOND observation, not the first.
    let prev: SemanticObservation | null = semObs({ scrollY: 0 });
    t.evaluate({ previous: null, current: prev, scrollDirection: null });

    const verdicts = [500, 1000, 1500].map((scrollY) => {
      const cur = semObs({ scrollY });
      const v = t.evaluate({ previous: prev, current: cur, scrollDirection: 'down' });
      prev = cur;
      return v;
    });

    expect(verdicts[0]!.stagnation).toBe('NONE');
    expect(verdicts[1]!.stagnation).toBe('NONE');
    expect(verdicts[2]!.stagnation).toBe('NO_EFFECT');
    expect(verdicts[2]!.budgetExhausted).toBe(true);
    expect(verdicts.every((v) => v.geometry === 'GEOMETRY_CHANGED')).toBe(true);
  });

  it('the budget is a bound, and it is the tracker own no-progress ceiling', () => {
    expect(DEFAULT_SEMANTIC_PROGRESS_BOUNDS.maxSameDirectionWithoutProgress).toBe(
      DEFAULT_LONG_HORIZON_BOUNDS.maxConsecutiveNoProgress
    );
  });

  it('a productive scroll clears the budget completely', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = semObs({ scrollY: 0 });
    t.evaluate({ previous: null, current: prev, scrollDirection: null });
    const run = (scrollY: number, evidenceDelta = 0) => {
      const cur = semObs({ scrollY });
      const v = t.evaluate({ previous: prev, current: cur, scrollDirection: 'down', evidenceDelta });
      prev = cur;
      return v;
    };
    run(500, 1);
    run(1000, 1);
    expect(run(1500).sameDirectionRun).toBe(1);
    expect(run(2000).sameDirectionRun).toBe(2);
    // The third consecutive unproductive scroll exhausts it again.
    const exhausted = run(2500);
    expect(exhausted.stagnation).toBe('NO_EFFECT');
  });

  it('the tracker reports OSCILLATION-free NO_EFFECT for pure repetition', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = semObs({ scrollY: 0 });
    t.evaluate({ previous: null, current: prev, scrollDirection: null });
    const kinds: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const cur = semObs({ scrollY: i * 500 });
      kinds.push(t.evaluate({ previous: prev, current: cur, scrollDirection: 'down' }).stagnation);
      prev = cur;
    }
    expect(kinds).not.toContain('OSCILLATION');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CASE 2 — DOWN → UP → DOWN → UP with no evidence → OSCILLATION
// ═══════════════════════════════════════════════════════════════════════════

describe('I-8 CASE 2 · alternating scroll directions are OSCILLATION', () => {
  it('DOWN, UP, DOWN, UP with no evidence is detected on the fourth', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = semObs({ scrollY: 0 });
    t.evaluate({ previous: null, current: prev, scrollDirection: null });
    const dirs: Array<'up' | 'down'> = ['down', 'up', 'down', 'up'];
    const kinds: string[] = [];
    dirs.forEach((direction, i) => {
      const cur = semObs({ scrollY: i % 2 === 0 ? 500 : 0 });
      kinds.push(t.evaluate({ previous: prev, current: cur, scrollDirection: direction }).stagnation);
      prev = cur;
    });
    expect(kinds.slice(0, 3)).toEqual(['NONE', 'NONE', 'NONE']);
    expect(kinds[3]).toBe('OSCILLATION');
  });

  it('OSCILLATION dominates NO_EFFECT when both are true', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = semObs({ scrollY: 0 });
    t.evaluate({ previous: null, current: prev, scrollDirection: null });
    let last = t.snapshot();
    // Four identical directions would already report NO_EFFECT; the reversal
    // that follows turns it into OSCILLATION, which is the stronger truth.
    for (const d of ['down', 'down', 'down', 'down', 'up', 'down', 'up'] as Array<'up' | 'down'>) {
      const cur = semObs({ scrollY: 0 });
      last = t.evaluate({ previous: prev, current: cur, scrollDirection: d });
      prev = cur;
    }
    expect(last.stagnation).toBe('OSCILLATION');
    expect(last.budgetExhausted).toBe(true);
  });

  it('trailingAlternatingRun counts only the strictly alternating tail', () => {
    expect(trailingAlternatingRun([])).toBe(0);
    expect(trailingAlternatingRun(['down'])).toBe(1);
    expect(trailingAlternatingRun(['down', 'up'])).toBe(2);
    expect(trailingAlternatingRun(['down', 'up', 'down'])).toBe(3);
    expect(trailingAlternatingRun(['down', 'up', 'up', 'down'])).toBe(2);
  });

  it('A, B, A, B fingerprints are still an alternating loop (17.4 preserved)', () => {
    const a = lhObs({ url: 'http://x/1' });
    const b = lhObs({ url: 'http://x/2' });
    const t = new LongHorizonTracker();
    t.initialize('g');
    t.observe(a);
    t.observe(b);
    t.observe(a);
    t.observe(b);
    expect(t.detectLoop().kind).toBe('ALTERNATING_LOOP');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CASE 3 — productive scrolling must NOT be flagged
// ═══════════════════════════════════════════════════════════════════════════

describe('I-8 CASE 3 · productive scrolling stays productive', () => {
  it('DOWN → new evidence → DOWN → new evidence never trips the budget', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = null;
    const seen = [0, 500, 1000, 1500, 2000, 2500, 3000].map((scrollY, i) => {
      const cur = semObs({ scrollY });
      const v = t.evaluate({ previous: prev, current: cur, scrollDirection: 'down', evidenceDelta: 1 });
      prev = cur;
      return v;
    });
    expect(seen.every((v) => v.meaningful)).toBe(true);
    expect(seen.every((v) => v.stagnation === 'NONE')).toBe(true);
    expect(seen.every((v) => v.budgetExhausted === false)).toBe(true);
    expect(seen.every((v) => v.sameDirectionRun === 0)).toBe(true);
  });

  it('newly discovered candidates also keep the scroll strategy alive', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = null;
    for (let i = 1; i <= 8; i++) {
      const cur = semObs({ scrollY: i * 500, candidateIds: ['c1', 'c2', `c${i}`] });
      const v = t.evaluate({ previous: prev, current: cur, scrollDirection: 'down' });
      expect(v.stagnation, `scroll ${i}`).toBe('NONE');
      prev = cur;
    }
  });

  it('a productive scroll CLEARS a partially charged budget', () => {
    // The mutation-relevant half of CASE 3: it is not enough that every cycle is
    // productive. A run that has ALREADY spent two unproductive scrolls must be
    // restored to zero by the next genuinely productive one, so a page that
    // alternates "nothing here" with "here is the fact" is never declared
    // stagnant.
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = semObs({ scrollY: 0 });
    t.evaluate({ previous: null, current: prev, scrollDirection: null });
    const step = (scrollY: number, evidenceDelta: number) => {
      const cur = semObs({ scrollY });
      const v = t.evaluate({ previous: prev, current: cur, scrollDirection: 'down', evidenceDelta });
      prev = cur;
      return v;
    };
    expect(step(500, 0).sameDirectionRun).toBe(1);
    expect(step(1000, 0).sameDirectionRun).toBe(2);
    // Third in a row would exhaust; the middle productive one must reset it.
    const productive = step(1500, 1);
    expect(productive.meaningful).toBe(true);
    expect(productive.sameDirectionRun).toBe(0);
    expect(step(2000, 0).sameDirectionRun).toBe(1);
    const third = step(2500, 0);
    expect(third.stagnation).toBe('NONE');
    expect(step(3000, 0).stagnation).toBe('NO_EFFECT');
  });

  it('an alternating but PRODUCTIVE sequence is not oscillation', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = null;
    for (const [i, d] of (['down', 'up', 'down', 'up'] as const).entries()) {
      const cur = semObs({ scrollY: i * 400, entityIds: ['e1', 'e2', `e${i}`] });
      expect(t.evaluate({ previous: prev, current: cur, scrollDirection: d, evidenceDelta: 1 }).stagnation).toBe(
        'NONE'
      );
      prev = cur;
    }
  });

  it('a non-scroll action never charges the scroll budget', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = null;
    for (let i = 0; i < 6; i++) {
      const cur = semObs({ scrollY: i * 500 });
      const v = t.evaluate({ previous: prev, current: cur, scrollDirection: null });
      expect(v.sameDirectionRun).toBe(0);
      expect(v.budgetExhausted).toBe(false);
      prev = cur;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pre-existing semantics are not weakened
// ═══════════════════════════════════════════════════════════════════════════

describe('I-8 · the Phase 17.4 progress contract is not weakened', () => {
  it('an identical observation is still not progress', () => {
    expect(assessProgress(lhObs(), lhObs()).meaningful).toBe(false);
  });

  it('a completed subgoal alone is still not progress', () => {
    expect(assessProgress(lhObs(), lhObs(), { subgoalJustCompleted: 'sg-1' }).meaningful).toBe(false);
  });

  it('a new candidate still is progress', () => {
    const r = assessProgress(lhObs({ candidateIds: ['c1'] }), lhObs({ candidateIds: ['c1', 'c2'] }));
    expect(r.meaningful).toBe(true);
    expect(r.signals).toContain('NEW_CANDIDATE');
  });

  it('the first observation is meaningful (a page relative to nothing)', () => {
    expect(assessProgress(null, lhObs()).meaningful).toBe(true);
  });

  it('detectStall still needs the configured count, and now reports WHICH kind', () => {
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    t.initialize('g');
    const cur = lhObs();
    // 4 no-progress cycles: 3 of the same direction, then one reversal.
    for (const d of ['down', 'down', 'down', 'up'] as const) {
      t.observe({ ...cur, scrollY: 0 }, { action: 'scroll', direction: d });
    }
    const stall = t.detectStall();
    expect(stall.stalled).toBe(true);
    expect(stall.kind).toBe('NONE'); // reversal cleared the same-direction run
    t.observe({ ...cur, scrollY: 0 }, { action: 'scroll', direction: 'down' });
    t.observe({ ...cur, scrollY: 0 }, { action: 'scroll', direction: 'up' });
    expect(t.detectStall().kind).toBe('OSCILLATION');
  });

  it('observeFromContext carries fact and affordance ids (ids/keys only)', () => {
    const ctx = {
      url: DOC,
      timestamp: 1,
      viewport: { width: 1, height: 1, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: [],
      total_elements_scanned: 0,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
      semantic_context: {
        pageType: 'ARTICLE',
        confidence: 1,
        pageState: 'STABLE',
        pageGeneration: 1,
        entities: [],
        affordances: [{ id: 'aff-1', type: 'CLICK', requiresConfirmation: false, description: 'd' }],
        promptInjectionDetected: false,
        facts: [
          {
            key: 'year',
            label: 'Year',
            displayText: '1591',
            displayValue: 1591,
            valueKind: 'numeric',
            untrusted: true,
          },
        ],
      },
    } as unknown as AgentContextPayload;
    const o = observeFromContext(ctx);
    expect(o.factIds).toEqual(['year']);
    expect(o.affordanceIds).toEqual(['aff-1']);
    // No display text ever enters loop state.
    expect(JSON.stringify(o)).not.toContain('1591');
  });

  it('toSemanticObservation round-trips without inventing ids', () => {
    expect(toSemanticObservation(lhObs()).factIds).toEqual([]);
    expect(toSemanticObservation(lhObs({ factIds: ['a'] })).factIds).toEqual(['a']);
  });

  it('semanticSignalsBetween is empty for an identical pair', () => {
    expect(semanticSignalsBetween(semObs(), semObs())).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Single-authority structural proof
// ═══════════════════════════════════════════════════════════════════════════

describe('I-8 · there is exactly ONE progress authority', () => {
  const root = join(__dirname, '..', 'extension', 'src');

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  it('only longHorizon.ts imports semanticProgress in production code', () => {
    const importers = walk(root)
      .filter((f) => readFileSync(f, 'utf8').includes("from './semanticProgress'") || readFileSync(f, 'utf8').includes('agent/semanticProgress'))
      .map((f) => f.slice(root.length + 1));
    expect(importers).toEqual([join('agent', 'longHorizon.ts')]);
  });

  it('the module itself declares no authority vocabulary', () => {
    // Comments legitimately say "never authorizes an action", so the check runs
    // on the executable surface only.
    const src = readFileSync(join(root, 'agent', 'semanticProgress.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      'SUCCESS',
      'authoriz',
      'dispatch',
      'execute',
      'groundProposedTarget',
      'validateAction',
      'securityCritic',
      'riskEngine',
      'containment',
    ]) {
      expect(src.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  it('the tracker never grows its direction ring with task length', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = null;
    for (let i = 0; i < 200; i++) {
      const cur = semObs({ scrollY: i * 500 });
      t.evaluate({ previous: prev, current: cur, scrollDirection: i % 2 ? 'up' : 'down' });
      prev = cur;
    }
    expect(t.snapshot().directionSequence.length).toBeLessThanOrEqual(16);
  });

  it('reset clears the budget so a new task gets a full one', () => {
    const t = new SemanticProgressTracker();
    let prev: SemanticObservation | null = semObs({ scrollY: 0 });
    t.evaluate({ previous: null, current: prev, scrollDirection: null });
    for (let i = 1; i <= 3; i++) {
      const cur = semObs({ scrollY: i * 500 });
      t.evaluate({ previous: prev, current: cur, scrollDirection: 'down' });
      prev = cur;
    }
    expect(t.snapshot().stagnation).toBe('NO_EFFECT');
    t.reset();
    expect(t.snapshot().stagnation).toBe('NONE');
    expect(t.snapshot().sameDirectionRun).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end through the real AgentLoop
// ═══════════════════════════════════════════════════════════════════════════

const loopContext = (scrollY: number, candidateIds: string[]): AgentContextPayload =>
  ({
    url: DOC,
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: scrollY },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 3,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 1, sensitive_detected: 0, latency_ms: 1 },
    detections: candidateIds.map((id) => ({
      id,
      type: 'element',
      selector: `#${id}`,
      confidence: 0.95,
      bbox: { x: 1, y: 1, width: 10, height: 10 },
      length: 0,
      source: 'dom_attribute',
      is_partially_visible: false,
    })),
  }) as unknown as AgentContextPayload;

describe('I-8 · the real loop stops scrolling instead of running to maxSteps', () => {
  it('CASE 1 end-to-end: useless downward scrolling is bounded and truthful', async () => {
    let dispatchedScrolls = 0;
    const provider = {
      name: 'UselessScrollProvider',
      requestAction: async (): Promise<BrowserAction> => {
        return { action: 'scroll', direction: 'down', amount: 500 };
      },
    };
    let scrollY = 0;
    let cycle = 0;
    const loop = new AgentLoop(
      provider as never,
      {
        perceivePage: async () => loopContext(scrollY, ['c1', 'c2']),
        executeAction: async (a: BrowserAction) => {
          if (a.action === 'scroll') {
            dispatchedScrolls++;
            scrollY += 500;
          }
          return { success: true };
        },
        // The page genuinely MOVES: effect verification must pass, so the run
        // cannot be rescued by the effect verifier. Only the semantic view can
        // see that nothing was learned.
        getEffectSnapshot: async () => ({
          url: DOC,
          scrollX: 0,
          scrollY: scrollY + 500,
          domElementCount: 3,
          timestamp: Date.now() + cycle++,
        }),
      },
      { maxSteps: 10, maxRetries: 2, delayBetweenStepsMs: 1, runId: 8081 }
    );

    const state = await loop.runTask('tell me about charminar');

    expect(dispatchedScrolls).toBeLessThanOrEqual(4);
    expect(dispatchedScrolls).toBeGreaterThan(0);
    expect(state.status).not.toBe('SUCCESS');
    expect(state.goalStatus).not.toBe('SUCCESS');
    // NOT "exceeded maximum step limit": the run ended on an observation-backed
    // bound, which is the truthful reason.
    expect(state.reason ?? '').not.toContain('maximum step limit');
    expect(state.reason ?? '').toMatch(/no-progress|ACTION_NO_EFFECT|Scroll/i);
    // The exhausted-strategy refusals are recorded truthfully as not-dispatched.
    const refusals = state.steps.filter((s) =>
      (s.validationReason ?? '').startsWith('SCROLL_STRATEGY_EXHAUSTED')
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((s) => s.validationAllowed === false)).toBe(true);
    expect(state.longHorizon?.semanticProgress.stagnation).toMatch(/NO_EFFECT|OSCILLATION/);
  });

  it('CASE 3 end-to-end: scrolling that keeps finding new content keeps working', async () => {
    let dispatchedScrolls = 0;
    const provider = {
      name: 'ProductiveScrollProvider',
      requestAction: async (): Promise<BrowserAction> => ({ action: 'scroll', direction: 'down', amount: 500 }),
    };
    let scrollY = 0;
    const loop = new AgentLoop(
      provider as never,
      {
        // Every scroll genuinely reveals a NEW candidate id — real semantic
        // progress, and the exact condition that must not be misread as a loop.
        perceivePage: async () => loopContext(scrollY, ['c1', `c${dispatchedScrolls + 2}`]),
        executeAction: async (a: BrowserAction) => {
          if (a.action === 'scroll') {
            dispatchedScrolls++;
            scrollY += 500;
          }
          return { success: true };
        },
        getEffectSnapshot: async () => ({
          url: DOC,
          scrollX: 0,
          scrollY: scrollY + 500,
          domElementCount: dispatchedScrolls + 3,
          timestamp: Date.now(),
        }),
      },
      { maxSteps: 10, maxRetries: 2, delayBetweenStepsMs: 1, runId: 8082 }
    );

    const state = await loop.runTask('tell me about charminar');
    expect(dispatchedScrolls).toBeGreaterThanOrEqual(4);
    expect(state.steps.filter((s) => (s.validationReason ?? '').startsWith('SCROLL_STRATEGY_EXHAUSTED'))).toHaveLength(0);
    expect(state.longHorizon?.semanticProgress.budgetExhausted).toBe(false);
    expect(state.longHorizon?.semanticProgress.stagnation).toBe('NONE');
  });
});
