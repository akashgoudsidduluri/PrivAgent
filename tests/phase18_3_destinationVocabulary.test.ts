/**
 * Phase 18.3 — Destination Vocabulary & Intent Coverage Tests
 *
 * Requirements:
 * 1. "open account details" -> DECLARED ['SETTINGS', 'DASHBOARD']
 * 2. "open api keys" -> DECLARED ['SETTINGS', 'DASHBOARD']
 * 3. "open groq api keys page" -> DECLARED ['SETTINGS', 'DASHBOARD']
 * 4. "open transactions" -> DECLARED ['DASHBOARD']
 * 5. "open recent transactions" -> DECLARED ['DASHBOARD']
 * 6. "open store catalog" -> DECLARED ['LISTING']
 * 7. existing supported destination prompts remain supported
 * 8. unsupported destination nouns still remain UNSUPPORTED
 * 9. ambiguous wording remains AMBIGUOUS/UNKNOWN
 * 10. no destination URL is invented for role-only declarations
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeDestination,
  normalizeDestinations,
  type DestinationDeclaration,
} from '../extension/src/planning/destinationNormalizer';

describe('Phase 18.3: Destination Vocabulary & Intent Coverage', () => {
  it('1. "open account details" produces deterministic role declaration', () => {
    const d = normalizeDestination('open account details');
    expect(d.kind).toBe('DECLARED');
    if (d.kind === 'DECLARED') {
      expect(d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
      expect(d.role?.acceptablePageTypes).toEqual(['SETTINGS', 'DASHBOARD']);
      expect(d.url).toBeUndefined();
      expect(d.entryUrl).toBeUndefined();
    }
  });

  it('2. "open api keys" produces deterministic role declaration', () => {
    const d = normalizeDestination('open api keys');
    expect(d.kind).toBe('DECLARED');
    if (d.kind === 'DECLARED') {
      expect(d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
      expect(d.role?.acceptablePageTypes).toEqual(['SETTINGS', 'DASHBOARD']);
      expect(d.url).toBeUndefined();
      expect(d.entryUrl).toBeUndefined();
    }
  });

  it('3. "open groq api keys page" produces deterministic role declaration without inventing URL', () => {
    const d = normalizeDestination('open groq api keys page');
    expect(d.kind).toBe('DECLARED');
    if (d.kind === 'DECLARED') {
      expect(d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
      expect(d.role?.acceptablePageTypes).toEqual(['SETTINGS', 'DASHBOARD']);
      expect(d.url).toBeUndefined();
      expect(d.entryUrl).toBeUndefined();
    }
  });

  it('4. "open transactions" produces deterministic role declaration', () => {
    const d = normalizeDestination('open transactions');
    expect(d.kind).toBe('DECLARED');
    if (d.kind === 'DECLARED') {
      expect(d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
      expect(d.role?.acceptablePageTypes).toEqual(['DASHBOARD']);
      expect(d.url).toBeUndefined();
      expect(d.entryUrl).toBeUndefined();
    }
  });

  it('5. "open recent transactions" produces deterministic role declaration', () => {
    const d = normalizeDestination('open recent transactions');
    expect(d.kind).toBe('DECLARED');
    if (d.kind === 'DECLARED') {
      expect(d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
      expect(d.role?.acceptablePageTypes).toEqual(['DASHBOARD']);
      expect(d.url).toBeUndefined();
      expect(d.entryUrl).toBeUndefined();
    }
  });

  it('6. "open store catalog" produces deterministic role declaration', () => {
    const d = normalizeDestination('open store catalog');
    expect(d.kind).toBe('DECLARED');
    if (d.kind === 'DECLARED') {
      expect(d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
      expect(d.role?.acceptablePageTypes).toEqual(['LISTING']);
      expect(d.url).toBeUndefined();
      expect(d.entryUrl).toBeUndefined();
    }
  });

  it('7. existing supported destination prompts remain supported', () => {
    const existing = [
      ['open the checkout page', ['CHECKOUT']],
      ['open the contact form', ['FORM']],
      ['go to the product listing', ['LISTING']],
      ['open the search page', ['SEARCH']],
      ['visit the article page', ['ARTICLE']],
      ['open the login page', ['LOGIN']],
      ['navigate to settings', ['SETTINGS']],
      ['open the dashboard', ['DASHBOARD']],
      ['open search results', ['LISTING']],
      ['open product details', ['LISTING']],
    ] as const;

    for (const [task, expectedTypes] of existing) {
      const d = normalizeDestination(task);
      expect(d.kind, task).toBe('DECLARED');
      if (d.kind === 'DECLARED') {
        expect(d.role?.acceptablePageTypes, task).toEqual(expectedTypes);
      }
    }
  });

  it('8. unsupported destination nouns still remain UNSUPPORTED', () => {
    const unsupported = [
      ['open the store', 'store'],
      ['open the first product', 'product'],
      ['browse the shop', 'shop'],
      ['open the products', 'products'],
      ['open details', 'details'],
      ['open keys', 'keys'],
    ] as const;

    for (const [task, unmappedHead] of unsupported) {
      const d = normalizeDestination(task);
      expect(d.kind, task).toBe('UNSUPPORTED');
      if (d.kind === 'UNSUPPORTED') {
        expect(d.unmappedHead, task).toBe(unmappedHead);
        expect(d.provenance, task).toBe('EXPLICIT_PAGE_ROLE');
      }
    }
  });

  it('9. ambiguous wording remains AMBIGUOUS', () => {
    const ambiguous = [
      ['open the results', [['LISTING'], ['SEARCH']]],
      ['open the account page', [['LOGIN'], ['DASHBOARD']]],
      ['open my orders', [['CHECKOUT'], ['DASHBOARD']]],
      ['open the history page', [['DASHBOARD'], ['ARTICLE']]],
      ['open the review section', [['ARTICLE'], ['CHECKOUT']]],
      ['open the overview', [['DASHBOARD'], ['ARTICLE']]],
    ] as const;

    for (const [task, expectedCandidates] of ambiguous) {
      const d = normalizeDestination(task);
      expect(d.kind, task).toBe('AMBIGUOUS');
      if (d.kind === 'AMBIGUOUS') {
        expect(d.candidates, task).toEqual(expectedCandidates);
        expect(d.provenance, task).toBe('EXPLICIT_PAGE_ROLE');
      }
    }
  });

  it('10. no destination URL is invented for role-only declarations', () => {
    const tasks = [
      'open account details',
      'open api keys',
      'open groq api keys page',
      'open transactions',
      'open recent transactions',
      'open store catalog',
      'open search results',
      'open product details',
    ];

    for (const task of tasks) {
      const d = normalizeDestination(task);
      expect(d.kind, task).toBe('DECLARED');
      if (d.kind === 'DECLARED') {
        expect(d.url, `task ${task} must not invent url`).toBeUndefined();
        expect(d.entryUrl, `task ${task} must not invent entryUrl`).toBeUndefined();
        expect(d.role?.provenance).toBe('EXPLICIT_PAGE_ROLE');
      }
    }
  });

  it('preserves user URL when explicit URL is supplied', () => {
    const d = normalizeDestination('open the api keys at https://groq.com');
    expect(d.kind).toBe('DECLARED');
    if (d.kind === 'DECLARED') {
      expect(d.role?.acceptablePageTypes).toEqual(['SETTINGS', 'DASHBOARD']);
      expect(d.entryUrl?.origin).toBe('https://groq.com');
      expect(d.url).toBeUndefined();
    }
  });
});
