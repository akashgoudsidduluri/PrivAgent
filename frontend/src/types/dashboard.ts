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

export interface DashboardAgentState {
  status: UIAgentStatus;
  task: string;
  currentStep: number;
  maxSteps: number;
  currentPipelineStage: PipelineStage;
  currentUrl: string;
  reason?: string;
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
