/**
 * PrivAgent 2.0 — Workflow State Observation Engine (P3.6)
 *
 * Observes and describes the current progression within standard web workflows:
 *   - SEARCH:   QUERY_ENTERED -> SEARCH_SUBMITTED -> RESULTS_LOADED -> RESULT_SELECTED
 *   - SHOPPING: LISTING_VIEWED -> PRODUCT_OPENED -> VARIANT_SELECTED -> CART_UPDATED -> CHECKOUT_STAGE
 *   - LOGIN:    LOGIN_PAGE -> CREDENTIALS_ENTERED_LOCAL -> SUBMISSION_PENDING -> AUTHENTICATED
 *   - FORM:     FORM_FILLING -> FORM_SUBMITTED
 *
 * CRITICAL ARCHITECTURAL BOUNDARY:
 *  Workflow state is STRICTLY DESCRIPTIVE observation of the current page.
 *  It does NOT generate speculative multi-step plans or autonomous long-horizon strategies.
 *  Planning belongs to Phase 4.
 */

import { BrowserWorldModel } from '../worldModel/types';
import {
  SemanticPageType,
  SemanticPageState,
  WorkflowFlowType,
  WorkflowObservation,
  WorkflowStage,
} from './semanticTypes';

export interface WorkflowStateOptions {
  pageType: SemanticPageType;
  pageState: SemanticPageState;
  worldModel?: BrowserWorldModel;
  root?: Document | HTMLElement;
  pageGeneration?: number;
}

export function observeWorkflowState(options: WorkflowStateOptions): WorkflowObservation {
  const { pageType, pageState, worldModel: wm } = options;
  const pageGeneration = options.pageGeneration ?? wm?.page?.pageGeneration ?? 1;

  const targetDoc: Document = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document)
      : options.root.ownerDocument || document
    : typeof document !== 'undefined'
    ? document
    : (null as unknown as Document);

  // ──────────────────────────────────────────────────────────────────────────
  // 1. SHOPPING FLOW
  // ──────────────────────────────────────────────────────────────────────────
  if (pageType === 'CHECKOUT') {
    return {
      flowType: 'SHOPPING',
      currentStage: 'CHECKOUT_STAGE',
      confidence: 0.95,
      evidence: ['User has navigated into order review and checkout flow'],
      pageGeneration,
    };
  }

  const hasCartBadge = targetDoc?.querySelector('.cart-count, #cart-qty, [data-cart-items]');
  const isProductDetail = targetDoc?.querySelector('#add-to-cart, .btn-buy-now, [data-action="add-to-cart"]');
  const isListing = pageType === 'LISTING' || (pageState === 'results_available' && !isProductDetail);

  if (isProductDetail) {
    const sizeSelected = targetDoc?.querySelector('select[name="size"], [role="radio"][aria-checked="true"]');
    return {
      flowType: 'SHOPPING',
      currentStage: sizeSelected ? 'VARIANT_SELECTED' : 'PRODUCT_OPENED',
      confidence: 0.93,
      evidence: [sizeSelected ? 'Product item open with specific variant chosen' : 'Individual product detail page open'],
      pageGeneration,
    };
  }

  if (isListing) {
    return {
      flowType: 'SHOPPING',
      currentStage: 'LISTING_VIEWED',
      confidence: 0.90,
      evidence: ['Catalog or search result listing currently viewed'],
      pageGeneration,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. SEARCH FLOW
  // ──────────────────────────────────────────────────────────────────────────
  if (pageType === 'SEARCH') {
    const queryInput = targetDoc?.querySelector<HTMLInputElement>('input[type="search"], input[name="q"]');
    const queryValue = (queryInput?.value || '').trim();

    if (pageState === 'results_available') {
      return {
        flowType: 'SEARCH',
        currentStage: 'RESULTS_LOADED',
        confidence: 0.94,
        evidence: ['Search executed; query results loaded into view'],
        pageGeneration,
      };
    }

    if (queryValue.length > 0) {
      return {
        flowType: 'SEARCH',
        currentStage: 'QUERY_ENTERED',
        confidence: 0.90,
        evidence: [`Query text "${queryValue.slice(0, 30)}" present in search bar`],
        pageGeneration,
      };
    }

    return {
      flowType: 'SEARCH',
      currentStage: 'INITIAL',
      confidence: 0.88,
      evidence: ['Search portal initialized awaiting user query input'],
      pageGeneration,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. LOGIN FLOW
  // ──────────────────────────────────────────────────────────────────────────
  if (pageType === 'LOGIN') {
    const passwordInput = targetDoc?.querySelector<HTMLInputElement>('input[type="password"]');
    const passwordFilled = Boolean(passwordInput && (passwordInput.value || '').length > 0);

    return {
      flowType: 'LOGIN',
      currentStage: passwordFilled ? 'CREDENTIALS_ENTERED_LOCAL' : 'LOGIN_PAGE',
      confidence: 0.95,
      evidence: [passwordFilled ? 'Credentials entered in local protected fields' : 'Authentication page awaiting credential input'],
      pageGeneration,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. FORM FLOW
  // ──────────────────────────────────────────────────────────────────────────
  if (pageType === 'FORM') {
    return {
      flowType: 'FORM_SUBMISSION',
      currentStage: pageState === 'form_complete' ? 'SUBMISSION_PENDING' : 'FORM_FILLING',
      confidence: 0.91,
      evidence: [pageState === 'form_complete' ? 'Form inputs complete; ready to submit' : 'Form fields being populated'],
      pageGeneration,
    };
  }

  return {
    flowType: 'GENERAL_BROWSING',
    currentStage: 'INITIAL',
    confidence: 0.70,
    evidence: ['General web document browsing'],
    pageGeneration,
  };
}
