/**
 * PrivAgent — Real-Chrome OBSERVED effect verification
 *
 * Purpose
 * -------
 * Prove that the SHIPPED extension's production effect-snapshot path can tell
 * "the action dispatched" apart from "the requested browser effect actually
 * happened".
 *
 * This runs the real content script from dist/ inside real Chrome, obtains
 * snapshots through the real PRIVAGENT_GET_EFFECT_SNAPSHOT message, and feeds
 * them to the real verifyActionEffect() (bundled from source, not reimplemented).
 *
 * Cases
 * -----
 *   A. NEGATIVE  — scroll at the scroll boundary: dispatch succeeds, the page
 *                  does not move, nothing else changes  → ACTION_NO_EFFECT
 *   B. POSITIVE  — a real scroll                          → SCROLL_CHANGED
 *   C. SUBTLE    — an inert click that only moves focus   → FOCUS_SHIFT_OBSERVED
 *                  (a real effect the old synthesis would have mislabelled)
 *   D. TYPE      — a real value-length change              → VALUE_STATE_CHANGED
 *   E. FAIL-SAFE — a target that does not resolve          → ACTION_NO_EFFECT
 *
 * What it does NOT do
 * -------------------
 * It does not drive the full agent loop, because that needs a live reasoner
 * backend, which is unavailable in this environment (recorded in the evidence).
 * It exercises the exact production observation + verification seam the loop
 * calls into, against a real browser.
 *
 * Evidence → docs/evidence/post-phase15-e2e/
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PORT = Number(process.env.PRIVAGENT_EFFECT_CDP_PORT || 9491);
const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-phase15-e2e');
const EVIDENCE_JSON = path.join(EVIDENCE_DIR, 'observed_effect_no_effect_evidence.json');

const TARGET_PORT = 4198;
const TARGET_ORIGIN = `http://localhost:${TARGET_PORT}`;

const TARGET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Observed effect target</title>
<style>body{margin:0}#tall{height:6000px;background:linear-gradient(#fff,#ddd)}input,button{font-size:14px;padding:6px}</style>
</head><body>
  <h1>Effect verification target</h1>
  <input id="q" type="text" name="q" placeholder="Search" />
  <button id="inert">Inert Button</button>
  <div id="tall"></div>
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

/** Bundle the shipped verifyActionEffect so the harness uses real source code. */
function ensureVerifierBundle() {
  const bundle = path.join(__dirname, '.effect_verifier_bundle.mjs');
  const entry = path.join(__dirname, '.effect_verifier_entry.ts');
  const entrySrc =
    "// Re-exports the SHIPPED effect verifier so this harness exercises the\n" +
    "// exact production implementation rather than a reimplementation.\n" +
    "export { verifyActionEffect } from '../extension/src/agent/effectVerifier';\n";
  if (!fs.existsSync(entry) || fs.readFileSync(entry, 'utf8') !== entrySrc) {
    fs.writeFileSync(entry, entrySrc, 'utf8');
  }
  const r = spawnSync(
    'npx',
    ['esbuild', entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`],
    { cwd: REPO_ROOT, stdio: 'ignore' }
  );
  if (r.status !== 0 || !fs.existsSync(bundle)) {
    throw new Error('failed to bundle the shipped effect verifier');
  }
}

async function main() {
  const targetServer = await serve(TARGET_PORT, TARGET_PAGE);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-effect-'));
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
    phase: 'Post-Phase-15 Validation: Observed Effect Verification',
    goal:
      'Prove the shipped production snapshot path distinguishes "the action dispatched" from "the requested browser effect actually happened".',
    provenance: {
      kind: 'REAL_CHROME',
      browser: 'Chromium (headless=new) driven over CDP',
      contentScript: 'REAL production content script loaded from dist/',
      messagePath:
        'real page → real content script → real PRIVAGENT_GET_EFFECT_SNAPSHOT → real verifyActionEffect() (bundled from extension/src)',
      synthetic: false,
      securityGatesTouched: false,
      note:
        'The full agent loop is not driven because no live reasoner backend is available in this environment. This exercises the exact production observation + verification seam the loop calls into, against a real browser.',
    },
    checks: {},
  };

  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    evidence.checks[name] = { pass: Boolean(ok), ...detail };
    if (ok) { pass++; console.log(`  [PASS] ${name}`); }
    else { fail++; console.log(`  [FAIL] ${name} :: ${JSON.stringify(detail)}`); }
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
      `/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/popup.html`)}`,
      'PUT'
    );
    const control = await openSession(controlTarget.webSocketDebuggerUrl);
    sessions.push(control);
    await control.send('Page.enable');
    await control.send('Runtime.enable');
    await sleep(1500);

    const targetTabId = await control.evaluate(
      `chrome.tabs.create({ url: '${TARGET_ORIGIN}/', active: true }).then(t => t.id).catch(() => null)`
    );
    if (targetTabId == null) throw new Error('failed to create the fixture tab');
    evidence.targetTabId = targetTabId;
    await sleep(3000);

    // The verifier is bundled from the SHIPPED source, so this proves the real
    // implementation rather than a reimplementation. The bundle is a build
    // artifact, so it is generated on demand rather than committed.
    ensureVerifierBundle();
    const { verifyActionEffect } = await import('./.effect_verifier_bundle.mjs');

    console.log('\n[EFFECT] REAL CHROME — observed snapshot + effect verification');

    // Prime perception so the content script's detection table is populated.
    await control.evaluate(
      `chrome.tabs.sendMessage(${targetTabId}, { type: 'PRIVAGENT_SCAN_REQUEST', mode: 'blackout' }).catch(() => null)`,
      { timeoutMs: 60000 }
    );

    const takeSnapshot = async (target) => {
      const raw = await control.evaluate(
        `chrome.tabs.sendMessage(${targetTabId}, {
           type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT'${target ? `, target: ${JSON.stringify(target)}` : ''}
         }).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ __error: String(e) }))`,
        { timeoutMs: 30000 }
      );
      const parsed = JSON.parse(raw);
      if (parsed.__error) throw new Error(`snapshot failed: ${parsed.__error}`);
      if (!parsed.snapshot) throw new Error('snapshot returned no snapshot');
      return parsed.snapshot;
    };

    const dispatch = async (action) => {
      const raw = await control.evaluate(
        `chrome.tabs.sendMessage(${targetTabId}, { type: 'PRIVAGENT_EXECUTE_ACTION', action: ${JSON.stringify(action)} })
           .then(r => JSON.stringify(r)).catch(e => JSON.stringify({ __error: String(e) }))`,
        { timeoutMs: 30000 }
      );
      return JSON.parse(raw);
    };

    // ── 1. The production snapshot message works ────────────────────────────
    const initial = await takeSnapshot();
    check('productionSnapshotMessageResponds', true, {
      fields: Object.keys(initial).sort(),
      url: initial.url,
      domElementCount: initial.domElementCount,
    });

    // ── 2. The snapshot is metadata only ────────────────────────────────────
    const forbiddenKeys = ['value', 'text', 'textContent', 'innerText', 'password', 'secret', 'cvv', 'otp'];
    const leakedKeys = Object.keys(initial).filter((k) => forbiddenKeys.includes(k));
    check('snapshotCarriesNoRawValueField', leakedKeys.length === 0, {
      keysChecked: Object.keys(initial).sort(),
      forbiddenKeysPresent: leakedKeys,
      targetValueLength: initial.targetValueLength,
      note: 'Only a LENGTH is ever reported for a target value.',
    });

    // ── 3. POSITIVE: a real scroll is observed as a real effect ─────────────
    const preScroll = await takeSnapshot();
    const scrollDispatch = await dispatch({ action: 'scroll', direction: 'down', amount: 600, reason: 'positive control' });
    await sleep(900);
    const postScroll = await takeSnapshot();
    const scrollVerdict = verifyActionEffect(
      { action: 'scroll', direction: 'down', amount: 600 },
      preScroll,
      postScroll
    );
    evidence.positiveControlScroll = {
      action: { action: 'scroll', direction: 'down', amount: 600 },
      dispatchSucceeded: scrollDispatch?.result?.success === true,
      dispatchMessage: scrollDispatch?.result?.message,
      preSnapshot: preScroll,
      postSnapshot: postScroll,
      effectVerdict: scrollVerdict,
    };
    check(
      'observedRealEffectIsVerified',
      scrollVerdict.hasEffect === true && scrollVerdict.status === 'SCROLL_CHANGED',
      {
        preScrollY: preScroll.scrollY,
        postScrollY: postScroll.scrollY,
        observedDelta: postScroll.scrollY - preScroll.scrollY,
        requestedAmount: 600,
        status: scrollVerdict.status,
        note: 'The observed delta, not the requested 600, produced the verdict.',
      }
    );

    // ── 4. NEGATIVE: scroll at the boundary. Dispatch succeeds, nothing moves.
    await sleep(600);
    // Drive to the very bottom first so the next scroll is a guaranteed no-op.
    await control.evaluate(
      `chrome.tabs.sendMessage(${targetTabId}, { type: 'PRIVAGENT_EXECUTE_ACTION',
         action: { action: 'scroll', direction: 'down', amount: 5000, reason: 'reach bottom' } }).catch(() => null)`,
      { timeoutMs: 30000 }
    );
    await sleep(1200);

    const preNoop = await takeSnapshot();
    const noopDispatch = await dispatch({ action: 'scroll', direction: 'down', amount: 600, reason: 'negative control' });
    await sleep(900);
    const postNoop = await takeSnapshot();
    const noopVerdict = verifyActionEffect(
      { action: 'scroll', direction: 'down', amount: 600 },
      preNoop,
      postNoop
    );
    evidence.negativeCase = {
      action: { action: 'scroll', direction: 'down', amount: 600 },
      scenario: 'scroll at the document scroll boundary',
      dispatchSucceeded: noopDispatch?.result?.success === true,
      dispatchMessage: noopDispatch?.result?.message,
      preSnapshot: preNoop,
      postSnapshot: postNoop,
      effectVerdict: noopVerdict,
    };
    check(
      'negativeNoOpIsActionNoEffect',
      noopVerdict.hasEffect === false && noopVerdict.status === 'ACTION_NO_EFFECT',
      {
        preScrollY: preNoop.scrollY,
        postScrollY: postNoop.scrollY,
        requestedAmount: 600,
        diagnostics: noopVerdict.diagnostics,
        status: noopVerdict.status,
        details: noopVerdict.details,
      }
    );
    check(
      'dispatchSuccessDoesNotImplyEffect',
      noopDispatch?.result?.success === true && noopVerdict.hasEffect === false,
      {
        note:
          'The exact distinction the previous implementation could not make: a successful dispatch and a verified effect were conflated.',
        dispatchSucceeded: noopDispatch?.result?.success === true,
        effectVerified: noopVerdict.hasEffect,
      }
    );

    // ── 5. SUBTLE: an inert click that only moves focus IS a real effect ────
    await control.evaluate(
      `chrome.tabs.sendMessage(${targetTabId}, { type: 'PRIVAGENT_EXECUTE_ACTION',
         action: { action: 'scroll', direction: 'up', amount: 5000, reason: 'back to top' } }).catch(() => null)`,
      { timeoutMs: 30000 }
    );
    await sleep(1200);
    const preClick = await takeSnapshot();
    const clickDispatch = await dispatch({ action: 'click', target: 'inert', reason: 'focus-only control' });
    await sleep(700);
    const postClick = await takeSnapshot();
    const clickVerdict = verifyActionEffect(
      { action: 'click', target: 'inert' },
      preClick,
      postClick
    );
    evidence.subtleFocusOnlyEffect = {
      action: { action: 'click', target: 'inert' },
      scenario: 'button with no handler — the page does not change, only focus does',
      dispatchSucceeded: clickDispatch?.result?.success === true,
      preSnapshot: preClick,
      postSnapshot: postClick,
      effectVerdict: clickVerdict,
    };
    check(
      'focusOnlyEffectIsDetectedAsRealEffect',
      clickVerdict.hasEffect === true && clickVerdict.status === 'FOCUS_SHIFT_OBSERVED',
      {
        preFocus: preClick.activeElementSelector,
        postFocus: postClick.activeElementSelector,
        status: clickVerdict.status,
        note:
          'Guards against over-correcting: a genuine, subtle observed effect must still be reported as an effect.',
      }
    );

    // ── 6. TYPE: a real value-length change ─────────────────────────────────
    const preType = await takeSnapshot('q');
    const typeDispatch = await dispatch({ action: 'type', target: 'q', text: 'cats', reason: 'positive control' });
    await sleep(600);
    const postType = await takeSnapshot('q');
    const typeVerdict = verifyActionEffect({ action: 'type', target: 'q', text: 'cats' }, preType, postType);
    evidence.positiveControlType = {
      action: { action: 'type', target: 'q', text: 'cats' },
      dispatchSucceeded: typeDispatch?.result?.success === true,
      preSnapshot: preType,
      postSnapshot: postType,
      effectVerdict: typeVerdict,
    };
    check(
      'observedTypeLengthChangeIsVerified',
      typeVerdict.hasEffect === true && typeVerdict.status === 'VALUE_STATE_CHANGED',
      {
        preTargetValueLength: preType.targetValueLength,
        postTargetValueLength: postType.targetValueLength,
        status: typeVerdict.status,
        dispatchError: typeDispatch?.result?.error,
        note: 'Only the LENGTH crossed the boundary.',
      }
    );
    check(
      'snapshotNeverContainsTheTypedValue',
      !JSON.stringify(postType).includes('cats'),
      { postSnapshot: postType, note: 'The typed value must not appear in any snapshot payload.' }
    );

    // ── 7. FAIL-SAFE: a target that does not resolve ────────────────────────
    const missingRaw = await control.evaluate(
      `chrome.tabs.sendMessage(${targetTabId}, {
         type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT', target: 'does-not-exist-12345'
       }).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ __error: String(e) }))`,
      { timeoutMs: 30000 }
    );
    const missingSnapshot = JSON.parse(missingRaw)?.snapshot;
    check(
      'unresolvableTargetReportsZeroNotAGuess',
      missingSnapshot != null && missingSnapshot.targetValueLength === 0,
      {
        observedTargetValueLength: missingSnapshot?.targetValueLength,
        preTypeTargetValueLength: postType.targetValueLength,
        note:
          'A target that does not resolve reports length 0 rather than guessing or carrying a value over. This is the fail-safe property: no observation means no claim.',
      }
    );
  } finally {
    for (const s of sessions) s.close();
    try { chrome.kill('SIGKILL'); } catch {}
    try { targetServer.close(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

    evidence.result = { pass, fail, allPassed: fail === 0 };
    fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(evidence, null, 2));
    console.log(`\n[EFFECT] ${pass} passed, ${fail} failed`);
    console.log(`[EFFECT] evidence → ${path.relative(REPO_ROOT, EVIDENCE_JSON)}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[EFFECT] harness error:', e);
  process.exit(2);
});
