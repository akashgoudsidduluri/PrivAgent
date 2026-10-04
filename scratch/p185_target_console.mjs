/**
 * PHASE I-7 — READ ONLY FORENSIC.
 *
 * Closes the gap left by the previous probe: the content script logs WHY the
 * world model / semantic understanding failed via console.warn, and every
 * earlier harness only listened on the SERVICE WORKER and the DASHBOARD tab —
 * never on the TARGET TAB itself.
 *
 * A content script runs in an isolated world of the target page's target, so
 * its console arrives on THAT target's Runtime domain. We therefore enable
 * Runtime on the Wikipedia tab before navigating and record every context.
 *
 * Changes no production code. Read-only.
 *
 * Env: ST_TASK, ST_PROBE_URL, ST_CDP_PORT, ST_SETTLE_MS
 */
import fs from 'fs';
import path from 'path';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome, attachServiceWorker } from './phase16_cdp.mjs';

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9891);
const FIXTURE_PORT = Number(process.env.ST_FIXTURE_PORT || 4174);
const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const URL_UNDER_TEST = process.env.ST_PROBE_URL || 'https://en.wikipedia.org/wiki/Charminar';
const TASK = process.env.ST_TASK || 'open wikipedia and find information about charminar';
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 40000);

const out = { url: URL_UNDER_TEST, task: TASK, targetTabLogs: [], swLogs: [] };

const chrome = launchChrome(CDP_PORT);
let bs, page, dash, targetTab, sw;
try {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
  }
  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });

  // Dashboard tab, as usual.
  const dashCreated = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`http://localhost:${DASHBOARD_PORT}/`)}`, 'PUT');
  dash = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${dashCreated.id}`);
  await dash.send('Page.enable');
  await dash.send('Runtime.enable');
  await sleep(3500);

  // The TARGET TAB. Runtime.enable BEFORE navigation so the content script's
  // isolated-world console is captured from its very first line.
  const tabCreated = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(URL_UNDER_TEST)}`, 'PUT');
  targetTab = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${tabCreated.id}`);
  await targetTab.send('Page.enable');
  await targetTab.send('Runtime.enable');
  await targetTab.send('Log.enable').catch(() => {});

  targetTab.ws.addEventListener('message', async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const parts = (m.params.args || []).map((a) => {
          if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
          return a.description || a.type;
        });
        out.targetTabLogs.push({
          t: Date.now(),
          level: m.params.type,
          ctx: m.params.executionContextId,
          text: parts.join(' ').slice(0, 500),
        });
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        out.targetTabLogs.push({
          t: Date.now(), level: 'exception',
          ctx: d.executionContextId,
          text: (d.exception && d.exception.description) || d.text || 'exception',
        });
      }
    } catch { /* ignore */ }
  });

  await targetTab.send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(6000);

  sw = await attachServiceWorker(CDP_PORT);
  if (sw) await sw.send('Runtime.enable', {});

  // Submit the task so a real scan runs against this tab.
  await dash.send('Runtime.evaluate', {
    expression: `(() => {
      const ta = document.getElementById('composer-input');
      const btn = document.getElementById('composer-btn-run');
      if (!ta || !btn) return 'no-controls';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(TASK)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return 'submitted';
    })()`,
    returnByValue: true,
  });

  await sleep(SETTLE_MS);
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
} finally {
  try { if (dash) await dash.send('Page.close').catch(() => {}); } catch {}
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch {}
  try { if (chrome.profile) fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch {}
}

// The decisive lines: anything from the content script about the build.
const decisive = out.targetTabLogs.filter((l) =>
  /world model|semantic|ContentScript|failed|violation|registration/i.test(l.text));

console.log('=== TARGET-TAB CONSOLE: decisive lines ===');
for (const l of decisive.slice(0, 25)) console.log(` [${l.level}] ctx=${l.ctx} ${l.text.slice(0, 300)}`);
console.log('=== total target-tab log lines:', out.targetTabLogs.length);
console.log('=== distinct execution contexts:', [...new Set(out.targetTabLogs.map((l) => l.ctx))].join(', '));

fs.writeFileSync(path.join(REPO_ROOT, 'scratch', 'probe_target_console.json'), JSON.stringify(out, null, 2));