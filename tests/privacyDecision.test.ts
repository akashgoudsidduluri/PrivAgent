/**
 * PrivAgent — M8 Centralized Privacy Decision Policy Test Suite
 *
 * Verifies the ONE place where transmission decisions are made:
 *   1. Credentials/OTP → NEVER_TRANSMIT; payment/government-ID → REDACT;
 *      phone/email/name → MINIMIZE; unknown → FAIL_CLOSED.
 *   2. The core invariant: `rawValueTransmissible` is false for EVERY decision.
 *   3. Fail-closed escalation: unknown categories and below-threshold
 *      confidence can never obtain a weaker verdict.
 *   4. Fusion never weakens privacy: the strongest severity wins.
 *   5. The summary is aggregate metadata only (no values).
 *
 * No network, no live LLM, synthetic data only.
 */

import { describe, it, expect } from 'vitest';
import {
  CATEGORY_POLICY,
  decideTransmission,
  policyForCategory,
  severityForCategory,
  severityRank,
  summarizeDecisions,
  PolicyDecisionRecord,
} from '../extension/src/privacy/privacyDecision';
import type { PrivacyCategory } from '../extension/src/privacy/fusion';

type DecisionCategory = Parameters<typeof decideTransmission>[0]['category'];

function decide(category: string, confidence = 0.95, sources: Array<'dom' | 'ocr' | 'visual'> = ['dom']) {
  return decideTransmission({
    category: category as DecisionCategory,
    confidence,
    sources,
  });
}

function policyEntry(category: string) {
  return CATEGORY_POLICY[category as PrivacyCategory]!;
}

describe('Category policy table (M8)', () => {
  it('covers every known category plus unknown and the reserved face policy', () => {
    // The interactive-affordance entries (button/link/input/search/select/
    // form/heading/element) were deliberately added to the policy in commit
    // f80fa7f: they are structural metadata only (id, type, selector, geometry)
    // and are required for any target grounding to work live. The list below
    // mirrors CATEGORY_POLICY's actual, audited keys.
    const expected = [
      'password', 'cvv', 'otp', 'credit_card', 'pan', 'account_number',
      'face', 'phone', 'email', 'person_name', 'address', 'unknown',
      'button', 'link', 'input', 'search', 'select', 'form', 'heading', 'element',
    ];
    expect(Object.keys(CATEGORY_POLICY).sort()).toEqual(expected.sort());
  });

  it('interactive affordances are MINIMIZE with exportable metadata and no redaction', () => {
    for (const category of ['button', 'link', 'input', 'search', 'select', 'form', 'heading', 'element']) {
      expect(policyEntry(category).decision).toBe('MINIMIZE');
      expect(policyEntry(category).exportableMetadata).toBe(true);
      expect(policyEntry(category).mustRedact).toBe(false);
      expect(policyEntry(category).severity).toBe('low');
    }
  });

  it('credentials, OTP and CVV are NEVER_TRANSMIT', () => {
    for (const category of ['password', 'cvv', 'otp']) {
      expect(policyEntry(category).decision).toBe('NEVER_TRANSMIT');
      expect(policyEntry(category).mustRedact).toBe(true);
    }
  });

  it('payment cards, PAN and account numbers are REDACT', () => {
    for (const category of ['credit_card', 'pan', 'account_number']) {
      expect(policyEntry(category).decision).toBe('REDACT');
      expect(policyEntry(category).mustRedact).toBe(true);
    }
  });

  it('phone, email and names are MINIMIZE (metadata only, never values)', () => {
    for (const category of ['phone', 'email', 'person_name']) {
      expect(policyEntry(category).decision).toBe('MINIMIZE');
      expect(policyEntry(category).exportableMetadata).toBe(true);
    }
  });

  it('unknown and face categories fail closed / are redacted', () => {
    expect(CATEGORY_POLICY['unknown']!.decision).toBe('FAIL_CLOSED');
    expect(CATEGORY_POLICY['unknown']!.exportableMetadata).toBe(false);
    expect(CATEGORY_POLICY['face']!.decision).toBe('REDACT');
    expect(CATEGORY_POLICY['face']!.mustRedact).toBe(true);
  });
});

describe('decideTransmission — the core invariant', () => {
  it('rawValueTransmissible is false for EVERY decision, no exceptions', () => {
    const decisions: PolicyDecisionRecord[] = [
      decide('password', 1.0),
      decide('credit_card', 0.98),
      decide('phone', 0.92),
      decide('email', 0.97),
      decide('person_name', 0.9),
      decide('account_number', 0.94),
      decide('pan', 0.95),
      decide('cvv', 0.92),
      decide('otp', 0.92),
      decide('unknown', 0.9),
      decide('phone', 0.2), // fail-closed escalation
    ];
    for (const record of decisions) {
      expect(record.rawValueTransmissible).toBe(false);
    }
  });

  it('returns the category policy verdict for confident known categories', () => {
    expect(decide('password', 1.0).decision).toBe('NEVER_TRANSMIT');
    expect(decide('credit_card', 0.98).decision).toBe('REDACT');
    expect(decide('phone', 0.92).decision).toBe('MINIMIZE');
    expect(decide('phone', 0.92).code).toBe('policy.category');
    expect(decide('phone', 0.92).failClosed).toBe(false);
  });

  it('escalates below-threshold confidence to FAIL_CLOSED (fail closed)', () => {
    const record = decide('phone', 0.3);
    expect(record.decision).toBe('FAIL_CLOSED');
    expect(record.failClosed).toBe(true);
    expect(record.exportableMetadata).toBe(false);
    expect(record.mustRedact).toBe(true);
    expect(record.code).toBe('policy.uncertain_low_confidence');
  });

  it('never lets a low-confidence credential become exportable', () => {
    // Even at the threshold boundary the credential stays NEVER_TRANSMIT;
    // below it, it is fail-closed — both are stricter than MINIMIZE.
    expect(decide('password', 0.5).decision).toBe('NEVER_TRANSMIT');
    expect(decide('password', 0.49).decision).toBe('FAIL_CLOSED');
  });

  it('fails closed for unknown categories regardless of confidence', () => {
    const record = decide('some_future_category', 1.0);
    expect(record.decision).toBe('FAIL_CLOSED');
    expect(record.code).toBe('policy.unknown_category');
    expect(record.exportableMetadata).toBe(false);
  });

  it('is deterministic: identical input yields the identical verdict', () => {
    expect(decide('credit_card', 0.98)).toEqual(decide('credit_card', 0.98));
  });
});

describe('Severity ladder (fusion never weakens privacy)', () => {
  it('ranks unknown (fail-closed) as strongest, then critical/high/medium/low', () => {
    expect(severityRank('unknown')).toBeGreaterThan(severityRank('critical'));
    expect(severityRank('critical')).toBeGreaterThan(severityRank('high'));
    expect(severityRank('high')).toBeGreaterThan(severityRank('medium'));
    expect(severityRank('medium')).toBeGreaterThan(severityRank('low'));
  });

  it('maps categories to severities consistently via policyForCategory', () => {
    expect(severityForCategory('password')).toBe('critical');
    expect(severityForCategory('account_number')).toBe('high');
    expect(severityForCategory('phone')).toBe('medium');
    // Unregistered future category resolves to the fail-closed unknown policy.
    expect(policyForCategory('not_a_category' as never).decision).toBe('FAIL_CLOSED');
  });
});

describe('summarizeDecisions — aggregate metadata only', () => {
  it('counts decisions by category, source and verdict without any values', () => {
    const summary = summarizeDecisions([
      decide('password', 1.0),
      decide('credit_card', 0.98, ['dom', 'ocr']),
      decide('phone', 0.92),
      decide('unknown', 0.9),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.neverTransmit).toBe(1);
    expect(summary.minimized).toBe(1);
    expect(summary.failClosed).toBe(1);
    expect(summary.redacted).toBe(3); // password + credit_card + unknown mustRedact
    expect(summary.byCategory.credit_card).toBe(1);
    expect(summary.bySource.ocr).toBe(1);
    expect(summary.byDecision.NEVER_TRANSMIT).toBe(1);
    expect(summary.byDecision.FAIL_CLOSED).toBe(1);
  });

  it('returns an empty summary for an empty record list', () => {
    const summary = summarizeDecisions([]);
    expect(summary.total).toBe(0);
    expect(summary.neverTransmit).toBe(0);
  });
});
