/**
 * STEP 10.5 Part 4/8 — verify the REAL production page classifier against the
 * REAL fixture pages, using the same code path the extension uses.
 *
 * Read-only. Fetches the live fixture over HTTP and classifies each page with
 * the production `classifyPageSemantics`. This establishes, before any change,
 * whether a correct navigation to /results.html would actually satisfy the
 * DestinationVerifier.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { classifyPageSemantics, MIN_PAGE_CLASSIFICATION_CONFIDENCE } from '../extension/src/semanticUnderstanding/pageClassifier';

const FIXTURE = 'http://localhost:4174';

async function classifyPage(url: string) {
  const html = await (await fetch(url)).text();
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document as unknown as Document;
  const result = classifyPageSemantics({ root: doc, pageGeneration: 3 });
  return {
    url,
    pageType: result.pageType,
    confidence: result.confidence,
    signals: result.signals,
  };
}

describe('STEP 10.5 — real classifier vs real fixture', () => {
  it('classifies /results.html as LISTING above the floor', async () => {
    const r = await classifyPage(`${FIXTURE}/results.html`);
    console.log('[probe] /results.html ->', JSON.stringify({
      pageType: r.pageType, confidence: r.confidence,
    }));
    console.log('[probe]   signals:', JSON.stringify(r.signals));
    expect(r.pageType).toBe('LISTING');
    expect(r.confidence).toBeGreaterThanOrEqual(MIN_PAGE_CLASSIFICATION_CONFIDENCE);
  });

  it('does NOT classify / or /search.html as LISTING', async () => {
    for (const p of ['/', '/search.html']) {
      const r = await classifyPage(`${FIXTURE}${p}`);
      console.log(`[probe] ${p} ->`, JSON.stringify({
        pageType: r.pageType, confidence: r.confidence,
      }));
      expect(r.pageType).not.toBe('LISTING');
    }
  });

  it('reports the floor for reference', () => {
    console.log('[probe] MIN_PAGE_CLASSIFICATION_CONFIDENCE =', MIN_PAGE_CLASSIFICATION_CONFIDENCE);
    expect(MIN_PAGE_CLASSIFICATION_CONFIDENCE).toBe(0.5);
  });
});
