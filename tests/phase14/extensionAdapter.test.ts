/**
 * PrivAgent — Phase 14 Correction Pass: Dashboard Adapter Acceptance
 *
 * Phase 14's real-browser run surfaced a contradiction: the runtime reported
 * `Step 2 of 10 · harness cycle 2` while the dashboard appeared to show a
 * generic "Deciding the next step." / "No result yet." pair, and every progress
 * message logged `reason: undefined`.
 *
 * These tests pin the corrected contract:
 *
 *   1. The structured `interaction` projection is the source of truth, and the
 *      adapter consumes it rather than inferring anything from prose.
 *   2. The lifecycle stage comes from `interaction.activity.phase`, NOT from a
 *      substring sniff of the legacy `reason` string (which the agent loop no
 *      longer populates, so that branch was dead code).
 *   3. `reason` is a FALLBACK: a real failure reason survives, and when the
 *      legacy field is absent the structured terminal outcome supplies it, so a
 *      FAILED run no longer records `error: undefined` in its receipt.
 *   4. The PING watchdog neither emits agent progress nor mutates agent state.
 *   5. Duplicate progress payloads are idempotent, not accumulative.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExtensionAgentAdapter } from '../../frontend/src/adapters/extensionAdapter';
import type { AgentActivityPhase, AgentInteractionState } from '../../frontend/src/types/dashboard';

/** A realistic screened projection, exactly as the service worker emits it. */
function interaction(overrides: Partial<AgentInteractionState> = {}): AgentInteractionState {
  return {
    outcome: 'RUNNING',
    activity: { phase: 'PLANNING', summary: 'Deciding the next step.', step: 2, maxSteps: 10, cycle: 2 },
    terminal: null,
    result: { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] },
    artifacts: [],
    timeline: [],
    awaitingConfirmation: null,
    ...overrides,
  };
}

function taskProgress(overrides: Record<string, unknown> = {}) {
  return {
    status: 'IN_PROGRESS',
    currentStep: 1,
    // NOTE: no `reason` and no `stage`. The real agent loop emits neither.
    ...overrides,
  };
}

let adapter: ExtensionAgentAdapter;

beforeEach(async () => {
  adapter = new ExtensionAgentAdapter();
  // Let the constructor's 200ms initial ping timer and any queued window
  // messages from the previous test drain before assertions run.
  await new Promise((r) => setTimeout(r, 0));
});

afterEach(() => {
  adapter.destroy();
  vi.useRealTimers();
});

/** Deliver a TASK_PROGRESS exactly as the content-script bridge does. */
async function deliver(payload: Record<string, unknown>): Promise<void> {
  window.postMessage(
    { source: 'privagent-extension', type: 'TASK_PROGRESS', payload },
    '*'
  );
  // window.postMessage is asynchronous: the bridge runs on a later task.
  await new Promise((r) => setTimeout(r, 0));
}

describe('Phase 14 · 1. The adapter consumes the structured projection', () => {
  it('stores the interaction object and exposes it through getState()', async () => {
    await deliver(taskProgress({ interaction: interaction() }));

    const state = adapter.getState();
    expect(state.status).toBe('RUNNING');
    expect(state.interaction).toBeDefined();
    expect(state.interaction!.activity.phase).toBe('PLANNING');
    expect(state.interaction!.activity.step).toBe(2);
    expect(state.interaction!.activity.cycle).toBe(2);
    expect(state.interaction!.result.summary).toBe('No result yet.');
  });

  it('carries every field the UI renders: activity, result, terminal, artifacts, timeline', async () => {
    await deliver(
      taskProgress({
        interaction: interaction({
          outcome: 'FAILED',
          terminal: { outcome: 'FAILED', reason: 'REASONER_FAILED', headline: 'Failed: the reasoning model was unavailable.' },
          result: { kind: 'FINDINGS', summary: 'Found 2 items.', count: 2, items: [{ id: 'a', title: 'Cats', detail: 'wikipedia.org' }] },
          artifacts: [{ kind: 'FAILURE', label: 'reasoner unreachable' }],
          timeline: [{ step: 1, action: 'navigate', outcome: 'EXECUTED' }],
        }),
      })
    );

    const ix = adapter.getState().interaction!;
    expect(ix.outcome).toBe('FAILED');
    expect(ix.terminal?.reason).toBe('REASONER_FAILED');
    expect(ix.terminal?.headline).toContain('reasoning model was unavailable');
    expect(ix.result.kind).toBe('FINDINGS');
    expect(ix.result.items).toHaveLength(1);
    expect(ix.artifacts).toHaveLength(1);
    expect(ix.timeline).toHaveLength(1);
  });

  it('degrades to undefined for a malformed projection instead of throwing', async () => {
    await deliver(taskProgress({ interaction: { outcome: 'RUNNING' } }));
    expect(adapter.getState().interaction).toBeUndefined();

    await deliver(taskProgress({ interaction: 'not-an-object' }));
    expect(adapter.getState().interaction).toBeUndefined();
  });

  it('does not mutate its input payload', async () => {
    const payload = taskProgress({ interaction: interaction() });
    const snapshot = JSON.stringify(payload);
    await deliver(payload);
    expect(JSON.stringify(payload)).toBe(snapshot);
  });
});

describe('Phase 14 · 2. The stage comes from the structured phase, not from prose', () => {
  it('maps each projection phase onto the dashboard lifecycle vocabulary', async () => {
    const cases: Array<[AgentActivityPhase, string]> = [
      ['PERCEPTION', 'PERCEPTION'],
      ['PLANNING', 'LLM_REASONING'],
      ['VALIDATION', 'ACTION_VALIDATION'],
      ['EXECUTION', 'BROWSER_EXECUTION'],
      ['VERIFICATION', 'VERIFICATION'],
      ['AWAITING_CONFIRMATION', 'ACTION_VALIDATION'],
    ];

    for (const [phase, expected] of cases) {
      await deliver(taskProgress({ interaction: interaction({ activity: { phase, summary: '…', step: 1, maxSteps: 10, cycle: 1 } }) }));
      expect(adapter.getState().currentPipelineStage, `phase ${phase}`).toBe(expected);
    }
  });

  it('falls back to BROWSER_EXECUTION when no projection is present', async () => {
    await deliver(taskProgress());
    expect(adapter.getState().currentPipelineStage).toBe('BROWSER_EXECUTION');
  });

  it('never infers a stage by sniffing the legacy reason string', async () => {
    // The pre-fix adapter looked for the substring "perception" in `reason`.
    // That branch is now dead by construction, and the structured phase wins.
    await deliver(taskProgress({ reason: 'perception complete, 12 candidates' }));
    expect(adapter.getState().currentPipelineStage).toBe('BROWSER_EXECUTION');

    await deliver(
      taskProgress({
        reason: 'perception complete',
        interaction: interaction({ activity: { phase: 'PERCEPTION', summary: 'Reading the page.', step: 1, maxSteps: 10, cycle: 1 } }),
      })
    );
    expect(adapter.getState().currentPipelineStage).toBe('PERCEPTION');
  });

  it('honours an explicit stage from the loop when one is supplied', async () => {
    await deliver(taskProgress({ stage: 'PRIVACY_PROTECTION' }));
    expect(adapter.getState().currentPipelineStage).toBe('PRIVACY_PROTECTION');
  });
});

describe('Phase 14 · 3. `reason` is a fallback, not an erased field', () => {
  it('keeps a real legacy reason when the loop supplies one', async () => {
    await deliver(taskProgress({ status: 'FAILED', reason: 'Browser action execution failed repeatedly' }));
    expect(adapter.getState().reason).toBe('Browser action execution failed repeatedly');
  });

  it('supplies the structured terminal headline when the legacy reason is absent', async () => {
    // This is the real shape of a Phase 14 failure payload: TaskState has no
    // `reason` field at all, so the pre-fix adapter wrote `undefined` and the
    // receipt recorded `error: undefined`.
    await deliver(
      taskProgress({
        status: 'FAILED',
        interaction: interaction({
          outcome: 'FAILED',
          terminal: { outcome: 'FAILED', reason: 'REASONER_FAILED', headline: 'Failed: the reasoning model was unavailable.' },
        }),
      })
    );
    expect(adapter.getState().reason).toBe('Failed: the reasoning model was unavailable.');
  });

  it('leaves reason undefined on a healthy in-progress run rather than inventing one', async () => {
    await deliver(taskProgress({ interaction: interaction() }));
    expect(adapter.getState().reason).toBeUndefined();
  });
});

describe('Phase 14 · 4. PING does not touch agent state or progress', () => {
  it('does not create, duplicate or alter agent state', async () => {
    const before = adapter.getState();
    const states: unknown[] = [];
    const off = adapter.onStateChange((s) => states.push(s));

    // A full ping round trip, as the 15s watchdog performs it.
    window.postMessage(
      { source: 'privagent-dashboard', type: 'PING_EXTENSION', pingId: 'p1', targetUrl: 'http://localhost:4173' },
      '*'
    );
    window.postMessage(
      { source: 'privagent-extension', type: 'PONG_EXTENSION', pingId: 'p1', connected: true },
      '*'
    );
    await new Promise((r) => setTimeout(r, 0));

    // The PONG updates connectivity only. It must not push agent state.
    expect(states).toEqual([]);
    const after = adapter.getState();
    expect(after.status).toBe(before.status);
    expect(after.currentStep).toBe(before.currentStep);
    expect(after.currentPipelineStage).toBe(before.currentPipelineStage);
    expect(after.interaction).toBe(before.interaction);
    expect(adapter.isExtensionConnected()).toBe(true);
    off();
  });

  it('notifies extension-status listeners without touching agent state', async () => {
    const statuses: boolean[] = [];
    const off = adapter.onExtensionStatusChange((c) => statuses.push(c));

    window.postMessage(
      { source: 'privagent-extension', type: 'PONG_EXTENSION', pingId: 'p2', connected: true },
      '*'
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(statuses).toEqual([false, true]); // initial replay, then the PONG
    expect(adapter.getState().status).toBe('IDLE');
    off();
  });

  it('pings on exactly one 15s interval, and destroy() clears it', async () => {
    // A second interval would double every ping cycle for the page's lifetime.
    vi.useFakeTimers();
    const spy = vi
      .spyOn(ExtensionAgentAdapter.prototype, 'checkExtensionConnected')
      .mockResolvedValue(true);
    try {
      const a = new ExtensionAgentAdapter();
      await vi.advanceTimersByTimeAsync(250);
      expect(spy).toHaveBeenCalledTimes(1); // the one-off initial ping (200ms)

      await vi.advanceTimersByTimeAsync(15000);
      expect(spy).toHaveBeenCalledTimes(2); // exactly one interval tick

      await vi.advanceTimersByTimeAsync(45000);
      expect(spy).toHaveBeenCalledTimes(5); // 3 more ticks, not 12

      a.destroy();
      await vi.advanceTimersByTimeAsync(60000);
      expect(spy).toHaveBeenCalledTimes(5); // destroy() cleared the interval
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('Phase 14 · 5. Duplicate progress payloads are idempotent', () => {
  it('appends no duplicate timeline entries when the same payload is replayed', async () => {
    const payload = taskProgress({
      interaction: interaction({
        timeline: [{ step: 1, action: 'navigate', outcome: 'EXECUTED' }],
      }),
    });

    await deliver(payload);
    const first = adapter.getState().interaction!.timeline.length;
    await deliver(payload);
    await deliver(payload);

    // The projection is replaced wholesale, not appended to, so a redelivered
    // payload cannot inflate the UI.
    expect(adapter.getState().interaction!.timeline.length).toBe(first);
  });

  it('replaces rather than merges the interaction projection', async () => {
    await deliver(taskProgress({ interaction: interaction() }));
    expect(adapter.getState().interaction!.activity.phase).toBe('PLANNING');

    await deliver(
      taskProgress({
        interaction: interaction({
          outcome: 'SUCCEEDED',
          activity: { phase: 'TERMINAL', summary: 'Finished.', step: 10, maxSteps: 10, cycle: 4 },
        }),
      })
    );
    const ix = adapter.getState().interaction!;
    expect(ix.outcome).toBe('SUCCEEDED');
    expect(ix.activity.phase).toBe('TERMINAL');
    expect(adapter.getState().status).toBe('RUNNING');
  });
});
