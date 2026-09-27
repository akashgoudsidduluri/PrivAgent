/**
 * PrivAgent 2.0 — Multimodal Perception Coordinator (Phase 7.5 Stage 3)
 *
 * Coordinates live multimodal perception for the autonomous AgentLoop:
 *   1. Captures live viewport screenshot via Chrome MV3 tabs API or active provider
 *   2. Extracts authoritative bitmap dimensions deterministically
 *   3. Maps DOM detections to screenshot coordinates using coordinateMapper
 *   4. Runs local OCR (or spatial OCR layer) with strict privacy scrubbing
 *   5. Executes M8 privacy fusion across DOM, OCR, and visual signals
 *   6. Enriches BrowserWorldModel with SafeOCRRegions and PrivacyFindings
 *   7. Produces a validated VisualCaptureReport for canonical AgentContextPayload
 *
 * Security & Privacy Invariants:
 *  - Raw screenshot data URLs NEVER leave local memory and are never sent to remote LLMs.
 *  - Sensitive visual text (cards, CVVs, passwords, PANs, OTPs) is scrubbed locally.
 *  - All visual candidates and OCR regions are stamped with pageGeneration.
 *  - Zero raw PII crosses the boundary to cloud reasoning gateways (M8 firewall).
 */

import {
  ActualScreenshotDimensions,
  mapDOMToScreenshot,
  ViewportGeometry,
} from '../capture/coordinateMapper';
import {
  CaptureMetadata,
  PrivacyScanReport,
  VisualCaptureReport,
  VisualDetectionResult,
  isSensitiveEntityType,
} from '../privacy/types';
import {
  candidateFromContextualDetection,
  candidateFromDOMPageDetection,
  candidateFromOCRDetection,
  candidateFromVisualDetection,
  fusePrivacyFindings,
  PrivacyFinding,
} from '../privacy/fusion';
import {
  ContextualOcrFinding,
  defaultContextualDetector,
  detectContextualInOcr,
} from '../privacy/contextualPii';
import {
  convertToSafeOCRRegions,
  processSpatialOCRResult,
  OCRRegion,
} from '../ocr/spatialOcrLayer';
import { SafeOCRRegion, BrowserWorldModel } from '../worldModel/types';
import { OCREngine, InternalOCRResult } from '../ocr/types';
import {
  OCRObservation,
  createUnavailableOCRObservation,
  validateScreenshotGeometry,
} from '../ocr/ocrObservationContract';
import { getScreenshotProvider } from './screenshotCapture';
import { LocalScreenshot } from './visualTypes';

export interface MultimodalPerceptionInput {
  tabId?: number;
  windowId?: number;
  documentUrl?: string;
  taskDescription?: string;
  requireOCR?: boolean;
  scanReport: PrivacyScanReport;
  pageGeneration: number;
  geometry?: ViewportGeometry;
  ocrEngine?: OCREngine;
  screenshotDataUrl?: string;
  isDashboardUrl?: (url: string) => boolean;
}

/**
 * Determines whether a perception cycle requires non-DOM visual / OCR perception.
 * Invariant: OCR must NOT become mandatory on every agent cycle.
 * Normal DOM-only cycles skip OCR execution to eliminate unnecessary latency.
 */
export function isNonDOMPerceptionRequired(input: MultimodalPerceptionInput): boolean {
  if (input.requireOCR === true) return true;
  if (input.requireOCR === false) return false;

  // 1. Task instruction checks: does the task ask to read visual / canvas / image text?
  const task = (input.taskDescription || '').toLowerCase();
  if (
    task.includes('canvas') ||
    task.includes('image') ||
    task.includes('visually') ||
    task.includes('visual') ||
    task.includes('rendered text') ||
    task.includes('receipt') ||
    task.includes('invoice') ||
    task.includes('statement') ||
    task.includes('screenshot') ||
    task.includes('chart')
  ) {
    return true;
  }

  // 2. DOM evidence checks: pure canvas or non-DOM page (0 DOM elements scanned)
  const totalDom = input.scanReport?.totalElementsScanned ?? 0;
  if (totalDom === 0) {
    return true;
  }

  // 3. Canvas elements or non-text visual containers detected on the page
  const detections = input.scanReport?.detections || [];
  const hasCanvasElement = detections.some(
    (d) => d.selector?.includes('canvas') || (d as any).tagName === 'CANVAS'
  );
  if (hasCanvasElement) {
    return true;
  }

  return false;
}

export interface MultimodalCoordinationResult {
  visualReport: VisualCaptureReport;
  ocrRegions: SafeOCRRegion[];
  privacyFindings: PrivacyFinding[];
  screenshotDimensions: ActualScreenshotDimensions;
  scaleFactors: { scaleX: number; scaleY: number };
  ocrObservation: OCRObservation;
}

/**
 * Extracts width and height directly from PNG image binary headers in 0.001 ms.
 * Avoids any dependency on DOM `Image` or browser canvas elements.
 */
export function getPngDimensions(dataUrl: string): ActualScreenshotDimensions | null {
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
    return null;
  }
  try {
    const base64 = dataUrl.slice(22, 60);
    const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
    const bytes = new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
    const view = new DataView(bytes.buffer);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) {
      return { screenshotWidth: width, screenshotHeight: height };
    }
  } catch {
    // Fall back to null if parsing fails
  }
  return null;
}

/**
 * Resolves authoritative screenshot dimensions from data URL or viewport geometry.
 */
export function resolveScreenshotDimensions(
  dataUrl?: string | null,
  geometry?: ViewportGeometry | null
): ActualScreenshotDimensions {
  if (dataUrl) {
    const parsed = getPngDimensions(dataUrl);
    if (parsed) return parsed;
  }

  const dpr = geometry?.devicePixelRatio || 1;
  const w = Math.round((geometry?.viewportWidth || 1280) * dpr);
  const h = Math.round((geometry?.viewportHeight || 800) * dpr);
  return { screenshotWidth: w, screenshotHeight: h };
}

/**
 * Executes the complete Stage 3 Multimodal Perception cycle.
 */
export async function coordinateMultimodalPerception(
  input: MultimodalPerceptionInput
): Promise<MultimodalCoordinationResult> {
  const { scanReport, pageGeneration } = input;
  const startTime = Date.now();

  // 1. Resolve Viewport Geometry
  const geometry: ViewportGeometry = input.geometry || {
    viewportWidth: typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280,
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight || 800 : 800,
    scrollX: typeof window !== 'undefined' ? window.scrollX || 0 : 0,
    scrollY: typeof window !== 'undefined' ? window.scrollY || 0 : 0,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  };

  // Check target tab provenance: NEVER capture or OCR the dashboard
  if (input.documentUrl && input.isDashboardUrl?.(input.documentUrl)) {
    const reason = 'Screenshot capture rejected: target tab is the dashboard';
    console.warn(`[MultimodalCoordinator] ${reason}`);
    const emptyDimensions = { screenshotWidth: geometry.viewportWidth, screenshotHeight: geometry.viewportHeight };
    const visualReport: VisualCaptureReport = {
      captureMetadata: {
        viewportWidth: geometry.viewportWidth,
        viewportHeight: geometry.viewportHeight,
        screenshotWidth: emptyDimensions.screenshotWidth,
        screenshotHeight: emptyDimensions.screenshotHeight,
        devicePixelRatio: geometry.devicePixelRatio,
        scaleX: 1,
        scaleY: 1,
        scrollX: geometry.scrollX,
        scrollY: geometry.scrollY,
        capturedAt: startTime,
      },
      visualDetections: [],
      totalDetected: 0,
      totalPartiallyVisible: 0,
      totalOffscreenFiltered: 0,
      ocrRegionsScanned: 0,
      sensitiveOCRDetected: 0,
      ocrLatencyMs: 0,
      domSensitiveDetected: scanReport.sensitiveElementsDetected,
      status: 'Local Visual Context Prepared',
    };
    return {
      visualReport,
      ocrRegions: [],
      privacyFindings: [],
      screenshotDimensions: emptyDimensions,
      scaleFactors: { scaleX: 1, scaleY: 1 },
      ocrObservation: createUnavailableOCRObservation(reason, input.tabId, input.documentUrl),
    };
  }

  // 2. Obtain Visual Screenshot (Local Isolated Memory)
  const isRequired = isNonDOMPerceptionRequired(input);
  // If screenshotDataUrl was explicitly provided by caller (e.g. direct test or manual capture), honor it; otherwise strictly gate on non-DOM necessity
  const needsOCR = isRequired || Boolean(input.screenshotDataUrl);
  let screenshotDataUrl = input.screenshotDataUrl || null;
  let localScreenshot: LocalScreenshot | null = null;

  // On DOM-only cycles where non-DOM perception is not required, skip screenshot capture
  if (!screenshotDataUrl && needsOCR) {
    if (
      typeof chrome !== 'undefined' &&
      chrome.tabs &&
      typeof chrome.tabs.captureVisibleTab === 'function' &&
      input.windowId !== undefined
    ) {
      try {
        screenshotDataUrl = await new Promise<string | null>((resolve) => {
          chrome.tabs.captureVisibleTab(
            input.windowId!,
            { format: 'png' },
            (dataUrl) => {
              if (chrome.runtime?.lastError || !dataUrl) {
                resolve(null);
              } else {
                resolve(dataUrl);
              }
            }
          );
        });
      } catch (err) {
        console.warn('[MultimodalCoordinator] captureVisibleTab failed:', err);
      }
    }

    if (!screenshotDataUrl) {
      try {
        localScreenshot = await getScreenshotProvider().captureViewport({
          pageGeneration,
          format: 'png',
        });
        screenshotDataUrl = localScreenshot.getRawDataUrl();
      } catch {
        // Screenshot capture failed: leave null (do NOT fabricate a fake blank image)
        screenshotDataUrl = null;
      }
    }
  }

  // 3. Resolve Authoritative Dimensions
  const screenshotDimensions = resolveScreenshotDimensions(screenshotDataUrl, geometry);
  const geoValidation = validateScreenshotGeometry(screenshotDimensions, geometry);
  const scaleX = geoValidation ? geoValidation.scaleX : 1;
  const scaleY = geoValidation ? geoValidation.scaleY : 1;

  // 4. Map DOM Detections to Visual Coordinates
  const visualDetections: VisualDetectionResult[] = [];
  let totalPartiallyVisible = 0;
  let totalOffscreenFiltered = 0;

  const rawDetections = scanReport?.detections || [];
  for (const det of rawDetections) {
    if (!isSensitiveEntityType(det.type)) {
      continue;
    }
    const mapped = mapDOMToScreenshot(det.bbox, geometry, screenshotDimensions, true);
    if (!mapped) {
      totalOffscreenFiltered++;
      continue;
    }

    if (mapped.isPartiallyVisible) {
      totalPartiallyVisible++;
    }

    visualDetections.push({
      id: det.id,
      type: det.type,
      confidence: det.confidence,
      selector: det.selector,
      viewportBBox: mapped.viewportBBox,
      screenshotBBox: mapped.screenshotBBox,
      isPartiallyVisible: mapped.isPartiallyVisible,
      source: det.source,
    });
  }

  // 5. Local OCR Processing & Privacy Boundary (Scrub sensitive visual text)
  let ocrRegions: SafeOCRRegion[] = [];
  let rawOcrRegions: OCRRegion[] = [];
  let ocrLatencyMs = 0;
  let contextualFindings: ContextualOcrFinding[] = [];
  let ocrObservation: OCRObservation;

  if (!needsOCR) {
    ocrObservation = {
      state: 'NOT_APPLICABLE',
      provenance: null,
      completedAt: null,
      totalTokensScanned: 0,
      sensitiveRegionsCount: 0,
      safeRegionsCount: 0,
      ocrLatencyMs: 0,
      failureReason: 'DOM extraction sufficient; OCR not required for DOM-only cycle',
    };
  } else if (!screenshotDataUrl) {
    ocrObservation = createUnavailableOCRObservation(
      'Screenshot acquisition failed or unavailable',
      input.tabId,
      input.documentUrl
    );
  } else if (!geoValidation) {
    ocrObservation = createUnavailableOCRObservation(
      'Invalid or degenerate viewport/screenshot geometry',
      input.tabId,
      input.documentUrl
    );
  } else if (!input.ocrEngine) {
    ocrObservation = {
      state: 'NOT_APPLICABLE',
      provenance: null,
      completedAt: null,
      totalTokensScanned: 0,
      sensitiveRegionsCount: 0,
      safeRegionsCount: 0,
      ocrLatencyMs: 0,
      failureReason: 'No OCREngine configured for this perception pass',
    };
  } else {
    const ocrStart = Date.now();
    try {
      const ocrResult: InternalOCRResult = await input.ocrEngine.recognize(screenshotDataUrl);
      ocrLatencyMs = Date.now() - ocrStart;
      const imageDimensions = {
        width: screenshotDimensions.screenshotWidth,
        height: screenshotDimensions.screenshotHeight,
      };
      rawOcrRegions = processSpatialOCRResult(ocrResult, {
        pageGeneration,
        imageDimensions,
      });
      contextualFindings = detectContextualInOcr(
        ocrResult,
        defaultContextualDetector,
        imageDimensions
      );

      // Privacy fusion at perception boundary: if contextual NLP detector identifies a cued sensitive entity,
      // mark corresponding raw OCR regions as sensitive so raw tokens never leak into safe previews
      const cuedFindings = contextualFindings.filter((f) => f.evidence?.includes('cue'));
      if (cuedFindings.length > 0) {
        ocrResult.lines.forEach((line, idx) => {
          if (idx < rawOcrRegions.length && line?.text) {
            const hits = defaultContextualDetector.detect({ text: line.text, hints: [] });
            if (hits.some((h) => h.evidence?.includes('cue'))) {
              const reg = rawOcrRegions[idx];
              if (reg) {
                reg.sensitivity = 'sensitive';
                reg.sensitiveType = 'person_name';
                reg.safeText = undefined;
              }
            }
          }
        });
      }

      ocrRegions = convertToSafeOCRRegions(rawOcrRegions);

      const sensitiveCount = rawOcrRegions.filter((r) => r.sensitivity === 'sensitive').length;
      const safeCount = rawOcrRegions.filter((r) => r.sensitivity === 'safe').length;

      ocrObservation = {
        state: 'OBSERVED',
        provenance: {
          tabId: input.tabId ?? 0,
          documentUrl: input.documentUrl ?? scanReport.url ?? '',
          pageGeneration,
          capturedAt: startTime,
          screenshotDimensions: {
            width: screenshotDimensions.screenshotWidth,
            height: screenshotDimensions.screenshotHeight,
          },
          viewportGeometry: geometry,
          scaleFactors: { scaleX, scaleY },
        },
        completedAt: Date.now(),
        totalTokensScanned: rawOcrRegions.length,
        sensitiveRegionsCount: sensitiveCount,
        safeRegionsCount: safeCount,
        ocrLatencyMs,
      };

      // Map verified safe non-DOM OCR regions into visualDetections so they are perceptible by agent
      for (const safeReg of ocrRegions) {
        if (!safeReg.isSensitive && safeReg.sanitizedPreview) {
          const [sx, sy, sw, sh] = safeReg.bbox;
          visualDetections.push({
            id: safeReg.id,
            type: safeReg.isHeading ? 'heading' : 'element',
            confidence: safeReg.confidence,
            selector: 'canvas:visual-text',
            viewportBBox: [Math.round(sx / scaleX), Math.round(sy / scaleY), Math.round(sw / scaleX), Math.round(sh / scaleY)],
            screenshotBBox: [sx, sy, sw, sh],
            isPartiallyVisible: false,
            source: 'ocr',
            label: safeReg.sanitizedPreview,
          });
        }
      }
    } catch (ocrErr: any) {
      ocrLatencyMs = Date.now() - ocrStart;
      const errMsg = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
      console.warn('[MultimodalCoordinator] OCR processing error:', errMsg);
      ocrObservation = createUnavailableOCRObservation(
        `OCR recognition failed: ${errMsg}`,
        input.tabId,
        input.documentUrl
      );
    }
  }

  // 6. Privacy Fusion across DOM, Visual, and OCR Signals
  const domCandidates = (scanReport?.detections || []).map((d) => candidateFromDOMPageDetection(d));
  const visualCandidates = visualDetections.map((v) => candidateFromVisualDetection(v));
  const ocrCandidates = rawOcrRegions
    .filter((r) => r.sensitivity === 'sensitive' && r.sensitiveType)
    .map((r) =>
      candidateFromOCRDetection({
        id: r.id,
        type: r.sensitiveType!,
        confidence: r.confidence,
        bbox: r.bbox,
        length: 10,
        source: 'ocr',
        isPartiallyVisible: Boolean(r.isPartiallyVisible),
      })
    );

  const contextualCandidates = contextualFindings.map((f, i) =>
    candidateFromContextualDetection({
      id: `ctx-ocr-${i + 1}`,
      type: f.type,
      confidence: f.confidence,
      bbox: f.bbox,
      length: f.length,
      evidence: f.evidence,
    })
  );

  const fusionResult = fusePrivacyFindings([
    ...domCandidates,
    ...visualCandidates,
    ...ocrCandidates,
    ...contextualCandidates,
  ]);

  // Release local screenshot memory if acquired via provider
  if (localScreenshot && !localScreenshot.isReleased()) {
    localScreenshot.release();
  }

  // 7. Construct VisualCaptureReport
  const captureMetadata: CaptureMetadata = {
    viewportWidth: geometry.viewportWidth,
    viewportHeight: geometry.viewportHeight,
    screenshotWidth: screenshotDimensions.screenshotWidth,
    screenshotHeight: screenshotDimensions.screenshotHeight,
    devicePixelRatio: geometry.devicePixelRatio,
    scaleX,
    scaleY,
    scrollX: geometry.scrollX,
    scrollY: geometry.scrollY,
    capturedAt: startTime,
  };

  const visualReport: VisualCaptureReport = {
    captureMetadata,
    visualDetections,
    totalDetected: visualDetections.length,
    totalPartiallyVisible,
    totalOffscreenFiltered,
    ocrRegionsScanned: rawOcrRegions.length,
    sensitiveOCRDetected: rawOcrRegions.filter((r) => r.sensitivity === 'sensitive').length,
    ocrLatencyMs,
    domSensitiveDetected: scanReport.sensitiveElementsDetected,
    status: 'Local Visual Context Prepared',
  };

  return {
    visualReport,
    ocrRegions,
    privacyFindings: fusionResult.findings,
    screenshotDimensions,
    scaleFactors: { scaleX, scaleY },
    ocrObservation,
  };
}

/**
 * Enriches a live BrowserWorldModel with multimodal perception artifacts.
 */
export function enrichWorldModelWithMultimodalPerception(
  worldModel: BrowserWorldModel,
  coordination: MultimodalCoordinationResult
): BrowserWorldModel {
  worldModel.ocrRegions = coordination.ocrRegions;
  worldModel.privacyFindings = coordination.privacyFindings;
  worldModel.ocrObservation = coordination.ocrObservation;
  worldModel.viewport = {
    width: coordination.visualReport.captureMetadata.viewportWidth,
    height: coordination.visualReport.captureMetadata.viewportHeight,
    scrollX: coordination.visualReport.captureMetadata.scrollX,
    scrollY: coordination.visualReport.captureMetadata.scrollY,
    devicePixelRatio: coordination.visualReport.captureMetadata.devicePixelRatio,
  };
  return worldModel;
}
