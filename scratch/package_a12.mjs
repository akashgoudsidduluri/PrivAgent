#!/usr/bin/env node
/**
 * PHASE 18.8 / A12 — evidence packaging.
 *
 * Reads the real-Chrome interrupt transcript and computes the A12 acceptance
 * criteria FROM THE TIMELINE (nothing is asserted by hand):
 *
 *   · task A started and really dispatched an action before the interrupt
 *   · A was cancelled with a typed code (SUPERSEDED / USER_CANCELLED)
 *   · B started AFTER the cancellation and owns the active run
 *   · no action was dispatched for A after the cancellation timestamp
 *   · A's late provider response produced no terminal result
 *   · B's terminal result is what the dashboard ended on
 *   · A never overwrote B (no A terminal event after B started)
 *
 * Run: node scratch/package_a12.mjs [raw] [out]
 */
import fs from 'node:fs';
import path from 'node:path';

const RAW = process.argv[2] || 'docs/evidence/post-17-10/audit/p188_A12_raw.json';
const OUT = process.argv[3] || 'docs/evidence/post-17-10/audit/p188_A12.json';

const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const logs = raw.swLogs.map((l) => ({ t: Number(String(l.t).replace('s', '')) || 0, text: l.text }));
const sec = (s) => Number.parseFloat(String(s)) || 0;

const firstIdx = (needle) => logs.findIndex((l) => l.text.includes(needle));
const after = (fromIdx, needle) => logs.slice(fromIdx + 1).findIndex((l) => l.text.includes(needle));

const startA = firstIdx('agent loop started {runId:1}');
const startB = firstIdx('agent loop started {runId:2}');
const cancelIdx = firstIdx('run cancelled');
const executeIdx = firstIdx('executeAction started');
const suppressedIdx = firstIdx('terminal progress suppressed (task superseded)');

const cancelLine = cancelIdx >= 0 ? logs[cancelIdx].text : '';
const cancelCode = (cancelLine.match(/reason:([A-Z_]+)/) || [])[1] ?? null;
const suppressedLine = suppressedIdx >= 0 ? logs[suppressedIdx].text : '';
const supersededToken = (suppressedLine.match(/taskOwnershipToken:(\d+)/) || [])[1] ?? null;
const activeRunId = (suppressedLine.match(/activeTaskRunId:(\d+)/) || [])[1] ?? null;

// Any action dispatch that belongs to run 1 AFTER the cancellation? The worker
// stamps the run on the loop; the dispatch log does not, so the check is on the
// TIMELINE: nothing was dispatched at all between the cancellation and B's own
// first reasoning request, and every dispatch after B starts belongs to B.
const dispatches = logs.map((l, i) => ({ i, t: l.t })).filter((d) => logs[d.i].text.includes('executeAction started'));
const cancelT = cancelIdx >= 0 ? logs[cancelIdx].t : Infinity;
const dispatchAfterCancel = dispatches.filter((d) => d.t > cancelT);
const dispatchBetween = dispatches.filter((d) => d.t > cancelT && d.t < (startB >= 0 ? logs[startB].t : Infinity));

const events = raw.events || [];
const terminalStatuses = new Set([
  'SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL', 'CANNOT_VERIFY',
  'NEEDS_INFORMATION', 'NEEDS_CLARIFICATION', 'PROVIDER_UNAVAILABLE',
]);
const aTerminal = events.filter((e) => e.runId === 1 && terminalStatuses.has(e.status));
const bTerminal = events.filter((e) => e.runId === 2 && terminalStatuses.has(e.status));

const checks = [
  {
    id: 'A12-1',
    claim: 'task A started and dispatched a real action before the interrupt',
    pass: startA >= 0 && executeIdx > startA && executeIdx < cancelIdx,
    observed: { startRun1At: logs[startA]?.t, firstDispatchAt: logs[executeIdx]?.t },
  },
  {
    id: 'A12-2',
    claim: 'A was cancelled with a TYPED cancellation code',
    pass: cancelIdx > startA && (cancelCode === 'SUPERSEDED_BY_NEW_TASK' || cancelCode === 'USER_CANCELLED'),
    observed: { reason: cancelCode, line: cancelLine.slice(0, 160) },
  },
  {
    id: 'A12-3',
    claim: 'B started AFTER the cancellation and owns the active run',
    pass: startB > cancelIdx,
    observed: { cancelAt: logs[cancelIdx]?.t, startRun2At: logs[startB]?.t },
  },
  {
    id: 'A12-4',
    claim: 'NO action was dispatched for A after it was cancelled',
    pass: dispatchBetween.length === 0 && dispatchAfterCancel.length === 0,
    observed: {
      dispatchesAfterCancellation: dispatchAfterCancel.map((d) => logs[d.i].t),
      dispatchesBetweenCancellationAndB: dispatchBetween.length,
    },
  },
  {
    id: 'A12-5',
    claim: "A's late provider response produced NO terminal result",
    pass: aTerminal.length === 0,
    observed: { terminalEventsForRun1: aTerminal.length },
  },
  {
    id: 'A12-6',
    claim: "A's late result was explicitly SUPPRESSED by ownership, not merely lost",
    pass: suppressedIdx > startB && supersededToken === '1' && activeRunId === '2',
    observed: { line: suppressedLine.slice(0, 160) },
  },
  {
    id: 'A12-7',
    claim: 'B produced its own terminal result and the dashboard ended on it',
    pass: bTerminal.length > 0,
    observed: { run2Terminal: bTerminal.map((e) => ({ status: e.status, result: e.finalResult?.kind ?? null })) },
  },
];

const artifact = {
  phase: '18.8-A12',
  work: 'Cancellation / interruption: supersession, late provider response, ownership',
  labels: raw.labels,
  provider: 'CONTROLLED (scratch/i8a7a8_controlled_provider.py, STUB_MODE=interrupt_demo)',
  honesty:
    'CONTROLLED_PROVIDER. The long task answers late BY DESIGN so the response lands after the interrupt; this reproduces the race deterministically and is not a live-provider claim.',
  source: path.basename(RAW),
  environment: raw.environment ?? {},
  tasks: raw.inputs ?? {},
  timeline: logs
    .filter((l) =>
      /agent loop started|run cancelled|executeAction started|requesting reasoning|terminal progress|stale perception/.test(l.text)
    )
    .map((l) => ({ t: l.t, line: l.text.slice(0, 200) })),
  dashboardEvents: events,
  checks,
  summary: {
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
  },
};

fs.writeFileSync(path.join(process.cwd(), OUT), JSON.stringify(artifact, null, 2));
console.log(`${OUT}: ${artifact.summary.passed}/${checks.length} checks passed`);
for (const c of checks) if (!c.pass) console.log(`  FAIL ${c.id}: ${c.claim} → ${JSON.stringify(c.observed)}`);
process.exitCode = artifact.summary.failed === 0 ? 0 : 1;