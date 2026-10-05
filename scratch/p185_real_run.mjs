/**
 * PHASE 18.5 — REAL CHROME reproduction harness for the LLM_REASONING watchdog.
 *
 * Drives the REAL built extension (dist/) in REAL headless Chrome against the
 * REAL dashboard (5173) and the REAL backend (8010), submits a task through the
 * REAL dashboard UI path, and records the complete timeline so the root cause is
 * derived from observed behaviour rather than assumed.
 *
 * It instruments three independent clocks:
 *   1. every TASK_PROGRESS the dashboard receives (stage + status + timestamp)
 *   2. every console line the DASHBOARD page emits (watchdog messages)
 *   3. every /api/v1/ request the SERVICE WORKER makes (request + response)
 *
 * Env:
 *   ST_TASK       task string
 *   ST_SETTLE_MS  how long to let the run proceed
 *   ST_CDP_PORT   devtools port
 *   ST_OUT        output filename under docs/evidence/post-17-10/audit
 *   ST_START_URL  optional pre-existing fixture tab to adopt
 *   ST_KEEP_TABS  1 = keep pre-existing fixture tabs
 *   ST_PHASE/ST_WORK/ST_LABELS
 *                 override the artifact header. The defaults describe the
 *                 LIVE-BACKEND 18.5 run; a run against the controlled stub is
 *                 NOT that, so it must say so in its own header rather than
 *                 borrowing the live-backend label.
 */
import fs from 'fs';
import path from 'path';

import {
  REPO_ROOT,
  sleep,
  cdpGet,
  openSession,
  launchChrome,
  attachServiceWorker,
  readReasonerConfig,
} from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.ST_FIXTURE_PORT || 4174);
const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const CDP_PORT = Number(process.env.ST_CDP_PORT || 9801);
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const TASK = process.env.ST_TASK || 'open wikipedia and find information about charminar';
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 90000);
const START_URL = process.env.ST_START_URL || '';
const KEEP_TABS = process.env.ST_KEEP_TABS === '1';
const OUT = process.env.ST_OUT || 'p185_real_run.json';

const out = {
  phase: process.env.ST_PHASE || '18.5',
  work: process.env.ST_WORK || 'PHASE 18.5 — LLM_REASONING watchdog timeout: real Chrome reproduction',
  labels: process.env.ST_LABELS || 'PROVEN_REAL_CHROME / PROVEN_REAL_BACKEND',
  inputs: { task: TASK, startUrl: START_URL || null, settleMs: SETTLE_MS },
  environment: {},
  timeline: [],
  network: [],
  dashboardLogs: [],
  swLogs: [],
  analysis: {},
};

const t0 = Date.now();
const at = () => Date.now() - t0;

const chrome = launchChrome(CDP_PORT);
let bs, page, sw;

try {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('chrome CDP never became ready');
  out.environment.chromeVersion = version.Browser || 'unknown';
  out.environment.reasoner = readReasonerConfig();

  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });

  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable').catch(() => {});

  if (START_URL) {
    await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(START_URL)}`, 'PUT');
    await sleep(1200);
  }

  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(3500);

  sw = await attachServiceWorker(CDP_PORT);
  if (!sw) throw new Error('service worker not found');
  await sw.send('Network.enable', {});
  await sw.send('Runtime.enable', {});

  // ── SW network + console capture ─────────────────────────────────────────
  const finished = new Set();
  const swOnMessage = sw.ws.onmessage;
  sw.ws.onmessage = async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Network.requestWillBeSent') {
        const url = m.params.request.url || '';
        if (url.includes('/api/v1/')) {
          out.network.push({
            t: at(), kind: 'request', requestId: m.params.requestId, url,
            method: m.params.request.method,
            postDataBytes: (m.params.request.postData || '').length,
          });
        }
      } else if (m.method === 'Network.responseReceived') {
        const rec = out.network.find((r) => r.requestId === m.params.requestId);
        if (rec) { rec.status = m.params.response.status; rec.tResponse = at(); }
      } else if (m.method === 'Network.loadingFinished' && !finished.has(m.params.requestId)) {
        const rec = out.network.find((r) => r.requestId === m.params.requestId);
        if (rec) {
          finished.add(m.params.requestId);
          rec.tFinished = at();
          rec.roundTripMs = rec.tFinished - rec.t;
          try {
            const body = await sw.send('Network.getResponseBody', { requestId: rec.requestId });
            const parsed = JSON.parse(body.body);
            rec.success = parsed.success;
            rec.action = parsed.action && parsed.action.action;
            rec.telemetry = parsed.telemetry || null;
            if (parsed.detail) rec.detail = JSON.stringify(parsed.detail).slice(0, 300);
          } catch (e) {
            rec.bodyError = String(e).slice(0, 160);
          }
        }
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const parts = [];
        for (const a of m.params.args || []) {
          if (a.value !== undefined) parts.push(typeof a.value === 'string' ? a.value : JSON.stringify(a.value));
          else if (a.objectId) {
            let rendered = a.description ?? a.type;
            try {
              const r = await sw.send('Runtime.callFunctionOn', {
                objectId: a.objectId,
                functionDeclaration: 'function(){ try { return JSON.stringify(this); } catch (e) { return "UNSERIALIZABLE"; } }',
                returnByValue: true,
              });
              if (r?.result?.value) rendered = String(r.result.value).slice(0, 600);
            } catch { /* keep description */ }
            parts.push(rendered);
          } else parts.push(a.description ?? a.type);
        }
        out.swLogs.push({ t: at(), text: parts.join(' ') });
      }
    } catch { /* ignore */ }
    swOnMessage.call(sw.ws, ev);
  };

  // ── Dashboard console + TASK_PROGRESS capture ────────────────────────────
  const pageOnMessage = page.ws.onmessage;
  page.ws.onmessage = async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const parts = [];
        for (const a of m.params.args || []) {
          if (a.value !== undefined) parts.push(typeof a.value === 'string' ? a.value : JSON.stringify(a.value));
          else if (a.objectId) {
            let rendered = a.description ?? a.type;
            try {
              const r = await page.send('Runtime.callFunctionOn', {
                objectId: a.objectId,
                functionDeclaration: 'function(){ try { return JSON.stringify(this); } catch (e) { return "UNSERIALIZABLE"; } }',
                returnByValue: true,
              });
              if (r?.result?.value) rendered = String(r.result.value).slice(0, 600);
            } catch { /* keep description */ }
            parts.push(rendered);
          } else parts.push(a.description ?? a.type);
        }
        const text = parts.join(' ');
        out.dashboardLogs.push({ t: at(), text });
      }
    } catch { /* ignore */ }
    pageOnMessage.call(page.ws, ev);
  };

  // Observe the adapter's own state + every progress message it receives, from
  // INSIDE the page. This is the authoritative record of what the watchdog saw.
  await page.send('Runtime.evaluate', {
    expression: `
      window.__p185 = { progress: [], watchdogFired: false, adapterState: null };
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.source !== 'privagent-extension') return;
        if (d.type === 'TASK_PROGRESS' && d.payload) {
          const p = d.payload;
          window.__p185.progress.push({
            t: performance.now()|0,
            wall: Date.now(),
            status: p.status,
            stage: p.stage ?? null,
            phase: p.interaction && p.interaction.activity ? p.interaction.activity.phase : null,
            outcome: p.interaction ? p.interaction.outcome : null,
            currentStep: p.currentStep,
            currentUrl: p.currentUrl || p.targetUrl || null,
            // PHASE 18.8 / B1 — capture the typed final result card the service
            // worker emitted, so the artifact can prove what the user was shown
            // rather than only what status was reached.
            finalResult: p.interaction && p.interaction.finalResult ? p.interaction.finalResult : null,
          });
        }
      });
      true;
    `,
    returnByValue: true,
  });

  // Submit the task through the REAL dashboard path.
  const submitted = await page.send('Runtime.evaluate', {
    expression: `
      (() => {
        try {
          // The redesigned dashboard (Phase 18) uses #composer-input /
          // #composer-btn-run. These are the REAL user-facing controls.
          const ta = document.getElementById('composer-input');
          const btn = document.getElementById('composer-btn-run');
          if (!ta || !btn) {
            return JSON.stringify({ via: 'controls-missing', taFound: !!ta, btnFound: !!btn });
          }
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, ${JSON.stringify(TASK)});
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          btn.click();
          return JSON.stringify({ via: 'composer', value: ta.value });
        } catch (e) { return JSON.stringify({ error: String(e) }); }
      })()
    `,
    returnByValue: true,
  });
  out.analysis.submission = submitted?.result?.value;

  await sleep(SETTLE_MS);

  const final = await page.send('Runtime.evaluate', {
    expression: `
      (() => {
        try {
          const w = window.__p185 || { progress: [] };
          const txt = document.body ? document.body.innerText.slice(0, 4000) : '';
          return JSON.stringify({ progress: w.progress, bodyText: txt });
        } catch (e) { return JSON.stringify({ error: String(e) }); }
      })()
    `,
    returnByValue: true,
  });

  let parsed = {};
  try { parsed = JSON.parse(final?.result?.value || '{}'); } catch { /* ignore */ }
  out.timeline = parsed.progress || [];
  out.analysis.bodyText = parsed.bodyText || '';

  const watchdogLines = (out.dashboardLogs || []).filter((l) => /WATCHDOG_TIMEOUT|watchdog/i.test(l.text));
  out.analysis.watchdogLines = watchdogLines;
  out.analysis.requestCount = out.network.filter((n) => n.kind === 'request').length;
  out.analysis.gaps = [];
  let prev = null;
  for (const p of out.timeline) {
    if (prev) out.analysis.gaps.push({ fromStage: prev.stage ?? prev.phase, toStage: p.stage ?? p.phase, gapMs: p.wall - prev.wall });
    prev = p;
  }
} catch (err) {
  out.analysis.error = String(err && err.stack ? err.stack : err);
} finally {
  try { if (page) await page.send('Page.close').catch(() => {}); } catch { /* ignore */ }
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { if (chrome.profile) fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

const outDir = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, OUT), JSON.stringify(out, null, 2));

console.log('=== TASK:', TASK);
console.log('=== watchdog lines:', JSON.stringify(out.analysis.watchdogLines || [], null, 2));
console.log('=== progress timeline:');
for (const p of out.timeline) console.log('   ', JSON.stringify(p));
console.log('=== api requests:', JSON.stringify(out.network.filter(n => n.kind === 'request').map(n => ({ t: n.t, status: n.status, ms: n.roundTripMs, action: n.action })), null, 2));
console.log('=== gaps:', JSON.stringify(out.analysis.gaps, null, 2));
console.log('=== body:', (out.analysis.bodyText || '').slice(0, 900));
console.log('=== written', path.join(outDir, OUT));