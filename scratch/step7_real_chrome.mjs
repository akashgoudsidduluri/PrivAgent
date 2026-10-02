/**
 * STEP 7 — Real Chrome E2E capture for the destination producer wiring.
 *
 * Drives the PRODUCTION extension (rebuilt, loaded unpacked) against the REAL
 * shopping fixture with the REAL configured reasoner. Nothing here proposes an
 * action or decides a verdict: the agent plans and acts through the production
 * loop, and this file only READS what production produced.
 *
 * What is captured, all metadata-only:
 *   - the raw user prompt;
 *   - the production `[AgentTrace]` subgoal lines, which are the live planner's
 *     own record of why a subgoal did or did not complete;
 *   - real observations (URL, semantic page type, confidence, page generation);
 *   - the production target-resolution trace, proving the entry URL was still
 *     provisioned by the target resolver rather than by this harness.
 *
 * It does NOT capture: page text, element labels, values, model output, PII.
 *
 * Evidence policy: the agent-directed arrival at the catalog is recorded
 * separately from a harness navigation to the catalog, and the two are never
 * conflated. See `docs/evidence/post-17-9/destination-verifier/step8_real_chrome_results.json`.
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
const CDP_PORT = Number(process.env.ST_CDP_PORT || 9755);
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const TARGET_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

/** The Step 5/6 canonical prompt, and one that classifies as e-commerce. */
const ALL_RUNS = [
  { key: 'canonical', task: process.env.ST_TASK || `open the store catalog at ${TARGET_ORIGIN}` },
  {
    key: 'ecommerce',
    task: `open the store catalog at ${TARGET_ORIGIN} and open the first product listed`,
  },
];
/** How long the real agent is given to plan and act before observation. */
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 9000);
const ONLY = process.env.ST_ONLY_KEY;
const RUNS = ONLY ? ALL_RUNS.filter((r) => r.key === ONLY) : ALL_RUNS;

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-9', 'destination-verifier');
const OUT = path.join(OUT_DIR, 'step8_real_chrome_results.json');
const log = (...a) => console.log('[STEP8]', ...a);

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
          return a.preview
            ? JSON.stringify(a.preview.properties?.map((p) => `${p.name}:${p.value}`) ?? {})
            : a.type;
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
        worldModelPageType: wm?.page?.pageType ?? null,
        worldModelPageGeneration: wm?.page?.pageGeneration ?? null,
        semanticPageType: sc?.pageType ?? null,
        semanticConfidence: sc?.confidence ?? null,
        semanticPageState: sc?.pageState ?? null,
        semanticPageGeneration: sc?.pageGeneration ?? null,
        entityCount: Array.isArray(sc?.entities) ? sc.entities.length : null,
        affordanceTypes: Array.isArray(sc?.affordances) ? sc.affordances.map(a => a.type) : null,
        totalElementsScanned: res.report?.totalElementsScanned ?? null,
        sensitiveDetected: res.report?.sensitiveElementsDetected ?? null,
      };
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 200) };
    }
  })()`;
  const raw = await sw.evaluate(expr);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { label, capturedAt: new Date().toISOString(), ...parsed };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    work:
      'POST-17.10 step 8 — real Chrome E2E capture of the destination producer wiring (production extension, real reasoner)',
    evidencePolicy:
      'Metadata only: URL, semantic page type, confidence, page generation, counts, and the production ' +
      'planner trace lines. No page text, no element labels, no values, no model output, no PII.',
    evidencePolicyNote:
      'agentDirected=false observations were reached by a harness navigation and are labelled ' +
      'CONTROLLED_FIXTURE_PROVEN, never as the agent having arrived there.',
    inputs: { dashboardOrigin: DASHBOARD_ORIGIN, targetOrigin: TARGET_ORIGIN },
    environment: {},
    runs: [],
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
    log('extension loaded (rebuilt bundle)');

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

    for (const run of RUNS) {
      log('=== RUN', run.key, '::', run.task);
      const mark = sw.deepLogs.length;
      // A tab left over from a PREVIOUS run in the same session would make this
      // run's "provisioned by production code" record a lie. Close any such tab
      // BEFORE starting the task — closing it afterwards would delete the very
      // tab the resolver is about to create.
      await sw.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if ((t.url || t.pendingUrl || '').startsWith('${TARGET_ORIGIN}')) {
            try { await chrome.tabs.remove(t.id); } catch (e) { /* already gone */ }
          }
        }
        return true;
      })()`);
      await sleep(800);

      await page.evaluate(`(() => {
        window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: ${JSON.stringify(run.task)} }, '*');
        return true;
      })()`);

      // Production target resolver must provision the tab — not this harness.
      let targetTabId = null;
      let provisioned = null;
      for (let i = 0; i < 60; i += 1) {
        await sleep(500);
        const raw = await sw.evaluate(`(async () => {
          const tabs = await chrome.tabs.query({});
          const t = tabs.find(x => (x.url || x.pendingUrl || '').startsWith('${TARGET_ORIGIN}'));
          return JSON.stringify(t ? { id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status } : null);
        })()`);
        const t = JSON.parse(raw);
        if (t) { targetTabId = t.id; provisioned = t; break; }
      }
      if (!targetTabId) {
        out.runs.push({ key: run.key, task: run.task, error: 'target resolver never provisioned a tab' });
        continue;
      }
      log('target tab provisioned by production code:', targetTabId, provisioned.url);

      // Let the real agent plan and act.
      await sleep(SETTLE_MS);
      const agentEndObservation = await captureObservation(sw, targetTabId, 'agent-end-of-run');
      log('agent-end observation', JSON.stringify({
        url: agentEndObservation.url,
        pageType: agentEndObservation.semanticPageType,
        conf: agentEndObservation.semanticConfidence,
        gen: agentEndObservation.semanticPageGeneration,
      }));

      const lines = sw.deepLogs.slice(mark);
      const trace = lines.filter((l) => l.includes('AgentTrace') || l.includes('TARGET_')).slice(0, 120);
      const subgoalLines = lines.filter(
        (l) => l.includes('subgoal completed') || l.includes('subgoal NOT completed')
      );
      const planningStateLines = lines.filter(
        (l) => l.includes('planningEngineState') || l.includes('NEEDS_REPLAN') || l.includes('Goal verified')
      );
      const goalVerifyLines = lines.filter((l) => l.includes('goal') && l.includes('verif')).slice(0, 40);

      for (const l of subgoalLines) log('  SUBGOAL |', l.slice(0, 300));

      // ── Controlled fixture navigation: real browser, NOT agent-directed ────
      await sw.evaluate(`(async () => { await chrome.tabs.update(${targetTabId}, { url: '${TARGET_ORIGIN}/results.html' }); return true; })()`);
      await sleep(3000);
      const fixtureCatalog = await captureObservation(sw, targetTabId, 'fixture-catalog-results-html');
      log('fixture catalog', JSON.stringify({
        url: fixtureCatalog.url,
        pageType: fixtureCatalog.semanticPageType,
        conf: fixtureCatalog.semanticConfidence,
        gen: fixtureCatalog.semanticPageGeneration,
      }));

      await sw.evaluate(`(async () => { await chrome.tabs.update(${targetTabId}, { url: '${TARGET_ORIGIN}/product.html' }); return true; })()`);
      await sleep(3000);
      const fixtureProduct = await captureObservation(sw, targetTabId, 'fixture-product-html');

      const envelope = await page.evaluate('JSON.stringify((window.__p||[]).slice(-1)[0] || null)');

      out.runs.push({
        key: run.key,
        task: run.task,
        targetTab: { provisionedBy: 'production targetResolver', ...provisioned },
        observations: [
          { ...agentEndObservation, agentDirected: true },
          { ...fixtureCatalog, agentDirected: false },
          { ...fixtureProduct, agentDirected: false },
        ],
        productionTrace: {
          subgoalLines,
          planningStateLines,
          goalVerifyLines,
          traceSample: trace,
        },
        providerCalls: lines.filter((l) => l.includes('requesting reasoning')).length,
        lastEnvelope: JSON.parse(envelope),
      });
    }

    out.limitations.push(
      'The service worker exposes no state read-out for the planner, so the production subgoal record is read from ' +
        'the loop\'s own [AgentTrace] console output rather than from its internal graph object.',
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