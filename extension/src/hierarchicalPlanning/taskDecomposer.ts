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

export interface TaskDecompositionOptions {
  worldModel?: BrowserWorldModel;
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
  const currentUrl = worldModel?.page?.url || '';
  const currentCategory = options?.knownPageCategory || worldModel?.page?.pageType;

  const taskCategory = classifyTaskCategory(userPrompt);

  const goalId = `goal-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  const { targetEntities, constraints } = extractEntitiesAndConstraints(userPrompt, taskCategory);

  const highLevelGoal: HighLevelGoal = {
    goalId,
    rawUserPrompt: userPrompt,
    sanitizedGoalDescription: userPrompt.replace(/[^\x20-\x7E]/g, '').trim(),
    taskCategory,
    targetEntities,
    constraints,
    createdAt: Date.now(),
    status: taskCategory === 'UNSUPPORTED_TASK_TYPE' ? 'FAILED' : 'ACTIVE',
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
    targetEntity?: string
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
    });
    return id;
  };

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

      const searchPrereq = navId ? [navId] : [];
      const searchTarget = targetEntities[0] || userPrompt;
      const searchId = addSubgoal(
        'SEARCH',
        `Enter search query "${searchTarget}" into search box`,
        'type',
        searchPrereq,
        { type: 'AFFORDANCE_AVAILABLE', description: 'Query results displayed' },
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
          { type: 'AFFORDANCE_AVAILABLE', description: 'Store catalog reachable' }
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
        { type: 'AFFORDANCE_AVAILABLE', description: 'Catalog results presented' },
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
      const inspectId = addSubgoal(
        'LOCATE',
        'Inspect and ground required form fields on current page',
        'inspect',
        [],
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
      const inspectId = addSubgoal(
        'LOCATE',
        'Inspect login form inputs and verify secure HTTPS origin',
        'inspect',
        [],
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
      // Safe generic exploratory flow
      const inspectId = addSubgoal(
        'LOCATE',
        `Perceive page and locate candidate controls relevant to "${highLevelGoal.sanitizedGoalDescription}"`,
        'inspect',
        [],
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
