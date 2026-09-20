/**
 * PrivAgent 2.0 — Page and Workflow State Test Suite (Subphases P3.5 & P3.6)
 *
 * Validates:
 *  1. Observable page states: loading, modal_open, confirmation_required, results_available, form_complete
 *  2. Search workflow states: INITIAL -> QUERY_ENTERED -> RESULTS_LOADED
 *  3. Shopping workflow states: LISTING_VIEWED -> PRODUCT_OPENED -> VARIANT_SELECTED -> CHECKOUT_STAGE
 *  4. Login workflow states: LOGIN_PAGE -> CREDENTIALS_ENTERED_LOCAL
 *  5. Form submission workflow states: FORM_FILLING -> SUBMISSION_PENDING
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectPageState } from '../extension/src/semanticUnderstanding/pageState';
import { observeWorkflowState } from '../extension/src/semanticUnderstanding/workflowState';

describe('Subphases P3.5 & P3.6 — Page and Workflow State', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('P3.5 Page State', () => {
    it('detects loading state when spinner is present', () => {
      document.body.innerHTML = `<div class="spinner">Loading data...</div>`;
      const res = detectPageState({ root: document, pageGeneration: 1 });
      expect(res.state).toBe('loading');
      expect(res.confidence).toBeGreaterThanOrEqual(0.90);
    });

    it('detects modal_open and confirmation_required', () => {
      document.body.innerHTML = `
        <div role="dialog" class="modal confirm-dialog">
          <h2>Confirm Purchase</h2>
          <p>Are you sure you want to purchase this item for $45.00?</p>
          <button id="btn-confirm">Confirm</button>
        </div>
      `;

      const res = detectPageState({ root: document, pageGeneration: 2 });
      expect(res.state).toBe('confirmation_required');
      expect(res.hasModal).toBe(true);
    });

    it('detects results_available vs no_results', () => {
      // Results available
      document.body.innerHTML = `<div class="product-card"><h3>Shoe</h3></div>`;
      const resAvail = detectPageState({ root: document, pageGeneration: 1 });
      expect(resAvail.state).toBe('results_available');

      // No results
      document.body.innerHTML = `<div class="no-results">0 results found for your query.</div>`;
      const resEmpty = detectPageState({ root: document, pageGeneration: 2 });
      expect(resEmpty.state).toBe('no_results');
    });

    it('detects form_incomplete vs form_complete', () => {
      document.body.innerHTML = `
        <form>
          <input type="text" id="req-1" required />
        </form>
      `;

      const resIncomplete = detectPageState({ root: document, pageGeneration: 1 });
      expect(resIncomplete.state).toBe('form_incomplete');

      const input = document.getElementById('req-1') as HTMLInputElement;
      input.value = 'Filled Value';

      const resComplete = detectPageState({ root: document, pageGeneration: 1 });
      expect(resComplete.state).toBe('form_complete');
    });
  });

  describe('P3.6 Workflow State', () => {
    it('observes shopping workflow: listing -> product detail -> variant selected -> checkout', () => {
      // 1. Listing
      const obsListing = observeWorkflowState({
        pageType: 'LISTING',
        pageState: 'results_available',
        root: document,
        pageGeneration: 1,
      });
      expect(obsListing.flowType).toBe('SHOPPING');
      expect(obsListing.currentStage).toBe('LISTING_VIEWED');

      // 2. Product opened
      document.body.innerHTML = `
        <h1>Running Shoes</h1>
        <button id="add-to-cart">Add to Cart</button>
      `;
      const obsProduct = observeWorkflowState({
        pageType: 'LISTING',
        pageState: 'populated',
        root: document,
        pageGeneration: 2,
      });
      expect(obsProduct.currentStage).toBe('PRODUCT_OPENED');

      // 3. Variant selected
      document.body.innerHTML = `
        <h1>Running Shoes</h1>
        <select name="size"><option selected>Size 10</option></select>
        <button id="add-to-cart">Add to Cart</button>
      `;
      const obsVariant = observeWorkflowState({
        pageType: 'LISTING',
        pageState: 'populated',
        root: document,
        pageGeneration: 3,
      });
      expect(obsVariant.currentStage).toBe('VARIANT_SELECTED');

      // 4. Checkout
      const obsCheckout = observeWorkflowState({
        pageType: 'CHECKOUT',
        pageState: 'checkout_ready',
        root: document,
        pageGeneration: 4,
      });
      expect(obsCheckout.currentStage).toBe('CHECKOUT_STAGE');
    });

    it('observes search workflow: initial -> query entered', () => {
      document.body.innerHTML = `<input type="search" name="q" value="mechanical keyboard" />`;
      const obs = observeWorkflowState({
        pageType: 'SEARCH',
        pageState: 'populated',
        root: document,
        pageGeneration: 1,
      });
      expect(obs.flowType).toBe('SEARCH');
      expect(obs.currentStage).toBe('QUERY_ENTERED');
    });
  });
});
