#!/usr/bin/env node
/**
 * STEP 10.4 Part 8/9 — real backend + real provider probe.
 *
 * Sends the canonical fixture task through the LIVE FastAPI gateway on
 * :8010 with the REAL Groq provider, and captures the full response so the
 * P1 remediation can be judged on the real path rather than in unit tests.
 *
 * Rate limit: Groq free tier is ~3 req/min, so calls are spaced.
 * Usage: node scratch/step10_4_real_backend.mjs <outFile> [task]
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] ?? 'scratch/.step104_real_backend.json');
const TASK = process.argv[3] ?? 'open the store catalog';
const ENDPOINT = 'http://127.0.0.1:8010/api/v1/agent/action';

// The real detections the extension sends from the fixture home page
// (captured verbatim in docs/evidence/post-17-10/audit/step10_3_g7_run1.json).
const DETECTIONS = [
  { id: 'btn-login-cta', type: 'button', confidence: 0.95,
    bbox: { x: 441, y: 297, width: 186, height: 43 }, length: 15,
    source: 'dom_attribute', selector: '#btn-login-cta', is_partially_visible: false },
  { id: 'btn-shop-now', type: 'button', confidence: 0.95,
    bbox: { x: 648, y: 296, width: 191, height: 45 }, length: 14,
    source: 'dom_attribute', selector: '#btn-shop-now', is_partially_visible: false },
  { id: 'brand-link', type: 'link', confidence: 0.95,
    bbox: { x: 32, y: 16, width: 125, height: 28 }, length: 8,
    source: 'dom_attribute', selector: '#brand-link', is_partially_visible: false },
];

function body() {
  return {
    task: TASK,
    context: {
      url: 'http://localhost:4174/',
      timestamp: Date.now(),
      viewport: { width: 1280, height: 757, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: { width: 1280, height: 757 },
      detections: DETECTIONS,
      total_elements_scanned: 18,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      page_type: 'landing',
      semantic_context: {
        pageType: 'UNKNOWN',
        confidence: 0.1,
        pageState: 'populated',
        pageGeneration: 3,
        entities: [],
        affordances: [
          { id: 'affordance-btn-shop-now', type: 'CLICK', requiresConfirmation: false,
            description: 'Shop Now button' },
          { id: 'affordance-brand-link', type: 'CLICK', requiresConfirmation: false,
            description: 'ApexCart brand link' },
        ],
        workflow: null,
        promptInjectionDetected: false,
        facts: [],
        // The G4/G5-declared role-only destination: LISTING, no URL.
        declaredDestination: { provenance: 'USER_DECLARED_DESTINATION', role: ['LISTING'] },
      },
    },
    history: [],
    model_role: 'STRONG',
  };
}

async function call() {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body()),
  });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = {
  work: 'STEP 10.4 Part 8 — real backend / real provider proof after the P1 remediation',
  task: TASK,
  endpoint: ENDPOINT,
  labels: 'PROVEN_REAL (live FastAPI :8010, real Groq provider, real fixture detections)',
  calls: [],
};

for (let i = 1; i <= 3; i += 1) {
  if (i > 1) await sleep(70000); // Groq free tier: ~3 req/min
  process.stdout.write(`call ${i} ... `);
  let rec;
  try {
    const r = await call();
    rec = { run: i, ...r };
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch { /* keep raw */ }
    rec.parsed = parsed;
    const detail = parsed?.detail;
    rec.success = parsed?.success ?? detail?.success ?? null;
    rec.reason = parsed?.action?.reason ?? parsed?.reason ?? detail?.action?.reason ?? null;
    rec.action = parsed?.action ?? detail?.action ?? null;
    rec.rejectionReason = typeof detail === 'object' && detail?.reason ? detail.reason
      : (typeof detail === 'string' ? detail : null);
    rec.errorKind = detail?.error_kind ?? null;
    rec.retryable = detail?.retryable ?? null;
    console.log(`status ${r.status}`);
  } catch (e) {
    rec = { run: i, error: String(e) };
    console.log(`ERROR ${e}`);
  }
  run.calls.push(rec);
  console.log('   ' + JSON.stringify({
    status: rec.status, success: rec.success, action: rec.action, reason: rec.reason,
    rejectionReason: rec.rejectionReason, errorKind: rec.errorKind,
  }).slice(0, 500));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(run, null, 2));
console.log(`\nwrote ${OUT}`);
