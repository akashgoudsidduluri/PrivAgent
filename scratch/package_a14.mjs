#!/usr/bin/env node
/**
 * PHASE 18.8 / A14 — evidence packaging.
 *
 * Reads the real-Chrome uncertain-commit transcript and computes the A14
 * acceptance criteria FROM THE TRANSCRIPT AND THE PAGE COUNTER (nothing is
 * asserted by hand):
 *
 *   · the task ran and exactly ONE dispatch reached the page
 *   · the first dispatch's effect could NOT be established (typed record)
 *   · the second proposal was blocked by the commit gate, with the class named
 *   · the re-perception could not settle it (typed verdict)
 *   · the run ended in the typed terminal state COMMIT_UNKNOWN
 *   · the user-facing copy names no internal code and explains the duplicate risk
 *   · nothing was dispatched after the terminal event
 *
 * Run: node scratch/package_a14.mjs [raw] [out]
 */
import fs from 'node:fs';

const RAW = process.argv[2] || 'docs/evidence/post-17-10/audit/p188_A14_raw.json';
const OUT = process.argv[3] || 'docs/evidence/post-17-10/audit/p188_A14.json';

const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const logs = (raw.swLogs || []).map((l) => ({ t: Number(String(l.t).replace('s', '')) || 0, text: l.text }));
const events = raw.events || [];
const has = (needle) => logs.some((l) => l.text.includes(needle));
const firstLine = (needle) => (logs.find((l) => l.text.includes(needle)) || {}).text || null;

const assessed = firstLine('commit assessed');
const settled = (logs.find((l) => l.text.includes('commit settled by effect verification')) || {}).text || null;
const blocked = (logs.find((l) => l.text.includes('dispatch blocked — commit unresolved')) || {}).text || null;
const verification = (logs.find((l) => l.text.includes('external commit verification')) || {}).text || null;

const terminalEvents = events.filter((e) =>
  ['SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL', 'CANNOT_VERIFY', 'NEEDS_INFORMATION', 'NEEDS_CLARIFICATION', 'PROVIDER_UNAVAILABLE', 'COMMIT_UNKNOWN'].includes(e.status)
);
const terminalEvent = terminalEvents[terminalEvents.length - 1] || null;
const finalResult = terminalEvent?.finalResult || null;
const clicksAtTerminal = raw.fixture?.atTerminal?.clicks ?? null;
const clicksAfterSettle = raw.fixture?.afterSettle?.clicks ?? null;

const classMatch = (assessed || '').match(/actionClass:([A-Z]+)/);
const unresolvedMatch = (assessed || '').match(/unresolved:(true|false)/);
const blockedClass = (blocked || '').match(/actionClass:([A-Z]+)/);
const certainty = (blocked || '').match(/certainty:([A-Z_]+)/);

const checks = [
  {
    id: 'A14-1',
    claim: 'the task ran and EXACTLY ONE dispatch reached the page',
    pass: clicksAtTerminal === 1,
    observed: { clicksAtTerminal, clicksAfterSettle, page: raw.fixture?.atTerminal?.url ?? null },
  },
  {
    id: 'A14-2',
    claim: 'the first consequential dispatch was recorded with a TYPED commit record, unresolved',
    pass:
      /commit assessed/.test(assessed || '') &&
      ['BUY', 'SUBMIT', 'SEND', 'DELETE', 'TRANSFER', 'CREATE'].includes(classMatch?.[1] ?? '') &&
      unresolvedMatch?.[1] === 'true',
    observed: { assessed, actionClass: classMatch?.[1] ?? null, unresolved: unresolvedMatch?.[1] ?? null },
  },
  {
    id: 'A14-3',
    claim: 'the effect verifier could NOT close that commit (the action changed nothing observable)',
    pass: /ACTION_NO_EFFECT/.test(settled || '') && /unresolved:true/.test(settled || ''),
    observed: { settled },
  },
  {
    id: 'A14-4',
    claim: 'the SECOND proposal of the same class was refused by the commit gate, naming the class',
    pass: blocked !== null && blockedClass?.[1] === classMatch?.[1],
    observed: { blocked, actionClass: blockedClass?.[1] ?? null, certainty: certainty?.[1] ?? null },
  },
  {
    id: 'A14-5',
    claim: 'NO second dispatch reached the page after the gate — the counter does not move',
    pass: clicksAfterSettle === clicksAtTerminal && clicksAfterSettle === 1,
    observed: { clicksAtTerminal, clicksAfterSettle },
  },
  {
    id: 'A14-6',
    claim: 're-perception could not settle it (typed UNKNOWN verdict), so the commit stayed open',
    pass: /status:UNKNOWN/.test(verification || '') && /resolved:false/.test(verification || ''),
    observed: { verification },
  },
  {
    id: 'A14-7',
    claim: 'the run ended in the typed terminal state COMMIT_UNKNOWN (not a pause, not SUCCESS, not FAILED)',
    pass: terminalEvent?.status === 'COMMIT_UNKNOWN' && terminalEvent?.terminal?.outcome === 'UNANSWERED',
    observed: {
      status: terminalEvent?.status ?? null,
      outcome: terminalEvent?.terminal?.outcome ?? null,
      reason: terminalEvent?.terminal?.reason ?? null,
      headline: terminalEvent?.terminal?.headline ?? null,
    },
  },
  {
    id: 'A14-8',
    claim: 'the user-facing result explains the duplicate risk and leaks no internal code',
    pass:
      finalResult?.kind === 'COMMIT_UNKNOWN' &&
      /could not confirm/i.test(finalResult?.body ?? '') &&
      /duplicate/i.test(finalResult?.body ?? '') &&
      // The COPY is what must be free of internals; the typed `kind` is the
      // vocabulary the screen decides styling from.
      !/COMMIT_UNKNOWN|EFFECT_|RESOLVED_|_ERROR/.test(
        `${finalResult?.headline ?? ''} ${finalResult?.body ?? ''} ${(finalResult?.remaining ?? []).join(' ')}`
      ),
    observed: { finalResult },
  },
];

const artifact = {
  phase: '18.8-A14',
  work: 'Uncertain commit: an unconfirmed consequential action is never re-dispatched',
  labels: raw.labels,
  provider: 'CONTROLLED (scratch/i8a7a8_controlled_provider.py, STUB_MODE=commit_demo)',
  honesty:
    'CONTROLLED_PROVIDER. The provider proposed the SAME consequential control on every call, by design. ' +
    'The click count is read from the PAGE (window.__a14Enquiries), not inferred from the agent. ' +
    'The action chosen for this scenario is a real send-shaped control on a real local fixture page; ' +
    'no part of this claims a live-model run.',
  source: RAW.split('/').pop(),
  environment: raw.environment,
  inputs: raw.inputs,
  fixtureCounter: raw.fixture,
  trace: {
    assessed,
    settled,
    blocked,
    verification,
  },
  terminal: terminalEvent,
  checks,
  summary: { passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length },
};

fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
console.log(`wrote ${OUT}`);
console.log(`A14 CHECKS: ${artifact.summary.passed}/${checks.length} passed`);
for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.id} ${c.claim}`);
process.exitCode = artifact.summary.failed === 0 ? 0 : 1;
