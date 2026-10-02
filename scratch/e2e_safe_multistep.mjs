/**
 * ONE focused real-browser end-to-end test of a SAFE multi-step task.
 *
 * Goal: does a normal safe action pass through the COMPLETE pipeline after
 * initial perception?
 *
 *   initial perception -> real Groq request -> returned action -> backend
 *   validation -> extension provider boundary -> Grounding -> M5 -> Security
 *   Critic -> Risk/Confirmation -> Containment -> dispatch -> real browser
 *   effect -> post-action perception -> Goal Verification
 *
 * Fixture: the REAL shopping demo (demo/shopping-fixture) on localhost:4174 —
 * the same port used by every prior audit. Task is deliberately safe: no
 * typing, no email/phone/card/password/OTP, no OCR dependency.
 *
 * REAL PROVIDER. No scripted proposer, no mocks. If the provider is
 * unavailable the run reports that instead of substituting anything.
 *
 * EVIDENCE POLICY: metadata only — action type, target id, gate verdicts,
 * dispatch, effect status, URLs. No raw values are read, logged or persisted.
 */
import fs from 'fs';
import path from 'path';

import {
  REPO_ROOT,
  sleep,
  cdpGet,
  openSession,
  launchChrome,
  attachServiceWorker,
} from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.ST_FIXTURE_PORT || 4174);
const CDP_PORT = Number(process.env.ST_CDP_PORT || 9701);
const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const TARGET_ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const TASK = process.env.ST_TASK || `open the store catalog at ${TARGET_ORIGIN}/results.html and open the first product listed`;

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'e2e-safe-multistep');
const OUT = path.join(OUT_DIR, process.env.ST_TAG ? `real_chrome_results_${process.env.ST_TAG}.json` : 'real_chrome_results.json');

const log = (...a) => console.log('[E2E]', ...a);

async function waitForCdp(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { return await cdpGet(port, '/json/version'); } catch {}
    await sleep(500);
  }
  throw new Error(`chrome CDP never became ready on ${port}`);
}

async function httpOk(port, p = '/') {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: res.status, length: (await res.text()).length };
  } catch (e) { return { status: 0, length: 0, error: String(e) }; }
}

/** Deep-render console object args so gate telemetry is observable. */
function deepConsoleCapture(session) {
  session.deepLogs = [];
  const orig = session.ws.onmessage;
  session.ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const parts = (m.params.args || []).map((a) => {
          if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
          if (a.preview && Array.isArray(a.preview.properties)) {
            const o = {};
            for (const p of a.preview.properties) o[p.name] = p.value;
            return JSON.stringify(o);
          }
          return a.description || a.type || '';
        });
        session.deepLogs.push(parts.join(' '));
      }
    } catch {}
    return orig.call(session.ws, ev);
  };
  return session;
}

const out = {
  timestamp: new Date().toISOString(),
  work: 'Safe multi-step end-to-end through the complete agent pipeline',
  evidencePolicy: 'Metadata, gate verdicts and URLs only. No raw values are read, logged or persisted.',
  inputs: { dashboardOrigin: DASHBOARD_ORIGIN, targetOrigin: TARGET_ORIGIN, task: TASK, reasoner: 'REAL (groq)' },
  environment: {},
  boundaries: {},
  provider: {},
  steps: [],
  goalVerification: {},
  outcome: {},
};

let chrome = null, page = null, sw = null, bs = null;

try {
  // ── Preconditions: real fixture, real dashboard, real backend ─────────────
  const fixture = await httpOk(FIXTURE_PORT);
  const catalog = await httpOk(FIXTURE_PORT, '/results.html');
  const dash = await httpOk(DASHBOARD_PORT);
  let backend = { status: 0 };
  try {
    const r = await fetch('http://127.0.0.1:8010/api/v1/health');
    backend = { status: r.status, reasoner: (await r.json()).reasoner };
  } catch (e) { backend = { status: 0, error: String(e) }; }
  out.environment = {
    fixtureRoot: fixture.status, fixtureCatalog: catalog.status,
    dashboard: dash.status, backend: backend.status,
    reasoner: backend.reasoner ?? null,
  };
  log('fixture', fixture.status, '| catalog', catalog.status, '| dashboard', dash.status, '| backend', backend.status, backend.reasoner ?? '');
  if (fixture.status !== 200 || catalog.status !== 200) throw new Error('shopping fixture not serving on ' + FIXTURE_PORT);
  if (dash.status !== 200) throw new Error('dashboard not serving on ' + DASHBOARD_PORT);
  if (backend.status !== 200) throw new Error('backend not reachable on 8010');

  // ── Real Chrome + real built extension ────────────────────────────────────
  chrome = launchChrome(CDP_PORT);
  const version = await waitForCdp(CDP_PORT);
  out.environment.chromeVersion = version['Browser'] || 'unknown';
  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  out.environment.extensionLoaded = Boolean(extensionId);

  // Open ONLY the dashboard; the 4174 target is provisioned by the agent.
  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(DASHBOARD_ORIGIN + '/')}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(3000);

  // Collect EVERY progress envelope, extracting per-step gate metadata.
  await page.evaluate(`(() => {
    window.__p = [];
    const pick = (s) => ({
      status: s.status, goalStatus: s.goalStatus ?? null,
      currentStep: s.currentStep, maxSteps: s.maxSteps,
      currentUrl: s.currentUrl ?? null, targetTabId: s.targetTabId ?? null,
      reason: typeof s.reason === 'string' ? s.reason.slice(0, 200) : null,
      stepCount: Array.isArray(s.steps) ? s.steps.length : 0,
      steps: (s.steps || []).map(st => ({
        step: st.step,
        actionType: st.action?.type ?? st.action?.action ?? null,
        targetId: st.targetId ?? null,
        targetType: st.targetType ?? null,
        m5Allowed: st.validationAllowed,
        m5Reason: typeof st.validationReason === 'string' ? st.validationReason.slice(0, 160) : null,
        dispatched: st.executionSuccess === true,
        executionError: typeof st.executionError === 'string' ? st.executionError.slice(0, 160) : null,
        observedUrl: st.url ?? null,
        navigationIntent: st.navigationDestination ?? null,
        effectVerified: st.effectVerified ?? null,
        effectStatus: st.effectStatus ?? null,
        perceptionGeneration: st.perceptionGeneration ?? null,
        riskLevel: st.riskAssessment?.riskLevel ?? null,
        requiresConfirmation: st.riskAssessment?.requiresConfirmation ?? null,
        semanticVerified: st.semanticVerification?.verified ?? null,
      })),
      // Sanitized perception evidence: page identity + affordances/candidates.
      // Labels and types only — this reads no raw values.
      affordances: (() => {
        const last = (s.steps || [])[s.steps.length - 1];
        const sc = last?.semanticContext;
        if (!sc) return null;
        return {
          pageType: sc.pageType ?? null,
          pageState: sc.pageState ?? null,
          affordanceCount: Array.isArray(sc.affordances) ? sc.affordances.length : 0,
          affordanceTypes: Array.isArray(sc.affordances)
            ? [...new Set(sc.affordances.map((a) => a.type))].sort() : [],
          affordanceDescriptions: Array.isArray(sc.affordances)
            ? sc.affordances.slice(0, 12).map((a) => a.description) : [],
          entityLabels: Array.isArray(sc.entities) ? sc.entities.slice(0, 12).map((e) => e.label) : [],
        };
      })(),
      activeSubgoal: s.activeSubgoal
        ? { category: s.activeSubgoal.category, description: s.activeSubgoal.description }
        : null,
      trace: (s.decisionTraceSummary?.steps || []).map(t => ({
        step: t.step,
        action: t.proposedAction?.action ?? t.proposedAction?.type ?? null,
        structuralPassed: t.structuralValidation?.passed ?? null,
        semanticVerified: t.semanticVerification?.verified ?? null,
        confidenceDirective: t.confidenceEvaluation?.directive ?? null,
        finalOutcome: t.finalOutcome ?? null,
      })),
    });
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.source === 'privagent-extension' && d.type === 'TASK_PROGRESS' && d.payload) {
        window.__p.push(pick(d.payload));
      }
    });
    return true;
  })()`);

  sw = deepConsoleCapture(await attachServiceWorker(CDP_PORT));
  if (!sw) throw new Error('service worker not attached');
  await sw.send('Runtime.enable');
  await sleep(500);

  out.boundaries.tabsBefore = await sw.evaluate(`(async () => {
    const t = await chrome.tabs.query({});
    return t.map(x => { let o=null; try { o = new URL(x.url||x.pendingUrl||'').origin; } catch {}
      return { id: x.id, origin: o }; });
  })()`);
  out.boundaries.dashboardTabId = out.boundaries.tabsBefore.find((t) => t.origin === DASHBOARD_ORIGIN)?.id ?? null;
  out.boundaries.targetTabOpenBefore = out.boundaries.tabsBefore.some((t) => t.origin === TARGET_ORIGIN);
  log('dashboard tab', out.boundaries.dashboardTabId, '| 4174 already open?', out.boundaries.targetTabOpenBefore);

  const mark = sw.deepLogs.length;

  // ── Dispatch the real START_TASK through the real path ────────────────────
  await page.evaluate(`(() => {
    window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: ${JSON.stringify(TASK)} }, '*');
    return true;
  })()`);
  log('START_TASK dispatched:', TASK);

  // ── Run until terminal (bounded) ──────────────────────────────────────────
  let lastCount = -1;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const env = JSON.parse(await page.evaluate('JSON.stringify(window.__p)'));
    if (env.length !== lastCount) {
      lastCount = env.length;
      const cur = env[env.length - 1];
      log(`  progress #${env.length}: status=${cur.status} step=${cur.currentStep} url=${cur.currentUrl} steps=${cur.stepCount}`);
    }
    const last = env[env.length - 1];
    if (last && ['SUCCESS', 'FAILED', 'STOPPED'].includes(last.status) && last.stepCount > 0) break;
  }
  await sleep(2000);

  // ── Post-run tab state ────────────────────────────────────────────────────
  out.boundaries.tabsAfter = await sw.evaluate(`(async () => {
    const t = await chrome.tabs.query({});
    return t.map(x => { let o=null,u=null; try { const q=new URL(x.url||x.pendingUrl||''); o=q.origin; u=q.pathname; } catch {}
      return { id: x.id, origin: o, pathname: u, active: !!x.active }; });
  })()`);
  out.boundaries.targetTabId = out.boundaries.tabsAfter.find((t) => t.origin === TARGET_ORIGIN)?.id ?? null;
  out.boundaries.finalTargetPathname = out.boundaries.tabsAfter.find((t) => t.id === out.boundaries.targetTabId)?.pathname ?? null;

  // ── Consolidated per-step record (last envelope wins per step) ────────────
  const envs = JSON.parse(await page.evaluate('JSON.stringify(window.__p)'));
  out.outcome.envelopeCount = envs.length;
  out.outcome.envelopeStatuses = envs.map((e) => `${e.status}@${e.currentStep}`);
  out.outcome.finalStatus = envs.length ? envs[envs.length - 1].status : null;
  out.outcome.finalGoalStatus = envs.length ? envs[envs.length - 1].goalStatus : null;
  out.outcome.finalReason = envs.length ? envs[envs.length - 1].reason : null;
  out.outcome.finalUrl = envs.length ? envs[envs.length - 1].currentUrl : null;

  const final = envs[envs.length - 1] || { steps: [], trace: [] };
  out.steps = final.steps;
  out.goalVerification = {
    trace: final.trace,
    goalStatus: final.goalStatus ?? null,
    stepOutcomes: final.trace.map((t) => `${t.step}:${t.finalOutcome}`),
  };

  // ── Provider + gate telemetry from the service worker console ─────────────
  const lines = sw.deepLogs.slice(mark);
  out.provider = {
    calls: lines.filter((l) => l.includes('requesting reasoning')).length,
    responsesReceived: lines.filter((l) => l.includes('reasoning response received')).length,
    m5Passed: lines.filter((l) => l.includes('action validated by M5')).length,
    dispatches: lines.filter((l) => l.includes('executeAction started')).length,
    dispatchesCompleted: lines.filter((l) => l.includes('executeAction response received')).length,
    criticRuns: lines.filter((l) => l.includes('security critic')).length,
    containmentDenied: lines.filter((l) => /containment.{0,40}(denied|refus)/i.test(l)).length,
    perceptionCycles: lines.filter((l) => l.includes('perception complete')).length,
    trace: lines.filter(
      (l) =>
        l.includes('AgentTrace') ||
        l.includes('TARGET_') ||
        l.includes('subgoal') ||
        l.includes('goal verified') ||
        l.includes('Goal verif')
    ).slice(0, 160),
  };

  out.verdict =
    out.provider.calls > 0 &&
    out.steps.some((s) => s.dispatched) &&
    out.outcome.finalStatus === 'SUCCESS'
      ? 'SUCCESS'
      : out.outcome.finalStatus === 'FAILED'
        ? 'FAILED'
        : 'INCONCLUSIVE';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  log('verdict:', out.verdict, '| wrote', OUT);
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
  out.verdict = 'ERROR';
  console.error('[E2E] ERROR', out.error);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  for (const s of [page, sw, bs]) { try { s?.close(); } catch {} }
  try { chrome?.kill?.(); } catch {}
}
