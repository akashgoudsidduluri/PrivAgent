import { SecurityDecision } from './types';

export interface TargetIdentity {
  id: string;
  origin: string;
  pageGeneration: number;
}

/**
 * Validates that a target is legally bound to the current execution context.
 */
export function validateTargetOrigin(targetId: string, currentOrigin: string, currentPageGeneration: number, knownTargets: TargetIdentity[]): SecurityDecision {
  const target = knownTargets.find(t => t.id === targetId);

  if (!target) {
    return {
      directive: 'BLOCK',
      policy: 'TARGET_ISOLATION',
      source: 'LOCAL_POLICY',
      destination: 'CHROME_EXECUTION',
      reason: `Target ${targetId} is unknown and cannot be verified.`,
      severity: 'high',
      origin: currentOrigin,
      timestamp: Date.now()
    };
  }

  if (target.origin !== currentOrigin) {
    return {
      directive: 'BLOCK',
      policy: 'ORIGIN_ISOLATION',
      source: 'LOCAL_POLICY',
      destination: 'CHROME_EXECUTION',
      reason: `Cross-origin target mismatch. Target origin: ${target.origin}, Current: ${currentOrigin}`,
      severity: 'critical',
      origin: currentOrigin,
      timestamp: Date.now()
    };
  }

  if (target.pageGeneration !== currentPageGeneration) {
    return {
      directive: 'BLOCK',
      policy: 'STALE_TARGET_ISOLATION',
      source: 'LOCAL_POLICY',
      destination: 'CHROME_EXECUTION',
      reason: `Stale target. Target generation: ${target.pageGeneration}, Current: ${currentPageGeneration}`,
      severity: 'medium',
      origin: currentOrigin,
      timestamp: Date.now()
    };
  }

  return {
    directive: 'ALLOW',
    policy: 'TARGET_ISOLATION',
    source: 'LOCAL_POLICY',
    destination: 'CHROME_EXECUTION',
    reason: 'Target is valid for current origin and generation.',
    severity: 'low',
    origin: currentOrigin,
    timestamp: Date.now()
  };
}
