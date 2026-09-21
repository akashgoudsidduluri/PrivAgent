/**
 * PrivAgent — Memory Types (Phase 5)
 * Defines the core types, trust hierarchy, and storage schemas for the Privacy-Preserving Agent Memory subsystem.
 */

// ============================================================================
// 1. TRUST HIERARCHY
// ============================================================================

/**
 * Explicit Trust Hierarchy (Deterministic Policy).
 * Lower numerical value = Higher trust.
 * 
 * LOCAL SECURITY POLICY > CURRENT BROWSER WORLD > VERIFIED OBSERVATION > VERIFIED MEMORY > ...
 */
export enum MemoryTrustLevel {
  /** Unassailable local policy (e.g. M5 rules, M8 privacy rules). */
  LOCAL_SECURITY_POLICY = 1,
  
  /** The actual current state of the DOM and active browser tab. */
  CURRENT_BROWSER_WORLD = 2,
  
  /** An observation derived deterministically from the current DOM in this tick. */
  CURRENT_VERIFIED_OBSERVATION = 3,
  
  /** A memory that was previously verified by effect verification and is highly robust. */
  VERIFIED_MEMORY = 4,
  
  /** Memory derived from successful past actions or user explicit preferences. */
  HIGH_CONFIDENCE_MEMORY = 5,
  
  /** Unverified observations, inferred data, or aging semantic facts. */
  LOW_CONFIDENCE_MEMORY = 6,
  
  /** Claims made by the remote model during reasoning. Untrusted. */
  REMOTE_MODEL_CLAIM = 7,
  
  /** Instructions or facts originating directly from webpage content. Highly untrusted. */
  WEBPAGE_INSTRUCTION = 8,
}

// ============================================================================
// 2. MEMORY SCOPE & PROVENANCE
// ============================================================================

export interface SiteScope {
  /** The normalized origin (e.g., "https://example.com"). */
  origin: string;
  /** A deterministic site identifier (e.g., hash or canonical name). */
  siteKey: string;
  /** Optional page taxonomy category (e.g., "PRODUCT_LISTING", "CHECKOUT"). */
  pageTaxonomy?: string;
}

export type MemorySource = 
  | 'USER' 
  | 'SYSTEM' 
  | 'LOCAL_PERCEPTION' 
  | 'REMOTE_MODEL' 
  | 'WEBPAGE' 
  | 'ACTION_RESULT' 
  | 'VERIFIED_OUTCOME';

export interface MemoryProvenance {
  source: MemorySource;
  timestamp: number;
  subgoalId?: string;
  actionType?: string;
}

// ============================================================================
// 3. MEMORY CLASSES
// ============================================================================

export type MemoryClass = 'WORKING' | 'EPISODIC' | 'SEMANTIC' | 'FAILURE';

export interface BaseMemoryRecord {
  id: string;
  class: MemoryClass;
  scope: SiteScope;
  trustLevel: MemoryTrustLevel;
  provenance: MemoryProvenance;
  confidence: number; // 0.0 to 1.0
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

// ----------------------------------------------------------------------------
// A. Working Memory (Transient)
// ----------------------------------------------------------------------------
export interface WorkingMemoryRecord extends BaseMemoryRecord {
  class: 'WORKING';
  goalId: string;
  key: string;
  memoryContent: any;
}

// ----------------------------------------------------------------------------
// B. Episodic Memory (Sanitized Historical Task Events)
// ----------------------------------------------------------------------------
export interface EpisodicMemoryRecord extends BaseMemoryRecord {
  class: 'EPISODIC';
  taskType: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'ABORTED';
  sanitizedSummary: string;
  metrics?: {
    durationMs: number;
    actionsTaken: number;
  };
}

// ----------------------------------------------------------------------------
// C. Semantic Memory (Reusable Knowledge/Facts)
// ----------------------------------------------------------------------------
export type SemanticMemoryType = 
  | 'SITE_KNOWLEDGE' 
  | 'WORKFLOW_KNOWLEDGE' 
  | 'USER_PREFERENCE' 
  | 'VERIFIED_FACT';

export interface SemanticMemoryRecord extends BaseMemoryRecord {
  class: 'SEMANTIC';
  type: SemanticMemoryType;
  key: string;
  memoryContent: string;
  observationCount: number;
}

// ----------------------------------------------------------------------------
// D. Failure Memory (Sanitized Failure Patterns)
// ----------------------------------------------------------------------------
export interface FailureMemoryRecord extends BaseMemoryRecord {
  class: 'FAILURE';
  failureType: string;
  contextCategory: string;
  recoveryAttempted?: string;
  recoveryResult?: 'SUCCESS' | 'FAILURE';
}

export type AnyMemoryRecord = 
  | WorkingMemoryRecord 
  | EpisodicMemoryRecord 
  | SemanticMemoryRecord 
  | FailureMemoryRecord;
