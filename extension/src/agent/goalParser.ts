/**
 * PrivAgent — Deterministic Goal Decomposition & Constraint Parser (Phase 2)
 *
 * Decomposes natural language user goals into structured constraints, site intents,
 * and ordered subgoals without hardcoding website-specific logic.
 *
 * Security Invariant:
 *  - Output conforms to safe metadata types with zero raw sensitive keys.
 */

import { StructuredConstraints, SubGoalItem } from './agentState';

export interface ParsedGoalResult {
  normalizedGoal: string;
  targetSite?: string;
  actionIntent: 'shopping' | 'search' | 'login' | 'banking' | 'navigation' | 'general';
  constraints: StructuredConstraints;
  subgoals: SubGoalItem[];
}

const COMMON_COLORS = [
  'black', 'white', 'red', 'blue', 'green',
  'yellow', 'orange', 'purple', 'pink', 'brown', 'grey', 'gray',
];

const COMMON_SIZES = ['xxxl', 'xxl', 'xl', 'xs', 's', 'm', 'l'];

const COMMON_STYLES = [
  'baggy', 'casual', 'formal', 'slim', 'oversized',
  'vintage', 'leather', 'cotton', 'denim', 'canvas',
];

const COMMON_CATEGORIES = [
  'bag', 'bags', 'shoe', 'shoes', 'shirt', 'shirts',
  't-shirt', 'laptop', 'phone', 'watch', 'dress', 'jacket',
];

/**
 * Extracts structured constraints from a user request string.
 */
export function extractTaskConstraints(task: string): StructuredConstraints {
  const lower = task.toLowerCase();
  const constraints: StructuredConstraints = {};

  // 1. Max Price extraction (e.g. "under ₹1000", "below 1000", "under $50", "max 1000")
  const priceRegex = /(?:under|below|less than|max(?:imum)? price of?|at most|up to|<=?)\s*(?:[₹$£€]|rs\.?|inr)?\s*(\d+(?:[.,]\d+)?)/i;
  const matchPrice = lower.match(priceRegex);
  if (matchPrice && matchPrice[1]) {
    constraints.maxPrice = parseFloat(matchPrice[1].replace(/,/g, ''));
  } else {
    // Alternative: e.g. "₹1000 or less", "1000 rs max"
    const altPriceRegex = /(?:[₹$£€]|rs\.?|inr)\s*(\d+(?:[.,]\d+)?)/i;
    const altMatch = lower.match(altPriceRegex);
    if (altMatch && altMatch[1]) {
      constraints.maxPrice = parseFloat(altMatch[1].replace(/,/g, ''));
    }
  }

  // Currency
  if (task.includes('₹') || lower.includes('rs') || lower.includes('inr')) {
    constraints.currency = '₹';
  } else if (task.includes('$') || lower.includes('usd')) {
    constraints.currency = '$';
  } else if (task.includes('€') || lower.includes('eur')) {
    constraints.currency = '€';
  }

  // 2. Size extraction
  for (const size of COMMON_SIZES) {
    const sizeRegex = new RegExp(`\\b${size}\\b`, 'i');
    if (sizeRegex.test(lower)) {
      constraints.size = size.toUpperCase();
      break;
    }
  }

  // 3. Color extraction
  for (const color of COMMON_COLORS) {
    const colorRegex = new RegExp(`\\b${color}\\b`, 'i');
    if (colorRegex.test(lower)) {
      constraints.color = color;
      break;
    }
  }

  // 4. Style extraction
  for (const style of COMMON_STYLES) {
    const styleRegex = new RegExp(`\\b${style}\\b`, 'i');
    if (styleRegex.test(lower)) {
      constraints.style = style;
      break;
    }
  }

  // 5. Category extraction
  for (const cat of COMMON_CATEGORIES) {
    const catRegex = new RegExp(`\\b${cat}\\b`, 'i');
    if (catRegex.test(lower)) {
      constraints.category = cat.endsWith('s') && cat.length > 3 ? cat.slice(0, -1) : cat;
      break;
    }
  }

  // 6. Authentication requirement
  if (lower.includes('login') || lower.includes('sign in') || lower.includes('log in') || lower.includes('authenticate')) {
    constraints.requiresAuth = true;
  }

  return constraints;
}

/**
 * Extracts destination site or domain from task if present.
 */
export function extractTargetSite(task: string): string | undefined {
  const urlRegex = /(https?:\/\/[^\s]+)/i;
  const matchUrl = task.match(urlRegex);
  if (matchUrl && matchUrl[1]) return matchUrl[1];

  const domainRegex = /\b([a-z0-9-]+\.(?:com|org|net|in|io|gov|edu))\b/i;
  const matchDomain = task.match(domainRegex);
  if (matchDomain && matchDomain[1]) return `https://www.${matchDomain[1].toLowerCase()}`;

  if (task.toLowerCase().includes('shopping site') || task.toLowerCase().includes('shopping portal')) {
    return 'http://localhost:4174';
  }

  if (task.toLowerCase().includes('google')) {
    return 'https://www.google.com';
  }

  return undefined;
}

/**
 * Parses user goal into a complete ParsedGoalResult with ordered subgoals.
 */
export function parseUserGoal(task: string): ParsedGoalResult {
  const lower = task.toLowerCase();
  const constraints = extractTaskConstraints(task);
  const targetSite = extractTargetSite(task);

  // Classify action intent
  let actionIntent: ParsedGoalResult['actionIntent'] = 'general';
  if (
    constraints.maxPrice !== undefined ||
    constraints.category ||
    constraints.size ||
    lower.includes('shopping') ||
    lower.includes('buy') ||
    lower.includes('product')
  ) {
    actionIntent = 'shopping';
  } else if (lower.includes('search') || lower.includes('google') || lower.includes('find')) {
    actionIntent = 'search';
  } else if (lower.includes('transaction') || lower.includes('account number') || lower.includes('banking')) {
    actionIntent = 'banking';
  } else if (lower.includes('login') || lower.includes('sign in')) {
    actionIntent = 'login';
  } else if (targetSite) {
    actionIntent = 'navigation';
  }

  // Construct ordered subgoals
  const subgoals: SubGoalItem[] = [];
  let order = 1;

  if (targetSite) {
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: `Navigate to target destination (${targetSite})`,
      expectedActionType: 'navigate',
      status: 'PENDING',
      targetHint: targetSite,
    });
  }

  if (constraints.requiresAuth) {
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: 'Authenticate / Sign in securely on-device',
      expectedActionType: 'click',
      status: 'PENDING',
      targetHint: 'login-button',
    });
  }

  if (actionIntent === 'shopping' || actionIntent === 'search') {
    const searchTerms: string[] = [];
    if (constraints.size) searchTerms.push(constraints.size);
    if (constraints.color) searchTerms.push(constraints.color);
    if (constraints.style) searchTerms.push(constraints.style);
    if (constraints.category) searchTerms.push(constraints.category);
    const query = searchTerms.join(' ') || 'search items';

    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: `Locate search input and query for "${query}"`,
      expectedActionType: 'type',
      status: 'PENDING',
      targetHint: 'search-input',
    });

    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: 'Submit search and observe resulting candidates',
      expectedActionType: 'click',
      status: 'PENDING',
      targetHint: 'search-submit',
    });

    if (actionIntent === 'shopping') {
      subgoals.push({
        id: `subgoal-${order}`,
        order: order++,
        description: 'Verify candidate products against price, size, and color constraints',
        expectedActionType: 'verify',
        status: 'PENDING',
      });
    }
  } else if (actionIntent === 'banking') {
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: 'Locate banking activity or account details view',
      expectedActionType: 'click',
      status: 'PENDING',
      targetHint: 'account-details',
    });
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: 'Inspect transactions or account information safely on-device',
      expectedActionType: 'verify',
      status: 'PENDING',
    });
  } else {
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: 'Perceive and interact with relevant target elements',
      expectedActionType: 'inspect',
      status: 'PENDING',
    });
  }

  // Normalized goal summary
  let normalizedGoal = task;
  if (actionIntent === 'shopping') {
    const constraintDesc: string[] = [];
    if (constraints.category) constraintDesc.push(`category: ${constraints.category}`);
    if (constraints.size) constraintDesc.push(`size: ${constraints.size}`);
    if (constraints.color) constraintDesc.push(`color: ${constraints.color}`);
    if (constraints.maxPrice !== undefined) constraintDesc.push(`max price: ${constraints.currency || ''}${constraints.maxPrice}`);
    normalizedGoal = `Find and verify qualifying products (${constraintDesc.join(', ') || 'matching query'})`;
  }

  return {
    normalizedGoal,
    targetSite,
    actionIntent,
    constraints,
    subgoals,
  };
}
