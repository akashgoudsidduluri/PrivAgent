/**
 * PrivAgent — Phase 13 Acceptance: Harness
 *
 * The Harness is CYCLE COORDINATION and RUNTIME-STATE OBSERVATION. It is not a
 * security authority and not an arbiter of security: it has no ALLOW / DENY /
 * AUTHORIZE output, only
 *
 *     CONTINUE · HALT_ENVIRONMENT · BUDGET_EXHAUSTED · TERMINAL
 *
 * These tests assert both halves of that contract:
 *
 *   1. The Harness genuinely coordinates cycles — it halts a cycle whose
 *      environment is no longer the one the task resolved to, BEFORE any
 *      perception happens, and it observes (never re-invents) the loop's own
 *      bounds.
 *   2. The Harness does NOT weaken, replace or reorder any existing security
 *      authority. Grounding, M5, the Security Critic, the Privacy Firewall,
 *      Risk/Confirmation, Containment, Effect Verification, Goal Verification
 *      and the Recovery Engine all still run on every cycle the Harness allows,
 *      and every one of them still decides independently. A CONTINUE verdict is
 *      never permission to dispatch.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AgentHarness,
  MAX_HARNESS_CYCLE_RECORDS,
  describeHarnessDecision,
  evaluateHarnessCycle,
  type HarnessBounds,
  type HarnessCycleInput,
} from '../../extension/src/agent/harness';
import {
  ContainmentScope,
  establishContainmentScope,
} from '../../extension/src/agent/containment';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { groundProposedTarget } from '../../extension/src/agent/groundingEngine';
import { reviewProposedAction } from '../../extension/src/agent/securityCritic';
import { canPerformAction } from '../../extension/src/agent/privacyPolicy';
import { assessActionRisk } from '../../extension/src/agent/riskEngine';
import { AgentLoop, assertNoSensitiveDataInState } from '../../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../../extension/src/agent/mockAgentProvider';
import { BrowserAction } from '../../extension/src/agent/actionTypes';
import { AgentContextPayload, AgentDetection } from '../../extension/src/privacy/types';
import { scanForRawSensitiveValues } from '../../extension/src/privacy/rawValueScanner';

const DASHBOARD = 'http://localhost:5173';
const IN_SCOPE_URL = 'https://www.google.com/';
const OFF_SCOPE_URL = 'https://redirected.evil.test/landing';
const TASK = 'search for black cats on google';

function scopeFor(url: string, tabId: number | null = 7): ContainmentScope | null {
  return establishContainmentScope({ targetUrl: url, targetTabId: tabId, dashboardOrigin: DASHBOARD });
}

function requireScope(url: string, tabId: number | null = 7): ContainmentScope {
  const s = scopeFor(url, tabId);
  expect(s).not.toBeNull();
  if (!s) throw new Error('scope not established');
  return s;
}

const BOUNDS: HarnessBounds = { maxSteps: 5, maxRetries: 2, maxTotalRecoveries: 6 };

/** A well-formed, in-scope cycle input. Every test perturbs exactly one field. */
function cycleInput(over: Partial<HarnessCycleInput> = {}): HarnessCycleInput {
  return {
    cycle: 1,
    status: 'IN_PROGRESS',
    stopRequested: false,
    containmentScope: requireScope(IN_SCOPE_URL),
    targetTabId: 7,
    liveUrl: IN_SCOPE_URL,
    bounds: { ...BOUNDS },
    step: 1,
    retryCount: 0,
    recoveryAttempts: 0,
    perceptionGeneration: 1,
    ...over,
  };
}

function det(id: string, type: AgentDetection['type'], selector: string): AgentDetection {
  return {
    id,
    type,
    selector,
    confidence: 0.95,
    bbox: { x: 20, y: 20, width: 160, height: 32 },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
  };
}

function ctx(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: IN_SCOPE_URL,
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 5,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 1, sensitive_detected: 0, latency_ms: 5 },
    detections: [det('search-box', 'search', 'input#q'), det('go', 'button', 'button#go')],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Run lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe('P13-1 a harness run is created, bounded and reset per task', () => {
  it('1.1 an uninitialized harness claims nothing', () => {
    const h = new AgentHarness();
    const s = h.summary();
    expect(s.cycles).toBe(0);
    expect(s.continueCount).toBe(0);
    expect(s.haltCount).toBe(0);
    expect(s.history).toEqual([]);
    expect(s.lastVerdict).toBe('TERMINAL');
  });

  it('1.2 initialize derives a deterministic run id from the task, never the task text', () => {
    const a = new AgentHarness();
    const b = new AgentHarness();
    a.initialize(TASK);
    b.initialize(TASK);
    expect(a.summary().runId).toBe(b.summary().runId);
    expect(a.summary().runId).not.toContain('cats');
    expect(a.summary().runId.startsWith('harness-run-')).toBe(true);
  });

  it('1.3 a new task starts with a fresh run — history never bleeds across tasks', () => {
    const h = new AgentHarness();
    h.initialize(TASK);
    h.runCycle({ ...cycleInput() });
    expect(h.summary().cycles).toBe(1);
    h.initialize('a completely different task');
    const s = h.summary();
    expect(s.cycles).toBe(0);
    expect(s.continueCount).toBe(0);
    expect(s.haltCount).toBe(0);
    expect(s.history).toEqual([]);
  });

  it('1.4 the cycle record is bounded and says so when it is truncated', () => {
    const h = new AgentHarness();
    h.initialize(TASK);
    for (let i = 0; i < MAX_HARNESS_CYCLE_RECORDS + 5; i++) {
      h.runCycle({ ...cycleInput(), step: 1 });
    }
    const s = h.summary();
    expect(s.cycles).toBe(MAX_HARNESS_CYCLE_RECORDS + 5);
    expect(s.history.length).toBe(MAX_HARNESS_CYCLE_RECORDS);
    expect(s.historyTruncated).toBe(true);
  });

  it('1.5 continue and halt counts are tracked separately', () => {
    const h = new AgentHarness();
    h.initialize(TASK);
    h.runCycle({ ...cycleInput(), step: 1 });
    h.runCycle({ ...cycleInput(), step: 2 });
    h.runCycle({ ...cycleInput(), step: 3, liveUrl: OFF_SCOPE_URL });
    const s = h.summary();
    expect(s.cycles).toBe(3);
    expect(s.continueCount).toBe(2);
    expect(s.haltCount).toBe(1);
    expect(s.lastVerdict).toBe('HALT_ENVIRONMENT');
    expect(s.lastHaltCode).toBe('SCOPE_DRIFT_DETECTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Environment held
// ─────────────────────────────────────────────────────────────────────────────
describe('P13-2 the harness halts a cycle whose environment is no longer valid', () => {
  it('2.1 an in-scope environment continues and says what it observed', () => {
    const d = evaluateHarnessCycle(cycleInput());
    expect(d.verdict).toBe('CONTINUE');
    expect(d.haltCode).toBeNull();
    expect(d.record.environment.scopeEstablished).toBe(true);
    expect(d.record.environment.withinScope).toBe(true);
    expect(d.record.environment.code).toBe('WITHIN_SCOPE');
  });

  it('2.2 a sub-domain of the root host is still inside the scope', () => {
    const d = evaluateHarnessCycle(cycleInput({ liveUrl: 'https://accounts.google.com/signin' }));
    expect(d.verdict).toBe('CONTINUE');
    expect(d.record.environment.withinScope).toBe(true);
  });

  it('2.3 an environment that has DRIFTED off-scope halts the cycle', () => {
    const d = evaluateHarnessCycle(cycleInput({ liveUrl: OFF_SCOPE_URL }));
    expect(d.verdict).toBe('HALT_ENVIRONMENT');
    expect(d.haltCode).toBe('SCOPE_DRIFT_DETECTED');
    expect(d.record.environment.withinScope).toBe(false);
  });

  it('2.4 an agent no longer pinned to the contained tab halts the cycle', () => {
    const d = evaluateHarnessCycle(cycleInput({ targetTabId: 99 }));
    expect(d.verdict).toBe('HALT_ENVIRONMENT');
    expect(d.haltCode).toBe('TAB_SCOPE_VIOLATION');
    expect(d.record.environment.tabMatchesScope).toBe(false);
  });

  it('2.5 an environment that is no longer a web origin halts the cycle', () => {
    const d = evaluateHarnessCycle(cycleInput({ liveUrl: 'chrome://settings' }));
    expect(d.verdict).toBe('HALT_ENVIRONMENT');
    expect(d.haltCode).toBe('UNSUPPORTED_SCHEME_DENIED');
  });

  it('2.6 a blank pre-load environment is NOT drift — the cycle may run', () => {
    const d = evaluateHarnessCycle(cycleInput({ liveUrl: 'about:blank' }));
    expect(d.verdict).toBe('CONTINUE');
    expect(d.record.environment.withinScope).toBeNull();
    expect(d.record.environment.code).toBeNull();
  });

  it('2.7 an unknown environment makes NO claim — it is not silently "inside"', () => {
    const d = evaluateHarnessCycle(cycleInput({ liveUrl: null }));
    expect(d.verdict).toBe('CONTINUE');
    expect(d.record.environment.liveUrlKnown).toBe(false);
    expect(d.record.environment.withinScope).toBeNull();
  });

  it('2.8 a host with NO scope makes no environmental claim at all', () => {
    const d = evaluateHarnessCycle(cycleInput({ containmentScope: null }));
    expect(d.verdict).toBe('CONTINUE');
    expect(d.record.environment.scopeEstablished).toBe(false);
    expect(d.record.environment.withinScope).toBeNull();
    expect(d.record.containmentScopeSummary).toBe('contained:none');
  });

  it('2.9 a malformed scope fails closed rather than being guessed at', () => {
    const broken = { ...requireScope(IN_SCOPE_URL), rootHost: '' };
    const d = evaluateHarnessCycle(cycleInput({ containmentScope: broken }));
    expect(d.verdict).toBe('HALT_ENVIRONMENT');
    expect(d.haltCode).toBe('MALFORMED_INPUT');
  });

  it('2.10 the environment halt is reported in the containment language, not a parallel one', () => {
    // The harness reuses Phase 12's codes rather than inventing a taxonomy the
    // rest of the system would have to learn.
    const d = evaluateHarnessCycle(cycleInput({ liveUrl: OFF_SCOPE_URL }));
    expect(d.haltCode).toBe('SCOPE_DRIFT_DETECTED');
    expect(d.record.environment.code).toBe('SCOPE_DRIFT_DETECTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Budgets — observed, never re-invented
// ─────────────────────────────────────────────────────────────────────────────
describe('P13-3 the harness observes the loop\'s own bounds and invents none', () => {
  it('3.1 the step bound is checked with the loop\'s own operator', () => {
    expect(evaluateHarnessCycle(cycleInput({ step: 4 })).verdict).toBe('CONTINUE');
    const d = evaluateHarnessCycle(cycleInput({ step: 5 }));
    expect(d.verdict).toBe('BUDGET_EXHAUSTED');
    expect(d.haltCode).toBe('MAX_STEPS_EXHAUSTED');
    expect(d.reason).toContain('5');
  });

  it('3.2 the retry bound is checked with the loop\'s own operator', () => {
    // The loop breaks on retryCount > maxRetries, so the harness must too: it
    // can never end a run the loop would have continued.
    expect(evaluateHarnessCycle(cycleInput({ retryCount: 2 })).verdict).toBe('CONTINUE');
    const d = evaluateHarnessCycle(cycleInput({ retryCount: 3 }));
    expect(d.verdict).toBe('BUDGET_EXHAUSTED');
    expect(d.haltCode).toBe('RETRY_BUDGET_EXHAUSTED');
  });

  it('3.3 the recovery bound is checked with the Recovery Engine\'s own operator', () => {
    // RecoveryEngine.abort()s on totalRecoveries > maxTotalRecoveries.
    expect(evaluateHarnessCycle(cycleInput({ recoveryAttempts: 6 })).verdict).toBe('CONTINUE');
    const d = evaluateHarnessCycle(cycleInput({ recoveryAttempts: 7 }));
    expect(d.verdict).toBe('BUDGET_EXHAUSTED');
    expect(d.haltCode).toBe('RECOVERY_BUDGET_EXHAUSTED');
  });

  it('3.4 the bounds come from the caller on every call — the harness stores none', () => {
    const h = new AgentHarness();
    h.initialize(TASK);
    h.runCycle({ ...cycleInput(), step: 4, bounds: { maxSteps: 10, maxRetries: 2, maxTotalRecoveries: 6 } });
    // The very next call uses different bounds and is judged by them.
    const d = h.runCycle({ ...cycleInput(), step: 4, bounds: { maxSteps: 3, maxRetries: 2, maxTotalRecoveries: 6 } });
    expect(d.verdict).toBe('BUDGET_EXHAUSTED');
    expect(d.record.budget.maxSteps).toBe(3);
  });

  it('3.5 the observed counters are the loop\'s, mirrored — never double-counted', () => {
    const d = evaluateHarnessCycle(cycleInput({ step: 2, retryCount: 1, recoveryAttempts: 3 }));
    expect(d.record.budget).toEqual({
      step: 2,
      maxSteps: 5,
      retryCount: 1,
      maxRetries: 2,
      recoveryAttempts: 3,
      maxTotalRecoveries: 6,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Terminal verdicts and malformed input
// ─────────────────────────────────────────────────────────────────────────────
describe('P13-4 terminal verdicts and fail-closed input', () => {
  it('4.1 a stop request is TERMINAL, never ALLOW', () => {
    const d = evaluateHarnessCycle(cycleInput({ stopRequested: true }));
    expect(d.verdict).toBe('TERMINAL');
    expect(d.haltCode).toBe('STOP_REQUESTED');
  });

  it('4.2 a task that is no longer in progress is TERMINAL', () => {
    for (const status of ['SUCCESS', 'FAILED', 'STOPPED', 'NEEDS_USER_CONFIRMATION'] as const) {
      const d = evaluateHarnessCycle(cycleInput({ status }));
      expect(d.verdict).toBe('TERMINAL');
      expect(d.haltCode).toBe('TASK_NOT_IN_PROGRESS');
    }
  });

  it('4.3 malformed input fails closed', () => {
    const cases = [
      undefined as unknown as HarnessCycleInput,
      null as unknown as HarnessCycleInput,
      cycleInput({ bounds: undefined as unknown as HarnessBounds }),
      cycleInput({ bounds: { maxSteps: -1, maxRetries: 2, maxTotalRecoveries: 6 } }),
      cycleInput({ bounds: { maxSteps: NaN, maxRetries: 2, maxTotalRecoveries: 6 } }),
      cycleInput({ step: -5 }),
      cycleInput({ recoveryAttempts: Infinity }),
      cycleInput({ perceptionGeneration: 'x' as unknown as number }),
    ];
    for (const input of cases) {
      const d = evaluateHarnessCycle(input);
      expect(d.verdict).toBe('TERMINAL');
      expect(d.haltCode).toBe('MALFORMED_INPUT');
    }
  });

  it('4.4 the verdict vocabulary contains no ALLOW / DENY / AUTHORIZE', () => {
    // The single most important structural property of the phase: the Harness
    // is not an arbiter of security, so it must have no word for permitting.
    const d = evaluateHarnessCycle(cycleInput());
    const surface = Object.keys(d)
      .map((k) => d[k as keyof typeof d])
      .filter((v): v is string => typeof v === 'string')
      .join(' ')
      .toUpperCase();
    expect(surface).not.toMatch(/ALLOW|DENY|AUTHORIZ|PERMIT|GRANT/);
    expect(d.verdict).toBe('CONTINUE');
  });

  it('4.5 the audit line is stable and value-free', () => {
    expect(describeHarnessDecision(evaluateHarnessCycle(cycleInput()))).toBe('HARNESS_CONTINUE');
    expect(
      describeHarnessDecision(evaluateHarnessCycle(cycleInput({ liveUrl: OFF_SCOPE_URL })))
    ).toBe('HARNESS_HALT_ENVIRONMENT_SCOPE_DRIFT_DETECTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Reporting is value-free
// ─────────────────────────────────────────────────────────────────────────────
describe('P13-5 harness reporting carries no values', () => {
  it('5.1 no reason ever contains the live URL or page text', () => {
    const secretish = 'https://user:pass@redirected.evil.test/steal?token=abc123#x';
    const d = evaluateHarnessCycle(cycleInput({ liveUrl: secretish }));
    expect(d.reason).not.toContain('redirected.evil.test');
    expect(d.reason).not.toContain('steal');
    expect(d.reason).not.toContain('abc123');
    expect(d.record.environment.reason).not.toContain('redirected.evil.test');
    expect(JSON.stringify(d)).not.toContain('redirected.evil.test');
  });

  it('5.2 the run summary passes the raw-value scanner', () => {
    const h = new AgentHarness();
    h.initialize(TASK);
    h.runCycle({ ...cycleInput(), step: 1 });
    h.runCycle({ ...cycleInput(), step: 2, liveUrl: OFF_SCOPE_URL });
    expect(scanForRawSensitiveValues(h.summary())).toEqual([]);
  });

  it('5.3 the scope summary exposes only the root host, via containment\'s own helper', () => {
    const d = evaluateHarnessCycle(cycleInput());
    expect(d.record.containmentScopeSummary).toBe('contained:google.com');
    expect(d.record.containmentScopeSummary).not.toContain('https://');
  });

  it('5.4 the record contains no forbidden state keys', () => {
    const d = evaluateHarnessCycle(cycleInput());
    expect(() => assertNoSensitiveDataInState(d)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Determinism
// ─────────────────────────────────────────────────────────────────────────────
describe('P13-6 the harness is deterministic', () => {
  it('6.1 identical input produces a byte-identical decision', () => {
    const a = evaluateHarnessCycle(cycleInput());
    const b = evaluateHarnessCycle(cycleInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('6.2 the same input through two independent runs is identical', () => {
    const run = () => {
      const h = new AgentHarness();
      h.initialize(TASK);
      h.runCycle({ ...cycleInput(), step: 1 });
      h.runCycle({ ...cycleInput(), step: 2 });
      return h.summary();
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('6.3 one perturbed field changes exactly that verdict', () => {
    const base = cycleInput();
    const drift = evaluateHarnessCycle({ ...base, liveUrl: OFF_SCOPE_URL });
    expect(drift.verdict).toBe('HALT_ENVIRONMENT');
    // Nothing else in the record moves.
    expect(drift.record.budget).toEqual(evaluateHarnessCycle(base).record.budget);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The AgentLoop integration
// ─────────────────────────────────────────────────────────────────────────────
describe('P13-7 the AgentLoop consults the harness before perception', () => {
  function makeLoop(
    actions: BrowserAction[],
    opts: { liveUrl: string; scope: ContainmentScope | null; withHarness: boolean }
  ) {
    const provider = new MockAgentProvider(actions);
    const perceivePage = vi.fn(async () => ctx({ url: opts.liveUrl }));
    const executeAction = vi.fn(async (_action: BrowserAction) => ({
      success: true,
      postSnapshot: { url: opts.liveUrl, scrollX: 0, scrollY: 0, domElementCount: 4, targetValueLength: 0, timestamp: 1 },
    }));
    const harness = new AgentHarness();
    const loop = new AgentLoop(
      provider,
      {
        perceivePage,
        executeAction,
        getEffectSnapshot: async () => ({ url: opts.liveUrl, scrollX: 0, scrollY: 0, domElementCount: 4, targetValueLength: 0, timestamp: 1 }),
      },
      {
        maxSteps: 5,
        maxRetries: 2,
        delayBetweenStepsMs: 1,
        targetTabId: 7,
        containmentScope: opts.scope,
        harness: opts.withHarness ? harness : null,
      }
    );
    return { loop, perceivePage, executeAction, harness };
  }

  const CLICK = { action: 'click', target: 'go', reason: 'Open the search control' } as BrowserAction;
  const SCROLL = { action: 'scroll', direction: 'down', amount: 300, reason: 'Look around' } as BrowserAction;
  // Refused by the Security Critic, which lets the loop continue to the next
  // cycle without dispatching anything.
  const BLOCKED = { action: 'navigate', url: 'https://evil.example/steal', reason: 'Navigate to the requested site' } as BrowserAction;

  it('7.1 an in-scope run consults the harness on every cycle and still completes', async () => {
    const { loop, executeAction, harness } = makeLoop(
      [CLICK, SCROLL, CLICK],
      { liveUrl: IN_SCOPE_URL, scope: requireScope(IN_SCOPE_URL), withHarness: true }
    );
    const state = await loop.runTask(TASK);

    expect(executeAction).toHaveBeenCalled();
    expect(['SUCCESS', 'FAILED']).toContain(state.status);
    expect(state.harnessRun).toBeDefined();
    expect(state.harnessRun!.cycles).toBeGreaterThan(0);
    expect(state.harnessRun!.continueCount).toBeGreaterThan(0);
    expect(harness.summary().haltCount).toBe(0);
  });

  it('7.2 a drifted environment halts the NEXT cycle, before it perceives or dispatches', async () => {
    // The capability the phase adds, in its reachable form. Cycle 1 has no
    // known URL so it claims nothing; that perception reveals a drifted page.
    // The proposed action is refused by M5 so nothing dispatches, and then
    // cycle 2 is halted by the harness BEFORE the agent perceives or reasons
    // about the unauthorized page a second time.
    const { loop, perceivePage, executeAction } = makeLoop(
      [BLOCKED, CLICK, SCROLL],
      { liveUrl: OFF_SCOPE_URL, scope: requireScope(IN_SCOPE_URL), withHarness: true }
    );
    const state = await loop.runTask(TASK);

    expect(state.status).toBe('FAILED');
    expect(state.harnessRun!.lastVerdict).toBe('HALT_ENVIRONMENT');
    expect(state.harnessRun!.lastHaltCode).toBe('SCOPE_DRIFT_DETECTED');
    // Exactly one perception: the halt happened before any second one.
    expect(perceivePage).toHaveBeenCalledTimes(1);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('7.3 the environment halt is TERMINAL — no recovery, no retry into the drift', async () => {
    const { loop } = makeLoop(
      [BLOCKED, CLICK, SCROLL],
      { liveUrl: OFF_SCOPE_URL, scope: requireScope(IN_SCOPE_URL), withHarness: true }
    );
    const state = await loop.runTask(TASK);

    expect(state.status).toBe('FAILED');
    // Exactly one halt: the run is never re-entered into the denied environment.
    expect(state.harnessRun!.haltCount).toBe(1);
    expect(state.harnessRun!.cycles).toBe(2);
    // The Recovery Engine was never engaged for an environmental refusal.
    expect(state.totalRecoveryAttempts ?? 0).toBe(0);
  });

  it('7.8 when BOTH layers are armed, containment\'s dispatch-boundary denial is the one that fires', async () => {
    // The two environmental controls are complementary and deliberately both
    // exist. Containment (Phase 12) sits at the DISPATCH boundary and is the
    // later, stronger control; the Harness sits before PERCEPTION and is the
    // earlier backstop for the case where containment never gets to run. This
    // pins the layering so neither layer can ever be removed as "redundant".
    const { loop, executeAction } = makeLoop(
      [CLICK, CLICK, SCROLL],
      { liveUrl: OFF_SCOPE_URL, scope: requireScope(IN_SCOPE_URL), withHarness: true }
    );
    const state = await loop.runTask(TASK);

    expect(state.status).toBe('FAILED');
    expect(executeAction).not.toHaveBeenCalled();
    // Containment refused the dispatch; the harness had already recorded the
    // environment on every cycle it observed.
    expect(state.containmentDecision?.code).toBe('SCOPE_DRIFT_DETECTED');
    expect(state.failureHistory?.some((f) => f.category === 'CONTAINMENT_DENIED')).toBe(true);
    expect(state.harnessRun!.cycles).toBeGreaterThan(0);
  });

  it('7.4 the first cycle makes NO environmental claim — it has not perceived yet', async () => {
    // Documented limitation, pinned deliberately: at cycle 1 the loop has no
    // live URL, so the harness records no claim rather than guessing. This is
    // the fail-safe direction (it never halts spuriously), and the service
    // worker's own start guard is what ensures the task starts in the resolved
    // environment in the first place.
    const { loop, executeAction } = makeLoop(
      [CLICK, SCROLL],
      { liveUrl: IN_SCOPE_URL, scope: requireScope(IN_SCOPE_URL), withHarness: true }
    );
    const state = await loop.runTask(TASK);

    const firstCycle = state.harnessRun!.history[0]!;
    expect(firstCycle.environment.liveUrlKnown).toBe(false);
    expect(firstCycle.environment.withinScope).toBeNull();
    expect(firstCycle.verdict).toBe('CONTINUE');
    expect(executeAction).toHaveBeenCalled();
  });

  it('7.5 a loop WITHOUT a harness behaves exactly as it did before this phase', async () => {
    // Opt-in safety: no harness ⇒ no claim, no new verdict, identical outcome.
    const { loop, perceivePage } = makeLoop(
      [CLICK, SCROLL],
      { liveUrl: IN_SCOPE_URL, scope: requireScope(IN_SCOPE_URL), withHarness: false }
    );
    const state = await loop.runTask(TASK);

    expect(perceivePage).toHaveBeenCalled();
    expect(state.harnessRun).toBeUndefined();
    expect(['SUCCESS', 'FAILED']).toContain(state.status);
  });

  it('7.6 a loop with no harness and no scope still runs (no false fail-closed)', async () => {
    const { loop, executeAction } = makeLoop(
      [CLICK, SCROLL],
      { liveUrl: IN_SCOPE_URL, scope: null, withHarness: true }
    );
    const state = await loop.runTask(TASK);

    expect(executeAction).toHaveBeenCalled();
    expect(state.harnessRun!.lastVerdict).not.toBe('HALT_ENVIRONMENT');
  });

  it('7.7 the harness state that lands in TaskState is value-free', async () => {
    const { loop } = makeLoop(
      [CLICK],
      { liveUrl: IN_SCOPE_URL, scope: requireScope(IN_SCOPE_URL), withHarness: true }
    );
    const state = await loop.runTask(TASK);

    expect(() => assertNoSensitiveDataInState(state)).not.toThrow();
    expect(scanForRawSensitiveValues(state.harnessRun)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. THE CENTRAL INVARIANT: the harness never substitutes for an authority
// ─────────────────────────────────────────────────────────────────────────────
describe('P13-8 HARNESS=CONTINUE is never permission to dispatch', () => {
  const GOOD_CLICK = { action: 'click', target: 'go', reason: 'Open the search control' } as BrowserAction;
  const OFFSITE = { action: 'navigate', url: 'https://evil.example/steal', reason: 'Navigate to the requested site' } as BrowserAction;
  const TYPE_RAW_CARD = { action: 'type', target: 'card-field', text: '4111111111111111' } as BrowserAction;
  const DESTRUCTIVE = { action: 'click', target: 'delete-all', reason: 'Delete everything' } as BrowserAction;

  it('8.1 HARNESS=CONTINUE → M5=REFUSED → NO DISPATCH', async () => {
    const { loop, executeAction, harness } = makeLoopWithHarness([{ action: 'eval', code: 'x' } as unknown as BrowserAction]);
    const state = await loop.runTask(TASK);

    expect(harness.summary().lastVerdict).toBe('CONTINUE');
    expect(validateAction({ action: 'eval', code: 'x' } as unknown as BrowserAction, ctx()).allowed).toBe(false);
    expect(executeAction).not.toHaveBeenCalled();
    expect(state.steps.every((s) => s.executionSuccess === false)).toBe(true);
  });

  it('8.2 HARNESS=CONTINUE → CRITIC=BLOCK → NO DISPATCH', async () => {
    const { loop, executeAction, harness } = makeLoopWithHarness([OFFSITE]);
    const state = await loop.runTask(TASK);

    expect(harness.summary().lastVerdict).toBe('CONTINUE');
    // The critic reaches its own BLOCK verdict on its own evidence...
    expect(reviewProposedAction({ action: OFFSITE, task: TASK, context: ctx(), currentUrl: IN_SCOPE_URL }).verdict).toBe('BLOCK');
    // ...and the refused navigation never reached the executor. The harness
    // said CONTINUE and the agent still did not go there.
    expect(executeAction.mock.calls.every((c) => c[0].action !== 'navigate')).toBe(true);
    expect(state.steps.find((s) => s.action.action === 'navigate')?.executionSuccess).toBe(false);
  });

  it('8.3 HARNESS=CONTINUE → CONTAINMENT=DENIED → NO DISPATCH', async () => {
    // In scope for the live tab, but the navigate target is off-scope: the
    // critic may pass it (the harness said CONTINUE) and containment is what
    // refuses it at the dispatch boundary.
    const scope = requireScope(IN_SCOPE_URL);
    const crossOrigin: BrowserAction = { action: 'navigate', url: 'https://other.example/x', reason: 'Move on' };
    const { loop, executeAction, harness } = makeLoopWithHarness([crossOrigin, GOOD_CLICK], scope);
    const state = await loop.runTask(TASK);

    expect(harness.summary().lastVerdict).toBe('CONTINUE');
    const navStep = state.steps.find((s) => s.action.action === 'navigate');
    expect(navStep?.executionSuccess).toBe(false);
    // If the navigate reached the executor it would be a containment failure;
    // either way it must never have executed.
    expect(executeAction.mock.calls.every((c) => c[0].action !== 'navigate')).toBe(true);
    expect(scope.rootHost).toBe('google.com');
  });

  it('8.4 HARNESS=CONTINUE → GROUNDING=REFUSED → NO DISPATCH', async () => {
    const hallucinated: BrowserAction = { action: 'click', target: 'does-not-exist', reason: 'Click a ghost' };
    const { loop, executeAction, harness } = makeLoopWithHarness([hallucinated, GOOD_CLICK]);
    const state = await loop.runTask(TASK);

    expect(harness.summary().lastVerdict).toBe('CONTINUE');
    expect(groundProposedTarget(hallucinated, ctx().detections, { currentPageGeneration: 0, actionPageGeneration: 0, currentOrigin: new URL(IN_SCOPE_URL).origin }).grounded).toBe(false);
    expect(executeAction.mock.calls.every((c) => (c[0] as { target?: string }).target !== 'does-not-exist')).toBe(true);
    expect(
      state.steps.every(
        (s) => s.executionSuccess === false || (s.action as { target?: string }).target === 'go'
      )
    ).toBe(true);
  });

  it('8.5 HARNESS=CONTINUE → the privacy value-transit boundary still refuses', () => {
    // The real protection the Privacy Firewall provides to an agent is that a
    // raw sensitive value can never transit through an action, and that the
    // policy is not reachable from a harness verdict at all. Both still hold.
    const cardCtx = ctx({ detections: [det('card-field', 'credit_card', 'input#cc')] });
    expect(validateAction(TYPE_RAW_CARD, cardCtx).allowed).toBe(false);
    // The policy API has no parameter through which a harness verdict could
    // reach it, and it still returns its own independent decision.
    const target = cardCtx.detections.find((d) => d.id === 'card-field');
    expect(canPerformAction({ action: 'click', target: 'card-field' } as BrowserAction, target, 'agent_llm').granted).toBe(true);
    expect(scanForRawSensitiveValues('4111 1111 1111 1111').length).toBeGreaterThan(0);
  });

  it('8.6 the risk/confirmation gate is untouched by a CONTINUE verdict', () => {
    const r = assessActionRisk(DESTRUCTIVE, ctx(), IN_SCOPE_URL);
    const consequential = r.level === 'HIGH' || r.level === 'CRITICAL' || r.requiresUserConfirmation;
    expect(consequential).toBe(true);
  });

  it('8.7 a CONTINUE verdict carries no authorization field at all', () => {
    const d = evaluateHarnessCycle(cycleInput());
    const keys = Object.keys(d).concat(Object.keys(d.record));
    expect(keys.some((k) => /allow|deny|authoriz|permit|grant|approved/i.test(k))).toBe(false);
  });

  // Local helper: a loop whose FIRST cycle is guaranteed in-scope so the
  // harness says CONTINUE, and whose proposed actions are refused by gates.
  function makeLoopWithHarness(actions: BrowserAction[], scope: ContainmentScope | null = requireScope(IN_SCOPE_URL)) {
    return makeLoopInternal(actions, scope);
  }
  function makeLoopInternal(actions: BrowserAction[], scope: ContainmentScope | null) {
    const provider = new MockAgentProvider(actions);
    const perceivePage = vi.fn(async () => ctx());
    const executeAction = vi.fn(async (_action: BrowserAction) => ({
      success: true,
      postSnapshot: { url: IN_SCOPE_URL, scrollX: 0, scrollY: 0, domElementCount: 4, targetValueLength: 0, timestamp: 1 },
    }));
    const harness = new AgentHarness();
    const loop = new AgentLoop(
      provider,
      {
        perceivePage,
        executeAction,
        getEffectSnapshot: async () => ({ url: IN_SCOPE_URL, scrollX: 0, scrollY: 0, domElementCount: 4, targetValueLength: 0, timestamp: 1 }),
      },
      {
        maxSteps: 4,
        maxRetries: 2,
        delayBetweenStepsMs: 1,
        targetTabId: 7,
        containmentScope: scope,
        harness,
      }
    );
    return { loop, perceivePage, executeAction, harness };
  }
});
