/**
 * PrivAgent — Memory Retriever (Phase 5)
 * Fetches relevant sanitized memory hints based on the current SiteScope
 * and orchestrates context minimization.
 */

import { SemanticMemoryManager, FailureMemoryManager, WorkingMemoryManager } from './memoryManager';
import { SiteScope } from './memoryTypes';

export interface MemoryHints {
  workingMemory: string[];
  semanticHints: string[];
  failureHints: string[];
  userPreferences: string[];
}

export class MemoryRetriever {
  /**
   * Retrieves deterministic, sanitized memory hints for the planner.
   * Ranks by trust level, confidence, and recency implicitly.
   */
  public static async getHintsForContext(scope: SiteScope, goalId: string): Promise<MemoryHints> {
    const hints: MemoryHints = {
      workingMemory: [],
      semanticHints: [],
      failureHints: [],
      userPreferences: [],
    };

    // 1. Working Memory (Scoped to current goal)
    const working = WorkingMemoryManager.readByGoal(goalId);
    hints.workingMemory = working.map(w => {
      const contentStr = typeof w.memoryContent === 'string'
        ? w.memoryContent
        : JSON.stringify(w.memoryContent, null, 1).replace(/\n/g, ' ');
      return `[Working] ${w.key}: ${contentStr}`;
    });

    // 2. Semantic Memory
    const semantic = await SemanticMemoryManager.findRelevant(scope);
    // Sort by TrustLevel (lower is better), then Confidence (higher is better)
    semantic.sort((a, b) => {
      if (a.trustLevel !== b.trustLevel) return a.trustLevel - b.trustLevel;
      return b.confidence - a.confidence;
    });

    for (const record of semantic) {
      if (record.type === 'USER_PREFERENCE') {
        hints.userPreferences.push(`[User Preference] ${record.memoryContent}`);
      } else {
        hints.semanticHints.push(`[Semantic Knowledge] ${record.key}: ${record.memoryContent}`);
      }
    }

    // 3. Failure Memory
    const failures = await FailureMemoryManager.findRelevant(scope);
    failures.sort((a, b) => b.createdAt - a.createdAt); // Most recent first
    
    for (const record of failures) {
      let hint = `[Past Failure] Type: ${record.failureType}, Context: ${record.contextCategory}`;
      if (record.recoveryAttempted) {
        hint += `, Recovery Strategy: ${record.recoveryAttempted}, Result: ${record.recoveryResult}`;
      }
      hints.failureHints.push(hint);
    }

    return hints;
  }
}
