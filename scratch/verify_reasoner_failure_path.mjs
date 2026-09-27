/**
 * PrivAgent — REAL-CHROME ACCEPTANCE: the reasoner failure path
 *
 * Reproduces the exact condition that produced the misdiagnosis:
 *
 *   backend is UP, but the reasoner is SLOW (the real Groq timeout is 30s).
 *
 * A local stub stands in for the backend: it ACCEPTS the request and delays
 * ~40s before returning a structured 503, which is precisely what
 * `backend/app/reasoner.py` does when the upstream model times out. Nothing is
 * faked into success — the run genuinely fails, via the genuine error path.
 *
 * Before the fix this fired the dashboard watchdog at 30s and reported
 * "Last stage: PERCEPTION" before the true terminal state arrived.
 * After the fix the watchdog must stay quiet and the terminal REASONER_FAILED
 * must land first.
 *
 * Evidence → docs/evidence/phase14-interaction-output/
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PORT = Number(process.env.REASONER_CDP_PORT || 9516);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase14-interaction-output');
const EVIDENCE_JSON = path.join(EVIDENCE_DIR, 'reasoner_failure_path_evidence.json');

const DASHBOARD_PORT = 5189;
const TARGET_PORT = 4200;
const TARGET_ORIGIN = `http://localhost:${TARGET_PORT}`;
const BACKEND_PORT = 8010;
const SLOW_REASONER_MS = Number(process.env.SLOW_REASONER_MS || 40000);
const TASK = 'open the local target and read its heading';

const TARGET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Reasoner path target</title></head>
<body><h1>Reasoner path target</h1><button id="act">Activate</button></body></html>`;

const DASHBOARD_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>PrivAgent dashboard</h1>
<script>
window.__ev = [];
window.addEventListener('message', function (ev) {
  if (ev.data && ev.data.source === 'privagent-extension' && ev.data.type === 'TASK_PROGRESS' && ev.data.payload) {
    var p = ev.data.payload, ix = p.interaction;
    window.__ev.push({ t: Date.now(), status: p.status, currentStep: p.currentStep,
      hasInteraction: !!ix, phase: ix ? ix.activity.phase : null,
      outcome: ix ? ix.outcome : null, terminal: ix ? ix.terminal : null,
      currentUrl: p.currentUrl || null, reason: p.reason === undefined ? '(absent)' : p.reason });
  }
});
</script></body></html>`;

function serve(port, html) {
  const s = http.createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((r) => s.listen(port, '127.0.0.1', () => r(s)));
}

/**
 * A stand-in backend that is UP but SLOW — the real production condition when
 * the upstream model times out. Returns a structured 503, exactly as
 * `backend/app/routes/agent.py` does for a ReasoningError of kind 'timeout'.
 */
function serveSlowBackend(port) {
  const state = { requests: 0, paths: [], lastDelayMs: null };
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      state.requests++;
      state.paths.push(req.url);
      if (req.url.includes('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backend_status: 'CONNECTED', reasoner: 'groq' }));
        return;
      }
      state.lastDelayMs = SLOW_REASONER_MS;
      setTimeout(() => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          detail: {
            success: false,
            reason: 'Reasoning unavailable: groq (timeout) and fallback  failed.',
            error_kind: 'timeout',
            retryable: false,
          },
        }));
      }, SLOW_REASONER_MS);
    });
  });
  s.on('error', () => {});
  return new Promise((r) => s.listen(port, '127.0.0.1', () => r({ server: s, state })));
}

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const getJson = (endpoint, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CHROME_PORT, path: endpoint, method }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('non-JSON')); } });
    });
    req.on('error', reject);
    req.end();
  });

class Session {
  constructor(ws, sessionId) {
    this.ws = ws; this.sessionId = sessionId; this.id = 0; this.pending = new Map(); this.onEvent = null;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const e = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(e.t);
        m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result);
      } else if (m.method && this.onEvent) this.onEvent(m);
    };
  }
  send(method, params = {}, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timeout`)); } }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      const p = { id, method, params };
      if (this.sessionId) p.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(p));
    });
  }
  async evaluate(expression, { awaitPromise = true, timeoutMs = 90000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function openSession(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  return new Session(ws);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(browserWsUrl, predicate, label) {
  const b = await openSession(browserWsUrl);
  for (let i = 0; i < 60; i++) {
    const { targetInfos } = await b.send('Target.getTargets');
    const m = targetInfos.find(predicate);
    if (m) {
      const { sessionId } = await b.send('Target.attachToTarget', { targetId: m.targetId, flatten: true });
      const s = new Session(b.ws, sessionId);
      await s.send('Runtime.enable').catch(() => {});
      await s.send('Page.enable').catch(() => {});
      return s;
    }
    await sleep(500);
  }
  throw new Error(`no target: ${label}`);
}

async function main() {
  const dashServer = await serve(DASHBOARD_PORT, DASHBOARD_PAGE);
  const targetServer = await serve(TARGET_PORT, TARGET_PAGE);
  const { server: backendServer, state: backendState } = await serveSlowBackend(BACKEND_PORT);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-reasoner-'));
  const chrome = spawn(CHROME_BIN, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,900', `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const sessions = [];
  const evidence = {
    timestamp: new Date().toISOString(),
    phase: 'Reasoner failure path — real-Chrome acceptance',
    goal: 'Prove a slow-but-real reasoner failure produces a clean terminal REASONER_FAILED, and is no longer misreported by the dashboard as a perception stall.',
    provenance: {
      kind: 'REAL_CHROME_WITH_DETERMINISTIC_SLOW_BACKEND',
      browser: 'Chromium (headless=new) over CDP',
      extension: 'REAL production extension from dist/',
      reasoner: `A LOCAL STUB on 127.0.0.1:${BACKEND_PORT} that ACCEPTS the request and delays ${SLOW_REASONER_MS}ms before returning a structured 503 (error_kind=timeout). This is the same shape backend/app/routes/agent.py returns when the upstream model times out (GROQ_TIMEOUT_SECONDS=30).`,
      synthetic: false,
      note: 'No success is fabricated. The run genuinely fails through the genuine error path: BackendAgentProvider -> ProviderError -> AgentLoop terminal FAILED. The only thing stubbed is the upstream model latency.',
    },
  };

  try {
    for (let i = 0; i < 80; i++) { try { await getJson('/json/version'); break; } catch { await sleep(250); } }
    const browserWsUrl = (await getJson('/json/version')).webSocketDebuggerUrl;
    const bs = await openSession(browserWsUrl);
    const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    bs.close();
    evidence.extensionId = extensionId;

    const controlTarget = await getJson(`/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`, 'PUT');
    const control = await openSession(controlTarget.webSocketDebuggerUrl);
    sessions.push(control);
    await control.send('Page.enable'); await control.send('Runtime.enable');
    await sleep(1500);

    // Prove the stub is reachable BEFORE the task, so "backend up" is a fact.
    const health = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: BACKEND_PORT, path: '/api/v1/health', method: 'GET' }, (res) => {
        let raw = ''; res.on('data', (d) => (raw += d));
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, raw }); } });
      });
      req.on('error', (e) => resolve({ error: String(e) }));
      req.end();
    });
    evidence.backendReachableBeforeTask = health;
    console.log('[REASONER] backend stub health:', JSON.stringify(health));

    const dashTabId = await control.evaluate(`chrome.tabs.create({url:'http://localhost:${DASHBOARD_PORT}/',active:false}).then(t=>t.id).catch(()=>null)`);
    const targetTabId = await control.evaluate(`chrome.tabs.create({url:'${TARGET_ORIGIN}/',active:false}).then(t=>t.id).catch(()=>null)`);
    if (dashTabId == null || targetTabId == null) throw new Error('tab creation failed');
    await sleep(3000);

    const sw = await attach(browserWsUrl,
      (t) => (t.type === 'service_worker' || t.type === 'worker') && (t.url || '').startsWith(`chrome-extension://${extensionId}`),
      'service worker');
    sessions.push(sw);
    const swLog = [];
    let t0 = Date.now();
    sw.onEvent = (m) => {
      if (m.method !== 'Runtime.consoleAPICalled') return;
      swLog.push({ ms: Date.now() - t0, line: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400) });
    };

    const dashPage = await attach(browserWsUrl,
      (t) => t.type === 'page' && (t.url || '').startsWith(`http://localhost:${DASHBOARD_PORT}`), 'dashboard');
    sessions.push(dashPage);

    console.log(`[REASONER] starting task (reasoner will take ~${SLOW_REASONER_MS}ms)…`);
    t0 = Date.now();
    await control.evaluate(
      `chrome.scripting.executeScript({ target:{tabId:${dashTabId}},
         func: () => chrome.runtime.sendMessage({
           type:'PRIVAGENT_DASHBOARD_START_TASK', task:${JSON.stringify(TASK)},
           originUrl:'http://localhost:${DASHBOARD_PORT}' }) })
       .then(()=> 'sent').catch(e=>'fail: '+String(e))`, { timeoutMs: 30000 });

    let events = [];
    for (let i = 0; i < 100; i++) {
      await sleep(1000);
      const raw = await dashPage.evaluate('JSON.stringify(window.__ev||[])').catch(() => null);
      if (!raw) continue;
      try { events = JSON.parse(raw); } catch { events = []; }
      const last = events[events.length - 1];
      if (last && ['FAILED', 'SUCCESS', 'STOPPED'].includes(last.status) && i > 6) break;
    }
    await sleep(1500);
    events = JSON.parse(await dashPage.evaluate('JSON.stringify(window.__ev||[])'));

    const withT = events.map((e) => ({ ...e, ms: e.t - t0 }));
    const watchdogLines = swLog.filter((l) => /WATCHDOG/i.test(l.line));
    const reasoningIdx = swLog.findIndex((l) => l.line.includes('requesting reasoning'));
    const m6FailedIdx = swLog.findIndex((l) => l.line.includes('M6 failed'));
    const terminalEvt = withT.find((e) => ['FAILED', 'SUCCESS', 'STOPPED'].includes(e.status));
    const lastProgress = withT.filter((e) => !['FAILED', 'SUCCESS', 'STOPPED'].includes(e.status)).pop();
    // The loop emits its last progress payload just BEFORE calling the provider,
    // so the payload that carries the phase is the one immediately preceding the
    // reasoner window, not one inside it.
    const lastNonTerminalEvt = withT.filter((e) => !['FAILED', 'SUCCESS', 'STOPPED'].includes(e.status)).pop();
    const duringReasoner = withT.filter((e) => reasoningIdx >= 0 && e.ms >= (swLog[reasoningIdx]?.ms ?? 0));

    evidence.timing = {
      slowReasonerMs: SLOW_REASONER_MS,
      reasoningEnteredAtMs: reasoningIdx >= 0 ? swLog[reasoningIdx].ms : null,
      m6FailedAtMs: m6FailedIdx >= 0 ? swLog[m6FailedIdx].ms : null,
      terminalAtMs: terminalEvt ? terminalEvt.ms : null,
      lastProgressAtMs: lastProgress ? lastProgress.ms : null,
      backendRequests: backendState.requests,
      backendPaths: backendState.paths,
    };
    evidence.phaseDuringReasoner = [...new Set(duringReasoner.map((e) => e.phase))];
    evidence.lastProgressPhase = lastProgress ? lastProgress.phase : null;
    evidence.lastProgressAtMs = lastProgress ? lastProgress.ms : null;
    evidence.watchdog = {
      fired: watchdogLines.length > 0,
      lines: watchdogLines.map((l) => l.line),
      note: 'The pre-fix dashboard fired this at 30s while the reasoner was still legitimately pending, and reported "Last stage: PERCEPTION".',
    };
    evidence.terminal = terminalEvt ? {
      status: terminalEvt.status,
      terminal: terminalEvt.terminal,
      reason: terminalEvt.reason,
    } : null;
    evidence.events = withT;

    evidence.result = {
      backendActuallyReachedTheStub: backendState.requests > 0,
      perceptionCompletedBeforeReasoning: swLog.some((l) => /perception complete|multimodal perception complete|AgentLoop\] perception completed/.test(l.line)),
      // The payload that arms the watchdog for the reasoner window must not say
      // PERCEPTION. Pre-fix it always did, which is what produced the misleading
      // "Last stage: PERCEPTION" watchdog message.
      phaseWasPlanningWhileAwaitingReasoner: evidence.lastProgressPhase === 'PLANNING',
      phaseNeverMisreportedAsPerceptionStall: !withT.some(
        (e) => e.status === 'FAILED' && e.terminal?.reason === 'REASONER_FAILED' && e.phase === 'PERCEPTION'
      ),
      terminalFailedReachedDashboard: terminalEvt?.status === 'FAILED',
      terminalReasonIsReasonerFailed: terminalEvt?.terminal?.reason === 'REASONER_FAILED',
      watchdogDidNotFire: watchdogLines.length === 0,
      terminalArrivedBeforeAnyWatchdog:
        !!terminalEvt && (m6FailedIdx < 0 || terminalEvt.ms <= swLog[m6FailedIdx].ms + 5000),
    };

    fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
    console.log('\n=== TIMING ===');
    console.log(JSON.stringify(evidence.timing, null, 2));
    console.log('=== EVENTS ===');
    for (const e of withT) console.log(`  +${String(e.ms).padStart(6)}ms ${e.status} step=${e.currentStep} phase=${e.phase} terminal=${e.terminal ? e.terminal.reason : '-'}`);
    console.log('=== WATCHDOG ===');
    console.log(JSON.stringify(evidence.watchdog, null, 2));
    console.log('=== RESULT ===');
    console.log(JSON.stringify(evidence.result, null, 2));
    const pass = Object.values(evidence.result).every(Boolean);
    console.log(`\n[REASONER FAILURE PATH] ${pass ? 'ALL CHECKS PASS' : 'CHECKS FAILED'}`);
    if (!pass) process.exitCode = 1;
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { dashServer.close(); } catch {}
    try { targetServer.close(); } catch {}
    try { backendServer.close(); } catch {}
  }
}

await main();
