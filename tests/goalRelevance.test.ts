/**
 * PrivAgent 2.0 — Goal Relevance Scoring Test Suite (Subphase P3.7)
 *
 * Validates:
 *  1. Extraction of relevant entities and attributes matching natural language goal
 *  2. Mapping of relevant affordances (ADD_TO_CART, SELECT_RESULT)
 *  3. Invariant: Does NOT declare authoritative goal success (goalVerifier remains authority)
 *  4. Uncertainty: Low confidence when entities do not match goal
 */

import { describe, it, expect } from 'vitest';
import { evaluateGoalRelevance } from '../extension/src/semanticUnderstanding/goalRelevance';
import { SemanticEntity, ActionAffordance } from '../extension/src/semanticUnderstanding/semanticTypes';

describe('Subphase P3.7 — Goal Relevance Scoring', () => {
  const sampleEntities: SemanticEntity[] = [
    {
      id: 'prod-1',
      type: 'Product',
      label: 'Black Waterproof Backpack',
      confidence: 0.95,
      source: 'layout',
      associatedInteractiveElements: ['btn-buy-1'],
      pageGeneration: 1,
      safeAttributes: { price: 899, priceAvailable: true },
    },
    {
      id: 'prod-2',
      type: 'Product',
      label: 'Red Running Shoes',
      confidence: 0.95,
      source: 'layout',
      associatedInteractiveElements: ['btn-buy-2'],
      pageGeneration: 1,
      safeAttributes: { price: 1500, priceAvailable: true },
    },
  ];

  const sampleAffordances: ActionAffordance[] = [
    {
      id: 'aff-1',
      type: 'ADD_TO_CART',
      targetElementId: 'btn-buy-1',
      confidence: 0.95,
      description: 'Add to cart',
      requiresConfirmation: false,
      pageGeneration: 1,
      source: 'layout',
    },
    {
      id: 'aff-2',
      type: 'SELECT_RESULT',
      targetElementId: 'res-link',
      confidence: 0.90,
      description: 'Open product',
      requiresConfirmation: false,
      pageGeneration: 1,
      source: 'layout',
    },
  ];

  it('1. matches relevant entity and attributes for "Find a black backpack under ₹1000"', () => {
    const res = evaluateGoalRelevance({
      userGoal: 'Find a black backpack under ₹1000',
      entities: sampleEntities,
      affordances: sampleAffordances,
    });

    expect(res.relevantEntities.length).toBe(1);
    expect(res.relevantEntities[0]!.id).toBe('prod-1');
    expect(res.matchedGoalTerms).toContain('black');
    expect(res.matchedGoalTerms).toContain('backpack');
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
    expect(res.relevantAffordances.some(a => a.type === 'ADD_TO_CART')).toBe(true);
  });

  it('2. returns low confidence when no entity matches user goal', () => {
    const res = evaluateGoalRelevance({
      userGoal: 'Buy yellow sunglasses',
      entities: sampleEntities,
      affordances: sampleAffordances,
    });

    expect(res.relevantEntities.length).toBe(0);
    expect(res.confidence).toBeLessThan(0.50);
  });

  it('3. INVARIANT: Does not declare authoritative goal success', () => {
    const res = evaluateGoalRelevance({
      userGoal: 'Find a black backpack under ₹1000',
      entities: sampleEntities,
      affordances: sampleAffordances,
    });

    // The relevance engine scores candidate relevance; it does NOT return a TaskStatus
    expect((res as unknown as Record<string, unknown>).taskStatus).toBeUndefined();
    expect((res as unknown as Record<string, unknown>).finalSuccess).toBeUndefined();
  });
});
