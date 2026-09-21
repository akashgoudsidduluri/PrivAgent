/**
 * PrivAgent — Planner Context Builder & Minimizer (Phase 4.14)
 *
 * Assembles a minimized, privacy-preserving context for the reasoning layer.
 *
 * Budget Rule:
 *  - Target <= 2 KB (2048 bytes).
 *  - If context exceeds the target, applies deterministic relevance ranking and minimization.
 *  - NEVER removes security-critical information (URL, category, constraints, active subgoal conditions)
 *    merely to satisfy the byte budget.
 *  - Strictly adheres to the M8 privacy/sanitization boundary.
 */

import { HighLevelGoal, Subgoal } from './hierarchicalTypes';
import { AgentContextPayload, AgentDetection } from '../privacy/types';
import { assertSanitizedContextSafe } from '../agent/privacyPolicy';

export interface PlannerContextResult {
  contextPayload: AgentContextPayload;
  byteSize: number;
  targetBudgetMet: boolean;
  trimmedElementsCount: number;
}

export const TARGET_PLANNER_CONTEXT_BUDGET_BYTES = 2048;

export class PlannerContextBuilder {
  /**
   * Builds and minimizes the planner context to target <= 2 KB without omitting security-critical data.
   */
  public static buildContext(
    baseContext: AgentContextPayload,
    goal: HighLevelGoal,
    activeSubgoal?: Subgoal,
    memoryHints?: import('../memory/memoryRetriever').MemoryHints
  ): PlannerContextResult {
    // 1. Verify privacy boundary safety
    assertSanitizedContextSafe(baseContext);

    // Deep copy detections to prevent mutating the original perception
    const candidateDetections: AgentDetection[] = baseContext.detections
      ? baseContext.detections.map((d) => ({ ...d }))
      : [];

    // 2. Score and rank detections deterministically based on active subgoal relevance
    const rankedDetections = this.rankDetections(candidateDetections, goal, activeSubgoal);

    // 3. Assemble initial context
    const currentContext: AgentContextPayload = {
      ...baseContext,
      detections: rankedDetections,
      ...(memoryHints ? { memory_hints: { ...memoryHints } } : {})
    };

    let serialized = JSON.stringify(currentContext);
    let byteSize = new TextEncoder().encode(serialized).length;
    let trimmedCount = 0;

    // 4. If budget exceeded, minimize low-relevance candidates while preserving security-critical fields
    if (byteSize > TARGET_PLANNER_CONTEXT_BUDGET_BYTES) {
      // First trim memory hints if they exist and we are over budget
      if (currentContext.memory_hints) {
        while (byteSize > TARGET_PLANNER_CONTEXT_BUDGET_BYTES && currentContext.memory_hints.semanticHints.length > 0) {
          currentContext.memory_hints.semanticHints.pop();
          serialized = JSON.stringify(currentContext);
          byteSize = new TextEncoder().encode(serialized).length;
        }
      }

      // Then trim detections
      if (byteSize > TARGET_PLANNER_CONTEXT_BUDGET_BYTES && currentContext.detections.length > 3) {
        // Keep at least top 3 detections; trim from the end of the ranked list
        while (byteSize > TARGET_PLANNER_CONTEXT_BUDGET_BYTES && currentContext.detections.length > 3) {
          currentContext.detections.pop();
          trimmedCount += 1;
          serialized = JSON.stringify(currentContext);
          byteSize = new TextEncoder().encode(serialized).length;
        }
      }
    }

    return {
      contextPayload: currentContext,
      byteSize,
      targetBudgetMet: byteSize <= TARGET_PLANNER_CONTEXT_BUDGET_BYTES,
      trimmedElementsCount: trimmedCount,
    };
  }

  /**
   * Deterministically scores and ranks detections based on relevance to the active subgoal.
   */
  private static rankDetections(
    detections: AgentDetection[],
    goal: HighLevelGoal,
    subgoal?: Subgoal
  ): AgentDetection[] {
    const targetTerms: string[] = [];
    if (subgoal?.targetEntity) targetTerms.push(subgoal.targetEntity.toLowerCase());
    for (const ent of goal.targetEntities) targetTerms.push(ent.toLowerCase());

    const expectedAction = subgoal?.expectedActionType;

    const scored = detections.map((det) => {
      let score = 0;
      const label = (det.label || '').toLowerCase();
      const type = (det.type || '').toLowerCase();

      // Action type alignment
      if (expectedAction === 'type' && (type === 'search' || type === 'input')) score += 50;
      if (expectedAction === 'click' && (type === 'button' || type === 'link')) score += 40;

      // Entity keyword matches
      for (const term of targetTerms) {
        if (term && (label.includes(term) || det.selector.toLowerCase().includes(term))) {
          score += 60;
        }
      }

      // Proximity / Primary role boost
      if (type === 'button' || type === 'search' || type === 'input') score += 10;

      return { det, score };
    });

    // Deterministic sort: descending by score, then ascending by element ID
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.det.id.localeCompare(b.det.id);
    });

    return scored.map((s) => s.det);
  }
}
