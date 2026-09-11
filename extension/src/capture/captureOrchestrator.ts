/**
 * PrivAgent — Capture Orchestrator (Milestone 2)
 *
 * Coordinates the full Milestone 2 visual privacy pipeline:
 *   1. Request DOM scan from content script (existing Milestone 1 detections)
 *   2. Collect viewport geometry from the content script
 *   3. Request screenshot via background service worker (captureVisibleTab)
 *   4. Decode the screenshot to extract ACTUAL dimensions (authoritative)
 *   5. Run coordinateMapper for every detection using actual dimensions
 *   6. Return a VisualCaptureReport with all visual detections mapped
 *
 * Security boundary:
 *   - The screenshot data URL stays in local extension memory.
 *   - It is NEVER forwarded to any remote server or VLM.
 *   - It is consumed only by the local VisualCanvasRedactor.
 */

import {
  CaptureMetadata,
  DetectionResult,
  ExtensionMessage,
  PrivacyScanReport,
  VisualCaptureReport,
  VisualDetectionResult,
} from '../privacy/types';
import {
  ActualScreenshotDimensions,
  ViewportGeometry,
  mapDOMToScreenshot,
} from './coordinateMapper';

export interface OrchestratorResult {
  dataUrl: string;
  report: VisualCaptureReport;
}

/**
 * Loads an HTMLImageElement from a data URL.
 * Returns both the element and the ACTUAL decoded dimensions of the image.
 */
export function loadImageFromDataUrl(
  dataUrl: string
): Promise<{ image: HTMLImageElement; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ image: img, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to decode screenshot image.'));
    img.src = dataUrl;
  });
}

/**
 * Sends a message to the background service worker and returns the response.
 * Throws on chrome.runtime.lastError or missing response.
 */
function sendToBackground(msg: ExtensionMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'Background message error.'));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Sends a message to the active tab's content script and returns the response.
 */
function sendToContentScript(tabId: number, msg: ExtensionMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'Content script message error.'));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Maps an array of DOM DetectionResults to VisualDetectionResults using the
 * actual screenshot dimensions as the authoritative scaling authority.
 */
function mapDetectionsToVisual(
  detections: DetectionResult[],
  geometry: ViewportGeometry,
  screenshotDimensions: ActualScreenshotDimensions
): {
  visualDetections: VisualDetectionResult[];
  totalPartiallyVisible: number;
  totalOffscreenFiltered: number;
} {
  const visualDetections: VisualDetectionResult[] = [];
  let totalPartiallyVisible = 0;
  let totalOffscreenFiltered = 0;

  for (const det of detections) {
    // det.bbox is always in document (page) coordinates
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

  return { visualDetections, totalPartiallyVisible, totalOffscreenFiltered };
}

/**
 * Full Milestone 2 pipeline:
 *   DOM scan → viewport geometry → screenshot → decode dimensions → map coordinates → visual report
 *
 * @param tabId  The active tab ID to operate on.
 * @param currentMode  The current redaction mode (for scan request).
 * @returns OrchestratorResult containing the data URL and VisualCaptureReport
 */
export async function runCaptureAndMap(
  tabId: number,
  currentMode: 'blackout' | 'blur' | 'mask' = 'blackout'
): Promise<OrchestratorResult> {
  const captureStart = performance.now();

  // Step 1: Trigger DOM scan on the content script to get fresh detections
  const scanResponse = await sendToContentScript(tabId, {
    type: 'PRIVAGENT_SCAN_REQUEST',
    mode: currentMode,
  });

  const scanReport: PrivacyScanReport = scanResponse?.report;
  if (!scanReport) {
    throw new Error('Failed to obtain DOM scan report from content script.');
  }

  // Step 2: Collect viewport geometry from the content script
  const geoResponse = await sendToContentScript(tabId, {
    type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY',
  });

  if (!geoResponse || geoResponse.type !== 'PRIVAGENT_GET_VIEWPORT_GEOMETRY_RESPONSE') {
    throw new Error('Failed to obtain viewport geometry from content script.');
  }

  const geometry: ViewportGeometry = {
    viewportWidth: geoResponse.viewportWidth,
    viewportHeight: geoResponse.viewportHeight,
    scrollX: geoResponse.scrollX,
    scrollY: geoResponse.scrollY,
    devicePixelRatio: geoResponse.devicePixelRatio,
  };

  // Step 3: Capture the viewport screenshot via the background service worker
  const captureResponse = await sendToBackground({
    type: 'PRIVAGENT_CAPTURE_SCREENSHOT',
  });

  if (captureResponse?.error || !captureResponse?.dataUrl) {
    throw new Error(captureResponse?.error ?? 'No screenshot data URL returned.');
  }

  const dataUrl: string = captureResponse.dataUrl;

  // Step 4: Decode screenshot to obtain AUTHORITATIVE actual pixel dimensions
  const { image, width: screenshotWidth, height: screenshotHeight } = await loadImageFromDataUrl(dataUrl);

  // Suppress unused variable warning — image is returned to caller for rendering
  void image;

  const screenshotDimensions: ActualScreenshotDimensions = { screenshotWidth, screenshotHeight };

  // Step 5: Map detections to visual coordinates
  const { visualDetections, totalPartiallyVisible, totalOffscreenFiltered } = mapDetectionsToVisual(
    scanReport.detections,
    geometry,
    screenshotDimensions
  );

  // Compute empirical scale factors (for diagnostic metadata only, not for calculations)
  const scaleX = screenshotWidth / geometry.viewportWidth;
  const scaleY = screenshotHeight / geometry.viewportHeight;

  const captureMetadata: CaptureMetadata = {
    viewportWidth: geometry.viewportWidth,
    viewportHeight: geometry.viewportHeight,
    screenshotWidth,
    screenshotHeight,
    devicePixelRatio: geometry.devicePixelRatio,
    scaleX,
    scaleY,
    scrollX: geometry.scrollX,
    scrollY: geometry.scrollY,
    capturedAt: Date.now(),
  };

  const visualReport: VisualCaptureReport = {
    captureMetadata,
    visualDetections,
    totalDetected: visualDetections.length,
    totalPartiallyVisible,
    totalOffscreenFiltered,
    status: 'Local Visual Context Prepared',
  };

  console.info(
    `[PrivAgent Capture] Pipeline complete in ${(performance.now() - captureStart).toFixed(1)} ms. ` +
    `Detections: ${visualDetections.length} visible, ` +
    `${totalPartiallyVisible} partial, ${totalOffscreenFiltered} off-screen.`
  );

  return { dataUrl, report: visualReport };
}
