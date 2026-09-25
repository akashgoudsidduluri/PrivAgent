/**
 * PrivAgent — Structured Browser Action Types (Milestone 5.1)
 *
 * Strict typed schema for browser actions produced by the agent reasoning layer
 * and verified by the local Action Validator before extension execution.
 *
 * Security Invariants:
 *  - Disallows arbitrary JavaScript execution (no eval, no script, no raw DOM injection).
 *  - Disallows arbitrary code strings.
 *  - Restricted to a deterministic 5-action allowlist:
 *      1. click
 *      2. scroll
 *      3. type
 *      4. select
 *      5. navigate
 *  - Targeted actions reference element IDs from the sanitized M4 context.
 */

export type ActionType = 'click' | 'scroll' | 'type' | 'select' | 'navigate' | 'pressKey';

export const SUPPORTED_ACTION_TYPES: readonly ActionType[] = [
  'click',
  'scroll',
  'type',
  'select',
  'navigate',
  'pressKey',
] as const;

export type ScrollDirection = 'up' | 'down';

export const MAX_SCROLL_AMOUNT = 5000;
export const MIN_SCROLL_AMOUNT = 1;

// ── Specific Action Schemas ──────────────────────────────────────────────────

export interface ClickAction {
  action: 'click';
  target: string;
  reason?: string;
}

export interface ScrollAction {
  action: 'scroll';
  direction: ScrollDirection;
  amount: number;
  reason?: string;
}

export interface TypeAction {
  action: 'type';
  target: string;
  text: string;
  reason?: string;
}

export interface SelectAction {
  action: 'select';
  target: string;
  option: string;
  reason?: string;
}

export interface NavigateAction {
  action: 'navigate';
  url: string;
  reason?: string;
}

/**
 * Phase 11: safe keyboard interaction. Restricted to a fixed allowlist of
 * non-destructive keys (see humanInteraction.SAFE_KEYS) delivered to the
 * CURRENTLY FOCUSED control. The key text is validator-controlled — the model
 * cannot invent arbitrary keys — and the action passes the same gates as all
 * others.
 */
export interface PressKeyAction {
  action: 'pressKey';
  key: string;
  /** Optional: the control expected to hold focus (verified at execution). */
  target?: string;
  reason?: string;
}

export type BrowserAction =
  | ClickAction
  | ScrollAction
  | TypeAction
  | SelectAction
  | NavigateAction
  | PressKeyAction;

// ── Validation & Execution Result Types ─────────────────────────────────────

export type ActionValidationResult =
  | {
      allowed: true;
      action: BrowserAction;
      reason: string;
    }
  | {
      allowed: false;
      action?: undefined;
      reason: string;
    };

export type ActionExecutionResult =
  | {
      success: true;
      action: BrowserAction;
      message?: string;
    }
  | {
      success: false;
      error: string;
      action?: BrowserAction;
    };

// ── Security Denylist for Action Objects ───────────────────────────────────

export const FORBIDDEN_ACTION_FIELDS = new Set([
  'eval',
  'code',
  'script',
  'executeScript',
  'executescript',
  'execute_script',
  'rawDOM',
  'rawDom',
  'raw_dom',
  'javascript',
  'payload',
  'html',
  'innerHTML',
  'outerHTML',
]);
