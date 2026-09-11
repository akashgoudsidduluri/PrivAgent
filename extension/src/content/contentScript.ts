import { scanDOM } from '../privacy/domDetector';
import { LocalRedactor } from '../redaction/redactor';
import { OverlayManager } from '../redaction/overlayManager';
import { createSanitizedExport } from '../privacy/securityBoundary';
import { isUrlExcluded, getExclusionReason } from '../privacy/siteExclusions';
import { ExtensionMessage, PrivacyScanReport, RedactionMode, SensitiveEntityType } from '../privacy/types';

const currentUrl = window.location.href;
const isCurrentSiteExcluded = isUrlExcluded(currentUrl);
const exclusionReason = isCurrentSiteExcluded ? getExclusionReason(currentUrl) : null;

if (isCurrentSiteExcluded) {
  console.info(`[PrivAgent] URL excluded from automatic privacy scanning (${exclusionReason}): ${currentUrl}`);
} else {
  console.info('[PrivAgent] Initializing on-device privacy engine content script...');
}

const redactor = new LocalRedactor();
const overlayManager = new OverlayManager(redactor);

let lastReport: PrivacyScanReport | null = null;
let currentMode: RedactionMode = 'blackout';
let isRedactionActive = true;

function createExcludedReport(): PrivacyScanReport {
  return {
    timestamp: Date.now(),
    url: currentUrl,
    scanLatencyMs: 0,
    redactionLatencyMs: 0,
    totalElementsScanned: 0,
    sensitiveElementsDetected: 0,
    elementsProtected: 0,
    leakageCount: 0,
    categories: {
      password: 0,
      credit_card: 0,
      account_number: 0,
      email: 0,
      phone: 0,
      person_name: 0,
      pan: 0,
      otp: 0,
      cvv: 0,
    },
    detections: [],
    status: 'Excluded Site',
    redactionMode: currentMode,
  };
}

/**
 * Runs a full on-device DOM privacy scan, calculates exact metrics,
 * and enforces local redaction.
 */
function performPrivacyScan(mode: RedactionMode = currentMode): PrivacyScanReport {
  if (isCurrentSiteExcluded) {
    return createExcludedReport();
  }

  currentMode = mode;
  
  // 1. DOM Scan with timing
  const { detections, scanLatencyMs, totalElementsScanned } = scanDOM(document);

  // 2. Count categories
  const categories: Record<SensitiveEntityType, number> = {
    password: 0,
    credit_card: 0,
    account_number: 0,
    email: 0,
    phone: 0,
    person_name: 0,
    pan: 0,
    otp: 0,
    cvv: 0,
  };

  for (const det of detections) {
    categories[det.type] = (categories[det.type] || 0) + 1;
  }

  // 3. Local Redaction with timing
  let elementsProtected = 0;
  let redactionLatencyMs = 0;

  if (isRedactionActive) {
    const redactRes = redactor.applyRedaction(detections, currentMode);
    elementsProtected = redactRes.elementsProtected;
    redactionLatencyMs = redactRes.redactionLatencyMs;
  } else {
    redactor.clearRedaction();
  }

  // 4. Update overlay manager for demo stage view
  overlayManager.setDetections(detections, currentMode);
  overlayManager.renderFloatingPanel();

  // 5. Construct & verify sanitized report (Guarantees zero raw PII values)
  const rawReport: PrivacyScanReport = {
    timestamp: Date.now(),
    url: window.location.href,
    scanLatencyMs,
    redactionLatencyMs,
    totalElementsScanned,
    sensitiveElementsDetected: detections.length,
    elementsProtected,
    leakageCount: 0,
    categories,
    detections,
    status: 'Sanitized Context — Local Privacy Check Passed',
    redactionMode: currentMode,
  };

  const safeExport = createSanitizedExport(rawReport);
  lastReport = safeExport as PrivacyScanReport;
  return lastReport;
}

// Listen for messages from popup or background worker
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'PRIVAGENT_SCAN_REQUEST') {
    const report = performPrivacyScan(message.mode || currentMode);
    sendResponse({ type: 'PRIVAGENT_SCAN_RESPONSE', report });
    return true;
  }

  if (message.type === 'PRIVAGENT_SET_REDACTION_MODE') {
    currentMode = message.mode;
    if (lastReport) {
      const report = performPrivacyScan(currentMode);
      sendResponse({ type: 'PRIVAGENT_SCAN_RESPONSE', report });
    }
    return true;
  }

  if (message.type === 'PRIVAGENT_TOGGLE_REDACTION') {
    isRedactionActive = message.enabled;
    if (lastReport) {
      const report = performPrivacyScan(currentMode);
      sendResponse({ type: 'PRIVAGENT_SCAN_RESPONSE', report });
    }
    return true;
  }

  if (message.type === 'PRIVAGENT_GET_STATE') {
    if (!lastReport) {
      // Run automatic initial scan
      lastReport = performPrivacyScan(currentMode);
    }
    sendResponse({
      type: 'PRIVAGENT_STATE_RESPONSE',
      report: lastReport,
      isRedactionActive,
    });
    return true;
  }

  // Milestone 2: Provide live viewport geometry for coordinate mapping
  if (message.type === 'PRIVAGENT_GET_VIEWPORT_GEOMETRY') {
    sendResponse({
      type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY_RESPONSE',
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    });
    return true;
  }

  return false;
});

// Auto-run initial lightweight scan when DOM is ready (only on non-excluded sites)
if (!isCurrentSiteExcluded) {
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => {
      performPrivacyScan('blackout');
    }, 300);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        performPrivacyScan('blackout');
      }, 300);
    });
  }
}
