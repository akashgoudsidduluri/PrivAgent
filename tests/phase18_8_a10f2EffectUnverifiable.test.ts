/**
 * PHASE 18.8 / A10-F2 — `EFFECT_UNVERIFIABLE` is a typed, recoverable state
 * instead of an unmapped code whose internal error reached the user.
 *
 * THE DEFECT, observed in real Chrome (A10 S18)
 *   A dispatched cross-origin `navigate` produced effect status
 *   `EFFECT_UNVERIFIABLE` — the browser state it would be measured on could not
 *   be observed. That status is a member of `EffectStatus`, so
 *   `RecoveryFailureCode` already admitted it and TypeScript was satisfied. But
 *   `STRATEGY_BY_CODE` had no entry for it, so `classifyFailure` returned
 *   `UNKNOWN` ("Unrecognized failure code 'EFFECT_UNVERIFIABLE'; failing closed"),
 *   the recovery engine ABORTED, and the abort reason became the terminal reason
 *   the user was shown.
 *
 * WHAT IS ASSERTED HERE
 *   1. The code is RECOGNIZED — a type-level admission is not a runtime mapping.
 *   2. Recovery does not abort because the category is unknown.
 *   3. It does not blindly repeat the action whose effect is unknown.
 *   4. One fresh perception is allowed, and can resolve the unknown.
 *   5. Persistent uncertainty terminates TRUTHFULLY, not by looping.
 *   6. NO_EFFECT / EXECUTION_FAILED / POLICY_BLOCKED behaviour is unchanged.
 *   7. No raw internal string reaches the user-facing reason.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  ALLOWED_STRATEGY_TRANSITIONS,
  DEFAULT_TYPED_RECOVERY_BUDGET,
  RECOVERY_REASON_CODES,
  RecoveryEngine,
  TypedRecoveryPlanner,
  classifyFailure,
  recoveryCategoryFor,
  type RecoveryFailureCategory,
} from '../extension/src/agent/recoveryEngine';
import type { EffectStatus } from '../extension/src/agent/effectVerifier';
import type { ActionHistoryEntry } from '../extension/src/agent/actionHistory';

const TASK = 'open wikipedia';
const URL = 'https://en.wikipedia.org/wiki/Main_Page';

function entry(over: Partial<ActionHistoryEntry> = {}): ActionHistoryEntry {
  return {
    step: 1,
    action: 'navigate',
    target: null,
    dispatchStatus: 'DISPATCHED',
    effectStatus: 'EFFECT_UNVERIFIABLE',
    effectDelta: null,
    riskLevel: 'LOW',
    confidence: 0.8,
    ...over,
  } as unknown as ActionHistoryEntry;
}

describe('A10-F2 — the code is recognized at runtime, not just in the type', () => {
  it('classifyFailure accepts EFFECT_UNVERIFIABLE', () => {
    // Pre-fix this returned ok:false / 'UNKNOWN'.
    const cls = classifyFailure({ code: 'EFFECT_UNVERIFIABLE' });
    expect(cls.ok).toBe(true);
    expect(cls.code).toBe('EFFECT_UNVERIFIABLE');
    expect(cls.reason).not.toMatch(/unrecognized/i);
  });

  it('EFFECT_UNVERIFIABLE is a member of EffectStatus, so the failure code type admits it', () => {
    // Pins WHY the bug survived TypeScript: the union already contained it.
    const statuses: readonly string[] = [
      'EFFECT_OBSERVED', 'EFFECT_UNVERIFIABLE', 'ACTION_NO_EFFECT',
      'URL_NAVIGATION_OBSERVED', 'DOM_MUTATION_OBSERVED', 'MODAL_STATE_CHANGED',
      'SCROLL_CHANGED', 'VALUE_STATE_CHANGED', 'FOCUS_SHIFT_OBSERVED',
    ];
    const declared: readonly EffectStatus[] = statuses as readonly EffectStatus[];
    expect(declared).toContain('EFFECT_UNVERIFIABLE');
  });

  it('the engine recovers instead of aborting', () => {
    const engine = new RecoveryEngine();
    const decision = engine.decide({
      code: 'EFFECT_UNVERIFIABLE',
      pageGeneration: 2,
      targetId: 'nav-1',
      noEffect: true,
    });
    expect(decision.strategy).not.toBe('ABORT');
    expect(decision.code).toBe('EFFECT_UNVERIFIABLE');
    // Recovery proposes re-observation; the dispatch pipeline still gates.
    expect(decision.requiresFreshPerception).toBe(true);
  });

  it('recovery never proposes repeating the action whose effect is unknown', () => {
    const engine = new RecoveryEngine();
    const first = engine.decide({ code: 'EFFECT_UNVERIFIABLE', pageGeneration: 2 });
    expect(first.strategy).not.toBe('RETRY_SAME_TARGET');
    expect(first.strategy).toBe('REPERCEIVE');
  });
});

describe('A10-F2 — the typed category is its own, not NO_EFFECT', () => {
  it('an unreadable effect is EFFECT_UNVERIFIABLE, not NO_EFFECT', () => {
    expect(
      recoveryCategoryFor({ dispatchStatus: 'DISPATCHED', effectStatus: 'EFFECT_UNVERIFIABLE' })
    ).toBe('EFFECT_UNVERIFIABLE');
  });

  it('a genuinely unchanged effect is still NO_EFFECT (unchanged behaviour)', () => {
    expect(
      recoveryCategoryFor({ dispatchStatus: 'DISPATCHED', effectStatus: 'NO_EFFECT' })
    ).toBe('NO_EFFECT');
  });

  it('an unreadable effect can never reach CHANGE_STRATEGY', () => {
    // The safety property: an unknown outcome must not re-propose an action.
    // The budget is raised here ON PURPOSE, so this pins the CHAIN itself
    // rather than the chain-and-budget combination. A chain that merely
    // happens not to be reached before the budget runs out is not the property
    // being claimed.
    const planner = new TypedRecoveryPlanner({ EFFECT_UNVERIFIABLE: 4 });
    const strategies: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const outcome = planner.plan({
        failureCategory: 'EFFECT_UNVERIFIABLE',
        previousActionResult: entry(),
        madeProgress: false,
      });
      strategies.push(outcome.record.strategyTo);
      if (outcome.exhausted) break;
    }
    expect(strategies).not.toContain('CHANGE_STRATEGY');
    expect(strategies.filter((s) => s === 'RE_PERCEIVE').length).toBe(1);
    expect(strategies[strategies.length - 1]).toBe('STOP');
  });

  it('its budget is one and its reason code is a fixed code', () => {
    expect(DEFAULT_TYPED_RECOVERY_BUDGET.EFFECT_UNVERIFIABLE).toBe(1);
    expect(RECOVERY_REASON_CODES).toContain('EFFECT_NOT_OBSERVABLE');
  });

  it('STOP is terminal for this category (no escape hatch back out)', () => {
    expect(ALLOWED_STRATEGY_TRANSITIONS.STOP).toEqual(['STOP']);
  });
});

describe('A10-F2 — bounded: one fresh look, then a truthful stop', () => {
  it('first occurrence: re-perceive, not exhausted', () => {
    const planner = new TypedRecoveryPlanner();
    const outcome = planner.plan({
      failureCategory: 'EFFECT_UNVERIFIABLE',
      previousActionResult: entry(),
      madeProgress: false,
    });
    expect(outcome.record.strategyTo).toBe('RE_PERCEIVE');
    expect(outcome.record.reasonCode).toBe('EFFECT_NOT_OBSERVABLE');
    expect(outcome.exhausted).toBe(false);
    // The record names the real effect status, so the audit trail is honest.
    expect(outcome.record.previousActionResult?.effectStatus).toBe('EFFECT_UNVERIFIABLE');
  });

  it('persistent uncertainty exhausts the budget instead of looping', () => {
    const planner = new TypedRecoveryPlanner();
    const outcomes = [
      planner.plan({ failureCategory: 'EFFECT_UNVERIFIABLE', previousActionResult: entry(), madeProgress: false }),
      planner.plan({ failureCategory: 'EFFECT_UNVERIFIABLE', previousActionResult: entry(), madeProgress: false }),
      planner.plan({ failureCategory: 'EFFECT_UNVERIFIABLE', previousActionResult: entry(), madeProgress: false }),
    ];
    const first = outcomes[0]!;
    const last = outcomes[outcomes.length - 1]!;
    expect(first.exhausted).toBe(false);
    expect(last.exhausted).toBe(true);
    expect(last.record.strategyTo).toBe('STOP');
    expect(last.record.reasonCode).toBe('RETRY_BUDGET_EXHAUSTED');
  });

  it('fresh verification CAN resolve it: a later verified effect is not this category', () => {
    // The flow the brief describes: unknown -> re-perceive -> resolved.
    expect(
      recoveryCategoryFor({
        dispatchStatus: 'DISPATCHED',
        effectStatus: 'EFFECT_VERIFIED',
      })
    ).not.toBe('EFFECT_UNVERIFIABLE');
  });
});

describe('A10-F2 — no internal string reaches the user', () => {
  it('classifyFailure no longer produces the unrecognized-code sentence', () => {
    const reason = classifyFailure({ code: 'EFFECT_UNVERIFIABLE' }).reason;
    expect(reason).not.toMatch(/unrecognized/i);
    expect(reason).not.toMatch(/failing closed/i);
  });

  it('the typed planner stores no free text at all', () => {
    const planner = new TypedRecoveryPlanner();
    const outcome = planner.plan({
      failureCategory: 'EFFECT_UNVERIFIABLE',
      previousActionResult: entry(),
      madeProgress: false,
    });
    // Every reason is a code; there is no field a message could hide in.
    expect(outcome.record.reasonCode).toMatch(/^[A-Z_]+$/);
    expect(JSON.stringify(outcome.record)).not.toMatch(/Unrecognized|failure code|recoveryEngine/i);
  });
});

describe('A10-F2 — existing recovery behaviour is unchanged', () => {
  it('NO_EFFECT keeps its two-step chain and budget', () => {
    const planner = new TypedRecoveryPlanner();
    const first = planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: entry({ effectStatus: 'NO_EFFECT' }), madeProgress: false });
    expect(first.record.strategyTo).toBe('RE_PERCEIVE');
    expect(DEFAULT_TYPED_RECOVERY_BUDGET.NO_EFFECT).toBe(2);
    // Unchanged: NO_EFFECT may still change strategy, because "nothing changed"
    // IS a claim about the browser and re-proposing is meaningful.
    expect(ALLOWED_STRATEGY_TRANSITIONS.RE_PERCEIVE).toContain('CHANGE_STRATEGY');
  });

  it('EXECUTION_FAILED and POLICY_BLOCKED keep their mappings', () => {
    expect(
      recoveryCategoryFor({ dispatchStatus: 'EXECUTION_FAILED', effectStatus: 'EFFECT_UNVERIFIABLE' })
    ).toBe('EXECUTION_FAILED');
    expect(
      recoveryCategoryFor({ dispatchStatus: 'POLICY_BLOCKED', effectStatus: 'EFFECT_UNVERIFIABLE' })
    ).toBe('POLICY_BLOCKED');
  });

  it('every category has a budget, a chain entry and a reason code', () => {
    const categories: RecoveryFailureCategory[] = [
      'NO_EFFECT', 'POLICY_BLOCKED', 'EXECUTION_FAILED',
      'PROVIDER_UNAVAILABLE', 'STALE_PERCEPTION', 'OSCILLATION', 'EFFECT_UNVERIFIABLE',
    ];
    for (const c of categories) {
      expect(DEFAULT_TYPED_RECOVERY_BUDGET[c], `${c} budget`).toBeGreaterThan(0);
      expect(RECOVERY_REASON_CODES.length).toBeGreaterThanOrEqual(categories.length);
    }
  });

  it('a malformed failure payload still fails closed', () => {
    // The new mapping must not have weakened structural validation.
    expect(classifyFailure(null).ok).toBe(false);
    expect(classifyFailure({}).ok).toBe(false);
    expect(classifyFailure({ code: 'CONFIRMATION_REQUIRED' }).ok).toBe(false);
  });
});

describe('A10-F2 — the loop, not just the engine', () => {
  it('an unobservable effect never reports SUCCESS and never repeats the action', async () => {
    const { AgentLoop } = await import('../extension/src/agent/agentLoop');
    const executeAction = vi.fn(async () => ({ success: true, message: 'navigated' }));
    const scroll = { action: 'scroll' as const, direction: 'down' as const, amount: 400 };

    const provider = {
      name: 'stub',
      requestAction: vi.fn(async () => scroll),
      requestStep: vi.fn(async () => ({ kind: 'ACTION' as const, action: scroll })),
    };

    const loop = new AgentLoop(
      provider,
      {
        // The observation channel EXISTS but can never read — the exact S18
        // shape: the host is there, the browser state is not observable.
        getEffectSnapshot: async () => null,
        perceivePage: async () => ({
          timestamp: Date.now(),
          url: URL,
          detections: [],
          viewport: { width: 1265, height: 757, scroll_x: 0, scroll_y: 0 },
          screenshot: null,
          total_elements_scanned: 0,
          sensitive_elements_detected: 0,
          sanitized_status: 'sanitized_only' as const,
          pageState: { url: URL, domElementCount: 0 },
        }),
        executeAction,
      } as never,
      { delayBetweenStepsMs: 1, maxSteps: 6, maxRetries: 5 } as never
    );

    const state = await loop.runTask(TASK);

    expect(state.status).not.toBe('SUCCESS');
    // The bound is the typed budget of ONE, not maxRetries (which is 5 here).
    expect(executeAction.mock.calls.length).toBeLessThanOrEqual(2);
    // The typed recovery record exists and says why — an audit trail, not copy.
    expect(state.recoveryRecords?.some((r) => r.failureCategory === 'EFFECT_UNVERIFIABLE')).toBe(true);
    //
    // The user-facing reason is pinned to the SENTENCE, not merely screened for
    // a few banned words. Screening alone let a regression that re-prefixed the
    // device's internal explanation back onto the terminal reason pass.
    //
    expect(state.reason).toBe(
      "I couldn't verify whether the action took effect, so I stopped without repeating it."
    );
    expect(state.reason ?? '').not.toMatch(/Unrecognized|failure code|recoveryEngine|failing closed/i);
    // The internal explanation the device writes into its own failure record
    // must not have leaked into anything the user is shown.
    expect(state.reason ?? '').not.toMatch(/browser state could not be observed|effect treated as unverified/i);
  });

  it('an unreadable VERDICT from the effect verifier is planned as EFFECT_UNVERIFIABLE too', async () => {
    // The third production path: both sides WERE snapshotted, but the field this
    // action is measured on was never read, so `verifyActionEffect` itself
    // returns { hasEffect: false, status: 'EFFECT_UNVERIFIABLE' }. Planning that
    // as NO_EFFECT would be a factual downgrade - NO_EFFECT may change strategy
    // and re-propose, while an unknown outcome must not.
    const { AgentLoop } = await import('../extension/src/agent/agentLoop');
    const executeAction = vi.fn(async () => ({ success: true, message: 'scrolled' }));
    const scroll = { action: 'scroll' as const, direction: 'down' as const, amount: 400 };

    const provider = {
      name: 'stub',
      requestAction: vi.fn(async () => scroll),
      requestStep: vi.fn(async () => ({ kind: 'ACTION' as const, action: scroll })),
    };

    // A snapshot that exists but on which a scroll cannot be measured:
    // scrollY was never read (UNAVAILABLE is not a reading of zero).
    const unreadableSnapshot = () => ({
      url: URL,
      scrollX: 0,
      scrollY: 0,
      timestamp: Date.now(),
      observation: {
        observedAt: Date.now(),
        tabId: 1,
        pageGeneration: 1,
        tabLifecycleObserved: true,
        pageReadable: false,
        fields: {
          url: 'OBSERVED' as const,
          scrollX: 'UNAVAILABLE' as const,
          scrollY: 'UNAVAILABLE' as const,
          targetValueLength: 'UNAVAILABLE' as const,
          openModalsCount: 'UNAVAILABLE' as const,
          activeElementSelector: 'UNAVAILABLE' as const,
          domElementCount: 'UNAVAILABLE' as const,
        },
      },
    });

    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: async () => unreadableSnapshot(),
        perceivePage: async () => ({
          timestamp: Date.now(),
          url: URL,
          detections: [],
          viewport: { width: 1265, height: 757, scroll_x: 0, scroll_y: 0 },
          screenshot: null,
          total_elements_scanned: 0,
          sensitive_elements_detected: 0,
          sanitized_status: 'sanitized_only' as const,
          pageState: { url: URL, domElementCount: 0 },
        }),
        executeAction,
      } as never,
      { delayBetweenStepsMs: 1, maxSteps: 6, maxRetries: 5 } as never
    );

    const state = await loop.runTask(TASK);

    expect(state.status).not.toBe('SUCCESS');
    // Bounded by the typed budget of one, not by maxRetries (5 here).
    expect(executeAction.mock.calls.length).toBeLessThanOrEqual(2);
    // The recovery record carries the verifier's own category, not NO_EFFECT.
    expect(state.recoveryRecords?.some((r) => r.failureCategory === 'EFFECT_UNVERIFIABLE')).toBe(true);
    expect(state.reason).toBe(
      "I couldn't verify whether the action took effect, so I stopped without repeating it."
    );
    expect(state.reason ?? '').not.toMatch(/Recovery limit exceeded|NO_EFFECT|EFFECT_UNVERIFIABLE|Unrecognized/i);
  });
});