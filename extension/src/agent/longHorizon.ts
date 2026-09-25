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
  scrollY: number;
  /** LENGTH ONLY of the targeted field's value — never the value itself. */
  targetValueLength: number;
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
}

/** Build an observation from a sanitized context. Structure only. */
export function observeFromContext(
  context: AgentContextPayload,
  extra: { scrollY?: number; targetValueLength?: number } = {}
): TaskObservation {
  const entityIds = (context.semantic_context?.entities ?? []).map((e) => e.id).sort();
  const candidateIds = context.detections.map((d) => d.id).sort();
  return {
    url: context.url,
    pageGeneration: context.semantic_context?.pageGeneration ?? 0,
    entityIds,
    candidateIds,
    scrollY: extra.scrollY ?? 0,
    targetValueLength: extra.targetValueLength ?? 0,
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
 */
export function fingerprintObservation(observation: TaskObservation, action?: BrowserAction): string {
  const url = normalizeUrl(observation.url);
  const topCandidates = observation.candidateIds.slice(0, 5).join(',');
  const topEntities = observation.entityIds.slice(0, 5).join(',');
  const actionPart = action
    ? `${action.action}:${'target' in action ? String((action as { target?: unknown }).target ?? '') : ''}`
    : 'observe';
  return stableHash(`${url}|${topCandidates}|${topEntities}|${actionPart}`);
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
  opts: { subgoalJustCompleted?: string; discoveriesAdded?: number } = {}
): ProgressAssessment {
  const signals: ProgressSignal[] = [];
  if (previous) {
    if (normalizeUrl(previous.url) !== normalizeUrl(current.url)) {
      signals.push('NEW_PAGE');
    }
    if (current.entityIds.length > previous.entityIds.length) {
      signals.push('NEW_ENTITY');
    }
    if (current.candidateIds.length > previous.candidateIds.length) {
      signals.push('NEW_CANDIDATE');
    }
    if (
      previous.targetValueLength !== current.targetValueLength ||
      previous.scrollY !== current.scrollY
    ) {
      signals.push('RELEVANT_STATE_CHANGED');
    }
  } else {
    signals.push('NEW_PAGE');
  }
  if (opts.subgoalJustCompleted) signals.push('SUBGOAL_COMPLETED');
  if ((opts.discoveriesAdded ?? 0) > 0) signals.push('NEW_ENTITY');

  return {
    meaningful: signals.length > 0,
    signals,
    fingerprint: fingerprintObservation(current),
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
}

export function detectStall(
  consecutiveNoProgress: number,
  totalNoProgress: number,
  bounds: Pick<LongHorizonBounds, 'maxConsecutiveNoProgress'>
): StallDetection {
  if (consecutiveNoProgress >= bounds.maxConsecutiveNoProgress) {
    return {
      stalled: true,
      consecutiveNoProgress,
      totalNoProgress,
      reason: `${consecutiveNoProgress} consecutive actions produced no meaningful progress (limit ${bounds.maxConsecutiveNoProgress}).`,
    };
  }
  return { stalled: false, consecutiveNoProgress, totalNoProgress, reason: 'Task is still progressing.' };
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

  actionCount = 0;
  recoveryCount = 0;
  consecutiveNoProgress = 0;
  totalNoProgress = 0;
  lastLoop?: { kind: LoopKind; reason: string };
  lastStallReason?: string;

  constructor(bounds: LongHorizonBounds = DEFAULT_LONG_HORIZON_BOUNDS) {
    this.bounds = bounds;
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
    action?: BrowserAction,
    opts: { subgoalJustCompleted?: string; discoveriesAdded?: number; countsAsAction?: boolean } = {}
  ): ProgressAssessment {
    const assessment = assessProgress(this.lastObservation, observation, {
      subgoalJustCompleted: opts.subgoalJustCompleted,
      discoveriesAdded: opts.discoveriesAdded,
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

  detectLoop(): LoopDetection {
    const d = detectLoop(this.fingerprints, this.bounds);
    if (d.loop) this.lastLoop = { kind: d.kind!, reason: d.reason };
    return d;
  }

  detectStall(): StallDetection {
    const d = detectStall(this.consecutiveNoProgress, this.totalNoProgress, this.bounds);
    if (d.stalled) this.lastStallReason = d.reason;
    return d;
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
    if (subgoal.state === 'COMPLETED' && tracked.status !== 'COMPLETED') {
      tracked.status = 'COMPLETED';
    } else if (subgoal.state === 'IN_PROGRESS' && tracked.status === 'PENDING') {
      tracked.status = 'ACTIVE';
      tracked.attempts += 1;
    } else if (subgoal.state === 'FAILED' && tracked.status === 'ACTIVE') {
      tracked.status = 'FAILED';
      tracked.lastReason = subgoal.failureReason ?? 'failed';
    } else if (subgoal.state === 'SKIPPED' && tracked.status === 'PENDING') {
      tracked.status = 'FAILED';
      tracked.lastReason = 'skipped';
    }
  }
}
