/**
 * PrivAgent — Semantic Pre-Execution Verifier (Feature 2)
 *
 * Verifies that a proposed browser action is semantically consistent with:
 *  1. The user's explicit task intent and goal.
 *  2. The active page context.
 *  3. The intended target element semantics (role, label, context).
 *  4. Deterministic risk assessment.
 *
 * Distinguishes STRUCTURALLY VALID (element exists in DOM) from
 * SEMANTICALLY AUTHORIZED (aligned with user instruction, not hijacked or conflicting).
 */

import { BrowserAction } from './actionTypes';
import { assessActionRisk, ActionRiskAssessment } from './riskEngine';
import { AgentContextPayload, AgentDetection } from '../privacy/types';

export type TargetAlignment = 'ALIGNED' | 'AMBIGUOUS' | 'CONTRADICTORY' | 'UNRELATED';
export type SemanticPolicyDecision = 'ALLOW' | 'REQUIRE_CONFIRMATION' | 'REJECT';

export interface SemanticVerificationResult {
  verified: boolean;
  confidence: number; // 0.0 to 1.0
  reason: string;
  targetAlignment: TargetAlignment;
  policyDecision: SemanticPolicyDecision;
  suggestedAlternative?: string;
}

interface IntentSemanticMap {
  taskKeywords: string[];
  expectedTargetKeywords: string[];
  conflictingTargetKeywords: string[];
}

const DOMAIN_INTENT_MAPS: IntentSemanticMap[] = [
  {
    taskKeywords: ['transaction', 'transactions', 'statement', 'history', 'passbook'],
    expectedTargetKeywords: ['transaction', 'history', 'statement', 'activity', 'recent', 'details', 'view'],
    conflictingTargetKeywords: ['transfer', 'pay', 'send money', 'deposit', 'delete', 'logout', 'change password'],
  },
  {
    taskKeywords: ['account number', 'account_number', 'account details', 'balance', 'profile'],
    expectedTargetKeywords: ['account', 'details', 'profile', 'balance', 'number', 'overview', 'info'],
    conflictingTargetKeywords: ['delete account', 'transfer', 'checkout', 'pay now'],
  },
  {
    taskKeywords: ['scroll', 'scroll down', 'scroll up'],
    expectedTargetKeywords: ['scroll', 'page', 'body', 'window'],
    conflictingTargetKeywords: ['submit', 'pay', 'delete'],
  },
  {
    taskKeywords: ['navigate', 'open', 'go to'],
    expectedTargetKeywords: ['link', 'menu', 'button', 'nav'],
    conflictingTargetKeywords: ['javascript:', 'data:', 'vbscript:'],
  },
  {
    taskKeywords: ['search', 'query', 'find', 'lookup', 'google'],
    expectedTargetKeywords: ['search', 'input', 'query', 'btn', 'button', 'text', 'box', 'q', 'find'],
    conflictingTargetKeywords: ['delete', 'pay', 'checkout', 'transfer', 'logout'],
  },
];

/**
 * Evaluates semantic consistency between the user task and proposed browser action.
 */
export function verifySemanticAction(
  action: BrowserAction,
  task: string,
  context: AgentContextPayload,
  riskAssessment?: ActionRiskAssessment
): SemanticVerificationResult {
  const risk = riskAssessment || assessActionRisk(action, context);
  const normalizedTask = task.toLowerCase();
  let targetDet: AgentDetection | undefined;

  if ('target' in action && typeof action.target === 'string') {
    targetDet = context.detections.find((d) => d.id === action.target);
    if (targetDet && targetDet.bbox) {
      const width = typeof targetDet.bbox.width === 'number' ? targetDet.bbox.width : (targetDet.bbox as any)[2];
      const height = typeof targetDet.bbox.height === 'number' ? targetDet.bbox.height : (targetDet.bbox as any)[3];
      if (typeof width === 'number' && typeof height === 'number' && (width <= 0 || height <= 0)) {
        return {
          verified: false,
          confidence: 0.0,
          reason: `Target element '${action.target}' has zero visible geometry (0x0) and cannot be interactively targeted.`,
          targetAlignment: 'CONTRADICTORY',
          policyDecision: 'REJECT',
        };
      }
    }
  }

  const targetDescription = [
    targetDet?.selector || '',
    targetDet?.type || '',
    'reason' in action && typeof action.reason === 'string' ? action.reason : '',
    action.action === 'navigate' ? action.url : '',
  ].join(' ').toLowerCase();

  // 1. Navigation Safety Check
  if (action.action === 'navigate') {
    if (action.url.startsWith('javascript:') || action.url.startsWith('data:') || action.url.startsWith('vbscript:')) {
      return {
        verified: false,
        confidence: 0.0,
        reason: `Malicious protocol in navigation action: '${action.url}'.`,
        targetAlignment: 'CONTRADICTORY',
        policyDecision: 'REJECT',
      };
    }
  }

  // 2. Identify Matching Intent Domain
  let matchingDomain: IntentSemanticMap | undefined;
  for (const domain of DOMAIN_INTENT_MAPS) {
    if (domain.taskKeywords.some((kw) => normalizedTask.includes(kw))) {
      matchingDomain = domain;
      break;
    }
  }

  // 3. Conflict / Hijacking Detection
  if (matchingDomain) {
    const hasConflict = matchingDomain.conflictingTargetKeywords.some((kw) =>
      targetDescription.includes(kw)
    );

    if (hasConflict) {
      return {
        verified: false,
        confidence: 0.15,
        reason: `Action target '${targetDescription}' contradicts user task intent '${task}'. Potential action hijacking or prompt injection detected.`,
        targetAlignment: 'CONTRADICTORY',
        policyDecision: 'REJECT',
      };
    }

    const hasAlignment = matchingDomain.expectedTargetKeywords.some((kw) =>
      targetDescription.includes(kw)
    );

    if (hasAlignment) {
      const confidence = risk.riskLevel === 'LOW' ? 0.95 : 0.85;
      return {
        verified: true,
        confidence,
        reason: `Action target '${targetDescription}' is semantically aligned with goal '${task}'.`,
        targetAlignment: 'ALIGNED',
        policyDecision: risk.requiresConfirmation ? 'REQUIRE_CONFIRMATION' : 'ALLOW',
      };
    }
  }

  // 4. Scroll Actions Alignment
  if (action.action === 'scroll') {
    return {
      verified: true,
      confidence: 0.90,
      reason: 'Scroll action is an observational inspection step consistent with visual discovery.',
      targetAlignment: 'ALIGNED',
      policyDecision: 'ALLOW',
    };
  }

  // 5. General Element Matching
  if (targetDet) {
    // If user prompt mentions words in target selector or type
    const taskTokens = normalizedTask.split(/\s+/).filter((t) => t.length > 3);
    const tokenOverlap = taskTokens.some((tok) => targetDescription.includes(tok));

    if (tokenOverlap) {
      return {
        verified: true,
        confidence: 0.85,
        reason: `Target element tokens correspond to user task description.`,
        targetAlignment: 'ALIGNED',
        policyDecision: risk.requiresConfirmation ? 'REQUIRE_CONFIRMATION' : 'ALLOW',
      };
    }

    // If risk is high/critical and no explicit token overlap
    if (risk.riskLevel === 'HIGH' || risk.riskLevel === 'CRITICAL') {
      return {
        verified: false,
        confidence: 0.40,
        reason: `High-risk action targets '${targetDescription}' without explicit semantic authorization in task prompt '${task}'.`,
        targetAlignment: 'AMBIGUOUS',
        policyDecision: 'REQUIRE_CONFIRMATION',
      };
    }

    // Benign generic interaction
    return {
      verified: true,
      confidence: 0.75,
      reason: `Target '${targetDescription}' is structurally plausible for visual exploration.`,
      targetAlignment: 'ALIGNED',
      policyDecision: 'ALLOW',
    };
  }

  // 6. Navigation Alignment
  if (action.action === 'navigate') {
    return {
      verified: true,
      confidence: 0.80,
      reason: `Navigating to destination '${action.url}'.`,
      targetAlignment: 'ALIGNED',
      policyDecision: risk.requiresConfirmation ? 'REQUIRE_CONFIRMATION' : 'ALLOW',
    };
  }

  return {
    verified: true,
    confidence: 0.50,
    reason: 'Target element not found in current perception snapshot; delegating structural validation to local validator.',
    targetAlignment: 'AMBIGUOUS',
    policyDecision: 'ALLOW',
  };
}
