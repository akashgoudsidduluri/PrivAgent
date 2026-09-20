/**
 * PrivAgent 2.0 — Action Affordance Engine (P3.4)
 *
 * Discovers and characterizes observable action affordances on a web page:
 *   - Search:  ENTER_QUERY | SUBMIT_SEARCH | SELECT_RESULT | PAGINATE | SCROLL
 *   - Product: SELECT_VARIANT | ADD_TO_CART | BUY_NOW | NAVIGATE_IMAGES | VIEW_DETAILS
 *   - Login:   ENTER_USERNAME | ENTER_PASSWORD_LOCAL | SUBMIT_LOGIN
 *   - Form:    FILL_FIELD | SELECT_OPTION | SUBMIT_FORM | CANCEL_FORM
 *   - Checkout:REVIEW_ORDER | SELECT_ADDRESS | SELECT_PAYMENT | SUBMIT_ORDER
 *
 * CRITICAL ARCHITECTURAL INVARIANT:
 *  Understanding that an action affordance exists is STRICTLY DESCRIPTIVE.
 *  Affordance discovery does NOT authorize execution.
 *  M5 action validation, credential boundaries, and user confirmation policies
 *  remain sole and authoritative gates before any action is executed.
 */

import { BrowserWorldModel } from '../worldModel/types';
import { ActionAffordance, ActionAffordanceType, SemanticPageType } from './semanticTypes';

export interface ActionAffordanceOptions {
  pageType: SemanticPageType;
  worldModel?: BrowserWorldModel;
  root?: Document | HTMLElement;
  pageGeneration?: number;
}

export function discoverActionAffordances(
  options: ActionAffordanceOptions
): ActionAffordance[] {
  const { pageType, worldModel: wm } = options;
  const pageGeneration = options.pageGeneration ?? wm?.page?.pageGeneration ?? 1;

  const targetDoc: Document = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document)
      : options.root.ownerDocument || document
    : typeof document !== 'undefined'
    ? document
    : (null as unknown as Document);

  const affordances: ActionAffordance[] = [];
  const seenIds = new Set<string>();

  function addAffordance(
    type: ActionAffordanceType,
    targetElementId: string | undefined,
    description: string,
    confidence: number,
    requiresConfirmation: boolean = false
  ) {
    const key = `${type}::${targetElementId || 'page'}`;
    if (seenIds.has(key)) return;
    seenIds.add(key);

    affordances.push({
      id: `affordance-${type.toLowerCase()}-${affordances.length + 1}`,
      type,
      targetElementId,
      confidence: Math.min(0.99, Math.round(confidence * 100) / 100),
      description,
      requiresConfirmation,
      pageGeneration,
      source: 'layout',
    });
  }

  if (!targetDoc) return affordances;

  // ──────────────────────────────────────────────────────────────────────────
  // 1. SEARCH AFFORDANCES
  // ──────────────────────────────────────────────────────────────────────────
  const searchInputs = Array.from(targetDoc.querySelectorAll<HTMLInputElement>('input[type="search"], input[name="q"], input[name="query"], [role="search"] input'));
  searchInputs.forEach(inp => {
    addAffordance(
      'ENTER_QUERY',
      inp.id || 'search-input',
      'Input search keyword query into query bar',
      0.95
    );
  });

  const searchSubmitButtons = Array.from(targetDoc.querySelectorAll<HTMLElement>('form[action*="search" i] button[type="submit"], [role="search"] button, button[id*="search" i]'));
  searchSubmitButtons.forEach(btn => {
    addAffordance(
      'SUBMIT_SEARCH',
      btn.id || 'search-submit-btn',
      'Execute and submit search query to retrieve results',
      0.95
    );
  });

  const resultLinks = Array.from(targetDoc.querySelectorAll<HTMLAnchorElement>('.search-result a[href], div.g a[href]'));
  resultLinks.slice(0, 5).forEach((link, idx) => {
    addAffordance(
      'SELECT_RESULT',
      link.id || `result-link-${idx + 1}`,
      `Navigate to search result candidate #${idx + 1}`,
      0.90
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. PRODUCT AFFORDANCES
  // ──────────────────────────────────────────────────────────────────────────
  const allButtons = Array.from(targetDoc.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"], input[type="button"]'));
  const addToCartButtons = Array.from(targetDoc.querySelectorAll<HTMLElement>('#add-to-cart, .btn-add-cart, button[name*="add-to-cart" i], [data-action="add-to-cart"]'));
  for (const b of allButtons) {
    const text = (b.textContent || '').toLowerCase();
    if ((text.includes('add to cart') || text.includes('add to bag')) && !addToCartButtons.includes(b)) {
      addToCartButtons.push(b);
    }
  }

  addToCartButtons.forEach(btn => {
    addAffordance(
      'ADD_TO_CART',
      btn.id || 'add-to-cart-btn',
      'Add currently configured product item to shopping cart',
      0.96,
      false // Routine action
    );
  });

  const buyNowButtons = Array.from(targetDoc.querySelectorAll<HTMLElement>('#buy-now, .btn-buy-now, button[name*="buy-now" i], [data-action="buy-now"]'));
  for (const b of allButtons) {
    const text = (b.textContent || '').toLowerCase();
    if ((text.includes('buy now') || text.includes('instant buy') || text.includes('direct checkout')) && !buyNowButtons.includes(b)) {
      buyNowButtons.push(b);
    }
  }

  buyNowButtons.forEach(btn => {
    addAffordance(
      'BUY_NOW',
      btn.id || 'buy-now-btn',
      'Initiate immediate express purchase checkout flow',
      0.94,
      true // Consequential purchase action requires confirmation
    );
  });

  const variantSelectors = Array.from(targetDoc.querySelectorAll<HTMLElement>('select[name*="size" i], select[name*="color" i], .variant-picker button, [role="radiogroup"] [role="radio"]'));
  variantSelectors.forEach(sel => {
    addAffordance(
      'SELECT_VARIANT',
      sel.id || 'variant-selector',
      'Select product variant options (size, color, style)',
      0.92
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. LOGIN AFFORDANCES
  // ──────────────────────────────────────────────────────────────────────────
  const usernameInputs = Array.from(targetDoc.querySelectorAll<HTMLInputElement>('input[type="text"][name*="user" i], input[type="email"], #username, #email'));
  usernameInputs.forEach(inp => {
    addAffordance(
      'ENTER_USERNAME',
      inp.id || 'username-field',
      'Fill in user account identifier / email',
      0.95
    );
  });

  const passwordInputs = Array.from(targetDoc.querySelectorAll<HTMLInputElement>('input[type="password"]'));
  passwordInputs.forEach(inp => {
    addAffordance(
      'ENTER_PASSWORD_LOCAL',
      inp.id || 'password-field',
      'Local on-device credential entry (never forwarded to remote reasoner)',
      0.98,
      true // Credential entry requires local protection
    );
  });

  const loginSubmitButtons = Array.from(targetDoc.querySelectorAll<HTMLElement>('#btn-login, #btn-signin, button[type="submit"]'));
  if (passwordInputs.length > 0) {
    loginSubmitButtons.forEach(btn => {
      addAffordance(
        'SUBMIT_LOGIN',
        btn.id || 'login-submit-btn',
        'Submit authentication credentials to session endpoint',
        0.95,
        false
      );
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. FORM AFFORDANCES
  // ──────────────────────────────────────────────────────────────────────────
  const formFields = Array.from(targetDoc.querySelectorAll<HTMLElement>('form input:not([type="hidden"]):not([type="password"]), form select, form textarea'));
  if (passwordInputs.length === 0) {
    formFields.slice(0, 8).forEach(f => {
      const tag = f.tagName.toLowerCase();
      if (tag === 'select') {
        addAffordance(
          'SELECT_OPTION',
          f.id || 'select-field',
          'Choose an option from dropdown selection',
          0.90
        );
      } else {
        addAffordance(
          'FILL_FIELD',
          f.id || 'input-field',
          'Enter text data into form input field',
          0.90
        );
      }
    });

    const formSubmits = Array.from(targetDoc.querySelectorAll<HTMLElement>('form button[type="submit"], form input[type="submit"]'));
    formSubmits.forEach(btn => {
      addAffordance(
        'SUBMIT_FORM',
        btn.id || 'form-submit-btn',
        'Submit completed form information to server',
        0.94
      );
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. CHECKOUT AFFORDANCES
  // ──────────────────────────────────────────────────────────────────────────
  const checkoutSubmits = Array.from(targetDoc.querySelectorAll<HTMLElement>('#btn-pay, #btn-place-order, button[name*="place-order" i]'));
  checkoutSubmits.forEach(btn => {
    addAffordance(
      'SUBMIT_ORDER',
      btn.id || 'place-order-btn',
      'Consequential order placement and financial transaction submission',
      0.97,
      true // Consequential financial action: ALWAYS requires confirmation
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. GENERAL BROWSING (Scroll, Pagination)
  // ──────────────────────────────────────────────────────────────────────────
  const paginationLinks = Array.from(targetDoc.querySelectorAll<HTMLElement>('.pagination a, [aria-label*="next page" i], #next-page'));
  paginationLinks.forEach(pg => {
    addAffordance(
      'PAGINATE',
      pg.id || 'next-page-link',
      'Navigate to subsequent page of catalog results',
      0.88
    );
  });

  addAffordance(
    'SCROLL',
    undefined,
    'Scroll viewport downward to inspect additional lazy-loaded content',
    0.80
  );

  return affordances;
}
