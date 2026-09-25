/**
 * PrivAgent — Centralized Privacy Decision Policy (M8)
 *
 * The ONE place where "what may happen to this category of sensitive
 * information" is decided. It sits AFTER fusion (so it sees unified, multi-source
 * evidence) and BEFORE context minimization (which obeys these verdicts).
 *
 *   DOM ─┐
 *   OCR ─┼─→ fusion.ts ──→ privacyDecision.ts ──→ contextMinimizer.ts ──→ provider
 *   Vis ─┘                    (this file)
 *
 * ── The invariant this layer exists to guarantee ─────────────────────────────
 *
 *   A RAW SENSITIVE VALUE MUST NEVER REACH THE REMOTE REASONING PROVIDER.
 *
 * `rawValueTransmissible` is therefore `false` for EVERY decision, including
 * MINIMIZE. Providers historically reasoned over redacted-value METADATA (id,
 * category, confidence, geometry, counts) and that remains the only category of
 * page information any provider may receive.
 *
 * Decisions:
 *   NEVER_TRANSMIT — credential / payment / OTP / government-ID data. The value
 *                    is never transmissible; the element stays locally redacted
 *                    and its redacted metadata may still be referenced.
 *   REDACT         — must be locally redacted (in addition to the global rule).
 *   MINIMIZE       — lower-risk PII: allowed into context only as minimized
 *                    metadata, never as a value.
 *   FAIL_CLOSED    — unknown, uncertain, or below-confidence findings. Not
 *                    allowed into context at all and always redacted locally.
 *
 * Deterministic and pure: identical input always yields the identical verdict.
 */

import type { FindingSource, PrivacyCategory, PrivacySeverity } from './fusion';

export type TransmissionDecision = 'NEVER_TRANSMIT' | 'REDACT' | 'MINIMIZE' | 'FAIL_CLOSED';

export interface CategoryPolicy {
  decision: TransmissionDecision;
  severity: PrivacySeverity;
  /** Region must be locally redacted (M2 redaction layer). */
  mustRedact: boolean;
  /**
   * May this finding's METADATA (never its value) enter sanitized context and
   * therefore reach a reasoning provider?
   */
  exportableMetadata: boolean;
  /**
   * Minimum detector confidence for this category to be actionable. Below it the
   * finding is treated as uncertain and fails closed.
   */
  minConfidence: number;
  /** Human-readable justification. MUST NOT contain raw values. */
  rationale: string;
}

const SEVERITY_RANK: Record<PrivacySeverity, number> = {
  unknown: 4,
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** Numeric severity ordering (higher = more severe). */
export function severityRank(severity: PrivacySeverity): number {
  return SEVERITY_RANK[severity];
}

/**
 * Category policy table. Keys mirror the project's SensitiveEntityType plus
 * 'face' and 'unknown'.
 *
 * 'face':
 *   RESERVED. No face detector exists in M1–M3 today, so this entry is
 *   deliberately dormant — it documents the required verdict ("faces are
 *   redacted and never exported") so a future visual face detector inherits the
 *   correct, already-tested policy instead of inventing a weaker one.
 */
/**
 * Shared policy for interactive affordances (buttons, links, inputs, ...).
 *
 * These findings are structural, not semantic: they describe WHERE a control is
 * and WHAT KIND it is, never WHAT it contains. The M8 exporter copies no value
 * and no free-text label for them, so exporting their metadata grants the
 * reasoner no page content — it can locate a control, not read it.
 */
const INTERACTIVE_POLICY: CategoryPolicy = {
  decision: 'MINIMIZE',
  severity: 'low',
  mustRedact: false,
  exportableMetadata: true,
  minConfidence: 0.5,
  rationale:
    'Interactive affordances carry no sensitive value; only structural metadata (id, type, selector, geometry) is exported so actions can be grounded locally.',
};

export const CATEGORY_POLICY: Record<string, CategoryPolicy> = {
  password: {
    decision: 'NEVER_TRANSMIT',
    severity: 'critical',
    mustRedact: true,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Credentials must never be transmitted externally.',
  },
  cvv: {
    decision: 'NEVER_TRANSMIT',
    severity: 'critical',
    mustRedact: true,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Card security codes must never be transmitted externally.',
  },
  otp: {
    decision: 'NEVER_TRANSMIT',
    severity: 'critical',
    mustRedact: true,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'One-time passcodes must never be transmitted externally.',
  },
  credit_card: {
    decision: 'REDACT',
    severity: 'critical',
    mustRedact: true,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Payment card numbers are locally redacted and never transmitted.',
  },
  pan: {
    decision: 'REDACT',
    severity: 'critical',
    mustRedact: true,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Government identifiers are locally redacted and never transmitted.',
  },
  account_number: {
    decision: 'REDACT',
    severity: 'high',
    mustRedact: true,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Financial account numbers are locally redacted and never transmitted.',
  },
  face: {
    decision: 'REDACT',
    severity: 'high',
    mustRedact: true,
    exportableMetadata: true,
    minConfidence: 0.4,
    rationale: 'Biometric regions are locally redacted and never transmitted (reserved policy).',
  },
  phone: {
    decision: 'MINIMIZE',
    severity: 'medium',
    mustRedact: false,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Phone numbers are minimized; only redacted metadata may leave the device.',
  },
  email: {
    decision: 'MINIMIZE',
    severity: 'medium',
    mustRedact: false,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Email addresses are minimized; only redacted metadata may leave the device.',
  },
  person_name: {
    decision: 'MINIMIZE',
    severity: 'medium',
    mustRedact: false,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Personal names are minimized; only redacted metadata may leave the device.',
  },
  address: {
    decision: 'REDACT',
    severity: 'medium',
    mustRedact: true,
    exportableMetadata: true,
    minConfidence: 0.5,
    rationale: 'Physical and billing residential addresses are protected on-device.',
  },
  // ── Interactive affordances ────────────────────────────────────────────────
  // Browser controls carry NO sensitive value: the frozen M4 contract exports
  // only id, type, selector, confidence, geometry, length and visibility. The
  // reasoner needs these metadata to ground an action at all — without them the
  // local grounding gate can never resolve a real click/type target, so the
  // agent is blind and the security pipeline is never even reached.
  //
  // These entries do NOT weaken the boundary: no value is ever attached, the
  // raw-value firewall still scans the exported payload, and any category that
  // is not listed here (including a future unregistered one) still fails closed.
  button: INTERACTIVE_POLICY,
  link: INTERACTIVE_POLICY,
  input: INTERACTIVE_POLICY,
  search: INTERACTIVE_POLICY,
  select: INTERACTIVE_POLICY,
  form: INTERACTIVE_POLICY,
  heading: INTERACTIVE_POLICY,
  element: INTERACTIVE_POLICY,

  unknown: {
    decision: 'FAIL_CLOSED',
    severity: 'unknown',
    mustRedact: true,
    exportableMetadata: false,
    // Any confidence qualifies as "uncertain" for an unclassified finding.
    minConfidence: 1.01,
    rationale: 'Unclassified sensitive information fails closed: not exported, region redacted.',
  },
};

export interface PolicyQuery {
  category: PrivacyCategory;
  confidence: number;
  sources: FindingSource[];
}

export interface PolicyDecisionRecord {
  category: PrivacyCategory;
  decision: TransmissionDecision;
  severity: PrivacySeverity;
  mustRedact: boolean;
  exportableMetadata: boolean;
  /** Always false — the core invariant, recorded explicitly for auditability. */
  rawValueTransmissible: false;
  /** True when the finding was escalated to FAIL_CLOSED for being uncertain. */
  failClosed: boolean;
  confidence: number;
  sources: FindingSource[];
  /** Stable machine-readable reason code. */
  code:
    | 'policy.category'
    | 'policy.uncertain_low_confidence'
    | 'policy.unknown_category';
  rationale: string;
}

/** Policy lookup for any category (including future ones → fail closed). */
export function policyForCategory(category: PrivacyCategory): CategoryPolicy {
  return CATEGORY_POLICY[category] ?? CATEGORY_POLICY['unknown']!;
}

export function severityForCategory(category: PrivacyCategory): PrivacySeverity {
  return policyForCategory(category).severity;
}

/**
 * The centralized transmission verdict for one fused finding.
 *
 * Fail-closed escalation happens BEFORE category policy: an unknown category or
 * a finding whose confidence is below the category's threshold can never obtain
 * a weaker verdict just because the category is normally harmless.
 */
export function decideTransmission(query: PolicyQuery): PolicyDecisionRecord {
  const { category, confidence, sources } = query;
  const policy = policyForCategory(category);

  // "Known" = registered in the policy table AND not the explicit unknown
  // marker. An unregistered future category is treated exactly like 'unknown':
  // it fails closed with the policy.unknown_category code.
  const isKnownCategory =
    Object.prototype.hasOwnProperty.call(CATEGORY_POLICY, category) && category !== 'unknown';
  // CATEGORY_POLICY.unknown is always defined — it is the fail-closed sentinel.
  const isUncertain = !Number.isFinite(confidence) || confidence < policy.minConfidence;

  if (!isKnownCategory || isUncertain) {
    return {
      category,
      decision: 'FAIL_CLOSED',
      severity: CATEGORY_POLICY['unknown']!.severity,
      mustRedact: true,
      exportableMetadata: false,
      rawValueTransmissible: false,
      failClosed: true,
      confidence,
      sources,
      code: isKnownCategory ? 'policy.uncertain_low_confidence' : 'policy.unknown_category',
      rationale: isKnownCategory
        ? 'Finding confidence is below the category threshold — failing closed.'
        : CATEGORY_POLICY['unknown']!.rationale,
    };
  }

  return {
    category,
    decision: policy.decision,
    severity: policy.severity,
    mustRedact: policy.mustRedact,
    exportableMetadata: policy.exportableMetadata,
    rawValueTransmissible: false,
    failClosed: false,
    confidence,
    sources,
    code: 'policy.category',
    rationale: policy.rationale,
  };
}

export interface PolicySummary {
  total: number;
  neverTransmit: number;
  redacted: number;
  minimized: number;
  failClosed: number;
  /** Category → number of findings with that category. */
  byCategory: Record<string, number>;
  /** Perception source → number of findings it contributed to. */
  bySource: Record<FindingSource, number>;
  /** Decision → number of findings with that decision. */
  byDecision: Record<TransmissionDecision, number>;
}

/** Aggregate, presentation-safe summary of policy verdicts (no raw values). */
export function summarizeDecisions(records: PolicyDecisionRecord[]): PolicySummary {
  const summary: PolicySummary = {
    total: records.length,
    neverTransmit: 0,
    redacted: 0,
    minimized: 0,
    failClosed: 0,
    byCategory: {},
    bySource: { dom: 0, ocr: 0, visual: 0 },
    byDecision: { NEVER_TRANSMIT: 0, REDACT: 0, MINIMIZE: 0, FAIL_CLOSED: 0 },
  };

  for (const record of records) {
    summary.byDecision[record.decision] += 1;
    summary.byCategory[record.category] = (summary.byCategory[record.category] ?? 0) + 1;
    for (const source of record.sources) {
      summary.bySource[source] += 1;
    }

    if (record.decision === 'NEVER_TRANSMIT') summary.neverTransmit += 1;
    if (record.decision === 'MINIMIZE') summary.minimized += 1;
    if (record.decision === 'FAIL_CLOSED') summary.failClosed += 1;
    if (record.mustRedact) summary.redacted += 1;
  }

  return summary;
}
