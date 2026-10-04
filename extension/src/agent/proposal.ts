/**
 * PHASE 18.7 / A1 + A9 — the terminal proposal verifier.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORFORCE
 *   The LLM proposes. The device disposes.
 *
 * A terminal proposal is UNTRUSTED model text arriving over the network. It
 * is parsed through a fixed allowlist, bounded, screened by the same
 * authoritative detector that guards every other egress path, and only then
 * checked against the evidence ledger this device holds. Nothing here trusts
 * the model's own word, its own citations, or its own confidence.
 *
 * WHAT IS STRUCTURALLY IMPOSSIBLE HERE
 *   `ProposalTerminalStatus` deliberately does not contain `SUCCESS`. The type
 *   cannot express it, so no code path in this file can report an answer as a
 *   successful task. The GoalVerifier remains the only authority for SUCCESS
 *   and is untouched by this file.
 *
 *   `ANSWER ≠ SUCCESS`. An admissible ANSWER reports an answer the local
 *   ledger supports; it does not assert the task is done.
 *
 * WHY THE DOWNGRADES EXIST
 *   Every rule below fails CLOSED. A model that over-claims is not obeyed and
 *   is not punished — the strongest statement the device can make from the
 *   evidence it actually holds is used instead, and an unverifiable claim
 *   collapses to `NEEDS_INFORMATION`, which is truthful in both directions
 *   (it does not claim an answer exists, and it does not claim absence).
 */

import {
  scanForRawSensitiveValues,
} from '../privacy/rawValueScanner';
import { isInjectionShapedText } from '../semanticUnderstanding/semanticContext';
import { evidenceKey, type EvidenceRecord } from '../evidence/evidenceLedger';

/**
 * The terminal states a proposal may resolve to.
 *
 * `SUCCESS` is NOT a member and cannot be added without editing this union,
 * which is the point: an answer is not a task success.
 */
export type ProposalTerminalStatus =
  | 'ANSWER'
  | 'PARTIAL'
  | 'NEEDS_INFORMATION'
  | 'CANNOT_VERIFY';

/** Proposal kinds exactly as the backend contract declares them. */
export const PROPOSAL_KINDS: readonly ProposalTerminalStatus[] = Object.freeze([
  'ANSWER',
  'PARTIAL',
  'NEEDS_INFORMATION',
  'CANNOT_VERIFY',
]);

/** Bounds. A proposal is bounded exactly like an action field is. */
export const MAX_PROPOSAL_REASON_CHARS = 300;
export const MAX_PROPOSAL_ANSWER_CHARS = 1500;
export const MAX_PROPOSAL_QUESTION_CHARS = 300;
export const MAX_PROPOSAL_CITATIONS = 12;
export const MAX_PROPOSAL_ITEM_CHARS = 200;

/** Bound on the answer text composed from verified ledger records. */
export const MAX_SUPPORTED_ANSWER_CHARS = 1500;

/** The only keys read from a model proposal. Anything else is ignored. */
const ALLOWED_PROPOSAL_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(['kind', 'reason', 'question', 'answer', 'cited_evidence', 'citedEvidence', 'missing'])
);

export interface TerminalProposal {
  readonly kind: ProposalTerminalStatus;
  readonly reason: string;
  readonly answer: string | null;
  readonly question: string | null;
  /** Ledger record ids only. Never the model's copy of the fact. */
  readonly citedEvidence: readonly string[];
  readonly missing: readonly string[];
}

export type ProposalRejection =
  | 'MALFORMED'
  | 'SENSITIVE_CONTENT'
  | 'INJECTION_SHAPED'
  | 'OVERSIZED'
  | 'UNRESOLVED_CITATION'
  | 'INSUFFICIENT_EVIDENCE'
  | 'OVERCLAIM_DOWNGRADED';

export interface ProposalVerdict {
  /**
   * Whether a terminal statement may be reported to the user at all. `false`
   * means the loop must keep acting — the model proposed stopping without a
   * basis we can reproduce locally.
   */
  readonly accepted: boolean;
  /**
   * The terminal state to set. Null when nothing may be reported. Never
   * `SUCCESS` — see `ProposalTerminalStatus`.
   */
  readonly status: ProposalTerminalStatus | null;
  /** Records that actually backed the statement. Empty when `status` is null. */
  readonly supportedRecordIds: readonly string[];
  readonly rejections: readonly ProposalRejection[];
  /** True when the model's own claim was reduced, not accepted as stated. */
  readonly downgraded: boolean;
}

/** The minimal ledger surface this file needs. Keeps it pure and testable. */
export interface ProposalLedgerView {
  byIdSafe(id: string): EvidenceRecord | undefined;
  citable(): EvidenceRecord[];
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxChars);
}

function boundedStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxChars));
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Parse one untrusted network payload into a bounded, screened proposal.
 * Returns null for anything malformed — never a partially-trusted object.
 */
export function parseTerminalProposal(raw: unknown): TerminalProposal | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const kind = source.kind;
  if (typeof kind !== 'string' || !PROPOSAL_KINDS.includes(kind as ProposalTerminalStatus)) {
    return null;
  }

  const reason = boundedText(source.reason, MAX_PROPOSAL_REASON_CHARS);
  if (!reason) return null;

  const answer = boundedText(source.answer, MAX_PROPOSAL_ANSWER_CHARS);
  const question = boundedText(source.question, MAX_PROPOSAL_QUESTION_CHARS);
  const citedEvidence = boundedStringList(
    source.cited_evidence ?? source.citedEvidence,
    MAX_PROPOSAL_CITATIONS,
    120
  );
  const missing = boundedStringList(source.missing, MAX_PROPOSAL_CITATIONS, MAX_PROPOSAL_ITEM_CHARS);

  // AN ANSWER with no answer text is not an answer. Refuse rather than
  // downgrade here: the model already told us it could answer, and then did
  // not, so the shape is inconsistent.
  if (kind === 'ANSWER' && !answer) return null;

  const proposal: TerminalProposal = Object.freeze({
    kind: kind as ProposalTerminalStatus,
    reason,
    answer,
    question,
    citedEvidence: Object.freeze(citedEvidence),
    missing: Object.freeze(missing),
  });

  // Same authoritative detector that guards every other egress path. A
  // proposal is model-authored prose and is no safer than an action field.
  if (scanForRawSensitiveValues(proposal).length > 0) return null;

  // Webpage-derived wording can reach the model and come back in its answer.
  // It stays inert: it is data, never an instruction.
  for (const candidate of [proposal.reason, proposal.answer, proposal.question, ...proposal.missing]) {
    if (candidate && isInjectionShapedText(candidate)) return null;
  }

  return proposal;
}

/** ALLOWED_PROPOSAL_KEYS is the contract; expose it so a test can pin it. */
export function proposalAllowlistedKeys(): readonly string[] {
  return Array.from(ALLOWED_PROPOSAL_KEYS).sort();
}

/**
 * Extract subject terms from the USER'S OWN task text, so evidence can be
 * matched against what was actually asked without trusting the model to
 * restate the question correctly.
 */
export function subjectTermsFromTask(task: string): string[] {
  const STOP = new Set([
    'the', 'a', 'an', 'about', 'tell', 'me', 'what', 'is', 'are', 'was', 'were',
    'of', 'on', 'in', 'for', 'to', 'and', 'or', 'find', 'information', 'please',
    'give', 'show', 'open', 'search', 'get', 'know', 'do', 'does', 'did', 'you',
    'can', 'could', 'would', 'should', 'it', 'its', 'this', 'that', 'there',
  ]);
  const key = evidenceKey(task);
  if (!key) return [];
  return key
    .split(' ')
    .filter((term) => term.length >= 3 && !STOP.has(term))
    .slice(0, 12);
}

function isVerifiedAndCurrent(record: EvidenceRecord): boolean {
  return record.verificationStatus === 'VERIFIED' && record.freshness === 'CURRENT';
}

function matchesSubject(record: EvidenceRecord, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const key = record.key.toLowerCase();
  return terms.some((term) => key.includes(term) || term.includes(key));
}

/**
 * Decide what may truthfully be reported from a proposed terminal state.
 *
 * Pure: no I/O, no clock, no model. The same proposal and the same ledger
 * always produce the same verdict.
 */
export function verifyTerminalProposal(
  raw: unknown,
  ledger: ProposalLedgerView,
  task: string
): ProposalVerdict {
  const proposal = parseTerminalProposal(raw);
  if (!proposal) {
    return Object.freeze({
      accepted: false,
      status: null,
      supportedRecordIds: Object.freeze([] as string[]),
      rejections: Object.freeze(['MALFORMED'] as ProposalRejection[]),
      downgraded: false,
    });
  }

  const rejections: ProposalRejection[] = [];
  const terms = subjectTermsFromTask(task);

  const citable = ledger.citable();
  const verified = citable.filter(isVerifiedAndCurrent);

  // Resolve EVERY citation against the ledger we hold. An id the model
  // invented — or one that has gone stale, conflicted or been invalidated —
  // is discarded, and never counted as support.
  const resolved: EvidenceRecord[] = [];
  for (const id of proposal.citedEvidence) {
    const record = ledger.byIdSafe(id);
    if (!record) {
      rejections.push('UNRESOLVED_CITATION');
      continue;
    }
    if (!isVerifiedAndCurrent(record)) {
      rejections.push('UNRESOLVED_CITATION');
      continue;
    }
    resolved.push(record);
  }

  const supported = resolved.filter((record) => matchesSubject(record, terms));
  const supportedIds = Object.freeze(supported.map((record) => record.id));

  // Deterministic downgrades. Each states the strongest thing the LOCAL
  // evidence actually supports, and never more.
  let status: ProposalTerminalStatus | null;
  let downgraded = false;

  switch (proposal.kind) {
    case 'ANSWER':
      if (supported.length >= 1) {
        status = 'ANSWER';
      } else if (verified.length >= 1) {
        // Something is verified, just not about the question.
        status = 'PARTIAL';
        downgraded = true;
        rejections.push('INSUFFICIENT_EVIDENCE');
      } else {
        status = 'NEEDS_INFORMATION';
        downgraded = true;
        rejections.push('INSUFFICIENT_EVIDENCE');
      }
      break;

    case 'PARTIAL':
      if (verified.length >= 1) {
        status = 'PARTIAL';
      } else {
        // "Partial" implies some verified part. With none, the honest state is
        // that we need more information.
        status = 'NEEDS_INFORMATION';
        downgraded = true;
        rejections.push('INSUFFICIENT_EVIDENCE');
      }
      break;

    case 'NEEDS_INFORMATION':
      if (verified.length === 0) {
        status = 'NEEDS_INFORMATION';
      } else {
        // Refusing to accept an answer while verified evidence exists would be
        // its own kind of untruth.
        status = 'PARTIAL';
        downgraded = true;
        rejections.push('OVERCLAIM_DOWNGRADED');
      }
      break;

    case 'CANNOT_VERIFY':
    default:
      if (citable.length === 0) {
        // Nothing was observed that could be verified. Verification really is
        // impossible, and saying so is more useful than claiming ignorance.
        status = 'CANNOT_VERIFY';
      } else {
        status = 'NEEDS_INFORMATION';
        downgraded = true;
        rejections.push('OVERCLAIM_DOWNGRADED');
      }
      break;
  }

  // A terminal state with no verified evidence behind it must never be
  // reported as though something had been established. This is the structural
  // half of "UNKNOWN ≠ ABSENCE": NEEDS_INFORMATION says we do not know, not
  // that the answer does not exist.
  if (status === 'ANSWER' && supportedIds.length === 0) {
    status = verified.length >= 1 ? 'PARTIAL' : 'NEEDS_INFORMATION';
    downgraded = true;
    rejections.push('INSUFFICIENT_EVIDENCE');
  }

  return Object.freeze({
    accepted: status !== null,
    status,
    supportedRecordIds: supportedIds,
    rejections: Object.freeze(Array.from(new Set(rejections))),
    downgraded,
  });
}