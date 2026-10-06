/**
 * PHASE 18.8 / A16 — PRE-ACTION STATE FRESHNESS, real Chrome.
 *
 * What this proves, and nothing more:
 *   1. the task runs against a real local fixture page and the agent really
 *      prepares a CONSEQUENTIAL step on it (the plan is a click on the page's
 *      own send control, chosen from what the device reported);
 *   2. while the agent is still waiting for the plan to come back, the PAGE
 *      ITSELF performs a real navigation to a different document;
 *   3. the observation the agent makes immediately before dispatch reports the
 *      NEW url, which disagrees with the view the step was planned on — so the
 *      freshness gate stops the run and the action is NEVER dispatched;
 *   4. the destination document carries the SAME control id, so a blind dispatch
 *      would have visibly landed: the page-side count (sessionStorage, which
 *      survives the navigation) stays at exactly 0;
 *   5. the run ends in the TYPED terminal state FRESHNESS_UNVERIFIED with
 *      user-readable copy and no internal code;
 *   6. the trace shows the assessed verdict, the blocked dispatch, and ZERO
 *      executed actions for the whole run.
 *
 * The provider is CONTROLLED (scratch/i8a7a8_controlled_provider.py,
 * STUB_MODE=freshness_demo): it proposes the page's own send control and holds
 * its first answer open long enough for the navigation to land. This is not a
 * live-provider claim.
 *
 * Run: ST_CDP_PORT=9863 ST_OUT=p188_A16_raw.json node scratch/a16_freshness_run.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  sleep,
  cdpGet,
  openSession,
  launchChrome,
  attachServiceWorker,
} from './phase16_cdp.mjs';

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9863);
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const AFTER_MS = Number(process.env.ST_AFTER_MS || 9000);
const FIXTURE = process.env.ST_FIXTURE || `http://localhost:4174/freshness.html?after=${AFTER_MS}`;
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 90000);
const OUT = process.env.ST_OUT || 'p188_A16_raw.json';
// The same wording the A14 real-Chrome run used. It names the target directly:
// a task that says "this page" is an anaphoric reference, and the B1 reference
// resolver legitimately refuses it before any step is planned — which would stop
// the run for a reason unrelated to freshness and prove nothing here.
const TASK = process.env.ST_TASK || 'Send an enquiry';
const GATEWAY = process.env.ST_GATEWAY || 'http://127.0.0.1:8010';
const MODE = process.env.ST_MODE || 'freshness_demo';

const TERMINAL = [
  'SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL', 'CANNOT_VERIFY',
  'NEEDS_INFORMATION', 'NEEDS_CLARIFICATION', 'PROVIDER_UNAVAILABLE',
  'COMMIT_UNKNOWN', 'FRESHNESS_UNVERIFIED',
];

const out = {
  phase: '18.8-A16',
  work: 'Pre-action state freshness: a step is never dispatched against a view the device no longer sees — real Chrome',
  labels: process.env.ST_LABELS || 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER',
  inputs: {
    task: TASK,
    fixture: FIXTURE,
    fixtureNavigatesAfterMs: AFTER_MS,
    provider: `controlled stub mode=${MODE}`,
    gateway: GATEWAY,
  },
  environment: {},
  stub: null,
  timeline: [],
  swLogs: [],
  events: [],
};

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const note = (what, detail) => out.timeline.push({ t: at(), what, ...(detail ? { detail } : {}) });

// The controlled provider is switched by the harness, never by the page: the
// endpoint also resets the call counter, so "the FIRST call" is per scenario.
try {
  const res = await fetch(`${GATEWAY}/mode?set=${MODE}`);
  out.stub = await res.json();
} catch (err) {
  out.stub = { error: String(err && err.message ? err.message : err) };
}
note('controlled provider mode set', out.stub);

const chrome = launchChrome(CDP_PORT);
let bs;
let page;
let fixtureTab;
let sw;
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

  const fixture = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(FIXTURE)}`, 'PUT');
  fixtureTab = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${fixture.id}`);
  await fixtureTab.send('Runtime.enable');
  await fixtureTab.send('Page.enable');
  await sleep(1500);

  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(3500);

  sw = await attachServiceWorker(CDP_PORT);
  if (!sw) throw new Error('service worker not found');
  await sw.send('Runtime.enable', {});

  const swOnMessage = sw.ws.onmessage;
  sw.ws.onmessage = async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || [])
          .map((a) => {
            if (a.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
            if (a.preview && Array.isArray(a.preview.properties)) {
              return `{${a.preview.properties.map((p) => `${p.name}:${p.value !== undefined ? p.value : p.type}`).join(',')}}`;
            }
            return a.description || '';
          })
          .join(' ');
        out.swLogs.push({ t: at(), text: text.slice(0, 600) });
      }
    } catch { /* ignore */ }
    try { swOnMessage.call(sw.ws, ev); } catch { /* ignore */ }
  };

  await page.send('Runtime.evaluate', {
    expression: `
      window.__a16 = [];
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.source !== 'privagent-extension') return;
        if (d.type !== 'TASK_PROGRESS' || !d.payload) return;
        const p = d.payload;
        window.__a16.push({
          t: Date.now(), runId: p.runId ?? null, status: p.status, task: p.task || null,
          steps: Array.isArray(p.steps) ? p.steps.length : 0,
          finalResult: p.interaction ? p.interaction.finalResult || null : null,
          terminal: p.interaction ? p.interaction.terminal || null : null,
        });
      });
      true;
    `,
    returnByValue: true,
  });

  /**
   * Read the FIXTURE through its own page, not through the agent: the url, the
   * click count (sessionStorage, so it survives the navigation), and whether the
   * consequential control still exists in the CURRENT document.
   */
  const reading = async () =>
    fixtureTab
      .send('Runtime.evaluate', {
        expression: `JSON.stringify({
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          clicks: (function () { try { return Number(sessionStorage.getItem('__a16Clicks')); } catch (e) { return null; } })(),
          controlPresent: !!document.getElementById('btn-send-enquiry')
        })`,
        returnByValue: true,
      })
      .then((r) => {
        try { return JSON.parse(r?.result?.value || '{}'); } catch { return {}; }
      });

  // Restart the fixture's own clock: a fresh navigation means the page's timer
  // begins now, so the move is deterministic relative to the task submission.
  await fixtureTab.send('Page.navigate', { url: FIXTURE });
  await sleep(1200);
  const preRun = await reading();
  note('fixture loaded (page will move on its own)', preRun);

  await page.send('Runtime.evaluate', {
    expression: `
      (() => {
        const ta = document.getElementById('composer-input');
        const btn = document.getElementById('composer-btn-run');
        if (!ta || !btn) return 'controls-missing';
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(TASK)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        btn.click();
        return 'submitted';
      })()
    `,
    returnByValue: true,
  });
  out.events.push({ t: at(), what: 'task submitted', task: TASK });
  note('task submitted', { task: TASK });

  const deadline = Date.now() + SETTLE_MS;
  let events = [];
  let atTerminal = null;
  while (Date.now() < deadline) {
    await sleep(1500);
    const raw = await page.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__a16 || [])',
      returnByValue: true,
    });
    try { events = JSON.parse(raw?.result?.value || '[]'); } catch { events = []; }
    if (events.some((e) => TERMINAL.includes(e.status))) {
      atTerminal = await reading();
      note('terminal event observed', { status: events[events.length - 1]?.status ?? null, fixture: atTerminal });
      break;
    }
  }

  // A short grace period AFTER the terminal event: if the agent were going to
  // dispatch the stale plan after all, this is when it would land.
  await sleep(4000);
  const afterSettle = await reading();
  note('fixture re-read after a 4s grace period', afterSettle);

  const body = await page.send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText.slice(0, 3000) : ""',
    returnByValue: true,
  });
  out.events = events;
  out.fixture = { preRun, atTerminal, afterSettle };
  out.dashboardBodyExcerpt = String(body?.result?.value || '').slice(0, 2000);
} finally {
  try { bs?.close?.(); } catch { /* ignore */ }
  try { page?.close?.(); } catch { /* ignore */ }
  try { fixtureTab?.close?.(); } catch { /* ignore */ }
  try { chrome?.close?.(); } catch { /* ignore */ }
}

const outDir = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit');
fs.writeFileSync(path.join(outDir, OUT), JSON.stringify(out, null, 2));
console.log(`wrote docs/evidence/post-17-10/audit/${OUT}`);
console.log('  fixture:', JSON.stringify(out.fixture));
console.log('  timeline:', JSON.stringify(out.timeline.map((s) => `${s.t}: ${s.what}`)));
for (const e of out.events.slice(-4)) console.log('  ', JSON.stringify(e).slice(0, 200));
// Explicit exit: the keep-alive socket from the mode request above would
// otherwise hold the event loop open long after the evidence is on disk.
process.exit(0);
