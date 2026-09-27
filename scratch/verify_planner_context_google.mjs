/**
 * Diagnostic — is P1-1 (planner-context budget excluding the Google search
 * affordance) the actual cause of the real E2E failure?
 *
 * Opens REAL google.com in real Chrome with the built extension, takes the
 * REAL sanitized scan report, and pushes it through the REAL
 * PlannerContextBuilder with the REAL goal. Reports which detections the
 * reasoner could actually see.
 *
 * Read-only: changes nothing, fakes nothing.
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
const CHROME_PORT = Number(process.env.PRIVAGENT_DIAG_CDP_PORT || 9495);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const OUT = path.join(REPO_ROOT, 'docs', 'evidence', 'post-phase15-e2e', 'planner_context_diagnostic.json');
const GOAL = 'open google and search cats';

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

const ENTRY = path.join(__dirname, '.planner_diag_entry.ts');
const BUNDLE = path.join(__dirname, '.planner_diag_bundle.mjs');

async function main() {
  fs.writeFileSync(ENTRY, [
    "export { PlannerContextBuilder } from '../extension/src/hierarchicalPlanning/plannerContextBuilder';",
    "export { buildSemanticUnderstanding } from '../extension/src/semanticUnderstanding';",
    "export { TARGET_PLANNER_CONTEXT_BUDGET_BYTES } from '../extension/src/hierarchicalPlanning/plannerContextBuilder';",
    "export { buildAgentPayload } from '../extension/src/privacy/types';",
    "export { minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';",
    "export { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';",
  ].join('\n'), 'utf8');
  const r = spawnSync('npx', ['esbuild', ENTRY, '--bundle', '--format=esm', '--platform=node', `--outfile=${BUNDLE}`], { cwd: REPO_ROOT, stdio: 'ignore' });
  if (r.status !== 0) throw new Error('planner bundle failed');
  const mod = await import(BUNDLE);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-diag-'));
  const chrome = spawn(CHROME_BIN, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,900', `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--proxy-bypass-list=*', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const out = { goal: GOAL, source: 'REAL google.com + REAL content script + REAL PlannerContextBuilder' };
  const sessions = [];
  try {
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
    if (tabId == null) throw new Error('could not open google.com');
    out.targetTabId = tabId;
    await sleep(6000); // let the real page settle

    const tabUrl = await ctl.evaluate(`chrome.tabs.get(${tabId}).then(t => t.url).catch(() => null)`);
    out.loadedUrl = tabUrl;

    const scanRaw = await ctl.evaluate(
      `chrome.tabs.sendMessage(${tabId}, { type: 'PRIVAGENT_SCAN_REQUEST', mode: 'blackout' }).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ __error: String(e) }))`,
      { timeoutMs: 60000 }
    );
    const scan = JSON.parse(scanRaw);
    if (scan.__error) throw new Error(`scan failed: ${scan.__error}`);
    const report = scan.report || {};
    const detections = report.detections || [];

    out.rawDetections = {
      totalElementsScanned: report.totalElementsScanned,
      detectionCount: detections.length,
      detections: detections.map((d) => ({ id: d.id, type: d.type, selector: d.selector })),
    };

    // Build the SAME context the loop hands the planner.
    const worldModel = scan.worldModel;
    let semantic = scan.semanticUnderstanding;
    if ((!semantic || !worldModel) && worldModel) {
      try {
        semantic = mod.buildSemanticUnderstanding({ worldModel, pageGeneration: worldModel.page.pageGeneration, userGoal: GOAL });
      } catch { /* keep null */ }
    }
    const sanitized = semantic?.sanitizedContext || scan.semanticContext || null;

    // Use the REAL payload construction + minimization the service worker uses,
    // so this diagnostic sees exactly what the reasoner would see.
    const built0 = mod.buildAgentPayload(report, null, sanitized);
    if (!built0) throw new Error('buildAgentPayload returned null');
    const base = mod.minimizeAgentContext(built0, { task: GOAL }).payload;

    // Build the goal with the REAL decomposer, exactly as the loop does.
    const decomp = mod.decomposeTask(GOAL, { currentUrl: report.url });
    out.decomposition = {
      goalId: decomp.goal.goalId,
      taskCategory: decomp.goal.taskCategory,
      subgoalCount: decomp.subgoals.length,
      subgoals: decomp.subgoals.map((s) => ({ id: s.id, category: s.category, description: s.description })),
    };

    const built = mod.PlannerContextBuilder.buildContext(base, decomp.goal, decomp.subgoals[0], undefined);
    const ctx = built.contextPayload || built;
    const kept = ctx.detections || [];

    out.plannerContext = {
      budgetBytes: mod.TARGET_PLANNER_CONTEXT_BUDGET_BYTES,
      actualBytes: built.byteSize ?? null,
      targetBudgetMet: built.targetBudgetMet ?? null,
      keptCount: kept.length,
      droppedCount: detections.length - kept.length,
      kept: kept.map((d) => ({ id: d.id, type: d.type, selector: d.selector })),
    };

    // Is a usable search affordance actually visible to the reasoner?
    const searchLike = kept.filter((d) =>
      ['search', 'input', 'textbox'].includes(String(d.type).toLowerCase()) ||
      /search|q=|query|btnk/i.test(String(d.selector || '') + String(d.id || ''))
    );
    out.searchAffordanceVisibleToReasoner = {
      count: searchLike.length,
      entries: searchLike.map((d) => ({ id: d.id, type: d.type, selector: d.selector })),
    };
    out.verdict = searchLike.length > 0
      ? 'A_SEARCH_AFFORDANCE_WAS_VISIBLE — P1-1 is NOT the cause'
      : 'NO_SEARCH_AFFORDANCE_VISIBLE — P1-1 confirmed as a contributing cause';
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
  console.log(`\n[DIAG] verdict: ${out.verdict}`);
  console.log(`[DIAG] → ${path.relative(REPO_ROOT, OUT)}`);
}

main().catch((e) => { console.error('[DIAG] error:', e.message); process.exit(2); });
