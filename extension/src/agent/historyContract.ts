/**
 * PHASE 18.5 / I-2 — THE MODEL-FACING ACTION-HISTORY CONTRACT.
 *
 * `requestActionWithBoundedRetry` enriches the last action with its OBSERVED
 * effect and measured scroll delta before sending it back to the model. That
 * enrichment is load-bearing: without it the model cannot distinguish "I
 * scrolled and the page moved" from "I scrolled and nothing happened", which
 * is precisely the no-effect loop Phase 18.2 exists to break. It is preserved.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 * --------------------------------------
 * Action history is validated by the backend's `BrowserActionModel`, which is
 * `extra='forbid'` AND enforces per-action-type field applicability: a `type`
 * action requires a non-empty `text`, a `click` requires a `target`, and so
 * on. That strictness is correct and is NOT relaxed anywhere.
 *
 * The failure was on the SENDING side: the loop placed actions into history
 * that the backend's own contract rejects — observed live as a
 * `422 [PrivAgent Security] Action 'type' requires a non-empty 'text' field`
 * raised against `body.history[1]`. One malformed historical entry therefore
 * invalidated the ENTIRE reasoning request, losing a turn whose action was
 * otherwise perfectly valid.
 *
 * THE CONTRACT
 * ------------
 * This module is the single explicit definition of what may cross into reasoner
 * history, mirroring the backend's applicability rules exactly. Non-conforming
 * entries are dropped BEFORE egress rather than being sent to be rejected.
 *
 * Dropping is not silent and it is not a bypass: nothing here grants
 * permission, changes an action's meaning, or weakens a gate. An action that
 * cannot be expressed in the shared contract simply is not history the model
 * may rely on, and the count of dropped entries is reported so the condition
 * stays visible.
 */
import type { BrowserAction } from './actionTypes';

/** Action types the model may see in history. Mirrors the backend enum. */
const HISTORY_ACTION_TYPES = new Set([
  'click',
  'scroll',
  'type',
  'select',
  'navigate',
  'pressKey',
]);

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Does this action satisfy the model-facing history contract?
 *
 * Mirrors `BrowserActionModel`'s applicability rules: the same action types,
 * and the same required-field-per-type requirements. It is a SHAPE check on
 * history only — it is neither a security gate nor a substitute for M5, which
 * remain authoritative over the live action.
 */
export function conformsToHistoryContract(action: BrowserAction): boolean {
  if (!action || typeof action !== 'object') return false;
  const a = action as unknown as Record<string, unknown>;

  const type = a.action;
  if (typeof type !== 'string' || !HISTORY_ACTION_TYPES.has(type)) return false;

  switch (type) {
    case 'type':
      // A `type` action without text is not an expressible action.
      return nonEmptyString(a.target) && nonEmptyString(a.text);
    case 'click':
      return nonEmptyString(a.target);
    case 'select':
      return nonEmptyString(a.target) && nonEmptyString(a.option);
    case 'navigate':
      return nonEmptyString(a.url);
    case 'pressKey':
      return nonEmptyString(a.key);
    case 'scroll':
      return true;
    default:
      return false;
  }
}

/**
 * Filter history to entries the shared contract accepts.
 *
 * Returns the conforming entries plus the number dropped. Only the COUNT is
 * reported — never the content of a dropped entry, which may carry a target
 * label or typed text.
 */
export function filterToHistoryContract(actions: BrowserAction[]): {
  history: BrowserAction[];
  dropped: number;
} {
  const history: BrowserAction[] = [];
  let dropped = 0;
  for (const action of actions) {
    if (conformsToHistoryContract(action)) history.push(action);
    else dropped += 1;
  }
  return { history, dropped };
}