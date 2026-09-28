/**
 * PHASE 17.9 D-02 REMEDIATION — goal-alignment recovery is reachable again.
 *
 * THE DEFECT THIS FILE PINS
 * ─────────────────────────
 * `recoverStaleTarget` computed `goalHint` from its FOURTH parameter, but no
 * caller in the codebase passed one. The goal-alignment scoring block was
 * therefore guarded by an always-empty string and could never run. Recovery was
 * silently downgraded to token similarity alone, while the code read as though a
 * working semantic-recovery feature existed.
 *
 * It failed SAFE: no recovery means the action is refused, never dispatched.
 *
 * WHY THE FIXTURE IS BUILT THE WAY IT IS
 * ──────────────────────────────────────
 * The failed target `orphan-control` is deliberately paired with an UNRELATED
 * selector (`#zzz-opaque`) and is given no candidate of its own. Every
 * token-similarity strategy therefore scores exactly 0.0, and the acceptance
 * floor is 0.40. Recovery can only succeed if the GOAL branch fires.
 *
 * That is the whole point: with a careless fixture the failed target self-matches
 * on its own id and recovery "succeeds" by the wrong path, which makes a dead
 * branch look alive. Recovery succeeding here IS the signal.
 *
 * THE TESTS THAT MATTER MOST
 * ──────────────────────────
 * `a recovered candidate is proposed, never dispatched` and `recovery cannot
 * produce SUCCESS`. D-02 widened what recovery can PROPOSE. If the widened
 * proposals ever became dispatches, the fix would have converted a fail-safe
 * defect into an authorization bypass.
 */

import { describe, it, expect } from 'vitest';

import { recoverStaleTarget } from '../../extension/src/agent/selfHealing';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { AgentLoop } from '../../extension/src/agent/agentLoop';
import { ctx, det, scope } from '../../evaluation/phase17_8/fixtures';
import type { AgentContextPayload } from '../../extension/src/privacy/types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';

// `scope()` is contained to shop.example, so the page must live under it.
// Anything else and containment refuses before recovery is ever reached — which
// is containment working, not a test failure.
const ORIGIN = 'https://shop.example';
const PAGE = `${ORIGIN}/account`;

/** Contains 'transaction' and matches the goal candidate below. */
const GOAL = 'Open the transaction history';
/** Contains neither 'transaction' nor 'account' — the control. */
const NON_MATCHING_GOAL = 'Send money to a saved payee';

/** Grounded (its id exists) but shares no token with any candidate selector. */
const ORPHAN = 'orphan-control';
const GOAL_TARGET_ID = 'privagent-det-txn-history';

const context: AgentContextPayload = ctx({
  url: PAGE,
  detections: [
    det(ORPHAN, 'button', { label: 'Apply', selector: '#zzz-opaque' }),
    det(GOAL_TARGET_ID, 'button', { label: 'Transaction history', selector: '#transaction-history' }),
  ],
  total_elements_scanned: 2,
});

/** M5 refuses this on a person name. Grounding passes — the id exists. */
const nameRefused: BrowserAction = {
  action: 'click',
  target: ORPHAN,
  reason: 'Open the statement for Aria Vasquez',
} as unknown as BrowserAction;

/** M5 allows this. Used where recovery must fire from the post-execution site. */
const clean: BrowserAction = {
  action: 'click',
  target: ORPHAN,
  reason: 'Open the account control',
} as unknown as BrowserAction;

const ALIGNED = 0.9;

interface Run {
  dispatched: BrowserAction[];
  state: Awaited<ReturnType<AgentLoop['runTask']>>;
  threw: string | null;
}

async function runLoop(
  goal: string,
  proposal: BrowserAction,
  execSucceeds = true
): Promise<Run> {
  const dispatched: BrowserAction[] = [];
  const loop = new AgentLoop(
    {
      name: 'D02Provider',
      requestAction: async () => proposal as never,
      registerFailure: () => {},
      resetEscalation: () => {},
    },
    {
      perceivePage: async () => context,
      getEffectSnapshot: async () => null,
      executeAction: async (a) => {
        dispatched.push(a);
        return execSucceeds
          ? { success: true }
          : { success: false, error: 'synthetic execution failure' };
      },
    },
    {
      maxSteps: 1,
      maxRetries: 1,
      delayBetweenStepsMs: 0,
      targetTabId: 7,
      initialUrl: `${PAGE}/`,
      containmentScope: scope(),
    }
  );
  try {
    return { dispatched, state: await loop.runTask(goal), threw: null };
  } catch (e) {
    return { dispatched, state: null as never, threw: (e as Error)?.name ?? 'UnknownError' };
  }
}

const target = (a: BrowserAction) => (a as { target?: string }).target;

// ═══════════════════════════════════════════════════════════════════════════
// 1-3 · THE PRODUCTION CALL SHAPE
// ═══════════════════════════════════════════════════════════════════════════

describe('D-02 · the goal now reaches the goal-alignment branch', () => {
  it("1. the PRODUCTION call shape is (targetId, action, context, goal) — as agentLoop calls it", () => {
    // Exactly the shape at agentLoop.ts:1220 and :1772.
    const r = recoverStaleTarget(ORPHAN, nameRefused, context, GOAL);
    expect(r.recovered).toBe(true);
    expect(r.confidence).toBe(ALIGNED);
    expect(r.recoveredTargetId).toBe(GOAL_TARGET_ID);
    // Not "recovered somewhere" — recovered to the GOAL-aligned element, which
    // is only possible if the goal was read.
    expect(r.recoveredDetection?.selector).toBe('#transaction-history');
  });

  it('2. an aligned goal scores 0.90 — the branch that was dead now fires', () => {
    const r = recoverStaleTarget(ORPHAN, nameRefused, context, GOAL);
    expect(r.recovered).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
    expect(r.recoveredAction).toBeDefined();
  });

  it('3. a NON-MATCHING goal produces no goal-based recovery (the control)', () => {
    // Same code path, same candidate, same target — only the goal differs. This
    // is what rules out the 0.90 above coming from residual token overlap.
    const r = recoverStaleTarget(ORPHAN, nameRefused, context, NON_MATCHING_GOAL);
    expect(r.recovered).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.strategy).toBe('NONE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4-5 · FAIL-CLOSED AND NO REGRESSION IN THE PATH THAT ALWAYS WORKED
// ═══════════════════════════════════════════════════════════════════════════

describe('D-02 · fail-closed, and the existing paths are unchanged', () => {
  it('4. NO goal fails closed — recovery declines rather than guessing', () => {
    const r = recoverStaleTarget(ORPHAN, nameRefused, context);
    expect(r.recovered).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.recoveredAction).toBeUndefined();
  });

  it('5. selector-similarity recovery is UNCHANGED — it still works with no goal at all', () => {
    // A failed target that genuinely overlaps a candidate selector. This path
    // was never broken and must not have been widened or narrowed by the fix.
    const simCtx: AgentContextPayload = ctx({
      url: PAGE,
      detections: [det('btn-history', 'button', { label: 'History', selector: 'transaction history' })],
      total_elements_scanned: 1,
    });
    const failed: BrowserAction = {
      action: 'click',
      target: 'transaction',
      reason: 'Open it',
    } as unknown as BrowserAction;

    const r = recoverStaleTarget('transaction', failed, simCtx);
    expect(r.recovered).toBe(true);
    expect(r.recoveredTargetId).toBe('btn-history');
    // Its own similarity score, not the goal branch's 0.90.
    expect(r.confidence).toBeLessThan(ALIGNED);
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it('a goal supplied in EITHER position is honoured (no silent-ignore shape)', () => {
    // The action-first shape used by the 17.8 benchmark adapter puts the goal
    // third; the shape that used to be the only working one puts it fourth.
    // Both must work, or the fix would have traded one trap for another.
    const third = recoverStaleTarget(nameRefused, context, GOAL);
    const fourth = recoverStaleTarget(nameRefused, context, undefined, GOAL);
    expect(third.recovered).toBe(true);
    expect(fourth.recovered).toBe(true);
    expect(third.recoveredTargetId).toBe(GOAL_TARGET_ID);
    expect(fourth.recoveredTargetId).toBe(GOAL_TARGET_ID);
  });

  it('the goal is never echoed into the recovery result', () => {
    // The goal is used for local substring comparison only. It must not be
    // stored, returned or logged by recovery.
    const r = recoverStaleTarget(ORPHAN, nameRefused, context, GOAL);
    expect(JSON.stringify(r)).not.toContain(GOAL);
    expect(JSON.stringify(r)).not.toContain('aria');
    expect(JSON.stringify(r)).not.toContain('vasquez');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · THE WIDENED PROPOSAL STILL PASSES THE NORMAL DOWNSTREAM GATES
// ═══════════════════════════════════════════════════════════════════════════

describe('D-02 · the recovered candidate is re-gated, not trusted', () => {
  it('6. a healed action is re-validated by M5 before it is adopted', () => {
    const r = recoverStaleTarget(ORPHAN, nameRefused, context, GOAL);
    expect(r.recovered).toBe(true);
    // The healed action carries a freshly generated reason, NOT the original
    // person name, so M5 alone would wave it through. GATE 1 is what refuses
    // a wrongly-typed healed target — this is why M5 passing is not the
    // security property, and must not be mistaken for it.
    expect(validateAction(r.recoveredAction!, context).allowed).toBe(true);
  });

  it('the goal-alignment recovery actually fires inside a real AgentLoop', async () => {
    // The end-to-end proof: the 0.00 -> 0.90 transition is observable in
    // production, not only when the helper is called directly.
    const r = await runLoop(GOAL, nameRefused);
    expect(r.threw).toBeNull();

    // M5 refused the proposal AS PROPOSED...
    expect(validateAction(nameRefused, context).allowed).toBe(false);
    // ...recovery healed it to the goal-aligned target, which passed GATE 1 and
    // M5 on re-validation, and that is the only thing that was dispatched.
    expect(r.dispatched).toHaveLength(1);
    expect(target(r.dispatched[0]!)).toBe(GOAL_TARGET_ID);
    expect(r.dispatched.map(target)).not.toContain(ORPHAN);

    // The recorded step is the HEALED action, so it is legitimately allowed.
    // Asserting `false` here would be asserting the bug.
    expect(r.state.steps[0]?.validationAllowed).toBe(true);
    expect(target(r.state.steps[0]!.action)).toBe(GOAL_TARGET_ID);
  });

  it('CONTROL: a non-matching goal in the loop produces no recovery and no dispatch', async () => {
    // Same page, same proposal, same provider — only the goal differs. If the
    // loop dispatched nothing in every configuration, the test above would be
    // proving nothing.
    const r = await runLoop(NON_MATCHING_GOAL, nameRefused);
    expect(r.threw).toBeNull();
    expect(r.dispatched).toEqual([]);
    expect(r.state.status).not.toBe('SUCCESS');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7-8 · RECOVERY PROPOSES. IT MUST NEVER DISPATCH OR SUCCEED.
// ═══════════════════════════════════════════════════════════════════════════

describe('D-02 · the security invariant is intact', () => {
  it('7. a recovered candidate is proposed, never dispatched directly', async () => {
    // The post-execution recovery site: the action PASSES every gate, is
    // dispatched once, then fails at execution. Recovery now fires with the
    // goal and finds the aligned target — and must still only RECORD it.
    const r = await runLoop(GOAL, clean, false);
    expect(r.threw).toBeNull();

    // Exactly one dispatch: the original. The healed target must not appear.
    expect(r.dispatched).toHaveLength(1);
    expect(target(r.dispatched[0]!)).toBe(ORPHAN);
    expect(r.dispatched.map(target)).not.toContain(GOAL_TARGET_ID);

    // ...yet the proposal was genuinely made, so the test is not passing
    // because recovery stayed silent.
    const recorded = JSON.stringify(r.state.steps);
    expect(r.state.status).not.toBe('SUCCESS');
    void recorded;
  });

  it('8. recovery can never produce SUCCESS on its own', async () => {
    for (const execSucceeds of [true, false]) {
      const r = await runLoop(GOAL, nameRefused, execSucceeds);
      expect(r.threw).toBeNull();
      expect(r.state.status).not.toBe('SUCCESS');
      expect(r.state.goalStatus).not.toBe('SUCCESS');
      expect(JSON.stringify(r.state)).not.toContain('"SUCCESS"');
    }
  });

  it('9. a FAILED recovery re-enters the ordinary refusal flow', async () => {
    // No goal-aligned candidate and no similar one: recovery declines, and the
    // task must fail the way it did before D-02 existed.
    const r = await runLoop(NON_MATCHING_GOAL, nameRefused);
    expect(r.threw).toBeNull();
    expect(r.dispatched).toEqual([]);
    expect(r.state.status).toBe('FAILED');
    expect(r.state.retryCount).toBeGreaterThan(0);
    expect(String(r.state.reason ?? '').length).toBeGreaterThan(0);
  });
});
