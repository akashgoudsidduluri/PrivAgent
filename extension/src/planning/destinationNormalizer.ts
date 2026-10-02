/**
 * PrivAgent — Destination Normalizer (POST-17.10 destination-intent contract)
 *
 * WHAT THIS IS
 * ────────────
 * The DECLARATION channel. It turns a user's task text into a typed statement of
 * what page the agent believes it was asked to reach, or an explicit refusal to
 * make such a statement.
 *
 * It does NOT observe the browser. It does NOT verify anything. It never sees a
 * page, a DOM, a world model, or model output — its entire input surface is one
 * `string`. Comparison against observed page identity is the destination
 * verifier's job, and task SUCCESS remains Goal Verification's job alone.
 *
 * WHY IT IS NOT A KEYWORD MATCHER
 * ───────────────────────────────
 * The difference between this and `task.includes('catalog')` is the GATE, not
 * the vocabulary:
 *
 *   • a destination verb from a CLOSED class is mandatory (N1);
 *   • the role noun is only ever read from that verb's complement slot, within a
 *     bounded modifier run that stops at the first preposition or clause
 *     boundary (N12);
 *   • the head must be a member of a CLOSED, enumerated table whose values are
 *     drawn from the existing `SemanticPageType` enum — no new values are added
 *     and no word list is open-ended;
 *   • assertion phrasing ("I already opened …") is explicitly not authority (N8).
 *
 * So `"catalog"` on its own declares nothing, and neither do `"catalog number"`,
 * `"checkout price"`, `"search for 'checkout'"` or `"find the product named
 * catalog"` — the noun is never even examined, because the gate never opened.
 *
 * GRAMMAR PROVENANCE
 * ──────────────────
 * The verb class, the noun-slot stop-words, the prepositional frame and the
 * already-opened contrast are all modelled on `background/targetResolver.ts`
 * (`EXPLICIT_OPEN_VERB` at :433, `STOP_WORDS` at :308 and :338,
 * `isAlreadyOpenedIntent` at :230). That module is deliberately NOT edited and
 * NOT imported: it governs tab provisioning, and coupling declaration parsing to
 * a provisioning module would let a security-relevant change there silently
 * rewrite what the agent believes the user asked for. The classes are restated
 * here and pinned by `tests/destinationNormalizer.test.ts`.
 *
 * One deliberate divergence: `targetResolver` captures exactly ONE token after
 * the verb (`([a-zA-Z0-9-]+)` at :301), so `"open the store catalog"` captures
 * the determiner and falls through. This module allows a bounded modifier run of
 * up to {0,2} tokens before the head, which is the parser extension the audit
 * identified as the one piece of work classification B required.
 *
 * HARD INVARIANTS (each has a mutation probe)
 * ───────────────────────────────────────────
 *  N1  A destination may only be declared from the complement of an explicit
 *      destination verb, or from a user-typed URL.
 *  N2  A content noun without destination syntax can never create a declaration.
 *  N3  The head must be in the closed page-role table; an unmappable head is
 *      `UNSUPPORTED`, never a guess.
 *  N4  Declarations are pure values. Nothing here mutates, and nothing mutates
 *      these.
 *  N5  No browser observation participates — the signature makes it impossible.
 *  N6  No model output participates — the signature makes it impossible.
 *  N7  Task category and `ParsedGoalResult.actionIntent` do not participate.
 *      `actionIntent` is substring-based (`goalParser.ts:147-150` tests
 *      `lower.includes('product')`), so it is explicitly NOT an input.
 *  N8  Assertion phrasing is not authority.
 *  N9  A head with more than one legitimate reading is `AMBIGUOUS`.
 *  N10 `UNKNOWN` is never declarable — it is the absence of observation.
 *  N11 The role vocabulary is the existing `SemanticPageType` enum.
 *  N12 The modifier run is bounded to {0,2} and stops at a boundary.
 *  N13 Provenance is derived from the mechanism that opened the gate.
 *  N14 A URL declaration is normalised here but NEVER self-evidences. Only
 *      `origin` + `path` are comparable; `rawUrl` is provenance and must never
 *      be used for comparison, because its query string is exactly the sort of
 *      substring that must never carry destination identity.
 *  N15 `NONE` does not block the task; the subgoal simply stays unverifiable.
 *  N16 `AMBIGUOUS` never authorises a guess.
 *  N17 Multiple destination-bearing constructs yield an ordered list.
 *  N18 An entry URL is NOT a destination constraint. When a role noun was
 *      declared, a co-occurring user URL is the site to START at, and it is
 *      recorded on `entryUrl`. Only a URL that is itself the requested
 *      destination is recorded on `url`. The two are separate fields and are
 *      never interchangeable: `entryUrl` is never compared against an observed
 *      URL, and `/` therefore never has to "match" `/results.html`.
 *  N19 The entry/destination split is decided by the USER'S GRAMMAR alone.
 *      No browser observation, page type, DOM, model output, task category or
 *      action intent participates, so no amount of observed state can rewrite
 *      which of the two the user wrote. This is what makes the declaration
 *      immutable under observation rather than merely currently-unmutated.
 *  N20 POST-17.10 Step 10.2 (G3). A user URL is the DESTINATION of the
 *      construct whose verb governs it ("open <url>", "visit <url>",
 *      "navigate to <url>") and the ENTRY SITE only of a construct that named
 *      its destination in words ("open the catalog at <url>"). Before, the URL
 *      was attached after the fact to whichever declaration happened to carry a
 *      role, so an explicit destination URL silently became somebody else's
 *      `entryUrl` — and two tasks that differ in which construct owns the URL
 *      produced byte-identical declarations. Both channels stay mutually
 *      exclusive for one literal, and the decision still uses only the user's
 *      own sentence.
 *
 * WHY ENTRY AND DESTINATION ARE SEPARATE (POST-17.10 Step 6)
 * ─────────────────────────────────────────────────────────
 * `"open the store catalog at http://localhost:4174"` names TWO different
 * things: `http://localhost:4174` is where to START, and `store catalog` is the
 * destination. The real site then reaches `/results.html`. Collapsing the two
 * made the destination URL `/` and forced the verifier to compare `/` against
 * `/results.html` — which correctly MISMATCHed. The defect was never in the
 * comparison; it was in what the user was understood to have asked for.
 *
 * The fix is representational, not comparative. Exact URL matching is unchanged:
 * when a URL genuinely IS the requested destination, it is still compared
 * exactly, with no substring matching and no `/`-matches-anything rule.
 */

import type { SemanticPageType } from '../semanticUnderstanding/semanticTypes';

// ══════════════════════════════════════════════════════════════════════════════
// Result types
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Where a declaration came from. Provenance is a DISCRIMINATED field, not a
 * debug string, because it is the reviewable answer to "who declared this, and
 * by what permitted mechanism" — and because it is what makes an illegitimate
 * declaration (category-inferred, model-authored) detectable.
 */
export type DestinationProvenance = 'USER_URL' | 'EXPLICIT_PAGE_ROLE';

/**
 * A user-typed destination URL, normalised.
 *
 * `origin` and `path` are the ONLY comparable fields. `rawUrl` is retained for
 * provenance and is deliberately not normalised, because a query string must
 * never become identity (N14). Comparison is the verifier's job and is exact,
 * never substring-based.
 */
export interface UrlDeclaration {
  readonly provenance: 'USER_URL';
  readonly origin: string;
  readonly path: string;
  readonly rawUrl: string;
}

/**
 * A user-typed site to START at, when the destination itself was named in
 * words rather than by URL. Deliberately its own type rather than a flag on
 * `UrlDeclaration`: the distinction is the whole point of this module, and one
 * boolean is exactly the kind of representation that gets conflated again.
 *
 * Reuses `NormalizedUrl` rather than defining a second URL shape (Step 6), and
 * deliberately has NO counterpart on `DestinationObservation` — there is
 * nothing to compare it against, because the entry URL is a provisioning fact,
 * not a destination constraint (N18).
 */
export interface EntryUrlDeclaration {
  readonly provenance: 'USER_ENTRY_SITE';
  readonly origin: string;
  readonly path: string;
  readonly rawUrl: string;
}

/** A verb-gated page-role claim over the existing `SemanticPageType` enum. */
export interface RoleDeclaration {
  readonly provenance: 'EXPLICIT_PAGE_ROLE';
  /** Never contains `UNKNOWN` (N10). Never empty. */
  readonly acceptablePageTypes: readonly SemanticPageType[];
}

export type DestinationDeclaration =
  /** No destination-bearing construct at all. Task continues (N15). */
  | { readonly kind: 'NONE' }
  /** Exactly one reading, with at least one DESTINATION channel present. */
  | {
      readonly kind: 'DECLARED';
      readonly role?: RoleDeclaration;
      /** Set ONLY when the URL is itself the requested destination. */
      readonly url?: UrlDeclaration;
      /**
       * Where the browser should start. NEVER a destination constraint, and
       * never read by the verifier (N18).
       */
      readonly entryUrl?: EntryUrlDeclaration;
    }
  /** Two or more legitimate readings. Never guessed, never blocked (N9, N16). */
  | {
      readonly kind: 'AMBIGUOUS';
      readonly candidates: readonly (readonly SemanticPageType[])[];
      readonly provenance: 'EXPLICIT_PAGE_ROLE';
    }
  /** A destination verb whose head the current ontology cannot express. */
  | {
      readonly kind: 'UNSUPPORTED';
      /** The role noun the user supplied, or '' when the slot bound was hit. */
      readonly unmappedHead: string;
      readonly provenance: 'EXPLICIT_PAGE_ROLE';
    };

// ══════════════════════════════════════════════════════════════════════════════
// The closed grammar
// ══════════════════════════════════════════════════════════════════════════════

/**
 * N1 — single-token destination verbs. Mirrors the one-word members of
 * `EXPLICIT_OPEN_VERB` (`targetResolver.ts:433`).
 *
 * Bare `go` is deliberately ABSENT: the audited class contains `go\s+to` only,
 * and admitting `go` alone would make `"go shopping"` look like a destination
 * request when it is not.
 *
 * `show`, `find`, `search`, `look`, `continue` and `want` are deliberately
 * ABSENT: they introduce content requests, not destinations. That absence is
 * what makes `"show me products"` and `"search for 'checkout'"` resolve to NONE.
 */
const DESTINATION_VERBS_ONE = new Set([
  'open', 'opens', 'opened', 'goto', 'visit', 'visits', 'navigate',
  'launch', 'launches', 'browse', 'browses', 'load', 'loads',
]);

/**
 * N8 — verbs that are grammatically a destination construct but carry NO
 * authority. `"I already opened X"` asserts the destination is UP, which is the
 * opposite of a request to open it, so the construct declares nothing.
 *
 * This is deliberately scoped to the CONSTRUCT, not to the whole task. A blanket
 * veto would also discard an unrelated genuine request in the same sentence —
 * `"I opened the shop earlier, now open the contact form"` must still be able to
 * declare the form.
 */
const NON_AUTHORIZING_VERBS = new Set(['opened']);

/**
 * A verb immediately preceded by `already` is likewise an assertion about state
 * rather than a request, in either inflection: `"already open the login page"`
 * describes the page, it does not ask for it to be opened.
 */
const NON_AUTHORIZING_PREV = new Set(['already']);

/** N1 — two-token destination verbs. */
const DESTINATION_VERBS_TWO = new Set(['go to', 'navigate to']);

/**
 * N8 — assertion phrasing, retained from `isAlreadyOpenedIntent`
 * (`targetResolver.ts:230`) in scoped form. The decision itself is made per
 * construct via `NON_AUTHORIZING_VERBS`, so this pattern only detects the
 * stronger `"already open"` / `"have opened"` phrasings, which contain no
 * destination verb at all.
 */
const ASSERTION_PHRASE =
  /\b(?:already\s+open|have\s+opened|has\s+opened)\b/i;

/**
 * N12 — where the noun slot ends. A preposition or conjunction terminates the
 * complement, so `"open the catalog and then find bags"` can never bind `bags`
 * as the catalog's head. Mirrors the prepositional frame at :338.
 */
const SLOT_TERMINATORS = new Set([
  'and', 'then', 'but', 'so', 'because', 'while', 'when', 'after', 'before',
  'or', 'plus', 'also', 'now', 'next',
  'at', 'on', 'in', 'to', 'from', 'for', 'with', 'of', 'into', 'about',
  'using', 'via', 'under', 'over',
]);

/**
 * Nouns that can neither open nor close the head slot. Mirrors the `STOP_WORDS`
 * sets at :308 and :338, plus the possessives a user naturally writes.
 */
const DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'my', 'your', 'our', 'its', 'their', 'some', 'any', 'all', 'each', 'every',
  'me', 'us', 'new',
]);

/** Trailing nouns that are never the head: `"the checkout page"` → `checkout`. */
const TRAILING_NOUNS = new Set([
  'page', 'tab', 'screen', 'view', 'section', 'listed', 'shown', 'displayed',
]);

/** N12 — the bounded modifier run. A longer span fails closed. */
const MAX_MODIFIERS = 2;

/** How many tokens after the verb are inspected at all. A hard window. */
const SLOT_WINDOW = 8;

/**
 * N1 — the user-typed URL channel. Mirrors `parseTaskTargetReference` form 1.
 */
const EXPLICIT_URL = /https?:\/\/[^\s"'`)\]]+/i;

/**
 * Sentence punctuation immediately after a URL is not part of it. A user writes
 * `"open the catalog at http://localhost:4174, then ..."` far more often than the
 * punctuation-free form; without this the comma is captured, `new URL()` rejects
 * the port (`4174,`), and the URL channel is lost entirely. Trimming terminal
 * punctuation cannot loosen anything — the trimmed URL still has to parse and
 * still has to pass the scheme check, and its `origin`+`path` are still
 * compared exactly.
 */
const URL_TRAILING_PUNCTUATION = /[.,;:!]+$/;

/** Every URL occurrence, for stripping URLs out of the token stream. */
const EXPLICIT_URL_GLOBAL = new RegExp(EXPLICIT_URL.source, 'gi');

/**
 * POST-17.10 Step 10.2 (G3) — the in-token stand-in for the user's FIRST URL.
 *
 * It must survive `tokenize` unchanged (so it may only use `[a-z0-9]`, spaces
 * and intra-token hyphens), it must never be a real English word, and it must
 * never collide with the closed `PAGE_ROLE_TABLE` head keys — if it did, a
 * construct whose verb was followed by a URL would bind the placeholder as a
 * role head instead of taking the URL branch above.
 */
const URL_PLACEHOLDER = '-paurlref-';

/** N11 — the closed page-role table. Keys are user-facing head nouns. */
type RoleReadings = readonly (readonly SemanticPageType[])[];

/**
 * Heads NOT listed here produce `UNSUPPORTED`, which is the honest outcome for a
 * destination the current vocabulary cannot express: a product detail page
 * (`PRODUCT` does not exist and was not invented), a shop front, an account
 * area, or a bare URL with no role noun.
 */
const PAGE_ROLE_TABLE: ReadonlyMap<string, RoleReadings> = new Map<string, RoleReadings>([
  // ── listing ──────────────────────────────────────────────────────────────
  ['catalog', [['LISTING']]],
  ['catalogue', [['LISTING']]],
  ['listing', [['LISTING']]],
  ['listings', [['LISTING']]],
  ['search result', [['LISTING']]],
  ['search results', [['LISTING']]],
  ['product list', [['LISTING']]],
  ['item list', [['LISTING']]],
  ['shop front', [['LISTING']]],
  ['storefront', [['LISTING']]],
  ['store front', [['LISTING']]],

  // ── search ───────────────────────────────────────────────────────────────
  ['search', [['SEARCH']]],
  ['search page', [['SEARCH']]],
  ['search box', [['SEARCH']]],
  ['search bar', [['SEARCH']]],

  // ── checkout ─────────────────────────────────────────────────────────────
  ['checkout', [['CHECKOUT']]],
  ['check out', [['CHECKOUT']]],
  ['cart', [['CHECKOUT']]],
  ['basket', [['CHECKOUT']]],
  ['payment page', [['CHECKOUT']]],

  // ── login ────────────────────────────────────────────────────────────────
  ['login', [['LOGIN']]],
  ['sign in', [['LOGIN']]],
  ['signin', [['LOGIN']]],
  ['log in', [['LOGIN']]],
  ['login page', [['LOGIN']]],

  // ── form ─────────────────────────────────────────────────────────────────
  ['form', [['FORM']]],
  ['contact form', [['FORM']]],
  ['signup form', [['FORM']]],
  ['sign up form', [['FORM']]],
  ['application', [['FORM']]],

  // ── article ──────────────────────────────────────────────────────────────
  ['article', [['ARTICLE']]],
  ['blog', [['ARTICLE']]],
  ['blog post', [['ARTICLE']]],
  ['post', [['ARTICLE']]],
  ['news', [['ARTICLE']]],

  // ── settings / dashboard ────────────────────────────────────────────────
  ['settings', [['SETTINGS']]],
  ['preferences', [['SETTINGS']]],
  ['dashboard', [['DASHBOARD']]],

  // ── genuinely ambiguous (N9) ────────────────────────────────────────────
  // Each head has TWO defensible readings over the EXISTING enum. No value is
  // invented; the ambiguity is real and the only correct answer is to ask.
  ['results', [['LISTING'], ['SEARCH']]],
  ['orders', [['CHECKOUT'], ['DASHBOARD']]],
  ['account', [['LOGIN'], ['DASHBOARD']]],
  ['history', [['DASHBOARD'], ['ARTICLE']]],
  ['review', [['ARTICLE'], ['CHECKOUT']]],
  ['overview', [['DASHBOARD'], ['ARTICLE']]],
]);

// ══════════════════════════════════════════════════════════════════════════════
// Internals
// ══════════════════════════════════════════════════════════════════════════════

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    // keep intra-phrase hyphens and apostrophes ("store-front", "sign-in")
    .replace(/[^a-z0-9\s'’-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * The ONE URL normalization rule in the destination system: scheme-checked,
 * origin-lowercased, pathname-only, trailing slash stripped.
 *
 * Exported so the verifier compares URLs by exactly the same rule the
 * declaration was produced with. A second normalizer anywhere else would be a
 * second competing notion of what "the same URL" means.
 *
 * Query and fragment are dropped deliberately (N14): `?q=catalog` must never
 * make `/search.html` equal to `/catalog`.
 */
export interface NormalizedUrl {
  readonly origin: string;
  readonly path: string;
}

export function normalizeDestinationUrl(rawUrl: string): NormalizedUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return {
    origin: parsed.origin.toLowerCase(),
    path: (parsed.pathname || '/').replace(/\/+$/, '').toLowerCase() || '/',
  };
}

function normalizeUrl(rawUrl: string): UrlDeclaration | null {
  const normalized = normalizeDestinationUrl(rawUrl);
  if (!normalized) return null;
  return { provenance: 'USER_URL', ...normalized, rawUrl };
}

/**
 * The same normalization rule (N14 applies identically), different MEANING.
 * Sharing `normalizeDestinationUrl` is deliberate: one notion of what two URLs
 * being "the same" means, two distinct statements about what the user asked.
 */
function normalizeEntryUrl(rawUrl: string): EntryUrlDeclaration | null {
  const normalized = normalizeDestinationUrl(rawUrl);
  if (!normalized) return null;
  return { provenance: 'USER_ENTRY_SITE', ...normalized, rawUrl };
}

/**
 * Exact tokenised verb match, LONGEST first. Never a substring test (N1).
 *
 * The two-token form must be tried before the one-token form, otherwise
 * `"navigate to settings"` consumes only `navigate` and the slot immediately
 * terminates on the preposition `to`.
 */
function matchVerb(tokens: string[], i: number): 0 | 1 | 2 {
  const two = i + 1 < tokens.length ? `${tokens[i]} ${tokens[i + 1]}` : undefined;
  if (two !== undefined && DESTINATION_VERBS_TWO.has(two)) return 2;
  const one = tokens[i];
  if (one !== undefined && DESTINATION_VERBS_ONE.has(one)) return 1;
  return 0;
}

type HeadResolution =
  | {
      readonly ok: true;
      /** Determiner-stripped slot, trailing page-nouns INTACT, for lookup. */
      readonly slot: string[];
      /** The same slot with trailing page-nouns stripped, for lookup order. */
      readonly trimmed: string[];
      /** The trailing-stripped head, for reporting an unmappable head. */
      readonly head: string;
      readonly modifiers: string[];
      readonly consumed: number;
      /** Tokens that followed the terminating preposition, up to 3. */
      readonly afterBoundary: string[];
    }
  /** No head before a boundary — this construct simply declares nothing. */
  | { readonly ok: false; readonly reason: 'NO_HEAD' }
  /** A head was reached but the modifier run exceeded the bound — fail closed. */
  | { readonly ok: false; readonly reason: 'BOUND_EXCEEDED' };

function resolveHead(tokens: string[], startIndex: number): HeadResolution {
  const collected: string[] = [];
  const afterBoundary: string[] = [];
  const limit = Math.min(tokens.length, startIndex + SLOT_WINDOW);
  let hitBoundary = false;

  for (let i = startIndex; i < limit; i += 1) {
    const t = tokens[i]!;
    if (SLOT_TERMINATORS.has(t)) {
      hitBoundary = true;
      // N12 — the complement cannot reach across a preposition, but the
      // preposition may itself be part of a compound head ("sign in"), so a
      // bounded continuation is kept for an exact vocabulary match.
      if (afterBoundary.length < 3) afterBoundary.push(t);
      continue;
    }
    if (hitBoundary) {
      if (afterBoundary.length < 4) afterBoundary.push(t);
      continue;
    }
    collected.push(t);
  }

  while (collected.length > 0 && DETERMINERS.has(collected[0]!)) collected.shift();
  if (collected.length === 0) return { ok: false, reason: 'NO_HEAD' };

  // Trailing page-nouns are never the head, but they ARE part of a multi-word
  // entry ("the payment page"), so the strip happens for the head only.
  const trimmed = [...collected];
  while (trimmed.length > 0 && TRAILING_NOUNS.has(trimmed[trimmed.length - 1]!)) trimmed.pop();
  if (trimmed.length === 0) return { ok: false, reason: 'NO_HEAD' };

  const modifiers = trimmed.slice(0, -1);
  if (modifiers.length > MAX_MODIFIERS) return { ok: false, reason: 'BOUND_EXCEEDED' };

  return {
    ok: true,
    slot: collected,
    trimmed,
    head: trimmed[trimmed.length - 1]!,
    modifiers,
    consumed: collected.length,
    afterBoundary,
  };
}

/**
 * Resolve the slot to a role reading.
 *
 * Four ordered sources, because the same token can be a boundary in one phrase
 * and part of a compound head in another:
 *
 *   1. `collected + boundary continuation` — lets the CLOSED vocabulary override
 *      a boundary, and only by exact match: `"the sign in page"` resolves via
 *      `sign in`, while `"the catalog in the shop"` does not, because no
 *      `catalog in …` entry exists. An extension span MUST cross the boundary
 *      (minimum span 2), so the continuation can never be read as the head on
 *      its own — that is what stops `"the catalog on my search site"` from
 *      resolving to SEARCH.
 *   2. trailing-stripped slot — `"the checkout page"` resolves via `checkout`.
 *   3. unstripped slot — `"the payment page"` resolves via `payment page`.
 *
 * Every candidate is an exact key in `PAGE_ROLE_TABLE`. Nothing else resolves.
 */
function lookupHead(resolution: Extract<HeadResolution, { ok: true }>): RoleReadings | null {
  const collected = resolution.slot;
  const trimmed = resolution.trimmed;
  const afterBoundary = resolution.afterBoundary;

  const seen = new Set<string>();
  const trySource = (source: string[], minSpan: number): RoleReadings | null => {
    const maxSpan = Math.min(source.length, 3);
    for (let span = maxSpan; span >= minSpan; span -= 1) {
      const candidate = source.slice(source.length - span).join(' ');
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const hit = PAGE_ROLE_TABLE.get(candidate);
      if (hit) return hit;
    }
    return null;
  };

  for (let extra = 1; extra <= afterBoundary.length; extra += 1) {
    const hit = trySource([...collected, ...afterBoundary.slice(0, extra)], 2);
    if (hit) return hit;
  }
  return trySource(trimmed, 1) ?? trySource(collected, 1);
}

// ══════════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════════

/**
 * N17 — every destination-bearing construct in the task, in textual order.
 *
 * A pure function of its single `string` argument. It cannot observe a page
 * (N5), cannot see model output (N6), and receives no task category or parsed
 * intent (N7) — there is no parameter through which any of them could arrive.
 */
export function normalizeDestinations(task: string): readonly DestinationDeclaration[] {
  if (typeof task !== 'string' || task.trim() === '') return [];

  const urlMatch = task.match(EXPLICIT_URL);
  const urlRaw = urlMatch?.[0]?.replace(URL_TRAILING_PUNCTUATION, '');
  const url = urlRaw ? normalizeUrl(urlRaw) : null;

  // A URL is its own channel: its tokens must never reach the noun slot, or
  // "open http://host:4174" would parse `4174` as a role head. EVERY URL is
  // stripped, not just the first — otherwise a second URL in the same sentence
  // leaks `4174` and `/checkout` into a noun slot and produces a spurious
  // UNSUPPORTED for a head the user never wrote.
  //
  // POST-17.10 Step 10.2 (G3). The FIRST URL is replaced by a single
  // `URL_PLACEHOLDER` token instead of whitespace, and every later URL by
  // whitespace exactly as before. That keeps the N1 single-URL channel (and its
  // pinned KNOWN_LIMITATION) intact, while making one fact readable that the
  // old blanking destroyed: WHETHER the user's URL is the direct object of a
  // destination verb (`open <url>`, `visit <url>`, `navigate to <url>`) or a
  // prepositional adjunct of a named role (`open the catalog AT <url>`).
  //
  // That distinction is the whole G3 fix, and it has to be made here, on the
  // user's own text, because it is the only place the grammar still exists.
  // Before, the URL was attached AFTER every construct had been emitted, to
  // whichever construct happened to carry a role — so "visit
  // http://host/product.html then open the catalog" and "open the catalog, then
  // visit http://host/product.html" produced BYTE-IDENTICAL declarations: the
  // user explicitly named a destination URL with their own verb, and it was
  // silently demoted to the entryUrl of a different, unrelated declaration. An
  // explicit destination URL could therefore only ever reach `destinationUrl`
  // when no role noun appeared anywhere in the task.
  const masked =
    urlMatch === null || urlMatch.index === undefined
      ? task
      : task.slice(0, urlMatch.index) +
        URL_PLACEHOLDER +
        task.slice(urlMatch.index + urlMatch[0].length).replace(EXPLICIT_URL_GLOBAL, ' ');
  const tokens = tokenize(masked);

  // True once the user's URL has been claimed as the DESTINATION of the
  // construct whose verb governs it. In that case it is never also an entry
  // URL: the two channels are mutually exclusive for one literal, by
  // construction, not by convention.
  let urlClaimedAsDestination = false;

  const out: DestinationDeclaration[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const verbLen = matchVerb(tokens, i);
    if (verbLen === 0) continue;

    // N8 — a non-authorizing construct declares nothing, but scanning
    // continues so a genuine request elsewhere in the task is unaffected.
    if (NON_AUTHORIZING_VERBS.has(tokens[i]!) || (i > 0 && NON_AUTHORIZING_PREV.has(tokens[i - 1]!))) {
      i += verbLen;
      continue;
    }

    // G3 — the URL is this construct's own complement. "open <url>" is the user
    // naming the destination itself; there is no noun slot to bind and nothing
    // to attach it to later. The declaration is emitted HERE, in textual order,
    // so `normalizeDestination` (which returns the first construct) returns the
    // construct the user wrote first.
    if (tokens[i + verbLen] === URL_PLACEHOLDER) {
      if (url !== null) {
        urlClaimedAsDestination = true;
        out.push({ kind: 'DECLARED', url });
      }
      // A non-http(s) URL falls through to the normal head resolution: the
      // placeholder is not a noun, so `resolveHead` simply finds no head and
      // the construct declares nothing. It never becomes an entry URL either.
      i += verbLen;
      continue;
    }

    const resolution = resolveHead(tokens, i + verbLen);
    if (!resolution.ok) {
      // N12 — reaching past the modifier bound fails closed; finding no head at
      // all means this construct simply has no role channel.
      if (resolution.reason === 'BOUND_EXCEEDED') {
        out.push({ kind: 'UNSUPPORTED', unmappedHead: '', provenance: 'EXPLICIT_PAGE_ROLE' });
      }
      i += verbLen - 1;
      continue;
    }

    const readings = lookupHead(resolution);
    if (!readings) {
      // N3 — an unmappable head is UNSUPPORTED, never a guess.
      out.push({
        kind: 'UNSUPPORTED',
        unmappedHead: resolution.head,
        provenance: 'EXPLICIT_PAGE_ROLE',
      });
    } else if (readings.length > 1) {
      // N9 — real ambiguity, never silently resolved.
      out.push({ kind: 'AMBIGUOUS', candidates: readings, provenance: 'EXPLICIT_PAGE_ROLE' });
    } else {
      // N10 — `UNKNOWN` can never survive into a declared set.
      const types = readings[0]!.filter((t) => t !== 'UNKNOWN');
      if (types.length === 0) {
        out.push({
          kind: 'UNSUPPORTED',
          unmappedHead: resolution.head,
          provenance: 'EXPLICIT_PAGE_ROLE',
        });
      } else {
        out.push({
          kind: 'DECLARED',
          role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: types },
        });
      }
    }

    i += verbLen + resolution.consumed - 1;
  }

  if (!urlRaw) return out;

  // G3 — the URL was already claimed as a destination by its own verb. It is
  // never ALSO attached as somebody else's entry URL.
  if (urlClaimedAsDestination) return out;

  // N18/N19 — the split is made here, from the user's own grammar, and from
  // nothing else. A role head bound from the destination verb means the user
  // named the destination in WORDS, so their URL says where to start. With no
  // role head, the URL is the only thing that could be the destination, so it
  // is the destination and is compared exactly.
  const firstRole = out.findIndex((d) => d.kind === 'DECLARED' && d.role !== undefined);

  if (firstRole >= 0) {
    const entryUrl = normalizeEntryUrl(urlRaw);
    if (entryUrl === null) return out;
    const existing = out[firstRole] as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
    out[firstRole] = { ...existing, entryUrl };
    return out;
  }

  if (url === null) return out;
  return [{ kind: 'DECLARED', url }, ...out];
}

/**
 * The primary declaration for a task: the first destination-bearing construct,
 * or `NONE`. `NONE` does not block the task (N15) — it leaves a subgoal
 * unverifiable rather than falsely satisfied.
 */
export function normalizeDestination(task: string): DestinationDeclaration {
  const all = normalizeDestinations(task);
  return all[0] ?? { kind: 'NONE' };
}
