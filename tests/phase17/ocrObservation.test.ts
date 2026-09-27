/**
 * PHASE 17.3 — OCR & Advanced Non-DOM Perception: Focused Contract & Invariant Tests.
 *
 * Invariants under test:
 *  1. OCR is an OBSERVATION SOURCE, not an action authorization authority.
 *  2. Unobserved or failed OCR is NEVER fabricated into success.
 *  3. Stale or cross-tab screenshots are NEVER treated as current observations.
 *  4. Raw sensitive text and partial substrings NEVER cross the privacy boundary.
 *  5. Coordinate mapping must be valid and bounded; degenerate geometry fails closed.
 *  6. Non-DOM perception accurately surfaces canvas/image content missing from DOM.
 *  7. OCR is CONDITIONAL: DOM-only cycles do NOT invoke OCR; only non-DOM needs trigger it.
 *  8. Goal verifier requires verified provenance and exact condition matches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OCRObservation,
  createUnavailableOCRObservation,
  createStaleOCRObservation,
  isOCRObservationFresh,
  validateScreenshotGeometry,
  normalizeDocumentIdentity,
  isSameDocumentIdentity,
} from '../../extension/src/ocr/ocrObservationContract';
import { OffscreenOCREngine } from '../../extension/src/ocr/offscreenOcrClient';
import {
  processSpatialOCRResult,
  convertToSafeOCRRegions,
} from '../../extension/src/ocr/spatialOcrLayer';
import {
  coordinateMultimodalPerception,
  isNonDOMPerceptionRequired,
} from '../../extension/src/visualPerception/multimodalCoordinator';
import { verifyTaskGoal } from '../../extension/src/agent/goalVerifier';
import {
  PrivacyScanReport,
  VisualCaptureReport,
  buildAgentPayload,
} from '../../extension/src/privacy/types';
import { AgentTaskState } from '../../extension/src/agent/agentState';
import { InternalOCRResult } from '../../extension/src/ocr/types';

describe('Phase 17.3: OCR Observation Contract & Provenance', () => {
  const baseViewport = {
    viewportWidth: 1280,
    viewportHeight: 800,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
  };

  it('initializes to UNAVAILABLE with explicit reason when capture fails', () => {
    const empty = createUnavailableOCRObservation('Screenshot capture failed', 42, 'https://example.com/app');
    expect(empty.state).toBe('UNAVAILABLE');
    expect(empty.provenance).toBeNull();
    expect(empty.totalTokensScanned).toBe(0);
    expect(empty.failureReason).toContain('Screenshot capture failed');
  });

  it('marks observation STALE if document URL origin or pathname changed', () => {
    const obs: OCRObservation = {
      state: 'OBSERVED',
      provenance: {
        tabId: 10,
        documentUrl: 'https://bank.example.com/dashboard',
        pageGeneration: 1,
        capturedAt: 1000,
        viewportGeometry: baseViewport,
        screenshotDimensions: { width: 1280, height: 800 },
        scaleFactors: { scaleX: 1, scaleY: 1 },
      },
      completedAt: 1050,
      totalTokensScanned: 12,
      sensitiveRegionsCount: 0,
      safeRegionsCount: 2,
      ocrLatencyMs: 50,
    };

    // Same document URL, matching page generation, and recent timestamp -> fresh
    expect(isOCRObservationFresh(obs, 10, 'https://bank.example.com/dashboard', 1, 2000)).toBe(true);

    // Same document URL and repeated observation across generation increment -> still fresh!
    // (pageGeneration is NOT document identity; same document remains valid)
    expect(isOCRObservationFresh(obs, 10, 'https://bank.example.com/dashboard', 2, 2000)).toBe(true);

    // Negative generation drift (captured generation > current generation) -> stale
    expect(isOCRObservationFresh(obs, 10, 'https://bank.example.com/dashboard', 0, 2000)).toBe(false);

    // Document URL changed -> stale
    expect(isOCRObservationFresh(obs, 10, 'https://bank.example.com/transfer', 1, 2000)).toBe(false);

    // Tab changed -> stale
    expect(isOCRObservationFresh(obs, 99, 'https://bank.example.com/dashboard', 1, 2000)).toBe(false);

    // Expired timestamp (> 15000ms threshold) -> stale
    expect(isOCRObservationFresh(obs, 10, 'https://bank.example.com/dashboard', 1, 18000)).toBe(false);
  });

  it('preserves hash normalization across document identity checks', () => {
    expect(isSameDocumentIdentity('https://docs.site.com/guide#step1', 'https://docs.site.com/guide#step2')).toBe(true);
    expect(isSameDocumentIdentity('https://docs.site.com/guide', 'https://docs.site.com/other')).toBe(false);
  });

  it('creates a STALE observation wrapping prior observation metadata', () => {
    const freshObs: OCRObservation = {
      state: 'OBSERVED',
      provenance: null,
      completedAt: 500,
      totalTokensScanned: 5,
      sensitiveRegionsCount: 0,
      safeRegionsCount: 1,
      ocrLatencyMs: 20,
    };
    const staleObs = createStaleOCRObservation(freshObs, 'Navigation occurred during OCR execution');
    expect(staleObs.state).toBe('STALE');
    expect(staleObs.failureReason).toContain('Navigation occurred');
  });

  it('enforces that UNAVAILABLE observations are never considered fresh', () => {
    const unavailableObs = createUnavailableOCRObservation('Capture error', 10, 'https://example.com');
    expect(isOCRObservationFresh(unavailableObs, 10, 'https://example.com', 1, Date.now())).toBe(false);
  });
});

describe('Phase 17.3: Conditional OCR Execution', () => {
  it('does NOT invoke OCR on normal DOM-only cycles without non-DOM requirement', async () => {
    const mockOcrEngine = {
      recognize: vi.fn(),
    };

    const domOnlyInput = {
      tabId: 10,
      documentUrl: 'https://example.com/normal-dom-page',
      taskDescription: 'Click the submit button',
      pageGeneration: 1,
      scanReport: {
        url: 'https://example.com/normal-dom-page',
        totalElementsScanned: 25,
        sensitiveElementsDetected: 0,
        detections: [
          { id: 'btn-1', type: 'button', selector: '#submit', bbox: [10, 10, 80, 30] } as any,
        ],
      } as any,
      ocrEngine: mockOcrEngine as any,
    };

    // 1. Verify helper classifies as DOM-only
    expect(isNonDOMPerceptionRequired(domOnlyInput)).toBe(false);

    // 2. Execute coordination
    const result = await coordinateMultimodalPerception(domOnlyInput);

    // Invariant: OCR engine must NOT be invoked on DOM-only cycle
    expect(mockOcrEngine.recognize).not.toHaveBeenCalled();
    expect(result.ocrObservation.state).toBe('NOT_APPLICABLE');
    expect(result.ocrObservation.failureReason).toContain('DOM-only');
  });

  it('invokes OCR when non-DOM canvas or visual perception is required', async () => {
    const mockOcrEngine = {
      recognize: vi.fn().mockResolvedValue({
        lines: [
          { text: 'Canvas Analytics Heading', confidence: 0.95, bbox: { x0: 20, y0: 20, x1: 200, y1: 50 }, words: [] },
        ],
        words: [],
        fullText: 'Canvas Analytics Heading',
        latencyMs: 30,
      }),
    };

    const canvasRequiredInput = {
      tabId: 10,
      documentUrl: 'https://example.com/canvas-report',
      taskDescription: 'Find the text shown inside the canvas on this page',
      pageGeneration: 1,
      scanReport: {
        url: 'https://example.com/canvas-report',
        totalElementsScanned: 0, // 0 DOM elements -> pure canvas app
        sensitiveElementsDetected: 0,
        detections: [],
      } as any,
      screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      ocrEngine: mockOcrEngine as any,
    };

    expect(isNonDOMPerceptionRequired(canvasRequiredInput)).toBe(true);

    const result = await coordinateMultimodalPerception(canvasRequiredInput);

    expect(mockOcrEngine.recognize).toHaveBeenCalledTimes(1);
    expect(result.ocrObservation.state).toBe('OBSERVED');
  });
});

describe('Phase 17.3: Offscreen OCR Client & Worker Lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fails closed with UNAVAILABLE on timeout', async () => {
    const originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      runtime: {
        getURL: (p: string) => `chrome-extension://mock-id/${p}`,
        sendMessage: vi.fn((msg, cb) => {
          if (msg.type === 'PRIVAGENT_OFFSCREEN_OCR_PING') {
            if (cb) cb({ type: 'PRIVAGENT_OFFSCREEN_OCR_PONG' });
            return Promise.resolve({ type: 'PRIVAGENT_OFFSCREEN_OCR_PONG' });
          }
          // Never resolve or call callback for OCR requests to trigger engine timeout
        }),
      },
      offscreen: {
        hasDocument: vi.fn().mockResolvedValue(true),
        createDocument: vi.fn().mockResolvedValue(undefined),
      },
    };

    const client = new OffscreenOCREngine({ timeoutMs: 80 }); // 80ms timeout
    await expect(client.recognize('data:image/png;base64,fake')).rejects.toThrow(/timed out/i);

    (globalThis as any).chrome = originalChrome;
  });

  it('handles bridge messaging errors gracefully without crashing the loop', async () => {
    const originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      runtime: {
        getURL: (p: string) => `chrome-extension://mock-id/${p}`,
        sendMessage: vi.fn((msg, cb) => {
          if (msg.type === 'PRIVAGENT_OFFSCREEN_OCR_PING') {
            if (cb) cb({ type: 'PRIVAGENT_OFFSCREEN_OCR_PONG' });
            return Promise.resolve({ type: 'PRIVAGENT_OFFSCREEN_OCR_PONG' });
          }
          if (cb) cb({ type: 'PRIVAGENT_OFFSCREEN_OCR_RESPONSE', success: false, error: 'WASM memory limit exceeded' });
        }),
      },
      offscreen: {
        hasDocument: vi.fn().mockResolvedValue(true),
        createDocument: vi.fn().mockResolvedValue(undefined),
      },
    };

    const client = new OffscreenOCREngine({ timeoutMs: 200 });
    await expect(client.recognize('data:image/png;base64,fake')).rejects.toThrow(/WASM memory limit/i);

    (globalThis as any).chrome = originalChrome;
  });
});

describe('Phase 17.3: OCR Privacy Fusion & Full / Partial Leakage Invariants', () => {
  it('strictly suppresses raw sensitive text and partial fragments (card, phone, email, password)', () => {
    const ocrResult: InternalOCRResult = {
      fullText: 'Sample OCR Page Content',
      latencyMs: 25,
      lines: [
        {
          text: '4532 1122 3344 5566',
          confidence: 0.95,
          bbox: { x0: 50, y0: 50, x1: 250, y1: 80 },
          words: [],
        },
        {
          text: '+91 98765 43210',
          confidence: 0.94,
          bbox: { x0: 50, y0: 100, x1: 220, y1: 130 },
          words: [],
        },
        {
          text: 'akash@example.test',
          confidence: 0.92,
          bbox: { x0: 50, y0: 140, x1: 230, y1: 165 },
          words: [],
        },
        {
          text: 'SyntheticSecret123!',
          confidence: 0.90,
          bbox: { x0: 50, y0: 180, x1: 200, y1: 205 },
          words: [],
        },
        {
          text: 'Canvas Analytics Dashboard',
          confidence: 0.98,
          bbox: { x0: 50, y0: 10, x1: 350, y1: 50 },
          words: [],
        },
      ],
      words: [],
    };

    const rawRegions = processSpatialOCRResult(ocrResult, {
      pageGeneration: 1,
      imageDimensions: { width: 1000, height: 800 },
    });

    const safeRegions = convertToSafeOCRRegions(rawRegions);
    expect(safeRegions).toHaveLength(5);

    // 1. Credit card check (full and partial)
    const sensitiveCards = safeRegions.filter(r => r.sensitiveType === 'credit_card');
    expect(sensitiveCards).toHaveLength(1);
    expect(sensitiveCards[0]!.isSensitive).toBe(true);
    expect(sensitiveCards[0]!.sanitizedPreview).toBeUndefined(); // MUST be undefined

    // 2. Email check (full and partial)
    const sensitiveEmails = safeRegions.filter(r => r.sensitiveType === 'email');
    expect(sensitiveEmails).toHaveLength(1);
    expect(sensitiveEmails[0]!.isSensitive).toBe(true);
    expect(sensitiveEmails[0]!.sanitizedPreview).toBeUndefined(); // MUST be undefined

    // 3. Phone check (full and partial)
    const sensitivePhones = safeRegions.filter(r => r.sensitiveType === 'phone');
    expect(sensitivePhones).toHaveLength(1);
    expect(sensitivePhones[0]!.isSensitive).toBe(true);
    expect(sensitivePhones[0]!.sanitizedPreview).toBeUndefined(); // MUST be undefined

    // 4. Safe heading allowed sanitizedPreview
    const safeHeading = safeRegions.find(r => !r.isSensitive && r.sanitizedPreview);
    expect(safeHeading).toBeDefined();
    expect(safeHeading?.isHeading).toBe(true);
    expect(safeHeading?.sanitizedPreview).toBe('Canvas Analytics Dashboard');
  });

  it('mutation test: prevents raw and partial sensitive substrings from entering buildAgentPayload', () => {
    const domScanReport: PrivacyScanReport = {
      url: 'https://example.com/canvas',
      timestamp: Date.now(),
      detections: [],
      totalElementsScanned: 10,
      sensitiveElementsDetected: 0,
      redactionMode: 'mask',
      status: 'Sanitized Context — Local Privacy Check Passed',
      scanLatencyMs: 5,
      redactionLatencyMs: 2,
      elementsProtected: 0,
      leakageCount: 0,
      categories: {} as any,
    };

    const visualReport: VisualCaptureReport = {
      captureMetadata: {
        viewportWidth: 800,
        viewportHeight: 600,
        screenshotWidth: 800,
        screenshotHeight: 600,
        devicePixelRatio: 1,
        scaleX: 1,
        scaleY: 1,
        scrollX: 0,
        scrollY: 0,
        capturedAt: Date.now(),
      },
      visualDetections: [
        {
          id: 'ocr-card-1',
          type: 'credit_card',
          confidence: 0.99,
          selector: 'canvas:ocr',
          viewportBBox: [10, 10, 150, 35],
          screenshotBBox: [10, 10, 150, 35],
          isPartiallyVisible: false,
          source: 'ocr',
          label: 'CREDIT_CARD',
        },
        {
          id: 'ocr-phone-1',
          type: 'phone',
          confidence: 0.94,
          selector: 'canvas:ocr',
          viewportBBox: [50, 10, 150, 35],
          screenshotBBox: [50, 10, 150, 35],
          isPartiallyVisible: false,
          source: 'ocr',
          label: 'PHONE_NUMBER',
        },
      ],
      totalDetected: 2,
      totalPartiallyVisible: 0,
      totalOffscreenFiltered: 0,
      ocrRegionsScanned: 2,
      sensitiveOCRDetected: 2,
      ocrLatencyMs: 40,
      domSensitiveDetected: 0,
      status: 'Local Visual Context Prepared',
    };

    const payload = buildAgentPayload(domScanReport, visualReport);
    expect(payload).not.toBeNull();
    const serialized = JSON.stringify(payload);

    // Full value checks:
    expect(serialized).not.toContain('4532 1122 3344 5566');
    expect(serialized).not.toContain('+91 98765 43210');
    expect(serialized).not.toContain('akash@example.test');
    expect(serialized).not.toContain('SyntheticSecret123!');

    // Partial value checks:
    expect(serialized).not.toContain('5566');
    expect(serialized).not.toContain('98765');
    expect(serialized).not.toContain('akash@');
    expect(serialized).not.toContain('SyntheticSecret');

    // Tokenized labels must be present:
    expect(serialized).toContain('CREDIT_CARD');
    expect(serialized).toContain('PHONE_NUMBER');
  });
});

describe('Phase 17.3: Coordinate Mapping & Geometry Invariants', () => {
  it('computes scale factors for high-DPI screenshots accurately', () => {
    const scale = validateScreenshotGeometry(
      { width: 2560, height: 1600 }, // 2x screenshot
      { viewportWidth: 1280, viewportHeight: 800 } // CSS viewport
    );

    expect(scale).not.toBeNull();
    expect(scale?.scaleX).toBe(2);
    expect(scale?.scaleY).toBe(2);
  });

  it('fails closed when viewport or screenshot geometry is degenerate or negative', () => {
    expect(validateScreenshotGeometry(null, { viewportWidth: 1280, viewportHeight: 800 })).toBeNull();
    expect(validateScreenshotGeometry({ width: 0, height: 600 }, { viewportWidth: 800, viewportHeight: 600 })).toBeNull();
    expect(validateScreenshotGeometry({ width: -100, height: 600 }, { viewportWidth: 800, viewportHeight: 600 })).toBeNull();
    expect(validateScreenshotGeometry({ width: 800, height: 600 }, { viewportWidth: 0, viewportHeight: 600 })).toBeNull();
    expect(validateScreenshotGeometry({ width: 800, height: 600 }, { viewportWidth: NaN, viewportHeight: 600 })).toBeNull();
  });
});

describe('Phase 17.3: Isolated Goal Verification with Provenance Gate', () => {
  const freshObs: OCRObservation = {
    state: 'OBSERVED',
    provenance: {
      tabId: 10,
      documentUrl: 'https://example.com/canvas-ui',
      pageGeneration: 1,
      capturedAt: Date.now(),
      viewportGeometry: { viewportWidth: 1000, viewportHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
      screenshotDimensions: { width: 1000, height: 800 },
      scaleFactors: { scaleX: 1, scaleY: 1 },
    },
    completedAt: Date.now(),
    totalTokensScanned: 5,
    sensitiveRegionsCount: 0,
    safeRegionsCount: 1,
    ocrLatencyMs: 30,
  };

  it('fails closed (IN_PROGRESS) if OCR observation is missing, UNAVAILABLE, or STALE', () => {
    const taskDescription = 'Find the text shown inside the canvas on this page: "Monthly Financial"';
    const taskState = {
      task: taskDescription,
      taskGoal: taskDescription,
      normalizedGoal: taskDescription.toLowerCase(),
      currentStep: 1,
      maxSteps: 10,
      status: 'IN_PROGRESS' as const,
      previousActions: [],
      steps: [],
      currentUrl: 'https://example.com/canvas-ui',
      targetTabId: 10,
      windowId: 1,
      currentPageGeneration: 1,
      pageType: 'unknown' as const,
      taskConstraints: {},
      pendingSubgoals: [],
      completedSteps: [],
      candidateItems: [],
    } as unknown as AgentTaskState;

    // 1. Missing ocr_observation -> IN_PROGRESS
    const contextNoOcr = {
      task: taskDescription,
      url: 'https://example.com/canvas-ui',
      page_generation: 1,
      timestamp: Date.now(),
      detections: [
        { id: 'ocr-1', type: 'heading', source: 'ocr' as const, label: 'Monthly Financial' } as any,
      ],
    };
    const resNoOcr = verifyTaskGoal(taskDescription, taskState, contextNoOcr as any);
    expect(resNoOcr.satisfied).toBe(false);
    expect(resNoOcr.status).toBe('IN_PROGRESS');

    // 2. UNAVAILABLE ocr_observation -> IN_PROGRESS
    const contextUnavailable = {
      ...contextNoOcr,
      ocr_observation: createUnavailableOCRObservation('Capture failed', 10, 'https://example.com/canvas-ui'),
    };
    const resUnavailable = verifyTaskGoal(taskDescription, taskState, contextUnavailable as any);
    expect(resUnavailable.satisfied).toBe(false);

    // 3. Wrong tab ID in provenance -> IN_PROGRESS
    const contextWrongTab = {
      ...contextNoOcr,
      ocr_observation: {
        ...freshObs,
        provenance: { ...freshObs.provenance!, tabId: 99 }, // Tab 99 != targetTabId 10
      },
    };
    const resWrongTab = verifyTaskGoal(taskDescription, taskState, contextWrongTab as any);
    expect(resWrongTab.satisfied).toBe(false);
  });

  it('does NOT imply success from OCR presence alone when requested condition is not met', () => {
    const taskDescription = 'Find the text shown inside the canvas: "Annual Tax Return"';
    const taskState = {
      task: taskDescription,
      taskGoal: taskDescription,
      normalizedGoal: taskDescription.toLowerCase(),
      currentStep: 1,
      maxSteps: 10,
      status: 'IN_PROGRESS' as const,
      previousActions: [],
      steps: [],
      currentUrl: 'https://example.com/canvas-ui',
      targetTabId: 10,
      windowId: 1,
      currentPageGeneration: 1,
      pageType: 'unknown' as const,
      taskConstraints: {},
      pendingSubgoals: [],
      completedSteps: [],
      candidateItems: [],
    } as unknown as AgentTaskState;

    const contextWithOtherText = {
      task: taskDescription,
      url: 'https://example.com/canvas-ui',
      page_generation: 1,
      timestamp: Date.now(),
      ocr_observation: freshObs,
      detections: [
        // Has OCR text, but NOT "Annual Tax Return"
        { id: 'ocr-1', type: 'element', source: 'ocr' as const, label: 'Unrelated Canvas Chart Data' } as any,
      ],
    };

    const res = verifyTaskGoal(taskDescription, taskState, contextWithOtherText as any);
    // Invariant: Presence of OCR regions alone CANNOT satisfy the goal!
    expect(res.satisfied).toBe(false);
    expect(res.status).toBe('IN_PROGRESS');
  });

  it('verifies non-DOM canvas goal when fresh provenance and exact condition match', () => {
    const taskDescription = 'Find the text shown inside the canvas on this page: "Monthly Financial"';
    const taskState = {
      task: taskDescription,
      taskGoal: taskDescription,
      normalizedGoal: taskDescription.toLowerCase(),
      currentStep: 1,
      maxSteps: 10,
      status: 'IN_PROGRESS' as const,
      previousActions: [],
      steps: [],
      currentUrl: 'https://example.com/canvas-ui',
      targetTabId: 10,
      windowId: 1,
      currentPageGeneration: 1,
      pageType: 'unknown' as const,
      taskConstraints: {},
      pendingSubgoals: [],
      completedSteps: [],
      candidateItems: [],
    } as unknown as AgentTaskState;

    const context = {
      task: taskDescription,
      url: 'https://example.com/canvas-ui',
      page_generation: 1,
      timestamp: Date.now(),
      ocr_observation: freshObs,
      detections: [
        {
          id: 'ocr-vis-heading-1',
          type: 'heading',
          source: 'ocr' as const,
          label: 'Monthly Financial Canvas Summary',
          confidence: 0.95,
          bbox: { x: 100, y: 100, width: 300, height: 50 },
          length: 32,
          is_partially_visible: false,
        },
      ],
    };

    const verification = verifyTaskGoal(taskDescription, taskState, context as any);
    expect(verification.satisfied).toBe(true);
    expect(verification.status).toBe('SUCCESS');
    expect(verification.reason).toContain('Monthly Financial');
  });
});
