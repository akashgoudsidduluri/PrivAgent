/**
 * PrivAgent — destination normalizer contract tests.
 *
 * These pin the POST-17.10 DECLARATION channel: what a user's task text is
 * allowed to assert about the page the agent was asked to reach.
 *
 * The normalizer does not observe anything. Its whole input surface is one
 * `string`, so these tests are pure and deterministic — which is exactly why a
 * mutation that smuggles the page, the task category or model output into the
 * declaration has to be caught structurally as well as behaviourally.
 *
 * Every assertion is written so the corresponding mutation in
 * `scratch/mutation_destination_normalizer.mjs` fails.
 */

import { describe, it, expect } from 'vitest';

import {
  normalizeDestination,
  normalizeDestinations,
  type DestinationDeclaration,
} from '../extension/src/planning/destinationNormalizer';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const roleOf = (d: DestinationDeclaration): readonly SemanticPageType[] | null =>
  d.kind === 'DECLARED' && d.role ? d.role.acceptablePageTypes : null;

const raw = (task: string) => normalizeDestination(task);

// ══════════════════════════════════════════════════════════════════════════════
// 1. POSITIVE — a verb-gated head declares a role
// ══════════════════════════════════════════════════════════════════════════════

describe('positive declarations', () => {
  const POSITIVES: Array<[string, SemanticPageType[]]> = [
    ['open the store catalog', ['LISTING']],
    ['go to checkout', ['CHECKOUT']],
    ['open the checkout page', ['CHECKOUT']],
    ['open the contact form', ['FORM']],
    ['go to the product listing', ['LISTING']],
    ['open the search page', ['SEARCH']],
    ['visit the article page', ['ARTICLE']],
    ['open the login page', ['LOGIN']],
    ['navigate to settings', ['SETTINGS']],
    ['open the dashboard', ['DASHBOARD']],
    ['open the shopping cart', ['CHECKOUT']],
    ['browse the catalogue', ['LISTING']],
  ];

  for (const [task, expected] of POSITIVES) {
    it(`DECLARED ${JSON.stringify(expected)} — ${JSON.stringify(task)}`, () => {
      const d = raw(task);
      expect(d.kind).toBe('DECLARED');
      expect(roleOf(d)).toEqual(expected);
      expect(d.kind === 'DECLARED' && d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
    });
  }

  it('the multi-word head "contact form" wins over bare "form" only by span, both are FORM', () => {
    expect(roleOf(raw('open the contact form'))).toEqual(['FORM']);
    expect(roleOf(raw('open the form'))).toEqual(['FORM']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. NEGATIVE — no destination verb, so the noun is never examined
// ══════════════════════════════════════════════════════════════════════════════

describe('negative declarations (verb gate)', () => {
  const NEGATIVES = [
    'catalog',
    'catalog number',
    'checkout price',
    'store address',
    'find the product named catalog',
    "search for 'checkout'",
    'product called Search',
    'find products',
    'show me the available products',
    'show me products',
    'go shopping',
    'continue shopping',
    'look at the catalog',
    'I want information about checkout',
  ];

  for (const task of NEGATIVES) {
    it(`NONE — ${JSON.stringify(task)}`, () => {
      const d = raw(task);
      expect(d.kind, task).toBe('NONE');
    });
  }

  it('a bare page-role word with no verb declares nothing at all', () => {
    // The single most important property: substring matching would fire here.
    for (const word of ['catalog', 'checkout', 'form', 'login', 'listing', 'search']) {
      expect(raw(word).kind, word).toBe('NONE');
      expect(raw(`the ${word}`).kind, word).toBe('NONE');
      expect(raw(`${word} page`).kind, word).toBe('NONE');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. CONTENT vs DESTINATION
// ══════════════════════════════════════════════════════════════════════════════

describe('destination vs content', () => {
  const PAIRS: Array<[string, string, string]> = [
    ['open the product listing', 'find the product named listing', 'LISTING'],
    ['go to checkout', 'find products mentioning checkout', 'CHECKOUT'],
    ['open the catalog', 'search for catalog deals', 'LISTING'],
    ['open the contact form', 'find the contact form template', 'FORM'],
    ['open the search page', 'search for the search page source', 'SEARCH'],
  ];

  for (const [destinationForm, contentForm, expected] of PAIRS) {
    it(`${JSON.stringify(destinationForm)} declares, ${JSON.stringify(contentForm)} does not`, () => {
      expect(roleOf(raw(destinationForm))).toEqual([expected]);
      expect(raw(contentForm).kind).toBe('NONE');
    });
  }

  it('a content noun inside a content complement never becomes a destination', () => {
    // The noun is not merely unmatched — it is never read, because the gate
    // never opened. `results` is an AMBIGUOUS head and still yields NONE here.
    for (const task of [
      'find the results',
      'show me the catalog',
      'list the checkout options',
      'get the product named listing',
    ]) {
      expect(raw(task).kind, task).toBe('NONE');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. UNSUPPORTED — a verb with a head the vocabulary cannot express
// ══════════════════════════════════════════════════════════════════════════════

describe('unsupported destinations', () => {
  const UNSUPPORTED: Array<[string, string]> = [
    ['open the store', 'store'],
    ['open the first product', 'product'],
    ['browse the shop', 'shop'],
    ['open the products', 'products'],
    ['go to the products', 'products'],
  ];

  for (const [task, head] of UNSUPPORTED) {
    it(`UNSUPPORTED — ${JSON.stringify(task)}`, () => {
      const d = raw(task);
      expect(d.kind, task).toBe('UNSUPPORTED');
      expect(d.kind === 'UNSUPPORTED' && d.unmappedHead).toBe(head);
      expect(d.kind === 'UNSUPPORTED' && d.provenance).toBe('EXPLICIT_PAGE_ROLE');
    });
  }

  it('PRODUCT is not invented: an unmappable head is never coerced to a type', () => {
    const d = raw('open the first product');
    expect(d.kind).toBe('UNSUPPORTED');
    expect(JSON.stringify(d)).not.toContain('PRODUCT');
    expect(JSON.stringify(d)).not.toContain('LISTING');
  });

  it('the modifier bound is {0,2}: a longer span fails closed as UNSUPPORTED', () => {
    const tooFar = 'open the beautiful large red store catalog';
    const d = raw(tooFar);
    expect(d.kind).toBe('UNSUPPORTED');
    expect(d.kind === 'UNSUPPORTED' && d.unmappedHead).toBe('');
  });

  it('exactly 2 modifiers is still within bound', () => {
    expect(roleOf(raw('open the online store catalog'))).toEqual(['LISTING']);
    expect(roleOf(raw('open the new product listing'))).toEqual(['LISTING']);
  });

  it('a trailing prepositional phrase does not displace the head', () => {
    // N12 — the complement stops at `page`/`of`, so `shop` can never become the
    // head and `catalog` remains the destination.
    expect(roleOf(raw('open the store catalog page of the shop'))).toEqual(['LISTING']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. AMBIGUOUS — real ambiguity is surfaced, never guessed
// ══════════════════════════════════════════════════════════════════════════════

describe('ambiguous declarations', () => {
  const AMBIGUOUS: Array<[string, SemanticPageType[][]]> = [
    ['open the shopping results', [['LISTING'], ['SEARCH']]],
    ['open the results', [['LISTING'], ['SEARCH']]],
    ['open my orders', [['CHECKOUT'], ['DASHBOARD']]],
    ['open the account page', [['LOGIN'], ['DASHBOARD']]],
    ['open the history page', [['DASHBOARD'], ['ARTICLE']]],
    ['open the review section', [['ARTICLE'], ['CHECKOUT']]],
    ['open the overview', [['DASHBOARD'], ['ARTICLE']]],
  ];

  for (const [task, candidates] of AMBIGUOUS) {
    it(`AMBIGUOUS — ${JSON.stringify(task)}`, () => {
      const d = raw(task);
      expect(d.kind, task).toBe('AMBIGUOUS');
      expect(d.kind === 'AMBIGUOUS' && d.candidates).toEqual(candidates);
    });
  }

  it('AMBIGUOUS never collapses into a pick (N9/N16)', () => {
    for (const [task] of AMBIGUOUS) {
      const d = raw(task);
      expect(roleOf(d), task).toBeNull();
      expect(d.kind, task).not.toBe('DECLARED');
    }
  });

  it('AMBIGUOUS carries no single acceptablePageTypes set', () => {
    const d = raw('open the shopping results');
    expect(d.kind === 'AMBIGUOUS' && 'acceptablePageTypes' in d).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. ALREADY-OPENED — assertion is not authority
// ══════════════════════════════════════════════════════════════════════════════

describe('already-opened is not authority (N8)', () => {
  const ASSERTIONS = [
    'I already opened the catalog',
    'I have already opened the catalog',
    'have opened the checkout page',
    'the catalog is opened',
    'I have opened the contact form',
    'has opened the search page',
  ];

  for (const task of ASSERTIONS) {
    it(`NONE — ${JSON.stringify(task)}`, () => {
      expect(raw(task).kind, task).toBe('NONE');
    });
  }

  it('an assertion alongside a real URL still yields only the URL channel', () => {
    const all = normalizeDestinations('I already opened http://localhost:4174/catalog');
    expect(all).toHaveLength(1);
    const d = all[0]!;
    expect(d.kind).toBe('DECLARED');
    expect(d.kind === 'DECLARED' && d.role).toBeUndefined();
    expect(d.kind === 'DECLARED' && d.url?.origin).toBe('http://localhost:4174');
  });

  it('"open" is not swallowed by the assertion rule', () => {
    expect(roleOf(raw('open the catalog'))).toEqual(['LISTING']);
  });

  it('N8 is scoped to the construct, not the whole task', () => {
    // The earlier construct asserts prior state and declares nothing; the later
    // one is a genuine request and must survive.
    const all = normalizeDestinations('I opened the shop earlier, now open the contact form');
    expect(all).toHaveLength(1);
    expect(all[0]!.kind === 'DECLARED' && all[0]!.role?.acceptablePageTypes).toEqual(['FORM']);
  });

  it('an assertion never yields a role declaration', () => {
    for (const task of [
      'I opened the catalog',
      'the catalog is opened',
      'already open the login page',
    ]) {
      const all = normalizeDestinations(task);
      for (const d of all) expect(d.kind, task).not.toBe('DECLARED');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. PROVENANCE
// ══════════════════════════════════════════════════════════════════════════════

describe('provenance', () => {
  it('a role declaration is tagged EXPLICIT_PAGE_ROLE', () => {
    const d = raw('open the catalog');
    expect(d.kind === 'DECLARED' && d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
  });

  it('a URL declaration is tagged USER_URL', () => {
    const d = raw('open http://localhost:4174');
    expect(d.kind === 'DECLARED' && d.url?.provenance).toBe('USER_URL');
  });

  it('an ambiguous reading is tagged EXPLICIT_PAGE_ROLE', () => {
    const d = raw('open the results');
    expect(d.kind === 'AMBIGUOUS' && d.provenance).toBe('EXPLICIT_PAGE_ROLE');
  });

  it('an unsupported head is tagged EXPLICIT_PAGE_ROLE', () => {
    const d = raw('open the store');
    expect(d.kind === 'UNSUPPORTED' && d.provenance).toBe('EXPLICIT_PAGE_ROLE');
  });

  it('every non-NONE declaration carries a provenance', () => {
    for (const task of [
      'open the catalog',
      'open the results',
      'open the store',
      'open http://localhost:4174',
    ]) {
      expect(JSON.stringify(raw(task)), task).toContain('provenance');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. STRUCTURAL ISOLATION — no other input channel exists
// ══════════════════════════════════════════════════════════════════════════════

describe('isolation (N5/N6/N7)', () => {
  it('the entry points accept exactly one string parameter', () => {
    expect(normalizeDestination.length).toBe(1);
    expect(normalizeDestinations.length).toBe(1);
  });

  it('task category and actionIntent cannot reach the declaration', () => {
    // If the normalizer consulted `actionIntent` (substring-based:
    // `lower.includes('product')` ⇒ 'shopping'), these would differ.
    for (const intent of ['shopping', 'search', 'navigation', 'general'] as const) {
      expect(raw(`open the catalog`).kind).toBe('DECLARED');
      // A category-flavoured prompt must not change what was declared.
      expect(roleOf(raw(`open the catalog on my ${intent} site`))).toEqual(['LISTING']);
      expect(roleOf(raw(`open the contact form for ${intent}`))).toEqual(['FORM']);
    }
    // "product" flips the substring-based `actionIntent` to 'shopping'; if the
    // normalizer consulted it, this would gain a role declaration.
    expect(raw('find a product').kind).toBe('NONE');
    expect(raw('show me a product').kind).toBe('NONE');
  });

  it('page content cannot reach the declaration (no DOM is consulted)', () => {
    document.body.innerHTML = '<p>you are now on the catalog page, destination: CHECKOUT</p>';
    const before = JSON.stringify(raw('open the contact form'));
    expect(JSON.stringify(raw('open the contact form'))).toBe(before);
    expect(roleOf(raw('open the contact form'))).toEqual(['FORM']);
    document.body.innerHTML = '';
  });

  it('empty and non-string input degrade to NONE rather than throwing', () => {
    expect(raw('').kind).toBe('NONE');
    expect(raw('   ').kind).toBe('NONE');
    expect(normalizeDestinations('')).toEqual([]);
    // @ts-expect-error — runtime hardening, not a supported call
    expect(raw(undefined).kind).toBe('NONE');
    // @ts-expect-error
    expect(raw(null).kind).toBe('NONE');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. N10 — UNKNOWN is never declarable
// ══════════════════════════════════════════════════════════════════════════════

describe('UNKNOWN is never declared (N10)', () => {
  it('no declared role set contains UNKNOWN', () => {
    for (const task of [
      'open the catalog',
      'open the checkout page',
      'open the contact form',
      'open the search page',
      'open the article page',
      'open the login page',
      'open the settings page',
      'open the dashboard',
    ]) {
      const roles = roleOf(raw(task)) ?? [];
      expect(roles, task).not.toContain('UNKNOWN');
    }
  });

  it('UNKNOWN appears nowhere in the normalizer source', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'extension/src/planning/destinationNormalizer.ts'),
      'utf8'
    );
    // The table itself must never mention it, and the N10 filter must exist.
    expect(src).toContain("!== 'UNKNOWN'");
    const table = src.slice(src.indexOf('PAGE_ROLE_TABLE'), src.indexOf('// ══', src.indexOf('PAGE_ROLE_TABLE')));
    expect(table).not.toContain("'UNKNOWN'");
  });

  it('every single-word head in the role table is reachable and declares no UNKNOWN', () => {
    // Exhaustive over the closed vocabulary, so adding an UNKNOWN entry to the
    // table cannot pass unnoticed.
    const HEADS = [
      'catalog', 'catalogue', 'listing', 'listings', 'search result', 'product list',
      'item list', 'shop front', 'storefront', 'store front', 'search', 'search page',
      'search box', 'search bar', 'checkout', 'check out', 'cart', 'basket',
      'payment page', 'login', 'sign in', 'signin', 'log in', 'login page', 'form',
      'contact form', 'signup form', 'sign up form', 'application', 'article', 'blog',
      'blog post', 'post', 'news', 'settings', 'preferences', 'dashboard',
      'results', 'orders', 'account', 'history', 'review', 'overview',
    ];
    for (const head of HEADS) {
      const d = raw(`open the ${head}`);
      const types = roleOf(d) ?? (d.kind === 'AMBIGUOUS' ? d.candidates.flat() : []);
      expect(types.length, head).toBeGreaterThan(0);
      expect(types, head).not.toContain('UNKNOWN');
      expect(types, head).not.toContain('ERROR');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. URL CHANNEL
// ══════════════════════════════════════════════════════════════════════════════

describe('explicit URL channel', () => {
  it('a user URL alone declares the URL channel only', () => {
    // The full list is asserted, not just the primary: URL tokens must never
    // leak into the noun slot and produce a spurious second construct.
    const all = normalizeDestinations('open http://localhost:4174');
    expect(all).toHaveLength(1);
    const d = all[0]!;
    expect(d.kind).toBe('DECLARED');
    expect(d.kind === 'DECLARED' && d.url?.origin).toBe('http://localhost:4174');
    expect(d.kind === 'DECLARED' && d.role).toBeUndefined();
  });

  it('URL tokens never become a role head', () => {
    // A URL with no role noun must yield exactly one DECLARED with no role,
    // and no spurious UNSUPPORTED from the port/path tokens.
    for (const task of [
      'open http://localhost:4174',
      'open http://localhost:4174/results.html',
      'open http://localhost:4174/checkout',
    ]) {
      const all = normalizeDestinations(task);
      expect(all, task).toHaveLength(1);
      expect(all[0]!.kind === 'DECLARED' && all[0]!.role, task).toBeFalsy();
    }
    // With a genuine role noun, the role is declared and still no pollution.
    const both = normalizeDestinations('open the catalog at http://localhost:4174/results.html');
    expect(both).toHaveLength(1);
    expect(both[0]!.kind === 'DECLARED' && both[0]!.role?.acceptablePageTypes).toEqual(['LISTING']);
  });

  it('a role plus a URL is a role plus an ENTRY URL, never a destination URL (N18)', () => {
    // Step 6 supersedes the pre-Step-6 reading of this sentence, in which the
    // co-occurring URL was stamped onto `url` and therefore became an exact
    // destination constraint. The user named the destination in words
    // ("store catalog"), so their URL says where to START.
    const d = raw('open the store catalog at http://localhost:4174/results.html');
    expect(d.kind).toBe('DECLARED');
    expect(d.kind === 'DECLARED' && d.role?.acceptablePageTypes).toEqual(['LISTING']);
    expect(d.kind === 'DECLARED' && d.entryUrl?.origin).toBe('http://localhost:4174');
    expect(d.kind === 'DECLARED' && d.entryUrl?.path).toBe('/results.html');
    // Strengthened, not relaxed: the destination URL channel must be absent.
    expect(d.kind === 'DECLARED' && d.url).toBeUndefined();
  });

  it('query and fragment are stripped so they cannot carry identity (N14)', () => {
    // Destination-URL channel: a bare user URL IS the destination.
    const dest = raw('open http://localhost:4174/search.html?q=catalog#top');
    expect(dest.kind === 'DECLARED' && dest.url?.path).toBe('/search.html');
    // Entry-URL channel: identical normalization, different meaning (N18).
    const entry = raw('open the catalog at http://localhost:4174/search.html?q=catalog#top');
    expect(entry.kind === 'DECLARED' && entry.entryUrl?.path).toBe('/search.html');

    // Only `origin` + `path` are comparable. `rawUrl` is provenance and is
    // deliberately unnormalised, so the assertion is on the comparable fields.
    for (const d of [dest, entry]) {
      const comparable = d.kind === 'DECLARED'
        ? `${d.url?.origin ?? ''}${d.url?.path ?? ''}${d.entryUrl?.origin ?? ''}${d.entryUrl?.path ?? ''}`
        : '';
      expect(comparable).not.toContain('?');
      expect(comparable).not.toContain('#');
      expect(comparable).not.toContain('catalog');
    }
  });

  it('a trailing slash and case differences normalise identically', () => {
    const a = raw('open http://LOCALHOST:4174/Results/');
    const b = raw('open http://localhost:4174/results');
    expect(a.kind === 'DECLARED' && b.kind === 'DECLARED' && a.url?.path).toBe(
      b.kind === 'DECLARED' ? b.url?.path : null
    );
    expect(a.kind === 'DECLARED' && a.url?.origin).toBe('http://localhost:4174');
  });

  it('non-http schemes are not accepted as a URL destination', () => {
    for (const task of ['open file:///etc/passwd', 'open chrome://settings']) {
      const d = raw(task);
      expect(d.kind === 'DECLARED' && d.url, task).toBeFalsy();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. MULTI-CONSTRUCT TASKS (N17)
// ══════════════════════════════════════════════════════════════════════════════

describe('multiple destination constructs', () => {
  it('the audited multi-step task yields LISTING then an unsupported product hop', () => {
    const all = normalizeDestinations(
      'open the store catalog at http://localhost:4174/results.html and open the first product listed'
    );
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0]!.kind).toBe('DECLARED');
    expect(all[0]!.kind === 'DECLARED' && all[0]!.role?.acceptablePageTypes).toEqual(['LISTING']);
    // sg2's destination is a product, which the current ontology cannot express.
    const last = all[all.length - 1]!;
    expect(last.kind).toBe('UNSUPPORTED');
    expect(last.kind === 'UNSUPPORTED' && last.unmappedHead).toBe('product');
  });

  it('the primary declaration is the first construct', () => {
    const d = normalizeDestination(
      'open the store catalog at http://localhost:4174 and open the contact form'
    );
    expect(d.kind === 'DECLARED' && d.role?.acceptablePageTypes).toEqual(['LISTING']);
  });

  it('a clause boundary stops the parse from reaching a later noun', () => {
    // `bags` must not become the head of the catalog construct.
    expect(roleOf(raw('open the catalog and then find bags'))).toEqual(['LISTING']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. DETERMINISM
// ══════════════════════════════════════════════════════════════════════════════

describe('determinism', () => {
  const CORPUS = [
    'open the store catalog',
    'open the checkout page',
    'open the contact form',
    'open the shopping results',
    'open the first product',
    'catalog',
    'I already opened the catalog',
    'open the store catalog at http://localhost:4174/results.html',
    'open the store catalog at http://localhost:4174 and open the first product listed',
    '',
  ];

  it('100 identical runs produce byte-identical output', () => {
    for (const task of CORPUS) {
      const first = JSON.stringify(normalizeDestinations(task));
      for (let i = 0; i < 100; i += 1) {
        expect(JSON.stringify(normalizeDestinations(task)), `${task} run ${i}`).toBe(first);
      }
    }
  });

  it('no clock, randomness or ambient state is consulted', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(process.cwd(), 'extension/src/planning/destinationNormalizer.ts'),
      'utf8'
    );
    for (const forbidden of ['Date.now', 'Math.random', 'performance.now', 'crypto.']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it('the same input always yields the same object shape', () => {
    for (const task of CORPUS) {
      const a = normalizeDestinations(task);
      const b = normalizeDestinations(task);
      expect(Object.keys(a)).toEqual(Object.keys(b));
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. ENTRY URL vs DESTINATION URL (POST-17.10 Step 6)
//
// Step 5 proved, against real Chrome, that the exact URL channel correctly
// rejected `/` against an observed `/results.html`. The defect was not the
// comparison — it was that the normalizer had recorded the user's ENTRY site as
// if it were the DESTINATION. These tests pin that split.
// ══════════════════════════════════════════════════════════════════════════════

describe('Step 6 — entry URL vs destination URL', () => {
  const ORIGIN = 'http://localhost:4174';

  // ── Case A ────────────────────────────────────────────────────────────────
  it('A: "open the store catalog at <origin>" is an ENTRY URL plus a LISTING role', () => {
    const d = raw(`open the store catalog at ${ORIGIN}`);
    expect(d.kind).toBe('DECLARED');
    expect(roleOf(d)).toEqual(['LISTING']);
    expect(d.kind === 'DECLARED' && d.entryUrl?.origin).toBe(ORIGIN);
    expect(d.kind === 'DECLARED' && d.entryUrl?.path).toBe('/');
    expect(d.kind === 'DECLARED' && d.entryUrl?.provenance).toBe('USER_ENTRY_SITE');
    // The destination URL channel is ABSENT, which is the entire fix.
    expect(d.kind === 'DECLARED' && d.url).toBeUndefined();
  });

  // ── Case B ────────────────────────────────────────────────────────────────
  it('B: "open <origin>/results.html" is a DESTINATION URL', () => {
    const d = raw(`open ${ORIGIN}/results.html`);
    expect(d.kind).toBe('DECLARED');
    expect(d.kind === 'DECLARED' && d.url?.origin).toBe(ORIGIN);
    expect(d.kind === 'DECLARED' && d.url?.path).toBe('/results.html');
    expect(d.kind === 'DECLARED' && d.url?.provenance).toBe('USER_URL');
    expect(d.kind === 'DECLARED' && d.entryUrl).toBeUndefined();
    expect(roleOf(d)).toBeNull();
  });

  // ── Case D ────────────────────────────────────────────────────────────────
  it('D: entryUrl and destinationUrl are never the same field', () => {
    const entryCase = raw(`open the store catalog at ${ORIGIN}`);
    const destCase = raw(`open ${ORIGIN}/results.html`);

    expect(entryCase.kind === 'DECLARED').toBe(true);
    expect(destCase.kind === 'DECLARED').toBe(true);
    if (entryCase.kind !== 'DECLARED' || destCase.kind !== 'DECLARED') return;

    // The entry case has no destination URL; the destination case has no entry.
    expect(entryCase.url).toBeUndefined();
    expect(destCase.entryUrl).toBeUndefined();
    expect(entryCase.entryUrl).toBeDefined();
    expect(destCase.url).toBeDefined();

    // And the two declarations are not interchangeable even for one literal.
    expect(Object.keys(entryCase).sort()).not.toEqual(Object.keys(destCase).sort());
  });

  it('D2: a bare origin named with a role is an entry URL, never a destination URL', () => {
    for (const task of [
      `open the catalog at ${ORIGIN}`,
      `open the store catalog at ${ORIGIN}`,
      `go to the catalog at ${ORIGIN}`,
      `open the product listing at ${ORIGIN}`,
      `open the checkout at ${ORIGIN}`,
      `open the login page at ${ORIGIN}`,
    ]) {
      const d = raw(task);
      expect(d.kind, task).toBe('DECLARED');
      expect(d.kind === 'DECLARED' && d.url, task).toBeUndefined();
      expect(d.kind === 'DECLARED' && d.entryUrl, task).toBeDefined();
      expect(roleOf(d), task).not.toBeNull();
    }
  });

  it('D3: a bare origin named with NO role stays a destination URL (N1)', () => {
    // Nothing in the sentence names a destination in words, so the URL is the
    // only possible destination claim and it remains exactly comparable.
    const d = raw(`open ${ORIGIN}`);
    expect(d.kind === 'DECLARED' && d.url?.origin).toBe(ORIGIN);
    expect(d.kind === 'DECLARED' && d.entryUrl).toBeUndefined();
  });

  it('D4: the split is decided by grammar, never by the shape of the URL', () => {
    // The SAME literal, one with a role noun and one without, splits two ways.
    // If the decision were made by inspecting the path, both would agree.
    const withRole = raw(`open the catalog at ${ORIGIN}/results.html`);
    const withoutRole = raw(`open ${ORIGIN}/results.html`);
    expect(withRole.kind === 'DECLARED' && withRole.entryUrl?.path).toBe('/results.html');
    expect(withRole.kind === 'DECLARED' && withRole.url).toBeUndefined();
    expect(withoutRole.kind === 'DECLARED' && withoutRole.url?.path).toBe('/results.html');
    expect(withoutRole.kind === 'DECLARED' && withoutRole.entryUrl).toBeUndefined();
  });

  it('an unresolvable role leaves the URL in the DESTINATION channel, not entry', () => {
    // "open the widget at <origin>" — the head is unmappable, so no role is
    // declared and there is nothing for an entry URL to attach to. The URL then
    // keeps its independent N1 meaning and is compared exactly. This fails
    // STRICT (an exact `/` constraint), never loose, and the unmappable head is
    // still reported rather than guessed at.
    const all = normalizeDestinations(`open the widget at ${ORIGIN}`);
    const d = all[0]!;
    expect(d.kind).toBe('DECLARED');
    expect(d.kind === 'DECLARED' && d.url?.origin).toBe(ORIGIN);
    expect(d.kind === 'DECLARED' && d.entryUrl).toBeUndefined();
    expect(
      all.some((x) => x.kind === 'UNSUPPORTED' && x.unmappedHead === 'widget'),
      'the unmappable head must still be reported'
    ).toBe(true);
  });

  it('a non-http URL never becomes an entry URL', () => {
    for (const task of [`open the catalog at file:///etc/passwd`, `open the catalog at chrome://settings`]) {
      const d = raw(task);
      expect(d.kind === 'DECLARED' && d.entryUrl, task).toBeFalsy();
    }
  });

  it('only the FIRST user URL is normalized, and here it is the entry site', () => {
    // N1 is a single URL channel, so a second URL in the same sentence is not
    // normalized at all. This is a PRE-EXISTING scope limit, recorded as a
    // KNOWN_LIMITATION in the Step 6 evidence. It is pinned here rather than
    // left implicit: nothing extra is ever asserted, so the failure mode is a
    // missing constraint (strict), never a loosened one.
    const all = normalizeDestinations(`open the store catalog at ${ORIGIN}, then open ${ORIGIN}/checkout`);
    expect(all).toHaveLength(1);
    expect(all[0]!.kind === 'DECLARED' && all[0]!.entryUrl?.path).toBe('/');
    expect(all[0]!.kind === 'DECLARED' && all[0]!.url).toBeUndefined();
  });
});
