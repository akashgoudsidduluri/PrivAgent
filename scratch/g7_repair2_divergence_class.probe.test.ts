/**
 * G7 REPAIR 2 — WHICH PAGE TYPES ACTUALLY DIVERGE?
 *
 * Audit-only probe. For each REAL fixture page, run the REAL
 * `buildSemanticUnderstanding` both ways:
 *
 *   (a) content-script path  — `root: document`
 *   (b) service-worker shape  — no `document` global, world model only
 *
 * using the REAL `buildBrowserWorldModel`. Reports the divergence class so the
 * repair targets a real defect rather than an assumed one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { buildSemanticUnderstanding } from '../extension/src/semanticUnderstanding';

const DIR = join(process.cwd(), 'demo', 'shopping-fixture');

const PAGES: Array<{ file: string; url: string; gen: number }> = [
  { file: 'results.html', url: 'http://localhost:4174/results.html?q=all', gen: 7 },
  { file: 'search.html', url: 'http://localhost:4174/search.html', gen: 5 },
  { file: 'index.html', url: 'http://localhost:4174/', gen: 2 },
  { file: 'product.html', url: 'http://localhost:4174/product.html?id=1', gen: 13 },
  { file: 'login.html', url: 'http://localhost:4174/login.html', gen: 17 },
  { file: 'modal-popup.html', url: 'http://localhost:4174/modal-popup.html', gen: 19 },
];

describe('G7 Repair 2 — divergence class across real fixture pages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports content-script vs service-worker classification per real page', () => {
    const rows: unknown[] = [];

    for (const page of PAGES) {
      let html: string;
      try {
        html = readFileSync(join(DIR, page.file), 'utf8');
      } catch {
        continue;
      }
      document.documentElement.innerHTML = html;

      const wm = buildBrowserWorldModel({ root: document, pageGeneration: page.gen });
      wm.page = { ...wm.page, url: page.url };

      const normal = buildSemanticUnderstanding({
        root: document,
        worldModel: wm,
        pageGeneration: page.gen,
      }).sanitizedContext;

      vi.stubGlobal('document', undefined);
      const fallback = buildSemanticUnderstanding({
        worldModel: wm,
        pageGeneration: page.gen,
        userGoal: 'open the store catalog',
      }).sanitizedContext;
      vi.unstubAllGlobals();

      rows.push({
        file: page.file,
        normal: `${normal.pageType}@${normal.confidence}`,
        fallback: `${fallback.pageType}@${fallback.confidence}`,
        diverges: normal.pageType !== fallback.pageType,
        worldModelEntities: wm.entities.length,
      });
    }

    console.log('[REPAIR2-CLASS] ' + JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('probes the residual divergence class using DOM-only classifier signals', () => {
    // These page shapes are classified from DOM selectors that have NO
    // worldModel fallback in the classifier (DASHBOARD tables/grids, ARTICLE
    // containers, CHECKOUT controls, SETTINGS panels). A service worker has no
    // DOM, so these are exactly the shapes at risk.
    const CASES: Array<{ name: string; html: string; url: string }> = [
      {
        name: 'dashboard',
        url: 'http://localhost:4174/admin',
        html: '<html><body><h1>Dashboard</h1><table><tbody>'
          + '<tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr>'
          + '</tbody></table></body></html>',
      },
      {
        name: 'checkout',
        url: 'http://localhost:4174/cart',
        html: '<html><body><h1>Your cart</h1><button id="btn-checkout">Pay</button>'
          + '<div class="cart-summary"></div></body></html>',
      },
      {
        name: 'settings',
        url: 'http://localhost:4174/settings',
        html: '<html><body><h1>Settings</h1><div class="settings-panel"></div></body></html>',
      },
    ];

    const rows: unknown[] = [];
    for (const c of CASES) {
      document.documentElement.innerHTML = c.html;
      const wm = buildBrowserWorldModel({ root: document, pageGeneration: 21 });
      wm.page = { ...wm.page, url: c.url };

      const normal = buildSemanticUnderstanding({
        root: document,
        worldModel: wm,
        pageGeneration: 21,
      }).sanitizedContext;

      vi.stubGlobal('document', undefined);
      const fallback = buildSemanticUnderstanding({
        worldModel: wm,
        pageGeneration: 21,
      }).sanitizedContext;
      vi.unstubAllGlobals();

      rows.push({
        name: c.name,
        normal: `${normal.pageType}@${normal.confidence}`,
        fallback: `${fallback.pageType}@${fallback.confidence}`,
        diverges: normal.pageType !== fallback.pageType,
      });
    }

    console.log('[REPAIR2-CLASS] ' + JSON.stringify(rows, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  });
});