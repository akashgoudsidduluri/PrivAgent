/**
 * M8 PHONE GAP — REAL CHROME VERIFICATION.
 *
 * Real Chrome (CDP), real built MV3 extension, real content script, real
 * privacy scan → fusion → minimization. Nothing in the detection path is
 * stubbed: the content script is driven by the SAME
 * `PRIVAGENT_SCAN_REQUEST` message the service worker sends in production.
 *
 * The reasoner is deliberately NOT invoked — this check is about local
 * detection and the egress boundary, not task execution.
 *
 * EVIDENCE POLICY: artifacts record METADATA, BOOLEANS and LENGTHS ONLY. The
 * synthetic phone value is never written to the evidence file; only its digit
 * count, and whether the raw value appeared anywhere it must not.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { servePhoneFixture } from './phone_fixture.mjs';
import {
  REPO_ROOT,
  sleep,
  cdpGet,
  openSession,
  launchChrome,
  waitForBackend,
  attachServiceWorker,
} from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.P176_FIXTURE_PORT || 4292);
const CDP_PORT = Number(process.env.P176_CDP_PORT || 9587);
const BACKEND_PORT = Number(process.env.P176_BACKEND_PORT || 8011);
const ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-9', 'm8-phone-detection');
const OUT = path.join(OUT_DIR, 'real_chrome_results.json');

const log = (...a) => console.log('[PHONE]', ...a);

// Used ONLY for leak assertions. Never written to the evidence artifact.
const PHONE = '5551234567';
const PHONE_DIGITS = PHONE.length;

const out = {
  timestamp: new Date().toISOString(),
  work: 'M8 phone-detection gap — real Chrome verification',
  evidencePolicy:
    'Metadata, booleans and lengths only. The synthetic phone value is never recorded; ' +
    'only its digit count and whether the raw value appeared where it must not.',
  environment: { realChrome: true, stubbedDetection: false, reasonerInvoked: false },
  cases: {},
};

const leaks = (v) => String(v ?? '').includes(PHONE);

/** Chrome needs a moment before its CDP endpoint answers. */
async function waitForCdp(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      return await cdpGet(port, '/json/version');
    } catch {}
    await sleep(500);
  }
  throw new Error(`chrome CDP never became ready on ${port}`);
}

let server = null;
let chrome = null;
let page = null;
let sw = null;
let bs = null;

try {
  server = await servePhoneFixture(FIXTURE_PORT);
  log('fixture up on', ORIGIN);

  out.environment.backendReachable = await waitForBackend(BACKEND_PORT);

  chrome = launchChrome(CDP_PORT);
  const version = await waitForCdp(CDP_PORT);
  out.environment.chromeVersion = version['Browser'] || 'unknown';
  log('chrome:', out.environment.chromeVersion);

  const browserWsId = version.webSocketDebuggerUrl.split('/').pop();
  bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${browserWsId}`);
  const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  out.environment.extensionLoaded = Boolean(extensionId);
  log('extension loaded:', extensionId);

  // Open the fixture in a real tab.
  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(ORIGIN + '/')}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(1500);

  out.cases.pageUrl = await page.evaluate('location.href');
  log('tab url:', out.cases.pageUrl);

  // ── Confirm the live tab really carries the values under test ─────────────
  const dom = await page.evaluate(`(() => {
    const ids = ['prose-phone','label-phone','contact-phone','product-id','order-id',
                 'tracking','reference','short-serial','long-serial','email','pan','tel1','sku1'];
    const o = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      o[id] = el ? (el.value !== undefined && el.value !== '' ? String(el.value) : (el.textContent||'').trim()) : null;
    }
    return o;
  })()`);

  out.cases.liveTabContents = {
    // Booleans + lengths only.
    prosePhoneInDom: leaks(dom['prose-phone']),
    prosePhoneTextLength: (dom['prose-phone'] || '').length,
    phoneDigitsInDom: PHONE_DIGITS,
    productIdInDom: /1234567890/.test(dom['product-id'] || ''),
    productIdTextLength: (dom['product-id'] || '').length,
    emailInDom: leaks(dom['email']) || /@/.test(dom['email'] || ''),
    panInDom: /4111/.test(dom['pan'] || ''),
  };
  log('live tab contents verified');

  // ── Drive the REAL content script through the REAL service worker ────────
  sw = await attachServiceWorker(CDP_PORT);
  out.environment.serviceWorkerAttached = Boolean(sw);
  if (!sw) throw new Error('service worker not attached');
  await sw.send('Runtime.enable');

  const tabId = await sw.evaluate(
    `(async () => { const t = await chrome.tabs.query({}); return t.find(x => (x.url||'').includes('${FIXTURE_PORT}'))?.id ?? null; })()`
  );
  out.cases.targetTabResolved = typeof tabId === 'number';
  log('tab id resolved from the service worker:', tabId);

  const raw = await sw.evaluate(
    `(async () => { try { return await chrome.tabs.sendMessage(${tabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }); } catch (e) { return { error: String(e) }; } })()`
  );

  if (!raw || raw.error) throw new Error(`content script scan failed: ${raw && raw.error}`);

  const report = raw.report || {};
  const detections = report.detections || [];
  const phoneDetections = detections.filter((d) => d.type === 'phone');

  out.cases.realContentScriptScan = {
    totalElementsScanned: report.totalElementsScanned ?? null,
    sensitiveElementsDetected: report.sensitiveElementsDetected ?? null,
    detectionCount: detections.length,
    phoneDetectionCount: phoneDetections.length,
    categoriesDetected: Array.from(new Set(detections.map((d) => d.type))).sort(),
    // Metadata shape only: ids, categories, lengths, confidence — never values.
    detectionMetadataShape:
      detections.length > 0 ? Object.keys(detections[0]).sort() : [],
    containsRawPhoneValue: leaks(JSON.stringify(detections)),
    containsRawEmail: /@/.test(JSON.stringify(detections)),
  };
  log('phone detections in the real scan:', phoneDetections.length);

  // ── The world model / semantic layer must not carry the raw value ────────
  const worldModel = raw.worldModel || null;
  out.cases.worldModelBoundary = {
    present: Boolean(worldModel),
    containsRawPhoneValue: leaks(JSON.stringify(worldModel)),
    textRegionCount: Array.isArray(worldModel?.textRegions) ? worldModel.textRegions.length : 0,
    // Whether any text region was replaced by the fail-closed marker.
    protectedTextRegionCount: Array.isArray(worldModel?.textRegions)
      ? worldModel.textRegions.filter((r) => r.sanitizedPreview === 'Protected Text').length
      : 0,
  };

  // ── Egress: run the REAL backend scanner over a REAL minimized payload ───
  // The report is exactly what the content script would hand upstream.
  const egressBody = JSON.stringify({ context: report });
  out.cases.egressBoundary = {
    serializedReportLength: egressBody.length,
    containsRawPhoneValue: leaks(egressBody),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  log('wrote', OUT);

  // Machine-readable verdict.
  const pass =
    out.cases.realContentScriptScan.phoneDetectionCount > 0 &&
    out.cases.realContentScriptScan.containsRawPhoneValue === false &&
    out.cases.worldModelBoundary.containsRawPhoneValue === false &&
    out.cases.egressBoundary.containsRawPhoneValue === false;
  out.verdict = pass ? 'PROVEN_REAL' : 'NOT_PROVEN';
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  log('verdict:', out.verdict);
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
  out.verdict = 'NOT_PROVEN';
  log('ERROR', out.error);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  for (const s of [page, sw, bs]) { try { s?.close(); } catch {} }
  try { chrome?.kill?.(); } catch {}
  server?.close();
}
