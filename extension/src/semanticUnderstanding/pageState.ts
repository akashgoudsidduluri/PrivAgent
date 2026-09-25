/**
 * PrivAgent 2.0 — Observable Page State Engine (P3.5)
 *
 * Infers deterministic page state strictly from observable DOM and layout evidence:
 *   loading | loaded | empty | populated | error | modal_open |
 *   login_required | results_available | no_results |
 *   form_incomplete | form_complete | checkout_ready | confirmation_required
 *
 * Invariants:
 *  1. Only uses observable signals; never guesses unobservable server state.
 *  2. Evaluates document readiness, modal overlays, empty state notices, and form completeness.
 *  3. Stamped with monotonic pageGeneration.
 */

import { BrowserWorldModel } from '../worldModel/types';
import { PageStateResult, SemanticPageState } from './semanticTypes';

export interface PageStateOptions {
  worldModel?: BrowserWorldModel;
  root?: Document | HTMLElement;
  pageGeneration?: number;
}

export function detectPageState(options: PageStateOptions = {}): PageStateResult {
  const pageGeneration = options.pageGeneration ?? options.worldModel?.page?.pageGeneration ?? 1;
  const wm = options.worldModel;

  const targetDoc: Document = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document)
      : options.root.ownerDocument || document
    : typeof document !== 'undefined'
    ? document
    : (null as unknown as Document);

  const evidence: string[] = [];

  if (!targetDoc) {
    if (wm) {
      if (wm.page?.hasActiveModal) {
        return {
          state: 'modal_open',
          confidence: 0.90,
          evidence: ['Active modal overlay indicated in BrowserWorldModel'],
          pageGeneration,
          hasModal: true,
        };
      }
      if (wm.page?.pageType === 'results' || wm.entities.some(e => e.type === 'Product' || e.type === 'SearchResult')) {
        return {
          state: 'results_available',
          confidence: 0.88,
          evidence: ['Result candidate entities present in BrowserWorldModel'],
          pageGeneration,
        };
      }
      if (wm.page?.pageType === 'login' || wm.elements.some(e => e.type === 'password')) {
        return {
          state: 'login_required',
          confidence: 0.90,
          evidence: ['Authentication controls present in BrowserWorldModel'],
          pageGeneration,
        };
      }
      return {
        state: wm.elements.length > 0 ? 'populated' : 'loaded',
        confidence: 0.75,
        evidence: [`BrowserWorldModel elements evaluated (count: ${wm.elements.length})`],
        pageGeneration,
      };
    }
    return {
      state: 'loaded',
      confidence: 0.5,
      evidence: ['No active document context available'],
      pageGeneration,
    };
  }

  // 1. Check Loading State
  const isDocumentLoading = targetDoc.readyState === 'loading';
  const hasSpinner = Boolean(targetDoc.querySelector('.spinner, .loading, .loader, [aria-busy="true"]'));
  if (isDocumentLoading || hasSpinner) {
    return {
      state: 'loading',
      confidence: 0.95,
      evidence: [isDocumentLoading ? 'document.readyState is "loading"' : 'Active loading spinner/skeleton present in layout'],
      pageGeneration,
    };
  }

  // 2. Check Modal Overlay
  const hasModal = Boolean(wm?.page?.hasActiveModal || targetDoc.querySelector('[role="dialog"], .modal.show, .modal-open, .overlay[aria-modal="true"]'));
  if (hasModal) {
    // Check if modal is an explicit confirmation modal
    const modalEl = targetDoc.querySelector('[role="dialog"], .modal, .confirm-dialog');
    const isConfirm = modalEl && (
      modalEl.textContent?.toLowerCase().includes('are you sure') ||
      modalEl.textContent?.toLowerCase().includes('confirm purchase') ||
      modalEl.querySelector('#btn-confirm, .btn-confirm')
    );

    if (isConfirm) {
      return {
        state: 'confirmation_required',
        confidence: 0.96,
        evidence: ['Active modal dialog requires user confirmation'],
        pageGeneration,
        hasModal: true,
      };
    }

    return {
      state: 'modal_open',
      confidence: 0.95,
      evidence: ['Active modal overlay dialog visible in viewport'],
      pageGeneration,
      hasModal: true,
    };
  }

  // 3. Check Error State
  const errorEl = targetDoc.querySelector('.error-page, [data-error], .error-message, .alert-danger');
  const bodyText = (targetDoc.body?.textContent || '').toLowerCase();
  if (errorEl || bodyText.includes('404 not found') || bodyText.includes('an unexpected error occurred')) {
    return {
      state: 'error',
      confidence: 0.92,
      evidence: ['Explicit error container or 404 message present'],
      pageGeneration,
    };
  }

  // 4. Check Login Required
  const hasPasswordInput = Boolean(targetDoc.querySelector('input[type="password"]'));
  const loginNotice = bodyText.includes('please log in') || bodyText.includes('sign in to continue');
  if (hasPasswordInput && loginNotice) {
    return {
      state: 'login_required',
      confidence: 0.94,
      evidence: ['Authentication checkpoint required to proceed'],
      pageGeneration,
    };
  }

  // 5. Check No Results vs Results Available
  const noResultsNotice = targetDoc.querySelector('.no-results, .empty-search, [data-empty="true"]');
  if (noResultsNotice || bodyText.includes('0 results found') || bodyText.includes('no products match your search')) {
    return {
      state: 'no_results',
      confidence: 0.95,
      evidence: ['Explicit zero-results container or message in layout'],
      pageGeneration,
    };
  }

  const resultItems = targetDoc.querySelectorAll('.product-card, .search-result, [data-component="result"], .listing-item');
  if (resultItems.length > 0) {
    return {
      state: 'results_available',
      confidence: 0.96,
      evidence: [`${resultItems.length} result item cards visible in current view`],
      pageGeneration,
    };
  }

  // 6. Check Form Completeness
  const forms = Array.from(targetDoc.querySelectorAll<HTMLFormElement>('form'));
  if (forms.length > 0) {
    const requiredInputs = Array.from(targetDoc.querySelectorAll<HTMLInputElement>('form input[required]'));
    if (requiredInputs.length > 0) {
      const allFilled = requiredInputs.every(inp => (inp.value || '').trim().length > 0);
      return {
        state: allFilled ? 'form_complete' : 'form_incomplete',
        confidence: 0.90,
        evidence: [allFilled ? 'All required form inputs filled' : 'Required form inputs remain unfilled'],
        pageGeneration,
        isFormReady: allFilled,
      };
    }
  }

  // 7. Check Checkout Ready
  const checkoutBtn = targetDoc.querySelector('#btn-checkout, #btn-pay, [data-checkout]');
  const cartTotal = targetDoc.querySelector('.cart-total, #order-total, .cart-summary');
  if (checkoutBtn && cartTotal) {
    return {
      state: 'checkout_ready',
      confidence: 0.91,
      evidence: ['Order summary and checkout initiation control ready'],
      pageGeneration,
    };
  }

  // 8. Empty vs Populated
  const childCount = targetDoc.body ? targetDoc.body.querySelectorAll('*').length : 0;
  if (childCount < 5) {
    return {
      state: 'empty',
      confidence: 0.85,
      evidence: ['Minimal DOM tree with fewer than 5 elements'],
      pageGeneration,
    };
  }

  return {
    state: 'populated',
    confidence: 0.88,
    evidence: [`Standard populated page with ${childCount} elements`],
    pageGeneration,
  };
}
