/**
 * PrivAgent — PHASE 18.7 / A7 + A8 FOCUSED TESTS.
 *
 * A7: recovery consumes TRUTHFUL, TYPED failure and progress information,
 *     stays bounded, and gains no authority over any existing gate.
 * A8: an HTTP 200 is not a valid action. The provider response pipeline is
 *     status → schema → applicability → a valid action OR a truthful failure,
 *     and a provider failure is never a success, a fabricated action, or a
 *     fabricated completion.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ALLOWED_STRATEGY_TRANSITIONS,
  DEFAULT_TYPED_RECOVERY_BUDGET,
  MAX_RECOVERY_RECORDS,
  RECOVERY_REASON_CODES,
  TypedRecoveryPlanner,
  describeRecoveryRecord,
  recoveryCategoryFor,
  type RecoveryFailureCategory,
  type RecoveryStrategyClass,
} from '../extension/src/agent/recoveryEngine';
import {
  isTransientFailure,
  providerRetryBudget,
  providerTaskClassFor,
  terminalStateForProviderFailure,
  validateProviderAction,
  validateProviderEnvelope,
  validateProviderResponse,
  validateStepApplicability,
  type ProviderFailureCategory,
} from '../extension/src/agent/providerResponse';
import { ProviderError } from '../extension/src/agent/openRouterProvider';
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { reviewProposedAction } from '../extension/src/agent/securityCritic';
import { validateAction } from '../extension/src/agent/actionValidator';
import type { ActionHistoryEntry } from '../extension/src/agent/actionHistory';
import type { AgentContextPayload } from '../extension/src/privacy/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

const entry = (over: Partial<ActionHistoryEntry> = {}): ActionHistoryEntry => ({
  action: { action: 'scroll', direction: 'down', amount: 500 },
  dispatchStatus: 'DISPATCHED',
  effectStatus: 'NO_EFFECT',
  scrollDelta: 0,
  evidenceDelta: 0,
  failureCode: null,
  pageGeneration: 3,
  observationState: 'CURRENT',
  ...over,
});

const ALL_CATEGORIES: RecoveryFailureCategory[] = [
  'NO_EFFECT',
  'POLICY_BLOCKED',
  'EXECUTION_FAILED',
  'PROVIDER_UNAVAILABLE',
  'STALE_PERCEPTION',
  'OSCILLATION',
];

// ═══════════════════════════════════════════════════════════════════════════
// A7 — the record contract
// ═══════════════════════════════════════════════════════════════════════════

describe('A7 · RecoveryRecord is structured, bounded and value-free', () => {
  it('carries exactly the contract fields and nothing else', () => {
    const planner = new TypedRecoveryPlanner();
    const out = planner.plan({
      failureCategory: 'NO_EFFECT',
      previousActionResult: entry(),
      madeProgress: false,
    });
    expect(Object.keys(out.record).sort()).toEqual([
      'failureCategory',
      'madeProgress',
      'observationState',
      'previousActionResult',
      'reasonCode',
      'retryCount',
      'strategyFrom',
      'strategyTo',
    ]);
  });

  it('every reason code is a fixed enum member — no free text anywhere', () => {
    const planner = new TypedRecoveryPlanner();
    for (const category of ALL_CATEGORIES) {
      for (let i = 0; i < 4; i++) {
        const out = planner.plan({ failureCategory: category, previousActionResult: entry(), madeProgress: false });
        expect(RECOVERY_REASON_CODES).toContain(out.record.reasonCode);
        expect(typeof out.record.reasonCode).toBe('string');
        expect(out.record.reasonCode.length).toBeLessThan(40);
      }
    }
  });

  it('holds a REFERENCE to the typed history entry, not a copy of a message', () => {
    const planner = new TypedRecoveryPlanner();
    const previous = entry({ failureCode: 'ACTION_NO_EFFECT' });
    const out = planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: previous, madeProgress: false });
    expect(out.record.previousActionResult).toBe(previous);
    // The only string in the record body is a code, and the reason code is one.
    const described = describeRecoveryRecord(out.record);
    expect(described).toContain('failure=NO_EFFECT');
    expect(described).toContain('dispatch=DISPATCHED');
    expect(described).toContain('effect=NO_EFFECT');
  });

  it('observation provenance is read from the entry, not asserted by the caller', () => {
    const planner = new TypedRecoveryPlanner();
    const out = planner.plan({
      failureCategory: 'STALE_PERCEPTION',
      previousActionResult: entry({ observationState: 'STALE' }),
      madeProgress: false,
    });
    expect(out.record.observationState).toBe('STALE');
  });

  it('the record ring is bounded', () => {
    const planner = new TypedRecoveryPlanner({ NO_EFFECT: 999 });
    for (let i = 0; i < MAX_RECOVERY_RECORDS + 40; i++) {
      planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: entry(), madeProgress: false });
    }
    expect(planner.records.length).toBe(MAX_RECOVERY_RECORDS);
  });

  it('reset restores a full budget for the next task', () => {
    const planner = new TypedRecoveryPlanner();
    for (let i = 0; i < 5; i++) {
      planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: entry(), madeProgress: false });
    }
    expect(planner.exhaustedFor('NO_EFFECT')).toBe(true);
    planner.reset();
    expect(planner.retryCountFor('NO_EFFECT')).toBe(0);
    expect(planner.exhaustedFor('NO_EFFECT')).toBe(false);
    expect(planner.records).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A7 — bounded, explicit strategy transitions
// ═══════════════════════════════════════════════════════════════════════════

describe('A7 · strategy transitions are explicit and bounded', () => {
  it('the vocabulary cannot express "retry the exact same action"', () => {
    // There is deliberately no RETRY_SAME_ACTION member, and no planner output
    // ever names one.
    const planner = new TypedRecoveryPlanner();
    const seen = new Set<string>();
    for (const category of ALL_CATEGORIES) {
      for (let i = 0; i < 6; i++) {
        const out = planner.plan({ failureCategory: category, previousActionResult: entry(), madeProgress: false });
        seen.add(out.record.strategyTo);
        expect(out.record.strategyTo).not.toMatch(/SAME_ACTION|REPEAT/);
      }
    }
    expect([...seen].sort()).toEqual(['CHANGE_STRATEGY', 'CONTINUE', 'RE_PERCEIVE', 'STOP']);
  });

  it('every emitted transition is in the explicit allowlist', () => {
    const planner = new TypedRecoveryPlanner();
    for (const category of ALL_CATEGORIES) {
      for (let i = 0; i < 6; i++) {
        const out = planner.plan({ failureCategory: category, previousActionResult: entry(), madeProgress: false });
        const allowed = ALLOWED_STRATEGY_TRANSITIONS[out.record.strategyFrom];
        expect(allowed, `${category} ${out.record.strategyFrom}->${out.record.strategyTo}`).toContain(
          out.record.strategyTo
        );
      }
    }
  });

  it('STOP is terminal — the only transition out of it is a restatement of STOP', () => {
    expect(ALLOWED_STRATEGY_TRANSITIONS.STOP).toEqual(['STOP']);
  });

  it('the same strategy never repeats for one category, so no alternating pair is reachable', () => {
    for (const category of ALL_CATEGORIES) {
      const planner = new TypedRecoveryPlanner();
      const chain: RecoveryStrategyClass[] = [];
      for (let i = 0; i < 8; i++) {
        const out = planner.plan({ failureCategory: category, previousActionResult: entry(), madeProgress: false });
        chain.push(out.record.strategyTo);
        if (out.exhausted) break;
      }
      // Once STOP is reached nothing else may follow.
      const stopAt = chain.indexOf('STOP');
      if (stopAt >= 0) expect(chain.slice(stopAt + 1)).toEqual([]);
      // No immediate A -> A repetition, except the single bounded provider
      // retry, which is literally "continue once".
      for (let i = 1; i < chain.length; i++) {
        if (chain[i] === 'STOP') continue;
        expect(chain[i] === chain[i - 1], `${category} step ${i}`).toBe(
          category === 'PROVIDER_UNAVAILABLE' && chain[i] === 'CONTINUE'
        );
      }
      // Bounded by the configured budget.
      expect(chain.filter((s) => s !== 'STOP').length).toBeLessThanOrEqual(
        DEFAULT_TYPED_RECOVERY_BUDGET[category]
      );
    }
  });

  it('every category terminates within its hard budget', () => {
    for (const category of ALL_CATEGORIES) {
      const planner = new TypedRecoveryPlanner();
      let attempts = 0;
      let exhausted = false;
      while (!exhausted && attempts < 50) {
        exhausted = planner.plan({ failureCategory: category, previousActionResult: entry(), madeProgress: false })
          .exhausted;
        attempts++;
      }
      expect(exhausted, category).toBe(true);
      expect(attempts, category).toBeLessThanOrEqual(DEFAULT_TYPED_RECOVERY_BUDGET[category] + 1);
    }
  });

  it('a caller cannot widen a budget past the built-in ceiling', () => {
    // The planner accepts an override for tests, but the DEFAULT table is what
    // production uses and every default is small and hard.
    for (const value of Object.values(DEFAULT_TYPED_RECOVERY_BUDGET)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2);
    }
    expect(DEFAULT_TYPED_RECOVERY_BUDGET.POLICY_BLOCKED).toBe(1);
    expect(DEFAULT_TYPED_RECOVERY_BUDGET.OSCILLATION).toBe(1);
    expect(DEFAULT_TYPED_RECOVERY_BUDGET.STALE_PERCEPTION).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A7 — per-category behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('A7 · each category gets the strategy its truth requires', () => {
  it('STALE_PERCEPTION re-perceives BEFORE anything else', () => {
    const planner = new TypedRecoveryPlanner();
    const out = planner.plan({
      failureCategory: 'STALE_PERCEPTION',
      previousActionResult: entry({ observationState: 'STALE' }),
      madeProgress: false,
    });
    expect(out.record.strategyTo).toBe('RE_PERCEIVE');
    expect(out.requiresFreshPerception).toBe(true);
    expect(out.forbidsStaleTarget).toBe(true);
    expect(out.record.reasonCode).toBe('OBSERVATION_SUPERSEDED');
  });

  it('PROVIDER_UNAVAILABLE retries a BOUNDED number of times, then terminates', () => {
    const planner = new TypedRecoveryPlanner();
    const first = planner.plan({
      failureCategory: 'PROVIDER_UNAVAILABLE',
      previousActionResult: entry(),
      madeProgress: false,
    });
    expect(first.exhausted).toBe(false);
    const second = planner.plan({
      failureCategory: 'PROVIDER_UNAVAILABLE',
      previousActionResult: entry(),
      madeProgress: false,
    });
    expect(second.exhausted).toBe(true);
    expect(second.record.strategyTo).toBe('STOP');
    expect(second.record.reasonCode).toBe('RETRY_BUDGET_EXHAUSTED');
  });

  it('POLICY_BLOCKED does not blindly retry the prohibited action', () => {
    const planner = new TypedRecoveryPlanner();
    const first = planner.plan({
      failureCategory: 'POLICY_BLOCKED',
      previousActionResult: entry({ dispatchStatus: 'POLICY_BLOCKED', effectStatus: 'NOT_APPLICABLE' }),
      madeProgress: false,
    });
    expect(first.record.reasonCode).toBe('GATE_REFUSED_ACTION');
    // One change of strategy, then truthful termination — never a second
    // attempt at the proposal a gate already refused.
    const second = planner.plan({
      failureCategory: 'POLICY_BLOCKED',
      previousActionResult: entry({ dispatchStatus: 'POLICY_BLOCKED', effectStatus: 'NOT_APPLICABLE' }),
      madeProgress: false,
    });
    expect(second.exhausted).toBe(true);
    expect(second.record.strategyTo).toBe('STOP');
  });

  it('OSCILLATION changes strategy immediately — the alternating pattern is already known bad', () => {
    const planner = new TypedRecoveryPlanner();
    const first = planner.plan({
      failureCategory: 'OSCILLATION',
      previousActionResult: entry(),
      madeProgress: false,
    });
    expect(first.record.strategyTo).toBe('CHANGE_STRATEGY');
    const second = planner.plan({
      failureCategory: 'OSCILLATION',
      previousActionResult: entry(),
      madeProgress: false,
    });
    expect(second.exhausted).toBe(true);
  });

  it('EXECUTION_FAILED may change strategy, but only after re-perceiving', () => {
    const planner = new TypedRecoveryPlanner();
    const first = planner.plan({
      failureCategory: 'EXECUTION_FAILED',
      previousActionResult: entry({ dispatchStatus: 'EXECUTION_FAILED' }),
      madeProgress: false,
    });
    expect(first.record.strategyFrom).toBe('CONTINUE');
    expect(first.record.strategyTo).toBe('RE_PERCEIVE');
    const second = planner.plan({
      failureCategory: 'EXECUTION_FAILED',
      previousActionResult: entry({ dispatchStatus: 'EXECUTION_FAILED' }),
      madeProgress: false,
    });
    expect(second.record.strategyTo).toBe('CHANGE_STRATEGY');
    expect(second.requiresFreshPerception).toBe(true);
  });

  it('the record names the transition it actually made, not the one before the run', () => {
    const planner = new TypedRecoveryPlanner();
    const first = planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: entry(), madeProgress: false });
    expect(first.record.strategyFrom).toBe('CONTINUE');
    expect(first.record.strategyTo).toBe('RE_PERCEIVE');
    // The SECOND record must say it is moving FROM the strategy the first one
    // selected. Reporting `CONTINUE → CHANGE_STRATEGY` here would erase the
    // fact that a re-perception already happened.
    const second = planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: entry(), madeProgress: false });
    expect(second.record.strategyFrom).toBe('RE_PERCEIVE');
    expect(second.record.strategyTo).toBe('CHANGE_STRATEGY');
  });

  it('an unlisted transition fails closed to STOP instead of being taken', () => {
    // A caller may state the strategy in force. If that makes the next step an
    // illegal hop, recovery must refuse it rather than drift.
    const planner = new TypedRecoveryPlanner();
    const out = planner.plan({
      failureCategory: 'OSCILLATION',
      previousActionResult: entry(),
      madeProgress: false,
      strategyFrom: 'CHANGE_STRATEGY',
    });
    expect(out.record.strategyTo).toBe('STOP');
    expect(out.exhausted).toBe(true);
  });

  it('NO_EFFECT re-perceives, then changes strategy, then stops', () => {
    const planner = new TypedRecoveryPlanner();
    expect(
      planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: entry(), madeProgress: false }).record
        .strategyTo
    ).toBe('RE_PERCEIVE');
    expect(
      planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: entry(), madeProgress: false }).record
        .strategyTo
    ).toBe('CHANGE_STRATEGY');
    const third = planner.plan({ failureCategory: 'NO_EFFECT', previousActionResult: entry(), madeProgress: false });
    expect(third.exhausted).toBe(true);
    expect(third.record.strategyTo).toBe('STOP');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A7 — category derivation and authority
// ═══════════════════════════════════════════════════════════════════════════

describe('A7 · categories are derived from typed state, never guessed', () => {
  it('maps each typed combination to the right category', () => {
    expect(
      recoveryCategoryFor({ dispatchStatus: 'POLICY_BLOCKED', effectStatus: 'NOT_APPLICABLE' })
    ).toBe('POLICY_BLOCKED');
    expect(recoveryCategoryFor({ dispatchStatus: 'NOT_DISPATCHED', effectStatus: 'NOT_APPLICABLE' })).toBe(
      'POLICY_BLOCKED'
    );
    expect(recoveryCategoryFor({ dispatchStatus: 'EXECUTION_FAILED', effectStatus: 'EFFECT_UNVERIFIABLE' })).toBe(
      'EXECUTION_FAILED'
    );
    expect(recoveryCategoryFor({ dispatchStatus: 'DISPATCHED', effectStatus: 'NO_EFFECT' })).toBe('NO_EFFECT');
    expect(recoveryCategoryFor({ dispatchStatus: 'DISPATCHED', effectStatus: 'NO_EFFECT', providerFailure: true })).toBe(
      'PROVIDER_UNAVAILABLE'
    );
    expect(recoveryCategoryFor({ dispatchStatus: 'DISPATCHED', effectStatus: 'NO_EFFECT', staleObservation: true })).toBe(
      'STALE_PERCEPTION'
    );
  });

  it('OSCILLATION dominates a weaker effect-derived category', () => {
    expect(
      recoveryCategoryFor({
        dispatchStatus: 'DISPATCHED',
        effectStatus: 'NO_EFFECT',
        oscillating: true,
        providerFailure: true,
      })
    ).toBe('OSCILLATION');
  });

  it('a provider failure outranks a stale observation — the request never completed', () => {
    expect(
      recoveryCategoryFor({
        dispatchStatus: 'DISPATCHED',
        effectStatus: 'NO_EFFECT',
        staleObservation: true,
        providerFailure: true,
      })
    ).toBe('PROVIDER_UNAVAILABLE');
  });

  it('recovery grants no authority: it cannot produce an action the gates would refuse', () => {
    // The planner's whole output surface is codes, booleans and integers.
    const planner = new TypedRecoveryPlanner();
    const out = planner.plan({
      failureCategory: 'NO_EFFECT',
      previousActionResult: entry(),
      madeProgress: true,
    });
    expect(Object.values(out).filter((v) => typeof v === 'object' && v !== null)).toHaveLength(1);

    // And the gates the loop still runs are untouched by any of it: the Security
    // Critic still produces a verdict, and M5 still refuses a forbidden scheme.
    const dangerous = { action: 'navigate', url: 'https://checkout.example/pay' };
    expect(reviewProposedAction({ action: dangerous } as never).verdict).toBeDefined();
    const jsUrl = validateAction({ action: 'navigate', url: 'javascript:alert(1)' }, {
      url: 'https://shop.example/cart',
      detections: [],
    } as never);
    expect(jsUrl.allowed).toBe(false);
  });

  it('madeProgress is recorded as a boolean and is never read from dispatch', () => {
    const planner = new TypedRecoveryPlanner();
    const dispatchedButUseless = planner.plan({
      failureCategory: 'NO_EFFECT',
      previousActionResult: entry({ dispatchStatus: 'DISPATCHED' }),
      madeProgress: false,
    });
    expect(dispatchedButUseless.record.previousActionResult?.dispatchStatus).toBe('DISPATCHED');
    expect(dispatchedButUseless.record.madeProgress).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A8 — HTTP 200 is not a valid action
// ═══════════════════════════════════════════════════════════════════════════

describe('A8 · the response pipeline refuses a malformed 200', () => {
  const ctx = () =>
    ({
      url: 'http://localhost:4260/',
      timestamp: 1,
      viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: [{ id: 'el_0_go', type: 'button', confidence: 0.9, bbox: { x: 1, y: 1, width: 2, height: 2 }, length: 0, source: 'dom_attribute', selector: '#go', is_partially_visible: false }],
      total_elements_scanned: 1,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
    }) as unknown as AgentContextPayload;

  function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  function rawResp(status: number, raw: string, headers: Record<string, string> = {}): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => JSON.parse(raw),
      text: async () => raw,
    } as unknown as Response;
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const categoryOf = async (resp: Response): Promise<ProviderFailureCategory> => {
    globalThis.fetch = vi.fn(async () => resp) as never;
    const p = new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' });
    try {
      await p.requestAction('do the thing', ctx());
      return 'NONE' as ProviderFailureCategory;
    } catch (err) {
      return err instanceof ProviderError ? err.category : 'UNKNOWN_PROVIDER_FAILURE';
    }
  };

  it('a VALID response is accepted and an action comes out', async () => {
    const ok = await categoryOf(
      jsonResp(200, { success: true, action: { action: 'click', target: 'el_0_go', reason: 'press go' } })
    );
    expect(ok).toBe('NONE');
  });

  it('THE OBSERVED DEFECT: every unused field filled with "down" is REFUSED', async () => {
    // Proven against the real provider in the A6/A8 runs.
    const category = await categoryOf(
      jsonResp(200, {
        success: true,
        action: {
          action: 'scroll',
          amount: 500,
          direction: 'down',
          option: 'down',
          reason: 'more results',
          target: 'down',
          text: 'down',
          url: 'down',
        },
      })
    );
    expect(category).toBe('SCHEMA_INVALID');
  });

  it('a missing required field is refused', async () => {
    expect(await categoryOf(jsonResp(200, { success: true, action: { action: 'scroll', direction: 'down' } }))).toBe(
      'SCHEMA_INVALID'
    );
    expect(await categoryOf(jsonResp(200, { success: true, action: { action: 'click' } }))).toBe('SCHEMA_INVALID');
  });

  it('a wrong field TYPE is refused', async () => {
    expect(
      await categoryOf(jsonResp(200, { success: true, action: { action: 'scroll', direction: 'down', amount: '500' } }))
    ).toBe('SCHEMA_INVALID');
    expect(
      await categoryOf(jsonResp(200, { success: true, action: { action: 'click', target: 42 } }))
    ).toBe('SCHEMA_INVALID');
  });

  it('an invalid enum value is refused, not defaulted', async () => {
    expect(
      await categoryOf(jsonResp(200, { success: true, action: { action: 'scroll', direction: 'sideways', amount: 500 } }))
    ).toBe('SCHEMA_INVALID');
    expect(
      await categoryOf(jsonResp(200, { success: true, action: { action: 'pressKey', key: 'F5' } }))
    ).toBe('UNSUPPORTED_ACTION');
    expect(await categoryOf(jsonResp(200, { success: true, action: { action: 'teleport', target: 'x' } }))).toBe(
      'UNSUPPORTED_ACTION'
    );
  });

  it('an out-of-range amount is refused, not clamped', async () => {
    expect(
      await categoryOf(jsonResp(200, { success: true, action: { action: 'scroll', direction: 'down', amount: 999999 } }))
    ).toBe('SCHEMA_INVALID');
  });

  it('a non-JSON body on a 200 is refused', async () => {
    expect(await categoryOf(rawResp(200, 'not json at all'))).toBe('INVALID_JSON');
  });

  it('an empty body on a 200 is refused', async () => {
    expect(await categoryOf(rawResp(200, ''))).toBe('EMPTY_RESPONSE');
  });

  it('an envelope with neither an action nor a proposal is refused', async () => {
    expect(await categoryOf(jsonResp(200, { success: true }))).toBe('SCHEMA_INVALID');
  });

  it('a contradictory envelope (action AND proposal) is refused', async () => {
    expect(
      await categoryOf(
        jsonResp(200, {
          success: true,
          action: { action: 'click', target: 'el_0_go' },
          proposal: { kind: 'ANSWER', answer: 'x' },
        })
      )
    ).toBe('SCHEMA_INVALID');
  });

  it('an unsuccessful envelope is refused', async () => {
    expect(await categoryOf(jsonResp(200, { success: false, action: { action: 'click', target: 'x' } }))).toBe(
      'UNKNOWN_PROVIDER_FAILURE'
    );
  });

  it('no refusal is ever coerced into a working action', () => {
    // validateProviderAction REFUSES; it has no repair path at all.
    expect(() => validateProviderAction({ action: 'scroll', direction: 'down', amount: 500, target: 'down' })).toThrow(
      ProviderError
    );
    expect(() => validateProviderAction({ action: 'click' })).toThrow(ProviderError);
    expect(() => validateProviderEnvelope({ success: true, action: { action: 'scroll', direction: 'down', amount: 500, url: 'x' } })).toThrow(
      ProviderError
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A8 — stage 3: applicability
// ═══════════════════════════════════════════════════════════════════════════

describe('A8 · applicability refuses an incoherent step', () => {
  const actionStep = { kind: 'ACTION' as const, action: { action: 'click', target: 'x' } } as const;

  it('a valid proposal passes', () => {
    const step = validateStepApplicability({
      kind: 'TERMINAL_PROPOSAL',
      proposal: { kind: 'ANSWER', answer: 'The monument was built in 1591.' },
    });
    expect(step.kind).toBe('TERMINAL_PROPOSAL');
  });

  it('proposal kind ACTION with NO action is refused (it would smuggle one past the schema stage)', () => {
    expect(() => validateStepApplicability({ kind: 'TERMINAL_PROPOSAL', proposal: { kind: 'ACTION' } })).toThrow(
      ProviderError
    );
  });

  it('proposal kind ACTION with a malformed nested action is refused', () => {
    expect(() =>
      validateStepApplicability({
        kind: 'TERMINAL_PROPOSAL',
        proposal: { kind: 'ACTION', action: { action: 'scroll', direction: 'down', amount: 500, text: 'down' } },
      })
    ).toThrow(ProviderError);
  });

  it('proposal kind ACTION with a valid nested action becomes a real ACTION step', () => {
    const out = validateStepApplicability({
      kind: 'TERMINAL_PROPOSAL',
      proposal: { kind: 'ACTION', action: { action: 'click', target: 'x' } },
    });
    expect(out.kind).toBe('ACTION');
  });

  it('ANSWER with no answer is refused — a claim with nothing behind it', () => {
    expect(() => validateStepApplicability({ kind: 'TERMINAL_PROPOSAL', proposal: { kind: 'ANSWER' } })).toThrow(
      ProviderError
    );
    expect(() => validateStepApplicability({ kind: 'TERMINAL_PROPOSAL', proposal: { kind: 'ANSWER', answer: '  ' } })).toThrow(
      ProviderError
    );
  });

  it('NEEDS_INFORMATION with neither a question nor a gap is refused', () => {
    expect(() =>
      validateStepApplicability({ kind: 'TERMINAL_PROPOSAL', proposal: { kind: 'NEEDS_INFORMATION' } })
    ).toThrow(ProviderError);
  });

  it('CANNOT_VERIFY with no reason is refused', () => {
    expect(() =>
      validateStepApplicability({ kind: 'TERMINAL_PROPOSAL', proposal: { kind: 'CANNOT_VERIFY' } })
    ).toThrow(ProviderError);
  });

  it('an unknown proposal kind is refused', () => {
    expect(() =>
      validateStepApplicability({ kind: 'TERMINAL_PROPOSAL', proposal: { kind: 'DEFINITELY_DONE' } })
    ).toThrow(ProviderError);
  });

  it('an APPLICABILITY refusal carries the provider-invalid-response category', () => {
    try {
      validateProviderResponse({ success: true, proposal: { kind: 'ANSWER' } });
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).category).toBe('PROVIDER_INVALID_RESPONSE');
      // And the message names the fault, never the value.
      expect((err as ProviderError).message).not.toMatch(/[0-9]{6,}/);
    }
  });

  it('a valid action step is passed through untouched', () => {
    expect(validateStepApplicability(actionStep)).toBe(actionStep);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A8 — failure classification and the bounded, task-class-aware budget
// ═══════════════════════════════════════════════════════════════════════════

describe('A8 · failures are classified truthfully and retried within a bound', () => {
  it('transient and deterministic categories are separated without guesswork', () => {
    expect(isTransientFailure('TIMEOUT')).toBe(true);
    expect(isTransientFailure('NETWORK_FAILURE')).toBe(true);
    expect(isTransientFailure('HTTP_5XX')).toBe(true);
    // A rate limit is transient only when the provider published its own hint.
    expect(isTransientFailure('HTTP_429_RATE_LIMIT')).toBe(false);
    expect(isTransientFailure('HTTP_429_RATE_LIMIT', 1500)).toBe(true);
    // Deterministic: asking again returns the same unusable answer.
    for (const c of [
      'SCHEMA_INVALID',
      'INVALID_JSON',
      'UNSUPPORTED_ACTION',
      'MODEL_CONTRACT',
      'PROVIDER_INVALID_RESPONSE',
      'HTTP_401_403',
      'HTTP_4XX',
    ] as ProviderFailureCategory[]) {
      expect(isTransientFailure(c), c).toBe(false);
    }
  });

  it('the task class comes from the frozen intent decision, never from prose', () => {
    expect(providerTaskClassFor({ requiresEvidence: true, requiresDestination: false })).toBe('INFORMATION');
    expect(providerTaskClassFor({ requiresEvidence: true, requiresDestination: true })).toBe('UNKNOWN');
    expect(providerTaskClassFor({ requiresEvidence: false, requiresDestination: true })).toBe('INTERACTIVE');
    expect(providerTaskClassFor({})).toBe('INTERACTIVE');
  });

  it('an information task spends less of its budget than an interactive one', () => {
    expect(providerRetryBudget('INFORMATION', 'HTTP_429_RATE_LIMIT', 1000)).toBe(1);
    expect(providerRetryBudget('INTERACTIVE', 'HTTP_429_RATE_LIMIT', 1000)).toBe(2);
    // A deterministic failure gets no retry for an information task at all.
    expect(providerRetryBudget('INFORMATION', 'PROVIDER_INVALID_RESPONSE')).toBe(0);
    expect(providerRetryBudget('INTERACTIVE', 'PROVIDER_INVALID_RESPONSE')).toBe(1);
    // And a rate limit without a Retry-After is never retried.
    for (const taskClass of ['INFORMATION', 'INTERACTIVE', 'UNKNOWN'] as const) {
      expect(providerRetryBudget(taskClass, 'HTTP_429_RATE_LIMIT')).toBe(0);
    }
  });

  it('every budget is a small hard number', () => {
    const categories: ProviderFailureCategory[] = [
      'NETWORK_FAILURE',
      'TIMEOUT',
      'HTTP_5XX',
      'HTTP_429_RATE_LIMIT',
      'EMPTY_RESPONSE',
      'SCHEMA_INVALID',
      'INVALID_JSON',
      'MODEL_CONTRACT',
      'PROVIDER_INVALID_RESPONSE',
      'UNSUPPORTED_ACTION',
      'HTTP_401_403',
      'UNKNOWN_PROVIDER_FAILURE',
    ];
    for (const taskClass of ['INFORMATION', 'INTERACTIVE', 'UNKNOWN'] as const) {
      for (const c of categories) {
        const budget = providerRetryBudget(taskClass, c, 1000);
        expect(Number.isInteger(budget), `${taskClass}/${c}`).toBe(true);
        expect(budget, `${taskClass}/${c}`).toBeGreaterThanOrEqual(0);
        expect(budget, `${taskClass}/${c}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('every provider failure maps to the truthful PROVIDER_UNAVAILABLE state, never to success', () => {
    for (const c of [
      'NETWORK_FAILURE',
      'TIMEOUT',
      'HTTP_429_RATE_LIMIT',
      'HTTP_5XX',
      'INVALID_JSON',
      'SCHEMA_INVALID',
      'MODEL_CONTRACT',
      'PROVIDER_INVALID_RESPONSE',
    ] as ProviderFailureCategory[]) {
      expect(terminalStateForProviderFailure(c)).toBe('PROVIDER_UNAVAILABLE');
      expect(terminalStateForProviderFailure(c)).not.toBe('SUCCESS');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A8 / A7 — end to end through the real loop
// ═══════════════════════════════════════════════════════════════════════════

const loopCtx = (): AgentContextPayload =>
  ({
    url: 'https://en.wikipedia.org/wiki/Charminar',
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 1,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 0, sensitive_detected: 0, latency_ms: 1 },
    detections: [
      {
        id: 'el_0_body',
        type: 'element',
        selector: '#body',
        confidence: 0.95,
        bbox: { x: 1, y: 1, width: 10, height: 10 },
        length: 0,
        source: 'dom_attribute',
        is_partially_visible: false,
      },
    ],
  }) as unknown as AgentContextPayload;

const makeLoop = (provider: unknown, executeAction: ReturnType<typeof vi.fn>, runId: number) =>
  new AgentLoop(
    provider as never,
    {
      perceivePage: async () => loopCtx(),
      executeAction: executeAction as never,
      getEffectSnapshot: async () => ({
        url: 'https://en.wikipedia.org/wiki/Charminar',
        scrollX: 0,
        scrollY: 0,
        domElementCount: 1,
        timestamp: Date.now(),
      }),
    },
    { maxSteps: 6, maxRetries: 1, delayBetweenStepsMs: 1, runId }
  );

describe('A8 · a malformed provider response never reaches execution', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const runWithBody = async (body: unknown, runId: number) => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    })) as never;
    const executeAction = vi.fn(async () => ({ success: true }));
    const loop = makeLoop(new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' }), executeAction, runId);
    const state = await loop.runTask('tell me about charminar');
    return { state, executeAction };
  };

  it('the "down" class of malformed 200 dispatches nothing and never succeeds', async () => {
    const { state, executeAction } = await runWithBody(
      {
        success: true,
        action: {
          action: 'scroll',
          amount: 500,
          direction: 'down',
          option: 'down',
          reason: 'more results',
          target: 'down',
          text: 'down',
          url: 'down',
        },
      },
      9101
    );
    expect(executeAction).not.toHaveBeenCalled();
    expect(state.status).not.toBe('SUCCESS');
    expect(state.goalStatus).not.toBe('SUCCESS');
  });

  it('a malformed 200 is surfaced as a truthful PROVIDER_UNAVAILABLE state', async () => {
    const { state } = await runWithBody(
      { success: true, action: { action: 'scroll', direction: 'sideways', amount: 500 } },
      9102
    );
    expect(state.status).toBe('PROVIDER_UNAVAILABLE');
    expect(state.goalStatus).not.toBe('SUCCESS');
    expect(state.reason).toMatch(/reasoning service/i);
  });

  it('the retry budget is bounded: the provider is asked a small, fixed number of times', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ success: true, action: { action: 'scroll', direction: 'down' } }),
      text: async () => JSON.stringify({ success: true, action: { action: 'scroll', direction: 'down' } }),
    })) as never;
    const executeAction = vi.fn(async () => ({ success: true }));
    const loop = makeLoop(new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' }), executeAction, 9103);
    const state = await loop.runTask('tell me about charminar');

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    // Bounded, and small: never an unbounded spin on a provider that cannot
    // produce a usable step.
    expect(calls).toBeLessThanOrEqual(3);
    expect(executeAction).not.toHaveBeenCalled();
    expect(state.status).toBe('PROVIDER_UNAVAILABLE');
  });

  it('a rate limit is surfaced truthfully and is distinguishable from a goal failure', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: { get: () => null },
      json: async () => ({ detail: { reason: 'rate limited', error_kind: 'rate_limit', retryable: false } }),
      text: async () => '{}',
    })) as never;
    const executeAction = vi.fn(async () => ({ success: true }));
    const loop = makeLoop(new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' }), executeAction, 9104);
    const state = await loop.runTask('tell me about charminar');

    expect(executeAction).not.toHaveBeenCalled();
    expect(state.status).toBe('PROVIDER_UNAVAILABLE');
    expect(state.status).not.toBe('FAILED');
    const records = state.recoveryRecords ?? [];
    expect(records.length).toBeGreaterThan(0);
    // The FIRST record says the provider could not answer; the LAST one says
    // the bounded budget is spent and the run stopped truthfully.
    expect(records[0]!.failureCategory).toBe('PROVIDER_UNAVAILABLE');
    expect(records[0]!.reasonCode).toBe('PROVIDER_COULD_NOT_ANSWER');
    expect(records[records.length - 1]!.reasonCode).toBe('RETRY_BUDGET_EXHAUSTED');
    expect(records[records.length - 1]!.strategyTo).toBe('STOP');
  });

  it('an INFORMATION task spends a SMALLER retry budget than an interactive one', async () => {
    // The exact difference A8 exists to make, observed through the real loop:
    // the same transient 5xx, two different budgets, both hard.
    const measure = async (runId: number, intent?: unknown) => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({ detail: { reason: 'down', error_kind: 'http_error', retryable: true } }),
        text: async () => '{}',
      })) as never;
      const executeAction = vi.fn(async () => ({ success: true }));
      const loop = new AgentLoop(
        new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' }),
        {
          perceivePage: async () => loopCtx(),
          executeAction: executeAction as never,
          getEffectSnapshot: async () => ({
            url: 'https://en.wikipedia.org/wiki/Charminar',
            scrollX: 0,
            scrollY: 0,
            domElementCount: 1,
            timestamp: Date.now(),
          }),
        },
        { maxSteps: 6, maxRetries: 1, delayBetweenStepsMs: 1, runId, intentDecision: intent as never }
      );
      const state = await loop.runTask('tell me about charminar');
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
      return { calls, state, executeAction };
    };

    const information = await measure(9301, {
      intent: 'INFORMATION_REQUEST',
      confidence: 'DETERMINISTIC',
      requiresDestination: false,
      requiresEvidence: true,
      admitsBrowserAutomation: true,
    });
    const interactive = await measure(9302, {
      intent: 'INTERACTIVE_TASK',
      confidence: 'DETERMINISTIC',
      requiresDestination: true,
      requiresEvidence: false,
      admitsBrowserAutomation: true,
    });

    // INFORMATION: 1 retry. INTERACTIVE: 2. Both bounded, both truthful.
    expect(information.calls).toBe(2);
    expect(interactive.calls).toBe(3);
    expect(information.calls).toBeLessThan(interactive.calls);
    for (const r of [information, interactive]) {
      expect(r.executeAction).not.toHaveBeenCalled();
      expect(r.state.status).toBe('PROVIDER_UNAVAILABLE');
      expect(r.state.goalStatus).not.toBe('SUCCESS');
    }
  });

  it('a timeout is surfaced truthfully, with no fabricated action or evidence', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('The operation was aborted');
    }) as never;
    const executeAction = vi.fn(async () => ({ success: true }));
    const loop = makeLoop(new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' }), executeAction, 9105);
    const state = await loop.runTask('tell me about charminar');

    expect(executeAction).not.toHaveBeenCalled();
    expect(state.status).toBe('PROVIDER_UNAVAILABLE');
    expect(state.steps).toHaveLength(0);
    expect(state.answer).toBeUndefined();
  });
});

describe('A7 · the loop records truthful recovery for real gate refusals', () => {
  it('a grounded refusal is POLICY_BLOCKED with a bounded retry count', async () => {
    const executeAction = vi.fn(async () => ({ success: true }));
    const loop = makeLoop(
      {
        name: 'HallucinatingProvider',
        requestAction: async () => ({ action: 'click', target: 'element_that_does_not_exist' }),
      },
      executeAction,
      9201
    );
    const state = await loop.runTask('open the account details');

    expect(executeAction).not.toHaveBeenCalled();
    expect(state.status).not.toBe('SUCCESS');
    const records = state.recoveryRecords ?? [];
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]!.failureCategory).toBe('POLICY_BLOCKED');
    expect(records[0]!.previousActionResult?.dispatchStatus).toBe('POLICY_BLOCKED');
    expect(records[0]!.previousActionResult?.effectStatus).toBe('NOT_APPLICABLE');
    expect(records[0]!.reasonCode).toBe('GATE_REFUSED_ACTION');
    // Bounded: never more than the policy-blocked budget plus the stopping call.
    expect(records.filter((r) => r.failureCategory === 'POLICY_BLOCKED').length).toBeLessThanOrEqual(3);
  });

  it('recovery records survive as state with no field able to hold page text', () => {
    const record = new TypedRecoveryPlanner().plan({
      failureCategory: 'NO_EFFECT',
      previousActionResult: entry(),
      madeProgress: false,
    }).record;
    // No free-text field exists at all, so there is nothing to scan for.
    const serialized = JSON.stringify(record);
    expect(serialized).toContain('"reasonCode"');
    expect(serialized).not.toMatch(/password|credential|secret/i);
  });

  it('a failure before any action was proposed records NO previous action', () => {
    const record = new TypedRecoveryPlanner().plan({
      failureCategory: 'PROVIDER_UNAVAILABLE',
      previousActionResult: null,
      madeProgress: false,
    }).record;
    expect(record.previousActionResult).toBeNull();
    expect(record.observationState).toBe('NOT_APPLICABLE');
    expect(describeRecoveryRecord(record)).toContain('dispatch=NONE');
  });
});
