/**
 * PrivAgent — Multi-Signal Semantic Target Grounding Engine (M10)
 *
 * Authoritative local gatekeeper determining whether a reasoner-proposed
 * target corresponds to an observable, valid, enabled live DOM element.
 *
 * Invariants:
 *  1. NEVER trust the LLM target blindly.
 *  2. Multi-signal matching: ID, role, accessible label, type, selector, bbox, visibility.
 *  3. Page generation guard: Expired generations immediately fail as STALE_TARGET.
 *  4. Action/element compatibility: Type mismatch (e.g. typing into a button) fails as TARGET_MISMATCH.
 *  5. Confidence threshold: Targets below minimum confidence are rejected for fresh perception.
 */

import { DetectionResult, AgentDetection } from '../privacy/types';
import { BrowserAction, ActionType } from './actionTypes';

export type GroundingFailureReason =
  | 'STALE_TARGET'
  | 'TARGET_MISMATCH'
  | 'ELEMENT_NOT_FOUND'
  | 'INSUFFICIENT_CONFIDENCE'
  | 'DISABLED_OR_HIDDEN'
  | 'UNAUTHORIZED_ORIGIN';

export interface GroundingSignals {
  idMatch: boolean;
  labelScore: number;
  typeCompatible: boolean;
  visibilityValid: boolean;
  generationValid: boolean;
}

export interface GroundingResult {
  grounded: boolean;
  targetId?: string;
  matchedDetection?: DetectionResult | AgentDetection;
  confidence: number;
  failureReason?: GroundingFailureReason;
  signals?: GroundingSignals;
  details: string;
}

type AnyDetection = DetectionResult | AgentDetection;

/**
 * Normalizes strings for robust fuzzy comparison.
 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Computes simple token overlap score between two strings (0.0 to 1.0).
 */
function computeTokenOverlap(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;
  if (normA.includes(normB) || normB.includes(normA)) return 0.85;

  const tokensA = new Set(normA.split(' ').filter(t => t.length > 2));
  const tokensB = new Set(normB.split(' ').filter(t => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let matches = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) matches++;
  }
  return matches / Math.max(tokensA.size, tokensB.size);
}

/**
 * Check if the browser action type is compatible with the element detection type.
 */
function isActionCompatibleWithType(actionType: ActionType, detectionType: string): boolean {
  switch (actionType) {
    case 'click':
      return (
        detectionType === 'button' ||
        detectionType === 'link' ||
        detectionType === 'element' ||
        detectionType === 'search' ||
        detectionType === 'select' ||
        detectionType === 'input'
      );
    case 'type':
      return (
        detectionType === 'input' ||
        detectionType === 'search' ||
        detectionType === 'password' ||
        detectionType === 'element'
      );
    case 'select':
      return detectionType === 'select' || detectionType === 'input' || detectionType === 'element';
    case 'scroll':
    case 'navigate':
      return true;
    default:
      return false;
  }
}

/**
 * Extract bbox dimensions safely from either DetectionResult or AgentDetection format.
 */
function getBBoxDimensions(det: AnyDetection): { width: number; height: number } {
  if (Array.isArray(det.bbox)) {
    return { width: det.bbox[2], height: det.bbox[3] };
  }
  if (typeof det.bbox === 'object' && det.bbox !== null) {
    const b = det.bbox as { width?: number; height?: number };
    return { width: b.width ?? 0, height: b.height ?? 0 };
  }
  return { width: 0, height: 0 };
}

/**
 * Authoritatively ground a proposed browser action against live perception detections.
 */
export function groundProposedTarget(
  action: BrowserAction,
  detections: AnyDetection[],
  options: {
    currentPageGeneration?: number;
    actionPageGeneration?: number;
    confidenceThreshold?: number;
    currentOrigin?: string;
  } = {}
): GroundingResult {
  // Actions that don't target specific DOM elements (scroll, navigate) are inherently grounded
  if (action.action === 'scroll' || action.action === 'navigate') {
    return {
      grounded: true,
      confidence: 1.0,
      details: `Action '${action.action}' does not require element target grounding.`,
    };
  }

  const rawTarget = action.target?.trim() || '';
  if (!rawTarget) {
    return {
      grounded: false,
      confidence: 0,
      failureReason: 'ELEMENT_NOT_FOUND',
      details: `Action '${action.action}' requires a non-empty target element ID.`,
    };
  }

  const currentGen = options.currentPageGeneration ?? 0;
  const actionGen = options.actionPageGeneration ?? currentGen;
  const threshold = options.confidenceThreshold ?? 0.65;

  // 1a. Origin Isolation Guard
  if (options.currentOrigin) {
    const actionOrigin = (action as any).targetOrigin || (action as any).origin;
    if (actionOrigin && actionOrigin !== options.currentOrigin) {
      return {
        grounded: false,
        confidence: 0,
        failureReason: 'UNAUTHORIZED_ORIGIN',
        signals: {
          idMatch: false,
          labelScore: 0,
          typeCompatible: false,
          visibilityValid: false,
          generationValid: true,
        },
        details: `Action origin '${actionOrigin}' does not match current origin '${options.currentOrigin}'. Cross-origin execution blocked.`,
      };
    }
  }

  // 1. Generation Lifecycle Guard
  if (actionGen < currentGen) {
    return {
      grounded: false,
      confidence: 0,
      failureReason: 'STALE_TARGET',
      signals: {
        idMatch: false,
        labelScore: 0,
        typeCompatible: false,
        visibilityValid: false,
        generationValid: false,
      },
      details: `Target was generated for page generation ${actionGen}, but current page is at generation ${currentGen}. Stale target rejected.`,
    };
  }

  // 2. Exact ID Search
  const exactMatch = detections.find(d => d.id === rawTarget);

  if (exactMatch) {
    if (options.currentOrigin && (exactMatch as any).origin && (exactMatch as any).origin !== options.currentOrigin) {
      return {
        grounded: false,
        confidence: 0,
        failureReason: 'UNAUTHORIZED_ORIGIN',
        matchedDetection: exactMatch,
        signals: {
          idMatch: true,
          labelScore: 1.0,
          typeCompatible: true,
          visibilityValid: true,
          generationValid: true,
        },
        details: `Target element '${rawTarget}' belongs to origin '${(exactMatch as any).origin}', not current origin '${options.currentOrigin}'. Cross-origin execution blocked.`,
      };
    }

    const compatible = isActionCompatibleWithType(action.action, exactMatch.type);
    const { width, height } = getBBoxDimensions(exactMatch);
    const visible = width > 0 && height > 0;

    if (!compatible) {
      return {
        grounded: false,
        confidence: 0.2,
        failureReason: 'TARGET_MISMATCH',
        matchedDetection: exactMatch,
        signals: {
          idMatch: true,
          labelScore: 1.0,
          typeCompatible: false,
          visibilityValid: visible,
          generationValid: true,
        },
        details: `Action '${action.action}' is incompatible with target element '${rawTarget}' of type '${exactMatch.type}'.`,
      };
    }

    if (!visible) {
      return {
        grounded: false,
        confidence: 0.3,
        failureReason: 'DISABLED_OR_HIDDEN',
        matchedDetection: exactMatch,
        signals: {
          idMatch: true,
          labelScore: 1.0,
          typeCompatible: true,
          visibilityValid: false,
          generationValid: true,
        },
        details: `Target element '${rawTarget}' has zero dimensions (width: ${width}, height: ${height}) and is not interactable.`,
      };
    }

    return {
      grounded: true,
      targetId: exactMatch.id,
      matchedDetection: exactMatch,
      confidence: 1.0,
      signals: {
        idMatch: true,
        labelScore: 1.0,
        typeCompatible: true,
        visibilityValid: true,
        generationValid: true,
      },
      details: `Exact grounded match for element ID '${rawTarget}' (${exactMatch.type}).`,
    };
  }

  // 3. Multi-signal semantic matching (fallback for descriptive / fuzzy targets)
  let bestCandidate: AnyDetection | null = null;
  let bestScore = 0;
  let bestSignals: GroundingSignals = {
    idMatch: false,
    labelScore: 0,
    typeCompatible: false,
    visibilityValid: false,
    generationValid: true,
  };

  for (const det of detections) {
    const compatible = isActionCompatibleWithType(action.action, det.type);
    if (!compatible) continue;

    const { width, height } = getBBoxDimensions(det);
    const visible = width > 0 && height > 0;
    if (!visible) continue;

    const label = det.label || '';
    const labelScore = computeTokenOverlap(rawTarget, label);
    const idScore = computeTokenOverlap(rawTarget, det.id);
    const selectorScore = det.selector ? computeTokenOverlap(rawTarget, det.selector) : 0;

    const compositeScore = Math.max(labelScore, idScore, selectorScore * 0.8);

    if (compositeScore > bestScore) {
      bestScore = compositeScore;
      bestCandidate = det;
      bestSignals = {
        idMatch: false,
        labelScore,
        typeCompatible: compatible,
        visibilityValid: visible,
        generationValid: true,
      };
    }
  }

  if (bestCandidate && bestScore >= threshold) {
    return {
      grounded: true,
      targetId: bestCandidate.id,
      matchedDetection: bestCandidate,
      confidence: Number(bestScore.toFixed(2)),
      signals: bestSignals,
      details: `Semantic grounding matched proposed target '${rawTarget}' to live element '${bestCandidate.id}' (confidence: ${(bestScore * 100).toFixed(0)}%).`,
    };
  }

  // 4. Grounding failure
  return {
    grounded: false,
    confidence: Number(bestScore.toFixed(2)),
    failureReason: bestCandidate ? 'INSUFFICIENT_CONFIDENCE' : 'ELEMENT_NOT_FOUND',
    signals: bestSignals,
    details: `Target '${rawTarget}' could not be grounded in the live DOM (best confidence: ${(bestScore * 100).toFixed(0)}%, required: ${(threshold * 100).toFixed(0)}%).`,
  };
}
