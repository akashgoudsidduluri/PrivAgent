/**
 * G7 — CONSOLIDATED REPRODUCIBLE EVIDENCE.
 *
 * Runs the REAL production planning / destination / goal modules over the
 * canonical G7 task and prints the exact chain, stage by stage, so the single
 * blocking stage is unambiguous and reproducible.
 *
 * No mocks. No browser. No provider. This isolates the chain's reachability
 * from provider capacity.
 */
import { describe, it } from 'vitest';
import {
  decomposeTask,
  SubgoalGraph,
  SubgoalSelector,
  GoalProgressTracker,
} from '../extension/src/hierarchicalPlanning';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import { verifyTaskGoal } from '../extension/src/agent/goalVerifier';
import type { AgentContextPayload } from '../extension/src/privacy/types';

const TASK = 'open the store catalog';

function ctx(pageType: string, url: string, gen: number, conf: number): AgentContextPayload {
  return {
    url,
    viewport: { width: 1280, height: 720, scroll_x: 0, scroll_y: 0 },
    detections: [],
    page_type: pageType,
    semantic_context: {
      pageType,
      pageGeneration: gen,
      pageState: 'READY',
      confidence: conf,
      entities: [],
      affordances: [],
    },
  } as unknown as AgentContextPayload;
}

const log = (k: string, v: unknown) => console.info(`[G7] ${k}:`, JSON.stringify(v));

describe('G7 consolidated chain evidence', () => {
  it('runs the real chain stage by stage for the canonical task', () => {
    // ── Stage 1: decomposition
    const decomp = decomposeTask(TASK, { currentUrl: 'http://localhost:4174/' });
    const sg1 = decomp.subgoals[0]!;
    log('1_decompose_goalCategory', decomp.goal.taskCategory);
    log('1_sg1', {
      category: sg1.category,
      cond: (sg1 as any).verificationCondition?.type,
      destination: (sg1 as any).destination,
    });

    // ── Stage 2: planner selects the destination subgoal
    const graph = new SubgoalGraph(decomp.goal.goalId, decomp.subgoals);
    const sel = SubgoalSelector.selectNextSubgoal({ graph, affordances: [], recentFailures: [] });
    graph.startSubgoal(sel.selectedSubgoal!.id);
    log('2_selected', { status: sel.status, id: sel.selectedSubgoal!.id.split('-').pop() });

    // ── Stage 3: DestinationVerifier directly on a fresh LISTING observation
    const listing = ctx('LISTING', 'http://localhost:4174/results.html?q=catalog', 9, 0.99);
    const dv = verifyDestination({
      declaration: (sg1 as any).destination,
      observation: {
        url: listing.url,
        pageGeneration: 9,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 9 },
      },
      currentPageGeneration: 9,
    });
    log('3_destinationVerifier', dv);

    // ── Stage 4: GoalProgressTracker on the same observation
    const sub = GoalProgressTracker.verifySubgoalCondition(sg1, {
      context: listing,
      previous: undefined,
      pageGeneration: 9,
      userConfirmedActionIds: [],
    });
    log('4_subgoalVerification', sub);

    // ── Stage 5: planner marks it COMPLETE and progresses
    if (sub.satisfied) graph.completeSubgoal(sg1.id);
    const sel2 = SubgoalSelector.selectNextSubgoal({ graph, affordances: [], recentFailures: [] });
    log('5_plannerProgression', {
      sg1Status: graph.toData().subgoals[sg1.id]!.status,
      next: sel2.status === 'SELECTED' ? sel2.selectedSubgoal!.id.split('-').pop() : sel2.status,
    });

    // ── Stage 6: GoalVerifier — THE DECIDING STAGE
    const state: any = {
      steps: [],
      currentUrl: listing.url,
      pageType: 'LISTING',
      previousActions: [],
      candidateItems: [],
      currentFindings: [],
      currentPageGeneration: 9,
      subgoalGraphData: graph.toData(),
    };
    const goal = verifyTaskGoal(TASK, state, listing);
    log('6_GOALVERIFIER', goal);

    // ── Control: is the failure observation-dependent or structural?
    log('6b_wrongPage_ARTICLE', verifyTaskGoal(TASK, state, ctx('ARTICLE', 'http://localhost:4174/a.html', 9, 0.99)));
    log('6c_lowConf_LISTING', verifyTaskGoal(TASK, state, ctx('LISTING', listing.url, 9, 0.1)));
    log('6d_stale_gen', verifyTaskGoal(TASK, state, ctx('LISTING', listing.url, 3, 0.99)));
  });
});
