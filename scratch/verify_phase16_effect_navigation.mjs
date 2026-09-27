/**
 * PrivAgent — PHASE 16 diagnostic: does effect verification survive navigation?
 *
 * The Phase 16 task suite produced ACTION_NO_EFFECT on actions that DID change
 * the browser (the tab URL demonstrably moved to the submitted results page).
 * This harness isolates the mechanism: it asks the REAL service worker's
 * production snapshot path for a post-action snapshot immediately after a
 * navigation-triggering click, and compares the Chrome tab URL (authoritative,
 * survives content-script teardown) against the content-script response.
 *
 * DETERMINISTIC FIXTURE TEST — no reasoner, no agent loop. Real Chrome, real
 * built content script, real SW message channel.
 */

import fs from 'fs';
import path from 'path';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.P16_FIXTURE_PORT || 4200);
const CDP_PORT = Number(process.env.P16_CDP_PORT || 9503);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const OUT = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16', 'phase16_effect_navigation_diagnostic.json');

const out = {
  timestamp: new Date().toISOString(),
  work: 'Phase 16 diagnostic — effect verification vs. navigation',
  fixtureClass: 'DETERMINISTIC FIXTURE TEST',
  question: 'Can the production post-action snapshot observe an effect that is a navigation?',
  cases: [],
};

const server = await servePhase16Fixture(FIXTURE_PORT);
const { proc: chrome, profile } = launchChrome(CDP_PORT);
const sessions = [];

try {
  for (let i = 0; i < 120; i++) { try { await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(250); } }
  const bs = await openSession((await cdpGet(CDP_PORT, '/json/version')).webSocketDebuggerUrl);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  bs.close();

  const swTarget = (await cdpGet(CDP_PORT, '/json/list')).find((t) => t.url && t.url.includes('serviceWorker.js'));
  if (!swTarget) throw new Error('no service worker target — extension not loaded');
  const sw = await openSession(swTarget.webSocketDebuggerUrl);
  sessions.push(sw);
  await sw.send('Runtime.enable');

  // Case A: in-page click (no navigation) — the control.
  // Case B: navigation-triggering click (form submit) — the suspect.
  for (const c of [
    { key: 'IN_PAGE_CLICK', url: `${ORIGIN}/details`, clickSelector: '#reveal' },
    { key: 'NAVIGATION_CLICK', url: `${ORIGIN}/`, clickSelector: '#go' },
  ]) {
    const tab = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(c.url)}`, 'PUT');
    await sleep(2200);

    const urlBefore = await cdpGet(CDP_PORT, '/json/list').then((l) => l.find((t) => t.id === tab.id)?.url);

    // Ask the REAL service worker for the production snapshot on this tab,
    // using the same message the agent loop uses.
    const probe = async (label) => sw.evaluate(`(async () => {
      try {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find(x => (x.url||'').includes('localhost:${FIXTURE_PORT}'));
        if (!t) return { label: ${JSON.stringify(label)}, tabFound: false };
        const tabUrl = t.url || t.pendingUrl || null;
        let contentScript = 'ok';
        let snap = null;
        try {
          const res = await chrome.tabs.sendMessage(t.id, { type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT' });
          snap = res && res.snapshot ? { url: res.snapshot.url, scrollY: res.snapshot.scrollY, dom: res.snapshot.domElementCount } : null;
        } catch (e) { contentScript = 'UNAVAILABLE: ' + String(e && e.message || e).slice(0, 80); }
        return { label: ${JSON.stringify(label)}, tabFound: true, chromeTabUrl: tabUrl, contentScript, snapshot: snap };
      } catch (e) { return { label: ${JSON.stringify(label)}, error: String(e && e.message || e).slice(0,120) }; }
    })()`);

    const pre = await probe('pre');
    // Click through the page's own DOM, exactly as a user would.
    const page = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((t) => t.id === tab.id).webSocketDebuggerUrl);
    sessions.push(page);
    await page.send('Runtime.enable');
    const clickErr = await page.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(c.clickSelector)}); if (!el) return 'no element'; el.click(); return 'clicked'; })()`
    );
    // The agent loop reads the post-snapshot immediately after dispatch.
    const post = await probe('post-immediate');
    await sleep(1500);
    const postSettled = await probe('post-settled-1.5s');

    const urlAfter = await cdpGet(CDP_PORT, '/json/list').then((l) => l.find((t) => t.id === tab.id)?.url);

    out.cases.push({
      key: c.key, clickSelector: c.clickSelector, clickResult: clickErr,
      urlBefore, urlAfter, navigationObserved: urlBefore !== urlAfter,
      pre, postImmediate: post, postSettled,
      productionSnapshotWouldBeNull:
        !post.snapshot && post.chromeTabUrl !== undefined && post.chromeTabUrl !== urlBefore,
    });
    console.log(`[P16-EFF] ${c.key}: nav=${urlBefore !== urlAfter} contentScriptPost=${String(post.contentScript).slice(0, 40)}`);
    try { await cdpGet(CDP_PORT, `/json/close/${tab.id}`); } catch {}
  }
} finally {
  for (const s of sessions) s.close();
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`[P16-EFF] → ${path.relative(REPO_ROOT, OUT)}`);
console.log(JSON.stringify(out.cases.map((c) => ({
  key: c.key, navigationObserved: c.navigationObserved,
  urlBefore: c.urlBefore, urlAfter: c.urlAfter,
  postContentScript: c.postImmediate.contentScript,
  postChromeTabUrl: c.postImmediate.chromeTabUrl,
  snapshotReturned: Boolean(c.postImmediate.snapshot),
})), null, 2));
