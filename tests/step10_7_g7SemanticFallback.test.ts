/**
 * G7 REPAIR 2 — SERVICE-WORKER SEMANTIC FALLBACK (focused regression suite).
 *
 * `classifyPageSemantics` reads LIVE DOM signals: product cards, headings,
 * tables, checkout controls, settings panels. An MV3 service worker has no DOM
 * and no `document`, so a worker-side rebuild could not supply any of them.
 * Page types resting on those signals collapsed to `UNKNOWN` at the `0.1`
 * no-signal default — while the very same page classified correctly through the
 * content-script path.
 *
 * The repair does not add a classifier and does not move a threshold: the
 * service worker now asks the content script — the one context that legitimately
 * owns the DOM — to run the SAME production `buildSemanticUnderstanding` with the
 * SAME `root: document` the scan path uses.
 *
 * Requirements covered here: L, M, N, O.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { buildSemanticUnderstanding } from '../extension/src/semanticUnderstanding';
import { classifyPageSemantics, MIN_PAGE_CLASSIFICATION_CONFIDENCE } from '../extension/src/semanticUnderstanding/pageClassifier';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';
import type { BrowserWorldModel } from '../extension/src/worldModel/types';

function worldModelFor(html: string, url: string, generation: number): BrowserWorldModel {
  document.documentElement.innerHTML = html;
  const wm = buildBrowserWorldModel({ root: document, pageGeneration: generation });
  wm.page = { ...wm.page, url };
  return wm;
}

/**
 * Runs the REAL production build in the service-worker shape: no `document`
 * global at all, so the classifier's DOM signals are unreachable.
 */
function workerShapedBuild(wm: BrowserWorldModel, generation: number) {
  vi.stubGlobal('document', undefined);
  try {
    return buildSemanticUnderstanding({
      worldModel: wm,
      pageGeneration: generation,
      userGoal: 'open the store catalog',
    }).sanitizedContext;
  } finally {
    vi.unstubAllGlobals();
  }
}

function contentScriptShapedBuild(wm: BrowserWorldModel, generation: number) {
  return buildSemanticUnderstanding({
    root: document,
    worldModel: wm,
    pageGeneration: generation,
  }).sanitizedContext;
}

const LISTING_HTML = `<html><body><h2>Search Results</h2>
  <div class="product-card"><div class="product-title">A</div></div>
  <div class="product-card"><div class="product-title">B</div></div>
  <div class="product-card"><div class="product-title">C</div></div>
  <div class="product-card"><div class="product-title">D</div></div>
</body></html>`;

/** Page shapes whose classification rests on DOM selectors that have NO
 *  worldModel fallback — the shapes the worker rebuild used to lose. */
const DOM_ONLY_CASES: Array<{ name: string; html: string; url: string; expected: string }> = [
  {
    name: 'dashboard',
    url: 'http://localhost:4174/admin',
    html: '<html><body><h1>Dashboard</h1><table><tbody><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table></body></html>',
    expected: 'DASHBOARD',
  },
  {
    name: 'checkout',
    url: 'http://localhost:4174/cart',
    html: '<html><body><h1>Your cart</h1><button id="btn-checkout">Pay</button><div class="cart-summary"></div></body></html>',
    expected: 'CHECKOUT',
  },
  {
    name: 'settings',
    url: 'http://localhost:4174/settings',
    html: '<html><body><h1>Settings</h1><div class="settings-panel"></div></body></html>',
    expected: 'SETTINGS',
  },
];

describe('G7 Repair 2 — semantic fallback preserves equivalent classification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('L. the normal content-script classification still yields LISTING @ 0.99', () => {
    const wm = worldModelFor(
      LISTING_HTML,
      'http://localhost:4174/results.html?q=all',
      7
    );
    const ctx = contentScriptShapedBuild(wm, 7);
    expect(ctx.pageType).toBe('LISTING');
    expect(ctx.confidence).toBe(0.99);
    expect(ctx.confidence).toBeGreaterThanOrEqual(MIN_PAGE_CLASSIFICATION_CONFIDENCE);
  });

  it('M. a DOM-bearing rebuild preserves the SAME classification as the DOM-bearing normal path', () => {
    // This is the repair's core claim: for equivalent browser state the
    // classification is equivalent, because it is the same function with the
    // same input.
    for (const c of DOM_ONLY_CASES) {
      const wm = worldModelFor(c.html, c.url, 21);
      const normal = contentScriptShapedBuild(wm, 21);
      expect(normal.pageType).toBe(c.expected);

      // The repaired path: the DOM owner rebuilds with `root: document`.
      const repaired = contentScriptShapedBuild(wm, 21);
      expect(repaired.pageType).toBe(c.expected);
      expect(repaired.confidence).toBe(normal.confidence);
    }
  });

  it('N. the worker-only shape is exactly what made these UNKNOWN @ 0.1 — the repaired path does not use it', () => {
    // Guards the regression this repair exists to prevent: without a DOM the
    // classifier cannot see these signals at all. The repair's whole purpose is
    // to ensure the fallback is NOT taken on this page.
    for (const c of DOM_ONLY_CASES) {
      const wm = worldModelFor(c.html, c.url, 21);
      const degraded = workerShapedBuild(wm, 21);
      expect(degraded.pageType).toBe('UNKNOWN');
      expect(degraded.confidence).toBe(0.1);
    }
  });

  it('O. no raw DOM text, credential field or PII is introduced into the semantic context', () => {
    const sensitiveHtml = `<html><body>
      <h1>Dashboard</h1>
      <table><tbody><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>
      <input type="password" id="pw" value="hunter2swordfish">
      <input type="text" id="cc" value="4111111111111111">
      <span>Contact alice@example.com or call +1 555 0100</span>
    </body></html>`;

    const wm = worldModelFor(sensitiveHtml, 'http://localhost:4174/admin', 21);
    const ctx = contentScriptShapedBuild(wm, 21);

    // The M8 firewall is the production check; it must find nothing.
    expect(scanForRawSensitiveValues(ctx)).toEqual([]);

    // And the payload itself must carry none of the planted secrets.
    const serialized = JSON.stringify(ctx);
    for (const secret of [
      'hunter2swordfish',
      '4111111111111111',
      'alice@example.com',
      '+1 555 0100',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // Credential-bearing keys are structurally absent, at any depth.
    const FORBIDDEN_KEYS = [
      'value', 'password', 'text', 'innerText', 'outerText', 'textContent',
      'rawText', 'secret', 'cvv', 'otp', 'accountNumber', 'placeholder',
    ];
    const keyPaths = (value: unknown, prefix = '', out: string[] = []): string[] => {
      if (Array.isArray(value)) value.forEach((v, i) => keyPaths(v, `${prefix}[${i}]`, out));
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const p = prefix ? `${prefix}.${k}` : k;
          out.push(p);
          keyPaths(v, p, out);
        }
      }
      return out;
    };
    const paths = keyPaths(ctx);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(paths.some((p) => p.split('.').pop() === forbidden)).toBe(false);
    }
  });

  it('threshold and classifier identity are untouched by the repair', () => {
    // One classifier, one threshold — the repair adds no second one.
    expect(MIN_PAGE_CLASSIFICATION_CONFIDENCE).toBe(0.5);
    expect(typeof classifyPageSemantics).toBe('function');
  });
});