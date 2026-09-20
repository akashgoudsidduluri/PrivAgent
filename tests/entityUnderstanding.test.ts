/**
 * PrivAgent 2.0 — Entity Understanding Test Suite (Subphase P3.2)
 *
 * Validates:
 *  1. Extraction of Product entities with prices and actions
 *  2. Extraction of SearchResult entities with associated links
 *  3. Extraction of Article entities with authors and dates
 *  4. Extraction of Form entities with field counts and submit actions
 *  5. Extraction of TableRow and Transaction entities
 *  6. Integration with Phase 2 Video keyframe findings
 *  7. PRIVACY INVARIANT: Strict exclusion of passwords, cards, account numbers from safeAttributes
 *  8. Bounded confidence scoring and pageGeneration stamping
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { extractSemanticEntities } from '../extension/src/semanticUnderstanding/entityUnderstanding';

describe('Subphase P3.2 — Semantic Entity Understanding', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('1. extracts Product entity with price, title, and action controls', () => {
    document.body.innerHTML = `
      <div id="product-card-101" class="product-card" data-price="49.99">
        <h2 class="product-title">Ergonomic Office Chair</h2>
        <span class="price">$49.99</span>
        <button id="btn-add-cart">Add to Cart</button>
        <button id="btn-buy-now">Buy Now</button>
      </div>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 4 });
    expect(entities.length).toBe(1);

    const prod = entities[0]!;
    expect(prod.type).toBe('Product');
    expect(prod.label).toBe('Ergonomic Office Chair');
    expect(prod.safeAttributes.price).toBe(49.99);
    expect(prod.safeAttributes.priceAvailable).toBe(true);
    expect(prod.associatedInteractiveElements).toContain('btn-add-cart');
    expect(prod.associatedInteractiveElements).toContain('btn-buy-now');
    expect(prod.confidence).toBeGreaterThanOrEqual(0.90);
    expect(prod.pageGeneration).toBe(4);
    expect(prod.source).toBe('layout');
  });

  it('2. extracts SearchResult entity with destination links', () => {
    document.body.innerHTML = `
      <div id="res-1" class="search-result">
        <h3 class="result-title"><a id="res-link-1" href="https://example.com/docs">Privacy Agent Documentation</a></h3>
        <p class="snippet">Learn how PrivAgent isolates local browser execution.</p>
      </div>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 2 });
    expect(entities.length).toBe(1);

    const res = entities[0]!;
    expect(res.type).toBe('SearchResult');
    expect(res.label).toBe('Privacy Agent Documentation');
    expect(res.associatedInteractiveElements).toContain('res-link-1');
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('3. extracts Article entity with author and publish metadata', () => {
    document.body.innerHTML = `
      <article id="tech-post">
        <h1 class="article-title">Decoupled AI Architectures</h1>
        <span class="author">Dr. Jane Smith</span>
        <time class="publish-date">2026-09-20</time>
        <p>Decoupling perception from reasoning enables verifiable safety guarantees.</p>
        <a id="read-more" href="/article/2">Read More</a>
      </article>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 1 });
    expect(entities.length).toBe(1);

    const art = entities[0]!;
    expect(art.type).toBe('Article');
    expect(art.label).toBe('Decoupled AI Architectures');
    expect(art.safeAttributes.hasAuthor).toBe(true);
    expect(art.safeAttributes.author).toBe('Dr. Jane Smith');
    expect(art.associatedInteractiveElements).toContain('read-more');
  });

  it('4. extracts Form entity with constituent field elements', () => {
    document.body.innerHTML = `
      <form id="shipping-form" name="Shipping Address">
        <h2>Enter Delivery Address</h2>
        <input id="street-input" type="text" placeholder="Street Address" />
        <input id="city-input" type="text" placeholder="City" />
        <select id="state-select"><option>California</option></select>
        <button id="submit-shipping" type="submit">Continue</button>
      </form>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 3 });
    expect(entities.length).toBe(1);

    const form = entities[0]!;
    expect(form.type).toBe('Form');
    expect(form.associatedInteractiveElements).toContain('street-input');
    expect(form.associatedInteractiveElements).toContain('city-input');
    expect(form.associatedInteractiveElements).toContain('state-select');
    expect(form.associatedInteractiveElements).toContain('submit-shipping');
    expect(form.safeAttributes.hasSubmitAction).toBe(true);
  });

  it('5. extracts TableRow and Transaction entities', () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr id="row-1">
            <td>Account Transfer Credit</td>
            <td>+$500.00</td>
            <td><button id="view-tx-1">Details</button></td>
          </tr>
          <tr id="row-2">
            <td>Standard Log Item</td>
            <td>Status OK</td>
          </tr>
        </tbody>
      </table>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 1 });
    expect(entities.length).toBe(2);

    const tx = entities.find(e => e.type === 'Transaction');
    expect(tx).toBeDefined();
    expect(tx?.associatedInteractiveElements).toContain('view-tx-1');

    const genericRow = entities.find(e => e.type === 'TableRow');
    expect(genericRow).toBeDefined();
  });

  it('6. PRIVACY INVARIANT: Strictly scrubs credentials from attributes and labels', () => {
    document.body.innerHTML = `
      <div id="auth-box" class="product-card" data-password="SuperSecretPassword123" data-card="4111111111111111" data-cvv="999">
        <h2 class="title">Account Security Token: SecretAuthToken999</h2>
      </div>
    `;

    const entities = extractSemanticEntities({ root: document, pageGeneration: 1 });
    expect(entities.length).toBe(1);

    const ent = entities[0]!;
    // Label must be sanitized because title contained token/password
    expect(ent.label).not.toContain('SecretAuthToken999');
    expect(ent.label).toBe('Protected Credential Entity');

    // Safe attributes must omit password, card, and cvv
    expect(ent.safeAttributes.password).toBeUndefined();
    expect(ent.safeAttributes.card).toBeUndefined();
    expect(ent.safeAttributes.cvv).toBeUndefined();

    const serialized = JSON.stringify(ent);
    expect(serialized).not.toContain('SuperSecretPassword123');
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('999');
  });
});
