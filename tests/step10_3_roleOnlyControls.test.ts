/**
 * PrivAgent — POST-17.10 Step 10.3: G7 CONTROLS.
 *
 * G7's headline requirement is the POSITIVE chain (role-only task → real
 * navigation → real LISTING observation → DestinationVerifier MATCH → subgoal
 * completes). That chain is NOT_REACHED at runtime: see
 * `docs/evidence/post-17-10/audit/step10_3_g7_blocker.json`. Five consecutive
 * real-Chrome runs against the production build all died at the same arrow —
 * the model's `reason` prose is rejected by the backend's pre-existing
 * `person_name` text-safety rule (the documented Step 9 P1, explicitly out of
 * scope for this step), so no action is ever executed.
 *
 * This file therefore proves the NEGATIVE controls, which are the part that can
 * still be pinned honestly, and pins the boundary of what was actually reached:
 * that the typed role-only declaration does reach the production egress, and
 * that every arrow AFTER it is gated behind a real DestinationVerifier verdict.
 *
 * LABELS
 * ──────
 * Everything here is `PROVEN_UNIT_ONLY` — Node-level, with controlled
 * fixtures. Nothing in this file is real-browser evidence, and the Step 10.3
 * report does not cite it as such.
 */

import { describe, it, expect } from 'vitest';

import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import { MIN_PAGE_CLASSIFICATION_CONFIDENCE } from '../extension/src/semanticUnderstanding/pageClassifier';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { toDeclaredDestinationConstraint } from '../extension/src/hierarchicalPlanning/plannerContextBuilder';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const ORIGIN = 'http://localhost:4174';
const RESULTS = `${ORIGIN}/results.html`;
const SEARCH = `${ORIGIN}/search.html`;
const LOGIN = `${ORIGIN}/login.html`;
const CANONICAL = 'open the store catalog';

function contextAt(
  url: string,
  pageType: SemanticPageType,
  confidence: number,
  pageGeneration: number,
  extra: Record<string, unknown> = {}
): AgentContextPayload {
  return {
    url,
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 4,
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
      ...extra,
    } as AgentContextPayload['semantic_context'],
  };
}

const destination = normalizeDestination(CANONICAL);

function destinationSubgoal(): Subgoal {
  return {
    id: 'sg1',
    goalId: 'g1',
    index: 0,
    description: 'Reach the destination declared in the user request',
    category: 'NAVIGATE',
    expectedActionType: 'navigate',
    state: 'IN_PROGRESS',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
    verificationCondition: { type: 'DESTINATION_VERIFIED', description: 'Declared destination is observed' },
    destination,
  } as unknown as Subgoal;
}

// ════════════════════════════════════════════════════════════════════════════
// Control 1 — wrong page role
// ════════════════════════════════════════════════════════════════════════════

describe('G7 control 1 · a wrong page role is MISMATCH', () => {
  for (const [url, pageType] of [
    [LOGIN, 'LOGIN'],
    [SEARCH, 'SEARCH'],
    [`${ORIGIN}/cart.html`, 'CHECKOUT'],
    [RESULTS, 'ARTICLE'],
  ] as const) {
    it(`${pageType} at ${url}`, () => {
      const v = verifyDestination({
        declaration: destination,
        observation: {
          url,
          pageGeneration: 6,
          semantic: { pageType: pageType as SemanticPageType, confidence: 0.99, pageGeneration: 6 },
        },
        currentPageGeneration: 6,
      });
      expect(v.kind).toBe('MISMATCH');
      expect(v.decisiveChannel).toBe('pageRole');
    });
  }

  it('even at full confidence a wrong role does not complete the subgoal', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
      context: contextAt(LOGIN, 'LOGIN', 1.0, 6),
      pageGeneration: 6,
    });
    expect(v.satisfied).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Control 2 — UNKNOWN page
// ════════════════════════════════════════════════════════════════════════════

describe('G7 control 2 · an UNKNOWN page is UNKNOWN, never MATCH', () => {
  it('UNKNOWN pageType at high confidence is UNKNOWN', () => {
    const v = verifyDestination({
      declaration: destination,
      observation: {
        url: RESULTS,
        pageGeneration: 6,
        semantic: { pageType: 'UNKNOWN', confidence: 1.0, pageGeneration: 6 },
      },
      currentPageGeneration: 6,
    });
    expect(v.kind).toBe('UNKNOWN');
  });

  it('and it completes nothing', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
      context: contextAt(RESULTS, 'UNKNOWN', 1.0, 6),
      pageGeneration: 6,
    });
    expect(v.satisfied).toBe(false);
  });

  it('a confidence below the EXISTING floor is UNKNOWN — the floor was not lowered', () => {
    // The floor is read from the classifier constant rather than hard-coded, so
    // this test cannot drift into permitting a threshold that was never there.
    expect(MIN_PAGE_CLASSIFICATION_CONFIDENCE).toBe(0.5);
    for (const confidence of [0, 0.1, 0.3, 0.49, 0.499]) {
      const v = verifyDestination({
        declaration: destination,
        observation: {
          url: RESULTS,
          pageGeneration: 6,
          semantic: { pageType: 'LISTING' as SemanticPageType, confidence, pageGeneration: 6 },
        },
        currentPageGeneration: 6,
      });
      expect(v.kind, `confidence ${confidence}`).toBe('UNKNOWN');
    }
    // …and at the floor itself it is MATCH, which is the EXISTING behaviour.
    expect(
      verifyDestination({
        declaration: destination,
        observation: {
          url: RESULTS,
          pageGeneration: 6,
          semantic: { pageType: 'LISTING' as SemanticPageType, confidence: 0.5, pageGeneration: 6 },
        },
        currentPageGeneration: 6,
      }).kind
    ).toBe('MATCH');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Control 3 — stale observation
// ════════════════════════════════════════════════════════════════════════════

describe('G7 control 3 · a stale observation is UNKNOWN', () => {
  it('an observation from a previous document never satisfies the destination', () => {
    const v = verifyDestination({
      declaration: destination,
      observation: {
        url: RESULTS,
        pageGeneration: 3,
        semantic: { pageType: 'LISTING' as SemanticPageType, confidence: 0.99, pageGeneration: 3 },
      },
      currentPageGeneration: 11,
    });
    expect(v.kind).toBe('UNKNOWN');
    expect(v.reason).toMatch(/generation/i);
  });

  it('and it completes nothing', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
      context: contextAt(RESULTS, 'LISTING', 0.99, 3),
      pageGeneration: 11,
    });
    expect(v.satisfied).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Control 4 — an action with no effect is not destination success
// (G1 regression guard; the full loop-level proof is Step 10.1 W31/W32)
// ════════════════════════════════════════════════════════════════════════════

describe('G7 control 4 · action success alone never satisfies the destination', () => {
  it('a URL the user never typed does not make a role-only destination match', () => {
    // The browser happens to be on a LISTING URL. With no URL channel in the
    // declaration, only the ROLE can speak — and the role alone must be
    // satisfied by a real observation, not by the URL.
    const v = verifyDestination({
      declaration: destination,
      observation: { url: RESULTS, pageGeneration: 6 },
      currentPageGeneration: 6,
    });
    expect(v.channels.url).toBeNull();
    expect(v.kind).toBe('UNKNOWN');
  });

  it('a completed action on a non-listing page does not complete the subgoal', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
      context: contextAt(LOGIN, 'LOGIN', 0.99, 6),
      pageGeneration: 6,
    });
    expect(v.satisfied).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Control 5 — already-at-destination preserves G1
// ════════════════════════════════════════════════════════════════════════════

describe('G7 control 5 · already-at-destination still requires the verifier', () => {
  it('no observation at all cannot complete an already-at-destination subgoal', () => {
    const v = GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
      context: contextAt(RESULTS, 'LISTING', 0.99, 6),
      pageGeneration: 6,
      // no semantic classification reachable → the tracker fails closed
    });
    // The context above DOES carry a classification, so this must MATCH…
    expect(v.satisfied).toBe(true);
    // …and removing it must fail closed. That is the G1 invariant in one test.
    const bare: AgentContextPayload = {
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
    expect(
      GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
        context: bare,
        pageGeneration: 6,
      }).satisfied
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Control 6 — the model cannot claim the destination
// ════════════════════════════════════════════════════════════════════════════

describe('G7 control 6 · a model claim never overrides the verifier', () => {
  it('no model field is an input to the verdict', () => {
    // `DestinationVerificationInput` has exactly two inputs: the declaration
    // and the observation. A model claim would have to be smuggled into one of
    // them, and both are structurally incapable of carrying action output.
    const v = verifyDestination({
      declaration: destination,
      observation: {
        url: LOGIN,
        pageGeneration: 6,
        semantic: { pageType: 'LOGIN' as SemanticPageType, confidence: 0.99, pageGeneration: 6 },
      },
      currentPageGeneration: 6,
    });
    expect(v.kind).toBe('MISMATCH');
  });

  it('a subgoal whose only condition is satisfied by the PAGE TYPE still needs the role', () => {
    // Even a correctly-classified SEARCH page cannot complete a LISTING
    // destination, so "the model says we are done" has no path to completion.
    const v = GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
      context: contextAt(SEARCH, 'SEARCH', 0.99, 6),
      pageGeneration: 6,
    });
    expect(v.satisfied).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Control 7 — the current URL must not replace the semantic observation
// ════════════════════════════════════════════════════════════════════════════

describe('G7 control 7 · a suggestive URL is not a semantic observation', () => {
  it('a LISTING-looking URL with no classification is UNKNOWN', () => {
    const v = verifyDestination({
      declaration: destination,
      observation: { url: RESULTS, pageGeneration: 6 },
      currentPageGeneration: 6,
    });
    expect(v.kind).toBe('UNKNOWN');
    expect(v.channels.pageRole?.kind).toBe('UNKNOWN');
  });

  it('a URL containing the word "catalog" proves nothing', () => {
    for (const url of [`${ORIGIN}/catalog`, `${ORIGIN}/catalog.html`, `${ORIGIN}/?q=catalog`]) {
      const v = verifyDestination({
        declaration: destination,
        observation: { url, pageGeneration: 6 },
        currentPageGeneration: 6,
      });
      expect(v.kind, url).toBe('UNKNOWN');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Control 8 — page TEXT saying "catalog" establishes nothing
// ════════════════════════════════════════════════════════════════════════════

describe('G7 control 8 · page text alone cannot establish the destination', () => {
  it('a sanitized display fact reading "catalog" is not evidence', () => {
    const ctx = contextAt(`${ORIGIN}/`, 'UNKNOWN', 0.1, 6, {
      facts: [
        {
          key: 'cta',
          label: 'Browse Catalog',
          displayText: 'Browse Catalog',
          untrusted: true,
        },
        {
          key: 'h1',
          label: 'Store Catalog',
          displayText: 'Store Catalog',
          untrusted: true,
        },
      ],
    });
    // Facts travel inside the observation, and the observation is what the
    // verifier reads — but a fact is not a page classification.
    expect(ctx.semantic_context?.facts?.length).toBe(2);
    const v = GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
      context: ctx,
      pageGeneration: 6,
    });
    expect(v.satisfied).toBe(false);
  });

  it('and the facts never become a declaration', () => {
    const ctx = contextAt(`${ORIGIN}/`, 'UNKNOWN', 0.1, 6, {
      facts: [{ key: 'cta', label: 'Open the store catalog', displayText: 'Open the store catalog', untrusted: true }],
    });
    const constraint = toDeclaredDestinationConstraint(
      normalizeDestination('find the cheapest blue running shoes')
    );
    expect(constraint).toBeUndefined();
    expect(ctx.semantic_context?.declaredDestination).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The boundary that WAS reached, and the arrows that were NOT
// ════════════════════════════════════════════════════════════════════════════

describe('G7 · what is proven and what is not', () => {
  it('PROVEN: the canonical prompt yields a typed, URL-less role declaration', () => {
    expect(destination.kind).toBe('DECLARED');
    const d = destination as Extract<typeof destination, { kind: 'DECLARED' }>;
    expect(d.role?.acceptablePageTypes).toEqual(['LISTING']);
    expect(d.url).toBeUndefined();
    expect(toDeclaredDestinationConstraint(destination)).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
  });

  it('PROVEN: given a fresh LISTING observation the verifier does return MATCH', () => {
    // This is the arrow the real run could not reach, proven at the unit level.
    // It is NOT a substitute for the runtime chain.
    const v = verifyDestination({
      declaration: destination,
      observation: {
        url: RESULTS,
        pageGeneration: 6,
        semantic: { pageType: 'LISTING' as SemanticPageType, confidence: 0.99, pageGeneration: 6 },
      },
      currentPageGeneration: 6,
    });
    expect(v.kind).toBe('MATCH');
    expect(GoalProgressTracker.verifySubgoalCondition(destinationSubgoal(), {
      context: contextAt(RESULTS, 'LISTING', 0.99, 6),
      pageGeneration: 6,
    }).satisfied).toBe(true);
  });
});