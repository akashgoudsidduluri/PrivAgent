/**
 * PrivAgent — Long-Horizon Task State, Progress & Loop Recovery (Phase 9)
 *
 * Makes the agent reliable on LONGER multi-step tasks by remembering what it
 * has already accomplished in the CURRENT task, and refusing to blindly repeat
 * work that already failed or already completed.
 *
 * ── Design constraints (all enforced, none configurable away) ───────────────
 *  1. DETERMINISTIC + LOCAL. No model call, no network, no provider. The same
 *     state/action sequence always yields the same verdict. An LLM never
 *     decides whether a loop or a stall exists.
 *  2. EXTEND, NEVER DUPLICATE. This module owns no security authority. M5, the
 *     Security Critic, grounding, the privacy policy, risk assessment,
 *     confirmation, effect verification and goal verification all remain the
 *     authoritative gates and are untouched here. The reasoner still only
 *     proposes; nothing in this file can execute a browser action.
 *  3. FAIL CLOSED. Bounds are hard. On exhaustion the task ends in a terminal
 *     FAILED status with an explicit reason — it never continues indefinitely.
 *  4. VALUE-FREE. Only structural identifiers, categories, counts and
 *     fingerprints are stored and summarized. Raw sensitive values can never
 *     enter long-horizon state, memory, or the planner payload handed to the
 *     remote reasoner; the summary is scanned by the existing raw-value
 *     firewall before it is allowed out.
 *
 * Reuses the existing SubgoalGraph, PlanningBounds, memory managers and
 * AgentTaskState rather than introducing a second state-management system.
 */

import { BrowserAction } from './actionTypes';
import { AgentContextPayload } from '../privacy/types';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';
// PHASE 17.4. Reuses the Phase 17.3 document-identity primitive rather than
// inventing a second definition of "same page". No cycle: this contract
// imports only a type from effectVerifier.
// PHASE 18.7 / I-8 uses the SAME primitive (`normalizeDocumentIdentity`) for the
// semantic page-change signal, so "a hash-only URL change is not a new page"
// keeps exactly the meaning it had in 17.3/17.4.
import { normalizeDocumentIdentity } from '../ocr/ocrObservationContract';
// PHASE 18.7 / I-8. The ONE semantic-progress classifier. `assessProgress`
// below is a thin wrapper over it — this file remains the single owner of
// progress semantics, and nothing else in production may import the module.
import {
  DEFAULT_SEMANTIC_PROGRESS_BOUNDS,
  EMPTY_SEMANTIC_PROGRESS_BUDGET,
  SemanticProgressTracker,
  classifySemanticProgress,
  type GeometricSignal,
  type SemanticProgressBudgetState,
  type SemanticProgressSignal,
  type SemanticProgressVerdict,
  type ScrollDirection,
  type SemanticObservation,
  type StagnationKind,
} from './semanticProgress';
import {
  PlanningBounds,
  DEFAULT_PLANNING_BOUNDS,
  Subgoal,
  SubgoalGraphData,
} from '../hierarchicalPlanning/hierarchicalTypes';
import {
  MemoryTrustLevel,
  SiteScope,
  WorkingMemoryRecord,
  EpisodicMemoryRecord,
  FailureMemoryRecord,
} from '../memory/memoryTypes';
import {
  WorkingMemoryManager,
  EpisodicMemoryManager,
  FailureMemoryManager,
} from '../memory/memoryManager';

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Task-level bounds. Extends the EXISTING PlanningBounds rather than
 * introducing a second, competing bounds system. Conservative by default: a
 * long research task is expected to need more actions than a short one, but
 * every number here is a hard ceiling, not a target.
 */
export interface LongHorizonBounds extends PlanningBounds {
  /** Consecutive actions without meaningful progress before declaring a stall. */
  maxConsecutiveNoProgress: number;
  /** Occurrences of the same state+action fingerprint before a loop is declared. */
  maxRepeatedStates: number;
  /** Total no-progress actions across the whole task before failing closed. */
  maxStallActions: number;
  /** Size of the bounded recent-fingerprint ring buffer. */
  fingerprintWindow: number;
}

export const DEFAULT_LONG_HORIZON_BOUNDS: LongHorizonBounds = {
  ...DEFAULT_PLANNING_BOUNDS,
  maxTotalActions: 24,
  maxReplans: 4,
  maxRepeatedFailures: 2,
  maxConsecutiveNoProgress: 3,
  maxRepeatedStates: 2,
  maxStallActions: 5,
  fingerprintWindow: 8,
};

// ── Subgoal lifecycle ───────────────────────────────────────────────────────

export type LongHorizonSubgoalStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'BLOCKED' | 'FAILED';

export interface LongHorizonSubgoal {
  id: string;
  description: string;
  category: string;
  status: LongHorizonSubgoalStatus;
  attempts: number;
  /** Value-free failure note (a code or reason, never page/model text). */
  lastReason?: string;
}

/**
 * Deterministic legal transitions. Anything not listed is REJECTED — the
 * lifecycle fails closed. In particular COMPLETED is terminal, so a completed
 * subgoal cannot be silently reopened by a re-planner.
 */
const SUBGOAL_TRANSITIONS: Readonly<Record<LongHorizonSubgoalStatus, readonly LongHorizonSubgoalStatus[]>> = {
  // A subgoal must be ACTIVATED before it can complete, so completion is
  // always the result of observed work rather than a bookkeeping shortcut.
  PENDING: ['ACTIVE', 'BLOCKED', 'FAILED'],
  ACTIVE: ['COMPLETED', 'BLOCKED', 'FAILED'],
  COMPLETED: [],
  BLOCKED: ['ACTIVE', 'FAILED'],
  FAILED: ['ACTIVE', 'BLOCKED'],
};

export interface SubgoalTransitionResult {
  ok: boolean;
  reason: string;
}

/** Attempts a deterministic lifecycle transition. Never throws; never guesses. */
export function transitionSubgoal(
  subgoal: LongHorizonSubgoal,
  to: LongHorizonSubgoalStatus,
  reason?: string
): SubgoalTransitionResult {
  const allowed = SUBGOAL_TRANSITIONS[subgoal.status];
  if (!allowed) {
    return { ok: false, reason: `Unknown subgoal status '${subgoal.status}'.` };
  }
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: `Illegal subgoal transition ${subgoal.status} → ${to} for ${subgoal.id}.`,
    };
  }
  if (to === 'ACTIVE' && subgoal.status === 'ACTIVE') {
    return { ok: false, reason: `Subgoal ${subgoal.id} is already ACTIVE.` };
  }
  subgoal.status = to;
  if (to === 'ACTIVE') subgoal.attempts += 1;
  if (to === 'COMPLETED' || to === 'BLOCKED' || to === 'FAILED') {
    subgoal.lastReason = reason ?? (to === 'COMPLETED' ? 'completed' : 'blocked');
  }
  return { ok: true, reason: `${subgoal.status}` };
}

// ── Observations & progress ─────────────────────────────────────────────────

/**
 * The deterministic, structural view of "where the agent is right now".
 * Deliberately excludes any raw value: only URLs, ids, counts and positions.
 */
export interface TaskObservation {
  url: string;
  pageGeneration: number;
  /** Sorted semantic entity ids currently present. */
  entityIds: string[];
  /** Sorted interactive candidate ids currently present. */
  candidateIds: string[];
  /**
   * PHASE 18.7 / I-8. Sorted sanitized-fact ids currently present. IDS ONLY —
   * the display text stays in the sanitized context and never enters loop
   * state. Optional so a producer predating I-8 keeps its previous shape.
   */
  factIds?: string[];
  /** Sorted affordance ids currently present. IDS ONLY. */
  affordanceIds?: string[];
  scrollY: number;
  /** LENGTH ONLY of the targeted field's value — never the value itself. */
  targetValueLength: number;
  /**
   * PHASE 17.4. True when the geometry numbers above are real readings, false
   * when they are the all-zero fallback Phase 17.1 identified as "the ABSENCE
   * of a reading". Carried from `AgentContextPayload.viewportObservable` (the
   * 17.1 contract) so the long-horizon layer does not decode an unobservable
   * viewport as "scroll did not move".
   *
   * OPTIONAL, matching `AgentContextPayload.viewportObservable`, which is
   * optional in the 17.1 contract. `undefined` is read as "not asserted
   * unobservable" so a producer predating the flag keeps its previous
   * behaviour; only an explicit `false` suppresses the geometry signal. The one
   * production producer, `observeFromContext`, always sets it explicitly.
   */
  viewportObservable?: boolean;
}

export type ProgressSignal =
  | 'NEW_PAGE'
  | 'NEW_ENTITY'
  | 'NEW_CANDIDATE'
  | 'SUBGOAL_COMPLETED'
  | 'RELEVANT_STATE_CHANGED';

export interface ProgressAssessment {
  meaningful: boolean;
  signals: ProgressSignal[];
  fingerprint: string;
  /**
   * PHASE 18.7 / I-8. The bounded scroll-strategy verdict. `NONE` means the
   * scroll strategy is still viable; the other two are truthful stagnation
   * reports that recovery consumes. Never a task verdict.
   */
  stagnation: StagnationKind;
  /** What the viewport did. Recorded; never sufficient on its own. */
  geometry: GeometricSignal;
  /** Consecutive same-direction scrolls with no semantic signal. */
  sameDirectionRun: number;
  /** The scroll strategy has demonstrably had no effect. */
  budgetExhausted: boolean;
}

/** Build an observation from a sanitized context. Structure only. */
export function observeFromContext(
  context: AgentContextPayload,
  extra: { scrollY?: number; targetValueLength?: number } = {}
): TaskObservation {
  const entityIds = (context.semantic_context?.entities ?? []).map((e) => e.id).sort();
  const candidateIds = context.detections.map((d) => d.id).sort();
  // PHASE 18.7 / I-8. Semantic ids participate in the progress decision, so the
  // observation must carry them. NORMALIZED KEYS ONLY: a `SanitizedSemanticFact`
  // has no opaque id, and its `displayText`/`displayValue` are page-derived text
  // that must never enter loop state (it is persisted and can reach a summary).
  // A newly appearing fact KEY is the value-free evidence that a new kind of
  // fact is now observable; the ledger's own record count covers value changes.
  const factIds = [...new Set((context.semantic_context?.facts ?? []).map((f) => f.key))].sort();
  const affordanceIds = (context.semantic_context?.affordances ?? []).map((a) => a.id).sort();
  return {
    url: context.url,
    pageGeneration: context.semantic_context?.pageGeneration ?? 0,
    entityIds,
    candidateIds,
    factIds,
    affordanceIds,
    scrollY: extra.scrollY ?? 0,
    targetValueLength: extra.targetValueLength ?? 0,
    // PHASE 17.4. Absent flag means the 17.1 producer did not assert
    // observability. The field is OPTIONAL on AgentContextPayload, so an
    // absent flag is treated as observable (preserving pre-17.4 behaviour for
    // producers that predate the flag) but an explicit `false` is honoured.
    viewportObservable: context.viewportObservable !== false,
  };
}

// ── Deterministic fingerprinting ────────────────────────────────────────────

/** FNV-1a, 32-bit. Short, stable, dependency-free and fully deterministic. */
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Normalizes a URL to origin+path+query, dropping fragment and trailing noise. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`.replace(/\/+$/, '') || u.origin;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * A bounded, deterministic fingerprint of "same page state + same action".
 * Only the first few candidate ids participate, so a long list of unrelated
 * DOM nodes cannot mask a genuine loop.
 *
 * PHASE 17.4. The observed geometry now participates. It previously did not,
 * so a page that genuinely SCROLLED produced the same fingerprint as a page
 * that had not moved: legitimate repeated scrolling was indistinguishable from
 * a stuck page, and the loop detector fired on both. That is the "repeated
 * action with changing observed state" case the reliability model must NOT
 * treat as repetition.
 *
 * An UNOBSERVABLE viewport contributes a fixed marker rather than its numbers,
 * so "we could not read the geometry" is never confused with "the geometry did
 * not change" — the two must not collapse into one fingerprint.
 */
export function fingerprintObservation(
  observation: TaskObservation,
  // Structurally minimal on purpose. The fingerprint reads ONLY `action`
  // and `target` (see `actionPart` below), so it accepts a live
  // `BrowserAction` during the pipeline AND the value-free `RetainedAction`
  // read back from task state afterwards. Nothing here needs a value.
  action?: { action: string; target?: string }
): string {
  const url = normalizeUrl(observation.url);
  const topCandidates = observation.candidateIds.slice(0, 5).join(',');
  const topEntities = observation.entityIds.slice(0, 5).join(',');
  const actionPart = action
    ? `${action.action}:${String(action.target ?? '')}`
    : 'observe';
  const geometryPart =
    observation.viewportObservable === false
      ? 'geometry:unobservable'
      : `geometry:${observation.scrollY}:${observation.targetValueLength}`;
  return stableHash(`${url}|${topCandidates}|${topEntities}|${geometryPart}|${actionPart}`);
}

/**
 * Determines whether an observation represents MEANINGFUL task progress
 * relative to the previous one.
 *
 * Critically, a successful browser action is NOT by itself progress: an
 * effect-verified click that leaves the page, the entities and the targeted
 * state exactly where they were has moved the task nowhere.
 */
export function assessProgress(
  previous: TaskObservation | null,
  current: TaskObservation,
  opts: {
    subgoalJustCompleted?: string;
    discoveriesAdded?: number;
    evidenceDelta?: number;
    scrollDirection?: ScrollDirection | null;
  } = {},
  carry: SemanticProgressBudgetState = EMPTY_SEMANTIC_PROGRESS_BUDGET
): ProgressAssessment {
  const signals: ProgressSignal[] = [];
  //
  // PHASE 17.4. `observedChange` used to be what made progress MEANINGFUL.
  // It counted a CHANGED `scrollY` as an observed change, which is exactly how
  // an unbounded, individually-"productive", goal-ineffective scroll loop was
  // possible: every successful scroll produced a fresh fingerprint and reset
  // `consecutiveNoProgress`, so neither `detectLoop` nor `detectStall` could
  // ever fire and `maxSteps` was the only bound.
  //
  // PHASE 18.7 / I-8. The decision now comes from `classifySemanticProgress`,
  // the single semantic-progress authority. GEOMETRY IS NOT A SIGNAL: moving
  // the viewport changes where we look, not what we know. The Phase 17.4 rule
  // that a completed subgoal or a dispatch alone is not progress is preserved
  // exactly — those are still recorded in `signals` for the trace and still
  // cannot make a cycle meaningful on their own.
  const semantic: SemanticProgressVerdict = classifySemanticProgress(
    {
      previous: previous ? toSemanticObservation(previous) : null,
      current: toSemanticObservation(current),
      evidenceDelta: opts.evidenceDelta ?? 0,
      scrollDirection: opts.scrollDirection ?? null,
    },
    carry
  );
  const meaningful = semantic.meaningful;

  // The pre-existing trace vocabulary, preserved so existing consumers and
  // tests keep reading the same `signals`. Geometry alone now yields NO
  // progress signal at all — it is reported through `ProgressAssessment.geometry`.
  if (!previous) signals.push('NEW_PAGE');
  for (const signal of semantic.signals) {
    switch (signal) {
      case 'PAGE_IDENTITY_CHANGED':
        if (previous) signals.push('NEW_PAGE');
        break;
      case 'NEW_ENTITY':
        signals.push('NEW_ENTITY');
        break;
      case 'NEW_CANDIDATE':
        signals.push('NEW_CANDIDATE');
        break;
      case 'EVIDENCE_DELTA':
      case 'NEW_SEMANTIC_FACT':
      case 'NEW_AFFORDANCE':
        // Evidence and new sanitized facts ARE entity-level discoveries for the
        // trace, but they are not double-counted here: `semantic.signals`
        // already carries the precise code.
        break;
      case 'TARGET_VALUE_CHANGED':
        signals.push('RELEVANT_STATE_CHANGED');
        break;
    }
  }
  if (opts.subgoalJustCompleted) signals.push('SUBGOAL_COMPLETED');
  if ((opts.discoveriesAdded ?? 0) > 0) {
    signals.push('NEW_ENTITY');
    // A discovery is derived from an observed entity, so it is evidence too.
  }

  return {
    meaningful,
    signals,
    fingerprint: fingerprintObservation(current),
    stagnation: semantic.stagnation,
    geometry: semantic.geometry,
    sameDirectionRun: semantic.sameDirectionRun,
    budgetExhausted: semantic.budgetExhausted,
  };
}

/**
 * Narrow a `TaskObservation` to what the semantic-progress classifier reads.
 * `documentIdentity` reuses the existing 17.3 normalization, so a fragment-only
 * URL change is still the same document here.
 */
export function toSemanticObservation(observation: TaskObservation): SemanticObservation {
  return {
    // The 17.3 primitive, verbatim. A hash-only URL change is the same
    // document here for the same reason it was one in 17.4.
    documentIdentity: normalizeDocumentIdentity(observation.url) ?? observation.url,
    entityIds: observation.entityIds,
    candidateIds: observation.candidateIds,
    factIds: observation.factIds ?? [],
    affordanceIds: observation.affordanceIds ?? [],
    scrollY: observation.scrollY,
    targetValueLength: observation.targetValueLength,
    viewportObservable: observation.viewportObservable,
  };
}

// ── Loop / stall detection ──────────────────────────────────────────────────

export type LoopKind = 'REPEATED_STATE' | 'ALTERNATING_LOOP';

export interface LoopDetection {
  loop: boolean;
  kind?: LoopKind;
  occurrences: number;
  reason: string;
}

/**
 * Detects a loop from the BOUNDED, DETERMINISTIC fingerprint history. No model
 * is consulted — only string equality over a fixed-size window.
 */
export function detectLoop(
  fingerprints: readonly string[],
  bounds: Pick<LongHorizonBounds, 'maxRepeatedStates'>
): LoopDetection {
  if (fingerprints.length === 0) {
    return { loop: false, occurrences: 0, reason: 'No observations yet.' };
  }
  const current = fingerprints[fingerprints.length - 1]!;
  const occurrences = fingerprints.filter((f) => f === current).length;
  if (occurrences > bounds.maxRepeatedStates) {
    return {
      loop: true,
      kind: 'REPEATED_STATE',
      occurrences,
      reason: `The same page-state/action fingerprint occurred ${occurrences} times (limit ${bounds.maxRepeatedStates}).`,
    };
  }
  // A → B → A → B
  const n = fingerprints.length;
  if (
    n >= 4 &&
    fingerprints[n - 4] === fingerprints[n - 2] &&
    fingerprints[n - 3] === fingerprints[n - 1] &&
    fingerprints[n - 4] !== fingerprints[n - 3]
  ) {
    return {
      loop: true,
      kind: 'ALTERNATING_LOOP',
      occurrences: 2,
      reason: 'Alternating state sequence A → B → A → B detected.',
    };
  }
  return { loop: false, occurrences, reason: 'No loop detected.' };
}

export interface StallDetection {
  stalled: boolean;
  consecutiveNoProgress: number;
  totalNoProgress: number;
  reason: string;
  /**
   * PHASE 18.7 / I-8. WHICH kind of stagnation this is, taken from the single
   * semantic-progress classifier. Recovery consumes it verbatim so a truthful
   * `OSCILLATION` is never relabelled as generic no-effect.
   */
  kind: StagnationKind;
}

export function detectStall(
  consecutiveNoProgress: number,
  totalNoProgress: number,
  bounds: Pick<LongHorizonBounds, 'maxConsecutiveNoProgress'>,
  kind: StagnationKind = 'NO_EFFECT'
): StallDetection {
  if (consecutiveNoProgress >= bounds.maxConsecutiveNoProgress) {
    return {
      stalled: true,
      consecutiveNoProgress,
      totalNoProgress,
      kind,
      reason: `${consecutiveNoProgress} consecutive actions produced no meaningful progress (limit ${bounds.maxConsecutiveNoProgress}).`,
    };
  }
  return { stalled: false, consecutiveNoProgress, totalNoProgress, kind: 'NONE', reason: 'Task is still progressing.' };
}

// ── Hard bounds ─────────────────────────────────────────────────────────────

export type BoundExhaustion =
  | 'ACTION_BUDGET_EXHAUSTED'
  | 'REPLANNING_EXHAUSTED'
  | 'REPEATED_STATE_EXHAUSTED'
  | 'STALL_BUDGET_EXHAUSTED'
  | 'SUBGOAL_BUDGET_EXHAUSTED';

export interface BoundsCheck {
  exhausted: boolean;
  reason?: BoundExhaustion;
  detail?: string;
}

export function checkBounds(
  counters: {
    actionCount: number;
    recoveryCount: number;
    totalNoProgress: number;
    subgoalCount: number;
  },
  bounds: LongHorizonBounds
): BoundsCheck {
  if (counters.actionCount >= bounds.maxTotalActions) {
    return {
      exhausted: true,
      reason: 'ACTION_BUDGET_EXHAUSTED',
      detail: `Task reached the maximum of ${bounds.maxTotalActions} total actions.`,
    };
  }
  if (counters.recoveryCount >= bounds.maxReplans) {
    return {
      exhausted: true,
      reason: 'REPLANNING_EXHAUSTED',
      detail: `Task reached the maximum of ${bounds.maxReplans} recovery/replanning attempts.`,
    };
  }
  if (counters.totalNoProgress >= bounds.maxStallActions) {
    return {
      exhausted: true,
      reason: 'STALL_BUDGET_EXHAUSTED',
      detail: `Task accumulated ${counters.totalNoProgress} no-progress actions (limit ${bounds.maxStallActions}).`,
    };
  }
  if (counters.subgoalCount >= bounds.maxSubgoals) {
    return {
      exhausted: true,
      reason: 'SUBGOAL_BUDGET_EXHAUSTED',
      detail: `Task produced ${counters.subgoalCount} subgoals (limit ${bounds.maxSubgoals}).`,
    };
  }
  return { exhausted: false };
}

// ── Discovered results (value-free) ─────────────────────────────────────────

/**
 * A task-level discovery. STRUCTURE ONLY: a label plus where it came from.
 * There is deliberately no field able to hold a raw value.
 */
export interface TaskDiscovery {
  id: string;
  /** Short categorical/semantic label, e.g. an entity type or role name. */
  label: string;
  source: 'ENTITY' | 'CANDIDATE' | 'PAGE' | 'SUBGOAL' | 'RECOVERY';
  subgoalId?: string;
  url?: string;
  timestamp: number;
}

// ── The tracker ─────────────────────────────────────────────────────────────

export interface LongHorizonSnapshot {
  originalGoal: string;
  normalizedConstraints: string[];
  activeSubgoalId: string | null;
  pendingSubgoalIds: string[];
  completedSubgoalIds: string[];
  failedSubgoalIds: string[];
  blockedSubgoalIds: string[];
  discoveries: TaskDiscovery[];
  actionCount: number;
  recoveryCount: number;
  consecutiveNoProgress: number;
  totalNoProgress: number;
  recentFingerprints: string[];
  lastLoop?: { kind: LoopKind; reason: string };
  lastStallReason?: string;
  /** PHASE 18.7 / I-8. Bounded scroll-strategy verdict. Never a task verdict. */
  semanticProgress: SemanticProgressVerdict;
}

export class LongHorizonTracker {
  readonly bounds: LongHorizonBounds;
  private originalGoal = '';
  private constraints: string[] = [];
  private subgoals = new Map<string, LongHorizonSubgoal>();
  private discoveryList: TaskDiscovery[] = [];
  private discoveryIds = new Set<string>();
  private fingerprints: string[] = [];
  private lastObservation: TaskObservation | null = null;
  /**
   * PHASE 18.7 / I-8. The bounded scroll-strategy budget: consecutive
   * same-direction scrolls with no semantic signal, and the alternating-run
   * length that distinguishes OSCILLATION from plain NO_EFFECT. It is fed by
   * `observe()` and read by `detectStall()`.
   */
  private readonly semanticProgress: SemanticProgressTracker;

  actionCount = 0;
  recoveryCount = 0;
  consecutiveNoProgress = 0;
  totalNoProgress = 0;
  lastLoop?: { kind: LoopKind; reason: string };
  lastStallReason?: string;

  constructor(bounds: LongHorizonBounds = DEFAULT_LONG_HORIZON_BOUNDS) {
    this.bounds = bounds;
    this.semanticProgress = new SemanticProgressTracker({
      // Reuse the tracker's own no-progress ceiling so the two bounds cannot
      // drift apart; the plan's default of 3 same-direction scrolls is the
      // same number `maxConsecutiveNoProgress` already carried.
      maxSameDirectionWithoutProgress: bounds.maxConsecutiveNoProgress,
      maxAlternatingWithoutProgress: Math.max(4, bounds.maxConsecutiveNoProgress + 1),
    });
  }

  // ── Initialization ──────────────────────────────────────────────────────

  initialize(goal: string, constraints: string[] = [], subgoals: Subgoal[] = []): void {
    this.originalGoal = goal;
    this.constraints = [...new Set(constraints.filter((c) => typeof c === 'string' && c.length > 0))];
    this.subgoals.clear();
    for (const s of subgoals) {
      this.subgoals.set(s.id, {
        id: s.id,
        description: s.description,
        category: String(s.category),
        status: s.state === 'COMPLETED' ? 'COMPLETED' : s.state === 'IN_PROGRESS' ? 'ACTIVE' : 'PENDING',
        attempts: s.state === 'IN_PROGRESS' ? 1 : 0,
      });
    }
    this.discoveryList = [];
    this.discoveryIds.clear();
    this.fingerprints = [];
    this.lastObservation = null;
    this.actionCount = 0;
    this.recoveryCount = 0;
    this.consecutiveNoProgress = 0;
    this.totalNoProgress = 0;
    this.lastLoop = undefined;
    this.lastStallReason = undefined;
    this.semanticProgress.reset();
  }

  // ── Subgoal lifecycle ───────────────────────────────────────────────────

  registerSubgoal(subgoal: Subgoal): LongHorizonSubgoal {
    const existing = this.subgoals.get(subgoal.id);
    if (existing) return existing;
    const created: LongHorizonSubgoal = {
      id: subgoal.id,
      description: subgoal.description,
      category: String(subgoal.category),
      status: 'PENDING',
      attempts: 0,
    };
    this.subgoals.set(subgoal.id, created);
    return created;
  }

  transition(subgoalId: string, to: LongHorizonSubgoalStatus, reason?: string): SubgoalTransitionResult {
    const subgoal = this.subgoals.get(subgoalId);
    if (!subgoal) {
      return { ok: false, reason: `Unknown subgoal ${subgoalId}.` };
    }
    return transitionSubgoal(subgoal, to, reason);
  }

  getSubgoal(subgoalId: string): LongHorizonSubgoal | undefined {
    return this.subgoals.get(subgoalId);
  }

  get completedSubgoalIds(): string[] {
    return [...this.subgoals.values()].filter((s) => s.status === 'COMPLETED').map((s) => s.id);
  }

  get pendingSubgoalIds(): string[] {
    return [...this.subgoals.values()]
      .filter((s) => s.status === 'PENDING' || s.status === 'ACTIVE')
      .map((s) => s.id);
  }

  get failedSubgoalIds(): string[] {
    return [...this.subgoals.values()]
      .filter((s) => s.status === 'FAILED' || s.status === 'BLOCKED')
      .map((s) => s.id);
  }

  get activeSubgoalId(): string | null {
    for (const s of this.subgoals.values()) if (s.status === 'ACTIVE') return s.id;
    return null;
  }

  /**
   * A completed subgoal must never be needlessly re-executed. Returns true when
   * the agent is about to redo work it has already finished.
   */
  isAlreadyCompleted(subgoalId: string): boolean {
    return this.subgoals.get(subgoalId)?.status === 'COMPLETED';
  }

  // ── Observations ────────────────────────────────────────────────────────

  /**
   * Records one observation, updates progress accounting and appends a
   * bounded fingerprint. Returns the deterministic progress assessment.
   */
  observe(
    observation: TaskObservation,
    action?: { action: string; target?: string; direction?: string },
    opts: {
      subgoalJustCompleted?: string;
      discoveriesAdded?: number;
      countsAsAction?: boolean;
      /** PHASE 18.7 / I-8. New evidence-ledger records this cycle produced. */
      evidenceDelta?: number;
    } = {}
  ): ProgressAssessment {
    //
    // PHASE 18.7 / I-8. The scroll direction comes from the RETAINED action the
    // loop actually dispatched — never from the provider's prose — and only
    // when that action really was a scroll.
    const scrollDirection: ScrollDirection | null =
      action?.action === 'scroll' && (action.direction === 'up' || action.direction === 'down')
        ? action.direction
        : null;
    // The budget is stateful; `assessProgress` itself stays pure. Both are
    // driven by `classifySemanticProgress` with the SAME input and the SAME
    // carried budget, so there is exactly one definition of "meaningful" and the
    // two cannot disagree.
    const carry = this.semanticProgress.carry();
    const assessment = assessProgress(
      this.lastObservation,
      observation,
      {
        subgoalJustCompleted: opts.subgoalJustCompleted,
        discoveriesAdded: opts.discoveriesAdded,
        evidenceDelta: opts.evidenceDelta ?? 0,
        scrollDirection,
      },
      carry
    );
    this.semanticProgress.evaluate({
      previous: this.lastObservation ? toSemanticObservation(this.lastObservation) : null,
      current: toSemanticObservation(observation),
      evidenceDelta: opts.evidenceDelta ?? 0,
      scrollDirection,
    });
    if (opts.countsAsAction !== false) this.actionCount += 1;

    if (assessment.meaningful) {
      this.consecutiveNoProgress = 0;
    } else {
      this.consecutiveNoProgress += 1;
      this.totalNoProgress += 1;
    }

    const fp = action
      ? fingerprintObservation(observation, action)
      : assessment.fingerprint;
    this.fingerprints.push(fp);
    if (this.fingerprints.length > this.bounds.fingerprintWindow) {
      this.fingerprints = this.fingerprints.slice(-this.bounds.fingerprintWindow);
    }
    this.lastObservation = observation;
    return assessment;
  }

  getRecentFingerprints(): string[] {
    return [...this.fingerprints];
  }

  /** PHASE 17.4 D5. The last observation, for persistence. Read-only. */
  getLastObservation(): TaskObservation | null {
    return this.lastObservation ? { ...this.lastObservation } : null;
  }

  /**
   * PHASE 17.4 D5. Subgoal LIFECYCLE state only — id, status and attempts.
   * The `description` is deliberately not exposed here: it is model-authored
   * free text and must never reach a persisted record.
   */
  getSubgoalStates(): ReadonlyArray<{ id: string; status: LongHorizonSubgoalStatus; attempts: number }> {
    return [...this.subgoals.values()].map((s) => ({ id: s.id, status: s.status, attempts: s.attempts }));
  }

  /**
   * PHASE 17.4 D5. Rebuild the reliability state of an INTERRUPTED task.
   *
   * Only call with a record that has already passed `validatePersisted`. This is
   * a restore of BOUNDS — counters, the fingerprint ring, the last observation
   * and the subgoal lifecycle — and it deliberately does NOT touch the goal text
   * or the discovery list, neither of which is persisted.
   *
   * It cannot create a success: every restored value feeds only loop, stall and
   * bound checks, whose sole terminal output is a replan or `FAILED`.
   */
  restoreFrom(state: {
    actionCount: number;
    recoveryCount: number;
    consecutiveNoProgress: number;
    totalNoProgress: number;
    fingerprints: string[];
    lastObservation: TaskObservation | null;
    subgoals: ReadonlyArray<{ id: string; status: LongHorizonSubgoalStatus; attempts: number }>;
    lastLoop?: { kind: LoopKind | string; reason: string };
    lastStallReason?: string;
  }): void {
    this.actionCount = state.actionCount;
    this.recoveryCount = state.recoveryCount;
    this.consecutiveNoProgress = state.consecutiveNoProgress;
    this.totalNoProgress = state.totalNoProgress;
    this.fingerprints = [...state.fingerprints].slice(-this.bounds.fingerprintWindow);
    this.lastObservation = state.lastObservation ? { ...state.lastObservation } : null;
    for (const s of state.subgoals) {
      // A COMPLETED subgoal stays COMPLETED: the lifecycle makes it terminal, so
      // a restart cannot silently reopen finished work.
      this.subgoals.set(s.id, {
        id: s.id,
        description: '',
        category: '',
        status: s.status,
        attempts: s.attempts,
      });
    }
    this.lastLoop = state.lastLoop as { kind: LoopKind; reason: string } | undefined;
    this.lastStallReason = state.lastStallReason;
  }

  detectLoop(): LoopDetection {
    const d = detectLoop(this.fingerprints, this.bounds);
    if (d.loop) this.lastLoop = { kind: d.kind!, reason: d.reason };
    return d;
  }

  detectStall(): StallDetection {
    // PHASE 18.7 / I-8. The KIND comes from the semantic-progress classifier,
    // never from guesswork, so recovery is told the difference between "scrolling
    // had no effect" and "the agent is oscillating" — two different strategies.
    const kind = this.semanticProgress.snapshot().stagnation;
    const d = detectStall(this.consecutiveNoProgress, this.totalNoProgress, this.bounds, kind);
    if (d.stalled) this.lastStallReason = d.reason;
    return d;
  }

  /**
   * PHASE 18.7 / I-8. The live semantic-progress verdict: budget, geometry and
   * stagnation kind. Read-only; recovery consumes this verbatim.
   */
  semanticProgressVerdict(): SemanticProgressVerdict {
    return this.semanticProgress.snapshot();
  }

  checkBounds(): BoundsCheck {
    return checkBounds(
      {
        actionCount: this.actionCount,
        recoveryCount: this.recoveryCount,
        totalNoProgress: this.totalNoProgress,
        subgoalCount: this.subgoals.size,
      },
      this.bounds
    );
  }

  // ── Discoveries ─────────────────────────────────────────────────────────

  /**
   * Records a task-level discovery. Ids are deduplicated so a re-perceived
   * entity never inflates the discovery list. Returns true when new.
   */
  addDiscovery(discovery: Omit<TaskDiscovery, 'timestamp'> & { timestamp?: number }): boolean {
    if (this.discoveryIds.has(discovery.id)) return false;
    // Defence in depth at the INPUT boundary: a discovery that carries a
    // raw-value-shaped label is dropped outright, so it can never enter
    // long-horizon state, memory, or the planner summary.
    if (scanForRawSensitiveValues(discovery.label, { structuralKeys: new Set() }).length > 0) {
      return false;
    }
    this.discoveryIds.add(discovery.id);
    this.discoveryList.push({ ...discovery, timestamp: discovery.timestamp ?? Date.now() });
    return true;
  }

  get discoveries(): TaskDiscovery[] {
    return [...this.discoveryList];
  }

  // ── Replanning ──────────────────────────────────────────────────────────

  /**
   * STATE-AWARE REPLANNING. Reopens ONLY the work that is still outstanding.
   * Completed subgoals and accumulated discoveries are preserved verbatim, and
   * a COMPLETED subgoal is never reopened — a replan must not throw away work
   * the agent has already finished.
   */
  replanRemaining(failedSubgoalId?: string, reason = 'replan'): {
    reopened: string[];
    preservedCompleted: string[];
    preservedDiscoveries: number;
  } {
    const reopened: string[] = [];
    for (const subgoal of this.subgoals.values()) {
      if (subgoal.status === 'COMPLETED') continue; // preserved
      if (failedSubgoalId && subgoal.id !== failedSubgoalId) {
        // Leave the other outstanding subgoals exactly as they are; only the
        // blocked one is reconsidered.
        continue;
      }
      if (subgoal.status === 'BLOCKED' || subgoal.status === 'FAILED') {
        const r = transitionSubgoal(subgoal, 'ACTIVE', reason);
        if (r.ok) reopened.push(subgoal.id);
      } else if (subgoal.status === 'PENDING') {
        const r = transitionSubgoal(subgoal, 'ACTIVE', reason);
        if (r.ok) reopened.push(subgoal.id);
      }
    }
    this.recoveryCount += 1;
    return {
      reopened,
      preservedCompleted: this.completedSubgoalIds,
      preservedDiscoveries: this.discoveryList.length,
    };
  }

  // ── Snapshot & sanitized planner summary ────────────────────────────────

  snapshot(): LongHorizonSnapshot {
    const all = [...this.subgoals.values()];
    return {
      originalGoal: this.originalGoal,
      normalizedConstraints: [...this.constraints],
      activeSubgoalId: this.activeSubgoalId,
      pendingSubgoalIds: this.pendingSubgoalIds,
      completedSubgoalIds: this.completedSubgoalIds,
      failedSubgoalIds: all.filter((s) => s.status === 'FAILED').map((s) => s.id),
      blockedSubgoalIds: all.filter((s) => s.status === 'BLOCKED').map((s) => s.id),
      discoveries: this.discoveries,
      actionCount: this.actionCount,
      recoveryCount: this.recoveryCount,
      consecutiveNoProgress: this.consecutiveNoProgress,
      totalNoProgress: this.totalNoProgress,
      recentFingerprints: [...this.fingerprints],
      lastLoop: this.lastLoop,
      lastStallReason: this.lastStallReason,
      semanticProgress: this.semanticProgress.snapshot(),
    };
  }

  /**
   * The ONLY long-horizon data allowed to reach the remote reasoner. It is
   * counts, ids, categories and labels — never a raw value — and it is scanned
   * by the existing raw-value firewall before being returned, so a leak fails
   * closed instead of being transmitted.
   */
  toSanitizedSummary(maxDiscoveries = 8): string {
    const snap = this.snapshot();
    const summary = {
      originalGoal: snap.originalGoal,
      normalizedConstraints: snap.normalizedConstraints,
      activeSubgoal: snap.activeSubgoalId,
      completedSubgoals: snap.completedSubgoalIds.length,
      pendingSubgoals: snap.pendingSubgoalIds.length,
      failedSubgoals: snap.failedSubgoalIds.length,
      blockedSubgoals: snap.blockedSubgoalIds.length,
      discoveriesSoFar: snap.discoveries.length,
      // Labels only, and only the most recent bounded slice.
      recentDiscoveries: snap.discoveries.slice(-maxDiscoveries).map((d) => ({
        label: d.label,
        source: d.source,
        type: d.source,
      })),
      actionsTaken: snap.actionCount,
      recoveryAttempts: snap.recoveryCount,
      stalled: snap.consecutiveNoProgress > 0,
    };
    // Scan the STRUCTURED object (what the firewall is designed for) before
    // serializing. Serializing first and scanning the string would produce
    // false positives on long JSON runs without adding any real protection.
    const violations = scanForRawSensitiveValues(summary, {
      structuralKeys: new Set<string>(),
    });
    if (violations.length > 0) {
      // Fail closed: withhold the summary rather than risk transmitting it.
      return JSON.stringify({
        originalGoal: snap.originalGoal,
        completedSubgoals: snap.completedSubgoalIds.length,
        pendingSubgoals: snap.pendingSubgoalIds.length,
        actionsTaken: snap.actionCount,
        note: 'Task summary withheld: failed the raw-value firewall.',
      });
    }
    return JSON.stringify(summary);
  }
}

// ── Memory integration (reuses the existing memory subsystem) ───────────────

/**
 * Persists the CURRENT task's long-horizon progress into the EXISTING working
 * memory, so a later step of the same task can recall what was already done.
 * Everything written passes through the existing memory firewall, and the
 * content is value-free by construction.
 */
export function recordWorkingProgress(
  tracker: LongHorizonTracker,
  scope: SiteScope,
  goalId: string
): void {
  const snap = tracker.snapshot();
  const record: WorkingMemoryRecord = {
    id: `lh-${goalId}`,
    class: 'WORKING',
    scope,
    trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
    provenance: { source: 'VERIFIED_OUTCOME', timestamp: Date.now() },
    confidence: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    goalId,
    key: 'long-horizon-progress',
    memoryContent: {
      completedSubgoals: snap.completedSubgoalIds.length,
      pendingSubgoals: snap.pendingSubgoalIds.length,
      failedSubgoals: snap.failedSubgoalIds.length,
      discoveries: snap.discoveries.length,
      actionsTaken: snap.actionCount,
      recoveryAttempts: snap.recoveryCount,
    },
  };
  try {
    WorkingMemoryManager.write(record);
  } catch {
    // Memory is assistive, never authoritative: a failed write must not break
    // the task, and must never grant permission.
  }
}

/** Records a loop/stall/bound event as a sanitized failure memory entry. */
export async function recordLongHorizonFailure(
  scope: SiteScope,
  goalId: string,
  params: {
    failureType: string;
    reason: string;
    subgoalId?: string;
    actionType?: string;
  }
): Promise<void> {
  const record: FailureMemoryRecord = {
    id: `lh-fail-${goalId}-${Date.now().toString(36)}`,
    class: 'FAILURE',
    scope,
    trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
    provenance: {
      source: 'ACTION_RESULT',
      timestamp: Date.now(),
      subgoalId: params.subgoalId,
      actionType: params.actionType,
    },
    confidence: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    failureType: params.failureType,
    contextCategory: 'long_horizon',
    recoveryAttempted: 'NONE',
    recoveryResult: 'FAILURE',
  };
  try {
    await FailureMemoryManager.write(record);
  } catch {
    // Same rationale as above.
  }
}

/** Records the sanitized outcome of a finished task. */
export async function recordEpisodicOutcome(
  scope: SiteScope,
  goalId: string,
  params: { taskType: string; outcome: 'SUCCESS' | 'FAILURE' | 'ABORTED'; summary: string; actions: number }
): Promise<void> {
  const record: EpisodicMemoryRecord = {
    id: `lh-ep-${goalId}-${Date.now().toString(36)}`,
    class: 'EPISODIC',
    scope,
    trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
    provenance: { source: 'VERIFIED_OUTCOME', timestamp: Date.now() },
    confidence: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    taskType: params.taskType,
    outcome: params.outcome,
    // Counts and codes only.
    sanitizedSummary: params.summary,
    metrics: { durationMs: 0, actionsTaken: params.actions },
  };
  try {
    await EpisodicMemoryManager.write(record);
  } catch {
    // Assistive only.
  }
}

/**
 * Mirrors the existing SubgoalGraph into the long-horizon tracker so the two
 * never disagree. The graph remains the single source of truth for planning.
 */
export function syncFromSubgoalGraph(
  tracker: LongHorizonTracker,
  graphData: SubgoalGraphData | undefined
): void {
  if (!graphData) return;
  for (const subgoal of Object.values(graphData.subgoals ?? {})) {
    const tracked = tracker.registerSubgoal(subgoal);
    //
    // PHASE 17.6 (C). Every branch below now goes through
    // `transitionSubgoal`, which validates the transition against
    // SUBGOAL_TRANSITIONS. It used to assign `tracked.status` directly, which
    // silently defeated the only rule the state machine exists to enforce:
    // PENDING may not become COMPLETED without passing through ACTIVE. A graph
    // subgoal reported COMPLETED would therefore complete its tracker twin from
    // PENDING, and `isAlreadyCompleted` would then make the loop skip it
    // forever.
    //
    // `transitionSubgoal` returns `ok: false` for an illegal edge and leaves
    // the object untouched, so an unprovable transition simply does not happen
    // — it fails closed, exactly as it does everywhere else.
    if (subgoal.state === 'COMPLETED' && tracked.status !== 'COMPLETED') {
      // A tracker subgoal that is still PENDING has never been observed as
      // ACTIVE. Promote it to ACTIVE first so the completion is a legal,
      // observation-backed lifecycle edge rather than a direct assignment.
      if (tracked.status === 'PENDING') {
        transitionSubgoal(tracked, 'ACTIVE', 'mirrored as IN_PROGRESS before completion');
      }
      transitionSubgoal(tracked, 'COMPLETED', 'mirrored from observed subgoal graph');
    } else if (subgoal.state === 'IN_PROGRESS' && tracked.status === 'PENDING') {
      transitionSubgoal(tracked, 'ACTIVE', 'mirrored from observed subgoal graph');
    } else if (subgoal.state === 'FAILED' && tracked.status === 'ACTIVE') {
      transitionSubgoal(tracked, 'FAILED', subgoal.failureReason ?? 'failed');
    } else if (subgoal.state === 'SKIPPED' && tracked.status === 'PENDING') {
      transitionSubgoal(tracked, 'FAILED', 'skipped');
    }
  }
}
