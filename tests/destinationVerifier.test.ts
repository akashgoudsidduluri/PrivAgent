/**
 * PrivAgent — destination verifier contract tests.
 *
 * These pin the VERIFICATION channel: what an observed browser state is allowed
 * to conclude about a declared destination.
 *
 * The load-bearing property is that the three outcomes stay distinct. A boolean
 * would have to collapse "I looked and it is different" and "I could not look"
 * into one `false`; that collapse is the defect this contract exists to prevent,
 * so every case below asserts a specific outcome rather than a truthiness.
 *
 * See `scratch/mutation_destination_verifier.mjs`.
 */

import { describe, it, expect } from 'vitest';

import {
  verifyDestination,
  type DestinationObservation,
  type DestinationVerdict,
} from '../extension/src/planning/destinationVerifier';
import { MIN_PAGE_CLASSIFICATION_CONFIDENCE } from '../extension/src/semanticUnderstanding/pageClassifier';
import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const ORIGIN = 'http://localhost:4174';

const declaredRole = (types: SemanticPageType[], url?: string) => ({
  kind: 'DECLARED' as const,
  role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: types },
  ...(url
    ? { url: { provenance: 'USER_URL' as const, origin: 'http://localhost:4174', path: url, rawUrl: `${ORIGIN}${url}` } }
    : {}),
});

const obs = (over: Partial<DestinationObservation> = {}): DestinationObservation => ({
  url: `${ORIGIN}/`,
  pageGeneration: 7,
  semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 7 },
  ...over,
});

const verdict = (v: DestinationVerdict) => v.kind;

// ══════════════════════════════════════════════════════════════════════════════
// Page-role verification
// ══════════════════════════════════════════════════════════════════════════════

describe('page role', () => {
  it('DECLARED[LISTING] × LISTING 0.99 current → MATCH', () => {
    const v = verifyDestination({ declaration: declaredRole(['LISTING']), observation: obs() });
    expect(verdict(v)).toBe('MATCH');
    expect(v.decisiveChannel).toBe('pageRole');
    expect(v.reason).toContain('LISTING');
  });

  it('DECLARED[LISTING] × UNKNOWN 0.10 current → UNKNOWN, never MATCH', () => {
    const v = verifyDestination({
      declaration: declaredRole(['LISTING']),
      observation: obs({
        semantic: { pageType: 'UNKNOWN', confidence: 0.1, pageGeneration: 7 },
      }),
    });
    expect(verdict(v)).toBe('UNKNOWN');
    expect(v.reason).toMatch(/not classified/i);
  });

  it('DECLARED[LISTING] × LISTING below the classifier floor → UNKNOWN', () => {
    const v = verifyDestination({
      declaration: declaredRole(['LISTING']),
      observation: obs({
        semantic: { pageType: 'LISTING', confidence: MIN_PAGE_CLASSIFICATION_CONFIDENCE - 0.01, pageGeneration: 7 },
      }),
    });
    expect(verdict(v)).toBe('UNKNOWN');
    expect(v.reason).toMatch(/floor/i);
  });

  it('DECLARED[LISTING] × LISTING exactly AT the floor → MATCH', () => {
    const v = verifyDestination({
      declaration: declaredRole(['LISTING']),
      observation: obs({
        semantic: { pageType: 'LISTING', confidence: MIN_PAGE_CLASSIFICATION_CONFIDENCE, pageGeneration: 7 },
      }),
    });
    expect(verdict(v)).toBe('MATCH');
  });

  it('DECLARED[CHECKOUT] × LISTING 0.99 current → MISMATCH', () => {
    const v = verifyDestination({ declaration: declaredRole(['CHECKOUT']), observation: obs() });
    expect(verdict(v)).toBe('MISMATCH');
    expect(v.decisiveChannel).toBe('pageRole');
  });

  it('DECLARED[LISTING] × old-generation LISTING → UNKNOWN', () => {
    const v = verifyDestination({
      declaration: declaredRole(['LISTING']),
      observation: obs({
        pageGeneration: 6,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 6 },
      }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('UNKNOWN');
    expect(v.reason).toMatch(/generation/i);
  });

  it('DECLARED[LISTING] × missing observation → UNKNOWN, never MISMATCH', () => {
    for (const o of [null, undefined]) {
      const v = verifyDestination({ declaration: declaredRole(['LISTING']), observation: o });
      expect(verdict(v)).toBe('UNKNOWN');
    }
  });

  it('a classification stamped to a different document is refused', () => {
    const v = verifyDestination({
      declaration: declaredRole(['LISTING']),
      observation: obs({
        pageGeneration: 7,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 6 },
      }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('UNKNOWN');
    expect(v.reason).toMatch(/different document/i);
  });

  it('an observation with no semantic classification → UNKNOWN', () => {
    const v = verifyDestination({
      declaration: declaredRole(['LISTING']),
      observation: obs({ semantic: null }),
    });
    expect(verdict(v)).toBe('UNKNOWN');
  });

  it('a positively classified ERROR page is a MISMATCH, not an absence', () => {
    const v = verifyDestination({
      declaration: declaredRole(['LISTING']),
      observation: obs({ semantic: { pageType: 'ERROR', confidence: 0.9, pageGeneration: 7 } }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MISMATCH');
    expect(v.reason).toMatch(/error page/i);
  });

  it('an ERROR page cannot be declared as a destination either', () => {
    const v = verifyDestination({
      declaration: { kind: 'DECLARED', role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['ERROR' as SemanticPageType] } },
      observation: obs({ semantic: { pageType: 'ERROR', confidence: 0.9, pageGeneration: 7 } }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('UNKNOWN');
  });

  it('acceptablePageTypes = [UNKNOWN] can never be satisfied', () => {
    for (const observation of [obs(), obs({ semantic: { pageType: 'UNKNOWN', confidence: 0.99, pageGeneration: 7 } })]) {
      const v = verifyDestination({
        // Hand-built: the normalizer cannot produce this, and the verifier
        // must refuse it defensively rather than treat UNKNOWN as a target.
        declaration: { kind: 'DECLARED', role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['UNKNOWN' as SemanticPageType] } },
        observation,
      });
      expect(verdict(v)).toBe('UNKNOWN');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Non-DECLARED declarations never verify
// ══════════════════════════════════════════════════════════════════════════════

describe('only a DECLARED destination can verify', () => {
  it('NONE, AMBIGUOUS and UNSUPPORTED all yield UNKNOWN', () => {
    const cases = [
      { kind: 'NONE' as const },
      { kind: 'AMBIGUOUS' as const, candidates: [['LISTING'] as SemanticPageType[], ['SEARCH'] as SemanticPageType[]], provenance: 'EXPLICIT_PAGE_ROLE' as const },
      { kind: 'UNSUPPORTED' as const, unmappedHead: 'product', provenance: 'EXPLICIT_PAGE_ROLE' as const },
    ];
    for (const declaration of cases) {
      const v = verifyDestination({ declaration, observation: obs() });
      expect(verdict(v), declaration.kind).toBe('UNKNOWN');
      expect(v.decisiveChannel).toBeNull();
    }
  });

  it('an AMBIGUOUS declaration is never collapsed into a MATCH', () => {
    const v = verifyDestination({
      declaration: { kind: 'AMBIGUOUS', candidates: [['LISTING']], provenance: 'EXPLICIT_PAGE_ROLE' },
      observation: obs(),
    });
    expect(verdict(v)).toBe('UNKNOWN');
  });

  it('a non-DECLARED verdict is ATTRIBUTED to the declaration, not to missing evidence', () => {
    // Without this, the explicit "only DECLARED can verify" precondition is
    // indistinguishable from the generic "carries neither a page role nor a URL"
    // fallback, so a mutant that deletes the guard would survive.
    for (const [declaration, kind] of [
      [{ kind: 'NONE' as const }, 'NONE'],
      [{ kind: 'AMBIGUOUS' as const, candidates: [['LISTING'] as SemanticPageType[]], provenance: 'EXPLICIT_PAGE_ROLE' as const }, 'AMBIGUOUS'],
      [{ kind: 'UNSUPPORTED' as const, unmappedHead: 'product', provenance: 'EXPLICIT_PAGE_ROLE' as const }, 'UNSUPPORTED'],
    ] as const) {
      const v = verifyDestination({ declaration, observation: obs() });
      expect(verdict(v), kind).toBe('UNKNOWN');
      expect(v.reason, kind).toContain(kind);
      expect(v.reason, kind).toMatch(/nothing to verify/i);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// URL verification — exact normalized comparison only
// ══════════════════════════════════════════════════════════════════════════════

describe('URL destination', () => {
  const urlDeclared = (path: string) => ({
    kind: 'DECLARED' as const,
    url: { provenance: 'USER_URL' as const, origin: ORIGIN, path, rawUrl: `${ORIGIN}${path}` },
  });

  it('exact match → MATCH', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/catalog'),
      observation: obs({ url: `${ORIGIN}/catalog` }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MATCH');
  });

  it('trailing slash and host case normalise to the same destination', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/catalog'),
      observation: obs({ url: 'http://LOCALHOST:4174/catalog/' }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MATCH');
  });

  it('a query string cannot turn /search.html into /catalog', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/catalog'),
      observation: obs({ url: `${ORIGIN}/search.html?q=catalog` }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MISMATCH');
  });

  it('a fragment cannot turn one path into another', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/catalog'),
      observation: obs({ url: `${ORIGIN}/catalog#section` }),
      currentPageGeneration: 7,
    });
    // Same origin+pathname: the fragment is not identity, so this still matches.
    expect(verdict(v)).toBe('MATCH');
  });

  it('/catalog does not match /catalogue', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/catalog'),
      observation: obs({ url: `${ORIGIN}/catalogue` }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MISMATCH');
  });

  it('/catalog does not match /catalog/x', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/catalog'),
      observation: obs({ url: `${ORIGIN}/catalog/x` }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MISMATCH');
  });

  it('a different origin never matches, even with the same path', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/catalog'),
      observation: obs({ url: 'http://localhost:5173/catalog' }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MISMATCH');
  });

  it('a root path normalises to /', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/'),
      observation: obs({ url: `${ORIGIN}/` }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MATCH');
  });

  it('an unparseable observed URL is UNKNOWN, not MISMATCH', () => {
    for (const url of ['not a url', '', 'about:blank']) {
      const v = verifyDestination({
        declaration: urlDeclared('/catalog'),
        observation: obs({ url }),
        currentPageGeneration: 7,
      });
      expect(verdict(v), url).toBe('UNKNOWN');
    }
  });

  it('a stale observation cannot verify a URL destination', () => {
    const v = verifyDestination({
      declaration: urlDeclared('/catalog'),
      observation: obs({ url: `${ORIGIN}/catalog`, pageGeneration: 3 }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('UNKNOWN');
  });

  it('a missing observation is UNKNOWN, not MISMATCH', () => {
    const v = verifyDestination({ declaration: urlDeclared('/catalog'), observation: null });
    expect(verdict(v)).toBe('UNKNOWN');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// URL + page-role: two independent constraints
// ══════════════════════════════════════════════════════════════════════════════

describe('combined URL + page-role declarations', () => {
  const both = (types: SemanticPageType[], path: string) => declaredRole(types, path);

  it('URL MATCH + ROLE MATCH → MATCH', () => {
    const v = verifyDestination({
      declaration: both(['LISTING'], '/results.html'),
      observation: obs({ url: `${ORIGIN}/results.html` }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MATCH');
    expect(v.channels.pageRole?.kind).toBe('MATCH');
    expect(v.channels.url?.kind).toBe('MATCH');
  });

  it('URL MISMATCH + ROLE MATCH → MISMATCH', () => {
    const v = verifyDestination({
      declaration: both(['LISTING'], '/results.html'),
      observation: obs({ url: `${ORIGIN}/search.html` }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MISMATCH');
    expect(v.decisiveChannel).toBe('url');
    expect(v.channels.pageRole?.kind).toBe('MATCH');
  });

  it('URL MATCH + ROLE MISMATCH → MISMATCH', () => {
    const v = verifyDestination({
      declaration: both(['CHECKOUT'], '/results.html'),
      observation: obs({ url: `${ORIGIN}/results.html` }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('MISMATCH');
    expect(v.decisiveChannel).toBe('pageRole');
  });

  it('URL MATCH + ROLE UNKNOWN → UNKNOWN', () => {
    const v = verifyDestination({
      declaration: both(['LISTING'], '/results.html'),
      observation: obs({
        url: `${ORIGIN}/results.html`,
        semantic: { pageType: 'UNKNOWN', confidence: 0.1, pageGeneration: 7 },
      }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('UNKNOWN');
    expect(v.channels.url?.kind).toBe('MATCH');
    expect(v.channels.pageRole?.kind).toBe('UNKNOWN');
  });

  it('URL UNKNOWN + ROLE MATCH → UNKNOWN', () => {
    const v = verifyDestination({
      declaration: both(['LISTING'], '/results.html'),
      observation: obs({ url: 'not a url' }),
      currentPageGeneration: 7,
    });
    expect(verdict(v)).toBe('UNKNOWN');
    expect(v.channels.pageRole?.kind).toBe('MATCH');
    expect(v.channels.url?.kind).toBe('UNKNOWN');
  });

  it('neither constraint may silently suppress the other', () => {
    const v = verifyDestination({
      declaration: both(['LISTING'], '/results.html'),
      observation: obs({ url: `${ORIGIN}/results.html` }),
      currentPageGeneration: 7,
    });
    expect(v.channels.pageRole).not.toBeNull();
    expect(v.channels.url).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Forbidden evidence cannot change the outcome
// ══════════════════════════════════════════════════════════════════════════════

describe('forbidden evidence is inert', () => {
  const base = {
    declaration: declaredRole(['LISTING']),
    observation: obs(),
    currentPageGeneration: 7,
  } as const;
  const baseline = verdict(verifyDestination(base));

  const FORBIDDEN: Array<[string, Record<string, unknown>]> = [
    ['action.url claiming the catalog', { action: { action: 'click', url: `${ORIGIN}/catalog` } }],
    ['action.url claiming a different page', { action: { action: 'click', url: 'https://example.com/' } }],
    ['executionSuccess', { executionSuccess: true }],
    ['previousActions', { previousActions: [{ action: 'navigate', url: `${ORIGIN}/catalog` }] }],
    ['navigationDestination', { navigationDestination: `${ORIGIN}/catalog` }],
    ['planned destination', { destination: { kind: 'DECLARED', role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['LISTING'] } } }],
    ['model claim of success', { modelSays: 'I reached the catalog' }],
    ['page text claiming the catalog', { text: 'You are on the catalog page', pageText: 'catalog' }],
    ['entity labels', { entities: [{ id: 'e1', type: 'Product', label: 'catalog' }] }],
    ['affordance descriptions', { affordances: [{ id: 'a1', type: 'SCROLL', description: 'catalog' }] }],
  ];

  for (const [label, extra] of FORBIDDEN) {
    it(`${label} does not change the verdict`, () => {
      const polluted = { ...base, ...extra } as typeof base;
      expect(verdict(verifyDestination(polluted))).toBe(baseline);
    });
  }

  it('the input type has no field capable of carrying dispatch state', () => {
    // Structural guarantee: the observation is a narrow, purpose-built type, so
    // there is no `previous_actions` / `detections` / `model` channel to read.
    const source = verifyDestination.toString();
    expect(source).not.toMatch(/previous_actions|executionSuccess|navigationDestination/);
  });

  it('verdicts never leak page text into the reason', () => {
    const v = verifyDestination({
      declaration: declaredRole(['LISTING']),
      observation: { ...obs(), secretNote: 'PAN 4111111111111111' } as never,
      currentPageGeneration: 7,
    });
    expect(v.reason).not.toMatch(/4111/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// End-to-end with the real normalizer
// ══════════════════════════════════════════════════════════════════════════════

describe('normalizer output feeds the verifier unchanged', () => {
  it('"open the store catalog at http://localhost:4174/results.html" verifies against the catalog page', () => {
    const declaration = normalizeDestination(
      'open the store catalog at http://localhost:4174/results.html'
    );
    expect(declaration.kind).toBe('DECLARED');

    const onCatalog = verifyDestination({
      declaration,
      observation: obs({ url: `${ORIGIN}/results.html` }),
      currentPageGeneration: 7,
    });
    expect(verdict(onCatalog)).toBe('MATCH');

    // The negative control: the wrong page, with search affordances present.
    const onSearch = verifyDestination({
      declaration,
      observation: obs({
        url: `${ORIGIN}/search.html`,
        semantic: { pageType: 'UNKNOWN', confidence: 0.1, pageGeneration: 7 },
      }),
      currentPageGeneration: 7,
    });
    expect(verdict(onSearch)).not.toBe('MATCH');
  });

  it('the same declaration is UNSUPPORTED-verified for a product destination', () => {
    const declaration = normalizeDestination('open the first product');
    expect(declaration.kind).toBe('UNSUPPORTED');
    expect(verdict(verifyDestination({ declaration, observation: obs(), currentPageGeneration: 7 }))).toBe('UNKNOWN');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Determinism and authority
// ══════════════════════════════════════════════════════════════════════════════

describe('determinism and authority', () => {
  it('100 identical runs produce identical verdicts', () => {
    const input = {
      declaration: declaredRole(['LISTING'], '/results.html'),
      observation: obs({ url: `${ORIGIN}/results.html` }),
      currentPageGeneration: 7,
    } as const;
    const first = JSON.stringify(verifyDestination(input));
    for (let i = 0; i < 100; i += 1) {
      expect(JSON.stringify(verifyDestination(input))).toBe(first);
    }
  });

  it('the verifier imports no authorization or goal-verification authority', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'extension/src/planning/destinationVerifier.ts'),
      'utf8'
    );
    for (const forbidden of [
      'goalVerifier',
      'actionValidator',
      'securityCritic',
      'riskEngine',
      'containment',
      'effectVerification',
      'recoveryEngine',
      'agentLoop',
      'Date.now',
      'Math.random',
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('the verdict kind is a closed three-value union', () => {
    for (const d of [obs(), obs({ semantic: null })]) {
      const kind = verifyDestination({ declaration: declaredRole(['LISTING']), observation: d }).kind;
      expect(['MATCH', 'MISMATCH', 'UNKNOWN']).toContain(kind);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. ENTRY URL IS NOT A DESTINATION CONSTRAINT (POST-17.10 Step 6)
// ══════════════════════════════════════════════════════════════════════════════

describe('Step 6 — entry URL separation', () => {
  const LISTING_099 = obs({
    url: `${ORIGIN}/results.html`,
    pageGeneration: 5,
    semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 5 },
  });

  /** The Step 5 task, normalized by the REAL normalizer. */
  const realDeclaration = () => normalizeDestination(`open the store catalog at ${ORIGIN}`);

  // ── Case F / acceptance criterion ─────────────────────────────────────────
  it('F: entryUrl + LISTING role verifies against the real LISTING page -> MATCH', () => {
    const d = realDeclaration();
    expect(d.kind).toBe('DECLARED');
    expect(d.kind === 'DECLARED' && d.role?.acceptablePageTypes).toEqual(['LISTING']);
    expect(d.kind === 'DECLARED' && d.entryUrl?.origin).toBe(ORIGIN);
    // The entry URL opens no channel at all.
    expect(d.kind === 'DECLARED' && d.url).toBeUndefined();

    const v = verifyDestination({ declaration: d, observation: LISTING_099, currentPageGeneration: 5 });
    expect(v.kind).toBe('MATCH');
    expect(v.decisiveChannel).toBe('pageRole');
    // Only the role channel was ever consulted.
    expect(v.channels.url).toBeNull();
  });

  it('the entry URL is never compared, even when the page moved away from it', () => {
    // This is the whole point. Under the pre-Step-6 contract this exact
    // situation MISMATCHed, because `/` was treated as the destination URL and
    // compared against an observed `/results.html`.
    const d = realDeclaration();
    const away = obs({
      url: `${ORIGIN}/cart`,
      pageGeneration: 9,
      semantic: { pageType: 'LISTING', confidence: 0.9, pageGeneration: 9 },
    });
    const v = verifyDestination({ declaration: d, observation: away, currentPageGeneration: 9 });
    expect(v.kind).toBe('MATCH');
    expect(v.channels.url).toBeNull();
  });

  it('an entry URL alone declares nothing verifiable -> UNKNOWN', () => {
    const only = {
      kind: 'DECLARED' as const,
      entryUrl: { provenance: 'USER_ENTRY_SITE' as const, origin: ORIGIN, path: '/', rawUrl: ORIGIN },
    };
    const v = verifyDestination({ declaration: only, observation: LISTING_099, currentPageGeneration: 5 });
    expect(v.kind).toBe('UNKNOWN');
    expect(v.decisiveChannel).toBeNull();
    expect(v.reason).toMatch(/entry URL/i);
  });

  // ── Case E: the declaration is immutable under observation ────────────────
  it('E: observation cannot rewrite the declaration', () => {
    const d = normalizeDestination(`open the store catalog at ${ORIGIN}`);
    const before = JSON.parse(JSON.stringify(d));

    verifyDestination({ declaration: d, observation: LISTING_099, currentPageGeneration: 5 });
    verifyDestination({ declaration: d, observation: obs({ url: `${ORIGIN}/search.html` }), currentPageGeneration: 7 });
    verifyDestination({ declaration: d, observation: LISTING_099, currentPageGeneration: 99 });

    expect(JSON.parse(JSON.stringify(d))).toEqual(before);
    // Specifically: the observation of /results.html never became the
    // destination URL. That would be evidence laundering.
    expect(d.kind === 'DECLARED' && d.url).toBeUndefined();
    expect(d.kind === 'DECLARED' && d.entryUrl?.path).toBe('/');
  });

  // ── Case B / C / G: exact destination URLs stay strict ────────────────────
  it('B: a bare user URL is a destination URL and is compared exactly', () => {
    const d = normalizeDestination(`open ${ORIGIN}/results.html`);
    expect(d.kind === 'DECLARED' && d.url?.path).toBe('/results.html');
    const v = verifyDestination({ declaration: d, observation: LISTING_099, currentPageGeneration: 5 });
    expect(v.kind).toBe('MATCH');
    expect(v.channels.url?.kind).toBe('MATCH');
  });

  it('C: a different observed path is NOT a match', () => {
    const d = normalizeDestination(`open ${ORIGIN}/results.html`);
    const other = obs({
      url: `${ORIGIN}/search.html?q=x`,
      pageGeneration: 11,
      semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 11 },
    });
    const v = verifyDestination({ declaration: d, observation: other, currentPageGeneration: 11 });
    expect(v.kind).toBe('MISMATCH');
    expect(v.decisiveChannel).toBe('url');
  });

  it('G: the same declaration against a same-site, wrong path still MISMATCHes', () => {
    // The URL channel must not become slack just because the origin matches.
    const d = normalizeDestination(`open ${ORIGIN}/results.html`);
    const wrong = obs({
      url: `${ORIGIN}/search.html`,
      pageGeneration: 5,
      semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 5 },
    });
    const v = verifyDestination({ declaration: d, observation: wrong, currentPageGeneration: 5 });
    expect(v.kind).toBe('MISMATCH');
    expect(v.decisiveChannel).toBe('url');
  });

  it('a query string can never rescue or break the exact URL comparison', () => {
    const d = normalizeDestination(`open ${ORIGIN}/results.html?q=whatever`);
    const exact = obs({
      url: `${ORIGIN}/results.html`,
      pageGeneration: 5,
      semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 5 },
    });
    expect(verifyDestination({ declaration: d, observation: exact, currentPageGeneration: 5 }).kind).toBe('MATCH');
  });

  it('the root path and a real path are NOT interchangeable', () => {
    // The Step 5 failure mode, pinned as a permanent regression guard: nothing
    // may ever make `/` match `/results.html` under the destination URL channel.
    const rootAsDestination = {
      kind: 'DECLARED' as const,
      url: { provenance: 'USER_URL' as const, origin: ORIGIN, path: '/', rawUrl: ORIGIN },
    };
    const v = verifyDestination({
      declaration: rootAsDestination,
      observation: LISTING_099,
      currentPageGeneration: 5,
    });
    expect(v.kind).toBe('MISMATCH');
    expect(v.channels.url?.kind).toBe('MISMATCH');
  });

  // ── Case H ────────────────────────────────────────────────────────────────
  it('H: a low-confidence role claim stays UNKNOWN, not MATCH', () => {
    const d = realDeclaration();
    const unclassified = obs({
      url: `${ORIGIN}/`,
      pageGeneration: 5,
      semantic: { pageType: 'UNKNOWN', confidence: 0.1, pageGeneration: 5 },
    });
    expect(verifyDestination({ declaration: d, observation: unclassified, currentPageGeneration: 5 }).kind).toBe('UNKNOWN');
  });

  it('H2: a sub-floor classified role is not authoritative', () => {
    const d = realDeclaration();
    const belowFloor = obs({
      url: `${ORIGIN}/results.html`,
      pageGeneration: 5,
      semantic: {
        pageType: 'LISTING',
        confidence: MIN_PAGE_CLASSIFICATION_CONFIDENCE - 0.01,
        pageGeneration: 5,
      },
    });
    expect(verifyDestination({ declaration: d, observation: belowFloor, currentPageGeneration: 5 }).kind).toBe('UNKNOWN');
  });

  // ── Case I: the Step 4 staleness invariant survives the new field ─────────
  it('I: a stale observation still cannot verify a destination', () => {
    const d = realDeclaration();
    const stale = obs({
      url: `${ORIGIN}/results.html`,
      pageGeneration: 5,
      semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 5 },
    });
    const v = verifyDestination({ declaration: d, observation: stale, currentPageGeneration: 7 });
    expect(v.kind).toBe('UNKNOWN');
    expect(v.reason).toMatch(/generation/i);
    // And the declaration is still untouched by the refusal.
    expect(d.kind === 'DECLARED' && d.url).toBeUndefined();
  });

  it('entryUrl is never a channel under any declaration shape', () => {
    const shapes = [
      { kind: 'DECLARED' as const, entryUrl: { provenance: 'USER_ENTRY_SITE' as const, origin: ORIGIN, path: '/', rawUrl: ORIGIN } },
      { kind: 'DECLARED' as const, role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: ['LISTING'] as SemanticPageType[] }, entryUrl: { provenance: 'USER_ENTRY_SITE' as const, origin: ORIGIN, path: '/', rawUrl: ORIGIN } },
      { kind: 'DECLARED' as const, role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: ['CHECKOUT'] as SemanticPageType[] }, url: { provenance: 'USER_URL' as const, origin: ORIGIN, path: '/', rawUrl: ORIGIN }, entryUrl: { provenance: 'USER_ENTRY_SITE' as const, origin: ORIGIN, path: '/checkout', rawUrl: `${ORIGIN}/checkout` } },
    ];
    for (const d of shapes) {
      for (const o of [LISTING_099, obs({ url: 'https://elsewhere.example/' }), obs({ semantic: null }), null, undefined]) {
        const v = verifyDestination({ declaration: d, observation: o });
        expect(['MATCH', 'MISMATCH', 'UNKNOWN']).toContain(v.kind);
        // Whatever happens, only the two destination channels may appear.
        expect(['pageRole', 'url', null]).toContain(v.decisiveChannel);
      }
    }
  });

  it('an entryUrl pointing somewhere unrelated does not drag the verdict', () => {
    const d = {
      kind: 'DECLARED' as const,
      role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: ['LISTING'] as SemanticPageType[] },
      entryUrl: { provenance: 'USER_ENTRY_SITE' as const, origin: 'https://unrelated.example', path: '/', rawUrl: 'https://unrelated.example' },
    };
    const v = verifyDestination({ declaration: d, observation: LISTING_099, currentPageGeneration: 5 });
    expect(v.kind).toBe('MATCH');
    expect(v.channels.url).toBeNull();
  });
});
