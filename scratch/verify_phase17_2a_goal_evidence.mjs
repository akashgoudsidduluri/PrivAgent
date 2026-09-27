/**
 * PrivAgent — PHASE 17.2A real-Chrome goal-evidence evidence (3 cases).
 *
 * SUBSTRATE AND ITS LIMITS, stated up front so the numbers are not over-read:
 *
 *   REAL:  the browser (headless Chrome via CDP), the built MV3 extension, the
 *          service worker, the content script, and the page state read back out
 *          of the live tab. Every URL and every detection below came out of a
 *          real browser.
 *   NOT REAL: the goal DECISION. The production `verifyTaskGoal` cannot be
 *          invoked inside the service worker — it is bundled and not exported —
 *          so the decision is made by importing the identical production module
 *          (`extension/src/agent/goalVerifier.ts`, the same file the bundle is
 *          built from) in Node, against observations captured from Chrome in
 *          this same run. This harness therefore proves the OBSERVATION half in
 *          a real browser and the DECISION half against real observations. It is
 *          a hybrid, and is reported as one.
 *
 * Cases:
 *   1  an action request alone does not produce goal success
 *   2  a navigation that never commits does not become success because the URL
 *      was requested
 *   3  a genuinely OBSERVED state still reaches the valid success path
 */

import fs from 'fs';
import path from 'path';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';
import { verifyTaskGoal } from '../extension/src/agent/goalVerifier.ts';

const FIXTURE_PORT = Number(process.env.P17_FIXTURE_PORT || 4220);
const CDP_PORT = Number(process.env.P17_CDP_PORT || 9521);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
// A port nothing is listening on: the navigation is genuinely refused.
const DEAD_ORIGIN = 'http://localhost:9';

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase17', '17.2-goal-verification');
const OUT = path.join(OUT_DIR, 'real_chrome_evidence.json');

const out = {
  timestamp: new Date().toISOString(),
  work: 'Phase 17.2A — goal evidence fabrication remediation, real-Chrome evidence',
  substrate: 'REAL headless Chrome + REAL built MV3 extension + REAL service worker + REAL content script',
  substitution: {
    observation: 'REAL — read back from the live tab through the extension',
    decision: 'NOT RUN IN BROWSER — production verifyTaskGoal is bundled and not exported to the service worker; the identical production module is imported in Node and fed those real observations. This is a hybrid, labelled as such.',
  },
  cases: {},
  summary: {},
};

const state = (over = {}) => ({
  task: '',
  taskConstraints: {},
  previousActions: [],
  steps: [],
  visitedElementIds: [],
  candidateItems: [],
  ...over,
});

const server = await servePhase16Fixture(FIXTURE_PORT);
const { proc: chrome, profile } = launchChrome(CDP_PORT);
const sessions = [];

const tidy = async () => {
  for (const s of sessions) { try { s.close(); } catch { /* already closed */ } }
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  try { server.close(); } catch { /* already closed */ }
};

try {
  for (let i = 0; i < 120; i++) {
    try { await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(250); }
  }
  const bs = await openSession((await cdpGet(CDP_PORT, '/json/version')).webSocketDebuggerUrl);
  const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  bs.close();
  out.extensionId = extensionId;

  const swTarget = (await cdpGet(CDP_PORT, '/json/list'))
    .find((t) => t.url && t.url.includes('serviceWorker.js'));
  if (!swTarget) throw new Error('no service worker target — extension not loaded');
  const sw = await openSession(swTarget.webSocketDebuggerUrl);
  sessions.push(sw);
  await sw.send('Runtime.enable');
  out.serviceWorkerAttached = true;

  /**
   * Drives ONE real tab to a URL and reads the live page state back out of it.
   * (A service-worker CDP session may not call Target.createTarget, so the
   * browser's own about:blank tab is reused — the same tab the 17.1 harness
   * used.)
   */
  const pageTarget = (await cdpGet(CDP_PORT, '/json/list'))
    .find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pageTarget) throw new Error('no page target');
  const page = await openSession(pageTarget.webSocketDebuggerUrl);
  sessions.push(page);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  const openAndObserve = async (url) => {
    try { await page.send('Page.navigate', { url }); } catch { /* refused navigation */ }
    await sleep(1800);

    // Read the URL and the DOM shape back OUT of the live tab.
    const read = await page.send('Runtime.evaluate', {
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => {
        const sel = ['#transaction-table', '#results', '#account-number', '#pricing-marker', '[data-marker]'];
        return {
          url: location.href,
          title: document.title,
          markers: sel.filter((s) => document.querySelector(s)),
          domElementCount: document.querySelectorAll('*').length,
        };
      })()`,
    });
    return read.result.value;
  };

  /* ── CASE 1: an action request alone does not produce goal success ─────── */
  const home = await openAndObserve(`${ORIGIN}/`);
  out.cases.case1_action_request_alone = {
    question: 'Does a long, successful-looking action history establish a goal?',
    realObservation: home,
    fabricatedSignals: {
      previousActions: [
        { action: 'click', target: 'search-box' },
        { action: 'click', target: 'search-submit' },
        { action: 'scroll', direction: 'down', amount: 1200 },
      ],
      steps: [
        { step: 1, action: { action: 'click' }, executionSuccess: true, url: home.url, navigationDestination: '/transactions' },
        { step: 2, action: { action: 'scroll' }, executionSuccess: true, url: home.url, navigationDestination: '/transactions' },
        { step: 3, action: { action: 'click' }, executionSuccess: true, url: home.url, navigationDestination: '/transactions' },
      ],
      visitedElementIds: ['acct-1', 'search-box'],
      reason: 'Clicked the details button; the account details view is now open.',
    },
    task: 'open the account details and find the recent transactions',
    verdict: null,
  };
  const c1 = verifyTaskGoal(
    'open the account details and find the recent transactions',
    state({ ...out.cases.case1_action_request_alone.fabricatedSignals, currentUrl: home.url }),
    {
      sanitized_status: 'sanitized_only',
      url: home.url,
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      detections: [],
    }
  );
  out.cases.case1_action_request_alone.verdict = { satisfied: c1.satisfied, status: c1.status, reason: c1.reason ?? null };
  out.cases.case1_action_request_alone.expectation = 'satisfied === false (no transaction surface is OBSERVED on the real page)';
  out.cases.case1_action_request_alone.pass = c1.satisfied === false;

  /* ── CASE 2: a navigation that never commits ──────────────────────────── */
  // The agent REQUESTS a results URL. The browser is pointed at a dead origin,
  // so the navigation cannot commit. What the tab actually holds afterwards is
  // read back from Chrome, and the requested destination is then offered to the
  // goal verifier as `navigationDestination` + `action.url`.
  const dead = await openAndObserve(`${DEAD_ORIGIN}/results?q=cats`);
  out.cases.case2_failed_navigation = {
    question: 'Does a requested URL that never committed establish a search goal?',
    requestedUrl: `${DEAD_ORIGIN}/results?q=cats`,
    realObservationAfterRequest: dead,
    note: 'The requested origin refused the connection; the tab did not navigate there.',
    fabricatedSignals: {
      steps: [
        {
          step: 1,
          action: { action: 'navigate', url: `${DEAD_ORIGIN}/results?q=cats` },
          executionSuccess: true,
          url: dead.url,
          navigationDestination: `${DEAD_ORIGIN}/results?q=cats`,
        },
      ],
      currentUrl: dead.url,
    },
    task: 'search for cats',
    verdict: null,
  };
  const c2 = verifyTaskGoal(
    'search for cats',
    state(out.cases.case2_failed_navigation.fabricatedSignals),
    {
      sanitized_status: 'sanitized_only',
      url: dead.url,
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      detections: [],
    }
  );
  out.cases.case2_failed_navigation.verdict = { satisfied: c2.satisfied, status: c2.status, reason: c2.reason ?? null };
  out.cases.case2_failed_navigation.expectation = 'satisfied === false (the requested q= is an INTENT, never an observation)';
  out.cases.case2_failed_navigation.pass = c2.satisfied === false;

  /* ── CASE 3: a genuinely observed state still reaches the valid path ───── */
  const results = await openAndObserve(`${ORIGIN}/results?q=cats`);
  out.cases.case3_observed_success = {
    question: 'Does a real observation still produce the existing valid success?',
    realObservation: results,
    task: 'search for cats',
    verdict: null,
  };
  const c3 = verifyTaskGoal(
    'search for cats',
    state({ currentUrl: results.url }),
    {
      sanitized_status: 'sanitized_only',
      url: results.url,
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      detections: [],
    }
  );
  out.cases.case3_observed_success.verdict = { satisfied: c3.satisfied, status: c3.status, reason: c3.reason ?? null };
  out.cases.case3_observed_success.expectation = "satisfied === true, from the OBSERVED q= in the live tab URL";
  out.cases.case3_observed_success.pass = c3.satisfied === true;

  out.summary = {
    allPass: Object.values(out.cases).every((c) => c.pass === true),
    cases: Object.fromEntries(Object.entries(out.cases).map(([k, v]) => [k, v.pass])),
  };
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
  out.summary = { allPass: false, error: out.error };
} finally {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  await tidy();
}

console.log(JSON.stringify(out.summary, null, 2));
process.exit(out.summary.allPass ? 0 : 1);
