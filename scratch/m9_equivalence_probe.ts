/**
 * PHASE 17.9 CLOSURE AUDIT — M9 equivalence probe.
 *
 * M9 replaces `if (healedVal.allowed) {` with `if (true) {`, so a healed target
 * is adopted even when GATE 1 or M5 refused it. It has survived the full suite
 * since 17.7 and still does. That is a property of the TEST SUITE, not of
 * production, and "survives" has two very different meanings:
 *
 *   (a) genuinely equivalent — adopting the healed action changes no observable
 *       outcome, so no test could ever tell; or
 *   (b) a coverage gap — adopting it DOES change an outcome, but no test looks.
 *
 * D-02 widened what recovery can propose, so this audit must establish which.
 *
 * The scenario that separates them: a goal-ALIGNED candidate that is NOT an
 * interactive control. Production refuses it at GATE 1 (TARGET_MISMATCH). Under
 * M9 it is adopted anyway. If it then reaches executeAction, the mutants are not
 * equivalent and the escape is a gap.
 *
 * Run:  npx vite-node scratch/m9_equivalence_probe.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { AgentLoop } from '../extension/src/agent/agentLoop';
import { ctx, det, scope } from '../evaluation/phase17_8/fixtures';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const LOOP = 'extension/src/agent/agentLoop.ts';
const GOAL = 'Open the transaction history';
const ORIGIN = 'https://shop.example';
const PAGE = `${ORIGIN}/account`;
const ORPHAN = 'orphan-control';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const proposal: BrowserAction = {
  action: 'click',
  target: ORPHAN,
  reason: 'Open the statement for Aria Vasquez',
} as unknown as BrowserAction;

function buildContext(candidateType: 'button' | 'heading'): AgentContextPayload {
  return ctx({
    url: PAGE,
    detections: [
      det(ORPHAN, 'button', { label: 'Apply', selector: '#zzz-opaque' }),
      det('privagent-det-txn-history', candidateType, {
        label: 'Transaction history',
        selector: '#transaction-history',
      }),
    ],
    total_elements_scanned: 2,
  });
}

async function run(context: AgentContextPayload) {
  const dispatched: BrowserAction[] = [];
  const loop = new AgentLoop(
    { name: 'M9', requestAction: async () => proposal as never, registerFailure: () => {}, resetEscalation: () => {} },
    {
      perceivePage: async () => context,
      getEffectSnapshot: async () => null,
      executeAction: async (a) => {
        dispatched.push(a);
        return { success: true };
      },
    },
    { maxSteps: 1, maxRetries: 1, delayBetweenStepsMs: 0, targetTabId: 7, initialUrl: `${PAGE}/`, containmentScope: scope() }
  );
  let threw: string | null = null;
  let state: any = null;
  try { state = await loop.runTask(GOAL); } catch (e) { threw = (e as Error)?.name ?? 'UnknownError'; }
  return { dispatched: dispatched.map((a) => (a as any).target), status: state?.status, threw, reason: state?.reason };
}

const line = (label: string, r: Awaited<ReturnType<typeof run>>) =>
  console.log(
    `  ${label.padEnd(40)} dispatched=${JSON.stringify(r.dispatched).padEnd(26)} status=${String(r.status).padEnd(7)} reason=${String(r.reason ?? '').slice(0, 60)}`
  );

// ── BASELINE: production code ────────────────────────────────────────────────
const original = readFileSync(LOOP, 'utf8');
const before = sha(original);
console.log(`\n=== baseline (production, no mutation) :: ${before} ===\n`);
const baseOk = await run(buildContext('button'));
const baseBad = await run(buildContext('heading'));
line('goal-aligned candidate is a button', baseOk);
line('goal-aligned candidate is a HEADING', baseBad);

// ── M9 ───────────────────────────────────────────────────────────────────────
const ANCHOR = '          if (healedVal.allowed) {';
if (!original.includes(ANCHOR)) throw new Error('M9 anchor missing — re-derive, do not force');
const mutated = original.replace(ANCHOR, '          if (true as boolean) {');
if (mutated === original) throw new Error('M9 replacement was a no-op');

let mutOk: Awaited<ReturnType<typeof run>>;
let mutBad: Awaited<ReturnType<ReturnType<typeof run>>>;
try {
  writeFileSync(LOOP, mutated, 'utf8');
  console.log(`\n=== under M9 (healedVal.allowed bypassed) :: ${sha(mutated)} ===\n`);
  mutOk = await run(buildContext('button'));
  mutBad = await run(buildContext('heading'));
  line('goal-aligned candidate is a button', mutOk);
  line('goal-aligned candidate is a HEADING', mutBad);
} finally {
  writeFileSync(LOOP, original, 'utf8');
  const ok = sha(readFileSync(LOOP, 'utf8')) === before;
  console.log(`\n[restored ${LOOP}: ${ok ? 'VERIFIED by hash' : 'FAILED'}]`);
  if (!ok) process.exitCode = 3;
}

console.log('\n=== FINDING ===\n');
const differs = (a: string[], b: string[]) => JSON.stringify(a) !== JSON.stringify(b);
const headingDiverges = differs(baseBad.dispatched, mutBad.dispatched);
console.log(`  button  : baseline ${JSON.stringify(baseOk.dispatched)} vs M9 ${JSON.stringify(mutOk.dispatched)} -> ${differs(baseOk.dispatched, mutOk.dispatched) ? 'DIFFERS' : 'identical'}`);
console.log(`  heading : baseline ${JSON.stringify(baseBad.dispatched)} vs M9 ${JSON.stringify(mutBad.dispatched)} -> ${headingDiverges ? 'DIFFERS' : 'identical'}`);
console.log('');
console.log(`  M9 VERDICT: ${headingDiverges
  ? 'NOT equivalent — adopting a healed target that GATE 1 refused CHANGES the dispatch. The escape is a TEST COVERAGE GAP, not equivalence.'
  : 'equivalent on this scenario — the later gates refuse it anyway, so no observable outcome changes.'}`);
console.log(`  Is this a PRODUCTION defect? ${headingDiverges
  ? 'NO. Production has `if (healedVal.allowed)` and refuses correctly; this is a gap in what the suite can detect if that line were ever weakened.'
  : 'NO.'}`);
