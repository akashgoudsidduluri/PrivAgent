/**
 * PrivAgent — POST-17.10 Step 10.3: G5, DESTINATION SUBGOAL SCOPING.
 *
 * THE INVARIANT
 * ─────────────
 * A destination MATCH completes ONLY the subgoal that OWNS that declaration.
 *
 * It must not complete another NAVIGATE subgoal, LOCATE, SEARCH, CLICK or
 * FORM_FILL subgoal; it must not complete a second destination subgoal that
 * carries a DIFFERENT declaration; and UNKNOWN, MISMATCH and a STALE
 * observation must complete nothing at all.
 *
 * WHY THIS NEEDS A FILE OF ITS OWN
 * ────────────────────────────────
 * `GoalProgressTracker.verifySubgoalCondition` is already a pure per-subgoal
 * function that reads only `subgoal.destination`, and `agentLoop` only ever
 * calls `completeSubgoal(activeSubgoal.id)`. Both of those are true by
 * inspection — which is exactly why they need executable proof: "looks correct"
 * is not evidence, and a future refactor that hoists destination verification
 * into a task-level "is the destination satisfied?" flag would be invisible
 * without a test that fails when it happens.
 *
 * HONESTY NOTE
 * ────────────
 * Everything here is `PROVEN_UNIT_ONLY` / Node-integration with a CONTROLLED
 * provider. The loop-level section (H) uses a scripted adapter that emits a
 * no-effect action; it is NOT the real reasoner and is never reported as one.
 */

import { describe, it, expect } from 'vitest';

import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import type { SubgoalObservation } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import {
  PlannerContextBuilder,
  toDeclaredDestinationConstraint,
} from '../extension/src/hierarchicalPlanning/plannerContextBuilder';
import { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';
import type { HighLevelGoal, Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const ORIGIN = 'http://localhost:4174';
const RESULTS = `${ORIGIN}/results.html`;
const SEARCH = `${ORIGIN}/search.html`;
const LOGIN = `${ORIGIN}/login.html`;

// ════════════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════════════

function contextAt(
  url: string,
  pageType: SemanticPageType,
  confidence: number,
  pageGeneration: number
): AgentContextPayload {
  return {
    url,
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 3,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    semantic_context: {
      pageType,
      confidence,
      pageState: 'populated',
      pageGeneration,
      entities: [],
      affordances: [],
      promptInjectionDetected: false,
    } as AgentContextPayload['semantic_context'],
  };
}

/** A fresh, current LISTING observation at `/results.html`. */
function listingObservation(generation = 7): SubgoalObservation {
  return {
    context: contextAt(RESULTS, 'LISTING', 0.99, generation),
    pageGeneration: generation,
  };
}

function destinationSubgoal(
  id: string,
  prompt: string,
  index = 0,
  extra: Partial<Subgoal> = {}
): Subgoal {
  return {
    id,
    goalId: 'g1',
    index,
    description: 'Reach the destination declared in the user request',
    category: 'NAVIGATE',
    expectedActionType: 'navigate',
    state: 'PENDING',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
    verificationCondition: { type: 'DESTINATION_VERIFIED', description: 'Declared destination is observed' },
    destination: normalizeDestination(prompt),
    ...extra,
  } as unknown as Subgoal;
}

function unrelatedSubgoal(id: string, category: Subgoal['category'], index = 1): Subgoal {
  // The five categories the Step 10.3 brief names, mapped onto the REAL
  // `SubgoalCategory` enum: CLICK is `SELECT`, FORM_FILL is `FILL`. Using the
  // real enum values matters — a scoping test written against invented
  // category names would prove nothing about the production planner.
  const conditions: Record<string, Subgoal['verificationCondition']> = {
    NAVIGATE: { type: 'URL_CONTAINS', expectedValue: 'example.com', description: 'Elsewhere' },
    LOCATE: { type: 'ELEMENT_EXISTS', expectedValue: 'product-42', description: 'Found it' },
    SEARCH: { type: 'AFFORDANCE_AVAILABLE', expectedValue: 'ENTER_QUERY', description: 'Query box' },
    SELECT: { type: 'ELEMENT_EXISTS', expectedValue: 'add-to-cart', description: 'Button there' },
    FILL: { type: 'ELEMENT_EXISTS', expectedValue: 'email-field', description: 'Field there' },
  };
  return {
    id,
    goalId: 'g1',
    index,
    description: `Unrelated ${category}`,
    category,
    state: 'PENDING',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
    verificationCondition: conditions[category],
  } as unknown as Subgoal;
}

function goalWith(prompt: string): HighLevelGoal {
  return {
    goalId: 'g1',
    rawUserPrompt: prompt,
    sanitizedGoalDescription: prompt,
    taskCategory: 'GENERIC_INTERACTION',
    targetEntities: [],
    constraints: {},
    createdAt: 1_700_000_000_000,
    status: 'ACTIVE',
    destinationDeclaration: normalizeDestination(prompt),
  } as unknown as HighLevelGoal;
}

// ════════════════════════════════════════════════════════════════════════════
// S0 — the producer never hands the declaration to more than one subgoal
// ════════════════════════════════════════════════════════════════════════════

describe('G5-S0 · decomposeTask attaches the declaration to exactly one subgoal', () => {
  const prompts = [
    'open the store catalog',
    'open the store catalog at http://localhost:4174/results.html',
    `open ${RESULTS}`,
    'find the cheapest blue running shoes',
    'go to the login page and sign in',
  ];

  for (const prompt of prompts) {
    it(`at most one subgoal carries a destination: ${JSON.stringify(prompt)}`, () => {
      const plan = decomposeTask(prompt);
      const withDestination = plan.subgoals.filter((sg) => sg.destination !== undefined);
      expect(withDestination.length).toBeLessThanOrEqual(1);
      if (withDestination.length === 1) {
        const owner = withDestination[0]!;
        // The owner must be a destination subgoal, not an incidental one.
        expect(owner.verificationCondition?.type).toBe('DESTINATION_VERIFIED');
        // And it must be a faithful copy of the goal's declaration.
        expect(owner.destination).toEqual(plan.goal.destinationDeclaration);
      }
    });
  }

  it('every subgoal that has NO declaration cannot be completed by a destination MATCH', () => {
    const plan = decomposeTask('open the store catalog at http://localhost:4174/results.html');
    const obs = listingObservation();
    for (const sg of plan.subgoals) {
      if (sg.destination !== undefined) continue;
      const v = GoalProgressTracker.verifySubgoalCondition(sg, obs);
      expect(v.satisfied, `${sg.id}/${sg.category}`).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// S1 — A: one destination subgoal + one unrelated subgoal
// ════════════════════════════════════════════════════════════════════════════

describe('G5-A · a destination MATCH completes only its own subgoal', () => {
  const destination = destinationSubgoal('sg1', 'open the store catalog');

  for (const category of ['NAVIGATE', 'LOCATE', 'SEARCH', 'SELECT', 'FILL'] as const) {
    it(`category ${category}: the unrelated subgoal stays unproven on a matching page`, () => {
      const other = unrelatedSubgoal('sg2', category);
      const obs = listingObservation();

      expect(GoalProgressTracker.verifySubgoalCondition(destination, obs).satisfied).toBe(true);
      const v = GoalProgressTracker.verifySubgoalCondition(other, obs);
      expect(v.satisfied, category).toBe(false);
    });
  }

  it('completing the destination subgoal in the graph leaves the other PENDING', () => {
    const graph = new SubgoalGraph('g1', [destination, unrelatedSubgoal('sg2', 'SELECT')]);
    graph.completeSubgoal(destination.id);
    expect(graph.getSubgoal('sg1')!.state).toBe('COMPLETED');
    expect(graph.getSubgoal('sg2')!.state).not.toBe('COMPLETED');
  });

  it('a matching page completes nothing when the unrelated subgoal is the ACTIVE one', () => {
    // The loop passes only the ACTIVE subgoal to the verifier, so a matching
    // page while a different subgoal is active cannot complete it either.
    const other = unrelatedSubgoal('sg2', 'LOCATE');
    const v = GoalProgressTracker.verifySubgoalCondition(other, listingObservation());
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/product-42/);
  });

  it('the destination MATCH is reported for the subgoal it names, and no other', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(destination, listingObservation());
    expect(v.satisfied).toBe(true);
    expect(v.reason).not.toMatch(/sg2/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// S2 — B and C: two destination-related subgoals with different declarations
// ════════════════════════════════════════════════════════════════════════════

describe('G5-B/C · destination A cannot complete destination B', () => {
  const listing = destinationSubgoal('sgA', 'open the store catalog', 0);
  const search = destinationSubgoal('sgB', 'open the search page', 1);

  it('the two declarations really are different', () => {
    expect(toDeclaredDestinationConstraint(listing.destination!)).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
    expect(toDeclaredDestinationConstraint(search.destination!)).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['SEARCH'],
    });
  });

  it('a LISTING observation satisfies A and leaves B unproven', () => {
    const obs = listingObservation();
    expect(GoalProgressTracker.verifySubgoalCondition(listing, obs).satisfied).toBe(true);
    const b = GoalProgressTracker.verifySubgoalCondition(search, obs);
    expect(b.satisfied).toBe(false);
    expect(b.reason).toMatch(/MISMATCH/);
  });

  it('a SEARCH observation satisfies B and leaves A unproven', () => {
    const obs: SubgoalObservation = {
      context: contextAt(SEARCH, 'SEARCH', 0.97, 3),
      pageGeneration: 3,
    };
    expect(GoalProgressTracker.verifySubgoalCondition(search, obs).satisfied).toBe(true);
    expect(GoalProgressTracker.verifySubgoalCondition(listing, obs).satisfied).toBe(false);
  });

  it('completing A in the graph leaves B untouched', () => {
    const graph = new SubgoalGraph('g1', [listing, search]);
    graph.completeSubgoal('sgA');
    expect(graph.getSubgoal('sgA')!.state).toBe('COMPLETED');
    expect(graph.getSubgoal('sgB')!.state).not.toBe('COMPLETED');
  });

  it('B with the SAME role but a different explicit URL is still not completed by A', () => {
    // Both declare a destination; only the URLs differ. A MATCH on one must
    // not transfer to the other.
    const a = destinationSubgoal('sgA', `open ${RESULTS}`);
    const b = destinationSubgoal('sgB', `open ${ORIGIN}/product.html`);
    expect(GoalProgressTracker.verifySubgoalCondition(a, listingObservation()).satisfied).toBe(true);
    const vb = GoalProgressTracker.verifySubgoalCondition(b, listingObservation());
    expect(vb.satisfied).toBe(false);
    expect(vb.reason).toMatch(/MISMATCH/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// S3 — D / E / F: MISMATCH, UNKNOWN and STALE complete nothing
// ════════════════════════════════════════════════════════════════════════════

describe('G5-D/E/F · only MATCH completes', () => {
  const destination = destinationSubgoal('sg1', 'open the store catalog');

  it('D · a genuinely different page is MISMATCH and completes nothing', () => {
    const obs: SubgoalObservation = {
      context: contextAt(LOGIN, 'LOGIN', 0.99, 4),
      pageGeneration: 4,
    };
    const v = GoalProgressTracker.verifySubgoalCondition(destination, obs);
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/MISMATCH/);
  });

  it('E · UNKNOWN completes nothing', () => {
    // No semantic classification at all.
    const noSemantic: AgentContextPayload = {
      url: RESULTS,
      timestamp: 1,
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: [],
      total_elements_scanned: 0,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
    };
    const v1 = GoalProgressTracker.verifySubgoalCondition(destination, {
      context: noSemantic,
      pageGeneration: 1,
    });
    expect(v1.satisfied).toBe(false);
    expect(v1.reason).toMatch(/No sanitized page classification/);

    // A classification that is itself UNKNOWN.
    const unknownPage: SubgoalObservation = {
      context: contextAt(RESULTS, 'UNKNOWN', 0.99, 1),
      pageGeneration: 1,
    };
    expect(GoalProgressTracker.verifySubgoalCondition(destination, unknownPage).satisfied).toBe(
      false
    );

    // Below the existing confidence floor.
    const lowConfidence: SubgoalObservation = {
      context: contextAt(RESULTS, 'LISTING', 0.05, 1),
      pageGeneration: 1,
    };
    expect(GoalProgressTracker.verifySubgoalCondition(destination, lowConfidence).satisfied).toBe(
      false
    );
  });

  it('F · a STALE observation completes nothing even when it would otherwise MATCH', () => {
    const obs: SubgoalObservation = {
      context: contextAt(RESULTS, 'LISTING', 0.99, 4),
      pageGeneration: 9, // the browser moved on; the classification describes a dead document
    };
    const v = GoalProgressTracker.verifySubgoalCondition(destination, obs);
    expect(v.satisfied).toBe(false);
    expect(v.reason).toMatch(/generation/i);
  });

  it('D/E/F · each of those leaves the graph subgoal incomplete', () => {
    const cases: SubgoalObservation[] = [
      { context: contextAt(LOGIN, 'LOGIN', 0.99, 4), pageGeneration: 4 },
      { context: contextAt(RESULTS, 'UNKNOWN', 0.99, 4), pageGeneration: 4 },
      { context: contextAt(RESULTS, 'LISTING', 0.99, 4), pageGeneration: 9 },
    ];
    for (const obs of cases) {
      const graph = new SubgoalGraph('g1', [destination]);
      const v = GoalProgressTracker.verifySubgoalCondition(destination, obs);
      if (v.satisfied) graph.completeSubgoal(destination.id);
      expect(graph.getSubgoal('sg1')!.state, JSON.stringify(obs.context.semantic_context?.pageGeneration)).not.toBe(
        'COMPLETED'
      );
    }
  });

  it('an AMBIGUOUS or UNSUPPORTED declaration can never complete', () => {
    for (const prompt of ['open the results page', 'open the widget', 'open my account']) {
      const sg = destinationSubgoal('sgX', prompt);
      const kind = (sg.destination as { kind: string }).kind;
      expect(kind === 'DECLARED', prompt).toBe(false);
      const v = GoalProgressTracker.verifySubgoalCondition(sg, listingObservation());
      expect(v.satisfied, prompt).toBe(false);
      expect(v.reason, prompt).toMatch(/no user-derived destination declaration/);
    }
  });

  it('a destination subgoal with no declaration at all fails closed', () => {
    const sg = destinationSubgoal('sgY', 'open the store catalog');
    delete (sg as { destination?: unknown }).destination;
    const v = GoalProgressTracker.verifySubgoalCondition(sg, listingObservation());
    expect(v.satisfied).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// S4 — the declaration's PROPAGATION is scoped too
// ════════════════════════════════════════════════════════════════════════════

describe('G5-S4 · the model-facing declaration follows the ACTIVE subgoal', () => {
  const destination = destinationSubgoal('sg1', 'open the store catalog');
  const other = unrelatedSubgoal('sg2', 'SELECT');

  function plannerContextFor(active: Subgoal) {
    return PlannerContextBuilder.buildContext(
      {
        url: RESULTS,
        timestamp: 1,
        viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
        screenshot_dimensions: null,
        detections: [],
        total_elements_scanned: 0,
        sensitive_elements_detected: 0,
        sanitized_status: 'sanitized_only',
        ocr_metrics: null,
        semantic_context: {
          pageType: 'LISTING',
          confidence: 0.99,
          pageState: 'populated',
          pageGeneration: 2,
          entities: [],
          affordances: [],
          promptInjectionDetected: false,
        } as AgentContextPayload['semantic_context'],
      },
      goalWith('open the store catalog'),
      active
    ).contextPayload;
  }

  it('the destination is present while the destination subgoal is active', () => {
    const ctx = plannerContextFor(destination);
    expect((ctx.semantic_context as unknown as Record<string, unknown>).declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
  });

  it('the destination is PRESENT on a turn where an unrelated subgoal is active', () => {
    // Step 10.3 (G5): propagation scope is the GOAL. The Step 10 case-B
    // capture carried the declaration on only 2 of 7 requests because this
    // projection read the ACTIVE subgoal. The user's declared destination is
    // standing task intent, not a property of whichever subgoal is selected.
    const ctx = plannerContextFor(other);
    expect((ctx.semantic_context as unknown as Record<string, unknown>).declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
  });

  it('and it is present even when NO subgoal is active at all', () => {
    const ctx = PlannerContextBuilder.buildContext(
      {
        url: RESULTS,
        timestamp: 1,
        viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
        screenshot_dimensions: null,
        detections: [],
        total_elements_scanned: 0,
        sensitive_elements_detected: 0,
        sanitized_status: 'sanitized_only',
        ocr_metrics: null,
        semantic_context: {
          pageType: 'LISTING',
          confidence: 0.99,
          pageState: 'populated',
          pageGeneration: 2,
          entities: [],
          affordances: [],
          promptInjectionDetected: false,
        } as AgentContextPayload['semantic_context'],
      },
      goalWith('open the store catalog'),
      undefined
    ).contextPayload;
    expect((ctx.semantic_context as unknown as Record<string, unknown>).declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
  });

  it('widening PROPAGATION did not widen COMPLETION (the critical separation)', () => {
    // The unrelated subgoal now HEARS about the destination. It still cannot be
    // completed by it — completion reads `subgoal.destination` only, and this
    // subgoal has none.
    const ctx = plannerContextFor(other);
    expect(
      (ctx.semantic_context as unknown as Record<string, unknown>).declaredDestination
    ).toBeDefined();
    const v = GoalProgressTracker.verifySubgoalCondition(other, {
      context: ctx,
      pageGeneration: 2,
    });
    expect(v.satisfied).toBe(false);
  });

  it('a goal with NO declaration injects none, whatever subgoal is active', () => {
    const goalNoDecl = {
      ...goalWith('open the store catalog'),
      destinationDeclaration: { kind: 'NONE' as const },
    } as unknown as HighLevelGoal;
    const ctx = PlannerContextBuilder.buildContext(
      {
        url: RESULTS,
        timestamp: 1,
        viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
        screenshot_dimensions: null,
        detections: [],
        total_elements_scanned: 0,
        sensitive_elements_detected: 0,
        sanitized_status: 'sanitized_only',
        ocr_metrics: null,
        semantic_context: {
          pageType: 'LISTING',
          confidence: 0.99,
          pageState: 'populated',
          pageGeneration: 2,
          entities: [],
          affordances: [],
          promptInjectionDetected: false,
        } as AgentContextPayload['semantic_context'],
      },
      goalNoDecl,
      destination
    ).contextPayload;
    expect((ctx.semantic_context as unknown as Record<string, unknown>).declaredDestination).toBeUndefined();
  });
});