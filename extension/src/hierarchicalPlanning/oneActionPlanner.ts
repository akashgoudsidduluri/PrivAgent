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
          action: proposal as unknown as BrowserAction,
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
          action: proposal as unknown as BrowserAction,
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
          action: proposal as unknown as BrowserAction,
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
          action: proposal as unknown as BrowserAction,
        };
      }

      case 'navigate': {
        if (!proposal.url || typeof proposal.url !== 'string') {
          return { valid: false, error: 'Navigate action requires a valid destination URL string.' };
        }
        return {
          valid: true,
          action: proposal as unknown as BrowserAction,
        };
      }

      case 'pressKey': {
        // Phase 11 shape validation only. The SAFE-KEY allowlist is enforced by
        // the authoritative M5 validator, which runs after the planner.
        if (!proposal.key || typeof proposal.key !== 'string') {
          return { valid: false, error: 'PressKey action requires a valid key string.' };
        }
        if (proposal.target !== undefined && typeof proposal.target !== 'string') {
          return { valid: false, error: 'PressKey target must be a string element ID when provided.' };
        }
        return {
          valid: true,
          action: proposal as unknown as BrowserAction,
        };
      }

      default:
        return { valid: false, error: `Unrecognized action type: ${String(actionType)}` };
    }
  }

  /**
   * POST-17.10 Step 9 — deterministic navigation for an EXPLICITLY DECLARED
   * destination URL.
   *
   * Step 9's audit found that 100% of actions come from the reasoner: this class
   * had no production caller at all, and `proposeSubgoalAction` returns `null`
   * for any NAVIGATE subgoal, so a destination subgoal could only ever be
   * "reached" by whatever URL the model happened to guess.
   *
   * When the user named the destination as a URL — "open
   * http://localhost:4174/results.html" — that URL is not a guess, and letting
   * the model re-derive it is strictly worse. This proposes it verbatim.
   *
   * DELIBERATE LIMITS — this must not become a way to invent a URL:
   *
   *  - It fires ONLY when the declaration carries `url` (an EXPLICIT destination
   *    URL the user typed). A `role`-only declaration has NO url and returns
   *    `null`, so a role destination can never be "navigated to" by fabricating
   *    a path. Reaching a LISTING page is a discovery problem, not a URL
   *    problem, and it stays with the reasoner.
   *  - It ignores `entryUrl` entirely. The entry site is where the browser
   *    STARTS; turning it into a destination URL is exactly the conflation
   *    Steps 5–8 removed.
   *  - It normalizes nothing and appends nothing. The declared
   *    origin+path is what the verifier will later compare exactly, so proposing
   *    anything else would make arrival unverifiable.
   *  - It proposes an action. It does NOT assert arrival. Completion remains
   *    `verifyDestination`'s exclusive decision on a fresh observation.
   *
   * `reason` is device-local metadata for the local gates; it never reaches the
   * reasoner. It begins with an action verb so the same prose heuristic that
   * gates model-emitted reasons cannot over-block it.
   */
  public static proposeDestinationNavigation(subgoal: Subgoal | undefined): BrowserAction | null {
    if (!subgoal) return null;
    if (subgoal.expectedActionType !== 'navigate') return null;

    const declaration = subgoal.destination;
    if (!declaration || declaration.kind !== 'DECLARED') return null;

    const declared = declaration.url;
    if (!declared) return null;

    return {
      action: 'navigate',
      url: `${declared.origin}${declared.path}`,
      reason: `Navigating to the destination URL declared in the user request for subgoal ${subgoal.id}.`,
    };
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
