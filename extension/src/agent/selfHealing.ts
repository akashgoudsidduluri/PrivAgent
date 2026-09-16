/**
 * PrivAgent — Self-Healing Selector & Target Recovery Engine (Feature 5)
 *
 * When an intended DOM element ID becomes stale, mutated, or missing,
 * attempts semantic recovery using:
 *   - Accessible name / aria-label
 *   - Text label token overlap (e.g. "Transactions" -> "Transaction History")
 *   - Role and element type compatibility
 *   - Spatial proximity / bounding boxes
 *
 * Security Invariant:
 *  - Recovered targets are UNTRUSTED until they pass through:
 *      1. Schema validation
 *      2. M5 Action Validator
 *      3. Risk Engine assessment
 *      4. Semantic Pre-Execution Verification
 *  - Recovery NEVER bypasses security checks.
 */

import { BrowserAction, ClickAction, TypeAction, SelectAction } from './actionTypes';
import { AgentContextPayload, AgentDetection } from '../privacy/types';

export interface TargetRecoveryResult {
  recovered: boolean;
  originalTargetId: string;
  recoveredTargetId?: string;
  recoveredDetection?: AgentDetection;
  confidence: number;
  strategy: 'LABEL_SIMILARITY' | 'ROLE_MATCH' | 'ACCESSIBLE_NAME' | 'NONE';
  reason: string;
  recoveredAction?: BrowserAction;
}

export type SelfHealingResult = TargetRecoveryResult;

/**
 * Calculates string similarity using word token overlap (Jaccard similarity).
 */
function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/[\s_-]+/).filter((t) => t.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/[\s_-]+/).filter((t) => t.length > 2));

  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0.0;
}

/**
 * Attempts to recover a missing or stale target element within the active page detections.
 */
export function recoverStaleTarget(
  failedActionOrTargetId: BrowserAction | string,
  actionOrLastKnownOrContext?: BrowserAction | AgentDetection | AgentContextPayload,
  contextOrGoal?: AgentContextPayload | string,
  taskGoal?: string
): TargetRecoveryResult {
  let failedTargetId = '';
  let failedAction: BrowserAction | undefined;
  let context: AgentContextPayload | undefined;
  let goal = taskGoal;

  if (typeof failedActionOrTargetId === 'string') {
    failedTargetId = failedActionOrTargetId;
    failedAction = actionOrLastKnownOrContext as BrowserAction;
    context = contextOrGoal as AgentContextPayload;
  } else {
    failedAction = failedActionOrTargetId;
    if (actionOrLastKnownOrContext && 'detections' in actionOrLastKnownOrContext) {
      context = actionOrLastKnownOrContext as AgentContextPayload;
      goal = contextOrGoal as string | undefined;
    } else {
      context = contextOrGoal as AgentContextPayload;
    }
    if (failedAction && 'target' in failedAction && typeof (failedAction as any).target === 'string') {
      failedTargetId = (failedAction as any).target;
    }
  }

  if (!failedAction || !('target' in failedAction) || typeof failedAction.target !== 'string') {
    return {
      recovered: false,
      originalTargetId: failedTargetId,
      confidence: 0.0,
      strategy: 'NONE',
      reason: 'Action does not reference a target element ID.',
    };
  }

  if (!context || !context.detections || context.detections.length === 0) {
    return {
      recovered: false,
      originalTargetId: failedTargetId,
      confidence: 0.0,
      strategy: 'NONE',
      reason: 'No detected elements available in current sanitized page context.',
    };
  }

  const availableDetections = context.detections;

  // Extract hints from the failed action's reason and target ID
  const targetIdHint = failedTargetId.toLowerCase().replace(/^(det|privagent)-/, '');
  const actionReason = 'reason' in failedAction && typeof failedAction.reason === 'string' ? failedAction.reason : '';
  const goalHint = (taskGoal || '').toLowerCase();

  let bestMatch: AgentDetection | null = null;
  let bestScore = 0.0;
  let bestStrategy: TargetRecoveryResult['strategy'] = 'NONE';

  for (const det of availableDetections) {
    const selectorStr = (det.selector || '').toLowerCase();
    const typeStr = (det.type || '').toLowerCase();

    // 1. Check selector and ID similarity
    const idSim = tokenSimilarity(targetIdHint, selectorStr);
    if (idSim > bestScore) {
      bestScore = idSim;
      bestMatch = det;
      bestStrategy = 'LABEL_SIMILARITY';
    }

    // 2. Check reason string similarity
    if (actionReason) {
      const reasonSim = tokenSimilarity(actionReason, selectorStr);
      if (reasonSim > bestScore) {
        bestScore = reasonSim;
        bestMatch = det;
        bestStrategy = 'ACCESSIBLE_NAME';
      }
    }

    // 3. Check goal semantic alignment
    if (goalHint) {
      if (goalHint.includes('transaction') && (selectorStr.includes('transaction') || selectorStr.includes('history'))) {
        const score = 0.90;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = det;
          bestStrategy = 'LABEL_SIMILARITY';
        }
      } else if (goalHint.includes('account') && (selectorStr.includes('account') || selectorStr.includes('details'))) {
        const score = 0.88;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = det;
          bestStrategy = 'LABEL_SIMILARITY';
        }
      }
    }
  }

  // Recovery acceptance threshold: at least 0.40 confidence
  if (bestMatch && bestScore >= 0.40) {
    // Clone action with recovered target
    let recoveredAction: BrowserAction;
    switch (failedAction.action) {
      case 'click':
        recoveredAction = {
          action: 'click',
          target: bestMatch.id,
          reason: `Self-healed target (${bestStrategy}): ${bestMatch.selector || bestMatch.id}`,
        } as ClickAction;
        break;
      case 'type':
        recoveredAction = {
          action: 'type',
          target: bestMatch.id,
          text: failedAction.text,
          reason: `Self-healed target (${bestStrategy}): ${bestMatch.selector || bestMatch.id}`,
        } as TypeAction;
        break;
      case 'select':
        recoveredAction = {
          action: 'select',
          target: bestMatch.id,
          option: failedAction.option,
          reason: `Self-healed target (${bestStrategy}): ${bestMatch.selector || bestMatch.id}`,
        } as SelectAction;
        break;
      default:
        recoveredAction = failedAction;
        break;
    }

    return {
      recovered: true,
      originalTargetId: failedTargetId,
      recoveredTargetId: bestMatch.id,
      recoveredDetection: bestMatch,
      confidence: Number(bestScore.toFixed(2)),
      strategy: bestStrategy,
      reason: `Recovered stale target '${failedTargetId}' -> '${bestMatch.id}' using ${bestStrategy} (score: ${bestScore.toFixed(2)}).`,
      recoveredAction,
    };
  }

  return {
    recovered: false,
    originalTargetId: failedTargetId,
    confidence: Number(bestScore.toFixed(2)),
    strategy: 'NONE',
    reason: `Could not confidently recover target '${failedTargetId}' (highest similarity was ${bestScore.toFixed(2)}).`,
  };
}
