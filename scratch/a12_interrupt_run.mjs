/**
 * PHASE 18.8 / A12 — CANCELLATION / INTERRUPTION, real Chrome.
 *
 * What this proves, and nothing more:
 *   1. task A starts and keeps running;
 *   2. task B is submitted while A is ACTIVE;
 *   3. A is cancelled (SUPERSEDED) and stops — no further action of A executes;
 *   4. A's provider response, held back past the interrupt, is DISCARDED;
 *   5. B owns the active state and produces its own terminal result;
 *   6. A's terminal result never overwrites B's.
 *
 * The provider is CONTROLLED (scratch/i8a7a8_controlled_provider.py, STUB_MODE=
 * interrupt_demo): the "slowly" task's response is deliberately late. This is
 * not a live-provider claim.
 *
 * Run: ST_CDP_PORT=9861 ST_OUT=p188_A12_raw.json node scratch/a12_interrupt_run.mjs
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

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9861);
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const CATALOG = 'http://localhost:4174/results.html';
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 45000);
const GAP_MS = Number(process.env.ST_GAP_MS || 2500);
const OUT = process.env.ST_OUT || 'p188_A12_raw.json';

const TASK_A = 'Go down the page slowly step by step.';
const TASK_B = 'Tell me about the products.';

const out = {
  phase: '18.8-A12',
  work: 'Cancellation / interruption under a late provider response — real Chrome',
  labels: process.env.ST_LABELS || 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER',
  inputs: { taskA: TASK_A, taskB: TASK_B, gapMs: GAP_MS, catalog: CATALOG },
  environment: {},
  swLogs: [],
  events: [],
};

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

const chrome = launchChrome(CDP_PORT);
let bs;
let page;
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

  const fixtureTab = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(CATALOG)}`, 'PUT');
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

  // Capture EVERY task-progress the dashboard receives, in order, with the runId
  // the worker stamped on it — this is how "A never overwrites B" is observed.
  await page.send('Runtime.evaluate', {
    expression: `
      window.__a12 = [];
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.source !== 'privagent-extension') return;
        if (d.type !== 'TASK_PROGRESS' || !d.payload) return;
        const p = d.payload;
        window.__a12.push({
          t: Date.now(), runId: p.runId ?? null, status: p.status, task: p.task || null,
          steps: Array.isArray(p.steps) ? p.steps.length : 0,
          cancellationCode: p.cancellationCode || (p.interaction ? p.interaction.cancellationCode : null) || null,
          finalResult: p.interaction ? p.interaction.finalResult || null : null,
        });
      });
      true;
    `,
    returnByValue: true,
  });

  const submit = async (task) =>
    page.send('Runtime.evaluate', {
      expression: `
        (() => {
          const ta = document.getElementById('composer-input');
          const btn = document.getElementById('composer-btn-run');
          if (!ta || !btn) return 'controls-missing';
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, ${JSON.stringify(task)});
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          btn.click();
          return 'submitted';
        })()
      `,
      returnByValue: true,
    });

  const snapshot = async () => {
    const raw = await page.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__a12 || [])',
      returnByValue: true,
    });
    try { return JSON.parse(raw?.result?.value || '[]'); } catch { return []; }
  };

  // ── 1. start task A, then interrupt it with B mid-flight ────────────────
  await submit(TASK_A);
  out.events.push({ t: at(), what: 'task A submitted', task: TASK_A });
  await sleep(GAP_MS);
  const beforeB = (await snapshot()).length;
  await submit(TASK_B);
  out.events.push({ t: at(), what: 'task B submitted (interrupt)', task: TASK_B, eventsBefore: beforeB });

  const deadline = Date.now() + SETTLE_MS;
  let events = [];
  while (Date.now() < deadline) {
    await sleep(1200);
    events = await snapshot();
    const terminalRunIds = new Set(
      events
        .filter((e) => ['SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL', 'CANNOT_VERIFY', 'NEEDS_INFORMATION', 'NEEDS_CLARIFICATION', 'PROVIDER_UNAVAILABLE'].includes(e.status))
        .map((e) => e.runId)
    );
    if (terminalRunIds.size >= 2) break;
  }

  const body = await page.send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText.slice(0, 2000) : ""',
    returnByValue: true,
  });
  out.events = events;
  out.dashboardBodyExcerpt = String(body?.result?.value || '').slice(0, 1200);
} finally {
  try { bs?.close?.(); } catch { /* ignore */ }
  try { page?.close?.(); } catch { /* ignore */ }
  try { chrome?.close?.(); } catch { /* ignore */ }
}

const outDir = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit');
fs.writeFileSync(path.join(outDir, OUT), JSON.stringify(out, null, 2));
console.log(`wrote docs/evidence/post-17-10/audit/${OUT}`);
for (const e of out.events.slice(-8)) console.log('  ', JSON.stringify(e).slice(0, 190));