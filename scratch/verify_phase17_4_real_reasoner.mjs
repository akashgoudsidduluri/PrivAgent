/**
 * PrivAgent — PHASE 17.4 real-reasoner long-horizon run.
 *
 * A CONTROLLED FIXTURE page, the REAL backend reasoner (Groq
 * openai/gpt-oss-20b, the production provider), the REAL built extension
 * loaded into REAL headless Chrome, and the REAL production AgentLoop.
 *
 * The only scripted parts are the browser host callbacks (perceivePage and
 * executeAction), which is exactly what the real service worker supplies in
 * production — they read the live tab and dispatch real trusted input events.
 * The PROPOSER is not scripted: every action comes from the model.
 *
 * If the provider fails, the failure is recorded. It is never replaced with a
 * fake success.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import http from 'http';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome, PYTHON } from './phase16_cdp.mjs';
import { AgentLoop } from '../extension/src/agent/agentLoop.ts';
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider.ts';

const FIXTURE_PORT = Number(process.env.P174R_FIXTURE_PORT || 4250);
const BACKEND_PORT = Number(process.env.P174R_BACKEND_PORT || 8061);
const CDP_PORT = Number(process.env.P174R_CDP_PORT || 9551);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase17', '17.4-long-horizon');
const OUT = path.join(OUT_DIR, 'real_reasoner_evidence.json');
const BACKEND_LOG = path.join('/tmp', 'p174r_backend.log');

const TASK = `Open ${ORIGIN}/ , then find the pricing information on the site, and report the price of the first product.`;

const out = {
  timestamp: new Date().toISOString(),
  work: 'Phase 17.4 — controlled real-reasoner long-horizon run',
  substrate: 'REAL reasoner (Groq openai/gpt-oss-20b via the production BackendAgentProvider) + REAL built MV3 extension + REAL headless Chrome',
  proposer: 'REAL MODEL — not scripted. Every proposed action came from the reasoner over the production HTTP path.',
  fixture: 'CONTROLLED local fixture (deterministic pages, no network dependence).',
  task: TASK,
  provider: {},
  cycles: [],
  result: {},
};

const waitForBackend = async () => {
  for (let i = 0; i < 160; i++) {
    try {
      const s = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: BACKEND_PORT, path: '/openapi.json' }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
        req.on('error', reject); req.end();
      });
      if (s === 200) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
};

const server = await servePhase16Fixture(FIXTURE_PORT);
const backendFd = fs.openSync(BACKEND_LOG, 'w');
const backend = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(BACKEND_PORT)], {
  cwd: path.join(REPO_ROOT, 'backend'), stdio: ['ignore', backendFd, backendFd],
});
const { proc: chrome, profile } = launchChrome(CDP_PORT);
const sessions = [];

const tidy = async () => {
  for (const s of sessions) { try { s.close(); } catch { /* closed */ } }
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  try { backend.kill('SIGKILL'); } catch { /* gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  try { server.close(); } catch { /* closed */ }
  try { fs.closeSync(backendFd); } catch { /* closed */ }
};

try {
  out.provider.backendReachable = await waitForBackend();
  if (!out.provider.backendReachable) throw new Error('backend did not become reachable');

  for (let i = 0; i < 120; i++) {
    try { await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(250); }
  }
  const bs = await openSession((await cdpGet(CDP_PORT, '/json/version')).webSocketDebuggerUrl);
  const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  bs.close();
  out.provider.extensionId = extensionId;

  const pageTarget = (await cdpGet(CDP_PORT, '/json/list')).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const page = await openSession(pageTarget.webSocketDebuggerUrl);
  sessions.push(page);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  const observe = async () => {
    const r = await page.send('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `(() => ({
        url: location.href,
        title: document.title,
        domElementCount: document.querySelectorAll('*').length,
        scrollY: window.scrollY,
        markers: [...document.querySelectorAll('[data-marker]')].map(e => e.getAttribute('data-marker')),
        ids: [...document.querySelectorAll('[id]')].map(e => ({ id: e.id, tag: e.tagName.toLowerCase() })),
      }))()`,
    });
    return r.result.value;
  };

  // The REAL service worker's per-cycle contract: fresh observation each cycle.
  const perceivePage = async () => {
    const o = await observe();
    return {
      url: o.url,
      timestamp: Date.now(),
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: o.scrollY },
      viewportObservable: true,
      screenshot_dimensions: null,
      detections: o.ids.map((e, i) => ({
        id: `el_${i}_${e.id}`, type: e.tag === 'a' ? 'link' : e.tag === 'button' ? 'button' : e.tag === 'input' ? 'text_input' : 'text',
        confidence: 0.95, bbox: { x: 10, y: 10 + i * 30, width: 220, height: 28 },
        length: 0, source: 'dom_attribute', selector: `#${e.id}`, is_partially_visible: false,
      })),
      total_elements_scanned: o.domElementCount,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
    };
  };

  // Real dispatch: navigate via the real address, everything else via a real
  // trusted mouse event at the element's real coordinates.
  const executeAction = async (action) => {
    const t0 = Date.now();
    if (action.action === 'navigate' && typeof action.url === 'string') {
      await page.send('Page.navigate', { url: action.url });
      await sleep(1200);
      return { success: true, message: `navigated to ${action.url}`, latencyMs: Date.now() - t0 };
    }
    if (action.action === 'scroll') {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: action.amount ?? 500 });
      await sleep(700);
      return { success: true, message: 'scrolled', latencyMs: Date.now() - t0 };
    }
    const sel = `#${String(action.target ?? '')}`;
    const box = await page.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
    });
    const p = box.result.value;
    if (!p) return { success: false, error: `target not present: ${sel}` };
    if (action.action === 'type') {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: String(action.text ?? '') });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', text: String(action.text ?? '') });
      await sleep(300);
      return { success: true, message: 'typed', latencyMs: Date.now() - t0 };
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    await sleep(900);
    return { success: true, message: 'clicked', latencyMs: Date.now() - t0 };
  };

  await page.send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(1500);
  out.provider.startObservation = await observe();

  const provider = new BackendAgentProvider({ timeoutMs: 55000 });
  const loop = new AgentLoop(
    provider,
    {
      getEffectSnapshot: async () => {
        const o = await observe();
        return { url: o.url, scrollX: 0, scrollY: o.scrollY, domElementCount: o.domElementCount, targetValueLength: 0, openModalsCount: 0, timestamp: Date.now() };
      },
      perceivePage,
      executeAction,
    },
    { delayBetweenStepsMs: 300, maxSteps: 10 }
  );

  // Record what the MODEL actually proposed, cycle by cycle.
  const origRequest = provider.requestAction.bind(provider);
  provider.requestAction = async (task, context, history, role) => {
    const t = Date.now();
    const a = await origRequest(task, context, history, role);
    out.cycles.push({
      cycle: out.cycles.length + 1,
      observedUrlBefore: context?.url ?? null,
      detectionCount: Array.isArray(context?.detections) ? context.detections.length : null,
      historyLength: Array.isArray(history) ? history.length : null,
      modelProposed: { action: a?.action, target: a?.target ?? null, url: a?.url ?? null, text: a?.text ?? null },
      reasonerLatencyMs: Date.now() - t,
    });
    return a;
  };

  const finalState = await loop.runTask(TASK);

  out.result = {
    status: finalState.status,
    goalStatus: finalState.goalStatus,
    reason: finalState.reason ?? null,
    steps: finalState.steps.length,
    actionsDispatched: finalState.steps.filter((s) => s.executionSuccess).length,
    finalObservedUrl: (await observe()).url,
    goalVerifiedByVerifier: finalState.goalStatus === 'SUCCESS',
  };

  const reasonerLat = out.cycles.map((c) => c.reasonerLatencyMs).sort((a, b) => a - b);
  out.provider.reasonerLatencyMs = reasonerLat.length
    ? { p50: reasonerLat[Math.floor(reasonerLat.length / 2)], min: reasonerLat[0], max: reasonerLat[reasonerLat.length - 1] }
    : null;

  out.summary = {
    realReasoner: true,
    proposerScripted: false,
    modelCycles: out.cycles.length,
    reachedVerifiedSuccess: out.result.goalVerifiedByVerifier,
    status: out.result.status,
    note:
      out.result.goalVerifiedByVerifier
        ? 'The loop reached SUCCESS, decided by the production goal verifier from the observed browser state.'
        : 'The real reasoner run did NOT reach verified SUCCESS. This is recorded as-is and is NOT replaced with a scripted success.',
  };
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
  out.summary = { realReasoner: true, proposerScripted: false, error: out.error, reachedVerifiedSuccess: false,
    note: 'The real-reasoner run FAILED. The failure is recorded rather than replaced with a fake success.' };
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  try { out.backendLogTail = fs.readFileSync(BACKEND_LOG, 'utf8').split('\n').slice(-25).join('\n'); } catch { /* n/a */ }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  await tidy();
}

console.log(JSON.stringify(out.summary, null, 2));
process.exit(0);
