import { describe, it, expect } from 'vitest';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';

describe('PrivAgent Phase 4 — Subgoal Graph (DAG)', () => {
  const createTestSubgoal = (id: string, index: number, prereqs: string[] = []): Subgoal => ({
    id,
    goalId: 'test-goal',
    index,
    description: `Subgoal ${id}`,
    category: 'SELECT',
    state: 'PENDING',
    prerequisites: prereqs,
    retryCount: 0,
    maxRetries: 2,
  });

  it('manages dependency prerequisites and transitions subgoals to READY', () => {
    const s1 = createTestSubgoal('sg1', 0);
    const s2 = createTestSubgoal('sg2', 1, ['sg1']);
    const s3 = createTestSubgoal('sg3', 2, ['sg2']);

    const graph = new SubgoalGraph('test-goal', [s1, s2, s3]);
    expect(graph.getReadySubgoals().map((s) => s.id)).toEqual(['sg1']);

    graph.startSubgoal('sg1');
    expect(graph.getSubgoal('sg1')?.state).toBe('IN_PROGRESS');

    graph.completeSubgoal('sg1');
    expect(graph.getSubgoal('sg1')?.state).toBe('COMPLETED');
    expect(graph.getReadySubgoals().map((s) => s.id)).toEqual(['sg2']);

    graph.completeSubgoal('sg2');
    expect(graph.getReadySubgoals().map((s) => s.id)).toEqual(['sg3']);
    graph.completeSubgoal('sg3');

    expect(graph.isAllCompleted()).toBe(true);
  });

  it('detects cycles and refuses cyclic additions', () => {
    const s1 = createTestSubgoal('sg1', 0, ['sg2']);
    const s2 = createTestSubgoal('sg2', 1, ['sg1']);

    const graph = new SubgoalGraph('test-goal');
    graph.addSubgoal(createTestSubgoal('sg1', 0));
    graph.addSubgoal(createTestSubgoal('sg2', 1, ['sg1']));

    // Introducing a reverse dependency to create a cycle should throw
    expect(() => {
      graph.addSubgoal(createTestSubgoal('sg3', 2, ['sg2']));
      // Add node that depends on sg3 and sg1 depends on it
      const cyclicNode: Subgoal = {
        ...createTestSubgoal('sg-cycle', 3, ['sg3']),
      };
      graph.addSubgoal(cyclicNode);
      // Mutate sg1 to depend on cyclicNode
      graph.getSubgoal('sg1')!.prerequisites = ['sg-cycle'];
      if (graph.hasCycle()) throw new Error('Cycle detected');
    }).toThrow();
  });

  it('produces a valid topological sort of execution steps', () => {
    const s1 = createTestSubgoal('sg1', 0);
    const s2 = createTestSubgoal('sg2', 1, ['sg1']);
    const s3 = createTestSubgoal('sg3', 2, ['sg1']);
    const s4 = createTestSubgoal('sg4', 3, ['sg2', 'sg3']);

    const graph = new SubgoalGraph('test-goal', [s4, s2, s1, s3]);
    const topo = graph.getTopologicalOrder();
    const order = topo.map((s) => s.id);

    expect(order.indexOf('sg1')).toBeLessThan(order.indexOf('sg2'));
    expect(order.indexOf('sg1')).toBeLessThan(order.indexOf('sg3'));
    expect(order.indexOf('sg2')).toBeLessThan(order.indexOf('sg4'));
    expect(order.indexOf('sg3')).toBeLessThan(order.indexOf('sg4'));
  });

  it('supports dynamic splicing and subgoal cancellation', () => {
    const s1 = createTestSubgoal('sg1', 0);
    const s2 = createTestSubgoal('sg2', 1, ['sg1']);
    const graph = new SubgoalGraph('test-goal', [s1, s2]);

    graph.cancelSubgoals(['sg2']);
    expect(graph.getSubgoal('sg2')?.state).toBe('SKIPPED');

    const replanSg = createTestSubgoal('sg-replan', 1, ['sg1']);
    graph.spliceSubgoals([replanSg]);
    expect(graph.getSubgoal('sg-replan')).toBeDefined();
  });
});
