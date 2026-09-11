import { ExtensionMessage, PrivacyScanReport, RedactionMode } from '../privacy/types';

let currentReport: PrivacyScanReport | null = null;
let isRedactionActive = true;
let selectedMode: RedactionMode = 'blackout';

// UI Elements
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

// Event Listeners
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

// Initialize on open
document.addEventListener('DOMContentLoaded', initPopup);
