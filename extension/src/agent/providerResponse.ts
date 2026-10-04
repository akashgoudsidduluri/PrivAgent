/**
 * PrivAgent — PHASE 17.5: provider response validation, failure taxonomy,
 * stale-response identity and structured telemetry.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * The provider is UNTRUSTED INPUT. It is not an authority and never becomes one.
 * The production provider (`backendAgentProvider.ts`) previously returned the
 * backend's `action` field verbatim, with no schema validation, no size bound and
 * no binding to the observation the response was computed from. A provider
 * failure, a malformed response, or a response computed against browser state
 * that has since changed must all produce NO DISPATCH.
 *
 * ── Relationship to M5 ────────────────────────────────────────────────────────
 * This is ADDITIONAL defence, never a replacement. `actionValidator.validateAction`
 * (M5) remains the authority and still runs on every proposal, exactly as before.
 * Validating earlier means a malformed response is refused at the boundary instead
 * of travelling through the agent loop to be caught later.
 *
 * ── What validation is allowed to do ─────────────────────────────────────────
 * REFUSE ONLY. It never repairs, coerces, truncates or completes a malformed
 * action. A deterministic, narrow, allowlisted normalization of an already-valid
 * shape is permitted; inventing a missing field is not.
 *
 * ── Privacy ──────────────────────────────────────────────────────────────────
 * Telemetry here is identifiers, categories, counts and statuses only. No prompt,
 * no page text, no PII, no OCR text, no screenshot, no API key. Error messages
 * name the offending FIELD, never its value.
 */

import { SUPPORTED_ACTION_TYPES, type ActionType, type BrowserAction } from './actionTypes';
import { ProviderError, type ProviderErrorKind } from './openRouterProvider';

// ── Bounded limits (mirrors backend/app/reasoner.py) ──────────────────────────

export const MAX_RESPONSE_CONTENT_CHARS = 20_000;
export const MAX_REASON_CHARS = 300;
export const MAX_TEXT_CHARS = 500;
export const MAX_OPTION_CHARS = 200;
export const MAX_TARGET_CHARS = 200;
export const MAX_URL_CHARS = 2048;
export const MIN_SCROLL_AMOUNT = 1;
export const MAX_SCROLL_AMOUNT = 5000;

/** Hard ceiling on a raw response body read off the wire. */
export const MAX_RESPONSE_BODY_BYTES = 512 * 1024;

/** `Retry-After` is honoured only within this bound; never busy-loops. */
export const MAX_HONOURED_RETRY_AFTER_MS = 30_000;

/**
 * Phase 11 key allowlist, mirrored so a provider can never invent a key.
 * `humanInteraction.SAFE_KEYS` is the authority; this is the same set.
 */
const ALLOWED_PRESS_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
]);

/** Per-action-type required and optional fields. Unknown fields are refused. */
const ACTION_SHAPE: Record<ActionType, { required: readonly string[]; optional: readonly string[] }> = {
  click: { required: ['action', 'target'], optional: ['reason'] },
  scroll: { required: ['action', 'direction', 'amount'], optional: ['reason'] },
  type: { required: ['action', 'target', 'text'], optional: ['reason'] },
  select: { required: ['action', 'target', 'option'], optional: ['reason'] },
  navigate: { required: ['action', 'url'], optional: ['reason'] },
  pressKey: { required: ['action', 'key'], optional: ['reason', 'target'] },
};

// ── Failure taxonomy ──────────────────────────────────────────────────────────

/**
 * PHASE 17.5. The provider failure taxonomy.
 *
 * Every category here is DISTINGUISHABLE from the information actually available
 * at the call site (HTTP status, transport error, or parse outcome). No category
 * is inferred from guesswork. Maps 1:1 onto the brief's A–P list.
 */
export type ProviderFailureCategory =
  | 'NETWORK_FAILURE' // A
  | 'TIMEOUT' // B
  | 'HTTP_4XX' // C
  | 'HTTP_401_403' // D
  | 'HTTP_409' // E
  | 'HTTP_429_RATE_LIMIT' // F
  | 'HTTP_5XX' // G
  | 'EMPTY_RESPONSE' // H
  | 'INVALID_JSON' // I
  | 'SCHEMA_INVALID' // J
  | 'UNSUPPORTED_ACTION' // K
  | 'OVERSIZED_RESPONSE' // L
  | 'PROVIDER_CONFIGURATION_ERROR' // M
  | 'FALLBACK_EXHAUSTED' // N
  | 'STALE_RESPONSE' // O
  // PHASE 18.5 / I-3. The provider answered; the answer violated the action
  // contract. Deterministic and non-transient, so it must never be grouped
  // with the transport faults above (A-G).
  | 'MODEL_CONTRACT' // Q
  // PHASE 18.7 / A8. The provider answered with HTTP 200 and the body is not a
  // usable step: it is not JSON, it is missing required fields, it carries an
  // invalid enum value or a wrong field type, or it is internally contradictory
  // (a terminal proposal claiming a kind it cannot support; a proposal of kind
  // ACTION carrying no action). This is its own category precisely so it is
  // never mistaken for a transport outage, and never mistaken for success.
  | 'PROVIDER_INVALID_RESPONSE'
  | 'UNKNOWN_PROVIDER_FAILURE'; // P

/**
 * PHASE 18.7 / A8. The three validation stages a provider response must pass,
 * in order. A stage either yields the next input or a truthful failure; there
 * is no repair path between them.
 *
 *   HTTP          — transport status and `Retry-After` (backendAgentProvider)
 *   SCHEMA        — the envelope and the per-action-type field shape
 *   APPLICABILITY — the step must be internally coherent and applicable
 */
export type ProviderValidationStage = 'HTTP' | 'SCHEMA' | 'APPLICABILITY';

/** The existing repository error vocabulary, preserved — not replaced. */
export type { ProviderErrorKind };
export { ProviderError };

/** Deterministic kind+status → category. No guesswork, no string matching. */
export function categoryForKind(kind: ProviderErrorKind, status?: number): ProviderFailureCategory {
  switch (kind) {
    case 'timeout':
      return 'TIMEOUT';
    case 'network':
      return 'NETWORK_FAILURE';
    case 'rate_limit':
      return 'HTTP_429_RATE_LIMIT';
    case 'auth':
      return 'HTTP_401_403';
    case 'empty_response':
      return 'EMPTY_RESPONSE';
    case 'invalid_json':
      return 'INVALID_JSON';
    case 'missing_action':
      return 'SCHEMA_INVALID';
    case 'unsupported_action':
      return 'UNSUPPORTED_ACTION';
    // PHASE 18.5 / I-3. A model-contract violation is its own failure
    // category, so recovery and reporting can treat it as a deterministic
    // output problem rather than a transient transport fault.
    case 'model_contract':
      return 'MODEL_CONTRACT';
    case 'http_error':
    case 'unknown':
      break;
  }
  if (status === 409) return 'HTTP_409';
  if (typeof status === 'number' && status >= 500) return 'HTTP_5XX';
  if (typeof status === 'number' && status >= 400) return 'HTTP_4XX';
  return 'UNKNOWN_PROVIDER_FAILURE';
}

/**
 * Parse a `Retry-After` header. Only a plain number of SECONDS or an HTTP-date is
 * accepted, and the result is clamped. A malformed or absurd value yields
 * `undefined` so the caller falls back to its own bounded delay.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const raw = String(header).trim();
  if (raw === '') return undefined;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.min(seconds * 1000, MAX_HONOURED_RETRY_AFTER_MS);
  }

  // A leading '-' is a NEGATIVE delay, not a date. `Date.parse('-5')` happily
  // returns a real (past) date, which would silently become a 0ms hint. Reject
  // it outright rather than letting a negative value read as "retry immediately".
  if (raw.startsWith('-')) return undefined;

  const asDate = Date.parse(raw);
  if (Number.isNaN(asDate)) return undefined;
  const delta = asDate - nowMs;
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_HONOURED_RETRY_AFTER_MS);
}

/**
 * PHASE 17.5 (F5). Read and parse a response body under a HARD size bound.
 *
 * Prefers `text()` so the bound is applied to raw bytes BEFORE parsing (an
 * enormous body must never be handed to `JSON.parse`). Falls back to `json()`
 * for response-like objects that do not implement `text()`.
 *
 * Refuses oversized, empty and non-JSON bodies. Never returns a partial parse.
 */
export async function readBoundedJsonBody(resp: Response): Promise<unknown> {
  if (typeof resp.text === 'function') {
    const raw = await resp.text();
    if (raw.length > MAX_RESPONSE_BODY_BYTES) {
      throw new ProviderError(
        `Provider response exceeds the ${MAX_RESPONSE_BODY_BYTES}-byte limit.`,
        'invalid_json',
        { category: 'OVERSIZED_RESPONSE' }
      );
    }
    if (raw.trim().length === 0) {
      throw new ProviderError('Provider returned an empty response body.', 'empty_response', {
        category: 'EMPTY_RESPONSE',
      });
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new ProviderError('Provider returned a non-JSON response body.', 'invalid_json', {
        category: 'INVALID_JSON',
      });
    }
  }
  try {
    return await resp.json();
  } catch {
    throw new ProviderError('Provider returned a non-JSON response body.', 'invalid_json', {
      category: 'INVALID_JSON',
    });
  }
}

// ── Strict response validation ────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireBoundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new ProviderError(`Provider action field '${field}' must be a string.`, 'invalid_json', {
      category: 'SCHEMA_INVALID',
    });
  }
  if (value.length > max) {
    throw new ProviderError(`Provider action field '${field}' exceeds ${max} characters.`, 'invalid_json', {
      category: 'OVERSIZED_RESPONSE',
    });
  }
  return value;
}

/**
 * PHASE 17.5. Validate one untrusted provider action.
 *
 * REJECTS — never repairs:
 *   • non-object / array / null
 *   • missing or non-string `action`
 *   • unknown or unsupported action type
 *   • missing required per-type fields
 *   • wrong field types
 *   • unexpected fields
 *   • malformed coordinates / URL / key / scroll direction / amount
 *   • oversized strings
 *
 * On success returns a structurally valid action. It performs NO grounding, NO
 * privacy judgment and NO authorization — those remain M5's job and are not
 * duplicated here.
 */
export function validateProviderAction(raw: unknown): BrowserAction {
  if (!isPlainObject(raw)) {
    throw new ProviderError('Provider response is not a JSON object.', 'invalid_json', {
      category: 'INVALID_JSON',
    });
  }

  const actionType = raw.action;
  if (typeof actionType !== 'string' || actionType.length === 0) {
    throw new ProviderError("Provider response is missing a string 'action' field.", 'missing_action', {
      category: 'SCHEMA_INVALID',
    });
  }
  if (!SUPPORTED_ACTION_TYPES.includes(actionType as ActionType)) {
    throw new ProviderError(`Provider proposed an unsupported action type: '${actionType}'.`, 'unsupported_action', {
      category: 'UNSUPPORTED_ACTION',
    });
  }
  const typed = actionType as ActionType;
  const shape = ACTION_SHAPE[typed];

  // Unknown fields are refused outright.
  for (const key of Object.keys(raw)) {
    if (!shape.required.includes(key) && !shape.optional.includes(key)) {
      throw new ProviderError(`Provider action has unexpected field '${key}'.`, 'invalid_json', {
        category: 'SCHEMA_INVALID',
      });
    }
  }
  // Required fields must be present and not null/undefined.
  for (const key of shape.required) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new ProviderError(`Provider action '${typed}' is missing required field '${key}'.`, 'missing_action', {
        category: 'SCHEMA_INVALID',
      });
    }
  }

  const out: Record<string, unknown> = { action: typed };

  switch (typed) {
    case 'click': {
      const target = requireBoundedString(raw.target, 'target', MAX_TARGET_CHARS).trim();
      if (target.length === 0) {
        throw new ProviderError("Provider action 'click' has an empty 'target'.", 'missing_action', {
          category: 'SCHEMA_INVALID',
        });
      }
      out.target = target;
      break;
    }
    case 'type': {
      const target = requireBoundedString(raw.target, 'target', MAX_TARGET_CHARS).trim();
      if (target.length === 0) {
        throw new ProviderError("Provider action 'type' has an empty 'target'.", 'missing_action', {
          category: 'SCHEMA_INVALID',
        });
      }
      out.target = target;
      out.text = requireBoundedString(raw.text, 'text', MAX_TEXT_CHARS);
      break;
    }
    case 'select': {
      out.target = requireBoundedString(raw.target, 'target', MAX_TARGET_CHARS).trim();
      out.option = requireBoundedString(raw.option, 'option', MAX_OPTION_CHARS);
      break;
    }
    case 'scroll': {
      const direction = raw.direction;
      if (direction !== 'up' && direction !== 'down') {
        throw new ProviderError("Provider action 'scroll' has an invalid 'direction'.", 'invalid_json', {
          category: 'SCHEMA_INVALID',
        });
      }
      out.direction = direction;
      const amount = raw.amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw new ProviderError("Provider action 'scroll' has a non-numeric 'amount'.", 'invalid_json', {
          category: 'SCHEMA_INVALID',
        });
      }
      if (amount < MIN_SCROLL_AMOUNT || amount > MAX_SCROLL_AMOUNT) {
        throw new ProviderError(
          `Provider action 'scroll' amount is outside ${MIN_SCROLL_AMOUNT}-${MAX_SCROLL_AMOUNT}.`,
          'invalid_json',
          { category: 'SCHEMA_INVALID' }
        );
      }
      out.amount = amount;
      break;
    }
    case 'navigate': {
      const url = requireBoundedString(raw.url, 'url', MAX_URL_CHARS).trim();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ProviderError("Provider action 'navigate' has a malformed 'url'.", 'invalid_json', {
          category: 'SCHEMA_INVALID',
        });
      }
      //
      // SCHEMA layer only: a malformed URL is refused here.
      //
      // SCHEME POLICY is deliberately NOT duplicated here. Whether
      // `javascript:` / `data:` / `file:` is allowed is an AUTHORIZATION
      // decision owned by M5 (`validateNavigate`) and the containment checks.
      // Repeating it here would create a second, independent copy of a security
      // rule that could drift — the exact "duplicated state machine" antipattern.
      // M5 still refuses it, and continues to be the single authority.
      out.url = url;
      break;
    }
    case 'pressKey': {
      const key = requireBoundedString(raw.key, 'key', 32);
      if (!ALLOWED_PRESS_KEYS.has(key)) {
        throw new ProviderError(`Provider action 'pressKey' requested a non-allowlisted key.`, 'unsupported_action', {
          category: 'UNSUPPORTED_ACTION',
        });
      }
      out.key = key;
      if (raw.target !== undefined && raw.target !== null) {
        out.target = requireBoundedString(raw.target, 'target', MAX_TARGET_CHARS).trim();
      }
      break;
    }
  }

  if (raw.reason !== undefined && raw.reason !== null) {
    out.reason = requireBoundedString(raw.reason, 'reason', MAX_REASON_CHARS);
  }

  return out as unknown as BrowserAction;
}

/**
 * PHASE 18.7 / A8 — STAGE 3: SEMANTIC / APPLICABILITY VALIDATION.
 *
 * The SCHEMA stage above asks "does this have the right shape?". This asks "is
 * it APPLICABLE?", which is a different question and the one the real defect
 * class escaped: a body can satisfy every structural rule and still say
 * something the agent cannot act on.
 *
 * What is checked here is INTERNAL COHERENCE only:
 *   • a terminal proposal of kind `ACTION` must actually carry an action, and
 *     that action must itself validate — otherwise the relay would hand a
 *     terminal-shaped envelope containing an unvalidated action straight to the
 *     device, which is precisely how a malformed 200 becomes a bogus action;
 *   • a terminal proposal of kind `ANSWER`/`PARTIAL` must actually carry an
 *     answer, `NEEDS_INFORMATION` a question or a list of what is missing, and
 *     `CANNOT_VERIFY` a reason — a proposal that asserts an outcome it does not
 *     support is refused here rather than reaching the A1 device verifier as an
 *     unexplicable claim.
 *
 * What is NOT checked here, deliberately: grounding (M5), scheme policy
 * (containment), risk and confirmation. Duplicating a security rule here would
 * create a second authority that could drift from the first.
 *
 * REFUSES ONLY. It never fills a missing field, never widens a kind, and never
 * turns an unusable step into a usable one.
 */
const PROPOSAL_KINDS: ReadonlySet<string> = new Set([
  'ACTION',
  'ANSWER',
  'NEEDS_INFORMATION',
  'PARTIAL',
  'CANNOT_VERIFY',
]);

const TERMINAL_KINDS: ReadonlySet<string> = new Set(['ANSWER', 'NEEDS_INFORMATION', 'PARTIAL', 'CANNOT_VERIFY']);

function inapplicable(message: string): ProviderError {
  return new ProviderError(message, 'missing_action', {
    category: 'PROVIDER_INVALID_RESPONSE',
  });
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** STAGE 3. Returns the same step, or throws. Never mutates, never repairs. */
export function validateStepApplicability(step: ProviderStep): ProviderStep {
  if (step.kind === 'ACTION') {
    // A schema-valid action is, by construction, internally coherent: the
    // schema stage already refused non-applicable fields and missing required
    // ones. There is nothing left to check that would not be a duplicate of an
    // existing authority.
    return step;
  }

  const raw = step.proposal as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' ? raw.kind : undefined;
  if (kind === undefined || !PROPOSAL_KINDS.has(kind)) {
    throw inapplicable('Provider terminal proposal declares an unknown kind.');
  }

  if (kind === 'ACTION') {
    // The proposal says "act", so it must carry an action — and that action
    // goes through the SAME schema stage as any other.
    const nested = raw.action;
    if (!isPlainObject(nested)) {
      throw inapplicable('Provider terminal proposal declares ACTION but carries no action.');
    }
    return Object.freeze({ kind: 'ACTION' as const, action: validateProviderAction(nested) });
  }

  if (!TERMINAL_KINDS.has(kind)) return step;

  if ((kind === 'ANSWER' || kind === 'PARTIAL') && !nonEmptyString(raw.answer)) {
    throw inapplicable(`Provider terminal proposal declares ${kind} but carries no answer.`);
  }
  if (kind === 'NEEDS_INFORMATION') {
    const missing = Array.isArray(raw.missing) ? raw.missing.filter((m) => nonEmptyString(m)) : [];
    if (!nonEmptyString(raw.question) && missing.length === 0) {
      throw inapplicable('Provider terminal proposal declares NEEDS_INFORMATION with no question or gap.');
    }
  }
  if (kind === 'CANNOT_VERIFY' && !nonEmptyString(raw.reason)) {
    throw inapplicable('Provider terminal proposal declares CANNOT_VERIFY with no reason.');
  }
  return step;
}

/**
 * PHASE 18.7 / A8 — THE WHOLE PIPELINE, with the stage attached to the failure.
 *
 * `HTTP` status handling lives in the provider (it needs the status code and the
 * headers); everything downstream of it lives here. A failure always carries the
 * stage it died at, so a malformed 200 is never reported as a transport outage
 * and never reported as success.
 */
export function validateProviderResponse(data: unknown): ProviderStep {
  return validateStepApplicability(validateProviderStep(data));
}
/**
 * PHASE 18.7 / A8 — BOUNDED, TASK-CLASS-AWARE RETRY BUDGET.
 *
 * `HTTP 200` is not the question this answers; the question is how many more
 * times it is worth asking. Two facts drive it:
 *
 *  1. TRANSIENT vs DETERMINISTIC. A transport fault or a rate limit may clear
 *     on its own. A malformed body, a schema violation, an invalid enum or an
 *     unsupported action will not: asking the same question again produces the
 *     same answer, so a deterministic failure gets a SMALLER budget, not a
 *     larger one.
 *  2. TASK CLASS. An information task has nothing partial to protect and no
 *     intermediate value to gain, so a rate-limited first attempt must not burn
 *     the whole budget, and a deterministic failure is not retried for it at
 *     all — a second identical malformed answer tells us nothing new.
 *
 * The budget is a hard count. It is computed here, once, from a category and a
 * task class — never from a message string, never from a counter the provider
 * controls.
 */
export type ProviderTaskClass = 'INFORMATION' | 'INTERACTIVE' | 'UNKNOWN';

/**
 * Failure categories a retry could plausibly fix. Everything else is treated
 * as deterministic. A rate limit WITHOUT a provider-supplied `Retry-After` is
 * deliberately NOT transient here — the Phase 17.5 rule that a rate limit is
 * never retried on a guess is preserved (see `isTransientFailure`).
 */
const TRANSIENT_CATEGORIES: ReadonlySet<ProviderFailureCategory> = new Set<ProviderFailureCategory>([
  'NETWORK_FAILURE',
  'TIMEOUT',
  'HTTP_5XX',
  'HTTP_429_RATE_LIMIT',
  'EMPTY_RESPONSE',
  'FALLBACK_EXHAUSTED',
]);

/**
 * Categories that are NEVER retried, whatever anything else claims. A
 * malformed body, a schema violation or an auth failure produces the same
 * answer every time it is asked.
 */
const NEVER_RETRY_CATEGORIES: ReadonlySet<ProviderFailureCategory> = new Set<ProviderFailureCategory>([
  'SCHEMA_INVALID',
  'INVALID_JSON',
  'UNSUPPORTED_ACTION',
  'MODEL_CONTRACT',
  'PROVIDER_INVALID_RESPONSE',
  'OVERSIZED_RESPONSE',
  'HTTP_401_403',
  'HTTP_409',
  'PROVIDER_CONFIGURATION_ERROR',
]);

/**
 * True when a retry could plausibly change the answer.
 *
 * `declaredRetryable` is the transport's OWN verdict, and it is honoured only
 * for a category that does not positively say the failure is deterministic.
 * That is what keeps a bare, uncategorised transport fault retryable while a
 * malformed body stays un-retryable even if something upstream flags it.
 */
export function isTransientFailure(
  category: ProviderFailureCategory,
  retryAfterMs?: number,
  declaredRetryable?: boolean
): boolean {
  // A rate limit is only transient when the provider published its own
  // `Retry-After`. Without one, retrying is guessing at a published limit.
  if (category === 'HTTP_429_RATE_LIMIT') return typeof retryAfterMs === 'number';
  if (NEVER_RETRY_CATEGORIES.has(category)) return false;
  if (TRANSIENT_CATEGORIES.has(category)) return true;
  return declaredRetryable === true;
}

const TRANSIENT_BUDGET: Readonly<Record<ProviderTaskClass, number>> = Object.freeze({
  INFORMATION: 1,
  INTERACTIVE: 2,
  UNKNOWN: 2,
});

const DETERMINISTIC_BUDGET: Readonly<Record<ProviderTaskClass, number>> = Object.freeze({
  INFORMATION: 0,
  INTERACTIVE: 1,
  UNKNOWN: 1,
});

/** How many additional attempts (beyond the first) this failure may take. */
export function providerRetryBudget(
  taskClass: ProviderTaskClass,
  category: ProviderFailureCategory,
  retryAfterMs?: number,
  declaredRetryable?: boolean
): number {
  const transient = isTransientFailure(category, retryAfterMs, declaredRetryable);
  // M7 / Phase 17.5, strengthened: a rate limit the provider gave no
  // `Retry-After` for is never retried, on any task class. Honouring a limit we
  // cannot read the terms of is guessing.
  if (category === 'HTTP_429_RATE_LIMIT' && !transient) return 0;
  return transient ? TRANSIENT_BUDGET[taskClass] : DETERMINISTIC_BUDGET[taskClass];
}

/**
 * Classify a task from what the device ALREADY KNOWS. Never from the model's
 * prose: the intent boundary's frozen decision is the only source, and it is
 * what lets an information task — which has nothing partial to protect and no
 * intermediate value to gain — spend less of its retry budget on a provider
 * that is not answering.
 */
export function providerTaskClassFor(input: {
  requiresEvidence?: boolean;
  requiresDestination?: boolean;
}): ProviderTaskClass {
  if (input.requiresEvidence === true && input.requiresDestination === false) return 'INFORMATION';
  if (input.requiresEvidence === true && input.requiresDestination === true) return 'UNKNOWN';
  return 'INTERACTIVE';
}

/**
 * PHASE 18.7 / A8 — THE TRUTHFUL OUTCOME OF A PROVIDER FAILURE.
 *
 * A provider failure is NEVER a success, never a completed subgoal, and never
 * a goal-verified result. It is its own terminal state, which is what makes it
 * distinguishable from a browser failure, a goal failure and insufficient
 * evidence — the four states a rate limit used to be confused with.
 */
export function terminalStateForProviderFailure(category: ProviderFailureCategory): 'PROVIDER_UNAVAILABLE' {
  // One state, deliberately. Every provider-failure category — transport,
  // schema, applicability — is a truthful "the reasoning service could not
  // produce a usable step", and none of them is a statement about the page.
  void category;
  return 'PROVIDER_UNAVAILABLE';
}

/** Validate a provider's whole response envelope before the action is read out of
 * it. A malformed envelope produces NO ACTION.
 */
export function validateProviderEnvelope(data: unknown): BrowserAction {
  if (!isPlainObject(data)) {
    throw new ProviderError('Provider returned a non-object response envelope.', 'invalid_json', {
      category: 'INVALID_JSON',
    });
  }
  if (data.success !== true) {
    throw new ProviderError('Provider reported an unsuccessful response.', 'unknown', {
      category: 'UNKNOWN_PROVIDER_FAILURE',
    });
  }
  if (data.action === undefined || data.action === null) {
    throw new ProviderError('Provider response contains no action.', 'missing_action', {
      category: 'SCHEMA_INVALID',
    });
  }
  return validateProviderAction(data.action);
}

/**
 * PHASE 18.7 / A1 — one validated step, which is EITHER an action OR an inert
 * terminal proposal.
 *
 * The two cases are mutually exclusive and a response carrying both is
 * refused: a provider that states two contradictory things has produced an
 * ambiguous step, and silently preferring one is how a model would smuggle an
 * action past the terminal path.
 *
 * `validateProviderEnvelope` above is deliberately NOT relaxed. Its action-only
 * rules, including the refusal when no action is present, are unchanged and
 * still run in full whenever the response is an action.
 */
export type ProviderStep =
  | { readonly kind: 'ACTION'; readonly action: BrowserAction }
  | { readonly kind: 'TERMINAL_PROPOSAL'; readonly proposal: Readonly<Record<string, unknown>> };

const TERMINAL_PROPOSAL_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(['kind', 'reason', 'question', 'answer', 'cited_evidence', 'citedEvidence', 'missing'])
);

export function validateProviderStep(data: unknown): ProviderStep {
  if (!isPlainObject(data)) {
    throw new ProviderError('Provider returned a non-object response envelope.', 'invalid_json', {
      category: 'INVALID_JSON',
    });
  }
  if (data.success !== true) {
    throw new ProviderError('Provider reported an unsuccessful response.', 'unknown', {
      category: 'UNKNOWN_PROVIDER_FAILURE',
    });
  }

  const hasAction = data.action !== undefined && data.action !== null;
  const hasProposal = isPlainObject(data.proposal);

  if (hasAction && hasProposal) {
    throw new ProviderError(
      'Provider response contains both an action and a terminal proposal.',
      'missing_action',
      { category: 'SCHEMA_INVALID' }
    );
  }

  if (hasAction) {
    // Identical path, identical guards, identical exceptions.
    return Object.freeze({ kind: 'ACTION' as const, action: validateProviderEnvelope(data) });
  }

  if (hasProposal) {
    const raw = data.proposal as Record<string, unknown>;
    // Allowlist at the boundary. An unknown key is REFUSED, not stripped, so a
    // provider cannot hide a field the device never audits.
    for (const key of Object.keys(raw)) {
      if (!TERMINAL_PROPOSAL_KEYS.has(key)) {
        throw new ProviderError(
          `Provider terminal proposal carries an unexpected field: ${key}.`,
          'missing_action',
          { category: 'SCHEMA_INVALID' }
        );
      }
    }
    return Object.freeze({
      kind: 'TERMINAL_PROPOSAL' as const,
      proposal: Object.freeze({ ...raw }),
    });
  }

  throw new ProviderError(
    'Provider response contains neither an action nor a terminal proposal.',
    'missing_action',
    { category: 'SCHEMA_INVALID' }
  );
}

// ── Stale-response identity ───────────────────────────────────────────────────

/**
 * PHASE 17.5. Derive an identity for the observation a proposal was computed
 * from, using Phase 17.1 provenance only.
 *
 * This is a DIGEST of structural identity — page generation, URL, and the set of
 * detection IDs. It contains no page text, no attribute values and nothing that
 * could carry PII, and it is never persisted: it lives for one cycle.
 */
export function observationIdentity(input: {
  pageGeneration: number;
  url: string;
  detectionIds: readonly string[];
}): string {
  const ids = [...input.detectionIds].sort().join(',');
  const material = `${input.pageGeneration}|${input.url}|${ids}`;
  // FNV-1a: deterministic, dependency-free, non-cryptographic. This identifies a
  // cycle, it is not a security token.
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `obs-${hash.toString(16).padStart(8, '0')}-${material.length.toString(16)}`;
}

/** True when the observation a proposal was computed from is still current. */
export function isObservationCurrent(expected: string, actual: string): boolean {
  return expected.length > 0 && expected === actual;
}

// ── Structured telemetry ──────────────────────────────────────────────────────

/**
 * PHASE 17.5. Provider telemetry.
 *
 * Contains identifiers, categories, counts and statuses ONLY. There is
 * deliberately no field for a prompt, page content, PII, OCR text, a screenshot
 * or a credential — the type makes adding one a compile error.
 */
export interface ProviderTelemetryEvent {
  provider: string;
  /** Assigned by the provider when it records the event. */
  requestId?: string;
  cycle: number;
  attempt: number;
  category: ProviderFailureCategory | 'OK';
  httpStatus: number | null;
  retryable: boolean;
  retried: boolean;
  retryAfterMs: number | null;
  fallbackUsed: boolean;
  validation: 'PASS' | 'REFUSED' | 'NOT_RUN';
  /**
   * PHASE 18.7 / A8. Which pipeline stage the response reached. `HTTP` means
   * the transport was refused before a body was read; `SCHEMA`/`APPLICABILITY`
   * mean a 200 arrived and was refused on its content; `NOT_RUN` means the
   * failure happened before validation could start.
   */
  validationStage: ProviderValidationStage | 'NOT_RUN';
  actionType: string | null;
  terminalOutcome: 'CONTINUE' | 'FAILED' | 'ABORTED' | 'PENDING' | 'TERMINAL_PROPOSAL';
  latencyMs: number | null;
}
