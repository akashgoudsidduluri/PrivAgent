/**
 * POST-17.10 STEP 10 — Real Chrome E2E for the two Step 10 objectives.
 *
 * TESTS
 *   A  role-only canonical — "open the store catalog at http://localhost:4174".
 *      There is NO destination URL. The fixture must not define one, the
 *      observation must not create one, and the model must not rewrite one.
 *      If the agent cannot determine a route on its own, the honest answer is
 *      NOT_PROVEN and that is what gets written. /results.html is never forced.
 *   B  explicit destination URL — the deterministic navigator should propose it
 *      verbatim, real Chrome should reach it, and the verifier should MATCH.
 *   C  already-at-destination — B's task is re-issued against the SAME tab,
 *      which production has already left at the destination. The action may
 *      produce no transition; only a fresh observation + verifier MATCH may
 *      complete the subgoal, and no action-success claim may be made.
 *   D  wrong destination — a role the current page does not have. Must not
 *      complete.
 *   E  UNKNOWN — the current page is /search.html classified UNKNOWN. Must not
 *      complete.
 *
 * WHAT THIS HARNESS DOES NOT DO
 *   • It does not navigate the browser. Every arrival is produced by the
 *     production agent. (B and C deliberately reuse a tab PRODUCTION left at the
 *     destination; nothing here opens it.)
 *   • It does not propose an action or decide a verdict.
 *   • It does not read the verifier from Node and call it E2E.
 *
 * EVIDENCE POLICY
 *   Metadata only: URL, semantic page type, confidence, page generation, counts,
 *   provider call count, the production [AgentTrace] lines, and the STRUCTURE of
 *   the provider egress payload. No page text, no element labels, no values, no
 *   PII, and never the model's raw output.
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

const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 12000);

const TESTS = {
  A: {
    key: 'A',
    name: 'ROLE-ONLY CANONICAL',
    task: `open the store catalog at ${TARGET_ORIGIN}`,
    reuseTab: false,
    expectation:
      'entryUrl present, destination role LISTING, destinationUrl ABSENT. The reasoner receives the typed ' +
      'constraint. The agent must find a route itself; /results.html is never forced.',
  },
  B: {
    key: 'B',
    name: 'EXPLICIT DESTINATION URL',
    task: `open ${TARGET_ORIGIN}/results.html and buy the first product listed`,
    reuseTab: false,
    expectation: 'real Chrome reaches /results.html; verifier MATCH; destination subgoal COMPLETED',
  },
  C: {
    key: 'C',
    name: 'ALREADY-AT-DESTINATION',
    // Deliberately the SAME task as B, re-issued against the SAME tab, which
    // production already left at the destination. The only thing that differs
    // is the precondition — and that precondition was produced by the agent,
    // not by this harness.
    task: `open ${TARGET_ORIGIN}/results.html and buy the first product listed`,
    reuseTab: true,
    expectation:
      'action may produce no URL transition; a FRESH observation + verifier MATCH completes the subgoal, ' +
      'credited to the observation, with no action-success claim',
  },
  D: {
    key: 'D',
    name: 'WRONG DESTINATION',
    task: `open the checkout page at ${TARGET_ORIGIN}`,
    reuseTab: false,
    expectation: 'the declared role is CHECKOUT and the page is not a checkout: no destination completion',
  },
  E: {
    key: 'E',
    name: 'UNKNOWN PAGE',
    task: `open the store catalog at ${TARGET_ORIGIN}/search.html`,
    reuseTab: false,
    expectation: 'current page is /search.html classified UNKNOWN: no destination completion',
  },
};

const SESSION = Number(process.env.ST_SESSION || 1);
const KEYS = (process.env.ST_KEYS || (SESSION === 1 ? 'A,B,C' : 'D,E'))
  .split(',')
  .map((k) => k.trim().toUpperCase())
  .filter((k) => TESTS[k]);

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-9', 'destination-verifier');
const log = (...a) => console.log('[STEP10]', ...a);

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

/** Record the STRUCTURE of the provider egress payload — never model output. */
function captureEgress(sw) {
  sw.egress = [];
  sw.onEvent = (m) => {
    if (m.method !== 'Network.requestWillBeSent') return;
    const req = m.params.request || {};
    if (!String(req.url || '').includes('/agent/action')) return;
    let parsed = null;
    try {
      const body = JSON.parse(req.postData || '{}');
      const sem = body?.context?.semantic_context || {};
      parsed = {
        // The claim under test, measured on the wire.
        declaredDestination: sem.declaredDestination ?? null,
        semanticPageType: sem.pageType ?? null,
        taskIsPresent: typeof body.task === 'string',
        detectionCount: Array.isArray(body.context?.detections) ? body.context.detections.length : null,
      };
    } catch {
      parsed = { parseError: true };
    }
    sw.egress.push(parsed);
  };
}

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

const TRACE_MARKERS = [
  'requesting reasoning',
  'reasoning response received',
  'destination navigation proposed deterministically',
  'destination already satisfied',
  'no transition and destination NOT satisfied',
  'subgoal completed',
  'subgoal NOT completed',
  'ACTION_EXECUTED + ACTION_NO_EFFECT',
  'ACTION_EXECUTED + EFFECT_VERIFIED',
  'M6 failed',
  'Agent reasoning failed',
  'AgentLoop] perception complete',
];

function classify(lines) {
  const has = (needle) => lines.some((l) => l.includes(needle));
  return {
    providerCalled: has('requesting reasoning'),
    providerFailure:
      lines.find((l) => l.includes('Agent reasoning failed'))?.slice(0, 240) ??
      lines.find((l) => l.includes('M6 failed'))?.slice(0, 240) ??
      null,
    deterministicNavigationProposed: has('destination navigation proposed deterministically'),
    alreadySatisfied: has('destination already satisfied'),
    notSatisfied: has('no transition and destination NOT satisfied'),
    subgoalCompleted: lines.filter((l) => l.includes('subgoal completed')).map((l) => l.slice(0, 260)),
    subgoalNotCompleted: lines
      .filter((l) => l.includes('subgoal NOT completed'))
      .map((l) => l.slice(0, 260)),
    actionNoEffect: has('ACTION_EXECUTED + ACTION_NO_EFFECT'),
    effectVerified: has('ACTION_EXECUTED + EFFECT_VERIFIED'),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    work:
      'POST-17.10 step 10 — real Chrome E2E: role-only destination propagation and already-at-destination semantics',
    session: SESSION,
    keys: KEYS,
    evidencePolicy:
      'Metadata only: URL, semantic page type, confidence, page generation, counts, provider call count, the ' +
      'production [AgentTrace] lines, and the STRUCTURE of the provider egress payload. No page text, no element ' +
      'labels, no values, no model output, no PII.',
    harnessDoesNot: [
      'navigate the browser',
      'propose an action',
      'decide a verdict',
      'read the destination verifier directly and label it E2E',
      'force /results.html for a role-only declaration',
    ],
    inputs: { dashboardOrigin: DASHBOARD_ORIGIN, targetOrigin: TARGET_ORIGIN },
    environment: {},
    tests: [],
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
    await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    out.environment.extensionLoaded = true;
    log('extension loaded (rebuilt bundle)');

    const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
    page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
    await sleep(3500);
    await page.evaluate('(() => { window.__p = []; return true; })()');

    sw = await attachServiceWorker(CDP_PORT);
    if (!sw) throw new Error('service worker not found');
    captureSwConsole(sw);
    captureEgress(sw);

    let lastTabId = null;

    for (const key of KEYS) {
      const test = TESTS[key];
      log('=== TEST', key, test.name, '::', test.task);
      const logMark = sw.deepLogs.length;
      const egressMark = sw.egress.length;

      if (test.reuseTab && lastTabId) {
        // C: keep the tab PRODUCTION left at the destination. Nothing here
        // navigates it — we only read where it already is.
        log('reusing production-provisioned tab', lastTabId);
      } else {
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
      }

      const startObservation = lastTabId && test.reuseTab
        ? await captureObservation(sw, lastTabId, 'at-task-start-previous-tab')
        : null;

      await page.evaluate(`(() => {
        window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: ${JSON.stringify(test.task)} }, '*');
        return true;
      })()`);

      let targetTabId = lastTabId && test.reuseTab ? lastTabId : null;
      let provisioned = null;
      for (let i = 0; i < 60; i += 1) {
        await sleep(500);
        const raw = await sw.evaluate(`(async () => {
          const tabs = await chrome.tabs.query({});
          const matching = tabs.filter(x => (x.url || x.pendingUrl || '').startsWith('${TARGET_ORIGIN}'));
          // The MOST RECENTLY created target tab is the one production is
          // acting on; an older leftover must never be mistaken for it.
          matching.sort((a, b) => b.id - a.id);
          const t = matching[0];
          return JSON.stringify(t ? { id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status } : null);
        })()`);
        const t = JSON.parse(raw);
        if (t) { targetTabId = t.id; provisioned = t; break; }
      }
      if (!targetTabId) {
        out.tests.push({ key, name: test.name, task: test.task, error: 'target resolver never provisioned a tab' });
        continue;
      }
      lastTabId = targetTabId;
      log('target tab:', targetTabId, provisioned.url);

      await sleep(SETTLE_MS);

      const endObservation = await captureObservation(sw, targetTabId, 'agent-end-of-run');
      log('end observation', JSON.stringify({
        url: endObservation.url,
        pageType: endObservation.semanticPageType,
        conf: endObservation.semanticConfidence,
        gen: endObservation.semanticPageGeneration,
      }));

      const lines = sw.deepLogs.slice(logMark);
      const egress = sw.egress.slice(egressMark);
      const envelope = await page.evaluate('JSON.stringify((window.__p||[]).slice(-1)[0] || null)');

      out.tests.push({
        key,
        name: test.name,
        task: test.task,
        expectation: test.expectation,
        precondition: startObservation,
        targetTab: { provisionedBy: 'production targetResolver', ...provisioned },
        endObservation,
        providerEgress: egress,
        productionTrace: {
          ...classify(lines),
          traceSample: lines
            .filter((l) => TRACE_MARKERS.some((m) => l.includes(m)) || l.includes('TARGET_'))
            .slice(0, 120),
        },
        lastEnvelope: JSON.parse(envelope),
      });
    }

    out.limitations.push(
      'The service worker exposes no state read-out for the planner, so the destination-subgoal record is read ' +
        'from the loop\'s own [AgentTrace] console output, not from its internal graph object.',
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

  const file = path.join(OUT_DIR, `step10_real_chrome_session${SESSION}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  log('wrote', file);
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
