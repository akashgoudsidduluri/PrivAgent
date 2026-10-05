/**
 * PHASE 18.8 / B2 — THE CONVERSATION CONTEXT CONTRACT.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * A bounded, typed record of ONE conversation: which turns happened (as typed
 * intent classes, never free text), which entities were OBSERVED on which page
 * generation, which one was selected, and what is still unresolved.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * It grants NOTHING. It is not an input to grounding, M5, the privacy firewall,
 * the security critic, risk/confirmation, containment, effect verification or
 * goal verification, and no authority is ever derived from it. A stale,
 * foreign or untrusted context can only make the agent ASK or STOP; it can
 * never make it ACT.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * The user's own words are NOT stored. A turn keeps the typed intent class the
 * intent boundary already produced, a stable hash of the text (so a mismatch is
 * detectable and the text is not reconstructible) and the text length. This is
 * the same rule `longHorizonPersistence.ts` applies to `originalGoal`.
 *
 * No raw password, payment or card value, no raw DOM value, no arbitrary page
 * text, no model output, no screenshot, no OCR text and no security internal is
 * an input to any field below. Entity titles and attributes are bounded,
 * normalized and screened with the existing M8 raw-value scanner BEFORE they
 * are admitted, and an identity that trips it is refused rather than downgraded.
 *
 * ── Bounds ──────────────────────────────────────────────────────────────────
 * Turns, candidates, attributes and every string are capped by an exported
 * constant. Growth is impossible by construction: each mutator returns a NEW
 * frozen context with the oldest entries dropped, never appending in place.
 */
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';

export const CONVERSATION_SCHEMA_VERSION = 1;

/** `chrome.storage.session` key. Never `chrome.storage` (disk). */
export const CONVERSATION_STORE_KEY = 'privagent.conversation.v1';

/** Hard bounds. A conversation cannot grow past these, ever. */
export const MAX_CONVERSATION_TURNS = 12;
export const MAX_CONVERSATION_CANDIDATES = 20;
export const MAX_CANDIDATE_ATTRIBUTES = 6;
export const MAX_IDENTITY_TITLE_CHARS = 80;
export const MAX_CLARIFICATION_CHARS = 160;
export const MAX_URL_CHARS = 200;
/**
 * Longest digit run kept from a numeric attribute. A catalog id (`3`, `4471`)
 * is short; a card number, an account number or a long token is not.
 */
export const MAX_NUMERIC_ATTRIBUTE_DIGITS = 12;
export const MAX_ATTRIBUTES_PER_CANDIDATE = MAX_CANDIDATE_ATTRIBUTES;

/** How long a conversation context may be reused after its last update. */
export const CONVERSATION_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Normalized entity kind. Derived from the content-side entity type so the
 * vocabulary is closed and cross-page comparable.
 */
export type EntityKind =
  | 'PRODUCT'
  | 'LISTING'
  | 'SEARCH_RESULT'
  | 'ARTICLE'
  | 'DOCUMENT'
  | 'TRANSACTION'
  | 'CONTACT'
  | 'TABLE_ROW'
  | 'CONTROL'
  | 'PAGE'
  | 'UNKNOWN';

/** Closed map from the content-script entity type to the normalized kind. */
const ENTITY_KIND_BY_TYPE: Readonly<Record<string, EntityKind>> = Object.freeze({
  Product: 'PRODUCT',
  SearchResult: 'SEARCH_RESULT',
  TableRow: 'TABLE_ROW',
  Article: 'ARTICLE',
  Document: 'DOCUMENT',
  Transaction: 'TRANSACTION',
  Contact: 'CONTACT',
  MenuItem: 'CONTROL',
  FormField: 'CONTROL',
  Event: 'UNKNOWN',
  Generic: 'LISTING',
});

export function entityKindFor(rawType: string | undefined): EntityKind {
  if (!rawType) return 'UNKNOWN';
  return ENTITY_KIND_BY_TYPE[rawType] ?? 'UNKNOWN';
}

/**
 * A stable, privacy-safe identity for one entity.
 *
 * The key is a stable hash of NORMALIZED, SCREENED attributes only. A DOM
 * detection id is deliberately absent: it is page-local and cannot survive a
 * navigation, which is the entire defect A15 exists to close.
 */
export interface EntityIdentity {
  readonly identityKey: string;
  readonly entityType: EntityKind;
  /** Lowercased, whitespace-collapsed, bounded. Screened on creation. */
  readonly normalizedTitle: string;
  /** scheme://host + path. Query and fragment are dropped (they carry tokens). */
  readonly canonicalUrl: string | null;
  /** Host only. Never a path, never a query. */
  readonly origin: string | null;
  /** Last meaningful path segment when it looks like an identifier. */
  readonly productId: string | null;
  /** Bounded, whitelisted, screened safe attributes. Never a raw secret. */
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

/** One referable entity as OBSERVED on one page generation. */
export interface EntityCandidate {
  /** 1-based, in observed document order (top-to-bottom, then left-to-right). */
  readonly ordinal: number;
  readonly identity: EntityIdentity;
  /** Verified evidence keys backing this candidate. Bounded; may be empty. */
  readonly evidenceKeys: readonly string[];
  readonly pageGeneration: number;
  readonly observedAt: number;
}

/**
 * The current selection, and whether it is still trustworthy.
 *
 * The recorded identity travels WITH the selection (bounded, screened). It is
 * what "it" resolves to after a navigation, provided A15 revalidates it against
 * the page now on screen.
 */
export interface EntitySelection {
  readonly identityKey: string;
  readonly ordinal: number;
  readonly identity: EntityIdentity;
  readonly resolvedAt: number;
  readonly revalidatedAt: number | null;
  readonly revalidation: 'SELECTED' | 'REVALIDATED' | 'UNCONFIRMED' | 'NOT_FOUND';
}

/** Typed reason a reference could not be resolved. Fixed vocabulary, no prose. */
export type ClarificationCode =
  | 'NO_CANDIDATES'
  | 'AMBIGUOUS_REFERENCE'
  | 'STALE_CANDIDATES'
  | 'CONFLICTING_IDENTITY'
  | 'OUT_OF_RANGE_ORDINAL'
  | 'UNTRUSTED_SELECTION'
  | 'ENTITY_NOT_FOUND_AFTER_NAVIGATION'
  | 'STALE_CONTEXT';

export interface ClarificationState {
  readonly code: ClarificationCode;
  /** Fixed copy, bounded. Never model prose, never an internal error. */
  readonly question: string;
  readonly referencePhrase: string | null;
  readonly at: number;
}

/** One user turn, recorded WITHOUT the user's words. */
export interface ConversationTurn {
  readonly index: number;
  /** Typed class from the intent boundary. Never free text. */
  readonly intentClass: string;
  /** Stable hash of the task text. Detects a mismatch; cannot be reversed. */
  readonly intentDigest: string;
  readonly taskLength: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly status: 'IN_PROGRESS' | 'ANSWER' | 'SUCCESS' | 'FAILED' | 'NEEDS_CLARIFICATION' | 'NEEDS_INFORMATION';
  readonly candidatesAdded: number;
}

/** Where the conversation is, in navigation terms. Structural only. */
export interface ConversationPage {
  readonly url: string | null;
  readonly origin: string | null;
  readonly role: string | null;
  readonly pageGeneration: number;
  readonly navigationCount: number;
  /**
   * The largest candidate list this conversation has OBSERVED. Kept so a later
   * turn can say "the items I saw are gone from this page" (STALE_CANDIDATES)
   * rather than the less truthful "I never had any items".
   */
  readonly lastObservedCandidateCount: number;
}

/** Terminal state of the LAST turn. Fixed copy only. */
export interface ConversationTerminal {
  readonly status: string;
  readonly reasonCode: string | null;
}

export type ContextFreshness = 'FRESH' | 'STALE' | 'INVALID';

export interface ConversationContext {
  readonly schemaVersion: number;
  readonly conversationId: string;
  /** Incremented on every accepted update; a mismatch invalidates the context. */
  readonly contextGeneration: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly turns: readonly ConversationTurn[];
  readonly candidates: readonly EntityCandidate[];
  readonly selection: EntitySelection | null;
  readonly page: ConversationPage;
  readonly terminal: ConversationTerminal;
  readonly clarification: ClarificationState | null;
  readonly freshness: ContextFreshness;
}

/** ── normalization + screening helpers ───────────────────────────────────── */

export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** True when a string trips the existing M8 raw-value scanner. */
function tripsPrivacy(value: string): boolean {
  return scanForRawSensitiveValues(value, { structuralKeys: new Set() }).length > 0;
}

/**
 * Normalize a display title into a bounded, lowercased identity attribute.
 * Returns null when the title is absent or trips the raw-value scanner — an
 * unsafe title yields NO identity, never a degraded one.
 */
export function normalizeTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!collapsed) return null;
  if (collapsed.length > MAX_IDENTITY_TITLE_CHARS) {
    const cut = collapsed.slice(0, MAX_IDENTITY_TITLE_CHARS);
    const boundary = cut.lastIndexOf(' ');
    const bounded = boundary > 0 ? cut.slice(0, boundary) : cut;
    return bounded || null;
  }
  if (tripsPrivacy(collapsed)) return null;
  return collapsed;
}

/**
 * Canonicalize a URL for identity comparison.
 *
 * Lowercased scheme and host, default port removed, `www.` prefix removed,
 * trailing slash removed, fragment dropped, and the query reduced to a
 * WHITELIST of identifier keys (`id`, `sku`, `item`, …) whose values are
 * identifier-shaped and individually screened. Everything else in the query is
 * dropped: a query string is the single most common carrier of a session token,
 * an email or a search phrase, none of which may enter identity.
 */
const CANONICAL_QUERY_ALLOWLIST: ReadonlySet<string> = new Set([
  'id',
  'itemid',
  'item',
  'pid',
  'productid',
  'product_id',
  'sku',
]);

/** The identifier portion of a canonical URL, or null when there is none. */
function safeQueryIdentifiers(u: URL): { query: string; identifier: string | null } {
  const parts: string[] = [];
  let identifier: string | null = null;
  for (const [rawKey, rawValue] of u.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    if (!CANONICAL_QUERY_ALLOWLIST.has(key)) continue;
    const value = String(rawValue).trim().toLowerCase();
    // Identifier shape only: letters, digits, dash, underscore.
    if (!/^[a-z0-9_-]{1,48}$/.test(value)) continue;
    // A digit run of PAN length is never an identifier.
    if (/^\d{13,19}$/.test(value)) continue;
    if (tripsPrivacy(value)) continue;
    parts.push(`${key}=${value}`);
    if (!identifier) identifier = value;
  }
  parts.sort();
  return { query: parts.length ? `?${parts.join('&')}` : '', identifier };
}

export function canonicalizeUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    const scheme = u.protocol.toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
    let path = u.pathname.replace(/\/+$/, '');
    if (path.length > MAX_URL_CHARS) path = path.slice(0, MAX_URL_CHARS);
    const { query } = safeQueryIdentifiers(u);
    const canonical = `${scheme}//${host}${port}${path}${query}`;
    if (canonical.length > MAX_URL_CHARS * 2) return null;
    return tripsPrivacy(canonical) ? null : canonical;
  } catch {
    return null;
  }
}

/** The identifier in a URL (allowlisted query id, else an id-like path segment). */
export function identifierFromUrl(raw: string | null | undefined): string | null {
  const canonical = canonicalizeUrl(raw);
  if (!canonical) return null;
  try {
    const u = new URL(canonical);
    const fromQuery = safeQueryIdentifiers(u).identifier;
    if (fromQuery) return fromQuery;
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments.length ? segments[segments.length - 1]! : '';
    if (last && last.length <= 48 && !/\s|\.[a-z]{2,4}$/i.test(last) && !tripsPrivacy(last)) return last;
    return null;
  } catch {
    return null;
  }
}

/** Host only, `www.`-stripped, bounded. Never a path or query. */
export function hostOf(raw: string | null | undefined): string | null {
  const canonical = canonicalizeUrl(raw);
  if (!canonical) return null;
  try {
    return new URL(canonical).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Attribute keys that may form identity. Everything else is dropped. */
const IDENTITY_ATTRIBUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'price',
  'currency',
  'rating',
  'reviews',
  'availability',
  'brand',
  'category',
  'condition',
  'sku',
  'identifier',
  'itemid',
  'productid',
  'type',
  'role',
  'code',
  'asin',
  'gtin',
  'ean',
  'upc',
  'isbn',
]);

/**
 * Is this normalized attribute key an IDENTIFIER?
 *
 * Catalog pages publish their product id as a `data-*` attribute, so the
 * normalized key ends in `id` (`data-product-id` → `dataproductid`). Accepting
 * that shape is what lets identity survive navigation to the detail page.
 */
function isIdentifierAttributeKey(normalizedKey: string): boolean {
  return normalizedKey.endsWith('id') && normalizedKey.length > 2;
}

function sanitizeAttributes(
  raw: Record<string, string | number | boolean> | undefined | null
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== 'object') return out;
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_CANDIDATE_ATTRIBUTES) break;
    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!IDENTITY_ATTRIBUTE_ALLOWLIST.has(normalizedKey) && !isIdentifierAttributeKey(normalizedKey)) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      //
      // A numeric attribute is NOT automatically safe. The DOM reader coerces
      // a long digit run published as a `data-*` attribute (a card or account
      // number) into a NUMBER, and a bare `Number.isFinite` check would carry
      // that digit run straight into the conversation as an identity attribute.
      // Numbers are screened exactly like strings, and a long digit run is
      // refused before the scanner even sees it.
      const digits = String(value);
      if (digits.replace(/[-.]/g, '').length > MAX_NUMERIC_ATTRIBUTE_DIGITS) continue;
      if (tripsPrivacy(digits)) continue;
      out[normalizedKey] = value;
      kept += 1;
      continue;
    }
    if (typeof value === 'boolean') {
      out[normalizedKey] = value;
      kept += 1;
      continue;
    }
    if (typeof value !== 'string') continue;
    const text = value.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text || text.length > 48) continue;
    if (tripsPrivacy(text)) continue;
    out[normalizedKey] = text;
    kept += 1;
  }
  return Object.freeze(out);
}

/** ── identity construction ───────────────────────────────────────────────── */

/**
 * Build a stable identity, or return null.
 *
 * The key is a hash of exactly four normalized, screened attributes: kind,
 * title, canonical URL and product id. Two pages that show the same product
 * therefore agree on identity even when every DOM id has changed; two different
 * products never collide unless all four agree.
 */
export function buildIdentity(input: {
  entityType: EntityKind;
  title: string | null | undefined;
  url?: string | null;
  productId?: string | null;
  attributes?: Record<string, string | number | boolean> | null;
}): EntityIdentity | null {
  const normalizedTitle = normalizeTitle(input.title);
  if (!normalizedTitle) return null;
  const canonicalUrl = canonicalizeUrl(input.url);
  const origin = hostOf(input.url);
  const attributes = sanitizeAttributes(input.attributes);
  let productId = typeof input.productId === 'string' ? input.productId.trim().toLowerCase() : '';
  // The catalog's OWN identifier attribute wins over a URL path segment: a
  // listing page URL ends in the page name ("/catalog"), which identifies
  // nothing, while `data-product-id` is the identifier that survives the jump to
  // the detail page.
  if (!productId) {
    for (const [key, value] of Object.entries(attributes)) {
      if (!isIdentifierAttributeKey(key)) continue;
      //
      // A catalog publishes its id as `data-product-id="3"`, and the DOM
      // attribute reader has already coerced that to the NUMBER 3. Accepting
      // only strings silently dropped every numeric identifier, so a listing
      // candidate could never be re-established on its own detail page — the
      // identity had nothing but the listing URL to carry across. A finite,
      // bounded number is accepted, and is screened exactly like a string.
      const identifier =
        typeof value === 'string' && value
          ? value
          : typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e15
            ? String(value)
            : '';
      if (identifier) {
        productId = identifier;
        break;
      }
    }
  }
  if (!productId) productId = identifierFromUrl(input.url) ?? '';
  if (productId && tripsPrivacy(productId)) productId = '';
  const identityKey = stableHash(
    `${input.entityType}|${normalizedTitle}|${canonicalUrl ?? ''}|${productId}`
  );
  return Object.freeze({
    identityKey,
    entityType: input.entityType,
    normalizedTitle,
    canonicalUrl,
    origin,
    productId: productId || null,
    attributes,
  });
}

/**
 * Create one candidate. `ordinal` is assigned by the caller from OBSERVED
 * document order, never from a previous array position.
 */
export function createCandidate(input: {
  ordinal: number;
  identity: EntityIdentity;
  pageGeneration: number;
  observedAt: number;
  evidenceKeys?: readonly string[];
}): EntityCandidate {
  return Object.freeze({
    ordinal: input.ordinal,
    identity: input.identity,
    evidenceKeys: Object.freeze([...(input.evidenceKeys ?? [])].slice(0, MAX_CANDIDATE_ATTRIBUTES)),
    pageGeneration: input.pageGeneration,
    observedAt: input.observedAt,
  });
}

/** ── context construction + bounded mutation ─────────────────────────────── */

export function createConversationContext(input: {
  conversationId: string;
  now: number;
  pageUrl?: string | null;
}): ConversationContext {
  return Object.freeze({
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    conversationId: input.conversationId,
    contextGeneration: 1,
    createdAt: input.now,
    updatedAt: input.now,
    turns: Object.freeze([]),
    candidates: Object.freeze([]),
    selection: null,
    page: Object.freeze({
      url: canonicalizeUrl(input.pageUrl) ?? null,
      origin: hostOf(input.pageUrl) ?? null,
      role: null,
      pageGeneration: 0,
      navigationCount: 0,
      lastObservedCandidateCount: 0,
    }),
    terminal: Object.freeze({ status: 'IN_PROGRESS', reasonCode: null }),
    clarification: null,
    freshness: 'FRESH',
  });
}

/** Every mutator returns a NEW frozen context with the generation advanced. */
function advance(ctx: ConversationContext, patch: Partial<ConversationContext>, now: number): ConversationContext {
  return Object.freeze({
    ...ctx,
    ...patch,
    contextGeneration: ctx.contextGeneration + 1,
    updatedAt: now,
  });
}

export function appendTurn(
  ctx: ConversationContext,
  turn: {
    intentClass: string;
    intentDigest: string;
    taskLength: number;
    now: number;
  }
): { context: ConversationContext; index: number } {
  const index = ctx.turns.length;
  const next: ConversationTurn = Object.freeze({
    index,
    intentClass: turn.intentClass,
    intentDigest: turn.intentDigest,
    taskLength: turn.taskLength,
    startedAt: turn.now,
    endedAt: null,
    status: 'IN_PROGRESS',
    candidatesAdded: 0,
  });
  const turns = [...ctx.turns, next].slice(-MAX_CONVERSATION_TURNS).map((t, i) =>
    Object.freeze({ ...t, index: i })
  );
  return {
    context: advance(ctx, { turns: Object.freeze(turns), terminal: Object.freeze({ status: 'IN_PROGRESS', reasonCode: null }) }, turn.now),
    index,
  };
}

/** Record the outcome of a turn. */
export function closeTurn(
  ctx: ConversationContext,
  turnIndex: number,
  status: ConversationTurn['status'],
  now: number,
  candidatesAdded = 0
): ConversationContext {
  const turns = ctx.turns.map((t) =>
    t.index === turnIndex
      ? Object.freeze({ ...t, status, endedAt: now, candidatesAdded })
      : t
  );
  return advance(ctx, { turns: Object.freeze(turns) }, now);
}

/**
 * Record the entities OBSERVED on the current page.
 *
 * Candidates from an OLDER page generation are dropped rather than merged: a
 * candidate that no longer describes the live page must not be resolvable by
 * "the third one". The SELECTION survives (A15 revalidation re-establishes it
 * against the new page); the candidate list does not.
 */
export function observeCandidates(
  ctx: ConversationContext,
  candidates: readonly EntityCandidate[],
  now: number,
  pageGeneration: number
): ConversationContext {
  const bounded = [...candidates].slice(0, MAX_CONVERSATION_CANDIDATES);
  return advance(
    ctx,
    {
      candidates: Object.freeze(bounded),
      page: Object.freeze({
        ...ctx.page,
        pageGeneration,
        lastObservedCandidateCount:
          bounded.length > 0 ? bounded.length : ctx.page.lastObservedCandidateCount,
      }),
    },
    now
  );
}

/** Navigation changes the page generation and the canonical URL. Never the id. */
export function withPage(
  ctx: ConversationContext,
  page: { url: string | null; role: string | null; pageGeneration: number; navigated?: boolean },
  now: number
): ConversationContext {
  return advance(
    ctx,
    {
      page: Object.freeze({
        url: canonicalizeUrl(page.url) ?? null,
        origin: hostOf(page.url) ?? ctx.page.origin,
        role: page.role,
        pageGeneration: page.pageGeneration,
        navigationCount: ctx.page.navigationCount + (page.navigated ? 1 : 0),
        lastObservedCandidateCount: ctx.page.lastObservedCandidateCount,
      }),
    },
    now
  );
}

export function withSelection(ctx: ConversationContext, selection: EntitySelection, now: number): ConversationContext {
  return advance(ctx, { selection: Object.freeze({ ...selection }) }, now);
}

export function withTerminal(
  ctx: ConversationContext,
  status: string,
  reasonCode: string | null,
  now: number
): ConversationContext {
  return advance(ctx, { terminal: Object.freeze({ status, reasonCode }) }, now);
}

export function withClarification(
  ctx: ConversationContext,
  code: ClarificationCode,
  question: string,
  referencePhrase: string | null,
  now: number
): ConversationContext {
  const bounded = question.slice(0, MAX_CLARIFICATION_CHARS);
  return advance(
    ctx,
    {
      clarification: Object.freeze({ code, question: bounded, referencePhrase, at: now }),
    },
    now
  );
}

export function clearClarification(ctx: ConversationContext, now: number): ConversationContext {
  return advance(ctx, { clarification: null }, now);
}

/** ── validity + freshness ────────────────────────────────────────────────── */

/**
 * Is this context usable for a new turn?
 *
 * Fails closed on: wrong schema, a different conversation, a generation that
 * does not match what the caller holds, an age beyond the bound, or a context
 * that was already invalidated. Each condition is a NEW conversation.
 */
export function isUsableContext(
  ctx: ConversationContext | null | undefined,
  expected: { conversationId: string; contextGeneration?: number; now: number }
): ctx is ConversationContext {
  if (!ctx || typeof ctx !== 'object') return false;
  if (ctx.schemaVersion !== CONVERSATION_SCHEMA_VERSION) return false;
  if (ctx.conversationId !== expected.conversationId) return false;
  if (ctx.freshness === 'INVALID') return false;
  if (typeof expected.contextGeneration === 'number' && ctx.contextGeneration !== expected.contextGeneration) {
    return false;
  }
  if (!Number.isFinite(expected.now) || expected.now - ctx.updatedAt > CONVERSATION_MAX_AGE_MS) return false;
  return true;
}

export function contextFreshness(ctx: ConversationContext, now: number): ContextFreshness {
  if (ctx.freshness === 'INVALID') return 'INVALID';
  if (now - ctx.updatedAt > CONVERSATION_MAX_AGE_MS) return 'STALE';
  return 'FRESH';
}

/**
 * Candidates that describe the LIVE page. A reference can only resolve against
 * these, which is what stops "the third one" from silently meaning the third
 * row of a page the agent has already left.
 */
export function eligibleCandidates(ctx: ConversationContext): readonly EntityCandidate[] {
  return ctx.candidates.filter((c) => c.pageGeneration === ctx.page.pageGeneration);
}

/** Deterministic conversation id. Not a secret; it identifies scope only. */
export function nextConversationId(seed: string): string {
  return `conv-${stableHash(seed)}`;
}