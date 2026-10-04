/**
 * PHASE I-7 FORENSIC PROBE — READ ONLY.
 *
 * Measures, on a REAL page in REAL Chrome, the counts at each stage of the
 * perception chain, and reproduces the EXACT filter logic used by
 * `extractVisualRegions` and `isElementVisible` so the first loss point can be
 * located precisely.
 *
 * It changes no production code and no test. It evaluates read-only DOM
 * queries in the page and reports numbers.
 *
 * Env:
 *   ST_PROBE_URL  page to measure
 *   ST_PROBE_OUT  output json path
 */
import fs from 'fs';
import path from 'path';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome, attachServiceWorker } from './phase16_cdp.mjs';

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9881);
const URL_UNDER_TEST = process.env.ST_PROBE_URL || 'https://en.wikipedia.org/wiki/Charminar';
const OUT = process.env.ST_PROBE_OUT || 'probe.json';

const out = { url: URL_UNDER_TEST, stages: {} };

const chrome = launchChrome(CDP_PORT);
let page, sw;
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
  await sleep(6000);

  sw = await attachServiceWorker(CDP_PORT);
  if (sw) { await sw.send('Runtime.enable', {}); }

  // Pure read-only DOM measurement, replicating the production filters exactly.
  const probe = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      const isVisible = (el) => {
        if (!el.isConnected) return false;
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
        const win = el.ownerDocument && el.ownerDocument.defaultView;
        const st = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
        if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0' || st.pointerEvents === 'none')) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return true;
        return r.width > 2 && r.height > 2;
      };

      const REGION_SELECTOR = [
        'article','section','.card, .product-card, [data-card]',
        'dialog, [role="dialog"], .modal, .cookie-banner, .banner',
        'header, nav, footer, main','canvas','video','img, figure',
        'button, [role="button"], a.btn, a.button'
      ].join(', ');

      const regionCandidates = q(REGION_SELECTOR);
      const regionVisible = regionCandidates.filter(isVisible);
      const regionBigEnough = regionVisible.filter(el => {
        const r = el.getBoundingClientRect();
        return Math.round(r.width) >= 8 && Math.round(r.height) >= 8;
      });

      // Headings / text blocks / links / controls
      const headings = q('h1,h2,h3,h4,h5,h6');
      const textBlocks = q('p, li').filter(el => (el.textContent||'').trim().length > 0);
      const links = q('a[href]');
      const buttons = q('button, [role="button"], input[type=submit], input[type=button]');
      const inputs = q('input, textarea, select');

      // Interactive candidates as the interactive scanner would see them
      const interactiveSelector = 'a[href], button, input, textarea, select, [role=button], [role=link], [onclick], [tabindex]';
      const interactiveCandidates = q(interactiveSelector);

      // Accessibility-ish nodes
      const ariaNodes = q('[aria-label], [role], [aria-describedby], [aria-labelledby]');
      const labelledByTitle = q('a[title], img[alt], button[title], input[placeholder], input[aria-label]');

      // Why might region extraction see nothing?
      const allHidden = regionCandidates.filter(el => !isVisible(el)).length;
      const tooSmall = regionVisible.filter(el => {
        const r = el.getBoundingClientRect();
        return Math.round(r.width) < 8 || Math.round(r.height) < 8;
      }).length;

      return JSON.stringify({
        dom: {
          headings: headings.length,
          headingSamples: headings.slice(0,6).map(h => (h.textContent||'').trim().slice(0,42)),
          textBlocks: textBlocks.length,
          links: links.length,
          buttons: buttons.length,
          inputs: inputs.length,
          interactiveCandidates: interactiveCandidates.length,
          accessibilityNodes: ariaNodes.length,
          labelledControls: labelledByTitle.length,
          totalElements: document.querySelectorAll('*').length,
          bodyTextLength: (document.body ? document.body.innerText.length : 0)
        },
        visualRegionExtraction: {
          selector: REGION_SELECTOR,
          candidates: regionCandidates.length,
          afterVisibilityFilter: regionVisible.length,
          rejectedByVisibility: allHidden,
          rejectedAsTooSmall: tooSmall,
          survivors: regionBigEnough.length
        }
      });
    })()`,
    returnByValue: true,
  });

  out.stages = JSON.parse(probe?.result?.value || '{}');
  out.readyState = await page.send('Runtime.evaluate', {
    expression: 'document.readyState + " | " + document.title', returnByValue: true,
  });
  out.readyState = out.readyState?.result?.value;
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
} finally {
  try { if (page) await page.send('Page.close').catch(() => {}); } catch {}
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch {}
  try { if (chrome.profile) fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch {}
}

console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(REPO_ROOT, 'scratch', OUT), JSON.stringify(out, null, 2));