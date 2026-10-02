/**
 * START_TASK LOCALHOST-PORT REGRESSION — REAL CHROME DIAGNOSTIC.
 *
 * Reproduces the exact reported production scenario in real Chrome:
 *
 *   Dashboard  http://localhost:5173   (the real vite dev server)
 *   Target     http://localhost:4174   (intentionally NOT open at START_TASK)
 *
 *   START_TASK received -> status FAILED / currentStep 0 / hasInteraction false
 *   -> TERMINAL FAILED, Step Budget 0/10, Target Tab: --
 *
 * Real Chrome (CDP), real built MV3 extension, real content script, real
 * service worker, real resolveTargetWebTab() / provisionTargetTab() /
 * establishContainmentScope() / AgentLoop. Nothing in the target path is
 * stubbed. The reasoner may legitimately be unavailable; the FIRST objective
 * is only that START_TASK reaches INITIAL AGENTLOOP PERCEPTION.
 *
 * EVIDENCE POLICY: metadata, booleans and counts only.
 */
import fs from 'fs';
import path from 'path';

import { serveTargetFixture } from './starttask_fixture.mjs';
import {
  REPO_ROOT,
  sleep,
  cdpGet,
  openSession,
  launchChrome,
  attachServiceWorker,
} from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.ST_FIXTURE_PORT || 4174);
const CDP_PORT = Number(process.env.ST_CDP_PORT || 9681);
const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const TARGET_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'start-task-localhost-port');
const OUT = path.join(OUT_DIR, 'real_chrome_results.json');
void OUT;

const TASK = `open ${TARGET_ORIGIN} and fill the contact form`;
// Optional: an UNRELATED tab opened before START_TASK. Proves the resolver
// provisions 4174 rather than hijacking whatever web tab happens to be open.
const UNRELATED_PORT = Number(process.env.ST_UNRELATED_PORT || 0);
const UNRELATED_ORIGIN = UNRELATED_PORT ? `http://localhost:${UNRELATED_PORT}` : null;
const TAG = process.env.ST_TAG || 'POSTFIX';

const log = (...a) => console.log('[ST]', ...a);

async function waitForCdp(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      return await cdpGet(port, '/json/version');
    } catch {}
    await sleep(500);
  }
  throw new Error(`chrome CDP never became ready on ${port}`);
}

async function httpOk(port, p = '/') {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    const body = await res.text();
    return { status: res.status, length: body.length };
  } catch (e) {
    return { status: 0, length: 0, error: String(e) };
  }
}

/**
 * The bundled service worker is a module, so `activeLoop` is not reachable from
 * the worker's global scope. Its telemetry is emitted as console.info instead;
 * this wrapper deep-renders object arguments so containment rootHost / tabId and
 * the AgentTrace markers are all observable.
 */
function deepConsoleCapture(session) {
  session.deepLogs = [];
  const orig = session.ws.onmessage;
  session.ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const parts = (m.params.args || []).map((a) => {
          if (a.value !== undefined) {
            return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
          }
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
  work: 'START_TASK localhost-port target resolution — real Chrome diagnostic',
  tag: TAG,
  evidencePolicy: 'Metadata, booleans and counts only. No page content or PII values are recorded.',
  environment: { realChrome: true, stubbedTargetPath: false, reasonerInvoked: null },
  inputs: {
    dashboardOrigin: DASHBOARD_ORIGIN,
    requestedTargetOrigin: TARGET_ORIGIN,
    unrelatedTabOrigin: UNRELATED_ORIGIN,
    task: TASK,
    targetTabOpenBeforeStartTask: false,
  },
  boundaries: {},
  perception: {},
  outcome: {},
};

let server = null;
let unrelatedServer = null;
let chrome = null;
let page = null;
let sw = null;
let bs = null;

try {
  // ── Boundary 0: both origins live, on DISTINCT ports ──────────────────────
  server = await serveTargetFixture(FIXTURE_PORT);
  if (UNRELATED_PORT) {
    unrelatedServer = await serveTargetFixture(UNRELATED_PORT);
    out.boundaries.unrelatedFixtureServed = await httpOk(UNRELATED_PORT);
  }
  const dashProbe = await httpOk(DASHBOARD_PORT);
  const targetProbe = await httpOk(FIXTURE_PORT);
  out.boundaries.dashboardServed = { status: dashProbe.status, ok: dashProbe.status === 200 };
  out.boundaries.targetFixtureServed = { status: targetProbe.status, ok: targetProbe.status === 200 };
  log('dashboard', dashProbe.status, '| target fixture', targetProbe.status);
  if (dashProbe.status !== 200) throw new Error('dashboard dev server is not serving on ' + DASHBOARD_PORT);

  // ── Real Chrome + the real built extension ────────────────────────────────
  chrome = launchChrome(CDP_PORT);
  const version = await waitForCdp(CDP_PORT);
  out.environment.chromeVersion = version['Browser'] || 'unknown';
  const browserWsId = version.webSocketDebuggerUrl.split('/').pop();
  bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${browserWsId}`);
  const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  out.environment.extensionLoaded = Boolean(extensionId);
  log('chrome', out.environment.chromeVersion, '| extension', extensionId);

  // ── Open ONLY the dashboard. The 4174 target is deliberately NOT open. ────
  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(DASHBOARD_ORIGIN + '/')}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(3000);
  out.boundaries.dashboardTabUrl = await page.evaluate('location.href');

  // Open the unrelated web tab BEFORE the task, if requested.
  if (UNRELATED_ORIGIN) {
    const extra = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(UNRELATED_ORIGIN + '/')}`, 'PUT');
    const extraSession = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${extra.id}`);
    await extraSession.send('Page.enable');
    await extraSession.send('Page.navigate', { url: `${UNRELATED_ORIGIN}/` });
    await sleep(1500);
    out.boundaries.unrelatedTabUrl = await extraSession.evaluate('location.href');
    extraSession.close();
    log('unrelated tab opened at', out.boundaries.unrelatedTabUrl);
  }

  // Capture every TASK_PROGRESS envelope the extension posts to the dashboard.
  await page.evaluate(`(() => {
    window.__stProgress = [];
    window.addEventListener('message', (e) => {
      if (e.data && e.data.source === 'privagent-extension' && e.data.type === 'TASK_PROGRESS') {
        const p = e.data.payload || {};
        window.__stProgress.push({
          status: p.status,
          currentStep: p.currentStep,
          maxSteps: p.maxSteps,
          stepCount: Array.isArray(p.steps) ? p.steps.length : null,
          targetTabId: p.targetTabId ?? null,
          currentUrl: p.currentUrl ?? null,
          reason: typeof p.reason === 'string' ? p.reason.slice(0, 240) : null,
          hasInteraction: Boolean(p.interaction),
        });
      }
    });
    return true;
  })()`);

  // ── Service worker: tab inventory BEFORE the task ─────────────────────────
  sw = deepConsoleCapture(await attachServiceWorker(CDP_PORT));
  if (!sw) throw new Error('service worker not attached');
  await sw.send('Runtime.enable');
  await sleep(500);

  out.boundaries.tabsBeforeStartTask = await sw.evaluate(`(async () => {
    const t = await chrome.tabs.query({});
    return t.map(x => {
      let origin = null, port = null;
      try { const u = new URL(x.url || x.pendingUrl || ''); origin = u.origin; port = u.port; } catch {}
      return { id: x.id, origin, port };
    });
  })()`);
  const dashEntry = out.boundaries.tabsBeforeStartTask.find((t) => t.origin === DASHBOARD_ORIGIN);
  out.boundaries.dashboardTabId = dashEntry ? dashEntry.id : null;
  out.boundaries.targetTabOpenBeforeStartTask = out.boundaries.tabsBeforeStartTask.some(
    (t) => t.origin === TARGET_ORIGIN
  );
  log('dashboard tab', out.boundaries.dashboardTabId, '| 4174 already open?', out.boundaries.targetTabOpenBeforeStartTask);

  const mark = sw.deepLogs.length;

  // ── Dispatch START_TASK through the REAL dashboard -> content script path ─
  // (exactly the envelope frontend/src/adapters/extensionAdapter.ts posts)
  await page.evaluate(`(() => {
    window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: ${JSON.stringify(
      TASK
    )} }, '*');
    return true;
  })()`);
  log('START_TASK dispatched from the dashboard page');

  // ── Wait for provisioning + first perception ──────────────────────────────
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const arr = JSON.parse(await page.evaluate('JSON.stringify(window.__stProgress || [])'));
    const terminal = arr.filter((x) => x.status === 'FAILED' || x.status === 'SUCCESS' || x.status === 'PAUSED');
    if (terminal.length >= 1 && arr.length >= 2) break;
    if (sw.deepLogs.slice(mark).some((l) => l.includes('agent loop started'))) break;
  }
  await sleep(2500);

  // ── Service worker: tab inventory AFTER the task ──────────────────────────
  out.boundaries.tabsAfterStartTask = await sw.evaluate(`(async () => {
    const t = await chrome.tabs.query({});
    return t.map(x => {
      let origin = null; try { origin = new URL(x.url || x.pendingUrl || '').origin; } catch {}
      return { id: x.id, origin, active: !!x.active, status: x.status };
    });
  })()`);
  const targetEntry = out.boundaries.tabsAfterStartTask.find((t) => t.origin === TARGET_ORIGIN);
  out.boundaries.targetTabId = targetEntry ? targetEntry.id : null;
  out.boundaries.resolvedTargetUrl = targetEntry ? targetEntry.origin : null;
  out.boundaries.dashboardTabStillOnDashboard = Boolean(
    out.boundaries.tabsAfterStartTask.find((t) => t.id === out.boundaries.dashboardTabId)?.origin === DASHBOARD_ORIGIN
  );
  out.boundaries.noArbitraryTabSelected = !out.boundaries.tabsAfterStartTask.some(
    (t) => t.origin && t.origin !== DASHBOARD_ORIGIN && t.origin !== TARGET_ORIGIN && !UNRELATED_ORIGIN && /^https?:/.test(t.origin)
  );
  if (UNRELATED_ORIGIN) {
    // The unrelated tab must still exist, still be on its own origin, and must
    // NOT be the pinned target.
    out.boundaries.unrelatedTabNotHijacked =
      out.boundaries.targetTabId !== (out.boundaries.tabsAfterStartTask.find((t) => t.origin === UNRELATED_ORIGIN)?.id ?? -1) &&
      Boolean(out.boundaries.tabsAfterStartTask.find((t) => t.origin === UNRELATED_ORIGIN));
  }
  log('target tab', out.boundaries.targetTabId, '| resolved', out.boundaries.resolvedTargetUrl);

  // ── Service-worker telemetry for the target/containment/loop boundaries ───
  const swLines = sw.deepLogs.slice(mark);
  const findLine = (needle) => swLines.find((l) => l.includes(needle)) || null;
  const parseObj = (line) => {
    const m = line && line.match(/(\{.*\})\s*$/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };

  out.boundaries.resolver = {
    started: Boolean(findLine('TARGET_RESOLUTION_STARTED')),
    candidates: findLine('TARGET_TAB_CANDIDATES'),
    failureLine: findLine('TARGET_TAB_FAILED'),
    selected: findLine('TARGET_TAB_SELECTED'),
    provisioned: findLine('TARGET_TAB_PROVISIONED'),
    ready: findLine('TARGET_TAB_READY'),
  };
  out.boundaries.containment = {
    logged: Boolean(findLine('containment scope established')),
    ...(parseObj(findLine('containment scope established')) || {}),
  };
  out.boundaries.agentLoop = {
    constructed: swLines.some((l) => l.includes('agent loop started')),
    perceptionEntered: swLines.some((l) => l.includes('perception started')),
    targetResolvedMarker: Boolean(findLine('AgentTrace] target resolved')),
    contentScriptReadyMarker: Boolean(findLine('target content script ready')),
  };

  // ── Initial perception, read from the LIVE target tab ─────────────────────
  if (out.boundaries.targetTabId != null) {
    const scan = await sw.evaluate(`(async () => {
      try { return await chrome.tabs.sendMessage(${out.boundaries.targetTabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }); }
      catch (e) { return { error: String(e) }; }
    })()`);
    const wm = scan?.worldModel;
    const cands = Array.isArray(wm?.candidates) ? wm.candidates : [];
    // The AUTHORITATIVE initial-perception generation is the one the AgentLoop
    // itself reported, taken from its own `perception complete` trace line. The
    // numbers below come from a post-run re-scan driven by this harness, so the
    // world model has already advanced past generation 1.
    const loopPerceptionLine = findLine('[AgentTrace] perception complete');
    const genMatch = loopPerceptionLine && loopPerceptionLine.match(/"perceptionGeneration":"(\d+)"/);
    out.perception = {
      scanSucceeded: Boolean(scan?.report),
      totalElementsScanned: scan?.report?.totalElementsScanned ?? null,
      sensitiveElementsDetected: scan?.report?.sensitiveElementsDetected ?? null,
      worldModelPresent: Boolean(wm),
      agentLoopInitialPerceptionGeneration: genMatch ? Number(genMatch[1]) : null,
      agentLoopPerceptionLine: loopPerceptionLine,
      postRunRescanGeneration: wm?.page?.pageGeneration ?? null,
      candidateCount: cands.length,
      protectedCount: cands.filter(
        (c) => c && (c.sanitizedPreview === 'Protected Text' || c.protected === true || c.isProtected === true)
      ).length,
      semanticPresent: Boolean(scan?.semanticUnderstanding),
    };
    log('perception:', JSON.stringify(out.perception));
  }

  // ── Progress envelopes: the step-0 FAILED signature ───────────────────────
  const progress = JSON.parse(await page.evaluate('JSON.stringify(window.__stProgress || [])'));
  out.outcome.progressEnvelopes = progress;
  out.outcome.envelopeCount = progress.length;
  out.outcome.firstEnvelopeStatus = progress[0]?.status ?? null;
  out.outcome.firstEnvelopeCurrentStep = progress[0]?.currentStep ?? null;
  out.outcome.firstEnvelopeStepCount = progress[0]?.stepCount ?? null;
  out.outcome.anyStep0TerminalFailed = progress.some(
    (p) => p.status === 'FAILED' && p.currentStep === 0 && p.stepCount === 0
  );
  out.outcome.reachedStepOne = progress.some((p) => (p.currentStep ?? 0) >= 1);
  out.outcome.finalStatus = progress.length ? progress[progress.length - 1].status : null;
  out.outcome.finalReason = progress.length ? progress[progress.length - 1].reason : null;
  out.outcome.reportedTargetTabId = progress.find((p) => p.targetTabId != null)?.targetTabId ?? null;

  out.environment.reasonerInvoked = swLines.some((l) => l.includes('requesting reasoning'));
  out.outcome.reasonerReached = out.environment.reasonerInvoked;
  out.outcome.actionDispatched = swLines.some((l) => l.includes('executeAction started'));
  out.outcome.agentTraceLines = swLines.filter((l) => l.includes('AgentTrace') || l.includes('TARGET_')).slice(0, 60);

  out.verdict =
    out.boundaries.targetTabId != null &&
    out.boundaries.containment.logged === true &&
    out.boundaries.agentLoop.constructed === true &&
    out.perception.agentLoopInitialPerceptionGeneration != null &&
    out.outcome.anyStep0TerminalFailed === false
      ? 'REACHED_INITIAL_PERCEPTION'
      : 'NOT_PROVEN';

  if (UNRELATED_ORIGIN && out.boundaries.unrelatedTabNotHijacked !== true) {
    out.verdict = 'HIJACKED_UNRELATED_TAB';
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  log('verdict:', out.verdict);
  log('wrote', OUT);
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
  out.verdict = 'NOT_PROVEN';
  console.error('[ST] ERROR', out.error);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  for (const s of [page, sw, bs]) { try { s?.close(); } catch {} }
  try { chrome?.kill?.(); } catch {}
  server?.close();
  unrelatedServer?.close();
}
