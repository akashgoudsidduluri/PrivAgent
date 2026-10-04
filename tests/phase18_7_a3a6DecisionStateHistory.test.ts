/**
 * PHASE 18.7 / A3 + A6 — STRUCTURED DECISION STATE AND TRUTHFUL HISTORY.
 *
 * These pin the two properties the previous architecture lacked:
 *
 *   A6 — DISPATCH != EFFECT != GOAL SUCCESS. The three are separate typed
 *        signals and each is derived from its own evidence.
 *   A3 — the model sees an ALLOWLISTED projection of state, never an authority.
 *
 * The mutation block at the end is the point of the file. Each mutation removes
 * one truthfulness guard; each MUST be caught. A mutation that survives means the
 * shortcut it represents is reachable in production.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDispatchStatus,
  classifyEffectStatus,
  buildActionHistoryEntry,
  findHistoryTruthfulnessViolations,
  assertTruthfulHistory,
  toWireAction,
  describeActionHistory,
  type ActionHistoryEntry,
  type DispatchStatus,
  type HistoryEffectStatus,
} from '../extension/src/agent/actionHistory';
import {
  buildDecisionState,
  projectDecisionStateForModel,
  goalStatusFromTaskStatus,
  renderDecisionState,
  MAX_CRITERIA,
  MAX_EVIDENCE_REFERENCES,
  type ModelFacingDecisionState,
} from '../extension/src/agent/decisionState';
import { filterToHistoryContract } from '../extension/src/agent/historyContract';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';
import type { StepRecord } from '../extension/src/agent/agentState';

// ── Fixtures ────────────────────────────────────────────────────────────────

function step(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    step: 1,
    action: { action: 'click', target: 'elem_1' },
    validationAllowed: true,
    validationReason: 'ok',
    executionSuccess: true,
    url: 'https://example.org/a',
    timestamp: 1,
    currentPageGeneration: 3,
    ...overrides,
  } as StepRecord;
}

const EVIDENCE: ModelFacingDecisionState['evidence'] = [
  { id: 'ev-1', verificationStatus: 'VERIFIED', freshness: 'CURRENT' },
  { id: 'ev-2', verificationStatus: 'UNVERIFIED', freshness: 'CURRENT' },
];

// ── A6.1 — dispatch classification ──────────────────────────────────────────

describe('A6 — dispatch status is derived from gating, not from dispatch', () => {
  it('a refused action is POLICY_BLOCKED, not DISPATCHED', () => {
    expect(classifyDispatchStatus({ validationAllowed: false, executionSuccess: true })).toBe(
      'POLICY_BLOCKED',
    );
  });

  it('a dispatched action that threw is EXECUTION_FAILED', () => {
    expect(classifyDispatchStatus({ validationAllowed: true, executionSuccess: false })).toBe(
      'EXECUTION_FAILED',
    );
  });

  it('a clean run is DISPATCHED and says nothing about effect', () => {
    expect(classifyDispatchStatus({ validationAllowed: true, executionSuccess: true })).toBe(
      'DISPATCHED',
    );
  });

  it('a gate refusal CANNOT look like a successful dispatch even if executionSuccess is true', () => {
    // The loop sets executionSuccess:true on the confirmed path; the gate flag
    // is the load-bearing signal. Ordering must not matter.
    expect(classifyDispatchStatus({ validationAllowed: false, executionSuccess: true })).not.toBe(
      'DISPATCHED',
    );
  });
});

// ── A6.2 — effect classification never reads execution success ──────────────

describe('A6 — effect status is derived only from an observed effect', () => {
  it('a blocked action has NOT_APPLICABLE effect, never NO_EFFECT', () => {
    // NO_EFFECT would claim an observer looked and saw nothing.
    const s = classifyEffectStatus(step({ validationAllowed: false }), 'POLICY_BLOCKED');
    expect(s).toBe('NOT_APPLICABLE');
  });

  it('execution success with no verifier verdict is EFFECT_UNVERIFIABLE, not verified', () => {
    const s = classifyEffectStatus(step({ executionSuccess: true }), 'DISPATCHED');
    expect(s).toBe('EFFECT_UNVERIFIABLE');
  });

  it('an explicitly observed DOM mutation is EFFECT_VERIFIED', () => {
    const s = classifyEffectStatus(
      step({ effectVerified: true, effectStatus: 'DOM_MUTATION_OBSERVED' }),
      'DISPATCHED',
    );
    expect(s).toBe('EFFECT_VERIFIED');
  });

  it('a confirmed ACTION_NO_EFFECT verdict stays NO_EFFECT', () => {
    const s = classifyEffectStatus(
      step({ effectVerified: false, effectStatus: 'ACTION_NO_EFFECT' }),
      'DISPATCHED',
    );
    expect(s).toBe('NO_EFFECT');
  });

  it('an unverifiable verdict stays EFFECT_UNVERIFIABLE even when execution succeeded', () => {
    const s = classifyEffectStatus(
      step({ effectVerified: false, effectStatus: 'EFFECT_UNVERIFIABLE', executionSuccess: true }),
      'DISPATCHED',
    );
    expect(s).toBe('EFFECT_UNVERIFIABLE');
  });

  it('an unknown effect status cannot be promoted to EFFECT_VERIFIED', () => {
    const s = classifyEffectStatus(
      step({ effectVerified: true, effectStatus: 'SOMETHING_ELSE' as never }),
      'DISPATCHED',
    );
    expect(s).not.toBe('EFFECT_VERIFIED');
  });
});

// ── A6.3 — truthfulness invariant ───────────────────────────────────────────

describe('A6 — the truthfulness invariant catches every conflation', () => {
  function entry(o: Partial<ActionHistoryEntry> = {}): ActionHistoryEntry {
    return {
      action: { action: 'click', target: 'elem_1' },
      dispatchStatus: 'DISPATCHED',
      effectStatus: 'NO_EFFECT',
      scrollDelta: null,
      evidenceDelta: 0,
      failureCode: null,
      pageGeneration: 3,
      observationState: 'CURRENT',
      ...o,
    };
  }

  it('a truthful history has no violations', () => {
    expect(
      findHistoryTruthfulnessViolations([
        entry({ dispatchStatus: 'POLICY_BLOCKED', effectStatus: 'NOT_APPLICABLE', failureCode: 'RISK_HIGH' }),
        entry({ dispatchStatus: 'DISPATCHED', effectStatus: 'EFFECT_VERIFIED' }),
      ]),
    ).toEqual([]);
  });

  it('MUT-1: POLICY_BLOCKED + EFFECT_VERIFIED is a violation', () => {
    const v = findHistoryTruthfulnessViolations([
      entry({ dispatchStatus: 'POLICY_BLOCKED', effectStatus: 'EFFECT_VERIFIED' }),
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it('MUT-2: EXECUTION_FAILED + EFFECT_VERIFIED is a violation', () => {
    const v = findHistoryTruthfulnessViolations([
      entry({ dispatchStatus: 'EXECUTION_FAILED', effectStatus: 'EFFECT_VERIFIED' }),
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it('MUT-3: NOT_DISPATCHED claiming an effect is a violation', () => {
    const v = findHistoryTruthfulnessViolations([
      entry({ dispatchStatus: 'NOT_DISPATCHED', effectStatus: 'NO_EFFECT' }),
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it('MUT-4: SCROLL_CHANGED observed with a zero measured delta is self-contradictory', () => {
    const v = findHistoryTruthfulnessViolations([
      entry({
        action: {
          action: 'scroll',
          direction: 'down',
          amount: 500,
          effect: 'SCROLL_CHANGED',
        },
        effectStatus: 'EFFECT_VERIFIED',
        scrollDelta: 0,
      }),
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it('a zero-delta scroll that produced new evidence is PERMITTED (lazy content)', () => {
    // Not a violation: content can load without the viewport moving. Rejecting
    // this would break exactly the productive scroll A4/I-8 must preserve.
    expect(
      findHistoryTruthfulnessViolations([
        entry({
          action: { action: 'scroll', direction: 'down', amount: 500 },
          effectStatus: 'EFFECT_VERIFIED',
          scrollDelta: 0,
          evidenceDelta: 3,
        }),
      ]),
    ).toEqual([]);
  });

  it('MUT-6: a STALE entry must keep its pageGeneration', () => {
    const v = findHistoryTruthfulnessViolations([
      entry({ observationState: 'STALE', pageGeneration: null }),
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it('assertTruthfulHistory throws rather than emitting a lying history', () => {
    expect(() =>
      assertTruthfulHistory([entry({ dispatchStatus: 'POLICY_BLOCKED', effectStatus: 'EFFECT_VERIFIED' })]),
    ).toThrow(/non-truthful/);
  });

  it('assertTruthfulHistory passes a consistent history silently', () => {
    expect(() =>
      assertTruthfulHistory([
        entry({ dispatchStatus: 'DISPATCHED', effectStatus: 'NO_EFFECT' }),
      ]),
    ).not.toThrow();
  });
});

// ── A6.4 — scroll delta, evidence delta, multi-action history, staleness ────

describe('A6 — deltas and multi-action history', () => {
  it('scroll delta is preserved for a scroll', () => {
    const e = buildActionHistoryEntry(
      step({
        action: { action: 'scroll', direction: 'down', amount: 500, scrollDelta: 420 } as StepRecord['action'],
        effectVerified: true,
        effectStatus: 'SCROLL_CHANGED',
      }),
    );
    expect(e.scrollDelta).toBe(420);
    expect(e.dispatchStatus).toBe('DISPATCHED');
    expect(e.effectStatus).toBe('EFFECT_VERIFIED');
  });

  it('scroll delta is null for a non-scroll action', () => {
    expect(buildActionHistoryEntry(step()).scrollDelta).toBeNull();
  });

  it('evidence delta is carried through', () => {
    expect(buildActionHistoryEntry(step(), { evidenceDelta: 5 }).evidenceDelta).toBe(5);
  });

  it('a stale page generation marks the entry STALE, not CURRENT', () => {
    const e = buildActionHistoryEntry(step({ currentPageGeneration: 3 }), {
      currentPageGeneration: 9,
    });
    expect(e.observationState).toBe('STALE');
    expect(e.pageGeneration).toBe(3);
  });

  it('a matching generation marks the entry CURRENT', () => {
    const e = buildActionHistoryEntry(step({ currentPageGeneration: 9 }), {
      currentPageGeneration: 9,
    });
    expect(e.observationState).toBe('CURRENT');
  });

  it('history across many actions stays internally consistent', () => {
    const entries = [
      buildActionHistoryEntry(step({ step: 1, effectVerified: true, effectStatus: 'URL_NAVIGATION_OBSERVED' })),
      buildActionHistoryEntry(
        step({ step: 2, action: { action: 'scroll', direction: 'down', amount: 500, scrollDelta: 0 } as StepRecord['action'], effectStatus: 'ACTION_NO_EFFECT' }),
      ),
      buildActionHistoryEntry(step({ step: 3, validationAllowed: false, validationReason: 'CONTAINED' })),
    ];
    expect(findHistoryTruthfulnessViolations(entries)).toEqual([]);
    expect(entries.map((e) => `${e.dispatchStatus}/${e.effectStatus}`)).toEqual([
      'DISPATCHED/EFFECT_VERIFIED',
      'DISPATCHED/NO_EFFECT',
      'POLICY_BLOCKED/NOT_APPLICABLE',
    ]);
  });

  it('a policy-blocked entry carries a failure code and is described truthfully', () => {
    const e = buildActionHistoryEntry(step({ validationAllowed: false, validationReason: 'RISK_BLOCKED' }));
    expect(e.failureCode).toBe('RISK_BLOCKED');
    expect(describeActionHistory(e)).toContain('dispatch=POLICY_BLOCKED');
  });
});

// ── A6.5 — the shape gate still runs AFTER the projection ───────────────────

describe('A6 — the existing history shape gate is preserved', () => {
  it('a well-formed projected action survives the contract filter', () => {
    const e = buildActionHistoryEntry(step({ effectVerified: true, effectStatus: 'DOM_MUTATION_OBSERVED' }));
    const { history, dropped } = filterToHistoryContract([toWireAction(e)]);
    expect(dropped).toBe(0);
    expect(history).toHaveLength(1);
  });

  it('a malformed action is still dropped (the 422-prevention behaviour)', () => {
    const { history, dropped } = filterToHistoryContract([
      { action: 'type', target: 'elem_1' } as never,
    ]);
    expect(dropped).toBe(1);
    expect(history).toHaveLength(0);
  });

  it('a blocked entry is never projected as a runnable action', () => {
    const e = buildActionHistoryEntry(step({ validationAllowed: false, validationReason: 'BLOCKED' }));
    const wire = toWireAction(e) as unknown as Record<string, unknown>;
    expect(wire.effect).toBe('NOT_APPLICABLE');
    expect(wire.reason).toBe('BLOCKED');
  });
});

// ── A3.1 — the state carries everything the model needs ─────────────────────

describe('A3 — the decision state is complete', () => {
  const state = buildDecisionState({
    task: 'find information about charminar',
    intent: 'MIXED_TASK',
    requiresEvidence: true,
    activeSubgoal: 'Reach the Charminar article',
    pendingCriteria: ['Reach an article page'],
    completedCriteria: ['Opened the search page'],
    url: 'https://en.wikipedia.org/wiki/Charminar',
    pageType: 'article',
    pageObservationState: 'OBSERVED',
    pageGeneration: 7,
    destinationStatus: 'UNVERIFIED',
    goalStatus: 'PENDING',
    evidence: EVIDENCE,
    recoveryState: 'NONE',
  });

  it('carries the task and the deterministic intent', () => {
    expect(state.task).toBe('find information about charminar');
    expect(state.intent).toBe('MIXED_TASK');
    expect(state.requiresEvidence).toBe(true);
  });

  it('carries the active subgoal and both criteria lists', () => {
    expect(state.activeSubgoal).toBe('Reach the Charminar article');
    expect(state.pendingCriteria).toEqual(['Reach an article page']);
    expect(state.completedCriteria).toEqual(['Opened the search page']);
  });

  it('carries page url, type, observation state and generation', () => {
    expect(state.page).toEqual({
      url: 'https://en.wikipedia.org/wiki/Charminar',
      type: 'article',
      observationState: 'OBSERVED',
      generation: 7,
    });
  });

  it('carries the last action with its truthful dispatch/effect status', () => {
    const withAction = buildDecisionState({
      task: 't',
      intent: 'ACTION_REQUEST',
      requiresEvidence: false,
      lastAction: buildActionHistoryEntry(step({ validationAllowed: false })),
    });
    expect(withAction.lastAction?.dispatchStatus).toBe('POLICY_BLOCKED');
    expect(withAction.lastAction?.effectStatus).toBe('NOT_APPLICABLE');
  });

  it('carries destination and goal status verbatim', () => {
    expect(state.destination.status).toBe('UNVERIFIED');
    expect(state.goal.status).toBe('PENDING');
  });

  it('carries evidence references', () => {
    expect(state.evidence).toHaveLength(2);
    expect(state.evidence[0]!.verificationStatus).toBe('VERIFIED');
  });

  it('carries recovery state', () => {
    expect(state.recovery).toEqual({ state: 'NONE', attempts: 0, retryCount: 0 });
  });

  it('maps every task status to a truthful goal status', () => {
    expect(goalStatusFromTaskStatus('SUCCESS')).toBe('SATISFIED');
    expect(goalStatusFromTaskStatus('FAILED')).toBe('NOT_SATISFIED');
    expect(goalStatusFromTaskStatus('IN_PROGRESS')).toBe('PENDING');
    // Neither success nor failure: nothing was attempted.
    expect(goalStatusFromTaskStatus('NEEDS_CLARIFICATION')).toBe('NOT_APPLICABLE');
    expect(goalStatusFromTaskStatus('NEEDS_USER_CONFIRMATION')).toBe('NOT_APPLICABLE');
  });
});

// ── A3.2 — observation states are NOT collapsed ─────────────────────────────

describe('A3 — observation states are preserved', () => {
  it('defaults to UNKNOWN, never to a success-flavoured state', () => {
    const s = buildDecisionState({ task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false });
    expect(s.page.observationState).toBe('UNKNOWN');
  });

  it('UNAVAILABLE is distinct from UNKNOWN', () => {
    const a = buildDecisionState({ task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false, pageObservationState: 'UNAVAILABLE' });
    const b = buildDecisionState({ task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false, pageObservationState: 'UNKNOWN' });
    expect(a.page.observationState).not.toBe(b.page.observationState);
  });

  it('STALE survives projection unchanged', () => {
    const s = buildDecisionState({
      task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false, pageObservationState: 'STALE',
    });
    expect(projectDecisionStateForModel(s).page.observationState).toBe('STALE');
  });

  it('goal status defaults to PENDING, never SATISFIED', () => {
    const s = buildDecisionState({ task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false });
    expect(s.goal.status).toBe('PENDING');
  });
});

// ── A3.3 — the allowlist: a field cannot leak by being added upstream ───────

describe('A3 — the egress projection is an allowlist', () => {
  it('projects exactly the permitted top-level keys', () => {
    const s = buildDecisionState({ task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false });
    expect(Object.keys(projectDecisionStateForModel(s)).sort()).toEqual([
      'activeSubgoal',
      'completedCriteria',
      'destination',
      'evidence',
      'goal',
      'intent',
      'lastAction',
      'page',
      'pendingCriteria',
      'recovery',
      'requiresEvidence',
      'task',
    ]);
  });

  it('a smuggled authority field does NOT survive projection', () => {
    // Simulate a future upstream change that attaches authority state.
    const polluted = {
      ...buildDecisionState({ task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false }),
      riskScore: 91,
      securityCriticVerdict: 'APPROVED',
      containmentDecision: { contained: true },
      goalVerifierInternals: { criteria: ['x'] },
    } as unknown as ModelFacingDecisionState;

    const out = projectDecisionStateForModel(polluted) as unknown as Record<string, unknown>;
    expect(out.riskScore).toBeUndefined();
    expect(out.securityCriticVerdict).toBeUndefined();
    expect(out.containmentDecision).toBeUndefined();
    expect(out.goalVerifierInternals).toBeUndefined();
  });

  it('nested page object is rebuilt, not spread', () => {
    const polluted = {
      ...buildDecisionState({ task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false }),
      page: { url: 'u', type: 'article', observationState: 'OBSERVED', generation: 1, riskScore: 5 },
    } as unknown as ModelFacingDecisionState;
    expect(Object.keys(projectDecisionStateForModel(polluted).page).sort()).toEqual([
      'generation',
      'observationState',
      'type',
      'url',
    ]);
  });

  it('bounds the criteria lists', () => {
    const many = Array.from({ length: MAX_CRITERIA + 15 }, (_, i) => `criterion ${i}`);
    const s = buildDecisionState({
      task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false, pendingCriteria: many,
    });
    expect(s.pendingCriteria).toHaveLength(MAX_CRITERIA);
  });

  // The test above compares against the constant, so it stays green however the
  // constant is moved. These two pin the bound to a NUMBER, which is what the
  // contract actually promises: the model-facing decision state has a fixed
  // ceiling, so a long-running task cannot grow the prompt without limit.
  it('MAX_CRITERIA is the fixed published ceiling, not a moving one', () => {
    expect(MAX_CRITERIA).toBe(20);
    const many = Array.from({ length: 500 }, (_, i) => `criterion ${i}`);
    const s = buildDecisionState({
      task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false,
      pendingCriteria: many, completedCriteria: many,
    });
    expect(s.pendingCriteria).toHaveLength(20);
    expect(s.completedCriteria).toHaveLength(20);
    expect(projectDecisionStateForModel(s).pendingCriteria).toHaveLength(20);
  });

  it('MAX_EVIDENCE_REFERENCES is the fixed published ceiling', () => {
    expect(MAX_EVIDENCE_REFERENCES).toBe(20);
    const refs = Array.from({ length: 500 }, (_, i) => ({
      id: `ev-${i}`,
      key: `k${i}`,
      claim: `claim ${i}`,
      confidence: 0.5,
      verificationStatus: 'VERIFIED' as const,
      freshness: 'CURRENT' as const,
    }));
    const s = buildDecisionState({
      task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false, evidence: refs,
    });
    expect(s.evidence).toHaveLength(20);
    expect(projectDecisionStateForModel(s).evidence).toHaveLength(20);
  });

  it('drops blank criteria rather than passing whitespace', () => {
    const s = buildDecisionState({
      task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false, pendingCriteria: ['  ', 'real'],
    });
    expect(s.pendingCriteria).toEqual(['real']);
  });

  it('the rendered state reports counts, not raw criterion text', () => {
    const s = buildDecisionState({
      task: 't', intent: 'MIXED_TASK', requiresEvidence: true,
      pendingCriteria: ['a', 'b'], completedCriteria: ['c'],
    });
    const rendered = renderDecisionState(s);
    expect(rendered).toContain('Pending criteria: 2');
    expect(rendered).toContain('Completed criteria: 1');
    expect(rendered).not.toMatch(/pending criteria: \[/);
  });
});

// ── A3.4 — the projected state is safe to put on the wire ────────────────────

describe('A3 — the projected state carries no raw sensitive value', () => {
  it('a realistic projection passes the authoritative raw-value scanner', () => {
    const s = buildDecisionState({
      task: 'find information about charminar',
      intent: 'MIXED_TASK',
      requiresEvidence: true,
      activeSubgoal: 'Reach the Charminar article',
      pendingCriteria: ['Reach an article page'],
      completedCriteria: ['Opened search'],
      url: 'https://en.wikipedia.org/wiki/Charminar',
      pageType: 'article',
      pageObservationState: 'OBSERVED',
      pageGeneration: 2,
      lastAction: buildActionHistoryEntry(
        step({ effectVerified: true, effectStatus: 'URL_NAVIGATION_OBSERVED' }),
      ),
      destinationStatus: 'VERIFIED',
      goalStatus: 'PENDING',
      evidence: EVIDENCE,
    });
    // Scanned as an OBJECT, exactly as production does at the egress boundary
  // (`assertNoRawSensitiveValues(minimizedPayload)`). Stringifying first is not
  // what production does, and it is misleading: compact JSON collapses the whole
  // object into one whitespace-free token, which the `credential_token` rule
  // matches on its heuristics regardless of content.
  expect(scanForRawSensitiveValues(projectDecisionStateForModel(s))).toEqual([]);
  });

  it('no authority name appears anywhere in the projection', () => {
    const s = buildDecisionState({ task: 't', intent: 'ACTION_REQUEST', requiresEvidence: false });
    const json = JSON.stringify(projectDecisionStateForModel(s));
    for (const forbidden of [
      'riskScore',
      'securityCritic',
      'containment',
      'goalVerifier',
      'effectVerifier',
      'destinationVerifier',
      'm5',
    ]) {
      expect(json.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});