/**
 * PrivAgent — PHASE 17.8 D-01 REMEDIATION: privacy refusal trace reliability.
 *
 * THE DEFECT THIS FILE PINS
 * ─────────────────────────
 * Every `AgentDecisionTracer.recordStep` entry carries `proposedAction: action`,
 * and the tracer runs the raw-value firewall over the WHOLE entry. So when the
 * model proposes an action containing a raw value — an email in a `type`
 * action's text — the trace that exists to RECORD THE REFUSAL is itself
 * rejected for carrying that value, and `PrivacyBoundaryError` escapes
 * `runTask`.
 *
 * The security decision was already correct and stayed correct: M5 refused, and
 * nothing was ever dispatched. What broke is reliability — a safe refusal
 * became an unhandled exception, and the task ended with no state, no reason
 * and no trace at all.
 *
 * WHY THERE IS A FALLBACK MARKER BUT NO FALLBACK TRACE ENTRY
 * ──────────────────────────────────────────────────────────
 * `DecisionTraceEntry.proposedAction` is required, so a "safe" entry would have
 * to invent a placeholder action. Writing a fabricated proposal into an
 * explainability trace is the exact class of fabrication this project exists to
 * refuse, so the detailed entry is WITHHELD rather than replaced, and a
 * value-free marker records that it was. The refusal itself is unaffected: it
 * is already recorded in `state.steps` and `state.reason`, neither of which
 * runs the wire firewall.
 *
 * THE TEST THAT MATTERS MOST
 * ──────────────────────────
 * `an unrelated tracer error still propagates` — if this one regresses, the fix
 * has silently become "ignore every tracing error", which would be worse than
 * the original defect because it would also hide genuine bugs in the audit path.
 *
 * WHAT D-01 DID NOT COVER — A KNOWN LIMITATION, NOT A PASSED ASSERTION
 * ───────────────────────────────────────────────────────────────────
 * The brief asked that no raw PII appear "anywhere in the resulting state".
 * Written that literally it does NOT hold, and it did not hold before D-01
 * either: `state.steps[].action` — the loop's own in-memory StepRecord, not
 * the decision trace — stores the full proposed action, so a refused `type`
 * action leaves its text in task state. The `KNOWN LIMITATION` test below
 * pins that behaviour precisely rather than quietly narrowing the assertion to
 * make it green.
 *
 * It was deliberately not fixed here. The value is never dispatched, never
 * traced, never sent to a provider and never rendered to a dashboard — all
 * asserted below — and closing the gap means changing the loop's step-record
 * data model, which is a different defect with a different blast radius and is
 * outside the "smallest contained change" this remediation is scoped to. It is
 * reported for a follow-up decision instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { AgentLoop } from '../../extension/src/agent/agentLoop';
import { AgentDecisionTracer } from '../../extension/src/agent/decisionTrace';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { PrivacyBoundaryError } from '../../extension/src/privacy/rawValueScanner';
import { ctx, det, scope } from '../../evaluation/phase17_8/fixtures';
import type { AgentContextPayload } from '../../extension/src/privacy/types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';

const ORIGIN = 'https://shop.example';
const CHECKOUT = `${ORIGIN}/checkout`;

/** Synthetic, structurally valid, and never present in the sanitized context. */
const RAW_EMAIL = 'recipient@example.com';
const RAW_CARD = '4111111111111111';

const context: AgentContextPayload = ctx({
  url: CHECKOUT,
  detections: [
    det('in-email', 'input', { label: 'Recipient email' }),
    // Present so the "M5 is still an authority" checks have a benign action
    // that is genuinely grounded. `btn-pay` is deliberately absent, so the
    // ordinary-refusal test below still refuses on Grounding, not on privacy.
    det('btn-help', 'button', { label: 'Help' }),
  ],
  total_elements_scanned: 2,
});

/** A type action carrying a raw value in its text. Refused by M5. */
const piiProposal = {
  action: 'type',
  target: 'in-email',
  text: RAW_EMAIL,
  reason: 'Fill in the recipient email address',
} as unknown as BrowserAction;

interface RunResult {
  dispatched: BrowserAction[];
  state: Awaited<ReturnType<AgentLoop['runTask']>>;
  loop: AgentLoop;
  /** True when runTask rejected rather than returning a state. */
  threw: boolean;
  thrownName: string | null;
}

async function runLoop(proposal: unknown, maxSteps = 1): Promise<RunResult> {
  const dispatched: BrowserAction[] = [];
  const loop = new AgentLoop(
    {
      name: 'D01Provider',
      requestAction: async () => proposal as never,
      registerFailure: () => {},
      resetEscalation: () => {},
    },
    {
      perceivePage: async () => context,
      getEffectSnapshot: async () => null,
      executeAction: async (a) => {
        dispatched.push(a);
        return { success: true };
      },
    },
    {
      maxSteps,
      maxRetries: 1,
      delayBetweenStepsMs: 0,
      targetTabId: 7,
      initialUrl: CHECKOUT,
      containmentScope: scope(),
    },
  );

  try {
    const state = await loop.runTask('Fill in the recipient email address');
    return { dispatched, state, loop, threw: false, thrownName: null };
  } catch (err) {
    return {
      dispatched,
      state: null as never,
      loop,
      threw: true,
      thrownName: err instanceof Error ? err.name : 'UnknownError',
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1-3 · THE PRECONDITION: M5 refuses, and the tracer genuinely throws
// ═══════════════════════════════════════════════════════════════════════════

describe('D-01 · precondition', () => {
  it('1. the PII-bearing action reaches M5, and 2. M5 refuses it', () => {
    const v = validateAction(piiProposal, context);
    expect(v.allowed).toBe(false);
    // The refusal reason is M5's, and it is value-free.
    expect(v.reason).toBeTruthy();
    expect(v.reason).not.toContain(RAW_EMAIL);
  });

  it('3. the decision tracer really does throw PrivacyBoundaryError on such a proposal', () => {
    // Asserted directly, so the loop-level tests below cannot pass merely
    // because the tracer stopped throwing for an unrelated reason.
    const tracer = new AgentDecisionTracer('d01-precondition');
    expect(() =>
      tracer.recordStep({
        step: 1,
        goal: 'Fill in the recipient email address',
        proposedAction: piiProposal,
        riskAssessment: { riskLevel: 'LOW', score: 0, requiresConfirmation: false },
        structuralValidation: { passed: false, reason: 'M5 refused the proposal.' },
        semanticVerification: { verified: false, confidence: 0, alignment: 'UNKNOWN', reason: 'M5 refused the proposal.' },
        confidenceEvaluation: { confidenceScore: 0, directive: 'BLOCK', explanation: 'M5 refused the proposal.' },
        finalOutcome: 'FAILED',
      }),
    ).toThrow(PrivacyBoundaryError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4-7 · THE FIX
// ═══════════════════════════════════════════════════════════════════════════

describe('D-01 · the refusal is recorded and the task survives', () => {
  let r: RunResult;

  beforeEach(async () => {
    r = await runLoop(piiProposal);
  });

  it('4. PrivacyBoundaryError does NOT escape runTask', () => {
    expect(r.threw, `runTask rejected with ${r.thrownName}`).toBe(false);
    expect(r.state).toBeTruthy();
  });

  it('5. the task remains in a refusal/failure state, not SUCCESS', () => {
    expect(r.state.status).toBe('FAILED');
    expect(r.state.status).not.toBe('SUCCESS');
    expect(r.state.goalStatus).not.toBe('SUCCESS');
  });

  it('6. the refused action is NOT dispatched', () => {
    expect(r.dispatched).toEqual([]);
  });

  it('7. no SUCCESS is produced anywhere in the state', () => {
    const serialized = JSON.stringify(r.state);
    expect(serialized).not.toContain('"SUCCESS"');
  });

  it('8. the withheld trace is reported as withheld, with a value-free marker', () => {
    expect(r.loop.withheldDecisionTraceSteps).toBe(1);
  });

  it('9. no raw PII appears anywhere on the AUDITED surface of the result', () => {
    // D-01 is a defect in the AUDIT path, so the audit path is what is asserted
    // exhaustively here: the decision trace, the reason a host would display,
    // the failure records, and every rendered field of the step record. All of
    // it is value-free, including when the detailed trace entry was withheld.
    const audited = JSON.stringify({
      decisionTraceSummary: r.state.decisionTraceSummary,
      reason: r.state.reason,
      lastFailure: r.state.lastFailure,
      failureHistory: r.state.failureHistory,
      steps: r.state.steps.map((s) => ({
        step: s.step,
        targetId: s.targetId,
        validationAllowed: s.validationAllowed,
        validationReason: s.validationReason,
        executionSuccess: s.executionSuccess,
        executionError: s.executionError,
        expectedStateChange: s.expectedStateChange,
      })),
    });
    expect(audited).not.toContain(RAW_EMAIL);
    expect(audited).not.toContain(RAW_CARD);
    expect(audited).not.toContain('@example.com');
  });

  // ── FOLLOW-UP, NOW CLOSED: retained step state no longer keeps the raw value ──
  it('the refused action is NO LONGER retained verbatim in the in-memory step record', () => {
    // HISTORY. This test used to assert the OPPOSITE and was named
    // `KNOWN LIMITATION`. The defect it pinned was real and predated D-01:
    // `state.steps[].action` held the live `BrowserAction`, so a refused action
    // left its whole `text` in task state. Task state is what `getState()`
    // returns and what the service worker hands to `sendToDashboard`, so it was
    // a retention site on a real egress path, not merely a long-lived local.
    //
    // The follow-up replaced the retained action with a value-free projection.
    // This test now PROVES the raw value is gone while the step is still
    // present and still auditable — see the positive control in the dedicated
    // improvement suite.
    const step = r.state.steps[0]!;
    expect(step.validationAllowed).toBe(false);
    expect('text' in step.action ? (step.action as { text?: string }).text : undefined).toBeUndefined();
    expect(JSON.stringify(r.state)).not.toContain(RAW_EMAIL);
    // The privacy-relevant counterweight is unchanged.
    expect(r.dispatched).toEqual([]);
    expect(r.state.decisionTraceSummary?.entries ?? []).toEqual([]);
  });

  it('the refusal itself is still recorded in state, with a reason', () => {
    // The trace entry was withheld; the refusal was not. This is the property
    // that makes withholding acceptable rather than a loss.
    expect(r.state.steps.length).toBeGreaterThan(0);
    expect(r.state.steps[0]!.validationAllowed).toBe(false);
    expect(String(r.state.reason ?? '')).not.toContain(RAW_EMAIL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 · THE TEST THAT MATTERS MOST
// ═══════════════════════════════════════════════════════════════════════════

describe('D-01 · the fix is narrow', () => {
  const original = AgentDecisionTracer.prototype.recordStep;

  afterEach(() => {
    AgentDecisionTracer.prototype.recordStep = original;
  });

  it('10. an UNRELATED tracer error still propagates normally', async () => {
    // If this regresses, the remediation has become "ignore every tracing
    // error" — which would also hide genuine bugs in the audit path.
    AgentDecisionTracer.prototype.recordStep = function throwingUnrelated(this: never) {
      throw new Error('unrelated tracer fault');
    } as unknown as typeof AgentDecisionTracer.prototype.recordStep;

    const r = await runLoop(piiProposal);
    expect(r.threw, 'an unrelated tracer error was swallowed').toBe(true);
    expect(r.thrownName).toBe('Error');
  });

  it('a normal M5 refusal with a functioning tracer behaves exactly as before', async () => {
    // A refusal that does NOT carry a raw value takes the ordinary path: the
    // trace is written, nothing is withheld, and nothing is dispatched.
    const plainRefusal = {
      action: 'click',
      target: 'btn-pay',
      reason: 'Pay the invoice for Aria Vasquez',
    } as unknown as BrowserAction;

    const r = await runLoop(plainRefusal);
    expect(r.threw).toBe(false);
    expect(r.dispatched).toEqual([]);
    expect(r.state.status).not.toBe('SUCCESS');
    // Nothing was withheld, because the tracer could write this entry.
    expect(r.loop.withheldDecisionTraceSteps).toBe(0);
  });

  it('an unrelated error in the refusal path is not converted into a withheld trace', async () => {
    AgentDecisionTracer.prototype.recordStep = function throwingUnrelated(this: never) {
      throw new TypeError('a different fault entirely');
    } as unknown as typeof AgentDecisionTracer.prototype.recordStep;

    const r = await runLoop({
      action: 'click',
      target: 'btn-pay',
      reason: 'Submit the order',
    } as unknown as BrowserAction);
    expect(r.threw).toBe(true);
    expect(r.thrownName).toBe('TypeError');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NO REGRESSION IN THE AUTHORITIES
// ═══════════════════════════════════════════════════════════════════════════

describe('D-01 · the authorities are untouched', () => {
  it('M5 still refuses exactly the same inputs', () => {
    expect(validateAction(piiProposal, context).allowed).toBe(false);
    expect(validateAction({ action: 'type', target: 'in-email', text: RAW_CARD }, context).allowed).toBe(false);
    expect(validateAction({ action: 'disable_privacy', target: 'in-email' }, context).allowed).toBe(false);
  });

  it('a benign action is still allowed by M5', () => {
    expect(validateAction({ action: 'click', target: 'btn-help', reason: 'Open the help centre' }, context).allowed).toBe(
      true,
    );
  });

  it('the withheld marker carries no action, page text or model output', async () => {
    // Asserted on what is actually emitted, not on the source: the marker is
    // captured from the log call the loop makes when it withholds a trace.
    const captured: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      const r = await runLoop(piiProposal);
      expect(r.loop.withheldDecisionTraceSteps).toBe(1);
    } finally {
      console.info = originalInfo;
    }

    const withheld = captured.filter((a) => a[0] === '[AgentTrace] decision trace withheld');
    expect(withheld).toHaveLength(1);

    const marker = withheld[0]![1] as Record<string, unknown>;
    // EXACTLY two fields. If a payload, page text or model output is ever
    // added to the marker, the key-set assertion below is what notices.
    expect(Object.keys(marker).sort()).toEqual(['reason', 'step']);
    // The only string in the marker is a fixed constant; the only other value
    // is the step index. Nothing is interpolated from the action or the page.
    expect(Object.entries(marker).filter(([, v]) => typeof v === 'string')).toEqual([
      ['reason', 'RAW_VALUE_IN_PROPOSAL'],
    ]);
    expect(marker.step).toBe(1);

    const serialized = JSON.stringify(withheld);
    for (const raw of [RAW_EMAIL, RAW_CARD, 'example.com', 'in-email', 'Recipient email', 'checkout']) {
      expect(serialized).not.toContain(raw);
    }
  });
});
