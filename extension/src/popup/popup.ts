import {
  ExtensionMessage,
  PrivacyScanReport,
  RedactionMode,
  VisualCaptureReport,
  VisualDetectionResult,
  AgentContextPayload,
  buildAgentPayload,
} from '../privacy/types';
import { VisualCanvasRedactor } from '../capture/visualRedactor';
import { LocalOCREngine } from '../ocr/ocrEngine';
import { detectSensitiveOCRRegions } from '../ocr/ocrDetector';
import { mapDOMToScreenshot } from '../capture/coordinateMapper';
import { checkBackendHealth, sendSanitizedContext } from '../agent/agentBridge';

type VisualViewMode = 'original' | 'detected' | 'sanitized';

let currentReport: PrivacyScanReport | null = null;
let currentVisualReport: VisualCaptureReport | null = null;
let cachedOriginalImage: HTMLImageElement | null = null;
let cachedVisualDetections: VisualDetectionResult[] = [];
let isRedactionActive = true;
let selectedMode: RedactionMode = 'blackout';
let activeViewMode: VisualViewMode = 'sanitized';

// Singleton local OCR engine for popup
let localOcrEngine: LocalOCREngine | null = null;

// UI Elements — DOM scan section
const metricDetected = document.getElementById('metric-detected')!;
const metricProtected = document.getElementById('metric-protected')!;
const metricLeakage = document.getElementById('metric-leakage')!;
const benchScan = document.getElementById('bench-scan')!;
const benchRedact = document.getElementById('bench-redact')!;

const catPassword = document.getElementById('cat-password')!;
const catCard = document.getElementById('cat-card')!;
const catAccount = document.getElementById('cat-account')!;
const catEmail = document.getElementById('cat-email')!;
const catPhone = document.getElementById('cat-phone')!;
const catPan = document.getElementById('cat-pan');
const catCvv = document.getElementById('cat-cvv');
const catName = document.getElementById('cat-name')!;

const btnModeBlackout = document.getElementById('btn-mode-blackout')!;
const btnModeBlur = document.getElementById('btn-mode-blur')!;
const btnModeMask = document.getElementById('btn-mode-mask')!;

const btnRescan = document.getElementById('btn-rescan')!;
const btnToggle = document.getElementById('btn-toggle')!;
const btnViewPayload = document.getElementById('btn-view-payload')!;

const payloadModal = document.getElementById('payload-modal')!;
const btnClosePayload = document.getElementById('btn-close-payload')!;
const payloadJson = document.getElementById('payload-json')!;

const statusTitle = document.getElementById('status-title')!;
const statusSub = document.getElementById('status-sub')!;
const statusCard = document.getElementById('status-card')!;

// UI Elements — Milestone 3 visual capture & OCR section
const btnCapture = document.getElementById('btn-capture')!;
const captureStatusEl = document.getElementById('capture-status')!;
const viewModeContainer = document.getElementById('view-mode-container')!;
const btnViewOriginal = document.getElementById('btn-view-original')!;
const btnViewDetected = document.getElementById('btn-view-detected')!;
const btnViewSanitized = document.getElementById('btn-view-sanitized')!;

const canvasContainer = document.getElementById('canvas-container')!;
const previewCanvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const captureMetaEl = document.getElementById('capture-meta')!;

const metaCombined = document.getElementById('meta-combined')!;
const metaDomDetections = document.getElementById('meta-dom-detections')!;
const metaOcrSensitive = document.getElementById('meta-ocr-sensitive')!;
const metaOcrScanned = document.getElementById('meta-ocr-scanned')!;
const metaOcrLatency = document.getElementById('meta-ocr-latency')!;
const metaViewport = document.getElementById('meta-viewport')!;
const metaScreenshot = document.getElementById('meta-screenshot')!;
const metaScale = document.getElementById('meta-scale')!;
const metaPartialOffscreen = document.getElementById('meta-partial-offscreen')!;
const metaCaptureStatus = document.getElementById('meta-capture-status')!;
const btnViewVisualPayload = document.getElementById('btn-view-visual-payload')!;

// UI Elements — Milestone 4 Agent API
const btnSendAgent = document.getElementById('btn-send-agent') as HTMLButtonElement;
const agentStatusEl = document.getElementById('agent-status')!;
const agentMetaEl = document.getElementById('agent-meta')!;
const agentDetectionCount = document.getElementById('agent-detection-count')!;
const agentLastSent = document.getElementById('agent-last-sent')!;
const healthDot = document.getElementById('health-dot')!;
const healthLabel = document.getElementById('health-label')!;
const btnViewAgentPayload = document.getElementById('btn-view-agent-payload')!;

// Agent payload cache (for View JSON)
let lastAgentPayload: AgentContextPayload | null = null;

// ── DOM Scan UI helpers ─────────────────────────────────────────────────────

function updateUI(report: PrivacyScanReport): void {
  currentReport = report;

  if (report.status === 'Excluded Site') {
    statusTitle.textContent = 'Site Excluded From Scanning';
    statusSub.textContent = 'Development exclusion active (AI interface or browser protocol).';
    statusCard.style.borderColor = 'rgba(59, 130, 246, 0.4)';
    statusCard.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
  } else {
    statusTitle.textContent = 'Sanitized Context — Local Privacy Check Passed';
    statusSub.textContent = 'Sensitive information masked locally on-device.';
    statusCard.style.borderColor = 'rgba(16, 185, 129, 0.35)';
    statusCard.style.backgroundColor = 'rgba(16, 185, 129, 0.12)';
  }

  metricDetected.textContent = String(report.sensitiveElementsDetected);
  metricProtected.textContent = String(report.elementsProtected);
  metricLeakage.textContent = String(report.leakageCount);

  benchScan.textContent = `${report.scanLatencyMs.toFixed(1)} ms`;
  benchRedact.textContent = `${report.redactionLatencyMs.toFixed(1)} ms`;

  // Categories
  catPassword.textContent = String(report.categories.password || 0);
  catCard.textContent = String(report.categories.credit_card || 0);
  catAccount.textContent = String(report.categories.account_number || 0);
  catEmail.textContent = String(report.categories.email || 0);
  catPhone.textContent = String(report.categories.phone || 0);
  if (catPan) catPan.textContent = String(report.categories.pan || 0);
  if (catCvv) catCvv.textContent = String((report.categories.cvv || 0) + (report.categories.otp || 0));
  catName.textContent = String(report.categories.person_name || 0);

  // Redaction Mode Buttons
  [btnModeBlackout, btnModeBlur, btnModeMask].forEach(btn => btn.classList.remove('active'));
  if (report.redactionMode === 'blackout') btnModeBlackout.classList.add('active');
  if (report.redactionMode === 'blur') btnModeBlur.classList.add('active');
  if (report.redactionMode === 'mask') btnModeMask.classList.add('active');
  selectedMode = report.redactionMode;
}

async function getActiveWebTab(): Promise<chrome.tabs.Tab | null> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && activeTab.url && !activeTab.url.startsWith('chrome-extension://') && !activeTab.url.startsWith('chrome://')) {
    return activeTab;
  }
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  return tabs.length > 0 ? tabs[0] : (activeTab ?? null);
}

async function sendTabMessage(msg: ExtensionMessage): Promise<any> {
  const tab = await getActiveWebTab();
  if (!tab?.id) {
    console.warn('[PrivAgent Popup] No active tab found.');
    return null;
  }

  const tabId = tab.id;

  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // If content script is missing (e.g. tab opened before extension reload)
    if (
      errorMsg.includes('Could not establish connection') ||
      errorMsg.includes('Receiving end does not exist')
    ) {
      try {
        // Self-heal: inject content script dynamically using 'scripting' permission
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['contentScript.js'],
        });
        await chrome.scripting.insertCSS({
          target: { tabId },
          files: ['contentStyles.css'],
        });
        // Brief pause for script initialization
        await new Promise(resolve => setTimeout(resolve, 80));
        return await chrome.tabs.sendMessage(tabId, msg);
      } catch (injectErr) {
        // Tab is likely a restricted page (e.g., chrome://, edge://, file:// without access)
        statusTitle.textContent = 'Active Page Connection Unavailable';
        statusSub.textContent = 'Please refresh the tab or navigate to a web page (e.g. http://localhost:4174).';
        statusCard.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        statusCard.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
        return null;
      }
    }

    console.warn('[PrivAgent Popup] Message send failed:', errorMsg);
    return null;
  }
}

async function initPopup(): Promise<void> {
  const res = await sendTabMessage({ type: 'PRIVAGENT_GET_STATE' });
  if (res?.report) {
    updateUI(res.report);
    isRedactionActive = res.isRedactionActive;
    btnToggle.textContent = isRedactionActive ? 'Redaction: ON' : 'Redaction: OFF';
  } else {
    triggerRescan();
  }
}

async function triggerRescan(): Promise<void> {
  benchScan.textContent = 'Scanning...';
  const res = await sendTabMessage({ type: 'PRIVAGENT_SCAN_REQUEST', mode: selectedMode });
  if (res?.report) {
    updateUI(res.report);
  }
}

async function setMode(mode: RedactionMode): Promise<void> {
  selectedMode = mode;
  const res = await sendTabMessage({ type: 'PRIVAGENT_SET_REDACTION_MODE', mode });
  if (res?.report) {
    updateUI(res.report);
  }

  // If visual canvas is rendered, immediately update sanitized view
  if (cachedOriginalImage) {
    renderCurrentVisualView();
  }
}

// ── Milestone 3: Visual Capture & Local OCR Pipeline ─────────────────────────

function setCaptureStatus(msg: string, isError = false): void {
  captureStatusEl.textContent = msg;
  captureStatusEl.style.display = 'block';
  captureStatusEl.style.color = isError ? '#f87171' : '#a3e635';
}

/**
 * Re-renders the preview canvas depending on the active view mode:
 * - 'original': unredacted raw screenshot
 * - 'detected': original screenshot with bounding boxes & [DOM]/[OCR] badges
 * - 'sanitized': redacted screenshot with current mode (blackout/blur/mask)
 */
function renderCurrentVisualView(): void {
  if (!cachedOriginalImage) return;

  const redactor = new VisualCanvasRedactor();
  previewCanvas.width = cachedOriginalImage.naturalWidth || cachedOriginalImage.width;
  previewCanvas.height = cachedOriginalImage.naturalHeight || cachedOriginalImage.height;
  const ctx = previewCanvas.getContext('2d')!;

  if (activeViewMode === 'original') {
    // Draw untouched screenshot
    ctx.drawImage(cachedOriginalImage, 0, 0);
  } else if (activeViewMode === 'detected') {
    // Draw original image with debug detection badges showing [DOM] vs [OCR]
    const detectedCanvas = redactor.renderSanitizedCanvas(
      cachedOriginalImage,
      cachedVisualDetections,
      {
        mode: selectedMode,
        drawDebugOverlay: true,
      }
    );
    ctx.drawImage(detectedCanvas, 0, 0);
  } else {
    // 'sanitized': Draw cleanly redacted canvas
    const sanitizedCanvas = redactor.renderSanitizedCanvas(
      cachedOriginalImage,
      cachedVisualDetections,
      {
        mode: selectedMode,
        drawDebugOverlay: false,
      }
    );
    ctx.drawImage(sanitizedCanvas, 0, 0);
  }

  canvasContainer.style.display = 'block';

  // Update view mode button states
  [btnViewOriginal, btnViewDetected, btnViewSanitized].forEach(b => b.classList.remove('active'));
  if (activeViewMode === 'original') btnViewOriginal.classList.add('active');
  if (activeViewMode === 'detected') btnViewDetected.classList.add('active');
  if (activeViewMode === 'sanitized') btnViewSanitized.classList.add('active');
}

/**
 * Runs the full visual perception + Local OCR pipeline from the popup context:
 *  1. Get active tab
 *  2. Request DOM scan from content script
 *  3. Request viewport geometry
 *  4. Request screenshot from background service worker
 *  5. Decode image to get AUTHORITATIVE actual dimensions
 *  6. Map DOM detections to screenshot coordinates
 *  7. Initialize & Run Local OCR on captured image
 *  8. Classify OCR sensitive regions (stripping raw text)
 *  9. Unify visual detections (DOM + OCR)
 * 10. Render preview canvas
 */
async function runVisualCapture(): Promise<void> {
  btnCapture.setAttribute('disabled', 'true');
  setCaptureStatus('⏳ Requesting screenshot from background…');
  canvasContainer.style.display = 'none';
  captureMetaEl.style.display = 'none';
  viewModeContainer.style.display = 'none';

  try {
    const tab = await getActiveWebTab();
    if (!tab?.id) {
      setCaptureStatus('❌ No active tab available.', true);
      return;
    }
    const tabId = tab.id;

    // Step 1: Fresh DOM scan
    setCaptureStatus('⏳ Scanning DOM…');
    const scanRes = await sendTabMessage({
      type: 'PRIVAGENT_SCAN_REQUEST',
      mode: selectedMode,
    } as ExtensionMessage);

    if (scanRes?.report) {
      updateUI(scanRes.report);
    }

    const domDetections = scanRes?.report?.detections ?? [];

    // Step 2: Collect viewport geometry
    setCaptureStatus('⏳ Getting Geometry…');
    const geoRes = await sendTabMessage({
      type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY',
    } as ExtensionMessage);

    if (!geoRes || geoRes.type !== 'PRIVAGENT_GET_VIEWPORT_GEOMETRY_RESPONSE') {
      setCaptureStatus('❌ Could not read viewport geometry. Please refresh the active tab.', true);
      return;
    }

    const geometry = {
      viewportWidth: geoRes.viewportWidth as number,
      viewportHeight: geoRes.viewportHeight as number,
      scrollX: geoRes.scrollX as number,
      scrollY: geoRes.scrollY as number,
      devicePixelRatio: geoRes.devicePixelRatio as number,
    };

    // Step 3: Capture screenshot
    setCaptureStatus('📸 Capturing Screenshot…');
    const capRes: any = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'PRIVAGENT_CAPTURE_SCREENSHOT' } as ExtensionMessage, resolve);
    });

    if (capRes?.error || !capRes?.dataUrl) {
      setCaptureStatus(`❌ Capture failed: ${capRes?.error ?? 'Unknown error'}`, true);
      return;
    }

    const dataUrl: string = capRes.dataUrl;

    // Step 4: Decode screenshot dimensions
    setCaptureStatus('🖼️ Decoding Screenshot…');
    const { image, actualWidth, actualHeight } = await decodeImage(dataUrl);
    cachedOriginalImage = image;

    const screenshotDimensions = { screenshotWidth: actualWidth, screenshotHeight: actualHeight };

    // Step 5: Map DOM detections
    setCaptureStatus('📐 Mapping DOM…');
    const domVisualDetections: VisualDetectionResult[] = [];
    let domPartial = 0;
    let totalOffscreenFiltered = 0;

    for (const det of domDetections) {
      const mapped = mapDOMToScreenshot(det.bbox, geometry, screenshotDimensions, true);
      if (!mapped) {
        totalOffscreenFiltered++;
        continue;
      }
      if (mapped.isPartiallyVisible) domPartial++;
      domVisualDetections.push({
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

    const scaleX = actualWidth / geometry.viewportWidth;
    const scaleY = actualHeight / geometry.viewportHeight;

    // Step 6: Initialize & Run Local OCR
    setCaptureStatus('🔍 Running Local OCR…');
    if (!localOcrEngine) {
      localOcrEngine = new LocalOCREngine();
    }
    const ocrResult = await localOcrEngine.recognize(image);

    // Step 7: Classify OCR regions into safe detections
    setCaptureStatus('🛡️ Classifying OCR Regions…');
    const ocrSafeDetections = detectSensitiveOCRRegions(ocrResult, {
      width: actualWidth,
      height: actualHeight,
    });

    let ocrPartial = 0;
    const ocrVisualDetections: VisualDetectionResult[] = ocrSafeDetections.map(det => {
      if (det.isPartiallyVisible) ocrPartial++;
      const [sx, sy, sw, sh] = det.bbox;
      return {
        id: det.id,
        type: det.type,
        confidence: det.confidence,
        selector: 'canvas:visual-ocr',
        viewportBBox: [Math.round(sx / scaleX), Math.round(sy / scaleY), Math.round(sw / scaleX), Math.round(sh / scaleY)],
        screenshotBBox: [sx, sy, sw, sh],
        isPartiallyVisible: det.isPartiallyVisible,
        source: 'ocr',
      };
    });

    // Step 8: Unified visual detections
    cachedVisualDetections = [...domVisualDetections, ...ocrVisualDetections];

    // Step 9: Render preview canvas
    setCaptureStatus('🎨 Rendering Sanitized Screenshot…');
    viewModeContainer.style.display = 'block';
    renderCurrentVisualView();

    // Step 10: Create VisualCaptureReport and update telemetry panel
    currentVisualReport = {
      captureMetadata: {
        viewportWidth: geometry.viewportWidth,
        viewportHeight: geometry.viewportHeight,
        screenshotWidth: actualWidth,
        screenshotHeight: actualHeight,
        devicePixelRatio: geometry.devicePixelRatio,
        scaleX,
        scaleY,
        scrollX: geometry.scrollX,
        scrollY: geometry.scrollY,
        capturedAt: Date.now(),
      },
      visualDetections: cachedVisualDetections,
      totalDetected: cachedVisualDetections.length,
      totalPartiallyVisible: domPartial + ocrPartial,
      totalOffscreenFiltered,
      ocrRegionsScanned: ocrResult.words.length,
      sensitiveOCRDetected: ocrVisualDetections.length,
      ocrLatencyMs: Number(ocrResult.latencyMs.toFixed(1)),
      domSensitiveDetected: domVisualDetections.length,
      status: 'Local Visual Context Prepared',
    };

    metaCombined.textContent = `${cachedVisualDetections.length} (${domVisualDetections.length} DOM + ${ocrVisualDetections.length} OCR)`;
    metaDomDetections.textContent = String(domVisualDetections.length);
    metaOcrSensitive.textContent = String(ocrVisualDetections.length);
    metaOcrScanned.textContent = `${ocrResult.words.length} tokens`;
    metaOcrLatency.textContent = `${ocrResult.latencyMs.toFixed(1)} ms`;
    metaViewport.textContent = `${geometry.viewportWidth} × ${geometry.viewportHeight} px`;
    metaScreenshot.textContent = `${actualWidth} × ${actualHeight} px`;
    metaScale.textContent = `${scaleX.toFixed(4)} × ${scaleY.toFixed(4)}`;
    metaPartialOffscreen.textContent = `${domPartial + ocrPartial} partial / ${totalOffscreenFiltered} off-screen`;
    metaCaptureStatus.textContent = 'Local Visual Context Prepared ✅';
    captureMetaEl.style.display = 'block';

    setCaptureStatus('Local Visual Context Prepared ✅');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setCaptureStatus(`❌ Error: ${msg}`, true);
    console.error('[PrivAgent Popup] Visual capture error:', err);
  } finally {
    btnCapture.removeAttribute('disabled');
  }
}

/**
 * Loads an HTMLImageElement from a data URL and returns its ACTUAL decoded dimensions.
 */
function decodeImage(dataUrl: string): Promise<{ image: HTMLImageElement; actualWidth: number; actualHeight: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ image: img, actualWidth: img.naturalWidth, actualHeight: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to decode captured screenshot image.'));
    img.src = dataUrl;
  });
}

// ── Event Listeners ─────────────────────────────────────────────────────────

btnRescan.addEventListener('click', triggerRescan);

btnModeBlackout.addEventListener('click', () => setMode('blackout'));
btnModeBlur.addEventListener('click', () => setMode('blur'));
btnModeMask.addEventListener('click', () => setMode('mask'));

btnToggle.addEventListener('click', async () => {
  isRedactionActive = !isRedactionActive;
  btnToggle.textContent = isRedactionActive ? 'Redaction: ON' : 'Redaction: OFF';
  const res = await sendTabMessage({ type: 'PRIVAGENT_TOGGLE_REDACTION', enabled: isRedactionActive });
  if (res?.report) {
    updateUI(res.report);
  }
});

btnViewPayload.addEventListener('click', () => {
  if (currentReport) {
    payloadJson.textContent = JSON.stringify(currentReport, null, 2);
    payloadModal.classList.add('open');
  } else {
    payloadJson.textContent = '// No scan report available yet. Run a scan first.';
    payloadModal.classList.add('open');
  }
});

btnViewVisualPayload.addEventListener('click', () => {
  if (currentVisualReport) {
    payloadJson.textContent = JSON.stringify(currentVisualReport, null, 2);
    payloadModal.classList.add('open');
  } else {
    payloadJson.textContent = '// No visual capture report available yet. Run capture first.';
    payloadModal.classList.add('open');
  }
});

btnClosePayload.addEventListener('click', () => {
  payloadModal.classList.remove('open');
});

// View mode selectors
btnViewOriginal.addEventListener('click', () => {
  activeViewMode = 'original';
  renderCurrentVisualView();
});

btnViewDetected.addEventListener('click', () => {
  activeViewMode = 'detected';
  renderCurrentVisualView();
});

btnViewSanitized.addEventListener('click', () => {
  activeViewMode = 'sanitized';
  renderCurrentVisualView();
});

// Milestone 3 capture button
btnCapture.addEventListener('click', runVisualCapture);

// ── Milestone 4: Agent API ────────────────────────────────────────────────────

function setHealthStatus(state: 'online' | 'offline' | 'checking', label: string): void {
  healthDot.className = `health-dot ${state}`;
  healthLabel.textContent = label;
}

function setAgentStatus(msg: string, isSuccess: boolean | null = null): void {
  agentStatusEl.textContent = msg;
  agentStatusEl.style.display = 'block';
  agentStatusEl.className = 'agent-status';
  if (isSuccess === true) agentStatusEl.classList.add('success');
  if (isSuccess === false) agentStatusEl.classList.add('error');
}

async function runHealthCheck(): Promise<void> {
  setHealthStatus('checking', 'Checking…');
  const result = await checkBackendHealth();
  if (result.online) {
    setHealthStatus('online', `● Online (v${result.version})`);
    btnSendAgent.disabled = false;
  } else {
    setHealthStatus('offline', '○ Offline');
    btnSendAgent.disabled = true;
  }
}

btnSendAgent.addEventListener('click', async () => {
  if (!currentReport) {
    setAgentStatus('❌ No DOM scan report. Run a scan first.', false);
    return;
  }

  btnSendAgent.disabled = true;
  btnSendAgent.textContent = '⏳ Sending…';
  setAgentStatus('⏳ Building sanitized payload…');

  try {
    const result = await sendSanitizedContext(currentReport, currentVisualReport);

    if (result.success) {
      // Cache payload for JSON preview (re-build using allowlist)
      lastAgentPayload = buildAgentPayload(currentReport, currentVisualReport);

      setAgentStatus(`✅ Sanitized context sent — ${result.detectionCount} detection(s) transmitted.`, true);
      agentDetectionCount.textContent = String(result.detectionCount);
      agentLastSent.textContent = new Date(result.receivedAt).toLocaleTimeString();
      agentMetaEl.style.display = 'block';
    } else {
      setAgentStatus(`❌ ${result.error}`, false);
      // Re-check health in case backend went down
      await runHealthCheck();
    }
  } catch (err) {
    setAgentStatus(`❌ Unexpected error: ${err instanceof Error ? err.message : String(err)}`, false);
  } finally {
    btnSendAgent.textContent = '🤖 Send to Agent API';
    // Re-enable only if backend is still online
    const health = await checkBackendHealth();
    btnSendAgent.disabled = !health.online;
  }
});

btnViewAgentPayload.addEventListener('click', () => {
  if (lastAgentPayload) {
    payloadJson.textContent = JSON.stringify(lastAgentPayload, null, 2);
    payloadModal.classList.add('open');
  } else {
    payloadJson.textContent = '// No agent payload yet. Run a scan and send to Agent API first.';
    payloadModal.classList.add('open');
  }
});

// Initialize on open
document.addEventListener('DOMContentLoaded', async () => {
  await initPopup();
  // Kick off health check without blocking popup init
  runHealthCheck();
});
