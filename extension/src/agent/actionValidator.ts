/**
 * PrivAgent — Local Action Validator (Milestone 5.2)
 *
 * Enforces local validation BEFORE any action reaches the extension execution layer.
 * Acts as an authoritative gatekeeper between the agent reasoning layer and the browser DOM.
 *
 * Security Invariants:
 *  1. Action type must be allowlisted ('click', 'scroll', 'type', 'select', 'navigate').
 *  2. Target element ID must exist in the current sanitized context.
 *  3. Target must correspond to a known element in context detections.
 *  4. Scroll amount must be bounded (1 <= amount <= 5000).
 *  5. Navigation URL must be valid http: or https: only.
 *  6. Reject javascript:, data:, vbscript:, file: URLs.
 *  7. Reject arbitrary script injection patterns.
 *  8. Reject unknown or forbidden fields (eval, code, script, executeScript, etc.).
 *  9. Case-normalized forbidden key checking.
 *  10. Never log sensitive values.
 */

import {
  ActionType,
  BrowserAction,
  ActionValidationResult,
  SUPPORTED_ACTION_TYPES,
  FORBIDDEN_ACTION_FIELDS,
  MAX_SCROLL_AMOUNT,
  MIN_SCROLL_AMOUNT,
} from './actionTypes';
import { AgentContextPayload } from '../privacy/types';

// Sensitive keys that must not appear as properties anywhere in the action object
const FORBIDDEN_SENSITIVE_KEYS = new Set([
  'value', 'password', 'token', 'secret', 'card',
  'cardnumber', 'card_number', 'cvv', 'pan',
  'accountnumber', 'account_number', 'rawtext', 'rawocr',
  'ocrtext', 'sensitivevalue', 'sensitive_value',
]);

const ALLOWED_ACTION_KEYS: Record<ActionType, ReadonlySet<string>> = {
  click: new Set(['action', 'target', 'reason']),
  scroll: new Set(['action', 'direction', 'amount', 'reason']),
  type: new Set(['action', 'target', 'text', 'reason']),
  select: new Set(['action', 'target', 'option', 'reason']),
  navigate: new Set(['action', 'url', 'reason']),
};

/**
 * Validates a proposed action against the current sanitized context and security rules.
 *
 * @param proposed - The raw action object (typically parsed from LLM JSON response)
 * @param context  - The latest sanitized AgentContextPayload
 * @returns ActionValidationResult with allowed: true or allowed: false
 */
export function validateAction(
  proposed: unknown,
  context: AgentContextPayload
): ActionValidationResult {
  // 1. Structure check: Must be a non-null, non-array object
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
    return fail('Action must be a valid non-empty JSON object.');
  }

  const actionObj = proposed as Record<string, unknown>;

  // 2. Scan for forbidden fields and sensitive keys
  for (const key of Object.keys(actionObj)) {
    const lowerKey = key.toLowerCase();
    const normalizedKey = lowerKey.replace(/_/g, '');

    if (FORBIDDEN_ACTION_FIELDS.has(key) || FORBIDDEN_ACTION_FIELDS.has(lowerKey)) {
      return fail(`Forbidden field detected in action: '${key}'. Arbitrary code execution is blocked.`);
    }

    if (FORBIDDEN_SENSITIVE_KEYS.has(lowerKey) || FORBIDDEN_SENSITIVE_KEYS.has(normalizedKey)) {
      return fail(`Forbidden sensitive key detected in action: '${key}'. Sensitive values cannot be transmitted in actions.`);
    }
  }

  // 3. Action type check
  const actionType = actionObj.action;
  if (typeof actionType !== 'string' || !SUPPORTED_ACTION_TYPES.includes(actionType as ActionType)) {
    return fail(
      `Invalid action type: '${String(actionType)}'. Allowed types: ${SUPPORTED_ACTION_TYPES.join(', ')}.`
    );
  }

  const typedAction = actionType as ActionType;

  // 4. Reject unknown properties for this action type
  const allowedKeys = ALLOWED_ACTION_KEYS[typedAction];
  for (const key of Object.keys(actionObj)) {
    if (!allowedKeys.has(key)) {
      return fail(`Unknown field '${key}' is not allowed on '${typedAction}' action.`);
    }
  }

  // Reason field check (if present, must be string)
  if ('reason' in actionObj && actionObj.reason !== undefined && typeof actionObj.reason !== 'string') {
    return fail("Field 'reason' must be a string if provided.");
  }

  // 5. Specific action validation
  switch (typedAction) {
    case 'click':
      return validateClick(actionObj, context);
    case 'scroll':
      return validateScroll(actionObj);
    case 'type':
      return validateType(actionObj, context);
    case 'select':
      return validateSelect(actionObj, context);
    case 'navigate':
      return validateNavigate(actionObj);
  }
}

// ── Per-action Validators ───────────────────────────────────────────────────

function validateClick(
  obj: Record<string, unknown>,
  context: AgentContextPayload
): ActionValidationResult {
  const target = obj.target;
  if (typeof target !== 'string' || !target.trim()) {
    return fail("Action 'click' requires a non-empty string 'target'.");
  }

  const targetId = target.trim();
  const detection = findDetection(targetId, context);
  if (!detection) {
    return fail(`Target element '${targetId}' does not exist in the current sanitized context.`);
  }

  const action: BrowserAction = {
    action: 'click',
    target: targetId,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };

  return pass(`Validated click action on known element '${targetId}'.`, action);
}

function validateScroll(obj: Record<string, unknown>): ActionValidationResult {
  const direction = obj.direction;
  if (direction !== 'up' && direction !== 'down') {
    return fail("Action 'scroll' direction must be 'up' or 'down'.");
  }

  const amount = obj.amount;
  if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount)) {
    return fail("Action 'scroll' amount must be a finite number.");
  }

  if (amount < MIN_SCROLL_AMOUNT || amount > MAX_SCROLL_AMOUNT) {
    return fail(
      `Action 'scroll' amount ${amount} is out of bounds. Must be between ${MIN_SCROLL_AMOUNT} and ${MAX_SCROLL_AMOUNT}px.`
    );
  }

  const action: BrowserAction = {
    action: 'scroll',
    direction,
    amount: Math.round(amount),
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };

  return pass(`Validated scroll ${direction} by ${action.amount}px.`, action);
}

function validateType(
  obj: Record<string, unknown>,
  context: AgentContextPayload
): ActionValidationResult {
  const target = obj.target;
  if (typeof target !== 'string' || !target.trim()) {
    return fail("Action 'type' requires a non-empty string 'target'.");
  }

  const text = obj.text;
  if (typeof text !== 'string') {
    return fail("Action 'type' requires a string 'text' field.");
  }

  // Detect script tags or javascript pseudoprotocol injection in typed text
  if (/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i.test(text) || /javascript:/i.test(text)) {
    return fail("Action 'type' text contains prohibited script injection syntax.");
  }

  const targetId = target.trim();
  const detection = findDetection(targetId, context);
  if (!detection) {
    return fail(`Target element '${targetId}' does not exist in the current sanitized context.`);
  }

  const action: BrowserAction = {
    action: 'type',
    target: targetId,
    text,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };

  return pass(`Validated type action on known element '${targetId}'.`, action);
}

function validateSelect(
  obj: Record<string, unknown>,
  context: AgentContextPayload
): ActionValidationResult {
  const target = obj.target;
  if (typeof target !== 'string' || !target.trim()) {
    return fail("Action 'select' requires a non-empty string 'target'.");
  }

  const option = obj.option;
  if (typeof option !== 'string' || !option.trim()) {
    return fail("Action 'select' requires a non-empty string 'option'.");
  }

  const targetId = target.trim();
  const detection = findDetection(targetId, context);
  if (!detection) {
    return fail(`Target element '${targetId}' does not exist in the current sanitized context.`);
  }

  const action: BrowserAction = {
    action: 'select',
    target: targetId,
    option: option.trim(),
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };

  return pass(`Validated select action '${action.option}' on known element '${targetId}'.`, action);
}

function validateNavigate(obj: Record<string, unknown>): ActionValidationResult {
  const urlStr = obj.url;
  if (typeof urlStr !== 'string' || !urlStr.trim()) {
    return fail("Action 'navigate' requires a non-empty string 'url'.");
  }

  const trimmed = urlStr.trim();

  // Reject dangerous pseudo-protocols
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('file:') ||
    lower.includes('<script')
  ) {
    return fail(`Action 'navigate' rejected unsafe or non-web protocol URL: '${trimmed}'.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail(`Action 'navigate' contains a malformed URL: '${trimmed}'.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail(`Action 'navigate' protocol must be 'http:' or 'https:', got '${parsed.protocol}'.`);
  }

  const action: BrowserAction = {
    action: 'navigate',
    url: parsed.href,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };

  return pass(`Validated navigation to '${parsed.origin}${parsed.pathname}'.`, action);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findDetection(targetId: string, context: AgentContextPayload) {
  if (!context || !Array.isArray(context.detections)) {
    return undefined;
  }
  return context.detections.find((d) => d.id === targetId);
}

function pass(reason: string, action: BrowserAction): ActionValidationResult {
  return { allowed: true, action, reason };
}

function fail(reason: string): ActionValidationResult {
  return { allowed: false, reason };
}
