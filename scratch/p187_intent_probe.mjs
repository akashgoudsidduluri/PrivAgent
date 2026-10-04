/**
 * PHASE 18.7 / I-1 — REAL-BROWSER INTENT BOUNDARY PROBE.
 *
 * Read-only. Loads the PRODUCTION build (dist) into real Chrome with the real
 * dashboard and the real backend, then submits one task and records the
 * evidence the I-1 acceptance criteria require:
 *
 *   1. the classified intent and whether it was admitted
 *   2. whether a TARGET TAB was resolved or provisioned  (must be 0 if refused)
 *   3. whether the PROVIDER was called                   (must be 0 if refused)
 *   4. the truthful terminal state shown to the user
 *
 * A refused task must show NONE of: TARGET_RESOLUTION_STARTED,
 * TARGET_TAB_CANDIDATES, /api/v1/agent/action. Those are the observable
 * footprints of tab provisioning and provider traffic.
 */
import fs from 'fs';
import path from 'path';
import { REPO_ROOT, sleep, cdpGet, openSession, launchChrome, attachServiceWorker } from './phase16_cdp.mjs';

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9921);
const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const TASK = process.env.ST_TASK || 'open wikipedia and find information about charminar';
const LABEL = process.env.ST_LABEL || TASK;
const START_URL = process.env.ST_START_URL || '';
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 30000);

const out = {
  label: LABEL,
  task: TASK,
  startUrl: START_URL || null,
  classificationLines: [],
  targetResolutionStarted: 0,
  targetTabCandidates: 0,
  targetTabFailed: 0,
  providerRequests: 0,
  intentNotAdmitted: 0,
  swErrors: [],
  terminalState: null,
  dashboardBody: null,
};

const chrome = launchChrome(CDP_PORT);
let dash, sw;

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

  if (START_URL) {
    await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(START_URL)}`, 'PUT');
    await sleep(1500);
  }
  await sleep(2500);

  sw = await attachServiceWorker(CDP_PORT);
  if (sw) {
    await sw.send('Network.enable', {});
    await sw.send('Runtime.enable', {});
  }

  const swOnMessage = sw.ws.onmessage;
  sw.ws.onmessage = async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Network.requestWillBeSent') {
        if ((m.params.request.url || '').includes('/api/v1/agent/action')) out.providerRequests += 1;
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const parts = [];
        for (const a of m.params.args || []) {
          if (a.value !== undefined) parts.push(typeof a.value === 'string' ? a.value : JSON.stringify(a.value));
          else if (a.objectId) {
            // Resolve the object argument. Without this the classification
            // renders as the string "Object" and the ACTUAL intent value is
            // never observed in the runtime — only inferred from the refusal.
            let rendered = a.description ?? a.type;
            try {
              const r = await sw.send('Runtime.callFunctionOn', {
                objectId: a.objectId,
                functionDeclaration: 'function(){ try { return JSON.stringify(this); } catch (e) { return "UNSERIALIZABLE"; } }',
                returnByValue: true,
              });
              if (r && r.result && r.result.value) rendered = String(r.result.value).slice(0, 400);
            } catch { /* keep description */ }
            parts.push(rendered);
          } else parts.push(a.description ?? a.type);
        }
        const text = parts.join(' ');
        if (/intent classified/.test(text)) out.classificationLines.push(text);
        // EXACT match on the bare string only. The service worker also logs
        // `[SW][PING] TARGET_RESOLUTION_STARTED` for a connectivity ping that has
        // nothing to do with task admission; a substring match counted that too
        // and produced a misleadingly non-zero number.
        if (text.trim() === 'TARGET_RESOLUTION_STARTED') out.targetResolutionStarted += 1;
        if (text.includes('TARGET_TAB_CANDIDATES')) out.targetTabCandidates += 1;
        if (text.includes('TARGET_TAB_FAILED')) out.targetTabFailed += 1;
        if (/not admitted by the intent boundary/.test(text)) out.intentNotAdmitted += 1;
        if (m.params.type === 'error') out.swErrors.push(text.slice(0, 300));
      }
    } catch { /* ignore */ }
    if (swOnMessage) swOnMessage.call(sw.ws, ev);
  };

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

  const body = await dash.send('Runtime.evaluate', {
    expression: `document.body.innerText.slice(0, 1200)`,
    returnByValue: true,
  });
  out.dashboardBody = body?.result?.value ?? null;
  const m = out.dashboardBody?.match(/\b(SUCCESS|FAILED|NEEDS_CLARIFICATION|STOPPED|NEEDS_USER_CONFIRMATION|IN_PROGRESS)\b/);
  out.terminalState = m ? m[1] : 'UNKNOWN';
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
} finally {
  try { if (dash) await dash.send('Page.close').catch(() => {}); } catch { /* ignore */ }
  try { if (chrome.proc) chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { if (chrome.profile) fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('=== TASK:', JSON.stringify(out.label));
console.log('=== classification:', out.classificationLines[0] ?? '(none)');
console.log('=== intentNotAdmitted:', out.intentNotAdmitted);
console.log('=== TARGET_RESOLUTION_STARTED:', out.targetResolutionStarted, '| TARGET_TAB_CANDIDATES:', out.targetTabCandidates, '| TARGET_TAB_FAILED:', out.targetTabFailed);
console.log('=== providerRequests(/api/v1/agent/action):', out.providerRequests);
console.log('=== terminalState:', out.terminalState);
if (out.error) console.log('=== ERROR:', out.error);

fs.writeFileSync(
  path.join(REPO_ROOT, 'scratch', `p187_intent_${(out.label || 'task').replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.json`),
  JSON.stringify(out, null, 2)
);