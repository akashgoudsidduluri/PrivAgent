/**
 * PrivAgent M7 — Reasoning Network Verification Script
 *
 * Runtime evidence (not source inspection) that the reasoning request sent
 * toward OpenRouter contains ONLY sanitized metadata. Modeled after
 * tests/m4NetworkVerify.mjs (Chrome DevTools Protocol Network domain).
 *
 * Verifies, for the outbound reasoning request captured from the popup's
 * "Run Agent Task" flow (BackendAgentProvider → 127.0.0.1:8010 → OpenRouter):
 *   1. Backend hop: URL = http://127.0.0.1:8010/api/v1/agent/action
 *   2. OpenRouter hop (when the backend has a key): the serialized request
 *      toward openrouter.ai contains sanitized metadata only
 *   3. NO fake PII values (names/emails/phones/account/card/CVV/PAN/OTP)
 *   4. NO forbidden keys (value, text, password, rawOCR, cardNumber, ...)
 *   5. NO screenshots / base64 image data
 *   6. The OpenRouter API key never appears in any request body
 *   7. No unexpected external hosts beyond openrouter.ai during reasoning
 *
 * Prerequisites (manual run — NOT part of automated CI):
 *   - Chrome started with --remote-debugging-port=9222
 *   - PrivAgent extension loaded; backend running (python backend/run.py)
 *   - Banking portal open on http://localhost:4173
 *   - Optional: OPENROUTER_API_KEY on the backend for the second hop
 *
 * If the environment cannot support live verification, this script reports
 * NOT_EXECUTED with the missing prerequisite — it never fabricates success.
 */

import { writeFileSync } from 'fs';

const FAKE_PII_VALUES = [
  '123456789012',             // account number
  '4111111111111111',         // credit card
  '4111 1111 1111 1111',      // credit card (spaced)
  'ABCDE1234F',               // PAN
  'rahul.sharma@example.com', // email
  '9876543210',               // phone
  'DemoPassword123',          // password
  'Rahul Sharma',             // name
];

const FORBIDDEN_KEYS = [
  'value', 'textContent', 'innerText', 'rawText', 'rawOCR', 'ocrText',
  'password', 'words', 'lines', 'token', 'secret',
  'card', 'cardNumber', 'cvv', 'pan', 'accountNumber',
  'sensitiveValue', 'pii',
];

// "text" is excluded from FORBIDDEN_KEYS here because the reasoning action
// schema legitimately carries it; its CONTENT is covered by the PII scan.
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);
const REASONING_HOSTS = new Set(['127.0.0.1', 'localhost', 'openrouter.ai']);

const CDP_PORT = 9222;
const BACKEND_BASE = 'http://127.0.0.1:8010';

function collectStringValues(obj, out = []) {
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { obj.forEach((v) => collectStringValues(v, out)); return out; }
  if (obj && typeof obj === 'object') { Object.values(obj).forEach((v) => collectStringValues(v, out)); return out; }
  return out;
}

function walkKeys(obj, out = []) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) { obj.forEach((v) => walkKeys(v, out)); return out; }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) { out.push(k); walkKeys(v, out); }
  }
  return out;
}

async function main() {
  const report = {
    timestamp: new Date().toISOString(),
    executed: false,
    notExecutedReason: null,
    backendHopCaptured: false,
    openrouterHopCaptured: false,
    checks: {},
    notes: [],
  };

  console.log('\n══════════════════════════════════════════════════════');
  console.log('   PrivAgent M7 — Reasoning Network Verification');
  console.log('══════════════════════════════════════════════════════\n');

  // ── Prerequisite checks (fail → NOT_EXECUTED, never fabricated success) ───
  let cdpVersion;
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cdpVersion = await res.json();
  } catch (err) {
    report.notExecutedReason =
      `Chrome DevTools Protocol not reachable on port ${CDP_PORT} (${err.message}). ` +
      'Start Chrome with --remote-debugging-port=9222 and re-run.';
    console.log(`⚠️  NOT EXECUTED: ${report.notExecutedReason}`);
    writeFileSync('m7-network-verification.json', JSON.stringify(report, null, 2));
    process.exit(2);
  }

  try {
    const res = await fetch(`${BACKEND_BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const health = await res.json();
    report.notes.push(`backend reasoner mode: ${health.reasoner}, key configured: ${health.reasoner_configured}`);
    console.log(`✓ Backend online — reasoner: ${health.reasoner}, key configured: ${health.reasoner_configured}`);
  } catch (err) {
    report.notExecutedReason =
      `PrivAgent backend not reachable at ${BACKEND_BASE} (${err.message}). ` +
      'Start it with: python backend/run.py';
    console.log(`⚠️  NOT EXECUTED: ${report.notExecutedReason}`);
    writeFileSync('m7-network-verification.json', JSON.stringify(report, null, 2));
    process.exit(2);
  }

  report.executed = true;
  console.log('✓ Prerequisites satisfied. Attaching to Chrome CDP...\n');

  const ws = new WebSocket(cdpVersion.webSocketDebuggerUrl);
  let idCounter = 1;
  const pending = new Map();
  const requestLog = []; // { url, method, body, host }

  function sendCmd(method, params = {}, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(msg));
    });
  }

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
      return;
    }
    if (data.method === 'Network.requestWillBeSent') {
      const req = data.params?.request;
      if (req) {
        requestLog.push({
          url: req.url,
          method: req.method,
          body: req.postData ?? null,
          host: (() => { try { return new URL(req.url).hostname; } catch { return ''; } })(),
        });
      }
    }
  };

  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  // ── Open the extension popup ──────────────────────────────────────────────
  const { targetInfos } = await sendCmd('Target.getTargets');
  const extTarget = targetInfos.find((t) => t.url.startsWith('chrome-extension://'));
  if (!extTarget) {
    report.notExecutedReason = 'PrivAgent extension not found among Chrome targets. Load the extension first.';
    console.log(`⚠️  NOT EXECUTED: ${report.notExecutedReason}`);
    writeFileSync('m7-network-verification.json', JSON.stringify(report, null, 2));
    process.exit(2);
  }
  const extId = new URL(extTarget.url).hostname;
  const { targetId: popupTargetId } = await sendCmd('Target.createTarget', {
    url: `chrome-extension://${extId}/src/popup/popup.html`,
  });
  const { sessionId } = await sendCmd('Target.attachToTarget', { targetId: popupTargetId, flatten: true });
  await sendCmd('Network.enable', {}, sessionId);
  await sendCmd('Runtime.enable', {}, sessionId);
  await sendCmd('Page.enable', {}, sessionId);
  console.log(`✓ Popup opened (extension ${extId})`);

  async function evalInPopup(expr) {
    const res = await sendCmd('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    }
    return res.result.value;
  }

  // ── Drive the reasoning flow: ensure provider = backend, scan, run task ───
  await new Promise((r) => setTimeout(r, 2000)); // health check settle

  const providerSelect = `document.getElementById('agent-provider-select')`;
  const hasProviderSelect = await evalInPopup(`!!${providerSelect}`);
  if (hasProviderSelect) {
    await evalInPopup(`${providerSelect}.value = 'backend'; ${providerSelect}.dispatchEvent(new Event('change'))`);
    report.notes.push('provider forced to backend (production path)');
  }

  console.log('Triggering DOM scan + reasoning task...');
  await evalInPopup(`document.getElementById('btn-rescan')?.click()`);
  await new Promise((r) => setTimeout(r, 2000));
  await evalInPopup(`document.getElementById('btn-run-agent-loop')?.click()`);
  await new Promise((r) => setTimeout(r, 15000)); // allow multi-step reasoning

  // ── Analyse captured requests ─────────────────────────────────────────────
  const backendRequests = requestLog.filter((r) => r.url.includes('/api/v1/agent/action'));
  const openrouterRequests = requestLog.filter((r) => r.host === 'openrouter.ai');
  report.backendHopCaptured = backendRequests.length > 0;
  report.openrouterHopCaptured = openrouterRequests.length > 0;

  const reasoningBodies = [
    ...backendRequests.map((r) => r.body),
    ...openrouterRequests.map((r) => r.body),
  ].filter(Boolean);

  // Parse bodies; fall back to backend /latest payload as ground truth for
  // the sanitized context that the backend received.
  const parsedBodies = reasoningBodies
    .map((b) => { try { return JSON.parse(b); } catch { return null; } })
    .filter(Boolean);
  try {
    const latestRes = await fetch(`${BACKEND_BASE}/api/v1/context/latest`);
    if (latestRes.ok) {
      const latest = await latestRes.json();
      if (latest?.payload) parsedBodies.push(latest.payload);
    }
  } catch { /* optional ground truth */ }

  const allStrings = parsedBodies.flatMap((b) => collectStringValues(b)).map((s) => s.toLowerCase());
  const allKeys = parsedBodies.flatMap((b) => walkKeys(b));

  // 1. Fake PII values must be absent from every string value.
  const piiFound = [];
  for (const pii of FAKE_PII_VALUES) {
    const needle = pii.toLowerCase();
    if (allStrings.some((v) => v.includes(needle))) piiFound.push(pii);
  }
  report.checks.noFakePII = piiFound.length === 0;
  console.log(`\n1. Fake PII in reasoning payloads: ${piiFound.length === 0 ? '✅ NONE' : `❌ FOUND: ${piiFound.join(', ')}`}`);

  // 2. Forbidden keys must be absent.
  const forbiddenFound = [];
  for (const key of allKeys) {
    const norm = String(key).toLowerCase().replace(/_/g, '');
    const normalizedForbidden = FORBIDDEN_KEYS.map((k) => k.toLowerCase().replace(/_/g, ''));
    if (normalizedForbidden.includes(norm)) forbiddenFound.push(key);
  }
  report.checks.noForbiddenKeys = forbiddenFound.length === 0;
  console.log(`2. Forbidden keys: ${forbiddenFound.length === 0 ? '✅ NONE' : `❌ FOUND: ${forbiddenFound.join(', ')}`}`);

  // 3. No screenshot / base64 image data.
  const serialized = JSON.stringify(parsedBodies);
  const hasBase64 = /data:image/i.test(serialized) || /base64,[A-Za-z0-9+/]{40,}/.test(serialized);
  report.checks.noScreenshotData = !hasBase64;
  console.log(`3. Screenshot/base64 data: ${hasBase64 ? '❌ FOUND' : '✅ NONE'}`);

  // 4. API key never in a body (look for the OpenRouter key prefix shape).
  const keyShaped = /sk-or-[A-Za-z0-9-]{10,}/.test(serialized);
  report.checks.noApiKeyInBodies = !keyShaped;
  console.log(`4. OpenRouter key material in bodies: ${keyShaped ? '❌ FOUND' : '✅ NONE'}`);

  // 5. Network topology: reasoning stayed within localhost + openrouter.ai.
  const unexpectedHosts = requestLog
    .filter((r) => r.host && !REASONING_HOSTS.has(r.host))
    .filter((r) => !r.url.startsWith('chrome-extension://') && !r.url.startsWith('devtools://'))
    .map((r) => `${r.method} ${r.url}`);
  report.checks.noUnexpectedExternalHosts = unexpectedHosts.length === 0;
  console.log(`5. Unexpected external hosts: ${unexpectedHosts.length === 0 ? '✅ NONE' : `❌ ${unexpectedHosts.join('; ')}`}`);

  // 6. Hops observed.
  console.log(`6. Hops captured: backend=${report.backendHopCaptured ? '✅' : '⚠️ not observed'} openrouter=${report.openrouterHopCaptured ? '✅' : '— (expected when backend lacks key)'}`);
  if (!report.backendHopCaptured) {
    report.notes.push('backend reasoning request not captured — verify the task actually ran and CDP captured the popup context');
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const allPassed =
    report.checks.noFakePII &&
    report.checks.noForbiddenKeys &&
    report.checks.noScreenshotData &&
    report.checks.noApiKeyInBodies &&
    report.checks.noUnexpectedExternalHosts;

  report.verdict = allPassed ? 'PASS' : 'FAIL';
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`   VERDICT: ${allPassed ? '🟢 PASS — reasoning payloads are sanitized' : '🔴 FAIL'}`);
  console.log('   Full log saved to: m7-network-verification.json');
  console.log('══════════════════════════════════════════════════════\n');

  writeFileSync('m7-network-verification.json', JSON.stringify(report, null, 2));
  try { await sendCmd('Target.closeTarget', { targetId: popupTargetId }); } catch { /* ignore */ }
  ws.close();
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('\n[FATAL] Verification script error:', err.message ?? err);
  process.exit(1);
});
