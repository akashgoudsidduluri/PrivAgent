/**
 * PHASE 18.8 / A14 — UNCERTAIN COMMIT, real Chrome.
 *
 * What this proves, and nothing more:
 *   1. the task runs and one consequential control really is clicked;
 *   2. that click leaves NO observable trace (the fixture renders nothing,
 *      navigates nowhere, and moves no focus) — so the agent cannot establish
 *      whether the send happened;
 *   3. the same control is proposed again by the provider and is NOT dispatched:
 *      the page-side counter stays at exactly 1;
 *   4. the run ends in the TYPED terminal state COMMIT_UNKNOWN, and the
 *      dashboard shows an honest, user-readable outcome instead of a running
 *      session;
 *   5. the trace shows the typed commit record and the blocked dispatch.
 *
 * The provider is CONTROLLED (scratch/i8a7a8_controlled_provider.py,
 * STUB_MODE=commit_demo): it proposes the same control on every call. This is
 * not a live-provider claim.
 *
 * Run: ST_CDP_PORT=9862 ST_OUT=p188_A14_raw.json node scratch/a14_commit_run.mjs
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

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9862);
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const FIXTURE = process.env.ST_FIXTURE || 'http://localhost:4174/enquiry.html';
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 60000);
const OUT = process.env.ST_OUT || 'p188_A14_raw.json';
const TASK = process.env.ST_TASK || 'Reply to the order enquiry shown on this page.';

const TERMINAL = [
  'SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL', 'CANNOT_VERIFY',
  'NEEDS_INFORMATION', 'NEEDS_CLARIFICATION', 'PROVIDER_UNAVAILABLE',
  'COMMIT_UNKNOWN',
];

const out = {
  phase: '18.8-A14',
  work: 'Uncertain commit: an unconfirmed consequential action is never re-dispatched — real Chrome',
  labels: process.env.ST_LABELS || 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER',
  inputs: { task: TASK, fixture: FIXTURE, provider: 'controlled stub mode=commit_demo' },
  environment: {},
  swLogs: [],
  events: [],
};

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

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
      window.__a14 = [];
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.source !== 'privagent-extension') return;
        if (d.type !== 'TASK_PROGRESS' || !d.payload) return;
        const p = d.payload;
        window.__a14.push({
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

  const counter = async () =>
    fixtureTab
      .send('Runtime.evaluate', {
        expression: 'JSON.stringify({ clicks: window.__a14Enquiries ?? null, url: location.href })',
        returnByValue: true,
      })
      .then((r) => {
        try { return JSON.parse(r?.result?.value || '{}'); } catch { return {}; }
      });

  out.events.push({ t: at(), what: 'fixture opened', detail: await counter() });

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

  const deadline = Date.now() + SETTLE_MS;
  let events = [];
  let clicksSeenAtTerminal = null;
  while (Date.now() < deadline) {
    await sleep(1500);
    const raw = await page.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__a14 || [])',
      returnByValue: true,
    });
    try { events = JSON.parse(raw?.result?.value || '[]'); } catch { events = []; }
    if (events.some((e) => TERMINAL.includes(e.status))) {
      clicksSeenAtTerminal = await counter();
      break;
    }
  }

  // A short grace period AFTER the terminal event: if the agent were going to
  // send second thoughts, this is when they would land.
  await sleep(4000);
  const clicksAfterSettle = await counter();

  const body = await page.send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText.slice(0, 3000) : ""',
    returnByValue: true,
  });
  out.events = events;
  out.fixture = { atTerminal: clicksSeenAtTerminal, afterSettle: clicksAfterSettle };
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
for (const e of out.events.slice(-6)) console.log('  ', JSON.stringify(e).slice(0, 220));
