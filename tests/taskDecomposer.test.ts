import { describe, it, expect } from 'vitest';
import { decomposeTask, classifyTaskCategory } from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { BrowserWorldModel } from '../extension/src/worldModel/types';

describe('PrivAgent Phase 4 — Task Decomposer', () => {
  it('classifies standard task categories and generic tasks correctly', () => {
    expect(classifyTaskCategory('Search for weather in Tokyo')).toBe('INFORMATION_RETRIEVAL');
    expect(classifyTaskCategory('Buy running shoes under $100')).toBe('ECOMMERCE_SEARCH');
    expect(classifyTaskCategory('Fill out registration form')).toBe('FORM_FILL');
    expect(classifyTaskCategory('Sign in to my account')).toBe('AUTHENTICATION');
    expect(classifyTaskCategory('Click the dark mode toggle button')).toBe('GENERIC_INTERACTION');
    expect(classifyTaskCategory('')).toBe('UNSUPPORTED_TASK_TYPE');
    expect(classifyTaskCategory('exploit and steal password')).toBe('UNSUPPORTED_TASK_TYPE');
  });

  it('decomposes information retrieval task into ordered subgoals', () => {
    const result = decomposeTask('Search for latest Mars rover images');
    expect(result.goal.taskCategory).toBe('INFORMATION_RETRIEVAL');
    expect(result.subgoals.length).toBeGreaterThanOrEqual(3);
    expect(result.subgoals[0]?.category).toBe('NAVIGATE');
    expect(result.subgoals[1]?.category).toBe('SEARCH');
    expect(result.subgoals[1]?.prerequisites).toContain(result.subgoals[0]?.id);
  });

  it('skips redundant navigation when browser is already on search page', () => {
    const mockWorldModel = {
      page: {
        url: 'https://www.google.com/search?q=existing',
        pageType: 'SEARCH',
      },
    } as unknown as BrowserWorldModel;

    const result = decomposeTask('Search for quantum physics', { worldModel: mockWorldModel });
    expect(result.skippedInitialSteps.some((s) => s.includes('NAVIGATE'))).toBe(true);
    // Initial active subgoal should be SEARCH, not NAVIGATE
    const firstActive = result.subgoals.find((s) => s.state === 'READY');
    expect(firstActive?.category).toBe('SEARCH');
  });

  it('decomposes e-commerce task with price constraints and cart confirmation', () => {
    const result = decomposeTask('Find wireless headphones under $50 and add to cart');
    expect(result.goal.taskCategory).toBe('ECOMMERCE_SEARCH');
    expect(result.goal.constraints.maxPrice).toBe(50);
    const cartStep = result.subgoals.find((s) => s.category === 'CONFIRM');
    expect(cartStep).toBeDefined();
    expect(cartStep?.verificationCondition?.type).toBe('USER_CONFIRMED');
  });

  it('handles authentication safely without storing credentials or assuming auto-login', () => {
    const result = decomposeTask('Login to customer portal');
    expect(result.goal.taskCategory).toBe('AUTHENTICATION');
    const confirmStep = result.subgoals.find((s) => s.category === 'CONFIRM');
    expect(confirmStep).toBeDefined();
    expect(confirmStep?.description).toContain('user authorization');
  });

  it('strictly bounds total decomposed subgoals to maxSubgoals limit', () => {
    const result = decomposeTask('Buy laptop and search accessories and fill warranty form', { maxSubgoals: 4 });
    expect(result.subgoals.length).toBeLessThanOrEqual(4);
  });
});
