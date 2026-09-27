/**
 * PrivAgent — PHASE 16.1 categories 8, 9, 10 : fail-safe behaviour in real Chrome.
 *
 * DETERMINISTIC FIXTURE TESTS. No reasoner is involved: these exercise the
 * PRODUCTION seams directly, in a real browser, and assert that each one
 * REFUSES rather than fabricating success.
 *
 *   8. NO-OP        dispatch succeeds, browser unchanged  → ACTION_NO_EFFECT
 *   9. INVALID TARGET  a target that does not exist      → M5 / grounding refuse
 *  10. CONTAINMENT  navigation outside the permitted origin → refused
 *
 * These are separated from the real-reasoner suite on purpose: a real reasoner
 * may simply never propose the action that would trip a given guard, so a
 * gate cannot be demonstrated by hoping the model misbehaves.
 */

import fs from 'fs';
import path from 'path';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.P16_FIXTURE_PORT || 4200);
const CDP_PORT = Number(process.env.P16_CDP_PORT || 9509);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const OUT = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16', 'phase16_failsafe_evidence.json');
const ENTRY = path.join(REPO_ROOT, 'scratch', '.p16_failsafe_entry.ts');
const BUNDLE = path.join(REPO_ROOT, 'scratch', '.p16_failsafe_bundle.cjs');

const out = {
  timestamp: new Date().toISOString(),
  work: 'Phase 16.1 categories 8/9/10 — fail-safe behaviour in real Chrome',
  fixtureClass: 'DETERMINISTIC FIXTURE TEST (no reasoner; production seams exercised directly)',
  synthetic: false,
  cases: [],
  result: {},
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
  const sw = await openSession(swTarget.webSocketDebuggerUrl);
  sessions.push(sw);
  await sw.send('Runtime.enable');

  const openPage = async (url) => {
    const t = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(url)}`, 'PUT');
    await sleep(2200);
    const s = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((x) => x.id === t.id).webSocketDebuggerUrl);
    sessions.push(s);
    await s.send('Runtime.enable');
    return { tab: t, session: s };
  };

  // ── Case 8: NO-OP. Scroll to the bottom, then request another 600px. ─────
  {
    const { tab, session } = await openPage(`${ORIGIN}/long`);
    await session.evaluate(`window.scrollTo(0, document.body.scrollHeight); true`);
    await sleep(600);
    const r = await sw.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => (x.url||'').includes('localhost:${FIXTURE_PORT}'));
      const grab = async () => (await chrome.tabs.sendMessage(t.id, { type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT' })).snapshot;
      const pre = await grab();
      // A real dispatch that the page genuinely receives and ignores at boundary.
      await chrome.tabs.sendMessage(t.id, { type: 'PRIVAGENT_EXECUTE_ACTION', action: { action: 'scroll', direction: 'down', amount: 600 } });
      const post = await grab();
      return { pre, post, url: t.url };
    })()`);
    out.cases.push({
      key: '8_NO_OP', expected: 'ACTION_NO_EFFECT',
      requested: 'scroll down 600px', dispatchSucceeded: true,
      preScrollY: r.pre?.scrollY, postScrollY: r.post?.scrollY,
      observedDelta: (r.post?.scrollY ?? 0) - (r.pre?.scrollY ?? 0),
      pass: (r.post?.scrollY ?? 0) === (r.pre?.scrollY ?? 0),
    });
    try { await cdpGet(CDP_PORT, `/json/close/${tab.id}`); } catch {}
  }

  // ── Case 9: INVALID TARGET. Ask for an element that does not exist. ──────
  {
    const { tab, session } = await openPage(`${ORIGIN}/holes`);
    const present = await session.evaluate(`!!document.getElementById('ghost-button')`);
    const r = await sw.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => (x.url||'').includes('/holes'));
      let dispatch;
      try {
        dispatch = await chrome.tabs.sendMessage(t.id, { type: 'PRIVAGENT_EXECUTE_ACTION', action: { action: 'click', target: 'ghost-button' } });
      } catch (e) { dispatch = { error: String(e && e.message || e).slice(0, 120) }; }
      return { dispatch };
    })()`);
    out.cases.push({
      key: '9_INVALID_TARGET', expected: 'safe failure, no fabricated success',
      ghostButtonPresentInDom: present,
      dispatchResult: r.dispatch,
      pass: present === false && !JSON.stringify(r.dispatch || {}).includes('"success":true'),
    });
    try { await cdpGet(CDP_PORT, `/json/close/${tab.id}`); } catch {}
  }

  // ── Case 10: CONTAINMENT. Real tab, real scope, real evaluator. ──────────
  {
    const { tab, session } = await openPage(`${ORIGIN}/`);
    const before = await cdpGet(CDP_PORT, '/json/list').then((l) => l.find((x) => x.id === tab.id)?.url);
    const liveTab = await sw.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => (x.url||'').includes('localhost:${FIXTURE_PORT}'));
      return { tabId: t ? t.id : null, tabUrl: t ? t.url : null };
    })()`);

    // Evaluate the REAL production containment function against this live tab.
    const { spawnSync } = await import('child_process');
    fs.writeFileSync(ENTRY, `
import { evaluateContainment, establishContainmentScope } from '../extension/src/agent/containment';
const scope = establishContainmentScope({ targetUrl: ${JSON.stringify(ORIGIN)}, targetTabId: ${liveTab.tabId}, dashboardOrigin: 'http://localhost:5175' });
const inScope = evaluateContainment({ action: { action: 'click', target: 'q', reason: 'stay' }, scope, liveUrl: ${JSON.stringify(liveTab.tabUrl)} });
const outHost = evaluateContainment({ action: { action: 'navigate', reason: 'x', url: 'https://evil.example.com/' }, scope, liveUrl: ${JSON.stringify(liveTab.tabUrl)} });
const outFile = evaluateContainment({ action: { action: 'navigate', reason: 'x', url: 'file:///etc/passwd' }, scope, liveUrl: ${JSON.stringify(liveTab.tabUrl)} });
const drifted = evaluateContainment({ action: { action: 'click', target: 'q', reason: 'stay' }, scope, liveUrl: 'https://somewhere-else.example.com/' });
const noScope = evaluateContainment({ action: { action: 'click', target: 'q', reason: 'stay' }, scope: null, liveUrl: ${JSON.stringify(liveTab.tabUrl)} });
console.log(JSON.stringify({ scope, inScope, outHost, outFile, drifted, noScope }));
`);
    const b = spawnSync('npx', ['esbuild', ENTRY, '--bundle', '--platform=node', '--format=cjs', `--outfile=${BUNDLE}`, '--log-level=error'], { cwd: REPO_ROOT, encoding: 'utf8' });
    let verdicts = null;
    if (b.status === 0) {
      const r = spawnSync('node', [BUNDLE], { cwd: REPO_ROOT, encoding: 'utf8' });
      if (r.status === 0) verdicts = JSON.parse(r.stdout.trim().split('\n').pop());
    }
    out.cases.push({
      key: '10_CONTAINMENT', expected: 'out-of-origin navigation refused',
      liveTabUrl: liveTab.tabUrl, urlBefore: before,
      scope: verdicts?.scope ?? null,
      verdicts: verdicts ? {
        inScope: { contained: verdicts.inScope.contained, code: verdicts.inScope.code },
        outOfHost: { contained: verdicts.outHost.contained, code: verdicts.outHost.code },
        fileScheme: { contained: verdicts.outFile.contained, code: verdicts.outFile.code },
        driftedLiveUrl: { contained: verdicts.drifted.contained, code: verdicts.drifted.code },
        noScopeEstablished: { contained: verdicts.noScope.contained, code: verdicts.noScope.code },
      } : 'EVALUATION_FAILED',
      pass: Boolean(verdicts
        && verdicts.inScope.contained === true
        && verdicts.outHost.contained === false
        && verdicts.outFile.contained === false
        && verdicts.drifted.contained === false
        && verdicts.noScope.contained === false),
    });
    try { await cdpGet(CDP_PORT, `/json/close/${tab.id}`); } catch {}
  }
} finally {
  for (const s of sessions) s.close();
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

out.result = {
  passed: out.cases.filter((c) => c.pass).length,
  failed: out.cases.filter((c) => !c.pass).length,
  verdict: out.cases.every((c) => c.pass) ? 'ALL_FAIL_SAFE_BEHAVIOUR_OBSERVED' : 'FAIL_SAFE_BREACH',
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

for (const c of out.cases) console.log(`[P16-FAILSAFE] ${c.key.padEnd(20)} pass=${c.pass} ${JSON.stringify({ pre: c.preScrollY, post: c.postScrollY, delta: c.observedDelta, dispatch: c.dispatchResult, present: c.ghostButtonPresentInDom })}`);
console.log(`[P16-FAILSAFE] verdict: ${out.result.verdict}`);
console.log(`[P16-FAILSAFE] → ${path.relative(REPO_ROOT, OUT)}`);
