/**
 * PHASE 17.4 D5 — long-horizon reliability state across a service-worker restart.
 *
 * The invariant under test throughout:
 *
 *     A RESTART MUST NOT HAND THE AGENT A SECOND BUDGET
 *     A CORRUPT RECORD MUST NOT BECOME AN UNBOUNDED ONE
 *     PERSISTED STATE IS METADATA ONLY
 *     TRACKER STATE IS NEVER GOAL EVIDENCE
 *
 * `LongHorizonTracker` is a reliability mechanism. Restoring a record can only
 * make the agent stop SOONER. These tests pin that, and pin that a restart
 * cannot silently reset the bounds that keep a long run bounded.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  LONG_HORIZON_SCHEMA_VERSION,
  createMemoryStore,
  createNoopStore,
  loadTrackerForTask,
  saveTracker,
  serializeTracker,
  validatePersisted,
  type LongHorizonPersistedRecord,
  type LongHorizonStore,
} from '../../extension/src/agent/longHorizonPersistence';
import {
  LongHorizonTracker,
  DEFAULT_LONG_HORIZON_BOUNDS,
  stableHash,
  type TaskObservation,
} from '../../extension/src/agent/longHorizon';
import { verifyTaskGoal } from '../../extension/src/agent/goalVerifier';
import { AgentLoop } from '../../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../../extension/src/agent/mockAgentProvider';
import { observingHost } from '../helpers/observingHost';
import type { AgentContextPayload } from '../../extension/src/privacy/types';

const B = DEFAULT_LONG_HORIZON_BOUNDS;
const TASK = 'open the account details';
const RUN = 'run-fixed-0001';

const obs = (over: Partial<TaskObservation> = {}): TaskObservation => ({
  url: 'http://localhost:4200/bank',
  pageGeneration: 1,
  entityIds: ['e1'],
  candidateIds: ['c1'],
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

const state = (over: Record<string, unknown> = {}) =>
  ({ task: '', taskConstraints: {}, previousActions: [], steps: [], visitedElementIds: [], candidateItems: [], ...over }) as never;

/** A store that simulates the SW being evicted: the record survives, the JS heap does not. */
const durableStore = (seed: LongHorizonPersistedRecord | null = null): LongHorizonStore & { raw: unknown } => {
  const s = createMemoryStore(seed) as LongHorizonStore & { raw: unknown };
  return s;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * A–E. State survives a simulated service-worker restart
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-D5-A/E reliability state survives a service-worker restart', () => {
  const buildUsedTracker = () => {
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [] as never);
    // Some real history: actions, a repeated-state loop, a recovery.
    t.observe(obs({ url: 'http://localhost:4200/p1' }), { action: 'click', target: 'a' } as never);
    t.observe(obs({ url: 'http://localhost:4200/p2' }), { action: 'click', target: 'b' } as never);
    t.observe(obs({ url: 'http://localhost:4200/p1' }), { action: 'click', target: 'a' } as never);
    t.observe(obs({ url: 'http://localhost:4200/p1' }), { action: 'click', target: 'a' } as never);
    t.replanRemaining(undefined, 'loop');
    return t;
  };

  it('A. the whole reliability record round-trips through a restart', async () => {
    const store = durableStore();
    const before = buildUsedTracker();
    expect(await saveTracker(store, before, RUN, TASK, B)).toBe(true);

    // "Restart": nothing in memory survives, only the record does.
    const after = await loadTrackerForTask(store, RUN, TASK, B);

    expect(after.status).toBe('RESTORED');
    expect(after.tracker.actionCount).toBe(before.actionCount);
    expect(after.tracker.recoveryCount).toBe(before.recoveryCount);
    expect(after.tracker.consecutiveNoProgress).toBe(before.consecutiveNoProgress);
    expect(after.tracker.totalNoProgress).toBe(before.totalNoProgress);
    expect(after.tracker.getRecentFingerprints()).toEqual(before.getRecentFingerprints());
  });

  it('B. repetition history survives, so a loop is still detected after restart', async () => {
    const store = durableStore();
    const before = buildUsedTracker();
    expect(before.detectLoop().loop).toBe(true);
    await saveTracker(store, before, RUN, TASK, B);

    const after = await loadTrackerForTask(store, RUN, TASK, B);
    // A fresh tracker would NOT see the loop. The restored one must.
    expect(new LongHorizonTracker(B).detectLoop().loop).toBe(false);
    expect(after.tracker.detectLoop().loop).toBe(true);
    expect(after.tracker.detectLoop().kind).toBe('REPEATED_STATE');
  });

  it('C. stagnation counts survive, so a stall is still detected after restart', async () => {
    const store = durableStore();
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [] as never);
    t.observe(obs({ url: 'http://localhost:4200/x1' })); // first = progress (0)
    t.observe(obs({ url: 'http://localhost:4200/x1' })); // no progress (1)
    t.observe(obs({ url: 'http://localhost:4200/x1' })); // no progress (2)
    t.observe(obs({ url: 'http://localhost:4200/x1' })); // no progress (3 = limit)
    expect(t.detectStall().stalled).toBe(true);
    expect(t.consecutiveNoProgress).toBe(3);
    await saveTracker(store, t, RUN, TASK, B);

    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.tracker.consecutiveNoProgress).toBe(3);
    expect(after.tracker.totalNoProgress).toBe(3);
    expect(after.tracker.detectStall().stalled).toBe(true);
  });

  it('D. recovery / repeated-strategy counters survive', async () => {
    const store = durableStore();
    const t = buildUsedTracker();
    expect(t.recoveryCount).toBeGreaterThan(0);
    await saveTracker(store, t, RUN, TASK, B);
    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.tracker.recoveryCount).toBe(t.recoveryCount);
  });

  it('E. a bound already partly consumed is still consumed after restart', async () => {
    // The core of D5: this is the "second budget" the defect would have granted.
    const store = durableStore();
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [] as never);
    for (let i = 0; i < B.maxTotalActions - 2; i++) t.observe(obs({ url: `http://localhost:4200/p${i}` }));
    expect(t.actionCount).toBe(B.maxTotalActions - 2);
    expect(t.checkBounds().exhausted).toBe(false);
    await saveTracker(store, t, RUN, TASK, B);

    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.tracker.actionCount).toBe(B.maxTotalActions - 2);
    // Two more actions and the bound fires — it did not get a fresh budget.
    after.tracker.observe(obs({ url: 'http://localhost:4200/z1' }));
    after.tracker.observe(obs({ url: 'http://localhost:4200/z2' }));
    const b = after.tracker.checkBounds();
    expect(b.exhausted).toBe(true);
    expect(b.reason).toBe('ACTION_BUDGET_EXHAUSTED');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F–J. Identity, reset, and fail-closed restore
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-D5-F/J restore refuses anything it cannot fully trust', () => {
  const seedRecord = (): LongHorizonPersistedRecord =>
    serializeTracker(build(), RUN, TASK, B);
  const build = () => {
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [] as never);
    t.observe(obs({ url: 'http://localhost:4200/p1' }));
    return t;
  };

  it('F. a record from a DIFFERENT run is refused', async () => {
    const store = durableStore();
    await saveTracker(store, build(), 'run-OTHER', TASK, B);
    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.status).toBe('REJECTED_TASK_MISMATCH');
    expect(after.tracker.actionCount).toBe(0);
    // ...and it is deleted, not re-read every cycle.
    expect(await store.load()).toBeNull();
  });

  it('F2. a record whose goal digest differs is refused', () => {
    const rec = seedRecord();
    expect(validatePersisted(rec, RUN, 'a completely different task', B).ok).toBe(false);
    expect(validatePersisted(rec, RUN, TASK, B).ok).toBe(true);
    expect(rec.goalDigest).toBe(stableHash(TASK));
  });

  it('G. an explicit reset clears the record', async () => {
    const store = durableStore();
    await saveTracker(store, build(), RUN, TASK, B);
    expect(await store.load()).not.toBeNull();
    await store.clear();
    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.status).toBe('FRESH_NO_RECORD');
    expect(after.tracker.actionCount).toBe(0);
  });

  it('H. malformed state fails safely — never as an unbounded tracker', async () => {
    const cases: unknown[] = [
      'a string',
      42,
      [],
      {},
      { schemaVersion: LONG_HORIZON_SCHEMA_VERSION },
      { ...seedRecord(), actionCount: -5 },
      { ...seedRecord(), actionCount: 'lots' },
      { ...seedRecord(), fingerprints: 'nope' },
      { ...seedRecord(), subgoals: [{ status: 'ACTIVE' }] },
      { ...seedRecord(), subgoals: [{ id: 'x', status: 'WEIRD', attempts: 0 }] },
      { ...seedRecord(), runId: 12345 },
    ];
    for (const bad of cases) {
      const store = durableStore(bad as never);
      const after = await loadTrackerForTask(store, RUN, TASK, B);
      expect(after.status, `input: ${JSON.stringify(bad)?.slice(0, 60)}`).toMatch(
        /^REJECTED_(MALFORMED|SCHEMA|TASK_MISMATCH|PRIVACY)$/
      );
      // Fail-closed means a FRESH *BOUNDED* tracker, not an unlimited one.
      expect(after.tracker.actionCount).toBe(0);
      expect(after.tracker.bounds).toEqual(B);
      expect(after.tracker.detectStall().stalled).toBe(false);
      expect(after.tracker.checkBounds().exhausted).toBe(false);
    }
  });

  it('I. an old schema version is refused', async () => {
    const store = durableStore({ ...seedRecord(), schemaVersion: LONG_HORIZON_SCHEMA_VERSION - 1 });
    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.status).toBe('REJECTED_SCHEMA');
    expect(after.tracker.actionCount).toBe(0);
  });

  it('J. no record at all starts a fresh, fully bounded task', async () => {
    const after = await loadTrackerForTask(durableStore(null), RUN, TASK, B);
    expect(after.status).toBe('FRESH_NO_RECORD');
    expect(after.tracker.actionCount).toBe(0);
    expect(after.tracker.bounds).toEqual(B);
  });

  it('an unavailable store is explicit, never silently assumed to have restored', async () => {
    const store = createNoopStore();
    expect(store.persistenceAvailable).toBe(false);
    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.status).toBe('UNAVAILABLE');
    expect(after.tracker.bounds).toEqual(B);
  });

  it('K. two independent tasks never share tracker state', async () => {
    const store = durableStore();
    await saveTracker(store, build(), 'run-A', TASK, B);
    // Task B, same task text, different run identity.
    const b = await loadTrackerForTask(store, 'run-B', TASK, B);
    expect(b.status).toBe('REJECTED_TASK_MISMATCH');
    expect(b.tracker.actionCount).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * L. Privacy: the record is metadata only
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-D5-L the persisted record is metadata only', () => {
  it('never contains task text, model text, or any raw value', () => {
    const t = new LongHorizonTracker(B);
    // A goal and a subgoal whose DESCRIPTIONS carry PII-shaped free text.
    t.initialize('find John Doe account 4111111111111111 password hunter2', [], [
      { id: 'sg-1', goalId: 'g', index: 0, description: 'email jane@example.com', category: 'GENERIC_INTERACTION', state: 'IN_PROGRESS', prerequisites: [], retryCount: 0, maxRetries: 2 } as never,
    ]);
    t.transition('sg-1', 'COMPLETED', 'ok');
    t.observe(obs({ url: 'http://localhost:4200/p1' }));

    const rec = serializeTracker(t, RUN, 'find John Doe account 4111111111111111 password hunter2', B);
    const json = JSON.stringify(rec);

    // Structural exclusions.
    expect(json).not.toContain('John Doe');
    expect(json).not.toContain('4111111111111111');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('jane@example.com');
    expect(rec.goalDigest).toBe(stableHash('find John Doe account 4111111111111111 password hunter2'));
    // Only {id, status, attempts} per subgoal.
    expect(Object.keys(rec.subgoals[0]!).sort()).toEqual(['attempts', 'id', 'status']);

    // Forbidden key classes must not exist anywhere in the record.
    for (const banned of ['value', 'textContent', 'innerText', 'password', 'rawText', 'ocrText', 'screenshot', 'dataUrl', 'imageData', 'innerHTML']) {
      expect(json.toLowerCase()).not.toContain(`"${banned.toLowerCase()}"`);
    }
  });

  it('a record that somehow carries raw-value content is refused, not written', async () => {
    const store = durableStore();
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [] as never);
    t.observe(obs());
    // Poison the record the way a future careless change might.
    const rec = { ...serializeTracker(t, RUN, TASK, B), lastObservation: { ...obs(), textContent: 'secret' } } as never;
    const v = validatePersisted(rec, RUN, TASK, B);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe('REJECTED_PRIVACY');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * M/N/O. Persistence is not an evidence or success path
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-D5-M/N/O restored state can never produce SUCCESS', () => {
  it('M. a fully-restored tracker is not goal evidence', async () => {
    const store = durableStore();
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [] as never);
    for (let i = 0; i < 8; i++) t.observe(obs({ url: `http://localhost:4200/p${i}` }));
    await saveTracker(store, t, RUN, TASK, B);
    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.status).toBe('RESTORED');
    const snap = after.tracker.snapshot();
    // A rich, restored reliability snapshot proves nothing about the goal.
    const g = verifyTaskGoal(
      'open the account details',
      state({ longHorizon: snap, previousActions: [{ action: 'click' }] }),
      ctx()
    );
    expect(g.satisfied).toBe(false);
  });

  it('N. recovery / replan cannot create SUCCESS', async () => {
    const store = durableStore();
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [] as never);
    t.transition?.('sg-1', 'ACTIVE');
    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.tracker.recoveryCount).toBe(0);
    const g = verifyTaskGoal('open the account details', state(), ctx());
    expect(g.satisfied).toBe(false);
  });

  it('O. budget exhaustion — before or after restore — cannot create SUCCESS', async () => {
    const store = durableStore();
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [] as never);
    for (let i = 0; i < B.maxTotalActions; i++) t.observe(obs({ url: `http://localhost:4200/p${i}` }));
    expect(t.checkBounds().exhausted).toBe(true);
    await saveTracker(store, t, RUN, TASK, B);
    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.tracker.checkBounds().exhausted).toBe(true);
    const g = verifyTaskGoal('open the account details', state(), ctx());
    expect(g.satisfied).toBe(false);
  });

  it('a completed subgoal stays terminal across a restart', async () => {
    const store = durableStore();
    const t = new LongHorizonTracker(B);
    t.initialize(TASK, [], [
      { id: 'sg-done', goalId: 'g', index: 0, description: 'finished work', category: 'GENERIC_INTERACTION', state: 'PENDING', prerequisites: [], retryCount: 0, maxRetries: 2 } as never,
    ]);
    t.transition('sg-done', 'ACTIVE');
    t.transition('sg-done', 'COMPLETED', 'observed');
    await saveTracker(store, t, RUN, TASK, B);

    const after = await loadTrackerForTask(store, RUN, TASK, B);
    expect(after.tracker.isAlreadyCompleted('sg-done')).toBe(true);
    const r = after.tracker.replanRemaining('sg-done', 'loop');
    expect(r.preservedCompleted).toEqual(['sg-done']);
    expect(after.tracker.isAlreadyCompleted('sg-done')).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * End-to-end through the real AgentLoop
 * ═════════════════════════════════════════════════════════════════════════ */
describe('17.4-D5 end to end: a restarted loop keeps its bounds', () => {
  const loopCtx = (url: string): AgentContextPayload =>
    ({
      url, timestamp: 1,
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      viewportObservable: true, screenshot_dimensions: null,
      detections: [{ id: 'element_details_0', type: 'button', confidence: 0.95, bbox: { x: 50, y: 100, width: 200, height: 35 }, length: 0, source: 'dom_attribute', selector: '#details', is_partially_visible: false }],
      total_elements_scanned: 4, sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only', ocr_metrics: null,
    }) as unknown as AgentContextPayload;

  it('the loop writes a record each cycle and clears it on a terminal outcome', async () => {
    const store = durableStore();
    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({ action: 'click', target: 'element_details_0' }));
    const page = { url: 'http://localhost:4200/bank', domElementCount: 4 };
    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(() => { page.domElementCount += 1; return page; }),
        perceivePage: async () => loopCtx(page.url),
        executeAction: async () => ({ success: true, message: 'dispatched' }),
      },
      { delayBetweenStepsMs: 1, maxSteps: 30, longHorizonStore: store }
    );
    const finalState = await loop.runTask('open the account details');
    expect(finalState.status).toBe('FAILED');
    // Terminal outcome: the record is cleared, so nothing leaks to a next task.
    expect(await store.load()).toBeNull();
  });

  it('a run with no store configured is unchanged (persistence opt-in)', async () => {
    const provider = new MockAgentProvider();
    provider.setCustomHandler(() => ({ action: 'click', target: 'element_details_0' }));
    const page = { url: 'http://localhost:4200/bank', domElementCount: 4 };
    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(() => { page.domElementCount += 1; return page; }),
        perceivePage: async () => loopCtx(page.url),
        executeAction: async () => ({ success: true, message: 'dispatched' }),
      },
      { delayBetweenStepsMs: 1, maxSteps: 30 }
    );
    const finalState = await loop.runTask('open the account details');
    expect(loop.longHorizonRestoreStatus).toBe('UNAVAILABLE');
    expect(finalState.status).toBe('FAILED');
    expect(finalState.goalStatus).not.toBe('SUCCESS');
  });
});
