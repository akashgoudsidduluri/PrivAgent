/**
 * STEP 10.5 Part 12 — the twelve negative controls for the G7 destination
 * chain, asserted against the real production path
 * (`destinationVerifier` -> `goalProgressTracker`), not against a mock.
 *
 * These exist so the closing conditions for G7 are pinned in one named place.
 * The positive case (a real LISTING observation satisfies a role-only
 * declaration) is deliberately NOT asserted as sufficient for anything here:
 * a MATCH is the verifier's verdict, and only the verifier's MATCH — never
 * anything in this file — can complete a destination subgoal.
 *
 * Label for every assertion below: PROVEN_UNIT_ONLY.
 */
import { describe, expect, it } from 'vitest';

import {
  verifyDestination,
  type DestinationObservation,
  type DestinationVerdict,
} from '../extension/src/planning/destinationVerifier';
import { MIN_PAGE_CLASSIFICATION_CONFIDENCE } from '../extension/src/semanticUnderstanding/pageClassifier';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import type { SubgoalObservation } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const ORIGIN = 'http://localhost:4174';

// The REAL role-only declaration the extension emits for "open the store
// catalog": a page role, and NO url channel at all.
const ROLE_ONLY = {
  kind: 'DECLARED' as const,
  role: {
    provenance: 'EXPLICIT_PAGE_ROLE' as const,
    acceptablePageTypes: ['LISTING'] as SemanticPageType[],
  },
};

const listing = (over: Partial<DestinationObservation> = {}): DestinationObservation => ({
  url: `${ORIGIN}/results.html?q=catalog`,
  pageGeneration: 8,
  semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 8 },
  ...over,
});

const kind = (v: DestinationVerdict) => v.kind;

/** The REAL role-only subgoal the extension builds for the canonical prompt. */
function destinationSubgoal(): Subgoal {
  return {
    id: 'sg1',
    goalId: 'g1',
    index: 0,
    description: 'Reach the destination declared in the user request',
    category: 'NAVIGATE',
    expectedActionType: 'navigate',
    state: 'PENDING',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
    verificationCondition: {
      type: 'DESTINATION_VERIFIED',
      description: 'Declared destination is observed',
    },
    // normalizeDestination is the SOLE producer; using it keeps the test on the
    // real path rather than hand-writing a declaration.
    destination: normalizeDestination('open the store catalog'),
  } as unknown as Subgoal;
}

/** A fresh, current observation of the given classification. */
function obsAt(pageType: SemanticPageType, confidence: number): SubgoalObservation {
  const url = pageType === 'LISTING'
    ? `${ORIGIN}/results.html?q=catalog`
    : pageType === 'SEARCH'
      ? `${ORIGIN}/search.html`
      : `${ORIGIN}/product.html?id=1`;
  return {
    context: {
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
        pageGeneration: 8,
        entities: [],
        affordances: [],
        promptInjectionDetected: false,
      },
    } as never,
    pageGeneration: 8,
  };
}

describe('STEP 10.5 Part 12 — negative controls', () => {
  it('A — wrong destination role is MISMATCH', () => {
    const v = verifyDestination({
      declaration: ROLE_ONLY,
      observation: listing({
        url: `${ORIGIN}/product.html?id=1`,
        semantic: { pageType: 'ARTICLE', confidence: 0.95, pageGeneration: 8 },
      }),
    });
    expect(kind(v)).toBe('MISMATCH');
  });

  it('B — an UNKNOWN page can neither confirm nor deny', () => {
    const v = verifyDestination({
      declaration: ROLE_ONLY,
      observation: listing({
        url: `${ORIGIN}/search.html`,
        semantic: { pageType: 'UNKNOWN', confidence: 0.1, pageGeneration: 8 },
      }),
    });
    expect(kind(v)).toBe('UNKNOWN');
  });

  it('C — a stale observation is UNKNOWN', () => {
    const v = verifyDestination({
      declaration: ROLE_ONLY,
      observation: listing({
        pageGeneration: 8,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 2 },
      }),
    });
    expect(kind(v)).toBe('UNKNOWN');
    expect(v.reason).toMatch(/different document/i);
  });

  it('D — a model claim of success cannot complete anything', () => {
    // Nothing in the verifier's input carries a model claim, so a claim can
    // only ever show up as an absent observation. Absent => UNKNOWN.
    const v = verifyDestination({ declaration: ROLE_ONLY, observation: undefined });
    expect(kind(v)).toBe('UNKNOWN');
    expect(kind(v)).not.toBe('MATCH');
  });

  it('E — action success on the wrong page does not satisfy the destination', () => {
    const v = verifyDestination({
      declaration: ROLE_ONLY,
      observation: listing({
        url: `${ORIGIN}/login.html`,
        semantic: { pageType: 'LOGIN', confidence: 0.98, pageGeneration: 8 },
      }),
    });
    expect(kind(v)).toBe('MISMATCH');
  });

  it('F — a sub-floor classification is not authoritative (action-no-effect class)', () => {
    const v = verifyDestination({
      declaration: ROLE_ONLY,
      observation: listing({
        semantic: {
          pageType: 'LISTING',
          confidence: MIN_PAGE_CLASSIFICATION_CONFIDENCE - 0.01,
          pageGeneration: 8,
        },
      }),
    });
    expect(kind(v)).toBe('UNKNOWN');
    expect(v.reason).toMatch(/floor/i);
  });

  it('G — already at the destination still requires the verifier', () => {
    const v = verifyDestination({ declaration: ROLE_ONLY, observation: listing() });
    expect(kind(v)).toBe('MATCH');
    expect(v.decisiveChannel).toBe('pageRole');
  });

  it('H — the declaration has no url channel for an action to inject into', () => {
    expect((ROLE_ONLY as Record<string, unknown>).url).toBeUndefined();
    const v = verifyDestination({ declaration: ROLE_ONLY, observation: listing() });
    expect(v.channels.url).toBeNull();
    expect(v.decisiveChannel).toBe('pageRole');
  });

  it('I — no observation can rewrite what was declared', () => {
    for (const pageType of ['LISTING', 'SEARCH', 'LOGIN', 'ARTICLE', 'UNKNOWN'] as SemanticPageType[]) {
      const v = verifyDestination({
        declaration: ROLE_ONLY,
        observation: listing({
          semantic: { pageType, confidence: 0.99, pageGeneration: 8 },
        }),
      });
      // The verifier reports on the DECLARED role; it never echoes a role
      // back into the declaration, and only pageRole can be decisive.
      expect(v.decisiveChannel).toBe('pageRole');
      expect(v.channels.url).toBeNull();
    }
  });

  it('J — an undeclared destination has nothing to verify', () => {
    for (const kindValue of ['NONE', 'AMBIGUOUS', 'UNSUPPORTED'] as const) {
      const v = verifyDestination({
        declaration: { kind: kindValue } as never,
        observation: listing(),
      });
      expect(kind(v)).toBe('UNKNOWN');
    }
  });

  it('K — the tracker completes a destination subgoal ONLY on a verifier MATCH', () => {
    // The tracker takes a `SubgoalObservation` (a sanitized AgentContextPayload
    // plus the page generation), NOT a raw DestinationObservation — it builds
    // the verifier's input itself. This test therefore drives the REAL
    // production builder rather than hand-writing the verifier input.
    const subgoal = destinationSubgoal();

    const mismatch = GoalProgressTracker.verifySubgoalCondition(
      subgoal, obsAt('ARTICLE', 0.99));
    expect(mismatch.satisfied).toBe(false);

    const unknown = GoalProgressTracker.verifySubgoalCondition(
      subgoal, obsAt('UNKNOWN', 0.1));
    expect(unknown.satisfied).toBe(false);

    // No declaration at all: fail closed, never satisfied.
    const undeclared = GoalProgressTracker.verifySubgoalCondition(
      { ...subgoal, destination: undefined } as never, obsAt('LISTING', 0.99));
    expect(undeclared.satisfied).toBe(false);

    // MATCH: satisfied — and only here.
    const match = GoalProgressTracker.verifySubgoalCondition(
      subgoal, obsAt('LISTING', 0.99));
    expect(match.satisfied).toBe(true);
    expect(match.reason).toMatch(/LISTING/);
  });

  it('L — the confidence floor is the shared, authoritative one', () => {
    expect(MIN_PAGE_CLASSIFICATION_CONFIDENCE).toBe(0.5);
    const below = verifyDestination({
      declaration: ROLE_ONLY,
      observation: listing({
        semantic: { pageType: 'LISTING', confidence: 0.49, pageGeneration: 8 },
      }),
    });
    const at = verifyDestination({
      declaration: ROLE_ONLY,
      observation: listing({
        semantic: { pageType: 'LISTING', confidence: 0.5, pageGeneration: 8 },
      }),
    });
    expect(kind(below)).toBe('UNKNOWN');
    expect(kind(at)).toBe('MATCH');
  });
});
