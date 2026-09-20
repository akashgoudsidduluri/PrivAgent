/**
 * PrivAgent — Deterministic Risk-Aware Action Engine (Feature 1)
 *
 * Implements authoritative, deterministic pre-execution risk assessment for all
 * proposed browser actions.
 *
 * Invariant:
 *  - Remote LLM reasoning is untrusted; the LLM NEVER chooses its own risk level.
 *  - Every action receives a structured 4-tier risk assessment before execution.
 *  - High/Critical risk actions are strictly gated or blocked.
 *  - Zero raw PII values are ever accepted, stored, or emitted.
 */

import { BrowserAction } from './actionTypes';
import { AgentContextPayload, AgentDetection, SensitiveEntityType } from '../privacy/types';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ActionRiskAssessment {
  riskLevel: RiskLevel;
  level: RiskLevel;
  score: number; // 0.0 to 1.0 (normalized risk score)
  reasons: string[];
  rationale: string;
  requiresConfirmation: boolean;
  requiresUserConfirmation: boolean;
  allowed: boolean;
  riskFactors: {
    actionTypeRisk: RiskLevel;
    targetSensitivityRisk: RiskLevel;
    consequentialImpactRisk: RiskLevel;
    navigationRisk: RiskLevel;
    destructivenessRisk: RiskLevel;
  };
}

// Consequential keywords that indicate financial impact, mutation, or checkout
const CONSEQUENTIAL_KEYWORDS = [
  'pay', 'payment', 'transfer', 'buy', 'order', 'purchase',
  'checkout', 'withdraw', 'subscribe', 'charge', 'authorise', 'authorize',
  'submit', 'delete', 'remove', 'destroy', 'terminate', 'cancel subscription',
  'reset', 'update password', 'change password', 'send money',
];

// Reversible or non-destructive keywords
const SAFE_KEYWORDS = [
  'view', 'inspect', 'open', 'details', 'history', 'expand', 'collapse',
  'scroll', 'read', 'next', 'previous', 'filter', 'search', 'find',
  'show', 'select', 'tab', 'menu',
];

// Sensitive target categories that escalate risk
const SENSITIVE_CATEGORIES: ReadonlySet<SensitiveEntityType> = new Set([
  'password', 'cvv', 'otp', 'pan', 'credit_card', 'account_number', 'address',
]);

/**
 * Deterministically calculates the risk assessment for a proposed browser action.
 */
export function assessActionRisk(
  action: BrowserAction,
  context: AgentContextPayload,
  currentUrl?: string
): ActionRiskAssessment {
  const reasons: string[] = [];
  let score = 0.05; // Base minimal score

  // 1. Action Type Base Risk
  let actionTypeRisk: RiskLevel = 'LOW';
  switch (action.action) {
    case 'scroll':
      actionTypeRisk = 'LOW';
      score += 0.05;
      reasons.push('Scrolling is a reversible observation action.');
      break;
    case 'select':
      actionTypeRisk = 'MEDIUM';
      score += 0.20;
      reasons.push('Select modifies an active form or filter selection.');
      break;
    case 'type':
      actionTypeRisk = 'MEDIUM';
      score += 0.25;
      reasons.push("Type inputs text into an interactive element.");
      break;
    case 'click':
      actionTypeRisk = 'LOW'; // May escalate based on target
      score += 0.15;
      break;
    case 'navigate':
      actionTypeRisk = 'MEDIUM'; // May escalate to CRITICAL based on origin
      score += 0.30;
      break;
  }

  // 2. Target Sensitivity Risk
  let targetSensitivityRisk: RiskLevel = 'LOW';
  let targetDet: AgentDetection | undefined;

  if ('target' in action && typeof action.target === 'string') {
    targetDet = context.detections.find((d) => d.id === action.target);

    if (targetDet) {
      if (SENSITIVE_CATEGORIES.has(targetDet.type)) {
        if (action.action === 'type' || action.action === 'select') {
          targetSensitivityRisk = 'HIGH';
          score += 0.40;
          reasons.push(`Target is a protected sensitive field (${targetDet.type}) being modified.`);
        } else {
          // Clicking or viewing an in-page element is low-risk observation/expansion
          targetSensitivityRisk = 'LOW';
          score += 0.05;
          reasons.push(`Target relates to sensitive category (${targetDet.type}).`);
        }
      } else if (targetDet.type === 'email' || targetDet.type === 'phone' || targetDet.type === 'person_name') {
        if (action.action === 'type' || action.action === 'select') {
          targetSensitivityRisk = 'MEDIUM';
          score += 0.20;
          reasons.push(`Target is a contact identifier field (${targetDet.type}) being modified.`);
        } else {
          targetSensitivityRisk = 'LOW';
          score += 0.05;
          reasons.push(`Target relates to contact identifier (${targetDet.type}).`);
        }
      }
    }
  }

  // 3. Consequential Impact & Financial Risk
  let consequentialImpactRisk: RiskLevel = 'LOW';
  const targetDescriptor = [
    targetDet?.selector || '',
    'reason' in action && typeof action.reason === 'string' ? action.reason : '',
    action.action === 'navigate' ? action.url : '',
  ].join(' ').toLowerCase();

  const isSearchAction =
    targetDescriptor.includes('search') ||
    targetDescriptor.includes('filter') ||
    targetDescriptor.includes('query');

  const isConsequential = CONSEQUENTIAL_KEYWORDS.some((kw) => {
    if (kw === 'submit' && isSearchAction) {
      return false; // Submitting search queries is non-destructive exploration
    }
    return targetDescriptor.includes(kw);
  });
  if (isConsequential) {
    const isFinancialOrDestructive = [
      'pay', 'transfer', 'buy', 'purchase', 'delete', 'checkout', 'send money'
    ].some((kw) => targetDescriptor.includes(kw));

    if (isFinancialOrDestructive) {
      consequentialImpactRisk = 'CRITICAL';
      score += 0.55;
      reasons.push('Action executes a consequential financial or destructive operation.');
    } else {
      consequentialImpactRisk = 'HIGH';
      score += 0.35;
      reasons.push('Action performs consequential state change or form submission.');
    }
  }

  // 4. Navigation & Cross-Origin Risk
  let navigationRisk: RiskLevel = 'LOW';
  if (action.action === 'navigate') {
    try {
      const dest = new URL(action.url);
      const curr = currentUrl ? new URL(currentUrl) : null;

      if (dest.protocol !== 'http:' && dest.protocol !== 'https:') {
        navigationRisk = 'CRITICAL';
        score = 1.0;
        reasons.push(`Prohibited navigation protocol: '${dest.protocol}'. Non-web protocols are blocked.`);
      } else if (curr && dest.origin !== curr.origin) {
        navigationRisk = 'HIGH';
        score += 0.35;
        reasons.push(`Cross-origin navigation from ${curr.origin} to ${dest.origin}.`);
      } else {
        reasons.push(`In-origin navigation to ${dest.pathname}.`);
      }
    } catch {
      navigationRisk = 'CRITICAL';
      score = 1.0;
      reasons.push(`Malformed navigation destination URL: '${action.url}'.`);
    }
  }

  // 5. Destructiveness & Reversibility Risk
  let destructivenessRisk: RiskLevel = 'LOW';
  if (targetDescriptor.includes('delete') || targetDescriptor.includes('destroy') || targetDescriptor.includes('remove')) {
    destructivenessRisk = 'CRITICAL';
    score += 0.50;
    reasons.push('Action is irreversible / destructive.');
  }

  // Normalize composite score
  const normalizedScore = Number(Math.min(Math.max(score, 0.0), 1.0).toFixed(2));

  // Determine aggregate RiskLevel
  let riskLevel: RiskLevel = 'LOW';
  if (
    consequentialImpactRisk === 'CRITICAL' ||
    navigationRisk === 'CRITICAL' ||
    destructivenessRisk === 'CRITICAL' ||
    normalizedScore >= 0.80
  ) {
    riskLevel = 'CRITICAL';
  } else if (
    consequentialImpactRisk === 'HIGH' ||
    navigationRisk === 'HIGH' ||
    targetSensitivityRisk === 'HIGH' ||
    normalizedScore >= 0.55
  ) {
    riskLevel = 'HIGH';
  } else if (
    actionTypeRisk === 'MEDIUM' ||
    targetSensitivityRisk === 'MEDIUM' ||
    normalizedScore >= 0.30
  ) {
    riskLevel = 'MEDIUM';
  }

  const requiresConfirmation = riskLevel === 'HIGH' || riskLevel === 'CRITICAL';
  const allowed = navigationRisk !== 'CRITICAL' && !targetDescriptor.includes('javascript:');

  return {
    riskLevel,
    level: riskLevel,
    score: normalizedScore,
    reasons,
    rationale: reasons.join('; ') || 'Risk assessment complete.',
    requiresConfirmation,
    requiresUserConfirmation: requiresConfirmation,
    allowed,
    riskFactors: {
      actionTypeRisk,
      targetSensitivityRisk,
      consequentialImpactRisk,
      navigationRisk,
      destructivenessRisk,
    },
  };
}
