import { describe, it } from 'vitest';
import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import { classifyTaskCategory } from '../extension/src/hierarchicalPlanning/taskDecomposer';

const ORIGIN = 'http://localhost:4174';
const CASES = [
  `open the store catalog at ${ORIGIN}`,
  'open the widget page',
  'open the results page',
  `open ${ORIGIN}/results.html and buy the first product listed`,
  `open ${ORIGIN}/results.html`,
  'visit the catalog',
];

describe('probe', () => {
  it('prints', () => {
    for (const c of CASES) {
      const d = normalizeDestination(c);
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          prompt: c,
          category: classifyTaskCategory(c),
          kind: d.kind,
          role: d.kind === 'DECLARED' ? d.role?.acceptablePageTypes : (d as never).candidates,
          url: d.kind === 'DECLARED' ? (d.url ? `${d.url.origin}${d.url.path}` : null) : null,
          entryUrl:
            d.kind === 'DECLARED' && d.entryUrl
              ? `${d.entryUrl.origin}${d.entryUrl.path}`
              : null,
        })
      );
    }
  });
});
