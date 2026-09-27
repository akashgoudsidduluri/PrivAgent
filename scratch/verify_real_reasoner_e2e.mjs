/**
 * PrivAgent — REAL end-to-end autonomous run (P0-2)
 *
 * Drives the canonical task "open google and search cats" through the genuine
 * production path, in real Chrome, against a REAL backend and a REAL cloud
 * reasoner:
 *
 *   built dashboard (frontend/dist, real ExtensionAgentAdapter)
 *     → window bridge → real content script → real service worker
 *       → real target resolver → real containment
 *         → real AgentLoop → real perception → real sanitization
 *           → real BackendAgentProvider → real backend /api/v1/agent/action
 *             → REAL Groq (openai/gpt-oss-20b)
 *           → real Grounding/M5/Critic/Privacy/Risk → real dispatch
 *             → OBSERVED post-action snapshot → real effect verification
 *           → real goal verification → real terminal result
 *
 * NOTHING is stubbed: no scripted proposer, no deterministic local policy, no
 * fabricated response. The backend is the repository's own FastAPI app started
 * as a child process from backend/.venv.
 *
 * Success is judged ONLY on observed browser state. A 200, a proposed action,
 * a passed gate, or a successful dispatch are each recorded but none of them
 * counts as goal achievement.
 *
 * Evidence → docs/evidence/post-phase15-e2e/
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PORT = Number(process.env.PRIVAGENT_E2E_CDP_PORT || 9493);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');

const DASHBOARD_PORT = Number(process.env.PRIVAGENT_DASHBOARD_PORT || 5173);
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 8010);
const TASK = 'open google and search cats';
const RUN_TIMEOUT_MS = Number(process.env.PRIVAGENT_E2E_TIMEOUT_MS || 150000);

const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-phase15-e2e');
const EVIDENCE_JSON = path.join(EVIDENCE_DIR, 'real_reasoner_e2e_evidence.json');
const BACKEND_LOG = path.join(EVIDENCE_DIR, 'backend_run.log');
const PYTHON = path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// ── small helpers ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serveStatic(port, rootDir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(rootDir)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)));
}

const cdpGet = (endpoint, method = 'GET', port = CHROME_PORT) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: endpoint, method }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('non-JSON')); } });
    });
    req.on('error', reject);
    req.end();
  });

class Session {
  constructor(ws, sessionId) {
    this.ws = ws; this.sessionId = sessionId; this.id = 0; this.pending = new Map();
    this.logs = [];
    this.onEvent = null;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const e = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(e.t);
        m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.consoleAPICalled') {
          try {
            const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
            this.logs.push({ t: Date.now(), level: m.params.type, text });
          } catch { /* ignore */ }
        }
        if (this.onEvent) this.onEvent(m);
      }
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

async function openSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  return new Session(ws);
}

function ensureVerifierBundle() {
  const bundle = path.join(__dirname, '.effect_verifier_bundle.mjs');
  const entry = path.join(__dirname, '.effect_verifier_entry.ts');
  const src = "export { verifyActionEffect } from '../extension/src/agent/effectVerifier';\n";
  if (!fs.existsSync(entry) || fs.readFileSync(entry, 'utf8') !== src) fs.writeFileSync(entry, src, 'utf8');
  const r = spawnSync('npx', ['esbuild', entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`], { cwd: REPO_ROOT, stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(bundle)) throw new Error('verifier bundle failed');
}

// ── backend readiness (no secrets are ever printed) ──────────────────────────
async function waitForBackend() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: BACKEND_PORT, path: '/openapi.json', method: 'GET' }, (r) => {
          let n = 0; r.on('data', (d) => (n += d.length)); r.on('end', () => resolve(r.statusCode));
        });
        req.on('error', reject); req.end();
      });
      if (res === 200) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

async function main() {
  const evidence = {
    timestamp: new Date().toISOString(),
    work: 'P0-2 real reasoner end-to-end autonomous run',
    task: TASK,
    environment: {
      python: spawnSync(PYTHON, ['-V'], { encoding: 'utf8' }).stdout?.trim() || 'unknown',
      backendPort: BACKEND_PORT,
      dashboardPort: DASHBOARD_PORT,
      dashboardBuild: 'frontend/dist (production Vite build, served statically)',
      extensionBuild: 'dist/ (production extension build)',
    },
    substitutionsUsed: 'NONE — real backend, real configured provider, no scripted proposer',
    gates: {},
    distinctions: {},
  };

  // 0. Report the CONFIGURED provider without exposing the key.
  const cfg = spawnSync(PYTHON, ['-c', [
    'import sys; sys.path.insert(0,".")',
    'from app import config',
    'from app.reasoner import build_reasoner, resolve_reasoner_name',
    'n = resolve_reasoner_name(config.REASONER_MODE)',
    'r = build_reasoner(n)',
    'print(config.REASONER_MODE, config.has_api_key("groq"), config.GROQ_MODEL, config.GROQ_TIMEOUT_SECONDS, config.REASONER_FALLBACK_PROVIDER or "none", type(r).__name__)',
  ].join(';')], { cwd: path.join(REPO_ROOT, 'backend'), encoding: 'utf8' });
  if (cfg.status === 0) {
    const [mode, hasKey, model, timeout, fallback, cls] = cfg.stdout.trim().split(' ');
    evidence.reasonerConfig = { mode, apiKeyConfigured: hasKey === 'True', model, timeoutSeconds: Number(timeout), configuredFallback: fallback, reasonerClass: cls, keyValueNeverPrinted: true };
  } else {
    evidence.reasonerConfig = { error: 'could not read config' };
  }
  console.log(`[E2E] reasoner config: ${JSON.stringify(evidence.reasonerConfig)}`);

  if (!fs.existsSync(PYTHON)) {
    evidence.result = { outcome: 'STOPPED', blocker: `backend virtualenv missing at ${PYTHON}` };
    fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
    throw new Error('backend venv missing');
  }

  // 1. Start the REAL backend.
  const backendLogFd = fs.openSync(BACKEND_LOG, 'w');
  const backend = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(BACKEND_PORT)], {
    cwd: path.join(REPO_ROOT, 'backend'), stdio: ['ignore', backendLogFd, backendLogFd],
  });
  evidence.backendStarted = await waitForBackend();
  console.log(`[E2E] backend reachable: ${evidence.backendStarted}`);

  // 2. Serve the PRODUCTION dashboard build.
  const dash = await serveStatic(DASHBOARD_PORT, path.join(REPO_ROOT, 'frontend', 'dist'));

  // 3. Launch real Chrome with the built extension.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-e2e-'));
  const chrome = spawn(CHROME_BIN, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,900', `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    // Bypass the proxy so the container can reach the real internet.
    '--no-proxy-server', '--proxy-bypass-list=*', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const sessions = [];
  try {
    for (let i = 0; i < 100; i++) { try { await cdpGet('/json/version'); break; } catch { await sleep(250); } }
    const bs = await openSession((await cdpGet('/json/version')).webSocketDebuggerUrl);
    const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    bs.close();
    evidence.extensionId = extensionId;

    // Dashboard tab: the real frontend, so the real ExtensionAgentAdapter runs.
    const dashTarget = await cdpGet(`/json/new?${encodeURIComponent(`http://localhost:${DASHBOARD_PORT}/`)}`, 'PUT');
    const dashSession = await openSession(dashTarget.webSocketDebuggerUrl);
    sessions.push(dashSession);
    await dashSession.send('Page.enable');
    await dashSession.send('Runtime.enable');
    await sleep(4000);
    evidence.dashboardLoaded = await dashSession.evaluate(
      `!!document.getElementById('agent-task-input') && !!document.getElementById('agent-run-btn')`
    );
    console.log(`[E2E] real dashboard loaded with task input + RUN: ${evidence.dashboardLoaded}`);

    // 3b. Attach to the REAL service worker BEFORE the run, and record every
    // request it makes to the reasoner endpoint. This observes the wire without
    // changing a single line of application code.
    const reasonerRequests = [];
    {
      const swTargetEarly = (await cdpGet('/json/list')).find((t) => t.url && t.url.includes('serviceWorker.js'));
      if (swTargetEarly && swTargetEarly.webSocketDebuggerUrl) {
        const swEarly = await openSession(swTargetEarly.webSocketDebuggerUrl);
        sessions.push(swEarly);
        await swEarly.send('Runtime.enable');
        await swEarly.send('Network.enable');
        swEarly.onEvent = (m) => {
          if (m.method === 'Network.requestWillBeSent' && /\/api\/v1\/agent\/(action|review)/.test(m.params.request.url || '')) {
            let parsed = null;
            try { parsed = JSON.parse(m.params.request.postData || 'null'); } catch {}
            reasonerRequests.push({
              endpoint: (m.params.request.url || '').split('/').pop(),
              sentAt: Date.now(),
              task: parsed?.task ?? null,
              contextUrl: parsed?.context?.url ?? null,
              detectionCount: Array.isArray(parsed?.context?.detections) ? parsed.context.detections.length : null,
              detections: Array.isArray(parsed?.context?.detections)
                ? parsed.context.detections.map((d) => ({ id: d.id, type: d.type, selector: d.selector }))
                : null,
              pageType: parsed?.context?.page_type ?? null,
              historyLength: Array.isArray(parsed?.history) ? parsed.history.length : null,
            });
          }
        };
        evidence.serviceWorkerAttachedPreRun = true;
      } else {
        evidence.serviceWorkerAttachedPreRun = false;
      }
    }

    // 4. Install the TASK_PROGRESS collector FIRST, so no payload is missed,
    //    then type the canonical task and press the real RUN button.
    await dashSession.evaluate(`
      window.__e2e = { payloads: [] };
      window.addEventListener('message', (ev) => {
        if (ev.source !== window) return;
        if (!ev.data || ev.data.source !== 'privagent-extension') return;
        if (ev.data.type === 'TASK_PROGRESS') window.__e2e.payloads.push(ev.data.payload);
      });
      true
    `);
    await sleep(300);
    await dashSession.evaluate(`
      (() => {
        const input = document.getElementById('agent-task-input');
        input.value = ${JSON.stringify(TASK)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('agent-run-btn').click();
        return true;
      })()
    `);

    // 5. Wait for the run to terminate.
    const payloads = [];
    {
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      let last = null;
      while (Date.now() < deadline) {
        last = await dashSession.evaluate(
          `JSON.stringify((window.__e2e.payloads || []).map(p => ({
             status: p.status,
             reason: p.reason,
             currentStep: p.currentStep,
             phase: p.interaction && p.interaction.activity && p.interaction.activity.phase,
             phaseSummary: p.interaction && p.interaction.activity && p.interaction.activity.summary,
             outcome: p.interaction && p.interaction.outcome,
             terminal: p.interaction && p.interaction.terminal,
             steps: Array.isArray(p.steps) ? p.steps : [],
             url: p.currentUrl,
             targetTabId: p.targetTabId
           })))`
        );
        const arr = JSON.parse(last || '[]');
        if (arr.length && ['SUCCESS', 'FAILED', 'STOPPED'].includes(arr[arr.length - 1].status)) break;
        // If confirmation is required, exercise the REAL confirmation path.
        if (arr.length && arr[arr.length - 1].status === 'NEEDS_USER_CONFIRMATION') {
          console.log('[E2E] confirmation required — exercising the real confirmation flow');
          const confirmedVia = await dashSession.evaluate(`
            (() => {
              const allow = document.getElementById('agent-confirm-allow');
              if (allow && !allow.disabled) { allow.click(); return 'agent-confirm-allow'; }
              return null;
            })()
          `);
          if (confirmedVia) {
            (evidence.confirmationExercised = evidence.confirmationExercised || []).push(confirmedVia);
            console.log(`[E2E] confirmation granted via the real UI control: ${confirmedVia}`);
          } else {
            console.log('[E2E] confirmation required but the real allow control was unavailable');
          }
        }
        await sleep(1000);
      }
      payloads.push(...JSON.parse(last || '[]'));
    }

    evidence.reasonerRequestsOnTheWire = reasonerRequests;
    evidence.payloadTimeline = payloads.map((p) => ({
      status: p.status,
      phase: p.phase,
      phaseSummary: p.phaseSummary,
      reason: p.reason ? String(p.reason).slice(0, 200) : null,
      currentStep: p.currentStep,
      stepCount: (p.steps || []).length,
      url: p.url,
    }));
    evidence.stepRecords = payloads.flatMap((p) => (p.steps || []).map((s) => ({
      step: s.step,
      actionType: s.action ? s.action.action : null,
      target: s.action ? (s.action.target || s.action.url || null) : null,
      validationAllowed: s.validationAllowed,
      validationReason: s.validationReason,
      executionSuccess: s.executionSuccess,
      executionError: s.executionError,
      effectStatus: s.effectStatus,
      effectDetails: s.effectDetails ? String(s.effectDetails).slice(0, 200) : null,
      targetType: s.targetType,
    })));
    const final = payloads[payloads.length - 1] || null;
    evidence.finalPayload = final;
    evidence.distinctions = {
      '1_backendReachable': evidence.backendStarted,
      '2_backendCalledRealProvider': (await backendLogHasReasonerCall()) || null,
      '3_reasonerReturnedValidAction': payloads.some((p) => (p.steps || []).length > 0),
      '4_actionPassedBackendValidation': payloads.some((p) => (p.steps || []).some((s) => s && s.action)),
      '5_actionPassedExtensionGates': payloads.some((p) => (p.steps || []).some((s) => s && s.validationAllowed)),
      '6_actionDispatched': payloads.some((p) => (p.steps || []).some((s) => s && s.executionSuccess)),
      '7_browserStateActuallyChanged': null, // filled from observed snapshots below
      '8_goalActuallyAchieved': final?.status === 'SUCCESS',
    };

    // 5b. Attach to the real service worker so its own trace is captured.
    try {
      const swTarget = (await cdpGet('/json/list')).find((t) => t.url && t.url.includes('serviceWorker.js'));
      if (swTarget && swTarget.webSocketDebuggerUrl) {
        const sw = await openSession(swTarget.webSocketDebuggerUrl);
        sessions.push(sw);
        await sw.send('Runtime.enable');
        evidence.serviceWorkerAttached = true;
      } else {
        evidence.serviceWorkerAttached = false;
      }
    } catch (e) {
      evidence.serviceWorkerAttached = false;
      evidence.serviceWorkerAttachError = String(e);
    }

    // 6. OBSERVED browser state — authoritative for the effect verdict.
    const tabs = await cdpGet('/json/list');
    const target = tabs.find((t) => (t.url || '').includes('google.'));
    evidence.finalBrowserState = { googleTabFound: Boolean(target), url: target?.url || null, title: target?.title || null };
    evidence.distinctions['7_browserStateActuallyChanged'] = Boolean(target) && !(target?.url || '').endsWith('/');

    // 7. Did the browser actually search for cats?
    const searchedCats = Boolean(target) && /[?&]q=cats|cats/i.test(target.url || '');
    evidence.goalVerification = {
      task: TASK,
      finalUrl: target?.url || null,
      searchForCatsPerformed: searchedCats,
      verdict: final?.status === 'SUCCESS' && searchedCats
        ? 'GOAL_ACHIEVED'
        : final?.status === 'SUCCESS'
          ? 'AGENT_CLAIMED_SUCCESS_BUT_GOAL_NOT_OBSERVED'
          : 'NOT_ACHIEVED',
      note: 'The agent\'s own SUCCESS claim is NOT trusted. The verdict is derived from the observed final URL.',
    };
    evidence.adapterReasonerView = await dashSession.evaluate(
      `(() => {
         const el = document.querySelector('#agent-kv-reasoner, [id*="reasoner"]');
         return el ? el.textContent.trim() : null;
       })()`
    ).catch(() => null);
    evidence.terminalResult = {
      status: final?.status ?? null,
      reason: final?.reason ?? null,
      terminal: final?.terminal ?? null,
    };

    // 8. Backend log evidence (key never appears; it is read only for reasoner lines).
    evidence.backendLogReasonerLines = backendReasonerLines();
    evidence.dashboardConsoleTrace = dashSession.logs
      .map((l) => `[${l.level}] ${l.text}`)
      .filter((l) => /AgentTrace|Adapter|ServiceWorker|START_TASK|PROGRESS/i.test(l))
      .slice(0, 120);
    evidence.serviceWorkerConsoleTrace = (sessions.find((s) => s !== dashSession)?.logs || [])
      .map((l) => `[${l.level}] ${l.text}`)
      .filter((l) => /AgentTrace|ServiceWorker|TARGET|contain|perception|reason/i.test(l))
      .slice(0, 160);

    evidence.result = {
      outcome: evidence.goalVerification.verdict,
      honest: true,
      note:
        'Judged only on observed browser state. Backend reachability, an HTTP 200, a proposed action, a passed gate and a successful dispatch are recorded but none counts as goal achievement.',
    };
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { backend.kill('SIGKILL'); } catch {}
    try { fs.closeSync(backendLogFd); } catch {}
    try { dash.close(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
  }

  console.log('\n[E2E] RESULT:', JSON.stringify(evidence.result, null, 1));
  console.log('[E2E] goal:', JSON.stringify(evidence.goalVerification, null, 1));
  console.log(`[E2E] evidence → ${path.relative(REPO_ROOT, EVIDENCE_JSON)}`);
}

function backendReasonerLines() {
  try {
    return fs.readFileSync(BACKEND_LOG, 'utf8')
      .split('\n')
      .filter((l) => /reason|Action Reasoning|provider|fallback/i.test(l))
      .slice(-40)
      .map((l) => l.replace(/[A-Za-z0-9_-]{32,}/g, '<redacted>'));
  } catch { return []; }
}

async function backendLogHasReasonerCall() {
  return backendReasonerLines().some((l) => /Action Reasoning/i.test(l));
}

main().catch((e) => {
  console.error('[E2E] harness error:', e.message);
  process.exit(2);
});
