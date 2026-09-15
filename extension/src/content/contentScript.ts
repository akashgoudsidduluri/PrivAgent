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

  // Milestone 5: Structured Browser Action Execution
  if (message.type === 'PRIVAGENT_EXECUTE_ACTION') {
    const result = executeBrowserAction(message.action);
    sendResponse({
      type: 'PRIVAGENT_EXECUTE_ACTION_RESPONSE',
      result,
    });
    return false;
  }

  // Dashboard Progress Relay from background worker to web UI
  if ((message as any).type === 'PRIVAGENT_DASHBOARD_PROGRESS') {
    window.postMessage(
      {
        source: 'privagent-extension',
        type: 'TASK_PROGRESS',
        payload: (message as any).payload,
      },
      '*'
    );
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function isExtensionContextValid(): boolean {
  try {
    return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

// ── Dashboard Web UI Bridge ─────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'privagent-dashboard') return;

  const { type, task, allowed } = event.data;

  // Immediate handshake ping response
  if (type === 'PING_EXTENSION') {
    const valid = isExtensionContextValid();
    window.postMessage(
      {
        source: 'privagent-extension',
        type: 'PONG_EXTENSION',
        version: '0.4.0',
        connected: valid,
        error: valid ? undefined : 'Extension context invalidated. Please refresh this tab.',
      },
      '*'
    );
    return;
  }

  if (!isExtensionContextValid()) {
    console.warn('[PrivAgent] Extension context invalidated while handling:', type);
    window.postMessage(
      {
        source: 'privagent-extension',
        type: 'TASK_PROGRESS',
        payload: {
          status: 'FAILED',
          currentStep: 0,
          maxSteps: 10,
          task: task || '',
          steps: [],
          reason: 'Extension was reloaded. Please refresh this tab to reconnect to the extension.',
        },
      },
      '*'
    );
    return;
  }

  // Forward dashboard commands to background service worker with error handling
  try {
    if (type === 'START_TASK') {
      chrome.runtime.sendMessage(
        {
          type: 'PRIVAGENT_DASHBOARD_START_TASK',
          task,
          originUrl: window.location.href,
        },
        (_response) => {
          if (chrome.runtime.lastError) {
            console.warn('[PrivAgent] START_TASK error:', chrome.runtime.lastError.message);
            window.postMessage(
              {
                source: 'privagent-extension',
                type: 'TASK_PROGRESS',
                payload: {
                  status: 'FAILED',
                  currentStep: 0,
                  maxSteps: 10,
                  task: task || '',
                  steps: [],
                  reason: chrome.runtime.lastError.message || 'Failed to dispatch task to background service worker.',
                },
              },
              '*'
            );
          }
        }
      );
    } else if (type === 'STOP_TASK') {
      chrome.runtime.sendMessage({
        type: 'PRIVAGENT_DASHBOARD_STOP_TASK',
      });
    } else if (type === 'CONFIRM_ACTION') {
      chrome.runtime.sendMessage({
        type: 'PRIVAGENT_DASHBOARD_CONFIRM_ACTION',
        allowed,
      });
    }
  } catch (err) {
    console.warn('[PrivAgent] Failed to send message to background worker:', err);
    window.postMessage(
      {
        source: 'privagent-extension',
        type: 'TASK_PROGRESS',
        payload: {
          status: 'FAILED',
          currentStep: 0,
          maxSteps: 10,
          task: task || '',
          steps: [],
          reason: 'Extension context invalidated. Please refresh this tab.',
        },
      },
      '*'
    );
  }
});

/**
 * Visual highlight indicator over the element being acted upon.
 */
function highlightActionElement(el: HTMLElement): void {
  const originalOutline = el.style.outline;
  const originalTransition = el.style.transition;
  const originalBoxShadow = el.style.boxShadow;

  el.style.transition = 'all 0.3s ease';
  el.style.outline = '3px solid #10b981';
  el.style.boxShadow = '0 0 12px rgba(16, 185, 129, 0.6)';

  setTimeout(() => {
    el.style.outline = originalOutline;
    el.style.transition = originalTransition;
    el.style.boxShadow = originalBoxShadow;
  }, 1800);
}

/**
 * Locate target DOM element by ID from previous scan detections or direct DOM search.
 */
function findElementByTarget(targetId: string): HTMLElement | null {
  if (lastReport && lastReport.detections) {
    const det = lastReport.detections.find((d) => d.id === targetId);
    if (det && det.selector) {
      const el = document.querySelector<HTMLElement>(det.selector);
      if (el) return el;
    }
  }

  // Fallback 1: direct ID
  const elById = document.getElementById(targetId);
  if (elById) return elById;

  // Fallback 2: data attribute
  const elByData = document.querySelector<HTMLElement>(`[data-privagent-id="${targetId}"]`);
  if (elByData) return elByData;

  // Fallback 3: try selector directly
  try {
    const elByQuery = document.querySelector<HTMLElement>(targetId);
    if (elByQuery) return elByQuery;
  } catch {
    // ignore invalid selector syntax
  }

  return null;
}

/**
 * Deterministically execute a validated BrowserAction using DOM APIs.
 * NO eval(), NO dynamic code execution.
 */
function executeBrowserAction(action: import('../agent/actionTypes').BrowserAction): import('../agent/actionTypes').ActionExecutionResult {
  try {
    switch (action.action) {
      case 'click': {
        const el = findElementByTarget(action.target);
        if (!el) {
          return { success: false, error: `Target element '${action.target}' not found in DOM.` };
        }
        highlightActionElement(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        el.click();
        return { success: true, action, message: `Clicked element '${action.target}'.` };
      }

      case 'scroll': {
        const top = action.direction === 'down' ? action.amount : -action.amount;
        window.scrollBy({ top, behavior: 'smooth' });
        return { success: true, action, message: `Scrolled ${action.direction} by ${action.amount}px.` };
      }

      case 'type': {
        const el = findElementByTarget(action.target);
        if (!el) {
          return { success: false, error: `Target element '${action.target}' not found in DOM.` };
        }
        highlightActionElement(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();

        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = action.text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, action, message: `Typed text into element '${action.target}'.` };
        }
        return { success: false, error: `Target element '${action.target}' is not an input or textarea.` };
      }

      case 'select': {
        const el = findElementByTarget(action.target);
        if (!el) {
          return { success: false, error: `Target element '${action.target}' not found in DOM.` };
        }
        highlightActionElement(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();

        if (el instanceof HTMLSelectElement) {
          let matched = false;
          for (let i = 0; i < el.options.length; i++) {
            const opt = el.options[i];
            if (opt && (opt.text === action.option || opt.value === action.option)) {
              el.selectedIndex = i;
              matched = true;
              break;
            }
          }
          if (!matched && el.options.length > 0) {
            el.value = action.option;
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, action, message: `Selected option '${action.option}' on element '${action.target}'.` };
        }
        return { success: false, error: `Target element '${action.target}' is not a select element.` };
      }

      case 'navigate': {
        window.location.href = action.url;
        return { success: true, action, message: `Navigating to ${action.url}.` };
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Browser action execution failed: ${msg}` };
  }
}


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
