/**
 * PrivAgent — Extensible Hierarchical Task Decomposer (Phase 4.2)
 *
 * Decomposes high-level user goals into structured subgoals with dependency prerequisites.
 *
 * Core Principles:
 *  - Generic & Extensible: Information Retrieval, E-Commerce, Form Fill, and Authentication
 *    are representative examples, NOT an exhaustive closed enum.
 *  - Unknown task types remain at a safe, generic exploratory level or fail safely with UNSUPPORTED_TASK_TYPE.
 *  - Redundant-step skipping: If current BrowserWorldModel shows the browser is already at
 *    the intended page or state, unnecessary navigation steps are bypassed.
 *  - Max subgoals bounded to <= 10.
 */

import {
  HighLevelGoal,
  Subgoal,
  TaskCategory,
  SubgoalCategory,
  DEFAULT_PLANNING_BOUNDS,
} from './hierarchicalTypes';
import { BrowserWorldModel } from '../worldModel/types';
import { SemanticPageType } from '../semanticUnderstanding/semanticTypes';
import { normalizeDestination } from '../planning/destinationNormalizer';

export interface TaskDecompositionOptions {
  worldModel?: BrowserWorldModel;
  /**
   * The URL the agent is currently on, when the caller already knows it.
   *
   * Used ONLY to avoid planning a NAVIGATE subgoal the agent does not need —
   * e.g. an INFORMATION_RETRIEVAL task that starts on the search provider it
   * was asked to use. It grants nothing, authorizes nothing, and is never
   * compared against a containment scope; a stale or absent value simply
   * produces the more conservative plan.
   */
  currentUrl?: string;
  maxSubgoals?: number;
  knownPageCategory?: SemanticPageType | string;
}

export interface DecompositionResult {
  goal: HighLevelGoal;
  subgoals: Subgoal[];
  skippedInitialSteps: string[];
}

/**
 * Categorizes a task prompt into a known pattern or GENERIC_INTERACTION / UNSUPPORTED_TASK_TYPE.
 * Never forces an ambiguous/unsupported prompt into a rigid domain bucket.
 */
export function classifyTaskCategory(prompt: string): TaskCategory {
  const lower = prompt.toLowerCase().trim();

  if (!lower) {
    return 'UNSUPPORTED_TASK_TYPE';
  }

  // Safety / Harmful prompt rejection
  const hazardousKeywords = ['exploit', 'bypass security', 'exfiltrate', 'steal password', 'crack key'];
  if (hazardousKeywords.some((k) => lower.includes(k))) {
    return 'UNSUPPORTED_TASK_TYPE';
  }

  // E-commerce Search & Shopping
  if (
    lower.includes('buy') ||
    lower.includes('purchase') ||
    lower.includes('cart') ||
    lower.includes('product') ||
    lower.includes('price') ||
    lower.includes('order') ||
    lower.includes('amazon') ||
    lower.includes('shop')
  ) {
    return 'ECOMMERCE_SEARCH';
  }

  // Information Retrieval & Search
  if (
    lower.includes('search') ||
    lower.includes('find') ||
    lower.includes('lookup') ||
    lower.includes('what is') ||
    lower.includes('who is') ||
    lower.includes('google') ||
    lower.includes('wiki')
  ) {
    return 'INFORMATION_RETRIEVAL';
  }

  // Form Fill
  if (
    lower.includes('fill') ||
    lower.includes('form') ||
    lower.includes('register') ||
    lower.includes('sign up') ||
    lower.includes('submit form') ||
    lower.includes('enter') ||
    lower.includes('type into')
  ) {
    return 'FORM_FILL';
  }

  // Authentication Intent
  if (
    lower.includes('login') ||
    lower.includes('sign in') ||
    lower.includes('log in') ||
    lower.includes('authenticate')
  ) {
    return 'AUTHENTICATION';
  }

  // Generic Safe Task
  return 'GENERIC_INTERACTION';
}

/**
 * Extracts target entities and constraints from user prompt safely without leaking PII.
 */
function extractEntitiesAndConstraints(
  prompt: string,
  category: TaskCategory
): { targetEntities: string[]; constraints: Record<string, string | number | boolean> } {
  const entities: string[] = [];
  const constraints: Record<string, string | number | boolean> = {};

  // Extract quoted text or keywords
  const quotes = prompt.match(/"([^"]+)"|'([^']+)'/g);
  if (quotes) {
    for (const q of quotes) {
      const clean = q.replace(/['"]/g, '').trim();
      if (clean.length > 1) {
        entities.push(clean);
      }
    }
  }

  // Fallback simple noun extraction for common categories
  if (entities.length === 0) {
    const tokens = prompt
      // A URL is an ADDRESS, not page content. Strip it before tokenising so a
      // host/port fragment can never be manufactured into a target entity.
      // Without this, "open the store catalog at http://localhost:4174 and open
      // the first product listed" yields the entity "store catalog
      // httplocalhost4174" — a mangled URL asserted as the product to search
      // for, which no affordance on any page can ever match. That fabricated
      // subgoal is what drove the wasted reasoning cycles after the first
      // navigation: the planner was hunting a product that was never named.
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'search', 'find', 'open', 'page', 'site',
      'click', 'press', 'show', 'look', 'what', 'where', 'when', 'from', 'into'
    ]);
    const candidates = tokens.filter((t) => !stopWords.has(t.toLowerCase()));
    if (candidates.length > 0) {
      entities.push(candidates.slice(0, 3).join(' '));
    }
  }

  // Price constraints check
  const priceMatch = prompt.match(/under\s*\$?(\d+)|less than\s*\$?(\d+)|\$?(\d+)\s*or less/i);
  if (priceMatch) {
    const val = Number(priceMatch[1] || priceMatch[2] || priceMatch[3]);
    if (!isNaN(val)) constraints.maxPrice = val;
  }

  return { targetEntities: entities, constraints };
}

/**
 * Decomposes a user task into a structured HighLevelGoal and Subgoal list.
 */
export function decomposeTask(
  userPrompt: string,
  options?: TaskDecompositionOptions
): DecompositionResult {
  const maxSubgoals = options?.maxSubgoals ?? DEFAULT_PLANNING_BOUNDS.maxSubgoals;
  const worldModel = options?.worldModel;
  // Prefer the URL the caller already knows (e.g. the pinned target tab's
  // seeded initialUrl) over deriving it from a world model we may not have.
  const currentUrl = options?.currentUrl || worldModel?.page?.url || '';
  const currentCategory = options?.knownPageCategory || worldModel?.page?.pageType;

  const taskCategory = classifyTaskCategory(userPrompt);

  const goalId = `goal-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  const { targetEntities, constraints } = extractEntitiesAndConstraints(userPrompt, taskCategory);

  // POST-17.10 Step 7 — destination intent, derived ONCE from the raw user
  // prompt and nowhere else.
  //
  // `userPrompt` is the only input. This line runs before any observation is
  // read and its result is never written again: the declaration type is
  // entirely `readonly`, so browser state, page classification, affordances,
  // action URLs and model output have no way to reach it. `currentUrl` /
  // `worldModel` ARE in scope on both sides of this call and are deliberately
  // NOT passed to the normalizer — that is the whole anti-laundering property.
  const destinationDeclaration = normalizeDestination(userPrompt);

  const highLevelGoal: HighLevelGoal = {
    goalId,
    rawUserPrompt: userPrompt,
    sanitizedGoalDescription: userPrompt.replace(/[^\x20-\x7E]/g, '').trim(),
    taskCategory,
    targetEntities,
    constraints,
    createdAt: Date.now(),
    status: taskCategory === 'UNSUPPORTED_TASK_TYPE' ? 'FAILED' : 'ACTIVE',
    destinationDeclaration,
  };

  if (taskCategory === 'UNSUPPORTED_TASK_TYPE') {
    return {
      goal: highLevelGoal,
      subgoals: [],
      skippedInitialSteps: [],
    };
  }

  const subgoals: Subgoal[] = [];
  const skippedInitialSteps: string[] = [];

  const addSubgoal = (
    category: SubgoalCategory,
    description: string,
    expectedActionType?: Subgoal['expectedActionType'],
    prerequisites: string[] = [],
    verificationCondition?: Subgoal['verificationCondition'],
    targetEntity?: string,
    destination?: Subgoal['destination']
  ): string => {
    if (subgoals.length >= maxSubgoals) return '';
    const id = `${goalId}-sg${subgoals.length + 1}`;
    subgoals.push({
      id,
      goalId,
      index: subgoals.length,
      category,
      description,
      expectedActionType,
      state: 'PENDING',
      prerequisites,
      retryCount: 0,
      maxRetries: 2,
      verificationCondition,
      targetEntity,
      destination,
    });
    return id;
  };

  /**
   * POST-17.10 Step 7. The destination constraints a subgoal may verify, or
   * `undefined` when the user declared no destination.
   *
   * `AMBIGUOUS` and `UNSUPPORTED` deliberately yield `undefined`: an ambiguous
   * goal must not be guessed into a destination, and an unmapped one must not
   * be invented. Those subgoals keep the previous fail-closed condition, which
   * can never be satisfied.
   */
  const declaredDestination =
    destinationDeclaration.kind === 'DECLARED' ? destinationDeclaration : undefined;

  /**
   * POST-17.10 Step 8 — THE CLASSIFICATION GAP, AND ITS FIX.
   *
   * The audit behind this helper found the exact disconnection: the typed
   * declaration was produced for EVERY prompt but CONSUMED in exactly one place,
   * the ECOMMERCE_SEARCH branch. `INFORMATION_RETRIEVAL`, `FORM_FILL`,
   * `AUTHENTICATION` and `GENERIC_INTERACTION` each silently discarded it. So a
   * prompt whose destination was unambiguous — "open the store catalog at
   * <url>" — planned no destination subgoal whenever its LEXICAL category did
   * not happen to contain a commerce keyword.
   *
   * The chosen fix is the narrow one, and it is deliberately NOT the other one:
   *
   *   NOT FIXED: adding "catalog"/"store" to the e-commerce keyword list, or
   *              rewriting the category to ECOMMERCE_SEARCH. That would change
   *              GLOBAL classification semantics on a guess, and would mis-file
   *              unrelated prompts that merely contain the word.
   *
   *   FIXED:     the typed declaration is now an explicit SECOND planning input,
   *              alongside the lexical category, and it gates a destination
   *              subgoal in every branch that does not already produce one.
   *              `classifyTaskCategory` is untouched; the category still governs
   *              everything else about the plan.
   *
   * Invariants this preserves:
   *  - The subgoal exists ONLY when the declaration is DECLARED. `NONE`,
   *    `AMBIGUOUS` and `UNSUPPORTED` yield `''` — the gate is the declaration,
   *    never the category, so "click the submit button" gains nothing.
   *  - Exactly ONE destination subgoal can exist per plan. The ECOMMERCE branch
   *    builds its own and does not call this helper, so no flow can double up.
   *  - The destination is still copied from `HighLevelGoal.destinationDeclaration`,
   *    which is derived from `userPrompt` alone.
   */
  const addDestinationSubgoal = (): string => {
    if (!declaredDestination) return '';
    return addSubgoal(
      'NAVIGATE',
      'Reach the destination declared in the user request',
      'navigate',
      [],
      { type: 'DESTINATION_VERIFIED', description: 'Declared destination is observed' },
      undefined,
      declaredDestination
    );
  };

  /** Prerequisites contributed by the destination subgoal, when one exists. */
  const destinationPrerequisites = (id: string): string[] => (id ? [id] : []);

  // Determine if browser is already at a search engine or query results
  const isAlreadyOnSearchPage =
    currentUrl.includes('google.com') ||
    currentUrl.includes('bing.com') ||
    currentUrl.includes('duckduckgo.com') ||
    currentCategory === 'SEARCH' ||
    currentCategory === 'SEARCH_RESULTS';

  const isAlreadyOnEcommerce =
    currentCategory === 'LISTING' ||
    currentCategory === 'CHECKOUT' ||
    currentCategory === 'PRODUCT_LISTING' ||
    currentCategory === 'PRODUCT_DETAIL';

  // ── Category-Specific Decomposition ────────────────────────────────────────

  switch (taskCategory) {
    case 'INFORMATION_RETRIEVAL': {
      // STEP 8: a declared destination is planned first, and the search chain
      // depends on it. Gated on the declaration, so an ordinary information
      // request (declaration NONE) plans exactly what it always did.
      const destinationNavId = addDestinationSubgoal();
      let navId = '';
      if (!isAlreadyOnSearchPage && !currentUrl) {
        navId = addSubgoal(
          'NAVIGATE',
          'Navigate to search engine or knowledge portal',
          'navigate',
          [],
          { type: 'URL_CONTAINS', expectedValue: 'google.com', description: 'Search portal loaded' }
        );
      } else if (isAlreadyOnSearchPage) {
        skippedInitialSteps.push('NAVIGATE (Browser already on search provider/page)');
      }

      const searchPrereq = [...destinationPrerequisites(destinationNavId), ...(navId ? [navId] : [])];
      const searchTarget = targetEntities[0] || userPrompt;
      const searchId = addSubgoal(
        'SEARCH',
        `Enter search query "${searchTarget}" into search box`,
        'type',
        searchPrereq,
        // The observed affordance that makes THIS subgoal's own action
        // (`type` a query into a search box) groundable. Named, so the
        // condition can be proven or refuted from the observed affordance set
        // instead of degrading to "the page has affordances", which
        // `discoverActionAffordances` satisfies on every document via its
        // unconditional `SCROLL`. The POST-condition ("results are displayed")
        // is a page-state claim and is deliberately not asserted here.
        { type: 'AFFORDANCE_AVAILABLE', expectedValue: 'ENTER_QUERY', description: 'Search query input available on the observed page' },
        searchTarget
      );

      const locateId = addSubgoal(
        'LOCATE',
        `Locate relevant search result matching "${searchTarget}"`,
        'inspect',
        [searchId],
        { type: 'ELEMENT_EXISTS', description: 'Relevant search item found' },
        searchTarget
      );

      const extractId = addSubgoal(
        'EXTRACT',
        'Extract target information from verified search result',
        'inspect',
        [locateId],
        { type: 'STATE_CHANGED', description: 'Information verified on-device' }
      );

      addSubgoal(
        'VERIFY',
        'Verify target information satisfies user query',
        'verify',
        [extractId],
        { type: 'STATE_CHANGED', description: 'Goal verified' }
      );
      break;
    }

    case 'ECOMMERCE_SEARCH': {
      let navId = '';
      if (!isAlreadyOnEcommerce && !currentUrl.includes('amazon') && !currentUrl.includes('shop')) {
        navId = addSubgoal(
          'NAVIGATE',
          'Navigate to commerce catalog or store front',
          'navigate',
          [],
          // POST-17.10 Step 7 — this subgoal's completion condition IS the
          // user's declared destination, verified against observed page
          // identity. See `Subgoal.destination`, which is the typed carrier.
          //
          // When the user declared no destination the previous fail-closed
          // condition is retained unchanged, so the subgoal still cannot
          // complete. It is NOT replaced by a fallback that could.
          declaredDestination
            ? {
                type: 'DESTINATION_VERIFIED' as const,
                description: 'Declared destination is observed',
              }
            : {
                // KNOWN-UNVERIFIABLE, DELIBERATELY UNCHANGED.
                //
                // "Store catalog reachable" is a DESTINATION claim. With no
                // typed declaration there is nothing to verify it against —
                // `URL_CONTAINS` would need a hardcoded store domain,
                // `AFFORDANCE_AVAILABLE` a named affordance meaning
                // "catalog" — and neither exists. `GoalProgressTracker` fails
                // this unnamed condition closed, so the subgoal stays
                // IN_PROGRESS. That is the safe direction: it cannot
                // fabricate completion, and Goal Verification remains the sole
                // task-SUCCESS authority.
                type: 'AFFORDANCE_AVAILABLE' as const,
                description: 'Store catalog reachable',
              },
          undefined,
          declaredDestination
        );
      } else {
        skippedInitialSteps.push('NAVIGATE (Browser already on commerce catalog)');
      }

      const searchPrereq = navId ? [navId] : [];
      const productQuery = targetEntities[0] || 'requested item';
      const searchId = addSubgoal(
        'SEARCH',
        `Search catalog for product "${productQuery}"`,
        'type',
        searchPrereq,
        // Named for the same reason as the INFORMATION_RETRIEVAL SEARCH above:
        // the observed affordance that makes `type`ing a product query into the
        // catalog groundable. Naming it keeps the condition falsifiable.
        { type: 'AFFORDANCE_AVAILABLE', expectedValue: 'ENTER_QUERY', description: 'Catalog query input available on the observed page' },
        productQuery
      );

      const selectId = addSubgoal(
        'SELECT',
        `Select product candidate conforming to constraints (${JSON.stringify(constraints)})`,
        'click',
        [searchId],
        { type: 'ELEMENT_EXISTS', description: 'Product detail viewed' },
        productQuery
      );

      const verifyId = addSubgoal(
        'VERIFY',
        'Verify product specifications, price, and availability on-device',
        'verify',
        [selectId],
        { type: 'STATE_CHANGED', description: 'Product matches constraints' }
      );

      // If user prompt indicates adding to cart or purchase
      if (userPrompt.toLowerCase().includes('cart') || userPrompt.toLowerCase().includes('buy')) {
        addSubgoal(
          'CONFIRM',
          'Locate add to cart affordance and request user confirmation before proceeding',
          'click',
          [verifyId],
          { type: 'USER_CONFIRMED', description: 'User explicitly confirmed cart action' }
        );
      }
      break;
    }

    case 'FORM_FILL': {
      // STEP 8. "open the contact form at <url>" classifies as FORM_FILL because
      // of the word "form", yet it also carries an explicit FORM destination —
      // previously discarded. The destination is now planned and gated.
      const destinationNavId = addDestinationSubgoal();
      const inspectId = addSubgoal(
        'LOCATE',
        'Inspect and ground required form fields on current page',
        'inspect',
        destinationPrerequisites(destinationNavId),
        { type: 'ELEMENT_EXISTS', description: 'Form fields mapped' }
      );

      const fillId = addSubgoal(
        'FILL',
        'Fill input fields using sanitized local attributes with zero remote credential leakage',
        'type',
        [inspectId],
        { type: 'STATE_CHANGED', description: 'Inputs populated' }
      );

      const verifyFillId = addSubgoal(
        'VERIFY',
        'Verify form inputs are valid and conform to constraints',
        'verify',
        [fillId],
        { type: 'STATE_CHANGED', description: 'Form validated' }
      );

      // Submitting always requires explicit user confirmation
      addSubgoal(
        'CONFIRM',
        'Request explicit user confirmation before submitting form',
        'click',
        [verifyFillId],
        { type: 'USER_CONFIRMED', description: 'User approved submission' }
      );
      break;
    }

    case 'AUTHENTICATION': {
      // Security Invariant: Never assume user wants to automatically log in.
      // Credentials must remain local and require user confirmation.
      // STEP 8: a declared destination (e.g. an explicit sign-in page) is
      // planned first. Gated on the declaration; credential handling below is
      // entirely unchanged.
      const destinationNavId = addDestinationSubgoal();
      const inspectId = addSubgoal(
        'LOCATE',
        'Inspect login form inputs and verify secure HTTPS origin',
        'inspect',
        destinationPrerequisites(destinationNavId),
        { type: 'ELEMENT_EXISTS', description: 'Login fields grounded securely' }
      );

      const confirmAuthId = addSubgoal(
        'CONFIRM',
        'Request user authorization before populating credentials locally',
        'verify',
        [inspectId],
        { type: 'USER_CONFIRMED', description: 'User confirmed authentication' }
      );

      const fillAuthId = addSubgoal(
        'FILL',
        'Populate login identifiers on-device with zero network exfiltration',
        'type',
        [confirmAuthId],
        { type: 'STATE_CHANGED', description: 'Credentials populated locally' }
      );

      addSubgoal(
        'VERIFY',
        'Verify authentication outcome safely without capturing session secrets',
        'verify',
        [fillAuthId],
        { type: 'STATE_CHANGED', description: 'Authentication verified' }
      );
      break;
    }

    case 'GENERIC_INTERACTION':
    default: {
      // Safe generic exploratory flow.
      //
      // STEP 8 — the canonical gap. "open the store catalog at <url>" declares
      // `role = LISTING` + an entry site, but carries no commerce keyword, so it
      // classified GENERIC_INTERACTION and planned NO destination subgoal. The
      // typed declaration is now honoured here, WITHOUT touching the category.
      //
      // The LOCATE existence claim below is untouched and remains deliberately
      // unverifiable; this adds a separate, structurally typed subgoal ahead of
      // it rather than repurposing it.
      const destinationNavId = addDestinationSubgoal();
      const inspectId = addSubgoal(
        'LOCATE',
        `Perceive page and locate candidate controls relevant to "${highLevelGoal.sanitizedGoalDescription}"`,
        'inspect',
        destinationPrerequisites(destinationNavId),
        // POST-17.10 — KNOWN-UNVERIFIABLE, DELIBERATELY UNCHANGED.
        //
        // "Controls identified" is an EXISTENCE claim, not a named-affordance
        // claim, and no single `ActionAffordanceType` expresses it. Wiring
        // `SCROLL` would be the forbidden "always true in another form":
        // `discoverActionAffordances` appends `SCROLL` unconditionally for
        // every document, so it would reintroduce exactly the vacuous
        // verification this condition previously had. The required future
        // change is a first-class, page-derived "the page exposes N
        // interactive elements" observation distinct from the affordance set;
        // it is deliberately NOT invented here. See the sibling comment on
        // the ECOMMERCE NAVIGATE subgoal above.
        { type: 'AFFORDANCE_AVAILABLE', description: 'Controls identified' }
      );

      const actId = addSubgoal(
        'SELECT',
        'Execute primary safe interaction with grounded target',
        'click',
        [inspectId],
        { type: 'STATE_CHANGED', description: 'Target interaction executed' }
      );

      addSubgoal(
        'VERIFY',
        'Verify state change satisfies user goal',
        'verify',
        [actId],
        { type: 'STATE_CHANGED', description: 'Interaction outcome verified' }
      );
      break;
    }
  }

  // Mark initial subgoals without prerequisites as READY
  for (const sg of subgoals) {
    if (sg.prerequisites.length === 0) {
      sg.state = 'READY';
    }
  }

  return {
    goal: highLevelGoal,
    subgoals,
    skippedInitialSteps,
  };
}
