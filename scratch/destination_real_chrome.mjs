/**
 * STEP 5 — Real Chrome destination-verification capture.
 *
 * Drives the PRODUCTION extension against the REAL shopping fixture and records
 * the observation the production path actually produces: current URL, page
 * generation, semantic page type and semantic confidence.
 *
 * Nothing here decides a verdict. The real `normalizeDestination` and real
 * `verifyDestination` are executed afterwards, in
 * `scratch/destination_verify_real.probe.test.ts`, against the observation this
 * file captures. The verifier is not wired into the bundle, so it cannot be
 * invoked from inside the browser; the OBSERVATION is real browser output and
 * that distinction is recorded in the evidence file rather than blurred.
 *
 * Evidence policy: metadata only — URL, page type, confidence, generation,
 * counts. No page text, no element labels, no values.
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
const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const CDP_PORT = Number(process.env.ST_CDP_PORT || 9740);
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const TARGET_ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const TASK = process.env.ST_TASK || `open the store catalog at ${TARGET_ORIGIN}`;

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-9', 'destination-verifier');
const OUT = path.join(OUT_DIR, 'real_observation.json');
const log = (...a) => console.log('[DEST]', ...a);

/** Capture every console object argument the SW emits, deep-rendered. */
function captureSwConsole(sw) {
  sw.deepLogs = [];
  const orig = sw.ws.onmessage;
  sw.ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const parts = (m.params.args || []).map((a) => {
          if (a.value !== undefined) {
            return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
          }
          if (a.description) return a.description;
          return a.preview ? JSON.stringify(a.preview.properties?.map((p) => `${p.name}:${p.value}`) ?? {}) : a.type;
        });
        sw.deepLogs.push(parts.join(' '));
      }
    } catch {
      /* ignore non-JSON frames */
    }
    orig.call(sw.ws, ev);
  };
}

/** The REAL production observation for a tab, produced by the shipped content script. */
async function captureObservation(sw, tabId, label) {
  const expr = `(async () => {
    try {
      const res = await chrome.tabs.sendMessage(${tabId}, { type: 'PRIVAGENT_SCAN_REQUEST' });
      if (!res || res.type !== 'PRIVAGENT_SCAN_RESPONSE') return { ok: false, reason: 'no scan response' };
      const sc = res.semanticContext || null;
      const wm = res.worldModel || null;
      return {
        ok: true,
        url: wm?.page?.url ?? null,
        worldModelOrigin: wm?.page?.origin ?? null,
        worldModelTitle: null,
        worldModelPageType: wm?.page?.pageType ?? null,
        worldModelPageGeneration: wm?.page?.pageGeneration ?? null,
        semanticPageType: sc?.pageType ?? null,
        semanticConfidence: sc?.confidence ?? null,
        semanticPageState: sc?.pageState ?? null,
        semanticPageGeneration: sc?.pageGeneration ?? null,
        entityCount: Array.isArray(sc?.entities) ? sc.entities.length : null,
        affordanceTypes: Array.isArray(sc?.affordances) ? sc.affordances.map(a => a.type) : null,
        workflow: sc?.workflow ?? null,
        totalElementsScanned: res.report?.totalElementsScanned ?? null,
        sensitiveDetected: res.report?.sensitiveElementsDetected ?? null,
      };
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 200) };
    }
  })()`;
  const raw = await sw.evaluate(expr);
  // `Session.evaluate` already resolves promises and returns values, so this
  // may be an object (returnByValue) or a string (JSON.stringify'd).
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { label, capturedAt: new Date().toISOString(), ...parsed };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    work: 'POST-17.10 step 5 — real Chrome capture of the production destination observation',
    evidencePolicy:
      'Metadata only: URL, semantic page type, confidence, page generation, counts. ' +
      'No page text, no element labels, no values, no model output is recorded.',
    inputs: { task: TASK, dashboardOrigin: DASHBOARD_ORIGIN, targetOrigin: TARGET_ORIGIN },
    environment: {},
    boundaries: {},
    observations: [],
    agentRun: {},
    limitations: [],
  };

  const chrome = launchChrome(CDP_PORT);
  let bs, page, sw;
  try {
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
    }
    if (!version) throw new Error('chrome CDP never became ready');
    out.environment.chromeVersion = version.Browser || 'unknown';

    const bsId = version.webSocketDebuggerUrl.split('/').pop();
    bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
    const loadResult = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    out.environment.extensionLoaded = true;
    out.environment.extensionLoadResult = JSON.stringify(loadResult).slice(0, 200);
    log('extension loaded');

    // Open ONLY the dashboard. The target tab is provisioned by production code.
    const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
    page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
    await sleep(3500);

    await page.evaluate(`(() => { window.__p = []; return true; })()`);

    sw = await attachServiceWorker(CDP_PORT);
    if (!sw) throw new Error('service worker not found');
    captureSwConsole(sw);
    const mark = sw.deepLogs.length;

    // ── Drive the real production path ──────────────────────────────────────
    log('START_TASK:', TASK);
    await page.evaluate(`(() => {
      window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: ${JSON.stringify(TASK)} }, '*');
      return true;
    })()`);

    // ── Wait for the production target resolver to provision the tab ───────
    let targetTabId = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const raw = await sw.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find(x => (x.url || x.pendingUrl || '').startsWith('${TARGET_ORIGIN}'));
        return JSON.stringify(t ? { id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status } : null);
      })()`);
      const t = JSON.parse(raw);
      if (t) { targetTabId = t.id; out.boundaries.targetTab = t; break; }
    }
    if (!targetTabId) throw new Error('production path never provisioned a target tab');
    log('target tab provisioned', targetTabId, out.boundaries.targetTab.url);

    out.boundaries.dashboardTabId = created.id;
    out.boundaries.targetTabId = targetTabId;

    // Let perception settle on whatever the agent actually reached.
    await sleep(4000);

    // ── Observation 1: the page the agent actually reached ─────────────────
    const observed = await captureObservation(sw, targetTabId, 'agent-reached-page');
    out.observations.push(observed);
    log('obs1', JSON.stringify({ url: observed.url, pageType: observed.semanticPageType, conf: observed.semanticConfidence, gen: observed.semanticPageGeneration }));

    // ── Observation 2: the catalog, reached by a real browser navigation ───
    await sw.evaluate(`(async () => { await chrome.tabs.update(${targetTabId}, { url: '${TARGET_ORIGIN}/results.html' }); return true; })()`);
    await sleep(3000);
    const catalog = await captureObservation(sw, targetTabId, 'catalog-results-html');
    out.observations.push(catalog);
    log('obs2', JSON.stringify({ url: catalog.url, pageType: catalog.semanticPageType, conf: catalog.semanticConfidence, gen: catalog.semanticPageGeneration }));

    // ── Observation 3: a different document, for the staleness control ─────
    await sw.evaluate(`(async () => { await chrome.tabs.update(${targetTabId}, { url: '${TARGET_ORIGIN}/product.html' }); return true; })()`);
    await sleep(3000);
    const product = await captureObservation(sw, targetTabId, 'product-html');
    out.observations.push(product);
    log('obs3', JSON.stringify({ url: product.url, pageType: product.semanticPageType, conf: product.semanticConfidence, gen: product.semanticPageGeneration }));

    // ── Agent-run telemetry, metadata only ─────────────────────────────────
    const envelope = await page.evaluate('JSON.stringify((window.__p||[]).slice(-1)[0] || null)');
    out.agentRun.lastEnvelope = JSON.parse(envelope);
    const swLines = sw.deepLogs.slice(mark);
    out.agentRun.semanticCompletions = swLines
      .filter((l) => l.includes('semantic understanding complete'))
      .map((l) => l.replace(/^.*semantic understanding complete\s*/, '').slice(0, 300));
    out.agentRun.trace = swLines
      .filter(
        (l) =>
          l.includes('AgentTrace') ||
          l.includes('TARGET_') ||
          l.includes('subgoal') ||
          l.includes('perception complete')
      )
      .slice(0, 80);
    out.agentRun.providerCalls = swLines.filter((l) => l.includes('requesting reasoning')).length;

    out.limitations.push(
      'The destination verifier is NOT wired into the extension bundle, so it could not be invoked from inside the browser. ' +
        'The OBSERVATION recorded here is real production browser output; the verdict is computed afterwards by executing the ' +
        'real production verifyDestination() in Node against that captured observation. This is a scope consequence of Step 4 ' +
        '("producers remain unwired"), not a fabrication.',
    );
  } catch (e) {
    out.error = String(e && e.message ? e.message : e).slice(0, 500);
    log('ERROR', out.error);
  } finally {
    try { sw?.close?.(); } catch { /* ignore */ }
    try { page?.close?.(); } catch { /* ignore */ }
    try { bs?.close?.(); } catch { /* ignore */ }
    try { chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  log('wrote', OUT);
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
