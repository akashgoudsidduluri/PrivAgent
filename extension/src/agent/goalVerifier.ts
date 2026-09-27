/**
 * PrivAgent — Deterministic Goal & Candidate Verification Engine (Phases 3 & 8)
 *
 * Authoritatively verifies whether a task goal has actually been achieved based on
 * observable browser state and fresh perception metadata.
 *
 * Security Invariants:
 *  - Deterministic and local; the remote LLM NEVER declares its own success.
 *  - Candidates carry strictly non-sensitive product metadata (no raw PII, credentials, or card details).
 *  - Unknown constraint attributes do NOT count as a match: UNKNOWN !== MATCH.
 *
 * PHASE 17.2A — GOAL EVIDENCE FABRICATION REMEDIATION.
 *
 *     ACTION REQUEST   != OBSERVED RESULT
 *     DISPATCH SUCCESS != GOAL SUCCESS
 *
 * Only AUTHORITATIVE OBSERVATION may establish SUCCESS. These are NOT evidence
 * and are no longer read by any success path below:
 *   state.previousActions        - what the agent ATTEMPTED
 *   state.steps[].executionSuccess - that dispatch returned without error
 *   state.steps[].navigationDestination - the URL the model REQUESTED
 *   state.visitedElementIds      - populated from action.target, a REQUEST
 * They describe transport/execution state, not the browser.
 * Goal verification remains a VERIFIER: it authorizes nothing.
 */

import { AgentContextPayload, AgentDetection } from '../privacy/types';
import { AgentTaskState, CandidateProductItem, StructuredConstraints, TaskStatus } from './agentState';
import { isSameDocumentIdentity, MAX_OCR_OBSERVATION_AGE_MS, OCRObservation } from '../ocr/ocrObservationContract';

export interface GoalVerificationResult {
  satisfied: boolean;
  status: TaskStatus;
  reason?: string;
  verifiedCandidates?: CandidateProductItem[];
}

/**
 * Checks if a candidate product satisfies all extracted task constraints.
 * Strict rule: Unknown information cannot be assumed to match.
 */
export function verifyCandidateAgainstConstraints(
  candidate: {
    title?: string;
    price?: number;
    size?: string;
    color?: string;
    category?: string;
  },
  constraints: StructuredConstraints
): { matches: boolean; notes: string } {
  const failures: string[] = [];

  // 1. Max price check
  if (constraints.maxPrice !== undefined) {
    if (candidate.price === undefined || isNaN(candidate.price)) {
      failures.push('Price unknown');
    } else if (candidate.price > constraints.maxPrice) {
      failures.push(`Price ${candidate.price} exceeds max ${constraints.maxPrice}`);
    }
  }

  // 2. Size check
  if (constraints.size) {
    const expectedSize = constraints.size.toUpperCase();
    const actualSize = (candidate.size || '').toUpperCase();
    const title = (candidate.title || '').toUpperCase();

    if (actualSize === expectedSize || title.includes(` ${expectedSize} `) || title.includes(`${expectedSize}-`) || title.startsWith(`${expectedSize} `)) {
      // Matches size
    } else {
      failures.push(`Size '${candidate.size || 'unknown'}' does not match '${constraints.size}'`);
    }
  }

  // 3. Color check
  if (constraints.color) {
    const expectedColor = constraints.color.toLowerCase();
    const actualColor = (candidate.color || '').toLowerCase();
    const title = (candidate.title || '').toLowerCase();

    if (actualColor.includes(expectedColor) || title.includes(expectedColor)) {
      // Matches color
    } else {
      failures.push(`Color '${candidate.color || 'unknown'}' does not match '${constraints.color}'`);
    }
  }

  // 4. Style check
  if (constraints.style) {
    const expectedStyle = constraints.style.toLowerCase();
    const title = (candidate.title || '').toLowerCase();
    if (!title.includes(expectedStyle)) {
      failures.push(`Style '${constraints.style}' not found in title`);
    }
  }

  // 5. Category check
  if (constraints.category) {
    const expectedCat = constraints.category.toLowerCase();
    const title = (candidate.title || '').toLowerCase();
    if (!title.includes(expectedCat)) {
      failures.push(`Category '${constraints.category}' not found in title`);
    }
  }

  if (failures.length === 0) {
    return {
      matches: true,
      notes: 'All constraints verified successfully on observable item data.',
    };
  }

  return {
    matches: false,
    notes: failures.join('; '),
  };
}

/**
 * Extracts candidate products from sanitized context detections.
 * Inspects element selectors, IDs, and structural clues without accessing raw PII.
 */
export function extractCandidatesFromContext(
  context: AgentContextPayload,
  constraints: StructuredConstraints
): CandidateProductItem[] {
  const candidates: CandidateProductItem[] = [];
  if (!context || !context.detections) return candidates;

  for (const det of context.detections) {
    const selector = (det.selector || '').toLowerCase();
    const id = (det.id || '').toLowerCase();

    // Check if this detection represents a product item / result card
    const isProductElement =
      selector.includes('product') ||
      selector.includes('item') ||
      selector.includes('card') ||
      selector.includes('result') ||
      id.includes('product') ||
      id.includes('item');

    if (isProductElement) {
      // Parse metadata tokens from selector/id
      // e.g. "#product-xxl-black-baggy-bag-899", "[data-price='899']"
      let price: number | undefined;
      const priceMatch = selector.match(/(?:price|rs|inr|-)?(\d{2,5})(?:px)?/);
      if (priceMatch && priceMatch[1] && !priceMatch[0].includes('px')) {
        price = parseFloat(priceMatch[1]);
      }

      let size: string | undefined;
      const sizeMatch = selector.match(/-(xxxl|xxl|xl|xs|[sml])\b/i);
      if (sizeMatch && sizeMatch[1]) {
        size = sizeMatch[1].toUpperCase();
      }

      let color: string | undefined;
      const colorMatch = selector.match(/\b(black|white|red|blue|green|yellow)\b/i);
      if (colorMatch && colorMatch[1]) {
        color = colorMatch[1].toLowerCase();
      }

      const title = selector
        .replace(/^[#.[]+/, '')
        .replace(/[[\]'"]/g, ' ')
        .replace(/[-_]/g, ' ')
        .trim();

      const verification = verifyCandidateAgainstConstraints(
        { title, price, size, color },
        constraints
      );

      candidates.push({
        id: det.id,
        title: title || 'Detected Product Item',
        price: price ?? 0,
        currency: constraints.currency || '₹',
        size,
        color,
        targetId: det.id,
        matchesConstraints: verification.matches,
        constraintNotes: verification.notes,
        confidence: det.confidence,
      });
    }
  }

  return candidates;
}

/** Words that carry no identifying meaning in a research item. */
const RESEARCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'all', 'their', 'its', 'his', 'her',
  'who', 'what', 'which', 'name', 'names', 'list',
]);

/**
 * Detects a multi-page research goal and returns the discrete items the user's
 * OWN goal text asks for, or null when the goal is not of that shape.
 *
 * Deterministic string analysis of the user-typed task only. Two conditions must
 * both hold, so ordinary navigation/search/shopping goals are untouched:
 *   1. the goal asks for MULTIPLE items ("find the director, producers and ...")
 *   2. the goal expects MULTIPLE pages / a synthesis of what was inspected.
 */
function extractResearchItems(task: string): string[] | null {
  const lower = task.toLowerCase();
  // Exclude goals owned by the stronger, earlier rules. `product` is matched on
  // a word boundary deliberately: substring matching would claim "production
  // team" as a shopping goal and send a research task down the shopping branch.
  if (
    /\b(search|log ?in|sign ?in|add to cart|checkout|buy|purchase|book|product|shop|bag)\b/.test(lower)
  ) {
    return null;
  }
  if (!/\b(research|investigate|find|identify|compile|gather)\b/.test(lower)) return null;
  if (!/\b(multiple|several|each|different)\b[^.]*\b(pages?|sources?|articles?|links?)\b|\b(summar|overviews?|breakdown|report)\b/.test(lower)) {
    return null;
  }

  // "find the A, B, and C" / "identify the X and Y". A goal may contain more
  // than one research clause ("Research the production team of Avengers:
  // Endgame. Find the director, producers, screenwriters and cinematographer."),
  // so evaluate every clause and keep the one that is a genuine enumeration.
  const clausePattern =
    /\b(?:find|identify|compile|gather|research)\s+(?:the\s+|all\s+the\s+)?([^.]*?)(?:\.\s|\.$|,\s*(?:and\s+)?(?:return|provide|inspect|review)\b|$)/g;

  let best: string[] = [];
  for (const match of lower.matchAll(clausePattern)) {
    const clause = match[1];
    if (!clause) continue;
    const parts = clause
      .split(/,|\band\b|\bor\b|&/)
      .map((p) => p.replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((p) => {
        const words = p.split(' ').filter((w) => w && !RESEARCH_STOPWORDS.has(w));
        return words.length > 0 && words.length <= 3;
      });
    const unique = Array.from(new Set(parts));
    if (unique.length > best.length) best = unique;
  }

  return best.length >= 2 ? best : null;
}

/**
 * True when an OBSERVED page URL genuinely corresponds to a requested research
 * item. Matching is on the item's meaningful words appearing in the URL path or
 * query — structural evidence from the browser, never a model claim.
 */
function urlMentionsResearchItem(observedUrl: string, item: string): boolean {
  const words = item.split(' ').filter((w) => w && !RESEARCH_STOPWORDS.has(w));
  if (words.length === 0) return false;
  let path = observedUrl;
  try {
    const u = new URL(observedUrl);
    path = `${u.pathname} ${u.search}`;
  } catch {
    path = observedUrl;
  }
  const haystack = path.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const singular = (w: string) => (w.endsWith('s') && w.length > 3 ? w.slice(0, -1) : w);
  // Empty tokens are dropped: without that, the empty string is a prefix of
  // every word and every item would trivially "match" any page.
  const tokens = haystack.split(' ').filter(Boolean);
  return words.every((w) =>
    tokens.some(
      (t) =>
        t === w ||
        singular(t) === singular(w) ||
        (t.length >= 4 && w.length >= 4 && (t.startsWith(w) || w.startsWith(t)))
    )
  );
}

/**
 * What a scroll goal actually claims, parsed from the user's own words.
 *
 * The goal is NOT taken from any action. A proposal is a request; only
 * observed browser state can satisfy a goal.
 */
interface ScrollGoalClaim {
  kind: 'distance' | 'target' | 'boundary' | 'direction';
  direction: 'down' | 'up';
  amountPx: number | null;
  /** Meaningful words naming a section, e.g. ['pricing', 'section']. */
  targetTerms: string[];
}

/** Words that carry no meaning when matching a scroll target. */
const SCROLL_STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'down', 'up', 'scroll', 'page', 'section', 'area',
  'part', 'bottom', 'top', 'end', 'into', 'on', 'at', 'of', 'and', 'then',
  'please', 'go', 'bring', 'show', 'find', 'until', 'toward', 'towards',
]);

/**
 * Parses a scroll goal out of the task text.
 *
 * Handles the three shapes that can be decided from observed state:
 *   "scroll down 500px"        → distance
 *   "scroll to the pricing section" → target
 *   "scroll down"              → direction
 *
 * "scroll to the bottom" is recognised as a boundary claim, which cannot be
 * decided without a document height the sanitized context does not carry, so
 * it fails closed rather than guessing.
 */
export function parseScrollGoal(lowerTask: string): ScrollGoalClaim | null {
  const m = lowerTask.match(/\bscroll\b/);
  if (!m) return null;

  const after = lowerTask.slice(m.index! + m[0].length);
  const direction: 'down' | 'up' = /\bup\b/.test(after) ? 'up' : 'down';

  // "scroll to the bottom" / "to the end" — a boundary claim.
  if (/\bto\s+the\s+(bottom|end|very\s+bottom)\b/.test(after)) {
    return { kind: 'boundary', direction, amountPx: null, targetTerms: [] };
  }

  // "scroll down 500px" / "scroll by 500 pixels" — an absolute distance.
  const amount = after.match(/(\d{1,6})\s*(?:px|pixels?|px\b)/) || after.match(/\bby\s+(\d{1,6})\b/);
  if (amount) {
    return { kind: 'distance', direction, amountPx: parseInt(amount[1] ?? '0', 10), targetTerms: [] };
  }

  // "scroll to the pricing section" — a named target.
  const toTarget = after.match(/\bto\s+(?:the\s+)?([a-z0-9'\- ]{2,60})/);
  if (toTarget) {
    const terms = (toTarget[1] ?? '')
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9'\-]/g, ''))
      .filter((t) => t.length > 1 && !SCROLL_STOPWORDS.has(t));
    if (terms.length > 0) {
      return { kind: 'target', direction, amountPx: null, targetTerms: terms };
    }
  }

  // A bare direction with no measurable claim.
  return { kind: 'direction', direction, amountPx: null, targetTerms: [] };
}

/**
 * True when a detection's document-absolute box is inside the CURRENT
 * observed viewport. Detection bboxes are document-absolute
 * (`rect.top + window.scrollY`) and the viewport comes from the same live
 * perception cycle, so this compares two real observations.
 *
 * A partly-visible element counts: the goal is "reach the section", not
 * "centre it perfectly".
 */
function isDetectionInViewport(
  det: AgentDetection,
  scrollY: number,
  viewportHeight: number
): boolean {
  const bbox = det.bbox;
  if (!bbox || typeof bbox.y !== 'number' || typeof bbox.height !== 'number') return false;
  const top = bbox.y;
  const bottom = bbox.y + bbox.height;
  const viewTop = scrollY;
  const viewBottom = scrollY + viewportHeight;
  return top < viewBottom && bottom > viewTop;
}

/** Machine-generated surface of a detection, used only to match the user's words. */
function detectionSurface(det: AgentDetection): string {
  return `${det.id ?? ''} ${det.selector ?? ''} ${det.label ?? ''} ${det.type ?? ''}`.toLowerCase();
}

/**
 * Decides a scroll goal from OBSERVED browser state only.
 *
 * Explicitly does NOT consult `previousActions`, a proposed action, or a
 * requested scroll amount for proof. If the observed state cannot establish
 * the claim, this returns IN_PROGRESS and fails closed.
 */
function verifyScrollGoal(
  lowerTask: string,
  state: AgentTaskState,
  context: AgentContextPayload
): GoalVerificationResult {
  const claim = parseScrollGoal(lowerTask);
  if (!claim) return { satisfied: false, status: 'IN_PROGRESS' };

  const viewport = context.viewport;
  const scrollY = state.observedScrollY ?? (typeof viewport?.scroll_y === 'number' ? viewport.scroll_y : null);
  const baseline = state.initialScrollY ?? null;
  const viewportHeight = typeof viewport?.height === 'number' ? viewport.height : null;

  //
  // PHASE 17.1 (C6). A perception with no geometry source reports an all-zero
  // viewport, which is the ABSENCE of a reading, not a measurement of zero.
  // Deciding a scroll goal against it would be deciding against a default.
  // 17.1 adds no goal types; it only refuses to decide without an observation.
  //
  if (context.viewportObservable === false) {
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── Observable state must actually exist ────────────────────────────────
  if (scrollY === null || viewportHeight === null) {
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  if (claim.kind === 'boundary') {
    // Document height is not carried in the sanitized context, so "reached the
    // bottom" cannot be established. Fail closed rather than assume it.
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  if (claim.kind === 'distance') {
    // Requires an observed baseline from the start of THIS task. Without one
    // we cannot say how far the page actually moved.
    if (baseline === null) return { satisfied: false, status: 'IN_PROGRESS' };
    const moved = claim.direction === 'down' ? scrollY - baseline : baseline - scrollY;
    const want = claim.amountPx ?? 0;
    if (moved >= want) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: `Scroll goal verified from observed viewport position: observed ${moved}px of ${claim.direction} travel from a baseline of ${baseline}px to ${scrollY}px.`,
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  if (claim.kind === 'direction') {
    if (baseline === null) return { satisfied: false, status: 'IN_PROGRESS' };
    const moved = claim.direction === 'down' ? scrollY - baseline : baseline - scrollY;
    if (moved > 0) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: `Scroll goal verified from observed viewport position: ${scrollY - baseline}px of ${claim.direction} travel observed (${baseline}px → ${scrollY}px).`,
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // claim.kind === 'target'
  // The named section must be OBSERVED in the current viewport. If no
  // detection matches the user's words, or none is in view, fail closed.
  const matches = (context.detections ?? []).filter((d) => {
    const surface = detectionSurface(d);
    return claim.targetTerms.every((t) => surface.includes(t));
  });
  if (matches.length === 0) return { satisfied: false, status: 'IN_PROGRESS' };
  const inView = matches.find((d) => isDetectionInViewport(d, scrollY, viewportHeight));
  if (inView) {
    return {
      satisfied: true,
      status: 'SUCCESS',
      reason: `Scroll goal verified from observed state: target '${claim.targetTerms.join(' ')}' is inside the observed viewport at ${scrollY}px.`,
    };
  }
  return { satisfied: false, status: 'IN_PROGRESS' };
}

/**
 * Main goal verification function. Evaluates current observable browser state
 * and decides whether the goal is genuinely achieved.
 */
export function verifyTaskGoal(
  task: string,
  state: AgentTaskState,
  context: AgentContextPayload
): GoalVerificationResult {
  const lower = task.toLowerCase();
  const currentUrl = context.url || state.currentUrl || '';

  // ── 1. Generic Web Search Goal Verification (any search engine) ─────────────
  // PrivAgent is a GENERAL-PURPOSE browser agent, so search goals are not
  // Google-specific. Success requires an OBSERVED query in the live URL
  // (or an already-observed query on a results page). A typed-but-unsubmitted
  // query is never treated as success.
  const searchIntent = lower.match(/\bsearch(?:e[ds]?|ing)?\s+(?:for\s+)?["']?([a-z0-9\s-]{2,60}?)["']?(?:\s+on\s+|\s+in\s+|\s+using\s+)?(?:[.?]|$)/);
  if (searchIntent) {
    const intent = (searchIntent[1] || '').trim().toLowerCase();

    // Observed in the live URL query string of a search results page
    try {
      const u = new URL(currentUrl);
      const q = (u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('search') || '').trim();
      if (q.length > 0 && u.pathname.toLowerCase() !== '/' && (intent.length === 0 || q.toLowerCase().includes(intent) || intent.includes(q.toLowerCase()))) {
        return {
          satisfied: true,
          status: 'SUCCESS',
          reason: `Search goal verified against observed results URL: query '${q}' present at '${u.hostname}'.`,
        };
      }
    } catch {
      // Non-parsable URL: fall through to the action-history check below.
    }

    // Otherwise the goal is NOT satisfied. A prior type action alone is
    // insufficient — the query must be observed in the browser state.
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 1b. Google Search Goal Verification ────────────────────────────────────
  if (
    (lower.includes('search for') || lower.includes('search google')) &&
    /(\.google\.)|(\/\/google\.)/i.test(currentUrl)
  ) {
    try {
      const u = new URL(currentUrl);
      if (u.searchParams.has('q') && u.searchParams.get('q')!.length > 0) {
        return {
          satisfied: true,
          status: 'SUCCESS',
          reason: `Google search query verified in results URL: '${u.searchParams.get('q')}'.`,
        };
      }
    } catch {
      // URL parsing fallback
    }

    // PHASE 17.2A. A dispatched `type` + `click`/`navigate` is TRANSPORT
    // state: it says the agent ASKED, not that a result page exists. Removed.
    // The observed `q=` above is the only thing that can establish a search.
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 2. Login Workflow Verification ─────────────────────────────────────────
  if (lower.includes('login') && !lower.includes('search')) {
    // Verified when URL transitions away from login page to dashboard/portal/home
    const wasOnLoginPage = state.steps.some((s) => s.url.includes('login'));
    const isNowAwayFromLogin = !currentUrl.includes('login') && currentUrl.length > 0;
    //
    // PHASE 17.2A. `hasTyped`/`hasClickedSubmit` were ACTION-HISTORY evidence:
    // typing a credential and clicking submit says the agent ATTEMPTED a login.
    // The observed URL transition is the proof; the attempts are not. Removing
    // them is correct AND strictly less brittle - a login whose actions were
    // not recorded still verifies on its observed outcome.
    if (wasOnLoginPage && isNowAwayFromLogin) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: `Login successful: authenticated state observed at '${currentUrl}'.`,
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 2b. Multi-page research goals (Phase 9) ────────────────────────────────
  // A long-horizon research goal ("find the A, B and C, inspect multiple pages,
  // return a summary") has no single observable end-state, so it would otherwise
  // never terminate: the agent keeps working and the task fails closed on its
  // step bound. The rule below is DETERMINISTIC and derives success ONLY from
  // observed evidence already in local state:
  //   * the items the USER'S OWN goal text asks for, and
  //   * pages the agent actually reached in successfully executed steps.
  // The reasoner and the remote model cannot influence it: nothing here reads a
  // model-supplied claim, and a missing observation is never treated as a match
  // (UNKNOWN !== MATCH), so it fails closed by staying IN_PROGRESS.
  //
  // It is evaluated BEFORE the shopping rule because that rule's substring test
  // for 'product' would otherwise claim a "production team" goal as shopping.
  const researchItems = extractResearchItems(task);
  if (researchItems) {
    // Every page the agent genuinely observed during this task.
    const observedUrls = new Set<string>();
    if (currentUrl) observedUrls.add(currentUrl);
    for (const step of state.steps) {
      // PHASE 17.2A. `executionSuccess` is DISPATCH state, and
      // `navigationDestination` is the URL the model REQUESTED (set from
      // `action.url`). A navigation dispatched, returned without error, and
      // never committed could still contribute its REQUESTED url and certify a
      // research goal from a page the browser was never on. `step.url` alone
      // is the observed tab URL as of that step.
      if (step.url) observedUrls.add(step.url);
    }

    const observedLower = Array.from(observedUrls).map((u) => u.toLowerCase());
    const unmatched = researchItems.filter(
      (item) => !observedLower.some((u) => urlMentionsResearchItem(u, item))
    );

    if (unmatched.length === 0 && observedLower.length >= Math.min(2, researchItems.length)) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason:
          `Research goal verified from observed browser state: all ${researchItems.length} requested ` +
          `item(s) were reached across ${observedLower.length} distinct page(s).`,
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 3. Shopping / Product Search & Constraint Verification ─────────────────
  const isShoppingTask =
    state.taskConstraints?.maxPrice !== undefined ||
    state.taskConstraints?.size !== undefined ||
    state.taskConstraints?.color !== undefined ||
    lower.includes('shopping') ||
    lower.includes('bag') ||
    lower.includes('product');

  if (isShoppingTask) {
    // Extract candidates from current perception
    const candidates = extractCandidatesFromContext(context, state.taskConstraints || {});
    if (candidates.length > 0) {
      state.candidateItems = candidates;
    }

    const qualifying = (state.candidateItems || []).filter((c) => c.matchesConstraints);

    // Goal is satisfied when:
    // 1. Result/product page reached (e.g. url contains results/product/cart/search)
    // 2. At least one qualifying candidate is verified against all constraints
    const isResultsOrProductPage =
      currentUrl.includes('results') ||
      currentUrl.includes('product') ||
      currentUrl.includes('search') ||
      state.pageType === 'results' ||
      state.pageType === 'product_detail';

    if (qualifying.length > 0 && isResultsOrProductPage) {
      const best = qualifying[0];
      if (best) {
        return {
          satisfied: true,
          status: 'SUCCESS',
          reason: `Verified qualifying product candidate '${best.title}' matching constraints (${best.constraintNotes}).`,
          verifiedCandidates: qualifying,
        };
      }
    }

    // Check if on product detail view of qualifying item
    // PHASE 17.2A. The `previousActions` click conjunct is removed: a dispatched
    // click is not evidence a product page opened. What is required is the
    // observed detail URL together with a qualifying candidate OBSERVED in the
    // current perception (rebuilt from `context.detections` above, never from
    // history).
    if (currentUrl.includes('product') && qualifying.length > 0) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Observed product detail page with a qualifying item in the current perception.',
        verifiedCandidates: qualifying,
      };
    }

    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 4. Multi-step Banking / Transaction Tasks ───────────────────────────────
  if (
    (lower.includes('account details') || lower.includes('details')) &&
    (lower.includes('transaction') || lower.includes('transactions'))
  ) {
    //
    // PHASE 17.2A. This branch previously returned SUCCESS with NO OBSERVATION
    // WHATSOEVER: three dispatched actions including a click and a scroll were
    // reported as a verification of transaction history, with a reason string
    // describing evidence that did not exist.
    //
    // The replacement is the OBSERVED transaction surface: a detection naming a
    // ledger/statement, read from the CURRENT perception. Note it is weaker
    // than proving rows are loaded - the sanitized context carries no row
    // content. Phase 17.2 proper adds the text/content goal type for that; what
    // matters here is that the evidence is observational, not a dispatch record.
    const observedLedger = (context.detections ?? []).some((d) => {
      const surface = `${d.id ?? ''} ${d.selector ?? ''} ${d.label ?? ''} ${d.type ?? ''}`.toLowerCase();
      return surface.includes('transaction') || surface.includes('ledger') || surface.includes('statement');
    });
    if (observedLedger) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Transaction history surface observed in the current perception.',
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 5. Single-step demo tasks ──────────────────────────────────────────────
  if (lower.includes('account number') || lower.includes('account_number')) {
    //
    // PHASE 17.2A. Both previous conjuncts were REQUEST/EXECUTION evidence:
    // `executionSuccess && click` is dispatch state, and `visitedElementIds`
    // is populated from `action.target`, recording what the agent ASKED to
    // click rather than what the browser showed.
    //
    // The goal text is "find and CLICK the account number field", so the
    // authoritative evidence is the FIELD BEING OPENED. A detection on its own
    // proves only that the field EXISTS, which is true before the agent has
    // done anything - treating that as completion would let the goal verify
    // before the first action was even requested, short-circuiting the loop.
    //
    // The sanitized context has no focus/opened signal today (`AgentDetection`
    // carries no such field), so there is currently NO authoritative
    // observation that can establish this goal. It therefore fails closed.
    // Phase 17.2 proper adds the DOM/text goal type that can read whether the
    // field is actually open; inventing a focus flag here would fabricate the
    // evidence this remediation exists to remove.
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  if (lower.includes('scroll')) {
    return verifyScrollGoal(lower, state, context);
  }

  if (lower.includes('account details') || lower.includes('details')) {
    //
    // PHASE 17.2A. This was a pure click counter: any dispatched click reported
    // "Account details view opened." with nothing observed about the view.
    //
    // `state.pageType === 'banking'` is deliberately NOT accepted: that
    // classifies the SITE, not the VIEW, so being anywhere on a banking portal
    // would claim the details pane is open. Page classification is an inference
    // about a page's purpose, not an observation that a view is displayed. The
    // observed URL must name the details surface.
    const observedUrl = currentUrl.toLowerCase();
    if (observedUrl.includes('detail') || observedUrl.includes('transaction')) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Account details surface observed in the current browser state.',
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 6. Visual / Non-DOM OCR Perception Goals (Phase 17.3) ───────────────────
  // Evaluates tasks requiring perception of text, headings, or sensitive fields
  // rendered inside canvas, images, or non-DOM visual regions.
  //
  // Strict Invariant (Phase 17.3 Review):
  //  1. OCR presence ALONE never implies success.
  //  2. OCR evidence must carry verified provenance: state === 'OBSERVED',
  //     matching target tab, matching authoritative document identity, and
  //     fresh within MAX_OCR_OBSERVATION_AGE_MS.
  //  3. An explicit goal target condition must be matched against observed
  //     detections (never assumed from action requests or previous actions).
  const isVisualOcrTask =
    lower.includes('canvas') ||
    lower.includes('image') ||
    lower.includes('visually') ||
    lower.includes('visual element') ||
    lower.includes('rendered text');

  if (isVisualOcrTask) {
    // Provenance & Freshness Gate: OCR must be OBSERVED and verified fresh
    const ocrObs = (context as any).ocr_observation as OCRObservation | undefined;
    if (!ocrObs || ocrObs.state !== 'OBSERVED' || !ocrObs.provenance) {
      return { satisfied: false, status: 'IN_PROGRESS' };
    }

    const prov = ocrObs.provenance;
    if (state.targetTabId && prov.tabId !== state.targetTabId) {
      return { satisfied: false, status: 'IN_PROGRESS' };
    }
    if (!isSameDocumentIdentity(prov.documentUrl, currentUrl)) {
      return { satisfied: false, status: 'IN_PROGRESS' };
    }
    if (Date.now() - prov.capturedAt > MAX_OCR_OBSERVATION_AGE_MS) {
      return { satisfied: false, status: 'IN_PROGRESS' };
    }

    // A. Sensitive entity search in visual element (e.g. phone number or email)
    if (lower.includes('phone') || lower.includes('mobile')) {
      const match = context.detections.find((d) => d.type === 'phone' && d.source === 'ocr');
      if (match) {
        return {
          satisfied: true,
          status: 'SUCCESS',
          reason: `Visual OCR goal verified: sensitive phone entity identified in visual region without raw value exposure (ID: ${match.id}).`,
        };
      }
    }

    if (lower.includes('email')) {
      const match = context.detections.find((d) => d.type === 'email' && d.source === 'ocr');
      if (match) {
        return {
          satisfied: true,
          status: 'SUCCESS',
          reason: `Visual OCR goal verified: sensitive email entity identified in visual region without raw value exposure (ID: ${match.id}).`,
        };
      }
    }

    // B. Heading / title inside visual element
    if (lower.includes('heading') || lower.includes('title')) {
      const match = context.detections.find((d) => (d.type === 'heading' || d.label) && d.source === 'ocr');
      if (match && match.label) {
        const quoted = task.match(/["']([^"']+)["']/);
        if (!quoted || match.label.toLowerCase().includes(quoted[1]!.toLowerCase())) {
          return {
            satisfied: true,
            status: 'SUCCESS',
            reason: `Visual OCR goal verified: visible heading '${match.label}' identified inside visual element.`,
          };
        }
      }
    }

    // C. Explicit targeted text inside canvas / image
    // Invariant: Mere presence of OCR regions does NOT satisfy the goal.
    // The specific required target text must match observed OCR labels.
    const quoted = task.match(/["']([^"']+)["']/);
    if (quoted) {
      const term = quoted[1]!.toLowerCase();
      const match = context.detections.find(
        (d) => d.source === 'ocr' && d.label && d.label.toLowerCase().includes(term)
      );
      if (match) {
        return {
          satisfied: true,
          status: 'SUCCESS',
          reason: `Visual OCR goal verified: text matching '${quoted[1]}' perceived inside visual element ('${match.label}').`,
        };
      }
    }

    // Specific non-DOM canvas statement / overview check
    if (lower.includes('canvas statement') || lower.includes('financial statement') || (lower.includes('statement') && lower.includes('canvas'))) {
      const match = context.detections.find(
        (d) => d.source === 'ocr' && d.label && /statement/i.test(d.label)
      );
      if (match) {
        return {
          satisfied: true,
          status: 'SUCCESS',
          reason: `Visual OCR goal verified: observed statement inside visual element ('${match.label}').`,
        };
      }
    }
  }

  return { satisfied: false, status: 'IN_PROGRESS' };
}
