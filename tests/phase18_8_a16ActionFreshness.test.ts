/**
 * PHASE 18.8 / A16 — PRE-ACTION STATE FRESHNESS.
 *
 * The question every test here asks: before a CONSEQUENTIAL action is
 * dispatched, is the state it was grounded on still the state the device can
 * currently see? If the page moved, was replaced, or simply was not observed at
 * dispatch time, the action must not reach the executor at all.
 *
 * Two layers:
 *   1. the pure freshness contract (verdict, code, resolution, user copy) —
 *      deterministic and local;
 *   2. the real AgentLoop, driven through synthetic perception/execution hosts,
 *      where the guarantee is observed as behaviour (how many actions reached
 *      the executor) rather than asserted from the contract's own words.
 *
 * Nothing here weakens an existing gate: grounding, M5, the security critic,
 * privacy, risk/confirmation, the A14 commit gate, effect verification and goal
 * verification all still run. Freshness can only ever REMOVE a dispatch, and
 * FRESH grants nothing — the A14 suite covers what happens immediately after.
 */
import { describe, it, expect, vi } from 'vitest';

import { AgentLoop } from '../extension/src/agent/agentLoop';
import type { BrowserAction } from '../extension/src/agent/actionTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { PreActionSnapshot } from '../extension/src/agent/effectVerifier';
import { isTerminalTaskStatus, userFacingMessageForStatus } from '../extension/src/agent/agentState';
import { projectAgentOutput } from '../extension/src/agent/agentOutput';
import {
  assessActionFreshness,
  freshnessStopMessage,
  stopsTheRun,
  type FreshnessState,
} from '../extension/src/agent/actionFreshness';

const NOW = 1_760_000_000_000;
/** The URL the action was planned on. */
const A = 'https://bank.example.com/transfer';
/** A different view: the page moved out from under the plan. */
const B = 'https://bank.example.com/other';
/**
 * The task that makes the fixture click a TRANSFER-class commit. Its wording is
 * deliberately neutral to every intent-domain rule, so these tests exercise the
 * freshness gate rather than the intent boundary (which has its own suites).
 */
const TASK = 'Proceed with the transfer to savings';

// ── 1. The contract: when is a view still the view that was planned on? ──────

describe('A16 — the freshness verdict', () => {
  it('1.1 a non-consequential action is never stopped by freshness', () => {
    // Freshness adds nothing to the gates a non-mutating action already passes,
    // and must not manufacture a refusal out of a page that legitimately moved.
    for (const input of [
      { consequential: false, observed: false, plannedUrl: A, observedUrl: null },
      { consequential: false, observed: true, plannedGeneration: 1, currentGeneration: 9 },
      { consequential: false, observed: true, differentDocument: true },
      { consequential: false, observed: true, plannedUrl: A, observedUrl: B },
    ]) {
      const a = assessActionFreshness(input);
      expect(a.state).toBe('FRESH');
      expect(a.code).toBe('NOT_CONSEQUENTIAL');
      expect(a.resolution).toBe('PROCEED');
    }
  });

  it('1.2 two observed readings that disagree about the document are a CONFLICT, not a refresh', () => {
    const replaced = assessActionFreshness({
      consequential: true,
      observed: true,
      differentDocument: true,
      plannedUrl: A,
      observedUrl: A,
    });
    expect(replaced.state).toBe('CONFLICT');
    expect(replaced.code).toBe('DOCUMENT_REPLACED');
    expect(replaced.resolution).toBe('STOP_AND_ASK');
    expect(replaced.mayDispatchStaleView).toBe(false);

    const moved = assessActionFreshness({ consequential: true, observed: true, plannedUrl: A, observedUrl: B });
    expect(moved.state).toBe('CONFLICT');
    expect(moved.code).toBe('URL_CHANGED_SINCE_PLANNING');
    expect(moved.resolution).toBe('STOP_AND_ASK');
    expect(moved.mayDispatchStaleView).toBe(false);
  });

  it('1.3 a fragment, query string or trailing slash alone is not a move', () => {
    for (const observed of [A, `${A}/`, `${A}#confirm`, `${A}?step=2`, `${A.toUpperCase()}/?x=1#y`]) {
      const a = assessActionFreshness({ consequential: true, observed: true, plannedUrl: A, observedUrl: observed });
      expect(a.state, observed).toBe('FRESH');
      expect(a.code).toBe('SAME_GENERATION');
    }
  });

  it('1.4 an observed conflict outranks generation bookkeeping', () => {
    // No generation arithmetic may rescue an action whose page has moved.
    const a = assessActionFreshness({
      consequential: true,
      observed: true,
      plannedUrl: A,
      observedUrl: B,
      plannedGeneration: 3,
      currentGeneration: 3,
    });
    expect(a.state).toBe('CONFLICT');
    expect(a.code).toBe('URL_CHANGED_SINCE_PLANNING');
  });

  it('1.5 an action planned on an older generation is STALE and must be re-planned', () => {
    const a = assessActionFreshness({
      consequential: true,
      observed: true,
      plannedUrl: A,
      observedUrl: A,
      plannedGeneration: 2,
      currentGeneration: 3,
    });
    expect(a.state).toBe('STALE');
    expect(a.code).toBe('ACTION_GENERATION_OLDER');
    expect(a.resolution).toBe('RE_PERCEIVE');
    expect(a.mayDispatchStaleView).toBe(false);
    expect(a.record?.plannedGeneration).toBe(2);
    expect(a.record?.currentGeneration).toBe(3);
    expect(a.record?.observed).toBe(true);
  });

  it('1.6 an action with no DECLARED generation is not "stale" — grounding owns that basis', () => {
    const a = assessActionFreshness({
      consequential: true,
      observed: true,
      plannedGeneration: null,
      currentGeneration: 4,
      plannedUrl: A,
      observedUrl: A,
    });
    expect(a.state).toBe('FRESH');
    expect(a.code).toBe('SAME_GENERATION');
    expect(a.resolution).toBe('PROCEED');
  });

  it('1.7 a missing observation is never rounded up to FRESH', () => {
    const none = assessActionFreshness({
      consequential: true,
      observed: false,
      plannedUrl: A,
      observedUrl: null,
      currentGeneration: 1,
    });
    expect(none.state).toBe('REFRESH_REQUIRED');
    expect(none.code).toBe('NO_CURRENT_OBSERVATION');
    expect(none.resolution).toBe('RE_PERCEIVE');
    expect(none.record?.observed).toBe(false);

    const failed = assessActionFreshness({
      consequential: true,
      observed: false,
      observationFailed: true,
      plannedUrl: A,
      observedUrl: null,
      currentGeneration: 1,
    });
    expect(failed.state).toBe('REFRESH_REQUIRED');
    expect(failed.code).toBe('OBSERVATION_FAILED');
    expect(failed.resolution).toBe('RE_PERCEIVE');
    expect(failed.mayDispatchStaleView).toBe(false);
  });

  it('1.8 no state information at all is UNKNOWN — the device stops rather than guessing', () => {
    const a = assessActionFreshness({
      consequential: true,
      observed: true,
      plannedUrl: null,
      observedUrl: null,
      plannedGeneration: null,
      currentGeneration: null,
    });
    expect(a.state).toBe('UNKNOWN');
    expect(a.code).toBe('NO_CURRENT_OBSERVATION');
    expect(a.resolution).toBe('STOP_AND_ASK');
    expect(a.mayDispatchStaleView).toBe(false);
  });

  it('1.9 only FRESH ever grants mayDispatchStaleView, and it grants no authority', () => {
    const cases: Array<[FreshnessState, boolean]> = [
      ['FRESH', true],
      ['STALE', false],
      ['REFRESH_REQUIRED', false],
      ['CONFLICT', false],
      ['UNKNOWN', false],
    ];
    const reached = new Set<FreshnessState>();
    const inputs = [
      { consequential: true, observed: true, plannedUrl: A, observedUrl: A },
      { consequential: true, observed: true, plannedUrl: A, observedUrl: A, plannedGeneration: 1, currentGeneration: 2 },
      { consequential: true, observed: false, plannedUrl: A },
      { consequential: true, observed: true, plannedUrl: A, observedUrl: B },
      { consequential: true, observed: true, plannedUrl: null, observedUrl: null },
    ];
    inputs.forEach((input, i) => {
      const a = assessActionFreshness(input);
      reached.add(a.state);
      expect(a.mayDispatchStaleView, cases[i]![0]).toBe(cases[i]![1]);
    });
    // Every verdict the contract can produce is exercised above.
    expect([...reached].sort()).toEqual(['CONFLICT', 'FRESH', 'REFRESH_REQUIRED', 'STALE', 'UNKNOWN']);
  });

  it('1.10 only CONFLICT and UNKNOWN end the run; STALE and REFRESH_REQUIRED are refreshes', () => {
    expect(stopsTheRun('CONFLICT')).toBe(true);
    expect(stopsTheRun('UNKNOWN')).toBe(true);
    expect(stopsTheRun('STALE')).toBe(false);
    expect(stopsTheRun('REFRESH_REQUIRED')).toBe(false);
    expect(stopsTheRun('FRESH')).toBe(false);
  });

  it('1.11 the user-facing sentence for a freshness stop carries no internal code and claims no failure', () => {
    const conflict = freshnessStopMessage('CONFLICT')!;
    expect(conflict).toMatch(/page moved/i);
    expect(conflict).toMatch(/stopped without acting/i);

    const unknown = freshnessStopMessage('UNKNOWN')!;
    expect(unknown).toMatch(/could not tell/i);
    expect(unknown).toMatch(/stopped without acting/i);

    for (const s of ['CONFLICT', 'UNKNOWN'] as const) {
      const msg = freshnessStopMessage(s)!;
      expect(msg).not.toMatch(/FRESHNESS_|DOCUMENT_REPLACED|URL_CHANGED|_ERROR|CONFLICT|UNKNOWN/);
      expect(msg).not.toMatch(/\bfail|\berror|\bsucceed|completed/i);
    }

    // A refresh is not a stop: there is no sentence to show.
    expect(freshnessStopMessage('FRESH')).toBeNull();
    expect(freshnessStopMessage('STALE')).toBeNull();
    expect(freshnessStopMessage('REFRESH_REQUIRED')).toBeNull();
  });
});

// ── 2. The loop: a moved view never reaches the executor ─────────────────────

function det(id: string, label: string) {
  return {
    id,
    type: 'button' as const,
    selector: `#${id}`,
    label,
    confidence: 0.95,
    bbox: { x: 10, y: 10, width: 120, height: 30 },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
  };
}

function ctx(detections = [det('btn', 'Confirm'), det('btn2', 'Confirm again')]): AgentContextPayload {
  return {
    url: A,
    timestamp: NOW,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    detections,
    total_elements_scanned: detections.length,
    sensitive_elements_detected: 0,
    ocr_metrics: null,
  } as unknown as AgentContextPayload;
}

function pageWith(generation: number, url = A) {
  return {
    context: { ...(ctx() as any), url },
    worldModel: {
      id: `wm-${generation}`,
      page: { url, title: 'Transfer', pageGeneration: generation, pageType: 'app', totalDomElements: 40 },
      entities: [],
      textRegions: [],
      ocrRegions: [],
      visualRegions: [],
      privacyFindings: [],
    },
  } as never;
}

interface Harness {
  loop: AgentLoop;
  executed: BrowserAction[];
  infos: string[];
  state: () => any;
  run: (task: string) => Promise<unknown>;
}

/**
 * The REAL host always has the pre-action observation channel, and it reads the
 * live tab. This harness models that: `observedUrl` is what the channel REPORTS,
 * and `failObservation` makes the channel exist but return nothing — the two
 * real shapes A16 has to tell apart.
 */
function makeHarness(options: {
  actions: BrowserAction[];
  /** What the pre-dispatch observation reports. Defaults to the planned URL. */
  observedUrl?: string | null;
  /**
   * Per-reading URLs, in call order (pre1, post1, pre2, post2, ...). Use this
   * when the view must move BETWEEN steps rather than before the first one.
   */
  observedUrls?: Array<string | null>;
  /** The channel exists but cannot read the page. */
  failObservation?: boolean;
  /** The generation the live page reports. Defaults to the perception count. */
  generation?: number;
  maxSteps?: number;
  maxRetries?: number;
}): Harness {
  const executed: BrowserAction[] = [];
  const infos: string[] = [];
  let perceptions = 0;
  let readings = 0;
  const queue = [...options.actions];

  // The freshness refusal is logged at `warn`, the surrounding pipeline at
  // `info`. Both are captured so the trace assertions can tell them apart.
  const capture = (...args: unknown[]) => {
    infos.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  vi.spyOn(console, 'info').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);

  const loop = new AgentLoop(
    {
      name: 'A16FixtureProvider',
      requestAction: async () => (queue.length > 1 ? queue.shift()! : queue[0]!),
      reviewAction: async () => ({ safe: true, reason: 'fixture' }),
      registerFailure: vi.fn(),
      resetEscalation: vi.fn(),
    } as never,
    {
      perceivePage: async () => {
        perceptions += 1;
        return pageWith(options.generation ?? perceptions + 1);
      },
      executeAction: async (action) => {
        executed.push(action as BrowserAction);
        return { success: true };
      },
      getEffectSnapshot: async (): Promise<PreActionSnapshot | null> => {
        if (options.failObservation) return null;
        const reading = options.observedUrls?.[readings++];
        return {
          url: reading ?? options.observedUrl ?? A,
          scrollX: 0,
          scrollY: 0,
          domElementCount: 40,
          openModalsCount: 0,
          targetValueLength: 0,
          activeElementSelector: '',
          timestamp: NOW,
        };
      },
      onStepProgress: () => {},
    },
    {
      maxSteps: options.maxSteps ?? 4,
      maxRetries: options.maxRetries ?? 3,
      delayBetweenStepsMs: 1,
    }
  );

  return {
    loop,
    executed,
    infos,
    state: () => loop.getState() as any,
    run: (task: string) => loop.runTask(task),
  };
}

describe('A16 — a consequential action is not dispatched against a view nobody is looking at', () => {
  it('2.1 the page moved before dispatch: STOP with no dispatch at all', async () => {
    const h = makeHarness({
      actions: [{ action: 'click', target: 'btn', reason: 'confirm the step' }],
      observedUrl: B,
    });
    await h.run(TASK);

    // The whole point: nothing reached the executor.
    expect(h.executed.length).toBe(0);

    const state = h.state();
    expect(state.status).toBe('FRESHNESS_UNVERIFIED');
    expect(isTerminalTaskStatus('FRESHNESS_UNVERIFIED')).toBe(true);
    expect(state.actionFreshness?.state).toBe('CONFLICT');
    expect(state.actionFreshness?.code).toBe('URL_CHANGED_SINCE_PLANNING');
    expect(state.actionFreshness?.resolution).toBe('STOP_AND_ASK');
    expect(state.lastFailure?.category).toBe('PAGE_CHANGED');
    expect(state.lastFailure?.reason).toContain('FRESHNESS_CONFLICT');
    // The run reason is the fixed user sentence, never an internal code.
    expect(state.reason).toBe(freshnessStopMessage('CONFLICT'));
    expect(h.infos.join('\n')).toContain('dispatch blocked — state freshness not established');
  });

  it('2.2 the stop is terminal: later proposals in the same run never dispatch either', async () => {
    const h = makeHarness({
      actions: [
        { action: 'click', target: 'btn', reason: 'confirm the step' },
        { action: 'click', target: 'btn2', reason: 'confirm the step' },
      ],
      observedUrl: B,
    });
    await h.run(TASK);

    expect(h.executed.length).toBe(0);
    expect(h.state().status).toBe('FRESHNESS_UNVERIFIED');
    expect(h.state().status).not.toBe('COMMIT_UNKNOWN');
  });

  it('2.3 the freshness gate runs BEFORE the commit gate, and cannot be bypassed by an open commit', async () => {
    // Step 1 commits unverifiably (A14 opens a commit). Step 2's view has moved.
    // Both gates would refuse; the freshness verdict must be what the run ends
    // on, because acting on a view nobody looked at is the more basic refusal.
    const h = makeHarness({
      actions: [
        { action: 'click', target: 'btn', reason: 'confirm the step' },
        { action: 'click', target: 'btn2', reason: 'confirm the step' },
      ],
      // Readings: pre1, post1, pre2, post2. Step 1 sees an unchanged view (so its
      // commit stays open) and only step 2's view has moved.
      observedUrls: [A, A, B, B],
      maxSteps: 3,
    });
    await h.run(TASK);

    // Only the observation channel changed: the first action still dispatches.
    expect(h.executed.length).toBe(1);
    expect(h.state().commitRecords.length).toBe(1);
    expect(h.state().commitRecords[0].unresolved).toBe(true);
    // The freshness verdict is what ended the run, so the commit gate was never
    // the gate that refused: ordering is proven, not assumed.
    expect(h.state().status).toBe('FRESHNESS_UNVERIFIED');
    expect(h.state().actionFreshness?.state).toBe('CONFLICT');
    expect(h.infos.join('\n')).toContain('dispatch blocked — state freshness not established');
    expect(h.infos.join('\n')).not.toContain('dispatch blocked — commit unresolved');
  });

  it('2.4 an observation channel that cannot read the page is a refresh, never a dispatch', async () => {
    const h = makeHarness({
      actions: [{ action: 'click', target: 'btn', reason: 'confirm the step' }],
      failObservation: true,
      maxSteps: 3,
      maxRetries: 1,
    });
    await h.run(TASK);

    expect(h.executed.length).toBe(0);
    const state = h.state();
    // The channel existed and failed, and the refresh was requested and bounded.
    expect(state.actionFreshness?.state).toBe('REFRESH_REQUIRED');
    expect(state.actionFreshness?.code).toBe('OBSERVATION_FAILED');
    expect(h.infos.join('\n')).toContain('action freshness requires re-observation');
    // Bounded: the run ends truthfully instead of dispatching on a view the
    // device has just said it cannot see.
    expect(['FAILED', 'FRESHNESS_UNVERIFIED']).toContain(state.status);
    expect(state.reason).toMatch(/without acting|freshly/);
  });

  it('2.5 a FRESH view still faces every gate after it — freshness grants nothing', async () => {
    const h = makeHarness({
      actions: [{ action: 'click', target: 'btn', reason: 'confirm the step' }],
    });
    await h.run(TASK);

    // Same view → A16 PROCEED → the A14 commit gate is what stops the run, and
    // the action did dispatch exactly once.
    expect(h.executed.length).toBe(1);
    expect(h.state().status).toBe('COMMIT_UNKNOWN');
    expect(h.state().actionFreshness?.state).toBe('FRESH');
    expect(h.state().actionFreshness?.code).toBe('SAME_GENERATION');
  });

  it('2.6 a non-consequential action is unaffected by a moved view', async () => {
    const h = makeHarness({
      actions: [{ action: 'scroll', direction: 'down', amount: 200, reason: 'read on' }],
      observedUrl: B,
      maxSteps: 1,
    });
    await h.run(TASK);

    // A16 must not turn a legitimate scroll into a stop: no commit, no refusal.
    expect(h.executed.length).toBe(1);
    expect(h.state().status).not.toBe('FRESHNESS_UNVERIFIED');
  });

  it('2.8 the generation the action was grounded against is recorded, so the comparison has a real basis', async () => {
    const h = makeHarness({
      actions: [{ action: 'click', target: 'btn', reason: 'confirm the step' }],
      maxSteps: 1,
    });
    await h.run(TASK);

    // Read the value AT THE GATE, from the trace the gate itself emits: not
    // null, not a placeholder, and equal to the generation the page reports.
    // An unrecorded basis would silently disable the STALE branch entirely.
    const assessed = h.infos.find((l) => l.includes('action freshness assessed')) ?? '';
    expect(assessed).toContain('"plannedGeneration":2');
    expect(assessed).toContain('"currentGeneration":2');
    expect(assessed).toContain('"state":"FRESH"');
    // A recorded generation must be a NUMBER, never the null that would make the
    // comparison vacuous.
    expect(/"plannedGeneration":null/.test(assessed)).toBe(false);
  });

  it('2.7 the stop is projected as a typed terminal outcome the user can act on', async () => {
    const h = makeHarness({
      actions: [{ action: 'click', target: 'btn', reason: 'confirm the step' }],
      observedUrl: B,
    });
    await h.run(TASK);

    const output = projectAgentOutput(h.state()) as any;
    expect(output.terminal.reason).toBe('FRESHNESS_UNVERIFIED');
    expect(output.terminal.outcome).toBe('UNANSWERED');
    expect(output.terminal.headline).toBe('Stopped: the page was no longer the one that step was planned on.');
    expect(output.finalResult.kind).toBe('FRESHNESS_UNVERIFIED');
    expect(output.finalResult.headline).toBe('Page changed before acting');
    expect(output.finalResult.body).toBe(freshnessStopMessage('CONFLICT'));
    expect(output.finalResult.body).not.toMatch(/FRESHNESS_|CONFLICT|URL_CHANGED|DOCUMENT_REPLACED/);
    expect(output.terminal.headline).not.toMatch(/FRESHNESS_|CONFLICT/);

    const runMessage = userFacingMessageForStatus('FRESHNESS_UNVERIFIED');
    expect(runMessage).toMatch(/page changed/i);
    expect(runMessage).not.toMatch(/\bfail|\bsucceed|completed/i);
  });
});
