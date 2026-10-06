/**
 * FINAL PRODUCT ACCEPTANCE AUDIT — NORMAL CHAT vs BROWSER-TASK ROUTING, real Chrome.
 *
 * What this proves, and nothing more:
 *   1. NORMAL-CHAT suite: each of the 7 ordinary messages is classified
 *      CONVERSATION by the deterministic route, is answered by the backend
 *      conversational endpoint, and produces ZERO target-tab resolution /
 *      tab provisioning / perception / action dispatch / navigation — the
 *      I-1 intent boundary is never even reached (no `intent classified`).
 *   2. BROWSER suite: each browser task is classified PIPELINE, admitted by
 *      the I-1 intent boundary, reaches TARGET_RESOLUTION_STARTED and runs
 *      the normal gates to a TYPED terminal state.
 *   3. BOUNDARY suite: mixed / deixis / vague / insufficient-target messages
 *      get the correct TYPED outcome and never invent a browser task from
 *      keywords (no tab provisioning, no dispatched actions for the cases
 *      that must not act).
 *
 * Provider mode: the gateway at :8010 is probed with a canary chat call at
 * startup. LIVE_PROVIDER is claimed ONLY if the real FastAPI backend answers
 * it. There is no controlled stub in this run.
 *
 * Run (one suite per process, they fit the 180s command budget):
 *   ST_SUITE=chat ST_CDP_PORT=9871 node scratch/final_chat_run.mjs
 *   ST_SUITE=chat ST_CASES=c1,c2 ST_OUT=... node scratch/final_chat_run.mjs
 *   ST_SUITE=browser ST_CASES=b1 node scratch/final_chat_run.mjs
 *   ST_SUITE=boundary ST_CASES=x3,x4 node scratch/final_chat_run.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  sleep,
  cdpGet,
  openSession,
  launchChrome,
  attachServiceWorker,
} from './phase16_cdp.mjs';

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9871);
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const FIXTURE = process.env.ST_FIXTURE || 'http://localhost:4174/';
const GATEWAY = process.env.ST_GATEWAY || 'http://127.0.0.1:8010';
const SUITE = process.env.ST_SUITE || 'chat';
const ONLY = (process.env.ST_CASES || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = process.env.ST_OUT || `final_chat_${SUITE}${ONLY.length ? '_' + ONLY.join('-') : ''}_raw.json`;

const TERMINAL = [
  'SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL', 'CANNOT_VERIFY',
  'NEEDS_INFORMATION', 'NEEDS_CLARIFICATION', 'PROVIDER_UNAVAILABLE',
  'COMMIT_UNKNOWN', 'FRESHNESS_UNVERIFIED',
];

const TIMEOUTS = {
  'normal-chat': 40000,
  browser: 70000,
  'boundary-pipeline': 70000,
  'boundary-fast': 40000,
};

const SUITES = {
  chat: [
    { id: 'c1', kind: 'normal-chat', text: 'Hi' },
    { id: 'c2', kind: 'normal-chat', text: 'Hello' },
    { id: 'c3', kind: 'normal-chat', text: 'How are you?' },
    { id: 'c4', kind: 'normal-chat', text: 'What is machine learning?' },
    { id: 'c5', kind: 'normal-chat', text: 'Explain TCP vs UDP' },
    { id: 'c6', kind: 'normal-chat', text: 'What is 2 + 2?' },
    { id: 'c7', kind: 'normal-chat', text: 'What is a binary search tree?' },
  ],
  browser: [
    { id: 'b1', kind: 'browser', text: 'Find the top 5 products on the shopping fixture.', stubMode: 'act_then_answer' },
    { id: 'b2', kind: 'browser', text: 'Search for laptops under \u20b950,000.', stubMode: 'click_fixture' },
    { id: 'b3', kind: 'browser', text: 'Open the third result.', stubMode: 'navigate_fixture' },
    { id: 'b4', kind: 'browser', text: 'Find the latest information about Charminar.', stubMode: 'navigate_wikipedia' },
  ],
  boundary: [
    { id: 'x1', kind: 'boundary-pipeline', text: 'I want to compare laptops and also add the cheapest one to my cart.', stubMode: 'click_fixture' },
    { id: 'x2', kind: 'boundary-pipeline', text: 'What is the price of this product?', stubMode: 'act_then_answer' },
    { id: 'x3', kind: 'boundary-fast', text: 'Tell me about it.' },
    { id: 'x4', kind: 'boundary-fast', text: 'Search the web' },
  ],
};

if (!SUITES[SUITE]) throw new Error(`unknown ST_SUITE=${SUITE}`);
let CASES = SUITES[SUITE];
if (ONLY.length) {
  CASES = CASES.filter((c) => ONLY.includes(c.id));
  if (!CASES.length) throw new Error(`no cases matched ST_CASES=${process.env.ST_CASES}`);
}

const out = {
  phase: 'FINAL-ACCEPTANCE-normal-chat-routing',
  suite: SUITE,
  casesRequested: CASES.map((c) => c.id),
  labels: 'pending',
  inputs: { dashboard: DASHBOARD_ORIGIN, fixture: FIXTURE, gateway: GATEWAY, stubUsed: false },
  environment: {},
  canary: null,
  providerMode: null,
  timeline: [],
  swLogs: [],
  results: [],
};

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const note = (what, detail) => out.timeline.push({ t: at(), what, ...(detail ? { detail: detail } : {}) });

// ── Provider canary: prove the gateway is the REAL backend before any claim ──
try {
  const tC = Date.now();
  const res = await fetch(`${GATEWAY}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'PrivAgent final audit canary. Reply with the single word OK.' }),
  });
  const body = await res.json().catch(() => ({}));
  out.canary = {
    ok: Boolean(res.ok && body.answer),
    httpStatus: res.status,
    model: body.model ?? null,
    ms: Date.now() - tC,
    answerPrefix: String(body.answer || '').slice(0, 80),
  };
} catch (err) {
  out.canary = { ok: false, error: String(err && err.message ? err.message : err) };
}
const canaryIsStub = Boolean(
  out.canary && out.canary.ok &&
  (out.canary.model === 'controlled_stub' || String(out.canary.answerPrefix).startsWith('CONTROLLED_STUB_ANSWER'))
);
out.providerMode = canaryIsStub
  ? 'CONTROLLED_PROVIDER (scratch/i8a7a8_controlled_provider.py on :8010)'
  : (out.canary && out.canary.ok
    ? `LIVE_PROVIDER (real FastAPI gateway :8010, model=${out.canary.model})`
    : 'LIVE_BACKEND_CHAT_CANARY_FAILED');
out.labels = canaryIsStub
  ? 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER'
  : (out.canary && out.canary.ok
    ? 'PROVEN_REAL_CHROME / LIVE_PROVIDER'
    : 'PROVEN_REAL_CHROME / BACKEND_LIVE_UNVERIFIED');
note('provider canary', out.canary);

const chrome = launchChrome(CDP_PORT);
let bs;
let page;
let fixtureTab;
let sw;

const MARKERS = {
  chatClassified: 'chat route classified',
  chatAccepted: 'normal chat accepted',
  chatUnavailable: 'normal chat unavailable',
  chatSuppressed: 'normal chat suppressed',
  intentClassified: 'intent classified',
  notAdmitted: 'task not admitted by the intent boundary',
  targetResolution: 'TARGET_RESOLUTION_STARTED',
  tabProvisioned: 'target tab provisioned',
  perception: 'perception started',
  actionValidated: 'action validated by M5',
  actionExecuted: 'ACTION_EXECUTED +',
  navigation: 'POST_NAVIGATION',
  responseForwarded: 'response forwarded',
};

const countMarkers = (logs) => {
  const counts = {};
  for (const [k, s] of Object.entries(MARKERS)) {
    counts[k] = logs.filter((l) => {
      if (k === 'targetResolution') {
        // The PING variant ('[SW][PING] TARGET_RESOLUTION_STARTED') is a
        // dashboard heartbeat, not a real target-resolution entry.
        return l.text.includes(s) && !l.text.includes('[SW][PING]');
      }
      return l.text.includes(s);
    }).length;
  }
  return counts;
};

const pick = (text, re) => {
  const m = text.match(re);
  return m ? m[1] : null;
};

const extractFields = (logs) => {
  const chatLine = (logs.find((l) => l.text.includes('chat route classified')) || {}).text || '';
  const intentLine = (logs.find((l) => l.text.includes('intent classified')) || {}).text || '';
  const forwarded = (logs.find((l) => l.text.includes('response forwarded')) || {}).text || '';
  const screen = (logs.find((l) => l.text.includes('output screen')) || {}).text || '';
  return {
    route: pick(chatLine, /route:\s*"?([A-Z_]+)"?/),
    code: pick(chatLine, /code:\s*"?([A-Z_]+)"?/),
    intent: pick(intentLine, /intent:\s*"?([A-Z_]+)"?/),
    admits: intentLine ? /admitsBrowserAutomation:\s*"?true"?/.test(intentLine) : null,
    refusal: pick(intentLine, /refusal:\s*"?([A-Z_]+)"?/),
    forwardedStatus: pick(forwarded, /status:\s*"?([A-Z_]+)"?/),
    screenOutcome: pick(screen, /outcome:\s*"?([A-Z_]+)"?/),
    screenResultKind: pick(screen, /resultKind:\s*"?([A-Z_]+)"?/),
  };
};

function evaluateCase(c, r) {
  const fails = [];
  if (!r.submitted) fails.push('message was never submitted');
  if (r.timedOut) fails.push('no terminal state before timeout');
  if (c.kind === 'normal-chat') {
    if (r.route !== 'CONVERSATION') fails.push(`route=${r.route}`);
    if (r.counts.chatClassified < 1) fails.push('chat route was never classified');
    if (r.counts.chatAccepted < 1) fails.push('normal chat was never accepted');
    for (const k of ['targetResolution', 'tabProvisioned', 'perception', 'actionValidated', 'actionExecuted', 'navigation', 'intentClassified', 'notAdmitted']) {
      if (r.counts[k] !== 0) fails.push(`${k}=${r.counts[k]} (must be 0)`);
    }
    if (r.terminalStatus !== 'ANSWER') fails.push(`status=${r.terminalStatus}`);
    if (r.counts.responseForwarded < 1) fails.push('answer was never forwarded to the dashboard');
    if (!r.answer) fails.push('no answer body');
    if (r.answer && r.answer.startsWith('CONTROLLED_STUB_ANSWER')) fails.push('stub answer in a live run');
    if (r.terminalReason !== 'CONVERSATIONAL_ANSWER') fails.push(`terminalReason=${r.terminalReason}`);
    if (r.finalResultKind !== 'ANSWER') fails.push(`finalResultKind=${r.finalResultKind}`);
    if (r.answerProvenance !== null) fails.push('conversational answer must carry no page provenance');
  } else if (c.kind === 'browser') {
    if (r.route !== 'PIPELINE') fails.push(`route=${r.route}`);
    if (r.admits !== true) fails.push(`admitsBrowserAutomation=${r.admits}`);
    if (r.counts.intentClassified < 1) fails.push('I-1 intent boundary never ran');
    if (r.counts.targetResolution < 1) fails.push('target resolution never started');
    if (!r.terminalStatus) fails.push('no typed terminal state');
    if (!TERMINAL.includes(r.terminalStatus)) fails.push(`non-typed status=${r.terminalStatus}`);
  } else if (c.kind === 'boundary-fast') {
    if (r.route !== 'PIPELINE') fails.push(`route=${r.route}`);
    if (r.counts.tabProvisioned !== 0) fails.push(`tabProvisioned=${r.counts.tabProvisioned} (must be 0)`);
    if (r.counts.actionExecuted !== 0) fails.push(`actionExecuted=${r.counts.actionExecuted} (must be 0)`);
    if (!r.terminalStatus || !TERMINAL.includes(r.terminalStatus)) fails.push(`status=${r.terminalStatus} (typed terminal required)`);
  } else if (c.kind === 'boundary-pipeline') {
    if (r.route !== 'PIPELINE') fails.push(`route=${r.route}`);
    if (r.counts.chatAccepted !== 0) fails.push('pipeline message wrongly accepted as chat');
    if (r.counts.intentClassified < 1) fails.push('I-1 intent boundary never ran');
    if (!r.terminalStatus || !TERMINAL.includes(r.terminalStatus)) fails.push(`status=${r.terminalStatus} (typed terminal required)`);
  }
  return fails;
}

async function injectListener() {
  await page.send('Runtime.evaluate', {
    expression: `
      window.__fx = [];
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.source !== 'privagent-extension') return;
        if (d.type !== 'TASK_PROGRESS' || !d.payload) return;
        const p = d.payload;
        const ix = p.interaction || null;
        window.__fx.push({
          t: Date.now(), runId: p.runId ?? null, status: p.status, task: p.task || null,
          reason: p.reason || null, conversational: p.conversational ?? null,
          steps: Array.isArray(p.steps) ? p.steps.length : 0,
          outcome: ix ? ix.outcome || null : null,
          terminal: ix ? ix.terminal || null : null,
          finalResult: ix ? ix.finalResult || null : null,
        });
      });
      true;
    `,
    returnByValue: true,
  });
}

async function readEvents() {
  const raw = await page.send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__fx || [])',
    returnByValue: true,
  });
  try { return JSON.parse(raw?.result?.value || '[]'); } catch { return []; }
}

async function ensureComposer() {
  for (let i = 0; i < 10; i += 1) {
    const r = await page.send('Runtime.evaluate', {
      expression: `(() => {
        const ta = document.getElementById('composer-input');
        const btn = document.getElementById('composer-btn-run');
        return (ta && btn && !ta.disabled && !btn.disabled) ? 'ready' : 'wait';
      })()`,
      returnByValue: true,
    });
    if (r?.result?.value === 'ready') return 'ready';
    await sleep(800);
  }
  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(3500);
  await injectListener();
  out.environment.dashboardReloads = (out.environment.dashboardReloads || 0) + 1;
  return 'reloaded';
}

async function runCase(c) {
  const swStart = out.swLogs.length;
  if (c.stubMode && canaryIsStub) {
    // Controlled runs only: the harness picks the stub mode, never the page.
    try {
      const res = await fetch(`${GATEWAY}/mode?set=${c.stubMode}`);
      const body = await res.json().catch(() => ({}));
      note(`stub mode set for ${c.id}`, { requested: c.stubMode, actual: body.stub_mode ?? null });
    } catch (err) {
      note(`stub mode set FAILED for ${c.id}`, { error: String(err && err.message ? err.message : err) });
    }
  }
  const readiness = await ensureComposer();
  await page.send('Runtime.evaluate', { expression: 'window.__fx = []; true;', returnByValue: true });
  await sleep(400);

  const submit = await page.send('Runtime.evaluate', {
    expression: `
      (() => {
        const ta = document.getElementById('composer-input');
        const btn = document.getElementById('composer-btn-run');
        if (!ta || !btn) return 'controls-missing';
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(c.text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        btn.click();
        return 'submitted';
      })()
    `,
    returnByValue: true,
  });
  const submitted = submit?.result?.value === 'submitted';
  const tStart = Date.now();
  note(`case ${c.id} submitted`, { text: c.text, readiness });

  const deadline = tStart + TIMEOUTS[c.kind];
  let events = [];
  let termSeenAt = null;
  let prevLen = -1;
  while (Date.now() < deadline) {
    await sleep(1200);
    events = await readEvents();
    const hasTerm = events.some((e) => TERMINAL.includes(e.status));
    if (hasTerm && !termSeenAt) termSeenAt = Date.now();
    if (termSeenAt) {
      const waited = Date.now() - termSeenAt;
      const grew = events.length !== prevLen;
      prevLen = events.length;
      const hasResult = events.some((e) => e.finalResult && e.finalResult.kind);
      if (waited >= 10000) break;
      if (!grew && waited >= 3000 && (hasResult || waited >= 8000)) break;
    }
  }
  const timedOut = !events.some((e) => TERMINAL.includes(e.status));
  await sleep(800); // let the last service-worker console lines flush

  const caseLogs = out.swLogs.slice(swStart);
  const terminalEvent = [...events].reverse().find((e) => TERMINAL.includes(e.status)) || null;
  const resultEvent = [...events].reverse().find((e) => e.finalResult && e.finalResult.kind) || terminalEvent;
  const fields = extractFields(caseLogs);
  const body = await page.send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText.slice(0, 1500) : ""',
    returnByValue: true,
  });

  const r = {
    id: c.id,
    kind: c.kind,
    text: c.text,
    submitted,
    readiness,
    timedOut,
    stubMode: c.stubMode || null,
    durationMs: Date.now() - tStart,
    ...fields,
    counts: countMarkers(caseLogs),
    terminalStatus: terminalEvent ? terminalEvent.status : null,
    finalResultKind: resultEvent && resultEvent.finalResult ? resultEvent.finalResult.kind : null,
    terminalReason: terminalEvent && terminalEvent.terminal ? terminalEvent.terminal.reason : null,
    terminalHeadline: terminalEvent && terminalEvent.terminal ? terminalEvent.terminal.headline : null,
    outcome: terminalEvent ? terminalEvent.outcome : null,
    answer: resultEvent && resultEvent.finalResult && resultEvent.finalResult.body
      ? String(resultEvent.finalResult.body).slice(0, 1500)
      : null,
    answerProvenance: resultEvent && resultEvent.finalResult ? resultEvent.finalResult.provenance ?? null : null,
    events,
    dashboardBodyExcerpt: String(body?.result?.value || '').slice(0, 1200),
    swLogs: caseLogs,
  };
  r.fails = evaluateCase(c, r);
  r.pass = r.fails.length === 0;
  out.results.push(r);
  note(`case ${c.id} terminal`, { status: r.terminalStatus, route: r.route, pass: r.pass, fails: r.fails });
  return r;
}

try {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('chrome CDP never became ready');
  out.environment.chromeVersion = version.Browser || 'unknown';

  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });

  const fixture = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(FIXTURE)}`, 'PUT');
  fixtureTab = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${fixture.id}`);
  await fixtureTab.send('Runtime.enable');
  await fixtureTab.send('Page.enable');
  await sleep(1500);

  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(4000);

  sw = await attachServiceWorker(CDP_PORT);
  if (!sw) throw new Error('service worker not found');
  await sw.send('Runtime.enable', {});

  const swOnMessage = sw.ws.onmessage;
  sw.ws.onmessage = async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || [])
          .map((a) => {
            if (a.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
            if (a.preview && Array.isArray(a.preview.properties)) {
              return `{${a.preview.properties.map((p) => `${p.name}:${p.value !== undefined ? p.value : p.type}`).join(',')}}`;
            }
            return a.description || '';
          })
          .join(' ');
        out.swLogs.push({ t: at(), text: text.slice(0, 600) });
      }
    } catch { /* ignore */ }
    try { swOnMessage.call(sw.ws, ev); } catch { /* ignore */ }
  };

  await injectListener();
  note('listener injected, fixture + dashboard open', { fixture: FIXTURE });

  for (const c of CASES) {
    await runCase(c);
  }
} finally {
  try { bs?.close?.(); } catch { /* ignore */ }
  try { page?.close?.(); } catch { /* ignore */ }
  try { fixtureTab?.close?.(); } catch { /* ignore */ }
  try { chrome?.proc?.kill?.(); } catch { /* ignore */ }
}

out.summary = {
  casesRun: out.results.length,
  passed: out.results.filter((r) => r.pass).length,
  failed: out.results.filter((r) => !r.pass).length,
};
const outDir = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, OUT), JSON.stringify(out, null, 2));
console.log(`wrote docs/evidence/post-17-10/audit/${OUT}`);
console.log(`  providerMode: ${out.providerMode}`);
console.log(`  summary: ${JSON.stringify(out.summary)}`);
for (const r of out.results) {
  console.log(`  ${r.id} [${r.pass ? 'PASS' : 'FAIL'}] route=${r.route} status=${r.terminalStatus} reason=${r.terminalReason} counts=${JSON.stringify(r.counts)}`);
  if (!r.pass) console.log(`      fails: ${JSON.stringify(r.fails)}`);
}
// Explicit exit: keep-alive sockets would otherwise hold the event loop open.
process.exit(0);
