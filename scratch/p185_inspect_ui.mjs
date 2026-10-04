/**
 * PHASE 18.5 — dashboard DOM probe.
 * Discovers the REAL controls the redesigned dashboard uses to submit a task,
 * so the reproduction harness drives the same path a user would.
 */
import path from 'path';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome, attachServiceWorker } from './phase16_cdp.mjs';

const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const CDP_PORT = Number(process.env.ST_CDP_PORT || 9802);
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;

const chrome = launchChrome(CDP_PORT);
let page;
try {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
  }
  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  const bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });

  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(4000);

  const r = await page.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      inputs: Array.from(document.querySelectorAll('input,textarea')).map((e,i)=>({
        i, tag:e.tagName, type:e.type||null, id:e.id||null, name:e.name||null,
        placeholder:e.placeholder||null, cls:e.className||null,
        visible: !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)
      })),
      buttons: Array.from(document.querySelectorAll('button')).map((b,i)=>({
        i, text:(b.textContent||'').trim().slice(0,60), type:b.type||null,
        id:b.id||null, cls:b.className||null,
        visible: !!(b.offsetWidth||b.offsetHeight||b.getClientRects().length)
      })),
      forms: Array.from(document.querySelectorAll('form')).map(f=>({ id:f.id||null, cls:f.className||null, action:f.action||null })),
      hasAdapter: typeof window.__p185,
      composerHints: Array.from(document.querySelectorAll('[class*=composer],[class*=task],[id*=task],[id*=composer]')).slice(0,25).map(e=>({
        tag:e.tagName, id:e.id||null, cls:(e.className||'').toString().slice(0,120)
      }))
    })`,
    returnByValue: true,
  });
  console.log(r?.result?.value);
} catch (e) {
  console.log('ERR', e && e.message);
} finally {
  try { if (page) await page.send('Page.close').catch(() => {}); } catch {}
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch {}
  try { if (chrome.profile) (await import('fs')).rmSync(chrome.profile, { recursive: true, force: true }); } catch {}
}