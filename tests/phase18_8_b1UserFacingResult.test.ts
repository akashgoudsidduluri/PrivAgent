/**
 * PHASE 18.8 / B1 — THE USER-FACING RESULT.
 *
 * The projection already reported lifecycle, timeline and terminal outcome, but
 * it had no ANSWER surface: an information task could end `ANSWER` while the
 * dashboard showed "No result yet.", and a failed run rendered the loop's raw
 * internal `state.reason` (recovery codes, gate prose, provider payloads) in the
 * result box.
 *
 * B1 adds a typed `finalResult` card to the projection contract:
 *
 *   * `kind` is the closed result vocabulary (ANSWER is NOT SUCCESS);
 *   * `body` is either the answer composed from LOCAL verified evidence or
 *     fixed, user-safe copy — never `state.reason`;
 *   * `provenance` is a count and a host, never a URL or a value;
 *   * `remaining` is bounded fixed copy;
 *   * the card crosses the SAME `screenAgentOutput` boundary as every other
 *     user-facing field, and a corrupt card fails closed with the whole payload.
 *
 * These tests pin the ten contracts plus the regressions that protect A10-F1,
 * A10-F2, A5/I-5, provider-failure handling and the privacy seam.
 */
import { describe, it, expect } from 'vitest';

import {
  projectAgentOutput,
  screenAgentOutput,
  type AgentInteractionState,
  type AgentResultKind,
} from '../extension/src/agent/agentOutput';
import {
  createAgentTaskState,
  userFacingMessageForStatus,
  type AgentTaskState,
} from '../extension/src/agent/agentState';
import {
  composeEvidenceAnswerFromLedger,
  MAX_EVIDENCE_ANSWER_CLAIMS,
} from '../extension/src/agent/agentLoop';
import { EvidenceLedger } from '../extension/src/evidence/evidenceLedger';

const TASK = 'history of charminar';
const IN_SCOPE = 'https://en.wikipedia.org/wiki/Charminar';
const DEFAULT_FAILURE_COPY =
  'The task could not be completed. I stopped safely without repeating actions.';
const EFFECT_UNVERIFIABLE_COPY =
  "I couldn't verify whether the action took effect, so I stopped without repeating it.";

/** A realistic state. Tests override exactly one field at a time. */
function baseState(over: Partial<AgentTaskState> = {}): AgentTaskState {
  const s = createAgentTaskState(TASK, { maxSteps: 10, maxRetries: 2, targetTabId: 7 });
  s.currentUrl = IN_SCOPE;
  s.perceptionGeneration = 1;
  s.currentPageGeneration = 1;
  s.planningEngineState = 'CHROME_EXECUTION';
  return { ...s, ...over };
}

function provenance(verifiedRecords: number, sourceHost: string | null = 'en.wikipedia.org') {
  return { verifiedRecords, sourceHost };
}

function recoveryRecord(category: 'EFFECT_UNVERIFIABLE' | 'NO_EFFECT' | 'OSCILLATION') {
  return {
    failureCategory: category,
    previousActionResult: null,
    observationState: 'CURRENT' as const,
    madeProgress: false,
    strategyFrom: 'CONTINUE' as const,
    strategyTo: 'RE_PERCEIVE' as const,
    retryCount: 1,
    reasonCode: 'EFFECT_NOT_OBSERVABLE' as const,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The answer states render the answer the device verified
// ─────────────────────────────────────────────────────────────────────────────
describe('B1-1 an ANSWER is a useful result, not an empty panel', () => {
  it('1.1 ANSWER renders the composed answer, its headline and provenance', () => {
    const s = baseState({
      status: 'ANSWER',
      answer: 'The Charminar is a monument in Hyderabad, completed in 1591.',
      answerProvenance: provenance(5),
    });
    const out = projectAgentOutput(s);
    expect(out.outcome).toBe('ANSWERED');
    expect(out.terminal?.reason).toBe('ANSWERED');
    expect(out.finalResult.kind).toBe('ANSWER');
    expect(out.finalResult.headline).toBe('Answer');
    expect(out.finalResult.body).toBe('The Charminar is a monument in Hyderabad, completed in 1591.');
    expect(out.finalResult.provenance).toBe(
      'Based on 5 locally verified observation(s) from en.wikipedia.org.'
    );
    expect(out.finalResult.remaining).toEqual([]);

    // The card survives the egress sweep unchanged.
    const screened = screenAgentOutput(out);
    expect(screened.verdict).toBe('CLEAR');
    expect(screened.output.finalResult.body).toBe(s.answer);
  });

  it('1.2 an ANSWER with no composed body never fabricates one', () => {
    const out = projectAgentOutput(baseState({ status: 'ANSWER' }));
    expect(out.finalResult.kind).toBe('ANSWER');
    expect(out.finalResult.body).toBeNull();
    expect(out.finalResult.provenance).toBeNull();
  });
});

describe('B1-2 a PARTIAL answer keeps what was verified and names what was not', () => {
  it('2.1 PARTIAL carries the partial answer and the remaining note', () => {
    const s = baseState({
      status: 'PARTIAL',
      answer: 'It was completed in 1591.',
      answerProvenance: provenance(1),
    });
    const out = projectAgentOutput(s);
    expect(out.outcome).toBe('ANSWERED');
    expect(out.terminal?.reason).toBe('ANSWERED');
    expect(out.finalResult.kind).toBe('PARTIAL');
    expect(out.finalResult.headline).toBe('Partly answered');
    expect(out.finalResult.body).toBe('It was completed in 1591.');
    expect(out.finalResult.remaining).toEqual([
      'Some of what was asked could not be verified on this page.',
    ]);
  });
});

describe('B1-3 an unverifiable outcome says so in user language', () => {
  it('3.1 CANNOT_VERIFY uses the approved sentence and leaks no gate prose', () => {
    const s = baseState({
      status: 'CANNOT_VERIFY',
      reason: 'EVIDENCE_GATE: no verified subject evidence after 3 steps',
    });
    const out = projectAgentOutput(s);
    expect(out.outcome).toBe('UNANSWERED');
    expect(out.terminal?.reason).toBe('NO_VERIFIABLE_RESULT');
    expect(out.finalResult.kind).toBe('CANNOT_VERIFY');
    expect(out.finalResult.body).toBe(userFacingMessageForStatus('CANNOT_VERIFY'));
    expect(out.finalResult.provenance).toBeNull();
    expect(JSON.stringify(out.finalResult)).not.toContain('EVIDENCE_GATE');
  });

  it('3.2 NEEDS_INFORMATION uses the approved sentence', () => {
    const s = baseState({
      status: 'NEEDS_INFORMATION',
      reason: 'subject not present in sanitized perception',
    });
    const out = projectAgentOutput(s);
    expect(out.outcome).toBe('UNANSWERED');
    expect(out.terminal?.reason).toBe('NO_VERIFIABLE_RESULT');
    expect(out.finalResult.kind).toBe('NEEDS_INFORMATION');
    expect(out.finalResult.body).toBe(userFacingMessageForStatus('NEEDS_INFORMATION'));
    expect(JSON.stringify(out.finalResult)).not.toContain('sanitized perception');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Failures and provider outages are explained, never quoted
// ─────────────────────────────────────────────────────────────────────────────
describe('B1-4 a FAILED run shows user-safe copy, never the internal reason', () => {
  it('4.1 the raw reason (recovery codes, strategy names) never reaches the card', () => {
    const s = baseState({
      status: 'FAILED',
      reason:
        "Unrecognized failure code 'EFFECT_UNVERIFIABLE' from recovery engine (CONTINUE->RE_PERCEIVE)",
    });
    const out = projectAgentOutput(s);
    expect(out.outcome).toBe('FAILED');
    expect(out.finalResult.kind).toBe('FAILED');
    expect(out.finalResult.body).toBe(DEFAULT_FAILURE_COPY);

    const card = JSON.stringify(out.finalResult);
    expect(card).not.toContain('Unrecognized failure code');
    expect(card).not.toContain('EFFECT_UNVERIFIABLE');
    expect(card).not.toContain('RE_PERCEIVE');
    expect(card).not.toContain('recovery engine');
  });

  it('4.2 an unmapped failure category still resolves to fixed copy', () => {
    const s = baseState({
      status: 'FAILED',
      reason: 'some internal prose',
      lastFailure: {
        category: 'TARGET_NOT_FOUND',
        reason: 'internal record text',
        pageGeneration: 1,
        recoveryAttempted: false,
        finalState: 'FAILED',
        timestamp: 1,
      },
    });
    const out = projectAgentOutput(s);
    expect(out.finalResult.kind).toBe('FAILED');
    expect(out.finalResult.body).toBe(DEFAULT_FAILURE_COPY);
    expect(JSON.stringify(out.finalResult)).not.toContain('internal record text');
  });
});

describe('B1-5 a provider outage is reported as a provider outage', () => {
  it('5.1 PROVIDER_UNAVAILABLE never renders the provider payload', () => {
    const s = baseState({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'Groq returned HTTP 502 model_contract: invalid action payload',
    });
    const out = projectAgentOutput(s);
    expect(out.outcome).toBe('FAILED');
    expect(out.terminal?.reason).toBe('REASONER_FAILED');
    expect(out.finalResult.kind).toBe('PROVIDER_UNAVAILABLE');
    expect(out.finalResult.body).toBe(userFacingMessageForStatus('PROVIDER_UNAVAILABLE'));

    const card = JSON.stringify(out.finalResult);
    expect(card).not.toContain('Groq');
    expect(card).not.toContain('502');
    expect(card).not.toContain('model_contract');
  });

  it('5.2 a typed reasoner failure reaches the same card from FAILED', () => {
    const s = baseState({
      status: 'FAILED',
      reason: 'provider rate limit exceeded',
      lastFailure: {
        category: 'LLM_RATE_LIMIT',
        reason: '429 from upstream',
        pageGeneration: 1,
        recoveryAttempted: false,
        finalState: 'FAILED',
        timestamp: 1,
      },
    });
    const out = projectAgentOutput(s);
    expect(out.terminal?.reason).toBe('REASONER_FAILED');
    expect(out.finalResult.kind).toBe('PROVIDER_UNAVAILABLE');
    expect(out.finalResult.body).toBe(userFacingMessageForStatus('PROVIDER_UNAVAILABLE'));
    expect(JSON.stringify(out.finalResult)).not.toContain('429');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Internal recovery codes are vocabulary, not copy
// ─────────────────────────────────────────────────────────────────────────────
describe('B1-6 recovery categories become fixed sentences (A10-F2 regression)', () => {
  function exhausted(
    category: 'EFFECT_UNVERIFIABLE' | 'NO_EFFECT' | 'OSCILLATION' | null
  ): AgentTaskState {
    return baseState({
      status: 'FAILED',
      reason: 'recovery exhausted: internal prose that must not surface',
      lastFailure: {
        category: 'RECOVERY_EXHAUSTED',
        reason: 'internal record',
        pageGeneration: 1,
        recoveryAttempted: true,
        finalState: 'FAILED',
        timestamp: 1,
      },
      recoveryRecords: category ? [recoveryRecord(category)] : [],
      totalRecoveryAttempts: 1,
    });
  }

  it('6.1 EFFECT_UNVERIFIABLE renders the honest sentence, not the code', () => {
    const out = projectAgentOutput(exhausted('EFFECT_UNVERIFIABLE'));
    expect(out.finalResult.kind).toBe('FAILED');
    expect(out.finalResult.body).toBe(EFFECT_UNVERIFIABLE_COPY);

    const card = JSON.stringify(out.finalResult);
    expect(card).not.toContain('EFFECT_UNVERIFIABLE');
    expect(card).not.toContain('RE_PERCEIVE');
    expect(card).not.toContain('EFFECT_NOT_OBSERVABLE');
    expect(card).not.toContain('RECOVERY_EXHAUSTED');
    expect(card).not.toContain('recovery exhausted');
  });

  it('6.2 NO_EFFECT and OSCILLATION get their own user sentences', () => {
    const noEffect = projectAgentOutput(exhausted('NO_EFFECT')).finalResult;
    expect(noEffect.body).toBe(
      'The page did not change when I acted on it, so I stopped instead of repeating the same action.'
    );
    const osc = projectAgentOutput(exhausted('OSCILLATION')).finalResult;
    expect(osc.body).toBe(
      'I kept going back and forth without making progress, so I stopped instead of looping.'
    );
    for (const card of [noEffect, osc]) {
      expect(JSON.stringify(card)).not.toContain('NO_EFFECT');
      expect(JSON.stringify(card)).not.toContain('OSCILLATION');
    }
  });

  it('6.3 exhaustion with no typed record falls back to the recovery sentence', () => {
    const out = projectAgentOutput(exhausted(null));
    expect(out.finalResult.body).toBe(
      'The page stopped responding to the actions I tried, so I stopped instead of repeating them.'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The card crosses the privacy boundary like every other field
// ─────────────────────────────────────────────────────────────────────────────
describe('B1-7 raw sensitive values never reach the final result', () => {
  it('7.1 a sensitive value in the composed answer is redacted in place', () => {
    const s = baseState({
      status: 'ANSWER',
      answer: 'The card on file is 4111 1111 1111 1111.',
      answerProvenance: provenance(2),
    });
    const screened = screenAgentOutput(projectAgentOutput(s));
    expect(screened.verdict).toBe('REDACTED');
    expect(screened.findings).toBeGreaterThan(0);
    expect(JSON.stringify(screened.output)).not.toContain('4111');
    expect(screened.output.finalResult.body).toBe('withheld by output screening');
  });

  it('7.2 a sensitive value in the internal reason never reaches the card at all', () => {
    const s = baseState({
      status: 'FAILED',
      reason: 'M5 refused because the text contained a raw PAN 4111111111111111',
    });
    const out = projectAgentOutput(s);
    expect(JSON.stringify(out.finalResult)).not.toContain('4111');
    expect(out.finalResult.body).toBe(DEFAULT_FAILURE_COPY);
  });

  it('7.3 a corrupt structural field drops the whole payload and keeps the card safe', () => {
    const out = projectAgentOutput(
      baseState({ status: 'ANSWER', answer: 'Verified answer.', answerProvenance: provenance(1) })
    );
    const tampered: AgentInteractionState = {
      ...out,
      finalResult: { ...out.finalResult, headline: 'card 4111 1111 1111 1111' },
    };
    const screened = screenAgentOutput(tampered);
    expect(screened.verdict).toBe('BLOCKED');
    expect(JSON.stringify(screened.output)).not.toContain('4111');
    expect(screened.output.outcome).toBe('FAILED');
    expect(screened.output.finalResult.kind).toBe('FAILED');
    expect(screened.output.finalResult.body).toBe(DEFAULT_FAILURE_COPY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The card is additive: the timeline and the outcome stay consistent
// ─────────────────────────────────────────────────────────────────────────────
describe('B1-8 the final result is additive and consistent with the timeline', () => {
  it('8.1 the operational timeline survives beside the result card', () => {
    const s = baseState({ status: 'FAILED', reason: 'internal' });
    s.steps = [
      {
        step: 1,
        action: { action: 'click', target: 'go' } as never,
        validationAllowed: true,
        validationReason: 'ok',
        executionSuccess: true,
        url: IN_SCOPE,
        timestamp: 1,
      },
    ];
    const out = projectAgentOutput(s);
    expect(out.timeline).toHaveLength(1);
    expect(out.timeline[0]!.action).toBe('click');
    expect(out.timeline[0]!.outcome).toBe('EXECUTED');
    expect(out.finalResult.kind).toBe('FAILED');
    expect(screenAgentOutput(out).output.timeline).toHaveLength(1);
  });

  it('8.2 every terminal status maps to exactly one card kind and outcome', () => {
    const cases: Array<{
      status: AgentTaskState['status'];
      kind: AgentResultKind;
      outcome: AgentInteractionState['outcome'];
      terminal: boolean;
    }> = [
      { status: 'ANSWER', kind: 'ANSWER', outcome: 'ANSWERED', terminal: true },
      { status: 'PARTIAL', kind: 'PARTIAL', outcome: 'ANSWERED', terminal: true },
      { status: 'CANNOT_VERIFY', kind: 'CANNOT_VERIFY', outcome: 'UNANSWERED', terminal: true },
      { status: 'NEEDS_INFORMATION', kind: 'NEEDS_INFORMATION', outcome: 'UNANSWERED', terminal: true },
      { status: 'SUCCESS', kind: 'SUCCESS', outcome: 'SUCCEEDED', terminal: true },
      { status: 'FAILED', kind: 'FAILED', outcome: 'FAILED', terminal: true },
      { status: 'PROVIDER_UNAVAILABLE', kind: 'PROVIDER_UNAVAILABLE', outcome: 'FAILED', terminal: true },
      { status: 'STOPPED', kind: 'STOPPED', outcome: 'STOPPED', terminal: true },
      { status: 'IN_PROGRESS', kind: 'NONE', outcome: 'RUNNING', terminal: false },
    ];
    for (const c of cases) {
      const out = projectAgentOutput(baseState({ status: c.status }));
      expect(out.finalResult.kind, c.status).toBe(c.kind);
      expect(out.outcome, c.status).toBe(c.outcome);
      expect(out.terminal !== null, c.status).toBe(c.terminal);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Regressions: the answer itself is composed from LOCAL verified evidence
// ─────────────────────────────────────────────────────────────────────────────
describe('B1-9 A10-F1 / A5 regression — the card renders the ledger answer', () => {
  function ledger(
    claims: readonly { key: string; claim: string; verified?: boolean }[]
  ): EvidenceLedger {
    const l = new EvidenceLedger();
    l.advance(1, IN_SCOPE);
    for (const c of claims) {
      const rec = l.record({
        claim: c.claim,
        key: c.key,
        sourceUrl: IN_SCOPE,
        pageGeneration: 1,
        evidenceType: 'SEMANTIC_FACT',
        confidence: 0.9,
      });
      if (rec && c.verified !== false) l.verify(rec.id);
    }
    return l;
  }

  it('9.1 only verified, current, on-subject claims compose the answer', () => {
    const l = ledger([
      { key: 'charminar-completed', claim: 'The Charminar was completed in 1591.' },
      { key: 'charminar-city', claim: 'It stands in Hyderabad, India.' },
      { key: 'charminar-gossip', claim: 'An unverified claim about the monument.', verified: false },
      { key: 'golconda-fort', claim: 'Off-subject claim.' },
    ]);
    const composed = composeEvidenceAnswerFromLedger(l, TASK);
    expect(composed).toBeDefined();
    expect(composed!.verifiedRecords).toBe(2);
    expect(composed!.answer).toContain('1591');
    expect(composed!.answer).not.toContain('Off-subject');
    expect(composed!.answer).not.toContain('unverified claim');

    // Exactly what the loop hands the projection after an A5 goal-satisfied run.
    const s = baseState({
      status: 'SUCCESS',
      answer: composed!.answer,
      answerProvenance: provenance(composed!.verifiedRecords),
    });
    const out = projectAgentOutput(s);
    expect(out.finalResult.kind).toBe('SUCCESS');
    expect(out.finalResult.body).toBe(composed!.answer);
    expect(out.finalResult.provenance).toBe(
      'Based on 2 locally verified observation(s) from en.wikipedia.org.'
    );
  });

  it('9.2 no evidence means no answer, never a fabricated one', () => {
    expect(composeEvidenceAnswerFromLedger(null, TASK)).toBeUndefined();
    expect(composeEvidenceAnswerFromLedger(new EvidenceLedger(), TASK)).toBeUndefined();

    const out = projectAgentOutput(baseState({ status: 'SUCCESS' }));
    expect(out.finalResult.kind).toBe('SUCCESS');
    expect(out.finalResult.body).toBeNull();
    expect(out.finalResult.provenance).toBeNull();
  });

  it('9.3 the composed answer is bounded to the claim budget', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      key: `charminar-fact-${i}`,
      claim: `Verified fact ${i} about the monument.`,
    }));
    const composed = composeEvidenceAnswerFromLedger(ledger(many), TASK);
    expect(composed).toBeDefined();
    expect(composed!.verifiedRecords).toBe(MAX_EVIDENCE_ANSWER_CLAIMS);
  });
});
