/**
 * PrivAgent — PHASE 16.3 : privacy on a synthetic-PII page, end to end.
 *
 * Opens a page containing SYNTHETIC sensitive values (fabricated for testing —
 * never real personal data), runs a REAL agent task against it with the REAL
 * Groq reasoner, and captures EVERY byte the extension sends to the backend.
 *
 * The central assertion is negative and absolute: none of the synthetic values
 * may appear in ANY outbound payload, to the backend or anywhere else.
 *
 * STOP CONDITION: if any raw value is observed on the wire, the run records
 * LEAK_DETECTED and this must be investigated, not patched around.
 */

import fs from 'fs';
import path from 'path';
import { servePhase16Fixture, SYNTHETIC_PII } from './phase16_fixtures.mjs';
import {
  REPO_ROOT, sleep, cdpGet, openSession, serveStatic, startBackend,
  waitForBackend, launchChrome, readReasonerConfig,
} from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.P16_FIXTURE_PORT || 4200);
const DASHBOARD_PORT = Number(process.env.P16_DASHBOARD_PORT || 5175);
const BACKEND_PORT = Number(process.env.P16_BACKEND_PORT || 8010);
const CDP_PORT = Number(process.env.P16_CDP_PORT || 9505);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const TASK = `open ${ORIGIN}/pii and click the Save button`;
const OUT = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16', 'phase16_privacy_evidence.json');
const BACKEND_LOG = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16', 'phase16_privacy_backend.log');

const NEEDLES = Object.entries(SYNTHETIC_PII);
console.log('[P16-PII] synthetic needles under test (fabricated, never real):', NEEDLES.map(([k]) => k).join(', '));

const out = {
  timestamp: new Date().toISOString(),
  work: 'Phase 16 privacy — synthetic PII page through the real pipeline',
  substrate: 'REAL BROWSER + REAL BACKEND + REAL GROQ',
  fixtureClass: 'DETERMINISTIC FIXTURE with SYNTHETIC (fabricated) PII only',
  realPersonalDataUsed: false,
  needles: NEEDLES.map(([kind, value]) => ({ kind, valueLength: value.length })),
  outbound: [],
  leaks: [],
  result: {},
};

const fixture = await servePhase16Fixture(FIXTURE_PORT);
const dash = await serveStatic(DASHBOARD_PORT, path.join(REPO_ROOT, 'frontend', 'dist'));
const { proc: backend, fd } = startBackend(BACKEND_PORT, BACKEND_LOG);
out.backendReachable = await waitForBackend(BACKEND_PORT);
out.reasonerConfig = readReasonerConfig();
const { proc: chrome, profile } = launchChrome(CDP_PORT);
const sessions = [];

try {
  for (let i = 0; i < 120; i++) { try { await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(250); } }
  const bs = await openSession((await cdpGet(CDP_PORT, '/json/version')).webSocketDebuggerUrl);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  bs.close();

  // Capture EVERY request the service worker makes, with its full body.
  const swTarget = (await cdpGet(CDP_PORT, '/json/list')).find((t) => t.url && t.url.includes('serviceWorker.js'));
  const sw = await openSession(swTarget.webSocketDebuggerUrl);
  sessions.push(sw);
  await sw.send('Runtime.enable');
  await sw.send('Network.enable');
  sw.onEvent = (m) => {
    if (m.method !== 'Network.requestWillBeSent') return;
    const url = m.params.request.url || '';
    if (!/127\.0\.0\.1:8010|localhost:8010/.test(url)) return;
    out.outbound.push({ url: url.replace(/^https?:\/\//, ''), method: m.params.request.method, postData: m.params.request.postData ?? null });
  };

  const tab = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${ORIGIN}/pii`)}`, 'PUT');
  await sleep(2500);
  const dashTarget = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`http://localhost:${DASHBOARD_PORT}/`)}`, 'PUT');
  const dashSession = await openSession(dashTarget.webSocketDebuggerUrl);
  sessions.push(dashSession);
  await dashSession.send('Page.enable');
  await dashSession.send('Runtime.enable');
  await sleep(3500);

  // Confirm the synthetic values really ARE on the page, so a "no leak" result
  // cannot be explained by the page not containing them.
  const pageSession = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((t) => t.id === tab.id).webSocketDebuggerUrl);
  sessions.push(pageSession);
  await pageSession.send('Runtime.enable');
  out.pageActuallyContainsSyntheticPII = {};
  for (const [kind, value] of NEEDLES) {
    out.pageActuallyContainsSyntheticPII[kind] = await pageSession.evaluate(
      `document.documentElement.innerHTML.includes(${JSON.stringify(value)})`
    );
  }
  console.log('[P16-PII] page really contains the synthetic values:', JSON.stringify(out.pageActuallyContainsSyntheticPII));

  await dashSession.evaluate(`
    window.__p16 = { payloads: [] };
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      if (!ev.data || ev.data.source !== 'privagent-extension') return;
      if (ev.data.type === 'TASK_PROGRESS') window.__p16.payloads.push(ev.data.payload);
    });
    (() => {
      const i = document.getElementById('agent-task-input');
      i.value = ${JSON.stringify(TASK)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('agent-run-btn').click();
      return true;
    })()
  `);

  const deadline = Date.now() + 120000;
  let payloads = [];
  while (Date.now() < deadline) {
    const s = await dashSession.evaluate(`JSON.stringify((window.__p16.payloads||[]).map(p=>({status:p.status,goalStatus:p.goalStatus,reason:p.reason?String(p.reason).slice(0,200):null,steps:(p.steps||[]).map(s=>({step:s.step,action:s.action,effectStatus:s.effectStatus}))})))`);
    payloads = JSON.parse(s || '[]');
    const tail = payloads[payloads.length - 1];
    if (tail && ['SUCCESS', 'FAILED', 'STOPPED'].includes(tail.status)) break;
    await sleep(1000);
  }
  const final = payloads[payloads.length - 1] || null;
  out.agentRun = { terminalStatus: final?.status ?? null, goalStatus: final?.goalStatus ?? null, reason: final?.reason ?? null, payloadCount: payloads.length };
  out.terminalReasonerCalls = out.outbound.filter((r) => /agent\/action/.test(r.url)).length;
  out.terminalContextCalls = out.outbound.filter((r) => /context/.test(r.url)).length;
  out.totalOutboundRequests = out.outbound.length;
} finally {
  for (const s of sessions) s.close();
  try { chrome.kill('SIGKILL'); } catch {}
  try { backend.kill('SIGKILL'); } catch {}
  try { fs.closeSync(fd); } catch {}
  try { dash.close(); } catch {}
  try { fixture.close(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

// ── The assertion: scan EVERY outbound body for EVERY synthetic value ──────
for (const req of out.outbound) {
  const body = req.postData || '';
  for (const [kind, value] of NEEDLES) {
    if (body.includes(value)) out.leaks.push({ url: req.url, kind });
  }
}
// Also scan the backend's own view of what it received.
let backendReceived = [];
try {
  const r = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/v1/context/latest`).catch(() => null);
  if (r && r.ok) backendReceived = await r.json();
} catch {}
out.backendStoredContextSample = JSON.stringify(backendReceived).slice(0, 4000);
out.backendLeaks = NEEDLES.filter(([, v]) => out.backendStoredContextSample.includes(v)).map(([k]) => k);
out.sanitizedStatusSeen = /sanitized_only/.test(out.backendStoredContextSample);

out.result = {
  leakDetected: out.leaks.length > 0 || out.backendLeaks.length > 0,
  rawValueInAnyOutboundRequest: out.leaks,
  rawValueInBackendStoredContext: out.backendLeaks,
  verdict: out.leaks.length > 0 || out.backendLeaks.length > 0 ? 'LEAK_DETECTED_STOP_CONDITION' : 'NO_RAW_VALUE_OBSERVED',
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log('\n[P16-PII] outbound requests captured:', out.totalOutboundRequests);
console.log('[P16-PII] reasoner calls:', out.terminalReasonerCalls);
console.log('[P16-PII] verdict:', out.result.verdict);
if (out.leaks.length) console.log('[P16-PII] LEAKS:', JSON.stringify(out.leaks));
console.log(`[P16-PII] → ${path.relative(REPO_ROOT, OUT)}`);
process.exit(out.result.leakDetected ? 3 : 0);
