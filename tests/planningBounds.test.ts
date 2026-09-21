import { describe, it, expect } from 'vitest';
import { PlanningBoundsEnforcer } from '../extension/src/hierarchicalPlanning/planningBounds';

describe('PrivAgent Phase 4 — Planning Bounds & Tripwires', () => {
  it('trips when maximum action count is exceeded (limit 15)', () => {
    const enforcer = new PlanningBoundsEnforcer({
      maxSubgoals: 10,
      maxReplans: 3,
      maxTotalActions: 15,
      maxRepeatedFailures: 2,
    });

    for (let i = 0; i < 15; i++) {
      const status = enforcer.recordAction();
      expect(status.tripped).toBe(false);
    }

    const overLimit = enforcer.recordAction();
    expect(overLimit.tripped).toBe(true);
    expect(overLimit.tripwireType).toBe('MAX_ACTIONS');
  });

  it('trips when maximum replan count is exceeded (limit 3)', () => {
    const enforcer = new PlanningBoundsEnforcer();
    for (let i = 0; i < 3; i++) {
      expect(enforcer.recordReplan().tripped).toBe(false);
    }
    const overLimit = enforcer.recordReplan();
    expect(overLimit.tripped).toBe(true);
    expect(overLimit.tripwireType).toBe('MAX_REPLANS');
  });

  it('trips when repeated failure threshold is breached for the same target (limit 2)', () => {
    const enforcer = new PlanningBoundsEnforcer();
    expect(enforcer.recordFailure('target-btn').tripped).toBe(false);
    expect(enforcer.recordFailure('target-btn').tripped).toBe(false);

    const thirdFailure = enforcer.recordFailure('target-btn');
    expect(thirdFailure.tripped).toBe(true);
    expect(thirdFailure.tripwireType).toBe('REPEATED_FAILURE');
  });

  it('detects back-and-forth URL navigation oscillation (A -> B -> A -> B)', () => {
    const enforcer = new PlanningBoundsEnforcer();
    expect(enforcer.recordUrlVisit('https://site.com/pageA').tripped).toBe(false);
    expect(enforcer.recordUrlVisit('https://site.com/pageB').tripped).toBe(false);
    expect(enforcer.recordUrlVisit('https://site.com/pageA').tripped).toBe(false);

    const oscillate = enforcer.recordUrlVisit('https://site.com/pageB');
    expect(oscillate.tripped).toBe(true);
    expect(oscillate.tripwireType).toBe('STATE_OSCILLATION');
  });
});
