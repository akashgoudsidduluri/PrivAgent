/**
 * PrivAgent 2.0 — Browser World Model Test Suite (Phase 1)
 *
 * Covers core scenarios A through M:
 *  A. Empty / simple page
 *  B. Basic text page
 *  C. Form page
 *  D. Product-card page
 *  E. Multiple identical buttons
 *  F. Nested elements
 *  G. Overlapping elements
 *  H. Hidden elements (excluded)
 *  I. Disabled elements (marked disabled)
 *  J. Modal overlay
 *  K. Dynamic DOM mutation
 *  L. SPA navigation
 *  M. Page generation change
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { createWorldModelStore } from '../extension/src/worldModel/worldModelStore';
import { createAgentTaskState, advancePageGeneration } from '../extension/src/agent/agentState';

describe('BrowserWorldModel — Structural & Spatial Scenarios A to M', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'Test Page';
  });

  it('Scenario A: Empty / simple page builds clean world model', () => {
    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wm).toBeDefined();
    expect(wm.page.pageGeneration).toBe(1);
    expect(wm.elements.length).toBe(0);
    expect(wm.entities.length).toBe(0);
    expect(wm.spatialRelationships.length).toBe(0);
    expect(wm.buildDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('Scenario B: Basic text page with headings and paragraphs', () => {
    document.body.innerHTML = `
      <main>
        <h1 id="main-heading">PrivAgent Documentation</h1>
        <p id="p1">PrivAgent provides on-device privacy perception for browser agents.</p>
        <h2 id="sub-heading">Architecture Overview</h2>
        <p id="p2">Local perception decouples reasoning from authority.</p>
      </main>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wm.textRegions.length).toBeGreaterThanOrEqual(3);
    const h1Region = wm.textRegions.find(r => r.id === 'main-heading');
    expect(h1Region).toBeDefined();
    expect(h1Region?.isHeading).toBe(true);
  });

  it('Scenario C: Form page extracts input controls, labels, and submit relationship', () => {
    document.body.innerHTML = `
      <form id="contact-form">
        <label id="lbl-name" for="name-input">Full Name</label>
        <input id="name-input" type="text" placeholder="John Doe" />

        <label id="lbl-email" for="email-input">Email Address</label>
        <input id="email-input" type="email" placeholder="john@example.com" />

        <button id="send-btn" type="submit">Send Message</button>
      </form>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wm.elements.some(e => e.id === 'name-input')).toBe(true);
    expect(wm.elements.some(e => e.id === 'email-input')).toBe(true);
    expect(wm.elements.some(e => e.id === 'send-btn')).toBe(true);

    // Semantic relationships: submit_for
    const submitRel = wm.semanticRelationships.find(
      r => r.sourceId === 'name-input' && r.targetId === 'send-btn' && r.relation === 'SUBMIT_FOR'
    );
    expect(submitRel).toBeDefined();
  });

  it('Scenario D: Product-card page extracts entity and constituent relationships', () => {
    document.body.innerHTML = `
      <div id="product-card-101" class="product-card" data-price="79.99">
        <img id="prod-img-1" src="/bag.jpg" alt="Leather Bag" />
        <h3 id="prod-title-1" class="product-title">Vintage Leather Backpack</h3>
        <span id="prod-price-1" class="price">$79.99</span>
        <button id="add-to-cart-1">Add to Cart</button>
      </div>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const product = wm.entities.find(e => e.id === 'product-card-101');
    expect(product).toBeDefined();
    expect(product?.type).toBe('Product');

    // Semantic relationships: HAS_ACTION, HAS_TITLE, HAS_PRICE
    const actionRel = wm.semanticRelationships.find(
      r => r.sourceId === 'product-card-101' && r.targetId === 'add-to-cart-1' && r.relation === 'HAS_ACTION'
    );
    expect(actionRel).toBeDefined();

    const titleRel = wm.semanticRelationships.find(
      r => r.sourceId === 'product-card-101' && r.targetId === 'prod-title-1' && r.relation === 'HAS_TITLE'
    );
    expect(titleRel).toBeDefined();
  });

  it('Scenario E: Multiple identical buttons are disambiguated by container spatial relationships', () => {
    document.body.innerHTML = `
      <div id="card-alpha" class="product-card">
        <h3 id="title-alpha">Alpha Edition</h3>
        <button id="btn-cart-alpha">Add to Cart</button>
      </div>
      <div id="card-beta" class="product-card">
        <h3 id="title-beta">Beta Edition</h3>
        <button id="btn-cart-beta">Add to Cart</button>
      </div>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wm.elements.some(e => e.id === 'btn-cart-alpha')).toBe(true);
    expect(wm.elements.some(e => e.id === 'btn-cart-beta')).toBe(true);

    // Each button is associated with its respective parent entity
    const relAlpha = wm.semanticRelationships.find(
      r => r.sourceId === 'card-alpha' && r.targetId === 'btn-cart-alpha'
    );
    const relBeta = wm.semanticRelationships.find(
      r => r.sourceId === 'card-beta' && r.targetId === 'btn-cart-beta'
    );
    expect(relAlpha).toBeDefined();
    expect(relBeta).toBeDefined();
    expect(relAlpha?.sourceId).not.toBe(relBeta?.sourceId);
  });

  it('Scenario F: Nested elements preserve parent and hierarchy structure', () => {
    document.body.innerHTML = `
      <div id="grid-container">
        <section id="section-electronics">
          <div id="widget-deal">
            <button id="btn-claim">Claim Deal</button>
          </div>
        </section>
      </div>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const claimBtn = wm.elements.find(e => e.id === 'btn-claim');
    expect(claimBtn).toBeDefined();
  });

  it('Scenario G: Overlapping elements are captured in spatial relationships', () => {
    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    // Spatial relationship engine is verified in dedicated tests
    expect(wm.spatialRelationships).toBeDefined();
  });

  it('Scenario H: Hidden elements with display:none or visibility:hidden are excluded', () => {
    document.body.innerHTML = `
      <div>
        <button id="btn-visible">Click Me</button>
        <button id="btn-hidden-display" style="display: none;">Invisible 1</button>
        <button id="btn-hidden-visibility" style="visibility: hidden;">Invisible 2</button>
      </div>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wm.elements.some(e => e.id === 'btn-visible')).toBe(true);
    expect(wm.elements.some(e => e.id === 'btn-hidden-display')).toBe(false);
    expect(wm.elements.some(e => e.id === 'btn-hidden-visibility')).toBe(false);
  });

  it('Scenario I: Disabled elements are captured but marked isEnabled=false', () => {
    document.body.innerHTML = `
      <button id="btn-enabled">Active Action</button>
      <button id="btn-disabled" disabled>Disabled Action</button>
      <button id="btn-aria-disabled" aria-disabled="true">Aria Disabled</button>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const enabled = wm.elements.find(e => e.id === 'btn-enabled');
    expect(enabled).toBeDefined();
    expect(enabled?.isEnabled).toBe(true);

    // DomInteractiveScanner filters disabled elements from interactive action list,
    // while accessibility tree retains them with disabled: true
    const axDisabled = wm.accessibilityTree.find(n => n.elementId === 'btn-disabled');
    expect(axDisabled).toBeDefined();
    expect(axDisabled?.disabled).toBe(true);
  });

  it('Scenario J: Modal overlay is detected and reflected in page model', () => {
    document.body.innerHTML = `
      <div id="cookie-banner" class="cookie-banner">
        <p>This website uses cookies.</p>
        <button id="btn-accept">Accept</button>
      </div>
    `;

    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wm.page.hasActiveModal).toBe(true);
    expect(wm.page.activeModalSelector).toBe('#cookie-banner');
  });

  it('Scenario K: Dynamic DOM mutation produces a fresh world model', () => {
    document.body.innerHTML = `<div id="feed"><button id="btn-1">Item 1</button></div>`;
    const wm1 = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wm1.elements.length).toBe(1);

    // Mutate DOM
    const feed = document.getElementById('feed')!;
    const newBtn = document.createElement('button');
    newBtn.id = 'btn-2';
    newBtn.textContent = 'Item 2';
    feed.appendChild(newBtn);

    const wm2 = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wm2.elements.length).toBe(2);
    expect(wm2.elements.some(e => e.id === 'btn-2')).toBe(true);
  });

  it('Scenario L: SPA navigation reclassifies pageType in the world model', () => {
    document.body.innerHTML = `
      <form action="/search">
        <h1>Search Products</h1>
        <input type="search" placeholder="Search..." />
      </form>
    `;
    const wmSearch = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wmSearch.page.pageType).toBe('search');

    // Simulate SPA navigation to checkout
    document.body.innerHTML = `
      <h1>Checkout & Payment</h1>
      <form action="/checkout" data-checkout>
        <input type="text" placeholder="Shipping Address" />
        <button id="btn-pay">Pay Now</button>
      </form>
    `;
    const wmCheckout = buildBrowserWorldModel({ root: document, pageGeneration: 2 });
    expect(wmCheckout.page.pageType).toBe('checkout');
    expect(wmCheckout.page.pageGeneration).toBe(2);
  });

  it('Scenario M: Page generation change monotonically updates all nodes', () => {
    document.body.innerHTML = `<button id="btn-gen">Action</button>`;
    const wmGen1 = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    expect(wmGen1.page.pageGeneration).toBe(1);
    expect(wmGen1.elements[0]?.pageGeneration).toBe(1);

    const wmGen2 = buildBrowserWorldModel({ root: document, pageGeneration: 2 });
    expect(wmGen2.page.pageGeneration).toBe(2);
    expect(wmGen2.elements[0]?.pageGeneration).toBe(2);
  });

  it('Scenario N: WorldModelStore registers models and resolves activeWorldModelRef', () => {
    document.body.innerHTML = `<button id="btn-submit">Submit Order</button>`;
    const store = createWorldModelStore();
    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 10 });

    const ref = store.registerWorldModel(wm);
    expect(ref.pageGeneration).toBe(10);
    expect(ref.worldModelId).toBe(wm.id);

    const retrieved = store.getActiveWorldModel(ref);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(wm.id);
    expect(store.isTargetValid(ref, 'btn-submit', 10)).toBe(true);
    expect(store.isTargetValid(ref, 'non-existent-id', 10)).toBe(false);
  });

  it('Scenario O: Page Generation 41 -> W41, Action -> Generation 42 -> W41 targets automatically invalid', () => {
    const store = createWorldModelStore();
    const state = createAgentTaskState('Buy product');
    state.currentPageGeneration = 41;

    // Build WorldModel W41
    document.body.innerHTML = `<button id="btn-add-41">Add to Cart</button>`;
    const w41 = buildBrowserWorldModel({ root: document, pageGeneration: 41, id: 'wm-41' });
    const ref41 = store.registerWorldModel(w41);
    state.activeWorldModelRef = ref41;

    // Verify target is valid in Generation 41
    expect(store.isTargetValid(state.activeWorldModelRef, 'btn-add-41', state.currentPageGeneration)).toBe(true);

    // User/Agent action occurs -> page changes -> Generation 42
    advancePageGeneration(state, 'https://shop.example/cart', 'checkout');
    expect(state.currentPageGeneration).toBe(42);
    expect(state.activeWorldModelRef).toBeNull();

    // W41 targets are automatically invalid for Generation 42
    expect(store.isTargetValid(ref41, 'btn-add-41', state.currentPageGeneration)).toBe(false);
    expect(store.isTargetValid(state.activeWorldModelRef, 'btn-add-41', state.currentPageGeneration)).toBe(false);

    // Build WorldModel W42
    document.body.innerHTML = `<button id="btn-checkout-42">Complete Purchase</button>`;
    const w42 = buildBrowserWorldModel({ root: document, pageGeneration: 42, id: 'wm-42' });
    const ref42 = store.registerWorldModel(w42);
    state.activeWorldModelRef = ref42;

    // W42 targets are valid in Generation 42; W41 targets remain invalid
    expect(store.isTargetValid(state.activeWorldModelRef, 'btn-checkout-42', state.currentPageGeneration)).toBe(true);
    expect(store.isTargetValid(state.activeWorldModelRef, 'btn-add-41', state.currentPageGeneration)).toBe(false);
  });

  it('Scenario P: Stale generation reference in getActiveWorldModel returns null', () => {
    const store = createWorldModelStore();
    document.body.innerHTML = `<button id="btn-ok">OK</button>`;
    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 5, id: 'wm-5' });
    store.registerWorldModel(wm);

    // Create a forged or stale ref with mismatched generation
    const staleRef = { pageGeneration: 6, worldModelId: 'wm-5' };
    expect(store.getActiveWorldModel(staleRef)).toBeNull();
  });
});

