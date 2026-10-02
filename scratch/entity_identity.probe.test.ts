/**
 * READ-ONLY probe — Option D viability: are semantic ENTITIES actually
 * populated on each fixture page, and do they distinguish
 * catalog / search / product without any fixture-specific rule?
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { extractSemanticEntities } from '../extension/src/semanticUnderstanding/entityUnderstanding';
import { classifyPageSemantics } from '../extension/src/semanticUnderstanding/pageClassifier';
import { observeWorkflowState } from '../extension/src/semanticUnderstanding/workflowState';
import type { BrowserWorldModel } from '../extension/src/worldModel/types';

const FIXTURE = join(process.cwd(), 'demo', 'shopping-fixture');
const PAGES = ['index.html', 'search.html', 'results.html', 'product.html'];

function wmFor(page: string): BrowserWorldModel {
  const html = readFileSync(join(FIXTURE, page), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  const nodes = document.querySelectorAll('input, button, a, select, textarea, .product-card, [data-product], .card');
  const elements = Array.from(nodes).map((n, i) => {
    const tag = n.tagName.toLowerCase();
    return {
      id: `el_${i}`,
      type: (tag === 'input'
        ? (n as HTMLInputElement).type === 'search'
          ? 'search'
          : 'input'
        : tag === 'button'
          ? 'button'
          : tag === 'a'
            ? 'link'
            : tag === 'select'
              ? 'select'
              : 'other') as never,
      tag,
      label: (n.textContent || '').trim().slice(0, 80),
      selector: `#${n.id || `${tag}-${i}`}`,
      visible: true,
      enabled: true,
      boundingBox: { x: 0, y: 0, width: 100, height: 20 },
      attributes: {},
      privacyRisk: 'none',
    };
  });
  return {
    page: {
      url: `http://localhost:4174/${page === 'index.html' ? '' : page}`,
      title: document.title,
      pageGeneration: 1,
      viewport: { width: 1280, height: 720, scroll_x: 0, scroll_y: 0 },
    },
    elements,
    detections: [],
    scanLatencyMs: 0,
    totalElementsScanned: elements.length,
  } as never;
}

describe('option D entity viability', () => {
  for (const p of PAGES) {
    it(p, () => {
      const wm = wmFor(p);
      const cls = classifyPageSemantics({ worldModel: wm, root: document, pageGeneration: 1 });
      const wf = observeWorkflowState({
        pageType: cls.pageType,
        pageState: 'populated',
        worldModel: wm,
        root: document,
        pageGeneration: 1,
      });
      const ents = extractSemanticEntities({ worldModel: wm, root: document, pageGeneration: 1 } as never);
      const byType: Record<string, number> = {};
      for (const e of ents) byType[e.type] = (byType[e.type] ?? 0) + 1;
      console.log(
        'ENT ' +
          JSON.stringify({
            page: p,
            semanticPageType: cls.pageType,
            conf: cls.confidence,
            workflowStage: wf.currentStage,
            flowType: wf.flowType,
            entityCount: ents.length,
            entityTypes: byType,
            // Are labels populated, or only types? (a label-free entity set cannot
            // carry destination identity, only category identity)
            sampleLabels: ents.slice(0, 4).map((e) => `${e.type}:${String(e.label).slice(0, 24)}`),
            // does anything name a CATALOG concept?
            mentionsCatalog: ents.some((e) => /catalog/i.test(String(e.label))),
          })
      );
    });
  }

  it('workflow product-detail selector vocabulary vs the fixture markup', () => {
    const html = readFileSync(join(FIXTURE, 'product.html'), 'utf8');
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    const wfSelectors = ['#add-to-cart', '.btn-buy-now', '[data-action="add-to-cart"]'];
    const afSelectors = ['#add-to-cart', '#buy-now', '.btn-add-cart', 'button[id*="buy" i]', 'button[id*="cart" i]'];
    console.log(
      'SELECTOR ' +
        JSON.stringify({
          fixtureIds: Array.from(document.querySelectorAll('button[id]')).map((b) => `#${b.id}`),
          workflowState_matches: wfSelectors.filter((s) => document.querySelector(s)),
          affordanceEngine_matches: afSelectors.filter((s) => {
            try { return Boolean(document.querySelector(s)); } catch { return false; }
          }),
        })
    );
  });
});
