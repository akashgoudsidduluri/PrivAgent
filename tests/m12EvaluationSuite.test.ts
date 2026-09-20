import { describe, it, expect } from 'vitest';
import { M12EvaluationEngine } from '../extension/src/telemetry/evaluationEngine';
import { EvidenceManager } from '../extension/src/telemetry/evidenceManager';

describe('PrivAgent M12 — Evaluation Engine & Benchmark Matrix Suite', () => {
  it('runs all 18 deterministic benchmark cases (A through R) successfully', async () => {
    const engine = M12EvaluationEngine.getInstance();
    const run = await engine.runEvaluation();

    expect(run).toBeDefined();
    expect(run.totalCases).toBe(18);
    expect(run.passed).toBe(18);
    expect(run.failed).toBe(0);
    expect(run.passRatePercent).toBe(100.0);
    expect(run.cases.length).toBe(18);

    // Verify presence of all 18 specific case IDs
    const caseIds = run.cases.map((c) => c.id);
    const expectedIds = [
      'CASE-A', 'CASE-B', 'CASE-C', 'CASE-D', 'CASE-E', 'CASE-F',
      'CASE-G', 'CASE-H', 'CASE-I', 'CASE-J', 'CASE-K', 'CASE-L',
      'CASE-M', 'CASE-N', 'CASE-O', 'CASE-P', 'CASE-Q', 'CASE-R'
    ];
    expect(caseIds).toEqual(expectedIds);
  });

  it('strictly preserves the ZERO sensitive data transmission invariant across all cases', async () => {
    const engine = M12EvaluationEngine.getInstance();
    const run = await engine.runEvaluation();

    for (const c of run.cases) {
      expect(c.evidence.privacyTransmissionCount).toBe(0);
      if (c.evidence.actualChromeAction.valueMasked) {
        expect(c.evidence.actualChromeAction.valueMasked).not.toMatch(/password|secret|token|4532/i);
      }
    }
  });

  it('computes honest SIH evaluation metrics with distinct MEASURED, SUPPORTED, and NOT_YET_MEASURED tags', async () => {
    const engine = M12EvaluationEngine.getInstance();
    const run = await engine.runEvaluation();
    const m = run.metrics;

    // Measured metrics
    expect(m.visualContextAccuracy.status).toBe('MEASURED');
    expect(m.visualContextAccuracy.passed).toBe(true);

    expect(m.piiDetectionRecall.status).toBe('MEASURED');
    expect(m.piiDetectionRecall.numericValue).toBe(1.0);

    expect(m.redactionPrecision.status).toBe('MEASURED');
    expect(m.redactionPrecision.numericValue).toBe(1.0);

    expect(m.zeroLeakTransmission.status).toBe('MEASURED');
    expect(m.zeroLeakTransmission.numericValue).toBe(0);

    expect(m.m5ValidationRate.status).toBe('MEASURED');
    expect(m.m5ValidationRate.numericValue).toBe(1.0);

    expect(m.promptInjectionImmunity.status).toBe('MEASURED');
    expect(m.promptInjectionImmunity.numericValue).toBe(1.0);

    // Honest unmeasured metric
    expect(m.networkBandwidthThrottling.status).toBe('NOT_YET_MEASURED');
    expect(m.networkBandwidthThrottling.valueDisplay).toBe('Not measured');
  });

  it('generates complete 11-step chronological decision traces for evidence verification', async () => {
    const engine = M12EvaluationEngine.getInstance();
    const manager = EvidenceManager.getInstance();
    const run = await engine.runEvaluation();

    const caseA = run.cases.find((c) => c.id === 'CASE-A');
    expect(caseA).toBeDefined();

    const trace = manager.buildChronologicalTrace(caseA!.evidence);
    expect(trace.length).toBe(11);

    const phases = trace.map((t) => t.phase);
    expect(phases).toEqual([
      'INTENT',
      'PERCEPTION',
      'REASONING',
      'GROUNDING',
      'SAFETY_GATE',
      'RISK_POLICY',
      'EXECUTION',
      'OBSERVATION',
      'VERIFICATION',
      'RE_PERCEPTION',
      'GOAL_VERIFY',
    ]);

    const mdReport = manager.generateMarkdownReport(caseA!);
    expect(mdReport).toContain('# PrivAgent Evaluation Evidence: CASE-A');
    expect(mdReport).toContain('11-Stage Chronological Decision Trace');
    expect(mdReport).toContain('**Sensitive Data Transmitted**: `0 bytes`');
  });

  it('generates comprehensive run summary markdown for SIH problem statement review', async () => {
    const engine = M12EvaluationEngine.getInstance();
    const manager = EvidenceManager.getInstance();
    const run = await engine.runEvaluation();

    const summaryMd = manager.generateRunSummaryMarkdown(run);
    expect(summaryMd).toContain('PrivAgent M12 Official Evaluation & Benchmark Report');
    expect(summaryMd).toContain('Official SIH Problem Statement Matrix');
    expect(summaryMd).toContain('18-Case Benchmark Test Results');
    expect(summaryMd).toContain('CASE-A');
    expect(summaryMd).toContain('CASE-R');
  });
});
