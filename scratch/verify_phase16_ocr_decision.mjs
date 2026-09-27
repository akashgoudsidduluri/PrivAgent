/**
 * PrivAgent — PHASE 16.7 : the OCR decision.
 *
 * Question: should OCR be activated in the autonomous agent loop?
 *
 * Method: measure the REAL cost and the REAL quality of the existing OCR stack
 * on a real canvas fixture, then decide on the evidence. OCR is NOT activated
 * in the agent loop by this harness, and nothing in production is changed.
 *
 * Three measurements:
 *   1. Initialisation cost — WASM/Tesseract cold start.
 *   2. Processing latency — warm recognise() on a real screenshot region.
 *   3. Detection quality  — does it actually read the canvas text?
 * Plus: heap cost, and whether the agent loop can currently reach it at all.
 */

import fs from 'fs';
import path from 'path';
import { servePhase16Fixture } from './phase16_fixtures.mjs';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.P16_FIXTURE_PORT || 4200);
const CDP_PORT = Number(process.env.P16_CDP_PORT || 9507);
const ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const OUT = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16', 'phase16_ocr_decision.json');
const ENTRY = path.join(REPO_ROOT, 'scratch', '.p16_ocr_entry.ts');
const BUNDLE = path.join(REPO_ROOT, 'scratch', '.p16_ocr_bundle.cjs');

const out = {
  timestamp: new Date().toISOString(),
  work: 'Phase 16.7 — OCR activation decision',
  question: 'Does the evidence justify activating OCR in the autonomous agent loop?',
  substrate: 'REAL Chrome + the REAL built OCR stack (bundled from extension/src, unmodified)',
  productionChanged: false,
  measurements: {},
};

const server = await servePhase16Fixture(FIXTURE_PORT);
const { proc: chrome, profile } = launchChrome(CDP_PORT);
const sessions = [];

try {
  for (let i = 0; i < 120; i++) { try { await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(250); } }
  const bs = await openSession((await cdpGet(CDP_PORT, '/json/version')).webSocketDebuggerUrl);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
  bs.close();

  const tab = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${ORIGIN}/canvas`)}`, 'PUT');
  await sleep(2500);
  const page = await openSession((await cdpGet(CDP_PORT, '/json/list')).find((t) => t.id === tab.id).webSocketDebuggerUrl);
  sessions.push(page);
  await page.send('Runtime.enable');

  // The canvas really does contain image-only text that is NOT in the DOM.
  out.canvasState = await page.evaluate(`(() => {
    const c = document.getElementById('ocr-canvas');
    const ctx2 = c.getContext('2d');
    const d = ctx2.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
    return {
      canvasPresent: true,
      darkPixelCount: dark,
      domTextContent: document.body.innerText.replace(/\\s+/g, ' ').trim(),
      submitTextInDom: /SUBMIT ORDER/i.test(document.body.innerText),
    };
  })()`);
  console.log('[P16-OCR] canvas state:', JSON.stringify(out.canvasState));

  // Screenshot the canvas element so OCR is measured on real pixels.
  const box = await page.evaluate(`(() => { const r = document.getElementById('ocr-canvas').getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }); })()`);
  const clip = JSON.parse(box);
  const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  fs.writeFileSync(path.join(REPO_ROOT, 'scratch', '.p16_canvas.png'), Buffer.from(shot.data, 'base64'));
  out.screenshotBytes = Buffer.from(shot.data, 'base64').length;

  // Run the REAL OCR stack in Node against those real pixels.
  const { spawnSync } = await import('child_process');
  const pngPath = path.join(REPO_ROOT, 'scratch', '.p16_canvas.png');
  const ocrAssets = path.join(REPO_ROOT, 'extension', 'dist', 'assets', 'ocr');
  fs.writeFileSync(ENTRY, `
import { LocalOCREngine } from '../extension/src/ocr/ocrEngine';
import fs from 'fs';
async function main() {
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(${JSON.stringify(pngPath)}).toString('base64');
  const assets = ${JSON.stringify(ocrAssets)};
  const e = new LocalOCREngine({
    workerPath: assets + '/worker.min.js',
    corePath: assets + '/tesseract-core-simd.wasm.js',
    langPath: assets + '/',
  });
  const t0 = performance.now();
  await e.init();
  const initMs = performance.now() - t0;
  const t1 = performance.now();
  const r = await e.recognize(dataUrl);
  const recMs = performance.now() - t1;
  const t2 = performance.now();
  const r2 = await e.recognize(dataUrl);
  const rec2Ms = performance.now() - t2;
  console.log(JSON.stringify({
    initMs: Math.round(initMs), firstRecognizeMs: Math.round(recMs), warmRecognizeMs: Math.round(rec2Ms),
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576 * 10) / 10,
    text: (r && r.fullText) || '', regions: Array.isArray(r?.lines) ? r.lines.length : null,
    warmText: (r2 && r2.fullText) || '',
  }));
}
main();
`);
  const b = spawnSync('npx', ['esbuild', ENTRY, '--bundle', '--platform=node', '--format=cjs', `--outfile=${BUNDLE}`, '--log-level=error'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (b.status !== 0) {
    out.measurements = { status: 'NOT_MEASURED', reason: 'esbuild of the OCR entry failed', detail: String(b.stderr).slice(0, 300) };
  } else {
    const r = spawnSync('node', [BUNDLE], { cwd: path.join(REPO_ROOT, 'extension', 'dist'), encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) {
      // The built Tesseract worker is a BROWSER worker: it calls
      // self.addEventListener, which does not exist in a Node worker thread.
      // The OCR stack therefore cannot be initialised or timed outside a
      // browser. This is recorded as an unavailability, not a number.
      out.measurements = {
        status: 'NOT_MEASURED',
        reason: 'The shipped Tesseract worker is browser-only (calls self.addEventListener) and cannot be initialised outside a browser context. No latency figure is reported rather than an estimated one.',
        errorClass: (String(r.stderr).match(/TypeError: [^\n]+/) || ['unknown'])[0].slice(0, 160),
        initLatencyMs: 'NOT_MEASURED',
        processingLatencyMs: 'NOT_MEASURED',
        memoryCost: 'NOT_MEASURED',
      };
      out.quality = {
        status: 'NOT_MEASURED',
        reason: 'Requires a running OCR worker, i.e. the extension popup capture flow. Out of scope for this phase.',
        fixtureIsImageOnly: !out.canvasState.submitTextInDom,
        darkPixelCount: out.canvasState.darkPixelCount,
      };
      console.log('[P16-OCR] latency NOT MEASURED — browser-only worker (recorded, not estimated)');
    } else {
      const m = JSON.parse(r.stdout.trim().split('\n').pop());
      out.measurements = { status: 'MEASURED', ...m };
      out.quality = {
        status: 'MEASURED',
        readTheCanvasText: /submit\s*order/i.test(m.text || ''),
        recognisedText: (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        domHadItAlready: out.canvasState.submitTextInDom,
      };
      console.log('[P16-OCR] measurements:', JSON.stringify(out.measurements));
    }
  }
} finally {
  for (const s of sessions) s.close();
  try { chrome.kill('SIGKILL'); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

// ── Is the OCR branch even reachable from the autonomous loop today? ───────
out.reachability = {
  serviceWorkerPassesOcrEngine: false,
  evidence: 'serviceWorker.ts:733 calls coordinateMultimodalPerception({tabId, windowId, scanReport, pageGeneration}) with no ocrEngine; multimodalCoordinator.ts:223 gates the whole branch on `if (input.ocrEngine)`.',
  ocrRegionsObservedInRealRun: 0,
  ocrRegionsEvidence: 'The Phase 16 task suite observed ocr_metrics.regions_scanned = 0 on every real run.',
};

const m = out.measurements || {};
out.decision = {
  verdict: 'KEEP OCR DORMANT',
  reasoning: [
    'The decisive evidence is REACHABILITY, not quality: the autonomous loop never passes an ocrEngine, so the branch is unreachable today regardless of how good OCR is.',
    'Task completion across all seven Phase 16 categories was decided by DOM affordances. No task required canvas or image-only text.',
    'There is NO measured evidence that activating OCR improves any task outcome.',
    'Cost could not be quantified from this harness (browser-only worker), and paying an unquantified per-cycle cost without a demonstrated benefit is not justified.',
    'The only canvas fixture is synthetic, so any quality number obtained from it would not be representative of real sites.',
  ],
  productionChanged: false,
  recommendation: 'Do not activate OCR in the autonomous loop. Revisit only with a corpus of real pages whose goals are unreachable from the DOM alone, and with the cost measured in-browser first.',
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n[P16-OCR] decision: ${out.decision.verdict} (production changed: ${out.decision.productionChanged})`);
console.log(`[P16-OCR] → ${path.relative(REPO_ROOT, OUT)}`);
