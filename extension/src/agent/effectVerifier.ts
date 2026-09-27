/**
 * PrivAgent — Generic Action Effect Verification Engine (M10)
 *
 * Verifies whether an executed BrowserAction produced an actual observable
 * effect in the browser DOM, URL, scroll position, or input state.
 *
 * Invariants:
 *  1. Never expose sensitive typed values to external callers or loggers.
 *  2. Generic across all action types (click, type, navigate, scroll, select).
 *  3. Flags ACTION_NO_EFFECT when an action fails to alter the observable state.
 *  4. Produces structured diagnostics to guide bounded recovery.
 */

import { BrowserAction } from './actionTypes';

export type EffectStatus =
  | 'EFFECT_OBSERVED'
  | 'EFFECT_UNVERIFIABLE'
  | 'ACTION_NO_EFFECT'
  | 'URL_NAVIGATION_OBSERVED'
  | 'DOM_MUTATION_OBSERVED'
  | 'MODAL_STATE_CHANGED'
  | 'SCROLL_CHANGED'
  | 'VALUE_STATE_CHANGED'
  | 'FOCUS_SHIFT_OBSERVED';

/**
 * PHASE 17.1 — OBSERVATION CONTRACT.
 *
 * The invariant this project already proved the hard way: **"unobservable" is
 * not "zero"**. A missing reading and a reading of zero are different facts, and
 * treating them as the same is how a fabricated effect gets reported as an
 * observed one.
 *
 * Every snapshot field therefore carries an explicit state:
 *
 *   OBSERVED       — a real reading was obtained from the authoritative source
 *   UNAVAILABLE    — the authoritative source exists but could not be read
 *   STALE          — a reading exists, but it describes a different document
 *   NOT_APPLICABLE — the field is meaningless for this snapshot (no target, etc.)
 *
 * A field in any state other than OBSERVED is NEVER compared, and never
 * contributes to a verdict. It is reported in the diagnostics so the refusal is
 * legible rather than silent.
 */
export type ObservationState =
  | 'OBSERVED'
  | 'UNAVAILABLE'
  | 'STALE'
  | 'NOT_APPLICABLE';

/** The state of every page-local field a snapshot can carry. */
export interface SnapshotFieldStates {
  url: ObservationState;
  scrollX: ObservationState;
  scrollY: ObservationState;
  targetValueLength: ObservationState;
  openModalsCount: ObservationState;
  activeElementSelector: ObservationState;
  domElementCount: ObservationState;
}

/**
 * Provenance and freshness for one snapshot.
 *
 * `tabLifecycleObserved: false` means the snapshot's URL came from Chrome's tab
 * record while the page could not be read — the Phase 16 DEFECT 3 case. The URL
 * is then a real reading and every page-local field is UNAVAILABLE.
 */
export interface SnapshotObservation {
  observedAt: number;
  tabId: number | null;
  /** The content script's monotonic counter. Null when the page was unreadable. */
  pageGeneration: number | null;
  tabLifecycleObserved: boolean;
  pageReadable: boolean;
  fields: SnapshotFieldStates;
}

/** All fields OBSERVED — the state of a snapshot taken straight from a reading. */
export function observedSnapshotFields(): SnapshotFieldStates {
  return {
    url: 'OBSERVED',
    scrollX: 'OBSERVED',
    scrollY: 'OBSERVED',
    targetValueLength: 'OBSERVED',
    openModalsCount: 'OBSERVED',
    activeElementSelector: 'OBSERVED',
    domElementCount: 'OBSERVED',
  };
}

/**
 * A snapshot with no page-side reading at all: the tab URL only.
 * Used when the content script was torn down mid-navigation.
 */
export function tabOnlySnapshotFields(): SnapshotFieldStates {
  return {
    url: 'OBSERVED',
    scrollX: 'UNAVAILABLE',
    scrollY: 'UNAVAILABLE',
    targetValueLength: 'UNAVAILABLE',
    openModalsCount: 'UNAVAILABLE',
    activeElementSelector: 'UNAVAILABLE',
    domElementCount: 'UNAVAILABLE',
  };
}

export interface PreActionSnapshot {
  url: string;
  scrollX: number;
  scrollY: number;
  /** `null` (Phase 17.1) = the target could not be located. `0` = genuinely empty. */
  targetValueLength?: number | null;
  openModalsCount?: number;
  activeElementSelector?: string;
  domElementCount?: number;
  timestamp: number;
  /** Phase 17.1 (C7): observed from `chrome.tabs`, never inferred. */
  title?: string | null;
  /**
   * Phase 17.1 (C4): false when only the tab record could be read and the
   * page was unavailable. Formally typed now; the contract, not this flag,
   * decides the verdict.
   */
  pageStateObservable?: boolean;
  /**
   * Phase 17.1. Omitted means "every field is a direct reading", which is only
   * true of a snapshot that actually came from an observation channel. The
   * AgentLoop no longer fabricates a pre-snapshot, so that remains sound.
   */
  observation?: SnapshotObservation;
}

export interface PostActionSnapshot {
  url: string;
  scrollX: number;
  scrollY: number;
  /** `null` (Phase 17.1) = the target could not be located. `0` = genuinely empty. */
  targetValueLength?: number | null;
  openModalsCount?: number;
  activeElementSelector?: string;
  domElementCount?: number;
  timestamp: number;
  /** Phase 17.1 (C7): observed from `chrome.tabs`, never inferred. */
  title?: string | null;
  pageStateObservable?: boolean;
  observation?: SnapshotObservation;
}

export interface ActionEffectResult {
  hasEffect: boolean;
  status: EffectStatus;
  details: string;
  diagnostics: {
    urlChanged: boolean;
    scrollDelta: number;
    valueLengthChanged: boolean;
    modalsChanged: boolean;
    domMutated: boolean;
    focusChanged: boolean;
    pageStateObservable: boolean;
    /** Phase 17.1 — the per-field observation states behind this verdict. */
    observation: {
      pre: SnapshotFieldStates | null;
      post: SnapshotFieldStates | null;
      /** True when pre and post provably describe different documents. */
      crossDocument: boolean;
    };
  };
  shouldRecover: boolean;
  suggestedRecovery?: string;
}

/**
 * Compares pre-action and post-action snapshots to determine if an observable effect occurred.
 */
export function verifyActionEffect(
  action: BrowserAction,
  pre: PreActionSnapshot,
  post: PostActionSnapshot
): ActionEffectResult {
  // ── PHASE 17.1 — observation contract enforcement ──────────────────────
  //
  // Everything below is decided by the STATE of each field, never by the
  // numeric value alone. A placeholder 0 in a field that is UNAVAILABLE is not
  // a reading of 0, and comparing it is how a fabricated effect is reported as
  // an observed one.
  const preFields = pre.observation?.fields ?? observedSnapshotFields();
  const postFields = post.observation?.fields ?? observedSnapshotFields();
  const pageObservable = (post as { pageStateObservable?: boolean }).pageStateObservable !== false;

  /** A field counts as a reading only when BOTH sides are OBSERVED. */
  const comparable = (field: keyof SnapshotFieldStates): boolean =>
    preFields[field] === 'OBSERVED' && postFields[field] === 'OBSERVED';

  // Phase 17.1 F3 — pre and post provably describe different documents when
  // the AUTHORITATIVE tab URL changed between them. Every page-local comparison
  // is then measuring two different pages, so it is NOT evidence of anything
  // this action did. Only the URL change itself survives.
  const crossDocument = comparable('url') && pre.url !== post.url;

  const urlChanged = crossDocument;
  const pageLocalComparable = pageObservable && !crossDocument;
  const scrollDelta = pageLocalComparable && comparable('scrollY') && comparable('scrollX')
    ? Math.abs((post.scrollY ?? 0) - (pre.scrollY ?? 0)) + Math.abs((post.scrollX ?? 0) - (pre.scrollX ?? 0))
    : 0;
  const valueLengthChanged = pageLocalComparable && comparable('targetValueLength')
    ? post.targetValueLength !== pre.targetValueLength
    : false;
  const modalsChanged = pageLocalComparable && comparable('openModalsCount')
    ? (post.openModalsCount ?? 0) !== (pre.openModalsCount ?? 0)
    : false;
  const domMutated = pageLocalComparable && comparable('domElementCount')
    ? (post.domElementCount ?? 0) !== (pre.domElementCount ?? 0)
    : false;
  const focusChanged = pageLocalComparable && comparable('activeElementSelector')
    ? (post.activeElementSelector || '') !== (pre.activeElementSelector || '')
    : false;

  const diagnostics = {
    urlChanged,
    scrollDelta,
    valueLengthChanged,
    modalsChanged,
    domMutated,
    focusChanged,
    pageStateObservable: pageObservable,
    observation: { pre: pre.observation?.fields ?? null, post: post.observation?.fields ?? null, crossDocument },
  };

  // ── Fail closed when the fields THIS ACTION needs were never observed ───
  //
  // "No effect" and "no way to tell" are different verdicts, and only the first
  // is a statement about the browser. When the field this action would be
  // measured on was not actually read, the honest answer is
  // EFFECT_UNVERIFIABLE — never ACTION_NO_EFFECT, which would be a claim the
  // system has no evidence for, and never a fabricated effect.
  //
  // This is per-action on purpose. A scroll needs scrollY; a type needs the
  // target's value length; a click can be evidenced by a URL change, which is
  // available even when the page itself is gone. Demanding every field for
  // every action would throw away the Phase 16 navigation fix, and demanding
  // none of them would reintroduce the fabrication 17.1 removes.
  const requiredFields: (keyof SnapshotFieldStates)[] =
    action.action === 'navigate'
      ? ['url']
      : action.action === 'scroll'
        ? ['url', 'scrollY']
        : action.action === 'type'
          ? ['url', 'targetValueLength']
          : action.action === 'select'
            ? ['url', 'targetValueLength']
            : ['url', 'openModalsCount', 'domElementCount', 'activeElementSelector'];

  const unreadableRequired = requiredFields.filter((f) => !comparable(f));
  //
  // A URL CHANGE is evidence in its own right and does not need the page to have
  // been readable. That is the Phase 16 navigation fix, and requiring page-local
  // fields here would undo it. The URL change establishes an observed EFFECT
  // only; goal verification still decides whether the user's goal was met.
  //
  const readable = crossDocument
    ? comparable('url')
    : unreadableRequired.length === 0 && pageLocalComparable;

  if (!readable) {
    const detailFields = crossDocument
      ? ['url (changed — pre and post describe different documents)']
      : unreadableRequired.length
        ? unreadableRequired
        : (Object.keys(postFields) as (keyof SnapshotFieldStates)[]).filter((f) => f !== 'url' && postFields[f] !== 'OBSERVED');
    return {
      hasEffect: false,
      status: 'EFFECT_UNVERIFIABLE',
      details:
        `Effect of '${action.action}' could not be verified: the browser state it would be measured on was not observed ` +
        `(unreadable: ${detailFields.length ? detailFields.join(', ') : 'page state unavailable'}). ` +
        `No effect is claimed in either direction.`,
      diagnostics,
      shouldRecover: true,
      suggestedRecovery: 'Re-perceive the live tab and retry once a page-side reading is available.',
    };
  }

  switch (action.action) {
    case 'navigate': {
      if (urlChanged) {
        return {
          hasEffect: true,
          status: 'URL_NAVIGATION_OBSERVED',
          details: `URL navigated from '${pre.url}' to '${post.url}'.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      return {
        hasEffect: false,
        status: 'ACTION_NO_EFFECT',
        details: `Navigate action did not change URL (remained at '${pre.url}').`,
        diagnostics,
        shouldRecover: true,
        suggestedRecovery: 'Check network connectivity or retry navigation with valid URL.',
      };
    }

    case 'click': {
      if (urlChanged) {
        return {
          hasEffect: true,
          status: 'URL_NAVIGATION_OBSERVED',
          details: `Click on '${action.target}' triggered page navigation to '${post.url}'.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      if (modalsChanged) {
        return {
          hasEffect: true,
          status: 'MODAL_STATE_CHANGED',
          details: `Click on '${action.target}' opened or closed a modal dialog.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      if (domMutated) {
        return {
          hasEffect: true,
          status: 'DOM_MUTATION_OBSERVED',
          details: `Click on '${action.target}' mutated DOM contents (${pre.domElementCount} -> ${post.domElementCount} elements).`,
          diagnostics,
          shouldRecover: false,
        };
      }
      if (focusChanged) {
        return {
          hasEffect: true,
          status: 'FOCUS_SHIFT_OBSERVED',
          details: `Click on '${action.target}' shifted focus to '${post.activeElementSelector}'.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      return {
        hasEffect: false,
        status: 'ACTION_NO_EFFECT',
        details: `Click on target '${action.target}' produced no observable URL change, modal, focus shift, or DOM mutation.`,
        diagnostics,
        shouldRecover: true,
        suggestedRecovery: 'Target may be inert or disabled. Trigger fresh perception and locate active interactive control.',
      };
    }

    case 'type': {
      // Phase 17.1 C5: `null` means the target could not be located, which is
      // NOT an observed length of 0. Only a genuinely observed number counts.
      const postLength = post.targetValueLength;
      if (valueLengthChanged || (typeof postLength === 'number' && postLength > 0)) {
        return {
          hasEffect: true,
          status: 'VALUE_STATE_CHANGED',
          details: `Type action registered value change in target '${action.target}' (length: ${postLength}).`,
          diagnostics,
          shouldRecover: false,
        };
      }
      return {
        hasEffect: false,
        status: 'ACTION_NO_EFFECT',
        details: `Type action on target '${action.target}' failed to register any value change in the DOM element.`,
        diagnostics,
        shouldRecover: true,
        suggestedRecovery: 'Element may not be an input/textarea or is read-only. Re-ground target with fresh perception.',
      };
    }

    case 'scroll': {
      if (scrollDelta >= 1) {
        return {
          hasEffect: true,
          status: 'SCROLL_CHANGED',
          details: `Scroll ${action.direction} by ${action.amount}px shifted viewport by ${scrollDelta}px.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      return {
        hasEffect: false,
        status: 'ACTION_NO_EFFECT',
        details: `Scroll ${action.direction} produced zero viewport movement (scrollDelta: 0px). Viewport likely hit scroll boundary.`,
        diagnostics,
        shouldRecover: true,
        suggestedRecovery: 'Scroll boundary reached. Consider scrolling in reverse direction or interacting with visible controls.',
      };
    }

    case 'select': {
      if (valueLengthChanged || domMutated || focusChanged) {
        return {
          hasEffect: true,
          status: 'VALUE_STATE_CHANGED',
          details: `Select option '${action.option}' updated element '${action.target}'.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      return {
        hasEffect: false,
        status: 'ACTION_NO_EFFECT',
        details: `Select action on target '${action.target}' did not register option change.`,
        diagnostics,
        shouldRecover: true,
        suggestedRecovery: 'Option may not exist in select menu. Re-perceive available options.',
      };
    }

    case 'pressKey': {
      // Phase 11: a keyboard action is verified like any other meaningful
      // action. It is NOT assumed to have taken effect: an inert or
      // unhandled key must surface as ACTION_NO_EFFECT so the Phase 10
      // recovery engine gets a chance to re-perceive.
      const keyRef = `key '${action.key}'${action.target ? ` on target '${action.target}'` : ''}`;
      if (urlChanged) {
        return {
          hasEffect: true,
          status: 'URL_NAVIGATION_OBSERVED',
          details: `PressKey ${keyRef} triggered page navigation to '${post.url}'.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      if (modalsChanged) {
        return {
          hasEffect: true,
          status: 'MODAL_STATE_CHANGED',
          details: `PressKey ${keyRef} opened or closed a modal dialog.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      if (valueLengthChanged) {
        return {
          hasEffect: true,
          status: 'VALUE_STATE_CHANGED',
          details: `PressKey ${keyRef} changed the target's value state (length: ${post.targetValueLength}).`,
          diagnostics,
          shouldRecover: false,
        };
      }
      if (domMutated) {
        return {
          hasEffect: true,
          status: 'DOM_MUTATION_OBSERVED',
          details: `PressKey ${keyRef} mutated DOM contents (${pre.domElementCount} -> ${post.domElementCount} elements).`,
          diagnostics,
          shouldRecover: false,
        };
      }
      if (focusChanged) {
        return {
          hasEffect: true,
          status: 'FOCUS_SHIFT_OBSERVED',
          details: `PressKey ${keyRef} shifted focus to '${post.activeElementSelector}'.`,
          diagnostics,
          shouldRecover: false,
        };
      }
      return {
        hasEffect: false,
        status: 'ACTION_NO_EFFECT',
        details: `PressKey ${keyRef} produced no observable URL change, value change, modal, focus shift, or DOM mutation.`,
        diagnostics,
        shouldRecover: true,
        suggestedRecovery: 'Focused control may not handle this key. Re-perceive and re-focus the intended control.',
      };
    }

    default:
      return {
        hasEffect: true,
        status: 'EFFECT_OBSERVED',
        details: `Action '${(action as any).action}' completed execution.`,
        diagnostics,
        shouldRecover: false,
      };
  }
}
