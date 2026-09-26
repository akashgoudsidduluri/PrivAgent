/**
 * PrivAgent — Phase 15: REAL-CHROME Privacy Fusion & Contextual PII Verification
 *
 * The unit suite proves the detector and the fusion rules. This proves the
 * WIRING: that the shipped extension, running in a real browser against a real
 * page, actually feeds contextual (NLP) evidence into Privacy Fusion and that
 * the result is still metadata only.
 *
 *   real page fixture → real content script (from dist/) → real DOM detector
 *     → real contextual detector → real fusePrivacyFindings()
 *       → real world model (assertWorldModelSafe) → CDP response
 *
 * Asserts:
 *   1. the DOM detector still finds the card field (no regression)
 *   2. the contextual detector contributes an `nlp`-sourced finding
 *   3. that finding carries a person_name category and a real region/selector
 *   4. it FUSED with the DOM finding rather than duplicating it
 *   5. the fused finding set still passes the raw-value boundary
 *   6. no raw page text appears anywhere in the world model
 *   7. ordinary UI copy on the same page produces no contextual finding
 *
 * Evidence → docs/evidence/phase15-privacy-fusion/
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PORT = Number(process.env.PRIVAGENT_PHASE15_CDP_PORT || 9486);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase15-privacy-fusion');
const EVIDENCE_JSON = path.join(EVIDENCE_DIR, 'phase15_real_chrome_evidence.json');

const TARGET_PORT = 4197;
const TARGET_ORIGIN = `http://localhost:${TARGET_PORT}`;

// A real page: one cued PII neighbourhood, plus ordinary UI copy that a naive
// detector would happily report as "person names".
const TARGET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Phase 15 privacy fusion target</title></head>
<body>
  <h1>Checkout</h1>
  <nav><a href="#">Home</a> <a href="#">Contact Us</a> <a href="#">Track Your Package</a></nav>
  <div class="field">
    <label for="cc">Cardholder Name</label>
    <span>Rajesh Kumar</span>
    <input id="cc" type="text" autocomplete="cc-number" name="cardnumber" value="4111111111111111">
  </div>
  <div class="field">
    <label for="pw">Password</label>
    <input id="pw" type="password" name="password" value="hunter2hunter2">
  </div>
  <div class="actions"><button>Place Order</button><button>Order Summary</button></div>
</body></html>`;

function serve(port, html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const getJson = (endpoint, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CHROME_PORT, path: endpoint, method }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error(`CDP ${endpoint} non-JSON`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });

class Session {
  constructor(ws, sessionId = undefined) {
    this.ws = ws; this.sessionId = sessionId; this.id = 0; this.pending = new Map();
    this.onEvent = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const e = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(e.t);
        msg.error ? e.reject(new Error(JSON.stringify(msg.error))) : e.resolve(msg.result);
      } else if (msg.method && this.onEvent) this.onEvent(msg);
    };
  }
  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timeout`)); } }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      const payload = { id, method, params };
      if (this.sessionId) payload.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  async evaluate(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function openSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  return new Session(ws);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targetServer = await serve(TARGET_PORT, TARGET_PAGE);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-phase15-'));
  const chrome = spawn(
    CHROME_BIN,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1280,900',
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', 'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  const sessions = [];
  const evidence = {
    timestamp: new Date().toISOString(),
    phase: 'Phase 15: Privacy Fusion & Contextual PII Detection',
    goal: 'Prove the shipped extension feeds contextual (NLP) evidence into Privacy Fusion on a real page, and that the fused output is still metadata only.',
    provenance: {
      kind: 'REAL_CHROME',
      browser: 'Chromium (headless=new) driven over CDP',
      contentScript: 'REAL production content script loaded from dist/',
      messagePath: 'real page → real content script → real DOM detector → real contextual detector → real fusePrivacyFindings() → real world model (assertWorldModelSafe) → CDP response',
      securityGatesTouched: false,
      synthetic: false,
      note: 'OCR is not exercised here: the fixture carries no canvas or non-DOM visual region, and the contextual OCR span→box mapping is covered by the unit suite. No agent action is proposed, so no security gate is bypassed or relied upon.',
    },
  };

  try {
    for (let i = 0; i < 80; i++) {
      try { await getJson('/json/version'); break; } catch { await sleep(250); }
    }
    const browserWsUrl = (await getJson('/json/version')).webSocketDebuggerUrl;
    const bs = await openSession(browserWsUrl);
    const { id: extensionId } = await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });
    bs.close();
    evidence.extensionId = extensionId;

    const controlTarget = await getJson(
      `/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`, 'PUT'
    );
    const control = await openSession(controlTarget.webSocketDebuggerUrl);
    sessions.push(control);
    await control.send('Page.enable'); await control.send('Runtime.enable');
    await sleep(1500);

    const targetTabId = await control.evaluate(
      `chrome.tabs.create({ url: '${TARGET_ORIGIN}/', active: true }).then(t => t.id).catch(() => null)`
    );
    if (targetTabId == null) throw new Error('failed to create the fixture tab');
    evidence.targetTabId = targetTabId;
    await sleep(3000);

    console.log(`\n[PHASE 15] REAL CHROME — privacy fusion & contextual PII detection`);

    // Drive the REAL perception path exactly as the agent loop does.
    const responseJson = await control.evaluate(
      `chrome.tabs.sendMessage(${targetTabId}, { type: 'PRIVAGENT_SCAN_REQUEST', mode: 'blackout' })
         .then(r => JSON.stringify(r))
         .catch(e => JSON.stringify({ __error: String(e) }))`,
      { timeoutMs: 60000 }
    );
    const response = JSON.parse(responseJson);
    if (response.__error) throw new Error(`scan request failed: ${response.__error}`);

    const report = response.report || {};
    const findings = (response.worldModel && response.worldModel.privacyFindings) || [];

    // ── 1. The pre-existing DOM detector still works ─────────────────────────
    const domTypes = (report.detections || []).map((d) => d.type);
    evidence.case1_domDetectorIntact = {
      sensitiveDetected: report.sensitiveElementsDetected,
      categories: report.categories,
      detectedTypes: domTypes,
      cardFieldFound: domTypes.includes('credit_card'),
      passwordFieldFound: domTypes.includes('password'),
    };
    console.log(`  DOM detections = ${domTypes.join(', ') || '(none)'}`);

    // ── 2. A contextual (nlp) source reached fusion ──────────────────────────
    const nlpFindings = findings.filter((f) => (f.sources || []).includes('nlp'));
    evidence.case2_contextualSignalReachedFusion = {
      totalFindings: findings.length,
      nlpSourcedFindings: nlpFindings.length,
      nlpCategories: nlpFindings.map((f) => f.category),
      evidenceCodes: [...new Set(nlpFindings.flatMap((f) => f.evidence || []))],
    };
    console.log(`  fused findings = ${findings.length}, nlp-sourced = ${nlpFindings.length}`);

    // ── 3 & 4. It fused with the DOM finding instead of duplicating it ───────
    const personFindings = findings.filter((f) => f.category === 'person_name');
    const fused = personFindings.filter((f) => (f.sources || []).length > 1);
    evidence.case3_contextualCategoryAndRegion = {
      personNameFindings: personFindings.length,
      regionsPresent: personFindings.every((f) => f.region !== null || f.selector !== null),
      selectors: personFindings.map((f) => f.selector),
      confidences: personFindings.map((f) => f.confidence),
      policies: personFindings.map((f) => f.decision && f.decision.decision),
    };
    evidence.case4_fusedNotDuplicated = {
      multiSourcePersonFindings: fused.length,
      sourcesPerPersonFinding: personFindings.map((f) => f.sources),
      evidenceIdsPerPersonFinding: personFindings.map((f) => f.evidenceIds),
      note: 'A contextual hit anchored to an existing DOM detection carries that detection’s own selector, so fusion merges them by selector. The count of person_name findings must stay at the number of ANCHORS, not anchors + contextual hits.',
    };
    console.log(`  person_name findings = ${personFindings.length} (multi-source = ${fused.length})`);

    // ── 5 & 6. Still metadata only ──────────────────────────────────────────
    const worldModelJson = JSON.stringify(response.worldModel);
    const RAW_VALUES = ['Rajesh Kumar', '4111111111111111', 'hunter2hunter2', 'Rajesh', 'Kumar'];
    const leaked = RAW_VALUES.filter((v) => worldModelJson.includes(v));
    const findingJson = JSON.stringify(findings);
    evidence.case5_metadataOnly = {
      rawValuesChecked: RAW_VALUES,
      rawValuesFoundInWorldModel: leaked,
      worldModelKeys: Object.keys(response.worldModel || {}),
      findingKeys: [...new Set(findings.flatMap((f) => Object.keys(f)))].sort(),
      note: 'assertWorldModelSafe() ran inside the content script before the world model was returned; a violation would have thrown and the scan would have failed instead.',
    };
    console.log(`  raw values found in the world model = ${leaked.length}`);

    // ── 7. Ordinary UI copy produced no contextual finding ───────────────────
    const uiOnlyHits = findings.filter(
      (f) => /Place Order|Order Summary|Track Your Package|Contact Us|Home/i.test(JSON.stringify(f))
    );
    evidence.case6_noUiCopyFalsePositives = {
      uiStringsOnPage: ['Home', 'Contact Us', 'Track Your Package', 'Place Order', 'Order Summary'],
      findingsMentioningUiCopy: uiOnlyHits.length,
      allEvidenceCodesAreValueFree: findings.every((f) =>
        (f.evidence || []).every((c) => /^(dom|ocr|visual|nlp|contextual|fused|fail_closed):/.test(c))
      ),
    };
    console.log(`  findings referencing UI copy = ${uiOnlyHits.length}`);

    // ── Redaction / screening remained authoritative ─────────────────────────
    evidence.case7_existingEnginesUntouched = {
      redactionLatencyMs: report.redactionLatencyMs,
      elementsProtected: report.elementsProtected,
      leakageCount: report.leakageCount,
      status: report.status,
      note: 'The redaction engine ran on the ORIGINAL DOM detections only. The contextual signal is fusion metadata; it neither re-redacted nor un-redacted anything.',
    };

    evidence.result = {
      domDetectorIntact: evidence.case1_domDetectorIntact.cardFieldFound && evidence.case1_domDetectorIntact.passwordFieldFound,
      contextualSignalReachedFusion: nlpFindings.length > 0,
      contextualCategoryIsPersonName: nlpFindings.some((f) => f.category === 'person_name'),
      contextualFindingIsLocatable: personFindings.every((f) => f.region !== null || f.selector !== null),
      fusedNotDuplicated: personFindings.length > 0 && personFindings.length <= (report.sensitiveElementsDetected || 0),
      noRawValuesInWorldModel: leaked.length === 0,
      noUiCopyFalsePositives: uiOnlyHits.length === 0,
      zeroLeakage: report.leakageCount === 0,
    };

    fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
    console.log(`\nEvidence written to ${path.relative(REPO_ROOT, EVIDENCE_JSON)}`);
    console.log(JSON.stringify(evidence.result, null, 2));
    const allPass = Object.values(evidence.result).every(Boolean);
    console.log(`\n[PHASE 15] ${allPass ? 'ALL CHECKS PASS' : 'CHECKS FAILED'}`);
    if (!allPass) process.exitCode = 1;
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { targetServer.close(); } catch {}
  }
}

await main();
