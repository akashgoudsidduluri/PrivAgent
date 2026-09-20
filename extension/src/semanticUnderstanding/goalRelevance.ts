/**
 * PrivAgent 2.0 — Goal Relevance Scoring Engine (P3.7)
 *
 * Maps active natural language user goals and parsed constraints to relevant
 * observable entities and action affordances on the page.
 *
 * CRITICAL ARCHITECTURAL INVARIANT:
 *  The semantic layer identifies relevance and matches candidates;
 *  it does NOT authoritatively declare final goal achievement or success.
 *  The existing deterministic goalVerifier remains the sole authority.
 *  UNKNOWN constraint values remain strictly UNKNOWN.
 */

import { extractTaskConstraints } from '../agent/goalParser';
import { ActionAffordance, GoalRelevanceResult, SemanticEntity } from './semanticTypes';

export interface GoalRelevanceOptions {
  userGoal?: string;
  entities: SemanticEntity[];
  affordances: ActionAffordance[];
}

export function evaluateGoalRelevance(options: GoalRelevanceOptions): GoalRelevanceResult {
  const { userGoal, entities, affordances } = options;

  if (!userGoal || userGoal.trim() === '') {
    return {
      matchedGoalTerms: [],
      relevantEntities: [],
      relevantAffordances: [],
      confidence: 0.1,
      relevanceSummary: 'No user goal specified for relevance matching',
      isGoalPotentiallySatisfied: false,
    };
  }

  const constraints = extractTaskConstraints(userGoal);
  const goalLower = userGoal.toLowerCase();
  const goalTokens = goalLower
    .replace(/[^\w\s₹$]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);

  const matchedTerms: Set<string> = new Set();
  const relevantEntities: SemanticEntity[] = [];

  // 1. Evaluate Entity Relevance against Goal Constraints
  for (const ent of entities) {
    const labelLower = ent.label.toLowerCase();
    let isRelevant = false;

    // Check keyword token matches
    for (const token of goalTokens) {
      if (labelLower.includes(token)) {
        matchedTerms.add(token);
        isRelevant = true;
      }
    }

    // Check specific constraints
    if (constraints.color && labelLower.includes(constraints.color.toLowerCase())) {
      matchedTerms.add(constraints.color);
      isRelevant = true;
    }
    if (constraints.category && labelLower.includes(constraints.category.toLowerCase())) {
      matchedTerms.add(constraints.category);
      isRelevant = true;
    }

    // Check max price compatibility
    if (constraints.maxPrice !== undefined && typeof ent.safeAttributes.price === 'number') {
      if (ent.safeAttributes.price <= constraints.maxPrice) {
        matchedTerms.add(`<= ₹${constraints.maxPrice}`);
        isRelevant = true;
      }
    }

    if (isRelevant) {
      relevantEntities.push(ent);
    }
  }

  // 2. Evaluate Relevant Affordances
  const relevantAffordances: ActionAffordance[] = [];
  for (const aff of affordances) {
    // E-commerce search / product selection affordances relevant to shopping goals
    if (
      aff.type === 'ADD_TO_CART' ||
      aff.type === 'SELECT_VARIANT' ||
      aff.type === 'SELECT_RESULT' ||
      aff.type === 'ENTER_QUERY' ||
      aff.type === 'SUBMIT_SEARCH'
    ) {
      relevantAffordances.push(aff);
    }
  }

  const matchedTermsList = Array.from(matchedTerms);
  const hasStrongMatch = relevantEntities.length > 0 && matchedTermsList.length >= 2;
  const confidence = hasStrongMatch ? 0.90 : relevantEntities.length > 0 ? 0.70 : 0.40;

  const relevanceSummary = hasStrongMatch
    ? `Identified ${relevantEntities.length} matching entities for terms: ${matchedTermsList.join(', ')}`
    : relevantEntities.length > 0
    ? `Partial match found (${relevantEntities.length} candidates) for terms: ${matchedTermsList.join(', ')}`
    : 'No directly matching entities located on current page';

  return {
    matchedGoalTerms: matchedTermsList,
    relevantEntities,
    relevantAffordances,
    confidence,
    relevanceSummary,
    // Strictly potential candidate presence, NOT final goal success assertion
    isGoalPotentiallySatisfied: hasStrongMatch,
  };
}
