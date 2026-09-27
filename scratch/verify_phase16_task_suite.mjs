/**
 * PrivAgent — PHASE 16.1 / 16.2 / 16.5 : real-reasoner task suite.
 *
 * Runs SEVEN independent task categories through the FULL production path —
 * real backend, real Groq, real service worker, real content script, real
 * gates, real browser, observed effect verification, production goal verifier.
 *
 * Nothing is stubbed. There is no scripted proposer, no injected action, and no
 * hardcoded verdict. The harness READS what the production pipeline decided and
 * records it, including failures. A task that legitimately fails is useful
 * evidence and is reported as a failure.
 *
 * DETERMINISTIC FIXTURE: the pages are local and stable. That is the caveat on
 * every result in this file, and it is not hidden anywhere in the output.
 *
 * Usage: node scratch/verify_phase16_task_suite.mjs [taskKey ...]
 */

import fs from 'fs';
import path from 'path';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import {
  REPO_ROOT, PYTHON, sleep, cdpGet, openSession, serveStatic, startBackend,
  waitForBackend, launchChrome, readReasonerConfig,
} from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.P16_FIXTURE_PORT || 4200);
const DASHBOARD_PORT = Number(process.env.P16_DASHBOARD_PORT || 5175);
// The endpoint is hard-coded in the BUILT extension (backendAgentProvider.ts
// and agentBridge.ts both target 127.0.0.1:8010), so the backend must run on
// 8010. This is a build-time constant, not a configuration option.
const BACKEND_PORT = Number(process.env.P16_BACKEND_PORT || 8010);
const CDP_PORT = Number(process.env.P16_CDP_PORT || 9501);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const TASK_TIMEOUT_MS = Number(process.env.P16_TASK_TIMEOUT_MS || 150000);

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16');
const EVIDENCE = path.join(OUT_DIR, 'phase16_task_suite_evidence.json');
const BACKEND_LOG = path.join(OUT_DIR, 'phase16_backend_run.log');

/* ── The task suite ───────────────────────────────────────────────────────── */
/* markerSelector: read from the LIVE page after the run, never asserted into it. */
const TASKS = [
  {
    key: 'SEARCH', category: 'SEARCH', start: '/',
    task: `open ${ORIGIN} and search cats`,
    markerSelector: '#result-marker', expectMarker: 'Search results for cats',
  },
  {
    key: 'FORM_FILL', category: 'FORM_FILL', start: '/form',
    task: `open ${ORIGIN}/form and enter Alice into the name field`,
    markerSelector: '#form-state', expectMarker: 'EMPTY',
  },
  {
    key: 'MULTI_FIELD_FORM', category: 'MULTI_FIELD_FORM', start: '/multi',
    task: `open ${ORIGIN}/multi, enter Pune into the city field and India into the country field, then submit the form`,
    markerSelector: '#multi-marker', expectMarker: 'MULTI SUBMITTED',
  },
  {
    key: 'NAVIGATION', category: 'NAVIGATION', start: '/',
    task: `open ${ORIGIN} and navigate to the products page`,
    markerSelector: '#detail-marker', expectMarker: 'Product detail for Widget Basic',
  },
  {
    key: 'SCROLL', category: 'SCROLL', start: '/long',
    task: `open ${ORIGIN}/long and scroll down to the pricing section`,
    markerSelector: '#pricing-marker', expectMarker: 'PRICING SECTION',
  },
  {
    key: 'CLICK', category: 'CLICK', start: '/details',
    task: `open ${ORIGIN}/details and open the details section`,
    markerSelector: '#details-marker', expectMarker: 'DETAILS OPENED',
  },
  {
    key: 'MULTI_STEP', category: 'MULTI_STEP', start: '/',
    task: `open ${ORIGIN}, search cats, and open the first result`,
    markerSelector: '#detail-marker', expectMarker: 'Product detail for Widget Basic',
  },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const only = process.argv.slice(2);
  const suite = only.length ? TASKS.filter((t) => only.includes(t.key)) : TASKS;

  const evidence = {
    timestamp: new Date().toISOString(),
    work: 'Phase 16 real-reasoner task suite',
    substrate: 'REAL BROWSER + REAL BACKEND + REAL GROQ + PRODUCTION GATES',
    fixtureClass: 'DETERMINISTIC FIXTURE (local, stable pages) — generalisation to the open web is NOT demonstrated by this run',
    substitutionsUsed: 'NONE — no scripted proposer, no injected action, no asserted verdict',
    tasks: [],
  };

  const cfg = readReasonerConfig();
  evidence.reasonerConfig = cfg;
  console.log(`[P16] reasoner config: ${JSON.stringify(cfg)}`);
  if (cfg.mode !== 'groq' || cfg.apiKeyConfigured !== true) {
    evidence.result = { outcome: 'STOPPED', blocker: 'Groq is not the configured provider, or the key is absent' };
    fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
    throw new Error('reasoner preconditions not met — recorded, not worked around');
  }

  const fixture = await servePhase16Fixture(FIXTURE_PORT);
  const dash = await serveStatic(DASHBOARD_PORT, path.join(REPO_ROOT, 'frontend', 'dist'));
  const { proc: backend, fd } = startBackend(BACKEND_PORT, BACKEND_LOG);
  evidence.backendReachable = await waitForBackend(BACKEND_PORT);
  console.log(`[P16] backend reachable: ${evidence.backendReachable}`);

  const { proc: chrome, profile } = launchChrome(CDP_PORT);
  const sessions = [];

  try {
    for (let i = 0; i < 120; i++) { try { await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(250); } }
    const bs = await openSession((await cdpGet(CDP_PORT, '/json/version')).webSocketDebuggerUrl);
    const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    bs.close();
    evidence.extensionId = extensionId;

    // Attach to the real service worker so we can capture the EXACT reasoner
    // wire traffic — proof the actions came from the model, not from a script.
    const reasonerRequests = [];
    const swTarget = (await cdpGet(CDP_PORT, '/json/list')).find((t) => t.url && t.url.includes('serviceWorker.js'));
    if (swTarget?.webSocketDebuggerUrl) {
      const sw = await openSession(swTarget.webSocketDebuggerUrl);
      sessions.push(sw);
      await sw.send('Runtime.enable');
      await sw.send('Network.enable');
      sw.onEvent = (m) => {
        if (m.method === 'Network.requestWillBeSent' && /\/api\/v1\/agent\/action/.test(m.params.request.url || '')) {
          let p = null;
          try { p = JSON.parse(m.params.request.postData || 'null'); } catch {}
          const t0 = Date.now();
          reasonerRequests.push({
            at: t0,
            requestId: m.params.requestId,
            contextUrl: p?.context?.url ?? null,
            detectionCount: Array.isArray(p?.context?.detections) ? p.context.detections.length : null,
            detections: Array.isArray(p?.context?.detections) ? p.context.detections.map((d) => ({ id: d.id, type: d.type, selector: d.selector })) : null,
            historyLength: Array.isArray(p?.history) ? p.history.length : null,
            contextBytes: (m.params.request.postData || '').length,
          });
        }
        // Pair each reasoner request with its response to get REAL Groq latency.
        if (m.method === 'Network.responseReceived') {
          const hit = reasonerRequests.find((r) => r.requestId === m.params.requestId);
          if (hit && hit.respondedAtMs === undefined) {
            hit.respondedAtMs = Date.now();
            hit.reasonerLatencyMs = hit.respondedAtMs - hit.at;
            hit.status = m.params.response?.status;
          }
        }
      };
      evidence.serviceWorkerAttached = true;
    } else {
      evidence.serviceWorkerAttached = false;
    }

    const dashTarget = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`http://localhost:${DASHBOARD_PORT}/`)}`, 'PUT');
    const dashSession = await openSession(dashTarget.webSocketDebuggerUrl);
    sessions.push(dashSession);
    await dashSession.send('Page.enable');
    await dashSession.send('Runtime.enable');

    for (const spec of suite) {
      const rec = await runOneTask(spec, dashSession, reasonerRequests);
      evidence.tasks.push(rec);
      console.log(`[P16] ${spec.key.padEnd(16)} terminal=${String(rec.terminalStatus).padEnd(8)} goal=${String(rec.goalStatus).padEnd(12)} actions=${rec.actions.length} observed=${JSON.stringify(rec.observedMarker)}`);
      fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
    }

    evidence.reasonerRequestsTotal = reasonerRequests.length;
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { backend.kill('SIGKILL'); } catch {}
    try { fs.closeSync(fd); } catch {}
    try { dash.close(); } catch {}
    try { fixture.close(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
  console.log(`\n[P16] → ${path.relative(REPO_ROOT, EVIDENCE)}`);
}

async function runOneTask(spec, dashSession, reasonerRequests) {
  const rec = {
    key: spec.key, category: spec.category, task: spec.task,
    reasoner: 'REAL (groq)', fixture: 'DETERMINISTIC LOCAL FIXTURE',
    startedAt: new Date().toISOString(),
  };

  // A FRESH tab per task, opened at the task's start URL. The resolver refuses
  // to provision or hijack a port-qualified local target — that is containment,
  // not a workaround.
  const before = reasonerRequests.length;
  const tab = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${ORIGIN}${spec.start}`)}`, 'PUT');
  rec.startUrl = tab.url;
  await sleep(2200);

  // Reload the dashboard so no agent state leaks between tasks.
  await dashSession.send('Page.reload', { ignoreCache: true });
  await sleep(3000);

  await dashSession.evaluate(`
    window.__p16 = { payloads: [] };
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      if (!ev.data || ev.data.source !== 'privagent-extension') return;
      if (ev.data.type === 'TASK_PROGRESS') window.__p16.payloads.push(ev.data.payload);
    });
    true
  `);
  await sleep(300);

  const uiReady = await dashSession.evaluate(`!!document.getElementById('agent-task-input') && !!document.getElementById('agent-run-btn')`);
  rec.dashboardReady = uiReady;
  if (!uiReady) { rec.terminalStatus = 'HARNESS_ERROR'; rec.reason = 'dashboard controls not present'; return rec; }

  const t0 = Date.now();
  await dashSession.evaluate(`
    (() => {
      const i = document.getElementById('agent-task-input');
      i.value = ${JSON.stringify(spec.task)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('agent-run-btn').click();
      return true;
    })()
  `);

  const payloads = [];
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let confirmations = 0;
  let last = '[]';
  while (Date.now() < deadline) {
    last = await dashSession.evaluate(
      `JSON.stringify((window.__p16.payloads || []).map(p => ({
         status: p.status, reason: p.reason, goalStatus: p.goalStatus,
         currentStep: p.currentStep, currentUrl: p.currentUrl, targetTabId: p.targetTabId,
         phase: p.interaction && p.interaction.activity && p.interaction.activity.phase,
         steps: Array.isArray(p.steps) ? p.steps : []
       })))`
    );
    const arr = JSON.parse(last || '[]');
    if (arr.length) payloads.push(...arr);
    const tail = arr[arr.length - 1];
    if (tail && ['SUCCESS', 'FAILED', 'STOPPED'].includes(tail.status)) break;
    if (tail && tail.status === 'NEEDS_USER_CONFIRMATION') {
      const via = await dashSession.evaluate(
        `(() => { const a = document.getElementById('agent-confirm-allow'); if (a && !a.disabled) { a.click(); return true; } return false; })()`
      );
      if (via) confirmations++;
    }
    await sleep(1000);
  }
  rec.wallClockMs = Date.now() - t0;
  rec.confirmationPromptsAnswered = confirmations;

  // De-duplicate the step records the production loop emitted.
  const steps = [];
  const seen = new Set();
  for (const p of payloads) {
    for (const s of p.steps || []) {
      const k = `${s.step}|${s.action?.action}|${s.action?.target}|${s.effectStatus}`;
      if (seen.has(k)) continue;
      seen.add(k);
      steps.push({
        step: s.step,
        proposedAction: s.action ?? null,
        validationAllowed: s.validationAllowed,
        validationReason: s.validationReason ? String(s.validationReason).slice(0, 200) : null,
        executionSuccess: s.executionSuccess,
        effectStatus: s.effectStatus,
        effectDetails: s.effectDetails ? String(s.effectDetails).slice(0, 200) : null,
        targetType: s.targetType,
        url: s.url,
      });
    }
  }
  rec.actions = steps;
  rec.cycleCount = payloads.length ? Math.max(...payloads.map((p) => p.currentStep ?? 0)) + 1 : 0;

  const final = payloads[payloads.length - 1] || null;
  rec.terminalStatus = final?.status ?? 'NO_TERMINAL';
  rec.goalStatus = final?.goalStatus ?? null;
  rec.terminalReason = final?.reason ? String(final.reason).slice(0, 300) : null;
  rec.targetTabId = final?.targetTabId ?? null;
  rec.phaseTimeline = payloads.map((p) => ({
    status: p.status, goalStatus: p.goalStatus, step: p.currentStep, phase: p.phase, url: p.currentUrl,
  }));

  // Reasoner wire evidence for THIS task only.
  rec.reasonerRequests = reasonerRequests.slice(before).map((r) => ({
    contextUrl: r.contextUrl, detectionCount: r.detectionCount,
    detectionIds: (r.detections || []).map((d) => d.id), historyLength: r.historyLength,
    contextBytes: r.contextBytes,
    // REAL measured Groq round-trip, request -> response, on the wire.
    reasonerLatencyMs: r.reasonerLatencyMs ?? null,
    status: r.status ?? null,
  }));
  rec.reasonerLatency = rec.reasonerRequests.filter((r) => typeof r.reasonerLatencyMs === 'number').map((r) => r.reasonerLatencyMs);
  rec.reasonerProposedActions = (rec.reasonerRequests.length > 0) ? steps.map((s) => s.proposedAction?.action) : [];

  // OBSERVED state, read from the live tab. Never asserted into the agent.
  const tabs = await cdpGet(CDP_PORT, '/json/list');
  const target = tabs.find((t) => (t.url || '').includes(`localhost:${FIXTURE_PORT}`) && t.id === tab.id)
    || tabs.find((t) => (t.url || '').includes(`localhost:${FIXTURE_PORT}`));
  rec.observedUrl = target?.url || null;
  rec.observedTitle = target?.title || null;
  let marker = null;
  if (target) {
    const ts = await openSession(target.webSocketDebuggerUrl);
    try {
      await ts.send('Runtime.enable');
      marker = await ts.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(spec.markerSelector)}); return el ? el.textContent.trim() : null; })()`
      );
      rec.observedScrollY = await ts.evaluate('Math.round(window.scrollY)');
    } catch {} finally { ts.close(); }
  }
  rec.observedMarker = marker;
  rec.expectedMarker = spec.expectMarker;
  rec.markerMatched = marker === spec.expectMarker;

  rec.goalVerification = {
    verifier: 'verifyTaskGoal (extension/src/agent/goalVerifier.ts) — unmodified production code',
    agentReportedStatus: rec.terminalStatus,
    agentReportedGoalStatus: rec.goalStatus,
    agentReason: rec.terminalReason,
    observedMarkerMatched: rec.markerMatched,
    success: rec.terminalStatus === 'SUCCESS' && rec.goalStatus === 'SUCCESS',
  };

  try { await cdpGet(CDP_PORT, `/json/close/${tab.id}`); } catch {}
  return rec;
}

main().catch((e) => { console.error('[P16] harness error:', e.message); process.exit(2); });
