/**
 * STEP 10.5 — does the REAL production destinationVerifier accept the exact
 * observation the real run produced?
 *
 * Read-only. Feeds the verifier the real captured observation from
 * step10_5_g7_run2.json (results.html, LISTING, 0.99, generation 8) together
 * with the real user declaration (role=[LISTING], no URL) and prints the
 * verdict the production code returns, plus the negative controls.
 */
import { describe, expect, it } from 'vitest';

import {
  verifyDestination,
  type DestinationObservation,
  type DestinationVerdict,
} from '../extension/src/planning/destinationVerifier';
import { MIN_PAGE_CLASSIFICATION_CONFIDENCE } from '../extension/src/semanticUnderstanding/pageClassifier';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const ORIGIN = 'http://localhost:4174';

// The REAL declaration the extension produced for "open the store catalog":
// role-only, provenance USER_DECLARED_DESTINATION, and NO url channel.
const REAL_DECLARATION = {
  kind: 'DECLARED' as const,
  role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: ['LISTING'] as SemanticPageType[] },
};

const obs = (over: Partial<DestinationObservation> = {}): DestinationObservation => ({
  url: `${ORIGIN}/`,
  pageGeneration: 8,
  semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 8 },
  ...over,
});

const kind = (v: DestinationVerdict) => v.kind;

describe('STEP 10.5 — real captured observation vs real verifier', () => {
  it('the observation the real run ACTUALLY produced', () => {
    const v = verifyDestination({
      declaration: REAL_DECLARATION,
      observation: obs({
        url: `${ORIGIN}/results.html?q=all`,
        pageGeneration: 8,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 8 },
      }),
    });
    console.log('[probe] REAL results.html LISTING 0.99 gen8 ->', JSON.stringify(v));
    console.log('[probe] floor =', MIN_PAGE_CLASSIFICATION_CONFIDENCE);
    expect(kind(v)).toBe('MATCH');
  });

  it('control A — wrong role (PRODUCT)', () => {
    const v = verifyDestination({
      declaration: REAL_DECLARATION,
      observation: obs({ url: `${ORIGIN}/product.html?id=1`,
        semantic: { pageType: 'PRODUCT', confidence: 0.95, pageGeneration: 8 } }),
    });
    console.log('[probe] wrong role ->', JSON.stringify(v));
    expect(kind(v)).toBe('MISMATCH');
  });

  it('control B — UNKNOWN page (what the old runs produced)', () => {
    const v = verifyDestination({
      declaration: REAL_DECLARATION,
      observation: obs({ url: `${ORIGIN}/search.html`,
        semantic: { pageType: 'UNKNOWN', confidence: 0.1, pageGeneration: 8 } }),
    });
    console.log('[probe] UNKNOWN ->', JSON.stringify(v));
    expect(kind(v)).toBe('UNKNOWN');
  });

  it('control L — LISTING just below the floor', () => {
    const v = verifyDestination({
      declaration: REAL_DECLARATION,
      observation: obs({ url: `${ORIGIN}/results.html`,
        semantic: { pageType: 'LISTING', confidence: 0.49, pageGeneration: 8 } }),
    });
    console.log('[probe] sub-floor ->', JSON.stringify(v));
    expect(kind(v)).toBe('UNKNOWN');
  });

  it('control C — stale observation', () => {
    const v = verifyDestination({
      declaration: REAL_DECLARATION,
      observation: obs({ url: `${ORIGIN}/results.html`, pageGeneration: 8,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 2 } }),
    });
    console.log('[probe] stale ->', JSON.stringify(v));
  });

  it('control G — already at the destination', () => {
    const v = verifyDestination({
      declaration: REAL_DECLARATION,
      observation: obs({ url: `${ORIGIN}/results.html?q=all`,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 8 } }),
    });
    expect(kind(v)).toBe('MATCH');
  });
});
