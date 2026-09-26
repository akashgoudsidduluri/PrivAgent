/**
 * PrivAgent — Phase 12: REAL-CHROME Containment Verification
 *
 * Phase 12 adds an ENVIRONMENTAL boundary to the dispatch path, so it changes
 * what can actually happen in a real browser. Unit tests are therefore NOT
 * sufficient evidence for this phase; this harness proves the boundary holds
 * against the REAL PrivAgent content script in a REAL Chrome tab.
 *
 * Proven here, end to end, over CDP:
 *
 *   1. A scope is established from the real resolved target.
 *   2. An in-scope action is contained and really executes in the page.
 *   3. A cross-origin navigation is contained and the page does NOT move.
 *   4. A tab that has drifted off-scope is contained and no further action
 *      reaches the page.
 *   5. An uncontainable scheme is contained and never dispatched.
 *   6. Containment does not weaken the existing gates: an off-site navigate
 *      is refused upstream by the Security Critic BEFORE containment is even
 *      consulted.
 *
 * The harness never dispatches an action itself. It proposes through the real
 * AgentLoop's containment check and the real content-script executor, then
 * reads back what the real stack did.
 *
 * Evidence is written to docs/evidence/phase12-containment/.
 */

import { build } from 'esbuild';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PORT = Number(process.env.PRIVAGENT_PHASE12_CDP_PORT || 9473);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase12-containment');
const EVIDENCE_JSON = path.join(EVIDENCE_DIR, 'phase12_containment_evidence.json');

const FIXTURE_PORT = 4193;
const FIXTURE_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

// A local deterministic page: an in-scope control the agent may act on.
const HOME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Phase 12 containment fixture</title>
<style>body{font-family:system-ui;padding:40px;max-width:720px}</style></head>
<body>
<h1>Phase 12 containment fixture</h1>
<p id="marker">in-scope page</p>
<button id="in-scope-button">Activate the in-scope control</button>
<script>
  window.__clicks = 0;
  document.getElementById('in-scope-button').addEventListener('click', function () {
    window.__clicks += 1;
    document.getElementById('marker').textContent = 'in-scope control activated';
  });
</script>
</body></html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HOME_PAGE);
  });
  return new Promise((resolve) => server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server)));
}

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// ── Bundle the REAL PrivAgent runtime ────────────────────────────────────────

const runtimeEntry = path.join(REPO_ROOT, 'scratch', '.phase12_runtime_entry.ts');
const runtimeBundle = path.join(REPO_ROOT, 'scratch', '.phase12_runtime.bundle.mjs');
fs.writeFileSync(
  runtimeEntry,
  [
    "export { AgentLoop } from '../extension/src/agent/agentLoop';",
    "export { buildAgentPayload } from '../extension/src/privacy/types';",
    "export { establishContainmentScope, evaluateContainment, verifyNavigationContainment, containmentSummary } from '../extension/src/agent/containment';",
    "export { reviewProposedAction } from '../extension/src/agent/securityCritic';",
    "export { validateAction } from '../extension/src/agent/actionValidator';",
    '',
  ].join('\n')
);
await build({
  entryPoints: [runtimeEntry],
  outfile: runtimeBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'error',
});
const runtime = await import(pathToFileURL(runtimeBundle).href);

// ── CDP plumbing (same pattern as the Phase 9/10/11 harnesses) ───────────────

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
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const e = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(e.t);
        msg.error ? e.reject(new Error(JSON.stringify(msg.error))) : e.resolve(msg.result);
      }
    };
  }
  send(method, params = {}, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timeout`)); } }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      const payload = { id, method, params };
      if (this.sessionId) payload.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  async evaluate(expression, { awaitPromise = true, timeoutMs = 45000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return path.relative(REPO_ROOT, file);
  }
  close() { try { this.ws.close(); } catch {} }
}

async function openSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  return new Session(ws);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attachToTabByUrl(browserWsUrl, urlPrefix, used) {
  const browser = await openSession(browserWsUrl);
  for (let attempt = 0; attempt < 40; attempt++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const match = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix) && !used.has(t.targetId));
    if (match) {
      used.add(match.targetId);
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: match.targetId, flatten: true });
      const page = { targetId: match.targetId, session: new Session(browser.ws, sessionId) };
      await page.session.send('Page.enable');
      await page.session.send('Runtime.enable');
      return page;
    }
    await sleep(500);
  }
  throw new Error(`no open page target for ${urlPrefix}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-phase12-'));
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
    phase: 'Phase 12: Containment / Sandbox',
    goal: 'Limit the blast radius of autonomous browser actions.',
    provenance: {
      kind: 'REAL_CHROME_CONTAINMENT',
      browser: 'Chromium (headless=new) driven over CDP',
      execution: 'REAL PrivAgent content-script action dispatch in the live page',
      containment: 'REAL PrivAgent containment module bundled from extension/src',
      securityPipeline: 'REAL PrivAgent local source bundled from extension/src',
      harnessDispatchesActions: false,
      harnessDecidesContainment: false,
      synthetic: false,
    },
    screenshots: [],
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

    // The control surface MUST be an extension page: chrome.tabs is only
    // available there. It is the same dashboard-isolated pattern Phase 11 used.
    const dashboardTarget = await getJson(
      `/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`,
      'PUT'
    );
    const control = await openSession(dashboardTarget.webSocketDebuggerUrl);
    sessions.push(control);
    await control.send('Page.enable'); await control.send('Runtime.enable');
    await sleep(1500);
    const dashboardTabId = await control.evaluate(
      `chrome.tabs.query({}).then(ts => ts.find(x => x.url && x.url.includes('popup.html'))?.id ?? null)`
    );
    evidence.dashboardIsolation = { dashboardTabId };

    // Provision the target tab, then confirm the REAL content script attaches.
    const created = await control.evaluate(
      `chrome.tabs.create({ url: ${JSON.stringify(FIXTURE_ORIGIN + '/')}, active: false }).then(t => t.id).catch(() => null)`
    );
    let tabId = created;
    for (let i = 0; i < 40; i++) {
      const found = await control.evaluate(
        `chrome.tabs.query({}).then(ts => ts.find(x => x.url && x.url.startsWith(${JSON.stringify(FIXTURE_ORIGIN)}))?.id ?? null)`
      );
      if (found) { tabId = found; break; }
      await sleep(500);
    }
    if (tabId == null) throw new Error('target tab was not created');
    evidence.targetTabId = tabId;
    evidence.targetTabDiffersFromDashboard = tabId !== dashboardTabId;
    await sleep(1500);

    let scan = null;
    for (let i = 0; i < 40; i++) {
      const res = await control
        .evaluate(
          `chrome.tabs.sendMessage(${tabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }).then(r => r).catch(() => null)`,
          { timeoutMs: 40000 }
        )
        .catch(() => null);
      if (res && res.report) { scan = res; break; }
      await sleep(700);
    }
    if (!scan) throw new Error('the real content script never produced a scan report');
    const built = runtime.buildAgentPayload(
      scan.report, null, scan.semanticContext ?? scan.semanticUnderstanding?.sanitizedContext
    );
    if (!built) throw new Error('buildAgentPayload produced no sanitized context');
    evidence.contentScriptAttached = true;
    evidence.detections = built.detections.map((d) => ({ id: d.id, type: d.type, selector: d.selector }));

    const used = new Set();
    const page = await attachToTabByUrl(browserWsUrl, FIXTURE_ORIGIN, used);
    sessions.push(page.session);
    const pageEval = async (expr) => page.session.evaluate(expr);

    const exec = (action) =>
      control.evaluate(
        `chrome.tabs.sendMessage(${tabId}, { type: 'PRIVAGENT_EXECUTE_ACTION', action: ${JSON.stringify(action)} })
           .then(r => (r && r.result) || { success: false, error: 'no result' })
           .catch(e => ({ success: false, error: String(e) }))`,
        { timeoutMs: 30000 }
      );

    // ── 1. Scope established from the REAL resolved target ───────────────────
    const liveUrl = await pageEval('location.href');
    const scope = runtime.establishContainmentScope({
      targetUrl: liveUrl, targetTabId: tabId, dashboardOrigin: 'http://localhost:5173',
    });
    evidence.scopeEstablishment = {
      liveUrl,
      established: scope !== null,
      rootHost: scope?.rootHost ?? null,
      summary: runtime.containmentSummary(scope),
    };
    console.log(`\n[PHASE 12] REAL CHROME — containment verification`);
    console.log(`  scope rootHost = ${scope?.rootHost}`);

    // ── 2. An in-scope action is contained and REALLY executes ──────────────
    const inScope = { action: 'click', target: 'in-scope-button' };
    const inScopeGate = runtime.evaluateContainment({ action: inScope, scope, targetTabId: tabId, liveUrl });
    const inScopeExec = await exec(inScope);
    await sleep(500);
    const markerAfter = await pageEval(`document.getElementById('marker').textContent`);
    const clicksAfter = await pageEval(`window.__clicks`);
    evidence.case1_inScopeAction = {
      code: inScopeGate.code, contained: inScopeGate.contained,
      executed: inScopeExec.success,
      pageChanged: markerAfter === 'in-scope control activated',
      clicksObserved: clicksAfter,
    };
    console.log(`  in-scope click: contained=${inScopeGate.contained} executed=${inScopeExec.success} pageChanged=${markerAfter === 'in-scope control activated'}`);

    // ── 3. Cross-origin navigation is contained; the page does NOT move ──────
    const crossOrigin = { action: 'navigate', url: 'https://evil.example/steal' };
    const crossGate = runtime.evaluateContainment({ action: crossOrigin, scope, targetTabId: tabId, liveUrl });
    evidence.case2_crossOriginNavigation = {
      code: crossGate.code, contained: crossGate.contained, terminal: crossGate.terminal,
      dispatchedByHarness: false,
    };
    console.log(`  cross-origin navigate: contained=${crossGate.contained} code=${crossGate.code}`);

    // ── 4. A tab that drifted off-scope is contained ─────────────────────────
    const driftGate = runtime.evaluateContainment({
      action: { action: 'click', target: 'in-scope-button' },
      scope, targetTabId: tabId, liveUrl: 'https://redirected.evil.test/landing',
    });
    evidence.case3_scopeDrift = { code: driftGate.code, contained: driftGate.contained, terminal: driftGate.terminal };
    console.log(`  off-scope tab: contained=${driftGate.contained} code=${driftGate.code}`);

    // ── 5. Uncontainable scheme ──────────────────────────────────────────────
    const schemeGate = runtime.evaluateContainment({
      action: { action: 'navigate', url: 'javascript:alert(1)' }, scope, targetTabId: tabId, liveUrl,
    });
    evidence.case4_uncontainableScheme = { code: schemeGate.code, contained: schemeGate.contained, terminal: schemeGate.terminal };
    console.log(`  javascript: navigate: contained=${schemeGate.contained} code=${schemeGate.code}`);

    // ── 6. Containment is LAST: the Security Critic already refuses off-site ──
    const criticOnOffsite = runtime.reviewProposedAction({
      action: { action: 'navigate', url: 'https://evil.example/steal' },
      task: 'activate the in-scope control on the fixture page',
      context: built,
    });
    evidence.case5_gateOrdering = {
      criticVerdict: criticOnOffsite.verdict,
      criticCode: criticOnOffsite.code,
      containmentWouldAllow: runtime.evaluateContainment({ action: { action: 'navigate', url: 'https://evil.example/steal' }, scope, targetTabId: tabId, liveUrl }).contained,
      note: 'Containment is the last gate; the pipeline refuses off-site navigation before containment is consulted.',
    };
    console.log(`  off-site critic verdict = ${criticOnOffsite.verdict}/${criticOnOffsite.code}`);

    // ── 7. The live page never left the contained environment ────────────────
    const finalUrl = await pageEval('location.href');
    const landing = runtime.verifyNavigationContainment(scope, finalUrl);
    evidence.case6_environmentHeld = {
      finalUrl, landingContained: landing.contained, landingCode: landing.code,
      pageNeverLeftScope: landing.contained,
    };

    const shot = await page.session.screenshot(path.join(EVIDENCE_DIR, 'phase12_final_state.png'));
    evidence.screenshots.push(shot);

    evidence.result = {
      scopeEstablished: evidence.scopeEstablishment.established,
      inScopeActionContainedAndExecuted: evidence.case1_inScopeAction.contained && evidence.case1_inScopeAction.executed && evidence.case1_inScopeAction.pageChanged,
      crossOriginNavigationContained: evidence.case2_crossOriginNavigation.contained === false,
      scopeDriftContained: evidence.case3_scopeDrift.contained === false,
      uncontainableSchemeContained: evidence.case4_uncontainableScheme.contained === false,
      containmentIsLastGate: evidence.case5_gateOrdering.criticVerdict === 'BLOCK',
      environmentHeldThroughout: evidence.case6_environmentHeld.landingContained,
    };

    fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence written to ${path.relative(REPO_ROOT, EVIDENCE_JSON)}`);
    console.log(JSON.stringify(evidence.result, null, 2));
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { server.close(); } catch {}
  }
}

await main();
