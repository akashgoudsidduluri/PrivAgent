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
import { isValidLuhn } from '../privacy/patterns';
import { groundProposedTarget } from './groundingEngine';

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

// ── Sensitive-content scan for free-text action fields (M7) ───────────────
//
// The LLM is UNTRUSTED: a `type` action's `text` (and a `select` action's
// `option`) must never become a smuggling channel for raw PII. Pattern-level
// checks complement the forbidden-key scan above. These are deliberately
// high-precision patterns (Luhn-validated cards, structured IDs, labeled
// credentials) to avoid blocking legitimate non-sensitive text.

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const INDIAN_PHONE_PATTERN = /(?:^|[\s(-])(\+?91[-\s]?)?[6-9]\d{9}(?=$|[\s).,])/;
// PAN: privacy-first over-approximation — the 4th character class accepts any
// letter (the audit found the demo fixture 'ABCDE1234F' passed when 'D' was
// excluded). Over-blocking a benign token here costs far less than leaking a PAN.
const PAN_PATTERN = /\b[A-Z]{3}[A-Z][A-Z]\d{4}[A-Z]\b/;
const LABELLED_CREDENTIAL_PATTERN = /(?:password|passcode|cvv|otp|pin)\s*[:=]\s*\S+/i;
// Conservative, privacy-first heuristics (M7):
//  - Full person names: two consecutive capitalized words. Over-blocks some
//    benign proper-noun text — accepted tradeoff: privacy wins over convenience.
//  - Credential-shaped tokens: 8+ char single token mixing upper, lower and
//    digits (e.g. unlabelled passwords like "DemoPassword123").
const FULL_NAME_PATTERN = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/;
const CREDENTIAL_TOKEN_PATTERN = /\b(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[^\s]{8,}\b/;

// M7 Phase 5 (HIGH-4, extension side): the `reason` field re-enters M6
// previousActions and the next LLM prompt, so it is scanned too — with a
// context-aware person-name rule mirroring backend text_safety.scan_reason_text:
// benign UI reasons start with an action verb ("Clicked Account Details") and
// stay exempt; verb-free reasons containing a TitleCase name bigram are blocked.
const REASON_ACTION_VERBS = new Set([
  'click', 'clicked', 'clicking', 'scroll', 'scrolled', 'scrolling',
  'type', 'typed', 'typing', 'select', 'selected', 'selecting',
  'navigate', 'navigated', 'navigating', 'open', 'opened', 'opening',
  'close', 'closed', 'closing', 'submit', 'submitted', 'submitting',
  'fill', 'filled', 'filling', 'enter', 'entered', 'entering',
  'find', 'finding', 'found', 'locate', 'locating', 'located',
  'reveal', 'revealing', 'search', 'searching', 'wait', 'waiting',
  'retry', 'retrying', 'retried', 'proceed', 'proceeding', 'proceeded',
  'skip', 'skipping', 'skipped', 'stop', 'stopped', 'stopping',
  'target', 'targeting', 'focus', 'focusing', 'complete', 'completed',
  'completing', 'finish', 'finished', 'verify', 'verified', 'verifying',
  'task', 'step', 'action',
]);

function startsWithActionVerb(reason: string): boolean {
  const firstWord = reason.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return REASON_ACTION_VERBS.has(firstWord.replace(/[.,;:!]$/, ''));
}

function containsSensitiveReasonContent(candidate: string): boolean {
  if (!candidate) return false;
  if (containsSensitiveContent(candidate)) return true;
  if (!startsWithActionVerb(candidate) && FULL_NAME_PATTERN.test(candidate)) {
    return true;
  }
  return false;
}

function containsSensitiveContent(candidate: string): boolean {
  if (!candidate) return false;

  // Luhn-validated credit card candidate (13-19 digits with optional separators)
  const digitRuns = candidate.replace(/[-\s]/g, '').match(/\d{13,19}/g);
  if (digitRuns && digitRuns.some((run) => isValidLuhn(run))) {
    return true;
  }

  if (LABELLED_CREDENTIAL_PATTERN.test(candidate)) return true;
  if (PAN_PATTERN.test(candidate)) return true;

  // Structured account numbers only: 9+ digit runs (pure digit strings).
  // Short numbers that could be amounts/dates/IDs are not treated as PII.
  if (/\b\d{9,}\b/.test(candidate)) return true;

  // Email addresses are PII in free text.
  if (EMAIL_PATTERN.test(candidate)) return true;

  // Indian mobile numbers (optionally +91 prefixed) — exclude bare amounts
  // by requiring a boundary/separator context before the number.
  if (INDIAN_PHONE_PATTERN.test(candidate)) return true;

  // Full person names (privacy-first; see heuristic notes above).
  if (FULL_NAME_PATTERN.test(candidate)) return true;

  // Credential-shaped tokens (unlabelled passwords, API keys).
  if (CREDENTIAL_TOKEN_PATTERN.test(candidate)) return true;

  return false;
}

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
  if (typeof actionType === 'string' && [
    'modify_security_policy',
    'disable_privacy',
    'disable_egress_firewall',
    'trust_domain',
    'trust_website',
    'bypass_confirmation',
    'allow_domain',
    'mark_webpage_trusted'
  ].includes(actionType.toLowerCase())) {
    return fail('M5_UNMODIFIABLE: Remote model output cannot modify local security policy. Execution blocked.');
  }

  if (typeof actionType !== 'string' || !SUPPORTED_ACTION_TYPES.includes(actionType as ActionType)) {
    return fail(
      `Invalid action type: '${String(actionType)}'. Allowed types: ${SUPPORTED_ACTION_TYPES.join(', ')}.`
    );
  }

  const typedAction = actionType as ActionType;

  // 4. Reject unknown properties for this action type
  const allowedKeys = ALLOWED_ACTION_KEYS[typedAction];
  for (const key of Object.keys(actionObj)) {
    if (actionObj[key] !== null && actionObj[key] !== undefined && !allowedKeys.has(key)) {
      return fail(`Unknown field '${key}' is not allowed on '${typedAction}' action.`);
    }
  }

  // Reason field check (if present, must be string + PII-free)
  if ('reason' in actionObj && actionObj.reason !== undefined && typeof actionObj.reason !== 'string') {
    return fail("Field 'reason' must be a string if provided.");
  }
  if (typeof actionObj.reason === 'string' && containsSensitiveReasonContent(actionObj.reason)) {
    return fail("Action reason appears to contain sensitive values (PII). Reasons must not carry raw values into history or prompts.");
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
  let detection = findDetection(targetId, context);
  let resolvedTargetId = targetId;

  if (!detection) {
    const grounding = groundProposedTarget(
      { action: 'click', target: targetId },
      context.detections
    );
    if (grounding.grounded && grounding.targetId) {
      resolvedTargetId = grounding.targetId;
      detection = findDetection(resolvedTargetId, context);
    } else {
      return fail(`Target element '${targetId}' does not exist in the current sanitized context.`);
    }
  }

  const action: BrowserAction = {
    action: 'click',
    target: resolvedTargetId,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };

  return pass(`Validated click action on known element '${resolvedTargetId}'.`, action);
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

  // M7: untrusted LLM must not smuggle raw PII through free-text fields
  if (containsSensitiveContent(text)) {
    return fail("Action 'type' text appears to contain sensitive values (PII). Values must never transit through agent actions.");
  }

  const targetId = target.trim();
  let detection = findDetection(targetId, context);
  let resolvedTargetId = targetId;

  if (!detection) {
    const grounding = groundProposedTarget(
      { action: 'type', target: targetId, text },
      context.detections
    );
    if (grounding.grounded && grounding.targetId) {
      resolvedTargetId = grounding.targetId;
      detection = findDetection(resolvedTargetId, context);
    } else {
      return fail(`Target element '${targetId}' does not exist in the current sanitized context.`);
    }
  }

  const action: BrowserAction = {
    action: 'type',
    target: resolvedTargetId,
    text,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };

  return pass(`Validated type action on known element '${resolvedTargetId}'.`, action);
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

  // M7: untrusted LLM must not smuggle raw PII through the option field
  if (containsSensitiveContent(option)) {
    return fail("Action 'select' option appears to contain sensitive values (PII).");
  }

  const targetId = target.trim();
  let detection = findDetection(targetId, context);
  let resolvedTargetId = targetId;

  if (!detection) {
    const grounding = groundProposedTarget(
      { action: 'select', target: targetId, option: option.trim() },
      context.detections
    );
    if (grounding.grounded && grounding.targetId) {
      resolvedTargetId = grounding.targetId;
      detection = findDetection(resolvedTargetId, context);
    } else {
      return fail(`Target element '${targetId}' does not exist in the current sanitized context.`);
    }
  }

  const action: BrowserAction = {
    action: 'select',
    target: resolvedTargetId,
    option: option.trim(),
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };

  return pass(`Validated select action '${action.option}' on known element '${resolvedTargetId}'.`, action);
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
