/**
 * Probe — what does the REAL reasoner actually return for the REAL Google
 * planner context?
 *
 * Captures the genuine sanitized+minimized planner context from live google.com
 * in real Chrome, then POSTs it to the REAL backend, and records the REAL
 * provider's response verbatim. This isolates the reasoner's decision from the
 * agent loop so the first concrete defect can be identified with evidence.
 *
 * Read-only. No fakes, no overrides.
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
const CHROME_PORT = Number(process.env.PRIVAGENT_PROBE_CDP_PORT || 9497);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 8010);
const PYTHON = path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');
const GOAL = 'open google and search cats';
const OUT = path.join(REPO_ROOT, 'docs', 'evidence', 'post-phase15-e2e', 'reasoner_response_probe.json');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdpGet = (endpoint, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CHROME_PORT, path: endpoint, method }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('non-JSON')); } });
    });
    req.on('error', reject); req.end();
  });

class Session {
  constructor(ws, sessionId) {
    this.ws = ws; this.sessionId = sessionId; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const e = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(e.t);
        m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result);
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
async function openSession(u) {
  const ws = new WebSocket(u);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  return new Session(ws);
}

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: j, raw: raw.slice(0, 600) }); });
    });
    req.on('error', reject); req.end(data);
  });
}

async function waitForBackend() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: BACKEND_PORT, path: '/openapi.json' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.end();
      });
      if (r === 200) return true;
    } catch { /* not up */ }
    await sleep(500);
  }
  return false;
}

const ENTRY = path.join(__dirname, '.probe_entry.ts');
const BUNDLE = path.join(__dirname, '.probe_bundle.mjs');

async function main() {
  fs.writeFileSync(ENTRY, [
    "export { PlannerContextBuilder } from '../extension/src/hierarchicalPlanning/plannerContextBuilder';",
    "export { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';",
    "export { buildSemanticUnderstanding } from '../extension/src/semanticUnderstanding';",
    "export { buildAgentPayload } from '../extension/src/privacy/types';",
    "export { minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';",
  ].join('\n'), 'utf8');
  if (spawnSync('npx', ['esbuild', ENTRY, '--bundle', '--format=esm', '--platform=node', `--outfile=${BUNDLE}`], { cwd: REPO_ROOT, stdio: 'ignore' }).status !== 0) throw new Error('bundle failed');
  const mod = await import(BUNDLE);

  const out = { goal: GOAL, note: 'Real google.com context -> real backend -> real configured provider. Response recorded verbatim.' };
  const backend = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(BACKEND_PORT)], { cwd: path.join(REPO_ROOT, 'backend'), stdio: ['ignore', 'ignore', 'ignore'] });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-probe-'));
  const chrome = spawn(CHROME_BIN, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900', `--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--proxy-bypass-list=*', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
  const sessions = [];
  try {
    out.backendUp = await waitForBackend();
    for (let i = 0; i < 100; i++) { try { await cdpGet('/json/version'); break; } catch { await sleep(250); } }
    const bs = await openSession((await cdpGet('/json/version')).webSocketDebuggerUrl);
    const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    bs.close();
    out.extensionId = extensionId;
    const ctl = await openSession((await cdpGet(`/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`, 'PUT')).webSocketDebuggerUrl);
    sessions.push(ctl);
    await ctl.send('Runtime.enable');
    await sleep(1500);
    const tabId = await ctl.evaluate(`chrome.tabs.create({ url: 'https://www.google.com/', active: true }).then(t => t.id).catch(() => null)`);
    if (tabId == null) throw new Error('could not open google');
    await sleep(6000);

    const scan = JSON.parse(await ctl.evaluate(
      `chrome.tabs.sendMessage(${tabId}, { type: 'PRIVAGENT_SCAN_REQUEST', mode: 'blackout' }).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ __error: String(e) }))`,
      { timeoutMs: 60000 }
    ));
    if (scan.__error) throw new Error(`scan failed: ${scan.__error}`);
    const report = scan.report || {};

    let semantic = scan.semanticUnderstanding;
    if ((!semantic || !scan.worldModel) && scan.worldModel) {
      try { semantic = mod.buildSemanticUnderstanding({ worldModel: scan.worldModel, pageGeneration: scan.worldModel.page.pageGeneration, userGoal: GOAL }); } catch {}
    }
    const sanitized = semantic?.sanitizedContext || scan.semanticContext || null;
    const base = mod.minimizeAgentContext(mod.buildAgentPayload(report, null, sanitized), { task: GOAL }).payload;
    const decomp = mod.decomposeTask(GOAL, { currentUrl: report.url });
    const ctx = mod.PlannerContextBuilder.buildContext(base, decomp.goal, decomp.subgoals[0], undefined).contextPayload;

    out.sentToReasoner = {
      url: ctx.url,
      detectionCount: (ctx.detections || []).length,
      detections: (ctx.detections || []).map((d) => ({ id: d.id, type: d.type, selector: d.selector })),
      pageType: ctx.page_type,
    };

    const res = await post(BACKEND_PORT, '/api/v1/agent/action', { task: GOAL, context: ctx, history: [], model_role: 'FAST' });
    out.reasonerResponse = { status: res.status, body: res.body, rawIfUnparseable: res.body ? undefined : res.raw };
    out.observations = {
      choseAction: res.body?.action?.action ?? null,
      reasonGiven: res.body?.reason ?? res.body?.action?.reason ?? null,
      telemetry: res.body?.telemetry ?? null,
      analysis: res.body?.action
        ? 'A search input AND the real Google Search button were present in the context sent to the reasoner.'
        : 'No action returned.',
    };
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { backend.kill('SIGKILL'); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error('[PROBE] error:', e.message); process.exit(2); });
