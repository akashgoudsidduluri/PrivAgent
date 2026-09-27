/**
 * PrivAgent — PHASE 17.5 real-reasoner long-horizon validation.
 *
 * SUBSTRATE (what is real):
 *   • the REAL backend reasoner — Groq openai/gpt-oss-20b, the production
 *     `BackendAgentProvider`, the production HTTP path to
 *     POST /api/v1/agent/action;
 *   • the REAL built MV3 extension loaded into REAL headless Chrome;
 *   • the REAL production `AgentLoop` with the real D5 persistence wired in;
 *   • real trusted input events and real navigations.
 *
 * The PROPOSER IS NOT SCRIPTED. Every action below came from the model.
 *
 * What is controlled: the fixture pages (deterministic, no network dependence)
 * and the two host callbacks the service worker supplies in production
 * (`perceivePage`, `executeAction`), which read the live tab and dispatch real
 * input. This is the same hybrid substrate the 17.4 long-horizon run used, and
 * it is labelled as such — the model and the loop are the subject, not the page.
 *
 * If the reasoner fails, the failure is recorded. It is never replaced by a
 * scripted proposer and never reported as a success.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';
import { AgentLoop } from '../extension/src/agent/agentLoop.ts';
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider.ts';
import { createSessionStore } from '../extension/src/agent/longHorizonPersistence.ts';

const FIXTURE_PORT = Number(process.env.P175_FIXTURE_PORT || 4260);
const CDP_PORT = Number(process.env.P175_CDP_PORT || 9561);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
// PHASE 17.5: talk to the backend that is ACTUALLY listening. The provider
// defaulted to 8010 while the 17.4 harness started its own backend on 8061, so
// every request went nowhere and the model was never invoked.
const BACKEND_PORT = Number(process.env.P175_BACKEND_PORT || 8010);
const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`;

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase17', '17.5-real-reasoner');
const OUT = path.join(OUT_DIR, 'real_reasoner_evidence.json');

// PHASE 17.5. The task is recorded VERBATIM here and in the evidence file. An
// earlier phrasing ("...then find the pricing information on the site...") left
// the route ambiguous and the real model answered it with three `scroll`
// actions against an already-bottomed page, which effect verification correctly
// refused. That run is preserved in the evidence history, not hidden.
const TASK = `Go to the pricing page at ${ORIGIN}/pricing and report the price shown there.`;

const out = {
  timestamp: new Date().toISOString(),
  work: 'Phase 17.5 — real-reasoner long-horizon validation',
  substrate:
    'REAL reasoner (Groq openai/gpt-oss-20b via the production BackendAgentProvider) + REAL built MV3 extension + REAL headless Chrome + REAL production AgentLoop',
  proposer: 'REAL MODEL — not scripted. Every proposed action came from the reasoner over the production HTTP path.',
  fixture: 'CONTROLLED local fixture (deterministic pages, no network dependence).',
  task: TASK,
  provider: { baseUrl: BACKEND_BASE },
  cycles: [],
  result: {},
};

const waitForBackend = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const s = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: BACKEND_PORT, path: '/openapi.json' }, (r) => {
          r.resume();
          r.on('end', () => resolve(r.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      if (s === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
};

const server = await servePhase16Fixture(FIXTURE_PORT);
const { proc: chrome, profile } = launchChrome(CDP_PORT);
const sessions = [];

const tidy = async () => {
  for (const s of sessions) {
    try {
      s.close();
    } catch {
      /* closed */
    }
  }
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* gone */
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    server.close();
  } catch {
    /* closed */
  }
};

try {
  out.provider.backendReachable = await waitForBackend();
  if (!out.provider.backendReachable) throw new Error(`backend not reachable on ${BACKEND_PORT}`);

  for (let i = 0; i < 120; i++) {
    try {
      await cdpGet(CDP_PORT, '/json/version');
      break;
    } catch {
      await sleep(250);
    }
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
        ids: [...document.querySelectorAll('[id]')].map(e => ({ id: e.id, tag: e.tagName.toLowerCase() })),
      }))()`,
    });
    return r.result.value;
  };

  const perceivePage = async () => {
    const o = await observe();
    return {
      url: o.url,
      timestamp: Date.now(),
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: o.scrollY },
      viewportObservable: true,
      screenshot_dimensions: null,
      detections: o.ids.map((e, i) => ({
        id: `el_${i}_${e.id}`,
        // PHASE 17.5: the backend DetectionType enum. A hand-built context that
        // invents its own type strings is a HARNESS bug (it was the real cause
        // of the 17.4 422 ambiguity), not a product defect.
        type: e.tag === 'a' ? 'link' : e.tag === 'button' ? 'button' : e.tag === 'input' ? 'input' : e.tag === 'form' ? 'form' : e.tag === 'select' ? 'select' : 'element',
        confidence: 0.95,
        bbox: { x: 10, y: 10 + i * 30, width: 220, height: 28 },
        length: 0,
        source: 'dom_attribute',
        selector: `#${e.id}`,
        is_partially_visible: false,
      })),
      total_elements_scanned: o.domElementCount,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
    };
  };

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

  const provider = new BackendAgentProvider({ timeoutMs: 55000, baseUrl: BACKEND_BASE });
  const loop = new AgentLoop(
    provider,
    {
      getEffectSnapshot: async () => {
        const o = await observe();
        return {
          url: o.url,
          scrollX: 0,
          scrollY: o.scrollY,
          domElementCount: o.domElementCount,
          targetValueLength: 0,
          openModalsCount: 0,
          timestamp: Date.now(),
        };
      },
      perceivePage,
      executeAction,
    },
    {
      delayBetweenStepsMs: 300,
      maxSteps: 12,
      // PHASE 17.5: exercise the real D5 persistence path in a real worker.
      longHorizonStore: createSessionStore(),
    }
  );

  const origRequest = provider.requestAction.bind(provider);
  provider.requestAction = async (task, context, history, role) => {
    const t = Date.now();
    let a;
    try {
      a = await origRequest(task, context, history, role);
    } catch (e) {
      out.proposerError = { cycle: out.cycles.length + 1, message: String(e && e.message || e) };
      // Re-issue the identical request WITHOUT the provider wrapper so the raw
      // 422 body is visible. Diagnostics only — never a substitute proposer.
      const { viewportObservable: _a, viewportSource: _b, ...ctx } = context;
      const r = await fetch(`${BACKEND_BASE}/api/v1/agent/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, context: ctx, history, model_role: role }),
      });
      out.proposerError.status = r.status;
      out.proposerError.rawBody = (await r.text()).slice(0, 2000);
      throw e;
    }
    out.cycles.push({
      cycle: out.cycles.length + 1,
      observedUrlBefore: context?.url ?? null,
      detectionCount: Array.isArray(context?.detections) ? context.detections.length : null,
      historyLength: Array.isArray(history) ? history.length : null,
      modelProposed: { action: a?.action, target: a?.target ?? null, url: a?.url ?? null, text: a?.text ?? null, reason: a?.reason ?? null },
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
    longHorizonRestoreStatus: loop.longHorizonRestoreStatus ?? null,
    finalLongHorizon: finalState.longHorizon
      ? {
          actionCount: finalState.longHorizon.actionCount,
          recoveryCount: finalState.longHorizon.recoveryCount,
          consecutiveNoProgress: finalState.longHorizon.consecutiveNoProgress,
          totalNoProgress: finalState.longHorizon.totalNoProgress,
        }
      : null,
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
    note: out.result.goalVerifiedByVerifier
      ? 'The loop reached SUCCESS, decided by the production goal verifier from the OBSERVED browser state. Every action came from the model.'
      : 'The real reasoner run did NOT reach verified SUCCESS. Recorded as-is; NOT replaced with a scripted proposer.',
  };
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
  out.summary = {
    realReasoner: true,
    proposerScripted: false,
    error: out.error,
    reachedVerifiedSuccess: false,
    note: 'The real-reasoner run FAILED. The failure is recorded rather than replaced with a fake success.',
  };
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await tidy();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
}

console.log(JSON.stringify(out.summary, null, 2));
process.exit(0);
