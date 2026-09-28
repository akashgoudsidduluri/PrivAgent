/**
 * PHASE 17.9 — D-02 AUDIT PROBE. READ-ONLY.
 *
 * Establishes the EXACT current behaviour of `recoverStaleTarget` before any
 * D-02 change is considered. It imports the production module and calls it; it
 * does not modify, stub or patch anything.
 *
 * THE FIXTURE IS BUILT TO DISCRIMINATE
 * ────────────────────────────────────
 * The acceptance floor is 0.40. The failed target `orphan-control` shares NO
 * token with any candidate selector, and no candidate carries an `orphan-control`
 * detection, so the three token-similarity strategies all score exactly 0.0.
 * The ONLY strategy that can clear the floor is the goal-semantic branch
 * (0.90 for 'transaction', 0.88 for 'account').
 *
 * That matters: with a sloppy fixture the failed target self-matches on its own
 * id at ~0.5 and recovery "succeeds" by the wrong path, which makes the dead
 * branch look alive. Here recovery succeeding IS the signal that the goal
 * branch fired.
 *
 * Run:  npx vite-node scratch/d02_audit.ts
 */

import { recoverStaleTarget } from '../extension/src/agent/selfHealing';
import { ctx, det } from '../evaluation/phase17_8/fixtures';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const GOAL = 'show the transaction history';

const FAILED_TARGET = 'orphan-control';
const action: BrowserAction = {
  action: 'click',
  target: FAILED_TARGET,
  reason: 'Open the control',
} as unknown as BrowserAction;

/** No `orphan-control` detection exists — the target is genuinely stale. */
const context: AgentContextPayload = ctx({
  url: 'https://bank.example/history',
  detections: [
    det('privagent-det-transaction-history', 'button', { label: 'History', selector: '#transaction-history' }),
    det('privagent-det-account-details', 'button', { label: 'Details', selector: '#account-details' }),
  ],
  total_elements_scanned: 2,
});

const r = (x: ReturnType<typeof recoverStaleTarget>) => ({
  recovered: x.recovered,
  score: Number((x.confidence ?? 0).toFixed(2)),
  strategy: x.strategy,
  target: x.recoveredAction?.target ?? null,
});

const a1 = r(recoverStaleTarget(FAILED_TARGET, action, context));
const b1 = r(recoverStaleTarget(action, context, GOAL));
const c1 = r(recoverStaleTarget(action, context, undefined, GOAL));
const c2 = r(recoverStaleTarget(FAILED_TARGET, action, context, GOAL));
// Control: the same 4-arg call with a goal that matches nothing.
const c0 = r(recoverStaleTarget(FAILED_TARGET, action, context, 'unrelated intent'));

const row = (label: string, v: ReturnType<typeof r>) =>
  console.log(
    `  ${label.padEnd(44)} recovered=${String(v.recovered).padEnd(5)} score=${String(v.score).padEnd(4)} strategy=${v.strategy.padEnd(16)} target=${v.target ?? '-'}`,
  );

console.log('\n=== D-02 AUDIT: recoverStaleTarget, current production code (unmodified) ===\n');

console.log('A. THE TWO PRODUCTION CALL SITES — agentLoop.ts:1215 and :1762');
console.log('   recoverStaleTarget(staleTargetId, action, context)   [3 args, no goal]\n');
row('A1. string-targetId form, no goal', a1);

console.log('\nB. THE 3-ARG FORM CARRYING A GOAL — what the 17.8 report examined');
console.log('   recoverStaleTarget(action, context, goal)\n');
row('B1. goal in 3rd position', b1);

console.log('\nC. THE 4-ARG FORM — the only shape goalHint actually reads');
console.log('   recoverStaleTarget(action, context, undefined, taskGoal)\n');
row('C0. control: 4-arg, goal matches nothing', c0);
row('C1. action form, goal in 4th position', c1);
row('C2. string-targetId form, goal in 4th', c2);

const goalBranchAlive = c1.recovered && c1.score === 0.9;
const goalBranchLiveInProduction = a1.recovered || b1.recovered;

console.log('\n=== FINDINGS ===\n');
console.log(`  1. Goal-semantic branch IS implemented and correct:      ${goalBranchAlive ? 'YES (0.90, picks the goal-aligned target)' : 'NO — re-derive'}`);
console.log(`  2. Reachable from either production call site:            ${goalBranchLiveInProduction ? 'YES' : 'NO — recovery simply fails'}`);
console.log(`  3. Reachable by the 3-arg form carrying a goal:           ${b1.recovered ? 'YES' : 'NO — goal is misrouted'}`);
console.log(`  4. Reachable only by the 4-arg form, which NOBODY calls:  ${c1.recovered ? 'YES' : 'NO'}`);
console.log(`\n  VERDICT: ${goalBranchAlive && !goalBranchLiveInProduction ? 'D-02 CONFIRMED — goal-semantic recovery is inert in production' : 'behaviour differs from the 17.8 report — re-derive'}`);
console.log(`  Severity: recovery failing means the action is REFUSED, never dispatched. Fail-safe.`);
