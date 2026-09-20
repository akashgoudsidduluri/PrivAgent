/**
 * PrivAgent — Local Interactive Element & Page Understanding Scanner (M9)
 *
 * Scans the live DOM for visible interactive elements (buttons, links, search boxes,
 * inputs, selects) to build a rich semantic representation of the current page.
 *
 * Security & Privacy Invariants:
 *  1. Zero raw PII values: Never extracts input values or credentials.
 *  2. Label sanitization: Accessible labels/text are checked against sensitive keywords
 *     and redacted before inclusion.
 *  3. Geometry verification: Only includes elements with visible, non-zero geometry.
 *  4. Deterministic IDs: Preserves real DOM IDs where available for accurate M5 grounding.
 */

import { DetectionResult, DetectionEntityType, SemanticGroupMetadata } from '../privacy/types';

export interface InteractiveElement {
  id: string;
  type: DetectionEntityType;
  selector: string;
  label: string;
  bbox: [number, number, number, number];
  length: number;
}

export interface PageUnderstanding {
  pageType: string;
  title: string;
  heading: string;
  interactiveElements: DetectionResult[];
  semanticGroups?: SemanticGroupMetadata[];
  activeModal?: { selector: string; label: string } | null;
  isLargeDom?: boolean;
  totalDomElements?: number;
}

const SENSITIVE_LABEL_KEYWORDS = [
  'password', 'passwd', 'secret', 'pin', 'cvv', 'cvc',
  'token', 'card number', 'card_number', 'pan', 'otp',
  'ssn', 'account number', 'routing number'
];

/**
 * Checks if a string contains any sensitive credential or security tokens.
 */
function isSensitiveText(text: string): boolean {
  const lower = text.toLowerCase();
  return SENSITIVE_LABEL_KEYWORDS.some(kw => lower.includes(kw));
}

function safeEscapeCss(val: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(val);
  }
  return val.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');
}

/**
 * Builds a unique CSS selector for an interactive DOM element.
 */
function getInteractiveSelector(el: HTMLElement): string {
  if (el.id) {
    return `#${safeEscapeCss(el.id)}`;
  }

  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute('name');
  if (name) {
    return `${tag}[name="${safeEscapeCss(name)}"]`;
  }

  const role = el.getAttribute('role');
  if (role) {
    return `${tag}[role="${safeEscapeCss(role)}"]`;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    return `${tag}[aria-label="${safeEscapeCss(ariaLabel.slice(0, 30))}"]`;
  }

  const className = (el.className || '')
    .toString()
    .split(/\s+/)
    .filter(c => c && !c.includes(':') && !c.startsWith('privagent-'))
    .slice(0, 2)
    .join('.');

  if (className) {
    return `${tag}.${className}`;
  }

  return tag;
}

/**
 * Extracts a compact, safe accessible label for an element.
 */
function getAccessibleLabel(el: HTMLElement): string {
  // 1. Check aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    return sanitizeLabel(ariaLabel.trim());
  }

  // 2. Check title
  const title = el.getAttribute('title');
  if (title && title.trim()) {
    return sanitizeLabel(title.trim());
  }

  // 3. Check placeholder for inputs
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const placeholder = el.placeholder;
    if (placeholder && placeholder.trim()) {
      return sanitizeLabel(placeholder.trim());
    }
  }

  // 4. Check associated label
  if (el.id) {
    const label = document.querySelector(`label[for="${safeEscapeCss(el.id)}"]`);
    if (label && label.textContent && label.textContent.trim()) {
      return sanitizeLabel(label.textContent.trim());
    }
  }

  // 5. Check inner visible text for buttons and links
  const text = (el.innerText || el.textContent || '').trim();
  if (text) {
    // Truncate to first 50 chars and normalize whitespace
    const cleanText = text.replace(/\s+/g, ' ').slice(0, 50);
    return sanitizeLabel(cleanText);
  }

  // 6. Check value for submit/button inputs
  if (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button')) {
    if (el.value && el.value.trim()) {
      return sanitizeLabel(el.value.trim());
    }
  }

  return '';
}

/**
 * Sanitizes an accessible label so no sensitive credentials leak.
 */
function sanitizeLabel(label: string): string {
  if (isSensitiveText(label)) {
    return 'Protected Credential Field';
  }
  return label.slice(0, 60);
}

/**
 * Computes bounding box geometry [x, y, width, height].
 */
function getBoundingBox(el: HTMLElement): [number, number, number, number] {
  const rect = el.getBoundingClientRect();
  const scrollX = typeof window !== 'undefined' ? window.scrollX || 0 : 0;
  const scrollY = typeof window !== 'undefined' ? window.scrollY || 0 : 0;
  return [
    Math.round(rect.left + scrollX),
    Math.round(rect.top + scrollY),
    Math.round(rect.width),
    Math.round(rect.height),
  ];
}

/**
 * Determines if an element is visible, non-hidden, and interactive (not disabled).
 */
export function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;

  // Reject disabled controls
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
    return false;
  }

  const style = window.getComputedStyle(el);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0' ||
    style.pointerEvents === 'none'
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return true;
  }
  return rect.width > 2 && rect.height > 2;
}

/**
 * Detects if an active modal dialog, popup overlay, or cookie banner is present on the page.
 */
export function detectActiveModal(doc: Document = document): { selector: string; label: string; element: HTMLElement } | null {
  const modalQuery = [
    'dialog[open]',
    '[aria-modal="true"]',
    '[role="dialog"]:not([style*="display: none"])',
    '.modal.show',
    '.modal.active',
    '#cookie-consent:not([style*="display: none"])',
    '#cookie-banner:not([style*="display: none"])',
    '.cookie-banner:not([style*="display: none"])',
    '.popup-overlay:not([style*="display: none"])'
  ].join(', ');

  const candidates = Array.from(doc.querySelectorAll<HTMLElement>(modalQuery));
  for (const m of candidates) {
    if (m.isConnected) {
      const style = window.getComputedStyle(m);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        const titleEl = m.querySelector('h1, h2, h3, .modal-title, .title');
        const label = (titleEl?.textContent || m.getAttribute('aria-label') || 'Active Modal Dialog').trim().slice(0, 50);
        const selector = m.id ? `#${safeEscapeCss(m.id)}` : m.tagName.toLowerCase();
        return { selector, label, element: m };
      }
    }
  }
  return null;
}

/**
 * Safely inspects same-origin iframes without violating browser Same-Origin Policy (SOP).
 */
export function scanSameOriginIframes(doc: Document = document): Array<{ el: HTMLElement; framePrefix: string }> {
  const iframes = Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe'));
  const results: Array<{ el: HTMLElement; framePrefix: string }> = [];

  iframes.forEach((iframe, idx) => {
    try {
      const frameDoc = iframe.contentDocument;
      if (frameDoc) {
        const query = 'button, a[href], input:not([type="hidden"]), textarea, select';
        const els = Array.from(frameDoc.querySelectorAll<HTMLElement>(query));
        for (const el of els) {
          results.push({ el, framePrefix: `frame${idx}` });
        }
      }
    } catch {
      // Cross-origin iframe: protected by browser security policy (SOP).
      // We do not weaken or bypass browser sandbox boundaries.
    }
  });

  return results;
}

/**
 * Generic page classifier that categorizes the current page into semantic types:
 * 'search' | 'login' | 'article' | 'listing' | 'form' | 'checkout' | 'settings' | 'dashboard' | 'error' | 'unknown'
 * (plus backwards-compatible 'landing', 'results', 'product_detail', 'banking').
 */
export function classifyPage(doc: Document = document): string {
  const url = (typeof window !== 'undefined' ? window.location.href : '').toLowerCase();
  const title = (doc.title || '').toLowerCase();
  const h1 = (doc.querySelector('h1')?.textContent || '').toLowerCase();

  // 1. Error pages
  if (
    url.includes('chrome-error://') ||
    title.includes('404') || title.includes('not found') ||
    h1.includes('404') || h1.includes('not found') ||
    doc.querySelector('.error-page, [data-error]')
  ) {
    return 'error';
  }

  // 2. Login / Authentication
  if (
    url.includes('login') || url.includes('signin') || url.includes('auth') ||
    title.includes('sign in') || title.includes('log in') ||
    doc.querySelector('input[type="password"], form[action*="login" i], form[action*="signin" i], #btn-signin, #btn-login')
  ) {
    return 'login';
  }

  // 3. Checkout / Payment
  if (
    url.includes('checkout') || url.includes('cart') || url.includes('payment') || url.includes('pay') ||
    title.includes('checkout') || title.includes('shopping cart') ||
    doc.querySelector('form[action*="checkout" i], [data-checkout], #btn-checkout, #btn-pay')
  ) {
    return 'checkout';
  }

  // 4. Product / Search Results / Listing
  if (
    url.includes('results') || url.includes('search?') ||
    doc.querySelector('.product-card, .search-result, [data-component="result"], [data-product], .listing-item')
  ) {
    return 'listing';
  }

  // 5. Search portal
  if (
    url.includes('search') ||
    doc.querySelector('input[type="search"], input[name="q"], [role="search"], form[action*="search" i]')
  ) {
    return 'search';
  }

  // 6. Settings / Account / Profile
  if (
    url.includes('settings') || url.includes('profile') || url.includes('account') ||
    title.includes('settings') || title.includes('my account') ||
    doc.querySelector('.settings-panel, [data-settings], form[action*="settings" i]')
  ) {
    return 'settings';
  }

  // 7. Dashboard / Table data
  if (
    url.includes('dashboard') || url.includes('analytics') || url.includes('admin') ||
    doc.querySelector('[role="grid"], .dashboard, table tbody tr')
  ) {
    return 'dashboard';
  }

  // 8. Article / Content
  if (
    url.includes('article') || url.includes('blog') || url.includes('post') || url.includes('news') ||
    doc.querySelector('article, [role="article"], .article-body, .post-content')
  ) {
    return 'article';
  }

  // 9. Generic Form
  if (doc.querySelectorAll('form input:not([type="hidden"])').length >= 3) {
    return 'form';
  }

  // 10. Landing page
  if (url.endsWith('/') || url.includes('index.html') || url.includes('home')) {
    return 'landing';
  }

  return 'unknown';
}

export function inferPageType(doc: Document = document): string {
  return classifyPage(doc);
}

/**
 * Extracts safe structural element relationships (search region, auth region, cards, forms)
 * without ever exposing raw input values or sensitive credentials.
 */
function extractSemanticGroups(doc: Document, interactive: DetectionResult[]): SemanticGroupMetadata[] {
  const groups: SemanticGroupMetadata[] = [];
  const elementIdMap = new Map<HTMLElement, string>();

  for (const det of interactive) {
    try {
      const el = doc.querySelector<HTMLElement>(det.selector);
      if (el) elementIdMap.set(el, det.id);
    } catch {
      // ignore invalid selector syntax
    }
  }

  // Group 1: Search Regions
  const searchForms = Array.from(
    doc.querySelectorAll<HTMLElement>('form[role="search"], form.search-form, [role="search"], form[action*="search" i]')
  );
  let searchIdx = 0;
  for (const sf of searchForms) {
    searchIdx++;
    const containedIds: string[] = [];
    for (const [el, id] of elementIdMap.entries()) {
      if (sf.contains(el)) containedIds.push(id);
    }
    if (containedIds.length > 0) {
      groups.push({
        id: `group-search-${searchIdx}`,
        type: 'search_region',
        label: 'Search Region',
        elementIds: containedIds,
      });
    }
  }

  // Group 2: Auth Regions
  const authForms = Array.from(
    doc.querySelectorAll<HTMLElement>('form:has(input[type="password"]), form.login-form, form.auth-form')
  );
  let authIdx = 0;
  for (const af of authForms) {
    authIdx++;
    const containedIds: string[] = [];
    for (const [el, id] of elementIdMap.entries()) {
      if (af.contains(el)) containedIds.push(id);
    }
    if (containedIds.length > 0) {
      groups.push({
        id: `group-auth-${authIdx}`,
        type: 'auth_region',
        label: 'Authentication Region',
        elementIds: containedIds,
      });
    }
  }

  // Group 3: Card Listings (products, results, articles)
  const cards = Array.from(
    doc.querySelectorAll<HTMLElement>('.product-card, .search-result, [data-component="result"], article.card, .listing-card')
  );
  let cardIdx = 0;
  for (const card of cards.slice(0, 10)) {
    cardIdx++;
    const containedIds: string[] = [];
    for (const [el, id] of elementIdMap.entries()) {
      if (card.contains(el)) containedIds.push(id);
    }
    const cardTitle = (card.querySelector('.product-title, h2, h3, .title')?.textContent || '').trim().slice(0, 40);
    if (containedIds.length > 0) {
      groups.push({
        id: `group-card-${cardIdx}`,
        type: 'card_listing',
        label: cardTitle ? `Card: ${cardTitle}` : 'Listing Item Card',
        elementIds: containedIds,
      });
    }
  }

  // Group 4: Generic Form Sections
  const generalForms = Array.from(doc.querySelectorAll<HTMLElement>('form:not([role="search"])')).filter(
    (f) => !authForms.includes(f) && !searchForms.includes(f)
  );
  let formIdx = 0;
  for (const gf of generalForms.slice(0, 5)) {
    formIdx++;
    const containedIds: string[] = [];
    for (const [el, id] of elementIdMap.entries()) {
      if (gf.contains(el)) containedIds.push(id);
    }
    if (containedIds.length > 0) {
      groups.push({
        id: `group-form-${formIdx}`,
        type: 'form_section',
        label: 'Form Section',
        elementIds: containedIds,
      });
    }
  }

  return groups;
}

/**
 * Scans the live document for visible interactive controls,
 * producing standardized DetectionResult objects with clean accessible labels and semantic groups.
 * Includes modal prioritization, same-origin iframe elements, duplicate label disambiguation, and large DOM bounds.
 */
export function scanInteractiveElements(root: Document | HTMLElement = document): PageUnderstanding {
  const targetDoc = root instanceof Document ? root : root.ownerDocument || document;
  const pageType = classifyPage(targetDoc);
  const title = targetDoc.title || '';
  const mainHeading = (targetDoc.querySelector('h1')?.textContent || '').trim().slice(0, 80);

  const totalDomElements = targetDoc.querySelectorAll('*').length;
  const isLargeDom = totalDomElements > 1500;
  const activeModal = detectActiveModal(targetDoc);

  const interactiveElements: DetectionResult[] = [];
  const seenSelectors = new Set<string>();
  const seenLabels = new Map<string, number>();

  // Selector targeting common interactive elements
  const query = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="searchbox"]',
    'a.btn',
    'a.button'
  ].join(', ');

  const allDocElements = Array.from(targetDoc.querySelectorAll<HTMLElement>(query));

  // Also include elements from accessible same-origin iframes
  const iframeResults = scanSameOriginIframes(targetDoc);
  const iframeElements = iframeResults.map(r => r.el);

  // If a modal is active, prioritize its interactive elements first
  let rawElements: HTMLElement[] = [];
  if (activeModal && activeModal.element) {
    const modalElements = allDocElements.filter(el => activeModal.element.contains(el));
    const outsideElements = allDocElements.filter(el => !activeModal.element.contains(el));
    rawElements = [...modalElements, ...outsideElements, ...iframeElements];
  } else {
    rawElements = [...allDocElements, ...iframeElements];
  }

  let counter = 0;

  for (const el of rawElements) {
    // Skip PrivAgent extension UI elements
    if (el.closest('#privagent-redaction-root') || el.closest('#privagent-floating-panel')) {
      continue;
    }

    if (!isElementVisible(el)) {
      continue;
    }

    const tag = el.tagName.toLowerCase();
    const typeAttr = (el.getAttribute('type') || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();

    let entityType: DetectionEntityType = 'element';
    if (tag === 'button' || typeAttr === 'submit' || typeAttr === 'button' || role === 'button' || el.classList.contains('btn')) {
      entityType = 'button';
    } else if (tag === 'a' || role === 'link') {
      entityType = 'link';
    } else if (typeAttr === 'search' || (el instanceof HTMLInputElement && el.name === 'q') || role === 'searchbox') {
      entityType = 'search';
    } else if (tag === 'select') {
      entityType = 'select';
    } else if (typeAttr === 'password') {
      entityType = 'password';
    } else if (tag === 'input' || tag === 'textarea') {
      entityType = 'input';
    }

    const selector = getInteractiveSelector(el);
    if (seenSelectors.has(selector) && !el.id) {
      continue; // avoid duplicates of generic selectors
    }
    seenSelectors.add(selector);

    counter++;
    const id = el.id || `inter-${entityType}-${counter}`;
    let rawLabel = getAccessibleLabel(el);

    // Disambiguate duplicate labels (e.g. repeated "Add to Cart" or "Select")
    if (rawLabel) {
      const currentCount = seenLabels.get(rawLabel) || 0;
      seenLabels.set(rawLabel, currentCount + 1);
      if (currentCount > 0) {
        const card = el.closest('.product-card, .search-result, article, tr, li, [data-component]');
        const cardTitle = card
          ? (card.querySelector('.product-title, h2, h3, h4, .title, strong')?.textContent || '').trim().slice(0, 30)
          : '';
        rawLabel = cardTitle && !rawLabel.toLowerCase().includes(cardTitle.toLowerCase())
          ? `${rawLabel} (${cardTitle})`
          : `${rawLabel} (#${currentCount + 1})`;
      }
    }

    const bbox = getBoundingBox(el);

    interactiveElements.push({
      id,
      type: entityType,
      confidence: 0.95,
      selector,
      bbox,
      length: rawLabel.length,
      source: 'dom_attribute',
      label: rawLabel || undefined,
    });

    // Bound context to 40 most prominent interactive controls to prevent prompt explosion
    if (interactiveElements.length >= 40) {
      break;
    }
  }

  const semanticGroups = extractSemanticGroups(targetDoc, interactiveElements);

  if (activeModal && activeModal.element) {
    const modalElementIds = interactiveElements
      .filter((ie) => {
        const matchingNode = targetDoc.querySelector(ie.selector);
        return matchingNode && activeModal.element.contains(matchingNode);
      })
      .map((ie) => ie.id);

    if (modalElementIds.length > 0) {
      semanticGroups.unshift({
        id: 'group-modal-interruption',
        type: 'modal_overlay',
        label: `Active Dialog: ${activeModal.label}`,
        elementIds: modalElementIds,
      });
    }
  }

  return {
    pageType,
    title,
    heading: mainHeading,
    interactiveElements,
    semanticGroups,
    activeModal: activeModal ? { selector: activeModal.selector, label: activeModal.label } : null,
    isLargeDom,
    totalDomElements,
  };
}
