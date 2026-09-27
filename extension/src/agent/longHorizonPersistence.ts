/**
 * PrivAgent — PHASE 17.4 D5: long-horizon reliability state that survives an
 * MV3 service-worker restart.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * A reliability mechanism ONLY. It holds no gate, runs none, and grants nothing.
 * Restoring a record can only make the agent stop SOONER: every restored value
 * feeds the loop/stall/bounds checks in `longHorizon.ts`, whose only terminal
 * output is a replan or `FAILED`. It can never create a success, and it can never
 * bypass Grounding, M5, the Privacy Firewall, the Security Critic,
 * Risk/Confirmation, Effect Verification or Containment.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * `AgentLoop.longHorizon` is a per-instance field. An MV3 service worker is
 * evicted when idle, and with it every bound — `actionCount`, `recoveryCount`,
 * `consecutiveNoProgress`, `totalNoProgress`, the fingerprint ring and the
 * subgoal lifecycle. A revived worker rebuilt the tracker from zero, so a task
 * that had already consumed 20 of 24 actions silently received 24 more. The
 * bounds are the only thing preventing an unbounded run.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * METADATA ONLY. Two exclusions are structural rather than filtered:
 *   • the user's task text (`originalGoal`) is NEVER persisted — a `stableHash`
 *     digest is stored instead, which can detect a mismatch but cannot
 *     reconstruct text that may contain PII;
 *   • subgoal `description` and discovery `label` are NEVER persisted — both are
 *     model-authored free text. Only `{id, status, attempts}` is kept.
 * On top of that the serialized record is passed through the EXISTING
 * `scanForRawSensitiveValues` before writing, and is refused if it trips — the
 * same input-boundary defence `addDiscovery()` already applies.
 *
 * No screenshot, DOM, OCR text, prompt or raw value is an input to this record,
 * and no outbound path is created: it is local extension state read by one
 * reliability class.
 *
 * ── Storage ─────────────────────────────────────────────────────────────────
 * `chrome.storage.session` — the MV3 area for live, in-memory extension state.
 * It survives service-worker eviction and is NEVER written to disk, which keeps
 * the privacy property absolute. `chrome.storage` is gated behind the `storage`
 * permission, which this change set added to the manifest — without it the API is
 * absent in the shipped build and everything below is dead code. Availability is
 * still probed rather than assumed; when it is genuinely absent the store degrades
 * to in-memory and says so via `persistenceAvailable`. Degradation is explicit,
 * never silent, and never writes task state to disk as a fallback.
 *
 * Design decision and the ten-question audit: LONG_HORIZON_AUDIT_D5.md
 */

import {
  LongHorizonTracker,
  stableHash,
  type LongHorizonBounds,
  type LongHorizonSubgoalStatus,
  type TaskObservation,
} from './longHorizon';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';

export const LONG_HORIZON_SCHEMA_VERSION = 1;
export const LONG_HORIZON_STORE_KEY = 'privagent.longHorizon.v1';

export type LongHorizonRestoreStatus =
  | 'FRESH_NO_RECORD'
  | 'RESTORED'
  | 'REJECTED_MALFORMED'
  | 'REJECTED_SCHEMA'
  | 'REJECTED_TASK_MISMATCH'
  | 'REJECTED_PRIVACY'
  | 'UNAVAILABLE';

/** A persisted subgoal carries NO description — model text is never stored. */
interface PersistedSubgoal {
  id: string;
  status: LongHorizonSubgoalStatus;
  attempts: number;
}

export interface LongHorizonPersistedRecord {
  schemaVersion: number;
  runId: string;
  goalDigest: string;
  updatedAt: number;
  actionCount: number;
  recoveryCount: number;
  consecutiveNoProgress: number;
  totalNoProgress: number;
  fingerprints: string[];
  lastObservation: TaskObservation | null;
  subgoals: PersistedSubgoal[];
  lastLoop?: { kind: string; reason: string };
  lastStallReason?: string;
}

/* ── Store ────────────────────────────────────────────────────────────────── */

export interface LongHorizonStore {
  /** Null when persistence is unavailable; never silently substituted. */
  readonly persistenceAvailable: boolean;
  load(): Promise<unknown | null>;
  save(record: LongHorizonPersistedRecord): Promise<boolean>;
  clear(): Promise<void>;
}

/**
 * A WORKING store held in this JS heap. It is what tests use to simulate "the
 * record outlived the service worker": the record is genuinely readable and
 * writable through the production code path, it just does not itself survive a
 * restart.
 */
export function createMemoryStore(seed?: LongHorizonPersistedRecord | null): LongHorizonStore {
  let current: unknown | null = seed ?? null;
  return {
    persistenceAvailable: true,
    async load() {
      return current;
    },
    async save(record) {
      current = record;
      return true;
    },
    async clear() {
      current = null;
    },
  };
}

/**
 * No persistence at all. This is the `AgentLoop` DEFAULT, so every existing
 * caller, fixture and test is byte-for-byte unchanged. It reports itself
 * unavailable, which surfaces as an explicit `UNAVAILABLE` restore status rather
 * than a silent assumption that nothing was restored.
 */
export function createNoopStore(): LongHorizonStore {
  return {
    persistenceAvailable: false,
    async load() {
      return null;
    },
    async save() {
      return false;
    },
    async clear() {
      /* nothing persisted */
    },
  };
}

/** `chrome.storage.session` — survives SW eviction, never touches disk. */
export function createSessionStore(): LongHorizonStore {
  const area = (globalThis as { chrome?: { storage?: { session?: ChromeStorageArea } } }).chrome?.storage
    ?.session;
  if (!area) {
    return createNoopStore();
  }
  return {
    persistenceAvailable: true,
    async load() {
      try {
        const got = await area.get(LONG_HORIZON_STORE_KEY);
        return got?.[LONG_HORIZON_STORE_KEY] ?? null;
      } catch {
        return null;
      }
    },
    async save(record) {
      try {
        await area.set({ [LONG_HORIZON_STORE_KEY]: record });
        return true;
      } catch {
        return false;
      }
    },
    async clear() {
      try {
        await area.remove(LONG_HORIZON_STORE_KEY);
      } catch {
        /* best effort */
      }
    },
  };
}

interface ChromeStorageArea {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/* ── Serialize ────────────────────────────────────────────────────────────── */

const isFiniteNonNegativeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;

const VALID_SUBGOAL_STATUS: readonly LongHorizonSubgoalStatus[] = [
  'PENDING',
  'ACTIVE',
  'COMPLETED',
  'BLOCKED',
  'FAILED',
];

/**
 * Build the persisted record. Metadata only — see the module header for the two
 * structural exclusions. This is the ONLY place a record is constructed, so the
 * exclusion cannot be forgotten by a later caller.
 */
export function serializeTracker(
  tracker: LongHorizonTracker,
  runId: string,
  goalText: string,
  bounds: Pick<LongHorizonBounds, 'fingerprintWindow'>
): LongHorizonPersistedRecord {
  const snapshot = tracker.snapshot();
  return {
    schemaVersion: LONG_HORIZON_SCHEMA_VERSION,
    runId,
    // Digest, never the task text.
    goalDigest: stableHash(goalText),
    updatedAt: Date.now(),
    actionCount: tracker.actionCount,
    recoveryCount: tracker.recoveryCount,
    consecutiveNoProgress: tracker.consecutiveNoProgress,
    totalNoProgress: tracker.totalNoProgress,
    fingerprints: tracker.getRecentFingerprints().slice(-bounds.fingerprintWindow),
    lastObservation: tracker.getLastObservation(),
    // id + status + attempts ONLY. No description, no discovery labels.
    subgoals: tracker.getSubgoalStates().map((s) => ({ id: s.id, status: s.status, attempts: s.attempts })),
    ...(snapshot.lastLoop ? { lastLoop: { ...snapshot.lastLoop } } : {}),
    ...(snapshot.lastStallReason ? { lastStallReason: snapshot.lastStallReason } : {}),
  };
}

/* ── Validate ─────────────────────────────────────────────────────────────── */

export type ValidationOutcome =
  | { ok: true; record: LongHorizonPersistedRecord }
  | { ok: false; status: 'REJECTED_MALFORMED' | 'REJECTED_SCHEMA' | 'REJECTED_TASK_MISMATCH' | 'REJECTED_PRIVACY'; detail: string };

/**
 * Refuse anything we cannot fully trust. Every branch is a REFUSAL, never a
 * repair: a partially-understood record is treated as no record at all.
 */
export function validatePersisted(raw: unknown, runId: string, goalText: string, bounds: LongHorizonBounds): ValidationOutcome {
  if (raw === null || raw === undefined) {
    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'no record' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'record is not an object' };
  }
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== LONG_HORIZON_SCHEMA_VERSION) {
    return { ok: false, status: 'REJECTED_SCHEMA', detail: `schemaVersion ${String(r.schemaVersion)} != ${LONG_HORIZON_SCHEMA_VERSION}` };
  }
  if (typeof r.runId !== 'string' || r.runId.length === 0) {
    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'missing runId' };
  }
  if (r.runId !== runId) {
    return { ok: false, status: 'REJECTED_TASK_MISMATCH', detail: 'record belongs to a different run' };
  }
  if (typeof r.goalDigest !== 'string' || r.goalDigest !== stableHash(goalText)) {
    return { ok: false, status: 'REJECTED_TASK_MISMATCH', detail: 'goal digest does not match this task' };
  }

  for (const k of ['actionCount', 'recoveryCount', 'consecutiveNoProgress', 'totalNoProgress'] as const) {
    if (!isFiniteNonNegativeInt(r[k])) {
      return { ok: false, status: 'REJECTED_MALFORMED', detail: `invalid counter: ${k}` };
    }
  }

  if (!Array.isArray(r.fingerprints) || r.fingerprints.length > bounds.fingerprintWindow) {
    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'invalid fingerprint ring' };
  }
  if (!r.fingerprints.every((f) => typeof f === 'string')) {
    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'non-string fingerprint' };
  }

  if (!Array.isArray(r.subgoals) || r.subgoals.length > 512) {
    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'invalid subgoal list' };
  }
  for (const s of r.subgoals as unknown[]) {
    if (s === null || typeof s !== 'object') {
      return { ok: false, status: 'REJECTED_MALFORMED', detail: 'subgoal is not an object' };
    }
    const sg = s as Record<string, unknown>;
    if (typeof sg.id !== 'string' || sg.id.length === 0) return { ok: false, status: 'REJECTED_MALFORMED', detail: 'subgoal missing id' };
    if (!VALID_SUBGOAL_STATUS.includes(sg.status as LongHorizonSubgoalStatus)) {
      return { ok: false, status: 'REJECTED_MALFORMED', detail: 'subgoal has an unknown status' };
    }
    if (!isFiniteNonNegativeInt(sg.attempts)) {
      return { ok: false, status: 'REJECTED_MALFORMED', detail: 'subgoal attempts invalid' };
    }
  }

  if (r.lastObservation !== null && (typeof r.lastObservation !== 'object' || Array.isArray(r.lastObservation))) {
    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'lastObservation is not an object' };
  }

  // Defence in depth: even though construction excludes text, a record that
  // somehow carries raw-value-shaped content is refused rather than restored.
  if (scanForRawSensitiveValues(raw).length > 0) {
    return { ok: false, status: 'REJECTED_PRIVACY', detail: 'record tripped the raw-value scanner' };
  }

  return { ok: true, record: raw as unknown as LongHorizonPersistedRecord };
}

/* ── Restore ──────────────────────────────────────────────────────────────── */

/**
 * Rebuild a tracker from a VALIDATED record. Only call with a record that
 * `validatePersisted` accepted.
 */
export function restoreTracker(record: LongHorizonPersistedRecord, bounds: LongHorizonBounds): LongHorizonTracker {
  const t = new LongHorizonTracker(bounds);
  t.restoreFrom(record);
  return t;
}

/* ── Orchestration ────────────────────────────────────────────────────────── */

export interface LoadOutcome {
  tracker: LongHorizonTracker;
  status: LongHorizonRestoreStatus;
  detail?: string;
  persistenceAvailable: boolean;
}

/**
 * Attempt to restore. On ANY refusal this returns a FRESH, FULLY BOUNDED
 * tracker — never an unbounded one. Every bound is a construction parameter, so
 * a refused record cannot hand the agent an unlimited budget; it can only fail to
 * remember what was already consumed, which is the conservative direction.
 */
export async function loadTrackerForTask(
  store: LongHorizonStore,
  runId: string,
  goalText: string,
  bounds: LongHorizonBounds
): Promise<LoadOutcome> {
  const fresh = () => new LongHorizonTracker(bounds);
  if (!store.persistenceAvailable) {
    return { tracker: fresh(), status: 'UNAVAILABLE', persistenceAvailable: false };
  }
  let raw: unknown | null;
  try {
    raw = await store.load();
  } catch {
    return { tracker: fresh(), status: 'UNAVAILABLE', detail: 'store threw on load', persistenceAvailable: true };
  }
  if (raw === null || raw === undefined) {
    return { tracker: fresh(), status: 'FRESH_NO_RECORD', persistenceAvailable: true };
  }
  const v = validatePersisted(raw, runId, goalText, bounds);
  if (!v.ok) {
    // Delete the unusable record so it is not re-read every cycle.
    try {
      await store.clear();
    } catch {
      /* best effort */
    }
    return { tracker: fresh(), status: v.status, detail: v.detail, persistenceAvailable: true };
  }
  try {
    return { tracker: restoreTracker(v.record, bounds), status: 'RESTORED', persistenceAvailable: true };
  } catch {
    try {
      await store.clear();
    } catch {
      /* best effort */
    }
    return { tracker: fresh(), status: 'REJECTED_MALFORMED', detail: 'restore threw', persistenceAvailable: true };
  }
}

/** Persist the current state. Returns false when it was refused or unavailable. */
export async function saveTracker(
  store: LongHorizonStore,
  tracker: LongHorizonTracker,
  runId: string,
  goalText: string,
  bounds: Pick<LongHorizonBounds, 'fingerprintWindow'>
): Promise<boolean> {
  if (!store.persistenceAvailable) return false;
  let record: LongHorizonPersistedRecord;
  try {
    record = serializeTracker(tracker, runId, goalText, bounds);
  } catch {
    return false;
  }
  if (scanForRawSensitiveValues(record).length > 0) {
    // Refuse to write rather than persist something that tripped the scanner.
    try {
      await store.clear();
    } catch {
      /* best effort */
    }
    return false;
  }
  try {
    return await store.save(record);
  } catch {
    return false;
  }
}

/** Clear on every terminal exit, so a finished task cannot donate its counters. */
export async function clearTracker(store: LongHorizonStore): Promise<void> {
  try {
    await store.clear();
  } catch {
    /* best effort */
  }
}
