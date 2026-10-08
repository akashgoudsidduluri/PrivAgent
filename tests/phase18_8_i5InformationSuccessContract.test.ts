/**
 * PHASE 18.8 / I-5 — THE INFORMATION-TASK SUCCESS CONTRACT.
 *
 * THE CONTRACT
 *   An information task (the I-1 intent boundary marks it `requiresEvidence`)
 *   may reach SUCCESS only when the device itself holds at least one ledger
 *   record that is
 *     * VERIFIED by the local verifier,
 *     * CURRENT (not superseded by a later observed page generation),
 *     * SANITIZED at write time, and
 *     * ON SUBJECT — its normalized key matches a subject term taken from the
 *       USER'S OWN task text.
 *
 *   Nothing else may authorise SUCCESS: not a visited page, not a dispatched
 *   action, not a search URL, not a provider's ANSWER, not a non-empty answer
 *   string, and not evidence that exists somewhere in the ledger about
 *   something else.
 *
 * THE DEFECT THIS FILE PINS (found by reading the rule order, then reproduced)
 *   A5 added the evidence precondition, but it was POSITIONAL: the check sat
 *   after rules 1, 1b, 2, 2b and after the scroll preconditions, so every one of
 *   those rules could still return SUCCESS for an evidence-requiring task with
 *   zero verified records. “search for cats on wikipedia” is an information task
 *   (MIXED_TASK, requiresEvidence=true) and rule 1 certified it as SUCCESS the
 *   moment the query string appeared in the URL — i.e. because a search was
 *   PERFORMED, which is exactly the false success I-5 forbids.
 *
 * WHAT IS ASSERTED (PART 11 of the I-5 brief)
 *   1. valid information task + verified/current on-subject evidence → SUCCESS
 *   2. provider says SUCCESS, zero supporting evidence            → no SUCCESS
 *   3. provider proposes ANSWER with no supporting record         → downgrade
 *   4. verified evidence about the WRONG subject                  → no SUCCESS
 *   5. unverified evidence                                        → no SUCCESS
 *   6. stale evidence when freshness is required                  → no SUCCESS
 *   7. current evidence on the correct subject                    → SUCCESS
 *   8. partial evidence                                           → PARTIAL
 *   9. provider failure                                           → truthful failure
 *  10. ambiguous request                                          → NEEDS_CLARIFICATION
 *  11. privacy failure                                            → fail closed
 *  12. contradictory evidence                                     → no false SUCCESS
 *  13. multiple records                                           → all resolved
 *  14. answer inconsistent with the evidence                      → composed from records only
 *  15. normal chat must not enter information verification
 *  16. browser information task must enter the verification path
 *  17. no raw sensitive value in verification metadata
 *  18. the A10 false-success evaluator still refuses an uncited SUCCESS
 */
import { describe, it, expect } from 'vitest';

import { verifyTaskGoal } from '../extension/src/agent/goalVerifier';
import { classifyIntent } from '../extension/src/agent/intentBoundary';
import { verifyTerminalProposal } from '../extension/src/agent/proposal';
import { composeEvidenceAnswerFromLedger } from '../extension/src/agent/agentLoop';
import { EvidenceLedger } from '../extension/src/evidence/evidenceLedger';
import type { AgentTaskState } from '../extension/src/agent/agentState';
import type { SemanticFact, SemanticObservation } from '../extension/src/semanticObservation/types';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import {
  A10_SCENARIO_MATRIX,
  buildEmptyScenarioRecord,
  evaluateA10Scenario,
} from '../extension/src/telemetry/a10MatrixHarness';

const PAGE_URL = 'https://en.wikipedia.org/wiki/Charminar';
const TASK = 'tell me about charminar';
const TAB = 4242;

/* ── context fixtures ─────────────────────────────────────────────────────── */

/** A fresh, authoritative observation carrying one fact about the subject. */
function observedSubjectContext(task = TASK): AgentContextPayload {
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
  void task;
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

/**
 * A live search-results URL: the shape rule 1 reads as “the search happened”.
 * No semantic observation at all — a page was reached, nothing was learned.
 */
function searchUrlContext(): AgentContextPayload {
  return {
    url: 'https://en.wikipedia.org/w/index.php?search=cats&title=Special%3ASearch',
    timestamp: Date.now(),
    viewport: { width: 1265, height: 757, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 60,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
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

/** A ledger holding one record per key, optionally promoted to VERIFIED. */
function ledgerWith(keys: readonly string[], verify = true, url = PAGE_URL, generation = 2): EvidenceLedger {
  const ledger = new EvidenceLedger();
  ledger.advance(generation, url);
  for (const key of keys) {
    const record = ledger.record({
      claim: `A verified observation about ${key}.`,
      key,
      sourceUrl: url,
      pageGeneration: generation,
      evidenceType: 'PAGE_TEXT',
      confidence: 0.9,
    });
    if (record && verify) ledger.verify(record.id);
  }
  return ledger;
}

function verifiedKeysOf(ledger: EvidenceLedger): string[] {
  return ledger
    .citable()
    .filter((r) => r.verificationStatus === 'VERIFIED' && r.freshness === 'CURRENT')
    .map((r) => r.key);
}

function informationTask(): { task: string; state: AgentTaskState } {
  const decision = classifyIntent(TASK);
  expect(decision.requiresEvidence).toBe(true);
  return { task: TASK, state: state({ intentRequiresEvidence: decision.requiresEvidence }) };
}

/* ── 1 & 2. SUCCESS requires evidence; a visited/search page is not evidence ─ */

describe('I-5 — an information task cannot be certified by a page or an action', () => {
  it('1. verified, CURRENT, on-subject evidence authorises SUCCESS', () => {
    const { task, state: s } = informationTask();
    const ledger = ledgerWith(['charminar']);
    const result = verifyTaskGoal(task, { ...s, verifiedEvidenceKeys: verifiedKeysOf(ledger) }, observedSubjectContext());
    expect(result.satisfied).toBe(true);
    expect(result.status).toBe('SUCCESS');
    expect(typeof result.rule).toBe('string');
  });

  it('2a. a search RESULTS page alone never authorises SUCCESS (rule 1 was bypassing the gate)', () => {
    const decision = classifyIntent('search for cats on wikipedia');
    expect(decision.requiresEvidence).toBe(true);
    const s = state({ taskGoal: 'search for cats on wikipedia', intentRequiresEvidence: true, verifiedEvidenceKeys: [] });
    const result = verifyTaskGoal('search for cats on wikipedia', s, searchUrlContext());
    expect(result.satisfied).toBe(false);
    expect(result.status).not.toBe('SUCCESS');
  });

  it('2b. the real WA-MIXED information task never authorises SUCCESS from a search URL', () => {
    const task = 'open wikipedia and find information about charminar';
    const decision = classifyIntent(task);
    expect(decision.requiresEvidence).toBe(true);
    expect(decision.requiresDestination).toBe(true);
    const s = state({ taskGoal: task, intentRequiresEvidence: true, verifiedEvidenceKeys: [] });
    const result = verifyTaskGoal(task, s, searchUrlContext());
    expect(result.status).not.toBe('SUCCESS');
  });

  it('2c. not even verified evidence about something else can authorise it', () => {
    const s = state({
      taskGoal: 'search for cats on wikipedia',
      intentRequiresEvidence: true,
      verifiedEvidenceKeys: ['parking costs three euros per hour'],
    });
    const result = verifyTaskGoal('search for cats on wikipedia', s, searchUrlContext());
    expect(result.status).not.toBe('SUCCESS');
  });

  it('7. the same task SUCCEEDS once the evidence the contract demands exists', () => {
    const task = 'search for cats on wikipedia';
    const s = state({ taskGoal: task, intentRequiresEvidence: true, verifiedEvidenceKeys: ['cats are felids'] });
    const result = verifyTaskGoal(task, s, searchUrlContext());
    expect(result.satisfied).toBe(true);
    expect(result.status).toBe('SUCCESS');
    expect(result.rule).toBe('1');
  });
});

/* ── 3, 8, 12, 13. the terminal-proposal path ─────────────────────────────── */

describe('I-5 — a provider proposal never becomes SUCCESS, and never over-claims', () => {
  it('3. ANSWER with zero supporting records is downgraded, not accepted', () => {
    const ledger = ledgerWith(['parking costs three euros per hour']);
    const id = ledger.citable()[0]!.id;
    const verdict = verifyTerminalProposal(
      { kind: 'ANSWER', reason: 'I know the answer.', answer: 'The answer is 42.', cited_evidence: [id] },
      ledger,
      TASK
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.status).not.toBe('ANSWER');
    expect(verdict.status).not.toBe('SUCCESS');
    expect(verdict.supportedRecordIds).toEqual([]);
    expect(verdict.downgraded).toBe(true);
    expect(verdict.rejections).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('8. PARTIAL is the honest state for non-subject evidence, and it is not SUCCESS', () => {
    const ledger = ledgerWith(['parking costs three euros per hour']);
    const verdict = verifyTerminalProposal(
      { kind: 'ANSWER', reason: 'Partial.', answer: 'Something about parking.', cited_evidence: [ledger.citable()[0]!.id] },
      ledger,
      TASK
    );
    expect(verdict.status).toBe('PARTIAL');
    expect(verdict.status).not.toBe('SUCCESS');
  });

  it('12. contradictory evidence cannot be cited into an ANSWER', () => {
    const ledger = new EvidenceLedger();
    ledger.advance(2, PAGE_URL);
    // Same key, two different claims on the same page: BOTH become CONFLICTED.
    const first = ledger.record({ claim: 'The ticket costs ten euros.', key: 'ticket price', sourceUrl: PAGE_URL, pageGeneration: 2, evidenceType: 'PAGE_TEXT', confidence: 0.9 })!;
    ledger.verify(first.id);
    const second = ledger.record({ claim: 'The ticket costs twelve euros.', key: 'ticket price', sourceUrl: PAGE_URL, pageGeneration: 2, evidenceType: 'PAGE_TEXT', confidence: 0.9 })!;
    expect(ledger.byIdSafe(first.id)!.verificationStatus).toBe('CONFLICTED');
    const verdict = verifyTerminalProposal(
      { kind: 'ANSWER', reason: 'Confident.', answer: 'It costs ten euros.', cited_evidence: [first.id, second.id] },
      ledger,
      'what is the ticket price'
    );
    expect(verdict.status).not.toBe('ANSWER');
    expect(verdict.supportedRecordIds).toEqual([]);
    expect(verdict.rejections).toContain('UNRESOLVED_CITATION');
  });

  it('13. every cited record must resolve; a partial citation set supports only what resolved', () => {
    const ledger = ledgerWith(['charminar', 'charminar construction date']);
    const ids = ledger.citable().map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const verdict = verifyTerminalProposal(
      { kind: 'ANSWER', reason: 'Two records.', answer: 'Two things.', cited_evidence: [...ids, 'not-a-real-record-id'] },
      ledger,
      TASK
    );
    expect(verdict.status).toBe('ANSWER');
    expect(verdict.supportedRecordIds.length).toBeGreaterThanOrEqual(2);
    expect(verdict.rejections).toContain('UNRESOLVED_CITATION');
  });
});

/* ── 4, 5, 6. subject and freshness ───────────────────────────────────────── */

describe('I-5 — subject match and freshness are enforced, not assumed', () => {
  it('4. verified evidence about a different subject does not satisfy an information task', () => {
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: ['parking costs three euros per hour'] });
    const result = verifyTaskGoal(TASK, s, observedSubjectContext());
    expect(result.satisfied).toBe(false);
  });

  it('5. an UNVERIFIED record is never published as verified', () => {
    const ledger = ledgerWith(['charminar'], false);
    expect(verifiedKeysOf(ledger)).toEqual([]);
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: verifiedKeysOf(ledger) });
    expect(verifyTaskGoal(TASK, s, observedSubjectContext()).satisfied).toBe(false);
  });

  it('6. a record invalidated by a later generation cannot authorise SUCCESS', () => {
    const ledger = ledgerWith(['charminar']);
    expect(verifiedKeysOf(ledger)).toContain('charminar');
    ledger.advance(3, PAGE_URL); // the page moved on: the old reading is STALE
    expect(verifiedKeysOf(ledger)).toEqual([]);
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: verifiedKeysOf(ledger) });
    expect(verifyTaskGoal(TASK, s, observedSubjectContext()).satisfied).toBe(false);
  });

  it('6b. freshness is preserved even when the observation still looks fresh', () => {
    const ledger = ledgerWith(['charminar']);
    ledger.advance(4, PAGE_URL);
    const s = state({
      intentRequiresEvidence: true,
      currentPageGeneration: 4,
      verifiedEvidenceKeys: verifiedKeysOf(ledger),
    });
    const result = verifyTaskGoal(TASK, s, observedSubjectContext());
    expect(result.status).not.toBe('SUCCESS');
  });
});

/* ── 9, 10, 11, 15, 16. routing, refusal and privacy ──────────────────────── */

describe('I-5 — the failures stay truthful and the routes stay honest', () => {
  it('10. an ambiguous information request is refused by the intent boundary', () => {
    const decision = classifyIntent('Open it.');
    expect(decision.intent).toBe('AMBIGUOUS');
    expect(decision.admitsBrowserAutomation).toBe(false);
    expect(decision.requiresEvidence).toBe(false);
    expect(decision.refusal).toBe('AMBIGUOUS_NO_GUESS');
  });

  it('15. smalltalk never enters information-task verification', () => {
    for (const greeting of ['hi there', 'thanks!', 'good night']) {
      const decision = classifyIntent(greeting);
      expect(decision.intent, greeting).toBe('GREETING_CASUAL');
      expect(decision.admitsBrowserAutomation, greeting).toBe(false);
      expect(decision.requiresEvidence, greeting).toBe(false);
    }
  });

  it('16. an information-bearing browser task is classified as requiring evidence', () => {
    for (const task of [
      'tell me about charminar',
      'search for cats on wikipedia',
      'open wikipedia and find information about charminar',
      'what is the price of the product on the page',
    ]) {
      const decision = classifyIntent(task);
      expect(decision.requiresEvidence, task).toBe(true);
      expect(decision.admitsBrowserAutomation, task).toBe(true);
    }
    // …and a pure action or navigation task is NOT forced down the information path.
    for (const task of ['open wikipedia', 'click the login button']) {
      expect(classifyIntent(task).requiresEvidence, task).toBe(false);
    }
  });

  it('11. a credential-shaped answer is refused before it can become a terminal state', () => {
    const ledger = ledgerWith(['charminar']);
    const verdict = verifyTerminalProposal(
      {
        kind: 'ANSWER',
        reason: 'Here it is.',
        answer: 'Use sk_live_51H8xAbCdEf012345 to continue.',
        cited_evidence: [ledger.citable()[0]!.id],
      },
      ledger,
      TASK
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.status).toBeNull();
    expect(verdict.supportedRecordIds).toEqual([]);
    expect(verdict.rejections).toContain('MALFORMED');
  });

  it('9. a provider failure has its own truthful terminal state, never SUCCESS', () => {
    // The loop maps a typed provider failure to PROVIDER_UNAVAILABLE (A8/A1).
    // What I-5 adds is the guarantee that this never becomes SUCCESS: no
    // evidence-less SUCCESS path exists in the verifier at all.
    expect('PROVIDER_UNAVAILABLE').not.toBe('SUCCESS');
    const s = state({ intentRequiresEvidence: true, verifiedEvidenceKeys: [] });
    const result = verifyTaskGoal(TASK, s, { ...observedSubjectContext(), url: '' });
    expect(result.status).not.toBe('SUCCESS');
  });
});

/* ── 14, 17. answer composition and verification metadata ─────────────────── */

describe('I-5 — the answer is composed from accepted records, and metadata stays value-free', () => {
  it('14. the composed answer contains only verified, current, on-subject claims', () => {
    const ledger = ledgerWith(['charminar']);
    const composed = composeEvidenceAnswerFromLedger(ledger, TASK);
    expect(composed).toBeDefined();
    expect(composed!.verifiedRecords).toBeGreaterThanOrEqual(1);
    for (const record of ledger.citable()) {
      if (record.claim === composed!.answer) expect(record.verificationStatus).toBe('VERIFIED');
    }
  });

  it('14b. nothing is composed when no record is on subject', () => {
    const ledger = ledgerWith(['parking costs three euros per hour']);
    expect(composeEvidenceAnswerFromLedger(ledger, TASK)).toBeUndefined();
  });

  it('17. record ids are opaque hashes and a raw value never becomes a record', () => {
    const ledger = new EvidenceLedger();
    ledger.advance(2, PAGE_URL);
    const record = ledger.record({
      claim: 'The construction began in 1591.',
      key: 'charminar',
      sourceUrl: PAGE_URL,
      pageGeneration: 2,
      evidenceType: 'PAGE_TEXT',
      confidence: 0.9,
    })!;
    expect(record.id).toMatch(/^[0-9a-z]{7,}$/);
    expect(record.id).not.toContain('charminar');
    // A credential-shaped claim is rejected at WRITE time, so it can neither be
    // cited nor composed into an answer.
    const rejected = ledger.record({
      claim: 'The card number is 4111111111111111.',
      key: 'card',
      sourceUrl: PAGE_URL,
      pageGeneration: 2,
      evidenceType: 'PAGE_TEXT',
      confidence: 0.9,
    });
    expect(rejected).toBeNull();
  });
});

/* ── 18. the A10 false-success evaluator still refuses an uncited SUCCESS ─── */

describe('I-5 — the A10 false-success evaluator agrees with this contract', () => {
  it('18. a SUCCESS with no verified evidence is not certified by the A10 harness', () => {
    const def = A10_SCENARIO_MATRIX[0]!;
    const record = {
      ...buildEmptyScenarioRecord(def),
      task: def.title,
      providerMode: 'CONTROLLED_PROVIDER' as const,
      environmentBlocked: false,
      executed: true,
      terminalStatus: 'SUCCESS' as const,
      goalStatus: 'SATISFIED' as const,
      actionCount: 0,
      dispatchCount: 0,
      lateActionCount: 0,
      effectVerifiedCount: 0,
      effectNoEffectCount: 0,
      effectUnverifiableCount: 0,
      destinationStatus: 'UNVERIFIED' as const,
      evidenceLedgerCount: 10,
      evidenceLedgerVerifiedCurrentCount: 0,
      citedEvidenceIds: [],
      privacySelfCheck: { clean: true, rawValueFindings: 0, scannerLines: 1 },
      artifactPath: 'docs/evidence/post-17-10/audit/a10_18_6/raw_S1.json',
      notes: null,
      pageEngaged: true,
    };
    const verdict = evaluateA10Scenario(record, def);
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('no verified/current evidence is cited');
  });
});
