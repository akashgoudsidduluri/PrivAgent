/**
 * PrivAgent — Subgoal Selector (Phase 4.4)
 *
 * Deterministically selects the single highest-priority ready subgoal from the DAG,
 * taking into account current browser perception, affordance availability, and failure history.
 */

import { Subgoal } from './hierarchicalTypes';
import { SubgoalGraph } from './subgoalGraph';
import { BrowserWorldModel } from '../worldModel/types';
import { ActionAffordance } from '../semanticUnderstanding/semanticTypes';

export interface SubgoalSelectionResult {
  status: 'SELECTED' | 'ALL_COMPLETED' | 'BLOCKED' | 'NEEDS_REPLAN';
  selectedSubgoal?: Subgoal;
  reason: string;
}

export interface SubgoalSelectionContext {
  graph: SubgoalGraph;
  worldModel?: BrowserWorldModel;
  affordances?: ActionAffordance[];
  recentFailures?: Array<{ subgoalId: string; reason: string }>;
}

export class SubgoalSelector {
  /**
   * Selects the next subgoal to execute from the ready subgoals in the graph.
   */
  public static selectNextSubgoal(context: SubgoalSelectionContext): SubgoalSelectionResult {
    const { graph, worldModel, affordances = [], recentFailures = [] } = context;

    if (graph.isAllCompleted()) {
      return {
        status: 'ALL_COMPLETED',
        reason: 'All subgoals in the plan have reached COMPLETED or SKIPPED state.',
      };
    }

    const readySubgoals = graph.getReadySubgoals();
    if (readySubgoals.length === 0) {
      // Check if there are uncompleted subgoals that are stuck
      const allSubgoals = graph.getAllSubgoals();
      const pendingOrFailed = allSubgoals.filter(
        (sg) => sg.state === 'PENDING' || sg.state === 'FAILED'
      );

      if (pendingOrFailed.length > 0) {
        return {
          status: 'NEEDS_REPLAN',
          reason: `No subgoals are currently READY, but ${pendingOrFailed.length} subgoals remain uncompleted. Replanning is required.`,
        };
      }

      return {
        status: 'BLOCKED',
        reason: 'Subgoal execution is blocked with no ready candidates available.',
      };
    }

    // Filter out subgoals that recently failed and exceeded max retries
    const failureCounts = new Map<string, number>();
    for (const f of recentFailures) {
      failureCounts.set(f.subgoalId, (failureCounts.get(f.subgoalId) || 0) + 1);
    }

    const viableCandidates = readySubgoals.filter((sg) => {
      const fails = failureCounts.get(sg.id) || 0;
      return fails < sg.maxRetries;
    });

    if (viableCandidates.length === 0) {
      return {
        status: 'NEEDS_REPLAN',
        reason: 'All ready subgoals have reached their maximum failure limit. Dynamic replanning triggered.',
      };
    }

    // Score candidates based on topological index and semantic affordance alignment
    let bestCandidate: Subgoal = viableCandidates[0]!;
    let highestScore = -Infinity;

    for (const candidate of viableCandidates) {
      let score = 100 - candidate.index; // Earlier topological subgoals have baseline priority

      // Semantic boost if current affordances directly match expected action
      if (candidate.category === 'SEARCH') {
        const hasSearchAffordance = affordances.some(
          (a) => a.type === 'ENTER_QUERY' || a.type === 'SUBMIT_SEARCH'
        );
        if (hasSearchAffordance) score += 50;
      } else if (candidate.category === 'SELECT' || candidate.category === 'FILL') {
        const hasInputAffordance = affordances.some(
          (a) => a.type === 'FILL_FIELD' || a.type === 'SELECT_OPTION' || a.type === 'GENERIC_CLICK'
        );
        if (hasInputAffordance) score += 30;
      } else if (candidate.category === 'NAVIGATE') {
        // If already on a page with content, navigate is lower priority than interacting
        if (worldModel?.page?.url && worldModel.page.url !== 'about:blank') {
          score -= 20;
        }
      }

      // Penalize subgoals with previous failures in this cycle
      const failCount = failureCounts.get(candidate.id) || 0;
      score -= failCount * 40;

      if (score > highestScore) {
        highestScore = score;
        bestCandidate = candidate;
      }
    }

    return {
      status: 'SELECTED',
      selectedSubgoal: bestCandidate,
      reason: `Selected subgoal "${bestCandidate.description}" (ID: ${bestCandidate.id}) with priority score ${highestScore}.`,
    };
  }
}
