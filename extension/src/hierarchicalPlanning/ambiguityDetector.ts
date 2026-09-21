/**
 * PrivAgent — Ambiguity Detector & Disambiguation Prompts (Phase 4.11)
 *
 * Identifies underspecified user instructions, conflicting target candidates,
 * or high-impact branching choices, prompting the user for clarification rather than
 * making unvalidated autonomous assumptions.
 */

import { HighLevelGoal, Subgoal } from './hierarchicalTypes';
import { AgentContextPayload } from '../privacy/types';

export interface AmbiguityDetectionResult {
  isAmbiguous: boolean;
  reason?: string;
  candidateOptions?: string[];
  suggestedPrompt?: string;
}

export class AmbiguityDetector {
  /**
   * Checks if a user goal or active subgoal is ambiguous in the context of current browser candidates.
   */
  public static checkAmbiguity(
    goal: HighLevelGoal,
    activeSubgoal?: Subgoal,
    context?: AgentContextPayload
  ): AmbiguityDetectionResult {
    const rawLower = goal.rawUserPrompt.toLowerCase();

    // 1. Check for underspecified purchase or deletion intent without explicit product or item
    const hasVagueAction = /^(buy|purchase|delete|remove|checkout|order)\s+(it|this|that|them|something|anything)/i.test(rawLower);
    if (hasVagueAction) {
      return {
        isAmbiguous: true,
        reason: 'The action references a vague target ("it" / "this") without identifying which item.',
        suggestedPrompt: 'Could you specify exactly which product or item you would like to select?',
      };
    }

    // 2. Check for conflicting candidates on page during SELECT subgoal
    if (activeSubgoal?.category === 'SELECT' && context?.detections) {
      const candidates = context.detections.filter((el) => {
        if (!activeSubgoal.targetEntity) return false;
        const target = activeSubgoal.targetEntity.toLowerCase();
        return el.label?.toLowerCase().includes(target);
      });

      // If multiple candidates match equally without clear constraints
      if (candidates.length > 3 && Object.keys(goal.constraints).length === 0) {
        const candidateNames = candidates.slice(0, 3).map((c) => c.label || c.id);
        return {
          isAmbiguous: true,
          reason: `Found ${candidates.length} matching items on the page with no specific filter or price constraint specified.`,
          candidateOptions: candidateNames,
          suggestedPrompt: `There are multiple items matching "${activeSubgoal.targetEntity}". Which one would you prefer? Options include: ${candidateNames.join(', ')}`,
        };
      }
    }

    return { isAmbiguous: false };
  }
}
