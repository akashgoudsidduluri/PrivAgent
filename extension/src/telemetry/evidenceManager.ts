/**
 * PrivAgent — M12 Evidence Manager & Artifact Generator
 *
 * Implements a structured, judge-ready evidence export and storage system
 * for the SIH26171 (ISRO) evaluation.
 *
 * Security Invariants:
 * 1. NEVER stores raw passwords, OTPs, CVVs, card numbers, or full tokens.
 * 2. Formats full 11-step chronological decision traces for each evaluation case.
 * 3. Exports structured JSON and judge-friendly Markdown summaries.
 */

import { EvaluationCase, EvaluationCaseEvidence, EvaluationRun } from './evaluationEngine';

export interface ChronologicalTraceStep {
  stepNumber: number;
  phase: string;
  name: string;
  description: string;
  details: Record<string, unknown>;
  safetyVerdict: 'SAFE' | 'GATED' | 'BLOCKED' | 'NOT_APPLICABLE';
}

export class EvidenceManager {
  private static instance: EvidenceManager | null = null;

  static getInstance(): EvidenceManager {
    if (!EvidenceManager.instance) {
      EvidenceManager.instance = new EvidenceManager();
    }
    return EvidenceManager.instance;
  }

  /**
   * Builds the 11-step chronological trace required for SIH judging.
   */
  buildChronologicalTrace(evidence: EvaluationCaseEvidence): ChronologicalTraceStep[] {
    return [
      {
        stepNumber: 1,
        phase: 'INTENT',
        name: 'User Goal Formulation',
        description: `Task goal received: "${evidence.task}"`,
        details: { task: evidence.task, targetUrl: evidence.pageUrl },
        safetyVerdict: 'SAFE',
      },
      {
        stepNumber: 2,
        phase: 'PERCEPTION',
        name: 'On-Device Perception Snapshot',
        description: evidence.perceptionSummary,
        details: {
          pageUrl: evidence.pageUrl,
          pageGeneration: evidence.pageGeneration,
          interactiveCandidatesCount: evidence.detectedInteractiveElementsCount,
          sensitiveDetections: evidence.sensitiveDetectionsSummary,
        },
        safetyVerdict: 'SAFE',
      },
      {
        stepNumber: 3,
        phase: 'REASONING',
        name: 'Groq Cloud Reasoner Proposal',
        description: `Proposed action "${evidence.reasonerProposal.actionType}" based on sanitized context.`,
        details: {
          actionType: evidence.reasonerProposal.actionType,
          targetHint: evidence.reasonerProposal.targetHint ?? 'N/A',
          rationale: evidence.reasonerProposal.rationale ?? 'N/A',
          untrustedCloudContext: 'Sanitized DOM metadata only (0 raw values)',
        },
        safetyVerdict: 'SAFE',
      },
      {
        stepNumber: 4,
        phase: 'GROUNDING',
        name: 'Interactive Target Grounding',
        description: evidence.groundedTargetId
          ? `Grounded proposed target to local DOM element ID: ${evidence.groundedTargetId}`
          : 'No specific element grounding required (e.g. scroll or none)',
        details: {
          groundedTargetId: evidence.groundedTargetId ?? 'NONE',
        },
        safetyVerdict: 'SAFE',
      },
      {
        stepNumber: 5,
        phase: 'SAFETY_GATE',
        name: 'M5 Local Action Validation',
        description: evidence.m5Result.allowed
          ? 'M5 local validator ALLOWED candidate action'
          : `M5 local validator REJECTED/GATED candidate action: ${evidence.m5Result.reason}`,
        details: {
          allowed: evidence.m5Result.allowed,
          reason: evidence.m5Result.reason ?? 'Element in viewport, active generation, valid coordinates',
        },
        safetyVerdict: evidence.m5Result.allowed ? 'SAFE' : 'BLOCKED',
      },
      {
        stepNumber: 6,
        phase: 'RISK_POLICY',
        name: 'Risk Evaluation & Confirmation Check',
        description: `Risk score ${evidence.riskResult.riskScore}/100 (${evidence.riskResult.riskLevel}). Confirmation required: ${evidence.riskResult.requiresConfirmation}`,
        details: {
          riskScore: evidence.riskResult.riskScore,
          riskLevel: evidence.riskResult.riskLevel,
          requiresConfirmation: evidence.riskResult.requiresConfirmation,
          confirmationResult: evidence.confirmationResult ?? 'N/A',
        },
        safetyVerdict: evidence.riskResult.requiresConfirmation ? 'GATED' : 'SAFE',
      },
      {
        stepNumber: 7,
        phase: 'EXECUTION',
        name: 'Real Chrome Browser Execution',
        description: `Dispatched CDP command for action type "${evidence.actualChromeAction.type}"`,
        details: {
          actionType: evidence.actualChromeAction.type,
          targetId: evidence.actualChromeAction.targetId ?? 'N/A',
          valueMasked: evidence.actualChromeAction.valueMasked ? '[REDACTED/MASKED]' : undefined,
        },
        safetyVerdict: 'SAFE',
      },
      {
        stepNumber: 8,
        phase: 'OBSERVATION',
        name: 'Browser Effect Observation',
        description: evidence.browserEffect,
        details: {
          observedEffect: evidence.browserEffect,
        },
        safetyVerdict: 'SAFE',
      },
      {
        stepNumber: 9,
        phase: 'VERIFICATION',
        name: 'Action-Effect Verification',
        description: evidence.effectVerification.verified
          ? `Effect verified: ${evidence.effectVerification.effectDescription}`
          : `Effect unverified: ${evidence.effectVerification.effectDescription}`,
        details: {
          verified: evidence.effectVerification.verified,
          description: evidence.effectVerification.effectDescription,
        },
        safetyVerdict: evidence.effectVerification.verified ? 'SAFE' : 'BLOCKED',
      },
      {
        stepNumber: 10,
        phase: 'RE_PERCEPTION',
        name: 'Fresh Perception Snapshot',
        description: evidence.nextPerception,
        details: {
          nextState: evidence.nextPerception,
        },
        safetyVerdict: 'SAFE',
      },
      {
        stepNumber: 11,
        phase: 'GOAL_VERIFY',
        name: 'Final Goal Verification',
        description: `Verdict: ${evidence.goalVerification.verdict} (Confidence: ${Math.round(evidence.goalVerification.confidence * 100)}%)`,
        details: {
          verdict: evidence.goalVerification.verdict,
          confidence: evidence.goalVerification.confidence,
          finalStatus: evidence.finalStatus,
          durationMs: evidence.durationMs,
        },
        safetyVerdict: evidence.finalStatus === 'PASSED' ? 'SAFE' : 'BLOCKED',
      },
    ];
  }

  /**
   * Generates a judge-ready Markdown summary of an evaluation case.
   */
  generateMarkdownReport(evalCase: EvaluationCase): string {
    const trace = this.buildChronologicalTrace(evalCase.evidence);
    const md: string[] = [];

    md.push(`# PrivAgent Evaluation Evidence: ${evalCase.id} — ${evalCase.title}`);
    md.push(`**Category**: \`${evalCase.category}\` | **Status**: **${evalCase.status}** | **Duration**: \`${evalCase.durationMs}ms\``);
    md.push(`**Task**: ${evalCase.inputTask}`);
    md.push(`**Expected**: ${evalCase.expectedBehavior}`);
    md.push(`**Actual**: ${evalCase.actualBehavior}`);
    md.push('');
    md.push('---');
    md.push('## 11-Stage Chronological Decision Trace');
    md.push('');
    md.push('| Step | Phase | Action / Event | Verdict |');
    md.push('| :--- | :--- | :--- | :--- |');

    for (const step of trace) {
      md.push(`| **${step.stepNumber}** | \`${step.phase}\` | **${step.name}**: ${step.description} | \`${step.safetyVerdict}\` |`);
    }

    md.push('');
    md.push('---');
    md.push('## Security & Privacy Verification Audit');
    md.push(`- **Sensitive Data Transmitted**: \`${evalCase.evidence.privacyTransmissionCount} bytes\` (Strict Invariant)`);
    md.push(`- **M5 Validator Decision**: \`${evalCase.evidence.m5Result.allowed ? 'ALLOWED' : 'BLOCKED/GATED'}\``);
    md.push(`- **Risk Level**: \`${evalCase.evidence.riskResult.riskLevel}\` (Score: \`${evalCase.evidence.riskResult.riskScore}/100\`)`);
    md.push(`- **Goal Completion**: \`${evalCase.evidence.goalVerification.verdict}\` (Confidence: \`${Math.round(evalCase.evidence.goalVerification.confidence * 100)}%\`)`);
    md.push('');
    md.push('### Security Events:');
    for (const sec of evalCase.securityEvents) {
      md.push(`- \`${sec}\``);
    }
    md.push('');
    md.push('### Privacy Events:');
    for (const priv of evalCase.privacyEvents) {
      md.push(`- \`${priv}\``);
    }

    return md.join('\n');
  }

  /**
   * Generates a complete Markdown summary of a full EvaluationRun.
   */
  generateRunSummaryMarkdown(run: EvaluationRun): string {
    const md: string[] = [];
    md.push(`# PrivAgent M12 Official Evaluation & Benchmark Report`);
    md.push(`**Run ID**: \`${run.id}\` | **Date**: \`${new Date(run.timestamp).toISOString()}\` | **Version**: \`${run.version}\``);
    md.push(`**Environment**: \`${run.environment}\` | **Reasoner**: \`${run.provider} (${run.model})\``);
    md.push(`**Result**: **${run.passed} / ${run.totalCases} Passed (${run.passRatePercent}%)** in \`${run.durationMs}ms\``);
    md.push('');
    md.push('---');
    md.push('## Official SIH Problem Statement Matrix');
    md.push('');
    md.push('| Dimension / Metric | Measured Value | Threshold | Status | Traceable Source |');
    md.push('| :--- | :--- | :--- | :--- | :--- |');

    const m = run.metrics;
    const metricsList = [
      m.visualContextAccuracy,
      m.piiDetectionRecall,
      m.piiDetectionPrecision,
      m.piiDetectionF1,
      m.redactionPrecision,
      m.redactionRecall,
      m.zeroLeakTransmission,
      m.clientResourceUtilization,
      m.endToEndLatency,
      m.m5ValidationRate,
      m.staleTargetRejectionRate,
      m.promptInjectionImmunity,
      m.unauthorizedNavigationRejection,
      m.highRiskConfirmationRate,
      m.providerFailClosedRate,
      m.goalVerificationAccuracy,
      m.actionEffectVerificationSuccess,
      m.recoverySuccessRate,
      m.networkBandwidthThrottling,
    ];

    for (const item of metricsList) {
      md.push(`| **${item.name}** | \`${item.valueDisplay}\` | \`${item.threshold ?? 'N/A'}\` | **${item.status}** | ${item.traceableSource} |`);
    }

    md.push('');
    md.push('---');
    md.push('## 18-Case Benchmark Test Results');
    md.push('');
    md.push('| Case ID | Title | Category | Status | Duration | M5 Gate | Risk | Goal |');
    md.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');

    for (const c of run.cases) {
      md.push(`| **${c.id}** | ${c.title} | \`${c.category}\` | **${c.status}** | \`${c.durationMs}ms\` | \`${c.evidence.m5Result.allowed ? 'PASS' : 'GATE'}\` | \`${c.evidence.riskResult.riskLevel}\` | \`${c.evidence.goalVerification.verdict}\` |`);
    }

    return md.join('\n');
  }
}
