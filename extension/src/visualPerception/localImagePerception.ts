/**
 * PrivAgent 2.0 — Local Image & Object Perception (Subphase P2.3)
 *
 * Implements a pluggable local visual perception abstraction (LocalVisionProvider)
 * that produces structured image and visual object findings.
 *
 * HONEST CAPABILITY INVARIANTS:
 *  1. No False Claims: Deterministic DOM & layout signals (dimensions, aspect ratio,
 *     roles, alt attributes) are explicitly stamped with source: 'layout'.
 *  2. True Vision Isolation: True pixel/model recognition is separated behind the
 *     LocalVisionProvider interface.
 *  3. Zero Remote Inference: Remote reasoners (Groq) are NEVER used for visual perception.
 *  4. Generation Stamped: All findings contain pageGeneration for stale invalidation.
 */

import { ImageFinding, ImageFindingType, LocalScreenshot, PerceptionSource } from './visualTypes';
import { isElementVisible } from '../content/domInteractiveScanner';

export interface VisualPerceptionInput {
  pageGeneration: number;
  root?: Document | HTMLElement;
  screenshot?: LocalScreenshot;
}

export interface LocalVisionProvider {
  detect(input: VisualPerceptionInput): Promise<ImageFinding[]>;
}

function getBbox(el: HTMLElement): [number, number, number, number] {
  if (typeof el.getBoundingClientRect !== 'function') return [0, 0, 0, 0];
  const rect = el.getBoundingClientRect();
  const scrollX = typeof window !== 'undefined' ? window.scrollX || 0 : 0;
  const scrollY = typeof window !== 'undefined' ? window.scrollY || 0 : 0;
  return [
    Math.max(0, Math.round(rect.left + scrollX)),
    Math.max(0, Math.round(rect.top + scrollY)),
    Math.max(0, Math.round(rect.width)),
    Math.max(0, Math.round(rect.height)),
  ];
}

const SENSITIVE_PATTERN = /\b(password|passwd|secret|pin|cvv|cvc|token|card|pan|otp)\b/i;

function sanitizeImageLabel(label: string): string {
  if (!label) return '';
  const clean = label.trim().replace(/\s+/g, ' ').slice(0, 50);
  if (SENSITIVE_PATTERN.test(clean)) {
    return 'Protected Credential Asset';
  }
  return clean;
}

/**
 * Deterministic Layout Vision Provider
 * Extracts visual findings from layout, dimensions, CSS rules, and semantic attributes.
 * Stamped explicitly with source: 'layout'.
 */
export class DeterministicLayoutVisionProvider implements LocalVisionProvider {
  public async detect(input: VisualPerceptionInput): Promise<ImageFinding[]> {
    const { pageGeneration } = input;
    const doc = input.root
      ? 'defaultView' in input.root
        ? (input.root as Document)
        : input.root.ownerDocument || document
      : document;

    const rootEl = input.root
      ? 'defaultView' in input.root
        ? (input.root as Document).body || (input.root as Document).documentElement
        : (input.root as HTMLElement)
      : doc.body || doc.documentElement;

    if (!rootEl) return [];

    const findings: ImageFinding[] = [];
    let counter = 0;

    // Scan visual image-bearing elements
    const candidates = Array.from(
      rootEl.querySelectorAll<HTMLElement>('img, svg, picture, [role="img"], figure')
    );

    for (const el of candidates) {
      if (!el.isConnected || !isElementVisible(el)) continue;

      const bbox = getBbox(el);
      const width = bbox[2];
      const height = bbox[3];
      if (width < 6 || height < 6) continue; // Skip microscopic icons

      const aspect = height > 0 ? width / height : 1;
      const tag = el.tagName.toLowerCase();
      const alt = (el.getAttribute('alt') || el.getAttribute('aria-label') || '').toLowerCase();
      const classId = `${el.className || ''} ${el.id || ''}`.toLowerCase();

      let type: ImageFindingType = 'product_image';
      let confidence = 0.8;

      // Classification heuristics based on layout and attributes
      if (width <= 48 && height <= 48 && (tag === 'svg' || classId.includes('icon') || alt.includes('icon'))) {
        type = 'icon';
        confidence = 0.9;
      } else if (classId.includes('logo') || alt.includes('logo') || el.closest('header, nav')) {
        type = 'logo';
        confidence = 0.85;
      } else if (
        aspect >= 0.75 &&
        aspect <= 1.33 &&
        width <= 96 &&
        (classId.includes('avatar') || classId.includes('profile') || alt.includes('avatar') || alt.includes('profile'))
      ) {
        type = 'avatar';
        confidence = 0.88;
      } else if (aspect >= 2.5 && width >= 300) {
        type = 'banner';
        confidence = 0.85;
      } else if (el.closest('button, a, [role="button"]') || classId.includes('btn') || classId.includes('button')) {
        type = 'visual_control';
        confidence = 0.9;
      } else if (el.closest('article, .card, .product-card')) {
        type = 'product_image';
        confidence = 0.85;
      }

      counter++;
      const rawLabel = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const sanitized = sanitizeImageLabel(rawLabel);

      findings.push({
        id: `img-g${pageGeneration}-${counter}`,
        type,
        bbox,
        confidence,
        pageGeneration,
        source: 'layout', // Honest capability labeling: derived from DOM & layout geometry
        associatedElementId: el.id || undefined,
        label: sanitized || undefined,
      });
    }

    return findings;
  }
}

/** Active LocalVisionProvider singleton */
let activeVisionProvider: LocalVisionProvider = new DeterministicLayoutVisionProvider();

export function setLocalVisionProvider(provider: LocalVisionProvider): void {
  activeVisionProvider = provider;
}

export function getLocalVisionProvider(): LocalVisionProvider {
  return activeVisionProvider;
}

export async function detectVisualObjects(input: VisualPerceptionInput): Promise<ImageFinding[]> {
  return activeVisionProvider.detect(input);
}
