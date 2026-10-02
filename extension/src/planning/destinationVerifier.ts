/**
 * PrivAgent — Destination Verifier (POST-17.10 destination-intent contract)
 *
 * WHAT THIS IS
 * ────────────
 * The VERIFICATION channel. It compares a DECLARED destination (from
 * `destinationNormalizer`) against the CURRENT OBSERVED browser state, and
 * returns one of three outcomes:
 *
 *     MATCH     the observed page positively establishes the declared destination
 *     MISMATCH  the observed page positively establishes something else
 *     UNKNOWN   the observation does not speak to the destination
 *
 * A boolean cannot express this, and that is the point: `false` would have to
 * mean both "I looked and it is different" and "I could not look". Collapsing
 * those two is precisely the defect this contract exists to prevent, because
 * only one of them is evidence.
 *
 * THE THREE SEPARATE CHANNELS
 * ───────────────────────────
 *   DECLARATION  comes from interpreting the user's task (the normalizer).
 *   OBSERVATION  comes from browser perception (the sanitized context).
 *   VERIFICATION is this file, and it is the only place the two meet.
 *
 * This file reads the declaration and the observation and nothing else. There
 * is deliberately no parameter through which dispatch state could arrive, which
 * is why the forbidden-evidence list below is enforced by the TYPE rather than
 * by a reviewer remembering to check:
 *
 *   action.url              — a requested destination is intent, never evidence
 *   executionSuccess        — dispatch state says the agent asked
 *   previousActions         — history of requests, not of observations
 *   navigationDestination   — intent, by construction
 *   model output            — a claim, not an observation
 *   planned destination     — the declaration itself
 *   page text / entities /  — page CONTENT must never rewrite or satisfy a
 *     affordance descriptions   destination claim; only the page-identity
 *                               classification is used
 *   declaration.entryUrl    — the site to START at, not a destination claim
 *                               (POST-17.10 Step 6). See below.
 *
 * WHY `entryUrl` IS NOT A CHANNEL
 * ───────────────────────────────
 * A declaration may carry `entryUrl` — the origin a task should start from,
 * e.g. `http://localhost:4174` in `"open the store catalog at
 * http://localhost:4174"`. That is a PROVISIONING fact, not a destination
 * constraint: the requested destination is the catalog, which the user named in
 * words, not the bare origin. Verifying it against an observed URL would demand
 * that `/` match wherever the site actually serves its catalog, which is exactly
 * the substring-like slack this module exists to refuse.
 *
 * So the entry URL is simply not read here. The two destination channels remain
 * `role` and `url`, `url` is still compared EXACTLY against `origin` + `path`,
 * and no observation can add, remove or rewrite a declaration field (all fields
 * are `readonly` and this function never assigns to `declaration`).
 *
 * WHAT IT IS NOT
 * ──────────────
 * This is planning bookkeeping, not authorization and not task success. It
 * cannot permit an action — Grounding, M5, the Security Critic, Risk/Confirmation
 * and Containment remain authoritative — and it cannot declare the task
 * complete. Goal Verification remains the ONLY source of task SUCCESS and is not
 * consulted, imported or influenced here.
 *
 * FAIL CLOSED
 * ───────────
 * UNKNOWN is the default and absorbs every case where evidence is absent, stale,
 * unclassified, low-confidence, unparseable, ambiguous, or unsupported. Absence
 * of evidence is never evidence of completion, and it is never evidence of
 * failure either: MISMATCH requires a POSITIVE contrary observation.
 */

import type { SemanticPageType } from '../semanticUnderstanding/semanticTypes';
import { MIN_PAGE_CLASSIFICATION_CONFIDENCE } from '../semanticUnderstanding/pageClassifier';
import { normalizeDestinationUrl, type DestinationDeclaration } from './destinationNormalizer';

// ══════════════════════════════════════════════════════════════════════════════
// Result types
// ══════════════════════════════════════════════════════════════════════════════

export type DestinationVerdictKind = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

/** Which independent constraint produced (or prevented) a verdict. */
export type DestinationChannel = 'pageRole' | 'url';

/**
 * A channel that was not declared at all, so it constrains nothing.
 * `NONE`, `AMBIGUOUS` and `UNSUPPORTED` declarations all land here.
 */
export interface DestinationVerdict {
  readonly kind: DestinationVerdictKind;
  /** Human-readable evidence trail. Never contains page text or values. */
  readonly reason: string;
  /** The channel that determined the outcome, or null when none applied. */
  readonly decisiveChannel: DestinationChannel | null;
  /** Per-channel detail, so a combined verdict is inspectable. */
  readonly channels: {
    readonly pageRole: ChannelOutcome | null;
    readonly url: ChannelOutcome | null;
  };
}

export interface ChannelOutcome {
  readonly channel: DestinationChannel;
  readonly kind: DestinationVerdictKind;
  readonly reason: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// Input types — structurally incapable of carrying forbidden evidence
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The sanitized page identity this verifier is allowed to read.
 *
 * Deliberately NOT `AgentContextPayload`: that type carries `detections`,
 * `previous_actions` and other fields this verifier must never consult. A
 * narrow type makes the exclusion structural instead of a promise.
 */
export interface DestinationObservation {
  /** The observed document URL, as perceived. */
  readonly url: string;
  /** Page generation of the observed document. */
  readonly pageGeneration: number;
  /** Sanitized semantic classification, when perception established one. */
  readonly semantic?: {
    readonly pageType: SemanticPageType;
    readonly confidence: number;
    readonly pageGeneration: number;
  } | null;
}

export interface DestinationVerificationInput {
  readonly declaration: DestinationDeclaration;
  /**
   * The observed page state. `null`/`undefined` — perception produced nothing —
   * is a legitimate input and yields UNKNOWN, never MISMATCH.
   */
  readonly observation?: DestinationObservation | null;
  /**
   * The page generation of the cycle this verification is being run in. When
   * supplied it MUST equal `observation.pageGeneration`; otherwise the
   * observation belongs to an older document and is refused.
   */
  readonly currentPageGeneration?: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// Channel: page role
// ══════════════════════════════════════════════════════════════════════════════

function verifyPageRole(
  acceptable: readonly SemanticPageType[],
  input: DestinationVerificationInput
): ChannelOutcome {
  const fail = (reason: string): ChannelOutcome => ({ channel: 'pageRole', kind: 'UNKNOWN', reason });
  const obs = input.observation;
  const unknown = (reason: string) => ({ channel: 'pageRole' as const, kind: 'UNKNOWN' as const, reason });

  // N10 — `UNKNOWN` is never an acceptable destination. The normalizer cannot
  // emit it; this refuses it defensively so a hand-built or future declaration
  // cannot turn "unclassified" into "satisfied".
  const targets = acceptable.filter((t) => t !== 'UNKNOWN' && t !== 'ERROR');
  if (targets.length === 0) {
    return fail('Declaration names no verifiable page role; UNKNOWN and ERROR are not destinations.');
  }

  if (!obs) return fail('No observation was supplied, so the declared page role cannot be checked.');
  if (!Number.isFinite(obs.pageGeneration)) {
    return fail('Observation carries no usable page generation, so it cannot be shown current.');
  }
  if (input.currentPageGeneration !== undefined && input.currentPageGeneration !== obs.pageGeneration) {
    return fail(
      `Observation belongs to page generation ${obs.pageGeneration} but verification is running at generation ${input.currentPageGeneration}; a stale document cannot verify a destination.`
    );
  }

  const semantic = obs.semantic;
  if (!semantic) {
    return fail('Observation carries no semantic page classification, so the declared page role cannot be shown.');
  }
  if (semantic.pageGeneration !== obs.pageGeneration) {
    return fail(
      `Page classification is stamped generation ${semantic.pageGeneration} but the document is generation ${obs.pageGeneration}; the classification is about a different document.`
    );
  }
  // The classifier already collapses anything below the floor to UNKNOWN; this
  // is the shared floor, checked defensively so a hand-built observation can
  // never present a sub-floor classification as authoritative.
  if (semantic.pageType !== 'UNKNOWN' && semantic.confidence < MIN_PAGE_CLASSIFICATION_CONFIDENCE) {
    return fail(
      `Observed page classification ${semantic.pageType} at confidence ${semantic.confidence} is below the classifier's floor of ${MIN_PAGE_CLASSIFICATION_CONFIDENCE}, so it is not authoritative.`
    );
  }
  if (semantic.pageType === 'UNKNOWN') {
    return unknown(
      `The page is not classified (UNKNOWN at confidence ${semantic.confidence}); an unclassified page cannot confirm or deny a destination.`
    );
  }
  // A positively classified error page is a contrary observation, not an
  // absence of one. `ERROR` is excluded from `targets` above, so it can never
  // be declared as a destination, but observing one is still decisive.
  if (semantic.pageType === 'ERROR') {
    return {
      channel: 'pageRole',
      kind: 'MISMATCH',
      reason: `The observed page is classified as an error page at confidence ${semantic.confidence}, not one of the declared roles [${targets.join(', ')}].`,
    };
  }

  if (targets.includes(semantic.pageType)) {
    return {
      channel: 'pageRole',
      kind: 'MATCH',
      reason: `Observed page identity ${semantic.pageType} at confidence ${semantic.confidence} is one of the declared roles [${targets.join(', ')}].`,
    };
  }

  // Positive contrary classification — the only route to MISMATCH.
  return {
    channel: 'pageRole',
    kind: 'MISMATCH',
    reason: `Observed page identity ${semantic.pageType} at confidence ${semantic.confidence} is not one of the declared roles [${targets.join(', ')}].`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Channel: explicit URL
// ══════════════════════════════════════════════════════════════════════════════

function verifyUrl(
  declared: { readonly origin: string; readonly path: string },
  input: DestinationVerificationInput
): ChannelOutcome {
  const obs = input.observation;
  if (!obs) {
    return { channel: 'url', kind: 'UNKNOWN', reason: 'No observation was supplied, so the declared URL cannot be checked.' };
  }
  if (!Number.isFinite(obs.pageGeneration)) {
    return { channel: 'url', kind: 'UNKNOWN', reason: 'Observation carries no usable page generation, so it cannot be shown current.' };
  }
  if (input.currentPageGeneration !== undefined && input.currentPageGeneration !== obs.pageGeneration) {
    return {
      channel: 'url',
      kind: 'UNKNOWN',
      reason: `Observation belongs to page generation ${obs.pageGeneration} but verification is running at generation ${input.currentPageGeneration}.`,
    };
  }

  // The OBSERVED URL is the only thing compared. The requested URL is intent.
  const observed = normalizeDestinationUrl(obs.url);
  if (!observed) {
    return {
      channel: 'url',
      kind: 'UNKNOWN',
      reason: 'The observed URL could not be parsed as an http(s) URL, so it cannot be compared.',
    };
  }

  const same = observed.origin === declared.origin && observed.path === declared.path;
  return same
    ? {
        channel: 'url',
        kind: 'MATCH',
        reason: `Observed URL ${observed.origin}${observed.path} equals the declared destination exactly.`,
      }
    : {
        channel: 'url',
        kind: 'MISMATCH',
        reason: `Observed URL ${observed.origin}${observed.path} differs from the declared destination ${declared.origin}${declared.path}.`,
      };
}

// ══════════════════════════════════════════════════════════════════════════════
// Combination
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Compare a declared destination against the current observation.
 *
 * Precedence, which is deterministic and total:
 *
 *   1. A declaration that names nothing verifiable (NONE / AMBIGUOUS /
 *      UNSUPPORTED) → UNKNOWN. Ambiguity is never a guess.
 *   2. Any declared channel that MISMATCHes → MISMATCH. A positively contrary
 *      observation settles the question even if another channel is unknown.
 *   3. Every declared channel MATCHes → MATCH.
 *   4. Otherwise → UNKNOWN. Missing evidence is never upgraded.
 */
export function verifyDestination(input: DestinationVerificationInput): DestinationVerdict {
  const { declaration } = input;

  if (declaration.kind !== 'DECLARED') {
    return {
      kind: 'UNKNOWN',
      reason: `Declaration is ${declaration.kind}; no destination was asserted, so there is nothing to verify.`,
      decisiveChannel: null,
      channels: { pageRole: null, url: null },
    };
  }

  const pageRole = declaration.role
    ? verifyPageRole(declaration.role.acceptablePageTypes, input)
    : null;
  // `declaration.entryUrl` is deliberately NOT read: it is the site to start at,
  // not a destination constraint. Only `declaration.url` opens the URL channel.
  const url = declaration.url ? verifyUrl(declaration.url, input) : null;

  const declared = [pageRole, url].filter((c): c is ChannelOutcome => c !== null);
  if (declared.length === 0) {
    return {
      kind: 'UNKNOWN',
      reason:
        declaration.entryUrl !== undefined
          ? 'Declaration names only an entry URL, which is where to start rather than a destination; nothing was asserted about the destination.'
          : 'Declaration carries neither a page role nor a destination URL, so there is nothing to verify.',
      decisiveChannel: null,
      channels: { pageRole: null, url: null },
    };
  }

  const mismatch = declared.find((c) => c.kind === 'MISMATCH');
  if (mismatch) {
    return {
      kind: 'MISMATCH',
      reason: mismatch.reason,
      decisiveChannel: mismatch.channel,
      channels: { pageRole, url },
    };
  }

  const allMatch = declared.every((c) => c.kind === 'MATCH');
  if (allMatch) {
    return {
      kind: 'MATCH',
      reason: declared.map((c) => c.reason).join(' '),
      decisiveChannel: declared.length === 1 ? declared[0]!.channel : null,
      channels: { pageRole, url },
    };
  }

  const unknownChannel = declared.find((c) => c.kind === 'UNKNOWN');
  return {
    kind: 'UNKNOWN',
    reason: unknownChannel
      ? unknownChannel.reason
      : 'The declared destination could not be resolved against the current observation.',
    decisiveChannel: unknownChannel?.channel ?? null,
    channels: { pageRole, url },
  };
}
