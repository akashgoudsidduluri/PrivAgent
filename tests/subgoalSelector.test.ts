import { describe, it, expect } from 'vitest';
import { SubgoalSelector } from '../extension/src/hierarchicalPlanning/subgoalSelector';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import { ActionAffordance } from '../extension/src/semanticUnderstanding/semanticTypes';

describe('PrivAgent Phase 4 — Subgoal Selector', () => {
  it('selects the highest priority ready subgoal according to topological order', () => {
    const s1: Subgoal = {
      id: 'sg1',
      goalId: 'g1',
      index: 0,
      category: 'SEARCH',
      description: 'Search query',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };
    const s2: Subgoal = {
      id: 'sg2',
      goalId: 'g1',
      index: 1,
      category: 'SELECT',
      description: 'Select item',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };

    const graph = new SubgoalGraph('g1', [s1, s2]);
    const result = SubgoalSelector.selectNextSubgoal({ graph });
    expect(result.status).toBe('SELECTED');
    expect(result.selectedSubgoal?.id).toBe('sg1');
  });

  it('boosts candidates that match live page affordances', () => {
    const s1: Subgoal = {
      id: 'sg1',
      goalId: 'g1',
      index: 0,
      category: 'SELECT',
      description: 'Select something',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };
    const s2: Subgoal = {
      id: 'sg2',
      goalId: 'g1',
      index: 1,
      category: 'SEARCH',
      description: 'Search for item',
      state: 'READY',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };

    const graph = new SubgoalGraph('g1', [s1, s2]);
    const affordances: ActionAffordance[] = [
      {
        id: 'aff-search',
        type: 'ENTER_QUERY',
        targetElementId: 'search-input',
        confidence: 0.95,
        description: 'Search input',
        requiresConfirmation: false,
        pageGeneration: 1,
        source: 'layout',
      },
    ];

    const result = SubgoalSelector.selectNextSubgoal({ graph, affordances });
    expect(result.status).toBe('SELECTED');
    expect(result.selectedSubgoal?.id).toBe('sg2'); // boosted because search affordance is live
  });

  it('detects when all subgoals are completed', () => {
    const s1: Subgoal = {
      id: 'sg1',
      goalId: 'g1',
      index: 0,
      category: 'SEARCH',
      description: 'Done',
      state: 'COMPLETED',
      prerequisites: [],
      retryCount: 0,
      maxRetries: 2,
    };
    const graph = new SubgoalGraph('g1', [s1]);
    const result = SubgoalSelector.selectNextSubgoal({ graph });
    expect(result.status).toBe('ALL_COMPLETED');
  });

  it('diagnoses NEEDS_REPLAN when all ready subgoals exceeded retry limits', () => {
    const s1: Subgoal = {
      id: 'sg1',
      goalId: 'g1',
      index: 0,
      category: 'SEARCH',
      description: 'Failing',
      state: 'READY',
      prerequisites: [],
      retryCount: 2,
      maxRetries: 2,
    };
    const graph = new SubgoalGraph('g1', [s1]);
    const result = SubgoalSelector.selectNextSubgoal({
      graph,
      recentFailures: [
        { subgoalId: 'sg1', reason: 'fail 1' },
        { subgoalId: 'sg1', reason: 'fail 2' },
      ],
    });
    expect(result.status).toBe('NEEDS_REPLAN');
  });
});
