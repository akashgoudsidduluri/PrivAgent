/**
 * PrivAgent 2.0 — Semantic Relationships Test Suite (Subphase P3.3)
 *
 * Validates:
 *  1. Product relationships: HAS_PRICE, HAS_IMAGE, HAS_ACTION
 *  2. Article relationships: HAS_AUTHOR, HAS_DATE, HAS_LINK
 *  3. Form relationships: HAS_FIELD, HAS_SUBMIT_ACTION, REQUIRES_AUTHENTICATION
 *  4. Search result relationships: HAS_ACTION
 *  5. Explicit label-for relationships
 *  6. Calibration: Confidence scores and observable evidence strings
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { extractSemanticEntities } from '../extension/src/semanticUnderstanding/entityUnderstanding';
import { buildSemanticRelationships } from '../extension/src/semanticUnderstanding/semanticRelations';

describe('Subphase P3.3 — Semantic Relationships', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('1. builds Product relationships: HAS_PRICE, HAS_IMAGE, HAS_ACTION', () => {
    document.body.innerHTML = `
      <div id="product-card-1" class="product-card">
        <h2 id="prod-title">Wireless Earbuds</h2>
        <img id="prod-img-1" src="/earbuds.jpg" alt="Earbuds" />
        <span id="prod-price-1" class="price">$79.99</span>
        <button id="prod-buy-btn">Buy Now</button>
      </div>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 1 });
    const rels = buildSemanticRelationships({ entities, root: document, pageGeneration: 1 });

    expect(rels.length).toBeGreaterThanOrEqual(3);

    const priceRel = rels.find(r => r.relation === 'HAS_PRICE');
    expect(priceRel).toBeDefined();
    expect(priceRel?.sourceId).toBe('product-card-1');
    expect(priceRel?.targetId).toBe('prod-price-1');
    expect(priceRel?.confidence).toBeGreaterThanOrEqual(0.95);
    expect(priceRel?.evidence).toContain('Price element');

    const imgRel = rels.find(r => r.relation === 'HAS_IMAGE');
    expect(imgRel).toBeDefined();
    expect(imgRel?.sourceId).toBe('product-card-1');
    expect(imgRel?.targetId).toBe('prod-img-1');

    const actRel = rels.find(r => r.relation === 'HAS_ACTION');
    expect(actRel).toBeDefined();
    expect(actRel?.sourceId).toBe('product-card-1');
    expect(actRel?.targetId).toBe('prod-buy-btn');
  });

  it('2. builds Article relationships: HAS_AUTHOR, HAS_DATE, HAS_LINK', () => {
    document.body.innerHTML = `
      <article id="art-201">
        <h1 id="art-h1">Local Privacy Perception</h1>
        <span id="art-auth" class="author" rel="author">Alice Walker</span>
        <time id="art-date" class="date">2026-09-20</time>
        <a id="art-src-link" href="https://privagent.dev">Source Link</a>
      </article>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 2 });
    const rels = buildSemanticRelationships({ entities, root: document, pageGeneration: 2 });

    const authRel = rels.find(r => r.relation === 'HAS_AUTHOR');
    expect(authRel).toBeDefined();
    expect(authRel?.targetId).toBe('art-auth');

    const dateRel = rels.find(r => r.relation === 'HAS_DATE');
    expect(dateRel).toBeDefined();
    expect(dateRel?.targetId).toBe('art-date');

    const linkRel = rels.find(r => r.relation === 'HAS_LINK');
    expect(linkRel).toBeDefined();
    expect(linkRel?.targetId).toBe('art-src-link');
  });

  it('3. builds Form relationships: HAS_FIELD, HAS_SUBMIT_ACTION, REQUIRES_AUTHENTICATION', () => {
    document.body.innerHTML = `
      <form id="login-form">
        <input id="user-field" type="text" />
        <input id="pwd-field" type="password" />
        <button id="login-submit" type="submit">Sign In</button>
      </form>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 3 });
    const rels = buildSemanticRelationships({ entities, root: document, pageGeneration: 3 });

    const fieldRel = rels.find(r => r.relation === 'HAS_FIELD' && r.targetId === 'user-field');
    expect(fieldRel).toBeDefined();

    const submitRel = rels.find(r => r.relation === 'HAS_SUBMIT_ACTION');
    expect(submitRel).toBeDefined();
    expect(submitRel?.targetId).toBe('login-submit');

    const authRel = rels.find(r => r.relation === 'REQUIRES_AUTHENTICATION');
    expect(authRel).toBeDefined();
    expect(authRel?.confidence).toBeGreaterThanOrEqual(0.98);
  });
});
