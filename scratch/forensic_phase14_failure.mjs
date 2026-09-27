/**
 * PrivAgent — FORENSIC: the real-Chrome REASONER_FAILED / WATCHDOG_TIMEOUT run
 *
 * Diagnostic only. This script instruments, it does not fix. It answers:
 *   1. Does perceivePage() actually return?
 *   2. How long does the reasoner call actually take, and how does that
 *      compare with the dashboard watchdog?
 *   3. Is the 55s provider timeout / 55s loop timeout reachable, and is the
 *      30s dashboard watchdog the thing that fires first?
 *   4. Where does `interaction.activity.phase` come from, and what does it read
 *      during the reasoning window?
 *   5. Does a connection-refused backend fail fast or hang?
 *
 * Usage: node scratch/forensic_phase14_failure.mjs
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

const CHROME_PORT = Number(process.env.FORENSIC_CDP_PORT || 9506);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const DASHBOARD_PORT = 5188;
const TARGET_PORT = 4199;
const TARGET_ORIGIN = `http://localhost:${TARGET_PORT}`;
const TASK = 'read the heading on the local forensic target';
const OUT = path.join(REPO_ROOT, 'scratch', 'forensic_phase14_failure.json');

const TARGET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Forensic target</title></head>
<body><h1>Forensic target</h1><p id="marker">untouched</p>
<button id="act">Activate</button></body></html>`;

function serve(port, html) {
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

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
  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timeout`)); } }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      const p = { id, method, params };
      if (this.sessionId) p.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(p));
    });
  }
  async evaluate(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
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
  const dashServer = await serve(DASHBOARD_PORT, `<!doctype html><html><head><meta charset="utf-8"></head>
<body><h1>PrivAgent dashboard</h1><p id="status">idle</p>
<script>
window.__ev = [];
window.addEventListener('message', function (ev) {
  if (ev.data && ev.data.source === 'privagent-extension' && ev.data.type === 'TASK_PROGRESS' && ev.data.payload) {
    var p = ev.data.payload;
    var ix = p.interaction;
    window.__ev.push({
      t: Date.now(),
      status: p.status,
      currentStep: p.currentStep,
      hasInteraction: !!ix,
      phase: ix ? ix.activity.phase : null,
      planningEngineState: p.planningEngineState === undefined ? '(absent)' : p.planningEngineState,
      reason: p.reason === undefined ? '(absent)' : p.reason,
      outcome: ix ? ix.outcome : null,
      terminal: ix ? ix.terminal : null,
      currentUrl: p.currentUrl === undefined ? '(absent)' : p.currentUrl,
      hasSemanticContext: !!p.semanticContext,
      semPageGeneration: p.semanticContext ? p.semanticContext.pageGeneration : null,
      semEntityCount: p.semanticContext && Array.isArray(p.semanticContext.entities) ? p.semanticContext.entities.length : null,
      candidateEntityCount: Array.isArray(p.candidateEntities) ? p.candidateEntities.length : null,
      detectionCount: Array.isArray(p.detections) ? p.detections.length : null,
    });
  }
});
</script></body></html>`);
  const targetServer = await serve(TARGET_PORT, TARGET_PAGE);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-forensic-'));
  const chrome = spawn(CHROME_BIN, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,900', `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const sessions = [];
  const report = { task: TASK, target: TARGET_ORIGIN, events: [], backendProbe: null, timing: {} };

  try {
    for (let i = 0; i < 80; i++) { try { await getJson('/json/version'); break; } catch { await sleep(250); } }
    const browserWsUrl = (await getJson('/json/version')).webSocketDebuggerUrl;
    const bs = await openSession(browserWsUrl);
    const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    bs.close();

    const controlTarget = await getJson(`/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`, 'PUT');
    const control = await openSession(controlTarget.webSocketDebuggerUrl);
    sessions.push(control);
    await control.send('Page.enable'); await control.send('Runtime.enable');
    await sleep(1500);

    // ── PROBE 1: how fast does a connection-refused backend fail, from the
    //    extension's own origin (the same context the provider uses)?
    report.backendProbe = await control.evaluate(`
      (async () => {
        const t0 = Date.now();
        let outcome, message = null;
        try {
          const r = await fetch('http://127.0.0.1:8010/api/v1/agent/action', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ task: 'probe' }), signal: AbortSignal.timeout(20000)
          });
          outcome = 'http_' + r.status;
        } catch (e) {
          outcome = 'threw';
          message = (e && e.message) ? e.message : String(e);
        }
        return { ms: Date.now() - t0, outcome, message };
      })()
    `);
    console.log('\n[FORENSIC] backend probe from extension origin:',
      JSON.stringify(report.backendProbe));

    const dashTabId = await control.evaluate(`chrome.tabs.create({url:'http://localhost:${DASHBOARD_PORT}/',active:false}).then(t=>t.id).catch(()=>null)`);
    const targetTabId = await control.evaluate(`chrome.tabs.create({url:'${TARGET_ORIGIN}/',active:false}).then(t=>t.id).catch(()=>null)`);
    if (dashTabId == null || targetTabId == null) throw new Error('tab creation failed');
    await sleep(3000);

    // Attach to the SW and timestamp EVERY console line.
    const sw = await attach(browserWsUrl,
      (t) => (t.type === 'service_worker' || t.type === 'worker') && (t.url || '').startsWith(`chrome-extension://${extensionId}`),
      'service worker');
    sessions.push(sw);
    const swLog = [];
    let t0 = Date.now();
    sw.onEvent = (m) => {
      if (m.method !== 'Runtime.consoleAPICalled') return;
      const line = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500);
      swLog.push({ ms: Date.now() - t0, line });
    };

    const dashPage = await attach(browserWsUrl,
      (t) => t.type === 'page' && (t.url || '').startsWith(`http://localhost:${DASHBOARD_PORT}`),
      'dashboard');
    sessions.push(dashPage);

    // Attach to the TARGET page to observe the content script directly.
    const targetPage = await attach(browserWsUrl,
      (t) => t.type === 'page' && (t.url || '').startsWith(TARGET_ORIGIN), 'target');
    sessions.push(targetPage);
    const csLog = [];
    targetPage.onEvent = (m) => {
      if (m.method !== 'Runtime.consoleAPICalled') return;
      const line = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400);
      csLog.push({ ms: Date.now() - t0, line });
    };

    console.log('[FORENSIC] starting task…');
    t0 = Date.now();
    await control.evaluate(
      `chrome.scripting.executeScript({ target:{tabId:${dashTabId}},
         func: () => chrome.runtime.sendMessage({
           type:'PRIVAGENT_DASHBOARD_START_TASK', task:${JSON.stringify(TASK)},
           originUrl:'http://localhost:${DASHBOARD_PORT}' }) })
       .then(()=> 'sent').catch(e=>'fail: '+String(e))`,
      { timeoutMs: 30000 }
    );

    // Watch for up to 90s, past the 30s watchdog.
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const raw = await dashPage.evaluate('JSON.stringify(window.__ev||[])').catch(() => null);
      if (!raw) continue;
      let ev = []; try { ev = JSON.parse(raw); } catch { ev = []; }
      const last = ev[ev.length - 1];
      if (last && ['FAILED','SUCCESS','STOPPED','NEEDS_USER_CONFIRMATION'].includes(last.status) && i > 12) break;
    }

    const events = JSON.parse(await dashPage.evaluate('JSON.stringify(window.__ev||[])'));
    const rendered = await targetPage.evaluate('"ok"').catch(() => 'n/a');
    const adapterState = await dashPage.evaluate(`(function(){
      try {
        var w = window;
        return JSON.stringify({
          kvTargetTab: (document.querySelector('#agent-kv-status')||{}).textContent || null,
          urlSpan: (document.getElementById('agent-browser-url')||{}).textContent || null,
          genBadge: (document.getElementById('agent-browser-generation')||{}).textContent || null,
          countBadge: (document.getElementById('agent-element-count')||{}).textContent || null,
          protectedBadge: (document.getElementById('agent-privacy-protected')||{}).textContent || null,
          statusbarStage: (document.getElementById('statusbar-stage')||{}).textContent || null,
          interactionPanel: (document.getElementById('agent-interaction')||{}).innerText || null,
        });
      } catch(e) { return JSON.stringify({error:String(e)}); }
    })()`).catch(() => null);

    // ── Analyse the gap ──────────────────────────────────────────────────
    const withT = events.map((e) => ({ ...e, ms: e.t - t0 }));
    const lastNonTerminal = withT.filter((e) => !['FAILED','SUCCESS','STOPPED'].includes(e.status)).pop();
    const terminal = withT.filter((e) => ['FAILED','SUCCESS','STOPPED'].includes(e.status))[0];

    report.timing = {
      taskStart: 0,
      watchdogWindowMs: 30000,
      lastNonTerminalAtMs: lastNonTerminal ? lastNonTerminal.ms : null,
      terminalAtMs: terminal ? terminal.ms : null,
      gapBetweenLastProgressAndTerminalMs:
        lastNonTerminal && terminal ? terminal.ms - lastNonTerminal.ms : null,
      watchdogFiredBeforeTerminal: !!(lastNonTerminal && terminal && terminal.ms - lastNonTerminal.ms > 30000),
    };

    // Locate the reasoning boundary in the SW log.
    const reasoningIdx = swLog.findIndex((l) => l.line.includes('requesting reasoning'));
    const reasoningDoneIdx = swLog.findIndex((l) => l.line.includes('reasoning response received'));
    const m6FailedIdx = swLog.findIndex((l) => l.line.includes('M6 failed'));
    const perceptionStartIdx = swLog.findIndex((l) => l.line.includes('perception started'));
    const perceptionDoneIdx = swLog.findIndex((l) => l.line.includes('multimodal perception complete') || l.line.includes('perception complete'));
    const terminalEmitIdx = swLog.findIndex((l) => l.line.includes('terminal progress emitted'));

    report.swBoundaries = {
      perceptionStartedAtMs: perceptionStartIdx >= 0 ? swLog[perceptionStartIdx].ms : null,
      multimodalCompleteAtMs: perceptionDoneIdx >= 0 ? swLog[perceptionDoneIdx].ms : null,
      perceptionReturnedEvidence: swLog.filter((l) => /perception|multimodal|world model|minimiz/i.test(l.line)).map((l) => l.line).slice(0, 25),
      reasoningEnteredAtMs: reasoningIdx >= 0 ? swLog[reasoningIdx].ms : null,
      reasoningReturnedAtMs: reasoningDoneIdx >= 0 ? swLog[reasoningDoneIdx].ms : null,
      reasoningWindowMs: reasoningIdx >= 0 && reasoningDoneIdx >= 0 ? swLog[reasoningDoneIdx].ms - swLog[reasoningIdx].ms : null,
      m6FailedAtMs: m6FailedIdx >= 0 ? swLog[m6FailedIdx].ms : null,
      m6FailedLine: m6FailedIdx >= 0 ? swLog[m6FailedIdx].line : null,
      terminalEmittedAtMs: terminalEmitIdx >= 0 ? swLog[terminalEmitIdx].ms : null,
    };

    report.dashboardEvents = withT;
    report.renderedUi = adapterState ? JSON.parse(adapterState) : null;
    report.swConsole = swLog.filter((l) => /AgentTrace|perception|reasoning|M6|output screen|containment|harness|WATCHDOG|error|fail/i.test(l.line)).slice(0, 80);
    report.contentScriptConsole = csLog.map((l) => l.line).slice(0, 40);
    report.phaseEvidence = {
      note: 'planningEngineState is read by phaseFromPlanningState(); if it is absent from the payload the phase falls back to IDLE.',
      observed: [...new Set(withT.map((e) => `${e.phase}|${e.planningEngineState}`))],
    };

    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('\n=== TIMING ===');
    console.log(JSON.stringify(report.timing, null, 2));
    console.log('=== SW BOUNDARIES ===');
    console.log(JSON.stringify(report.swBoundaries, null, 2));
    console.log('=== DASHBOARD EVENTS ===');
    for (const e of withT) console.log(`  +${String(e.ms).padStart(6)}ms  ${e.status} step=${e.currentStep} phase=${e.phase} pes=${e.planningEngineState} ix=${e.hasInteraction} sem=${e.hasSemanticContext}/${e.semEntityCount} det=${e.detectionCount} url=${e.currentUrl}`);
    console.log('=== RENDERED UI ===');
    console.log(JSON.stringify(report.renderedUi, null, 2));
    console.log(`\nWritten to ${path.relative(REPO_ROOT, OUT)}`);
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { dashServer.close(); } catch {}
    try { targetServer.close(); } catch {}
  }
}

await main();
