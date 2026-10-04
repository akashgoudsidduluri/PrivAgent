/**
 * PHASE I-7 FORENSIC PROBE — CONTENT SCRIPT CONSOLE.
 *
 * READ ONLY. The production build logs the reason the world model / semantic
 * understanding failed via console.warn from the CONTENT SCRIPT. The earlier
 * harness only captured the service worker's console, so those warnings — the
 * single most diagnostic piece of evidence — were never seen.
 *
 * This attaches to the real content script target and captures its console.
 *
 * Env:
 *   ST_PROBE_URL  page to load
 *   ST_CDP_PORT   devtools port
 */
import fs from 'fs';
import path from 'path';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9883);
const URL_UNDER_TEST = process.env.ST_PROBE_URL || 'https://en.wikipedia.org/wiki/Charminar';

const out = { url: URL_UNDER_TEST, contentScriptLogs: [] };

const chrome = launchChrome(CDP_PORT);
let bs, page, cs;
try {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
  }
  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });

  // Attach to every target so the content script's console is captured.
  const attached = new Set();
  const sessions = [];
  bs.ws.addEventListener('message', async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Target.attachedToTarget') {
        const sid = m.params.sessionId;
        const tinfo = m.params.targetInfo;
        attached.add(sid);
        // Content scripts report url like the page url but type 'other'/worker.
        const s = { sid, url: tinfo.url, type: tinfo.type, logs: [] };
        sessions.push(s);
        await bs.send('Runtime.enable', { sessionId: sid }).catch(() => {});
        bs.ws.addEventListener('message', async (ev2) => {
          try {
            const m2 = JSON.parse(ev2.data);
            if (m2.sessionId !== sid) return;
            if (m2.method === 'Runtime.consoleAPICalled') {
              const parts = (m2.params.args || []).map((a) =>
                a.value !== undefined ? String(a.value) : (a.description || a.type));
              s.logs.push({ t: Date.now(), level: m2.params.type, text: parts.join(' ') });
            }
            if (m2.method === 'Runtime.exceptionThrown') {
              s.logs.push({ t: Date.now(), level: 'exception',
                text: m2.params.exceptionDetails?.exception?.description
                     || m2.params.exceptionDetails?.text || 'exception' });
            }
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
  });
  await bs.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(URL_UNDER_TEST)}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(9000);

  // Give the extension time to inject + run a scan.
  out.sessions = sessions.map((s) => ({ url: s.url, type: s.type, logCount: s.logs.length }));
  out.contentScriptLogs = sessions
    .flatMap((s) => s.logs.map((l) => ({ target: s.type, ...l })))
    .filter((l) => /world model|semantic|failed|error|warn/i.test(l.text));
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
} finally {
  try { if (page) await page.send('Page.close').catch(() => {}); } catch {}
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch {}
  try { if (chrome.profile) fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch {}
}

console.log(JSON.stringify(out, null, 2).slice(0, 4000));