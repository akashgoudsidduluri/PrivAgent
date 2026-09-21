import { describe, it, expect } from 'vitest';
import { DynamicReplanner } from '../extension/src/hierarchicalPlanning/dynamicReplanner';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import { HighLevelGoal, Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import { ActionAffordance } from '../extension/src/semanticUnderstanding/semanticTypes';

describe('PrivAgent Phase 4 — Dynamic Replanner', () => {
  const dummyGoal: HighLevelGoal = {
    goalId: 'g1',
    rawUserPrompt: 'Buy wireless earbuds',
    sanitizedGoalDescription: 'Buy wireless earbuds',
    taskCategory: 'ECOMMERCE_SEARCH',
    targetEntities: ['wireless earbuds'],
    constraints: {},
    createdAt: Date.now(),
    status: 'ACTIVE',
  };

  const dummySubgoal: Subgoal = {
    id: 'sg1',
    goalId: 'g1',
    index: 0,
    category: 'SELECT',
    description: 'Select earbud item',
    state: 'IN_PROGRESS',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
  };

  it('handles LOGIN_REQUIRED by requiring user confirmation and keeping credentials local', () => {
    const graph = new SubgoalGraph('g1', [dummySubgoal]);
    const decision = DynamicReplanner.replan({
      graph,
      goal: dummyGoal,
      failedSubgoal: dummySubgoal,
      trigger: 'LOGIN_REQUIRED',
      triggerReason: 'Login form encountered',
      replanCount: 0,
    });

    expect(decision.shouldReplan).toBe(true);
    expect(decision.requiresUserConfirmation).toBe(true);
    expect(decision.userConfirmationPrompt).toContain('authentication');
    expect(decision.newSubgoals?.[0]?.category).toBe('CONFIRM');
  });

  it('handles MODAL_INTERCEPTED by inserting a modal dismiss recovery subgoal', () => {
    const graph = new SubgoalGraph('g1', [dummySubgoal]);
    const affordances: ActionAffordance[] = [
      {
        id: 'aff-modal-close',
        type: 'GENERIC_CLICK',
        targetElementId: 'btn-modal-close',
        confidence: 0.9,
        description: 'Close dialog',
        requiresConfirmation: false,
        pageGeneration: 1,
        source: 'layout',
      },
    ];

    const decision = DynamicReplanner.replan({
      graph,
      goal: dummyGoal,
      failedSubgoal: dummySubgoal,
      trigger: 'MODAL_INTERCEPTED',
      triggerReason: 'Cookie consent dialog appeared',
      affordances,
      replanCount: 0,
    });

    expect(decision.shouldReplan).toBe(true);
    expect(decision.newSubgoals?.[0]?.category).toBe('RECOVER');
    expect((decision.newSubgoals?.[0]?.suggestedAction as any)?.target).toBe('btn-modal-close');
  });

  it('handles EMPTY_RESULTS by broadening the search query', () => {
    const graph = new SubgoalGraph('g1', [dummySubgoal]);
    const decision = DynamicReplanner.replan({
      graph,
      goal: dummyGoal,
      failedSubgoal: dummySubgoal,
      trigger: 'EMPTY_RESULTS',
      triggerReason: 'Zero product listings found',
      replanCount: 0,
    });

    expect(decision.shouldReplan).toBe(true);
    expect(decision.newSubgoals?.[0]?.category).toBe('SEARCH');
    expect(decision.newSubgoals?.[0]?.description).toContain('Revise search query to broader terms');
  });

  it('handles ACTION_NO_EFFECT by scheduling an observation scroll', () => {
    const graph = new SubgoalGraph('g1', [dummySubgoal]);
    const decision = DynamicReplanner.replan({
      graph,
      goal: dummyGoal,
      failedSubgoal: dummySubgoal,
      trigger: 'ACTION_NO_EFFECT',
      triggerReason: 'DOM unchanged after click',
      replanCount: 0,
    });

    expect(decision.shouldReplan).toBe(true);
    expect(decision.newSubgoals?.[0]?.suggestedAction?.action).toBe('scroll');
  });

  it('strictly bounds replanning attempts to maximum 3 replans', () => {
    const graph = new SubgoalGraph('g1', [dummySubgoal]);
    const decision = DynamicReplanner.replan({
      graph,
      goal: dummyGoal,
      failedSubgoal: dummySubgoal,
      trigger: 'ACTION_NO_EFFECT',
      triggerReason: 'Still unchanged',
      replanCount: 3, // Exceeds default limit
    });

    expect(decision.shouldReplan).toBe(false);
    expect(decision.reason).toContain('Exceeded maximum replanning limit');
  });
});
