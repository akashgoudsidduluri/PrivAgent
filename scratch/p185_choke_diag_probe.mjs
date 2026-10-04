/**
 * PHASE I-7 — CHOKE POINT DIAGNOSTIC PAYLOAD PROBE (real Chrome).
 *
 * `p185_target_console.mjs` proves the choke point FIRES on the real Wikipedia
 * page, but CDP renders `console.warn(msg, obj)` as the string "Object" — it
 * never resolves the argument. This probe resolves it, so the real-world
 * diagnostic payload can be inspected directly.
 *
 * What it asserts (read-only, no production code):
 *   - the choke-point warning fires at all (sanitization actually happened)
 *   - the payload contains counts and rule NAMES only
 *   - the payload contains NO raw sensitive value of any shape
 *
 * Env: ST_TASK, ST_CDP_PORT, ST_SETTLE_MS
 */
import fs from 'fs';
import path from 'path';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome, attachServiceWorker } from './phase16_cdp.mjs';

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9901);
const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const URL_UNDER_TEST = process.env.ST_PROBE_URL || 'https://en.wikipedia.org/wiki/Charminar';
const TASK = process.env.ST_TASK || 'open wikipedia and find information about charminar';
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 60000);

const out = { url: URL_UNDER_TEST, task: TASK, chokePointPayloads: [], withheldPayloads: [], failureLines: [] };

// Shapes that must NEVER appear in a diagnostic payload.
const RAW_PATTERNS = [
  ['phone_10digit', /\b\d{10}\b/],
  ['card_16digit', /\b(?:4111|4242|5555|3782)\d{10,}\b/],
  ['email', /[\w.+-]+@[\w-]+\.[\w.]{2,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/],
  ['labelled_credential', /(?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*\S{4,}/i],
];

const chrome = launchChrome(CDP_PORT);
let dash, targetTab;

try {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
  }
  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  const bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });

  const dashCreated = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`http://localhost:${DASHBOARD_PORT}/`)}`, 'PUT');
  dash = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${dashCreated.id}`);
  await dash.send('Page.enable');
  await dash.send('Runtime.enable');
  await sleep(3500);

  const tabCreated = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(URL_UNDER_TEST)}`, 'PUT');
  targetTab = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${tabCreated.id}`);
  await targetTab.send('Page.enable');
  await targetTab.send('Runtime.enable');

  const resolve = async (objectId) => {
    try {
      const r = await targetTab.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ try { return JSON.stringify(this); } catch (e) { return "UNSERIALIZABLE"; } }',
        returnByValue: true,
      });
      return r && r.result && r.result.value;
    } catch { return null; }
  };

  targetTab.ws.addEventListener('message', async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method !== 'Runtime.consoleAPICalled') return;
      const head = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : '')).join(' ');
      if (/world model build|sanitization failed|PrivacyViolation/i.test(head)) {
        out.failureLines.push(head.slice(0, 300));
        return;
      }
      const isChoke = /choke point/.test(head);
      const isA11y = /accessibility names withheld/.test(head);
      if (!isChoke && !isA11y) return;
      for (const a of m.params.args || []) {
        if (a.objectId) {
          const payload = await resolve(a.objectId);
          (isChoke ? out.chokePointPayloads : out.withheldPayloads).push(payload);
        }
      }
    } catch { /* ignore */ }
  });

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
  try { if (dash) await dash.send('Page.close').catch(() => {}); } catch { /* ignore */ }
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { if (chrome.profile) fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
const allPayloads = [...out.chokePointPayloads, ...out.withheldPayloads];
const rawLeaks = [];
for (const p of allPayloads) {
  for (const [name, re] of RAW_PATTERNS) {
    if (p && re.test(p)) rawLeaks.push({ name, sample: p.slice(0, 200) });
  }
}

console.log('=== failure / violation lines:', out.failureLines.length);
for (const f of out.failureLines) console.log('   !!', f);
console.log('=== choke-point warning payloads captured:', out.chokePointPayloads.length);
for (const p of out.chokePointPayloads.slice(0, 4)) console.log('   ', p);
console.log('=== accessibility-withheld payloads captured:', out.withheldPayloads.length);
for (const p of out.withheldPayloads.slice(0, 4)) console.log('   ', p);
console.log('=== RAW SENSITIVE VALUES FOUND IN DIAGNOSTICS:', rawLeaks.length);
for (const l of rawLeaks) console.log('   !!', l.name, l.sample);

fs.writeFileSync(
  path.join(REPO_ROOT, 'scratch', 'probe_choke_diag.json'),
  JSON.stringify({ ...out, verdict: { failureLines: out.failureLines.length, payloads: allPayloads.length, rawLeaks: rawLeaks.length } }, null, 2)
);