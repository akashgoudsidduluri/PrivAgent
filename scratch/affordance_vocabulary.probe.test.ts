/**
 * READ-ONLY PROBE — what affordance types does the real shopping fixture
 * actually produce, on each page the real run visited?
 *
 * Decides whether `expectedValue: 'ENTER_QUERY'` is a truthful, satisfiable
 * observation-backed condition for the two SEARCH subgoal producers, or a
 * new dead-end.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { discoverActionAffordances } from '../extension/src/semanticUnderstanding/actionAffordance';
import { classifyPageSemantics } from '../extension/src/semanticUnderstanding/pageClassifier';
import type { BrowserWorldModel } from '../extension/src/worldModel/types';

const FIXTURE = join(process.cwd(), 'demo', 'shopping-fixture');
const PAGES = ['index.html', 'search.html', 'results.html', 'product.html'];

function minimalWorldModel(url: string, root: Document): BrowserWorldModel {
  const elements: BrowserWorldModel['elements'] = [];
  const nodes = root.querySelectorAll('input, button, a, select, textarea, [role="button"]');
  let i = 0;
  for (const n of Array.from(nodes)) {
    const tag = n.tagName.toLowerCase();
    const type =
      tag === 'input'
        ? ((n as HTMLInputElement).type === 'search' ? 'search' : 'input')
        : tag === 'button'
          ? 'button'
          : tag === 'a'
            ? 'link'
            : tag === 'select'
              ? 'select'
              : 'other';
    elements.push({
      id: `el_${i}`,
      type: type as never,
      tag,
      label: (n.textContent || '').trim().slice(0, 80),
      selector: `#${n.id || `${tag}-${i}`}`,
      visible: true,
      enabled: !(n as HTMLButtonElement).disabled,
      boundingBox: { x: 0, y: 0, width: 100, height: 20 },
      attributes: {},
      privacyRisk: 'none',
    } as never);
    i += 1;
  }
  return {
    page: { url, title: root.title, pageGeneration: 1, viewport: { width: 1280, height: 720, scroll_x: 0, scroll_y: 0 } },
    elements,
    detections: [],
    scanLatencyMs: 0,
    totalElementsScanned: elements.length,
  } as never;
}

describe('fixture affordance vocabulary', () => {
  for (const p of PAGES) {
    it(`page ${p}`, () => {
      const html = readFileSync(join(FIXTURE, p), 'utf8');
      document.documentElement.innerHTML = html
        .replace(/<!DOCTYPE[^>]*>/i, '')
        .replace(/<head[\s\S]*?<\/head>/i, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '');
      const wm = minimalWorldModel(`http://localhost:4174/${p === 'index.html' ? '' : p}`, document);
      const cls = classifyPageSemantics({ worldModel: wm as never, root: document, pageGeneration: 1 });
      const affs = discoverActionAffordances({ pageType: cls.pageType, worldModel: wm, root: document, pageGeneration: 1 });
      console.log(
        JSON.stringify(
          {
            page: p,
            pageType: cls.pageType,
            confidence: cls.confidence,
            affordances: affs.map((a) => a.type),
            entities: 0,
          },
          null,
          1
        )
      );
    });
  }
});
