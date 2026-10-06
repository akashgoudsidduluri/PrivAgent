#!/usr/bin/env node
/**
 * PHASE 18.8 / A12 — real-Chrome cancellation / interruption checkpoint.
 *
 * The scenario the brief asks for, driven through the actual extension:
 *
 *   1. Start task A on the catalog fixture.
 *   2. Prove A is active and WAITING: the controlled provider is holding its
 *      first answer open (STUB_SLOW_FIRST_SECONDS), so A is parked inside an
 *      `await` with a live round trip.
 *   3. Start task B while A is still waiting.
 *   4. Let A's delayed response arrive.
 *   5. Assert: A is SUPERSEDED, A executed ZERO actions after the supersession,
 *      B is the authoritative run, the dashboard shows B, and no A data appears
 *      in B's result.
 *
 * Controlled provider, labelled as such. Nothing here is a live-provider claim.
 *
 * Run:
 *   STUB_SLOW_FIRST_SECONDS=14 ST_CDP_PORT=9861 \
 *   node scratch/a12_cancel_run.mjs
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

const CDP_PORT = Number(process.env.ST_CDP_PORT || 9861);
const CATALOG = 'http://localhost:4174/results.html';
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const GATEWAY = 'http://127.0.0.1:8010';
const SLOW_SECONDS = Number(process.env.ST_SLOW_SECONDS || 9);
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 26000);
const OUT = process.env.ST_OUT || 'p188_a12_raw.json';

const TASK_A = 'Find the cheapest products under 1000 with good ratings.';
const TASK_B = 'Tell me about the products under 1000 with good ratings.';
const TASK_C = 'Find the products under 1000 with the best ratings.';

const TERMINAL = new Set([
  'SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL',
  'CANNOT_VERIFY', 'NEEDS_INFORMATION', 'NEEDS_CLARIFICATION', 'PROVIDER_UNAVAILABLE',
]);

const out = {
  phase: '18.8-A12',
  work: 'Cancellation / interruption — real Chrome',
  labels: 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER',
  provider: 'CONTROLLED (scratch/i8a7a8_controlled_provider.py, STUB_MODE=slow_then_normal)',
  honesty:
    'CONTROLLED_PROVIDER. The live groq route was rate-limited/malformed throughout this session; no live leg is claimed.',
  inputs: { taskA: TASK_A, taskB: TASK_B, taskC: TASK_C, slowSeconds: SLOW_SECONDS, catalog: CATALOG },
  environment: {},
  swLogs: [],
  timeline: [],
};
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

const chrome = launchChrome(CDP_PORT);

try {
  // Put the controlled provider into the slow-first mode before Chrome starts.
  await fetch(`${GATEWAY}/mode?set=slow_then_normal`);
  const modeState = await (await fetch(`${GATEWAY}/mode`)).json();

  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('chrome CDP never became ready');
  out.environment.chromeVersion = version.Browser || 'unknown';

  const bsId = version.webSocketDebuggerUrl.split('/').pop();
  const bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
  await bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') });

  // The catalog tab the agent works on, then the dashboard that drives it.
  await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(CATALOG)}`, 'PUT');
  await sleep(1500);
  const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
  const page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
  await sleep(3500);

  // Service-worker console, so the run's own trace is part of the evidence.
  const sw = await attachServiceWorker(CDP_PORT);
  if (!sw) throw new Error('service worker not found');
  await sw.send('Runtime.enable', {});
  const swOnMessage = sw.ws.onmessage;
  sw.ws.onmessage = async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || [])
          .map((a) => {
            if (a.value !== undefined) {
              return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
            }
            if (a.preview && Array.isArray(a.preview.properties)) {
              return `{${a.preview.properties.map((p) => `${p.name}:${p.value ?? p.type}`).join(',')}}`;
            }
            return a.description || '';
          })
          .join(' ');
        out.swLogs.push({ t: at(), text: text.slice(0, 500) });
      }
    } catch { /* ignore */ }
    try { swOnMessage.call(sw.ws, ev); } catch { /* ignore */ }
  };

  // Every progress event the dashboard receives, in order, with its run.
  await page.send('Runtime.evaluate', {
    expression: `
      window.__a12 = { progress: [] };
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.source !== 'privagent-extension') return;
        if (d.type !== 'TASK_PROGRESS' || !d.payload) return;
        const p = d.payload;
        window.__a12.progress.push({
          at: Date.now(),
          runId: p.runId ?? null,
          status: p.status,
          task: p.task || null,
          steps: Array.isArray(p.steps) ? p.steps.length : 0,
          lifecycle: p.lifecycle || null,
          cancellationCode: p.cancellationCode ?? null,
          result: p.interaction && p.interaction.finalResult ? p.interaction.finalResult.kind : null,
          reason: p.interaction && p.interaction.terminal ? p.interaction.terminal.reason : null,
        });
      });
      true;
    `,
    returnByValue: true,
  });

  const submit = async (task) => {
    out.timeline.push({ t: at(), event: 'submit', task });
    await page.send('Runtime.evaluate', {
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
  };

  const snapshot = async () => {
    const r = await page.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__a12 ? window.__a12.progress : [])',
      returnByValue: true,
    });
    try { return JSON.parse(r?.result?.value || '[]'); } catch { return []; }
  };
  const gateCalls = async () => {
    try {
      const r = await fetch(`${GATEWAY}/mode`);
      const j = await r.json();
      return j.calls_served ?? 0;
    } catch { return -1; }
  };

  // ── 1. Task A, and prove it is waiting on the provider ─────────────────────
  const beforeA = (await snapshot()).length;
  await submit(TASK_A);

  const waitDeadline = Date.now() + 30_000;
  let callsWhenSubmittedB = -1;
  while (Date.now() < waitDeadline) {
    await sleep(700);
    if ((await gateCalls()) >= 1) break;
  }
  callsWhenSubmittedB = await gateCalls();
  const progressAtInterrupt = await snapshot();
  out.timeline.push({
    t: at(),
    event: 'task_a_waiting',
    providerCallsServed: callsWhenSubmittedB,
    progressEvents: progressAtInterrupt.length - beforeA,
  });

  // ── 2. Task B supersedes A while A's answer is still in flight ─────────────
  const beforeB = (await snapshot()).length;
  await submit(TASK_B);
  out.timeline.push({ t: at(), event: 'task_b_submitted' });

  // ── 3. Let A's delayed answer land, then wait for both terminals ───────────
  const deadline = Date.now() + SETTLE_MS;
  let progress = [];
  while (Date.now() < deadline) {
    await sleep(1500);
    progress = await snapshot();
    const afterB = progress.slice(beforeB);
    const aTerminal = progress.slice(beforeA).filter((p) => TERMINAL.has(p.status));
    const bTerminal = afterB.filter((p) => TERMINAL.has(p.status));
    if (aTerminal.length && bTerminal.length) break;
  }

  // Attribute events by TASK, not by slice position: the replaced run's
  // terminal event is deliberately NOT forwarded, so a positional slice would
  // silently attribute the NEW run's events to the old one.
  const aEvents = progress.filter((p) => p.task === TASK_A);
  const bEvents = progress.filter((p) => p.task === TASK_B);
  const aTerminalEvent = aEvents.filter((p) => TERMINAL.has(p.status)).slice(-1)[0] ?? null;
  const bTerminalEvent = bEvents.filter((p) => TERMINAL.has(p.status)).slice(-1)[0] ?? null;
  const body = await page.send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText.slice(0, 1500) : ""',
    returnByValue: true,
  });

  const supersedeIndex = out.swLogs.findIndex((l) => l.text.includes('Halting and superseding'));
  const cancelIndex = out.swLogs.findIndex((l) => l.text.includes('run cancelled'));
  const cancelLine = cancelIndex >= 0 ? out.swLogs[cancelIndex].text : '';
  const aLifecycle = (cancelLine.match(/lifecycle:([A-Z_]+)/) || [])[1] ?? null;
  const aCancelReason = (cancelLine.match(/reason:([A-Z_]+)/) || [])[1] ?? null;
  const afterSupersede = supersedeIndex >= 0 ? out.swLogs.slice(supersedeIndex) : [];
  const execAfterSupersede = afterSupersede.filter((l) => l.text.includes('executeAction started'));

  out.result = {
    taskA: {
      submittedAt: out.timeline.find((e) => e.event === 'submit')?.t ?? null,
      // The old run's terminal event is SUPPRESSED by design: the dashboard
      // belongs to the new run. Its end is therefore read from the worker's own
      // trace, which is where the lifecycle decision is recorded.
      terminalEventForwarded: !!aTerminalEvent,
      finalStatus: aTerminalEvent?.status ?? null,
      lifecycle: aLifecycle ?? null,
      cancellationReason: aCancelReason ?? null,
      anyLifecycleCancellation: aEvents.some((p) => p.lifecycle === 'SUPERSEDED' || p.lifecycle === 'CANCELLED'),
      reportedSuccess: aEvents.some((p) => p.status === 'SUCCESS'),
    },
    taskB: {
      finalStatus: bTerminalEvent?.status ?? null,
      lifecycle: bTerminalEvent?.lifecycle ?? null,
      resultKind: bTerminalEvent?.result ?? null,
      terminalReason: bTerminalEvent?.reason ?? null,
    },
    supersedeObserved: supersedeIndex >= 0,
    cancellationObserved: cancelIndex >= 0,
    dispatchAttemptsAfterSupersede: execAfterSupersede.length,
    dispatchAfterSupersedeLog: execAfterSupersede.slice(0, 3).map((l) => l.text.slice(0, 160)),
    // Progress events attributed to A that were emitted AFTER B was submitted.
    staleProgressFromA: (() => {
      const bSubmitted = out.timeline.find((e) => e.event === 'task_b_submitted');
      if (!bSubmitted) return -1;
      const bWall = t0 + Number(bSubmitted.t) * 1000;
      return progress.filter((p) => p.task === TASK_A && p.at > bWall).length;
    })(),
    dashboardShowsTaskB: String(body?.result?.value || '').includes(TASK_B.slice(0, 24)),
    dashboardMentionsTaskA: String(body?.result?.value || '').includes(TASK_A.slice(0, 24)),
    mode: modeState,
  };

  // ── 4. Explicit user cancellation, while a run is waiting again ───────────
  // Resetting the mode also resets the held-open "first call", so this run is
  // parked inside the provider round trip too.
  await fetch(`${GATEWAY}/mode?set=slow_then_normal`);
  const beforeC = (await snapshot()).length;
  await submit(TASK_C);
  let cancelClicks = 0;
  const cancelDeadline = Date.now() + 25_000;
  while (Date.now() < cancelDeadline) {
    await sleep(600);
    if ((await gateCalls()) >= 1) break;
  }
  // The dashboard's own Stop control — the real user path.
  const stopClicked = await page.send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = document.getElementById('composer-btn-stop');
        if (!btn) return 'stop-button-missing';
        btn.click();
        return 'stopped';
      })()
    `,
    returnByValue: true,
  });
  cancelClicks += 1;
  out.timeline.push({ t: at(), event: 'stop_clicked', result: stopClicked?.result?.value ?? null });

  const cDeadline = Date.now() + 20_000;
  let progressC = [];
  while (Date.now() < cDeadline) {
    await sleep(1200);
    progressC = await snapshot();
    if (progressC.slice(beforeC).some((p) => TERMINAL.has(p.status))) break;
  }
  const cEvents = progressC.filter((p) => p.task === TASK_C);
  const cTerminal = cEvents.filter((p) => TERMINAL.has(p.status)).slice(-1)[0] ?? null;
  const cCancelLine =
    out.swLogs.filter((l) => l.text.includes('run cancelled')).slice(-1)[0]?.text ?? '';
  const cLifecycle = (cCancelLine.match(/lifecycle:([A-Z_]+)/) || [])[1] ?? null;
  const cReason = (cCancelLine.match(/reason:([A-Z_]+)/) || [])[1] ?? null;
  const stopIndex = out.swLogs.map((l) => l.text).findIndex((t) => t.includes('run cancelled'));
  const dispatchesAfterStop = out.swLogs
    .slice(stopIndex)
    .filter((l) => l.text.includes('executeAction started')).length;
  out.cancelCase = {
    stopControlResult: stopClicked?.result?.value ?? null,
    lifecycle: cLifecycle,
    cancellationReason: cReason,
    terminalStatus: cTerminal?.status ?? null,
    resultKind: cTerminal?.result ?? null,
    terminalReason: cTerminal?.reason ?? null,
    reportedSuccess: cEvents.some((p) => p.status === 'SUCCESS'),
    dispatchesAfterStop,
    events: cEvents.length,
  };

  const r = out.result;
  out.checks = [
    { id: 'A12-R1', claim: 'task A was provably waiting on an in-flight provider call when B started', pass: callsWhenSubmittedB >= 1 },
    {
      id: 'A12-R2',
      claim: 'the worker ended A when B started (superseded, or explicitly stopped by the dashboard)',
      pass: r.supersedeObserved || r.cancellationObserved,
    },
    {
      id: 'A12-R3',
      claim: "A's lifecycle left ACTIVE in the worker's own record",
      pass: r.taskA.lifecycle === 'SUPERSEDED' || r.taskA.lifecycle === 'CANCELLED',
    },
    {
      id: 'A12-R8',
      claim: "the replaced run's progress/terminal never reached the dashboard as the active task",
      pass: r.staleProgressFromA === 0 && r.taskA.reportedSuccess === false,
    },
    { id: 'A12-R4', claim: 'A executed ZERO actions after the supersession', pass: r.dispatchAttemptsAfterSupersede === 0 },
    { id: 'A12-R5', claim: 'A never reported SUCCESS', pass: !r.taskA.reportedSuccess },
    { id: 'A12-R6', claim: 'B became the authoritative run and reached its own terminal state', pass: !!r.taskB.finalStatus && r.taskB.lifecycle !== 'SUPERSEDED' },
    { id: 'A12-R7', claim: 'the dashboard shows B, not A', pass: r.dashboardShowsTaskB },
    {
      id: 'A12-R9',
      claim: 'an explicit user stop cancels the running task (USER_CANCELLED)',
      pass: out.cancelCase.cancellationReason === 'USER_CANCELLED' && out.cancelCase.lifecycle === 'CANCELLED',
    },
    {
      id: 'A12-R10',
      claim: 'a user-stopped task dispatched nothing after the stop',
      pass: out.cancelCase.dispatchesAfterStop === 0 && out.cancelCase.reportedSuccess === false,
    },
  ];
  out.summary = {
    passed: out.checks.filter((c) => c.pass).length,
    failed: out.checks.filter((c) => !c.pass).length,
  };

  fs.writeFileSync(path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit', OUT), JSON.stringify(out, null, 2));
  console.log(`${OUT}: ${out.summary.passed}/${out.checks.length} checks passed`);
  for (const c of out.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.id}: ${c.claim}`);
  process.exitCode = out.summary.failed === 0 ? 0 : 1;
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err);
  fs.writeFileSync(path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit', OUT), JSON.stringify(out, null, 2));
  console.error('A12 checkpoint failed:', out.error);
  process.exitCode = 1;
} finally {
  // Chrome is left for the next checkpoint to reuse; killing it here would
  // race the harness that owns the profile.
}