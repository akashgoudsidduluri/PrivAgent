/**
 * PHASE 17.4 — LONG-HORIZON RELIABILITY
 *
 * The invariants under test throughout:
 *
 *     PROGRESS IS OBSERVATION-BACKED
 *     BOOKKEEPING IS NOT PROGRESS
 *     A BOUND IS NOT A VERDICT
 *
 * Phase 9 built the long-horizon machinery (fingerprints, loop detection, stall
 * detection, hard bounds). Phase 17.4 did not rebuild it — the audit found the
 * machinery sound and the WIRING defective, so these tests pin the wiring and
 * the pure functions it depends on.
 *
 * Every "must fail closed" case below is built from bookkeeping or bounded
 * budgets only. None of them may produce a SUCCESS verdict.
 *
 * NOTE on the fail-closed verdict: `GoalVerificationResult` still has no
 * UNVERIFIABLE state (Phase 17.2 documented gap). The strongest fail-closed
 * behaviour the existing contract supports is asserted here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  assessProgress,
  detectLoop,
  detectStall,
  checkBounds,
  fingerprintObservation,
  observeFromContext,
  transitionSubgoal,
  LongHorizonTracker,
  DEFAULT_LONG_HORIZON_BOUNDS,
  type TaskObservation,
  type LongHorizonSubgoal,
} from '../../extension/src/agent/longHorizon';
import type { Subgoal } from '../../extension/src/hierarchicalPlanning/hierarchicalTypes';
import { verifyTaskGoal } from '../../extension/src/agent/goalVerifier';
import { AgentLoop } from '../../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../../extension/src/agent/mockAgentProvider';
import { observingHost } from '../helpers/observingHost';
import type { AgentContextPayload } from '../../extension/src/privacy/types';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const obs = (over: Partial<TaskObservation> = {}): TaskObservation => ({
  url: 'http://localhost:4200/bank',
  pageGeneration: 1,
  entityIds: ['e1', 'e2'],
  candidateIds: ['c1', 'c2'],
  scrollY: 0,
  targetValueLength: 0,
  viewportObservable: true,
  ...over,
});

const ctx = (over: Record<string, unknown> = {}): AgentContextPayload =>
  ({
    sanitized_status: 'sanitized_only',
    url: 'http://localhost:4200/bank',
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    detections: [],
    ...over,
  }) as unknown as AgentContextPayload;

/** A registered subgoal, as `initialize` requires before it can transition. */
const subgoal = (id: string, state: Subgoal['state'] = 'PENDING'): Subgoal =>
  ({
    id,
    goalId: 'g1',
    index: 0,
    description: `work ${id}`,
    category: 'GENERIC_INTERACTION',
    state,
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
  }) as unknown as Subgoal;

const state = (over: Record<string, unknown> = {}) =>
  ({
    task: '',
    taskConstraints: {},
    previousActions: [],
    steps: [],
    visitedElementIds: [],
    candidateItems: [],
    ...over,
  }) as never;

/* ═══════════════════════════════════════════════════════════════════════════
 * A. 5+ action successful long-horizon task
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-A a multi-step task reports progress from observation', () => {
  it('five genuinely different observed states are five progress signals', () => {
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    const seen: boolean[] = [];
    let prev: TaskObservation | null = null;
    for (let i = 0; i < 5; i++) {
      const cur = obs({
        url: `http://localhost:4200/step-${i}`,
        candidateIds: ['c1', 'c2', `c${i}`],
        entityIds: ['e1', 'e2', `e${i}`],
      });
      seen.push(t.observe(cur).meaningful);
      prev = cur;
    }
    expect(prev).not.toBeNull();
    expect(seen).toEqual([true, true, true, true, true]);
    expect(t.totalNoProgress).toBe(0);
    expect(t.detectStall().stalled).toBe(false);
  });

  it('the agent completes a 5-action task and the goal verifies from observation', () => {
    // Goal success must still come only from the goal verifier, never from the
    // long-horizon layer having counted five actions.
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    for (let i = 0; i < 5; i++) t.observe(obs({ url: `http://localhost:4200/s${i}` }));
    expect(t.actionCount).toBe(5);

    // Same action count, no observed results URL → NOT a success.
    const r = verifyTaskGoal('search for cats', state({ currentUrl: 'http://localhost:4200/bank' }), ctx());
    expect(r.satisfied).toBe(false);

    // ...and the same task DOES verify once the URL is genuinely observed.
    const ok = verifyTaskGoal(
      'search for cats',
      state({ currentUrl: 'http://localhost:4200/results?q=cats' }),
      ctx({ url: 'http://localhost:4200/results?q=cats' })
    );
    expect(ok.satisfied).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * B. repeated identical failed action
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-B repeated identical failed action is detected', () => {
  it('A -> FAIL -> A -> FAIL reaches a bounded loop verdict', () => {
    // PHASE 17.4 D2: the fingerprint is documented as "same page state + same
    // action". Before the fix the action argument was never supplied, so this
    // was only ever true by accident of the observation repeating.
    const sameAction = { action: 'click', target: 'btn' } as never;
    const a = fingerprintObservation(obs(), sameAction);
    const b = fingerprintObservation(obs(), sameAction);
    const c = fingerprintObservation(obs({ url: 'http://localhost:4200/other' }), sameAction);
    expect(a).toBe(b);
    expect(a).not.toBe(c);

    const d = detectLoop([a, a, a], DEFAULT_LONG_HORIZON_BOUNDS);
    expect(d.loop).toBe(true);
    expect(d.kind).toBe('REPEATED_STATE');
  });

  it('the action argument actually changes the fingerprint', () => {
    const o = obs();
    const click = fingerprintObservation(o, { action: 'click', target: 'x' } as never);
    const scroll = fingerprintObservation(o, { action: 'scroll', direction: 'down' } as never);
    const none = fingerprintObservation(o);
    expect(new Set([click, scroll, none]).size).toBe(3);
  });

  it('the tracker records the attempted action at its call site', () => {
    // A repeated identical action on an UNCHANGING page must not silently look
    // like a fresh observation each time.
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    const act = { action: 'click', target: 'btn' } as never;
    t.observe(obs(), act);
    t.observe(obs(), act);
    t.observe(obs(), act);
    const fps = t.getRecentFingerprints();
    expect(fps[0]).toBe(fps[1]);
    expect(fps[1]).toBe(fps[2]);
    expect(t.detectLoop().loop).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C. legitimate repeated action with changing observed state
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-C a repeated action is legitimate when the page really changes', () => {
  it('repeated scrolls that change observed state are NOT a loop', () => {
    const act = { action: 'scroll', direction: 'down' } as never;
    const fps = [0, 400, 800, 1200].map((y) => fingerprintObservation(obs({ scrollY: y }), act));
    expect(new Set(fps).size).toBe(4);
    expect(detectLoop(fps, DEFAULT_LONG_HORIZON_BOUNDS).loop).toBe(false);
  });

  it('progress is real when new candidates actually appear', () => {
    const prev = obs({ candidateIds: ['c1'] });
    const cur = obs({ candidateIds: ['c1', 'c2', 'c3'] });
    const r = assessProgress(prev, cur);
    expect(r.meaningful).toBe(true);
    expect(r.signals).toContain('NEW_CANDIDATE');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * D/E. recovery loops and recovery oscillation
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-D/E loops and oscillation are bounded', () => {
  it('A -> B -> A -> B alternating loop is detected', () => {
    const a = fingerprintObservation(obs({ url: 'http://x/1' }));
    const b = fingerprintObservation(obs({ url: 'http://x/2' }));
    const d = detectLoop([a, b, a, b], DEFAULT_LONG_HORIZON_BOUNDS);
    expect(d.loop).toBe(true);
    expect(d.kind).toBe('ALTERNATING_LOOP');
  });

  it('recovery cannot terminate the task successfully', () => {
    // A replan reopens outstanding work; it never completes anything and never
    // produces a goal verdict.
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    t.initialize('do the thing', [], [subgoal('sg-1')]);
    t.transition('sg-1', 'ACTIVE');
    t.transition('sg-1', 'BLOCKED', 'stall');
    const r = t.replanRemaining('sg-1', 'loop detected');
    expect(r.reopened).toContain('sg-1');
    expect(t.completedSubgoalIds).toEqual([]);
    // And the goal is still unverified.
    const g = verifyTaskGoal('open the account details', state({ previousActions: [{ action: 'click' }] }), ctx());
    expect(g.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F/G/H/I. observation staleness, unavailability, transitions
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-F/G/H/I observations must be provenance-bearing', () => {
  it('an unobservable viewport cannot be reported as progress', () => {
    // PHASE 17.4 D4/P4: the 17.1 all-zero fallback is the ABSENCE of a
    // reading. Two identical all-zero viewports mean "we do not know", not
    // "nothing moved" and not "progress".
    const prev = obs({ scrollY: 0, viewportObservable: false });
    const cur = obs({ scrollY: 0, viewportObservable: false });
    expect(assessProgress(prev, cur).meaningful).toBe(false);
  });

  it('DIFFERENT unobservable geometry is still not progress', () => {
    // The stronger form, and the one that actually discriminates: a decoder
    // that ignored the observability flag would see 0 → 900 and call it
    // movement. The page was never read, so nothing was observed to move.
    const prev = obs({ scrollY: 0, viewportObservable: false });
    const cur = obs({ scrollY: 900, viewportObservable: false });
    expect(assessProgress(prev, cur).meaningful).toBe(false);
  });

  it('the same geometry read vs not-read is a different fingerprint', () => {
    // "We could not read the geometry" must not collapse into the same
    // fingerprint as "we read it and it did not change".
    const unobservable = fingerprintObservation(obs({ scrollY: 0, viewportObservable: false }));
    const observedUnchanged = fingerprintObservation(obs({ scrollY: 0, viewportObservable: true }));
    expect(unobservable).not.toBe(observedUnchanged);
  });

  it('a stale repeated observation does not masquerade as progress', () => {
    const stale = obs({ viewportObservable: false, candidateIds: [], entityIds: [] });
    const again = obs({ viewportObservable: false, candidateIds: [], entityIds: [] });
    expect(assessProgress(stale, again).meaningful).toBe(false);
  });

  it('a real document transition IS progress (17.3 document identity)', () => {
    // A hash-only change is the same document and must NOT count.
    const same = assessProgress(obs({ url: 'http://x/p#a' }), obs({ url: 'http://x/p#b' }));
    expect(same.meaningful).toBe(false);
    // A path change is a different document and does count.
    const diff = assessProgress(obs({ url: 'http://x/p' }), obs({ url: 'http://x/q' }));
    expect(diff.meaningful).toBe(true);
    expect(diff.signals).toContain('NEW_PAGE');
  });

  it('observeFromContext carries the 17.1 observability flag through', () => {
    const yes = observeFromContext(ctx({ viewportObservable: true }));
    const no = observeFromContext(ctx({ viewportObservable: false }));
    expect(yes.viewportObservable).toBe(true);
    expect(no.viewportObservable).toBe(false);
  });

  it('unavailable perception is not silently continued with old evidence', () => {
    // The loop's own contract: a null perception is FAILED, never "keep going
    // with the last context". Asserted here at the layer that supplies it.
    expect(observeFromContext(ctx({ url: '', viewportObservable: false })).url).toBe('');
    const g = verifyTaskGoal('search for cats', state({ currentUrl: 'http://localhost:4200/bank' }), ctx({ url: '' }));
    expect(g.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * J/K. budget exhaustion
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-J budget exhaustion is a bound, never a verdict', () => {
  const B = DEFAULT_LONG_HORIZON_BOUNDS;
  it('action budget exhaustion is reported, and is not success', () => {
    const r = checkBounds({ actionCount: B.maxTotalActions, recoveryCount: 0, totalNoProgress: 0, subgoalCount: 0 }, B);
    expect(r.exhausted).toBe(true);
    expect(r.reason).toBe('ACTION_BUDGET_EXHAUSTED');
    expect(r).not.toHaveProperty('satisfied');
  });

  it('every hard bound fails closed', () => {
    expect(checkBounds({ actionCount: 0, recoveryCount: B.maxReplans, totalNoProgress: 0, subgoalCount: 0 }, B).reason)
      .toBe('REPLANNING_EXHAUSTED');
    expect(checkBounds({ actionCount: 0, recoveryCount: 0, totalNoProgress: B.maxStallActions, subgoalCount: 0 }, B).reason)
      .toBe('STALL_BUDGET_EXHAUSTED');
    expect(checkBounds({ actionCount: 0, recoveryCount: 0, totalNoProgress: 0, subgoalCount: B.maxSubgoals }, B).reason)
      .toBe('SUBGOAL_BUDGET_EXHAUSTED');
  });

  it('an exhausted task still cannot verify its goal', () => {
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    for (let i = 0; i < B.maxTotalActions; i++) t.observe(obs());
    expect(t.checkBounds().exhausted).toBe(true);
    const g = verifyTaskGoal('open the account details', state(), ctx());
    expect(g.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * L/M. terminal state, planner bookkeeping
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-L/M terminal and planner state cannot manufacture success', () => {
  it('a completed subgoal is terminal and cannot be reopened by a replan', () => {
    const sg: LongHorizonSubgoal = { id: 'a', description: 'd', category: 'c', status: 'ACTIVE', attempts: 1 };
    expect(transitionSubgoal(sg, 'COMPLETED', 'done').ok).toBe(true);
    const back = transitionSubgoal(sg, 'ACTIVE', 'reopen');
    expect(back.ok).toBe(false);
  });

  it('a replan preserves completed subgoals and never completes new ones', () => {
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    t.initialize('goal', [], [subgoal('done-1'), subgoal('open-1')]);
    t.transition('done-1', 'ACTIVE');
    t.transition('done-1', 'COMPLETED');
    t.transition('open-1', 'ACTIVE');
    t.transition('open-1', 'FAILED');
    const r = t.replanRemaining('open-1', 'loop');
    expect(r.preservedCompleted).toEqual(['done-1']);
    expect(r.reopened).toEqual(['open-1']);
    expect(t.completedSubgoalIds).toEqual(['done-1']);
  });

  it('all subgoals complete is NOT goal completion', () => {
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    t.initialize('goal', [], [subgoal('a'), subgoal('b')]);
    t.transition('a', 'ACTIVE');
    t.transition('a', 'COMPLETED');
    t.transition('b', 'ACTIVE');
    t.transition('b', 'COMPLETED');
    expect(t.completedSubgoalIds).toHaveLength(2);
    const g = verifyTaskGoal('open the account details', state(), ctx());
    expect(g.satisfied).toBe(false);
  });

  it('a long action history is not progress and is not a verdict', () => {
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    // The first observation legitimately counts as progress (a page relative to
    // nothing). The SECOND, identical observation is the one that must not.
    t.observe(obs());
    expect(t.consecutiveNoProgress).toBe(0);
    t.observe(obs());
    expect(t.consecutiveNoProgress).toBe(1);
    const g = verifyTaskGoal('open the account details', state({ previousActions: Array.from({ length: 20 }, () => ({ action: 'click' })) }), ctx());
    expect(g.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * R. LOOP-LEVEL: the wiring, exercised through the real AgentLoop
 *
 * The pure-function tests above cannot see the call site. These run the actual
 * loop so that a regression in the AgentLoop -> LongHorizonTracker wiring is
 * caught even when every pure function is individually correct.
 * ═════════════════════════════════════════════════════════════════════════ */

const loopCtx = (url: string): AgentContextPayload =>
  ({
    url,
    timestamp: 1,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    viewportObservable: true,
    screenshot_dimensions: null,
    // A real, groundable target. Without one, grounding rejects the action and
    // the task fails for a reason that has nothing to do with long-horizon
    // reliability — which would make every "stuck agent" test pass vacuously.
    detections: [
      {
        id: 'element_details_0',
        type: 'button',
        confidence: 0.95,
        bbox: { x: 50, y: 100, width: 200, height: 35 },
        length: 0,
        source: 'dom_attribute',
        selector: '#details',
        is_partially_visible: false,
      },
    ],
    total_elements_scanned: 4,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  }) as unknown as AgentContextPayload;

describe('17.4-R the loop wiring fails closed (end to end)', () => {
  it('a stuck agent ends FAILED and bounded, never SUCCESS', async () => {
    // Every action DISPATCHES successfully and the page NEVER changes. Effect
    // verification correctly reports ACTION_NO_EFFECT, so the RECOVERY limit is
    // the first bound to fire in this configuration — which is the correct
    // fail-closed layering. What matters for 17.4 is the terminal outcome: a
    // stuck agent must end bounded and must never report SUCCESS.
    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({ action: 'click', target: 'element_details_0' }));
    const executeAction = vi.fn(async () => ({ success: true, message: 'dispatched' }));

    const page = { url: 'http://localhost:4200/bank', domElementCount: 4 };
    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(() => page),
        perceivePage: async () => loopCtx(page.url),
        executeAction,
      },
      { delayBetweenStepsMs: 1, maxSteps: 12 }
    );

    const finalState = await loop.runTask('open the account details');

    // Transport really happened — otherwise this would pass for the wrong reason.
    expect(executeAction).toHaveBeenCalled();
    expect(finalState.steps.length).toBeGreaterThan(0);
    expect(finalState.status).toBe('FAILED');
    expect(finalState.goalStatus).not.toBe('SUCCESS');
    expect(finalState.steps.length).toBeLessThan(12);
  });

  it('dispatch + verified effect on a NEVER-CHANGING page still stalls out', async () => {
    // The precise Phase 17.4 defect (D1), reproduced end to end.
    //
    // Here every gate is happy: the action is grounded, validated, dispatched,
    // AND effect verification succeeds (the DOM element count really does
    // change each cycle). The page URL, the entity ids, the candidate ids and
    // the scroll position NEVER change — so the long-horizon observation is
    // byte-identical every cycle.
    //
    // Before 17.4 this could not be detected: `subgoalJustCompleted` was derived
    // from `lastActionResult.success`, so every one of those successful
    // dispatches reported "meaningful progress", `consecutiveNoProgress` never
    // advanced, and the task simply ran to the step ceiling. It must now stop
    // on an observation-backed bound, well before that.
    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({ action: 'click', target: 'element_details_0' }));
    const executeAction = vi.fn(async () => ({ success: true, message: 'dispatched' }));

    const page = { url: 'http://localhost:4200/bank', domElementCount: 4 };
    const loop = new AgentLoop(
      provider,
      {
        // The DOM count changes on every snapshot, so effect verification
        // genuinely observes an effect and never short-circuits the run.
        getEffectSnapshot: observingHost(() => {
          page.domElementCount += 1;
          return page;
        }),
        perceivePage: async () => loopCtx(page.url),
        executeAction,
      },
      { delayBetweenStepsMs: 1, maxSteps: 30 }
    );

    const finalState = await loop.runTask('open the account details');

    expect(executeAction).toHaveBeenCalled();
    // Effect verification really did see effects — this is not a no-effect run.
    expect(finalState.steps.some((s) => s.executionSuccess)).toBe(true);
    // It stopped on a bound well short of the 30-step ceiling, because the
    // observation never changed.
    expect(finalState.steps.length).toBeLessThan(12);
    expect(finalState.status).toBe('FAILED');
    expect(finalState.goalStatus).not.toBe('SUCCESS');
  });

  it('a genuinely progressing 5-action task is NOT killed as stagnant', async () => {
    // The counterpart to the two tests above: the fix must not simply make the
    // loop fail fast. Real observed progress must keep it alive long enough to
    // reach goal verification, and the goal must verify from the observation.
    const provider = new MockAgentProvider();
    const page = { url: 'http://localhost:4200/start', domElementCount: 1 };
    let step = 0;
    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(() => page),
        perceivePage: async () => loopCtx(page.url),
        executeAction: async () => {
          step += 1;
          // Real observed progress for the first cycles, then the agent
          // genuinely reaches a results page — which is what the goal
          // verifier will decide from.
          page.url =
            step < 3
              ? `http://localhost:4200/page-${step}`
              : 'http://localhost:4200/results?q=cats';
          return { success: true, message: 'dispatched' };
        },
      },
      { delayBetweenStepsMs: 1, maxSteps: 12 }
    );

    const finalState = await loop.runTask('search for cats');
    // It got far enough to reach the observed results URL, and the goal
    // verifier decided SUCCESS from THAT observation — not from the count.
    expect(finalState.status).toBe('SUCCESS');
    expect(finalState.goalStatus).toBe('SUCCESS');
    expect(finalState.steps.length).toBeGreaterThanOrEqual(1);
    expect(finalState.steps.length).toBeLessThan(5);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * N/O/P/Q. the 17.2A invariants still hold on the long-horizon path
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-N/O/P/Q long-horizon bookkeeping never becomes goal evidence', () => {
  it('a full action history plus progress signals still cannot verify a goal', () => {
    const t = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
    for (let i = 0; i < 6; i++) t.observe(obs({ url: `http://localhost:4200/p${i}` }));
    const s = t.snapshot();
    expect(s.actionCount).toBeGreaterThan(0);
    const g = verifyTaskGoal(
      'open the account details',
      state({ previousActions: [{ action: 'click' }], longHorizon: s }),
      ctx()
    );
    expect(g.satisfied).toBe(false);
  });

  it('dispatch success is not progress (the Phase 17.4 defect itself)', () => {
    // The regression that pins D1: assessProgress must not report meaningful
    // progress on bookkeeping alone.
    const r = assessProgress(obs(), obs(), { subgoalJustCompleted: 'sg-1' });
    expect(r.meaningful).toBe(false);
    expect(r.signals).toContain('SUBGOAL_COMPLETED');
  });

  it('dispatch success is not a verdict', () => {
    const g = verifyTaskGoal('open the account details', state({ steps: [{ step: 1, executionSuccess: true }] }), ctx());
    expect(g.satisfied).toBe(false);
  });

  it('a requested URL is not an observation', () => {
    const g = verifyTaskGoal('search for cats', state({ currentUrl: 'http://localhost:4200/' }), ctx({ url: 'http://localhost:4200/' }));
    expect(g.satisfied).toBe(false);
  });
});
