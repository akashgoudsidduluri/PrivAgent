/**
 * PrivAgent — Dynamic Replanner (Phase 4.7 & 4.8)
 *
 * Provides context-aware, dynamic plan revision driven by real-time browser perception,
 * Phase 3 semantic understanding, available affordances, failure history, and user constraints.
 *
 * Core Principles:
 *  - NOT hardcoded to fixed workflows.
 *  - Uses current BrowserWorldModel, semantic page state, affordances, and observed effects.
 *  - Special-case handlers (LOGIN, MODAL, EMPTY RESULTS, STALE TARGET, ACTION_NO_EFFECT)
 *    generate/revise subgoals that are revalidated against current browser state.
 *  - Does NOT assume every login page means the user wants to log in. Authentication requires
 *    user confirmation, and credentials remain local.
 *  - Replanning is strictly bounded (max 3 replans).
 */

import {
  Subgoal,
  ReplanningTrigger,
  ReplanningDecision,
  DEFAULT_PLANNING_BOUNDS,
  PlanningBounds,
  HighLevelGoal,
} from './hierarchicalTypes';
import { SubgoalGraph } from './subgoalGraph';
import { BrowserWorldModel } from '../worldModel/types';
import { ActionAffordance, SemanticPageType } from '../semanticUnderstanding/semanticTypes';

export interface DynamicReplanningContext {
  graph: SubgoalGraph;
  goal: HighLevelGoal;
  failedSubgoal?: Subgoal;
  trigger: ReplanningTrigger;
  triggerReason: string;
  worldModel?: BrowserWorldModel;
  pageCategory?: SemanticPageType | string;
  affordances?: ActionAffordance[];
  previousEffect?: { changed: boolean; details?: string };
  replanCount: number;
  bounds?: PlanningBounds;
}

export class DynamicReplanner {
  /**
   * Evaluates current failure or page shift and produces a revised subgoal strategy.
   */
  public static replan(context: DynamicReplanningContext): ReplanningDecision {
    const {
      graph,
      goal,
      failedSubgoal,
      trigger,
      triggerReason,
      worldModel,
      pageCategory,
      affordances = [],
      replanCount,
      bounds = DEFAULT_PLANNING_BOUNDS,
    } = context;

    // 1. Strict Replanning Bounds Enforcement
    if (replanCount >= bounds.maxReplans) {
      return {
        triggeredBy: trigger,
        shouldReplan: false,
        reason: `Exceeded maximum replanning limit (${bounds.maxReplans} replans). Failing closed to prevent loop.`,
      };
    }

    const currentUrl = worldModel?.page?.url || '';
    const goalId = goal.goalId;

    // 2. Specialized Trigger Handlers (yielding revised subgoals that revalidate against browser state)

    switch (trigger) {
      case 'LOGIN_REQUIRED': {
        // Invariant: Do NOT assume user wants to automatically log in.
        // Prompt user for confirmation and keep credentials local on-device.
        const confirmLoginSg: Subgoal = {
          id: `${goalId}-replan-auth-confirm-${Date.now()}`,
          goalId,
          index: (failedSubgoal?.index || 0) + 0.1,
          category: 'CONFIRM',
          description: 'A login form was encountered. Request user confirmation before proceeding with local authentication.',
          expectedActionType: 'verify',
          state: 'READY',
          prerequisites: [],
          retryCount: 0,
          maxRetries: 1,
          verificationCondition: {
            type: 'USER_CONFIRMED',
            description: 'User confirmed login intent with local credentials',
          },
        };

        return {
          triggeredBy: trigger,
          shouldReplan: true,
          reason: 'Login encountered: Requesting user confirmation before proceeding with local authentication.',
          newSubgoals: [confirmLoginSg],
          requiresUserConfirmation: true,
          userConfirmationPrompt: `The target page (${currentUrl}) requires authentication. Would you like PrivAgent to proceed with local on-device login?`,
        };
      }

      case 'MODAL_INTERCEPTED': {
        // Modal / Overlay dialog intercepted user interaction
        // Look for dismiss / close affordance in current affordances
        const closeAffordance = affordances.find(
          (a) =>
            a.type === 'CANCEL_FORM' ||
            a.type === 'GENERIC_CLICK' ||
            /close|dismiss|agree|accept|cancel/i.test(a.description || '')
        );

        const dismissSg: Subgoal = {
          id: `${goalId}-replan-modal-${Date.now()}`,
          goalId,
          index: (failedSubgoal?.index || 0) - 0.1, // Insert right before current step
          category: 'RECOVER',
          description: closeAffordance
            ? `Dismiss intercepted modal using affordance "${closeAffordance.description}"`
            : 'Dismiss intercepted modal or overlay dialog',
          expectedActionType: 'click',
          state: 'READY',
          prerequisites: [],
          retryCount: 0,
          maxRetries: 2,
          targetEntity: closeAffordance?.targetElementId,
          suggestedAction: closeAffordance?.targetElementId
            ? { action: 'click', target: closeAffordance.targetElementId, reason: 'Dismissing modal dialog' }
            : undefined,
        };

        return {
          triggeredBy: trigger,
          shouldReplan: true,
          reason: 'Modal or cookie dialog detected: Inserting modal dismissal recovery subgoal.',
          newSubgoals: [dismissSg],
        };
      }

      case 'EMPTY_RESULTS': {
        // Search produced zero results. Broaden query or inspect alternate filter
        const originalQuery = failedSubgoal?.targetEntity || goal.targetEntities[0] || '';
        const broadenedQuery = originalQuery.split(' ').slice(0, 2).join(' ') || originalQuery;

        const revisedSearchSg: Subgoal = {
          id: `${goalId}-replan-search-${Date.now()}`,
          goalId,
          index: failedSubgoal?.index || 0,
          category: 'SEARCH',
          description: `Revise search query to broader terms "${broadenedQuery}" due to empty results`,
          expectedActionType: 'type',
          state: 'READY',
          prerequisites: [],
          retryCount: 0,
          maxRetries: 2,
          targetEntity: broadenedQuery,
        };

        return {
          triggeredBy: trigger,
          shouldReplan: true,
          reason: `Empty results for "${originalQuery}": Replanning with broader query "${broadenedQuery}".`,
          newSubgoals: [revisedSearchSg],
          subgoalsToCancel: failedSubgoal ? [failedSubgoal.id] : [],
        };
      }

      case 'STALE_TARGET': {
        // Target element was removed or mutated in the DOM
        const recoverySg: Subgoal = {
          id: `${goalId}-replan-reground-${Date.now()}`,
          goalId,
          index: failedSubgoal?.index || 0,
          category: 'LOCATE',
          description: `Re-perceive and re-ground target element for "${failedSubgoal?.description || 'current step'}"`,
          expectedActionType: 'inspect',
          state: 'READY',
          prerequisites: [],
          retryCount: 0,
          maxRetries: 2,
        };

        return {
          triggeredBy: trigger,
          shouldReplan: true,
          reason: `Stale target element in DOM (${triggerReason}): Triggering re-perception and re-grounding step.`,
          newSubgoals: [recoverySg],
        };
      }

      case 'ACTION_NO_EFFECT': {
        // Action succeeded dispatch but DOM/URL showed zero state change
        // Try gentle observation scroll or re-locating the element
        const scrollRecoverySg: Subgoal = {
          id: `${goalId}-replan-scroll-${Date.now()}`,
          goalId,
          index: (failedSubgoal?.index || 0) + 0.1,
          category: 'RECOVER',
          description: 'Perform observation scroll to settle lazy loading / dynamic viewport elements',
          expectedActionType: 'scroll',
          state: 'READY',
          prerequisites: [],
          retryCount: 0,
          maxRetries: 1,
          suggestedAction: {
            action: 'scroll',
            direction: 'down',
            amount: 250,
            reason: 'Observation scroll to settle page dynamic elements after no effect',
          },
        };

        return {
          triggeredBy: trigger,
          shouldReplan: true,
          reason: 'Action had no observable effect on DOM or state: Injecting observation scroll.',
          newSubgoals: [scrollRecoverySg],
        };
      }

      case 'POLICY_REJECTION':
      case 'EXECUTION_ERROR':
      default: {
        // General recovery: inspect current affordances to see if an alternative path exists
        const availableActionAffordance = affordances.find((a) => a.targetElementId);
        if (availableActionAffordance?.targetElementId && failedSubgoal) {
          const alternateSg: Subgoal = {
            id: `${goalId}-replan-alt-${Date.now()}`,
            goalId,
            index: failedSubgoal.index,
            category: 'SELECT',
            description: `Attempt alternative affordance "${availableActionAffordance.description || 'control'}" after failure: ${triggerReason}`,
            expectedActionType: 'click',
            state: 'READY',
            prerequisites: [],
            retryCount: 0,
            maxRetries: 1,
            targetEntity: availableActionAffordance.targetElementId,
          };

          return {
            triggeredBy: trigger,
            shouldReplan: true,
            reason: `Attempting alternative affordance following failure: ${triggerReason}`,
            newSubgoals: [alternateSg],
            subgoalsToCancel: [failedSubgoal.id],
          };
        }

        return {
          triggeredBy: trigger,
          shouldReplan: false,
          reason: `No viable replanning path available for trigger ${trigger}: ${triggerReason}`,
        };
      }
    }
  }
}
