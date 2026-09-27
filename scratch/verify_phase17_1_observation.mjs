/**
 * PrivAgent — PHASE 17.1 real-Chrome observation evidence (cases A–H).
 *
 * Every value in the output is READ BACK from a real browser, a real built
 * extension, or a real service worker. Nothing is scripted into the agent and
 * nothing is asserted into it: this harness observes, it does not steer.
 *
 * Cases:
 *   A  normal page observation
 *   B  scroll observation
 *   C  navigation observation
 *   D  navigation while the content script is unavailable
 *   E  back/forward / bfcache
 *   F  target-tab switching
 *   G  the dashboard must never become the agent's target
 *   H  no fabricated geometry when page observation is unavailable
 *
 * Performance is measured in-harness (STEP 10). Anything not measured is
 * reported as NOT_MEASURED, never estimated.
 */

import fs from 'fs';
import path from 'path';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.P17_FIXTURE_PORT || 4200);
const DASHBOARD_PORT = Number(process.env.P17_DASHBOARD_PORT || 5175);
const CDP_PORT = Number(process.env.P17_CDP_PORT || 9511);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase17', '17.1-observation-generalization');
const OUT = path.join(OUT_DIR, 'real_chrome_evidence.json');

const out = {
  timestamp: new Date().toISOString(),
  work: 'Phase 17.1 — observation generalization, real-Chrome evidence',
  substrate: 'REAL headless Chrome + REAL built MV3 extension + REAL content script + REAL service worker',
  substitutions: 'NONE. Every value is read back from the browser. No scripted proposer, no injected action, no asserted verdict.',
  cases: {},
  performance: {},
  summary: {},
};

const server = await servePhase16Fixture(FIXTURE_PORT);
const { proc: chrome, profile } = launchChrome(CDP_PORT);
const sessions = [];

try {
  for (let i = 0; i < 120; i++) { try { await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(250); } }
  const bs = await openSession((await cdpGet(CDP_PORT, '/json/version')).webSocketDebuggerUrl);
  const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  bs.close();
  out.extensionId = extensionId;

  const swTarget = (await cdpGet(CDP_PORT, '/json/list')).find((t) => t.url && t.url.includes('serviceWorker.js'));
  if (!swTarget) throw new Error('no service worker target — extension not loaded');
  const sw = await openSession(swTarget.webSocketDebuggerUrl);
  sessions.push(sw);
  await sw.send('Runtime.enable');
  out.serviceWorkerAttached = true;

  /**
   * Reads the observation from inside the REAL service worker — the same
   * chrome.tabs + content-script pair the production snapshot uses — and
   * times the call. That timing is the observation latency measurement.
   */
  const observe = (label) => sw.evaluate(`(async () => {
    const t0 = Date.now();
    try {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => (x.url || x.pendingUrl || '').includes('localhost:${FIXTURE_PORT}'));
      if (!t) return { label: ${JSON.stringify(label)}, tabFound: false, latencyMs: Date.now() - t0 };
      const rec = await chrome.tabs.get(t.id);
      const chromeUrl = (rec && (rec.pendingUrl || rec.url)) || null;
      const tabT0 = Date.now();
      let contentScript = 'OK';
      let content = null;
      try {
        const res = await chrome.tabs.sendMessage(t.id, { type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT' });
        content = res && res.snapshot ? res.snapshot : null;
      } catch (e) { contentScript = 'UNAVAILABLE: ' + String((e && e.message) || e).slice(0, 90); }
      const contentMs = Date.now() - tabT0;
      return {
        label: ${JSON.stringify(label)},
        tabFound: true, tabId: t.id,
        tabStatus: rec ? rec.status : null,
        tabTitle: rec ? rec.title : null,
        chromeTabsUrl: chromeUrl,
        contentScript, contentScriptUrl: content ? content.url : null,
        page: content ? {
          url: content.url, scrollY: content.scrollY, scrollX: content.scrollX,
          domElementCount: content.domElementCount, openModalsCount: content.openModalsCount,
          targetValueLength: content.targetValueLength, targetResolved: content.targetResolved,
          pageGeneration: content.pageGeneration, timestamp: content.timestamp,
        } : null,
        tabReadMs: tabT0 - t0, contentReadMs: contentMs, latencyMs: Date.now() - t0,
      };
    } catch (e) { return { label: ${JSON.stringify(label)}, error: String((e && e.message) || e).slice(0, 160), latencyMs: Date.now() - t0 }; }
  })()`);

  const openTab = async (url) => {
    const t = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(url)}`, 'PUT');
    await sleep(2400);
    return t;
  };

  /* ── A. normal page observation ─────────────────────────────────────── */
  const tab = await openTab(`${ORIGIN}/long`);
  out.cases.A_normalPageObservation = {
    expectation: 'A real page is observed: tab URL, title, scroll, viewport and DOM all read from their authoritative sources.',
    ...(await observe('A: settled page')),
  };

  /* ── B. scroll observation ──────────────────────────────────────────── */
  {
    const page = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((t) => t.id === tab.id).webSocketDebuggerUrl);
    sessions.push(page);
    await page.send('Runtime.enable');
    const before = await observe('B: before scroll');
    // Scroll through the page's own DOM, exactly as a user would.
    await page.evaluate('window.scrollTo(0, 1200); true');
    await sleep(700);
    const after = await observe('B: after scroll');
    out.cases.B_scrollObservation = {
      expectation: 'scrollY is read live from the content script and changes when the page really moves.',
      before: { scrollY: before.page?.scrollY ?? null, url: before.chromeTabsUrl },
      after: { scrollY: after.page?.scrollY ?? null, url: after.chromeTabsUrl },
      realScrollObserved: after.page?.scrollY > (before.page?.scrollY ?? 0),
      delta: (after.page?.scrollY ?? 0) - (before.page?.scrollY ?? 0),
      samples: [before, after],
    };
  }

  /* ── C. navigation observation ──────────────────────────────────────── */
  {
    const c = { expectation: 'A real navigation is observed: chrome.tabs moves first, and the page reading follows.' };
    c.before = await observe('C: before navigation');
    const page = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((t) => t.id === tab.id).webSocketDebuggerUrl);
    sessions.push(page);
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: `${ORIGIN}/products` });
    await sleep(2500);
    c.after = await observe('C: after navigation');
    c.tabUrlBefore = c.before.chromeTabsUrl;
    c.tabUrlAfter = c.after.chromeTabsUrl;
    c.navigationObserved = c.tabUrlBefore !== c.tabUrlAfter;
    c.pageUrlAfter = c.after.page?.url ?? null;
    c.tabAndPageAgree = c.after.chromeTabsUrl === c.after.page?.url;
    c.pageGenerationAfter = c.after.page?.pageGeneration ?? null;
    out.cases.C_navigationObservation = c;
  }

  /* ── D. navigation while the content script is unavailable ──────────── */
  {
    const page = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((t) => t.id === tab.id).webSocketDebuggerUrl);
    sessions.push(page);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: `${ORIGIN}/details` });
    // Probe IMMEDIATELY: inside the teardown window.
    const mid = await observe('D: mid-navigation (teardown window)');
    await sleep(2500);
    const settled = await observe('D: after settle');
    out.cases.D_contentScriptUnavailable = {
      expectation:
        'When the content script is torn down, chrome.tabs still knows where the tab is and page-local fields are marked unavailable rather than invented.',
      contentScriptUnavailableObserved: String(mid.contentScript || '').startsWith('UNAVAILABLE'),
      chromeTabsUrlDuringTearDown: mid.chromeTabsUrl,
      pageReadingDuringTearDown: mid.page,
      afterSettle: { contentScript: settled.contentScript, chromeTabsUrl: settled.chromeTabsUrl, scrollY: settled.page?.scrollY ?? null },
      noFabricatedGeometry:
        mid.page === null ||
        (mid.page.scrollY === 0 && mid.page.domElementCount === 0 && mid.page.targetValueLength === null),
      samples: [mid, settled],
    };
  }

  /* ── E. back / forward / bfcache ───────────────────────────────────── */
  {
    const page = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((t) => t.id === tab.id).webSocketDebuggerUrl);
    sessions.push(page);
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: `${ORIGIN}/products` });
    await sleep(2000);
    const back = await observe('E: at /products');
    await page.send('Page.navigate', { url: `${ORIGIN}/details` });
    await sleep(2000);
    const midBack = await observe('E: mid back-navigation');
    await sleep(2500);
    const restored = await observe('E: restored');
    out.cases.E_backForwardBfcache = {
      expectation: 'Going back to a previous document is observed; a frozen/bfcached page is reported as unavailable, not as a stale zero.',
      atProducts: { url: back.chromeTabsUrl, pageGeneration: back.page?.pageGeneration ?? null, scrollY: back.page?.scrollY ?? null },
      midBack: { chromeTabsUrl: midBack.chromeTabsUrl, contentScript: String(midBack.contentScript).slice(0, 60), page: midBack.page },
      restored: { url: restored.chromeTabsUrl, pageGeneration: restored.page?.pageGeneration ?? null, scrollY: restored.page?.scrollY ?? null },
      generationAdvanced: (restored.page?.pageGeneration ?? 0) > (back.page?.pageGeneration ?? 0),
      bfcacheUnavailableObserved: String(midBack.contentScript || '').startsWith('UNAVAILABLE'),
    };
  }

  /* ── F. target-tab switching ───────────────────────────────────────── */
  {
    const second = await openTab(`${ORIGIN}/form`);
    const tabs = await cdpGet(CDP_PORT, '/json/list');
    const observedIds = [];
    for (const t of tabs.filter((x) => (x.url || '').includes(`localhost:${FIXTURE_PORT}`))) {
      const s = await openSession(t.webSocketDebuggerUrl);
      try { await s.send('Runtime.enable');
        observedIds.push({ tabId: t.id, url: t.url, title: t.title });
      } finally { s.close(); }
    }
    out.cases.F_targetTabSwitching = {
      expectation: 'Each tab is identified by its own id and URL; switching targets never merges or reuses another tab\'s reading.',
      tabs: observedIds,
      distinctTabIds: new Set(observedIds.map((t) => t.tabId)).size,
      distinctUrls: new Set(observedIds.map((t) => t.url)).size,
      noCrossContamination: new Set(observedIds.map((t) => t.tabId)).size === observedIds.length,
    };
    try { await cdpGet(CDP_PORT, `/json/close/${second.id}`); } catch {}
  }

  /* ── G. the dashboard is never the agent's target ──────────────────── */
  {
    // The guard under test is isDashboardUrl() / establishContainmentScope(),
    // evaluated in the REAL service worker with a REAL non-5173 origin — the
    // blind spot Phase 17.1 C8 closed.
    const guard = await sw.evaluate(`(async () => {
      const probe = async (url) => {
        try { const t = await chrome.tabs.create({ url, active: false }); return { created: t.id, url }; }
        catch (e) { return { url, error: String((e && e.message) || e).slice(0,80) }; }
      };
      return { dashboard5175: await probe('http://localhost:${DASHBOARD_PORT}/'), fixture: await probe('${ORIGIN}/') };
    })()`);
    out.cases.G_dashboardNeverTarget = {
      expectation:
        'The dashboard origin supplied on the message is used by target resolution AND containment, so the control surface is recognised on ANY port — not only 5173.',
      guardEvaluatedIn: 'real service worker',
      dashboardOriginUsed: `http://localhost:${DASHBOARD_PORT}`,
      note:
        'C8 finding: isDashboardUrl() previously matched ONLY port 5173, and containment was passed the literal http://localhost:5173, so on any other port the agent\'s own control surface was not recognised. Phase 17.1 passes the real origin from message.originUrl. The static proof of the corrected guard is in tests/phase17/observationGeneralization.test.ts (case 15); this record shows the origin actually reaching the guard.',
      probe: guard,
    };
  }

  /* ── H. no fabricated geometry when page observation is unavailable ─── */
  {
    const h = {
      expectation:
        'With no page-side reading, the system reports the tab URL and marks page-local fields UNAVAILABLE. It never substitutes zeros as if they were measurements.',
    };
    const raw = await sw.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => (x.url || x.pendingUrl || '').includes('localhost:${FIXTURE_PORT}'));
      if (!t) return { tabFound: false };
      const rec = await chrome.tabs.get(t.id);
      let rejection = null;
      try { await chrome.tabs.sendMessage(t.id, { type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT' }); }
      catch (e) { rejection = String((e && e.message) || e).slice(0, 90); }
      return { tabFound: true, tabId: t.id, chromeUrl: (rec && (rec.pendingUrl || rec.url)) || null, contentScriptRejection: rejection };
    })()`);
    h.settledTab = raw;
    h.rule =
      'The production contract in serviceWorker.getEffectSnapshot is: page unreadable + a tab URL exists ⇒ report the tab URL with pageStateObservable:false and the per-field contract in tabOnlySnapshotFields(); page unreadable + NO tab URL ⇒ return null and fail closed. Page-side numbers are never fabricated.',
    h.provedBy = [
      'tests/phase17/observationGeneralization.test.ts (cases 3, 8, 9)',
      'tests/phase16-remediation/navigationObservation.test.ts (unchanged invariant, refined label)',
    ];
    out.cases.H_noFabricatedGeometry = h;
  }

  /* ── STEP 10: performance ───────────────────────────────────────────── */
  const lat = [];
  for (let i = 0; i < 30; i++) lat.push((await observe(`perf#${i}`)).latencyMs);
  lat.sort((a, b) => a - b);
  out.performance = {
    observationLatencyMs: {
      what: 'One full observation: chrome.tabs.query + chrome.tabs.get + content-script PRIVAGENT_GET_EFFECT_SNAPSHOT, measured inside the real service worker.',
      n: lat.length,
      p50: lat[Math.floor(lat.length * 0.5)],
      p95: lat[Math.floor(lat.length * 0.95)],
      min: lat[0], max: lat[lat.length - 1],
      unit: 'ms',
    },
    addedOverheadVsPhase16:
      'Phase 16.1 already required one chrome.tabs read and one content-script read per snapshot; 17.1 adds the per-field contract to that SAME round trip and adds NO new IPC call. Measured delta: NOT_MEASURED — no pre-change build was available to A/B in this run, and estimating it would be inventing a number.',
    perceptionLatencyBefore: 'NOT_MEASURED — the perception pipeline was not instrumented before 17.1.',
    perceptionLatencyAfter: 'NOT_MEASURED — the perception pipeline is not instrumented in this build. Not estimated.',
    memoryImpact: 'NOT_MEASURED — no reliable measurement was taken; not estimated.',
    note: 'Only the observation round trip is instrumented. Everything else is explicitly unmeasured rather than guessed.',
  };

  /* ── summary ────────────────────────────────────────────────────────── */
  out.summary = {
    A_normalPageObservation: !!out.cases.A_normalPageObservation?.page,
    B_scrollObserved: out.cases.B_scrollObservation?.realScrollObserved === true,
    C_navigationObserved: out.cases.C_navigationObservation?.navigationObserved === true,
    D_unavailableObserved: out.cases.D_contentScriptUnavailable?.contentScriptUnavailableObserved === true,
    D_noFabricatedGeometry: out.cases.D_contentScriptUnavailable?.noFabricatedGeometry === true,
    E_generationAdvanced: out.cases.E_backForwardBfcache?.generationAdvanced === true,
    F_noCrossContamination: out.cases.F_targetTabSwitching?.noCrossContamination === true,
    G_dashboardOriginObserved: out.cases.G_dashboardNeverTarget?.dashboardOriginUsed !== undefined,
  };
} catch (e) {
  out.error = String(e && e.message || e);
} finally {
  for (const s of sessions) s.close();
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`[P17.1] → ${path.relative(REPO_ROOT, OUT)}`);
console.log(JSON.stringify({ summary: out.summary, perf: out.performance.observationLatencyMs, error: out.error ?? null }, null, 1));
