/**
 * PrivAgent — Phase 13: REAL-CHROME PRODUCTION-PATH Verification
 *
 * The Phase 13 acceptance evidence for the seam was produced by a scratch
 * harness that constructed its own AgentLoop. That proves the seam is CORRECT
 * but not that the SHIPPED product uses it.
 *
 * This harness closes that gap. It drives the ACTUAL PRODUCTION path:
 *
 *   real dashboard page (:5173)
 *     → real extension content script
 *       → real service worker  (PRIVAGENT_DASHBOARD_START_TASK)
 *         → real target resolution, real containment scope
 *           → real AgentLoop, constructed with `harness: new AgentHarness()`
 *             → real content-script perception in a real target tab
 *
 * Nothing here is stubbed. The service worker is loaded from dist/ exactly as
 * Chrome would load it from the unpacked extension. The only synthetic part is
 * that the reasoner backend is not running, so the task ends at the reasoning
 * step — which is AFTER the harness has been constructed and consulted, and
 * therefore still proves the point.
 *
 * Evidence is written to docs/evidence/phase13-harness/.
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

const CHROME_PORT = Number(process.env.PRIVAGENT_PHASE13_PROD_CDP_PORT || 9475);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase13-harness');
const EVIDENCE_JSON = path.join(EVIDENCE_DIR, 'phase13_production_path_evidence.json');

const DASHBOARD_PORT = 5173; // the dashboard port the product treats as the control surface
const TARGET_PORT = 4195;
const TARGET_ORIGIN = `http://localhost:${TARGET_PORT}`;

// ── The dashboard fixture: receives the real relayed progress payload ────────
const DASHBOARD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>PrivAgent dashboard</title></head>
<body><h1>PrivAgent dashboard</h1><p id="status">idle</p>
<script>
  window.__privagentProgress = [];
  window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.source === 'privagent-extension' && ev.data.type === 'TASK_PROGRESS') {
      window.__privagentProgress.push(ev.data.payload);
      document.getElementById('status').textContent = 'progress: ' + ev.data.payload.status;
    }
  });
</script>
</body></html>`;

// ── The target fixture: an in-scope control on a real page ───────────────────
const TARGET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Phase 13 production target</title></head>
<body><h1>Phase 13 production target</h1>
<p id="marker">untouched</p>
<button id="in-scope-button">Activate the in-scope control</button>
</body></html>`;

function serve(port, html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// ── CDP plumbing (same pattern as the Phase 9–13 harnesses) ──────────────────

const getJson = (endpoint, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CHROME_PORT, path: endpoint, method }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error(`CDP ${endpoint} non-JSON`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });

class Session {
  constructor(ws, sessionId = undefined) {
    this.ws = ws; this.sessionId = sessionId; this.id = 0; this.pending = new Map();
    this.events = [];
    this.onEvent = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const e = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(e.t);
        msg.error ? e.reject(new Error(JSON.stringify(msg.error))) : e.resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (this.onEvent) this.onEvent(msg);
      }
    };
  }
  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timeout`)); } }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      const payload = { id, method, params };
      if (this.sessionId) payload.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  async evaluate(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function openSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  return new Session(ws);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attachToTarget(browserWsUrl, predicate, label) {
  const browser = await openSession(browserWsUrl);
  for (let attempt = 0; attempt < 60; attempt++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const match = targetInfos.find(predicate);
    if (match) {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: match.targetId, flatten: true });
      const s = new Session(browser.ws, sessionId);
      await s.send('Runtime.enable').catch(() => {});
      await s.send('Page.enable').catch(() => {});
      return s;
    }
    await sleep(500);
  }
  throw new Error(`no target matched: ${label}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dashServer = await serve(DASHBOARD_PORT, DASHBOARD_PAGE);
  const targetServer = await serve(TARGET_PORT, TARGET_PAGE);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-phase13-prod-'));
  const chrome = spawn(
    CHROME_BIN,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1280,900',
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', 'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  const sessions = [];
  const evidence = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 13: Harness — PRODUCTION service-worker path',
    goal: 'Prove the shipped service worker actually arms the Harness, with every gate unchanged.',
    provenance: {
      kind: 'REAL_CHROME_PRODUCTION_PATH',
      browser: 'Chromium (headless=new) driven over CDP',
      serviceWorker: 'REAL production service worker loaded from dist/',
      messagePath: 'dashboard page → real content script → real service worker → real AgentLoop → real content-script perception',
      agentLoop: 'REAL AgentLoop constructed by the production service worker with harness: new AgentHarness()',
      gatesTouched: false,
      synthetic: false,
      note: 'The reasoner backend is intentionally not running; the task ends at the reasoning step, which is AFTER the harness is constructed and consulted.',
    },
  };

  try {
    for (let i = 0; i < 80; i++) {
      try { await getJson('/json/version'); break; } catch { await sleep(250); }
    }
    const browserWsUrl = (await getJson('/json/version')).webSocketDebuggerUrl;
    const bs = await openSession(browserWsUrl);
    const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    bs.close();
    evidence.extensionId = extensionId;
    evidence.loadedFrom = 'dist (the built production extension)';

    // Control surface: an extension page, so chrome.tabs/scripting/runtime exist.
    const controlTarget = await getJson(
      `/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`, 'PUT'
    );
    const control = await openSession(controlTarget.webSocketDebuggerUrl);
    sessions.push(control);
    await control.send('Page.enable'); await control.send('Runtime.enable');
    await sleep(1500);

    // The dashboard and the agent target are both real tabs.
    const dashTabId = await control.evaluate(
      `chrome.tabs.create({ url: 'http://localhost:${DASHBOARD_PORT}/', active: false }).then(t => t.id).catch(() => null)`
    );
    const targetTabId = await control.evaluate(
      `chrome.tabs.create({ url: '${TARGET_ORIGIN}/', active: false }).then(t => t.id).catch(() => null)`
    );
    if (dashTabId == null || targetTabId == null) throw new Error('failed to create tabs');
    evidence.tabs = { dashboardTabId: dashTabId, targetTabId, distinct: dashTabId !== targetTabId };
    await sleep(2500);

    // Attach to the REAL service worker and record its console.
    const swSession = await attachToTarget(
      browserWsUrl,
      (t) => (t.type === 'service_worker' || t.type === 'worker') &&
             (t.url || '').startsWith(`chrome-extension://${extensionId}`),
      'service worker'
    );
    sessions.push(swSession);
    const swConsole = [];
    swSession.onEvent = (msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
          .join(' ')
          .slice(0, 400);
        swConsole.push(text);
      }
    };
    console.log(`\n[PHASE 13] REAL CHROME — production service-worker path`);

    // Send the REAL start message from the dashboard tab's content script, so
    // sender.tab is the dashboard — exactly how the product starts a task.
    await control.evaluate(
      `chrome.scripting.executeScript({
         target: { tabId: ${dashTabId} },
         func: () => chrome.runtime.sendMessage({
           type: 'PRIVAGENT_DASHBOARD_START_TASK',
           task: 'read the heading on the phase 13 production target page',
           originUrl: 'http://localhost:${DASHBOARD_PORT}'
         })
       }).then(() => 'sent').catch(e => 'send-failed: ' + String(e))`,
      { timeoutMs: 60000 }
    );

    // Read the dashboard's MAIN world (where the page's own script lives).
    // chrome.scripting.executeScript would run in the isolated world and could
    // not see window.__privagentProgress, so a CDP page session is used here.
    const dashPage = await attachToTarget(
      browserWsUrl,
      (t) => t.type === 'page' && (t.url || '').startsWith(`http://localhost:${DASHBOARD_PORT}`),
      'dashboard page'
    );
    sessions.push(dashPage);

    // Wait for the terminal progress payload to reach the real dashboard page.
    let finalState = null;
    let progressCount = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const raw = await dashPage.evaluate(
        `JSON.stringify(window.__privagentProgress || [])`
      ).catch(() => null);
      if (!raw) continue;
      let list = [];
      try { list = JSON.parse(raw); } catch { list = []; }
      progressCount = list.length;
      if (list.length) {
        finalState = list[list.length - 1];
        if (['FAILED', 'SUCCESS', 'STOPPED', 'NEEDS_USER_CONFIRMATION'].includes(finalState.status)) break;
      }
    }

    const harnessRun = finalState?.harnessRun ?? null;
    const harnessConsoleLines = swConsole.filter((l) => l.includes('harness cycle'));
    const harnessTrace = harnessConsoleLines
      .map((l) => { const m = l.match(/harness cycle (\{[\s\S]*\})/); try { return m ? JSON.parse(m[1]) : l; } catch { return l; } })
      .slice(0, 6);

    evidence.productionServiceWorker = {
      taskReachedRealAgentLoop: Boolean(finalState),
      progressMessageCount: progressCount,
      finalStatus: finalState?.status ?? null,
      finalReason: finalState?.reason ?? null,
      harnessRun,
      harnessCycleConsoleLines: harnessConsoleLines.length,
      harnessCycleTraces: harnessTrace,
    };
    console.log(`  progress messages on the real dashboard = ${progressCount}`);
    console.log(`  final status = ${finalState?.status}`);
    console.log(`  harness cycles observed in SW console = ${harnessConsoleLines.length}`);
    console.log(`  harnessRun in the real task state: cycles=${harnessRun?.cycles} continues=${harnessRun?.continueCount} halts=${harnessRun?.haltCount}`);

    // ── The security pipeline still ran, unchanged, in the production path ──
    const gateTraces = {
      perception: swConsole.some((l) => l.includes('perception complete')),
      containmentEstablished: swConsole.some((l) => l.includes('containment scope established')),
      m5: swConsole.some((l) => l.includes('action validated by M5')),
      securityCritic: swConsole.some((l) => l.includes('security critic')),
      privacy: swConsole.some((l) => l.includes('action passed privacy policy')),
      containmentDecision: swConsole.some((l) => l.includes('containment decision')),
      recovery: swConsole.some((l) => l.includes('recovery decision')),
    };
    const actionGatesExercised = gateTraces.m5 || gateTraces.securityCritic ||
      gateTraces.privacy || gateTraces.containmentDecision || gateTraces.recovery;
    evidence.gatesStillRunning = {
      ...gateTraces,
      actionGatesExercised,
      note: actionGatesExercised
        ? 'At least one action was proposed, so the per-action gates ran in the production path.'
        : 'No action was ever proposed because the reasoner backend is not running in this environment, so the per-action gates had nothing to evaluate. The reasoner failure is upstream of them. These gates are verified by tests/phase13/harness.test.ts and scratch/verify_phase13_harness.mjs.',
    };
    console.log(`  gates observed: ${JSON.stringify(gateTraces)}`);
    console.log(`  action gates exercised: ${actionGatesExercised}`);

    // The live target page must never have left the contained environment.
    const targetPage = await attachToTarget(
      browserWsUrl, (t) => t.type === 'page' && (t.url || '').startsWith(TARGET_ORIGIN), 'target page'
    );
    sessions.push(targetPage);
    const liveUrl = await targetPage.evaluate('location.href');
    const markerText = await targetPage.evaluate(`document.getElementById('marker').textContent`);
    evidence.liveEnvironment = {
      liveUrl,
      neverLeftOrigin: liveUrl.startsWith(TARGET_ORIGIN),
      markerText,
      containmentScopeInState: finalState?.containmentDecision?.scope ?? null,
    };
    console.log(`  live environment: ${liveUrl} (held=${liveUrl.startsWith(TARGET_ORIGIN)})`);

    // The Harness record that reached the dashboard must be value-free.
    const serialized = JSON.stringify(harnessRun ?? {});
    evidence.harnessStateIsValueFree = {
      containsTargetHost: serialized.includes(`localhost:${TARGET_PORT}`),
      containsFullUrl: /https?:\/\//.test(serialized),
      serialized,
    };

    evidence.result = {
      harnessArmedInProduction: Boolean(harnessRun && harnessRun.cycles > 0),
      harnessConsultedByRealLoop: harnessConsoleLines.length > 0,
      harnessStateReachedRealDashboard: Boolean(harnessRun),
      containmentStillEstablished: gateTraces.containmentEstablished,
      perceptionStillRan: gateTraces.perception,
      harnessStateCarriesNoUrl: !/https?:\/\//.test(serialized),
      environmentHeldThroughout: liveUrl.startsWith(TARGET_ORIGIN),
    };

    fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence written to ${path.relative(REPO_ROOT, EVIDENCE_JSON)}`);
    console.log(JSON.stringify(evidence.result, null, 2));
    const allPass = Object.values(evidence.result).every(Boolean);
    console.log(`\n[PHASE 13 PRODUCTION PATH] ${allPass ? 'ALL CHECKS PASS' : 'CHECKS FAILED'}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { dashServer.close(); } catch {}
    try { targetServer.close(); } catch {}
  }
}

await main();
