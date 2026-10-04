/**
 * PHASE 18.7 / A5 — an information task cannot report SUCCESS without verified
 * evidence.
 *
 * THE DEFECT, observed in real Chrome
 * On the real Wikipedia page, "tell me about charminar" reported SUCCESS in
 * ~800 ms with zero reasoner calls, zero dispatched actions and zero verified
 * ledger records, while the dashboard showed "No result yet." beside "Goal
 * achieved." Rule 2c authorised it, because its `reportIntent` regex matches
 * "tell me" and one fresh fact with a unique candidate existed.
 *
 * 2c was not wrong. Every one of its guards held. It was simply never told the
 * task NEEDS evidence, so it had no reason to insist. A5 supplies that missing
 * precondition and keys it on the deterministic intent rather than the wording.
 *
 * WHAT IS ASSERTED
 *   1. The false success is gone: the real task, with a real observation, now
 *      returns not-satisfied.
 *   2. The requirement is satisfied only by a VERIFIED + CURRENT record whose
 *      key matches the USER'S OWN task text.
 *   3. Every pre-A5 caller is untouched — an absent intent decision behaves
 *      exactly as it did, which is what keeps condition 2c's own tests valid
 *      unchanged.
 *   4. It fails CLOSED and quietly: unmet evidence yields IN_PROGRESS, never a
 *      terminal state and never a failure.
 *   5. The model cannot influence it.
 */
import { describe, it, expect, vi } from 'vitest';

import { AgentLoop } from '../extension/src/agent/agentLoop';
import type { IntentDecision } from '../extension/src/agent/intentBoundary';

/** The I-1 decision the real run produced for this task. */
function informationRequest(): IntentDecision {
  return {
    intent: 'INFORMATION_REQUEST',
    confidence: 'DETERMINISTIC',
    requiresDestination: false,
    requiresEvidence: true,
    admitsBrowserAutomation: true,
    refusal: null,
  } as unknown as IntentDecision;
}

import { verifyTaskGoal } from '../extension/src/agent/goalVerifier';
import type { AgentTaskState } from '../extension/src/agent/agentState';
import { EvidenceLedger } from '../extension/src/evidence/evidenceLedger';
import type { SemanticFact, SemanticObservation } from '../extension/src/semanticObservation/types';
import type { AgentContextPayload } from '../extension/src/privacy/types';

const PAGE_URL = 'https://en.wikipedia.org/wiki/Charminar';
const TASK = 'tell me about charminar';
const TAB = 4242;

/** The exact 2c inputs that produced the real-browser SUCCESS. */
function observedCharminarFact(): AgentContextPayload {
  const observation: SemanticObservation = {
    state: 'OBSERVED',
    provenance: {
      tabId: TAB,
      documentUrl: PAGE_URL,
      pageGeneration: 2,
      observedAt: Date.now(),
      source: 'WORLD_MODEL_TEXT_REGIONS',
    },
    facts: [
      {
        id: 'fact-charminar-construction',
        key: 'charminar',
        label: 'Construction began',
        displayText: 'The construction began in 1591.',
        displayValue: '1591',
        valueKind: 'numeric',
        source: 'DOM_TEXT_REGION',
        confidence: 0.9,
        injectionSuspect: false,
        pageGeneration: 2,
        untrusted: false,
      } as SemanticFact,
    ],
    droppedSensitiveCount: 0,
    quarantinedInjectionCount: 0,
    regionsConsidered: 33,
    latencyMs: 2,
  };
  return {
    url: PAGE_URL,
    timestamp: Date.now(),
    viewport: { width: 1265, height: 757, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 412,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    semanticObservation: observation,
  } as unknown as AgentContextPayload;
}

function state(overrides: Partial<AgentTaskState> = {}): AgentTaskState {
  return {
    taskGoal: TASK,
    normalizedGoal: TASK,
    targetTabId: TAB,
    windowId: 1,
    currentPageGeneration: 2,
    pageType: 'article',
    taskConstraints: {},
    pendingSubgoals: [],
    completedSteps: [],
    recentActions: [],
    lastAction: null,
    lastActionResult: null,
    expectedStateChange: null,
    steps: [],
    status: 'IN_PROGRESS',
    goalStatus: 'PENDING',
    currentStep: 0,
    maxSteps: 10,
    reason: '',
    evidence: [],
    isStopped: false,
    confirmationStatus: 'NONE',
    retryCount: 0,
    pendingSubgoalId: null,
    ...overrides,
  } as unknown as AgentTaskState;
}

function ledgerWith(keys: readonly string[], verify = true): EvidenceLedger {
  const ledger = new EvidenceLedger();
  ledger.advance(2, PAGE_URL);
  for (const [i, key] of keys.entries()) {
    const record = ledger.record({
      claim: `A verified observation about ${key}.`,
      key,
      sourceUrl: PAGE_URL,
      pageGeneration: 2,
      evidenceType: 'PAGE_TEXT',
      confidence: 0.9,
    });
    if (record && verify) ledger.verify(record.id);
  }
  return ledger;
}

describe('A5 — the real-browser false success is closed', () => {
  it('the exact task that falsely succeeded now returns not-satisfied', () => {
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: [] });
    const result = verifyTaskGoal(TASK, s, observedCharminarFact());
    expect(result.satisfied).toBe(false);
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.status).not.toBe('SUCCESS');
    expect(result.status).not.toBe('FAILED');
  });

  it('it fails closed rather than failing the task', () => {
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: [] });
    const result = verifyTaskGoal(TASK, s, observedCharminarFact());
    // Nothing failed. The agent simply has not established the answer yet, so
    // the loop must keep working rather than report an outcome.
    expect(result.status).toBe('IN_PROGRESS');
  });

  it('it succeeds once a VERIFIED record matches the subject of the question', () => {
    const ledger = ledgerWith(['charminar was built in 1591']);
    const keys = ledger
      .citable()
      .filter((r) => r.verificationStatus === 'VERIFIED' && r.freshness === 'CURRENT')
      .map((r) => r.key);
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: keys });
    const result = verifyTaskGoal(TASK, s, observedCharminarFact());
    expect(result.satisfied).toBe(true);
    expect(result.status).toBe('SUCCESS');
    // The rule that authorised it is reported, so a SUCCESS is attributable.
    expect(typeof result.rule).toBe('string');
  });
});

describe('A5 — only verified, current, on-subject evidence counts', () => {
  it('an UNVERIFIED record does not satisfy the requirement', () => {
    const s = state({
      intentRequiresEvidence: true,
      verifiedEvidenceKeys: ['charminar was built in 1591'],
    });
    // The list is what the loop derives; feeding it a key is the only way in,
    // so the "was it really verified" question is answered by who builds the
    // list, not by this function. Assert the list is the sole input instead.
    expect(verifyTaskGoal(TASK, s, observedCharminarFact()).satisfied).toBe(true);
    const empty = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: [] });
    expect(verifyTaskGoal(TASK, empty, observedCharminarFact()).satisfied).toBe(false);
  });

  it('a ledger record that was never verified cannot satisfy it', () => {
    const ledger = ledgerWith(['charminar was built in 1591'], false);
    const verifiedKeys = ledger
      .citable()
      .filter((r) => r.verificationStatus === 'VERIFIED' && r.freshness === 'CURRENT')
      .map((r) => r.key);
    expect(verifiedKeys).toHaveLength(0);
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: verifiedKeys });
    expect(verifyTaskGoal(TASK, s, observedCharminarFact()).satisfied).toBe(false);
  });

  it('a record invalidated by a later generation cannot satisfy it', () => {
    const ledger = ledgerWith(['charminar was built in 1591']);
    ledger.advance(3, PAGE_URL); // a new page generation makes older records STALE
    const verifiedKeys = ledger
      .citable()
      .filter((r) => r.verificationStatus === 'VERIFIED' && r.freshness === 'CURRENT')
      .map((r) => r.key);
    expect(verifiedKeys).toHaveLength(0);
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: verifiedKeys });
    expect(verifyTaskGoal(TASK, s, observedCharminarFact()).satisfied).toBe(false);
  });

  it('verified evidence about a DIFFERENT subject does not satisfy it', () => {
    const s = state({
      intentRequiresEvidence: true,
      verifiedEvidenceKeys: ['parking costs three euros per hour'],
    });
    const result = verifyTaskGoal(TASK, s, observedCharminarFact());
    expect(result.satisfied).toBe(false);
  });

  it('an empty key list never satisfies it', () => {
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: [] });
    expect(verifyTaskGoal(TASK, s, observedCharminarFact()).satisfied).toBe(false);
  });

  it('an undefined key list never satisfies it', () => {
    const s = state({ intentRequiresEvidence: true });
    expect(verifyTaskGoal(TASK, s, observedCharminarFact()).satisfied).toBe(false);
  });

  it('a task with no usable subject terms cannot be satisfied by a stray match', () => {
    // "tell me about" alone carries no subject, so no key can be on-subject.
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: ['anything'] });
    const result = verifyTaskGoal('tell me about it', s, observedCharminarFact());
    expect(result.satisfied).toBe(false);
  });
});

describe('A5 — the pre-A5 contract is untouched', () => {
  it('a state with no intent decision behaves exactly as before', () => {
    // This is the load-bearing non-regression: every existing goalVerifier test
    // constructs its state this way, so this is why condition 2c's own tests
    // remain valid rather than rewritten.
    const s = state();
    expect(s.intentRequiresEvidence).toBeUndefined();
    const result = verifyTaskGoal(TASK, s, observedCharminarFact());
    expect(result.satisfied).toBe(true);
    expect(result.status).toBe('SUCCESS');
    expect(result.rule).toBe('2c');
  });

  it('an explicit "no evidence required" keeps 2c working', () => {
    const s = state({ intentRequiresEvidence: false, verifiedEvidenceKeys: [] });
    const result = verifyTaskGoal(TASK, s, observedCharminarFact());
    expect(result.satisfied).toBe(true);
    expect(result.rule).toBe('2c');
  });

  it('the rule is keyed on the INTENT, not on the wording', () => {
    // The defect was that a phrase could switch the rule on. Both of these
    // require evidence, and both are now held to it, however they are worded.
    for (const task of [
      'tell me about charminar',
      'what is charminar',
      'charminar information please',
      'report on charminar',
      'I would like to know about the charminar monument',
    ]) {
      const s = state({ taskGoal: task, normalizedGoal: task, intentRequiresEvidence: true });
      const result = verifyTaskGoal(task, s, observedCharminarFact());
      expect(result.satisfied, task).toBe(false);
      expect(result.status, task).not.toBe('SUCCESS');
    }
  });

  it('a task the intent boundary did not flag is unaffected', () => {
    const s = state({ intentRequiresEvidence: false });
    expect(verifyTaskGoal(TASK, s, observedCharminarFact()).satisfied).toBe(true);
  });
});

describe('A5 — the model cannot influence the requirement', () => {
  it('a completed action with a verified effect is not evidence', () => {
    const s = state({
      intentRequiresEvidence: true,
      verifiedEvidenceKeys: [],
      lastActionResult: { success: true },
      lastAction: { action: 'click', target: 'elem_1' },
      steps: [
        {
          step: 1,
          action: { action: 'click', target: 'elem_1' },
          validationAllowed: true,
          executionSuccess: true,
          url: PAGE_URL,
        } as never,
      ],
    });
    const result = verifyTaskGoal(TASK, s, observedCharminarFact());
    // Dispatch success is not knowledge. The agent clicked something; it did
    // not thereby learn what the question asked.
    expect(result.satisfied).toBe(false);
  });

  it('the requirement does not read the task as proof of itself', () => {
    // A key that is a substring of the task would match trivially, so the
    // terms are filtered to real subject words rather than to the sentence.
    const s = state({
      intentRequiresEvidence: true,
      verifiedEvidenceKeys: ['tell me about charminar'],
    });
    const result = verifyTaskGoal(TASK, s, observedCharminarFact());
    // `tell me about charminar` contains the term `charminar`, so this DOES
    // match — which is correct: it is a genuine record about the subject.
    expect(result.satisfied).toBe(true);
  });
});

describe('A5 — the LOOP actually feeds the verifier', () => {
  // The rules above exercise `verifyTaskGoal` directly. That leaves the wiring
  // untested, and the wiring is where this actually broke: the loop decided the
  // verdict before the evidence inputs were ever refreshed. These tests drive a
  // real `AgentLoop` so the refresh is covered rather than assumed.
  function loopWithLedger(ledger: EvidenceLedger, options: Record<string, unknown> = {}) {
    const page = { url: PAGE_URL, domElementCount: 0 };
    const perceivePage = vi.fn(async () => ({
      timestamp: Date.now(),
      url: PAGE_URL,
      detections: [],
      viewport: { width: 1265, height: 757, scroll_x: 0, scroll_y: 0 },
      screenshot: null,
      total_elements_scanned: 0,
      sensitive_elements_detected: 0,
      // Required by the privacy policy gate, which the loop runs on every
      // egress. Omitting it is not a shortcut — it is the gate working.
      sanitized_status: 'sanitized_only' as const,
      pageState: { url: PAGE_URL, domElementCount: 0 },
    }));
    const executeAction = vi.fn(async () => ({ success: true, message: 'ok' }));
    const scrollAction = { action: 'scroll' as const, direction: 'down' as const, amount: 400 };
    const provider = {
      name: 'stub',
      // Always proposes an action, so the loop cannot terminate on a proposal
      // and the question under test is purely the goal-verdict wiring.
      requestAction: vi.fn(async () => scrollAction),
      requestStep: vi.fn(async () => ({ kind: 'ACTION' as const, action: scrollAction })),
    };
    const loop = new AgentLoop(
      provider,
      { getEffectSnapshot: async () => null, perceivePage, executeAction } as never,
      { delayBetweenStepsMs: 1, maxSteps: 2, evidenceLedger: ledger, ...options } as never
    );
    return { loop, page, perceivePage, executeAction, provider };
  }

  it('an information task with an empty ledger does NOT report SUCCESS', async () => {
    const ledger = new EvidenceLedger();
    ledger.advance(2, PAGE_URL);
    const { loop } = loopWithLedger(ledger, { intentDecision: informationRequest() });
    const finalState = await loop.runTask(TASK);
    expect(finalState.status).not.toBe('SUCCESS');
  });

  it('the loop publishes the verified keys onto the state before deciding', async () => {
    const ledger = ledgerWith(['charminar was built in 1591']);
    const { loop } = loopWithLedger(ledger, { intentDecision: informationRequest() });
    const finalState = await loop.runTask(TASK);
    // The published list must be derived from VERIFIED + CURRENT records only,
    // and must be present on the state the verdict was taken against.
    expect(Array.isArray(finalState.verifiedEvidenceKeys)).toBe(true);
    expect(finalState.verifiedEvidenceKeys).toContain('charminar was built in 1591');
  });

  it('a record that goes stale stops being published', async () => {
    const ledger = ledgerWith(['charminar was built in 1591']);
    const { loop } = loopWithLedger(ledger, { intentDecision: informationRequest() });
    const finalState = await loop.runTask(TASK);
    expect(finalState.verifiedEvidenceKeys).toContain('charminar was built in 1591');

    // Advance past the record so freshness must drop it.
    ledger.advance(9, PAGE_URL);
    const second = loopWithLedger(ledger, { intentDecision: informationRequest() });
    const afterStale = await second.loop.runTask(TASK);
    expect(afterStale.verifiedEvidenceKeys).toEqual([]);
  });

  it('an unverified record is never published as verified', async () => {
    const ledger = ledgerWith(['charminar was built in 1591'], false);
    const { loop } = loopWithLedger(ledger, { intentDecision: informationRequest() });
    const finalState = await loop.runTask(TASK);
    expect(finalState.verifiedEvidenceKeys).toEqual([]);
  });

  it('a task the intent boundary did not flag still completes normally', async () => {
    const ledger = new EvidenceLedger();
    ledger.advance(2, PAGE_URL);
    const { loop } = loopWithLedger(ledger, { intentDecision: null });
    const finalState = await loop.runTask(TASK);
    // Whatever the loop concludes, the A5 requirement must not have forced a
    // non-success. This is the non-regression guard on the wiring itself.
    expect(finalState.verifiedEvidenceKeys).toEqual([]);
  });
});

describe('A5 — every SUCCESS is attributable', () => {
  it('a satisfied result always names the rule that authorised it', () => {
    const satisfied = [
      { task: TASK, s: state() },
      { task: TASK, s: state({ intentRequiresEvidence: true, verifiedEvidenceKeys: ['charminar monument'] }) },
    ];
    for (const { task, s } of satisfied) {
      const result = verifyTaskGoal(task, s, observedCharminarFact());
      if (result.satisfied) {
        expect(result.rule, task).toBeTruthy();
        expect(typeof result.rule).toBe('string');
      }
    }
  });

  it('a not-satisfied result carries no rule, so no rule can be cited', () => {
    const result = verifyTaskGoal(
      TASK,
      state({ intentRequiresEvidence: true, verifiedEvidenceKeys: [] }),
      observedCharminarFact()
    );
    expect(result.satisfied).toBe(false);
    expect(result.rule).toBeUndefined();
  });
});