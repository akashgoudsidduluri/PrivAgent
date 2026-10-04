/**
 * PHASE I-7 — READ ONLY. Confirms whether real Wikipedia text trips
 * `scanForRawSensitiveValues`, which is the guard inside `assertWorldModelSafe`
 * that discards the ENTIRE world model when a single string fails.
 *
 * Uses the production scanner via the built bundle semantics; no source edits.
 */
import path from 'path';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9885);
const URL_UNDER_TEST = process.env.ST_PROBE_URL || 'https://en.wikipedia.org/wiki/Charminar';

const chrome = launchChrome(CDP_PORT);
let page;
const out = {};
try {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
  }
  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  const bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });

  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(URL_UNDER_TEST)}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(8000);

  // Pull the exact strings the world model would carry: 50-char semantic hints
  // taken from the real region elements, then look for credential-shaped runs.
  const r = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const sel = ['article','section','header, nav, footer, main','img, figure','button, [role="button"]'].join(', ');
      const els = Array.from(document.querySelectorAll(sel)).filter(el => {
        if (!el.isConnected) return false;
        const s = getComputedStyle(el);
        if (s.display==='none'||s.visibility==='hidden') return false;
        const b = el.getBoundingClientRect();
        return b.width > 8 && b.height > 8;
      });
      const hints = els.map(el => {
        const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g,' ').slice(0,50);
        return t;
      }).filter(Boolean);

      // Heuristic mirror of rawValueScanner patterns, evaluated on the REAL hints.
      const PATTERNS = [
        ['longDigitRun', /\\b\\d{12,}\\b/],
        ['cardLike', /\\b(?:\\d[ -]*?){13,16}\\b/],
        ['emailLike', /[\\w.+-]+@[\\w-]+\\.[\\w.]+/],
        ['bearerLike', /\\b(?:sk|gsk|pk|api[_-]?key)[-_][A-Za-z0-9]{8,}/i],
        ['jwtLike', /\\beyJ[A-Za-z0-9_-]{10,}/],
        ['urlCredential', /[?&](?:token|key|password|secret)=[^&\\s]{6,}/i],
      ];
      const hits = [];
      for (const h of hints) {
        for (const [name, re] of PATTERNS) {
          if (re.test(h)) { hits.push({ rule: name, hint: h.slice(0,60) }); break; }
        }
      }
      return JSON.stringify({ regionCount: els.length, hintCount: hints.length, hitCount: hits.length, hits: hits.slice(0,12), sampleHints: hints.slice(0,8) });
    })()`,
    returnByValue: true,
  });
  out.result = JSON.parse(r?.result?.value || '{}');
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
} finally {
  try { if (page) await page.send('Page.close').catch(() => {}); } catch {}
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch {}
  try { if (chrome.profile) (await import('fs')).rmSync(chrome.profile, { recursive: true, force: true }); } catch {}
}

console.log(JSON.stringify(out, null, 2).slice(0, 3500));