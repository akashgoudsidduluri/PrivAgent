/**
 * PrivAgent — PHASE 17.8 BENCHMARK: types.
 *
 * WHAT THIS IS
 * ────────────
 * A deterministic, labelled benchmark over the DECISION AUTHORITIES of the
 * agent: Grounding, M5, the Security Critic, Risk/Confirmation, Containment,
 * Effect Verification, Goal Verification, Recovery and the Privacy boundary.
 *
 * WHAT THIS IS NOT
 * ────────────────
 * It is not a new authorization system, it does not wrap or shadow any
 * production gate, and nothing in it can change a verdict in production. Every
 * case calls the REAL production function and records what it actually
 * returned. The benchmark is a READER of the system, never a participant in it.
 *
 * WHY THE SHAPE IS A CORPUS PLUS AN ADAPTER
 * ─────────────────────────────────────────
 * `corpus.ts` holds DATA ONLY — the input, the expected verdict and the reason
 * that verdict is correct. `authorities.ts` holds the invocation. Keeping them
 * apart is what makes the benchmark falsifiable: if a case's expectation and
 * the production call it is compared against were written in the same place,
 * a well-meaning edit could quietly make them agree with each other while
 * disagreeing with production. Here they cannot.
 *
 * The error taxonomy is deliberately ASYMMETRIC. A "false allow" — an authority
 * permitting something it must refuse — and a "false block" — an authority
 * refusing something that is legitimate — are not two flavors of the same
 * mistake. The first is a security event. The second is a usability defect.
 * They are counted, reported and asserted separately, and the false-allow
 * count is the number this benchmark is really about.
 */

import type { AgentContextPayload } from '../../extension/src/privacy/types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';
import type { SecurityCriticInput } from '../../extension/src/agent/securityCritic';
import type { ContainmentInput, ContainmentScope } from '../../extension/src/agent/containment';
import type { PreActionSnapshot, PostActionSnapshot } from '../../extension/src/agent/effectVerifier';
import type { AgentTaskState } from '../../extension/src/agent/agentState';
import type { SensitiveEntityType } from '../../extension/src/privacy/types';

// ─────────────────────────────────────────────────────────────────────────────
// Authority / category taxonomy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The authorities the benchmark exercises. These are the gates that exist in
 * production, named as they are named in the phase evidence, not as a new
 * hierarchy invented by the benchmark.
 */
export type AuthorityId =
  | 'GROUNDING'
  | 'M5'
  | 'SECURITY_CRITIC'
  | 'RISK_CONFIRMATION'
  | 'CONTAINMENT'
  | 'EFFECT_VERIFICATION'
  | 'OBSERVATION'
  | 'GOAL_VERIFICATION'
  | 'RECOVERY'
  | 'PRIVACY_EGRESS'
  | 'LONG_HORIZON_HARNESS';

export const AUTHORITY_IDS: readonly AuthorityId[] = [
  'GROUNDING',
  'M5',
  'SECURITY_CRITIC',
  'RISK_CONFIRMATION',
  'CONTAINMENT',
  'EFFECT_VERIFICATION',
  'OBSERVATION',
  'GOAL_VERIFICATION',
  'RECOVERY',
  'PRIVACY_EGRESS',
  'LONG_HORIZON_HARNESS',
] as const;

/** Corpus categories A–J, as specified in the Phase 17.8 plan. */
export type CategoryId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';

export const CATEGORY_TITLES: Record<CategoryId, string> = {
  A: 'Grounding',
  B: 'M5 / Privacy Firewall (action schema + PII firewall)',
  C: 'Security Critic',
  D: 'Risk / Confirmation',
  E: 'Containment',
  F: 'Effect Verification',
  G: 'Goal Verification',
  H: 'Recovery / Long Horizon',
  I: 'Privacy / Egress',
  J: 'Success Fabrication',
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-category inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface GroundingInput {
  action: BrowserAction;
  detections: AgentContextPayload['detections'];
  options?: {
    currentPageGeneration?: number;
    actionPageGeneration?: number;
    confidenceThreshold?: number;
    currentOrigin?: string;
  };
}

export interface M5Input {
  action: unknown;
  context: AgentContextPayload;
}

export interface RiskInput {
  action: BrowserAction;
  context: AgentContextPayload;
  currentUrl?: string;
}

export type ContainmentInput_ = ContainmentInput;

export interface ContainmentPostNavInput {
  scope: ContainmentScope | null;
  actualUrl: string | null;
}

export interface EffectInput {
  action: BrowserAction;
  pre: PreActionSnapshot;
  post: PostActionSnapshot;
}

export interface GoalInput {
  task: string;
  state: Partial<AgentTaskState>;
  context: AgentContextPayload;
  /**
   * Present only for subgoal-completion cases, which are verified by
   * `GoalProgressTracker.verifySubgoalCondition` rather than by the task goal
   * verifier. Dispatch state must never complete a subgoal.
   */
  subgoal?: {
    id: string;
    goalId?: string;
    index?: number;
    description: string;
    category?: string;
    state?: string;
    prerequisites?: string[];
    retryCount?: number;
    maxRetries?: number;
    verificationCondition?: {
      type: string;
      expectedValue?: string;
      description: string;
    };
  };
  /** Only used by STATE_CHANGED / USER_CONFIRMED conditions. */
  userConfirmedActionIds?: string[];
}

export type RecoveryInput =
  | { kind: 'RECOVER'; action: BrowserAction; context: AgentContextPayload; goal: string }
  | { kind: 'HEALED_REVALIDATED'; action: BrowserAction; context: AgentContextPayload; goal: string }
  | { kind: 'PROGRESS'; previous: unknown; current: unknown; subgoalJustCompleted?: string }
  | { kind: 'LOOP'; fingerprints: string[]; maxRepeatedStates: number }
  | { kind: 'STALL'; consecutiveNoProgress: number; totalNoProgress: number; maxConsecutiveNoProgress: number }
  | { kind: 'PERSIST_RESTORE'; raw: unknown; runId: string; goalText: string }
  | { kind: 'BUDGET'; used: number; maxSteps: number };

export type ProviderInput =
  /**
   * Provider envelope validation: an unexpected field must be refused.
   *
   * The F-08 egress regression (a local-only observation block crossing the
   * wire) is NOT a corpus case. It is a property of the serialized request
   * body, which requires an intercepted `fetch` and is therefore async, so it
   * is measured in `egress.ts` against the real `BackendAgentProvider` and
   * asserted alongside the other reused infrastructure.
   */
  | { kind: 'PROVIDER_ENVELOPE'; raw: unknown };

export type PrivacyInput =
  | { kind: 'CAPABILITY'; entity: SensitiveEntityType; capability: string; caller: 'agent_llm' | 'local_user' }
  | { kind: 'CAN_PERFORM'; action: BrowserAction; targetId: string; caller: 'agent_llm' | 'local_user' }
  | { kind: 'RAW_VALUE'; payload: unknown }
  | { kind: 'SANITIZED_CTX'; context: AgentContextPayload }
  | { kind: 'TRANSMISSION'; category: string; hasMapping: boolean; hasRaw: boolean; confidence?: number; sources?: string[] }
  | { kind: 'MIXED_FINDINGS'; domCount: number; ocrCount: number }
  | { kind: 'PROVIDER_FAILURE'; leaked: string[]; telemetryValue: string };

/**
 * Category J — success fabrication.
 *
 * Every input here is built from a NON-AUTHORITATIVE source of "evidence":
 * dispatch success, action history, visited element ids, the requested URL,
 * the model's own claim, subgoal bookkeeping, or recovery. The expectation is
 * ALWAYS that the goal is not satisfied. A case that unexpectedly succeeds is
 * the single most important failure this benchmark can report.
 */
export interface FabricationInput extends GoalInput {
  /** Which non-authoritative signal this case plants. Recorded in evidence. */
  plantedSignal:
    | 'executionSuccess'
    | 'previousActions'
    | 'visitedElementIds'
    | 'requestedUrl'
    | 'modelClaim'
    | 'dispatchSuccess'
    | 'subgoalCompletion'
    | 'recoveryCompletion';
}

export type CaseInput =
  | { category: 'A'; input: GroundingInput }
  | { category: 'B'; input: M5Input }
  | { category: 'C'; input: SecurityCriticInput }
  | { category: 'D'; input: RiskInput }
  | { category: 'E'; input: ContainmentInput_ | ContainmentPostNavInput }
  | { category: 'F'; input: EffectInput }
  | { category: 'G'; input: GoalInput }
  | { category: 'H'; input: RecoveryInput }
  | { category: 'I'; input: PrivacyInput | ProviderInput }
  | { category: 'J'; input: FabricationInput };

// ─────────────────────────────────────────────────────────────────────────────
// The case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single decisive token the authority must produce.
 *
 * These are production tokens wherever production has one
 * (`STALE_TARGET`, `TARGET_MISMATCH`, `BLOCK`, `SUCCESS`, `SCOPE_DRIFT_DETECTED`)
 * and a benchmark-side, explicitly non-production label where it does not
 * (`REFUSED`, `ALLOWED`). A benchmark label is never mistaken for a verdict
 * the system emitted.
 */
export interface Expectation {
  /** Decisive token, compared for exact equality. */
  verdict: string;
  /** True when the authority must refuse. The security-relevant half. */
  blocked: boolean;
  /**
   * True when the refusal must be a hard fail-closed (terminal / never-default
   * to the permissive branch). Null when the notion does not apply.
   */
  failClosed: boolean | null;
  /**
   * Optional extra tokens that must ALSO appear, when a single verdict code
   * cannot distinguish the case. Used sparingly.
   */
  alsoVerdicts?: string[];
}

export interface BenchmarkCase {
  /** Stable identifier, e.g. 'A3'. Never reused, never renumbered. */
  id: string;
  category: CategoryId;
  authority: AuthorityId;
  title: string;
  /**
   * True when the case is an ATTACK: the correct answer is to refuse.
   * False for the control cases, which must be allowed through. Every blocking
   * rule is paired with a control, so a benchmark that refused everything
   * would score well and would be worthless.
   */
  adversarial: boolean;
  input: CaseInput;
  expectation: Expectation;
  /** Why this expectation is the correct one. Part of the evidence. */
  rationale: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcomes and metrics
// ─────────────────────────────────────────────────────────────────────────────

export interface CaseOutcome {
  id: string;
  category: CategoryId;
  authority: AuthorityId;
  title: string;
  adversarial: boolean;
  expectedVerdict: string;
  actualVerdict: string;
  pass: boolean;
  /** Did the authority actually refuse? */
  blocked: boolean;
  expectedBlocked: boolean;
  /**
   * SECURITY EVENT. The authority permitted something the corpus says must be
   * refused. Any non-zero count fails the benchmark outright.
   */
  falseAllow: boolean;
  /**
   * USABILITY DEFECT. The authority refused something legitimate. Real, worth
   * reporting, and categorically less serious than a false allow.
   */
  falseBlock: boolean;
  failClosedCorrect: boolean | null;
  /** Which production authority produced the answer. */
  responsible: string;
  /** Value-free diagnostic. Never contains page text, model text or PII. */
  detail: string;
  latencyMs: number;
  rationale: string;
}

export interface Confusion {
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface AuthorityResult {
  authority: AuthorityId;
  category: CategoryId;
  casesExercised: number;
  expectedDecisions: number;
  correctDecisions: number;
  incorrectDecisions: number;
  falseAllows: number;
  falseBlocks: number;
  bypasses: number;
  failClosedCases: number;
  failClosedCorrect: number;
  /** Confusion matrix over "must refuse" as the positive class. */
  confusion: Confusion;
  notes: string;
}

export interface AggregateResult {
  totalCases: number;
  passed: number;
  failed: number;
  accuracy: number;
  falseAllowCount: number;
  falseBlockCount: number;
  securityBypassCount: number;
  failClosedCases: number;
  failClosedCorrect: number;
  failClosedAccuracy: number | null;
  goalSuccessFabricationCount: number;
  effectSuccessFabricationCount: number;
  privacyLeakageCount: number;
  containmentBypassCount: number;
  recoveryGateBypassCount: number;
  byCategory: Record<CategoryId, { total: number; passed: number; falseAllows: number; falseBlocks: number }>;
  byAuthority: AuthorityResult[];
}
