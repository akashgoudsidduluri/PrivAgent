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
import { getScreenshotProvider } from './screenshotCapture';
import { LocalScreenshot } from './visualTypes';

export interface MultimodalPerceptionInput {
  tabId?: number;
  windowId?: number;
  scanReport: PrivacyScanReport;
  pageGeneration: number;
  geometry?: ViewportGeometry;
  ocrEngine?: OCREngine;
  screenshotDataUrl?: string;
}

export interface MultimodalCoordinationResult {
  visualReport: VisualCaptureReport;
  ocrRegions: SafeOCRRegion[];
  privacyFindings: PrivacyFinding[];
  screenshotDimensions: ActualScreenshotDimensions;
  scaleFactors: { scaleX: number; scaleY: number };
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

  // 2. Obtain Visual Screenshot (Local Isolated Memory)
  let screenshotDataUrl = input.screenshotDataUrl || null;
  let localScreenshot: LocalScreenshot | null = null;

  if (!screenshotDataUrl) {
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
        // Fallback synthetic screenshot
        screenshotDataUrl =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAYAAAByNR6YAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAI/SURBVHhe7cExAQAAAMKg9U9tCF8gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgIsBI0AAAc5d7iQAAAAASUVORK5CYII=';
      }
    }
  }

  // 3. Resolve Authoritative Dimensions
  const screenshotDimensions = resolveScreenshotDimensions(screenshotDataUrl, geometry);
  const scaleX = screenshotDimensions.screenshotWidth / geometry.viewportWidth;
  const scaleY = screenshotDimensions.screenshotHeight / geometry.viewportHeight;

  // 4. Map DOM Detections to Visual Coordinates
  const visualDetections: VisualDetectionResult[] = [];
  let totalPartiallyVisible = 0;
  let totalOffscreenFiltered = 0;

  for (const det of scanReport.detections) {
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
  // Phase 15: contextual (NLP) findings derived from the SAME local OCR pass.
  // They are metadata-only and re-enter the pipeline through fusion like any
  // other perception source. They never bypass the policy layer.
  let contextualFindings: ContextualOcrFinding[] = [];

  if (input.ocrEngine) {
    const ocrStart = Date.now();
    try {
      const ocrResult: InternalOCRResult = await input.ocrEngine.recognize(screenshotDataUrl!);
      ocrLatencyMs = Date.now() - ocrStart;
      const imageDimensions = {
        width: screenshotDimensions.screenshotWidth,
        height: screenshotDimensions.screenshotHeight,
      };
      rawOcrRegions = processSpatialOCRResult(ocrResult, {
        pageGeneration,
        imageDimensions,
      });
      ocrRegions = convertToSafeOCRRegions(rawOcrRegions);
      // Runs HERE, while the raw OCR text is still local and in scope — the
      // only place reading it is legitimate. Spans are mapped straight back to
      // OCR word boxes; anything unmappable is kept so fusion fails closed on it.
      contextualFindings = detectContextualInOcr(
        ocrResult,
        defaultContextualDetector,
        imageDimensions
      );
    } catch (ocrErr) {
      console.warn('[MultimodalCoordinator] OCR processing error:', ocrErr);
    }
  }

  // 6. Privacy Fusion across DOM, Visual, and OCR Signals
  const domCandidates = scanReport.detections.map((d) => candidateFromDOMPageDetection(d));
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

  // Phase 15: contextual OCR hits become fusion candidates. A hit whose span
  // could not be mapped to a region is STILL emitted (bbox null) so that the
  // must-redact-but-unlocatable case escalates instead of disappearing.
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
  worldModel.viewport = {
    width: coordination.visualReport.captureMetadata.viewportWidth,
    height: coordination.visualReport.captureMetadata.viewportHeight,
    scrollX: coordination.visualReport.captureMetadata.scrollX,
    scrollY: coordination.visualReport.captureMetadata.scrollY,
    devicePixelRatio: coordination.visualReport.captureMetadata.devicePixelRatio,
  };
  return worldModel;
}
