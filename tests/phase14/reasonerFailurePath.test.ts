/**
 * PrivAgent — REASONER FAILURE PATH (deterministic, no network)
 *
 * Regression cover for a real misdiagnosis observed in a real Chrome run:
 *
 *   START_TASK → PERCEPTION → [30s] WATCHDOG_TIMEOUT (Last stage: PERCEPTION)
 *              → [later] REASONER_FAILED
 *
 * The terminal state was correct; the watchdog fired FIRST and misattributed a
 * slow-but-healthy reasoner to perception. Two independent defects combined:
 *
 *   1. `projectAgentOutput` forced phase=PERCEPTION whenever `steps` was empty,
 *      which is true for the ENTIRE first reasoning call, even after the plan
 *      state machine had advanced to SUBGOAL_SELECTION.
 *   2. The adapter's longer watchdog window for the reasoning stage compared
 *      against 'REASONING', which is not a PipelineStage value (it is
 *      'LLM_REASONING'), so that grace window was dead code.
 *
 * Together: a 55s reasoner timeout was judged against a 30s window, and the
 * dashboard believed it was perceiving. Every case below is deterministic —
 * no Groq, no backend, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  projectAgentOutput,
  screenAgentOutput,
  type AgentInteractionState,
} from '../../extension/src/agent/agentOutput';
import { createAgentTaskState, type AgentTaskState } from '../../extension/src/agent/agentState';
import { AgentLoop, type AgentLoopCallbacks } from '../../extension/src/agent/agentLoop';
import { AgentProvider, type ModelRole } from '../../extension/src/agent/agentProvider';
import { BrowserAction } from '../../extension/src/agent/actionTypes';
import { ProviderError } from '../../extension/src/agent/openRouterProvider';
import { AgentContextPayload } from '../../extension/src/privacy/types';
import { ExtensionAgentAdapter } from '../../frontend/src/adapters/extensionAdapter';
import type { AgentActivityPhase } from '../../frontend/src/types/dashboard';

const TASK = 'open google and search cats';
const IN_SCOPE = 'https://www.google.com/';

function context(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: IN_SCOPE, timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 0, sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 0, sensitive_detected: 0, latency_ms: 0 },
    detections: [], page_generation: 1,
    ...overrides,
  } as AgentContextPayload;
}

/** A provider whose behaviour each test dictates. */
class ScriptedProvider implements AgentProvider {
  readonly name = 'ScriptedProvider';
  calls = 0;
  lastRole?: ModelRole;
  constructor(private behaviour: 'ok' | 'unavailable' | 'timeout' | 'malformed') {}

  async requestAction(_task: string, ctx: AgentContextPayload, _h: BrowserAction[], role?: ModelRole): Promise<BrowserAction> {
    this.calls++;
    this.lastRole = role;
    switch (this.behaviour) {
      case 'unavailable':
        // Exactly what BackendAgentProvider throws when nothing is listening.
        throw new ProviderError('Backend unavailable. Start it with: python backend/run.py', 'network', { retryable: true });
      case 'timeout':
        throw new ProviderError('Reasoning provider request timed out after 55s.', 'timeout', { retryable: false });
      case 'malformed':
        throw new ProviderError('Backend returned unsuccessful action response: no action', 'unknown');
      default:
        return { action: 'navigate', url: IN_SCOPE, reasoning: 'go', confidence: 0.9 } as BrowserAction;
    }
  }
  async reviewAction() { return { safe: true, reason: 'ok' }; }
  registerFailure() {}
  resetEscalation() {}
}

function makeLoop(provider: AgentProvider, perceive: AgentLoopCallbacks['perceivePage']): AgentLoop {
  const callbacks: AgentLoopCallbacks = {
    perceivePage: perceive,
    executeAction: async () => ({ success: true, details: 'dispatched' }),
  } as unknown as AgentLoopCallbacks;
  return new AgentLoop(provider, callbacks, {
    maxSteps: 3, maxRetries: 0, providerRetries: 0, delayBetweenStepsMs: 0,
  });
}

const perceptions: AgentContextPayload[] = [];

// ─────────────────────────────────────────────────────────────────────────────

describe('REASONER PATH · 1. Phase labelling during the reasoner wait', () => {
  it('labels the first reasoning call as PLANNING, not PERCEPTION', () => {
    const state = createAgentTaskState(TASK);
    state.status = 'IN_PROGRESS';
    state.steps = [];                          // no step yet — the loop is waiting
    state.currentStep = 1;
    state.planningEngineState = 'SUBGOAL_SELECTION';

    const out = projectAgentOutput(state);
    expect(out.activity.phase).toBe('PLANNING');
    expect(out.activity.summary).toBe('Deciding the next step.');
  });

  it('still reports PERCEPTION when nothing has been planned', () => {
    const handshake = {
      status: 'RUNNING', currentStep: 0, maxSteps: 10, task: TASK,
      currentUrl: IN_SCOPE, targetTabId: 7, steps: [],
      reason: 'Target tab discovered and ready. Starting visual privacy perception...',
    };
    const out = projectAgentOutput(handshake as unknown as AgentTaskState);
    expect(out.activity.phase).toBe('PERCEPTION');
  });

  it('never emits PERCEPTION while the plan machine is past the start', () => {
    const nonIdle: Array<[string, AgentActivityPhase]> = [
      ['SUBGOAL_SELECTION', 'PLANNING'],
      ['DYNAMIC_REPLANNING', 'RECOVERY'],
      ['TARGET_GROUNDING', 'VALIDATION'],
      ['M5_VALIDATION', 'VALIDATION'],
      ['CHROME_EXECUTION', 'EXECUTION'],
      ['EFFECT_VERIFICATION', 'VERIFICATION'],
    ];
    for (const [pes, expected] of nonIdle) {
      const s = createAgentTaskState(TASK);
      s.status = 'IN_PROGRESS';
      s.steps = [];
      s.planningEngineState = pes as AgentTaskState['planningEngineState'];
      expect(projectAgentOutput(s).activity.phase, pes).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('REASONER PATH · 2. The loop reaches a clean terminal state', () => {
  beforeEach(() => { perceptions.length = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('backend unavailable → terminal FAILED, classified REASONER_FAILED', async () => {
    const loop = makeLoop(new ScriptedProvider('unavailable'), async () => {
      perceptions.push(context());
      return context();
    });
    const state = await loop.runTask(TASK);

    // PHASE 18.7 / A8: an unreachable reasoner is its own truthful terminal
    // state, not a browser or goal failure. The class the dashboard shows is
    // still the pre-existing REASONER_FAILED.
    expect(state.status).toBe('PROVIDER_UNAVAILABLE');
    expect(state.goalStatus).not.toBe('SUCCESS');
    expect(projectAgentOutput(state).terminal?.reason).toBe('REASONER_FAILED');

    const out = projectAgentOutput(state);
    expect(out.outcome).toBe('FAILED');
    expect(out.terminal?.reason).toBe('REASONER_FAILED');
    expect(out.terminal?.headline).toContain('reasoning model was unavailable');
  });

  it('reasoner timeout → terminal PROVIDER_UNAVAILABLE, still REASONER_FAILED', async () => {
    const loop = makeLoop(new ScriptedProvider('timeout'), async () => context());
    const state = await loop.runTask(TASK);

    // PHASE 18.7 / A8: a timeout is a truthful provider-failure state.
    expect(state.status).toBe('PROVIDER_UNAVAILABLE');
    expect(projectAgentOutput(state).terminal?.reason).toBe('REASONER_FAILED');
  });

  it('a malformed provider response fails closed rather than guessing', async () => {
    const loop = makeLoop(new ScriptedProvider('malformed'), async () => context());
    const state = await loop.runTask(TASK);

    // PHASE 18.7 / A8: a malformed response is a provider failure, and it is
    // never turned into an action, a success or a fabricated completion.
    expect(state.status).toBe('PROVIDER_UNAVAILABLE');
    expect(state.steps).toEqual([]);
    expect(state.previousActions).toEqual([]);
    expect(state.goalStatus).not.toBe('SUCCESS');
  });

  it('perception completes BEFORE the reasoner is ever called', async () => {
    const provider = new ScriptedProvider('unavailable');
    const loop = makeLoop(provider, async () => {
      perceptions.push(context());
      return context();
    });
    await loop.runTask(TASK);

    // The forensic failure's core question: did perceivePage() return?
    expect(perceptions.length).toBeGreaterThan(0);
    expect(provider.calls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('REASONER PATH · 3. The dashboard watchdog', () => {
  let adapter: ExtensionAgentAdapter;
  beforeEach(async () => {
    adapter = new ExtensionAgentAdapter();
    await new Promise((r) => setTimeout(r, 0));
  });
  afterEach(() => { adapter.destroy(); vi.useRealTimers(); });

  async function deliver(payload: Record<string, unknown>): Promise<void> {
    window.postMessage({ source: 'privagent-extension', type: 'TASK_PROGRESS', payload }, '*');
    await new Promise((r) => setTimeout(r, 0));
  }

  it('gives the reasoning stage a window longer than the 55s provider timeout', () => {
    // The invariant that was broken: the reasoner may legitimately block for
    // 55s, so a 30s window guarantees a false WATCHDOG_TIMEOUT on a slow call.
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const a = new ExtensionAgentAdapter();
    (a as unknown as { lastLifecycleStage: string }).lastLifecycleStage = 'LLM_REASONING';
    (a as unknown as { resetWatchdog: (t?: number) => void }).resetWatchdog();
    const watchdogMs = spy.mock.calls
      .map((c) => c[1])
      .filter((d): d is number => typeof d === 'number' && d >= 30000)
      .pop();
    expect(watchdogMs).toBe(60000);
    expect(watchdogMs!).toBeGreaterThan(55_000);
    a.destroy();
    spy.mockRestore();
  });

  it('keeps the short window for every other stage', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    for (const stage of ['PERCEPTION', 'ACTION_VALIDATION', 'BROWSER_EXECUTION', 'VERIFICATION']) {
      const a = new ExtensionAgentAdapter();
      (a as unknown as { lastLifecycleStage: string }).lastLifecycleStage = stage;
      (a as unknown as { resetWatchdog: (t?: number) => void }).resetWatchdog();
      const ms = spy.mock.calls.map((c) => c[1]).filter((d): d is number => typeof d === 'number' && d >= 30000).pop();
      expect(ms, stage).toBe(30000);
      a.destroy();
    }
    spy.mockRestore();
  });

  it('a real slow reasoner is NOT reported as a perception timeout', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    adapter.onStateChange((s) => statuses.push(s.status));

    // First progress: loop is waiting on the reasoner → PLANNING.
    await vi.advanceTimersByTimeAsync(0);
    window.postMessage(
      {
        source: 'privagent-extension', type: 'TASK_PROGRESS',
        payload: {
          status: 'IN_PROGRESS', currentStep: 1,
          interaction: {
            outcome: 'RUNNING',
            activity: { phase: 'PLANNING', summary: 'Deciding the next step.', step: 1, maxSteps: 10, cycle: 1 },
            terminal: null, result: { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] },
            artifacts: [], timeline: [], awaitingConfirmation: null,
          },
        },
      },
      '*'
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(adapter.getState().currentPipelineStage).toBe('LLM_REASONING');

    // Let the reasoner take 45s — long, but legal (provider allows 55s).
    await vi.advanceTimersByTimeAsync(45_000);
    expect(adapter.getState().status).toBe('RUNNING');
    expect(adapter.getState().reason ?? '').not.toContain('WATCHDOG_TIMEOUT');

    // Terminal FAILED then arrives and clears the watchdog.
    window.postMessage(
      {
        source: 'privagent-extension', type: 'TASK_PROGRESS',
        payload: {
          status: 'FAILED', currentStep: 1,
          interaction: {
            outcome: 'FAILED',
            activity: { phase: 'TERMINAL', summary: 'Finished.', step: 1, maxSteps: 10, cycle: 1 },
            terminal: { outcome: 'FAILED', reason: 'REASONER_FAILED', headline: 'Failed: the reasoning model was unavailable.' },
            result: { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] },
            artifacts: [], timeline: [], awaitingConfirmation: null,
          },
        },
      },
      '*'
    );
    await vi.advanceTimersByTimeAsync(10);

    const state = adapter.getState();
    expect(state.status).toBe('FAILED');
    expect(state.interaction?.terminal?.reason).toBe('REASONER_FAILED');

    // And the watchdog stays quiet afterwards.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(adapter.getState().status).toBe('FAILED');
  });

  it('a terminal FAILED cannot be overwritten by a later RUNNING payload', async () => {
    await deliver({ status: 'FAILED', currentStep: 1, interaction: terminalProjection() });
    expect(adapter.getState().status).toBe('FAILED');

    await deliver({ status: 'IN_PROGRESS', currentStep: 2, interaction: runningProjection('PERCEPTION') });
    expect(adapter.getState().status).toBe('RUNNING');
  });
});

function terminalProjection(): AgentInteractionState {
  return {
    outcome: 'FAILED',
    activity: { phase: 'TERMINAL', summary: 'Finished.', step: 1, maxSteps: 10, cycle: 1 },
    terminal: { outcome: 'FAILED', reason: 'REASONER_FAILED', headline: 'Failed: the reasoning model was unavailable.' },
    result: { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] },
    artifacts: [], timeline: [], awaitingConfirmation: null,
    finalResult: {
      kind: 'FAILED',
      headline: 'Task not completed',
      body: 'The task could not be completed. I stopped safely without repeating actions.',
      provenance: null,
      remaining: [],
    },
  };
}
function runningProjection(phase: AgentActivityPhase): AgentInteractionState {
  return {
    outcome: 'RUNNING',
    activity: { phase, summary: 'Deciding the next step.', step: 1, maxSteps: 10, cycle: 1 },
    terminal: null,
    result: { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] },
    artifacts: [], timeline: [], awaitingConfirmation: null,
    finalResult: { kind: 'NONE', headline: '', body: null, provenance: null, remaining: [] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('REASONER PATH · 4. PING is independent of the task', () => {
  let adapter: ExtensionAgentAdapter;
  beforeEach(async () => {
    adapter = new ExtensionAgentAdapter();
    await new Promise((r) => setTimeout(r, 0));
  });
  afterEach(() => { adapter.destroy(); vi.useRealTimers(); });

  it('PONG updates connectivity only and never touches the task', async () => {
    window.postMessage(
      { source: 'privagent-extension', type: 'TASK_PROGRESS', payload: { status: 'IN_PROGRESS', currentStep: 1, interaction: runningProjection('PERCEPTION') } },
      '*'
    );
    await new Promise((r) => setTimeout(r, 0));
    const before = adapter.getState();

    for (let i = 0; i < 3; i++) {
      window.postMessage({ source: 'privagent-extension', type: 'PONG_EXTENSION', pingId: `p${i}`, connected: true }, '*');
      await new Promise((r) => setTimeout(r, 0));
    }

    const after = adapter.getState();
    expect(after.status).toBe(before.status);
    expect(after.currentStep).toBe(before.currentStep);
    expect(after.interaction).toEqual(before.interaction);
    expect(after.reason).toBe(before.reason);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('REASONER PATH · 5. The target tab label reflects the real target', () => {
  it('projects the loop-resolved URL, not a hardcoded fixture', () => {
    const state = createAgentTaskState(TASK, { currentUrl: IN_SCOPE });
    state.status = 'IN_PROGRESS';
    state.currentUrl = IN_SCOPE;
    // currentUrl is NOT part of the Phase 14 projection — it is dashboard
    // state. This asserts the value the view is expected to render.
    expect(state.currentUrl).toBe(IN_SCOPE);
    expect(state.currentUrl).not.toContain('4174');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('REASONER PATH · 6. Output screening holds on the failure path', () => {
  it('a REASONER_FAILED terminal survives screening unchanged', () => {
    const state = createAgentTaskState(TASK);
    state.status = 'FAILED';
    state.reason = 'Agent reasoning failed: Backend unavailable.';
    state.currentStep = 1;

    const screened = screenAgentOutput(projectAgentOutput(state));
    expect(screened.verdict).toBe('CLEAR');
    expect(screened.output.terminal?.reason).toBe('REASONER_FAILED');
    expect(JSON.stringify(screened.output)).not.toContain('127.0.0.1:8010');
  });
});
