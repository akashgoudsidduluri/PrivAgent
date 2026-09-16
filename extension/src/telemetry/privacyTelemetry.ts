/**
 * PrivAgent — Safe Privacy & Performance Telemetry (Milestone 7/8 & SIH)
 *
 * Implements structured, privacy-preserving telemetry that tracks safe operational
 * metadata and latency metrics across the entire perception -> privacy -> reasoning -> execution loop.
 *
 * Security Invariants:
 *  - STRICTLY ZERO raw sensitive values (passwords, card numbers, accounts, PANs, OTPs, raw DOM, raw OCR).
 *  - Only counts, durations, identifiers, categories, and boolean outcomes.
 *  - Asserts safety invariants on every recorded telemetry entry.
 */

export interface LatencyBreakdown {
  domScanMs?: number;
  ocrMs?: number;
  privacyFusionMs?: number;
  minimizationMs?: number;
  llmReasoningMs?: number;
  browserExecutionMs?: number;
  totalWallMs?: number;
}

export interface TaskTelemetryRecord {
  taskId: string;
  taskLength: number;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  result?: 'SUCCESS' | 'FAILED' | 'STOPPED' | 'NEEDS_USER_CONFIRMATION';
  errorKind?: string;
  errorMessage?: string;

  // Counts & Categories (Metadata only)
  detectionCount: number;
  redactionCount: number;
  sanitizedContextCount: number;
  categoriesDetected: string[];

  // Execution Stats
  llmRequestCount: number;
  actionCount: number;
  successfulActionsCount: number;
  failedActionsCount: number;

  // Latency Metrics
  latencies: LatencyBreakdown;
  provider?: string;
  model?: string;
}

const FORBIDDEN_TELEMETRY_KEYS = new Set([
  'value', 'text', 'textcontent', 'innertext', 'rawtext',
  'rawocr', 'ocrtext', 'password', 'words', 'lines',
  'token', 'secret', 'card', 'cardnumber', 'cvv',
  'pan', 'accountnumber', 'raw', 'input', 'sensitivevalue', 'pii',
]);

/**
 * Validates that a telemetry record strictly contains zero forbidden raw sensitive keys.
 */
export function assertNoSensitiveDataInTelemetry(data: unknown, path = '<telemetry>'): void {
  if (data === null || data === undefined) return;
  if (typeof data === 'object') {
    if (Array.isArray(data)) {
      data.forEach((item, idx) => assertNoSensitiveDataInTelemetry(item, `${path}[${idx}]`));
    } else {
      for (const key of Object.keys(data as Record<string, unknown>)) {
        const norm = key.toLowerCase().replace(/_/g, '');
        if (FORBIDDEN_TELEMETRY_KEYS.has(norm) || FORBIDDEN_TELEMETRY_KEYS.has(key.toLowerCase())) {
          throw new Error(
            `[PrivAgent Telemetry Violation] Forbidden sensitive key '${key}' detected at '${path}.${key}'. ` +
            'Telemetry must never store or transmit raw sensitive information.'
          );
        }
        assertNoSensitiveDataInTelemetry((data as Record<string, unknown>)[key], `${path}.${key}`);
      }
    }
  }
}

export class PrivacyTelemetryCollector {
  private activeRecords: Map<string, TaskTelemetryRecord> = new Map();
  private history: TaskTelemetryRecord[] = [];
  private readonly maxHistory = 50;

  startTask(taskId: string, taskLength: number): TaskTelemetryRecord {
    const record: TaskTelemetryRecord = {
      taskId,
      taskLength,
      startTime: Date.now(),
      detectionCount: 0,
      redactionCount: 0,
      sanitizedContextCount: 0,
      categoriesDetected: [],
      llmRequestCount: 0,
      actionCount: 0,
      successfulActionsCount: 0,
      failedActionsCount: 0,
      latencies: {},
    };
    this.activeRecords.set(taskId, record);
    return record;
  }

  recordPerception(
    taskId: string,
    stats: {
      detectionsCount: number;
      categories: string[];
      domScanMs?: number;
      ocrMs?: number;
      fusionMs?: number;
    }
  ): void {
    const record = this.activeRecords.get(taskId);
    if (!record) return;

    record.detectionCount += stats.detectionsCount;
    for (const cat of stats.categories) {
      if (!record.categoriesDetected.includes(cat)) {
        record.categoriesDetected.push(cat);
      }
    }
    if (stats.domScanMs) record.latencies.domScanMs = (record.latencies.domScanMs || 0) + stats.domScanMs;
    if (stats.ocrMs) record.latencies.ocrMs = (record.latencies.ocrMs || 0) + stats.ocrMs;
    if (stats.fusionMs) record.latencies.privacyFusionMs = (record.latencies.privacyFusionMs || 0) + stats.fusionMs;
  }

  recordMinimization(taskId: string, stats: { sanitizedElementsCount: number; minimizationMs?: number }): void {
    const record = this.activeRecords.get(taskId);
    if (!record) return;

    record.sanitizedContextCount = stats.sanitizedElementsCount;
    if (stats.minimizationMs) {
      record.latencies.minimizationMs = (record.latencies.minimizationMs || 0) + stats.minimizationMs;
    }
  }

  recordLLMRequest(
    taskId: string,
    info: {
      latencyMs: number;
      provider: string;
      model?: string;
      errorKind?: string;
    }
  ): void {
    const record = this.activeRecords.get(taskId);
    if (!record) return;

    record.llmRequestCount++;
    record.provider = info.provider;
    if (info.model) record.model = info.model;
    record.latencies.llmReasoningMs = (record.latencies.llmReasoningMs || 0) + info.latencyMs;
    if (info.errorKind) record.errorKind = info.errorKind;
  }

  recordAction(taskId: string, stats: { success: boolean; durationMs?: number }): void {
    const record = this.activeRecords.get(taskId);
    if (!record) return;

    record.actionCount++;
    if (stats.success) {
      record.successfulActionsCount++;
    } else {
      record.failedActionsCount++;
    }
    if (stats.durationMs) {
      record.latencies.browserExecutionMs = (record.latencies.browserExecutionMs || 0) + stats.durationMs;
    }
  }

  finishTask(
    taskId: string,
    outcome: {
      result: 'SUCCESS' | 'FAILED' | 'STOPPED' | 'NEEDS_USER_CONFIRMATION';
      errorMessage?: string;
      errorKind?: string;
    }
  ): TaskTelemetryRecord | undefined {
    const record = this.activeRecords.get(taskId);
    if (!record) return undefined;

    record.endTime = Date.now();
    record.durationMs = record.endTime - record.startTime;
    record.latencies.totalWallMs = record.durationMs;
    record.result = outcome.result;
    if (outcome.errorMessage) record.errorMessage = outcome.errorMessage;
    if (outcome.errorKind) record.errorKind = outcome.errorKind;

    // Safety verification before archiving
    assertNoSensitiveDataInTelemetry(record);

    this.activeRecords.delete(taskId);
    this.history.unshift(record);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }
    return record;
  }

  getRecord(taskId: string): TaskTelemetryRecord | undefined {
    return this.activeRecords.get(taskId) || this.history.find((r) => r.taskId === taskId);
  }

  getHistory(): TaskTelemetryRecord[] {
    return [...this.history];
  }

  clear(): void {
    this.activeRecords.clear();
    this.history = [];
  }
}

export const privacyTelemetry = new PrivacyTelemetryCollector();
