/**
 * PrivAgent — Action Idempotency Guard (M11)
 *
 * Prevents accidental duplicate actions (e.g. double clicking 'Buy', submitting forms twice,
 * sending duplicate messages, or repeating navigations unnecessarily) by comparing proposed actions
 * with recent execution history and current observed browser state.
 *
 * Invariant:
 *  - Never mutates state. Pure deterministic evaluation.
 *  - Zero LLM calls.
 */

import { BrowserAction } from './actionTypes';

export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  shouldSkip: boolean;
  reason: string;
}

export interface ObservedBrowserState {
  currentUrl: string;
  activeElementId?: string;
  inputValues?: Record<string, string>;
  hasModalOpen?: boolean;
  isFormSubmitted?: boolean;
}

/**
 * Checks whether an action is a duplicate whose effect has already taken place.
 */
export function checkActionIdempotency(
  proposedAction: BrowserAction,
  recentActions: BrowserAction[],
  observedState?: ObservedBrowserState
): IdempotencyCheckResult {
  if (!recentActions || recentActions.length === 0) {
    return { isDuplicate: false, shouldSkip: false, reason: 'First action in sequence' };
  }

  const lastAction = recentActions[recentActions.length - 1];

  // 1. Navigation Idempotency: Already on target URL
  if (proposedAction.action === 'navigate' && proposedAction.url) {
    if (observedState?.currentUrl) {
      const normProposed = proposedAction.url.replace(/\/$/, '').toLowerCase();
      const normCurrent = observedState.currentUrl.replace(/\/$/, '').toLowerCase();
      if (normProposed === normCurrent) {
        return {
          isDuplicate: true,
          shouldSkip: true,
          reason: `Navigation skipped: browser is already at target URL '${proposedAction.url}'`,
        };
      }
    }
    if (lastAction && lastAction.action === 'navigate' && lastAction.url === proposedAction.url) {
      return {
        isDuplicate: true,
        shouldSkip: true,
        reason: `Duplicate navigation to '${proposedAction.url}' already dispatched in previous step`,
      };
    }
  }

  // 2. Type Idempotency: Target input already contains the text
  if (proposedAction.action === 'type') {
    if (observedState?.inputValues && proposedAction.target) {
      const currentVal = observedState.inputValues[proposedAction.target];
      if (currentVal !== undefined && currentVal === proposedAction.text) {
        return {
          isDuplicate: true,
          shouldSkip: true,
          reason: `Type action skipped: target '${proposedAction.target}' already contains value '${proposedAction.text}'`,
        };
      }
    }

    if (
      lastAction &&
      lastAction.action === 'type' &&
      lastAction.target === proposedAction.target &&
      lastAction.text === proposedAction.text
    ) {
      return {
        isDuplicate: true,
        shouldSkip: true,
        reason: `Duplicate type action: '${proposedAction.text}' was just entered into '${proposedAction.target}'`,
      };
    }
  }

  // 3. Click Idempotency: High-impact buttons (submit, buy, checkout) should not be double-clicked
  if (proposedAction.action === 'click') {
    const isConsequential =
      (proposedAction.reason || '').toLowerCase().includes('buy') ||
      (proposedAction.reason || '').toLowerCase().includes('pay') ||
      (proposedAction.reason || '').toLowerCase().includes('submit') ||
      (proposedAction.target || '').toLowerCase().includes('buy') ||
      (proposedAction.target || '').toLowerCase().includes('submit') ||
      (proposedAction.target || '').toLowerCase().includes('checkout');

    if (
      lastAction &&
      lastAction.action === 'click' &&
      lastAction.target === proposedAction.target &&
      isConsequential
    ) {
      return {
        isDuplicate: true,
        shouldSkip: true,
        reason: `Duplicate click prevented on consequential target '${proposedAction.target}' to prevent double execution`,
      };
    }
  }

  return {
    isDuplicate: false,
    shouldSkip: false,
    reason: 'Action is unique and eligible for execution',
  };
}
