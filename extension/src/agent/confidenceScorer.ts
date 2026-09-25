/**
 * PrivAgent — Confidence-Aware Execution Scorer (Feature 6)
 *
 * Defines explainable confidence scoring and deterministic execution gating.
 *
 * Threshold Policy:
 *  - HIGH CONFIDENCE (>= 0.85) + LOW/MEDIUM RISK -> AUTO_EXECUTE
 *  - MEDIUM CONFIDENCE (0.60 - 0.84) -> REQUIRE_CONFIRMATION
 *  - HIGH RISK -> REQUIRE_CONFIRMATION (irrespective of confidence)
 *  - CRITICAL RISK or POLICY VIOLATION or LOW CONFIDENCE (< 0.60) -> BLOCK
 */

import { ActionRiskAssessment } from './riskEngine';
import { SemanticVerificationResult } from './semanticVerifier';

export type ExecutionDirective = 'AUTO_EXECUTE' | 'REQUIRE_CONFIRMATION' | 'BLOCK';

export interface ConfidenceEvaluation {
  confidenceScore: number; // 0.0 to 1.0
  directive: ExecutionDirective;
  explanation: string;
  factors: {
    semanticAlignmentScore: number;
    riskSafetyFactor: number;
    historicalReliability: number;
  };
}

export function evaluateExecutionConfidence(
  semantic: SemanticVerificationResult,
  risk: ActionRiskAssessment,
  consecutiveSuccessCount = 0
): ConfidenceEvaluation {
  // Factor 1: Semantic alignment (0.0 to 1.0)
  const semanticAlignmentScore = semantic.confidence;

  // Factor 2: Risk safety factor (inverse of risk score: 1.0 - risk.score)
  const riskSafetyFactor = Math.max(0.0, 1.0 - risk.score);

  // Factor 3: Historical reliability bonus (up to 0.10)
  const historicalReliability = Math.min(0.10, consecutiveSuccessCount * 0.03);

  // Weighted composite confidence score
  let compositeScore = (semanticAlignmentScore * 0.60) + (riskSafetyFactor * 0.35) + historicalReliability;
  compositeScore = Number(Math.min(Math.max(compositeScore, 0.0), 1.0).toFixed(2));

  let directive: ExecutionDirective = 'AUTO_EXECUTE';
  let explanation = '';

  // 1. Prohibited operation or unallowed risk immediately blocks
  if (!risk.allowed || (!semantic.verified && semantic.policyDecision !== 'REQUIRE_CONFIRMATION')) {
    directive = 'BLOCK';
    explanation = !risk.allowed
      ? (risk.rationale || 'Blocked: Action involves unauthorized protocol or prohibited operation.')
      : `Blocked: ${semantic.reason}`;
  }
  // 2. High/Critical risk or consequential action requires explicit user confirmation
  else if (risk.requiresConfirmation || risk.riskLevel === 'HIGH' || risk.riskLevel === 'CRITICAL' || semantic.policyDecision === 'REQUIRE_CONFIRMATION') {
    directive = 'REQUIRE_CONFIRMATION';
    explanation = risk.riskLevel === 'CRITICAL'
      ? 'Action requires explicit user confirmation: Critical consequential financial or destructive operation.'
      : 'Action requires explicit user confirmation due to elevated consequential risk.';
  }
  // 3. Verified safe operations auto-execute if compositeScore >= 0.70
  else if (compositeScore >= 0.70) {
    directive = 'AUTO_EXECUTE';
    explanation = `Benign action (${compositeScore}) safe for autonomous execution.`;
  }
  // 4. Low confidence requires confirmation
  else {
    directive = 'REQUIRE_CONFIRMATION';
    explanation = `Confidence (${compositeScore}) is below autonomous threshold (0.70). Confirming with user.`;
  }

  return {
    confidenceScore: compositeScore,
    directive,
    explanation,
    factors: {
      semanticAlignmentScore,
      riskSafetyFactor,
      historicalReliability,
    },
  };
}
