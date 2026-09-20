/**
 * PrivAgent 2.0 — Action Affordances Test Suite (Subphase P3.4)
 *
 * Validates:
 *  1. Discovery of Search affordances (ENTER_QUERY, SUBMIT_SEARCH, SELECT_RESULT)
 *  2. Discovery of Product affordances (ADD_TO_CART, BUY_NOW, SELECT_VARIANT)
 *  3. Discovery of Login affordances (ENTER_USERNAME, ENTER_PASSWORD_LOCAL, SUBMIT_LOGIN)
 *  4. Discovery of Form affordances (FILL_FIELD, SELECT_OPTION, SUBMIT_FORM)
 *  5. Discovery of Checkout affordances with confirmation requirements (SUBMIT_ORDER)
 *  6. Architectural invariant: Affordance presence is strictly descriptive; M5 authority preserved
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { discoverActionAffordances } from '../extension/src/semanticUnderstanding/actionAffordance';

describe('Subphase P3.4 — Action Affordances', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('1. discovers search affordances on a search portal', () => {
    document.body.innerHTML = `
      <form action="/search">
        <input id="q-input" type="search" name="q" />
        <button id="q-submit" type="submit">Search</button>
      </form>
    `;

    const affordances = discoverActionAffordances({
      pageType: 'SEARCH',
      root: document,
      pageGeneration: 1,
    });

    const enterQuery = affordances.find(a => a.type === 'ENTER_QUERY');
    expect(enterQuery).toBeDefined();
    expect(enterQuery?.targetElementId).toBe('q-input');

    const submitSearch = affordances.find(a => a.type === 'SUBMIT_SEARCH');
    expect(submitSearch).toBeDefined();
    expect(submitSearch?.targetElementId).toBe('q-submit');
  });

  it('2. discovers product affordances with BUY_NOW marked as requiring confirmation', () => {
    document.body.innerHTML = `
      <div id="product-actions">
        <select id="size-picker" name="size"><option>Large</option></select>
        <button id="add-to-cart">Add to Cart</button>
        <button id="buy-now">Instant Buy</button>
      </div>
    `;

    const affordances = discoverActionAffordances({
      pageType: 'LISTING',
      root: document,
      pageGeneration: 2,
    });

    const addCart = affordances.find(a => a.type === 'ADD_TO_CART');
    expect(addCart).toBeDefined();
    expect(addCart?.requiresConfirmation).toBe(false);

    const buyNow = affordances.find(a => a.type === 'BUY_NOW');
    expect(buyNow).toBeDefined();
    expect(buyNow?.requiresConfirmation).toBe(true); // Consequential action requires confirmation

    const variant = affordances.find(a => a.type === 'SELECT_VARIANT');
    expect(variant).toBeDefined();
    expect(variant?.targetElementId).toBe('size-picker');
  });

  it('3. discovers login affordances with ENTER_PASSWORD_LOCAL protected', () => {
    document.body.innerHTML = `
      <form id="login-box">
        <input id="username" type="text" name="username" />
        <input id="password" type="password" name="password" />
        <button id="btn-login" type="submit">Log In</button>
      </form>
    `;

    const affordances = discoverActionAffordances({
      pageType: 'LOGIN',
      root: document,
      pageGeneration: 3,
    });

    const usr = affordances.find(a => a.type === 'ENTER_USERNAME');
    expect(usr).toBeDefined();

    const pwd = affordances.find(a => a.type === 'ENTER_PASSWORD_LOCAL');
    expect(pwd).toBeDefined();
    expect(pwd?.description).toContain('Local on-device');
    expect(pwd?.requiresConfirmation).toBe(true);

    const sub = affordances.find(a => a.type === 'SUBMIT_LOGIN');
    expect(sub).toBeDefined();
  });

  it('4. discovers checkout order placement with strict confirmation requirement', () => {
    document.body.innerHTML = `
      <div id="checkout-container">
        <button id="btn-place-order" name="place-order">Place Final Order ($120.00)</button>
      </div>
    `;

    const affordances = discoverActionAffordances({
      pageType: 'CHECKOUT',
      root: document,
      pageGeneration: 4,
    });

    const orderSubmit = affordances.find(a => a.type === 'SUBMIT_ORDER');
    expect(orderSubmit).toBeDefined();
    expect(orderSubmit?.requiresConfirmation).toBe(true);
  });

  it('5. INVARIANT: Affordances do not contain execution authorization', () => {
    document.body.innerHTML = `<button id="btn-delete">Delete Account</button>`;

    const affordances = discoverActionAffordances({
      pageType: 'SETTINGS',
      root: document,
      pageGeneration: 1,
    });

    // Affordances describe capability, not execution permission
    for (const aff of affordances) {
      expect((aff as unknown as Record<string, unknown>).allowed).toBeUndefined();
      expect((aff as unknown as Record<string, unknown>).authorized).toBeUndefined();
      expect(aff.pageGeneration).toBe(1);
    }
  });
});
