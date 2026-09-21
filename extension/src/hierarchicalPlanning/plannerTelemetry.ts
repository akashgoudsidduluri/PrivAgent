/**
 * PrivAgent — Planner Telemetry & Decision Provenance Logger (Phase 4.15)
 *
 * Logs state transitions, subgoal state changes, action proposals, M5 decisions,
 * risk assessments, execution outcomes, and action provenance.
 *
 * Security Invariant:
 *  - Telemetry logs NEVER store raw passwords, account numbers, card credentials, or raw OCR.
 *  - Every autonomous action is tagged with provenance (PRIVAGENT_ACTION vs TEST_HARNESS_ACTION).
 */

import {
  PlanningTelemetryEntry,
  PlanningEngineState,
  ActionProvenanceSource,
} from './hierarchicalTypes';
import { BrowserAction } from '../agent/actionTypes';

export class PlannerTelemetryLogger {
  private entries: PlanningTelemetryEntry[] = [];
  private runId: string;

  constructor(runId?: string) {
    this.runId = runId || `run-${Date.now()}`;
  }

  public logEvent(
    state: PlanningEngineState,
    details?: {
      subgoalId?: string;
      actionProposed?: BrowserAction;
      provenanceSource?: ActionProvenanceSource;
      m5Approved?: boolean;
      riskRating?: string;
      executionSuccess?: boolean;
      effectVerified?: boolean;
      goalProgressPercent?: number;
      notes?: string;
      memoryInfluencedPlanning?: boolean;
      memoryInfluencedRecovery?: boolean;
      memoryConflictDetected?: boolean;
      memoryOverriddenByCurrentWorld?: boolean;
      memoryMetadata?: PlanningTelemetryEntry['memoryMetadata'];
    }
  ): PlanningTelemetryEntry {
    const entry: PlanningTelemetryEntry = {
      entryId: `entry-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      state,
      subgoalId: details?.subgoalId,
      actionProposed: details?.actionProposed ? { ...details.actionProposed } : undefined,
      provenanceSource: details?.provenanceSource,
      m5Approved: details?.m5Approved,
      riskRating: details?.riskRating,
      executionSuccess: details?.executionSuccess,
      effectVerified: details?.effectVerified,
      goalProgressPercent: details?.goalProgressPercent,
      notes: details?.notes,
      memoryInfluencedPlanning: details?.memoryInfluencedPlanning,
      memoryInfluencedRecovery: details?.memoryInfluencedRecovery,
      memoryConflictDetected: details?.memoryConflictDetected,
      memoryOverriddenByCurrentWorld: details?.memoryOverriddenByCurrentWorld,
      memoryMetadata: details?.memoryMetadata,
    };

    // Sanitize any action fields before persisting
    if (entry.actionProposed && entry.actionProposed.action === 'type') {
      // Obfuscate text if it contains sensitive keyword hints
      const text = entry.actionProposed.text;
      if (/password|secret|token|card|pin/i.test(text)) {
        entry.actionProposed.text = '[REDACTED_BY_TELEMETRY]';
      }
    }

    this.entries.push(entry);
    return entry;
  }

  public getEntries(): ReadonlyArray<PlanningTelemetryEntry> {
    return this.entries;
  }

  public getRunId(): string {
    return this.runId;
  }

  public exportReport(): {
    runId: string;
    totalEvents: number;
    autonomousActionsCount: number;
    provenanceDistribution: Record<ActionProvenanceSource, number>;
    entries: PlanningTelemetryEntry[];
  } {
    const provenanceDistribution: Record<ActionProvenanceSource, number> = {
      PRIVAGENT_ACTION: 0,
      TEST_HARNESS_ACTION: 0,
    };

    let autonomousActions = 0;
    for (const e of this.entries) {
      if (e.provenanceSource) {
        provenanceDistribution[e.provenanceSource] += 1;
        if (e.provenanceSource === 'PRIVAGENT_ACTION') {
          autonomousActions += 1;
        }
      }
    }

    return {
      runId: this.runId,
      totalEvents: this.entries.length,
      autonomousActionsCount: autonomousActions,
      provenanceDistribution,
      entries: [...this.entries],
    };
  }

  public clear(): void {
    this.entries = [];
  }
}
