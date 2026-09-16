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

  // 1. Critical risk or semantic rejection immediately blocks
  if (risk.riskLevel === 'CRITICAL' || !semantic.verified || !risk.allowed) {
    directive = 'BLOCK';
    explanation = risk.riskLevel === 'CRITICAL'
      ? 'Blocked: Action involves critical consequential financial or destructive operation.'
      : `Blocked: ${semantic.reason}`;
  }
  // 2. High risk or explicit confirmation requirement
  else if (risk.requiresConfirmation || risk.riskLevel === 'HIGH' || semantic.policyDecision === 'REQUIRE_CONFIRMATION') {
    directive = 'REQUIRE_CONFIRMATION';
    explanation = 'Action requires explicit user confirmation due to elevated consequential risk.';
  }
  // 3. Low risk benign operations auto-execute if verified and compositeScore >= 0.60
  else if (risk.riskLevel === 'LOW' && compositeScore >= 0.60) {
    directive = 'AUTO_EXECUTE';
    explanation = `Benign low-risk action (${compositeScore}) safe for autonomous execution.`;
  }
  // 4. Medium risk with moderate confidence requires confirmation
  else if (compositeScore < 0.85) {
    directive = 'REQUIRE_CONFIRMATION';
    explanation = `Confidence (${compositeScore}) on moderate-risk action is below autonomous threshold (0.85). Confirming with user.`;
  }
  // 5. High confidence auto-executes
  else {
    directive = 'AUTO_EXECUTE';
    explanation = `High confidence (${compositeScore}) and safe risk profile (${risk.riskLevel}). Authorized for autonomous execution.`;
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
