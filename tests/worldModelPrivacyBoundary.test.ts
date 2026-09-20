/**
 * PrivAgent 2.0 — World Model Privacy Boundary & Security Invariants Test Suite (Phase 1)
 *
 * Covers:
 *  - Scenario Q: Entity-to-element relationships
 *  - Scenario R: Stale world-model target rejection
 *  - Scenario S: Privacy firewall integration
 *  - Scenario T: Forbidden raw-value propagation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import {
  assertWorldModelSafe,
  createSanitizedWorldModelSummary,
  WorldModelPrivacyViolation,
} from '../extension/src/worldModel/worldModelSanitizer';
import { validateAction } from '../extension/src/agent/actionValidator';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { AgentContextPayload } from '../extension/src/privacy/types';

describe('WorldModel Privacy Boundary — Security Invariants Q, R, S, T', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('Scenario Q: links candidate entities to interactive elements deterministically', () => {
    document.body.innerHTML = `
      <article id="article-1" class="article-card">
        <h2 id="art-title">Privacy Preserving AI</h2>
        <a id="art-read-more" href="/articles/1">Read Full Article</a>
      </article>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const actionRel = wm.semanticRelationships.find(r => r.targetId === 'art-read-more');
    expect(actionRel).toBeDefined();
  });

  it('Scenario R: stale world-model target is rejected when page generation has advanced', () => {
    // Page Generation 1 has a button
    document.body.innerHTML = `<button id="btn-old">Old Button</button>`;
    const wmGen1 = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const oldTarget = wmGen1.elements.find(e => e.id === 'btn-old');
    expect(oldTarget).toBeDefined();

    // Page Generation 2 renders fresh DOM
    document.body.innerHTML = `<button id="btn-new">New Button</button>`;
    const freshContext: AgentContextPayload = {
      url: 'http://localhost/page2',
      timestamp: Date.now(),
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      detections: [
        {
          id: 'btn-new',
          type: 'button',
          confidence: 1.0,
          bbox: { x: 100, y: 100, width: 100, height: 40 },
          length: 10,
          source: 'dom_attribute',
          selector: '#btn-new',
          is_partially_visible: false,
        },
      ],
      total_elements_scanned: 1,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      screenshot_dimensions: null,
      ocr_metrics: null,
    };

    // Stale action attempting to target old element from gen 1
    const staleAction: BrowserAction = {
      action: 'click',
      target: 'btn-old',
      reason: 'Clicking button from prior page',
    };

    const validation = validateAction(staleAction, freshContext);

    // M5 must reject stale target not present in current page context
    expect(validation.allowed).toBe(false);
    expect(validation.reason).toContain("does not exist in the current sanitized context");
  });

  it('Scenario S: assertWorldModelSafe validates a clean world model without errors', () => {
    document.body.innerHTML = `
      <div id="shop">
        <h1 id="shop-title">Safe Store</h1>
        <button id="shop-btn">Browse Products</button>
      </div>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(() => assertWorldModelSafe(wm)).not.toThrow();

    const summary = createSanitizedWorldModelSummary(wm);
    expect(summary).toBeDefined();
    expect(summary.hasModal).toBe(false);
    expect(summary.elementCount).toBeGreaterThanOrEqual(1);
  });

  it('Scenario T: assertWorldModelSafe throws WorldModelPrivacyViolation if forbidden key is smuggled', () => {
    const maliciousModel: any = {
      page: { title: 'Test' },
      elements: [
        {
          id: 'elem-1',
          type: 'button',
          value: 'RAW_SECRET_PASSWORD_123', // FORBIDDEN KEY
        },
      ],
    };

    expect(() => assertWorldModelSafe(maliciousModel)).toThrow(WorldModelPrivacyViolation);
  });

  it('Scenario T: assertWorldModelSafe throws WorldModelPrivacyViolation if raw credit card is smuggled in label', () => {
    const maliciousModel: any = {
      page: { title: 'Test' },
      elements: [
        {
          id: 'elem-1',
          type: 'button',
          label: 'Card 4111 1111 1111 1111 charged', // Raw Luhn-valid card in label!
        },
      ],
    };

    expect(() => assertWorldModelSafe(maliciousModel)).toThrow(WorldModelPrivacyViolation);
  });

  it('Scenario T: assertWorldModelSafe throws WorldModelPrivacyViolation if raw password pattern is in title', () => {
    const maliciousModel: any = {
      page: { title: 'Test' },
      entities: [
        {
          id: 'ent-1',
          type: 'Product',
          title: 'password: SecretCredential456', // Labelled credential rule!
        },
      ],
    };

    expect(() => assertWorldModelSafe(maliciousModel)).toThrow(WorldModelPrivacyViolation);
  });

  it('Scenario T: createSanitizedWorldModelSummary excludes all raw DOM text and preserves only structural metadata', () => {
    document.body.innerHTML = `
      <div id="card-xyz" class="product-card" data-price="49.99">
        <h3 id="card-title">Wireless Earbuds</h3>
        <button id="card-btn">Buy Now</button>
      </div>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const summary = createSanitizedWorldModelSummary(wm);

    const serialized = JSON.stringify(summary);
    // Invariant checks
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('cvv');
    expect(serialized).not.toContain('token');
    expect(summary.keyEntities.length).toBeGreaterThanOrEqual(1);
    expect(summary.keyEntities[0]?.actionElementId).toBe('card-btn');
  });
});
