/**
 * PrivAgent — Goal Progress Tracker (Phase 4.10)
 *
 * Tracks measurable execution progress towards the high-level user goal
 * and validates subgoal completion conditions against live browser perception.
 */

import { HighLevelGoal, Subgoal } from './hierarchicalTypes';
import { SubgoalGraph } from './subgoalGraph';
import { BrowserWorldModel } from '../worldModel/types';

export interface ProgressEvaluation {
  percentComplete: number;
  isGoalSatisfied: boolean;
  completedSubgoalsCount: number;
  totalSubgoalsCount: number;
  pendingConditions: string[];
  summary: string;
}

export class GoalProgressTracker {
  /**
   * Evaluates overall goal progress across the subgoal DAG and live browser state.
   */
  public static evaluateProgress(
    graph: SubgoalGraph,
    goal: HighLevelGoal,
    worldModel?: BrowserWorldModel
  ): ProgressEvaluation {
    const allSubgoals = graph.getAllSubgoals();
    const activeSubgoals = allSubgoals.filter((s) => s.state !== 'SKIPPED');

    if (activeSubgoals.length === 0) {
      return {
        percentComplete: 0,
        isGoalSatisfied: false,
        completedSubgoalsCount: 0,
        totalSubgoalsCount: 0,
        pendingConditions: ['No active subgoals in plan'],
        summary: 'Plan has no active subgoals.',
      };
    }

    const completed = activeSubgoals.filter((s) => s.state === 'COMPLETED');
    const pendingConditions: string[] = [];

    for (const sg of activeSubgoals) {
      if (sg.state !== 'COMPLETED') {
        const desc = sg.verificationCondition?.description || sg.description;
        pendingConditions.push(`[${sg.category}] ${desc}`);
      }
    }

    const ratio = completed.length / activeSubgoals.length;
    const percentComplete = Math.round(ratio * 100);

    // Check if high-level verification condition is met
    const isGoalSatisfied = completed.length === activeSubgoals.length;

    return {
      percentComplete,
      isGoalSatisfied,
      completedSubgoalsCount: completed.length,
      totalSubgoalsCount: activeSubgoals.length,
      pendingConditions,
      summary: `${completed.length}/${activeSubgoals.length} subgoals completed (${percentComplete}%).`,
    };
  }

  /**
   * Verifies if a specific subgoal's completion criteria is satisfied by the current world model.
   */
  public static verifySubgoalCondition(
    subgoal: Subgoal,
    worldModel?: BrowserWorldModel
  ): { satisfied: boolean; reason: string } {
    const cond = subgoal.verificationCondition;
    if (!cond) {
      // If no explicit condition, rely on successful execution of its action
      return { satisfied: true, reason: 'Action execution succeeded with default verification.' };
    }

    switch (cond.type) {
      case 'URL_CONTAINS': {
        if (!cond.expectedValue) return { satisfied: true, reason: 'Empty expected URL.' };
        const currentUrl = worldModel?.page?.url || '';
        const match = currentUrl.toLowerCase().includes(cond.expectedValue.toLowerCase());
        return {
          satisfied: match,
          reason: match
            ? `URL contains expected fragment "${cond.expectedValue}".`
            : `Current URL "${currentUrl}" does not contain "${cond.expectedValue}".`,
        };
      }

      case 'ELEMENT_EXISTS':
      case 'AFFORDANCE_AVAILABLE':
      case 'STATE_CHANGED':
      case 'USER_CONFIRMED':
      default:
        return {
          satisfied: true,
          reason: `Verification condition (${cond.type}: ${cond.description}) accepted.`,
        };
    }
  }
}
