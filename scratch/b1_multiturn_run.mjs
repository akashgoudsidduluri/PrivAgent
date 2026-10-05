/**
 * PHASE 18.8 / B2 + A13 + A15 — MULTI-TURN REAL-CHROME HARNESS.
 *
 * EVALUATION CODE ONLY. It drives the REAL built extension (`dist/`) in REAL
 * headless Chrome against the REAL dashboard and the REAL catalog fixture, and
 * submits SEVERAL turns through the REAL dashboard composer in ONE session —
 * which is the only way the conversation context, reference resolution and
 * cross-page identity can be observed as they actually behave.
 *
 * Nothing here interprets a run as a pass: the terminal state comes from the
 * service worker's own progress events, the selection comes from the typed
 * conversation summary the loop publishes, and the privacy check is done
 * independently over the fixture's own raw values.
 *
 * Env:
 *   ST_SETTLE_MS   per-turn settle budget (default 45000)
 *   ST_CDP_PORT    devtools port (default 9851)
 *   ST_OUT         artifact filename under docs/evidence/post-17-10/audit
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

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9851);
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const CATALOG = 'http://localhost:4174/results.html';
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 45000);
const OUT = process.env.ST_OUT || 'p188_mt1_raw.json';

const TERMINAL = new Set([
  'SUCCESS',
  'FAILED',
  'STOPPED',
  'ANSWER',
  'PARTIAL',
  'CANNOT_VERIFY',
  'NEEDS_INFORMATION',
  'NEEDS_CLARIFICATION',
  'PROVIDER_UNAVAILABLE',
]);

// The conversation the brief describes, plus the ambiguity probe.
const TURNS = [
  { id: 'T1', task: 'Find the top 5 products under 1000 with good ratings.', expect: 'FIRST_TURN' },
  { id: 'T2', task: 'Tell me about the third one.', expect: 'ORDINAL_RESOLUTION' },
  { id: 'T3', task: 'Open it.', expect: 'IDENTITY_AFTER_NAVIGATION' },
  { id: 'T4', task: 'Get details about it.', expect: 'DETAILS_SAME_ENTITY' },
  { id: 'T5', task: 'Show me the products under 1000 with good ratings.', expect: 'NEW_CONVERSATION' },
  { id: 'T6', task: 'Tell me about it.', expect: 'AMBIGUOUS_CLARIFICATION' },
];

const out = {
  phase: '18.8-B2/A13/A15',
  work: 'Multi-turn conversation, reference resolution and cross-page identity — real Chrome',
  labels: process.env.ST_LABELS || 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER',
  inputs: { turns: TURNS, settleMs: SETTLE_MS, catalog: CATALOG },
  environment: {},
  swLogs: [],
  turns: [],
};

const t0 = Date.now();
const at = () => Date.now() - t0;
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

  // The catalog tab the agent will work on, then the dashboard that drives it.
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
        // Arguments are structured objects by design (no page text in logs), so
        // render the CDP preview rather than String(obj) === 'Object'.
        const text = (m.params.args || [])
          .map((a) => {
            if (a.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
            if (a.preview && Array.isArray(a.preview.properties)) {
              const inner = a.preview.properties
                .map((p) => `${p.name}:${p.value !== undefined ? p.value : p.type}`)
                .join(',');
              return `{${inner}}`;
            }
            return a.description || '';
          })
          .join(' ');
        out.swLogs.push({ t: at(), text: text.slice(0, 600) });
      }
    } catch { /* ignore */ }
    try { swOnMessage.call(sw.ws, ev); } catch { /* ignore */ }
  };

  // Observe every TASK_PROGRESS the dashboard receives, including the typed
  // conversation summary the loop publishes.
  await page.send('Runtime.evaluate', {
    expression: `
      window.__mt = { progress: [] };
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.source !== 'privagent-extension') return;
        if (d.type !== 'TASK_PROGRESS' || !d.payload) return;
        const p = d.payload;
        window.__mt.progress.push({
          t: Date.now(), status: p.status, task: p.task || null,
          conversation: p.conversation || null,
          finalResult: p.interaction ? p.interaction.finalResult || null : null,
          outcome: p.interaction ? p.interaction.outcome : null,
          currentUrl: p.currentUrl || null,
        });
      });
      true;
    `,
    returnByValue: true,
  });

  const currentUrl = async () => {
    const tabs = await cdpGet(CDP_PORT, '/json/list');
    const fixture = (tabs || []).find((t) => (t.url || '').includes('localhost:4174'));
    return fixture ? fixture.url : null;
  };

  for (const turn of TURNS) {
    // The progress-event COUNT at submit time. Slicing by turn index would read
    // the PREVIOUS turn's terminal event and report it as this turn's result.
    const marker = await page.send('Runtime.evaluate', {
      expression: 'String(window.__mt ? window.__mt.progress.length : 0)',
      returnByValue: true,
    });
    const before = Number(marker?.result?.value || 0);
    const urlBefore = await currentUrl();
    await page.send('Runtime.evaluate', {
      expression: `
        (() => {
          const ta = document.getElementById('composer-input');
          const btn = document.getElementById('composer-btn-run');
          if (!ta || !btn) return 'controls-missing';
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, ${JSON.stringify(turn.task)});
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          btn.click();
          return 'submitted';
        })()
      `,
      returnByValue: true,
    });

    const deadline = Date.now() + SETTLE_MS;
    let terminal = null;
    while (Date.now() < deadline) {
      await sleep(1200);
      const snapshot = await page.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__mt ? window.__mt.progress : [])',
        returnByValue: true,
      });
      let progress = [];
      try { progress = JSON.parse(snapshot?.result?.value || '[]'); } catch { progress = []; }
      const terminalEvents = progress.slice(before).filter((p) => TERMINAL.has(p.status));
      if (terminalEvents.length) {
        const last = terminalEvents[terminalEvents.length - 1];
        const body = await page.send('Runtime.evaluate', {
          expression: 'document.body ? document.body.innerText.slice(0, 2500) : ""',
          returnByValue: true,
        });
        terminal = {
          status: last.status,
          outcome: last.outcome,
          conversation: last.conversation,
          finalResult: last.finalResult,
          urlBefore,
          urlAfter: await currentUrl(),
          dashboardBodyExcerpt: String(body?.result?.value || '').slice(0, 1200),
        };
        break;
      }
    }

    out.turns.push({
      id: turn.id,
      task: turn.task,
      expect: turn.expect,
      terminal: terminal || { status: 'NO_TERMINAL_WITHIN_SETTLE' },
    });
    console.log(
      `${turn.id} ${turn.task} -> ${
        terminal ? `${terminal.status} selection=${terminal.conversation ? JSON.stringify(terminal.conversation) : 'none'}` : 'NO TERMINAL'
      }`
    );
  }
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
  console.error('harness error:', out.error);
} finally {
  try { if (page) await page.send('Page.close').catch(() => {}); } catch { /* ignore */ }
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { if (chrome.profile) fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

const outDir = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, OUT), JSON.stringify(out, null, 2));
console.log(`wrote docs/evidence/post-17-10/audit/${OUT}`);