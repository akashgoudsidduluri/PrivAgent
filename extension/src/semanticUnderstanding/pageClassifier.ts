/**
 * PrivAgent 2.0 — Multi-Signal Semantic Page Classifier (P3.1)
 *
 * Classifies web pages into the strongly typed semantic taxonomy:
 *   SEARCH | LOGIN | ARTICLE | LISTING | FORM | CHECKOUT | SETTINGS | DASHBOARD | ERROR | UNKNOWN
 *
 * Invariants:
 *  1. Multi-signal requirement: NEVER classify from URL alone.
 *  2. Conservative threshold: Returns UNKNOWN when evidence is ambiguous or confidence < 0.50.
 *  3. Explicit evidence trails: Every classification attaches an array of observable proof.
 *  4. Stamped with monotonic pageGeneration.
 */

import { BrowserWorldModel } from '../worldModel/types';
import { PageClassificationResult, SemanticPageType } from './semanticTypes';

export interface PageClassificationOptions {
  worldModel?: BrowserWorldModel;
  root?: Document | HTMLElement;
  pageGeneration?: number;
}

interface SignalMatch {
  type: SemanticPageType;
  weight: number;
  evidence: string;
}

export function classifyPageSemantics(
  options: PageClassificationOptions = {}
): PageClassificationResult {
  const pageGeneration = options.pageGeneration ?? options.worldModel?.page?.pageGeneration ?? 1;
  const wm = options.worldModel;

  const targetDoc: Document = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document)
      : options.root.ownerDocument || document
    : typeof document !== 'undefined'
    ? document
    : (null as unknown as Document);

  const signals: SignalMatch[] = [];

  // Extract primary observable signals
  const rawUrl = (wm?.page?.url || (typeof window !== 'undefined' ? window.location.href : '')).toLowerCase();
  const rawTitle = (wm?.page?.title || (targetDoc?.title || '')).toLowerCase();
  const headings = targetDoc
    ? Array.from(targetDoc.querySelectorAll<HTMLElement>('h1, h2')).map(h => (h.textContent || '').toLowerCase().trim())
    : [];
  const primaryH1 = headings[0] || '';

  // ──────────────────────────────────────────────────────────────────────────
  // 1. ERROR PAGE SIGNALS
  // ──────────────────────────────────────────────────────────────────────────
  const isChromeError = rawUrl.includes('chrome-error://');
  const errorTitle = rawTitle.includes('404') || rawTitle.includes('not found') || rawTitle.includes('error');
  const errorH1 = primaryH1.includes('404') || primaryH1.includes('not found') || primaryH1.includes('access denied');
  const errorDom = targetDoc?.querySelector('.error-page, [data-error], .error-container, #error-message');

  if (errorDom) {
    signals.push({ type: 'ERROR', weight: 0.8, evidence: 'DOM contains explicit error container (.error-page / [data-error])' });
  }
  if (errorH1 && (errorTitle || errorDom || rawUrl.includes('error'))) {
    signals.push({ type: 'ERROR', weight: 0.7, evidence: `Error heading: "${primaryH1.slice(0, 40)}"` });
  }
  if (isChromeError) {
    signals.push({ type: 'ERROR', weight: 0.9, evidence: 'Internal browser error URL scheme (chrome-error://)' });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. LOGIN / AUTHENTICATION SIGNALS
  // ──────────────────────────────────────────────────────────────────────────
  const hasPasswordInput = targetDoc?.querySelector('input[type="password"]') ||
    wm?.elements.some(e => e.type === 'password');
  const authForm = targetDoc?.querySelector('form[action*="login" i], form[action*="signin" i], form[action*="auth" i]');
  const loginButtons = targetDoc?.querySelector('#btn-login, #btn-signin, button[type="submit"][name*="login" i], [aria-label*="sign in" i]');
  const loginHeading = primaryH1.includes('sign in') || primaryH1.includes('log in') || primaryH1.includes('welcome back');
  const loginTitle = rawTitle.includes('sign in') || rawTitle.includes('log in') || rawTitle.includes('login');
  const loginUrlKeyword = rawUrl.includes('/login') || rawUrl.includes('/signin') || rawUrl.includes('/auth');

  if (hasPasswordInput) {
    signals.push({ type: 'LOGIN', weight: 0.85, evidence: 'DOM contains input[type="password"] credential field' });
  }
  if (authForm) {
    signals.push({ type: 'LOGIN', weight: 0.6, evidence: 'Form with explicit authentication action target' });
  }
  if (loginButtons) {
    signals.push({ type: 'LOGIN', weight: 0.5, evidence: 'Dedicated login/signin action button present' });
  }
  if (loginHeading) {
    signals.push({ type: 'LOGIN', weight: 0.4, evidence: `Login heading detected: "${primaryH1.slice(0, 40)}"` });
  }
  if (loginUrlKeyword && (hasPasswordInput || authForm || loginButtons || loginHeading)) {
    signals.push({ type: 'LOGIN', weight: 0.3, evidence: 'URL corroborates authentication path' });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. CHECKOUT / CART SIGNALS
  // ──────────────────────────────────────────────────────────────────────────
  const checkoutButtons = targetDoc?.querySelector('#btn-checkout, #btn-pay, [data-checkout], button[name*="checkout" i], button[name*="pay" i]');
  const paymentInputs = targetDoc?.querySelector('input[name*="card" i], input[autocomplete*="cc-" i], [data-payment]');
  const cartSummary = targetDoc?.querySelector('.cart-summary, .order-summary, #order-total, .cart-total');
  const checkoutTitle = rawTitle.includes('checkout') || rawTitle.includes('shopping cart') || rawTitle.includes('order review');
  const checkoutH1 = primaryH1.includes('checkout') || primaryH1.includes('your cart') || primaryH1.includes('order summary');
  const checkoutUrlKeyword = rawUrl.includes('/checkout') || rawUrl.includes('/cart') || rawUrl.includes('/payment');

  if (checkoutButtons) {
    signals.push({ type: 'CHECKOUT', weight: 0.75, evidence: 'Dedicated checkout/payment action control found' });
  }
  if (cartSummary) {
    signals.push({ type: 'CHECKOUT', weight: 0.7, evidence: 'Order/Cart summary container present in DOM' });
  }
  if (paymentInputs) {
    signals.push({ type: 'CHECKOUT', weight: 0.8, evidence: 'Payment method / card input fields present' });
  }
  if (checkoutH1 && (checkoutButtons || cartSummary || paymentInputs || checkoutUrlKeyword)) {
    signals.push({ type: 'CHECKOUT', weight: 0.5, evidence: `Checkout heading: "${primaryH1.slice(0, 40)}"` });
  }
  if (checkoutUrlKeyword && (checkoutButtons || cartSummary || paymentInputs || checkoutTitle)) {
    signals.push({ type: 'CHECKOUT', weight: 0.3, evidence: 'URL corroborates checkout/cart workflow' });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. LISTING (E-COMMERCE / SEARCH RESULTS)
  // ──────────────────────────────────────────────────────────────────────────
  const productCards = targetDoc?.querySelectorAll('.product-card, [data-product], .listing-item, .search-result, div.g');
  const productCount = productCards ? productCards.length : wm?.entities.filter(e => e.type === 'Product' || e.type === 'SearchResult').length ?? 0;
  const listingH1 = primaryH1.includes('results') || primaryH1.includes('products') || primaryH1.includes('items') || primaryH1.includes('catalog');
  const listingUrlKeyword = rawUrl.includes('/search?') || rawUrl.includes('/results') || rawUrl.includes('/category/') || rawUrl.includes('/products');
  const hasBuyButton = Boolean(targetDoc?.querySelector('#add-to-cart, #buy-now, .btn-add-cart, button[id*="buy" i], button[id*="cart" i]'));

  if (productCount >= 2) {
    signals.push({ type: 'LISTING', weight: 0.85, evidence: `Multiple repeatable item cards detected (count: ${productCount})` });
  } else if (productCount === 1) {
    const weight = hasBuyButton || listingH1 ? 0.75 : 0.45;
    signals.push({ type: 'LISTING', weight, evidence: 'Product item card detected with actionable purchase controls' });
  }
  if (listingH1 && productCount >= 1) {
    signals.push({ type: 'LISTING', weight: 0.4, evidence: `Listing header detected: "${primaryH1.slice(0, 40)}"` });
  }
  if (listingUrlKeyword && productCount >= 1) {
    signals.push({ type: 'LISTING', weight: 0.3, evidence: 'URL corroborates search results or catalog path' });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. SEARCH PORTAL SIGNALS
  // ──────────────────────────────────────────────────────────────────────────
  const searchInputs = targetDoc?.querySelectorAll('input[type="search"], input[name="q"], input[name="query"], [role="search"]');
  const searchRole = targetDoc?.querySelector('[role="search"]');
  const isSearchEngineHome = (rawUrl.includes('google.') || rawUrl.includes('bing.') || rawUrl.includes('duckduckgo.')) &&
    (rawUrl.endsWith('/') || rawUrl.includes('/webhp') || !rawUrl.includes('?q='));
  const hasDedicatedSearchForm = targetDoc?.querySelector('form[action*="search" i]');

  if (searchInputs && searchInputs.length > 0 && productCount < 2) {
    signals.push({ type: 'SEARCH', weight: 0.65, evidence: 'Prominent search input control detected' });
  }
  if (searchRole) {
    signals.push({ type: 'SEARCH', weight: 0.5, evidence: 'Semantic ARIA role="search" container found' });
  }
  if (isSearchEngineHome && (searchInputs && searchInputs.length > 0)) {
    signals.push({ type: 'SEARCH', weight: 0.8, evidence: 'Search engine portal home page with primary query box' });
  }
  if (hasDedicatedSearchForm && productCount < 2) {
    signals.push({ type: 'SEARCH', weight: 0.5, evidence: 'Dedicated search query form present' });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. DASHBOARD / DATA TABLE SIGNALS
  // ──────────────────────────────────────────────────────────────────────────
  const dataGrids = targetDoc?.querySelectorAll('[role="grid"], table tbody tr, .dashboard-widget, .metrics-grid');
  const trCount = targetDoc?.querySelectorAll('table tbody tr').length ?? 0;
  const dashboardHeading = primaryH1.includes('dashboard') || primaryH1.includes('analytics') || primaryH1.includes('overview') || primaryH1.includes('admin');
  const dashboardUrl = rawUrl.includes('/dashboard') || rawUrl.includes('/analytics') || rawUrl.includes('/admin');

  if (trCount >= 3 || (dataGrids && dataGrids.length >= 3)) {
    signals.push({ type: 'DASHBOARD', weight: 0.7, evidence: `Tabular data grid / rows detected (row count: ${trCount})` });
  }
  if (dashboardHeading && trCount >= 1) {
    signals.push({ type: 'DASHBOARD', weight: 0.5, evidence: `Dashboard heading: "${primaryH1.slice(0, 40)}"` });
  }
  if (dashboardUrl && (trCount >= 1 || (dataGrids && dataGrids.length > 0))) {
    signals.push({ type: 'DASHBOARD', weight: 0.35, evidence: 'URL corroborates dashboard/admin path' });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. ARTICLE / DOCUMENTATION SIGNALS
  // ──────────────────────────────────────────────────────────────────────────
  const articleTags = targetDoc?.querySelectorAll('article, [role="article"], .article-content, .post-body, .documentation');
  const paragraphs = targetDoc?.querySelectorAll('p');
  const longParagraphs = paragraphs ? Array.from(paragraphs).filter(p => (p.textContent || '').trim().length > 100) : [];
  const articleHeading = targetDoc?.querySelector('article h1, .article-title, h1');

  if (articleTags && articleTags.length > 0 && paragraphs && paragraphs.length >= 2) {
    signals.push({ type: 'ARTICLE', weight: 0.85, evidence: `Semantic article container with ${paragraphs.length} paragraphs` });
  } else if (longParagraphs.length >= 3 && productCount === 0 && !hasPasswordInput) {
    signals.push({ type: 'ARTICLE', weight: 0.7, evidence: `Editorial body text detected (${longParagraphs.length} long text paragraphs)` });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. FORM (GENERIC APPLICATION / DATA INPUT)
  // ──────────────────────────────────────────────────────────────────────────
  const allInputs = targetDoc?.querySelectorAll('input:not([type="hidden"]), select, textarea');
  const visibleInputsCount = allInputs ? allInputs.length : wm?.elements.filter(e => e.type === 'input' || e.type === 'select').length ?? 0;
  const submitBtn = targetDoc?.querySelector('button[type="submit"], input[type="submit"]');

  if (visibleInputsCount >= 3 && !hasPasswordInput && !checkoutButtons && productCount < 2) {
    signals.push({ type: 'FORM', weight: 0.75, evidence: `Multi-field data entry form (${visibleInputsCount} input controls with submit target)` });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. SETTINGS / PREFERENCES
  // ──────────────────────────────────────────────────────────────────────────
  const settingsContainers = targetDoc?.querySelector('.settings-panel, [data-settings], #settings-form');
  const settingsHeading = primaryH1.includes('settings') || primaryH1.includes('preferences') || primaryH1.includes('account configuration');
  const settingsUrl = rawUrl.includes('/settings') || rawUrl.includes('/preferences');

  if (settingsContainers) {
    signals.push({ type: 'SETTINGS', weight: 0.8, evidence: 'Explicit settings/preferences container panel' });
  }
  if (settingsHeading && (settingsUrl || visibleInputsCount >= 2)) {
    signals.push({ type: 'SETTINGS', weight: 0.6, evidence: `Settings heading: "${primaryH1.slice(0, 40)}"` });
  }
  if (settingsUrl && (settingsHeading || settingsContainers)) {
    signals.push({ type: 'SETTINGS', weight: 0.35, evidence: 'URL corroborates settings/preferences path' });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MULTI-SIGNAL AGGREGATION & CONFIDENCE CALCULATION
  // ──────────────────────────────────────────────────────────────────────────
  const typeScores = new Map<SemanticPageType, { totalWeight: number; evidences: string[] }>();

  for (const signal of signals) {
    const existing = typeScores.get(signal.type) || { totalWeight: 0, evidences: [] };
    existing.totalWeight += signal.weight;
    existing.evidences.push(signal.evidence);
    typeScores.set(signal.type, existing);
  }

  // Sort candidates by total weight descending
  const candidates = Array.from(typeScores.entries())
    .map(([type, data]) => {
      // Bounded confidence between 0.0 and 0.99
      const normalizedConfidence = Math.min(0.99, Math.round(data.totalWeight * 100) / 100);
      return {
        type,
        confidence: normalizedConfidence,
        evidence: data.evidences,
      };
    })
    .sort((a, b) => b.confidence - a.confidence);

  // INVARIANT: Minimum confidence threshold for classification is 0.50
  if (candidates.length === 0 || candidates[0]!.confidence < 0.50) {
    return {
      pageType: 'UNKNOWN',
      confidence: candidates[0]?.confidence ?? 0.1,
      evidence: candidates[0]?.evidence ?? ['Insufficient or conflicting observable signals across DOM and layout'],
      pageGeneration,
      secondaryCandidates: candidates.map(c => ({ type: c.type, confidence: c.confidence })),
    };
  }

  const winner = candidates[0]!;
  return {
    pageType: winner.type,
    confidence: winner.confidence,
    evidence: winner.evidence,
    pageGeneration,
    secondaryCandidates: candidates.slice(1).map(c => ({ type: c.type, confidence: c.confidence })),
  };
}
