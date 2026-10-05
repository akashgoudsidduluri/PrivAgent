/**
 * PHASE 18.8 / A13 — DETERMINISTIC CONVERSATIONAL REFERENCE RESOLUTION.
 *
 * "it", "that product", "the third one" are resolved LOCALLY, from the
 * structured conversation context, BEFORE any action is dispatched. The model is
 * never asked what "it" means: it is told the resolved anchor, it does not
 * decide the anchor.
 *
 * ── Resolution priority (fixed, documented, deterministic) ──────────────────
 *   1. ORDINAL ("the third one", "3rd result")
 *      → the candidate with that ordinal among the candidates that describe the
 *        LIVE page. Zero candidates → NEEDS_INFORMATION. Out of range →
 *        NEEDS_CLARIFICATION. Never clamped, never rounded.
 *   2. TRUSTED SELECTION ("it", "this product", "the one we opened")
 *      → the selection, but ONLY when it has been revalidated against the live
 *        page (A15). A stale or absent selection is not used.
 *   3. UNIQUE CANDIDATE ("this product" with nothing selected)
 *      → resolved only when exactly ONE candidate describes the live page.
 *   4. ANYTHING ELSE
 *      → NEEDS_CLARIFICATION (two or more candidates and nothing selected) or
 *        NEEDS_INFORMATION (nothing observed). Never a guess.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * Not a planner and not an authority. It cannot dispatch, cannot authorize,
 * cannot bypass grounding, M5, the security critic, risk/confirmation, effect
 * verification or goal verification, and it never reads model output.
 */
import {
  eligibleCandidates,
  createConversationContext,
  isUsableContext,
  type ClarificationCode,
  type ConversationContext,
  type EntityCandidate,
  type EntityIdentity,
} from './conversationContext';

export type EntityReferenceKind = 'ORDINAL' | 'PRONOUN' | 'DESCRIPTOR' | 'PAGE';

/** A reference detected in the user's own words. Structural, no semantics. */
export interface EntityReference {
  readonly kind: EntityReferenceKind;
  /** 1-based, for ORDINAL only. */
  readonly ordinal: number | null;
  /** The matched surface form, bounded. Used only to phrase the question. */
  readonly phrase: string;
}

export type ReferenceOutcome =
  | 'NOT_A_REFERENCE'
  | 'RESOLVED'
  | 'NEEDS_CLARIFICATION'
  | 'NEEDS_INFORMATION';

export interface ReferenceResolutionResult {
  readonly outcome: ReferenceOutcome;
  readonly reference: EntityReference | null;
  /** The resolved candidate. Non-null only for RESOLVED. */
  readonly candidate: EntityCandidate | null;
  /** The resolved identity, even when the live page no longer lists it. */
  readonly identity: EntityIdentity | null;
  readonly clarificationCode: ClarificationCode | null;
  /** Fixed copy the user can act on. Never model prose, never an internal code. */
  readonly question: string | null;
  /** How it resolved. Fixed vocabulary, for the audit trail. */
  readonly basis: 'NONE' | 'ORDINAL' | 'REVALIDATED_SELECTION' | 'UNIQUE_CANDIDATE';
}

const WORD_ORDINALS: Readonly<Record<string, number>> = Object.freeze({
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  last: -1,
});

const ORDINAL_RE = /\b(?:the\s+)?(\d+)(?:st|nd|rd|th)?\s+(?:one|item|result|product|row|entry)\b/i;
const WORD_ORDINAL_RE = /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(?:one|item|result|product|row|entry)\b/i;
const SELECTOR_RE = /\b(?:the\s+)?(one|product|item|result|page|account|order|listing)\s+(?:we\s+)?(?:just\s+)?(?:opened|selected|viewed|clicked)\b/i;
const PREVIOUS_RE = /\b(?:the\s+)?(?:previous|last|prior)\s+(?:one|result|product|item|page)\b/i;
const PRONOUN_NOUN_RE = /\b(?:it|this|that)\s+(?:one|product|item|result|page|account|order|listing)\b/i;
const BARE_PRONOUN_RE = /\b(it|this|that)\b/i;

/**
 * Detect a conversational reference in the user's turn.
 *
 * Order matters and is fixed: an ordinal beats a pronoun, an explicit selector
 * ("the one we opened") beats a bare pronoun, and a bare pronoun is only
 * accepted when the turn is short enough that it cannot be incidental
 * ("get the weather and tell me about it" is not a reference the agent may
 * resolve silently).
 */
export function detectReference(task: string): EntityReference | null {
  if (typeof task !== 'string') return null;
  const text = task.trim();
  if (!text || text.length > 240) return null;
  const lower = text.toLowerCase();

  const numeric = ORDINAL_RE.exec(text);
  if (numeric) {
    const n = Number(numeric[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 20) {
      return { kind: 'ORDINAL', ordinal: n, phrase: numeric[0].trim() };
    }
    return { kind: 'ORDINAL', ordinal: null, phrase: numeric[0].trim() };
  }

  const wordOrdinal = WORD_ORDINAL_RE.exec(lower);
  if (wordOrdinal) {
    const mapped = WORD_ORDINALS[wordOrdinal[1]!] ?? null;
    return { kind: 'ORDINAL', ordinal: mapped && mapped > 0 ? mapped : null, phrase: wordOrdinal[0].trim() };
  }

  if (/\bthat\s+page\b/.test(lower) || /\bthis\s+page\b/.test(lower)) {
    return { kind: 'PAGE', ordinal: null, phrase: wordOrdinal?.[0] ?? 'that page' };
  }

  const selector = SELECTOR_RE.exec(lower);
  if (selector) return { kind: 'DESCRIPTOR', ordinal: null, phrase: selector[0].trim() };

  const previous = PREVIOUS_RE.exec(lower);
  if (previous) return { kind: 'DESCRIPTOR', ordinal: null, phrase: previous[0].trim() };

  const nounPronoun = PRONOUN_NOUN_RE.exec(lower);
  if (nounPronoun) {
    const phrase = nounPronoun[0].trim();
    return { kind: /page/i.test(phrase) ? 'PAGE' : 'PRONOUN', ordinal: null, phrase };
  }

  // A bare "it" is accepted only as the WHOLE instruction of a short turn. In a
  // longer sentence it is incidental, and resolving it would be a guess.
  const words = lower.split(/\s+/);
  const bare = BARE_PRONOUN_RE.exec(lower);
  if (bare && words.length <= 4) {
    return { kind: 'PRONOUN', ordinal: null, phrase: bare[0].trim() };
  }
  return null;
}

/**
 * Turns the user has asked for a fresh conversation. Matched locally; a "new
 * task" always means a new conversation, never a continuation with stale
 * candidates attached.
 */
const NEW_CONVERSATION_RE = /\b(?:new (?:conversation|task|session)|start over|start again|forget (?:that|everything|the previous)|reset)\b/i;

export type ConversationMode = 'NEW' | 'CONTINUE';

export interface ConversationPlan {
  readonly mode: ConversationMode;
  readonly context: ConversationContext | null;
  /** Fixed vocabulary for the audit trail. */
  readonly reason:
    | 'EXPLICIT_NEW_CONVERSATION'
    | 'NO_ACTIVE_CONVERSATION'
    | 'UNUSABLE_CONTEXT'
    | 'NO_REFERENCE_IN_TURN'
    | 'NO_ANCHOR_TO_REFER_TO'
    | 'CONTINUATION';
}

/**
 * Decide — LOCALLY and DETERMINISTICALLY — whether this turn continues a
 * conversation or starts a new one.
 *
 * A turn CONTINUES only when all of these hold:
 *   • the user did not ask for a new conversation/task/reset;
 *   • an active context exists and is usable (schema, id, generation, age);
 *   • the turn actually contains a conversational reference;
 *   • that conversation has something the reference could point at (observed
 *     candidates or a selection).
 *
 * Everything else starts a NEW conversation. The default is therefore isolation:
 * a follow-up can never silently inherit a previous run's candidates.
 */
export function planConversation(input: {
  task: string;
  current: ConversationContext | null;
  conversationId: string;
  now: number;
  pageUrl?: string | null;
}): ConversationPlan {
  const task = typeof input.task === 'string' ? input.task : '';
  if (NEW_CONVERSATION_RE.test(task)) {
    return {
      mode: 'NEW',
      context: createConversationContext({
        conversationId: input.conversationId,
        now: input.now,
        pageUrl: input.pageUrl ?? null,
      }),
      reason: 'EXPLICIT_NEW_CONVERSATION',
    };
  }
  if (!input.current) {
    return {
      mode: 'NEW',
      context: createConversationContext({
        conversationId: input.conversationId,
        now: input.now,
        pageUrl: input.pageUrl ?? null,
      }),
      reason: 'NO_ACTIVE_CONVERSATION',
    };
  }
  const conversationId = input.current.conversationId;
  if (
    !isUsableContext(input.current, {
      conversationId,
      now: input.now,
    })
  ) {
    return {
      mode: 'NEW',
      context: createConversationContext({
        conversationId: input.conversationId,
        now: input.now,
        pageUrl: input.pageUrl ?? null,
      }),
      reason: 'UNUSABLE_CONTEXT',
    };
  }

  const hasReference = detectReference(task) !== null;
  const hasAnchor = input.current.selection !== null || eligibleCandidates(input.current).length > 0;
  if (!hasReference || !hasAnchor) {
    return {
      mode: 'NEW',
      context: createConversationContext({
        conversationId: input.conversationId,
        now: input.now,
        pageUrl: input.pageUrl ?? null,
      }),
      reason: hasReference ? 'NO_ANCHOR_TO_REFER_TO' : 'NO_REFERENCE_IN_TURN',
    };
  }
  return { mode: 'CONTINUE', context: input.current, reason: 'CONTINUATION' };
}

/** Fixed, user-facing clarification copy. No internals, no model text. */
function questionFor(code: ClarificationCode, referencePhrase: string | null): string {
  switch (code) {
    case 'NO_CANDIDATES':
      return 'I do not have a list of items from this page yet, so I cannot tell which one you mean. Try asking me to find the items first.';
    case 'OUT_OF_RANGE_ORDINAL':
      return 'There is no item at that position on this page. Tell me a position that exists, or describe the item.';
    case 'STALE_CANDIDATES':
      return 'The items I saw earlier are no longer the items on this page, so I cannot safely pick one. Let me look at this page again.';
    case 'CONFLICTING_IDENTITY':
      return 'More than one thing on this page matches what you referred to, so I will not guess. Tell me which one you mean.';
    case 'UNTRUSTED_SELECTION':
      return 'I am not certain which item you mean. Tell me the position or the name of the item.';
    case 'ENTITY_NOT_FOUND_AFTER_NAVIGATION':
      return 'I could not confirm that the item I was following is on this page. Tell me which item to use.';
    case 'AMBIGUOUS_REFERENCE':
      return 'I found several items here, so I cannot tell which one you mean. Tell me a position, such as “the third one”, or describe it.';
    case 'STALE_CONTEXT':
      return 'That reference belongs to an earlier task. Tell me again what you would like me to do.';
    default:
      return 'Tell me which item you mean.';
  }
}

function clarification(
  code: ClarificationCode,
  reference: EntityReference | null,
  outcome: 'NEEDS_CLARIFICATION' | 'NEEDS_INFORMATION'
): ReferenceResolutionResult {
  return {
    outcome,
    reference,
    candidate: null,
    identity: null,
    clarificationCode: code,
    question: questionFor(code, reference?.phrase ?? null),
    basis: 'NONE',
  };
}

/**
 * Resolve one reference against the conversation context.
 *
 * Pure and read-only: the context is never mutated here. The caller records the
 * outcome (`withSelection` / `withClarification`).
 */
export function resolveReference(
  reference: EntityReference | null,
  ctx: ConversationContext | null | undefined,
  observed?: readonly EntityCandidate[]
): ReferenceResolutionResult {
  if (!reference) {
    return {
      outcome: 'NOT_A_REFERENCE',
      reference: null,
      candidate: null,
      identity: null,
      clarificationCode: null,
      question: null,
      basis: 'NONE',
    };
  }
  if (!ctx) return clarification('NO_CANDIDATES', reference, 'NEEDS_INFORMATION');

  const live = observed && observed.length ? observed : eligibleCandidates(ctx);

  // Priority 1: ordinal.
  if (reference.kind === 'ORDINAL') {
    if (reference.ordinal === null) return clarification('OUT_OF_RANGE_ORDINAL', reference, 'NEEDS_CLARIFICATION');
    if (live.length === 0) {
      return clarification(
        ctx.candidates.length > 0 || ctx.page.lastObservedCandidateCount > 0
          ? 'STALE_CANDIDATES'
          : 'NO_CANDIDATES',
        reference,
        'NEEDS_INFORMATION'
      );
    }
    const target = live.find((c) => c.ordinal === reference.ordinal);
    if (!target) return clarification('OUT_OF_RANGE_ORDINAL', reference, 'NEEDS_CLARIFICATION');
    return {
      outcome: 'RESOLVED',
      reference,
      candidate: target,
      identity: target.identity,
      clarificationCode: null,
      question: null,
      basis: 'ORDINAL',
    };
  }

  // Priority 2: a selection that A15 revalidated on the live page. The recorded
  // identity travels with it, so "it" still resolves AFTER a navigation even
  // when the detail page does not re-list the entity as a candidate.
  const selection = ctx.selection;
  if (selection) {
    if (selection.revalidation === 'NOT_FOUND') {
      return clarification('ENTITY_NOT_FOUND_AFTER_NAVIGATION', reference, 'NEEDS_CLARIFICATION');
    }
    if (selection.revalidation === 'UNCONFIRMED') {
      return clarification('CONFLICTING_IDENTITY', reference, 'NEEDS_CLARIFICATION');
    }
    const stillObserved = live.find((c) => c.identity.identityKey === selection.identityKey) ?? null;
    if (!stillObserved) {
      // Two live candidates can share one identity key (same title, different
      // catalog row). That is a conflict, never a coin flip.
      const twins = live.filter((c) => c.identity.identityKey === selection.identityKey);
      if (twins.length > 1) return clarification('CONFLICTING_IDENTITY', reference, 'NEEDS_CLARIFICATION');
    }
    return {
      outcome: 'RESOLVED',
      reference,
      candidate: stillObserved,
      identity: stillObserved ? stillObserved.identity : selection.identity,
      clarificationCode: null,
      question: null,
      basis: 'REVALIDATED_SELECTION',
    };
  }

  // Priority 3: exactly one live candidate, and nothing selected at all.
  if (live.length === 1) {
    const only = live[0]!;
    return {
      outcome: 'RESOLVED',
      reference,
      candidate: only,
      identity: only.identity,
      clarificationCode: null,
      question: null,
      basis: 'UNIQUE_CANDIDATE',
    };
  }
  if (live.length === 0) {
    return clarification(
      ctx.candidates.length > 0 || ctx.page.lastObservedCandidateCount > 0
        ? 'STALE_CANDIDATES'
        : 'NO_CANDIDATES',
      reference,
      'NEEDS_INFORMATION'
    );
  }
  return clarification('AMBIGUOUS_REFERENCE', reference, 'NEEDS_CLARIFICATION');
}