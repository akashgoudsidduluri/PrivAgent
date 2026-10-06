/**
 * DYNAMIC TASK-AWARE UI — REAL CHROME verification (Phase 9).
 *
 * Runs the PRODUCTION extension + dashboard in real Chrome and captures what
 * the user actually sees:
 *
 *   TEST A — "hi"                      → normal chat UI, zero browser chrome
 *   TEST B — "What is machine learning?" → normal chat UI, zero browser chrome
 *   TEST E — real browser task (live provider fails closed) → failure UI,
 *            activity preserved, no fake success, not stuck working
 *   TEST F — "hi" after E (same page)  → clean normal chat UI, no residue
 *   (live suite runs A, B, E, F)
 *
 *   TEST C — "search for cats"         → browser activity UI driven by real
 *            runtime events, no fabricated steps   (controlled suite)
 *   TEST D — "open Wikipedia"          → navigation activity while navigating,
 *            final result after verification       (controlled suite)
 *
 * Provider mode is detected by a canary and recorded honestly:
 *   LIVE_PROVIDER      — real FastAPI gateway answered the chat canary
 *   CONTROLLED_PROVIDER — the scratch stub answered it
 *
 * Run:
 *   ST_SUITE=live       ST_CDP_PORT=9885 node scratch/dynamic_ui_run.mjs
 *   ST_SUITE=controlled ST_CDP_PORT=9886 node scratch/dynamic_ui_run.mjs
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

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9885);
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const FIXTURE = process.env.ST_FIXTURE || 'http://localhost:4174/';
const GATEWAY = process.env.ST_GATEWAY || 'http://127.0.0.1:8010';
const SUITE = process.env.ST_SUITE || 'live';
const OUT = process.env.ST_OUT || `real_chrome_ui_${SUITE}.json`;
const SHOTS = path.join(REPO_ROOT, 'docs', 'evidence', 'dynamic-ui', 'shots');

const SUITES = {
  // reload:true isolates the case on a fresh dashboard; F deliberately reuses
  // E's page so "return to normal chat AFTER a browser task" is proven in the
  // same session.
  live: [
    { id: 'A', task: 'hi', reload: true, timeoutMs: 30000, expect: 'chat' },
    { id: 'B', task: 'What is machine learning?', reload: true, timeoutMs: 30000, expect: 'chat' },
    { id: 'E', task: 'Find the latest information about Charminar.', reload: true, timeoutMs: 75000, expect: 'browser-failure' },
    { id: 'F', task: 'hi', reload: false, timeoutMs: 30000, expect: 'chat-after-browser' },
  ],
  controlled: [
    { id: 'C', task: 'search for cats', reload: true, timeoutMs: 70000, mode: 'act_then_answer', expect: 'browser-activity' },
    { id: 'D', task: 'open Wikipedia', reload: true, timeoutMs: 70000, mode: 'navigate_wikipedia', expect: 'browser-navigation' },
  ],
};

if (!SUITES[SUITE]) throw new Error(`unknown ST_SUITE=${SUITE}`);
let CASES = SUITES[SUITE];
const ONLY = (process.env.ST_CASES || '').split(',').map((s) => s.trim()).filter(Boolean);
if (ONLY.length) CASES = CASES.filter((c) => ONLY.includes(c.id));

const CONVERSATION_BANNED = [
  'Agent Activity Timeline',
  'activity-timeline-section',
  'agent-response-card',
  'timeline-entry',
  'diagnostics-details',
  'Browser Context',
  'Local Privacy Boundary',
  'Task received',
  'Privacy boundary active',
];

const out = {
  phase: 'DYNAMIC-TASK-AWARE-UI',
  work: 'Real Chrome: task-aware dashboard surfaces (tests A–F)',
  labels: 'pending',
  suite: SUITE,
  inputs: { dashboard: DASHBOARD_ORIGIN, fixture: FIXTURE, gateway: GATEWAY, cases: CASES.map((c) => c.id) },
  environment: {},
  canary: null,
  providerMode: null,
  timeline: [],
  swLogs: [],
  pageLogs: [],
  results: [],
};

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const note = (what, detail) => out.timeline.push({ t: at(), what, ...(detail !== undefined ? { detail } : {}) });

// ── Provider canary ─────────────────────────────────────────────────────────
try {
  const tC = Date.now();
  const res = await fetch(`${GATEWAY}/api/v1/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'PrivAgent dynamic-UI canary. Reply with the single word OK.' }),
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
  (out.canary.model === 'controlled_stub' || String(out.canary.answerPrefix).startsWith('CONTROLLED_STUB_ANSWER')),
);
out.providerMode = canaryIsStub
  ? 'CONTROLLED_PROVIDER (scratch/i8a7a8_controlled_provider.py on :8010)'
  : (out.canary && out.canary.ok
    ? `LIVE_PROVIDER (real FastAPI gateway :8010, model=${out.canary.model})`
    : 'LIVE_BACKEND_CHAT_CANARY_FAILED');
out.labels = canaryIsStub
  ? 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER'
  : (out.canary && out.canary.ok ? 'PROVEN_REAL_CHROME / LIVE_PROVIDER' : 'PROVEN_REAL_CHROME / BACKEND_LIVE_UNVERIFIED');
note('provider canary', out.canary);

const MARKERS = {
  chatClassified: 'chat route classified',
  chatAccepted: 'normal chat accepted',
  intentClassified: 'intent classified',
  targetResolution: 'TARGET_RESOLUTION_STARTED',
  tabProvisioned: 'target tab provisioned',
  perception: 'perception started',
  actionExecuted: 'ACTION_EXECUTED +',
  responseForwarded: 'response forwarded',
};
const countMarkers = (logs) => {
  const counts = {};
  for (const [k, s] of Object.entries(MARKERS)) {
    counts[k] = logs.filter((l) =>
      k === 'targetResolution'
        ? l.text.includes(s) && !l.text.includes('[SW][PING]')
        : l.text.includes(s),
    ).length;
  }
  return counts;
};

const chrome = launchChrome(CDP_PORT);
let bs;
let page;
let fixtureTab;
let sw;

async function reloadDashboard() {
  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(4000);
}

async function ensureComposer() {
  for (let i = 0; i < 12; i += 1) {
    const r = await page.send('Runtime.evaluate', {
      expression: `(() => {
        const ta = document.getElementById('composer-input');
        const btn = document.getElementById('composer-btn-run');
        return (ta && btn && !ta.disabled && !btn.disabled) ? 'ready' : 'wait';
      })()`,
      returnByValue: true,
    });
    if (r?.result?.value === 'ready') return 'ready';
    await sleep(700);
  }
  return 'not-ready';
}

async function submitTask(task) {
  const r = await page.send('Runtime.evaluate', {
    expression: `
      (() => {
        const ta = document.getElementById('composer-input');
        const btn = document.getElementById('composer-btn-run');
        if (!ta || !btn) return 'controls-missing';
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(task)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        btn.click();
        return 'submitted';
      })()
    `,
    returnByValue: true,
  });
  return r?.result?.value || 'error';
}

/**
 * One snapshot of what the user sees right now.
 */
async function snapshot() {
  const expr = `JSON.stringify((() => {
    const content = document.querySelector('#workspace-content');
    if (!content) return { missing: true };
    const surfaceEl = content.querySelector('[data-surface]');
    const panel = content.querySelector('.final-response-panel');
    const bubble = content.querySelector('.assistant-message-bubble');
    const pending = Boolean(content.querySelector('.typing-dots'));
    const workingEls = [...content.querySelectorAll('.working-label')].map((e) => e.textContent.trim());
    const activityEls = [...content.querySelectorAll('.timeline-title')].map((e) => e.textContent.trim());
    const details = content.querySelector('#activity-details');
    const composer = document.getElementById('composer-btn-run');
    return {
      surface: surfaceEl ? surfaceEl.getAttribute('data-surface') : null,
      text: (content.innerText || '').slice(0, 6000),
      html: (content.innerHTML || '').slice(0, 60000),
      panelClass: panel ? panel.className : null,
      panelHeadline: panel ? (panel.querySelector('.final-headline-group')?.textContent || '').trim() : null,
      assistantBody: bubble ? (bubble.textContent || '').trim() : null,
      bubbleTone: bubble ? bubble.getAttribute('data-tone') : null,
      pending,
      workingLabels: workingEls,
      activities: activityEls,
      activityDetailsOpen: details ? details.open : null,
      hasActivityDetails: Boolean(details),
      composerReady: composer ? !composer.disabled : false,
      consoleHasError: false,
    };
  })())`;
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  try { return JSON.parse(r?.result?.value || '{}'); } catch { return {}; }
}

function evaluateCase(c, snap, samples, counts, shotFile) {
  const fails = [];
  const html = snap.html || '';
  const text = snap.text || '';
  const marker = (m) => {
    if (html.includes(m)) fails.push(`banned chrome present: ${m}`);
  };

  if (c.expect === 'chat' || c.expect === 'chat-after-browser') {
    if (snap.surface !== 'conversation') fails.push(`surface=${snap.surface} (expected conversation)`);
    if (!snap.assistantBody || snap.assistantBody.length < 2) fails.push('no assistant response text');
    for (const m of CONVERSATION_BANNED) marker(m);
    if (/Step \d+ of \d+/.test(html)) fails.push('Step N of M present');
    if (html.includes('data-state="working"')) fails.push('browser working row present');
    if (c.expect === 'chat') {
      if (counts.chatAccepted < 1) fails.push('chat route was never accepted');
      if (counts.targetResolution !== 0) fails.push(`targetResolution=${counts.targetResolution}`);
      if (counts.tabProvisioned !== 0) fails.push(`tabProvisioned=${counts.tabProvisioned}`);
      if (counts.actionExecuted !== 0) fails.push(`actionExecuted=${counts.actionExecuted}`);
      if (counts.intentClassified !== 0) fails.push('I-1 intent boundary ran for plain chat');
    }
    if (c.expect === 'chat-after-browser') {
      if (/Charminar/i.test(text)) fails.push('stale browser-task content in chat UI');
      if (html.includes('timeline-entry')) fails.push('stale activity timeline in chat UI');
      if (counts.targetResolution !== 0) fails.push(`targetResolution=${counts.targetResolution} for the chat message`);
    }
  }

  if (c.expect.startsWith('browser')) {
    if (snap.surface !== 'browser') fails.push(`surface=${snap.surface} (expected browser)`);
    if (/Step \d+ of \d+/.test(html)) fails.push('Step N of M present');
    if (html.includes('Task received')) fails.push('fixed entry "Task received" present');
    if (html.includes('Privacy boundary active')) fails.push('fixed entry "Privacy boundary active" present');
    if (html.includes('Agent Activity Timeline')) fails.push('fixed Agent Activity Timeline present');
    if (!snap.panelClass) fails.push('no terminal result panel');
    if (counts.intentClassified < 1) fails.push('I-1 intent boundary did not run');
    if (counts.targetResolution < 1) fails.push('target resolution did not start');

    const observedLabels = [...new Set(samples.flatMap((s) => [...s.workingLabels, ...s.activities]))];
    if (c.expect === 'browser-activity') {
      if (observedLabels.length === 0) fails.push('no dynamic activity label was ever observed');
      if (samples.some((s) => s.workingLabel == null) && samples.every((s) => s.workingLabels.length === 0)) {
        fails.push('working indicator never shown while running');
      }
      // No fabricated future steps: every rendered activity must correspond to
      // an observed runtime event — the fixed vocabulary contains no entry for
      // events that never reported.
      for (const banned of ['Task terminated safely', 'Destination verified & task completed']) {
        if (html.includes(banned)) fails.push(`fabricated timeline entry: ${banned}`);
      }
    }
    if (c.expect === 'browser-failure') {
      if (!/failure/.test(snap.panelClass || '')) fails.push(`panelClass=${snap.panelClass} (expected failure)`);
      if (/final-response-panel success/.test(html)) fails.push('fake success rendered');
      if (samples[samples.length - 1]?.workingLabels?.length && !snap.panelClass) {
        fails.push('still in working state at the end');
      }
      if (snap.activities.length < 1) fails.push('activity context lost on failure');
      if (!snap.composerReady) fails.push('composer stuck after failure');
    }
    if (c.expect === 'browser-navigation') {
      const observed = [...new Set(samples.flatMap((s) => [...s.workingLabels, ...s.activities]))];
      if (!observed.some((l) => /^Opening/.test(l))) fails.push(`no navigation activity observed (saw: ${observed.join(' | ') || 'none'})`);
      if (counts.actionExecuted < 1) fails.push('no action was actually dispatched/executed');
      if (!snap.panelClass) fails.push('no final result after navigation');
    }
    return { fails, observedLabels };
  }

  return { fails, observedLabels: [] };
}

async function screenshot(file) {
  try {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  } catch {
    return null;
  }
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
  await sleep(1200);

  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
  page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  // Capture the DASHBOARD's own console: adapter drop reasons land here.
  const pageOnMessage = page.ws.onmessage;
  page.ws.onmessage = async (ev) => {
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
        out.pageLogs.push({ t: at(), text: text.slice(0, 600) });
      }
    } catch { /* ignore */ }
    try { pageOnMessage.call(page.ws, ev); } catch { /* ignore */ }
  };
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

  for (const c of CASES) {
    if (c.mode && canaryIsStub) {
      try {
        const res = await fetch(`${GATEWAY}/mode?set=${c.mode}`);
        const body = await res.json().catch(() => ({}));
        note(`stub mode set for ${c.id}`, { requested: c.mode, actual: body.stub_mode ?? null });
      } catch (err) {
        note(`stub mode set FAILED for ${c.id}`, { error: String(err && err.message ? err.message : err) });
      }
    }
    if (c.reload) await reloadDashboard();
    const readiness = await ensureComposer();
    const swStart = out.swLogs.length;
    const pageLogStart = out.pageLogs.length;

    const submitted = await submitTask(c.task);
    note(`case ${c.id} submitted`, { task: c.task, readiness, submitted });

    const deadline = Date.now() + c.timeoutMs;
    const samples = [];
    let sawTyping = false;
    let snap = {};
    let done = false;
    while (Date.now() < deadline) {
      await sleep(450);
      snap = await snapshot();
      samples.push({
        t: Date.now(),
        surface: snap.surface,
        workingLabels: snap.workingLabels || [],
        activities: snap.activities || [],
        pending: snap.pending,
        panelClass: snap.panelClass,
      });
      if (snap.pending) sawTyping = true;
      if (snap.surface === 'conversation' && snap.assistantBody && !snap.pending && snap.assistantBody.length > 2) {
        done = true; break;
      }
      if (snap.surface === 'browser' && snap.panelClass) {
        // Grace: let the post-terminal render settle and any late activity land.
        await sleep(1200);
        snap = await snapshot();
        done = true; break;
      }
    }
    await sleep(400);

    const caseLogs = out.swLogs.slice(swStart);
    const pageCaseLogs = out.pageLogs.slice(pageLogStart);
    const counts = countMarkers(caseLogs);
    const shotFile = path.join(SHOTS, `${c.id}_${SUITE}.png`);
    const shot = await screenshot(shotFile);
    const { fails, observedLabels } = evaluateCase(c, snap, samples, counts, shot);

    const result = {
      id: c.id,
      suite: SUITE,
      task: c.task,
      expect: c.expect,
      submitted,
      readiness,
      timedOut: !done,
      providerMode: out.providerMode,
      surface: snap.surface ?? null,
      panelClass: snap.panelClass ?? null,
      panelHeadline: snap.panelHeadline ?? null,
      assistantBody: snap.assistantBody ? String(snap.assistantBody).slice(0, 900) : null,
      bubbleTone: snap.bubbleTone ?? null,
      sawTypingIndicator: sawTyping,
      activityDetailsPresent: snap.hasActivityDetails ?? false,
      activityDetailsOpenAtEnd: snap.activityDetailsOpen ?? null,
      renderedActivitiesAtEnd: snap.activities || [],
      observedLabels,
      sampleCount: samples.length,
      counts,
      composerReadyAtEnd: snap.composerReady ?? null,
      screenshot: shot,
      textExcerpt: String(snap.text || '').slice(0, 2500),
      fails,
      pass: fails.length === 0 && done,
      samples,
      swLogs: caseLogs,
      pageLogs: pageCaseLogs,
    };
    out.results.push(result);
    note(`case ${c.id} evaluated`, { pass: result.pass, surface: result.surface, panel: result.panelClass, fails });
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
const outDir = path.join(REPO_ROOT, 'docs', 'evidence', 'dynamic-ui');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, OUT), JSON.stringify(out, null, 2));
console.log(`wrote docs/evidence/dynamic-ui/${OUT}`);
console.log(`  providerMode: ${out.providerMode}`);
console.log(`  summary: ${JSON.stringify(out.summary)}`);
for (const r of out.results) {
  console.log(`  ${r.id} [${r.pass ? 'PASS' : 'FAIL'}] surface=${r.surface} panel=${r.panelClass} labels=${JSON.stringify(r.observedLabels)} counts=${JSON.stringify(r.counts)}`);
  if (!r.pass) console.log(`      fails: ${JSON.stringify(r.fails)}`);
}
process.exit(0);
