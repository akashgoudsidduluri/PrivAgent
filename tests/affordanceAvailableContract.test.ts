/**
 * PrivAgent — POST-17.10: the `AFFORDANCE_AVAILABLE` verification contract.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `goalProgressTracker.ts` documents one rule and holds itself to it:
 *
 *   "Absence of evidence is never evidence of completion."
 *
 * Phase 17.6 applied that rule to five of the seven declared condition types
 * and counted them ("Five of the seven"). `AFFORDANCE_AVAILABLE` was the
 * holdout: with no `expectedValue` it degraded to `affordances.length > 0`.
 *
 * That test is VACUOUS, not merely loose. `discoverActionAffordances` appends
 * a `SCROLL` affordance unconditionally for every document
 * (`actionAffordance.ts`), so the condition was satisfied by any page at all —
 * including one with zero interactive controls. It was a verification that
 * could not fail.
 *
 * The condition is now the seventh type to require a NAMED affordance that is
 * actually observed, and an unnamed `AFFORDANCE_AVAILABLE` fails closed like
 * its six siblings. The two decomposer producers that CAN be named are wired
 * (`ENTER_QUERY`); the two that would need destination ontology or an
 * "existence" observation are left deliberately unchanged and documented.
 *
 * Every assertion is written so that a mutation restoring the old behaviour
 * makes it fail. See scratch/mutation_affordance_contract.mjs.
 */

import { describe, it, expect } from 'vitest';

import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';

const ORIGIN = 'http://localhost:4174';

const ctx = (over: Partial<AgentContextPayload> = {}): AgentContextPayload =>
  ({
    url: `${ORIGIN}/product/alpha-widget`,
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    viewportObservable: true,
    screenshot_dimensions: null,
    detections: [],
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
    description: 'Open the catalog',
    category: 'NAVIGATE',
    state: 'IN_PROGRESS',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
    ...over,
  }) as Subgoal;

const cond = (type: string, expectedValue?: string) =>
  ({ type, expectedValue, description: 'test condition' } as Subgoal['verificationCondition']);

/** A context whose observed affordance set is exactly `types`. */
const withAffordances = (types: string[], over: Partial<AgentContextPayload> = {}) =>
  ctx({
    ...over,
    semantic_context: {
      pageType: 'product_detail',
      confidence: 0.9,
      pageState: 'populated',
      pageGeneration: 1,
      entities: [],
      affordances: types.map((t, i) => ({
        id: `af_${i}`,
        type: t as never,
        targetElementId: `el_${i}`,
        requiresConfirmation: false,
        description: `${t} affordance`,
      })),
    } as never,
  });

const verify = (sg: Subgoal, context: AgentContextPayload) =>
  GoalProgressTracker.verifySubgoalCondition(sg, { context, pageGeneration: 1 });

// ══════════════════════════════════════════════════════════════════════════════
// A named affordance claim is proven or refuted from the OBSERVED set
// ══════════════════════════════════════════════════════════════════════════════

describe('AFFORDANCE_AVAILABLE · a named claim is answerable', () => {
  it('1. expectedValue="add_to_cart" + observed add_to_cart → true', () => {
    const v = verify(
      subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE', 'add_to_cart') }),
      withAffordances(['add_to_cart'])
    );
    expect(v.satisfied).toBe(true);
    expect(v.reason).toContain('add_to_cart');
  });

  it('2. expectedValue="add_to_cart" + observed checkout → false', () => {
    const v = verify(
      subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE', 'add_to_cart') }),
      withAffordances(['checkout'])
    );
    expect(v.satisfied).toBe(false);
  });

  it('6. an arbitrary affordance never satisfies a DIFFERENT named claim', () => {
    for (const observed of ['ADD_TO_CART', 'BUY_NOW', 'SELECT_RESULT', 'SCROLL', 'ENTER_QUERY']) {
      const v = verify(
        subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE', 'REVIEW_ORDER') }),
        withAffordances([observed])
      );
      expect(v.satisfied, observed).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The contract violation: an UNNAMED claim is not evidence
// ══════════════════════════════════════════════════════════════════════════════

describe('AFFORDANCE_AVAILABLE · an unnamed claim fails closed', () => {
  it('3. empty expectedValue → false, even with affordances observed', () => {
    const v = verify(
      subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE', '') }),
      withAffordances(['ADD_TO_CART', 'BUY_NOW', 'ENTER_QUERY'])
    );
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/no named affordance/i);
  });

  it('4. undefined expectedValue → false, even with affordances observed', () => {
    const v = verify(
      subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE') }),
      withAffordances(['ADD_TO_CART', 'BUY_NOW', 'ENTER_QUERY'])
    );
    expect(v.satisfied).toBe(false);
  });

  it('5. zero observed affordances → false', () => {
    const v = verify(
      subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE', 'add_to_cart') }),
      withAffordances([])
    );
    expect(v.satisfied).toBe(false);
  });

  it('7. navigating to a page with arbitrary affordances does NOT satisfy an unnamed claim', () => {
    // The exact production shape: the task navigated "/" -> "/search.html",
    // the new page exposed affordances, and the unnamed NAVIGATE condition
    // reported "Affordance 'any' is available".
    for (const page of ['/', '/search.html', '/results.html', '/checkout']) {
      const v = verify(
        subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE') }),
        withAffordances(['SCROLL', 'SUBMIT_SEARCH', 'FILL_FIELD'], { url: `${ORIGIN}${page}` })
      );
      expect(v.satisfied, page).toBe(false);
      expect(v.reason).not.toMatch(/is available/);
    }
  });

  it('7b. the "affordances.length > 0" oracle is vacuous, which is why it was removed', () => {
    // Guards the reason the fix is necessary rather than cosmetic: the affordance
    // engine appends SCROLL for EVERY document, so the old predicate was
    // satisfied by a page with no controls whatsoever. If a future change makes
    // the observed set non-empty on a content-free page, this documents why
    // "some affordance exists" can never stand in for a named claim.
    const emptyPage = withAffordances([]);
    expect((emptyPage.semantic_context as { affordances: unknown[] }).affordances).toHaveLength(0);
    const v = verify(subgoal({ verificationCondition: cond('AFFORDANCE_AVAILABLE') }), emptyPage);
    expect(v.satisfied).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dispatch-side evidence is NEVER goal evidence
//
// These exist because mutation probes M4/M5 (`action.url` and
// `executionSuccess` used as the evidence source) initially SURVIVED: no test
// put those fields on a subgoal, so the mutants were unexercised no-ops. A
// survivor that is only equivalent for the inputs a test happens to use is a
// test gap, not an equivalent mutant, so the gap is closed here.
// ══════════════════════════════════════════════════════════════════════════════

describe('dispatch and intent fields cannot satisfy a subgoal condition', () => {
  /** A subgoal carrying every dispatch/intent field the loop records. */
  const loaded = (extra: Record<string, unknown> = {}) =>
    subgoal({
      expectedActionType: 'click',
      targetEntity: 'alpha widget',
      ...extra,
    } as Partial<Subgoal>);

  it('D1. a requested action.url does not satisfy a NAMED claim whose affordance is absent', () => {
    const v = verify(
      loaded({
        verificationCondition: cond('AFFORDANCE_AVAILABLE', 'ENTER_QUERY'),
        action: { action: 'click', target: 'btn-1', url: `${ORIGIN}/results.html` },
      }),
      withAffordances(['SCROLL'], { url: `${ORIGIN}/` })
    );
    expect(v.satisfied).toBe(false);
  });

  it('D2. executionSuccess=true does not satisfy a NAMED claim whose affordance is absent', () => {
    const v = verify(
      loaded({
        verificationCondition: cond('AFFORDANCE_AVAILABLE', 'ENTER_QUERY'),
        executionSuccess: true,
      }),
      withAffordances(['SCROLL'], { url: `${ORIGIN}/` })
    );
    expect(v.satisfied).toBe(false);
  });

  it('D3. a populated previousActions list does not satisfy a NAMED claim whose affordance is absent', () => {
    const v = verify(
      loaded({
        verificationCondition: cond('AFFORDANCE_AVAILABLE', 'ENTER_QUERY'),
        previousActions: [{ action: 'click', target: 'btn-1' }],
      }),
      withAffordances(['SCROLL'], {
        url: `${ORIGIN}/`,
        ...({ previous_actions: [{ action: 'click', target: 'btn-1' }] } as Partial<AgentContextPayload>),
      })
    );
    expect(v.satisfied).toBe(false);
  });

  it('D4. a requested navigationDestination does not satisfy a NAMED claim whose affordance is absent', () => {
    const v = verify(
      loaded({
        verificationCondition: cond('AFFORDANCE_AVAILABLE', 'ENTER_QUERY'),
        navigationDestination: `${ORIGIN}/results.html`,
      }),
      withAffordances(['SCROLL'], { url: `${ORIGIN}/` })
    );
    expect(v.satisfied).toBe(false);
  });

  it('D5. all four together, on a page where the named affordance is ABSENT', () => {
    const v = verify(
      loaded({
        verificationCondition: cond('AFFORDANCE_AVAILABLE', 'ENTER_QUERY'),
        action: { action: 'click', target: 'btn-1', url: `${ORIGIN}/results.html` },
        executionSuccess: true,
        previousActions: [{ action: 'click' }],
        navigationDestination: `${ORIGIN}/results.html`,
      }),
      withAffordances(['ADD_TO_CART', 'BUY_NOW'], {
        url: `${ORIGIN}/`,
        ...({ previous_actions: [{ action: 'click' }] } as Partial<AgentContextPayload>),
      })
    );
    expect(v.satisfied).toBe(false);
  });

  it('D6. but they do not SUPPRESS a genuinely observed named affordance', () => {
    // The converse: a loaded subgoal carrying dispatch fields must still verify
    // when the affordance really is observed, so a mutation cannot be killed
    // merely by inverting the whole predicate.
    const v = verify(
      loaded({
        verificationCondition: cond('AFFORDANCE_AVAILABLE', 'ENTER_QUERY'),
        action: { action: 'click', target: 'btn-1' },
        executionSuccess: true,
        previousActions: [{ action: 'click' }],
      }),
      withAffordances(['ENTER_QUERY', 'SUBMIT_SEARCH'], { url: `${ORIGIN}/search.html` })
    );
    expect(v.satisfied).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. the decomposer producers remain constructible, with honest conditions
// ══════════════════════════════════════════════════════════════════════════════

const ecommerce = () =>
  decomposeTask('open the store catalog at http://localhost:4174 and open the first product listed', {
    currentUrl: `${ORIGIN}/`,
  });
const information = () =>
  decomposeTask('find information about quantum computing on the web', { currentUrl: `${ORIGIN}/` });
const generic = () => decomposeTask('do something with this page', { currentUrl: `${ORIGIN}/` });

const affordanceConditions = (g: ReturnType<typeof ecommerce>) =>
  g.subgoals.filter((s) => s.verificationCondition?.type === 'AFFORDANCE_AVAILABLE');

describe('decomposer producers', () => {
  it('8. every decomposed flow is still constructible', () => {
    for (const g of [ecommerce(), information(), generic()]) {
      expect(g.subgoals.length).toBeGreaterThan(0);
      for (const sg of g.subgoals) {
        expect(sg.id).toMatch(/sg\d+$/);
        expect(sg.goalId).toBe(g.goal.goalId);
      }
    }
  });

  it('8b. the two NAMEABLE producers now declare ENTER_QUERY and are falsifiable', () => {
    const search = affordanceConditions(information()).find((s) => s.category === 'SEARCH');
    expect(search).toBeDefined();
    expect(search!.verificationCondition!.expectedValue).toBe('ENTER_QUERY');

    const ecom = affordanceConditions(ecommerce()).find((s) => s.category === 'SEARCH');
    expect(ecom).toBeDefined();
    expect(ecom!.verificationCondition!.expectedValue).toBe('ENTER_QUERY');

    // Falsifiable: not proven on a page with no query input...
    expect(
      verify(search!, withAffordances(['ADD_TO_CART', 'BUY_NOW', 'SCROLL'])).satisfied
    ).toBe(false);
    // ...proven only where a query input is actually observed.
    expect(verify(search!, withAffordances(['ENTER_QUERY', 'SUBMIT_SEARCH'])).satisfied).toBe(true);
  });

  it('8c. the two DESTINATION/EXISTENCE producers are left unnamed and unverifiable', () => {
    // Deliberately unchanged, pending the destination-intent design. They must
    // NOT be given a fabricated named affordance, and must not be proven.
    const nav = affordanceConditions(ecommerce()).find((s) => s.category === 'NAVIGATE');
    expect(nav).toBeDefined();
    expect(nav!.verificationCondition!.expectedValue ?? '').toBe('');
    expect(verify(nav!, withAffordances(['SCROLL'])).satisfied).toBe(false);

    const locate = affordanceConditions(generic()).find((s) => s.category === 'LOCATE');
    expect(locate).toBeDefined();
    expect(locate!.verificationCondition!.expectedValue ?? '').toBe('');
    expect(verify(locate!, withAffordances(['SCROLL'])).satisfied).toBe(false);
  });

  it('8d. SCROLL is never used as a stand-in for an existence claim', () => {
    // Wiring `SCROLL` would restore the old vacuous truth, because
    // discoverActionAffordances appends it for every document.
    for (const g of [ecommerce(), information(), generic()]) {
      for (const sg of affordanceConditions(g)) {
        expect(sg.verificationCondition!.expectedValue ?? '', sg.id).not.toBe('SCROLL');
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. targetEntity semantics are unchanged
// ══════════════════════════════════════════════════════════════════════════════

describe('targetEntity is still a CONTENT target, not destination identity', () => {
  it('9a. it is still populated with the search/product query', () => {
    const search = ecommerce().subgoals.find((s) => s.category === 'SEARCH')!;
    expect(search.targetEntity).toBe('store catalog first');
    const select = ecommerce().subgoals.find((s) => s.category === 'SELECT')!;
    expect(select.targetEntity).toBe('store catalog first');
  });

  it('9b. it is still consumed as an ELEMENT_EXISTS marker, not as a destination', () => {
    const select = ecommerce().subgoals.find((s) => s.category === 'SELECT')!;
    expect(select.verificationCondition!.type).toBe('ELEMENT_EXISTS');
    // Proven by observation of that element, or not at all.
    expect(verify(select, ctx({ detections: [] })).satisfied).toBe(false);
    expect(
      verify(
        select,
        ctx({
          detections: [
            {
              id: 'store catalog first',
              type: 'element',
              confidence: 0.9,
              bbox: { x: 0, y: 0, width: 1, height: 1 },
              length: 0,
              source: 'dom_attribute',
              selector: '#store-catalog-first',
              is_partially_visible: true,
            },
          ] as never,
        })
      ).satisfied
    ).toBe(true);
  });

  it('9c. it is still typed into the input by the one-action planner', async () => {
    const { OneActionPlanner } = await import('../extension/src/hierarchicalPlanning/oneActionPlanner');
    const search = ecommerce().subgoals.find((s) => s.category === 'SEARCH')!;
    const proposed = OneActionPlanner.proposeSubgoalAction(
      search,
      ctx({
        detections: [
          {
            id: 'el_input_search',
            type: 'search',
            confidence: 0.9,
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            length: 0,
            source: 'dom_attribute',
            selector: '#input-search-query',
            is_partially_visible: true,
          },
        ] as never,
      })
    );
    expect(proposed).not.toBeNull();
    expect(proposed!.action).toBe('type');
    expect((proposed as { text?: string }).text).toBe('store catalog first');
  });

  it('9d. a bare URL is not smuggled into targetEntity as destination identity', () => {
    for (const g of [ecommerce(), information(), generic()]) {
      for (const sg of g.subgoals) {
        expect(sg.targetEntity ?? '', sg.id).not.toMatch(/localhost|https?:/i);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. Goal Verification remains the sole task-SUCCESS authority
// ══════════════════════════════════════════════════════════════════════════════

describe('subgoal completion is still not task success', () => {
  it('10a. a fully-satisfied affordance claim never sets isGoalSatisfied', () => {
    const g = ecommerce();
    for (const sg of g.subgoals) {
      const v = verify(sg, withAffordances(['ENTER_QUERY', 'ADD_TO_CART', 'SCROLL']));
      // whatever the verdict, the tracker exposes no task-level claim
      expect(Object.keys(v).sort()).toEqual(['reason', 'satisfied']);
    }
  });

  it('10b. the tracker public API exposes no goal-satisfaction surface', () => {
    const api = GoalProgressTracker as unknown as Record<string, unknown>;
    for (const name of ['isGoalSatisfied', 'setGoalSatisfied', 'markGoalSatisfied', 'completeGoal']) {
      expect(api[name], name).toBeUndefined();
    }
    expect(typeof api.verifySubgoalCondition).toBe('function');
  });

  it('10c. agentLoop still routes task SUCCESS through the goal verifier', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'extension/src/agent/agentLoop.ts'), 'utf8');
    expect(src).toContain('isTaskGoalSatisfied');
    const completions = src.match(/subgoalGraph\.completeSubgoal/g) ?? [];
    const successes = src.match(/status = 'SUCCESS'|goalStatus = 'SUCCESS'/g) ?? [];
    expect(completions.length).toBeGreaterThan(0);
    // Completion bookkeeping must not be co-located with a SUCCESS transition.
    expect(src).not.toMatch(/completeSubgoal\([^)]*\)[\s\S]{0,240}status = 'SUCCESS'/);
    expect(successes.length).toBeGreaterThan(0);
  });
});
