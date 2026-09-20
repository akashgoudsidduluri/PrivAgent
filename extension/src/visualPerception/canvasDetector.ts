/**
 * PrivAgent 2.0 — Canvas & Image-Only UI Detection (Subphase P2.4)
 *
 * Detects visual interactive content that lacks rich DOM semantics:
 *  - Canvas-based controls & chart regions
 *  - Image-only buttons and icon links lacking accessible text
 *  - Visual-only interactive candidates
 *
 * CRITICAL PRIVACY & HONESTY INVARIANTS:
 *  1. No Raw OCR in CanvasFinding: Uses detectedText: boolean and
 *     textSensitivity: 'safe' | 'sensitive' | 'unknown'. Never stores raw text previews.
 *  2. No Fabricated Certainty: Unclear visual areas are classified as 'unknown'.
 *  3. Generation Stamped: All findings contain pageGeneration.
 *  4. Honest Perception Source: DOM/layout mapped controls are stamped source: 'layout'.
 */

import {
  CanvasFinding,
  VisualInteractiveCandidate,
  VisualInteractiveCandidateType,
} from './visualTypes';
import { isElementVisible } from '../content/domInteractiveScanner';

export interface DetectCanvasAndImageUIOptions {
  pageGeneration: number;
  root?: Document | HTMLElement;
  maxFindings?: number;
}

export interface CanvasAndImageUIReport {
  canvasFindings: CanvasFinding[];
  interactiveCandidates: VisualInteractiveCandidate[];
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

function sanitizeLabel(label: string): string {
  if (!label) return '';
  const clean = label.trim().replace(/\s+/g, ' ').slice(0, 50);
  if (SENSITIVE_PATTERN.test(clean)) {
    return 'Protected Credential Control';
  }
  return clean;
}

/**
 * Detects canvases, chart regions, image-only buttons, and visual interactive candidates.
 */
export function detectCanvasAndImageUI(
  options: DetectCanvasAndImageUIOptions
): CanvasAndImageUIReport {
  const { pageGeneration, maxFindings = 50 } = options;
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

  if (!rootEl) return { canvasFindings: [], interactiveCandidates: [] };

  const canvasFindings: CanvasFinding[] = [];
  const interactiveCandidates: VisualInteractiveCandidate[] = [];
  let candidateCounter = 0;
  let canvasCounter = 0;

  // 1. Scan Canvas Elements
  const canvases = Array.from(rootEl.querySelectorAll<HTMLCanvasElement>('canvas'));
  for (const canvas of canvases) {
    if (canvasFindings.length >= maxFindings) break;
    if (!canvas.isConnected || !isElementVisible(canvas)) continue;

    const bbox = getBbox(canvas);
    if (bbox[2] < 10 || bbox[3] < 10) continue;

    const classId = `${canvas.className || ''} ${canvas.id || ''}`.toLowerCase();
    const role = canvas.getAttribute('role') || '';
    const isChartOrGraphic =
      role === 'img' ||
      role === 'graphics-document' ||
      classId.includes('chart') ||
      classId.includes('graph') ||
      classId.includes('plot');

    const hasInteractiveElements =
      canvas.hasAttribute('tabindex') ||
      role === 'button' ||
      classId.includes('btn') ||
      Boolean(canvas.onclick);

    // Assess text presence & sensitivity without storing raw text
    const ariaLabel = (canvas.getAttribute('aria-label') || '').toLowerCase();
    const detectedText = ariaLabel.length > 0 || classId.includes('label');
    const textSensitivity = SENSITIVE_PATTERN.test(ariaLabel) ? 'sensitive' : detectedText ? 'safe' : 'unknown';

    canvasCounter++;
    const canvasId = `canvas-g${pageGeneration}-${canvasCounter}`;
    const localCandidates: VisualInteractiveCandidate[] = [];

    if (hasInteractiveElements) {
      candidateCounter++;
      const candType: VisualInteractiveCandidateType = role === 'button' ? 'canvas_button' : 'visual_control';
      const rawLabel = canvas.getAttribute('aria-label') || canvas.getAttribute('title') || '';

      const cand: VisualInteractiveCandidate = {
        id: `vic-g${pageGeneration}-${candidateCounter}`,
        type: candType,
        bbox,
        confidence: 0.85,
        pageGeneration,
        source: 'layout',
        suggestedAction: 'click',
        associatedElementId: canvas.id || undefined,
        label: sanitizeLabel(rawLabel) || undefined,
      };
      localCandidates.push(cand);
      interactiveCandidates.push(cand);
    }

    canvasFindings.push({
      id: canvasId,
      bbox,
      hasInteractiveElements,
      detectedText,
      textSensitivity,
      isChartOrGraphic,
      confidence: 0.9,
      pageGeneration,
      source: 'layout',
      associatedElementId: canvas.id || undefined,
      interactiveCandidates: localCandidates,
    });
  }

  // 2. Scan Image-Only UI Controls (buttons/links with images but no text)
  const imageControls = Array.from(
    rootEl.querySelectorAll<HTMLElement>('a, button, [role="button"]')
  );

  for (const control of imageControls) {
    if (interactiveCandidates.length >= maxFindings) break;
    if (!control.isConnected || !isElementVisible(control)) continue;

    // Check if the control has an image child and no visible text
    const text = (control.innerText || control.textContent || '').trim();
    const hasImageChild = control.querySelector('img, svg') !== null;

    if (hasImageChild && text.length === 0) {
      const bbox = getBbox(control);
      if (bbox[2] < 8 || bbox[3] < 8) continue;

      candidateCounter++;
      const rawLabel =
        control.getAttribute('aria-label') ||
        control.getAttribute('title') ||
        control.querySelector('img')?.getAttribute('alt') ||
        '';

      const type: VisualInteractiveCandidateType = 'image_button';

      interactiveCandidates.push({
        id: `vic-g${pageGeneration}-${candidateCounter}`,
        type,
        bbox,
        confidence: 0.88,
        pageGeneration,
        source: 'layout',
        suggestedAction: 'click',
        associatedElementId: control.id || undefined,
        label: sanitizeLabel(rawLabel) || undefined,
      });
    }
  }

  return { canvasFindings, interactiveCandidates };
}
