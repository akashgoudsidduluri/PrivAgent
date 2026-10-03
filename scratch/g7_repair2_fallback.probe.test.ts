/**
 * G7 REPAIR 2 — DOES THE SERVICE-WORKER FALLBACK ACTUALLY DOWNGRADE?
 *
 * Audit-only probe. Uses the REAL `buildBrowserWorldModel` on the REAL fixture
 * page, then runs the REAL `classifyPageSemantics` twice:
 *
 *   (a) with `root` — the content-script path
 *   (b) with NO `root` and NO `document` — the MV3 service-worker fallback
 *
 * The question this answers: is the fallback genuinely broken with a REAL world
 * model, or did the earlier synthetic probe (which used an empty world model)
 * manufacture the symptom?
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { classifyPageSemantics } from '../extension/src/semanticUnderstanding/pageClassifier';

const FIXTURE = join(process.cwd(), 'demo', 'shopping-fixture', 'results.html');

describe('G7 Repair 2 — real world model, fallback classification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports what the REAL world model carries and what the fallback classifies', () => {
    document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8');

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 9 });
    // The service worker DOES have the real tab URL, via the world model.
    // jsdom's own location is a test artifact; stamp the real one so the
    // probe measures production reality rather than the harness.
    const REAL_URL = 'http://localhost:4174/results.html?q=all';
    wm.page = { ...wm.page, url: REAL_URL };

    const entityTypes = wm.entities.map((e) => e.type);
    const productEntities = entityTypes.filter((t) => t === 'Product' || t === 'SearchResult');

    console.log('[REPAIR2] world model summary:', JSON.stringify({
      url: wm.page.url,
      generation: wm.page.pageGeneration,
      elementCount: wm.elements.length,
      entityCount: wm.entities.length,
      entityTypes,
      productEntityCount: productEntities.length,
    }));

    // (a) content-script path: DOM root present.
    const withRoot = classifyPageSemantics({
      root: document,
      worldModel: wm,
      pageGeneration: 9,
    });
    console.log('[REPAIR2] WITH root ->', JSON.stringify({
      pageType: withRoot.pageType,
      confidence: withRoot.confidence,
    }));

    // (b) service-worker fallback: no `document` global at all.
    vi.stubGlobal('document', undefined);
    const fallback = classifyPageSemantics({
      worldModel: wm,
      pageGeneration: 9,
    });
    console.log('[REPAIR2] WITHOUT root (SW fallback) ->', JSON.stringify({
      pageType: fallback.pageType,
      confidence: fallback.confidence,
      evidence: fallback.evidence,
      secondary: fallback.secondaryCandidates,
    }));

    expect(withRoot.pageType).toBe('LISTING');
    // The probe asserts the FACT, whatever it is; the repair decision follows.
    console.log('[REPAIR2] FALLBACK_DOWNGRADES =', fallback.pageType !== withRoot.pageType);
  });
});