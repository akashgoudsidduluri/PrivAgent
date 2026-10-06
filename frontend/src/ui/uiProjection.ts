/**
 * PrivAgent — DYNAMIC TASK-AWARE UI (Phase 2): the UI-facing projection.
 *
 * A PURE, DETERMINISTIC, FAIL-CLOSED, CONTENT-SAFE translation from the
 * dashboard's typed runtime state to "what to display". It is explicitly NOT
 * an authority over the agent: it has no write path into the loop, the gates,
 * or the service worker. It only decides which surface to render.
 *
 * Surfaces:
 *   IDLE             — no task: the empty-state hero.
 *   CONVERSATION     — conversationRoute said CONVERSATION: user message +
 *                      assistant response. NEVER any browser chrome.
 *   BROWSER_ACTIVITY — the message entered the browser pipeline: a compact
 *                      working indicator, an event-driven activity list, the
 *                      terminal result.
 *
 * Invariants:
 *   - CONVERSATION is decided only by `answerSource === 'CONVERSATION'`
 *     (relayed from the proven normal-chat route) or the typed terminal
 *     reason `CONVERSATIONAL_ANSWER`. Never by guessing from prose.
 *   - Activities exist ONLY for events that actually occurred: a phase
 *     transition that was reported, or a step that actually executed. There
 *     are no seeded/fixed entries and no future steps.
 *   - No fabricated step counters, ever. The model carries an activity count,
 *     which is a count of observed events.
 *   - Content-safe: every string in the output comes from the screened
 *     interaction projection, a fixed label table, or a hostname. The internal
 *     `state.reason` is NEVER read. Unknown/malformed input fails closed to
 *     the smallest honest surface.
 */

import type { DashboardAgentState, AgentInteractionState, StepTelemetry } from '../types/dashboard';

export type UiSurface = 'IDLE' | 'CONVERSATION' | 'BROWSER_ACTIVITY';

export type UiActivityStatus = 'ACTIVE' | 'COMPLETE' | 'FAILED' | 'BLOCKED';

export interface UiActivity {
  /** Stable key so repeated reports of the same event update, not duplicate. */
  key: string;
  /** User-facing label from the fixed safe table (never raw arguments). */
  label: string;
  status: UiActivityStatus;
  /** Optional compact detail, safe by construction (effect verdicts, hosts). */
  detail?: string;
}

export type UiTerminalKind =
  | 'ANSWER'
  | 'SUCCESS'
  | 'PARTIAL'
  | 'FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NEEDS_CLARIFICATION'
  | 'NEEDS_INFORMATION'
  | 'CANNOT_VERIFY'
  | 'COMMIT_UNKNOWN'
  | 'FRESHNESS_UNVERIFIED'
  | 'CANCELLED'
  | 'SUPERSEDED';

export interface UiTerminal {
  kind: UiTerminalKind;
  /** success | notice | failure — drives colour + icon only. */
  tone: 'success' | 'notice' | 'failure';
  headline: string;
  body: string | null;
  provenance: string | null;
  remaining: readonly string[];
}

export interface UiAwaitingConfirmation {
  action: string;
  description: string;
  riskLevel: string;
}

export interface UiModel {
  surface: UiSurface;
  /** Conversation answer still in flight (the ack arrived, the body has not). */
  pending: boolean;
  /** Compact category-of-work label while the browser pipeline is running. */
  workingLabel: string | null;
  /** Event-driven activity history — only what actually happened. */
  activities: UiActivity[];
  activityCount: number;
  /** How many of those activities are still running right now. */
  activeCount: number;
  terminal: UiTerminal | null;
  awaitingConfirmation: UiAwaitingConfirmation | null;
  /** "Previous task replaced by this request." — set only when it happened. */
  supersededNotice: string | null;
  /** There is NO step counter anywhere in this model, by design. */
  stepCounter: null;
}

// ── Label tables ─────────────────────────────────────────────────────────────
// Fixed vocabulary. Every user-facing activity label in the dashboard comes
// from one of these tables, keyed by a TYPED runtime value. Nothing here is
// model-generated, nothing echoes action arguments, and nothing describes
// hidden reasoning — only the category of work occurring.

const PHASE_LABELS: Record<string, string> = {
  PERCEPTION: 'Reading the page',
  PLANNING: 'Planning the next action',
  VALIDATION: 'Checking the action is safe',
  EXECUTION: 'Performing the requested action',
  VERIFICATION: 'Checking the result',
  RECOVERY: 'Retrying after the page changed',
  AWAITING_CONFIRMATION: 'Waiting for your confirmation',
};

const STAGE_LABELS: Record<string, string> = {
  PERCEPTION: 'Reading the page',
  PRIVACY_PROTECTION: 'Protecting page data locally',
  CONTEXT_MINIMIZATION: 'Sanitizing page context locally',
  LLM_REASONING: 'Working…',
  ACTION_VALIDATION: 'Checking the action is safe',
  BROWSER_EXECUTION: 'Performing the requested action',
  VERIFICATION: 'Checking the result',
  TARGET_RESOLUTION: 'Finding the requested item',
};

const ACTION_LABELS: Record<string, string> = {
  navigate: 'Opening the requested page',
  click: 'Performing the requested action',
  type: 'Entering the requested text',
  scroll: 'Looking further down the page',
  select: 'Choosing the requested option',
  pressKey: 'Performing the requested action',
  wait: 'Waiting for the page',
};

/** A hostname for "Opening example.com"; null when the URL is unusable. */
function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    // Dashboard-host URLs reveal nothing useful and would be noise.
    return u.hostname;
  } catch {
    return null;
  }
}

const TERMINAL_STATUSES = new Set([
  'SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL', 'NEEDS_INFORMATION',
  'CANNOT_VERIFY', 'PROVIDER_UNAVAILABLE', 'COMMIT_UNKNOWN',
  'FRESHNESS_UNVERIFIED', 'NEEDS_CLARIFICATION',
]);

function terminalKindFor(state: DashboardAgentState): UiTerminalKind | null {
  if (!TERMINAL_STATUSES.has(state.status)) return null;
  if (state.status === 'STOPPED') {
    return state.supersededPreviousTask ? 'SUPERSEDED' : 'CANCELLED';
  }
  return state.status as UiTerminalKind;
}

const TONE: Record<UiTerminalKind, UiTerminal['tone']> = {
  ANSWER: 'success',
  SUCCESS: 'success',
  PARTIAL: 'notice',
  FAILED: 'failure',
  PROVIDER_UNAVAILABLE: 'failure',
  NEEDS_CLARIFICATION: 'notice',
  NEEDS_INFORMATION: 'notice',
  CANNOT_VERIFY: 'notice',
  COMMIT_UNKNOWN: 'notice',
  FRESHNESS_UNVERIFIED: 'notice',
  CANCELLED: 'notice',
  SUPERSEDED: 'notice',
};

/** Fixed, truthful fallbacks. Never `state.reason` (internal by contract). */
const FALLBACK_HEADLINES: Record<UiTerminalKind, string> = {
  ANSWER: 'Answered directly.',
  SUCCESS: 'Task completed successfully.',
  PARTIAL: 'Partially completed.',
  FAILED: 'The task could not be completed.',
  PROVIDER_UNAVAILABLE: 'The reasoning service was unavailable, so nothing was changed on the page.',
  NEEDS_CLARIFICATION: 'One detail is missing — a little more information is needed.',
  NEEDS_INFORMATION: 'This page does not contain the requested information.',
  CANNOT_VERIFY: 'The result could not be verified on this page.',
  COMMIT_UNKNOWN: 'The action went through, but the outcome could not be confirmed. Check the page yourself.',
  FRESHNESS_UNVERIFIED: 'The page changed before acting, so nothing was done.',
  CANCELLED: 'Task cancelled.',
  SUPERSEDED: 'Task replaced by a newer request.',
};

/** Kinds whose final result is a "check this yourself" notice, not a failure. */
function toneForKind(kind: UiTerminalKind, projected?: UiTerminal['tone']): UiTerminal['tone'] {
  return projected ?? TONE[kind];
}

function isConversational(state: DashboardAgentState): boolean {
  if (state.answerSource === 'CONVERSATION') return true;
  return state.interaction?.terminal?.reason === 'CONVERSATIONAL_ANSWER';
}

// ── Terminal ────────────────────────────────────────────────────────────────

function projectTerminal(state: DashboardAgentState): UiTerminal | null {
  const kind = terminalKindFor(state);
  if (!kind) return null;
  const ix = state.interaction;
  const fr = ix?.finalResult;
  const hasFinal = Boolean(fr && fr.kind !== 'NONE');
  const headline =
    (hasFinal && fr?.headline) ||
    ix?.terminal?.headline ||
    FALLBACK_HEADLINES[kind];
  return {
    kind,
    tone: toneForKind(kind),
    headline: String(headline).slice(0, 500),
    body: hasFinal && fr?.body ? String(fr.body) : null,
    provenance: hasFinal && fr?.provenance ? String(fr.provenance) : null,
    remaining: hasFinal && fr?.remaining ? fr.remaining.slice(0, 10) : [],
  };
}

// ── Working label ───────────────────────────────────────────────────────────

function projectWorkingLabel(state: DashboardAgentState): string | null {
  if (state.status !== 'RUNNING') return null;
  const phase = state.interaction?.activity?.phase;
  if (phase === 'AWAITING_CONFIRMATION') return PHASE_LABELS.AWAITING_CONFIRMATION ?? 'Waiting for your confirmation';
  const fromPhase = phase ? PHASE_LABELS[phase] : undefined;
  if (fromPhase) return fromPhase;
  const stage = state.currentPipelineStage;
  const fromStage = stage ? STAGE_LABELS[stage] : undefined;
  if (fromStage) return fromStage;
  // Fail closed to a category-free generic. Never invent detail we were not
  // given: "Working…" claims only that work is occurring.
  return 'Working…';
}

// ── Activities (event-driven) ───────────────────────────────────────────────

export interface ActivityLog {
  task: string;
  items: UiActivity[];
  /** Keys already present, for idempotent merges. */
  seen: string[];
}

export const EMPTY_LOG: ActivityLog = { task: '', items: [], seen: [] };

function stepActivity(step: StepTelemetry, index: number): { key: string; label: string; status: UiActivityStatus; detail?: string } {
  const key = `step:${step.step || index + 1}`;
  const action = (step.actionType || '').toLowerCase();
  let label = ACTION_LABELS[action] || 'Performing the requested action';
  if (action === 'navigate') {
    const host = hostOf(step.targetDescription);
    if (host) label = `Opening ${host}`;
  }
  let status: UiActivityStatus = 'COMPLETE';
  if (step.validationPassed === false) status = 'BLOCKED';
  else if (step.executionSuccess === false) status = 'FAILED';
  let detail: string | undefined;
  if (step.effectStatus === 'EFFECT_VERIFIED') detail = 'effect verified';
  else if (step.effectStatus === 'ACTION_NO_EFFECT') detail = 'no change observed';
  else if (status === 'BLOCKED') detail = 'blocked by a safety check';
  if (step.sensitiveCategoryDetected) {
    // Category id only — the value itself never exists here.
    detail = detail ? `${detail} · masked ${step.sensitiveCategoryDetected}` : `masked ${step.sensitiveCategoryDetected}`;
  }
  return { key, label, status, detail };
}

/**
 * Fold one runtime report into the activity log. PURE: returns a new log and
 * never mutates the previous one, so callers (and tests) can reason about it
 * as a value.
 *
 * Only two event classes create activities:
 *   1. an executed step (it really ran — status from its real verdict), and
 *   2. a reported non-terminal activity phase (it really occurred).
 * Nothing is seeded, nothing is predicted, nothing repeats.
 */
export function mergeActivities(log: ActivityLog, state: DashboardAgentState): ActivityLog {
  const taskKey = state.task || '';
  if (taskKey !== log.task) {
    // A different message: its history starts empty — then this very report
    // is folded into that fresh log (it is an event of the new message, not
    // something to drop).
    log = { task: taskKey, items: [], seen: [] };
  }

  const items = log.items.slice();
  const seen = new Set(log.seen);
  const push = (entry: { key: string; label: string; status: UiActivityStatus; detail?: string }) => {
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    items.push({ key: entry.key, label: entry.label, status: entry.status, detail: entry.detail });
  };

  (state.steps || []).forEach((s, i) => push(stepActivity(s, i)));

  const phase = state.interaction?.activity?.phase;
  const phaseLabel = phase ? PHASE_LABELS[phase] : undefined;
  const running = state.status === 'RUNNING';
  if (running && phase && phase !== 'TERMINAL' && phaseLabel) {
    push({ key: `phase:${phase}`, label: phaseLabel, status: 'ACTIVE' });
  }

  // Exactly one activity is ACTIVE while running: the most recent one. Older
  // entries settle to their own real verdicts.
  if (running && items.length > 0) {
    for (let i = 0; i < items.length - 1; i += 1) {
      const entry = items[i];
      if (entry && entry.status === 'ACTIVE') items[i] = { ...entry, status: 'COMPLETE' };
    }
  }

  // Terminal: nothing is still active. Failed/blocked verdicts stand; the
  // rest are complete.
  if (TERMINAL_STATUSES.has(state.status)) {
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i];
      if (entry && entry.status === 'ACTIVE') items[i] = { ...entry, status: 'COMPLETE' };
    }
  }

  return { task: taskKey, items, seen: [...seen] };
}

// ── The projection ──────────────────────────────────────────────────────────

export function projectUi(state: DashboardAgentState, log: ActivityLog = EMPTY_LOG): UiModel {
  // Fail closed on a missing/odd state: the smallest honest surface.
  const hasTask = Boolean(state && state.task && String(state.task).trim());
  if (!state || state.status === 'IDLE' || !hasTask) {
    return {
      surface: 'IDLE', pending: false, workingLabel: null, activities: [],
      activityCount: 0, activeCount: 0, terminal: null, awaitingConfirmation: null,
      supersededNotice: null, stepCounter: null,
    };
  }

  const ix = state.interaction;
  const terminal = projectTerminal(state);

  // ── CONVERSATION: proven route marker only, never a guess. ──
  if (isConversational(state)) {
    // Pending until the ANSWER payload with its final result has arrived: the
    // port ack carries the provenance but no body yet.
    const hasResultCard = Boolean(ix?.finalResult && ix.finalResult.kind !== 'NONE');
    const pending = !terminal || (terminal.kind === 'ANSWER' && !hasResultCard);
    return {
      surface: 'CONVERSATION',
      pending,
      workingLabel: null,
      activities: [],
      activityCount: 0,
      activeCount: 0,
      // A chat that could not be produced is still a conversation: the notice
      // renders as the assistant's message, not as browser chrome.
      terminal: terminal ? { ...terminal, body: terminal.body ?? terminal.headline } : null,
      awaitingConfirmation: null,
      supersededNotice: null,
      stepCounter: null,
    };
  }

  // ── BROWSER PIPELINE ──
  const activities = log.items;
  const awaiting = state.requiresUserConfirmationAction || ix?.awaitingConfirmation
    ? {
        action: String(state.requiresUserConfirmationAction?.action || ix?.awaitingConfirmation?.action || ''),
        description: String(
          state.requiresUserConfirmationAction?.description ||
          ix?.awaitingConfirmation?.description ||
          'Consequential browser action',
        ),
        riskLevel: String(state.requiresUserConfirmationAction?.riskLevel || ix?.awaitingConfirmation?.riskLevel || 'HIGH'),
      }
    : null;

  return {
    surface: 'BROWSER_ACTIVITY',
    pending: false,
    workingLabel: projectWorkingLabel(state),
    activities,
    activityCount: activities.length,
    activeCount: activities.filter((a) => a.status === 'ACTIVE').length,
    terminal,
    awaitingConfirmation: awaiting,
    supersededNotice: state.supersededPreviousTask
      ? `Previous task replaced by this request: “${String(state.supersededPreviousTask).slice(0, 80)}”`
      : null,
    stepCounter: null,
  };
}
