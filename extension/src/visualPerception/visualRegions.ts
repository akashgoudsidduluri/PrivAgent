/**
 * PrivAgent 2.0 — Visual Region Perception (Phase 2)
 *
 * Segments the viewport layout into typed, bounded visual regions:
 *  - Cards & Containers
 *  - Button-like / Clickable visual blocks
 *  - Media blocks (Images, Canvas, Video)
 *  - Modal overlays & Notification banners
 *  - Major text blocks
 *
 * Invariants:
 *  1. Zero raw pixel storage: Only geometry, classification, and sanitized hints are retained.
 *  2. Honest Capability Labeling: These regions are derived from DOM and layout geometry,
 *     so they are explicitly stamped with source: 'layout'.
 *  3. Bounded coordinates: Coordinates are normalized against the active viewport geometry.
 *  4. Generation Stamped: Every region includes pageGeneration for stale-reference invalidation.
 */

import { VisualRegion, VisualRegionType } from './visualTypes';
import { isElementVisible } from '../content/domInteractiveScanner';

function getBbox(el: HTMLElement): [number, number, number, number] {
  if (typeof el.getBoundingClientRect !== 'function') return [0, 0, 0, 0];
  const rect = el.getBoundingClientRect();
  const scrollX = typeof window !== 'undefined' ? window.scrollX || 0 : 0;
  const scrollY = typeof window !== 'undefined' ? window.scrollY || 0 : 0;
  const x = Math.max(0, Math.round(rect.left + scrollX));
  const y = Math.max(0, Math.round(rect.top + scrollY));
  const w = Math.max(0, Math.round(rect.width));
  const h = Math.max(0, Math.round(rect.height));
  return [x, y, w, h];
}

const SENSITIVE_PATTERN = /\b(password|passwd|secret|pin|cvv|cvc|token|card|pan|otp)\b/i;

function sanitizeSemanticHint(hint: string): string {
  if (!hint) return '';
  const clean = hint.trim().replace(/\s+/g, ' ').slice(0, 50);
  if (SENSITIVE_PATTERN.test(clean)) {
    return 'Protected Credential Region';
  }
  return clean;
}

export interface ExtractVisualRegionsOptions {
  pageGeneration: number;
  root?: Document | HTMLElement;
  maxRegions?: number;
}

/**
 * Extracts normalized visual regions from the live DOM and layout tree.
 * Explicitly marks findings with source: 'layout'.
 */
export function extractVisualRegions(options: ExtractVisualRegionsOptions): VisualRegion[] {
  const pageGeneration = options.pageGeneration;
  const maxRegions = options.maxRegions ?? 100;
  const doc = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document)
      : options.root.ownerDocument || document
    : document;

  const rootEl = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document).body || (options.root as Document).documentElement
      : (options.root as HTMLElement)
    : doc.body || doc.documentElement;

  if (!rootEl) return [];

  const regions: VisualRegion[] = [];
  let regionCounter = 0;

  // Scan structural candidates: articles, sections, cards, modals, banners, media, canvases, videos
  const selector = [
    'article',
    'section',
    '.card, .product-card, [data-card]',
    'dialog, [role="dialog"], .modal, .cookie-banner, .banner',
    'header, nav, footer, main',
    'canvas',
    'video',
    'img, figure',
    'button, [role="button"], a.btn, a.button',
  ].join(', ');

  const candidates = Array.from(rootEl.querySelectorAll<HTMLElement>(selector));

  for (const el of candidates) {
    if (regions.length >= maxRegions) break;
    if (!el.isConnected || !isElementVisible(el)) continue;

    const bbox = getBbox(el);
    if (bbox[2] < 8 || bbox[3] < 8) continue; // Skip micro-elements smaller than 8x8

    const tag = el.tagName.toLowerCase();
    let type: VisualRegionType = 'container';
    let confidence = 0.8;

    if (tag === 'canvas') {
      type = 'canvas';
      confidence = 0.95;
    } else if (tag === 'video') {
      type = 'video';
      confidence = 0.95;
    } else if (tag === 'img' || tag === 'figure') {
      type = 'image';
      confidence = 0.9;
    } else if (tag === 'button' || el.getAttribute('role') === 'button' || el.classList.contains('btn')) {
      type = 'button_like';
      confidence = 0.9;
    } else if (tag === 'dialog' || el.getAttribute('role') === 'dialog' || el.classList.contains('modal')) {
      type = 'modal';
      confidence = 0.95;
    } else if (el.classList.contains('banner') || el.classList.contains('cookie-banner')) {
      type = 'banner';
      confidence = 0.9;
    } else if (tag === 'article' || el.classList.contains('card') || el.classList.contains('product-card')) {
      type = 'card';
      confidence = 0.85;
    }

    // Extract sanitized semantic hint
    const rawHint =
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el.querySelector('h1, h2, h3, h4, .title')?.textContent || '') ||
      (type === 'button_like' ? el.textContent || '' : '');

    const semanticHint = sanitizeSemanticHint(rawHint);

    regionCounter++;
    regions.push({
      id: `vr-g${pageGeneration}-${regionCounter}`,
      type,
      bbox,
      visible: true,
      confidence,
      pageGeneration,
      source: 'layout', // Honest capability labeling: derived from DOM & layout tree
      semanticHint: semanticHint || undefined,
      associatedElementId: el.id || undefined,
    });
  }

  return regions;
}
