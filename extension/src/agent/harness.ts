/**
 * PrivAgent — Phase 13: Harness (cycle coordination & runtime-state observation)
 *
 * The Harness answers ONE question at the top of every agent cycle:
 *
 *     MAY THIS CYCLE RUN, IN THE ENVIRONMENT THE AGENT IS ACTUALLY IN?
 *
 * ── What the Harness IS ─────────────────────────────────────────────────────
 *
 *   1. CYCLE COORDINATION — it observes the environment and the loop's own
 *      bounds and returns a verdict about whether the next perception cycle
 *      may start, continue, or must halt.
 *   2. RUNTIME-STATE OBSERVATION — it keeps a sanitized, value-free record of
 *      what it observed, so a run can be audited without a debugger.
 *
 * ── What the Harness is NOT ────────────────────────────────────────────────
 *
 *   IT IS NOT A SECURITY AUTHORITY, AND IT IS NOT AN ARBITER OF SECURITY.
 *
 *   It has no ALLOW / DENY / AUTHORIZE output anywhere in its surface. Its
 *   vocabulary is deliberately:
 *
 *       CONTINUE  ·  HALT_ENVIRONMENT  ·  BUDGET_EXHAUSTED  ·  TERMINAL
 *
 *   A CONTINUE verdict means only "the next cycle may run the pipeline". It is
 *   NOT permission to dispatch. On EVERY cycle the Harness allows, the full
 *   authoritative pipeline runs unchanged and in the same order:
 *
 *       Target Grounding → M5 → Security Critic → Privacy Firewall →
 *       Risk/Confirmation → [5.5 Containment] → Dispatch →
 *       Effect Verification → Goal Verification → Recovery Engine
 *
 *   Concretely, and this is the central invariant of the phase:
 *
 *       HARNESS = CONTINUE → M5 = REFUSED          → NO DISPATCH
 *       HARNESS = CONTINUE → CRITIC = BLOCK        → NO DISPATCH
 *       HARNESS = CONTINUE → CONTAINMENT = DENIED → NO DISPATCH
 *
 *   REASONING ≠ AUTHORITY is unchanged. The reasoner still proposes; the local
 *   pipeline still decides what can actually happen.
 *
 * ── Relationship to Phase 12 containment ───────────────────────────────────
 *
 *   Containment OWNS the environmental boundary. It defines the scope, and its
 *   primitives — `isContainableScheme`, `hostWithinScope`, `isDashboardOrigin`,
 *   `containmentSummary` — define what "inside the boundary" means.
 *
 *   The Harness CONSUMES that boundary. It never creates a scope, never widens
 *   or narrows one, never reinterprets one, and never re-derives the root host.
 *   It asks Phase 12's own questions at a different moment in the cycle.
 *
 *   The service worker's live dispatch-time containment check remains the
 *   authoritative last-line boundary and is untouched by this phase. The two
 *   are complementary and deliberately both exist:
 *
 *       Harness        → "should this perception cycle run?"   (before perception)
 *       Service worker → "is this real dispatch still inside?"  (at dispatch)
 *
 * ── Relationship to the loop's bounds ──────────────────────────────────────
 *
 *   The Harness holds NO bounds of its own. Every bound it checks is supplied
 *   by the loop on each call, and the comparison operators mirror the loop's
 *   own checks exactly, so the two can never drift into competing limit sets
 *   and the Harness can never terminate a run the loop would have continued.
 *   The existing stop check and max-steps check in the loop remain
 *   authoritative; the Harness observes and mirrors them as a backstop.
 *
 * ── When the Harness makes no claim ────────────────────────────────────────
 *
 *   A host that supplies no containment scope gets no environmental claim: the
 *   Harness records `scopeEstablished: false` and asserts nothing. This mirrors
 *   the Phase 12 rule that "no scope" means "no configured environment", not
 *   "an open sandbox".
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 *
 *   Pure functions only: no network, no clock-dependent policy, no model call,
 *   no browser API. Identical inputs always produce an identical verdict and an
 *   identical record. Unknown or malformed input FAILS CLOSED.
 */

import {
  hostWithinScope,
  isContainableScheme,
  containmentSummary,
  type ContainmentCode,
  type ContainmentScope,
} from './containment';
import type { TaskStatus } from './agentState';

// ── Verdict vocabulary ────────────────────────────────────────────────────────

/**
 * The four things the Harness can say about a cycle.
 *
 * Deliberately there is no ALLOW, no DENY, no AUTHORIZE and no PERMIT. The
 * Harness coordinates cycles; the existing security modules decide what may be
 * dispatched, and they do so entirely without reference to this type.
 */
export type HarnessVerdict =
  /** The next perception cycle may run the pipeline. NOT permission to dispatch. */
  | 'CONTINUE'
  /** The environment the agent is in is no longer the one the task resolved to. */
  | 'HALT_ENVIRONMENT'
  /** One of the loop's own bounds is spent. */
  | 'BUDGET_EXHAUSTED'
  /** The task is stopping: it was halted, or it is no longer in progress. */
  | 'TERMINAL';

/**
 * Why a cycle did not continue.
 *
 * Environment halts REUSE the Phase 12 `ContainmentCode` values rather than
 * inventing a parallel taxonomy, so a halt is reported in exactly the language
 * the boundary itself uses. The remaining codes describe the loop's own
 * bookkeeping, which containment has no vocabulary for.
 */
export type HarnessHaltCode =
  // Phase 12 containment codes, reused verbatim (never redefined here).
  | ContainmentCode
  | 'MAX_STEPS_EXHAUSTED'
  | 'RETRY_BUDGET_EXHAUSTED'
  | 'RECOVERY_BUDGET_EXHAUSTED'
  | 'STOP_REQUESTED'
  | 'TASK_NOT_IN_PROGRESS';

// ── Observation shapes ───────────────────────────────────────────────────────

/**
 * The bounds as the LOOP sees them. Supplied on every call; the Harness stores
 * no bounds of its own, so it can never disagree with the loop about a limit.
 */
export interface HarnessBounds {
  maxSteps: number;
  maxRetries: number;
  maxTotalRecoveries: number;
}

/**
 * What the Harness observed about the environment. `withinScope` is `null`
 * whenever the Harness declines to make a claim — either because no scope was
 * established, or because the live environment is not a determinable web
 * origin. "Not observed" is never silently reported as "inside".
 */
export interface HarnessEnvironmentObservation {
  /** A Phase 12 containment scope was available to observe. */
  scopeEstablished: boolean;
  /** A live URL was available to check. */
  liveUrlKnown: boolean;
  /** True/False when determinable, `null` when no claim is made. */
  withinScope: boolean | null;
  /** True/False when determinable, `null` when no claim is made. */
  tabMatchesScope: boolean | null;
  /** The Phase 12 code for this observation, or `null` when none applies. */
  code: ContainmentCode | null;
  /** Deterministic, value-free explanation. Never contains a URL. */
  reason: string;
}

/**
 * The loop's own counters, mirrored. These are observed, never owned: the
 * Harness holds no counter of its own and can never double-count.
 */
export interface HarnessBudgetObservation {
  step: number;
  maxSteps: number;
  retryCount: number;
  maxRetries: number;
  recoveryAttempts: number;
  maxTotalRecoveries: number;
}

/** One sanitized, value-free record per cycle. */
export interface HarnessCycleRecord {
  cycle: number;
  verdict: HarnessVerdict;
  haltCode: HarnessHaltCode | null;
  environment: HarnessEnvironmentObservation;
  budget: HarnessBudgetObservation;
  /** Phase 12 scope summary, e.g. `contained:example.com` or `contained:none`. */
  containmentScopeSummary: string;
  perceptionGeneration: number;
}

export interface HarnessDecision {
  verdict: HarnessVerdict;
  haltCode: HarnessHaltCode | null;
  /** Deterministic, value-free explanation. Never contains a URL or page text. */
  reason: string;
  record: HarnessCycleRecord;
}

export interface HarnessCycleInput {
  /** 1-based cycle counter, supplied by the run. */
  cycle: number;
  /** The loop's current status. */
  status: TaskStatus;
  /** True when the user/host has asked the task to stop. */
  stopRequested: boolean;
  /** The Phase 12 containment scope. Null ⇒ no environmental claim. */
  containmentScope: ContainmentScope | null;
  /** The tab the agent is pinned to. */
  targetTabId: number | null;
  /** The last known URL of the environment. Null ⇒ not determinable. */
  liveUrl: string | null;
  /** The loop's own bounds. */
  bounds: HarnessBounds;
  step: number;
  retryCount: number;
  recoveryAttempts: number;
  perceptionGeneration: number;
}

// ── Pure evaluation ──────────────────────────────────────────────────────────

/** Non-finite or negative numbers are never treated as a valid bound. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Resolve the host of a web URL, or null when it is not a containable web
 * origin. `about:blank` resolves to null but is NOT drift: it is the empty
 * pre-load environment, exactly as Phase 12 already treats it.
 */
function observableHost(liveUrl: string): { host: string | null; blank: boolean } {
  const trimmed = liveUrl.trim();
  if (/^about:blank$/i.test(trimmed)) return { host: null, blank: true };
  if (!isContainableScheme(trimmed)) return { host: null, blank: false };
  try {
    return { host: new URL(trimmed).hostname.toLowerCase(), blank: false };
  } catch {
    return { host: null, blank: false };
  }
}

/**
 * Observe the environment against the Phase 12 scope. Pure: it only ASKS
 * Phase 12's primitives what the boundary is; it never defines one.
 */
function observeEnvironment(input: HarnessCycleInput): {
  observation: HarnessEnvironmentObservation;
  haltCode: HarnessHaltCode | null;
  reason: string;
} {
  const scope = input.containmentScope;

  if (!scope) {
    // No scope is not an open sandbox claim; it is simply no configured
    // environment. The Harness asserts nothing.
    return {
      observation: {
        scopeEstablished: false,
        liveUrlKnown: false,
        withinScope: null,
        tabMatchesScope: null,
        code: null,
        reason: 'No containment scope is configured; the harness claims no environment.',
      },
      haltCode: null,
      reason: 'No environmental boundary is configured for this run.',
    };
  }

  // A scope the Harness cannot even read is a fail-closed halt, not a guess.
  if (typeof scope.rootHost !== 'string' || scope.rootHost.trim() === '') {
    return {
      observation: {
        scopeEstablished: true,
        liveUrlKnown: false,
        withinScope: null,
        tabMatchesScope: null,
        code: 'MALFORMED_INPUT',
        reason: 'The configured containment scope is malformed; the harness cannot observe it.',
      },
      haltCode: 'MALFORMED_INPUT',
      reason: 'The configured containment scope is malformed; refusing to run another cycle.',
    };
  }

  // Tab containment. The agent may only run a cycle in the tab it was pinned
  // to. This is Phase 12's TAB_SCOPE_VIOLATION, asked one step earlier.
  const tabMatchesScope =
    typeof scope.tabId === 'number' ? input.targetTabId === scope.tabId : null;
  if (tabMatchesScope === false) {
    return {
      observation: {
        scopeEstablished: true,
        liveUrlKnown: false,
        withinScope: null,
        tabMatchesScope: false,
        code: 'TAB_SCOPE_VIOLATION',
        reason: 'The agent is not pinned to the tab this task was contained to.',
      },
      haltCode: 'TAB_SCOPE_VIOLATION',
      reason:
        'The agent is no longer pinned to the tab this task was contained to; refusing to run another cycle.',
    };
  }

  // Live environment containment, using Phase 12's own rule.
  if (typeof input.liveUrl === 'string' && input.liveUrl.trim() !== '') {
    const { host, blank } = observableHost(input.liveUrl);

    if (host === null && !blank) {
      return {
        observation: {
          scopeEstablished: true,
          liveUrlKnown: true,
          withinScope: false,
          tabMatchesScope,
          code: 'UNSUPPORTED_SCHEME_DENIED',
          reason: 'The agent is no longer on a containable web origin.',
        },
        haltCode: 'UNSUPPORTED_SCHEME_DENIED',
        reason:
          'The agent is no longer on a containable web origin; refusing to perceive or act on it.',
      };
    }

    if (host !== null && !hostWithinScope(host, scope.rootHost)) {
      return {
        observation: {
          scopeEstablished: true,
          liveUrlKnown: true,
          withinScope: false,
          tabMatchesScope,
          code: 'SCOPE_DRIFT_DETECTED',
          reason: 'The environment has left the containment scope for this task.',
        },
        haltCode: 'SCOPE_DRIFT_DETECTED',
        reason:
          'The environment has left the containment scope for this task; refusing to run another cycle.',
      };
    }

    if (host !== null) {
      return {
        observation: {
          scopeEstablished: true,
          liveUrlKnown: true,
          withinScope: true,
          tabMatchesScope,
          code: 'WITHIN_SCOPE',
          reason: 'The environment is inside the containment scope for this task.',
        },
        haltCode: null,
        reason: 'The environment is inside the containment scope; the cycle may run.',
      };
    }
  }

  // A blank or unknown environment is NOT drift and NOT a claim.
  return {
    observation: {
      scopeEstablished: true,
      liveUrlKnown: typeof input.liveUrl === 'string' && input.liveUrl.trim() !== '',
      withinScope: null,
      tabMatchesScope,
      code: null,
      reason: 'The environment is not yet a determinable web origin; no claim is made.',
    },
    haltCode: null,
    reason: 'The environment is not yet determinable; the cycle may run.',
  };
}

/**
 * Evaluate one cycle. Pure and deterministic: the same input always yields the
 * same verdict and the same record. Malformed input fails closed.
 */
export function evaluateHarnessCycle(input: HarnessCycleInput): HarnessDecision {
  const malformed = (reason: string): HarnessDecision => {
    const observation: HarnessEnvironmentObservation = {
      scopeEstablished: false,
      liveUrlKnown: false,
      withinScope: null,
      tabMatchesScope: null,
      code: 'MALFORMED_INPUT',
      reason: 'Malformed harness input; the harness makes no claim.',
    };
    return {
      verdict: 'TERMINAL',
      haltCode: 'MALFORMED_INPUT',
      reason: 'Malformed harness input; failing closed.',
      record: {
        cycle: isCount(input?.cycle) ? input.cycle : 0,
        verdict: 'TERMINAL',
        haltCode: 'MALFORMED_INPUT',
        environment: observation,
        budget: {
          step: 0,
          maxSteps: 0,
          retryCount: 0,
          maxRetries: 0,
          recoveryAttempts: 0,
          maxTotalRecoveries: 0,
        },
        containmentScopeSummary: containmentSummary(null),
        perceptionGeneration: 0,
      },
    };
  };

  if (typeof input !== 'object' || input === null) return malformed('not an object');

  const { bounds } = input;
  if (
    typeof bounds !== 'object' ||
    bounds === null ||
    !isCount(bounds.maxSteps) ||
    !isCount(bounds.maxRetries) ||
    !isCount(bounds.maxTotalRecoveries)
  ) {
    return malformed('bounds are missing or not finite non-negative counts');
  }
  if (
    !isCount(input.cycle) ||
    !isCount(input.step) ||
    !isCount(input.retryCount) ||
    !isCount(input.recoveryAttempts) ||
    !isCount(input.perceptionGeneration)
  ) {
    return malformed('counters are missing or not finite non-negative counts');
  }

  const finish = (
    verdict: HarnessVerdict,
    haltCode: HarnessHaltCode | null,
    reason: string,
    observation: HarnessEnvironmentObservation
  ): HarnessDecision => ({
    verdict,
    haltCode,
    reason,
    record: {
      cycle: input.cycle,
      verdict,
      haltCode,
      environment: observation,
      budget: {
        step: input.step,
        maxSteps: bounds.maxSteps,
        retryCount: input.retryCount,
        maxRetries: bounds.maxRetries,
        recoveryAttempts: input.recoveryAttempts,
        maxTotalRecoveries: bounds.maxTotalRecoveries,
      },
      containmentScopeSummary: containmentSummary(input.containmentScope ?? null),
      perceptionGeneration: input.perceptionGeneration,
    },
  });

  // 1. The run is over: it is neither in progress, nor still running.
  if (input.status !== 'IN_PROGRESS') {
    return finish(
      'TERMINAL',
      'TASK_NOT_IN_PROGRESS',
      'The task is no longer in progress; the harness will not start another cycle.',
      {
        scopeEstablished: false,
        liveUrlKnown: false,
        withinScope: null,
        tabMatchesScope: null,
        code: null,
        reason: 'The task is no longer in progress; no environment was observed.',
      }
    );
  }

  // 2. A stop was requested. The loop's own stop handling remains
  //    authoritative; this is the same determination in harness vocabulary.
  if (input.stopRequested === true) {
    return finish(
      'TERMINAL',
      'STOP_REQUESTED',
      'A stop was requested; the harness will not start another cycle.',
      {
        scopeEstablished: false,
        liveUrlKnown: false,
        withinScope: null,
        tabMatchesScope: null,
        code: null,
        reason: 'A stop was requested; no environment was observed.',
      }
    );
  }

  // 3. The environment. This is the capability the phase adds: the first and
  //    only point at which a cycle is refused BEFORE any perception happens.
  const env = observeEnvironment(input);
  if (env.haltCode) {
    return finish('HALT_ENVIRONMENT', env.haltCode, env.reason, env.observation);
  }

  // 4. The loop's own bounds, mirrored with the loop's own operators. These
  //    are backstops: the loop already terminates on each of these, so the
  //    harness can never end a run the loop would have continued.
  if (input.step >= bounds.maxSteps) {
    return finish(
      'BUDGET_EXHAUSTED',
      'MAX_STEPS_EXHAUSTED',
      `Task exceeded maximum step limit of ${bounds.maxSteps}.`,
      env.observation
    );
  }
  if (input.retryCount > bounds.maxRetries) {
    return finish(
      'BUDGET_EXHAUSTED',
      'RETRY_BUDGET_EXHAUSTED',
      `Retry budget of ${bounds.maxRetries} is spent.`,
      env.observation
    );
  }
  if (input.recoveryAttempts > bounds.maxTotalRecoveries) {
    return finish(
      'BUDGET_EXHAUSTED',
      'RECOVERY_BUDGET_EXHAUSTED',
      `Task recovery budget of ${bounds.maxTotalRecoveries} is spent.`,
      env.observation
    );
  }

  return finish('CONTINUE', null, 'The cycle may run the existing pipeline.', env.observation);
}

// ── The run record ───────────────────────────────────────────────────────────

/** Bounded history: a task cannot exceed maxSteps cycles, but the bound is explicit. */
export const MAX_HARNESS_CYCLE_RECORDS = 64;

export interface HarnessRunSummary {
  /** Deterministic, derived from the task text. Never the task text itself. */
  runId: string;
  cycles: number;
  continueCount: number;
  haltCount: number;
  lastVerdict: HarnessVerdict;
  lastHaltCode: HarnessHaltCode | null;
  history: HarnessCycleRecord[];
  historyTruncated: boolean;
}

/** Stable, deterministic, value-free id derivation (djb2, base36). */
function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The bounded Harness run: cycle coordination plus a sanitized record.
 *
 * It holds NO policy and NO bounds. Every bound arrives per call from the loop,
 * and the only state it keeps is the cycle counter and the bounded record — so
 * a Harness can never drift out of step with the loop it coordinates.
 */
export class AgentHarness {
  runId = 'harness-run-uninitialized';
  cycles = 0;
  continueCount = 0;
  haltCount = 0;
  lastVerdict: HarnessVerdict = 'TERMINAL';
  lastHaltCode: HarnessHaltCode | null = null;
  historyTruncated = false;
  private readonly history: HarnessCycleRecord[] = [];

  /** Task-lifetime reset. A new task starts with a fresh run and fresh record. */
  initialize(task: string): void {
    this.runId = `harness-run-${stableHash(typeof task === 'string' ? task : '')}`;
    this.cycles = 0;
    this.continueCount = 0;
    this.haltCount = 0;
    this.lastVerdict = 'TERMINAL';
    this.lastHaltCode = null;
    this.historyTruncated = false;
    this.history.length = 0;
  }

  runCycle(input: Omit<HarnessCycleInput, 'cycle'>): HarnessDecision {
    this.cycles += 1;
    const decision = evaluateHarnessCycle({ ...input, cycle: this.cycles });

    this.lastVerdict = decision.verdict;
    this.lastHaltCode = decision.haltCode;
    if (decision.verdict === 'CONTINUE') {
      this.continueCount += 1;
    } else {
      this.haltCount += 1;
    }

    if (this.history.length < MAX_HARNESS_CYCLE_RECORDS) {
      this.history.push(decision.record);
    } else {
      this.historyTruncated = true;
    }

    return decision;
  }

  summary(): HarnessRunSummary {
    return {
      runId: this.runId,
      cycles: this.cycles,
      continueCount: this.continueCount,
      haltCount: this.haltCount,
      lastVerdict: this.lastVerdict,
      lastHaltCode: this.lastHaltCode,
      history: [...this.history],
      historyTruncated: this.historyTruncated,
    };
  }
}

/** Short, stable, value-free audit line for a harness decision. */
export function describeHarnessDecision(decision: HarnessDecision): string {
  return `HARNESS_${decision.verdict}${decision.haltCode ? `_${decision.haltCode}` : ''}`;
}
