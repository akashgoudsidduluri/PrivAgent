/**
 * PrivAgent — Phase 11: Human-Like Browser Interaction
 *
 * A deterministic interaction-quality layer that strengthens the EXISTING
 * execution primitives (content-script DOM dispatch) and target selection.
 * It introduces NO new authority: every action still flows through the
 * authoritative pipeline (Grounding → M5 → Security Critic → Privacy →
 * Risk/Confirmation → Execution → Effect Verification → Recovery → Goal
 * Verification) exactly as before.
 *
 * What this module adds:
 *  1. PRE-FLIGHT INTERACTABILITY — a deterministic, value-free decision about
 *     whether a target can actually be interacted with right now (visibility,
 *     enabled state, detached node, modal occlusion), used by the content
 *     script before dispatch and by the loop for viewport-aware handling.
 *  2. A SAFE KEYBOARD PRIMITIVE — `pressKey`, restricted to a fixed allowlist
 *     of keys (Enter, Escape, Tab, ArrowUp/Down) that target the CURRENTLY
 *     FOCUSED element only. No arbitrary key text, no global dispatch, and it
 *     is subject to the SAME M5/grounding/critic/privacy gates as every other
 *     action (the target, when present, is the focused control).
 *  3. BOUNDED VIEWPORT INTERACTION HELPERS — deterministic scroll math to
 *     bring a target into view and decide whether re-perception is warranted,
 *     with hard bounds; the scrolling itself stays an ordinary `scroll` action
 *     so Phase 10 recovery and effect verification remain authoritative.
 *  4. VALUE-FREE INTERACTION REPORTING — the content script reports structure
 *     only (lengths, selected indices, booleans); raw values never enter
 *     results, logs or history.
 *
 * No duplicate recovery, grounding, privacy or verification system is created.
 */

import { BrowserAction } from './actionTypes';

// ── 1. Pre-flight interactability ───────────────────────────────────────────

/**
 * Deterministic, value-free pre-flight verdict for interacting with a target.
 * All fields are structural: booleans, counts and geometry — never values.
 */
export interface InteractabilityReport {
  /** The element exists in the live DOM and is attached. */
  exists: boolean;
  /** Rendered and interactable (display/visibility/opacity/pointer-events). */
  visible: boolean;
  /** Not disabled / aria-disabled. */
  enabled: boolean;
  /** The element's geometry is non-degenerate. */
  hasGeometry: boolean;
  /** Element centre is inside the current viewport. */
  inViewport: boolean;
  /** An active modal/overlay is present that does NOT contain the target. */
  occludedByModal: boolean;
  /** Overall verdict: all structural preconditions hold. */
  interactable: boolean;
  /** Deterministic reason (code-level, value-free). */
  reason: string;
}

export interface InteractabilityInput {
  exists?: boolean;
  visible?: boolean;
  enabled?: boolean;
  hasGeometry?: boolean;
  inViewport?: boolean;
  occludedByModal?: boolean;
}

/**
 * Combines structural signals into a verdict. Pure function so the content
 * script (DOM-backed) and the tests (fixture-backed) share one rule set.
 */
export function assessInteractability(input: InteractabilityInput): InteractabilityReport {
  const exists = input.exists !== false;
  const visible = input.visible !== false;
  const enabled = input.enabled !== false;
  const hasGeometry = input.hasGeometry !== false;
  const inViewport = input.inViewport !== false;
  const occludedByModal = input.occludedByModal === true;

  let reason = 'Target is structurally interactable.';
  if (!exists) reason = 'Target is detached from the live DOM.';
  else if (!enabled) reason = 'Target is disabled (or aria-disabled).';
  else if (!visible) reason = 'Target is hidden (display/visibility/opacity/pointer-events).';
  else if (!hasGeometry) reason = 'Target has degenerate geometry (zero-size box).';
  else if (occludedByModal) reason = 'An active modal overlay does not contain the target.';
  else if (!inViewport) reason = 'Target is outside the current viewport; scroll into view first.';

  return {
    exists,
    visible,
    enabled,
    hasGeometry,
    inViewport,
    occludedByModal,
    interactable: exists && enabled && visible && hasGeometry && inViewport && !occludedByModal,
    reason,
  };
}

// ── 2. Safe keyboard primitive ──────────────────────────────────────────────

/**
 * The ONLY keys `pressKey` may deliver. Fixed allowlist — the model cannot
 * invent key text. Each key is a normal, non-destructive interaction:
 *  - Enter: submit the focused form / activate the focused control
 *  - Escape: close the focused popup/menu (does NOT dismiss security dialogs)
 *  - Tab: move focus (focus-management equivalent for keyboard flows)
 *  - ArrowUp/ArrowDown: native list/select navigation
 */
export const SAFE_KEYS = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown'] as const;
export type SafeKey = (typeof SAFE_KEYS)[number];

export function isSafeKey(key: string): key is SafeKey {
  return (SAFE_KEYS as readonly string[]).includes(key);
}

export interface PressKeyAction {
  action: 'pressKey';
  /** One of SAFE_KEYS. Anything else is rejected by M5 before this point. */
  key: SafeKey;
  /**
   * Optional target id: the control expected to hold focus. When provided,
   * grounding verifies it exists; execution verifies focus actually sits on
   * it (or inside its form) and fails with FOCUS_MISMATCH otherwise.
   */
  target?: string;
  reason?: string;
}

// ── 3. Bounded viewport interaction ─────────────────────────────────────────

/** Hard bounds for viewport-aware scrolling (deterministic, no loops). */
export const VIEWPORT_BOUNDS = {
  /** Maximum px distance the agent will auto-scroll to reach a target. */
  maxAutoScrollPx: 2400,
  /** Per-scroll step cap used when walking toward an off-screen target. */
  scrollStepPx: 600,
  /** After this many scroll+re-perceive walks, fail closed to recovery. */
  maxScrollWalks: 4,
} as const;

export interface ViewportGeometryLite {
  width: number;
  height: number;
  scrollY: number;
}

export interface TargetGeometryLite {
  /** Absolute page-space top (bbox top as reported by perception). */
  top: number;
  bottom: number;
}

/**
 * Deterministically decides whether a target is inside the live viewport.
 * Perception bboxes are page-space (they include scroll offset), matching the
 * scanner's `getBoundingBox`.
 */
export function isTargetInViewport(
  target: TargetGeometryLite,
  viewport: ViewportGeometryLite
): boolean {
  const viewTop = viewport.scrollY;
  const viewBottom = viewport.scrollY + viewport.height;
  return target.bottom > viewTop && target.top < viewBottom;
}

/**
 * Deterministic scroll plan to bring a target into view. Returns null when no
 * scrolling is needed. The plan is executed as a NORMAL `scroll` action —
 * it never dispatches directly — so effect verification, recovery bounds and
 * the security pipeline stay authoritative.
 */
export function planScrollToTarget(
  target: TargetGeometryLite,
  viewport: ViewportGeometryLite
): { direction: 'up' | 'down'; amount: number } | null {
  if (isTargetInViewport(target, viewport)) return null;
  const centre = (target.top + target.bottom) / 2;
  const viewCentre = viewport.scrollY + viewport.height / 2;
  const delta = Math.round(centre - viewCentre);
  const amount = Math.min(
    VIEWPORT_BOUNDS.maxAutoScrollPx,
    Math.max(VIEWPORT_BOUNDS.scrollStepPx, Math.abs(delta))
  );
  return { direction: delta > 0 ? 'down' : 'up', amount };
}

// ── 4. Value-free interaction result metadata ───────────────────────────────

/**
 * Structured result the content script attaches to an executed action. Every
 * field is value-free: booleans, indices, lengths — never the typed value,
 * never the selected option's text payload beyond the requested key/option
 * token that the model already proposed.
 */
export interface InteractionOutcome {
  interactable: boolean;
  interactabilityReason?: string;
  focused: boolean;
  focusVerified: boolean;
  /** For select: index of the option actually selected afterwards. */
  selectedIndex?: number;
  /** For select: whether post-state verification matched the request. */
  selectVerified?: boolean;
  /** For click: deterministic duplicate-dispatch guard engaged. */
  duplicateGuardEngaged?: boolean;
  /** For pressKey: the safe key that was delivered. */
  key?: SafeKey;
  /** Scroll performed to bring the target into view (always bounded). */
  scrolledIntoView?: boolean;
}

/**
 * Deterministic duplicate-click suppression. A target freshly interacted with
 * within the window is not clicked again — a repeated identical dispatch is
 * the signature of a loop, and Phase 10 recovery should see NO_EFFECT rather
 * than compounding clicks.
 */
export class DuplicateClickGuard {
  private readonly recent = new Map<string, number>();

  constructor(private readonly windowMs = 1200) {}

  /** Returns true when the click is allowed (not a duplicate). */
  shouldClick(targetId: string, now = Date.now()): boolean {
    const last = this.recent.get(targetId);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.recent.set(targetId, now);
    return true;
  }

  /** Test/telemetry helper: number of tracked targets. */
  get size(): number {
    return this.recent.size;
  }
}

// ── 5. Action-kind helpers ──────────────────────────────────────────────────

/** True for actions that target a DOM element (used for grounding metadata). */
export function isTargetedAction(action: BrowserAction | PressKeyAction): action is (BrowserAction & { target: string }) | PressKeyAction & { target: string } {
  return 'target' in action && typeof (action as { target?: unknown }).target === 'string';
}
