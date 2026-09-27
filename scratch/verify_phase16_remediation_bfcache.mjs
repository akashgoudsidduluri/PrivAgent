/**
 * PrivAgent — PHASE 16 DEFECT REMEDIATION: real-Chrome bfcache probe.
 *
 * The remediation for DEFECT 3 is in the service worker's production
 * getEffectSnapshot: Chrome's tab record is authoritative for the tab URL, and
 * a content script that has been torn down by a navigation is NOT treated as
 * proof that the action failed.
 *
 * That claim is only worth anything if the content script really IS
 * unavailable during a real navigation. This probe measures that window in a
 * real headless Chrome, against the real built extension, and records what the
 * two sources said at the same instant.
 *
 * It is an OBSERVATION probe. It does not drive the agent and it does not
 * assert any verdict. The end-to-end production record is Test D of
 * verify_phase16_remediation.mjs.
 */

import fs from 'fs';
import path from 'path';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.P16_FIXTURE_PORT || 4200);
const CDP_PORT = Number(process.env.P16_CDP_PORT || 9503);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const OUT = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16-remediation', 'bfcache_navigation_evidence.json');

const out = {
  timestamp: new Date().toISOString(),
  work: 'DEFECT 3 — authoritative chrome.tabs URL vs. an unavailable content script',
  substrate: 'REAL headless Chrome + REAL built extension + REAL content script + REAL service worker',
  question:
    'During a real navigation, is the content script genuinely unavailable while Chrome\'s tab record already knows the destination?',
  scope:
    'Observation only. The end-to-end production record (a real agent navigation, the real getEffectSnapshot, the real effect verifier and goal verifier) is Test D in this directory.',
  samples: [],
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
  out.extensionLoaded = true;

  /**
   * Reads BOTH sources at the same instant from inside the real service
   * worker: Chrome's own tab record, and the content script. This is the same
   * pair the production getEffectSnapshot reads.
   */
  const probe = (label) => sw.evaluate(`(async () => {
    try {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => (x.url || x.pendingUrl || '').includes('localhost:${FIXTURE_PORT}'));
      if (!t) return { label: ${JSON.stringify(label)}, tabFound: false };
      const rec = await chrome.tabs.get(t.id);
      const chromeUrl = (rec && (rec.pendingUrl || rec.url)) || null;
      let contentScript = 'OK';
      let contentUrl = null;
      try {
        const res = await chrome.tabs.sendMessage(t.id, { type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT' });
        contentUrl = res && res.snapshot ? res.snapshot.url : null;
      } catch (e) { contentScript = 'UNAVAILABLE: ' + String((e && e.message) || e).slice(0, 90); }
      return {
        label: ${JSON.stringify(label)}, tabFound: true, tabId: t.id,
        tabStatus: rec ? rec.status : null,
        chromeTabsUrl: chromeUrl, chromeTabsPendingUrl: (rec && rec.pendingUrl) || null,
        contentScript, contentScriptUrl: contentUrl,
      };
    } catch (e) { return { label: ${JSON.stringify(label)}, error: String((e && e.message) || e).slice(0, 140) }; }
  })()`);

  const tab = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${ORIGIN}/products`)}`, 'PUT');
  await sleep(2500);
  out.samples.push({ case: 'CONTROL — page settled, content script present', ...(await probe('settled')) });

  // Case 1: a navigation, probed IMMEDIATELY (inside the teardown window).
  const page = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((t) => t.id === tab.id).webSocketDebuggerUrl);
  sessions.push(page);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${ORIGIN}/details` });
  out.samples.push({ case: 'NAVIGATION — probed immediately (teardown window)', ...(await probe('mid-navigation')) });
  await sleep(2000);
  out.samples.push({ case: 'NAVIGATION — probed after settle', ...(await probe('post-navigation-settled')) });

  // Case 2: the back/forward-cache path. Going back restores a document that
  // the browser may have frozen rather than torn down; that is the bfcache
  // case the Phase 16 report described.
  await page.send('Page.navigate', { url: `${ORIGIN}/products` });
  await sleep(2000);
  out.samples.push({ case: 'BACK/FORWARD — after returning to the first document', ...(await probe('after-return')) });
  await page.send('Page.goBack', {}).catch?.(() => {});
  out.samples.push({ case: 'BACK/FORWARD — probed immediately after goBack', ...(await probe('mid-back')) });
  await sleep(2000);
  out.samples.push({ case: 'BACK/FORWARD — probed after settle', ...(await probe('post-back-settled')) });

  out.observedContentScriptUnavailableAtAnyPoint = out.samples.some(
    (s) => typeof s.contentScript === 'string' && s.contentScript.startsWith('UNAVAILABLE')
  );
  out.observedChromeTabsUrlDisagreeingWithPage = out.samples.some(
    (s) => s.chromeTabsUrl && s.contentScriptUrl && s.chromeTabsUrl !== s.contentScriptUrl
  );
  out.productionContract = {
    rule: 'chrome.tabs is authoritative for the tab URL. A content script that is unavailable mid-navigation is not evidence that the action failed.',
    source: 'extension/src/background/serviceWorker.ts — getEffectSnapshot',
    failClosed: 'If NEITHER chrome.tabs NOR the page yields a URL, the snapshot is null and the loop fails closed. It never guesses.',
    notSuccess: 'The snapshot establishes an OBSERVED EFFECT only. Goal Verification still decides whether the user\'s goal was met.',
  };
  try { await cdpGet(CDP_PORT, `/json/close/${tab.id}`); } catch {}
} catch (e) {
  out.error = String(e && e.message || e);
} finally {
  for (const s of sessions) s.close();
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`[P16R-BFC] → ${path.relative(REPO_ROOT, OUT)}`);
console.log(JSON.stringify(out.samples.map((s) => ({
  case: s.case, tabStatus: s.tabStatus,
  chromeTabsUrl: s.chromeTabsUrl, pendingUrl: s.chromeTabsPendingUrl,
  contentScript: String(s.contentScript).slice(0, 50), contentScriptUrl: s.contentScriptUrl,
})), null, 1));
console.log('contentScriptUnavailableObserved:', out.observedContentScriptUnavailableAtAnyPoint);
console.log('chromeTabsDisagreedWithPage:', out.observedChromeTabsUrlDisagreeingWithPage);
