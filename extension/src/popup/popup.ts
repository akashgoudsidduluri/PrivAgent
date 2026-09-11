import { ExtensionMessage, PrivacyScanReport, RedactionMode, VisualCaptureReport } from '../privacy/types';
import { VisualCanvasRedactor } from '../capture/visualRedactor';

let currentReport: PrivacyScanReport | null = null;
let isRedactionActive = true;
let selectedMode: RedactionMode = 'blackout';

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

// UI Elements — Milestone 2 visual capture section
const btnCapture = document.getElementById('btn-capture')!;
const captureStatusEl = document.getElementById('capture-status')!;
const canvasContainer = document.getElementById('canvas-container')!;
const previewCanvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const captureMetaEl = document.getElementById('capture-meta')!;

const metaViewport = document.getElementById('meta-viewport')!;
const metaScreenshot = document.getElementById('meta-screenshot')!;
const metaScale = document.getElementById('meta-scale')!;
const metaScroll = document.getElementById('meta-scroll')!;
const metaDpr = document.getElementById('meta-dpr')!;
const metaDetections = document.getElementById('meta-detections')!;
const metaPartial = document.getElementById('meta-partial')!;
const metaOffscreen = document.getElementById('meta-offscreen')!;
const metaCaptureStatus = document.getElementById('meta-capture-status')!;

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
  catName.textContent = String(report.categories.person_name || 0);

  // Redaction Mode Buttons
  [btnModeBlackout, btnModeBlur, btnModeMask].forEach(btn => btn.classList.remove('active'));
  if (report.redactionMode === 'blackout') btnModeBlackout.classList.add('active');
  if (report.redactionMode === 'blur') btnModeBlur.classList.add('active');
  if (report.redactionMode === 'mask') btnModeMask.classList.add('active');
  selectedMode = report.redactionMode;
}

async function sendTabMessage(msg: ExtensionMessage): Promise<any> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    console.warn('[PrivAgent Popup] No active tab found.');
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (err) {
    console.error('[PrivAgent Popup] Message send failed:', err);
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
    // Trigger fresh scan
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
}

// ── Milestone 2: Visual Capture Pipeline ────────────────────────────────────

function setCaptureStatus(msg: string, isError = false): void {
  captureStatusEl.textContent = msg;
  captureStatusEl.style.display = 'block';
  captureStatusEl.style.color = isError ? '#f87171' : '#a3e635';
}

/**
 * Runs the full visual capture pipeline from the popup context:
 *  1. Get active tab
 *  2. Request DOM scan from content script (for fresh detections)
 *  3. Request viewport geometry from content script
 *  4. Request screenshot from background service worker
 *  5. Decode image to get ACTUAL dimensions
 *  6. Map detections to screenshot coordinates
 *  7. Render sanitized canvas preview
 */
async function runVisualCapture(): Promise<void> {
  btnCapture.setAttribute('disabled', 'true');
  setCaptureStatus('⏳ Requesting screenshot from background…');
  canvasContainer.style.display = 'none';
  captureMetaEl.style.display = 'none';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setCaptureStatus('❌ No active tab available.', true);
      return;
    }
    const tabId = tab.id;

    // Step 1: Fresh DOM scan to ensure detections are up to date
    setCaptureStatus('⏳ Running DOM scan…');
    const scanRes = await chrome.tabs.sendMessage(tabId, {
      type: 'PRIVAGENT_SCAN_REQUEST',
      mode: selectedMode,
    } as ExtensionMessage);

    if (scanRes?.report) {
      updateUI(scanRes.report);
    }

    const detections = scanRes?.report?.detections ?? [];

    // Step 2: Collect viewport geometry
    setCaptureStatus('⏳ Collecting viewport geometry…');
    const geoRes = await chrome.tabs.sendMessage(tabId, {
      type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY',
    } as ExtensionMessage);

    if (!geoRes || geoRes.type !== 'PRIVAGENT_GET_VIEWPORT_GEOMETRY_RESPONSE') {
      setCaptureStatus('❌ Could not read viewport geometry.', true);
      return;
    }

    const geometry = {
      viewportWidth: geoRes.viewportWidth as number,
      viewportHeight: geoRes.viewportHeight as number,
      scrollX: geoRes.scrollX as number,
      scrollY: geoRes.scrollY as number,
      devicePixelRatio: geoRes.devicePixelRatio as number,
    };

    // Step 3: Capture screenshot via background service worker
    setCaptureStatus('📸 Capturing visible viewport…');
    const capRes: any = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'PRIVAGENT_CAPTURE_SCREENSHOT' } as ExtensionMessage, resolve);
    });

    if (capRes?.error || !capRes?.dataUrl) {
      setCaptureStatus(`❌ Capture failed: ${capRes?.error ?? 'Unknown error'}`, true);
      return;
    }

    const dataUrl: string = capRes.dataUrl;

    // Step 4: Decode image to obtain AUTHORITATIVE actual dimensions
    setCaptureStatus('🖼️ Decoding screenshot dimensions…');
    const { image, actualWidth, actualHeight } = await decodeImage(dataUrl);

    // Step 5: Map detections to screenshot pixel coordinates
    setCaptureStatus('📐 Mapping detection coordinates…');
    const { mapDOMToScreenshot } = await import('../capture/coordinateMapper');

    const screenshotDimensions = { screenshotWidth: actualWidth, screenshotHeight: actualHeight };

    const visualDetections: VisualCaptureReport['visualDetections'] = [];
    let totalPartiallyVisible = 0;
    let totalOffscreenFiltered = 0;

    for (const det of detections) {
      const mapped = mapDOMToScreenshot(det.bbox, geometry, screenshotDimensions, true);
      if (!mapped) {
        totalOffscreenFiltered++;
        continue;
      }
      if (mapped.isPartiallyVisible) totalPartiallyVisible++;
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

    const scaleX = actualWidth / geometry.viewportWidth;
    const scaleY = actualHeight / geometry.viewportHeight;

    // Step 6: Render sanitized canvas preview
    setCaptureStatus('🎨 Rendering sanitized visual preview…');
    const redactor = new VisualCanvasRedactor();
    const sanitizedCanvas = redactor.renderSanitizedCanvas(image, visualDetections, {
      mode: selectedMode,
      drawDebugOverlay: true,
    });

    // Render scaled preview into the popup canvas
    previewCanvas.width = sanitizedCanvas.width;
    previewCanvas.height = sanitizedCanvas.height;
    const ctx = previewCanvas.getContext('2d')!;
    ctx.drawImage(sanitizedCanvas, 0, 0);

    canvasContainer.style.display = 'block';

    // Step 7: Populate metadata panel
    metaViewport.textContent = `${geometry.viewportWidth} × ${geometry.viewportHeight} px`;
    metaScreenshot.textContent = `${actualWidth} × ${actualHeight} px`;
    metaScale.textContent = `${scaleX.toFixed(4)} × ${scaleY.toFixed(4)}`;
    metaScroll.textContent = `${geometry.scrollX}, ${geometry.scrollY}`;
    metaDpr.textContent = `${geometry.devicePixelRatio} (diagnostic only)`;
    metaDetections.textContent = String(visualDetections.length);
    metaPartial.textContent = String(totalPartiallyVisible);
    metaOffscreen.textContent = String(totalOffscreenFiltered);
    metaCaptureStatus.textContent = 'Local Visual Context Prepared ✅';
    captureMetaEl.style.display = 'block';

    setCaptureStatus('✅ Visual capture complete — sanitized locally.');
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
 * Uses naturalWidth/naturalHeight as the authoritative source — NOT devicePixelRatio math.
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

btnClosePayload.addEventListener('click', () => {
  payloadModal.classList.remove('open');
});

// Milestone 2 capture button
btnCapture.addEventListener('click', runVisualCapture);

// Initialize on open
document.addEventListener('DOMContentLoaded', initPopup);
