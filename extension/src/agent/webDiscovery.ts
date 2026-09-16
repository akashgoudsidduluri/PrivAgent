/**
 * PrivAgent — Autonomous Web Discovery Foundation (Phase 13)
 *
 * Implements clean discovery foundations for open-ended user goals
 * (e.g. "Find beige baggy pants under ₹1500") without creating a separate
 * automation engine or destabilizing the M6 AgentLoop.
 *
 * Architecture Flow:
 *   User Goal
 *      ↓
 *   Classify Intent & Destination (webDiscovery.ts)
 *      ↓
 *   Initial 'navigate' BrowserAction
 *      ↓
 *   M6 AgentLoop (Standard Single Loop)
 *      ↓
 *   Perception → Privacy Engine → Sanitized Context → LLM Reasoning
 *      ↓
 *   Consequential Action Gating (Purchase / Checkout / Payment require Confirmation)
 */

export type GoalCategory =
  | 'DIRECT_BANKING'
  | 'ECOMMERCE_DISCOVERY'
  | 'INFORMATIONAL_SEARCH'
  | 'UNKNOWN';

export interface WebDiscoveryPlan {
  category: GoalCategory;
  destinationUrl: string;
  searchQuery?: string;
  initialActionDescription: string;
  requiresGatedConfirmation: boolean;
}

const CONSEQUENTIAL_KEYWORDS = [
  'buy',
  'purchase',
  'order',
  'checkout',
  'pay',
  'confirm payment',
  'submit application',
  'transfer',
];

/**
 * Evaluates whether a proposed browser action or user intent is consequential
 * and MUST be gated behind explicit human-in-the-loop confirmation.
 */
export function isConsequentialAction(actionDescription: string, targetLabel = ''): boolean {
  const text = `${actionDescription} ${targetLabel}`.toLowerCase();
  return CONSEQUENTIAL_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Resolves an open-ended natural language goal into a structured initial web discovery plan.
 */
export function planWebDiscovery(goal: string): WebDiscoveryPlan {
  const text = goal.toLowerCase();

  // 1. Direct Banking / Synthetic Demo
  if (text.includes('account') || text.includes('balance') || text.includes('transaction') || text.includes('4173')) {
    return {
      category: 'DIRECT_BANKING',
      destinationUrl: 'http://localhost:4173',
      initialActionDescription: 'Open synthetic banking portal to inspect account details',
      requiresGatedConfirmation: false,
    };
  }

  // 2. E-commerce / Product Discovery (e.g. "Find beige baggy pants under ₹1500")
  if (
    text.includes('find') ||
    text.includes('buy') ||
    text.includes('pants') ||
    text.includes('shirt') ||
    text.includes('price') ||
    text.includes('under')
  ) {
    const isConsequential = isConsequentialAction(text);
    return {
      category: 'ECOMMERCE_DISCOVERY',
      destinationUrl: 'https://duckduckgo.com',
      searchQuery: goal,
      initialActionDescription: `Navigate to web search to find matching catalogue items: "${goal}"`,
      requiresGatedConfirmation: isConsequential,
    };
  }

  // 3. General Informational Search
  return {
    category: 'INFORMATIONAL_SEARCH',
    destinationUrl: 'https://duckduckgo.com',
    searchQuery: goal,
    initialActionDescription: `Search the web for query: "${goal}"`,
    requiresGatedConfirmation: false,
  };
}
