/**
 * PrivAgent — PHASE 17.8 BENCHMARK: shared fixtures.
 *
 * Deterministic constructors for the sanitized types the authorities accept.
 * Every value here is a literal: no clocks, no randomness, no environment. The
 * benchmark must produce identical output on every machine and every run, or it
 * is not evidence of anything.
 */

import type { AgentContextPayload, AgentDetection, DetectionEntityType } from '../../extension/src/privacy/types';
import type { ContainmentScope } from '../../extension/src/agent/containment';
import type { AgentTaskState } from '../../extension/src/agent/agentState';
import type { OCRObservation } from '../../extension/src/ocr/ocrObservationContract';
import type { PreActionSnapshot } from '../../extension/src/agent/effectVerifier';

/** A fixed instant. Nothing in the corpus reads the real clock. */
export const T0 = 1_700_000_000_000;

export function det(
  id: string,
  type: DetectionEntityType,
  over: Partial<AgentDetection> = {},
): AgentDetection {
  return {
    id,
    type,
    confidence: 0.95,
    bbox: { x: 100, y: 150, width: 180, height: 40 },
    length: 12,
    source: 'dom_label',
    selector: `#${id}`,
    is_partially_visible: false,
    ...over,
  };
}

export function ctx(over: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: 'https://shop.example/checkout',
    timestamp: T0,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 0,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    ...over,
  };
}

/**
 * `verifyTaskGoal` reads a handful of fields off the task state. The benchmark
 * builds exactly those, so a state impossible to construct in production is
 * never accidentally exercised.
 */
export function state(over: Partial<AgentTaskState> = {}): AgentTaskState {
  return {
    taskGoal: '',
    normalizedGoal: '',
    targetTabId: null,
    windowId: null,
    currentPageGeneration: 1,
    pageType: 'unknown',
    taskConstraints: {},
    pendingSubgoals: [],
    completedSteps: [],
    recentActions: [],
    lastAction: null,
    lastActionResult: null,
    expectedStateChange: null,
    steps: [],
    candidates: [],
    previousActions: [],
    visitedElementIds: [],
    currentUrl: '',
    initialScrollY: 0,
    observedScrollY: 0,
    ...over,
  } as unknown as AgentTaskState;
}

export const scope = (over: Partial<ContainmentScope> = {}): ContainmentScope => ({
  rootHost: 'shop.example',
  origin: 'https://shop.example',
  tabId: 7,
  dashboardOrigin: 'http://localhost:5173',
  ...over,
});

/**
 * A complete, valid OBSERVED screenshot provenance block. Individual cases
 * override exactly the field they are testing and nothing else, so a case can
 * never be passing for a reason other than the one it names.
 */
export function provenance(over: Partial<OCRObservation['provenance']> = {}): NonNullable<OCRObservation['provenance']> {
  return {
    tabId: 7,
    documentUrl: 'https://shop.example/checkout',
    pageGeneration: 3,
    capturedAt: T0,
    screenshotDimensions: { width: 1280, height: 800 },
    viewportGeometry: {
      viewportWidth: 1280,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 2,
    },
    scaleFactors: { scaleX: 1, scaleY: 1 },
    ...over,
  };
}

export function ocrObs(over: Partial<OCRObservation> = {}): OCRObservation {
  return {
    state: 'OBSERVED',
    provenance: provenance(),
    completedAt: T0,
    totalTokensScanned: 128,
    sensitiveRegionsCount: 1,
    safeRegionsCount: 12,
    ocrLatencyMs: 41,
    ...over,
  };
}

/** The canonical "everything really was read" snapshot. */
export const snapBase: PreActionSnapshot = {
  url: 'https://shop.example/checkout',
  scrollX: 0,
  scrollY: 0,
  domElementCount: 40,
  openModalsCount: 0,
  targetValueLength: 0,
  activeElementSelector: '',
  timestamp: T0,
};

export const ALL_OBSERVED = {
  url: 'OBSERVED',
  scrollX: 'OBSERVED',
  scrollY: 'OBSERVED',
  targetValueLength: 'OBSERVED',
  openModalsCount: 'OBSERVED',
  activeElementSelector: 'OBSERVED',
  domElementCount: 'OBSERVED',
} as const;

export const ALL_UNAVAILABLE = {
  url: 'OBSERVED',
  scrollX: 'UNAVAILABLE',
  scrollY: 'UNAVAILABLE',
  targetValueLength: 'UNAVAILABLE',
  openModalsCount: 'UNAVAILABLE',
  activeElementSelector: 'UNAVAILABLE',
  domElementCount: 'UNAVAILABLE',
} as const;
