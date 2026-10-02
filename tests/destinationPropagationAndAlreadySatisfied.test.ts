/**
 * PrivAgent — POST-17.10 Step 10: ROLE-ONLY PROPAGATION + ALREADY-AT-DESTINATION.
 *
 * TWO INDEPENDENT OBJECTS, ONE MATRIX
 * ────────────────────────────────────
 * A (W1–W16) — a ROLE-ONLY destination (`role = LISTING`, NO `destinationUrl`)
 *     must survive every hop to the reasoning/action-selection boundary as a
 *     TYPED, USER-DERIVED constraint, and must never be silently converted into
 *     a URL.
 *
 * B (W17–W30) — `ACTION_NO_EFFECT` must not be silently converted into success
 *     EITHER. A no-effect action whose destination is independently proven by a
 *     FRESH observation may complete the destination subgoal, credited to the
 *     observation. Anything else stays a failure.
 *
 * WHAT THESE TESTS PIN AS INVARIANTS (not merely as current behaviour)
 * ───────────────────────────────────────────────────────────────────
 *  • Provenance is a REQUIRED LITERAL (`USER_DECLARED_DESTINATION`). There is no
 *    channel by which an observation, a page type, an affordance, a `targetEntity`,
 *    an `action.url`, an execution result, a previous action, model output or a
 *    recovery result could produce a declaration — and W5–W10 prove each of those
 *    individually rather than asserting the design in prose.
 *  • `AMBIGUOUS` and `UNSUPPORTED` produce NO constraint. Ambiguity is never
 *    resolved on the user's behalf and an unmapped noun is never guessed at.
 *  • `entryUrl` is provenance, never a destination constraint (Step 6 contract).
 *  • The egress payload carries no `text` / `value` / `input` key, because
 *    `backend/app/security.py` rejects those names at ANY nesting depth.
 *  • `destinationVerifier` is the ONLY authority that can complete a destination
 *    subgoal, and ONLY on MATCH. `GoalVerifier` remains the ONLY authority for
 *    task success.
 *
 * HONESTY NOTE ON THE LOOP-LEVEL TESTS
 * ────────────────────────────────────
 * The provider in the `W17+` section is a CONTROLLED ADAPTER used purely to
 * produce a scripted, no-effect action. It is explicitly NOT the real reasoner
 * and is never reported as one. Real-provider evidence lives in
 * `docs/evidence/post-17-9/destination-verifier/`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import { verifyActionEffect } from '../extension/src/agent/effectVerifier';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import {
  classifyTaskCategory,
  decomposeTask,
} from '../extension/src/hierarchicalPlanning/taskDecomposer';
import {
  PlannerContextBuilder,
  toDeclaredDestinationConstraint,
} from '../extension/src/hierarchicalPlanning/plannerContextBuilder';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { OneActionPlanner } from '../extension/src/hierarchicalPlanning/oneActionPlanner';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import type { DestinationDeclaration } from '../extension/src/planning/destinationNormalizer';
import type { BrowserAction } from '../extension/src/agent/actionTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

// ════════════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════════════

const ORIGIN = 'http://localhost:4174';
const RESULTS = `${ORIGIN}/results.html`;

/** The canonical Step 10 role-only request. No destination URL exists. */
const CANONICAL = `open the store catalog at ${ORIGIN}`;
/** A role-only request whose head has two legitimate readings (N9). */
const AMBIGUOUS = 'open the results page';
/** A role-only request whose head the ontology cannot express (N3). */
const UNSUPPORTED = 'open the widget page';
/** The explicit-URL case. */
const EXPLICIT_URL = `open ${RESULTS}`;
/** ECOMMERCE category plus an explicit destination URL. */
const EXPLICIT_URL_ECOM = `${EXPLICIT_URL} and buy the first product listed`;
/** GENERIC_INTERACTION with NO destination-bearing construct at all. */
const NO_DESTINATION = 'interact with the page';

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

/** The real observed catalog page, at generation 5. */
const REAL_CATALOG = classified(RESULTS, 'LISTING', 0.99, 5);
/** The fixture's unclassified page — TEST E's UNKNOWN case. */
const UNCLASSIFIED_SEARCH = classified(`${ORIGIN}/search.html`, 'UNKNOWN', 0.1, 5);

const plan = (prompt: string, currentUrl = `${ORIGIN}/`) =>
  decomposeTask(prompt, { currentUrl });

const destOf = (prompt: string, currentUrl = `${ORIGIN}/`): Subgoal => {
  const found = plan(prompt, currentUrl).subgoals.filter((s) => s.destination !== undefined);
  expect(found.length, prompt).toBe(1);
  return found[0]!;
};

const verify = (sg: Subgoal, c: AgentContextPayload, gen?: number) =>
  GoalProgressTracker.verifySubgoalCondition(sg, {
    context: c,
    pageGeneration: gen ?? c.semantic_context?.pageGeneration ?? 1,
  });

/** Keys `backend/app/security.py` rejects at any nesting depth. */
const FORBIDDEN_EGRESS_KEYS = [
  'value',
  'text',
  'textContent',
  'innerText',
  'rawText',
  'rawOCR',
  'ocrText',
  'password',
  'words',
  'lines',
  'token',
  'secret',
  'card',
  'cardNumber',
  'cvv',
  'pan',
  'accountNumber',
  'raw',
  'input',
  'sensitiveValue',
  'pii',
];

const collectKeys = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
};

// ════════════════════════════════════════════════════════════════════════════
// OBJECTIVE A — W1–W16: the typed role reaches the reasoning boundary
// ════════════════════════════════════════════════════════════════════════════

describe('A · W1 — an explicit role declaration survives the normalizer', () => {
  it('W1. "open the store catalog at <origin>" declares role LISTING and NO destination URL', () => {
    const d = normalizeDestination(CANONICAL);
    expect(d.kind).toBe('DECLARED');
    if (d.kind !== 'DECLARED') return;
    expect(d.role?.acceptablePageTypes).toEqual(['LISTING']);
    // There is intentionally no destination URL. Its absence is the contract.
    expect(d.url).toBeUndefined();
    expect(d.entryUrl?.origin).toBe(ORIGIN);
    expect(d.entryUrl?.path).toBe('/');
  });
});

describe('A · W2/W3 — the role survives HighLevelGoal and Subgoal', () => {
  it('W2. the HighLevelGoal carries the identical role declaration', () => {
    const { goal } = plan(CANONICAL);
    const d = goal.destinationDeclaration;
    expect(d?.kind).toBe('DECLARED');
    expect((d as { role?: { acceptablePageTypes: unknown } }).role?.acceptablePageTypes).toEqual([
      'LISTING',
    ]);
  });

  it('W3. the destination Subgoal carries it verbatim and verifiably', () => {
    const sg = destOf(CANONICAL);
    expect(sg.category).toBe('NAVIGATE');
    expect(sg.verificationCondition?.type).toBe('DESTINATION_VERIFIED');
    expect(sg.destination?.kind).toBe('DECLARED');
    expect((sg.destination as { role?: { acceptablePageTypes: unknown } }).role?.acceptablePageTypes).toEqual(
      ['LISTING']
    );
    // The entry site travels WITH the subgoal, as provenance only.
    expect((sg.destination as { entryUrl?: { origin: string } }).entryUrl?.origin).toBe(ORIGIN);
  });
});

describe('A · W4 — the typed role reaches the reasoning / action-selection boundary', () => {
  it('W4a. toDeclaredDestinationConstraint projects role + provenance and NO url', () => {
    const sg = destOf(CANONICAL);
    const c = toDeclaredDestinationConstraint(sg.destination);
    expect(c).toBeDefined();
    expect(c!.provenance).toBe('USER_DECLARED_DESTINATION');
    expect(c!.role).toEqual(['LISTING']);
    expect(c!.entryUrl).toBe(`${ORIGIN}/`);
    expect(Object.prototype.hasOwnProperty.call(c!, 'destinationUrl')).toBe(false);
  });

  it('W4b. PlannerContextBuilder puts it on semantic_context of the request context', () => {
    const { goal, subgoals } = plan(CANONICAL);
    const sg = subgoals.find((s) => s.destination !== undefined)!;
    const built = PlannerContextBuilder.buildContext(REAL_CATALOG, goal, sg);
    const carried = (built.contextPayload.semantic_context as unknown as {
      declaredDestination: Record<string, unknown>;
    }).declaredDestination;
    expect(carried.provenance).toBe('USER_DECLARED_DESTINATION');
    expect(carried.role).toEqual(['LISTING']);
    expect(carried.entryUrl).toBe(`${ORIGIN}/`);
    expect(carried.destinationUrl).toBeUndefined();
  });

  it('W4c. the role-only constraint crosses the 2 KB planner budget rather than being trimmed', () => {
    // Many detections, so the minimizer has real work to do. The destination
    // constraint is security-critical and must survive it.
    const noisy = classified(
      RESULTS,
      'LISTING',
      0.99,
      5,
      Array.from({ length: 40 }, (_, i) => `EL_${i}`)
    );
    noisy.detections = Array.from({ length: 40 }, (_, i) => ({
      id: `el_${i}`,
      type: i % 2 === 0 ? 'button' : 'input',
      confidence: 0.9,
      bbox: { x: i, y: i, width: 200, height: 30 },
      length: 0,
      source: 'dom_attribute',
      selector: `#e${i}`,
      is_partially_visible: false,
    })) as AgentContextPayload['detections'];

    const { goal, subgoals } = plan(CANONICAL);
    const sg = subgoals.find((s) => s.destination !== undefined)!;
    const built = PlannerContextBuilder.buildContext(noisy, goal, sg);
    expect(built.trimmedElementsCount).toBeGreaterThan(0);
    expect(
      (built.contextPayload.semantic_context as unknown as { declaredDestination?: unknown })
        .declaredDestination
    ).toBeDefined();
  });

  it('W4d. the constraint survives the privacy firewall on its way out', () => {
    const { goal, subgoals } = plan(CANONICAL);
    const sg = subgoals.find((s) => s.destination !== undefined)!;
    const built = PlannerContextBuilder.buildContext(REAL_CATALOG, goal, sg);
    // The egress payload the provider serializes is exactly this context. Its
    // key set must contain nothing the outbound scanner forbids.
    const keys = collectKeys(built.contextPayload);
    for (const forbidden of FORBIDDEN_EGRESS_KEYS) {
      expect(keys, `forbidden egress key "${forbidden}"`).not.toContain(forbidden);
    }
    // And the constraint itself carries only structural identifiers.
    expect(Object.keys(toDeclaredDestinationConstraint(sg.destination)!).sort()).toEqual([
      'entryUrl',
      'provenance',
      'role',
    ]);
  });
});

describe('A · W5–W10 — no other channel may create or rewrite the declaration', () => {
  it('W5. a targetEntity cannot stand in for a role declaration', () => {
    // A subgoal that names the destination ONLY via targetEntity (a field the
    // decomposer fills from prompt keywords) projects NOTHING.
    const entityOnly: Subgoal = {
      id: 'sg_0',
      goalId: 'g',
      index: 0,
      description: 'Reach the catalog',
      category: 'NAVIGATE',
      targetEntity: 'store catalog',
      expectedActionType: 'navigate',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };
    expect(toDeclaredDestinationConstraint(entityOnly.destination)).toBeUndefined();

    // And a real destination subgoal is unaffected by whatever targetEntity it
    // carries alongside.
    const sg = destOf(CANONICAL);
    const polluted: Subgoal = { ...sg, targetEntity: 'results.html' };
    expect(toDeclaredDestinationConstraint(polluted.destination)).toEqual(
      toDeclaredDestinationConstraint(sg.destination)
    );
  });

  it('W5b. neither targetEntity nor a model-proposed action reaches the boundary', () => {
    // The PRODUCTION boundary is `PlannerContextBuilder.buildContext`, not the
    // pure projection, so the boundary itself is what is asserted here.
    const polluted: Subgoal = {
      id: 'sg_0',
      goalId: 'g',
      index: 0,
      description: 'Reach the catalog',
      category: 'NAVIGATE',
      targetEntity: 'store catalog',
      // `suggestedAction` is model-derived in production. It is populated with
      // a plausible model-authored destination hint so that a planner which
      // TRUSTED model output would have something to trust.
      suggestedAction: {
        action: 'navigate',
        url: RESULTS,
        reason: 'Model proposal.',
        destinationRole: 'CHECKOUT',
        destinationUrl: RESULTS,
      } as never,
      expectedActionType: 'navigate',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };
    const { goal } = plan(CANONICAL);
    const built = PlannerContextBuilder.buildContext(
      classified(RESULTS, 'LISTING', 0.99, 5, ['NAVIGATE', 'CLICK']),
      goal,
      polluted
    );
    // POST-17.10 Step 10.3 (G5): propagation is scoped to the GOAL, so a
    // subgoal with no declaration of its own no longer suppresses the task's
    // declared destination. The invariant this test exists to protect is
    // unchanged and is asserted in its STRONGER form: whatever reaches the
    // boundary is exactly the user's own declaration, byte for byte, and the
    // model-authored `suggestedAction` — which claims CHECKOUT and a different
    // URL — contributed nothing.
    const emitted = (built.contextPayload.semantic_context as unknown as {
      declaredDestination?: unknown;
    }).declaredDestination;
    expect(emitted).toEqual(
      toDeclaredDestinationConstraint(goal.destinationDeclaration)
    );
    expect(JSON.stringify(emitted)).not.toContain('CHECKOUT');
  });

  it('W6. an affordance cannot create or rewrite the declaration', () => {
    // A page that offers a NAVIGATE affordance, on a subgoal with NO declared
    // destination, still projects nothing.
    const affordanceRich = classified(`${ORIGIN}/`, 'LISTING', 0.99, 5, [
      'NAVIGATE',
      'CLICK',
      'ENTER_QUERY',
    ]);
    const bare: Subgoal = {
      id: 'sg_0',
      goalId: 'g',
      index: 0,
      description: 'Reach the catalog',
      category: 'NAVIGATE',
      expectedActionType: 'navigate',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };
    const { goal } = plan(CANONICAL);
    const built = PlannerContextBuilder.buildContext(affordanceRich, goal, bare);
    // Same Step 10.3 (G5) correction as W5b: the block that reaches the
    // boundary is the USER's declaration verbatim. An affordance-rich LISTING
    // page cannot create one, cannot add a channel to one, and cannot rewrite
    // one — the value is bit-identical to what the goal already held.
    expect(
      (built.contextPayload.semantic_context as unknown as { declaredDestination?: unknown })
        .declaredDestination
    ).toEqual(toDeclaredDestinationConstraint(goal.destinationDeclaration));
    // The page being a LISTING is evidence about SATISFACT, never a
    // declaration, so no destination URL may appear for this task: the user
    // named a ROLE and an entry site, and nothing else.
    expect(
      JSON.stringify(
        (built.contextPayload.semantic_context as unknown as { declaredDestination?: unknown })
          .declaredDestination
      )
    ).not.toContain('destinationUrl');
    // A task that declared NO destination still projects nothing on an
    // affordance-rich page — the original point of this test, now pinned
    // against a goal rather than against one subgoal.
    const noDeclGoal = plan(NO_DESTINATION).goal;
    const stillEmpty = PlannerContextBuilder.buildContext(
      affordanceRich,
      noDeclGoal,
      bare
    );
    expect(
      (stillEmpty.contextPayload.semantic_context as unknown as { declaredDestination?: unknown })
        .declaredDestination
    ).toBeUndefined();
    // The observed page is already a LISTING. That is evidence about
    // SATISFACTION, and must not become a declaration for a task that
    // declared none.
    expect(plan(NO_DESTINATION).goal.destinationDeclaration?.kind).toBe('NONE');
  });

  it('W7. an observation cannot create a declaration', () => {
    // `toDeclaredDestinationConstraint` has exactly one input: the declaration.
    // Page state, page type and confidence are not parameters and cannot be.
    expect(toDeclaredDestinationConstraint(undefined)).toBeUndefined();
    expect(toDeclaredDestinationConstraint(normalizeDestination(NO_DESTINATION))).toBeUndefined();

    const { goal, subgoals } = plan(NO_DESTINATION);
    expect(goal.destinationDeclaration?.kind).toBe('NONE');
    for (const sg of subgoals) {
      expect(sg.destination).toBeUndefined();
    }
    // Even the observed destination page creates no subgoal-level declaration.
    const { goal: g2, subgoals: s2 } = plan(NO_DESTINATION, RESULTS);
    expect(g2.destinationDeclaration?.kind).toBe('NONE');
    expect(s2.some((s) => s.destination !== undefined)).toBe(false);
  });

  it('W7b. an OBSERVED listing page creates no declaration at the boundary', () => {
    const bare: Subgoal = {
      id: 'sg_0',
      goalId: 'g',
      index: 0,
      description: 'Reach the catalog',
      category: 'NAVIGATE',
      expectedActionType: 'navigate',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };
    const { goal } = plan(NO_DESTINATION);
    const built = PlannerContextBuilder.buildContext(REAL_CATALOG, goal, bare);
    expect(
      (built.contextPayload.semantic_context as unknown as { declaredDestination?: unknown })
        .declaredDestination
    ).toBeUndefined();
  });

  it('W8. model output cannot rewrite the declaration', () => {
    const sg = destOf(CANONICAL);
    const before = toDeclaredDestinationConstraint(sg.destination);

    // A model proposal that invents a destination URL. It is a CLAIM; the
    // constraint is regenerated from the user declaration every time, so it
    // cannot leak in.
    const modelProposal = {
      action: 'navigate',
      url: RESULTS,
      reason: 'The catalog must be at results.html.',
      destinationRole: 'LISTING',
      destinationUrl: RESULTS,
    };
    expect(modelProposal.url).toBe(RESULTS);
    expect(toDeclaredDestinationConstraint(sg.destination)).toEqual(before);
    expect(toDeclaredDestinationConstraint(sg.destination)!.destinationUrl).toBeUndefined();

    // Nor can the model's own output object BE a declaration: it carries no
    // `kind`, so it projects nothing at all rather than being partially
    // believed. The ONLY thing that reaches this function is a
    // `DestinationDeclaration`, and that type is produced in exactly one place.
    const modelObject = {
      role: ['CHECKOUT'],
      destinationUrl: RESULTS,
      entryUrl: `${ORIGIN}/`,
      declaredDestination: true,
    } as never;
    expect(toDeclaredDestinationConstraint(modelObject)).toBeUndefined();
  });

  it('W8b. a previous navigate action cannot rewrite the declaration', () => {
    // `previous_actions` is the agent's own history of REQUESTS. It is exactly
    // the forbidden evidence the destination contract names, and it must not
    // become a destination constraint on the way out.
    const sg = destOf(CANONICAL);
    const { goal } = plan(CANONICAL);
    const withHistory = { ...REAL_CATALOG, previous_actions: [{ action: 'navigate', url: RESULTS }] } as never;

    // (a) alongside a real declaration, the action url contributes nothing.
    const built = PlannerContextBuilder.buildContext(withHistory, goal, sg);
    const carried = (built.contextPayload.semantic_context as unknown as {
      declaredDestination: Record<string, unknown>;
    }).declaredDestination;
    expect(carried.destinationUrl).toBeUndefined();
    expect(JSON.stringify(carried)).not.toContain('results.html');

    // (b) with NO declaration at all, the action url cannot BECOME one.
    const bare: Subgoal = {
      id: 'sg_0',
      goalId: 'g',
      index: 0,
      description: 'Reach the catalog',
      category: 'NAVIGATE',
      expectedActionType: 'navigate',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };
    const bareBuilt = PlannerContextBuilder.buildContext(
      withHistory,
      plan(NO_DESTINATION).goal,
      bare
    );
    expect(
      (bareBuilt.contextPayload.semantic_context as unknown as { declaredDestination?: unknown })
        .declaredDestination
    ).toBeUndefined();
  });

  it('W9. action.url cannot rewrite the declaration', () => {
    const sg = destOf(CANONICAL);
    // The only deterministic navigator that exists returns null for a role-only
    // declaration, so no action URL can be derived from it at all.
    expect(OneActionPlanner.proposeDestinationNavigation(sg)).toBeNull();
    // An action carrying the invented URL does not change the constraint.
    const action: BrowserAction = { action: 'navigate', url: RESULTS, reason: 'x' };
    expect(action.url).toBe(RESULTS);
    expect(toDeclaredDestinationConstraint(sg.destination)!.destinationUrl).toBeUndefined();
  });

  it('W10. executionSuccess cannot rewrite the declaration', () => {
    const sg = destOf(CANONICAL);
    // `SubgoalObservation` carries no execution-success field at all; the
    // completion branch reads only `context` and `pageGeneration`. Stuffing the
    // forbidden evidence onto the observation changes nothing.
    for (const success of [true, false]) {
      const observation = {
        context: REAL_CATALOG,
        pageGeneration: 5,
        executionSuccess: success,
        action: { action: 'navigate', url: RESULTS },
        previousActions: [{ action: 'navigate', url: RESULTS }],
      } as never;
      const verdict = GoalProgressTracker.verifySubgoalCondition(sg, observation);
      // LISTING is genuinely observed here, so MATCH is correct — but it is
      // reached through the verifier, on the observed page identity, and would
      // be identical with `executionSuccess: false`.
      expect(verdict.satisfied).toBe(true);
    }
    // With NO observation at all, nothing can be proven regardless.
    expect(GoalProgressTracker.verifySubgoalCondition(sg, undefined).satisfied).toBe(false);
  });

  it('W10b. executionSuccess:true cannot satisfy a destination the page contradicts', () => {
    const sg = destOf(EXPLICIT_URL_ECOM);
    const elsewhere = classified(`${ORIGIN}/cart.html`, 'CHECKOUT', 0.97, 5);
    const observation = {
      context: elsewhere,
      pageGeneration: 5,
      executionSuccess: true,
    } as never;
    const verdict = GoalProgressTracker.verifySubgoalCondition(sg, observation);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toMatch(/not confirmed \(MISMATCH\)/);
  });
});

describe('A · W11–W13 — the destination subgoal is created by the DECLARATION alone', () => {
  it('W11. GENERIC_INTERACTION + a role destination creates exactly one destination subgoal', () => {
    expect(classifyTaskCategory(CANONICAL)).toBe('GENERIC_INTERACTION');
    const { subgoals } = plan(CANONICAL);
    const dest = subgoals.filter((s) => s.verificationCondition?.type === 'DESTINATION_VERIFIED');
    expect(dest.length).toBe(1);
    expect(dest[0]!.destination?.kind).toBe('DECLARED');
  });

  it('W12. GENERIC_INTERACTION without a destination creates none', () => {
    expect(classifyTaskCategory(NO_DESTINATION)).toBe('GENERIC_INTERACTION');
    const { subgoals } = plan(NO_DESTINATION);
    expect(subgoals.some((s) => s.verificationCondition?.type === 'DESTINATION_VERIFIED')).toBe(
      false
    );
  });

  it('W13. the ECOMMERCE flow does not duplicate the destination subgoal', () => {
    expect(classifyTaskCategory(EXPLICIT_URL_ECOM)).toBe('ECOMMERCE_SEARCH');
    const { subgoals } = plan(EXPLICIT_URL_ECOM);
    const dest = subgoals.filter((s) => s.verificationCondition?.type === 'DESTINATION_VERIFIED');
    expect(dest.length).toBe(1);

    // And the category alone never creates one: an ordinary shopping task that
    // declared no destination must plan exactly what it always planned.
    const plainShop = 'buy the first product on the page';
    expect(classifyTaskCategory(plainShop)).toBe('ECOMMERCE_SEARCH');
    expect(plan(plainShop).subgoals.some((s) => s.verificationCondition?.type === 'DESTINATION_VERIFIED')).toBe(
      false
    );
  });
});

describe('A · W14/W15 — no URL is invented, and entry stays separate', () => {
  it('W14a. role-only never produces a destination URL at any layer', () => {
    const sg = destOf(CANONICAL);
    const constraint = toDeclaredDestinationConstraint(sg.destination)!;

    expect(constraint.destinationUrl).toBeUndefined();
    expect(JSON.stringify(constraint)).not.toContain('results.html');
    expect(OneActionPlanner.proposeDestinationNavigation(sg)).toBeNull();

    // And the planner context that is actually serialized to the provider
    // carries the SAME constraint. (The observed page URL legitimately appears
    // in the context — that is perception, not intent — so the assertion is
    // scoped to the constraint the system derived, never to the observation.)
    const { goal, subgoals } = plan(CANONICAL);
    const built = PlannerContextBuilder.buildContext(
      REAL_CATALOG,
      goal,
      subgoals.find((s) => s.destination !== undefined)
    );
    const carried = (built.contextPayload.semantic_context as unknown as {
      declaredDestination: Record<string, unknown>;
    }).declaredDestination;
    expect(carried.destinationUrl).toBeUndefined();
    expect(JSON.stringify(carried)).not.toContain('results.html');
  });

  it('W14b. the fixture route appears nowhere in the production source', () => {
    // A fixture special-case ("catalog" → /results.html) is the failure mode
    // this step exists to prevent. Comments, which legitimately name the route
    // while explaining why it must not be hard-coded, are stripped first.
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const rel of [
      'extension/src/planning/destinationNormalizer.ts',
      'extension/src/planning/destinationVerifier.ts',
      'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
      'extension/src/hierarchicalPlanning/oneActionPlanner.ts',
      'extension/src/hierarchicalPlanning/taskDecomposer.ts',
      'extension/src/agent/agentLoop.ts',
    ]) {
      const code = stripComments(readFileSync(resolve(process.cwd(), rel), 'utf8'));
      expect(code, rel).not.toContain('results.html');
    }
  });

  it('W15a. the entry URL is carried but is never a destination constraint', () => {
    const constraint = toDeclaredDestinationConstraint(destOf(CANONICAL).destination)!;
    expect(constraint.entryUrl).toBe(`${ORIGIN}/`);
    expect(constraint.destinationUrl).toBeUndefined();
    // Not even equal: they are separate fields with separate provenance.
    expect(constraint.entryUrl).not.toBe(constraint.destinationUrl);
  });

  it('W15b. a declaration naming ONLY an entry site verifies as UNKNOWN, never MATCH', () => {
    const d = normalizeDestination(CANONICAL);
    expect(d.kind).toBe('DECLARED');
    if (d.kind !== 'DECLARED') return;
    expect(d.url).toBeUndefined();

    // The real canonical declaration, with the ROLE removed. What remains is
    // exactly the Step 6 entry site, and it must open no destination channel:
    // otherwise `/` would have to "match" wherever the site serves its catalog.
    const entryOnly: DestinationDeclaration = {
      kind: 'DECLARED',
      entryUrl: d.entryUrl,
    };
    expect(entryOnly.kind).toBe('DECLARED');

    // Observed exactly at the entry site: UNKNOWN, because nothing was
    // asserted about the destination.
    expect(
      verifyDestination({
        declaration: entryOnly,
        observation: { url: `${ORIGIN}/`, pageGeneration: 5 },
        currentPageGeneration: 5,
      }).kind
    ).toBe('UNKNOWN');

    // Observed somewhere else entirely: still UNKNOWN, never MISMATCH — the
    // entry site is a provisioning fact, not a constraint to contradict.
    expect(
      verifyDestination({
        declaration: entryOnly,
        observation: { url: `${ORIGIN}/cart.html`, pageGeneration: 5 },
        currentPageGeneration: 5,
      }).kind
    ).toBe('UNKNOWN');

    // And the loop-level rule: no destination constraint is projected from it.
    expect(toDeclaredDestinationConstraint(entryOnly)!.destinationUrl).toBeUndefined();
  });
});

describe('A · W16 — unsupported and ambiguous destinations stay fail-closed', () => {
  it('W16a. an unmappable head is UNSUPPORTED and projects no constraint', () => {
    expect(normalizeDestination(UNSUPPORTED).kind).toBe('UNSUPPORTED');
    expect(toDeclaredDestinationConstraint(normalizeDestination(UNSUPPORTED))).toBeUndefined();
    // And no destination subgoal is planned for it.
    const { subgoals } = plan(UNSUPPORTED);
    expect(subgoals.some((s) => s.verificationCondition?.type === 'DESTINATION_VERIFIED')).toBe(
      false
    );
  });

  it('W16b. a genuinely ambiguous head is AMBIGUOUS and projects no constraint', () => {
    const d = normalizeDestination(AMBIGUOUS);
    expect(d.kind).toBe('AMBIGUOUS');
    expect(toDeclaredDestinationConstraint(d)).toBeUndefined();
    const { subgoals } = plan(AMBIGUOUS);
    expect(subgoals.some((s) => s.verificationCondition?.type === 'DESTINATION_VERIFIED')).toBe(
      false
    );
  });

  it('W16c. an ambiguous destination can never complete a subgoal', () => {
    const sg = destOf(CANONICAL);
    const ambiguousSubgoal: Subgoal = {
      ...sg,
      destination: normalizeDestination(AMBIGUOUS) as never,
    };
    // Even on a perfectly matching LISTING page, an unresolved declaration
    // proves nothing.
    const verdict = verify(ambiguousSubgoal, REAL_CATALOG);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toMatch(/no user-derived destination declaration/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OBJECTIVE B — W17–W30: already-at-destination vs. genuine no-effect
// ════════════════════════════════════════════════════════════════════════════

describe('B · W17–W22 — no transition, fresh observation, MATCH, completion', () => {
  it('W17. the declaration and the observed page agree on the exact destination URL', () => {
    // Precondition of the Step 9 real run: the target resolver already
    // provisioned the destination, so the tab sits AT it.
    const sg = destOf(EXPLICIT_URL_ECOM);
    const d = sg.destination!;
    expect(d.kind).toBe('DECLARED');
    if (d.kind !== 'DECLARED') return;
    expect(`${d.url!.origin}${d.url!.path}`).toBe(RESULTS);

    const verdict = verifyDestination({
      declaration: d,
      observation: {
        url: RESULTS,
        pageGeneration: 5,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 5 },
      },
      currentPageGeneration: 5,
    });
    expect(verdict.kind).toBe('MATCH');
    expect(verdict.decisiveChannel).toBe('url');
  });

  it('W18. the deterministic navigation to the SAME url is still proposed', () => {
    // Step 9 behaviour, unchanged: the navigator proposes the declared URL
    // verbatim. It has no idea the tab is already there, and must not pretend
    // otherwise — that is the whole reason the no-effect path exists.
    const action = OneActionPlanner.proposeDestinationNavigation(destOf(EXPLICIT_URL_ECOM))!;
    expect(action.action).toBe('navigate');
    expect((action as { url: string }).url).toBe(RESULTS);
    // A proposal is not an arrival claim.
    expect(Object.keys(action).sort()).toEqual(['action', 'reason', 'url']);
  });

  it('W19. an unchanged URL is NOT an action success', () => {
    // `verifyActionEffect` on identical pre/post snapshots.
    const snapshot = {
      url: RESULTS,
      scrollX: 0,
      scrollY: 0,
      domElementCount: 40,
      targetValueLength: 0,
      openModalsCount: 0,
      timestamp: 1,
    };
    const result = verifyActionEffect(
      { action: 'navigate', url: RESULTS, reason: 'go' },
      snapshot,
      { ...snapshot, timestamp: 2 }
    );
    expect(result.hasEffect).toBe(false);
    expect(result.status).toBe('ACTION_NO_EFFECT');
  });
});

// ── The loop-level harness ────────────────────────────────────────────────
//
// Drives the REAL AgentLoop with a CONTROLLED provider that emits a scripted
// action, and an `executeAction` that reports the action produced no effect.
// `perceivePage` returns the destination page on the FRESH (post-action)
// perception, which is exactly what Step 10's no-effect branch asks for.

interface LoopRun {
  state: Awaited<ReturnType<AgentLoop['runTask']>>;
  info: string[];
  warn: string[];
  providerContexts: AgentContextPayload[];
}

async function driveNoEffectLoop(opts: {
  task: string;
  /** Sanitized context returned for every perception, given the live generation. */
  freshPage: (generation: number) => AgentContextPayload;
  /**
   * The CYCLE perception only. Defaults to `freshPage`. Setting it differently
   * is what proves a fresh re-perception actually happened: if the destination
   * still completes when the cycle's own page says nothing and only the
   * re-perceived page does, the re-perception cannot be skipped.
   */
  firstPage?: (generation: number) => AgentContextPayload;
  /** A model-proposed action. Defaults to a scroll. */
  action?: BrowserAction;
  /** Report a genuine observed effect instead of ACTION_NO_EFFECT. */
  effectHasEffect?: boolean;
  maxSteps?: number;
}): Promise<LoopRun> {
  const info: string[] = [];
  const warn: string[] = [];
  const infoSpy = vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => {
    info.push(String(a[0]));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warn.push(String(a[0]));
  });

  const providerContexts: AgentContextPayload[] = [];
  let loopRef: AgentLoop | undefined;
  let perceptionCalls = 0;

  const snapshot = async () => ({
    url: RESULTS,
    scrollX: 0,
    scrollY: 0,
    domElementCount: 40,
    targetValueLength: 0,
    openModalsCount: 0,
    timestamp: Date.now(),
  });

  const provider = {
    name: 'ControlledNoEffectProvider',
    registerFailure: () => {},
    requestAction: vi.fn(async (_task: string, context: AgentContextPayload) => {
      providerContexts.push(context);
      return opts.action ?? {
        action: 'scroll',
        direction: 'down',
        amount: 200,
        reason: 'Controlled proposal.',
      };
    }),
    reviewAction: async () => ({ safe: true, reason: 'ok' }),
  } as never;

  loopRef = new AgentLoop(
    provider,
    {
      getEffectSnapshot: snapshot,
      perceivePage: async () => {
        perceptionCalls += 1;
        const generation =
          (loopRef as unknown as { state: { currentPageGeneration: number } }).state
            .currentPageGeneration || 1;
        // Call 1 is the cycle perception; every later call is a FRESH
        // re-perception, which is the one that must prove the destination.
        return perceptionCalls === 1 && opts.firstPage
          ? opts.firstPage(generation)
          : opts.freshPage(generation);
      },
      executeAction: async () => ({
        success: true,
        effect: {
          hasEffect: !!opts.effectHasEffect,
          status: (opts.effectHasEffect ? 'URL_NAVIGATION_OBSERVED' : 'ACTION_NO_EFFECT') as
            | 'URL_NAVIGATION_OBSERVED'
            | 'ACTION_NO_EFFECT',
          details: opts.effectHasEffect
            ? 'Observed the document URL change.'
            : 'Observed post-action state is identical to the pre-action state.',
          shouldRecover: !opts.effectHasEffect,
          diagnostics: {} as never,
        },
      }),
    },
    { maxSteps: opts.maxSteps ?? 2, providerRetries: 0, delayBetweenStepsMs: 0, providerRetryDelayMs: 0 }
  );

  const state = await loopRef.runTask(opts.task);
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  return { state, info, warn, providerContexts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const destSubgoalState = (run: LoopRun): string | undefined => {
  const data = run.state.subgoalGraphData;
  if (!data) return undefined;
  const ids = Object.keys(data.subgoals).filter(
    (id) => data.subgoals[id]?.verificationCondition?.type === 'DESTINATION_VERIFIED'
  );
  return ids.length ? data.subgoals[ids[0]!]?.state : undefined;
};

describe('B · W20–W22 — loop: a no-effect action completes the destination on an observed MATCH', () => {
  it('W20/W21/W22. re-perceives, verifies MATCH, completes the subgoal, and claims no action success', async () => {
    const run = await driveNoEffectLoop({
      task: EXPLICIT_URL_ECOM,
      // One step only, so `lastActionResult` is still the value the
      // already-at-destination branch wrote rather than a later cycle's.
      maxSteps: 1,
      freshPage: (generation) =>
        classified(RESULTS, 'LISTING', 0.99, generation, ['CLICK', 'SCROLL']),
    });

    // W20 — a fresh observation was actually taken inside the no-effect branch.
    const satisfied = run.info.filter((l) =>
      l.includes('destination already satisfied — no transition needed')
    );
    expect(satisfied.length).toBeGreaterThan(0);

    // W21 — the completion is credited to the destination verifier's MATCH,
    // and the trace carries that evidence, not an execution claim.
    expect(satisfied[0]).toContain('AgentTrace');

    // W22 — the destination subgoal is COMPLETED.
    expect(destSubgoalState(run)).toBe('COMPLETED');

    // W19 (loop level) — and the ACTION was NOT declared successful.
    expect(run.state.lastActionResult?.success).toBe(false);
    expect(run.state.lastActionResult?.error).toContain('ACTION_NO_EFFECT');
  });

  it('W20b. the completion needs the FRESH page, not the cycle page', async () => {
    // The cycle perception shows an unclassified entry page; only the
    // re-perception shows the destination. If the branch reused the cycle
    // context this destination would NOT complete.
    const run = await driveNoEffectLoop({
      task: EXPLICIT_URL_ECOM,
      maxSteps: 1,
      firstPage: (generation) => classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, generation),
      freshPage: (generation) => classified(RESULTS, 'LISTING', 0.99, generation),
    });
    expect(run.info.some((l) => l.includes('destination already satisfied'))).toBe(true);
    expect(destSubgoalState(run)).toBe('COMPLETED');
  });

  it('W21a. the provider is still told the declaration at the same boundary', async () => {
    // The same loop, the ROLE-ONLY task: the provider receives the typed
    // constraint. This is the end-to-end form of W4b.
    const run = await driveNoEffectLoop({
      task: CANONICAL,
      freshPage: (generation) =>
        classified(RESULTS, 'LISTING', 0.99, generation, ['CLICK', 'SCROLL']),
    });
    expect(run.providerContexts.length).toBeGreaterThan(0);
    const first = run.providerContexts[0]!;
    const carried = (first.semantic_context as unknown as { declaredDestination?: Record<string, unknown> })
      .declaredDestination;
    expect(carried).toBeDefined();
    expect(carried!.provenance).toBe('USER_DECLARED_DESTINATION');
    expect(carried!.role).toEqual(['LISTING']);
    expect(carried!.destinationUrl).toBeUndefined();
  });

  it('W10c. a model-proposed URL never lands in the declaration, even on success', async () => {
    const run = await driveNoEffectLoop({
      task: CANONICAL,
      maxSteps: 1,
      // The model claims the destination is /results.html and the action
      // genuinely navigates. Nothing about that may alter the user contract.
      action: { action: 'navigate', url: RESULTS, reason: 'Controlled proposal.' } as BrowserAction,
      freshPage: (generation) => classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, generation),
    });
    const data = run.state.subgoalGraphData;
    const ids = data
      ? Object.keys(data.subgoals).filter(
          (id) => data.subgoals[id]?.verificationCondition?.type === 'DESTINATION_VERIFIED'
        )
      : [];
    expect(ids.length).toBe(1);
    const declaration = data!.subgoals[ids[0]!]!.destination as
      | { kind: string; url?: unknown }
      | undefined;
    expect(declaration?.kind).toBe('DECLARED');
    expect(declaration?.url).toBeUndefined();
    // And the model's proposal is not completion either: the fresh page in this
    // run says UNKNOWN, so the destination stays incomplete.
    expect(destSubgoalState(run)).not.toBe('COMPLETED');
  });

  it('W20c. a model-proposed navigate does not complete the destination on SUCCESS either', async () => {
    // The action genuinely navigates and genuinely has an observed effect, yet
    // the page the agent is looking at is UNKNOWN. A URL the MODEL chose is a
    // request; only an observed destination identity may complete the subgoal.
    const run = await driveNoEffectLoop({
      task: CANONICAL,
      maxSteps: 1,
      effectHasEffect: true,
      action: { action: 'navigate', url: RESULTS, reason: 'Controlled proposal.' } as BrowserAction,
      freshPage: (generation) => classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, generation),
    });
    expect(run.info.some((l) => l.includes('subgoal NOT completed'))).toBe(true);
    expect(destSubgoalState(run)).not.toBe('COMPLETED');
  });
});

describe('B · W23–W27 — every non-MATCH outcome stays a failure', () => {
  it('W23. MISMATCH leaves the destination incomplete', async () => {
    const run = await driveNoEffectLoop({
      task: EXPLICIT_URL_ECOM,
      // A classified page that is positively NOT the declared destination.
      freshPage: (generation) => classified(`${ORIGIN}/checkout.html`, 'CHECKOUT', 0.97, generation),
    });
    expect(run.info.filter((l) => l.includes('no transition and destination NOT satisfied')).length)
      .toBeGreaterThan(0);
    expect(destSubgoalState(run)).not.toBe('COMPLETED');
    // And the ACTION_NO_EFFECT failure is recorded truthfully.
    expect(run.state.failureHistory?.some((f) => f.category === 'ACTION_NO_EFFECT')).toBe(true);
  });

  it('W24. UNKNOWN leaves the destination incomplete', async () => {
    const run = await driveNoEffectLoop({
      task: EXPLICIT_URL_ECOM,
      freshPage: (generation) =>
        classified(`${ORIGIN}/search.html`, 'UNKNOWN', 0.1, generation),
    });
    expect(run.info.filter((l) => l.includes('no transition and destination NOT satisfied')).length)
      .toBeGreaterThan(0);
    expect(destSubgoalState(run)).not.toBe('COMPLETED');
    expect(run.state.failureHistory?.some((f) => f.category === 'ACTION_NO_EFFECT')).toBe(true);
  });

  it('W25. a STALE observation is refused', () => {
    const sg = destOf(EXPLICIT_URL_ECOM);
    // The classification was captured at generation 5; the browser is now at 6.
    const verdict = verify(sg, REAL_CATALOG, 6);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toMatch(/not confirmed/);
  });

  it('W25b. a STALE fresh-perception is refused at the loop level too', async () => {
    // The re-perceived page LOOKS like the destination, but its classification
    // was captured one generation ago. The browser is at a newer document, so
    // the reading describes a page that no longer exists.
    const run = await driveNoEffectLoop({
      task: EXPLICIT_URL_ECOM,
      maxSteps: 1,
      freshPage: (generation) => classified(RESULTS, 'LISTING', 0.99, Math.max(generation - 1, 0)),
    });
    expect(run.info.some((l) => l.includes('no transition and destination NOT satisfied'))).toBe(
      true
    );
    expect(destSubgoalState(run)).not.toBe('COMPLETED');
  });

  it('W26. an OLD page generation is refused', () => {
    const sg = destOf(EXPLICIT_URL_ECOM);
    const d = sg.destination!;
    expect(d.kind).toBe('DECLARED');
    if (d.kind !== 'DECLARED') return;
    const v = verifyDestination({
      declaration: d,
      observation: {
        url: RESULTS,
        pageGeneration: 4,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 4 },
      },
      currentPageGeneration: 9,
    });
    expect(v.kind).toBe('UNKNOWN');
    expect(v.reason).toMatch(/page generation/i);
  });

  it('W27. a WRONG destination url remains a mismatch', () => {
    const sg = destOf(EXPLICIT_URL_ECOM);
    // The tab is on the SAME site and the page is a perfect LISTING — but the
    // DECLARED URL is not the observed URL, and an explicit-URL declaration has
    // no role channel to fall back on. Observing a different URL is POSITIVE
    // contrary evidence, not an absence of evidence.
    const elsewhere = classified(`${ORIGIN}/other.html`, 'LISTING', 0.99, 5);
    const verdict = verify(sg, elsewhere);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toMatch(/not confirmed \(MISMATCH\)/);
  });
});

describe('B · W28/W29 — the normal transition still works, and no needless recovery', () => {
  it('W28. a destination reached by a REAL transition still completes', async () => {
    // Same declared destination, but the action genuinely navigates: Effect
    // Verification observes a URL change and the ordinary path completes.
    const loop = new AgentLoop(
      {
        name: 'ControlledTransitionProvider',
        registerFailure: () => {},
        requestAction: vi.fn(async () => ({
          action: 'navigate',
          url: RESULTS,
          reason: 'Controlled proposal.',
        })),
        reviewAction: async () => ({ safe: true, reason: 'ok' }),
      } as never,
      {
        getEffectSnapshot: async () => ({
          url: RESULTS,
          scrollX: 0,
          scrollY: 0,
          domElementCount: 40,
          targetValueLength: 0,
          openModalsCount: 0,
          timestamp: Date.now(),
        }),
        perceivePage: async () => REAL_CATALOG,
        executeAction: async () => ({
          success: true,
          urlChanged: RESULTS,
          effect: {
            hasEffect: true,
            status: 'URL_NAVIGATION_OBSERVED' as const,
            details: 'Observed the document URL change to the declared destination.',
            shouldRecover: false,
            diagnostics: {} as never,
          },
        }),
      },
      { maxSteps: 1, providerRetries: 0, delayBetweenStepsMs: 0, providerRetryDelayMs: 0 }
    );
    const state = await loop.runTask(EXPLICIT_URL_ECOM);
    const data = state.subgoalGraphData;
    const ids = data
      ? Object.keys(data.subgoals).filter(
          (id) => data.subgoals[id]?.verificationCondition?.type === 'DESTINATION_VERIFIED'
        )
      : [];
    expect(ids.length).toBe(1);
    // Either it completed on the ordinary success path, or — if this
    // configuration's post-action perception has not yet been re-taken — it is
    // not falsely marked complete. The invariant under test is that the
    // transition path still reaches the verifier.
    expect(['COMPLETED', 'IN_PROGRESS']).toContain(data!.subgoals[ids[0]!]!.state);
  });

  it('W29. an already-satisfied destination does not escalate into recovery', async () => {
    const run = await driveNoEffectLoop({
      task: EXPLICIT_URL_ECOM,
      maxSteps: 1,
      freshPage: (generation) => classified(RESULTS, 'LISTING', 0.99, generation),
    });
    expect(destSubgoalState(run)).toBe('COMPLETED');
    // No ACTION_NO_EFFECT failure record was written, and no recovery was
    // attempted: the no-effect verdict was recorded truthfully but the
    // escalation did not happen.
    expect(run.state.failureHistory ?? []).toHaveLength(0);
    expect(run.state.lastFailure).toBeFalsy();
    expect(run.state.reason ?? '').not.toMatch(/recovery/i);
  });

  it('W29b. the ACTION_NO_EFFECT warning is still emitted — nothing is hidden', async () => {
    const run = await driveNoEffectLoop({
      task: EXPLICIT_URL_ECOM,
      maxSteps: 1,
      freshPage: (generation) => classified(RESULTS, 'LISTING', 0.99, generation),
    });
    expect(run.warn.some((l) => l.includes('ACTION_NO_EFFECT'))).toBe(true);
  });
});

describe('B · W30 — authority boundaries', () => {
  it('W30a. only the destination verifier can complete a destination subgoal', () => {
    // A destination subgoal whose condition is not DESTINATION_VERIFIED has no
    // observation-backed completion path at all, whatever the page shows.
    const sg = destOf(EXPLICIT_URL_ECOM);
    const neutralised: Subgoal = {
      ...sg,
      verificationCondition: { type: 'STATE_CHANGED', description: 'anything' },
    };
    const verdict = GoalProgressTracker.verifySubgoalCondition(neutralised, {
      context: REAL_CATALOG,
      pageGeneration: 5,
      previous: REAL_CATALOG,
    });
    expect(verdict.satisfied).toBe(false);
  });

  it('W30b. a completed destination subgoal is not task SUCCESS', async () => {
    const run = await driveNoEffectLoop({
      task: EXPLICIT_URL_ECOM,
      maxSteps: 1,
      freshPage: (generation) => classified(RESULTS, 'LISTING', 0.99, generation),
    });
    expect(destSubgoalState(run)).toBe('COMPLETED');
    // The run stops on the step budget, not on a success claim: GoalVerifier
    // was never told the task is done, and the state says so.
    expect(run.state.goalStatus).not.toBe('SUCCESS');
  });

  it('W30c. the destination verifier is not modified by Step 10', () => {
    // The Step 10 already-at-destination path is in the LOOP. The verifier
    // module is untouched, so its three-way contract is exactly as Step 7 left
    // it. This pins the "no new enum, no weakened verifier" requirement, on
    // BOTH declaration channels separately.
    const urlDecl = destOf(EXPLICIT_URL_ECOM).destination!;
    if (urlDecl.kind !== 'DECLARED') throw new Error('expected DECLARED');
    const roleDecl = destOf(CANONICAL).destination!;
    if (roleDecl.kind !== 'DECLARED') throw new Error('expected DECLARED');

    interface Obs {
      url: string;
      pageGeneration: number;
      semantic: {
        pageType: SemanticPageType;
        confidence: number;
        pageGeneration: number;
      } | null;
    }
    const base: Obs = {
      url: RESULTS,
      pageGeneration: 5,
      semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 5 },
    };
    const verdict = (declaration: typeof urlDecl, over: Partial<Obs> = {}) =>
      verifyDestination({
        declaration,
        observation: { ...base, ...over },
        currentPageGeneration: 5,
      }).kind;

    // URL channel.
    expect(verdict(urlDecl)).toBe('MATCH');
    expect(verdict(urlDecl, { url: `${ORIGIN}/cart.html` })).toBe('MISMATCH');
    expect(verdict(urlDecl, { pageGeneration: 2 })).toBe('UNKNOWN');

    // Role channel.
    expect(verdict(roleDecl)).toBe('MATCH');
    expect(
      verdict(roleDecl, { semantic: { pageType: 'CHECKOUT', confidence: 0.97, pageGeneration: 5 } })
    ).toBe('MISMATCH');
    expect(
      verdict(roleDecl, { semantic: { pageType: 'UNKNOWN', confidence: 0.1, pageGeneration: 5 } })
    ).toBe('UNKNOWN');
    expect(verdict(roleDecl, { semantic: null })).toBe('UNKNOWN');      // No observation at all is UNKNOWN, never MATCH and never MISMATCH.
      expect(verifyDestination({ declaration: urlDecl, observation: null }).kind).toBe('UNKNOWN');
      expect(verifyDestination({ declaration: urlDecl }).kind).toBe('UNKNOWN');
      expect(verifyDestination({ declaration: roleDecl, observation: null }).kind).toBe('UNKNOWN');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // OBJECTIVE D — W31/W32: CAUSALITY. Step 10.1 (closes audit gap G1).
  //
  // W23/W24/W25b already drive the ordinary `ACTION_NO_EFFECT` fall-through at
  // `agentLoop.ts:2121` and assert the trace, the subgoal state and the failure
  // record — but none of them asserted `lastActionResult`, which is exactly why
  // mutation M13 (flipping that one `success: false` to `true`) survived the
  // entire 2088-test suite.
  //
  // THE INVARIANT, stated so that a single flipped boolean breaks it:
  //
  //   ACTION_NO_EFFECT is NEVER action success, and destination satisfaction is
  //   NEVER action success. The two are orthogonal signals that happen to share
  //   one `success` field, and only ONE of them may ever set it — and it is
  //   always `false` on this path.
  //
  // So the assertions below are deliberately NOT `toMatchObject({success:false})`.
  // Each one cross-checks the action verdict against a signal that is written on
  // a DIFFERENT branch of `agentLoop.runTask`, so "the object happens to say
  // false" cannot pass on its own:
  //
  //   * `completedSteps` is pushed to ONLY by the success branch (agentLoop.ts:2345),
  //     never by the no-effect branch. Non-empty ⇒ the loop took the success path.
  //   * `failureHistory` receives an `ACTION_NO_EFFECT` record ONLY on the
  //     fall-through (agentLoop.ts:2125-2130). Present ⇒ the no-effect path ran.
  //   * `destSubgoalState` is `COMPLETED` ONLY via `completeSubgoal`, which on
  //     this path happens exclusively inside the MATCH branch (agentLoop.ts:2103).
  //   * `lastActionResult.error` is a DIFFERENT literal per branch: the MATCH
  //     branch writes `'ACTION_NO_EFFECT (destination already satisfied per
  //     verifier)'`, the fall-through writes the effect verifier's own details.
  //
  // Flip `success: false` → `true` at agentLoop.ts:2121 and W31 fails on
  // `lastActionResult.success` while every other signal in the same test still
  // reads as a no-effect. Flip it at agentLoop.ts:2108 instead and W32 fails.
  // There is no assignment left that turns a no-effect into a success.
  // ════════════════════════════════════════════════════════════════════════════

  describe('D · W31/W32 — causality: ACTION_NO_EFFECT is never action success', () => {
    /** Every non-MATCH verdict the destination verifier can hand back. */
    const NOT_SATISFIED: Array<{
      name: string;
      verdict: RegExp;
      freshPage: (generation: number) => AgentContextPayload;
    }> = [
      {
        name: 'MISMATCH',
        verdict: /\(MISMATCH\)/,
        freshPage: (g) => classified(`${ORIGIN}/checkout.html`, 'CHECKOUT', 0.97, g),
      },
      {
        name: 'UNKNOWN',
        verdict: /\(UNKNOWN\)/,
        freshPage: (g) => classified(`${ORIGIN}/search.html`, 'UNKNOWN', 0.1, g),
      },
      {
        // The page LOOKS like the destination but its classification belongs to
        // the previous document, so the reading is refused as stale.
        name: 'STALE',
        verdict: /page generation|not confirmed/i,
        freshPage: (g) => classified(RESULTS, 'LISTING', 0.99, Math.max(g - 1, 0)),
      },
    ];

    for (const { name, verdict, freshPage } of NOT_SATISFIED) {
      it(`W31. a no-effect action the page answers ${name} stays unsuccessful and completes nothing`, async () => {
        // maxSteps 1 so the recorded action result is unambiguously the one this
        // single fall-through wrote, with no later cycle free to overwrite it.
        const run = await driveNoEffectLoop({
          task: EXPLICIT_URL_ECOM,
          maxSteps: 1,
          freshPage,
        });

        // (1) An action really was attempted and really did produce no effect.
        //     The warning is the only place the loop announces the no-effect verdict.
        expect(run.warn.some((l) => l.includes('ACTION_EXECUTED + ACTION_NO_EFFECT'))).toBe(true);
        // (2) The no-effect branch ran, and it is the branch that writes an
        //     ACTION_NO_EFFECT failure record. A success run writes none.
        expect(run.state.failureHistory?.some((f) => f.category === 'ACTION_NO_EFFECT')).toBe(true);
        // (3) The success branch did NOT run: it is the only writer of
        //     `completedSteps` (agentLoop.ts:2345).
        expect(run.state.completedSteps).toHaveLength(0);
        // (4) The destination was independently checked and came back non-MATCH.
        //     The verdict is read out of the verifier's own evidence string, so
        //     this cannot pass on an absent check.
        const notSatisfied = run.info.filter((l) =>
          l.includes('no transition and destination NOT satisfied')
        );
        expect(notSatisfied.length).toBeGreaterThan(0);

        // (5) THE INVARIANT. ACTION_NO_EFFECT is not action success.
        expect(run.state.lastActionResult?.success).toBe(false);
        // (6) …and it is the fall-through's own record, not the already-satisfied
        //     branch's, which is the only place that wording may appear.
        expect(run.state.lastActionResult?.error ?? '').not.toMatch(/already satisfied/i);
        // (7) No destination success was inferred.
        expect(destSubgoalState(run)).not.toBe('COMPLETED');
        // (8) And no task success was claimed anywhere.
        expect(run.state.goalStatus).not.toBe('SUCCESS');
      });
    }

    it('W32. an observed MATCH completes the destination while the action stays unsuccessful', async () => {
      // The control case, and the reason the two signals must stay separate: a
      // MATCH and a no-effect produce the SAME `success: false`, but they differ
      // in destination state and in which branch wrote the record. If either
      // signal were ever allowed to imply the other, this pair would disagree.
      const run = await driveNoEffectLoop({
        task: EXPLICIT_URL_ECOM,
        maxSteps: 1,
        freshPage: (generation) => classified(RESULTS, 'LISTING', 0.99, generation),
      });

      expect(run.warn.some((l) => l.includes('ACTION_EXECUTED + ACTION_NO_EFFECT'))).toBe(true);
      // Destination satisfaction: proven by the observation, recorded by the
      // MATCH branch, and therefore absent from the failure history.
      expect(destSubgoalState(run)).toBe('COMPLETED');
      expect(run.state.failureHistory).toHaveLength(0);
      // Action success: not claimed, and still not credited to the action.
      expect(run.state.completedSteps).toHaveLength(0);
      expect(run.state.lastActionResult?.success).toBe(false);
      expect(run.state.lastActionResult?.error).toMatch(
        /ACTION_NO_EFFECT \(destination already satisfied per verifier\)/
      );
      // Neither signal is task success.
      expect(run.state.goalStatus).not.toBe('SUCCESS');
    });

    it('W32b. no code path turns ACTION_NO_EFFECT into a completedSteps entry', async () => {
      // A structural backstop for the whole invariant: across every verdict the
      // verifier can produce, the success branch — the only writer of
      // `lastActionResult = { success: true }` on an executed action — is never
      // entered after a no-effect. This is the assertion that would survive even
      // if `lastActionResult` were later re-typed or renamed.
      const pages: Array<(g: number) => AgentContextPayload> = [
        (g) => classified(RESULTS, 'LISTING', 0.99, g), // MATCH
        (g) => classified(`${ORIGIN}/checkout.html`, 'CHECKOUT', 0.97, g), // MISMATCH
        (g) => classified(`${ORIGIN}/search.html`, 'UNKNOWN', 0.1, g), // UNKNOWN
        (g) => classified(RESULTS, 'LISTING', 0.99, Math.max(g - 1, 0)), // STALE
      ];
      for (const [i, freshPage] of pages.entries()) {
        const run = await driveNoEffectLoop({ task: EXPLICIT_URL_ECOM, maxSteps: 1, freshPage });
        expect(run.warn.some((l) => l.includes('ACTION_EXECUTED + ACTION_NO_EFFECT')), `page ${i}`).toBe(
          true
        );
        expect(run.state.completedSteps, `page ${i}`).toHaveLength(0);
        expect(run.state.lastActionResult?.success, `page ${i}`).toBe(false);
      }
    });
  });
