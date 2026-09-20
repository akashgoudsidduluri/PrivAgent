/**
 * PrivAgent 2.0 — Page Semantic Classifier Test Suite (Subphase P3.1)
 *
 * Validates:
 *  1. Search page classification
 *  2. Login page classification
 *  3. Product listing classification
 *  4. Article classification
 *  5. Generic form classification
 *  6. Checkout classification
 *  7. Settings classification
 *  8. Dashboard classification
 *  9. Error page classification
 *  10. Unknown page (fallback when signals < 0.50)
 *  11. Multi-signal rule: Rejects classification based on URL alone
 *  12. Correct pageGeneration stamping and evidence trails
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classifyPageSemantics } from '../extension/src/semanticUnderstanding/pageClassifier';

describe('Subphase P3.1 — Semantic Page Classification', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'Test Page';
  });

  it('1. classifies SEARCH page using query inputs and search roles', () => {
    document.body.innerHTML = `
      <header>
        <div role="search">
          <input type="search" name="q" placeholder="Search products..." />
          <button type="submit">Search</button>
        </div>
      </header>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 3 });
    expect(res.pageType).toBe('SEARCH');
    expect(res.confidence).toBeGreaterThanOrEqual(0.65);
    expect(res.pageGeneration).toBe(3);
    expect(res.evidence.some(e => e.includes('search input') || e.includes('role="search"'))).toBe(true);
  });

  it('2. classifies LOGIN page using password input and authentication buttons', () => {
    document.body.innerHTML = `
      <main>
        <h1>Sign In to Your Account</h1>
        <form action="/auth/login" method="POST">
          <label for="usr">Username</label>
          <input id="usr" type="text" />
          <label for="pwd">Password</label>
          <input id="pwd" type="password" />
          <button id="btn-login" type="submit">Log In</button>
        </form>
      </main>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 1 });
    expect(res.pageType).toBe('LOGIN');
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
    expect(res.evidence.some(e => e.includes('password'))).toBe(true);
  });

  it('3. classifies LISTING page from multiple product/result cards', () => {
    document.body.innerHTML = `
      <main>
        <h1>Product Results</h1>
        <div class="product-card" id="card-1"><h3>Item 1</h3><span>$10</span></div>
        <div class="product-card" id="card-2"><h3>Item 2</h3><span>$20</span></div>
        <div class="product-card" id="card-3"><h3>Item 3</h3><span>$30</span></div>
      </main>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 2 });
    expect(res.pageType).toBe('LISTING');
    expect(res.confidence).toBeGreaterThanOrEqual(0.80);
    expect(res.evidence.some(e => e.includes('repeatable item cards'))).toBe(true);
  });

  it('4. classifies ARTICLE page from semantic article tags and long paragraphs', () => {
    document.body.innerHTML = `
      <article>
        <h1>Understanding Multimodal Privacy in Browser Agents</h1>
        <p>PrivAgent introduces an on-device privacy firewall for browser agents operating in hostile web environments.</p>
        <p>By decoupling perception from execution, credentials never cross the network boundary to external models.</p>
        <p>Local computer vision heuristics accurately detect buttons, images, and layout hierarchies deterministically.</p>
      </article>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 4 });
    expect(res.pageType).toBe('ARTICLE');
    expect(res.confidence).toBeGreaterThanOrEqual(0.70);
  });

  it('5. classifies FORM page from multi-input controls and submit target', () => {
    document.body.innerHTML = `
      <form id="contact-form">
        <label>First Name <input type="text" id="fn" /></label>
        <label>Last Name <input type="text" id="ln" /></label>
        <label>Email <input type="email" id="em" /></label>
        <label>Department
          <select id="dept">
            <option>Sales</option>
            <option>Support</option>
          </select>
        </label>
        <button type="submit">Send Inquiry</button>
      </form>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 1 });
    expect(res.pageType).toBe('FORM');
    expect(res.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('6. classifies CHECKOUT page from order summary and payment controls', () => {
    document.body.innerHTML = `
      <main>
        <h1>Your Cart Checkout</h1>
        <div class="cart-summary">
          <span>Subtotal: $54.00</span>
          <span>Shipping: $5.00</span>
        </div>
        <button id="btn-pay">Proceed to Payment</button>
      </main>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 6 });
    expect(res.pageType).toBe('CHECKOUT');
    expect(res.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('7. classifies SETTINGS page from settings panel and preferences headings', () => {
    document.body.innerHTML = `
      <div class="settings-panel">
        <h1>Account Settings & Preferences</h1>
        <input type="checkbox" id="dark-mode" />
        <input type="checkbox" id="notifications" />
      </div>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 1 });
    expect(res.pageType).toBe('SETTINGS');
    expect(res.confidence).toBeGreaterThanOrEqual(0.70);
  });

  it('8. classifies DASHBOARD page from tabular data grids', () => {
    document.body.innerHTML = `
      <main>
        <h1>System Metrics & Analytics Overview</h1>
        <table>
          <tbody>
            <tr><td>Metric A</td><td>100ms</td></tr>
            <tr><td>Metric B</td><td>200ms</td></tr>
            <tr><td>Metric C</td><td>300ms</td></tr>
            <tr><td>Metric D</td><td>400ms</td></tr>
          </tbody>
        </table>
      </main>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 1 });
    expect(res.pageType).toBe('DASHBOARD');
    expect(res.confidence).toBeGreaterThanOrEqual(0.70);
  });

  it('9. classifies ERROR page from error containers and 404 headers', () => {
    document.body.innerHTML = `
      <div class="error-page">
        <h1>404 Not Found</h1>
        <p>The requested page does not exist on this server.</p>
      </div>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 1 });
    expect(res.pageType).toBe('ERROR');
    expect(res.confidence).toBeGreaterThanOrEqual(0.80);
  });

  it('10. outputs UNKNOWN when page has insufficient evidence', () => {
    document.body.innerHTML = `
      <div><span>Hello world</span></div>
    `;

    const res = classifyPageSemantics({ root: document, pageGeneration: 5 });
    expect(res.pageType).toBe('UNKNOWN');
    expect(res.confidence).toBeLessThan(0.50);
    expect(res.evidence.length).toBeGreaterThan(0);
  });

  it('11. INVARIANT: Does NOT classify based on URL alone', () => {
    // Empty body, only URL suggests checkout
    document.body.innerHTML = `<div>Welcome</div>`;

    const mockWorldModel = {
      id: 'wm-test',
      page: {
        url: 'https://shop.example.com/checkout/step2',
        origin: 'https://shop.example.com',
        title: 'Welcome',
        pageType: 'unknown',
        pageGeneration: 1,
        isReady: true,
        hasActiveModal: false,
        totalDomElements: 2,
        isLargeDom: false,
        timestamp: Date.now(),
      },
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
      elements: [],
      accessibilityTree: [],
      entities: [],
      spatialRelationships: [],
      semanticRelationships: [],
      textRegions: [],
      ocrRegions: [],
      visualRegions: [],
      imageFindings: [],
      canvasFindings: [],
      videoFindings: [],
      interactiveCandidates: [],
      privacyFindings: [],
      buildDurationMs: 5,
    };

    const res = classifyPageSemantics({ worldModel: mockWorldModel, root: document, pageGeneration: 1 });
    // Since DOM has zero checkout elements, URL alone is NOT sufficient -> UNKNOWN
    expect(res.pageType).toBe('UNKNOWN');
  });
});
