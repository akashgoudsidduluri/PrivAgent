/**
 * PrivAgent — Planning Bounds & Loop Tripwires (Phase 4.9)
 *
 * Enforces hard operational boundaries on the autonomous planner:
 *  - MAX_SUBGOALS = 10
 *  - MAX_REPLANS = 3
 *  - MAX_TOTAL_ACTIONS = 15
 *  - MAX_REPEATED_FAILURES = 2
 *
 * Security Invariant:
 *  Prevents infinite loops, runaway recursion, prompt injection loops, or resource exhaustion.
 */

import { PlanningBounds, DEFAULT_PLANNING_BOUNDS } from './hierarchicalTypes';

export interface TripwireStatus {
  tripped: boolean;
  reason?: string;
  tripwireType?: 'MAX_SUBGOALS' | 'MAX_REPLANS' | 'MAX_ACTIONS' | 'REPEATED_FAILURE' | 'STATE_OSCILLATION';
}

export class PlanningBoundsEnforcer {
  private bounds: PlanningBounds;
  private actionCount: number = 0;
  private replanCount: number = 0;
  private subgoalCount: number = 0;
  private failureMap: Map<string, number> = new Map();
  private recentUrlHistory: string[] = [];

  constructor(bounds: PlanningBounds = DEFAULT_PLANNING_BOUNDS) {
    this.bounds = bounds;
  }

  public getBounds(): PlanningBounds {
    return { ...this.bounds };
  }

  public getActionCount(): number {
    return this.actionCount;
  }

  public getReplanCount(): number {
    return this.replanCount;
  }

  public recordAction(): TripwireStatus {
    this.actionCount += 1;
    if (this.actionCount > this.bounds.maxTotalActions) {
      return {
        tripped: true,
        tripwireType: 'MAX_ACTIONS',
        reason: `Exceeded maximum allowable total actions (${this.bounds.maxTotalActions}). Autonomy aborted to prevent runaway loop.`,
      };
    }
    return { tripped: false };
  }

  public recordReplan(): TripwireStatus {
    this.replanCount += 1;
    if (this.replanCount > this.bounds.maxReplans) {
      return {
        tripped: true,
        tripwireType: 'MAX_REPLANS',
        reason: `Exceeded maximum allowable dynamic replans (${this.bounds.maxReplans}). Autonomy aborted to prevent oscillation.`,
      };
    }
    return { tripped: false };
  }

  public recordSubgoals(count: number): TripwireStatus {
    this.subgoalCount = count;
    if (this.subgoalCount > this.bounds.maxSubgoals) {
      return {
        tripped: true,
        tripwireType: 'MAX_SUBGOALS',
        reason: `Exceeded maximum allowable subgoals (${this.bounds.maxSubgoals}). Decomposition bounded.`,
      };
    }
    return { tripped: false };
  }

  public recordFailure(key: string): TripwireStatus {
    const current = (this.failureMap.get(key) || 0) + 1;
    this.failureMap.set(key, current);

    if (current > this.bounds.maxRepeatedFailures) {
      return {
        tripped: true,
        tripwireType: 'REPEATED_FAILURE',
        reason: `Repeated failure threshold exceeded for "${key}" (${current} failures > limit of ${this.bounds.maxRepeatedFailures}).`,
      };
    }
    return { tripped: false };
  }

  public recordUrlVisit(url: string): TripwireStatus {
    if (!url) return { tripped: false };
    this.recentUrlHistory.push(url);

    // Detect immediate back-and-forth oscillation: A -> B -> A -> B
    const len = this.recentUrlHistory.length;
    if (len >= 4) {
      const [u1, u2, u3, u4] = this.recentUrlHistory.slice(-4);
      if (u1 === u3 && u2 === u4 && u1 !== u2) {
        return {
          tripped: true,
          tripwireType: 'STATE_OSCILLATION',
          reason: `Detected navigation oscillation between ${u1} and ${u2}. Tripwire triggered to prevent infinite loop.`,
        };
      }
    }
    return { tripped: false };
  }

  public reset(): void {
    this.actionCount = 0;
    this.replanCount = 0;
    this.subgoalCount = 0;
    this.failureMap.clear();
    this.recentUrlHistory = [];
  }
}
