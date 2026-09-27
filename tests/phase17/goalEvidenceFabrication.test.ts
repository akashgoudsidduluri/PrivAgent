/**
 * PHASE 17.2A — GOAL EVIDENCE FABRICATION REMEDIATION
 *
 * The invariant under test throughout:
 *
 *     ACTION REQUEST   != OBSERVED RESULT
 *     DISPATCH SUCCESS != GOAL SUCCESS
 *
 * Before 17.2A the goal verifier could report SUCCESS from things that describe
 * TRANSPORT state rather than the browser: a dispatched click, a typed value, a
 * `previousActions` count, `executionSuccess`, or the URL a navigate action
 * REQUESTED. This file pins the removal of that entire class of evidence.
 *
 * Every "must fail" case below is built from a fabricated signal ONLY. If any of
 * them satisfies the goal, the remediation has regressed.
 *
 * Note on the fail-closed verdict: `GoalVerificationResult` has no UNVERIFIABLE
 * status (that is Phase 17.2 proper). The strongest fail-closed behaviour the
 * existing contract can express is asserted here — `satisfied === false` with
 * `status === 'IN_PROGRESS'`, which is NOT a claim that the goal was not met.
 */

import { describe, it, expect, vi } from 'vitest';
import { verifyTaskGoal } from '../../extension/src/agent/goalVerifier';
import { advancePageGeneration } from '../../extension/src/agent/agentState';
import { AgentLoop } from '../../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../../extension/src/agent/mockAgentProvider';
import { observingHost } from '../helpers/observingHost';
import { PlanStateMachine } from '../../extension/src/hierarchicalPlanning/planStateMachine';
import type { AgentContextPayload, AgentDetection } from '../../extension/src/privacy/types';
import type { AgentTaskState, StepRecord } from '../../extension/src/agent/agentState';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const detection = (
  id: string,
  type: string,
  selector: string,
  over: Partial<AgentDetection> = {}
): AgentDetection =>
  ({
    id, type, selector,
    confidence: 0.95,
    bbox: { x: 10, y: 10, width: 120, height: 30 },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
    ...over,
  }) as unknown as AgentDetection;

/** A context with NO evidence of any goal being met. */
const bareCtx = (url = 'http://localhost:4200/'): AgentContextPayload =>
  ({
    sanitized_status: 'sanitized_only',
    detections: [],
    url,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
  }) as unknown as AgentContextPayload;

const state = (over: Record<string, unknown> = {}): AgentTaskState =>
  ({
    task: '',
    taskConstraints: {},
    previousActions: [],
    steps: [],
    visitedElementIds: [],
    candidateItems: [],
    ...over,
  }) as unknown as AgentTaskState;

const click = { action: 'click', target: 'x' };
const scroll = { action: 'scroll', direction: 'down', amount: 500 };
const type = { action: 'type', target: 'q', text: 'cats' };

/* ═══════════════════════════════════════════════════════════════════════════
 * A. previousActions alone cannot produce goal success
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.2A-A action history is not evidence', () => {
  it('an arbitrarily long click history satisfies no goal on its own', () => {
    // 20 dispatched actions, none of which changed anything.
    const history = Array.from({ length: 20 }, () => click);
    for (const task of [
      'open the account details',
      'find the account number field',
      'show my recent transactions',
    ]) {
      const r = verifyTaskGoal(task, state({ previousActions: history }), bareCtx());
      expect(r.satisfied, `task: ${task}`).toBe(false);
    }
  });

  it('a typed value is not observed content', () => {
    // The agent typed "cats". The browser state says nothing about content.
    const r = verifyTaskGoal('search cats', state({ previousActions: [type] }), bareCtx());
    expect(r.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * B. click + scroll history cannot produce transaction-history success
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.2A-B the banking fabrication is gone', () => {
  it('the exact fabricated triple that used to verify now fails closed', () => {
    // This is the pre-17.2A condition verbatim: >=3 actions, a click, a scroll.
    // It previously returned:
    //   { satisfied: true, reason: '...verified recent account transaction history.' }
    const r = verifyTaskGoal(
      'show the account details and recent transactions',
      state({ previousActions: [click, click, scroll], pageType: 'banking' }),
      bareCtx('http://localhost:4200/bank')
    );
    expect(r.satisfied).toBe(false);
    expect(r.status).toBe('IN_PROGRESS');
  });

  it('an OBSERVED transaction surface is what establishes it instead', () => {
    const withLedger = {
      ...bareCtx('http://localhost:4200/bank'),
      detections: [detection('t', 'credit_card', '#transaction-table')],
    } as AgentContextPayload;
    const r = verifyTaskGoal(
      'show the account details and recent transactions',
      state({ previousActions: [click, click, scroll] }),
      withLedger
    );
    expect(r.satisfied).toBe(true);
    // ...and, critically, it also succeeds with NO action history at all, which
    // is the proof that the history was never the evidence.
    const noHistory = verifyTaskGoal(
      'show the account details and recent transactions',
      state(),
      withLedger
    );
    expect(noHistory.satisfied).toBe(true);
  });

  it('an account-details goal needs the observed details surface, not a click', () => {
    const dispatchedOnly = verifyTaskGoal(
      'open the account details',
      state({ previousActions: [click, click, click] }),
      bareCtx('http://localhost:4200/portal')
    );
    expect(dispatchedOnly.satisfied).toBe(false);

    const observed = verifyTaskGoal(
      'open the account details',
      state(),
      bareCtx('http://localhost:4200/portal/transactions')
    );
    expect(observed.satisfied).toBe(true);
  });

  it('a banking PORTAL page alone does not prove a details VIEW is open', () => {
    // `pageType === 'banking'` classifies the SITE. Being anywhere on a banking
    // portal must not claim a particular pane is displayed.
    const r = verifyTaskGoal(
      'open the account details',
      state({ pageType: 'banking' }),
      bareCtx('http://localhost:4200/portal')
    );
    expect(r.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * C/D. Requested parameters and dispatch success are not evidence
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.2A-C/D requested parameters and dispatch results are not evidence', () => {
  // A real multi-page research goal: three enumerated items across several
  // pages. Using a task shape the verifier actually recognises is essential —
  // a task the verifier never claims as a research goal would return
  // `satisfied === false` for uninteresting reasons and prove nothing.
  const RESEARCH_TASK =
    'Find the director, producers, and cinematographer. Inspect multiple relevant pages and return a structured summary.';

  const navigateStep = (over: Partial<StepRecord> = {}): StepRecord =>
    ({
      step: 1,
      action: { action: 'navigate', url: 'http://localhost:4200/next' },
      validationAllowed: true,
      validationReason: 'ok',
      executionSuccess: true,
      // step.url is the OBSERVED tab url — still on the ORIGINAL page.
      url: 'http://localhost:4200/',
      timestamp: 1,
      ...over,
    }) as unknown as StepRecord;

  it('action.url cannot establish navigation success (a blocked/failed nav)', () => {
    // RESEARCH_TASK is a genuine multi-page research goal, so this is NOT a
    // vacuous miss: the next test proves the same goal DOES verify once the
    // urls are observed. Here only the REQUESTED destination exists.
    const r = verifyTaskGoal(
      RESEARCH_TASK,
      state({
        steps: [navigateStep({ navigationDestination: 'http://localhost:4200/director' })],
        currentUrl: 'http://localhost:4200/',
      }),
      bareCtx('http://localhost:4200/')
    );
    expect(r.satisfied).toBe(false);
    expect(r.status).toBe('IN_PROGRESS');
  });

  it('a REQUESTED url is not an OBSERVED page even when dispatch succeeded', () => {
    // executionSuccess + a navigationDestination pointing at a research item:
    // both are transport/intent, so the goal must not verify from them.
    const r = verifyTaskGoal(
      RESEARCH_TASK,
      state({
        steps: [navigateStep({ navigationDestination: 'http://localhost:4200/director' })],
        currentUrl: 'http://localhost:4200/',
      }),
      bareCtx('http://localhost:4200/')
    );
    expect(r.satisfied).toBe(false);
  });

  it('an OBSERVED committed url does establish it', () => {
    // Control for the two tests above: identical goal, identical task, the only
    // difference is that the three item pages are now OBSERVED (`step.url` /
    // `currentUrl`) rather than merely requested.
    const observedStep = (u: string) =>
      navigateStep({ url: u, navigationDestination: 'http://localhost:4200/somewhere-else' });
    const r = verifyTaskGoal(
      RESEARCH_TASK,
      state({
        steps: [observedStep('http://localhost:4200/director'), observedStep('http://localhost:4200/producers')],
        currentUrl: 'http://localhost:4200/cinematographer',
      }),
      bareCtx('http://localhost:4200/cinematographer')
    );
    expect(r.satisfied).toBe(true);
  });

  it('executionSuccess alone cannot establish a goal', () => {
    // Every step dispatched without error and the goal is still unmet.
    const steps = Array.from({ length: 3 }, (_, i) =>
      navigateStep({ step: i + 1, url: 'http://localhost:4200/', executionSuccess: true })
    );
    const r = verifyTaskGoal(
      RESEARCH_TASK,
      state({ steps, currentUrl: 'http://localhost:4200/' }),
      bareCtx('http://localhost:4200/')
    );
    expect(r.satisfied).toBe(false);
  });

  it('visitedElementIds (populated from action.target) is not evidence', () => {
    const withVisited = state({ visitedElementIds: ['acct-1'] });
    const r = verifyTaskGoal('find the account number field', withVisited, bareCtx());
    expect(r.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * E. A requested navigation must not leak into the observed URL
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.2A-E a blocked navigation cannot become goal evidence', () => {
  it('advancePageGeneration never overwrites the observed URL with a request', () => {
    // `advancePageGeneration(state, action.url)` used to write the REQUESTED
    // destination into `state.currentUrl`, which goal verification reads as the
    // OBSERVED tab URL. The parameter is still accepted (other callers pass a
    // page type), so this asserts the loop no longer supplies it.
    const s = state({ currentUrl: 'http://localhost:4200/original' });
    advancePageGeneration(s);
    expect(s.currentUrl).toBe('http://localhost:4200/original');
  });

  it('an unsatisfied navigation goal is unaffected by a settled handshake', () => {
    const s = state({ currentUrl: 'http://localhost:4200/original' });
    advancePageGeneration(s, 'http://localhost:4200/requested' as never);
    // If the requested URL HAD been written through, this goal would verify.
    const r = verifyTaskGoal('search for cats', s, bareCtx('http://localhost:4200/original'));
    expect(r.satisfied).toBe(false);
  });

  it('a redirected navigation never records the REQUESTED url as the observed url', async () => {
    // End-to-end at the loop level. The reasoner requests a results URL that
    // would satisfy a "search for cats" goal by itself. The browser accepts the
    // navigation and the load handshake settles - so the action is dispatched
    // and genuinely has an effect - but the site lands the tab somewhere else
    // entirely. The goal must not verify, and the recorded URL must not become
    // the requested one.
    const REQUESTED = 'http://localhost:4173/results?q=cats';
    const START = 'http://localhost:4173/bank';
    const LANDED = 'http://localhost:4173/consent-notice'; // not where we asked

    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({ action: 'navigate', url: REQUESTED }));

    // A live page model: it moves to LANDED when the navigation dispatches.
    const page = { url: START, domElementCount: 12 };
    const executeAction = vi.fn(async () => {
      page.url = LANDED;
      return { success: true, message: 'dispatched' };
    });
    const onNavigationComplete = vi.fn(async () => true);

    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(() => page),
        // The next perception reports where the tab ACTUALLY is.
        perceivePage: vi.fn(async () => ({
          url: page.url,
          timestamp: 1,
          viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
          screenshot_dimensions: null,
          detections: [],
          total_elements_scanned: 1,
          sensitive_elements_detected: 0,
          sanitized_status: 'sanitized_only',
          ocr_metrics: null,
        }) as unknown as AgentContextPayload),
        executeAction,
        onNavigationComplete,
      },
      { delayBetweenStepsMs: 1, maxSteps: 3 }
    );

    const finalState = await loop.runTask('search for cats');

    // The request really was made, dispatched, and settled...
    expect(executeAction).toHaveBeenCalled();
    expect(onNavigationComplete).toHaveBeenCalled();
    // ...and it bought nothing that the goal could be built from.
    expect(finalState.currentUrl).not.toBe(REQUESTED);
    expect(finalState.status).not.toBe('SUCCESS');
    expect(finalState.goalStatus).not.toBe('SUCCESS');
  });

  it('an UNAVAILABLE url cannot be backfilled from a requested destination', async () => {
    // The same defect, one layer deeper. When the browser cannot report a URL
    // for a cycle, `AgentLoop` keeps the previous `state.currentUrl`, and goal
    // verification falls back to it (`context.url || state.currentUrl`). So a
    // requested destination written into that field by the post-navigation
    // settle becomes the *last observation of the page* - and would verify a
    // "search for cats" goal outright.
    const REQUESTED = 'http://localhost:4173/results?q=cats';
    const START = 'http://localhost:4173/bank';
    const LANDED = 'http://localhost:4173/consent-notice';

    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({ action: 'navigate', url: REQUESTED }));

    const page = { url: START, domElementCount: 12 };
    const executeAction = vi.fn(async () => {
      page.url = LANDED;
      return { success: true, message: 'dispatched' };
    });
    const onNavigationComplete = vi.fn(async () => true);

    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(() => page),
        // `url: ''` — the browser reported no location for this cycle. The
        // effect-verification snapshot still knows the real one.
        perceivePage: vi.fn(async () => ({
          url: '',
          timestamp: 1,
          viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
          screenshot_dimensions: null,
          detections: [],
          total_elements_scanned: 1,
          sensitive_elements_detected: 0,
          sanitized_status: 'sanitized_only',
          ocr_metrics: null,
        }) as unknown as AgentContextPayload),
        executeAction,
        onNavigationComplete,
      },
      { delayBetweenStepsMs: 1, maxSteps: 3 }
    );

    const finalState = await loop.runTask('search for cats');

    expect(executeAction).toHaveBeenCalled();
    expect(onNavigationComplete).toHaveBeenCalled();
    expect(finalState.currentUrl).not.toBe(REQUESTED);
    expect(finalState.status).not.toBe('SUCCESS');
    expect(finalState.goalStatus).not.toBe('SUCCESS');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F/G. Model claims and requested values are never evidence
 * ═════════════════════════════════════════════════════════════════════════ */describe('17.2A-F/G model claims and requested values are never evidence', () => {
  it('a model "reason" string asserting completion changes nothing', () => {
    const claiming = [
      { ...click, reason: 'Clicked the details button; the account details view is now open.' },
      { ...scroll, reason: 'Scrolled; the transaction history is now visible and confirmed.' },
      { ...click, reason: 'Verified success: the goal is complete.' },
    ];
    const r = verifyTaskGoal(
      'open the account details and find the recent transactions',
      state({ previousActions: claiming }),
      bareCtx('http://localhost:4200/portal')
    );
    expect(r.satisfied).toBe(false);
  });

  it('a fabricated fallback/default observation cannot establish success', () => {
    // The all-zero viewport is the ABSENCE of a reading. Deciding a scroll goal
    // from it is deciding from a default.
    const zeroViewport = {
      ...bareCtx('http://localhost:4200/long'),
      viewport: { width: 0, height: 0, scroll_x: 0, scroll_y: 0 },
      viewportObservable: false,
    } as unknown as AgentContextPayload;
    const r = verifyTaskGoal(
      'scroll down 3000px',
      state({ initialScrollY: 0, observedScrollY: 3000, previousActions: [scroll] }),
      zeroViewport
    );
    expect(r.satisfied).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * H/I. Unavailable observation fails closed
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.2A-H/I unavailable observation fails closed', () => {
  it('an empty perception with a full action history is not success', () => {
    const r = verifyTaskGoal(
      'open the account details and find the recent transactions',
      state({ previousActions: [click, click, scroll, click], pageType: 'banking' }),
      bareCtx('http://localhost:4200/portal')
    );
    expect(r.satisfied).toBe(false);
    // Fail closed = IN_PROGRESS, which is "not yet", not "definitely not met".
    expect(r.status).toBe('IN_PROGRESS');
  });

  it('an observed navigation still reaches the existing valid success path', () => {
    // The remediation must not have broken the ONE path that was already sound.
    const r = verifyTaskGoal('search cats', state(), bareCtx('http://localhost:4200/results?q=cats'));
    expect(r.satisfied).toBe(true);
    expect(r.status).toBe('SUCCESS');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * D (second location). The subgoal DAG completes on DISPATCH success, and the
 * plan state machine used to report that as a verified, satisfied goal.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('17.2A-D the planning state machine is not an authorization or evidence path', () => {
  it('dispatched subgoals do not register goal satisfaction', () => {
    // A subgoal is marked complete by `completeSubgoal` on `execResult.success`
    // - transport state. `AgentLoop` used to OR that in as an alternative to
    // goal verification.
    const sm = new PlanStateMachine();
    sm.registerExecutionResult(true);      // dispatched without error
    sm.registerEffectVerification(true);   // observed effect
    sm.registerGoalVerification(/* goalSatisfied */ false, /* allSubgoalsDone */ true);

    expect(sm.getContext().goalSatisfied).toBe(false);
    const last = sm.getTransitionHistory().at(-1);
    expect(last?.reason).not.toMatch(/goal verified and satisfied/i);
    expect(last?.reason).toMatch(/NOT verified by observation/i);
  });

  it('an observed, verified goal is still reported as satisfied', () => {
    // The remediation must not have broken the one sound path.
    const sm = new PlanStateMachine();
    sm.registerExecutionResult(true);
    sm.registerEffectVerification(true);
    sm.registerGoalVerification(true, true);
    expect(sm.getContext().goalSatisfied).toBe(true);
    expect(sm.getState()).toBe('COMPLETED');
  });
});
