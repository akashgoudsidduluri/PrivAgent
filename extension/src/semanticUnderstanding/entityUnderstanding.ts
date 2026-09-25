/**
 * PrivAgent 2.0 — Semantic Entity Understanding (P3.2)
 *
 * Extracts and maps high-level semantic entities across:
 *   Product | Article | SearchResult | Transaction | TableRow | Form |
 *   UserProfile | NavigationItem | Category | Image | Video | GenericEntity
 *
 * Security & Privacy Invariants:
 *  1. ZERO raw credentials: Passwords, card numbers, CVVs, tokens, and account numbers
 *     are strictly scrubbed and never stored in safeAttributes or entity labels.
 *  2. No hallucinated entities: Entities are extracted solely from observable DOM/layout evidence.
 *  3. Bounded confidence scoring based on attribute completeness.
 *  4. Stamped with monotonic pageGeneration and honest perception source.
 */

import { BrowserWorldModel } from '../worldModel/types';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';
import { PerceptionSource } from '../visualPerception/visualTypes';
import { SemanticEntity, SemanticEntityType } from './semanticTypes';

export interface EntityExtractionOptions {
  worldModel?: BrowserWorldModel;
  root?: Document | HTMLElement;
  pageGeneration?: number;
}

const FORBIDDEN_KEYS = new Set([
  'password', 'passwd', 'token', 'secret', 'cvv', 'cvc',
  'card', 'cardnumber', 'card_number', 'pan', 'otp', 'pin',
  'ssn', 'accountnumber', 'account_number', 'auth', 'cred',
]);

function getBbox(el: HTMLElement): [number, number, number, number] {
  if (typeof el.getBoundingClientRect !== 'function') return [0, 0, 0, 0];
  const rect = el.getBoundingClientRect();
  return [
    Math.round(rect.left),
    Math.round(rect.top),
    Math.round(rect.width),
    Math.round(rect.height),
  ];
}

function sanitizeLabel(rawLabel: string): string {
  const trimmed = rawLabel.trim();
  if (!trimmed) return 'Untitled Entity';

  // Explicit credential keyword check
  if (/\b(password|passwd|token|secret|cvv|pin|otp|card|credit\s*card|auth)\b/i.test(trimmed)) {
    return 'Protected Credential Entity';
  }

  const violations = scanForRawSensitiveValues(trimmed);
  if (violations.length > 0) {
    return 'Protected Credential Entity';
  }
  return trimmed.slice(0, 100);
}

function filterSafeAttributes(rawAttrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};

  for (const [k, v] of Object.entries(rawAttrs)) {
    const lowerKey = k.toLowerCase();
    if (FORBIDDEN_KEYS.has(lowerKey)) continue;

    if (typeof v === 'string') {
      if (/\b(password|passwd|token|secret|cvv|pin|otp|card|credit\s*card|auth)\b/i.test(v)) continue;
      const violations = scanForRawSensitiveValues(v);
      if (violations.length === 0 && v.length < 200) {
        safe[k] = v;
      }
    } else if (typeof v === 'number' && !isNaN(v)) {
      // Exclude suspected credit cards or account numbers disguised as numbers
      if (v < 1e12) {
        safe[k] = v;
      }
    } else if (typeof v === 'boolean') {
      safe[k] = v;
    }
  }

  return safe;
}

export function extractSemanticEntities(
  options: EntityExtractionOptions = {}
): SemanticEntity[] {
  const pageGeneration = options.pageGeneration ?? options.worldModel?.page?.pageGeneration ?? 1;
  const wm = options.worldModel;

  const targetDoc: Document = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document)
      : options.root.ownerDocument || document
    : typeof document !== 'undefined'
    ? document
    : (null as unknown as Document);

  const entities: SemanticEntity[] = [];
  const seenIds = new Set<string>();

  // 1. If BrowserWorldModel is provided, consume its structured entities
  if (wm?.entities && wm.entities.length > 0) {
    for (const we of wm.entities) {
      if (seenIds.has(we.id)) continue;
      seenIds.add(we.id);
      entities.push({
        id: we.id,
        type: (we.type as SemanticEntityType) || 'GenericEntity',
        label: sanitizeLabel(we.title || 'Entity'),
        confidence: we.confidence ?? 0.90,
        bbox: we.bbox,
        source: 'layout',
        associatedInteractiveElements: we.associatedElementIds || [],
        pageGeneration: we.pageGeneration ?? pageGeneration,
        safeAttributes: filterSafeAttributes(we.attributes || {}),
      });
    }
  }

  if (!targetDoc) return entities;

  // ──────────────────────────────────────────────────────────────────────────
  // 1. PRODUCTS (E-Commerce cards / items)
  // ──────────────────────────────────────────────────────────────────────────
  const productCards = Array.from(targetDoc.querySelectorAll<HTMLElement>('.product-card, [data-product], .listing-item'));
  productCards.forEach((el, idx) => {
    const id = el.id || `entity-product-g${pageGeneration}-${idx + 1}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const titleEl = el.querySelector('.product-title, .title, h2, h3, h4');
    const label = sanitizeLabel(titleEl?.textContent || el.getAttribute('aria-label') || 'Product Item');

    // Extract interactive elements within this product container
    const interactiveEls = Array.from(el.querySelectorAll<HTMLElement>('button, a[href], input[type="submit"]'));
    const associatedInteractiveElements = interactiveEls.map((act, i) => act.id || `${id}-action-${i + 1}`);

    // Price extraction
    const priceEl = el.querySelector('.price, .product-price, [data-price]');
    let priceAvailable = false;
    let numericPrice: number | undefined;

    const rawPrice = (priceEl?.textContent || el.getAttribute('data-price') || '').replace(/[^\d.]/g, '');
    if (rawPrice) {
      const parsed = parseFloat(rawPrice);
      if (!isNaN(parsed)) {
        numericPrice = parsed;
        priceAvailable = true;
      }
    }

    const safeAttributes = filterSafeAttributes({
      priceAvailable,
      ...(numericPrice !== undefined ? { price: numericPrice } : {}),
      hasImage: Boolean(el.querySelector('img, picture')),
      actionCount: associatedInteractiveElements.length,
    });

    const confidence = priceAvailable && titleEl ? 0.95 : 0.85;

    entities.push({
      id,
      type: 'Product',
      label,
      confidence,
      bbox: getBbox(el),
      source: 'layout',
      associatedInteractiveElements,
      pageGeneration,
      safeAttributes,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. SEARCH RESULTS
  // ──────────────────────────────────────────────────────────────────────────
  const searchResultEls = Array.from(targetDoc.querySelectorAll<HTMLElement>('.search-result, [data-component="result"], div.g'));
  searchResultEls.forEach((el, idx) => {
    const id = el.id || `entity-search-g${pageGeneration}-${idx + 1}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const titleEl = el.querySelector('h3, .result-title, a');
    const label = sanitizeLabel(titleEl?.textContent || 'Search Result');

    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const associatedInteractiveElements = links.map((link, i) => link.id || `${id}-link-${i + 1}`);

    const safeAttributes = filterSafeAttributes({
      hasSnippet: Boolean(el.querySelector('.snippet, .result-snippet, p')),
      linkCount: links.length,
    });

    entities.push({
      id,
      type: 'SearchResult',
      label,
      confidence: titleEl ? 0.92 : 0.80,
      bbox: getBbox(el),
      source: 'layout',
      associatedInteractiveElements,
      pageGeneration,
      safeAttributes,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. ARTICLES
  // ──────────────────────────────────────────────────────────────────────────
  const articleEls = Array.from(targetDoc.querySelectorAll<HTMLElement>('article, .article-content, .post-body'));
  articleEls.forEach((el, idx) => {
    const id = el.id || `entity-article-g${pageGeneration}-${idx + 1}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const titleEl = el.querySelector('h1, h2, .article-title');
    const label = sanitizeLabel(titleEl?.textContent || 'Article Entry');

    const interactiveEls = Array.from(el.querySelectorAll<HTMLElement>('a[href], button'));
    const associatedInteractiveElements = interactiveEls.map((btn, i) => btn.id || `${id}-int-${i + 1}`);

    const authorEl = el.querySelector('.author, [rel="author"], .byline');
    const dateEl = el.querySelector('time, .date, .publish-date');

    const safeAttributes = filterSafeAttributes({
      hasAuthor: Boolean(authorEl),
      ...(authorEl?.textContent ? { author: authorEl.textContent.trim().slice(0, 50) } : {}),
      hasDate: Boolean(dateEl),
      paragraphCount: el.querySelectorAll('p').length,
    });

    entities.push({
      id,
      type: 'Article',
      label,
      confidence: 0.90,
      bbox: getBbox(el),
      source: 'layout',
      associatedInteractiveElements,
      pageGeneration,
      safeAttributes,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. FORMS (Composite data forms)
  // ──────────────────────────────────────────────────────────────────────────
  const formEls = Array.from(targetDoc.querySelectorAll<HTMLFormElement>('form'));
  formEls.forEach((el, idx) => {
    const id = el.id || `entity-form-g${pageGeneration}-${idx + 1}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const headingEl = el.querySelector('h1, h2, h3, legend');
    const label = sanitizeLabel(headingEl?.textContent || el.getAttribute('aria-label') || el.getAttribute('name') || 'Data Entry Form');

    const inputs = Array.from(el.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea, button[type="submit"]'));
    const associatedInteractiveElements = inputs.map((inp, i) => inp.id || `${id}-field-${i + 1}`);

    const hasPassword = Boolean(el.querySelector('input[type="password"]'));
    const safeAttributes = filterSafeAttributes({
      fieldCount: inputs.length,
      requiresAuthentication: hasPassword,
      hasSubmitAction: Boolean(el.querySelector('button[type="submit"], input[type="submit"]')),
    });

    entities.push({
      id,
      type: 'Form',
      label,
      confidence: 0.93,
      bbox: getBbox(el),
      source: 'layout',
      associatedInteractiveElements,
      pageGeneration,
      safeAttributes,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. TABLE ROWS / TRANSACTIONS
  // ──────────────────────────────────────────────────────────────────────────
  const tableRows = Array.from(targetDoc.querySelectorAll<HTMLTableRowElement>('table tbody tr'));
  tableRows.slice(0, 20).forEach((el, idx) => {
    const id = el.id || `entity-tablerow-g${pageGeneration}-${idx + 1}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const cells = Array.from(el.querySelectorAll<HTMLTableCellElement>('td'));
    if (cells.length === 0) return;

    const firstCellText = cells[0]?.textContent || '';
    const label = sanitizeLabel(firstCellText || `Row ${idx + 1}`);

    const rowButtons = Array.from(el.querySelectorAll<HTMLElement>('button, a[href]'));
    const associatedInteractiveElements = rowButtons.map((btn, i) => btn.id || `${id}-btn-${i + 1}`);

    // Check if table row represents a financial transaction or generic row
    const rowText = (el.textContent || '').toLowerCase();
    const isTransaction = rowText.includes('credit') || rowText.includes('debit') || rowText.includes('transfer') || rowText.includes('payment');

    const safeAttributes = filterSafeAttributes({
      cellCount: cells.length,
      isTransaction,
    });

    entities.push({
      id,
      type: isTransaction ? 'Transaction' : 'TableRow',
      label,
      confidence: 0.88,
      bbox: getBbox(el),
      source: 'layout',
      associatedInteractiveElements,
      pageGeneration,
      safeAttributes,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. VIDEO / KEY-FRAME ENTITIES
  // ──────────────────────────────────────────────────────────────────────────
  if (wm?.videoFindings && wm.videoFindings.length > 0) {
    wm.videoFindings.forEach((vf, idx) => {
      const id = `entity-video-g${pageGeneration}-${idx + 1}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      entities.push({
        id,
        type: 'Video',
        label: `Video Stream (${vf.durationSeconds}s)`,
        confidence: 0.94,
        bbox: vf.bbox,
        source: vf.source,
        associatedInteractiveElements: vf.elementId ? [vf.elementId] : [],
        pageGeneration,
        safeAttributes: {
          durationSeconds: vf.durationSeconds ?? 0,
          hasMotion: Boolean(vf.hasMotion),
          visualChangeScore: vf.visualChangeScore ?? 0,
        },
      });
    });
  }

  return entities;
}
