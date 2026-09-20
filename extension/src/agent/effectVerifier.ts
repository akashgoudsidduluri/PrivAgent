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
  | 'ACTION_NO_EFFECT'
  | 'URL_NAVIGATION_OBSERVED'
  | 'DOM_MUTATION_OBSERVED'
  | 'MODAL_STATE_CHANGED'
  | 'SCROLL_CHANGED'
  | 'VALUE_STATE_CHANGED'
  | 'FOCUS_SHIFT_OBSERVED';

export interface PreActionSnapshot {
  url: string;
  scrollX: number;
  scrollY: number;
  targetValueLength?: number;
  openModalsCount?: number;
  activeElementSelector?: string;
  domElementCount?: number;
  timestamp: number;
}

export interface PostActionSnapshot {
  url: string;
  scrollX: number;
  scrollY: number;
  targetValueLength?: number;
  openModalsCount?: number;
  activeElementSelector?: string;
  domElementCount?: number;
  timestamp: number;
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
  const urlChanged = pre.url !== post.url;
  const scrollDelta = Math.abs((post.scrollY ?? 0) - (pre.scrollY ?? 0)) + Math.abs((post.scrollX ?? 0) - (pre.scrollX ?? 0));
  const valueLengthChanged = (post.targetValueLength ?? 0) !== (pre.targetValueLength ?? 0);
  const modalsChanged = (post.openModalsCount ?? 0) !== (pre.openModalsCount ?? 0);
  const domMutated = (post.domElementCount ?? 0) !== (pre.domElementCount ?? 0);
  const focusChanged = (post.activeElementSelector || '') !== (pre.activeElementSelector || '');

  const diagnostics = {
    urlChanged,
    scrollDelta,
    valueLengthChanged,
    modalsChanged,
    domMutated,
    focusChanged,
  };

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
      if (valueLengthChanged || (post.targetValueLength ?? 0) > 0) {
        return {
          hasEffect: true,
          status: 'VALUE_STATE_CHANGED',
          details: `Type action registered value change in target '${action.target}' (length: ${post.targetValueLength}).`,
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
