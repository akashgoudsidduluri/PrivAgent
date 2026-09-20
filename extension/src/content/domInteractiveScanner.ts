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

import { DetectionResult, DetectionEntityType } from '../privacy/types';

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

/**
 * Builds a unique CSS selector for an interactive DOM element.
 */
function getInteractiveSelector(el: HTMLElement): string {
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }

  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute('name');
  if (name) {
    return `${tag}[name="${CSS.escape(name)}"]`;
  }

  const role = el.getAttribute('role');
  if (role) {
    return `${tag}[role="${CSS.escape(role)}"]`;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    return `${tag}[aria-label="${CSS.escape(ariaLabel.slice(0, 30))}"]`;
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
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
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
 * Determines if an element is visible and interactive.
 */
function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 2 && rect.height > 2;
}

/**
 * Infer the high-level semantic page type from URL and DOM contents.
 */
export function inferPageType(doc: Document = document): string {
  const url = (typeof window !== 'undefined' ? window.location.href : '').toLowerCase();
  
  // 1. URL patterns
  if (url.includes('login') || url.includes('signin') || url.includes('auth')) return 'login';
  if (url.includes('results') || url.includes('search?') || url.includes('/search')) return 'results';
  if (url.includes('checkout') || url.includes('cart') || url.includes('pay')) return 'checkout';
  if (url.includes('bank') || url.includes('account') || url.includes('portal')) return 'banking';

  // 2. DOM-based heuristics
  if (doc.querySelector('input[type="password"]')) {
    return 'login';
  }
  if (doc.querySelector('input[name="q"], input[type="search"], #search-query, input[placeholder*="search" i]')) {
    return 'search';
  }
  if (doc.querySelector('.product-card, .search-result, [data-component="result"]')) {
    return 'results';
  }
  if (url.endsWith('/') || url.includes('index.html') || url.includes('home')) {
    return 'landing';
  }

  return 'general';
}

/**
 * Scans the live document for all visible interactive controls,
 * producing standardized DetectionResult objects with clean accessible labels.
 */
export function scanInteractiveElements(root: Document | HTMLElement = document): PageUnderstanding {
  const targetDoc = root instanceof Document ? root : root.ownerDocument || document;
  const pageType = inferPageType(targetDoc);
  const title = targetDoc.title || '';
  const mainHeading = (targetDoc.querySelector('h1')?.textContent || '').trim().slice(0, 80);

  const interactiveElements: DetectionResult[] = [];
  const seenSelectors = new Set<string>();

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

  const rawElements = Array.from(targetDoc.querySelectorAll<HTMLElement>(query));
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
    const label = getAccessibleLabel(el);
    const bbox = getBoundingBox(el);

    interactiveElements.push({
      id,
      type: entityType,
      confidence: 0.95,
      selector,
      bbox,
      length: label.length,
      source: 'dom_attribute',
      label: label || undefined,
    });

    // Limit to 35 most prominent interactive controls to keep context bounded
    if (interactiveElements.length >= 35) {
      break;
    }
  }

  return {
    pageType,
    title,
    heading: mainHeading,
    interactiveElements,
  };
}
