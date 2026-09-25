/**
 * PrivAgent — One-Action Proposal Planner (Phase 4.5)
 *
 * Enforces the strict single-action proposal constraint:
 * Exactly ONE atomic browser action can be proposed per planning cycle.
 *
 * Rejects compound actions, script batches, and chained proposals.
 * The proposed action must conform to the 5-action allowlist (click, type, scroll, select, navigate).
 */

import { BrowserAction, ActionType, SUPPORTED_ACTION_TYPES } from '../agent/actionTypes';
import { Subgoal } from './hierarchicalTypes';
import { AgentContextPayload } from '../privacy/types';

export interface ActionProposalResult {
  valid: boolean;
  action?: BrowserAction;
  error?: string;
}

export class OneActionPlanner {
  /**
   * Validates that an incoming proposal from reasoning contains exactly ONE atomic action.
   */
  public static validateSingleActionProposal(rawProposal: unknown): ActionProposalResult {
    if (!rawProposal || typeof rawProposal !== 'object') {
      return { valid: false, error: 'Proposal is empty or not an object.' };
    }

    // Reject array or batch proposals
    if (Array.isArray(rawProposal)) {
      return {
        valid: false,
        error: 'Batch or multiple actions are strictly forbidden. Only one atomic action is permitted.',
      };
    }

    const proposal = rawProposal as Record<string, unknown>;

    // Reject proposals that embed multiple actions or sub-actions
    if ('actions' in proposal || 'steps' in proposal || 'subActions' in proposal) {
      return {
        valid: false,
        error: 'Compound or nested action structures are rejected by one-action planner.',
      };
    }

    const actionType = proposal.action as ActionType;
    if (!actionType || !SUPPORTED_ACTION_TYPES.includes(actionType)) {
      return {
        valid: false,
        error: `Action "${String(proposal.action)}" is not a supported atomic browser action allowlist type.`,
      };
    }

    // Cast and validate specific atomic action fields
    switch (actionType) {
      case 'click': {
        if (!proposal.target || typeof proposal.target !== 'string') {
          return { valid: false, error: 'Click action requires a valid target element ID string.' };
        }
        return {
          valid: true,
          action: {
            action: 'click',
            target: proposal.target,
            reason: typeof proposal.reason === 'string' ? proposal.reason : undefined,
          },
        };
      }

      case 'type': {
        if (!proposal.target || typeof proposal.target !== 'string') {
          return { valid: false, error: 'Type action requires a valid target element ID string.' };
        }
        if (typeof proposal.text !== 'string') {
          return { valid: false, error: 'Type action requires a valid text string.' };
        }
        return {
          valid: true,
          action: {
            action: 'type',
            target: proposal.target,
            text: proposal.text,
            reason: typeof proposal.reason === 'string' ? proposal.reason : undefined,
          },
        };
      }

      case 'scroll': {
        const direction = proposal.direction;
        if (direction !== 'up' && direction !== 'down') {
          return { valid: false, error: 'Scroll direction must be "up" or "down".' };
        }
        const amount = Number(proposal.amount);
        if (isNaN(amount) || amount <= 0) {
          return { valid: false, error: 'Scroll amount must be a positive number.' };
        }
        return {
          valid: true,
          action: {
            action: 'scroll',
            direction,
            amount,
            reason: typeof proposal.reason === 'string' ? proposal.reason : undefined,
          },
        };
      }

      case 'select': {
        if (!proposal.target || typeof proposal.target !== 'string') {
          return { valid: false, error: 'Select action requires a valid target element ID string.' };
        }
        if (typeof proposal.option !== 'string') {
          return { valid: false, error: 'Select action requires a valid option string.' };
        }
        return {
          valid: true,
          action: {
            action: 'select',
            target: proposal.target,
            option: proposal.option,
            reason: typeof proposal.reason === 'string' ? proposal.reason : undefined,
          },
        };
      }

      case 'navigate': {
        if (!proposal.url || typeof proposal.url !== 'string') {
          return { valid: false, error: 'Navigate action requires a valid destination URL string.' };
        }
        return {
          valid: true,
          action: {
            action: 'navigate',
            url: proposal.url,
            reason: typeof proposal.reason === 'string' ? proposal.reason : undefined,
          },
        };
      }

      default:
        return { valid: false, error: `Unrecognized action type: ${String(actionType)}` };
    }
  }

  /**
   * Generates a candidate action proposal for a given subgoal when deterministic rules apply.
   */
  public static proposeSubgoalAction(
    subgoal: Subgoal,
    context?: AgentContextPayload
  ): BrowserAction | null {
    if (subgoal.suggestedAction) {
      return subgoal.suggestedAction;
    }

    if (subgoal.category === 'SEARCH' && subgoal.targetEntity) {
      // Find search input candidate
      const searchCandidate = context?.detections?.find(
        (el) =>
          el.type === 'search' ||
          el.type === 'input' ||
          (el.label && /search|find|query/i.test(el.label))
      );
      if (searchCandidate) {
        return {
          action: 'type',
          target: searchCandidate.id,
          text: subgoal.targetEntity,
          reason: `Typing search query for subgoal: ${subgoal.description}`,
        };
      }
    }

    return null;
  }
}
