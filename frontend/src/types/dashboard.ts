/**
 * PrivAgent Dashboard UI Types & Data Models
 *
 * Security Invariant:
 * Zero raw sensitive values (no passwords, card numbers, OTPs, CVVs).
 * Strictly metadata, category identifiers, and sanitized action descriptions.
 */

export type DashboardTab = 'agent' | 'activity' | 'privacy' | 'receipts' | 'settings';

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
  | 'BROWSER_EXECUTION';

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
  };
  steps: StepTelemetry[];
  sensitiveItemsCount: number;
  categories: SensitiveCategorySummary;
}

export interface BackendHealthState {
  online: boolean;
  service: string;
  reasoner: string;
  reasoner_configured: boolean;
}
