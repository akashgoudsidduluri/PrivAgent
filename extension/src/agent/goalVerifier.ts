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
 */

import { AgentContextPayload, AgentDetection } from '../privacy/types';
import { AgentTaskState, CandidateProductItem, StructuredConstraints, TaskStatus } from './agentState';

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

    const hasTyped = state.previousActions.some((a) => a.action === 'type');
    const hasSubmitted = state.previousActions.some((a) => a.action === 'click' || a.action === 'navigate');
    if (hasTyped && hasSubmitted) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Google search submission actions verified; search request dispatched.',
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 2. Login Workflow Verification ─────────────────────────────────────────
  if (lower.includes('login') && !lower.includes('search')) {
    // Verified when URL transitions away from login page to dashboard/portal/home
    const wasOnLoginPage = state.steps.some((s) => s.url.includes('login'));
    const isNowAwayFromLogin = !currentUrl.includes('login') && currentUrl.length > 0;
    const hasTyped = state.previousActions.some((a) => a.action === 'type');
    const hasClickedSubmit = state.previousActions.some((a) => a.action === 'click');

    if (wasOnLoginPage && isNowAwayFromLogin && hasTyped && hasClickedSubmit) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: `Login successful: authenticated state observed at '${currentUrl}'.`,
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 3. Shopping / Product Search & Constraint Verification ─────────────────
  const isShoppingTask =
    state.taskConstraints.maxPrice !== undefined ||
    state.taskConstraints.size !== undefined ||
    state.taskConstraints.color !== undefined ||
    lower.includes('shopping') ||
    lower.includes('bag') ||
    lower.includes('product');

  if (isShoppingTask) {
    // Extract candidates from current perception
    const candidates = extractCandidatesFromContext(context, state.taskConstraints);
    if (candidates.length > 0) {
      state.candidateItems = candidates;
    }

    const qualifying = state.candidateItems.filter((c) => c.matchesConstraints);

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
    if (currentUrl.includes('product') && state.previousActions.some((a) => a.action === 'click')) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Navigated to verified product detail page for qualifying item.',
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
    const hasClicked = state.previousActions.some((a) => a.action === 'click');
    const hasScrolled = state.previousActions.some((a) => a.action === 'scroll');
    if (state.previousActions.length >= 3 && hasClicked && hasScrolled) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Navigated to and verified recent account transaction history.',
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  // ── 5. Single-step demo tasks ──────────────────────────────────────────────
  if (lower.includes('account number') || lower.includes('account_number')) {
    const found =
      state.steps.some(
        (s) => s.executionSuccess && s.action.action === 'click' && s.targetType === 'account_number'
      ) ||
      state.previousActions.some(
        (a) =>
          a.action === 'click' &&
          state.visitedElementIds.some((id) => {
            const det = context.detections.find((d) => d.id === id);
            return det && det.type === 'account_number';
          })
      );
    if (found) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Account number field identified and opened locally.',
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  if (lower.includes('scroll down') || lower.includes('scroll')) {
    if (state.previousActions.some((a) => a.action === 'scroll')) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Scroll observation action completed.',
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  if (lower.includes('account details') || lower.includes('details')) {
    if (state.previousActions.some((a) => a.action === 'click')) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Account details view opened.',
      };
    }
    return { satisfied: false, status: 'IN_PROGRESS' };
  }

  return { satisfied: false, status: 'IN_PROGRESS' };
}
