/**
 * PrivAgent — Phase 11 Acceptance Suite: shared harness
 *
 * Provides strictly sanitized agent-context fixtures and a jsdom harness that
 * drives the REAL content-script executor (extension/src/content/contentScript.ts)
 * rather than a mock. Nothing here relaxes a production behaviour: the only
 * shims are for APIs jsdom does not implement (scrollIntoView) and for the
 * chrome.runtime surface the content script registers at import time.
 */

import { vi } from 'vitest';
import type {
  AgentContextPayload,
  AgentDetection,
  DetectionEntityType,
} from '../../extension/src/privacy/types';
import type { PreActionSnapshot, PostActionSnapshot } from '../../extension/src/agent/effectVerifier';
import type { ActionExecutionResult } from '../../extension/src/agent/actionTypes';

export function det(
  id: string,
  type: DetectionEntityType,
  selector: string,
  bbox: [number, number, number, number] = [20, 20, 160, 32],
  label?: string
): AgentDetection {
  return {
    id,
    type,
    selector,
    confidence: 0.95,
    bbox: { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Strictly sanitized agent context. NEVER contains raw values — only metadata,
 * exactly as buildAgentPayload() guarantees.
 */
export function ctx(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: 'https://example.com/search',
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 12,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 3, sensitive_detected: 0, latency_ms: 9 },
    detections: [
      det('search-box', 'search', 'input#q'),
      det('submit-button', 'button', 'button#go'),
      det('colour-select', 'select', 'select#colour'),
      det('results-link', 'link', 'a#result-1', [20, 200, 200, 40]),
    ],
    ...overrides,
  };
}

export function snapshot(
  over: Partial<PreActionSnapshot & PostActionSnapshot> = {}
): PostActionSnapshot {
  return {
    url: 'https://example.com/search',
    scrollX: 0,
    scrollY: 0,
    domElementCount: 4,
    openModalsCount: 0,
    activeElementSelector: 'body',
    targetValueLength: 0,
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

// ── DOM harness ──────────────────────────────────────────────────────────────

export type ContentScriptModule = typeof import('../../extension/src/content/contentScript');

let cached: ContentScriptModule | null = null;

/**
 * Import the production content script once per test file. Only the extension
 * messaging surface and scrollIntoView (absent in jsdom) are shimmed.
 */
export async function loadContentScript(): Promise<ContentScriptModule> {
  if (cached) return cached;

  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: () => undefined },
      getManifest: () => ({ version: '11.0.0' }),
      sendMessage: () => undefined,
      lastError: undefined,
    },
  });

  const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
  if (typeof proto.scrollIntoView !== 'function') {
    proto.scrollIntoView = function scrollIntoView(): void {};
  }

  cached = await import('../../extension/src/content/contentScript');
  return cached;
}

export function stubRect(
  el: HTMLElement,
  rect: { top: number; left: number; width: number; height: number }
): void {
  el.getBoundingClientRect = () =>
    ({
      x: rect.left,
      y: rect.top,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** A plainly visible, enabled, in-viewport control. */
export function addControl(
  id: string,
  tag: 'button' | 'input' | 'select' | 'a' | 'div',
  rect = { top: 100, left: 20, width: 160, height: 32 }
): HTMLElement {
  const el = document.createElement(tag) as HTMLElement;
  el.id = id;
  document.body.appendChild(el);
  stubRect(el, rect);
  return el;
}

export function resetDom(): void {
  document.body.innerHTML = '';
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/**
 * Assert that an executed action failed closed and return its error code.
 * The executor returns a discriminated union, so this keeps the failure-code
 * assertions explicit and type-safe instead of reaching into a possibly
 * successful branch.
 */
export function failureCode(res: ActionExecutionResult): string {
  if (res.success) {
    throw new Error(`expected the action to fail closed, got: ${res.message ?? 'success'}`);
  }
  return res.error;
}
