/**
 * PrivAgent Security Architecture 2.0 Types
 * 
 * Defines the typed trust labels, sources, and data-flow security constructs.
 */

export type TrustSource = 
  | 'LOCAL_POLICY'
  | 'CURRENT_BROWSER'
  | 'VERIFIED_OBSERVATION'
  | 'MEMORY'
  | 'REMOTE_MODEL'
  | 'WEBPAGE'
  | 'USER';

export type TrustClass = 
  | 'TRUSTED'
  | 'VERIFIED'
  | 'ADVISORY'
  | 'UNTRUSTED'
  | 'HOSTILE';

export type SensitiveDataClass = 
  | 'PASSWORD'
  | 'OTP'
  | 'CVV'
  | 'CARD_NUMBER'
  | 'ACCOUNT_NUMBER'
  | 'AUTH_TOKEN'
  | 'COOKIE'
  | 'API_KEY'
  | 'SECRET'
  | 'PII';

export type SecurityDecisionType = 
  | 'ALLOW'
  | 'BLOCK'
  | 'SANITIZE'
  | 'REQUIRE_CONFIRMATION'
  | 'QUARANTINE';

export type SecurityEventType = 
  | 'PROMPT_INJECTION_DETECTED'
  | 'RAW_VALUE_BLOCKED'
  | 'EGRESS_BLOCKED'
  | 'ORIGIN_MISMATCH'
  | 'STALE_TARGET'
  | 'UNTRUSTED_INSTRUCTION'
  | 'MODEL_OUTPUT_REJECTED'
  | 'MEMORY_WRITE_BLOCKED'
  | 'NAVIGATION_BLOCKED'
  | 'UNAUTHORIZED_DATA_FLOW'
  | 'CONFIRMATION_REQUIRED'
  | 'POLICY_VIOLATION';

export interface SecurityDecision {
  directive: SecurityDecisionType;
  policy: string;
  source: TrustSource;
  destination: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  origin: string;
  timestamp: number;
}

export interface SecurityEvent {
  type: SecurityEventType;
  metadata: Record<string, unknown>; // MUST NOT contain raw sensitive payloads
  timestamp: number;
}

// A typed wrapper for data fragments to explicitly track provenance and trust
export interface ProvenanceData<T> {
  value: T;
  source: TrustSource;
  trustLevel: TrustClass;
}
