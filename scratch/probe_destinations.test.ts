import { describe, it } from 'vitest';
import { normalizeDestination } from './extension/src/planning/destinationNormalizer';

describe('probe new destinations', () => {
  const tests = [
    'open account details',
    'open api keys',
    'open groq api keys page',
    'open transactions',
    'open recent transactions',
    'open store catalog',
    'open search results',
    'open product details'
  ];

  for (const t of tests) {
    it(`evaluates ${t}`, () => {
      const res = normalizeDestination(t);
      console.log(`[PROBE] "${t}" =>`, JSON.stringify(res));
    });
  }
});
