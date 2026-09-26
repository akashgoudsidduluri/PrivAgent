/**
 * PrivAgent — Phase 15: Contextual PII Detection (the NLP adapter seam)
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * The existing local detectors are all PATTERN-based: `patterns.ts` holds
 * regexes for email, card, phone, account, PAN, OTP, CVV and address, and
 * `domDetector.ts` / `ocrDetector.ts` apply them to the DOM and to OCR output.
 *
 * Those regexes cannot find the PII that matters most in practice:
 *
 *     "Ship it to Rajesh Kumar, 14 Nehru Road, Bengaluru 560038"
 *
 * A person's name, a company in a payment context — neither is a shape. A
 * regex cannot see them; a neural model can, but a bundled NER model would add
 * tens of megabytes and seconds of latency to a Chrome MV3 extension whose
 * entire premise is a sub-50ms local decision cycle.
 *
 * ── The tradeoff, stated plainly ───────────────────────────────────────────
 *
 * This is a CONTEXTUAL HEURISTIC detector, not a neural NER model. It uses
 * label cues, capitalization shape, and the existing pattern validators. It is
 * deterministic, local, dependency-free and fast.
 *
 * The architecture is therefore built for the model to arrive later:
 *
 *     interface ContextualPiiDetector { detect(...) }
 *                   ▲
 *                   │
 *     LightweightContextualDetector  ← ships today (no model, no network)
 *
 * A real local NER model can be dropped in behind the same interface with no
 * change to fusion, redaction, the agent, or any caller. That is the point of
 * keeping the adapter this narrow.
 *
 * ── Hard privacy rules ─────────────────────────────────────────────────────
 *
 *  1. RAW TEXT NEVER LEAVES THIS MODULE. A hit carries a type, a confidence, a
 *     character SPAN and a character LENGTH. Never the matched substring. The
 *     caller already has the text it passed in; nothing new is disclosed.
 *  2. NO NETWORK. The detector is synchronous and performs no I/O of any kind.
 *     A detector that could exfiltrate text would be an exfiltration primitive
 *     hidden inside a privacy feature.
 *  3. NOT AN AUTHORITY. This is a PERCEPTION layer. It proposes findings; the
 *     existing `privacyDecision` policy, the redaction engine and the security
 *     pipeline remain authoritative. A contextual hit grants no permission,
 *     blocks nothing, and bypasses no gate.
 *  4. DETERMINISTIC. Same input, same hits, same order. No clock, no randomness.
 *
 * ── Relationship to what already exists ─────────────────────────────────────
 *
 * This ADDS a signal. It replaces nothing:
 *   - `patterns.ts` still validates every shape-based category.
 *   - `domDetector.ts` / `ocrDetector.ts` still own DOM and OCR classification.
 *   - `fusion.ts` still owns the canonical `PrivacyFinding` and all merging.
 *   - the redaction engine still owns actual redaction.
 * A contextual finding is just another candidate arriving at the same fusion.
 */

import { PATTERNS, KEYWORDS, matchesKeyword } from './patterns';
import type { SensitiveEntityType } from './types';
import type { InternalOCRResult, InternalOCRWord, OCRWordBox } from '../ocr/types';

// ── Category contract ────────────────────────────────────────────────────────

/**
 * Categories this layer can propose.
 *
 * `person_name` and `address` are existing `SensitiveEntityType` values, so a
 * contextual hit flows through the existing policy table and contracts with no
 * new plumbing. `organization` and `location` are NOT registered categories:
 * the existing `privacyDecision` policy treats an unregistered category exactly
 * like `unknown` and FAILS CLOSED on it, which is the correct default for
 * "a name we could not classify precisely".
 */
export type ContextualPrivacyCategory =
  | Extract<SensitiveEntityType, 'person_name' | 'address'>
  | 'organization'
  | 'location';

/** A single contextual finding. METADATA ONLY — never the matched text. */
export interface ContextualPiiHit {
  /** Stable, value-free id. */
  id: string;
  type: ContextualPrivacyCategory;
  /** 0..1. Conservative: a hit without a strong cue gets a low score. */
  confidence: number;
  /** Character span within the analysed text. Not the text. */
  start: number;
  end: number;
  /** Character length of the matched span — never its content. */
  length: number;
  /** Value-free evidence code, e.g. 'contextual:person_label_cue'. */
  evidence: string;
}

/** Input to a contextual detector. The text stays local and is never returned. */
export interface ContextualAnalysisInput {
  /** The text to analyse. Consumed here and never emitted. */
  text: string;
  /**
   * Ambient label/attribute context that disambiguates, e.g.
   * `['cardholder', 'name']`. Cues RAISE confidence; they never by themselves
   * create a finding.
   */
  hints?: string[];
}

/**
 * The NLP adapter seam.
 *
 * The ONLY contract a contextual detector must satisfy. A real local NER model
 * implements this and nothing downstream changes.
 *
 * Implementations MUST be local: no network, no telemetry, no model download.
 */
export interface ContextualPiiDetector {
  readonly name: string;
  /** Deterministic. Returns metadata-only hits. Never throws. */
  detect(input: ContextualAnalysisInput): ContextualPiiHit[];
}

// ── Lexical resources (closed, local, value-free) ────────────────────────────

/**
 * Closed list of tokens that look like names but never are. Without this, every
 * heading, menu item and button label becomes a "person name", which is exactly
 * the false-positive class that destroys trust in a privacy tool.
 */
const NON_NAME_TOKENS: ReadonlySet<string> = new Set([
  // Navigation / chrome
  'home', 'about', 'contact', 'search', 'login', 'logout', 'sign', 'up', 'next',
  'previous', 'back', 'menu', 'privacy', 'policy', 'terms', 'help', 'support',
  'account', 'settings', 'profile', 'dashboard', 'overview', 'summary', 'details',
  'page', 'report', 'reports', 'download', 'upload', 'read more', 'learn more',
  // Actions
  'submit', 'cancel', 'confirm', 'continue', 'view', 'edit', 'delete', 'update',
  'welcome', 'hello', 'thank', 'thanks', 'loading', 'error', 'success', 'warning',
  'add', 'apply', 'proceed', 'place', 'purchase', 'refund', 'click here',
  // Commerce UI
  'order', 'orders', 'cart', 'checkout', 'payment', 'payments', 'product',
  'products', 'item', 'items', 'total', 'subtotal', 'price', 'quantity',
  'shipping', 'delivery', 'billing', 'invoice', 'history', 'recent', 'saved',
  'wishlist', 'sale', 'offers', 'deals', 'coupon', 'status', 'pending',
  'completed', 'failed', 'transaction', 'transactions', 'balance', 'amount',
  'date', 'time',
  // More chrome / verbs
  'check', 'out', 'track', 'tracking', 'your', 'yours', 'our', 'mine', 'here',
  'there', 'yes', 'ok', 'no', 'more', 'less', 'other', 'another', 'first',
  'last', 'go', 'stop', 'start', 'end', 'begin', 'open', 'close', 'read',
  'list', 'grid', 'map', 'filter', 'sort', 'share', 'save', 'print', 'copy',
  'ship', 'in', 'out',
  // Sentence-initial function words
  'us', 'in', 'on', 'at', 'the', 'and', 'or', 'it', 'this', 'that', 'we', 'you',
  'they', 'he', 'she', 'if', 'is', 'was', 'do', 'does', 'today', 'now', 'new',
  'all', 'top', 'best',
  // Weekdays and months
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

/**
 * Person label cues. Deliberately kept as WHOLE PHRASES from the existing
 * `KEYWORDS.PERSON_NAME` table rather than split into single words: the word
 * "name" on its own appears in far too much non-PII copy, and treating it as a
 * cue turns every capitalized heading on the page into a person.
 */
const PERSON_CUES: ReadonlySet<string> = new Set(
  KEYWORDS.PERSON_NAME.map((k) => k.toLowerCase().replace(/_/g, ' '))
);

/** Label cues that make a capitalized run more likely an organization. */
const ORGANIZATION_CUES: ReadonlySet<string> = new Set([
  'employer', 'company', 'organisation', 'organization', 'beneficiary',
  'beneficiary bank', 'bank', 'issuer', 'merchant', 'payee', 'recipient',
  'vendor', 'supplier', 'account with', 'branch', 'insurer', 'provider',
]);

/** Label cues that make a capitalized token more likely a location. */
const LOCATION_CUES: ReadonlySet<string> = new Set([
  'city', 'state', 'country', 'region', 'location', 'district', 'locality',
  'zone', 'branch name', 'city name',
]);

/** Address continuations that indicate the run is an address, not a name. */
const ADDRESS_TOKENS: ReadonlySet<string> = new Set([
  'street', 'road', 'avenue', 'lane', 'drive', 'boulevard', 'nagar', 'colony',
  'sector', 'residency', 'apartment', 'flat', 'plot', 'block', 'floor',
  'marg', 'cross', 'layout',
]);

/** Every token that belongs to a LABEL rather than to a person's name. */
const LABEL_TOKENS: ReadonlySet<string> = new Set([
  ...NON_NAME_TOKENS,
  ...ADDRESS_TOKENS,
  ...PERSON_CUES,
  ...ORGANIZATION_CUES,
  ...LOCATION_CUES,
  ...KEYWORDS.ADDRESS,
].flatMap((token) => token.split(/[\s_-]+/)).filter(Boolean));

/** Tokens that mark an organization-shaped suffix rather than a name part. */
const ORG_SUFFIX_PATTERN = /\b(inc|ltd|llc|pvt|corp|corporation|company|co|plc|gmbh|limited|holdings|group)\b/i;

// ── Helpers ──────────────────────────────────────────────────────────────────

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A token is "name-shaped" if it is alphabetic, capitalized and non-trivial. */
function isNameShaped(token: string): boolean {
  const t = token.trim();
  if (t.length < 2 || t.length > 24) return false;
  if (!/^[\p{L}]+(\s[\p{L}]+)*$/u.test(t)) return false;
  if (t !== t.replace(/^./, (c) => c.toUpperCase())) return false;
  return !NON_NAME_TOKENS.has(t.toLowerCase());
}

/** True when the token is a UI word or a field label, never part of a name. */
function isLabelToken(token: string): boolean {
  return LABEL_TOKENS.has(token.toLowerCase().replace(/[.,]$/, ''));
}

/** True when any hint or nearby token matches one of the given cue sets. */
function hasCue(hints: string[], window: string, cues: ReadonlySet<string>): boolean {
  // Cues are space-normalised phrases, so `legal_name` in the keyword table and
  // `legal name` in page copy are the same cue. Attribute values arrive
  // underscore-separated, so the haystack is normalised the same way.
  const haystack = [...hints, window].join(' ').toLowerCase().replace(/_/g, ' ');
  for (const cue of cues) {
    if (haystack.includes(cue)) return true;
  }
  return false;
}

interface CapitalizedRun {
  start: number;
  end: number;
  tokens: string[];
}

/**
 * Collect every run of consecutive name-shaped tokens, with the leading label
 * tokens ("Account Holder Jane Doe" → "Jane Doe") trimmed off.
 *
 * Runs continue only across whitespace. Punctuation ends a run, so
 * "Cardholder Name: Rajesh Kumar" yields "Rajesh Kumar" on its own.
 */
function capitalizedRuns(text: string): CapitalizedRun[] {
  const runs: CapitalizedRun[] = [];
  const re = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
  let match: RegExpExecArray | null;
  let spans: Array<[number, number]> = [];

  const flush = (): void => {
    if (spans.length > 0) {
      const tokens: string[] = [];
      const kept: Array<[number, number]> = [];
      for (const [start, end] of spans) {
        const token = text.slice(start, end);
        // A run that is nothing but labels is a field caption, not a name.
        if (tokens.length === 0 && isLabelToken(token)) continue;
        tokens.push(token);
        kept.push([start, end]);
      }
      if (kept.length > 0) {
        runs.push({
          start: kept[0]![0],
          end: kept[kept.length - 1]![1],
          tokens,
        });
      }
    }
    spans = [];
  };

  while ((match = re.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    const previous = spans[spans.length - 1];
    const contiguous =
      previous !== undefined &&
      start >= previous[1] &&
      text.slice(previous[1], start).trim().length === 0;

    if (isNameShaped(token) && contiguous && spans.length < 4) {
      spans.push([start, end]);
    } else {
      flush();
      if (isNameShaped(token)) spans.push([start, end]);
    }
  }
  flush();
  return runs;
}

/** A conservative window of text around a span, used only for cue matching. */
function contextWindow(text: string, start: number, end: number, radius = 40): string {
  return text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius));
}

// ── The lightweight local detector ───────────────────────────────────────────

/**
 * Deterministic, local, model-free contextual detector.
 *
 * It proposes only what a regex structurally cannot see, and it proposes it
 * CONSERVATIVELY: an uncued capitalized run is reported at low confidence rather
 * than not at all, so the policy layer can decide, and a cued one is reported
 * higher. It never blocks and never authorizes.
 */
export class LightweightContextualDetector implements ContextualPiiDetector {
  readonly name = 'lightweight-contextual-v1';

  detect(input: ContextualAnalysisInput): ContextualPiiHit[] {
    if (!input || typeof input.text !== 'string') return [];
    const text = input.text;
    if (text.length === 0 || text.length > 20000) return [];
    const hints = Array.isArray(input.hints) ? input.hints.filter((h) => typeof h === 'string') : [];

    const hits: ContextualPiiHit[] = [];
    let seq = 0;
    const push = (
      type: ContextualPrivacyCategory,
      confidence: number,
      start: number,
      end: number,
      evidence: string
    ): void => {
      if (end <= start) return;
      hits.push({
        id: `ctx-${seq++}`,
        type,
        confidence: clampConfidence(confidence),
        start,
        end,
        length: end - start,
        evidence,
      });
    };

    // 1. Addresses. The EXISTING address regex runs first — this layer only
    //    adds spans the regex missed, and never re-reports a regex hit.
    const flags = PATTERNS.ADDRESS.flags.includes('g')
      ? PATTERNS.ADDRESS.flags
      : `${PATTERNS.ADDRESS.flags}g`;
    const addressRe = new RegExp(PATTERNS.ADDRESS.source, flags);
    let m: RegExpExecArray | null;
    while ((m = addressRe.exec(text)) !== null) {
      if (m[0].length === 0) {
        addressRe.lastIndex++;
        continue;
      }
      push('address', 0.9, m.index, m.index + m[0].length, 'contextual:address_pattern');
    }

    // 2. Capitalized runs → person / organization / location.
    for (const run of capitalizedRuns(text)) {
      if (run.tokens.length === 0) continue;
      const window = contextWindow(text, run.start, run.end);
      const runText = text.slice(run.start, run.end);

      // An address-shaped run is an address, never a name.
      if (run.tokens.some((t) => ADDRESS_TOKENS.has(t.toLowerCase().replace(/[.,]$/, '')))) {
        continue;
      }
      if (run.tokens.length >= 2 && matchesKeyword(window, KEYWORDS.ADDRESS)) {
        push('address', 0.72, run.start, run.end, 'contextual:address_label_cue');
        continue;
      }

      if (run.tokens.length >= 2 && hasCue(hints, window, ORGANIZATION_CUES)) {
        push('organization', 0.74, run.start, run.end, 'contextual:organization_cue');
        continue;
      }
      if (run.tokens.length >= 2 && hasCue(hints, window, PERSON_CUES)) {
        push('person_name', 0.8, run.start, run.end, 'contextual:person_label_cue');
        continue;
      }
      // A single capitalized token only counts as a location, only with a
      // location cue, and only when it is not itself the cue word. A bare
      // single capitalized word is far too weak to claim.
      if (
        run.tokens.length === 1 &&
        !isLabelToken(run.tokens[0]!) &&
        hasCue(hints, window, LOCATION_CUES)
      ) {
        push('location', 0.6, run.start, run.end, 'contextual:location_cue');
        continue;
      }
      // Uncategorized capitalized run: reported at deliberately LOW confidence
      // so the policy layer treats it as uncertain, and skipped entirely when it
      // is shaped like an organization's legal name.
      if (run.tokens.length >= 2 && !ORG_SUFFIX_PATTERN.test(runText)) {
        push('person_name', 0.45, run.start, run.end, 'contextual:capitalized_run_weak');
      }
    }

    // Deduplicate identical spans (the address pass and the run pass can meet).
    const seen = new Set<string>();
    return hits
      .filter((h) => {
        const key = `${h.type}:${h.start}:${h.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  }
}

/** The default detector instance. Stateless and safe to share. */
export const defaultContextualDetector: ContextualPiiDetector = new LightweightContextualDetector();

// ── DOM path ─────────────────────────────────────────────────────────────────

/**
 * Analyse a DOM text run. Returns metadata-only hits.
 *
 * The raw text is supplied by the caller (which already holds it) and is never
 * returned, logged, or stored.
 */
export function detectContextualInDomText(
  input: ContextualAnalysisInput,
  detector: ContextualPiiDetector = defaultContextualDetector
): ContextualPiiHit[] {
  return detector.detect(input);
}

/** A contextual finding anchored to an already-detected DOM element. */
export interface ContextualDomFinding {
  type: ContextualPrivacyCategory;
  confidence: number;
  /** Selector of the anchor element, so fusion merges it into THAT finding. */
  selector: string | null;
  /** The anchor's own geometry, reused verbatim — never invented. */
  bbox: [number, number, number, number] | null;
  length: number;
  evidence: string;
  /** True when the finding has neither a selector nor a region. */
  unmappable: boolean;
}

/** An existing DOM detection used as the anchor for contextual analysis. */
export interface ContextualDomAnchor {
  selector: string | null;
  /** Hints from the already-classified detection, e.g. `['credit_card']`. */
  hints?: string[];
  bbox?: [number, number, number, number] | null;
}

/** Bound the work per scan: this runs on every content-script pass. */
const MAX_DOM_CONTEXT_ANCHORS = 60;
const MAX_DOM_CONTEXT_CHARS = 400;
const MAX_DOM_CONTEXT_HITS_PER_ANCHOR = 4;

function safeQuery(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null; // a malformed selector is a no-op, never a page-breaking throw
  }
}

function boundedText(value: string | null | undefined, limit: number): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : '';
}

/**
 * Build a BOUNDED context string around an element without ever returning it.
 *
 * The text is assembled from accessibility/label attributes, any associated
 * `<label>`, and the immediate container's text — capped at
 * `MAX_DOM_CONTEXT_CHARS`. It is consumed by the detector and dropped. Sources
 * that merely repeat an earlier one are dropped too, so a label that appears in
 * both `placeholder` and the container is analysed once, not twice.
 */
function buildAnchorContextText(element: Element): string {
  const parts: string[] = [];
  const add = (raw: string | null | undefined, limit: number): void => {
    let value = boundedText(raw, limit).replace(/\s+/g, ' ').trim();
    if (!value) return;
    // A container's textContent usually REPEATS its <label> verbatim. Strip the
    // repeated label rather than dropping the whole container text, or the
    // human-readable value sitting next to that label is lost with it.
    for (const existing of parts) {
      if (existing.includes(value)) return;
      if (value.includes(existing)) {
        value = value.split(existing).join(' ').replace(/\s+/g, ' ').trim();
      }
    }
    if (value) parts.push(value);
  };

  add(element.getAttribute('aria-label'), 80);
  add(element.getAttribute('title'), 80);
  add(element.getAttribute('placeholder'), 80);

  // An associated <label for=...> is the single best label cue on real pages.
  const id = element.getAttribute('id');
  if (id) {
    const label = safeQuery(element.ownerDocument, `label[for="${id}"]`);
    if (label) add(label.textContent, 120);
  }

  // The immediate container usually holds the human-readable label for the
  // value, which is exactly what regexes cannot see.
  add(element.parentElement?.textContent, 200);

  return parts.join(' ').slice(0, MAX_DOM_CONTEXT_CHARS);
}

/**
 * Contextual detection anchored to detections the DOM engine already made.
 *
 * This deliberately does NOT crawl the page for free text. It analyses only the
 * small, already-classified neighbourhood of a confirmed sensitive field, which
 * is where "Cardholder: Jane Doe" style PII actually lives, and where a false
 * positive costs one extra signal rather than hundreds.
 *
 * Each finding inherits the ANCHOR's selector and geometry rather than
 * inventing its own, so `fusePrivacyFindings` folds it into the anchor's
 * existing finding instead of creating a duplicate region.
 */
export function detectContextualForDomDetections(
  root: ParentNode,
  anchors: ContextualDomAnchor[],
  detector: ContextualPiiDetector = defaultContextualDetector
): ContextualDomFinding[] {
  if (!root || !Array.isArray(anchors) || anchors.length === 0) return [];

  const out: ContextualDomFinding[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors.slice(0, MAX_DOM_CONTEXT_ANCHORS)) {
    if (!anchor || !anchor.selector || seen.has(anchor.selector)) continue;
    seen.add(anchor.selector);

    const element = safeQuery(root, anchor.selector);
    if (!element) continue;

    const text = buildAnchorContextText(element);
    if (text.length === 0) continue;

    let hits: ContextualPiiHit[];
    try {
      hits = detector.detect({ text, hints: anchor.hints ?? [] });
    } catch {
      continue; // a failing adapter degrades to "no contextual signal", never a crash
    }
    if (!Array.isArray(hits)) continue;

    for (const hit of hits.slice(0, MAX_DOM_CONTEXT_HITS_PER_ANCHOR)) {
      if (!hit || typeof hit.length !== 'number') continue;
      out.push({
        type: hit.type,
        confidence: clampConfidence(hit.confidence),
        selector: anchor.selector,
        bbox: anchor.bbox ?? null,
        length: hit.length,
        evidence: hit.evidence,
        unmappable: !anchor.selector && !anchor.bbox,
      });
    }
  }

  return out;
}

// ── OCR path ─────────────────────────────────────────────────────────────────

/**
 * Map a contextual hit back onto the bounding boxes of the OCR words it covers.
 *
 * OCR words are re-joined with single spaces so offsets are reconstructible
 * exactly, then every word overlapping the hit's span contributes its box, and
 * the union is returned.
 *
 * FAILS CLOSED: returns null when no word overlaps the span, or when any
 * contributing word has an unusable box. A null here means "this sensitive
 * finding cannot be safely mapped to a region", which the fusion layer escalates
 * rather than silently dropping or silently trusting.
 */
export function mapContextualHitToOcrRegion(
  hit: ContextualPiiHit,
  words: InternalOCRWord[]
): [number, number, number, number] | null {
  if (!hit || !Array.isArray(words) || words.length === 0) return null;

  let offset = 0;
  const boxes: OCRWordBox[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (typeof w.text !== 'string') return null;
    const start = offset;
    const end = start + w.text.length;

    const overlaps = start < hit.end && end > hit.start;
    if (overlaps) {
      const b = w.bbox;
      if (
        !b ||
        !Number.isFinite(b.x0) || !Number.isFinite(b.y0) ||
        !Number.isFinite(b.x1) || !Number.isFinite(b.y1) ||
        b.x1 <= b.x0 || b.y1 <= b.y0
      ) {
        // An unusable box on an overlapping word makes the mapping untrustworthy.
        return null;
      }
      boxes.push(b);
    }

    // The line text the detector analysed is the words joined by ONE space, so
    // the next word starts one character after this one ends.
    offset = end + 1;
  }

  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x0));
  const y0 = Math.min(...boxes.map((b) => b.y0));
  const x1 = Math.max(...boxes.map((b) => b.x1));
  const y1 = Math.max(...boxes.map((b) => b.y1));
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

/** A contextual OCR finding. Metadata only — no raw text. */
export interface ContextualOcrFinding {
  type: ContextualPrivacyCategory;
  confidence: number;
  bbox: [number, number, number, number] | null;
  length: number;
  evidence: string;
  /** True when the hit was detected but could NOT be mapped to a region. */
  unmappable: boolean;
}

/**
 * Run contextual detection over OCR output, locally.
 *
 * This is called INSIDE the local OCR classification stage, while raw text is
 * still in scope and before it is discarded — the only place it is legitimate to
 * read OCR text at all. Nothing returned here contains text.
 *
 * A hit that cannot be mapped to a region is returned with `unmappable: true`
 * and a null bbox rather than being dropped, so the caller can fail closed on
 * it instead of silently under-reporting.
 */
export function detectContextualInOcr(
  ocrResult: InternalOCRResult,
  detector: ContextualPiiDetector = defaultContextualDetector,
  imageDimensions?: { width: number; height: number }
): ContextualOcrFinding[] {
  if (!ocrResult || !Array.isArray(ocrResult.lines)) return [];
  const out: ContextualOcrFinding[] = [];

  for (const line of ocrResult.lines) {
    if (!line || typeof line.text !== 'string' || !Array.isArray(line.words)) continue;
    const hits = detector.detect({ text: line.text, hints: [] });
    if (!Array.isArray(hits)) continue;
    for (const hit of hits) {
      let bbox = mapContextualHitToOcrRegion(hit, line.words);
      // Clamp into the captured bitmap when its size is known. A hit that
      // cannot be clamped is unmappable rather than silently kept.
      if (bbox && imageDimensions) {
        const w = imageDimensions.width;
        const h = imageDimensions.height;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          bbox = null;
        } else {
          const x = Math.max(0, Math.min(w, bbox[0]));
          const y = Math.max(0, Math.min(h, bbox[1]));
          const x1 = Math.max(0, Math.min(w, bbox[0] + bbox[2]));
          const y1 = Math.max(0, Math.min(h, bbox[1] + bbox[3]));
          bbox = x1 > x && y1 > y ? [x, y, x1 - x, y1 - y] : null;
        }
      }
      out.push({
        type: hit.type,
        confidence: hit.confidence,
        bbox,
        length: hit.length,
        evidence: hit.evidence,
        unmappable: bbox === null,
      });
    }
  }
  return out;
}
