/**
 * PrivAgent — Explainable Privacy-Safe Agent Decision Trace (Feature 7)
 *
 * Implements granular, privacy-safe decision tracing for each step in an agent task.
 *
 * Invariant:
 *  - Raw sensitive data (passwords, OTPs, CVVs, PANs, account numbers, card numbers,
 *    raw addresses, phones, emails, raw OCR) NEVER enters the decision trace.
 *  - Traces record strictly: structural outcomes, risk levels, confidence scores,
 *    policy verdicts, and non-sensitive identifiers.
 */

import { BrowserAction } from './actionTypes';
import { ActionRiskAssessment } from './riskEngine';
import { SemanticVerificationResult } from './semanticVerifier';
import { ConfidenceEvaluation } from './confidenceScorer';
import { assertNoRawSensitiveValues } from '../privacy/rawValueScanner';

export interface DecisionTraceEntry {
  step: number;
  timestamp: number;
  goal: string;
  proposedAction: BrowserAction;
  riskAssessment: {
    riskLevel: string;
    score: number;
    requiresConfirmation: boolean;
  };
  structuralValidation: {
    passed: boolean;
    reason: string;
  };
  semanticVerification: {
    verified: boolean;
    confidence: number;
    alignment: string;
    reason: string;
  };
  confidenceEvaluation: {
    confidenceScore: number;
    directive: string;
    explanation: string;
  };
  executionResult?: {
    success: boolean;
    error?: string;
  };
  recoveryAttempt?: {
    attemptNumber: number;
    diagnosis: string;
    originalTarget: string;
    recoveredTarget?: string;
    success: boolean;
  };
  finalOutcome: 'EXECUTED' | 'CONFIRMED' | 'BLOCKED' | 'FAILED' | 'RECOVERED';
}

export class AgentDecisionTracer {
  private entries: DecisionTraceEntry[] = [];
  private taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  recordStep(entry: Omit<DecisionTraceEntry, 'timestamp'>): DecisionTraceEntry {
    const fullEntry: DecisionTraceEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    // Assert zero raw PII in decision trace entry
    assertNoRawSensitiveValues(fullEntry, {
      extraStructuralKeys: ['text'],
      allowedKeyNames: ['text'],
    });

    this.entries.push(fullEntry);
    return fullEntry;
  }

  getEntries(): readonly DecisionTraceEntry[] {
    return this.entries;
  }

  getSummary() {
    return {
      taskId: this.taskId,
      totalSteps: this.entries.length,
      executedCount: this.entries.filter((e) => e.finalOutcome === 'EXECUTED').length,
      blockedCount: this.entries.filter((e) => e.finalOutcome === 'BLOCKED').length,
      confirmedCount: this.entries.filter((e) => e.finalOutcome === 'CONFIRMED').length,
      recoveredCount: this.entries.filter((e) => e.finalOutcome === 'RECOVERED').length,
      entries: this.entries,
    };
  }
}
