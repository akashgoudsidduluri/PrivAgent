/**
 * PrivAgent Dashboard UI Types & Data Models
 *
 * Security Invariant:
 * Zero raw sensitive values (no passwords, card numbers, OTPs, CVVs).
 * Strictly metadata, category identifiers, and sanitized action descriptions.
 */

import type { EvaluationRun, EvaluationCase, SIHEvaluationMatrix, BenchmarkMetric } from '../../../extension/src/telemetry/evaluationEngine';
export type { EvaluationRun, EvaluationCase, SIHEvaluationMatrix, BenchmarkMetric };

export type DashboardTab =
  | 'overview'
  | 'agent'
  | 'browser'
  | 'privacy'
  | 'evaluation'
  | 'activity'
  | 'evidence'
  | 'system';

export type UIAgentStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'NEEDS_USER_CONFIRMATION'
  | 'STOPPED';

export type PipelineStage =
  | 'IDLE'
  | 'PERCEPTION'
  | 'PRIVACY_PROTECTION'
  | 'CONTEXT_MINIMIZATION'
  | 'LLM_REASONING'
  | 'ACTION_VALIDATION'
  | 'BROWSER_EXECUTION'
  | 'VERIFICATION';

export interface SensitiveCategorySummary {
  password: number;
  credit_card: number;
  account_number: number;
  email: number;
  phone: number;
  pan: number;
  cvv: number;
  otp: number;
}

export interface PlanStep {
  id: string;
  stepNumber: number;
  description: string;
  expectedActionType: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  targetHint?: string;
  completedAction?: unknown;
  error?: string;
}

export interface TaskPlan {
  taskId: string;
  goal: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: string;
  recoveryAttempts: number;
  maxRecoveryAttempts: number;
  createdAt: number;
  updatedAt: number;
  failureDiagnosis?: string;
}

export interface ActionRiskAssessment {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  level?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  score: number;
  reasons: string[];
  rationale?: string;
  requiresConfirmation: boolean;
  allowed: boolean;
}

export interface SemanticVerificationResult {
  verified: boolean;
  confidence: number;
  reason: string;
  targetAlignment: 'ALIGNED' | 'AMBIGUOUS' | 'CONTRADICTORY' | 'UNRELATED';
  policyDecision: 'ALLOW' | 'REQUIRE_CONFIRMATION' | 'REJECT';
}

export interface DecisionTraceSummary {
  taskId: string;
  totalSteps: number;
  executedCount: number;
  blockedCount: number;
  confirmedCount: number;
  recoveredCount: number;
  entries: unknown[];
}

export interface StepTelemetry {
  step: number;
  actionType: string;
  targetDescription: string;
  validationPassed: boolean;
  validationReason?: string;
  executionSuccess: boolean;
  executionError?: string;
  sensitiveCategoryDetected?: string;
  timestamp: number;
  riskAssessment?: ActionRiskAssessment;
  semanticVerification?: SemanticVerificationResult;
  confidenceScore?: number;
  selfHealingRecovered?: boolean;
  semanticContext?: any;
}

export interface PrivacyReceipt {
  id: string;
  task: string;
  timestamp: number;
  result: 'SUCCESS' | 'FAILED' | 'STOPPED';
  sensitiveDetectedCount: number;
  sensitiveTransmittedCount: 0; // Invariant: always 0
  rawScreenshotsTransmitted: 0; // Invariant: always 0
  rawDomTransmitted: 0;         // Invariant: always 0
  categoriesDetected: string[];
  sanitizedContextShared: string[];
  llmRequestsCount: number;
  browserActionsCount: number;
  latencyMs: number;
  error?: string;
  steps: StepTelemetry[];
}

/**
 * Phase 14 — Agent Interaction & Output Layer (user-facing projection).
 *
 * Produced by `projectAgentOutput()` in extension/src/agent/agentOutput.ts and
 * screened by `screenAgentOutput()` in the SERVICE WORKER before it crosses the
 * SW → dashboard boundary. These types mirror that closed vocabulary so the UI
 * never has to infer a phase from prose.
 *
 * Security invariant: the values here are operational status only. No model
 * rationale, no gate prose, no internal `reason`, no decision trace, no raw
 * values. Rendering them grants no authority whatsoever.
 */
export type AgentOutcome =
  | 'IDLE' | 'RUNNING' | 'AWAITING_CONFIRMATION' | 'SUCCEEDED' | 'FAILED' | 'STOPPED';

export type AgentActivityPhase =
  | 'IDLE' | 'PERCEPTION' | 'PLANNING' | 'VALIDATION' | 'EXECUTION'
  | 'VERIFICATION' | 'RECOVERY' | 'AWAITING_CONFIRMATION' | 'TERMINAL';

export type AgentTerminalReason =
  | 'GOAL_ACHIEVED' | 'STOPPED_BY_USER' | 'CONTAINMENT_DENIED' | 'HARNESS_HALTED'
  | 'RECOVERY_EXHAUSTED' | 'STEP_BOUND_EXHAUSTED' | 'REASONER_FAILED'
  | 'PERCEPTION_FAILED' | 'CONFIRMATION_DECLINED' | 'UNKNOWN';

export interface AgentActivity {
  phase: AgentActivityPhase;
  summary: string;
  step: number;
  maxSteps: number;
  cycle: number | null;
}

export interface AgentTerminal {
  outcome: 'SUCCEEDED' | 'FAILED' | 'STOPPED';
  reason: AgentTerminalReason;
  headline: string;
}

export interface AgentResultItem {
  id: string;
  title: string;
  detail: string;
}

export interface AgentResult {
  kind: 'NONE' | 'FINDINGS' | 'CANDIDATES';
  summary: string;
  count: number;
  items: AgentResultItem[];
}

export interface AgentArtifact {
  kind: 'CONTAINMENT' | 'HARNESS' | 'RECOVERY' | 'FAILURE' | 'PERCEPTION';
  label: string;
}

export interface AgentTimelineEntry {
  step: number;
  action: string;
  outcome: 'EXECUTED' | 'BLOCKED' | 'FAILED' | 'CONFIRMED';
}

export interface AgentInteractionState {
  outcome: AgentOutcome;
  activity: AgentActivity;
  terminal: AgentTerminal | null;
  result: AgentResult;
  artifacts: AgentArtifact[];
  timeline: AgentTimelineEntry[];
  awaitingConfirmation: {
    action: string;
    description: string;
    riskLevel: string;
  } | null;
}

export interface DashboardAgentState {
  status: UIAgentStatus;
  task: string;
  currentStep: number;
  maxSteps: number;
  currentPipelineStage: PipelineStage;
  currentUrl: string;
  reason?: string;
  pageType?: string;
  candidateEntities?: any[];
  semanticContext?: any;
  requiresUserConfirmationAction?: {
    action: string;
    description: string;
    target?: string;
    url?: string;
    riskLevel?: string;
    riskScore?: number;
  };
  steps: StepTelemetry[];
  sensitiveItemsCount: number;
  categories: SensitiveCategorySummary;
  plan?: TaskPlan;
  latestRisk?: ActionRiskAssessment;
  latestSemantic?: SemanticVerificationResult;
  decisionTraceSummary?: DecisionTraceSummary;
  /**
   * Phase 14 user-facing interaction projection. Absent on a task that has not
   * yet emitted one (or from an older service worker); the UI degrades to the
   * previous behaviour rather than failing.
   */
  interaction?: AgentInteractionState;
}

export interface BackendHealthState {
  online: boolean;
  service: string;
  backend_status: string;
  reasoner: string;
  reasoner_status: string;
  reasoner_configured: boolean;
  model?: string;
  fallback_reasoner?: string;
  fallback_configured?: boolean;
  privacy_firewall: string;
  sensitive_data_sent: number;
}
