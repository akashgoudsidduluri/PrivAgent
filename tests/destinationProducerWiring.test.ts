/**
 * PrivAgent — POST-17.10 Step 7: destination declaration PRODUCER WIRING.
 *
 * Step 6 proved the declaration contract (ENTRY URL vs DESTINATION URL) and the
 * verifier against real Chrome. This file proves the PLANNING INTEGRATION:
 *
 *     user prompt
 *       → normalizeDestination        (user input only)
 *       → HighLevelGoal.destinationDeclaration
 *       → Subgoal.destination
 *       → GoalProgressTracker.verifySubgoalCondition
 *       → verifyDestination(observation)
 *       → MATCH completes the subgoal
 *
 * The property under test is not "the demo completes". It is that a DESTINATION
 * subgoal can complete on observed page identity and on nothing else. Every
 * section below is written so that a mutation restoring the old vacuous
 * behaviour makes it fail. See scratch/mutation_destination_producer_wiring.mjs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  classifyTaskCategory,
  decomposeTask,
} from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const ORIGIN = 'http://localhost:4174';

/**
 * The canonical Step 5/6 evidence prompt. NOTE: this classifies as
 * `GENERIC_INTERACTION`, which plans no NAVIGATE subgoal — see W0. The wiring
 * assertions therefore run against an equivalent prompt that DOES classify as
 * e-commerce, which is the only flow that owns a destination-claim subgoal.
 */
const PROMPT = 'open the store catalog at http://localhost:4174';
const PROMPT_ECOM = `${PROMPT} and open the first product listed`;
const PROMPT_EXPLICIT_URL = 'open http://localhost:4174/results.html';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ctx = (over: Partial<AgentContextPayload> = {}): AgentContextPayload =>
  ({
    url: `${ORIGIN}/`,
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

/** A sanitized context whose OBSERVED page classification is the given values. */
const classified = (
  url: string,
  pageType: SemanticPageType,
  confidence: number,
  generation: number,
  affordances: string[] = ['SCROLL']
): AgentContextPayload =>
  ctx({
    url,
    semantic_context: {
      pageType,
      confidence,
      pageState: 'populated',
      pageGeneration: generation,
      entities: [],
      affordances: affordances.map((t, i) => ({
        id: `af_${i}`,
        type: t as never,
        targetElementId: `el_${i}`,
        requiresConfirmation: false,
        description: `${t} affordance`,
      })),
    } as never,
  });

const verify = (sg: Subgoal, context: AgentContextPayload, currentGeneration?: number) =>
  GoalProgressTracker.verifySubgoalCondition(sg, {
    context,
    pageGeneration: currentGeneration ?? (context.semantic_context?.pageGeneration ?? 1),
  });

const planned = () => decomposeTask(PROMPT_ECOM, { currentUrl: `${ORIGIN}/` });
const navSubgoal = (): Subgoal => planned().subgoals.find((s) => s.category === 'NAVIGATE')!;

/** The real classification the fixture catalog produces. */
const REAL_CATALOG = classified(`${ORIGIN}/results.html`, 'LISTING', 0.99, 5);

// ══════════════════════════════════════════════════════════════════════════════
// W0 — the classification gap, and what Step 8 did about it
//
// `classifyTaskCategory` buckets "open the store catalog at <url>" as
// GENERIC_INTERACTION, because none of its e-commerce keywords ("buy",
// "purchase", "cart", "product", "price", "order", "amazon", "shop") appear.
//
// After Step 7 the declaration was produced and attached to the goal, but only
// the ECOMMERCE_SEARCH branch CONSUMED it — so this prompt planned NO
// destination subgoal and the whole chain died before the verifier.
//
// Step 8 fixed that WITHOUT touching the category: the typed declaration is now
// a second planning input that gates a destination subgoal in every branch that
// does not already produce one. These tests pin both halves — the category is
// unchanged, and the destination subgoal now exists.
// ══════════════════════════════════════════════════════════════════════════════

describe('W0 · the canonical prompt plans a destination subgoal without changing category', () => {
  it('W0a. the lexical category is DELIBERATELY unchanged', () => {
    // Step 8 did not add "catalog"/"store" to the e-commerce keyword list, and
    // did not re-file this prompt. Classification semantics are untouched.
    expect(classifyTaskCategory(PROMPT)).toBe('GENERIC_INTERACTION');
    expect(classifyTaskCategory(PROMPT).valueOf()).toBe('GENERIC_INTERACTION');
  });

  it('W0b. the declaration is produced and attached to the goal', () => {
    const g = decomposeTask(PROMPT, { currentUrl: `${ORIGIN}/` });
    const d = g.goal.destinationDeclaration as {
      kind: string;
      role?: { acceptablePageTypes: string[] };
      entryUrl?: { origin: string; path: string };
    };
    expect(d.kind).toBe('DECLARED');
    expect(d.role!.acceptablePageTypes).toEqual(['LISTING']);
    expect(d.entryUrl!.origin).toBe(ORIGIN);
  });

  it('W0c. the destination subgoal NOW EXISTS and is the READY first subgoal', () => {
    const g = decomposeTask(PROMPT, { currentUrl: `${ORIGIN}/` });
    const withDestination = g.subgoals.filter((s) => s.destination !== undefined);
    expect(withDestination).toHaveLength(1);
    const nav = withDestination[0]!;
    expect(nav.category).toBe('NAVIGATE');
    expect(nav.verificationCondition!.type).toBe('DESTINATION_VERIFIED');
    expect(nav.state).toBe('READY');
    expect(nav.prerequisites).toEqual([]);
    expect((nav.destination as { role?: { acceptablePageTypes: string[] } }).role!.acceptablePageTypes).toEqual([
      'LISTING',
    ]);
  });

  it('W0d. the generic LOCATE existence claim stays blocked and now depends on it', () => {
    const g = decomposeTask(PROMPT, { currentUrl: `${ORIGIN}/` });
    const locate = g.subgoals.find((s) => s.category === 'LOCATE')!;
    expect(locate.destination).toBeUndefined();
    expect(locate.verificationCondition!.type).toBe('AFFORDANCE_AVAILABLE');
    expect(locate.verificationCondition!.expectedValue ?? '').toBe('');
    expect(verify(locate, REAL_CATALOG, 5).satisfied).toBe(false);
    // It is no longer READY on its own; it waits for the destination.
    expect(locate.state).toBe('PENDING');
    expect(locate.prerequisites).toContain(g.subgoals[0]!.id);
  });

  it('W0e. the destination subgoal completes only on the real catalog observation', () => {
    const nav = decomposeTask(PROMPT, { currentUrl: `${ORIGIN}/` }).subgoals[0]!;
    expect(verify(nav, REAL_CATALOG).satisfied).toBe(true);
    // Fail-closed everywhere else.
    expect(verify(nav, classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(false);
    expect(verify(nav, classified(`${ORIGIN}/product.html`, 'UNKNOWN', 0.1, 7)).satisfied).toBe(false);
    expect(verify(nav, REAL_CATALOG, 6).satisfied).toBe(false); // stale
  });

  it('W0f. an equivalent e-commerce prompt still plans exactly ONE', () => {
    expect(classifyTaskCategory(PROMPT_ECOM)).toBe('ECOMMERCE_SEARCH');
    const g = decomposeTask(PROMPT_ECOM, { currentUrl: `${ORIGIN}/` });
    expect(g.subgoals.filter((s) => s.destination !== undefined)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W1 — the declaration reaches the planning representation, typed
// ══════════════════════════════════════════════════════════════════════════════

describe('W1 · declaration flows prompt → goal → subgoal', () => {
  it('W1a. HighLevelGoal carries the declaration, with entryUrl and NO destination URL', () => {
    const g = planned().goal;
    expect(g.destinationDeclaration).toBeDefined();
    const d = g.destinationDeclaration as {
      kind: string;
      role?: { acceptablePageTypes: string[] };
      url?: unknown;
      entryUrl?: { origin: string; path: string };
    };
    expect(d.kind).toBe('DECLARED');
    expect(d.role!.acceptablePageTypes).toEqual(['LISTING']);
    expect(d.url).toBeUndefined();
    expect(d.entryUrl!.origin).toBe(ORIGIN);
    expect(d.entryUrl!.path).toBe('/');
  });

  it('W1b. the Subgoal carries the SAME typed declaration', () => {
    const nav = navSubgoal();
    expect(nav.destination).toBeDefined();
    expect((nav.destination as { kind: string }).kind).toBe('DECLARED');
    expect(nav.verificationCondition!.type).toBe('DESTINATION_VERIFIED');
  });

  it('W1c. the destination is a DISTINCT field — not description, targetEntity or expectedValue', () => {
    const nav = navSubgoal();
    expect(nav.description).not.toMatch(/LISTING/);
    expect(nav.targetEntity ?? '').not.toMatch(/LISTING/);
    expect(nav.verificationCondition!.expectedValue ?? '').toBe('');
    // A subgoal WITH a destination is structurally identifiable.
    const withDestination = planned().subgoals.filter((s) => s.destination !== undefined);
    expect(withDestination.map((s) => s.category)).toEqual(['NAVIGATE']);
  });

  it('W1d. non-destination subgoals carry no declaration at all', () => {
    for (const sg of planned().subgoals) {
      if (sg.category !== 'NAVIGATE') expect(sg.destination, sg.id).toBeUndefined();
    }
  });

  it('W1e. an explicit destination URL prompt yields url, never entryUrl', () => {
    const g = decomposeTask(PROMPT_EXPLICIT_URL, { currentUrl: `${ORIGIN}/` });
    const d = g.goal.destinationDeclaration as {
      url?: { path: string };
      entryUrl?: unknown;
      role?: unknown;
    };
    expect(d.url!.path).toBe('/results.html');
    expect(d.entryUrl).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W2 — USER INPUT is the only source of the declaration
// ══════════════════════════════════════════════════════════════════════════════

describe('W2 · the declaration cannot be derived from anything but the prompt', () => {
  it('W2a. it is identical regardless of the observed browser state supplied to the decomposer', () => {
    const shape = (url: string, category: string, affordances: string[]) => {
      const g = decomposeTask(PROMPT_ECOM, { currentUrl: url, knownPageCategory: category });
      return JSON.stringify(g.goal.destinationDeclaration);
    };
    const baseline = shape(`${ORIGIN}/`, 'UNKNOWN', ['SCROLL']);
    for (const [url, cat] of [
      [`${ORIGIN}/results.html`, 'LISTING'],
      [`${ORIGIN}/product.html`, 'PRODUCT_DETAIL'],
      ['https://example.com/checkout', 'CHECKOUT'],
    ] as const) {
      expect(shape(url, cat, ['SCROLL', 'ADD_TO_CART']), url).toBe(baseline);
    }
  });

  it('W2b. it is identical regardless of the world model passed in', () => {
    const baseline = JSON.stringify(planned().goal.destinationDeclaration);
    const g = decomposeTask(PROMPT_ECOM, {
      currentUrl: `${ORIGIN}/results.html`,
      worldModel: { page: { url: `${ORIGIN}/results.html`, pageType: 'LISTING' } } as never,
    });
    expect(JSON.stringify(g.goal.destinationDeclaration)).toBe(baseline);
  });

  it('W2c. a prompt with no destination-bearing construct declares NONE', () => {
    const g = decomposeTask('do something with this page', { currentUrl: `${ORIGIN}/` });
    expect((g.goal.destinationDeclaration as { kind: string }).kind).toBe('NONE');
    for (const sg of g.subgoals) expect(sg.destination, sg.id).toBeUndefined();
  });

  it('W2d. the declaration field is readonly at the type level', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const src = readFileSync(resolve(process.cwd(), 'extension/src/planning/destinationNormalizer.ts'), 'utf8');
    const block = src.slice(src.indexOf('export interface UrlDeclaration'));
    expect(block).toMatch(/readonly provenance/);
    expect(block).toMatch(/readonly origin/);
    // No exported mutator anywhere in the normalizer.
    for (const name of ['setDestination', 'updateDestination', 'rewriteDestination']) {
      expect(src, name).not.toContain(name);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W3 — completion semantics: MATCH completes, MISMATCH and UNKNOWN do not
// ══════════════════════════════════════════════════════════════════════════════

describe('W3 · only MATCH completes a destination subgoal', () => {
  it('W3a. MATCH on the real classification completes the subgoal', () => {
    const v = verify(navSubgoal(), REAL_CATALOG);
    expect(v.satisfied).toBe(true);
    expect(v.reason).toMatch(/LISTING/);
  });

  it('W3b. MISMATCH — a different positively-classified page — does not complete', () => {
    const v = verify(navSubgoal(), classified(`${ORIGIN}/checkout`, 'CHECKOUT', 0.97, 5));
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/MISMATCH/);
  });

  it('W3c. UNKNOWN at high confidence does not complete', () => {
    const v = verify(navSubgoal(), classified(`${ORIGIN}/`, 'UNKNOWN', 0.95, 5));
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/UNKNOWN/);
  });

  it('W3d. UNKNOWN is never silently converted into MISMATCH or MATCH', () => {
    const v = verify(navSubgoal(), classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5));
    expect(v.satisfied).toBe(false);
    expect(v.reason).not.toMatch(/MISMATCH/);
  });

  it('W3e. a low-confidence LISTING below the shared floor does not complete', () => {
    const v = verify(navSubgoal(), classified(`${ORIGIN}/results.html`, 'LISTING', 0.2, 5));
    expect(v.satisfied).toBe(false);
  });

  it('W3f. no semantic classification at all does not complete', () => {
    const v = verify(navSubgoal(), ctx({ url: `${ORIGIN}/results.html` }));
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/classification/i);
  });

  it('W3g. a DESTINATION_VERIFIED subgoal with NO declaration does not complete', () => {
    const orphan: Subgoal = {
      ...navSubgoal(),
      destination: undefined,
    };
    expect(verify(orphan, REAL_CATALOG).satisfied).toBe(false);
  });

  it('W3h. an AMBIGUOUS declaration is never resolved into a destination', () => {
    const ambiguous = { kind: 'AMBIGUOUS' as const, candidates: [['LISTING'], ['CHECKOUT']] };
    const sg: Subgoal = { ...navSubgoal(), destination: ambiguous as never };
    expect(verify(sg, REAL_CATALOG).satisfied).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W4 — dispatch-side evidence can NEVER complete a destination subgoal
// ══════════════════════════════════════════════════════════════════════════════

describe('W4 · dispatch, intent and affordance evidence cannot complete a destination', () => {
  const loaded = (extra: Record<string, unknown>) =>
    ({ ...navSubgoal(), ...extra }) as Subgoal;

  it('W4a. executionSuccess=true on a page that does not match', () => {
    const v = verify(
      loaded({ executionSuccess: true }),
      classified(`${ORIGIN}/product/alpha`, 'UNKNOWN', 0.1, 5)
    );
    expect(v.satisfied).toBe(false);
  });

  it('W4b. a requested action.url pointing at the catalog does not complete', () => {
    const v = verify(
      loaded({ action: { action: 'navigate', url: `${ORIGIN}/results.html` } }),
      classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)
    );
    expect(v.satisfied).toBe(false);
  });

  it('W4b2. the OBSERVED url CONTAINING the requested action.url still does not complete', () => {
    // Mutation M7 (`complete a destination subgoal from action.url`) survived
    // the first version of W4b, because no test ever let its predicate fire:
    // the requested path was never a substring of the observed URL. That is a
    // test gap, not an equivalent mutant — a mutant that is only equivalent for
    // the inputs a test happens to use has not been exercised.
    //
    // Here the browser really IS on the catalog path, and the action really did
    // request it. Only the PAGE IDENTITY fails to confirm the destination. If
    // any dispatch-derived evidence were sufficient, this would complete.
    const v = verify(
      loaded({ action: { action: 'navigate', url: `${ORIGIN}/results.html` } }),
      classified(`${ORIGIN}/results.html?utm=1`, 'UNKNOWN', 0.1, 5)
    );
    expect(v.satisfied).toBe(false);
    // And the converse, so the mutant cannot be killed by merely inverting:
    // the same dispatch fields with a genuinely matching identity DO complete.
    expect(
      verify(loaded({ action: { action: 'navigate', url: `${ORIGIN}/results.html` } }), REAL_CATALOG).satisfied
    ).toBe(true);
  });

  it('W4c. a requested navigationDestination does not complete', () => {
    const v = verify(
      loaded({ navigationDestination: `${ORIGIN}/results.html` }),
      classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)
    );
    expect(v.satisfied).toBe(false);
  });

  it('W4d. a populated previousActions list does not complete', () => {
    const v = verify(
      loaded({ previousActions: [{ action: 'navigate' }], previous_actions: [{ action: 'navigate' }] }),
      classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)
    );
    expect(v.satisfied).toBe(false);
  });

  it('W4e. affordances.length > 0 does not complete — SCROLL is on every document', () => {
    for (const affs of [['SCROLL'], ['SCROLL', 'SUBMIT_SEARCH', 'ENTER_QUERY', 'ADD_TO_CART']]) {
      const v = verify(navSubgoal(), classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5, affs));
      expect(v.satisfied, JSON.stringify(affs)).toBe(false);
    }
  });

  it('W4f. ALL of them together, on a page that does not match', () => {
    const v = verify(
      loaded({
        executionSuccess: true,
        action: { action: 'navigate', url: `${ORIGIN}/results.html` },
        previousActions: [{ action: 'navigate' }],
        navigationDestination: `${ORIGIN}/results.html`,
        previous_actions: [{ action: 'navigate' }],
      }),
      classified(`${ORIGIN}/product/alpha`, 'UNKNOWN', 0.1, 5, ['SCROLL', 'ADD_TO_CART'])
    );
    expect(v.satisfied).toBe(false);
  });

  it('W4g. model-authored fields on the subgoal cannot alter the declaration', () => {
    // A planner/replanner writing anything back onto `destination` is the
    // laundering path. The guard is that the declaration is produced once, from
    // the prompt, and is byte-identical no matter what the browser shows.
    // (goalId/createdAt are per-decomposition and are excluded deliberately.)
    const strip = () => JSON.stringify(navSubgoal().destination);
    const before = strip();
    decomposeTask(PROMPT_ECOM, { currentUrl: `${ORIGIN}/results.html`, knownPageCategory: 'LISTING' });
    decomposeTask(PROMPT_ECOM, {
      currentUrl: 'https://example.com/checkout',
      worldModel: { page: { url: 'https://example.com/checkout', pageType: 'CHECKOUT' } } as never,
    });
    expect(strip()).toBe(before);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W5 — page-generation freshness (the verifier's own semantics, reused)
// ══════════════════════════════════════════════════════════════════════════════

describe('W5 · a stale classification cannot complete a current destination', () => {
  it('W5a. an older generation does not complete, even though the URL matches', () => {
    const stale = classified(`${ORIGIN}/results.html`, 'LISTING', 0.99, 5);
    const v = verify(navSubgoal(), stale, 7);
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/generation/i);
  });

  it('W5b. the matching generation completes', () => {
    expect(verify(navSubgoal(), REAL_CATALOG, 5).satisfied).toBe(true);
  });

  it('W5c. freshness uses the verifier, not a second generation system', () => {
    // Direct comparison against the verifier: same inputs, same answer.
    const declaration = planned().goal.destinationDeclaration!;
    const stale = verifyDestination({
      declaration,
      observation: {
        url: `${ORIGIN}/results.html`,
        pageGeneration: 5,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 5 },
      },
      currentPageGeneration: 7,
    });
    expect(stale.kind).toBe('UNKNOWN');
  });

  it('W5d. a match never caches across generations', () => {
    const nav = navSubgoal();
    expect(verify(nav, REAL_CATALOG, 5).satisfied).toBe(true);
    // Same subgoal, browser has moved on: the old evidence no longer applies.
    expect(verify(nav, REAL_CATALOG, 6).satisfied).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W6 — entry URL stays an entry URL all the way through planning
// ══════════════════════════════════════════════════════════════════════════════

describe('W6 · the entry URL never becomes a destination constraint', () => {
  it('W6a. the entry site is still what target provisioning receives', async () => {
    const { extractTargetSite } = await import('../extension/src/agent/goalParser');
    expect(extractTargetSite(PROMPT)).toBe(ORIGIN);
    expect(extractTargetSite(PROMPT_ECOM)).toBe(ORIGIN);
  });

  it('W6b. a subgoal carrying entryUrl still verifies on ROLE alone', () => {
    // The catalog is /results.html; the entry URL is /. If "/" were treated as
    // a destination constraint this could not pass.
    const v = verify(navSubgoal(), REAL_CATALOG);
    expect(v.satisfied).toBe(true);
  });

  it('W6c. the explicit destination URL form still compares exactly', () => {
    // The e-commerce suffix is needed only so the plan owns a destination-
    // bearing NAVIGATE subgoal (see W0); it does not affect the declaration.
    const g = decomposeTask(`${PROMPT_EXPLICIT_URL} and buy the first product listed`, {
      currentUrl: `${ORIGIN}/`,
    });
    const nav = g.subgoals.find((s) => s.category === 'NAVIGATE');
    expect(nav).toBeDefined();
    const d = nav!.destination as { url?: { path: string }; entryUrl?: unknown };
    expect(d.url!.path).toBe('/results.html');
    expect(d.entryUrl).toBeUndefined();
    // Matches on the exact page.
    expect(verify(nav!, REAL_CATALOG).satisfied).toBe(true);
    // "/" must not match "/results.html" when "/" IS the declared destination.
    expect(verify(nav!, classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(false);
  });

  it('W6d. an explicitly declared destination URL mismatches a different real page', () => {
    const g = decomposeTask(`${PROMPT_EXPLICIT_URL} and buy the first product listed`, {
      currentUrl: `${ORIGIN}/`,
    });
    const nav = g.subgoals.find((s) => s.category === 'NAVIGATE')!;
    const v = verify(nav, classified(`${ORIGIN}/product.html`, 'UNKNOWN', 0.1, 7));
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/MISMATCH/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W7 — the tracker exposes no task-success authority
// ══════════════════════════════════════════════════════════════════════════════

describe('W7 · Goal Verification remains the sole task-success authority', () => {
  it('W7a. the tracker verdict surface is unchanged', () => {
    const v = verify(navSubgoal(), REAL_CATALOG);
    expect(Object.keys(v).sort()).toEqual(['reason', 'satisfied']);
  });

  it('W7b. the tracker exposes no goal-satisfaction or status setter', () => {
    const api = GoalProgressTracker as unknown as Record<string, unknown>;
    for (const name of [
      'isGoalSatisfied',
      'setGoalSatisfied',
      'markGoalSatisfied',
      'completeGoal',
      'setStatus',
      'completeTask',
    ]) {
      expect(api[name], name).toBeUndefined();
    }
  });

  it('W7c. completing the destination subgoal does not complete the graph by itself', () => {
    const g = planned();
    const graph = new SubgoalGraph(g.goal.goalId, g.subgoals);
    // The destination subgoal verified...
    expect(verify(navSubgoal(), REAL_CATALOG).satisfied).toBe(true);
    // ...but the dependent SEARCH/SELECT/VERIFY chain is untouched.
    expect(graph.isAllCompleted()).toBe(false);
    expect(g.goal.status).toBe('ACTIVE');
  });

  it('W7d. agentLoop still routes task SUCCESS through the goal verifier only', () => {
    const src = readFileSync(resolve(process.cwd(), 'extension/src/agent/agentLoop.ts'), 'utf8');
    expect(src).toContain('isTaskGoalSatisfied');
    expect(src).not.toMatch(/completeSubgoal\([^)]*\)[\s\S]{0,240}status = 'SUCCESS'/);
    // Nothing in the loop marks a subgoal complete from the destination verdict.
    expect(src).not.toMatch(/DESTINATION_VERIFIED/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W8 — the model is not a destination authority, and nothing new egresses
// ══════════════════════════════════════════════════════════════════════════════

describe('W8 · the provider cannot see, let alone redefine, the destination', () => {
  it('W8a. the declaration is absent from every outbound payload construction', () => {
    const sources = [
      'extension/src/agent/backendAgentProvider.ts',
      'extension/src/agent/openRouterProvider.ts',
      'extension/src/privacy/contextMinimizer.ts',
      'extension/src/agent/agentLoop.ts',
    ];
    for (const rel of sources) {
      // Comments are stripped before matching. Step 9 added a COMMENT in
      // agentLoop.ts that names `verifyDestination`, which a blunt substring
      // scan counted as a violation. A prose mention cannot put anything in a
      // payload; matching CODE is both the true invariant and free of the false
      // positive. This is a strengthening of intent, not a relaxation.
      const src = readFileSync(resolve(process.cwd(), rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(src, rel).not.toMatch(/destinationDeclaration/);
      expect(src, rel).not.toMatch(/verifyDestination/);
      expect(src, rel).not.toMatch(/destinationNormalizer/);
      expect(src, rel).not.toMatch(/normalizeDestination/);
    }
  });

  it('W8b. no provider request body is built from the subgoal graph', () => {
    const src = readFileSync(resolve(process.cwd(), 'extension/src/agent/backendAgentProvider.ts'), 'utf8');
    expect(src).not.toMatch(/subgoalGraphData|highLevelGoal/);
  });

  it('W8c. the destination declaration carries no page-derived text', () => {
    const d = planned().goal.destinationDeclaration as Record<string, unknown>;
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/baggy|baggy jeans|add to cart|product card/i);
    // The role is a closed enum, and the URL is a normalized URL.
    const role = d.role as { acceptablePageTypes: string[] };
    expect(role.acceptablePageTypes.every((t) => /^[A-Z_]+$/.test(t))).toBe(true);
  });

  it('W8d. the verifier is a pure local function with no egress', () => {
    const src = readFileSync(resolve(process.cwd(), 'extension/src/planning/destinationVerifier.ts'), 'utf8');
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'chrome.runtime.sendMessage', 'axios']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W9 — the normalizer the producer calls is the Step 6 contract, unmodified
// ══════════════════════════════════════════════════════════════════════════════

describe('W9 · producer and verifier agree with the proven Step 6 contract', () => {
  it('W9a. the goal declaration is byte-identical to normalizeDestination(prompt)', () => {
    expect(planned().goal.destinationDeclaration).toEqual(normalizeDestination(PROMPT));
  });

  it('W9b. the subgoal declaration is that same object graph', () => {
    expect(navSubgoal().destination).toEqual(planned().goal.destinationDeclaration);
  });
});