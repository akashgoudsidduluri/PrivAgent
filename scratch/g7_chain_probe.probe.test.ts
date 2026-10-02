/**
 * G7 Phase 2d — can the REAL planning chain reach SUCCESS for the canonical
 * task, independent of any provider?
 *
 * Runs the production decomposeTask → SubgoalGraph → SubgoalSelector →
 * GoalProgressTracker → verifyDestination → verifyTaskGoal modules against a
 * realistic LISTING observation. No mocks, no browser, no provider: this is a
 * pure determinism probe of whether the chain is even reachable.
 */
import { describe, it } from 'vitest';
import {
  decomposeTask,
  SubgoalGraph,
  SubgoalSelector,
  GoalProgressTracker,
} from '../extension/src/hierarchicalPlanning';
import { verifyTaskGoal } from '../extension/src/agent/goalVerifier';
import type { AgentContextPayload } from '../extension/src/privacy/types';

const TASK = 'open the store catalog';

function listingContext(pageGeneration: number): AgentContextPayload {
  return {
    url: 'http://localhost:4174/results.html?q=catalog',
    viewport: { width: 1280, height: 720, scroll_x: 0, scroll_y: 0 },
    detections: [],
    page_type: 'LISTING',
    semantic_context: {
      pageType: 'LISTING',
      pageGeneration,
      pageState: 'READY',
      confidence: 0.99,
      entities: [],
      affordances: [],
    },
  } as unknown as AgentContextPayload;
}

describe('G7 chain reachability probe', () => {
  it('reports the full deterministic chain outcome', () => {
    const decomp = decomposeTask(TASK, { currentUrl: 'http://localhost:4174/' });
    console.info('[g7] goalId=', decomp.goal.goalId);
    console.info(
      '[g7] subgoals=',
      JSON.stringify(
        decomp.subgoals.map((s) => ({
          id: s.id,
          category: s.category,
          desc: s.description,
          cond: (s as any).condition,
          destination: (s as any).destination,
          dependsOn: (s as any).dependsOn,
        })),
        null,
        1,
      ),
    );

    const graph = new SubgoalGraph(decomp.goal.goalId, decomp.subgoals);
    const sel = SubgoalSelector.selectNextSubgoal({
      graph,
      affordances: [],
      recentFailures: [],
    });
    console.info('[g7] selection=', sel.status, sel.selectedSubgoal?.id);

    // Observe the semantic destination arrival at generation 9.
    const ctx = listingContext(9);
    const active = sel.selectedSubgoal ?? decomp.subgoals[0];
    const v = GoalProgressTracker.verifySubgoalCondition(active, {
      context: ctx,
      previous: undefined,
      pageGeneration: 9,
      userConfirmedActionIds: [],
    });
    console.info('[g7] subgoalVerification=', JSON.stringify(v));

    const goal = verifyTaskGoal(
      TASK,
      {
        steps: [],
        currentUrl: ctx.url,
        pageType: 'LISTING',
        previousActions: [],
        candidateItems: [],
        currentFindings: [],
      } as any,
      ctx,
    );
    console.info('[g7] verifyTaskGoal=', JSON.stringify(goal));
  });
});
