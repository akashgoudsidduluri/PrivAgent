/**
 * PHASE 18.8 / A15 — CROSS-PAGE ENTITY IDENTITY.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * A DOM detection id is page-local. `element_3` on the listing page and
 * `element_1` on the detail page are the same nothing. Using one as identity
 * meant "it" could never survive a navigation, and using an array index meant it
 * could silently mean something else.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * Identity is derived from OBSERVED, privacy-safe attributes only: normalized
 * entity kind, normalized title, canonical URL, product id, and a whitelisted
 * set of bounded safe attributes (price, rating, availability, …). The DOM id,
 * the previous array position, `previousActions`, model output and
 * `executionSuccess` are never inputs.
 *
 * ── Revalidation, not persistence ───────────────────────────────────────────
 * A selection is NOT trusted across a navigation. It is RE-ESTABLISHED against
 * the newly perceived page by `revalidateSelection`, and when it cannot be, the
 * result is `NOT_FOUND` or `UNCONFIRMED` — never a substitution with whatever
 * happens to be on the page now.
 *
 * This module is PURE: no I/O, no clock of its own, no model. It grants no
 * authority; grounding, M5, the security critic, risk/confirmation, effect
 * verification and goal verification all still run on any resulting action.
 */
import type { BrowserWorldModel, WorldEntity } from '../worldModel/types';
import {
  buildIdentity,
  canonicalizeUrl,
  createCandidate,
  entityKindFor,
  identifierFromUrl,
  MAX_CONVERSATION_CANDIDATES,
  type EntityCandidate,
  type EntityIdentity,
} from './conversationContext';

/** Entity kinds a user can plausibly refer to. `UNKNOWN` is excluded on purpose. */
const REFERABLE_KINDS = new Set([
  'PRODUCT',
  'SEARCH_RESULT',
  'LISTING',
  'ARTICLE',
  'DOCUMENT',
  'TRANSACTION',
  'CONTACT',
  'TABLE_ROW',
  'CONTROL',
]);

/** Document order: top to bottom, then left to right. Stable and page-local. */
function documentOrder(a: WorldEntity, b: WorldEntity): number {
  const at = a.bbox?.[1] ?? 0;
  const bt = b.bbox?.[1] ?? 0;
  if (at !== bt) return at - bt;
  const al = a.bbox?.[0] ?? 0;
  const bl = b.bbox?.[0] ?? 0;
  if (al !== bl) return al - bl;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Build the referable candidates for one perception, in observed order.
 *
 * Ordinals are assigned from the OBSERVED document order of this page. They are
 * never carried over from a previous page: "the third one" is meaningless until
 * the page that has a third one has been observed.
 */
export function candidatesFromWorldModel(
  worldModel: BrowserWorldModel | null | undefined,
  now: number,
  options: { limit?: number; url?: string | null } = {}
): EntityCandidate[] {
  if (!worldModel || !Array.isArray(worldModel.entities)) return [];
  const pageUrl = options.url ?? worldModel.page?.url ?? null;
  const pageGeneration = worldModel.page?.pageGeneration ?? 0;
  const limit = Math.min(options.limit ?? MAX_CONVERSATION_CANDIDATES, MAX_CONVERSATION_CANDIDATES);

  const ordered = [...worldModel.entities].sort(documentOrder);
  const candidates: EntityCandidate[] = [];
  const seenSignatures = new Set<string>();

  for (const entity of ordered) {
    if (candidates.length >= limit) break;
    const kind = entityKindFor(entity.type);
    if (!REFERABLE_KINDS.has(kind)) continue;
    const identity = buildIdentity({
      entityType: kind,
      title: entity.title,
      // A listing-page entity has no URL of its own; the page's canonical URL
      // is the honest one, and the title plus the catalog identifier carries
      // the per-entity distinction.
      url: pageUrl,
      attributes: entity.attributes,
    });
    if (!identity) continue;
    // Two rows on ONE page can legitimately share a title (different sizes, for
    // instance). They are still two separate candidates the user can order, so
    // the per-observation de-duplication uses the observed ATTRIBUTES too. The
    // identity key itself stays stable, and the resolver treats two live
    // candidates sharing one key as a conflict rather than picking one.
    const signature = `${identity.identityKey}|${JSON.stringify(
      Object.entries(identity.attributes).sort(([a], [b]) => a.localeCompare(b))
    )}`;
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    candidates.push(
      createCandidate({
        ordinal: candidates.length + 1,
        identity,
        pageGeneration,
        observedAt: now,
      })
    );
  }
  return candidates;
}

export type RevalidationVerdict = 'REVALIDATED' | 'UNCONFIRMED' | 'NOT_FOUND';

export interface RevalidationResult {
  readonly verdict: RevalidationVerdict;
  /** The identity re-established on the live page. Null unless REVALIDATED. */
  readonly identity: EntityIdentity | null;
  /** Ordinal of the re-established entity in the CURRENT observation. */
  readonly ordinal: number | null;
  /** Fixed code describing why revalidation was not conclusive. */
  readonly code: 'IDENTITY_KEY_MATCH' | 'TITLE_AND_ID_MATCH' | 'IDENTITY_CONFLICT' | 'IDENTITY_ABSENT';
}

/**
 * Re-establish a selection against a freshly observed page.
 *
 * Deterministic, ordered, and it NEVER substitutes another entity:
 *   1. exact `identityKey` match in the observation  -> REVALIDATED;
 *   2. unique (kind + normalized title) match, with no product-id conflict
 *      -> REVALIDATED (identity rebuilt from safe attributes on this page);
 *   3. several (kind + title) matches                -> UNCONFIRMED (conflict);
 *   4. a title match whose product id disagrees      -> UNCONFIRMED (conflict);
 *   5. no match                                     -> NOT_FOUND.
 *
 * "The page still shows something at all" is never sufficient: an empty
 * observation must not silently re-target the selection.
 */
export function revalidateSelection(
  selection: {
    identityKey: string;
    ordinal: number;
    identity?: EntityIdentity | null;
  },
  observed: readonly EntityCandidate[],
  pageUrl?: string | null
): RevalidationResult {
  // 1. The observed identity key is the strongest possible agreement.
  const exact = observed.find((c) => c.identity.identityKey === selection.identityKey);
  if (exact) {
    return {
      verdict: 'REVALIDATED',
      identity: exact.identity,
      ordinal: exact.ordinal,
      code: 'IDENTITY_KEY_MATCH',
    };
  }
  // 2. Otherwise REBUILD from the recorded identity against this page's
  //    observations. This never falls back to "the page still has something".
  if (selection.identity) return revalidateAgainstRecorded(selection.identity, observed, pageUrl, selection.ordinal);
  return { verdict: 'NOT_FOUND', identity: null, ordinal: null, code: 'IDENTITY_ABSENT' };
}

/**
 * Rebuild a selection identity from the recorded identity plus the live page.
 *
 * Order, and no substitution at any point:
 *   1. a unique (kind + normalized title) observation whose product id does not
 *      contradict the recorded one;
 *   2. the live page URL carrying the SAME identifier the recorded identity was
 *      built from (the detail page of a catalog listing — the entity node there
 *      frequently does not repeat the catalog title);
 *   3. the same canonical URL still on screen (no navigation happened).
 * Anything else is `NOT_FOUND`: the entity is not established on this page.
 */
export function revalidateAgainstRecorded(
  recorded: EntityIdentity,
  observed: readonly EntityCandidate[],
  pageUrl?: string | null,
  recordedOrdinal = 1
): RevalidationResult {
  const titleMatches = observed.filter(
    (c) => c.identity.normalizedTitle === recorded.normalizedTitle && c.identity.entityType === recorded.entityType
  );
  if (titleMatches.length > 1) {
    return { verdict: 'UNCONFIRMED', identity: null, ordinal: null, code: 'IDENTITY_CONFLICT' };
  }
  if (titleMatches.length === 1) {
    const only = titleMatches[0]!;
    if (
      recorded.productId &&
      only.identity.productId &&
      recorded.productId !== only.identity.productId
    ) {
      return { verdict: 'UNCONFIRMED', identity: null, ordinal: null, code: 'IDENTITY_CONFLICT' };
    }
    return {
      verdict: 'REVALIDATED',
      identity: only.identity,
      ordinal: only.ordinal,
      code: 'TITLE_AND_ID_MATCH',
    };
  }

  const liveIdentifier = identifierFromUrl(pageUrl);
  const observedIdentifiers = new Set<string>();
  for (const c of observed) {
    if (c.identity.productId) observedIdentifiers.add(c.identity.productId);
  }
  if (liveIdentifier) observedIdentifiers.add(liveIdentifier);
  if (recorded.productId && observedIdentifiers.has(recorded.productId)) {
    // The detail page of this very entity — either the observed page URL or an
    // observed entity states the SAME catalog identifier. The recorded identity
    // stands, with the observed URL attached; no entity is invented or
    // substituted.
    return {
      verdict: 'REVALIDATED',
      identity: Object.freeze({ ...recorded, canonicalUrl: canonicalizeUrl(pageUrl) ?? recorded.canonicalUrl }),
      ordinal: recordedOrdinal,
      code: 'TITLE_AND_ID_MATCH',
    };
  }

  const liveCanonical = canonicalizeUrl(pageUrl);
  if (recorded.canonicalUrl && liveCanonical && liveCanonical === recorded.canonicalUrl) {
    return { verdict: 'REVALIDATED', identity: recorded, ordinal: recordedOrdinal, code: 'TITLE_AND_ID_MATCH' };
  }

  return { verdict: 'NOT_FOUND', identity: null, ordinal: null, code: 'IDENTITY_ABSENT' };
}

/** Identity of a candidate currently selected by ordinal on the live page. */
export function candidateAt(candidates: readonly EntityCandidate[], ordinal: number): EntityCandidate | null {
  return candidates.find((c) => c.ordinal === ordinal) ?? null;
}