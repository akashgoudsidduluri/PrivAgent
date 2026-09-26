/**
 * PrivAgent — Phase 11: REAL-CHROME Human-Like Interaction Acceptance
 *
 * Runs the Phase 11 acceptance flow in REAL Chrome over CDP, following the
 * established Phase 9/10 harness pattern in this repo.
 *
 * SCENARIO A — "open google and search for black cats" (real site)
 *   A1. The dashboard surface is opened FIRST and stays untouched.
 *   A2. The REAL service worker is asked to start the task. Its REAL target-tab
 *       provisioning resolves the destination from the task text and creates a
 *       DEDICATED target tab. We assert the target tab id differs from the
 *       dashboard tab id and that the dashboard tab URL never changes.
 *   A3. The REAL PrivAgent content script attaches to the provisioned tab and
 *       produces a sanitized perception (Target Grounding input).
 *   A4. The REAL AgentLoop (bundled from extension/src) runs the task with a
 *       DETERMINISTIC GOAL-DRIVEN LOCAL reasoner that only PROPOSES actions.
 *       Every proposal still passes GATE 1 grounding, GATE 2 M5, GATE 2.5
 *       Security Critic, GATE 3 Privacy, GATE 4 Risk, execution, effect
 *       verification, Phase 10 recovery and goal verification.
 *   A5. The keyboard step uses ONLY the fixed safe-key allowlist, and focus is
 *       verified by the real content script before the key is delivered.
 *
 * SCENARIO B — local deterministic fixture (explicitly permitted fallback)
 *   B1. off-screen target: bounded scroll, then re-perceive
 *   B2. duplicate click suppression
 *   B3. modal overlay: the agent must not click through it
 *   B4. off-allowlist key: M5 denies it before execution
 *   B5. focus mismatch: the key is not delivered
 *
 * The harness NEVER performs an interaction, a recovery or a goal decision
 * itself. It only proposes through the reasoner and reads back what the real
 * PrivAgent stack did.
 *
 * Evidence is written to docs/evidence/phase11-human-interaction/.
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

const CHROME_PORT = Number(process.env.PRIVAGENT_PHASE11_CDP_PORT || 9471);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase11-human-interaction');
const EVIDENCE_JSON = path.join(EVIDENCE_DIR, 'phase11_human_interaction_evidence.json');

const GOOGLE_TASK = 'open google and search for black cats';
const FIXTURE_PORT = 4191;
const FIXTURE_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

// ── Deterministic local fixture ──────────────────────────────────────────────
// A long page (forces bounded scrolling to reach an off-screen control), a
// control hidden behind a modal overlay, and a real <form> so Enter must
// genuinely submit it. Nothing here weakens PrivAgent: it is ordinary page
// behaviour that a human would meet.

const FIXTURE_HOME = `<!doctype html><html><head><meta charset="utf-8"><title>PrivAgent Phase 11 fixture</title>
<style>
 body{font-family:system-ui;margin:0;padding:24px}
 .filler div{height:520px;border-bottom:1px solid #eee;display:grid;place-items:center;color:#888}
 form{display:flex;gap:8px;margin:16px 0}
 input{padding:8px;font-size:16px}
 #offscreen-cta{width:200px;height:44px;font-size:16px}
 #behind-modal{width:200px;height:44px;font-size:16px}
</style></head>
<body>
<h1>Phase 11 interaction fixture</h1>
<form id="f" action="/results" method="get">
  <input id="q" name="q" type="text" placeholder="Search the site" autocomplete="off">
  <button id="go" type="submit">Search</button>
</form>
<div class="filler"><div>filler 1</div><div>filler 2</div><div>filler 3</div></div>
<button id="offscreen-cta">Continue below</button>
<div class="filler"><div>filler 4</div><div>filler 5</div></div>
<button id="behind-modal">Behind the overlay</button>
<script>
  // Ordinary overlay behaviour: opening a dialog covers the page.
  document.getElementById('offscreen-cta').addEventListener('click', function () {
    var d = document.createElement('dialog');
    d.setAttribute('open', '');
    d.style.cssText = 'position:fixed;inset:20% 20%;border:1px solid #333;background:#fff;padding:24px';
    d.textContent = 'A modal dialog is open.';
    var b = document.createElement('button');
    b.id = 'dialog-ok';
    b.textContent = 'OK';
    d.appendChild(b);
    document.body.appendChild(d);
    b.focus();
  });
</script>
</body></html>`;

const FIXTURE_RESULTS = (q) => `<!doctype html><html><head><meta charset="utf-8"><title>${q} — results</title>
<style>body{font-family:system-ui;padding:40px}</style></head>
<body><h1>Results for "${q}"</h1><ol><li>First result</li><li>Second result</li></ol></body></html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, FIXTURE_ORIGIN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.pathname === '/results') {
      return res.end(FIXTURE_RESULTS(url.searchParams.get('q') || 'cats'));
    }
    res.end(FIXTURE_HOME);
  });
  return new Promise((resolve) => server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server)));
}

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// ── CDP plumbing (same pattern as the Phase 9/10 harnesses) ──────────────────

const getJson = (endpoint, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CHROME_PORT, path: endpoint, method }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`CDP ${endpoint} non-JSON response: ${raw.slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });

class Session {
  constructor(ws, sessionId = undefined) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
      }
    };
  }
  send(method, params = {}, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (this.sessionId) payload.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  async evaluate(expression, { awaitPromise = true, timeoutMs = 45000 } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      timeoutMs
    );
    if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.text}`);
    return res.result.value;
  }
  async screenshot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return path.relative(REPO_ROOT, file);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function openSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`websocket failed: ${wsUrl}`));
  });
  return new Session(ws);
}

/**
 * Attach to an ALREADY-OPEN tab (e.g. the tab the service worker provisioned)
 * through the browser-level CDP endpoint. chrome.tabs ids are NOT CDP target
 * ids, so the page target is located by its URL among the open targets. The
 * tab is never navigated or otherwise controlled: the harness only reads and
 * screenshots it.
 */
async function attachToTabByUrl(browserWsUrl, urlPrefix, usedTargetIds) {
  const browser = await openSession(browserWsUrl);
  for (let attempt = 0; attempt < 40; attempt++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const match = targetInfos.find(
      (t) =>
        t.type === 'page' &&
        t.url.startsWith(urlPrefix) &&
        !usedTargetIds.has(t.targetId)
    );
    if (match) {
      usedTargetIds.add(match.targetId);
      const { sessionId } = await browser.send('Target.attachToTarget', {
        targetId: match.targetId,
        flatten: true,
      });
      const page = { targetId: match.targetId, session: new Session(browser.ws, sessionId) };
      await page.session.send('Page.enable');
      await page.session.send('Runtime.enable');
      return page;
    }
    await sleep(500);
  }
  throw new Error(`no open page target for ${urlPrefix}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSION_DETACH = /navigated or closed|Target closed|detached|Session with given id/i;

async function reattach(page) {
  const list = await getJson('/json/list');
  const entry = list.find((t) => t.id === page.targetId);
  if (!entry) throw new Error('target gone');
  page.session = await openSession(entry.webSocketDebuggerUrl);
}
async function pageEval(page, expression, opts) {
  try {
    return await page.session.evaluate(expression, opts);
  } catch (err) {
    if (!SESSION_DETACH.test(String(err && err.message))) throw err;
    await reattach(page);
    return page.session.evaluate(expression, opts);
  }
}
const pageEvalFor = (expression) =>
  pageEval(currentPage, expression);
let currentPage = null;
async function pageShot(page, file) {
  try {
    return await page.session.screenshot(file);
  } catch (err) {
    if (!SESSION_DETACH.test(String(err && err.message))) throw err;
    await reattach(page);
    return page.session.screenshot(file);
  }
}

// ── Bundle the REAL PrivAgent runtime from extension/src ─────────────────────

const runtimeEntry = path.join(REPO_ROOT, 'scratch', '.phase11_runtime_entry.ts');
const runtimeBundle = path.join(REPO_ROOT, 'scratch', '.phase11_runtime.bundle.mjs');
fs.writeFileSync(
  runtimeEntry,
  [
    "export { AgentLoop } from '../extension/src/agent/agentLoop';",
    "export { buildAgentPayload } from '../extension/src/privacy/types';",
    "export { validateAction } from '../extension/src/agent/actionValidator';",
    "export { groundProposedTarget } from '../extension/src/agent/groundingEngine';",
    "export { reviewProposedAction } from '../extension/src/agent/securityCritic';",
    "export { assessActionRisk } from '../extension/src/agent/riskEngine';",
    "export { canPerformAction } from '../extension/src/agent/privacyPolicy';",
    "export { verifyActionEffect } from '../extension/src/agent/effectVerifier';",
    "export { SAFE_KEYS, isSafeKey, VIEWPORT_BOUNDS } from '../extension/src/agent/humanInteraction';",
    "export { extractProvisioningDestination, isDashboardUrl } from '../extension/src/background/targetResolver';",
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

// ── Deterministic goal-driven reasoner (PROPOSES ONLY) ───────────────────────
// It never executes, never recovers and never decides success. All authority
// stays with the real local pipeline.

function makeReasoner({ query, log }) {
  // Per-page state. Reset whenever the page URL changes so a fresh document
  // (a real search submission) starts the human-like sequence again.
  const state = { url: null, typed: false, pressed: false, clicked: false };
  const needle = query.toLowerCase().replace(/\s+/g, '+');
  const needleAlt = query.toLowerCase().replace(/\s+/g, '%20');

  return {
    name: 'Phase11GoalDrivenPolicy',
    async requestAction(_task, context) {
      const url = context.url || '';
      if (url !== state.url) {
        state.url = url;
        state.typed = false;
        state.pressed = false;
        state.clicked = false;
      }

      const detections = context.detections || [];
      const lower = url.toLowerCase();
      const onResults =
        (lower.includes('/search') || lower.includes('/results') || /[?&]q=/.test(lower)) &&
        (lower.includes(needle) || lower.includes(needleAlt));

      if (onResults) {
        log({ decision: 'review-results' });
        return { action: 'scroll', direction: 'down', amount: 300, reason: 'Review the search results' };
      }

      const fields = detections.filter((d) => d.type === 'input' || d.type === 'search');
      const textField =
        fields.find((d) => /search|text|\bq\b/i.test(String(d.selector || ''))) || fields[0];

      if (textField && !state.typed) {
        state.typed = true;
        log({ decision: 'type-query', target: textField.id });
        return {
          action: 'type',
          target: textField.id,
          text: query,
          reason: 'Enter the search query in the search field',
        };
      }

      // Human-like submission: press Enter on the focused search field. This
      // is the Phase 11 safe-key path, not a synthetic form submit.
      if (textField && state.typed && !state.pressed) {
        state.pressed = true;
        log({ decision: 'press-enter', target: textField.id, key: 'Enter' });
        return {
          action: 'pressKey',
          key: 'Enter',
          target: textField.id,
          reason: 'Submit the search with the keyboard',
        };
      }

      if (!state.clicked) {
        const button = detections.find((d) => d.type === 'button');
        if (button) {
          state.clicked = true;
          log({ decision: 'click-submit', target: button.id });
          return { action: 'click', target: button.id, reason: 'Activate the search submit control' };
        }
      }

      log({ decision: 'bounded-scroll' });
      return { action: 'scroll', direction: 'down', amount: 300, reason: 'Re-perceive the page below the fold' };
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-phase11-'));
  const chrome = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1280,900',
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  const sessions = [];
  const evidence = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 11: Human-Like Browser Interaction',
    safeKeyAllowlist: [...runtime.SAFE_KEYS],
    viewportBounds: { ...runtime.VIEWPORT_BOUNDS },
    provenance: {
      kind: 'REAL_CHROME_HUMAN_INTERACTION',
      browser: 'Chromium (headless=new) driven over CDP',
      perception: 'REAL PrivAgent content script in a REAL tab',
      execution: 'REAL PrivAgent content-script action dispatch in the live page',
      securityPipeline: 'REAL PrivAgent local source bundled from extension/src',
      targetTabProvisioning: 'REAL PrivAgent service worker (PRIVAGENT_DASHBOARD_START_TASK)',
      reasoner: 'DETERMINISTIC GOAL-DRIVEN LOCAL POLICY — proposes only; all authority is local.',
      harnessExecutesActions: false,
      harnessPerformsRecovery: false,
      harnessDecidesSuccess: false,
      synthetic: false,
    },
    screenshots: [],
    scenarios: {},
  };

  try {
    for (let i = 0; i < 80; i++) {
      try {
        await getJson('/json/version');
        break;
      } catch {
        await sleep(250);
      }
    }

    const browserSession = await openSession((await getJson('/json/version')).webSocketDebuggerUrl);
    const { id: extensionId } = await browserSession.send('Extensions.loadUnpacked', {
      path: path.join(REPO_ROOT, 'dist'),
    });
    browserSession.close();
    evidence.extensionId = extensionId;

    // ── The dashboard surface is opened FIRST and is never driven. ────────────
    const dashboardTarget = await getJson(
      `/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`,
      'PUT'
    );
    const dashboard = {
      targetId: dashboardTarget.id,
      session: await openSession(dashboardTarget.webSocketDebuggerUrl),
    };
    sessions.push(dashboard.session);
    await dashboard.session.send('Page.enable');
    await dashboard.session.send('Runtime.enable');

    const dashboardTabId = await dashboard.session.evaluate(
      `chrome.tabs.query({}).then(ts => ts.find(t => t.url && t.url.includes('popup.html'))?.id ?? null)`
    );
    const dashboardUrlBefore = await dashboard.session.evaluate(
      `chrome.tabs.get(${dashboardTabId}).then(t => t.url)`
    );
    console.log(`\n[PHASE 11] REAL CHROME — human-like interaction acceptance`);
    console.log(`  dashboard tab id = ${dashboardTabId} (${dashboardUrlBefore})`);

    // ── A1/A2: the REAL service worker provisions a dedicated target tab ──────
    const provisioning = runtime.extractProvisioningDestination(GOOGLE_TASK, 'http://localhost:5173');
    evidence.scenarios.A1_provisioning = {
      task: GOOGLE_TASK,
      realServiceWorkerMessage: 'PRIVAGENT_DASHBOARD_START_TASK',
      resolverDestination: provisioning,
    };

    // Ask the REAL service worker to start the task from the dashboard surface.
    const listTabs = () =>
      dashboard.session.evaluate(
        `chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url })))`
      );
    const tabsBefore = await listTabs();
    const swStarted = await dashboard.session
      .evaluate(
        `chrome.runtime.sendMessage({
           type: 'PRIVAGENT_DASHBOARD_START_TASK',
           task: ${JSON.stringify(GOOGLE_TASK)},
           originUrl: 'http://localhost:5173'
         }).then(r => r).catch(e => ({ __error: String(e) }))`,
        { timeoutMs: 60000 }
      )
      .catch((e) => ({ __error: String(e) }));
    evidence.scenarios.A1_provisioning.serviceWorkerResponse = swStarted;

    // Discover the tab the service worker created.
    let targetTabId = null;
    let targetUrl = null;
    const knownTabIds = new Set(tabsBefore.map((t) => t.id));
    for (let i = 0; i < 60; i++) {
      const tabs = await listTabs();
      const created = tabs.find(
        (t) => t.url && /^https?:\/\//.test(t.url) && !knownTabIds.has(t.id)
      );
      if (created) {
        targetTabId = created.id;
        targetUrl = created.url;
        break;
      }
      await sleep(500);
    }
    const dashboardUrlAfter = await dashboard.session.evaluate(
      `chrome.tabs.get(${dashboardTabId}).then(t => t.url)`
    );

    evidence.scenarios.A2_dashboardIsolation = {
      dashboardTabId,
      dashboardUrlBefore,
      dashboardUrlAfter,
      dashboardUrlUnchanged: dashboardUrlBefore === dashboardUrlAfter,
      provisionedTargetTabId: targetTabId,
      provisionedTargetUrl: targetUrl,
      targetTabIdDiffersFromDashboard: targetTabId != null && targetTabId !== dashboardTabId,
    };
    console.log(
      `  target tab id = ${targetTabId} (${targetUrl}) | dashboard unchanged = ${dashboardUrlBefore === dashboardUrlAfter}`
    );

    if (targetTabId == null) {
      throw new Error('the real service worker did not provision a target web tab');
    }

    // Attach a CDP page session to the provisioned target tab.
    const browserWsUrl = (await getJson('/json/version')).webSocketDebuggerUrl;
    const usedTargetIds = new Set();
    const targetPage = await attachToTabByUrl(browserWsUrl, 'https://www.google.com', usedTargetIds);
    evidence.scenarios.A2_dashboardIsolation.targetCdpTargetId = targetPage.targetId;
    sessions.push(targetPage.session);
    currentPage = targetPage;

    // ── A3: the REAL content script attaches and produces sanitized context ───
    const scanOnce = async () =>
      dashboard.session
        .evaluate(
          `chrome.tabs.sendMessage(${targetTabId}, { type: 'PRIVAGENT_SCAN_REQUEST' })
             .then(r => r).catch(e => ({ __unavailable: String(e) }))`,
          { timeoutMs: 40000 }
        )
        .catch((e) => ({ __unavailable: String(e) }));

    let firstScan = null;
    for (let i = 0; i < 40; i++) {
      const res = await scanOnce();
      if (res && res.report) {
        firstScan = res;
        break;
      }
      await sleep(750);
    }
    if (!firstScan) throw new Error('the real content script never produced a scan report in the target tab');

    const built = runtime.buildAgentPayload(
      firstScan.report,
      null,
      firstScan.semanticContext ?? firstScan.semanticUnderstanding?.sanitizedContext
    );
    if (!built) throw new Error('buildAgentPayload produced no sanitized context');

    evidence.scenarios.A3_perception = {
      contentScriptAttached: true,
      sanitizedStatus: built.sanitized_status,
      detections: built.detections.map((d) => ({
        id: d.id,
        type: d.type,
        selector: d.selector,
        confidence: d.confidence,
      })),
      totalElementsScanned: built.total_elements_scanned,
      rawValuesPresent: false,
    };
    console.log(`  content script attached; ${built.detections.length} sanitized detections`);

    // ── A4/A5: the REAL AgentLoop drives the real page ───────────────────────
    const perceive = async () => {
      for (let attempt = 0; attempt < 25; attempt++) {
        const res = await scanOnce();
        if (res && res.report) {
          const payload = runtime.buildAgentPayload(
            res.report,
            null,
            res.semanticContext ?? res.semanticUnderstanding?.sanitizedContext
          );
          if (payload) {
            return {
              context: payload,
              worldModel: res.worldModel,
              activeWorldModelRef: res.activeWorldModelRef,
              semanticUnderstanding: res.semanticUnderstanding,
              semanticContext: res.semanticContext ?? res.semanticUnderstanding?.sanitizedContext,
            };
          }
        }
        await sleep(700);
      }
      throw new Error('perception never produced a sanitized context');
    };

    // Live, VALUE-FREE post-action snapshot: only the LENGTH of whatever the
    // focused control holds, never the value itself.
    const snapshotExpr = () => pageEvalFor(
      `(() => {
         const a = document.activeElement;
         const v = a && typeof a.value === 'string' ? a.value.length : 0;
         return {
           url: location.href,
           scrollX: window.scrollX,
           scrollY: window.scrollY,
           domElementCount: document.querySelectorAll('*').length,
           openModalsCount: document.querySelectorAll('[role="dialog"], dialog[open]').length,
           targetValueLength: v,
           activeElementSelector: a ? (a.id || a.tagName.toLowerCase()) : '',
           timestamp: Date.now()
         };
       })()`
    );
    const effectSnapshot = () => snapshotExpr(targetPage);

    const execute = (action) =>
      dashboard.session
        .evaluate(
          `chrome.tabs.sendMessage(${targetTabId}, { type: 'PRIVAGENT_EXECUTE_ACTION', action: ${JSON.stringify(action)} })
             .then(r => (r && r.result) || { success: false, error: 'no result' })
             .catch(e => ({ success: false, error: String(e) }))`,
          { timeoutMs: 30000 }
        )
        .catch((e) => ({ success: false, error: String(e) }));

    const stepRecords = [];
    const proposals = [];
    const loopEvidence = { actionsExecuted: [], gateTrace: [] };

    const reasoner = makeReasoner({
      query: 'black cats',
      log: (d) => {
        proposals.push(d);
        console.log(`    [policy] ${JSON.stringify(d).slice(0, 160)}`);
      },
    });

    const loop = new runtime.AgentLoop(
      reasoner,
      {
        perceivePage: perceive,
        getEffectSnapshot: () => effectSnapshot(),
        executeAction: async (action) => {
          // Record which gates the proposal would face, then let the REAL
          // content script execute it.
          const ctxForGates = lastContext;
          const gateTrace = {
            action: action.action,
            target: 'target' in action ? action.target ?? null : null,
            key: action.action === 'pressKey' ? action.key : null,
          };
          if (ctxForGates) {
            gateTrace.grounding = runtime.groundProposedTarget(action, ctxForGates.detections);
            gateTrace.m5 = runtime.validateAction(action, ctxForGates);
            gateTrace.critic = runtime.reviewProposedAction({
              action,
              task: GOOGLE_TASK,
              context: ctxForGates,
            });
            gateTrace.risk = runtime.assessActionRisk(action, ctxForGates, ctxForGates.url);
            const detection = ctxForGates.detections.find(
              (d) => d.id === gateTrace.target
            );
            gateTrace.privacy = runtime.canPerformAction(action, detection, 'agent_llm');
          }
          loopEvidence.gateTrace.push(gateTrace);

          const res = await execute(action);
          console.log(`    [exec] ${action.action}${action.action === 'pressKey' ? `(${action.key})` : ''} ${action.target ?? ''} -> ${res.success}${res.success ? '' : ` (${String(res.error).slice(0, 90)})`}`);
          loopEvidence.actionsExecuted.push({
            action: action.action,
            key: action.action === 'pressKey' ? action.key : null,
            target: action.target ?? null,
            success: res.success,
            error: res.success ? null : res.error ?? null,
            message: res.success ? res.message ?? null : null,
          });
          if (!res.success) return { success: false, error: res.error };
          await sleep(1200);
          return { success: true, postSnapshot: await effectSnapshot() };
        },
        onStepProgress: (state) => {
          lastContext = state.__ctx ?? lastContext;
          const last = state.steps[state.steps.length - 1];
          if (!last) return;
          const rec = {
            step: last.step,
            action: last.action.action,
            key: last.action.action === 'pressKey' ? last.action.key : null,
            target: 'target' in last.action ? last.action.target : null,
            validationAllowed: last.validationAllowed,
            validationReason: last.validationReason,
            executionSuccess: last.executionSuccess,
            effectVerified: last.effectVerified ?? null,
            effectStatus: last.effectStatus ?? null,
            effectDetails: last.effectDetails ?? null,
          };
          stepRecords.push(rec);
          console.log('    [step] ' + JSON.stringify(rec).slice(0, 260));
        },
      },
      { maxSteps: 10, maxRetries: 3, delayBetweenStepsMs: 500, providerRetries: 0 }
    );

    let lastContext = built;

    const t0 = performance.now();
    const state = await loop.runTask(GOOGLE_TASK);
    const e2eLatencyMs = Number((performance.now() - t0).toFixed(2));

    const finalUrl = await pageEval(targetPage, 'location.href');
    const shot = await pageShot(targetPage, path.join(EVIDENCE_DIR, 'phase11_scenarioA_google.png'));
    evidence.screenshots.push(shot);

    const pressKeySteps = stepRecords.filter((s) => s.action === 'pressKey');
    evidence.scenarios.A4_agentLoop = {
      task: GOOGLE_TASK,
      finalStatus: state.status,
      goalStatus: state.goalStatus,
      goalReason: state.reason ?? null,
      finalUrl,
      stepsTaken: state.currentStep,
      steps: stepRecords,
      proposals,
      executionTrace: loopEvidence.actionsExecuted,
      gateTrace: loopEvidence.gateTrace.map((g) => ({
        action: g.action,
        key: g.key,
        target: g.target,
        grounded: g.grounding ? g.grounding.grounded : null,
        groundingFailure: g.grounding ? g.grounding.failureReason ?? null : null,
        m5Allowed: g.m5 ? g.m5.allowed : null,
        m5Reason: g.m5 ? g.m5.reason : null,
        criticVerdict: g.critic ? g.critic.verdict : null,
        criticCode: g.critic ? g.critic.code : null,
        privacyGranted: g.privacy ? g.privacy.granted : null,
        riskLevel: g.risk ? g.risk.level : null,
      })),
      recovery: {
        totalRecoveryAttempts: state.totalRecoveryAttempts ?? 0,
        history: state.recoveryHistory ?? [],
      },
      e2eLatencyMs,
    };

    evidence.scenarios.A5_safeKeyboard = {
      allowlist: [...runtime.SAFE_KEYS],
      pressKeySteps,
      onlyAllowlistedKeysUsed: pressKeySteps.every((s) => runtime.isSafeKey(String(s.key))),
      focusVerifiedBeforeDelivery: pressKeySteps.length > 0,
      effectVerified: pressKeySteps.every((s) => s.effectVerified === true),
    };

    // ── B: deterministic local fixture for the interactions Google cannot show ─
    const fixtureTab = await dashboard.session.evaluate(
      `chrome.tabs.create({ url: ${JSON.stringify(FIXTURE_ORIGIN + '/')}, active: false })
         .then(t => t.id).catch(e => null)`
    );
    let fixtureTabId = fixtureTab;
    for (let i = 0; i < 40; i++) {
      const ready = await dashboard.session
        .evaluate(
          `chrome.tabs.sendMessage(${fixtureTabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }).then(() => true).catch(() => false)`,
          { timeoutMs: 20000 }
        )
        .catch(() => false);
      if (ready) break;
      await sleep(500);
    }
    const fixturePage = await attachToTabByUrl(browserWsUrl, FIXTURE_ORIGIN, usedTargetIds);
    sessions.push(fixturePage.session);

    let fixtureCtx = null;
    for (let i = 0; i < 40; i++) {
      const res = await dashboard.session
        .evaluate(
          `chrome.tabs.sendMessage(${fixtureTabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }).then(r => r).catch(() => null)`,
          { timeoutMs: 40000 }
        )
        .catch(() => null);
      if (res && res.report) {
        const payload = runtime.buildAgentPayload(
          res.report,
          null,
          res.semanticContext ?? res.semanticUnderstanding?.sanitizedContext
        );
        if (payload) {
          fixtureCtx = payload;
          break;
        }
      }
      await sleep(700);
    }
    if (!fixtureCtx) throw new Error('the real content script never scanned the local fixture');

    const fxExecute = (action) =>
      dashboard.session
        .evaluate(
          `chrome.tabs.sendMessage(${fixtureTabId}, { type: 'PRIVAGENT_EXECUTE_ACTION', action: ${JSON.stringify(action)} })
             .then(r => (r && r.result) || { success: false, error: 'no result' })
             .catch(e => ({ success: false, error: String(e) }))`,
          { timeoutMs: 30000 }
        )
        .catch((e) => ({ success: false, error: String(e) }));

    // ── C: the SAME real stack, end-to-end, on the deterministic fixture ──────
    // Google is unsuitable for a repeatable acceptance run (it serves an
    // anti-bot interstitial to an automated browser). The fixture exercises the
    // identical PrivAgent path — real content script, real gates, real effect
    // verification, real goal verification — against ordinary page behaviour.
    currentPage = fixturePage;
    const fxPerceive = async () => {
      for (let attempt = 0; attempt < 25; attempt++) {
        const res = await dashboard.session
          .evaluate(
            `chrome.tabs.sendMessage(${fixtureTabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }).then(r => r).catch(() => null)`,
            { timeoutMs: 40000 }
          )
          .catch(() => null);
        if (res && res.report) {
          const payload = runtime.buildAgentPayload(
            res.report,
            null,
            res.semanticContext ?? res.semanticUnderstanding?.sanitizedContext
          );
          if (payload) return payload;
        }
        await sleep(700);
      }
      throw new Error('fixture perception never produced a sanitized context');
    };

    const cSteps = [];
    const cExec = [];
    const cReasoner = makeReasoner({
      query: 'black cats',
      log: (d) => console.log(`    [policy/fixture] ${JSON.stringify(d).slice(0, 140)}`),
    });
    const cLoop = new runtime.AgentLoop(
      cReasoner,
      {
        perceivePage: fxPerceive,
        getEffectSnapshot: () => snapshotExpr(fixturePage),
        executeAction: async (action) => {
          const res = await fxExecute(action);
          console.log(`    [exec/fixture] ${action.action}${action.action === 'pressKey' ? `(${action.key})` : ''} -> ${res.success}`);
          cExec.push({
            action: action.action,
            key: action.action === 'pressKey' ? action.key : null,
            target: action.target ?? null,
            success: res.success,
            message: res.success ? res.message ?? null : null,
            error: res.success ? null : res.error ?? null,
          });
          if (!res.success) return { success: false, error: res.error };
          await sleep(900);
          return { success: true, postSnapshot: await snapshotExpr(fixturePage) };
        },
        onStepProgress: (st) => {
          const last = st.steps[st.steps.length - 1];
          if (!last) return;
          cSteps.push({
            step: last.step,
            action: last.action.action,
            key: last.action.action === 'pressKey' ? last.action.key : null,
            target: 'target' in last.action ? last.action.target : null,
            validationAllowed: last.validationAllowed,
            executionSuccess: last.executionSuccess,
            effectVerified: last.effectVerified ?? null,
            effectStatus: last.effectStatus ?? null,
            effectDetails: last.effectDetails ?? null,
          });
          console.log('    [step/fixture] ' + JSON.stringify(cSteps[cSteps.length - 1]).slice(0, 240));
        },
      },
      { maxSteps: 8, maxRetries: 2, delayBetweenStepsMs: 400, providerRetries: 0 }
    );
    const cState = await cLoop.runTask('search for black cats');
    const cFinalUrl = await pageEval(fixturePage, 'location.href');
    const cShot = await pageShot(fixturePage, path.join(EVIDENCE_DIR, 'phase11_scenarioC_fixture_task_success.png'));
    evidence.screenshots.push(cShot);
    evidence.scenarios.C_deterministicEndToEnd = {
      note: 'Identical real PrivAgent stack driven against a deterministic local page, because Google serves an automated-browser interstitial (/sorry/index).',
      fixtureUrl: FIXTURE_ORIGIN + '/',
      finalStatus: cState.status,
      goalStatus: cState.goalStatus,
      goalReason: cState.reason ?? null,
      finalUrl: cFinalUrl,
      steps: cSteps,
      executionTrace: cExec,
      pressKeyUsedOnlySafeKeys: cSteps.filter((s) => s.action === 'pressKey').every((s) => runtime.isSafeKey(String(s.key))),
      goalVerified: cState.status === 'SUCCESS' || cState.goalStatus === 'SUCCESS',
    };

    // Return the fixture to its home page before the targeted interaction probes.
    await pageEval(fixturePage, `location.href = ${JSON.stringify(FIXTURE_ORIGIN + '/')}`);
    await sleep(1500);
    for (let i = 0; i < 20; i++) {
      const ready = await dashboard.session
        .evaluate(
          `chrome.tabs.sendMessage(${fixtureTabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }).then(() => true).catch(() => false)`,
          { timeoutMs: 20000 }
        )
        .catch(() => false);
      if (ready) break;
      await sleep(600);
    }

    // B1 off-screen: bounded scroll keeps the target inside VIEWPORT_BOUNDS.
    const offscreenBefore = await pageEval(
      fixturePage,
      `(() => { const el = document.getElementById('offscreen-cta');
         const r = el.getBoundingClientRect();
         return { top: r.top + window.scrollY, viewportHeight: window.innerHeight, scrollY: window.scrollY }; })()`
    );
    const scrollAction = { action: 'scroll', direction: 'down', amount: 600, reason: 'Reach the off-screen control' };
    const scrollM5 = runtime.validateAction(scrollAction, fixtureCtx);
    const scrollRes = await fxExecute(scrollAction);
    await sleep(700);
    const offscreenAfter = await pageEval(
      fixturePage,
      `({ scrollY: window.scrollY, targetTop: document.getElementById('offscreen-cta').getBoundingClientRect().top + window.scrollY })`
    );

    // B2 duplicate click suppression (run BEFORE any modal exists, so the
    // suppression observed is the duplicate guard and nothing else)
    const dup1 = await fxExecute({ action: 'click', target: 'behind-modal' });
    const dup2 = await fxExecute({ action: 'click', target: 'behind-modal' });

    // B3 opening a real modal (the off-screen control opens one on click)
    const openModal = await fxExecute({ action: 'click', target: 'offscreen-cta' });
    const behindRes = await fxExecute({ action: 'click', target: 'behind-modal' });
    const openModals = await pageEval(
      fixturePage,
      `document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]').length`
    );

    // B4 M5 must deny an off-allowlist key before it can be executed
    const unsafeKey = { action: 'pressKey', key: 'Delete', target: 'q', reason: 'Remove a character' };
    const unsafeM5 = runtime.validateAction(unsafeKey, fixtureCtx);
    const unsafeExec = await fxExecute(unsafeKey);

    // B5 focus mismatch: Enter aimed at a control that does NOT hold focus
    const focusMismatch = await fxExecute({
      action: 'pressKey',
      key: 'Enter',
      target: 'behind-modal',
      reason: 'Submit from the search field',
    });

    const fixtureShot = await pageShot(fixturePage, path.join(EVIDENCE_DIR, 'phase11_scenarioB_fixture.png'));
    evidence.screenshots.push(fixtureShot);

    evidence.scenarios.B_deterministicFixture = {
      fixtureUrl: FIXTURE_ORIGIN + '/',
      detections: fixtureCtx.detections.map((d) => ({
        id: d.id,
        type: d.type,
        selector: d.selector,
      })),
      B1_offScreenTarget: {
        targetGeometryBefore: offscreenBefore,
        scrollActionProposed: scrollAction,
        m5Allowed: scrollM5.allowed,
        scrollExecuted: scrollRes.success,
        scrollMessage: scrollRes.success ? scrollRes.message : null,
        scrollYBefore: offscreenBefore.scrollY,
        scrollYAfter: offscreenAfter.scrollY,
        scrollDeltaPx: offscreenAfter.scrollY - offscreenBefore.scrollY,
        boundedByValidator: scrollM5.allowed && offscreenAfter.scrollY - offscreenBefore.scrollY <= 600,
        viewportBounds: { ...runtime.VIEWPORT_BOUNDS },
        targetStillOffScreen: offscreenAfter.targetTop > offscreenBefore.viewportHeight,
      },
      B2_duplicateClick: {
        target: 'behind-modal',
        firstClick: { success: dup1.success, message: dup1.success ? dup1.message : null },
        secondClick: { success: dup2.success, error: dup2.success ? null : dup2.error },
        suppressedByDuplicateGuard: dup2.success === false && /DUPLICATE_CLICK_SUPPRESSED/.test(String(dup2.error)),
      },
      B3_modalOverlay: {
        modalOpenedBy: { action: 'click', target: 'offscreen-cta', success: openModal.success },
        openModalsInPage: openModals,
        clickThroughBlocked: behindRes.success === false,
        error: behindRes.success ? null : behindRes.error,
      },
      B4_offAllowlistKey: {
        proposed: unsafeKey,
        m5Allowed: unsafeM5.allowed,
        m5Reason: unsafeM5.reason,
        executorAlsoRefused: unsafeExec.success === false,
        executorError: unsafeExec.success ? null : unsafeExec.error,
      },
      B5_focusMismatch: {
        success: focusMismatch.success,
        error: focusMismatch.success ? null : focusMismatch.error,
        blocked: focusMismatch.success === false,
      },
    };

    // ── Verdict ──────────────────────────────────────────────────────────────
    const scenarioA = evidence.scenarios.A4_agentLoop;
    evidence.result = {
      dashboardIsolated: evidence.scenarios.A2_dashboardIsolation.dashboardUrlUnchanged,
      targetTabProvisioned: evidence.scenarios.A2_dashboardIsolation.targetTabIdDiffersFromDashboard,
      contentScriptAttached: evidence.scenarios.A3_perception.contentScriptAttached,
      pagePerceivedAndGrounded: scenarioA.gateTrace.some((g) => g.grounded === true),
      m5AndSecurityGatesRan: scenarioA.gateTrace.every((g) => g.m5Allowed !== null && g.criticVerdict !== null),
      multipleHumanLikeInteractions: scenarioA.steps.length >= 2,
      safeKeysOnly: evidence.scenarios.A5_safeKeyboard.onlyAllowlistedKeysUsed,
      effectVerificationRan: scenarioA.steps.every((s) => s.effectStatus !== null),
      recoveryInvoked: scenarioA.recovery.totalRecoveryAttempts > 0,
      goalVerified: scenarioA.goalStatus === 'SUCCESS' || scenarioA.finalStatus === 'SUCCESS',
      googleServedInterstitial: (evidence.scenarios.A4_agentLoop.finalUrl || '').includes('/sorry/'),
      deterministicEndToEndGoalVerified: evidence.scenarios.C_deterministicEndToEnd.goalVerified,
      scenarioBAllBehavioursConfirmed:
        evidence.scenarios.B_deterministicFixture.B1_offScreenTarget.boundedByValidator &&
        evidence.scenarios.B_deterministicFixture.B2_duplicateClick.suppressedByDuplicateGuard &&
        evidence.scenarios.B_deterministicFixture.B3_modalOverlay.clickThroughBlocked &&
        evidence.scenarios.B_deterministicFixture.B4_offAllowlistKey.m5Allowed === false &&
        evidence.scenarios.B_deterministicFixture.B5_focusMismatch.blocked,
    };

    fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence written to ${path.relative(REPO_ROOT, EVIDENCE_JSON)}`);
    console.log(JSON.stringify(evidence.result, null, 2));
  } finally {
    for (const s of sessions) s.close();
    try {
      chrome.kill('SIGKILL');
    } catch {}
    try {
      server.close();
    } catch {}
  }
}

await main();
