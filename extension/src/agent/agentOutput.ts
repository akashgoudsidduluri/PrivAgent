/**
 * PrivAgent — Phase 14: Agent Interaction & Output Layer
 *
 * A pure, read-only PROJECTION of agent state into a small, value-free,
 * user-facing interaction state — plus the output-privacy boundary that every
 * user-facing string must cross.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * PrivAgent's core is strong: task → Harness → AgentLoop → perception →
 * planning → security gates → browser → verification → recovery. What it has
 * never had is a way to TALK to the user while it does that.
 *
 * The dashboard currently receives the raw `AgentTaskState` and infers a
 * "current stage" by substring-matching an English `reason` string. It drops
 * eleven state fields. There is no result, no live activity line, and no
 * structured terminal outcome — only internal prose.
 *
 * This module is the missing translation. It is a PROJECTION, nothing more.
 *
 * ── The three rules that make it safe ──────────────────────────────────────
 *
 *   1. READ-ONLY AND ONE-WAY. It takes state and returns a new value. It has
 *      no write path back into `AgentTaskState`, no callback, no side effect.
 *      It therefore cannot influence the loop, the Harness, containment, or
 *      any security gate. There is no code path from here back into authority.
 *
 *   2. NARROWING. The projection is strictly smaller than its input. It can
 *      only OMIT. It never invents a fact the agent did not already compute.
 *
 *   3. NO CHAIN-OF-THOUGHT. The user sees operational status, never reasoning.
 *      Internal `reason` prose, validation reasons, execution errors, model
 *      rationale and the decision trace are READ INTERNALLY to classify an
 *      outcome into a stable code, and then DISCARDED. Only closed-vocabulary
 *      codes and composed headlines cross the boundary.
 *
 * ── The output-privacy seam ────────────────────────────────────────────────
 *
 * `screenAgentOutput()` is that seam, and it is deliberately minimal: it uses
 * the EXISTING `scanForRawSensitiveValues` primitive and nothing else. No new
 * classification system, no NLP, no OCR, no fusion engine.
 *
 * It runs in the SERVICE WORKER, immediately before `sendToDashboard` — the
 * same last-line position the service worker already uses for dispatch-time
 * containment. The two are mirror images:
 *
 *     CONTAINMENT (Phase 12)  protects what the agent DOES
 *     OUTPUT SCREEN (Phase 14) protects what the agent SAYS
 *
 * Screening in the frontend would be display-time cosmetics, not a boundary.
 * Anything can be sent from a browser tab; the service worker is the last
 * place the data is still ours.
 *
 * It FAILS CLOSED. A malformed projection is not displayed — it is replaced
 * with a safe, empty, terminal-FAILED interaction state. A raw-value shape
 * found in a STRUCTURAL field (a closed-vocabulary code) means the projection
 * is corrupt, and the whole payload is dropped rather than half-trusted.
 */

import type { AgentTaskState } from './agentState';
import type { PlanningEngineState } from '../hierarchicalPlanning/hierarchicalTypes';
import type { ContainmentCode } from './containment';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';

// ── Public vocabulary ────────────────────────────────────────────────────────

/** The user-visible lifecycle. Closed vocabulary; never free text. */
export type AgentOutcome =
  | 'IDLE'
  | 'RUNNING'
  | 'AWAITING_CONFIRMATION'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'STOPPED';

/**
 * Where the agent is, as a coarse operational phase. Derived from the EXISTING
 * `planningEngineState` (14 real states) rather than by guessing from prose.
 */
export type AgentActivityPhase =
  | 'IDLE'
  | 'PERCEPTION'
  | 'PLANNING'
  | 'VALIDATION'
  | 'EXECUTION'
  | 'VERIFICATION'
  | 'RECOVERY'
  | 'AWAITING_CONFIRMATION'
  | 'TERMINAL';

/**
 * Why a run ended, as a stable code. This is what replaces the internal
 * `reason` prose at the user boundary: the classification reads prose locally,
 * and only the CODE is ever surfaced.
 */
export type AgentTerminalReason =
  | 'GOAL_ACHIEVED'
  | 'STOPPED_BY_USER'
  | 'CONTAINMENT_DENIED'
  | 'HARNESS_HALTED'
  | 'RECOVERY_EXHAUSTED'
  | 'STEP_BOUND_EXHAUSTED'
  | 'REASONER_FAILED'
  | 'PERCEPTION_FAILED'
  | 'CONFIRMATION_DECLINED'
  | 'UNKNOWN';

export interface AgentActivity {
  phase: AgentActivityPhase;
  /** Concise operational status. Composed from a fixed table, never raw. */
  summary: string;
  step: number;
  maxSteps: number;
  /** The Phase 13 harness cycle counter, when a harness is armed. */
  cycle: number | null;
}

export interface AgentTerminal {
  outcome: Extract<AgentOutcome, 'SUCCEEDED' | 'FAILED' | 'STOPPED'>;
  reason: AgentTerminalReason;
  /** Composed headline. Never the internal `state.reason` string. */
  headline: string;
}

export interface AgentResultItem {
  id: string;
  /** Page-derived display text. THE highest-risk field in the output, and
   *  therefore the field `screenAgentOutput` exists to guard. */
  title: string;
  detail: string;
}

export interface AgentResult {
  kind: 'NONE' | 'FINDINGS' | 'CANDIDATES';
  summary: string;
  count: number;
  items: AgentResultItem[];
}

export type AgentArtifactKind =
  | 'CONTAINMENT'
  | 'HARNESS'
  | 'RECOVERY'
  | 'FAILURE'
  | 'PERCEPTION';

export interface AgentArtifact {
  kind: AgentArtifactKind;
  /** Value-free label, e.g. `contained:google.com` or a failure code. */
  label: string;
}

export interface AgentTimelineEntry {
  step: number;
  /** Action type only — 'click', 'navigate', … never a target or a value. */
  action: string;
  outcome: 'EXECUTED' | 'BLOCKED' | 'FAILED' | 'CONFIRMED';
}

export interface AgentInteractionState {
  outcome: AgentOutcome;
  activity: AgentActivity;
  terminal: AgentTerminal | null;
  result: AgentResult;
  artifacts: AgentArtifact[];
  /** Bounded, value-free operational history. Never reasoning. */
  timeline: AgentTimelineEntry[];
  awaitingConfirmation: {
    action: string;
    description: string;
    riskLevel: string;
  } | null;
}

// ── Fixed copy tables ────────────────────────────────────────────────────────

const PHASE_SUMMARY: Record<AgentActivityPhase, string> = {
  IDLE: 'Idle.',
  PERCEPTION: 'Reading the page.',
  PLANNING: 'Deciding the next step.',
  VALIDATION: 'Checking the action against local policy.',
  EXECUTION: 'Acting in the browser.',
  VERIFICATION: 'Confirming the result.',
  RECOVERY: 'Recovering from a failure.',
  AWAITING_CONFIRMATION: 'Waiting for your confirmation.',
  TERMINAL: 'Finished.',
};

const TERMINAL_HEADLINE: Record<AgentTerminalReason, string> = {
  GOAL_ACHIEVED: 'Goal achieved.',
  STOPPED_BY_USER: 'Stopped at your request.',
  CONTAINMENT_DENIED: 'Stopped: the agent left the environment it was allowed to act in.',
  HARNESS_HALTED: 'Stopped: the run was halted before it could continue safely.',
  RECOVERY_EXHAUSTED: 'Failed: recovery attempts were used up.',
  STEP_BOUND_EXHAUSTED: 'Failed: the step limit was reached.',
  REASONER_FAILED: 'Failed: the reasoning model was unavailable.',
  PERCEPTION_FAILED: 'Failed: the page could not be read.',
  CONFIRMATION_DECLINED: 'Stopped: the action was declined.',
  UNKNOWN: 'Failed.',
};

/** Failure-record categories that mean "the reasoner did not answer". */
const REASONER_FAILURES: ReadonlySet<string> = new Set([
  'PROVIDER_TIMEOUT',
  'LLM_RATE_LIMIT',
  'INVALID_MODEL_RESPONSE',
]);

/** Bounded timelines. A task cannot exceed maxSteps, but the bound is explicit. */
export const MAX_AGENT_TIMELINE_ENTRIES = 32;
/** Bounded result items. */
export const MAX_AGENT_RESULT_ITEMS = 10;

// ── Phase derivation ─────────────────────────────────────────────────────────

/**
 * Map the existing plan-state machine onto a coarse operational phase.
 *
 * This uses the REAL `planningEngineState` the loop already maintains. It does
 * not infer anything from prose, and it introduces no new state machine.
 */
export function phaseFromPlanningState(state?: string): AgentActivityPhase {
  const map: Record<PlanningEngineState, AgentActivityPhase> = {
    UNINITIALIZED: 'IDLE',
    DECOMPOSING: 'PLANNING',
    SUBGOAL_SELECTION: 'PLANNING',
    DYNAMIC_REPLANNING: 'RECOVERY',
    TARGET_GROUNDING: 'VALIDATION',
    M5_VALIDATION: 'VALIDATION',
    RISK_POLICY_CHECK: 'VALIDATION',
    USER_CONFIRMATION: 'AWAITING_CONFIRMATION',
    CHROME_EXECUTION: 'EXECUTION',
    EFFECT_VERIFICATION: 'VERIFICATION',
    GOAL_VERIFICATION: 'VERIFICATION',
    COMPLETED: 'TERMINAL',
    FAILED: 'TERMINAL',
    ABORTED: 'TERMINAL',
  };
  return map[state as PlanningEngineState] ?? 'IDLE';
}

// ── The projection ───────────────────────────────────────────────────────────

function isTerminalStatus(status: string): boolean {
  return status === 'SUCCESS' || status === 'FAILED' || status === 'STOPPED';
}

/**
 * Classify WHY a run ended, using internal evidence.
 *
 * The evidence — including `state.reason` — is read HERE and does not leave.
 * Only the resulting code crosses to the user. This is what keeps chain of
 * thought and internal gate prose off the screen.
 */
function classifyTerminalReason(s: AgentTaskState): AgentTerminalReason {
  if (s.status === 'SUCCESS') return 'GOAL_ACHIEVED';
  if (s.status === 'STOPPED') {
    return /declin|reject/i.test(s.reason ?? '') ? 'CONFIRMATION_DECLINED' : 'STOPPED_BY_USER';
  }

  // Environmental refusals win: they are why the run ended, not what it hit.
  if (s.containmentDecision && s.containmentDecision.contained === false) {
    return 'CONTAINMENT_DENIED';
  }
  if (s.harnessRun && s.harnessRun.lastVerdict === 'HALT_ENVIRONMENT') {
    return 'HARNESS_HALTED';
  }
  if (s.harnessRun && s.harnessRun.lastVerdict === 'BUDGET_EXHAUSTED') {
    return s.harnessRun.lastHaltCode === 'RECOVERY_BUDGET_EXHAUSTED'
      ? 'RECOVERY_EXHAUSTED'
      : 'STEP_BOUND_EXHAUSTED';
  }

  const lastCategory = s.lastFailure?.category;
  if (lastCategory) {
    if (REASONER_FAILURES.has(lastCategory)) return 'REASONER_FAILED';
    if (lastCategory === 'RECOVERY_EXHAUSTED') return 'RECOVERY_EXHAUSTED';
    if (lastCategory === 'CONTAINMENT_DENIED') return 'CONTAINMENT_DENIED';
  }

  if (/^Perception failed/i.test(s.reason ?? '')) return 'PERCEPTION_FAILED';
  if (/^Agent reasoning failed/i.test(s.reason ?? '')) return 'REASONER_FAILED';
  if (s.currentStep >= s.maxSteps) return 'STEP_BOUND_EXHAUSTED';

  return 'UNKNOWN';
}

function buildArtifacts(s: AgentTaskState): AgentArtifact[] {
  const out: AgentArtifact[] = [];
  if (s.containmentDecision) {
    out.push({
      kind: 'CONTAINMENT',
      label: `${s.containmentDecision.code}:${s.containmentDecision.scope}`,
    });
  }
  if (s.harnessRun && s.harnessRun.cycles > 0) {
    out.push({
      kind: 'HARNESS',
      label: `${s.harnessRun.cycles} cycle(s), ${s.harnessRun.haltCount} halt(s)`,
    });
  }
  if (typeof s.totalRecoveryAttempts === 'number' && s.totalRecoveryAttempts > 0) {
    out.push({ kind: 'RECOVERY', label: `${s.totalRecoveryAttempts} attempt(s)` });
  }
  if (s.lastFailure) {
    out.push({ kind: 'FAILURE', label: s.lastFailure.category });
  }
  if (s.perceptionGeneration > 0) {
    out.push({ kind: 'PERCEPTION', label: `${s.perceptionGeneration} cycle(s)` });
  }
  return out;
}

function buildResult(s: AgentTaskState): AgentResult {
  const candidates = Array.isArray(s.candidateItems) ? s.candidateItems : [];
  if (candidates.length > 0) {
    return {
      kind: 'CANDIDATES',
      summary: `${candidates.length} matching result(s) found.`,
      count: candidates.length,
      items: candidates.slice(0, MAX_AGENT_RESULT_ITEMS).map((c) => ({
        id: c.id,
        title: typeof c.title === 'string' ? c.title : 'item',
        detail: c.matchesConstraints ? 'matches the stated constraints' : 'partially matches',
      })),
    };
  }

  const findings = Array.isArray(s.currentFindings) ? s.currentFindings : [];
  if (findings.length > 0) {
    return {
      kind: 'FINDINGS',
      summary: `${findings.length} finding(s).`,
      count: findings.length,
      items: findings.slice(0, MAX_AGENT_RESULT_ITEMS).map((f, i) => ({
        id: `finding-${i + 1}`,
        title: typeof f === 'string' ? f : 'finding',
        detail: 'reported on the current page',
      })),
    };
  }

  return { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] };
}

function buildTimeline(s: AgentTaskState): AgentTimelineEntry[] {
  const steps = Array.isArray(s.steps) ? s.steps : [];
  return steps.slice(-MAX_AGENT_TIMELINE_ENTRIES).map((step) => ({
    step: step.step,
    action: step.action?.action ?? 'unknown',
    // The outcome is structural. The ERROR and REASON strings stay behind.
    outcome: step.executionSuccess
      ? 'EXECUTED'
      : step.validationAllowed
        ? 'FAILED'
        : 'BLOCKED',
  }));
}

/**
 * Project authoritative agent state into the user-facing interaction state.
 *
 * Pure, deterministic, and read-only. It performs no I/O, calls no model, and
 * mutates nothing — including its own argument.
 */
export function projectAgentOutput(state: AgentTaskState): AgentInteractionState {
  if (typeof state !== 'object' || state === null) {
    return safeBlockedProjection('UNKNOWN');
  }

  // The loop only ever produces TaskStatus values, but the service worker's
  // hand-built handshake payloads use 'RUNNING' for the same meaning. It is
  // read here explicitly rather than cast away, so the widening is visible.
  const status = state.status as AgentTaskState['status'] | 'RUNNING';

  // The first cycle has not yet run the plan state machine; it is perceiving.
  const isFirstCycle = !Array.isArray(state.steps) || state.steps.length === 0;
  let phase: AgentActivityPhase = phaseFromPlanningState(state.planningEngineState);
  if ((status === 'IN_PROGRESS' || status === 'RUNNING') && isFirstCycle) {
    phase = 'PERCEPTION';
  }
  if (status === 'NEEDS_USER_CONFIRMATION') {
    phase = 'AWAITING_CONFIRMATION';
  }

  let outcome: AgentOutcome = 'IDLE';
  // 'RUNNING' is the status the service worker uses for its hand-built
  // handshakes; 'IN_PROGRESS' is the loop's own status for the same idea.
  if (status === 'IN_PROGRESS' || status === 'RUNNING') outcome = 'RUNNING';
  if (status === 'NEEDS_USER_CONFIRMATION') outcome = 'AWAITING_CONFIRMATION';
  if (isTerminalStatus(status)) {
    outcome = status === 'SUCCESS' ? 'SUCCEEDED' : status === 'STOPPED' ? 'STOPPED' : 'FAILED';
  }

  const terminal: AgentTerminal | null = isTerminalStatus(status)
    ? (() => {
        const reason = classifyTerminalReason(state);
        return {
          outcome: outcome as AgentTerminal['outcome'],
          reason,
          headline: TERMINAL_HEADLINE[reason],
        };
      })()
    : null;

  const activity: AgentActivity = {
    phase: terminal ? 'TERMINAL' : phase,
    summary: PHASE_SUMMARY[terminal ? 'TERMINAL' : phase],
    step: state.currentStep ?? 0,
    maxSteps: state.maxSteps ?? 0,
    cycle: state.harnessRun?.cycles ?? null,
  };

  const awaiting =
    status === 'NEEDS_USER_CONFIRMATION' && state.requiresUserConfirmationAction
      ? {
          action: state.requiresUserConfirmationAction.action,
          // Type + risk only. The target id and destination URL are internal.
          description:
            state.requiresUserConfirmationAction.action === 'navigate'
              ? 'Navigate to a requested destination'
              : 'Interact with a control on the current page',
          riskLevel:
            state.steps.length > 0
              ? (state.steps[state.steps.length - 1]?.riskAssessment?.riskLevel ?? 'HIGH')
              : 'HIGH',
        }
      : null;

  return {
    outcome,
    activity,
    terminal,
    result: buildResult(state),
    artifacts: buildArtifacts(state),
    timeline: buildTimeline(state),
    awaitingConfirmation: awaiting,
  };
}

// ── Output screening — the privacy seam ─────────────────────────────────────

export type OutputScreenVerdict = 'CLEAR' | 'REDACTED' | 'BLOCKED';

export interface OutputScreenResult {
  verdict: OutputScreenVerdict;
  /** The payload that may be emitted. Never null: a blocked payload is a safe
   *  empty projection, so a caller cannot accidentally forward the original. */
  output: AgentInteractionState;
  /** Number of raw-value shapes found. Count only, never the value. */
  findings: number;
  /** Deterministic, value-free explanation. */
  reason: string;
}

/** The payload emitted when screening fails closed. */
function safeBlockedProjection(reason: AgentTerminalReason): AgentInteractionState {
  return {
    outcome: 'FAILED',
    activity: { phase: 'TERMINAL', summary: PHASE_SUMMARY.TERMINAL, step: 0, maxSteps: 0, cycle: null },
    terminal: { outcome: 'FAILED', reason, headline: TERMINAL_HEADLINE[reason] },
    result: { kind: 'NONE', summary: 'No result available.', count: 0, items: [] },
    artifacts: [],
    timeline: [],
    awaitingConfirmation: null,
  };
}

function isTripped(value: string): boolean {
  return scanForRawSensitiveValues(value, { structuralKeys: new Set() }).length > 0;
}

/** Structural fields come from a closed vocabulary; a hit there means corruption. */
function structureIsClean(o: AgentInteractionState): boolean {
  return ![
    o.outcome,
    o.activity.phase,
    o.activity.summary,
    o.activity.cycle === null ? '' : String(o.activity.cycle),
    o.terminal?.headline ?? '',
    o.terminal?.reason ?? '',
    o.result.kind,
    o.result.summary,
    ...o.timeline.map((t) => `${t.action}:${t.outcome}`),
    ...o.artifacts.map((a) => `${a.kind}:${a.label}`),
  ].some(isTripped);
}

/**
 * Screen a user-facing projection before it leaves the service worker.
 *
 * MINIMAL BY DESIGN: it establishes the boundary using the existing
 * `scanForRawSensitiveValues` primitive and nothing more. It is not a
 * classification system, and it is where a fuller output-privacy layer would
 * later attach without moving the boundary.
 *
 * FAIL-CLOSED in two distinct ways:
 *  - a malformed projection is replaced wholesale with a safe empty payload;
 *  - a raw-value shape in a CLOSED-VOCABULARY field drops the whole payload,
 *    because a corrupt structural field cannot be half-trusted.
 *
 * A raw-value shape in a page-derived DISPLAY field is redacted in place, so a
 * legitimate result is not lost to one bad title.
 */
export function screenAgentOutput(output: AgentInteractionState): OutputScreenResult {
  if (typeof output !== 'object' || output === null || typeof output.outcome !== 'string') {
    return {
      verdict: 'BLOCKED',
      output: safeBlockedProjection('UNKNOWN'),
      findings: 0,
      reason: 'Malformed interaction payload; failing closed.',
    };
  }

  if (!structureIsClean(output)) {
    return {
      verdict: 'BLOCKED',
      output: safeBlockedProjection('UNKNOWN'),
      findings: 1,
      reason: 'Structural field failed output screening; whole payload dropped.',
    };
  }

  let findings = 0;
  const items = output.result.items.map((item) => {
    if (isTripped(item.title)) {
      findings += 1;
      return { ...item, title: '[redacted]', detail: 'withheld by output screening' };
    }
    if (isTripped(item.detail)) {
      findings += 1;
      return { ...item, detail: 'withheld by output screening' };
    }
    return item;
  });

  if (findings > 0) {
    return {
      verdict: 'REDACTED',
      output: { ...output, result: { ...output.result, items } },
      findings,
      reason: `${findings} result field(s) redacted by output screening.`,
    };
  }

  return { verdict: 'CLEAR', output, findings: 0, reason: 'Output passed screening.' };
}

/** Stable, value-free audit line for an output-screening decision. */
export function describeOutputScreen(result: OutputScreenResult): string {
  return `OUTPUT_SCREEN_${result.verdict} (${result.findings} finding(s))`;
}
