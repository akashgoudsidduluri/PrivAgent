import { describe, it, expect } from 'vitest';
import {
  PrivacyTelemetryCollector,
  assertNoSensitiveDataInTelemetry,
} from '../extension/src/telemetry/privacyTelemetry';
import {
  calculatePrecisionRecall,
  calculateLatencyDistribution,
  compileSIHEvaluationReport,
} from '../extension/src/telemetry/sihEvaluation';

describe('PrivAgent Telemetry & SIH Evaluation Foundation Suite', () => {
  describe('Privacy Telemetry Safety Invariants', () => {
    it('records task stages and latencies without sensitive information', () => {
      const collector = new PrivacyTelemetryCollector();
      collector.startTask('task-101', 30);

      collector.recordPerception('task-101', {
        detectionsCount: 4,
        categories: ['account_number', 'password'],
        domScanMs: 12.5,
        ocrMs: 25.0,
        fusionMs: 2.1,
      });

      collector.recordMinimization('task-101', {
        sanitizedElementsCount: 4,
        minimizationMs: 1.5,
      });

      collector.recordLLMRequest('task-101', {
        latencyMs: 340,
        provider: 'backend',
        model: 'google/gemma-2-9b-it:free',
      });

      collector.recordAction('task-101', {
        success: true,
        durationMs: 45,
      });

      const finished = collector.finishTask('task-101', {
        result: 'SUCCESS',
      });

      expect(finished).toBeDefined();
      expect(finished?.result).toBe('SUCCESS');
      expect(finished?.detectionCount).toBe(4);
      expect(finished?.categoriesDetected).toEqual(['account_number', 'password']);
      expect(finished?.llmRequestCount).toBe(1);
      expect(finished?.actionCount).toBe(1);
      expect(finished?.successfulActionsCount).toBe(1);
      expect(finished?.latencies.domScanMs).toBe(12.5);
      expect(finished?.latencies.llmReasoningMs).toBe(340);

      // Must strictly satisfy the zero-PII assertion
      expect(() => assertNoSensitiveDataInTelemetry(finished)).not.toThrow();
    });

    it('REJECTS telemetry records containing forbidden raw sensitive value keys', () => {
      const contaminated = {
        taskId: 'leak-1',
        password: 'rawPasswordValue',
      };
      expect(() => assertNoSensitiveDataInTelemetry(contaminated)).toThrow(/Forbidden sensitive key 'password'/i);

      const contaminatedValue = {
        taskId: 'leak-2',
        inner: { value: '4532015112830366' },
      };
      expect(() => assertNoSensitiveDataInTelemetry(contaminatedValue)).toThrow(/Forbidden sensitive key 'value'/i);
    });
  });

  describe('SIH Benchmark Calculation Foundation', () => {
    it('accurately calculates precision, recall, and F1 score from confusion matrix', () => {
      const matrix = {
        truePositives: 90,
        falsePositives: 10,
        falseNegatives: 10,
      };
      const res = calculatePrecisionRecall(matrix);

      expect(res.precision).toBe(0.9);
      expect(res.recall).toBe(0.9);
      expect(res.f1Score).toBe(0.9);
      expect(res.sampleCount).toBe(110);
    });

    it('computes accurate latency distribution percentiles (P50, P95, mean)', () => {
      // 100 samples from 1 to 100
      const samples = Array.from({ length: 100 }, (_, i) => i + 1);
      const dist = calculateLatencyDistribution(samples);

      expect(dist.minMs).toBe(1);
      expect(dist.maxMs).toBe(100);
      expect(dist.p50Ms).toBe(51);
      expect(dist.p95Ms).toBe(96);
      expect(dist.meanMs).toBe(50.5);
      expect(dist.sampleCount).toBe(100);
    });

    it('compiles comprehensive SIH evaluation report matching official dimensions', () => {
      const report = compileSIHEvaluationReport(
        { truePositives: 48, falsePositives: 2, falseNegatives: 2 },
        [120, 150, 180, 210, 240],
        [
          {
            domElementsCount: 50,
            detectionsCount: 4,
            redactedElementsCount: 4,
            scanDurationMs: 12,
            redactionDurationMs: 3,
          },
        ],
        0 // zero leakage
      );

      expect(report.piiDetection.precision).toBe(0.96);
      expect(report.piiDetection.recall).toBe(0.96);
      expect(report.redactionPrecision.leakageCount).toBe(0);
      expect(report.redactionPrecision.redactionScore).toBe(1.0);
      expect(report.resourceUtilization.averageDOMElementsScanned).toBe(50);
      expect(report.latencyDistribution.p50Ms).toBe(180);
    });
  });
});
