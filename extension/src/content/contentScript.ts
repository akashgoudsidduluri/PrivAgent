import { scanDOM } from '../privacy/domDetector';
import { scanInteractiveElements } from './domInteractiveScanner';
import { LocalRedactor } from '../redaction/redactor';
import { OverlayManager } from '../redaction/overlayManager';
import { createSanitizedExport } from '../privacy/securityBoundary';
import { isUrlExcluded, getExclusionReason } from '../privacy/siteExclusions';
import { ExtensionMessage, isSensitiveEntityType, PrivacyScanReport, RedactionMode, SensitiveEntityType } from '../privacy/types';
import { buildBrowserWorldModel } from '../worldModel/worldModelBuilder';
import { assertWorldModelSafe, createSanitizedWorldModelSummary } from '../worldModel/worldModelSanitizer';
import { worldModelStore } from '../worldModel/worldModelStore';
import { BrowserWorldModel } from '../worldModel/types';
import { buildSemanticUnderstanding, SemanticUnderstandingOutput } from '../semanticUnderstanding';

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
let lastWorldModel: BrowserWorldModel | null = null;
let lastWorldModelRef: { pageGeneration: number; worldModelId: string } | null = null;
let lastSemanticUnderstanding: SemanticUnderstandingOutput | null = null;
let currentMode: RedactionMode = 'blackout';
let isRedactionActive = true;
let currentPageGeneration = 1;

function buildCurrentWorldModel(): { worldModel: BrowserWorldModel; activeWorldModelRef: { pageGeneration: number; worldModelId: string }; summary: ReturnType<typeof createSanitizedWorldModelSummary> } {
  const pageGeneration = currentPageGeneration;
  const worldModel = buildBrowserWorldModel({
    root: document,
    pageGeneration,
  });

  assertWorldModelSafe(worldModel);
  const ref = worldModelStore.registerWorldModel(worldModel);
  const storedWorldModel = worldModelStore.getActiveWorldModel(ref);
  if (!storedWorldModel) {
    throw new Error('World model registration failed for the current page generation.');
  }

  const summary = createSanitizedWorldModelSummary(storedWorldModel);
  return {
    worldModel: storedWorldModel,
    activeWorldModelRef: ref,
    summary,
  };
}

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
      address: 0,
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
    address: 0,
  };

  for (const det of detections) {
    if (isSensitiveEntityType(det.type)) {
      categories[det.type] = (categories[det.type] || 0) + 1;
    }
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

  // 5. Scan visible interactive controls (buttons, links, search inputs)
  const { interactiveElements, pageType, semanticGroups } = scanInteractiveElements(document);
  const sensitiveSelectors = new Set(detections.map((d) => d.selector));
  const sensitiveIds = new Set(detections.map((d) => d.id));
  const nonOverlappingInteractive = interactiveElements.filter(
    (el) => !sensitiveSelectors.has(el.selector) && !sensitiveIds.has(el.id)
  );
  const allDetections = [...detections, ...nonOverlappingInteractive];

  // 6. Construct & verify sanitized report (Guarantees zero raw PII values)
  const rawReport: PrivacyScanReport = {
    timestamp: Date.now(),
    url: window.location.href,
    scanLatencyMs,
    redactionLatencyMs,
    totalElementsScanned: totalElementsScanned + interactiveElements.length,
    sensitiveElementsDetected: detections.length,
    elementsProtected,
    leakageCount: 0,
    categories,
    detections: allDetections,
    status: 'Sanitized Context — Local Privacy Check Passed',
    redactionMode: currentMode,
    pageType,
    semanticGroups,
  };

  const safeExport = createSanitizedExport(rawReport);
  lastReport = safeExport as PrivacyScanReport;

  try {
    const { worldModel, activeWorldModelRef } = buildCurrentWorldModel();
    currentPageGeneration += 1;
    lastWorldModel = worldModel;
    lastWorldModelRef = activeWorldModelRef;

    try {
      lastSemanticUnderstanding = buildSemanticUnderstanding({
        worldModel,
        root: document,
        pageGeneration: activeWorldModelRef.pageGeneration,
      });
    } catch (semErr) {
      console.warn('[ContentScript] semantic understanding build failed:', semErr instanceof Error ? semErr.message : String(semErr));
      lastSemanticUnderstanding = null;
    }
  } catch (err) {
    console.warn('[ContentScript] world model build/sanitization failed:', err instanceof Error ? err.message : String(err));
    lastWorldModel = null;
    lastWorldModelRef = null;
    lastSemanticUnderstanding = null;
  }

  return lastReport;
}

// Listen for messages from popup or background worker
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'PRIVAGENT_SCAN_REQUEST') {
    console.info('[ContentScript] message received', { type: message.type });
    console.info('[ContentScript] perception started');
    console.info('perception:start');
    try {
      console.info('dom:start');
      const report = performPrivacyScan(message.mode || currentMode);
      console.info('dom:done');
      console.info('visual:start');
      console.info('visual:done');
      console.info('fusion:start');
      console.info('fusion:done');
      console.info('minimization:start');
      console.info('minimization:done');
      console.info('response:start');
      console.info('[ContentScript] perception completed', {
        elementsScanned: report.totalElementsScanned,
        sensitiveDetected: report.sensitiveElementsDetected,
        worldModelId: lastWorldModel?.id ?? null,
      });
      sendResponse({
        type: 'PRIVAGENT_SCAN_RESPONSE',
        report,
        worldModel: lastWorldModel,
        activeWorldModelRef: lastWorldModelRef,
        semanticUnderstanding: lastSemanticUnderstanding,
        semanticContext: lastSemanticUnderstanding?.sanitizedContext ?? undefined,
      });
      console.info('response:sent');
      console.info('[ContentScript] response sent');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[ContentScript] perception error:', errMsg);
      sendResponse({ type: 'PRIVAGENT_SCAN_RESPONSE', error: errMsg });
    }
    return false;
  }

  if (message.type === 'PRIVAGENT_SET_REDACTION_MODE') {
    currentMode = message.mode;
    if (lastReport) {
      const report = performPrivacyScan(currentMode);
      sendResponse({ type: 'PRIVAGENT_SCAN_RESPONSE', report });
    }
    return false;
  }

  if (message.type === 'PRIVAGENT_TOGGLE_REDACTION') {
    isRedactionActive = message.enabled;
    if (lastReport) {
      const report = performPrivacyScan(currentMode);
      sendResponse({ type: 'PRIVAGENT_SCAN_RESPONSE', report });
    }
    return false;
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
    return false;
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
    return false;
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
    if (typeof chrome === 'undefined' || !chrome?.runtime?.id) {
      return false;
    }
    // In Chrome MV3, chrome.runtime.getManifest() throws synchronously when context is invalidated
    const manifest = chrome.runtime.getManifest();
    return Boolean(manifest && manifest.version);
  } catch {
    return false;
  }
}

// ── Dashboard Web UI Bridge ─────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'privagent-dashboard') return;

  const { type, task, allowed } = event.data;

  // Immediate handshake ping response with deep health check
  if (type === 'PING_EXTENSION') {
    const pingId = event.data.pingId || `cs-${Date.now()}`;
    console.info('[CS][PING] PING_RECEIVED_BY_CONTENT_SCRIPT', {
      pingId,
      origin: window.location.origin,
      validContext: isExtensionContextValid(),
    });

    const valid = isExtensionContextValid();
    if (!valid) {
      console.warn('[CS][PING] CONTEXT_INVALID — sending disconnected PONG', { pingId });
      window.postMessage(
        {
          source: 'privagent-extension',
          type: 'PONG_EXTENSION',
          pingId,
          version: '0.4.0',
          connected: false,
          details: {
            extension: 'DISCONNECTED',
            serviceWorker: 'UNREACHABLE',
            targetTab: 'NOT_FOUND',
            contentScript: 'NOT_INJECTED',
            urlOrigin: '',
            pageReady: false,
          },
          error: 'Extension context invalidated. Please refresh this tab.',
        },
        '*'
      );
      return;
    }

    // Helper: send PRIVAGENT_DASHBOARD_PING to service worker with one retry
    // if the SW was asleep (MV3 workers spin down after ~30s of inactivity).
    // "Receiving end does not exist" is the normal Chrome error when the SW
    // is still waking up; retrying once after 600ms is sufficient.
    const sendPingToSW = (attempt: number) => {
      console.info('[CS][PING] DASHBOARD_PING_SENT_TO_SERVICE_WORKER', { pingId, attempt });
      try {
        chrome.runtime.sendMessage(
          {
            type: 'PRIVAGENT_DASHBOARD_PING',
            pingId,
            targetUrl: event.data.targetUrl || 'http://localhost:4173',
          },
          (res) => {
            const err = chrome.runtime.lastError;

            // MV3 SW wake-up race: SW was idle, Chrome returned this error
            // synchronously before the SW had a chance to register listeners.
            // Retry once after a brief delay to let the SW wake up.
            if (err && attempt === 1) {
              const msg = err.message || '';
              const isSwAsleep =
                msg.includes('Receiving end does not exist') ||
                msg.includes('Could not establish connection');
              if (isSwAsleep) {
                console.info('[CS][PING] SW_WAKEUP_RETRY', { pingId, error: msg });
                setTimeout(() => sendPingToSW(2), 600);
                return;
              }
            }

            if (err || !res) {
              console.warn('[CS][PING] CONTENT_SCRIPT_RESPONSE_RECEIVED — SW unreachable', {
                pingId,
                attempt,
                error: err?.message,
              });
              console.info('[CS][PING] PONG_EXTENSION_SENT (sw-unreachable)', { pingId });
              window.postMessage(
                {
                  source: 'privagent-extension',
                  type: 'PONG_EXTENSION',
                  pingId,
                  version: '0.4.0',
                  connected: false,
                  details: {
                    extension: 'CONNECTED',
                    serviceWorker: 'UNREACHABLE',
                    targetTab: 'NOT_FOUND',
                    contentScript: 'NOT_INJECTED',
                    urlOrigin: '',
                    pageReady: false,
                  },
                  error: err?.message || 'Background service worker unreachable.',
                },
                '*'
              );
            } else {
              console.info('[CS][PING] CONTENT_SCRIPT_RESPONSE_RECEIVED — SW alive', {
                pingId,
                attempt,
                targetTab: res.targetTab,
                urlOrigin: res.urlOrigin,
              });
              console.info('[CS][PING] PONG_EXTENSION_SENT', {
                pingId,
                connected: Boolean(res.connected),
                targetTab: res.targetTab,
              });
              window.postMessage(
                {
                  source: 'privagent-extension',
                  type: 'PONG_EXTENSION',
                  pingId,
                  version: '0.4.0',
                  connected: Boolean(res.connected),
                  details: {
                    extension: 'CONNECTED',
                    serviceWorker: res.serviceWorker || 'REACHABLE',
                    targetTab: res.targetTab || 'NOT_FOUND',
                    contentScript: res.contentScript || 'NOT_INJECTED',
                    urlOrigin: res.urlOrigin || '',
                    pageReady: Boolean(res.pageReady),
                  },
                },
                '*'
              );
            }
          }
        );
      } catch (ex) {
        console.warn('[CS][PING] SEND_MESSAGE_THREW', { pingId, attempt, error: String(ex) });
        // Extension context gone — send a best-effort PONG from what we know
        window.postMessage(
          {
            source: 'privagent-extension',
            type: 'PONG_EXTENSION',
            pingId,
            version: '0.4.0',
            connected: true,
            details: {
              extension: 'CONNECTED',
              serviceWorker: 'REACHABLE',
              targetTab: 'NOT_FOUND',
              contentScript: 'NOT_INJECTED',
              urlOrigin: '',
              pageReady: false,
            },
          },
          '*'
        );
      }
    };

    sendPingToSW(1);
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
      console.info('[Extension] message received', { type: 'START_TASK' });
      console.info('[AgentTrace] content START_TASK received');
      console.info('[AgentTrace] content script forwarding START_TASK to background worker');
      chrome.runtime.sendMessage(
        {
          type: 'PRIVAGENT_DASHBOARD_START_TASK',
          task,
          originUrl: window.location.href,
        },
        (response) => {
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
          } else if (response) {
            window.postMessage(
              {
                source: 'privagent-extension',
                type: 'TASK_PROGRESS',
                payload: {
                  status: response.status || (response.started ? 'RUNNING' : 'FAILED'),
                  currentStep: 0,
                  maxSteps: 10,
                  task: task || '',
                  steps: [],
                  reason: response.reason || (response.started ? 'Task accepted by background service worker.' : 'Task failed.'),
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
        window.scrollBy(0, top);
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
